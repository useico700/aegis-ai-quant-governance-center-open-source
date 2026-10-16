// Intersection geometry is observation-only. This model never consumes a clock.
import { createHash } from 'node:crypto';
import { sanitizeStructurePlans } from './smc-structure-plan.mjs';
import { sanitizeStructureContext } from './smc-structure-context.mjs';
import { smcNetRewardRisk,SMC_SCAN_POLICY } from './smc-scanner.mjs';
import { planPriceEvent } from './smc-plan-lifecycle.mjs';
import { timedReaction } from './smc-timed-reaction.mjs';
import { assessLocalOpportunity } from '../integrations/jev/smc-opportunity.mjs';
export const LOCAL_ENTRY_REVISION='SMC-LOCAL-ENTRY-1';
const check=(x,c)=>{if(!x)throw new Error(c);};
export function localSmcCandidate(plan,context,rows,quote,now,selection=null) {
 const normalized=sanitizeStructureContext(context,now),reaction=timedReaction(plan,rows,now);
 const assessment=assessLocalOpportunity({plan,context:normalized,reaction,now});
 const long=plan.direction==='LONG';
 const reasons=[...assessment.reasons];
 const fresh=quote&&[quote.bid,quote.ask,quote.time].every(Number.isFinite)&&quote.bid>0&&quote.ask>=quote.bid&&now-quote.time>=-1000&&now-quote.time<=15000;
 if(!fresh)reasons.push('QUOTE_UNAVAILABLE');
 if(planPriceEvent(plan,{quote,now}))reasons.push('PLAN_NOT_ACTIVE');
 if(selection&&(selection.symbol!==plan.symbol||selection.direction!==plan.direction||!Number.isFinite(selection.selectedAt)||selection.selectedAt>now||typeof selection.autoTradingEnabled!=='boolean'))reasons.push('OWNER_SELECTION_INVALID');
 let band=null;
 const cap=plan.entryReview?.planned?.entryFor2R;
 if(reaction.ready&&Number.isFinite(cap)) {
  const tolerance=reaction.atr5m*.25;
  band=long?{low:plan.zone.low,high:Math.min(reaction.confirmation.close+tolerance,cap)}:{low:Math.max(reaction.confirmation.close-tolerance,cap),high:plan.zone.high};
  if(!(band.high>band.low))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 } else if(!Number.isFinite(cap))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 if(reasons.length)return {candidate:null,assessment:{...assessment,revision:LOCAL_ENTRY_REVISION,ready:false,reasons}};
 const price=long?quote.ask:quote.bid,active=price>=band.low&&price<=band.high;
 const entry=active?price:Math.max(band.low,Math.min(band.high,plan.entry)),rr=smcNetRewardRisk({...plan,entry});
 if(!rr.qualified)return {candidate:null,assessment:{...assessment,ready:false,reasons:['NET_R_BELOW_2']}};
 const id=`SMC-LOCAL-${createHash('sha256').update(`${plan.id}:${reaction.confirmation.closeTime}`).digest('hex').slice(0,32).toUpperCase()}`;
 const entryBand={...band,ce:plan.entry,trigger:plan.entry,half:'LOCAL_SMC_REACTION_BAND'};
 const distance=price<band.low?band.low-price:price>band.high?price-band.high:0;
 return {assessment:{...assessment,revision:LOCAL_ENTRY_REVISION,ready:true,stage:active?'EXECUTION_RECHECK':'WAIT_PRICE',band},candidate:{
  id,symbol:plan.symbol,direction:plan.direction,revision:SMC_SCAN_POLICY.revision,modelRevision:LOCAL_ENTRY_REVISION,
  candidateSource:selection?'OWNER_SELECTED':'AUTOMATIC',ownerSelectedAt:selection?.selectedAt??null,ownerAutoTradingEnabled:selection?.autoTradingEnabled??null,sourceSelection:selection,
  status:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',reason:active?'LOCAL_SMC_CONFIRMED':'WAIT_LOCAL_SMC_PRICE',
  entry,stop:plan.stop,target:plan.target,netR:rr.netR,riskPerUnit:rr.riskPerUnit,netRewardPerUnit:rr.netRewardPerUnit,
  referenceEntry:plan.entry,entryBand,zone:{...plan.zone,availableAt:plan.availableAt,entryBand:{low:band.low,high:band.high}},
  sourcePlan:structuredClone(plan),sourceContext:normalized,sourceQuote:quote,
  sourceReactionBars:rows.filter(b=>Number(b[6])<now).slice(-80).map(b=>b.slice(0,7).map(Number)),
  anchor:plan.anchor,availableAt:plan.availableAt,lifecyclePolicy:2,lifecycleGeneration:plan.lifecycleGeneration,
  structure:{eventType:'LOCAL_RETEST',bosAt:plan.anchor.confirmedAt,currentBias:normalized.frames['15m'].bias,
   protectedPivot:plan.stopBasis.point,parentEpisodeId:normalized.frames['4h']?.episodeId??null,model:LOCAL_ENTRY_REVISION,nPatternRequired:false,nPatternQualified:false},
  entryConfirmation:{mode:'CLOSED_5M_LOCAL_SMC_REACTION',state:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',closedBarRequired:true,reaction,liveBboInsideBand:active},
  jevOpportunity:assessment,
  confirmationAt:reaction.confirmation.closeTime,observedAt:now,
  expiresAt:Math.min(plan.expiresAt,reaction.confirmation.closeTime+1200000),
  entryHistoryCoverage:'CONTINUOUS_FROM_PLAN',quoteFresh:true,
  distanceToEntry:{executablePrice:price,absolute:distance,percent:distance/plan.entry*100,quoteAt:quote.time,side:long?'ASK':'BID',basis:'NEAREST_ENTRY_BAND_EDGE'},
  orderAuthority:false,executionQualified:false,winProbability:null,
 }};
}
export function validateLocalSmcCandidate(row,now) {
 check(row?.modelRevision===LOCAL_ENTRY_REVISION&&Number.isFinite(row.observedAt)&&now-row.observedAt<=360000&&now-row.observedAt>=-5000&&row.expiresAt>now,'LOCAL_ENTRY_STALE');
 sanitizeStructurePlans([row.sourcePlan],row.symbol,row.observedAt);
 const expected=localSmcCandidate(row.sourcePlan,row.sourceContext,row.sourceReactionBars,row.sourceQuote,row.observedAt,row.sourceSelection).candidate;
 check(expected,'LOCAL_ENTRY_NOT_CONFIRMED');
 for(const key of Object.keys(expected))check(JSON.stringify(row[key])===JSON.stringify(expected[key]),`LOCAL_ENTRY_MISMATCH_${key.toUpperCase()}`);
 return true;
}
