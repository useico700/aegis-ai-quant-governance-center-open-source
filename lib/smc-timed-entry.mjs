import { createHash } from 'node:crypto';
import { sanitizeStructurePlans } from './smc-structure-plan.mjs';
import { sanitizeStructureContext } from './smc-structure-context.mjs';
import { smcNetRewardRisk,SMC_SCAN_POLICY } from './smc-scanner.mjs';
import { planPriceEvent } from './smc-plan-lifecycle.mjs';
import { timedReaction } from './smc-timed-reaction.mjs';
import { validateIntersectionEvent,INTERSECTION_CLOCK_REVISION,CLOCK_POLICY } from './smc-intersection-clock.mjs';
import { assessTimedOpportunity } from '../integrations/jev/smc-opportunity.mjs';
export const TIMED_ENTRY_REVISION='SMC-TIMED-ENTRY-1';
const check=(x,c)=>{if(!x)throw new Error(c);};
export function timedEntryCandidate(plan,context,clock,rows,quote,now,selection=null) {
 const normalized=sanitizeStructureContext(context,now),reaction=timedReaction(plan,rows,now);
 const assessment=assessTimedOpportunity({plan,context:normalized,clock,reaction,now});
 const long=plan.direction==='LONG',w=clock?.active;
 const reasons=[...assessment.reasons];
 const fresh=quote&&[quote.bid,quote.ask,quote.time].every(Number.isFinite)&&quote.bid>0&&quote.ask>=quote.bid&&now-quote.time>=-1000&&now-quote.time<=15000;
 if(!fresh)reasons.push('QUOTE_UNAVAILABLE');
 if(planPriceEvent(plan,{quote,now}))reasons.push('PLAN_NOT_ACTIVE');
 if(selection&&(selection.symbol!==plan.symbol||selection.direction!==plan.direction||!Number.isFinite(selection.selectedAt)||selection.selectedAt>now||typeof selection.autoTradingEnabled!=='boolean'))reasons.push('OWNER_SELECTION_INVALID');
 if(w) {
  validateIntersectionEvent(w.event);
  check(clock.revision===INTERSECTION_CLOCK_REVISION&&w.opensAt===w.event.tx&&w.expiresAt===w.opensAt+CLOCK_POLICY.postWindowMs
   &&w.selectedAt>=w.event.firstSeenAt&&w.selectedAt<w.opensAt,'TIMED_WINDOW_INVALID');
 }
 let band=null;
 const cap=plan.entryReview?.planned?.entryFor2R;
 if(reaction.ready&&Number.isFinite(cap)) {
  const tolerance=reaction.atr5m*.25;
  band=long?{low:plan.zone.low,high:Math.min(reaction.confirmation.close+tolerance,cap)}:{low:Math.max(reaction.confirmation.close-tolerance,cap),high:plan.zone.high};
  if(!(band.high>band.low))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 } else if(!Number.isFinite(cap))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 if(reasons.length)return {candidate:null,assessment:{...assessment,revision:TIMED_ENTRY_REVISION,ready:false,reasons}};
 const price=long?quote.ask:quote.bid,active=price>=band.low&&price<=band.high;
 const entry=active?price:Math.max(band.low,Math.min(band.high,plan.entry)),rr=smcNetRewardRisk({...plan,entry});
 if(!rr.qualified)return {candidate:null,assessment:{...assessment,ready:false,reasons:['NET_R_BELOW_2']}};
 const id=`SMC-TIME-${createHash('sha256').update(`${plan.id}:${w.event.id}:${reaction.confirmation.closeTime}`).digest('hex').slice(0,32).toUpperCase()}`;
 const entryBand={...band,ce:plan.entry,trigger:plan.entry,half:'TIMED_SMC_REACTION_BAND'};
 const distance=price<band.low?band.low-price:price>band.high?price-band.high:0;
 return {assessment:{...assessment,revision:TIMED_ENTRY_REVISION,ready:true,stage:active?'EXECUTION_RECHECK':'WAIT_PRICE',band},candidate:{
  id,symbol:plan.symbol,direction:plan.direction,revision:SMC_SCAN_POLICY.revision,modelRevision:TIMED_ENTRY_REVISION,
  candidateSource:selection?'OWNER_SELECTED':'AUTOMATIC',ownerSelectedAt:selection?.selectedAt??null,ownerAutoTradingEnabled:selection?.autoTradingEnabled??null,sourceSelection:selection,
  status:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',reason:active?'TIMED_SMC_CONFIRMED':'WAIT_TIMED_SMC_PRICE',
  entry,stop:plan.stop,target:plan.target,netR:rr.netR,riskPerUnit:rr.riskPerUnit,netRewardPerUnit:rr.netRewardPerUnit,
  referenceEntry:plan.entry,entryBand,zone:{...plan.zone,availableAt:plan.availableAt,entryBand:{low:band.low,high:band.high}},
  sourcePlan:structuredClone(plan),sourceContext:normalized,sourceClock:{revision:clock.revision,active:w},sourceQuote:quote,
  sourceReactionBars:rows.filter(b=>Number(b[6])<now).slice(-80).map(b=>b.slice(0,7).map(Number)),
  anchor:plan.anchor,availableAt:plan.availableAt,lifecyclePolicy:2,lifecycleGeneration:plan.lifecycleGeneration,
  structure:{eventType:'LOCAL_RETEST',bosAt:plan.anchor.confirmedAt,currentBias:normalized.frames['15m'].bias,
   protectedPivot:plan.stopBasis.point,parentEpisodeId:normalized.frames['4h']?.episodeId??null,model:TIMED_ENTRY_REVISION,nPatternRequired:false,nPatternQualified:false},
  entryConfirmation:{mode:'CLOSED_5M_TIMED_SMC_REACTION',state:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',closedBarRequired:true,reaction,liveBboInsideBand:active},
  intersectionEvent:w.event,jevOpportunity:assessment,
  confirmationAt:reaction.confirmation.closeTime,observedAt:now,
  expiresAt:Math.min(plan.expiresAt,reaction.confirmation.closeTime+1200000,w.expiresAt),
  entryHistoryCoverage:'CONTINUOUS_FROM_PLAN',quoteFresh:true,
  distanceToEntry:{executablePrice:price,absolute:distance,percent:distance/plan.entry*100,quoteAt:quote.time,side:long?'ASK':'BID',basis:'NEAREST_ENTRY_BAND_EDGE'},
  orderAuthority:false,executionQualified:false,winProbability:null,
 }};
}
export function validateTimedEntryCandidate(row,now) {
 check(row?.modelRevision===TIMED_ENTRY_REVISION&&Number.isFinite(row.observedAt)&&now-row.observedAt<=360000&&now-row.observedAt>=-5000&&row.expiresAt>now,'TIMED_ENTRY_STALE');
 sanitizeStructurePlans([row.sourcePlan],row.symbol,row.observedAt);
 const expected=timedEntryCandidate(row.sourcePlan,row.sourceContext,row.sourceClock,row.sourceReactionBars,row.sourceQuote,row.observedAt,row.sourceSelection).candidate;
 check(expected,'TIMED_ENTRY_NOT_CONFIRMED');
 for(const key of Object.keys(expected))check(JSON.stringify(row[key])===JSON.stringify(expected[key]),`TIMED_ENTRY_MISMATCH_${key.toUpperCase()}`);
 check(now>=row.intersectionEvent.tx&&now<=row.intersectionEvent.tx+CLOCK_POLICY.postWindowMs,'TIMED_ENTRY_OUTSIDE_WINDOW');
 return true;
}
