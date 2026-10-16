import {
  fourHourLineageHypotheses,
  normalizeKlines,
  structuralPairs,
  structuralPivots,
} from "../../orion-v2/paper/paper-engine.mjs";
import { intersectLines } from "../../../scripts/v2-mtf-trendline-intersection.mjs";
import { deterministicId } from "../../orion-v2/paper/runtime-utils.mjs";
import { findConfirmedZForPair, validateDualZPlanEvidence, validateSingleZPlanEvidence } from "./dual-z.mjs";
import {
  entryDecisionInterval, releasePolicy, requiresDualZ, requiresPrimaryZ, requiresSingleZ, validateDualZPolicy,
} from "./release-policy.mjs";

export const FIVE_MINUTES_MS = 5 * 60_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;
export const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;
const ENTRY_INTERVAL_MS = { "5m": FIVE_MINUTES_MS, "15m": FIFTEEN_MINUTES_MS };
const DEMO_BASE_URL = "https://demo-fapi.binance.com";

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const bpsDistance = (first, second) => Math.abs(first - second) / Math.max(Math.abs(first), Math.abs(second), Number.EPSILON) * 10_000;

export function validateHighFrequencyConfig(config) {
  const release = releasePolicy(config);
  const decisionInterval = entryDecisionInterval(config);
  const decisionConfirmationPolicy = `TWO_CONSECUTIVE_${decisionInterval.toUpperCase()}_CLOSES_SAME_SIDE_BEYOND_INTERSECTION_BUFFER`;
  const decisionCloseReference = `LATEST_EXECUTABLE_BBO_VERSUS_CONFIRMED_${decisionInterval.toUpperCase()}_DECISION_CLOSE`;
  const hf14 = requiresSingleZ(config);
  const marketStatePolicyValid = hf14
    ? config?.marketStateGate?.enabled === false && config?.marketStateGate?.executionGate === false &&
      config?.marketStateGate?.observationOnly === true && config?.marketStateGate?.requestInExecutionScan === false &&
      config?.marketStateGate?.missingEvidenceAction === "NOT_AN_EXECUTION_INPUT"
    : config?.marketStateGate?.enabled === true && config?.marketStateGate?.missingEvidenceAction === "SHADOW_ONLY_FAIL_CLOSED";
  if (config?.candidateVersion !== "ORION-V3-RESEARCH-MTFX-HF-0.5.0" ||
      !release || !validateDualZPolicy(config) ||
      config?.riskPolicyRevision !== "V3-RISK-2-AGGRESSIVE-GROWTH-1PCT-10PCT-20260820" ||
      config?.riskPolicyAuthorizationId !== "OWNER-DIRECTIVE-ORION-V3-AGGRESSIVE-GROWTH-RISK-1PCT-10PCT-20260820" ||
      config?.scanUniverseAuthorizationId !== "OWNER-DIRECTIVE-ORION-V3-V4-TIERED-SCAN-UNIVERSE30-20260820" ||
      config?.evaluationIsolation?.forwardCohortId !== release.cohort ||
      config?.evaluationIsolation?.baselineCohortId !== "ORION-V3-PRE-HF11-BASELINE-20260826" ||
      config?.shadowEvaluation?.experimentId !== "ORION-V3-HF12A-COST-GATE-SHADOW-20260830" ||
      config?.shadowEvaluation?.status !== "ACTIVE_OBSERVE_ONLY" ||
      config?.shadowEvaluation?.sourceImplementationRevision !== "MTFX-V3-HF11-TRUE-4H-MARKET-STATE-GATE" ||
      config?.shadowEvaluation?.maximumCompleteLifecycleCostR !== 0.12 ||
      config?.shadowEvaluation?.takerFeeRate !== 0.0007 ||
      config?.shadowEvaluation?.adverseSlippageRate !== 0.0002 ||
      config?.shadowEvaluation?.minimumAttributableClosedPositions !== 100 ||
      config?.shadowEvaluation?.minimumObservationsPerBucket !== 20 ||
      config?.shadowEvaluation?.historicalBackfillAllowed !== false ||
      config?.shadowEvaluation?.executionGate !== false ||
      config?.shadowEvaluation?.ordersOrPositionsAffected !== false ||
      config?.shadowEvaluation?.automaticPromotionAllowed !== false ||
      config?.shadowEvaluation?.phaseB?.recordingActive !== false ||
      config?.timeframes?.marketState !== "4h" ||
      config?.timeframes?.primaryStructure !== "1h" ||
      config?.timeframes?.opposingStructure !== "15m" ||
      config?.timeframes?.runnerTrail !== "15m" ||
      config?.timeframes?.entryDecision !== decisionInterval ||
      config?.signal?.interval !== decisionInterval ||
      config?.signal?.maximumDirectionDecisionBars !== 2 ||
      config?.signal?.maximumReserveBars !== 4 ||
      config?.signal?.crossCloseBufferBps !== 5 ||
      config?.signal?.confirmationPolicy !== decisionConfirmationPolicy ||
      config?.signal?.failedPersistenceAction !== "EXPIRE_INTERSECTION_WITHOUT_REVERSE" ||
      config?.signal?.maximumEntryDisplacementBps !== 75 ||
      config?.signal?.maximumEntrySignalAgeMs !== FIVE_MINUTES_MS ||
      config?.signal?.entryDisplacementReference !== decisionCloseReference ||
      config?.risk?.maximumRiskPerIntersectionFraction !== 0.01 ||
      config?.risk?.maximumLeverage !== 10 ||
      config?.exit?.runner?.interval !== "15m" ||
      config?.risk?.maximumPortfolioRiskFraction !== 0.1 ||
      config?.risk?.maximumOpenPositionsTotal !== 18 ||
      config?.pivots?.primary?.minimumRealtimeHierarchyMultiplier !== 4 ||
      config?.pivots?.primary?.maximumSecondAnchorAgeFraction !== 0.35 ||
      config?.pivots?.opposing?.minimumRealtimeHierarchyMultiplier !== 2 ||
      config?.pivots?.opposing?.maximumSecondAnchorAgeFraction !== 0.5 ||
      config?.intersection?.maximumPrimaryProjectionSpanMultiples !== 2 ||
      config?.intersection?.maximumOpposingProjectionSpanMultiples !== 2 ||
      config?.intersection?.minimumDiscoveryLeadMinutes !== 5 ||
      config?.intersection?.maximumLeadHours !== 6 ||
      config?.intersection?.priceProximityRequired !== false ||
      config?.intersection?.maximumDiscoveryPriceDistanceBps !== 750 ||
      config?.intersection?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
      config?.intersection?.observationCandidateAutomaticSubmissionAtDiscovery !== false ||
      config?.intersection?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
      config?.intersection?.minimumAutomaticExecutionConsensusSupport !== 1 ||
      config?.intersection?.conditionalSingleHypothesisExecution?.enabled !== false ||
      config?.intersection?.conditionalSingleHypothesisExecution?.minimumAnchorQualityScore !== 0.9 ||
      config?.intersection?.conditionalSingleHypothesisExecution?.minimumStabilityScore !== 0.7 ||
      config?.intersection?.conditionalSingleHypothesisExecution?.minimumPrimaryHierarchyMultiplier !== 4 ||
      config?.intersection?.conditionalSingleHypothesisExecution?.minimumOpposingHierarchyMultiplier !== 4 ||
      config?.intersection?.maximumQueuedCandidatesPerSymbol !== 2 ||
      config?.intersection?.maximumRankedCandidatesGlobal !== 12 ||
      config?.execution?.maximumNewEntriesPerCycle !== 2 ||
      config?.execution?.structuralDiscoveryIntervalMs !== FIVE_MINUTES_MS ||
      config?.execution?.candidatePositionAndReconciliationIntervalMs !== 60_000 ||
      config?.execution?.residentScannerAutomaticOrderSubmissionAllowed !== true ||
      config?.execution?.realOrdersAllowed !== false ||
      !marketStatePolicyValid ||
      config?.marketStateGate?.interval !== "4h" ||
      config?.marketStateGate?.source !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
      config?.marketStateGate?.requestLimit !== 500 ||
      config?.marketStateGate?.pivotPolicy?.leftBars !== 2 ||
      config?.marketStateGate?.pivotPolicy?.rightBars !== 2 ||
      JSON.stringify(config?.marketStateGate?.pivotPolicy?.hierarchyWindowMultipliers) !== "[1]" ||
      config?.marketStateGate?.comparisonRule !== "LAST_TWO_CONFIRMED_4H_HIGHS_AND_LAST_TWO_CONFIRMED_4H_LOWS" ||
      config?.marketStateGate?.longOnlyRule !== "BOTH_HIGHS_AND_LOWS_RISING" ||
      config?.marketStateGate?.shortOnlyRule !== "BOTH_HIGHS_AND_LOWS_FALLING" ||
      config?.marketStateGate?.otherwiseState !== "RANGE_OR_TRANSITION" ||
      config?.marketStateGate?.unfinishedBarsAllowed !== false ||
      config?.marketStateGate?.historicalSignalBackfillAllowed !== false ||
      config?.marketStateGate?.symbolSpecificOverridesAllowed !== false ||
      config?.reentryLineageGate?.enabled !== true ||
      !Number.isFinite(Date.parse(config?.reentryLineageGate?.enforcedFrom ?? "")) ||
      config?.reentryLineageGate?.requiredChange !== "BOTH_PRIMARY_1H_AND_OPPOSING_15M_CONFIRMED_ANCHOR_PAIRS" ||
      config?.reentryLineageGate?.missingEvidenceAction !== "FAIL_CLOSED") {
    throw new Error("V3_HIGH_FREQUENCY_CONFIG_INVALID");
  }
  return true;
}

function fourHourRelation(first, second) {
  if (!(Number.isFinite(first) && Number.isFinite(second))) return "INSUFFICIENT";
  return second > first ? "RISING" : second < first ? "FALLING" : "EQUAL";
}

function compactFourHourPivot(pivot) {
  return {
    type: pivot.type,
    openTime: pivot.time,
    price: pivot.price,
    confirmedAt: pivot.confirmedAt,
  };
}

/**
 * HF11 market state is formed only from native, fully closed Binance 4H bars.
 * The two-sided 2-left/2-right pivot rule is price-time symmetric and carries
 * no symbol thresholds or indicator inputs.
 */
export function classifyFourHourMarketState(bars, policy = {}, asOf = Date.now()) {
  const source = Array.isArray(bars) ? bars : [];
  const closed = source.filter((bar) =>
    [bar?.openTime, bar?.open, bar?.high, bar?.low, bar?.close, bar?.closeTime].every(Number.isFinite) &&
    bar.closeTime < asOf &&
    bar.closeTime - bar.openTime === FOUR_HOURS_MS - 1 &&
    bar.openTime % FOUR_HOURS_MS === 0 &&
    bar.high >= bar.low
  ).sort((first, second) => first.openTime - second.openTime);
  const hasGap = closed.some((bar, index) => index > 0 && bar.openTime - closed[index - 1].openTime !== FOUR_HOURS_MS);
  const pivotPolicy = policy?.pivotPolicy ?? { leftBars: 2, rightBars: 2, hierarchyWindowMultipliers: [1] };
  const highs = hasGap ? [] : structuralPivots(closed, "HIGH", pivotPolicy)
    .filter((pivot) => pivot.confirmedAt < asOf)
    .sort((first, second) => first.time - second.time)
    .slice(-2);
  const lows = hasGap ? [] : structuralPivots(closed, "LOW", pivotPolicy)
    .filter((pivot) => pivot.confirmedAt < asOf)
    .sort((first, second) => first.time - second.time)
    .slice(-2);
  const evidenceComplete = highs.length === 2 && lows.length === 2;
  const highRelation = evidenceComplete ? fourHourRelation(highs[0].price, highs[1].price) : "INSUFFICIENT";
  const lowRelation = evidenceComplete ? fourHourRelation(lows[0].price, lows[1].price) : "INSUFFICIENT";
  const state = highRelation === "RISING" && lowRelation === "RISING"
    ? "LONG_ONLY"
    : highRelation === "FALLING" && lowRelation === "FALLING"
      ? "SHORT_ONLY"
      : "RANGE_OR_TRANSITION";
  return {
    schemaVersion: 1,
    interval: "4h",
    source: "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC",
    state,
    directionalBias: state === "LONG_ONLY" ? 1 : state === "SHORT_ONLY" ? -1 : 0,
    evidenceStatus: evidenceComplete && !hasGap ? "CONFIRMED" : hasGap ? "BAR_GAP_DETECTED" : "INSUFFICIENT_CONFIRMED_4H_STRUCTURE",
    highRelation,
    lowRelation,
    observedAt: asOf,
    lastFullyClosedBarCloseTime: closed.at(-1)?.closeTime ?? null,
    sourceBarCount: source.length,
    fullyClosedNativeFourHourBarCount: closed.length,
    unfinishedOrNonFourHourBarsExcluded: source.length - closed.length,
    contiguous: !hasGap,
    evidence: {
      highs: highs.map(compactFourHourPivot),
      lows: lows.map(compactFourHourPivot),
    },
  };
}

export function evaluateFourHourMarketStateGate(marketState, direction = 0, now = Date.now()) {
  const state = marketState?.state;
  const observedAt = marketState?.observedAt;
  const lastClosed = marketState?.lastFullyClosedBarCloseTime;
  const expectedLastClosed = Number.isFinite(now) && now > 0
    ? Math.floor(now / FOUR_HOURS_MS) * FOUR_HOURS_MS - 1
    : null;
  const evidenceConfirmed = marketState?.interval === "4h" &&
    marketState?.source === "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" &&
    marketState?.evidenceStatus === "CONFIRMED" &&
    marketState?.contiguous === true &&
    expectedLastClosed !== null &&
    Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now &&
    Number.isFinite(lastClosed) && lastClosed >= 0 &&
    (lastClosed + 1) % FOUR_HOURS_MS === 0 && lastClosed < observedAt;
  // An internally contiguous history can still be missing its newest closed bar.
  // Check against this decision/retry time, not the candidate's discovery time.
  if (evidenceConfirmed && lastClosed !== expectedLastClosed) {
    return {
      status: "BLOCKED_STALE_4H_EVIDENCE",
      state: "RANGE_OR_TRANSITION",
      direction,
      candidateEligibleForAutomaticExecution: false,
      orderSubmissionAllowed: false,
      action: "SHADOW_ONLY_FAIL_CLOSED",
      observedAt,
      evaluatedAt: now,
      lastFullyClosedBarCloseTime: lastClosed,
      expectedLastFullyClosedBarCloseTime: expectedLastClosed,
    };
  }
  if (!evidenceConfirmed || !["LONG_ONLY", "SHORT_ONLY"].includes(state)) {
    return {
      status: evidenceConfirmed ? "BLOCKED_RANGE_OR_TRANSITION" : "BLOCKED_INSUFFICIENT_4H_EVIDENCE",
      state: "RANGE_OR_TRANSITION",
      direction,
      candidateEligibleForAutomaticExecution: false,
      orderSubmissionAllowed: false,
      action: "SHADOW_ONLY_FAIL_CLOSED",
    };
  }
  const allowedDirection = state === "LONG_ONLY" ? 1 : -1;
  if (![-1, 1].includes(Number(direction))) {
    return {
      status: "WAITING_FOR_5M_DIRECTION",
      state,
      direction: 0,
      allowedDirection,
      candidateEligibleForAutomaticExecution: true,
      orderSubmissionAllowed: false,
      action: "RETAIN_CANDIDATE_PENDING_HF10_CONFIRMATION",
    };
  }
  const allowed = Number(direction) === allowedDirection;
  return {
    status: allowed ? "ALLOWED" : "BLOCKED_DIRECTION_MISMATCH",
    state,
    direction: Number(direction),
    allowedDirection,
    candidateEligibleForAutomaticExecution: allowed,
    orderSubmissionAllowed: allowed,
    action: allowed ? "AUTOMATIC_EXECUTION_GATE_PASSED" : "SHADOW_ONLY_FAIL_CLOSED",
  };
}

export function applyFourHourMarketStateGate(plan, entryDecision, now = Date.now()) {
  const baseAutomaticExecutionAllowed = plan?.intersectionQuality?.baseAutomaticExecutionAllowed ??
    plan?.intersectionQuality?.automaticExecutionAllowed === true;
  const quality = plan?.intersectionQuality;
  const baseAction = quality?.baseAction ??
    (!String(quality?.action ?? "").startsWith("HF11_4H_MARKET_STATE_")
      ? quality?.action
      : quality?.conditionalSingleHypothesisExecutionAllowed
        ? "CONDITIONAL_SINGLE_HIGH_QUALITY_HYPOTHESIS_AUTOMATIC_EXECUTION_ELIGIBLE"
        : quality?.freshExecutionBboPromotionRequired
          ? "OBSERVATION_QUEUE_FRESH_BBO_PROMOTION_REQUIRED"
          : "FORMAL_CANDIDATE_AUTOMATIC_EXECUTION_ELIGIBLE");
  const marketStateGate = evaluateFourHourMarketStateGate(plan?.marketState4h, entryDecision?.direction, now);
  const automaticExecutionAllowed = baseAutomaticExecutionAllowed && marketStateGate.candidateEligibleForAutomaticExecution;
  return {
    ...plan,
    marketStateGate,
    intersectionQuality: {
      ...plan.intersectionQuality,
      baseAutomaticExecutionAllowed,
      baseAction,
      automaticExecutionAllowed,
      action: !baseAutomaticExecutionAllowed || automaticExecutionAllowed
        ? baseAction
        : `HF11_4H_MARKET_STATE_${marketStateGate.status}`,
    },
    entryDecision: {
      ...entryDecision,
      orderSubmissionAllowed: entryDecision?.orderSubmissionAllowed === true && marketStateGate.orderSubmissionAllowed,
      marketStateGateStatus: marketStateGate.status,
    },
  };
}

export function applyReleaseMarketStateGate(plan, entryDecision, config, now = Date.now()) {
  if (!requiresSingleZ(config)) return applyFourHourMarketStateGate(plan, entryDecision, now);
  const marketStateGate = {
    status: "OBSERVE_ONLY_NOT_EXECUTION_INPUT",
    state: plan?.marketState4h?.state ?? "UNAVAILABLE",
    direction: Number(entryDecision?.direction ?? 0),
    candidateEligibleForAutomaticExecution: true,
    orderSubmissionAllowed: entryDecision?.orderSubmissionAllowed === true,
    action: "HF14_4H_DIRECTION_GATE_REVOKED_BY_OWNER",
    evaluatedAt: now,
  };
  return {
    ...plan,
    marketStateGate,
    entryDecision: {
      ...entryDecision,
      marketStateGateStatus: marketStateGate.status,
    },
  };
}

export function evaluatePairRangeGuard(pair, policy = {}) {
  const hierarchyMultiplier = Number(pair?.hierarchyMultiplier ?? 0);
  const secondAnchorAgeFraction = Number(pair?.secondAnchorAgeFraction);
  const minimumHierarchyMultiplier = Number(policy?.minimumRealtimeHierarchyMultiplier ?? 1);
  const maximumSecondAnchorAgeFraction = Number(policy?.maximumSecondAnchorAgeFraction ?? 1);
  const reasons = [];
  if (!(hierarchyMultiplier >= minimumHierarchyMultiplier)) reasons.push("ANCHOR_HIERARCHY_BELOW_MINIMUM");
  if (!(secondAnchorAgeFraction >= 0 && secondAnchorAgeFraction <= maximumSecondAnchorAgeFraction)) {
    reasons.push("SECOND_ANCHOR_OUTSIDE_MAXIMUM_AGE");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    hierarchyMultiplier,
    minimumHierarchyMultiplier,
    secondAnchorAgeFraction,
    maximumSecondAnchorAgeFraction,
  };
}

export function evaluateIntersectionRangeGuard({ primary, opposing, cross, discoveryReferencePrice, config }) {
  const primarySpan = Number(primary?.span15m);
  const opposingSpan = Number(opposing?.span15m);
  const primaryLatestAnchor = Number(primary?.second?.coordinate15m);
  const opposingLatestAnchor = Number(opposing?.second?.coordinate15m);
  const primaryProjectionSpanMultiples = primarySpan > 0
    ? (Number(cross?.time) - primaryLatestAnchor) / primarySpan
    : Infinity;
  const opposingProjectionSpanMultiples = opposingSpan > 0
    ? (Number(cross?.time) - opposingLatestAnchor) / opposingSpan
    : Infinity;
  const discoveryPriceDistanceBps = Number(cross?.price) > 0 && Number(discoveryReferencePrice) > 0
    ? Math.abs(Number(discoveryReferencePrice) - Number(cross.price)) / Number(cross.price) * 10_000
    : Infinity;
  const maximumPrimaryProjectionSpanMultiples = Number(config?.intersection?.maximumPrimaryProjectionSpanMultiples);
  const maximumOpposingProjectionSpanMultiples = Number(config?.intersection?.maximumOpposingProjectionSpanMultiples);
  const maximumDiscoveryPriceDistanceBps = Number(config?.intersection?.maximumDiscoveryPriceDistanceBps);
  const maximumFormalCandidateDiscoveryDistanceBps = Number(config?.intersection?.maximumFormalCandidateDiscoveryDistanceBps);
  const reasons = [];
  if (!(primaryProjectionSpanMultiples >= 0 && primaryProjectionSpanMultiples <= maximumPrimaryProjectionSpanMultiples)) {
    reasons.push("PRIMARY_LINE_PROJECTION_OUTSIDE_RANGE");
  }
  if (!(opposingProjectionSpanMultiples >= 0 && opposingProjectionSpanMultiples <= maximumOpposingProjectionSpanMultiples)) {
    reasons.push("OPPOSING_LINE_PROJECTION_OUTSIDE_RANGE");
  }
  if (config?.intersection?.priceProximityRequired === true &&
      !(discoveryPriceDistanceBps <= maximumDiscoveryPriceDistanceBps)) {
    reasons.push("INTERSECTION_PRICE_OUTSIDE_DISCOVERY_RANGE");
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    primaryProjectionSpanMultiples,
    opposingProjectionSpanMultiples,
    maximumPrimaryProjectionSpanMultiples,
    maximumOpposingProjectionSpanMultiples,
    discoveryReferencePrice: Number(discoveryReferencePrice),
    discoveryPriceDistanceBps,
    maximumDiscoveryPriceDistanceBps,
    maximumFormalCandidateDiscoveryDistanceBps,
    discoveryTier: discoveryPriceDistanceBps <= maximumFormalCandidateDiscoveryDistanceBps
      ? "FORMAL_CANDIDATE"
      : "OBSERVATION_CANDIDATE",
    automaticSubmissionAtDiscovery: discoveryPriceDistanceBps <= maximumFormalCandidateDiscoveryDistanceBps,
    freshExecutionBboPromotionRequired: discoveryPriceDistanceBps > maximumFormalCandidateDiscoveryDistanceBps,
  };
}

function dualZPriority(first, second) {
  const firstPrimary = first?.dualZ?.primary ?? first?.singleZ?.primary;
  const secondPrimary = second?.dualZ?.primary ?? second?.singleZ?.primary;
  if (!firstPrimary || !secondPrimary) return 0;
  const firstDistance = first?.dualZ?.opposing
    ? Math.max(firstPrimary.priceDistanceBps, first.dualZ.opposing.priceDistanceBps)
    : firstPrimary.priceDistanceBps;
  const secondDistance = second?.dualZ?.opposing
    ? Math.max(secondPrimary.priceDistanceBps, second.dualZ.opposing.priceDistanceBps)
    : secondPrimary.priceDistanceBps;
  return secondPrimary.points.D.time - firstPrimary.points.D.time ||
    firstDistance - secondDistance || secondPrimary.spanBars - firstPrimary.spanBars ||
    secondPrimary.amplitudeFraction - firstPrimary.amplitudeFraction;
}

function candidatePriority(first, second) {
  return dualZPriority(first, second) || Number(second.primaryLineStatus === "ACTIVE_1H_TREND") - Number(first.primaryLineStatus === "ACTIVE_1H_TREND") ||
    Number(second.anchorConsensus?.stabilityScore ?? 0) - Number(first.anchorConsensus?.stabilityScore ?? 0) ||
    Number(second.anchorQualityScore ?? 0) - Number(first.anchorQualityScore ?? 0) ||
    Number(first.intersectionTime) - Number(second.intersectionTime) ||
    String(first.id).localeCompare(String(second.id));
}

/**
 * HF10 keeps time-distinct opportunities, then ranks the global near-term queue.
 * Stability is a duplicate-window selector, never a reason to erase an earlier,
 * non-overlapping opportunity.
 */
export function selectHighFrequencyCandidateQueue(evaluated, config) {
  const maximum = Number(config.intersection.maximumQueuedCandidatesPerSymbol);
  const maximumGlobal = Number(config.intersection.maximumRankedCandidatesGlobal ?? Infinity);
  const perSymbolRetained = [];
  const candidateSelectionAudit = [];
  const bySymbol = new Map();
  for (const plan of evaluated) {
    const plans = bySymbol.get(plan.symbol) ?? [];
    plans.push(plan);
    bySymbol.set(plan.symbol, plans);
  }

  for (const [symbol, symbolPlans] of bySymbol) {
    const chronological = [...symbolPlans].sort((a, b) =>
      Number(a.lockedBarOpenTime) - Number(b.lockedBarOpenTime) || candidatePriority(a, b));
    const components = [];
    for (const plan of chronological) {
      const start = Number(plan.lockedBarOpenTime);
      const end = Number(plan.directionDecisionDeadline);
      const current = components.at(-1);
      if (!current || start > current.maximumEnd) {
        components.push({ plans: [plan], maximumEnd: end });
      } else {
        current.plans.push(plan);
        current.maximumEnd = Math.max(current.maximumEnd, end);
      }
    }

    const windowWinners = components.map((component) => {
      const ranked = [...component.plans].sort(candidatePriority);
      const winner = ranked[0];
      for (const suppressed of ranked.slice(1)) {
        candidateSelectionAudit.push({
          symbol,
          suppressedPlanId: suppressed.id,
          retainedPlanId: winner.id,
          reason: "OVERLAPPING_DECISION_WINDOW_LOWER_PRIORITY",
        });
      }
      return winner;
    }).sort((a, b) => Number(a.intersectionTime) - Number(b.intersectionTime) || candidatePriority(a, b));

    const queued = windowWinners.slice(0, maximum);
    for (const suppressed of windowWinners.slice(maximum)) {
      candidateSelectionAudit.push({
        symbol,
        suppressedPlanId: suppressed.id,
        retainedPlanId: null,
        reason: "SYMBOL_CANDIDATE_QUEUE_CAPACITY",
      });
    }
    queued.forEach((plan, index) => perSymbolRetained.push({
      ...plan,
      candidateQueue: {
        position: index + 1,
        size: queued.length,
        maximum,
        policy: config.intersection.candidateQueuePolicy,
      },
    }));
  }

  const globallyRanked = perSymbolRetained.sort((a, b) =>
    Number(b.intersectionQuality?.automaticExecutionAllowed === true) - Number(a.intersectionQuality?.automaticExecutionAllowed === true) ||
    Number(b.primaryLineStatus === "ACTIVE_1H_TREND") - Number(a.primaryLineStatus === "ACTIVE_1H_TREND") ||
    Number(a.intersectionTime) - Number(b.intersectionTime) ||
    Number(a.intersectionRange?.discoveryPriceDistanceBps ?? Infinity) - Number(b.intersectionRange?.discoveryPriceDistanceBps ?? Infinity) ||
    candidatePriority(a, b));
  const retained = globallyRanked.slice(0, maximumGlobal);
  for (const suppressed of globallyRanked.slice(maximumGlobal)) {
    candidateSelectionAudit.push({
      symbol: suppressed.symbol,
      suppressedPlanId: suppressed.id,
      retainedPlanId: null,
      reason: "GLOBAL_CANDIDATE_QUEUE_CAPACITY",
    });
  }
  const globalSize = retained.length;

  return {
    plans: retained.map((plan, index) => ({
      ...plan,
      candidateQueue: {
        ...plan.candidateQueue,
        globalPosition: index + 1,
        globalSize,
        maximumGlobal,
      },
    })),
    candidateSelectionAudit,
  };
}

function pivotSets(bars, policy) {
  return {
    highs: structuralPivots(bars, "HIGH", policy),
    lows: structuralPivots(bars, "LOW", policy),
  };
}

function zPairPriority(first, second) {
  return second.z.points.D.time - first.z.points.D.time || first.z.priceDistanceBps - second.z.priceDistanceBps ||
    second.z.spanBars - first.z.spanBars || second.z.amplitudeFraction - first.z.amplitudeFraction ||
    second.qualityScore - first.qualityScore;
}

function pairsFor(pattern, primaryBars, opposingBars, config, now) {
  const primaryPivots = pivotSets(primaryBars, config.pivots.primary);
  const opposingPivots = pivotSets(opposingBars, config.pivots.opposing);
  const primarySource = pattern.primaryType === "HIGH" ? primaryPivots.highs : primaryPivots.lows;
  const primaryOpposite = pattern.primaryType === "HIGH" ? primaryPivots.lows : primaryPivots.highs;
  const opposingSource = pattern.opposingType === "HIGH" ? opposingPivots.highs : opposingPivots.lows;
  const opposingOpposite = pattern.opposingType === "HIGH" ? opposingPivots.lows : opposingPivots.highs;
  let primaryPairs = structuralPairs(primarySource, primaryOpposite, primaryBars, pattern.primaryDirection, config.pivots.primary)
    .filter((pair) => evaluatePairRangeGuard(pair, config.pivots.primary).eligible);
  let opposingPairs = structuralPairs(opposingSource, opposingOpposite, opposingBars, pattern.opposingDirection, config.pivots.opposing)
    .filter((pair) => evaluatePairRangeGuard(pair, config.pivots.opposing).eligible);
  if (requiresPrimaryZ(config)) {
    const attach = (pair, bars, direction, interval, policy) => ({ ...pair, z: findConfirmedZForPair({ pair, bars, direction, interval, policy, asOf: now, referencePrice: Number(opposingBars.at(-1)?.close) }) });
    primaryPairs = primaryPairs.map((pair) => attach(pair, primaryBars, pattern.primaryDirection, "1h", config.pivots.primary)).filter((pair) => pair.z).sort(zPairPriority);
    opposingPairs = opposingPairs.map((pair) => requiresDualZ(config)
      ? attach(pair, opposingBars, pattern.opposingDirection, "15m", config.pivots.opposing)
      : { ...pair, comparisonZ: findConfirmedZForPair({ pair, bars: opposingBars, direction: pattern.opposingDirection,
        interval: "15m", policy: config.pivots.opposing, asOf: now, referencePrice: Number(opposingBars.at(-1)?.close) }) });
    if (requiresDualZ(config)) opposingPairs = opposingPairs.filter((pair) => pair.z).sort(zPairPriority);
    return { primaryLineages: primaryPairs.map((pair, index) => ({ ...pair, lineageStatus: index === 0 ? "ACTIVE_1H_TREND" : "PREVIOUS_1H_CANDIDATE" })), opposingPairs };
  }
  const primaryLineages = fourHourLineageHypotheses(primaryPairs, config.pivots.primary).map((pair) => ({
    ...pair,
    lineageStatus: pair.lineageStatus === "ACTIVE_4H_TREND" ? "ACTIVE_1H_TREND" : "PREVIOUS_1H_CANDIDATE",
  }));
  return { primaryLineages, opposingPairs };
}

function rawCandidates(symbol, primaryBars, opposingBars, marketState4h, config, now) {
  if (requiresPrimaryZ(config) && now < Date.parse(config.dualZ.forwardOnlyFrom)) return [];
  const decisionIntervalMs = ENTRY_INTERVAL_MS[entryDecisionInterval(config)];
  const minimumTime = now + Number(config.intersection.minimumDiscoveryLeadMinutes) * 60_000;
  const maximumTime = now + Number(config.intersection.maximumLeadHours) * ONE_HOUR_MS;
  const discoveryReferencePrice = Number(opposingBars.at(-1)?.close);
  const result = [];
  for (const pattern of config.patterns) {
    const { primaryLineages, opposingPairs } = pairsFor(pattern, primaryBars, opposingBars, config, now);
    for (const primary of primaryLineages.slice(0, config.intersection.primaryPairCandidates)) {
      for (const opposing of opposingPairs.slice(0, config.intersection.opposingPairCandidates)) {
        const cross = intersectLines(primary.line, opposing.line, config.intersection.minimumSlopeDifferencePer5m);
        if (!cross.valid) continue;
        const intersectionRange = evaluateIntersectionRangeGuard({ primary, opposing, cross, discoveryReferencePrice, config });
        if (!intersectionRange.eligible) continue;
        const intersectionTime = cross.time * FIFTEEN_MINUTES_MS;
        if (intersectionTime < minimumTime || intersectionTime > maximumTime) continue;
        const latestConfirmation = Math.max(primary.first.confirmedAt, primary.second.confirmedAt, opposing.first.confirmedAt, opposing.second.confirmedAt, primary.z?.confirmedAt ?? 0, requiresDualZ(config) ? opposing.z?.confirmedAt ?? 0 : 0);
        if (latestConfirmation >= intersectionTime) continue;
        const containingOpen = Math.floor(intersectionTime / decisionIntervalMs) * decisionIntervalMs;
        const boundaryDistance = Math.min(intersectionTime - containingOpen, containingOpen + decisionIntervalMs - intersectionTime);
        if (boundaryDistance < config.intersection.ambiguousBoundaryMs) continue;
        const anchors = [primary.first, primary.second, opposing.first, opposing.second].map((pivot) => ({
          type: pivot.type,
          time: pivot.time,
          price: pivot.price,
          confirmedAt: pivot.confirmedAt,
          hierarchyMultiplier: pivot.hierarchyMultiplier,
          prominenceAbsolute: pivot.prominenceAbsolute,
        }));
        const anchorQualityScore = (Number(primary.qualityScore) + Number(opposing.qualityScore)) / 2;
        const dualZ = requiresDualZ(config) ? { schemaVersion: 1, status: "CONFIRMED", primary: primary.z, opposing: opposing.z, confirmedAt: latestConfirmation } : null;
        const singleZ = requiresSingleZ(config) ? { schemaVersion: 1, status: "CONFIRMED", primary: primary.z, confirmedAt: primary.z.confirmedAt } : null;
        const dualZComparison = requiresSingleZ(config) ? {
          schemaVersion: 1,
          status: opposing.comparisonZ?.confirmedAt < intersectionTime ? "WOULD_PASS_HF13_DUAL_Z_FILTER" : "WOULD_FAIL_HF13_DUAL_Z_FILTER",
          primaryConfirmed: true,
          opposingConfirmed: Boolean(opposing.comparisonZ?.confirmedAt < intersectionTime),
          evaluatedAt: now,
          executionInput: false,
          rankingInput: false,
        } : null;
        const identity = { symbol, pattern: pattern.id, anchors: anchors.map(({ type, time, price }) => ({ type, time, price })) };
        if (dualZ) Object.assign(identity, { implementationRevision: config.implementationRevision, zPoints: [primary.z, opposing.z].map((z) => Object.values(z.points).map(({ type, time, price, confirmedAt }) => ({ type, time, price, confirmedAt }))) });
        if (singleZ) Object.assign(identity, { implementationRevision: config.implementationRevision,
          zPoints: [Object.values(primary.z.points).map(({ type, time, price, confirmedAt }) => ({ type, time, price, confirmedAt }))] });
        result.push({
          id: deterministicId("v3hf_cross", identity),
          symbol,
          pattern: pattern.id,
          primaryLineStatus: primary.lineageStatus,
          intersectionTime,
          intersectionPrice: cross.price,
          lockedBarOpenTime: containingOpen,
          directionDecisionDeadline: containingOpen + 2 * decisionIntervalMs - 1,
          reserveDeadline: containingOpen + Number(config.signal.maximumReserveBars) * decisionIntervalMs - 1,
          latestConfirmation,
          anchorQualityScore,
          anchors,
          ...(dualZ ? { dualZ } : {}),
          ...(singleZ ? { singleZ, dualZComparison } : {}),
          intersectionRange,
          scale: {
            primaryHierarchyMultiplier: primary.hierarchyMultiplier,
            opposingHierarchyMultiplier: opposing.hierarchyMultiplier,
            primaryAnchorProminenceFraction: primary.anchorProminenceFraction,
            opposingAnchorProminenceFraction: opposing.anchorProminenceFraction,
            primaryPairMoveFraction: primary.pairMoveFraction,
            opposingPairMoveFraction: opposing.pairMoveFraction,
          },
          marketState4h,
        });
      }
    }
  }
  return result;
}

function clusterCandidates(candidates, config) {
  const radiusMs = Number(config.intersection.anchorConsensus.clusterTimeRadiusMinutes) * 60_000;
  const priceRadiusBps = Number(config.intersection.anchorConsensus.clusterPriceRadiusBps);
  const seen = new Set();
  const clusters = [];
  for (const seed of candidates) {
    const members = candidates.filter((candidate) =>
      candidate.pattern === seed.pattern && candidate.primaryLineStatus === seed.primaryLineStatus &&
      Math.abs(candidate.intersectionTime - seed.intersectionTime) <= radiusMs &&
      bpsDistance(candidate.intersectionPrice, seed.intersectionPrice) <= priceRadiusBps);
    const signature = members.map((member) => member.id).sort().join("|");
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    const canonical = [...members].sort((a, b) =>
      dualZPriority(a, b) || Number(b.primaryLineStatus === "ACTIVE_1H_TREND") - Number(a.primaryLineStatus === "ACTIVE_1H_TREND") ||
      b.anchorQualityScore - a.anchorQualityScore || a.intersectionTime - b.intersectionTime)[0];
    const times = members.map((member) => member.intersectionTime);
    const prices = members.map((member) => member.intersectionPrice);
    const timeTightness = 1 - clamp01((Math.max(...times) - Math.min(...times)) / (2 * radiusMs));
    const priceTightness = 1 - clamp01(bpsDistance(Math.max(...prices), Math.min(...prices)) / priceRadiusBps);
    const supportScore = clamp01(members.length / Number(config.intersection.anchorConsensus.highStabilityMinimumSupport));
    const averageQuality = members.reduce((sum, member) => sum + member.anchorQualityScore, 0) / members.length;
    const stabilityScore = clamp01(0.4 * supportScore + 0.2 * timeTightness + 0.15 * priceTightness + 0.25 * averageQuality);
    const thresholds = config.intersection.anchorConsensus.gradeThresholds;
    const rawGrade = stabilityScore >= thresholds.high ? "HIGH" : stabilityScore >= thresholds.medium ? "MEDIUM" : "LOW";
    const minimumAutomaticExecutionConsensusSupport = Number(config.intersection.minimumAutomaticExecutionConsensusSupport);
    const consensusExecutionAllowed = members.length >= minimumAutomaticExecutionConsensusSupport;
    const minimumClusterDiscoveryPriceDistanceBps = Math.min(...members.map((member) => Number(member.intersectionRange?.discoveryPriceDistanceBps ?? Infinity)));
    const automaticSubmissionAtDiscovery = members.some((member) => member.intersectionRange?.automaticSubmissionAtDiscovery === true);
    const freshExecutionBboPromotionRequired = !automaticSubmissionAtDiscovery;
    const singlePolicy = config.intersection.conditionalSingleHypothesisExecution ?? {};
    const conditionalSingleHypothesisExecutionAllowed = members.length === 1 && singlePolicy.enabled === true &&
      averageQuality >= Number(singlePolicy.minimumAnchorQualityScore) &&
      stabilityScore >= Number(singlePolicy.minimumStabilityScore) &&
      Number(canonical.scale?.primaryHierarchyMultiplier) >= Number(singlePolicy.minimumPrimaryHierarchyMultiplier) &&
      Number(canonical.scale?.opposingHierarchyMultiplier) >= Number(singlePolicy.minimumOpposingHierarchyMultiplier);
    const automaticExecutionAllowed = consensusExecutionAllowed || conditionalSingleHypothesisExecutionAllowed;
    const grade = automaticExecutionAllowed ? rawGrade : "LOW";
    clusters.push({
      ...canonical,
      intersectionRange: {
        ...canonical.intersectionRange,
        minimumClusterDiscoveryPriceDistanceBps,
        discoveryTier: automaticSubmissionAtDiscovery ? "FORMAL_CANDIDATE" : "OBSERVATION_CANDIDATE",
        automaticSubmissionAtDiscovery,
        freshExecutionBboPromotionRequired,
      },
      anchorConsensus: {
        support: members.length,
        stabilityScore,
        grade,
        rawGrade,
        timeWindowMinutes: (Math.max(...times) - Math.min(...times)) / 60_000,
        priceDispersionBps: bpsDistance(Math.max(...prices), Math.min(...prices)),
      },
      intersectionQuality: {
        automaticExecutionAllowed,
        consensusExecutionAllowed,
        conditionalSingleHypothesisExecutionAllowed,
        automaticSubmissionAtDiscovery,
        freshExecutionBboPromotionRequired,
        minimumAutomaticExecutionConsensusSupport,
        action: !automaticExecutionAllowed
          ? "OBSERVE_ONLY_INSUFFICIENT_ANCHOR_CONSENSUS"
          : conditionalSingleHypothesisExecutionAllowed
            ? "CONDITIONAL_SINGLE_HIGH_QUALITY_HYPOTHESIS_AUTOMATIC_EXECUTION_ELIGIBLE"
          : freshExecutionBboPromotionRequired
            ? "OBSERVATION_QUEUE_FRESH_BBO_PROMOTION_REQUIRED"
            : "FORMAL_CANDIDATE_AUTOMATIC_EXECUTION_ELIGIBLE",
      },
    });
  }
  return clusters.sort(candidatePriority);
}

export function discoverHighFrequencyCandidates({ symbol, primaryBars, opposingBars, marketState4h, config, now }) {
  validateHighFrequencyConfig(config);
  return clusterCandidates(rawCandidates(symbol, primaryBars, opposingBars, marketState4h, config, now), config);
}

export function evaluateEntryDecision(plan, bars, bufferBps = 5, now = Date.now(), interval = "5m") {
  const decisionIntervalMs = ENTRY_INTERVAL_MS[interval];
  if (!decisionIntervalMs) throw new Error("V3_ENTRY_DECISION_INTERVAL_INVALID");
  const relevant = bars.filter((bar) => bar.openTime === plan.lockedBarOpenTime || bar.openTime === plan.lockedBarOpenTime + decisionIntervalMs)
    .sort((a, b) => a.openTime - b.openTime);
  const upper = plan.intersectionPrice * (1 + bufferBps / 10_000);
  const lower = plan.intersectionPrice * (1 - bufferBps / 10_000);
  if (now < plan.intersectionTime) return { status: "WAITING_FOR_CROSS", direction: 0, orderSubmissionAllowed: false };
  if (!relevant.length) return { status: `WAITING_FIRST_${interval.toUpperCase()}_CLOSE`, direction: 0, orderSubmissionAllowed: false };
  const side = (bar) => bar.close >= upper ? 1 : bar.close <= lower ? -1 : 0;
  const firstSide = side(relevant[0]);
  if (firstSide === 0) return { status: "EXPIRED_FIRST_CLOSE_NOT_CONFIRMED", direction: 0, orderSubmissionAllowed: false };
  if (relevant.length === 1 && now <= plan.directionDecisionDeadline) {
    return {
      status: "WAITING_SECOND_PERSISTENCE_CLOSE",
      direction: 0,
      armedDirection: firstSide,
      firstDecisionBarOpenTime: relevant[0].openTime,
      firstDecisionBarCloseTime: relevant[0].closeTime,
      orderSubmissionAllowed: false,
    };
  }
  const second = relevant[1];
  if (!second || side(second) !== firstSide) {
    return { status: "EXPIRED_SECOND_CLOSE_NOT_PERSISTENT", direction: 0, armedDirection: firstSide, orderSubmissionAllowed: false };
  }
  return {
    status: firstSide === 1 ? "CONFIRMED_LONG" : "CONFIRMED_SHORT",
    direction: firstSide,
    decisionBarNumber: 2,
    decisionBarOpenTime: second.openTime,
    decisionBarCloseTime: second.closeTime,
    decisionClose: second.close,
    firstDecisionBarOpenTime: relevant[0].openTime,
    firstDecisionBarCloseTime: relevant[0].closeTime,
    firstDecisionClose: relevant[0].close,
    initialStop: firstSide === 1 ? lower : upper,
    confirmationInterval: interval,
    confirmationPolicy: `TWO_CONSECUTIVE_${interval.toUpperCase()}_CLOSES_SAME_SIDE_BEYOND_INTERSECTION_BUFFER`,
    orderSubmissionAllowed: true,
  };
}

export function evaluateFiveMinuteEntry(plan, bars, bufferBps = 5, now = Date.now()) {
  return evaluateEntryDecision(plan, bars, bufferBps, now, "5m");
}

export function applyDualZPlanGate(plan, config, now) {
  if (!requiresPrimaryZ(config)) return plan;
  const single = requiresSingleZ(config);
  const check = single ? validateSingleZPlanEvidence(plan, { now }) : validateDualZPlanEvidence(plan, { now });
  const afterCutover = Number(plan?.firstDiscoveredAt) >= Date.parse(config.dualZ.forwardOnlyFrom);
  const allowed = check.allowed && afterCutover;
  const reason = afterCutover ? check.reason : single ? "SINGLE_Z_BEFORE_FORWARD_CUTOFF" : "DUAL_Z_BEFORE_FORWARD_CUTOFF";
  const gateName = single ? "singleZGate" : "dualZGate";
  const decisionGateName = single ? "singleZGateStatus" : "dualZGateStatus";
  return {
    ...plan,
    [gateName]: { allowed, reason, evaluatedAt: now },
    intersectionQuality: {
      ...plan.intersectionQuality,
      automaticExecutionAllowed: allowed && plan.intersectionQuality?.automaticExecutionAllowed === true,
      ...(allowed ? {} : { action: reason }),
    },
    entryDecision: { ...plan.entryDecision, orderSubmissionAllowed: allowed && plan.entryDecision?.orderSubmissionAllowed === true, [decisionGateName]: reason },
  };
}

export function refreshSingleZPlanEvidence(plan, primaryBars, opposingBars, config, now) {
  if (!requiresSingleZ(config)) return plan;
  if (!plan?.singleZ?.primary || !Array.isArray(primaryBars) || !Array.isArray(opposingBars)) return null;
  const old = plan.singleZ.primary;
  if (!(old.observedAt <= now) || !validateSingleZPlanEvidence(plan, { now: old.observedAt }).allowed) return null;
  const pattern = config.patterns.find((row) => row.id === plan.pattern);
  if (!pattern || ["A", "B", "C", "D"].some((name) => !old.points?.[name])) return null;
  const [,, opposingA, opposingC] = plan.anchors ?? [];
  const exactOpposingPair = (bars) => {
    const pivots = pivotSets(bars, config.pivots.opposing);
    const source = pattern.opposingType === "HIGH" ? pivots.highs : pivots.lows;
    const opposite = pattern.opposingType === "HIGH" ? pivots.lows : pivots.highs;
    return structuralPairs(source, opposite, bars, pattern.opposingDirection, config.pivots.opposing)
      .filter((pair) => evaluatePairRangeGuard(pair, config.pivots.opposing).eligible)
      .find((pair) => [pair.first, pair.second].every((point, index) => {
        const originalPoint = index === 0 ? opposingA : opposingC;
        return ["type", "time", "price"].every((key) => point?.[key] === originalPoint?.[key]);
      }));
  };
  if (!exactOpposingPair(opposingBars)) return null;
  const opposingDiscoveryBars = opposingBars.filter((bar) => bar.closeTime < plan.firstDiscoveredAt);
  const originalOpposingPair = exactOpposingPair(opposingDiscoveryBars);
  const opposingEvidenceKeys = ["type", "time", "price", "confirmedAt", "hierarchyMultiplier", "prominenceAbsolute"];
  if (!originalOpposingPair || [originalOpposingPair.first, originalOpposingPair.second].some((point, index) => {
    const originalPoint = index === 0 ? opposingA : opposingC;
    return opposingEvidenceKeys.some((key) => point?.[key] !== originalPoint?.[key]);
  })) return null;
  const pivots = structuralPivots(primaryBars, pattern.primaryDirection === 1 ? "LOW" : "HIGH", config.pivots.primary);
  const anchor = (name) => pivots.find((point) => point.time === old.points[name].time && point.price === old.points[name].price);
  const current = findConfirmedZForPair({ pair: { first: anchor("A"), second: anchor("C") }, bars: primaryBars,
    direction: pattern.primaryDirection, interval: "1h", policy: config.pivots.primary, asOf: now,
    referencePrice: Number(plan?.dualZComparison?.referencePrice ?? plan?.intersectionPrice) });
  if (!current || Object.keys(current.points).some((name) => ["type", "time", "price"].some((key) => current.points[name][key] !== old.points[name]?.[key]))) return null;
  const discoveryBars = primaryBars.filter((bar) => bar.closeTime < plan.firstDiscoveredAt);
  const discoveryPivots = structuralPivots(discoveryBars, pattern.primaryDirection === 1 ? "LOW" : "HIGH", config.pivots.primary);
  const originalAnchor = (name) => discoveryPivots.find((point) => point.time === old.points[name].time && point.price === old.points[name].price);
  const original = findConfirmedZForPair({ pair: { first: originalAnchor("A"), second: originalAnchor("C") }, bars: discoveryBars,
    direction: pattern.primaryDirection, interval: "1h", policy: config.pivots.primary, asOf: plan.firstDiscoveredAt,
    referencePrice: Number(plan?.dualZComparison?.referencePrice ?? plan?.intersectionPrice) });
  const originalKeys = ["type", "time", "price", "confirmedAt", "baseConfirmedAt", "hierarchyMultiplier", "hierarchySpanBars"];
  if (!original || original.confirmedAt !== old.confirmedAt || Object.keys(original.points)
    .some((name) => originalKeys.some((key) => original.points[name][key] !== old.points[name]?.[key]))) return null;
  const updated = { ...plan, singleZ: { ...plan.singleZ, primary: { ...current, points: original.points, confirmedAt: original.confirmedAt }, confirmedAt: original.confirmedAt } };
  return validateSingleZPlanEvidence(updated, { now }).allowed ? updated : null;
}

export function refreshDualZPlanEvidence(plan, primaryBars, opposingBars, config, now) {
  if (!requiresDualZ(config)) return plan;
  if (!plan?.dualZ || !Array.isArray(primaryBars) || !Array.isArray(opposingBars)) return null;
  const previousObservation = Math.max(plan.dualZ.primary?.observedAt, plan.dualZ.opposing?.observedAt);
  if (!(previousObservation <= now) || !validateDualZPlanEvidence(plan, { now: previousObservation }).allowed) return null;
  const pattern = config.patterns.find((row) => row.id === plan.pattern);
  if (!pattern) return null;
  const renewed = {};
  for (const [name, bars, direction, interval, policy] of [
    ["primary", primaryBars, pattern.primaryDirection, "1h", config.pivots.primary],
    ["opposing", opposingBars, pattern.opposingDirection, "15m", config.pivots.opposing],
  ]) {
    const old = plan.dualZ[name];
    if (!old?.points || ["A", "B", "C", "D"].some((name) => !old.points[name] || !Number.isFinite(old.points[name].time) || !Number.isFinite(old.points[name].price) || !Number.isFinite(old.points[name].confirmedAt))) return null;
    const pivots = structuralPivots(bars, direction === 1 ? "LOW" : "HIGH", policy);
    const anchor = (name) => pivots.find((point) => point.time === old.points[name].time && point.price === old.points[name].price);
    const z = findConfirmedZForPair({ pair: { first: anchor("A"), second: anchor("C") }, bars, direction, interval, policy, asOf: now, referencePrice: Number(opposingBars.at(-1)?.close) });
    if (!z || Object.keys(z.points).some((name) => ["type", "time", "price"].some((key) => z.points[name][key] !== old.points[name]?.[key]))) return null;
    // A wider right-hand window may upgrade a still-identical pivot after first
    // discovery. Re-prove the original receipt using only bars visible then,
    // rather than replacing its confirmation with later hierarchy evidence.
    // Both prefixes start at the current source's first bar, so pivot indices
    // naturally adjust when the exchange's rolling history window advances.
    const discoveryBars = bars.filter((bar) => bar.closeTime < plan.firstDiscoveredAt);
    const discoveryPivots = structuralPivots(discoveryBars, direction === 1 ? "LOW" : "HIGH", policy);
    const originalAnchor = (name) => discoveryPivots.find((point) => point.time === old.points[name].time && point.price === old.points[name].price);
    const originalZ = findConfirmedZForPair({ pair: { first: originalAnchor("A"), second: originalAnchor("C") }, bars: discoveryBars,
      direction, interval, policy, asOf: plan.firstDiscoveredAt, referencePrice: Number(opposingBars.at(-1)?.close) });
    const originalKeys = ["type", "time", "price", "confirmedAt", "baseConfirmedAt", "hierarchyMultiplier", "hierarchySpanBars"];
    if (!originalZ || originalZ.confirmedAt !== old.confirmedAt || Object.keys(originalZ.points)
      .some((name) => originalKeys.some((key) => originalZ.points[name][key] !== old.points[name]?.[key]))) return null;
    renewed[name] = { ...z, points: originalZ.points, confirmedAt: originalZ.confirmedAt };
  }
  const updated = { ...plan, dualZ: { ...plan.dualZ, ...renewed } };
  return validateDualZPlanEvidence(updated, { now }).allowed ? updated : null;
}

function mergeWithPreviouslyDiscovered(discovered, previousPlans, barsBySymbol, marketStatesBySymbol, config, now, structureBarsBySymbol = new Map()) {
  const byId = new Map();
  const refreshedZPlans = [];
  for (const previous of previousPlans ?? []) {
    if (previous?.strategyVersion !== config.candidateVersion ||
        previous?.implementationRevision !== config.implementationRevision ||
        previous?.riskPolicyRevision !== config.riskPolicyRevision ||
        previous?.evaluationCohortId !== config.evaluationIsolation.forwardCohortId ||
        Number(previous.reserveDeadline) < now) continue;
    const bars = structureBarsBySymbol.get(previous.symbol);
    const refreshed = requiresDualZ(config)
      ? refreshDualZPlanEvidence(previous, bars?.primary, bars?.opposing, config, now)
      : requiresSingleZ(config) ? refreshSingleZPlanEvidence(previous, bars?.primary, bars?.opposing, config, now) : previous;
    if (refreshed) {
      byId.set(previous.id, refreshed);
      if (requiresPrimaryZ(config)) refreshedZPlans.push(refreshed);
    }
  }
  for (const candidate of discovered) {
    // A natural hierarchy upgrade does not create a second geometric signal.
    // Only an old receipt that passed the complete source refresh may retain
    // its discovery identity; invalid or changed old points cannot revive it.
    const sameConfirmedGeometry = requiresPrimaryZ(config) && refreshedZPlans.find((previous) => {
      if (previous.symbol !== candidate.symbol || previous.pattern !== candidate.pattern) return false;
      const names = requiresDualZ(config) ? ["primary", "opposing"] : ["primary"];
      const structuresMatch = names.every((name) => ["A", "B", "C", "D"].every((point) => {
        const priorZ = requiresDualZ(config) ? previous.dualZ?.[name] : previous.singleZ?.primary;
        const nextZ = requiresDualZ(config) ? candidate.dualZ?.[name] : candidate.singleZ?.primary;
        return ["type", "time", "price"].every((key) => priorZ?.points?.[point]?.[key] === nextZ?.points?.[point]?.[key]);
      }));
      return structuresMatch && previous.anchors?.slice(2).every((point, index) =>
        ["type", "time", "price"].every((key) => point?.[key] === candidate.anchors?.[index + 2]?.[key]));
    });
    if (sameConfirmedGeometry && sameConfirmedGeometry.id !== candidate.id) continue;
    const previous = byId.get(candidate.id);
    byId.set(candidate.id, {
      ...candidate,
      strategyVersion: config.candidateVersion,
      implementationRevision: config.implementationRevision,
      riskPolicyRevision: config.riskPolicyRevision,
      riskPolicyAuthorizationId: config.riskPolicyAuthorizationId,
      evaluationCohortId: config.evaluationIsolation.forwardCohortId,
      firstDiscoveredAt: previous?.firstDiscoveredAt ?? now,
    });
  }
  const evaluated = [...byId.values()].map((plan) => {
    const entryDecision = evaluateEntryDecision(plan, barsBySymbol.get(plan.symbol) ?? [], config.signal.crossCloseBufferBps, now, entryDecisionInterval(config));
    const baseAutomaticExecutionAllowed = plan.intersectionQuality?.baseAutomaticExecutionAllowed ??
      plan.intersectionQuality?.automaticExecutionAllowed === true;
    const qualityGated = {
      ...plan,
      // Refresh even candidates whose cross is no longer in the discovery window.
      // Missing current data must never fall back to the previous market state.
      marketState4h: marketStatesBySymbol.get(plan.symbol) ?? null,
      entryDecision: baseAutomaticExecutionAllowed
        ? entryDecision
        : {
            ...entryDecision,
            orderSubmissionAllowed: false,
            qualityGateStatus: plan.intersectionQuality?.action ?? "OBSERVE_ONLY_INTERSECTION_QUALITY",
          },
    };
    return applyDualZPlanGate(applyReleaseMarketStateGate(qualityGated, qualityGated.entryDecision, config, now), config, now);
  });
  return selectHighFrequencyCandidateQueue(evaluated, config);
}

export class V3DemoMarketClient {
  constructor({ baseUrl = DEMO_BASE_URL, fetchImpl = fetch, requestTimeoutMs = 8_000 } = {}) {
    this.base = new URL(baseUrl);
    if (this.base.protocol !== "https:" || this.base.hostname !== "demo-fapi.binance.com") throw new Error("V3_HF_DEMO_HOST_NOT_ALLOWLISTED");
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(pathname, params = {}) {
    if (!["/fapi/v1/time", "/fapi/v1/klines", "/fapi/v1/ticker/bookTicker"].includes(pathname)) throw new Error("V3_HF_PUBLIC_ENDPOINT_NOT_ALLOWLISTED");
    const url = new URL(pathname, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: { "user-agent": "orion-v3-binance-demo-hf-readonly/1.0" },
    });
    if (!response.ok) throw new Error(`V3_HF_PUBLIC_HTTP_${response.status}`);
    return response.json();
  }

  async serverTime() {
    return Number((await this.request("/fapi/v1/time")).serverTime);
  }

  async bars(symbol, interval, limit, serverTime) {
    const rows = await this.request("/fapi/v1/klines", { symbol, interval, limit });
    return normalizeKlines(rows, serverTime);
  }

  async book(symbol) {
    const row = await this.request("/fapi/v1/ticker/bookTicker", { symbol });
    return { bid: Number(row.bidPrice), ask: Number(row.askPrice), updateId: Number(row.time ?? row.updateId ?? 0) };
  }
}

export async function scanHighFrequencyCandidates({ symbols, config, previousPlans = [], now = Date.now(), client = new V3DemoMarketClient() }) {
  validateHighFrequencyConfig(config);
  const serverTime = await client.serverTime();
  const barsBySymbol = new Map();
  const marketStatesBySymbol = new Map();
  const structureBarsBySymbol = new Map();
  const discovered = [];
  for (const symbol of symbols) {
    const hf14 = requiresSingleZ(config);
    let primaryBars;
    let opposingBars;
    let entryBars;
    let legacyMarketStateBars;
    if (hf14) {
      [primaryBars, opposingBars] = await Promise.all([
        client.bars(symbol, "1h", 500, serverTime),
        client.bars(symbol, "15m", 1200, serverTime),
      ]);
      entryBars = opposingBars;
    } else {
      [legacyMarketStateBars, primaryBars, opposingBars, entryBars] = await Promise.all([
        client.bars(symbol, "4h", config.marketStateGate.requestLimit, serverTime),
        client.bars(symbol, "1h", 500, serverTime),
        client.bars(symbol, "15m", 1200, serverTime),
        client.bars(symbol, entryDecisionInterval(config), 200, serverTime),
      ]);
    }
    barsBySymbol.set(symbol, entryBars);
    structureBarsBySymbol.set(symbol, { primary: primaryBars, opposing: opposingBars });
    let marketState4h;
    if (hf14) {
      marketState4h = {
        schemaVersion: 1,
        interval: "4h",
        source: "NOT_REQUESTED_BY_HF14_EXECUTION_SCAN",
        state: "NOT_REQUIRED",
        evidenceStatus: "OBSERVE_ONLY_DECOUPLED_FROM_EXECUTION_LOOP",
        observedAt: serverTime,
      };
    } else {
      marketState4h = classifyFourHourMarketState(legacyMarketStateBars, config.marketStateGate, serverTime);
    }
    marketStatesBySymbol.set(symbol, marketState4h);
    discovered.push(...discoverHighFrequencyCandidates({ symbol, primaryBars, opposingBars, marketState4h, config, now: serverTime }));
  }
  const selection = mergeWithPreviouslyDiscovered(discovered, previousPlans, barsBySymbol, marketStatesBySymbol, config, serverTime, structureBarsBySymbol);
  return {
    scannedAt: new Date(now).toISOString(),
    marketTime: serverTime,
    strategyVersion: config.candidateVersion,
    implementationRevision: config.implementationRevision,
    riskPolicyRevision: config.riskPolicyRevision,
    riskPolicyAuthorizationId: config.riskPolicyAuthorizationId,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    plans: selection.plans,
    planCount: selection.plans.length,
    candidateSelectionAudit: selection.candidateSelectionAudit,
    automaticOrderSubmissionAllowed: config.execution.residentScannerAutomaticOrderSubmissionAllowed === true,
  };
}
