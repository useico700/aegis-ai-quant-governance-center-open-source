import crypto from 'node:crypto';
import { structuralPivots, structuralPairs } from '../orion-v2/paper/paper-engine.mjs';

export const S2_Z_STRUCTURE_REVISION = 'S2-15M-Z-FIRST-1H-PX-1';
// Existing owner-approved S2 pivot quality and intersection settings. The Z
// revision changes discovery order, not these numeric quality thresholds.
export const S2_Z_GEOMETRY_POLICY_HASH = 'd6e3a42cedfaf5cfc0cdc50a6756e67723d49468147c2c0fd2de32fc4c5f0f01';
const M5 = 300000, M15 = 900000, H1 = 3600000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : NaN;
const positive = value => Number.isFinite(value) && value > 0;
const time = value => Number.isSafeInteger(value) && value >= 0;
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Number.EPSILON * 64 * Math.max(1, Math.abs(a), Math.abs(b));
const result = (status, reason, evidence = null) => ({ allowed: status === 'VALID', status, reason, terminal: status === 'INVALID', evidence });
const tuple = bar => [bar.openTime, bar.open, bar.high, bar.low, bar.close];

function barsOf(input, interval, now, { latest = false } = {}) {
  if (!Array.isArray(input) || !input.length) return null;
  const output = [];
  for (const value of input) {
    const row = Array.isArray(value) ? { openTime: value[0], open: value[1], high: value[2], low: value[3], close: value[4] } : value;
    if (!row || row.closed === false || row.isClosed === false) return null;
    const bar = Object.fromEntries(['openTime', 'open', 'high', 'low', 'close'].map(key => [key, number(row[key])]));
    bar.closeTime = row.closeTime === undefined ? bar.openTime + interval - 1 : number(row.closeTime);
    if (!time(bar.openTime) || bar.openTime % interval !== 0 || bar.closeTime !== bar.openTime + interval - 1 ||
      bar.closeTime >= now || ![bar.open, bar.high, bar.low, bar.close].every(positive) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high) ||
      (output.length && bar.openTime !== output.at(-1).openTime + interval)) return null;
    output.push(bar);
  }
  if (latest && output.at(-1).closeTime !== Math.floor(now / interval) * interval - 1) return null;
  return output;
}

function mergedBars(frozen, continuation, current, interval, now, cutoff) {
  const initial = barsOf(frozen, interval, now);
  const fresh = barsOf(current, interval, now, { latest: true });
  if (!initial || !fresh) return null;
  const continued = continuation?.length ? barsOf(continuation, interval, now) : [];
  if (!continued) return null;
  const byTime = new Map(initial.map(bar => [bar.openTime, bar]));
  for (const bar of [...continued, ...fresh]) {
    const old = byTime.get(bar.openTime);
    if (old && JSON.stringify(tuple(old)) !== JSON.stringify(tuple(bar))) return null;
    byTime.set(bar.openTime, bar);
  }
  const merged = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  const requiredLastClose = (Math.ceil((cutoff + 1) / interval) - 1) * interval - 1;
  const required = merged.filter(bar => bar.closeTime < cutoff);
  if (!required.length || required.at(-1).closeTime !== requiredLastClose ||
    required.some((bar, index) => index > 0 && bar.openTime !== required[index - 1].openTime + interval)) return null;
  // The frozen validity claim ends before Px. A gap strictly after that cutoff
  // is not missing line-validity evidence; current bars still need freshness.
  return merged;
}

function pointValid(point, bars, policy, discoveredAt) {
  if (!point || !['LOW', 'HIGH'].includes(point.type) || !time(point.time) || !time(point.confirmedAt) ||
    !positive(point.price) || point.confirmedAt >= discoveredAt) return false;
  const index = bars.findIndex(bar => bar.openTime === point.time);
  const multiplier = Number(point.hierarchyMultiplier ?? 1);
  const left = Number(policy.leftBars ?? 2), right = Number(policy.rightBars ?? 2);
  if (!Number.isInteger(multiplier) || multiplier < 1 || !(policy.hierarchyWindowMultipliers ?? [1]).includes(multiplier) ||
    index < left * multiplier || index + right * multiplier >= bars.length ||
    bars[index + right * multiplier].closeTime !== point.confirmedAt || point.coordinate15m !== point.time / M15 || point.index !== index) return false;
  const field = point.type === 'HIGH' ? 'high' : 'low';
  if (bars[index][field] !== point.price) return false;
  const baseWindow = bars.slice(index - left, index + right + 1);
  const prominence = field === 'high' ? point.price - Math.min(...baseWindow.map(b => b.low))
    : Math.max(...baseWindow.map(b => b.high)) - point.price;
  if (!near(point.prominenceAbsolute, prominence)) return false;
  return bars.slice(index - left * multiplier, index + right * multiplier + 1).every((bar, offset) =>
    offset === left * multiplier || (field === 'high' ? bar.high < point.price : bar.low > point.price));
}

function uniqueExtreme(bars, first, last, point) {
  const field = point.type === 'HIGH' ? 'high' : 'low';
  return bars.filter(bar => bar.openTime >= first.time && bar.openTime <= last.time).every(bar =>
    bar.openTime === point.time ? bar[field] === point.price : (field === 'high' ? bar[field] < point.price : bar[field] > point.price));
}
const priceOrder = ({ A, B, C, D }, direction) => direction === 1
  ? A.price < C.price && C.price < B.price && B.price < D.price
  : A.price > C.price && C.price > B.price && B.price > D.price;
const lineAt = (a, c, at) => a.price + (c.price - a.price) * (at - a.time) / (c.time - a.time);
const lineFor = (a, c) => ({ anchorTime: a.time / M15, anchorPrice: a.price,
  slope: (c.price - a.price) / ((c.time - a.time) / M15), intercept: a.price - (c.price - a.price) * a.time / (c.time - a.time) });
const anchorCore = point => ({ type: point.type, time: point.time, price: point.price, confirmedAt: point.confirmedAt,
  hierarchyMultiplier: point.hierarchyMultiplier ?? 1, prominenceAbsolute: point.prominenceAbsolute });
const planIdentity = (symbol, pattern, anchors, D) => `s2z1_${hash({ symbol, pattern,
  anchors: anchors.map(p => [p.type, p.time, p.price]), D: [D.time, D.price] }).slice(0, 24)}`;
function geometry(plan) {
  const s = plan.zStructure;
  return { revision: plan.structureRevision, symbol: plan.symbol, pattern: plan.pattern,
    anchors: plan.anchors?.map(anchorCore), z: { direction: s.z.direction,
      points: Object.fromEntries(Object.entries(s.z.points).map(([key, point]) => [key, anchorCore(point)])) },
    hourly: { direction: s.hourly.direction, intervening: anchorCore(s.hourly.intervening) },
    policies: s.policies, tolerances: s.tolerances, fourHourLine: plan.fourHourLine, oneHourLine: plan.oneHourLine,
    intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice, lockedBarOpenTime: plan.lockedBarOpenTime };
}
function proofHash(s) {
  return hash({ geometryHash: s.geometryHash, discoveredAt: s.discoveredAt, referenceBar: s.referenceBar,
    source: s.source, continuation: s.continuation });
}

// Native bar envelopes are checked only while the two lines still converge.
// An interval containing Px cannot establish whether a wick crossed before Px.
function lineViolation(bars, a, c, direction, tolerance, cutoff) {
  return bars.find(bar => bar.openTime > c.time && bar.closeTime < cutoff &&
    (direction === 1 ? bar.low < lineAt(a, c, bar.openTime) - tolerance : bar.high > lineAt(a, c, bar.openTime) + tolerance));
}
function crossFor(a, c, b, d) {
  const slope1 = (c.price - a.price) / (c.time - a.time), slope2 = (d.price - b.price) / (d.time - b.time);
  const crossTime = a.time + (lineAt(b, d, a.time) - a.price) / (slope1 - slope2);
  return { time: crossTime, price: lineAt(a, c, crossTime), slopeDifference: Math.abs((slope1 - slope2) * M15) };
}

function validate(plan, { now, bars15m, bars1h } = {}) {
  if (plan?.structureRevision !== S2_Z_STRUCTURE_REVISION || plan?.zStructure?.revision !== S2_Z_STRUCTURE_REVISION)
    return result('INVALID', 'S2_Z_STRUCTURE_REQUIRED');
  const s = plan.zStructure;
  if (!time(now) || !time(s.discoveredAt) || now < s.discoveredAt) return result('WAIT', 'S2_Z_CLOCK_INVALID');
  if (s.schemaVersion !== 1 || ![1, -1].includes(s.z?.direction) || s.hourly?.direction !== -s.z.direction ||
    s.z.interval !== '15m' || s.hourly.interval !== '1h' || plan.createdAt !== s.discoveredAt ||
    !s.policies?.fifteenMinute || !s.policies?.hourly || !s.source || !s.continuation ||
    !Array.isArray(plan.anchors) || plan.anchors.length !== 4 || !positive(plan.intersectionTime) || !positive(plan.intersectionPrice) ||
    !(plan.intersectionTime > s.discoveredAt) || hash(s.policies) !== S2_Z_GEOMETRY_POLICY_HASH ||
    s.geometryHash !== hash(geometry(plan)) || s.evidenceHash !== proofHash(s))
    return result('INVALID', 'S2_Z_PROOF_INTEGRITY');
  const initial15 = barsOf(s.source.bars15m, M15, s.discoveredAt, { latest: true });
  const initial1h = barsOf(s.source.bars1h, H1, s.discoveredAt, { latest: true });
  if (!initial15 || !initial1h) return result('INVALID', 'S2_Z_DISCOVERY_BARS_INVALID');
  const points = s.z.points, zDirection = s.z.direction;
  if (!points || !['A', 'B', 'C', 'D'].every(key => pointValid(points[key], initial15, s.policies.fifteenMinute, s.discoveredAt)))
    return result('INVALID', 'S2_Z_POINT_CONFIRMATION_INVALID');
  const { A, B, C, D } = points;
  if (plan.pattern !== (zDirection === 1 ? '1H_DESC_HIGH__15M_ASC_LOW' : '1H_ASC_LOW__15M_DESC_HIGH') ||
    plan.id !== planIdentity(plan.symbol, plan.pattern, plan.anchors, D)) return result('INVALID', 'S2_Z_IDENTITY_INVALID');
  if ([A, C].some(p => p.type !== (zDirection === 1 ? 'LOW' : 'HIGH')) || [B, D].some(p => p.type !== (zDirection === 1 ? 'HIGH' : 'LOW')) ||
    !(A.time < B.time && B.time < C.time && C.time < D.time) || !priceOrder(points, zDirection) ||
    !uniqueExtreme(initial15, A, B, A) || !uniqueExtreme(initial15, A, C, B) ||
    !uniqueExtreme(initial15, B, D, C) || !uniqueExtreme(initial15, C, D, D) ||
    s.z.confirmedAt !== Math.max(...Object.values(points).map(point => point.confirmedAt))) return result('INVALID', 'S2_Z_LEGS_INVALID');
  const [first, second, shortA, shortC] = plan.anchors;
  if (JSON.stringify(anchorCore(A)) !== JSON.stringify(anchorCore(shortA)) || JSON.stringify(anchorCore(C)) !== JSON.stringify(anchorCore(shortC)) ||
    ![first, second, s.hourly.intervening].every(point => pointValid(point, initial1h, s.policies.hourly, s.discoveredAt)) ||
    !(first.time < s.hourly.intervening.time && s.hourly.intervening.time < second.time) ||
    Math.sign(second.price - first.price) !== s.hourly.direction ||
    first.type !== (s.hourly.direction === 1 ? 'LOW' : 'HIGH') || second.type !== first.type || s.hourly.intervening.type === first.type)
    return result('INVALID', 'S2_Z_ANCHOR_BINDING_INVALID');
  const selectedShort = structuralPairs([A, C], [B], initial15, zDirection, s.policies.fifteenMinute);
  const selectedHourly = structuralPairs([first, second], [s.hourly.intervening], initial1h, s.hourly.direction, s.policies.hourly);
  const toleranceFor = (bars, policy) => { const visible = bars.slice(-policy.searchWindowBars);
    return (Math.max(...visible.map(b => b.high)) - Math.min(...visible.map(b => b.low))) * (policy.maximumIntermediateViolationFractionOfVisibleRange ?? 0); };
  if (selectedShort.length !== 1 || selectedHourly.length !== 1 ||
    !near(s.tolerances.fifteenMinute, toleranceFor(initial15, s.policies.fifteenMinute)) ||
    !near(s.tolerances.hourly, toleranceFor(initial1h, s.policies.hourly))) return result('INVALID', 'S2_Z_PAIR_QUALITY_INVALID');
  const cross = crossFor(first, second, A, C);
  if (!near(cross.time, plan.intersectionTime) || !near(cross.price, plan.intersectionPrice) ||
    plan.lockedBarOpenTime !== Math.floor(plan.intersectionTime / M5) * M5 ||
    !['anchorTime', 'anchorPrice', 'slope', 'intercept'].every(key => near(plan.fourHourLine?.[key], lineFor(first, second)[key]) &&
      near(plan.oneHourLine?.[key], lineFor(A, C)[key])))
    return result('INVALID', 'S2_Z_INTERSECTION_INVALID');
  const reference = barsOf([s.referenceBar], M5, s.discoveredAt, { latest: true })?.[0];
  const lower = zDirection === 1 ? lineAt(A, C, s.discoveredAt) : lineAt(first, second, s.discoveredAt);
  const upper = zDirection === 1 ? lineAt(first, second, s.discoveredAt) : lineAt(A, C, s.discoveredAt);
  if (!reference || reference.close < lower || reference.close > upper) return result('INVALID', 'S2_Z_DISCOVERY_OUTSIDE_CONVERGENCE');
  const cutoff = Math.min(now, plan.intersectionTime);
  const merged15 = mergedBars(s.source.bars15m, s.continuation.bars15m, bars15m, M15, now, cutoff);
  const merged1h = mergedBars(s.source.bars1h, s.continuation.bars1h, bars1h, H1, now, cutoff);
  if (!merged15 || !merged1h) return result('WAIT', 'S2_Z_NATIVE_EVIDENCE_GAP_OR_CONFLICT');
  const violation15 = lineViolation(merged15, A, C, zDirection, s.tolerances.fifteenMinute, cutoff);
  const violation1h = lineViolation(merged1h, first, second, s.hourly.direction, s.tolerances.hourly, cutoff);
  const keyC = merged15.find(bar => bar.openTime > D.time && bar.closeTime < cutoff &&
    (zDirection === 1 ? bar.low < C.price : bar.high > C.price));
  const evidence = { revision: S2_Z_STRUCTURE_REVISION, geometryHash: s.geometryHash, checkedAt: now,
    cutoffExclusive: cutoff, bars15mThrough: merged15.filter(bar => bar.closeTime < cutoff).at(-1)?.closeTime ?? null,
    bars1hThrough: merged1h.filter(bar => bar.closeTime < cutoff).at(-1)?.closeTime ?? null,
    intersectionContainingBarExcluded: true, zDirectionIsOrderDirection: false };
  if (violation15 || violation1h || keyC) return { ...result('INVALID', keyC ? 'S2_Z_KEY_C_BROKEN_BEFORE_PX'
    : violation1h ? 'S2_Z_1H_LINE_BROKEN_BEFORE_PX' : 'S2_Z_15M_LINE_BROKEN_BEFORE_PX',
  { ...evidence, invalidatedBarOpenTime: (keyC ?? violation1h ?? violation15).openTime }), merged15, merged1h };
  return { ...result('VALID', 'S2_Z_STRUCTURE_CONFIRMED', evidence), merged15, merged1h };
}

export function validateS2ZPlanEvidence(plan, input = {}) {
  try { const { merged15, merged1h, ...verdict } = validate(plan, input); return verdict; }
  catch { return result('INVALID', 'S2_Z_PROOF_MALFORMED'); }
}

export function refreshS2ZPlanEvidence(plan, input = {}) {
  let verdict;
  try { verdict = validate(plan, input); } catch { verdict = result('INVALID', 'S2_Z_PROOF_MALFORMED'); }
  const updated = structuredClone(plan);
  updated.structureValidation = Object.fromEntries(Object.entries(verdict).filter(([key]) => !['merged15', 'merged1h'].includes(key)));
  // Both VALID and these terminal market violations have passed native bar
  // continuity/conflict checks. Preserve their causal pre-Px evidence so the
  // archive can reproduce the verdict. Earlier malformed/geometry failures
  // and WAIT do not carry verified merges and must not alter frozen proof.
  if (verdict.merged15 && verdict.merged1h) {
    const s = updated.zStructure, cutoff = Math.min(input.now, updated.intersectionTime);
    s.continuation = {
      bars15m: verdict.merged15.filter(bar => bar.openTime > s.source.bars15m.at(-1)[0] && bar.closeTime < cutoff).map(tuple),
      bars1h: verdict.merged1h.filter(bar => bar.openTime > s.source.bars1h.at(-1)[0] && bar.closeTime < cutoff).map(tuple),
    };
    s.evidenceHash = proofHash(s);
  }
  return updated;
}

export function discoverS2ZPlans({ symbol, bars5m, bars15m, bars1h, now, strategy } = {}) {
  if (strategy?.structureRevision !== S2_Z_STRUCTURE_REVISION || !time(now) || typeof symbol !== 'string') return [];
  const b5 = barsOf(bars5m, M5, now, { latest: true }), b15 = barsOf(bars15m, M15, now, { latest: true }), b1 = barsOf(bars1h, H1, now, { latest: true });
  if (!b5 || !b15 || !b1) return [];
  const shortPolicy = strategy.pivots.oneHour, hourlyPolicy = strategy.pivots.fourHour;
  const high15 = structuralPivots(b15, 'HIGH', shortPolicy), low15 = structuralPivots(b15, 'LOW', shortPolicy);
  const high1 = structuralPivots(b1, 'HIGH', hourlyPolicy), low1 = structuralPivots(b1, 'LOW', hourlyPolicy);
  const range = (bars, policy) => { const visible = bars.slice(-policy.searchWindowBars); return Math.max(...visible.map(b => b.high)) - Math.min(...visible.map(b => b.low)); };
  const tolerances = { fifteenMinute: range(b15, shortPolicy) * (shortPolicy.maximumIntermediateViolationFractionOfVisibleRange ?? 0),
    hourly: range(b1, hourlyPolicy) * (hourlyPolicy.maximumIntermediateViolationFractionOfVisibleRange ?? 0) };
  const zs = [];
  for (const direction of [1, -1]) {
    const anchors = direction === 1 ? low15 : high15, opposites = direction === 1 ? high15 : low15;
    for (const pair of structuralPairs(anchors, opposites, b15, direction, shortPolicy)) {
      const A = pair.first, C = pair.second;
      if (lineViolation(b15, A, C, direction, tolerances.fifteenMinute, now)) continue;
      const B = opposites.find(point => point.time > A.time && point.time < C.time && uniqueExtreme(b15, A, C, point));
      if (!B || !uniqueExtreme(b15, A, B, A)) continue;
      for (const D of [...opposites].reverse()) {
        if (D.time <= C.time || !priceOrder({ A, B, C, D }, direction) || !uniqueExtreme(b15, B, D, C) || !uniqueExtreme(b15, C, D, D)) continue;
        const confirmedAt = Math.max(A.confirmedAt, B.confirmedAt, C.confirmedAt, D.confirmedAt);
        if (confirmedAt >= now) continue;
        zs.push({ direction, pair, points: { A, B, C, D }, confirmedAt }); break;
      }
    }
  }
  zs.sort((a, b) => b.points.D.time - a.points.D.time || b.confirmedAt - a.confirmedAt || b.points.C.time - a.points.C.time ||
    b.pair.qualityScore - a.pair.qualityScore || b.points.A.time - a.points.A.time || b.direction - a.direction);
  const z = zs[0];
  if (!z) return [];
  const direction = -z.direction, hourlyAnchors = direction === 1 ? low1 : high1, hourlyOpposites = direction === 1 ? high1 : low1;
  const plans = [];
  // No old active/previous lineage or top-N pair pruning: every qualified 1H
  // pair for the selected current Z is a distinct prospective Px candidate.
  for (const hourly of structuralPairs(hourlyAnchors, hourlyOpposites, b1, direction, hourlyPolicy)) {
    if (lineViolation(b1, hourly.first, hourly.second, direction, tolerances.hourly, now)) continue;
    const cross = crossFor(hourly.first, hourly.second, z.points.A, z.points.C);
    if (!positive(cross.time) || !Number.isFinite(new Date(cross.time).getTime()) || !positive(cross.price) || cross.time <= now || cross.slopeDifference < strategy.intersection.minimumSlopeDifferencePer15m) continue;
    if (Number.isFinite(strategy.intersection.minimumDiscoveryLeadHours) && cross.time < now + strategy.intersection.minimumDiscoveryLeadHours * H1) continue;
    if (Number.isFinite(strategy.intersection.maximumLeadHours) && cross.time > now + strategy.intersection.maximumLeadHours * H1) continue;
    const locked = Math.floor(cross.time / M5) * M5;
    if (Math.min(cross.time - locked, locked + M5 - cross.time) < strategy.intersection.ambiguousBoundaryMs) continue;
    const anchors = [hourly.first, hourly.second, z.points.A, z.points.C];
    const pattern = direction === -1 ? '1H_DESC_HIGH__15M_ASC_LOW' : '1H_ASC_LOW__15M_DESC_HIGH';
    const plan = { id: planIdentity(symbol, pattern, anchors, z.points.D),
      version: 1, symbol, pattern, createdAt: now, firstDiscoveredAt: now, latestConfirmation: Math.max(z.confirmedAt, hourly.first.confirmedAt, hourly.second.confirmedAt),
      intersectionCoordinate15m: cross.time / M15, intersectionTime: cross.time, intersectionPrice: cross.price, lockedBarOpenTime: locked,
      commitAt: cross.time - Number(strategy.intersection.commitmentLeadHours ?? 0) * H1,
      committed: now >= cross.time - Number(strategy.intersection.commitmentLeadHours ?? 0) * H1, frozen: false,
      implementationRevisionAtDiscovery: strategy.implementationRevision, structureRevision: S2_Z_STRUCTURE_REVISION,
      selectionObjective: 'CURRENT_15M_CONFIRMED_Z_THEN_ALL_VALID_1H_PAIRS', primaryLineStatus: 'CURRENT_Z_HISTORICAL_1H', fourHourLineStatus: 'CURRENT_Z_HISTORICAL_1H',
      timeframeContract: { primaryStructure: '1h', opposingStructure: '15m', entryDecision: '5m' },
      anchorQualityScore: (z.pair.qualityScore + hourly.qualityScore) / 2, anchors,
      scale: { fourHourSpan15m: hourly.span15m, oneHourSpan15m: z.pair.span15m,
        fourHourAnchorProminenceFraction: hourly.anchorProminenceFraction, oneHourAnchorProminenceFraction: z.pair.anchorProminenceFraction,
        fourHourPairMoveFraction: hourly.pairMoveFraction, oneHourPairMoveFraction: z.pair.pairMoveFraction,
        fourHourHierarchyMultiplier: hourly.hierarchyMultiplier, oneHourHierarchyMultiplier: z.pair.hierarchyMultiplier, importance: hourly.importance + z.pair.importance },
      fourHourLine: lineFor(hourly.first, hourly.second), oneHourLine: lineFor(z.points.A, z.points.C),
      zStructure: { schemaVersion: 1, revision: S2_Z_STRUCTURE_REVISION, discoveredAt: now,
        z: { interval: '15m', direction: z.direction, points: z.points, confirmedAt: z.confirmedAt },
        hourly: { interval: '1h', direction, intervening: hourlyOpposites.find(p => p.time > hourly.first.time && p.time < hourly.second.time) },
        policies: { fifteenMinute: structuredClone(shortPolicy), hourly: structuredClone(hourlyPolicy), intersection: structuredClone(strategy.intersection) },
        tolerances, referenceBar: tuple(b5.at(-1)), source: { format: 'NATIVE_CLOSED_OHLC_TUPLES_T_O_H_L_C', bars15m: b15.map(tuple), bars1h: b1.map(tuple) },
        continuation: { bars15m: [], bars1h: [] } } };
    plan.zStructure.geometryHash = hash(geometry(plan)); plan.zStructure.evidenceHash = proofHash(plan.zStructure);
    const checked = refreshS2ZPlanEvidence(plan, { now, bars15m: b15, bars1h: b1 });
    if (checked.structureValidation.allowed) plans.push(checked);
  }
  return plans.sort((a, b) => a.intersectionTime - b.intersectionTime || b.anchorQualityScore - a.anchorQualityScore || a.id.localeCompare(b.id));
}
