import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Journal } from '../agents/orion-live/s1-execution/journal.mjs';
import { ExecutionKernel } from '../agents/orion-live/s1-execution/kernel.mjs';
import { PositionLedger } from '../agents/orion-live/s1-execution/position-ledger.mjs';
import { PositionLifecycle, replacementEligible, positionConflictDecision } from '../agents/orion-live/s1-execution/lifecycle.mjs';
import { readOrderFills, readIncomeWindow } from '../agents/orion-live/s1-execution/history-reader.mjs';
import { hash, REVISION, clientId } from '../agents/orion-live/s1-execution/common.mjs';
import { FakeS1Venue } from './helpers/s1-fake-venue.mjs';
import { S1_PROFIT_RETENTION_POLICY } from '../agents/shared/profit-retention.mjs';
const now = 1789113600100;
const runtime = { paperRisk: { takerFeeRate: 0.0005, adverseSlippageRate: 0.0002 }, portfolioProfitProtection: {} };
test('management uses durable plan costs without a duplicate runtime fee configuration', () => {
  const lifecycle = new PositionLifecycle({ runtime: { paperRisk: {} } });
  assert.deepEqual(lifecycle.runtimeFor({ takerFeeRate: '0.0005', adverseSlippageRate: '0.0002' }), { paperRisk: { takerFeeRate: 0.0005, adverseSlippageRate: 0.0002 } });
  for (const bad of [undefined, null, '', ' ', 'NaN', '-0.01', '1', 0.001]) {
    assert.throws(() => lifecycle.runtimeFor({ takerFeeRate: bad, adverseSlippageRate: '0.0002' }), /PLAN_COST_RATES_REQUIRED/);
    assert.throws(() => lifecycle.runtimeFor({ takerFeeRate: '0.0005', adverseSlippageRate: bad }), /PLAN_COST_RATES_REQUIRED/);
  }
  assert.equal(lifecycle.runtimeFor({ takerFeeRate: '0', adverseSlippageRate: '0' }).paperRisk.takerFeeRate, 0);
});
const rule = { symbol: 'SOLUSDT', observedAt: new Date(now).toISOString(), venue: 'BINANCE_USDM_MAINNET', status: 'TRADING', price: { min: '0.01', max: '10000', step: '0.01' }, lot: { min: '0.01', max: '10000', step: '0.01' }, marketLot: { min: '0.01', max: '10000', step: '0.01' }, minNotional: '5', multiplierUp: '1.15', multiplierDown: '0.85', orderTypes: ['LIMIT', 'MARKET', 'STOP_MARKET'] };
function plan(direction = 'LONG') { const p = { schema: 'S1_VALIDATED_ENTRY_V1', id: 'lifecycle-synthetic', symbol: 'SOLUSDT', direction, revision: REVISION, price: '100', quantity: '10', stopPrice: direction === 'LONG' ? '90' : '110', plannedRiskUsdt: '102', budgetUsdt: '102', initialRiskPerUnit: '10.12', takerFeeRate: '0.0005', adverseSlippageRate: '0.0002', intersectionTime: now - 10000, validUntil: now + 1000 }; return { ...p, fingerprint: hash(p) }; }
async function fixture(t, direction = 'LONG') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's1-life-test-')); let journal = await new Journal(root).open(); const venue = new FakeS1Venue(); venue.direction = direction;
  t.after(async () => { await journal.close(); await fs.rm(root, { recursive: true }); });
  const construct = () => { const kernel = new ExecutionKernel({ journal, transport: venue, gates: async () => {}, now: () => now }); const book = new PositionLedger(journal); const lifecycle = new PositionLifecycle({ kernel, book, runtime, strategy: { pivots: { oneHour: { leftBars: 4, rightBars: 4 } } }, now: () => now }); return { kernel, book, lifecycle }; };
  return { venue, plan: plan(direction), ...construct(), async reopen() { await journal.close(); journal = await new Journal(root).open(); return construct(); } };
}
const q = (price, sequence = 1) => ({ symbol: 'SOLUSDT', bid: price, ask: price, marketTime: now, receivedAt: now, sequence, persisted: true, continuity: true });
async function sync(f) { const snapshot = f.venue.snapshot(); return f.lifecycle.sync(f.plan, {
  quantity: (Number(f.venue.quantity) / 1e18).toString(), algos: snapshot.algos,
}); }
test('entry actual fill accounting survives restart without new entry or duplicate fees', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  const before = f.book.positions.get(f.plan.id); assert.equal(before.quantity, '10'); assert.equal(before.exact.entryFeesUsdt, '0.5');
  f = { ...f, ...await f.reopen() }; await sync(f);
  assert.equal(f.book.positions.get(f.plan.id).exact.entryFeesUsdt, '0.5'); assert.equal(f.book.fills.size, 1); assert.equal(f.venue.calls.filter(row => row.method === 'POST' && row.params.type === 'LIMIT').length, 1);
});
test('R22 long lifecycle closes 40/25/20 and preserves 15 percent runner', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  for (const [price, remaining, flag] of [['106', '6', 'softLockTaken'], ['112', '3.5', 'firstPartialTaken'], ['122', '1.5', 'secondPartialTaken']]) {
    f.venue.price = price; await f.lifecycle.manage(f.plan, q(price), rule); await sync(f);
    const p = f.book.positions.get(f.plan.id); assert.equal(p.quantity, remaining); assert.equal(p[flag], true);
    await f.lifecycle.protect(f.plan, p, f.venue.snapshot(), rule, q(price), { bars1h: [], bars15m: [] });
  }
  assert.ok(Number(f.book.positions.get(f.plan.id).stop) > 90);
  assert.equal(f.book.positions.get(f.plan.id).managementPolicy, null);
});
for (const direction of ['LONG', 'SHORT']) test(`new S1 ${direction} plan realizes cumulative 60/80/85 and keeps 15 percent runner through restart`, async t => {
  let f = await fixture(t, direction);
  const base = { ...f.plan, managementPolicy: S1_PROFIT_RETENTION_POLICY }; delete base.fingerprint;
  f.plan = { ...base, fingerprint: hash(base) };
  await f.kernel.enter(f.plan); await sync(f);
  for (const [offset, remaining, flag] of [[6, '4', 'softLockTaken'], [12, '2', 'firstPartialTaken'], [22, '1.5', 'secondPartialTaken']]) {
    const price = String(100 + (direction === 'LONG' ? offset : -offset));
    f.venue.price = price; await f.lifecycle.manage(f.plan, q(price), rule); await sync(f);
    const position = f.book.positions.get(f.plan.id);
    assert.equal(position.quantity, remaining); assert.equal(position[flag], true);
    assert.equal(position.managementPolicy.revision, S1_PROFIT_RETENTION_POLICY.revision);
  }
  f = { ...f, ...await f.reopen() }; await sync(f);
  assert.equal(f.book.positions.get(f.plan.id).quantity, '1.5');
  assert.equal(f.book.fills.size, 4);
});
test('real S1 SOFT fill activates causal high-water harvest without consuming the tail or inventing fees', async t => {
  let f = await fixture(t);
  const base = { ...f.plan, managementPolicy: S1_PROFIT_RETENTION_POLICY }; delete base.fingerprint;
  f.plan = { ...base, fingerprint: hash(base) };
  await f.kernel.enter(f.plan); await sync(f);
  f.venue.price = '106'; await f.lifecycle.manage(f.plan, q('106'), rule); await sync(f);
  assert.equal(f.book.positions.get(f.plan.id).quantity, '4');
  await f.lifecycle.observeProfitRetention(f.plan, f.book.positions.get(f.plan.id), q('112'));
  const floor = f.book.positions.get(f.plan.id).profitRetention.floorR;
  f = { ...f, ...await f.reopen() };
  f.venue.price = '105'; const action = await f.lifecycle.manage(f.plan, q('105'), rule); await sync(f);
  assert.equal(action.status, 'FILLED');
  assert.equal(f.book.positions.get(f.plan.id).stage, 'PROFIT_RETENTION_HARVEST');
  assert.equal(f.book.positions.get(f.plan.id).quantity, '1.5');
  assert.equal(f.book.positions.get(f.plan.id).profitRetention.floorR, floor);
  assert.equal(f.book.fills.size, 3);
  await f.lifecycle.manage(f.plan, q('105'), rule); await sync(f);
  assert.equal(f.book.fills.size, 3);
});
test('short lifecycle uses BUY SHORT reduction, never flips LONG', async t => {
  const f = await fixture(t, 'SHORT'); await f.kernel.enter(f.plan); await sync(f); f.venue.price = '94'; await f.lifecycle.manage(f.plan, q('94'), rule); await sync(f);
  assert.equal(f.book.positions.get(f.plan.id).quantity, '6'); const close = f.venue.calls.find(row => row.method === 'POST' && row.params.type === 'MARKET'); assert.equal(close.params.side, 'BUY'); assert.equal(close.params.positionSide, 'SHORT');
});
test('crash after reduce fill before local commit recovers stage once', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan); await sync(f); f.venue.price = '106'; f.venue.failAfterWrite = true; await f.lifecycle.manage(f.plan, q('106'), rule);
  f = { ...f, ...await f.reopen() }; await sync(f); assert.equal(f.book.positions.get(f.plan.id).softLockTaken, true); assert.equal(f.book.positions.get(f.plan.id).quantity, '6');
  await f.lifecycle.resumeOperations(f.plan); assert.equal(f.venue.calls.filter(row => row.method === 'POST' && row.params.type === 'MARKET').length, 1);
});
test('durable planned reduction before POST resumes once after restart', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  await f.book.operation({ id: 'crash-before-post', planId: f.plan.id, quantity: '4', baseQuantity: '10', targetQuantity: '6', flag: 'softLockTaken', stage: 'SOFT', aggregateFloor: 0.15, observedQuoteSequence: 1, at: now });
  f = { ...f, ...await f.reopen() }; await f.lifecycle.resumeOperations(f.plan); await sync(f); await f.lifecycle.resumeOperations(f.plan); assert.equal(f.book.positions.get(f.plan.id).quantity, '6'); assert.equal(f.venue.calls.filter(row => row.method === 'POST' && row.params.type === 'MARKET').length, 1);
});
test('sync defers a marker-v1 close whose final gate rejected before dispatch', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  const operation = { id: 'gate-rejected-before-dispatch', planId: f.plan.id, quantity: '4', baseQuantity: '10', targetQuantity: '6', flag: 'softLockTaken', stage: 'SOFT', aggregateFloor: 0.15, observedQuoteSequence: 1, at: now };
  await f.book.operation(operation);
  const identity = `${f.plan.id}:${operation.id}`, id = clientId('close', identity);
  await f.book.journal.append({ type: 'INTENT', id, kind: 'close', planId: f.plan.id, method: 'POST', path: '/fapi/v1/order', params: {
    symbol: f.plan.symbol, positionSide: f.plan.direction, side: 'SELL', type: 'MARKET', quantity: '4', newOrderRespType: 'RESULT', newClientOrderId: id }, purpose: 'STANDARD', dispatchProtocol: 'MARKER_V1', at: now });
  f = { ...f, ...await f.reopen() };
  await sync(f);
  assert.equal(f.venue.calls.filter(row => row.method === 'POST' && row.params.type === 'MARKET').length, 0);
  await f.lifecycle.resumeOperations(f.plan);
  assert.equal(f.venue.calls.filter(row => row.method === 'POST' && row.params.type === 'MARKET').length, 1);
});
test('account snapshot adopts a tightening stop hidden from its immediate query without quarantining', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  const oldStop = [...f.kernel.intents.values()].find(row => row.kind === 'stop'), identity = `${f.plan.id}:snapshot-adoption`;
  const id = clientId('stop', identity), params = { symbol: f.plan.symbol, side: 'SELL', positionSide: 'LONG', algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice: '95', closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: id };
  await f.book.journal.append({ type: 'INTENT', id, kind: 'stop', planId: f.plan.id, method: 'POST', path: '/fapi/v1/algoOrder', params, purpose: 'STANDARD', dispatchProtocol: 'MARKER_V1', at: now });
  await f.book.journal.append({ type: 'DISPATCH_STARTED', id, at: now });
  f.venue.algos.set(id, { ...params, algoStatus: 'NEW', algoId: 999, actualOrderId: '' });
  f = { ...f, ...await f.reopen() };
  const direct = f.venue.request.bind(f.venue);
  f.venue.request = async (method, pathname, request) => {
    if (method === 'GET' && pathname === '/fapi/v1/algoOrder' && request.clientAlgoId === id) throw new Error('NOT_VISIBLE_YET');
    return direct(method, pathname, request);
  };
  assert.notEqual(id, oldStop.id);
  await sync(f);
  assert.equal(f.kernel.intents.get(id).result.algoStatus, 'NEW');
  await f.lifecycle.protect(f.plan, f.book.positions.get(f.plan.id), f.venue.snapshot(), rule, q('100'), { bars1h: [], bars15m: [] });
  assert.equal(f.kernel.intents.get(id).result.algoStatus, 'NEW');
  assert.equal(f.book.positions.get(f.plan.id).stopClientId, id);
  assert.equal(f.book.positions.get(f.plan.id).stop, '95');
  assert.equal(f.venue.algos.get(oldStop.id).algoStatus, 'NEW');
});
test('active primary stop in the complete account snapshot survives a transient direct-query miss', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  const direct = f.venue.request.bind(f.venue), stop = [...f.kernel.intents.values()].find(row => row.kind === 'stop');
  f.venue.request = async (method, pathname, request) => {
    if (method === 'GET' && pathname === '/fapi/v1/algoOrder' && request.clientAlgoId === stop.id) throw new Error('NOT_VISIBLE_BY_CLIENT_ID');
    return direct(method, pathname, request);
  };
  const result = await sync(f);
  assert.equal(result.status, 'OPEN');
  await f.lifecycle.protect(f.plan, f.book.positions.get(f.plan.id), f.venue.snapshot(), rule, q('100'), { bars1h: [], bars15m: [] });
  assert.equal(f.book.positions.get(f.plan.id).stopClientId, stop.id);
});
test('flat account defers an unresolved stop-child lookup without quarantining ownership', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f);
  const stop = [...f.kernel.intents.values()].find(row => row.kind === 'stop');
  f.venue.quantity = 0n; f.venue.algos.clear();
  const direct = f.venue.request.bind(f.venue);
  f.venue.request = async (method, pathname, request) => {
    if (method === 'GET' && pathname === '/fapi/v1/algoOrder' && request.clientAlgoId === stop.id) throw new Error('NOT_VISIBLE_YET');
    return direct(method, pathname, request);
  };
  await assert.rejects(sync(f), /PROTECTIVE_ALGO_STATUS_DEFERRED/);
  assert.equal(f.book.positions.get(f.plan.id).status, 'OPEN');
});
test('stop first closes, then cancels only owned leftover stops after flat verification', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f); f.venue.price = '89'; await f.lifecycle.manage(f.plan, q('89'), rule); await sync(f);
  assert.equal(f.book.positions.get(f.plan.id).status, 'CLOSED'); await f.lifecycle.cleanupFlat(f.plan, f.venue.snapshot()); assert.equal(f.venue.snapshot().algos.length, 0);
});
test('unexpected venue quantity blocks reconstruction instead of overwriting ownership', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f); await assert.rejects(f.lifecycle.sync(f.plan, { quantity: '9' }), /QUANTITY_MISMATCH/);
});
test('late funding is deduplicated and boundary ambiguity remains explicit', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f); const row = { symbol: 'SOLUSDT', incomeType: 'FUNDING_FEE', tranId: 5, asset: 'USDT', income: '-0.01', time: now };
  await f.book.recordIncome(row); await f.book.recordIncome(row); assert.equal(f.book.income.size, 1); assert.equal(f.book.rebuild(f.plan).fundingNetUsdt, '-0.01');
  await f.book.recordIncome({ ...row, tranId: 6, time: f.book.positions.get(f.plan.id).openedAt }); assert.equal(f.book.rebuild(f.plan).fundingAttributionComplete, false);
});
test('changed historical trade and non-USDT fees cannot silently change accounting', async t => {
  const f = await fixture(t); await f.kernel.enter(f.plan); await sync(f); const order = f.kernel.intents.get(clientId('entry', f.plan.id)).result;
  await assert.rejects(f.book.recordOrderFills(f.plan, order, [{ ...f.venue.fills[0], commission: '1' }], 'ENTRY'), /HISTORICAL_FILL_CHANGED/);
  await assert.rejects(f.book.recordOrderFills(f.plan, order, [{ ...f.venue.fills[0], commissionAsset: 'BNB' }], 'ENTRY'), /NON_USDT/);
});
test('R15 replacement requires newer active current structure and opposite direction', () => {
  const p = { symbol: 'SOLUSDT', direction: 1, intersectionTime: 100, openedAt: 200 }, signal = { symbol: 'SOLUSDT', direction: 'SHORT', fourHourLineStatus: 'ACTIVE_4H_TREND', intersectionTime: 300, closedAt: 400 };
  assert.equal(replacementEligible(signal, p), true);
  for (const change of [{ direction: 'LONG' }, { fourHourLineStatus: 'PREVIOUS' }, { intersectionTime: 100 }, { closedAt: 200 }, { symbol: 'BTCUSDT' }]) assert.equal(replacementEligible({ ...signal, ...change }, p), false);
  for (const missing of [null, undefined, '100', NaN]) assert.equal(replacementEligible(signal, { ...p, intersectionTime: missing }), false);
  assert.equal(replacementEligible({ ...signal, direction: 'UNKNOWN' }, p), false);
});
test('same-symbol candidate waits; opposite candidate replaces only with executable net floating profit', () => {
  const position = { symbol: 'SOLUSDT', direction: 1, intersectionTime: 100, openedAt: 200,
    entry: 100, quantity: '10', originalQuantity: '10', entryFee: 0.5 };
  const signal = { symbol: 'SOLUSDT', direction: 'SHORT', fourHourLineStatus: 'ACTIVE_4H_TREND', intersectionTime: 300, closedAt: 400 };
  const costs = { takerFeeRate: '0.0005', adverseSlippageRate: '0.0002' };
  assert.equal(positionConflictDecision({ ...signal, direction: 'LONG' }, position, { bid: '102', ask: '102.01' }, costs).reason,
    'SAME_DIRECTION_POSITION_EXISTS');
  assert.equal(positionConflictDecision(signal, position, { bid: '100.01', ask: '100.02' }, costs).action, 'HOLD_POSITION');
  const profitable = positionConflictDecision(signal, position, { bid: '101', ask: '101.01' }, costs);
  assert.equal(profitable.action, 'REPLACE_POSITION');
  assert.ok(profitable.executableNetFloatingProfitUsdt > 0);
});
test('final runner blocks a newer opposite entry even while executable net floating profit is positive', () => {
  const position = { symbol: 'SOLUSDT', direction: 1, intersectionTime: 100, openedAt: 200,
    entry: 100, quantity: '1.5', originalQuantity: '10', entryFee: 0.5, secondPartialTaken: true };
  const signal = { symbol: 'SOLUSDT', direction: 'SHORT', fourHourLineStatus: 'ACTIVE_4H_TREND', intersectionTime: 300, closedAt: 400 };
  const decision = positionConflictDecision(signal, position, { bid: '110', ask: '110.01' },
    { takerFeeRate: '0.0005', adverseSlippageRate: '0.0002' });
  assert.deepEqual(decision, { action: 'HOLD_POSITION', reason: 'RUNNER_POSITION_BLOCKS_OPPOSITE_ENTRY' });
});
test('history readers reject incomplete trade results and unbounded income windows', async () => {
  await assert.rejects(readOrderFills({ request: async () => [] }, { symbol: 'SOLUSDT', orderId: 1, executedQty: '1' }), /INCOMPLETE/);
  await assert.rejects(readIncomeWindow({ request: async () => [] }, now, now + 8 * 86400000), /WINDOW_INVALID/);
});

test('legacy rounded filled order is re-queried by client ID before fill accounting without new orders', async t => {
  let f = await fixture(t); await f.kernel.enter(f.plan);
  const oldEntry = f.kernel.intents.get(clientId('entry', f.plan.id));
  const exactId = '8389766280679209901';
  // Replay the actual failure shape from an old journal, without rewriting it.
  await f.book.journal.append({ type: 'OBSERVED', id: oldEntry.id, at: now,
    result: { ...oldEntry.result, orderId: Number(exactId) } });
  f = { ...f, ...await f.reopen() };
  const entry = f.kernel.intents.get(oldEntry.id);
  const request = f.venue.request.bind(f.venue); let queriedByClient = false;
  f.venue.request = async (method, pathname, params) => {
    if (method !== 'GET') throw new Error('RECOVERY_MUST_NOT_SUBMIT');
    if (pathname === '/fapi/v1/order') { assert.equal(params.origClientOrderId,entry.id);queriedByClient=true;return {...await request(method,pathname,params),orderId:exactId}; }
    if (pathname === '/fapi/v1/userTrades') { assert.equal(params.orderId,exactId);return [{symbol:'SOLUSDT',id:'9007199254740993',orderId:exactId,positionSide:'LONG',side:'BUY',qty:'10',price:'100',commission:'0.5',commissionAsset:'USDT',realizedPnl:'0',time:now}]; }
    return request(method,pathname,params);
  };
  await sync(f);assert.equal(queriedByClient,true);assert.equal(f.book.positions.get(f.plan.id).quantity,'10');assert.equal(entry.result.orderId,exactId);
  assert.equal([...f.book.fills.values()][0].fill.orderId,exactId);
});
