import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash, invariant } from './common.mjs';
import { journalEventMaximumBytes, journalGrowthReservationBytes, S2_Z_PLAN_RESERVED_MAX_BYTES } from './journal-limits.mjs';

// The separate ownership database holds an OS-backed SQLite exclusive lock
// across all ledger commits. A crash releases it without deleting a guessed
// stale PID file. Both databases must live on a local filesystem, never NFS.
export class SQLiteJournal {
  constructor(root, { maximumBytes = 1024 ** 3 } = {}) {
    this.root = root; this.maximumBytes = maximumBytes;
    this.sequence = 0; this.previous = '0'.repeat(64); this.failed = false;
  }
  async regularFile(name) {
    const filename = path.join(this.root, name);
    const handle = await fs.open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { invariant((await handle.stat()).isFile(), 'JOURNAL_NOT_REGULAR'); } finally { await handle.close(); }
    return filename;
  }
  async open() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0, 'JOURNAL_ROOT_INVALID');
    try {
      this.owner = new DatabaseSync(await this.regularFile('ownership.sqlite'));
      this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.filename = await this.regularFile('execution.sqlite');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const entry = await fs.lstat(this.filename + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        invariant(!entry || (entry.isFile() && !entry.isSymbolicLink()), 'JOURNAL_SIDECAR_INVALID');
      }
      this.db = new DatabaseSync(this.filename);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
        PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, previous TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL);`);
      invariant(this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'JOURNAL_INTEGRITY_FAILURE');
      for (const row of this.db.prepare('SELECT * FROM events ORDER BY sequence').iterate()) {
        const payloadBytes = Buffer.byteLength(row.payload);
        invariant(payloadBytes <= S2_Z_PLAN_RESERVED_MAX_BYTES, 'JOURNAL_EVENT_TOO_LARGE');
        const event = JSON.parse(row.payload);
        invariant(payloadBytes <= journalEventMaximumBytes(event), 'JOURNAL_EVENT_TOO_LARGE');
        const record = { sequence: row.sequence, previous: row.previous, event };
        invariant(row.sequence === this.sequence + 1 && row.previous === this.previous && row.digest === hash(record), 'JOURNAL_INTEGRITY_FAILURE');
        this.sequence = row.sequence; this.previous = row.digest;
      }
      const directory = await fs.open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  get events() {
    invariant(this.db && !this.failed, 'JOURNAL_UNAVAILABLE');
    const database = this.db;
    return { *[Symbol.iterator]() { for (const row of database.prepare('SELECT payload FROM events ORDER BY sequence').iterate()) yield JSON.parse(row.payload); } };
  }
  async size() {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) total += (await fs.stat(this.filename + suffix).catch(error => { if (error.code !== 'ENOENT') throw error; return { size: 0 }; })).size;
    return total;
  }
  async append(event) {
    invariant(this.db && !this.failed, 'JOURNAL_UNAVAILABLE');
    invariant(!this.writing, 'JOURNAL_CONCURRENT_WRITE');
    const payload = JSON.stringify(event);
    invariant(!/apiKey|secret|signature|listenKey|authorization|cookie/i.test(payload), 'JOURNAL_SECRET_FIELD_FORBIDDEN');
    const payloadBytes = Buffer.byteLength(payload);
    invariant(payloadBytes <= journalEventMaximumBytes(event), 'JOURNAL_EVENT_TOO_LARGE');
    this.writing = true;
    try {
      // Never prune order/fill audit to make space. Runtime warns and stops new
      // entries well before this last-resort cap. Protection stays at the venue.
      invariant(await this.size() + journalGrowthReservationBytes(payloadBytes) < this.maximumBytes, 'JOURNAL_CAPACITY_EXHAUSTED');
      const record = { sequence: this.sequence + 1, previous: this.previous, event }, digest = hash(record);
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)').run(record.sequence, record.previous, payload, digest);
      this.db.exec('COMMIT'); // WAL + FULL synchronizes before network mutations.
      this.sequence = record.sequence; this.previous = digest;
      return this.sequence;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* No transaction may be open. */ }
      this.failed = true; throw error;
    } finally { this.writing = false; }
  }
  async close() {
    if (this.db) { this.db.close(); this.db = null; }
    if (this.owner) { this.owner.close(); this.owner = null; }
  }
}
