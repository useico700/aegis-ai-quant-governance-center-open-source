import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256, stableStringify } from "./contracts.mjs";
import { AppendOnlyLedger } from "./ledger.mjs";
import { readJsonIfPresent, writeJsonAtomic } from "./persistence.mjs";
import { normalizeWsPayload } from "./ws-protocol.mjs";

export const PUBLIC_WS_BASE = "wss://fstream.binancefuture.com/public/stream";
export const MARKET_WS_BASE = "wss://fstream.binancefuture.com/market/stream";

const streamsFor = (kind, symbols) => kind === "PUBLIC"
  ? symbols.flatMap((symbol) => [`${symbol.toLowerCase()}@bookTicker`, `${symbol.toLowerCase()}@depth@100ms`])
  : symbols.map((symbol) => `${symbol.toLowerCase()}@aggTrade`);

export class ContinuousMarketCapture {
  constructor({ runtimeRoot, symbols, resourceGuard, onPersistedEvent, getReducedReceiveSeq = async () => 0, getReducerCheckpoint = null, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
    this.runtimeRoot = runtimeRoot;
    this.symbols = [...symbols];
    this.universe = new Set(symbols);
    this.resourceGuard = resourceGuard;
    this.onPersistedEvent = onPersistedEvent;
    this.getReducedReceiveSeq = getReducedReceiveSeq;
    this.getReducerCheckpoint = getReducerCheckpoint;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.statePath = path.join(runtimeRoot, "continuous-capture-state.json");
    this.rawLedger = new AppendOnlyLedger(path.join(runtimeRoot, "market-events.ndjson"), "MARKETRAW", { resourceGuard });
    this.state = null;
    this.sockets = new Map();
    this.ingestChain = Promise.resolve();
    this.stateWriteChain = Promise.resolve();
    this.assignedReceiveSeq = 0;
    this.eventsSinceStateCheckpoint = 0;
    this.stopping = false;
    this.fatalError = null;
  }

  async initialize() {
    await this.rawLedger.initialize();
    this.state = await readJsonIfPresent(this.statePath) ?? {
      schemaVersion: 1,
      status: "INITIALIZING",
      receiveSequence: this.rawLedger.sequence,
      epochs: { PUBLIC: 0, MARKET: 0 },
      connections: {},
      continuousFromReceiveSeq: null,
      lastPersistedReceiveSeq: this.rawLedger.sequence,
      lastReducedReceiveSeq: 0,
      epochBoundaries: [],
    };
    const checkpoint = this.getReducerCheckpoint ? await this.getReducerCheckpoint() : { lastReceiveSeq: await this.getReducedReceiveSeq(), publicEpoch: 0, marketEpoch: 0 };
    const reducedReceiveSeq = Number(checkpoint.lastReceiveSeq);
    if (!Number.isInteger(reducedReceiveSeq) || reducedReceiveSeq < 0 || reducedReceiveSeq > this.rawLedger.sequence) throw new Error("C_WS_REDUCER_CURSOR_INVALID_FOR_RAW_LEDGER");
    await this.rawLedger.replayAfter(reducedReceiveSeq, async (record) => {
      const event = record.payload?.normalizedEvent;
      if (!event || event.receiveSeq !== record.sequence) throw new Error("C_WS_RAW_REPLAY_EVENT_INVALID");
      await this.onPersistedEvent({ ...event, replayed: true, processedAt: Date.now() });
      if (event.connectionKind === "PUBLIC") this.state.epochs.PUBLIC = Math.max(this.state.epochs.PUBLIC, Number(event.epoch ?? 0));
      if (event.connectionKind === "MARKET") this.state.epochs.MARKET = Math.max(this.state.epochs.MARKET, Number(event.epoch ?? 0));
    });
    this.state.epochs.PUBLIC = Math.max(Number(this.state.epochs.PUBLIC ?? 0), Number(checkpoint.publicEpoch ?? 0));
    this.state.epochs.MARKET = Math.max(Number(this.state.epochs.MARKET ?? 0), Number(checkpoint.marketEpoch ?? 0));
    this.assignedReceiveSeq = this.rawLedger.sequence;
    this.state.receiveSequence = this.rawLedger.sequence;
    this.state.lastPersistedReceiveSeq = this.rawLedger.sequence;
    this.state.lastReducedReceiveSeq = this.rawLedger.sequence;
    await this.persistState();
    return this.state;
  }

  async persistState() {
    const snapshot = structuredClone(this.state);
    this.stateWriteChain = this.stateWriteChain.then(() => writeJsonAtomic(this.statePath, snapshot));
    await this.stateWriteChain;
  }

  async start() {
    if (!this.state) await this.initialize();
    this.stopping = false;
    await Promise.all([this.connect("PUBLIC"), this.connect("MARKET")]);
    return this.state;
  }

  async connect(kind) {
    const epoch = Number(this.state.epochs[kind] ?? 0) + 1;
    this.state.epochs[kind] = epoch;
    this.state.connections[kind] = { epoch, status: "CONNECTING", subscribed: false, listed: false, openedAt: null, lastMessageAt: null };
    this.state.continuousFromReceiveSeq = null;
    await this.persistState();
    const socket = new this.WebSocketImpl(kind === "PUBLIC" ? PUBLIC_WS_BASE : MARKET_WS_BASE);
    this.sockets.set(kind, socket);
    const expectedStreams = streamsFor(kind, this.symbols);
    const subscribeId = epoch * 10 + 1;
    const listId = epoch * 10 + 2;
    const rotate = setTimeout(() => { try { socket.close(1000, "C_PROACTIVE_24H_ROTATION"); } catch {} }, 23 * 60 * 60 * 1000 + 50 * 60 * 1000);
    rotate.unref?.();
    socket.onopen = () => {
      const connection = this.state.connections[kind];
      if (!connection || connection.epoch !== epoch) return;
      connection.status = "VERIFYING_SUBSCRIPTION";
      connection.openedAt = new Date().toISOString();
      socket.send(JSON.stringify({ method: "SUBSCRIBE", params: expectedStreams, id: subscribeId }));
      socket.send(JSON.stringify({ method: "LIST_SUBSCRIPTIONS", id: listId }));
    };
    socket.onmessage = (message) => this.enqueue(kind, epoch, message.data, { expectedStreams, subscribeId, listId });
    socket.onerror = () => { this.state.connections[kind].lastErrorAt = new Date().toISOString(); };
    socket.onclose = (event) => {
      clearTimeout(rotate);
      if (this.sockets.get(kind) === socket) this.sockets.delete(kind);
      this.enqueueBoundary(kind, epoch, `WS_CLOSE_${event.code}_${event.reason || "NO_REASON"}`);
      if (!this.stopping && !this.resourceGuard.status().paused && !this.fatalError) {
        setTimeout(() => this.connect(kind).catch((error) => this.fail(error)), 1_000).unref?.();
      }
    };
  }

  enqueue(kind, epoch, data, control) {
    if (this.stopping || this.fatalError) return;
    const serialized = typeof data === "string" ? data : String(data);
    const bytes = Buffer.byteLength(serialized);
    const receivedAt = Date.now();
    const monotonicNs = process.hrtime.bigint();
    let reservation;
    try { reservation = this.resourceGuard.reserveQueueImmediate(bytes, `WS_${kind}_RECEIVE`); }
    catch (error) {
      void this.resourceGuard.latch("LOCAL_RESOURCE_QUEUE_LIMIT", { requestedBytes: bytes, connectionKind: kind }).finally(() => this.fail(error));
      return;
    }
    const receiveSeq = this.assignedReceiveSeq + 1;
    this.assignedReceiveSeq = receiveSeq;
    const item = { kind, epoch, serialized, control, receivedAt, monotonicNs, receiveSeq };
    this.ingestChain = this.ingestChain.catch(() => {}).then(async () => {
      try {
        if (!this.fatalError) await this.persistAndDispatch(item);
      } finally { this.resourceGuard.releaseQueue(reservation); }
    });
    void this.ingestChain.catch((error) => this.fail(error));
  }

  enqueueBoundary(kind, epoch, reason) {
    const serialized = JSON.stringify({ localControlType: "CONNECTION_BOUNDARY", reason, at: new Date().toISOString() });
    this.enqueue(kind, epoch, serialized, { localBoundary: true });
  }

  enqueueSlowContext(context) {
    const serialized = JSON.stringify({ localControlType: "SLOW_CONTEXT_READY", context });
    this.enqueue("LOCAL", 0, serialized, { slowContext: true });
  }

  async persistAndDispatch({ kind, epoch, serialized, control, receivedAt, monotonicNs, receiveSeq }) {
    const parsed = JSON.parse(serialized);
    if (receiveSeq !== this.rawLedger.sequence + 1) throw new Error("C_WS_RECEIVE_SEQUENCE_COMMIT_MISMATCH");
    const isCombined = parsed && typeof parsed.stream === "string" && parsed.data && typeof parsed.data === "object";
    const raw = isCombined ? parsed.data : parsed;
    const stream = isCombined ? parsed.stream : null;
    let event;
    if (control.slowContext) {
      if (raw.localControlType !== "SLOW_CONTEXT_READY" || raw.context?.schemaVersion !== 1) throw new Error("C_WS_SLOW_CONTEXT_INVALID");
      event = { type: "SLOW_CONTEXT_READY", receiveSeq, connectionKind: "LOCAL", epoch: 0, receivedAt, context: raw.context };
    } else if (control.localBoundary) {
      event = { type: "WS_CONNECTION_BOUNDARY", receiveSeq, connectionKind: kind, epoch, reason: raw.reason, receivedAt };
    } else if (control.depthSnapshot) {
      if (raw.localControlType !== "REST_DEPTH_SNAPSHOT" || !this.universe.has(raw.symbol) || !Number.isInteger(raw.lastUpdateId)) throw new Error("C_WS_DEPTH_BOOTSTRAP_SNAPSHOT_INVALID");
      event = { type: "WS_DEPTH_SNAPSHOT", receiveSeq, connectionKind: kind, epoch, ...raw };
    } else if (Object.hasOwn(raw, "id")) {
      const connection = this.state.connections[kind];
      let subscribed = connection.subscribed;
      let listed = connection.listed;
      if (raw.id === control.subscribeId) {
        if (raw.result !== null) throw new Error("C_WS_SUBSCRIBE_ACK_INVALID");
        subscribed = true;
      } else if (raw.id === control.listId) {
        const actual = [...(raw.result ?? [])].sort();
        const expected = [...control.expectedStreams].sort();
        if (stableStringify(actual) !== stableStringify(expected)) throw new Error("C_WS_SUBSCRIPTION_LIST_MISMATCH");
        listed = true;
      }
      event = { type: "WS_CONTROL_RESPONSE", receiveSeq, connectionKind: kind, epoch, raw, receivedAt, controlRole: subscribed && listed ? "SUBSCRIPTION_VERIFIED" : "SUBSCRIPTION_PARTIAL" };
    } else {
      if (!stream || !control.expectedStreams.includes(stream)) throw new Error("C_WS_STREAM_NAME_INVALID_OR_UNSUBSCRIBED");
      event = { ...normalizeWsPayload(kind, raw, receivedAt, monotonicNs, this.universe), receiveSeq, epoch, stream, subscriptionVerified: this.state.connections[kind].subscribed && this.state.connections[kind].listed };
    }
    const payload = {
      receiveSeq,
      connectionKind: kind,
      epoch,
      stream,
      exchangeEventTime: Number.isFinite(Number(raw.E)) ? Number(raw.E) : null,
      exchangeTransactionTime: Number.isFinite(Number(raw.T)) ? Number(raw.T) : null,
      receivedAt,
      monotonicNs: String(monotonicNs),
      raw,
      normalizedEvent: event,
    };
    const record = await this.rawLedger.append("RAW_MARKET_RECEIVE", receivedAt, payload, `c_market_receive_${String(receiveSeq).padStart(16, "0")}_${sha256(stableStringify({ kind, epoch, serialized })).slice(0, 16)}`);
    if (!record || record.sequence !== receiveSeq) throw new Error("C_WS_RECEIVE_SEQUENCE_COMMIT_MISMATCH");
    this.state.receiveSequence = receiveSeq;
    this.state.lastPersistedReceiveSeq = receiveSeq;
    if (this.state.connections[kind]) this.state.connections[kind].lastMessageAt = new Date(receivedAt).toISOString();
    if (event.type === "WS_CONNECTION_BOUNDARY") {
      this.state.connections[kind].status = "DISCONNECTED";
      this.state.connections[kind].subscribed = false;
      this.state.connections[kind].listed = false;
      this.state.continuousFromReceiveSeq = null;
      this.state.epochBoundaries = [...this.state.epochBoundaries, { receiveSeq, kind, epoch, reason: raw.reason }].slice(-200);
    } else if (event.type === "WS_CONTROL_RESPONSE") {
      const connection = this.state.connections[kind];
      if (raw.id === control.subscribeId) connection.subscribed = true;
      if (raw.id === control.listId) connection.listed = true;
      if (connection.subscribed && connection.listed) {
        connection.status = "SUBSCRIBED";
        if (kind === "PUBLIC") void this.bootstrapAllDepth(epoch);
      }
    }
    await this.onPersistedEvent({ ...event, processedAt: Date.now() });
    this.state.lastReducedReceiveSeq = receiveSeq;
    this.eventsSinceStateCheckpoint += 1;
    if (this.eventsSinceStateCheckpoint >= 500 || ["WS_CONTROL_RESPONSE", "WS_CONNECTION_BOUNDARY", "WS_DEPTH_SNAPSHOT"].includes(event.type)) {
      await this.persistState();
      this.eventsSinceStateCheckpoint = 0;
    }
  }

  async bootstrapAllDepth(epoch) {
    await Promise.all(this.symbols.map((symbol) => this.bootstrapDepth(symbol, epoch)));
  }

  async bootstrapDepth(symbol, epoch) {
    if (this.stopping || this.state.connections.PUBLIC?.epoch !== epoch || !this.universe.has(symbol)) return;
    try {
      const response = await this.fetchImpl(`https://demo-fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`C_WS_DEPTH_BOOTSTRAP_HTTP_${response.status}`);
      const raw = await response.json();
      const snapshot = {
        localControlType: "REST_DEPTH_SNAPSHOT",
        symbol,
        lastUpdateId: Number(raw.lastUpdateId),
        bids: raw.bids.map(([price, quantity]) => [Number(price), Number(quantity)]),
        asks: raw.asks.map(([price, quantity]) => [Number(price), Number(quantity)]),
        receivedAt: Date.now(),
      };
      this.enqueue("PUBLIC", epoch, JSON.stringify(snapshot), { depthSnapshot: true, expectedStreams: streamsFor("PUBLIC", this.symbols) });
    } catch (error) { this.enqueueBoundary("PUBLIC", epoch, `DEPTH_BOOTSTRAP_FAILED_${error.message}`); }
  }

  async waitUntilSubscribed(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (["PUBLIC", "MARKET"].every((kind) => this.state.connections[kind]?.status === "SUBSCRIBED")) return this.state;
      if (this.fatalError) throw this.fatalError;
      await delay(50);
    }
    throw new Error("C_WS_SUBSCRIPTION_VERIFICATION_TIMEOUT");
  }

  fail(error) {
    if (this.fatalError) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    this.state.status = "FAIL_CLOSED";
    this.state.lastError = this.fatalError.message;
    this.state.continuousFromReceiveSeq = null;
    for (const socket of this.sockets.values()) { try { socket.close(1011, "C_FAIL_CLOSED"); } catch {} }
  }

  async stop(reason = "C_CAPTURE_STOP_REQUESTED") {
    this.stopping = true;
    for (const socket of this.sockets.values()) { try { socket.close(1000, reason); } catch {} }
    await this.ingestChain;
    this.state.status = "STOPPED";
    this.state.continuousFromReceiveSeq = null;
    await this.persistState();
  }
}
