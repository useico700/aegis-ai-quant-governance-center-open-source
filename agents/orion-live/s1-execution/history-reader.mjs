import { invariant } from './common.mjs';
import { units } from '../../../lib/s1-precision.mjs';

export async function readOrderFills(transport, { symbol, orderId, executedQty }) {
  // Without fromId Binance returns the most recent fills, which can omit the
  // beginning of a heavily fragmented order. orderId + fromId is supported.
  const collected = new Map(); let fromId = '0';
  for (let page = 0; page < 100; page++) {
    const rows = await transport.request('GET', '/fapi/v1/userTrades', { symbol, orderId, limit: 1000, ...(fromId === undefined ? {} : { fromId }) });
    invariant(Array.isArray(rows), 'TRADE_HISTORY_NOT_ARRAY');
    for (const row of rows) {
      invariant(row.symbol === symbol && String(row.orderId) === String(orderId) && /^\d+$/.test(String(row.id)), 'TRADE_HISTORY_SCOPE_MISMATCH');
      const key = String(row.id), old = collected.get(key);
      invariant(!old || JSON.stringify(old) === JSON.stringify(row), 'TRADE_HISTORY_CONFLICT'); collected.set(key, row);
    }
    const sum = [...collected.values()].reduce((total, row) => total + units(row.qty), 0n);
    invariant(sum <= units(executedQty), 'TRADE_HISTORY_EXCESS');
    if (sum === units(executedQty)) return [...collected.values()];
    invariant(rows.length === 1000, 'TRADE_HISTORY_INCOMPLETE');
    const next = (rows.reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, 0n) + 1n).toString();
    invariant(fromId === undefined || BigInt(next) > BigInt(fromId), 'TRADE_HISTORY_CURSOR_STALLED'); fromId = next;
  }
  throw new Error('TRADE_HISTORY_PAGE_LIMIT');
}

// Windows <= 7 days; page by time-bounded income history. Overlap on subsequent
// polls lets late funding records arrive; ledger keys make overlap idempotent.
export async function readIncomeWindow(transport, startTime, endTime) {
  invariant(Number.isSafeInteger(startTime) && Number.isSafeInteger(endTime) && startTime > 0 && endTime >= startTime && endTime - startTime <= 7 * 86400000, 'INCOME_WINDOW_INVALID');
  const result = new Map();
  for (let page = 1; page <= 100; page++) {
    const rows = await transport.request('GET', '/fapi/v1/income', { startTime, endTime, page, limit: 1000 });
    invariant(Array.isArray(rows), 'INCOME_HISTORY_NOT_ARRAY');
    for (const row of rows) {
      invariant(row.time >= startTime && row.time <= endTime, 'INCOME_OUTSIDE_WINDOW');
      const key = `${row.incomeType}:${row.tranId}`, old = result.get(key);
      invariant(!old || JSON.stringify(old) === JSON.stringify(row), 'INCOME_HISTORY_CONFLICT'); result.set(key, row);
    }
    if (rows.length < 1000) return [...result.values()];
  }
  throw new Error('INCOME_HISTORY_PAGE_LIMIT');
}
