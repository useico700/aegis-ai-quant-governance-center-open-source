import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SQLiteJournal } from '../agents/orion-live/s1-execution/sqlite-journal.mjs';
import { PositionLedger } from '../agents/orion-live/s1-execution/position-ledger.mjs';
import { S1ExecutionEngine } from '../agents/orion-live/s1-execution/engine.mjs';
import { createExecutionRuntime as createS2ExecutionRuntime } from '../agents/orion-live/s2-execution/execution-runtime.mjs';
import { createExecutionRuntime } from '../agents/orion-live/s1-execution/execution-runtime.mjs';
import { REVISION, clientId } from '../agents/orion-live/s1-execution/common.mjs';
import { FakeS1Venue } from './helpers/s1-fake-venue.mjs';
import { EntryEvidenceArchive as S2EntryEvidenceArchive } from '../agents/orion-live/s2-execution/entry-evidence.mjs';
import { EntryEvidenceArchive } from '../agents/orion-live/s1-execution/entry-evidence.mjs';
import { SegmentedEvidenceStore } from '../agents/orion-live/s1-execution/segmented-evidence.mjs';

const profile = JSON.parse(await fs.readFile(new URL('../agents/orion-live/s1-scanner/r22-risk-profile.json', import.meta.url)));
const s2Profile = JSON.parse(await fs.readFile(new URL('../agents/orion-live/s2-scanner/r22-risk-profile.json', import.meta.url)));
async function fixture(t, mode = 'OBSERVE', account = 'S1') {
  let now = 1789113600100;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's1-engine-'));
  const journal = await new SQLiteJournal(root).open();
  const store = await new SegmentedEvidenceStore(path.join(root, 'raw'), { assertWriter: () => !!journal.db, now: () => now, statfs: async () => ({ blocks: 10000000, bavail: 9000000, bsize: 4096 }) }).open();
  const evidenceArchive = new (account === 'S2' ? S2EntryEvidenceArchive : EntryEvidenceArchive)({ store, now: () => now });
  t.after(async () => { await store.close(); await journal.close(); await fs.rm(root, { recursive: true }); });
  const venue = new FakeS1Venue(); venue.price = '150';
  const trialLimits = { schemaVersion: 1, accountLabel: account, strategyRevision: REVISION, mode: 'SMALL_TRIAL', status: 'OWNER_AMOUNTS_RECORDED', maximumGrossNotionalUsdt: '20', maximumPlannedLossPerTradeUsdt: '0.5', maximumOpenPositions: 1, grossNotionalMustNotExceedEquity: true, minimumNotionalUpsizingAllowed: false, negativeExposureOffsetsAllowed: false, pendingEntryExposureReserved: true };
  const signal = { id: 'engine-signal', symbol: 'SOLUSDT', revision: REVISION, direction: 'LONG', intersectionTime: now - 100000, fourHourLineStatus: 'ACTIVE_4H_TREND', closedAt: now - 100, firstBarOpenTime: now - 900000, discoveredAt: now - 900001, close: '150', stopPrice: '145' };
  const rule = { symbol: 'SOLUSDT', observedAt: new Date(now).toISOString(), venue: 'BINANCE_USDM_MAINNET', status: 'TRADING', price: { min: '0.01', max: '10000', step: '0.01' }, lot: { min: '0.01', max: '10000', step: '0.01' }, marketLot: { min: '0.01', max: '10000', step: '0.01' }, minNotional: '5', multiplierUp: '1.15', multiplierDown: '0.85', orderTypes: ['LIMIT', 'MARKET', 'STOP_MARKET'] };
  const controls = { stale: false, connected: true, signals: [signal], candidateEvaluations: [], foreign: false,
    bboPersisted: true, bboContinuity: true, rulesReady: true };
  const provider = async () => {
    const snapshot = venue.snapshot(), evidence = { symbol: 'SOLUSDT', marketTime: now, receivedAt: now, connectedAt: now - 1000, continuity: true, epoch: 1, sequence: now, updateId: String(now) };
    const bbo = { ...evidence, type: 'BBO', bid: venue.price, ask: venue.price }, tick = { ...evidence, type: 'TICK', price: venue.price };
    const persistence = await store.append([bbo, tick]);
    if (controls.foreign) snapshot.orders.push({ symbol: 'SOLUSDT', clientOrderId: 'manual' });
    return { account: { ...snapshot, observedAt: controls.stale ? now - 6000 : now, equityUsdt: '100', availableBalanceUsdt: '100', canTrade: true, dualSidePosition: true, multiAssetsMargin: false, userStreamConnected: controls.connected, userStreamSequenceStable: true, positionsComplete: true, ordersComplete: true, algosComplete: true },
      signals: controls.signals, candidateEvaluations: controls.candidateEvaluations, market: { SOLUSDT: { bbo: { ...bbo, persisted: controls.bboPersisted, continuity: controls.bboContinuity, persistence }, tick: { ...tick, persisted: true, persistence }, markPrice: venue.price, markObservedAt: now } }, rules: controls.rulesReady ? { SOLUSDT: rule } : {}, eventGate: { allowed: true, checkedAt: now, validUntil: now + 1000 },
      fees: { SOLUSDT: { takerFeeRate: '0.0005', observedAt: now } }, leverage: { SOLUSDT: 1 }, bars: { SOLUSDT: { bars1h: [], bars15m: [] } }, diskReady: true, singleWriter: true };
  };
  controls.authorized = true;
  const { book, kernel, lifecycle, engine } = (account === 'S2' ? createS2ExecutionRuntime : createExecutionRuntime)({ journal, readPort: venue, orderPort: venue,
    runtime: { paperRisk: { takerFeeRate: 0.0005, adverseSlippageRate: 0.0002 } }, strategy: { pivots: { oneHour: { leftBars: 4, rightBars: 4 } } },
    riskProfile: account === 'S2' ? s2Profile : profile, trialLimits, mode, frameProvider: provider, evidenceArchive,
    authorizeOperation: async () => controls.authorized, now: () => now });
  return { engine, kernel, lifecycle, book, venue, provider, signal, controls, store, evidenceArchive, step: () => { now += 100; venue.now = now - 1; return now; } };
}
test('OBSERVE runs full preflight without reserving intents or calling venue', async t => {
  const f = await fixture(t), result = await f.engine.cycle();
  assert.equal(result.status, 'OBSERVE_ONLY_NO_ORDER_CALLS'); assert.ok(result.decisions[0].plan, result.decisions[0].reason);
  assert.equal(f.kernel.intents.size, 0); assert.equal(f.venue.calls.length, 0);
});
test('assembled runtime refuses a synthetic order when operation authorization is closed', async t => {
  const f = await fixture(t, 'LIVE'); f.controls.authorized = false;
  await f.engine.cycle();
  assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
  assert.equal(f.kernel.intents.size, 1);
});
test('incomplete account-activity coverage blocks synthetic entry before reservation', async t => {
  const f = await fixture(t, 'LIVE'); f.engine.accountActivityGate = false;
  assert.equal((await f.engine.cycle()).status, 'NO_ELIGIBLE_ENTRY'); assert.equal(f.kernel.plans.size, 0);
  assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
});
test('terminal scanner filters and execution-gate rejections are exposed without changing orders', async t => {
  const f = await fixture(t, 'LIVE');
  f.controls.candidateEvaluations = [{ id: 'expired-plan', symbol: 'BTCUSDT', direction: null,
    intersectionTime: 1789113500000, intersectionPrice: 150, stage: 'SIGNAL_CONFIRMATION',
    reason: 'CONFIRMATION_RESERVE_EXPIRED', terminal: true, evaluatedAt: 1789113600100 }];
  f.engine.accountActivityGate = false;
  await f.engine.cycle();
  assert.deepEqual(f.engine.lastEvaluations.map(row => row.reason), ['CONFIRMATION_RESERVE_EXPIRED']);
  assert.deepEqual(f.engine.lastEntryBlockers.map(row => [row.reason, row.classification, row.terminal]), [['INFRASTRUCTURE_GATE_CLOSED', 'RETRYABLE', false]]);
  assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
});
test('terminal candidate outcomes survive later empty cycles until the publisher can sample them', async t => {
  const f = await fixture(t, 'LIVE');
  f.controls.signals = [];
  f.controls.candidateEvaluations = [{ id: 'superseded-plan', symbol: 'BTCUSDT', direction: null,
    intersectionTime: 1789113500000, intersectionPrice: 150, stage: 'CANDIDATE_LIFECYCLE',
    reason: 'CANDIDATE_SUPERSEDED', terminal: true, evaluatedAt: 1789113600100 }];
  await f.engine.cycle();
  f.controls.candidateEvaluations = []; f.step(); await f.engine.cycle();
  assert.deepEqual(f.engine.lastEvaluations.map(row => row.reason), ['CANDIDATE_SUPERSEDED']);
});
test('activity gate changing during evidence persistence blocks the synthetic entry', async t => {
  const f = await fixture(t, 'LIVE'), pin = f.evidenceArchive.pinEntry.bind(f.evidenceArchive);
  f.evidenceArchive.pinEntry = async args => { const result = await pin(args); f.engine.accountActivityGate = false; return result; };
  await f.engine.cycle(); assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
});
test('synthetic full cycle passes post-fsync gate, protects and accounts once', async t => {
  const f = await fixture(t, 'LIVE'), entry = await f.engine.cycle();
  assert.equal(entry.status, 'ENTRY_CYCLE', JSON.stringify(entry)); assert.equal(entry.result.status, 'PROTECTED_FILL_AWAITING_ACCOUNTING');
  f.step(); await f.engine.cycle();
  const p = f.book.positions.get(f.signal.id); assert.equal(p.status, 'OPEN'); assert.equal(p.quantity, '0.09');
  f.step(); await f.engine.cycle(); assert.equal(f.venue.calls.filter(c => c.method === 'POST' && c.params.type === 'LIMIT').length, 1);
});
test('confirmed entry installs its initial stop even when background reads have no local budget', async t => {
  const f = await fixture(t, 'LIVE'), provider = f.engine.frameProvider; let forcedReads = 0;
  f.engine.frameProvider = options => {
    if (options?.forceAccountRefresh && ++forcedReads > 1) throw new Error('READ_BUDGET_LOCAL_WEIGHT');
    return provider(options);
  };
  const entry = await f.engine.cycle();
  assert.equal(entry.status, 'ENTRY_CYCLE', JSON.stringify(entry));
  assert.equal(entry.result.status, 'PROTECTED_FILL_AWAITING_ACCOUNTING');
  assert.equal(f.venue.calls.filter(call => call.method === 'POST' && call.pathname === '/fapi/v1/algoOrder').length, 1);
  assert.equal(f.book.control.has(`positionQuarantine:${f.signal.id}`), false);
  assert.equal(f.engine.incident, null);
});
test('timely BBO awaiting persistence or continuity defers management without quarantining an owned position', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  f.controls.signals = []; f.controls.bboPersisted = false; f.controls.bboContinuity = false; f.step();
  const result = await f.engine.cycle();
  assert.equal(result.status, 'NO_ELIGIBLE_ENTRY');
  assert.equal(f.engine.incident, null);
  assert.equal(f.book.control.has(`positionQuarantine:${f.signal.id}`), false);
  assert.equal(f.venue.quantity, 90000000000000000n);
});
test('startup rule-cache warmup defers management without quarantining an owned position', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  f.controls.signals = []; f.controls.rulesReady = false; f.step();
  const result = await f.engine.cycle();
  assert.equal(result.status, 'NO_ELIGIBLE_ENTRY');
  assert.equal(f.engine.incident, null);
  assert.equal(f.book.control.has(`positionQuarantine:${f.signal.id}`), false);
  assert.equal(f.venue.quantity, 90000000000000000n);
});
test('foreign orders remain blocked during post-fsync reservation checks', async t => {
  const f = await fixture(t, 'LIVE'); f.controls.foreign = true; const result = await f.engine.cycle();
  assert.equal(result.status, 'NO_ELIGIBLE_ENTRY'); assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
});
test('temporary stale account gate clears on a fresh read rather than sticking forever', async t => {
  const f = await fixture(t, 'LIVE'); f.controls.stale = true; assert.equal((await f.engine.cycle()).error, 'ACCOUNT_SNAPSHOT_STALE');
  f.controls.stale = false; f.step(); assert.equal((await f.engine.cycle()).status, 'ENTRY_CYCLE'); assert.equal(f.engine.incident, null);
});
test('hard incident is durable and does not prevent protective exit operations', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  await f.engine.hold('POSITION_QUANTITY_MISMATCH'); assert.equal(f.book.control.get('entryIncident'), 'POSITION_QUANTITY_MISMATCH');
  f.venue.price = '144'; f.controls.signals = []; f.step(); await f.engine.cycle();
  assert.equal(f.venue.quantity, 0n); assert.equal(f.engine.incident, 'POSITION_QUANTITY_MISMATCH');
});
test('observed entry can never be exempted from reconciliation', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle();
  assert.throws(() => f.engine.frameFor(f.signal, {}, { ignoreUnsentEntryId: clientId('entry', f.signal.id) }), /CANNOT_IGNORE/);
});
test('entry evidence is byte-verified and durably pinned before a synthetic order call', async t => {
  const f = await fixture(t, 'LIVE'), request = f.venue.request.bind(f.venue);
  f.venue.request = async (method, pathname, params) => {
    if (method === 'POST' && params.type === 'LIMIT') {
      const proof = f.book.control.get(`entryEvidence:${f.signal.id}`);
      assert.equal(proof.schema, 'S1_PINNED_ENTRY_EVIDENCE_V1'); assert.ok(proof.receipts.every(row => row.verified && row.pinned));
      assert.ok(f.store.status().pinnedBytes > 0);
    }
    return request(method, pathname, params);
  };
  assert.equal((await f.engine.cycle()).status, 'ENTRY_CYCLE');
});
test('missing archive or failed evidence pin prevents entry without touching venue', async t => {
  const f = await fixture(t, 'LIVE'); f.engine.evidenceArchive = null;
  assert.equal((await f.engine.cycle()).error, 'ENTRY_EVIDENCE_ARCHIVE_REQUIRED'); assert.equal(f.venue.calls.length, 0);
  f.engine.evidenceArchive = { pinEntry: async () => { throw new Error('RAW_PINNED_CAP_BLOCKS_WRITE'); } };
  assert.equal((await f.engine.cycle()).error, 'RAW_PINNED_CAP_BLOCKS_WRITE'); assert.equal(f.venue.calls.length, 0);
});
test('R15 synthetic replacement closes old, reconciles flat, then opens opposite using a fresh BBO', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  f.venue.price = '151';
  const now = f.step();
  f.controls.signals = [{ ...f.signal, id: 'replacement-signal', direction: 'SHORT', close: '151', stopPrice: '155', intersectionTime: now - 50, closedAt: now - 1 }];
  const replacement = await f.engine.cycle();
  assert.equal(replacement.status, 'R15_CLOSE_OLD_FIRST', JSON.stringify({ replacement, decision: f.engine.lastDecision,
    evaluations: f.engine.lastEvaluations, position: f.book.positions.get(f.signal.id), plan: f.kernel.plans.get(f.signal.id) })); assert.equal(f.venue.quantity, 0n);
  assert.equal(f.venue.calls.filter(c => c.method === 'POST' && c.params.type === 'LIMIT').length, 1);
  f.step(); assert.equal((await f.engine.cycle()).status, 'R15_WAITING_RECONCILED_FLAT');
  f.step(); const opened = await f.engine.cycle(); assert.equal(opened.status, 'ENTRY_CYCLE', JSON.stringify(opened));
  f.step(); await f.engine.cycle();
  assert.equal(f.book.positions.get(f.signal.id).status, 'CLOSED'); assert.equal(f.book.positions.get('replacement-signal').direction, -1);
  const operations = f.venue.calls.filter(c => c.method === 'POST' && c.pathname === '/fapi/v1/order').map(c => [c.params.type, c.params.side, c.params.positionSide]);
  assert.deepEqual(operations, [['LIMIT', 'BUY', 'LONG'], ['MARKET', 'SELL', 'LONG'], ['LIMIT', 'SELL', 'SHORT']]);
});
test('a profitable final runner retains a newer opposite candidate without closing or opening', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  const position = f.book.positions.get(f.signal.id);
  position.secondPartialTaken = true;
  f.venue.price = '151';
  const now = f.step();
  f.controls.signals = [{ ...f.signal, id: 'runner-opposite-signal', direction: 'SHORT', close: '151', stopPrice: '155', intersectionTime: now - 50, closedAt: now - 1 }];
  const result = await f.engine.cycle();
  assert.equal(result.status, 'NO_ELIGIBLE_ENTRY');
  assert.equal(f.engine.lastDecision.status, 'CANDIDATE_RETAINED_WHILE_POSITION_OPEN');
  assert.equal(f.engine.lastDecision.reason, 'RUNNER_POSITION_BLOCKS_OPPOSITE_ENTRY');
  assert.equal(f.book.positions.get(f.signal.id).status, 'OPEN');
  assert.equal(f.kernel.plans.has('runner-opposite-signal'), false);
  const writes = f.venue.calls.filter(c => c.method === 'POST' && c.pathname === '/fapi/v1/order')
    .map(c => [c.params.type, c.params.side, c.params.positionSide]);
  assert.deepEqual(writes, [['LIMIT', 'BUY', 'LONG']]);
});
test('R21 entry freeze applies only to its eligible symbols and matching direction', async t => {
  const f = await fixture(t, 'LIVE');
  await f.book.setControl('r21Campaign', { state: { campaigns: { LONG: { freezeUntil: 1789113700000 } } }, actions: [] });
  assert.equal((await f.engine.cycle()).status, 'NO_ELIGIBLE_ENTRY'); assert.equal(f.engine.lastDecision.reason, 'R21_DIRECTION_ENTRY_FROZEN');
  const frame = await f.provider();
  assert.equal(f.engine.frameFor({ ...f.signal, direction: 'SHORT' }, frame).portfolioEntryAllowed, true);
  assert.equal(f.engine.frameFor({ ...f.signal, symbol: 'BTCUSDT' }, frame).portfolioEntryAllowed, true);
  assert.equal(f.venue.calls.length, 0);
});
test('R21 durable queued actions remain routable after the position count drops below three', async t => {
  const f = await fixture(t, 'LIVE'); f.controls.signals = [];
  await f.book.setControl('r21Campaign', { state: {}, actions: [{ id: 'queued-action' }] });
  f.book.positions.set('owned-one', { id: 'owned-one', symbol: 'SOLUSDT', status: 'OPEN' });
  f.book.positions.set('owned-two', { id: 'owned-two', symbol: 'XRPUSDT', status: 'OPEN' });
  f.lifecycle.resumeOperations = async () => ({ status: 'NO_PENDING_REDUCTION' });
  f.lifecycle.manage = async () => ({ type: 'HOLD' });
  let dispatched = 0; f.lifecycle.portfolio = async () => { dispatched++; };
  await f.engine.cycle(); assert.equal(dispatched, 1); assert.equal(f.venue.calls.length, 0);
});
test('shutdown entry suspension during evidence commit prevents a synthetic entry', async t => {
  const f = await fixture(t, 'LIVE'), pin = f.evidenceArchive.pinEntry.bind(f.evidenceArchive);
  f.evidenceArchive.pinEntry = async args => { const proof = await pin(args); f.engine.pauseEntries('RESIDENT_SHUTDOWN'); return proof; };
  const result = await f.engine.cycle();
  assert.equal(result.error, 'ENTRY_SUSPENDED_DURING_COMMIT'); assert.equal(f.venue.calls.length, 0);
});
test('shutdown entry suspension does not disable already-owned protective exits', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  f.engine.pauseEntries('RESIDENT_SHUTDOWN'); f.venue.price = '144'; f.controls.signals = []; f.step();
  await f.engine.cycle(); assert.equal(f.venue.quantity, 0n);
});

function independentLegs(f) {
  f.controls.signals = [];
  const calls = [];
  for (const [id, symbol] of [['first', 'SOLUSDT'], ['second', 'XRPUSDT']]) {
    f.kernel.plans.set(id, { id, symbol, direction: 'LONG' });
    f.book.positions.set(id, { id, symbol, direction: 1, status: 'OPEN', quantity: '1' });
  }
  f.lifecycle.sync = async plan => { calls.push(['sync', plan.id]); return { status: 'OPEN' }; };
  f.lifecycle.protect = async plan => { calls.push(['protect', plan.id]); return { status: 'PROTECTION_VERIFIED' }; };
  f.lifecycle.resumeOperations = async plan => { calls.push(['resume', plan.id]); return { status: 'NO_PENDING_REDUCTION' }; };
  f.lifecycle.manage = async plan => { calls.push(['manage', plan.id]); return { type: 'HOLD' }; };
  f.lifecycle.portfolio = async () => { calls.push(['portfolio']); };
  return calls;
}
test('one reconciliation failure quarantines that leg but still protects other legs', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f), sync = f.lifecycle.sync;
  f.lifecycle.sync = async plan => { if (plan.id === 'first') throw new Error('VENUE_AND_FILL_QUANTITY_MISMATCH'); return sync(plan); };
  await f.book.setControl('r21Campaign', { state: {}, actions: [{ id: 'pending' }] });
  const result = await f.engine.cycle();
  assert.equal(result.status, 'ENTRY_BLOCKED_INCIDENT');
  assert.deepEqual(calls, [['sync', 'second'], ['protect', 'second'], ['resume', 'second']]);
  assert.equal(f.book.control.get('positionQuarantine:first').phase, 'RECONCILIATION');
  assert.equal(f.book.control.get('entryIncident'), 'VENUE_AND_FILL_QUANTITY_MISMATCH');
  const sequence = f.book.journal.events.length;
  f.step(); await f.engine.cycle();
  assert.equal(f.book.journal.events.length, sequence, 'repeated quarantine must not grow the journal');
});
test('temporary read scheduling pressure retries without creating a durable position quarantine', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f), sync = f.lifecycle.sync;
  f.lifecycle.sync = async plan => {
    if (plan.id === 'first') throw new Error('READ_BUDGET_LOCAL_WEIGHT');
    return sync(plan);
  };
  const result = await f.engine.cycle();
  assert.equal(result.status, 'NO_ELIGIBLE_ENTRY');
  assert.equal(f.book.control.has('positionQuarantine:first'), false);
  assert.equal(f.book.control.has('entryIncident'), false);
  assert.equal(f.engine.incident, null);
  assert.ok(calls.some(([kind, id]) => kind === 'sync' && id === 'second'));
});
for (const reason of ['ACCOUNT_CHANGED_DURING_SUBMISSION_READ', 'SUBMISSION_REUSED_PRE_GATE_SNAPSHOT', 'SUBMISSION_ACCOUNT_STALE']) {
  test(`${reason} retries a fresh pre-submit snapshot without durable quarantine`, async t => {
    const f = await fixture(t, 'LIVE'), calls = independentLegs(f), sync = f.lifecycle.sync;
    f.lifecycle.sync = async plan => {
      if (plan.id === 'first') throw new Error(reason);
      return sync(plan);
    };
    const result = await f.engine.cycle();
    assert.equal(result.status, 'NO_ELIGIBLE_ENTRY');
    assert.equal(f.book.control.has('positionQuarantine:first'), false);
    assert.equal(f.book.control.has('entryIncident'), false);
    assert.equal(f.engine.incident, null);
    assert.ok(calls.some(([kind, id]) => kind === 'sync' && id === 'second'));
  });
}
test('protection failure is isolated and never falls through into reduction management', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f), protect = f.lifecycle.protect;
  f.lifecycle.protect = async plan => { if (plan.id === 'first') throw new Error('VENUE_PROTECTION_WEAKER_THAN_LEDGER'); return protect(plan); };
  await f.engine.cycle();
  assert.equal(f.book.control.get('positionQuarantine:first').phase, 'PROTECTION');
  assert.ok(calls.some(([kind, id]) => kind === 'protect' && id === 'second'));
  assert.ok(!calls.some(([kind, id]) => ['manage', 'resume'].includes(kind) && id === 'first'));
});
test('management failure does not prevent independent pending-operation reconciliation', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f);
  f.lifecycle.manage = async () => { throw new Error('PENDING_OPERATION_POSITION_CHANGED'); };
  await f.engine.cycle();
  assert.equal(f.book.control.get('positionQuarantine:first').phase, 'MANAGEMENT');
  assert.ok(calls.some(([kind, id]) => kind === 'resume' && id === 'second'));
});
test('quarantine alone recovers an entry hold after a crash between two control commits', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  await f.book.setControl('positionQuarantine:first', { phase: 'RECONCILIATION', reason: 'VENUE_AND_FILL_QUANTITY_MISMATCH', at: 1789113600100, status: 'REVIEW_REQUIRED_NO_AUTOMATIC_ADOPTION' });
  const recoveredBook = new PositionLedger(f.book.journal);
  const recovered = new S1ExecutionEngine({ ...f.engine, book: recoveredBook });
  assert.equal(recovered.incident, 'POSITION_QUARANTINE_REVIEW_REQUIRED');
  for (const kind of ['stop', 'close', 'cancel']) {
    await assert.rejects(recovered.submissionGate({ kind, planId: 'first' }), /POSITION_QUARANTINED/);
  }
  const stop = [...f.kernel.intents.values()].find(i => i.kind === 'stop');
  await recovered.submissionGate({ kind: 'stop', planId: f.signal.id, params: stop.params, method: stop.method, path: stop.path, intentId: stop.id });
  await assert.rejects(recovered.submissionGate({ kind: 'reserve' }), /ENTRY_INCIDENT_OR_INFRASTRUCTURE_GATE/);
});
test('unresolved entry is rechecked on a new snapshot but never managed from a cached position', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f), sync = f.lifecycle.sync;
  f.lifecycle.sync = async plan => plan.id === 'first' ? { status: 'ENTRY_UNRESOLVED', newEntriesBlocked: true } : sync(plan);
  await f.engine.cycle(); await f.engine.cycle();
  assert.ok(!calls.some(([, id]) => id === 'first'));
  assert.equal(f.engine.quarantinedPlans.size, 0);
  f.lifecycle.sync = sync; f.step(); await f.engine.cycle();
  assert.ok(calls.some(([kind, id]) => kind === 'protect' && id === 'first'));
  assert.equal(f.engine.deferredPlans.size, 0);
  assert.equal(f.engine.incident, 'ENTRY_UNRESOLVED', 'a successful poll is not an incident acknowledgement');
});
test('quarantine persistence failure stops the cycle instead of continuing unjournaled mutations', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f);
  f.lifecycle.sync = async () => { throw new Error('VENUE_AND_FILL_QUANTITY_MISMATCH'); };
  f.book.setControl = async () => { throw new Error('AUDIT_STORAGE_UNAVAILABLE'); };
  const result = await f.engine.cycle();
  assert.equal(result.error, 'AUDIT_STORAGE_UNAVAILABLE');
  assert.deepEqual(calls, []); assert.equal(f.engine.quarantinedPlans.has('first'), true);
});
test('quarantine records only bounded safe error codes, never external response payloads', async t => {
  const f = await fixture(t, 'LIVE'); independentLegs(f);
  f.lifecycle.sync = async () => { throw new Error('https://venue.test/?signature=not-a-real-secret'); };
  await f.engine.cycle();
  assert.equal(f.book.control.get('positionQuarantine:first').reason, 'POSITION_OPERATION_FAILED');
  assert.equal(JSON.stringify(f.book.journal.events).includes('signature='), false);
});
test('foreign position disappearance never fabricates exit fills or cancels venue protection', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  const fills = f.book.fills.size, quantity = f.book.positions.get(f.signal.id).quantity;
  f.venue.quantity = 0n; f.controls.signals = []; f.venue.calls.length = 0; f.step();
  await f.engine.cycle();
  assert.equal(f.engine.quarantinedPlans.has(f.signal.id), true);
  assert.equal(f.book.positions.get(f.signal.id).quantity, quantity);
  assert.equal(f.book.fills.size, fills); assert.equal(f.venue.calls.filter(call => call.method !== 'GET').length, 0);
});
test('failed protection repair result quarantines the leg after its own compensation attempt', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f), protect = f.lifecycle.protect;
  f.lifecycle.protect = async plan => plan.id === 'first' ? { status: 'PROTECTION_REPAIR_FAILED', close: { status: 'UNRESOLVED' } } : protect(plan);
  await f.engine.cycle();
  assert.equal(f.book.control.get('positionQuarantine:first').reason, 'PROTECTION_REPAIR_FAILED');
  assert.ok(calls.some(([kind, id]) => kind === 'protect' && id === 'second'));
  assert.ok(!calls.some(([kind, id]) => ['manage', 'resume'].includes(kind) && id === 'first'));
});
test('flat cleanup ownership failure does not skip protection of another open leg', async t => {
  const f = await fixture(t, 'LIVE'), calls = independentLegs(f);
  f.book.positions.get('first').status = 'CLOSED';
  f.lifecycle.cleanupFlat = async () => { throw new Error('ALGO_CHILD_ORDER_MISMATCH'); };
  await f.engine.cycle();
  assert.equal(f.book.control.get('positionQuarantine:first').phase, 'FLAT_CLEANUP');
  assert.equal(f.book.control.has('retired:first'), false);
  assert.ok(calls.some(([kind, id]) => kind === 'protect' && id === 'second'));
});
test('post-fsync external quantity change prevents a reduction and leaves its intent unresolved', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  const append = f.book.journal.append.bind(f.book.journal);
  f.book.journal.append = async event => {
    const result = await append(event);
    if (event.type === 'INTENT' && event.kind === 'close') f.venue.quantity = 0n;
    return result;
  };
  f.venue.price = '144'; f.controls.signals = []; f.venue.calls.length = 0; f.step();
  await f.engine.cycle();
  assert.equal(f.book.control.get(`positionQuarantine:${f.signal.id}`).reason, 'SUBMISSION_OWNED_QUANTITY_MISMATCH');
  const close = [...f.kernel.intents.values()].find(i => i.kind === 'close');
  assert.ok(close); assert.equal(close.result, null);
  assert.equal(f.venue.calls.filter(call => call.method !== 'GET').length, 0);
  assert.equal(f.book.positions.get(f.signal.id).quantity, '0.09');
});
test('every protection gate requests a post-gate account refresh, even with no user stream', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  const stop = [...f.kernel.intents.values()].find(i => i.kind === 'stop'), calls = [];
  f.controls.connected = false;
  f.engine.frameProvider = async options => { calls.push(options); return f.provider(); };
  await f.engine.submissionGate({ ...stop, intentId: stop.id });
  assert.deepEqual(calls, [{ forceAccountRefresh: true }]);
  f.engine.frameProvider = async () => { const frame = await f.provider(); frame.account.observedAt--; return frame; };
  await assert.rejects(f.engine.submissionGate({ ...stop, intentId: stop.id }), /SUBMISSION_REUSED_PRE_GATE_SNAPSHOT/);
});
test('late partial fill is re-observed before initial protection quantity validation', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle();
  const entry = f.kernel.intents.get(clientId('entry', f.signal.id)), stop = [...f.kernel.intents.values()].find(i => i.kind === 'stop');
  entry.result = { ...entry.result, status: 'PARTIALLY_FILLED', executedQty: '0.04' };
  f.venue.calls.length = 0;
  await f.engine.submissionGate({ ...stop, intentId: stop.id });
  assert.equal(entry.result.executedQty, '0.09'); assert.equal(entry.result.status, 'FILLED');
  assert.ok(f.venue.calls.some(call => call.method === 'GET' && call.params.origClientOrderId === entry.id));
  assert.equal(f.book.fills.size, 0, 'quantity observation is not a fee or PnL ledger projection');
});
test('a replacement stop lost after cancel-intent fsync never causes old protection deletion', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle(); f.step(); await f.engine.cycle();
  const plan = f.kernel.plans.get(f.signal.id), old = [...f.kernel.intents.values()].find(i => i.kind === 'stop');
  const append = f.book.journal.append.bind(f.book.journal);
  f.book.journal.append = async event => {
    const result = await append(event);
    if (event.type === 'INTENT' && event.kind === 'cancel') {
      for (const [id, row] of f.venue.algos) if (id !== old.id) row.algoStatus = 'CANCELED';
    }
    return result;
  };
  f.venue.calls.length = 0;
  await assert.rejects(f.kernel.tighten(plan, old.result, '146', 'cancel-race'), /REPLACEMENT_STOP_NOT_CURRENTLY_VERIFIED/);
  assert.equal(f.venue.algos.get(old.id).algoStatus, 'NEW');
  assert.equal(f.venue.calls.filter(call => call.method === 'DELETE').length, 0);
});
test('quarantine permits only cancellation of its exact durable entry identity', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle();
  await f.engine.quarantine(f.signal.id, 'RECONCILIATION', new Error('VENUE_AND_FILL_QUANTITY_MISMATCH'));
  const entryId = clientId('entry', f.signal.id); f.venue.calls.length = 0; f.venue.quantity = 1n;
  await f.kernel.once('cancel', `${f.signal.id}:entry`, 'DELETE', '/fapi/v1/order', { symbol: f.signal.symbol, origClientOrderId: entryId }, f.signal.id);
  assert.equal(f.venue.calls.filter(call => call.method === 'DELETE').length, 1);
  const stop = [...f.kernel.intents.values()].find(i => i.kind === 'stop');
  await assert.rejects(f.kernel.once('cancel', 'forged-stop-removal', 'DELETE', '/fapi/v1/algoOrder', { symbol: f.signal.symbol, clientAlgoId: stop.id }, f.signal.id), /QUARANTINED/);
  assert.equal(f.venue.algos.get(stop.id).algoStatus, 'NEW');
});
test('quarantine raised while awaiting a refresh blocks submission before its journal commit', async t => {
  const f = await fixture(t, 'LIVE'); await f.engine.cycle();
  const stop = [...f.kernel.intents.values()].find(i => i.kind === 'stop');
  f.engine.frameProvider = async () => {
    const frame = await f.provider(); f.engine.quarantinedPlans.add(f.signal.id); return frame;
  };
  await assert.rejects(f.engine.submissionGate({ ...stop, intentId: stop.id }), /POSITION_QUARANTINED/);
  assert.equal(f.book.control.has(`positionQuarantine:${f.signal.id}`), false);
});

for (const account of ['S1', 'S2']) {
  test(`${account} closest Px wins, is uniquely published and cannot pyramid`, async t => {
    const f = await fixture(t, 'LIVE', account);
    const old = { ...f.signal, id: 'far-old', intersectionPrice: 120 };
    const near = { ...f.signal, id: 'near-new', intersectionPrice: 149, closedAt: f.signal.closedAt + 1 };
    f.controls.signals = [old, near];
    const result = await f.engine.cycle();
    assert.equal(result.status, 'ENTRY_CYCLE', JSON.stringify(result));
    assert.ok(f.kernel.plans.has(near.id)); assert.equal(f.kernel.plans.has(old.id), false);
    assert.deepEqual(f.engine.candidatePriorities.map(p => p.planId), [near.id]);
    f.step(); await f.engine.cycle(); f.step(); await f.engine.cycle();
    assert.equal(f.venue.calls.filter(c => c.method === 'POST' && c.params.type === 'LIMIT').length, 1);
    assert.equal(f.engine.candidatePriorities[0].state, 'POSITION_OPEN');
  });
  test(`${account} rejection before submission cannot starve the next same-symbol plan`, async t => {
    const f = await fixture(t, 'LIVE', account);
    const blocked = { ...f.signal, id: 'nearest-invalid-stop', intersectionPrice: 149.5, stopPrice: '155' };
    const eligible = { ...f.signal, id: 'next-eligible', intersectionPrice: 149 };
    f.controls.signals = [blocked, eligible];
    const result = await f.engine.cycle();
    assert.equal(result.status, 'ENTRY_CYCLE', JSON.stringify(result));
    assert.ok(f.kernel.plans.has(eligible.id)); assert.equal(f.kernel.plans.has(blocked.id), false);
    assert.equal(f.venue.calls.filter(c => c.method === 'POST' && c.params.type === 'LIMIT').length, 1);
    assert.deepEqual(f.engine.candidatePriorities.map(p => p.planId), [eligible.id]);
  });
  test(`${account} uncertain entry result does not submit another candidate`, async t => {
    const f = await fixture(t, 'LIVE', account);
    f.controls.signals = [{ ...f.signal, id: 'old', intersectionPrice: 145 }, { ...f.signal, id: 'near', intersectionPrice: 149 }];
    f.venue.failAfterWrite = true;
    await f.engine.cycle();
    assert.equal(f.venue.calls.filter(c => c.method === 'POST' && c.params.type === 'LIMIT').length, 1);
    assert.equal(f.kernel.plans.has('old'), false);
    assert.equal(f.engine.candidatePriorities[0].planId, 'near');
  });
}

test('R22 final-gate expiry releases unsent draft before next sync can create an incident', async t => {
  const f = await fixture(t, 'LIVE');
  const original = f.kernel.gates; let gates = 0;
  f.kernel.gates = async request => {
    if (request.kind === 'entry' && ++gates === 2) throw new Error('ENTRY_PLAN_EXPIRED');
    return original(request);
  };
  const result = await f.engine.cycle();
  assert.equal(result.status, 'ENTRY_CONFIRMATION_WAIT');
  assert.equal(f.kernel.plans.size, 0); assert.equal(f.kernel.intents.size, 0);
  f.controls.signals = []; f.step(); await f.engine.cycle();
  assert.equal(f.engine.incident, null);
  assert.equal(f.venue.calls.filter(c => c.method !== 'GET').length, 0);
});
