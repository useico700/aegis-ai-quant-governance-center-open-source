// Presentation only: retired rules and stale signals never become current UI state.
export const ACTIVE_V3_MONITOR_REVISION = 'MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE';
export const V3_MONITOR_FRESHNESS_MS = 120000;
const FIFTEEN_MINUTES = 900000;
export function currentCandidateView(snapshot, now, envelopeStatus = 'OK', refreshFailed = false) {
  const source = Date.parse(snapshot?.sourceAsOf ?? '');
  if (refreshFailed || envelopeStatus !== 'OK' || !Number.isFinite(now) || !Number.isFinite(source) ||
      now - source > V3_MONITOR_FRESHNESS_MS || source - now > 5000) {
    return { status: 'STALE', candidatePlans: [], expiredCount: 0 };
  }
  if (snapshot?.implementationRevision !== ACTIVE_V3_MONITOR_REVISION) {
    return { status: 'INACTIVE_REVISION', candidatePlans: [], expiredCount: 0 };
  }
  const rows = Array.isArray(snapshot.candidatePlans) ? snapshot.candidatePlans : [];
  const current = rows.filter(row => {
    const tx = row?.intersectionTime;
    // HF14 uses the cross bar and immediate next native 15M close, then 300s.
    const deadline = Math.floor(tx / FIFTEEN_MINUTES) * FIFTEEN_MINUTES + 2 * FIFTEEN_MINUTES - 1 + 300000;
    return Number.isFinite(tx) && tx > 0 && now <= deadline &&
      !/EXPIRED|INVALIDATED|CONSUMED|REJECTED/.test(String(row?.entryStatus ?? ''));
  });
  return { status: 'CURRENT', candidatePlans: current, expiredCount: rows.length - current.length };
}
