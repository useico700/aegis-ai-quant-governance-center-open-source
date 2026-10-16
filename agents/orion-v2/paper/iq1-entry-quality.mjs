// IQ1 is an additive paper admission policy. This module never sends orders.
import { createHash } from 'node:crypto';
export const IQ1_REVISION = 'V2-IQ1-P1-20260915';
export const IQ1_AUTHORIZATION = 'OWNER-DIRECTIVE-V2-IQ1-EXECUTION-20260915';
const I = 900000;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
export const iq1Digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const out = (status, reason, metrics = {}) => ({ allowed: status === 'PASS', status, reason,
  terminal: status === 'REJECT', revision: IQ1_REVISION, metrics });

export function validateIq1Profile(p, risk) {
  if (p?.revision !== IQ1_REVISION) throw new Error('IQ1_PROFILE_REVISION_INVALID');
  for (const k of ['atrPeriod','compressionBars','maximumGroupPositions'])
    if (!Number.isInteger(p[k]) || p[k] < 1) throw new Error(`IQ1_PROFILE_${k}`);
  for (const k of ['maximumCompressionRatio','maximumCrossAnchorDelayMs','minimumPostCrossExpansionAtr',
    'minimumLatestProgressAtr','maximumPxBps','maximumPxAtr','maximumCrossAgeMs','minimumPositiveCorrelation',
    'maximumGroupRiskFraction','maximumGroupNotionalLeverage','maximumCorrelationAgeMs','maximumQuoteAgeMs'])
    if (!positive(p[k])) throw new Error(`IQ1_PROFILE_${k}`);
  if (p.maximumCompressionRatio >= 1 || p.minimumPositiveCorrelation >= 1 ||
    JSON.stringify(p.correlationWindows) !== '[96,288]' ||
    p.maximumGroupPositions > risk.maximumOpenPositionsTotal || p.maximumGroupRiskFraction > risk.maximumPortfolioRiskFraction ||
    p.maximumGroupNotionalLeverage > risk.maximumLeverage) throw new Error('IQ1_PROFILE_SCOPE_INVALID');
  if (p.pxDistanceGateEnabled !== undefined && typeof p.pxDistanceGateEnabled !== 'boolean')
    throw new Error('IQ1_PROFILE_pxDistanceGateEnabled');
  if (p.maximumDecisionCloseDisplacementBps !== undefined && !positive(p.maximumDecisionCloseDisplacementBps))
    throw new Error('IQ1_PROFILE_maximumDecisionCloseDisplacementBps');
  return p;
}

export function contiguousBars(bars, lastClose, count) {
  const a = (bars ?? []).filter(b => finite(b.closeTime) && b.closeTime <= lastClose).slice(-count);
  if (a.length !== count || a.at(-1).closeTime !== lastClose) return null;
  for (let j=0;j<a.length;j++) {
    const b=a[j];
    if (![b.open,b.high,b.low,b.close].every(positive) || b.high<Math.max(b.open,b.close) ||
      b.low>Math.min(b.open,b.close) || b.high<b.low || b.closeTime!==b.openTime+I-1 ||
      (j && b.openTime!==a[j-1].openTime+I)) return null;
  }
  return a;
}

export function freezeIq1Context(plan, bars, p, observedAt) {
  const tx=plan.intersectionTime, px=plan.intersectionPrice;
  if (!positive(tx) || !positive(px) || !finite(observedAt) || observedAt>tx || !finite(plan.createdAt) || plan.createdAt>tx ||
    !Array.isArray(plan.anchors) || plan.anchors.length!==4 || plan.anchors.some(a=>!finite(a.confirmedAt)||a.confirmedAt>tx)) return null;
  const last=Math.floor(tx/I)*I-1, count=Math.max(p.atrPeriod*4+1,p.compressionBars*2);
  const a=contiguousBars(bars,last,count); if (!a || last>observedAt) return null;
  const tr=a.slice(1).map((b,j)=>Math.max(b.high-b.low,Math.abs(b.high-a[j].close),Math.abs(b.low-a[j].close)));
  let atr=tr.slice(0,p.atrPeriod).reduce((x,y)=>x+y,0)/p.atrPeriod;
  for (const v of tr.slice(p.atrPeriod)) atr=((p.atrPeriod-1)*atr+v)/p.atrPeriod;
  const width=xs=>Math.max(...xs.map(b=>b.high))-Math.min(...xs.map(b=>b.low));
  const recent=width(a.slice(-p.compressionBars)), prior=width(a.slice(-2*p.compressionBars,-p.compressionBars));
  const lineAt=(l,t)=>l?.anchorPrice+l?.slope*(t/I-l?.anchorTime);
  const gap0=Math.abs(lineAt(plan.fourHourLine,tx-I)-lineAt(plan.oneHourLine,tx-I));
  const gap1=Math.abs(lineAt(plan.fourHourLine,tx)-lineAt(plan.oneHourLine,tx));
  const geometric=[gap0,gap1].every(finite)&&gap0>gap1&&gap1<=Math.max(1e-7,px*1e-8);
  if (!positive(atr)||!positive(prior)||!geometric) return null;
  return {eventId:plan.id,symbol:plan.symbol,tx,px,atr,compressionRatio:recent/prior,
    dataCutoff:last,observedAt,profileRevision:p.revision,structureDigest:iq1Digest({tx,px,anchors:plan.anchors}),
    source:'PRE_CROSS_CLOSED_15M_AND_ORIGINAL_STRUCTURE'};
}

export function consecutiveIq1Trades(previous, next) {
  try { return previous?.tradeId != null && next?.tradeId != null &&
    BigInt(next.tradeId) === BigInt(previous.tradeId) + 1n; } catch { return false; }
}
export function iq1Anchor(context, trade, previousTrade, epoch, p) {
  if (!context || !trade || !previousTrade || !consecutiveIq1Trades(previousTrade,trade) || trade.epoch!==epoch || previousTrade.epoch!==epoch ||
    !positive(trade.price) || !finite(trade.marketTime) || !finite(trade.receivedAt) ||
    !finite(previousTrade.marketTime) || previousTrade.marketTime>=context.tx || trade.marketTime<context.tx ||
    context.tx-previousTrade.marketTime>p.maximumCrossAnchorDelayMs ||
    trade.marketTime-context.tx>p.maximumCrossAnchorDelayMs ||
    !finite(previousTrade.receivedAt) || previousTrade.receivedAt>trade.receivedAt ||
    Math.abs(trade.receivedAt-trade.marketTime)>p.maximumCrossAnchorDelayMs ||
    context.observedAt>trade.receivedAt) return null;
  return {...trade,previousTrade,context,epoch};
}

function rho(x,y) {
  const mx=x.reduce((a,b)=>a+b,0)/x.length,my=y.reduce((a,b)=>a+b,0)/y.length;
  let xx=0,yy=0,xy=0;for(let j=0;j<x.length;j++){const a=x[j]-mx,b=y[j]-my;xx+=a*a;yy+=b*b;xy+=a*b;}
  return xx>0&&yy>0?xy/Math.sqrt(xx*yy):null;
}
export function buildIq1Correlation(bundles,symbols,p,marketNow,receivedAt) {
  const cutoff=Math.floor(marketNow/I)*I-1, returns={};
  for(const s of symbols){const a=contiguousBars(bundles[s]?.bars15m,cutoff,289);
    if(!a)return {valid:false,reason:'CORRELATION_UNKNOWN',symbol:s,cutoff,receivedAt};
    returns[s]=a.slice(1).map((b,j)=>Math.log(b.close/a[j].close));}
  const edges=[],pairs=[];
  for(let i=0;i<symbols.length;i++)for(let j=i+1;j<symbols.length;j++){
    const a=symbols[i],b=symbols[j],values=p.correlationWindows.map(n=>rho(returns[a].slice(-n),returns[b].slice(-n)));
    if(!values.every(finite))return {valid:false,reason:'CORRELATION_UNKNOWN',symbol:a+'/'+b,cutoff,receivedAt};
    pairs.push({a,b,values});if(values.every(v=>v>=p.minimumPositiveCorrelation))edges.push([a,b]);
  }
  const groups={};
  for(const s of symbols){const set=new Set([s]);let changed=true;while(changed){changed=false;for(const [a,b] of edges){
    if(set.has(a)!==set.has(b)){set.add(a);set.add(b);changed=true;}}}groups[s]=[...set].sort();}
  return {valid:true,cutoff,receivedAt,groups,pairs,returnSeries:returns,id:iq1Digest({cutoff,pairs,returns})};
}

export function evaluateIq1Shape({plan,signal,quote,anchor,profile:p,now,localNow,loadedAt,epoch,bars,slippageRate=0}) {
  if(!positive(now)||!positive(localNow)||!positive(loadedAt))return out('UNKNOWN','IQ1_CLOCK_UNKNOWN');
  if(plan.intersectionTime<loadedAt)return out('REJECT','IQ1_PRE_ACTIVATION_EVENT');
  if(now>Math.min(signal.bar.closeTime+180000,plan.intersectionTime+p.maximumCrossAgeMs))return out('REJECT','IQ1_EXPIRED');
  if(plan.iq1Invalidation)return out(plan.iq1Invalidation.status,plan.iq1Invalidation.reason);
  if(!anchor || anchor.epoch!==epoch || anchor.context?.eventId!==plan.id)return out('UNKNOWN','IQ1_CROSS_ANCHOR_MISSING');
  const c=anchor.context;
  if(c.structureDigest!==iq1Digest({tx:plan.intersectionTime,px:plan.intersectionPrice,anchors:plan.anchors}) ||
    c.profileRevision!==p.revision)return out('REJECT','IQ1_STRUCTURE_CHANGED');
  if(anchor.receivedAt>localNow || anchor.marketTime>=signal.bar.closeTime || signal.bar.closeTime>now ||
    c.dataCutoff>=plan.intersectionTime || !positive(c.atr))return out('UNKNOWN','IQ1_DATA_UNKNOWN');
  const s=signal.direction,q=s===1?quote?.ask:quote?.bid;
  if(![1,-1].includes(s)||!positive(q)||!positive(quote?.bid)||!positive(quote?.ask)||quote.ask<quote.bid||
    !finite(quote.marketTime)||!finite(quote.receivedAt)||quote.marketTime>now||quote.receivedAt>localNow||
    now-quote.marketTime>p.maximumQuoteAgeMs||localNow-quote.receivedAt>p.maximumQuoteAgeMs||quote.coverageComplete!==true)
    return out('UNKNOWN','IQ1_QUOTE_UNKNOWN');
  const modeledEntry=q*(1+s*slippageRate);
  if(!finite(slippageRate)||slippageRate<0||!positive(modeledEntry))return out('UNKNOWN','IQ1_EXECUTION_PRICE_UNKNOWN');
  const m={px:c.px,atr:c.atr,modeledEntry,pxBps:Math.max(Math.abs(q/c.px-1),Math.abs(modeledEntry/c.px-1))*10000,
    pxAtr:Math.max(Math.abs(q-c.px),Math.abs(modeledEntry-c.px))/c.atr,
    decisionCloseBps:Math.max(Math.abs(q/signal.bar.close-1),Math.abs(modeledEntry/signal.bar.close-1))*10000,
    compressionRatio:c.compressionRatio,crossAgeMs:now-c.tx};
  if(positive(p.maximumDecisionCloseDisplacementBps)&&m.decisionCloseBps>p.maximumDecisionCloseDisplacementBps)
    return out('REJECT','IQ1_DECISION_CLOSE_DISPLACEMENT',m);
  if(p.pxDistanceGateEnabled!==false&&(m.pxBps>p.maximumPxBps||m.pxAtr>p.maximumPxAtr))return out('REJECT','IQ1_PX_DISTANCE_EXCEEDED',m);
  if(!finite(c.compressionRatio)||c.compressionRatio>p.maximumCompressionRatio)return out('REJECT','IQ1_NO_CONVERGENCE',m);
  if(p.pxDistanceGateEnabled!==false&&(Math.abs(anchor.price/c.px-1)*10000>p.maximumPxBps||Math.abs(anchor.price-c.px)/c.atr>p.maximumPxAtr))
    return out('REJECT','IQ1_PROJECTED_CROSS_FAR_FROM_PRICE',m);
  const a=contiguousBars(bars,signal.bar.closeTime,2);
  if(!a||a[1].close!==signal.bar.close)return out('UNKNOWN','IQ1_CONFIRMATION_DATA_UNKNOWN',m);
  m.postCrossExpansionAtr=s*(signal.bar.close-anchor.price)/c.atr;
  m.latestProgressAtr=s*(signal.bar.close-a[0].close)/c.atr;
  if(s*(signal.bar.close-c.px)<c.px*0.0005||s*(q-c.px)<c.px*0.0005)return out('REJECT','IQ1_WRONG_PX_SIDE',m);
  if(m.postCrossExpansionAtr<p.minimumPostCrossExpansionAtr)return out('REJECT','IQ1_NO_POST_CROSS_EXPANSION',m);
  if(m.latestProgressAtr<p.minimumLatestProgressAtr)return out('REJECT','IQ1_RETURNING_NOT_EXPANDING',m);
  return out('PASS','IQ1_SHAPE_PASSED',m);
}

export function evaluateIq1Portfolio({candidate,positions,pending=[],correlation:c,profile:p,equity,now,localNow,replacementId=null}) {
  if(!c?.valid||!finite(c.cutoff)||!finite(c.receivedAt)||c.cutoff>=now||c.receivedAt>localNow||
    now-c.cutoff>p.maximumCorrelationAgeMs||!positive(equity)||!positive(candidate?.entry)||
    !positive(candidate?.quantity)||!finite(candidate?.plannedRiskUsdt)||candidate.plannedRiskUsdt<0||![1,-1].includes(candidate?.direction))
    return out('UNKNOWN','IQ1_CORRELATION_OR_CAPACITY_UNKNOWN');
  const group=c.groups[candidate.symbol];if(!group?.includes(candidate.symbol))return out('UNKNOWN','IQ1_CORRELATION_UNKNOWN');
  const old=positions.find(x=>x.id===replacementId);
  if(replacementId&&(!old||old.symbol!==candidate.symbol||old.direction===candidate.direction))return out('UNKNOWN','IQ1_REPLACEMENT_ID_INVALID');
  const peers=[...positions.filter(x=>x.id!==replacementId),...pending].filter(x=>group.includes(x.symbol));
  if(peers.some(x=>![1,-1].includes(x.direction)||!positive(x.entry)||!positive(x.quantity)||!finite(x.plannedRiskUsdt)||x.plannedRiskUsdt<0))
    return out('UNKNOWN','IQ1_POSITION_EVIDENCE_UNKNOWN');
  if(peers.some(x=>x.direction!==candidate.direction))return out('REJECT','IQ1_CORRELATED_OPPOSITE_EXPOSURE',{group,conflicts:peers.filter(x=>x.direction!==candidate.direction).map(x=>x.id)});
  const count=peers.length+1,risk=peers.reduce((v,x)=>v+x.plannedRiskUsdt,0)+candidate.plannedRiskUsdt;
  const notional=peers.reduce((v,x)=>v+x.entry*x.quantity,0)+candidate.entry*candidate.quantity;
  const metrics={group,count,risk,notional,correlationId:c.id,correlationEventId:c.eventId,cutoff:c.cutoff};
  if(count>p.maximumGroupPositions||risk>equity*p.maximumGroupRiskFraction+1e-8||notional>equity*p.maximumGroupNotionalLeverage+1e-8)
    return out('WAIT','IQ1_CORRELATED_GROUP_CAPACITY',metrics);
  return out('PASS','IQ1_PORTFOLIO_PASSED',metrics);
}

export function compareIq1Candidates(a,b) {
  for(const k of ['pxAtr','crossAgeMs','costR','spreadBps']){
    const av=finite(a[k])?a[k]:Infinity,bv=finite(b[k])?b[k]:Infinity;
    if(av!==bv)return av<bv?-1:1;
  }
  return String(a.symbol).localeCompare(String(b.symbol))||String(a.eventId).localeCompare(String(b.eventId));
}
