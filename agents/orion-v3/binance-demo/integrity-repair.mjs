import { assessClosedOutcome, evaluateAbnormalLossGate } from "../../shared/abnormal-loss-gate.mjs";

export const V3_INTEGRITY_REPAIR_ID = "OWNER-DIRECTIVE-V3-HF11-INTEGRITY-REPAIR-20260912";
const SCOPE = "ORION_V3_BINANCE_DEMO";

function latch(gate, trigger, now) {
  return {
    ...gate,
    status: "RED",
    entriesBlocked: true,
    manualResetRequired: true,
    orangeHealthyCycles: 0,
    activeTrigger: gate.status === "RED" && gate.activeTrigger ? gate.activeTrigger : trigger,
    lastEvaluatedAt: now,
  };
}

/** Correct only the authorized stored gate decision; never mutate a trade. */
export function evaluateV3IntegrityGate({ priorState, closedOutcomes = [], managedPositions = {}, repairAuthorization, authority, now, reconciled = true }) {
  if (repairAuthorization?.authorizationId !== V3_INTEGRITY_REPAIR_ID ||
      repairAuthorization?.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" ||
      repairAuthorization?.scope !== SCOPE ||
      repairAuthorization?.baseGateAuthorizationId !== authority?.authorizationId ||
      repairAuthorization?.redLatchRestorationAllowed !== true ||
      repairAuthorization?.redLatchResetAuthorized !== false) throw new Error("V3_INTEGRITY_REPAIR_AUTHORIZATION_INVALID");
  let gate = evaluateAbnormalLossGate({ priorState, closedOutcomes, now, reconciled, scope: SCOPE, ...authority });
  const expected = repairAuthorization.missedProtectionOutcome;
  if (!expected?.outcomeId || !(expected.closedAt >= authority.activatedAt)) throw new Error("V3_INTEGRITY_REPAIR_OUTCOME_SCOPE_INVALID");
  // An appended receipt prevents the same administrative correction from being
  // re-applied after a future separately authorized manual reset.
  if (gate.integrityRepair?.authorizationId !== V3_INTEGRITY_REPAIR_ID) {
    const matches = closedOutcomes.filter((row) => row.outcomeId === expected.outcomeId);
    const row = matches[0];
    const identityKeys = ["outcomeId", "symbol", "closeReason", "openedAt", "closedAt", "entryOrderId", "finalOrderId"];
    const identityMatches = matches.length === 1 && identityKeys.every((key) => String(row[key]) === String(expected[key]));
    const amountsMatch = row && ["initialPlannedRiskUsdt", "netPnl"].every((key) => Number.isFinite(row[key]) && Math.abs(row[key] - expected[key]) < 1e-8);
    if (!identityMatches || !amountsMatch || row.closedAt > now) {
      return latch(gate, { symbol: expected.symbol, outcomeId: expected.outcomeId, trigger: "V3_AUTHORIZED_INTEGRITY_REPAIR_EVIDENCE_MISMATCH", level: "RED", closedAt: null }, now);
    }
    const assessment = assessClosedOutcome(row, { scope: SCOPE });
    if (assessment.level !== "RED") throw new Error("V3_INTEGRITY_REPAIR_CLASSIFICATION_NOT_RED");
    gate = latch(gate, assessment, now);
    gate.integrityRepair = {
      authorizationId: V3_INTEGRITY_REPAIR_ID,
      appliedAt: now,
      outcomeId: expected.outcomeId,
      previousStatus: priorState?.status ?? null,
      correction: "RESTORED_MISSED_FORWARD_PROTECTION_INTEGRITY_RED_LATCH",
      historicalOutcomeModified: false,
    };
    gate.recentAssessments = [...gate.recentAssessments, { ...assessment, reassessmentAuthorizationId: V3_INTEGRITY_REPAIR_ID, reassessedAt: now }].slice(-20);
  }
  // A confirmed protected fill can exceed its authorized budget. Keep its
  // management active while latching entry admission, including after it closes.
  const records = [...Object.values(managedPositions ?? {}), ...closedOutcomes];
  const candidates = records.filter((row) => row.entryIntegrityIncident?.status !== "RESOLVED_BY_OWNER"
    && (row.entryIntegrityIncident || ["BREACHED", "LIMIT_BREACHED"].includes(row.postFillRiskAssessment?.status)));
  const incidents = candidates.map((row) => {
    const value = row.entryIntegrityIncident?.recordedAt ?? row.entryIntegrityIncident?.observedAt ?? row.postFillRiskAssessment?.postFill?.observedAt;
    const observedAt = typeof value === "number" ? value : Date.parse(value ?? "");
    return { row, observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null };
  }).filter(({ observedAt }) => observedAt === null || observedAt >= authority.activatedAt);
  if (incidents.length) {
    const { row: incident, observedAt } = incidents[0];
    gate = latch(gate, {
      symbol: incident.symbol,
      intentId: incident.intentId,
      outcomeId: incident.outcomeId ?? null,
      closedAt: incident.closedAt ?? null,
      observedAt,
      plannedMaximumLossUsdt: incident.initialPlannedRiskUsdt ?? null,
      actualLossUsdt: null,
      actualLossR: null,
      level: "RED",
      trigger: observedAt === null || observedAt > now ? "V3_ENTRY_INTEGRITY_EVENT_TIME_UNVERIFIED" : "V3_POST_FILL_RISK_OR_ENTRY_INTEGRITY_FAILURE",
    }, now);
  }
  return gate;
}
