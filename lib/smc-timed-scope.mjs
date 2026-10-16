import { reaction15m } from './smc-15m-reaction.mjs';
import { smcBars, confirmedSmcPivots } from './smc-bar-evidence.mjs';
import { timedReaction } from './smc-timed-reaction.mjs';
export const TIMED_SCOPE_REVISION='SMC-TIMED-SCOPE-1';
export function localTimedBasis({context,plan,now,buffer}) {
 try {
  if(plan.tradeScope!==TIMED_SCOPE_REVISION||plan.discoveryRevision!=='SMC-TIMED-ENTRY-1'||plan.symbol!==context.symbol)return null;
  const bars=smcBars(context.scopeBars15m,900000,now),long=plan.direction==='LONG',a=plan.anchor;
  const points=confirmedSmcPivots(bars).filter(p=>p.kind===(long?'LOW':'HIGH'));
  const i=points.findIndex(p=>p.time===a.time&&p.price===a.price&&p.confirmedAt===a.confirmedAt);
  if(i<1||a.confirmedAt>plan.availableAt||plan.availableAt>now||!(long?a.price>points[i-1].price:a.price<points[i-1].price)
    ||!(long?plan.zone.low===a.price:plan.zone.high===a.price)
    ||bars.slice(points[i].index+1).some(b=>long?b.close<a.price:b.close>a.price))return null;
  return {ready:true,reason:null,timeframe:'15m',kind:'LOCAL_TIMED_INVALIDATION',point:{kind:a.kind,price:a.price,time:a.time,confirmedAt:a.confirmedAt},
    buffer,availableAt:bars.at(-1).closeTime,scopeRevision:TIMED_SCOPE_REVISION};
 }catch{return null;}
}
export function validateTimedScopeTrigger(plan,context,now) {
 const dual=plan.timeframeProfile==='SMC-4H15M-1';
 if(dual&&context.timeframeProfile!=='SMC-4H15M-1')return false;
 return !!localTimedBasis({context,plan,now,buffer:context.tickSize*2})?.ready&&(dual ? reaction15m(plan,context.bars15m,now) : timedReaction(plan,context.bars5m,now)).ready;
}
