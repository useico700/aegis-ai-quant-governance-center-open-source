import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import runtime from "./config.json" with { type: "json" };
import hfConfig from "../../../experiments/v3-mtf-high-frequency/config.json" with { type: "json" };
import { buildV3CostGateShadowStudy } from "./cost-gate-shadow.mjs";
import { buildV3EquityCurve } from "./equity-curve.mjs";
import { V3_RUNTIME_ROOT } from "./snapshot.mjs";

const latestPath = `${V3_RUNTIME_ROOT}/latest.json`;
const auditPath = `${V3_RUNTIME_ROOT}/audit.ndjson`;

function keychain(account, service) {
  return execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function auditEvents() {
  const body = await fs.readFile(auditPath, "utf8").catch(() => "");
  return body.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export async function publishV3EquitySnapshot({ snapshot, events = [], token, sitesBypassToken, fetchImpl = fetch } = {}) {
  const config = runtime.onlineEquity;
  const ingestToken = token ?? keychain(config.keychainAccount, config.keychainService);
  const bypassToken = sitesBypassToken ?? keychain(config.sitesBypassKeychainAccount, config.sitesBypassKeychainService);
  if (ingestToken.length < 32 || bypassToken.length < 32) throw new Error("V3_EQUITY_SYNC_TOKEN_MISSING_OR_SHORT");
  const source = buildV3EquityCurve(snapshot, events);
  const costGateShadow = buildV3CostGateShadowStudy(snapshot, hfConfig.shadowEvaluation);
  const payload = {
    schemaVersion: 1,
    runtimeId: source.runtimeId,
    sourceAsOf: source.sourceAsOf,
    accountObservedAt: source.accountObservedAt,
    strategyDisplayName: source.strategyDisplayName,
    implementationRevision: source.implementationRevision,
    evaluationCohortId: source.evaluationCohortId,
    baselineUsdt: source.baselineUsdt,
    current: {
      walletBalanceUsdt: source.current.walletBalanceUsdt,
      walletChangeUsdt: source.current.walletChangeUsdt,
      unrealizedPnlUsdt: source.current.unrealizedPnlUsdt,
      marginEquityUsdt: source.current.marginEquityUsdt,
      realizedLearningEquityUsdt: source.current.realizedLearningEquityUsdt,
    },
    metrics: {
      closedTradeCount: source.metrics.closedTradeCount,
      partialSettlementCount: source.metrics.partialSettlementCount,
      totalRealizedNetPnlUsdt: source.metrics.totalRealizedNetPnlUsdt,
      maximumDrawdownUsdt: source.metrics.maximumDrawdownUsdt,
      settlementEvidence: {
        status: source.metrics.settlementEvidence.status,
        reasons: source.metrics.settlementEvidence.reasons,
        unlocatedSettlementCount: source.metrics.settlementEvidence.unlocatedSettlementCount,
        unlocatedPartialCount: source.metrics.settlementEvidence.unlocatedPartialCount,
        unlocatedNetPnlUsdt: source.metrics.settlementEvidence.unlocatedNetPnlUsdt,
        accountingResidualUsdt: source.metrics.settlementEvidence.accountingResidualUsdt,
        drawdownEligible: source.metrics.settlementEvidence.drawdownEligible,
      },
    },
    risk: source.risk,
    accountingBridge: source.accountingBridge,
    executionHealth: source.executionHealth,
    abnormalLossGate: source.abnormalLossGate,
    currentPositions: source.currentPositions,
    candidatePlans: source.candidatePlans,
    cohorts: source.cohorts.map((row) => ({
      evaluationCohortId: row?.evaluationCohortId ?? null,
      classification: row?.classification ?? null,
      openPositionCount: Number(row?.openPositionCount ?? 0),
      closedTradeCount: Number(row?.closedTradeCount ?? 0),
      realizedNetPnlUsdt: Number(row?.realizedNetPnlUsdt ?? 0),
      totalCommissionUsdt: Number(row?.totalCommissionUsdt ?? 0),
    })),
    shadowStudies: {
      costGate: costGateShadow,
    },
    curve: { points: source.curve.points.map(({ id, timestamp, kind, symbol, deltaUsdt, realizedLearningEquityUsdt }) => ({ id, timestamp, kind, symbol, deltaUsdt, realizedLearningEquityUsdt })) },
  };
  const response = await fetchImpl(config.url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "oai-sites-authorization": `Bearer ${bypassToken}`,
      "content-type": "application/json",
      "user-agent": "orion-v3-equity-sync/1.0",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`V3_EQUITY_SYNC_HTTP_${response.status}`);
  return { status: result.status ?? "SYNCED", sourceAsOf: payload.sourceAsOf, receivedAt: result.receivedAt ?? null, error: null };
}

export async function publishCurrentV3Equity({ snapshot } = {}) {
  const current = snapshot ?? JSON.parse(await fs.readFile(latestPath, "utf8"));
  return publishV3EquitySnapshot({ snapshot: current, events: await auditEvents() });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await publishCurrentV3Equity();
  console.log(JSON.stringify(result));
}
