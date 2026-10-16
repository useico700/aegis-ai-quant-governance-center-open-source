// Presentation only. Never mutate the source snapshot or the scanner's decision order.
const active = new Set(['FORMING', 'WAITING_CLOSE', 'CONFIRMED_SCAN_ONLY', 'WAITING_FIRST_PX_CLOSE', 'FIRST_CLOSE_LOCKED']);
const terminal = new Set(['EXPIRED', 'CONFIRMED_EXPIRED', 'NON_CAUSAL_OBSERVATION', 'INVALIDATED']);
export function sortCandidates(candidates, now, snapshotStale = false) {
  if (!Array.isArray(candidates)) return [];
  if (!Number.isFinite(now) || now <= 0) return [...candidates];
  const rank = row => {
    if (snapshotStale || row.stale) return 4;
    if (terminal.has(row.status)) return 2;
    if (!active.has(row.status) || !Number.isFinite(Date.parse(row.intersectionTime))) return 3;
    return Date.parse(row.intersectionTime) > now ? 0 : 1;
  };
  return [...candidates].sort((a, b) => {
    const bucket = rank(a), difference = bucket - rank(b);
    if (difference) return difference;
    const ta = Date.parse(a.intersectionTime), tb = Date.parse(b.intersectionTime);
    if (bucket <= 2) {
      const validA = Number.isFinite(ta), validB = Number.isFinite(tb);
      if (validA !== validB) return validA ? -1 : 1;
      if (validA && ta !== tb) return bucket === 0 ? ta - tb : tb - ta;
    }
    // Stable ties across incoming snapshots, no random reshuffling at equal countdowns.
    return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''), 'en') || String(a.id ?? '').localeCompare(String(b.id ?? ''), 'en');
  });
}
