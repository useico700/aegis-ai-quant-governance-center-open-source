import { freezeStructureGeometry, isS2ZRow, usesS2Z, S2_Z_STRUCTURE_REVISION, S2_Z_DECISION_REVISION, S2_Z_RESEARCH_REVISION } from './structure-quality.mjs';
import { sha } from './filter-core.mjs';
import { ENTRY_BAND_BPS,entryBandFraction } from './entry-band.mjs';

export const RESEARCH_REVISION = 'JEV-P5-DECISION-REVIEW-4';
export const S1_IQ1_RESEARCH_REVISION = 'JEV-R221-IQ1-PRE-GATE-REVIEW-1';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const stamp = value => Date.parse(value);
const rowRevision=(account,row)=>isS2ZRow(account,row)?S2_Z_RESEARCH_REVISION
  :row?.decision?.revision==='JEV-R221-IQ1-PRE-GATE-DECISION-1'?S1_IQ1_RESEARCH_REVISION:RESEARCH_REVISION;
export const trialKey = (account,row) => sha({revision:rowRevision(account,row),account,plan:row.id,direction:row.direction});

// Eligibility is an observed research event, not an execution permission. A
// five-minute sampler cannot claim it saw the first intrabar eligibility time.
export function observedOpportunity(account, row, market, now) {
  const bid=Number(market?.quote?.bid),ask=Number(market?.quote?.ask);
  const at=stamp(market?.asOf), sign=row.direction==='LONG'?1:-1;
  const price=sign===1?ask:bid, distance=sign*(price/row.px-1);
  const s1Iq1=row?.decision?.revision==='JEV-R221-IQ1-PRE-GATE-DECISION-1';
  return row.stage==='LOCKED' && stamp(row.intersectionTime)<=at && finite(at)
    && now-at>=0 && now-at<=60000 && bid>0 && ask>=bid && row.px>0 && distance>0
    && (s1Iq1||distance<=entryBandFraction(account)+1e-12);
}

export function independentTrials(rows) {
  const until=new Map();
  return [...rows].sort((a,b)=>a.frozenAt-b.frozenAt||a.key.localeCompare(b.key)).filter(row=>{
    const group=`${row.account}:${row.symbol}`;
    if(row.frozenAt<(until.get(group)??-Infinity))return false;
    until.set(group,row.deadlineAt); return true;
  });
}
export function calibrationAt(rows, account, probability, at, revision=RESEARCH_REVISION) {
  const bin=Math.min(4,Math.floor(probability*5));
  const cohort=revision===S2_Z_RESEARCH_REVISION?rows.filter(r=>r.revision===revision):rows;
  const past=independentTrials(cohort).filter(r=>r.account===account && r.result?.resolvedAt<at
    && [0,1].includes(r.result?.y) && r.revision===revision && r.model==='jev-1.13.0' && r.judgeRevision===(revision===S2_Z_RESEARCH_REVISION?S2_Z_DECISION_REVISION:revision===S1_IQ1_RESEARCH_REVISION?'JEV-R221-IQ1-PRE-GATE-DECISION-1':'JEV-P5-PLAN-DECISION-3')
    && Math.min(4,Math.floor(r.p*5))===bin);
  return {count:past.length,p:past.length>=20?(past.reduce((sum,r)=>sum+r.result.y,0)+1)/(past.length+2):null};
}

export function freezeTrial(account,row,market,now,history=[],plan=null) {
  const revision=rowRevision(account,row);
  const j=row.decision,target=j?.target??null,quoteAt=stamp(market?.asOf);
  if(revision===S2_Z_RESEARCH_REVISION&&(j?.structure?.status!=='VALID'||!plan?.zStructure||plan.zStructure.geometryHash!==j.structure.geometryHash))return null;
  if(j?.entryConfirmation && !j.entryConfirmation.allowed)return null;
  if(!target||target.planId!==row.id||!finite(quoteAt)||now<quoteAt||now-quoteAt>180000||!observedOpportunity(account,row,market,quoteAt))return null;
  const startAt=target?stamp(target.observedAt):quoteAt;
  const frozenAt=finite(stamp(j?.evaluatedAt))?stamp(j.evaluatedAt):now;
  const deadlineAt=target?stamp(target.deadlineAt):startAt+(account==='S1'?180:60)*60000;
  let p=j?.status==='EVALUATED'&&finite(j.score)?j.score/100:null;
  if(!finite(startAt)||!finite(frozenAt)||frozenAt<startAt||frozenAt>now||deadlineAt<=frozenAt)return null;
  if(!target||frozenAt-startAt>60000)p=null;
  if(target&&![target.favorablePrice,target.adversePrice,target.referencePrice].every(n=>finite(n)&&n>0))return null;
  if(p!==null && (p<0||p>1))return null;
  const calibration=p===null?{count:0,p:null}:calibrationAt(history,account,p,frozenAt,revision);
  return {key:trialKey(account,row),revision,account,...(revision===S2_Z_RESEARCH_REVISION?{structureRevision:S2_Z_STRUCTURE_REVISION,
    structureEvidence:structuredClone(plan.zStructure),structureGeometry:freezeStructureGeometry(plan)}:{}),planId:row.id,symbol:row.symbol,direction:row.direction,
    px:row.px,model:j?.model??null,judgeRevision:j?.revision??null,p,score:j?.score??null,frozenAt,startAt,deadlineAt,
    calibratedP:calibration.p,calibrationN:calibration.count,target,entryConfirmation:j?.entryConfirmation??null,
    managementRevision:j?.entryQuality?.managementRevision??null,
    evidenceHash:row.evidenceHash,inputHash:j?.inputHash??null,metrics:row.metrics,judge:j??null,sources:row.sources??null,
    opportunity:revision===S1_IQ1_RESEARCH_REVISION?'FIRST_RECORDED_R221_SIGNAL_BEFORE_IQ1_EXACT_GATE':'FIRST_RECORDED_P5_SIGNAL_IN_BAND',entryBandBps:revision===S1_IQ1_RESEARCH_REVISION?null:ENTRY_BAND_BPS[account],
    ...(revision===S1_IQ1_RESEARCH_REVISION?{executionCloseGuardBps:50}:{}),samplingCadenceSeconds:300,
    result:p===null?{status:'UNSCORED',y:null,resolvedAt:now}:null,
    cursor:{time:startAt,lastId:null},trade:{status:'UNMATCHED',netR:null}};
}

// Every aggregate ID is checked. Equal-timestamp opposite hits are ambiguous:
// aggregation timestamps must not manufacture an intramillisecond path.
export function consumeTradePage(trial,rows,through,now) {
  if(!Array.isArray(rows)||rows.length>1000||through<trial.cursor.time)throw new Error('RESEARCH_TICK_PAGE_INVALID');
  let previous=trial.cursor.lastId===null?null:BigInt(trial.cursor.lastId);
  let lastTime=trial.cursor.time, lastId=trial.cursor.lastId;
  const valid=[];
  for(const row of rows) {
    if(!Number.isSafeInteger(row.a)||!Number.isSafeInteger(row.T)||!finite(Number(row.p))||Number(row.p)<=0
      || row.T<lastTime || (previous!==null&&BigInt(row.a)!==previous+1n))throw new Error('RESEARCH_TICK_GAP');
    previous=BigInt(row.a);lastTime=row.T;valid.push({id:String(row.a),at:row.T,price:Number(row.p)});
  }
  const inWindow=valid.filter(r=>r.at<=through);
  const sign=trial.direction==='LONG'?1:-1;
  const hit=inWindow.find(r=>sign*(r.price-trial.target.favorablePrice)>=0||sign*(r.price-trial.target.adversePrice)<=0);
  const complete=rows.length<1000||valid.some(r=>r.at>through);
  if(hit) {
    const same=inWindow.filter(r=>r.at===hit.at);
    const favorable=same.some(r=>sign*(r.price-trial.target.favorablePrice)>=0);
    const adverse=same.some(r=>sign*(r.price-trial.target.adversePrice)<=0);
    // A page boundary can hide the opposite hit at the same timestamp.
    if(!complete && valid.at(-1).at===hit.at)return {result:{status:'AMBIGUOUS_PAGE_BOUNDARY',y:null,resolvedAt:now},cursor:trial.cursor};
    const status=hit.at<=trial.frozenAt?'PREDECISION_TOUCH':favorable&&adverse?'AMBIGUOUS':favorable?'FAVORABLE':'ADVERSE';
    return {result:{status,y:status==='FAVORABLE'?1:status==='ADVERSE'?0:null,hitAt:hit.at,hitPrice:hit.price,
      aggTradeId:hit.id,resolvedAt:now},cursor:trial.cursor};
  }
  if(inWindow.length)lastId=inWindow.at(-1).id;
  const cursor={lastId,time:complete?through+1:inWindow.at(-1)?.at??trial.cursor.time};
  return {cursor,result:complete&&through>=trial.deadlineAt?{status:'TIMEOUT',y:0,resolvedAt:now}:null};
}

export function tradeOutcome(trial,position) {
  if(!position)return {status:'UNMATCHED',netR:null};
  if(trial.structureRevision&&(position.structureRevision!==trial.structureRevision||position.structureGeometryHash!==trial.structureEvidence?.geometryHash))return {status:'STRUCTURE_MISMATCH',netR:null};
  if(position.symbol!==trial.symbol||(position.direction===1?'LONG':'SHORT')!==trial.direction)return {status:'MISMATCH',netR:null};
  if(position.openedAt<=trial.frozenAt)return {status:'PREEXISTING',netR:null};
  if(position.openedAt-trial.frozenAt>300000)return {status:'STALE_PREDICTION',netR:null};
  if(position.status!=='CLOSED')return {status:'OPEN',netR:null};
  const risk=Number(position.exact?.initialRiskUsdt),net=Number(position.netPnlIncludingKnownFundingUsdt);
  if(!position.accountingComplete||!position.fundingAttributionComplete||position.netPnlIncludingKnownFundingUsdt==null
    ||!finite(net)||!finite(risk)||risk<=0)return {status:'ACCOUNTING_INCOMPLETE',netR:null};
  return {status:'CLOSED',netR:net/risk,closedAt:position.closedAt,openedAt:position.openedAt,
    managementRevision:position.managementRevision??position.managementPolicy?.revision??'R22-LEGACY'};
}
function wilson(hits,n) {
  if(!n)return null;
  const z=1.96,p=hits/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,r=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [Math.max(0,c-r),Math.min(1,c+r)];
}
function statistics(rows) {
  const settled=rows.filter(r=>[0,1].includes(r.result?.y)&&r.p!==null);
  const hits=settled.reduce((sum,r)=>sum+r.result.y,0), n=settled.length;
  return {n,hits,rate:n?hits/n:null,interval:wilson(hits,n),brier:mean(settled.map(r=>(r.p-r.result.y)**2)),
    meanP:mean(settled.map(r=>r.p))};
}
function tradeStats(rows) {
  const closed=rows.filter(r=>r.trade?.status==='CLOSED'&&finite(r.trade.netR)).sort((a,b)=>a.trade.closedAt-b.trade.closedAt);
  let sum=0,peak=0,drawdown=0;
  for(const r of closed){sum+=r.trade.netR;peak=Math.max(peak,sum);drawdown=Math.max(drawdown,peak-sum);}
  return {n:closed.length,meanNetR:mean(closed.map(r=>r.trade.netR)),sumNetR:closed.length?sum:null,drawdownR:closed.length?drawdown:null};
}
export function researchSummary(rows,account,now,policy=null) {
  const revision=usesS2Z(account,policy)?S2_Z_RESEARCH_REVISION
    :account==='S1'&&policy?.entryQualityPolicy?.revision==='V2-IQ1-P1-20260915'?S1_IQ1_RESEARCH_REVISION:RESEARCH_REVISION;
  const own=rows.filter(r=>r.account===account&&r.revision===revision), independent=independentTrials(own), base=statistics(independent);
  const selected=independent.filter(r=>r.p>=.6),excluded=independent.filter(r=>r.p!==null&&r.p<.6);
  const brierRows=independent.filter(r=>finite(r.calibratedP)&&[0,1].includes(r.result?.y));
  return {revision,asOf:new Date(now).toISOString(),mode:'OBSERVE_ONLY',orderAuthority:false,account,
    total:own.length,independent:independent.length,overlapping:own.length-independent.length,
    pending:own.filter(r=>!r.result).length,excludedEvidence:own.filter(r=>r.result&&r.result.y===null).length,
    base,selected:statistics(selected),excluded:statistics(excluded),retention:base.n?statistics(selected).n/base.n:null,
    bins:Array.from({length:5},(_,i)=>({from:i*.2,to:(i+1)*.2,...statistics(independent.filter(r=>r.p!==null&&Math.min(4,Math.floor(r.p*5))===i))})),
    calibration:{outOfSampleN:brierRows.length,rawBrier:mean(brierRows.map(r=>(r.p-r.result.y)**2)),calibratedBrier:mean(brierRows.map(r=>(r.calibratedP-r.result.y)**2))},
    actual:{all:tradeStats(independent),retained:tradeStats(selected),omitted:tradeStats(excluded),
      byManagementPolicy:[...new Set(independent.filter(r=>r.trade?.status==='CLOSED').map(r=>r.trade.managementRevision??'R22-LEGACY'))].sort().map(revision=>({revision,
        all:tradeStats(independent.filter(r=>(r.trade?.managementRevision??'R22-LEGACY')===revision)),
        retained:tradeStats(selected.filter(r=>(r.trade?.managementRevision??'R22-LEGACY')===revision)),
        omitted:tradeStats(excluded.filter(r=>(r.trade?.managementRevision??'R22-LEGACY')===revision))})),
      open:own.filter(r=>r.trade?.status==='OPEN').length,unmatched:own.filter(r=>r.trade?.status==='UNMATCHED').length},
    conclusion:base.n<100?'ACCUMULATING':'REVIEW_REQUIRED',promotionAllowed:false,
    latest:[...own].sort((a,b)=>b.frozenAt-a.frozenAt).slice(0,15).map(r=>({key:r.key,symbol:r.symbol,direction:r.direction,
      p:r.p,frozenAt:r.frozenAt,status:r.result?.status??'PENDING',netR:r.trade?.netR??null,tradeStatus:r.trade?.status??'UNMATCHED'}))};
}
