import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { hash, invariant } from './common.mjs';

// Evidence is never evicted by raw Tick/BBO retention. A stale lock requires
// operator review; guessing that an earlier writer is dead is unsafe in Docker.
export class Journal {
  constructor(root) { this.root = root; this.sequence = 0; this.previous = '0'.repeat(64); this.events = []; }
  async open() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(this.root);
    invariant(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'JOURNAL_ROOT_INVALID');
    this.lock = path.join(this.root, 'writer.lock');
    await fs.mkdir(this.lock, { mode: 0o700 });
    try {
      this.file = path.join(this.root, 'execution.ndjson');
      // O_NOFOLLOW prevents replacing the ledger by a credential symlink.
      this.handle = await fs.open(this.file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      const stat = await this.handle.stat();
      invariant(stat.isFile(), 'JOURNAL_NOT_REGULAR');
      if (stat.size) {
        const last = Buffer.alloc(1);
        await this.handle.read(last, 0, 1, stat.size - 1);
        invariant(last[0] === 10, 'JOURNAL_TORN_TAIL_REQUIRES_REVIEW');
        const lines = readline.createInterface({ input: createReadStream(this.file), crlfDelay: Infinity });
        for await (const line of lines) {
          invariant(Buffer.byteLength(line) <= 65536, 'JOURNAL_EVENT_TOO_LARGE');
          const { digest, ...record } = JSON.parse(line);
          invariant(record.sequence === this.sequence + 1 && record.previous === this.previous && digest === hash(record), 'JOURNAL_INTEGRITY_FAILURE');
          this.sequence = record.sequence; this.previous = digest; this.events.push(record.event);
        }
      }
      const directory = await fs.open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async append(event) {
    invariant(this.handle && !this.failed, 'JOURNAL_UNAVAILABLE');
    invariant(!this.writing, 'JOURNAL_CONCURRENT_WRITE');
    // Prevent accidental secret/request logging; event schema is deliberately compact.
    const payload = JSON.stringify(event);
    invariant(!/apiKey|secret|signature|listenKey|authorization|cookie/i.test(payload), 'JOURNAL_SECRET_FIELD_FORBIDDEN');
    invariant(Buffer.byteLength(payload) <= 60000, 'JOURNAL_EVENT_TOO_LARGE');
    this.writing = true;
    try {
      const record = { sequence: this.sequence + 1, previous: this.previous, event };
      const digest = hash(record);
      await this.handle.writeFile(`${JSON.stringify({ ...record, digest })}\n`);
      await this.handle.sync(); // The network mutation may start only after this succeeds.
      this.sequence = record.sequence; this.previous = digest; this.events.push(event);
      return record.sequence;
    } catch (error) { this.failed = true; throw error; }
    finally { this.writing = false; }
  }
  async close() {
    if (this.handle) { await this.handle.close(); this.handle = null; }
    if (this.lock) { await fs.rmdir(this.lock); this.lock = null; }
  }
}
