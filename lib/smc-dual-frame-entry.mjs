import {entryPath15m,entryPathPriceBand,ENTRY_PATH_REVISION} from './smc-entry-paths.mjs';
import {assessTargetPath,validate4hFvgEvidence,compact4hFvgEvidence} from './smc-target-path.mjs';
import {reviewEntryGeometry} from './smc-entry-review.mjs';
import { targetDirectionSupport } from './smc-target-policy.mjs';
// Intersection geometry is observation-only. This model never consumes a clock.
import { createHash } from 'node:crypto';
import { sanitizeStructurePlans } from './smc-structure-plan.mjs';
import { sanitizeStructureContext } from './smc-structure-context.mjs';
import { smcNetRewardRisk,SMC_SCAN_POLICY } from './smc-scanner.mjs';
import { planPriceEvent } from './smc-plan-lifecycle.mjs';
import { reaction15m } from './smc-15m-reaction.mjs';
import { assessDualFrameOpportunity } from '../integrations/jev/smc-opportunity.mjs';
export const DUAL_FRAME_ENTRY_REVISION='SMC-LOCAL-ENTRY-2';
const check=(x,c)=>{if(!x)throw new Error(c);};
export function dualFrameCandidate(plan,context,rows,quote,now,selection=null,fullTargetPathEvidence=null) {
 check(plan.timeframeProfile==='SMC-4H15M-1'&&context?.timeframeProfile==='SMC-4H15M-1','DUAL_FRAME_PROFILE_REQUIRED');
 const normalized=sanitizeStructureContext(context,now),reaction=plan.entryPolicyRevision ? entryPath15m(plan,rows,now) : reaction15m(plan,rows,now);
 const long=plan.direction==='LONG',path2=plan.entryPolicyRevision===ENTRY_PATH_REVISION;
 let band=null,entryReference=null,entryGeometry=null,targetPath=null,referenceTarget=plan.target;
 const price=long?quote?.ask:quote?.bid;
 let cap=plan.entryReview?.planned?.entryFor2R;
 if(path2){
  check(fullTargetPathEvidence,'TARGET_PATH_FULL_EVIDENCE_REQUIRED');
  validate4hFvgEvidence(fullTargetPathEvidence,now);
  check(fullTargetPathEvidence.symbol===plan.symbol&&fullTargetPathEvidence.tickSize===plan.tickSize
   &&JSON.stringify(compact4hFvgEvidence(fullTargetPathEvidence))===JSON.stringify(plan.targetPathEvidence),'TARGET_PATH_SOURCE_MISMATCH');
  const modelPrice=reaction.ready&&reaction.path!=='RETEST'?reaction.externalEvent?.level:plan.entry;
  const at=entry=>assessTargetPath({evidence:fullTargetPathEvidence,direction:plan.direction,entry,stop:plan.stop,
   referenceTarget,tickSize:plan.tickSize,now});
  targetPath=at(modelPrice);
  const capFor=(path,entry)=>Number.isFinite(path.admissionTarget)
   ?reviewEntryGeometry({...plan,target:path.admissionTarget},entry,reaction.atr15m??plan.entryReview?.atr15m??0).entryFor2R:null;
  cap=capFor(targetPath,modelPrice);
  ({band,entryReference}=entryPathPriceBand(plan,reaction,cap));
  let entry=modelPrice;
  if(band?.high>band?.low){
   const reference=entryReference.price;
   const proposed=()=>Number.isFinite(price)&&price>=band.low&&price<=band.high?price:Math.max(band.low,Math.min(band.high,reference));
   entry=proposed();targetPath=at(entry);
   // Recheck the target and net2R boundary at the submitted/conditional price.
   // A new target cannot expand the original structurally anchored band.
   const finalCap=capFor(targetPath,entry),finalBand=entryPathPriceBand(plan,reaction,finalCap).band;
   if(finalBand){band={low:Math.max(band.low,finalBand.low),high:Math.min(band.high,finalBand.high)};cap=finalCap;
    if(band.high>band.low){entry=proposed();targetPath=at(entry);}}
  }
  entryGeometry={entry,target:targetPath.admissionTarget,netR:targetPath.netR,targetPath};
 }
 const assessment=assessDualFrameOpportunity({plan,context:normalized,reaction,now,...(path2?{entryGeometry}:{})});
 const reasons=[...assessment.reasons];
 if(plan.entryPolicyRevision){
  const supplied=plan.targetBasis?.directionSupport?.local,actual=normalized.frames['15m'];
  const same=(a,b,keys)=>keys.every(k=>a?.[k]===b?.[k]);
  if(!same(supplied,actual,['status','bias','episodeId','availableAt'])
    ||!same(supplied?.protectedPoint,actual?.protectedPoint,['kind','price','time','confirmedAt'])
    ||!same(supplied?.lastExternalEvent,actual?.lastExternalEvent,['type','scope','direction','at','episodeId','level','endpointAvailableAt']))reasons.push('ENTRY_SOURCE_CONTEXT_MISMATCH');
 }
 if(plan.targetPolicyRevision && (plan.targetBasis?.scope!=='4H_MAIN'||!targetDirectionSupport(normalized.frames['4h'],normalized.frames['15m'],plan.direction,path2?entryGeometry.entry:plan.entry,now,plan.targetPolicyRevision))) reasons.push(plan.targetPolicyRevision==='SMC-TARGET-4H-2'?'WAIT_CONFIRMED_DIRECTION':'WAIT_4H_MAIN_DIRECTION');
 const fresh=quote&&[quote.bid,quote.ask,quote.time].every(Number.isFinite)&&quote.bid>0&&quote.ask>=quote.bid&&now-quote.time>=-1000&&now-quote.time<=15000;
 if(!fresh)reasons.push('QUOTE_UNAVAILABLE');
 if(planPriceEvent(plan,{quote,now}))reasons.push('PLAN_NOT_ACTIVE');
 if(selection&&(selection.symbol!==plan.symbol||selection.direction!==plan.direction||!Number.isFinite(selection.selectedAt)||selection.selectedAt>now||typeof selection.autoTradingEnabled!=='boolean'))reasons.push('OWNER_SELECTION_INVALID');
 if(reaction.ready&&Number.isFinite(cap)) {
  if(!path2)({band}=entryPathPriceBand(plan,reaction,cap));
  if(!(band.high>band.low))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 } else if(!Number.isFinite(cap))reasons.push('NO_EXECUTABLE_PRICE_BAND');
 if(reasons.length)return {candidate:null,assessment:{...assessment,revision:DUAL_FRAME_ENTRY_REVISION,ready:false,reasons}};
 const active=price>=band.low&&price<=band.high;
 const entry=path2?entryGeometry.entry:active?price:Math.max(band.low,Math.min(band.high,plan.entry));
 const target=path2?targetPath.admissionTarget:plan.target,rr=smcNetRewardRisk({...plan,entry,target});
 if(!rr.qualified)return {candidate:null,assessment:{...assessment,revision:DUAL_FRAME_ENTRY_REVISION,ready:false,reasons:['NET_R_BELOW_2']}};
 const id=`SMC-DUAL-${createHash('sha256').update(`${plan.id}:${reaction.confirmation.closeTime}`).digest('hex').slice(0,32).toUpperCase()}`;
 const modelReference=path2?entryReference.price:plan.entry;
 const entryBand={...band,ce:modelReference,trigger:modelReference,half:'LOCAL_SMC_REACTION_BAND'};
 const distance=price<band.low?band.low-price:price>band.high?price-band.high:0;
 return {assessment:{...assessment,revision:DUAL_FRAME_ENTRY_REVISION,ready:true,stage:active?'EXECUTION_RECHECK':'WAIT_PRICE',band},candidate:{
  id,symbol:plan.symbol,direction:plan.direction,revision:SMC_SCAN_POLICY.revision,modelRevision:DUAL_FRAME_ENTRY_REVISION,
  candidateSource:selection?'OWNER_SELECTED':'AUTOMATIC',ownerSelectedAt:selection?.selectedAt??null,ownerAutoTradingEnabled:selection?.autoTradingEnabled??null,sourceSelection:selection,
  status:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',reason:active?'LOCAL_SMC_CONFIRMED':'WAIT_LOCAL_SMC_PRICE',
  entry,stop:plan.stop,target,netR:rr.netR,riskPerUnit:rr.riskPerUnit,netRewardPerUnit:rr.netRewardPerUnit,
  ...(path2?{entryPolicyRevision:plan.entryPolicyRevision,targetPathRevision:targetPath.revision,entryReference,referenceTarget,targetPath,sourceTargetPathEvidence:structuredClone(fullTargetPathEvidence)}:{}),
  referenceEntry:modelReference,entryBand,zone:{...plan.zone,availableAt:plan.availableAt,entryBand:{low:band.low,high:band.high}},
  sourcePlan:structuredClone(plan),sourceContext:normalized,sourceQuote:quote,
  sourceReactionBars:rows.filter(b=>Number(b[6])<now).slice(-80).map(b=>b.slice(0,7).map(Number)),
  anchor:plan.anchor,availableAt:plan.availableAt,lifecyclePolicy:2,lifecycleGeneration:plan.lifecycleGeneration,
  structure:{eventType:reaction.path??'LOCAL_RETEST',bosAt:plan.anchor.confirmedAt,currentBias:normalized.frames['15m'].bias,
   protectedPivot:plan.stopBasis.point,parentEpisodeId:normalized.frames['4h']?.episodeId??null,model:DUAL_FRAME_ENTRY_REVISION,nPatternRequired:false,nPatternQualified:false},
  entryConfirmation:{mode:'CLOSED_15M_LOCAL_SMC_REACTION',state:active?'ENTRY_BAND_ACTIVE':'WAIT_CE_REENTRY',closedBarRequired:true,reaction,liveBboInsideBand:active},
  jevOpportunity:assessment,
  confirmationAt:reaction.confirmation.closeTime,observedAt:now,
  expiresAt:Math.min(plan.expiresAt,reaction.confirmation.closeTime+1200000),
  entryHistoryCoverage:'CONTINUOUS_FROM_PLAN',quoteFresh:true,
  distanceToEntry:{executablePrice:price,absolute:distance,percent:distance/modelReference*100,quoteAt:quote.time,side:long?'ASK':'BID',basis:'NEAREST_ENTRY_BAND_EDGE'},
  orderAuthority:false,executionQualified:false,winProbability:null,
 }};
}
export function validateDualFrameCandidate(row,now) {
 check(row?.modelRevision===DUAL_FRAME_ENTRY_REVISION&&Number.isFinite(row.observedAt)&&now-row.observedAt<=360000&&now-row.observedAt>=-5000&&row.expiresAt>now,'LOCAL_ENTRY_STALE');
 sanitizeStructurePlans([row.sourcePlan],row.symbol,row.observedAt);
 const expected=dualFrameCandidate(row.sourcePlan,row.sourceContext,row.sourceReactionBars,row.sourceQuote,row.observedAt,row.sourceSelection,row.sourceTargetPathEvidence).candidate;
 check(expected,'LOCAL_ENTRY_NOT_CONFIRMED');
 for(const key of Object.keys(expected))check(JSON.stringify(row[key])===JSON.stringify(expected[key]),`LOCAL_ENTRY_MISMATCH_${key.toUpperCase()}`);
 return true;
}
