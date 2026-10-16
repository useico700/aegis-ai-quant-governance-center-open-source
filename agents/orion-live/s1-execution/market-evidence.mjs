import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import { invariant, UNIVERSE, fresh } from './common.mjs';

// Capture may retain causally ordered events through ordinary transport jitter.
// Entry construction remains independently capped at 2 seconds in entry-plan
// and engine, so raising this storage/continuity ceiling cannot authorize a
// delayed quote for submission.
const CAPTURE_EVENT_MAXIMUM_LAG_MS = 15000;

// This ingester accepts forward WebSocket events only, never REST backfill.
// Disconnect/overflow invalidates current coverage; later fresh observations do
// not erase the historical gap or qualify positions spanning it for promotion.
export class ForwardEvidence {
  constructor({ persist, now = Date.now, maximumQueue = 10000 }) {
    this.persist = persist; this.now = now; this.maximumQueue = maximumQueue;
    this.sequence = 0; this.epoch = 0; this.connectedAt = null; this.queue = []; this.queuedBbo = new Map(); this.latest = new Map(); this.prior = new Map(); this.draining = false;
    this.intersectionWatches = new Map(); this.intersectionAnchors = new Map();
    this.warmupDiscarded = 0;
  }
  connect() {
    this.epoch++; this.connectedAt = this.now(); this.latest.clear(); this.prior.clear(); this.queue = []; this.queuedBbo.clear();
    for (const watch of this.intersectionWatches.values()) watch.epoch = this.epoch;
  }
  disconnect(reason = 'DISCONNECTED') { this.connectedAt = null; this.latest.clear(); this.prior.clear(); this.queue = []; this.queuedBbo.clear(); this.gapReason = reason; }
  ingest(message) {
    try {
      invariant(this.connectedAt !== null, 'FEED_DISCONNECTED');
      invariant(UNIVERSE.includes(message?.s) && ['bookTicker', 'aggTrade'].includes(message.e), 'FORWARD_EVENT_INVALID');
      invariant(message.st === undefined || message.st === 1, 'NON_USDM_STREAM_EVENT');
      const type = message.e === 'bookTicker' ? 'BBO' : 'TICK';
      const marketTime = message.T, eventTime = message.E, receivedAt = this.now();
      invariant(fresh(marketTime, receivedAt, CAPTURE_EVENT_MAXIMUM_LAG_MS)
        && fresh(eventTime, receivedAt, CAPTURE_EVENT_MAXIMUM_LAG_MS), 'MARKET_CLOCK_INVALID');
      const updateId = String(type === 'BBO' ? message.u : message.a);
      const rawId = type === 'BBO' ? message.u : message.a;
      invariant(typeof rawId === 'string' || Number.isSafeInteger(rawId), 'UNSAFE_EVENT_ID');
      invariant(/^\d+$/.test(updateId) && BigInt(updateId) > 0n, 'EVENT_ID_INVALID');
      const key = `${message.s}:${type}`, previous = this.prior.get(key);
      if (!previous && marketTime < this.connectedAt) {
        // Initial network-buffered events can predate completion of the two
        // socket handshakes (an aggregate's dispatch time can be later). They
        // cannot qualify and do not advance any ID,
        // sequence, queue, or quote; wait for this symbol's first causal event.
        // Once a symbol has evidence, old events still invalidate the epoch.
        this.warmupDiscarded++; return true;
      }
      invariant(marketTime >= this.connectedAt, 'MARKET_CLOCK_INVALID');
      invariant(!previous || BigInt(updateId) > BigInt(previous.updateId) && marketTime >= previous.marketTime, 'EVENT_REGRESSION');
      if (type === 'TICK' && previous) invariant(BigInt(updateId) === BigInt(previous.updateId) + 1n, 'AGG_TRADE_GAP');
      if (type === 'BBO') invariant(Number(message.b) > 0 && Number(message.a) >= Number(message.b) && Number(message.B) >= 0 && Number(message.A) >= 0, 'BBO_INVALID');
      else invariant(Number(message.p) > 0 && Number(message.q) > 0, 'TICK_INVALID');
      const row = { symbol: message.s, type, marketTime, eventTime, receivedAt, connectedAt: this.connectedAt, epoch: this.epoch, sequence: ++this.sequence, updateId, continuity: true,
        ...(type === 'BBO' ? { bid: String(message.b), ask: String(message.a), bidQuantity: String(message.B), askQuantity: String(message.A) } : { price: String(message.p), quantity: String(message.q) }) };
      this.prior.set(key, row);
      // Binance bookTicker is an every-update stream. Persist the newest exact
      // quote per symbol in each bounded flush instead of serializing thousands
      // of already superseded quotes. Entry remains unavailable until that
      // newest quote is durably flushed, and aggregate trades remain lossless.
      const queuedIndex = type === 'BBO' ? this.queuedBbo.get(key) : undefined;
      if (queuedIndex !== undefined) this.queue[queuedIndex] = row;
      else {
        invariant(this.queue.length < this.maximumQueue, 'EVIDENCE_QUEUE_OVERFLOW');
        if (type === 'BBO') this.queuedBbo.set(key, this.queue.length);
        this.queue.push(row);
      }
      return true;
    } catch (error) { this.disconnect(error.message); return false; }
  }
  async flush() {
    invariant(!this.draining, 'EVIDENCE_SINGLE_WRITER_BUSY');
    if (!this.queue.length) return;
    this.draining = true; const epoch = this.epoch, batch = this.queue.splice(0); this.queuedBbo.clear();
    try {
      const receipt = await this.persist(batch);
      if (this.connectedAt !== null && this.epoch === epoch) for (const row of batch) {
        const key = `${row.symbol}:${row.type}`, previous = this.latest.get(key);
        const persisted = { ...row, persisted: true, ...(receipt ? { persistence: receipt } : {}) };
        if (row.type === 'TICK' && previous) for (const [eventId, watch] of this.intersectionWatches) {
          if (watch.symbol !== row.symbol || watch.epoch !== epoch || this.intersectionAnchors.has(eventId)) continue;
          if (previous.marketTime < watch.intersectionTime && row.marketTime >= watch.intersectionTime) {
            this.intersectionAnchors.set(eventId, { previous, trade: persisted, epoch });
            this.intersectionWatches.delete(eventId);
          }
        }
        this.latest.set(key, persisted);
      }
    } catch (error) { this.disconnect('EVIDENCE_PERSIST_FAILED'); throw error; }
    finally { this.draining = false; }
  }
  get(symbol, type) { return this.connectedAt === null ? null : this.latest.get(`${symbol}:${type}`) ?? null; }
  watchIntersection(eventId, symbol, intersectionTime) {
    invariant(typeof eventId === 'string' && eventId.length <= 200 && UNIVERSE.includes(symbol)
      && Number.isFinite(intersectionTime) && intersectionTime > 0, 'INTERSECTION_WATCH_INVALID');
    const anchored = this.intersectionAnchors.get(eventId);
    if (anchored) return anchored;
    const prior = this.intersectionWatches.get(eventId);
    invariant(!prior || prior.symbol === symbol && prior.intersectionTime === intersectionTime, 'INTERSECTION_WATCH_CHANGED');
    invariant(prior || this.intersectionWatches.size < 100, 'INTERSECTION_WATCH_CAPACITY');
    this.intersectionWatches.set(eventId, { symbol, intersectionTime, epoch: this.epoch });
    return null;
  }
  intersectionAnchor(eventId) { return this.intersectionAnchors.get(eventId) ?? null; }
}

// Bounded complete batch segments simplify crash behavior: abandoned *.open
// files are counted against the quota and block entries until operator review.
// Limits include pinned bytes. Pinned evidence is never deleted to make room.
export class RawEvidenceStore {
  constructor(root, { maximumBytes = 42949672960, maximumAgeMs = 7 * 86400000, minimumFreeBytes = 5 * 1024 ** 3, blockUsedFraction = 0.85, maximumBatchBytes = 4 * 1024 ** 2, maximumSegments = 4096, statfs = fs.statfs, now = Date.now } = {}) {
    this.root = root; this.maximumBytes = maximumBytes; this.maximumAgeMs = maximumAgeMs; this.minimumFreeBytes = minimumFreeBytes; this.blockUsedFraction = blockUsedFraction; this.maximumBatchBytes = maximumBatchBytes; this.maximumSegments = maximumSegments; this.statfs = statfs; this.now = now;
  }
  async inventory() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    invariant(!(await fs.lstat(this.root)).isSymbolicLink(), 'RAW_ROOT_SYMLINK');
    const names = await fs.readdir(this.root), rows = [];
    for (const name of names) {
      invariant(/^[a-f0-9-]+\.ndjson(?:\.open|\.pin)?$/.test(name), 'UNKNOWN_FILE_IN_RAW_ROOT');
      const stat = await fs.lstat(path.join(this.root, name));
      invariant(stat.isFile() && !stat.isSymbolicLink(), 'RAW_FILE_INVALID');
      if (name.endsWith('.pin')) continue;
      rows.push({ name, bytes: stat.size, modified: stat.mtimeMs, pinned: names.includes(`${name}.pin`) });
    }
    return rows.sort((a, b) => a.modified - b.modified);
  }
  async append(rows) {
    invariant(!this.busy, 'RAW_SINGLE_WRITER_BUSY'); this.busy = true;
    try {
      const data = rows.map(row => JSON.stringify(row)).join('\n') + '\n', size = Buffer.byteLength(data);
      invariant(size <= this.maximumBatchBytes && size <= this.maximumBytes, 'RAW_BATCH_TOO_LARGE');
      const inventory = await this.inventory();
      invariant(!inventory.some(row => row.name.endsWith('.open')), 'RAW_INCOMPLETE_SEGMENT_REVIEW_REQUIRED');
      let bytes = inventory.reduce((sum, row) => sum + row.bytes, 0), count = inventory.length;
      const deleted = [];
      for (const row of inventory) {
        if (row.pinned || count < this.maximumSegments && bytes + size <= this.maximumBytes && this.now() - row.modified <= this.maximumAgeMs) continue;
        await fs.unlink(path.join(this.root, row.name)); bytes -= row.bytes; count--; deleted.push(row.name);
      }
      invariant(bytes + size <= this.maximumBytes, 'RAW_PINNED_CAP_BLOCKS_WRITE');
      invariant(count < this.maximumSegments, 'RAW_PINNED_SEGMENT_CAP_BLOCKS_WRITE');
      const disk = await this.statfs(this.root);
      invariant(disk.blocks > 0 && disk.bavail * disk.bsize >= this.minimumFreeBytes && 1 - disk.bavail / disk.blocks < this.blockUsedFraction, 'DISK_PRESSURE_BLOCKS_CAPTURE');
      const file = path.join(this.root, `${crypto.randomUUID()}.ndjson`);
      const handle = await fs.open(`${file}.open`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(`${file}.open`, file);
      const directory = await fs.open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      return { file: path.basename(file), rawBytes: bytes + size, deleted, persisted: true };
    } finally { this.busy = false; }
  }
}
