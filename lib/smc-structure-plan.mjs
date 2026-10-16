import { ENTRY_PATH_REVISION, ENTRY_PATH_REVISIONS } from './smc-entry-paths.mjs';
import { TARGET_PATH_REVISION, build4hFvgEvidence, compact4hFvgEvidence, validateCompact4hFvgEvidence, assessTargetPath } from './smc-target-path.mjs';
import { PLAN_RISK_REVISION, validatePlanRiskScope } from './smc-risk-scope.mjs';
import { TARGET_POLICY_REVISION, LEGACY_TARGET_POLICY_REVISION, selectTargetHierarchy, validateTargetBasis } from './smc-target-policy.mjs';
import { smcBars, confirmedSmcPivots, smcStructureBias, smcNetRewardRisk, smcEntryLocationContext, SMC_SCAN_POLICY } from './smc-scanner.mjs';

import { stopSafetyContext, plannedSafeStop, structuralStopBasis, STOP_SAFETY_REVISION } from './smc-stop-safety.mjs';

import { deriveEntryReview, validateEntryReview } from './smc-entry-review.mjs';

import { planFamilyKey, planPriceEvent, requalifyPlanAnchor } from './smc-plan-lifecycle.mjs';
export const STRUCTURE_PLAN_REVISION = 'SMC-STRUCTURE-PLAN-2';
export const OPPORTUNITY_SEARCH_REVISION = 'SMC-OPPORTUNITY-SEARCH-1';
const H4 = 14400000, M15 = 900000;
const round = (value, tick, up = false) => Number(((up ? Math.ceil(value / tick - 1e-8) : Math.floor(value / tick + 1e-8)) * tick).toPrecision(12));
const atr = bars => {
  const from = Math.max(1, bars.length - 14);
  return bars.slice(from).reduce((sum, b, i) => sum + Math.max(b.high - b.low,
    Math.abs(b.high - bars[from + i - 1].close), Math.abs(b.low - bars[from + i - 1].close)), 0) / (bars.length - from);
};
const unswept = (pivot, bars) => !bars.slice(pivot.index + 1).some(b => pivot.kind === 'HIGH' ? b.high >= pivot.price : b.low <= pivot.price);

/** Prospective closed-bar planning, never an admitted candidate or order input.
 * Support/resistance comes from one confirmed swing, not an unrelated old FVG.
 * The closest objective is used even when its cost-adjusted R is unattractive.
 */
export function deriveStructurePlans({ symbol, bars4h, bars15m, tickSize, now, structureContext, bars5m, quote, lifecycleState, discoveryRevision = null, targetPolicyRevision = null, riskScopeRevision = null, entryPolicyRevision = null }) {
  if(entryPolicyRevision!=null && (!ENTRY_PATH_REVISIONS.includes(entryPolicyRevision)||riskScopeRevision!==PLAN_RISK_REVISION)) throw new Error('SMC_ENTRY_POLICY_INVALID');
  if (targetPolicyRevision != null && ![TARGET_POLICY_REVISION, LEGACY_TARGET_POLICY_REVISION].includes(targetPolicyRevision)) throw new Error('TARGET_POLICY_UNSUPPORTED');
  if(riskScopeRevision!=null && (riskScopeRevision!==PLAN_RISK_REVISION || targetPolicyRevision!==TARGET_POLICY_REVISION)) throw new Error('SMC_PLAN_RISK_SCOPE_INVALID');
  const tick = Number(tickSize);
  if (!(tick > 0) || !Number.isFinite(tick)) throw new Error('STRUCTURE_PLAN_TICK_INVALID');
  const h = smcBars(bars4h, H4, now), m = smcBars(bars15m, M15, now);
  const hp = confirmedSmcPivots(h), mp = confirmedSmcPivots(m);
  const close = m.at(-1).close, volatility = atr(m);
  const safetyContext = stopSafetyContext({ symbol, bars15m, tickSize, now, structureContext, bars5m });
  const pathEvidence = entryPolicyRevision===ENTRY_PATH_REVISION ? compact4hFvgEvidence(build4hFvgEvidence({symbol,bars4h,tickSize:tick,now})) : null;
  const plans = [], optionsByDirection = {};
  for (const direction of ['LONG', 'SHORT']) {
    const long = direction === 'LONG', anchorKind = long ? 'LOW' : 'HIGH';
    const anchors = mp.filter(p => p.kind === anchorKind && now - p.confirmedAt <= 3 * 86400000
      && (long ? p.price < close : p.price > close) && Math.abs(p.price / close - 1) <= .12
      && !m.slice(p.index + 1).some(b => long ? b.close < p.price : b.close > p.price))
      .sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close) || b.confirmedAt - a.confirmedAt);
    optionsByDirection[direction] = [];
    for (const anchor of anchors.slice(0, 8)) {
    const family = planFamilyKey({ symbol, direction, anchor, discoveryRevision, targetPolicyRevision, riskScopeRevision, entryPolicyRevision });
    const renewal = requalifyPlanAnchor({ state: lifecycleState, symbol, direction, anchor, bars: m, now, discoveryRevision, targetPolicyRevision, riskScopeRevision, entryPolicyRevision });
    if (renewal.blocked) continue;
    const width = Math.max(volatility * .25, tick * 2);
    const low = round(long ? anchor.price : anchor.price - width, tick);
    const high = round(long ? anchor.price + width : anchor.price, tick, true);
    const entries = [...new Set([round((low + high) / 2, tick), round(long ? low + tick : high - tick, tick)])];
    const trackedScope = renewal.tracked ?? lifecycleState?.records?.[family]?.plan;
    const localScope = {symbol,direction,discoveryRevision,riskScopeRevision,tradeScope:discoveryRevision==='SMC-TIMED-ENTRY-1'?'SMC-TIMED-SCOPE-1':'SMC-PULLBACK-SCOPE-1',anchor,zone:{low,high},
      availableAt:renewal.requalified ? now : trackedScope?.availableAt ?? now};
    // Old discovered plans keep their original scope; do not reclassify an old touch.
    const permitLocal = !trackedScope || trackedScope.tradeScope === localScope.tradeScope || renewal.requalified;
    const zoneStopBasis = structuralStopBasis({context:safetyContext,symbol,direction,entry:long?low:high,now,anchor,tradePlan:riskScopeRevision?localScope:permitLocal?localScope:null});
    const stop = plannedSafeStop({ context: safetyContext, symbol, direction, entry:long?low:high,
      anchor: anchor.price, now, structuralBasis:zoneStopBasis, costModel: SMC_SCAN_POLICY });
    for (const entry of entries) {
    const stopBasis = riskScopeRevision && zoneStopBasis.ready ? {...zoneStopBasis,entryValid:long?entry>zoneStopBasis.point.price:entry<zoneStopBasis.point.price} : zoneStopBasis;
    // Nearest unvisited opposing liquidity beyond both entry and current close.
    // Never move the objective farther away just to manufacture >=2R.
    const targets = [...hp.map(p => ({ ...p, timeframe: '4H', bars: h })),
      ...mp.map(p => ({ ...p, timeframe: '15M', bars: m }))]
      .filter(p => p.kind !== anchorKind && unswept(p, p.bars) && (!targetPolicyRevision || !m.some(b => b.openTime > p.time && (long ? b.high >= p.price : b.low <= p.price)))
        && (long ? p.price - tick * 2 > Math.max(entry, close) : p.price + tick * 2 < Math.min(entry, close)))
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry) || b.confirmedAt - a.confirmedAt);
    let objective = targets[0];
    const tracked = renewal.tracked ?? lifecycleState?.records?.[family]?.plan;
    let targetBasis = null;
    if (targetPolicyRevision) {
      const selected = selectTargetHierarchy({targets, frame:structureContext?.frames?.['4h'],localFrame:structureContext?.frames?.['15m'],direction,entry,now,tracked,revision:targetPolicyRevision});
      if (selected.invalid) continue;
      objective = selected.objective; targetBasis = selected.basis;
    } else if (tracked?.target != null) {
      const prior = targets.find(p => round(p.price + (long ? -tick * 2 : tick * 2), tick, !long) === tracked.target);
      if (!prior) continue;
      objective = prior;
    }
    const target = objective ? round(objective.price + (long ? -tick * 2 : tick * 2), tick, !long) : null;
    const targetPath = pathEvidence ? assessTargetPath({evidence:pathEvidence,direction,entry,stop,referenceTarget:target,tickSize:tick,now}) : null;
    const protectionConfirmed=stopBasis.ready && stopBasis.entryValid!==false;
    const admissionTarget=pathEvidence?targetPath.admissionTarget:target;
    const rr = admissionTarget == null || pathEvidence&&!protectionConfirmed ? null : smcNetRewardRisk({ direction, entry, stop, target:admissionTarget });
    const frames = structureContext?.frames ?? {}, dual = structureContext?.timeframeProfile === 'SMC-4H15M-1';
    const biases = Object.fromEntries((dual ? ['4h','15m'] : ['4h', '1h', '15m', '5m']).map(tf => [tf,
      frames[tf]?.status === 'READY' ? frames[tf].bias : tf === '4h' ? smcStructureBias(hp) : tf === '15m' ? smcStructureBias(mp) : 'UNAVAILABLE']));
    const expected = long ? 'BULLISH' : 'BEARISH';
    const sequenceBias = frames['15m']?.sequence?.bias ?? smcStructureBias(mp);
    const previous = mp.filter(p => p.kind === anchorKind && p.time < anchor.time).at(-1);
    const label = !previous ? 'UNKNOWN' : long ? (anchor.price > previous.price ? 'HL' : anchor.price < previous.price ? 'LL' : 'EQ')
      : (anchor.price < previous.price ? 'LH' : anchor.price > previous.price ? 'HH' : 'EQ');
    const continuation = sequenceBias === expected && label === (long ? 'HL' : 'LH');
    const pattern = continuation ? 'TREND_CONTINUATION' : sequenceBias === expected ? 'LOCAL_RECOVERY'
      : ['BULLISH','BEARISH'].includes(sequenceBias) ? 'COUNTER_SEQUENCE' : 'RANGE_RETEST';
    const unknownFrames = Object.entries(biases).filter(([,b]) => !['BULLISH','BEARISH'].includes(b)).map(([tf]) => tf);
    const localConflict = ['BULLISH','BEARISH'].includes(sequenceBias) && sequenceBias !== expected;
    const location = smcEntryLocationContext({ bars: m, direction, referenceEntry: entry });
    const conflicts = Object.entries(biases).filter(([, bias]) => ['BULLISH', 'BEARISH'].includes(bias) && bias !== expected).map(([tf]) => tf);
    const blockers = [(!stopBasis.ready || stopBasis.entryValid === false) ? 'STRUCTURAL_STOP_UNCONFIRMED' : null, localConflict ? 'LOCAL_SEQUENCE_CONFLICT' : null, unknownFrames.length && !(targetPolicyRevision===TARGET_POLICY_REVISION && targetBasis?.directionSupport?.mode) ? 'CONTEXT_NOT_CONFIRMED' : null,
      !location.ready && !continuation ? 'WAIT_VALUE_LOCATION' : null, !target ? 'NO_UNSWEPT_STRUCTURE_TARGET' : !rr?.qualified ? 'NET_R_BELOW_2' : null,
      conflicts.length && !(targetPolicyRevision===TARGET_POLICY_REVISION && targetBasis?.directionSupport?.mode==='15M_CONFIRMED_TRANSITION') ? 'TIMEFRAME_DIRECTION_CONFLICT' : null, pathEvidence&&!targetPath.ready&&targetPath.admissionTarget==null?'TARGET_PATH_UNCONFIRMED':null, 'WAIT_FULL_SCANNER_ADMISSION'].filter(Boolean);
    const proposal = { id: `${STRUCTURE_PLAN_REVISION}:${symbol}:${direction}:${anchor.time}${discoveryRevision === 'SMC-TIMED-ENTRY-1' ? ':TIME1' : ''}${targetPolicyRevision === TARGET_POLICY_REVISION ? ':HTF2' : targetPolicyRevision ? ':HTF1' : ''}${riskScopeRevision ? ':RISK1' : ''}${entryPolicyRevision === ENTRY_PATH_REVISION ? ':PATH2' : entryPolicyRevision ? ':PATH1' : ''}${renewal.generation ? `:R2:${renewal.generation}` : ''}`, revision: STRUCTURE_PLAN_REVISION,
      symbol, direction, discoveryRevision, ...(pathEvidence ? {targetPathRevision:TARGET_PATH_REVISION,targetPathEvidence:pathEvidence,targetPath} : {}), ...(entryPolicyRevision ? {entryPolicyRevision} : {}), ...(riskScopeRevision ? {riskScopeRevision} : {}), ...(targetPolicyRevision ? { targetPolicyRevision, targetBasis } : {}), ...(dual ? {timeframeProfile:'SMC-4H15M-1'} : {}), model: 'CONFIRMED_15M_SWING_RETEST', status: 'CONDITIONAL_STRUCTURE_PLAN',
      lifecyclePolicy: 2, lifecycleGeneration: renewal.generation ?? null, supersedesPlanId: renewal.supersedesPlanId ?? tracked?.supersedesPlanId ?? null,
      observedAt: now, availableAt: renewal.requalified ? now : tracked?.availableAt ?? now, expiresAt: m.at(-1).closeTime + M15 + 30000,
      zone: { kind: long ? 'SWING_SUPPORT' : 'SWING_RESISTANCE', low, high, ce: entry },
      entry, stop, target, tickSize: tick, netR: rr?.netR ?? null, riskPerUnit: rr?.riskPerUnit ?? null,
      stopSafetyRevision: safetyContext.revision, stopBasis,
      tradeScope: ['LOCAL_PULLBACK_INVALIDATION','LOCAL_TIMED_INVALIDATION'].includes(stopBasis.kind) ? localScope.tradeScope : null,
      anchor: { kind: anchor.kind, price: anchor.price, time: anchor.time, confirmedAt: anchor.confirmedAt, timeframe: '15M' },
      objective: objective ? { kind: objective.kind, price: objective.price, time: objective.time,
        confirmedAt: objective.confirmedAt, timeframe: objective.timeframe } : null,
      biases, conflicts, blockers, stopBufferAtr: .2, entryZoneAtr: .25,
      winProbability: null, executionQualified: false, orderAuthority: false,
      promotion: 'EXISTING_SCANNER_ADMISSION_REQUIRED', automaticEntryAllowed: false };
    proposal.entryReview = deriveEntryReview(proposal, { bars5m, bars15m, quote, now, atr15: volatility });
    proposal.opportunity = { revision: OPPORTUNITY_SEARCH_REVISION, pattern, anchorLabel: label, sequenceBias,
      unknownFrames, localConflict, location, continuationAtPremium: continuation && !location.ready,
      comparedAnchors: Math.min(8, anchors.length), comparedEntries: 0, alternatives: [] };
    if (!planPriceEvent(proposal, { quote, bars: [...m], now })) optionsByDirection[direction].push(proposal);
    }
    }
    const choices = optionsByDirection[direction];
    choices.sort((a,b) => Number(b.stopBasis.ready && b.stopBasis.entryValid !== false) - Number(a.stopBasis.ready && a.stopBasis.entryValid !== false)
      || Number(!!b.targetBasis?.directionSupport?.mode) - Number(!!a.targetBasis?.directionSupport?.mode)
      || (entryPolicyRevision ? Number(b.entryReview.timing.ready && b.netR>=2)-Number(a.entryReview.timing.ready && a.netR>=2) : 0)
      || Number(b.opportunity.pattern === 'TREND_CONTINUATION') - Number(a.opportunity.pattern === 'TREND_CONTINUATION')
      || Number(a.opportunity.localConflict) - Number(b.opportunity.localConflict)
      || Number(b.netR >= 2) - Number(a.netR >= 2)
      || Number(b.entryReview.timing.ready) - Number(a.entryReview.timing.ready)
      || (b.netR ?? -Infinity) - (a.netR ?? -Infinity)
      || Math.abs(a.entry - close) - Math.abs(b.entry - close));
    if (choices[0]) {
      const winner = choices[0];
      winner.opportunity.comparedEntries = choices.length;
      winner.opportunity.alternatives = choices.slice(0, 16).map(p => ({ anchorAt: p.anchor.time, entry: p.entry, stop: p.stop, target: p.targetPathRevision?p.targetPath.admissionTarget:p.target, netR: p.netR, pattern: p.opportunity.pattern, ...(p.targetPathRevision?{referenceTarget:p.target,protectionConfirmed:p.stopBasis.ready&&p.stopBasis.entryValid!==false}:{}) }));
      plans.push(winner);
    }
  }
  return plans;
}

export function sanitizeStructurePlans(rows, symbol, now) {
  if (rows == null) return [];
  if (!Array.isArray(rows) || rows.length > 2) throw new Error('STRUCTURE_PLANS_INVALID');
  if (new Set(rows.map(p => p.direction)).size !== rows.length) throw new Error('STRUCTURE_PLAN_DUPLICATE');
  return rows.map(p => {
    const long = p.direction === 'LONG';
    if (!['SMC-STRUCTURE-PLAN-1', STRUCTURE_PLAN_REVISION].includes(p.revision) || p.symbol !== symbol || !['LONG', 'SHORT'].includes(p.direction)
      || p.model !== 'CONFIRMED_15M_SWING_RETEST' || p.status !== 'CONDITIONAL_STRUCTURE_PLAN'
      || p.orderAuthority !== false || p.executionQualified !== false || p.automaticEntryAllowed !== false
      || p.promotion !== 'EXISTING_SCANNER_ADMISSION_REQUIRED' || p.winProbability !== null
      || ![p.entry, p.stop, p.tickSize, p.zone?.low, p.zone?.high, p.anchor?.price].every(n => Number.isFinite(n) && n > 0)
      || p.zone.kind !== (long ? 'SWING_SUPPORT' : 'SWING_RESISTANCE') || p.zone.ce !== p.entry
      || !(p.zone.low <= p.entry && p.entry <= p.zone.high && p.zone.low < p.zone.high)
      || !(long ? p.stop < p.zone.low : p.stop > p.zone.high)
      || p.anchor?.timeframe !== '15M' || p.anchor?.kind !== (long ? 'LOW' : 'HIGH')
      || ![p.observedAt, p.availableAt, p.expiresAt, p.anchor?.time, p.anchor?.confirmedAt].every(Number.isFinite)
      || p.anchor.time >= p.anchor.confirmedAt || p.anchor.confirmedAt > p.availableAt || p.availableAt > p.observedAt
      || p.observedAt > now + 5000 || now - p.observedAt > 360000 || p.expiresAt <= now
      || !Array.isArray(p.blockers) || p.blockers.length > 10 || !p.blockers.includes('WAIT_FULL_SCANNER_ADMISSION')
      || p.blockers.some(b => !['STRUCTURAL_STOP_UNCONFIRMED', 'NO_UNSWEPT_STRUCTURE_TARGET', 'NET_R_BELOW_2', 'TIMEFRAME_DIRECTION_CONFLICT', 'WAIT_FULL_SCANNER_ADMISSION', 'LOCAL_SEQUENCE_CONFLICT', 'CONTEXT_NOT_CONFIRMED', 'WAIT_VALUE_LOCATION', 'TARGET_PATH_UNCONFIRMED'].includes(b))
      || typeof p.id !== 'string' || !p.id.startsWith(`${p.revision}:${symbol}:${p.direction}:`)) throw new Error('STRUCTURE_PLAN_SCOPE');
    if (['SMC-STOP-SAFETY-2', STOP_SAFETY_REVISION].includes(p.stopSafetyRevision)) {
      const basis=p.stopBasis;
      if (!basis || typeof basis.ready !== 'boolean' || !['4h','1h','15m'].includes(basis.timeframe)
        || ((!basis.ready || basis.entryValid === false) && !p.blockers.includes('STRUCTURAL_STOP_UNCONFIRMED')))
        throw new Error('STRUCTURE_PLAN_STOP_BASIS');
      if (basis.kind === 'LOCAL_PULLBACK_INVALIDATION' && (basis.scopeRevision !== 'SMC-PULLBACK-SCOPE-1'
        || !basis.parentEpisodeId || ['kind','price','time','confirmedAt'].some(k=>basis.point?.[k]!==p.anchor[k]))) throw new Error('STRUCTURE_PLAN_LOCAL_PROOF');
      if (basis.kind === 'LOCAL_TIMED_INVALIDATION' && (basis.scopeRevision !== 'SMC-TIMED-SCOPE-1' || p.discoveryRevision !== 'SMC-TIMED-ENTRY-1'
        || ['kind','price','time','confirmedAt'].some(k=>basis.point?.[k]!==p.anchor[k]))) throw new Error('STRUCTURE_PLAN_TIMED_PROOF');
      if ((basis.kind === 'LOCAL_TIMED_INVALIDATION') !== (p.tradeScope === 'SMC-TIMED-SCOPE-1')) throw new Error('STRUCTURE_PLAN_TIMED_SCOPE');
      if ((basis.kind === 'LOCAL_PULLBACK_INVALIDATION') !== (p.tradeScope === 'SMC-PULLBACK-SCOPE-1')) throw new Error('STRUCTURE_PLAN_STOP_SCOPE');
      if (basis.ready && (!['EXTERNAL_PROTECTION','LOCAL_RANGE_SWING','LOCAL_PULLBACK_INVALIDATION','LOCAL_TIMED_INVALIDATION','MAIN_15M_PROTECTION'].includes(basis.kind)
        || basis.point?.kind !== (long?'LOW':'HIGH') || !Number.isFinite(basis.point.price) || basis.point.price<=0
        || !Number.isFinite(basis.point.confirmedAt) || !Number.isFinite(basis.availableAt)
        || basis.point.confirmedAt>basis.availableAt || basis.availableAt>p.observedAt
        || !Number.isFinite(basis.buffer) || basis.buffer<=0
        || (long?p.stop>basis.point.price-basis.buffer+1e-8:p.stop<basis.point.price+basis.buffer-1e-8)))
        throw new Error('STRUCTURE_PLAN_STOP_BASIS');
    }
    const pathV2=p.entryPolicyRevision===ENTRY_PATH_REVISION;
    if(pathV2){
      if(p.targetPathRevision!==TARGET_PATH_REVISION||p.targetPathEvidence?.symbol!==symbol||p.targetPathEvidence?.observedAt!==p.observedAt)throw new Error('STRUCTURE_PLAN_TARGET_PATH_SCOPE');
      validateCompact4hFvgEvidence(p.targetPathEvidence,now);
      const expected=assessTargetPath({evidence:p.targetPathEvidence,direction:p.direction,entry:p.entry,stop:p.stop,referenceTarget:p.target,tickSize:p.tickSize,now:p.observedAt});
      if(JSON.stringify(expected)!==JSON.stringify(p.targetPath))throw new Error('STRUCTURE_PLAN_TARGET_PATH_MISMATCH');
      const net=p.stopBasis.ready&&p.stopBasis.entryValid!==false?expected.netR:null;
      if(p.netR!==net || p.riskPerUnit!==(net===null?null:smcNetRewardRisk({...p,target:expected.admissionTarget}).riskPerUnit))throw new Error('STRUCTURE_PLAN_TARGET_PATH_R');
    }else if(p.targetPathRevision!=null)throw new Error('STRUCTURE_PLAN_TARGET_PATH_POLICY');
    if (p.target !== null) {
      const rr = pathV2 ? {netR:p.netR,qualified:p.netR>=2} : smcNetRewardRisk(p);
      if (!Number.isFinite(p.target) || !p.objective || !Number.isFinite(p.objective.confirmedAt) || p.objective.confirmedAt > p.availableAt
        || !['4H', '15M'].includes(p.objective.timeframe) || p.objective.kind !== (long ? 'HIGH' : 'LOW')
        || Math.abs(Math.abs(p.target - p.objective.price) - p.tickSize * 2) > Math.max(1e-8, p.tickSize * 1e-7)
        || !(long ? p.entry < p.target : p.target < p.entry)
        || (p.netR === null ? rr.netR !== null : !Number.isFinite(p.netR) || Math.abs(rr.netR - p.netR) > 1e-8)
        || (!rr.qualified && !p.blockers.includes('NET_R_BELOW_2'))) throw new Error('STRUCTURE_PLAN_GEOMETRY');
    } else if ((!pathV2 && p.netR !== null) || p.objective !== null || !p.blockers.includes('NO_UNSWEPT_STRUCTURE_TARGET')) throw new Error('STRUCTURE_PLAN_TARGET');
    if (p.revision === STRUCTURE_PLAN_REVISION) {
      const o = p.opportunity;
      if (o?.revision !== OPPORTUNITY_SEARCH_REVISION || !['TREND_CONTINUATION','LOCAL_RECOVERY','COUNTER_SEQUENCE','RANGE_RETEST'].includes(o.pattern)
        || !Array.isArray(o.unknownFrames) || typeof o.localConflict !== 'boolean' || typeof o.continuationAtPremium !== 'boolean'
        || !Number.isInteger(o.comparedAnchors) || o.comparedAnchors < 1 || o.comparedAnchors > 8
        || !Number.isInteger(o.comparedEntries) || o.comparedEntries < 1 || o.comparedEntries > 16
        || !Array.isArray(o.alternatives) || o.alternatives.length > 16
        || o.alternatives.some(a => !Number.isFinite(a.anchorAt) || !Number.isFinite(a.entry) || !Number.isFinite(a.stop)
          || a.target !== null && (!Number.isFinite(a.target) || !(pathV2&&a.protectionConfirmed===false&&a.netR===null) && Math.abs(smcNetRewardRisk({ ...a, direction: p.direction }).netR - a.netR) > 1e-8))) throw new Error('STRUCTURE_PLAN_OPPORTUNITY');
    }
    if(p.entryPolicyRevision!=null && (!ENTRY_PATH_REVISIONS.includes(p.entryPolicyRevision)||p.riskScopeRevision!==PLAN_RISK_REVISION)) throw new Error('SMC_ENTRY_POLICY_INVALID');
    validateTargetBasis(p);
    validateEntryReview(p, now);
    validatePlanRiskScope(p);
    return p;
  });
}
