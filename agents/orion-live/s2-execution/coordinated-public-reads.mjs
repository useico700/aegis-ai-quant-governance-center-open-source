import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { setTimeout as delay } from 'node:timers/promises';
import { invariant } from './common.mjs';
import { CoordinatedReadSession } from './coordinated-read-session.mjs';
import { guardReadAdmission } from './intent-read-bridge.mjs';
import { READ_INTENT_IDS } from './read-intent-catalog.mjs';
import { readIntentRequests, requestBindingKey } from './read-request-bindings.mjs';
import { admittedReadJson } from './admitted-http.mjs';

// A caller-owned scan/context window, not a new scheduler. The host must supply
// its original absolute cutoff; no request/page renews it. No trading endpoints.
export class CoordinatedPublicReads {
  #session; #consumer; #now; #fetcher; #sleep; #observeTiming; #catalog = new Map(); #lastRelease = new Map();
  #window = null; #tasks = new Map(); #targets = new Map(); #closePromise = null; #cancelFailed = false;
  constructor({ session, consumer, now = Date.now, fetcher = fetch, sleep = (ms, signal) => delay(ms, undefined, { signal }), observeTiming = () => {} }) {
    invariant(session instanceof CoordinatedReadSession && ['scanner', 'shadow'].includes(consumer)
      && [now, fetcher, sleep, observeTiming].every(p => typeof p === 'function'), 'PUBLIC_COORDINATED_PORTS');
    this.#session = session; this.#consumer = consumer; this.#now = now; this.#fetcher = fetcher; this.#sleep = sleep;
    this.#observeTiming = observeTiming;
    for (const id of READ_INTENT_IDS) if (id.startsWith(`${consumer}:`) && ['time', 'rules', 'bar', 'quote'].includes(id.split(':')[1])) {
      const [request] = readIntentRequests(id); this.#catalog.set(requestBindingKey(request), id);
    }
  }
  assertReadable() {
    const s = this.#session.status();
    invariant(s.started && !s.stopping && this.#window && !this.#window.abort.signal.aborted, 'PUBLIC_COORDINATED_STOPPED');
    invariant(this.#now() < this.#window.deadlineAt, 'PUBLIC_COORDINATED_DEADLINE');
  }
  beginWindow(deadlineAt) {
    const at = this.#now();
    invariant(this.#window === null && this.#tasks.size === 0 && !this.#cancelFailed,
      'PUBLIC_COORDINATED_WINDOW_ACTIVE');
    // Bounded by the existing scanner watchdog horizon, not a signal-age grant.
    invariant(Number.isSafeInteger(at) && Number.isSafeInteger(deadlineAt) && deadlineAt > at
      && deadlineAt - at <= 150000, 'PUBLIC_COORDINATED_DEADLINE');
    this.#window = { deadlineAt, abort: new AbortController() }; this.#closePromise = null;
    this.assertReadable();
  }
  get(pathname, params = {}, options = {}) {
    this.assertReadable();
    invariant(params && Object.getPrototypeOf(params) === Object.prototype, 'PUBLIC_COORDINATED_SCOPE');
    const request = Object.freeze({ method: 'GET', pathname, params: Object.freeze(Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]))) });
    const id = this.#catalog.get(requestBindingKey(request)); invariant(id, 'PUBLIC_COORDINATED_SCOPE');
    invariant(options && Object.getPrototypeOf(options) === Object.prototype
      && Object.keys(options).every(k => k === 'schedulingTargetAt'), 'PUBLIC_COORDINATED_TARGET');
    const target = options.schedulingTargetAt ?? this.#window.deadlineAt;
    invariant(Number.isSafeInteger(target) && target >= 0 && target <= this.#window.deadlineAt
      && (!Object.hasOwn(options, 'schedulingTargetAt') || (id === 'shadow:rules' && target <= this.#now())), 'PUBLIC_COORDINATED_TARGET');
    if (this.#tasks.has(id)) {
      invariant(this.#targets.get(id) === target, 'PUBLIC_COORDINATED_TARGET_CONFLICT');
      return this.#tasks.get(id);
    }
    const readyAt = Math.max(this.#now(), (this.#lastRelease.get(id) ?? -1) + 1), window = this.#window;
    invariant(readyAt < window.deadlineAt, 'PUBLIC_COORDINATED_DEADLINE');
    const handle = this.#session.prepare(id, { readyAt, deadlineAt: target });
    this.#lastRelease.set(id, readyAt);
    const task = Promise.resolve().then(() => this.#execute(handle, request, window)); this.#tasks.set(id, task); this.#targets.set(id, target);
    task.finally(() => { this.#tasks.delete(id); this.#targets.delete(id); }).catch(() => {}); return task;
  }
  async #execute(handle, request, window) {
    let queued = true;
    try {
      while (true) {
        this.assertReadable();
        let result;
        try {
          result = await this.#session.execute(handle, async admission => {
            const startedAt = this.#now();
            const url = new URL(request.pathname, 'https://demo-fapi.binance.com'); url.search = new URLSearchParams(request.params).toString();
            const guarded = guardReadAdmission(admission, () => this.#window === window && !window.abort.signal.aborted && this.#now() < window.deadlineAt);
            const response = await admittedReadJson(url, { method: 'GET' }, { admission: guarded, fetcher: this.#fetcher,
              timeoutMs: Math.min(this.#consumer === 'scanner' ? 10000 : 5000, window.deadlineAt - this.#now()) });
            invariant(response.ok, 'PUBLIC_COORDINATED_HTTP_FAILED');
            return { payload: response.payload, startedAt, completedAt: this.#now() };
          });
        } catch { queued = false; throw new Error('PUBLIC_COORDINATED_READ_FAILED'); }
        if (result.status === 'COMPLETED') {
          queued = false; this.assertReadable();
          this.#observeTiming(Object.freeze({ pathname: request.pathname, startedAt: result.value.startedAt, completedAt: result.value.completedAt }));
          return result.value.payload;
        }
        const before = this.#now(); this.assertReadable();
        await this.#sleep(Math.min(1000, window.deadlineAt - before), window.abort.signal);
        invariant(this.#now() > before, 'PUBLIC_COORDINATED_CLOCK');
      }
    } catch (error) {
      const safe = new Set(['PUBLIC_COORDINATED_STOPPED', 'PUBLIC_COORDINATED_DEADLINE', 'PUBLIC_COORDINATED_READ_FAILED', 'PUBLIC_COORDINATED_CLOCK']);
      throw new Error(window.abort.signal.aborted ? 'PUBLIC_COORDINATED_STOPPED'
        : safe.has(error?.message) ? error.message : 'PUBLIC_COORDINATED_READ_FAILED');
    } finally {
      if (queued && !this.#session.status().stopping) {
        try { this.#session.cancel(handle); }
        catch { this.#cancelFailed = true; throw new Error('PUBLIC_COORDINATED_CANCEL_FAILED'); }
      }
    }
  }
  closeWindow() {
    if (this.#closePromise) return this.#closePromise;
    this.#window?.abort.abort();
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#tasks.values()]);
      invariant(!this.#cancelFailed, 'PUBLIC_COORDINATED_CANCEL_FAILED'); this.#window = null;
    })();
    this.#closePromise.catch(() => {}); return this.#closePromise;
  }
}
