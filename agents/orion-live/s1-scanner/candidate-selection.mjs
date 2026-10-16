import { pxFirstCloseSignal } from '../../shared/px-first-close.mjs';

export const SELECTION_REVISION = 'S1-INTERSECTION-QUALITY-DEDUP-1';
const finite = Number.isFinite;
const score = x => finite(x) ? x : 0;
const valid = p => typeof p?.pattern === 'string' && typeof p.fourHourLineStatus === 'string'
  && p.anchors?.length === 4 && p.anchors.every(a => finite(a.time) && finite(a.price))
  && finite(p.intersectionTime) && finite(p.intersectionPrice) && p.intersectionPrice > 0;
export function selectionPolicy(strategy) {
  const p = strategy.intersection.anchorConsensus;
  return { revision: SELECTION_REVISION, timeRadiusMs: Math.max(1, Number(p?.clusterTimeRadiusMinutes ?? 120)) * 60000,
    priceRadiusBps: Math.max(1, Number(p?.clusterPriceRadiusBps ?? 100)) };
}
export function equivalentIntersection(a, b, policy) {
  return valid(a) && valid(b) && a.symbol === b.symbol && a.pattern === b.pattern
    && a.fourHourLineStatus === b.fourHourLineStatus
    && !(a.pxEntryState?.direction && b.pxEntryState?.direction && a.pxEntryState.direction !== b.pxEntryState.direction)
    && Math.abs(a.intersectionTime - b.intersectionTime) <= policy.timeRadiusMs
    && Math.abs(a.intersectionPrice - b.intersectionPrice) / Math.max(a.intersectionPrice, b.intersectionPrice) * 10000 <= policy.priceRadiusBps;
}
export const confirmationStarted = (p, now) => pxFirstCloseSignal(p).accepted
  || (finite(p.lockedBarOpenTime) && now >= p.lockedBarOpenTime)
  || (finite(p.intersectionTime) && now >= p.intersectionTime);
// Direct representative comparisons avoid transitive chains merging distinct
// endpoints. Never rewrite a representative's coordinates or confirmation state.
export function selectDistinctIntersections(plans, now, strategy) {
  const policy = selectionPolicy(strategy), queue = [], suppressed = [];
  const ranked = [...plans].sort((a,b) => Number(confirmationStarted(b,now))-Number(confirmationStarted(a,now))
    || score(b.anchorConsensus?.stabilityScore)-score(a.anchorConsensus?.stabilityScore)
    || score(b.anchorQualityScore)-score(a.anchorQualityScore)
    || score(b.anchorSensitivity?.score)-score(a.anchorSensitivity?.score)
    || a.intersectionTime-b.intersectionTime || a.createdAt-b.createdAt || String(a.id).localeCompare(String(b.id)));
  for (const plan of ranked) {
    const representative = !confirmationStarted(plan,now) && queue.find(p => equivalentIntersection(plan,p,policy));
    if (representative) suppressed.push({plan,representative}); else queue.push(plan);
  }
  return { queue, suppressed, policy };
}
