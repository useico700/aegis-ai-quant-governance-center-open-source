export const ABNORMAL_LOSS_GATE_AUTHORIZATION_ID = "OWNER-DIRECTIVE-V2-V3-V4-ABNORMAL-SINGLE-LOSS-CIRCUIT-BREAKER-20260825";

export const ABNORMAL_LOSS_GATE_POLICY = Object.freeze({
  yellowLossRExclusive: 1.2,
  orangeLossRExclusive: 1.5,
  redLossRExclusive: 2,
  orangeHealthyCyclesRequired: 3,
});

const LEVEL_PRIORITY = Object.freeze({ CLEAR: 0, YELLOW: 1, ORANGE: 2, RED: 3 });
const RED_INTEGRITY_REASON = /UNPROTECTED|PROTECTIVE_STOP_(?:MISSING|INTEGRITY)|UNKNOWN_(?:ORDER|ALGO)|DUPLICATE_(?:ORDER|ALGO)|ROLLBACK_AFTER_(?:STOP|PROTECTION)|PROTECTION_(?:FAILURE|INTEGRITY)/i;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function time(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function outcomeId(row) {
  return String(row?.outcomeId ?? row?.id ?? `${row?.symbol ?? "UNKNOWN"}:${time(row?.closedAt) ?? "UNKNOWN"}:${row?.netPnl ?? "UNKNOWN"}`);
}

export function validateAbnormalLossGateAuthorization(authorization, scope) {
  if (authorization?.authorizationId !== ABNORMAL_LOSS_GATE_AUTHORIZATION_ID || authorization?.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED") {
    throw new Error("ABNORMAL_LOSS_GATE_AUTHORIZATION_INVALID");
  }
  if (!authorization?.appliesTo?.includes(scope)) throw new Error(`ABNORMAL_LOSS_GATE_SCOPE_NOT_AUTHORIZED_${scope}`);
  const policy = authorization.policy;
  if (policy?.riskBasis !== "IMMUTABLE_INITIAL_PLANNED_RISK_USDT_AT_ENTRY" || policy?.forwardOnly !== true) {
    throw new Error("ABNORMAL_LOSS_GATE_POLICY_INVALID");
  }
  const thresholds = policy.thresholds;
  if (Number(thresholds?.yellowLossRExclusive) !== ABNORMAL_LOSS_GATE_POLICY.yellowLossRExclusive ||
      Number(thresholds?.orangeLossRExclusive) !== ABNORMAL_LOSS_GATE_POLICY.orangeLossRExclusive ||
      Number(thresholds?.redLossRExclusive) !== ABNORMAL_LOSS_GATE_POLICY.redLossRExclusive ||
      Number(policy?.orangeAction?.consecutiveHealthyReconciledCyclesRequired) !== ABNORMAL_LOSS_GATE_POLICY.orangeHealthyCyclesRequired ||
      policy?.redAction?.manualOwnerAuthorizedResetRequired !== true || policy?.redAction?.automaticReleaseAllowed !== false) {
    throw new Error("ABNORMAL_LOSS_GATE_THRESHOLDS_INVALID");
  }
  const activatedAt = time(authorization.activatedAt);
  if (!(activatedAt > 0)) throw new Error("ABNORMAL_LOSS_GATE_ACTIVATION_INVALID");
  return { authorizationId: authorization.authorizationId, activatedAt };
}

export function initialAbnormalLossGateState({ scope, activatedAt, authorizationId = ABNORMAL_LOSS_GATE_AUTHORIZATION_ID } = {}) {
  return {
    schemaVersion: 1,
    authorizationId,
    scope,
    activatedAt,
    status: "CLEAR",
    entriesBlocked: false,
    manualResetRequired: false,
    orangeHealthyCycles: 0,
    orangeHealthyCyclesRequired: ABNORMAL_LOSS_GATE_POLICY.orangeHealthyCyclesRequired,
    evaluatedOutcomeIds: [],
    recentAssessments: [],
    activeTrigger: null,
    lastEvaluatedAt: null,
  };
}

export function assessClosedOutcome(row, { scope = null } = {}) {
  const id = outcomeId(row);
  const closedAt = time(row?.closedAt);
  const netPnlUsdt = finite(row?.netPnl ?? row?.netPnlUsdt);
  const plannedMaximumLossUsdt = finite(row?.initialPlannedRiskUsdt);
  const actualLossUsdt = netPnlUsdt === null ? null : Math.max(0, -netPnlUsdt);
  const lossR = actualLossUsdt !== null && plannedMaximumLossUsdt > 0 ? actualLossUsdt / plannedMaximumLossUsdt : null;
  const reason = String(row?.closeReason ?? row?.exitReason ?? row?.reason ?? "");
  const executionEvidence = String(row?.executionEvidence ?? "");
  // The V3 gateway historically emitted this exact name without an explicit
  // integrity flag. Scope the compatibility repair to the authorized V3 lane.
  const v3ProtectionRollback = scope === "ORION_V3_BINANCE_DEMO"
    && reason === "PROTECTIVE_STOP_SUBMISSION_FAILED_ENTRY_ROLLBACK";
  const protectionIntegrityFailure = RED_INTEGRITY_REASON.test(`${reason}|${executionEvidence}`) || row?.protectionIntegrityFailure === true || v3ProtectionRollback;
  const missingLossEvidence = netPnlUsdt === null || (actualLossUsdt > 0 && !(plannedMaximumLossUsdt > 0));
  let level = "CLEAR";
  let trigger = null;
  if (protectionIntegrityFailure || missingLossEvidence) {
    level = "RED";
    trigger = protectionIntegrityFailure ? "PROTECTION_OR_ORDER_INTEGRITY_FAILURE" : "CLOSED_OUTCOME_LOSS_EVIDENCE_INVALID";
  } else if (lossR > ABNORMAL_LOSS_GATE_POLICY.redLossRExclusive) {
    level = "RED";
    trigger = "LOSS_EXCEEDED_2_00R";
  } else if (lossR > ABNORMAL_LOSS_GATE_POLICY.orangeLossRExclusive) {
    level = "ORANGE";
    trigger = "LOSS_EXCEEDED_1_50R";
  } else if (lossR > ABNORMAL_LOSS_GATE_POLICY.yellowLossRExclusive) {
    level = "YELLOW";
    trigger = "LOSS_EXCEEDED_1_20R";
  }
  return {
    outcomeId: id,
    symbol: String(row?.symbol ?? "UNKNOWN"),
    closedAt,
    closeReason: reason || null,
    plannedMaximumLossUsdt,
    thresholdsUsdt: plannedMaximumLossUsdt > 0 ? {
      yellow: plannedMaximumLossUsdt * ABNORMAL_LOSS_GATE_POLICY.yellowLossRExclusive,
      orange: plannedMaximumLossUsdt * ABNORMAL_LOSS_GATE_POLICY.orangeLossRExclusive,
      red: plannedMaximumLossUsdt * ABNORMAL_LOSS_GATE_POLICY.redLossRExclusive,
    } : null,
    netPnlUsdt,
    actualLossUsdt,
    actualLossR: lossR,
    excessLossUsdt: actualLossUsdt !== null && plannedMaximumLossUsdt > 0 ? Math.max(0, actualLossUsdt - plannedMaximumLossUsdt) : null,
    level,
    trigger,
  };
}

function strongest(assessments) {
  return [...assessments].sort((left, right) => LEVEL_PRIORITY[right.level] - LEVEL_PRIORITY[left.level] || Number(right.actualLossR ?? 0) - Number(left.actualLossR ?? 0))[0] ?? null;
}

export function evaluateAbnormalLossGate({ priorState, closedOutcomes = [], now = Date.now(), reconciled = true, scope, activatedAt, authorizationId = ABNORMAL_LOSS_GATE_AUTHORIZATION_ID } = {}) {
  const initial = initialAbnormalLossGateState({ scope, activatedAt, authorizationId });
  const prior = priorState?.authorizationId === authorizationId && priorState?.scope === scope && Number(priorState?.activatedAt) === Number(activatedAt)
    ? { ...initial, ...priorState }
    : initial;
  const evaluated = new Set(prior.evaluatedOutcomeIds ?? []);
  const assessments = (closedOutcomes ?? [])
    .map((row) => assessClosedOutcome(row, { scope }))
    .filter((row) => row.closedAt !== null && row.closedAt >= Number(activatedAt) && !evaluated.has(row.outcomeId))
    .sort((left, right) => left.closedAt - right.closedAt || left.outcomeId.localeCompare(right.outcomeId));
  for (const row of assessments) evaluated.add(row.outcomeId);
  const abnormal = assessments.filter((row) => row.level !== "CLEAR");
  const strongestNew = strongest(abnormal);
  let status = prior.status;
  let activeTrigger = prior.activeTrigger;
  let orangeHealthyCycles = Number(prior.orangeHealthyCycles ?? 0);

  if (prior.status === "RED") {
    status = "RED";
  } else if (strongestNew?.level === "RED") {
    status = "RED";
    activeTrigger = strongestNew;
    orangeHealthyCycles = 0;
  } else if (strongestNew?.level === "ORANGE") {
    status = "ORANGE";
    activeTrigger = strongestNew;
    orangeHealthyCycles = 0;
  } else if (prior.status === "ORANGE") {
    if (strongestNew?.level === "YELLOW") orangeHealthyCycles = 0;
    else if (reconciled) orangeHealthyCycles += 1;
    else orangeHealthyCycles = 0;
    if (orangeHealthyCycles >= ABNORMAL_LOSS_GATE_POLICY.orangeHealthyCyclesRequired) {
      status = "CLEAR";
      activeTrigger = null;
      orangeHealthyCycles = ABNORMAL_LOSS_GATE_POLICY.orangeHealthyCyclesRequired;
    }
  } else if (strongestNew?.level === "YELLOW") {
    status = "YELLOW";
    activeTrigger = strongestNew;
    orangeHealthyCycles = 0;
  } else if (prior.status === "YELLOW") {
    status = "CLEAR";
    activeTrigger = null;
  } else {
    status = "CLEAR";
  }

  return {
    ...prior,
    status,
    entriesBlocked: status !== "CLEAR",
    manualResetRequired: status === "RED",
    orangeHealthyCycles,
    evaluatedOutcomeIds: [...evaluated].slice(-10_000),
    recentAssessments: [...(prior.recentAssessments ?? []), ...assessments].slice(-20),
    activeTrigger,
    lastEvaluatedAt: now,
  };
}
