import { evaluateV2CostEfficiencyGate } from '../../orion-v2/paper/paper-engine.mjs';
import { simpleAdmission, SIMPLE_ADMISSION_REVISION } from '../../shared/px-band-risk-only.mjs';
import { units, decimal, calibrateEntryPlan, freshRules } from '../../../lib/s1-precision.mjs';
import { evaluateS1RiskBudget } from '../s1-scanner/risk-budget.mjs';
import { hash, invariant, fresh, REVISION, EXECUTION_REVISION, ENTRY_QUALITY_REVISION, UNIVERSE } from './common.mjs';
import { evaluateTrialBudget } from './trial-budget.mjs';
import { evaluateIq1Portfolio, evaluateIq1Shape } from '../../orion-v2/paper/iq1-entry-quality.mjs';
import { S1_PROFIT_RETENTION_POLICY, createAdaptiveFirstHarvestPolicy } from '../../shared/profit-retention.mjs';
import { highLeverageStopSafety } from '../../shared/leverage-stop-safety.mjs';

import { evaluateEntryConfirmation } from '../../shared/entry-confirmation.mjs';

const SCALE = units('1');
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
export const COST_POLICY_REVISION = 'S1-S2-COST-IN-RISK-C1-20260919';

// Exact decimal sizing after signal formation; no invented fills or account
// balance. Call again with a fresh frame immediately before submitting an intent.
export function prepareEntry(input, profile, now = Date.now()) {
  try {
    const { signal, bbo, tick, account, rule, eventGate } = input;
    const r22Rollback = input.entryQuality?.profile?.policyRevision === 'S1-R22-ROLLBACK-20261010';
    const originalPaperRules = r22Rollback || input.entryQuality?.profile?.policyRevision === 'S1-IQ1-P1-PAPER-FINAL-20261010';
    const simplified = simpleAdmission(input.entryQuality?.profile);
    const requestsSimple = simplified || simpleAdmission(signal) || simpleAdmission(input.trialLimits);
    invariant(!requestsSimple || (simplified && simpleAdmission(signal) && simpleAdmission(input.trialLimits)
      && input.entryQualityRequired === true), 'PX_ADMISSION_POLICY_MISMATCH');
    invariant(UNIVERSE.includes(signal?.symbol) && signal.revision === REVISION, 'SIGNAL_SCOPE_INVALID');
    invariant(['LONG', 'SHORT'].includes(signal.direction) && typeof signal.id === 'string' && signal.id.length > 0, 'SIGNAL_INVALID');
    invariant([signal.closedAt, signal.discoveredAt, signal.firstBarOpenTime].every(Number.isFinite) && signal.closedAt <= now && (simplified ? Number.isFinite(signal.intersectionTime) && signal.discoveredAt <= signal.intersectionTime && signal.intersectionTime <= signal.closedAt : signal.discoveredAt <= signal.firstBarOpenTime) && signal.firstBarOpenTime <= signal.closedAt, 'SIGNAL_NON_CAUSAL_OR_EXPIRED');
    invariant(eventGate?.allowed === true && fresh(eventGate.checkedAt, now, 5000) && eventGate.validUntil > now, 'EVENT_GATE_CLOSED');
    invariant(account?.reconciled === true && account.canTrade === true && account.dualSidePosition === true && account.multiAssetsMargin === false, 'ACCOUNT_NOT_RECONCILED_HEDGE_SINGLE_ASSET');
    invariant(fresh(Date.parse(account.observedAt), now, 5000) && account.userStreamConnected === true, 'ACCOUNT_OR_USER_STREAM_STALE');
    invariant(input.diskReady === true && input.singleWriter === true && input.noUnknownOrders === true, 'INFRASTRUCTURE_GATE_CLOSED');
    invariant(input.noExistingSymbolPosition === true && input.unconsumedSignal === true, 'POSITION_OR_SIGNAL_ALREADY_USED');
    invariant(simplified || input.portfolioEntryAllowed !== false, 'R21_DIRECTION_ENTRY_FROZEN');
    for (const row of [bbo, tick]) {
      invariant(row?.symbol === signal.symbol && fresh(row.marketTime, now, 2000) && fresh(row.receivedAt, now, 2000), 'FORWARD_MARKET_EVIDENCE_STALE');
      invariant(Number.isFinite(row.connectedAt) && row.marketTime >= signal.closedAt && row.receivedAt >= row.connectedAt && row.continuity === true && row.persisted === true, 'FORWARD_MARKET_EVIDENCE_INCOMPLETE');
      invariant(Number.isSafeInteger(row.sequence) && row.sequence > 0, 'FORWARD_SEQUENCE_INVALID');
    }
    invariant(String(bbo.updateId).match(/^\d+$/) && BigInt(bbo.updateId) > 0n, 'BBO_UPDATE_ID_REQUIRED');
    const bid = units(bbo.bid), ask = units(bbo.ask), reference = units(signal.close);
    invariant(bid > 0n && ask >= bid && reference > 0n && units(tick.price) > 0n, 'MARKET_PRICES_INVALID');
    let iq1Shape = null, iq1Portfolio = null;
    if (input.entryQualityRequired === true && !r22Rollback) {
      const quality = input.entryQuality;
      invariant(quality?.profile?.revision === ENTRY_QUALITY_REVISION && quality.plan?.id === signal.id,
        'IQ1_RUNTIME_EVIDENCE_REQUIRED');
      iq1Shape = evaluateIq1Shape({ plan: quality.plan,
        signal: { direction: signal.iq1Direction, bar: signal.iq1Bar,
          route: signal.pxEntryRoute, opportunityId: signal.pxOpportunityId },
        quote: { bid: Number(bbo.bid), ask: Number(bbo.ask), marketTime: bbo.marketTime,
          receivedAt: bbo.receivedAt, coverageComplete: bbo.continuity === true && bbo.persisted === true },
        anchor: quality.anchor, context: quality.context, profile: quality.profile, now, localNow: now,
        loadedAt: quality.loadedAt, epoch: quality.epoch, bars: quality.bars,
        slippageRate: Number(input.adverseSlippageRate) });
      invariant(iq1Shape.allowed === true, iq1Shape.reason ?? 'IQ1_SHAPE_REJECTED');
    }
    const entry = signal.direction === 'LONG' ? ask : bid;
    const displacement = entry >= reference ? entry - reference : reference - entry;
    const signalCloseDisplacementBps = Number(displacement * 1000000n / reference) / 100;
    if (r22Rollback) {
      invariant(fresh(signal.closedAt, now, 180000), 'R22_CONFIRMATION_EXPIRED');
      invariant(signalCloseDisplacementBps <= 50, 'R22_CONFIRMATION_PRICE_DISPLACEMENT');
      invariant(fresh(signal.intersectionTime, now, 1800000), 'R22_CROSS_EXPIRED');
    }
    const valid = freshRules(rule, signal.symbol, now);
    const risk = evaluateS1RiskBudget(account, profile, now);
    invariant(risk.status === 'BUDGET_AVAILABLE_ONLY', 'RISK_BUDGET_UNAVAILABLE');
    const trial = evaluateTrialBudget(account, input.trialLimits, now);
    invariant(trial.status === 'TRIAL_BUDGET_AVAILABLE_ONLY', trial.reason ?? 'TRIAL_GROSS_CAP_REACHED');
    invariant(fresh(input.markObservedAt, now, 2000), 'MARK_PRICE_STALE');
    const fee = units(input.takerFeeRate), slip = units(input.adverseSlippageRate);
    invariant(fresh(input.feeObservedAt, now, 300000) && input.feeEvidenceComplete === true && fee > 0n && fee < units('0.01') && slip > 0n && slip < units('0.01'), 'FEE_SLIPPAGE_EVIDENCE_INVALID');
    const stop = units(signal.stopPrice);
    const distance = signal.direction === 'LONG' ? entry - stop : stop - entry;
    invariant(distance > 0n, 'STOP_NOT_PROTECTIVE');
    // An IOC limit caps entry price; both entry and exit adverse allowances remain
    // included for conservative budget comparison, not as assumed actual fills.
    const costs = (entry * (fee + slip) + stop * (fee + slip) + SCALE - 1n) / SCALE;
    const perUnit = distance + costs;
    let costEfficiencyGuard = null;
    if (originalPaperRules) {
      const direction = signal.direction === 'LONG' ? 1 : -1;
      const modeledEntry = Number(decimal(entry)) * (1 + direction * Number(input.adverseSlippageRate));
      const modeledStop = Number(decimal(stop));
      costEfficiencyGuard = evaluateV2CostEfficiencyGate({ entry: modeledEntry,
        initialRiskPerUnit: Math.abs(modeledEntry-modeledStop) + modeledEntry*Number(input.takerFeeRate)
          + modeledStop*(Number(input.takerFeeRate)+Number(input.adverseSlippageRate)),
        takerFeeRate:Number(input.takerFeeRate),adverseSlippageRate:Number(input.adverseSlippageRate),
        maximumCompleteLifecycleCostR:0.12 });
      invariant(costEfficiencyGuard.allowed, costEfficiencyGuard.reason);
    }
    // Costs consume the same loss budget as the stop distance. Their share of
    // that risk is audit telemetry, not a separate minimum-distance entry gate.
    const budget = min(units(risk.nextTradeBudgetUsdt), units(trial.maximumPlannedLossPerTradeUsdt));
    const availableMargin = units(account.availableBalanceUsdt);
    const maximumLeverage = input.trialLimits.maximumLeverage ?? 1;
    invariant(units(input.remainingNotionalUsdt) > 0n && Number.isInteger(input.observedLeverage)
      && input.observedLeverage >= 1 && input.observedLeverage <= maximumLeverage, 'MARGIN_CAPACITY_MISSING');
    invariant(highLeverageStopSafety({ leverage: input.observedLeverage, marginType: input.observedMarginType,
      entry, riskPerUnit: perUnit }), 'ISOLATED_HIGH_LEVERAGE_STOP_UNSAFE');
    // No leverage changes, borrowing, minimum-notional upsizing or risk offsets.
    const marginPerUnit = (entry + BigInt(input.observedLeverage) - 1n) / BigInt(input.observedLeverage) + (entry * fee + SCALE - 1n) / SCALE;
    const notionalBudget = min(units(input.remainingNotionalUsdt), units(trial.remainingGrossNotionalUsdt));
    const quantity = min(budget * SCALE / perUnit, notionalBudget * SCALE / entry, availableMargin * SCALE / marginPerUnit);
    const calibration = calibrateEntryPlan({ symbol: signal.symbol, direction: signal.direction, orderType: 'LIMIT', price: decimal(entry), quantity: decimal(quantity), stopPrice: signal.stopPrice,
      workingType: 'CONTRACT_PRICE', lastPrice: tick.price, markPrice: input.markPrice, bid: bbo.bid, ask: bbo.ask, marketObservedAt: new Date(now).toISOString(), feeSlippagePerUnit: decimal(costs), riskBudget: decimal(budget) }, valid, now);
    invariant(calibration.status === 'CALIBRATED_PRECISION_ONLY', calibration.reason ?? 'PRECISION_REJECTED');
    if (input.entryQualityRequired === true) {
      const quality = input.entryQuality;
      iq1Portfolio = evaluateIq1Portfolio({ candidate: { id: signal.id, symbol: signal.symbol,
        direction: signal.iq1Direction, entry: Number(calibration.price), quantity: Number(calibration.quantity),
        plannedRiskUsdt: Number(calibration.estimatedRisk) }, positions: quality.positions,
        pending: quality.pending, correlation: quality.correlation, profile: quality.profile,
        equity: Number(account.equityUsdt), now, localNow: now, replacementId: quality.replacementId ?? null });
      invariant(iq1Portfolio.allowed === true, iq1Portfolio.reason ?? 'IQ1_PORTFOLIO_REJECTED');
    }
    let entryConfirmation = null;
    if (input.entryConfirmationPolicy) {
      invariant(input.entryConfirmationPolicy.account === 'S1', 'ENTRY_CONFIRMATION_ACCOUNT_INVALID');
      const guard = evaluateEntryConfirmation({ policy: input.entryConfirmationPolicy, now,
        direction: signal.direction === 'LONG' ? 1 : -1, signalClosedAt: signal.closedAt,
        entryBars: input.entryQuality?.bars, bars1h: input.entryQuality?.bars1h, quote: bbo,
        entryPrice: Number(calibration.price), modeledEntry: Number(calibration.price), stopPrice: Number(calibration.stopPrice),
        initialRiskPerUnit: Number(decimal(perUnit)), takerFeeRate: Number(input.takerFeeRate),
        adverseSlippageRate: Number(input.adverseSlippageRate), tickSize: Number(valid.price.step), lastLossExit: input.lastLossExit });
      invariant(guard.allowed === true, guard.reason ?? 'ENTRY_CONFIRMATION_WAIT');
      entryConfirmation = { revision: guard.revision, policy: { ...input.entryConfirmationPolicy },
        proof: guard.proof, firstHarvestTarget: guard.firstHarvestTarget,
        costs: { takerFeeRate: input.takerFeeRate, adverseSlippageRate: input.adverseSlippageRate },
        reference: { price: guard.metrics.referencePrice, windowStart: guard.metrics.referenceWindowStart,
          windowEnd: guard.metrics.referenceWindowEnd, barsHash: guard.metrics.referenceBarsHash, state: guard.metrics.referenceState },
        lastLossExit: input.lastLossExit, reason: guard.reason, metrics: guard.metrics };
    }
    const plan = { schema: 'S1_VALIDATED_ENTRY_V1', id: signal.id, symbol: signal.symbol, direction: signal.direction, revision: REVISION,
      executionRevision: r22Rollback ? REVISION : input.entryQualityRequired === true ? EXECUTION_REVISION : null,
      costPolicyRevision: COST_POLICY_REVISION,
      managementPolicy: originalPaperRules ? null : entryConfirmation ? createAdaptiveFirstHarvestPolicy({ account: 'S1', firstHarvestTarget: entryConfirmation.firstHarvestTarget }) : { ...S1_PROFIT_RETENTION_POLICY },
      ...(entryConfirmation ? { entryConfirmation } : {}),
      entryAdmissionRevision: simplified ? SIMPLE_ADMISSION_REVISION : null,
      entryQualityRevision: r22Rollback ? null : input.entryQualityRequired === true ? ENTRY_QUALITY_REVISION : null,
      price: calibration.price, quantity: calibration.quantity, stopPrice: calibration.stopPrice, plannedRiskUsdt: calibration.estimatedRisk,
      budgetUsdt: decimal(budget), initialRiskPerUnit: decimal(perUnit), takerFeeRate: input.takerFeeRate, adverseSlippageRate: input.adverseSlippageRate,
      trialLimitsFingerprint: hash(input.trialLimits), notionalBudgetUsdt: decimal(notionalBudget),
      intersectionTime: signal.intersectionTime ?? null, fourHourLineStatus: signal.fourHourLineStatus ?? null,
      createdAt: now, validUntil: Math.min(now + 1000, eventGate.validUntil),
      evidence: { bboSequence: bbo.sequence, tickSequence: tick.sequence, bboUpdateId: String(bbo.updateId), accountObservedAt: account.observedAt, ruleObservedAt: valid.observedAt,
        pxOpportunityId: signal.pxOpportunityId ?? null, pxEntryRoute: signal.pxEntryRoute ?? null,
        signalCloseDisplacementBps, signalCloseDisplacementPolicy: r22Rollback ? 'R19_MAXIMUM_50_BPS' : 'TELEMETRY_ONLY',
        costPolicy: costEfficiencyGuard ? 'V2_ORIGINAL_MAXIMUM_0_12R_PLUS_LIVE_COST_IN_RISK' : 'INCLUDED_IN_RISK_BUDGET_NO_RATIO_GATE',
        ...(costEfficiencyGuard ? { costEfficiencyGuard } : {}),
        feeSlippagePerUnit: decimal(costs),
        estimatedFeeSlippageUsdt: decimal((costs * units(calibration.quantity) + SCALE - 1n) / SCALE),
        costFractionOfInitialRisk: decimal(costs * SCALE / perUnit),
        ...(iq1Shape ? { iq1ShapeReason: iq1Shape.reason, iq1ShapeMetrics: iq1Shape.metrics,
          iq1PortfolioReason: iq1Portfolio.reason, iq1PortfolioMetrics: iq1Portfolio.metrics } : {}) } };
    return { status: 'VALIDATED_OFFLINE_NOT_ACTIVATED', plan: { ...plan, fingerprint: hash(plan) } };
  } catch (error) { return { status: 'REJECTED', reason: error.message }; }
}
