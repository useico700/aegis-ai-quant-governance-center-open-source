const HF14_REVISION = "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE";
const HF14_COHORT = "ORION-V3-HF14-SINGLE-Z-FORWARD-20260914";

function finite(value) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function sideSign(side) { return side === "BUY" || side === "LONG" || side === 1 ? 1 : side === "SELL" || side === "SHORT" || side === -1 ? -1 : 0; }
function executablePrice(side, quote) { return sideSign(side) === 1 ? finite(quote?.ask ?? quote?.askPrice) : sideSign(side) === -1 ? finite(quote?.bid ?? quote?.bidPrice) : null; }

export function directionalDistance({ side, quote, px, primaryB, primaryC }) {
  const sign = sideSign(side), price = executablePrice(side, quote), intersection = finite(px);
  const b = finite(primaryB), c = finite(primaryC);
  if (!sign || !(price > 0) || !(intersection > 0)) return { status: "UNKNOWN", reason: "PX_OR_EXECUTABLE_BBO_MISSING", price: price ?? null, distanceBps: null, structureZ: null };
  const distanceBps = sign * (price - intersection) / intersection * 10_000;
  const denominator = b !== null && c !== null ? Math.abs(b - c) : null;
  return { status: denominator > 0 ? "KNOWN" : "PARTIAL", reason: denominator > 0 ? null : "FROZEN_PRIMARY_1H_B_C_MISSING", price, distanceBps, structureZ: denominator > 0 ? sign * (price - intersection) / denominator : null, structureDenominator: denominator };
}

export function legacyDisplacementBps({ side, quote, decisionClose }) {
  const price = executablePrice(side, quote), reference = finite(decisionClose);
  return price > 0 && reference > 0 ? Math.abs(price - reference) / reference * 10_000 : null;
}

export function signalReceipt(plan, now = Date.now(), maximumSignalAgeMs = 300000, prospectiveStart = -Infinity) {
  const direction = Number(plan?.entryDecision?.direction), side = direction === 1 ? "BUY" : direction === -1 ? "SELL" : null;
  const statusExpected = direction === 1 ? "CONFIRMED_LONG" : direction === -1 ? "CONFIRMED_SHORT" : null;
  const closeTime = finite(plan?.entryDecision?.decisionBarCloseTime), decisionClose = finite(plan?.entryDecision?.decisionClose);
  const points = plan?.singleZ?.primary?.points;
  const primaryB = finite(points?.B?.price), primaryC = finite(points?.C?.price), px = finite(plan?.intersectionPrice);
  const bConfirmedAt = finite(points?.B?.confirmedAt), cConfirmedAt = finite(points?.C?.confirmedAt), zConfirmedAt = finite(plan?.singleZ?.primary?.confirmedAt);
  const causalTimes = [closeTime, bConfirmedAt, cConfirmedAt, zConfirmedAt];
  const eligible = Boolean(plan?.implementationRevision === HF14_REVISION && plan?.evaluationCohortId === HF14_COHORT && side && plan?.entryDecision?.status === statusExpected && closeTime > 0 && closeTime >= prospectiveStart && closeTime <= now && decisionClose > 0 && px > 0 && primaryB > 0 && primaryC > 0 && Math.abs(primaryB - primaryC) > 0 && causalTimes.every((value) => value !== null && value <= now));
  return {
    signalId: eligible ? `${plan.id}:${closeTime}:${direction}` : null,
    planId: String(plan?.id ?? ""), symbol: String(plan?.symbol ?? ""), side, direction,
    confirmedAt: closeTime, expiresAt: closeTime ? closeTime + maximumSignalAgeMs : null,
    observedAt: now, px, decisionClose, primaryB, primaryC,
    eligible, unknownReason: eligible ? null : "HF14_CAUSAL_SIGNAL_EVIDENCE_INCOMPLETE",
  };
}

export function evaluateObservation({ signal, quote, now, threshold, mode = "PERCENT_BPS", prior = {}, minimumDistanceBps = 5, legacyMaximumBps = 75, continuityComplete = false }) {
  const distance = directionalDistance({ side: signal.side, quote, px: signal.px, primaryB: signal.primaryB, primaryC: signal.primaryC });
  const legacy = legacyDisplacementBps({ side: signal.side, quote, decisionClose: signal.decisionClose });
  const value = mode === "STRUCTURE_Z" ? distance.structureZ : distance.distanceBps;
  const lower = mode === "STRUCTURE_Z" ? minimumDistanceBps / 10_000 * signal.px / Math.abs(signal.primaryB - signal.primaryC) : minimumDistanceBps;
  const expired = Number(now) > Number(signal.expiresAt);
  if (prior.unknownEvidence === true) return prior;
  if (!signal.eligible || !continuityComplete || distance.status !== "KNOWN" || legacy === null || value === null || Number(now) < Number(signal.confirmedAt)) return { ...prior, status: "UNKNOWN", unknownEvidence: true, terminal: true, reason: Number(now) < Number(signal.confirmedAt) ? "OBSERVATION_BEFORE_SIGNAL_CONFIRMATION" : !continuityComplete ? "CAUSAL_TICK_BBO_CONTINUITY_INCOMPLETE" : distance.reason ?? "EVIDENCE_INCOMPLETE", distanceBps: distance.distanceBps, structureZ: distance.structureZ, legacyDisplacementBps: legacy, outcomeVisibleAt: now };
  const tolerance = Math.max(1e-9, Math.abs(threshold) * 1e-12);
  const exceededNow = value > threshold + tolerance;
  const exceeded = prior.exceeded === true || exceededNow;
  const inside = value >= lower - tolerance && value <= threshold + tolerance;
  const legacyPass = legacy <= legacyMaximumBps + Math.max(1e-9, legacyMaximumBps * 1e-12);
  const first = prior.firstEvaluatedAt === undefined;
  let currentArm = prior.currentArm ?? { status: "WAITING", firstEvaluatedAt: now, admittedAt: null };
  let distanceOnlyArm = prior.distanceOnlyArm ?? { status: "UNDECIDED", firstEvaluatedAt: now, admittedAt: null };
  let pullbackArm = prior.pullbackArm ?? { status: "UNDECIDED", firstEvaluatedAt: now, admittedAt: null };
  if (currentArm.status === "WAITING") currentArm = expired ? { ...currentArm, status: "TIMED_OUT", outcomeVisibleAt: now } : legacyPass ? { ...currentArm, status: "ADMITTED", admittedAt: now, outcomeVisibleAt: now } : currentArm;
  if (first) {
    distanceOnlyArm = expired ? { ...distanceOnlyArm, status: "TIMED_OUT", outcomeVisibleAt: now } : inside && legacyPass ? { ...distanceOnlyArm, status: "ADMITTED", admittedAt: now, outcomeVisibleAt: now } : { ...distanceOnlyArm, status: exceededNow ? "REJECTED_OVER_DISTANCE" : !inside ? "REJECTED_BELOW_MINIMUM" : "REJECTED_LEGACY_75BPS", outcomeVisibleAt: now };
    pullbackArm = expired ? { ...pullbackArm, status: "TIMED_OUT", outcomeVisibleAt: now } : inside && legacyPass ? { ...pullbackArm, status: "DIRECT_ADMITTED", admittedAt: now, outcomeVisibleAt: now } : exceededNow ? { ...pullbackArm, status: "WAITING_FOR_PX_PULLBACK", exceededAt: now } : { ...pullbackArm, status: "REJECTED_BELOW_MINIMUM", outcomeVisibleAt: now };
  } else if (["WAITING_FOR_PX_PULLBACK", "WAITING_LEGACY_GATE_AFTER_RETURN"].includes(pullbackArm.status)) {
    if (expired) pullbackArm = { ...pullbackArm, status: "TIMED_OUT", outcomeVisibleAt: now };
    else if (inside && legacyPass) pullbackArm = { ...pullbackArm, status: "PULLBACK_ADMITTED", admittedAt: now, returnedAt: now, outcomeVisibleAt: now };
    else if (inside) pullbackArm = { ...pullbackArm, status: "WAITING_LEGACY_GATE_AFTER_RETURN", returnedAt: pullbackArm.returnedAt ?? now };
  }
  const status = pullbackArm.status;
  return { status, unknownEvidence: false, terminal: ["DIRECT_ADMITTED", "PULLBACK_ADMITTED", "TIMED_OUT", "REJECTED_BELOW_MINIMUM"].includes(status), exceeded, firstEvaluatedAt: prior.firstEvaluatedAt ?? now, currentArm, distanceOnlyArm, pullbackArm, distanceBps: distance.distanceBps, structureZ: distance.structureZ, legacyDisplacementBps: legacy, observedAt: now, outcomeVisibleAt: pullbackArm.outcomeVisibleAt ?? null, expired };
}

export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!(trials > 0) || successes < 0 || successes > trials) return { lower: null, estimate: trials === 0 ? null : successes / trials, upper: null, trials };
  const p = successes / trials, z2 = z * z, denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  return { lower: Math.max(0, center - margin), estimate: p, upper: Math.min(1, center + margin), trials };
}

function seededRandom(seed = 0x9e3779b9) { let state = seed >>> 0; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; }; }
function percentile(values, probability) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * probability, low = Math.floor(position), high = Math.ceil(position); return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low); }

export function blockAdjustedWilson(rows, { blockMs = 14_400_000, iterations = 1000, seed = 0x48463134 } = {}) {
  const usable = rows.filter((row) => Number.isFinite(Number(row.at)) && typeof row.success === "boolean");
  const blocks = new Map();
  for (const row of usable) { const key = Math.floor(Number(row.at) / blockMs); blocks.set(key, (blocks.get(key) ?? []).concat(row)); }
  const grouped = [...blocks.values()], n = usable.length, successes = usable.filter((row) => row.success).length;
  const rawWilson = { ...wilsonInterval(successes, n), assumption: "BERNOULLI_INDEPENDENCE_NOT_ESTABLISHED" };
  if (grouped.length < 2) return { rawTrials: n, rawSuccesses: successes, rawWilson, timeBlockCount: grouped.length, blockBootstrap: { status: "INSUFFICIENT_TIME_BLOCKS", lower: null, estimate: n ? successes / n : null, upper: null, iterations: 0 } };
  const random = seededRandom(seed), estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) { let sampled = []; for (let index = 0; index < grouped.length; index += 1) sampled = sampled.concat(grouped[Math.floor(random() * grouped.length)]); estimates.push(sampled.filter((row) => row.success).length / sampled.length); }
  return { rawTrials: n, rawSuccesses: successes, rawWilson, timeBlockCount: grouped.length, blockBootstrap: { status: "TIME_BLOCK_RESAMPLED", lower: percentile(estimates, 0.025), estimate: n ? successes / n : null, upper: percentile(estimates, 0.975), iterations } };
}

export function summarizeGrid(signals, config) {
  const eligibleSignals = signals.filter((signal) => signal.eligible !== false);
  const rows = [];
  for (const [mode, thresholds] of [["PERCENT_BPS", config.frozenParameterGrid.percentageDistanceBps], ["STRUCTURE_Z", config.frozenParameterGrid.structureDistanceMultipliers]]) {
    for (const threshold of thresholds) {
      const key = `${mode}:${threshold}`;
      const states = eligibleSignals.map((signal) => signal.thresholds?.[key]).filter(Boolean);
      const exceededStates = states.filter((state) => state.exceeded);
      const completedExceeded = exceededStates.filter((state) => (Number.isFinite(finite(state.pullbackArm?.returnedAt)) || state.pullbackArm?.status === "TIMED_OUT") && state.unknownEvidence !== true);
      const physicallyReturned = completedExceeded.filter((state) => Number.isFinite(finite(state.pullbackArm?.returnedAt))).length;
      const admittedAfterReturn = completedExceeded.filter((state) => state.pullbackArm?.status === "PULLBACK_ADMITTED").length;
      const interval = blockAdjustedWilson(completedExceeded.map((state) => ({ at: state.confirmedAt, success: Number.isFinite(finite(state.pullbackArm?.returnedAt)) })), { blockMs: config.statistics.correlationBlockMs });
      const sufficient = completedExceeded.length >= config.statistics.minimumEligibleSignals && interval.timeBlockCount >= config.statistics.minimumIndependentTimeBlocks && interval.blockBootstrap.status === "TIME_BLOCK_RESAMPLED";
      rows.push({ mode, threshold, denominatorEligibleSignals: eligibleSignals.length, currentArmAdmitted: states.filter((s) => s.currentArm?.status === "ADMITTED").length, distanceOnlyArmAdmitted: states.filter((s) => s.distanceOnlyArm?.status === "ADMITTED").length, pullbackArmAdmitted: states.filter((s) => ["DIRECT_ADMITTED", "PULLBACK_ADMITTED"].includes(s.pullbackArm?.status)).length, exceeded: exceededStates.length, completedExceededDenominator: completedExceeded.length, physicalPxIntervalReturns: physicallyReturned, legacyGatePassedPullbackAdmissions: admittedAfterReturn, pendingPullback: states.filter((s) => ["WAITING_FOR_PX_PULLBACK", "WAITING_LEGACY_GATE_AFTER_RETURN"].includes(s.pullbackArm?.status)).length, timedOut: states.filter((s) => s.pullbackArm?.status === "TIMED_OUT").length, unknown: states.filter((s) => s.unknownEvidence).length, physicalReturnRateIntervals: interval, calibrationStatus: sufficient ? "PHYSICAL_RETURN_RATE_EVALUABLE_NOT_A_TRADING_THRESHOLD" : "INSUFFICIENT_EVIDENCE", pnlCalibrationStatus: "UNAVAILABLE_WITHOUT_COMPLETE_FEE_ATTRIBUTED_EXITS", automaticPromotionAllowed: false });
    }
  }
  return rows;
}

export function rollingTimeValidation(signals, config) {
  signals = signals.filter((signal) => signal.eligible !== false);
  const windowMs = config.statistics.rollingValidationWindowMs;
  const times = signals.map((s) => Number(s.confirmedAt)).filter(Number.isFinite);
  if (!times.length) return { status: "INSUFFICIENT_EVIDENCE", folds: [], automaticPromotionAllowed: false };
  const start = Math.floor(Math.min(...times) / windowMs) * windowMs, end = Math.max(...times);
  const folds = [];
  for (let cutoff = start + windowMs; cutoff <= end; cutoff += windowMs) {
    const validationEnd = cutoff + windowMs;
    const censorAt = (rows, boundary) => rows.map((signal) => ({ ...signal, thresholds: Object.fromEntries(Object.entries(signal.thresholds ?? {}).filter(([, state]) => { const visibleAt = finite(state?.outcomeVisibleAt); return visibleAt !== null && visibleAt < boundary; })) }));
    const train = censorAt(signals.filter((s) => s.confirmedAt < cutoff), cutoff);
    const validation = signals.filter((s) => s.confirmedAt >= cutoff && s.confirmedAt < validationEnd);
    const trainGrid = summarizeGrid(train, config), candidates = trainGrid.filter((row) => row.calibrationStatus === "PHYSICAL_RETURN_RATE_EVALUABLE_NOT_A_TRADING_THRESHOLD" && row.physicalReturnRateIntervals.blockBootstrap.lower !== null).sort((a, b) => b.physicalReturnRateIntervals.blockBootstrap.lower - a.physicalReturnRateIntervals.blockBootstrap.lower || a.threshold - b.threshold);
    const selected = candidates[0] ?? null;
    const validationVisible = selected ? censorAt(validation, validationEnd).filter((signal) => signal.thresholds?.[`${selected.mode}:${selected.threshold}`]) : [];
    const validationRow = selected ? summarizeGrid(validationVisible, { ...config, frozenParameterGrid: { percentageDistanceBps: selected.mode === "PERCENT_BPS" ? [selected.threshold] : [], structureDistanceMultipliers: selected.mode === "STRUCTURE_Z" ? [selected.threshold] : [] } })[0] : null;
    folds.push({ trainingStart: start, trainingEndExclusive: cutoff, validationStart: cutoff, validationEndExclusive: validationEnd, trainSignalCount: train.length, validationSignalCount: validation.length, validationOutcomeVisibleCount: validationVisible.length, selectedForPhysicalReturnResearchOnly: selected ? { mode: selected.mode, threshold: selected.threshold, trainingBlockBootstrapLower: selected.physicalReturnRateIntervals.blockBootstrap.lower } : null, validation: validationRow, status: selected && validationVisible.length >= config.statistics.minimumEligibleSignals ? "PHYSICAL_RETURN_VALIDATION_AVAILABLE_NOT_A_TRADING_THRESHOLD" : "INSUFFICIENT_EVIDENCE" });
  }
  return { status: folds.some((fold) => fold.status === "PHYSICAL_RETURN_VALIDATION_AVAILABLE_NOT_A_TRADING_THRESHOLD") ? "PHYSICAL_RETURN_VALIDATION_AVAILABLE_NOT_A_TRADING_THRESHOLD" : "INSUFFICIENT_EVIDENCE", folds, outcomeVisibilityRule: "ONLY_FINITE_NON_NULL_OUTCOMES_STRICTLY_VISIBLE_BEFORE_EACH_TRAIN_OR_VALIDATION_CUTOFF", pnlValidationStatus: "OUTCOME_PRODUCER_NOT_IMPLEMENTED", automaticPromotionAllowed: false };
}

function completeNetOutcome(outcome) {
  if (outcome?.status === "UNFILLED") return { status: "COMPLETE", netPnl: 0, visibleAt: finite(outcome.visibleAt) };
  if (outcome?.status !== "COMPLETE_FEE_ATTRIBUTED_EXIT" || outcome.causalReplayComplete !== true) return { status: "INCOMPLETE", netPnl: null, visibleAt: null };
  const side = sideSign(outcome.side), entry = finite(outcome.entryPrice), quantity = finite(outcome.quantity), entryCommission = finite(outcome.entryCommission), visibleAt = finite(outcome.visibleAt);
  const exits = Array.isArray(outcome.exitFills) ? outcome.exitFills : [];
  if (!side || !(entry > 0) || !(quantity > 0) || entryCommission === null || visibleAt === null || !exits.length) return { status: "INCOMPLETE", netPnl: null, visibleAt: null };
  let exited = 0, gross = 0, exitCommission = 0;
  for (const fill of exits) { const price = finite(fill.price), fillQuantity = finite(fill.quantity), commission = finite(fill.commission); if (!(price > 0) || !(fillQuantity > 0) || commission === null) return { status: "INCOMPLETE", netPnl: null, visibleAt: null }; exited += fillQuantity; gross += side * (price - entry) * fillQuantity; exitCommission += commission; }
  if (Math.abs(exited - quantity) > Math.max(1e-12, quantity * 1e-9)) return { status: "INCOMPLETE", netPnl: null, visibleAt: null };
  return { status: "COMPLETE", netPnl: gross - entryCommission - exitCommission, visibleAt };
}

function bootstrapMeanLower(rows, { blockMs, iterations = 1000, seed = 0x504e4c43 } = {}) {
  const blocks = new Map();
  for (const row of rows) { const key = Math.floor(row.at / blockMs); blocks.set(key, (blocks.get(key) ?? []).concat(row)); }
  const grouped = [...blocks.values()];
  if (grouped.length < 2) return { status: "INSUFFICIENT_TIME_BLOCKS", lower: null, mean: rows.length ? rows.reduce((sum, row) => sum + row.value, 0) / rows.length : null, timeBlockCount: grouped.length, iterations: 0 };
  const random = seededRandom(seed), estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) { let sample = []; for (let index = 0; index < grouped.length; index += 1) sample = sample.concat(grouped[Math.floor(random() * grouped.length)]); estimates.push(sample.reduce((sum, row) => sum + row.value, 0) / sample.length); }
  return { status: "TIME_BLOCK_RESAMPLED", lower: percentile(estimates, 0.05), mean: rows.reduce((sum, row) => sum + row.value, 0) / rows.length, timeBlockCount: grouped.length, iterations, interval: "ONE_SIDED_95_PERCENT_LOWER" };
}

export function summarizeNetOutcomes(signals, { blockMs = 14_400_000, minimumEligibleSignals = 100, minimumIndependentTimeBlocks = 30, visibleBefore = Infinity } = {}) {
  const arms = ["current", "distanceOnly", "pullback"], perArm = {}, complete = new Map();
  for (const arm of arms) {
    const rows = [];
    for (const signal of signals) { const riskBudget = finite(signal.researchRiskBudget); const outcome = completeNetOutcome(signal.outcomes?.[arm]); if (signal.eligible !== false && riskBudget > 0 && outcome.status === "COMPLETE" && outcome.visibleAt !== null && outcome.visibleAt < visibleBefore) { rows.push({ signalId: signal.signalId, at: Number(signal.confirmedAt), value: outcome.netPnl / riskBudget, netPnl: outcome.netPnl, riskBudget }); complete.set(`${signal.signalId}:${arm}`, { value: outcome.netPnl / riskBudget, riskBudget }); } }
    const confidence = bootstrapMeanLower(rows, { blockMs });
    const sufficient = rows.length >= minimumEligibleSignals && confidence.timeBlockCount >= minimumIndependentTimeBlocks;
    perArm[arm] = { completeOutcomeCount: rows.length, netPnlSum: rows.reduce((sum, row) => sum + row.netPnl, 0), meanRiskNormalizedValue: confidence.mean, riskNormalizedConfidenceLowerBound: confidence.lower, confidenceMethod: confidence.status, confidenceInterval: "ONE_SIDED_95_PERCENT_LOWER", status: sufficient ? "RISK_NORMALIZED_NET_OUTCOME_EVALUABLE_NOT_PROMOTED" : "INSUFFICIENT_EVIDENCE" };
  }
  const pairedDeltas = {};
  for (const challenger of ["distanceOnly", "pullback"]) {
    const rows = signals.flatMap((signal) => { const base = complete.get(`${signal.signalId}:current`), candidate = complete.get(`${signal.signalId}:${challenger}`); return base === undefined || candidate === undefined || base.riskBudget !== candidate.riskBudget ? [] : [{ at: Number(signal.confirmedAt), value: candidate.value - base.value }]; });
    const confidence = bootstrapMeanLower(rows, { blockMs });
    const sufficient = rows.length >= minimumEligibleSignals && confidence.timeBlockCount >= minimumIndependentTimeBlocks;
    pairedDeltas[`${challenger}MinusCurrent`] = { pairedCount: rows.length, meanDeltaRiskNormalizedValue: confidence.mean, riskNormalizedConfidenceLowerBound: confidence.lower, confidenceMethod: confidence.status, confidenceInterval: "ONE_SIDED_95_PERCENT_LOWER", status: sufficient ? "PAIRED_RISK_NORMALIZED_DELTA_EVALUABLE_NOT_PROMOTED" : "INSUFFICIENT_EVIDENCE" };
  }
  return { inputContract: "CAUSAL_REPLAY_COMPLETE_AND_COMPLETE_FEE_ATTRIBUTED_EXIT_OR_EXPLICIT_UNFILLED_PLUS_SHARED_POSITIVE_RESEARCH_RISK_BUDGET_PER_SIGNAL", valueDefinition: "V_EQUALS_NET_PNL_DIVIDED_BY_SHARED_SIGNAL_RESEARCH_RISK_BUDGET", perArm, pairedDeltas, automaticPromotionAllowed: false };
}
