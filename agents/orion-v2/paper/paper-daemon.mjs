import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import { IQ1_REVISION, IQ1_AUTHORIZATION, iq1Digest, validateIq1Profile, consecutiveIq1Trades, freezeIq1Context, iq1Anchor,
  buildIq1Correlation, evaluateIq1Shape, evaluateIq1Portfolio, compareIq1Candidates } from "./iq1-entry-quality.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLedger } from "./audit-ledger.mjs";
import {
  applyPositionResult,
  createPaperPosition,
  defaultBook,
  findConvergencePlan,
  intersectionBufferStop,
  isPlanCommitted,
  normalizeKlines,
  netLiquidationR,
  protectiveStructureAtCutoff,
  reconcileDailyRealizedLossPolicy,
  signalForPlan,
  summarizeTrendCapture,
  updateHourlyStructureTrail,
  updatePaperPosition,
} from "./paper-engine.mjs";
import {
  appendLine,
  deterministicId,
  readJson,
  sleep,
  stableStringify,
  writeJsonAtomic,
} from "./runtime-utils.mjs";
import { tier1EventWindowAt, validateTier1EventCalendar } from "./event-risk.mjs";
import {
  initialR21State,
  isR21EligibleSymbol,
  r21AtrTrail,
} from "../../shared/r21-profit-protection.mjs";
import { evaluateV2R21ProfitProtection, V2_R21_INTEGRITY_REVISION as V2_R21_REPAIR_REVISION } from "./r21-integrity.mjs";
import { expandPaperPositionStateRecords } from "./position-state-records.mjs";
import {
  bindV2ExecutionRelease,
  confirmV2ExecutionRelease,
  EXECUTION_RELEASE_POSITION_FIELDS,
  validateV2ExecutionReleaseAuthority,
  v2PortfolioProtectionSnapshot,
} from "./execution-release.mjs";

export { V2_R21_REPAIR_REVISION };

import {
  evaluateAbnormalLossGate,
  validateAbnormalLossGateAuthorization,
} from "../../shared/abnormal-loss-gate.mjs";

const PAPER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(PAPER_ROOT, "../../..");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx");
const PATHS = {
  runtimeConfig: path.join(PAPER_ROOT, "config.json"),
  strategyConfig: path.join(PROJECT_ROOT, "experiments/v2-mtf-trendline-intersection/config.json"),
  governance: path.join(PROJECT_ROOT, "governance/current-state.json"),
  authorization: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-06-mtfx-price-time-structure-0.5.0.json"),
  lossGatesRemovedDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-07-mtfx-loss-gates-removed.json"),
  priorPaperRiskDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-18-mtfx-paper-position-capacity-10.json"),
  paperRiskDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-09-11-v2-risk-2pct-10pct.json"),
  baselineImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-06-mtfx-hierarchical-parent-r1.json"),
  lineageImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-06-mtfx-continuation-lineage-r2.json"),
  priorImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-06-mtfx-balanced-lead-window-r3.json"),
  oneSidedImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-07-mtfx-one-sided-expansion-r4.json"),
  structureHygieneDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-07-mtfx-structure-hygiene-h1.json"),
  postCrossImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-07-mtfx-post-cross-confirmation-r5.json"),
  multiAnchorImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-07-mtfx-multi-anchor-consensus-r6.json"),
  r7ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-08-mtfx-deferred-protective-structure-r7.json"),
  r8ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-10-mtfx-relaxed-price-confirmation-r8.json"),
  r9ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-11-mtfx-one-hour-protective-stop-r9.json"),
  r10ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-13-mtfx-cross-close-buffer-r10.json"),
  r11ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-13-mtfx-intersection-buffer-stop-r11.json"),
  r12ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-13-mtfx-two-bar-cross-buffer-r12.json"),
  r13ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-15-mtfx-tier1-event-entry-freeze-r13.json"),
  r14ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-17-mtfx-single-symbol-exposure-r14.json"),
  r15ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-17-mtfx-current-structure-replacement-r15.json"),
  r16ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-18-mtfx-current-structure-capacity-r16.json"),
  r17ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-18-mtfx-soft-profit-lock-r17.json"),
  r18ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-19-mtfx-entry-quality-guards-r18.json"),
  r19ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-21-mtfx-r19-confirmed-close-entry-and-monitor-recovery.json"),
  r20ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-22-mtfx-r20-cost-efficiency-gate.json"),
  r21ImplementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-22-mtfx-r21-alt-profit-retention.json"),
  implementationDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-28-mtfx-r22-balanced-profit-realization.json"),
  r21IntegrityAuthorization: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-09-13-v2-r21-integrity-repair.json"),
  executionReleaseDirective: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-09-14-v2-r22-1-entry-protection-consistency.json"),
  abnormalLossGateAuthorization: path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-08-25-v2-v3-v4-abnormal-single-loss-circuit-breaker.json"),
  tier1EventCalendar: path.join(PROJECT_ROOT, "agents/nexus/data/mtfx-tier1-event-calendar.json"),
  state: path.join(RUNTIME_ROOT, "state.json"),
  latest: path.join(RUNTIME_ROOT, "latest.json"),
  ledger: path.join(RUNTIME_ROOT, "ledger.ndjson"),
  killSwitch: path.join(RUNTIME_ROOT, "kill-switch.json"),
  pid: path.join(RUNTIME_ROOT, "daemon.pid.json"),
  bboEvidence: path.join(RUNTIME_ROOT, "market/bbo.ndjson"),
  tradeEvidence: path.join(RUNTIME_ROOT, "market/trades.ndjson"),
  positionBroadcasts: path.join(RUNTIME_ROOT, "broadcast/positions.ndjson"),
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateV2ExecutionDomain(governance) {
  const v2 = governance?.executionDomains?.orionV2Paper;
  invariant(v2?.exchangeCredentialsAllowed === false, "V2_EXCHANGE_CREDENTIAL_BOUNDARY_INVALID");
  invariant(v2?.signedRequestsAllowed === false, "V2_SIGNED_REQUEST_BOUNDARY_INVALID");
  invariant(v2?.apiKeysAllowed === false, "V2_API_KEY_BOUNDARY_INVALID");
  invariant(v2?.orderEndpointsAllowed === false, "V2_ORDER_ENDPOINT_BOUNDARY_INVALID");
  invariant(v2?.testnetOrdersAllowed === false, "V2_TESTNET_ORDER_BOUNDARY_INVALID");
  invariant(v2?.realOrdersAllowed === false, "V2_REAL_ORDER_BOUNDARY_INVALID");

  // Aggregate credentials belong to independently authorized execution domains
  // (including S1). They neither grant V2 access nor veto its paper recovery.
  // All V2 credential and order permissions above remain strictly false.
  return v2;
}

export function totalOpenPositionCount(books) {
  return Object.values(books).reduce((total, book) => total + book.openPositions.length, 0);
}

// A replacement is deliberately narrower than a price reversal: the new
// plan must be a newer, current 4H structure and its 15M direction must have
// completed after the old position was opened.  This prevents a delayed plan
// or a noisy later candle from liquidating a valid position.
export function currentStructureReplacementEligibility({ plan, gate, existingPosition }) {
  const confirmedAt = Number(gate?.lockedPriceConfirmation?.confirmedAt);
  const proposedDirection = Number(gate?.lockedPriceConfirmation?.direction);
  const reasons = [];
  if (plan?.fourHourLineStatus !== "ACTIVE_4H_TREND") reasons.push("REPLACEMENT_REQUIRES_ACTIVE_4H_LINEAGE");
  if (!(Number(plan?.intersectionTime) > Number(existingPosition?.intersectionTime))) reasons.push("REPLACEMENT_INTERSECTION_NOT_NEWER_THAN_EXISTING");
  if (!(confirmedAt > Number(existingPosition?.openedAt))) reasons.push("REPLACEMENT_CONFIRMATION_NOT_NEWER_THAN_EXISTING_OPEN");
  if (proposedDirection !== -Number(existingPosition?.direction)) reasons.push("REPLACEMENT_DIRECTION_NOT_OPPOSITE");
  return {
    accepted: reasons.length === 0,
    reason: reasons[0] ?? null,
    reasons,
    proposedDirection,
    directionConfirmedAt: Number.isFinite(confirmedAt) ? confirmedAt : null,
  };
}

// Equity performance is deliberately calculated from the complete closed
// position ledger, not the monitor's truncated recent-history feed.  It is
// presentation-only and never participates in signal, sizing, or risk logic.
export function summarizeClosedBookPerformance(closedPositions = []) {
  const closed = Array.isArray(closedPositions) ? closedPositions : [];
  const wins = closed.filter((position) => Number(position?.netPnl) > 0);
  const losses = closed.filter((position) => Number(position?.netPnl) < 0);
  const breakeven = closed.length - wins.length - losses.length;
  const grossProfitUsdt = wins.reduce((total, position) => total + Number(position.netPnl), 0);
  const grossLossUsdt = Math.abs(losses.reduce((total, position) => total + Number(position.netPnl), 0));
  return {
    closedPositions: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    grossProfitUsdt,
    grossLossUsdt,
    winRatePct: closed.length > 0 ? wins.length / closed.length * 100 : null,
    profitFactor: grossLossUsdt > 0 ? grossProfitUsdt / grossLossUsdt : null,
  };
}

export function hasPostConnectQuoteCoverage(websocket, quote) {
  const connectedAt = Number(websocket?.connectedAt);
  const receivedAt = Number(quote?.receivedAt);
  return websocket?.connected === true && Number.isFinite(connectedAt) && Number.isFinite(receivedAt) && receivedAt >= connectedAt;
}

export function websocketNeedsSelfHeal(websocket, now = Date.now(), staleAfterMs = 30_000) {
  const lastEventAt = Number(websocket?.lastEventAt);
  return websocket?.connected === true
    && Number.isFinite(lastEventAt)
    && now - lastEventAt > staleAfterMs;
}

export function validateEntryBboTiming({
  quote,
  stopReadyAt,
  deadline,
  decisionMarketTime,
  decisionLocalTime,
  maximumAgeMs = 15000,
}) {
  if (quote?.coverageComplete !== true) return { accepted: false, reason: "BBO_COVERAGE_INCOMPLETE" };
  const marketTime = Number(quote.marketTime);
  const receivedAt = Number(quote.receivedAt);
  if (![marketTime, receivedAt, stopReadyAt, deadline, decisionMarketTime, decisionLocalTime].every(Number.isFinite)) {
    return { accepted: false, reason: "BBO_TEMPORAL_EVIDENCE_INCOMPLETE" };
  }
  if (marketTime < stopReadyAt) return { accepted: false, reason: "BBO_MARKET_TIME_BEFORE_STRUCTURE_READY" };
  if (marketTime > deadline) return { accepted: false, reason: "BBO_MARKET_TIME_AFTER_ENTRY_DEADLINE" };
  if (marketTime > decisionMarketTime) return { accepted: false, reason: "BBO_MARKET_TIME_AFTER_DECISION_CLOCK" };
  if (receivedAt > decisionLocalTime) return { accepted: false, reason: "BBO_RECEIVED_AFTER_DECISION_CLOCK" };
  if (decisionMarketTime - marketTime > maximumAgeMs || decisionLocalTime - receivedAt > maximumAgeMs) {
    return { accepted: false, reason: "BBO_STALE_AT_DECISION" };
  }
  return { accepted: true, reason: "BBO_CAUSALLY_FRESH" };
}

export function evaluateV2EntrySignalFreshness({ gate, signalPolicy, now }) {
  const decisionBarCloseTime = Number(gate?.lockedPriceConfirmation?.confirmedAt);
  const maximumSignalAgeMs = Number(signalPolicy?.maximumEntrySignalAgeMs);
  invariant(decisionBarCloseTime > 0 && maximumSignalAgeMs > 0, "V2_ENTRY_SIGNAL_GUARD_CONFIGURATION_INVALID");
  const signalExpiresAt = decisionBarCloseTime + maximumSignalAgeMs;
  if (now < decisionBarCloseTime) {
    return { allowed: false, terminal: false, reason: "ENTRY_DECISION_BAR_NOT_CLOSED", decisionBarCloseTime, signalExpiresAt };
  }
  if (now > signalExpiresAt) {
    return {
      allowed: false,
      terminal: true,
      reason: "ENTRY_SIGNAL_EXPIRED_BEFORE_SIMULATED_SUBMISSION",
      decisionBarCloseTime,
      signalExpiresAt,
      signalAgeMs: now - decisionBarCloseTime,
      maximumSignalAgeMs,
    };
  }
  return {
    allowed: true,
    terminal: false,
    reason: "ENTRY_SIGNAL_FRESH",
    decisionBarCloseTime,
    signalExpiresAt,
    signalAgeMs: now - decisionBarCloseTime,
    maximumSignalAgeMs,
  };
}

export function evaluateV2EntryQualityGuard({ plan, gate, quote, signalPolicy, now }) {
  const freshness = evaluateV2EntrySignalFreshness({ gate, signalPolicy, now });
  if (!freshness.allowed) return freshness;
  const direction = Number(gate?.lockedPriceConfirmation?.direction);
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const intersectionPrice = Number(plan?.intersectionPrice);
  const referencePrice = Number(gate?.lockedPriceConfirmation?.composite?.close);
  const maximumDisplacementBps = Number(signalPolicy?.maximumEntryDisplacementBps);
  invariant([1, -1].includes(direction) && bid > 0 && ask >= bid && intersectionPrice > 0 && referencePrice > 0 && maximumDisplacementBps > 0, "R19_ENTRY_DISPLACEMENT_GUARD_CONFIGURATION_INVALID");
  const executablePrice = direction === 1 ? ask : bid;
  const displacementBps = Math.abs(executablePrice - referencePrice) / referencePrice * 10_000;
  if (displacementBps > maximumDisplacementBps) {
    return {
      ...freshness,
      allowed: false,
      terminal: false,
      reason: "ENTRY_PRICE_OUTSIDE_MAXIMUM_DISPLACEMENT_WAITING_FOR_REENTRY",
      executablePrice,
      intersectionPrice,
      referencePrice,
      referenceType: "CONFIRMED_15M_DECISION_CLOSE",
      displacementBps,
      maximumDisplacementBps,
    };
  }
  return {
    ...freshness,
    allowed: true,
    terminal: false,
    reason: "R19_ENTRY_QUALITY_GUARDS_PASSED",
    executablePrice,
    intersectionPrice,
    referencePrice,
    referenceType: "CONFIRMED_15M_DECISION_CLOSE",
    displacementBps,
    maximumDisplacementBps,
  };
}

function confirmationReserveDeadline(plan, strategy, runtime) {
  const reserveBars = Number(strategy?.signal?.maximumReserveBars ?? 4);
  return plan.lockedBarOpenTime + reserveBars * 900000 + runtime.marketData.signalFreshnessMs;
}

const DEFERRED_PROTECTIVE_STRUCTURE_REASONS = new Set([
  "TWO_NEAREST_CONFIRMED_STRUCTURE_POINTS_REQUIRED",
  "INTERVENING_OPPOSITE_STRUCTURE_REQUIRED",
  "LONG_REQUIRES_NEAREST_HIGHER_LOW",
  "SHORT_REQUIRES_NEAREST_LOWER_HIGH",
  "PROTECTIVE_STRUCTURE_PROMINENCE_REQUIRED",
  "PROTECTIVE_STRUCTURE_PROGRESSION_TOO_SMALL",
]);

export function isDeferredProtectiveStructureReason(reason) {
  return DEFERRED_PROTECTIVE_STRUCTURE_REASONS.has(reason);
}

function lockPriceConfirmation(signal, plan) {
  return {
    direction: signal.direction,
    confirmedAt: signal.bar.closeTime,
    signalBarOpenTime: signal.bar.openTime,
    signalBarCloseTime: signal.bar.closeTime,
    reserveBarNumber: Math.round((signal.bar.openTime - plan.lockedBarOpenTime) / 900000) + 1,
    patternLength: signal.patternLength,
    patternBars: signal.patternBars,
    composite: signal.composite,
    bodyToRange: signal.bodyToRange,
    closeLocation: signal.closeLocation,
  };
}

function signalFromLockedConfirmation(locked) {
  const patternBars = locked.patternBars;
  return {
    accepted: true,
    terminal: true,
    reason: "POST_CROSS_PRICE_PATTERN_ACCEPTED",
    direction: locked.direction,
    bar: patternBars.at(-1),
    patternBars,
    patternLength: locked.patternLength,
    composite: locked.composite,
    bodyToRange: locked.bodyToRange,
    closeLocation: locked.closeLocation,
  };
}

function consumeIntersection(book, intersectionId) {
  if (book.consumedIntersectionIds.includes(intersectionId)) return;
  book.consumedIntersectionIds = [...book.consumedIntersectionIds, intersectionId].slice(-2000);
}

const IMMUTABLE_OPEN_POSITION_FIELDS = [
  "entryQualityRevision", "entryQualityEvidence",
  "id",
  "book",
  "strategyVersion",
  "implementationRevision",
  ...EXECUTION_RELEASE_POSITION_FIELDS,
  "symbol",
  "direction",
  "openedAt",
  "signalBarOpenTime",
  "signalBarCloseTime",
  "confirmationPattern",
  "intersectionId",
  "intersectionTime",
  "intersectionPrice",
  "entry",
  "originalQuantity",
  "initialStop",
  "protectiveStructure",
  "softLockPrice",
  "oneRPrice",
  "twoRPrice",
  "initialRiskPerUnit",
  "initialPlannedRiskUsdt",
  "entryFee",
  "entryBbo",
  "entryQualityGuard",
];

function positionInBook(book, positionId) {
  return [...book.openPositions, ...book.closedPositions].find((position) => position.id === positionId) ?? null;
}

function assertImmutableOpenPositionMatches(existing, canonical) {
  for (const field of IMMUTABLE_OPEN_POSITION_FIELDS) {
    invariant(
      stableStringify(existing?.[field]) === stableStringify(canonical?.[field]),
      `PAPER_POSITION_IMMUTABLE_DRIFT_${canonical?.id ?? "UNKNOWN"}_${field}`,
    );
  }
}

function canonicalBookAccounting(book) {
  return {
    initialEquityUsdt: book.initialEquityUsdt,
    equityUsdt: book.equityUsdt,
    peakEquityUsdt: book.peakEquityUsdt,
    realizedPnlUsdt: book.realizedPnlUsdt,
    day: book.day,
    dayStartEquityUsdt: book.dayStartEquityUsdt,
    dayRealizedPnlUsdt: book.dayRealizedPnlUsdt,
    newEntriesBlocked: book.newEntriesBlocked,
    blockReason: book.blockReason,
  };
}

function applyCanonicalPositionTransition(book, payload) {
  invariant(payload?.position?.id, "PAPER_POSITION_STATE_COMMIT_POSITION_REQUIRED");
  invariant(payload?.variant === book.variant, "PAPER_POSITION_STATE_COMMIT_BOOK_MISMATCH");
  invariant(payload.position.book === book.variant, "PAPER_POSITION_STATE_COMMIT_POSITION_BOOK_MISMATCH");
  invariant(payload?.bookAccounting && typeof payload.bookAccounting === "object", "PAPER_POSITION_STATE_COMMIT_ACCOUNTING_REQUIRED");
  const position = payload.position;
  const next = {
    ...book,
    ...payload.bookAccounting,
    openPositions: book.openPositions.filter((candidate) => candidate.id !== position.id),
    closedPositions: book.closedPositions.filter((candidate) => candidate.id !== position.id),
  };
  if (position.status === "OPEN") next.openPositions = [...next.openPositions, position];
  else if (position.status === "CLOSED") next.closedPositions = [...next.closedPositions, position].slice(-500);
  else throw new Error(`PAPER_POSITION_STATE_COMMIT_STATUS_INVALID_${position.status}`);
  return next;
}

const POSITION_EVIDENCE_PRIORITY = { BBO_CAPTURED: 0, CAPTURE_INCOMPLETE: 1, RECOVERY_GAP: 2 };

export function applyFailClosedPositionEvidence(position, requestedEvidence) {
  const currentEvidence = position.executionEvidence ?? "BBO_CAPTURED";
  const nextEvidence = Number(POSITION_EVIDENCE_PRIORITY[requestedEvidence] ?? 0) >
    Number(POSITION_EVIDENCE_PRIORITY[currentEvidence] ?? 0)
    ? requestedEvidence
    : currentEvidence;
  if (position.bboCoverageComplete === false && nextEvidence === currentEvidence) return position;
  return { ...position, bboCoverageComplete: false, executionEvidence: nextEvidence };
}

export async function loadAndValidateAuthority() {
  const [runtime, strategy, governance, authorization, lossGatesRemovedDirective, priorPaperRiskDirective, paperRiskDirective, baselineImplementationDirective, lineageImplementationDirective, priorImplementationDirective, oneSidedImplementationDirective, structureHygieneDirective, postCrossImplementationDirective, multiAnchorImplementationDirective, r7ImplementationDirective, r8ImplementationDirective, r9ImplementationDirective, r10ImplementationDirective, r11ImplementationDirective, r12ImplementationDirective, r13ImplementationDirective, r14ImplementationDirective, r15ImplementationDirective, r16ImplementationDirective, r17ImplementationDirective, r18ImplementationDirective, r19ImplementationDirective, r20ImplementationDirective, r21ImplementationDirective, implementationDirective, tier1EventCalendar, abnormalLossGateAuthorization] = await Promise.all([
    readJson(PATHS.runtimeConfig),
    readJson(PATHS.strategyConfig),
    readJson(PATHS.governance),
    readJson(PATHS.authorization),
    readJson(PATHS.lossGatesRemovedDirective),
    readJson(PATHS.priorPaperRiskDirective),
    readJson(PATHS.paperRiskDirective),
    readJson(PATHS.baselineImplementationDirective),
    readJson(PATHS.lineageImplementationDirective),
    readJson(PATHS.priorImplementationDirective),
    readJson(PATHS.oneSidedImplementationDirective),
    readJson(PATHS.structureHygieneDirective),
    readJson(PATHS.postCrossImplementationDirective),
    readJson(PATHS.multiAnchorImplementationDirective),
    readJson(PATHS.r7ImplementationDirective),
    readJson(PATHS.r8ImplementationDirective),
    readJson(PATHS.r9ImplementationDirective),
    readJson(PATHS.r10ImplementationDirective),
    readJson(PATHS.r11ImplementationDirective),
    readJson(PATHS.r12ImplementationDirective),
    readJson(PATHS.r13ImplementationDirective),
    readJson(PATHS.r14ImplementationDirective),
    readJson(PATHS.r15ImplementationDirective),
    readJson(PATHS.r16ImplementationDirective),
    readJson(PATHS.r17ImplementationDirective),
    readJson(PATHS.r18ImplementationDirective),
    readJson(PATHS.r19ImplementationDirective),
    readJson(PATHS.r20ImplementationDirective),
    readJson(PATHS.r21ImplementationDirective),
    readJson(PATHS.implementationDirective),
    readJson(PATHS.tier1EventCalendar),
    readJson(PATHS.abnormalLossGateAuthorization),
  ]);
  invariant(runtime?.schemaVersion === 1, "RUNTIME_CONFIG_INVALID");
  invariant(runtime.strategyVersion === strategy?.candidateVersion, "STRATEGY_VERSION_MISMATCH");
  invariant(runtime.implementationRevision === strategy?.implementationRevision, "IMPLEMENTATION_REVISION_MISMATCH");
  invariant(runtime.implementationDirectiveId === implementationDirective?.id, "IMPLEMENTATION_DIRECTIVE_ID_MISMATCH");
  invariant(strategy?.implementationDirectiveId === implementationDirective?.id, "STRATEGY_IMPLEMENTATION_DIRECTIVE_MISMATCH");
  invariant(governance?.activeResearchCandidate?.implementationRevision === runtime.implementationRevision, "GOVERNANCE_IMPLEMENTATION_REVISION_MISMATCH");
  invariant(governance?.activeResearchCandidate?.implementationDirectiveId === implementationDirective?.id, "GOVERNANCE_IMPLEMENTATION_DIRECTIVE_MISMATCH");
  invariant(implementationDirective?.status === "ACTIVE", "IMPLEMENTATION_DIRECTIVE_NOT_ACTIVE");
  invariant(implementationDirective?.amends === r21ImplementationDirective?.id, "IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(r7ImplementationDirective?.amends === multiAnchorImplementationDirective?.id, "R7_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(multiAnchorImplementationDirective?.amends === postCrossImplementationDirective?.id, "MULTI_ANCHOR_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(postCrossImplementationDirective?.amends === structureHygieneDirective?.id, "POST_CROSS_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(structureHygieneDirective?.amends === oneSidedImplementationDirective?.id, "STRUCTURE_HYGIENE_AUTHORIZATION_CHAIN_INVALID");
  invariant(oneSidedImplementationDirective?.amends === priorImplementationDirective?.id, "ONE_SIDED_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(priorImplementationDirective?.amends === lineageImplementationDirective?.id, "PRIOR_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(lineageImplementationDirective?.amends === baselineImplementationDirective?.id, "LINEAGE_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(baselineImplementationDirective?.amends === authorization?.id, "BASELINE_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
  invariant(oneSidedImplementationDirective?.supersededBy === postCrossImplementationDirective?.id, "ONE_SIDED_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(structureHygieneDirective?.supersededBy === postCrossImplementationDirective?.id, "STRUCTURE_HYGIENE_REPLACEMENT_CHAIN_INVALID");
  invariant(structureHygieneDirective?.status === "INCORPORATED_IN_R5", "STRUCTURE_HYGIENE_NOT_INCORPORATED");
  invariant(postCrossImplementationDirective?.status === "SUPERSEDED" && postCrossImplementationDirective?.supersededBy === multiAnchorImplementationDirective?.id, "POST_CROSS_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(multiAnchorImplementationDirective?.status === "SUPERSEDED" && multiAnchorImplementationDirective?.supersededBy === r7ImplementationDirective?.id, "MULTI_ANCHOR_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r7ImplementationDirective?.status === "SUPERSEDED" && r7ImplementationDirective?.supersededBy === r8ImplementationDirective?.id, "R7_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r8ImplementationDirective?.status === "SUPERSEDED" && r8ImplementationDirective?.supersededBy === r9ImplementationDirective?.id, "R8_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r9ImplementationDirective?.status === "SUPERSEDED" && r9ImplementationDirective?.supersededBy === r10ImplementationDirective?.id, "R9_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r10ImplementationDirective?.status === "SUPERSEDED_BEFORE_RUNTIME_CUTOVER" && r10ImplementationDirective?.supersededBy === r11ImplementationDirective?.id, "R10_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r11ImplementationDirective?.status === "SUPERSEDED" && r11ImplementationDirective?.supersededBy === r12ImplementationDirective?.id, "R11_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r12ImplementationDirective?.status === "SUPERSEDED" && r12ImplementationDirective?.supersededBy === r13ImplementationDirective?.id, "R12_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r13ImplementationDirective?.status === "SUPERSEDED" && r13ImplementationDirective?.supersededBy === r14ImplementationDirective?.id, "R13_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r14ImplementationDirective?.status === "SUPERSEDED" && r14ImplementationDirective?.supersededBy === r15ImplementationDirective?.id, "R14_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r15ImplementationDirective?.status === "SUPERSEDED" && r15ImplementationDirective?.supersededBy === r16ImplementationDirective?.id, "R15_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r16ImplementationDirective?.status === "SUPERSEDED" && r16ImplementationDirective?.supersededBy === r17ImplementationDirective?.id, "R16_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r17ImplementationDirective?.status === "SUPERSEDED" && r17ImplementationDirective?.supersededBy === r18ImplementationDirective?.id, "R17_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r18ImplementationDirective?.status === "SUPERSEDED" && r18ImplementationDirective?.supersededBy === r19ImplementationDirective?.id, "R18_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r19ImplementationDirective?.status === "SUPERSEDED" && r19ImplementationDirective?.supersededBy === r20ImplementationDirective?.id, "R19_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r20ImplementationDirective?.status === "SUPERSEDED" && r20ImplementationDirective?.supersededBy === r21ImplementationDirective?.id, "R20_IMPLEMENTATION_REPLACEMENT_CHAIN_INVALID");
  invariant(r21ImplementationDirective?.status === "ACTIVE" && r21ImplementationDirective?.forwardV2SupersededBy === implementationDirective?.id, "R21_FORWARD_V2_REPLACEMENT_CHAIN_INVALID");
  invariant(implementationDirective?.strategyVersion === runtime.strategyVersion, "IMPLEMENTATION_STRATEGY_VERSION_MISMATCH");
  invariant(implementationDirective?.preserves?.realOrders === false, "IMPLEMENTATION_REAL_ORDER_BOUNDARY_INVALID");
  invariant(implementationDirective?.preserves?.maximumRiskPerIntersectionFraction === authorization.paperScope.maximumRiskPerIntersectionFraction, "IMPLEMENTATION_HISTORICAL_RISK_SCOPE_MISMATCH");
  invariant(implementationDirective?.preserves?.maximumPortfolioRiskFraction === authorization.paperScope.maximumPortfolioRiskFraction, "IMPLEMENTATION_HISTORICAL_PORTFOLIO_SCOPE_MISMATCH");
  invariant(implementationDirective?.preserves?.maximumOpenPositions === runtime.paperRisk.maximumOpenPositionsTotal, "IMPLEMENTATION_POSITION_CAPACITY_MISMATCH");
  invariant(implementationDirective?.policy?.singleSymbolExposure === "AT_MOST_ONE_OPEN_POSITION_PER_SYMBOL_ACROSS_ALL_ACTIVE_PAPER_BOOKS", "SINGLE_SYMBOL_EXPOSURE_POLICY_INVALID");
  invariant(runtime?.execution?.singleSymbolExposure === implementationDirective.policy.singleSymbolExposure, "RUNTIME_SINGLE_SYMBOL_EXPOSURE_MISMATCH");
  invariant(strategy?.execution?.singleSymbolExposure === implementationDirective.policy.singleSymbolExposure, "STRATEGY_SINGLE_SYMBOL_EXPOSURE_MISMATCH");
  invariant(runtime?.execution?.automaticSignalReplacement === "OPPOSITE_CURRENT_FULLY_CONFIRMED_ONLY", "RUNTIME_SIGNAL_REPLACEMENT_POLICY_INVALID");
  invariant(strategy?.execution?.automaticSignalReplacement === "OPPOSITE_CURRENT_FULLY_CONFIRMED_ONLY", "STRATEGY_SIGNAL_REPLACEMENT_POLICY_INVALID");
  invariant(runtime?.paperRisk?.exitVariant === "PARTIAL_40_SOFT_LOCK_25_20_RUNNER_15_1H_STRUCTURE", "R22_EXIT_VARIANT_INVALID");
  invariant(strategy?.costAdjustedRisk?.softLockActivationNetR === 0.5, "R22_SOFT_LOCK_TRIGGER_INVALID");
  invariant(strategy?.costAdjustedRisk?.softLockAggregateNetRFloor === 0.15, "R22_SOFT_LOCK_FLOOR_INVALID");
  invariant(strategy?.costAdjustedRisk?.oneNetRAggregateNetRFloor === 0.6, "R22_ONE_R_FLOOR_INVALID");
  invariant(strategy?.exit?.atHalfNetR?.closeFractionOfOriginal === 0.4, "R22_HALF_R_PARTIAL_INVALID");
  invariant(strategy?.exit?.atOneNetR?.closeFractionOfOriginal === 0.25, "R22_ONE_R_PARTIAL_INVALID");
  invariant(strategy?.exit?.atTwoNetR?.closeFractionOfOriginal === 0.2, "R22_TWO_R_PARTIAL_INVALID");
  invariant(strategy?.exit?.runner?.fractionOfOriginal === 0.15, "R22_RUNNER_FRACTION_INVALID");
  invariant(implementationDirective?.policy?.exitManagement?.runner === "REMAINING_15_PERCENT_TRAILS_EXISTING_CONFIRMED_1H_AND_R21_CLOSED_15M_ATR_TIGHTER_ONLY_NO_TIME_EXIT", "R22_RUNNER_POLICY_INVALID");
  const priceConfirmation = r12ImplementationDirective?.authorizedCorrection?.priceConfirmation;
  invariant(strategy?.signal?.entryMode === priceConfirmation?.entryMode, "PRICE_CONFIRMATION_MODE_MISMATCH");
  invariant(strategy?.signal?.crossCloseBufferBps === priceConfirmation?.crossCloseBufferBps, "CROSS_CLOSE_BUFFER_MISMATCH");
  invariant(strategy?.signal?.allowedPatternLengths?.length === 1 && strategy?.signal?.allowedPatternLengths?.[0] === 1, "CROSS_BAR_SINGLE_BAR_POLICY_MISMATCH");
  invariant(strategy?.signal?.maximumDirectionDecisionBars === priceConfirmation?.maximumDirectionDecisionBars, "CROSS_DECISION_WINDOW_MISMATCH");
  const entryQuality = r20ImplementationDirective?.policy?.entryQuality;
  invariant(entryQuality?.maximumEntryDisplacementBps === 50, "R19_ENTRY_DISPLACEMENT_POLICY_INVALID");
  invariant(entryQuality?.maximumEntrySignalAgeMs === 180000, "R19_ENTRY_SIGNAL_AGE_POLICY_INVALID");
  invariant(entryQuality?.displacementReference === "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE", "R19_ENTRY_DISPLACEMENT_REFERENCE_INVALID");
  invariant(entryQuality?.revalidation === "REQUIRED_ON_EVERY_SIMULATED_SUBMISSION_ATTEMPT", "R19_ENTRY_REVALIDATION_POLICY_INVALID");
  invariant(strategy?.signal?.maximumEntryDisplacementBps === entryQuality.maximumEntryDisplacementBps, "R19_STRATEGY_ENTRY_DISPLACEMENT_MISMATCH");
  invariant(strategy?.signal?.maximumEntrySignalAgeMs === entryQuality.maximumEntrySignalAgeMs, "R19_STRATEGY_ENTRY_SIGNAL_AGE_MISMATCH");
  invariant(strategy?.signal?.entryDisplacementReference === entryQuality.displacementReference, "R19_STRATEGY_ENTRY_REFERENCE_MISMATCH");
  invariant(runtime?.execution?.maximumEntryDisplacementBps === entryQuality.maximumEntryDisplacementBps, "R19_RUNTIME_ENTRY_DISPLACEMENT_MISMATCH");
  invariant(runtime?.execution?.maximumEntrySignalAgeMs === entryQuality.maximumEntrySignalAgeMs, "R19_RUNTIME_ENTRY_SIGNAL_AGE_MISMATCH");
  invariant(runtime?.execution?.entryDisplacementReference === entryQuality.displacementReference, "R19_RUNTIME_ENTRY_REFERENCE_MISMATCH");
  invariant(governance?.activeResearchCandidate?.entryTiming?.entryQuality?.maximumEntryDisplacementBps === entryQuality.maximumEntryDisplacementBps, "R19_GOVERNANCE_ENTRY_DISPLACEMENT_MISMATCH");
  invariant(governance?.activeResearchCandidate?.entryTiming?.entryQuality?.maximumEntrySignalAgeMs === entryQuality.maximumEntrySignalAgeMs, "R19_GOVERNANCE_ENTRY_SIGNAL_AGE_MISMATCH");
  invariant(governance?.activeResearchCandidate?.entryTiming?.entryQuality?.displacementReference === entryQuality.displacementReference, "R19_GOVERNANCE_ENTRY_REFERENCE_MISMATCH");
  const costEfficiency = r20ImplementationDirective?.policy?.costEfficiency;
  invariant(costEfficiency?.maximumCompleteLifecycleCostR === 0.12, "R20_COST_EFFICIENCY_THRESHOLD_INVALID");
  invariant(costEfficiency?.revalidation === "REQUIRED_BEFORE_POSITION_SIZING_ON_EVERY_SUBMISSION_ATTEMPT", "R20_COST_EFFICIENCY_REVALIDATION_INVALID");
  invariant(costEfficiency?.positionSizingBypassAllowed === false && costEfficiency?.stopWideningBypassAllowed === false, "R20_COST_EFFICIENCY_BYPASS_POLICY_INVALID");
  invariant(runtime?.execution?.maximumCompleteLifecycleCostR === costEfficiency.maximumCompleteLifecycleCostR, "R20_RUNTIME_COST_EFFICIENCY_THRESHOLD_MISMATCH");
  invariant(strategy?.signal?.maximumCompleteLifecycleCostR === costEfficiency.maximumCompleteLifecycleCostR, "R20_STRATEGY_COST_EFFICIENCY_THRESHOLD_MISMATCH");
  invariant(strategy?.costAdjustedRisk?.maximumCompleteLifecycleCostR === costEfficiency.maximumCompleteLifecycleCostR, "R20_STRATEGY_COST_RISK_THRESHOLD_MISMATCH");
  invariant(strategy?.costAdjustedRisk?.gateBeforePositionSizing === true, "R20_COST_GATE_ORDER_INVALID");
  invariant(governance?.activeResearchCandidate?.entryTiming?.costEfficiency?.maximumCompleteLifecycleCostR === costEfficiency.maximumCompleteLifecycleCostR, "R20_GOVERNANCE_COST_EFFICIENCY_THRESHOLD_MISMATCH");
  invariant(r20ImplementationDirective?.policy?.eventRisk?.freezeNewEntries === true, "TIER1_EVENT_FREEZE_NOT_ENABLED");
  invariant(runtime?.eventRisk?.authorizationId === implementationDirective?.id, "RUNTIME_EVENT_RISK_DIRECTIVE_MISMATCH");
  invariant(strategy?.eventRisk?.authorizationId === implementationDirective?.id, "STRATEGY_EVENT_RISK_DIRECTIVE_MISMATCH");
  invariant(governance?.activeResearchCandidate?.eventRisk?.authorizationId === implementationDirective?.id, "GOVERNANCE_EVENT_RISK_DIRECTIVE_MISMATCH");
  invariant(runtime.eventRisk.freezeBeforeMinutes === r20ImplementationDirective.policy.eventRisk.freezeBeforeMinutes && runtime.eventRisk.freezeAfterMinutes === r20ImplementationDirective.policy.eventRisk.freezeAfterMinutes, "EVENT_RISK_WINDOW_MISMATCH");
  invariant(runtime.eventRisk.existingPositions === r20ImplementationDirective.policy.eventRisk.existingPositions, "EVENT_RISK_OPEN_POSITION_SCOPE_MISMATCH");
  validateTier1EventCalendar(tier1EventCalendar);
  invariant(strategy?.stop?.initialStopMode === "INTERSECTION_BUFFER", "INITIAL_STOP_MODE_MISMATCH");
  invariant(strategy?.stop?.intersectionBufferBps === 5, "INITIAL_STOP_BUFFER_MISMATCH");
  invariant(runtime.authorizationId === authorization?.id, "AUTHORIZATION_ID_MISMATCH");
  invariant(runtime.paperRiskDirectiveId === paperRiskDirective?.authorizationId, "PAPER_RISK_DIRECTIVE_ID_MISMATCH");
  invariant(governance?.paperRisk?.authorizationId === paperRiskDirective?.authorizationId, "GOVERNANCE_PAPER_RISK_DIRECTIVE_MISMATCH");
  invariant(["AUTHORIZED_PENDING_RUNTIME_VERIFICATION", "ACTIVE_VERIFIED"].includes(paperRiskDirective?.status), "PAPER_RISK_DIRECTIVE_NOT_AUTHORIZED");
  invariant(paperRiskDirective?.scope === "ORION_V2_PAPER_ONLY", "PAPER_RISK_DIRECTIVE_SCOPE_INVALID");
  invariant(paperRiskDirective?.supersedesOnly?.previousRiskDirectiveId === priorPaperRiskDirective?.id, "PAPER_RISK_DIRECTIVE_CHAIN_INVALID");
  invariant(priorPaperRiskDirective?.status === "ACTIVE" && priorPaperRiskDirective?.amends === lossGatesRemovedDirective?.id, "PRIOR_PAPER_RISK_CHAIN_INVALID");
  invariant(lossGatesRemovedDirective?.status === "SUPERSEDED" && lossGatesRemovedDirective?.supersededBy === priorPaperRiskDirective?.id, "LOSS_GATES_REMOVAL_CHAIN_INVALID");
  invariant(governance?.execution?.paperOrdersAuthorized === true, "PAPER_NOT_AUTHORIZED_BY_GOVERNANCE");
  invariant(governance?.execution?.marketScanningAuthorized === true, "SCANNING_NOT_AUTHORIZED_BY_GOVERNANCE");
  validateV2ExecutionDomain(governance);
  invariant(strategy?.authorization?.paperExecutionAllowed === true, "STRATEGY_PAPER_AUTHORIZATION_MISSING");
  invariant(strategy?.authorization?.realExecutionAllowed === false, "STRATEGY_REAL_ORDER_BOUNDARY_INVALID");
  invariant(strategy?.authorization?.authorizationId === authorization.id, "STRATEGY_AUTHORIZATION_REFERENCE_INVALID");
  invariant(authorization?.authorization?.paperSimulation === true, "OWNER_PAPER_AUTHORIZATION_MISSING");
  invariant(authorization?.authorization?.realOrders === false, "OWNER_REAL_ORDER_BOUNDARY_INVALID");
  invariant(authorization?.authorization?.exchangeCredentials === false, "OWNER_CREDENTIAL_BOUNDARY_INVALID");
  invariant(runtime?.venue?.signedRequestsAllowed === false, "SIGNED_REQUESTS_MUST_BE_FORBIDDEN");
  invariant(runtime?.venue?.apiKeysAllowed === false, "API_KEYS_MUST_BE_FORBIDDEN");
  invariant(runtime?.venue?.orderEndpointsAllowed === false, "ORDER_ENDPOINTS_MUST_BE_FORBIDDEN");
  invariant(runtime?.execution?.realOrdersAllowed === false, "REAL_ORDERS_MUST_BE_FORBIDDEN");
  invariant(runtime?.execution?.testnetOrdersAllowed === false, "TESTNET_ORDERS_MUST_BE_FORBIDDEN");
  invariant(runtime?.execution?.automaticRestartAllowed === true, "AUTOMATIC_PAPER_RECOVERY_NOT_AUTHORIZED");
  invariant(governance?.execution?.automaticRestartAuthorized === true, "GOVERNANCE_PAPER_RECOVERY_NOT_AUTHORIZED");
  invariant(strategy?.authorization?.automaticRestartAllowed === true, "STRATEGY_PAPER_RECOVERY_NOT_AUTHORIZED");
  invariant(authorization?.authorization?.automaticRestart === true, "OWNER_PAPER_RECOVERY_NOT_AUTHORIZED");
  invariant(runtime.venue.universe.selection === authorization.paperScope.universeSelection, "UNIVERSE_SELECTION_SCOPE_MISMATCH");
  invariant(JSON.stringify(runtime.venue.universe.mandatorySymbols) === JSON.stringify(authorization.paperScope.mandatorySymbols), "MANDATORY_SYMBOL_SCOPE_MISMATCH");
  invariant(runtime.venue.universe.size === authorization.paperScope.universeSize, "UNIVERSE_SIZE_SCOPE_MISMATCH");
  invariant(JSON.stringify(runtime.venue.universe.symbols) === JSON.stringify(authorization.paperScope.universeSymbols), "FIXED_UNIVERSE_SCOPE_MISMATCH");
  invariant(runtime.paperRisk.riskAllocationMode === authorization.paperScope.riskAllocationMode, "RISK_ALLOCATION_MODE_MISMATCH");
  invariant(runtime.paperRisk.riskPerIntersectionFraction === paperRiskDirective.requestedRiskControls.maximumRiskPerIntersectionFraction, "RISK_SCOPE_MISMATCH");
  invariant(strategy?.futurePaperRisk?.authorizationId === paperRiskDirective.authorizationId, "STRATEGY_PAPER_RISK_DIRECTIVE_MISMATCH");
  invariant(strategy?.futurePaperRisk?.maximumRiskPerIntersectionFraction === runtime.paperRisk.riskPerIntersectionFraction, "STRATEGY_INTERSECTION_RISK_MISMATCH");
  invariant(strategy?.futurePaperRisk?.maximumPortfolioRiskFraction === runtime.paperRisk.maximumPortfolioRiskFraction, "STRATEGY_PORTFOLIO_RISK_MISMATCH");
  invariant(strategy?.futurePaperRisk?.application === "FORWARD_ELIGIBLE_NEW_ENTRIES_ONLY", "FORWARD_ONLY_RISK_APPLICATION_INVALID");
  invariant(strategy?.signal?.oneEntryMaximumPerIntersection === true, "SPLIT_INTERSECTION_BYPASS_NOT_FORBIDDEN");
  invariant(runtime.paperRisk.maximumOpenPositionsTotal === paperRiskDirective.preserves.maximumOpenPositionsTotal, "POSITION_SCOPE_MISMATCH");
  invariant(runtime.paperRisk.maximumPortfolioRiskFraction === paperRiskDirective.requestedRiskControls.maximumPortfolioRiskFraction, "PORTFOLIO_RISK_SCOPE_MISMATCH");
  invariant(runtime.paperRisk.maximumLeverage === paperRiskDirective.preserves.maximumLeverage, "LEVERAGE_SCOPE_MISMATCH");
  invariant(runtime.paperRisk.dailyRealizedLossStopEnabled === false, "DAILY_REALIZED_LOSS_GATE_MUST_BE_DISABLED");
  invariant(runtime.paperRisk.dailyRealizedLossStopFraction === null, "DAILY_REALIZED_LOSS_GATE_FRACTION_MUST_BE_NULL");
  invariant(governance.paperRisk.dailyRealizedLossStopEnabled === false, "GOVERNANCE_DAILY_REALIZED_LOSS_GATE_MUST_BE_DISABLED");
  invariant(governance.paperRisk.dailyRealizedLossStopFraction === null, "GOVERNANCE_DAILY_REALIZED_LOSS_GATE_FRACTION_MUST_BE_NULL");
  invariant(priorPaperRiskDirective.paperPolicy.dailyRealizedLossStopEnabled === false, "PAPER_RISK_DIRECTIVE_DAILY_GATE_INVALID");
  invariant(priorPaperRiskDirective.paperPolicy.dailyRealizedLossStopFraction === null, "PAPER_RISK_DIRECTIVE_DAILY_FRACTION_INVALID");
  invariant(priorPaperRiskDirective.paperPolicy.maximumDrawdownKillEnabled === false, "PAPER_RISK_DIRECTIVE_DRAWDOWN_GATE_INVALID");
  invariant(priorPaperRiskDirective.paperPolicy.maximumDrawdownKillFraction === null, "PAPER_RISK_DIRECTIVE_DRAWDOWN_FRACTION_INVALID");
  invariant(runtime.paperRisk.maximumDrawdownKillEnabled === false && runtime.paperRisk.maximumDrawdownKillFraction === null, "RUNTIME_DRAWDOWN_GATE_MUST_BE_DISABLED");
  invariant(governance.paperRisk.maximumDrawdownKillEnabled === false && governance.paperRisk.maximumDrawdownKillFraction === null, "GOVERNANCE_DRAWDOWN_GATE_MUST_BE_DISABLED");
  const controls = paperRiskDirective.requestedRiskControls;
  invariant(controls.maximumRiskPerIntersectionFraction === runtime.paperRisk.riskPerIntersectionFraction, "PAPER_RISK_DIRECTIVE_INTERSECTION_RISK_MISMATCH");
  invariant(controls.maximumPortfolioRiskFraction === runtime.paperRisk.maximumPortfolioRiskFraction, "PAPER_RISK_DIRECTIVE_PORTFOLIO_RISK_MISMATCH");
  invariant(paperRiskDirective.preserves.maximumOpenPositionsTotal === runtime.paperRisk.maximumOpenPositionsTotal, "PAPER_RISK_DIRECTIVE_POSITION_LIMIT_MISMATCH");
  invariant(paperRiskDirective.preserves.maximumLeverage === runtime.paperRisk.maximumLeverage, "PAPER_RISK_DIRECTIVE_LEVERAGE_MISMATCH");
  invariant(paperRiskDirective.preserves.existingPositionQuantityAndInitialRiskUnchangedByCutover === true && paperRiskDirective.preserves.stopWideningAllowed === false, "PAPER_RISK_EXISTING_POSITION_BOUNDARY_INVALID");
  invariant(paperRiskDirective.preserves.realOrdersAllowed === false && paperRiskDirective.preserves.testnetOrdersAllowed === false && paperRiskDirective.preserves.exchangeCredentialsAllowed === false && paperRiskDirective.preserves.signedRequestsAllowed === false && paperRiskDirective.preserves.exchangeOrderEndpointsAllowed === false, "PAPER_RISK_DIRECTIVE_ORDER_BOUNDARY_INVALID");
  invariant(paperRiskDirective.preserves.otherVersionsAndS1Unchanged === true && paperRiskDirective.preserves.shadowBooksAutomaticInheritanceAllowed === false, "PAPER_RISK_ISOLATION_BOUNDARY_INVALID");
  const guard = runtime.portfolioProfitProtection;
  invariant(guard?.enabled === true, "R21_PROFIT_PROTECTION_NOT_ENABLED");
  invariant(JSON.stringify(guard.excludedSymbols) === JSON.stringify(["BTCUSDT", "ETHUSDT"]), "R21_BTC_ETH_EXCLUSION_INVALID");
  invariant(guard.eligibleSymbols?.length === 8 && !guard.eligibleSymbols.includes("BTCUSDT") && !guard.eligibleSymbols.includes("ETHUSDT"), "R21_ELIGIBLE_UNIVERSE_INVALID");
  invariant(r21ImplementationDirective?.scope?.excludedSymbols?.includes("BTCUSDT") && r21ImplementationDirective?.scope?.excludedSymbols?.includes("ETHUSDT"), "R21_AUTHORIZATION_EXCLUSION_INVALID");
  const abnormalLossGateAuthority = validateAbnormalLossGateAuthorization(abnormalLossGateAuthorization, "ORION_V2_MTFX_PAPER");
  const r21IntegrityAuthorization = await readJson(PATHS.r21IntegrityAuthorization);
  invariant(r21IntegrityAuthorization?.authorizationId === "OWNER-DIRECTIVE-V2-R21-INTEGRITY-REPAIR-20260913"
    && r21IntegrityAuthorization?.status === "ACTIVE_IMPLEMENTATION_AUTHORIZED"
    && r21IntegrityAuthorization?.scope === "ORION_V2_MTFX_PAPER_ONLY"
    && r21IntegrityAuthorization?.repairRevision === V2_R21_REPAIR_REVISION, "V2_R21_INTEGRITY_AUTHORIZATION_INVALID");
  let iq1Authority = null;
  const iq1Pointer = governance?.executionDomains?.orionV2Paper?.entryQuality;
  if (iq1Pointer) {
    const directive = await readJson(path.join(PROJECT_ROOT, "governance/owner-authorizations/2026-09-15-v2-iq1-execution.json"));
    const profile = await readJson(path.join(PROJECT_ROOT, "agents/orion-v2/paper/iq1-profile.json"));
    invariant(iq1Pointer.enabled === true && iq1Pointer.revision === IQ1_REVISION
      && iq1Pointer.authorizationId === IQ1_AUTHORIZATION && directive?.authorizationId === IQ1_AUTHORIZATION
      && directive?.scope === "ORION_V2_PAPER_ONLY" && directive?.executionAuthorized === true
      && directive?.realOrdersAllowed === false && directive?.testnetOrdersAllowed === false
      && directive?.newEntriesOnly === true && directive?.preserveExistingPositions === true
      && directive?.exitRulesChanged === false && directive?.otherExecutionDomainsChanged === false && directive?.profileDigest === iq1Digest(profile)
      && iq1Pointer.profileDigest === directive.profileDigest, "IQ1_AUTHORITY_INVALID");
    validateIq1Profile(profile, runtime.paperRisk);
    iq1Authority = { profile, profileDigest: directive.profileDigest, authorizationId: IQ1_AUTHORIZATION };
  }
  const executionReleaseAuthority = validateV2ExecutionReleaseAuthority({ runtime, governance,
    directive: await readJson(PATHS.executionReleaseDirective, null) });
  return { runtime, strategy, governance, authorization, lossGatesRemovedDirective, priorPaperRiskDirective, paperRiskDirective, baselineImplementationDirective, lineageImplementationDirective, priorImplementationDirective, oneSidedImplementationDirective, structureHygieneDirective, postCrossImplementationDirective, multiAnchorImplementationDirective, r7ImplementationDirective, r8ImplementationDirective, r9ImplementationDirective, r10ImplementationDirective, r11ImplementationDirective, r12ImplementationDirective, r13ImplementationDirective, r14ImplementationDirective, r15ImplementationDirective, r16ImplementationDirective, r17ImplementationDirective, r18ImplementationDirective, r19ImplementationDirective, r20ImplementationDirective, r21ImplementationDirective, implementationDirective, tier1EventCalendar, abnormalLossGateAuthorization, abnormalLossGateAuthority, executionReleaseAuthority, iq1Authority };
}

export class PublicMarketClient {
  constructor(config) {
    this.config = config;
    this.base = new URL(config.venue.restBaseUrl);
    invariant(this.base.protocol === "https:" && this.base.hostname === "demo-fapi.binance.com", "PUBLIC_MARKET_HOST_NOT_ALLOWLISTED");
    this.requestStartTail = Promise.resolve();
    this.lastRequestAt = 0;
  }

  async scheduleRequestStart() {
    const scheduled = this.requestStartTail.then(async () => {
      const wait = Math.max(0, this.config.marketData.requestSpacingMs - (Date.now() - this.lastRequestAt));
      if (wait) await sleep(wait);
      this.lastRequestAt = Date.now();
    });
    this.requestStartTail = scheduled.catch(() => {});
    await scheduled;
  }

  async request(pathname, attempts = this.config.marketData.requestAttempts) {
    invariant(/^\/fapi\/v1\/(time|klines|ticker\/(bookTicker|24hr)|exchangeInfo)(\?|$)/.test(pathname), "PUBLIC_ENDPOINT_NOT_ALLOWLISTED");
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.scheduleRequestStart();
      try {
        const response = await fetch(new URL(pathname, this.base), {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(this.config.marketData.requestTimeoutMs),
          headers: { "user-agent": "orion-v2-mtfx-paper/1.0-public-only" },
        });
        if (!response.ok) {
          const error = new Error(`PUBLIC_HTTP_${response.status}`);
          error.status = response.status;
          error.retryAfter = response.headers.get("retry-after");
          throw error;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        if ([418, 429].includes(error?.status) || attempt === attempts) throw error;
        await sleep(300 * attempt);
      }
    }
    throw lastError;
  }

  serverTime() {
    return this.request("/fapi/v1/time").then((value) => Number(value.serverTime));
  }

  bars(symbol, interval, limit, serverTime) {
    const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
    return this.request(`/fapi/v1/klines?${query}`).then((rows) => normalizeKlines(rows, serverTime));
  }

  bookTicker(symbol) {
    const query = new URLSearchParams({ symbol });
    return this.request(`/fapi/v1/ticker/bookTicker?${query}`).then((value) => ({
      symbol,
      bid: Number(value.bidPrice),
      ask: Number(value.askPrice),
      marketTime: Number(value.time ?? Date.now()),
    }));
  }

  async exchangeInfo() {
    return this.request("/fapi/v1/exchangeInfo");
  }

  async selectUniverse() {
    const info = await this.exchangeInfo();
    const policy = this.config.venue.universe;
    const excluded = new Set(policy.excludedBaseAssets);
    const baseEligible = info.symbols.filter((item) =>
      item.status === policy.status && item.contractType === policy.contractType &&
      item.quoteAsset === policy.quoteAsset && !excluded.has(item.baseAsset)
    );
    if (policy.selection === "FIXED_OWNER_APPROVED_10") {
      invariant(Array.isArray(policy.symbols), "FIXED_UNIVERSE_SYMBOLS_MISSING");
      invariant(policy.symbols.length === policy.size && new Set(policy.symbols).size === policy.size, "FIXED_UNIVERSE_SIZE_INVALID");
      for (const mandatory of policy.mandatorySymbols) invariant(policy.symbols.includes(mandatory), `MANDATORY_SYMBOL_NOT_FIXED_${mandatory}`);
      for (const symbol of policy.symbols) invariant(baseEligible.some((item) => item.symbol === symbol), `FIXED_SYMBOL_NOT_ELIGIBLE_${symbol}`);
      return [...policy.symbols];
    }
    const tickers = await this.request("/fapi/v1/ticker/24hr");
    const volume = new Map(tickers.map((item) => [item.symbol, Number(item.quoteVolume ?? 0)]));
    const eligible = baseEligible.filter((item) => volume.get(item.symbol) > 0)
      .sort((first, second) => volume.get(second.symbol) - volume.get(first.symbol) || first.symbol.localeCompare(second.symbol));
    const selected = eligible.slice(0, policy.size).map((item) => item.symbol);
    for (const mandatory of [...policy.mandatorySymbols].reverse()) {
      invariant(eligible.some((item) => item.symbol === mandatory), `MANDATORY_SYMBOL_NOT_ELIGIBLE_${mandatory}`);
      const existingIndex = selected.indexOf(mandatory);
      if (existingIndex >= 0) selected.splice(existingIndex, 1);
      selected.unshift(mandatory);
    }
    return selected.slice(0, policy.size);
  }

  async tickSizes(symbols) {
    const info = await this.request("/fapi/v1/exchangeInfo");
    return Object.fromEntries(info.symbols.filter((item) => symbols.includes(item.symbol)).map((item) => {
      const priceFilter = item.filters.find((filter) => filter.filterType === "PRICE_FILTER");
      return [item.symbol, Number(priceFilter?.tickSize)];
    }));
  }
}

function initialState(runtime, symbols, now = Date.now()) {
  return {
    schemaVersion: 1,
    runtimeId: runtime.runtimeId,
    strategyVersion: runtime.strategyVersion,
    implementationRevision: runtime.implementationRevision,
    implementationDirectiveId: runtime.implementationDirectiveId,
    authorizationId: runtime.authorizationId,
    paperRiskDirectiveId: runtime.paperRiskDirectiveId,
    lifecycle: "INITIALIZING",
    startedAt: now,
    updatedAt: now,
    heartbeatAt: null,
    lastScanAt: null,
    lastSuccessfulScanAt: null,
    scanCount: 0,
    symbols,
    lastUniverseRefreshAt: now,
    scanErrors: [],
    plans: {},
    books: Object.fromEntries(runtime.books.map((book) => [book.variant, defaultBook(book.variant, book.initialEquityUsdt, now)])),
    positionStateCommitSequences: {},
    websocket: {
      connected: false,
      connectedAt: null,
      lastEventAt: null,
      reconnects: 0,
      selfHeals: 0,
      gapDetected: false,
    },
    lastQuotes: {},
    execution: {
      realOrdersAllowed: false,
      testnetOrdersAllowed: false,
      apiKeysAllowed: false,
      orderEndpointCalls: 0,
    },
    onlineLedger: {
      status: "INITIALIZING",
      lastPublishedAt: null,
      lastReceivedAt: null,
      lastError: null,
    },
    abnormalLossGate: null,
    lastPositionBroadcast: null,
  };
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, run));
  return results;
}

export class MtfxPaperDaemon {
  constructor(authority) {
    this.runtime = authority.runtime;
    this.strategy = authority.strategy;
    this.authorization = authority.authorization;
    this.paperRiskDirective = authority.paperRiskDirective;
    this.implementationDirective = authority.implementationDirective;
    this.executionReleaseAuthority = authority.executionReleaseAuthority ?? null;
    this.iq1Authority = authority.iq1Authority ?? null;
    this.iq1Bundles = {};
    this.iq1PreviousTrades = new Map();
    this.iq1PendingAnchors = new Set();
    this.abnormalLossGateAuthority = authority.abnormalLossGateAuthority;
    this.tier1EventCalendar = authority.tier1EventCalendar;
    this.market = new PublicMarketClient(this.runtime);
    this.ledger = new AuditLedger(PATHS.ledger);
    this.state = null;
    this.tickSizes = {};
    this.symbols = [];
    this.socket = null;
    this.stopping = false;
    this.mutationTail = Promise.resolve();
    this.lastBboEvidenceAt = new Map();
    this.reconnectTimer = null;
    this.websocketWatchdogTimer = null;
    this.websocketSelfHealInFlight = false;
    this.positionUpdateQueued = new Set();
    this.positionUpdatePending = new Set();
    this.scanInFlight = false;
    this.ledgerPublishInFlight = false;
    this.r21ProcessEpoch = randomUUID();
  }

  activeBookEntries() {
    const activeVariants = new Set(this.runtime.books
      .filter((book) => book.entryEnabled === true)
      .map((book) => book.variant));
    return Object.entries(this.state.books).filter(([variant]) => activeVariants.has(variant));
  }

  async refreshAbnormalLossGate({ now = Date.now(), reconciled = true } = {}) {
    if (!this.abnormalLossGateAuthority) return this.state.abnormalLossGate ?? null;
    const priorStatus = this.state.abnormalLossGate?.status ?? "CLEAR";
    const priorEvaluatedCount = this.state.abnormalLossGate?.evaluatedOutcomeIds?.length ?? 0;
    this.state.abnormalLossGate = evaluateAbnormalLossGate({
      priorState: this.state.abnormalLossGate,
      closedOutcomes: this.activeBookEntries().flatMap(([, book]) => book.closedPositions ?? []),
      now,
      reconciled,
      scope: "ORION_V2_MTFX_PAPER",
      activatedAt: this.abnormalLossGateAuthority.activatedAt,
      authorizationId: this.abnormalLossGateAuthority.authorizationId,
    });
    const evaluatedCount = this.state.abnormalLossGate.evaluatedOutcomeIds.length;
    if (priorStatus !== this.state.abnormalLossGate.status || evaluatedCount !== priorEvaluatedCount) {
      await this.ledger.append("PAPER_ABNORMAL_SINGLE_LOSS_GATE_EVALUATED", now, {
        authorizationId: this.abnormalLossGateAuthority.authorizationId,
        priorStatus,
        status: this.state.abnormalLossGate.status,
        entriesBlocked: this.state.abnormalLossGate.entriesBlocked,
        activeTrigger: this.state.abnormalLossGate.activeTrigger,
      });
    }
    return this.state.abnormalLossGate;
  }

  entryBlockForBook(book) {
    if (this.state.abnormalLossGate?.entriesBlocked) {
      return { blocked: true, reason: `ABNORMAL_SINGLE_LOSS_${this.state.abnormalLossGate.status}` };
    }
    return { blocked: book.newEntriesBlocked === true, reason: book.blockReason ?? null };
  }

  queueMutation(work) {
    const pending = this.mutationTail.then(work, work);
    this.mutationTail = pending.catch(() => {});
    return pending;
  }

  async ensureDerivedPositionEvents(record) {
    const payload = record?.payload;
    invariant(record?.eventId && payload?.position?.id, "PAPER_POSITION_STATE_COMMIT_RECORD_INVALID");
    const emitted = [];
    for (const [eventIndex, event] of (payload.transitionEvents ?? []).entries()) {
      const derivedEventId = `${record.eventId}_${eventIndex}_${event.type}`;
      if (typeof this.ledger.get === "function" && this.ledger.get(derivedEventId)) continue;
      let derivedRecord = await this.ledger.append(`PAPER_${event.type}`, record.marketTime, {
        positionId: payload.position.id,
        variant: payload.variant,
        stateCommitEventId: record.eventId,
        source: payload.source,
        stop: payload.position.stop,
        remainingQuantity: payload.position.quantity,
        realizedDelta: payload.realizedDelta,
        ...event,
      }, derivedEventId);
      if (!derivedRecord && typeof this.ledger.get === "function") derivedRecord = this.ledger.get(derivedEventId);
      invariant(derivedRecord, `PAPER_POSITION_DERIVED_EVENT_NOT_DURABLE_${derivedEventId}`);
      emitted.push(derivedEventId);
    }
    return emitted;
  }

  async ensureDerivedPositionEventsFromLedger() {
    if (typeof this.ledger.byType !== "function") return [];
    const emitted = [];
    for (const record of this.canonicalPositionStateRecords()) {
      emitted.push(...await this.ensureDerivedPositionEvents(record));
    }
    return emitted;
  }

  async commitPositionStateTransition({
    variant,
    priorPosition,
    nextPosition,
    bookAfter,
    marketTime,
    source,
    evidence = null,
    realizedDelta = 0,
    killRequired = false,
    transitionEvents = [],
  }) {
    const openRecord = typeof this.ledger.get === "function" ? this.ledger.get(`${priorPosition.id}_open`) : null;
    invariant(openRecord?.payload, `PAPER_POSITION_STATE_COMMIT_WITHOUT_OPEN_${priorPosition.id}`);
    assertImmutableOpenPositionMatches(nextPosition, openRecord.payload);
    const transitionEventId = deterministicId("paperposstate", {
      variant,
      positionId: priorPosition.id,
      source,
      evidence,
      position: nextPosition,
      realizedDelta,
    });
    const transitionPayload = {
      variant,
      positionId: priorPosition.id,
      source,
      position: nextPosition,
      closed: nextPosition.status === "CLOSED",
      realizedDelta: Number(realizedDelta ?? 0),
      killRequired: killRequired === true,
      bookAccounting: canonicalBookAccounting(bookAfter),
      evidence,
      transitionEvents,
    };
    let transitionRecord = typeof this.ledger.get === "function" ? this.ledger.get(transitionEventId) : null;
    if (!transitionRecord) {
      transitionRecord = await this.ledger.append(
        "PAPER_POSITION_STATE_COMMITTED",
        Number(marketTime),
        transitionPayload,
        transitionEventId,
      );
      if (!transitionRecord && typeof this.ledger.get === "function") transitionRecord = this.ledger.get(transitionEventId);
    }
    invariant(transitionRecord?.payload && Number.isFinite(Number(transitionRecord.sequence)), `PAPER_POSITION_STATE_COMMIT_NOT_DURABLE_${priorPosition.id}`);
    const appliedSequence = Number(this.state.positionStateCommitSequences?.[priorPosition.id] ?? 0);
    if (Number(transitionRecord.sequence) > appliedSequence) {
      this.state.books[variant] = applyCanonicalPositionTransition(this.state.books[variant], transitionRecord.payload);
      this.state.positionStateCommitSequences[priorPosition.id] = Number(transitionRecord.sequence);
      if (transitionRecord.payload.position?.status === "CLOSED") {
        await this.refreshAbnormalLossGate({ now: Number(marketTime), reconciled: false });
      }
      await this.persist();
    }
    await this.ensureDerivedPositionEvents(transitionRecord);
    return transitionRecord;
  }

  reconcilePositionStateFromLedger() {
    if (typeof this.ledger.byType !== "function") {
      return { recoveredOpenPositionIds: [], replayedTransitionEventIds: [] };
    }
    this.state.positionStateCommitSequences ??= {};
    const openRecords = this.ledger.byType("PAPER_POSITION_OPENED");
    const transitionRecords = this.canonicalPositionStateRecords();
    const openRecordByPositionId = new Map(openRecords
      .filter((record) => record.payload?.id)
      .map((record) => [record.payload.id, record]));
    const transitionRecordByPositionAndSequence = new Map(transitionRecords
      .filter((record) => record.payload?.position?.id && Number.isFinite(Number(record.sequence)))
      .map((record) => [`${record.payload.position.id}:${record.sequence}`, record]));
    const transitionPositionIds = new Set(transitionRecords
      .map((record) => record.payload?.position?.id)
      .filter(Boolean));
    const legacyClosedPositionIds = new Set(this.ledger.byType("PAPER_POSITION_CLOSED")
      .map((record) => record.payload?.positionId)
      .filter(Boolean));
    const recoveredOpenPositionIds = [];
    const replayedTransitionEventIds = [];

    for (const [positionId, sequenceValue] of Object.entries(this.state.positionStateCommitSequences)) {
      const sequence = Number(sequenceValue);
      invariant(Number.isInteger(sequence) && sequence >= 0, `PAPER_POSITION_STATE_WATERMARK_INVALID_${positionId}`);
      if (sequence === 0) continue;
      invariant(
        transitionRecordByPositionAndSequence.has(`${positionId}:${sequence}`),
        `PAPER_POSITION_STATE_WATERMARK_EVENT_MISSING_${positionId}_${sequence}`,
      );
    }

    for (const record of openRecords) {
      const position = record.payload;
      invariant(position?.id && position?.book, "PAPER_POSITION_OPEN_EVENT_PAYLOAD_INVALID");
      const book = this.state.books[position.book];
      invariant(book, `PAPER_POSITION_OPEN_BOOK_MISSING_${position.book}`);
      const occurrences = Object.values(this.state.books)
        .flatMap((candidateBook) => [...candidateBook.openPositions, ...candidateBook.closedPositions])
        .filter((candidate) => candidate.id === position.id);
      invariant(occurrences.length <= 1, `PAPER_POSITION_DUPLICATED_IN_STATE_${position.id}`);
      const existing = occurrences[0] ?? null;
      if (existing) {
        invariant(existing.book === position.book, `PAPER_POSITION_BOOK_DRIFT_${position.id}`);
        assertImmutableOpenPositionMatches(existing, position);
      } else {
        const appliedSequence = Number(this.state.positionStateCommitSequences[position.id] ?? 0);
        const appliedTransition = appliedSequence > 0
          ? transitionRecordByPositionAndSequence.get(`${position.id}:${appliedSequence}`)
          : null;
        if (appliedTransition?.payload?.position?.status === "OPEN") {
          book.openPositions = [...book.openPositions, appliedTransition.payload.position];
          recoveredOpenPositionIds.push(position.id);
        } else if (!appliedTransition && !(legacyClosedPositionIds.has(position.id) && !transitionPositionIds.has(position.id))) {
          book.openPositions = [...book.openPositions, position];
          recoveredOpenPositionIds.push(position.id);
        }
      }
      consumeIntersection(book, position.intersectionId);
      const plan = Object.values(this.state.plans ?? {}).find((candidate) => candidate.id === position.intersectionId);
      const gate = plan?.entryGateByBook?.[position.book];
      if (gate) {
        gate.status = "OPENED";
        gate.openedPositionId = position.id;
      }
    }

    for (const positionId of legacyClosedPositionIds) {
      if (transitionPositionIds.has(positionId)) continue;
      const staleOpen = Object.values(this.state.books)
        .flatMap((book) => book.openPositions)
        .some((position) => position.id === positionId);
      invariant(!staleOpen, `LEGACY_CLOSED_POSITION_STATE_REQUIRES_AUDIT_${positionId}`);
    }

    for (const record of transitionRecords) {
      const payload = record.payload;
      const position = payload?.position;
      invariant(position?.id && payload?.variant, "PAPER_POSITION_STATE_COMMIT_PAYLOAD_INVALID");
      const openRecord = openRecordByPositionId.get(position.id);
      invariant(openRecord, `PAPER_POSITION_STATE_COMMIT_WITHOUT_OPEN_${position.id}`);
      assertImmutableOpenPositionMatches(position, openRecord.payload);
      const appliedSequence = Number(this.state.positionStateCommitSequences[position.id] ?? 0);
      if (Number(record.sequence) <= appliedSequence) continue;
      const book = this.state.books[payload.variant];
      invariant(book, `PAPER_POSITION_STATE_COMMIT_BOOK_MISSING_${payload.variant}`);
      const existing = positionInBook(book, position.id);
      if (existing) assertImmutableOpenPositionMatches(existing, openRecord.payload);
      const reconciledBook = applyCanonicalPositionTransition(book, payload);
      this.state.books[payload.variant] = reconciledBook;
      this.state.positionStateCommitSequences[position.id] = Number(record.sequence);
      consumeIntersection(this.state.books[payload.variant], position.intersectionId);
      replayedTransitionEventIds.push(record.eventId);
    }

    return { recoveredOpenPositionIds, replayedTransitionEventIds };
  }

  reconcileOpenedPositionsFromLedger() {
    return this.reconcilePositionStateFromLedger().recoveredOpenPositionIds;
  }

  reconcilePositionEvidenceGapsFromLedger() {
    if (typeof this.ledger.byType !== "function") return [];
    const records = [
      ...this.ledger.byType("WEBSOCKET_DISCONNECTED").map((record) => ({ ...record, gapEvidence: "CAPTURE_INCOMPLETE" })),
      ...this.ledger.byType("DAEMON_RECOVERY_RESTART_REQUESTED").map((record) => ({ ...record, gapEvidence: "RECOVERY_GAP" })),
    ].sort((first, second) => Number(first.sequence) - Number(second.sequence));
    const recovered = new Set();
    for (const record of records) {
      const affectedPositionIds = new Set(record.payload?.affectedPositionIds ?? []);
      if (affectedPositionIds.size === 0) continue;
      this.state.websocket.gapDetected = true;
      for (const book of Object.values(this.state.books)) {
        const applyGap = (position) => {
          if (!affectedPositionIds.has(position.id)) return position;
          const next = applyFailClosedPositionEvidence(position, record.gapEvidence);
          if (next === position) return position;
          recovered.add(position.id);
          return next;
        };
        book.openPositions = book.openPositions.map(applyGap);
        book.closedPositions = book.closedPositions.map(applyGap);
      }
    }
    return [...recovered];
  }

  async initialize() {
    await fs.mkdir(RUNTIME_ROOT, { recursive: true });
    await this.ledger.initialize();
    this.symbols = await this.market.selectUniverse();
    const existing = await readJson(PATHS.state, null);
    this.state = existing?.runtimeId === this.runtime.runtimeId ? existing : initialState(this.runtime, this.symbols);
    this.state.positionStateCommitSequences ??= {};
    const recoveredDerivedPositionEventIds = await this.ensureDerivedPositionEventsFromLedger();
    const positionRecovery = this.reconcilePositionStateFromLedger();
    this.reconcileR21ProfitProtectionFromLedger();
    this.state.r21IntegrityRevision = V2_R21_REPAIR_REVISION;
    const { recoveredOpenPositionIds, replayedTransitionEventIds } = positionRecovery;
    const recoveredPositionEvidenceGapIds = this.reconcilePositionEvidenceGapsFromLedger();
    await this.refreshAbnormalLossGate({ now: Date.now(), reconciled: false });
    const priorAuthorizationId = this.state.authorizationId;
    const priorPaperRiskDirectiveId = this.state.paperRiskDirectiveId ?? null;
    const priorStrategyVersion = this.state.strategyVersion;
    const priorImplementationRevision = this.state.implementationRevision ?? (existing ? "MTFX-0.5.0-BASELINE" : null);
    const strategyChanged = priorStrategyVersion && priorStrategyVersion !== this.runtime.strategyVersion;
    const implementationChanged = priorImplementationRevision && priorImplementationRevision !== this.runtime.implementationRevision;
    if (!this.state.r21ProfitProtection) {
      this.state.r21ProfitProtection = initialR21State(Date.now());
    }
    let preservedCommittedPlanCount = 0;
    if (strategyChanged || implementationChanged) {
      const hasOpenPositions = Object.values(this.state.books).some((book) => book.openPositions.length > 0);
      const preserveOpenPositions = this.implementationDirective?.cutover?.preserveOpenPositions === true &&
        (this.implementationDirective?.cutover?.modifyOpenPositions === false ||
          this.implementationDirective?.cutover?.modifyOpenPositions === "OWNER_AUTHORIZED_NAMED_CONFLICT_ONLY" ||
          this.implementationDirective?.cutover?.modifyOpenPositions === "NO_IMMEDIATE_BULK_ACTION; FORWARD_REPLACEMENT_ONLY_ON_FULLY_CONFIRMED_SIGNAL" ||
          this.implementationDirective?.cutover?.modifyOpenPositions === "FORWARD_R21_MANAGEMENT_ONLY_NO_IMMEDIATE_BULK_ACTION" ||
          this.implementationDirective?.cutover?.existingPositionsUseImmutableEntryRevision === true);
      invariant(!hasOpenPositions || preserveOpenPositions, "STRATEGY_MIGRATION_REQUIRES_FLAT_BOOKS");
      const migrationNow = Date.now();
      const preserveCommittedPlans = !strategyChanged && implementationChanged &&
        this.implementationDirective?.cutover?.preserveCommittedPlans === true;
      this.state.plans = preserveCommittedPlans
        ? Object.fromEntries(Object.entries(this.state.plans ?? {}).filter(([, plan]) =>
          isPlanCommitted(plan, migrationNow) &&
          migrationNow <= confirmationReserveDeadline(plan, this.strategy, this.runtime)
        ).map(([symbol, plan]) => [symbol, {
          ...plan,
          implementationRevisionAtDiscovery: plan.implementationRevisionAtDiscovery ?? priorImplementationRevision,
          carriedAcrossImplementationRevision: this.runtime.implementationRevision,
        }]))
        : {};
      preservedCommittedPlanCount = Object.keys(this.state.plans).length;
      for (const book of Object.values(this.state.books)) {
        if (!preserveCommittedPlans) {
          book.consumedIntersectionIds = [];
          book.observedRetests = [];
        }
      }
    }
    this.state.strategyVersion = this.runtime.strategyVersion;
    this.state.implementationRevision = this.runtime.implementationRevision;
    this.state.implementationDirectiveId = this.runtime.implementationDirectiveId;
    this.state.authorizationId = this.runtime.authorizationId;
    this.state.paperRiskDirectiveId = this.runtime.paperRiskDirectiveId;
    let dailyLossBlockersCleared = 0;
    for (const [variant, book] of Object.entries(this.state.books)) {
      const reconciliation = reconcileDailyRealizedLossPolicy(book, this.runtime);
      if (!reconciliation.changed) continue;
      this.state.books[variant] = reconciliation.book;
      dailyLossBlockersCleared += 1;
    }
    this.symbols = [...new Set([...this.symbols, ...Object.values(this.state.books).flatMap((book) => book.openPositions.map((position) => position.symbol))])];
    this.state.symbols = this.symbols;
    this.state.plans = Object.fromEntries(Object.entries(this.state.plans ?? {}).filter(([symbol]) => this.symbols.includes(symbol)));
    this.tickSizes = await this.market.tickSizes(this.symbols);
    for (const symbol of this.symbols) invariant(this.tickSizes[symbol] > 0, `TICK_SIZE_MISSING_${symbol}`);
    const killSwitch = await readJson(PATHS.killSwitch, null);
    invariant(killSwitch?.engaged === false && killSwitch?.authorizationId === this.runtime.authorizationId, "KILL_SWITCH_NOT_OWNER_CLEARED");
    this.state.lifecycle = "ACTIVE_PAPER_SIMULATION";
    await this.normalizeOwnerAuthorizedSameSymbolConflicts();
    await this.loadExecutionRelease();
    if (this.iq1Authority) {
      const loadedAt = Date.now();
      const payload = { revision: IQ1_REVISION, ...this.iq1Authority, loadedAt,
        processId: process.pid, processEpoch: this.r21ProcessEpoch, enabled: true };
      const record = await this.ledger.append("MTFX_IQ1_LOADED", loadedAt, payload,
        deterministicId("iq1load", payload));
      invariant(record?.eventId, "IQ1_LOAD_NOT_DURABLE");
      this.state.entryQualityRelease = { ...payload, status: "LOADED_WAITING_CYCLE", loadEventId: record.eventId };
    }
    this.state.updatedAt = Date.now();
    await this.ledger.append("DAEMON_STARTED", Date.now(), {
      runtimeId: this.runtime.runtimeId,
      r21IntegrityRevision: V2_R21_REPAIR_REVISION,
      strategyVersion: this.runtime.strategyVersion,
      implementationRevision: this.runtime.implementationRevision,
      executionRelease: this.state.executionRelease ?? null,
      authorizationId: this.runtime.authorizationId,
      paperRiskDirectiveId: this.runtime.paperRiskDirectiveId,
      symbols: this.symbols,
      variants: Object.keys(this.state.books),
      realOrdersAllowed: false,
    });
    if (recoveredOpenPositionIds.length || replayedTransitionEventIds.length || recoveredDerivedPositionEventIds.length || recoveredPositionEvidenceGapIds.length) {
      await this.ledger.append("PAPER_POSITION_STATE_RECOVERED_FROM_LEDGER", Date.now(), {
        positionIds: recoveredOpenPositionIds,
        transitionEventIds: replayedTransitionEventIds,
        derivedEventIds: recoveredDerivedPositionEventIds,
        evidenceGapPositionIds: recoveredPositionEvidenceGapIds,
        recoveryMode: "IMMUTABLE_OPEN_PLUS_CANONICAL_POSITION_STATE_TRANSITIONS",
      });
    }
    if (priorAuthorizationId && priorAuthorizationId !== this.runtime.authorizationId) {
      await this.ledger.append("OWNER_AUTHORIZATION_MIGRATED", Date.now(), {
        priorAuthorizationId,
        authorizationId: this.runtime.authorizationId,
        positionsPreserved: this.hasOpenPosition(),
      });
    }
    if (priorPaperRiskDirectiveId !== this.runtime.paperRiskDirectiveId || dailyLossBlockersCleared > 0) {
      await this.ledger.append("PAPER_RISK_DIRECTIVE_MIGRATED", Date.now(), {
        priorPaperRiskDirectiveId,
        paperRiskDirectiveId: this.runtime.paperRiskDirectiveId,
        dailyRealizedLossGateRemoved: true,
        maximumDrawdownKillRemoved: true,
        dailyLossBlockersCleared,
        positionsPreserved: this.hasOpenPosition(),
        pendingStructureHygieneActivated: false,
      });
    }
    if (priorStrategyVersion && priorStrategyVersion !== this.runtime.strategyVersion) {
      await this.ledger.append("STRATEGY_VERSION_MIGRATED", Date.now(), {
        priorStrategyVersion,
        strategyVersion: this.runtime.strategyVersion,
        positionsPreserved: this.hasOpenPosition(),
        oldPlansInvalidated: preservedCommittedPlanCount === 0,
        uncommittedPlansInvalidated: true,
      });
    }
    if (implementationChanged) {
      await this.ledger.append("IMPLEMENTATION_REVISION_MIGRATED", Date.now(), {
        priorImplementationRevision,
        implementationRevision: this.runtime.implementationRevision,
        implementationDirectiveId: this.runtime.implementationDirectiveId,
        positionsPreserved: this.hasOpenPosition(),
        oldPlansInvalidated: true,
        committedPlansPreserved: preservedCommittedPlanCount,
      });
    }
    await this.persist();
  }

  hasOpenPosition(symbol = null) {
    return Object.values(this.state.books).some((book) => book.openPositions.some((position) => position.status === "OPEN" && (!symbol || position.symbol === symbol)));
  }

  quote(symbol) {
    const quote = this.state.lastQuotes[symbol];
    if (!quote) return null;
    return {
      ...quote,
      tickSize: this.tickSizes[symbol],
      coverageComplete: hasPostConnectQuoteCoverage(this.state.websocket, quote),
    };
  }

  connectWebsocket() {
    if (this.stopping) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const streams = this.symbols.flatMap((symbol) => [`${symbol.toLowerCase()}@trade`, `${symbol.toLowerCase()}@bookTicker`]);
    const url = `${this.runtime.venue.websocketBaseUrl}?streams=${streams.join("/")}`;
    const parsed = new URL(url);
    invariant(parsed.protocol === "wss:" && parsed.hostname === "fstream.binance.com", "PUBLIC_WEBSOCKET_HOST_NOT_ALLOWLISTED");
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.websocketSelfHealInFlight = false;
      this.queueMutation(async () => {
        const now = Date.now();
        this.state.websocket.connected = true;
        this.state.websocket.connectedAt = now;
        this.state.websocket.lastEventAt = now;
        this.state.updatedAt = now;
        await this.ledger.append("WEBSOCKET_CONNECTED", now, { streams: streams.length });
        await this.persist();
      });
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      this.handleWebsocketMessage(event.data).catch((error) => this.recordError("WEBSOCKET_MESSAGE", error));
    });
    const disconnected = (event) => {
      if (socket !== this.socket) return;
      this.queueMutation(async () => {
        const now = Date.now();
        const affectedPositionIds = Object.values(this.state.books)
          .flatMap((book) => book.openPositions)
          .filter((position) => position.status === "OPEN")
          .map((position) => position.id);
        this.state.websocket.connected = false;
        this.state.websocket.lastEventAt = now;
        this.state.websocket.reconnects += 1;
        if (this.hasOpenPosition()) {
          this.state.websocket.gapDetected = true;
          for (const book of Object.values(this.state.books)) {
            book.openPositions = book.openPositions.map((position) => applyFailClosedPositionEvidence(position, "CAPTURE_INCOMPLETE"));
          }
        }
        await this.ledger.append("WEBSOCKET_DISCONNECTED", now, {
          code: event?.code ?? null,
          openPosition: affectedPositionIds.length > 0,
          affectedPositionIds,
          gapEvidence: "CAPTURE_INCOMPLETE",
        });
        await this.persist();
      });
      if (!this.stopping) this.reconnectTimer = setTimeout(() => this.connectWebsocket(), 1000);
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", () => { try { socket.close(4_000, "PUBLIC_WEBSOCKET_ERROR_SELF_HEAL"); } catch {} });
  }

  selfHealStaleWebsocket() {
    if (this.stopping || this.websocketSelfHealInFlight || !websocketNeedsSelfHeal(this.state.websocket)) return false;
    const staleSocket = this.socket;
    if (!staleSocket) return false;
    this.websocketSelfHealInFlight = true;
    this.state.websocket.selfHeals = Number(this.state.websocket.selfHeals ?? 0) + 1;
    try { staleSocket.close(4_000, "PUBLIC_WEBSOCKET_STALE_SELF_HEAL"); } catch {}
    setTimeout(() => {
      if (this.stopping) return;
      if (staleSocket === this.socket) this.connectWebsocket();
      this.websocketSelfHealInFlight = false;
    }, 2_000).unref?.();
    return true;
  }

  async handleWebsocketMessage(raw) {
    const message = JSON.parse(String(raw));
    const data = message.data ?? message;
    const symbol = data.s;
    if (!this.symbols.includes(symbol)) return;
    const now = Date.now();
    if (data.e === "bookTicker") {
      const bid = Number(data.b);
      const ask = Number(data.a);
      if (!(bid > 0 && ask >= bid)) return;
      const updateId = Number(data.u);
      if (!Number.isFinite(updateId)) return;
      const marketTime = Number(data.T ?? data.E ?? now);
      const prior = this.state.lastQuotes[symbol];
      if (Number.isFinite(Number(prior?.marketTime)) && marketTime < Number(prior.marketTime)) return;
      if (Number.isFinite(updateId) && Number.isFinite(Number(prior?.updateId)) && updateId <= Number(prior.updateId)) return;
      this.state.websocket.lastEventAt = now;
      this.state.lastQuotes[symbol] = {
        symbol,
        bid,
        ask,
        marketTime,
        eventTime: Number(data.E ?? marketTime),
        transactionTime: Number(data.T ?? marketTime),
        connectionEpoch: this.r21ConnectionEpoch().id,
        marketTimeSource: data.T != null ? "EXCHANGE_TRANSACTION" : data.E != null ? "EXCHANGE_EVENT" : "LOCAL_FALLBACK",
        updateId,
        receivedAt: now,
      };
      if (this.hasOpenPosition(symbol)) this.schedulePositionUpdate(symbol);
    } else if (data.e === "trade") {
      if (this.iq1Authority) this.observeIq1Trade(symbol, data, now);
      if (!this.hasOpenPosition(symbol)) return;
      await appendLine(PATHS.tradeEvidence, JSON.stringify({
        symbol,
        price: Number(data.p),
        quantity: Number(data.q),
        tradeId: data.t,
        eventTime: Number(data.E ?? now),
        tradeTime: Number(data.T ?? now),
        buyerIsMaker: data.m,
        receivedAt: now,
      }));
    }
  }

  schedulePositionUpdate(symbol) {
    this.positionUpdatePending.add(symbol);
    if (this.positionUpdateQueued.has(symbol)) return;
    this.positionUpdateQueued.add(symbol);
    const drain = async () => {
      while (this.positionUpdatePending.delete(symbol)) {
        await this.queueMutation(async () => {
          const quote = this.quote(symbol);
          if (!quote) return;
          const now = quote.receivedAt;
          const lastPersist = this.lastBboEvidenceAt.get(symbol) ?? 0;
          if (now - lastPersist >= this.runtime.marketData.bboEvidenceMinimumIntervalMs) {
            this.lastBboEvidenceAt.set(symbol, now);
            await appendLine(PATHS.bboEvidence, JSON.stringify({
              symbol,
              bid: quote.bid,
              ask: quote.ask,
              marketTime: quote.marketTime,
              eventTime: quote.eventTime ?? quote.marketTime,
              transactionTime: quote.transactionTime ?? quote.marketTime,
              updateId: quote.updateId ?? null,
              receivedAt: now,
            }));
          }
          await this.managePositions(symbol, quote, now);
        });
      }
    };
    drain().catch((error) => this.recordError("POSITION_UPDATE", error)).finally(() => {
      this.positionUpdateQueued.delete(symbol);
      if (this.positionUpdatePending.has(symbol)) this.schedulePositionUpdate(symbol);
    });
  }

  async managePositions(symbol, quote, now, reasonOverride = null) {
    if (!quote) return;
    let killRequired = false;
    for (const [variant, book] of Object.entries(this.state.books)) {
      const bookConfig = this.runtime.books.find((candidate) => candidate.variant === variant);
      if (bookConfig?.entryEnabled !== true) continue;
      for (const position of [...book.openPositions].filter((candidate) => candidate.symbol === symbol)) {
        const result = updatePaperPosition(position, quote, this.runtime, now, reasonOverride);
        if (!result.changed) continue;
        const applied = applyPositionResult(this.state.books[variant], result, this.runtime, now);
        const transitionRecord = await this.commitPositionStateTransition({
          variant,
          priorPosition: position,
          nextPosition: result.position,
          bookAfter: applied.book,
          marketTime: Number(quote.marketTime ?? now),
          source: "BBO_POSITION_MANAGEMENT",
          evidence: {
            bid: quote.bid,
            ask: quote.ask,
            marketTime: quote.marketTime ?? null,
            eventTime: quote.eventTime ?? null,
            transactionTime: quote.transactionTime ?? null,
            updateId: quote.updateId ?? null,
            receivedAt: quote.receivedAt ?? now,
          },
          realizedDelta: Number(result.realizedDelta ?? 0),
          killRequired: applied.killRequired === true,
          transitionEvents: result.events ?? [],
        });
        killRequired ||= transitionRecord.payload.killRequired === true;
      }
    }
    if (killRequired) await this.engageKillSwitch("MAXIMUM_VIRTUAL_DRAWDOWN_REACHED");
  }

  async loadExecutionRelease(now = Date.now()) {
    if (!this.executionReleaseAuthority) {
      this.state.executionRelease = null;
      return null;
    }
    const priorLoads = this.ledger.byType("PAPER_EXECUTION_RELEASE_LOADED")
      .filter((record) => record.payload?.executionRevision === this.executionReleaseAuthority.executionRevision
        && record.payload?.executionDirectiveId === this.executionReleaseAuthority.executionDirectiveId
        && Number.isFinite(record.payload?.loadedAt) && record.payload.loadedAt > 0)
      .sort((a, b) => a.sequence - b.sequence);
    const payload = { ...this.executionReleaseAuthority, loadedAt: now,
      activatedAt: priorLoads[0]?.payload.loadedAt ?? now, processId: process.pid,
      processEpoch: this.r21ProcessEpoch, runtimeId: this.runtime.runtimeId };
    const eventId = deterministicId("v2executionload", payload);
    let record = this.ledger.get(eventId);
    if (!record) record = await this.ledger.append("PAPER_EXECUTION_RELEASE_LOADED", now, payload, eventId);
    if (!record) record = this.ledger.get(eventId);
    invariant(record?.payload && Number.isInteger(record.sequence), "V2_EXECUTION_RELEASE_LOAD_NOT_DURABLE");
    this.state.executionRelease = { ...record.payload, loadEventId: record.eventId,
      loadLedgerSequence: record.sequence, status: "AWAITING_FRESH_EVIDENCE", verifiedAt: null,
      verificationDecisionEventId: null, verificationLedgerSequence: null };
    return this.state.executionRelease;
  }

  async recordPaperPositionOpened(position, marketTime) {
    const openEventId = `${position.id}_open`;
    let openRecord = typeof this.ledger.get === "function" ? this.ledger.get(openEventId) : null;
    // A retry recovers its original durable binding, including a previous
    // process's loadedAt or the absence of release fields in an old R22 entry.
    const proposedPosition = openRecord ? { ...position, ...Object.fromEntries(
      [...EXECUTION_RELEASE_POSITION_FIELDS,"entryQualityRevision","entryQualityEvidence"].filter((field) => position[field] === undefined && openRecord.payload?.[field] !== undefined)
        .map((field) => [field, openRecord.payload[field]]),
    ) } : bindV2ExecutionRelease(position, this.executionReleaseAuthority ? this.state.executionRelease : null);
    if (!openRecord) {
      if (this.iq1Authority) invariant(position.entryQualityRevision===IQ1_REVISION
        && position.entryQualityEvidence?.profileDigest===this.iq1Authority.profileDigest
        && position.entryQualityEvidence?.decision?.allowed===true
        && position.entryQualityEvidence?.shape?.allowed===true
        && this.ledger.get?.(position.entryQualityEvidence?.anchorEventId)?.type==="MTFX_IQ1_CROSS_ANCHOR"
        && this.ledger.get?.(position.entryQualityEvidence?.decision?.decisionEventId)?.payload?.allowed===true
        && position.entryQualityEvidence?.loadEventId===this.state.entryQualityRelease?.loadEventId,
        "IQ1_OPEN_WITHOUT_ADMISSION_EVIDENCE");
      invariant(!this.executionReleaseAuthority || this.state.executionRelease, "V2_EXECUTION_RELEASE_NOT_LOADED");
      openRecord = await this.ledger.append("PAPER_POSITION_OPENED", marketTime, proposedPosition, openEventId);
      if (!openRecord && typeof this.ledger.get === "function") openRecord = this.ledger.get(openEventId);
    }
    invariant(openRecord?.payload, `PAPER_POSITION_OPEN_EVENT_NOT_DURABLE_${position.id}`);
    assertImmutableOpenPositionMatches(proposedPosition, openRecord.payload);
    return openRecord;
  }

  r21MarkedPositions(quotes = this.state.lastQuotes) {
    const rows = [];
    for (const [, book] of this.activeBookEntries()) {
      for (const position of book.openPositions) {
        const quote = quotes?.[position.symbol];
        const executable = position.direction === 1 ? Number(quote?.bid) : Number(quote?.ask);
        const currentNetR = quote ? netLiquidationR(position, executable, this.runtime) : NaN;
        const originalQuantity = Number(position.originalQuantity ?? position.quantity);
        const initialRiskPerUnit = Number(position.initialRiskPerUnit ?? Number(position.initialPlannedRiskUsdt) / originalQuantity);
        const remainingNetPnl = currentNetR * initialRiskPerUnit * Number(position.quantity);
        rows.push({
          id: position.id,
          symbol: position.symbol,
          direction: position.direction,
          initialRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt),
          markedNetPnlUsdt: Number(position.cumulativeRealizedNetPnl ?? 0) + remainingNetPnl,
          initialStage: position.softLockTaken !== true && position.firstPartialTaken !== true && currentNetR < 0.5,
          r21DefenseReductionTaken: position.r21DefenseReductionTaken === true,
          openedAt: position.openedAt,
        });
      }
    }
    return rows;
  }

  r21ConnectionEpoch() {
    const websocket = this.state.websocket ?? {};
    return {
      connected: websocket.connected === true,
      connectedAt: websocket.connectedAt,
      id: `${this.r21ProcessEpoch}:${websocket.connectedAt}:${websocket.reconnects ?? 0}`,
    };
  }

  canonicalPositionStateRecords() {
    return expandPaperPositionStateRecords([
      ...this.ledger.byType("PAPER_POSITION_STATE_COMMITTED"),
      ...this.ledger.byType("PAPER_R21_PROFIT_PROTECTION_EVALUATED"),
    ]).filter((record) => record.type === "PAPER_POSITION_STATE_COMMITTED")
      .sort((first, second) => Number(first.sequence) - Number(second.sequence));
  }

  reconcileR21ProfitProtectionFromLedger() {
    if (typeof this.ledger.byType !== "function") return null;
    const records = this.ledger.byType("PAPER_R21_PROFIT_PROTECTION_EVALUATED")
      .sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const watermark = Number(this.state.r21ProfitProtectionSequence ?? 0);
    invariant(Number.isInteger(watermark) && watermark >= 0, "R21_STATE_WATERMARK_INVALID");
    invariant(watermark === 0 || records.some((record) => Number(record.sequence) === watermark), "R21_STATE_WATERMARK_EVENT_MISSING");
    const latest = records.at(-1);
    if (!latest || Number(latest.sequence) <= watermark) return null;
    invariant(latest.payload?.repairRevision === V2_R21_REPAIR_REVISION && latest.payload?.state, "R21_STATE_COMMIT_INVALID");
    this.state.r21ProfitProtection = structuredClone(latest.payload.state);
    this.state.r21ProfitProtectionSequence = Number(latest.sequence);
    return latest.eventId;
  }

  async evaluateAndApplyR21ProfitProtection(now, { localNow = now, clockEvidence = null } = {}) {
    const config = this.runtime.portfolioProfitProtection;
    if (config?.enabled !== true) return;
    // Freeze one decision frame before any asynchronous persistence. No later
    // quote may replace a leg of this committed paper decision.
    const quotes = structuredClone(this.state.lastQuotes ?? {});
    const primaryBook = this.state.books["MTFX-T"];
    const outcome = evaluateV2R21ProfitProtection({
      priorState: this.state.r21ProfitProtection,
      positions: this.r21MarkedPositions(quotes),
      closedPositions: this.activeBookEntries().flatMap(([, book]) => book.closedPositions ?? []),
      quotes,
      equityUsdt: Number(primaryBook?.equityUsdt ?? 0),
      now,
      localNow,
      clockEvidence,
      connectionEpoch: this.r21ConnectionEpoch(),
      config,
    });
    const nextState = {
      ...outcome.state,
      freezeEligibleEntries: outcome.freezeEligibleEntries,
      frozenDirections: outcome.frozenDirections,
    };
    const decisionEventId = deterministicId("v2r21decision", { now, localNow, state: nextState, evidence: outcome.evidence, actions: outcome.actions });
    const books = structuredClone(Object.fromEntries(this.activeBookEntries()));
    const positionTransitions = [];
    for (const action of outcome.actions) {
      for (const [variant, book] of Object.entries(books)) {
        const priorPosition = book.openPositions.find((position) => position.id === action.positionId);
        const quote = quotes[action.symbol];
        if (!priorPosition || !quote || !isR21EligibleSymbol(action.symbol, config)) continue;
        const executionAt = Number(quote.marketTime);
        const result = action.type === "CLOSE_INITIAL"
          ? updatePaperPosition(priorPosition, quote, this.runtime, executionAt, "R21_PORTFOLIO_HARD_PROFIT_PROTECTION")
          : updatePaperPosition(priorPosition, quote, this.runtime, executionAt, null, action);
        if (!result.changed) continue;
        const openRecord = this.ledger.get(`${priorPosition.id}_open`);
        invariant(openRecord?.payload, `PAPER_POSITION_STATE_COMMIT_WITHOUT_OPEN_${priorPosition.id}`);
        assertImmutableOpenPositionMatches(result.position, openRecord.payload);
        const applied = applyPositionResult(book, result, this.runtime, executionAt);
        books[variant] = applied.book;
        positionTransitions.push({
          variant,
          positionId: priorPosition.id,
          source: "R21_ALT_PORTFOLIO_PROFIT_PROTECTION",
          marketTime: executionAt,
          position: result.position,
          closed: result.position.status === "CLOSED",
          realizedDelta: Number(result.realizedDelta ?? 0),
          killRequired: false,
          bookAccounting: canonicalBookAccounting(applied.book),
          evidence: { ...quote, action: action.type, decisionAt: now, decisionLocalAt: localNow, r21DecisionEventId: decisionEventId, repairRevision: V2_R21_REPAIR_REVISION },
          transitionEvents: result.events ?? [],
        });
      }
    }
    // One canonical record commits every paper leg and the campaign together.
    // Recovery projects the legs into the global position-transition sequence.
    const payload = { repairRevision: V2_R21_REPAIR_REVISION, state: nextState, evidence: outcome.evidence, actions: outcome.actions, positionTransitions };
    let record = this.ledger.get(decisionEventId);
    if (!record) record = await this.ledger.append("PAPER_R21_PROFIT_PROTECTION_EVALUATED", now, payload, decisionEventId);
    if (!record) record = this.ledger.get(decisionEventId);
    invariant(record?.payload && Number.isInteger(record.sequence), "R21_DECISION_NOT_DURABLE");
    const legs = expandPaperPositionStateRecords([record]).filter((leg) => leg.type === "PAPER_POSITION_STATE_COMMITTED");
    for (const leg of legs) {
      const positionId = leg.payload.position.id;
      if (Number(this.state.positionStateCommitSequences[positionId] ?? 0) >= record.sequence) continue;
      this.state.books[leg.payload.variant] = applyCanonicalPositionTransition(this.state.books[leg.payload.variant], leg.payload);
      this.state.positionStateCommitSequences[positionId] = record.sequence;
    }
    this.state.r21ProfitProtection = structuredClone(record.payload.state);
    this.state.r21ProfitProtectionSequence = record.sequence;
    this.state.executionRelease = confirmV2ExecutionRelease(this.state.executionRelease, record);
    await this.persist();
    for (const leg of legs) await this.ensureDerivedPositionEvents(leg);
    if (legs.some((leg) => leg.payload.closed)) await this.refreshAbnormalLossGate({ now, reconciled: false });
    return record;
  }

  async normalizeOwnerAuthorizedSameSymbolConflicts() {
    const instructions = this.implementationDirective?.cutover?.ownerAuthorizedConflictNormalization ?? [];
    for (const instruction of instructions) {
      const book = this.state.books?.[instruction.book];
      invariant(book, `CONFLICT_NORMALIZATION_BOOK_MISSING_${instruction.book}`);
      const retain = book.openPositions.find((position) => position.id === instruction.retainPositionId);
      const close = book.openPositions.find((position) => position.id === instruction.closePositionId);
      if (!close) continue;
      invariant(retain, `CONFLICT_NORMALIZATION_RETAIN_POSITION_MISSING_${instruction.retainPositionId}`);
      invariant(retain.symbol === instruction.symbol && close.symbol === instruction.symbol, "CONFLICT_NORMALIZATION_SYMBOL_MISMATCH");
      invariant(Number(retain.direction) === -Number(close.direction), "CONFLICT_NORMALIZATION_REQUIRES_OPPOSITE_DIRECTION");
      invariant(Number(close.openedAt) > Number(retain.openedAt), "CONFLICT_NORMALIZATION_REQUIRES_LATER_POSITION_CLOSE");
      const quote = await this.market.bookTicker(instruction.symbol);
      invariant(Number(quote?.bid) > 0 && Number(quote?.ask) >= Number(quote?.bid), "CONFLICT_NORMALIZATION_BBO_INVALID");
      const now = Number(quote.marketTime ?? Date.now());
      const actionId = `same_symbol_normalization_${close.id}`;
      await this.ledger.append("MTFX_SAME_SYMBOL_CONFLICT_NORMALIZATION_AUTHORIZED", now, {
        directiveId: this.implementationDirective.id,
        book: instruction.book,
        symbol: instruction.symbol,
        retainPositionId: retain.id,
        closePositionId: close.id,
        reason: instruction.reason,
        executionPriceSide: Number(close.direction) === 1 ? "BID" : "ASK",
        bid: quote.bid,
        ask: quote.ask,
      }, actionId);
      const result = updatePaperPosition(close, quote, this.runtime, now, instruction.reason);
      invariant(result.closed === true && result.position.status === "CLOSED", `CONFLICT_NORMALIZATION_CLOSE_FAILED_${close.id}`);
      const applied = applyPositionResult(book, result, this.runtime, now);
      await this.commitPositionStateTransition({
        variant: instruction.book,
        priorPosition: close,
        nextPosition: result.position,
        bookAfter: applied.book,
        marketTime: now,
        source: "OWNER_AUTHORIZED_SAME_SYMBOL_CONFLICT_NORMALIZATION",
        evidence: {
          bid: quote.bid,
          ask: quote.ask,
          marketTime: quote.marketTime ?? now,
          source: "PUBLIC_BBO_SNAPSHOT_FOR_OWNER_AUTHORIZED_PAPER_NORMALIZATION",
        },
        realizedDelta: Number(result.realizedDelta ?? 0),
        transitionEvents: [{
          type: "SAME_SYMBOL_CONFLICT_NORMALIZED",
          retainPositionId: retain.id,
          closePositionId: close.id,
          reason: instruction.reason,
        }],
      });
    }
  }

  async replaceWithConfirmedOppositeCurrentStructure({ variant, priorPosition, plan, gate, quote, now }) {
    const directionConfirmedAt = gate.lockedPriceConfirmation.confirmedAt;
    const actionId = deterministicId("mtfx_current_structure_replacement", {
      directiveId: this.implementationDirective.id,
      priorPositionId: priorPosition.id,
      replacementIntersectionId: plan.id,
    });
    await this.ledger.append("MTFX_CURRENT_STRUCTURE_REPLACEMENT_AUTHORIZED", now, {
      directiveId: this.implementationDirective.id,
      variant,
      symbol: plan.symbol,
      priorPositionId: priorPosition.id,
      priorDirection: priorPosition.direction,
      priorStage: priorPosition.stage,
      priorIntersectionId: priorPosition.intersectionId,
      priorIntersectionTime: priorPosition.intersectionTime,
      replacementIntersectionId: plan.id,
      replacementIntersectionTime: plan.intersectionTime,
      replacementDirection: gate.lockedPriceConfirmation.direction,
      directionConfirmedAt,
      fourHourLineStatus: plan.fourHourLineStatus,
      bid: quote.bid,
      ask: quote.ask,
      executionOrder: "CLOSE_OLD_THEN_OPEN_NEW",
    }, actionId);
    const closeResult = updatePaperPosition(
      priorPosition,
      quote,
      this.runtime,
      now,
      "SUPERSEDED_BY_CONFIRMED_OPPOSITE_CURRENT_STRUCTURE",
    );
    invariant(closeResult.closed === true && closeResult.position.status === "CLOSED", `CURRENT_STRUCTURE_REPLACEMENT_CLOSE_FAILED_${priorPosition.id}`);
    const applied = applyPositionResult(this.state.books[variant], closeResult, this.runtime, now);
    await this.commitPositionStateTransition({
      variant,
      priorPosition,
      nextPosition: closeResult.position,
      bookAfter: applied.book,
      marketTime: now,
      source: "CURRENT_STRUCTURE_REPLACEMENT_CLOSE",
      evidence: {
        bid: quote.bid,
        ask: quote.ask,
        marketTime: quote.marketTime ?? now,
        updateId: quote.updateId ?? null,
        replacementIntersectionId: plan.id,
        replacementDirection: gate.lockedPriceConfirmation.direction,
        directionConfirmedAt,
      },
      realizedDelta: Number(closeResult.realizedDelta ?? 0),
      transitionEvents: [{
        type: "POSITION_SUPERSEDED_BY_CONFIRMED_OPPOSITE_CURRENT_STRUCTURE",
        replacementIntersectionId: plan.id,
        replacementDirection: gate.lockedPriceConfirmation.direction,
      }],
    });
    return closeResult.position;
  }

  async fetchBundle(symbol, serverTime) {
    const limits = this.runtime.marketData.klineLimits;
    const [bars15m, bars1h, bars4h] = await Promise.all([
      this.market.bars(symbol, "15m", limits["15m"], serverTime),
      this.market.bars(symbol, "1h", limits["1h"], serverTime),
      this.market.bars(symbol, "4h", limits["4h"], serverTime),
    ]);
    invariant(bars15m.length >= 100 && bars1h.length >= 50 && bars4h.length >= 30, `INSUFFICIENT_BARS_${symbol}`);
    return { symbol, bars15m, bars1h, bars4h };
  }

  async scanCycle() {
    const killSwitch = await readJson(PATHS.killSwitch, null);
    if (killSwitch?.engaged) {
      await this.shutdown(`KILL_SWITCH_${killSwitch.reason ?? "ENGAGED"}`);
      return;
    }
    const now = await this.market.serverTime();
    if (now - Number(this.state.lastUniverseRefreshAt ?? 0) >= this.runtime.marketData.universeRefreshMs) {
      await this.refreshUniverse(now);
    }
    await this.queueMutation(async () => {
      this.state.lastScanAt = now;
      this.state.scanCount += 1;
      await this.writeLatest();
    });
    const results = await mapWithConcurrency([...this.symbols], 6, async (symbol) => {
      try {
        return { symbol, bundle: await this.fetchBundle(symbol, now), error: null };
      } catch (error) {
        return { symbol, bundle: null, error };
      }
    });
    const decisionRequestLocalAt = Date.now();
    const decisionClock = {
      marketTime: await this.market.serverTime(),
      localTime: Date.now(),
    };
    await this.queueMutation(async () => {
      await this.ensureDerivedPositionEventsFromLedger();
      const protectionLocalNow = Date.now();
      await this.evaluateAndApplyR21ProfitProtection(
        Number(decisionClock.marketTime) + Math.max(0, protectionLocalNow - decisionRequestLocalAt),
        { localNow: protectionLocalNow, clockEvidence: {
          serverTime: Number(decisionClock.marketTime), requestLocalAt: decisionRequestLocalAt,
          responseLocalAt: Number(decisionClock.localTime), uncertaintyMs: Number(decisionClock.localTime) - decisionRequestLocalAt,
          basis: "OBSERVED_SERVER_CLOCK_UPPER_BOUND",
        } },
      );
      const errors = [];
      const iq1Signals = [];
      if (this.iq1Authority) {
        this.iq1Bundles = Object.fromEntries(results.filter(r => !r.error).map(r => [r.symbol, r.bundle]));
        this.iq1Correlation = buildIq1Correlation(this.iq1Bundles, this.symbols, this.iq1Authority.profile,
          now, Date.now());
        if(this.iq1Correlation.valid) {
          const correlationEventId='iq1corr_'+this.iq1Correlation.id;
          const record=await this.ledger.append('MTFX_IQ1_CORRELATION_SNAPSHOT',now,
            {...this.iq1Correlation,profileDigest:this.iq1Authority.profileDigest},correlationEventId)
            ?? this.ledger.get(correlationEventId);
          invariant(record?.eventId,'IQ1_CORRELATION_NOT_DURABLE');
          this.iq1Correlation.eventId=record.eventId;
        }
      }
      for (const result of results) {
        const { symbol, bundle, error } = result;
        if (error) {
          errors.push({ symbol, message: error.message, at: now });
          await this.ledger.append("SYMBOL_SCAN_FAILED", now, { symbol, message: error.message });
          continue;
        }
        try {
        const discovered = findConvergencePlan({ ...bundle, now, strategy: this.strategy });
        const existing = this.state.plans[symbol] ?? null;
        const existingCommitted = existing && isPlanCommitted(existing, now) &&
          now <= confirmationReserveDeadline(existing, this.strategy, this.runtime);
        const existingFrozen = existing && now >= existing.lockedBarOpenTime &&
          now <= confirmationReserveDeadline(existing, this.strategy, this.runtime);
        if (discovered || existingCommitted || existingFrozen) {
          const selected = existingFrozen || existingCommitted
            ? { ...existing, committed: true, frozen: now >= existing.lockedBarOpenTime }
            : discovered;
          const plan = existing?.id === selected.id ? { ...selected, createdAt: existing.createdAt, version: existing.version } : {
            ...selected,
            version: Number(existing?.version ?? 0) + 1,
          };
          this.state.plans[symbol] = plan;
          if (existing?.id !== plan.id) await this.ledger.append("MTFX_PLAN_CREATED", now, plan, plan.id);
          if (this.iq1Authority) {
            if (!plan.iq1Context || plan.iq1Epoch !== this.r21ProcessEpoch) {
              plan.iq1Context = freezeIq1Context(plan, bundle.bars15m, this.iq1Authority.profile, Date.now());
              plan.iq1Epoch = this.r21ProcessEpoch;
              delete plan.iq1Anchor;
            }
            iq1Signals.push({plan,bundle});
          } else await this.evaluateSignal(plan, bundle.bars15m, now, decisionClock, bundle.bars1h);
        } else if (existing) {
          await this.expireUnconsumedEntryGate(existing, now);
          delete this.state.plans[symbol];
          await this.ledger.append(existing.intersectionTime < now ? "MTFX_PLAN_EXPIRED" : "MTFX_PLAN_INVALIDATED", now, {
            intersectionId: existing.id,
            symbol,
            committed: false,
          });
        }
        for (const [variant, book] of Object.entries(this.state.books)) {
          const bookConfig = this.runtime.books.find((candidate) => candidate.variant === variant);
          if (bookConfig?.entryEnabled !== true) continue;
          for (const position of [...book.openPositions].filter((item) => item.symbol === symbol)) {
            const currentBook = this.state.books[variant];
            const currentPosition = positionInBook(currentBook, position.id);
            if (!currentPosition || currentPosition.status !== "OPEN") continue;
            const trail = updateHourlyStructureTrail(currentPosition, bundle.bars1h, this.strategy);
            if (trail.changed) {
              await this.commitPositionStateTransition({
                variant,
                priorPosition: currentPosition,
                nextPosition: trail.position,
                bookAfter: currentBook,
                marketTime: now,
                source: "CONFIRMED_1H_STRUCTURE_TRAIL",
                evidence: {
                  confirmedAt: trail.position.lastTrailingStructureConfirmedAt,
                  priorStop: currentPosition.stop,
                  stop: trail.position.stop,
                },
                transitionEvents: [{
                  type: "RUNNER_TRAIL_UPDATED_1H",
                  priorStop: currentPosition.stop,
                  stop: trail.position.stop,
                  confirmedAt: trail.position.lastTrailingStructureConfirmedAt,
                }],
              });
            }
            const afterStructure = positionInBook(this.state.books[variant], currentPosition.id);
            if (!afterStructure) continue;
            const atrTrail = r21AtrTrail(afterStructure, bundle.bars15m, this.runtime.portfolioProfitProtection);
            if (!atrTrail.changed || Number(atrTrail.position.lastR21AtrTrailBarCloseTime) <= Number(afterStructure.lastR21AtrTrailBarCloseTime ?? 0)) continue;
            await this.commitPositionStateTransition({
              variant,
              priorPosition: afterStructure,
              nextPosition: atrTrail.position,
              bookAfter: this.state.books[variant],
              marketTime: now,
              source: "R21_CONFIRMED_15M_ATR_RUNNER_TRAIL",
              evidence: { priorStop: afterStructure.stop, stop: atrTrail.position.stop, ...atrTrail.position.r21AtrTrail },
              transitionEvents: [{ type: "R21_RUNNER_ATR_TRAIL_TIGHTENED", priorStop: afterStructure.stop, stop: atrTrail.position.stop }],
            });
          }
        }
        } catch (evaluationError) {
          errors.push({ symbol, message: evaluationError.message, at: now });
          await this.ledger.append("SYMBOL_SCAN_FAILED", now, { symbol, message: evaluationError.message });
        }
      }
      if (this.iq1Authority) {
        iq1Signals.sort((a,b) => compareIq1Candidates(this.iq1Rank(a,now),this.iq1Rank(b,now)));
        for (const {plan,bundle} of iq1Signals) {
          try { await this.evaluateSignal(plan,bundle.bars15m,now,decisionClock,bundle.bars1h); }
          catch (error) { errors.push({symbol:plan.symbol,message:error.message,at:now});
            await this.ledger.append("SYMBOL_SCAN_FAILED",now,{symbol:plan.symbol,message:error.message}); }
        }
        const payload={revision:IQ1_REVISION,profileDigest:this.iq1Authority.profileDigest,
          loadedAt:this.state.entryQualityRelease.loadedAt,processEpoch:this.r21ProcessEpoch,
          correlationValid:this.iq1Correlation.valid,correlationId:this.iq1Correlation.id??null,correlationEventId:this.iq1Correlation.eventId??null,
          candidates:iq1Signals.map(({plan})=>({id:plan.id,symbol:plan.symbol,
            contextReady:Boolean(plan.iq1Context),anchorReady:Boolean(plan.iq1Anchor),invalidation:plan.iq1Invalidation??null,
            status:plan.entryGateByBook?.["MTFX-T"]?.status??'WAITING_CONFIRMATION',
            executionReason:plan.entryGateByBook?.["MTFX-T"]?.lastExecutionReason??null,
            decision:plan.entryGateByBook?.["MTFX-T"]?.lastIq1Decision??null})),errors:errors.length};
        const rec=await this.ledger.append("MTFX_IQ1_CYCLE_EVALUATED",Date.now(),payload);
        this.state.entryQualityRelease={...this.state.entryQualityRelease,status:"ACTIVE_EVALUATING",
          lastCycleAt:Date.now(),lastCycleEventId:rec.eventId,correlationValid:this.iq1Correlation.valid};
      }
      this.state.scanErrors = errors.slice(-20);
      await this.refreshAbnormalLossGate({ now: Date.now(), reconciled: errors.length === 0 });
      if (errors.length === 0) this.state.lastSuccessfulScanAt = now;
      this.state.lifecycle = errors.length === this.symbols.length ? "DEGRADED_MARKET_DATA" : "ACTIVE_PAPER_SIMULATION";
      this.state.updatedAt = Date.now();
      await this.persist();
    });
  }

  async triggerScanCycle() {
    if (this.scanInFlight || this.stopping) return false;
    this.scanInFlight = true;
    try {
      await this.scanCycle();
      return true;
    } finally {
      this.scanInFlight = false;
    }
  }

  async refreshUniverse(now) {
    const selected = await this.market.selectUniverse();
    const held = Object.values(this.state.books).flatMap((book) => book.openPositions.map((position) => position.symbol));
    const next = [...new Set([...selected, ...held])];
    const changed = JSON.stringify(next) !== JSON.stringify(this.symbols);
    this.symbols = next;
    this.state.symbols = next;
    this.state.lastUniverseRefreshAt = now;
    this.tickSizes = await this.market.tickSizes(next);
    for (const symbol of Object.keys(this.state.plans)) {
      if (!next.includes(symbol)) delete this.state.plans[symbol];
    }
    await this.ledger.append("UNIVERSE_REFRESHED", now, {
      selected,
      carriedPositionSymbols: [...new Set(held)],
      changed,
      mandatorySymbols: this.runtime.venue.universe.mandatorySymbols,
    });
    if (changed && this.socket) this.socket.close(1000, "UNIVERSE_REFRESH");
  }

  async expireUnconsumedEntryGate(plan, now) {
    for (const [variant, book] of Object.entries(this.state.books)) {
      const bookConfig = this.runtime.books.find((candidate) => candidate.variant === variant);
      if (bookConfig?.entryEnabled !== true) continue;
      if (book.consumedIntersectionIds.includes(plan.id)) continue;
      const gate = plan.entryGateByBook?.[variant];
      if (!gate?.lockedPriceConfirmation) continue;
      const eventType = gate.lockedProtectiveStructure
        ? "MTFX_PROTECTIVE_ENTRY_WINDOW_EXPIRED"
        : "MTFX_PROTECTIVE_STRUCTURE_EXPIRED";
      gate.status = "EXPIRED";
      gate.expiredAt = now;
      consumeIntersection(book, plan.id);
      await this.ledger.append(eventType, now, {
        variant,
        intersectionId: plan.id,
        direction: gate.lockedPriceConfirmation.direction,
        directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
        stopReadyAt: gate.lockedProtectiveStructure?.evaluatedAt ?? null,
        lastStructureReason: gate.lastStructureReason ?? null,
        lastExecutionReason: gate.lastExecutionReason ?? null,
        reserveBarsObserved: gate.lastStructureReserveBarNumber ?? null,
      }, `${plan.id}_${variant}_${eventType}`);
    }
  }

  observeIq1Trade(symbol, data, receivedAt) {
    const epoch=this.r21ConnectionEpoch().id;
    const trade={symbol,price:Number(data.p),marketTime:Number(data.T),receivedAt,tradeId:data.t,epoch};
    const previous=this.iq1PreviousTrades.get(symbol);
    if (!Number.isFinite(trade.marketTime) || (previous?.epoch===epoch && trade.marketTime<previous.marketTime)) return;
    this.iq1PreviousTrades.set(symbol,trade);
    const plan=this.state.plans?.[symbol];
    if (plan?.iq1Context && plan.iq1Epoch===this.r21ProcessEpoch && trade.marketTime>=plan.intersectionTime &&
      trade.marketTime<=plan.intersectionTime+this.iq1Authority.profile.maximumCrossAgeMs && !plan.iq1Invalidation) {
      const p=this.iq1Authority.profile,c=plan.iq1Context;
      const gap=previous?.epoch!==epoch || !consecutiveIq1Trades(previous,trade);
      const far=Math.abs(trade.price/c.px-1)*10000>p.maximumPxBps || Math.abs(trade.price-c.px)/c.atr>p.maximumPxAtr;
      if(gap||far) {
        plan.iq1Invalidation={status:gap?'UNKNOWN':'REJECT',reason:gap?'IQ1_TRADE_CONTINUITY_GAP':'IQ1_POST_CROSS_OVEREXTENDED',marketTime:trade.marketTime,tradeId:trade.tradeId};
        const invalidation=structuredClone(plan.iq1Invalidation);
        this.queueMutation(()=>this.ledger.append('MTFX_IQ1_EVENT_INVALIDATED',trade.marketTime,
          {intersectionId:plan.id,symbol,...invalidation})).catch(error=>this.recordError('IQ1_INVALIDATION',error));
      }
    }
    if (!plan || plan.iq1Anchor?.epoch===epoch || this.iq1PendingAnchors.has(plan.id) ||
      trade.marketTime<plan.intersectionTime || trade.marketTime-plan.intersectionTime>this.iq1Authority.profile.maximumCrossAnchorDelayMs ||
      plan.intersectionTime<this.state.entryQualityRelease.loadedAt || plan.iq1Epoch!==this.r21ProcessEpoch) return;
    const anchor=iq1Anchor(plan.iq1Context,trade,previous,epoch,this.iq1Authority.profile);
    if (!anchor) return;
    this.iq1PendingAnchors.add(plan.id);
    this.queueMutation(async()=>{
      const current=this.state.plans[symbol];
      if(current?.id!==plan.id || this.r21ConnectionEpoch().id!==epoch) return;
      const record=await this.ledger.append('MTFX_IQ1_CROSS_ANCHOR',trade.marketTime,anchor,
        deterministicId('iq1anchor',{id:plan.id,epoch}));
      invariant(record?.eventId,'IQ1_ANCHOR_NOT_DURABLE');
      current.iq1Anchor={...record.payload,eventId:record.eventId};
    }).catch(error=>this.recordError('IQ1_ANCHOR',error));
  }

  iq1Rank({plan,bundle},now) {
    const quote=this.quote(plan.symbol), atr=plan.iq1Context?.atr;
    const state=signalForPlan({plan,bars15m:bundle.bars15m,now,signalPolicy:this.strategy.signal});
    const s=plan.entryGateByBook?.['MTFX-T']?.lockedPriceConfirmation?.direction??state.direction;
    const q=s===1?quote?.ask:quote?.bid;
    const fee=this.runtime.paperRisk.takerFeeRate, slip=this.runtime.paperRisk.adverseSlippageRate;
    const entry=q*(1+s*slip), stop=plan.intersectionPrice*(1-s*0.0005);
    const unitRisk=Math.abs(entry-stop)+entry*fee+stop*(fee+slip);
    return {symbol:plan.symbol,eventId:plan.id,pxAtr:atr>0?Math.abs(q-plan.intersectionPrice)/atr:Infinity,
      crossAgeMs:now-plan.intersectionTime,costR:entry*2*(fee+slip)/unitRisk,
      spreadBps:quote?(quote.ask/quote.bid-1)*10000:Infinity};
  }

  async recordIq1Decision(plan,gate,result,now) {
    const payload={...result,eventId:plan.id,symbol:plan.symbol,evaluatedAt:now,
      profileDigest:this.iq1Authority.profileDigest,loadEventId:this.state.entryQualityRelease.loadEventId};
    const record=await this.ledger.append('MTFX_IQ1_ENTRY_EVALUATED',now,payload);
    invariant(record?.eventId,'IQ1_DECISION_NOT_DURABLE');
    gate.lastIq1Decision={...payload,decisionEventId:record.eventId};
    if (!result.allowed) {
      gate.status=result.status==='REJECT'?'IQ1_REJECTED':`IQ1_${result.status}`;
      gate.lastExecutionReason=result.reason;
      if(result.terminal) for(const [,book] of this.activeBookEntries())consumeIntersection(book,plan.id);
    }
    return result.allowed;
  }

  async checkIq1Shape(plan,gate,signal,quote,bars,now,localNow) {
    const result=evaluateIq1Shape({plan,signal,quote,anchor:plan.iq1Anchor,profile:this.iq1Authority.profile,
      now,localNow,loadedAt:this.state.entryQualityRelease.loadedAt,epoch:this.r21ConnectionEpoch().id,bars,slippageRate:this.runtime.paperRisk.adverseSlippageRate});
    gate.iq1Shape=result;
    return this.recordIq1Decision(plan,gate,result,now);
  }

  iq1SizingRuntime(plan,book,replacementId=null) {
    if(!this.iq1Authority || !this.iq1Correlation?.valid)return this.runtime;
    const group=this.iq1Correlation.groups[plan.symbol],p=this.iq1Authority.profile;
    if(!group)return this.runtime;
    const peers=book.openPositions.filter(x=>x.id!==replacementId&&group.includes(x.symbol));
    const groupNotional=peers.reduce((v,x)=>v+x.entry*x.quantity,0);
    const groupRisk=peers.reduce((v,x)=>v+Math.max(0,x.plannedRiskUsdt),0);
    const allNotional=book.openPositions.reduce((v,x)=>v+x.entry*x.quantity,0);
    const riskBudget=Math.max(0,p.maximumGroupRiskFraction*book.equityUsdt-groupRisk);
    const notionalBudget=Math.max(0,p.maximumGroupNotionalLeverage*book.equityUsdt-groupNotional);
    return {...this.runtime,paperRisk:{...this.runtime.paperRisk,
      riskPerIntersectionFraction:Math.min(this.runtime.paperRisk.riskPerIntersectionFraction,riskBudget/book.equityUsdt),
      maximumLeverage:Math.min(this.runtime.paperRisk.maximumLeverage,(allNotional+notionalBudget)/book.equityUsdt)}};
  }

  async checkIq1Portfolio(plan,gate,candidate,now,localNow,replacementId=null) {
    const result=evaluateIq1Portfolio({candidate,positions:this.activeBookEntries().flatMap(([,b])=>b.openPositions),
      correlation:this.iq1Correlation,profile:this.iq1Authority.profile,
      equity:this.state.books[candidate.book].equityUsdt,now,localNow,replacementId});
    return this.recordIq1Decision(plan,gate,result,now);
  }

  async evaluateSignal(plan, bars15m, now, decisionClock = null, bars1h = null) {
    const decisionLocalTime = decisionClock ? Date.now() : now;
    if (decisionClock) {
      now = Number(decisionClock.marketTime) + Math.max(0, decisionLocalTime - Number(decisionClock.localTime));
    }
    for (const [variant, book] of Object.entries(this.state.books)) {
      const bookConfig = this.runtime.books.find((candidate) => candidate.variant === variant);
      if (bookConfig?.entryEnabled !== true) continue;
      if (book.consumedIntersectionIds.includes(plan.id) || this.entryBlockForBook(book).blocked) continue;
      const priorPosition = [...book.openPositions, ...book.closedPositions]
        .find((position) => position.intersectionId === plan.id);
      if (priorPosition) {
        consumeIntersection(book, plan.id);
        continue;
      }
      const reserveState = signalForPlan({ plan, bars15m, now, signalPolicy: this.strategy.signal });
      plan.entryGateByBook ??= {};
      let gate = plan.entryGateByBook[variant] ?? null;
      if (!gate?.lockedPriceConfirmation) {
        if (reserveState.reason === "CONFIRMATION_RESERVE_NOT_CLOSED" || reserveState.reason === "CONFIRMATION_RESERVE_OPEN") continue;
        if (!reserveState.accepted && reserveState.terminal === true) {
          consumeIntersection(book, plan.id);
          await this.ledger.append("MTFX_CONFIRMATION_RESERVE_EXPIRED", now, {
            variant,
            intersectionId: plan.id,
            reason: reserveState.reason,
            reserveBarsObserved: reserveState.reserveBarsObserved,
          }, `${plan.id}_${variant}_confirmation_reserve_expired`);
          continue;
        }
        if (!reserveState.accepted) continue;
        if (plan.createdAt > reserveState.patternBars[0].openTime) {
          consumeIntersection(book, plan.id);
          await this.ledger.append("MTFX_LOOKAHEAD_GUARD_REJECTED", now, {
            variant,
            intersectionId: plan.id,
          }, `${plan.id}_${variant}_lookahead_rejected`);
          continue;
        }
        gate = {
          status: "PRICE_LOCKED_WAITING_STRUCTURE",
          lockedPriceConfirmation: lockPriceConfirmation(reserveState, plan),
          lastStructureEvaluatedBarOpenTime: null,
          lastStructureReason: null,
          lockedProtectiveStructure: null,
        };
        plan.entryGateByBook[variant] = gate;
        await this.ledger.append("MTFX_PRICE_CONFIRMATION_LOCKED", now, {
          variant,
          intersectionId: plan.id,
          ...gate.lockedPriceConfirmation,
          patternBars: gate.lockedPriceConfirmation.patternBars.map((bar) => ({
            openTime: bar.openTime,
            closeTime: bar.closeTime,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
          })),
        }, `${plan.id}_${variant}_price_confirmation_locked`);
      }

      if (
        isR21EligibleSymbol(plan.symbol, this.runtime.portfolioProfitProtection) &&
        (this.state.r21ProfitProtection?.frozenDirections ?? []).includes(Number(gate.lockedPriceConfirmation.direction))
      ) {
        gate.status = "R21_SAME_DIRECTION_ENTRY_FROZEN";
        gate.lastExecutionReason = "R21_SAME_DIRECTION_ENTRY_FROZEN";
        continue;
      }

      const lockedSignal = signalFromLockedConfirmation(gate.lockedPriceConfirmation);
      const laterOpposite = reserveState.acceptedSignals?.find((candidate) =>
        candidate.bar.closeTime > gate.lockedPriceConfirmation.confirmedAt &&
        candidate.direction !== gate.lockedPriceConfirmation.direction
      );
      if (laterOpposite && !gate.oppositePriceAcceptanceObservedAt) {
        gate.oppositePriceAcceptanceObservedAt = laterOpposite.bar.closeTime;
        gate.oppositePriceAcceptanceDirection = laterOpposite.direction;
        await this.ledger.append("MTFX_OPPOSITE_PRICE_ACCEPTANCE_OBSERVED", now, {
          variant,
          intersectionId: plan.id,
          lockedDirection: gate.lockedPriceConfirmation.direction,
          observedDirection: laterOpposite.direction,
          observedAt: laterOpposite.bar.closeTime,
          executionUse: "OBSERVE_ONLY_DIRECTION_REMAINS_LOCKED",
        }, `${plan.id}_${variant}_opposite_price_acceptance_observed`);
      }

      if (!gate.lockedProtectiveStructure && this.strategy.stop?.initialStopMode === "INTERSECTION_BUFFER") {
        const stopPlan = intersectionBufferStop(
          gate.lockedPriceConfirmation.direction,
          plan.intersectionPrice,
          this.strategy.stop.intersectionBufferBps,
          lockedSignal.bar,
        );
        if (!stopPlan.accepted) {
          gate.status = "REJECTED";
          consumeIntersection(book, plan.id);
          await this.ledger.append("MTFX_PAPER_ENTRY_REJECTED", now, {
            variant,
            intersectionId: plan.id,
            reason: stopPlan.reason,
          }, `${plan.id}_${variant}_entry_rejected_${stopPlan.reason}`);
          continue;
        }
        gate.status = "INTERSECTION_BUFFER_STOP_READY_WAITING_BBO";
        gate.lockedProtectiveStructure = stopPlan;
        gate.lastStructureEvaluatedBarOpenTime = lockedSignal.bar.openTime;
        gate.lastStructureReserveBarNumber = 1;
        await this.ledger.append("MTFX_INTERSECTION_BUFFER_STOP_READY", now, {
          variant,
          intersectionId: plan.id,
          direction: gate.lockedPriceConfirmation.direction,
          directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
          reserveBarNumber: 1,
          ...stopPlan,
        }, `${plan.id}_${variant}_intersection_buffer_stop_ready`);
      }

      if (!gate.lockedProtectiveStructure) {
        const evaluationBars = (reserveState.reserveBars ?? []).filter((bar) =>
          bar.closeTime >= gate.lockedPriceConfirmation.confirmedAt &&
          bar.openTime > Number(gate.lastStructureEvaluatedBarOpenTime ?? -1)
        );
        for (const evaluationBar of evaluationBars) {
          const stopPlan = protectiveStructureAtCutoff({
            direction: gate.lockedPriceConfirmation.direction,
            bars15m,
            bars1h,
            strategy: this.strategy,
            cutoffBar: evaluationBar,
          });
          gate.lastStructureEvaluatedBarOpenTime = evaluationBar.openTime;
          gate.lastStructureReserveBarNumber = Math.round((evaluationBar.openTime - plan.lockedBarOpenTime) / 900000) + 1;
          gate.lastStructureReason = stopPlan.reason;
          if (stopPlan.accepted) {
            gate.status = "STRUCTURE_READY_WAITING_BBO";
            gate.lockedProtectiveStructure = stopPlan;
            await this.ledger.append("MTFX_PROTECTIVE_STRUCTURE_READY", now, {
              variant,
              intersectionId: plan.id,
              direction: gate.lockedPriceConfirmation.direction,
              directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
              reserveBarNumber: gate.lastStructureReserveBarNumber,
              ...stopPlan,
            }, `${plan.id}_${variant}_protective_structure_ready`);
            break;
          }
          if (!isDeferredProtectiveStructureReason(stopPlan.reason)) {
            gate.status = "REJECTED";
            consumeIntersection(book, plan.id);
            await this.ledger.append("MTFX_PAPER_ENTRY_REJECTED", now, {
              variant,
              intersectionId: plan.id,
              reason: stopPlan.reason,
              evaluationBarOpenTime: evaluationBar.openTime,
            }, `${plan.id}_${variant}_entry_rejected_${stopPlan.reason}`);
            break;
          }
          await this.ledger.append("MTFX_PROTECTIVE_STRUCTURE_WAITING", now, {
            variant,
            intersectionId: plan.id,
            direction: gate.lockedPriceConfirmation.direction,
            directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
            reserveBarNumber: gate.lastStructureReserveBarNumber,
            evaluationBarOpenTime: evaluationBar.openTime,
            reason: stopPlan.reason,
            availablePivotCount: stopPlan.availablePivotCount,
            availableOppositePivotCount: stopPlan.availableOppositePivotCount,
            progressionFractionOfWeakerProminence: stopPlan.progressionFractionOfWeakerProminence ?? null,
          }, `${plan.id}_${variant}_protective_structure_waiting_${evaluationBar.openTime}`);
        }
        if (book.consumedIntersectionIds.includes(plan.id)) continue;
        if (!gate.lockedProtectiveStructure) {
          if (reserveState.reserveComplete) {
            gate.status = "EXPIRED";
            gate.expiredAt = now;
            consumeIntersection(book, plan.id);
            await this.ledger.append("MTFX_PROTECTIVE_STRUCTURE_EXPIRED", now, {
              variant,
              intersectionId: plan.id,
              direction: gate.lockedPriceConfirmation.direction,
              directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
              reserveBarsObserved: reserveState.reserveBarsObserved,
              lastStructureReason: gate.lastStructureReason,
              lastExecutionReason: gate.lastExecutionReason ?? null,
            }, `${plan.id}_${variant}_protective_structure_expired`);
          }
          continue;
        }
      }

      const entryDecisionLocalTime = decisionClock ? Date.now() : decisionLocalTime;
      const entryDecisionMarketTime = decisionClock
        ? Number(decisionClock.marketTime) + Math.max(0, entryDecisionLocalTime - Number(decisionClock.localTime))
        : now;
      const entryQualityActive = ["MTFX-0.5.0-R18-ENTRY-QUALITY-GUARDS", "MTFX-0.5.0-R19-CONFIRMED-CLOSE-ENTRY-GUARD", "MTFX-0.5.0-R20-COST-EFFICIENCY-GATE", "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION", "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION"].includes(this.runtime.implementationRevision);
      const signalFreshness = entryQualityActive
        ? evaluateV2EntrySignalFreshness({
          gate,
          signalPolicy: this.strategy.signal,
          now: entryDecisionMarketTime,
        })
        : {
          allowed: true,
          signalExpiresAt: confirmationReserveDeadline(plan, this.strategy, this.runtime),
        };
      if (entryQualityActive) gate.lastEntryQualityGuard = signalFreshness;
      if (entryQualityActive && !signalFreshness.allowed) {
        gate.status = signalFreshness.terminal ? "EXPIRED" : "STRUCTURE_READY_WAITING_SIGNAL_TIME";
        gate.lastExecutionReason = signalFreshness.reason;
        if (signalFreshness.terminal) {
          gate.expiredAt = entryDecisionMarketTime;
          consumeIntersection(book, plan.id);
        }
        await this.ledger.append("MTFX_ENTRY_QUALITY_GUARD_BLOCKED", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          direction: gate.lockedPriceConfirmation.direction,
          ...signalFreshness,
        }, `${plan.id}_${variant}_entry_quality_${signalFreshness.reason}_${entryDecisionMarketTime}`);
        continue;
      }
      if (entryDecisionMarketTime > confirmationReserveDeadline(plan, this.strategy, this.runtime)) {
        await this.expireUnconsumedEntryGate(plan, entryDecisionMarketTime);
        continue;
      }
      const eventRisk = tier1EventWindowAt({
        now: entryDecisionMarketTime,
        policy: this.runtime.eventRisk,
        calendar: this.tier1EventCalendar,
      });
      if (eventRisk.active) {
        gate.status = "TIER1_EVENT_ENTRY_FROZEN";
        gate.lastExecutionReason = eventRisk.reason;
        gate.lastEventRiskWindow = {
          eventIds: eventRisk.eventIds,
          windowStart: eventRisk.windowStart,
          windowEnd: eventRisk.windowEnd,
        };
        await this.ledger.append("MTFX_TIER1_EVENT_ENTRY_FROZEN", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          direction: gate.lockedPriceConfirmation.direction,
          directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
          eventIds: eventRisk.eventIds,
          events: eventRisk.events.map((event) => ({ id: event.id, name: event.name, scheduledAt: event.scheduledAt, sourceUrl: event.sourceUrl })),
          windowStart: eventRisk.windowStart,
          windowEnd: eventRisk.windowEnd,
          existingPositions: "UNCHANGED",
          entryWindowExtended: false,
        }, `${plan.id}_${variant}_tier1_event_frozen_${eventRisk.eventIds.join("_")}`);
        continue;
      }
      const totalOpenPositions = totalOpenPositionCount(Object.fromEntries(this.runtime.books
        .filter((candidate) => candidate.entryEnabled === true)
        .map((candidate) => [candidate.variant, this.state.books[candidate.variant]])
        .filter(([, candidateBook]) => candidateBook)));
      if (totalOpenPositions >= this.runtime.paperRisk.maximumOpenPositionsTotal) {
        gate.status = "STRUCTURE_READY_WAITING_CAPACITY";
        gate.lastExecutionReason = "MAXIMUM_OPEN_POSITIONS_REACHED";
        await this.ledger.append("MTFX_SIGNAL_WAITING_FOR_CAPACITY", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          reason: gate.lastExecutionReason,
          openPositions: totalOpenPositions,
          maximumOpenPositionsTotal: this.runtime.paperRisk.maximumOpenPositionsTotal,
        }, `${plan.id}_${variant}_waiting_capacity_maximum_positions`);
        continue;
      }
      const deadline = Math.min(
        confirmationReserveDeadline(plan, this.strategy, this.runtime),
        signalFreshness.signalExpiresAt,
      );
      const stopReadyAt = gate.lockedProtectiveStructure.evaluatedAt;
      const quote = this.quote(plan.symbol);
      const bboTiming = validateEntryBboTiming({
        quote,
        stopReadyAt,
        deadline,
        decisionMarketTime: entryDecisionMarketTime,
        decisionLocalTime: entryDecisionLocalTime,
      });
      if (!bboTiming.accepted) {
        gate.status = "STRUCTURE_READY_WAITING_BBO";
        gate.lastExecutionReason = bboTiming.reason;
        await this.ledger.append("MTFX_SIGNAL_WAITING_FOR_BBO_COVERAGE", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          directionConfirmedAt: gate.lockedPriceConfirmation.confirmedAt,
          stopReadyAt,
          deadline,
          timingReason: bboTiming.reason,
          quoteMarketTime: quote?.marketTime ?? null,
          quoteReceivedAt: quote?.receivedAt ?? null,
        }, `${plan.id}_${variant}_waiting_bbo_after_stop_ready`);
        continue;
      }
      const entryQualityGuard = entryQualityActive
        ? evaluateV2EntryQualityGuard({
          plan,
          gate,
          quote,
          signalPolicy: this.strategy.signal,
          now: entryDecisionMarketTime,
        })
        : null;
      if (entryQualityActive) gate.lastEntryQualityGuard = entryQualityGuard;
      if (entryQualityActive && !entryQualityGuard.allowed) {
        gate.status = entryQualityGuard.terminal ? "EXPIRED" : "STRUCTURE_READY_WAITING_PRICE_REENTRY";
        gate.lastExecutionReason = entryQualityGuard.reason;
        if (entryQualityGuard.terminal) {
          gate.expiredAt = entryDecisionMarketTime;
          consumeIntersection(book, plan.id);
        }
        await this.ledger.append("MTFX_ENTRY_QUALITY_GUARD_BLOCKED", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          direction: gate.lockedPriceConfirmation.direction,
          bid: quote.bid,
          ask: quote.ask,
          ...entryQualityGuard,
        }, `${plan.id}_${variant}_entry_quality_${entryQualityGuard.reason}_${entryDecisionMarketTime}`);
        continue;
      }
      if (this.iq1Authority && !await this.checkIq1Shape(plan,gate,lockedSignal,quote,bars15m,
        entryDecisionMarketTime,entryDecisionLocalTime)) continue;
      let entryBook = book;
      let replacementPreview = null;
      let iq1Replaced = false;
      const sameSymbolPositions = Object.values(this.state.books)
        .flatMap((candidateBook) => candidateBook.openPositions ?? [])
        .filter((position) => position.status === "OPEN" && position.symbol === plan.symbol);
      if (sameSymbolPositions.length > 0) {
        const existingPosition = sameSymbolPositions.length === 1 ? sameSymbolPositions[0] : null;
        const replacement = existingPosition
          ? currentStructureReplacementEligibility({ plan, gate, existingPosition })
          : { accepted: false, reason: "MULTIPLE_SAME_SYMBOL_OPEN_POSITIONS" };
        if (!replacement.accepted) {
          gate.status = "REJECTED";
          gate.lastExecutionReason = replacement.reason ?? "SAME_SYMBOL_OPEN_POSITION_EXISTS";
          consumeIntersection(book, plan.id);
          await this.ledger.append("MTFX_SAME_SYMBOL_ENTRY_BLOCKED", entryDecisionMarketTime, {
            variant,
            intersectionId: plan.id,
            symbol: plan.symbol,
            proposedDirection: gate.lockedPriceConfirmation.direction,
            reason: gate.lastExecutionReason,
            existingPositions: sameSymbolPositions.map((position) => ({
              id: position.id,
              direction: position.direction,
              openedAt: position.openedAt,
              intersectionTime: position.intersectionTime,
              stage: position.stage,
              book: position.book,
            })),
            executionUse: "NO_NEW_POSITION_NO_REPLACEMENT",
          }, `${plan.id}_${variant}_same_symbol_open_position_exists_${gate.lastExecutionReason}`);
          continue;
        }
        // Verify the prospective new position against the book after the old
        // position has been removed before realizing any old-position P&L.
        // A failed replacement therefore leaves the old position untouched.
        const replacementBook = {
          ...book,
          openPositions: book.openPositions.filter((position) => position.id !== existingPosition.id),
        };
        replacementPreview = createPaperPosition({
          plan,
          signal: lockedSignal,
          quote,
          bars15m,
          bars1h,
          book: replacementBook,
          runtime: this.iq1SizingRuntime(plan,replacementBook),
          strategy: this.strategy,
          now: entryDecisionMarketTime,
          structureEvaluationBar: reserveState.reserveBars.find((bar) =>
            bar.openTime === gate.lockedProtectiveStructure.evaluationBarOpenTime
          ) ?? lockedSignal.bar,
          lockedProtectiveStructure: gate.lockedProtectiveStructure,
          entryQualityGuard,
        });
        if (replacementPreview.accepted && this.iq1Authority && !await this.checkIq1Portfolio(
          plan,gate,replacementPreview.position,entryDecisionMarketTime,entryDecisionLocalTime,existingPosition.id)) continue;
        if (replacementPreview.accepted) {
          await this.replaceWithConfirmedOppositeCurrentStructure({
            variant,
            priorPosition: existingPosition,
            plan,
            gate,
            quote,
            now: entryDecisionMarketTime,
          });
          entryBook = this.state.books[variant];
          if (this.iq1Authority) {
            // The prior preview is not an order. The next fresh scan/quote must
            // size and admit against the actual post-close book again.
            gate.iq1ReplacementClosedId = existingPosition.id;
            gate.status = "IQ1_REPLACEMENT_CLOSED_WAITING_FRESH_RECHECK";
            iq1Replaced = true;
          }
        }
      }
      if (iq1Replaced) continue;
      const result = replacementPreview ?? createPaperPosition({
        plan,
        signal: lockedSignal,
        quote,
        bars15m,
        bars1h,
        book: entryBook,
        runtime: this.iq1SizingRuntime(plan,entryBook),
        strategy: this.strategy,
        now: entryDecisionMarketTime,
        structureEvaluationBar: reserveState.reserveBars.find((bar) =>
          bar.openTime === gate.lockedProtectiveStructure.evaluationBarOpenTime
        ) ?? lockedSignal.bar,
        lockedProtectiveStructure: gate.lockedProtectiveStructure,
        entryQualityGuard,
      });
      if (!result.accepted) {
        if (["COMPLETE_LIFECYCLE_COST_EXCEEDS_0_12R", "V2_COST_EFFICIENCY_EVIDENCE_INVALID"].includes(result.reason)) {
          gate.status = "REJECTED";
          gate.lastExecutionReason = result.reason;
          gate.lastCostEfficiencyGuard = result.costEfficiencyGuard ?? null;
          consumeIntersection(book, plan.id);
          await this.ledger.append("MTFX_COST_EFFICIENCY_GUARD_BLOCKED", entryDecisionMarketTime, {
            variant,
            intersectionId: plan.id,
            symbol: plan.symbol,
            direction: gate.lockedPriceConfirmation.direction,
            reason: result.reason,
            ...(result.costEfficiencyGuard ?? {}),
          }, `${plan.id}_${variant}_cost_efficiency_${result.reason}`);
          continue;
        }
        if (["FIBONACCI_STOP_NOT_PROTECTIVE", "INTERSECTION_BUFFER_STOP_NOT_PROTECTIVE"].includes(result.reason)) {
          gate.status = "STRUCTURE_READY_WAITING_PROTECTIVE_BBO";
          gate.lastExecutionReason = result.reason;
          await this.ledger.append("MTFX_PROTECTIVE_ENTRY_WAITING_FOR_PRICE", entryDecisionMarketTime, {
            variant,
            intersectionId: plan.id,
            reason: result.reason,
            stop: gate.lockedProtectiveStructure.stop,
            bid: quote.bid,
            ask: quote.ask,
          }, `${plan.id}_${variant}_waiting_protective_bbo`);
          continue;
        }
        if (["PORTFOLIO_RISK_LIMIT_REACHED", "NON_POSITIVE_POSITION_SIZE"].includes(result.reason)) {
          gate.status = "STRUCTURE_READY_WAITING_CAPACITY";
          gate.lastExecutionReason = result.reason;
          await this.ledger.append("MTFX_SIGNAL_WAITING_FOR_CAPACITY", entryDecisionMarketTime, {
            variant,
            intersectionId: plan.id,
            reason: result.reason,
          }, `${plan.id}_${variant}_waiting_capacity_${result.reason}`);
          continue;
        }
        if (result.reason === "RETEST_QUEUE_UNKNOWN_OBSERVATION_ONLY") {
          book.observedRetests = [...book.observedRetests, { intersectionId: plan.id, symbol: plan.symbol, observedAt: now, status: result.reason }].slice(-500);
        }
        gate.status = "REJECTED";
        consumeIntersection(book, plan.id);
        await this.ledger.append("MTFX_PAPER_ENTRY_REJECTED", entryDecisionMarketTime, {
          variant,
          intersectionId: plan.id,
          reason: result.reason,
        }, `${plan.id}_${variant}_entry_rejected_${result.reason}`);
        continue;
      }
      if (this.iq1Authority) {
        if (!await this.checkIq1Portfolio(plan,gate,result.position,entryDecisionMarketTime,entryDecisionLocalTime)) continue;
        // Async ledger I/O can age a quote. Recheck the latest quote and state
        // before committing a new position; a changed quote retries next scan.
        const latest=this.quote(plan.symbol);
        const finalLocal=decisionClock?Date.now():entryDecisionLocalTime;
        const finalMarket=decisionClock?Number(decisionClock.marketTime)+Math.max(0,finalLocal-Number(decisionClock.localTime)):entryDecisionMarketTime;
        if (!latest || latest.bid!==quote.bid || latest.ask!==quote.ask || latest.marketTime!==quote.marketTime ||
          !evaluateV2EntryQualityGuard({plan,gate,quote:latest,signalPolicy:this.strategy.signal,now:finalMarket}).allowed ||
          !evaluateIq1Shape({plan,signal:lockedSignal,quote:latest,anchor:plan.iq1Anchor,
            profile:this.iq1Authority.profile,now:finalMarket,localNow:finalLocal,
            loadedAt:this.state.entryQualityRelease.loadedAt,epoch:this.r21ConnectionEpoch().id,bars:bars15m,slippageRate:this.runtime.paperRisk.adverseSlippageRate}).allowed ||
          tier1EventWindowAt({now:finalMarket,policy:this.runtime.eventRisk,calendar:this.tier1EventCalendar}).active || this.entryBlockForBook(entryBook).blocked) {
          gate.status="IQ1_WAITING_FRESH_SUBMISSION_RECHECK"; continue;
        }
        result.position.entryQualityRevision=IQ1_REVISION;
        result.position.entryQualityEvidence={profileDigest:this.iq1Authority.profileDigest,
          loadEventId:this.state.entryQualityRelease.loadEventId,anchorEventId:plan.iq1Anchor.eventId,
          decision:structuredClone(gate.lastIq1Decision),shape:structuredClone(gate.iq1Shape)};
      }
      const openRecord = await this.recordPaperPositionOpened(result.position, entryDecisionMarketTime);
      const canonicalPosition = openRecord.payload;
      gate.status = "OPENED";
      gate.openedPositionId = canonicalPosition.id;
      if (!entryBook.openPositions.some((position) => position.id === canonicalPosition.id)) {
        entryBook.openPositions = [...entryBook.openPositions, canonicalPosition];
      }
      consumeIntersection(entryBook, plan.id);
      await this.persist();
    }
  }

  async persist() {
    this.state.updatedAt = Date.now();
    await writeJsonAtomic(PATHS.state, this.state);
    await this.writeLatest();
  }

  liveMarkedPosition(position) {
    const quote = this.state.lastQuotes?.[position.symbol];
    const bid = Number(quote?.bid);
    const ask = Number(quote?.ask);
    if (!(bid > 0) || !(ask >= bid)) return position;
    return {
      ...position,
      lastBid: bid,
      lastAsk: ask,
      lastMarkedAt: Number(quote.receivedAt ?? quote.marketTime ?? position.lastMarkedAt ?? 0) || null,
    };
  }

  onlineSnapshot() {
    const sourceTime = this.state.heartbeatAt ?? this.state.updatedAt ?? Date.now();
    return {
      schemaVersion: 1,
      sourceAsOf: new Date(sourceTime).toISOString(),
      runtimeId: this.state.runtimeId,
      strategyVersion: this.state.strategyVersion,
      implementationRevision: this.state.implementationRevision,
      implementationDirectiveId: this.state.implementationDirectiveId,
      executionRelease: this.state.executionRelease ? structuredClone(this.state.executionRelease) : null,
      portfolioProtection: v2PortfolioProtectionSnapshot(this.state.r21ProfitProtection),
      entryQualityRelease: this.state.entryQualityRelease ?? null,
      authorizationId: this.state.authorizationId,
      paperRiskDirectiveId: this.state.paperRiskDirectiveId,
      lifecycle: this.state.lifecycle,
      symbols: this.symbols,
      plans: Object.values(this.state.plans).map((plan) => ({
        id: plan.id,
        symbol: plan.symbol,
        pattern: plan.pattern,
        intersectionTime: plan.intersectionTime,
        intersectionPrice: plan.intersectionPrice,
        intersectionWindowStart: plan.intersectionWindowStart,
        intersectionWindowEnd: plan.intersectionWindowEnd,
        lockedBarOpenTime: plan.lockedBarOpenTime,
        entryGateByBook: Object.fromEntries(Object.entries(plan.entryGateByBook ?? {})
          .filter(([variant]) => this.activeBookEntries().some(([activeVariant]) => activeVariant === variant))),
        fourHourLineStatus: plan.fourHourLineStatus,
        anchorQualityScore: plan.anchorQualityScore,
        anchorConsensus: plan.anchorConsensus ? {
          support: plan.anchorConsensus.support,
          stabilityScore: plan.anchorConsensus.stabilityScore,
          grade: plan.anchorConsensus.grade,
          timeWindowMinutes: plan.anchorConsensus.timeWindowMinutes,
          priceDispersionBps: plan.anchorConsensus.priceDispersionBps,
          perturbationSensitivityScore: plan.anchorConsensus.perturbationSensitivityScore,
        } : null,
        frozen: plan.frozen,
      })),
      books: Object.fromEntries(this.activeBookEntries().map(([variant, book]) => [variant, {
        initialEquityUsdt: book.initialEquityUsdt,
        equityUsdt: book.equityUsdt,
        realizedPnlUsdt: book.realizedPnlUsdt,
        dayRealizedPnlUsdt: book.dayRealizedPnlUsdt,
        performance: summarizeClosedBookPerformance(book.closedPositions),
        // This is a read-only live valuation. Canonical position snapshots
        // remain transition-only so BBO updates do not create audit noise.
        openPositions: book.openPositions.map((position) => this.liveMarkedPosition(position)),
        recentClosedPositions: book.closedPositions.slice(-20),
        // The chart must not inherit the recent-trades table's 20-row window.
        settlementHistory: book.closedPositions.map(({ id, openedAt, closedAt, netPnl }) => ({ id, openedAt, closedAt, netPnl })),
        settlementHistoryStartedAt: this.state.startedAt,
        newEntriesBlocked: this.entryBlockForBook(book).blocked,
        blockReason: this.entryBlockForBook(book).reason,
      }])),
      abnormalLossGate: this.state.abnormalLossGate,
      riskPolicy: {
        riskAllocationMode: this.runtime.paperRisk.riskAllocationMode,
        riskPerIntersectionFraction: this.runtime.paperRisk.riskPerIntersectionFraction,
        maximumPortfolioRiskFraction: this.runtime.paperRisk.maximumPortfolioRiskFraction,
        maximumOpenPositionsTotal: this.runtime.paperRisk.maximumOpenPositionsTotal,
        maximumLeverage: this.runtime.paperRisk.maximumLeverage,
        dailyRealizedLossStopEnabled: this.runtime.paperRisk.dailyRealizedLossStopEnabled,
        dailyRealizedLossStopFraction: this.runtime.paperRisk.dailyRealizedLossStopFraction,
      },
      trendCapture: Object.fromEntries(this.activeBookEntries().map(([variant, book]) => [
        variant,
        summarizeTrendCapture(book.closedPositions),
      ])),
      websocket: this.state.websocket,
      killSwitch: null,
      lastPositionBroadcast: this.state.lastPositionBroadcast,
      realOrdersAllowed: false,
      testnetOrdersAllowed: false,
      apiKeysAllowed: false,
    };
  }

  async publishOnlineLedger() {
    if (!this.runtime.onlineLedger.enabled || this.stopping || this.ledgerPublishInFlight) return;
    this.ledgerPublishInFlight = true;
    try {
      const token = String(process.env.MTFX_LEDGER_INGEST_TOKEN ?? "").trim();
      invariant(token.length >= 32, "ONLINE_LEDGER_TOKEN_MISSING_OR_SHORT");
      const sitesBypassToken = String(process.env.MTFX_SITES_BYPASS_TOKEN ?? "").trim();
      invariant(sitesBypassToken.length >= 32, "SITES_BYPASS_TOKEN_MISSING_OR_SHORT");
      const snapshot = this.onlineSnapshot();
      snapshot.killSwitch = await readJson(PATHS.killSwitch, null);
      const response = await fetch(this.runtime.onlineLedger.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        headers: {
          authorization: `Bearer ${token}`,
          "oai-sites-authorization": `Bearer ${sitesBypassToken}`,
          "content-type": "application/json",
          "user-agent": "orion-v2-mtfx-online-ledger/1.1",
        },
        body: JSON.stringify(snapshot),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`ONLINE_LEDGER_HTTP_${response.status}`);
      await this.queueMutation(async () => {
        this.state.onlineLedger = {
          status: "SYNCED",
          lastPublishedAt: Date.now(),
          lastReceivedAt: body.receivedAt ?? null,
          lastError: null,
        };
        await this.writeLatest();
      });
    } catch (error) {
      await this.queueMutation(async () => {
        this.state.onlineLedger = {
          ...this.state.onlineLedger,
          status: "DEGRADED",
          lastError: error.message,
        };
        await this.writeLatest();
      });
    } finally {
      this.ledgerPublishInFlight = false;
    }
  }

  async broadcastPositions(reason = "SCHEDULED_15M") {
    const now = Date.now();
    const books = Object.fromEntries(this.activeBookEntries().map(([variant, book]) => [variant, {
      equityUsdt: book.equityUsdt,
      realizedPnlUsdt: book.realizedPnlUsdt,
      openPositionCount: book.openPositions.length,
      positions: book.openPositions.map((position) => ({
        id: position.id,
        symbol: position.symbol,
        direction: position.direction === 1 ? "LONG" : "SHORT",
        entry: position.entry,
        stop: position.stop,
        target: position.target,
        stage: position.stage,
        remainingQuantity: position.quantity,
        originalQuantity: position.originalQuantity,
        plannedRiskUsdt: position.plannedRiskUsdt,
        lastBid: position.lastBid,
        lastAsk: position.lastAsk,
      })),
      newEntriesBlocked: this.entryBlockForBook(book).blocked,
      blockReason: this.entryBlockForBook(book).reason,
    }]));
    const broadcast = {
      schemaVersion: 1,
      type: "MTFX_POSITION_BROADCAST",
      reason,
      generatedAt: new Date(now).toISOString(),
      lifecycle: this.state.lifecycle,
      strategyVersion: this.state.strategyVersion,
      implementationRevision: this.state.implementationRevision,
      abnormalLossGate: this.state.abnormalLossGate,
      books,
      trendCapture: Object.fromEntries(this.activeBookEntries().map(([variant, book]) => [
        variant,
        summarizeTrendCapture(book.closedPositions),
      ])),
      planCount: Object.keys(this.state.plans).length,
      websocketConnected: this.state.websocket.connected,
      realOrdersAllowed: false,
    };
    this.state.lastPositionBroadcast = broadcast;
    await appendLine(PATHS.positionBroadcasts, JSON.stringify(broadcast));
    await this.ledger.append("POSITION_BROADCAST", now, broadcast);
    await this.persist();
  }

  async writeLatest() {
    const books = Object.fromEntries(this.activeBookEntries().map(([variant, book]) => [variant, {
      equityUsdt: book.equityUsdt,
      realizedPnlUsdt: book.realizedPnlUsdt,
      openPositions: book.openPositions.length,
      closedPositions: book.closedPositions.length,
      newEntriesBlocked: this.entryBlockForBook(book).blocked,
      blockReason: this.entryBlockForBook(book).reason,
    }]));
    await writeJsonAtomic(PATHS.latest, {
      schemaVersion: 1,
      runtimeId: this.state.runtimeId,
      strategyVersion: this.state.strategyVersion,
      implementationRevision: this.state.implementationRevision,
      implementationDirectiveId: this.state.implementationDirectiveId,
      authorizationId: this.state.authorizationId,
      paperRiskDirectiveId: this.state.paperRiskDirectiveId,
      lifecycle: this.state.lifecycle,
      heartbeatAt: this.state.heartbeatAt,
      lastScanAt: this.state.lastScanAt,
      lastSuccessfulScanAt: this.state.lastSuccessfulScanAt,
      symbols: this.symbols,
      plans: Object.values(this.state.plans).map((plan) => ({
        id: plan.id,
        symbol: plan.symbol,
        pattern: plan.pattern,
        intersectionTime: plan.intersectionTime,
        intersectionPrice: plan.intersectionPrice,
        intersectionWindowStart: plan.intersectionWindowStart,
        intersectionWindowEnd: plan.intersectionWindowEnd,
        lockedBarOpenTime: plan.lockedBarOpenTime,
        fourHourLineStatus: plan.fourHourLineStatus,
        anchorQualityScore: plan.anchorQualityScore,
        anchorConsensus: plan.anchorConsensus ? {
          support: plan.anchorConsensus.support,
          stabilityScore: plan.anchorConsensus.stabilityScore,
          grade: plan.anchorConsensus.grade,
          timeWindowMinutes: plan.anchorConsensus.timeWindowMinutes,
          priceDispersionBps: plan.anchorConsensus.priceDispersionBps,
          perturbationSensitivityScore: plan.anchorConsensus.perturbationSensitivityScore,
        } : null,
        frozen: plan.frozen,
      })),
      books,
      abnormalLossGate: this.state.abnormalLossGate,
      websocket: this.state.websocket,
      onlineLedger: this.state.onlineLedger,
      lastPositionBroadcast: this.state.lastPositionBroadcast,
      realOrdersAllowed: false,
      generatedAt: Date.now(),
    });
  }

  async recordError(scope, error) {
    const now = Date.now();
    await this.queueMutation(async () => {
      this.state.scanErrors = [...this.state.scanErrors, { scope, message: error.message, at: now }].slice(-20);
      await this.ledger.append("RUNTIME_ERROR", now, { scope, message: error.message });
      await this.persist();
    });
  }

  async heartbeat() {
    await this.queueMutation(async () => {
      const killSwitch = await readJson(PATHS.killSwitch, null);
      if (killSwitch?.engaged && !this.stopping) {
        await this.shutdown(`KILL_SWITCH_${killSwitch.reason ?? "ENGAGED"}`);
        return;
      }
      this.state.heartbeatAt = Date.now();
      await this.writeLatest();
    });
  }

  async engageKillSwitch(reason) {
    await writeJsonAtomic(PATHS.killSwitch, {
      schemaVersion: 1,
      engaged: true,
      reason,
      changedAt: new Date().toISOString(),
      changedBy: "ORION_V2_MTFX_PAPER_RUNTIME",
      authorizationId: this.runtime.authorizationId,
    });
  }

  async shutdown(reason) {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.websocketWatchdogTimer) clearInterval(this.websocketWatchdogTimer);
    try { this.socket?.close(1000, reason.slice(0, 120)); } catch {}
    const now = Date.now();
    for (const symbol of this.symbols) {
      let quote = this.quote(symbol);
      if (!quote && this.hasOpenPosition(symbol)) {
        try {
          const fallback = await this.market.bookTicker(symbol);
          quote = { ...fallback, tickSize: this.tickSizes[symbol], coverageComplete: false };
        } catch {}
      }
      if (quote) await this.managePositions(symbol, quote, now, `ADMINISTRATIVE_${reason}`);
    }
    this.state.lifecycle = "STOPPED_BY_KILL_SWITCH";
    this.state.websocket.connected = false;
    this.state.websocket.lastEventAt = now;
    this.state.heartbeatAt = now;
    await this.ledger.append("DAEMON_STOPPED", now, { reason });
    await this.persist();
  }

  async prepareRecoveryRestart(reason) {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.websocketWatchdogTimer) clearInterval(this.websocketWatchdogTimer);
    try { this.socket?.close(1000, reason.slice(0, 120)); } catch {}
    const now = Date.now();
    const affectedPositionIds = Object.values(this.state.books)
      .flatMap((book) => book.openPositions)
      .filter((position) => position.status === "OPEN")
      .map((position) => position.id);
    this.state.lifecycle = "RECOVERY_RESTART_PENDING";
    this.state.websocket.connected = false;
    this.state.websocket.lastEventAt = now;
    if (this.hasOpenPosition()) {
      this.state.websocket.gapDetected = true;
      for (const book of Object.values(this.state.books)) {
        book.openPositions = book.openPositions.map((position) => applyFailClosedPositionEvidence(position, "RECOVERY_GAP"));
      }
    }
    this.state.heartbeatAt = now;
    await this.ledger.append("DAEMON_RECOVERY_RESTART_REQUESTED", now, {
      reason,
      positionsPreserved: true,
      affectedPositionIds,
      gapEvidence: "RECOVERY_GAP",
    });
    await this.persist();
  }

  async run() {
    await this.initialize();
    this.connectWebsocket();
    await this.triggerScanCycle();
    await this.broadcastPositions("STARTUP");
    await this.publishOnlineLedger();
    const scanTimer = setInterval(() => this.triggerScanCycle().catch((error) => this.recordError("SCAN", error)), this.runtime.marketData.scanIntervalMs);
    const heartbeatTimer = setInterval(() => this.heartbeat().catch((error) => this.recordError("HEARTBEAT", error)), this.runtime.marketData.heartbeatMs);
    const ledgerTimer = setInterval(() => this.publishOnlineLedger().catch((error) => this.recordError("ONLINE_LEDGER", error)), this.runtime.onlineLedger.publishIntervalMs);
    const broadcastTimer = setInterval(() => this.queueMutation(() => this.broadcastPositions()).catch((error) => this.recordError("POSITION_BROADCAST", error)), this.runtime.onlineLedger.broadcastIntervalMs);
    this.websocketWatchdogTimer = setInterval(() => this.selfHealStaleWebsocket(), 5_000);
    this.websocketWatchdogTimer.unref?.();
    const stop = async (signal) => {
      clearInterval(scanTimer);
      clearInterval(heartbeatTimer);
      clearInterval(ledgerTimer);
      clearInterval(broadcastTimer);
      await this.queueMutation(() => this.shutdown(`OWNER_PROCESS_${signal}`));
      process.exit(0);
    };
    const recover = async () => {
      clearInterval(scanTimer);
      clearInterval(heartbeatTimer);
      clearInterval(ledgerTimer);
      clearInterval(broadcastTimer);
      await this.queueMutation(() => this.prepareRecoveryRestart("HEALTH_SUPERVISOR_SIGUSR2"));
      process.exit(0);
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGUSR2", () => recover());
  }
}

export { PATHS, PROJECT_ROOT, RUNTIME_ROOT };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const authority = await loadAndValidateAuthority();
  const daemon = new MtfxPaperDaemon(authority);
  await daemon.run();
}
