import { invariant } from './common.mjs';
import { validateMutation } from './transport.mjs';

const KEY = 'orderRequestBudget';

// Single execution writer; persists reservations before I/O and never refunds
// an uncertain request. Caps must come from the host's configured venue limits.
export class OrderRequestBudget {
  constructor({ book, ipBudget, maximumOrders10s, maximumOrders60s, now = Date.now }) {
    invariant(typeof book?.setControl === 'function' && typeof ipBudget?.run === 'function', 'ORDER_BUDGET_PORTS_REQUIRED');
    invariant(Number.isSafeInteger(maximumOrders10s) && maximumOrders10s > 0 && maximumOrders10s <= 1000
      && Number.isSafeInteger(maximumOrders60s) && maximumOrders60s >= maximumOrders10s && maximumOrders60s <= 6000, 'ORDER_BUDGET_LIMITS_INVALID');
    Object.assign(this, { book, ipBudget, maximumOrders10s, maximumOrders60s, now });
    this.state = structuredClone(book.control.get(KEY) ?? { version: 1, lastAt: 0, blockedUntil: 0, reservations: [], observations: [] });
    const s = this.state;
    invariant(s.version === 1 && Number.isSafeInteger(s.lastAt) && s.lastAt >= 0
      && Number.isSafeInteger(s.blockedUntil) && s.blockedUntil >= 0 && Array.isArray(s.reservations)
      && s.reservations.length <= 6000 && s.reservations.every(at => Number.isSafeInteger(at) && at >= 0 && at <= s.lastAt)
      && Array.isArray(s.observations) && s.observations.length <= 2 && s.observations.every(o => [10000, 60000].includes(o.window)
        && Number.isSafeInteger(o.at) && o.at >= 0 && o.at <= s.lastAt && Number.isSafeInteger(o.count) && o.count >= 0), 'ORDER_BUDGET_STATE_INVALID');
    this.busy = false; this.failed = false;
  }
  async commit() {
    try { await this.book.setControl(KEY, structuredClone(this.state)); }
    catch { this.failed = true; throw new Error('ORDER_BUDGET_PERSIST_FAILED'); }
  }
  async run(operation, action) {
    validateMutation(operation.method, operation.pathname, operation.params);
    invariant(!this.busy && !this.failed, 'ORDER_BUDGET_BUSY_OR_FAILED');
    this.busy = true;
    try {
      const at = this.now(), s = this.state;
      invariant(Number.isSafeInteger(at) && at >= s.lastAt, 'ORDER_BUDGET_CLOCK_INVALID');
      invariant(at >= s.blockedUntil, 'ORDER_BUDGET_COOLING_DOWN');
      s.reservations = s.reservations.filter(t => at - t < 60000);
      for (const [window, maximum] of [[10000, this.maximumOrders10s], [60000, this.maximumOrders60s]]) {
        const own = s.reservations.filter(t => at - t < window).length;
        const observed = s.observations.find(o => o.window === window && at - o.at < window);
        // Deliberately overcount own requests after the observed high water;
        // a missing/out-of-order response cannot release local capacity.
        invariant(Math.max(own, observed ? observed.count + s.reservations.filter(t => t >= observed.at).length : 0) + 1 <= maximum, 'ORDER_BUDGET_EXHAUSTED');
      }
      s.lastAt = at; s.reservations.push(at);
      await this.commit();
      // Conservatively charge one IP weight and one order slot for cancels too.
      return await this.ipBudget.run(1, async observe => {
        // Shared admission gives each reservation its own response observer;
        // do not call a tokenless global observe method on that budget.
        this.ipObserver = typeof observe === 'function' ? observe
          : typeof this.ipBudget.observe === 'function' ? meta => this.ipBudget.observe(meta) : null;
        invariant(this.ipObserver, 'ORDER_IP_OBSERVER_REQUIRED');
        return action();
      });
    } finally { this.ipObserver = null; this.busy = false; }
  }
  async observe(meta) {
    const at = this.now(), s = this.state;
    try {
      invariant(!this.failed && Number.isSafeInteger(at) && at >= s.lastAt, 'ORDER_BUDGET_CLOCK_INVALID');
      s.lastAt = at;
      if ([418, 429].includes(meta.status)) {
        const seconds = Number(meta.retryAfter);
        s.blockedUntil = Math.max(s.blockedUntil, at + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000));
      }
      for (const [window, value] of [[10000, meta.orderCount10s], [60000, meta.orderCount60s]]) {
        if (value === null || value === undefined) continue;
        invariant(/^\d{1,9}$/.test(String(value)), 'ORDER_BUDGET_HEADER_INVALID');
        const old = s.observations.find(o => o.window === window);
        s.observations = s.observations.filter(o => o.window !== window);
        s.observations.push({ window, at, count: Math.max(Number(value), old && at - old.at < window ? old.count : 0) });
      }
      await this.commit();
      const observe = this.ipObserver ?? (typeof this.ipBudget.observe === 'function' ? value => this.ipBudget.observe(value) : null);
      invariant(observe, 'ORDER_IP_OBSERVER_REQUIRED');
      await observe(meta);
    } catch { this.failed = true; throw new Error('ORDER_BUDGET_OBSERVATION_FAILED'); }
  }
}
