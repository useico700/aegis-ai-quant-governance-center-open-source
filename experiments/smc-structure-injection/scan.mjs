import { scanSmcSymbol, confirmedSmcPivots, smcStructureBias } from '../../lib/smc-scanner.mjs';
import { annotateScan, detectMainStructure, wilson } from './structure.mjs';

export function scanWithStructureExperience(input) {
  const scan = scanSmcSymbol(input);
  const bars = input.bars4h.filter(row => Number(row[6]) < input.now).map(row => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) }));
  return annotateScan(scan, bars, Number(input.tickSize));
}

// Diagnostic event outcomes are not simulated fills or profitability labels.
export function compareStructureRecognition(bars, tick) {
  const baseline = [], pivots = confirmedSmcPivots(bars), consumed = new Set();
  for (let i = 80; i < bars.length; i++) {
    const known = pivots.filter(point => point.confirmedAt < bars[i].openTime);
    const bias = smcStructureBias(known);
    const trs = bars.slice(i - 14, i).map((bar, j) => Math.max(bar.high - bar.low,
      Math.abs(bar.high - bars[i - 15 + j].close), Math.abs(bar.low - bars[i - 15 + j].close)));
    const buffer = Math.max(2 * tick, 0.05 * trs.reduce((a, b) => a + b, 0) / 14);
    for (const [direction, kind] of [['LONG', 'HIGH'], ['SHORT', 'LOW']]) {
      const point = known.filter(row => row.kind === kind).at(-1);
      if (!point) continue;
      const id = `${kind}:${point.index}`;
      const long = direction === 'LONG';
      if (consumed.has(id) || !(long ? bars[i].close > point.price + buffer
        && bars[i - 1].close <= point.price + buffer : bars[i].close < point.price - buffer
        && bars[i - 1].close >= point.price - buffer)) continue;
      consumed.add(id);
      baseline.push({ direction, index: i, at: bars[i].closeTime, level: point.price,
        eventType: bias === 'RANGE' ? 'MSS' : (long ? bias === 'BULLISH' : bias === 'BEARISH') ? 'BOS' : 'CHOCH' });
    }
  }
  const main = detectMainStructure(bars, tick), split = Math.floor(bars.length * 0.8);
  const summarize = events => {
    const eligible = events.filter(event => event.index + 2 < bars.length);
    const success = event => bars.slice(event.index + 1, event.index + 3).every(bar =>
      event.direction === 'LONG' ? bar.close > event.level : bar.close < event.level);
    const describe = group => ({ twoCloseHold: wilson(group.filter(success).length, group.length),
      events: group.length });
    return { all: describe(eligible), development: describe(eligible.filter(event => event.index < split)),
      temporalEvaluation: describe(eligible.filter(event => event.index >= split)),
      unresolvedRightEdge: events.length - eligible.length };
  };
  const byAt = new Set(main.events.map(event => `${event.at}:${event.direction}`));
  const attribution = { MAIN_ALIGNED: [], PARENT_CONFLICT: [], RANGE_OR_UNKNOWN: [] };
  for (const event of baseline) {
    const state = main.snapshots.filter(state => state.at < bars[event.index].openTime).at(-1);
    const bias = state?.bias ?? 'UNKNOWN';
    const aligned = event.direction === 'LONG' ? bias === 'BULLISH' : bias === 'BEARISH';
    const conflict = event.direction === 'LONG' ? bias === 'BEARISH' : bias === 'BULLISH';
    attribution[aligned ? 'MAIN_ALIGNED' : conflict ? 'PARENT_CONFLICT' : 'RANGE_OR_UNKNOWN'].push(event);
  }
  return { purpose: 'STRUCTURE_RECOGNITION_DIAGNOSTICS_ONLY', parametersFrozenBeforeRun: true,
    evaluationSplitIndex: split, outcome: 'NEXT_TWO_CLOSES_HOLD_BROKEN_LEVEL_NOT_TRADE_WIN',
    confidenceInterval: 'WILSON_DESCRIPTIVE;EVENTS_CORRELATED_NOT_CAUSAL_PROOF',
    baseline: summarize(baseline), main: summarize(main.events),
    baselineScope: 'PIVOT_BREAK_DETECTOR_ONLY_NOT_FULL_PRODUCTION_CANDIDATE_OR_EXECUTION_FUNNEL',
    attribution: Object.fromEntries(Object.entries(attribution).map(([group, events]) => [group, summarize(events)])),
    overlappingEventTimes: baseline.filter(event => byAt.has(`${event.at}:${event.direction}`)).length,
    mainPointCount: main.points.length,
    averageConfirmationDelayBars: main.points.length ? main.points.reduce((n, point) =>
      n + point.confirmationDelayBars, 0) / main.points.length : null,
    calibratedWinProbability: null, qualifiedTradePerformanceSamples: 0,
    mainEvents: main.events, baselineEvents: baseline };
}
