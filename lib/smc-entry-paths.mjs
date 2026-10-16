import {smcBars} from './smc-bar-evidence.mjs';
export const ENTRY_PATH_REVISION='SMC-ENTRY-PATHS-2';
export const LEGACY_ENTRY_PATH_REVISION='SMC-ENTRY-PATHS-1';
export const ENTRY_PATH_REVISIONS=Object.freeze([LEGACY_ENTRY_PATH_REVISION,ENTRY_PATH_REVISION]);
// Closed-bar signal formation. No historical order, clock gate or fabricated fill.
export function entryPath15m(plan,rows,now) {
 const revision=ENTRY_PATH_REVISIONS.includes(plan.entryPolicyRevision)?plan.entryPolicyRevision:ENTRY_PATH_REVISION;
 const wait={revision,ready:false,reason:'WAIT_ZONE_CANDLE',confirmation:null,atr15m:null,path:null};
 try {
  const bars=smcBars(rows,900000,now),b=bars.at(-1),long=plan.direction==='LONG',sign=long?1:-1;
  const f=plan.targetBasis?.directionSupport?.local,e=f?.lastExternalEvent,p=plan.stopBasis?.point;
  if(!ENTRY_PATH_REVISIONS.includes(plan.entryPolicyRevision)||!plan.stopBasis?.ready||plan.stopBasis.entryValid===false
   ||f?.status!=='READY'||f.bias!==(long?'BULLISH':'BEARISH')||!p||!plan.objective)return {...wait,reason:'WAIT_CONFIRMED_DIRECTION'};
  const knownAt=Math.max(plan.anchor.confirmedAt,p.confirmedAt,plan.objective.confirmedAt);
  if(!Number.isFinite(knownAt)||knownAt>b.closeTime||f.availableAt!==b.closeTime||now-b.closeTime>1200000)return wait;
  const last=bars.slice(-15),tr=last.slice(1).map((v,i)=>Math.max(v.high-v.low,Math.abs(v.high-last[i].close),Math.abs(v.low-last[i].close))),atr15m=tr.reduce((a,v)=>a+v,0)/tr.length;
  const range=b.high-b.low,body=Math.abs(b.close-b.open),wick=long?Math.min(b.open,b.close)-b.low:b.high-Math.max(b.open,b.close);
  const loc=range>0?(long?b.close-b.low:b.high-b.close)/range:0;
  if(!(atr15m>0)||range<atr15m*.3||sign*(b.close-b.open)<=0||loc<.65||!(body/range>=.45||wick/range>=.4))return wait;
  const retest=plan.anchor.confirmedAt<=b.openTime&&plan.objective.confirmedAt<=b.openTime
   &&b.low<=plan.zone.high&&b.high>=plan.zone.low&&(long?b.close>=plan.zone.ce:b.close<=plan.zone.ce);
  const external=['BOS','TREND_CONFIRMED'].includes(e?.type)&&e.scope==='EXTERNAL'&&e.direction===plan.direction
   &&e.episodeId===f.episodeId&&e.at===b.closeTime&&Number.isFinite(e.level)&&Number.isFinite(e.endpointAvailableAt)
   &&e.endpointAvailableAt<=b.openTime&&(long?b.close>e.level:b.close<e.level);
  if(!retest&&!external)return wait;
  const path=external?(e.type==='TREND_CONFIRMED'?'CONFIRMED_TURN':'BREAK_CONTINUATION'):'RETEST';
  return {revision,ready:true,reason:null,confirmation:{...b,bodyFraction:body/range,rejectionFraction:wick/range,directionalCloseLocation:loc},atr15m,path,
   knownAt,externalEvent:external?{type:e.type,at:e.at,level:e.level,endpointAvailableAt:e.endpointAvailableAt}:null};
 }catch{return {...wait,reason:'REACTION_DATA_UNAVAILABLE'};}
}

/** A new confirmation may confirm direction; it may not move its price anchor.
 * The existing 0.25 ATR tolerance is retained. PATH1 is reproduced unchanged
 * for frozen evidence; PATH2 anchors external breaks to their known level and
 * bounds retest admission to the original planned structure zone.
 */
export function entryPathPriceBand(plan,reaction,cap) {
 if(!reaction?.ready||!(reaction.atr15m>0)||!Number.isFinite(cap)
  ||!Number.isFinite(reaction.confirmation?.close))return {band:null,entryReference:null};
 const long=plan.direction==='LONG',tolerance=reaction.atr15m*.25;
 const external=Boolean(plan.entryPolicyRevision&&reaction.path!=='RETEST');
 const revised=plan.entryPolicyRevision===ENTRY_PATH_REVISION;
 if(revised&&external&&!Number.isFinite(reaction.externalEvent?.level))return {band:null,entryReference:null};
 const reference=external&&revised?reaction.externalEvent.level:reaction.confirmation.close;
 let band=external
  ?{low:Math.max(reference-tolerance,long?-Infinity:cap),high:Math.min(reference+tolerance,long?cap:Infinity)}
  :long?{low:plan.zone.low,high:Math.min(reaction.confirmation.close+tolerance,cap)}
   :{low:Math.max(reaction.confirmation.close-tolerance,cap),high:plan.zone.high};
 if(revised&&!external)band={low:Math.max(band.low,plan.zone.low-tolerance),high:Math.min(band.high,plan.zone.high+tolerance)};
 const entryReference=revised?(external
  ?{kind:'BROKEN_15M_STRUCTURE',price:reference,availableAt:reaction.externalEvent.endpointAvailableAt,eventAt:reaction.externalEvent.at,sourcePlanEntry:plan.entry}
  :{kind:'PLANNED_15M_ZONE',price:plan.entry,low:plan.zone.low,high:plan.zone.high,availableAt:plan.anchor.confirmedAt}):null;
 return {band,entryReference};
}
