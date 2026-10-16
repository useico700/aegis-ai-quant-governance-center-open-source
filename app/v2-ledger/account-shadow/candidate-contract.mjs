// Display-only validation: no runtime control, orders, or strategy dependencies.
export const CANDIDATE_STUDY_ID = "V2-ACCOUNT-COMPOUND-ABC-20260906";
export const CANDIDATE_REVISION = "V2-ACCOUNT-COMPOUND-C1-20260906";
export const CANDIDATE_ROW_PREFIX = "v2-account-compound-c1-20260906:report:";
const fail = (why) => { throw new Error(`CANDIDATE_${why}`); };
function keys(x, required) {
  if (!x || typeof x !== "object" || Array.isArray(x) || Object.keys(x).sort().join() !== [...required].sort().join()) fail("FIELDS");
}
function integer(x) { if (!Number.isSafeInteger(x) || x < 0) fail("COUNT"); }
function number(x, nullable = false, nonnegative = false) {
  if (x === null && nullable) return;
  if (typeof x !== "number" || !Number.isFinite(x) || (nonnegative && x < 0)) fail("NUMBER");
}
function iso(x) {
  if (typeof x !== "string" || !Number.isFinite(Date.parse(x)) || new Date(x).toISOString() !== x) fail("TIME");
}
const ACCOUNT = ["currency","initialEquityUsdt","cashRealizedEquityUsdt","liquidationNetEquityUsdt","confirmedHighEquityUsdt","protectionFloorUsdt","remainingProtectionCushionUsdt","existingStressRiskUsdt","availableCandidateRiskUsdt","portfolioPlannedRiskUsdt","grossNotionalUsdt","openPositionCount","closedPositionCount","cumulativeEntryFeesUsdt","cumulativeExitFeesUsdt","cumulativeFundingUsdt","realizedPnlUsdt","markToMarketNetPnlUsdt","cumulativeRebalanceCostsUsdt","maximumDrawdownFraction"];
const NULLABLE = ["initialEquityUsdt","cashRealizedEquityUsdt","liquidationNetEquityUsdt","confirmedHighEquityUsdt","protectionFloorUsdt","remainingProtectionCushionUsdt"];
const NONNEGATIVE = ["remainingProtectionCushionUsdt","existingStressRiskUsdt","availableCandidateRiskUsdt","portfolioPlannedRiskUsdt","grossNotionalUsdt","cumulativeEntryFeesUsdt","cumulativeExitFeesUsdt","cumulativeRebalanceCostsUsdt","maximumDrawdownFraction"];
const MAX_INPUT_AGE = { baselineAccount:30000,eventLedger:30000,quote:1000,depth:1000,funding:120000,metadata:86400000 };
const close = (a, b) => Math.abs(a - b) <= 1e-5;
export function validateCandidateReport(r, receivedAt = null) {
  keys(r, ["schemaVersion","studyId","candidateRevision","sequence","sourceAsOf","startedAt","status","sourceScope","account","inputs","gates","validation"]);
  if (r.schemaVersion !== 1 || r.studyId !== CANDIDATE_STUDY_ID || r.candidateRevision !== CANDIDATE_REVISION) fail("IDENTITY");
  integer(r.sequence); if (r.sequence < 1 || r.sequence > 999999999999) fail("SEQUENCE");
  iso(r.sourceAsOf);
  if (receivedAt !== null && Date.parse(r.sourceAsOf) > receivedAt + 1000) fail("FUTURE_REPORT");
  // Old, durable pending reports may be retried. GET explicitly labels stale feeds.
  if (r.startedAt !== null) { iso(r.startedAt); if (r.startedAt > r.sourceAsOf) fail("START_TIME"); }
  if (!["WAITING_HEALTHY_FORWARD_BASELINE","ACTIVE_OBSERVE_ONLY","EVIDENCE_HOLD","RED_LATCHED_MANUAL_RESET_REQUIRED"].includes(r.status)) fail("STATUS");
  const s = r.sourceScope;
  keys(s, ["mode","baselineLedger","fullIndependentSignalUniverse","baselineRejectedOpportunitiesSynthesized","historicalBackfillAllowed","carryInDisposition","carryInPositionCount","inferenceBoundary"]);
  if (s.mode !== "BASELINE_EXECUTED_OPPORTUNITY_SUBSET_ONLY" || s.baselineLedger !== "V2_APPEND_ONLY_PAPER_LEDGER_READ_ONLY"
    || s.fullIndependentSignalUniverse !== false || s.baselineRejectedOpportunitiesSynthesized !== false || s.historicalBackfillAllowed !== false
    || s.carryInDisposition !== "EXCLUDED_NOT_COPIED_AS_CANDIDATE_ENTRIES" || s.inferenceBoundary !== "INCOMPLETE_FOR_FULL_ACCOUNT_OR_ANNUAL_PROBABILITY_INFERENCE") fail("OPPORTUNITY_SCOPE");
  integer(s.carryInPositionCount);
  const a = r.account; keys(a, ACCOUNT);
  if (a.currency !== "USDT") fail("CURRENCY");
  for (const k of ACCOUNT.filter((k) => k !== "currency")) number(a[k], NULLABLE.includes(k), NONNEGATIVE.includes(k));
  for (const k of ["openPositionCount","closedPositionCount"]) integer(a[k]);
  if (a.openPositionCount > 10) fail("POSITION_CAP");
  if (r.startedAt === null && (a.openPositionCount || a.closedPositionCount || NULLABLE.some((k) => a[k] !== null))) fail("PRESTART_ACCOUNT");
  if (r.startedAt === null && ACCOUNT.some((k) => k !== "currency" && !NULLABLE.includes(k) && a[k] !== 0)) fail("PRESTART_ACTIVITY");
  if (r.startedAt !== null) {
    if (NULLABLE.some((k) => a[k] === null) || !(a.initialEquityUsdt > 0)) fail("STARTED_ACCOUNT_INCOMPLETE");
    if (!close(a.cashRealizedEquityUsdt, a.initialEquityUsdt + a.realizedPnlUsdt)
      || !close(a.liquidationNetEquityUsdt, a.cashRealizedEquityUsdt + a.markToMarketNetPnlUsdt)) fail("ACCOUNT_EQUATION");
    if (a.openPositionCount === 0 && [a.grossNotionalUsdt,a.existingStressRiskUsdt,a.portfolioPlannedRiskUsdt,a.markToMarketNetPnlUsdt].some((n) => !close(n,0))) fail("FLAT_ACCOUNT");
    if (a.confirmedHighEquityUsdt < a.initialEquityUsdt) fail("HIGH_WATERMARK");
    const floor = a.confirmedHighEquityUsdt >= 1.05 * a.initialEquityUsdt
      ? a.initialEquityUsdt + .6 * (a.confirmedHighEquityUsdt - a.initialEquityUsdt) : .99 * a.initialEquityUsdt;
    if (!close(a.protectionFloorUsdt, floor)) fail("FLOOR_EQUATION");
    const capital = Math.max(0, Math.min(a.cashRealizedEquityUsdt, a.liquidationNetEquityUsdt));
    const cushion = Math.max(0, a.liquidationNetEquityUsdt - a.protectionFloorUsdt);
    if (Math.abs(a.remainingProtectionCushionUsdt - cushion) > 1e-5) fail("CUSHION_EQUATION");
    const capacity = Math.min(.0075 * capital, Math.max(0, .25 * cushion - a.existingStressRiskUsdt), Math.max(0, .05 * capital - a.portfolioPlannedRiskUsdt));
    if (a.availableCandidateRiskUsdt > capacity + 1e-5) fail("RISK_CAPACITY");
  }
  keys(r.inputs, ["baselineAccount","eventLedger","quote","depth","funding","metadata"]);
  for (const [name, input] of Object.entries(r.inputs)) {
    const extra = name === "baselineAccount" ? [] : name === "metadata" ? ["sha256"] : ["cursor"];
    keys(input, ["status","sourceAsOf","freshnessMs",...extra]);
    if (!["WAITING","HEALTHY","STALE","GAP","INVALID"].includes(input.status)) fail("INPUT_STATUS");
    if (input.sourceAsOf !== null) { iso(input.sourceAsOf); if (input.sourceAsOf > r.sourceAsOf) fail("INPUT_FUTURE"); }
    if (input.freshnessMs !== null) integer(input.freshnessMs);
    if ("sha256" in input && input.sha256 !== null && !/^[0-9a-f]{64}$/.test(input.sha256)) fail("INPUT_HASH");
    if ("cursor" in input && input.cursor !== null && !(typeof input.cursor === "string" && input.cursor.length <= 100) && !(Number.isSafeInteger(input.cursor) && input.cursor >= 0)) fail("INPUT_CURSOR");
    if (input.sourceAsOf !== null && input.freshnessMs !== null && input.freshnessMs !== Date.parse(r.sourceAsOf) - Date.parse(input.sourceAsOf)) fail("INPUT_AGE_EQUATION");
    if (input.status === "HEALTHY" && (input.sourceAsOf === null || input.freshnessMs === null || input.freshnessMs > MAX_INPUT_AGE[name]
      || ("cursor" in input && (input.cursor === null || input.cursor === "")) || ("sha256" in input && input.sha256 === null))) fail("INPUT_HEALTH_PROOF");
  }
  const g = r.gates;
  keys(g, ["executionInputAllowed","kellySizingActivationAllowed","automaticPromotionAllowed","realizedOnlyCompounding","correlatedRiskShared","riskLimits","strategyInheritance","abnormalLoss","blockers"]);
  if ([g.executionInputAllowed,g.kellySizingActivationAllowed,g.automaticPromotionAllowed].some((v) => v !== false) || g.realizedOnlyCompounding !== true || g.correlatedRiskShared !== true) fail("EXECUTION_BOUNDARY");
  const limits = { candidateFraction:.0075,perIntersectionFraction:.01,portfolioFraction:.05,cushionUseFraction:.25,maximumLeverage:4,maximumPositions:10 };
  keys(g.riskLimits, Object.keys(limits)); for (const [k,v] of Object.entries(limits)) if (g.riskLimits[k] !== v) fail("LIMITS");
  keys(g.strategyInheritance, ["baselineRevision","r13","r15","r19","r20","r21","r22"]);
  if (g.strategyInheritance.baselineRevision !== "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" || Object.entries(g.strategyInheritance).some(([k,v]) => k !== "baselineRevision" && v !== "REQUIRED")) fail("STRATEGY");
  keys(g.abnormalLoss, ["status","yellowAboveR","orangeAboveR","redAboveR","automaticRedReleaseAllowed"]);
  if (!["CLEAR","YELLOW","ORANGE","RED"].includes(g.abnormalLoss.status) || g.abnormalLoss.yellowAboveR !== 1.2 || g.abnormalLoss.orangeAboveR !== 1.5 || g.abnormalLoss.redAboveR !== 2 || g.abnormalLoss.automaticRedReleaseAllowed !== false) fail("BREAKER");
  if (!Array.isArray(g.blockers) || g.blockers.length > 40 || g.blockers.some((v) => typeof v !== "string" || !/^[A-Z][A-Z0-9_]{1,119}$/.test(v))) fail("BLOCKERS");
  const blocked = g.blockers.length > 0 || g.abnormalLoss.status !== "CLEAR" || Object.values(r.inputs).some((i) => i.status !== "HEALTHY");
  if ((r.status !== "ACTIVE_OBSERVE_ONLY" || blocked) && a.availableCandidateRiskUsdt !== 0) fail("BLOCKED_RISK");
  if (r.status === "ACTIVE_OBSERVE_ONLY" && (r.startedAt === null || blocked)) fail("ACTIVE_WITH_BLOCKER");
  if (g.abnormalLoss.status === "RED" && r.status !== "RED_LATCHED_MANUAL_RESET_REQUIRED") fail("RED_STATUS");
  const v = r.validation;
  keys(v, ["performanceValidated","annualTargetProbability","annualTargetProbabilityPublicationAllowed","eligibleCompletedCampaigns","excludedCompletedCampaigns","minimumEligibleCampaigns","completeIndependentSignalUniverse","missingDataInvented"]);
  if (v.performanceValidated !== false || v.annualTargetProbability !== null || v.annualTargetProbabilityPublicationAllowed !== false || v.completeIndependentSignalUniverse !== false || v.missingDataInvented !== false || v.minimumEligibleCampaigns !== 20) fail("UNPROVEN_PERFORMANCE");
  integer(v.eligibleCompletedCampaigns); integer(v.excludedCompletedCampaigns);
  if (r.startedAt === null && (v.eligibleCompletedCampaigns || v.excludedCompletedCampaigns)) fail("PRESTART_CAMPAIGNS");
  return r;
}
export function validateCandidateTransition(previous, next) {
  validateCandidateReport(next);
  if (!previous) { if (next.sequence !== 1) fail("FIRST_SEQUENCE"); return next; }
  validateCandidateReport(previous);
  if (next.sequence !== previous.sequence + 1 || next.sourceAsOf <= previous.sourceAsOf) fail("NONCONTIGUOUS_REPORT");
  if (previous.startedAt !== null && (next.startedAt !== previous.startedAt || next.account.initialEquityUsdt !== previous.account.initialEquityUsdt)) fail("COHORT_RESET");
  if (previous.gates.abnormalLoss.status === "RED" && next.gates.abnormalLoss.status !== "RED") fail("RED_AUTO_RELEASE");
  if (next.sourceScope.carryInPositionCount < previous.sourceScope.carryInPositionCount) fail("CARRY_IN_REWIND");
  if (Number.isSafeInteger(previous.inputs.eventLedger.cursor) && (!Number.isSafeInteger(next.inputs.eventLedger.cursor) || next.inputs.eventLedger.cursor < previous.inputs.eventLedger.cursor)) fail("EVENT_CURSOR_REWIND");
  for (const k of ["closedPositionCount","cumulativeEntryFeesUsdt","cumulativeExitFeesUsdt","cumulativeRebalanceCostsUsdt","maximumDrawdownFraction"])
    if (next.account[k] + 1e-6 < previous.account[k]) fail("COUNTER_REWIND");
  for (const k of ["eligibleCompletedCampaigns","excludedCompletedCampaigns"]) if (next.validation[k] < previous.validation[k]) fail("COUNTER_REWIND");
  if (previous.startedAt !== null) for (const k of ["confirmedHighEquityUsdt","protectionFloorUsdt"]) if (next.account[k] + 1e-6 < previous.account[k]) fail("RATCHET_REWIND");
  return next;
}
export function candidateRowId(sequence) {
  integer(sequence); if (sequence < 1 || sequence > 999999999999) fail("SEQUENCE");
  return `${CANDIDATE_ROW_PREFIX}${String(sequence).padStart(12,"0")}`;
}
