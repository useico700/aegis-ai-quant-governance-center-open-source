// Pure research functions. No account, network, credential or order imports.
import { confirmedPivots } from '../../agents/orion-v2/paper/paper-engine.mjs';
import { fvgInventory, select4hMainTarget, netSpace, labelScopedSwings } from '../../reports/strategy-research/20261013-intersection-entry-fvg/prototype.mjs';
export { netSpace };
export const MINUTE=60000, QUARTER=900000;
export function wilderAtr(bars) {
  let v=null, sum=0;
  for(let i=0;i<bars.length;i++) {
    const b=bars[i], c=bars[i-1]?.close??b.close;
    const tr=Math.max(b.high-b.low,Math.abs(b.high-c),Math.abs(b.low-c));
    if(i<14) {sum+=tr;if(i===13)v=sum/14;} else v=(v*13+tr)/14;
  } return v;
}
export function validateBars(bars,width) {
  if(!bars.length || bars.some((b,i)=>![b.openTime,b.closeTime,b.open,b.high,b.low,b.close].every(Number.isFinite)
    || b.openTime%width || b.closeTime!==b.openTime+width-1 || b.low<=0 || b.low>Math.min(b.open,b.close)
    || b.high<Math.max(b.open,b.close) || (i&&b.openTime!==bars[i-1].openTime+width))) throw Error('HISTORY_GAP_OR_INVALID');
  return bars;
}
export function directionDecision(plan,bars,now,tick) {
  const open=Math.floor(plan.intersectionTime/QUARTER)*QUARTER;
  for(let i=0;i<2;i++) {
    const b=bars.find(v=>v.openTime===open+i*QUARTER && v.closeTime<now);
    if(!b)return {state:'WAIT_DIRECTION'};
    const px=plan.intersectionPrice;
    const direction=b.close>=px*1.0005?'LONG':b.close<=px*.9995?'SHORT':null;
    if(!direction)continue;
    const sign=direction==='LONG'?1:-1, known=bars.filter(v=>v.closeTime<b.openTime);
    const level=confirmedPivots(known,sign===1?'HIGH':'LOW').at(-1);
    const protection=confirmedPivots(known,sign===1?'LOW':'HIGH').filter(p=>p.time>(level?.time??Infinity)).at(-1);
    const evidence={direction,confirmedAt:b.closeTime,confirmationClose:b.close,level:level??null,protection:protection??null};
    if(!level)return {...evidence,state:'NO_CONFIRMED_MICRO_LEVEL'};
    const boundary=level.price+sign*tick;
    if(!(sign*(b.close-boundary)>=-1e-10 && sign*(known.at(-1).close-boundary)<=1e-10))return {...evidence,state:'NO_FRESH_MICRO_BREAK'};
    if(!protection)return {...evidence,state:'NO_CONFIRMED_PROTECTION'};
    if(bars.some(v=>v.openTime>protection.time&&v.closeTime<=b.closeTime&&(sign===1?v.low<protection.price:v.high>protection.price)))return {...evidence,state:'PROTECTION_BROKEN'};
    const buffer=Math.max(2*tick,.1*wilderAtr([...known,b]));
    const raw=protection.price-sign*buffer;
    const stop=(sign===1?Math.floor(raw/tick+1e-8):Math.ceil(raw/tick-1e-8))*tick;
    return {...evidence,state:'CONFIRMED',stop,buffer,deadline:Math.min(b.closeTime+180000,plan.intersectionTime+1800000)};
  }
  return {state:'NO_DIRECTION_IN_TWO_BARS'};
}
const rows=bars=>bars.map(b=>[b.openTime,b.open,b.high,b.low,b.close,b.volume??0,b.closeTime]);
export function chooseTarget({bars4h,decision,entry,tick,now,policy}) {
  if(bars4h.length<30)return {state:'NO_4H_HISTORY'};
  const inv=fvgInventory({rows:rows(bars4h),width:14400000,timeframe:'4H',tickSize:tick,now});
  const zones=inv.zones.map(z=>({...z,targetEligible:z.quality&&z.ageBars<=200&&z.fill<.75&&!z.closeInvalid}));
  try {
    const result=select4hMainTarget({zones,direction:decision.direction,entry,stop:decision.stop,tickSize:tick,now,
      minimumNetR:policy.minimumNetR,feeRate:policy.feeRate,slippageRate:policy.slippageRate,fundingReserveRate:policy.fundingReserveRate});
    if(result.riskPerUnit) {
      result.costR=((entry+result.target)*(policy.feeRate+policy.slippageRate)+entry*policy.fundingReserveRate)/result.riskPerUnit;
      if(result.costR>policy.maxCostR)result.state='COST_R_TOO_HIGH';
    }
    result.zone=zones.find(z=>z.id===result.barrier)??null;
    return result;
  } catch {return {state:'ENTRY_STOP_OR_TARGET_INVALID'};}
}
export function structureLabels(symbol,bars,tick,timeframe) {
  const points=[];
  for(const level of [1,2,4,8])for(const kind of ['HIGH','LOW']) {
    const n=(timeframe==='4H'?3:timeframe==='1H'?4:2)*level;
    for(const p of confirmedPivots(bars,kind,{leftBars:n,rightBars:n}).slice(-3))points.push({...p,kind,symbol,timeframe,level:String(level),id:`${timeframe}:${level}:${kind}:${p.time}`});
  }
  return labelScopedSwings(points,Infinity,tick).filter(p=>p.label!=='UNCLASSIFIED');
}
export function netAt(t,price) {
  return t.sign*(price-t.entry)-(t.entry+price)*t.costRate-t.entry*t.fundingRate;
}
export function priceAtNetR(t,r) {
  return (r*t.riskPerUnit+t.sign*t.entry+t.entry*(t.costRate+t.fundingRate))/(t.sign-t.costRate);
}
export function createTrade({plan,decision,target,entry,enteredAt,policy,variant='F1'}) {
  return {id:plan.id,symbol:plan.symbol,direction:decision.direction,sign:decision.direction==='LONG'?1:-1,variant,
    entry,enteredAt,stop:decision.stop,initialStop:decision.stop,target:target.target,targetZone:target.zone,
    riskPerUnit:target.riskPerUnit,plannedNetR:target.netR,costRate:policy.feeRate+policy.slippageRate,fundingRate:policy.fundingReserveRate,
    remaining:1,realizedPerUnit:0,stage:0,status:'OPEN',mfeR:0,events:[],lastAt:enteredAt-1,entryModel:policy.entry};
}
function exit(t,price,fraction,at,reason) {
  const q=Math.min(t.remaining,fraction);t.realizedPerUnit+=q*netAt(t,price);t.remaining=Math.max(0,t.remaining-q);
  t.events.push({at,price,fraction:q,reason});
  if(t.remaining<1e-9){t.remaining=0;t.status='CLOSED';t.closedAt=at;t.netR=t.realizedPerUnit/t.riskPerUnit;t.reason=reason;}
}
function atPrice(t,p,at) {
  if(t.status!=='OPEN')return;
  // Gap stops fill at the worse observed opening price, never at an invented stop quote.
  if(t.sign*(p-t.stop)<=1e-9){exit(t,p,1,at,'STOP');return;}
  t.mfeR=Math.max(t.mfeR,netAt(t,p)/t.riskPerUnit);
  if(t.sign*(p-t.target)>=-1e-9){exit(t,t.target,1,at,'4H_TARGET');return;}
  if(t.variant==='F1') {
    const r=netAt(t,p)/t.riskPerUnit;
    const stage=r>=2-1e-9?2:r>=1-1e-9?1:0;
    if(stage>t.stage) {t.stage=stage;t.stop=priceAtNetR(t,stage-1);t.events.push({at,reason:'PROTECT_NET_R',netR:stage-1,price:t.stop});}
  } else {
    for(const [i,r,q] of [[1,.5,.4],[2,1,.25],[3,2,.2]])if(t.stage<i&&netAt(t,p)/t.riskPerUnit>=r-1e-9){exit(t,priceAtNetR(t,r),q,at,'PARTIAL_MODEL');t.stage=i;}
  }
}
function segment(t,a,b,at) {
  if(t.status!=='OPEN')return;
  const favorable=t.sign*(b-a)>0;
  if(!favorable){if(t.sign*(b-t.stop)<=0)atPrice(t,t.stop,at);return;}
  const thresholds=t.variant==='F1'?[1,2]:[.5,1,2];
  const levels=[...thresholds.map(r=>priceAtNetR(t,r)),t.target].filter(p=>t.sign*(p-a)>1e-9&&t.sign*(b-p)>=-1e-9).sort((x,y)=>t.sign*(x-y));
  for(const p of levels)atPrice(t,p,at);
  if(t.status==='OPEN')atPrice(t,b,at);
}
function path(t,prices,bar) {
  const v=structuredClone(t);atPrice(v,prices[0],bar.openTime);
  for(let i=1;i<prices.length;i++)segment(v,prices[i-1],prices[i],bar.closeTime);
  v.lastAt=bar.closeTime;return v;
}
export function advanceMinute(trade,bar) {
  if(trade.status!=='OPEN')return trade;
  if(bar.openTime!==trade.lastAt+1)return {...trade,status:'DATA_GAP',reason:'MINUTE_HISTORY_GAP',netR:null};
  const a=path(trade,[bar.open,bar.high,bar.low,bar.close],bar),b=path(trade,[bar.open,bar.low,bar.high,bar.close],bar);
  const equal=a.status===b.status&&Math.abs(a.remaining-b.remaining)<1e-9&&Math.abs(a.realizedPerUnit-b.realizedPerUnit)<1e-8&&Math.abs(a.stop-b.stop)<1e-8;
  // Extremum order cannot establish queue or the full tick path; differing
  // exit/stop outcomes are explicitly censored, never cherry-picked as wins.
  if(!equal)return {...trade,status:'PATH_UNCERTAIN',reason:'INTRAMINUTE_ORDER_UNKNOWN',ambiguousAt:bar.openTime,netR:null,
    possibleNetR:[a.status==='CLOSED'?a.netR:null,b.status==='CLOSED'?b.netR:null]};
  return {...a,mfeR:Math.max(a.mfeR,b.mfeR)};
}
