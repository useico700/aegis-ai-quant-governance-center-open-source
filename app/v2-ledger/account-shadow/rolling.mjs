// Forward account-level research. Outputs never reach an execution adapter.
export const ROLLING_POLICY = Object.freeze({
  revision: "ACCOUNT-ROLLING-LOCK-1",
  initialLossCushionFraction: 0.01,
  confirmationMs: 30_000,
  stressCushionUseFraction: 0.8,
  desiredRunnerFraction: 0.25,
  recoveryCooldownMs: 30 * 60_000,
  recoveryCushionFraction: 0.005,
  maximumRecoveryStep: 0.25,
  compoundShareOfFundedReserve: 0.25,
  performanceValidated: false,
  executionInfluence: false,
});

const round = (n) => Number(n.toFixed(8));
const bounded = (n) => Math.max(0, Math.min(1, n));
const day = (ms) => new Date(ms + 28_800_000).toISOString().slice(0, 10);
const lockFor = (gain) => gain >= 0.05 ? 0.75 : gain >= 0.03 ? 0.7 : gain >= 0.02 ? 0.65 : gain >= 0.01 ? 0.5 : 0;
const proof = (input, equity, high) => ({
  sourceAsOf: input.sourceAsOf, frameFingerprint: input.frameFingerprint,
  equityUsdt: equity, previousHighUsdt: high,
});

export function advanceRollingAccount(previous, input) {
  const ms = Date.parse(input.sourceAsOf);
  if (!Number.isFinite(ms)) throw new Error("ROLLING_SOURCE_INVALID");
  if (previous && ms <= Date.parse(previous.sourceAsOf)) return previous;
  if (!input.accepted) {
    if (!previous) return null;
    return { ...previous, sourceAsOf: input.sourceAsOf, evidenceHold: true, pending: null, pendingAnchor: null,
      recoveryReadySince: null, validationEligible: false, status: "EVIDENCE_HOLD" };
  }
  const actual = input.actualEquityUsdt;
  const stress = input.stressEquityUsdt;
  const realized = input.realizedEquityUsdt;
  if (![actual, stress, realized].every(Number.isFinite) || stress > actual + 1e-7) throw new Error("ROLLING_VALUATION_INVALID");
  if (!previous && !(actual > 0 && realized > 0)) throw new Error("ROLLING_SEED_INVALID");
  const state = previous ? structuredClone(previous) : {
    policy: ROLLING_POLICY,
    startedAt: input.sourceAsOf, sourceAsOf: input.sourceAsOf, dayKey: day(ms),
    initialEquityUsdt: actual, initialRealizedEquityUsdt: realized,
    actualEquityUsdt: actual, realizedEquityUsdt: realized, stressEquityUsdt: stress,
    shadowEquityUsdt: actual, lastActualEquityUsdt: actual,
    confirmedHighUsdt: actual, protectionFloorUsdt: round(actual * (1 - ROLLING_POLICY.initialLossCushionFraction)),
    dayStartShadowEquityUsdt: actual, dailyNetChangeUsdt: 0,
    pending: null, pendingAnchor: null, evidenceHold: false,
    exposureFraction: 1, desiredRunnerFraction: ROLLING_POLICY.desiredRunnerFraction,
    retainedProfitTargetUsdt: 0, fundedReserveReferenceUsdt: 0,
    compoundBaseReferenceUsdt: actual, profitAtRiskUsdt: round(actual * ROLLING_POLICY.initialLossCushionFraction),
    shadowStressEquityUsdt: stress, floorShortfallUsdt: 0,
    recoveryReadySince: null, lastExposureChangeAt: input.sourceAsOf,
    lockFraction: 0, validationEligible: input.validationEligible,
    status: "GROWTH_OBSERVATION", kellyStatus: "DISABLED_PENDING_FULL_COST_AND_INDEPENDENT_RETURN_SAMPLES",
    executionInfluence: false, performanceValidated: false,
  };
  // Freeze missing paths rather than inventing the return over a data gap.
  state.shadowEquityUsdt = previous && !previous.evidenceHold
    ? round(previous.shadowEquityUsdt + previous.exposureFraction * (actual - previous.lastActualEquityUsdt))
    : state.shadowEquityUsdt;
  state.sourceAsOf = input.sourceAsOf;
  state.actualEquityUsdt = actual;
  state.realizedEquityUsdt = realized;
  state.stressEquityUsdt = stress;
  state.lastActualEquityUsdt = actual;
  state.evidenceHold = false;
  state.validationEligible = state.validationEligible && input.validationEligible && !previous?.evidenceHold;
  if (state.dayKey !== day(ms)) {
    state.dayKey = day(ms);
    // Only the reporting baseline rolls. Wealth, HWM, floor and exposure carry over.
    state.dayStartShadowEquityUsdt = previous.shadowEquityUsdt;
  }
  state.dailyNetChangeUsdt = round(state.shadowEquityUsdt - state.dayStartShadowEquityUsdt);
  let newConfirmedHigh = false;
  if (state.shadowEquityUsdt > state.confirmedHighUsdt) {
    if (!state.pending) {
      state.pending = proof(input, state.shadowEquityUsdt, state.confirmedHighUsdt);
      state.pendingAnchor = structuredClone(state.pending);
    }
    if (input.frameFingerprint !== state.pending.frameFingerprint && ms - Date.parse(state.pending.sourceAsOf) >= ROLLING_POLICY.confirmationMs) {
      state.confirmedHighUsdt = round(Math.max(state.confirmedHighUsdt, Math.min(state.pending.equityUsdt, state.shadowEquityUsdt)));
      state.pending = null;
      state.pendingAnchor = null;
      newConfirmedHigh = true;
    }
  } else { state.pending = null; state.pendingAnchor = null; }
  state.lockFraction = lockFor((state.confirmedHighUsdt - state.initialEquityUsdt) / state.initialEquityUsdt);
  if (state.lockFraction > 0) state.protectionFloorUsdt = round(Math.max(state.protectionFloorUsdt,
    state.initialEquityUsdt + state.lockFraction * (state.confirmedHighUsdt - state.initialEquityUsdt)));
  state.profitAtRiskUsdt = round(Math.max(0, state.shadowEquityUsdt - state.protectionFloorUsdt));
  const stressLoss = Math.max(0, actual - stress);
  const safeExposure = state.profitAtRiskUsdt <= 0 ? 0
    : stressLoss > 0 ? bounded(ROLLING_POLICY.stressCushionUseFraction * state.profitAtRiskUsdt / stressLoss) : 1;
  if (safeExposure < state.exposureFraction) {
    // Round down: rounding up would exceed the modeled stress budget.
    state.exposureFraction = Math.floor(safeExposure * 1e8) / 1e8;
    state.lastExposureChangeAt = input.sourceAsOf;
    state.recoveryReadySince = null;
  } else {
    const cushionHealthy = state.profitAtRiskUsdt >= state.initialEquityUsdt * ROLLING_POLICY.recoveryCushionFraction
      && input.validationEligible && !previous?.evidenceHold;
    state.recoveryReadySince = cushionHealthy ? state.recoveryReadySince ?? input.sourceAsOf : null;
    if (previous && newConfirmedHigh && state.recoveryReadySince
      && ms - Date.parse(state.recoveryReadySince) >= ROLLING_POLICY.recoveryCooldownMs
      && ms - Date.parse(state.lastExposureChangeAt) >= ROLLING_POLICY.recoveryCooldownMs) {
      const nextExposure = Math.floor(Math.min(1, safeExposure, state.exposureFraction + ROLLING_POLICY.maximumRecoveryStep) * 1e8) / 1e8;
      if (nextExposure > state.exposureFraction) {
        state.exposureFraction = nextExposure;
        state.lastExposureChangeAt = input.sourceAsOf;
        state.recoveryReadySince = null;
      }
    }
  }
  state.shadowStressEquityUsdt = round(state.shadowEquityUsdt - state.exposureFraction * stressLoss);
  state.floorShortfallUsdt = round(Math.max(0, state.protectionFloorUsdt - state.shadowEquityUsdt));
  state.retainedProfitTargetUsdt = round(Math.max(0, state.protectionFloorUsdt - state.initialEquityUsdt));
  state.fundedReserveReferenceUsdt = round(Math.min(state.retainedProfitTargetUsdt,
    Math.max(0, realized - state.initialRealizedEquityUsdt), Math.max(0, state.shadowEquityUsdt - state.initialEquityUsdt)));
  state.compoundBaseReferenceUsdt = round(Math.max(0, Math.min(realized, state.shadowEquityUsdt,
    state.initialEquityUsdt + ROLLING_POLICY.compoundShareOfFundedReserve * state.fundedReserveReferenceUsdt)));
  state.status = state.floorShortfallUsdt > 0 ? "FLOOR_BREACHED_REVIEW"
    : state.exposureFraction < ROLLING_POLICY.desiredRunnerFraction ? "STRESS_OVERRIDES_RUNNER"
      : state.exposureFraction < 1 ? "PROTECTED_RUNNER" : "GROWTH_OBSERVATION";
  return state;
}

export function validateRollingAccount(state, sourceAsOf) {
  if (state == null) return null;
  const fail = () => { throw new Error("ROLLING_STATE_INVALID"); };
  if (JSON.stringify(state.policy) !== JSON.stringify(ROLLING_POLICY) || state.sourceAsOf !== sourceAsOf
    || state.executionInfluence !== false || state.performanceValidated !== false
    || state.kellyStatus !== "DISABLED_PENDING_FULL_COST_AND_INDEPENDENT_RETURN_SAMPLES") fail();
  const numeric = ["initialEquityUsdt", "initialRealizedEquityUsdt", "actualEquityUsdt", "realizedEquityUsdt", "stressEquityUsdt", "shadowEquityUsdt", "lastActualEquityUsdt", "confirmedHighUsdt", "protectionFloorUsdt", "dayStartShadowEquityUsdt", "dailyNetChangeUsdt", "exposureFraction", "desiredRunnerFraction", "retainedProfitTargetUsdt", "fundedReserveReferenceUsdt", "compoundBaseReferenceUsdt", "profitAtRiskUsdt", "shadowStressEquityUsdt", "floorShortfallUsdt", "lockFraction"];
  const keys = [...numeric, "policy", "startedAt", "sourceAsOf", "dayKey", "pending", "pendingAnchor", "evidenceHold", "recoveryReadySince", "lastExposureChangeAt", "validationEligible", "status", "kellyStatus", "executionInfluence", "performanceValidated"];
  if (Object.keys(state).length !== keys.length || keys.some((k) => !Object.hasOwn(state, k))) fail();
  for (const key of numeric) if (!Number.isFinite(state[key])) fail();
  const near = (a, b) => Math.abs(a - b) < 1e-7;
  const gain = Math.max(0, state.confirmedHighUsdt - state.initialEquityUsdt);
  const lock = lockFor(gain / state.initialEquityUsdt);
  const floor = lock > 0 ? state.initialEquityUsdt + lock * gain : state.initialEquityUsdt * (1 - ROLLING_POLICY.initialLossCushionFraction);
  const retained = Math.max(0, floor - state.initialEquityUsdt);
  const funded = Math.min(retained, Math.max(0, state.realizedEquityUsdt - state.initialRealizedEquityUsdt), Math.max(0, state.shadowEquityUsdt - state.initialEquityUsdt));
  if (!near(state.protectionFloorUsdt, floor) || state.lockFraction !== lock || !near(state.retainedProfitTargetUsdt, retained)
    || !near(state.fundedReserveReferenceUsdt, funded)
    || !near(state.compoundBaseReferenceUsdt, Math.max(0, Math.min(state.realizedEquityUsdt, state.shadowEquityUsdt, state.initialEquityUsdt + ROLLING_POLICY.compoundShareOfFundedReserve * funded)))
    || !near(state.profitAtRiskUsdt, Math.max(0, state.shadowEquityUsdt - floor))
    || !near(state.floorShortfallUsdt, Math.max(0, floor - state.shadowEquityUsdt))
    || !near(state.shadowStressEquityUsdt, state.shadowEquityUsdt - state.exposureFraction * Math.max(0, state.actualEquityUsdt - state.stressEquityUsdt))
    || state.stressEquityUsdt > state.actualEquityUsdt + 1e-7
    || state.desiredRunnerFraction !== ROLLING_POLICY.desiredRunnerFraction) fail();
  if (state.dayKey < day(Date.parse(state.startedAt)) || state.dayKey > day(Date.parse(sourceAsOf)) || (!state.evidenceHold && state.dayKey !== day(Date.parse(sourceAsOf)))) fail();
  const status = state.evidenceHold ? "EVIDENCE_HOLD" : state.floorShortfallUsdt > 0 ? "FLOOR_BREACHED_REVIEW"
    : state.exposureFraction < ROLLING_POLICY.desiredRunnerFraction ? "STRESS_OVERRIDES_RUNNER"
      : state.exposureFraction < 1 ? "PROTECTED_RUNNER" : "GROWTH_OBSERVATION";
  if (state.status !== status) fail();
  if (!(state.initialEquityUsdt > 0) || state.exposureFraction < 0 || state.exposureFraction > 1
    || state.protectionFloorUsdt > state.confirmedHighUsdt || state.confirmedHighUsdt < state.initialEquityUsdt
    || state.fundedReserveReferenceUsdt < 0 || state.fundedReserveReferenceUsdt > state.retainedProfitTargetUsdt
    || typeof state.validationEligible !== "boolean" || typeof state.evidenceHold !== "boolean") fail();
  for (const key of ["startedAt", "sourceAsOf", "lastExposureChangeAt", "recoveryReadySince"]) {
    if (key === "recoveryReadySince" && state[key] === null) continue;
    if (typeof state[key] !== "string" || !Number.isFinite(Date.parse(state[key])) || Date.parse(state[key]) > Date.parse(sourceAsOf)) fail();
  }
  if ((state.pending === null) !== (state.pendingAnchor === null) || JSON.stringify(state.pending) !== JSON.stringify(state.pendingAnchor)) fail();
  if (state.pending && (state.evidenceHold || Date.parse(state.pending.sourceAsOf) < Date.parse(state.startedAt)
    || Date.parse(state.pending.sourceAsOf) > Date.parse(sourceAsOf) || state.pending.previousHighUsdt !== state.confirmedHighUsdt
    || !(state.pending.equityUsdt > state.confirmedHighUsdt) || typeof state.pending.frameFingerprint !== "string")) fail();
  if (!state.evidenceHold && Math.abs(state.dailyNetChangeUsdt - (state.shadowEquityUsdt - state.dayStartShadowEquityUsdt)) > 1e-7) fail();
  return state;
}
