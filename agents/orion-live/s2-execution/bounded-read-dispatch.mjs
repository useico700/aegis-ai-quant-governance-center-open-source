import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { setTimeout as delay } from 'node:timers/promises';
import { invariant } from './common.mjs';
import { readIntentSpec } from './read-intent-catalog.mjs';
import { IntentReadBridge, guardReadAdmission, isDrainedUnsentReadFailure } from './intent-read-bridge.mjs';

const attached = new WeakSet();

// Short auxiliary operations only (history's existing 20s window or a stream
// request timeout). Not the long-horizon fee/account scheduler or a retry of
// sent I/O. WAIT retries reuse the original handle, window and deadline.
export class BoundedReadDispatch {
  #bridge; #now; #sleep; #lastNow = 0; #lastReady = new Map();
  #active = new Map(); #abort = new AbortController();
  #prepared = new Map();
  #canceledPlans = new WeakSet();
  #consumedHistoryPlans = new WeakSet();
  #cancelFailed = false;
  constructor({ bridge, now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }) }) {
    invariant(bridge instanceof IntentReadBridge && !attached.has(bridge)
      && typeof now === 'function' && typeof sleep === 'function', 'READ_DISPATCH_PORTS');
    attached.add(bridge);
    this.#bridge = bridge; this.#now = now; this.#sleep = sleep;
  }
  now() {
    const at = this.#now();
    invariant(Number.isSafeInteger(at) && at >= this.#lastNow, 'READ_DISPATCH_CLOCK');
    this.#lastNow = at; return at;
  }
  prepareMaintenance(id, { readyAt, timeoutMs }) {
    readIntentSpec(id);
    invariant(/^(reader|shadow):stream:put$/.test(id) && !this.#abort.signal.aborted
      && !this.#active.has(id), 'READ_DISPATCH_MAINTENANCE_SCOPE');
    const at = this.now();
    invariant(Number.isSafeInteger(readyAt) && readyAt > at && readyAt - at <= 65000
      && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000
      && Number.isSafeInteger(readyAt + timeoutMs), 'READ_DISPATCH_MAINTENANCE_TIME');
    const old = this.#prepared.get(id);
    if (old) {
      invariant(old.plan.readyAt === readyAt && old.plan.deadlineAt === readyAt + timeoutMs, 'READ_DISPATCH_MAINTENANCE_CONFLICT');
      return old.plan;
    }
    invariant(readyAt > (this.#lastReady.get(id) ?? -1), 'READ_DISPATCH_MAINTENANCE_REPLAY');
    const handle = this.#bridge.prepare(id, { readyAt, deadlineAt: Math.max(0, readyAt - 65000) });
    const plan = Object.freeze({ id, readyAt, deadlineAt: readyAt + timeoutMs });
    this.#lastReady.set(id, readyAt); this.#prepared.set(id, { plan, handle, kind: 'maintenance' }); return plan;
  }
  prepareHistory(id, options) {
    readIntentSpec(id);
    invariant(/^shadow:history:[a-z]+$/.test(id) && !this.#abort.signal.aborted && !this.#cancelFailed
      && !this.#active.has(id), 'READ_DISPATCH_HISTORY_SCOPE');
    invariant(options && Object.getPrototypeOf(options) === Object.prototype
      && Object.keys(options).sort().join(',') === 'context,readyAt,schedulingTargetAt', 'READ_DISPATCH_HISTORY_OPTIONS');
    const { readyAt, schedulingTargetAt, context } = options, at = this.now();
    invariant(Number.isSafeInteger(readyAt) && readyAt > at && readyAt - at <= 30000
      && Number.isSafeInteger(readyAt + 20000) && Number.isSafeInteger(schedulingTargetAt)
      && schedulingTargetAt >= 0 && schedulingTargetAt <= readyAt + 20000, 'READ_DISPATCH_HISTORY_TIME');
    invariant(context && Object.getPrototypeOf(context) === Object.prototype
      && Object.keys(context).sort().join(',') === 'endTime,startTime'
      && Number.isSafeInteger(context.startTime) && Number.isSafeInteger(context.endTime)
      && context.startTime > 0 && context.startTime >= readyAt - 7 * 86400000
      && context.endTime >= context.startTime && context.endTime - context.startTime <= 3600000
      && context.endTime <= readyAt - 2000, 'READ_DISPATCH_HISTORY_WINDOW');
    const old = this.#prepared.get(id);
    if (old) {
      invariant(old.kind === 'history' && old.plan.readyAt === readyAt && old.plan.schedulingTargetAt === schedulingTargetAt
        && old.plan.context.startTime === context.startTime && old.plan.context.endTime === context.endTime,
      'READ_DISPATCH_HISTORY_CONFLICT');
      return old.plan;
    }
    // One upcoming initial batch, never ten future reservations. Preparation
    // is only queue visibility: no token, signing transport or I/O is created.
    invariant(![...this.#prepared.values()].some(entry => entry.kind === 'history'), 'READ_DISPATCH_HISTORY_PENDING');
    invariant(readyAt > (this.#lastReady.get(id) ?? -1), 'READ_DISPATCH_HISTORY_REPLAY');
    const window = Object.freeze({ startTime: context.startTime, endTime: context.endTime });
    const handle = this.#bridge.prepare(id, { readyAt, deadlineAt: schedulingTargetAt }, window);
    const plan = Object.freeze({ id, readyAt, deadlineAt: readyAt + 20000,
      admissionDeadlineAt: readyAt + 15000, schedulingTargetAt, context: window });
    this.#lastReady.set(id, readyAt); this.#prepared.set(id, { plan, handle, kind: 'history' }); return plan;
  }
  runPreparedHistory(plan, action) {
    const entry = this.#prepared.get(plan?.id), at = this.now();
    invariant(!this.#abort.signal.aborted && !this.#cancelFailed && entry?.kind === 'history' && entry.plan === plan
      && typeof action === 'function' && !this.#active.has(plan.id), 'READ_DISPATCH_HISTORY_HANDLE');
    invariant(at >= plan.readyAt, 'READ_DISPATCH_HISTORY_NOT_RELEASED');
    if (at >= plan.admissionDeadlineAt) { this.cancelPrepared(plan); throw new Error('READ_DISPATCH_DEADLINE'); }
    this.#prepared.delete(plan.id);
    this.#consumedHistoryPlans.add(plan);
    const task = Promise.resolve().then(() => this.#execute(entry.handle, plan.readyAt, plan.deadlineAt, action, plan.admissionDeadlineAt));
    this.#active.set(plan.id, task); task.finally(() => this.#active.delete(plan.id)).catch(() => {}); return task;
  }
  cancelUnstartedHistory(plan) {
    // Idempotence applies only to this dispatcher's exact retired capabilities.
    // An active/sent batch is drained by #execute/session close, never canceled
    // or refunded through this producer cleanup hook.
    invariant(typeof plan?.id === 'string' && /^shadow:history:[a-z]+$/.test(plan.id), 'READ_DISPATCH_HISTORY_HANDLE');
    if (this.#consumedHistoryPlans.has(plan) || this.#canceledPlans.has(plan)) return false;
    const entry = this.#prepared.get(plan?.id);
    invariant(entry?.kind === 'history' && entry.plan === plan, 'READ_DISPATCH_HISTORY_HANDLE');
    this.cancelPrepared(plan); return true;
  }
  cancelPrepared(plan) {
    // Session.stop() may have already canceled this exact plan before the
    // owning stream closes. Only a successful cancellation by this dispatcher
    // qualifies; unknown handles and failed cancellation still fail closed.
    if (this.#abort.signal.aborted && this.#canceledPlans.has(plan)) return;
    const entry = this.#prepared.get(plan?.id);
    invariant(entry?.plan === plan, 'READ_DISPATCH_MAINTENANCE_HANDLE');
    try { this.#bridge.cancel(entry.handle); this.#prepared.delete(plan.id); this.#canceledPlans.add(plan); }
    catch { this.#cancelFailed = true; throw new Error('READ_DISPATCH_CANCEL_FAILED'); }
  }
  runPrepared(plan, action) {
    const entry = this.#prepared.get(plan?.id), at = this.now();
    invariant(!this.#abort.signal.aborted && entry?.kind === 'maintenance' && entry.plan === plan && typeof action === 'function'
      && !this.#active.has(plan.id), 'READ_DISPATCH_MAINTENANCE_HANDLE');
    invariant(at >= plan.readyAt, 'READ_DISPATCH_MAINTENANCE_NOT_RELEASED');
    if (at >= plan.deadlineAt) { this.cancelPrepared(plan); throw new Error('READ_DISPATCH_DEADLINE'); }
    this.#prepared.delete(plan.id);
    const task = Promise.resolve().then(() => this.#execute(entry.handle, plan.readyAt, plan.deadlineAt, action));
    this.#active.set(plan.id, task); task.finally(() => this.#active.delete(plan.id)).catch(() => {}); return task;
  }
  run(id, { context = {}, deadlineAt, schedulingTargetAt = deadlineAt, reserveHistoryIo = false } = {}, action) {
    readIntentSpec(id);
    invariant(!this.#abort.signal.aborted && !this.#active.has(id) && !this.#prepared.has(id), 'READ_DISPATCH_UNAVAILABLE');
    const at = this.now();
    invariant(typeof action === 'function' && Number.isSafeInteger(deadlineAt) && deadlineAt > at
      && deadlineAt - at <= 20000, 'READ_DISPATCH_DEADLINE');
    invariant(typeof reserveHistoryIo === 'boolean' && (!reserveHistoryIo || /^shadow:(history|trades|forced):/.test(id)), 'READ_DISPATCH_IO_RESERVE_SCOPE');
    // An optional history admission cutoff leaves the existing SignedTransport
    // five-second I/O allowance inside the ORIGINAL complete window. It does
    // not shorten a sent request or convert a late result to a success.
    const admissionDeadlineAt = deadlineAt - (reserveHistoryIo ? 5000 : 0);
    // Queue urgency and the hard I/O cutoff are different contracts. A source
    // that is overdue must retain its original target across a later attempt;
    // this never extends the complete operation's twenty-second cutoff.
    invariant(Number.isSafeInteger(schedulingTargetAt) && schedulingTargetAt >= 0
      && schedulingTargetAt <= deadlineAt, 'READ_DISPATCH_TARGET');
    // readyAt is a scheduling release time, not a source observation timestamp.
    // Multiple pages in one millisecond get a later release and must wait for it.
    const readyAt = Math.max(at, (this.#lastReady.get(id) ?? -1) + 1);
    invariant(readyAt < admissionDeadlineAt, 'READ_DISPATCH_DEADLINE');
    const handle = this.#bridge.prepare(id, { readyAt, deadlineAt: schedulingTargetAt }, context);
    this.#lastReady.set(id, readyAt);
    // Defer execution until the active record exists, including reentrant calls.
    const task = Promise.resolve().then(() => this.#execute(handle, readyAt, deadlineAt, action, admissionDeadlineAt));
    this.#active.set(id, task);
    task.finally(() => this.#active.delete(id)).catch(() => {});
    return task;
  }
  async #execute(handle, readyAt, deadlineAt, action, admissionDeadlineAt = deadlineAt) {
    let queued = true;
    try {
      while (true) {
        invariant(!this.#abort.signal.aborted, 'READ_DISPATCH_STOPPED');
        const at = this.now(); invariant(at < admissionDeadlineAt, 'READ_DISPATCH_DEADLINE');
        if (at >= readyAt) {
          let result, rejectedBeforeAction = false;
          try { result = await this.#bridge.execute(handle, admission => {
            if (this.now() >= admissionDeadlineAt) {
              rejectedBeforeAction = true;
              throw new Error('READ_DISPATCH_DEADLINE');
            }
            return action(guardReadAdmission(admission, () => !this.#abort.signal.aborted && this.now() < deadlineAt));
          }); }
          catch (error) {
            queued = false;
            // Reservation is already spent. Only our own pre-action cutoff
            // plus a verified, unchanged bridge drain can be an unsent wait;
            // caller errors and cleanup failures remain request failures.
            throw new Error(rejectedBeforeAction && isDrainedUnsentReadFailure(error)
              ? 'READ_DISPATCH_DEADLINE' : 'READ_DISPATCH_REQUEST_FAILED');
          }
          if (result.status === 'COMPLETED') {
            queued = false;
            invariant(!this.#abort.signal.aborted && this.now() < deadlineAt, 'READ_DISPATCH_RESULT_EXPIRED');
            return result.value;
          }
        }
        const before = this.now(); invariant(before < admissionDeadlineAt, 'READ_DISPATCH_DEADLINE');
        invariant(!this.#abort.signal.aborted, 'READ_DISPATCH_STOPPED');
        await this.#sleep(Math.min(admissionDeadlineAt - before, before < readyAt ? readyAt - before : 1000), this.#abort.signal);
        invariant(this.now() > before, 'READ_DISPATCH_CLOCK');
      }
    } catch (error) {
      const safe = new Set(['READ_DISPATCH_STOPPED', 'READ_DISPATCH_DEADLINE', 'READ_DISPATCH_REQUEST_FAILED',
        'READ_DISPATCH_RESULT_EXPIRED', 'READ_DISPATCH_CLOCK']);
      throw new Error(this.#abort.signal.aborted ? 'READ_DISPATCH_STOPPED'
        : safe.has(error?.message) ? error.message : 'READ_DISPATCH_FAILED');
    } finally {
      // No refund and no deletion of claimed work. Executed actions are already
      // fully drained by the bridge; only an unclaimed queued handle is canceled.
      if (queued) {
        try { this.#bridge.cancel(handle); }
        catch { this.#cancelFailed = true; throw new Error('READ_DISPATCH_CANCEL_FAILED'); }
      }
    }
  }
  async close() {
    this.#abort.abort();
    for (const { plan } of this.#prepared.values()) {
      try { this.cancelPrepared(plan); } catch { /* Drain still runs; failure keeps ownership held. */ }
    }
    await Promise.allSettled([...this.#active.values()]);
    invariant(!this.#cancelFailed, 'READ_DISPATCH_CANCEL_FAILED');
  }
}
