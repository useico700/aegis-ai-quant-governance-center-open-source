import { units, decimal } from '../../lib/s1-precision.mjs';
import { signedDecimal } from '../../agents/orion-live/s1-execution/position-ledger.mjs';

export class FakeS1Venue {
  constructor() { this.orders = new Map(); this.algos = new Map(); this.fills = []; this.calls = []; this.nextId = 100; this.quantity = 0n; this.price = '100'; this.direction = 'LONG'; this.now = 1789113600000; this.failAfterWrite = false; }
  snapshot() { return { positions: [{ symbol: 'SOLUSDT', positionSide: this.direction, positionAmt: (this.direction === 'SHORT' && this.quantity > 0n ? '-' : '') + decimal(this.quantity), notional: decimal(this.quantity * units(this.price) / units('1')) }], algos: [...this.algos.values()].filter(row => row.algoStatus === 'NEW'), orders: [] }; }
  async request(method, pathname, params) {
    this.calls.push({ method, pathname, params });
    if (pathname === '/fapi/v2/positionRisk') return this.snapshot().positions;
    if (pathname === '/fapi/v1/userTrades') return this.fills.filter(row => String(row.orderId) === String(params.orderId));
    if (pathname === '/fapi/v1/income') return [];
    const algo = pathname.endsWith('/algoOrder'), collection = algo ? this.algos : this.orders;
    if (method === 'GET') {
      const id = params.clientAlgoId ?? params.origClientOrderId;
      const row = id ? collection.get(id) : [...collection.values()].find(item => String(item.orderId) === String(params.orderId));
      if (!row) throw new Error('NOT_FOUND'); return structuredClone(row);
    }
    if (method === 'DELETE') { const row = collection.get(params.clientAlgoId ?? params.origClientOrderId); if (!row) throw new Error('NOT_FOUND'); row[algo ? 'algoStatus' : 'status'] = 'CANCELED'; return structuredClone(row); }
    if (algo) { const row = { ...params, algoStatus: 'NEW', algoId: this.nextId++, actualOrderId: 0 }; collection.set(params.clientAlgoId, row); return structuredClone(row); }
    const orderId = this.nextId++, quantity = units(params.quantity);
    this.direction = params.positionSide;
    const opening = params.side === (params.positionSide === 'LONG' ? 'BUY' : 'SELL');
    if (opening) { this.quantity += quantity; this.entry = this.price; }
    else { if (quantity > this.quantity) throw new Error('REDUCTION_EXCESS'); this.quantity -= quantity; }
    const quote = quantity * units(this.price) / units('1');
    const realized = opening ? 0n : BigInt(this.direction === 'LONG' ? 1 : -1) * quantity * (units(this.price) - units(this.entry)) / units('1');
    const fill = { id: this.nextId++, orderId, symbol: params.symbol, positionSide: params.positionSide, side: params.side, qty: params.quantity, price: this.price, commission: decimal(quote * units('0.0005') / units('1')), commissionAsset: 'USDT', realizedPnl: signedDecimal(realized), time: this.now++ };
    this.fills.push(fill);
    const row = { ...params, orderId, clientOrderId: params.newClientOrderId, origQty: params.quantity, executedQty: params.quantity, avgPrice: this.price, status: 'FILLED' }; collection.set(row.clientOrderId, row);
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new Error('TIMEOUT_AFTER_FILL'); }
    return structuredClone(row);
  }
}
