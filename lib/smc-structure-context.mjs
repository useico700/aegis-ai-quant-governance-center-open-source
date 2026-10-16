import policy from './smc-structure-context-policy.json' with { type: 'json' };
export { policy as SMC_CONTEXT_POLICY };
const check = (ok, code) => { if (!ok) throw new Error(code); };
const round = n => Number(n.toPrecision(12));
const directionBias = direction => direction === 'LONG' ? 'BULLISH' : 'BEARISH';
const directional = bias => ['BULLISH', 'BEARISH'].includes(bias);
const mean = values => values.reduce((sum, n) => sum + n, 0) / values.length;
const atr = bars => mean(bars.slice(-14).map((b, i, selected) => {
  const prev = i ? selected[i - 1] : bars[bars.length - selected.length - 1];
  return Math.max(b.high - b.low, prev ? Math.abs(b.high - prev.close) : 0, prev ? Math.abs(b.low - prev.close) : 0);
}));

export function contextSequence(points, tick) {
  const counts = { HH: 0, HL: 0, LL: 0, LH: 0 }, last = {}, labels = [];
  for (const p of points) {
    if (last[p.kind]) {
      const delta = Math.round(p.price / tick) - Math.round(last[p.kind].price / tick);
      const label = delta === 0 ? 'EQ' : p.kind === 'HIGH' ? (delta > 0 ? 'HH' : 'LH') : (delta > 0 ? 'HL' : 'LL');
      for (const key of p.kind === 'HIGH' ? ['HH', 'LH'] : ['HL', 'LL']) counts[key] = label === key ? counts[key] + 1 : 0;
      labels.push({ label, pointId: p.id, availableAt: p.confirmedAt });
    }
    last[p.kind] = p;
  }
  const high = labels.filter(p => /:(HIGH):/.test(p.pointId)).at(-1)?.label;
  const low = labels.filter(p => /:(LOW):/.test(p.pointId)).at(-1)?.label;
  return { bias: !high || !low ? 'UNKNOWN' : high === 'HH' && low === 'HL' ? 'BULLISH'
    : high === 'LH' && low === 'LL' ? 'BEARISH' : 'RANGE', counts, labels: labels.slice(-12) };
}

// Each event uses only points available BEFORE its bar opens. A pivot confirmed
// at this bar's close becomes eligible starting at the next bar, never retroactively.
export function advanceContextBar(state, bar) {
  const s = state, previous = s.tail.at(-1), known = s.points.filter(p => p.confirmedAt < bar.openTime);
  if (previous && s.tail.length >= 15) {
    const buffer = Math.max(policy.breakTicks * s.tick, policy.breakBufferAtr * atr(s.tail));
    const before = s.bias, oldProtection = s.protectedPoint?.id ?? null;
    // A new lower high / higher low is internal to the active trend. The held
    // frontier survives both newer local pivots and bounded history eviction.
    if (directional(s.bias) && s.externalBoundary) {
      const long = s.bias === 'BULLISH';
      for (const p of known) if (p.kind === (long ? 'HIGH' : 'LOW') && p.time > s.externalBoundary.time
        && (long ? Math.round(p.price / s.tick) > Math.round(s.externalBoundary.price / s.tick)
          : Math.round(p.price / s.tick) < Math.round(s.externalBoundary.price / s.tick))) s.externalBoundary = p;
    }
    const protectionBroken = s.protectedPoint && (s.bias === 'BULLISH' ? bar.close < s.protectedPoint.price - buffer
      : s.bias === 'BEARISH' && bar.close > s.protectedPoint.price + buffer);
    const record = (type, direction, endpoint) => {
      const event = { id: `${policy.revision}:${s.symbol}:${s.timeframe}:${type}:${bar.closeTime}:${direction}`,
        type, direction, at: bar.closeTime, level: endpoint.price, endpointId: endpoint.id,
        endpointAvailableAt: endpoint.confirmedAt, priorBias: before, bias: s.bias,
        scope: ['BOS', 'CHOCH', 'TREND_CONFIRMED'].includes(type) ? 'EXTERNAL' : type === 'INTERNAL_BREAK' ? 'INTERNAL' : 'UNCONFIRMED',
        externalBoundaryId: s.externalBoundary?.id ?? null,
        episodeId: s.episodeId, protectedPointId: s.protectedPoint?.id ?? null,
        priorProtectedPointId: oldProtection, evidenceGroupId: `${s.symbol}:${s.timeframe}:${bar.openTime}` };
      s.events.push(event); return event;
    };
    if (protectionBroken) {
      const endpoint = s.protectedPoint, direction = s.bias === 'BULLISH' ? 'SHORT' : 'LONG';
      check(!s.consumed.includes(`${endpoint.id}:${direction}`), 'CONTEXT_PROTECTION_REUSED');
      s.consumed.push(`${endpoint.id}:${direction}`); s.retired.push(endpoint.id);
      s.bias = 'TRANSITION'; s.transitionAt = bar.closeTime; s.protectedPoint = null; s.externalBoundary = null;
      record('CHOCH', direction, endpoint);
    } else for (const direction of ['LONG', 'SHORT']) {
      const long = direction === 'LONG', target = directionBias(direction), inTrend = directional(s.bias);
      const local = known.filter(p => p.kind === (long ? 'HIGH' : 'LOW')).at(-1);
      const crosses = p => p && !s.consumed.includes(`${p.id}:${direction}`)
        && (long ? bar.close > p.price + buffer && previous.close <= p.price + buffer
          : bar.close < p.price - buffer && previous.close >= p.price - buffer);
      const external = inTrend && s.bias === target && crosses(s.externalBoundary);
      const point = external ? s.externalBoundary : crosses(local) ? local : null;
      if (!point) continue;
      s.consumed.push(`${point.id}:${direction}`);
      const recovery = s.transitionAt == null ? known : known.filter(p => p.time > s.transitionAt && p.confirmedAt > s.transitionAt);
      const establish = !inTrend && (s.transitionAt == null || point.time > s.transitionAt)
        && contextSequence(recovery, s.tick).bias === target;
      const possible = known.filter(p => p.kind === (long ? 'LOW' : 'HIGH') && p.time > point.time
        && !s.retired.includes(p.id) && !s.consumed.includes(`${p.id}:${long ? 'SHORT' : 'LONG'}`)
        && (long ? p.price < bar.close - buffer : p.price > bar.close + buffer));
      const selected = possible.reduce((best, p) => !best || (long ? p.price < best.price : p.price > best.price) ? p : best, null);
      const type = establish && selected ? 'TREND_CONFIRMED' : external ? 'BOS' : inTrend ? 'INTERNAL_BREAK' : 'UNCONFIRMED_BREAK';
      if (establish && selected) {
        s.episodeId = `${s.symbol}:${s.timeframe}:EPISODE:${bar.closeTime}:${direction}`;
        s.bias = target; s.protectedPoint = selected; s.externalBoundary = point;
      } else if (external && selected && (!s.protectedPoint || (long ? selected.price >= s.protectedPoint.price : selected.price <= s.protectedPoint.price))) {
        s.protectedPoint = selected;
      }
      record(type, direction, point);
    }
  }
  s.tail.push(bar);
  if (s.tail.length >= 5) {
    const window = s.tail.slice(-5), pivot = window[2];
    for (const [kind, field] of [['HIGH', 'high'], ['LOW', 'low']]) {
      if (window.every((b, i) => i === 2 || (kind === 'HIGH' ? pivot[field] > b[field] : pivot[field] < b[field]))) {
        s.points.push({ id: `${policy.revision}:${s.symbol}:${s.timeframe}:${kind}:${pivot.openTime}`,
          kind, price: pivot[field], time: pivot.openTime, confirmedAt: bar.closeTime });
      }
    }
  }
  s.lastCloseAt = bar.closeTime; s.processedBars++;
  s.tail = s.tail.slice(-80); s.points = s.points.slice(-128); s.events = s.events.slice(-256);
  const live = new Set([...s.points.map(p => p.id), s.protectedPoint?.id, s.externalBoundary?.id].filter(Boolean));
  s.retired = s.retired.filter(id => live.has(id));
  s.consumed = s.consumed.filter(key => live.has(key.slice(0, key.lastIndexOf(':'))));
  return s;
}

export function newContextState(symbol, timeframe, tick, originAt) {
  return { revision: policy.revision, symbol, timeframe, tick, originAt, processedBars: 0,
    lastCloseAt: null, bias: 'UNKNOWN', protectedPoint: null, externalBoundary: null,
    episodeId: null, transitionAt: null, points: [], events: [], consumed: [], retired: [], tail: [] };
}

// Causal classification for historical structure events, with the exact same
// pivot/protection semantics as the streaming context, never future bars.
export function traceContextBars({ symbol, timeframe, tick, bars }) {
  const s = newContextState(symbol, timeframe, tick, bars[0]?.openTime);
  const events = [];
  for (const bar of bars) {
    advanceContextBar(s, bar);
    events.push(...s.events.filter(e => e.at === bar.closeTime));
  }
  return { state: s, events };
}

function geometry(bars) {
  const window = bars.slice(-policy.geometryBars), last = window.at(-1), a = atr(bars);
  const low = Math.min(...window.map(b => b.low)), high = Math.max(...window.map(b => b.high));
  const travel = window.slice(1).reduce((sum, b, i) => sum + Math.abs(b.close - window[i].close), 0);
  const logs = window.map(b => Math.log(b.close)), xm = (logs.length - 1) / 2, ym = mean(logs);
  const numerator = logs.reduce((sum, y, x) => sum + (x - xm) * (y - ym), 0);
  const denominator = logs.reduce((sum, _, x) => sum + (x - xm) ** 2, 0);
  const variance = logs.reduce((sum, y) => sum + (y - ym) ** 2, 0), slope = denominator ? numerator / denominator : 0;
  const medianVolumes = window.slice(0, -1).map(b => b.volume).sort((x, y) => x - y);
  const baseline = medianVolumes[Math.floor(medianVolumes.length / 2)] ?? 0;
  return { atr: round(a), rangeLow: low, rangeHigh: high,
    rangePosition: high > low ? round((last.close - low) / (high - low)) : null,
    efficiency: travel ? round(Math.abs(last.close - window[0].close) / travel) : 0,
    logSlopePerBar: round(slope), rSquared: variance && denominator ? round(Math.min(1, numerator ** 2 / (denominator * variance))) : 0,
    bodyAtr: a ? round((last.close - last.open) / a) : 0,
    relativeVolume: baseline ? round(last.volume / baseline) : null };
}

// A venue may finalize its latest closed candle after our first read. Never
// reset the streaming history: replay both versions and require identical
// structural state, including consumed/retired endpoints and protection.
export function recoverLatestContextSource(checkpoint, bars, tick) {
  const overlap = bars.filter(b => checkpoint.tail.some(old => old.openTime === b.openTime));
  const changed = overlap.filter(b => JSON.stringify(b) !== JSON.stringify(checkpoint.tail.find(old => old.openTime === b.openTime)));
  check(overlap.length > 0 && changed.length === 1, 'CONTEXT_HISTORY_CHANGED');
  const revised = changed[0], original = checkpoint.tail.at(-1);
  check(revised.openTime === original.openTime && revised.closeTime === checkpoint.lastCloseAt
    && ['openTime','closeTime','open','high','low'].every(k => revised[k] === original[k])
    && Math.abs(revised.close-original.close) <= tick + tick * 1e-7
    && !checkpoint.events.some(e => e.at === original.closeTime), 'CONTEXT_HISTORY_CHANGED');
  const before = structuredClone(checkpoint);
  before.tail.pop(); before.lastCloseAt = before.tail.at(-1).closeTime; before.processedBars--;
  before.points = before.points.filter(p => p.confirmedAt !== original.closeTime);
  const replayOld = advanceContextBar(structuredClone(before), original);
  // Exact reconstruction is mandatory; truncated point/event history cannot
  // be repaired by guessing or borrowing a newer checkpoint.
  check(JSON.stringify(replayOld) === JSON.stringify(checkpoint), 'CONTEXT_HISTORY_CHANGED');
  const replayNew = advanceContextBar(structuredClone(before), revised);
  const structural = s => JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'tail')));
  check(structural(replayOld) === structural(replayNew), 'CONTEXT_HISTORY_CHANGED');
  return { checkpoint: replayNew, receipt: { revision:'SMC-CONTEXT-SOURCE-RECOVERY-1',
    status:'EXACT_REPLAY_STRUCTURE_UNCHANGED', openTime:original.openTime, closeTime:original.closeTime,
    before:{close:original.close,volume:original.volume}, after:{close:revised.close,volume:revised.volume},
    structuralStateChanged:false, orderAuthority:false } };
}

export function scanContextFrame({ symbol, timeframe, rows, tick, now, checkpoint = null }) {
  const frame = policy.frames[timeframe];
  check(frame && /^[A-Z0-9]{3,20}$/.test(symbol) && Number.isFinite(tick) && tick > 0, 'CONTEXT_SCOPE');
  check(Array.isArray(rows) && rows.length <= 1500, 'CONTEXT_BARS_INVALID');
  const bars = rows.map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]) })).filter(b => b.closeTime < now);
  check(bars.length >= 80, 'CONTEXT_BARS_TOO_SHORT');
  check(bars.every((b, i) => Object.values(b).every(Number.isFinite) && b.low > 0 && b.volume >= 0
    && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close)
    && b.openTime % frame.widthMs === 0 && b.closeTime === b.openTime + frame.widthMs - 1
    && (!i || b.openTime === bars[i - 1].openTime + frame.widthMs)), 'CONTEXT_BARS_GAP_OR_SHAPE');
  check(now - bars.at(-1).closeTime <= frame.widthMs + 30000, 'CONTEXT_BARS_STALE');
  let sourceRecovery = null;
  if (checkpoint) {
    check(checkpoint.revision === policy.revision && checkpoint.symbol === symbol && checkpoint.timeframe === timeframe
      && checkpoint.tick === tick && Array.isArray(checkpoint.tail) && checkpoint.tail.length === 80, 'CONTEXT_CHECKPOINT_INCOMPATIBLE');
    const overlap = bars.filter(b => checkpoint.tail.some(old => old.openTime === b.openTime));
    if (!(overlap.length > 0 && overlap.every(b => JSON.stringify(b) === JSON.stringify(checkpoint.tail.find(old => old.openTime === b.openTime))))) {
      const recovered = recoverLatestContextSource(checkpoint, bars, tick);
      checkpoint = recovered.checkpoint; sourceRecovery = recovered.receipt;
    }
    check(bars.at(-1).closeTime >= checkpoint.lastCloseAt, 'CONTEXT_HISTORY_REGRESSED');
  }
  const s = checkpoint ? structuredClone(checkpoint) : newContextState(symbol, timeframe, tick, bars[0].openTime);
  for (const b of bars.filter(b => s.lastCloseAt == null || b.closeTime > s.lastCloseAt)) {
    check(s.lastCloseAt == null || b.openTime === s.lastCloseAt + 1, 'CONTEXT_CHECKPOINT_GAP');
    advanceContextBar(s, b);
  }
  const events = s.events.filter(e => e.at >= now - policy.structureLookbackDays * 86400000);
  return { checkpoint: s, ...(sourceRecovery ? {sourceRecovery} : {}), feature: { timeframe, role: frame.role, status: 'READY', availableAt: s.lastCloseAt,
    coverageStartAt: s.originAt, processedBars: s.processedBars, contextDays: Math.min(policy.structureLookbackDays, (s.lastCloseAt + 1 - s.originAt) / 86400000),
    bias: s.bias, sequence: contextSequence(s.points, tick), protectedPoint: s.protectedPoint,
    externalBoundary: s.externalBoundary, boundaryConsumed: s.externalBoundary ? s.consumed.includes(`${s.externalBoundary.id}:${s.bias === 'BULLISH' ? 'LONG' : 'SHORT'}`) : false,
    episodeId: s.episodeId, geometry: geometry(s.tail), recentEvents: events.slice(-16),
    lastExternalEvent: [...events].reverse().find(e => e.scope === 'EXTERNAL') ?? null,
    lastInternalEvent: [...events].reverse().find(e => e.scope === 'INTERNAL') ?? null,
    lastEvent: events.at(-1) ?? null, checkpointContinued: !!checkpoint } };
}

export function contextRelationship(parent, child) {
  if (parent?.status !== 'READY' || child?.status !== 'READY' || !directional(parent.bias) || !directional(child.sequence?.bias)) return 'UNKNOWN';
  return parent.bias === child.sequence.bias ? 'ALIGNED' : 'CONFLICT';
}

export function assembleStructureContext(frames, now) {
  const dual = Object.keys(frames).length === 2 && frames['4h'] && frames['15m'];
  return { ...(dual ? {timeframeProfile:'SMC-4H15M-1'} : {}), revision: policy.revision, observedAt: now, mode: policy.mode, orderAuthority: false,
    admissionEffect: 'NONE', calibratedWinProbability: null, structureLookbackDays: policy.structureLookbackDays,
    confluencePolicy: policy.confluencePolicy, frames,
    relationships: Object.fromEntries((dual ? ['15m'] : ['1h', '15m', '5m']).map(tf => [tf, contextRelationship(frames['4h'], frames[tf])])) };
}

// Additive data: invalid context cannot be trusted or mutate legacy order inputs.
export function sanitizeStructureContext(raw, now) {
  if (raw == null) return null;
  check(raw.revision === policy.revision && raw.mode === policy.mode && raw.orderAuthority === false
    && raw.admissionEffect === 'NONE' && raw.calibratedWinProbability === null
    && Number.isFinite(raw.observedAt) && raw.observedAt <= now + 5000 && now - raw.observedAt <= 420000, 'CONTEXT_PAYLOAD_SCOPE');
  const frames = {};
  check(raw.timeframeProfile == null || raw.timeframeProfile === 'SMC-4H15M-1', 'CONTEXT_TIMEFRAME_PROFILE');
  const selected = raw.timeframeProfile === 'SMC-4H15M-1' ? ['4h','15m'] : Object.keys(policy.frames);
  for (const tf of selected) { const f=policy.frames[tf];
    const row = raw.frames?.[tf];
    check(row && ['READY', 'UNAVAILABLE'].includes(row.status), 'CONTEXT_FRAME_STATUS');
    if (row.status === 'UNAVAILABLE') { frames[tf] = { timeframe: tf, role: f.role, status: row.status, reason: /^[A-Z0-9_]{1,100}$/.test(row.reason) ? row.reason : 'CONTEXT_UNAVAILABLE' }; continue; }
    check(row.timeframe === tf && row.role === f.role && Number.isFinite(row.availableAt) && row.availableAt < now
      && now - row.availableAt <= f.widthMs + 30000 && Number.isFinite(row.coverageStartAt) && row.coverageStartAt <= row.availableAt
      && ['UNKNOWN', 'TRANSITION', 'BULLISH', 'BEARISH'].includes(row.bias)
      && ['UNKNOWN', 'RANGE', 'BULLISH', 'BEARISH'].includes(row.sequence?.bias)
      && Array.isArray(row.sequence?.labels) && row.sequence.labels.length <= 12
      && row.sequence.labels.every(p => ['HH', 'HL', 'LL', 'LH', 'EQ'].includes(p.label) && p.availableAt <= row.availableAt)
      && (row.externalBoundary == null || (Number.isFinite(row.externalBoundary.price) && row.externalBoundary.price > 0
        && Number.isFinite(row.externalBoundary.confirmedAt) && row.externalBoundary.confirmedAt <= row.availableAt
        && ['HIGH', 'LOW'].includes(row.externalBoundary.kind)))
      && Array.isArray(row.recentEvents) && row.recentEvents.length <= 16
      && row.recentEvents.every(e => e.endpointAvailableAt < e.at - f.widthMs + 1 && e.at <= row.availableAt)
      && row.geometry && Object.values(row.geometry).every(n => n === null || Number.isFinite(n)), 'CONTEXT_FRAME_INVALID');
    // Full event history stays in the durable checkpoint; transport only the
    // current diagnostic evidence, with bounded arrays and no duplicate event.
    frames[tf] = { timeframe: tf, role: f.role, status: row.status, availableAt: row.availableAt,
      coverageStartAt: row.coverageStartAt, processedBars: row.processedBars, contextDays: row.contextDays,
      bias: row.bias, sequence: { bias: row.sequence.bias, counts: row.sequence.counts, labels: row.sequence.labels.slice(-6) },
      protectedPoint: row.protectedPoint, externalBoundary: row.externalBoundary ?? null, boundaryConsumed: row.boundaryConsumed === true, episodeId: row.episodeId, geometry: row.geometry,
      recentEvents: [], lastExternalEvent: row.lastExternalEvent ?? null, lastInternalEvent: row.lastInternalEvent ?? null, lastEvent: row.lastEvent ? { id: row.lastEvent.id, type: row.lastEvent.type,
        direction: row.lastEvent.direction, at: row.lastEvent.at, endpointId: row.lastEvent.endpointId, scope: row.lastEvent.scope, externalBoundaryId: row.lastEvent.externalBoundaryId } : null,
      checkpointContinued: row.checkpointContinued };
  }
  return assembleStructureContext(frames, raw.observedAt);
}

export function externalStructureEvidence(structure) {
  const h = structure?.hierarchy;
  return Boolean(h?.revision === 'SMC-HIERARCHY-1' && h.scope === 'EXTERNAL' && h.externalQualified === true
    && ['BOS', 'TREND_CONFIRMED'].includes(h.event) && h.eventAt === structure.bosAt
    && Number.isFinite(h.endpointAt) && Number.isFinite(h.endpointAvailableAt)
    && h.endpointAt < h.endpointAvailableAt && h.endpointAvailableAt < h.eventAt - 14400000 + 1
    && h.endpointAt === structure.brokenPivot?.time && h.endpointAvailableAt === structure.brokenPivot?.confirmedAt
    && typeof h.endpointId === 'string' && h.endpointId.endsWith(`:${h.endpointAt}`)
    && typeof h.protectedPointId === 'string' && h.protectedPointId.endsWith(`:${structure.protectedPivot?.time}`));
}

// An N-shaped path does not turn trend establishment into continuation.
export const canonicalExternalEventType = event => event === 'BOS' ? 'BOS' : event === 'TREND_CONFIRMED' ? 'MSS' : event === 'CHOCH' ? 'CHOCH' : 'UNCONFIRMED_BREAK';

export const externalEventRequiresSweep = e => !!e && (e.type === 'CHOCH' || e.type !== 'BOS' && (e.priorBias === 'TRANSITION' || e.priorBias === (e.direction === 'LONG' ? 'BEARISH' : 'BULLISH')));
