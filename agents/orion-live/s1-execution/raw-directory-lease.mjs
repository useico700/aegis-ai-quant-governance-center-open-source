import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invariant } from './common.mjs';

export const RAW_LEASE_FILES = new Set(['.ownership.sqlite', '.ownership.sqlite-journal']);
// The lock is in the shared RAW directory, not a caller-selected ledger root.
// Different execution journals therefore cannot acquire this writer together.
// Never unlink a lock based on a PID or mtime; the OS releases it after death.
export class RawDirectoryLease {
  constructor(root) { this.root = root; this.held = false; }
  async open() {
    invariant(!this.held && !this.db, 'RAW_LEASE_ALREADY_OPEN');
    const root = await fs.lstat(this.root);
    invariant(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o022) === 0, 'RAW_LEASE_ROOT_INVALID');
    for (const name of RAW_LEASE_FILES) {
      const stat = await fs.lstat(path.join(this.root, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      invariant(!stat || stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072 && (stat.mode & 0o077) === 0, 'RAW_LEASE_FILE_INVALID');
    }
    const filename = path.join(this.root, '.ownership.sqlite');
    const file = await fs.open(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); await file.close();
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.held = true; return this;
    } catch { this.close(); throw new Error('RAW_DIRECTORY_WRITER_ALREADY_HELD'); }
  }
  close() { this.held = false; if (this.db) { this.db.close(); this.db = null; } }
}
