import { PLAN_RISK_REVISION, main15mStopBasis } from './smc-risk-scope.mjs';
import { localTimedBasis, validateTimedScopeTrigger } from './smc-timed-scope.mjs';
import { localPullbackBasis, validateLocalPullbackTrigger } from './smc-pullback-scope.mjs';
// Prospective protective policy, not a fitted win-probability model.
export const STOP_SAFETY_REVISION = 'SMC-STOP-SAFETY-3';
export const STOP_SLIPPAGE_BPS = 10;
const M15 = 900000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const q75 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .75) - 1];

export function stopSafetyContext({ symbol, bars15m, tickSize, now, structureContext, structureFrames, bars5m, scopeBars15m, parentFrame, localFrame, timeframeProfile }) {
  check(Array.isArray(bars15m) && bars15m.length <= 1500, 'SMC_STOP_CONTEXT_MISSING');
  const rows = bars15m.filter(b => Number(b[6]) < now).slice(-80);
  check(rows.length === 80 && Number(tickSize) > 0, 'SMC_STOP_CONTEXT_MISSING');
  check(rows.every((b, i) => b.slice(0, 7).every(v => Number.isFinite(Number(v)))
    && Number(b[0]) % M15 === 0 && Number(b[6]) === Number(b[0]) + M15 - 1
    && Number(b[5]) >= 0 && Number(b[3]) > 0 && Number(b[2]) >= Math.max(Number(b[1]), Number(b[4]))
    && Number(b[3]) <= Math.min(Number(b[1]), Number(b[4]))
    && (!i || Number(b[0]) === Number(rows[i - 1][0]) + M15)), 'SMC_STOP_CONTEXT_GAP');
  check(now - Number(rows.at(-1)[6]) <= M15 + 30000, 'SMC_STOP_CONTEXT_STALE');
  const profile = timeframeProfile ?? structureContext?.timeframeProfile;
  check(profile == null || profile === 'SMC-4H15M-1','SMC_STOP_PROFILE_INVALID');
  const selected = profile === 'SMC-4H15M-1' ? ['4h','15m'] : ['4h','1h','15m'];
  const frames = structureFrames ?? (structureContext ? Object.fromEntries(selected.map(tf => {
    const f = structureContext.frames?.[tf];
    return [tf, f ? { status:f.status, bias:f.bias, availableAt:f.availableAt,
      protectedPoint:f.protectedPoint ?? null, atr:f.geometry?.atr ?? null } : {status:'UNAVAILABLE'}];
  })) : null);
  return { ...(profile ? {timeframeProfile:profile} : {}), revision: STOP_SAFETY_REVISION, symbol, observedAt: now, tickSize: Number(tickSize), bars15m: rows, structureFrames: frames, scopeBars15m: (scopeBars15m ?? bars15m).filter(b => Number(b[6]) < now).slice(-320).map(b=>b.slice(0,7).map(Number)), bars5m: Array.isArray(bars5m) ? bars5m.filter(b=>Number(b[6])<now).slice(-80).map(b=>b.slice(0,7).map(Number)) : null, parentFrame: parentFrame ?? structureContext?.frames?.['4h'] ?? null, localFrame: localFrame ?? structureContext?.frames?.['15m'] ?? null };
}

export function stopSafetyMetrics(context, symbol, now) {
  check(context?.revision === STOP_SAFETY_REVISION && context.symbol === symbol
    && Number.isFinite(context.observedAt) && now - context.observedAt >= -5000
    && now - context.observedAt <= 360000, 'SMC_STOP_CONTEXT_STALE');
  const c = stopSafetyContext({ ...context, now }), rows = c.bars15m;
  const tr = rows.slice(1).map((b, i) => Math.max(Number(b[2]) - Number(b[3]),
    Math.abs(Number(b[2]) - Number(rows[i][4])), Math.abs(Number(b[3]) - Number(rows[i][4]))));
  const atr15m = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const noiseDistance = Math.max(atr15m, q75(tr.slice(-64)), c.tickSize * 2);
  const pools = [];
  for (let i = 2; i < rows.length - 2; i++) for (const [kind, field] of [['LOW', 3], ['HIGH', 2]]) {
    const price = Number(rows[i][field]);
    if ([i - 2, i - 1, i + 1, i + 2].every(n => kind === 'LOW' ? price < Number(rows[n][field]) : price > Number(rows[n][field]))
      && rows.slice(i + 1).every(b => kind === 'LOW' ? Number(b[3]) > price : Number(b[2]) < price))
      pools.push({ kind, price, time: Number(rows[i][0]), confirmedAt: Number(rows[i + 2][6]) });
  }
  check(atr15m > 0 && Number.isFinite(noiseDistance), 'SMC_STOP_CONTEXT_INVALID');
  return { atr15m, noiseDistance, pools, closedAt: Number(rows.at(-1)[6]), tickSize: c.tickSize };
}

// Source selection is independent of target, reward/risk, and entry ranking.
// The highest confirmed same-direction external protection remains authoritative.
export function structuralStopBasis({ context, symbol, direction, entry, now, anchor = null, tradePlan = null }) {
  const m = stopSafetyMetrics(context, symbol, now), long = direction === 'LONG';
  const expected = long ? 'BULLISH' : 'BEARISH', kind = long ? 'LOW' : 'HIGH';
  if (tradePlan?.riskScopeRevision != null) {
    check(tradePlan.riskScopeRevision === PLAN_RISK_REVISION,'SMC_PLAN_RISK_SCOPE_INVALID');
    return main15mStopBasis(context.localFrame,direction,entry,now,Math.max(.2*m.atr15m,m.tickSize*2));
  }
  const local = tradePlan && (localTimedBasis({context,plan:tradePlan,now,buffer:Math.max(.2*m.atr15m,m.tickSize*2)})
    ?? localPullbackBasis({context,plan:tradePlan,now,buffer:Math.max(.2*m.atr15m,m.tickSize*2)}));
  if (local?.ready) return {...local, entryValid:long?entry>=local.point.price:entry<=local.point.price};
  const widths = context.timeframeProfile === 'SMC-4H15M-1' ? {'4h':14400000,'15m':900000} : {'4h':14400000,'1h':3600000,'15m':900000};
  for (const [timeframe,width] of Object.entries(widths)) {
    const f = context.structureFrames?.[timeframe];
    if (f?.status !== 'READY' || !['BULLISH','BEARISH','TRANSITION','RANGE'].includes(f.bias)
      || !Number.isFinite(f.availableAt) || f.availableAt > now || now-f.availableAt > width+120000)
      return {ready:false, reason:'SMC_STOP_STRUCTURE_UNAVAILABLE', timeframe};
    if (f.bias !== expected) continue;
    const p = f.protectedPoint;
    if (!p || p.kind !== kind || !Number.isFinite(p.price) || p.price<=0
      || !Number.isFinite(p.confirmedAt) || p.confirmedAt > f.availableAt)
      return {ready:false,reason:'SMC_STOP_STRUCTURE_UNAVAILABLE',timeframe};
    return {ready:true, reason:null, timeframe, kind:'EXTERNAL_PROTECTION', point:p, entryValid:long?entry>p.price:entry<p.price,
      buffer:Math.max(.2*m.atr15m,m.tickSize*2), availableAt:f.availableAt};
  }
  // A range retest has no directional parent. Use a confirmed local swing,
  // explicitly identified as local; it does not invent a higher-TF thesis.
  const pool = anchor ?? m.pools.filter(p=>p.kind===kind && (long?p.price<entry:p.price>entry))
    .sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry))[0];
  return pool && pool.kind===kind && Number.isFinite(pool.price) && Number.isFinite(pool.confirmedAt) && pool.confirmedAt<=now
    ? {ready:true,reason:null,timeframe:'15m',kind:'LOCAL_RANGE_SWING',point:pool,
      buffer:Math.max(.2*m.atr15m,m.tickSize*2),availableAt:m.closedAt}
    : {ready:false,reason:'SMC_STOP_STRUCTURE_UNAVAILABLE',timeframe:'15m'};
}

export function evaluateStopSafety({ context, symbol, direction, entry, stop, bid, ask, tick, riskCostPerUnit = 0, now, tradePlan = null }) {
  try {
    const m = stopSafetyMetrics(context, symbol, now), long = direction === 'LONG';
    check(['LONG', 'SHORT'].includes(direction) && [entry, stop, bid, ask, tick, riskCostPerUnit].every(Number.isFinite)
      && entry > 0 && stop > 0 && bid > 0 && ask >= bid && tick > 0 && riskCostPerUnit >= 0, 'SMC_STOP_GEOMETRY_INVALID');
    const distance = long ? entry - stop : stop - entry;
    const liveDistance = long ? Math.min(bid, tick) - stop : stop - Math.max(ask, tick);
    const requiredDistance = Math.max(m.noiseDistance, 3 * (ask - bid), m.tickSize * 2, riskCostPerUnit);
    const buffer = Math.max(.2 * m.atr15m, m.tickSize * 2);
    const adversePools = m.pools.filter(p => p.kind === (long ? 'LOW' : 'HIGH')
      && (long ? p.price < entry : p.price > entry) && Math.abs(p.price - entry) <= requiredDistance + .5 * m.atr15m);
    const insidePool = adversePools.some(p => long ? stop > p.price - buffer + 1e-10 : stop < p.price + buffer - 1e-10);
    const basis = structuralStopBasis({context, symbol, direction, entry, now, tradePlan});
    if (tradePlan?.tradeScope === 'SMC-PULLBACK-SCOPE-1') {
      check(basis.kind === 'LOCAL_PULLBACK_INVALIDATION', 'SMC_LOCAL_SCOPE_UNCONFIRMED');
      check(validateLocalPullbackTrigger(tradePlan, context, now), 'SMC_LOCAL_TRIGGER_UNCONFIRMED');
    }
    if (tradePlan?.tradeScope === 'SMC-TIMED-SCOPE-1') {
      check(basis.kind === 'LOCAL_TIMED_INVALIDATION', 'SMC_TIMED_SCOPE_UNCONFIRMED');
      check(validateTimedScopeTrigger(tradePlan, context, now), 'SMC_TIMED_TRIGGER_UNCONFIRMED');
    }
    const structuralUnsafe = basis.ready && (long ? stop > basis.point.price-basis.buffer+1e-10 : stop < basis.point.price+basis.buffer-1e-10);
    const reason = liveDistance < Math.max(m.tickSize * 2, 3 * (ask - bid)) - 1e-10 ? 'SMC_STOP_LIVE_TOO_CLOSE'
      : distance < requiredDistance - Math.max(1e-10, m.tickSize * 1e-7) ? 'SMC_STOP_NOISE_UNSAFE'
        : !basis.ready ? basis.reason : basis.entryValid === false ? 'SMC_STOP_ENTRY_BEYOND_STRUCTURE' : structuralUnsafe ? 'SMC_STOP_INSIDE_STRUCTURE'
          : insidePool ? 'SMC_STOP_INSIDE_LIQUIDITY' : null;
    return { revision: STOP_SAFETY_REVISION, ready: !reason, reason, distance, liveDistance, requiredDistance,
      stopDistanceATR: distance / m.atr15m, noiseDistance: m.noiseDistance, atr15m: m.atr15m,
      riskCostPerUnit, structuralBasis:basis, adversePools, closedAt: m.closedAt, stopSlippageBps: STOP_SLIPPAGE_BPS };
  } catch (e) { return { revision: STOP_SAFETY_REVISION, ready: false, reason: e.message }; }
}

export function plannedSafeStop({ context, symbol, direction, entry, anchor, now, structuralBasis, costModel = { feeBpsPerSide: 5, slippageBpsPerSide: 3, fundingReserveBps: 2, stopSlippageBps: STOP_SLIPPAGE_BPS } }) {
  const m = stopSafetyMetrics(context, symbol, now), long = direction === 'LONG';
  const buffer = Math.max(.2 * m.atr15m, m.tickSize * 2);
  const pools = m.pools.filter(p => p.kind === (long ? 'LOW' : 'HIGH')
    && (long ? p.price < entry : p.price > entry) && Math.abs(p.price - entry) <= m.noiseDistance + .5 * m.atr15m);
  const r = (costModel.feeBpsPerSide + costModel.slippageBpsPerSide) / 10000;
  const x = Math.max(0, costModel.stopSlippageBps - costModel.slippageBpsPerSide) / 10000;
  const f = costModel.fundingReserveBps / 10000;
  check([r, x, f].every(v => Number.isFinite(v) && v >= 0) && r + x < 1, 'SMC_STOP_COST_INVALID');
  // Solve D >= C(E,S): S=E-D for long, S=E+D for short.
  const costFloor = entry * (2 * r + x + f) / (long ? 1 + r + x : 1 - r - x);
  const basis = structuralBasis ?? structuralStopBasis({context,symbol,direction,entry,now});
  const structure = basis.ready ? basis.point.price : anchor;
  const raw = long ? Math.min(structure - buffer, anchor - buffer, entry - Math.max(m.noiseDistance, costFloor), ...pools.map(p => p.price - buffer))
    : Math.max(structure + buffer, anchor + buffer, entry + Math.max(m.noiseDistance, costFloor), ...pools.map(p => p.price + buffer));
  const stop = (long ? Math.floor(raw / m.tickSize + 1e-8) : Math.ceil(raw / m.tickSize - 1e-8)) * m.tickSize;
  check(stop > 0, 'SMC_STOP_GEOMETRY_INVALID');
  return Number(stop.toPrecision(12));
}
