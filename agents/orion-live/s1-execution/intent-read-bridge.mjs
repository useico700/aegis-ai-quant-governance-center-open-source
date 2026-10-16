import { invariant } from './common.mjs';
import { CoordinatedReadBudget } from './coordinated-read-budget.mjs';
import { readIntentSpec } from './read-intent-catalog.mjs';
import { readIntentRequests, requestBindingKey } from './read-request-bindings.mjs';

const attached = new WeakSet();
const drainedUnsentFailures = new WeakSet();

// Opaque local provenance, never inferred from an error string or caller field.
// A true result proves no request binding/slot was used and the original
// failure survived the budget's complete unused-slot cleanup unchanged.
export function isDrainedUnsentReadFailure(error) { return drainedUnsentFailures.has(error); }
const waitCodes = new Set(['READ_COORDINATION_NOT_SELECTED', 'READ_COORDINATION_WAIT_FOR_RELEASE',
  'READ_COORDINATION_WAIT_FOR_BUDGET', 'READ_COORDINATION_PRODUCERS_UNAVAILABLE',
  'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN', 'READ_BUDGET_IP_HEADROOM', 'READ_BUDGET_LOCAL_WEIGHT']);

// Recheck lifecycle at binding, slot use AND callback entry. A previously
// reserved slot is not permission to begin a new HTTP request after stop.
export function guardReadAdmission(admission, canDispatch) {
  const check = () => invariant(canDispatch() === true, 'READ_SESSION_DISPATCH_CLOSED');
  const guarded = { run(weight, action) {
    check(); return admission.run(weight, observe => { check(); return action(observe); });
  } };
  if (typeof admission.bindRequest === 'function') guarded.bindRequest = request => {
    check(); return guardReadAdmission(admission.bindRequest(request), canDispatch);
  };
  if (typeof admission.runBatch === 'function') guarded.runBatch = (weights, action) => {
    check(); return admission.runBatch(weights, slots => { check(); return action(Object.freeze(slots.map(slot => guardReadAdmission(slot, canDispatch)))); });
  };
  return Object.freeze(guarded);
}

// Local preparation only. The caller retries an opaque queued handle at its
// existing cadence; this class never sleeps/retries or signs a request itself.
// Signing/action begins only AFTER the durable atomic reservation succeeds.
export class IntentReadBridge {
  #budget; #connection; #epoch; #entries = new Map(); #handles = new WeakMap();
  constructor(budget) {
    invariant(budget instanceof CoordinatedReadBudget && budget.db && !attached.has(budget), 'READ_BRIDGE_OWNER_REQUIRED');
    attached.add(budget); this.#budget = budget; this.#connection = budget.db; this.#epoch = budget.epoch;
  }
  #assertOwner() {
    invariant(this.#budget.db === this.#connection && this.#budget.epoch === this.#epoch
      && this.#budget.owner && !this.#budget.failed, 'READ_BRIDGE_OWNER_REQUIRED');
  }
  prepare(id, timing, context = {}) {
    this.#assertOwner();
    const requests = readIntentRequests(id, context);
    invariant(timing && Object.getPrototypeOf(timing) === Object.prototype
      && Object.keys(timing).sort().join(',') === 'deadlineAt,readyAt', 'READ_BRIDGE_TIMING');
    const fingerprint = JSON.stringify([timing.readyAt, timing.deadlineAt, requests.map(requestBindingKey)]);
    const old = this.#entries.get(id);
    if (old?.fingerprint === fingerprint) return old.handle;
    invariant(!old || old.state === 'DONE' || old.state === 'CANCELED', 'READ_BRIDGE_INTENT_CONFLICT');
    const receipt = this.#budget.announce(id, timing);
    // A process must not attach new semantics to a queue entry registered
    // outside this bridge. Restart acquires a new epoch and retires old entries.
    invariant(!receipt.duplicate && receipt.state === 'QUEUED', 'READ_BRIDGE_UNKNOWN_RECEIPT');
    const handle = Object.freeze({ id });
    const entry = { handle, fingerprint, requests, state: 'QUEUED' };
    this.#entries.set(id, entry); this.#handles.set(handle, entry);
    return handle;
  }
  #entry(handle) {
    this.#assertOwner();
    const entry = this.#handles.get(handle);
    invariant(entry && this.#entries.get(handle.id) === entry, 'READ_BRIDGE_HANDLE_INVALID');
    return entry;
  }
  cancel(handle) {
    const entry = this.#entry(handle);
    invariant(entry.state === 'QUEUED', 'READ_BRIDGE_HANDLE_USED');
    invariant(this.#budget.cancel(handle.id), 'READ_BRIDGE_CANCEL_FAILED');
    entry.state = 'CANCELED';
  }
  async execute(handle, action) {
    const entry = this.#entry(handle);
    invariant(entry.state === 'QUEUED' && typeof action === 'function', 'READ_BRIDGE_HANDLE_USED');
    entry.state = 'CLAIMING'; let entered = false, unsentError = null;
    try {
      const value = await this.#budget.runIntentBatch(handle.id, async slots => {
        entered = true;
        const weights = readIntentSpec(handle.id).weights, keys = entry.requests.map(requestBindingKey);
        const bound = new Set(), sent = new Set(), tasks = [];
        let open = true, batchLoaned = false;
        const forbidden = () => { throw new Error('READ_BRIDGE_BINDING_REQUIRED'); };
        const binder = indices => Object.freeze({ run: forbidden, bindRequest: request => {
          invariant(open, 'READ_BRIDGE_CLOSED');
          const key = requestBindingKey(request), i = indices.find(n => !bound.has(n) && keys[n] === key);
          invariant(i !== undefined, 'READ_BRIDGE_REQUEST_MISMATCH'); bound.add(i);
          return Object.freeze({ run: (weight, callback) => {
            invariant(open && !sent.has(i), 'READ_BRIDGE_SLOT_USED');
            // The underlying slot validates weight, age, cooldown and its token.
            const task = slots[i].run(weight, callback); sent.add(i); tasks.push(task);
            task.catch(() => {}); return task;
          } });
        } });
        const indices = slots.map((_, i) => i), routed = binder(indices);
        const admission = Object.freeze({ ...routed, runBatch: (requested, callback) => {
          invariant(open && !batchLoaned && bound.size === 0 && typeof callback === 'function'
            && JSON.stringify(requested) === JSON.stringify(weights), 'READ_BRIDGE_BATCH_MISMATCH');
          batchLoaned = true;
          return callback(Object.freeze(indices.map(i => binder([i]))));
        } });
        try {
          const result = await action(admission);
          open = false; // No late child may start while the original bodies drain.
          // Caller cannot report success after swallowing a failed child read.
          await Promise.all(tasks);
          invariant(sent.size === slots.length, 'READ_BRIDGE_INCOMPLETE');
          return result;
        } catch (error) {
          if (error instanceof Error && bound.size === 0 && sent.size === 0 && tasks.length === 0) unsentError = error;
          throw error;
        } finally { open = false; await Promise.allSettled(tasks); }
      });
      entry.state = 'DONE'; return Object.freeze({ status: 'COMPLETED', value });
    } catch (error) {
      if (!entered && waitCodes.has(error?.message)) {
        entry.state = 'QUEUED'; return Object.freeze({ status: 'WAIT', reason: error.message });
      }
      entry.state = 'DONE';
      // Never leak signed URLs, payloads, caller exceptions or SQLite details.
      const failure = new Error('READ_BRIDGE_EXECUTION_FAILED');
      if (entered && unsentError !== null && error === unsentError
        && this.#budget.db === this.#connection && this.#budget.epoch === this.#epoch && this.#budget.owner && !this.#budget.failed) {
        drainedUnsentFailures.add(failure);
      }
      throw failure;
    }
  }
}
