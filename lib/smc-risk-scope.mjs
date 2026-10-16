// Prospective 4H objective / 15M main protection contract. No order authority.
export const PLAN_RISK_REVISION = 'SMC-PLAN-RISK-1';
export function main15mStopBasis(frame, direction, entry, now, buffer) {
 const long=direction==='LONG',p=frame?.protectedPoint;
 const bad={ready:false,reason:'SMC_STOP_MAIN15M_UNCONFIRMED',timeframe:'15m',kind:'MAIN_15M_PROTECTION'};
 if(!['LONG','SHORT'].includes(direction)||frame?.status!=='READY'||frame.bias!==(long?'BULLISH':'BEARISH')
  ||!Number.isFinite(frame.availableAt)||frame.availableAt>now||now-frame.availableAt>1020000
  ||!p||p.kind!==(long?'LOW':'HIGH')||!Number.isFinite(p.price)||p.price<=0
  ||!Number.isFinite(p.time)||!Number.isFinite(p.confirmedAt)||p.time>=p.confirmedAt||p.confirmedAt>frame.availableAt
  ||!Number.isFinite(buffer)||buffer<=0) return bad;
 return {ready:true,reason:null,timeframe:'15m',kind:'MAIN_15M_PROTECTION',point:p,
  entryValid:long?entry>p.price:entry<p.price,buffer,availableAt:frame.availableAt};
}
export function validatePlanRiskScope(plan) {
 if(plan.riskScopeRevision==null)return true; // frozen legacy policy
 if(plan.riskScopeRevision!==PLAN_RISK_REVISION||plan.targetPolicyRevision!=='SMC-TARGET-4H-2'
  ||plan.timeframeProfile!=='SMC-4H15M-1'||plan.tradeScope!==null)throw new Error('SMC_PLAN_RISK_SCOPE_INVALID');
 const buffer=Math.max(.2*plan.entryReview?.atr15m,plan.tickSize*2);
 const expected=main15mStopBasis(plan.targetBasis?.directionSupport?.local,plan.direction,plan.entry,plan.observedAt,buffer),b=plan.stopBasis;
 if(!b||b.kind!==expected.kind||b.ready!==expected.ready||b.timeframe!=='15m')throw new Error('SMC_PLAN_RISK_BASIS_MISMATCH');
 if(!expected.ready) {
  if(!plan.blockers.includes('STRUCTURAL_STOP_UNCONFIRMED'))throw new Error('SMC_PLAN_RISK_UNCONFIRMED');
  return true;
 }
 if(b.entryValid!==expected.entryValid || ['kind','price','time','confirmedAt'].some(k=>b.point?.[k]!==expected.point[k])
  ||Math.abs(b.buffer-buffer)>1e-10||b.availableAt!==expected.availableAt
  ||plan.direction==='LONG'&&plan.stop>expected.point.price-buffer+1e-10
  ||plan.direction==='SHORT'&&plan.stop<expected.point.price+buffer-1e-10)throw new Error('SMC_PLAN_RISK_INSIDE_MAIN_PROTECTION');
 return true;
}
