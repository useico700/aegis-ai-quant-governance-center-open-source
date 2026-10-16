import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reconcile } from "../../../integrations/binance-usdm-testnet/read-only-reconciler.mjs";
import { TRADING_STATE_PATH, evaluateManagedExchangeReconciliation, verifyTradingAuditLedger } from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";
import { verifyChainedAudit } from "../../../integrations/binance-usdm-testnet/audit-ledger.mjs";
import { validateHighFrequencyConfig } from "./high-frequency-strategy.mjs";
import {
  HF13_AUTHORIZATION, HF14_AUTHORIZATION, entryDecisionInterval, releasePolicy, requiresDualZ, requiresSingleZ, validateDualZPolicy,
} from "./release-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function readJson(relative) {
  return JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

export function validateV3Boundary({ v3, v2Runtime, v2Strategy, v3Strategy, current, testnetGate, authorization, hfAuthorization, automaticAuthorization, riskAuthorization }) {
  const errors = [];
  const release = releasePolicy(v3Strategy);
  const hf13 = requiresDualZ(v3Strategy);
  const hf14 = requiresSingleZ(v3Strategy);
  const structuredZ = hf13 || hf14;
  const decisionInterval = entryDecisionInterval(v3Strategy);
  const decisionConfirmationPolicy = `TWO_CONSECUTIVE_${decisionInterval.toUpperCase()}_CLOSES_SAME_SIDE_BEYOND_INTERSECTION_BUFFER`;
  const decisionCloseReference = `LATEST_EXECUTABLE_BBO_VERSUS_CONFIRMED_${decisionInterval.toUpperCase()}_DECISION_CLOSE`;
  const authorizationDecisionCloseReference = `LATEST_EXECUTABLE_BBO_VERSUS_SECOND_CONFIRMED_${decisionInterval.toUpperCase()}_DECISION_CLOSE`;
  const expectedAuthorizationId = hf14 ? HF14_AUTHORIZATION : hf13 ? HF13_AUTHORIZATION : "OWNER-DIRECTIVE-ORION-V3-HF11-TRUE-4H-MARKET-STATE-GATE-20260826";
  const strategyMarketStateBoundaryValid = hf14
    ? v3Strategy?.marketStateGate?.enabled === false && v3Strategy?.marketStateGate?.executionGate === false &&
      v3Strategy?.marketStateGate?.observationOnly === true && v3Strategy?.marketStateGate?.requestInExecutionScan === false &&
      v3Strategy?.marketStateGate?.missingEvidenceAction === "NOT_AN_EXECUTION_INPUT"
    : v3Strategy?.marketStateGate?.enabled === true && v3Strategy?.marketStateGate?.missingEvidenceAction === "SHADOW_ONLY_FAIL_CLOSED";
  const authorizationMarketStateBoundaryValid = hf14
    ? hfAuthorization?.strategy?.fourHourMarketStateGateRetained === false &&
      hfAuthorization?.strategy?.marketStateObservationOnly === true &&
      hfAuthorization?.strategy?.fourHourRequestInExecutionScan === false &&
      hfAuthorization?.strategy?.missingOppositeRangeOrStaleFourHourEvidenceBlocksHf14 === false
    : hfAuthorization?.strategy?.marketStateInterval === "4h" &&
      hfAuthorization?.strategy?.marketStateSource === "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" &&
      hfAuthorization?.strategy?.oneHourHierarchyMultiplierMaySubstituteForTrueFourHourBars === false &&
      hfAuthorization?.strategy?.unfinishedFourHourBarsAllowed === false;
  const currentMarketStateBoundaryValid = hf14
    ? current?.orionV3BinanceUsdmDemo?.marketStateGate?.executionGate === false &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.observationOnly === true &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.requestInExecutionScan === false &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.missingEvidenceAction === "NOT_AN_EXECUTION_INPUT"
    : current?.orionV3BinanceUsdmDemo?.marketStateGate?.interval === "4h" &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.source === "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.unfinishedBarsAllowed === false &&
      current?.orionV3BinanceUsdmDemo?.marketStateGate?.missingEvidenceAction === "SHADOW_ONLY_FAIL_CLOSED";
  if (!release || !validateDualZPolicy(v3Strategy)) errors.push("V3_HIGH_FREQUENCY_RELEASE_POLICY_INVALID");
  try { validateHighFrequencyConfig(v3Strategy); } catch { errors.push("V3_HIGH_FREQUENCY_CONFIG_INVALID"); }
  const requiredFalse = (value, code) => {
    if (value !== false) errors.push(code);
  };
  const requiredTrue = (value, code) => {
    if (value !== true) errors.push(code);
  };

  if (v3.runtimeId !== "ORION-V3-BINANCE-USDM-DEMO-AUTOMATED-3.0") errors.push("V3_RUNTIME_ID_INVALID");
  if (v3.lifecycle !== "ACTIVE_OWNER_AUTHORIZED_AUTOMATED_TESTNET_TRADING") errors.push("V3_LIFECYCLE_INVALID");
  if (v3.authorizationId !== authorization.id || authorization.status !== "ACTIVE_ON_DEMAND_BINANCE_DEMO_TRADING") errors.push("V3_AUTHORIZATION_CHAIN_INVALID");
  if (v3.strategyParity?.mode !== "OWNER_AUTHORIZED_V3_HIGH_FREQUENCY_DERIVATIVE" ||
      v3.strategyParity?.expectedStrategyVersion !== v3Strategy?.candidateVersion ||
      v3.strategyParity?.expectedImplementationRevision !== v3Strategy?.implementationRevision ||
      v2Strategy.candidateVersion !== v2Runtime.strategyVersion ||
      current.activeResearchCandidate?.id !== v2Runtime.strategyVersion ||
      current.activeResearchCandidate?.implementationRevision !== v2Runtime.implementationRevision ||
      current.orionV3BinanceUsdmDemo?.strategyVersion !== v3Strategy?.candidateVersion ||
      current.orionV3BinanceUsdmDemo?.implementationRevision !== v3Strategy?.implementationRevision) {
    errors.push("V3_V2_STRATEGY_PARITY_INVALID");
  }
  if (v3.strategyParity?.unversionedLocalOverridesAllowed !== false ||
      hfAuthorization?.id !== expectedAuthorizationId ||
      v3Strategy?.implementationDirectiveId !== expectedAuthorizationId ||
      hfAuthorization?.status !== "ACTIVE" ||
      hfAuthorization?.appliesTo?.agent !== "orion-v3" ||
      hfAuthorization?.appliesTo?.venue !== "BINANCE_USDM_TESTNET" ||
      hfAuthorization?.appliesTo?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
      hfAuthorization?.release?.strategyFamily !== v3Strategy?.candidateVersion ||
      hfAuthorization?.release?.implementationRevision !== v3Strategy?.implementationRevision ||
      hfAuthorization?.release?.displayName !== v3Strategy?.displayName ||
      v3Strategy?.timeframes?.marketState !== "4h" ||
      v3Strategy?.timeframes?.primaryStructure !== "1h" ||
      v3Strategy?.timeframes?.opposingStructure !== "15m" ||
      v3Strategy?.timeframes?.entryDecision !== decisionInterval ||
      v3Strategy?.timeframes?.runnerTrail !== "15m" ||
      v3Strategy?.exit?.runner?.interval !== "15m" ||
      v3Strategy?.riskPolicyRevision !== "V3-RISK-2-AGGRESSIVE-GROWTH-1PCT-10PCT-20260820" ||
      v3Strategy?.riskPolicyAuthorizationId !== "OWNER-DIRECTIVE-ORION-V3-AGGRESSIVE-GROWTH-RISK-1PCT-10PCT-20260820" ||
      v3?.riskPolicyRevision !== v3Strategy?.riskPolicyRevision ||
      v3?.riskPolicyAuthorizationId !== v3Strategy?.riskPolicyAuthorizationId ||
      current?.orionV3BinanceUsdmDemo?.riskPolicyRevision !== v3Strategy?.riskPolicyRevision ||
      current?.orionV3BinanceUsdmDemo?.riskPolicyAuthorizationId !== v3Strategy?.riskPolicyAuthorizationId ||
      v3Strategy?.risk?.maximumRiskPerIntersectionFraction !== 0.01 ||
      v3Strategy?.risk?.maximumPortfolioRiskFraction !== 0.1 ||
      v3Strategy?.risk?.maximumLeverage !== 10 ||
      v3Strategy?.risk?.maximumOpenPositionsPerSymbol !== 1 ||
      v3Strategy?.risk?.lossAveragingAllowed !== false ||
      v3Strategy?.risk?.stopWideningAllowed !== false ||
      v3Strategy?.signal?.maximumEntryDisplacementBps !== 75 ||
      v3Strategy?.signal?.maximumEntrySignalAgeMs !== 300000 ||
      v3Strategy?.signal?.maximumDirectionDecisionBars !== 2 ||
      v3Strategy?.signal?.maximumReserveBars !== 4 ||
      v3Strategy?.signal?.confirmationPolicy !== decisionConfirmationPolicy ||
      v3Strategy?.signal?.failedPersistenceAction !== "EXPIRE_INTERSECTION_WITHOUT_REVERSE" ||
      v3Strategy?.signal?.entryDisplacementReference !== decisionCloseReference ||
      v3Strategy?.pivots?.primary?.minimumRealtimeHierarchyMultiplier !== 4 ||
      v3Strategy?.pivots?.primary?.maximumSecondAnchorAgeFraction !== 0.35 ||
      v3Strategy?.pivots?.opposing?.minimumRealtimeHierarchyMultiplier !== 2 ||
      v3Strategy?.pivots?.opposing?.maximumSecondAnchorAgeFraction !== 0.5 ||
      v3Strategy?.intersection?.maximumPrimaryProjectionSpanMultiples !== 2 ||
      v3Strategy?.intersection?.maximumOpposingProjectionSpanMultiples !== 2 ||
      v3Strategy?.intersection?.minimumDiscoveryLeadMinutes !== 5 ||
      v3Strategy?.intersection?.maximumLeadHours !== 6 ||
      v3Strategy?.intersection?.priceProximityRequired !== false ||
      v3Strategy?.intersection?.maximumDiscoveryPriceDistanceBps !== 750 ||
      v3Strategy?.intersection?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
      v3Strategy?.intersection?.observationCandidateAutomaticSubmissionAtDiscovery !== false ||
      v3Strategy?.intersection?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
      v3Strategy?.intersection?.minimumAutomaticExecutionConsensusSupport !== 1 ||
      v3Strategy?.scanUniverseAuthorizationId !== "OWNER-DIRECTIVE-ORION-V3-V4-TIERED-SCAN-UNIVERSE30-20260820" ||
      v3Strategy?.intersection?.maximumQueuedCandidatesPerSymbol !== 2 ||
      v3Strategy?.intersection?.maximumRankedCandidatesGlobal !== 12 ||
      v3Strategy?.intersection?.conditionalSingleHypothesisExecution?.enabled !== false ||
      v3Strategy?.execution?.maximumNewEntriesPerCycle !== 2 ||
      v3Strategy?.evaluationIsolation?.forwardCohortId !== release?.cohort ||
      v3Strategy?.evaluationIsolation?.baselineCohortId !== "ORION-V3-PRE-HF11-BASELINE-20260826" ||
      !strategyMarketStateBoundaryValid ||
      v3Strategy?.marketStateGate?.interval !== "4h" ||
      v3Strategy?.marketStateGate?.source !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
      v3Strategy?.marketStateGate?.pivotPolicy?.leftBars !== 2 ||
      v3Strategy?.marketStateGate?.pivotPolicy?.rightBars !== 2 ||
      JSON.stringify(v3Strategy?.marketStateGate?.pivotPolicy?.hierarchyWindowMultipliers) !== "[1]" ||
      v3Strategy?.marketStateGate?.comparisonRule !== "LAST_TWO_CONFIRMED_4H_HIGHS_AND_LAST_TWO_CONFIRMED_4H_LOWS" ||
      v3Strategy?.marketStateGate?.longOnlyRule !== "BOTH_HIGHS_AND_LOWS_RISING" ||
      v3Strategy?.marketStateGate?.shortOnlyRule !== "BOTH_HIGHS_AND_LOWS_FALLING" ||
      v3Strategy?.marketStateGate?.otherwiseState !== "RANGE_OR_TRANSITION" ||
      v3Strategy?.marketStateGate?.unfinishedBarsAllowed !== false ||
      v3Strategy?.marketStateGate?.historicalSignalBackfillAllowed !== false ||
      v3Strategy?.marketStateGate?.symbolSpecificOverridesAllowed !== false ||
      v3Strategy?.reentryLineageGate?.enabled !== true ||
      !Number.isFinite(Date.parse(v3Strategy?.reentryLineageGate?.enforcedFrom ?? "")) ||
      v3Strategy?.reentryLineageGate?.requiredChange !== "BOTH_PRIMARY_1H_AND_OPPOSING_15M_CONFIRMED_ANCHOR_PAIRS" ||
      v3Strategy?.reentryLineageGate?.missingEvidenceAction !== "FAIL_CLOSED" ||
      hfAuthorization?.strategy?.maximumPostConfirmationDisplacementBps !== 75 ||
      hfAuthorization?.strategy?.maximumEntrySignalAgeMs !== 300000 ||
      hfAuthorization?.strategy?.minimumOpposingHierarchyMultiplier !== 2 ||
      hfAuthorization?.strategy?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
      hfAuthorization?.strategy?.priceProximityRequired !== false ||
      hfAuthorization?.strategy?.antiChaseReference !== authorizationDecisionCloseReference ||
      hfAuthorization?.strategy?.minimumAutomaticExecutionConsensusSupport !== 1 ||
      !authorizationMarketStateBoundaryValid ||
      current?.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumOpposingProjectionSpanMultiples !== 2 ||
      current?.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
      current?.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.priceProximityRequired !== false ||
      current?.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
      current?.orionV3BinanceUsdmDemo?.evaluationIsolation?.forwardCohortId !== release?.cohort ||
      v3?.evaluationIsolation?.forwardCohortId !== release?.cohort ||
      hfAuthorization?.evaluationIsolation?.forwardCohortId !== release?.cohort ||
      !currentMarketStateBoundaryValid ||
      current?.orionV3BinanceUsdmDemo?.reentryLineageGate?.enabled !== true ||
      current?.orionV3BinanceUsdmDemo?.outcomeAttribution?.historicalAccountFactsRewritten !== false ||
      current?.orionV3BinanceUsdmDemo?.entryQualityGuards?.maximumEntryDisplacementBps !== 75 ||
      current?.orionV3BinanceUsdmDemo?.entryQualityGuards?.maximumEntrySignalAgeMs !== 300000 ||
      current?.orionV3BinanceUsdmDemo?.entryQualityGuards?.displacementReference !== decisionCloseReference ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
      v3Strategy?.risk?.maximumOpenPositionsTotal !== 18 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumOpenPositionsTotal !== 18 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumEffectiveNotionalLeverage !== 10) {
    errors.push("V3_LOCAL_STRATEGY_OVERRIDE_FORBIDDEN");
  }
  if (v3.venue?.name !== "BINANCE_USDM_TESTNET" || v3.venue?.fixedBaseUrl !== "https://demo-fapi.binance.com") {
    errors.push("V3_TESTNET_VENUE_INVALID");
  }
  requiredTrue(v3.venue?.networkEnabled, "V3_NETWORK_MUST_BE_ENABLED");
  requiredFalse(v3.venue?.productionHostsAllowed, "V3_PRODUCTION_HOSTS_FORBIDDEN");
  requiredTrue(v3.venue?.credentialAccessAllowed, "V3_CREDENTIAL_ACCESS_REQUIRED");
  requiredTrue(v3.venue?.signedRequestsAllowed, "V3_SIGNED_REQUESTS_REQUIRED");
  if (v3.orderModule?.status !== "IMPLEMENTED_OWNER_AUTHORIZED_AUTOMATED") errors.push("V3_ORDER_MODULE_NOT_ACTIVE");
  requiredTrue(v3.orderModule?.orderSubmissionAllowed, "V3_ORDER_SUBMISSION_NOT_ACTIVE");
  requiredTrue(v3.orderModule?.orderCancellationAllowed, "V3_ORDER_CANCELLATION_NOT_ACTIVE");
  requiredTrue(v3.orderModule?.deterministicClientOrderIds, "V3_IDEMPOTENCY_NOT_ACTIVE");
  requiredTrue(v3.orderModule?.protectiveStopRequired, "V3_PROTECTIVE_STOP_NOT_ACTIVE");
  if (v3.orderModule?.initialLeverageAlignmentAllowed !== true ||
      v3.orderModule?.targetInitialLeverage !== 10 ||
      current.orionV3BinanceUsdmDemo?.exchangeInitialLeverage?.target !== 10) {
    errors.push("V3_INITIAL_LEVERAGE_ALIGNMENT_INVALID");
  }
  for (const [value, code] of [
    [v3.orderModule?.marginModeChangesAllowed, "V3_MARGIN_MODE_CHANGE_FORBIDDEN"],
    [v3.orderModule?.withdrawalsOrTransfersAllowed, "V3_TRANSFER_FORBIDDEN"],
    [v3.isolation?.v2RuntimeMutationAllowed, "V3_V2_RUNTIME_MUTATION_FORBIDDEN"],
    [v3.isolation?.v2LedgerMutationAllowed, "V3_V2_LEDGER_MUTATION_FORBIDDEN"],
    [v3.isolation?.sharedPositionsAllowed, "V3_SHARED_POSITIONS_FORBIDDEN"],
    [v3.isolation?.sharedOrdersAllowed, "V3_SHARED_ORDERS_FORBIDDEN"],
    [current.execution?.realOrdersAuthorized, "GLOBAL_REAL_ORDER_ACTIVATION_FORBIDDEN"],
    [current.binanceUsdmTestnetReadOnlyReconciliation?.testnetOrdersAllowed, "READ_ONLY_GATE_TESTNET_ORDER_FORBIDDEN"],
    [current.binanceUsdmTestnetReadOnlyReconciliation?.realOrdersAllowed, "READ_ONLY_GATE_REAL_ORDER_FORBIDDEN"],
  ]) requiredFalse(value, code);
  if (v3.isolation?.startAllowed !== true ||
      v3.isolation?.startScope !== release?.residentScope ||
      v3.scanner?.automaticOrderSubmissionAllowed !== true ||
      current.orionV3BinanceUsdmDemo?.residentStartScope !== release?.residentScope) {
    errors.push("V3_RESIDENT_SCANNER_BOUNDARY_INVALID");
  }
  requiredTrue(current.execution?.testnetOrderActivationAllowed, "GLOBAL_TESTNET_ORDER_ACTIVATION_NOT_AUTHORIZED");
  requiredTrue(testnetGate.implementation?.orderSubmissionImplemented, "TESTNET_ORDER_MODULE_NOT_READY");
  requiredTrue(testnetGate.implementation?.orderCancellationImplemented, "TESTNET_CANCELLATION_MODULE_NOT_READY");

  if (testnetGate.status !== "ACTIVE_OWNER_AUTHORIZED_BINANCE_DEMO_TRADING" ||
      current.binanceUsdmTestnetReadOnlyReconciliation?.phase2ActivationAllowedNow !== true ||
      authorization.activation?.allowedNow !== true ||
      authorization.activation?.residentAutomaticStrategyMirroringAllowed !== false) {
    errors.push("V3_PHASE_TWO_GATE_INVALID");
  }
  if (v3.centralDistribution?.authorizationId !== hfAuthorization?.id ||
      current.v3ExperimentalStrategyRouting?.authorizationId !== hfAuthorization?.id ||
      v3.centralDistribution?.releaseMode !== "CENTRALLY_GOVERNED_SEPARATE_V3_EXPERIMENT" ||
      current.v3ExperimentalStrategyRouting?.status !== "ACTIVE_CENTRALLY_GOVERNED_SEPARATE_V3_EXPERIMENT" ||
      current.v3ExperimentalStrategyRouting?.automaticOrderSubmissionAllowed !== true ||
      current.v3ExperimentalStrategyRouting?.unversionedOverridesAllowed !== false ||
      v3.centralDistribution?.threadId !== current.orionV3BinanceUsdmDemo?.threadId) {
    errors.push("V3_HIGH_FREQUENCY_ROUTING_INVALID");
  }
  if (automaticAuthorization?.status !== "ACTIVE" ||
      automaticAuthorization?.id !== expectedAuthorizationId ||
      automaticAuthorization?.appliesTo?.release !== v3Strategy?.implementationRevision ||
      automaticAuthorization?.authorizes?.residentAutomaticCandidateExecution !== true ||
      automaticAuthorization?.authorizes?.automaticFifteenMinuteRunnerTrailing !== true ||
      automaticAuthorization?.hardRisk?.maximumEffectiveNotionalLeverage !== 10 ||
      automaticAuthorization?.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
      automaticAuthorization?.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
      automaticAuthorization?.hardRisk?.maximumOpenPositionsTotal !== 18 ||
      automaticAuthorization?.hardRisk?.maximumOpenPositionsPerSymbol !== 1 ||
      v3.automaticExecutionAuthorizationId !== automaticAuthorization?.id ||
      current.orionV3BinanceUsdmDemo?.automaticExecutionAuthorizationId !== automaticAuthorization?.id) {
    errors.push("V3_AUTOMATIC_EXECUTION_AUTHORIZATION_INVALID");
  }
  if (riskAuthorization?.status !== "ACTIVE" ||
      riskAuthorization?.id !== "OWNER-DIRECTIVE-ORION-V3-AGGRESSIVE-GROWTH-RISK-1PCT-10PCT-20260820" ||
      riskAuthorization?.riskPolicyRevision !== "V3-RISK-2-AGGRESSIVE-GROWTH-1PCT-10PCT-20260820" ||
      riskAuthorization?.scope?.agent !== "orion-v3" ||
      riskAuthorization?.scope?.venue !== "BINANCE_USDM_TESTNET" ||
      riskAuthorization?.scope?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
      riskAuthorization?.scope?.maximumRiskPerEntryFraction !== 0.01 ||
      riskAuthorization?.scope?.maximumManagedPortfolioRiskFraction !== 0.1 ||
      riskAuthorization?.unchangedHardBoundaries?.maximumEffectiveNotionalLeverage !== 10 ||
      riskAuthorization?.transition?.existingPositionEntryRiskStopOrQuantityRecalculationAllowed !== false ||
      v3?.riskPolicyAuthorizationId !== riskAuthorization?.id ||
      current?.orionV3BinanceUsdmDemo?.riskPolicyAuthorizationId !== riskAuthorization?.id) {
    errors.push("V3_RISK_POLICY_AUTHORIZATION_INVALID");
  }
  if (structuredZ && (hfAuthorization?.transition?.preserveAbnormalLossGate !== true ||
      hfAuthorization?.transition?.redLatchResetAuthorized !== false ||
      hfAuthorization?.transition?.preserveExistingManagedPositions !== true ||
      hfAuthorization?.transition?.preserveExistingProtectiveOrders !== true ||
      hfAuthorization?.transition?.preserveExistingImplementationAndCohortMetadata !== true ||
      hfAuthorization?.transition?.existingPositionEntryRiskStopOrQuantityRecalculationAllowed !== false ||
      hfAuthorization?.transition?.activationDropsPendingPriorRevisionCandidates !== true ||
      hfAuthorization?.evaluationIsolation?.historicalReclassificationAllowed !== false ||
      current?.orionV3BinanceUsdmDemo?.executionIntegrityRepair?.redLatchResetAuthorized !== false ||
      (hf14 && hfAuthorization?.transition?.newHf14EntriesAfterActivationAllowed !== true))) {
    errors.push(hf14 ? "V3_HF14_CUTOVER_PRESERVATION_INVALID" : "V3_HF13_CUTOVER_PRESERVATION_INVALID");
  }
  const recordedIntegrity = current?.orionV3BinanceUsdmDemo?.executionIntegrityRepair;

  return {
    status: errors.length ? "BLOCKED" : "READY_FOR_OWNER_AUTHORIZED_AUTOMATED_BINANCE_DEMO_TRADING",
    errors,
    strategyVersion: v3Strategy?.candidateVersion,
    implementationRevision: v3Strategy?.implementationRevision,
    orderSubmissionAllowed: errors.length === 0,
    automaticStrategyMirroringAllowed: false,
    centralDistributionMode: v3.centralDistribution?.releaseMode ?? null,
    recordedEntryAdmission: {
      source: "GOVERNANCE_RECORDED_INTEGRITY_STATE_NOT_CURRENT_RUNTIME",
      status: recordedIntegrity?.entryAdmissionStatus ?? "UNKNOWN",
      newEntriesAllowed: errors.length === 0 && recordedIntegrity?.newEntriesAllowed === true,
      redLatchResetAuthorized: structuredZ ? false : recordedIntegrity?.redLatchResetAuthorized ?? false,
      currentRuntimeGateRevalidationRequired: true,
    },
    v2Unmodified: true,
  };
}

export async function runPreflight({ readJsonImpl = readJson } = {}) {
  const v3Strategy = await readJsonImpl("experiments/v3-mtf-high-frequency/config.json");
  const release = releasePolicy(v3Strategy);
  if (!release) throw new Error("V3_HIGH_FREQUENCY_RELEASE_NOT_AUTHORIZED");
  const [v3, v2Runtime, v2Strategy, current, testnetGate, authorization, hfAuthorization, riskAuthorization] = await Promise.all([
    readJsonImpl("agents/orion-v3/binance-demo/config.json"),
    readJsonImpl("agents/orion-v2/paper/config.json"),
    readJsonImpl("experiments/v2-mtf-trendline-intersection/config.json"),
    readJsonImpl("governance/current-state.json"),
    readJsonImpl("experiments/v2-execution-reality/testnet-gate.json"),
    readJsonImpl("governance/owner-authorizations/2026-08-18-orion-v3-binance-usdm-demo-immediate-trading-cutover.json"),
    readJsonImpl(release.authorizationPath),
    readJsonImpl("governance/owner-authorizations/2026-08-20-orion-v3-aggressive-growth-risk-1pct-10pct.json"),
  ]);
  return validateV3Boundary({ v3, v2Runtime, v2Strategy, v3Strategy, current, testnetGate, authorization, hfAuthorization, automaticAuthorization: hfAuthorization, riskAuthorization });
}

export async function runOperationalPreflight() {
  const boundary = await runPreflight();
  const [reconciliation, managedState, resident, tradingAudit, automaticAudit] = await Promise.all([
    reconcile({ enabled: true, persist: false, now: Date.now() }),
    fs.readFile(TRADING_STATE_PATH, "utf8").then(JSON.parse),
    fs.readFile(path.join(root, ".runtime/orion-v3-binance-demo/scanner.pid.json"), "utf8").then(JSON.parse).catch(() => null),
    verifyTradingAuditLedger(),
    verifyChainedAudit(path.join(root, ".runtime/orion-v3-binance-demo/auto-audit.ndjson")),
  ]);
  const executionReconciliation = evaluateManagedExchangeReconciliation({
    accountMode: reconciliation.accountMode,
    positions: reconciliation.testnetPositions,
    openOrders: reconciliation.testnetOpenOrders,
    openAlgoOrders: reconciliation.testnetOpenAlgoOrders,
    managedState,
  });
  let residentAlive = false;
  if (Number(resident?.pid) > 0) {
    try {
      process.kill(Number(resident.pid), 0);
      residentAlive = true;
    } catch {
      residentAlive = false;
    }
  }
  const errors = [];
  if (boundary.status !== "READY_FOR_OWNER_AUTHORIZED_AUTOMATED_BINANCE_DEMO_TRADING") errors.push(...boundary.errors);
  if (reconciliation.accountCanTrade !== true) errors.push("V3_BINANCE_DEMO_ACCOUNT_CANNOT_TRADE");
  if (executionReconciliation.status !== "RECONCILED") errors.push(...executionReconciliation.errors);
  if (tradingAudit.status !== "VALID" || tradingAudit.chainedRecordCount < 1) errors.push("V3_TRADING_AUDIT_CHAIN_INVALID_OR_NOT_STARTED");
  if (automaticAudit.status !== "VALID" || automaticAudit.chainedRecordCount < 1) errors.push("V3_AUTOMATIC_AUDIT_CHAIN_INVALID_OR_NOT_STARTED");
  if (!residentAlive) errors.push("V3_RESIDENT_PROCESS_NOT_ALIVE");
  return {
    status: errors.length ? "BLOCKED_FAIL_CLOSED" : "READY_FOR_AUDITABLE_BINANCE_DEMO_TRADING",
    checkedAt: new Date().toISOString(),
    errors,
    boundary,
    accountMode: reconciliation.accountMode,
    accountCanTrade: reconciliation.accountCanTrade,
    livePositionCount: reconciliation.testnetPositions.length,
    standardOpenOrderCount: reconciliation.testnetStandardOpenOrderCount,
    protectiveAlgoOrderCount: reconciliation.testnetOpenAlgoOrderCount,
    executionReconciliation,
    tradingAudit,
    automaticAudit,
    resident: { pid: resident?.pid ?? null, status: resident?.status ?? null, alive: residentAlive },
    productionHostUsed: false,
    realOrdersSubmitted: 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runOperationalPreflight();
  if (report.status !== "READY_FOR_AUDITABLE_BINANCE_DEMO_TRADING") {
    throw new Error(`V3_BINANCE_DEMO_PREFLIGHT_BLOCKED_${report.errors.join("_")}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
