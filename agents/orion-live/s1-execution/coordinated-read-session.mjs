import { invariant } from './common.mjs';
import { CoordinatedReadBudget } from './coordinated-read-budget.mjs';
import { IntentReadBridge, guardReadAdmission } from './intent-read-bridge.mjs';
import { BoundedReadDispatch } from './bounded-read-dispatch.mjs';

// Resident lifecycle; the separate host factory controls migration/identity.
// No strategy cadence policy. Callers supply original evidence deadlines.
export class CoordinatedReadSession {
  #budget; #bridge; #auxiliary; #entries = new Map(); #pending = new Set();
  #setTimer; #clearTimer; #timer = null; #onFault; #closePromise = null; #auxDrain = null;
  #started = false; #stopping = false; #closed = false; #fault = null; #cancelFailed = false; #heartbeatAt = null;
  constructor(budget, { setTimer = setTimeout, clearTimer = clearTimeout, sleep, onFault = () => {} } = {}) {
    invariant(budget instanceof CoordinatedReadBudget && budget.db && typeof setTimer === 'function'
      && typeof clearTimer === 'function' && typeof onFault === 'function', 'COORDINATED_SESSION_PORTS');
    this.#budget = budget; this.#bridge = new IntentReadBridge(budget);
    this.#auxiliary = new BoundedReadDispatch({ bridge: this.#bridge, now: budget.now, ...(sleep ? { sleep } : {}) });
    this.#setTimer = setTimer; this.#clearTimer = clearTimer; this.#onFault = onFault;
  }
  get auxiliary() {
    invariant(this.#started && !this.#stopping, 'COORDINATED_SESSION_STOPPED'); return this.#auxiliary;
  }
  #fail(code) {
    if (!this.#fault) {
      this.#fault = code;
      this.stop();
      // Notification hooks receive a fixed code only, not a raw store error.
      try { Promise.resolve(this.#onFault(code)).catch(() => {}); } catch { /* Owner observes fault via status too. */ }
    }
    this.stop();
  }
  start() {
    invariant(!this.#started && !this.#stopping, 'COORDINATED_SESSION_ALREADY_STARTED'); this.#started = true;
    const pulse = () => {
      if (this.#stopping) return;
      try {
        this.#budget.heartbeat(); this.#heartbeatAt = this.#budget.now();
        this.#timer = this.#setTimer(pulse, 10000); this.#timer?.unref?.();
      } catch { this.#fail('COORDINATED_SESSION_HEARTBEAT_FAILED'); }
    };
    pulse(); invariant(!this.#fault, 'COORDINATED_SESSION_HEARTBEAT_FAILED');
  }
  prepare(id, timing, context = {}) {
    invariant(this.#started && !this.#stopping, 'COORDINATED_SESSION_STOPPED');
    const old = this.#entries.get(id);
    invariant(!old?.busy, 'COORDINATED_SESSION_CONFLICT');
    const handle = this.#bridge.prepare(id, timing, context);
    if (old?.handle === handle) return handle;
    invariant(!old || ['DONE', 'CANCELED'].includes(old.state), 'COORDINATED_SESSION_CONFLICT');
    this.#entries.set(id, { handle, state: 'QUEUED', busy: false }); return handle;
  }
  #entry(handle) {
    const entry = this.#entries.get(handle?.id);
    invariant(entry?.handle === handle, 'COORDINATED_SESSION_HANDLE'); return entry;
  }
  #cancel(entry) {
    try { this.#bridge.cancel(entry.handle); entry.state = 'CANCELED'; }
    catch { this.#cancelFailed = true; this.#fail('COORDINATED_SESSION_CANCEL_FAILED'); throw new Error('COORDINATED_SESSION_CANCEL_FAILED'); }
  }
  cancel(handle) {
    const entry = this.#entry(handle);
    invariant(entry.state === 'QUEUED' && !entry.busy, 'COORDINATED_SESSION_HANDLE_USED'); this.#cancel(entry);
  }
  execute(handle, action) {
    invariant(this.#started && !this.#stopping && typeof action === 'function', 'COORDINATED_SESSION_STOPPED');
    const entry = this.#entry(handle);
    invariant(entry.state === 'QUEUED' && !entry.busy, 'COORDINATED_SESSION_HANDLE_USED'); entry.busy = true;
    const task = Promise.resolve().then(async () => {
      if (this.#stopping) { this.#cancel(entry); throw new Error('COORDINATED_SESSION_STOPPED'); }
      let result;
      try { result = await this.#bridge.execute(handle, admission => action(guardReadAdmission(admission, () => !this.#stopping))); }
      catch { entry.state = 'DONE'; throw new Error('COORDINATED_SESSION_READ_FAILED'); }
      if (result.status === 'COMPLETED') entry.state = 'DONE';
      if (this.#stopping) {
        if (entry.state === 'QUEUED') this.#cancel(entry);
        throw new Error('COORDINATED_SESSION_STOPPED');
      }
      return result;
    });
    this.#pending.add(task);
    task.finally(() => { this.#pending.delete(task); entry.busy = false; }).catch(() => {});
    return task;
  }
  stop() {
    if (this.#stopping) return;
    this.#stopping = true;
    try { if (this.#timer !== null) this.#clearTimer(this.#timer); }
    catch { this.#cancelFailed = true; }
    this.#timer = null;
    this.#auxDrain = this.#auxiliary.close(); this.#auxDrain.catch(() => {});
    for (const entry of this.#entries.values()) if (entry.state === 'QUEUED' && !entry.busy) {
      try { this.#cancel(entry); } catch { /* close fails without releasing ownership. */ }
    }
  }
  close(timeoutMs = 30000, { canRelease = () => true } = {}) {
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'COORDINATED_SESSION_CLOSE_TIMEOUT');
    invariant(typeof canRelease === 'function', 'COORDINATED_SESSION_RELEASE_GUARD_INVALID');
    if (this.#closePromise) return this.#closePromise;
    this.stop();
    this.#closePromise = (async () => {
      let timer;
      try {
        const drain = Promise.all([Promise.allSettled([...this.#pending]), this.#auxDrain]);
        await Promise.race([drain, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('COORDINATED_SESSION_DRAIN_TIMEOUT')), timeoutMs); })]);
        invariant(!this.#cancelFailed, 'COORDINATED_SESSION_CANCEL_FAILED');
        invariant(canRelease() === true, 'COORDINATED_SESSION_RELEASE_FENCED');
        // Deliberately outside the race: a timed-out drain must never release
        // the owner later in a background continuation or claim a clean stop.
        this.#budget.close(); this.#closed = true;
      } catch (error) {
        const code = error?.message === 'COORDINATED_SESSION_DRAIN_TIMEOUT' ? error.message
          : this.#cancelFailed || error?.message === 'READ_DISPATCH_CANCEL_FAILED'
            ? 'COORDINATED_SESSION_CANCEL_FAILED' : 'COORDINATED_SESSION_DRAIN_FAILED';
        this.#fail(code); throw new Error(code);
      } finally { clearTimeout(timer); }
    })();
    this.#closePromise.catch(() => {}); return this.#closePromise;
  }
  status() {
    return Object.freeze({ productionActivated: false, started: this.#started, stopping: this.#stopping, closed: this.#closed,
      fault: this.#fault, lastHeartbeatAt: this.#heartbeatAt, pendingActions: this.#pending.size,
      queued: [...this.#entries.values()].filter(e => e.state === 'QUEUED').length });
  }
  readBudgetStatus() {
    invariant(!this.#closed, 'COORDINATED_SESSION_CLOSED');
    return { ...this.#budget.status(), coordination: this.#budget.coordinationStatus(),
      consumer: this.#budget.consumer, residentAdmissionEnrolled: true,
      allIpConsumersVerified: false, stopping: this.#stopping };
  }
}
