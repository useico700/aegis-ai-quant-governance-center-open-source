import { invariant } from './common.mjs';
import { readIntentSpec } from './read-intent-catalog.mjs';
import { ACCOUNT_BATCH_PATHS } from './transport.mjs';
import { readRequestWeight } from './request-budget.mjs';

const descriptor = (pathname, params = {}, method = 'GET') => Object.freeze({ method, pathname,
  params: Object.freeze(Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, String(v)]))) });
export const requestBindingKey = request => JSON.stringify([request.method, request.pathname,
  Object.entries(request.params).sort(([a], [b]) => a.localeCompare(b))]);

// Exact semantics for the current finite catalog. The aggregate history entry
// still covers only INITIAL pages; each additional page has its own intent. Window
// timestamps are retained unchanged while queued. No credential inputs exist.
export function readIntentRequests(id, context = {}) {
  const spec = readIntentSpec(id), [, kind, symbol, interval] = id.split(':');
  invariant(context && Object.getPrototypeOf(context) === Object.prototype, 'READ_BINDING_CONTEXT');
  const history = kind === 'history', windowed = ['history', 'trades', 'forced'].includes(kind);
  invariant(Object.keys(context).sort().join(',') === (windowed ? 'endTime,startTime' : ''), 'READ_BINDING_CONTEXT');
  if (windowed) invariant(Number.isSafeInteger(context.startTime) && context.startTime > 0
    && Number.isSafeInteger(context.endTime) && context.endTime >= context.startTime
    && context.endTime - context.startTime <= 7 * 86400000, 'READ_BINDING_WINDOW');
  let requests;
  if (kind === 'account') {
    requests = ACCOUNT_BATCH_PATHS.map(p => descriptor(p));
    if (id === 'reader:account') requests = [descriptor('/fapi/v1/time'), ...requests, descriptor('/fapi/v1/time')];
  } else if (kind === 'time') requests = [descriptor('/fapi/v1/time')];
  else if (kind === 'stream') requests = [descriptor('/fapi/v1/listenKey', {}, symbol.toUpperCase())];
  else if (kind === 'rules') requests = [descriptor('/fapi/v1/exchangeInfo')];
  else if (kind === 'fee') requests = [descriptor('/fapi/v1/commissionRate', { symbol: symbol.toUpperCase() })];
  else if (kind === 'quote') requests = [descriptor('/fapi/v1/ticker/bookTicker', { symbol: symbol.toUpperCase() })];
  else if (kind === 'bar') requests = [descriptor('/fapi/v1/klines', { symbol: symbol.toUpperCase(), interval,
    limit: { '15m': 320, '1h': 1200, '4h': 500 }[interval] })];
  else if (history) {
    const params = { symbol: symbol.toUpperCase(), ...context };
    requests = [descriptor('/fapi/v1/userTrades', { ...params, limit: 1000 }),
      ...['LIQUIDATION', 'ADL'].map(autoCloseType => descriptor('/fapi/v1/forceOrders', { ...params, limit: 100, autoCloseType }))];
  }
  else if (kind === 'trades') requests = [descriptor('/fapi/v1/userTrades', { symbol: symbol.toUpperCase(), ...context, limit: 1000 })];
  else if (kind === 'forced') requests = [descriptor('/fapi/v1/forceOrders', { symbol: symbol.toUpperCase(), ...context, limit: 100,
    autoCloseType: interval.toUpperCase() })];
  invariant(requests?.length === spec.weights.length && requests.every((r, i) =>
    readRequestWeight(r.method, r.pathname, r.params) === spec.weights[i]), 'READ_BINDING_CATALOG_MISMATCH');
  return Object.freeze(requests);
}
