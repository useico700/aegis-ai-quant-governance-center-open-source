import { validateTradeEvent } from "./contracts.mjs";

const number = (value, code) => {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(code);
  return result;
};

const integer = (value, code) => {
  const result = number(value, code);
  if (!Number.isInteger(result) || result < 0) throw new Error(code);
  return result;
};

function assertSymbol(symbol, universe) {
  if (!universe.has(symbol)) throw new Error("C_WS_SYMBOL_OUTSIDE_FIXED_UNIVERSE");
}

export function normalizeWsPayload(connectionKind, raw, receivedAt, monotonicNs, universe) {
  if (!raw || typeof raw !== "object") throw new Error("C_WS_PAYLOAD_OBJECT_REQUIRED");
  const symbol = raw.s;
  assertSymbol(symbol, universe);
  if (raw.st !== undefined && raw.st !== 1) throw new Error("C_WS_USDM_STREAM_TYPE_INVALID");
  const base = {
    connectionKind,
    symbol,
    eventTime: integer(raw.E, "C_WS_EVENT_TIME_INVALID"),
    transactionTime: integer(raw.T ?? raw.E, "C_WS_TRANSACTION_TIME_INVALID"),
    receivedAt,
    monotonicNs: String(monotonicNs),
  };
  if (connectionKind === "PUBLIC" && raw.e === "bookTicker") {
    return {
      ...base,
      type: "WS_BOOK_TICKER",
      updateId: integer(raw.u, "C_WS_BOOK_UPDATE_ID_INVALID"),
      bid: number(raw.b, "C_WS_BOOK_BID_INVALID"),
      bidQuantity: number(raw.B, "C_WS_BOOK_BID_QUANTITY_INVALID"),
      ask: number(raw.a, "C_WS_BOOK_ASK_INVALID"),
      askQuantity: number(raw.A, "C_WS_BOOK_ASK_QUANTITY_INVALID"),
    };
  }
  if (connectionKind === "PUBLIC" && raw.e === "depthUpdate") {
    const levels = (values, code) => {
      if (!Array.isArray(values)) throw new Error(code);
      return values.map((level) => {
        if (!Array.isArray(level) || level.length !== 2) throw new Error(code);
        return [number(level[0], code), number(level[1], code)];
      });
    };
    return {
      ...base,
      type: "WS_DIFF_DEPTH",
      firstUpdateId: integer(raw.U, "C_WS_DEPTH_FIRST_UPDATE_ID_INVALID"),
      finalUpdateId: integer(raw.u, "C_WS_DEPTH_FINAL_UPDATE_ID_INVALID"),
      previousFinalUpdateId: integer(raw.pu, "C_WS_DEPTH_PREVIOUS_UPDATE_ID_INVALID"),
      bids: levels(raw.b, "C_WS_DEPTH_BIDS_INVALID"),
      asks: levels(raw.a, "C_WS_DEPTH_ASKS_INVALID"),
    };
  }
  if (connectionKind === "MARKET" && raw.e === "aggTrade") {
    const result = {
      schemaVersion: 1,
      type: "PUBLIC_AGG_TRADE",
      connectionKind,
      symbol,
      aggregateTradeId: integer(raw.a, "C_WS_AGG_TRADE_ID_INVALID"),
      price: number(raw.p, "C_WS_AGG_TRADE_PRICE_INVALID"),
      quantity: number(raw.q, "C_WS_AGG_TRADE_QUANTITY_INVALID"),
      nonRpiQuantity: raw.nq == null ? null : number(raw.nq, "C_WS_AGG_TRADE_NON_RPI_QUANTITY_INVALID"),
      quantityIncludesRpi: true,
      buyerWasMaker: Boolean(raw.m),
      firstTradeId: integer(raw.f, "C_WS_AGG_FIRST_TRADE_ID_INVALID"),
      lastTradeId: integer(raw.l, "C_WS_AGG_LAST_TRADE_ID_INVALID"),
      eventTime: base.eventTime,
      tradeTime: base.transactionTime,
      receivedAt,
      monotonicNs: base.monotonicNs,
    };
    validateTradeEvent(result);
    return result;
  }
  throw new Error("C_WS_EVENT_TYPE_OR_CONNECTION_INVALID");
}

const emptySide = () => ({});
const levelKey = (price) => String(price);

function applyObservedLevel(side, price, quantity, epoch, explicitDiff) {
  const key = levelKey(price);
  const prior = side[key];
  if (quantity === 0) {
    side[key] = { price, observedQuantity: 0, consumedQuantity: Number(prior?.consumedQuantity ?? 0), generation: Number(prior?.generation ?? 1), zeroObservedEpoch: explicitDiff ? epoch : prior?.zeroObservedEpoch ?? null };
    return;
  }
  if (!prior) {
    side[key] = { price, observedQuantity: quantity, consumedQuantity: 0, generation: 1, zeroObservedEpoch: null };
    return;
  }
  const newGeneration = explicitDiff && prior.observedQuantity === 0 && prior.zeroObservedEpoch === epoch;
  side[key] = {
    price,
    observedQuantity: quantity,
    consumedQuantity: newGeneration ? 0 : prior.consumedQuantity,
    generation: newGeneration ? prior.generation + 1 : prior.generation,
    zeroObservedEpoch: null,
  };
}

function applyLevels(side, levels, epoch, explicitDiff) {
  for (const [price, quantity] of levels) applyObservedLevel(side, price, quantity, epoch, explicitDiff);
}

function snapshotObservedLayer(priorSide, levels) {
  const next = {};
  for (const level of Object.values(priorSide)) next[levelKey(level.price)] = { ...level, observedQuantity: 0, snapshotAbsentUnknown: true };
  for (const [price, quantity] of levels) {
    const key = levelKey(price);
    const prior = priorSide[key];
    next[key] = prior
      ? { ...prior, price, observedQuantity: quantity, snapshotAbsentUnknown: false }
      : { price, observedQuantity: quantity, consumedQuantity: 0, generation: 1, zeroObservedEpoch: null, snapshotAbsentUnknown: false };
  }
  return next;
}

function visible(side, descending, limit = 1000) {
  return Object.values(side)
    .filter((level) => level.observedQuantity > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price)
    .slice(0, limit)
    .map((level) => [level.price, Math.max(0, level.observedQuantity - level.consumedQuantity)]);
}

export class CausalOrderBook {
  constructor(symbol, state = null) {
    this.symbol = symbol;
    this.epoch = Number(state?.epoch ?? 0);
    this.ready = Boolean(state?.ready);
    this.lastUpdateId = state?.lastUpdateId ?? null;
    this.lastReceiveSeq = state?.lastReceiveSeq ?? null;
    this.lastEventTime = state?.lastEventTime ?? null;
    this.lastReceivedAt = state?.lastReceivedAt ?? null;
    this.bids = structuredClone(state?.bids ?? emptySide());
    this.asks = structuredClone(state?.asks ?? emptySide());
    this.buffer = structuredClone(state?.buffer ?? []);
    this.pendingSnapshot = structuredClone(state?.pendingSnapshot ?? null);
    this.invalidReason = state?.invalidReason ?? null;
  }

  beginEpoch(epoch) {
    if (!(epoch > this.epoch)) throw new Error("C_WS_DEPTH_EPOCH_NOT_ADVANCING");
    this.epoch = epoch;
    this.ready = false;
    this.lastUpdateId = null;
    this.lastReceiveSeq = null;
    this.lastEventTime = null;
    this.lastReceivedAt = null;
    this.buffer = [];
    this.pendingSnapshot = null;
    this.invalidReason = null;
  }

  bufferDiff(event) {
    if (event.symbol !== this.symbol || event.type !== "WS_DIFF_DEPTH") throw new Error("C_WS_DEPTH_EVENT_SYMBOL_OR_TYPE_INVALID");
    this.buffer.push(event);
  }

  bridgeSnapshot(snapshot, receiveSeq) {
    if (snapshot.symbol !== this.symbol || !Number.isInteger(snapshot.lastUpdateId)) throw new Error("C_WS_DEPTH_SNAPSHOT_INVALID");
    const candidateBids = snapshotObservedLayer(this.bids, snapshot.bids);
    const candidateAsks = snapshotObservedLayer(this.asks, snapshot.asks);
    const usable = this.buffer.filter((event) => event.finalUpdateId >= snapshot.lastUpdateId);
    const firstIndex = usable.findIndex((event) => event.firstUpdateId <= snapshot.lastUpdateId && event.finalUpdateId >= snapshot.lastUpdateId);
    if (firstIndex < 0) {
      this.ready = false;
      const firstBuffered = this.buffer[0];
      if (firstBuffered && firstBuffered.firstUpdateId > snapshot.lastUpdateId) {
        this.invalidReason = "C_WS_DEPTH_SNAPSHOT_TOO_OLD_FOR_BUFFER";
        return { ready: false, blocker: this.invalidReason };
      }
      this.pendingSnapshot = { ...structuredClone(snapshot), receiveSeq };
      return { ready: false, waitingForBridgeEvent: true };
    }
    let prior = null;
    for (const event of usable.slice(firstIndex)) {
      if (prior != null && event.previousFinalUpdateId !== prior) {
        this.ready = false;
        this.invalidReason = "C_WS_DEPTH_PU_GAP";
        return { ready: false, blocker: this.invalidReason };
      }
      applyLevels(candidateBids, event.bids, this.epoch, true);
      applyLevels(candidateAsks, event.asks, this.epoch, true);
      prior = event.finalUpdateId;
      this.lastReceiveSeq = event.receiveSeq;
      this.lastEventTime = event.eventTime;
      this.lastReceivedAt = event.receivedAt;
    }
    this.bids = candidateBids;
    this.asks = candidateAsks;
    this.lastUpdateId = prior;
    this.lastReceiveSeq ??= receiveSeq;
    this.ready = true;
    this.buffer = [];
    this.pendingSnapshot = null;
    return { ready: true, lastUpdateId: this.lastUpdateId };
  }

  applyDiff(event) {
    if (!this.ready) {
      this.bufferDiff(event);
      if (this.pendingSnapshot) return this.bridgeSnapshot(this.pendingSnapshot, this.pendingSnapshot.receiveSeq);
      return { ready: false, buffered: true };
    }
    if (event.finalUpdateId <= this.lastUpdateId) return { ready: true, duplicate: true };
    if (event.previousFinalUpdateId !== this.lastUpdateId) {
      this.ready = false;
      this.invalidReason = "C_WS_DEPTH_PU_GAP";
      this.buffer = [event];
      return { ready: false, blocker: this.invalidReason };
    }
    applyLevels(this.bids, event.bids, this.epoch, true);
    applyLevels(this.asks, event.asks, this.epoch, true);
    this.lastUpdateId = event.finalUpdateId;
    this.lastReceiveSeq = event.receiveSeq;
    this.lastEventTime = event.eventTime;
    this.lastReceivedAt = event.receivedAt;
    return { ready: true, lastUpdateId: this.lastUpdateId };
  }

  consume(sideName, quantity) {
    const side = sideName === "bids" ? this.bids : sideName === "asks" ? this.asks : null;
    if (!side || !this.ready) throw new Error("C_WS_DEPTH_NOT_READY_FOR_CONSUMPTION");
    if (!Number.isFinite(quantity) || !(quantity > 0)) throw new Error("C_WS_DEPTH_CONSUMPTION_QUANTITY_INVALID");
    const levels = visible(side, sideName === "bids", 1000);
    let remaining = quantity;
    const allocation = [];
    for (const [price, available] of levels) {
      const take = Math.min(remaining, available);
      if (take > 0) allocation.push([price, take]);
      remaining -= take;
      if (remaining <= 1e-10) break;
    }
    if (remaining > 1e-8) throw new Error("C_WS_DEPTH_AVAILABLE_LIQUIDITY_INSUFFICIENT");
    for (const [price, take] of allocation) side[levelKey(price)].consumedQuantity += take;
  }

  snapshot(limit = 20) {
    if (!this.ready) return null;
    return {
      schemaVersion: 1,
      type: "PUBLIC_PARTIAL_DEPTH",
      symbol: this.symbol,
      lastUpdateId: this.lastUpdateId,
      eventTime: this.lastEventTime,
      receivedAt: this.lastReceivedAt,
      bids: visible(this.bids, true, limit),
      asks: visible(this.asks, false, limit),
      snapshotSemantics: "TOP_LEVELS_COMPLETE_AT_EVENT_NOT_FULL_DIFF_HISTORY",
      epoch: this.epoch,
      decisionReceiveSeq: this.lastReceiveSeq,
    };
  }

  exportState() {
    return { symbol: this.symbol, epoch: this.epoch, ready: this.ready, lastUpdateId: this.lastUpdateId, lastReceiveSeq: this.lastReceiveSeq, lastEventTime: this.lastEventTime, lastReceivedAt: this.lastReceivedAt, bids: this.bids, asks: this.asks, buffer: this.buffer, pendingSnapshot: this.pendingSnapshot, invalidReason: this.invalidReason };
  }
}

export function applyBookTicker(prior, event) {
  if (event.type !== "WS_BOOK_TICKER") throw new Error("C_WS_BOOK_EVENT_INVALID");
  if (prior && event.updateId < prior.updateId) throw new Error("C_WS_BOOK_UPDATE_ID_REGRESSION");
  if (prior && event.updateId === prior.updateId) {
    const same = ["bid", "bidQuantity", "ask", "askQuantity"].every((key) => event[key] === prior[key]);
    if (!same) throw new Error("C_WS_BOOK_DUPLICATE_ID_CONFLICT");
    return prior;
  }
  if (!(event.bid > 0 && event.ask >= event.bid && event.bidQuantity >= 0 && event.askQuantity >= 0)) throw new Error("C_WS_BOOK_VALUES_INVALID");
  return event;
}
