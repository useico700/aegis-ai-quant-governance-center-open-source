export const CANDIDATE_PRIORITY_REVISION = 'S1-S2-CQ4-NEAREST-PX-BAND-FIRST-20260919';

const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

// Ordering only: this function never grants entry or replaces the execution gates.
// LONG uses ask, SHORT uses bid. Px itself is outside the strictly same-side band.
export function candidateProximity(plan, quote) {
  const px = plan?.iq1Plan?.intersectionPrice ?? plan?.intersectionPrice;
  const bid = quote?.bid, ask = quote?.ask;
  const direction = plan?.direction === 'LONG' ? 1 : plan?.direction === 'SHORT' ? -1 : 0;
  if (!direction || !positive(px) || !positive(bid) || !positive(ask) || Number(bid) > Number(ask)) return null;
  const price = Number(direction === 1 ? ask : bid);
  const offset = direction * (price - Number(px)) / Number(px);
  const sameSide = offset > 0;
  return { px: Number(px), price, sameSide, inside: sameSide && offset <= 0.02,
    tier: sameSide ? (offset <= 0.02 ? 0 : 1) : 2,
    bandDistance: sameSide ? Math.max(0, offset - 0.02) : Math.abs(offset),
    pxDistance: Math.abs(offset) };
}

export function compareCandidateProximity(left, right, quote) {
  const manualPriority = Number(right?.source === 'OWNER_MANUAL') - Number(left?.source === 'OWNER_MANUAL');
  if (manualPriority) return manualPriority;
  const a = candidateProximity(left, quote), b = candidateProximity(right, quote);
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return a.tier - b.tier || a.bandDistance - b.bandDistance || a.pxDistance - b.pxDistance
    || (timestamp(right.closedAt ?? right.intersectionTime) || 0) - (timestamp(left.closedAt ?? left.intersectionTime) || 0)
    || String(left.id).localeCompare(String(right.id));
}

export function rankSameSymbolCandidates(signals, market, now) {
  const groups = new Map();
  for (const signal of signals) {
    if (!groups.has(signal.symbol)) groups.set(signal.symbol, []);
    groups.get(signal.symbol).push(signal);
  }
  for (const [symbol, plans] of groups) {
    const quote = market?.[symbol]?.bbo;
    const fresh = quote?.persisted === true && quote?.continuity === true
      && [quote.marketTime, quote.receivedAt].every(at => Number.isFinite(at) && at <= now && now - at <= 2000);
    if (fresh) plans.sort((a, b) => compareCandidateProximity(a, b, quote));
  }
  // Preserve the original cross-symbol competition; only replace each symbol's slots.
  return signals.map(signal => groups.get(signal.symbol).shift());
}
