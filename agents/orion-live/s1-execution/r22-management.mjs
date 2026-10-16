import { units, decimal, align } from '../../../lib/s1-precision.mjs';
import { netLiquidationR, stopForAggregateNetRFloor, updateHourlyStructureTrail } from '../../orion-v2/paper/paper-engine.mjs';
import { r21AtrTrail } from '../../shared/r21-profit-protection.mjs';
import { fresh, invariant } from './common.mjs';
import { aggregateLiquidationNetR, resolveProfitRetentionPolicy } from '../../shared/profit-retention.mjs';

// R22 decisions only. Threshold observations never count as executions: stage,
// remaining quantity and realized PnL are committed from reconciled venue fills.
export function nextR22Action(position, quote, runtime, rules, now = Date.now()) {
  invariant(position?.accountingComplete === true && position.status === 'OPEN', 'ACTUAL_FILL_ACCOUNTING_REQUIRED');
  invariant(fresh(quote?.marketTime, now, 2000) && fresh(quote?.receivedAt, now, 2000) && quote.persisted === true && quote.continuity === true, 'FRESH_PERSISTED_BBO_REQUIRED');
  const bid = Number(quote.bid), ask = Number(quote.ask);
  invariant(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask >= bid, 'BBO_INVALID');
  invariant(rules?.marketLot && [rules.marketLot.min, rules.marketLot.step]
    .every(value => typeof value === 'string' && Number(value) > 0), 'MANAGEMENT_RULES_NOT_READY');
  const raw = position.direction === 1 ? bid : ask;
  if (position.direction === 1 ? raw <= position.stop : raw >= position.stop) return { type: 'CLOSE', reason: 'STOP_FIRST', quantity: String(position.quantity) };
  const netR = netLiquidationR(position, raw, runtime);
  invariant(Number.isFinite(netR), 'NET_R_INVALID');
  const policy = resolveProfitRetentionPolicy(position.managementPolicy, position, runtime.paperRisk);
  if (policy?.firstHarvestInvalid === true) return { type: 'CLOSE', reason: 'FIRST_HARVEST_TARGET_NOT_NET_POSITIVE', quantity: String(position.quantity), netR };
  if (policy && position.secondPartialTaken) return { type: 'HOLD', netR };
  if (policy && position.profitRetention?.active === true
    && aggregateLiquidationNetR(position, raw, runtime.paperRisk) <= position.profitRetention.floorR) {
    const original = units(String(position.originalQuantity)), remaining = units(String(position.quantity));
    const step = units(rules.marketLot.step), minimum = units(rules.marketLot.min);
    let tail = original * 15n / 100n / step * step;
    if (tail < minimum) tail = 0n;
    const harvest = remaining - tail;
    if (harvest >= minimum) return { type: 'REDUCE', stage: 'PROFIT_RETENTION_HARVEST',
      flag: 'secondPartialTaken', quantity: decimal(harvest), netR,
      aggregateFloor: position.pendingAggregateFloor ?? policy?.stages?.[0]?.floor ?? 0.15 };
  }
  const stages = policy?.stages ?? [{ flag: 'softLockTaken', r: 0.5, cumulative: 40, floor: 0.15, label: 'SOFT' }, { flag: 'firstPartialTaken', r: 1, cumulative: 65, floor: 0.60, label: 'ONE_R' }, { flag: 'secondPartialTaken', r: 2, cumulative: 85, floor: 0.60, label: 'TWO_R' }];
  for (const stage of stages) {
    if (position[stage.flag] === true) continue;
    if (netR < stage.r) break;
    const original = units(String(position.originalQuantity)), remaining = units(String(position.quantity)), step = units(rules.marketLot.step);
    const targetClosed = (original * BigInt(stage.cumulative) / 100n) / step * step;
    const alreadyClosed = original - remaining;
    const requested = targetClosed > alreadyClosed ? targetClosed - alreadyClosed : 0n;
    invariant(alreadyClosed >= 0n && requested <= remaining, 'POSITION_QUANTITY_INVALID');
    if (requested === 0n || requested < units(rules.marketLot.min)) {
      // A prospective small position cannot pretend to have realized profit.
      // When no legal partial fits, realize the remaining amount, never upsize.
      if (policy) return { type: 'CLOSE', reason: 'PROFIT_LOCK_BELOW_LOT_FULL_EXIT', quantity: String(position.quantity), netR };
      return { type: 'DEFER_ZERO_LOT_STAGE', stage: stage.label, flag: stage.flag, aggregateFloor: stage.floor, netR };
    }
    const quantity = align(decimal(requested), rules.marketLot, 'EXACT');
    return { type: 'REDUCE', stage: stage.label, flag: stage.flag, quantity, aggregateFloor: stage.floor, netR };
  }
  return { type: 'HOLD', netR };
}

export function r22StopProposal(position, { runtime, strategy, bars1h, bars15m, aggregateFloor = null }) {
  invariant(position.accountingComplete === true, 'ACTUAL_FILL_ACCOUNTING_REQUIRED');
  let proposed = { ...position };
  const choose = candidate => {
    if (Number.isFinite(candidate) && candidate > 0) proposed.stop = position.direction === 1 ? Math.max(proposed.stop, candidate) : Math.min(proposed.stop, candidate);
  };
  // An uninstalled tighter proposal must not retreat on the next calculation.
  choose(Number(position.desiredStop));
  // The dynamic threshold harvests the main position in nextR22Action. It is
  // deliberately NOT a full-close stop: that would kill the reserved runner.
  const revised = !!position.managementPolicy;
  const floorPosition = revised ? { ...position,
    cumulativeRealizedNetPnl: position.cumulativeRealizedNetPnl + Number(position.fundingNetUsdt) } : position;
  let floor = aggregateFloor;
  if (revised) {
    invariant(Number.isFinite(floorPosition.cumulativeRealizedNetPnl), 'PROFIT_RETENTION_ACCOUNTING_REQUIRED');
    if (position.secondPartialTaken) floor = Math.max(floor ?? 0, floorPosition.cumulativeRealizedNetPnl / position.initialPlannedRiskUsdt);
  }
  if (floor !== null) choose(stopForAggregateNetRFloor(floorPosition, runtime, floor));
  if (position.secondPartialTaken) {
    proposed = updateHourlyStructureTrail(proposed, bars1h, strategy).position;
    proposed = r21AtrTrail(proposed, bars15m, revised
      ? { ...runtime.portfolioProfitProtection, usePreEntryAtrHistory: true } : runtime.portfolioProfitProtection).position;
  }
  return { changed: proposed.stop !== position.stop, proposed, executable: false };
}

// Fee/funding records may arrive late. Missing non-USDT conversions cannot be
// silently treated as zero. This projector is deterministic and duplicate-safe.
export function actualFillTotals(fills, expectedQuantity, expectedOrderId) {
  const seen = new Set(); let quantity = 0, quote = 0, fees = 0, realized = 0;
  let exactQuantity = 0n;
  for (const fill of fills) {
    invariant(String(fill.orderId) === String(expectedOrderId), 'FILL_ORDER_MISMATCH');
    invariant(fill.id !== undefined && fill.id !== null && String(fill.id).match(/^\d+$/), 'TRADE_ID_REQUIRED');
    const id = String(fill.id);
    invariant(!seen.has(id), 'DUPLICATE_TRADE_ID'); seen.add(id);
    invariant(fill.commissionAsset === 'USDT', 'FEE_CONVERSION_REQUIRED');
    exactQuantity += units(String(fill.qty));
    const q = Number(fill.qty), p = Number(fill.price), fee = Number(fill.commission), pnl = Number(fill.realizedPnl);
    invariant([q, p, fee, pnl].every(Number.isFinite) && q > 0 && p > 0 && fee >= 0, 'FILL_VALUES_INVALID');
    quantity += q; quote += q * p; fees += fee; realized += pnl;
  }
  invariant(exactQuantity === units(String(expectedQuantity)) && quantity > 0, 'TRADE_HISTORY_INCOMPLETE');
  return { quantity: decimal(exactQuantity), averagePrice: quote / quantity, feesUsdt: fees, realizedPnlUsdt: realized, accountingComplete: true, tradeIds: [...seen] };
}
