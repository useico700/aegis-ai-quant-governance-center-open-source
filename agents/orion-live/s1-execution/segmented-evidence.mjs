import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hash, invariant } from './common.mjs';
import { RawDirectoryLease, RAW_LEASE_FILES } from './raw-directory-lease.mjs';

// One shared S1 raw directory. An independently held single-writer lease is
// required. Rotate by size/time, not per tick/flush, to avoid inode and stat I/O
// explosions. Torn old segments are preserved as recovered evidence with a gap;
// no truncation or claim of continuous history is made.
export class SegmentedEvidenceStore {
  constructor(root, { assertWriter, maximumBytes = 40 * 1024 ** 3, segmentBytes = 64 * 1024 ** 2,
    maximumAgeMs = 7 * 86400000, segmentAgeMs = 15 * 60000, maximumSegments = 4096,
    minimumFreeBytes = 5 * 1024 ** 3, maximumBatchBytes = 4 * 1024 ** 2,
    diskEvictionUsedFraction = 0.78, diskTargetUsedFraction = 0.72, diskBlockUsedFraction = 0.85,
    statfs = fs.statfs, now = Date.now, onRecovery = async () => {} } = {}) {
    Object.assign(this, { root, assertWriter, maximumBytes, segmentBytes, maximumAgeMs, segmentAgeMs, maximumSegments, minimumFreeBytes, maximumBatchBytes,
      diskEvictionUsedFraction, diskTargetUsedFraction, diskBlockUsedFraction, statfs, now, onRecovery });
    this.files = []; this.bytes = 0; this.current = null; this.busy = false; this.lastDiskCheck = -Infinity; this.lastPrune = -Infinity;
    this.tail = Promise.resolve(); this.queued = 0;
  }
  async syncDirectory() { const d = await fs.open(this.root, 'r'); try { await d.sync(); } finally { await d.close(); } }
  async open() {
    invariant(!this.opened && !this.writerLease?.held && !this.closing && !this.failed, 'RAW_STORE_ALREADY_USED');
    invariant(typeof this.assertWriter === 'function' && this.assertWriter(), 'RAW_WRITER_LEASE_REQUIRED');
    invariant(this.segmentBytes > 0 && this.maximumBytes >= this.segmentBytes && this.maximumBatchBytes <= this.segmentBytes, 'RAW_LIMITS_INVALID');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); const stat = await fs.lstat(this.root);
    invariant(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0, 'RAW_ROOT_INVALID');
    this.writerLease = await new RawDirectoryLease(this.root).open();
    try {
    const allNames = await fs.readdir(this.root);
    invariant(allNames.length <= this.maximumSegments * 4 + 2, 'RAW_INVENTORY_TOO_LARGE');
    const names = allNames.filter(name => !RAW_LEASE_FILES.has(name)), stats = new Map();
    const rawNames = names.filter(name => !name.endsWith('.pin'));
    const rawIds = new Set(rawNames.map(name => name.split('.')[0]));
    invariant(rawIds.size === rawNames.length, 'RAW_DUPLICATE_SEGMENT_ID');
    const pinIds = new Set(names.filter(name => name.endsWith('.pin')).map(name => name.split('.')[0]));
    for (const name of names) {
      invariant(/^[a-f0-9-]+\.ndjson(?:\.open|\.recovered)?(?:\.pin)?$/.test(name), 'UNKNOWN_FILE_IN_RAW_ROOT');
      const s = await fs.lstat(path.join(this.root, name)); invariant(s.isFile() && !s.isSymbolicLink(), 'RAW_FILE_INVALID');
      if (name.endsWith('.pin')) invariant(s.size <= 4096 && rawIds.has(name.split('.')[0]), 'RAW_PIN_FILE_INVALID');
      stats.set(name, s);
    }
    for (const name of names) {
      if (name.endsWith('.pin')) continue;
      const s = stats.get(name);
      let actual = name;
      if (name.endsWith('.open')) {
        // Keep byte-exact crash evidence and force a forward continuity reset.
        actual = name.slice(0, -5) + '.recovered';
        await fs.rename(path.join(this.root, name), path.join(this.root, actual));
      }
      if (actual.endsWith('.recovered')) {
        await this.syncDirectory();
        // Re-announce retained recovered segments on boot. A crash after rename
        // but before the journal callback must not erase the continuity gap.
        await this.onRecovery({ type: 'RAW_CRASH_GAP', file: actual, bytes: s.size, at: this.now() });
      }
      this.files.push({ name: actual, bytes: s.size, modified: s.mtimeMs, pinned: pinIds.has(name.split('.')[0]) }); this.bytes += s.size;
    }
    this.files.sort((a, b) => a.modified - b.modified); await this.syncDirectory();
    // Enforce the rolling byte/age budget before accepting a new event. This
    // also shrinks an older, larger deployment on first boot without touching
    // pinned execution evidence.
    await this.prune(0, false);
    await this.checkDisk(); this.opened = true; return this;
    } catch (error) { this.failed = true; this.writerLease.close(); throw error; }
  }
  async checkDisk() {
    let disk = await this.statfs(this.root);
    const valid = value => value.blocks > 0 && Number.isFinite(value.bavail * value.bsize);
    const used = value => 1 - value.bavail / value.blocks;
    const ready = value => valid(value) && value.bavail * value.bsize >= this.minimumFreeBytes && used(value) < this.diskBlockUsedFraction;
    const shouldEvict = value => value.bavail * value.bsize < this.minimumFreeBytes + 1024 ** 3
      || used(value) >= this.diskEvictionUsedFraction;
    invariant(valid(disk), 'DISK_PRESSURE_BLOCKS_CAPTURE');
    if (shouldEvict(disk)) {
      invariant(this.writerLease?.held && this.assertWriter(), 'RAW_WRITER_UNAVAILABLE');
      const total = disk.blocks * disk.bsize, available = disk.bavail * disk.bsize;
      const reserve = Math.min(1024 ** 3, Math.max(this.segmentBytes * 4, Math.floor(total * 0.01)));
      const required = Math.min(total, Math.max(this.minimumFreeBytes + reserve,
        Math.floor(total * (1 - this.diskTargetUsedFraction)) + 1));
      let released = 0;
      for (const row of [...this.files]) {
        if (row === this.current?.row || row.pinned) continue;
        await fs.unlink(path.join(this.root, row.name)); this.bytes -= row.bytes; released += row.bytes;
        this.files.splice(this.files.indexOf(row), 1);
        if (available + released >= required) break;
      }
      if (released) await this.syncDirectory();
      disk = await this.statfs(this.root);
    }
    invariant(ready(disk), 'DISK_PRESSURE_BLOCKS_CAPTURE');
    this.pressureBlocked = false;
    this.lastDiskCheck = this.now();
  }
  async seal() {
    if (!this.current) return;
    invariant(this.writerLease?.held && this.assertWriter(), 'RAW_WRITER_UNAVAILABLE');
    const c = this.current; await c.handle.sync(); await c.handle.close();
    const closed = c.row.name.slice(0, -5);
    await fs.rename(path.join(this.root, c.row.name), path.join(this.root, closed));
    // Pin names are independent of .open/.recovered suffixes. A crash between
    // renaming a segment and a pin must never make pinned evidence evictable.
    c.row.name = closed; this.current = null; await this.syncDirectory();
  }
  async prune(incoming, needsSegment) {
    invariant(this.writerLease?.held && this.assertWriter(), 'RAW_WRITER_UNAVAILABLE');
    for (const row of [...this.files]) {
      if (row === this.current?.row || row.pinned) continue;
      if (this.bytes + incoming <= this.maximumBytes && this.files.length + Number(needsSegment) <= this.maximumSegments && this.now() - row.modified <= this.maximumAgeMs) continue;
      await fs.unlink(path.join(this.root, row.name)); this.bytes -= row.bytes; this.files.splice(this.files.indexOf(row), 1);
    }
    invariant(this.bytes + incoming <= this.maximumBytes && this.files.length + Number(needsSegment) <= this.maximumSegments, 'RAW_PINNED_CAP_BLOCKS_WRITE');
    this.lastPrune = this.now();
  }
  serialize(operation) {
    invariant(!this.closing && this.queued < 32, 'RAW_OPERATION_QUEUE_UNAVAILABLE');
    this.queued++;
    const next = this.tail.then(async () => {
      invariant(this.opened && this.writerLease?.held && this.assertWriter() && !this.failed, 'RAW_WRITER_UNAVAILABLE');
      this.busy = true;
      try { return await operation(); } finally { this.busy = false; }
    }).finally(() => { this.queued--; });
    this.tail = next.catch(() => {});
    return next;
  }
  async append(rows) { return this.serialize(() => this.appendLocked(rows)); }
  async appendLocked(rows) {
    invariant(this.opened && this.writerLease?.held && this.assertWriter() && !this.failed, 'RAW_WRITER_UNAVAILABLE');
    try {
      invariant(Array.isArray(rows) && rows.length > 0, 'RAW_EMPTY_BATCH');
      const data = rows.map(row => JSON.stringify(row)).join('\n') + '\n', size = Buffer.byteLength(data);
      invariant(size <= this.maximumBatchBytes, 'RAW_BATCH_TOO_LARGE');
      if (this.current && (this.current.row.bytes + size > this.segmentBytes || this.now() - this.current.createdAt >= this.segmentAgeMs)) await this.seal();
      if (this.bytes + size > this.maximumBytes || !this.current || this.now() - this.lastPrune >= 60000) await this.prune(size, !this.current);
      if (this.now() - this.lastDiskCheck >= 5000) await this.checkDisk();
      if (!this.current) {
        const row = { name: `${crypto.randomUUID()}.ndjson.open`, bytes: 0, modified: this.now(), pinned: false };
        const handle = await fs.open(path.join(this.root, row.name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        this.files.push(row); this.current = { row, handle, createdAt: this.now() }; await this.syncDirectory();
      }
      const c = this.current, offset = c.row.bytes;
      await c.handle.writeFile(data); await c.handle.sync();
      c.row.bytes += size; this.bytes += size; c.row.modified = this.now();
      return { segmentId: c.row.name.split('.')[0], offset, bytes: size, sha256: hash(data), rawBytes: this.bytes, persisted: true };
    } catch (error) {
      // Disk pressure is recoverable: keep the writer alive so the next
      // reconnect can prune/recheck and resume automatically. Integrity,
      // ownership and pinned-cap failures remain terminal.
      if (error?.message === 'DISK_PRESSURE_BLOCKS_CAPTURE') this.pressureBlocked = true;
      else this.failed = true;
      throw error;
    }
  }
  async verifyAndPin(receipt, expectedEvents = []) { return this.serialize(() => this.verifyAndPinLocked(receipt, expectedEvents)); }
  async verifyAndPinLocked(receipt, expectedEvents) {
    invariant(this.writerLease?.held && this.assertWriter() && receipt?.persisted, 'RAW_PIN_REQUIRES_PERSISTED_EVIDENCE');
    const row = this.files.find(r => r.name.split('.')[0] === receipt.segmentId);
    invariant(row && Number.isSafeInteger(receipt.offset) && receipt.offset >= 0 && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= this.maximumBatchBytes && receipt.offset + receipt.bytes <= row.bytes && /^[a-f0-9]{64}$/.test(receipt.sha256), 'RAW_PIN_RECEIPT_INVALID');
    const source = await fs.open(path.join(this.root, row.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const data = Buffer.alloc(receipt.bytes);
    try {
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await source.read(data, offset, data.length - offset, receipt.offset + offset);
        invariant(bytesRead > 0, 'RAW_RECEIPT_SHORT_READ'); offset += bytesRead;
      }
    } finally { await source.close(); }
    invariant(hash(data.toString('utf8')) === receipt.sha256 && data.at(-1) === 10, 'RAW_RECEIPT_HASH_MISMATCH');
    const records = data.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    for (const expected of expectedEvents) {
      const matches = records.filter(item => item.symbol === expected.symbol && item.type === expected.type && item.sequence === expected.sequence && item.epoch === expected.epoch);
      invariant(matches.length === 1 && hash(matches[0]) === hash({ ...expected, persisted: undefined, persistence: undefined }), 'RAW_EVENT_RECEIPT_MISMATCH');
    }
    if (!row.pinned) {
      const marker = `${receipt.segmentId}.ndjson.pin`;
      const file = await fs.open(path.join(this.root, marker), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.sync(); } finally { await file.close(); }
      row.pinned = true; await this.syncDirectory();
    }
    return { segmentId: receipt.segmentId, offset: receipt.offset, bytes: receipt.bytes, sha256: receipt.sha256, pinned: true, verified: true };
  }
  async pin(receipt) { return this.verifyAndPin(receipt); }
  status() { return { bytes: this.bytes, segments: this.files.length, pinnedBytes: this.files.filter(r => r.pinned).reduce((n, r) => n + r.bytes, 0), captureReady: !!this.opened && !this.failed && !this.pressureBlocked && !this.closing && !!this.writerLease?.held && !!this.assertWriter() }; }
  async close() {
    this.closing = true; await this.tail;
    try {
      if ((this.failed || !this.writerLease?.held || !this.assertWriter()) && this.current) { await this.current.handle.close(); this.current = null; }
      else await this.seal();
    } finally {
      if (this.current) { await this.current.handle.close().catch(() => {}); this.current = null; }
      this.opened = false; this.writerLease?.close();
    }
  }
}
