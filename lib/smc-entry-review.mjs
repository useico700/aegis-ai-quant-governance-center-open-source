import { assessTargetPath } from './smc-target-path.mjs';
import {entryPath15m} from './smc-entry-paths.mjs';
import {reviewRetestTiming} from './smc-retest-timing.mjs';
import {reaction15m} from './smc-15m-reaction.mjs';
export {reviewRetestTiming};
import { smcNetRewardRisk, SMC_SCAN_POLICY as policy } from './smc-scanner.mjs';

import { STOP_SLIPPAGE_BPS } from './smc-stop-safety.mjs';

export const ENTRY_REVIEW_REVISION = 'SMC-ENTRY-REVIEW-2';
const M5 = 300000;
const round = (value, tick, up) => Number(((up ? Math.ceil(value / tick - 1e-8) : Math.floor(value / tick + 1e-8)) * tick).toPrecision(12));

/** Screening costs, not a promise of fill or stop execution. Recompute for each price. */
export function reviewEntryGeometry(plan, entry, atr15) {
  const { direction, stop, tickSize: tick, zone } = plan, long = direction === 'LONG';
  const path=plan.targetPathRevision ? assessTargetPath({evidence:plan.targetPathEvidence,direction,entry,stop,referenceTarget:plan.target,tickSize:tick,now:plan.observedAt}) : null;
  const protection= !plan.targetPathRevision || plan.stopBasis?.ready && plan.stopBasis.entryValid!==false && (long?entry>plan.stopBasis.point.price:entry<plan.stopBasis.point.price);
  const target=plan.targetPathRevision?path.admissionTarget:plan.target;
  const valid = protection && Number.isFinite(entry) && entry > 0 && (long ? entry > stop : entry < stop)
    && target != null && (long ? target > entry : target < entry);
  const distance = Number.isFinite(entry) ? Math.abs(entry - stop) : null;
  const rr = valid ? smcNetRewardRisk({ direction, entry, stop, target }) : null;
  const rate = (policy.feeBpsPerSide + policy.slippageBpsPerSide) / 10000, funding = policy.fundingReserveBps / 10000;
  const stopStress = Math.max(0, STOP_SLIPPAGE_BPS - policy.slippageBpsPerSide) / 10000;
  const cost = rr ? (entry + stop) * rate + entry * funding + stop * stopStress : null;
  const boundary = target == null ? null : long
    ? ((1 - rate) * target + 2 * (1 - rate - stopStress) * stop) / (3 * (1 + rate + funding))
    : ((1 + rate) * target + 2 * (1 + rate + stopStress) * stop) / (3 * (1 - rate - funding));
  const thresholdEntry = boundary == null ? null : round(boundary, tick, !long);
  const feasibleThreshold = protection && thresholdEntry != null && (long ? thresholdEntry > stop && thresholdEntry < target : thresholdEntry < stop && thresholdEntry > target);
  const flags = [target != null && !feasibleThreshold ? 'NO_FEASIBLE_2R_ENTRY' : null, !valid ? 'INVALID_PRICE_GEOMETRY' : null,
    entry < zone.low || entry > zone.high ? 'OUTSIDE_PLANNED_ZONE' : null,
    rr && !rr.qualified ? 'NET_R_BELOW_2' : null,
    distance != null && distance < atr15 ? 'STOP_DISTANCE_LT_15M_ATR' : null,
    cost != null && cost >= distance ? 'COST_DOMINATES_STOP_DISTANCE' : null].filter(Boolean);
  return { entry, valid, netR: rr?.netR ?? null, netRThresholdMet: rr?.qualified ?? false,
    riskPerUnit: rr?.riskPerUnit ?? null, stopDistance: distance, stopDistanceATR: distance == null || atr15 <= 0 ? null : distance / atr15,
    riskCostPerUnit: cost, riskCostShare: Number.isFinite(cost) && Number.isFinite(rr?.riskPerUnit) && rr.riskPerUnit > 0 ? cost / rr.riskPerUnit : null,
    entryFor2R: feasibleThreshold ? thresholdEntry : null, flags, ...(path?{targetPath:path,admissionTarget:target}:{}) };
}

/** Closed 5M retest + rejection + actual crossing of a previously confirmed pivot.
 * Reuses existing v13 body/range/location and twenty-minute evidence-age settings.
 * This is recognition only; it cannot replace 15M/full scanner/order admission.
 */

export function deriveEntryReview(plan, { bars5m, bars15m, quote, now, atr15 }) {
  const bid = Number(quote?.bidPrice), ask = Number(quote?.askPrice), quotedAt = Number(quote?.time);
  const quoteFresh = Number.isFinite(quotedAt) && now - quotedAt >= -1000 && now - quotedAt <= 15000
    && Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;
  const countertrend = plan.conflicts.some(tf => ['4h', '1h'].includes(tf));
  const dual = plan.timeframeProfile === 'SMC-4H15M-1';
  const reaction = dual ? plan.entryPolicyRevision ? entryPath15m(plan,bars15m,now) : reaction15m(plan,bars15m,now) : null;
  const timing = dual ? {timeframe:'15M',orderAuthority:false,...reaction,
    state:reaction.ready?'LOCAL_REACTION_CONFIRMED':reaction.reason,
    availableAt:Array.isArray(bars15m)?Number(bars15m.filter(b=>Number(b[6])<now).at(-1)?.[6])||null:null}
    : reviewRetestTiming(plan, bars5m, now);
  return { revision: dual ? 'SMC-ENTRY-REVIEW-3' : ENTRY_REVIEW_REVISION, observedAt: now, orderAuthority: false,
    admissionChanged: false, winProbability: null, atr15m: atr15,
    costModel: { basis: 'SCANNER_SCREEN_NOT_EXECUTION_QUOTE', feeBpsPerSide: policy.feeBpsPerSide,
      slippageBpsPerSide: policy.slippageBpsPerSide, fundingReserveBps: policy.fundingReserveBps, stopSlippageBps: STOP_SLIPPAGE_BPS },
    planned: reviewEntryGeometry(plan, plan.entry, atr15),
    immediate: quoteFresh ? { quotedAt, side: plan.direction === 'LONG' ? 'ASK' : 'BID',
      ...reviewEntryGeometry(plan, plan.direction === 'LONG' ? ask : bid, atr15) } : null,
    countertrend, recognitionState: countertrend && !timing.ready ? 'COUNTERTREND_UNCONFIRMED'
      : timing.ready ? 'LOCAL_TIMING_CONFIRMED' : 'CONDITIONAL_UNCONFIRMED', timing };
}

export function validateEntryReview(plan, now) {
  const r = plan.entryReview;
  if (r == null) return; // Legacy records keep their original prospective policy.
  const invalid = () => { throw new Error('STRUCTURE_PLAN_ENTRY_REVIEW'); };
  const dual=plan.timeframeProfile==='SMC-4H15M-1';
  if (r.revision !== (dual?'SMC-ENTRY-REVIEW-3':ENTRY_REVIEW_REVISION) || r.orderAuthority !== false || r.admissionChanged !== false
    || r.winProbability !== null || r.observedAt !== plan.observedAt || !(r.atr15m >= 0) || !Number.isFinite(r.atr15m)
    || r.costModel?.basis !== 'SCANNER_SCREEN_NOT_EXECUTION_QUOTE'
    || r.costModel.feeBpsPerSide !== policy.feeBpsPerSide || r.costModel.slippageBpsPerSide !== policy.slippageBpsPerSide
    || r.costModel.fundingReserveBps !== policy.fundingReserveBps || r.costModel.stopSlippageBps !== STOP_SLIPPAGE_BPS) invalid();
  const equal = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  if (!equal(r.planned, reviewEntryGeometry(plan, plan.entry, r.atr15m))) invalid();
  if (r.immediate !== null) {
    const { quotedAt, side, ...geometry } = r.immediate;
    if (!Number.isFinite(quotedAt) || r.observedAt - quotedAt < -1000 || r.observedAt - quotedAt > 15000
      || side !== (plan.direction === 'LONG' ? 'ASK' : 'BID')
      || !equal(geometry, reviewEntryGeometry(plan, geometry.entry, r.atr15m))) invalid();
  }
  const t = r.timing;
  if(dual){
    if(!t||t.timeframe!=='15M'||t.revision!==(plan.entryPolicyRevision??'SMC-15M-REACTION-1')||t.orderAuthority!==false
      || !['LOCAL_REACTION_CONFIRMED','WAIT_ZONE_CANDLE','REACTION_INVALIDATED','REACTION_DATA_UNAVAILABLE',...(plan.entryPolicyRevision?['WAIT_CONFIRMED_DIRECTION']:[])].includes(t.state)
      ||t.ready!==(t.state==='LOCAL_REACTION_CONFIRMED')
      ||(t.availableAt!==null&&(!Number.isFinite(t.availableAt)||t.availableAt>=now||t.availableAt>r.observedAt)))invalid();
    if(t.ready){
      const c=t.confirmation,long=plan.direction==='LONG';
      if(!c||![c.openTime,c.closeTime,c.open,c.high,c.low,c.close,t.atr15m].every(Number.isFinite)
        ||c.openTime%900000!==0||c.closeTime!==c.openTime+899999||(!plan.entryPolicyRevision&&c.openTime<=plan.availableAt)
        ||c.closeTime>t.availableAt||r.observedAt-c.closeTime>1200000||t.atr15m<=0
        ||c.high<=c.low||c.low<=0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)
        ||(!plan.entryPolicyRevision&&(c.low>plan.zone.high||c.high<plan.zone.low||!(long?c.close>=plan.zone.ce:c.close<=plan.zone.ce)))
        ||!(long?c.close>c.open:c.close<c.open)
        ||c.high-c.low<t.atr15m*.3
        ||c.bodyFraction!==Math.abs(c.close-c.open)/(c.high-c.low)
        ||c.rejectionFraction!==(long?Math.min(c.open,c.close)-c.low:c.high-Math.max(c.open,c.close))/(c.high-c.low)
        ||c.directionalCloseLocation!==(long?c.close-c.low:c.high-c.close)/(c.high-c.low)
        ||c.directionalCloseLocation<.65||!(c.bodyFraction>=.45||c.rejectionFraction>=.4))invalid();
      if(plan.entryPolicyRevision){
        const f=plan.targetBasis?.directionSupport?.local,e=f?.lastExternalEvent;
        const knownAt=Math.max(plan.anchor.confirmedAt,plan.stopBasis?.point?.confirmedAt,plan.objective?.confirmedAt);
        if(!plan.stopBasis?.ready||plan.stopBasis.entryValid===false||f?.status!=='READY'||f.bias!==(long?'BULLISH':'BEARISH')
          ||!Number.isFinite(knownAt)||t.knownAt!==knownAt||knownAt>c.closeTime||c.closeTime!==t.availableAt||f.availableAt!==c.closeTime)invalid();
        if(t.path==='RETEST'){
          if(t.externalEvent!==null||plan.anchor.confirmedAt>c.openTime||plan.objective.confirmedAt>c.openTime
            ||c.low>plan.zone.high||c.high<plan.zone.low||!(long?c.close>=plan.zone.ce:c.close<=plan.zone.ce))invalid();
        }else{
          if(!['CONFIRMED_TURN','BREAK_CONTINUATION'].includes(t.path)||!e
            ||e.type!==(t.path==='CONFIRMED_TURN'?'TREND_CONFIRMED':'BOS')||e.scope!=='EXTERNAL'
            ||e.direction!==plan.direction||e.episodeId!==f.episodeId||e.at!==c.closeTime
            ||!Number.isFinite(e.level)||!Number.isFinite(e.endpointAvailableAt)||e.endpointAvailableAt>c.openTime
            ||!(long?c.close>e.level:c.close<e.level)
            ||!equal(t.externalEvent,{type:e.type,at:e.at,level:e.level,endpointAvailableAt:e.endpointAvailableAt}))invalid();
        }
      }
    }else if(t.confirmation!==null||t.atr15m!==null||(plan.entryPolicyRevision&&t.path!==null))invalid();
    const countertrend=plan.conflicts.includes('4h');
    if(r.countertrend!==countertrend||r.recognitionState!==(countertrend&&!t.ready?'COUNTERTREND_UNCONFIRMED':t.ready?'LOCAL_TIMING_CONFIRMED':'CONDITIONAL_UNCONFIRMED'))invalid();
    return;
  }
  const states = ['UNAVAILABLE', 'WAIT_ZONE_TOUCH', 'WAIT_LOCAL_REVERSAL', 'RETEST_INVALIDATED',
    'LOCAL_REVERSAL_CONFIRMED', 'CONFIRMATION_EXPIRED'];
  if (!t || t.timeframe !== '5M' || t.orderAuthority !== false || !states.includes(t.state)
    || t.ready !== (t.state === 'LOCAL_REVERSAL_CONFIRMED')
    || (t.availableAt !== null && (!Number.isFinite(t.availableAt) || t.availableAt >= now || t.availableAt > r.observedAt))
    || (t.touchAt !== null && (!Number.isFinite(t.touchAt) || t.touchAt <= plan.anchor.confirmedAt || t.touchAt > t.availableAt))) invalid();
  if (t.ready || t.state === 'CONFIRMATION_EXPIRED') {
    const c = t.confirmation, p = t.breakPivot, long = plan.direction === 'LONG';
    if (!c || !p || ![c.openTime, c.closeTime, c.open, c.close, c.high, c.low, c.buffer, c.previousClose, p.time, p.confirmedAt, p.price, t.atr5m].every(Number.isFinite)
      || c.openTime % M5 !== 0 || c.closeTime !== c.openTime + M5 - 1
      || c.closeTime < t.touchAt || c.closeTime > t.availableAt || c.closeTime - t.touchAt > policy.entryMicroStructureMaximumAgeMs
      || p.time >= p.confirmedAt || p.confirmedAt >= c.openTime || p.kind !== (long ? 'HIGH' : 'LOW')
      || !(t.atr5m > 0) || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low <= 0 || c.high <= c.low
      || !(long ? c.close > c.open && c.close > plan.zone.high && c.close > p.price + c.buffer && c.previousClose <= p.price + c.buffer
        : c.close < c.open && c.close < plan.zone.low && c.close < p.price - c.buffer && c.previousClose >= p.price - c.buffer)
      || c.bodyFraction !== Math.abs(c.close - c.open) / (c.high - c.low)
      || c.rangeATR !== (c.high - c.low) / t.atr5m
      || c.directionalCloseLocation !== (long ? c.close - c.low : c.high - c.close) / (c.high - c.low)
      || c.bodyFraction < policy.entryMicroStructureMinimumBodyFraction || c.rangeATR < policy.entryMicroStructureMinimumRangeAtr
      || c.directionalCloseLocation < policy.entryMicroStructureMinimumDirectionalCloseLocation
      || c.buffer !== Math.max(plan.tickSize * 2, t.atr5m * policy.entryMicroStructureBreakBufferAtr)
      || t.ready !== (r.observedAt - c.closeTime <= policy.entryMicroStructureMaximumAgeMs)) invalid();
  } else if (t.confirmation !== null || t.breakPivot !== null || t.atr5m !== null) invalid();
  const countertrend = plan.conflicts.some(tf => ['4h', '1h'].includes(tf));
  if (r.countertrend !== countertrend || r.recognitionState !== (countertrend && !t.ready ? 'COUNTERTREND_UNCONFIRMED'
    : t.ready ? 'LOCAL_TIMING_CONFIRMED' : 'CONDITIONAL_UNCONFIRMED')) invalid();
}
