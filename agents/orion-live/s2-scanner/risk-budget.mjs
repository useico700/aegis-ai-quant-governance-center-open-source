// Offline S2 risk-budget calculation. No exchange client or order submission.
import { units, decimal } from '../../../lib/s1-precision.mjs';

const SCALE = units('1');
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };

export function evaluateS2RiskBudget(input, profile, now = Date.now()) {
  const boundary = { executable: false, submissionAllowed: false, mode: 'OFFLINE_RISK_PREPARATION' };
  try {
    requireValue(profile?.accountLabel === 'S2' && input?.accountLabel === 'S2', 'ACCOUNT_SCOPE_MISMATCH');
    requireValue(profile.strategyRevision === 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION', 'STRATEGY_MISMATCH');
    requireValue(profile.risk?.perTradeFraction === '0.04' && profile.risk?.portfolioFraction === '0.12', 'RISK_POLICY_MISMATCH');
    const age = now - Date.parse(input.observedAt);
    requireValue(Number.isFinite(now) && Number.isFinite(age) && age >= 0 && age <= 120000, 'ACCOUNT_STALE_OR_FUTURE');
    requireValue(input.reconciled === true && input.userStreamConnected === true && input.positionsComplete === true && input.pendingEntriesComplete === true, 'ACCOUNT_EVIDENCE_INCOMPLETE');
    requireValue(Array.isArray(input.positions) && Array.isArray(input.pendingEntries), 'RISK_ITEMS_MISSING');
    const equity = units(input.equityUsdt);
    requireValue(equity > 0n, 'EQUITY_NOT_POSITIVE');
    const perTradeCap = equity * units(profile.risk.perTradeFraction) / SCALE;
    const portfolioCap = equity * units(profile.risk.portfolioFraction) / SCALE;
    let committed = 0n;
    const ids = new Set();
    // Every open position and unresolved entry reserves nonnegative stop-loss risk,
    // including estimated costs. Profitable stops cannot offset another trade's risk.
    for (const row of [...input.positions, ...input.pendingEntries]) {
      requireValue(typeof row?.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'RISK_ITEM_ID_MISSING_OR_DUPLICATE');
      ids.add(row.id);
      requireValue(row.riskEvidenceComplete === true, 'RISK_EVIDENCE_INCOMPLETE');
      committed += units(row.committedRiskUsdt);
    }
    const remaining = portfolioCap > committed ? portfolioCap - committed : 0n;
    const budget = remaining < perTradeCap ? remaining : perTradeCap;
    const result = { ...boundary, status: budget > 0n ? 'BUDGET_AVAILABLE_ONLY' : 'PORTFOLIO_CAP_REACHED',
      equityUsdt: decimal(equity), perTradeCapUsdt: decimal(perTradeCap), portfolioCapUsdt: decimal(portfolioCap),
      committedRiskUsdt: decimal(committed), remainingPortfolioRiskUsdt: decimal(remaining), nextTradeBudgetUsdt: decimal(budget) };
    if (input.proposedRiskUsdt !== undefined) {
      const proposed = units(input.proposedRiskUsdt);
      result.proposedRiskWithinBudget = proposed > 0n && proposed <= budget;
      if (!result.proposedRiskWithinBudget) result.status = 'PROPOSED_RISK_REJECTED';
    }
    return result;
  } catch (error) {
    return { ...boundary, status: 'REJECTED', reason: error.message };
  }
}
