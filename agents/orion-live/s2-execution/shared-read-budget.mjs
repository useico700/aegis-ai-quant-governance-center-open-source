import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import { lstatSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE, ReadRequestBudget, READ_REQUEST_BUDGET_MAXIMUM_WEIGHT, readRequestWeight } from './request-budget.mjs';
import { ACCOUNT_BATCH_PATHS } from './transport.mjs';
import { invariant } from './common.mjs';

export const SHARED_READ_CONSUMERS = Object.freeze(['ACCOUNT_READER', 'CANDIDATE_SCANNER', 'SHADOW_RESIDENT']);
export const SHARED_READ_BUDGET_MAXIMUM_WEIGHT = READ_REQUEST_BUDGET_MAXIMUM_WEIGHT;
// Preserve one account-reader refresh (currently 97 weight including time
// checks) plus margin. This is a weight reservation, not reserved HTTP slots,
// a batch-atomicity guarantee or authority to exceed the shared/IP ceilings.
export const ACCOUNT_READER_WEIGHT_HEADROOM = 160;
// The fixed signed account batch may use the soft reader reserve to keep live
// reconciliation fresh. The 1200 local cap, IP ceiling and cooldown still apply.
// Do not stack a second static reserve on scanners: live load exceeded it.
const EXECUTION_ACCOUNT_INTENT = Symbol('EXECUTION_ACCOUNT_INTENT');
const EXECUTION_ACCOUNT_WEIGHTS = Object.freeze(ACCOUNT_BATCH_PATHS.map(
  pathname => readRequestWeight('GET', pathname)));
// Bounded synchronous lock acquisition, not an HTTP retry or quota increase.
// The previous 50 ms expired during ordinary process scheduling under the
// isolated server's 0.5-CPU quota. Keep this below the account freshness budget;
// long locks still reject admission, and unpersistable replies still halt.
export const SHARED_LOCK_WAIT_MS = 250;
// A writer normally holds the shared budget for only a few milliseconds, but
// the three resident processes can overlap while the host is CPU constrained.
// Retry only BEGIN IMMEDIATE: no callback has run and no HTTP request has been
// dispatched, so every retry is transactionally safe. Once a transaction has
// begun, any persistence error still latches the existing shared halt.
export const SHARED_BEGIN_LOCK_ATTEMPTS = 4;
const MAXIMUM_BYTES = 1024 ** 2, DRAIN_MS = 65000, HEX = /^[a-f0-9]{32}$/;
const STATE_KEYS = ['version', 'lastAt', 'blockedUntil', 'blocks', 'ipAt', 'ipUsed', 'ipWindow', 'requests', 'throttles'];
const validTime = at => Number.isSafeInteger(at) && at >= 0;
const REFUSAL_CODES = new Set(['READ_BUDGET_LOCAL_WEIGHT', 'READ_BUDGET_IP_HEADROOM',
  'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN', 'READ_BUDGET_CLOCK_OR_STORE_INVALID',
  'SHARED_BUDGET_CLOCK_REGRESSION', 'SHARED_BUDGET_HALT_REVIEW_REQUIRED', 'SHARED_BUDGET_UNAVAILABLE']);
const COORDINATION_SCHEMA = 'ALTER TABLE meta ADD COLUMN migration TEXT; CREATE TABLE coordination_owners (consumer TEXT PRIMARY KEY, epoch TEXT NOT NULL, heartbeat INTEGER NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), retired INTEGER NOT NULL); CREATE TABLE read_intents (id TEXT PRIMARY KEY, consumer TEXT NOT NULL, epoch TEXT NOT NULL, created_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, phase INTEGER NOT NULL CHECK(phase IN (0,1,2,3))); CREATE TABLE read_claims (token TEXT PRIMARY KEY, intent_id TEXT NOT NULL, consumer TEXT NOT NULL, epoch TEXT NOT NULL)';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function migrationReceipt(value, state, recovered) {
  if (value === null) return null; // Fresh explicit v2 bootstrap, not a migration.
  invariant(typeof value === 'string' && Buffer.byteLength(value) <= 2048, 'SHARED_MIGRATION_RECEIPT_INVALID');
  const r = JSON.parse(value);
  invariant(r && Object.keys(r).sort().join(',') === 'afterStateSha256,at,beforeStateSha256,blockedUntil,fromVersion,priorBlockedUntil,recovered,requests,schema,toVersion'
    && r.schema === 'S2_READ_BUDGET_MIGRATION_V1' && r.fromVersion === 1 && r.toVersion === 2
    && ['at', 'priorBlockedUntil', 'blockedUntil', 'recovered', 'requests'].every(k => validTime(r[k]))
    && /^[a-f0-9]{64}$/.test(r.beforeStateSha256) && /^[a-f0-9]{64}$/.test(r.afterStateSha256)
    && r.blockedUntil === Math.max(r.priorBlockedUntil, r.at + DRAIN_MS)
    && state.lastAt >= r.at && state.blockedUntil >= r.blockedUntil
    && state.requests >= r.requests && recovered >= r.recovered, 'SHARED_MIGRATION_RECEIPT_INVALID');
  return Object.freeze(r);
}
function regular(filename) {
  const s = lstatSync(filename);
  invariant(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077) && s.size <= MAXIMUM_BYTES, 'SHARED_BUDGET_FILE_BOUNDARY'); return s.size;
}
async function privateRoot(root) {
  const s = await fs.lstat(root); invariant(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077), 'SHARED_BUDGET_ROOT_BOUNDARY');
}
function sidecars(filename) {
  let bytes = regular(filename);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { bytes += regular(filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  invariant(bytes <= MAXIMUM_BYTES, 'SHARED_BUDGET_CAPACITY');
  return bytes;
}
function parseState(serialized) {
  invariant(typeof serialized === 'string' && Buffer.byteLength(serialized) <= 4096, 'SHARED_BUDGET_STATE_SIZE');
  const state = JSON.parse(serialized);
  invariant(state && Object.keys(state).sort().join(',') === [...STATE_KEYS].sort().join(','), 'SHARED_BUDGET_STATE_FIELDS');
  new ReadRequestBudget({ load: () => state, maximumWeight: SHARED_READ_BUDGET_MAXIMUM_WEIGHT });
  invariant(state.blocks.every(row => Object.keys(row).sort().join(',') === 'at,weight'), 'SHARED_BUDGET_BLOCK_FIELDS'); return state;
}
function configure(db) {
  db.exec(`PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=${SHARED_LOCK_WAIT_MS}; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=262144`);
}
// Explicit bootstrap only. Consumers never create/reset a missing shared store.
// Production migration must supply any longer already-observed cooldown and
// stop old unbudgeted consumers before this drain window can prove anything.
export async function initializeSharedReadBudget(root, { now = Date.now(), previousBlockedUntil = 0, schemaVersion = 1 } = {}) {
  invariant([1, 2].includes(schemaVersion), 'SHARED_BUDGET_SCHEMA_VERSION');
  invariant(validTime(now) && validTime(now + DRAIN_MS) && validTime(previousBlockedUntil), 'SHARED_BUDGET_BOOTSTRAP_TIME'); await privateRoot(root);
  invariant((await fs.readdir(root)).length === 0, 'SHARED_BUDGET_BOOTSTRAP_REQUIRES_EMPTY_ROOT');
  const filename = path.join(root, 'budget.sqlite'), h = await fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await h.close();
  const db = new DatabaseSync(filename);
  try {
    configure(db); db.exec('BEGIN IMMEDIATE; CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE pending (token TEXT PRIMARY KEY, consumer TEXT NOT NULL, epoch TEXT NOT NULL, weight INTEGER NOT NULL, at INTEGER NOT NULL); CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, recovered INTEGER NOT NULL)');
    const budget = new ReadRequestBudget({ now: () => now, maximumWeight: SHARED_READ_BUDGET_MAXIMUM_WEIGHT }); budget.state.blockedUntil = Math.max(now + DRAIN_MS, previousBlockedUntil);
    if (schemaVersion === 2) db.exec(COORDINATION_SCHEMA);
    db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(budget.state));
    db.prepare('INSERT INTO meta(id,version,recovered) VALUES(1,?,0)').run(schemaVersion); db.exec('COMMIT');
  } finally { db.close(); }
  const directory = await fs.open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

// Explicit OFFLINE preparation API; no CLI/production caller is provided.
// All three existing owner locks must be free. Never recover/delete old pending
// here: a crash must first be reconciled by the existing v1 recovery procedure.
export class StoppedReadBudgetMigration {
  constructor(root, { now = Date.now } = {}) {
    this.root = root; this.now = now; this.owners = []; this.db = null; this.phase = 'NEW';
  }
  #guard() {
    for (const name of ['halt', 'bootstrap.pending']) {
      try { lstatSync(path.join(this.root, name)); throw new Error('SHARED_MIGRATION_BLOCKED'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const bytes = sidecars(this.filename), s = lstatSync(this.filename);
    invariant(s.dev === this.identity.dev && s.ino === this.identity.ino, 'SHARED_MIGRATION_FILE_CHANGED');
    return bytes;
  }
  async open() {
    invariant(this.phase === 'NEW', 'SHARED_MIGRATION_LIFECYCLE');
    try {
      await privateRoot(this.root);
      this.filename = path.join(this.root, 'budget.sqlite'); sidecars(this.filename);
      const s = lstatSync(this.filename); this.identity = { dev: s.dev, ino: s.ino };
      this.#guard();
      for (const consumer of SHARED_READ_CONSUMERS) {
        const filename = path.join(this.root, `${consumer}.sqlite`);
        // Require existing files; absence is not permission to bootstrap them.
        sidecars(filename);
        for (const suffix of ['-wal', '-shm']) {
          try { lstatSync(filename + suffix); throw new Error('SHARED_MIGRATION_OWNER_MODE'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const owner = new DatabaseSync(filename); this.owners.push(owner);
        owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      }
      this.db = new DatabaseSync(this.filename); configure(this.db);
      invariant(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'SHARED_MIGRATION_INTEGRITY');
      this.phase = 'OPEN'; this.inspect(); return this;
    } catch (error) {
      this.close();
      throw new Error(/^SHARED_(MIGRATION|BUDGET)_[A-Z0-9_]{1,96}$/.test(error?.message ?? '') ? error.message : 'SHARED_MIGRATION_OPEN_FAILED');
    }
  }
  #snapshot() {
    invariant(this.db && this.owners.length === 3, 'SHARED_MIGRATION_LIFECYCLE'); this.#guard();
    const meta = this.db.prepare('SELECT * FROM meta').all();
    invariant(meta.length === 1 && meta[0].id === 1 && [1, 2].includes(meta[0].version) && validTime(meta[0].recovered), 'SHARED_MIGRATION_META');
    const m = meta[0], names = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name).sort();
    invariant(names.join(',') === (m.version === 1 ? 'meta,pending,state' : 'coordination_owners,meta,pending,read_claims,read_intents,state')
      && Object.keys(m).sort().join(',') === (m.version === 1 ? 'id,recovered,version' : 'id,migration,recovered,version'), 'SHARED_MIGRATION_SCHEMA');
    invariant(this.db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('trigger','view')").all().length === 0, 'SHARED_MIGRATION_SCHEMA');
    const rows = this.db.prepare('SELECT * FROM state').all();
    invariant(rows.length === 1 && rows[0].id === 1, 'SHARED_MIGRATION_STATE');
    const serialized = rows[0].value, state = parseState(serialized), at = this.now();
    invariant(validTime(at) && validTime(at + DRAIN_MS) && at >= state.lastAt && state.ipAt <= state.lastAt
      && state.blocks.every((b, i) => b.at >= 0 && b.at % 5000 === 0 && b.at <= state.lastAt
        && b.weight > 0 && b.weight <= SHARED_READ_BUDGET_MAXIMUM_WEIGHT && (i === 0 || b.at > state.blocks[i - 1].at)), 'SHARED_MIGRATION_STATE');
    const pending = this.db.prepare('SELECT * FROM pending').all();
    invariant(pending.length <= 8 && pending.every(r => HEX.test(r.token) && HEX.test(r.epoch)
      && SHARED_READ_CONSUMERS.includes(r.consumer) && Number.isSafeInteger(r.weight) && r.weight > 0
      && r.weight <= SHARED_READ_BUDGET_MAXIMUM_WEIGHT && validTime(r.at) && r.at <= at), 'SHARED_MIGRATION_PENDING_INVALID');
    const receipt = m.version === 2 ? migrationReceipt(m.migration, state, m.recovered) : null;
    return { m, state, serialized, at, pending, receipt };
  }
  inspect() {
    invariant(this.db, 'SHARED_MIGRATION_LIFECYCLE'); this.db.exec('BEGIN');
    try {
      const s = this.#snapshot();
      return Object.freeze({ version: s.m.version, pending: s.pending.length, recovered: s.m.recovered,
        requests: s.state.requests, blockedUntil: s.state.blockedUntil, stateSha256: digest(s.serialized), receipt: s.receipt });
    } finally { this.db.exec('ROLLBACK'); }
  }
  migrate() {
    invariant(this.phase === 'OPEN', 'SHARED_MIGRATION_LIFECYCLE');
    let commitAttempted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); const s = this.#snapshot();
      invariant(s.m.version === 1, 'SHARED_MIGRATION_SOURCE_VERSION');
      invariant(s.pending.length === 0, 'SHARED_MIGRATION_PENDING_REQUIRES_V1_RECOVERY');
      // Reserve bounded WAL/schema headroom without deleting any data. The
      // ordinary one-MiB limit remains in force before and after the commit.
      invariant(this.#guard() <= MAXIMUM_BYTES - 128 * 1024, 'SHARED_MIGRATION_CAPACITY_HEADROOM');
      const after = { ...s.state, lastAt: s.at, blockedUntil: Math.max(s.state.blockedUntil, s.at + DRAIN_MS) };
      const serialized = JSON.stringify(after); parseState(serialized);
      const receipt = { schema: 'S2_READ_BUDGET_MIGRATION_V1', fromVersion: 1, toVersion: 2, at: s.at,
        priorBlockedUntil: s.state.blockedUntil, blockedUntil: after.blockedUntil, requests: s.state.requests,
        recovered: s.m.recovered, beforeStateSha256: digest(s.serialized), afterStateSha256: digest(serialized) };
      migrationReceipt(JSON.stringify(receipt), after, s.m.recovered);
      this.db.exec(COORDINATION_SCHEMA);
      this.db.prepare('UPDATE state SET value=? WHERE id=1').run(serialized);
      this.db.prepare('UPDATE meta SET version=2,migration=? WHERE id=1').run(JSON.stringify(receipt));
      this.#snapshot();
      commitAttempted = true; this.db.exec('COMMIT'); this.#guard();
      this.phase = 'COMMITTED'; return Object.freeze(receipt);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* COMMIT may have succeeded; inspect after reopening, never reset. */ }
      this.phase = commitAttempted ? 'UNKNOWN' : 'FAILED';
      throw new Error(commitAttempted ? 'SHARED_MIGRATION_COMMIT_UNCERTAIN'
        : /^SHARED_(MIGRATION|BUDGET)_[A-Z0-9_]{1,96}$/.test(error?.message ?? '') ? error.message : 'SHARED_MIGRATION_FAILED');
    }
  }
  close() {
    try { this.db?.close(); }
    finally { this.db = null; for (const owner of this.owners.reverse()) owner.close(); this.owners = []; this.phase = 'CLOSED'; }
  }
}

// This is admission for a fixed three-consumer topology, NOT proof that all
// processes sharing a public IP are enrolled. It cannot authorize any request.
export class SharedReadBudget {
  get schemaVersion() { return 1; }
  validateAdditionalState() {}
  ownerAcquired() {}
  beforeReservation() {}
  afterReservation() {}
  beforeFinish() {}
  constructor(root, consumer, { now = Date.now } = {}) {
    invariant(SHARED_READ_CONSUMERS.includes(consumer), 'SHARED_BUDGET_CONSUMER_INVALID');
    Object.assign(this, { root, consumer, now, epoch: crypto.randomBytes(16).toString('hex'), localPending: new Set(), failed: false });
    this.admissionRefusals = 0; this.recentAdmissionRefusals = [];
  }
  async open() {
    invariant(!this.db && !this.owner, 'SHARED_BUDGET_ALREADY_OPEN'); await privateRoot(this.root);
    this.filename = path.join(this.root, 'budget.sqlite'); sidecars(this.filename);
    const ownerFile = path.join(this.root, `${this.consumer}.sqlite`);
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { regular(ownerFile + suffix); invariant(!['-wal', '-shm'].includes(suffix), 'SHARED_OWNER_MODE_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const h = await fs.open(ownerFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await h.close(); regular(ownerFile);
    try {
      this.owner = new DatabaseSync(ownerFile); this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(this.filename); configure(this.db);
      invariant(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'SHARED_BUDGET_INTEGRITY');
      const names = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name).sort();
      invariant(names.join(',') === (this.schemaVersion === 2 ? 'coordination_owners,meta,pending,read_claims,read_intents,state' : 'meta,pending,state'), 'SHARED_BUDGET_SCHEMA');
      this.transaction(({ budget, rows }) => {
        const abandoned = rows.filter(r => r.consumer === this.consumer);
        if (abandoned.length) {
          // Acquiring this consumer's OS lock proves its previous owner is gone.
          // Weight is never refunded; add a full conservative drain window.
          budget.state.blockedUntil = Math.max(budget.state.blockedUntil, this.now() + DRAIN_MS);
          this.db.prepare('DELETE FROM pending WHERE consumer=?').run(this.consumer);
          this.db.prepare('UPDATE meta SET recovered=recovered+? WHERE id=1').run(abandoned.length);
        }
        this.ownerAcquired({ at: budget.now() });
      });
      return this;
    } catch (error) { this.db?.close(); this.db = null; this.owner?.close(); this.owner = null; throw error; }
  }
  transaction(action) {
    invariant(this.db && this.owner && !this.failed, 'SHARED_BUDGET_UNAVAILABLE'); sidecars(this.filename);
    try { lstatSync(path.join(this.root, 'bootstrap.pending')); throw new Error('SHARED_BUDGET_BOOTSTRAP_INCOMPLETE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { lstatSync(path.join(this.root, 'halt')); throw new Error('SHARED_BUDGET_HALT_REVIEW_REQUIRED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let began = false;
    try {
      for (let attempt = 1; attempt <= SHARED_BEGIN_LOCK_ATTEMPTS; attempt++) {
        try { this.db.exec('BEGIN IMMEDIATE'); began = true; break; }
        catch (error) {
          const busy = error?.code === 'ERR_SQLITE_ERROR' && /(?:database is locked|database table is locked)/i.test(error?.message ?? '');
          if (!busy || attempt === SHARED_BEGIN_LOCK_ATTEMPTS) throw error;
        }
      }
      invariant(began, 'SHARED_BUDGET_UNAVAILABLE');
      const at = this.now(), state = parseState(this.db.prepare('SELECT value FROM state WHERE id=1').get()?.value);
      invariant(validTime(at) && at >= state.lastAt, 'SHARED_BUDGET_CLOCK_REGRESSION');
      const meta = this.db.prepare('SELECT * FROM meta').all();
      invariant(meta.length === 1 && meta[0].id === 1 && meta[0].version === this.schemaVersion && validTime(meta[0].recovered), 'SHARED_BUDGET_META_INVALID');
      if (this.schemaVersion === 2) migrationReceipt(meta[0].migration, state, meta[0].recovered);
      const rows = this.db.prepare('SELECT * FROM pending').all();
      invariant(rows.length <= 8 && rows.every(r => HEX.test(r.token) && HEX.test(r.epoch) && SHARED_READ_CONSUMERS.includes(r.consumer)
        && Number.isSafeInteger(r.weight) && r.weight > 0 && r.weight <= SHARED_READ_BUDGET_MAXIMUM_WEIGHT && validTime(r.at) && r.at <= at), 'SHARED_BUDGET_PENDING_INVALID');
      const budget = new ReadRequestBudget({ now: () => at, load: () => state, maximumWeight: SHARED_READ_BUDGET_MAXIMUM_WEIGHT });
      budget.inFlight = rows.length; budget.pendingWeight = rows.reduce((sum, row) => sum + row.weight, 0);
      this.validateAdditionalState({ budget, rows });
      const result = action({ budget, rows, recovered: meta[0].recovered }); budget.state.lastAt = at;
      if (this.schemaVersion === 2) this.validateAdditionalState({ budget, rows: this.db.prepare('SELECT * FROM pending').all() });
      const serialized = JSON.stringify(budget.state); parseState(serialized);
      this.db.prepare('UPDATE state SET value=? WHERE id=1').run(serialized);
      this.db.exec('COMMIT'); return result;
    } catch (error) {
      if (began) try { this.db.exec('ROLLBACK'); } catch { this.failed = true; }
      throw error;
    }
  }
  reserve(weight) {
    return this.reserveBatch([weight])[0];
  }
  reserveBatch(weights, intent = null) {
    invariant(Array.isArray(weights) && weights.length > 0 && weights.length <= 8
      && Array.from(weights).every(w => Number.isSafeInteger(w) && w > 0 && w <= SHARED_READ_BUDGET_MAXIMUM_WEIGHT), 'READ_BUDGET_WEIGHT_INVALID');
    invariant(intent === null || (intent === EXECUTION_ACCOUNT_INTENT && this.schemaVersion === 1
      && this.consumer === 'SHADOW_RESIDENT' && weights.length === EXECUTION_ACCOUNT_WEIGHTS.length
      && weights.every((weight, i) => weight === EXECUTION_ACCOUNT_WEIGHTS[i])), 'SHARED_PRIORITY_SCOPE');
    const readerHeadroom = this.consumer === 'ACCOUNT_READER' || intent === EXECUTION_ACCOUNT_INTENT
      ? 0 : ACCOUNT_READER_WEIGHT_HEADROOM;
    const tokens = weights.map(() => crypto.randomBytes(16).toString('hex'));
    let pressure = null, stage = 'BEFORE_TRANSACTION';
    try { this.transaction(({ budget, rows }) => {
      // Capture the validated pre-batch state inside the same locked transaction.
      // The attempted reservations below may mutate their in-memory copy before
      // rollback. Never report that partial attempt as previously spent weight.
      try {
        const at = budget.now();
        const rollingWeight = budget.state.blocks.filter(row => at - row.at < 65000).reduce((sum, row) => sum + row.weight, 0);
        if (Number.isSafeInteger(rollingWeight) && rollingWeight <= SHARED_READ_BUDGET_MAXIMUM_WEIGHT) pressure = Object.freeze({ capturedAt: at,
          rollingWeight, effectiveIpUsed: at - budget.state.ipAt >= 60000 ? 0 : budget.state.ipUsed,
          inFlight: rows.length, blockedUntil: budget.state.blockedUntil,
          readerHeadroom });
      } catch { /* Unavailable diagnostics cannot change admission semantics. */ }
      stage = 'BASE_ADMISSION';
      this.beforeReservation({ budget, rows, weights });
      for (const weight of weights) budget.reserve(weight);
      stage = 'ACCOUNT_READER_RESERVE';
      if (readerHeadroom > 0) {
        // Check after the ordinary admission checks, under the SAME SQLite
        // write transaction. A refusal rolls back both weight and counters
        // before dispatch; completed/uncertain HTTP requests are never refunded.
        // Reuse scheduling-pressure codes understood by the history monitor.
        const spent = budget.state.blocks.reduce((sum, row) => sum + row.weight, 0);
        invariant(spent + readerHeadroom <= budget.maximumWeight, 'READ_BUDGET_LOCAL_WEIGHT');
        invariant(budget.state.ipUsed + readerHeadroom <= budget.ipCeiling, 'READ_BUDGET_IP_HEADROOM');
      }
      stage = 'PERSIST_PENDING';
      weights.forEach((weight, i) => this.db.prepare('INSERT INTO pending VALUES(?,?,?,?,?)')
        .run(tokens[i], this.consumer, this.epoch, weight, budget.state.lastAt));
      this.afterReservation({ budget, tokens, weights });
    }); } catch (error) {
      // Fixed-size process-local diagnostics only. Do not write a failed
      // transaction, replace its exception, retry, refund or release anything.
      try {
        this.admissionRefusals = Math.min(Number.MAX_SAFE_INTEGER, this.admissionRefusals + 1);
        const at = this.now();
        this.recentAdmissionRefusals.push(Object.freeze({ sequence: this.admissionRefusals,
          at: validTime(at) ? at : null, consumer: this.consumer, stage,
          code: REFUSAL_CODES.has(error?.message) ? error.message : 'ADMISSION_UNVERIFIED',
          requestedRequests: weights.length, requestedWeight: weights.reduce((sum, weight) => sum + weight, 0), pressure }));
        this.recentAdmissionRefusals = this.recentAdmissionRefusals.slice(-8);
      } catch { /* Diagnostic failure cannot change admission failure semantics. */ }
      throw error;
    }
    for (const token of tokens) this.localPending.add(token);
    return tokens;
  }
  observe(token, response) {
    invariant(this.localPending.has(token), 'SHARED_BUDGET_UNKNOWN_LOCAL_REQUEST');
    try {
      this.transaction(({ budget, rows }) => {
        invariant(rows.some(r => r.token === token && r.consumer === this.consumer && r.epoch === this.epoch), 'SHARED_BUDGET_REQUEST_OWNERSHIP');
        // Cooldown is persisted before parsing optional weight headers. A bad
        // header cannot cause a known 418/429 to be forgotten on rollback.
        budget.observe({ status: response.status, retryAfter: response.retryAfter });
      });
      if (response.usedWeight !== null && response.usedWeight !== undefined) {
        this.transaction(({ budget }) => budget.observe({ status: 200, usedWeight: response.usedWeight, serverDate: response.serverDate }));
      }
    } catch (error) { this.halt(); throw error; }
  }
  finish(token) {
    invariant(this.localPending.has(token), 'SHARED_BUDGET_UNKNOWN_LOCAL_REQUEST');
    try {
      this.transaction(({ rows }) => {
        invariant(rows.some(r => r.token === token && r.consumer === this.consumer && r.epoch === this.epoch), 'SHARED_BUDGET_REQUEST_OWNERSHIP');
        this.beforeFinish({ token, rows });
        this.db.prepare('DELETE FROM pending WHERE token=?').run(token);
      });
    } catch (error) { this.halt(); throw error; }
    finally { this.localPending.delete(token); }
  }
  async run(weight, action) {
    const token = this.reserve(weight);
    try { return await action(response => this.observe(token, response)); }
    finally { this.finish(token); }
  }
  async runBatch(weights, action) {
    return this.#runBatch(weights, action, null);
  }
  async runExecutionAccountBatch(weights, action) {
    return this.#runBatch(weights, action, EXECUTION_ACCOUNT_INTENT);
  }
  async #runBatch(weights, action, intent) {
    invariant(typeof action === 'function', 'SHARED_BATCH_ACTION_REQUIRED');
    invariant(Array.isArray(weights), 'READ_BUDGET_WEIGHT_INVALID');
    weights = Object.freeze(Array.from(weights));
    const tokens = this.reserveBatch(weights, intent), claimed = new Set(), tasks = [];
    let closed = false;
    const slots = tokens.map((token, i) => Object.freeze({ run: (weight, callback) => {
      invariant(!closed && !claimed.has(i) && weight === weights[i] && typeof callback === 'function', 'SHARED_BATCH_SLOT_INVALID');
      // Bound reservation age by elapsed time, not the next bucket boundary:
      // admission at xx:04.999 must not expire after only one millisecond.
      // Before dispatch, move only this unsent slot's EXISTING charge forward
      // under the same transaction. Its rolling retention can only lengthen;
      // no weight/counter/IP credit is refunded or additional slot admitted.
      // Keep the original pending timestamp and five-second lifetime, and
      // reject any cooldown/halt learned from an earlier slot's response.
      this.transaction(({ budget, rows }) => {
        const row = rows.find(r => r.token === token && r.consumer === this.consumer && r.epoch === this.epoch);
        invariant(row && budget.now() - row.at < 5000, 'READ_BUDGET_BATCH_EXPIRED');
        invariant(budget.now() >= budget.state.blockedUntil, 'READ_BUDGET_COOLING_DOWN');
        invariant(budget.state.ipUsed <= budget.ipCeiling, 'READ_BUDGET_IP_HEADROOM');
        const sourceAt = Math.floor(row.at / 5000) * 5000, targetAt = Math.floor(budget.now() / 5000) * 5000;
        if (sourceAt !== targetAt) {
          const source = budget.state.blocks.find(block => block.at === sourceAt);
          invariant(source && source.weight >= weight && targetAt > sourceAt, 'READ_BUDGET_BATCH_CHARGE_INVALID');
          let target = budget.state.blocks.find(block => block.at === targetAt);
          if (!target) { target = { at: targetAt, weight: 0 }; budget.state.blocks.push(target); }
          source.weight -= weight; target.weight += weight;
          budget.state.blocks = budget.state.blocks.filter(block => block.weight > 0).sort((a, b) => a.at - b.at);
        }
      });
      claimed.add(i);
      const task = (async () => {
        try { return await callback(response => this.observe(token, response)); }
        finally { this.finish(token); }
      })();
      tasks.push(task);
      task.catch(() => {}); // The batch owns/drains even an unawaited child.
      return task;
    } }));
    try { return await action(Object.freeze(slots)); }
    finally {
      closed = true;
      await Promise.allSettled(tasks);
      // Admitted-but-unused slots are conservatively charged, never refunded.
      for (let i = 0; i < tokens.length; i++) if (!claimed.has(i)) this.finish(tokens[i]);
    }
  }
  canStartLowPriorityRead(weight = 45, headroom = 160) {
    return this.lowPriorityReadDecision(weight, headroom).allowed;
  }
  lowPriorityReadDecision(weight = 45, headroom = 160) {
    try { return this.transaction(({ budget }) => budget.lowPriorityReadDecision(weight, headroom)); }
    catch (error) {
      // Never surface SQLite messages, paths or arbitrary exception contents.
      // Unclassified failures remain unavailable, not falsely labeled capacity.
      const reason = error?.message === 'SHARED_BUDGET_CLOCK_REGRESSION' ? 'CLOCK_INVALID'
        : error?.message === 'SHARED_BUDGET_HALT_REVIEW_REQUIRED' ? 'HALT_REVIEW'
          : error?.message === 'READ_BUDGET_PRIORITY_INPUT_INVALID' ? 'INPUT_INVALID' : 'STORE_UNAVAILABLE';
      return Object.freeze({ allowed: false, reason });
    }
  }
  retainCooldown(until) {
    invariant(validTime(until), 'SHARED_BUDGET_COOLDOWN_INVALID');
    this.transaction(({ budget }) => { budget.state.blockedUntil = Math.max(budget.state.blockedUntil, until); });
  }
  status() {
    return this.transaction(({ budget, rows, recovered }) => ({ sharedAdmissionComponent: true, allIpConsumersVerified: false,
      maximumWeightPerRollingMinute: SHARED_READ_BUDGET_MAXIMUM_WEIGHT, maximumConcurrent: 8,
      ipCeiling: BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE,
      accountReaderWeightHeadroom: ACCOUNT_READER_WEIGHT_HEADROOM, accountReaderConcurrencyReserved: false,
      executionAccountPrioritySupported: true,
      atomicBatchAdmissionSupported: true,
      admissionDiagnostics: { processLocal: true, maximumRecentRefusals: 8, refusals: this.admissionRefusals,
        recentRefusals: this.recentAdmissionRefusals.map(row => ({ ...row, pressure: row.pressure ? { ...row.pressure } : null })) },
      requests: budget.state.requests, inFlight: rows.length, blockedUntil: budget.state.blockedUntil,
      throttles: budget.state.throttles, recoveredRequests: recovered, observedIpUsed: budget.state.ipUsed }));
  }
  close() {
    invariant(this.localPending.size === 0, 'SHARED_BUDGET_DRAIN_REQUIRED');
    this.db?.close(); this.db = null; this.owner?.close(); this.owner = null;
  }
  halt() {
    this.failed = true;
    // A known response that cannot be persisted must stop other consumers too.
    // The marker has no payload and is never automatically removed. If the
    // filesystem itself cannot persist it, this process remains halted; full
    // storage-failure fencing still needs host-level integration acceptance.
    let file, directory;
    try {
      file = openSync(path.join(this.root, 'halt'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      fsyncSync(file); directory = openSync(this.root, constants.O_RDONLY); fsyncSync(directory);
    } catch { /* Existing marker remains a hard stop; no reset on restart. */ }
    finally { if (file !== undefined) closeSync(file); if (directory !== undefined) closeSync(directory); }
  }
}
