import {validatedPullbackPlan} from './smc-pullback-scope.mjs';
import { evaluateStopSafety, STOP_SLIPPAGE_BPS } from './smc-stop-safety.mjs';
// Display estimate only. The existing SMC writer alone may size and submit live orders.
export function validateManualOrderPrices({ direction, entry, stop, target }) {
  if (!['LONG', 'SHORT'].includes(direction) || !Number.isFinite(entry) || entry <= 0)
    return { valid: false, code: 'ENTRY_INVALID' };
  if (!Number.isFinite(stop) || stop <= 0) return { valid: false, code: 'STOP_INVALID' };
  if (!Number.isFinite(target) || target <= 0) return { valid: false, code: 'TARGET_INVALID' };
  if (direction === 'LONG' && stop >= entry) return { valid: false, code: 'LONG_STOP_DIRECTION' };
  if (direction === 'SHORT' && stop <= entry) return { valid: false, code: 'SHORT_STOP_DIRECTION' };
  if (direction === 'LONG' && target <= entry) return { valid: false, code: 'LONG_TARGET_DIRECTION' };
  if (direction === 'SHORT' && target >= entry) return { valid: false, code: 'SHORT_TARGET_DIRECTION' };
  return { valid: true, code: null };
}

export function estimateManualOrder(input) {
  const { direction, entry, stop, target, equity, available, committedRisk, committedNotional,
    perTradeRiskFraction = .04, portfolioRiskFraction = .10,
    maximumGrossNotionalLeverage = 25, maximumLeverage = 25 } = input;
  if (!validateManualOrderPrices({ direction, entry, stop, target }).valid
    || ![equity, available, committedRisk, committedNotional, perTradeRiskFraction,
      portfolioRiskFraction, maximumGrossNotionalLeverage, maximumLeverage].every(Number.isFinite)
    || equity <= 0 || available < 0
    || committedRisk < 0 || committedNotional < 0
    || perTradeRiskFraction <= 0 || portfolioRiskFraction <= 0
    || maximumGrossNotionalLeverage <= 0 || maximumLeverage <= 0) return null;
  const distance = direction === 'LONG' ? entry - stop : stop - entry;
  const gain = direction === 'LONG' ? target - entry : entry - target;
  if (distance <= 0 || gain <= 0) return null;
  const friction = .0008; // illustrative fee and adverse slippage
  const funding = .0002;
  const riskPerUnit = distance + (entry + stop) * friction + entry * funding + stop * (STOP_SLIPPAGE_BPS - 3) / 10000;
  const live = Number(input.livePrice ?? entry);
  const stopSafety = evaluateStopSafety({ context: input.stopContext, tradePlan:validatedPullbackPlan(input.tradePlans,input.symbol,direction,input.stopContext,input.now??Date.now()), symbol: input.symbol, direction, entry: input.orderMode === 'LIMIT_GTC' ? (direction === 'LONG' ? Math.min(entry, live) : Math.max(entry, live)) : entry, stop,
    bid: live, ask: live, tick: live, riskCostPerUnit: riskPerUnit - distance, now: input.now ?? Date.now() });
  const rewardPerUnit = gain - (entry + target) * friction - entry * funding;
  const netR = rewardPerUnit / riskPerUnit;
  const portfolioRiskLimit = equity * portfolioRiskFraction;
  const grossNotionalLimit = equity * maximumGrossNotionalLeverage;
  const riskBudget = Math.max(0, Math.min(equity * perTradeRiskFraction, portfolioRiskLimit - committedRisk));
  const grossCapacity = Math.max(0, grossNotionalLimit - committedNotional);
  const marginCapacity = Math.max(0, available * maximumLeverage / 1.01);
  const quantity = Math.max(0, Math.min(riskBudget / riskPerUnit, grossCapacity / entry, marginCapacity / entry));
  const limitingCapacity = riskBudget <= 0 ? 'PORTFOLIO_RISK'
    : grossCapacity <= 0 ? 'GROSS_NOTIONAL'
      : marginCapacity <= 0 ? 'AVAILABLE_MARGIN'
        : null;
  return { stopSafety, riskBudget, quantity, notional: quantity * entry, margin: quantity * entry / maximumLeverage,
    estimatedLoss: quantity * riskPerUnit, netR, riskPerUnit,
    automaticNetRThresholdMet: rewardPerUnit >= 2 * riskPerUnit,
    costModel: { basis: 'ILLUSTRATIVE_UI_ESTIMATE', feePlusSlippageBpsPerSide: friction * 10000, fundingReserveBps: funding * 10000 },
    perTradeRiskFraction, portfolioRiskFraction, maximumGrossNotionalLeverage, maximumLeverage,
    portfolioRiskLimit, committedRisk, remainingRisk: Math.max(0, portfolioRiskLimit - committedRisk),
    grossNotionalLimit, committedNotional, grossCapacity, marginCapacity, limitingCapacity };
}
