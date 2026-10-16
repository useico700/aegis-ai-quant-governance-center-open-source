import { sha256, stableStringify } from "./contracts.mjs";
import { applyBookTicker, CausalOrderBook } from "./ws-protocol.mjs";
import path from "node:path";
import { readJsonIfPresent, writeJsonAtomic } from "./persistence.mjs";

export class CausalMarketReducer {
  constructor({ symbols, state = null, onNeedDepthResync = null }) {
    this.symbols = [...symbols];
    this.universe = new Set(symbols);
    this.onNeedDepthResync = onNeedDepthResync;
    this.state = state ?? {
      schemaVersion: 1,
      lastReceiveSeq: 0,
      publicEpoch: 0,
      marketEpoch: 0,
      subscriptions: { PUBLIC: false, MARKET: false },
      epochInvalid: { PUBLIC: false, MARKET: false },
      quotes: {},
      books: {},
      aggregateTrades: {},
      continuous: false,
      continuousFromReceiveSeq: null,
      gaps: [],
      processedOrder: [],
    };
    this.state.epochInvalid ??= { PUBLIC: false, MARKET: false };
    this.books = new Map(this.symbols.map((symbol) => [symbol, new CausalOrderBook(symbol, this.state.books[symbol] ?? null)]));
  }

  gap(event, reason) {
    if (["PUBLIC", "MARKET"].includes(event.connectionKind)) this.state.epochInvalid[event.connectionKind] = true;
    this.state.continuous = false;
    this.state.continuousFromReceiveSeq = null;
    this.state.gaps = [...this.state.gaps, { receiveSeq: event.receiveSeq, connectionKind: event.connectionKind, epoch: event.epoch, reason }].slice(-200);
  }

  beginEpoch(kind, epoch, event) {
    const key = kind === "PUBLIC" ? "publicEpoch" : "marketEpoch";
    if (epoch < this.state[key]) throw new Error(`C_WS_${kind}_EPOCH_REGRESSION`);
    if (epoch === this.state[key]) return;
    this.gap(event, `C_WS_${kind}_NEW_EPOCH`);
    this.state[key] = epoch;
    this.state.subscriptions[kind] = false;
    this.state.epochInvalid[kind] = false;
    if (kind === "PUBLIC") {
      this.state.quotes = {};
      for (const book of this.books.values()) book.beginEpoch(epoch);
    } else {
      this.state.aggregateTrades = {};
    }
  }

  updateContinuity(event) {
    const ready = this.state.subscriptions.PUBLIC && this.state.subscriptions.MARKET && !this.state.epochInvalid.PUBLIC && !this.state.epochInvalid.MARKET &&
      this.symbols.every((symbol) => this.state.quotes[symbol]?.epoch === this.state.publicEpoch && this.books.get(symbol).ready && this.books.get(symbol).epoch === this.state.publicEpoch);
    if (ready && !this.state.continuous) {
      this.state.continuous = true;
      this.state.continuousFromReceiveSeq = event.receiveSeq;
    } else if (!ready) {
      this.state.continuous = false;
      this.state.continuousFromReceiveSeq = null;
    }
  }

  async apply(event) {
    if (!Number.isInteger(event.receiveSeq) || event.receiveSeq !== this.state.lastReceiveSeq + 1) throw new Error("C_WS_REDUCER_RECEIVE_SEQUENCE_GAP");
    this.state.processedOrder = [...this.state.processedOrder, { receiveSeq: event.receiveSeq, exchangeEventTime: event.eventTime ?? null, type: event.type }].slice(-200);
    let decisionAllowed = true;
    if (["PUBLIC", "MARKET"].includes(event.connectionKind)) this.beginEpoch(event.connectionKind, event.epoch, event);
    if (event.type === "SLOW_CONTEXT_READY") {
      this.state.slowContext = { ...event.context, knownAtReceiveSeq: event.receiveSeq };
      decisionAllowed = false;
    } else if (event.type === "WS_CONNECTION_BOUNDARY") {
      this.state.subscriptions[event.connectionKind] = false;
      this.gap(event, event.reason);
    } else if (event.type === "WS_CONTROL_RESPONSE") {
      if (event.controlRole === "SUBSCRIPTION_VERIFIED") this.state.subscriptions[event.connectionKind] = true;
    } else if (event.type === "WS_BOOK_TICKER") {
      if (!this.universe.has(event.symbol)) throw new Error("C_WS_REDUCER_SYMBOL_INVALID");
      const prior = this.state.quotes[event.symbol] ?? null;
      const applied = applyBookTicker(prior, event);
      if (applied === prior) decisionAllowed = false;
      else this.state.quotes[event.symbol] = { ...applied, epoch: event.epoch, quoteId: `${event.epoch}:${event.updateId}:${event.receiveSeq}` };
    } else if (event.type === "WS_DIFF_DEPTH") {
      const book = this.books.get(event.symbol);
      if (!book) throw new Error("C_WS_REDUCER_SYMBOL_INVALID");
      const result = book.applyDiff(event);
      if (result.duplicate || result.buffered) decisionAllowed = false;
      if (result.blocker) {
        this.gap(event, result.blocker);
        await this.onNeedDepthResync?.(event.symbol, event.epoch, result.blocker);
      }
    } else if (event.type === "WS_DEPTH_SNAPSHOT") {
      const book = this.books.get(event.symbol);
      if (!book) throw new Error("C_WS_REDUCER_SYMBOL_INVALID");
      const result = book.bridgeSnapshot(event, event.receiveSeq);
      if (result.blocker) {
        this.gap(event, result.blocker);
        await this.onNeedDepthResync?.(event.symbol, event.epoch, result.blocker);
      }
    } else if (event.type === "PUBLIC_AGG_TRADE") {
      const prior = this.state.aggregateTrades[event.symbol];
      const digest = sha256(stableStringify({ id: event.aggregateTradeId, price: event.price, quantity: event.quantity, buyerWasMaker: event.buyerWasMaker }));
      if (prior && event.aggregateTradeId < prior.aggregateTradeId) this.gap(event, "C_WS_AGG_TRADE_ID_REGRESSION");
      else if (prior && event.aggregateTradeId === prior.aggregateTradeId && digest !== prior.digest) this.gap(event, "C_WS_AGG_TRADE_DUPLICATE_CONFLICT");
      else if (prior && event.aggregateTradeId > prior.aggregateTradeId + 1) this.gap(event, "C_WS_AGG_TRADE_ID_GAP");
      if (!prior || event.aggregateTradeId > prior.aggregateTradeId) this.state.aggregateTrades[event.symbol] = { aggregateTradeId: event.aggregateTradeId, digest, receiveSeq: event.receiveSeq, epoch: event.epoch };
    } else if (event.type !== "WS_CONTROL_RESPONSE") {
      throw new Error("C_WS_REDUCER_EVENT_TYPE_INVALID");
    }
    this.state.lastReceiveSeq = event.receiveSeq;
    this.updateContinuity(event);
    this.state.books = Object.fromEntries([...this.books].map(([symbol, book]) => [symbol, book.exportState()]));
    return { state: this.state, decision: decisionAllowed ? this.decisionView(event.symbol, event.receiveSeq) : null };
  }

  decisionView(symbol, decisionReceiveSeq = this.state.lastReceiveSeq) {
    if (decisionReceiveSeq !== this.state.lastReceiveSeq) throw new Error("C_WS_DECISION_SEQUENCE_NOT_CURRENT_IMMUTABLE_CHECKPOINT");
    if (!this.state.continuous || !symbol || !this.universe.has(symbol)) return null;
    const quote = this.state.quotes[symbol];
    const book = this.books.get(symbol);
    const depth = book.snapshot(20);
    if (!quote || !depth || quote.epoch !== this.state.publicEpoch || book.epoch !== this.state.publicEpoch || quote.receiveSeq > decisionReceiveSeq || book.lastReceiveSeq > decisionReceiveSeq) return null;
    return {
      symbol,
      decisionReceiveSeq,
      quote: {
        schemaVersion: 1,
        type: "PUBLIC_BBO",
        symbol,
        bid: quote.bid,
        ask: quote.ask,
        updateId: quote.updateId,
        eventTime: quote.eventTime,
        transactionTime: quote.transactionTime,
        receivedAt: quote.receivedAt,
        receiveSeq: quote.receiveSeq,
        quoteId: quote.quoteId,
        epoch: quote.epoch,
      },
      depth: { ...depth, depthVersion: `${book.epoch}:${book.lastUpdateId}:${book.lastReceiveSeq}` },
      evidenceBinding: {
        triggerReceiveSeq: eventTypeIsTrigger(this.state.processedOrder.at(-1)?.type) ? decisionReceiveSeq : null,
        decisionReceiveSeq,
        quoteId: quote.quoteId,
        depthVersion: `${book.epoch}:${book.lastUpdateId}:${book.lastReceiveSeq}`,
      },
    };
  }

  consume(symbol, side, quantity) {
    const book = this.books.get(symbol);
    if (!book) throw new Error("C_WS_REDUCER_SYMBOL_INVALID");
    book.consume(side, quantity);
    this.state.books[symbol] = book.exportState();
  }
}

function eventTypeIsTrigger(type) {
  return type === "WS_BOOK_TICKER" || type === "WS_DIFF_DEPTH";
}

export class PersistentCausalMarketReducer {
  constructor({ runtimeRoot, symbols, onNeedDepthResync = null, checkpointEvery = 500 }) {
    this.statePath = path.join(runtimeRoot, "causal-market-state.json");
    this.symbols = symbols;
    this.onNeedDepthResync = onNeedDepthResync;
    this.reducer = null;
    this.checkpointEvery = checkpointEvery;
    this.eventsSinceCheckpoint = 0;
  }

  async initialize() {
    const state = await readJsonIfPresent(this.statePath);
    this.reducer = new CausalMarketReducer({ symbols: this.symbols, state, onNeedDepthResync: this.onNeedDepthResync });
    return this.reducer.state;
  }

  cursor() {
    return Number(this.reducer?.state.lastReceiveSeq ?? 0);
  }

  checkpoint() {
    return { lastReceiveSeq: this.cursor(), publicEpoch: Number(this.reducer?.state.publicEpoch ?? 0), marketEpoch: Number(this.reducer?.state.marketEpoch ?? 0) };
  }

  async apply(event) {
    if (!this.reducer) await this.initialize();
    if (event.receiveSeq <= this.cursor()) return { state: this.reducer.state, decision: null, duplicateReplay: true };
    const result = await this.reducer.apply(event);
    this.eventsSinceCheckpoint += 1;
    if (this.eventsSinceCheckpoint >= this.checkpointEvery || ["WS_CONNECTION_BOUNDARY", "WS_DEPTH_SNAPSHOT"].includes(event.type)) await this.flush();
    return result;
  }

  async flush() {
    if (!this.reducer) return;
    await writeJsonAtomic(this.statePath, this.reducer.state);
    this.eventsSinceCheckpoint = 0;
  }
}
