import fs from 'node:fs';
import crypto from 'node:crypto';
import { detectMainStructureR2, scanWithStructureExperienceR2, revision, episodePolicy } from './structure-r2.mjs';
import { wilson } from './structure.mjs';
const root = 'reports/smc-research-20261004';
const hPath = 'market_data/orion-v4-rg1/binance-usdm/BTCUSDT/4h/1767225600000-1785542400000.json';
const mPath = 'market_data/orion-v4-rg1/binance-usdm/BTCUSDT/15m/1767225600000-1785542400000.json';
const frozenPath = `${root}/structure-injection-r1-replay.json`;
const hBytes = fs.readFileSync(hPath), h = JSON.parse(hBytes), bars = h.bars;
const r1 = JSON.parse(fs.readFileSync(frozenPath)), main = detectMainStructureR2(bars, 0.1);
const split = Math.floor(bars.length * 0.8);
const held = event => bars.slice(event.index + 1, event.index + 3).every(bar => event.direction === 'LONG'
  ? bar.close > event.level : bar.close < event.level);
const summary = events => {
  const eligible = events.filter(event => event.index + 2 < bars.length);
  const group = events => wilson(events.filter(held).length, events.length);
  return { all: group(eligible), development: group(eligible.filter(event => event.index + 2 < split)),
    temporalEvaluation: group(eligible.filter(event => event.index >= split)),
    splitBoundaryExcluded: eligible.filter(event => event.index < split && event.index + 2 >= split).length,
    unresolvedRightEdge: events.length - eligible.length };
};
const attribution = { MAIN_ALIGNED: [], PARENT_CONFLICT: [], RANGE_OR_UNKNOWN: [] };
for (const event of r1.diagnostic.baselineEvents) {
  const state = main.snapshots.filter(row => row.at < bars[event.index].openTime).at(-1);
  const bias = state?.bias ?? 'UNKNOWN';
  const aligned = event.direction === 'LONG' ? bias === 'BULLISH' : bias === 'BEARISH';
  const conflict = event.direction === 'LONG' ? bias === 'BEARISH' : bias === 'BULLISH';
  attribution[aligned ? 'MAIN_ALIGNED' : conflict ? 'PARENT_CONFLICT' : 'RANGE_OR_UNKNOWN'].push(event);
}
const duplicateGroups = events => {
  const grouped = new Map();
  for (const event of events.filter(event => event.eventType === 'MAIN_CHOCH')) {
    const key = `${event.endpointId}:${event.direction}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event.index);
  }
  return [...grouped].filter(([, indices]) => indices.length > 1).map(([key, indices]) => ({ key, indices }));
};
const rows = bars => bars.map(b => [b.openTime, b.open, b.high, b.low, b.close, b.volume, b.closeTime]);
const now = bars.at(-1).closeTime + 1, m = JSON.parse(fs.readFileSync(mPath));
const scan = scanWithStructureExperienceR2({ symbol: h.symbol, bars4h: rows(bars.slice(-360)),
  bars15m: rows(m.bars.filter(b => b.closeTime < now).slice(-1500)), now, tickSize: '0.1', quote: null });
const result = { revision, episodePolicy, sourceHash: crypto.createHash('sha256').update(hBytes).digest('hex'),
  frozenR1Path: frozenPath, sameFrozenBaselineOpportunityCount: r1.diagnostic.baselineEvents.length,
  r1DuplicateChoch: duplicateGroups(r1.diagnostic.mainEvents), r2DuplicateChoch: duplicateGroups(main.events),
  r2MainEventSummary: summary(main.events.filter(event => event.eventType.startsWith('MAIN_'))),
  attribution: Object.fromEntries(Object.entries(attribution).map(([key, events]) => [key, summary(events)])),
  outcome: 'NEXT_TWO_CLOSES_HOLD_NOT_TRADE_WIN', statisticalStatus: 'SINGLE_SYMBOL_DESCRIPTIVE_CORRELATED_EVENTS',
  productionMutated: false, jevImpact: 'NO_RUNTIME_EFFECT_OFFLINE_RESEARCH_ONLY', qualifiedTradeSamples: 0,
  main, scan };
const output = `${root}/structure-injection-r2-replay.json`;
if (fs.existsSync(output)) throw new Error('OUTPUT_ALREADY_EXISTS_PRESERVE_FROZEN_RESULTS');
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, r1DuplicateChoch: result.r1DuplicateChoch, r2DuplicateChoch: result.r2DuplicateChoch,
  r2MainEventSummary: result.r2MainEventSummary, attribution: result.attribution,
  eventCounts: Object.fromEntries([...new Set(main.events.map(e => e.eventType))].map(type =>
    [type, main.events.filter(e => e.eventType === type).length])) }));
