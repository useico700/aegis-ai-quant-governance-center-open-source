import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { UNIVERSE, REVISION, fresh, invariant } from './common.mjs';
import { extractRules } from '../../../lib/s1-precision.mjs';
import { normalizeKlines } from '../../orion-v2/paper/paper-engine.mjs';
import { ACCOUNT_BATCH_PATHS } from './transport.mjs';
import { ACCOUNT_READER_WEIGHT_HEADROOM } from './shared-read-budget.mjs';
import { readRequestWeight } from './request-budget.mjs';
import { hydrateS2ZState, S2_Z_STATE_MAX_BYTES } from '../../shared/s2-z-state-codec.mjs';

// Advisory background eligibility, never a quota increase or a reservation.
// Leave the existing reader reserve AND one fresh shadow account batch intact.
export const SHADOW_BACKGROUND_READ_HEADROOM = ACCOUNT_READER_WEIGHT_HEADROOM
  + ACCOUNT_BATCH_PATHS.reduce((sum, pathname) => sum + readRequestWeight('GET', pathname), 0);

export { requireBackgroundEligibility } from './read-eligibility.mjs';

export function assertProbeHost(hostname, identity, uid) {
  invariant(hostname === 'aegis-demo-host' && identity === 'demo-server' && uid === 993, 'PROBE_SERVER_ONLY');
}
export const S2_SCANNER_STATE_MAX_BYTES = S2_Z_STATE_MAX_BYTES;
export async function boundedJsonFile(filename, maximumBytes = 4 * 1024 ** 2, onMetadata = null) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const report = observedBytes => {
      try { onMetadata?.({ observedBytes, maximumBytes, readAt: Date.now(), withinLimit: stat.isFile() && observedBytes <= maximumBytes }); }
      catch { /* Optional size telemetry cannot affect an otherwise valid read. */ }
    };
    report(stat.size);
    invariant(stat.isFile() && stat.size <= maximumBytes, 'PROBE_FILE_INVALID');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) report(bytes.length);
    invariant(bytes.length <= maximumBytes, 'PROBE_FILE_TOO_LARGE');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}
// Only the deduplicated scanner state needs the larger, still bounded native
// proof envelope. Config, monitor and all other files retain the 4 MiB default.
export const readS2ScannerState = (filename, onMetadata = null) => boundedJsonFile(filename, S2_SCANNER_STATE_MAX_BYTES, onMetadata);
export function candidateSnapshot(state, latest, now, { requiredStructureRevision = null } = {}) {
  invariant(latest?.accountLabel === 'S2' && latest.mode === 'SCAN_ONLY' && latest.revision === REVISION && latest.status === 'HEALTHY', 'PROBE_SCANNER_NOT_HEALTHY');
  state = hydrateS2ZState(state);
  invariant(Number.isSafeInteger(state?.sequence) && state.sequence === latest.sequence && state.lastCycleAt === latest.sourceAsOf && !state.continuity?.freshScanPending, 'PROBE_SCANNER_SNAPSHOT_RACE');
  invariant(!requiredStructureRevision || (state.structureRevision === requiredStructureRevision
    && latest.structureRevision === requiredStructureRevision), 'PROBE_SCANNER_STRUCTURE_UNAVAILABLE');
  const observedAt = Date.parse(latest.sourceAsOf);
  invariant(fresh(observedAt, now, 180000), 'PROBE_SCANNER_STALE');
  invariant(state.plans && !Array.isArray(state.plans) && Object.keys(state.plans).length <= UNIVERSE.length, 'PROBE_SCANNER_PLANS_INVALID');
  const queues = state.planQueues ?? Object.fromEntries(Object.entries(state.plans).map(([symbol, plan]) => [symbol, [plan]]));
  invariant(queues && !Array.isArray(queues) && Object.keys(queues).length <= UNIVERSE.length, 'PROBE_SCANNER_QUEUES_INVALID');
  const plans = Object.entries(queues).flatMap(([symbol, queue]) => {
    invariant(UNIVERSE.includes(symbol) && Array.isArray(queue) && queue.length <= 20
      && new Set(queue.map(plan => plan?.id)).size === queue.length, 'PROBE_SCANNER_QUEUE_SCOPE');
    return queue.map(plan => {
      invariant(plan?.symbol === symbol && typeof plan.id === 'string' && plan.id.length <= 200, 'PROBE_SCANNER_PLAN_SCOPE');
      invariant(latest.candidates?.some(row => row.id === plan.id && row.symbol === symbol && row.stale !== true), 'PROBE_SCANNER_PLAN_NOT_CURRENT');
      return plan;
    });
  });
  invariant(plans.length <= 200, 'PROBE_SCANNER_QUEUE_CAPACITY');
  return { observedAt, plans, sequence: state.sequence,
    ...(state.structureRevision ? { structureRevision: state.structureRevision } : {}) };
}
export function closedBars(rows, interval, now) {
  invariant(['5m', '15m', '1h'].includes(interval) && Array.isArray(rows) && rows.length <= 1500, 'PROBE_BARS_INVALID');
  const width = interval === '5m' ? 300000 : interval === '15m' ? 900000 : 3600000;
  const bars = normalizeKlines(rows, now);
  invariant(bars.length >= 100 && now - bars.at(-1).closeTime <= width + 30000, 'PROBE_BARS_STALE_OR_SHORT');
  invariant(bars.every((b, index) => b.closeTime === b.openTime + width - 1 && b.low > 0 && b.open >= b.low && b.open <= b.high && b.close >= b.low && b.close <= b.high && (!index || b.openTime === bars[index - 1].openTime + width)), 'PROBE_BAR_GAP_OR_SHAPE');
  return bars;
}
// Fixed GET-only production ports. The caller supplies a SignedTransport whose
// real-network mutation path remains unreleased. No retry or trading endpoint.
export function readOnlyMetadataPorts({ publicGet, signedGet, canRead = () => true, now = Date.now, assertPublicReadable = () => {} }) {
  const checkSymbol = symbol => invariant(UNIVERSE.includes(symbol), 'PROBE_SYMBOL_FORBIDDEN');
  const read = (get, pathname, params, options) => {
    invariant(canRead(readRequestWeight('GET', pathname, params)) === true, 'PROBE_BACKGROUND_READ_DEFERRED');
    return options === undefined ? get(pathname, params) : get(pathname, params, options);
  };
  const barCache = new Map();
  const loadClosed = async (symbol, interval, limit) => {
    assertPublicReadable();
    const width = interval === '5m' ? 300000 : interval === '15m' ? 900000 : 3600000, key = `${symbol}:${interval}`;
    const expectedClose = Math.floor(now() / width) * width - 1, cached = barCache.get(key);
    if (cached?.at(-1)?.closeTime === expectedClose) return cached;
    const bars = closedBars(await read(publicGet, '/fapi/v1/klines', { symbol, interval, limit }), interval, now());
    assertPublicReadable();
    barCache.set(key, bars); return bars;
  };
  return {
    assertContextReadable: assertPublicReadable,
    // A scheduler may postpone a slot before calling loadFees. This is only an
    // advisory check; loadFees repeats eligibility and shared admission at I/O.
    canReadFees: () => canRead(readRequestWeight('GET', '/fapi/v1/commissionRate')) === true,
    loadRules: async (options) => {
      assertPublicReadable();
      const observedAt = new Date(now()).toISOString(), info = await read(publicGet, '/fapi/v1/exchangeInfo', undefined, options);
      assertPublicReadable();
      return Object.fromEntries(UNIVERSE.map(symbol => [symbol, extractRules(info, symbol, observedAt)]));
    },
    loadFees: async symbol => {
      checkSymbol(symbol); const observedAt = now(), row = await read(signedGet, '/fapi/v1/commissionRate', { symbol });
      invariant(row?.symbol === symbol && typeof row.takerCommissionRate === 'string' && /^0\.\d+$/.test(row.takerCommissionRate) && Number(row.takerCommissionRate) > 0 && Number(row.takerCommissionRate) < 0.01, 'PROBE_FEE_INVALID');
      return { takerFeeRate: row.takerCommissionRate, observedAt };
    },
    loadBars: async symbol => {
      checkSymbol(symbol);
      const bars5m = await loadClosed(symbol, '5m', 320);
      const bars15m = await loadClosed(symbol, '15m', 320);
      const bars1h = await loadClosed(symbol, '1h', 1200);
      assertPublicReadable();
      return { bars5m, bars15m, bars1h };
    },
  };
}
export function unpersistedProbeMarket(market) {
  return Object.fromEntries(UNIVERSE.map(symbol => [symbol, { ...market[symbol],
    bbo: market[symbol]?.bbo ? { ...market[symbol].bbo, persisted: false, persistence: null } : null,
    tick: market[symbol]?.tick ? { ...market[symbol].tick, persisted: false, persistence: null } : null,
  }]));
}
