import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invariant, hash } from './common.mjs';
import { SHARED_READ_BUDGET_MAXIMUM_WEIGHT } from './shared-read-budget.mjs';
import { BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE } from './request-budget.mjs';

// Fixed codes prevent remote status/error text, account data and credentials
// from becoming alert bodies. These are observations, never trading gates.
export const OPS_ALERTS = Object.freeze({
  READER_UNAVAILABLE: ['CRITICAL', 0], SCANNER_UNAVAILABLE: ['CRITICAL', 0], SHADOW_UNAVAILABLE: ['CRITICAL', 0],
  OBSERVE_BOUNDARY_VIOLATION: ['CRITICAL', 0], READER_DEGRADED: ['CRITICAL', 0], SCANNER_DEGRADED: ['WARNING', 60000],
  SHADOW_STOPPED_OR_FAILED: ['CRITICAL', 0], PRIVATE_STREAM_DISCONNECTED: ['CRITICAL', 0],
  MARKET_EVIDENCE_NOT_READY: ['WARNING', 60000], ENTRY_INCIDENT_REVIEW_REQUIRED: ['CRITICAL', 0],
  ACTIVITY_COVERAGE_UNVERIFIED: ['WARNING', 120000], RECONCILIATION_OR_CONTEXT_ERROR: ['CRITICAL', 0],
  REQUEST_BUDGET_UNAVAILABLE: ['CRITICAL', 0], REQUEST_COOLDOWN: ['CRITICAL', 0],
  RAW_CAPTURE_BLOCKED: ['CRITICAL', 0], RAW_CAPACITY_HIGH: ['WARNING', 0],
  AUDIT_CAPACITY_HIGH: ['CRITICAL', 0], STORAGE_MEASUREMENT_UNAVAILABLE: ['CRITICAL', 0], DISK_PRESSURE: ['CRITICAL', 0],
  MONITOR_PUBLISH_UNVERIFIED: ['WARNING', 120000], EXTERNAL_ALERT_DELIVERY_UNCONFIGURED: ['WARNING', 0],
  SCHEDULED_OFFSERVER_BACKUP_UNVERIFIED: ['WARNING', 0],
});
const GIB = 1024 ** 3, STATE_MAX = 65536;
const validTime = v => Number.isSafeInteger(v) && v >= 0;
const recent = (v, now, age) => { const at = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(at) && now - at >= -5000 && now - at <= age; };

// A fresh component status is diagnostic evidence, never proof that every
// process on the public IP is enrolled, and never permission to trade.
export function observedReadBudgetAvailable(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)
    || !validTime(budget.blockedUntil) || budget.persistenceFailed === true
    || (budget.budgetHalted !== undefined && budget.budgetHalted !== false)) return false;
  if (budget.sharedAdmissionComponent === true) {
    return budget.consumer === 'SHADOW_RESIDENT' && budget.residentAdmissionEnrolled === true
      && budget.allIpConsumersVerified === false && budget.stopping === false
      && budget.atomicBatchAdmissionSupported === true && budget.accountReaderConcurrencyReserved === false
      && budget.maximumWeightPerRollingMinute === SHARED_READ_BUDGET_MAXIMUM_WEIGHT && budget.maximumConcurrent === 8
      && budget.ipCeiling === BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE && budget.accountReaderWeightHeadroom === 160
      && ['requests', 'inFlight', 'throttles', 'recoveredRequests', 'observedIpUsed'].every(k => validTime(budget[k]))
      && budget.inFlight <= 8 && budget.workerOnlyAdmission !== true
      && (budget.persistenceFailed === undefined || budget.persistenceFailed === false);
  }
  // Retain the explicit legacy producer contract; absence of a shared marker
  // or of an error field alone must not make an unknown object look healthy.
  return budget.sharedAdmissionComponent === undefined && budget.workerOnlyAdmission === true
    && budget.legacyServicesEnrolled === false && budget.persistenceFailed === false
    && ['requests', 'inFlight', 'throttles', 'observedIpUsed'].every(k => validTime(budget[k]))
    && Number.isSafeInteger(budget.maximumConcurrent ?? 8) && (budget.maximumConcurrent ?? 8) > 0
    && (budget.maximumConcurrent ?? 8) <= 8 && budget.inFlight <= (budget.maximumConcurrent ?? 8)
    && budget.maximumWeightPerRollingMinute === 900 && budget.ipCeiling === BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE;
}

export function evaluateOps({ reader, scanner, shadow, disk, auditBytes }, now) {
  invariant(validTime(now), 'OPS_CLOCK_INVALID');
  const condition = Object.fromEntries(Object.keys(OPS_ALERTS).map(k => [k, null]));
  const r = reader && recent(reader.checkedAt, now, 150000), s = scanner && recent(scanner.sourceAsOf, now, 180000), h = shadow && recent(shadow.checkedAt, now, 45000);
  const rawCapacityVerified = !!(r && reader.retention?.rawManagement === 'SEGMENTED_WRITER_OBSERVER'
    && reader.retention.observerOnly === true && reader.retention.rawMaximumBytes === 40 * GIB
    && recent(reader.retention.checkedAt, now, 150000));
  const rawBytesVerified = !!(h && Number.isSafeInteger(shadow.raw?.bytes) && shadow.raw.bytes >= 0);
  condition.READER_UNAVAILABLE = !r; condition.SCANNER_UNAVAILABLE = !s; condition.SHADOW_UNAVAILABLE = !h;
  const sources = [[r, reader, 'PRODUCTION_READ_ONLY_SHADOW'], [s, scanner, 'SCAN_ONLY'], [h, shadow, 'OBSERVE']];
  const violation = sources.some(([fresh, value, mode]) => fresh && (value.mode !== mode || value.realOrdersAllowed !== false || value.newEntriesBlocked !== true));
  condition.OBSERVE_BOUNDARY_VIOLATION = violation ? true : r && s && h ? false : null;
  if (r) condition.READER_DEGRADED = !['READY_READ_ONLY_SHADOW', 'READ_ONLY_ATTENTION_REQUIRED'].includes(reader.status) || reader.userStream?.connected !== true;
  if (s) {
    condition.SCANNER_DEGRADED = scanner.status !== 'HEALTHY' || scanner.scannedSymbols !== 10;
    condition.MONITOR_PUBLISH_UNVERIFIED = scanner.publish?.status !== 'SYNCED' || !recent(scanner.publish?.at, now, 240000);
  }
  if (h) {
    condition.SHADOW_STOPPED_OR_FAILED = !['STARTING', 'OBSERVE_ONLY_NO_ORDER_CALLS', 'ENTRY_BLOCKED_INCIDENT'].includes(shadow.status) || !Number.isSafeInteger(shadow.lastCycleAt) || now - shadow.lastCycleAt > 45000 || now - shadow.lastCycleAt < -5000;
    condition.PRIVATE_STREAM_DISCONNECTED = shadow.accountStream?.connected !== true;
    condition.MARKET_EVIDENCE_NOT_READY = shadow.publicConnected !== true || shadow.currentTick !== 10 || shadow.currentBbo !== 10;
    condition.ENTRY_INCIDENT_REVIEW_REQUIRED = shadow.entryIncident !== null;
    condition.ACTIVITY_COVERAGE_UNVERIFIED = shadow.accountActivity?.recentWindowsReady !== true;
    condition.RECONCILIATION_OR_CONTEXT_ERROR = ['incomeError', 'contextError', 'accountTaskError', 'watchdogError', 'candidateError', 'calendarError', 'clockError'].some(k => shadow[k] !== null);
    const budget = shadow.requestBudget;
    condition.REQUEST_BUDGET_UNAVAILABLE = !observedReadBudgetAvailable(budget);
    condition.REQUEST_COOLDOWN = condition.REQUEST_BUDGET_UNAVAILABLE ? null : budget.blockedUntil > now;
    condition.RAW_CAPTURE_BLOCKED = shadow.raw?.captureReady !== true || !Number.isSafeInteger(shadow.raw?.bytes) || shadow.raw.bytes < 0;
    // Owner-authorized 40 GiB cap, same 90% warning ratio. Unknown or stale
    // capacity is a measurement fault, not a guessed threshold or a cleared alarm.
    condition.RAW_CAPACITY_HIGH = rawCapacityVerified && rawBytesVerified
      ? shadow.raw.bytes >= Math.floor(reader.retention.rawMaximumBytes * 0.9) : null;
  }
  const storageValid = disk && Number.isSafeInteger(disk.totalBytes) && disk.totalBytes > 0 && Number.isSafeInteger(disk.availableBytes) && disk.availableBytes >= 0 && disk.availableBytes <= disk.totalBytes;
  const auditValid = Number.isSafeInteger(auditBytes) && auditBytes >= 0;
  condition.STORAGE_MEASUREMENT_UNAVAILABLE = !(storageValid && auditValid && rawCapacityVerified && rawBytesVerified);
  if (storageValid) condition.DISK_PRESSURE = disk.availableBytes < 5 * GIB || disk.availableBytes / disk.totalBytes <= 0.15;
  if (auditValid) condition.AUDIT_CAPACITY_HIGH = auditBytes >= Math.floor(0.8 * GIB);
  condition.EXTERNAL_ALERT_DELIVERY_UNCONFIGURED = true;
  condition.SCHEDULED_OFFSERVER_BACKUP_UNVERIFIED = true;
  return condition;
}
export function emptyOpsState() { return { schema: 'S1_OPS_MONITOR_V1', checkedAt: 0, sequence: 0, stopped: false, liveReady: false, externalDeliveryVerified: false, alerts: {}, recent: [], evictedDiagnosticTransitions: 0 }; }
export function validateOpsState(state) {
  invariant(state && state.schema === 'S1_OPS_MONITOR_V1' && validTime(state.checkedAt) && validTime(state.sequence)
    && state.liveReady === false && state.externalDeliveryVerified === false && typeof state.stopped === 'boolean'
    && validTime(state.evictedDiagnosticTransitions) && Array.isArray(state.recent) && state.recent.length <= 128
    && state.alerts && typeof state.alerts === 'object' && !Array.isArray(state.alerts), 'OPS_STATE_INVALID');
  invariant(Object.keys(state).sort().join(',') === Object.keys(emptyOpsState()).sort().join(','), 'OPS_STATE_UNKNOWN_FIELDS');
  for (const [code, row] of Object.entries(state.alerts)) {
    invariant(Object.hasOwn(OPS_ALERTS, code) && row && typeof row.active === 'boolean' && (row.pending === null || typeof row.pending === 'boolean')
      && validTime(row.since) && validTime(row.evaluatedAt) && validTime(row.transitionAt) && validTime(row.revision)
      && Object.keys(row).sort().join(',') === 'active,evaluatedAt,pending,revision,since,transitionAt', 'OPS_ALERT_STATE_INVALID');
  }
  for (const event of state.recent) invariant(Object.keys(event).sort().join(',') === 'at,code,id,severity,state' && Object.hasOwn(OPS_ALERTS, event.code)
    && validTime(event.at) && /^[a-f0-9]{64}$/.test(event.id) && event.severity === OPS_ALERTS[event.code][0]
    && ['RAISED', 'OBSERVATION_RECOVERED_NOT_TRADING_RELEASE'].includes(event.state), 'OPS_TRANSITION_INVALID');
  invariant(Buffer.byteLength(JSON.stringify(state)) <= STATE_MAX, 'OPS_STATE_CAPACITY'); return state;
}
export function advanceOps(previous, condition, now) {
  validateOpsState(previous); invariant(validTime(now) && now >= previous.checkedAt, 'OPS_CLOCK_REGRESSION');
  invariant(Object.keys(condition).length === Object.keys(OPS_ALERTS).length && Object.keys(condition).every(k => Object.hasOwn(OPS_ALERTS, k) && [null, true, false].includes(condition[k])), 'OPS_CONDITIONS_INVALID');
  const state = structuredClone(previous); state.checkedAt = now; state.stopped = false; const transitions = [];
  for (const [code, value] of Object.entries(condition)) {
    const row = state.alerts[code] ?? { active: false, pending: null, since: now, evaluatedAt: now, transitionAt: 0, revision: 0 };
    if (value === null) { row.pending = null; row.since = now; }
    else {
      if (row.pending !== value || now - row.evaluatedAt > 30000) { row.pending = value; row.since = now; }
      if (value !== row.active && now - row.since >= (value ? OPS_ALERTS[code][1] : 30000)) {
        row.active = value; row.transitionAt = now; row.revision++;
        const event = { code, at: now, severity: OPS_ALERTS[code][0], state: value ? 'RAISED' : 'OBSERVATION_RECOVERED_NOT_TRADING_RELEASE' };
        event.id = hash({ ...event, revision: row.revision }); transitions.push(event);
      }
    }
    row.evaluatedAt = now; state.alerts[code] = row;
  }
  state.sequence += transitions.length; state.recent.push(...transitions);
  if (state.recent.length > 128) { state.evictedDiagnosticTransitions += state.recent.length - 128; state.recent = state.recent.slice(-128); }
  return { state: validateOpsState(state), transitions };
}
export async function readOpsInput(filename, maximumBytes = 1024 ** 2) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); invariant(info.isFile() && info.nlink === 1 && info.size <= maximumBytes && info.uid === process.getuid() && !(info.mode & 0o022), 'OPS_INPUT_BOUNDARY');
    const buffer = Buffer.alloc(maximumBytes + 1); let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    invariant(length <= maximumBytes, 'OPS_INPUT_TOO_LARGE'); return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}
export class OpsStore {
  constructor(root) { this.root = root; this.failed = false; }
  async open() {
    const info = await fs.lstat(this.root); invariant(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077), 'OPS_ROOT_BOUNDARY');
    for (const name of await fs.readdir(this.root)) {
      invariant(['lease.sqlite', 'lease.sqlite-journal', 'latest.json', 'latest.next'].includes(name), 'OPS_UNKNOWN_RUNTIME_FILE');
      const s = await fs.lstat(path.join(this.root, name)); invariant(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077) && s.size <= 1024 ** 2, 'OPS_RUNTIME_FILE_BOUNDARY');
    }
    const h = await fs.open(path.join(this.root, 'lease.sqlite'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await h.close();
    this.lease = new DatabaseSync(path.join(this.root, 'lease.sqlite'));
    try {
      this.lease.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      try { this.state = validateOpsState(await readOpsInput(path.join(this.root, 'latest.json'), STATE_MAX)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = emptyOpsState(); }
      return this;
    } catch (error) { this.close(); throw error; }
  }
  async save(state) {
    invariant(this.lease && !this.failed && !this.writing, 'OPS_STORE_UNAVAILABLE'); validateOpsState(state); this.writing = true;
    try {
      const target = path.join(this.root, 'latest.next'), h = await fs.open(target, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const s = await h.stat(); invariant(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077), 'OPS_OUTPUT_BOUNDARY');
        await h.truncate(0); await h.writeFile(JSON.stringify(state)); await h.sync();
      } finally { await h.close(); }
      await fs.rename(target, path.join(this.root, 'latest.json'));
      const directory = await fs.open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      this.state = structuredClone(state);
    } catch (error) { this.failed = true; throw error; } finally { this.writing = false; }
  }
  close() { this.lease?.close(); this.lease = null; }
}
