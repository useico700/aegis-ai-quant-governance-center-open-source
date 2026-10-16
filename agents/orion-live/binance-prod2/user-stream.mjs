import { userStreamControl } from "./mainnet-readonly-client.mjs";
import { parseExchangeJson } from '../../../lib/exchange-json.mjs';

export class ProductionUserStreamMonitor {
  #controls = new Set();
  #startPromise = null;
  #closePromise = null;
  #keepaliveTask = null;
  #cancelHandshake = null;
  #renewalAt = null;
  #preparedFor = null;
  #cancelFailed = false;
  constructor(config, credentials, { WebSocketImpl = globalThis.WebSocket, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, admission = null, sharedAccountToken = false, control = userStreamControl, prepareRenewal = null, cancelRenewal = null } = {}) {
    if (typeof control !== 'function') throw new Error('USER_STREAM_CONTROL_REQUIRED');
    if (!(prepareRenewal === null ? cancelRenewal === null : typeof prepareRenewal === 'function' && typeof cancelRenewal === 'function'
      && Number.isSafeInteger(config.runtime.userStreamKeepaliveMs) && config.runtime.userStreamKeepaliveMs > 65000)) throw new Error('USER_STREAM_SCHEDULING_PORTS');
    this.prepareRenewal = prepareRenewal; this.cancelRenewal = cancelRenewal;
    this.config = config;
    this.credentials = credentials;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.socket = null;
    this.keepalive = null;
    this.listenKey = null;
    this.connectedAt = null;
    this.lastEventAt = null;
    this.lastEventType = null;
    this.eventCount = 0;
    this.lastError = null;
    this.admission = admission;
    this.control = control;
    this.sharedAccountToken = sharedAccountToken;
    this.stopped = false;
  }

  start(options = {}) {
    if (this.stopped) return Promise.reject(new Error('USER_STREAM_STOPPED'));
    if (!this.#startPromise) {
      this.#startPromise = this.#start(options);
      this.#startPromise.catch(() => {
        if (!this.stopped) { this.#startPromise = null; this.lastError ??= 'USER_STREAM_START_FAILED'; }
      });
    }
    return this.#startPromise;
  }

  #requestControl(method, options) {
    const task = Promise.resolve().then(() => {
      if (this.stopped && method !== 'DELETE') throw new Error('USER_STREAM_STOPPED');
      return this.control(this.config, method, this.credentials, options);
    });
    this.#controls.add(task);
    task.finally(() => this.#controls.delete(task)).catch(() => {});
    return task;
  }

  async #start(options) {
    this.admission ??= options.admission ?? null;
    options = { ...options, admission: this.admission ?? options.admission };
    if (!this.WebSocketImpl) throw new Error("PRODUCTION_WEBSOCKET_UNAVAILABLE");
    const started = await this.#requestControl("POST", options);
    // close() drains the POST before deciding whether an unshared token needs
    // cleanup. A late token must never create a new socket after stop.
    if (started?.listenKey) this.listenKey = started.listenKey;
    if (this.stopped) throw new Error('USER_STREAM_STOPPED');
    if (!started?.listenKey) throw new Error("PRODUCTION_LISTEN_KEY_MISSING");
    const url = `${this.config.venue.userStreamBaseUrl}/${encodeURIComponent(this.listenKey)}`;
    this.socket = new this.WebSocketImpl(url);
    const socket = this.socket;
    const active = () => !this.stopped && this.socket === socket;
    this.socket.addEventListener("open", () => {
      if (!active()) return;
      this.connectedAt = this.now();
      this.lastError = null;
    });
    this.socket.addEventListener("message", (event) => {
      if (!active()) return;
      try {
        const payload = parseExchangeJson(String(event.data));
        this.lastEventAt = this.now();
        this.lastEventType = String(payload?.e ?? "UNKNOWN");
        this.eventCount += 1;
        if (this.lastEventType === "listenKeyExpired") this.lastError = "LISTEN_KEY_EXPIRED";
      } catch {
        this.lastError = "USER_STREAM_INVALID_JSON";
      }
    });
    this.socket.addEventListener("error", () => { if (active()) this.lastError = "USER_STREAM_ERROR"; });
    this.socket.addEventListener("close", () => { if (active()) this.lastError = this.lastError ?? "USER_STREAM_CLOSED"; });
    this.#renewalAt = this.now() + this.config.runtime.userStreamKeepaliveMs;
    this.keepalive = this.setIntervalImpl(() => {
      if (this.stopped || this.#keepaliveTask) return;
      if (this.prepareRenewal) {
        if (this.now() < this.#renewalAt) return;
        // A stalled host that missed preparation must not invent a fresh
        // request window at the late interval callback.
        if (this.lastError || this.#preparedFor !== this.#renewalAt) {
          this.lastError ??= 'USER_STREAM_RENEWAL_NOT_PREPARED'; return;
        }
      }
      this.#keepaliveTask = this.#requestControl("PUT", options)
        .catch(() => { if (active()) this.lastError = "USER_STREAM_KEEPALIVE_FAILED"; })
        .finally(() => {
          this.#keepaliveTask = null; this.#preparedFor = null;
          if (active() && !this.lastError) this.#renewalAt += this.config.runtime.userStreamKeepaliveMs;
        });
    }, this.config.runtime.userStreamKeepaliveMs);
    this.keepalive.unref?.();
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.#cancelHandshake = null;
          callback();
        };
        const timeout = setTimeout(() => {
          this.lastError = "USER_STREAM_CONNECT_TIMEOUT";
          finish(() => reject(new Error(this.lastError)));
        }, this.config.runtime.requestTimeoutMs);
        this.#cancelHandshake = () => finish(() => reject(new Error('USER_STREAM_STOPPED')));
        this.socket.addEventListener("open", () => finish(resolve), { once: true });
        this.socket.addEventListener("error", () => finish(() => reject(new Error("USER_STREAM_ERROR"))), { once: true });
        this.socket.addEventListener("close", () => finish(() => reject(new Error("USER_STREAM_CLOSED"))), { once: true });
      });
      if (this.stopped) throw new Error('USER_STREAM_STOPPED');
      return this.status();
    } catch (error) {
      await this.close(options);
      throw error;
    }
  }

  // Called by the coordinated resident's one-second pulse, even when the
  // 60-second account read is not due. Does not send or renew early.
  prepareKeepalive() {
    if (this.stopped || !this.prepareRenewal || !this.status().connected || this.lastError) return;
    const at = this.now();
    if (at < this.#renewalAt - 65000 || at >= this.#renewalAt) return;
    try {
      this.prepareRenewal({ readyAt: this.#renewalAt, timeoutMs: this.config.runtime.requestTimeoutMs });
      this.#preparedFor = this.#renewalAt;
    } catch {
      this.lastError = 'USER_STREAM_RENEWAL_PLAN_FAILED';
      throw new Error(this.lastError);
    }
  }

  status() {
    return {
      connected: !this.stopped && this.socket?.readyState === this.WebSocketImpl?.OPEN,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventAt,
      lastEventType: this.lastEventType,
      eventCount: this.eventCount,
      lastError: this.lastError,
      listenKeyPresent: Boolean(this.listenKey),
    };
  }

  close(options = {}) {
    if (this.#closePromise) return this.#closePromise;
    this.stopped = true;
    options = { ...options, admission: this.admission ?? options.admission };
    if (this.keepalive) this.clearIntervalImpl(this.keepalive);
    this.keepalive = null;
    try { this.cancelRenewal?.(); } catch { this.#cancelFailed = true; }
    this.#cancelHandshake?.();
    try { this.socket?.close(1000, "service stop"); } catch {}
    this.#closePromise = this.#drainClose(options);
    return this.#closePromise;
  }

  async #drainClose(options) {
    // No new POST/PUT can start once stopped. Drain HTTP bodies before the
    // caller releases shared admission or reports the process cleanly stopped.
    await Promise.allSettled([...this.#controls]);
    // Production reader and shadow can share the same account token. A socket
    // shutdown must not revoke the other service's stream; let it expire/renew.
    if (this.listenKey && !this.sharedAccountToken) await this.#requestControl("DELETE", options).catch(() => {});
    this.socket = null;
    this.listenKey = null;
    if (this.#cancelFailed) throw new Error('USER_STREAM_RENEWAL_CANCEL_FAILED');
  }
}
