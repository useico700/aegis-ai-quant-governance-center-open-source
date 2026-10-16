import policy from './smc-scan-policy.json' with { type:'json' };
import {smcBars,confirmedSmcPivots} from './smc-bar-evidence.mjs';
const M5 = 300000;
const averageRange = bars => {
  const start = Math.max(1, bars.length - 14);
  return bars.slice(start).reduce((sum, b, i) => sum + Math.max(b.high - b.low,
    Math.abs(b.high - bars[start + i - 1].close), Math.abs(b.low - bars[start + i - 1].close)), 0) / (bars.length - start);
};
export function reviewRetestTiming(plan, rows, now) {
  const base = { timeframe: '5M', ready: false, orderAuthority: false, availableAt: null,
    touchAt: null, confirmation: null, breakPivot: null, atr5m: null };
  let bars;
  try { bars = smcBars(rows, M5, now); }
  catch { return { ...base, state: 'UNAVAILABLE' }; }
  const long = plan.direction === 'LONG', pivots = confirmedSmcPivots(bars);
  const from = Math.max(0, bars.length - policy.entryLiquidityLookbackBars15m);
  let touch = -1;
  // Start the latest contiguous visit, rather than refreshing an old confirmation on every overlap.
  let previousTouches = false;
  for (let i = from; i < bars.length; i++) {
    const b = bars[i], touches = b.openTime > plan.anchor.confirmedAt && b.low <= plan.zone.high && b.high >= plan.zone.low;
    if (touches && !previousTouches) touch = i;
    previousTouches = touches;
  }
  const result = { ...base, state: 'WAIT_ZONE_TOUCH', availableAt: bars.at(-1).closeTime };
  if (touch < 0) return result;
  result.touchAt = bars[touch].closeTime; result.state = 'WAIT_LOCAL_REVERSAL';
  if (bars.slice(touch).some(b => long ? b.low <= plan.stop : b.high >= plan.stop))
    return { ...result, state: 'RETEST_INVALIDATED' };
  for (let i = touch; i < bars.length; i++) {
    const b = bars[i];
    if (b.closeTime - result.touchAt > policy.entryMicroStructureMaximumAgeMs) break;
    const volatility = averageRange(bars.slice(0, i + 1));
    const range = b.high - b.low, body = Math.abs(b.close - b.open);
    const directional = long ? b.close > b.open : b.close < b.open;
    const location = range > 0 ? (long ? b.close - b.low : b.high - b.close) / range : 0;
    const pivot = pivots.filter(p => p.kind === (long ? 'HIGH' : 'LOW') && p.confirmedAt < b.openTime).at(-1);
    if (!pivot || !directional || !volatility || !range) continue;
    const buffer = Math.max(plan.tickSize * 2, volatility * policy.entryMicroStructureBreakBufferAtr);
    if (!(long ? b.close > plan.zone.high : b.close < plan.zone.low)) continue;
    const crossed = long ? bars[i - 1]?.close <= pivot.price + buffer && b.close > pivot.price + buffer
      : bars[i - 1]?.close >= pivot.price - buffer && b.close < pivot.price - buffer;
    if (!crossed || body / range < policy.entryMicroStructureMinimumBodyFraction
      || range / volatility < policy.entryMicroStructureMinimumRangeAtr
      || location < policy.entryMicroStructureMinimumDirectionalCloseLocation) continue;
    result.confirmation = { openTime: b.openTime, closeTime: b.closeTime, open: b.open, high: b.high, low: b.low,
      close: b.close, previousClose: bars[i - 1].close, bodyFraction: body / range, rangeATR: range / volatility, directionalCloseLocation: location, buffer };
    result.breakPivot = { kind: pivot.kind, price: pivot.price, time: pivot.time, confirmedAt: pivot.confirmedAt };
    result.atr5m = volatility;
    result.ready = now - b.closeTime <= policy.entryMicroStructureMaximumAgeMs;
    result.state = result.ready ? 'LOCAL_REVERSAL_CONFIRMED' : 'CONFIRMATION_EXPIRED';
    break;
  }
  return result;
}
