import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, invariant } from './common.mjs';
import { SQLiteJournal } from './sqlite-journal.mjs';
import { PositionLedger } from './position-ledger.mjs';
import { ExecutionKernel } from './kernel.mjs';
import { AccountActivityLedger } from './account-activity.mjs';
import { ReadRequestBudget } from './request-budget.mjs';

const GIB = 1024 ** 3, FORBIDDEN = /apiKey|secret|signature|listenKey|authorization|cookie/i;
const SCHEMA = 'CREATE TABLE events (sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL)';
const DIGEST = /^[a-f0-9]{64}$/;
async function regular(filename, maximum = GIB) {
  const s = await fs.lstat(filename);
  invariant(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && s.size <= maximum && (s.mode & 0o077) === 0, 'BACKUP_FILE_BOUNDARY'); return s;
}
async function privateDirectory(filename) {
  const s = await fs.lstat(filename); invariant(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, 'BACKUP_DIRECTORY_BOUNDARY');
  return fs.realpath(filename);
}
async function syncFile(filename) { const h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); try { await h.sync(); } finally { await h.close(); } }
async function fileHash(filename) {
  const h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW), digest = crypto.createHash('sha256');
  try { for await (const chunk of h.createReadStream({ autoClose: false })) digest.update(chunk); return digest.digest('hex'); } finally { await h.close(); }
}
async function writeJsonExclusive(filename, value) {
  const h = await fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); }
}
function sourceSchema(db) {
  const rows = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  invariant(rows.some(r => r.type === 'table' && r.name === 'events') && rows.every(r => r.type === 'table' && ['events', 'read_budget'].includes(r.name)), 'BACKUP_UNKNOWN_DATABASE_SCHEMA');
  invariant(db.prepare('PRAGMA table_info(events)').all().map(r => `${r.name}:${r.type}`).join(',') === 'sequence:INTEGER,previous:TEXT,payload:TEXT,digest:TEXT', 'BACKUP_EVENT_SCHEMA_MISMATCH');
  return rows.some(r => r.name === 'read_budget');
}
function budgetState(db) {
  const rows = db.prepare('SELECT id,state FROM read_budget').all();
  invariant(rows.length <= 1 && rows.every(r => r.id === 1 && Buffer.byteLength(r.state) <= 4096 && !FORBIDDEN.test(r.state)), 'BACKUP_BUDGET_INVALID');
  if (!rows.length) return null;
  const state = JSON.parse(rows[0].state);
  const allowed = ['version', 'lastAt', 'blockedUntil', 'blocks', 'ipAt', 'ipUsed', 'ipWindow', 'requests', 'throttles'];
  invariant(state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).every(k => allowed.includes(k))
    && Array.isArray(state.blocks) && state.blocks.every(b => b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).every(k => ['at', 'weight'].includes(k))), 'BACKUP_UNKNOWN_BUDGET_FIELDS');
  new ReadRequestBudget({ load: () => state }); return rows[0].state;
}
function copyCommittedSnapshot(source, target, { maximumDatabaseBytes, deadline, now }) {
  source.exec('BEGIN'); let result;
  try {
    const hasBudget = sourceSchema(source);
    invariant(source.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'BACKUP_SOURCE_INTEGRITY');
    const pageSize = source.prepare('PRAGMA page_size').get().page_size;
    invariant(source.prepare('PRAGMA page_count').get().page_count * pageSize <= maximumDatabaseBytes, 'BACKUP_DATABASE_CAPACITY');
    target.exec(`PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; ${SCHEMA}`);
    const insert = target.prepare('INSERT INTO events VALUES (?,?,?,?)'); let sequence = 0, previous = '0'.repeat(64), payloadBytes = 0;
    for (const row of source.prepare('SELECT * FROM events ORDER BY sequence').iterate()) {
      invariant(now() <= deadline && sequence < 1000000, 'BACKUP_TIME_OR_EVENT_LIMIT');
      invariant(Buffer.byteLength(row.payload) <= 60000 && !FORBIDDEN.test(row.payload), 'BACKUP_EVENT_UNSAFE');
      const event = JSON.parse(row.payload); payloadBytes += Buffer.byteLength(row.payload) + 160;
      invariant(payloadBytes <= maximumDatabaseBytes, 'BACKUP_DATABASE_CAPACITY');
      invariant(row.sequence === sequence + 1 && row.previous === previous && row.digest === hash({ sequence: row.sequence, previous: row.previous, event }), 'BACKUP_HASH_CHAIN_INVALID');
      insert.run(row.sequence, row.previous, row.payload, row.digest); sequence = row.sequence; previous = row.digest;
    }
    const budget = hasBudget ? budgetState(source) : null;
    if (hasBudget) {
      target.exec('CREATE TABLE read_budget (id INTEGER PRIMARY KEY CHECK (id=1), state TEXT NOT NULL)');
      if (budget) target.prepare('INSERT INTO read_budget VALUES (1,?)').run(budget);
    }
    invariant(target.prepare('PRAGMA page_count').get().page_count * target.prepare('PRAGMA page_size').get().page_size <= maximumDatabaseBytes, 'BACKUP_DATABASE_CAPACITY');
    target.exec('COMMIT'); result = { sequence, head: previous, hasBudget, budgetDigest: budget === null ? null : hash(budget) };
  } finally { try { source.exec('ROLLBACK'); } catch { /* Read transaction may not exist. */ } }
  return result;
}
async function inventory(root) {
  let bytes = 0, generations = 0;
  for (const name of await fs.readdir(root)) {
    if (['backup-lock.sqlite', 'backup-lock.sqlite-journal'].includes(name)) { bytes += (await regular(path.join(root, name), 1024 ** 2)).size; continue; }
    invariant(/^snapshot-\d{13}-[a-f0-9]{16}$/.test(name), 'BACKUP_UNKNOWN_DIRECTORY_ENTRY'); generations++;
    const dir = path.join(root, name); await privateDirectory(dir);
    for (const child of await fs.readdir(dir)) {
      if (child === 'restore-drill') {
        const drill = path.join(dir, child); await privateDirectory(drill);
        for (const item of await fs.readdir(drill)) {
          invariant(['execution.sqlite', 'execution.sqlite-wal', 'execution.sqlite-shm', 'ownership.sqlite', 'ownership.sqlite-journal', 'result.json'].includes(item), 'BACKUP_UNKNOWN_DRILL_ENTRY');
          bytes += (await regular(path.join(drill, item), GIB + 16 * 1024 ** 2)).size;
        }
      } else {
        invariant(['checkpoint.sqlite', 'checkpoint.sqlite-journal', 'manifest.pending', 'manifest.json'].includes(child), 'BACKUP_UNKNOWN_SNAPSHOT_ENTRY');
        bytes += (await regular(path.join(dir, child), GIB + 16 * 1024 ** 2)).size;
      }
    }
  }
  return { bytes, generations };
}

// A failed/partial generation is retained and consumes a slot. This component
// does not prune any backup, source event, raw segment or financial evidence.
export async function createAuditBackup({ sourceRoot, backupRoot, maximumDatabaseBytes = GIB, maximumTotalBytes = 8 * GIB,
  statfs = fs.statfs, now = Date.now }) {
  invariant(Number.isSafeInteger(maximumDatabaseBytes) && maximumDatabaseBytes > 0 && maximumDatabaseBytes <= GIB
    && Number.isSafeInteger(maximumTotalBytes) && maximumTotalBytes > 0 && maximumTotalBytes <= 8 * GIB, 'BACKUP_LIMIT_INVALID');
  const sourcePath = await privateDirectory(sourceRoot);
  const root = await privateDirectory(backupRoot);
  invariant(root !== sourcePath && !root.startsWith(sourcePath + path.sep) && !sourcePath.startsWith(root + path.sep), 'BACKUP_SOURCE_DESTINATION_OVERLAP');
  const sourceFile = path.join(sourcePath, 'execution.sqlite'); await regular(sourceFile, GIB);
  const lockFile = path.join(root, 'backup-lock.sqlite');
  const lockHandle = await fs.open(lockFile, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await lockHandle.close(); await regular(lockFile, 1024 ** 2);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try { await regular(lockFile + suffix, 1024 ** 2); invariant(suffix === '-journal', 'BACKUP_LOCK_MODE_INVALID'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const lock = new DatabaseSync(lockFile); let source, target;
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const before = await inventory(root), space = await statfs(root);
    invariant(before.generations < 3 && before.bytes + 2 * maximumDatabaseBytes + 16 * 1024 ** 2 <= maximumTotalBytes, 'BACKUP_STORAGE_LIMIT');
    invariant(space.bavail * space.bsize >= 5 * GIB + 2 * maximumDatabaseBytes && space.bavail / space.blocks >= 0.15, 'BACKUP_INSUFFICIENT_FREE_SPACE');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await regular(sourceFile + suffix, GIB); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const createdAt = now(); invariant(Number.isSafeInteger(createdAt) && /^\d{13}$/.test(String(createdAt)), 'BACKUP_CLOCK_INVALID');
    const name = `snapshot-${createdAt}-${crypto.randomBytes(8).toString('hex')}`, directory = path.join(root, name);
    await fs.mkdir(directory, { mode: 0o700 }); await syncFile(root);
    const destination = path.join(directory, 'checkpoint.sqlite');
    const h = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await h.close();
    source = new DatabaseSync(sourceFile, { readOnly: true }); source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    target = new DatabaseSync(destination);
    const summary = copyCommittedSnapshot(source, target, { maximumDatabaseBytes, deadline: createdAt + 60000, now });
    target.close(); target = null; source.close(); source = null; await syncFile(destination);
    const manifest = { schema: 'S2_AUDIT_BACKUP_V1', createdAt, completedAt: now(), ...summary,
      bytes: (await regular(destination, maximumDatabaseBytes)).size, databaseSha256: await fileHash(destination),
      scope: 'COMMITTED_JOURNAL_AND_READ_BUDGET_ONLY', credentialsIncluded: false, rawEvidenceIncluded: false,
      automaticTradingRestoreAllowed: false, offServerCopyVerified: false };
    await writeJsonExclusive(path.join(directory, 'manifest.pending'), manifest);
    await fs.rename(path.join(directory, 'manifest.pending'), path.join(directory, 'manifest.json')); await syncFile(directory); await syncFile(root);
    return { directory, manifest, manifestSha256: await fileHash(path.join(directory, 'manifest.json')) };
  } finally { target?.close(); source?.close(); lock.close(); }
}

export async function verifyAuditBackup(directory, expectedManifestSha256) {
  invariant(DIGEST.test(expectedManifestSha256), 'BACKUP_TRUSTED_MANIFEST_DIGEST_REQUIRED');
  directory = await privateDirectory(directory); const manifestFile = path.join(directory, 'manifest.json');
  await regular(manifestFile, 8192); invariant(await fileHash(manifestFile) === expectedManifestSha256, 'BACKUP_MANIFEST_DIGEST_MISMATCH');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  invariant(manifest.schema === 'S2_AUDIT_BACKUP_V1' && manifest.scope === 'COMMITTED_JOURNAL_AND_READ_BUDGET_ONLY'
    && manifest.credentialsIncluded === false && manifest.rawEvidenceIncluded === false && manifest.automaticTradingRestoreAllowed === false
    && manifest.offServerCopyVerified === false && typeof manifest.hasBudget === 'boolean'
    && (manifest.budgetDigest === null || DIGEST.test(manifest.budgetDigest))
    && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= GIB
    && DIGEST.test(manifest.databaseSha256) && DIGEST.test(manifest.head) && Number.isSafeInteger(manifest.sequence) && manifest.sequence >= 0, 'BACKUP_MANIFEST_INVALID');
  const filename = path.join(directory, 'checkpoint.sqlite');
  invariant((await regular(filename)).size === manifest.bytes && await fileHash(filename) === manifest.databaseSha256, 'BACKUP_DATABASE_DIGEST_MISMATCH');
  return { directory, filename, manifest };
}
export async function drillAuditRestore({ directory, expectedManifestSha256, statfs = fs.statfs }) {
  const verified = await verifyAuditBackup(directory, expectedManifestSha256), space = await statfs(verified.directory);
  invariant(space.bavail * space.bsize >= 5 * GIB + verified.manifest.bytes && space.bavail / space.blocks >= 0.15, 'RESTORE_INSUFFICIENT_FREE_SPACE');
  const drill = path.join(verified.directory, 'restore-drill');
  await fs.mkdir(drill, { mode: 0o700 }); // Exclusive: never overwrite a prior drill or a runtime.
  await syncFile(verified.directory);
  await fs.copyFile(verified.filename, path.join(drill, 'execution.sqlite'), constants.COPYFILE_EXCL);
  await fs.chmod(path.join(drill, 'execution.sqlite'), 0o600); await syncFile(path.join(drill, 'execution.sqlite')); await syncFile(drill);
  const journal = await new SQLiteJournal(drill).open(); let result;
  try {
    invariant(journal.sequence === verified.manifest.sequence && journal.previous === verified.manifest.head, 'RESTORE_CHAIN_MISMATCH');
    const hasBudget = sourceSchema(journal.db), budget = hasBudget ? budgetState(journal.db) : null;
    invariant(hasBudget === verified.manifest.hasBudget && (budget === null ? null : hash(budget)) === verified.manifest.budgetDigest, 'RESTORE_BUDGET_MISMATCH');
    const book = new PositionLedger(journal), activity = new AccountActivityLedger(journal);
    const kernel = new ExecutionKernel({ journal, transport: { request: () => { throw new Error('RESTORE_NETWORK_FORBIDDEN'); } }, gates: () => { throw new Error('RESTORE_DISARMED'); } });
    result = { status: 'ISOLATED_RESTORE_VERIFIED_NOT_ACTIVATED', manifestSha256: expectedManifestSha256, sequence: journal.sequence, head: journal.previous,
      plans: kernel.plans.size, intents: kernel.intents.size, unresolvedIntents: [...kernel.intents.values()].filter(i => !i.result).length,
      positions: book.positions.size, fills: book.fills.size, externalExits: book.externalExits.size, controls: book.control.size,
      accountActivityFacts: activity.facts.size, accountActivityReports: activity.reports.size,
      entryHoldPresent: !!book.control.get('entryIncident'), readBudgetRestored: hasBudget,
      financialMutationsPerformed: false, sourceLedgerOverwritten: false, rawEvidenceRestored: false,
      executionResumeRequiresFreshReconciliation: true };
  } finally { await journal.close(); }
  await writeJsonExclusive(path.join(drill, 'result.json'), result); await syncFile(drill); return result;
}
