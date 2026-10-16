import { SharedReadBudget, SHARED_READ_CONSUMERS } from './shared-read-budget.mjs';
import { planReadDeadline } from './read-deadline-planner.mjs';
import { readIntentSpec } from './read-intent-catalog.mjs';
import { invariant } from './common.mjs';

// Schema-v2 PREPARATION. The explicit coordinated reader entry uses the guarded
// migrated-host factory; existing service commands remain v1. No fallback.
// Pending request lifetime/cooldown/no-refund rules are inherited unchanged.
const HEX = /^[a-f0-9]{32}$/, MAX_AHEAD = 900000, OWNER_AGE_MS = 30000;
const time = n => Number.isSafeInteger(n) && n >= 0;

export class CoordinatedReadBudget extends SharedReadBudget {
  #claim = null;
  #selected = null;
  get schemaVersion() { return 2; }
  validateAdditionalState({ budget, rows: pending }) {
    const at = budget.now(), owners = this.db.prepare('SELECT * FROM coordination_owners').all();
    invariant(owners.length <= 3 && owners.every(o => SHARED_READ_CONSUMERS.includes(o.consumer)
      && HEX.test(o.epoch) && time(o.heartbeat) && o.heartbeat <= at && [0, 1].includes(o.active)
      && time(o.retired)), 'READ_COORDINATION_OWNERS_INVALID');
    const rows = this.db.prepare('SELECT * FROM read_intents').all();
    invariant(rows.length <= 128, 'READ_COORDINATION_QUEUE_INVALID');
    for (const row of rows) {
      const spec = readIntentSpec(row.id), owner = owners.find(o => o.consumer === row.consumer);
      invariant(spec.consumer === row.consumer && owner?.epoch === row.epoch && owner.active === 1,
        'READ_COORDINATION_INTENT_OWNER_INVALID');
      invariant(time(row.created_at) && row.created_at <= at && time(row.ready_at)
        && row.ready_at - row.created_at <= MAX_AHEAD
        && time(row.deadline_at) && row.deadline_at - row.created_at <= MAX_AHEAD,
      'READ_COORDINATION_TIME_INVALID');
      invariant([0, 1, 2, 3].includes(row.phase), 'READ_COORDINATION_PHASE_INVALID');
    }
    const claims = this.db.prepare('SELECT * FROM read_claims').all();
    invariant(claims.length === pending.length && claims.length <= 8, 'READ_COORDINATION_CLAIMS_INVALID');
    for (const claim of claims) {
      const request = pending.find(p => p.token === claim.token), row = rows.find(r => r.id === claim.intent_id);
      invariant(request && row?.phase === 1 && request.consumer === claim.consumer && request.epoch === claim.epoch
        && row.consumer === claim.consumer && row.epoch === claim.epoch, 'READ_COORDINATION_CLAIM_OWNER_INVALID');
    }
    invariant(rows.every(row => (row.phase === 1) === claims.some(c => c.intent_id === row.id)), 'READ_COORDINATION_PHASE_CLAIM_MISMATCH');
  }
  ownerAcquired({ at }) {
    // The inherited exclusive owner lock proves that the old instance of THIS
    // consumer is gone. Retire only its old-generation intent receipts and
    // claim bindings, not another owner's work or any spent weight. Inherited
    // pending recovery has already quarantined this owner's uncertain requests
    // and added its full cooldown in the same transaction.
    const old = this.db.prepare('SELECT * FROM coordination_owners WHERE consumer=?').get(this.consumer);
    this.db.prepare('DELETE FROM read_claims WHERE consumer=?').run(this.consumer);
    const removed = this.db.prepare('DELETE FROM read_intents WHERE consumer=?').run(this.consumer).changes;
    const retired = (old?.retired ?? 0) + Number(removed);
    invariant(time(retired), 'READ_COORDINATION_COUNTER_INVALID');
    this.db.prepare('INSERT INTO coordination_owners VALUES(?,?,?,?,?) ON CONFLICT(consumer) DO UPDATE SET epoch=excluded.epoch,heartbeat=excluded.heartbeat,active=1,retired=excluded.retired')
      .run(this.consumer, this.epoch, at, 1, retired);
  }
  #assertOwner(at) {
    const owner = this.db.prepare('SELECT * FROM coordination_owners WHERE consumer=?').get(this.consumer);
    invariant(owner?.epoch === this.epoch && owner.active === 1 && owner.heartbeat <= at, 'READ_COORDINATION_OWNER_FENCED');
  }
  #touch(at) {
    this.#assertOwner(at);
    this.db.prepare('UPDATE coordination_owners SET heartbeat=? WHERE consumer=?').run(at, this.consumer);
  }
  heartbeat() { this.transaction(({ budget }) => this.#touch(budget.now())); }
  announce(id, options = {}) {
    invariant(options && Object.getPrototypeOf(options) === Object.prototype
      && Object.keys(options).sort().join(',') === 'deadlineAt,readyAt', 'READ_COORDINATION_INTENT_FIELDS');
    const { readyAt, deadlineAt } = options;
    const spec = readIntentSpec(id);
    invariant(spec.consumer === this.consumer, 'READ_COORDINATION_WRONG_CONSUMER');
    return this.transaction(({ budget }) => {
      const at = budget.now(); this.#touch(at);
      invariant(time(readyAt) && readyAt - at <= MAX_AHEAD
        && time(deadlineAt) && deadlineAt - at <= MAX_AHEAD, 'READ_COORDINATION_TIME_INVALID');
      const old = this.db.prepare('SELECT * FROM read_intents WHERE id=?').get(id);
      if (old) {
        invariant(old.epoch === this.epoch, 'READ_COORDINATION_INTENT_OWNER_INVALID');
        if (old.ready_at === readyAt && old.deadline_at === deadlineAt) return Object.freeze({ id, createdAt: old.created_at,
          state: ['QUEUED', 'CLAIMED', 'SETTLED', 'CANCELED'][old.phase], duplicate: true });
        invariant([2, 3].includes(old.phase), 'READ_COORDINATION_INTENT_CONFLICT');
        invariant(readyAt > old.ready_at, 'READ_COORDINATION_INTENT_REPLAY');
        this.db.prepare('UPDATE read_intents SET created_at=?,ready_at=?,deadline_at=?,phase=0 WHERE id=?').run(at, readyAt, deadlineAt, id);
        return Object.freeze({ id, createdAt: at, state: 'QUEUED', duplicate: false });
      }
      invariant(this.db.prepare('SELECT COUNT(*) AS n FROM read_intents').get().n < 128, 'READ_COORDINATION_QUEUE_INVALID');
      this.db.prepare('INSERT INTO read_intents VALUES(?,?,?,?,?,?,0)').run(id, this.consumer, this.epoch, at, readyAt, deadlineAt);
      return Object.freeze({ id, createdAt: at, state: 'QUEUED', duplicate: false });
    });
  }
  cancel(id) {
    invariant(readIntentSpec(id).consumer === this.consumer, 'READ_COORDINATION_WRONG_CONSUMER');
    return this.transaction(({ budget }) => {
      this.#touch(budget.now());
      // Keep the bounded last receipt: an identical delayed registration must
      // not resurrect canceled or completed work. Claimed requests are intact.
      return this.db.prepare('UPDATE read_intents SET phase=3 WHERE id=? AND consumer=? AND epoch=? AND phase=0').run(id, this.consumer, this.epoch).changes === 1;
    });
  }
  beforeReservation({ budget, weights }) {
    const id = this.#claim; this.#claim = null;
    invariant(id !== null, 'READ_COORDINATION_UNSCHEDULED_ADMISSION');
    const spec = readIntentSpec(id), at = budget.now();
    invariant(spec.consumer === this.consumer && JSON.stringify(spec.weights) === JSON.stringify(weights), 'READ_COORDINATION_CLAIM_MISMATCH');
    this.#touch(at);
    const owners = this.db.prepare('SELECT * FROM coordination_owners').all();
    invariant(owners.length === 3 && owners.every(o => o.active === 1 && at - o.heartbeat <= OWNER_AGE_MS), 'READ_COORDINATION_PRODUCERS_UNAVAILABLE');
    const intents = this.db.prepare('SELECT * FROM read_intents WHERE phase=0').all().map(row => {
      const entry = readIntentSpec(row.id);
      return { id: row.id, lane: entry.lane, createdAt: row.created_at, readyAt: Math.max(row.created_at, row.ready_at),
        deadlineAt: row.deadline_at, weight: entry.weight };
    });
    const decision = planReadDeadline({ intents, now: at, protectFutureDeadlines: true,
      canStart: (weight, headroom) => budget.canStartLowPriorityRead(weight, headroom) });
    invariant(decision.status === 'SELECTED_REQUIRES_ATOMIC_ADMISSION',
      decision.status === 'WAIT_FOR_BUDGET' ? 'READ_COORDINATION_WAIT_FOR_BUDGET' : 'READ_COORDINATION_WAIT_FOR_RELEASE');
    invariant(decision.selected.id === id, 'READ_COORDINATION_NOT_SELECTED');
    invariant(this.db.prepare('UPDATE read_intents SET phase=1 WHERE id=? AND consumer=? AND epoch=? AND phase=0').run(id, this.consumer, this.epoch).changes === 1,
      'READ_COORDINATION_CLAIM_LOST');
    this.#selected = id;
    // The inherited reserveBatch now charges every actual request and inserts
    // its pending token(s) before COMMIT. Any failure rolls this phase back.
  }
  afterReservation({ tokens }) {
    invariant(this.#selected !== null, 'READ_COORDINATION_CLAIM_LOST');
    for (const token of tokens) this.db.prepare('INSERT INTO read_claims VALUES(?,?,?,?)').run(token, this.#selected, this.consumer, this.epoch);
    this.#selected = null;
  }
  beforeFinish({ token }) {
    // SETTLED means admission ownership drained, not that HTTP succeeded or
    // that any source observation became fresh. Unused slots settle as well.
    const claim = this.db.prepare('SELECT * FROM read_claims WHERE token=?').get(token);
    invariant(claim?.consumer === this.consumer && claim.epoch === this.epoch, 'READ_COORDINATION_CLAIM_OWNER_INVALID');
    this.db.prepare('DELETE FROM read_claims WHERE token=?').run(token);
    if (!this.db.prepare('SELECT token FROM read_claims WHERE intent_id=? LIMIT 1').get(claim.intent_id))
      this.db.prepare('UPDATE read_intents SET phase=2 WHERE id=? AND phase=1').run(claim.intent_id);
  }
  reserveIntent(id) {
    const spec = readIntentSpec(id);
    invariant(spec.consumer === this.consumer && this.#claim === null, 'READ_COORDINATION_CLAIM_MISMATCH');
    this.#claim = id;
    try { return super.reserveBatch(spec.weights); }
    finally { this.#claim = null; this.#selected = null; }
  }
  runIntentBatch(id, action) {
    const spec = readIntentSpec(id);
    invariant(spec.consumer === this.consumer && this.#claim === null, 'READ_COORDINATION_CLAIM_MISMATCH');
    this.#claim = id;
    // The inherited async method reserves synchronously before its first await.
    // It owns slot claim/retiming, response observation and complete draining.
    try { return super.runBatch(spec.weights, action); }
    finally { this.#claim = null; this.#selected = null; }
  }
  coordinationStatus() {
    return this.transaction(({ budget }) => {
      this.#assertOwner(budget.now());
      const owners = this.db.prepare('SELECT * FROM coordination_owners ORDER BY consumer').all();
      const phases = this.db.prepare('SELECT phase,COUNT(*) AS n FROM read_intents GROUP BY phase').all();
      const count = phase => phases.find(row => row.phase === phase)?.n ?? 0;
      return { schemaVersion: 2, productionActivated: false,
        intentReceipts: { queued: count(0), claimed: count(1), settled: count(2), canceled: count(3) },
        owners: owners.map(o => ({ consumer: o.consumer, active: o.active === 1, heartbeat: o.heartbeat, retiredIntents: o.retired })),
        allOwnersFresh: owners.length === 3 && owners.every(o => o.active === 1 && budget.now() - o.heartbeat <= OWNER_AGE_MS) };
    });
  }
  close() {
    invariant(this.localPending.size === 0, 'SHARED_BUDGET_DRAIN_REQUIRED');
    if (this.db && this.owner && !this.failed) {
      try { this.transaction(({ budget }) => {
        this.#assertOwner(budget.now());
        const removed = Number(this.db.prepare('DELETE FROM read_intents WHERE consumer=? AND epoch=?').run(this.consumer, this.epoch).changes);
        this.db.prepare('UPDATE coordination_owners SET active=0,retired=retired+? WHERE consumer=? AND epoch=?').run(removed, this.consumer, this.epoch);
      }); } catch (error) { this.halt(); super.close(); throw error; }
    }
    super.close();
  }
}
