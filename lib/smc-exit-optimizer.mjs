import { pairedSmcStructureZones } from './smc-owner-direction.mjs';
import { normalizePriceByPurpose } from './smc-price-input.mjs';

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

function validExitPrice(direction, price, entry, market, tick) {
  if (![price, entry, market, tick].every(finitePositive)) return false;
  return direction === 'LONG'
    ? price > Math.max(entry, market) + tick
    : price < Math.min(entry, market) - tick;
}

function metrics(position, market, target, estimatedExitFeeRate = 0.0005) {
  const sign = position.direction === 'LONG' ? 1 : -1;
  const distancePercent = sign * (target - market) / market * 100;
  const rewardPerUnit = sign * (target - position.entry);
  const riskPerUnit = sign * (position.entry - position.stop);
  const quantity = Number(position.quantity);
  const grossRewardUsdt = finitePositive(quantity) ? rewardPerUnit * quantity : null;
  const estimatedExitFeeUsdt = finitePositive(quantity) ? target * quantity * estimatedExitFeeRate : null;
  const netRewardUsdt = grossRewardUsdt == null || estimatedExitFeeUsdt == null
    ? null : grossRewardUsdt - estimatedExitFeeUsdt;
  const recordedRiskUsdt = Number(position.initialRiskUsdt);
  const costAdjustedR = finitePositive(recordedRiskUsdt) && Number.isFinite(netRewardUsdt)
    ? netRewardUsdt / recordedRiskUsdt
    : riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : null;
  return {
    distancePercent: Number(distancePercent.toFixed(4)),
    rewardFromEntryPercent: Number((rewardPerUnit / position.entry * 100).toFixed(4)),
    currentStopR: costAdjustedR == null ? null : Number(costAdjustedR.toFixed(2)),
    grossRewardUsdt: grossRewardUsdt == null ? null : Number(grossRewardUsdt.toFixed(4)),
    estimatedExitFeeUsdt: estimatedExitFeeUsdt == null ? null : Number(estimatedExitFeeUsdt.toFixed(4)),
    netRewardUsdt: netRewardUsdt == null ? null : Number(netRewardUsdt.toFixed(4)),
    rBasis: finitePositive(recordedRiskUsdt) ? 'RECORDED_INITIAL_RISK_AND_ESTIMATED_EXIT_FEE' : 'PRICE_DISTANCE_FALLBACK',
    protectionState: riskPerUnit > 0 ? 'RISK_OPEN' : 'PROFIT_LOCKED',
  };
}

function currentTargetCandidate(position, market, tickSize) {
  const normalized = normalizePriceByPurpose(position.target, tickSize, position.direction, 'TARGET');
  const target = Number(normalized);
  if (!validExitPrice(position.direction, target, position.entry, market, Number(tickSize))) return null;
  return {
    target,
    kind: position.targetSource === 'STRUCTURE_PLAN' ? 'CURRENT_STRUCTURE_TARGET' : 'CURRENT_OWNER_TARGET',
    label: position.targetSource === 'STRUCTURE_PLAN' ? '当前结构目标' : '当前手动目标',
    // A source label is not fresh market evidence. Confidence can only come
    // from a currently valid, causally paired barrier below.
    confidence: 'REFERENCE_ONLY',
    changeRequired: false,
    grade: null,
    eventType: null,
    zone: null,
    touches: null,
    ageDays: null,
    ...metrics(position, market, target),
  };
}

function pairedBarrierCandidates(position, market, result, tickSize) {
  const tick = Number(tickSize);
  if (!finitePositive(tick)) return [];
  const barrierDirection = position.direction === 'LONG' ? 'SHORT' : 'LONG';
  return pairedSmcStructureZones(result, barrierDirection).flatMap(({ structure, zone }) => {
    if (Number(zone.touches ?? 0) > 1) return [];
    const raw = position.direction === 'LONG' ? Number(zone.low) - 2 * tick : Number(zone.high) + 2 * tick;
    const normalized = normalizePriceByPurpose(raw, tickSize, position.direction, 'TARGET');
    const target = Number(normalized);
    if (!validExitPrice(position.direction, target, position.entry, market, tick)) return [];
    const confidence = structure.grade === 'A' && Number(zone.touches ?? 0) === 0 ? 'HIGH' : 'MEDIUM';
    return [{
      target,
      kind: 'OPPOSING_4H_FVG_FRONT',
      label: `${structure.grade}级 ${structure.eventType} · 对向4H FVG前沿`,
      confidence,
      grade: structure.grade,
      eventType: structure.eventType,
      structureId: structure.id,
      zone: { low: Number(zone.low), high: Number(zone.high), ce: Number(zone.ce) },
      touches: Number(zone.touches ?? 0),
      ageDays: Number(zone.ageDays ?? 0),
      frontRunTicks: 2,
      changeRequired: true,
      ...metrics(position, market, target),
    }];
  });
}

function currentTargetFrontRunsBarrier(direction, current, barrier, tick) {
  if (!current || !barrier) return false;
  return direction === 'LONG'
    ? current.target <= barrier.target + tick / 2
    : current.target >= barrier.target - tick / 2;
}

/**
 * Read-only exit target optimizer for an already-open SMC position.
 * It uses a fresh executable-side BBO and only causally paired A/B 4H
 * structure/FVG barriers. It never places or mutates an order itself.
 */
export function optimizeSmcPositionExit({ position, quote, scanResult, tickSize, now = Date.now(), quoteStaleMs = 10000 }) {
  if (!position || !['LONG', 'SHORT'].includes(position.direction) || !finitePositive(position.entry)
    || !finitePositive(position.stop) || !finitePositive(position.quantity))
    return { status: 'POSITION_INVALID', recommendation: null, alternatives: [] };
  if (!finitePositive(tickSize)) return { status: 'PRICE_PRECISION_UNAVAILABLE', recommendation: null, alternatives: [] };
  const quoteAt = Number(quote?.quoteAt);
  if (!Number.isSafeInteger(quoteAt) || quoteAt > now + 5000 || now - quoteAt > quoteStaleMs)
    return { status: 'QUOTE_STALE', recommendation: null, alternatives: [] };
  const market = position.direction === 'LONG' ? Number(quote?.bid) : Number(quote?.ask);
  if (!finitePositive(market)) return { status: 'QUOTE_INVALID', recommendation: null, alternatives: [] };

  const structural = pairedBarrierCandidates(position, market, scanResult, tickSize)
    .sort((a, b) => a.distancePercent - b.distancePercent
      || Number(b.confidence === 'HIGH') - Number(a.confidence === 'HIGH')
      || a.target - b.target);
  const current = currentTargetCandidate(position, market, tickSize);
  const barrier = structural[0] ?? null;
  let recommendation = barrier;
  if (currentTargetFrontRunsBarrier(position.direction, current, barrier, Number(tickSize))) {
    recommendation = {
      ...current,
      kind: 'CURRENT_TARGET_ALREADY_PROTECTED',
      label: `当前止盈已提前于${barrier.grade}级 ${barrier.eventType} 结构区`,
      confidence: barrier.confidence,
      changeRequired: false,
      referenceTarget: barrier.target,
      structureId: barrier.structureId,
      grade: barrier.grade,
      eventType: barrier.eventType,
      zone: barrier.zone,
      touches: barrier.touches,
      ageDays: barrier.ageDays,
      frontRunTicks: barrier.frontRunTicks,
      leadDistance: Number(Math.abs(barrier.target - current.target).toFixed(8)),
    };
  }
  const alternatives = [
    ...structural.filter(row => row !== barrier),
    ...(barrier && recommendation !== barrier ? [barrier] : []),
    ...(current && recommendation !== current && recommendation?.kind !== 'CURRENT_TARGET_ALREADY_PROTECTED' ? [current] : []),
  ];
  return {
    status: recommendation ? 'READY' : 'NO_STRUCTURAL_EXIT',
    market,
    quoteAt,
    recommendation,
    alternatives: alternatives.slice(0, 3),
    policy: {
      quoteSide: position.direction === 'LONG' ? 'BID' : 'ASK',
      pairedStructureOnly: true,
      maximumMitigationEpisodes: 1,
      frontRunTicks: 2,
      estimatedExitFeeRate: 0.0005,
      confidenceRequiresFreshPairedBarrier: true,
      mutationAuthority: false,
    },
  };
}
