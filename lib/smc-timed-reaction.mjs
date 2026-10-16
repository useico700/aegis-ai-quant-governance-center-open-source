import { smcBars } from './smc-bar-evidence.mjs';
export const TIMED_REACTION_REVISION='SMC-TIMED-REACTION-1';
export function timedReaction(plan,rows,now) {
 const wait={revision:TIMED_REACTION_REVISION,ready:false,reason:'WAIT_ZONE_CANDLE',confirmation:null,atr5m:null};
 try {
  const bars=smcBars(rows,300000,now),long=plan.direction==='LONG',sign=long?1:-1;
  const tr=bars.slice(-15).slice(1).map((b,i)=>Math.max(b.high-b.low,Math.abs(b.high-bars.at(-15+i).close),Math.abs(b.low-bars.at(-15+i).close)));
  const atr=tr.reduce((a,b)=>a+b,0)/tr.length;
  for(let i=bars.length-1;i>=Math.max(0,bars.length-4);i--) {
   const b=bars[i],range=b.high-b.low,body=Math.abs(b.close-b.open),wick=long?Math.min(b.open,b.close)-b.low:b.high-Math.max(b.open,b.close);
   if(b.openTime<=plan.availableAt||now-b.closeTime>1200000||range<=0||range<atr*.3||sign*(b.close-b.open)<=0)continue;
   if(b.low>plan.zone.high||b.high<plan.zone.low||!(long?b.close>=plan.zone.ce:b.close<=plan.zone.ce))continue;
   const location=(long?b.close-b.low:b.high-b.close)/range;
   if(location<.65||!(body/range>=.45||wick/range>=.4))continue;
   if(bars.slice(i+1).some(p=>long?p.low<b.low:p.high>b.high))return {...wait,reason:'REACTION_INVALIDATED'};
   return {revision:TIMED_REACTION_REVISION,ready:true,reason:null,atr5m:atr,
    confirmation:{...b,bodyFraction:body/range,rejectionFraction:wick/range,directionalCloseLocation:location}};
  }
  return wait;
 } catch {return {...wait,reason:'REACTION_DATA_UNAVAILABLE'};}
}
