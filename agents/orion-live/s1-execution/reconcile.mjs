import { units, decimal } from '../../../lib/s1-precision.mjs';
import { fresh, invariant, closeSide } from './common.mjs';

// Account-wide reconciliation is intentionally stricter than symbol-only checks.
// Foreign/manual orders are never adopted, canceled or managed automatically.
export function reconcileAccount(snapshot, managed, now = Date.now()) {
  const issues = [];
  try {
    invariant(fresh(snapshot?.observedAt, now, 5000) && snapshot.userStreamConnected === true, 'ACCOUNT_OR_STREAM_STALE');
    invariant(snapshot.positionsComplete === true && snapshot.ordersComplete === true && snapshot.algosComplete === true, 'SNAPSHOT_INCOMPLETE');
    invariant(snapshot.dualSidePosition === true && snapshot.multiAssetsMargin === false && snapshot.canTrade === true, 'ACCOUNT_MODE_OR_PERMISSION_CHANGED');
    invariant(Array.isArray(snapshot.positions) && Array.isArray(snapshot.orders) && Array.isArray(snapshot.algos), 'ACCOUNT_ARRAYS_REQUIRED');
    invariant(Array.isArray(managed.positions) && Array.isArray(managed.pending), 'MANAGED_STATE_REQUIRED');
    const expected = new Map();
    for (const position of managed.positions) {
      const key = `${position.symbol}:${position.direction}`;
      invariant(!expected.has(key), 'DUPLICATE_MANAGED_POSITION'); expected.set(key, position);
    }
    const observedKeys = new Set();
    for (const row of snapshot.positions) {
      const quantity = units(String(row.positionAmt).replace(/^-/, ''));
      if (quantity === 0n) continue;
      const key = `${row.symbol}:${row.positionSide}`;
      invariant(!observedKeys.has(key), 'DUPLICATE_VENUE_POSITION'); observedKeys.add(key);
      const position = expected.get(key);
      if (!position) { issues.push({ code: 'UNOWNED_POSITION', symbol: row.symbol, direction: row.positionSide }); continue; }
      if (units(position.quantity) !== quantity) issues.push({ code: 'POSITION_QUANTITY_MISMATCH', id: position.id });
      if (position.accountingComplete !== true) issues.push({ code: 'FILL_ACCOUNTING_INCOMPLETE', id: position.id });
      const protections = snapshot.algos.filter(algo => algo.clientAlgoId === position.stopClientId && algo.symbol === position.symbol && algo.positionSide === position.direction);
      const stop = protections[0];
      const protective = protections.length === 1 && stop.algoStatus === 'NEW' && (stop.orderType ?? stop.type) === 'STOP_MARKET'
        && String(stop.closePosition) === 'true' && stop.side === closeSide(position.direction) && stop.workingType === 'CONTRACT_PRICE'
        && String(stop.priceProtect) === 'false' && units(stop.triggerPrice) === units(position.stopPrice);
      if (!protective) issues.push({ code: 'PROTECTION_MISSING_OR_MISMATCHED', id: position.id });
    }
    for (const [key, position] of expected) if (!observedKeys.has(key) && units(position.quantity) > 0n) issues.push({ code: 'VENUE_CLOSE_REQUIRES_FILL_RECONCILIATION', id: position.id });
    const ownIds = new Set(managed.pending.map(row => row.clientId));
    const stopIds = new Set(managed.positions.map(row => row.stopClientId));
    for (const order of snapshot.orders) if (!ownIds.has(order.clientOrderId)) issues.push({ code: 'UNOWNED_ORDER', symbol: order.symbol });
    for (const order of snapshot.algos) if (!stopIds.has(order.clientAlgoId) && !ownIds.has(order.clientAlgoId)) issues.push({ code: 'UNOWNED_ALGO', symbol: order.symbol });
    for (const pending of managed.pending) if (pending.resolved !== true) issues.push({ code: 'UNRESOLVED_INTENT', id: pending.id });
    const gross = snapshot.positions.reduce((sum, row) => sum + units(String(row.notional).replace(/^-/, '')), 0n);
    return { status: issues.length ? 'BLOCKED_RECONCILIATION' : 'RECONCILED', newEntriesBlocked: issues.length > 0, issues, observedAt: now, grossNotionalUsdt: decimal(gross), mutationAllowed: false };
  } catch (error) { return { status: 'BLOCKED_RECONCILIATION', newEntriesBlocked: true, issues: [...issues, { code: error.message }], observedAt: now, mutationAllowed: false }; }
}
