import { parseExchangeJson } from '../../../lib/exchange-json.mjs';
import { UNIVERSE, fresh, invariant } from './common.mjs';

export const publicStreamUrls = () => ({
  // A bounded 100 ms partial-depth stream carries an exact top of book while
  // avoiding the unbounded every-order-book-update burst rate of bookTicker.
  public: `wss://fstream.binancefuture.com/public/stream?streams=${UNIVERSE.map(s => `${s.toLowerCase()}@depth5@100ms`).join('/')}`,
  market: `wss://fstream.binancefuture.com/market/stream?streams=${UNIVERSE.flatMap(s => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@markPrice@1s`]).join('/')}`,
});

// Caller owns the short serial pulse timer; callbacks never submit orders.
// On either connection's failure BOTH feeds begin a new evidence epoch.
export class PublicStreams {
  constructor({ evidence, WebSocketImpl = globalThis.WebSocket, now = Date.now, onGap = () => {}, random = Math.random }) {
    Object.assign(this, { evidence, WebSocketImpl, now, onGap, random });
    this.sockets = new Map(); this.marks = new Map(); this.generation = 0;
    this.nextConnectAt = 0; this.failures = 0; this.stopped = false; this.lastError = null;
  }
  disconnect(reason) {
    this.generation++; this.evidence.disconnect(reason); this.marks.clear();
    for (const { socket } of this.sockets.values()) try { socket.close(); } catch { /* No raw error payloads. */ }
    this.sockets.clear(); this.lastError = reason;
    this.nextConnectAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)) + Math.floor(this.random() * 500);
    this.onGap({ type: 'PUBLIC_EVIDENCE_GAP', reason, at: this.now() });
  }
  connect() {
    invariant(!this.stopped && this.sockets.size === 0 && this.WebSocketImpl, 'PUBLIC_STREAM_START_INVALID');
    const generation = ++this.generation;
    try {
      for (const [kind, url] of Object.entries(publicStreamUrls())) {
        const socket = new this.WebSocketImpl(url), record = { socket, startedAt: this.now(), lastMessageAt: null, opened: false };
        this.sockets.set(kind, record);
        socket.addEventListener('open', () => {
          if (generation !== this.generation) return;
          record.opened = true;
          if (this.sockets.size === 2 && [...this.sockets.values()].every(row => row.opened)) { this.evidence.connect(); this.lastError = null; }
        });
        socket.addEventListener('message', event => {
          if (generation !== this.generation || this.evidence.connectedAt === null) return;
          try {
            invariant(typeof event.data === 'string' && Buffer.byteLength(event.data) < 65536, 'PUBLIC_MESSAGE_SIZE_INVALID');
            const wrapper = parseExchangeJson(event.data), message = wrapper.data;
            invariant(message && UNIVERSE.includes(message.s) && (message.st === undefined || message.st === 1), 'PUBLIC_MESSAGE_SCOPE_INVALID');
            record.lastMessageAt = this.now();
            if (kind === 'market' && message.e === 'markPriceUpdate') {
              invariant(Number.isSafeInteger(message.E) && Number(message.p) > 0, 'MARK_EVENT_INVALID');
              // Mark price is auxiliary context. A delayed or reordered mark is
              // ignored while BBO/Tick keep their own strict freshness gates.
              if (!fresh(message.E, this.now(), 2000)) return;
              const previous = this.marks.get(message.s);
              if (previous && message.E < previous.markObservedAt) return;
              this.marks.set(message.s, { markPrice: String(message.p), markObservedAt: message.E, markReceivedAt: this.now() });
            } else {
              const evidenceMessage = kind === 'public' ? normalizeDepthBbo(message) : message;
              invariant(evidenceMessage.e === (kind === 'public' ? 'bookTicker' : 'aggTrade'), 'PUBLIC_STREAM_TYPE_INVALID');
              if (!this.evidence.ingest(evidenceMessage)) this.disconnect(this.evidence.gapReason ?? 'PUBLIC_EVENT_INVALID');
            }
          } catch { this.disconnect('PUBLIC_MESSAGE_INVALID'); }
        });
        for (const event of ['error', 'close']) socket.addEventListener(event, () => { if (generation === this.generation) this.disconnect(`PUBLIC_SOCKET_${event.toUpperCase()}`); });
      }
    } catch { this.disconnect('PUBLIC_CONNECT_FAILED'); }
  }
  async pulse() {
    if (this.stopped) return;
    const now = this.now();
    if (!this.sockets.size && now >= this.nextConnectAt) this.connect();
    for (const row of this.sockets.values()) {
      if (now - row.startedAt >= 23 * 3600000) { this.disconnect('PUBLIC_SCHEDULED_ROTATION'); break; }
      if (now - (row.lastMessageAt ?? row.startedAt) > 15000) { this.disconnect('PUBLIC_IDLE_OR_CONNECT_TIMEOUT'); break; }
    }
    if (this.evidence.connectedAt !== null) {
      try { await this.evidence.flush(); }
      catch { this.disconnect('PUBLIC_PERSIST_FAILED'); }
      if (this.evidence.connectedAt !== null && now - this.evidence.connectedAt > 30000) this.failures = 0;
    }
  }
  market() { return Object.fromEntries(UNIVERSE.map(symbol => [symbol, { bbo: this.evidence.get(symbol, 'BBO'), tick: this.evidence.get(symbol, 'TICK'), ...this.marks.get(symbol) }])); }
  watchIntersection(eventId, symbol, intersectionTime) { return this.evidence.watchIntersection(eventId, symbol, intersectionTime); }
  intersectionAnchor(eventId) { return this.evidence.intersectionAnchor(eventId); }
  close() { this.stopped = true; this.disconnect('PUBLIC_STOPPED'); }
}

export const normalizeDepthBbo = message => {
  invariant(message?.e === 'depthUpdate' && Number.isSafeInteger(message.u)
    && Array.isArray(message.b) && message.b.length > 0
    && Array.isArray(message.a) && message.a.length > 0
    && Array.isArray(message.b[0]) && message.b[0].length >= 2
    && Array.isArray(message.a[0]) && message.a[0].length >= 2, 'PUBLIC_DEPTH_INVALID');
  const [[bidPrice, bidQuantity], [askPrice, askQuantity]] = [message.b[0], message.a[0]];
  invariant(Number(bidPrice) > 0 && Number(bidQuantity) > 0
    && Number(askPrice) > 0 && Number(askQuantity) > 0
    && Number(bidPrice) < Number(askPrice), 'PUBLIC_DEPTH_TOP_INVALID');
  return { e: 'bookTicker', E: message.E, T: message.T, s: message.s, u: message.u,
    b: String(bidPrice), B: String(bidQuantity), a: String(askPrice), A: String(askQuantity) };
};

// Binance can return a shared account listenKey. Never DELETE it on shutdown:
// doing so could invalidate the separate existing read-only account monitor.
// Events only invalidate the REST snapshot; fill accounting uses immutable
// orderId/tradeId reconciliation, not duplicate-prone user-event deltas.
export class AccountStream {
  constructor({ createToken, renewToken, prepareRenewal = null, cancelRenewal = null, WebSocketImpl = globalThis.WebSocket, now = Date.now, onChange = () => {} }) {
    invariant(prepareRenewal === null ? cancelRenewal === null
      : typeof prepareRenewal === 'function' && typeof cancelRenewal === 'function', 'ACCOUNT_STREAM_SCHEDULING_PORTS');
    Object.assign(this, { createToken, renewToken, WebSocketImpl, now, onChange });
    this.prepareRenewal = prepareRenewal; this.cancelRenewal = cancelRenewal;
    this.socket = null; this.connected = false; this.generation = 0; this.sequence = 0;
    this.nextConnectAt = 0; this.renewedAt = null; this.stopped = false; this.busy = false;
  }
  invalidate(reason) {
    this.generation++; this.connected = false;
    try { this.cancelRenewal?.(); } catch { reason = 'ACCOUNT_STREAM_SCHEDULE_CANCEL_FAILED'; this.cancelFailed = true; this.stopped = true; }
    try { this.socket?.close(); } catch { /* Never serialize token-bearing errors. */ }
    this.socket = null; this.token = null; this.nextConnectAt = this.now() + 5000;
    this.lastError = reason; this.onChange({ sequence: ++this.sequence, connected: false, reason, at: this.now() });
  }
  pulse() {
    if (this.busy) return this.controlPromise;
    if (this.stopped) return Promise.resolve();
    this.busy = true;
    const task = Promise.resolve().then(() => { if (!this.stopped) return this.runPulse(); });
    this.controlPromise = task;
    task.then(() => { this.busy = false; }, () => { this.busy = false; }).catch(() => {});
    return task;
  }
  async runPulse() {
    try {
      if (!this.socket && this.now() >= this.nextConnectAt) {
        const generation = ++this.generation, token = await this.createToken();
        if (this.stopped || generation !== this.generation) return;
        invariant(typeof token === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(token), 'ACCOUNT_STREAM_TOKEN_INVALID');
        this.token = token; this.renewedAt = this.now(); this.startedAt = this.now();
        const socket = new this.WebSocketImpl(`wss://fstream.binancefuture.com/private/ws/${encodeURIComponent(token)}`); this.socket = socket;
        socket.addEventListener('open', () => {
          if (generation !== this.generation) return;
          this.connected = true; this.lastError = null;
          this.onChange({ sequence: ++this.sequence, connected: true, reason: 'ACCOUNT_STREAM_RECONCILE_REQUIRED', at: this.now() });
        });
        socket.addEventListener('message', event => {
          if (generation !== this.generation) return;
          try {
            invariant(typeof event.data === 'string' && Buffer.byteLength(event.data) < 1024 * 1024, 'ACCOUNT_MESSAGE_INVALID');
            const message = parseExchangeJson(event.data);
            if (message.e === 'listenKeyExpired') { this.invalidate('ACCOUNT_STREAM_EXPIRED'); return; }
            invariant(typeof message.e === 'string' && fresh(message.E, this.now(), 5000), 'ACCOUNT_MESSAGE_STALE');
            const kind = ['ORDER_TRADE_UPDATE', 'TRADE_LITE', 'MARGIN_CALL', 'ACCOUNT_UPDATE', 'ACCOUNT_CONFIG_UPDATE', 'ALGO_UPDATE'].includes(message.e) ? message.e : 'OTHER_ACCOUNT_EVENT';
            const rawSymbol = message.o?.s ?? message.s;
            const symbols = [...new Set((message.a?.P ?? []).map(row => row?.s).filter(symbol => UNIVERSE.includes(symbol)))];
            this.onChange({ sequence: ++this.sequence, connected: true, reason: 'ACCOUNT_EVENT_RECONCILE_REQUIRED', at: this.now(), kind,
              symbol: UNIVERSE.includes(rawSymbol) ? rawSymbol : symbols.length === 1 ? symbols[0] : null, symbols });
          } catch { this.invalidate('ACCOUNT_MESSAGE_INVALID'); }
        });
        for (const event of ['error', 'close']) socket.addEventListener(event, () => { if (generation === this.generation) this.invalidate(`ACCOUNT_SOCKET_${event.toUpperCase()}`); });
      }
      if (this.socket && !this.connected && this.now() - this.startedAt > 10000) this.invalidate('ACCOUNT_CONNECT_TIMEOUT');
      if (this.socket && this.now() - this.startedAt >= 23 * 3600000) this.invalidate('ACCOUNT_SCHEDULED_ROTATION');
      if (this.connected && this.prepareRenewal && this.now() >= this.renewedAt + 20 * 60000 - 65000
        && this.now() < this.renewedAt + 20 * 60000) this.prepareRenewal({ readyAt: this.renewedAt + 20 * 60000 });
      if (this.connected && this.now() - this.renewedAt >= 20 * 60000) {
        const generation = this.generation; await this.renewToken(this.token);
        if (generation === this.generation) this.renewedAt = this.now();
      }
    } catch { this.invalidate('ACCOUNT_STREAM_CONTROL_FAILED'); }
  }
  status() { return { connected: this.connected, sequence: this.sequence, lastError: this.lastError ?? null }; }
  close() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.invalidate('ACCOUNT_STREAM_STOPPED');
    this.closePromise = (async () => {
      await this.controlPromise;
      invariant(!this.cancelFailed, 'ACCOUNT_STREAM_SCHEDULE_CANCEL_FAILED');
    })();
    this.closePromise.catch(() => {}); return this.closePromise;
  }
}
