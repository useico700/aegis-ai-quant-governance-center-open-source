import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, writeJsonAtomic } from "../../orion-v2/paper/runtime-utils.mjs";
import { reconcile } from "../../../integrations/binance-usdm-testnet/read-only-reconciler.mjs";
import { TRADING_STATE_PATH, evaluateManagedExchangeReconciliation } from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";
import { scanHighFrequencyCandidates, applyDualZPlanGate } from "./high-frequency-strategy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const V3_RUNTIME_ROOT = path.join(ROOT, ".runtime", "orion-v3-binance-demo");
export const V3_LATEST_PATH = path.join(V3_RUNTIME_ROOT, "latest.json");
export const V3_PID_PATH = path.join(V3_RUNTIME_ROOT, "scanner.pid.json");
export const V3_CONFIG_PATH = path.join(ROOT, "agents/orion-v3/binance-demo/config.json");
export const V3_HIGH_FREQUENCY_CONFIG_PATH = path.join(ROOT, "experiments/v3-mtf-high-frequency/config.json");
const HF11_REVISION = "MTFX-V3-HF11-TRUE-4H-MARKET-STATE-GATE";
const HF11_BASELINE_COHORT = "ORION-V3-PRE-HF11-BASELINE-20260826";
const HF11_FORWARD_COHORT = "ORION-V3-HF11-TRUE-4H-MARKET-STATE-GATE-FORWARD-20260826";
const HF13_FORWARD_COHORT = "ORION-V3-HF13-DUAL-Z-FORWARD-20260914";
const HF14_FORWARD_COHORT = "ORION-V3-HF14-SINGLE-Z-FORWARD-20260914";

export function shouldRunV3StructuralDiscovery({ now, previous, hfConfig, symbols }) {
  const intervalMs = Number(hfConfig?.execution?.structuralDiscoveryIntervalMs);
  if (!(intervalMs > 0)) return true;
  if (previous?.implementationRevision !== hfConfig?.implementationRevision || previous?.evaluationCohortId !== hfConfig?.evaluationIsolation?.forwardCohortId) return true;
  if (Number(previous?.system?.broadUniverseSize) !== symbols.length) return true;
  const last = Date.parse(previous?.system?.lastStructuralDiscoveryAt ?? "");
  if (!Number.isFinite(last)) return true;
  return Math.floor(Number(now) / intervalMs) > Math.floor(last / intervalMs);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function zeroSmall(value, tolerance = 1e-9) {
  return Math.abs(value) < tolerance ? 0 : value;
}

function feeOrModel(value, notional, rate = 0.0007) {
  return Number.isFinite(Number(value)) ? Number(value) : Math.max(0, Number(notional) || 0) * rate;
}

function normalizeClosedFeeRecord(row) {
  const originalQuantity = finite(row?.originalQuantity);
  const finalQuantity = finite(row?.finalExitQuantity);
  const entryPrice = finite(row?.entryPrice);
  const finalPrice = finite(row?.finalExitPrice);
  const partialExits = (row?.partialExits ?? []).map((partial) => {
    const notional = finite(partial?.fill) * finite(partial?.quantity);
    const exitFee = feeOrModel(partial?.exitFee, notional);
    return { ...partial, exitFee, exitFeeRate: Number.isFinite(Number(partial?.exitFeeRate)) ? Number(partial.exitFeeRate) : (notional > 0 ? exitFee / notional : null) };
  });
  const entryNotional = entryPrice * originalQuantity;
  const finalNotional = finalPrice * finalQuantity;
  const entryCommissionUsdt = feeOrModel(row?.entryCommissionUsdt, entryNotional);
  const partialExitCommissionUsdt = Number.isFinite(Number(row?.partialExitCommissionUsdt))
    ? Number(row.partialExitCommissionUsdt)
    : partialExits.reduce((sum, partial) => sum + finite(partial.exitFee), 0);
  const finalExitCommissionUsdt = feeOrModel(row?.finalExitCommissionUsdt, finalNotional);
  return {
    ...row,
    entryCommissionUsdt,
    entryCommissionRate: Number.isFinite(Number(row?.entryCommissionRate)) ? Number(row.entryCommissionRate) : (entryNotional > 0 ? entryCommissionUsdt / entryNotional : null),
    partialExitCommissionUsdt,
    finalExitCommissionUsdt,
    finalExitCommissionRate: Number.isFinite(Number(row?.finalExitCommissionRate)) ? Number(row.finalExitCommissionRate) : (finalNotional > 0 ? finalExitCommissionUsdt / finalNotional : null),
    totalCommissionUsdt: Number.isFinite(Number(row?.totalCommissionUsdt)) ? Number(row.totalCommissionUsdt) : entryCommissionUsdt + partialExitCommissionUsdt + finalExitCommissionUsdt,
    feeEvidence: row?.feeEvidence ?? "AUTHORIZED_CONSERVATIVE_TAKER_FEE_MODEL",
    partialExits,
  };
}

const EXECUTION_INCIDENT_CLOSE_REASONS = new Set([
  "UNPROTECTED_ENTRY_ROLLBACK_AFTER_STOP_CROSSED",
  "PROTECTIVE_STOP_SUBMISSION_FAILED_ENTRY_ROLLBACK",
  "PROTECTIVE_STOP_REPLACEMENT_RECOVERY_FAILED",
]);

export function classifyClosedOutcomeAttribution(row) {
  const closeReason = String(row?.closeReason ?? "");
  const attributionClass = EXECUTION_INCIDENT_CLOSE_REASONS.has(closeReason) ? "EXECUTION_INCIDENT" : "STRATEGY_OUTCOME";
  return {
    attributionClass,
    attributionReason: attributionClass === "EXECUTION_INCIDENT" ? closeReason : "AUTHORIZED_STRATEGY_LIFECYCLE",
    accountFactPreserved: true,
    excludedFromStrategyEffectivenessStatistics: attributionClass === "EXECUTION_INCIDENT",
  };
}

export function buildOutcomeAttribution(closedPositions = []) {
  const summarize = (rows) => ({
    closedTradeCount: rows.length,
    realizedNetPnlUsdt: rows.reduce((sum, row) => sum + finite(row?.netPnl), 0),
    totalCommissionUsdt: rows.reduce((sum, row) => sum + finite(row?.totalCommissionUsdt), 0),
  });
  const strategy = closedPositions.filter((row) => row.attribution?.attributionClass === "STRATEGY_OUTCOME");
  const incidents = closedPositions.filter((row) => row.attribution?.attributionClass === "EXECUTION_INCIDENT");
  return {
    policy: "ACCOUNT_TOTAL_PRESERVED_STRATEGY_AND_EXECUTION_INCIDENT_ANALYTICS_SEPARATED",
    strategyOutcomes: summarize(strategy),
    executionIncidents: summarize(incidents),
    accountTotal: summarize(closedPositions),
    arithmeticReconciled: strategy.length + incidents.length === closedPositions.length,
    historicalAccountFactsRewritten: false,
  };
}

export function buildEquityAttribution({ account = {}, baselineUsdt = 0, closedPositions = [], managedPositions = [], incomeHistory = null, incomeHistoryMeta = null } = {}) {
  const walletBalanceUsdt = finite(account.totalWalletBalanceUsdt);
  const unrealizedPnlUsdt = finite(account.totalUnrealizedProfitUsdt);
  const marginEquityUsdt = finite(account.totalMarginBalanceUsdt);
  const completedTradeNetPnlUsdt = closedPositions.reduce((sum, row) => sum + finite(row?.netPnl), 0);
  const completedTradeCommissionUsdt = closedPositions.reduce((sum, row) => sum + finite(row?.totalCommissionUsdt), 0);
  const openPositionPartialRealizedGrossPnlUsdt = managedPositions.reduce((sum, row) => sum + finite(row?.cumulativeGrossPnl), 0);
  const openPositionPartialRealizedNetPnlUsdt = managedPositions.reduce((sum, row) => sum + finite(row?.cumulativeRealizedNetPnl), 0);
  const openPositionEntryCommissionUsdt = managedPositions.reduce((sum, row) => sum + finite(row?.entryFee), 0);
  const openPositionAllocatedEntryCommissionUsdt = managedPositions.reduce((sum, row) => sum + (row?.partialExits ?? []).reduce((partialSum, partial) => partialSum + finite(partial?.entryFeeAllocated), 0), 0);
  const openPositionExitCommissionUsdt = managedPositions.reduce((sum, row) => sum + finite(row?.cumulativeExitFee), 0);
  const rows = Array.isArray(incomeHistory) ? incomeHistory : [];
  const usdtRows = rows.filter((row) => row?.asset === "USDT");
  const nonUsdtRows = rows.filter((row) => row?.asset !== "USDT");
  const byType = {};
  for (const row of usdtRows) byType[row.incomeType ?? "UNKNOWN"] = finite(byType[row.incomeType ?? "UNKNOWN"]) + finite(row.income);
  const exchangeRealizedPnlUsdt = finite(byType.REALIZED_PNL);
  const exchangeCommissionUsdt = finite(byType.COMMISSION);
  const exchangeFundingFeeUsdt = finite(byType.FUNDING_FEE);
  const exchangeOtherAdjustmentsUsdt = Object.entries(byType)
    .filter(([type]) => !["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"].includes(type))
    .reduce((sum, [, value]) => sum + finite(value), 0);
  const exchangeIncomeLedgerTotalUsdt = usdtRows.reduce((sum, row) => sum + finite(row?.income), 0);
  const walletBalanceDeltaFromBaselineUsdt = walletBalanceUsdt - baselineUsdt;
  const equityDeltaFromBaselineUsdt = marginEquityUsdt - baselineUsdt;
  const walletUnreconciledDifferenceUsdt = zeroSmall(walletBalanceDeltaFromBaselineUsdt - exchangeIncomeLedgerTotalUsdt);
  const accountEquationDifferenceUsdt = zeroSmall(marginEquityUsdt - walletBalanceUsdt - unrealizedPnlUsdt);
  const strategyLedgerRealizedNetPnlUsdt = completedTradeNetPnlUsdt + openPositionPartialRealizedNetPnlUsdt;
  const openPositionUnallocatedEntryCommissionUsdt = openPositionEntryCommissionUsdt - openPositionAllocatedEntryCommissionUsdt;
  const strategyAttributedWalletChangeUsdt = strategyLedgerRealizedNetPnlUsdt - openPositionUnallocatedEntryCommissionUsdt + exchangeFundingFeeUsdt;
  const strategyLedgerCoverageDifferenceUsdt = zeroSmall(walletBalanceDeltaFromBaselineUsdt - strategyAttributedWalletChangeUsdt);
  const historyRequested = incomeHistoryMeta !== null;
  const historyComplete = incomeHistoryMeta?.complete === true;
  const reconciled = historyComplete && nonUsdtRows.length === 0 && Math.abs(walletUnreconciledDifferenceUsdt) < 0.01 && Math.abs(accountEquationDifferenceUsdt) < 0.01;
  const status = !historyRequested ? "INCOME_HISTORY_NOT_REQUESTED"
    : !historyComplete ? "INCOME_HISTORY_PARTIAL"
      : nonUsdtRows.length ? "NON_USDT_INCOME_REQUIRES_SEPARATE_VALUATION"
        : reconciled ? "RECONCILED" : "DIFFERENCE_DETECTED";
  return {
    status,
    baselineUsdt,
    walletBalanceDeltaFromBaselineUsdt,
    walletBalanceUsdt,
    unrealizedPnlUsdt,
    marginEquityUsdt,
    equityDeltaFromBaselineUsdt,
    accountEquationDifferenceUsdt,
    completedTradeNetPnlUsdt,
    completedTradeCommissionUsdt,
    openPositionPartialRealizedGrossPnlUsdt,
    openPositionPartialRealizedNetPnlUsdt,
    strategyLedgerRealizedNetPnlUsdt,
    openPositionEntryCommissionUsdt,
    openPositionAllocatedEntryCommissionUsdt,
    openPositionUnallocatedEntryCommissionUsdt,
    openPositionExitCommissionUsdt,
    exchangeRealizedPnlUsdt,
    exchangeCommissionUsdt,
    exchangeFundingFeeUsdt,
    exchangeOtherAdjustmentsUsdt,
    exchangeIncomeLedgerTotalUsdt,
    walletUnreconciledDifferenceUsdt,
    strategyAttributedWalletChangeUsdt,
    strategyLedgerCoverageDifferenceUsdt,
    strategyLedgerCoverageStatus: Math.abs(strategyLedgerCoverageDifferenceUsdt) < 0.01 ? "RECONCILED" : "DIFFERENCE_REQUIRES_TRADE_ATTRIBUTION",
    incomeByTypeUsdt: Object.fromEntries(Object.entries(byType).sort(([left], [right]) => left.localeCompare(right))),
    incomeHistoryAuthorizationId: incomeHistoryMeta?.authorizationId ?? null,
    incomeHistoryStartTime: incomeHistoryMeta?.startTime ?? null,
    incomeHistoryEndTime: incomeHistoryMeta?.endTime ?? null,
    incomeHistoryRowCount: incomeHistoryMeta?.rowCount ?? null,
    incomeHistoryComplete: historyComplete,
    nonUsdtIncomeRowCount: nonUsdtRows.length,
    feesAlreadyIncludedInWalletAndEquity: true,
    completedAndPartialNetPnlAlreadyIncludeAllocatedFees: true,
  };
}

export function buildV3Snapshot({ reconciliation, strategyScan = null, hfConfig = null, v2Latest = null, v2Runtime = null, managedState = null, v3Config, scanMeta = null, now = Date.now() }) {
  const account = reconciliation?.accountEquity ?? {};
  const actualEquity = finite(account.totalMarginBalanceUsdt);
  const strategyInitialCapital = finite(v3Config?.account?.strategyInitialCapitalUsdt, 5_000);
  const plans = Array.isArray(strategyScan?.plans) ? strategyScan.plans : Array.isArray(v2Latest?.plans) ? v2Latest.plans : [];
  const positions = Array.isArray(reconciliation?.testnetPositions) ? reconciliation.testnetPositions : [];
  const totalOpenNotionalUsdt = positions.reduce((sum, position) => sum + Math.abs(finite(position?.quantity) * finite(position?.markPrice)), 0);
  const actualEffectiveNotionalLeverage = actualEquity > 0 ? totalOpenNotionalUsdt / actualEquity : 0;
  const openOrders = finite(reconciliation?.testnetOpenOrderCount);
  const standardOpenOrders = finite(reconciliation?.testnetStandardOpenOrderCount);
  const openAlgoOrders = finite(reconciliation?.testnetOpenAlgoOrderCount);
  const observedAt = reconciliation?.checkedAt ?? new Date(now).toISOString();
  const sourceScanAt = Date.parse(strategyScan?.scannedAt ?? "") || Number(v2Latest?.lastSuccessfulScanAt) || null;
  const baselineCohortId = hfConfig?.evaluationIsolation?.baselineCohortId ?? "ORION-V3-PRE-UNIVERSE30-BASELINE-20260820";
  const forwardCohortId = hfConfig?.evaluationIsolation?.forwardCohortId ?? "ORION-V3-HF11-TRUE-4H-MARKET-STATE-GATE-FORWARD-20260826";
  const hf13Active = /^MTFX-V3-HF13(?:-|$)/.test(hfConfig?.implementationRevision ?? "");
  const hf14Active = /^MTFX-V3-HF14(?:-|$)/.test(hfConfig?.implementationRevision ?? "");
  const structuredZActive = hf13Active || hf14Active;
  const cohortId = (row) => {
    if (row?.evaluationCohortId != null) return row.evaluationCohortId;
    // New HF13 entries require an explicit cohort receipt. A missing receipt
    // remains visible as unclassified; never infer a forward trading sample.
    if (/^MTFX-V3-HF1[34](?:-|$)/.test(row?.implementationRevision ?? "")) return null;
    if (structuredZActive) return row?.implementationRevision === HF11_REVISION ? HF11_FORWARD_COHORT : HF11_BASELINE_COHORT;
    return row?.implementationRevision === hfConfig?.implementationRevision ? forwardCohortId : baselineCohortId;
  };
  const closedPositions = Array.isArray(managedState?.closedPositions)
    ? managedState.closedPositions.map((row) => ({ ...normalizeClosedFeeRecord(row), evaluationCohortId: cohortId(row), attribution: classifyClosedOutcomeAttribution(row) }))
    : [];
  const managedPositions = Object.values(managedState?.managedPositions ?? {})
    .map((row) => ({ ...row, evaluationCohortId: cohortId(row) }));
  const executionReconciliation = evaluateManagedExchangeReconciliation({
    accountMode: reconciliation?.accountMode,
    positions,
    openOrders: reconciliation?.testnetOpenOrders,
    openAlgoOrders: reconciliation?.testnetOpenAlgoOrders,
    managedState,
  });
  executionReconciliation.checkedAt = observedAt;
  const realizedNetPnlUsdt = closedPositions.reduce((sum, row) => sum + finite(row?.netPnl), 0);
  const totalCommissionUsdt = closedPositions.reduce((sum, row) => sum + finite(row?.totalCommissionUsdt), 0);
  const exactCommissionTradeCount = closedPositions.filter((row) => row?.actualCommissionEvidenceComplete === true).length;
  const outcomeAttribution = buildOutcomeAttribution(closedPositions);
  const equityAttribution = buildEquityAttribution({
    account,
    baselineUsdt: strategyInitialCapital,
    closedPositions,
    managedPositions,
    incomeHistory: reconciliation?.incomeHistory,
    incomeHistoryMeta: reconciliation?.incomeHistoryMeta,
  });
  const cohortGroups = structuredZActive ? [
    { id: HF11_BASELINE_COHORT, classification: "PRE_HF11_BASELINE", includes: (row) => row.evaluationCohortId != null && ![HF11_FORWARD_COHORT, HF13_FORWARD_COHORT, HF14_FORWARD_COHORT].includes(row.evaluationCohortId) },
    { id: HF11_FORWARD_COHORT, classification: "HF11_FORWARD", includes: (row) => row.evaluationCohortId === HF11_FORWARD_COHORT },
    { id: HF13_FORWARD_COHORT, classification: "HF13_FORWARD", includes: (row) => row.evaluationCohortId === HF13_FORWARD_COHORT },
    ...(hf14Active ? [{ id: HF14_FORWARD_COHORT, classification: "HF14_FORWARD", includes: (row) => row.evaluationCohortId === HF14_FORWARD_COHORT }] : []),
    ...([...closedPositions, ...managedPositions].some((row) => row.evaluationCohortId == null)
      ? [{ id: null, classification: "UNCLASSIFIED", includes: (row) => row.evaluationCohortId == null }]
      : []),
  ] : [
    { id: baselineCohortId, classification: "PRE_HF11_BASELINE", includes: (row) => row.evaluationCohortId !== forwardCohortId },
    { id: forwardCohortId, classification: "HF11_FORWARD", includes: (row) => row.evaluationCohortId === forwardCohortId },
  ];
  const cohortAccounting = cohortGroups.map(({ id, classification, includes }) => {
    const closed = closedPositions.filter(includes);
    const open = managedPositions.filter(includes);
    return {
      evaluationCohortId: id,
      classification,
      openPositionCount: open.length,
      closedTradeCount: closed.length,
      realizedNetPnlUsdt: closed.reduce((sum, row) => sum + finite(row?.netPnl), 0),
      totalCommissionUsdt: closed.reduce((sum, row) => sum + finite(row?.totalCommissionUsdt), 0),
    };
  });
  return {
    schemaVersion: 1,
    runtimeId: "ORION-V3-BINANCE-USDM-DEMO-SCANNER-1.0",
    lifecycle: "ACTIVE_RESIDENT_AUTOMATED_BINANCE_DEMO_EXECUTION",
    venue: "BINANCE_USDM_TESTNET",
    baseUrl: "https://demo-fapi.binance.com",
    strategyVersion: hfConfig?.candidateVersion ?? strategyScan?.strategyVersion ?? v2Runtime?.strategyVersion ?? null,
    strategyDisplayName: hfConfig?.displayName ?? null,
    implementationRevision: hfConfig?.implementationRevision ?? strategyScan?.implementationRevision ?? v2Runtime?.implementationRevision ?? null,
    riskPolicyRevision: hfConfig?.riskPolicyRevision ?? strategyScan?.riskPolicyRevision ?? null,
    riskPolicyAuthorizationId: hfConfig?.riskPolicyAuthorizationId ?? strategyScan?.riskPolicyAuthorizationId ?? null,
    evaluationCohortId: forwardCohortId,
    evaluationIsolation: {
      baselineCohortId,
      forwardCohortId,
      assignmentRule: hfConfig?.evaluationIsolation?.assignmentRule ?? "ENTRY_OPENED_UNDER_IMPLEMENTATION_REVISION",
      baselineManifest: v3Config?.evaluationIsolation?.baselineManifest ?? null,
      mixedPerformanceAggregationAllowed: false,
    },
    strategySource: v3Config?.scanner?.candidateSource ?? "V3_OWNER_AUTHORIZED_TRUE_4H_STATE_1H_15M_MATHEMATICAL_SCANNER",
    timeframes: { marketState: "4h", primaryStructure: "1h", opposingStructure: "15m", entryDecision: hfConfig?.timeframes?.entryDecision ?? "5m", runnerTrail: "15m" },
    scannedAt: new Date(now).toISOString(),
    sourceStrategyScanAt: sourceScanAt ? new Date(sourceScanAt).toISOString() : null,
    accountObservedAt: observedAt,
    account: {
      strategyInitialCapitalUsdt: strategyInitialCapital,
      performanceBaselineUsdt: finite(v3Config?.account?.performanceBaselineUsdt, strategyInitialCapital),
      totalWalletBalanceUsdt: finite(account.totalWalletBalanceUsdt),
      totalUnrealizedProfitUsdt: finite(account.totalUnrealizedProfitUsdt),
      totalMarginBalanceUsdt: actualEquity,
      availableBalanceUsdt: finite(account.availableBalanceUsdt),
      totalInitialMarginUsdt: finite(account.totalInitialMarginUsdt),
      totalMaintMarginUsdt: finite(account.totalMaintMarginUsdt),
      equitySource: "BINANCE_USDM_DEMO_SIGNED_ACCOUNT_ACTUAL",
      actualMinusStrategyBaselineUsdt: actualEquity - strategyInitialCapital,
      walletBalanceDeltaFromBaselineUsdt: equityAttribution.walletBalanceDeltaFromBaselineUsdt,
      equityDeltaFromBaselineUsdt: equityAttribution.equityDeltaFromBaselineUsdt,
      baselineMatched: Math.abs(actualEquity - strategyInitialCapital) < 0.01,
    },
    risk: {
      maximumRiskPerEntryFraction: finite(hfConfig?.risk?.maximumRiskPerIntersectionFraction, 0.01),
      maximumPortfolioRiskFraction: finite(hfConfig?.risk?.maximumPortfolioRiskFraction, 0.1),
      maximumOpenPositionsTotal: finite(hfConfig?.risk?.maximumOpenPositionsTotal, 18),
      maximumLeverage: finite(hfConfig?.risk?.maximumLeverage, 10),
      exchangeInitialLeverageTarget: 10,
      totalOpenNotionalUsdt,
      actualEffectiveNotionalLeverage,
      observedExchangeInitialLeverages: [...new Set(positions.map((position) => finite(position?.leverage)).filter((value) => value > 0))].sort((a, b) => a - b),
      openPositionCount: positions.length,
      openOrderCount: openOrders,
      standardOpenOrderCount: standardOpenOrders,
      protectiveAlgoOrderCount: openAlgoOrders,
      protectedPositionCount: executionReconciliation.protectedPositionCount,
      riskEquityCeilingUsdt: actualEquity,
    },
    positions,
    managedPositions,
    closedPositions,
    accounting: {
      closedTradeCount: closedPositions.length,
      completedTradeNetPnlUsdt: realizedNetPnlUsdt,
      openPositionPartialRealizedNetPnlUsdt: equityAttribution.openPositionPartialRealizedNetPnlUsdt,
      strategyLedgerRealizedNetPnlUsdt: equityAttribution.strategyLedgerRealizedNetPnlUsdt,
      realizedNetPnlUsdt,
      totalCommissionUsdt,
      exactCommissionTradeCount,
      modeledOrMixedCommissionTradeCount: closedPositions.length - exactCommissionTradeCount,
      cohorts: cohortAccounting,
      outcomeAttribution,
      equityAlreadyIncludesExchangeCommission: true,
      commissionPrimarySource: "BINANCE_USDM_DEMO_USER_TRADES",
    },
    equityAttribution,
    plans,
    planCount: plans.length,
    candidateSelectionAudit: Array.isArray(strategyScan?.candidateSelectionAudit) ? strategyScan.candidateSelectionAudit : [],
    accountCanTrade: reconciliation?.accountCanTrade === true,
    accountMode: reconciliation?.accountMode ?? null,
    executionReconciliation,
    system: {
      scannerMode: hf14Active ? "RESIDENT_ACCOUNT_SCAN_AND_HF14_AUTOMATED_BINANCE_DEMO_EXECUTION" : hf13Active ? "RESIDENT_ACCOUNT_SCAN_AND_HF13_AUTOMATED_BINANCE_DEMO_EXECUTION" : "RESIDENT_ACCOUNT_SCAN_AND_HF11_AUTOMATED_BINANCE_DEMO_EXECUTION",
      tieredScanMode: "BROAD_5M_STRUCTURE_AND_60S_CANDIDATE_POSITION_RECONCILIATION",
      broadUniverseSize: v3Config?.universe?.symbols?.length ?? 0,
      residentCycleMs: v3Config?.scanner?.scanIntervalMs ?? 60_000,
      structuralDiscoveryIntervalMs: hfConfig?.execution?.structuralDiscoveryIntervalMs ?? 300_000,
      candidatePositionAndReconciliationIntervalMs: hfConfig?.execution?.candidatePositionAndReconciliationIntervalMs ?? 60_000,
      marketStateInterval: hfConfig?.marketStateGate?.interval ?? "4h",
      marketStateSource: hfConfig?.marketStateGate?.source ?? null,
      marketStateExecutionInput: hfConfig?.marketStateGate?.executionGate !== false,
      marketStateRequestInExecutionScan: hfConfig?.marketStateGate?.requestInExecutionScan !== false,
      unfinishedFourHourBarsAllowed: hfConfig?.marketStateGate?.unfinishedBarsAllowed ?? false,
      structuralDiscoveryPerformedThisCycle: scanMeta?.performed === true,
      lastStructuralDiscoveryAt: scanMeta?.lastStructuralDiscoveryAt ?? null,
      nextStructuralDiscoveryAt: scanMeta?.nextStructuralDiscoveryAt ?? null,
      automaticOrderSubmissionAllowed: executionReconciliation.status === "RECONCILED",
      matchingEngineOrdersSubmittedByScanner: null,
      realOrdersSubmitted: 0,
      v2RuntimeMutated: false,
      v2LedgerMutated: false,
    },
  };
}

export async function scanV3Once({ now = Date.now(), persist = true, reconcileImpl = reconcile, strategyScanner = scanHighFrequencyCandidates, forceStructuralDiscovery = false } = {}) {
  const v3Config = await readJson(V3_CONFIG_PATH);
  const incomeStartTime = Date.parse(v3Config?.account?.equityAttributionStartTime ?? "");
  const [reconciliation, hfConfig, previous, managedState] = await Promise.all([
    reconcileImpl({ enabled: true, persist: false, now, includeIncomeHistory: true, incomeStartTime }),
    readJson(V3_HIGH_FREQUENCY_CONFIG_PATH),
    readJson(V3_LATEST_PATH, null),
    readJson(TRADING_STATE_PATH, null),
  ]);
  const performStructuralDiscovery = forceStructuralDiscovery || shouldRunV3StructuralDiscovery({ now, previous, hfConfig, symbols: v3Config.universe.symbols });
  const intervalMs = Number(hfConfig.execution.structuralDiscoveryIntervalMs);
  const strategyScan = performStructuralDiscovery
    ? await strategyScanner({ symbols: v3Config.universe.symbols, config: hfConfig, previousPlans: previous?.plans ?? [], now })
    : {
        scannedAt: previous?.system?.lastStructuralDiscoveryAt,
        marketTime: Date.parse(previous?.system?.lastStructuralDiscoveryAt ?? "") || now,
        strategyVersion: hfConfig.candidateVersion,
        implementationRevision: hfConfig.implementationRevision,
        riskPolicyRevision: hfConfig.riskPolicyRevision,
        riskPolicyAuthorizationId: hfConfig.riskPolicyAuthorizationId,
        evaluationCohortId: hfConfig.evaluationIsolation.forwardCohortId,
        plans: previous?.implementationRevision === hfConfig.implementationRevision && previous?.evaluationCohortId === hfConfig.evaluationIsolation.forwardCohortId
          ? (previous?.plans ?? []).map((plan) => applyDualZPlanGate(plan, hfConfig, now))
          : [],
        planCount: previous?.implementationRevision === hfConfig.implementationRevision && previous?.evaluationCohortId === hfConfig.evaluationIsolation.forwardCohortId
          ? previous?.plans?.length ?? 0
          : 0,
        candidateSelectionAudit: previous?.implementationRevision === hfConfig.implementationRevision && previous?.evaluationCohortId === hfConfig.evaluationIsolation.forwardCohortId
          ? previous?.candidateSelectionAudit ?? []
          : [],
        automaticOrderSubmissionAllowed: true,
      };
  const lastStructuralDiscoveryAt = performStructuralDiscovery ? strategyScan.scannedAt : previous.system.lastStructuralDiscoveryAt;
  const lastMs = Date.parse(lastStructuralDiscoveryAt);
  const nextStructuralDiscoveryAt = new Date((Math.floor(lastMs / intervalMs) + 1) * intervalMs).toISOString();
  const scanMeta = { performed: performStructuralDiscovery, lastStructuralDiscoveryAt, nextStructuralDiscoveryAt };
  const snapshot = buildV3Snapshot({ reconciliation, strategyScan, hfConfig, managedState, v3Config, scanMeta, now });
  if (persist) await writeJsonAtomic(V3_LATEST_PATH, snapshot);
  return snapshot;
}
