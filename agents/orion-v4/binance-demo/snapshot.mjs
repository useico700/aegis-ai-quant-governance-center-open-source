import path from "node:path";

import { readJson, writeJsonAtomic } from "./runtime-utils.mjs";
import { snapshotV4DemoAccount } from "../../../experiments/v4-range-mean-reversion/src/demo-account.mjs";
import { v4EvaluateManagedExchangeReconciliation, v4LoadManagedTradingState } from "../../../experiments/v4-range-mean-reversion/src/execution-gateway.mjs";
import { ROOT, loadMtfxR20Context } from "./context.mjs";
import { V4DemoMarketClient } from "./market-client.mjs";
import { scanSymbolMtfx } from "./strategy.mjs";
import { loadCandidateLifecycle, markCandidateTerminal, persistActiveCandidates } from "./execution-parity.mjs";

export const V4_RUNTIME_ROOT = path.join(ROOT, ".runtime/orion-v4-binance-demo");
export const V4_LATEST_PATH = path.join(V4_RUNTIME_ROOT, "strategy-latest.json");
export const V4_PID_PATH = path.join(V4_RUNTIME_ROOT, "scanner.pid.json");

function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

export async function scanV4Once({ persist = true, client = new V4DemoMarketClient(), accountSnapshotImpl = snapshotV4DemoAccount } = {}) {
  const { config, sourceStrategy } = await loadMtfxR20Context();
  const serverTime = await client.serverTime();
  const previous = await readJson(V4_LATEST_PATH, null);
  const parityActivatedAt = Date.parse(config.executionParity?.activatedAt ?? config.riskPolicy.activatedAt);
  const lifecycleContext = { activatedAt: parityActivatedAt, cohortId: config.evaluationIsolation.forwardCohortId, implementationRevision: config.implementationRevision, signalPolicy: sourceStrategy.signal, now: serverTime };
  const candidateLifecycle = await loadCandidateLifecycle(lifecycleContext);
  const previousBySymbol = new Map(config.executionParity?.enabled === true
    ? Object.entries(candidateLifecycle.activeBySymbol ?? {}).map(([symbol, row]) => [symbol, { plan: row.plan }])
    : (previous?.plans ?? []).map((row) => [row.symbol, row]));
  const rows = [];
  for (const symbol of config.universe.symbols) {
    const limits = config.runtime.marketDataLimits;
    const [bars15m, bars1h, bars4h] = await Promise.all([
      client.bars(symbol, "15m", limits["15m"], serverTime),
      client.bars(symbol, "1h", limits["1h"], serverTime),
      client.bars(symbol, "4h", limits["4h"], serverTime),
    ]);
    rows.push(scanSymbolMtfx({ symbol, bars15m, bars1h, bars4h, sourceStrategy, config, previousRow: previousBySymbol.get(symbol), now: serverTime }));
  }
  if (config.executionParity?.enabled === true) {
    for (const row of rows.filter((item) => item.plan && item.signal?.terminal === true)) {
      await markCandidateTerminal({ symbol: row.symbol, planId: row.plan.id, status: row.signal.reason?.includes("EXPIRE") ? "EXPIRED" : "REJECTED", reason: row.signal.reason }, lifecycleContext);
      row.plan = null;
      row.assessment = { eligible: false, economicPrequalified: false, reason: row.signal.reason };
    }
    await persistActiveCandidates(rows, lifecycleContext);
  }
  const [account, managedState] = await Promise.all([
    accountSnapshotImpl({ enabled: true, persist: false, now: serverTime }),
    v4LoadManagedTradingState(),
  ]);
  const executionReconciliation = await v4EvaluateManagedExchangeReconciliation({
    accountMode: account.accountMode, positions: account.openPositions, openOrders: account.openStandardOrders,
    openAlgoOrders: account.openAlgoOrders, managedState,
  });
  executionReconciliation.checkedAt = account.checkedAt;
  const positions = account.openPositions ?? [];
  const equity = finite(account.accountEquity?.totalMarginBalanceUsdt);
  const totalOpenNotionalUsdt = positions.reduce((sum, row) => sum + Math.abs(finite(row.quantity) * finite(row.markPrice)), 0);
  const activePlans = rows.filter((row) => row.plan);
  const signals = rows.filter((row) => row.signal?.status?.startsWith("CONFIRMED_"));
  const snapshot = {
    schemaVersion: 2,
    runtimeId: "ORION-V4-MTFX-R22-1.0",
    lifecycle: "ACTIVE_RESIDENT_AUTOMATED_EXECUTION",
    venue: "BINANCE_USDM_ACCOUNT",
    strategyVersion: config.candidateVersion,
    implementationRevision: config.implementationRevision,
    sourceImplementationRevision: sourceStrategy.implementationRevision,
    riskPolicyRevision: config.riskPolicy.revision,
    riskPolicyAuthorizationId: config.riskPolicy.authorizationId,
    forwardSignalCutoffAt: config.executionParity?.activatedAt ?? config.riskPolicy.activatedAt,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    scannedAt: new Date(serverTime).toISOString(),
    accountObservedAt: account.checkedAt,
    account: account.accountEquity,
    accountCanTrade: account.accountCanTrade,
    accountMode: account.accountMode,
    positions,
    managedPositions: Object.values(managedState.managedPositions ?? {}),
    closedPositions: managedState.closedPositions ?? [],
    openStandardOrders: account.openStandardOrders ?? [],
    openAlgoOrders: account.openAlgoOrders ?? [],
    risk: {
      maximumRiskPerEntryFraction: config.risk.maximumRiskPerEntryFraction,
      maximumPortfolioRiskFraction: config.risk.maximumPortfolioRiskFraction,
      maximumOpenPositionsTotal: config.risk.maximumOpenPositionsTotal,
      maximumEffectiveNotionalLeverage: config.risk.maximumEffectiveNotionalLeverage,
      openPositionCount: positions.length,
      protectedPositionCount: executionReconciliation.protectedPositionCount,
      totalOpenNotionalUsdt,
      actualEffectiveNotionalLeverage: equity > 0 ? totalOpenNotionalUsdt / equity : 0,
    },
    plans: rows,
    planCount: activePlans.length,
    economicPrequalifiedCount: rows.filter((row) => row.assessment?.economicPrequalified).length,
    eligibleRangeCount: activePlans.length,
    eligibleCorridorCount: activePlans.length,
    confirmedSignalCount: signals.length,
    executionReconciliation,
    system: {
      scanIntervalMs: config.runtime.scanIntervalMs,
      tieredScanMode: "FULL_MTFX_60S_SCAN_AND_POSITION_RECONCILIATION",
      broadUniverseSize: config.universe.symbols.length,
      structuralDiscoveryIntervalMs: config.runtime.scanIntervalMs,
      candidatePositionAndReconciliationIntervalMs: config.runtime.scanIntervalMs,
      structuralDiscoveryPerformedThisCycle: true,
      lastStructuralDiscoveryAt: new Date(serverTime).toISOString(),
      automaticOrderSubmissionAllowed: executionReconciliation.status === "RECONCILED",
      sourceStrategyReadOnly: true,
      sourceRuntimeAccessed: false,
      sourceRuntimeMutated: false,
      candidateLifecycleDurable: config.executionParity?.enabled === true,
      causalBboRequired: config.executionParity?.causalBboRequired === true,
    },
  };
  if (persist) await writeJsonAtomic(V4_LATEST_PATH, snapshot);
  return snapshot;
}
