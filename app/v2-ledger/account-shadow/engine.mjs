import { advanceRollingAccount, validateRollingAccount } from "./rolling.mjs";

export const ACCOUNT_SHADOW_POLICY = Object.freeze({
  schemaVersion: 5,
  policyRevision: "ORION-V2-ACCOUNT-EQUITY-LOCK-SHADOW-POLICY-5",
  experimentId: "ORION-V2-R22-ACCOUNT-EQUITY-LOCK-SHADOW-20260905",
  authorizationId: "OWNER-DIRECTIVE-ORION-V2-ACCOUNT-EQUITY-LOCK-SHADOW-20260905",
  runtimeId: "ORION-V2-MTFX-PAPER-1.1",
  bookId: "MTFX-T",
  baselineImplementationRevision: "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION",
  status: "ACTIVE_OBSERVE_ONLY",
  timeZone: "Asia/Shanghai",
  dayBoundary: "00:00_ASIA_SHANGHAI_FIRST_VALID_SNAPSHOT",
  highWaterConfirmationMs: 30_000,
  maximumQuoteAgeMs: 1_000,
  maximumQuoteSkewMs: 250,
  maximumFutureQuoteSkewMs: 1_000,
  maximumTransportLagMs: 20_000,
  maximumObservationGapMs: 45_000,
  takerFeeRate: 0.0007,
  adverseSlippageRate: 0.0002,
  historySampleIntervalMs: 5 * 60_000,
  historyLimit: 288,
  completedCampaignLimit: 64,
  minimumEligibleCompletedCampaigns: 20,
  requiredGivebackReductionFraction: 0.3,
  minimumNetOutcomeRetentionFraction: 0.95,
  minimumTrendGainRetentionFraction: 0.8,
  stressLockIncrementFraction: 0.05,
  maximumLockFraction: 0.8,
  valuationScope: "INDICATIVE_PRICE_SIDE_ONLY_NO_ORDER_BOOK_DEPTH",
  tiers: Object.freeze([
    Object.freeze({ id: "T0", minimumPeakProfitFraction: 0, lockFraction: 0, runnerFraction: 1 }),
    Object.freeze({ id: "T1", minimumPeakProfitFraction: 0.01, lockFraction: 0.5, runnerFraction: 0.5 }),
    Object.freeze({ id: "T2", minimumPeakProfitFraction: 0.02, lockFraction: 0.65, runnerFraction: 0.35 }),
    Object.freeze({ id: "T3", minimumPeakProfitFraction: 0.03, lockFraction: 0.7, runnerFraction: 0.3 }),
    Object.freeze({ id: "T4", minimumPeakProfitFraction: 0.05, lockFraction: 0.75, runnerFraction: 0.25 }),
  ]),
});

const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value, digits = 8) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;

function cstDayKey(timestamp) {
  return new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function canonicalBook(snapshot) {
  return snapshot?.books?.[ACCOUNT_SHADOW_POLICY.bookId] ?? null;
}

function fingerprintText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function frameFingerprint(positions, realizedEquity, sourceAsOf) {
  const evidence = positions
    .map((position) => [position?.id, position?.symbol, position?.lastBid, position?.lastAsk, position?.lastMarkedAt])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const value = positions.length ? evidence : [["NO_OPEN_POSITIONS", realizedEquity, sourceAsOf]];
  return `${positions.length}:${fingerprintText(JSON.stringify(value))}`;
}

function continuityEpoch(snapshot) {
  return {
    reconnects: nonNegativeInteger(snapshot?.websocket?.reconnects),
    selfHeals: nonNegativeInteger(snapshot?.websocket?.selfHeals),
    connectedAt: finite(snapshot?.websocket?.connectedAt),
  };
}

function continuityEpochComplete(epoch) {
  return epoch.reconnects != null && epoch.selfHeals != null && epoch.connectedAt != null;
}

function continuityEpochChanged(previous, next) {
  return continuityEpochComplete(previous ?? {}) && continuityEpochComplete(next ?? {}) && (
    previous.reconnects !== next.reconnects ||
    previous.selfHeals !== next.selfHeals ||
    previous.connectedAt !== next.connectedAt
  );
}

function markingCosts() {
  return {
    takerFeeRate: ACCOUNT_SHADOW_POLICY.takerFeeRate,
    adverseSlippageRate: ACCOUNT_SHADOW_POLICY.adverseSlippageRate,
  };
}

function positionNetPnl(position, costs, mode) {
  const direction = finite(position?.direction);
  const entry = finite(position?.entry);
  const quantity = finite(position?.quantity);
  const bid = finite(position?.lastBid);
  const ask = finite(position?.lastAsk);
  const stop = finite(position?.stop);
  const originalQuantity = finite(position?.originalQuantity);
  const entryFee = finite(position?.entryFee);
  if (typeof position?.id !== "string" || position.id.length === 0 || typeof position?.symbol !== "string" || position.symbol.length === 0) return null;
  if ((direction !== 1 && direction !== -1) || !(entry > 0) || !(quantity > 0) || !(originalQuantity > 0) || originalQuantity < quantity || entryFee == null || entryFee < 0 || !(bid > 0) || !(ask >= bid)) return null;

  let reference = direction === 1 ? bid : ask;
  if (mode === "STOP") {
    if (!(stop > 0)) return null;
    reference = direction === 1 ? Math.min(stop, bid) : Math.max(stop, ask);
  }
  const estimatedExit = reference * (direction === 1 ? 1 - costs.adverseSlippageRate : 1 + costs.adverseSlippageRate);
  const remainingEntryFee = entryFee * (originalQuantity > 0 ? quantity / originalQuantity : 1);
  const exitFee = estimatedExit * quantity * costs.takerFeeRate;
  return direction * (estimatedExit - entry) * quantity - remainingEntryFee - exitFee;
}

export function deriveAccountObservation(snapshot, observedAtMs = Date.now()) {
  if (snapshot?.runtimeId !== ACCOUNT_SHADOW_POLICY.runtimeId) throw new Error("ACCOUNT_SHADOW_RUNTIME_INVALID");
  if (snapshot?.implementationRevision !== ACCOUNT_SHADOW_POLICY.baselineImplementationRevision) throw new Error("ACCOUNT_SHADOW_BASELINE_REVISION_INVALID");
  const book = canonicalBook(snapshot);
  const sourceMs = Date.parse(String(snapshot?.sourceAsOf ?? ""));
  if (!book || !Number.isFinite(sourceMs)) throw new Error("ACCOUNT_SHADOW_SNAPSHOT_INVALID");
  const realizedEquity = finite(book.equityUsdt);
  if (!(realizedEquity > 0)) throw new Error("ACCOUNT_SHADOW_BOOK_EQUITY_INVALID");

  const positionsArrayValid = Array.isArray(book.openPositions);
  const positions = positionsArrayValid ? book.openPositions : [];
  const costs = markingCosts();
  const currentPnls = positions.map((position) => positionNetPnl(position, costs, "CURRENT"));
  const stopPnls = positions.map((position) => positionNetPnl(position, costs, "STOP"));
  const positionIds = positions.map((position) => position?.id);
  const valuationsComplete = positionsArrayValid && currentPnls.every(Number.isFinite) && stopPnls.every(Number.isFinite)
    && new Set(positionIds).size === positionIds.length;
  const markedAt = positions.map((position) => finite(position?.lastMarkedAt)).filter(Number.isFinite);
  const quoteTimesComplete = positions.length === 0 || markedAt.length === positions.length;
  const newestQuoteAt = markedAt.length ? Math.max(...markedAt) : sourceMs;
  const oldestQuoteAt = markedAt.length ? Math.min(...markedAt) : sourceMs;
  const lastEventAt = finite(snapshot?.websocket?.lastEventAt);
  const epoch = continuityEpoch(snapshot);
  const evidenceReferenceAt = Math.max(sourceMs, newestQuoteAt, lastEventAt ?? sourceMs);
  const epochComplete = continuityEpochComplete(epoch)
    && lastEventAt != null
    && lastEventAt >= epoch.connectedAt
    && epoch.connectedAt <= evidenceReferenceAt
    && epoch.connectedAt <= observedAtMs + ACCOUNT_SHADOW_POLICY.maximumFutureQuoteSkewMs
    && (positions.length === 0 || markedAt.every((timestamp) => timestamp >= epoch.connectedAt));
  const maximumQuoteAgeMs = positions.length ? Math.max(0, evidenceReferenceAt - oldestQuoteAt) : 0;
  const futureQuoteSkewMs = Math.max(0, evidenceReferenceAt - observedAtMs);
  const quoteSkewMs = Math.max(0, newestQuoteAt - oldestQuoteAt);
  const transportLagMs = Math.max(0, observedAtMs - evidenceReferenceAt);
  const transportClockValid = observedAtMs >= sourceMs;
  const websocketConnected = snapshot?.websocket?.connected === true;
  const liveEvidenceAccepted = valuationsComplete && quoteTimesComplete && epochComplete && websocketConnected
    && transportClockValid
    && maximumQuoteAgeMs <= ACCOUNT_SHADOW_POLICY.maximumQuoteAgeMs
    && futureQuoteSkewMs <= ACCOUNT_SHADOW_POLICY.maximumFutureQuoteSkewMs
    && quoteSkewMs <= ACCOUNT_SHADOW_POLICY.maximumQuoteSkewMs
    && transportLagMs <= ACCOUNT_SHADOW_POLICY.maximumTransportLagMs;
  const recoveryGapPositions = positions.filter((position) => position?.bboCoverageComplete !== true || position?.executionEvidence !== "BBO_CAPTURED").length;

  let status = "PRICE_SIDE_EVIDENCE_ACCEPTED";
  if (!websocketConnected) status = "WEBSOCKET_DISCONNECTED";
  else if (!valuationsComplete) status = "VALUATION_INCOMPLETE";
  else if (!quoteTimesComplete) status = "QUOTE_TIME_INCOMPLETE";
  else if (!epochComplete) status = "CONTINUITY_EPOCH_INCOMPLETE";
  else if (!transportClockValid) status = "SOURCE_TIME_IN_FUTURE";
  else if (transportLagMs > ACCOUNT_SHADOW_POLICY.maximumTransportLagMs) status = "TRANSPORT_STALE";
  else if (futureQuoteSkewMs > ACCOUNT_SHADOW_POLICY.maximumFutureQuoteSkewMs) status = "QUOTE_TIME_IN_FUTURE";
  else if (maximumQuoteAgeMs > ACCOUNT_SHADOW_POLICY.maximumQuoteAgeMs) status = "QUOTE_STALE";
  else if (quoteSkewMs > ACCOUNT_SHADOW_POLICY.maximumQuoteSkewMs) status = "QUOTE_SKEW_EXCEEDED";

  const unrealizedNetPnl = valuationsComplete ? currentPnls.reduce((sum, value) => sum + value, 0) : null;
  const stressStopNetPnl = valuationsComplete ? stopPnls.reduce((sum, value) => sum + value, 0) : null;
  return {
    sourceAsOf: new Date(sourceMs).toISOString(),
    sourceMs,
    dayKey: cstDayKey(sourceMs),
    frameFingerprint: frameFingerprint(positions, realizedEquity, new Date(sourceMs).toISOString()),
    actualMarkedEquityUsdt: unrealizedNetPnl == null ? null : round(realizedEquity + unrealizedNetPnl),
    realizedEquityUsdt: round(realizedEquity),
    unrealizedNetPnlUsdt: round(unrealizedNetPnl),
    actualStressStopEquityUsdt: stressStopNetPnl == null ? null : round(realizedEquity + stressStopNetPnl),
    positionCount: positions.length,
    continuityEpoch: epoch,
    evidence: {
      status,
      liveEvidenceAccepted,
      analysisEligible: liveEvidenceAccepted,
      validationEligible: liveEvidenceAccepted && recoveryGapPositions === 0,
      promotionEligible: false,
      valuationScope: ACCOUNT_SHADOW_POLICY.valuationScope,
      websocketConnected,
      continuityEpochComplete: epochComplete,
      historicalGapDetected: snapshot?.websocket?.gapDetected === true,
      recoveryGapPositions,
      quoteTimesComplete,
      valuationsComplete,
      oldestQuoteAt: markedAt.length ? oldestQuoteAt : null,
      newestQuoteAt: markedAt.length ? newestQuoteAt : null,
      evidenceReferenceAt,
      maximumQuoteAgeMs: round(maximumQuoteAgeMs, 3),
      futureQuoteSkewMs: round(futureQuoteSkewMs, 3),
      quoteSkewMs: round(quoteSkewMs, 3),
      transportLagMs: round(transportLagMs, 3),
      fundingAccrued: false,
      depthModeled: false,
      limitations: [
        "FUNDING_NOT_ACCRUED",
        "ORDER_BOOK_DEPTH_NOT_MODELED",
        "BBO_SIZE_EVENT_TIME_AND_UPDATE_ID_NOT_PUBLISHED",
        "SNAPSHOT_CAPTURE_TIME_NOT_PUBLISHED_COMPOSITE_REFERENCE_USED",
        ...(snapshot?.websocket?.gapDetected === true ? ["HISTORICAL_CAPTURE_GAP"] : []),
        ...(recoveryGapPositions > 0 ? ["RECOVERY_GAP_POSITIONS_EXCLUDED_FROM_VALIDATION"] : []),
      ],
    },
  };
}

function tierFor(peakProfitFraction) {
  let selected = ACCOUNT_SHADOW_POLICY.tiers[0];
  for (const tier of ACCOUNT_SHADOW_POLICY.tiers) {
    if (peakProfitFraction >= tier.minimumPeakProfitFraction) selected = tier;
  }
  return selected;
}

function compactObservation(state) {
  const current = state.current;
  return {
    sourceAsOf: state.sourceAsOf,
    actualMarkedEquityUsdt: current.actualMarkedEquityUsdt,
    shadowMarkedEquityUsdt: current.shadowMarkedEquityUsdt,
    confirmedHighWaterUsdt: current.confirmedHighWaterUsdt,
    protectionFloorUsdt: current.protectionFloorUsdt,
    shadowStressStopEquityUsdt: current.shadowStressStopEquityUsdt,
    effectiveExposureFraction: current.effectiveExposureFraction,
    action: current.action,
    evidenceStatus: state.evidence.status,
  };
}

function addObservation(state, force = false) {
  const next = compactObservation(state);
  const history = Array.isArray(state.observations) ? state.observations : [];
  const previous = history.at(-1);
  const elapsed = previous ? Date.parse(next.sourceAsOf) - Date.parse(previous.sourceAsOf) : Number.POSITIVE_INFINITY;
  if (!force && elapsed < ACCOUNT_SHADOW_POLICY.historySampleIntervalMs && previous?.action === next.action && previous?.evidenceStatus === next.evidenceStatus) return;
  state.observations = [...history, next].slice(-ACCOUNT_SHADOW_POLICY.historyLimit);
}

function startCampaign(state, observation, tier, effectiveLockFraction) {
  const current = state.current;
  state.activeCampaign = {
    id: `${ACCOUNT_SHADOW_POLICY.experimentId}:${observation.dayKey}:${observation.sourceMs}`,
    dayKey: observation.dayKey,
    activatedAt: observation.sourceAsOf,
    completedAt: null,
    startActualEquityUsdt: current.actualMarkedEquityUsdt,
    startShadowEquityUsdt: current.shadowMarkedEquityUsdt,
    peakActualEquityUsdt: current.actualMarkedEquityUsdt,
    peakShadowEquityUsdt: current.shadowMarkedEquityUsdt,
    endActualEquityUsdt: null,
    endShadowEquityUsdt: null,
    maximumLockFraction: effectiveLockFraction,
    minimumRunnerFraction: tier.runnerFraction,
    interventionAt: null,
    interventionAction: null,
    evidenceEligible: state.dayEvidenceExclusions.length === 0,
    promotionEligible: observation.evidence.promotionEligible,
    exclusionReasons: [...state.dayEvidenceExclusions],
  };
  state.validation.activatedCampaignCount += 1;
}

function updateCampaign(state, observation, tier, effectiveLockFraction) {
  const campaign = state.activeCampaign;
  if (!campaign) return;
  if (Number.isFinite(state.current.actualMarkedEquityUsdt)) campaign.peakActualEquityUsdt = Math.max(campaign.peakActualEquityUsdt, state.current.actualMarkedEquityUsdt);
  if (Number.isFinite(state.current.shadowMarkedEquityUsdt)) campaign.peakShadowEquityUsdt = Math.max(campaign.peakShadowEquityUsdt, state.current.shadowMarkedEquityUsdt);
  campaign.maximumLockFraction = Math.max(campaign.maximumLockFraction, effectiveLockFraction);
  campaign.minimumRunnerFraction = Math.min(campaign.minimumRunnerFraction, tier.runnerFraction);
  campaign.promotionEligible = campaign.promotionEligible && observation.evidence.promotionEligible;
  if (!observation.evidence.validationEligible) {
    campaign.evidenceEligible = false;
    campaign.exclusionReasons = [...new Set([...campaign.exclusionReasons, ...observation.evidence.limitations, observation.evidence.status])];
  }
  if (state.dayEvidenceExclusions?.length) {
    campaign.evidenceEligible = false;
    campaign.exclusionReasons = [...new Set([...campaign.exclusionReasons, ...state.dayEvidenceExclusions])];
  }
}

function dayExclusions(previous, evidence) {
  return [...new Set([...previous, ...(evidence.validationEligible ? [] : [...evidence.limitations, evidence.status])])];
}

function finishCampaign(state, completedAt) {
  const campaign = state.activeCampaign;
  if (!campaign) return;
  campaign.completedAt = completedAt;
  campaign.endActualEquityUsdt = state.current.actualMarkedEquityUsdt;
  campaign.endShadowEquityUsdt = state.current.shadowMarkedEquityUsdt;
  campaign.actualGivebackUsdt = round(Math.max(0, campaign.peakActualEquityUsdt - campaign.endActualEquityUsdt));
  campaign.shadowGivebackUsdt = round(Math.max(0, campaign.peakShadowEquityUsdt - campaign.endShadowEquityUsdt));
  campaign.actualNetOutcomeUsdt = round(campaign.endActualEquityUsdt - campaign.startActualEquityUsdt);
  campaign.shadowNetOutcomeUsdt = round(campaign.endShadowEquityUsdt - campaign.startShadowEquityUsdt);
  campaign.actualTrendGainUsdt = round(Math.max(0, campaign.peakActualEquityUsdt - campaign.startActualEquityUsdt));
  campaign.shadowTrendGainUsdt = round(Math.max(0, campaign.peakShadowEquityUsdt - campaign.startShadowEquityUsdt));
  state.completedCampaigns = [...(state.completedCampaigns ?? []), campaign].slice(-ACCOUNT_SHADOW_POLICY.completedCampaignLimit);
  state.activeCampaign = null;
}

function summarizeValidation(state) {
  const completed = state.completedCampaigns ?? [];
  const eligible = completed.filter((campaign) => campaign.evidenceEligible);
  const sum = (field) => eligible.reduce((total, campaign) => total + (finite(campaign[field]) ?? 0), 0);
  const actualGiveback = sum("actualGivebackUsdt");
  const shadowGiveback = sum("shadowGivebackUsdt");
  const actualNet = sum("actualNetOutcomeUsdt");
  const shadowNet = sum("shadowNetOutcomeUsdt");
  const actualTrend = sum("actualTrendGainUsdt");
  const shadowTrend = sum("shadowTrendGainUsdt");
  const givebackReductionFraction = actualGiveback > 0 ? clamp(1 - shadowGiveback / actualGiveback, -10, 1) : null;
  const netOutcomeRetentionFraction = actualNet > 0 ? shadowNet / actualNet : null;
  const trendGainRetentionFraction = actualTrend > 0 ? shadowTrend / actualTrend : null;
  const enoughSamples = eligible.length >= ACCOUNT_SHADOW_POLICY.minimumEligibleCompletedCampaigns;
  const gates = {
    sample: enoughSamples,
    giveback: givebackReductionFraction != null && givebackReductionFraction >= ACCOUNT_SHADOW_POLICY.requiredGivebackReductionFraction,
    netOutcome: netOutcomeRetentionFraction != null && netOutcomeRetentionFraction >= ACCOUNT_SHADOW_POLICY.minimumNetOutcomeRetentionFraction,
    trendRetention: trendGainRetentionFraction != null && trendGainRetentionFraction >= ACCOUNT_SHADOW_POLICY.minimumTrendGainRetentionFraction,
  };
  state.validation = {
    ...state.validation,
    completedCampaignCount: completed.length,
    eligibleCompletedCampaignCount: eligible.length,
    excludedCompletedCampaignCount: completed.length - eligible.length,
    givebackReductionFraction: round(givebackReductionFraction),
    netOutcomeRetentionFraction: round(netOutcomeRetentionFraction),
    trendGainRetentionFraction: round(trendGainRetentionFraction),
    baselineNetOutcomeUsdt: round(actualNet),
    shadowNetOutcomeUsdt: round(shadowNet),
    gates,
    status: !enoughSamples ? "INDICATIVE_WAITING_MINIMUM_CAMPAIGNS" : Object.values(gates).every(Boolean) ? "INDICATIVE_PASS_REVIEW_READY" : "INDICATIVE_REVIEW_CRITERIA_NOT_MET",
    automaticPromotionAllowed: false,
  };
}

function persistedStateError(code) {
  throw new Error(`ACCOUNT_SHADOW_PERSISTED_STATE_INVALID_${code}`);
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) persistedStateError(code);
  return value;
}

function requireExactKeys(value, required, code, optional = []) {
  const allowed = [...required, ...optional];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) persistedStateError(`${code}_MISSING_${missing[0]}`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) persistedStateError(`${code}_UNEXPECTED_${unexpected[0]}`);
}

function requireFinite(value, code, minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) persistedStateError(code);
  return value;
}

function requireCount(value, code) {
  if (!Number.isInteger(value) || value < 0) persistedStateError(code);
  return value;
}

function requireIso(value, code, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) persistedStateError(code);
  return value;
}

function near(left, right, tolerance = 1e-6) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function sameNullableNumber(left, right, tolerance = 1e-6) {
  if (left == null || right == null) return left === right;
  return near(left, right, tolerance);
}

function requireProjectedCurrent(actual, expected, code) {
  for (const key of Object.keys(expected)) {
    const matches = typeof expected[key] === "number"
      ? near(actual[key], expected[key], 1e-7)
      : actual[key] === expected[key];
    if (!matches) persistedStateError(`${code}_${key}`);
  }
}

const OBSERVE_ONLY_ACTIONS = new Set([
  "OBSERVE_ONLY_BASELINE_SEEDED",
  "OBSERVE_ONLY_EVIDENCE_HOLD",
  "OBSERVE_ONLY_NO_CHANGE",
  "OBSERVE_ONLY_RUNNER_PRESERVED",
  "OBSERVE_ONLY_REVIEW_LOCK_BREACH",
  "OBSERVE_ONLY_REVIEW_STRESS_GAP",
  "OBSERVE_ONLY_NEAR_FLOOR",
  "OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE",
]);

const EVIDENCE_STATUSES = new Set([
  "PRICE_SIDE_EVIDENCE_ACCEPTED",
  "WEBSOCKET_DISCONNECTED",
  "VALUATION_INCOMPLETE",
  "QUOTE_TIME_INCOMPLETE",
  "CONTINUITY_EPOCH_INCOMPLETE",
  "SOURCE_TIME_IN_FUTURE",
  "TRANSPORT_STALE",
  "QUOTE_TIME_IN_FUTURE",
  "QUOTE_STALE",
  "QUOTE_SKEW_EXCEEDED",
  "CONTINUITY_EPOCH_CHANGED",
  "OBSERVATION_INTERVAL_GAP",
]);

const FIXED_EVIDENCE_LIMITATIONS = [
  "FUNDING_NOT_ACCRUED",
  "ORDER_BOOK_DEPTH_NOT_MODELED",
  "BBO_SIZE_EVENT_TIME_AND_UPDATE_ID_NOT_PUBLISHED",
  "SNAPSHOT_CAPTURE_TIME_NOT_PUBLISHED_COMPOSITE_REFERENCE_USED",
];

function validateCampaign(campaign, code, completedExpected) {
  const row = requireRecord(campaign, code);
  const baseKeys = ["id", "dayKey", "activatedAt", "completedAt", "startActualEquityUsdt", "startShadowEquityUsdt", "peakActualEquityUsdt", "peakShadowEquityUsdt", "endActualEquityUsdt", "endShadowEquityUsdt", "maximumLockFraction", "minimumRunnerFraction", "interventionAt", "interventionAction", "evidenceEligible", "promotionEligible", "exclusionReasons"];
  const resultKeys = ["actualGivebackUsdt", "shadowGivebackUsdt", "actualNetOutcomeUsdt", "shadowNetOutcomeUsdt", "actualTrendGainUsdt", "shadowTrendGainUsdt"];
  requireExactKeys(row, completedExpected ? [...baseKeys, ...resultKeys] : baseKeys, code);
  if (typeof row.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.dayKey)) persistedStateError(`${code}_DAY_KEY`);
  requireIso(row.activatedAt, `${code}_ACTIVATED_AT`);
  if (cstDayKey(Date.parse(row.activatedAt)) !== row.dayKey || row.id !== `${ACCOUNT_SHADOW_POLICY.experimentId}:${row.dayKey}:${Date.parse(row.activatedAt)}`) persistedStateError(`${code}_IDENTITY`);
  if (completedExpected) requireIso(row.completedAt, `${code}_COMPLETED_AT`);
  else if (row.completedAt !== null) persistedStateError(`${code}_ACTIVE_COMPLETED_AT`);
  for (const field of ["startActualEquityUsdt", "startShadowEquityUsdt", "peakActualEquityUsdt", "peakShadowEquityUsdt"]) {
    requireFinite(row[field], `${code}_${field}`, Number.MIN_VALUE);
  }
  if (row.peakActualEquityUsdt < row.startActualEquityUsdt || row.peakShadowEquityUsdt < row.startShadowEquityUsdt) persistedStateError(`${code}_PEAK_BELOW_START`);
  requireFinite(row.maximumLockFraction, `${code}_LOCK`, 0, ACCOUNT_SHADOW_POLICY.maximumLockFraction);
  requireFinite(row.minimumRunnerFraction, `${code}_RUNNER`, 0, 1);
  if (!near(row.maximumLockFraction + row.minimumRunnerFraction, 1, 1e-8)) persistedStateError(`${code}_LOCK_RUNNER_SUM`);
  if (typeof row.evidenceEligible !== "boolean" || typeof row.promotionEligible !== "boolean" || row.promotionEligible !== false) persistedStateError(`${code}_ELIGIBILITY`);
  if (!Array.isArray(row.exclusionReasons) || !row.exclusionReasons.every((item) => typeof item === "string" && item.length > 0) || new Set(row.exclusionReasons).size !== row.exclusionReasons.length) persistedStateError(`${code}_EXCLUSIONS`);
  if (row.evidenceEligible !== (row.exclusionReasons.length === 0)) persistedStateError(`${code}_ELIGIBILITY_EXCLUSIONS`);
  if (row.interventionAt == null || row.interventionAction == null) {
    if (row.interventionAt !== null || row.interventionAction !== null) persistedStateError(`${code}_INTERVENTION_PAIR`);
  } else {
    requireIso(row.interventionAt, `${code}_INTERVENTION_AT`);
    if (!new Set(["OBSERVE_ONLY_REVIEW_LOCK_BREACH", "OBSERVE_ONLY_REVIEW_STRESS_GAP"]).has(row.interventionAction)) persistedStateError(`${code}_INTERVENTION_ACTION`);
    if (Date.parse(row.interventionAt) < Date.parse(row.activatedAt)) persistedStateError(`${code}_INTERVENTION_BEFORE_ACTIVATION`);
  }
  if (!completedExpected) {
    if (row.endActualEquityUsdt !== null || row.endShadowEquityUsdt !== null) persistedStateError(`${code}_ACTIVE_END_EQUITY`);
  } else {
    if (Date.parse(row.completedAt) < Date.parse(row.activatedAt)) persistedStateError(`${code}_COMPLETION_ORDER`);
    if (cstDayKey(Date.parse(row.completedAt)) <= row.dayKey) persistedStateError(`${code}_COMPLETION_DAY`);
    for (const field of ["endActualEquityUsdt", "endShadowEquityUsdt"]) requireFinite(row[field], `${code}_${field}`, Number.MIN_VALUE);
    for (const field of resultKeys) requireFinite(row[field], `${code}_${field}`);
    if (row.peakActualEquityUsdt < row.endActualEquityUsdt || row.peakShadowEquityUsdt < row.endShadowEquityUsdt) persistedStateError(`${code}_PEAK_BELOW_END`);
    const expected = {
      actualGivebackUsdt: round(Math.max(0, row.peakActualEquityUsdt - row.endActualEquityUsdt)),
      shadowGivebackUsdt: round(Math.max(0, row.peakShadowEquityUsdt - row.endShadowEquityUsdt)),
      actualNetOutcomeUsdt: round(row.endActualEquityUsdt - row.startActualEquityUsdt),
      shadowNetOutcomeUsdt: round(row.endShadowEquityUsdt - row.startShadowEquityUsdt),
      actualTrendGainUsdt: round(Math.max(0, row.peakActualEquityUsdt - row.startActualEquityUsdt)),
      shadowTrendGainUsdt: round(Math.max(0, row.peakShadowEquityUsdt - row.startShadowEquityUsdt)),
    };
    for (const field of resultKeys) if (!near(row[field], expected[field])) persistedStateError(`${code}_${field}_EQUATION`);
  }
  return row;
}

export function validatePersistedAccountShadowState(value) {
  const state = requireRecord(value, "ROOT");
  requireExactKeys(state, ["schemaVersion", "experimentId", "authorizationId", "status", "prospectiveStart", "sourceAsOf", "lastFrameFingerprint", "policy", "boundary", "evidence", "continuityEpoch", "current", "pendingHigh", "pendingHighProof", "dayEvidenceExclusions", "rollingAccount", "lastValidActualMarkedEquityUsdt", "evidenceHoldActive", "recoveryRebaseCount", "continuityGapCount", "activeCampaign", "completedCampaigns", "observations", "validation"], "ROOT");
  if (state.schemaVersion !== ACCOUNT_SHADOW_POLICY.schemaVersion) persistedStateError("SCHEMA_VERSION");
  if (state.experimentId !== ACCOUNT_SHADOW_POLICY.experimentId) persistedStateError("EXPERIMENT_ID");
  if (state.authorizationId !== ACCOUNT_SHADOW_POLICY.authorizationId) persistedStateError("AUTHORIZATION_ID");
  if (state.status !== ACCOUNT_SHADOW_POLICY.status) persistedStateError("STATUS");
  requireIso(state.sourceAsOf, "SOURCE_AS_OF");
  if (typeof state.lastFrameFingerprint !== "string" || state.lastFrameFingerprint.length === 0) persistedStateError("LAST_FRAME_FINGERPRINT");
  requireIso(state.prospectiveStart, "PROSPECTIVE_START", true);
  if (state.prospectiveStart != null && Date.parse(state.prospectiveStart) > Date.parse(state.sourceAsOf)) persistedStateError("PROSPECTIVE_START_AFTER_SOURCE");

  const policy = requireRecord(state.policy, "POLICY");
  if (JSON.stringify(policy) !== JSON.stringify(ACCOUNT_SHADOW_POLICY)) persistedStateError("POLICY_IDENTITY");
  const boundary = requireRecord(state.boundary, "BOUNDARY");
  requireExactKeys(boundary, ["executionInfluence", "ordersOrPositionsAffected", "strategyOrRiskChanged", "automaticPromotionAllowed", "historicalBackfillAllowed", "counterfactualModel", "valuationScope", "mayBlockEntries", "mayResizePositions", "mayMoveStops", "maySubmitOrders"], "BOUNDARY");
  for (const field of ["executionInfluence", "ordersOrPositionsAffected", "strategyOrRiskChanged", "automaticPromotionAllowed", "historicalBackfillAllowed", "mayBlockEntries", "mayResizePositions", "mayMoveStops", "maySubmitOrders"]) {
    if (boundary[field] !== false) persistedStateError(`BOUNDARY_${field}`);
  }
  if (boundary.counterfactualModel !== "ACCOUNT_EQUITY_DELTA_SCALED_BY_RETAINED_RUNNER_FRACTION_AFTER_SHADOW_INTERVENTION" || boundary.valuationScope !== ACCOUNT_SHADOW_POLICY.valuationScope) persistedStateError("BOUNDARY_IDENTITY");

  const epoch = requireRecord(state.continuityEpoch, "CONTINUITY_EPOCH");
  requireExactKeys(epoch, ["reconnects", "selfHeals", "connectedAt"], "CONTINUITY_EPOCH");
  if (state.prospectiveStart == null) {
    if (epoch.reconnects != null) requireCount(epoch.reconnects, "CONTINUITY_RECONNECTS");
    if (epoch.selfHeals != null) requireCount(epoch.selfHeals, "CONTINUITY_SELF_HEALS");
    if (epoch.connectedAt != null) requireFinite(epoch.connectedAt, "CONTINUITY_CONNECTED_AT", 0);
  } else {
    requireCount(epoch.reconnects, "CONTINUITY_RECONNECTS");
    requireCount(epoch.selfHeals, "CONTINUITY_SELF_HEALS");
    requireFinite(epoch.connectedAt, "CONTINUITY_CONNECTED_AT", 0);
  }
  const evidence = requireRecord(state.evidence, "EVIDENCE");
  requireExactKeys(evidence, ["status", "liveEvidenceAccepted", "analysisEligible", "validationEligible", "promotionEligible", "valuationScope", "websocketConnected", "continuityEpochComplete", "historicalGapDetected", "recoveryGapPositions", "quoteTimesComplete", "valuationsComplete", "oldestQuoteAt", "newestQuoteAt", "evidenceReferenceAt", "maximumQuoteAgeMs", "futureQuoteSkewMs", "quoteSkewMs", "transportLagMs", "fundingAccrued", "depthModeled", "limitations"], "EVIDENCE", ["continuityGapDetected"]);
  if (!EVIDENCE_STATUSES.has(evidence.status) || typeof evidence.liveEvidenceAccepted !== "boolean" || typeof evidence.analysisEligible !== "boolean" || typeof evidence.validationEligible !== "boolean" || evidence.promotionEligible !== false || evidence.analysisEligible !== evidence.liveEvidenceAccepted || evidence.validationEligible !== (evidence.liveEvidenceAccepted && evidence.recoveryGapPositions === 0)) persistedStateError("EVIDENCE_ELIGIBILITY");
  for (const field of ["websocketConnected", "continuityEpochComplete", "historicalGapDetected", "quoteTimesComplete", "valuationsComplete", "fundingAccrued", "depthModeled"]) if (typeof evidence[field] !== "boolean") persistedStateError(`EVIDENCE_${field}`);
  requireCount(evidence.recoveryGapPositions, "EVIDENCE_RECOVERY_GAPS");
  for (const field of ["maximumQuoteAgeMs", "futureQuoteSkewMs", "quoteSkewMs", "transportLagMs"]) requireFinite(evidence[field], `EVIDENCE_${field}`, 0);
  for (const field of ["oldestQuoteAt", "newestQuoteAt"]) if (evidence[field] != null) requireFinite(evidence[field], `EVIDENCE_${field}`, 0);
  requireFinite(evidence.evidenceReferenceAt, "EVIDENCE_REFERENCE_AT", 0);
  if (evidence.evidenceReferenceAt < Date.parse(state.sourceAsOf)) persistedStateError("EVIDENCE_REFERENCE_BEFORE_SOURCE");
  if ((evidence.oldestQuoteAt == null) !== (evidence.newestQuoteAt == null)) persistedStateError("EVIDENCE_QUOTE_TIME_PAIR");
  if (evidence.oldestQuoteAt != null) {
    if (evidence.oldestQuoteAt > evidence.newestQuoteAt || evidence.newestQuoteAt > evidence.evidenceReferenceAt) persistedStateError("EVIDENCE_QUOTE_TIME_ORDER");
    if (!near(evidence.maximumQuoteAgeMs, Math.max(0, evidence.evidenceReferenceAt - evidence.oldestQuoteAt), 1e-3) || !near(evidence.quoteSkewMs, Math.max(0, evidence.newestQuoteAt - evidence.oldestQuoteAt), 1e-3)) persistedStateError("EVIDENCE_QUOTE_TIME_EQUATION");
  } else if (evidence.maximumQuoteAgeMs !== 0 || evidence.quoteSkewMs !== 0) persistedStateError("EVIDENCE_EMPTY_QUOTE_TIME_EQUATION");
  if (evidence.fundingAccrued !== false || evidence.depthModeled !== false || evidence.valuationScope !== ACCOUNT_SHADOW_POLICY.valuationScope) persistedStateError("EVIDENCE_SCOPE");
  const isContinuityGap = evidence.status === "CONTINUITY_EPOCH_CHANGED" || evidence.status === "OBSERVATION_INTERVAL_GAP";
  if ((evidence.continuityGapDetected === true) !== isContinuityGap || (Object.prototype.hasOwnProperty.call(evidence, "continuityGapDetected") && evidence.continuityGapDetected !== true)) persistedStateError("EVIDENCE_CONTINUITY_GAP_STATUS");
  if (evidence.status === "PRICE_SIDE_EVIDENCE_ACCEPTED") {
    if (!evidence.liveEvidenceAccepted || !evidence.websocketConnected || !evidence.continuityEpochComplete || !evidence.quoteTimesComplete || !evidence.valuationsComplete || evidence.maximumQuoteAgeMs > ACCOUNT_SHADOW_POLICY.maximumQuoteAgeMs || evidence.futureQuoteSkewMs > ACCOUNT_SHADOW_POLICY.maximumFutureQuoteSkewMs || evidence.quoteSkewMs > ACCOUNT_SHADOW_POLICY.maximumQuoteSkewMs || evidence.transportLagMs > ACCOUNT_SHADOW_POLICY.maximumTransportLagMs) persistedStateError("EVIDENCE_ACCEPTED_CONTRADICTION");
  } else if (evidence.liveEvidenceAccepted) persistedStateError("EVIDENCE_REJECTED_BUT_LIVE");
  if (evidence.status === "WEBSOCKET_DISCONNECTED" && evidence.websocketConnected) persistedStateError("EVIDENCE_WEBSOCKET_STATUS");
  if (evidence.status === "VALUATION_INCOMPLETE" && evidence.valuationsComplete) persistedStateError("EVIDENCE_VALUATION_STATUS");
  if (evidence.status === "QUOTE_TIME_INCOMPLETE" && evidence.quoteTimesComplete) persistedStateError("EVIDENCE_QUOTE_COMPLETENESS_STATUS");
  if (evidence.status === "CONTINUITY_EPOCH_INCOMPLETE" && evidence.continuityEpochComplete) persistedStateError("EVIDENCE_EPOCH_STATUS");
  if (evidence.status === "TRANSPORT_STALE" && evidence.transportLagMs <= ACCOUNT_SHADOW_POLICY.maximumTransportLagMs) persistedStateError("EVIDENCE_TRANSPORT_STATUS");
  if (evidence.status === "QUOTE_TIME_IN_FUTURE" && evidence.futureQuoteSkewMs <= ACCOUNT_SHADOW_POLICY.maximumFutureQuoteSkewMs) persistedStateError("EVIDENCE_FUTURE_STATUS");
  if (evidence.status === "QUOTE_STALE" && evidence.maximumQuoteAgeMs <= ACCOUNT_SHADOW_POLICY.maximumQuoteAgeMs) persistedStateError("EVIDENCE_STALE_STATUS");
  if (evidence.status === "QUOTE_SKEW_EXCEEDED" && evidence.quoteSkewMs <= ACCOUNT_SHADOW_POLICY.maximumQuoteSkewMs) persistedStateError("EVIDENCE_SKEW_STATUS");
  if (!Array.isArray(evidence.limitations) || !evidence.limitations.every((item) => typeof item === "string" && item.length > 0) || new Set(evidence.limitations).size !== evidence.limitations.length) persistedStateError("EVIDENCE_LIMITATIONS");
  for (const limitation of FIXED_EVIDENCE_LIMITATIONS) if (!evidence.limitations.includes(limitation)) persistedStateError(`EVIDENCE_LIMITATION_MISSING_${limitation}`);
  if (evidence.limitations.includes("HISTORICAL_CAPTURE_GAP") !== evidence.historicalGapDetected || evidence.limitations.includes("RECOVERY_GAP_POSITIONS_EXCLUDED_FROM_VALIDATION") !== (evidence.recoveryGapPositions > 0)) persistedStateError("EVIDENCE_LIMITATION_SEMANTICS");
  if (evidence.status === "CONTINUITY_EPOCH_CHANGED" && !evidence.limitations.includes("FORWARD_CONNECTION_EPOCH_CHANGED")) persistedStateError("EVIDENCE_EPOCH_GAP_LIMITATION");
  if (evidence.status === "OBSERVATION_INTERVAL_GAP" && !evidence.limitations.includes("UNOBSERVED_INTERVAL_EXCEEDED")) persistedStateError("EVIDENCE_INTERVAL_GAP_LIMITATION");

  const current = requireRecord(state.current, "CURRENT");
  requireExactKeys(current, ["dayKey", "dayBaselineKind", "baselineEquityUsdt", "actualMarkedEquityUsdt", "shadowMarkedEquityUsdt", "actualStressStopEquityUsdt", "shadowStressStopEquityUsdt", "confirmedHighWaterUsdt", "pendingHighWaterUsdt", "protectionFloorUsdt", "peakProfitFraction", "lockFraction", "runnerFraction", "effectiveExposureFraction", "distanceToFloorUsdt", "stressFloorGapUsdt", "tier", "action", "actionChangedAt"], "CURRENT");
  if (typeof current.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(current.dayKey) || !new Set(["WAITING_FIRST_VALID_FORWARD_SNAPSHOT", "PROSPECTIVE_FIRST_VALID_SNAPSHOT", "FIRST_VALID_SNAPSHOT_AFTER_CST_MIDNIGHT"]).has(current.dayBaselineKind) || !OBSERVE_ONLY_ACTIONS.has(current.action)) persistedStateError("CURRENT_IDENTITY");
  requireIso(current.actionChangedAt, "CURRENT_ACTION_CHANGED_AT");
  if (Date.parse(current.actionChangedAt) > Date.parse(state.sourceAsOf)) persistedStateError("CURRENT_ACTION_TIME_AFTER_SOURCE");
  requireFinite(current.peakProfitFraction, "CURRENT_PEAK_PROFIT", 0);
  requireFinite(current.lockFraction, "CURRENT_LOCK", 0, ACCOUNT_SHADOW_POLICY.maximumLockFraction);
  requireFinite(current.runnerFraction, "CURRENT_RUNNER", 0, 1);
  requireFinite(current.effectiveExposureFraction, "CURRENT_EXPOSURE", 0, 1);
  if (Math.abs(current.lockFraction + current.runnerFraction - 1) > 1e-8) persistedStateError("CURRENT_LOCK_RUNNER_SUM");
  if (state.prospectiveStart == null) {
    for (const field of ["baselineEquityUsdt", "actualMarkedEquityUsdt", "shadowMarkedEquityUsdt", "actualStressStopEquityUsdt", "shadowStressStopEquityUsdt", "confirmedHighWaterUsdt", "pendingHighWaterUsdt", "protectionFloorUsdt", "distanceToFloorUsdt", "stressFloorGapUsdt"]) {
      if (current[field] != null) persistedStateError(`WAITING_${field}`);
    }
    if (current.dayKey !== cstDayKey(Date.parse(state.sourceAsOf)) || current.dayBaselineKind !== "WAITING_FIRST_VALID_FORWARD_SNAPSHOT" || current.action !== "OBSERVE_ONLY_EVIDENCE_HOLD" || current.tier !== "T0" || current.lockFraction !== 0 || current.runnerFraction !== 1 || current.effectiveExposureFraction !== 1 || state.activeCampaign != null || state.lastValidActualMarkedEquityUsdt != null || state.evidenceHoldActive !== true || evidence.liveEvidenceAccepted !== false || evidence.analysisEligible !== false || evidence.validationEligible !== false || evidence.status === "PRICE_SIDE_EVIDENCE_ACCEPTED" || state.recoveryRebaseCount !== 0 || state.continuityGapCount !== 0) persistedStateError("WAITING_POLICY_STATE");
  } else {
    for (const field of ["baselineEquityUsdt", "actualMarkedEquityUsdt", "shadowMarkedEquityUsdt", "actualStressStopEquityUsdt", "shadowStressStopEquityUsdt", "confirmedHighWaterUsdt", "protectionFloorUsdt", "distanceToFloorUsdt", "stressFloorGapUsdt"]) {
      requireFinite(current[field], `CURRENT_${field}`);
    }
    if (!(current.baselineEquityUsdt > 0) || current.confirmedHighWaterUsdt < current.baselineEquityUsdt || current.protectionFloorUsdt < current.baselineEquityUsdt || current.protectionFloorUsdt > current.confirmedHighWaterUsdt) persistedStateError("CURRENT_EQUITY_ORDER");
    if (current.actualStressStopEquityUsdt > current.actualMarkedEquityUsdt + 1e-7 || current.shadowStressStopEquityUsdt > current.shadowMarkedEquityUsdt + 1e-7) persistedStateError("CURRENT_STRESS_ABOVE_MARK");
    if (current.effectiveExposureFraction + 1e-8 < current.runnerFraction) persistedStateError("CURRENT_EXPOSURE_BELOW_RUNNER");
    const expectedPeak = Math.max(0, (current.confirmedHighWaterUsdt - current.baselineEquityUsdt) / current.baselineEquityUsdt);
    const expectedTier = tierFor(expectedPeak);
    if (Math.abs(current.peakProfitFraction - expectedPeak) > 1e-7 || current.tier !== expectedTier.id) persistedStateError("CURRENT_TIER_OR_PEAK");
    if (current.lockFraction + 1e-8 < expectedTier.lockFraction || current.lockFraction > Math.min(ACCOUNT_SHADOW_POLICY.maximumLockFraction, expectedTier.lockFraction + ACCOUNT_SHADOW_POLICY.stressLockIncrementFraction) + 1e-8) persistedStateError("CURRENT_LOCK_TIER_RANGE");
    const expectedFloor = round(current.baselineEquityUsdt + current.lockFraction * Math.max(0, current.confirmedHighWaterUsdt - current.baselineEquityUsdt));
    if (!near(current.protectionFloorUsdt, expectedFloor)) persistedStateError("CURRENT_PROTECTION_FLOOR_EQUATION");
    if (!near(current.distanceToFloorUsdt, current.shadowMarkedEquityUsdt - current.protectionFloorUsdt)) persistedStateError("CURRENT_DISTANCE_TO_FLOOR");
    const expectedStress = current.shadowMarkedEquityUsdt + current.effectiveExposureFraction * (current.actualStressStopEquityUsdt - current.actualMarkedEquityUsdt);
    if (!near(current.shadowStressStopEquityUsdt, expectedStress) || !near(current.stressFloorGapUsdt, current.shadowStressStopEquityUsdt - current.protectionFloorUsdt)) persistedStateError("CURRENT_STRESS_EQUATION");
    if (state.evidenceHoldActive !== !evidence.liveEvidenceAccepted || (state.evidenceHoldActive && current.action !== "OBSERVE_ONLY_EVIDENCE_HOLD") || (!state.evidenceHoldActive && current.action === "OBSERVE_ONLY_EVIDENCE_HOLD")) persistedStateError("CURRENT_HOLD_SEMANTICS");
    if (!state.evidenceHoldActive && state.lastValidActualMarkedEquityUsdt !== current.actualMarkedEquityUsdt) persistedStateError("CURRENT_LAST_VALID_EQUITY");
    if (Date.parse(current.actionChangedAt) < Date.parse(state.prospectiveStart)) persistedStateError("CURRENT_ACTION_TIME_BEFORE_START");
    const prospectiveDay = cstDayKey(Date.parse(state.prospectiveStart));
    const expectedBaselineKind = current.dayKey === prospectiveDay ? "PROSPECTIVE_FIRST_VALID_SNAPSHOT" : "FIRST_VALID_SNAPSHOT_AFTER_CST_MIDNIGHT";
    const sourceDay = cstDayKey(Date.parse(state.sourceAsOf));
    if (current.dayKey < prospectiveDay || current.dayKey > sourceDay || current.dayBaselineKind !== expectedBaselineKind || (!state.evidenceHoldActive && current.dayKey !== sourceDay)) persistedStateError("CURRENT_DAY_SEMANTICS");
    if (current.tier === "T0" && !new Set(["OBSERVE_ONLY_BASELINE_SEEDED", "OBSERVE_ONLY_NO_CHANGE", "OBSERVE_ONLY_EVIDENCE_HOLD"]).has(current.action)) persistedStateError("CURRENT_T0_ACTION");
    if (current.action === "OBSERVE_ONLY_BASELINE_SEEDED" && state.sourceAsOf !== state.prospectiveStart) persistedStateError("CURRENT_BASELINE_ACTION_SOURCE");
    if (state.sourceAsOf === state.prospectiveStart && (state.evidenceHoldActive || !evidence.liveEvidenceAccepted)) persistedStateError("PROSPECTIVE_START_REQUIRES_LIVE_EVIDENCE");
    if (!state.evidenceHoldActive && current.tier === "T0") {
      const expectedT0Action = state.sourceAsOf === state.prospectiveStart ? "OBSERVE_ONLY_BASELINE_SEEDED" : "OBSERVE_ONLY_NO_CHANGE";
      if (current.action !== expectedT0Action) persistedStateError("CURRENT_T0_ACTION_PRIORITY");
    }
  }

  if (state.pendingHigh != null) {
    const pending = requireRecord(state.pendingHigh, "PENDING_HIGH");
    requireExactKeys(pending, ["startedAt", "candidateEquityUsdt", "frameFingerprint"], "PENDING_HIGH");
    requireFinite(pending.startedAt, "PENDING_HIGH_STARTED_AT", 0);
    requireFinite(pending.candidateEquityUsdt, "PENDING_HIGH_EQUITY");
    if (typeof pending.frameFingerprint !== "string" || pending.frameFingerprint.length === 0) persistedStateError("PENDING_HIGH_FINGERPRINT");
    if (current.pendingHighWaterUsdt !== pending.candidateEquityUsdt || pending.candidateEquityUsdt <= current.confirmedHighWaterUsdt || pending.startedAt > Date.parse(state.sourceAsOf) || state.evidenceHoldActive) persistedStateError("PENDING_HIGH_MISMATCH");
    if (pending.startedAt < Date.parse(state.prospectiveStart) || cstDayKey(pending.startedAt) !== current.dayKey) persistedStateError("PENDING_HIGH_START_RANGE");
    const proof = requireRecord(state.pendingHighProof, "PENDING_HIGH_PROOF");
    requireExactKeys(proof, ["sourceAsOf", "candidateEquityUsdt", "frameFingerprint", "baseHighWaterUsdt", "continuityEpoch"], "PENDING_HIGH_PROOF");
    requireIso(proof.sourceAsOf, "PENDING_HIGH_PROOF_SOURCE");
    if (Date.parse(proof.sourceAsOf) !== pending.startedAt || proof.candidateEquityUsdt !== pending.candidateEquityUsdt || proof.frameFingerprint !== pending.frameFingerprint || proof.baseHighWaterUsdt !== current.confirmedHighWaterUsdt || JSON.stringify(proof.continuityEpoch) !== JSON.stringify(state.continuityEpoch)) persistedStateError("PENDING_HIGH_PROOF_MISMATCH");
    if (state.lastFrameFingerprint !== pending.frameFingerprint && Date.parse(state.sourceAsOf) - pending.startedAt >= ACCOUNT_SHADOW_POLICY.highWaterConfirmationMs) persistedStateError("PENDING_HIGH_CONFIRMATION_OVERDUE");
  } else if (current.pendingHighWaterUsdt != null) persistedStateError("PENDING_HIGH_ORPHAN");
  if (state.pendingHigh == null && state.pendingHighProof !== null) persistedStateError("PENDING_HIGH_PROOF_ORPHAN");
  if (!Array.isArray(state.dayEvidenceExclusions) || state.dayEvidenceExclusions.some((v) => typeof v !== "string" || !v) || new Set(state.dayEvidenceExclusions).size !== state.dayEvidenceExclusions.length) persistedStateError("DAY_EVIDENCE_EXCLUSIONS_INVALID");
  if (!evidence.validationEligible && dayExclusions([], evidence).some((reason) => !state.dayEvidenceExclusions.includes(reason))) persistedStateError("DAY_EVIDENCE_EXCLUSIONS_MISSING");
  if (state.lastValidActualMarkedEquityUsdt != null) requireFinite(state.lastValidActualMarkedEquityUsdt, "LAST_VALID_EQUITY");
  if (state.prospectiveStart != null && state.lastValidActualMarkedEquityUsdt == null) persistedStateError("LAST_VALID_EQUITY_MISSING");
  if (typeof state.evidenceHoldActive !== "boolean") persistedStateError("EVIDENCE_HOLD");
  requireCount(state.recoveryRebaseCount, "RECOVERY_REBASE_COUNT");
  requireCount(state.continuityGapCount, "CONTINUITY_GAP_COUNT");

  if (state.activeCampaign != null) validateCampaign(state.activeCampaign, "ACTIVE_CAMPAIGN", false);
  if (!Array.isArray(state.completedCampaigns) || state.completedCampaigns.length > ACCOUNT_SHADOW_POLICY.completedCampaignLimit) persistedStateError("COMPLETED_CAMPAIGNS");
  state.completedCampaigns.forEach((campaign, index) => validateCampaign(campaign, `COMPLETED_CAMPAIGN_${index}`, true));
  if (state.prospectiveStart == null && (state.completedCampaigns.length !== 0 || state.activeCampaign != null)) persistedStateError("WAITING_CAMPAIGNS");
  if (state.prospectiveStart != null) {
    if ((current.lockFraction > 0) !== (state.activeCampaign != null)) persistedStateError("ACTIVE_CAMPAIGN_TIER_SEMANTICS");
    if (state.activeCampaign) {
      if (state.activeCampaign.dayKey !== current.dayKey || !near(state.activeCampaign.maximumLockFraction, current.lockFraction, 1e-8) || !near(state.activeCampaign.minimumRunnerFraction, current.runnerFraction, 1e-8) || state.activeCampaign.peakActualEquityUsdt < current.actualMarkedEquityUsdt || state.activeCampaign.peakShadowEquityUsdt < current.shadowMarkedEquityUsdt) persistedStateError("ACTIVE_CAMPAIGN_CURRENT_STATE");
      if (!evidence.validationEligible && state.activeCampaign.evidenceEligible) persistedStateError("ACTIVE_CAMPAIGN_EVIDENCE_CONTRADICTION");
      if (state.dayEvidenceExclusions.some((reason) => !state.activeCampaign.exclusionReasons.includes(reason))) persistedStateError("ACTIVE_CAMPAIGN_DAY_EVIDENCE_MISSING");
    }
    if (epoch.connectedAt > evidence.evidenceReferenceAt || (evidence.oldestQuoteAt != null && evidence.oldestQuoteAt < epoch.connectedAt)) persistedStateError("CONTINUITY_EPOCH_EVIDENCE_ORDER");
    if (!state.evidenceHoldActive && current.tier !== "T0") {
      if (current.shadowMarkedEquityUsdt <= current.protectionFloorUsdt && current.action !== "OBSERVE_ONLY_REVIEW_LOCK_BREACH") persistedStateError("CURRENT_LOCK_BREACH_PRIORITY");
      const stressInterventionJustOccurred = current.action === "OBSERVE_ONLY_REVIEW_STRESS_GAP" && state.activeCampaign?.interventionAt === current.actionChangedAt;
      if (current.shadowMarkedEquityUsdt > current.protectionFloorUsdt && current.shadowStressStopEquityUsdt < current.protectionFloorUsdt && current.action !== "OBSERVE_ONLY_REVIEW_STRESS_GAP") persistedStateError("CURRENT_STRESS_GAP_PRIORITY");
      if (current.shadowMarkedEquityUsdt > current.protectionFloorUsdt && current.shadowStressStopEquityUsdt >= current.protectionFloorUsdt && !stressInterventionJustOccurred) {
        const expectedAction = current.distanceToFloorUsdt <= current.baselineEquityUsdt * 0.002
          ? "OBSERVE_ONLY_NEAR_FLOOR"
          : current.effectiveExposureFraction <= current.runnerFraction
            ? "OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE"
            : "OBSERVE_ONLY_RUNNER_PRESERVED";
        if (current.action !== expectedAction) persistedStateError("CURRENT_ACTION_PRIORITY");
      }
      if (current.action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" && current.shadowMarkedEquityUsdt > current.protectionFloorUsdt) persistedStateError("CURRENT_LOCK_BREACH_ACTION");
      if (current.action === "OBSERVE_ONLY_REVIEW_STRESS_GAP" && current.shadowStressStopEquityUsdt >= current.protectionFloorUsdt && state.activeCampaign?.interventionAt !== current.actionChangedAt) persistedStateError("CURRENT_STRESS_GAP_ACTION");
      if (current.action === "OBSERVE_ONLY_NEAR_FLOOR" && (current.shadowMarkedEquityUsdt <= current.protectionFloorUsdt || current.shadowStressStopEquityUsdt < current.protectionFloorUsdt || current.distanceToFloorUsdt > current.baselineEquityUsdt * 0.002)) persistedStateError("CURRENT_NEAR_FLOOR_ACTION");
      if (current.action === "OBSERVE_ONLY_RUNNER_PRESERVED" && (current.shadowMarkedEquityUsdt <= current.protectionFloorUsdt || current.shadowStressStopEquityUsdt < current.protectionFloorUsdt || current.distanceToFloorUsdt <= current.baselineEquityUsdt * 0.002 || current.effectiveExposureFraction <= current.runnerFraction)) persistedStateError("CURRENT_RUNNER_ACTION");
      if (current.action === "OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE" && (current.shadowMarkedEquityUsdt <= current.protectionFloorUsdt || current.shadowStressStopEquityUsdt < current.protectionFloorUsdt || current.distanceToFloorUsdt <= current.baselineEquityUsdt * 0.002 || current.effectiveExposureFraction > current.runnerFraction)) persistedStateError("CURRENT_PROTECTED_RUNNER_ACTION");
      if (new Set(["OBSERVE_ONLY_BASELINE_SEEDED", "OBSERVE_ONLY_NO_CHANGE"]).has(current.action)) persistedStateError("CURRENT_ACTIVE_TIER_ACTION");
    }
  }
  if (!Array.isArray(state.observations) || state.observations.length === 0 || state.observations.length > ACCOUNT_SHADOW_POLICY.historyLimit) persistedStateError("OBSERVATIONS");
  let priorObservationMs = Number.NEGATIVE_INFINITY;
  let priorObservation = null;
  for (const [index, row] of state.observations.entries()) {
    requireRecord(row, `OBSERVATION_${index}`);
    requireExactKeys(row, ["sourceAsOf", "actualMarkedEquityUsdt", "shadowMarkedEquityUsdt", "confirmedHighWaterUsdt", "protectionFloorUsdt", "shadowStressStopEquityUsdt", "effectiveExposureFraction", "action", "evidenceStatus"], `OBSERVATION_${index}`);
    requireIso(row.sourceAsOf, `OBSERVATION_${index}_SOURCE`);
    const observationMs = Date.parse(row.sourceAsOf);
    if (observationMs <= priorObservationMs) persistedStateError(`OBSERVATION_${index}_ORDER`);
    priorObservationMs = observationMs;
    if (!OBSERVE_ONLY_ACTIONS.has(row.action) || !EVIDENCE_STATUSES.has(row.evidenceStatus) || observationMs > Date.parse(state.sourceAsOf)) persistedStateError(`OBSERVATION_${index}_IDENTITY`);
    for (const field of ["actualMarkedEquityUsdt", "shadowMarkedEquityUsdt", "confirmedHighWaterUsdt", "protectionFloorUsdt", "shadowStressStopEquityUsdt"]) {
      if (state.prospectiveStart == null) {
        if (row[field] !== null) persistedStateError(`OBSERVATION_${index}_${field}_WAITING`);
      } else {
        requireFinite(row[field], `OBSERVATION_${index}_${field}`);
      }
    }
    requireFinite(row.effectiveExposureFraction, `OBSERVATION_${index}_effectiveExposureFraction`, 0, 1);
    if ((row.confirmedHighWaterUsdt == null) !== (row.protectionFloorUsdt == null) || (row.confirmedHighWaterUsdt != null && row.protectionFloorUsdt > row.confirmedHighWaterUsdt)) persistedStateError(`OBSERVATION_${index}_EQUITY_ORDER`);
    if ((row.action === "OBSERVE_ONLY_EVIDENCE_HOLD") !== (row.evidenceStatus !== "PRICE_SIDE_EVIDENCE_ACCEPTED")) persistedStateError(`OBSERVATION_${index}_HOLD_SEMANTICS`);
    if (state.prospectiveStart == null && (row.action !== "OBSERVE_ONLY_EVIDENCE_HOLD" || row.effectiveExposureFraction !== 1)) persistedStateError(`OBSERVATION_${index}_WAITING_SEMANTICS`);
    if (priorObservation && cstDayKey(Date.parse(priorObservation.sourceAsOf)) === cstDayKey(observationMs) && priorObservation.evidenceStatus === "PRICE_SIDE_EVIDENCE_ACCEPTED" && row.evidenceStatus === "PRICE_SIDE_EVIDENCE_ACCEPTED") {
      if (row.confirmedHighWaterUsdt < priorObservation.confirmedHighWaterUsdt || row.protectionFloorUsdt < priorObservation.protectionFloorUsdt || row.effectiveExposureFraction > priorObservation.effectiveExposureFraction) persistedStateError(`OBSERVATION_${index}_PROTECTION_REGRESSED`);
    }
    priorObservation = row;
  }
  const firstObservation = state.observations[0];
  const lastObservation = state.observations.at(-1);
  if (state.prospectiveStart != null) {
    if (state.observations.some((row) => Date.parse(row.sourceAsOf) < Date.parse(state.prospectiveStart))) persistedStateError("OBSERVATION_BEFORE_PROSPECTIVE_START");
    if (state.observations.length < ACCOUNT_SHADOW_POLICY.historyLimit && firstObservation.sourceAsOf !== state.prospectiveStart) persistedStateError("OBSERVATION_HISTORY_PREFIX_MISSING");
  }
  const latestObservationLagMs = Date.parse(state.sourceAsOf) - Date.parse(lastObservation.sourceAsOf);
  if (latestObservationLagMs === 0) {
    if (JSON.stringify(lastObservation) !== JSON.stringify(compactObservation(state))) persistedStateError("OBSERVATION_LATEST_STATE_MISMATCH");
  } else if (latestObservationLagMs >= ACCOUNT_SHADOW_POLICY.historySampleIntervalMs || lastObservation.action !== current.action || lastObservation.evidenceStatus !== evidence.status) {
    persistedStateError("OBSERVATION_LATEST_SAMPLE_MISSING");
  }
  const validation = requireRecord(state.validation, "VALIDATION");
  requireExactKeys(validation, ["activatedCampaignCount", "completedCampaignCount", "eligibleCompletedCampaignCount", "excludedCompletedCampaignCount", "givebackReductionFraction", "netOutcomeRetentionFraction", "trendGainRetentionFraction", "baselineNetOutcomeUsdt", "shadowNetOutcomeUsdt", "gates", "status", "automaticPromotionAllowed"], "VALIDATION");
  for (const field of ["activatedCampaignCount", "completedCampaignCount", "eligibleCompletedCampaignCount", "excludedCompletedCampaignCount"]) requireCount(validation[field], `VALIDATION_${field}`);
  if (validation.automaticPromotionAllowed !== false) persistedStateError("VALIDATION_STATUS");
  for (const field of ["givebackReductionFraction", "netOutcomeRetentionFraction", "trendGainRetentionFraction", "baselineNetOutcomeUsdt", "shadowNetOutcomeUsdt"]) if (validation[field] != null) requireFinite(validation[field], `VALIDATION_${field}`);
  const gates = requireRecord(validation.gates, "VALIDATION_GATES");
  requireExactKeys(gates, ["sample", "giveback", "netOutcome", "trendRetention"], "VALIDATION_GATES");
  if (!["sample", "giveback", "netOutcome", "trendRetention"].every((field) => typeof gates[field] === "boolean")) persistedStateError("VALIDATION_GATE_VALUES");
  const eligibleCount = state.completedCampaigns.filter((campaign) => campaign.evidenceEligible).length;
  if (validation.completedCampaignCount !== state.completedCampaigns.length || validation.eligibleCompletedCampaignCount !== eligibleCount || validation.excludedCompletedCampaignCount !== state.completedCampaigns.length - eligibleCount) persistedStateError("VALIDATION_COUNTS");
  if (validation.activatedCampaignCount < validation.completedCampaignCount + (state.activeCampaign ? 1 : 0)) persistedStateError("VALIDATION_ACTIVATED_COUNT");
  const eligibleCampaigns = state.completedCampaigns.filter((campaign) => campaign.evidenceEligible);
  const sum = (field) => eligibleCampaigns.reduce((total, campaign) => total + campaign[field], 0);
  const actualGiveback = sum("actualGivebackUsdt");
  const shadowGiveback = sum("shadowGivebackUsdt");
  const actualNet = sum("actualNetOutcomeUsdt");
  const shadowNet = sum("shadowNetOutcomeUsdt");
  const actualTrend = sum("actualTrendGainUsdt");
  const shadowTrend = sum("shadowTrendGainUsdt");
  const expectedGiveback = actualGiveback > 0 ? round(clamp(1 - shadowGiveback / actualGiveback, -10, 1)) : null;
  const expectedNetRetention = actualNet > 0 ? round(shadowNet / actualNet) : null;
  const expectedTrendRetention = actualTrend > 0 ? round(shadowTrend / actualTrend) : null;
  if (!sameNullableNumber(validation.givebackReductionFraction, expectedGiveback) || !sameNullableNumber(validation.netOutcomeRetentionFraction, expectedNetRetention) || !sameNullableNumber(validation.trendGainRetentionFraction, expectedTrendRetention) || !near(validation.baselineNetOutcomeUsdt, round(actualNet)) || !near(validation.shadowNetOutcomeUsdt, round(shadowNet))) persistedStateError("VALIDATION_METRICS");
  const expectedGates = {
    sample: eligibleCount >= ACCOUNT_SHADOW_POLICY.minimumEligibleCompletedCampaigns,
    giveback: expectedGiveback != null && expectedGiveback >= ACCOUNT_SHADOW_POLICY.requiredGivebackReductionFraction,
    netOutcome: expectedNetRetention != null && expectedNetRetention >= ACCOUNT_SHADOW_POLICY.minimumNetOutcomeRetentionFraction,
    trendRetention: expectedTrendRetention != null && expectedTrendRetention >= ACCOUNT_SHADOW_POLICY.minimumTrendGainRetentionFraction,
  };
  if (JSON.stringify(gates) !== JSON.stringify(expectedGates)) persistedStateError("VALIDATION_GATE_EQUATIONS");
  const expectedValidationStatus = state.prospectiveStart == null
    ? "INDICATIVE_WAITING_FIRST_VALID_FORWARD_SNAPSHOT"
    : !expectedGates.sample
      ? "INDICATIVE_WAITING_MINIMUM_CAMPAIGNS"
      : Object.values(expectedGates).every(Boolean)
        ? "INDICATIVE_PASS_REVIEW_READY"
        : "INDICATIVE_REVIEW_CRITERIA_NOT_MET";
  if (validation.status !== expectedValidationStatus) persistedStateError("VALIDATION_STATUS_EQUATION");
  const campaignIds = [...state.completedCampaigns, ...(state.activeCampaign ? [state.activeCampaign] : [])].map((campaign) => campaign.id);
  if (new Set(campaignIds).size !== campaignIds.length) persistedStateError("CAMPAIGN_IDS_NOT_UNIQUE");
  if (state.prospectiveStart != null) {
    const prospectiveMs = Date.parse(state.prospectiveStart);
    const sourceMs = Date.parse(state.sourceAsOf);
    const campaigns = [...state.completedCampaigns, ...(state.activeCampaign ? [state.activeCampaign] : [])];
    let priorCompletedAt = Number.NEGATIVE_INFINITY;
    for (const campaign of campaigns) {
      const activatedAt = Date.parse(campaign.activatedAt);
      const completedAt = campaign.completedAt == null ? sourceMs : Date.parse(campaign.completedAt);
      if (activatedAt < prospectiveMs || activatedAt > sourceMs || completedAt > sourceMs || activatedAt <= priorCompletedAt) persistedStateError("CAMPAIGN_TIMELINE");
      if (campaign.interventionAt != null && Date.parse(campaign.interventionAt) > completedAt) persistedStateError("CAMPAIGN_INTERVENTION_TIMELINE");
      const activationObservation = state.observations.find((row) => row.sourceAsOf === campaign.activatedAt);
      if (activationObservation && (!near(activationObservation.actualMarkedEquityUsdt, campaign.startActualEquityUsdt) || !near(activationObservation.shadowMarkedEquityUsdt, campaign.startShadowEquityUsdt))) persistedStateError("CAMPAIGN_ACTIVATION_OBSERVATION_MISMATCH");
      if (campaign.interventionAt != null) {
        const interventionObservation = state.observations.find((row) => row.sourceAsOf === campaign.interventionAt);
        if (interventionObservation && interventionObservation.action !== campaign.interventionAction) persistedStateError("CAMPAIGN_INTERVENTION_OBSERVATION_MISMATCH");
      }
      if (campaign.completedAt != null) priorCompletedAt = completedAt;
    }
    const campaignDays = campaigns.map((campaign) => campaign.dayKey);
    if (new Set(campaignDays).size !== campaignDays.length) persistedStateError("CAMPAIGN_DAY_NOT_UNIQUE");
    const totalCompletedCampaigns = validation.activatedCampaignCount - (state.activeCampaign ? 1 : 0);
    if (totalCompletedCampaigns < 0 || state.completedCampaigns.length !== Math.min(totalCompletedCampaigns, ACCOUNT_SHADOW_POLICY.completedCampaignLimit)) persistedStateError("CAMPAIGN_ACTIVATION_COUNT_EQUATION");
    const prospectiveDayNumber = Math.floor((Date.parse(`${cstDayKey(prospectiveMs)}T00:00:00.000Z`)) / 86_400_000);
    const sourceDayNumber = Math.floor((Date.parse(`${cstDayKey(sourceMs)}T00:00:00.000Z`)) / 86_400_000);
    if (validation.activatedCampaignCount > sourceDayNumber - prospectiveDayNumber + 1) persistedStateError("CAMPAIGN_ACTIVATION_COUNT_EXCEEDS_DAYS");
  }
  validateRollingAccount(state.rollingAccount, state.sourceAsOf);
  if ((state.prospectiveStart == null) !== (state.rollingAccount == null)) persistedStateError("ROLLING_START_MISMATCH");
  return state;
}

export function validateAccountShadowTransition(previousValue, nextValue) {
  const previous = validatePersistedAccountShadowState(previousValue);
  const next = validatePersistedAccountShadowState(nextValue);
  const previousMs = Date.parse(previous.sourceAsOf);
  const nextMs = Date.parse(next.sourceAsOf);
  if (!(nextMs > previousMs)) persistedStateError("TRANSITION_SOURCE_NOT_MONOTONIC");
  if (previous.prospectiveStart != null && next.prospectiveStart !== previous.prospectiveStart) persistedStateError("TRANSITION_PROSPECTIVE_START_CHANGED");
  if (previous.prospectiveStart == null && next.prospectiveStart != null && next.prospectiveStart !== next.sourceAsOf) persistedStateError("TRANSITION_PROSPECTIVE_START_NOT_CURRENT_FRAME");
  const resetDayEvidence = previous.prospectiveStart == null || previous.current.dayKey !== next.current.dayKey;
  const expectedDayExclusions = dayExclusions(resetDayEvidence ? [] : previous.dayEvidenceExclusions, next.evidence);
  if (JSON.stringify(next.dayEvidenceExclusions) !== JSON.stringify(expectedDayExclusions)) persistedStateError("TRANSITION_DAY_EVIDENCE_INVALID");
  const expectedProof = next.pendingHigh == null ? null : previous.pendingHigh != null && next.pendingHigh.startedAt === previous.pendingHigh.startedAt
    ? previous.pendingHighProof : pendingProof(next);
  if (JSON.stringify(next.pendingHighProof) !== JSON.stringify(expectedProof)) persistedStateError("TRANSITION_PENDING_PROOF_INVALID");
  const expectedRolling = advanceRollingAccount(previous.rollingAccount, rollingInput(next, next.rollingAccount?.realizedEquityUsdt));
  if (JSON.stringify(next.rollingAccount) !== JSON.stringify(expectedRolling)) persistedStateError("TRANSITION_ROLLING_INVALID");

  const nextSourceDay = cstDayKey(nextMs);
  if (previous.prospectiveStart == null) {
    if (next.prospectiveStart == null) {
      if (next.evidence.liveEvidenceAccepted) persistedStateError("TRANSITION_WAITING_LIVE_EVIDENCE_NOT_SEEDED");
      const expectedWaitingCurrent = { ...previous.current, dayKey: nextSourceDay };
      requireProjectedCurrent(next.current, expectedWaitingCurrent, "TRANSITION_WAITING_CURRENT");
      if (next.pendingHigh !== null || next.lastValidActualMarkedEquityUsdt !== null || next.recoveryRebaseCount !== 0 || next.continuityGapCount !== 0 || next.activeCampaign !== null || next.completedCampaigns.length !== 0 || JSON.stringify(next.validation) !== JSON.stringify(previous.validation)) persistedStateError("TRANSITION_WAITING_STATE_CHANGED");
    } else {
      if (!next.evidence.liveEvidenceAccepted || next.evidence.status !== "PRICE_SIDE_EVIDENCE_ACCEPTED" || next.evidenceHoldActive) persistedStateError("TRANSITION_SEED_REQUIRES_LIVE_EVIDENCE");
      const equity = next.current.actualMarkedEquityUsdt;
      const stress = next.current.actualStressStopEquityUsdt;
      const expectedSeedCurrent = {
        dayKey: nextSourceDay,
        dayBaselineKind: "PROSPECTIVE_FIRST_VALID_SNAPSHOT",
        baselineEquityUsdt: equity,
        actualMarkedEquityUsdt: equity,
        shadowMarkedEquityUsdt: equity,
        actualStressStopEquityUsdt: stress,
        shadowStressStopEquityUsdt: stress,
        confirmedHighWaterUsdt: equity,
        pendingHighWaterUsdt: null,
        protectionFloorUsdt: equity,
        peakProfitFraction: 0,
        lockFraction: 0,
        runnerFraction: 1,
        effectiveExposureFraction: 1,
        distanceToFloorUsdt: 0,
        stressFloorGapUsdt: round(stress - equity),
        tier: "T0",
        action: "OBSERVE_ONLY_BASELINE_SEEDED",
        actionChangedAt: next.sourceAsOf,
      };
      requireProjectedCurrent(next.current, expectedSeedCurrent, "TRANSITION_SEED_CURRENT");
      if (next.pendingHigh !== null || next.lastValidActualMarkedEquityUsdt !== equity || next.recoveryRebaseCount !== 0 || next.continuityGapCount !== 0 || next.activeCampaign !== null || next.completedCampaigns.length !== 0 || next.validation.activatedCampaignCount !== 0) persistedStateError("TRANSITION_SEED_STATE_INVALID");
    }
  } else {
    if (!next.evidence.continuityEpochComplete && JSON.stringify(next.continuityEpoch) !== JSON.stringify(previous.continuityEpoch)) persistedStateError("TRANSITION_INCOMPLETE_EPOCH_CHANGED");
    const expectedEpochChanged = continuityEpochChanged(previous.continuityEpoch, next.continuityEpoch);
    const expectedObservationGap = nextMs - previousMs > ACCOUNT_SHADOW_POLICY.maximumObservationGapMs;
    const expectedContinuityGap = expectedEpochChanged || expectedObservationGap;
    if (expectedContinuityGap) {
      const expectedGapStatus = expectedEpochChanged ? "CONTINUITY_EPOCH_CHANGED" : "OBSERVATION_INTERVAL_GAP";
      if (next.evidence.status !== expectedGapStatus || !next.evidenceHoldActive || next.evidence.liveEvidenceAccepted) persistedStateError("TRANSITION_CONTINUITY_GAP_PROJECTION");
    } else if (next.evidence.status === "CONTINUITY_EPOCH_CHANGED" || next.evidence.status === "OBSERVATION_INTERVAL_GAP") {
      persistedStateError("TRANSITION_FALSE_CONTINUITY_GAP");
    }

    if (next.evidenceHoldActive) {
      const expectedHoldCurrent = {
        ...previous.current,
        pendingHighWaterUsdt: null,
        action: "OBSERVE_ONLY_EVIDENCE_HOLD",
        actionChangedAt: previous.current.action === "OBSERVE_ONLY_EVIDENCE_HOLD" ? previous.current.actionChangedAt : next.sourceAsOf,
      };
      requireProjectedCurrent(next.current, expectedHoldCurrent, "TRANSITION_HOLD_CURRENT");
      if (next.pendingHigh !== null || next.lastValidActualMarkedEquityUsdt !== previous.lastValidActualMarkedEquityUsdt) persistedStateError("TRANSITION_HOLD_PATH_CHANGED");
    } else if (nextSourceDay !== previous.current.dayKey) {
      if (!next.evidence.liveEvidenceAccepted || next.evidence.status !== "PRICE_SIDE_EVIDENCE_ACCEPTED") persistedStateError("TRANSITION_DAY_RESET_REQUIRES_LIVE_EVIDENCE");
      const equity = next.current.actualMarkedEquityUsdt;
      const stress = next.current.actualStressStopEquityUsdt;
      const expectedResetAction = "OBSERVE_ONLY_NO_CHANGE";
      const expectedResetCurrent = {
        dayKey: nextSourceDay,
        dayBaselineKind: "FIRST_VALID_SNAPSHOT_AFTER_CST_MIDNIGHT",
        baselineEquityUsdt: equity,
        actualMarkedEquityUsdt: equity,
        shadowMarkedEquityUsdt: equity,
        actualStressStopEquityUsdt: stress,
        shadowStressStopEquityUsdt: stress,
        confirmedHighWaterUsdt: equity,
        pendingHighWaterUsdt: null,
        protectionFloorUsdt: equity,
        peakProfitFraction: 0,
        lockFraction: 0,
        runnerFraction: 1,
        effectiveExposureFraction: 1,
        distanceToFloorUsdt: 0,
        stressFloorGapUsdt: round(stress - equity),
        tier: "T0",
        action: expectedResetAction,
        actionChangedAt: previous.current.action === expectedResetAction ? previous.current.actionChangedAt : next.sourceAsOf,
      };
      requireProjectedCurrent(next.current, expectedResetCurrent, "TRANSITION_DAY_RESET_CURRENT");
      if (next.pendingHigh !== null || next.lastValidActualMarkedEquityUsdt !== equity || next.activeCampaign !== null) persistedStateError("TRANSITION_DAY_RESET_STATE_INVALID");
    } else {
      if (!next.evidence.liveEvidenceAccepted || next.evidence.status !== "PRICE_SIDE_EVIDENCE_ACCEPTED") persistedStateError("TRANSITION_LIVE_FRAME_EVIDENCE_INVALID");
      const resumedAfterHold = previous.evidenceHoldActive || previous.lastValidActualMarkedEquityUsdt == null;
      const actual = next.current.actualMarkedEquityUsdt;
      const actualStress = next.current.actualStressStopEquityUsdt;
      const shadow = resumedAfterHold
        ? previous.current.shadowMarkedEquityUsdt
        : round(previous.current.shadowMarkedEquityUsdt + previous.current.effectiveExposureFraction * (actual - previous.lastValidActualMarkedEquityUsdt));
      let confirmedHighWater = previous.current.confirmedHighWaterUsdt;
      let pendingHigh = resumedAfterHold ? null : structuredClone(previous.pendingHigh);
      if (shadow > confirmedHighWater) {
        if (!pendingHigh) pendingHigh = { startedAt: nextMs, candidateEquityUsdt: shadow, frameFingerprint: next.lastFrameFingerprint };
        const distinctFrame = next.lastFrameFingerprint !== pendingHigh.frameFingerprint;
        if (distinctFrame && nextMs - pendingHigh.startedAt >= ACCOUNT_SHADOW_POLICY.highWaterConfirmationMs) {
          confirmedHighWater = round(Math.max(confirmedHighWater, Math.min(pendingHigh.candidateEquityUsdt, shadow)));
          pendingHigh = null;
        }
      } else {
        pendingHigh = null;
      }
      const baseline = previous.current.baselineEquityUsdt;
      const peakProfitFraction = Math.max(0, (Math.max(baseline, confirmedHighWater) - baseline) / baseline);
      const tier = tierFor(peakProfitFraction);
      const baseFloor = baseline + tier.lockFraction * Math.max(0, confirmedHighWater - baseline);
      const preActionShadowStress = shadow + previous.current.effectiveExposureFraction * (actualStress - actual);
      const stressEscalated = tier.lockFraction > 0 && preActionShadowStress < baseFloor;
      const calculatedLockFraction = Math.min(ACCOUNT_SHADOW_POLICY.maximumLockFraction, tier.lockFraction + (stressEscalated ? ACCOUNT_SHADOW_POLICY.stressLockIncrementFraction : 0));
      const lockFraction = round(Math.max(previous.current.lockFraction, calculatedLockFraction));
      const runnerFraction = round(Math.min(previous.current.runnerFraction, 1 - lockFraction));
      const protectionFloor = round(Math.max(previous.current.protectionFloorUsdt, baseline + lockFraction * Math.max(0, confirmedHighWater - baseline)));
      let effectiveExposureFraction = previous.current.effectiveExposureFraction;
      let shadowStress = shadow + effectiveExposureFraction * (actualStress - actual);
      let action = tier.lockFraction === 0 ? "OBSERVE_ONLY_NO_CHANGE" : "OBSERVE_ONLY_RUNNER_PRESERVED";
      if (tier.lockFraction > 0 && shadow <= protectionFloor) action = "OBSERVE_ONLY_REVIEW_LOCK_BREACH";
      else if (tier.lockFraction > 0 && shadowStress < protectionFloor) action = "OBSERVE_ONLY_REVIEW_STRESS_GAP";
      else if (tier.lockFraction > 0 && shadow - protectionFloor <= baseline * 0.002) action = "OBSERVE_ONLY_NEAR_FLOOR";
      if ((action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" || action === "OBSERVE_ONLY_REVIEW_STRESS_GAP") && effectiveExposureFraction > runnerFraction) {
        effectiveExposureFraction = round(runnerFraction);
        shadowStress = shadow + effectiveExposureFraction * (actualStress - actual);
      } else if (tier.lockFraction > 0 && effectiveExposureFraction <= runnerFraction && action === "OBSERVE_ONLY_RUNNER_PRESERVED") {
        action = "OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE";
      }
      const expectedLiveCurrent = {
        dayKey: previous.current.dayKey,
        dayBaselineKind: previous.current.dayBaselineKind,
        baselineEquityUsdt: baseline,
        actualMarkedEquityUsdt: actual,
        shadowMarkedEquityUsdt: shadow,
        actualStressStopEquityUsdt: actualStress,
        shadowStressStopEquityUsdt: round(shadowStress),
        confirmedHighWaterUsdt: confirmedHighWater,
        pendingHighWaterUsdt: pendingHigh ? round(pendingHigh.candidateEquityUsdt) : null,
        protectionFloorUsdt: protectionFloor,
        peakProfitFraction: round(peakProfitFraction),
        lockFraction,
        runnerFraction,
        effectiveExposureFraction,
        distanceToFloorUsdt: round(shadow - protectionFloor),
        stressFloorGapUsdt: round(shadowStress - protectionFloor),
        tier: tier.id,
        action,
        actionChangedAt: previous.current.action === action ? previous.current.actionChangedAt : next.sourceAsOf,
      };
      requireProjectedCurrent(next.current, expectedLiveCurrent, "TRANSITION_LIVE_CURRENT");
      if (JSON.stringify(next.pendingHigh) !== JSON.stringify(pendingHigh) || next.lastValidActualMarkedEquityUsdt !== actual) persistedStateError("TRANSITION_LIVE_PATH_INVALID");
    }
  }

  const sameActiveDay = previous.prospectiveStart != null && next.prospectiveStart != null && previous.current.dayKey === next.current.dayKey;
  if (sameActiveDay) {
    if (next.current.baselineEquityUsdt !== previous.current.baselineEquityUsdt) persistedStateError("TRANSITION_BASELINE_CHANGED");
    if (next.current.confirmedHighWaterUsdt < previous.current.confirmedHighWaterUsdt || next.current.protectionFloorUsdt < previous.current.protectionFloorUsdt || next.current.lockFraction < previous.current.lockFraction) persistedStateError("TRANSITION_PROTECTION_REGRESSED");
    if (next.current.runnerFraction > previous.current.runnerFraction || next.current.effectiveExposureFraction > previous.current.effectiveExposureFraction) persistedStateError("TRANSITION_EXPOSURE_EXPANDED");
    const exposureChanged = next.current.effectiveExposureFraction !== previous.current.effectiveExposureFraction;
    const interventionAction = next.current.action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" || next.current.action === "OBSERVE_ONLY_REVIEW_STRESS_GAP";
    if (exposureChanged && (!interventionAction || next.current.effectiveExposureFraction !== next.current.runnerFraction || next.current.effectiveExposureFraction >= previous.current.effectiveExposureFraction)) persistedStateError("TRANSITION_EXPOSURE_CHANGE_INVALID");
    if (interventionAction && previous.current.effectiveExposureFraction > next.current.runnerFraction && next.current.effectiveExposureFraction !== next.current.runnerFraction) persistedStateError("TRANSITION_INTERVENTION_REDUCTION_MISSING");
    if (next.evidenceHoldActive) {
      for (const field of ["baselineEquityUsdt", "shadowMarkedEquityUsdt", "confirmedHighWaterUsdt", "protectionFloorUsdt", "lockFraction", "runnerFraction", "effectiveExposureFraction"]) {
        if (next.current[field] !== previous.current[field]) persistedStateError(`TRANSITION_HOLD_CHANGED_${field}`);
      }
    } else {
      const highWaterIncreased = next.current.confirmedHighWaterUsdt > previous.current.confirmedHighWaterUsdt;
      if (highWaterIncreased) {
        const expectedHighWater = previous.pendingHigh == null
          ? null
          : round(Math.max(previous.current.confirmedHighWaterUsdt, Math.min(previous.pendingHigh.candidateEquityUsdt, next.current.shadowMarkedEquityUsdt)));
        if (previous.pendingHigh == null || nextMs - previous.pendingHigh.startedAt < ACCOUNT_SHADOW_POLICY.highWaterConfirmationMs || next.lastFrameFingerprint === previous.pendingHigh.frameFingerprint || next.pendingHigh != null || next.current.confirmedHighWaterUsdt !== expectedHighWater) persistedStateError("TRANSITION_HIGH_WATER_CONFIRMATION_INVALID");
      } else if (next.current.shadowMarkedEquityUsdt > previous.current.confirmedHighWaterUsdt) {
        if (previous.pendingHigh == null) {
          if (next.pendingHigh == null || next.pendingHigh.startedAt !== nextMs || next.pendingHigh.candidateEquityUsdt !== next.current.shadowMarkedEquityUsdt || next.pendingHigh.frameFingerprint !== next.lastFrameFingerprint) persistedStateError("TRANSITION_PENDING_HIGH_START_INVALID");
        } else if (JSON.stringify(next.pendingHigh) !== JSON.stringify(previous.pendingHigh)) persistedStateError("TRANSITION_PENDING_HIGH_CHANGED");
      } else if (next.pendingHigh != null) persistedStateError("TRANSITION_PENDING_HIGH_NOT_CLEARED");
    }
  }
  const expectedRecoveryRebaseCount = previous.recoveryRebaseCount + (sameActiveDay && previous.evidenceHoldActive && !next.evidenceHoldActive ? 1 : 0);
  if (next.recoveryRebaseCount !== expectedRecoveryRebaseCount) persistedStateError("TRANSITION_RECOVERY_REBASE_COUNT");
  const continuityGap = previous.prospectiveStart != null && (continuityEpochChanged(previous.continuityEpoch, next.continuityEpoch) || nextMs - previousMs > ACCOUNT_SHADOW_POLICY.maximumObservationGapMs);
  if (continuityGap) {
    if (!next.evidenceHoldActive || next.continuityGapCount !== previous.continuityGapCount + 1 || next.evidence.continuityGapDetected !== true) persistedStateError("TRANSITION_CONTINUITY_GAP_NOT_HELD");
  } else if (next.continuityGapCount !== previous.continuityGapCount) persistedStateError("TRANSITION_CONTINUITY_GAP_COUNT_CHANGED");
  if (previous.prospectiveStart != null && next.current.dayKey !== previous.current.dayKey && next.evidence.liveEvidenceAccepted !== true) persistedStateError("TRANSITION_DAY_RESET_WITHOUT_VALID_EVIDENCE");
  const campaignStarted = previous.activeCampaign == null && next.activeCampaign != null;
  if (next.validation.activatedCampaignCount !== previous.validation.activatedCampaignCount + (campaignStarted ? 1 : 0)) persistedStateError("TRANSITION_ACTIVATED_CAMPAIGN_COUNT");
  if (sameActiveDay) {
    let expectedActiveCampaign = null;
    if (previous.activeCampaign) {
      const projected = { activeCampaign: structuredClone(previous.activeCampaign), current: next.current, dayEvidenceExclusions: next.dayEvidenceExclusions };
      if (previous.evidenceHoldActive && !next.evidenceHoldActive) {
        projected.activeCampaign.evidenceEligible = false;
        projected.activeCampaign.exclusionReasons = [...new Set([...projected.activeCampaign.exclusionReasons, "EVIDENCE_GAP_NO_PATH_INTERPOLATION"] )];
      }
      if ((next.current.action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" || next.current.action === "OBSERVE_ONLY_REVIEW_STRESS_GAP") && previous.current.effectiveExposureFraction > next.current.runnerFraction && !projected.activeCampaign.interventionAt) {
        projected.activeCampaign.interventionAt = next.sourceAsOf;
        projected.activeCampaign.interventionAction = next.current.action;
      }
      updateCampaign(projected, { evidence: next.evidence }, { runnerFraction: round(Math.min(previous.current.runnerFraction, 1 - next.current.lockFraction)) }, next.current.lockFraction);
      expectedActiveCampaign = projected.activeCampaign;
    } else if (next.activeCampaign) {
      const exclusionReasons = [...next.dayEvidenceExclusions];
      expectedActiveCampaign = {
        id: `${ACCOUNT_SHADOW_POLICY.experimentId}:${next.current.dayKey}:${nextMs}`,
        dayKey: next.current.dayKey,
        activatedAt: next.sourceAsOf,
        completedAt: null,
        startActualEquityUsdt: next.current.actualMarkedEquityUsdt,
        startShadowEquityUsdt: next.current.shadowMarkedEquityUsdt,
        peakActualEquityUsdt: next.current.actualMarkedEquityUsdt,
        peakShadowEquityUsdt: next.current.shadowMarkedEquityUsdt,
        endActualEquityUsdt: null,
        endShadowEquityUsdt: null,
        maximumLockFraction: next.current.lockFraction,
        minimumRunnerFraction: round(Math.min(previous.current.runnerFraction, 1 - next.current.lockFraction)),
        interventionAt: null,
        interventionAction: null,
        evidenceEligible: next.dayEvidenceExclusions.length === 0,
        promotionEligible: false,
        exclusionReasons,
      };
      if ((next.current.action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" || next.current.action === "OBSERVE_ONLY_REVIEW_STRESS_GAP") && previous.current.effectiveExposureFraction > next.current.runnerFraction) {
        expectedActiveCampaign.interventionAt = next.sourceAsOf;
        expectedActiveCampaign.interventionAction = next.current.action;
      }
    }
    if (JSON.stringify(next.activeCampaign) !== JSON.stringify(expectedActiveCampaign)) persistedStateError("TRANSITION_ACTIVE_CAMPAIGN_INVALID");
  }
  const expectedCompletedCampaigns = structuredClone(previous.completedCampaigns);
  if (previous.current.dayKey !== next.current.dayKey && previous.activeCampaign) {
    const projection = { activeCampaign: structuredClone(previous.activeCampaign), current: previous.current, completedCampaigns: [] };
    finishCampaign(projection, next.sourceAsOf);
    expectedCompletedCampaigns.push(projection.completedCampaigns[0]);
  }
  const retainedExpectedCompletedCampaigns = expectedCompletedCampaigns.slice(-ACCOUNT_SHADOW_POLICY.completedCampaignLimit);
  if (JSON.stringify(next.completedCampaigns) !== JSON.stringify(retainedExpectedCompletedCampaigns)) persistedStateError("TRANSITION_COMPLETED_CAMPAIGNS_INVALID");
  const nextObservationsJson = JSON.stringify(next.observations);
  if (previous.prospectiveStart == null && next.prospectiveStart != null) {
    if (nextObservationsJson !== JSON.stringify([compactObservation(next)])) persistedStateError("TRANSITION_SEED_OBSERVATIONS_INVALID");
  } else {
    const observationProjection = { ...next, observations: structuredClone(previous.observations) };
    addObservation(observationProjection, previous.current.action !== next.current.action);
    if (nextObservationsJson !== JSON.stringify(observationProjection.observations)) persistedStateError("TRANSITION_OBSERVATIONS_INVALID");
  }
  return next;
}

function seedState(observation) {
  if (!observation.evidence.liveEvidenceAccepted || observation.actualMarkedEquityUsdt == null || observation.actualStressStopEquityUsdt == null) {
    throw new Error("ACCOUNT_SHADOW_INITIAL_EVIDENCE_INELIGIBLE");
  }
  const equity = observation.actualMarkedEquityUsdt;
  const state = {
    schemaVersion: ACCOUNT_SHADOW_POLICY.schemaVersion,
    experimentId: ACCOUNT_SHADOW_POLICY.experimentId,
    authorizationId: ACCOUNT_SHADOW_POLICY.authorizationId,
    status: ACCOUNT_SHADOW_POLICY.status,
    prospectiveStart: observation.sourceAsOf,
    sourceAsOf: observation.sourceAsOf,
    lastFrameFingerprint: observation.frameFingerprint,
    policy: ACCOUNT_SHADOW_POLICY,
    boundary: {
      executionInfluence: false,
      ordersOrPositionsAffected: false,
      strategyOrRiskChanged: false,
      automaticPromotionAllowed: false,
      historicalBackfillAllowed: false,
      counterfactualModel: "ACCOUNT_EQUITY_DELTA_SCALED_BY_RETAINED_RUNNER_FRACTION_AFTER_SHADOW_INTERVENTION",
      valuationScope: ACCOUNT_SHADOW_POLICY.valuationScope,
      mayBlockEntries: false,
      mayResizePositions: false,
      mayMoveStops: false,
      maySubmitOrders: false,
    },
    evidence: observation.evidence,
    continuityEpoch: observation.continuityEpoch,
    current: {
      dayKey: observation.dayKey,
      dayBaselineKind: "PROSPECTIVE_FIRST_VALID_SNAPSHOT",
      baselineEquityUsdt: equity,
      actualMarkedEquityUsdt: equity,
      shadowMarkedEquityUsdt: equity,
      actualStressStopEquityUsdt: observation.actualStressStopEquityUsdt,
      shadowStressStopEquityUsdt: observation.actualStressStopEquityUsdt,
      confirmedHighWaterUsdt: equity,
      pendingHighWaterUsdt: null,
      protectionFloorUsdt: equity,
      peakProfitFraction: 0,
      lockFraction: 0,
      runnerFraction: 1,
      effectiveExposureFraction: 1,
      distanceToFloorUsdt: 0,
      stressFloorGapUsdt: round(observation.actualStressStopEquityUsdt - equity),
      tier: "T0",
      action: observation.evidence.liveEvidenceAccepted ? "OBSERVE_ONLY_BASELINE_SEEDED" : "OBSERVE_ONLY_EVIDENCE_HOLD",
      actionChangedAt: observation.sourceAsOf,
    },
    pendingHigh: null,
    dayEvidenceExclusions: dayExclusions([], observation.evidence),
    lastValidActualMarkedEquityUsdt: observation.evidence.liveEvidenceAccepted ? equity : null,
    evidenceHoldActive: !observation.evidence.liveEvidenceAccepted,
    recoveryRebaseCount: 0,
    continuityGapCount: 0,
    activeCampaign: null,
    completedCampaigns: [],
    observations: [],
    validation: {
      activatedCampaignCount: 0,
      completedCampaignCount: 0,
      eligibleCompletedCampaignCount: 0,
      excludedCompletedCampaignCount: 0,
      givebackReductionFraction: null,
      netOutcomeRetentionFraction: null,
      trendGainRetentionFraction: null,
      baselineNetOutcomeUsdt: 0,
      shadowNetOutcomeUsdt: 0,
      gates: { sample: false, giveback: false, netOutcome: false, trendRetention: false },
      status: "INDICATIVE_WAITING_MINIMUM_CAMPAIGNS",
      automaticPromotionAllowed: false,
    },
  };
  addObservation(state, true);
  return state;
}

function seedWaitingState(observation) {
  const state = {
    schemaVersion: ACCOUNT_SHADOW_POLICY.schemaVersion,
    experimentId: ACCOUNT_SHADOW_POLICY.experimentId,
    authorizationId: ACCOUNT_SHADOW_POLICY.authorizationId,
    status: ACCOUNT_SHADOW_POLICY.status,
    prospectiveStart: null,
    sourceAsOf: observation.sourceAsOf,
    lastFrameFingerprint: observation.frameFingerprint,
    policy: ACCOUNT_SHADOW_POLICY,
    boundary: {
      executionInfluence: false,
      ordersOrPositionsAffected: false,
      strategyOrRiskChanged: false,
      automaticPromotionAllowed: false,
      historicalBackfillAllowed: false,
      counterfactualModel: "ACCOUNT_EQUITY_DELTA_SCALED_BY_RETAINED_RUNNER_FRACTION_AFTER_SHADOW_INTERVENTION",
      valuationScope: ACCOUNT_SHADOW_POLICY.valuationScope,
      mayBlockEntries: false,
      mayResizePositions: false,
      mayMoveStops: false,
      maySubmitOrders: false,
    },
    evidence: observation.evidence,
    continuityEpoch: observation.continuityEpoch,
    current: {
      dayKey: observation.dayKey,
      dayBaselineKind: "WAITING_FIRST_VALID_FORWARD_SNAPSHOT",
      baselineEquityUsdt: null,
      actualMarkedEquityUsdt: null,
      shadowMarkedEquityUsdt: null,
      actualStressStopEquityUsdt: null,
      shadowStressStopEquityUsdt: null,
      confirmedHighWaterUsdt: null,
      pendingHighWaterUsdt: null,
      protectionFloorUsdt: null,
      peakProfitFraction: 0,
      lockFraction: 0,
      runnerFraction: 1,
      effectiveExposureFraction: 1,
      distanceToFloorUsdt: null,
      stressFloorGapUsdt: null,
      tier: "T0",
      action: "OBSERVE_ONLY_EVIDENCE_HOLD",
      actionChangedAt: observation.sourceAsOf,
    },
    pendingHigh: null,
    dayEvidenceExclusions: dayExclusions([], observation.evidence),
    lastValidActualMarkedEquityUsdt: null,
    evidenceHoldActive: true,
    recoveryRebaseCount: 0,
    continuityGapCount: 0,
    activeCampaign: null,
    completedCampaigns: [],
    observations: [],
    validation: {
      activatedCampaignCount: 0,
      completedCampaignCount: 0,
      eligibleCompletedCampaignCount: 0,
      excludedCompletedCampaignCount: 0,
      givebackReductionFraction: null,
      netOutcomeRetentionFraction: null,
      trendGainRetentionFraction: null,
      baselineNetOutcomeUsdt: 0,
      shadowNetOutcomeUsdt: 0,
      gates: { sample: false, giveback: false, netOutcome: false, trendRetention: false },
      status: "INDICATIVE_WAITING_FIRST_VALID_FORWARD_SNAPSHOT",
      automaticPromotionAllowed: false,
    },
  };
  addObservation(state, true);
  return state;
}

function advanceAccountShadowCore(previousState, observation) {
  if (!previousState) return observation.evidence.liveEvidenceAccepted ? seedState(observation) : seedWaitingState(observation);
  const previousSourceMs = Date.parse(String(previousState.sourceAsOf ?? ""));
  if (Number.isFinite(previousSourceMs) && observation.sourceMs <= previousSourceMs) return previousState;

  if (!previousState.prospectiveStart) {
    if (observation.evidence.liveEvidenceAccepted) return seedState(observation);
    const waiting = structuredClone(previousState);
    waiting.sourceAsOf = observation.sourceAsOf;
    waiting.lastFrameFingerprint = observation.frameFingerprint;
    waiting.evidence = observation.evidence;
    waiting.dayEvidenceExclusions = dayExclusions([], observation.evidence);
    waiting.continuityEpoch = observation.continuityEpoch;
    waiting.current.dayKey = observation.dayKey;
    addObservation(waiting);
    return waiting;
  }

  const epochChanged = continuityEpochChanged(previousState.continuityEpoch, observation.continuityEpoch);
  const observationGap = Number.isFinite(previousSourceMs) && observation.sourceMs - previousSourceMs > ACCOUNT_SHADOW_POLICY.maximumObservationGapMs;
  const continuityGap = epochChanged || observationGap;
  if (continuityGap) {
    observation = {
      ...observation,
      evidence: {
        ...observation.evidence,
        status: epochChanged ? "CONTINUITY_EPOCH_CHANGED" : "OBSERVATION_INTERVAL_GAP",
        liveEvidenceAccepted: false,
        analysisEligible: false,
        validationEligible: false,
        promotionEligible: false,
        continuityGapDetected: true,
        limitations: [...new Set([
          ...observation.evidence.limitations,
          epochChanged ? "FORWARD_CONNECTION_EPOCH_CHANGED" : "UNOBSERVED_INTERVAL_EXCEEDED",
        ])],
      },
    };
  }

  const state = structuredClone(previousState);
  const priorAction = state.current.action;
  state.sourceAsOf = observation.sourceAsOf;
  state.lastFrameFingerprint = observation.frameFingerprint;
  state.evidence = observation.evidence;
  state.dayEvidenceExclusions = dayExclusions(state.dayEvidenceExclusions, observation.evidence);
  if (continuityEpochComplete(observation.continuityEpoch)) state.continuityEpoch = observation.continuityEpoch;
  if (continuityGap) state.continuityGapCount = Number(state.continuityGapCount ?? 0) + 1;

  if (!observation.evidence.liveEvidenceAccepted || observation.actualMarkedEquityUsdt == null || observation.actualStressStopEquityUsdt == null) {
    state.evidenceHoldActive = true;
    state.pendingHigh = null;
    state.current.pendingHighWaterUsdt = null;
    state.current.action = "OBSERVE_ONLY_EVIDENCE_HOLD";
    if (priorAction !== state.current.action) state.current.actionChangedAt = observation.sourceAsOf;
    if (state.activeCampaign) updateCampaign(state, observation, tierFor(state.current.peakProfitFraction), state.current.lockFraction);
    addObservation(state, priorAction !== state.current.action);
    summarizeValidation(state);
    return state;
  }

  if (observation.dayKey !== state.current.dayKey) {
    finishCampaign(state, observation.sourceAsOf);
    state.dayEvidenceExclusions = dayExclusions([], observation.evidence);
    state.current.dayKey = observation.dayKey;
    state.current.dayBaselineKind = "FIRST_VALID_SNAPSHOT_AFTER_CST_MIDNIGHT";
    state.current.baselineEquityUsdt = observation.actualMarkedEquityUsdt;
    state.current.actualMarkedEquityUsdt = observation.actualMarkedEquityUsdt;
    state.current.shadowMarkedEquityUsdt = observation.actualMarkedEquityUsdt;
    state.current.actualStressStopEquityUsdt = observation.actualStressStopEquityUsdt;
    state.current.shadowStressStopEquityUsdt = observation.actualStressStopEquityUsdt;
    state.current.confirmedHighWaterUsdt = observation.actualMarkedEquityUsdt;
    state.current.protectionFloorUsdt = observation.actualMarkedEquityUsdt;
    state.current.peakProfitFraction = 0;
    state.current.lockFraction = 0;
    state.current.runnerFraction = 1;
    state.current.effectiveExposureFraction = 1;
    state.pendingHigh = null;
  } else {
    const resumedAfterHold = state.evidenceHoldActive || state.lastValidActualMarkedEquityUsdt == null;
    state.current.actualMarkedEquityUsdt = observation.actualMarkedEquityUsdt;
    state.current.actualStressStopEquityUsdt = observation.actualStressStopEquityUsdt;
    if (resumedAfterHold) {
      if (state.activeCampaign) {
        state.activeCampaign.evidenceEligible = false;
        state.activeCampaign.exclusionReasons = [...new Set([...state.activeCampaign.exclusionReasons, "EVIDENCE_GAP_NO_PATH_INTERPOLATION"] )];
      }
      state.recoveryRebaseCount = Number(state.recoveryRebaseCount ?? 0) + 1;
      state.pendingHigh = null;
    } else {
      const actualDelta = observation.actualMarkedEquityUsdt - state.lastValidActualMarkedEquityUsdt;
      state.current.shadowMarkedEquityUsdt = round(state.current.shadowMarkedEquityUsdt + state.current.effectiveExposureFraction * actualDelta);
    }
  }
  state.evidenceHoldActive = false;
  state.lastValidActualMarkedEquityUsdt = observation.actualMarkedEquityUsdt;

  const shadowEquity = state.current.shadowMarkedEquityUsdt;
  if (shadowEquity > state.current.confirmedHighWaterUsdt) {
    if (!state.pendingHigh) state.pendingHigh = { startedAt: observation.sourceMs, candidateEquityUsdt: shadowEquity, frameFingerprint: observation.frameFingerprint };
    const distinctFrame = observation.frameFingerprint !== state.pendingHigh.frameFingerprint;
    if (distinctFrame && observation.sourceMs - state.pendingHigh.startedAt >= ACCOUNT_SHADOW_POLICY.highWaterConfirmationMs) {
      const twoFrameFloor = Math.min(state.pendingHigh.candidateEquityUsdt, shadowEquity);
      state.current.confirmedHighWaterUsdt = round(Math.max(state.current.confirmedHighWaterUsdt, twoFrameFloor));
      state.pendingHigh = null;
    }
  } else {
    state.pendingHigh = null;
  }
  state.current.pendingHighWaterUsdt = state.pendingHigh ? round(state.pendingHigh.candidateEquityUsdt) : null;

  const baseline = state.current.baselineEquityUsdt;
  const highWater = Math.max(baseline, state.current.confirmedHighWaterUsdt);
  const peakProfitFraction = baseline > 0 ? Math.max(0, (highWater - baseline) / baseline) : 0;
  const tier = tierFor(peakProfitFraction);
  const baseFloor = baseline + tier.lockFraction * Math.max(0, highWater - baseline);
  const preActionShadowStress = shadowEquity + state.current.effectiveExposureFraction * (observation.actualStressStopEquityUsdt - observation.actualMarkedEquityUsdt);
  const stressEscalated = tier.lockFraction > 0 && preActionShadowStress < baseFloor;
  const calculatedLockFraction = Math.min(
    ACCOUNT_SHADOW_POLICY.maximumLockFraction,
    tier.lockFraction + (stressEscalated ? ACCOUNT_SHADOW_POLICY.stressLockIncrementFraction : 0),
  );
  const effectiveLockFraction = round(Math.max(state.current.lockFraction, calculatedLockFraction));
  const effectiveRunnerFraction = round(Math.min(state.current.runnerFraction, 1 - effectiveLockFraction));
  const candidateFloor = baseline + effectiveLockFraction * Math.max(0, highWater - baseline);
  state.current.protectionFloorUsdt = round(Math.max(state.current.protectionFloorUsdt, candidateFloor));
  state.current.peakProfitFraction = round(peakProfitFraction);
  state.current.lockFraction = round(effectiveLockFraction);
  state.current.runnerFraction = round(effectiveRunnerFraction);
  state.current.tier = tier.id;

  if (tier.lockFraction > 0 && !state.activeCampaign) startCampaign(state, observation, { ...tier, runnerFraction: effectiveRunnerFraction }, effectiveLockFraction);

  let shadowStress = shadowEquity + state.current.effectiveExposureFraction * (observation.actualStressStopEquityUsdt - observation.actualMarkedEquityUsdt);
  let action = tier.lockFraction === 0 ? "OBSERVE_ONLY_NO_CHANGE" : "OBSERVE_ONLY_RUNNER_PRESERVED";
  if (tier.lockFraction > 0 && shadowEquity <= state.current.protectionFloorUsdt) action = "OBSERVE_ONLY_REVIEW_LOCK_BREACH";
  else if (tier.lockFraction > 0 && shadowStress < state.current.protectionFloorUsdt) action = "OBSERVE_ONLY_REVIEW_STRESS_GAP";
  else if (tier.lockFraction > 0 && shadowEquity - state.current.protectionFloorUsdt <= baseline * 0.002) action = "OBSERVE_ONLY_NEAR_FLOOR";

  if ((action === "OBSERVE_ONLY_REVIEW_LOCK_BREACH" || action === "OBSERVE_ONLY_REVIEW_STRESS_GAP") && state.current.effectiveExposureFraction > effectiveRunnerFraction) {
    state.current.effectiveExposureFraction = round(effectiveRunnerFraction);
    shadowStress = shadowEquity + state.current.effectiveExposureFraction * (observation.actualStressStopEquityUsdt - observation.actualMarkedEquityUsdt);
    if (state.activeCampaign && !state.activeCampaign.interventionAt) {
      state.activeCampaign.interventionAt = observation.sourceAsOf;
      state.activeCampaign.interventionAction = action;
    }
  } else if (tier.lockFraction > 0 && state.current.effectiveExposureFraction <= effectiveRunnerFraction && action === "OBSERVE_ONLY_RUNNER_PRESERVED") {
    action = "OBSERVE_ONLY_PROTECTED_RUNNER_ACTIVE";
  }

  state.current.shadowStressStopEquityUsdt = round(shadowStress);
  state.current.distanceToFloorUsdt = round(shadowEquity - state.current.protectionFloorUsdt);
  state.current.stressFloorGapUsdt = round(shadowStress - state.current.protectionFloorUsdt);
  state.current.action = action;
  if (priorAction !== action) state.current.actionChangedAt = observation.sourceAsOf;
  updateCampaign(state, observation, { ...tier, runnerFraction: effectiveRunnerFraction }, effectiveLockFraction);
  summarizeValidation(state);
  addObservation(state, priorAction !== action);
  return state;
}

function pendingProof(state) {
  if (!state.pendingHigh) return null;
  return {
    sourceAsOf: new Date(state.pendingHigh.startedAt).toISOString(),
    candidateEquityUsdt: state.pendingHigh.candidateEquityUsdt,
    frameFingerprint: state.pendingHigh.frameFingerprint,
    baseHighWaterUsdt: state.current.confirmedHighWaterUsdt,
    continuityEpoch: structuredClone(state.continuityEpoch),
  };
}

function rollingInput(state, realizedEquityUsdt) {
  return { sourceAsOf: state.sourceAsOf, frameFingerprint: state.lastFrameFingerprint,
    accepted: state.evidence.liveEvidenceAccepted, validationEligible: state.evidence.validationEligible,
    actualEquityUsdt: state.current.actualMarkedEquityUsdt,
    stressEquityUsdt: state.current.actualStressStopEquityUsdt, realizedEquityUsdt };
}

export function advanceAccountShadow(previousState, snapshot, observedAtMs = Date.now()) {
  if (previousState) validatePersistedAccountShadowState(previousState);
  const observation = deriveAccountObservation(snapshot, observedAtMs);
  const state = advanceAccountShadowCore(previousState, observation);
  if (state === previousState) return state;
  state.pendingHighProof = state.pendingHigh == null ? null
    : previousState?.pendingHigh != null && state.pendingHigh.startedAt === previousState.pendingHigh.startedAt
      ? structuredClone(previousState.pendingHighProof) : pendingProof(state);
  state.rollingAccount = advanceRollingAccount(previousState?.rollingAccount ?? null, rollingInput(state, observation.realizedEquityUsdt));
  return state;
}
