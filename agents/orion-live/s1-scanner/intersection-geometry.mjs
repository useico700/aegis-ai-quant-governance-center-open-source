import { anchorPairQuality } from '../../orion-v2/paper/paper-engine.mjs';
import { lineFromPivots } from '../../../scripts/v2-mtf-trendline-intersection.mjs';

// S1 owner-defined geometric links: confirmed swings and scale qualification
// remain required, but intervening penetration is not a support/resistance veto.
export function geometricPairs(pivots, opposites, bars, direction, policy) {
  const earliest = Math.max(0, bars.length - policy.searchWindowBars);
  const recent = pivots.filter(p => p.index >= earliest), visible = bars.slice(-policy.searchWindowBars);
  const range = Math.max(...visible.map(b => b.high)) - Math.min(...visible.map(b => b.low));
  if (!(range > 0)) return [];
  const pairs = [], separation = policy.minimumAnchorSeparationBars ?? policy.minimumSeparationBars ?? 1;
  for (let j = 1; j < recent.length; j++) for (let i = 0; i < j; i++) {
    const first = recent[i], second = recent[j];
    if (second.index - first.index < separation || Math.sign(second.price - first.price) !== direction
      || !opposites.some(p => p.index > first.index && p.index < second.index)) continue;
    const anchorProminenceFraction = (first.prominenceAbsolute + second.prominenceAbsolute) / (2 * range);
    const pairMoveFraction = Math.abs(second.price - first.price) / range;
    const spanFraction = (second.index - first.index) / policy.searchWindowBars;
    if (anchorProminenceFraction < policy.minimumAnchorProminenceFractionOfVisibleRange
      || pairMoveFraction < policy.minimumPairMoveFractionOfVisibleRange
      || spanFraction < policy.minimumPairSpanFractionOfSearchWindow) continue;
    const span15m = second.coordinate15m - first.coordinate15m;
    const hierarchyMultiplier = Math.min(first.hierarchyMultiplier ?? 1, second.hierarchyMultiplier ?? 1);
    const pair = { first, second, span15m, hierarchyMultiplier, anchorProminenceFraction, pairMoveFraction, spanFraction,
      secondAnchorAgeFraction: (bars.length - 1 - second.index) / policy.searchWindowBars,
      importance: span15m * (first.prominenceAbsolute + second.prominenceAbsolute) * (1 + pairMoveFraction) * (1 + Math.log2(hierarchyMultiplier)),
      line: lineFromPivots({ time: first.coordinate15m, price: first.price }, { time: second.coordinate15m, price: second.price }) };
    pair.qualityScore = anchorPairQuality(pair, policy); pairs.push(pair);
  }
  return pairs.sort((a,b) => b.hierarchyMultiplier - a.hierarchyMultiplier || b.importance - a.importance || b.second.time - a.second.time);
}

export const UNTOUCHED_REVISION = 'S1-GEOMETRIC-UNTOUCHED-PX-1';

// Closed OHLC is screening evidence, never a tick fill or same-bar path claim.
// Start after all anchors were causally confirmed. Never infer missing history.
export function untouchedPxReview(plan, bars1h, bars15m, now) {
  const confirmation = Math.max(...(plan.anchors ?? []).map(a => a.confirmedAt));
  const start = Number.isFinite(plan.touchStartAt) ? plan.touchStartAt : confirmation + 1, cross = plan.intersectionTime, px = plan.intersectionPrice;
  if (![start,cross,px,now].every(Number.isFinite) || !(start < cross) || !(px > 0)) return { reason: 'PX_TOUCH_HISTORY_UNVERIFIED' };
  const fine = bars15m.filter(b => b.closeTime < now);
  const fineStart = Math.ceil(fine[0]?.openTime / 3600000) * 3600000;
  if (!Number.isFinite(fineStart)) return { reason: 'PX_TOUCH_HISTORY_UNVERIFIED' };
  const bars = [...bars1h.filter(b => b.closeTime < fineStart), ...fine.filter(b => b.openTime >= fineStart)].filter(b => b.closeTime >= start && b.openTime < cross);
  let through = start - 1;
  for (const bar of bars) {
    if (bar.openTime < start) return { reason: 'PX_TOUCH_HISTORY_UNVERIFIED' };
    if (bar.openTime !== through + 1 || ![bar.high,bar.low,bar.closeTime].every(Number.isFinite) || bar.high < bar.low)
      return { reason: 'PX_TOUCH_HISTORY_UNVERIFIED' };
    if (bar.low <= px && bar.high >= px) return { reason: bar.closeTime < cross ? 'PX_ALREADY_TOUCHED_BEFORE_CROSS' : 'PX_CROSS_BAR_TOUCH_ORDER_UNVERIFIED',
      evidence: { start, barOpen: bar.openTime, barClose: bar.closeTime, low: bar.low, high: bar.high, px } };
    through = bar.closeTime;
  }
  const expected = Math.min(Math.floor(now / 900000) * 900000 - 1, Math.floor(cross / 900000) * 900000 + 899999);
  if (through < expected) return { reason: 'PX_TOUCH_HISTORY_UNVERIFIED' };
  return { reason: null, evidence: { revision: UNTOUCHED_REVISION, start, checkedThrough: through, basis: 'CLOSED_OHLC_WICK_INCLUSIVE_NO_PRICE_BUFFER' } };
}
