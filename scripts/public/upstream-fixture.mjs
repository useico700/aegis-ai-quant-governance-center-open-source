import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SQLiteJournal } from '../../agents/orion-live/s1-execution/sqlite-journal.mjs';
import { PositionLedger } from '../../agents/orion-live/s1-execution/position-ledger.mjs';
import { S1ExecutionEngine } from '../../agents/orion-live/s1-execution/engine.mjs';
import { createExecutionRuntime as createS2ExecutionRuntime } from '../../agents/orion-live/s2-execution/execution-runtime.mjs';
import { createExecutionRuntime } from '../../agents/orion-live/s1-execution/execution-runtime.mjs';
import { REVISION, clientId } from '../../agents/orion-live/s1-execution/common.mjs';
import { FakeS1Venue } from '../../tests/helpers/s1-fake-venue.mjs';
import { EntryEvidenceArchive as S2EntryEvidenceArchive } from '../../agents/orion-live/s2-execution/entry-evidence.mjs';
import { EntryEvidenceArchive } from '../../agents/orion-live/s1-execution/entry-evidence.mjs';
import { SegmentedEvidenceStore } from '../../agents/orion-live/s1-execution/segmented-evidence.mjs';

const profile = JSON.parse(await fs.readFile(new URL('../../agents/orion-live/s1-scanner/r22-risk-profile.json', import.meta.url)));
const s2Profile = JSON.parse(await fs.readFile(new URL('../../agents/orion-live/s2-scanner/r22-risk-profile.json', import.meta.url)));
export async function upstreamFixture(t, mode = 'OBSERVE', account = 'S1') {
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
