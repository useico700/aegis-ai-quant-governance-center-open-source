import { PLAN_RISK_REVISION, validatePlanRiskScope, main15mStopBasis } from './smc-risk-scope.mjs';
import { smcBars, confirmedSmcPivots } from './smc-bar-evidence.mjs';
import { reviewRetestTiming } from './smc-retest-timing.mjs';
export const PULLBACK_SCOPE_REVISION = 'SMC-PULLBACK-SCOPE-1';
const finite = Number.isFinite;

// Directional context, not an instruction to put every stop at the macro low/high.
export function parentSupportsPullback(plan, parent, now) {
  const long = plan.direction === 'LONG', event = parent?.lastExternalEvent;
  const start = Number(parent?.episodeId?.split(':').at(-2));
  const p = parent?.protectedPoint;
  return parent?.status === 'READY' && parent.bias === (long ? 'BULLISH' : 'BEARISH')
    && finite(parent.availableAt) && parent.availableAt <= now && now-parent.availableAt <= 14520000
    && !!parent.episodeId && !!p && p.kind === (long ? 'LOW' : 'HIGH')
    && event && ['BOS','TREND_CONFIRMED'].includes(event.type) && event.scope === 'EXTERNAL'
    && event.direction === plan.direction && event.episodeId === parent.episodeId
    && finite(event.at) && finite(event.endpointAvailableAt) && event.endpointAvailableAt < event.at-14400000+1
    && finite(start) && start <= plan.anchor.confirmedAt && start <= event.at && event.at <= parent.availableAt
    && finite(p.price) && p.price > 0 && finite(p.confirmedAt) && p.confirmedAt <= parent.availableAt
    && (long ? plan.zone.low > p.price : plan.zone.high < p.price);
}

// Only the declared, independently reconstructed 15M HL/LH can define this trade.
// There are deliberately no target or reward/risk arguments.
export function localPullbackBasis({context,plan,now,buffer}) {
  try {
    if (plan.tradeScope !== PULLBACK_SCOPE_REVISION || plan.symbol !== context.symbol
      || !['LONG','SHORT'].includes(plan.direction) || !parentSupportsPullback(plan,context.parentFrame,now)) return null;
    const bars = smcBars(context.scopeBars15m,900000,now), long = plan.direction === 'LONG';
    const a = plan.anchor, pivots = confirmedSmcPivots(bars).filter(p => p.kind === (long?'LOW':'HIGH'));
    const i = pivots.findIndex(p => p.time===a.time && p.price===a.price && p.confirmedAt===a.confirmedAt);
    if (i<1 || a.confirmedAt>plan.availableAt || plan.availableAt>now
      || !(long ? a.price>pivots[i-1].price : a.price<pivots[i-1].price)
      || !(long ? plan.zone.low===a.price : plan.zone.high===a.price)
      || bars.slice(pivots[i].index+1).some(b => long ? b.close<a.price : b.close>a.price)) return null;
    const parent = context.parentFrame;
    // A still-open higher bar cannot conceal a lower-timeframe breach of protection.
    if (bars.filter(b=>b.closeTime>parent.protectedPoint.confirmedAt).some(b=>long?b.low<=parent.protectedPoint.price:b.high>=parent.protectedPoint.price)) return null;
    return {ready:true,reason:null,timeframe:'15m',kind:'LOCAL_PULLBACK_INVALIDATION',
      point:{kind:a.kind,price:a.price,time:a.time,confirmedAt:a.confirmedAt},buffer,
      availableAt:bars.at(-1).closeTime,parentEpisodeId:parent.episodeId,scopeRevision:PULLBACK_SCOPE_REVISION};
  } catch { return null; }
}

// Reconstructed from current server evidence, never trusted from a UI/client flag.
export function validateLocalPullbackTrigger(plan,context,now) {
  try {
    const t = reviewRetestTiming(plan,context.bars5m,now);
    if (!t.ready || t.touchAt<=plan.availableAt || t.confirmation.openTime<=plan.availableAt) return false;
    const bars = smcBars(context.bars5m,300000,now), long=plan.direction==='LONG';
    const visit=bars.filter(b=>b.closeTime>=t.touchAt && b.closeTime<=t.confirmation.closeTime);
    const extreme=long?Math.min(...visit.map(b=>b.low)):Math.max(...visit.map(b=>b.high));
    // Price must test the predeclared anchor, reclaim the zone and displace across a known pivot.
    if (!(long ? extreme<=plan.anchor.price && bars.at(-1).close>plan.zone.high
      : extreme>=plan.anchor.price && bars.at(-1).close<plan.zone.low)) return false;
    if (bars.filter(b=>b.closeTime>t.confirmation.closeTime).some(b=>long?b.low<=extreme:b.high>=extreme)) return false;
    return true;
  } catch { return false; }
}

export function validatedPullbackPlan(plans,symbol,direction,context,now,active=()=>true) {
  const main = plans?.find(p=>p.symbol===symbol && p.direction===direction && p.riskScopeRevision===PLAN_RISK_REVISION
    && p.expiresAt>now && now-p.observedAt<=360000 && active(p));
  if(main) {
    try { validatePlanRiskScope(main);
      if(main15mStopBasis(context?.localFrame,direction,main.entry,now,context.tickSize*2).ready) return main;
    } catch { /* Invalid scope cannot grant a smaller manual stop. */ }
  }
  return plans?.find(p=>p.symbol===symbol && p.direction===direction && p.tradeScope===PULLBACK_SCOPE_REVISION
    && p.expiresAt>now && now-p.observedAt<=360000 && active(p)
    && localPullbackBasis({context,plan:p,now,buffer:context?.tickSize*2})?.ready
    && validateLocalPullbackTrigger(p,context,now)) ?? null;
}
