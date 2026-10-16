// Read-only presentation projection: no credentials, client order IDs or trading actions.
const number = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
const text = v => typeof v === 'string' ? v.slice(0, 80) : null;
const rows = v => Array.isArray(v) ? v : null;
const decimal = v => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length <= 50 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
export function projectAccount(account, positions, orders, algoOrders) {
  const asset = rows(account?.assets)?.find(row => row.asset === 'USDT');
  const nonFlat = rows(positions)?.filter(row => number(row.positionAmt) !== null && number(row.positionAmt) !== 0);
  const order = (row, conditional) => ({ symbol: text(row.symbol), side: text(row.side), type: text(row.orderType ?? row.type), status: text(row.algoStatus ?? row.status), quantity: decimal(row.quantity ?? row.origQty), executedQuantity: decimal(row.executedQty), price: decimal(row.price), triggerPrice: decimal(row.triggerPrice ?? row.stopPrice), reduceOnly: row.reduceOnly === true, closePosition: row.closePosition === true, conditional });
  return {
    schemaVersion: 1, currency: 'USDT', unrealized: number(asset?.unrealizedProfit), initialMargin: number(asset?.initialMargin), maintenanceMargin: number(asset?.maintMargin), positionMargin: number(asset?.positionInitialMargin), orderMargin: number(asset?.openOrderInitialMargin),
    multiAssetsMargin: typeof account?.multiAssetsMargin === 'boolean' ? account.multiAssetsMargin : null,
    positionsComplete: !!nonFlat && nonFlat.length <= 100 && positions.every(row => number(row.positionAmt) !== null),
    ordersComplete: !!rows(orders) && orders.length <= 100, algoOrdersComplete: !!rows(algoOrders) && algoOrders.length <= 100,
    positionRows: (nonFlat ?? []).slice(0, 100).map(row => ({ symbol: text(row.symbol), side: ['LONG','SHORT'].includes(row.positionSide) ? row.positionSide : number(row.positionAmt) > 0 ? 'LONG' : 'SHORT', quantity: decimal(row.positionAmt), entryPrice: decimal(row.entryPrice), markPrice: decimal(row.markPrice), liquidationPrice: decimal(row.liquidationPrice), unrealized: number(row.unRealizedProfit), notional: number(row.notional), leverage: number(row.leverage), marginType: text(row.marginType) })),
    regularOrders: (rows(orders) ?? []).slice(0,100).map(row => order(row, false)), conditionalOrders: (rows(algoOrders) ?? []).slice(0,100).map(row => order(row, true))
  };
}
export function sanitizeAccountDetails(input) {
  if (input?.schemaVersion !== 1 || input.currency !== 'USDT') return null;
  const numericKeys = ['unrealized','initialMargin','maintenanceMargin','positionMargin','orderMargin'];
  const positionKeys = ['symbol','side','quantity','entryPrice','markPrice','liquidationPrice','marginType'];
  const orderKeys = ['symbol','side','type','status','quantity','executedQuantity','price','triggerPrice'];
  const cleanRows = (items, keys, numeric = []) => (rows(items) ?? []).slice(0,100).map(row => ({ ...Object.fromEntries(keys.map(k => [k,text(row[k])])), ...Object.fromEntries(numeric.map(k => [k,number(row[k])])) }));
  return { schemaVersion: 1, currency: 'USDT', ...Object.fromEntries(numericKeys.map(k => [k,number(input[k])])),
    multiAssetsMargin: typeof input.multiAssetsMargin === 'boolean' ? input.multiAssetsMargin : null,
    positionsComplete: input.positionsComplete === true && !!rows(input.positionRows) && input.positionRows.length <= 100,
    ordersComplete: input.ordersComplete === true && !!rows(input.regularOrders) && input.regularOrders.length <= 100,
    algoOrdersComplete: input.algoOrdersComplete === true && !!rows(input.conditionalOrders) && input.conditionalOrders.length <= 100,
    positionRows: cleanRows(input.positionRows, positionKeys, ['unrealized','notional','leverage']),
    regularOrders: cleanRows(input.regularOrders, orderKeys), conditionalOrders: cleanRows(input.conditionalOrders, orderKeys) };
}
export function equitySegments(points, maximumGapMs = 180000) {
  const groups = []; let previous = null;
  for (const point of points) {
    const time = Date.parse(point.observedAt);
    if (!Number.isFinite(time) || typeof point.equity !== 'number' || !Number.isFinite(point.equity)) continue;
    if (previous !== null && time <= previous) continue;
    if (previous === null || time - previous > maximumGapMs) groups.push([]);
    groups.at(-1).push({...point,time}); previous = time;
  }
  return groups;
}
