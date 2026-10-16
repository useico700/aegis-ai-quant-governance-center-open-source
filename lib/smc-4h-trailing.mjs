import { supports4hTarget } from './smc-target-policy.mjs';
import { stopSafetyMetrics } from './smc-stop-safety.mjs';
export const SMC_TRAIL_REVISION='SMC-4H-TRAIL-1';
// Pure proposal. The existing single writer installs and verifies protection.
export function smc4hTrailProposal({plan,position,context,quote,now}) {
  const hold=reason=>({changed:false,reason,proposed:position});
  if(plan.smcTrailPolicy!==SMC_TRAIL_REVISION)return hold('ORIGINAL_POSITION_POLICY');
  const direction=position.direction===1?'LONG':'SHORT',long=direction==='LONG',frame=context?.parentFrame;
  const executable=Number(long?quote?.bid:quote?.ask),p=frame?.protectedPoint;
  if(!supports4hTarget(frame,direction,executable,now))return hold('WAIT_CONFIRMED_4H_PROTECTION');
  if(!Number.isFinite(position.openedAt)||p.time<position.openedAt||p.confirmedAt<=position.openedAt)
    return hold('WAIT_POST_ENTRY_4H_SWING');
  if(!quote?.persisted||!quote.continuity||![quote.marketTime,quote.receivedAt].every(t=>Number.isFinite(t)&&now-t>=-1000&&now-t<=2000))return hold('TRAIL_QUOTE_STALE');
  let metrics;try{metrics=stopSafetyMetrics(context,plan.symbol,now);}catch{return hold('TRAIL_CONTEXT_UNAVAILABLE');}
  const atr=frame.geometry?.atr,tick=metrics.tickSize;
  if(!(atr>0))return hold('TRAIL_4H_ATR_UNAVAILABLE');
  const buffer=Math.max(atr*.2,metrics.noiseDistance,tick*2);
  const raw=p.price+(long?-buffer:buffer);
  const stop=Number(((long?Math.floor(raw/tick+1e-8):Math.ceil(raw/tick-1e-8))*tick).toPrecision(12));
  if(!(stop>0)||!(long?stop>Number(position.stop)&&executable-stop>=buffer:stop<Number(position.stop)&&stop-executable>=buffer))return hold('KEEP_STRONGER_EXISTING_STOP');
  if(!(long?executable>Number(position.entry):executable<Number(position.entry)))return hold('WAIT_FAVORABLE_PRICE');
  return {changed:true,reason:'CONFIRMED_4H_PROTECTION_ADVANCED',proposed:{...position,stop:String(stop),
    smcTrailEvidence:{revision:SMC_TRAIL_REVISION,point:p,buffer,sourceAt:frame.availableAt,quoteAt:quote.marketTime}}};
}
