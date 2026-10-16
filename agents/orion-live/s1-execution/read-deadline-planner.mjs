import { invariant } from './common.mjs';
import { READ_INTENT_IDS, readIntentSpec } from './read-intent-catalog.mjs';

// Offline preparation only: no host binding, persistence, network or leases.
// A selection is NOT a reservation. Any future host integration must register
// all producers and select/reserve atomically in the existing budget store.
// Deadline values are supplied by the workload's verified freshness contract;
// this planner never extends deadlines or stamps source observations.
const HEADROOM = Object.freeze({ reader: 0, shadow: 160, scanner: 160,
  context: 265, history: 265, fees: 265 });
const FIELDS = ['id', 'lane', 'createdAt', 'readyAt', 'deadlineAt', 'weight'].sort().join(',');
const time = value => Number.isSafeInteger(value) && value >= 0;
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const streamIds = new Set(READ_INTENT_IDS.filter(id => /^(reader|shadow):stream:(post|put|delete)$/.test(id)));
// Pinned producer request maxima; their dispatchers enforce the actual hard
// cutoff too. A planned PUT stores release-65s as its soft queue target.
const renewalWindows = Object.freeze({ 'reader:stream:put': 8000, 'shadow:stream:put': 5000 });
const result = (status, selected = null, deadlineMissed = false) => Object.freeze({
  status, selected, deadlineMissed, admissionGranted: false,
});

export function planReadDeadline({ intents, now, canStart, protectFutureDeadlines = false }) {
  invariant(time(now) && typeof canStart === 'function' && typeof protectFutureDeadlines === 'boolean', 'READ_COORDINATION_PORT_INVALID');
  invariant(Array.isArray(intents) && intents.length <= 128, 'READ_COORDINATION_QUEUE_INVALID');
  const ids = new Set();
  const rows = Array.from(intents, row => {
    invariant(row && Object.getPrototypeOf(row) === Object.prototype
      && Object.keys(row).sort().join(',') === FIELDS, 'READ_COORDINATION_INTENT_INVALID');
    invariant(typeof row.id === 'string' && /^[a-z0-9:_-]{1,64}$/.test(row.id)
      && !ids.has(row.id) && typeof row.lane === 'string'
      && Object.hasOwn(HEADROOM, row.lane), 'READ_COORDINATION_ID_INVALID');
    invariant(time(row.createdAt) && time(row.readyAt) && time(row.deadlineAt)
      && row.createdAt <= now && row.readyAt >= row.createdAt, 'READ_COORDINATION_TIME_INVALID');
    invariant(Number.isSafeInteger(row.weight) && row.weight > 0 && row.weight <= 900,
      'READ_COORDINATION_WEIGHT_INVALID');
    ids.add(row.id);
    return Object.freeze({ ...row, headroom: HEADROOM[row.lane] });
  });
  const ready = rows.filter(row => row.readyAt <= now || (protectFutureDeadlines && row.deadlineAt <= now))
    .sort((a, b) => a.deadlineAt - b.deadlineAt || a.createdAt - b.createdAt || lexical(a.id, b.id));
  if (!ready.length) return result(rows.length ? 'WAIT_FOR_RELEASE' : 'IDLE');
  const selected = ready[0], missed = now > selected.deadlineAt;
  const allowed = (row, headroom = row.headroom) => {
    let value;
    try { value = canStart(row.weight, headroom, row.lane); }
    catch { throw new Error('READ_COORDINATION_ADMISSION_UNAVAILABLE'); }
    invariant(typeof value === 'boolean', 'READ_COORDINATION_ADMISSION_INVALID');
    return value;
  };
  // A due lease renewal has a hard cutoff, unlike stale history/fee targets.
  // Only the fixed, preplanned PUT shape qualifies, never an initial POST,
  // DELETE, early release or an expired window. It retains its ORIGINAL lane
  // reserve and competes for the same atomic weight/concurrency admission.
  // Other work keeps its original target/receipt and resumes after this one
  // bounded request; producers still impose the original 20/50-minute cadence.
  const renewal = protectFutureDeadlines ? ready.filter(row => Object.hasOwn(renewalWindows, row.id)
    && row.createdAt < row.readyAt && row.deadlineAt === row.readyAt - 65000 && row.readyAt <= now && now < row.readyAt + renewalWindows[row.id]
    && row.lane === readIntentSpec(row.id).lane && row.weight === readIntentSpec(row.id).weight)
    .sort((a, b) => a.readyAt + renewalWindows[a.id] - b.readyAt - renewalWindows[b.id] || lexical(a.id, b.id))[0] : null;
  if (renewal) return result(allowed(renewal) ? 'SELECTED_REQUIRES_ATOMIC_ADMISSION' : 'WAIT_FOR_BUDGET', renewal,
    now > renewal.deadlineAt);
  // A known upcoming refresh can have an earlier scheduling target than its
  // allowed dispatch time. Once that target is reached, preserve capacity;
  // never execute it early or move its deadline to make it look on time.
  if (selected.readyAt > now) {
    // Protect capacity, not idle wall time. Only the earliest released job may
    // run, and only after retaining every earlier future cost and the largest
    // original reserve. Never skip an unaffordable released job for cheaper
    // work behind it. Durable callers perform this check and charge atomically.
    // Keep the previously tested hard-cutoff maintenance exception ahead of
    // ordinary released work, with all preceding costs still retained.
    const maintenance = ready.findIndex(row => streamIds.has(row.id) && row.readyAt <= now
      && row.deadlineAt > now && row.deadlineAt <= selected.readyAt && row.deadlineAt - row.createdAt <= 10000
      && row.lane === readIntentSpec(row.id).lane && row.weight === readIntentSpec(row.id).weight);
    const index = maintenance > 0 ? maintenance : ready.findIndex(row => row.readyAt <= now);
    if (index > 0) {
      const candidate = ready[index], earlier = ready.slice(0, index);
      const headroom = Math.max(candidate.headroom, earlier.reduce((n, row) => n + row.weight, 0)
        + Math.max(...earlier.map(row => row.headroom)));
      if (allowed(candidate, headroom)) return result('SELECTED_REQUIRES_ATOMIC_ADMISSION',
        Object.freeze({ ...candidate, headroom }), now > candidate.deadlineAt);
    }
    return result('WAIT_FOR_RELEASE', selected, missed);
  }
  // Do not spend on a later-deadline cheap job while the earliest ready job
  // is waiting for capacity: that would perpetuate deadline starvation.
  return result(allowed(selected) ? 'SELECTED_REQUIRES_ATOMIC_ADMISSION' : 'WAIT_FOR_BUDGET', selected, missed);
}
