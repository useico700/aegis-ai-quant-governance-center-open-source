import { blockLegacyDirectLaunch } from "../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, writeJsonAtomic } from "../orion-v2/paper/runtime-utils.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SHADOW_KELLY_AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-20-orion-v3-shadow-kelly-automatic-version-sync.json");
export const SHADOW_KELLY_CURRENT_STATE_PATH = path.join(ROOT, "governance", "current-state.json");
export const SHADOW_KELLY_SOURCE_PATH = path.join(ROOT, ".runtime", "orion-v3-binance-demo", "state.json");
export const SHADOW_KELLY_LATEST_PATH = path.join(ROOT, ".runtime", "orion-v3-shadow-kelly", "latest.json");

const STRATEGY_VERSION = "ORION-V3-RESEARCH-MTFX-HF-0.5.0";
const REVISION_PATTERN = /^MTFX-V3-HF\d+(?:-|$)/;
const FORWARD_ONLY_FROM = Date.parse("2026-08-18T18:00:00+08:00");
const MINIMUM_SAMPLE = 100;
const MINIMUM_BUCKET = 20;
const MAXIMUM_REFERENCE_RISK = 0.005;
const ACTUAL_COST_EVIDENCE = "ACTUAL_BINANCE_DEMO_REALIZED_PNL_AND_COMMISSIONS";
const MANAGED_CLOSE_REASONS = new Set([
  "STRATEGY_MANAGED_CLOSE",
  "ELIGIBLE_OPPOSITE_SIGNAL_REPLACEMENT",
  "CONFIRMED_PROTECTIVE_STOP",
]);

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const revisionNumber = (value) => Number(/^MTFX-V3-HF(\d+)/.exec(value)?.[1] ?? -1);

function maximizeEmpiricalLog(realizedRs) {
  if (!realizedRs.length || realizedRs.every((value) => value >= 0)) return realizedRs.length ? 1 : null;
  const worstLoss = Math.min(...realizedRs);
  const upper = Math.min(1, 0.999 / Math.abs(worstLoss));
  const score = (fraction) => realizedRs.reduce((sum, value) => sum + Math.log1p(fraction * value), 0) / realizedRs.length;
  let low = 0;
  let high = upper;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const left = low + (high - low) / 3;
    const right = high - (high - low) / 3;
    if (score(left) < score(right)) low = left;
    else high = right;
  }
  const optimum = (low + high) / 2;
  return score(optimum) > score(0) ? optimum : 0;
}

function exclusionReason(outcome) {
  const closedAt = finite(outcome?.closedAt) ?? Date.parse(outcome?.closedAt ?? "");
  if (!(closedAt >= FORWARD_ONLY_FROM)) return "BEFORE_FORWARD_ONLY_BOUNDARY";
  if (outcome?.strategyVersion !== STRATEGY_VERSION) return "OTHER_STRATEGY_FAMILY";
  if (!REVISION_PATTERN.test(outcome?.implementationRevision ?? "")) return "UNKNOWN_OR_NON_V3_HF_REVISION";
  if (outcome?.completeFinalFill !== true) return "MISSING_FINAL_FILL";
  if (outcome?.exchangeRealizedPnlEvidenceComplete !== true) return "MISSING_ACTUAL_REALIZED_PNL_EVIDENCE";
  if (outcome?.actualCommissionEvidenceComplete !== true) return "MISSING_ACTUAL_COMMISSION_EVIDENCE";
  if (outcome?.costEvidence !== ACTUAL_COST_EVIDENCE) return "MISSING_ACTUAL_COST_EVIDENCE";
  if (!MANAGED_CLOSE_REASONS.has(outcome?.closeReason)) return "EXTERNAL_OR_UNMANAGED_CLOSE";
  if (!Number.isFinite(Number(outcome?.realizedR))) return "MISSING_REALIZED_R";
  return null;
}

function buildRevisionBucket(implementationRevision, outcomes) {
  const exclusions = {};
  const eligible = [];
  for (const outcome of outcomes) {
    const reason = exclusionReason(outcome);
    if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    else eligible.push(outcome);
  }
  const realizedRs = eligible.map((outcome) => Number(outcome.realizedR));
  const wins = realizedRs.filter((value) => value > 0);
  const losses = realizedRs.filter((value) => value < 0);
  const flats = realizedRs.filter((value) => value === 0);
  const pWin = realizedRs.length ? wins.length / realizedRs.length : null;
  const averageWinR = wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : null;
  const averageLossR = losses.length ? Math.abs(losses.reduce((sum, value) => sum + value, 0) / losses.length) : null;
  const payoffRatio = averageWinR !== null && averageLossR > 0 ? averageWinR / averageLossR : null;
  const classicKelly = pWin !== null && payoffRatio > 0 ? pWin - (1 - pWin) / payoffRatio : null;
  const empiricalLogKelly = maximizeEmpiricalLog(realizedRs);
  const enoughTotal = eligible.length >= MINIMUM_SAMPLE;
  const enoughBuckets = wins.length >= MINIMUM_BUCKET && losses.length >= MINIMUM_BUCKET;
  const sampleSufficient = enoughTotal && enoughBuckets;
  const rawQuarterKelly = empiricalLogKelly === null ? null : Math.max(0, empiricalLogKelly * 0.25);
  const referenceRiskFraction = sampleSufficient ? Math.min(MAXIMUM_REFERENCE_RISK, rawQuarterKelly) : null;
  return {
    implementationRevision,
    status: sampleSufficient ? (referenceRiskFraction > 0 ? "READY_OBSERVE_ONLY_REFERENCE" : "NON_POSITIVE_EDGE_ZERO_REFERENCE") : "COLLECTING_INSUFFICIENT_SAMPLE",
    sample: {
      sourceOutcomes: outcomes.length,
      eligible: eligible.length,
      excluded: outcomes.length - eligible.length,
      wins: wins.length,
      losses: losses.length,
      flats: flats.length,
      minimumEligible: MINIMUM_SAMPLE,
      minimumWinsAndLosses: MINIMUM_BUCKET,
      progressFraction: Math.min(1, eligible.length / MINIMUM_SAMPLE),
      sampleSufficient,
      exclusions,
    },
    metrics: {
      winRate: pWin,
      averageWinR,
      averageLossR,
      payoffRatio,
      classicBinaryKelly: classicKelly,
      empiricalLogKelly,
      quarterEmpiricalKelly: rawQuarterKelly,
      maximumReferenceRiskFraction: MAXIMUM_REFERENCE_RISK,
      referenceRiskFraction,
    },
  };
}

export function buildShadowKellyReport(closedPositions = [], { now = Date.now(), currentImplementationRevision = null } = {}) {
  if (!REVISION_PATTERN.test(currentImplementationRevision)) throw new Error("V3_SHADOW_KELLY_CURRENT_REVISION_INVALID");
  const outcomes = Array.isArray(closedPositions) ? closedPositions : [];
  const grouped = new Map([[currentImplementationRevision, []]]);
  const unbucketedExclusions = {};
  for (const outcome of outcomes) {
    const revision = outcome?.implementationRevision;
    if (REVISION_PATTERN.test(revision ?? "")) {
      if (!grouped.has(revision)) grouped.set(revision, []);
      grouped.get(revision).push(outcome);
    } else {
      const reason = exclusionReason(outcome);
      unbucketedExclusions[reason] = (unbucketedExclusions[reason] ?? 0) + 1;
    }
  }
  const revisionBuckets = [...grouped.entries()]
    .sort(([left], [right]) => revisionNumber(left) - revisionNumber(right) || left.localeCompare(right))
    .map(([revision, rows]) => buildRevisionBucket(revision, rows));
  const currentBucket = revisionBuckets.find((bucket) => bucket.implementationRevision === currentImplementationRevision);
  return {
    schemaVersion: 2,
    generatedAt: new Date(now).toISOString(),
    status: currentBucket.status,
    agent: "ORION V3 SHADOW KELLY",
    threadId: "00000000-0000-4000-8000-000000000000",
    venue: "BINANCE_USDM_TESTNET",
    sourceStrategyVersion: STRATEGY_VERSION,
    sourceImplementationRevision: currentImplementationRevision,
    currentImplementationRevision,
    versionSyncMode: "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE",
    forwardOnlyFrom: new Date(FORWARD_ONLY_FROM).toISOString(),
    executionUse: "OBSERVE_ONLY",
    v3OrderSizingInputAllowed: false,
    sample: currentBucket.sample,
    metrics: currentBucket.metrics,
    observedRevisions: revisionBuckets.map((bucket) => bucket.implementationRevision),
    revisionBuckets,
    unbucketedExclusions,
    causality: {
      completeClosedOutcomesOnly: true,
      actualBinanceOutcomeEvidenceRequired: true,
      crossVersionPoolingAllowed: false,
      automaticReadOnlyVersionRecognition: true,
      futureOutcomeFieldsIncluded: true,
      automaticPromotionAllowed: false,
    },
  };
}

export function formatShadowKelly(report) {
  const pct = (value) => value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;
  const r = (value) => value === null || value === undefined ? "—" : `${value.toFixed(3)}R`;
  const shortRevision = (value) => /^MTFX-V3-(HF\d+)/.exec(value)?.[1] ?? value;
  const current = report.revisionBuckets.find((bucket) => bucket.implementationRevision === report.currentImplementationRevision);
  const revisionLines = [...report.revisionBuckets]
    .sort((left, right) => Number(right.implementationRevision === report.currentImplementationRevision) - Number(left.implementationRevision === report.currentImplementationRevision) || revisionNumber(right.implementationRevision) - revisionNumber(left.implementationRevision))
    .map((bucket) => `${shortRevision(bucket.implementationRevision)}${bucket === current ? "（当前）" : ""}：${bucket.sample.eligible}/${bucket.sample.minimumEligible}｜胜 ${bucket.sample.wins} / 负 ${bucket.sample.losses} / 平 ${bucket.sample.flats}｜${bucket.status === "COLLECTING_INSUFFICIENT_SAMPLE" ? "采集中" : bucket.status}`);
  return [
    "V3 影子凯利｜仓位研究",
    `版本同步：自动｜当前 ${report.currentImplementationRevision}`,
    `当前版本状态：${report.status === "COLLECTING_INSUFFICIENT_SAMPLE" ? "采集中（不可执行）" : report.status}`,
    `当前版本样本：${report.sample.eligible}/${report.sample.minimumEligible} 合格完整平仓；胜 ${report.sample.wins} / 负 ${report.sample.losses} / 平 ${report.sample.flats}；排除 ${report.sample.excluded}`,
    `当前版本胜率：${pct(report.metrics.winRate)}｜平均盈利：${r(report.metrics.averageWinR)}｜平均亏损：${r(report.metrics.averageLossR)}｜盈亏比：${report.metrics.payoffRatio?.toFixed(3) ?? "—"}`,
    `当前版本经典凯利：${pct(report.metrics.classicBinaryKelly)}｜经验凯利：${pct(report.metrics.empiricalLogKelly)}｜四分之一凯利：${pct(report.metrics.quarterEmpiricalKelly)}`,
    `当前版本参考风险：${report.metrics.referenceRiskFraction === null ? "样本不足，不生成" : pct(report.metrics.referenceRiskFraction)}（研究上限0.50%，仅观察）`,
    "版本独立样本桶（禁止跨版本合并）：",
    ...revisionLines,
    "边界：只读研究；不修改V3下单、仓位、风险、候选、止损或交易会话。",
  ].join("\n");
}

export async function runShadowKelly({ now = Date.now(), persist = true } = {}) {
  const [authorization, currentState, state] = await Promise.all([
    readJson(SHADOW_KELLY_AUTHORIZATION_PATH),
    readJson(SHADOW_KELLY_CURRENT_STATE_PATH),
    readJson(SHADOW_KELLY_SOURCE_PATH, { closedPositions: [] }),
  ]);
  if (authorization?.status !== "ACTIVE" ||
      authorization?.mode !== "OBSERVE_ONLY_POSITION_SIZING_REFERENCE" ||
      authorization?.versionSyncPolicy?.mode !== "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE" ||
      authorization?.versionSyncPolicy?.crossVersionPoolingAllowed !== false) {
    throw new Error("V3_SHADOW_KELLY_AUTHORIZATION_INVALID");
  }
  const currentImplementationRevision = currentState?.orionV3BinanceUsdmDemo?.implementationRevision;
  const report = buildShadowKellyReport(state?.closedPositions ?? [], { now, currentImplementationRevision });
  if (persist) await writeJsonAtomic(SHADOW_KELLY_LATEST_PATH, report);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runShadowKelly();
  process.stdout.write(`${formatShadowKelly(report)}\n`);
}
