import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLine, deterministicId, readJson, writeJsonAtomic } from "./runtime-utils.mjs";
import { expandPaperPositionStateRecords } from "./position-state-records.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx");
export const FACTOR_PATHS = Object.freeze({
  state: path.join(RUNTIME_ROOT, "state.json"),
  ledger: path.join(RUNTIME_ROOT, "ledger.ndjson"),
  strategy: path.join(PROJECT_ROOT, "experiments/v2-mtf-trendline-intersection/config.json"),
  observations: path.join(RUNTIME_ROOT, "research/factor-observations.ndjson"),
  minerState: path.join(RUNTIME_ROOT, "research/factor-miner-state.json"),
});

const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const PROTECTIVE_STRUCTURE_FUNNEL_EVENT_TYPES = new Set([
  "MTFX_PRICE_CONFIRMATION_LOCKED",
  "MTFX_PROTECTIVE_STRUCTURE_WAITING",
  "MTFX_PROTECTIVE_STRUCTURE_READY",
  "MTFX_SIGNAL_WAITING_FOR_CAPACITY",
  "MTFX_SIGNAL_WAITING_FOR_BBO_COVERAGE",
  "MTFX_PROTECTIVE_ENTRY_WAITING_FOR_PRICE",
  "MTFX_PROTECTIVE_STRUCTURE_EXPIRED",
  "MTFX_PROTECTIVE_ENTRY_WINDOW_EXPIRED",
  "MTFX_PAPER_ENTRY_REJECTED",
  "PAPER_POSITION_OPENED",
]);
const NON_ENTRY_TERMINAL_EVENT_TYPES = new Set([
  "MTFX_CONFIRMATION_RESERVE_EXPIRED",
  "MTFX_PAPER_ENTRY_REJECTED",
  "MTFX_SIGNAL_EXPIRED",
  "MTFX_LOOKAHEAD_GUARD_REJECTED",
  "MTFX_PROTECTIVE_STRUCTURE_EXPIRED",
  "MTFX_PROTECTIVE_ENTRY_WINDOW_EXPIRED",
]);
const NON_ENTRY_OUTCOME_HORIZONS_HOURS = Object.freeze([6, 24]);
const OHLC_CROSS_TRIGGER_OUTCOME_HORIZONS_HOURS = Object.freeze([6, 24]);
const OHLC_CROSS_TRIGGER_PROSPECTIVE_START = Date.parse("2026-08-12T18:37:00Z");
const R12_PORTFOLIO_TELEMETRY_PROSPECTIVE_START = Date.parse("2026-08-13T16:24:59Z");
const R12_PORTFOLIO_LOOKBACK_BARS_15M = 96;
const R12_PORTFOLIO_MINIMUM_RETURN_PAIRS = 48;
const R12_HIGH_CORRELATION_THRESHOLD = 0.7;
const R12_POST_ENTRY_RELATIVE_PATH_HORIZONS_HOURS = Object.freeze([6, 24]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : null;
}

function bps(value, reference) {
  const result = ratio(value, reference);
  return result === null ? null : result * 10_000;
}

function directionFromComparison(value, intersectionPrice) {
  return value > intersectionPrice ? 1 : value < intersectionPrice ? -1 : 0;
}

function positionNotionalUsdt(position) {
  const entry = finite(position?.entry);
  const quantity = finite(position?.quantity);
  return entry === null || quantity === null ? null : Math.abs(entry * quantity);
}

function stableLedgerOrder(first, second) {
  const firstSequence = finite(first?.sequence);
  const secondSequence = finite(second?.sequence);
  if (firstSequence !== null && secondSequence !== null && firstSequence !== secondSequence) return firstSequence - secondSequence;
  return Number(first?.marketTime ?? 0) - Number(second?.marketTime ?? 0);
}

function isR12Position(position) {
  return String(position?.implementationRevision ?? "").includes("R12-TWO-BAR-CROSS-CLOSE-BUFFER-STOP");
}

export function displacementRiskBucket(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 0.25) return "UNDER_0_25R";
  if (value < 0.5) return "R0_25_TO_UNDER_0_5";
  if (value < 0.75) return "R0_5_TO_UNDER_0_75";
  if (value < 1) return "R0_75_TO_UNDER_1";
  return "ONE_R_OR_MORE";
}

export function rollingReturnRelationship(assetBars, referenceBars) {
  const assetByOpenTime = new Map((assetBars ?? []).map((bar) => [finite(bar?.openTime), finite(bar?.close)]).filter(([time, close]) => time !== null && close !== null && close > 0));
  const aligned = (referenceBars ?? [])
    .map((bar) => ({ openTime: finite(bar?.openTime), referenceClose: finite(bar?.close), assetClose: assetByOpenTime.get(finite(bar?.openTime)) }))
    .filter((row) => row.openTime !== null && row.referenceClose !== null && row.referenceClose > 0 && row.assetClose !== null && row.assetClose > 0)
    .sort((first, second) => first.openTime - second.openTime);
  const pairs = [];
  for (let index = 1; index < aligned.length; index += 1) {
    const previous = aligned[index - 1];
    const current = aligned[index];
    const assetReturn = current.assetClose / previous.assetClose - 1;
    const referenceReturn = current.referenceClose / previous.referenceClose - 1;
    if (Number.isFinite(assetReturn) && Number.isFinite(referenceReturn)) pairs.push({ assetReturn, referenceReturn });
  }
  if (pairs.length < 2) return { returnPairs: pairs.length, correlation: null, beta: null };
  const meanAsset = pairs.reduce((sum, item) => sum + item.assetReturn, 0) / pairs.length;
  const meanReference = pairs.reduce((sum, item) => sum + item.referenceReturn, 0) / pairs.length;
  let covariance = 0;
  let assetVariance = 0;
  let referenceVariance = 0;
  for (const item of pairs) {
    const assetDelta = item.assetReturn - meanAsset;
    const referenceDelta = item.referenceReturn - meanReference;
    covariance += assetDelta * referenceDelta;
    assetVariance += assetDelta ** 2;
    referenceVariance += referenceDelta ** 2;
  }
  return {
    returnPairs: pairs.length,
    correlation: assetVariance > 0 && referenceVariance > 0 ? covariance / Math.sqrt(assetVariance * referenceVariance) : null,
    beta: referenceVariance > 0 ? covariance / referenceVariance : null,
  };
}

export function activePositionsAtEntryEvents(ledger) {
  const activeById = new Map();
  const snapshots = new Map();
  for (const record of expandPaperPositionStateRecords(ledger ?? []).sort(stableLedgerOrder)) {
    const payload = record?.payload ?? {};
    if (record?.type === "PAPER_POSITION_OPENED" && payload?.id) {
      activeById.set(payload.id, payload);
      snapshots.set(record.eventId, [...activeById.values()].map((position) => ({ ...position })));
      continue;
    }
    if (record?.type === "PAPER_POSITION_STATE_COMMITTED" && payload?.closed === true && payload?.position?.status === "CLOSED" && payload?.positionId === payload?.position?.id) {
      activeById.delete(payload.positionId);
    }
  }
  return snapshots;
}

function weightedBetaExposure(positions, relationshipsBySymbol, referenceKey) {
  let coveredNotional = 0;
  let weightedNetNotional = 0;
  let weightedGrossNotional = 0;
  for (const position of positions) {
    const notional = positionNotionalUsdt(position);
    const relationship = relationshipsBySymbol.get(position.symbol)?.[referenceKey] ?? null;
    const beta = finite(relationship?.beta);
    const pairs = finite(relationship?.returnPairs);
    if (notional === null || beta === null || pairs === null || pairs < R12_PORTFOLIO_MINIMUM_RETURN_PAIRS) continue;
    const signed = finite(position.direction) * notional * beta;
    if (!Number.isFinite(signed)) continue;
    coveredNotional += notional;
    weightedNetNotional += signed;
    weightedGrossNotional += Math.abs(signed);
  }
  return { coveredNotional, weightedNetNotional, weightedGrossNotional };
}

export function buildR12PortfolioExposureObservation(record, activePositions, relationshipsBySymbol = new Map()) {
  const position = record?.payload ?? {};
  if (!isR12Position(position) || !record?.eventId) return null;
  const positions = (activePositions ?? []).filter((item) => finite(item?.direction) !== null && positionNotionalUsdt(item) !== null);
  const entry = finite(position.entry);
  const stop = finite(position.initialStop);
  const cross = finite(position.intersectionPrice);
  const priceRisk = entry === null || stop === null ? null : Math.abs(entry - stop);
  const displacementRisk = entry === null || cross === null || priceRisk === null ? null : ratio(Math.abs(entry - cross), priceRisk);
  const grossLong = positions.filter((item) => finite(item.direction) > 0).reduce((sum, item) => sum + positionNotionalUsdt(item), 0);
  const grossShort = positions.filter((item) => finite(item.direction) < 0).reduce((sum, item) => sum + positionNotionalUsdt(item), 0);
  const gross = grossLong + grossShort;
  const net = grossLong - grossShort;
  const sameSymbol = positions.filter((item) => item.symbol === position.symbol);
  const relation = relationshipsBySymbol.get(position.symbol) ?? {};
  const peers = positions.filter((item) => item.id !== position.id).map((item) => ({
    position: item,
    relationship: relation.peers?.get(item.symbol) ?? null,
  }));
  const highCorrelation = peers.filter(({ relationship }) => finite(relationship?.returnPairs) >= R12_PORTFOLIO_MINIMUM_RETURN_PAIRS && finite(relationship?.correlation) !== null && finite(relationship.correlation) >= R12_HIGH_CORRELATION_THRESHOLD);
  const highCorrelationSameSide = highCorrelation.filter(({ position: peer }) => finite(peer.direction) === finite(position.direction));
  const highCorrelationOppositeSide = highCorrelation.filter(({ position: peer }) => finite(peer.direction) === -finite(position.direction));
  const btcBeta = weightedBetaExposure(positions, relationshipsBySymbol, "btc");
  const ethBeta = weightedBetaExposure(positions, relationshipsBySymbol, "eth");
  return {
    schemaVersion: 1,
    observationType: "R12_PORTFOLIO_EXPOSURE_FACTOR_SNAPSHOT",
    observationId: deterministicId("factor_r12_portfolio_exposure", { eventId: record.eventId }),
    observedAt: Number(record.marketTime),
    symbol: position.symbol,
    planId: position.intersectionId,
    positionId: position.id,
    auditEventId: record.eventId,
    auditSequence: record.sequence ?? null,
    strategyVersion: position.strategyVersion ?? null,
    implementationRevision: position.implementationRevision ?? null,
    factors: {
      entryCrossDisplacementInPriceRisk: displacementRisk,
      entryCrossDisplacementRiskBucket: displacementRiskBucket(displacementRisk),
      activePositionCountAfterEntry: positions.length,
      activeR12PositionCountAfterEntry: positions.filter(isR12Position).length,
      grossLongNotionalUsdt: grossLong,
      grossShortNotionalUsdt: grossShort,
      grossNotionalUsdt: gross,
      netNotionalUsdt: net,
      netToGrossNotionalRatio: ratio(net, gross),
      sameSymbolActivePositionCount: sameSymbol.length,
      sameSymbolGrossNotionalUsdt: sameSymbol.reduce((sum, item) => sum + positionNotionalUsdt(item), 0),
      entryToBtcCorrelation15m: finite(relation.btc?.correlation),
      entryToBtcBeta15m: finite(relation.btc?.beta),
      entryToBtcReturnPairs15m: finite(relation.btc?.returnPairs),
      entryToEthCorrelation15m: finite(relation.eth?.correlation),
      entryToEthBeta15m: finite(relation.eth?.beta),
      entryToEthReturnPairs15m: finite(relation.eth?.returnPairs),
      highCorrelationThreshold: R12_HIGH_CORRELATION_THRESHOLD,
      highCorrelationPeerCount: highCorrelation.length,
      highCorrelationSameSideNotionalUsdt: highCorrelationSameSide.reduce((sum, item) => sum + positionNotionalUsdt(item.position), 0),
      highCorrelationOppositeSideNotionalUsdt: highCorrelationOppositeSide.reduce((sum, item) => sum + positionNotionalUsdt(item.position), 0),
      btcBetaCoveredNotionalUsdt: btcBeta.coveredNotional,
      btcBetaWeightedNetNotionalUsdt: btcBeta.weightedNetNotional,
      btcBetaWeightedGrossNotionalUsdt: btcBeta.weightedGrossNotional,
      ethBetaCoveredNotionalUsdt: ethBeta.coveredNotional,
      ethBetaWeightedNetNotionalUsdt: ethBeta.weightedNetNotional,
      ethBetaWeightedGrossNotionalUsdt: ethBeta.weightedGrossNotional,
    },
    causality: {
      sourceLedgerEventsOnly: true,
      marketRelationshipsEndAtOrBeforeEntry: true,
      futureOutcomeFieldsIncluded: false,
      executionUse: "OBSERVE_ONLY_R12_CROSS_ASSET_TELEMETRY",
    },
    dataQuality: {
      marketData: "BINANCE_USDT_PERPETUAL_FULLY_CLOSED_15M_OHLC",
      correlationLookbackBars15m: R12_PORTFOLIO_LOOKBACK_BARS_15M,
      minimumReturnPairs15m: R12_PORTFOLIO_MINIMUM_RETURN_PAIRS,
      relationshipCoverageSymbols: [...relationshipsBySymbol.keys()].length,
    },
  };
}

export function ohlcCrossTriggerComparison(bar, intersectionPrice, closeBufferBps = 5) {
  const open = finite(bar?.open);
  const high = finite(bar?.high);
  const low = finite(bar?.low);
  const close = finite(bar?.close);
  const cross = finite(intersectionPrice);
  const buffer = finite(closeBufferBps);
  if ([open, high, low, close, cross, buffer].some((value) => value === null) || !(cross > 0) || buffer < 0 || high < low) {
    return null;
  }
  const closeRuleDirection = directionFromComparison(close, cross);
  const bufferedCloseDirection = close >= cross * (1 + buffer / 10_000)
    ? 1 : close <= cross * (1 - buffer / 10_000) ? -1 : 0;
  const wholeBarSideDirection = low > cross ? 1 : high < cross ? -1 : 0;
  const highAboveIntersection = high > cross;
  const lowBelowIntersection = low < cross;
  const extremeTouchDirection = highAboveIntersection === lowBelowIntersection
    ? 0 : highAboveIntersection ? 1 : -1;
  return {
    open,
    high,
    low,
    close,
    intersectionPrice: cross,
    closeBufferBps: buffer,
    closeRuleDirection,
    bufferedCloseDirection,
    wholeBarSideDirection,
    highAboveIntersection,
    lowBelowIntersection,
    extremeTouchDirection,
    extremeSameBarAmbiguous: highAboveIntersection && lowBelowIntersection,
    openFromIntersectionBps: bps(open - cross, cross),
    highFromIntersectionBps: bps(high - cross, cross),
    lowFromIntersectionBps: bps(low - cross, cross),
    closeFromIntersectionBps: bps(close - cross, cross),
  };
}

export function buildOhlcCrossTriggerComparisonObservation(plan, bar, closeBufferBps = 5) {
  const comparison = ohlcCrossTriggerComparison(bar, plan?.intersectionPrice, closeBufferBps);
  const openTime = finite(bar?.openTime);
  const closeTime = finite(bar?.closeTime);
  if (!comparison || !plan?.id || openTime === null || closeTime === null) return null;
  return {
    schemaVersion: 1,
    observationType: "OHLC_CROSS_TRIGGER_COMPARISON",
    observationId: deterministicId("factor_ohlc_cross_trigger", {
      planId: plan.id,
      evaluationBarOpenTime: openTime,
      observationRevision: "R12_OHLC_COMPARATOR_TWO_BAR_V1",
    }),
    observedAt: closeTime + 1,
    symbol: plan.symbol,
    planId: plan.id,
    implementationRevision: plan.implementationRevisionAtDiscovery ?? null,
    evaluation: {
      evaluationBarOpenTime: openTime,
      evaluationBarCloseTime: closeTime,
      intersectionPrice: comparison.intersectionPrice,
    },
    factors: {
      evaluationOpen: comparison.open,
      evaluationHigh: comparison.high,
      evaluationLow: comparison.low,
      evaluationClose: comparison.close,
      closeBufferBps: comparison.closeBufferBps,
      closeRuleDirection: comparison.closeRuleDirection,
      bufferedCloseDirection: comparison.bufferedCloseDirection,
      wholeBarSideDirection: comparison.wholeBarSideDirection,
      highAboveIntersection: comparison.highAboveIntersection ? 1 : 0,
      lowBelowIntersection: comparison.lowBelowIntersection ? 1 : 0,
      extremeTouchDirection: comparison.extremeTouchDirection,
      extremeSameBarAmbiguous: comparison.extremeSameBarAmbiguous ? 1 : 0,
      evaluationOpenFromIntersectionBps: comparison.openFromIntersectionBps,
      evaluationHighFromIntersectionBps: comparison.highFromIntersectionBps,
      evaluationLowFromIntersectionBps: comparison.lowFromIntersectionBps,
      evaluationCloseFromIntersectionBps: comparison.closeFromIntersectionBps,
    },
    dataQuality: {
      source: "BINANCE_USDT_PERPETUAL_CLOSED_15M_OHLC",
      sameBarPathKnown: false,
      counterfactualExecutionModeled: false,
    },
    causality: {
      evaluationBarClosedBeforeObservation: true,
      futureOutcomeFieldsIncluded: false,
      executionUse: "OBSERVE_ONLY_OHLC_CROSS_TRIGGER_COMPARISON",
    },
  };
}

function directionalPostPathLabels(direction, grossUpBps, grossDownBps, closeBps) {
  if (direction !== 1 && direction !== -1) return null;
  return {
    direction,
    favourableExcursionBps: direction === 1 ? grossUpBps : -grossDownBps,
    adverseExcursionBps: direction === 1 ? -grossDownBps : grossUpBps,
    directionalCloseBps: direction === 1 ? closeBps : -closeBps,
  };
}

export function buildOhlcCrossTriggerPostPathOutcomeObservation({ plan, evaluationBar, horizonHours, bars, closeBufferBps = 5 }) {
  const comparison = ohlcCrossTriggerComparison(evaluationBar, plan?.intersectionPrice, closeBufferBps);
  const firstBar = Array.isArray(bars) ? bars[0] : null;
  const basePrice = finite(firstBar?.open);
  const high = firstBar ? Math.max(...bars.map((bar) => finite(bar.high)).filter((value) => value !== null)) : null;
  const low = firstBar ? Math.min(...bars.map((bar) => finite(bar.low)).filter((value) => value !== null)) : null;
  const close = finite(bars?.at(-1)?.close);
  const evaluationBarOpenTime = finite(evaluationBar?.openTime);
  if (!comparison || !plan?.id || basePrice === null || high === null || low === null || close === null || evaluationBarOpenTime === null) return null;
  const expectedBarCount = Math.round(horizonHours * 4);
  if (bars.length !== expectedBarCount) return null;
  const grossUpBps = bps(high - basePrice, basePrice);
  const grossDownBps = bps(low - basePrice, basePrice);
  const closeBps = bps(close - basePrice, basePrice);
  return {
    schemaVersion: 1,
    observationType: "OHLC_CROSS_TRIGGER_POST_PATH_OUTCOME",
    observationId: deterministicId("factor_ohlc_cross_trigger_outcome", {
      planId: plan.id,
      evaluationBarOpenTime,
      horizonHours,
      observationRevision: "R12_OHLC_COMPARATOR_TWO_BAR_V1",
    }),
    observedAt: finite(bars.at(-1)?.closeTime),
    symbol: plan.symbol,
    planId: plan.id,
    implementationRevision: plan.implementationRevisionAtDiscovery ?? null,
    decision: {
      evaluationBarOpenTime,
      evaluationBarCloseTime: finite(evaluationBar?.closeTime),
      firstPostEvaluationBarOpenTime: finite(firstBar.openTime),
      horizonHours,
      basePrice,
    },
    labels: {
      grossMaximumUpBps: grossUpBps,
      grossMaximumDownBps: grossDownBps,
      closeSide: directionalPostPathLabels(comparison.closeRuleDirection, grossUpBps, grossDownBps, closeBps),
      bufferedClose: directionalPostPathLabels(comparison.bufferedCloseDirection, grossUpBps, grossDownBps, closeBps),
      wholeBarSide: directionalPostPathLabels(comparison.wholeBarSideDirection, grossUpBps, grossDownBps, closeBps),
      extremeTouch: directionalPostPathLabels(comparison.extremeTouchDirection, grossUpBps, grossDownBps, closeBps),
    },
    dataQuality: {
      source: "BINANCE_USDT_PERPETUAL_CLOSED_15M_OHLC",
      fullHorizonClosed: true,
      expectedBarCount,
      observedBarCount: bars.length,
      sameBarPathKnown: false,
      counterfactualExecutionModeled: false,
      extremeSameBarAmbiguous: comparison.extremeSameBarAmbiguous,
    },
    causality: {
      postEvaluationOutcomeLabel: true,
      futureOutcomeFieldsIncluded: true,
      executionUse: "OBSERVE_ONLY_OHLC_CROSS_TRIGGER_COMPARISON",
    },
  };
}

export function crossDisplacementBucket(absoluteBps) {
  const value = finite(absoluteBps);
  if (value === null || value < 0) return null;
  if (value < 50) return "ABS_0_TO_50_BPS";
  if (value < 150) return "ABS_50_TO_150_BPS";
  if (value < 300) return "ABS_150_TO_300_BPS";
  return "ABS_300_BPS_OR_MORE";
}

export function crossDisplacementFactors(price, intersectionPrice) {
  const observedPrice = finite(price);
  const crossPrice = finite(intersectionPrice);
  if (observedPrice === null || crossPrice === null || crossPrice === 0) {
    return { signedBps: null, absoluteBps: null, bucket: null };
  }
  const signedBps = bps(observedPrice - crossPrice, crossPrice);
  const absoluteBps = Math.abs(signedBps);
  return { signedBps, absoluteBps, bucket: crossDisplacementBucket(absoluteBps) };
}

function log10(value) {
  return Number.isFinite(value) && value > 0 ? Math.log10(value) : null;
}

function anchorAgeHours(anchor, asOf) {
  const time = finite(anchor?.time);
  return time === null ? null : Math.max(0, (asOf - time) / HOUR_MS);
}

export function buildPlanFactorObservation(state, plan, asOf = Date.now()) {
  const scale = plan?.scale ?? {};
  const consensus = plan?.anchorConsensus ?? {};
  const anchors = Array.isArray(plan?.anchors) ? plan.anchors : [];
  const quote = state?.lastQuotes?.[plan.symbol] ?? null;
  const quoteBid = finite(quote?.bid);
  const quoteAsk = finite(quote?.ask);
  const mid = quoteBid === null || quoteAsk === null ? null : (quoteBid + quoteAsk) / 2;
  const crossPrice = finite(plan.intersectionPrice);
  const fourSlope = finite(plan.fourHourLine?.slope);
  const oneSlope = finite(plan.oneHourLine?.slope);
  const fourHierarchy = finite(scale.fourHourHierarchyMultiplier);
  const oneHierarchy = finite(scale.oneHourHierarchyMultiplier);
  const fourProminence = finite(scale.fourHourAnchorProminenceFraction);
  const oneProminence = finite(scale.oneHourAnchorProminenceFraction);
  const fourMove = finite(scale.fourHourPairMoveFraction);
  const oneMove = finite(scale.oneHourPairMoveFraction);
  const intersectionTime = finite(plan.intersectionTime);
  const intersectionCoordinate = finite(plan.intersectionCoordinate15m);
  const lockedBarOpenTime = finite(plan.lockedBarOpenTime);
  const latestConfirmation = finite(plan.latestConfirmation);
  const fourLatestAnchorCoordinate = finite(anchors[1]?.coordinate15m);
  const oneLatestAnchorCoordinate = finite(anchors[3]?.coordinate15m);
  const fourSpan15m = finite(scale.fourHourSpan15m);
  const oneSpan15m = finite(scale.oneHourSpan15m);
  const crossOffsetFraction = intersectionTime === null || lockedBarOpenTime === null
    ? null
    : (intersectionTime - lockedBarOpenTime) / FIFTEEN_MINUTES_MS;
  const marketDisplacement = crossDisplacementFactors(mid, crossPrice);
  return {
    schemaVersion: 1,
    observationType: "PLAN_FACTOR_SNAPSHOT",
    observationId: deterministicId("factor_plan", {
      planId: plan.id,
      barBucket: Math.floor(asOf / FIFTEEN_MINUTES_MS),
      committed: plan.committed === true,
    }),
    observedAt: asOf,
    symbol: plan.symbol,
    planId: plan.id,
    strategyVersion: state.strategyVersion,
    implementationRevision: state.implementationRevision,
    factors: {
      activeFourHourLine: plan.fourHourLineStatus === "ACTIVE_4H_TREND" ? 1 : 0,
      committed: plan.committed === true ? 1 : 0,
      leadHours: intersectionTime === null ? null : (intersectionTime - asOf) / HOUR_MS,
      intersectionWindowWidthMinutes: finite(plan.intersectionWindowStart) === null || finite(plan.intersectionWindowEnd) === null
        ? null
        : (finite(plan.intersectionWindowEnd) - finite(plan.intersectionWindowStart)) / 60_000,
      anchorHypothesisSupport: finite(consensus.support),
      anchorStabilityScore: finite(consensus.stabilityScore),
      anchorStabilityGrade: consensus.grade ?? null,
      anchorPairQualityScore: finite(plan.anchorQualityScore),
      anchorClusterPairQualityScore: finite(consensus.pairQualityScore),
      anchorClusterPriceDispersionBps: finite(consensus.priceDispersionBps),
      anchorPerturbationSensitivityScore: finite(consensus.perturbationSensitivityScore),
      crossOffsetWithin15mBar: crossOffsetFraction,
      crossDistanceFrom15mBarCenter: crossOffsetFraction === null ? null : Math.abs(crossOffsetFraction - 0.5) * 2,
      crossDistanceBps: mid && crossPrice !== null ? bps(crossPrice - mid, mid) : null,
      marketMidFromIntersectionBps: marketDisplacement.signedBps,
      marketMidAbsoluteDistanceFromIntersectionBps: marketDisplacement.absoluteBps,
      marketMidIntersectionDistanceBucket: marketDisplacement.bucket,
      fourHourHierarchy: fourHierarchy,
      oneHourHierarchy: oneHierarchy,
      weakestHierarchy: fourHierarchy === null || oneHierarchy === null ? null : Math.min(fourHierarchy, oneHierarchy),
      hierarchyBalance: fourHierarchy === null || oneHierarchy === null ? null : ratio(Math.min(fourHierarchy, oneHierarchy), Math.max(fourHierarchy, oneHierarchy)),
      fourHourSpanHours: finite(scale.fourHourSpan15m) === null ? null : finite(scale.fourHourSpan15m) * 0.25,
      oneHourSpanHours: finite(scale.oneHourSpan15m) === null ? null : finite(scale.oneHourSpan15m) * 0.25,
      fourHourProminenceFraction: fourProminence,
      oneHourProminenceFraction: oneProminence,
      weakestProminenceFraction: fourProminence === null || oneProminence === null ? null : Math.min(fourProminence, oneProminence),
      fourHourPairMoveFraction: fourMove,
      oneHourPairMoveFraction: oneMove,
      weakestPairMoveFraction: fourMove === null || oneMove === null ? null : Math.min(fourMove, oneMove),
      logStructureImportance: log10(finite(scale.importance)),
      fourHourSlopeAbsBpsPer15m: fourSlope === null || crossPrice === null ? null : bps(Math.abs(fourSlope), crossPrice),
      oneHourSlopeAbsBpsPer15m: oneSlope === null || crossPrice === null ? null : bps(Math.abs(oneSlope), crossPrice),
      slopeSeparationBpsPer15m: fourSlope === null || oneSlope === null || crossPrice === null ? null : bps(Math.abs(fourSlope - oneSlope), crossPrice),
      firstFourHourAnchorAgeHours: anchorAgeHours(anchors[0], asOf),
      secondFourHourAnchorAgeHours: anchorAgeHours(anchors[1], asOf),
      firstOneHourAnchorAgeHours: anchorAgeHours(anchors[2], asOf),
      secondOneHourAnchorAgeHours: anchorAgeHours(anchors[3], asOf),
      fourHourLineExtrapolationRatio: intersectionCoordinate === null || fourLatestAnchorCoordinate === null || fourSpan15m === null
        ? null
        : ratio(intersectionCoordinate - fourLatestAnchorCoordinate, fourSpan15m),
      oneHourLineExtrapolationRatio: intersectionCoordinate === null || oneLatestAnchorCoordinate === null || oneSpan15m === null
        ? null
        : ratio(intersectionCoordinate - oneLatestAnchorCoordinate, oneSpan15m),
      latestConfirmationAgeHours: latestConfirmation === null ? null : Math.max(0, (asOf - latestConfirmation) / HOUR_MS),
      hourOfDayCst: Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }).format(new Date(asOf))) % 24,
    },
    causality: {
      availableAtOrBeforeObservation: true,
      futureOutcomeFieldsIncluded: false,
      executionUse: "R7_DEFERRED_PROTECTIVE_STRUCTURE_ACTIVE_R6_ANCHOR_CONSENSUS_FIELDS_ARE_AUTHORIZED_SELECTION_INPUTS_OTHER_RESEARCH_FACTORS_OBSERVE_ONLY",
    },
  };
}

function compositePriceBar(patternBars) {
  const first = patternBars[0];
  const last = patternBars.at(-1);
  return {
    openTime: first.openTime,
    closeTime: last.closeTime,
    open: first.open,
    high: Math.max(...patternBars.map((bar) => bar.high)),
    low: Math.min(...patternBars.map((bar) => bar.low)),
    close: last.close,
  };
}

function confirmationAcceptance(composite, intersectionPrice, signalPolicy) {
  const range = composite.high - composite.low;
  const direction = Math.sign(composite.close - composite.open);
  const bodyToRange = ratio(Math.abs(composite.close - composite.open), range);
  const closeLocation = ratio(composite.close - composite.low, range);
  const minimumBodyToRange = Number(signalPolicy.minimumBodyToRange ?? 0.5);
  const longMinimumCloseLocation = Number(signalPolicy.longMinimumCloseLocation ?? 0.75);
  const shortMaximumCloseLocation = Number(signalPolicy.shortMaximumCloseLocation ?? 0.25);
  const crossSideConditionMet = direction === 1
    ? composite.close > intersectionPrice
    : direction === -1 && composite.close < intersectionPrice;
  const closeLocationConditionMet = direction === 1
    ? closeLocation >= longMinimumCloseLocation
    : direction === -1 && closeLocation <= shortMaximumCloseLocation;
  const bodyStrengthConditionMet = bodyToRange >= minimumBodyToRange;
  return {
    direction,
    bodyToRange,
    closeLocation,
    crossSideConditionMet,
    bodyStrengthConditionMet,
    closeLocationConditionMet,
    accepted: direction !== 0 && crossSideConditionMet && bodyStrengthConditionMet && closeLocationConditionMet,
  };
}

export function dualPriceShadowDecision({
  composite,
  reserveStartPrice,
  intersectionPrice,
  priorReserveBars = [],
  acceptance,
  preDivergenceThresholdBps = 300,
}) {
  const p0 = finite(reserveStartPrice);
  const crossPrice = finite(intersectionPrice);
  const direction = finite(acceptance?.direction) ?? 0;
  if (p0 === null || p0 === 0 || crossPrice === null) {
    return {
      accepted: false,
      reason: "DUAL_PRICE_REFERENCE_MISSING",
      reserveStartPrice: p0,
      preCrossDisplacementBps: null,
      postCrossIncrementalExpansionBps: null,
    };
  }
  const preDisplacement = crossDisplacementFactors(p0, crossPrice);
  const postCrossIncrementalExpansionBps = bps(composite.close - p0, p0);
  const preDiverged = preDisplacement.absoluteBps >= preDivergenceThresholdBps;
  const preDivergenceContinuationDirectionMet = !preDiverged ||
    (preDisplacement.signedBps > 0 && direction === 1) ||
    (preDisplacement.signedBps < 0 && direction === -1);
  const incrementalDirectionMet = direction === 1
    ? postCrossIncrementalExpansionBps > 0
    : direction === -1 && postCrossIncrementalExpansionBps < 0;
  const hasPriorReserveBar = priorReserveBars.length > 0;
  const localStructureBreakMet = hasPriorReserveBar && (direction === 1
    ? composite.close > Math.max(...priorReserveBars.map((bar) => bar.high))
    : direction === -1 && composite.close < Math.min(...priorReserveBars.map((bar) => bar.low)));
  const oppositePullbackObserved = direction === 1
    ? priorReserveBars.some((bar) => bar.close < bar.open)
    : direction === -1 && priorReserveBars.some((bar) => bar.close > bar.open);
  const pullbackReExpansionMet = oppositePullbackObserved && localStructureBreakMet;
  const preDivergenceReconfirmationMet = !preDiverged || localStructureBreakMet || pullbackReExpansionMet;
  const priceQualityMet = direction !== 0 &&
    acceptance?.bodyStrengthConditionMet === true &&
    acceptance?.closeLocationConditionMet === true;
  const accepted = priceQualityMet && incrementalDirectionMet &&
    preDivergenceContinuationDirectionMet && preDivergenceReconfirmationMet;
  let reason = "DUAL_PRICE_SHADOW_ACCEPTED";
  if (!priceQualityMet) reason = "PRICE_QUALITY_NOT_MET";
  else if (!incrementalDirectionMet) reason = "NO_NEW_POST_CROSS_DIRECTIONAL_EXPANSION";
  else if (!preDivergenceContinuationDirectionMet) reason = "PRE_DIVERGED_REVERSAL_IS_NOT_EXPANSION";
  else if (!preDivergenceReconfirmationMet) reason = "PRE_DIVERGED_REQUIRES_LOCAL_STRUCTURE_RECONFIRMATION";
  return {
    accepted,
    reason,
    reserveStartPrice: p0,
    preCrossDisplacementBps: preDisplacement.signedBps,
    preCrossAbsoluteDisplacementBps: preDisplacement.absoluteBps,
    preCrossDisplacementBucket: preDisplacement.bucket,
    preDivergenceThresholdBps,
    preDiverged,
    preDivergenceSide: preDiverged
      ? (preDisplacement.signedBps > 0 ? "ABOVE_INTERSECTION" : "BELOW_INTERSECTION")
      : "WITHIN_PRE_DIVERGENCE_BAND",
    postCrossIncrementalExpansionBps,
    incrementalDirectionMet,
    preDivergenceContinuationDirectionMet,
    localStructureBreakMet,
    oppositePullbackObserved,
    pullbackReExpansionMet,
    preDivergenceReconfirmationMet,
  };
}

export function buildConfirmationReserveFactorObservations(plan, reserveBars, signalPolicy = {}, capturedAt = Date.now()) {
  const crossPrice = finite(plan?.intersectionPrice);
  const intersectionTime = finite(plan?.intersectionTime);
  const lockedBarOpenTime = finite(plan?.lockedBarOpenTime);
  if (crossPrice === null || intersectionTime === null || lockedBarOpenTime === null) return [];
  const maximumReserveBars = Number(signalPolicy.maximumReserveBars ?? 4);
  const allowedPatternLengths = [...(signalPolicy.allowedPatternLengths ?? [1, 2, 3])]
    .filter((length) => Number.isInteger(length) && length > 0)
    .sort((a, b) => a - b);
  const closedBars = [...(reserveBars ?? [])]
    .filter((bar) => Number.isFinite(bar?.openTime) && Number.isFinite(bar?.closeTime) && bar.closeTime < capturedAt)
    .filter((bar) => bar.openTime >= lockedBarOpenTime && bar.openTime < lockedBarOpenTime + maximumReserveBars * FIFTEEN_MINUTES_MS)
    .sort((a, b) => a.openTime - b.openTime);
  const observations = [];
  let terminalAccepted = false;
  let shadowDecisionMade = false;
  for (let end = 0; end < closedBars.length && !terminalAccepted; end += 1) {
    for (const length of allowedPatternLengths) {
      const start = end - length + 1;
      if (start < 0) continue;
      const patternBars = closedBars.slice(start, end + 1);
      const composite = compositePriceBar(patternBars);
      const acceptance = confirmationAcceptance(composite, crossPrice, signalPolicy);
      const displacement = crossDisplacementFactors(composite.close, crossPrice);
      const shadow = dualPriceShadowDecision({
        composite,
        reserveStartPrice: closedBars[0]?.open,
        intersectionPrice: crossPrice,
        priorReserveBars: closedBars.slice(0, end),
        acceptance,
        preDivergenceThresholdBps: Number(signalPolicy.shadowPreDivergenceThresholdBps ?? 300),
      });
      const shadowEvaluationActive = !shadowDecisionMade;
      const shadowWouldEnter = shadowEvaluationActive ? shadow.accepted : null;
      const lastBar = patternBars.at(-1);
      observations.push({
        schemaVersion: 2,
        observationType: "CONFIRMATION_RESERVE_FACTOR_SNAPSHOT",
        observationId: deterministicId("factor_reserve", {
          planId: plan.id,
          lastBarOpenTime: lastBar.openTime,
          patternLength: length,
          observationRevision: "DUAL_PRICE_SHADOW_V1",
        }),
        observedAt: lastBar.closeTime + 1,
        capturedAt,
        symbol: plan.symbol,
        planId: plan.id,
        factors: {
          reserveBarNumber: Math.round((lastBar.openTime - lockedBarOpenTime) / FIFTEEN_MINUTES_MS) + 1,
          confirmationPatternLength: length,
          confirmationFirstBarDelayFromCrossMinutes: (patternBars[0].openTime - intersectionTime) / 60_000,
          confirmationDirection: acceptance.direction,
          confirmationCompositeOpen: composite.open,
          confirmationCompositeHigh: composite.high,
          confirmationCompositeLow: composite.low,
          confirmationCompositeClose: composite.close,
          confirmationCompositeBodyToRange: acceptance.bodyToRange,
          confirmationCompositeCloseLocation: acceptance.closeLocation,
          confirmationCompositeCloseFromIntersectionBps: displacement.signedBps,
          confirmationCompositeAbsoluteDistanceFromIntersectionBps: displacement.absoluteBps,
          confirmationCompositeIntersectionDistanceBucket: displacement.bucket,
          crossSideConditionMet: acceptance.crossSideConditionMet ? 1 : 0,
          bodyStrengthConditionMet: acceptance.bodyStrengthConditionMet ? 1 : 0,
          closeLocationConditionMet: acceptance.closeLocationConditionMet ? 1 : 0,
          priceConfirmationAccepted: acceptance.accepted ? 1 : 0,
          dualPriceReserveStartPrice: shadow.reserveStartPrice,
          dualPricePreCrossDisplacementBps: shadow.preCrossDisplacementBps,
          dualPricePreCrossAbsoluteDisplacementBps: shadow.preCrossAbsoluteDisplacementBps,
          dualPricePreCrossDisplacementBucket: shadow.preCrossDisplacementBucket,
          dualPricePreDivergenceThresholdBps: shadow.preDivergenceThresholdBps,
          dualPricePreDiverged: shadow.preDiverged ? 1 : 0,
          dualPricePreDivergenceSide: shadow.preDivergenceSide,
          dualPricePostCrossIncrementalExpansionBps: shadow.postCrossIncrementalExpansionBps,
          dualPriceIncrementalDirectionMet: shadow.incrementalDirectionMet ? 1 : 0,
          dualPricePreDivergenceContinuationDirectionMet: shadow.preDivergenceContinuationDirectionMet ? 1 : 0,
          dualPriceLocalStructureBreakMet: shadow.localStructureBreakMet ? 1 : 0,
          dualPriceOppositePullbackObserved: shadow.oppositePullbackObserved ? 1 : 0,
          dualPricePullbackReExpansionMet: shadow.pullbackReExpansionMet ? 1 : 0,
          dualPricePreDivergenceReconfirmationMet: shadow.preDivergenceReconfirmationMet ? 1 : 0,
          dualPriceShadowEvaluationActive: shadowEvaluationActive ? 1 : 0,
          dualPriceShadowWouldEnter: shadowWouldEnter === null ? null : (shadowWouldEnter ? 1 : 0),
          dualPriceShadowDecisionReason: shadowEvaluationActive ? shadow.reason : "SHADOW_ALREADY_ACCEPTED_EARLIER",
        },
        causality: {
          availableAtOrBeforeObservation: true,
          exchangeBarsClosedBeforeObservation: patternBars.every((bar) => bar.closeTime < lastBar.closeTime + 1),
          futureOutcomeFieldsIncluded: false,
          executionUse: "OBSERVE_ONLY",
        },
      });
      if (shadowEvaluationActive && shadow.accepted) shadowDecisionMade = true;
      if (acceptance.accepted) {
        terminalAccepted = true;
        break;
      }
    }
  }
  return observations;
}

async function fetchConfirmationReserveBars(plan, now, maximumReserveBars) {
  const symbol = String(plan?.symbol ?? "");
  const startTime = finite(plan?.lockedBarOpenTime);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || startTime === null) return [];
  if (now <= startTime) return [];
  const query = new URLSearchParams({
    symbol,
    interval: "15m",
    startTime: String(startTime),
    endTime: String(Math.min(now - 1, startTime + maximumReserveBars * FIFTEEN_MINUTES_MS - 1)),
    limit: String(maximumReserveBars),
  });
  const response = await fetch(`https://demo-fapi.binance.com/fapi/v1/klines?${query}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "orion-v2-mtfx-factor-miner/1.1-public-only" },
  });
  if (!response.ok) throw new Error(`CONFIRMATION_RESERVE_HTTP_${response.status}`);
  const rows = await response.json();
  return rows.map((row) => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), closeTime: Number(row[6]),
  })).filter((bar) =>
    [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.closeTime].every(Number.isFinite) &&
    bar.closeTime < now && bar.high >= bar.low
  );
}

async function fetchClosedFuturesBars(symbol, startTime, endTime, now) {
  if (!/^[A-Z0-9]{5,20}$/.test(String(symbol)) || !Number.isFinite(startTime) || !Number.isFinite(endTime)) return [];
  if (now < endTime) return [];
  const query = new URLSearchParams({
    symbol,
    interval: "15m",
    startTime: String(startTime),
    endTime: String(endTime - 1),
    limit: String(Math.ceil((endTime - startTime) / FIFTEEN_MINUTES_MS)),
  });
  const response = await fetch(`https://demo-fapi.binance.com/fapi/v1/klines?${query}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "orion-v2-mtfx-factor-miner/1.1-public-only" },
  });
  if (!response.ok) throw new Error(`NON_ENTRY_OUTCOME_HTTP_${response.status}`);
  const rows = await response.json();
  return rows.map((row) => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), closeTime: Number(row[6]),
  })).filter((bar) =>
    [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.closeTime].every(Number.isFinite) &&
    bar.closeTime < now && bar.high >= bar.low
  );
}

async function buildR12RelationshipsAtEntry(record, activePositions) {
  const observedAt = finite(record?.marketTime);
  if (observedAt === null) return new Map();
  const endTime = Math.floor((observedAt - 1) / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS + FIFTEEN_MINUTES_MS;
  const startTime = endTime - (R12_PORTFOLIO_LOOKBACK_BARS_15M + 1) * FIFTEEN_MINUTES_MS;
  const symbols = [...new Set([
    "BTCUSDT",
    "ETHUSDT",
    ...(activePositions ?? []).map((position) => position?.symbol),
  ].filter((symbol) => /^[A-Z0-9]{5,20}$/.test(String(symbol))))];
  const barsBySymbol = new Map(await Promise.all(symbols.map(async (symbol) => [
    symbol,
    await fetchClosedFuturesBars(symbol, startTime, endTime, observedAt),
  ])));
  const activeSymbols = [...new Set((activePositions ?? []).map((position) => position?.symbol).filter((symbol) => barsBySymbol.has(symbol)))];
  const relationships = new Map();
  for (const symbol of activeSymbols) {
    const assetBars = barsBySymbol.get(symbol) ?? [];
    const peers = new Map(activeSymbols.filter((peer) => peer !== symbol).map((peer) => [peer, rollingReturnRelationship(assetBars, barsBySymbol.get(peer) ?? [])]));
    relationships.set(symbol, {
      btc: rollingReturnRelationship(assetBars, barsBySymbol.get("BTCUSDT") ?? []),
      eth: rollingReturnRelationship(assetBars, barsBySymbol.get("ETHUSDT") ?? []),
      peers,
    });
  }
  return relationships;
}

function completePostEntryBars(bars, firstBarOpenTime, horizonHours) {
  const expected = horizonHours * 4;
  const expectedEnd = firstBarOpenTime + expected * FIFTEEN_MINUTES_MS;
  const ordered = [...(bars ?? [])].sort((first, second) => first.openTime - second.openTime);
  return ordered.length === expected && ordered[0]?.openTime === firstBarOpenTime && ordered.at(-1)?.openTime === expectedEnd - FIFTEEN_MINUTES_MS;
}

export function buildR12PostEntryRelativePathObservation({ record, horizonHours, assetBars, btcBars, ethBars }) {
  const position = record?.payload ?? {};
  const openedAt = finite(record?.marketTime);
  if (!isR12Position(position) || !record?.eventId || openedAt === null) return null;
  const firstBarOpenTime = (Math.floor(openedAt / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS;
  const orderedAsset = [...(assetBars ?? [])].sort((first, second) => first.openTime - second.openTime);
  const orderedBtc = [...(btcBars ?? [])].sort((first, second) => first.openTime - second.openTime);
  const orderedEth = [...(ethBars ?? [])].sort((first, second) => first.openTime - second.openTime);
  const complete = completePostEntryBars(orderedAsset, firstBarOpenTime, horizonHours) &&
    completePostEntryBars(orderedBtc, firstBarOpenTime, horizonHours) &&
    completePostEntryBars(orderedEth, firstBarOpenTime, horizonHours);
  const assetStart = finite(orderedAsset[0]?.open);
  const assetEnd = finite(orderedAsset.at(-1)?.close);
  const btcStart = finite(orderedBtc[0]?.open);
  const btcEnd = finite(orderedBtc.at(-1)?.close);
  const ethStart = finite(orderedEth[0]?.open);
  const ethEnd = finite(orderedEth.at(-1)?.close);
  const assetReturnBps = assetStart === null || assetEnd === null ? null : bps(assetEnd - assetStart, assetStart);
  const btcReturnBps = btcStart === null || btcEnd === null ? null : bps(btcEnd - btcStart, btcStart);
  const ethReturnBps = ethStart === null || ethEnd === null ? null : bps(ethEnd - ethStart, ethStart);
  const direction = finite(position.direction);
  return {
    schemaVersion: 1,
    observationType: "R12_POST_ENTRY_RELATIVE_PATH_LABEL",
    observationId: deterministicId("factor_r12_post_entry_relative_path", { eventId: record.eventId, horizonHours }),
    observedAt: firstBarOpenTime + horizonHours * HOUR_MS,
    symbol: position.symbol,
    planId: position.intersectionId,
    positionId: position.id,
    auditEventId: record.eventId,
    implementationRevision: position.implementationRevision,
    evaluation: { firstPostEntryBarOpenTime: firstBarOpenTime, horizonHours },
    labels: {
      assetCloseReturnBps: assetReturnBps,
      btcCloseReturnBps: btcReturnBps,
      ethCloseReturnBps: ethReturnBps,
      relativeCloseReturnBpsToBtc: assetReturnBps === null || btcReturnBps === null ? null : assetReturnBps - btcReturnBps,
      relativeCloseReturnBpsToEth: assetReturnBps === null || ethReturnBps === null ? null : assetReturnBps - ethReturnBps,
      directionalRelativeCloseReturnBpsToBtc: direction === null || assetReturnBps === null || btcReturnBps === null ? null : direction * (assetReturnBps - btcReturnBps),
      directionalRelativeCloseReturnBpsToEth: direction === null || assetReturnBps === null || ethReturnBps === null ? null : direction * (assetReturnBps - ethReturnBps),
    },
    causality: {
      entryFactorsIncluded: false,
      futureOutcomeFieldsIncluded: true,
      executionUse: "OBSERVE_ONLY_R12_POST_ENTRY_RELATIVE_PATH",
    },
    dataQuality: {
      marketData: "BINANCE_USDT_PERPETUAL_FULLY_CLOSED_15M_OHLC",
      pathComplete: complete,
      sameBarPathKnown: false,
      counterfactualExecutionModeled: false,
    },
  };
}

async function readLedger(target) {
  try {
    const raw = await fs.readFile(target, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function fetchSignalCandle(position) {
  const symbol = String(position.symbol ?? "");
  const openTime = finite(position.signalBarOpenTime);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || openTime === null) return null;
  const query = new URLSearchParams({
    symbol,
    interval: "15m",
    startTime: String(openTime),
    endTime: String(openTime + FIFTEEN_MINUTES_MS - 1),
    limit: "1",
  });
  const response = await fetch(`https://demo-fapi.binance.com/fapi/v1/klines?${query}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { "user-agent": "orion-v2-mtfx-factor-miner/1.0-public-only" },
  });
  if (!response.ok) throw new Error(`SIGNAL_CANDLE_HTTP_${response.status}`);
  const rows = await response.json();
  const row = rows?.[0];
  if (!row || Number(row[0]) !== openTime) return null;
  return { openTime, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), closeTime: Number(row[6]) };
}

function signalCandleFactors(candle) {
  if (!candle) return null;
  const range = candle.high - candle.low;
  const body = candle.close - candle.open;
  return {
    signalDirection: Math.sign(body),
    signalRangeBps: bps(range, candle.open),
    signalBodyBps: bps(Math.abs(body), candle.open),
    signalBodyToRange: ratio(Math.abs(body), range),
    signalCloseLocation: ratio(candle.close - candle.low, range),
    signalUpperWickToRange: ratio(candle.high - Math.max(candle.open, candle.close), range),
    signalLowerWickToRange: ratio(Math.min(candle.open, candle.close) - candle.low, range),
  };
}

export function protectiveStructureFactors(position) {
  const entry = finite(position?.entry);
  const stop = finite(position?.initialStop);
  const direction = finite(position?.direction);
  const earlier = position?.protectiveStructure?.secondEarlier ?? null;
  const nearest = position?.protectiveStructure?.firstNearest ?? null;
  const earlierPrice = finite(earlier?.price);
  const nearestPrice = finite(nearest?.price);
  const stopDistance = entry === null || stop === null ? null : Math.abs(entry - stop);
  const progression = direction === null || earlierPrice === null || nearestPrice === null
    ? null
    : direction * (nearestPrice - earlierPrice);
  const signalBarCloseTime = finite(position?.signalBarCloseTime);
  const structureReadyAt = finite(position?.protectiveStructure?.readyAt);
  const openedAt = finite(position?.openedAt);
  return {
    protectiveProgressionBps: entry === null || progression === null ? null : bps(progression, entry),
    protectiveProgressionShareOfStopDistance: progression === null || stopDistance === null
      ? null
      : ratio(progression, stopDistance),
    earlierProtectiveProminenceBps: entry === null || finite(earlier?.prominenceAbsolute) === null
      ? null
      : bps(finite(earlier.prominenceAbsolute), entry),
    nearestProtectiveProminenceBps: entry === null || finite(nearest?.prominenceAbsolute) === null
      ? null
      : bps(finite(nearest.prominenceAbsolute), entry),
    protectiveProgressionFractionOfWeakerProminence:
      finite(position?.protectiveStructure?.progressionFractionOfWeakerProminence),
    protectiveStructureReadyReserveBarNumber:
      finite(position?.protectiveStructure?.readyReserveBarNumber),
    confirmationToProtectiveStructureBars15m:
      signalBarCloseTime === null || structureReadyAt === null
        ? null
        : (structureReadyAt - signalBarCloseTime) / FIFTEEN_MINUTES_MS,
    protectiveStructureToEntryLatencySeconds:
      structureReadyAt === null || openedAt === null
        ? null
        : (openedAt - structureReadyAt) / 1000,
  };
}

function protectiveStructureFunnelStage(eventType) {
  return ({
    MTFX_PRICE_CONFIRMATION_LOCKED: "PRICE_CONFIRMATION_LOCKED",
    MTFX_PROTECTIVE_STRUCTURE_WAITING: "WAITING_FOR_PROTECTIVE_STRUCTURE",
    MTFX_PROTECTIVE_STRUCTURE_READY: "PROTECTIVE_STRUCTURE_READY",
    MTFX_SIGNAL_WAITING_FOR_CAPACITY: "STRUCTURE_READY_WAITING_CAPACITY",
    MTFX_SIGNAL_WAITING_FOR_BBO_COVERAGE: "STRUCTURE_READY_WAITING_BBO",
    MTFX_PROTECTIVE_ENTRY_WAITING_FOR_PRICE: "STRUCTURE_READY_WAITING_PROTECTIVE_PRICE",
    MTFX_PROTECTIVE_STRUCTURE_EXPIRED: "EXPIRED_WITHOUT_PROTECTIVE_STRUCTURE",
    MTFX_PROTECTIVE_ENTRY_WINDOW_EXPIRED: "EXPIRED_AFTER_PROTECTIVE_STRUCTURE_READY",
    MTFX_PAPER_ENTRY_REJECTED: "REJECTED_AFTER_PRICE_CONFIRMATION",
    PAPER_POSITION_OPENED: "PAPER_POSITION_OPENED",
  })[eventType] ?? null;
}

export function buildProtectiveStructureFunnelObservation(record, priceLockRecord = null, plan = null) {
  if (!PROTECTIVE_STRUCTURE_FUNNEL_EVENT_TYPES.has(record?.type) || !record?.eventId) return null;
  const payload = record.payload ?? {};
  const position = record.type === "PAPER_POSITION_OPENED" ? payload : null;
  const lock = priceLockRecord?.payload ?? (record.type === "MTFX_PRICE_CONFIRMATION_LOCKED" ? payload : {});
  const planId = payload.intersectionId ?? position?.intersectionId ?? null;
  const variant = payload.variant ?? position?.book ?? null;
  if (!planId || !variant) return null;
  const directionConfirmedAt = finite(
    payload.directionConfirmedAt ?? payload.confirmedAt ?? lock.confirmedAt ?? position?.signalBarCloseTime,
  );
  const priceConfirmationReserveBarNumber = finite(
    lock.reserveBarNumber ?? position?.confirmationPattern?.acceptedReserveBarNumber,
  );
  const protectiveStructureReserveBarNumber = finite(
    payload.reserveBarNumber ?? payload.reserveBarsObserved ?? position?.protectiveStructure?.readyReserveBarNumber,
  );
  const reserveBarsWaitedAfterDirectionLock = priceConfirmationReserveBarNumber === null || protectiveStructureReserveBarNumber === null
    ? null
    : Math.max(0, protectiveStructureReserveBarNumber - priceConfirmationReserveBarNumber);
  const stage = protectiveStructureFunnelStage(record.type);
  const observedAt = finite(record.marketTime);
  return {
    schemaVersion: 1,
    observationType: "PROTECTIVE_STRUCTURE_FUNNEL_EVENT",
    observationId: deterministicId("factor_protective_funnel", { auditEventId: record.eventId }),
    observedAt,
    symbol: payload.symbol ?? position?.symbol ?? plan?.symbol ?? null,
    planId,
    positionId: position?.id ?? null,
    variant,
    auditEventId: record.eventId,
    auditSequence: finite(record.sequence),
    implementationRevision: plan?.implementationRevisionAtDiscovery ?? position?.implementationRevision ?? null,
    eventType: record.type,
    stage,
    factors: {
      direction: finite(payload.direction ?? lock.direction ?? position?.direction),
      directionConfirmedAt,
      eventDelayFromDirectionConfirmationMinutes: directionConfirmedAt === null || observedAt === null
        ? null
        : Math.max(0, (observedAt - directionConfirmedAt) / 60_000),
      priceConfirmationReserveBarNumber,
      protectiveStructureReserveBarNumber,
      reserveBarsWaitedAfterDirectionLock,
      availablePivotCount: finite(payload.availablePivotCount),
      availableOppositePivotCount: finite(payload.availableOppositePivotCount),
      progressionFractionOfWeakerProminence: finite(
        payload.progressionFractionOfWeakerProminence ?? position?.protectiveStructure?.progressionFractionOfWeakerProminence,
      ),
      proposedStop: finite(payload.stop ?? position?.initialStop),
      structureEvaluatedAt: finite(payload.evaluatedAt ?? position?.protectiveStructure?.readyAt),
      structureEvaluationBarOpenTime: finite(
        payload.evaluationBarOpenTime ?? position?.protectiveStructure?.evaluationBarOpenTime,
      ),
      secondEarlierPrice: finite(payload.secondEarlier?.price ?? position?.protectiveStructure?.secondEarlier?.price),
      secondEarlierTime: finite(payload.secondEarlier?.time ?? position?.protectiveStructure?.secondEarlier?.time),
      secondEarlierConfirmedAt: finite(
        payload.secondEarlier?.confirmedAt ?? position?.protectiveStructure?.secondEarlier?.confirmedAt,
      ),
      secondEarlierProminenceAbsolute: finite(
        payload.secondEarlier?.prominenceAbsolute ?? position?.protectiveStructure?.secondEarlier?.prominenceAbsolute,
      ),
      firstNearestPrice: finite(payload.firstNearest?.price ?? position?.protectiveStructure?.firstNearest?.price),
      firstNearestTime: finite(payload.firstNearest?.time ?? position?.protectiveStructure?.firstNearest?.time),
      firstNearestConfirmedAt: finite(
        payload.firstNearest?.confirmedAt ?? position?.protectiveStructure?.firstNearest?.confirmedAt,
      ),
      firstNearestProminenceAbsolute: finite(
        payload.firstNearest?.prominenceAbsolute ?? position?.protectiveStructure?.firstNearest?.prominenceAbsolute,
      ),
      structureReason: payload.reason ?? payload.lastStructureReason ?? null,
      executionReason: payload.lastExecutionReason ?? null,
      structureAccepted: [
        "PROTECTIVE_STRUCTURE_READY",
        "STRUCTURE_READY_WAITING_CAPACITY",
        "STRUCTURE_READY_WAITING_BBO",
        "STRUCTURE_READY_WAITING_PROTECTIVE_PRICE",
        "EXPIRED_AFTER_PROTECTIVE_STRUCTURE_READY",
        "PAPER_POSITION_OPENED",
      ].includes(stage) ? 1 : 0,
      deferredStructureMatured: stage === "PROTECTIVE_STRUCTURE_READY" && reserveBarsWaitedAfterDirectionLock > 0 ? 1 : 0,
      entryOpened: stage === "PAPER_POSITION_OPENED" ? 1 : 0,
      terminalWithoutEntry: [
        "EXPIRED_WITHOUT_PROTECTIVE_STRUCTURE",
        "EXPIRED_AFTER_PROTECTIVE_STRUCTURE_READY",
        "REJECTED_AFTER_PRICE_CONFIRMATION",
      ].includes(stage) ? 1 : 0,
    },
    causality: {
      availableAtOrBeforeObservation: true,
      sourceAuditEventAndPriorPriceLockOnly: true,
      futureOutcomeFieldsIncluded: false,
      executionUse: "OBSERVE_ONLY_R7_PROTECTIVE_STRUCTURE_FUNNEL",
    },
  };
}

export function buildNonEntryPostPathOutcomeObservation({ record, plan, priceLockRecord = null, horizonHours, bars }) {
  if (!NON_ENTRY_TERMINAL_EVENT_TYPES.has(record?.type) || !record?.eventId || !plan?.id) return null;
  const payload = record.payload ?? {};
  const lockPayload = priceLockRecord?.payload ?? {};
  const direction = finite(payload.direction ?? lockPayload.direction);
  const terminalAt = finite(record.marketTime);
  const firstBar = Array.isArray(bars) ? bars[0] : null;
  const basePrice = finite(firstBar?.open);
  const high = firstBar ? Math.max(...bars.map((bar) => finite(bar.high)).filter((value) => value !== null)) : null;
  const low = firstBar ? Math.min(...bars.map((bar) => finite(bar.low)).filter((value) => value !== null)) : null;
  const close = finite(bars?.at(-1)?.close);
  if (terminalAt === null || basePrice === null || high === null || low === null || close === null) return null;
  const grossUpBps = bps(high - basePrice, basePrice);
  const grossDownBps = bps(low - basePrice, basePrice);
  const favourableExcursionBps = direction === 1 ? grossUpBps : direction === -1 ? -grossDownBps : null;
  const adverseExcursionBps = direction === 1 ? -grossDownBps : direction === -1 ? grossUpBps : null;
  const directionalCloseBps = direction === 1
    ? bps(close - basePrice, basePrice)
    : direction === -1 ? bps(basePrice - close, basePrice) : null;
  return {
    schemaVersion: 1,
    observationType: "NON_ENTRY_POST_PATH_OUTCOME",
    observationId: deterministicId("factor_nonentry_outcome", { auditEventId: record.eventId, horizonHours }),
    observedAt: finite(bars.at(-1)?.closeTime),
    symbol: plan.symbol,
    planId: plan.id,
    variant: payload.variant ?? null,
    auditEventId: record.eventId,
    auditSequence: finite(record.sequence),
    implementationRevision: plan.implementationRevisionAtDiscovery ?? null,
    decision: {
      terminalEventType: record.type,
      terminalReason: payload.reason ?? payload.lastStructureReason ?? null,
      direction,
      directionSource: finite(payload.direction) === null && finite(lockPayload.direction) !== null
        ? "PRIOR_PRICE_CONFIRMATION_LOCK" : finite(payload.direction) === null ? "UNAVAILABLE" : "TERMINAL_EVENT",
      terminalAt,
      postTerminalFirstBarOpenTime: finite(firstBar.openTime),
      horizonHours,
      basePrice,
    },
    labels: {
      grossMaximumUpBps: grossUpBps,
      grossMaximumDownBps: grossDownBps,
      directionalFavourableExcursionBps: favourableExcursionBps,
      directionalAdverseExcursionBps: adverseExcursionBps,
      directionalCloseBps,
    },
    dataQuality: {
      source: "BINANCE_USDT_PERPETUAL_CLOSED_15M_OHLC",
      fullHorizonClosed: true,
      expectedBarCount: Math.round(horizonHours * 4),
      observedBarCount: bars.length,
      directionAvailable: direction === 1 || direction === -1,
      counterfactualExecutionModeled: false,
      sameBarPathKnown: false,
    },
    causality: {
      postDecisionOutcomeLabel: true,
      futureOutcomeFieldsIncluded: true,
      executionUse: "OBSERVE_ONLY_NON_ENTRY_POST_PATH_RESEARCH",
    },
  };
}

export function confirmationPatternFactors(position) {
  const pattern = position?.confirmationPattern ?? {};
  const composite = pattern.composite ?? {};
  const intersectionTime = finite(position?.intersectionTime);
  const intersectionPrice = finite(position?.intersectionPrice);
  const firstBarOpenTime = finite(pattern.firstBarOpenTime);
  const lastBarOpenTime = finite(pattern.lastBarOpenTime);
  const compositeClose = finite(composite.close);
  const displacement = crossDisplacementFactors(compositeClose, intersectionPrice);
  return {
    confirmationPatternLength: finite(pattern.length),
    confirmationFirstBarDelayFromCrossMinutes: intersectionTime === null || firstBarOpenTime === null
      ? null
      : (firstBarOpenTime - intersectionTime) / 60_000,
    confirmationAcceptedReserveBarNumber:
      finite(pattern.acceptedReserveBarNumber) ?? (
        firstBarOpenTime === null || lastBarOpenTime === null
          ? null
          : Math.round((lastBarOpenTime - firstBarOpenTime) / FIFTEEN_MINUTES_MS) + 1
      ),
    confirmationCompositeBodyToRange: finite(pattern.bodyToRange),
    confirmationCompositeCloseLocation: finite(pattern.closeLocation),
    confirmationCompositeCloseFromIntersectionBps: displacement.signedBps,
    confirmationCompositeAbsoluteDistanceFromIntersectionBps: displacement.absoluteBps,
    confirmationCompositeIntersectionDistanceBucket: displacement.bucket,
  };
}

export async function buildEntryFactorObservation(record, planObservation, state) {
  const position = record.payload ?? {};
  let candle = null;
  let candleError = null;
  try { candle = await fetchSignalCandle(position); } catch (error) { candleError = error.message; }
  const entry = finite(position.entry);
  const stop = finite(position.initialStop);
  const bid = finite(position.lastBid);
  const ask = finite(position.lastAsk);
  const mid = bid === null || ask === null ? null : (bid + ask) / 2;
  const initialRiskPerUnit = finite(position.initialRiskPerUnit);
  const priceRiskPerUnit = entry === null || stop === null ? null : Math.abs(entry - stop);
  const entryDisplacement = crossDisplacementFactors(entry, finite(position.intersectionPrice));
  return {
    schemaVersion: 1,
    observationType: "ENTRY_FACTOR_SNAPSHOT",
    observationId: deterministicId("factor_entry", { eventId: record.eventId }),
    observedAt: Number(record.marketTime),
    symbol: position.symbol,
    planId: position.intersectionId,
    positionId: position.id,
    auditEventId: record.eventId,
    strategyVersion: position.strategyVersion,
    implementationRevision: position.implementationRevision ?? state.implementationRevision,
    factors: {
      ...(planObservation?.factors ?? {}),
      direction: finite(position.direction),
      entryPrice: entry,
      stopDistanceBps: entry === null || stop === null ? null : bps(Math.abs(entry - stop), entry),
      spreadBps: mid ? bps(ask - bid, mid) : null,
      executionCostShareOfInitialRisk: initialRiskPerUnit === null || priceRiskPerUnit === null
        ? null
        : ratio(Math.max(0, initialRiskPerUnit - priceRiskPerUnit), initialRiskPerUnit),
      plannedRiskUsdt: finite(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt),
      entryFromIntersectionBps: entry === null || finite(position.intersectionPrice) === null
        ? null
        : bps(entry - finite(position.intersectionPrice), finite(position.intersectionPrice)),
      entryAbsoluteDistanceFromIntersectionBps: entryDisplacement.absoluteBps,
      entryIntersectionDistanceBucket: entryDisplacement.bucket,
      entryCrossDisplacementInPriceRisk: entry === null || finite(position.intersectionPrice) === null || priceRiskPerUnit === null
        ? null
        : ratio(Math.abs(entry - finite(position.intersectionPrice)), priceRiskPerUnit),
      entryFromSignalCloseBps: entry === null || finite(candle?.close) === null
        ? null
        : bps(entry - finite(candle.close), finite(candle.close)),
      ...confirmationPatternFactors(position),
      ...protectiveStructureFactors(position),
      ...(signalCandleFactors(candle) ?? {}),
    },
    causality: {
      availableAtOrBeforeEntry: true,
      signalCandleClosedBeforeEntry: candle ? candle.closeTime <= Number(record.marketTime) : null,
      futureOutcomeFieldsIncluded: false,
      executionUse: "OBSERVE_ONLY",
    },
    dataQuality: {
      executionEvidence: position.executionEvidence ?? "UNKNOWN",
      signalCandleAvailable: candle !== null,
      signalCandleError: candleError,
    },
  };
}

export function buildOutcomeObservation(position, provenance = {}) {
  const outcome = position.trendOutcome ?? {};
  return {
    schemaVersion: 1,
    observationType: "OUTCOME_LABEL",
    observationId: deterministicId("factor_outcome", { positionId: position.id, closedAt: position.closedAt }),
    observedAt: Number(position.closedAt),
    symbol: position.symbol,
    planId: position.intersectionId,
    positionId: position.id,
    auditEventId: provenance.auditEventId ?? null,
    auditSequence: finite(provenance.auditSequence),
    projectedStateCommitEventId: provenance.projectedStateCommitEventId ?? null,
    derivedCloseEventId: provenance.derivedCloseEventId ?? null,
    outcomeSource: provenance.outcomeSource ?? "STATE_CLOSED_POSITION_LEGACY_FALLBACK",
    labels: {
      realizedNetPnlUsdt: finite(position.netPnl),
      realizedR: finite(position.realizedR),
      reachedOneNetR: outcome.reachedOneNetR === true ? 1 : 0,
      reachedTwoNetR: outcome.reachedTwoNetR === true ? 1 : 0,
      runnerReachedThreeNetR: outcome.runnerReachedThreeNetR === true ? 1 : 0,
      runnerReachedFiveNetR: outcome.runnerReachedFiveNetR === true ? 1 : 0,
      maximumNetExcursionR: finite(outcome.maximumNetExcursionR),
      minimumNetExcursionR: finite(outcome.minimumNetExcursionR),
      pathEfficiency: finite(outcome.pathEfficiency),
      holdingTimeHours: Number.isFinite(position.closedAt - position.openedAt) ? (position.closedAt - position.openedAt) / HOUR_MS : null,
      exitReason: position.exitReason ?? null,
    },
    dataQuality: {
      executionEvidence: position.executionEvidence ?? "UNKNOWN",
      attributableForFactorResearch: position.executionEvidence === "BBO_CAPTURED" && Boolean(position.trendOutcome),
      canonicalFullPositionState: ["CANONICAL_POSITION_STATE_COMMIT", "CANONICAL_PORTFOLIO_POSITION_TRANSITION"].includes(provenance.outcomeSource),
      canonicalStateProjection: provenance.outcomeSource === "CANONICAL_PORTFOLIO_POSITION_TRANSITION",
    },
  };
}

export function canonicalClosedPositionCommits(ledger) {
  const byPositionId = new Map();
  for (const record of expandPaperPositionStateRecords(ledger ?? [])) {
    if (record?.type !== "PAPER_POSITION_STATE_COMMITTED") continue;
    const payload = record.payload ?? {};
    const position = payload.position;
    if (payload.closed !== true || position?.status !== "CLOSED") continue;
    if (!position?.id || payload.positionId !== position.id) {
      throw new Error(`CANONICAL_CLOSED_POSITION_ID_MISMATCH_${record.eventId ?? "UNKNOWN"}`);
    }
    if (byPositionId.has(position.id)) {
      throw new Error(`MULTIPLE_CANONICAL_CLOSED_POSITION_COMMITS_${position.id}`);
    }
    byPositionId.set(position.id, record);
  }
  return byPositionId;
}

export async function mineFactorSnapshot({ now = Date.now(), paths = FACTOR_PATHS } = {}) {
  const [state, ledger, strategy, minerState, existingObservations] = await Promise.all([
    readJson(paths.state, null),
    readLedger(paths.ledger),
    readJson(paths.strategy ?? FACTOR_PATHS.strategy, { signal: {} }),
    readJson(paths.minerState, {
      schemaVersion: 1,
      observedIds: [],
      processedEntryEventIds: [],
      processedClosedPositionIds: [],
      processedReservePlanIds: [],
      processedDualPriceShadowPlanIds: [],
      latestPlanFactors: {},
    }),
    readLedger(paths.observations),
  ]);
  if (!state) throw new Error(`MTFX_STATE_MISSING: ${paths.state}`);
  const observed = new Set([
    ...(minerState.observedIds ?? []),
    ...existingObservations.map((observation) => observation?.observationId).filter(Boolean),
  ]);
  const processedEntryEventIds = new Set(minerState.processedEntryEventIds ?? []);
  const processedClosedPositionIds = new Set(minerState.processedClosedPositionIds ?? []);
  const processedReservePlanIds = new Set(minerState.processedReservePlanIds ?? []);
  const processedDualPriceShadowPlanIds = new Set(minerState.processedDualPriceShadowPlanIds ?? []);
  const priorPlanFactors = { ...(minerState.latestPlanFactors ?? {}) };
  const latestPlanFactors = { ...(minerState.latestPlanFactors ?? {}) };
  const additions = [];
  const reserveFetchErrors = [];
  const ohlcCrossTriggerErrors = [];
  const r12PortfolioTelemetryErrors = [];
  const r12PostEntryRelativePathErrors = [];
  const queueObservation = (observation) => {
    if (!observation?.observationId || observed.has(observation.observationId)) return false;
    observed.add(observation.observationId);
    additions.push(observation);
    return true;
  };

  for (const plan of Object.values(state.plans ?? {})) {
    const observation = buildPlanFactorObservation(state, plan, now);
    latestPlanFactors[plan.id] = observation;
    queueObservation(observation);
  }

  const terminalReserveEventTypes = new Set([
    "MTFX_CONFIRMATION_RESERVE_EXPIRED",
    "MTFX_PAPER_ENTRY_REJECTED",
    "MTFX_SIGNAL_EXPIRED",
    "MTFX_LOOKAHEAD_GUARD_REJECTED",
    "MTFX_PROTECTIVE_STRUCTURE_EXPIRED",
    "MTFX_PROTECTIVE_ENTRY_WINDOW_EXPIRED",
    "PAPER_POSITION_OPENED",
  ]);
  const terminalReservePlanIds = new Set(ledger
    .filter((record) => terminalReserveEventTypes.has(record?.type))
    .map((record) => record?.payload?.intersectionId)
    .filter(Boolean));
  const ledgerPlans = new Map(ledger
    .filter((record) => record?.type === "MTFX_PLAN_CREATED" && record?.payload?.id)
    .map((record) => [record.payload.id, record.payload]));
  const reservePlans = new Map(Object.values(state.plans ?? {}).map((plan) => [plan.id, plan]));
  for (const planId of terminalReservePlanIds) {
    if (!reservePlans.has(planId) && ledgerPlans.has(planId)) reservePlans.set(planId, ledgerPlans.get(planId));
  }

  for (const plan of reservePlans.values()) {
    if (processedDualPriceShadowPlanIds.has(plan.id)) continue;
    try {
      const maximumReserveBars = Number(strategy?.signal?.maximumReserveBars ?? 4);
      const reserveBars = await fetchConfirmationReserveBars(plan, now, maximumReserveBars);
      const reserveObservations = buildConfirmationReserveFactorObservations(plan, reserveBars, strategy?.signal ?? {}, now);
      for (const reserveObservation of reserveObservations) {
        queueObservation(reserveObservation);
      }
      const accepted = reserveObservations.some((item) => item.factors?.priceConfirmationAccepted === 1);
      const reserveDeadline = finite(plan.lockedBarOpenTime) === null
        ? null
        : finite(plan.lockedBarOpenTime) + maximumReserveBars * FIFTEEN_MINUTES_MS;
      if (accepted || terminalReservePlanIds.has(plan.id) || (reserveDeadline !== null && now > reserveDeadline)) {
        processedReservePlanIds.add(plan.id);
        processedDualPriceShadowPlanIds.add(plan.id);
      }
    } catch (error) {
      reserveFetchErrors.push({ planId: plan.id, symbol: plan.symbol, error: error.message });
    }
  }

  // R12's high/low alternatives are a forward, non-executing comparator only.
  // It deliberately starts from this authorization time and never backfills old
  // plans, fills, stops, or same-bar paths.
  const closeBufferBps = Number(strategy?.signal?.crossCloseBufferBps ?? 5);
  for (const plan of reservePlans.values()) {
    const firstEvaluationBarOpenTime = finite(plan?.lockedBarOpenTime);
    if (firstEvaluationBarOpenTime === null || firstEvaluationBarOpenTime < OHLC_CROSS_TRIGGER_PROSPECTIVE_START) continue;
    const decisionBarCount = Math.min(2, Math.max(1, Number(strategy?.signal?.maximumDirectionDecisionBars ?? 2)));
    try {
      const evaluationBars = await fetchClosedFuturesBars(plan.symbol, firstEvaluationBarOpenTime, firstEvaluationBarOpenTime + decisionBarCount * FIFTEEN_MINUTES_MS, now);
      for (let index = 0; index < decisionBarCount; index += 1) {
        const evaluationBarOpenTime = firstEvaluationBarOpenTime + index * FIFTEEN_MINUTES_MS;
        const evaluationBarEndTime = evaluationBarOpenTime + FIFTEEN_MINUTES_MS;
        if (now < evaluationBarEndTime) continue;
        const evaluationBar = evaluationBars.find((bar) => bar.openTime === evaluationBarOpenTime) ?? null;
        const comparison = buildOhlcCrossTriggerComparisonObservation(plan, evaluationBar, closeBufferBps);
        queueObservation(comparison);
        if (!comparison) continue;
        const firstPostEvaluationBarOpenTime = evaluationBarOpenTime + FIFTEEN_MINUTES_MS;
        for (const horizonHours of OHLC_CROSS_TRIGGER_OUTCOME_HORIZONS_HOURS) {
          const observationId = deterministicId("factor_ohlc_cross_trigger_outcome", {
            planId: plan.id,
            evaluationBarOpenTime,
            horizonHours,
            observationRevision: "R12_OHLC_COMPARATOR_TWO_BAR_V1",
          });
          if (observed.has(observationId)) continue;
          const endTime = firstPostEvaluationBarOpenTime + horizonHours * HOUR_MS;
          if (now < endTime) continue;
          const bars = await fetchClosedFuturesBars(plan.symbol, firstPostEvaluationBarOpenTime, endTime, now);
          queueObservation(buildOhlcCrossTriggerPostPathOutcomeObservation({
            plan,
            evaluationBar,
            horizonHours,
            bars,
            closeBufferBps,
          }));
        }
      }
    } catch (error) {
      ohlcCrossTriggerErrors.push({ planId: plan.id, symbol: plan.symbol, error: error.message });
    }
  }

  const priceLockRecords = new Map();
  for (const record of [...ledger].sort((first, second) => Number(first.sequence ?? 0) - Number(second.sequence ?? 0))) {
    const payload = record?.payload ?? {};
    const planId = payload.intersectionId;
    const variant = payload.variant ?? payload.book;
    const key = planId && variant ? `${planId}:${variant}` : null;
    if (record?.type === "MTFX_PRICE_CONFIRMATION_LOCKED" && key) priceLockRecords.set(key, record);
    if (!PROTECTIVE_STRUCTURE_FUNNEL_EVENT_TYPES.has(record?.type)) continue;
    const observation = buildProtectiveStructureFunnelObservation(
      record,
      key ? priceLockRecords.get(key) : null,
      planId ? ledgerPlans.get(planId) ?? reservePlans.get(planId) : null,
    );
    queueObservation(observation);
  }

  const nonEntryOutcomeErrors = [];
  for (const record of ledger.filter((item) => NON_ENTRY_TERMINAL_EVENT_TYPES.has(item?.type))) {
    const payload = record.payload ?? {};
    const planId = payload.intersectionId;
    const variant = payload.variant;
    const plan = planId ? ledgerPlans.get(planId) ?? reservePlans.get(planId) : null;
    const priceLock = planId && variant ? priceLockRecords.get(`${planId}:${variant}`) : null;
    const terminalAt = finite(record.marketTime);
    if (!plan || terminalAt === null) continue;
    // The first bar must open strictly after the terminal decision, so no partial decision bar leaks in.
    const firstPostTerminalBarOpenTime = (Math.floor(terminalAt / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS;
    for (const horizonHours of NON_ENTRY_OUTCOME_HORIZONS_HOURS) {
      const observationId = deterministicId("factor_nonentry_outcome", { auditEventId: record.eventId, horizonHours });
      if (observed.has(observationId)) continue;
      const endTime = firstPostTerminalBarOpenTime + horizonHours * HOUR_MS;
      if (now < endTime) continue;
      try {
        const bars = await fetchClosedFuturesBars(plan.symbol, firstPostTerminalBarOpenTime, endTime, now);
        const observation = buildNonEntryPostPathOutcomeObservation({
          record,
          plan,
          priceLockRecord: priceLock,
          horizonHours,
          bars,
        });
        queueObservation(observation);
      } catch (error) {
        nonEntryOutcomeErrors.push({ eventId: record.eventId, planId, horizonHours, error: error.message });
      }
    }
  }

  const entryRecords = ledger.filter((record) => record?.type === "PAPER_POSITION_OPENED").sort(stableLedgerOrder);
  for (const record of entryRecords) {
    if (processedEntryEventIds.has(record.eventId)) continue;
    const priorPlan = priorPlanFactors[record.payload?.intersectionId];
    const causalPlan = priorPlan && Number(priorPlan.observedAt) <= Number(record.marketTime) ? priorPlan : null;
    queueObservation(await buildEntryFactorObservation(record, causalPlan, state));
    processedEntryEventIds.add(record.eventId);
  }

  // Owner-authorized R12 telemetry is prospective and observe-only.  It rebuilds
  // the portfolio strictly from ledger events available at each entry rather
  // than reading current state, so a later position/close cannot leak backwards.
  const activeSnapshots = activePositionsAtEntryEvents(ledger);
  for (const record of entryRecords) {
    if (!isR12Position(record?.payload) || Number(record.marketTime) < R12_PORTFOLIO_TELEMETRY_PROSPECTIVE_START) continue;
    const observationId = deterministicId("factor_r12_portfolio_exposure", { eventId: record.eventId });
    if (observed.has(observationId)) continue;
    try {
      const activePositions = activeSnapshots.get(record.eventId) ?? [];
      const relationships = await buildR12RelationshipsAtEntry(record, activePositions);
      queueObservation(buildR12PortfolioExposureObservation(record, activePositions, relationships));
    } catch (error) {
      r12PortfolioTelemetryErrors.push({ eventId: record.eventId, symbol: record?.payload?.symbol ?? null, error: error.message });
    }
  }

  for (const record of entryRecords) {
    if (!isR12Position(record?.payload) || Number(record.marketTime) < R12_PORTFOLIO_TELEMETRY_PROSPECTIVE_START) continue;
    const firstPostEntryBarOpenTime = (Math.floor(Number(record.marketTime) / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS;
    for (const horizonHours of R12_POST_ENTRY_RELATIVE_PATH_HORIZONS_HOURS) {
      const observationId = deterministicId("factor_r12_post_entry_relative_path", { eventId: record.eventId, horizonHours });
      if (observed.has(observationId)) continue;
      const endTime = firstPostEntryBarOpenTime + horizonHours * HOUR_MS;
      if (now < endTime) continue;
      try {
        const [assetBars, btcBars, ethBars] = await Promise.all([
          fetchClosedFuturesBars(record.payload.symbol, firstPostEntryBarOpenTime, endTime, now),
          fetchClosedFuturesBars("BTCUSDT", firstPostEntryBarOpenTime, endTime, now),
          fetchClosedFuturesBars("ETHUSDT", firstPostEntryBarOpenTime, endTime, now),
        ]);
        queueObservation(buildR12PostEntryRelativePathObservation({ record, horizonHours, assetBars, btcBars, ethBars }));
      } catch (error) {
        r12PostEntryRelativePathErrors.push({ eventId: record.eventId, symbol: record?.payload?.symbol ?? null, horizonHours, error: error.message });
      }
    }
  }

  const canonicalCloseRecords = [...canonicalClosedPositionCommits(ledger).values()]
    .sort((first, second) => Number(first.sequence ?? 0) - Number(second.sequence ?? 0));
  const derivedCloseByStateCommitId = new Map(ledger
    .filter((record) => record?.type === "PAPER_POSITION_CLOSED" && record?.payload?.stateCommitEventId)
    .map((record) => [record.payload.stateCommitEventId, record]));
  for (const record of canonicalCloseRecords) {
    const position = record.payload.position;
    if (processedClosedPositionIds.has(position.id)) continue;
    const derivedClose = derivedCloseByStateCommitId.get(record.eventId) ?? null;
    queueObservation(buildOutcomeObservation(position, {
      // Batch legs are projections; only their parent is an original chain event.
      auditEventId: record.parentEventId ?? record.eventId,
      auditSequence: record.sequence,
      projectedStateCommitEventId: record.parentEventId ? record.eventId : null,
      derivedCloseEventId: derivedClose?.eventId ?? null,
      outcomeSource: record.parentEventId ? "CANONICAL_PORTFOLIO_POSITION_TRANSITION" : "CANONICAL_POSITION_STATE_COMMIT",
    }));
    processedClosedPositionIds.add(position.id);
  }

  for (const book of Object.values(state.books ?? {})) {
    for (const position of book.closedPositions ?? []) {
      if (processedClosedPositionIds.has(position.id)) continue;
      const positionRevision = String(position.implementationRevision ?? state.implementationRevision ?? "");
      if (positionRevision.includes("R7-DEFERRED-PROTECTIVE-STRUCTURE")) continue;
      const observation = buildOutcomeObservation(position, {
        outcomeSource: "R6_STATE_CLOSED_POSITION_LEGACY_FALLBACK",
      });
      queueObservation(observation);
      processedClosedPositionIds.add(position.id);
    }
  }

  for (const observation of additions) {
    await appendLine(paths.observations, JSON.stringify(observation));
  }
  const nextState = {
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    observationCount: observed.size,
    observedIds: [...observed].slice(-10000),
    processedEntryEventIds: [...processedEntryEventIds].slice(-2000),
    processedClosedPositionIds: [...processedClosedPositionIds].slice(-2000),
    processedReservePlanIds: [...processedReservePlanIds].slice(-2000),
    processedDualPriceShadowPlanIds: [...processedDualPriceShadowPlanIds].slice(-2000),
    latestPlanFactors,
    reserveFetchErrors: reserveFetchErrors.slice(-20),
    ohlcCrossTriggerErrors: ohlcCrossTriggerErrors.slice(-20),
    r12PortfolioTelemetryErrors: r12PortfolioTelemetryErrors.slice(-20),
    r12PostEntryRelativePathErrors: r12PostEntryRelativePathErrors.slice(-20),
    nonEntryOutcomeErrors: nonEntryOutcomeErrors.slice(-20),
    lastAdditions: additions.map((item) => ({ type: item.observationType, id: item.observationId })),
  };
  await writeJsonAtomic(paths.minerState, nextState);
  return { status: "OK", added: additions.length, observationCount: observed.size, types: additions.reduce((counts, item) => ({ ...counts, [item.observationType]: (counts[item.observationType] ?? 0) + 1 }), {}) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mineFactorSnapshot().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
