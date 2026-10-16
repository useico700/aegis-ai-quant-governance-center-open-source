import fs from "node:fs/promises";
import path from "node:path";

const RAW_SEGMENT_PATTERN = /\.(?:ndjson|jsonl)(?:\.(?:gz|zst))?$/;

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

export async function rawInventory(rawRoot) {
  await fs.mkdir(rawRoot, { recursive: true });
  const entries = await fs.readdir(rawRoot, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !RAW_SEGMENT_PATTERN.test(entry.name) || entry.name.endsWith(".open")) continue;
    const filePath = path.join(rawRoot, entry.name);
    const stat = await fs.stat(filePath);
    rows.push({ filePath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, pinned: await exists(`${filePath}.pin`) });
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return rows;
}

export async function enforceRawRetention(config, { now = Date.now(), statfsImpl = fs.statfs, unlinkImpl = fs.unlink } = {}) {
  const retention = config.retention;
  if (retention.rawManagement === 'SEGMENTED_WRITER_OBSERVER') return observeSegmentedRetention(retention, now, statfsImpl);
  const rows = await rawInventory(retention.rawRoot);
  const cutoff = now - retention.rawRetentionDays * 86400000;
  let totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  const deleted = [];
  const errors = [];
  for (const row of rows) {
    const ageExpired = row.mtimeMs < cutoff;
    const capExceeded = totalBytes > retention.rawMaximumBytes;
    if ((!ageExpired && !capExceeded) || row.pinned) continue;
    try {
      await unlinkImpl(row.filePath);
      totalBytes -= row.size;
      deleted.push({ name: row.name, size: row.size, reason: ageExpired ? "AGE" : "CAP" });
    } catch (error) {
      errors.push({ name: row.name, code: error?.code ?? "DELETE_FAILED" });
    }
  }
  const volume = await statfsImpl(retention.rawRoot);
  const diskUsedPercent = volume.blocks > 0 ? (1 - Number(volume.bavail) / Number(volume.blocks)) * 100 : 100;
  const pinnedBytes = rows.filter((row) => row.pinned).reduce((sum, row) => sum + row.size, 0);
  const blockNewEntries = totalBytes > retention.rawMaximumBytes || diskUsedPercent >= retention.diskBlockNewEntriesPercent || errors.length > 0;
  return {
    checkedAt: new Date(now).toISOString(),
    rawBytes: totalBytes,
    rawMaximumBytes: retention.rawMaximumBytes,
    pinnedBytes,
    diskUsedPercent,
    deleted,
    errors,
    blockNewEntries,
    reason: errors.length ? "RETENTION_DELETE_FAILED" : totalBytes > retention.rawMaximumBytes ? "RAW_CAP_EXCEEDED_BY_PINNED_EVIDENCE" : diskUsedPercent >= retention.diskBlockNewEntriesPercent ? "DISK_HIGH_WATER" : "WITHIN_LIMITS",
  };
}

// In this mode the account reader never deletes files. Only the raw-directory
// lease holder can pin, rotate and evict; its cached byte total cannot be
// invalidated by an independent janitor. Inventory is observational, not a
// reservation or a certificate of entry readiness.
export async function observeSegmentedRetention(retention, now = Date.now(), statfsImpl = fs.statfs) {
  const base = { checkedAt: new Date(now).toISOString(), rawManagement: 'SEGMENTED_WRITER_OBSERVER', observerOnly: true,
    rawMaximumBytes: retention.rawMaximumBytes, deleted: [], financialOrPinnedEvidenceEvicted: false };
  const check = (ok, code) => { if (!ok) throw new Error(code); };
  try {
    await fs.mkdir(retention.rawRoot, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(retention.rawRoot);
    check(root.isDirectory() && !root.isSymbolicLink() && (root.mode & 0o022) === 0, 'RAW_ROOT_INVALID');
    const names = await fs.readdir(retention.rawRoot);
    check(names.length <= 16386, 'RAW_INVENTORY_TOO_LARGE');
    const pinIds = new Set(names.filter(name => name.endsWith('.pin')).map(name => name.split('.')[0]));
    const rawIds = new Set(names.filter(name => !name.startsWith('.') && !name.endsWith('.pin')).map(name => name.split('.')[0]));
    let rawBytes = 0, pinnedBytes = 0, metadataBytes = 0, incompleteSegments = 0, ageExpiredUnpinned = 0;
    for (const name of names) {
      check(/^[a-f0-9-]+\.ndjson(?:\.open|\.recovered)?(?:\.pin)?$/.test(name) || /^\.ownership\.sqlite(?:-journal)?$/.test(name), 'RAW_UNKNOWN_FILE');
      const stat = await fs.lstat(path.join(retention.rawRoot, name));
      check(stat.isFile() && !stat.isSymbolicLink(), 'RAW_FILE_INVALID');
      if (name.startsWith('.ownership.') || name.endsWith('.pin')) {
        if (name.endsWith('.pin')) check(rawIds.has(name.split('.')[0]), 'RAW_ORPHAN_PIN');
        check(stat.size <= (name.endsWith('.pin') ? 4096 : 131072), 'RAW_METADATA_TOO_LARGE'); metadataBytes += stat.size; continue;
      }
      rawBytes += stat.size;
      const pinned = pinIds.has(name.split('.')[0]);
      if (pinned) pinnedBytes += stat.size;
      else if (now - stat.mtimeMs > retention.rawRetentionDays * 86400000) ageExpiredUnpinned++;
      if (name.endsWith('.open') || name.endsWith('.recovered')) incompleteSegments++;
    }
    const volume = await statfsImpl(retention.rawRoot);
    const diskUsedPercent = volume.blocks > 0 ? (1 - Number(volume.bavail) / Number(volume.blocks)) * 100 : 100;
    const availableBytes = Number(volume.bavail) * Number(volume.bsize);
    const pressure = diskUsedPercent >= retention.diskBlockNewEntriesPercent || !Number.isFinite(availableBytes) || availableBytes < (retention.minimumFreeBytes ?? 5 * 1024 ** 3);
    const blockNewEntries = rawBytes >= retention.rawMaximumBytes || pressure || ageExpiredUnpinned > 0;
    return { ...base, rawBytes, pinnedBytes, metadataBytes, incompleteSegments, ageExpiredUnpinned, diskUsedPercent, availableBytes,
      errors: [], blockNewEntries, reason: pressure ? 'DISK_HIGH_WATER' : rawBytes >= retention.rawMaximumBytes ? 'RAW_CAP_REACHED' : ageExpiredUnpinned ? 'RAW_WRITER_PRUNE_PENDING' : 'WITHIN_LIMITS_OBSERVER_ONLY' };
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.code === 'ENOENT' ? 'RAW_INVENTORY_CHANGED_RECHECK' : 'RAW_INVENTORY_UNVERIFIED';
    return { ...base, rawBytes: null, pinnedBytes: null, errors: [{ code }], blockNewEntries: true, reason: 'RAW_INVENTORY_UNVERIFIED' };
  }
}
