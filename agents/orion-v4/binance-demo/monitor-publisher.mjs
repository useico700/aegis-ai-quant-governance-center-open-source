import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import monitorConfig from "./monitor-config.json" with { type: "json" };
import strategyConfig from "../../../experiments/v4-mtfx-r20/config.json" with { type: "json" };
import { V4_AUTO_STATE_PATH } from "./auto-executor.mjs";
import { V4_BBO_LATEST_PATH } from "./execution-parity.mjs";
import { V4_LATEST_PATH, V4_PID_PATH } from "./snapshot.mjs";

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const compactText = (value, fallback = "") => typeof value === "string" ? value.slice(0, 180) : fallback;

function keychain(account, service) {
  return execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function managedPositionBySymbol(snapshot) {
  return new Map((snapshot?.managedPositions ?? []).map((row) => [row.symbol, row]));
}

function protectedSymbols(snapshot) {
  return new Set((snapshot?.executionReconciliation?.protection ?? [])
    .filter((row) => row.status === "PROTECTED")
    .map((row) => row.symbol));
}

export function buildV4MonitorSnapshot(snapshot, autoState = {}, config = strategyConfig, runtimeHealth = {}) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("V4_MONITOR_SNAPSHOT_REQUIRED");
  const sourceAsOf = compactText(snapshot.accountObservedAt ?? snapshot.scannedAt);
  if (!sourceAsOf || !Number.isFinite(Date.parse(sourceAsOf))) throw new Error("V4_MONITOR_SOURCE_TIME_INVALID");
  const managed = managedPositionBySymbol(snapshot);
  const protectedSet = protectedSymbols(snapshot);
  const protection = autoState?.r21ProfitProtection ?? {};
  const campaigns = protection.campaigns ?? {};
  const scanner = runtimeHealth?.scanner ?? {};
  const causalBbo = runtimeHealth?.causalBbo ?? {};
  const causalReferenceAt = compactText(causalBbo?.health?.lastMessageAt)
    || Object.values(causalBbo?.quotes ?? {}).map((row) => compactText(row?.updatedAt)).filter(Boolean).sort().at(-1)
    || null;
  const causalBboAgeMs = causalReferenceAt && Number.isFinite(Date.parse(causalReferenceAt))
    ? Math.max(0, finite(runtimeHealth?.observedAt, Date.now()) - Date.parse(causalReferenceAt))
    : null;
  const engineStatus = compactText(scanner.status, "UNKNOWN");
  const causalBboStatus = causalBboAgeMs !== null && causalBboAgeMs <= 10_000 ? "LIVE" : "STALE";
  const accountReconciliationStatus = compactText(snapshot.executionReconciliation?.status, "UNKNOWN");

  return {
    schemaVersion: 1,
    runtimeId: "ORION-V4-MTFX-R22-MONITOR-1.0",
    sourceAsOf,
    strategyDisplayName: "V4 MTFX · R22",
    implementationRevision: compactText(snapshot.implementationRevision),
    evaluationCohortId: compactText(snapshot.evaluationCohortId),
    baselineUsdt: finite(snapshot.account?.strategyInitialCapitalUsdt, 5_000),
    account: {
      walletBalanceUsdt: finite(snapshot.account?.totalWalletBalanceUsdt),
      marginEquityUsdt: finite(snapshot.account?.totalMarginBalanceUsdt),
      availableBalanceUsdt: finite(snapshot.account?.availableBalanceUsdt),
      unrealizedPnlUsdt: finite(snapshot.account?.totalUnrealizedProfitUsdt),
    },
    risk: {
      maximumRiskPerEntryFraction: finite(snapshot.risk?.maximumRiskPerEntryFraction),
      maximumPortfolioRiskFraction: finite(snapshot.risk?.maximumPortfolioRiskFraction),
      maximumOpenPositionsTotal: finite(snapshot.risk?.maximumOpenPositionsTotal),
      maximumEffectiveNotionalLeverage: finite(snapshot.risk?.maximumEffectiveNotionalLeverage),
      actualEffectiveNotionalLeverage: finite(snapshot.risk?.actualEffectiveNotionalLeverage),
      openPositionCount: finite(snapshot.risk?.openPositionCount),
      protectedPositionCount: finite(snapshot.risk?.protectedPositionCount),
    },
    execution: {
      status: accountReconciliationStatus,
      accountReconciliationStatus,
      engineStatus,
      engineLastError: compactText(scanner.lastError),
      automaticCycleAt: compactText(scanner.lastSuccessfulScanAt),
      causalBboStatus,
      causalBboAgeMs,
      degraded: accountReconciliationStatus !== "RECONCILED" || engineStatus !== "RUNNING" || causalBboStatus !== "LIVE",
      pendingOperationCount: finite(snapshot.executionReconciliation?.pendingOperationCount),
      standardOpenOrderCount: finite(snapshot.executionReconciliation?.standardOpenOrderCount),
      activeAlgoOrderCount: finite(snapshot.executionReconciliation?.activeAlgoOrderCount),
    },
    abnormalLossGate: autoState?.abnormalLossGate ?? snapshot?.abnormalLossGate ?? null,
    system: {
      planCount: finite(snapshot.planCount),
      economicPrequalifiedCount: finite(snapshot.economicPrequalifiedCount),
      confirmedSignalCount: finite(snapshot.confirmedSignalCount),
      broadUniverseSize: finite(snapshot.system?.broadUniverseSize),
      scanIntervalMs: finite(snapshot.system?.scanIntervalMs, 60_000),
    },
    r21ProfitProtection: {
      minimumSameDirectionPositions: finite(config.portfolioProfitProtection?.minimumSameDirectionPositions, 3),
      eligibleSymbols: [...(config.portfolioProfitProtection?.eligibleSymbols ?? [])],
      excludedSymbols: [...(config.portfolioProfitProtection?.excludedSymbols ?? [])],
      freezeEligibleEntries: protection.freezeEligibleEntries === true,
      frozenDirections: [...(protection.frozenDirections ?? [])].slice(0, 2),
      lastEvaluatedAt: finite(protection.lastEvaluatedAt),
      campaigns: {
        LONG: {
          active: campaigns.LONG?.active === true,
          tier: compactText(campaigns.LONG?.tier, "IDLE"),
          highWaterPnlUsdt: finite(campaigns.LONG?.highWaterPnlUsdt),
          freezeUntil: campaigns.LONG?.freezeUntil == null ? null : finite(campaigns.LONG.freezeUntil),
        },
        SHORT: {
          active: campaigns.SHORT?.active === true,
          tier: compactText(campaigns.SHORT?.tier, "IDLE"),
          highWaterPnlUsdt: finite(campaigns.SHORT?.highWaterPnlUsdt),
          freezeUntil: campaigns.SHORT?.freezeUntil == null ? null : finite(campaigns.SHORT.freezeUntil),
        },
      },
    },
    positions: (snapshot.positions ?? []).slice(0, 10).map((row) => {
      const local = managed.get(row.symbol) ?? {};
      const plannedMaximumLossUsdt = finite(local.initialPlannedRiskUsdt ?? local.plannedRiskUsdt);
      return {
        symbol: compactText(row.symbol, "—"),
        side: row.side === "SHORT" ? "SHORT" : "LONG",
        entryPrice: finite(row.entryPrice),
        markPrice: finite(row.markPrice),
        unrealizedPnlUsdt: finite(row.unrealizedProfitUsdt),
        leverage: finite(row.leverage),
        stopPrice: finite(local.stopPrice ?? local.stop),
        stage: compactText(local.stage, "OPEN"),
        openedAt: finite(local.openedAt),
        protected: protectedSet.has(row.symbol),
        ...(plannedMaximumLossUsdt > 0 ? { plannedMaximumLossUsdt, redLossThresholdUsdt: plannedMaximumLossUsdt * 2 } : {}),
      };
    }),
    candidates: (snapshot.plans ?? []).filter((row) => row?.plan).slice(0, 10).map((row) => ({
      id: compactText(row.plan.id),
      symbol: compactText(row.symbol, "—"),
      pattern: compactText(row.plan.pattern, "—"),
      intersectionTime: finite(row.plan.intersectionTime),
      intersectionPrice: finite(row.plan.intersectionPrice),
      stabilityScore: Math.min(1, Math.max(0, finite(row.plan.anchorConsensus?.stabilityScore ?? row.plan.anchorQualityScore))),
      support: finite(row.plan.anchorConsensus?.support),
      signalStatus: compactText(row.signal?.status, "NO_SIGNAL"),
      economicPrequalified: row.assessment?.economicPrequalified === true,
      assessmentReason: compactText(row.assessment?.reason, "MTFX_INTERSECTION_PLAN_ACTIVE"),
      signalReason: compactText(row.signal?.reason, "CONFIRMATION_RESERVE_NOT_CLOSED"),
      committed: row.plan?.committed === true,
      anchorQualityScore: Math.min(1, Math.max(0, finite(row.plan?.anchorQualityScore))),
      fourHourHierarchyMultiplier: finite(row.plan?.scale?.fourHourHierarchyMultiplier),
      oneHourHierarchyMultiplier: finite(row.plan?.scale?.oneHourHierarchyMultiplier),
    })),
    settlements: (snapshot.closedPositions ?? []).slice(-12).map((row) => ({
      symbol: compactText(row.symbol, "—"),
      side: Number(row.direction) < 0 || row.side === "SHORT" ? "SHORT" : "LONG",
      closedAt: finite(row.closedAt),
      netPnlUsdt: finite(row.netPnlUsdt ?? row.cumulativeRealizedNetPnl ?? row.netPnl),
      realizedR: Number.isFinite(Number(row.realizedR)) ? Number(row.realizedR) : null,
      reason: compactText(row.closeReason ?? row.reason ?? row.outcome, "已结算"),
    })),
  };
}

export async function publishV4MonitorSnapshot({ snapshot, autoState = {}, runtimeHealth = {}, token, sitesBypassToken, fetchImpl = fetch } = {}) {
  if (monitorConfig.enabled !== true) return { status: "DISABLED", sourceAsOf: null, receivedAt: null, error: null };
  const ingestToken = token ?? keychain(monitorConfig.keychainAccount, monitorConfig.keychainService);
  const bypassToken = sitesBypassToken ?? keychain(monitorConfig.sitesBypassKeychainAccount, monitorConfig.sitesBypassKeychainService);
  if (ingestToken.length < 32 || bypassToken.length < 32) throw new Error("V4_MONITOR_SYNC_TOKEN_MISSING_OR_SHORT");
  const payload = buildV4MonitorSnapshot(snapshot, autoState, strategyConfig, runtimeHealth);
  const response = await fetchImpl(monitorConfig.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "oai-sites-authorization": `Bearer ${bypassToken}`,
      "content-type": "application/json",
      "user-agent": "orion-v4-monitor-sync/1.0",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`V4_MONITOR_SYNC_HTTP_${response.status}`);
  return { status: result.status ?? "SYNCED", sourceAsOf: payload.sourceAsOf, receivedAt: result.receivedAt ?? null, error: null };
}

export async function publishCurrentV4Monitor() {
  const [snapshot, autoState, scanner, causalBbo] = await Promise.all([
    fs.readFile(V4_LATEST_PATH, "utf8").then(JSON.parse),
    fs.readFile(V4_AUTO_STATE_PATH, "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(V4_PID_PATH, "utf8").then(JSON.parse).catch(() => ({})),
    fs.readFile(V4_BBO_LATEST_PATH, "utf8").then(JSON.parse).catch(() => ({})),
  ]);
  return publishV4MonitorSnapshot({ snapshot, autoState, runtimeHealth: { scanner, causalBbo, observedAt: Date.now() } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await publishCurrentV4Monitor();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
