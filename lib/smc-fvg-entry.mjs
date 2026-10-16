import {smcBars,confirmedSmcPivots} from './smc-bar-evidence.mjs';
import policy from './smc-scan-policy.json' with {type:'json'};

export const FVG_ENTRY_PROPOSAL_REVISION='SMC-15M-FVG-PROPOSAL-1';
const M15=900000;
const atrAt=(bars,index)=>{
 const from=Math.max(1,index-13);
 return bars.slice(from,index+1).reduce((sum,b,i)=>sum+Math.max(b.high-b.low,
  Math.abs(b.high-bars[from+i-1].close),Math.abs(b.low-bars[from+i-1].close)),0)/(index-from+1);
};
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
const compact=b=>({openTime:b.openTime,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,closeTime:b.closeTime});

/** Prospective, observation-only 15M displacement/FVG retest proposals.
 * Formation uses three closed candles. A known pivot and a same-direction
 * displacement through that pivot must be present in the same three-candle
 * leg. All thresholds below reuse the current displacement/reaction policy.
 * This module does not grant direction, stop-safety, target, netR or order
 * admission. Its far-edge invalidation is a distinct hypothesis, never a
 * borrowed later main-swing protection point.
 */
export function derive15mFvgEntryProposals({symbol,bars15m,tickSize,now,maximumSetups=8}) {
 const tick=Number(tickSize);
 if(!policy.universe.includes(symbol)||!(tick>0)||!Number.isFinite(tick)
  ||!Number.isInteger(maximumSetups)||maximumSetups<1||maximumSetups>32)throw new Error('FVG_PROPOSAL_SCOPE_INVALID');
 const bars=smcBars(bars15m,M15,now),pivots=confirmedSmcPivots(bars),proposals=[];
 const currentAtr=atrAt(bars,bars.length-1);
 for(let index=21;index<bars.length;index++){
  const first=bars[index-2],third=bars[index];
  for(const direction of ['LONG','SHORT']){
   const long=direction==='LONG',sign=long?1:-1;
   const low=long?first.high:third.high,high=long?third.low:first.low;
   if(!(high-low>tick*2))continue;
   let displacement=null;
   for(let k=index-2;k<=index;k++){
    const b=bars[k],prior=bars[k-1],a=atrAt(bars,k-1),range=b.high-b.low;
    const pivot=pivots.filter(p=>p.kind===(long?'HIGH':'LOW')&&p.confirmedAt<b.openTime).at(-1);
    const volumeBaseline=median(bars.slice(Math.max(0,k-20),k).map(v=>v.volume));
    const body=sign*(b.close-b.open),buffer=Math.max(tick*2,a*policy.bosBufferAtr);
    if(!pivot||range<=0||!(a>0)||!(volumeBaseline>0)||body/a<policy.displacementBodyAtr
     ||body/range<policy.displacementBodyFraction||b.volume/volumeBaseline<policy.displacementVolumeRatio
     ||!(long?b.close>pivot.price+buffer&&prior.close<=pivot.price+buffer:b.close<pivot.price-buffer&&prior.close>=pivot.price-buffer))continue;
    displacement={bar:compact(b),pivot:{kind:pivot.kind,price:pivot.price,time:pivot.time,confirmedAt:pivot.confirmedAt},
     buffer,atr15m:a,bodyATR:body/a,bodyFraction:body/range,volumeRatio:b.volume/volumeBaseline};break;
   }
   if(!displacement)continue;
   const formedAt=third.closeTime,zone={kind:'FVG',low,high,ce:(low+high)/2,availableAt:formedAt};
   const farEdge=long?low:high,after=bars.slice(index+1);
   const invalidated=after.find(b=>long?b.close<farEdge:b.close>farEdge);
   if(invalidated)continue;
   const touches=after.filter(b=>b.low<=high&&b.high>=low);
   let reaction=null;
   for(let k=after.length-1;k>=0;k--){
    const b=after[k],range=b.high-b.low,body=Math.abs(b.close-b.open);
    const wick=long?Math.min(b.open,b.close)-b.low:b.high-Math.max(b.open,b.close);
    const location=range>0?(long?b.close-b.low:b.high-b.close)/range:0;
    if(now-b.closeTime>policy.entryMicroStructureMaximumAgeMs)break;
    if(b.openTime<=formedAt||b.low>high||b.high<low||range<currentAtr*.3||sign*(b.close-b.open)<=0
     ||location<.65||!(body/range>=.45||wick/range>=.4)||!(long?b.close>=zone.ce:b.close<=zone.ce))continue;
    if(after.slice(k+1).some(later=>long?later.low<b.low:later.high>b.high))continue;
    reaction={bar:compact(b),bodyFraction:body/range,rejectionFraction:wick/range,directionalCloseLocation:location};break;
   }
   proposals.push({id:`${FVG_ENTRY_PROPOSAL_REVISION}:${symbol}:${direction}:${formedAt}`,revision:FVG_ENTRY_PROPOSAL_REVISION,
    symbol,direction,model:'15M_FVG_RETEST',status:reaction?'REACTION_OBSERVED':'WAIT_FVG_RETEST',
    formedAt,observedAt:now,zone,entryReference:zone.ce,
    sourceCandles:bars.slice(index-2,index+1).map(compact),displacement,
    structuralInvalidation:{kind:'FVG_FAR_EDGE',timeframe:'15M',price:farEdge,availableAt:formedAt,closedBarBeyondEdge:true},
    stopBasisStatus:'INDEPENDENT_FVG_SCOPE_NOT_EXECUTION_VALIDATED',atr15m:currentAtr,
    firstTouchAt:touches[0]?.closeTime??null,lastTouchAt:touches.at(-1)?.closeTime??null,touchCount:touches.length,
    reaction,orderAuthority:false,executionQualified:false,automaticEntryAllowed:false,winProbability:null,
    requiredAdmission:['INDEPENDENT_FVG_STOP_SCOPE','4H_TARGET_PATH','ACTUAL_BBO_NET_R_AT_LEAST_2','SHARED_EXECUTION_PREFLIGHT']});
  }
 }
 return proposals.sort((a,b)=>b.formedAt-a.formedAt||a.direction.localeCompare(b.direction)).slice(0,maximumSetups);
}
