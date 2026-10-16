import { SMC_S1_ENTRY_REVISION, SMC_S1_TRAIL_REVISION, validateSmcS1Candidate, smcPxTarget, smcPxConfirmation } from '../../../lib/smc-s1-entry.mjs';
import hybridPolicy from '../../../lib/smc-s1-policy.json' with { type: 'json' };
import { evaluateV2CostEfficiencyGate } from '../../orion-v2/paper/paper-engine.mjs';
import { sanitizeIntersectionClock } from '../../../lib/smc-intersection-clock.mjs';
import {TARGET_PATH_REVISION,assessTargetPath,validate4hFvgEvidence} from '../../../lib/smc-target-path.mjs';
import {validateCandidateTargetPath} from '../../../lib/smc-target-path-candidate.mjs';
import { targetDirectionSupport, validateTargetBasis } from '../../../lib/smc-target-policy.mjs';
import { DUAL_FRAME_ENTRY_REVISION, validateDualFrameCandidate } from '../../../lib/smc-dual-frame-entry.mjs';
import { LOCAL_ENTRY_REVISION, validateLocalSmcCandidate } from '../../../lib/smc-local-entry.mjs';
import { TIMED_ENTRY_REVISION, validateTimedEntryCandidate } from '../../../lib/smc-timed-entry.mjs';
import { validatedPullbackPlan } from '../../../lib/smc-pullback-scope.mjs';
import { CONTINUATION_REVISION, validateContinuationCandidate } from '../../../lib/smc-continuation.mjs';
import { externalStructureEvidence } from '../../../lib/smc-structure-context.mjs';
import { lifecycleSourceIsActive, planPriceEvent } from '../../../lib/smc-plan-lifecycle.mjs';
import { STOP_SLIPPAGE_BPS, evaluateStopSafety } from '../../../lib/smc-stop-safety.mjs';
import fs from 'node:fs/promises';
import { units, decimal, calibrateEntryPlan, freshRules, align } from '../../../lib/s1-precision.mjs';
import { hash, invariant, fresh, UNIVERSE, terminal } from '../s2-execution/common.mjs';
import { highLeverageStopSafety } from '../../shared/leverage-stop-safety.mjs';
import { createExecutionRuntime } from '../s2-execution/execution-runtime.mjs';
import { createProductionOrderPort } from '../s2-execution/transport.mjs';
import { OrderRequestBudget } from '../s2-execution/order-request-budget.mjs';
import { assertSharedAdmissionHost, ResidentReadAdmission } from '../s2-execution/host-admission.mjs';
import { validateSmcManualIntent } from '../../../lib/smc-manual-intent.mjs';

export const SMC_EXECUTION_REVISION = 'SMC-EXEC-11';
export const SMC_AUTHORIZATION_FILE = '/etc/aegis/smc-execution-control/authorization.json';
const SCALE = units('1');
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_-]{1,160}$/.test(value);

export function latestManualIntents(intents) {
  invariant(Array.isArray(intents) && intents.length <= 32, 'SMC_MANUAL_QUEUE_INVALID');
  const latest = new Map();
  for (const intent of intents) {
    invariant(intent && UNIVERSE.includes(intent.symbol) && ['LONG', 'SHORT'].includes(intent.direction)
      && Number.isSafeInteger(intent.createdAt), 'SMC_MANUAL_QUEUE_INVALID');
    // One owner-directed action per symbol: the latest click also supersedes
    // an older opposite-direction ticket before either can reach the venue.
    const key = intent.symbol;
    if (!latest.has(key) || intent.createdAt > latest.get(key).createdAt) latest.set(key, intent);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function smcLeverageAlignment(account, expectedLeverage = 25) {
  const actual = {}, mismatches = [];
  if (!account || !Array.isArray(account.positions) || !Number.isSafeInteger(expectedLeverage)) {
    return { expectedLeverage, ready: false, actual, mismatches: [...UNIVERSE] };
  }
  for (const symbol of UNIVERSE) {
    const rows = account.positions.filter(row => row.symbol === symbol);
    const values = [...new Set(rows.map(row => Number(row.leverage)).filter(Number.isSafeInteger))];
    actual[symbol] = values.length === 1 ? values[0] : null;
    if (actual[symbol] !== expectedLeverage) mismatches.push(symbol);
  }
  return { expectedLeverage, ready: mismatches.length === 0, actual, mismatches };
}

export function applyOwnerSelectedAutoControls(plans, controlFeed, now = Date.now()) {
  invariant(Array.isArray(plans), 'SMC_OWNER_AUTO_PLANS_INVALID');
  if (controlFeed?.status !== 'READY' || !Number.isFinite(controlFeed.checkedAt)
    || !fresh(controlFeed.checkedAt, now, 10000) || !Array.isArray(controlFeed.controls)) {
    return plans.filter(plan => plan.candidateSource !== 'OWNER_SELECTED');
  }
  const controls = new Map();
  for (const row of controlFeed.controls) {
    invariant(UNIVERSE.includes(row?.symbol) && ['LONG', 'SHORT'].includes(row?.direction)
      && typeof row.autoTradingEnabled === 'boolean', 'SMC_OWNER_AUTO_CONTROL_INVALID');
    controls.set(`${row.symbol}:${row.direction}`, row.autoTradingEnabled);
  }
  return plans.flatMap(plan => {
    if (plan.candidateSource !== 'OWNER_SELECTED') return [plan];
    if (controls.get(`${plan.symbol}:${plan.direction}`) !== true) return [];
    return [{ ...plan, ownerAutoTradingEnabled: true, ownerAutoTradingCheckedAt: controlFeed.checkedAt }];
  });
}

export function validateSmcRiskProfile(profile, limits) {
  invariant(profile?.schemaVersion === 1 && profile.accountLabel === 'S2'
    && profile.strategyRevision === SMC_EXECUTION_REVISION && profile.scannerRevision === 'SMC-SCAN-13', 'SMC_RISK_SCOPE_INVALID');
  invariant(profile.risk?.perTradeFraction === '0.04' && profile.risk?.portfolioFraction === '0.10'
    && profile.risk?.maximumOpenPositions === 4 && profile.risk?.maximumLeverage === 25
    && profile.risk?.maximumGrossNotionalLeverage === 25, 'SMC_RISK_POLICY_INVALID');
  invariant(profile.risk.pendingEntriesReserveRisk === true && profile.risk.negativeRiskOffsetsAllowed === false
    && profile.risk.minimumNotionalUpsizingAllowed === false && profile.risk.stopWideningAllowed === false
    && profile.risk.lossAveragingAllowed === false && profile.minimumNetRewardRisk === 2
    && profile.fundingReserveRate === '0.0002' && Number.isFinite(Date.parse(profile.activationAt))
    && profile.realOrdersAllowed === true, 'SMC_RISK_BOUNDARY_INVALID');
  invariant(limits?.schemaVersion === 2 && limits.accountLabel === 'S2' && limits.strategyRevision === SMC_EXECUTION_REVISION
    && limits.mode === 'LIVE_PERCENT_RISK' && limits.status === 'OWNER_RISK_RECORDED'
    && limits.perTradeRiskFraction === profile.risk.perTradeFraction
    && limits.portfolioRiskFraction === profile.risk.portfolioFraction
    && limits.maximumOpenPositions === 4 && limits.maximumLeverage === 25
    && limits.maximumGrossNotionalLeverage === 25 && limits.pendingEntryExposureReserved === true
    && limits.minimumNotionalUpsizingAllowed === false && limits.negativeExposureOffsetsAllowed === false
    && limits.realOrdersAllowed === true && limits.newEntriesBlocked === false, 'SMC_LIMITS_INVALID');
  return true;
}

export function smcCandidateSnapshot(raw, profile, now = Date.now()) {
  validateSmcRiskProfile(profile, {
    schemaVersion: 2, accountLabel: 'S2', strategyRevision: SMC_EXECUTION_REVISION, mode: 'LIVE_PERCENT_RISK',
    status: 'OWNER_RISK_RECORDED', perTradeRiskFraction: '0.04', portfolioRiskFraction: '0.10', maximumOpenPositions: 4,
    maximumLeverage: 25, maximumGrossNotionalLeverage: 25, pendingEntryExposureReserved: true,
    minimumNotionalUpsizingAllowed: false, negativeExposureOffsetsAllowed: false, realOrdersAllowed: true, newEntriesBlocked: false,
  });
  const observedAt = Date.parse(raw?.sourceAsOf);
  invariant(raw?.revision === profile.scannerRevision && raw.mode === 'OPPORTUNITY_SCAN_ONLY'
    && raw.orderAuthority === false && raw.status === 'HEALTHY' && Array.isArray(raw.candidates)
    && Array.isArray(raw.errors) && raw.errors.length === 0 && fresh(observedAt, now, profile.candidateMaximumAgeMs), 'SMC_CANDIDATE_SOURCE_INVALID');
  const activatedAt = Date.parse(profile.activationAt);
  const plans = raw.candidates
    .filter(row => Number.isFinite(row.confirmationAt) && row.confirmationAt >= activatedAt)
    // A scanner may retain an older WAIT_CE_REENTRY plan for monitoring. It is
    // not executable after the confirmation window, but it must not poison a
    // separate current candidate's entire execution snapshot.
    .filter(row => fresh(row.confirmationAt, now, profile.confirmationMaximumAgeMs)
      && Number.isFinite(row.expiresAt) && row.expiresAt > now)
    .filter(row => ['ARMED_CE_CLOSE', 'WAIT_15M_MICRO_STRUCTURE_SHIFT', 'WAIT_CE_REENTRY', 'WAIT_LIQUIDITY_SWEEP_RECLAIM', 'WAIT_VALUE_LOCATION', 'WAIT_15M_EXPANSION_CONFIRMATION', 'ENTRY_BAND_ACTIVE', 'WAIT_SECOND_BAR_CE_REVERSAL', 'WAIT_SECOND_BAR_PRICE', 'SECOND_BAR_REVERSE_READY'].includes(row.status)).map(row => {
    if (row.modelRevision === SMC_S1_ENTRY_REVISION) {
      validateSmcS1Candidate(row,now);
      invariant(profile.entryPolicyRevision === SMC_S1_ENTRY_REVISION,'SMC_PX_POLICY_NOT_AUTHORIZED');
      return Object.freeze({...structuredClone(row),createdAt:row.sourceWindow.selectedAt});
    }
    invariant(profile.entryPolicyRevision !== SMC_S1_ENTRY_REVISION,'SMC_LEGACY_AUTOMATIC_POLICY_SUPERSEDED');
    if ([CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION, DUAL_FRAME_ENTRY_REVISION].includes(row.modelRevision)) {
      (row.modelRevision === DUAL_FRAME_ENTRY_REVISION ? validateDualFrameCandidate : row.modelRevision === LOCAL_ENTRY_REVISION ? validateLocalSmcCandidate : row.modelRevision === TIMED_ENTRY_REVISION ? validateTimedEntryCandidate : validateContinuationCandidate)(row, now);
      invariant(UNIVERSE.includes(row.symbol) && row.stopSafety?.ready === true, 'CONTINUATION_SCOPE_OR_STOP');
      return Object.freeze({ ...structuredClone(row), createdAt: row.structure.bosAt,
        // Common execution envelope retains these legacy field names. The local
        // model uses its reaction/entry, never optional intersection metadata.
        intersectionTime: [LOCAL_ENTRY_REVISION,DUAL_FRAME_ENTRY_REVISION].includes(row.modelRevision) ? row.confirmationAt : row.intersectionEvent?.tx ?? row.availableAt,
        intersectionPrice: [LOCAL_ENTRY_REVISION,DUAL_FRAME_ENTRY_REVISION].includes(row.modelRevision) ? row.entryBand.trigger : row.intersectionEvent?.px ?? row.entryBand.trigger });
    }
    if(row.targetPathRevision)validateCandidateTargetPath(row,now);
    const reversal = row.entryConfirmation?.mode === 'CLOSED_15M_SECOND_BAR_CE_REVERSAL';
    invariant(row.revision === profile.scannerRevision && row.orderAuthority === false && row.executionQualified === false
      && row.winProbability === null && externalStructureEvidence(row.structure) && UNIVERSE.includes(row.symbol) && ['LONG', 'SHORT'].includes(row.direction)
      && ['AUTOMATIC', 'OWNER_SELECTED'].includes(row.candidateSource)
      && (row.candidateSource === 'OWNER_SELECTED' ? Number.isFinite(row.ownerSelectedAt)
        && typeof row.ownerAutoTradingEnabled === 'boolean'
        : row.ownerSelectedAt == null && row.ownerAutoTradingEnabled == null)
      && safeCode(row.id) && Number.isFinite(row.confirmationAt)
      && fresh(row.confirmationAt, now, profile.confirmationMaximumAgeMs)
      && Number.isFinite(row.observedAt) && fresh(row.observedAt, now, profile.candidateMaximumAgeMs)
      && Number.isFinite(row.expiresAt) && row.expiresAt > now && row.netR >= profile.minimumNetRewardRisk
      && row.zone && Number.isFinite(row.zone.low) && Number.isFinite(row.zone.high) && row.zone.low < row.zone.high
      && row.entryBand && Number.isFinite(row.entryBand.low) && Number.isFinite(row.entryBand.high)
      && Number.isFinite(row.entryBand.ce) && Number.isFinite(row.entryBand.trigger)
      && row.entryBand.low < row.entryBand.high && row.entryBand.zoneFraction === 0.5
      && row.entryBand.triggerFraction === 0.5
      && row.entryBand.half === (row.direction === 'LONG'
        ? 'CE_TO_FVG_HIGH' : 'FVG_LOW_TO_CE')
      && (row.direction === 'LONG'
        ? row.entryBand.low === row.entryBand.ce && row.entryBand.high === row.zone.high
        : row.entryBand.low === row.zone.low && row.entryBand.high === row.entryBand.ce)
      && row.entryBand.trigger === row.entryBand.ce
      && row.poiLifecycle?.exhausted === false
      && Number.isSafeInteger(row.poiLifecycle?.mitigationEpisodes)
      && row.poiLifecycle.mitigationEpisodes <= 1
      && Number.isSafeInteger(row.poiLifecycle?.ceBodyCrosses)
      && row.poiLifecycle.ceBodyCrosses <= 2
      && row.entryLiquidity?.model === 'CONFIRMED_15M_PIVOT_2X2'
      && Array.isArray(row.entryLiquidity.blocking)
      && typeof row.entryLiquidity.ready === 'boolean'
      && row.entryLiquidity.adjustedStop === row.stop
      && row.entryMicroStructure?.model === 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT'
      && typeof row.entryMicroStructure.ready === 'boolean'
      && (row.status === 'WAIT_LIQUIDITY_SWEEP_RECLAIM')
        === (row.entryMicroStructure.ready && !row.entryLiquidity.ready && Boolean(row.entryConfirmation?.ceTouch))
      && row.entryLocation?.model === 'CAUSAL_15M_DUAL_DEALING_RANGE_PERCENTILE'
      && Number.isFinite(row.entryLocation.percentile) && Number.isFinite(row.entryLocation.robustPercentile)
      && typeof row.entryLocation.ready === 'boolean'
      && row.entryRegime?.model === 'CAUSAL_15M_EXPANSION_EFFICIENCY'
      && Number.isFinite(row.entryRegime.rangeAtr) && Number.isFinite(row.entryRegime.efficiency)
      && typeof row.entryRegime.ready === 'boolean'
      && (row.status === 'WAIT_VALUE_LOCATION')
        === (row.entryMicroStructure.ready && row.entryLiquidity.ready
          && !row.entryLocation.ready && Boolean(row.entryConfirmation?.ceTouch))
      && (row.status === 'WAIT_15M_EXPANSION_CONFIRMATION')
        === (row.entryMicroStructure.ready && row.entryLiquidity.ready && row.entryLocation.ready && !row.entryRegime.ready
          && Boolean(row.entryConfirmation?.ceTouch))
      && (reversal ? (row.direction === 'LONG' ? row.entry > row.entryBand.ce : row.entry < row.entryBand.ce)
        || row.status === 'WAIT_SECOND_BAR_CE_REVERSAL' : row.entry >= row.entryBand.low && row.entry <= row.entryBand.high)
      && ['BOS', 'CHOCH', 'MSS'].includes(row.structure?.eventType)
      && ['A', 'B'].includes(row.structure?.qualityGrade)
      && ['SINGLE_BAR', 'CUMULATIVE_LEG'].includes(row.structure?.qualityModel)
      && row.structure?.nPatternRequired === false
      && (reversal || row.entryConfirmation?.mode === 'CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT')
      && row.entryConfirmation?.closedBarRequired === true
      && (reversal ? row.entryConfirmation.reversal?.oldStop > 0
        && typeof row.entryConfirmation.reversal?.plannedStopSwept === 'boolean'
        && row.entryConfirmation.reversal?.revisedStop === row.entryLiquidity.provisionalStop
        && row.entryConfirmation.reversal?.firstBarAt >= row.zone.availableAt
        && (row.status === 'WAIT_SECOND_BAR_CE_REVERSAL'
          || (row.entryConfirmation.reversal.secondBarAt === row.confirmationAt
            && row.entryConfirmation.reversal.secondBarAt > row.entryConfirmation.reversal.firstBarAt
            && (row.direction === 'LONG' ? row.entryConfirmation.reversal.secondClose > row.entryBand.ce
              : row.entryConfirmation.reversal.secondClose < row.entryBand.ce)))
        : (row.status === 'ARMED_CE_CLOSE' || (row.entryConfirmation?.ceTouch
        && ['CLOSED_15M_BODY_CROSS', 'CLOSED_15M_WICK_RECLAIM', 'CLOSED_15M_FALSE_BREAK_RECLAIM'].includes(row.entryConfirmation.ceTouch.source)
        && Number.isFinite(row.entryConfirmation.ceTouch.testedAt)
        && Number.isFinite(row.entryConfirmation.ceTouch.close)
        && row.entryConfirmation.ceTouch.close >= row.entryBand.low
        && row.entryConfirmation.ceTouch.close <= row.entryBand.high))),
    'SMC_CONFIRMED_CANDIDATE_INVALID');
    return Object.freeze({ ...structuredClone(row), createdAt: row.structure.bosAt, observedAt: row.observedAt,
      intersectionTime: row.zone.availableAt, intersectionPrice: row.entryBand.trigger });
  });
  return { observedAt, plans };
}

export function smcExecutionSignal(plan, _bars5m, strategy, now) {
  invariant(strategy?.implementationRevision === SMC_EXECUTION_REVISION && strategy.structureRevision == null,
    'SMC_EXECUTION_STRATEGY_INVALID');
  if (plan?.status === 'OWNER_MANUAL_PENDING') {
    const intent = validateSmcManualIntent(plan.intent, now);
    return { accepted: true, signal: Object.freeze({ id: `MANUAL-${intent.id.replaceAll('-', '').toUpperCase()}`,
      source: 'OWNER_MANUAL', manualIntent: intent, symbol: intent.symbol, direction: intent.direction,
      revision: SMC_EXECUTION_REVISION, closedAt: intent.createdAt, discoveredAt: intent.createdAt,
      intersectionTime: intent.createdAt, intersectionPrice: plan.referencePrice,
      stopPrice: intent.stopPrice, targetPrice: intent.targetPrice,
      orderMode: intent.orderMode, limitPrice: intent.limitPrice, timeInForce: intent.timeInForce,
      scanObservedAt: intent.createdAt, expiresAt: intent.expiresAt }) };
  }
  if (plan?.status === 'ARMED_CE_CLOSE' || plan?.status === 'WAIT_SECOND_BAR_CE_REVERSAL'
    || plan?.status === 'WAIT_LIQUIDITY_SWEEP_RECLAIM' || plan?.status === 'WAIT_VALUE_LOCATION'
    || plan?.status === 'WAIT_15M_EXPANSION_CONFIRMATION' || plan?.status === 'WAIT_15M_MICRO_STRUCTURE_SHIFT') {
    const reason = plan.status === 'WAIT_LIQUIDITY_SWEEP_RECLAIM' ? 'WAIT_15M_LIQUIDITY_SWEEP_RECLAIM'
      : plan.status === 'WAIT_VALUE_LOCATION' ? 'WAIT_15M_VALUE_LOCATION'
        : plan.status === 'WAIT_15M_EXPANSION_CONFIRMATION' ? 'WAIT_15M_EXPANSION_CONFIRMATION'
          : plan.status === 'WAIT_15M_MICRO_STRUCTURE_SHIFT' ? 'WAIT_15M_MICRO_STRUCTURE_SHIFT'
          : 'WAIT_15M_CE_TOUCH_DIRECTIONAL_CLOSE';
    return { accepted: false, terminal: false, reason };
  }
  if (!['WAIT_CE_REENTRY', 'ENTRY_BAND_ACTIVE', 'WAIT_SECOND_BAR_PRICE', 'SECOND_BAR_REVERSE_READY'].includes(plan?.status)) {
    return { accepted: false, terminal: false, reason: 'SMC_PLAN_STATE_INVALID' };
  }
  if (plan.candidateSource === 'OWNER_SELECTED'
    && (plan.ownerAutoTradingEnabled !== true || !fresh(plan.ownerAutoTradingCheckedAt, now, 10000))) {
    return { accepted: false, terminal: false, reason: 'OWNER_AUTO_TRADING_DISABLED' };
  }
  invariant(UNIVERSE.includes(plan.symbol) && ['LONG', 'SHORT'].includes(plan.direction)
    && safeCode(plan.id) && fresh(plan.observedAt, now, strategy.candidateMaximumAgeMs)
    && fresh(plan.confirmationAt, now, strategy.confirmationMaximumAgeMs) && plan.expiresAt > now,
  'SMC_SIGNAL_STALE_OR_INVALID');
  return { accepted: true, signal: Object.freeze({
    modelRevision: plan.modelRevision ?? null, ...(plan.modelRevision===SMC_S1_ENTRY_REVISION ? {pxEvidence:structuredClone(plan)} : {}), continuationEvidence: [CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION, DUAL_FRAME_ENTRY_REVISION].includes(plan.modelRevision) ? structuredClone(plan) : null,
    id: plan.id, symbol: plan.symbol, revision: SMC_EXECUTION_REVISION, direction: plan.direction,
    closedAt: plan.confirmationAt, close: String(plan.modelRevision===SMC_S1_ENTRY_REVISION ? plan.entryConfirmation.confirmation.bar.close : plan.entry), discoveredAt: plan.createdAt,
    firstBarOpenTime: plan.confirmationAt - ([CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION].includes(plan.modelRevision) ? 300000 : 900000) + 1, intersectionTime: plan.intersectionTime,
    intersectionPrice: String(plan.intersectionPrice), stopPrice: String(plan.stop), targetPrice: String(plan.target),
    zone: structuredClone(plan.zone), entryBand: structuredClone(plan.entryBand),
    structure: structuredClone(plan.structure), entryConfirmation: structuredClone(plan.entryConfirmation),
    scannerRevision: plan.revision, scanObservedAt: plan.observedAt,
    candidateSource: plan.candidateSource, ownerSelectedAt: plan.ownerSelectedAt,
    ownerAutoTradingEnabled: plan.ownerAutoTradingEnabled ?? null,
    ownerAutoTradingCheckedAt: plan.ownerAutoTradingCheckedAt ?? null,
    ...(plan.targetPathRevision?{targetPathRevision:plan.targetPathRevision,referenceTarget:plan.referenceTarget}:{}),
    sourceNetR: plan.netR, expiresAt: plan.expiresAt,
  }) };
}

export function prepareSmcEntry(input, profile, now = Date.now()) {
  try {
    validateSmcRiskProfile(profile, input.trialLimits);
    const { signal, bbo, tick, account, rule, eventGate } = input;
    invariant(signal?.revision === SMC_EXECUTION_REVISION && UNIVERSE.includes(signal.symbol)
      && ['LONG', 'SHORT'].includes(signal.direction) && safeCode(signal.id), 'SMC_SIGNAL_SCOPE_INVALID');
    const manual = signal.source === 'OWNER_MANUAL';
    if (manual) {
      const intent = validateSmcManualIntent(signal.manualIntent, now);
      invariant(input.manualOrdersEnabled === true, 'SMC_MANUAL_ENTRY_DISABLED');
      invariant(signal.id === `MANUAL-${intent.id.replaceAll('-', '').toUpperCase()}`,
        'SMC_MANUAL_SIGNAL_ID_MISMATCH');
      invariant(intent.symbol === signal.symbol && intent.direction === signal.direction,
        'SMC_MANUAL_SIGNAL_SCOPE_MISMATCH');
      invariant(String(signal.stopPrice) === intent.stopPrice && String(signal.targetPrice) === intent.targetPrice,
        'SMC_MANUAL_PROTECTION_MISMATCH');
      invariant(signal.orderMode === intent.orderMode && signal.limitPrice === intent.limitPrice
        && signal.timeInForce === intent.timeInForce, 'SMC_MANUAL_ORDER_MODE_MISMATCH');
      invariant(signal.expiresAt === intent.expiresAt, 'SMC_MANUAL_EXPIRY_MISMATCH');
    } else {
      invariant(['AUTOMATIC', 'OWNER_SELECTED'].includes(signal.candidateSource)
        && (signal.candidateSource === 'OWNER_SELECTED'
          ? Number.isFinite(signal.ownerSelectedAt) && signal.ownerAutoTradingEnabled === true
            && fresh(signal.ownerAutoTradingCheckedAt, now, 10000)
          : signal.ownerSelectedAt == null), 'SMC_CANDIDATE_SOURCE_INVALID');
      invariant(fresh(signal.scanObservedAt, now, profile.candidateMaximumAgeMs)
        && signal.closedAt >= Date.parse(profile.activationAt)
        && fresh(signal.closedAt, now, profile.confirmationMaximumAgeMs) && signal.expiresAt > now, 'SMC_SIGNAL_STALE');
    }
    const hybrid = !manual && signal.modelRevision === SMC_S1_ENTRY_REVISION;
    invariant(manual || (profile.entryPolicyRevision===SMC_S1_ENTRY_REVISION ? hybrid : !hybrid),'SMC_AUTOMATIC_POLICY_MISMATCH');
    if (hybrid) {
      const c=signal.pxEvidence; validateSmcS1Candidate(c,now);
      invariant(signal.id===c.id && signal.symbol===c.symbol && signal.direction===c.direction
        && signal.closedAt===c.confirmationAt && signal.close===String(c.entryConfirmation.confirmation.bar.close)
        && signal.stopPrice===String(c.stop) && signal.targetPrice===String(c.target)
        && signal.intersectionTime===c.intersectionTime && signal.intersectionPrice===String(c.intersectionPrice),'SMC_PX_SIGNAL_MISMATCH');
      const clock=sanitizeIntersectionClock(input.intersectionClock,now);
      invariant(clock && clock.windows.some(w=>JSON.stringify(w)===JSON.stringify(c.sourceWindow)),'SMC_PX_CURRENT_INTERSECTION_UNAVAILABLE');
      invariant(input.conditionalLifecycle?.available===true,'SMC_PX_LIFECYCLE_UNAVAILABLE');
      const confirmed=smcPxConfirmation({window:c.sourceWindow,bars15m:input.stopSafetyContext?.scopeBars15m,now});
      invariant(confirmed.accepted && confirmed.direction===(signal.direction==='LONG'?1:-1)
        && confirmed.bar.closeTime===signal.closedAt && String(confirmed.bar.close)===signal.close,'SMC_PX_LIVE_CONFIRMATION_CHANGED');
    }
    const continuation = !manual && [CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION, DUAL_FRAME_ENTRY_REVISION].includes(signal.modelRevision);
    if (continuation) {
      (signal.modelRevision === DUAL_FRAME_ENTRY_REVISION ? validateDualFrameCandidate : signal.modelRevision === LOCAL_ENTRY_REVISION ? validateLocalSmcCandidate : signal.modelRevision === TIMED_ENTRY_REVISION ? validateTimedEntryCandidate : validateContinuationCandidate)(signal.continuationEvidence, now);
      const c = signal.continuationEvidence;
      if(input.requiredTargetPathRevision)invariant(c.sourcePlan.entryPolicyRevision==='SMC-ENTRY-PATHS-2'&&c.sourcePlan.targetPathRevision===TARGET_PATH_REVISION,'SMC_ENTRY_POLICY_SUPERSEDED');
      invariant(signal.id === c.id && signal.symbol === c.symbol && signal.direction === c.direction
        && signal.closedAt === c.confirmationAt && signal.stopPrice === String(c.stop) && signal.targetPrice === String(c.target)
        && JSON.stringify(signal.entryBand) === JSON.stringify(c.entryBand), 'CONTINUATION_SIGNAL_MISMATCH');
      invariant(input.conditionalLifecycle?.available === true, 'CONTINUATION_LIFECYCLE_UNAVAILABLE');
      invariant(lifecycleSourceIsActive(c.sourcePlan, { state: input.conditionalLifecycle.state, quote: bbo, tick, now }), 'CONTINUATION_SOURCE_CONSUMED');
      if (c.sourcePlan.targetPolicyRevision === 'SMC-TARGET-4H-2') invariant(c.sourcePlan.riskScopeRevision === 'SMC-PLAN-RISK-1', 'SMC_PLAN_RISK_POLICY_SUPERSEDED');
      if (c.sourcePlan.targetPolicyRevision) {
        validateTargetBasis(c.sourcePlan);
        const current = input.conditionalLifecycle.plans?.find(p => p.id === c.sourcePlan.id);
        invariant(current && current.targetPolicyRevision === c.sourcePlan.targetPolicyRevision && current.target === c.sourcePlan.target
          && JSON.stringify(current.objective) === JSON.stringify(c.sourcePlan.objective), 'SMC_TARGET_SOURCE_CHANGED');
        invariant(c.sourcePlan.targetBasis.scope !== '4H_MAIN' || targetDirectionSupport(input.stopSafetyContext?.parentFrame, input.stopSafetyContext?.localFrame, c.direction, c.entry, now, c.sourcePlan.targetPolicyRevision), 'SMC_4H_TARGET_SUPPORT_LOST');
      }
    }
    invariant(manual || hybrid || continuation || externalStructureEvidence(signal.structure), 'SMC_EXTERNAL_STRUCTURE_NOT_CONFIRMED');
    // Authenticated owner manual execution bypasses strategy admission. The
    // account, causal market evidence, sizing, portfolio, precision and
    // protection gates below remain mandatory.
    invariant(manual || eventGate?.allowed === true && fresh(eventGate.checkedAt, now, 5000)
      && eventGate.validUntil > now, 'EVENT_GATE_CLOSED');
    invariant(account?.accountLabel === 'S2' && account.reconciled === true && account.canTrade === true
      && account.dualSidePosition === true && account.multiAssetsMargin === false
      && fresh(Date.parse(account.observedAt), now, 5000) && account.userStreamConnected === true
      && account.positionsComplete === true && account.pendingEntriesComplete === true, 'ACCOUNT_NOT_READY');
    invariant(input.diskReady === true && input.singleWriter === true && input.noUnknownOrders === true
      && input.noExistingSymbolPosition === true && input.unconsumedSignal === true, 'INFRASTRUCTURE_GATE_CLOSED');
    for (const row of [bbo, tick]) invariant(row?.symbol === signal.symbol && fresh(row.marketTime, now, 2000)
      && fresh(row.receivedAt, now, 2000) && row.marketTime >= signal.closedAt && row.connectedAt <= row.receivedAt
      && row.continuity === true && row.persisted === true && Number.isSafeInteger(row.sequence) && row.sequence > 0,
    'FORWARD_MARKET_EVIDENCE_INVALID');
    invariant(/^\d+$/.test(String(bbo.updateId)) && BigInt(bbo.updateId) > 0n, 'BBO_UPDATE_ID_REQUIRED');
    const long = signal.direction === 'LONG';
    const validRule = freshRules(rule, signal.symbol, now);
    const sourceId = manual ? signal.manualIntent.sourceId : signal.id;
    invariant(!input.conditionalLifecycle?.state?.records?.[`PLAN:${sourceId}`]?.terminal, 'ENTRY_SOURCE_CONSUMED');
    const fixedLimit = manual && signal.orderMode === 'LIMIT_GTC';
    if (manual && /^SMC-STRUCTURE-PLAN-[12]:/.test(signal.manualIntent.sourceId)) {
      const c = input.conditionalLifecycle;
      invariant(c?.available === true, 'CONDITIONAL_LIFECYCLE_UNAVAILABLE');
      const p = c.plans?.find(p => p.id === signal.manualIntent.sourceId && p.direction === signal.direction);
      invariant(p && lifecycleSourceIsActive(p, { state: c.state, quote: bbo, tick, now }), 'CONDITIONAL_SOURCE_CONSUMED');
    }

    const entryPrice = fixedLimit ? align(signal.limitPrice, validRule.price, 'EXACT') : (long ? bbo.ask : bbo.bid);
    const entry = units(entryPrice), stop = units(signal.stopPrice);
    const targetPrice = manual ? align(signal.targetPrice, validRule.price, long ? 'DOWN' : 'UP') : signal.targetPrice;
    const target = units(targetPrice);
    if (hybrid) {
      const displacement=Number((entry>=units(signal.close)?entry-units(signal.close):units(signal.close)-entry)*1000000n/units(signal.close))/100;
      invariant(fresh(signal.closedAt,now,hybridPolicy.maximumSignalAgeMs) && fresh(signal.intersectionTime,now,hybridPolicy.maximumCrossAgeMs),'SMC_PX_R19_EXPIRED');
      invariant(displacement<=hybridPolicy.maximumDisplacementBps,'SMC_PX_R19_PRICE_DISPLACEMENT');
      const current=smcPxTarget({evidence:input.stopSafetyContext?.targetPathEvidence,bars15m:input.stopSafetyContext?.scopeBars15m,
        direction:signal.direction,entry:Number(decimal(entry)),stop:Number(decimal(stop)),now});
      invariant(current.path.ready && current.referenceTarget===signal.referenceTarget
        && Math.abs(current.path.admissionTarget-Number(targetPrice))<input.stopSafetyContext.targetPathEvidence.tickSize*.01,'SMC_PX_TARGET_CHANGED_REPLAN');
    }
    if(!manual && (input.requiredTargetPathRevision || signal.targetPathRevision)) {
      invariant(signal.targetPathRevision===TARGET_PATH_REVISION,'SMC_TARGET_PATH_POLICY_REQUIRED');
      const evidence=input.stopSafetyContext?.targetPathEvidence;
      validate4hFvgEvidence(evidence,now);
      invariant(evidence.symbol===signal.symbol,'SMC_TARGET_PATH_SYMBOL');
      const path=assessTargetPath({evidence,direction:signal.direction,entry:Number(decimal(entry)),stop:Number(decimal(stop)),referenceTarget:signal.referenceTarget,tickSize:evidence.tickSize,now});
      invariant(path.ready,`SMC_${path.reason}`);
      invariant(Math.abs(path.admissionTarget-Number(targetPrice))<evidence.tickSize*.01,'SMC_TARGET_PATH_CHANGED_REPLAN');
    }
    if (continuation) {
      invariant(entry >= units(String(signal.entryBand.low)) && entry <= units(String(signal.entryBand.high)), 'SMC_LIVE_ENTRY_OUTSIDE_CONTINUATION_BAND');
    }
    if (!manual && !continuation && !hybrid) {
      const zoneLow = units(String(signal.zone?.low)), zoneHigh = units(String(signal.zone?.high));
      const entryBandLow = units(String(signal.entryBand?.low)), entryBandHigh = units(String(signal.entryBand?.high));
      const entryBandCe = units(String(signal.entryBand?.ce));
      const entryBandTrigger = units(String(signal.entryBand?.trigger));
      const expectedHalf = long ? 'CE_TO_FVG_HIGH' : 'FVG_LOW_TO_CE';
      const reversal = signal.entryConfirmation?.mode === 'CLOSED_15M_SECOND_BAR_CE_REVERSAL';
      const recordedCeTouch = signal.entryConfirmation?.ceTouch;
      const touchRecorded = recordedCeTouch && ['CLOSED_15M_BODY_CROSS', 'CLOSED_15M_WICK_RECLAIM', 'CLOSED_15M_FALSE_BREAK_RECLAIM'].includes(recordedCeTouch.source)
        && Number.isFinite(recordedCeTouch.testedAt) && recordedCeTouch.testedAt >= signal.intersectionTime
        && recordedCeTouch.testedAt === signal.closedAt && recordedCeTouch.testedAt <= now
        && Number.isFinite(recordedCeTouch.close)
        && units(String(recordedCeTouch.close)) >= entryBandLow && units(String(recordedCeTouch.close)) <= entryBandHigh;
      const reversalEvidence = signal.entryConfirmation?.reversal;
      const reversalRecorded = reversal && reversalEvidence?.source === 'CLOSED_15M_SECOND_BAR_CE_REVERSAL'
        && Number.isFinite(reversalEvidence.firstBarAt) && Number.isFinite(reversalEvidence.secondBarAt)
        && reversalEvidence.secondBarAt - reversalEvidence.firstBarAt === 900000
        && reversalEvidence.secondBarAt === signal.closedAt && reversalEvidence.firstBarAt >= signal.intersectionTime
        && Number.isFinite(reversalEvidence.firstOpen) && Number.isFinite(reversalEvidence.firstClose)
        && Number.isFinite(reversalEvidence.secondOpen) && Number.isFinite(reversalEvidence.secondClose)
        && [reversalEvidence.firstHigh, reversalEvidence.firstLow, reversalEvidence.secondHigh,
          reversalEvidence.secondLow, reversalEvidence.atr15].every(Number.isFinite)
        && reversalEvidence.atr15 > 0
        && reversalEvidence.firstHigh >= Math.max(reversalEvidence.firstOpen, reversalEvidence.firstClose)
        && reversalEvidence.firstLow <= Math.min(reversalEvidence.firstOpen, reversalEvidence.firstClose)
        && reversalEvidence.secondHigh >= Math.max(reversalEvidence.secondOpen, reversalEvidence.secondClose)
        && reversalEvidence.secondLow <= Math.min(reversalEvidence.secondOpen, reversalEvidence.secondClose)
        && Math.abs(reversalEvidence.firstClose - reversalEvidence.firstOpen)
          / (reversalEvidence.firstHigh - reversalEvidence.firstLow) >= 0.6
        && Math.abs(reversalEvidence.secondClose - reversalEvidence.secondOpen)
          / (reversalEvidence.secondHigh - reversalEvidence.secondLow) >= 0.6
        && Math.abs(reversalEvidence.firstClose - reversalEvidence.firstOpen) >= 0.5 * reversalEvidence.atr15
        && Math.abs(reversalEvidence.secondClose - reversalEvidence.secondOpen) >= 0.5 * reversalEvidence.atr15
      && Number.isFinite(reversalEvidence.oldStop) && Number.isFinite(reversalEvidence.revisedStop)
      && typeof reversalEvidence.plannedStopSwept === 'boolean'
      && (long ? stop <= units(String(reversalEvidence.revisedStop)) : stop >= units(String(reversalEvidence.revisedStop)))
      && (long ? reversalEvidence.firstOpen > Number(signal.entryBand.ce) && reversalEvidence.firstClose < Number(signal.entryBand.ce)
        && reversalEvidence.secondOpen < Number(signal.entryBand.ce) && reversalEvidence.secondClose > Number(signal.entryBand.ce)
        && (reversalEvidence.plannedStopSwept
          ? reversalEvidence.firstLow <= reversalEvidence.oldStop : reversalEvidence.firstLow > reversalEvidence.oldStop)
        && reversalEvidence.revisedStop < Math.min(reversalEvidence.firstLow, reversalEvidence.secondLow)
        : reversalEvidence.firstOpen < Number(signal.entryBand.ce) && reversalEvidence.firstClose > Number(signal.entryBand.ce)
        && reversalEvidence.secondOpen > Number(signal.entryBand.ce) && reversalEvidence.secondClose < Number(signal.entryBand.ce)
        && (reversalEvidence.plannedStopSwept
          ? reversalEvidence.firstHigh >= reversalEvidence.oldStop : reversalEvidence.firstHigh < reversalEvidence.oldStop)
        && reversalEvidence.revisedStop > Math.max(reversalEvidence.firstHigh, reversalEvidence.secondHigh))
        && now - signal.closedAt <= 1200000;
      invariant(reversal ? reversalRecorded : touchRecorded, 'SMC_CE_CLOSE_NOT_CONFIRMED');
      invariant(entry > 0n && stop > 0n && target > 0n && zoneLow < zoneHigh
        && entryBandLow >= zoneLow && entryBandHigh <= zoneHigh && entryBandLow < entryBandHigh
        && signal.entryBand?.zoneFraction === 0.5 && signal.entryBand?.half === expectedHalf
        && signal.entryBand?.triggerFraction === 0.5 && entryBandTrigger === entryBandCe
        && (long ? entryBandLow === entryBandCe && entryBandHigh === zoneHigh
          : entryBandLow === zoneLow && entryBandHigh === entryBandCe)
        && (reversal ? (long ? entry > entryBandCe : entry < entryBandCe)
          && Math.abs(Number(decimal(entry)) - reversalEvidence.secondClose) / reversalEvidence.secondClose <= 0.005
          : entry >= entryBandLow && entry <= entryBandHigh), 'SMC_LIVE_ENTRY_OUTSIDE_CE_BAND');

    }

    const distance = long ? entry - stop : stop - entry, gain = long ? target - entry : entry - target;
    invariant(distance > 0n && gain > 0n, 'SMC_STOP_TARGET_INVALID');
    const currentEvent = planPriceEvent({ direction: signal.direction, target: Number(signal.targetPrice),
      stop: Number(signal.stopPrice), availableAt: signal.closedAt }, { quote: bbo, tick, now, checkExpiry: false });
    invariant(!currentEvent, `ENTRY_LIFECYCLE_${currentEvent?.reason ?? 'INVALID'}`);
    invariant(fresh(input.markObservedAt, now, 2000), 'MARK_PRICE_STALE');
    const fee = units(input.takerFeeRate), slip = units(input.adverseSlippageRate), funding = units(profile.fundingReserveRate);
    invariant(fresh(input.feeObservedAt, now, 300000) && input.feeEvidenceComplete === true
      && fee > 0n && fee < units('0.01') && slip > 0n && slip < units('0.01'), 'FEE_SLIPPAGE_EVIDENCE_INVALID');
    const rate = fee + slip;
    if(hybrid) {
      const modeledEntry=Number(decimal(entry))*(1+(long?1:-1)*Number(input.adverseSlippageRate));
      const modeledStop=Number(decimal(stop));
      const costGate=evaluateV2CostEfficiencyGate({entry:modeledEntry,initialRiskPerUnit:Math.abs(modeledEntry-modeledStop)
        +modeledEntry*Number(input.takerFeeRate)+modeledStop*(Number(input.takerFeeRate)+Number(input.adverseSlippageRate)),
        takerFeeRate:Number(input.takerFeeRate),adverseSlippageRate:Number(input.adverseSlippageRate),maximumCompleteLifecycleCostR:hybridPolicy.maximumCompleteLifecycleCostR});
      invariant(costGate.allowed,costGate.reason);
    }
    const stopSlip = slip > units(String(STOP_SLIPPAGE_BPS / 10000)) ? slip : units(String(STOP_SLIPPAGE_BPS / 10000));
    const riskPerUnit = distance + (entry * rate + SCALE - 1n) / SCALE + (stop * (fee + stopSlip) + SCALE - 1n) / SCALE
      + (entry * funding + SCALE - 1n) / SCALE;
    const rewardPerUnit = gain - (entry * rate + SCALE - 1n) / SCALE - (target * rate + SCALE - 1n) / SCALE
      - (entry * funding + SCALE - 1n) / SCALE;
    invariant(rewardPerUnit > 0n && (manual
      || rewardPerUnit >= riskPerUnit * BigInt(profile.minimumNetRewardRisk)), 'SMC_NET_R_BELOW_2');
    const stopTradePlan = continuation ? signal.continuationEvidence.sourcePlan : manual && input.conditionalLifecycle?.available
      ? validatedPullbackPlan(input.conditionalLifecycle.plans, signal.symbol, signal.direction, input.stopSafetyContext, now,
        p => lifecycleSourceIsActive(p, {state:input.conditionalLifecycle.state,quote:bbo,tick,now})) : null;
    const stopSafety = hybrid ? {revision:SMC_S1_ENTRY_REVISION,ready:true,reason:null,source:'S1_PX_BUFFER_5BPS',
      initialStopFixedBeforeRiskSizing:true,stopSlippageBps:STOP_SLIPPAGE_BPS} : evaluateStopSafety({ context: input.stopSafetyContext, symbol: signal.symbol, direction: signal.direction,
      tradePlan: stopTradePlan,
      entry: fixedLimit ? (long ? Math.min(Number(decimal(entry)), Number(bbo.ask)) : Math.max(Number(decimal(entry)), Number(bbo.bid))) : Number(decimal(entry)), stop: Number(decimal(stop)), bid: Number(bbo.bid), ask: Number(bbo.ask),
      tick: Number(tick.price), riskCostPerUnit: Number(decimal(riskPerUnit - distance)), now });
    invariant(stopSafety.ready, `ENTRY_CONFIRMATION_${stopSafety.reason}`);
    const equity = units(account.equityUsdt), available = units(account.availableBalanceUsdt);
    invariant(equity > 0n && available >= 0n && Array.isArray(account.positions) && Array.isArray(account.pendingEntries), 'ACCOUNT_EQUITY_INVALID');
    const exposures = [...account.positions, ...account.pendingEntries];
    invariant(exposures.length < profile.risk.maximumOpenPositions, 'SMC_POSITION_CAP_REACHED');
    let committedRisk = 0n, committedNotional = 0n;
    for (const row of exposures) {
      invariant(row.riskEvidenceComplete === true && row.exposureEvidenceComplete === true, 'SMC_PORTFOLIO_EVIDENCE_INCOMPLETE');
      committedRisk += units(row.committedRiskUsdt);
      committedNotional += units(row.grossNotionalUsdt ?? row.reservedNotionalUsdt);
    }
    const perTrade = equity * units(profile.risk.perTradeFraction) / SCALE;
    const portfolio = equity * units(profile.risk.portfolioFraction) / SCALE;
    const remainingRisk = portfolio > committedRisk ? portfolio - committedRisk : 0n;
    const riskBudget = min(perTrade, remainingRisk);
    const grossCap = equity * BigInt(profile.risk.maximumGrossNotionalLeverage);
    const remainingNotional = grossCap > committedNotional ? grossCap - committedNotional : 0n;
    invariant(riskBudget > 0n && remainingNotional > 0n, 'SMC_PORTFOLIO_CAP_REACHED');
    invariant(Number.isInteger(input.observedLeverage)
      && input.observedLeverage === profile.risk.maximumLeverage, 'SMC_LEVERAGE_INVALID');
    invariant(highLeverageStopSafety({ leverage: input.observedLeverage, marginType: input.observedMarginType,
      entry, riskPerUnit }), 'SMC_LEVERAGE_STOP_UNSAFE');
    const leverage = BigInt(input.observedLeverage);
    const marginPerUnit = (entry + leverage - 1n) / leverage + (entry * fee + SCALE - 1n) / SCALE;
    const quantity = min(riskBudget * SCALE / riskPerUnit, remainingNotional * SCALE / entry, available * SCALE / marginPerUnit);
    invariant(quantity > 0n, 'SMC_SIZE_ZERO_AFTER_CAPS');
    align(targetPrice, validRule.price, 'EXACT');
    const calibration = calibrateEntryPlan({ symbol: signal.symbol, direction: signal.direction, orderType: 'LIMIT',
      price: decimal(entry), quantity: decimal(quantity), stopPrice: signal.stopPrice, workingType: 'CONTRACT_PRICE',
      lastPrice: tick.price, markPrice: input.markPrice, bid: bbo.bid, ask: bbo.ask,
      marketObservedAt: new Date(now).toISOString(), feeSlippagePerUnit: decimal(riskPerUnit - distance),
      riskBudget: decimal(riskBudget) }, validRule, now);
    invariant(calibration.status === 'CALIBRATED_PRECISION_ONLY', calibration.reason ?? 'SMC_PRECISION_REJECTED');
    const plan = {
      schema: 'S2_VALIDATED_ENTRY_V1', id: signal.id, symbol: signal.symbol, direction: signal.direction,
      revision: SMC_EXECUTION_REVISION, executionRevision: SMC_EXECUTION_REVISION,
      price: calibration.price, quantity: calibration.quantity, stopPrice: calibration.stopPrice,
      source: manual ? 'OWNER_MANUAL' : 'SMC_AUTO', targetPrice,
      conditionalSourceId: manual && /^SMC-STRUCTURE-PLAN-[12]:/.test(signal.manualIntent.sourceId) ? signal.manualIntent.sourceId : null,
      orderMode: fixedLimit ? 'LIMIT_GTC' : 'IMMEDIATE', timeInForce: fixedLimit ? 'GTC' : 'IOC',
      candidateSource: manual ? 'OWNER_MANUAL' : signal.candidateSource,
      ownerSelectedAt: manual ? null : signal.ownerSelectedAt,
      managementMode: 'SMC_STRUCTURE_TARGET', managementPolicy: null,
      ...(hybrid ? {entryPolicyRevision:SMC_S1_ENTRY_REVISION,smcTrailPolicy:SMC_S1_TRAIL_REVISION,automaticPartialExits:false,sourceIntersectionId:signal.pxEvidence.intersectionEvent.id} : {}),
      ...(!manual && ['SMC-TARGET-4H-1','SMC-TARGET-4H-2'].includes(signal.continuationEvidence?.sourcePlan.targetPolicyRevision) ? {smcTrailPolicy:'SMC-4H-TRAIL-1',targetPolicyRevision:signal.continuationEvidence.sourcePlan.targetPolicyRevision} : {}),
      plannedRiskUsdt: calibration.estimatedRisk, budgetUsdt: decimal(riskBudget), initialRiskPerUnit: decimal(riskPerUnit),
      takerFeeRate: input.takerFeeRate, adverseSlippageRate: input.adverseSlippageRate, stopAdverseSlippageRate: decimal(stopSlip),
      trialLimitsFingerprint: hash(input.trialLimits), notionalBudgetUsdt: decimal(remainingNotional),
      // The immutable draft must survive the account refresh and two durable
      // pre-dispatch gates. Each gate rebuilds against fresh market/account
      // evidence, so a longer draft lifetime does not authorize stale quotes.
      createdAt: now, validUntil: Math.min(now + 15000, signal.expiresAt),
      scannerRevision: signal.scannerRevision, sourceNetR: signal.sourceNetR,
      evidence: { stopSafety, stopTradePlan:stopTradePlan?structuredClone(stopTradePlan):null, bboSequence: bbo.sequence, tickSequence: tick.sequence, bboUpdateId: String(bbo.updateId),
        accountObservedAt: account.observedAt, ruleObservedAt: validRule.observedAt,
        scanObservedAt: signal.scanObservedAt, confirmationAt: signal.closedAt,
        netRewardRiskRatio: decimal(rewardPerUnit * SCALE / riskPerUnit),
        // Pin the fully validated signal for the short pre-dispatch sequence.
        // The gates still rebuild price, size, account, market and policy
        // admission; they no longer depend on a second remote candidate fetch
        // whose latency or snapshot rotation cannot invalidate this identity.
        revalidationSignal: structuredClone(signal),
        ...(manual ? { manualIntent: structuredClone(signal.manualIntent) } : {
          candidateSource: signal.candidateSource, ownerSelectedAt: signal.ownerSelectedAt,
          ownerAutoTradingEnabled: signal.ownerAutoTradingEnabled ?? null,
          ownerAutoTradingCheckedAt: signal.ownerAutoTradingCheckedAt ?? null,
          zone: structuredClone(signal.zone), entryBand: structuredClone(signal.entryBand),
          structure: structuredClone(signal.structure), entryConfirmation: structuredClone(signal.entryConfirmation) }) },
    };
    return { status: 'VALIDATED_LIVE_READY', plan: { ...plan, fingerprint: hash(plan) } };
  } catch (error) { return { status: 'REJECTED', reason: error?.message ?? 'SMC_ENTRY_REJECTED' }; }
}

// Cancel only the unfilled remainder through the existing durable single writer.
// A racing partial fill stays owned and is protected by the normal lifecycle.
export async function guardRestingSmcEntries({ kernel, market, fees, now }) {
  let canceled = false;
  for (const plan of kernel.plans.values()) {
    if (plan.executionRevision !== SMC_EXECUTION_REVISION || plan.timeInForce !== 'GTC') continue;
    const intent = [...kernel.intents.values()].find(i => i.planId === plan.id && i.kind === 'entry');
    if (!intent || terminal(intent.result?.status)) continue;
    const m = market[plan.symbol], bbo = m?.bbo, tick = m?.tick;
    const fee = Number(fees[plan.symbol]?.takerFeeRate);
    const cost = (Number(plan.price) + Number(plan.stopPrice)) * (fee + .0002)
      + Number(plan.stopPrice) * .0008 + Number(plan.price) * .0002;
    const safety = evaluateStopSafety({ context: m?.stopSafetyContext, symbol: plan.symbol, direction: plan.direction,
      tradePlan: plan.evidence?.stopTradePlan ?? null,
      entry: plan.direction === 'LONG' ? Math.min(Number(plan.price), Number(bbo?.ask)) : Math.max(Number(plan.price), Number(bbo?.bid)), stop: Number(plan.stopPrice), bid: Number(bbo?.bid), ask: Number(bbo?.ask),
      tick: Number(tick?.price), riskCostPerUnit: cost, now });
    const stale = [bbo, tick].some(row => !fresh(row?.marketTime, now, 2000) || !fresh(row?.receivedAt, now, 2000)
      || row?.continuity !== true || row?.persisted !== true)
      || !fresh(fees[plan.symbol]?.observedAt, now, 300000);
    // A native resting order cannot outlive its frozen safety context indefinitely.
    const lifecycleEvent = planPriceEvent({ ...plan, availableAt: Date.parse(plan.createdAt) || plan.createdAt }, { quote: bbo, tick, now, checkExpiry: false });
    const familyTerminal = m?.conditionalLifecycle?.state?.records?.[`PLAN:${plan.evidence?.manualIntent?.sourceId ?? plan.id}`]?.terminal;
    const sourceActive = !familyTerminal && (!plan.conditionalSourceId || m?.conditionalLifecycle?.available === true
      && m.conditionalLifecycle.plans?.some(p => p.id === plan.conditionalSourceId
        && lifecycleSourceIsActive(p, { state: m.conditionalLifecycle.state, quote: bbo, tick, now })));
    if (safety.ready && !stale && !lifecycleEvent && sourceActive && now <= plan.createdAt + 900000) continue;
    await kernel.once('cancel', `${plan.id}:stop_safety_entry`, 'DELETE', '/fapi/v1/order',
      { symbol: plan.symbol, origClientOrderId: intent.id }, plan.id);
    const observed = await kernel.observe(intent.id);
    await kernel.protectEntry(plan, observed);
    canceled = true;
  }
  return canceled;
}

export function validSmcAuthorization(config, limits) {
  if (config?.schema !== 'SMC_EXECUTION_AUTHORIZATION_V1' || config.accountLabel !== 'S2'
    || config.strategyRevision !== SMC_EXECUTION_REVISION || config.trialLimitsDigest !== hash(limits)
    || typeof config.enabled !== 'boolean' || typeof config.entriesEnabled !== 'boolean'
    || typeof config.exitsEnabled !== 'boolean' || config.orderAuthority !== true) return null;
  if (config.manualEntriesEnabled !== undefined && typeof config.manualEntriesEnabled !== 'boolean') return null;
  if (!config.enabled && (config.entriesEnabled || config.exitsEnabled)) return null;
  if (config.entriesEnabled && !config.exitsEnabled) return null;
  if (config.manualEntriesEnabled === true && (!config.enabled || !config.entriesEnabled || !config.exitsEnabled)) return null;
  return config;
}

export function createSmcMutationPermit({ limits, load = async () => JSON.parse(await fs.readFile(SMC_AUTHORIZATION_FILE, 'utf8')) }) {
  return async operation => {
    try {
      const config = validSmcAuthorization(await load(), limits);
      if (!config?.enabled || !config.exitsEnabled) return false;
      const clientId = String(operation?.params?.newClientOrderId ?? '');
      const entry = operation?.method === 'POST' && operation?.pathname === '/fapi/v1/order' && clientId.startsWith('s2_entry_');
      return !entry || config.entriesEnabled === true;
    } catch { return false; }
  };
}

export async function readSmcAuthorizationStatus({ limits, load = async () => JSON.parse(await fs.readFile(SMC_AUTHORIZATION_FILE, 'utf8')) }) {
  try {
    const config = validSmcAuthorization(await load(), limits);
    if (!config) return { status: 'INVALID_OR_UNREADABLE', enabled: false, entriesEnabled: false, exitsEnabled: false, manualEntriesEnabled: false };
    return { status: !config.enabled ? 'DISABLED' : config.entriesEnabled ? 'ENABLED_ENTRIES_AND_EXITS' : 'ENABLED_EXITS_ONLY',
      enabled: config.enabled, entriesEnabled: config.entriesEnabled, exitsEnabled: config.exitsEnabled,
      manualEntriesEnabled: config.manualEntriesEnabled === true };
  } catch { return { status: 'INVALID_OR_UNREADABLE', enabled: false, entriesEnabled: false, exitsEnabled: false, manualEntriesEnabled: false }; }
}

export function createSmcProductionExecutionRuntime({ credentials, ipBudget, maximumOrders10s, maximumOrders60s, trialLimits, ...options }) {
  assertSharedAdmissionHost();
  invariant(ipBudget instanceof ResidentReadAdmission && !ipBudget.stopping && !ipBudget.closed, 'PRODUCTION_SHARED_ADMISSION_REQUIRED');
  const permit = createSmcMutationPermit({ limits: trialLimits });
  return createExecutionRuntime({ ...options, trialLimits, authorizeOperation: permit,
    createOrderPort: book => createProductionOrderPort({ credentials, mutationPermit: permit,
      orderBudget: new OrderRequestBudget({ book, ipBudget, maximumOrders10s, maximumOrders60s }) }),
  });
}
