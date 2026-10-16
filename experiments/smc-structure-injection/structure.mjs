// Causal research scanner. This module has no execution, network or deployment interface.
export const revision = 'SMC-MAIN-SEQUENCE-R1';
export const parameters = Object.freeze({ warmup: 80, thetaAtr: 1, minExtremeBars: 4,
  breakBufferAtr: 0.05, breakTicks: 2 });

function atrAt(bars, index) {
  const start = Math.max(1, index - 13);
  let sum = 0;
  for (let i = start; i <= index; i++) sum += Math.max(bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  return sum / (index - start + 1);
}

export function sequenceContext(points, tick) {
  const labels = [], last = {}, counts = { HH: 0, HL: 0, LL: 0, LH: 0 };
  for (const point of points) {
    const previous = last[point.kind];
    if (previous) {
      const delta = Math.round(point.price / tick) - Math.round(previous.price / tick);
      const label = delta === 0 ? 'EQ' : point.kind === 'HIGH'
        ? (delta > 0 ? 'HH' : 'LH') : (delta > 0 ? 'HL' : 'LL');
      const sameKind = point.kind === 'HIGH' ? ['HH', 'LH'] : ['HL', 'LL'];
      for (const key of sameKind) counts[key] = label === key ? counts[key] + 1 : 0;
      labels.push({ kind: point.kind, pointId: point.id, previousId: previous.id, label, availableAt: point.confirmedAt });
    }
    last[point.kind] = point;
  }
  const high = labels.filter(row => row.kind === 'HIGH').at(-1)?.label;
  const low = labels.filter(row => row.kind === 'LOW').at(-1)?.label;
  const bias = !high || !low ? 'UNKNOWN' : high === 'HH' && low === 'HL' ? 'BULLISH'
    : high === 'LH' && low === 'LL' ? 'BEARISH' : 'RANGE';
  return { bias, counts, labels, endpointIds: points.map(point => point.id),
    spanBars: points.length > 1 ? points.at(-1).index - points[0].index : 0 };
}

export function detectMainStructure(bars, tick, options = {}) {
  const p = { ...parameters, ...options };
  if (!(tick > 0) || !Number.isInteger(p.warmup) || p.warmup < 15
    || !(p.thetaAtr > 0) || !Number.isInteger(p.minExtremeBars) || p.minExtremeBars < 1)
    throw new Error('STRUCTURE_POLICY_INVALID');
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (![b.openTime, b.closeTime, b.open, b.high, b.low, b.close].every(Number.isFinite)
      || b.low <= 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)
      || b.closeTime !== b.openTime + 14400000 - 1
      || (i && b.openTime !== bars[i - 1].openTime + 14400000)) throw new Error('BARS_GAP_OR_SHAPE');
  }
  const points = [], events = [], snapshots = [], consumed = new Set();
  let leg = 'UNKNOWN', high, low, bias = 'UNKNOWN', protectedPoint = null;
  const extreme = (index, kind) => ({ index, price: bars[index][kind === 'HIGH' ? 'high' : 'low'],
    atr: atrAt(bars, index) });
  const append = (kind, e, i) => {
    const point = { id: `${revision}:${kind}:${bars[e.index].openTime}`, kind,
      index: e.index, price: e.price, time: bars[e.index].openTime,
      confirmedAt: bars[i].closeTime, confirmationDelayBars: i - e.index };
    points.push(point);
    return point;
  };
  for (let i = p.warmup - 1; i < bars.length; i++) {
    const b = bars[i];
    if (!high) { high = extreme(i, 'HIGH'); low = extreme(i, 'LOW'); continue; }
    // Events always use points known before this bar opened. Confirm new points afterwards.
    const knownHigh = points.filter(row => row.kind === 'HIGH').at(-1);
    const knownLow = points.filter(row => row.kind === 'LOW').at(-1);
    const buffer = Math.max(p.breakTicks * tick, p.breakBufferAtr * atrAt(bars, i - 1));
    let transitionThisBar = false;
    if (protectedPoint && ((bias === 'BULLISH' && b.close < protectedPoint.price - buffer)
      || (bias === 'BEARISH' && b.close > protectedPoint.price + buffer))) {
      const direction = bias === 'BULLISH' ? 'SHORT' : 'LONG';
      events.push({ eventType: 'MAIN_CHOCH', direction, index: i, at: b.closeTime,
        level: protectedPoint.price, endpointId: protectedPoint.id, priorBias: bias });
      consumed.add(protectedPoint.id);
      bias = 'TRANSITION'; protectedPoint = null; transitionThisBar = true;
    }
    for (const [direction, point] of [['LONG', knownHigh], ['SHORT', knownLow]]) {
      if (!point || consumed.has(point.id)) continue;
      const long = direction === 'LONG';
      if (!(long ? b.close > point.price + buffer : b.close < point.price - buffer)) continue;
      consumed.add(point.id);
      const sameDirection = long ? bias === 'BULLISH' : bias === 'BEARISH';
      if (sameDirection && !transitionThisBar) {
        // Only continuation of an established main trend may migrate its protection.
        const opposite = long ? knownLow : knownHigh;
        if (opposite && opposite.confirmedAt < b.openTime) protectedPoint = opposite;
      }
      if (!transitionThisBar) events.push({ eventType: sameDirection ? 'MAIN_BOS' : 'MAIN_MSS',
        direction, index: i, at: b.closeTime, level: point.price, endpointId: point.id,
        priorBias: bias, protectedPointId: protectedPoint?.id ?? null });
    }
    const turnDown = i - high.index >= p.minExtremeBars && b.close <= high.price - p.thetaAtr * high.atr;
    const turnUp = i - low.index >= p.minExtremeBars && b.close >= low.price + p.thetaAtr * low.atr;
    let added = false;
    if (leg === 'UNKNOWN' && turnDown && turnUp) {
      snapshots.push({ at: b.closeTime, bias: 'UNKNOWN', reason: 'AMBIGUOUS_SEED', pointCount: points.length });
      continue;
    }
    if ((leg === 'UNKNOWN' || leg === 'UP') && turnDown) {
      append('HIGH', high, i); leg = 'DOWN'; added = true;
      low = extreme(high.index + 1, 'LOW');
      for (let j = high.index + 2; j <= i; j++) if (bars[j].low < low.price) low = extreme(j, 'LOW');
    } else if ((leg === 'UNKNOWN' || leg === 'DOWN') && turnUp) {
      append('LOW', low, i); leg = 'UP'; added = true;
      high = extreme(low.index + 1, 'HIGH');
      for (let j = low.index + 2; j <= i; j++) if (bars[j].high > high.price) high = extreme(j, 'HIGH');
    } else {
      if ((leg === 'UNKNOWN' || leg === 'UP') && b.high > high.price) high = extreme(i, 'HIGH');
      if ((leg === 'UNKNOWN' || leg === 'DOWN') && b.low < low.price) low = extreme(i, 'LOW');
    }
    if (added) {
      const context = sequenceContext(points, tick);
      // A protection break cannot regain its old trend without a newly confirmed sequence.
      if (!transitionThisBar && ['BULLISH', 'BEARISH'].includes(context.bias)) {
        if (bias !== context.bias) protectedPoint = points.filter(row => row.kind ===
          (context.bias === 'BULLISH' ? 'LOW' : 'HIGH')).at(-1);
        bias = context.bias;
      } else if (bias === 'UNKNOWN' && context.bias === 'RANGE') bias = 'RANGE';
    }
    snapshots.push({ at: b.closeTime, bias, pointCount: points.length,
      protectedPointId: protectedPoint?.id ?? null });
  }
  return { revision, parameters: p, points, events, snapshots,
    sequence: sequenceContext(points, tick), orderAuthority: false };
}

export function annotateScan(scan, bars, tick) {
  const main = detectMainStructure(bars, tick);
  const annotate = row => {
    const at = row.structure?.bosAt ?? row.breakAt;
    const openAt = at - 14400000 + 1;
    const points = main.points.filter(point => point.confirmedAt < openAt);
    const sequence = sequenceContext(points, tick);
    const state = main.snapshots.filter(state => state.at < openAt).at(-1);
    const event = main.events.find(event => event.at === at && event.direction === row.direction);
    const mainBias = state?.bias ?? 'UNKNOWN';
    const conflict = row.direction === 'LONG' ? mainBias === 'BEARISH' : mainBias === 'BULLISH';
    return { ...row, researchStructure: { revision, ...sequence, mainBias,
      classification: event?.eventType ?? 'INTERNAL_OR_UNCONFIRMED',
      parentConflict: conflict, protectedPointId: state?.protectedPointId ?? null,
      recommendation: conflict ? 'REVIEW_PARENT_CONFLICT' : event ? 'MAIN_EVENT' : 'INTERNAL_CONTEXT',
      calibratedWinProbability: null, admissionChanged: false } };
  };
  return { ...scan, candidates: scan.candidates.map(annotate), structures: scan.structures.map(annotate),
    researchMainStructure: main, researchOnly: true, orderAuthority: false };
}

export function wilson(successes, total) {
  if (!total) return { rate: null, lower: null, upper: null, total, successes };
  const z = 1.959963984540054, rate = successes / total, d = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / d;
  const half = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / d;
  return { rate, lower: Math.max(0, center - half), upper: Math.min(1, center + half), total, successes };
}
