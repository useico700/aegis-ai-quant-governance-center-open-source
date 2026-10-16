import { BASELINE_REVISION, CANDIDATE_REVISION, C_POLICY, SOURCE_SCOPE, STUDY_ID } from "./policy.mjs";
import { validateDepthEvent, validateFundingEvent, validateMetadataRecord, validateQuoteEvent } from "./contracts.mjs";

const round = (value) => Number(value.toFixed(10));

export function initialCandidateState({ createdAt, sourceCursor, carryInPositionIds = [] }) {
  return {
    schemaVersion: 1,
    studyId: STUDY_ID,
    candidateRevision: CANDIDATE_REVISION,
    sourceScope: SOURCE_SCOPE,
    createdAt,
    startedAt: null,
    sourceCursor,
    marketCursors: { quotes: {}, depth: {}, funding: {}, metadataSha256: null },
    carryInPositionIds: [...new Set(carryInPositionIds)].sort(),
    opportunities: [],
    positions: [],
    closedPositions: [],
    account: {
      initialEquityUsdt: null,
      initialRealizedEquityUsdt: null,
      cashRealizedEquityUsdt: null,
      liquidationNetEquityUsdt: null,
      confirmedHighEquityUsdt: null,
      protectionFloorUsdt: null,
      remainingProtectionCushionUsdt: null,
      existingStressRiskUsdt: 0,
      availableCandidateRiskUsdt: 0,
      portfolioPlannedRiskUsdt: 0,
      grossNotionalUsdt: 0,
      cumulativeEntryFeesUsdt: 0,
      cumulativeExitFeesUsdt: 0,
      cumulativeFundingUsdt: 0,
      cumulativeRebalanceCostsUsdt: 0,
      realizedPnlUsdt: 0,
      markToMarketNetPnlUsdt: 0,
      maximumDrawdownFraction: 0,
    },
    abnormalLoss: { status: "CLEAR", redLatched: false, orangeHealthyCycles: 0 },
    blockers: [
      "WAITING_FIRST_HEALTHY_FORWARD_ACCOUNT_NET_EQUITY",
      "R13_CALENDAR_COVERAGE_NOT_READY",
      "R21_FULL_PORTFOLIO_PROTECTION_INPUT_NOT_READY",
      "R22_CONFIRMED_1H_AND_CLOSED_15M_ATR_TRAIL_INPUT_NOT_READY",
      "FUNDING_SETTLEMENT_STREAM_NOT_READY",
      "CONTINUOUS_TICK_BBO_DEPTH_CAPTURE_INCOMPLETE"
    ],
    capabilities: { r13Calendar: false, r15OwnState: true, r19OwnBbo: true, r20OwnCost: true, r21PortfolioProtection: false, r22IndependentManagement: false, fundingSettlement: false, independentRebalanceAccounting: true },
    validation: { eligibleCompletedCampaigns: 0, excludedCompletedCampaigns: 0, performanceValidated: false, annualTargetProbability: null },
    pendingHighProof: null,
    healthyAccountFrameCount: 0,
    healthEpoch: 0,
    publicationSequence: 0,
    lastPublishedSourceAsOf: null,
    lastPublishedDigest: null,
  };
}

export function validateCandidateState(state) {
  if (state?.schemaVersion !== 1 || state?.studyId !== STUDY_ID || state?.candidateRevision !== CANDIDATE_REVISION) throw new Error("C_STATE_IDENTITY_INVALID");
  if (state.sourceScope?.mode !== "BASELINE_EXECUTED_OPPORTUNITY_SUBSET_ONLY" || state.sourceScope.fullIndependentSignalUniverse !== false) throw new Error("C_SOURCE_SCOPE_INVALID");
  if (!Array.isArray(state.positions) || !Array.isArray(state.closedPositions) || !Array.isArray(state.carryInPositionIds)) throw new Error("C_STATE_COLLECTION_INVALID");
  if (state.positions.some((position) => state.carryInPositionIds.includes(position.baselinePositionId))) throw new Error("C_CARRY_IN_POSITION_COPIED");
  if (state.positions.length > C_POLICY.maximumPositions) throw new Error("C_POSITION_CAP_EXCEEDED");
  if (state.validation?.performanceValidated !== false || state.validation?.annualTargetProbability !== null) throw new Error("C_VALIDATION_CLAIM_INVALID");
  if (state.abnormalLoss?.status === "RED" && state.abnormalLoss.redLatched !== true) throw new Error("C_RED_NOT_LATCHED");
  return state;
}

export function validateStateTransition(previous, next) {
  validateCandidateState(previous);
  validateCandidateState(next);
  for (const key of ["schemaVersion", "studyId", "candidateRevision", "createdAt"]) {
    if (next[key] !== previous[key]) throw new Error(`C_IMMUTABLE_${key.toUpperCase()}_CHANGED`);
  }
  if (JSON.stringify(next.carryInPositionIds) !== JSON.stringify(previous.carryInPositionIds)) throw new Error("C_IMMUTABLE_CARRY_IN_SET_CHANGED");
  if (previous.startedAt != null && next.startedAt !== previous.startedAt) throw new Error("C_STARTED_AT_RESET_OR_CHANGED");
  if (previous.account.initialEquityUsdt != null && next.account.initialEquityUsdt !== previous.account.initialEquityUsdt) throw new Error("C_INITIAL_EQUITY_RESET_OR_CHANGED");
  if (previous.account.initialRealizedEquityUsdt != null && next.account.initialRealizedEquityUsdt !== previous.account.initialRealizedEquityUsdt) throw new Error("C_INITIAL_REALIZED_EQUITY_RESET_OR_CHANGED");
  for (const key of ["cumulativeEntryFeesUsdt", "cumulativeExitFeesUsdt", "cumulativeRebalanceCostsUsdt", "maximumDrawdownFraction"]) {
    if (next.account[key] < previous.account[key]) throw new Error(`C_MONOTONIC_${key.toUpperCase()}_REGRESSED`);
  }
  if (next.closedPositions.length < previous.closedPositions.length) throw new Error("C_CLOSED_POSITION_COUNT_REGRESSED");
  if (next.validation.eligibleCompletedCampaigns < previous.validation.eligibleCompletedCampaigns || next.validation.excludedCompletedCampaigns < previous.validation.excludedCompletedCampaigns) throw new Error("C_VALIDATION_COUNT_REGRESSED");
  if (next.publicationSequence < previous.publicationSequence) throw new Error("C_PUBLICATION_SEQUENCE_REGRESSED");
  if (previous.abnormalLoss.redLatched && (!next.abnormalLoss.redLatched || next.abnormalLoss.status !== "RED")) throw new Error("C_RED_AUTO_RELEASE_FORBIDDEN");
  return next;
}

export function seedHealthyForwardBaseline(state, observation) {
  validateCandidateState(state);
  if (state.startedAt != null) return state;
  const requiredHealthy = ["baselineAccount", "eventLedger", "quote", "depth", "funding", "metadata"];
  const blockers = requiredHealthy.filter((name) => observation.inputs?.[name]?.status !== "HEALTHY").map((name) => `${name.toUpperCase()}_NOT_HEALTHY`);
  const net = Number(observation.liquidationNetEquityUsdt);
  const realized = Number(observation.realizedEquityUsdt);
  if (!(net > 0) || !(realized > 0)) blockers.push("FORWARD_ACCOUNT_EQUITY_INVALID");
  if (blockers.length) return { ...state, blockers: [...new Set([...state.blockers, ...blockers])] };
  const next = structuredClone(state);
  next.startedAt = observation.sourceAsOf;
  next.account.initialEquityUsdt = net;
  next.account.initialRealizedEquityUsdt = realized;
  next.account.cashRealizedEquityUsdt = net;
  next.account.liquidationNetEquityUsdt = net;
  next.account.confirmedHighEquityUsdt = net;
  next.account.protectionFloorUsdt = round(C_POLICY.initialFloorFraction * net);
  next.account.remainingProtectionCushionUsdt = round(net - next.account.protectionFloorUsdt);
  next.blockers = next.blockers.filter((value) => value !== "WAITING_FIRST_HEALTHY_FORWARD_ACCOUNT_NET_EQUITY" && !value.endsWith("_NOT_HEALTHY") && value !== "FORWARD_ACCOUNT_EQUITY_INVALID");
  recomputeAccount(next);
  return validateCandidateState(next);
}

export function observeConfirmedAccountHigh(state, { sourceAsOf, liquidationNetEquityUsdt, healthy, bookId }) {
  if (!state.startedAt || Date.parse(sourceAsOf) < Date.parse(state.startedAt)) return state;
  const next = structuredClone(state);
  const net = Number(liquidationNetEquityUsdt);
  const observedAt = Date.parse(sourceAsOf);
  next.account.liquidationNetEquityUsdt = net;
  const exclude = (reason) => {
    next.healthFrameExclusions = [...(next.healthFrameExclusions ?? []), { at: sourceAsOf, reason }].slice(-100);
    next.pendingHighProof = null;
    next.healthyAccountFrameCount = 0;
    next.healthEpoch = Number(next.healthEpoch ?? 0) + 1;
  };
  if (healthy !== true || !bookId || !Number.isFinite(net) || !(net > 0)) {
    exclude("HIGH_PROOF_INPUT_FAILURE_RESETS_PENDING");
  } else {
    const high = Number(next.account.confirmedHighEquityUsdt ?? next.account.initialEquityUsdt);
    const pending = next.pendingHighProof;
    if (!pending && net > high) {
      next.pendingHighProof = { observedAt: sourceAsOf, bookId, liquidationNetEquityUsdt: net };
      next.healthyAccountFrameCount = 1;
    } else if (pending) {
      const gapMs = observedAt - Date.parse(pending.observedAt);
      if (bookId === pending.bookId) {
        exclude("HIGH_PROOF_REPEATED_CAUSAL_BOOK");
      } else if (gapMs < 0 || gapMs > 45_000) {
        exclude("HIGH_PROOF_GAP_OUTSIDE_30_TO_45_SECONDS");
        if (net > high) {
          next.pendingHighProof = { observedAt: sourceAsOf, bookId, liquidationNetEquityUsdt: net };
          next.healthyAccountFrameCount = 1;
        }
      } else if (gapMs >= 30_000) {
        const provenHigh = Math.min(Number(pending.liquidationNetEquityUsdt), net);
        next.pendingHighProof = null;
        next.healthyAccountFrameCount = 2;
        if (provenHigh > high) next.account.confirmedHighEquityUsdt = provenHigh;
        if (net > Number(next.account.confirmedHighEquityUsdt)) {
          next.pendingHighProof = { observedAt: sourceAsOf, bookId, liquidationNetEquityUsdt: net };
          next.healthyAccountFrameCount = 1;
        }
      }
    } else {
      next.healthyAccountFrameCount = 0;
    }
    if (next.account.confirmedHighEquityUsdt >= next.account.initialEquityUsdt * (1 + C_POLICY.profitActivationFraction)) {
      next.account.protectionFloorUsdt = round(Math.max(next.account.protectionFloorUsdt,
        next.account.initialEquityUsdt + C_POLICY.profitLockFraction * (next.account.confirmedHighEquityUsdt - next.account.initialEquityUsdt)));
    }
  }
  next.account.remainingProtectionCushionUsdt = round(Math.max(0, next.account.liquidationNetEquityUsdt - next.account.protectionFloorUsdt));
  const high = next.account.confirmedHighEquityUsdt ?? next.account.initialEquityUsdt;
  next.account.maximumDrawdownFraction = round(Math.max(next.account.maximumDrawdownFraction ?? 0,
    high > 0 ? Math.max(0, (high - next.account.liquidationNetEquityUsdt) / high) : 0));
  next.account.availableCandidateRiskUsdt = riskCapacity(next, { direction: 0 });
  return validateCandidateState(next);
}

export function riskCapacity(state, { direction, additionalStressRiskUsdt = 0 } = {}) {
  const account = state.account;
  if (!state.startedAt || state.abnormalLoss.status !== "CLEAR" || state.positions.length >= C_POLICY.maximumPositions || state.blockers.length > 0 ||
    state.capabilities?.continuousTickBboDepthCapture !== true || state.localResource?.newCandidateEntriesAllowed !== true || state.localResource?.paused === true ||
    state.governanceCandidateEntryEngineeringAccepted !== true) return 0;
  const base = Math.min(account.cashRealizedEquityUsdt, account.liquidationNetEquityUsdt);
  const existingStress = state.positions.reduce((sum, position) => sum + Number(position.stressRiskUsdt ?? 0), 0) + additionalStressRiskUsdt;
  const sameDirection = state.positions.filter((position) => position.direction === direction).reduce((sum, position) => sum + Number(position.initialRiskUsdt ?? 0), 0);
  const candidate = C_POLICY.maximumRiskFraction * base - sameDirection;
  const perIntersection = C_POLICY.maximumPerIntersectionFraction * base;
  const portfolio = C_POLICY.maximumPortfolioRiskFraction * base - existingStress;
  const cushion = C_POLICY.cushionRiskUseFraction * Math.max(0, account.liquidationNetEquityUsdt - account.protectionFloorUsdt) - existingStress;
  return round(Math.max(0, Math.min(candidate, perIntersection, portfolio, cushion)));
}

export function evaluateEntryHardGate(state, context = {}) {
  const blockers = [];
  if (state.abnormalLoss?.status !== "CLEAR") blockers.push("C_ENTRY_HARD_GATE_ABNORMAL_LOSS_NOT_CLEAR");
  if ((state.blockers ?? []).length > 0) blockers.push("C_ENTRY_HARD_GATE_GLOBAL_BLOCKERS_PRESENT");
  if (context.allInputsHealthy !== true) blockers.push("C_ENTRY_HARD_GATE_INPUTS_NOT_ALL_HEALTHY");
  if (state.capabilities?.continuousTickBboDepthCapture !== true || context.continuousCaptureVerified !== true) blockers.push("C_ENTRY_HARD_GATE_CONTINUOUS_CAPTURE_NOT_VERIFIED");
  if (state.localResource?.newCandidateEntriesAllowed !== true || state.localResource?.paused === true || context.localResourceEntryAllowed !== true) blockers.push("C_ENTRY_HARD_GATE_LOCAL_RESOURCE_NOT_ALLOWED");
  if (state.governanceCandidateEntryEngineeringAccepted !== true || context.candidateEntryEngineeringAccepted !== true) blockers.push("C_ENTRY_HARD_GATE_GOVERNANCE_ENGINEERING_NOT_ACCEPTED");
  return { open: blockers.length === 0, blockers };
}

export function r15ReplacementEvidenceReady(pendingReplacement, decision) {
  const closedAtReceiveSeq = Number(pendingReplacement?.oldPositionClosedAtReceiveSeq);
  return Number.isInteger(closedAtReceiveSeq) && closedAtReceiveSeq >= 0 &&
    Number(decision?.quote?.receiveSeq) > closedAtReceiveSeq &&
    Number(decision?.depth?.decisionReceiveSeq) > closedAtReceiveSeq;
}

export function validateMatchedOpportunity(state, sourceEvent, context) {
  const payload = sourceEvent?.payload ?? {};
  const blockers = [];
  blockers.push(...evaluateEntryHardGate(state, context).blockers);
  if (!state.startedAt || sourceEvent.marketTime < Date.parse(state.startedAt)) blockers.push("PRE_START_OR_UNSEEDED_OPPORTUNITY");
  if (sourceEvent.type !== "PAPER_POSITION_OPENED") blockers.push("NOT_BASELINE_EXECUTED_OPPORTUNITY");
  if (payload.implementationRevision !== BASELINE_REVISION) blockers.push("BASELINE_REVISION_MISMATCH");
  if (state.carryInPositionIds.includes(payload.id)) blockers.push("CARRY_IN_EXCLUDED");
  if (payload.entryQualityGuard?.allowed !== true || payload.entryQualityGuard?.maximumSignalAgeMs !== C_POLICY.maximumSignalAgeMs || payload.entryQualityGuard?.maximumDisplacementBps !== C_POLICY.maximumEntryDisplacementBps) blockers.push("R19_ATTESTATION_INVALID");
  if (payload.costEfficiencyGuard?.allowed !== true || Number(payload.costEfficiencyGuard?.maximumCompleteLifecycleCostR) !== C_POLICY.maximumCompleteLifecycleCostR) blockers.push("R20_ATTESTATION_INVALID");
  if (context.r13Eligible !== true) blockers.push("R13_EVENT_CALENDAR_NOT_PROVEN_CLEAR");
  const existing = state.positions.find((position) => position.symbol === payload.symbol);
  if (existing && !(payload.direction === -existing.direction && payload.intersectionTime > existing.intersectionTime && sourceEvent.marketTime > existing.openedAt)) blockers.push("R15_REPLACEMENT_NOT_ELIGIBLE");
  if (existing && context.r15ReplacementExecutionReady !== true) blockers.push("R15_CLOSE_OLD_THEN_OPEN_NEW_EXECUTION_NOT_READY");
  if (context.r21PortfolioProtectionReady !== true) blockers.push("R21_FULL_PORTFOLIO_PROTECTION_INPUT_NOT_READY");
  if (context.r21EntryFrozen === true) blockers.push("R21_SAME_DIRECTION_ENTRY_FROZEN");
  if (context.localResourceEntryAllowed !== true) blockers.push("LOCAL_RESOURCE_ENTRY_NOT_ALLOWED");
  if (context.r22TrailInputsReady !== true) blockers.push("R22_CONFIRMED_1H_AND_CLOSED_15M_ATR_TRAIL_INPUT_NOT_READY");
  return { accepted: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function depthVwap(levels, requestedQuantity) {
  let remaining = requestedQuantity;
  let notional = 0;
  for (const [price, quantity] of levels) {
    const take = Math.min(remaining, quantity);
    notional += take * price;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  return remaining <= 1e-12 ? notional / requestedQuantity : null;
}

function floorStep(quantity, step) {
  return Math.floor((quantity + 1e-12) / step) * step;
}

function finalExecutionModel({ direction, vwap, stop }) {
  const entry = direction === 1 ? vwap * (1 + C_POLICY.adverseSlippageRate) : vwap * (1 - C_POLICY.adverseSlippageRate);
  const stopFill = direction === 1 ? stop * (1 - C_POLICY.adverseSlippageRate) : stop * (1 + C_POLICY.adverseSlippageRate);
  const structuralRiskPerUnit = direction === 1 ? vwap - stop : stop - vwap;
  const entryFeePerUnit = entry * C_POLICY.takerFeeRate;
  const stopExitFeePerUnit = stopFill * C_POLICY.takerFeeRate;
  const slippageCostPerUnit = Math.abs(entry - vwap) + Math.abs(stopFill - stop);
  const completeLifecycleCostPerUnit = entryFeePerUnit + stopExitFeePerUnit + slippageCostPerUnit;
  const modeledRiskPerUnit = direction === 1 ? entry - stopFill : stopFill - entry;
  return { entry, stopFill, structuralRiskPerUnit, entryFeePerUnit, stopExitFeePerUnit, completeLifecycleCostPerUnit, modeledRiskPerUnit: modeledRiskPerUnit + entryFeePerUnit + stopExitFeePerUnit };
}

export function deriveIndependentEntry(state, sourceEvent, market, context) {
  const eligibility = validateMatchedOpportunity(state, sourceEvent, context);
  if (!eligibility.accepted) return { accepted: false, blockers: eligibility.blockers };
  const { quote, depth, funding, metadata } = market;
  validateQuoteEvent(quote); validateDepthEvent(depth); validateFundingEvent(funding); validateMetadataRecord(metadata);
  if ([quote.symbol, depth.symbol, funding.symbol, metadata.symbol].some((symbol) => symbol !== sourceEvent.payload.symbol)) return { accepted: false, blockers: ["CROSS_INPUT_SYMBOL_MISMATCH"] };
  if (quote.receivedAt <= context.sourceObservedAt || depth.receivedAt <= context.sourceObservedAt) return { accepted: false, blockers: ["ENTRY_REQUIRES_NEXT_CAUSAL_PUBLIC_BOOK"] };
  if (quote.receivedAt > sourceEvent.payload.entryQualityGuard.signalExpiresAt) return { accepted: false, blockers: ["R19_SIGNAL_EXPIRED_BEFORE_C_BOOK"] };
  const riskBudget = riskCapacity(state, { direction: sourceEvent.payload.direction });
  if (!(riskBudget > 0)) return { accepted: false, blockers: ["C_ACCOUNT_RISK_CAPACITY_UNAVAILABLE"] };
  const direction = sourceEvent.payload.direction;
  const reference = Number(sourceEvent.payload.entryQualityGuard.referencePrice);
  const executableTop = sourceEvent.payload.direction === 1 ? quote.ask : quote.bid;
  const displacementBps = Math.abs(executableTop - reference) / reference * 10_000;
  if (displacementBps > C_POLICY.maximumEntryDisplacementBps) return { accepted: false, blockers: ["R19_C_ENTRY_DISPLACEMENT_EXCEEDED"] };
  const stop = Number(sourceEvent.payload.initialStop);
  const topStructuralRiskPerUnit = direction === 1 ? executableTop - stop : stop - executableTop;
  if (!(topStructuralRiskPerUnit > 0)) return { accepted: false, blockers: ["C_STOP_NOT_PROTECTIVE"] };
  const leverageBase = Math.min(state.account.cashRealizedEquityUsdt, state.account.liquidationNetEquityUsdt);
  const leverageCapacity = Math.max(0, C_POLICY.maximumLeverage * leverageBase - state.account.grossNotionalUsdt);
  let quantity = floorStep(Math.min(riskBudget / topStructuralRiskPerUnit, leverageCapacity / executableTop), metadata.stepSize);
  let vwap = null;
  let model = null;
  for (let iteration = 0; iteration < 12 && quantity >= metadata.minQty; iteration += 1) {
    vwap = depthVwap(direction === 1 ? depth.asks : depth.bids, quantity);
    if (!vwap) return { accepted: false, blockers: ["C_DEPTH_INSUFFICIENT_NO_FILL"] };
    model = finalExecutionModel({ direction, vwap, stop });
    if (!(model.structuralRiskPerUnit > 0) || !(model.modeledRiskPerUnit > 0)) return { accepted: false, blockers: ["C_STOP_NOT_PROTECTIVE_AFTER_DEPTH"] };
    const refit = floorStep(Math.min(riskBudget / model.modeledRiskPerUnit, leverageCapacity / model.entry), metadata.stepSize);
    if (refit >= quantity) break;
    quantity = refit;
  }
  quantity = floorStep(quantity, metadata.stepSize);
  if (quantity < metadata.minQty) return { accepted: false, blockers: ["C_METADATA_MINIMUM_NOT_MET"] };
  vwap = depthVwap(direction === 1 ? depth.asks : depth.bids, quantity);
  if (!vwap) return { accepted: false, blockers: ["C_DEPTH_INSUFFICIENT_NO_FILL"] };
  model = finalExecutionModel({ direction, vwap, stop });
  const finalDisplacementBps = Math.abs(model.entry - reference) / reference * 10_000;
  const completeLifecycleCostR = model.completeLifecycleCostPerUnit / model.structuralRiskPerUnit;
  const initialRiskUsdt = model.modeledRiskPerUnit * quantity;
  if (finalDisplacementBps > C_POLICY.maximumEntryDisplacementBps) return { accepted: false, blockers: ["R19_C_FINAL_FILL_DISPLACEMENT_EXCEEDED"] };
  if (completeLifecycleCostR > C_POLICY.maximumCompleteLifecycleCostR) return { accepted: false, blockers: ["R20_C_COMPLETE_LIFECYCLE_COST_EXCEEDED"] };
  if (initialRiskUsdt > riskBudget + 1e-8) return { accepted: false, blockers: ["C_FINAL_MODELED_RISK_EXCEEDS_BUDGET"] };
  if (quantity * model.entry > leverageCapacity + 1e-8) return { accepted: false, blockers: ["C_FINAL_NOTIONAL_EXCEEDS_LEVERAGE_CAP"] };
  if (quantity * model.entry < metadata.minNotional) return { accepted: false, blockers: ["C_METADATA_MINIMUM_NOT_MET"] };
  const entryFeeUsdt = model.entryFeePerUnit * quantity;
  const position = {
    id: `c_${sourceEvent.payload.id}`,
    baselinePositionId: sourceEvent.payload.id,
    sourceEventId: sourceEvent.eventId,
    symbol: sourceEvent.payload.symbol,
    direction,
    intersectionId: sourceEvent.payload.intersectionId,
    intersectionTime: sourceEvent.payload.intersectionTime,
    openedAt: quote.receivedAt,
    entry: model.entry,
    initialStop: stop,
    stop,
    originalQuantity: quantity,
    quantity,
    quantityHistory: [{ effectiveAt: quote.receivedAt, quantity, reason: "OPEN" }],
    modeledStopFill: model.stopFill,
    initialRiskPerUnit: model.modeledRiskPerUnit,
    initialRiskUsdt,
    plannedRiskUsdt: initialRiskUsdt,
    stressRiskUsdt: initialRiskUsdt,
    entryFeeUsdt,
    lastMark: model.entry,
    lastMarkAt: quote.receivedAt,
    cumulativeGrossPnlUsdt: 0,
    cumulativeExitFeesUsdt: 0,
    cumulativeFundingUsdt: 0,
    halfTaken: false,
    oneTaken: false,
    twoTaken: false,
    stage: "INITIAL",
    costModel: {
      takerFeeRate: C_POLICY.takerFeeRate,
      adverseSlippageRate: C_POLICY.adverseSlippageRate,
      fundingRateAtEntry: funding.fundingRate,
      depthVwap: vwap,
      finalDisplacementBps,
      completeLifecycleCostPerUnit: model.completeLifecycleCostPerUnit,
      completeLifecycleCostR,
      initialRiskIncludesEntryAndModeledStopExitFees: true,
    },
  };
  return {
    accepted: true,
    blockers: [],
    entryHardGateAttestation: {
      allInputsHealthy: context.allInputsHealthy === true,
      continuousCaptureVerified: context.continuousCaptureVerified === true,
      localResourceEntryAllowed: context.localResourceEntryAllowed === true,
      candidateEntryEngineeringAccepted: context.candidateEntryEngineeringAccepted === true,
      globalBlockersAbsent: state.blockers.length === 0,
      abnormalLossClear: state.abnormalLoss.status === "CLEAR",
      sourceCursorHash: state.sourceCursor?.hash ?? null,
    },
    position,
    fee: { type: "ENTRY_FEE", amountUsdt: entryFeeUsdt, cashAccounting: "DEDUCTED_ON_OPEN_NOT_REALLOCATED_TO_REMAINING_POSITION" },
  };
}

export function applyIndependentEntry(state, derived) {
  if (!derived.accepted) return state;
  const gate = evaluateEntryHardGate(state, {
    allInputsHealthy: derived.entryHardGateAttestation?.allInputsHealthy,
    continuousCaptureVerified: derived.entryHardGateAttestation?.continuousCaptureVerified,
    localResourceEntryAllowed: derived.entryHardGateAttestation?.localResourceEntryAllowed,
    candidateEntryEngineeringAccepted: derived.entryHardGateAttestation?.candidateEntryEngineeringAccepted,
  });
  if (!gate.open || derived.entryHardGateAttestation?.globalBlockersAbsent !== true || derived.entryHardGateAttestation?.abnormalLossClear !== true || derived.entryHardGateAttestation?.sourceCursorHash !== (state.sourceCursor?.hash ?? null)) {
    throw new Error(`C_ENTRY_HARD_GATE_APPLY_REJECTED_${gate.blockers.join("_") || "ATTESTATION_INVALID"}`);
  }
  const next = structuredClone(state);
  next.positions.push(derived.position);
  next.account.cashRealizedEquityUsdt = round(next.account.cashRealizedEquityUsdt - derived.fee.amountUsdt);
  next.account.cumulativeEntryFeesUsdt = round(next.account.cumulativeEntryFeesUsdt + derived.fee.amountUsdt);
  next.account.realizedPnlUsdt = round(next.account.realizedPnlUsdt - derived.fee.amountUsdt);
  recomputeAccount(next);
  return validateCandidateState(next);
}

export function applyFundingSettlement(state, { symbol, fundingTime, fundingRate, markPrice }) {
  const next = structuredClone(state);
  const positions = [...next.positions, ...next.closedPositions].filter((candidate) => candidate.symbol === symbol &&
    fundingTime > candidate.openedAt && fundingTime <= Number(candidate.closedAt ?? Infinity) && fundingTime > Number(candidate.lastFundingTime ?? 0));
  if (!positions.length) return state;
  if (![fundingTime, fundingRate, markPrice].every(Number.isFinite) || !(markPrice > 0)) throw new Error("C_FUNDING_SETTLEMENT_INVALID");
  let costUsdt = 0;
  for (const position of positions) {
    const quantityAtSettlement = [...(position.quantityHistory ?? [{ effectiveAt: position.openedAt, quantity: position.originalQuantity }])]
      .filter((item) => item.effectiveAt < fundingTime).sort((a, b) => a.effectiveAt - b.effectiveAt).at(-1)?.quantity;
    if (!(quantityAtSettlement > 0)) throw new Error("C_FUNDING_SETTLEMENT_QUANTITY_UNKNOWN");
    const positionCost = position.direction * fundingRate * markPrice * quantityAtSettlement;
    position.cumulativeFundingUsdt = round(position.cumulativeFundingUsdt + positionCost);
    position.lastFundingTime = fundingTime;
    costUsdt += positionCost;
  }
  next.account.cashRealizedEquityUsdt = round(next.account.cashRealizedEquityUsdt - costUsdt);
  next.account.cumulativeFundingUsdt = round(next.account.cumulativeFundingUsdt + costUsdt);
  next.account.realizedPnlUsdt = round(next.account.realizedPnlUsdt - costUsdt);
  next.account.liquidationNetEquityUsdt = round(next.account.cashRealizedEquityUsdt + next.account.markToMarketNetPnlUsdt);
  next.account.remainingProtectionCushionUsdt = round(Math.max(0, next.account.liquidationNetEquityUsdt - next.account.protectionFloorUsdt));
  next.account.availableCandidateRiskUsdt = riskCapacity(next, { direction: 0 });
  return validateCandidateState(next);
}

function positionNetR(position, executablePrice) {
  const grossRemaining = position.direction === 1 ? (executablePrice - position.entry) * position.quantity : (position.entry - executablePrice) * position.quantity;
  const exitFee = executablePrice * position.quantity * C_POLICY.takerFeeRate;
  const totalNet = -position.entryFeeUsdt + position.cumulativeGrossPnlUsdt - position.cumulativeExitFeesUsdt - position.cumulativeFundingUsdt + grossRemaining - exitFee;
  return totalNet / position.initialRiskUsdt;
}

function stopForAggregateFloor(position, floorR) {
  const realized = -position.entryFeeUsdt + position.cumulativeGrossPnlUsdt - position.cumulativeExitFeesUsdt - position.cumulativeFundingUsdt;
  const targetRemaining = floorR * position.initialRiskUsdt - realized;
  if (position.direction === 1) return (position.entry + targetRemaining / position.quantity) / (1 - C_POLICY.takerFeeRate);
  return (position.entry - targetRemaining / position.quantity) / (1 + C_POLICY.takerFeeRate);
}

function closeFraction(position, executablePrice, fractionOfOriginal, reason, occurredAt) {
  const quantity = Math.min(position.quantity, position.originalQuantity * fractionOfOriginal);
  const gross = position.direction === 1 ? (executablePrice - position.entry) * quantity : (position.entry - executablePrice) * quantity;
  const exitFee = executablePrice * quantity * C_POLICY.takerFeeRate;
  position.quantity = round(position.quantity - quantity);
  position.plannedRiskUsdt = round(position.initialRiskUsdt * position.quantity / position.originalQuantity);
  position.stressRiskUsdt = position.plannedRiskUsdt;
  position.quantityHistory = [...(position.quantityHistory ?? []), { effectiveAt: occurredAt, quantity: position.quantity, reason }];
  position.cumulativeGrossPnlUsdt = round(position.cumulativeGrossPnlUsdt + gross);
  position.cumulativeExitFeesUsdt = round(position.cumulativeExitFeesUsdt + exitFee);
  return { reason, quantity, price: executablePrice, grossPnlUsdt: gross, exitFeeUsdt: exitFee, cashDeltaUsdt: gross - exitFee };
}

function closeFractionFromDepth(position, depthLevels, fractionOfOriginal, reason, metadata, occurredAt, finalClose = false) {
  const requested = finalClose ? position.quantity : Math.min(position.quantity, floorStep(position.originalQuantity * fractionOfOriginal, metadata.stepSize));
  if (!(requested >= metadata.minQty)) throw new Error("R22_EXIT_QUANTITY_BELOW_MINIMUM");
  let remaining = requested;
  let notional = 0;
  for (const level of depthLevels) {
    const take = Math.min(remaining, level[1]);
    notional += take * level[0];
    level[1] = round(level[1] - take);
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  if (remaining > 1e-12) throw new Error("R22_EXIT_DEPTH_INSUFFICIENT_NO_FILL");
  const vwap = notional / requested;
  const executable = position.direction === 1 ? vwap * (1 - C_POLICY.adverseSlippageRate) : vwap * (1 + C_POLICY.adverseSlippageRate);
  return closeFraction(position, executable, requested / position.originalQuantity, reason, occurredAt);
}

export function applyR22MarketObservation(state, symbol, market, trail = {}) {
  const next = structuredClone(state);
  const position = next.positions.find((candidate) => candidate.symbol === symbol);
  if (!position) return { state, events: [], blockers: ["C_POSITION_NOT_FOUND"] };
  try { validateQuoteEvent(market.quote); validateDepthEvent(market.depth); validateMetadataRecord(market.metadata); }
  catch { return { state, events: [], blockers: ["R22_INDEPENDENT_QUOTE_DEPTH_METADATA_REQUIRED"] }; }
  if ([market.depth.symbol, market.metadata.symbol].some((candidate) => candidate !== symbol)) return { state, events: [], blockers: ["R22_CROSS_INPUT_SYMBOL_MISMATCH"] };
  const executable = position.direction === 1 ? market.quote.bid * (1 - C_POLICY.adverseSlippageRate) : market.quote.ask * (1 + C_POLICY.adverseSlippageRate);
  const existingStopHit = position.direction === 1 ? executable <= position.stop : executable >= position.stop;
  if (!existingStopHit && !position.twoTaken && positionNetR(position, executable) >= C_POLICY.r22.twoNetR.threshold && trail.inputsReady !== true) {
    return { state, events: [], blockers: ["R22_RUNNER_TRAIL_INPUT_MISSING_FAIL_CLOSED"] };
  }
  const events = [];
  const exitLevels = structuredClone(position.direction === 1 ? market.depth.bids : market.depth.asks);
  let stopped = position.direction === 1 ? executable <= position.stop : executable >= position.stop;
  if (position.twoTaken && !stopped) {
    if (trail.inputsReady !== true) return { state, events: [], blockers: ["R22_RUNNER_TRAIL_INPUT_MISSING_FAIL_CLOSED"] };
    const candidates = [trail.confirmed1hStop, trail.closed15mAtrStop].filter(Number.isFinite);
    if (candidates.length) position.stop = position.direction === 1 ? Math.max(position.stop, ...candidates) : Math.min(position.stop, ...candidates);
    stopped = position.direction === 1 ? executable <= position.stop : executable >= position.stop;
  }
  try {
  if (stopped) events.push(closeFractionFromDepth(position, exitLevels, position.quantity / position.originalQuantity, "STOP", market.metadata, market.quote.receivedAt, true));
  else {
    let netR = positionNetR(position, executable);
    if (!position.halfTaken && netR >= C_POLICY.r22.halfNetR.threshold) {
      events.push(closeFractionFromDepth(position, exitLevels, C_POLICY.r22.halfNetR.closeFraction, "PARTIAL_40_AT_0_5R", market.metadata, market.quote.receivedAt));
      position.halfTaken = true; position.stage = "BALANCED_LOCK_60_REMAINING";
      const floorStop = stopForAggregateFloor(position, C_POLICY.r22.halfNetR.aggregateFloorR);
      position.stop = position.direction === 1 ? Math.max(position.stop, floorStop) : Math.min(position.stop, floorStop);
    }
    netR = positionNetR(position, executable);
    if (!position.oneTaken && netR >= C_POLICY.r22.oneNetR.threshold) {
      events.push(closeFractionFromDepth(position, exitLevels, C_POLICY.r22.oneNetR.closeFraction, "PARTIAL_25_AT_1R", market.metadata, market.quote.receivedAt));
      position.oneTaken = true; position.stage = "AFTER_1R_35_REMAINING";
      const floorStop = stopForAggregateFloor(position, C_POLICY.r22.oneNetR.aggregateFloorR);
      position.stop = position.direction === 1 ? Math.max(position.stop, floorStop) : Math.min(position.stop, floorStop);
    }
    netR = positionNetR(position, executable);
    if (!position.twoTaken && netR >= C_POLICY.r22.twoNetR.threshold) {
      events.push(closeFractionFromDepth(position, exitLevels, C_POLICY.r22.twoNetR.closeFraction, "PARTIAL_20_AT_2R", market.metadata, market.quote.receivedAt));
      position.twoTaken = true; position.stage = "RUNNER_15_REMAINING";
      const candidates = [trail.confirmed1hStop, trail.closed15mAtrStop].filter(Number.isFinite);
      if (candidates.length) position.stop = position.direction === 1 ? Math.max(position.stop, ...candidates) : Math.min(position.stop, ...candidates);
    }
  }
  } catch (error) {
    return { state, events: [], blockers: [error.message] };
  }
  for (const event of events) {
    next.account.cashRealizedEquityUsdt = round(next.account.cashRealizedEquityUsdt + event.cashDeltaUsdt);
    next.account.cumulativeExitFeesUsdt = round(next.account.cumulativeExitFeesUsdt + event.exitFeeUsdt);
    next.account.realizedPnlUsdt = round(next.account.realizedPnlUsdt + event.cashDeltaUsdt);
  }
  if (position.quantity <= 1e-10) {
    next.positions = next.positions.filter((candidate) => candidate.id !== position.id);
    next.closedPositions.push({ ...position, closedAt: market.quote.receivedAt, closeReason: events.at(-1)?.reason ?? "CLOSED", netPnlUsdt: round(-position.entryFeeUsdt + position.cumulativeGrossPnlUsdt - position.cumulativeExitFeesUsdt - position.cumulativeFundingUsdt) });
    const lossR = Math.max(0, -next.closedPositions.at(-1).netPnlUsdt / position.initialRiskUsdt);
    advanceAbnormalLoss(next, lossR);
  }
  recomputeAccount(next, { [symbol]: { price: executable, observedAt: market.quote.receivedAt } }, { valuationAt: market.quote.receivedAt });
  return { state: validateCandidateState(next), events, blockers: [] };
}

export function applyIndependentR21Action(state, action, market) {
  const next = structuredClone(state);
  const position = next.positions.find((candidate) => candidate.id === action.positionId && candidate.symbol === action.symbol);
  const allowed = ["REDUCE_INITIAL", "CLOSE_INITIAL", "ACCOUNT_PROTECTION_REDUCE", "ACCOUNT_PROTECTION_CLOSE", "ACCOUNT_FLOOR_EXIT"];
  if (!position || !allowed.includes(action.type)) return { state, event: null, blockers: ["RISK_REDUCTION_ACTION_TARGET_INVALID"] };
  try { validateQuoteEvent(market.quote); validateDepthEvent(market.depth); validateMetadataRecord(market.metadata); }
  catch { return { state, event: null, blockers: ["R21_ACTION_QUOTE_DEPTH_METADATA_REQUIRED"] }; }
  if ([market.quote.symbol, market.depth.symbol, market.metadata.symbol].some((symbol) => symbol !== position.symbol)) return { state, event: null, blockers: ["R21_ACTION_CROSS_INPUT_SYMBOL_MISMATCH"] };
  const levels = structuredClone(position.direction === 1 ? market.depth.bids : market.depth.asks);
  const finalClose = ["CLOSE_INITIAL", "ACCOUNT_PROTECTION_CLOSE", "ACCOUNT_FLOOR_EXIT"].includes(action.type);
  const fraction = finalClose ? position.quantity / position.originalQuantity : Number(action.fractionOfOriginal);
  let event;
  const reason = action.reason ?? (action.type === "CLOSE_INITIAL" ? "R21_PORTFOLIO_HARD_PROFIT_PROTECTION" : action.type === "REDUCE_INITIAL" ? "R21_PORTFOLIO_DEFENSE_REDUCTION" : action.type);
  try { event = closeFractionFromDepth(position, levels, fraction, reason, market.metadata, market.quote.receivedAt, finalClose); }
  catch (error) { return { state, event: null, blockers: [error.message] }; }
  next.account.cashRealizedEquityUsdt = round(next.account.cashRealizedEquityUsdt + event.cashDeltaUsdt);
  next.account.cumulativeExitFeesUsdt = round(next.account.cumulativeExitFeesUsdt + event.exitFeeUsdt);
  next.account.realizedPnlUsdt = round(next.account.realizedPnlUsdt + event.cashDeltaUsdt);
  const top = position.direction === 1 ? market.quote.bid : market.quote.ask;
  const rebalanceCost = event.exitFeeUsdt + Math.abs(event.price - top) * event.quantity;
  next.account.cumulativeRebalanceCostsUsdt = round(next.account.cumulativeRebalanceCostsUsdt + rebalanceCost);
  if (position.quantity <= 1e-10) {
    next.positions = next.positions.filter((candidate) => candidate.id !== position.id);
    next.closedPositions.push({ ...position, closedAt: market.quote.receivedAt, closeReason: event.reason, netPnlUsdt: round(-position.entryFeeUsdt + position.cumulativeGrossPnlUsdt - position.cumulativeExitFeesUsdt - position.cumulativeFundingUsdt) });
  }
  recomputeAccount(next, { [position.symbol]: { price: event.price, observedAt: market.quote.receivedAt } }, { valuationAt: market.quote.receivedAt });
  return { state: validateCandidateState(next), event: { ...event, actionType: action.type, rebalanceCostUsdt: rebalanceCost }, blockers: [] };
}

export function planAccountProtectionDeleverage(state) {
  if (!state.startedAt || !state.positions.length) return [];
  const cushion = Math.max(0, state.account.liquidationNetEquityUsdt - state.account.protectionFloorUsdt);
  const allowedStress = C_POLICY.cushionRiskUseFraction * cushion;
  const floorBreached = state.account.liquidationNetEquityUsdt <= state.account.protectionFloorUsdt;
  let excess = floorBreached ? Infinity : Math.max(0, state.account.existingStressRiskUsdt - allowedStress);
  if (!(excess > 0)) return [];
  const ordered = [...state.positions].sort((a, b) => Number(a.stage === "RUNNER_15_REMAINING") - Number(b.stage === "RUNNER_15_REMAINING") || b.stressRiskUsdt - a.stressRiskUsdt);
  const actions = [];
  for (const position of ordered) {
    if (floorBreached) {
      actions.push({ type: "ACCOUNT_FLOOR_EXIT", positionId: position.id, symbol: position.symbol, reason: "ACCOUNT_PROTECTION_FLOOR_BREACH_CAUSAL_DEPTH_EXIT" });
      continue;
    }
    const reductionRisk = Math.min(excess, position.stressRiskUsdt);
    if (!(reductionRisk > 0)) continue;
    const fractionOfCurrent = reductionRisk / position.stressRiskUsdt;
    const fractionOfOriginal = position.quantity / position.originalQuantity * fractionOfCurrent;
    actions.push({ type: reductionRisk >= position.stressRiskUsdt - 1e-8 ? "ACCOUNT_PROTECTION_CLOSE" : "ACCOUNT_PROTECTION_REDUCE", positionId: position.id, symbol: position.symbol, fractionOfOriginal, reason: "ACCOUNT_PROTECTION_STRESS_EXCEEDS_25_PERCENT_CUSHION" });
    excess -= reductionRisk;
    if (excess <= 1e-8) break;
  }
  return actions;
}

export function classifyCompletedCampaigns(state) {
  const next = structuredClone(state);
  for (const position of next.closedPositions.filter((candidate) => candidate.validationDisposition == null)) {
    if (Number(position.fundingCoverageThrough ?? 0) < Number(position.closedAt)) continue;
    const eligible = position.evidenceEligibility?.continuousTickBboDepth === true &&
      position.evidenceEligibility?.sourceHashContinuous === true &&
      position.evidenceEligibility?.noUnknownSameBarPath === true;
    position.validationDisposition = eligible ? "ELIGIBLE" : "EXCLUDED_CAPTURE_INCOMPLETE";
    position.validationClassifiedAt = new Date(Number(position.fundingCoverageThrough)).toISOString();
    if (eligible) next.validation.eligibleCompletedCampaigns += 1;
    else next.validation.excludedCompletedCampaigns += 1;
  }
  return validateStateTransition(state, next);
}

export function advanceAbnormalLoss(state, lossR, healthyReconciledCycle = false) {
  const gate = state.abnormalLoss;
  if (gate.redLatched) { gate.status = "RED"; return gate; }
  if (lossR > C_POLICY.abnormalLoss.redAboveR) { gate.status = "RED"; gate.redLatched = true; return gate; }
  if (lossR > C_POLICY.abnormalLoss.orangeAboveR) { gate.status = "ORANGE"; gate.orangeHealthyCycles = 0; return gate; }
  if (lossR > C_POLICY.abnormalLoss.yellowAboveR) {
    if (gate.status === "CLEAR") gate.status = "YELLOW";
    gate.orangeHealthyCycles = 0;
    return gate;
  }
  if (!healthyReconciledCycle) { gate.orangeHealthyCycles = 0; return gate; }
  if (healthyReconciledCycle && gate.status === "YELLOW") gate.status = "CLEAR";
  else if (healthyReconciledCycle && gate.status === "ORANGE") {
    gate.orangeHealthyCycles += 1;
    if (gate.orangeHealthyCycles >= 3) gate.status = "CLEAR";
  }
  return gate;
}

export function recomputeAccount(state, marks = {}, { valuationAt = null } = {}) {
  if (!state.startedAt) return state;
  const resolvedMarks = new Map();
  for (const position of state.positions) {
    const supplied = marks[position.symbol];
    const price = typeof supplied === "number" ? supplied : supplied?.price ?? position.lastMark;
    const observedAt = typeof supplied === "number" ? valuationAt : supplied?.observedAt ?? position.lastMarkAt;
    if (!(Number.isFinite(price) && Number.isFinite(observedAt)) || (Number.isFinite(valuationAt) && valuationAt - observedAt > C_POLICY.maximumQuoteAgeMs)) {
      state.blockers = [...new Set([...state.blockers, "C_ACCOUNT_MARK_MISSING_OR_STALE"])]
      state.account.availableCandidateRiskUsdt = 0;
      state.accountValuation = { status: "INVALID_MISSING_OR_STALE_MARK", valuedAt: valuationAt == null ? null : new Date(valuationAt).toISOString() };
      return state;
    }
    resolvedMarks.set(position.id, { price, observedAt });
  }
  state.blockers = state.blockers.filter((blocker) => blocker !== "C_ACCOUNT_MARK_MISSING_OR_STALE");
  let markPnl = 0;
  let stress = 0;
  let gross = 0;
  let planned = 0;
  for (const position of state.positions) {
    const resolved = resolvedMarks.get(position.id);
    const mark = resolved.price;
    position.lastMark = mark;
    position.lastMarkAt = resolved.observedAt;
    const grossRemaining = position.direction === 1 ? (mark - position.entry) * position.quantity : (position.entry - mark) * position.quantity;
    const exitFee = mark * position.quantity * C_POLICY.takerFeeRate;
    markPnl += grossRemaining - exitFee;
    const currentLiquidation = position.direction * (mark - position.entry) * position.quantity - mark * position.quantity * C_POLICY.takerFeeRate;
    const stopFill = position.stop * (position.direction === 1
      ? 1 - C_POLICY.adverseSlippageRate - C_POLICY.stressGapFraction
      : 1 + C_POLICY.adverseSlippageRate + C_POLICY.stressGapFraction);
    const stopLiquidation = position.direction * (stopFill - position.entry) * position.quantity - stopFill * position.quantity * C_POLICY.takerFeeRate;
    position.stressRiskUsdt = round(Math.max(0, currentLiquidation - stopLiquidation));
    stress += position.stressRiskUsdt;
    gross += mark * position.quantity;
    planned += Number(position.plannedRiskUsdt ?? position.initialRiskUsdt);
  }
  state.account.markToMarketNetPnlUsdt = round(markPnl);
  state.account.liquidationNetEquityUsdt = round(state.account.cashRealizedEquityUsdt + markPnl);
  state.account.existingStressRiskUsdt = round(stress);
  state.account.portfolioPlannedRiskUsdt = round(planned);
  state.account.grossNotionalUsdt = round(gross);
  state.accountStressModel = { type: "CURRENT_LIQUIDATION_TO_MODELED_STOP_LIQUIDATION", gapFraction: C_POLICY.stressGapFraction, includesAdverseSlippageAndExitFee: true, floorGuarantee: false };
  state.accountValuation = { status: "HEALTHY_CAUSAL_MARKS", valuedAt: valuationAt == null ? null : new Date(valuationAt).toISOString() };
  state.account.remainingProtectionCushionUsdt = round(Math.max(0, state.account.liquidationNetEquityUsdt - state.account.protectionFloorUsdt));
  const high = Math.max(state.account.confirmedHighEquityUsdt ?? state.account.liquidationNetEquityUsdt, state.account.liquidationNetEquityUsdt);
  state.account.maximumDrawdownFraction = round(Math.max(state.account.maximumDrawdownFraction ?? 0, high > 0 ? Math.max(0, (high - state.account.liquidationNetEquityUsdt) / high) : 0));
  state.account.availableCandidateRiskUsdt = riskCapacity(state, { direction: 0 });
  return state;
}
