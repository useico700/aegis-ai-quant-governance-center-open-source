import policy from './smc-scan-policy.json' with { type:'json' };
const check=(ok,code)=>{if(!ok)throw new Error(code);};
export function smcBars(rows, width, now) {
  check(Array.isArray(rows) && rows.length <= 1500, 'BARS_INVALID');
  const bars = rows.map(row => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]),
  })).filter(bar => bar.closeTime < now);
  check(bars.length >= 80, 'BARS_TOO_SHORT');
  check(bars.every((bar, index) => Object.values(bar).every(Number.isFinite) && Number.isSafeInteger(bar.openTime)
    && bar.openTime % width === 0 && bar.closeTime === bar.openTime + width - 1 && bar.low > 0 && bar.volume >= 0
    && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)
    && (!index || bar.openTime === bars[index - 1].openTime + width)), 'BARS_GAP_OR_SHAPE');
  check(now - bars.at(-1).closeTime <= width + 30000, 'BARS_STALE');
  return bars;
}

export function confirmedSmcPivots(bars, left = policy.externalSwingLeft, right = policy.externalSwingRight) {
  const output = [];
  for (let index = left; index < bars.length - right; index++) {
    const neighbours = [...bars.slice(index - left, index), ...bars.slice(index + 1, index + right + 1)];
    for (const [kind, field, compare] of [['HIGH', 'high', (a, b) => a > b], ['LOW', 'low', (a, b) => a < b]]) {
      if (neighbours.every(bar => compare(bars[index][field], bar[field]))) output.push({
        kind, index, price: bars[index][field], time: bars[index].openTime, confirmedAt: bars[index + right].closeTime,
      });
    }
  }
  return output;
}
