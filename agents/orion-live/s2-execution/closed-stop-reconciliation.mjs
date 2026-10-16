import { fresh, invariant } from './common.mjs';
import { hasDispatchProtocol } from './kernel.mjs';

// Recover only a CLOSED plan's old stop POST. An uncertain live protection or
// current position must keep the account-wide entry gate closed.
export async function reconcileClosedStopAbsence({ kernel, book, snapshot, read, accountActivityReady, now = Date.now() }) {
  if (accountActivityReady !== true || !fresh(snapshot?.observedAt, now, 5000)
    || snapshot.userStreamConnected !== true || snapshot.positionsComplete !== true
    || snapshot.ordersComplete !== true || snapshot.algosComplete !== true
    || snapshot.canTrade !== true || snapshot.dualSidePosition !== true
    || snapshot.multiAssetsMargin !== false) return null;
  const intent = [...kernel.intents.values()].find(row => row.kind === 'stop'
    && row.method === 'POST' && row.path === '/fapi/v1/algoOrder'
    && hasDispatchProtocol(row) && kernel.dispatchStarted.has(row.id)
    && row.result === null && now - row.at >= 300000 && now - row.at < 3 * 86400000
    && book.positions.get(row.planId)?.status === 'CLOSED'
    && Number(book.positions.get(row.planId)?.quantity) === 0);
  if (!intent) return null;
  const symbol = intent.params.symbol;
  invariant(intent.params.clientAlgoId === intent.id && intent.params.type === 'STOP_MARKET'
    && kernel.plans.get(intent.planId)?.symbol === symbol, 'CLOSED_STOP_INTENT_INVALID');
  if (snapshot.positions.some(row => row.symbol === symbol && Number(row.positionAmt) !== 0)
    || snapshot.orders.some(row => row.symbol === symbol)
    || snapshot.algos.some(row => row.symbol === symbol)
    || [...book.positions.values()].some(row => row.symbol === symbol && row.status === 'OPEN')) return null;
  let directAbsent = false;
  try { await read('GET', '/fapi/v1/algoOrder', { symbol, clientAlgoId: intent.id }); }
  catch (error) { if (error.exchangeCode === -2013) directAbsent = true; else throw error; }
  if (!directAbsent) return null;
  const endTime = now - 2000;
  const startTime = intent.at - 60000;
  invariant(endTime > startTime && endTime - startTime < 3 * 86400000, 'CLOSED_STOP_HISTORY_WINDOW');
  const rows = await read('GET', '/fapi/v1/allAlgoOrders', { symbol, startTime, endTime, limit: 1000 });
  invariant(Array.isArray(rows) && rows.length < 1000
    && rows.every(row => row.symbol === symbol && typeof row.clientAlgoId === 'string'),
  'CLOSED_STOP_HISTORY_INCOMPLETE');
  if (rows.some(row => row.clientAlgoId === intent.id)) return null;
  // This observation settles only the historical identity. The next entry
  // preflight still re-reads and reconciles the entire live account.
  await kernel.acceptObservation(intent.id, {
    symbol, clientAlgoId: intent.id, side: intent.params.side,
    positionSide: intent.params.positionSide, orderType: intent.params.type,
    triggerPrice: intent.params.triggerPrice, algoStatus: 'ABSENT_VERIFIED',
  });
  return intent.id;
}
