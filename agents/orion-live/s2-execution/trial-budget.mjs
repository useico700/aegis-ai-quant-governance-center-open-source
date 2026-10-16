import { units, decimal } from '../../../lib/s1-precision.mjs';
import { invariant, fresh, REVISION } from './common.mjs';

// No monetary defaults: "small" is not an amount or an activation instruction.
// Exposure is gross (never long-minus-short), including all unresolved entries.
export function evaluateTrialBudget(account, limits, now = Date.now()) {
  try {
    const livePercentRisk = limits?.schemaVersion === 2 && limits.mode === 'LIVE_PERCENT_RISK';
    const legacySmallTrial = limits?.schemaVersion === 1 && limits.mode === 'SMALL_TRIAL';
    invariant((livePercentRisk || legacySmallTrial) && limits.accountLabel === 'S2' && limits.strategyRevision === REVISION, 'TRIAL_SCOPE_INVALID');
    invariant(livePercentRisk ? limits.status === 'OWNER_RISK_RECORDED' : limits.status === 'OWNER_AMOUNTS_RECORDED', 'TRIAL_AMOUNTS_NOT_CONFIGURED');
    invariant(limits.minimumNotionalUpsizingAllowed === false && limits.negativeExposureOffsetsAllowed === false && limits.pendingEntryExposureReserved === true, 'TRIAL_BOUNDARY_INVALID');
    invariant(Number.isSafeInteger(limits.maximumOpenPositions) && limits.maximumOpenPositions > 0 && limits.maximumOpenPositions <= 8, 'TRIAL_POSITION_LIMIT_INVALID');
    if (livePercentRisk) invariant(limits.perTradeRiskFraction === '0.04' && limits.portfolioRiskFraction === '0.12'
      && limits.equityBasis === 'CURRENT_RECONCILED_S2_MARGIN_BALANCE_USDT'
      && limits.automaticRiskScalingWithEquity === true && [4, 25].includes(limits.maximumLeverage)
      && limits.maximumGrossNotionalLeverage === 4 && limits.grossNotionalMustNotExceedEquity === false,
    'TRIAL_PERCENT_RISK_INVALID');
    else {
      invariant(limits.grossNotionalMustNotExceedEquity === true, 'TRIAL_POSITION_LIMIT_INVALID');
      for (const key of ['maximumGrossNotionalUsdt', 'maximumPlannedLossPerTradeUsdt']) invariant(typeof limits[key] === 'string' && /^\d+(\.\d+)?$/.test(limits[key]) && units(limits[key]) > 0n, 'TRIAL_AMOUNT_INVALID');
    }
    invariant(account?.accountLabel === 'S2' && account.reconciled === true && fresh(Date.parse(account.observedAt), now, 5000), 'TRIAL_ACCOUNT_STALE_OR_UNRECONCILED');
    invariant(account.positionsComplete === true && account.pendingEntriesComplete === true && Array.isArray(account.positions) && Array.isArray(account.pendingEntries), 'TRIAL_EXPOSURE_INCOMPLETE');
    const equity = units(account.equityUsdt);
    invariant(equity > 0n, 'TRIAL_EQUITY_INVALID');
    const configuredMaximum = livePercentRisk ? equity * BigInt(limits.maximumGrossNotionalLeverage) : units(limits.maximumGrossNotionalUsdt);
    const loss = livePercentRisk ? equity * units(limits.perTradeRiskFraction) / units('1') : units(limits.maximumPlannedLossPerTradeUsdt);
    const maximum = livePercentRisk ? configuredMaximum : configuredMaximum < equity ? configuredMaximum : equity;
    let committed = 0n;
    const ids = new Set();
    for (const [rows, field] of [[account.positions, 'grossNotionalUsdt'], [account.pendingEntries, 'reservedNotionalUsdt']]) {
      for (const row of rows) {
        invariant(typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'TRIAL_EXPOSURE_ID_INVALID'); ids.add(row.id);
        invariant(row.exposureEvidenceComplete === true, 'TRIAL_EXPOSURE_EVIDENCE_MISSING');
        committed += units(row[field]);
      }
    }
    const remaining = maximum > committed ? maximum - committed : 0n;
    const positionCapacity = account.positions.length + account.pendingEntries.length < limits.maximumOpenPositions;
    return { status: !positionCapacity ? 'TRIAL_POSITION_CAP_REACHED' : remaining > 0n ? 'TRIAL_BUDGET_AVAILABLE_ONLY' : 'TRIAL_GROSS_CAP_REACHED', maximumGrossNotionalUsdt: decimal(maximum),
      committedGrossNotionalUsdt: decimal(committed), remainingGrossNotionalUsdt: decimal(remaining), maximumPlannedLossPerTradeUsdt: decimal(loss),
      riskMode: livePercentRisk ? 'LIVE_PERCENT_RISK' : 'LEGACY_SMALL_TRIAL',
      perTradeRiskFraction: livePercentRisk ? limits.perTradeRiskFraction : null,
      portfolioRiskFraction: livePercentRisk ? limits.portfolioRiskFraction : null,
      maximumOpenPositions: limits.maximumOpenPositions,
      maximumLeverage: livePercentRisk ? limits.maximumLeverage : 1,
      maximumGrossNotionalLeverage: livePercentRisk ? limits.maximumGrossNotionalLeverage : 1,
      realOrdersAllowed: livePercentRisk && limits.realOrdersAllowed === true,
      submissionAllowed: false };
  } catch (error) { return { status: 'REJECTED', reason: error.message, realOrdersAllowed: false, submissionAllowed: false }; }
}
