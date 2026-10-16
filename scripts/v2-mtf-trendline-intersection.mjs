import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = path.join(ROOT, "experiments/v2-mtf-trendline-intersection/config.json");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function pivotAnchorPrice(bar, type) {
  if (type === "HIGH" && Number.isFinite(bar?.high)) return bar.high;
  if (type === "LOW" && Number.isFinite(bar?.low)) return bar.low;
  throw new Error("PIVOT_ANCHOR_REQUIRES_BAR_HIGH_OR_LOW");
}

export function lineFromPivots(first, second) {
  invariant(Number.isFinite(first?.time) && Number.isFinite(first?.price), "INVALID_FIRST_PIVOT");
  invariant(Number.isFinite(second?.time) && Number.isFinite(second?.price), "INVALID_SECOND_PIVOT");
  invariant(second.time > first.time, "PIVOT_TIME_ORDER");
  return {
    anchorTime: first.time,
    anchorPrice: first.price,
    slope: (second.price - first.price) / (second.time - first.time),
  };
}

export function linePriceAt(line, time) {
  return line.anchorPrice + line.slope * (time - line.anchorTime);
}

export function intersectLines(first, second, minimumSlopeDifference = 1e-12) {
  const slopeDifference = first.slope - second.slope;
  if (!Number.isFinite(slopeDifference) || Math.abs(slopeDifference) < minimumSlopeDifference) {
    return { valid: false, reason: "PARALLEL_OR_UNSTABLE" };
  }
  const time = (
    second.anchorPrice - first.anchorPrice + first.slope * first.anchorTime - second.slope * second.anchorTime
  ) / slopeDifference;
  const price = linePriceAt(first, time);
  if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) {
    return { valid: false, reason: "INVALID_INTERSECTION" };
  }
  return { valid: true, time, price };
}

export function containingBar(bars, time) {
  return bars.find((bar) => bar.openTime <= time && time < bar.openTime + (bar.closeTime - bar.openTime + 1)) ?? null;
}

export function candleDirection(bar) {
  if (!bar || !Number.isFinite(bar.open) || !Number.isFinite(bar.close)) return 0;
  return bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0;
}

export function costAdjustedRiskPlan({
  direction,
  entry,
  initialStop,
  entryCostPerUnit,
  initialStopExitCostPerUnit,
  breakEvenExitCostPerUnit,
  firstTakeProfitExitCostPerUnit,
  softTakeProfitNetR = 0.5,
  firstTakeProfitNetR = 1,
  secondTakeProfitNetR = 2,
}) {
  const values = [entry, initialStop, entryCostPerUnit, initialStopExitCostPerUnit, breakEvenExitCostPerUnit,
    firstTakeProfitExitCostPerUnit, softTakeProfitNetR, firstTakeProfitNetR, secondTakeProfitNetR];
  if (![1, -1].includes(direction) || !values.every(Number.isFinite) ||
    [entryCostPerUnit, initialStopExitCostPerUnit, breakEvenExitCostPerUnit, firstTakeProfitExitCostPerUnit].some((value) => value < 0)) {
    return { accepted: false, reason: "INVALID_COST_ADJUSTED_RISK_INPUT" };
  }
  const initialPriceRisk = direction * (entry - initialStop);
  if (!(initialPriceRisk > 0)) return { accepted: false, reason: "INITIAL_STOP_NOT_PROTECTIVE" };
  const initialRiskPerUnit = initialPriceRisk + entryCostPerUnit + initialStopExitCostPerUnit;
  const breakEvenCostCushionPerUnit = entryCostPerUnit + breakEvenExitCostPerUnit;
  const target = (netR) => entry + direction * (
    netR * initialRiskPerUnit + entryCostPerUnit + firstTakeProfitExitCostPerUnit
  );
  return {
    accepted: true,
    reason: "COST_ADJUSTED_RISK_PLAN",
    initialPriceRisk,
    initialRiskPerUnit,
    breakEvenCostCushionPerUnit,
    breakEvenActivationPrice: target(1),
    breakEvenStopPrice: entry + direction * breakEvenCostCushionPerUnit,
    softTakeProfitPrice: target(softTakeProfitNetR),
    firstTakeProfitPrice: target(firstTakeProfitNetR),
    secondTakeProfitPrice: target(secondTakeProfitNetR),
    softTakeProfitNetR,
    firstTakeProfitNetR,
    secondTakeProfitNetR,
  };
}

export function validateConfig(config) {
  invariant(config?.schemaVersion === 1, "CONFIG_SCHEMA_VERSION");
  invariant(config?.candidateVersion === "ORION-V2-RESEARCH-MTFX-0.5.0", "CURRENT_STRATEGY_VERSION_REQUIRED");
  invariant(config?.implementationRevision === "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION", "CURRENT_IMPLEMENTATION_REVISION_REQUIRED");
  invariant(config?.implementationDirectiveId === "OWNER-DIRECTIVE-MTFX-050-R22-BALANCED-PROFIT-REALIZATION-20260828", "IMPLEMENTATION_DIRECTIVE_REFERENCE_REQUIRED");
  invariant(config?.eventRisk?.mode === "SCHEDULED_TIER1_EVENT_NEW_ENTRY_FREEZE", "TIER1_EVENT_RISK_POLICY_REQUIRED");
  invariant(config?.eventRisk?.authorizationId === "OWNER-DIRECTIVE-MTFX-050-R22-BALANCED-PROFIT-REALIZATION-20260828", "TIER1_EVENT_AUTHORIZATION_REFERENCE_REQUIRED");
  invariant(config?.eventRisk?.existingPositions === "UNCHANGED_UNLESS_A_NON_FROZEN_CONFIRMED_OPPOSITE_CURRENT_STRUCTURE_REPLACES_THEM", "TIER1_EVENT_EXISTING_POSITIONS_MUST_REMAIN_MANAGED");
  invariant(config?.execution?.singleSymbolExposure === "AT_MOST_ONE_OPEN_POSITION_PER_SYMBOL_ACROSS_ALL_ACTIVE_PAPER_BOOKS", "SINGLE_SYMBOL_EXPOSURE_REQUIRED");
  invariant(config?.execution?.newSameSymbolPlan === "AUDIT_AND_EXPIRE_WITHOUT_PAPER_POSITION_OPENED", "SAME_SYMBOL_PLAN_MUST_EXPIRE");
  invariant(config?.execution?.oppositeCurrentStructurePlan === "CLOSE_OLD_THEN_OPEN_NEW_ONLY_AFTER_FULL_CONFIRMATION", "CURRENT_STRUCTURE_REPLACEMENT_SEQUENCE_REQUIRED");
  invariant(config?.execution?.automaticSignalReplacement === "OPPOSITE_CURRENT_FULLY_CONFIRMED_ONLY", "AUTOMATIC_REPLACEMENT_SCOPE_REQUIRED");
  invariant(config?.signal?.maximumEntryDisplacementBps === 50, "MAXIMUM_ENTRY_DISPLACEMENT_REQUIRED");
  invariant(config?.signal?.maximumEntrySignalAgeMs === 180000, "MAXIMUM_ENTRY_SIGNAL_AGE_REQUIRED");
  invariant(config?.signal?.entryDisplacementReference === "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE", "CONFIRMED_15M_CLOSE_ENTRY_REFERENCE_REQUIRED");
  invariant(config?.signal?.entryQualityRevalidation === "EVERY_NEW_ENTRY_RETRY_AND_OPPOSITE_REPLACEMENT_ATTEMPT", "ENTRY_QUALITY_REVALIDATION_REQUIRED");
  invariant(config?.signal?.maximumCompleteLifecycleCostR === 0.12, "COMPLETE_LIFECYCLE_COST_THRESHOLD_REQUIRED");
  invariant(config?.signal?.costEfficiencyRevalidation === "BEFORE_POSITION_SIZING_ON_EVERY_SUBMISSION_ATTEMPT", "COST_EFFICIENCY_REVALIDATION_REQUIRED");
  invariant(config?.signal?.aboveCostThresholdAction === "REJECT_AND_CONSUME_INTERSECTION", "COST_EFFICIENCY_REJECTION_REQUIRED");
  invariant(config?.costAdjustedRisk?.maximumCompleteLifecycleCostR === 0.12, "COST_ADJUSTED_RISK_THRESHOLD_REQUIRED");
  invariant(config?.costAdjustedRisk?.gateBeforePositionSizing === true, "COST_GATE_MUST_PRECEDE_POSITION_SIZING");
  invariant(config?.authorization?.paperExecutionAllowed === true, "PAPER_EXECUTION_AUTHORIZATION_REQUIRED");
  invariant(config?.authorization?.realExecutionAllowed === false, "REAL_EXECUTION_FORBIDDEN");
  invariant(config?.authorization?.authorizationId === "OWNER-AUTH-MTFX-PRICE-TIME-STRUCTURE-050-20260806", "OWNER_PAPER_AUTHORIZATION_REFERENCE_REQUIRED");
  invariant(config?.marketModel?.sidewaysIsRecordedOutcome === true, "SIDEWAYS_OUTCOME_MUST_BE_RECORDED");
  invariant(config?.marketModel?.signalInputs?.join(",") === "EXCHANGE_OPEN_TIME,OPEN,HIGH,LOW,CLOSE", "PURE_PRICE_TIME_INPUTS_REQUIRED");
  invariant(config?.marketModel?.indicatorSignalFilters?.length === 0, "INDICATOR_SIGNAL_FILTERS_FORBIDDEN");
  invariant(config?.pivots?.anchorTimestamp === "EXCHANGE_BAR_OPEN_TIME", "ANCHOR_MUST_USE_EXCHANGE_OPEN_TIME");
  invariant(config?.pivots?.commonCoordinate === "INTEGER_15M_BAR_INDEX", "COMMON_15M_COORDINATE_REQUIRED");
  invariant(config?.pivots?.sameTypePairRequiresInterveningOppositeSwing === true, "INDEPENDENT_STRUCTURE_LEGS_REQUIRED");
  invariant(config?.pivots?.fourHour?.minimumAnchorProminenceFractionOfVisibleRange > 0, "FOUR_HOUR_SCALE_GATE_REQUIRED");
  invariant(config?.pivots?.oneHour?.minimumAnchorProminenceFractionOfVisibleRange > 0, "ONE_HOUR_SCALE_GATE_REQUIRED");
  invariant(config?.pivots?.fourHour?.hierarchyWindowMultipliers?.at(-1) >= 4, "FOUR_HOUR_HIERARCHY_GATE_REQUIRED");
  invariant(config?.pivots?.fourHour?.minimumRealtimeHierarchyMultiplier >= 4, "FOUR_HOUR_REALTIME_SCALE_FLOOR_REQUIRED");
  invariant(config?.pivots?.oneHour?.hierarchyWindowMultipliers?.at(-1) >= 4, "ONE_HOUR_HIERARCHY_GATE_REQUIRED");
  invariant(config?.pivots?.fourHour?.nonAdjacentParentAnchorsAllowed === true, "FOUR_HOUR_PARENT_ANCHORS_REQUIRED");
  invariant(config?.pivots?.fourHour?.maximumAnchorHypothesesPerLineage >= 3, "FOUR_HOUR_MULTI_ANCHOR_HYPOTHESES_REQUIRED");
  invariant(config?.pivots?.oneHour?.nonAdjacentParentAnchorsAllowed === true, "ONE_HOUR_PARENT_ANCHORS_REQUIRED");
  invariant(config?.symmetricPatterns?.length === 2, "BIDIRECTIONAL_PATTERNS_REQUIRED");
  invariant(config?.intersection?.barMapping === "FLOOR_X_STAR_CONTAINING_15M_INTERVAL", "CROSS_CONTAINING_BAR_MAPPING_REQUIRED");
  invariant(config?.intersection?.realtimeCrossMustBeInFutureBlankArea === true, "FUTURE_BLANK_CROSS_REQUIRED");
  invariant(config?.intersection?.minimumDiscoveryLeadHours === 2, "MINIMUM_DISCOVERY_LEAD_REQUIRED");
  invariant(config?.intersection?.maximumLeadHours === 72, "MAXIMUM_DISCOVERY_LEAD_REQUIRED");
  invariant(config?.intersection?.commitmentLeadHours === config.intersection.minimumDiscoveryLeadHours, "COMMITMENT_WINDOW_MUST_MATCH_DISCOVERY_FLOOR");
  invariant(config?.intersection?.priceProximityRequired === false, "PRICE_PROXIMITY_MUST_BE_DISABLED");
  invariant(config?.intersection?.anchorConsensus?.method === "MULTI_ANCHOR_INTERSECTION_CLUSTER_AND_ONE_BAR_PERTURBATION", "MULTI_ANCHOR_CONSENSUS_REQUIRED");
  invariant(config?.intersection?.anchorConsensus?.drawingCoordinatesUsed === false, "DRAWING_COORDINATES_FORBIDDEN");
  invariant(config?.intersection?.anchorConsensus?.mathematicalInputs?.join(",") === "EXCHANGE_BAR_OPEN_TIME,BAR_HIGH,BAR_LOW", "EXACT_PRICE_TIME_ANCHORS_REQUIRED");
  invariant(config?.intersection?.anchorConsensus?.lowStabilityAction === "KEEP_FOR_PAPER_OBSERVATION_NOT_BLOCK", "LOW_STABILITY_MUST_REMAIN_OBSERVABLE");
  invariant(config?.signal?.maximumReserveBars === 4, "POST_CROSS_RESERVE_MUST_REMAIN_FOUR_BARS");
  invariant(config?.signal?.barSelection === "THE_FULLY_CLOSED_15M_BAR_CONTAINING_CANONICAL_EXACT_INTERSECTION", "CROSS_CONTAINING_BAR_SELECTION_REQUIRED");
  invariant(config?.signal?.patternSelection === "FIRST_ELIGIBLE_CLOSE_IN_THE_CROSS_BAR_OR_IMMEDIATE_NEXT_15M_BAR_DETERMINES_DIRECTION", "TWO_BAR_CROSS_CLOSE_DIRECTION_LOCK_REQUIRED");
  invariant(config?.signal?.protectiveStructureMaturation === "INTERSECTION_BUFFER_STOP_READY_AT_DIRECTION_LOCKING_BAR_CLOSE", "INTERSECTION_BUFFER_STOP_REQUIRED");
  invariant(config?.signal?.bboTemporalEvidence === "DUAL_CLOCK_EXCHANGE_MARKET_TIME_AND_LOCAL_RECEIVED_TIME", "DUAL_CLOCK_BBO_EVIDENCE_REQUIRED");
  invariant(config?.signal?.bboOrdering === "MARKET_TIME_NON_REGRESSING_AND_UPDATE_ID_REQUIRED_STRICTLY_INCREASING", "MONOTONIC_BBO_ORDERING_REQUIRED");
  invariant(config?.signal?.positionStateDurability === "LEDGER_FIRST_OPEN_AND_PER_POSITION_SEQUENCE_REPLAY_FOR_BBO_AND_1H_TRAIL_COMMITS", "CANONICAL_POSITION_STATE_REPLAY_REQUIRED");
  invariant(config?.signal?.expiryAction === "BOTH_DIRECTION_DECISION_BARS_INSIDE_BUFFER_EXPIRE; AFTER_DIRECTION_LOCK_WAIT_ONLY_FOR_CAUSAL_BBO_AND_PRICE_REENTRY_UNTIL_180_SECONDS_AFTER_DECISION_CLOSE", "BOUNDED_BBO_EXPIRY_REQUIRED");
  invariant(config?.optimizationObjective?.primary === "MAXIMIZE_ONE_SIDED_EXPANSION_PROBABILITY_WITHOUT_INCREASING_RISK", "ONE_SIDED_EXPANSION_OBJECTIVE_REQUIRED");
  invariant(config?.optimizationObjective?.automaticParameterLearning === false, "AUTOMATIC_PARAMETER_LEARNING_FORBIDDEN");
  invariant(config?.fourHourLineLifecycle?.maximumConcurrentLineage === 2, "FOUR_HOUR_LINEAGE_MUST_BE_BOUNDED_TO_TWO");
  invariant(config?.signal?.interval === "15m", "SIGNAL_INTERVAL_MUST_BE_15M");
  invariant(config?.signal?.maximumReserveBars === 4, "FOUR_BAR_CONFIRMATION_RESERVE_REQUIRED");
  invariant(config?.signal?.entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER", "TWO_BAR_CROSS_CLOSE_MODE_REQUIRED");
  invariant(config?.signal?.crossCloseBufferBps === 5, "CROSS_CLOSE_BUFFER_REQUIRED");
  invariant(config?.signal?.allowedPatternLengths?.join(",") === "1", "SINGLE_CROSS_BAR_REQUIRED");
  invariant(config?.signal?.maximumDirectionDecisionBars === 2, "TWO_BAR_DECISION_WINDOW_REQUIRED");
  invariant(config?.signal?.minimumBodyToRange === null, "BODY_FILTER_MUST_BE_RETIRED");
  invariant(config?.signal?.longMinimumCloseLocation === null && config?.signal?.shortMaximumCloseLocation === null, "CLOSE_LOCATION_FILTER_MUST_BE_RETIRED");
  invariant(config?.signal?.bodySizeFilter === false && config?.signal?.volumeFilter === false, "PURE_CLOSE_RELATIVE_TO_CROSS_REQUIRED");
  invariant(config?.stop?.fibonacciRatio === 0.618, "FIBONACCI_0618_STOP_REQUIRED");
  invariant(config?.stop?.initialStopMode === "INTERSECTION_BUFFER", "INTERSECTION_BUFFER_INITIAL_STOP_REQUIRED");
  invariant(config?.stop?.intersectionBufferBps === 5, "INTERSECTION_BUFFER_STOP_SIZE_REQUIRED");
  invariant(config?.stop?.requireInterveningOppositeStructure === true, "INTERVENING_OPPOSITE_STOP_STRUCTURE_REQUIRED");
  invariant(config?.stop?.minimumProgressionFractionOfWeakerProminence === 0.1, "STOP_STRUCTURE_PROGRESSION_FLOOR_REQUIRED");
  invariant(config?.stop?.structureHygienePatch === "ACTIVE", "STOP_STRUCTURE_HYGIENE_MUST_BE_ACTIVE");
  invariant(config?.costAdjustedRisk?.softLockActivationNetR === 0.5, "COST_ADJUSTED_SOFT_LOCK_REQUIRED");
  invariant(config?.costAdjustedRisk?.softLockAggregateNetRFloor === 0.15, "R22_HALF_R_AGGREGATE_FLOOR_REQUIRED");
  invariant(config?.costAdjustedRisk?.oneNetRAggregateNetRFloor === 0.6, "R22_ONE_R_AGGREGATE_FLOOR_REQUIRED");
  invariant(config?.exit?.atHalfNetR?.closeFractionOfOriginal === 0.4, "R22_HALF_R_EXIT_MUST_CLOSE_FORTY_PERCENT");
  invariant(config?.exit?.atOneNetR?.closeFractionOfOriginal === 0.25, "R22_ONE_R_EXIT_MUST_CLOSE_TWENTY_FIVE_PERCENT");
  invariant(config?.exit?.atTwoNetR?.closeFractionOfOriginal === 0.2, "R22_TWO_R_EXIT_MUST_CLOSE_TWENTY_PERCENT");
  invariant(config?.exit?.runner?.fractionOfOriginal === 0.15 && config?.exit?.runner?.interval === "1h", "R22_ONE_HOUR_FIFTEEN_PERCENT_RUNNER_REQUIRED");
  invariant(config?.exit?.runner?.maximumHoldingTime === null, "RUNNER_TIME_EXIT_FORBIDDEN");
  invariant(config?.variants?.find((item) => item.id === "MTFX-TP")?.status === "RETIRED_NO_NEW_ENTRIES", "TIME_PRICE_VARIANT_MUST_BE_RETIRED");
  invariant(config?.promotion?.tickBboReplayRequired === true, "TICK_BBO_GATE_REQUIRED");
  invariant(config?.promotion?.ownerApprovalRequired === true, "OWNER_APPROVAL_REQUIRED");
  invariant(config?.futurePaperRisk?.authorizationId === "OWNER-DIRECTIVE-V2-RISK-2PCT-10PCT-20260911", "CURRENT_PAPER_RISK_DIRECTIVE_REQUIRED");
  invariant(config?.futurePaperRisk?.application === "FORWARD_ELIGIBLE_NEW_ENTRIES_ONLY", "FORWARD_ONLY_PAPER_RISK_REQUIRED");
  invariant(config?.futurePaperRisk?.maximumRiskPerIntersectionFraction === 0.02, "TWO_PERCENT_INTERSECTION_CAP_REQUIRED");
  invariant(config?.futurePaperRisk?.maximumPortfolioRiskFraction === 0.1, "TEN_PERCENT_PORTFOLIO_CAP_REQUIRED");
  invariant(config?.signal?.oneEntryMaximumPerIntersection === true, "SPLIT_INTERSECTION_RISK_BYPASS_FORBIDDEN");
  return true;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  validateConfig(config);
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadConfig(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONFIG_PATH);
  process.stdout.write(`${JSON.stringify({
    status: "VALID",
    experimentId: config.experimentId,
    candidateVersion: config.candidateVersion,
    variants: config.variants.map((variant) => variant.id),
    executionAllowed: "PAPER_ONLY",
    authorizationId: config.authorization.authorizationId,
  }, null, 2)}\n`);
}
