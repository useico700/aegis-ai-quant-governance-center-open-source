import { sha } from './filter-core.mjs';
import { entryBandFraction } from './entry-band.mjs';
import { executionSignal as s1Signal } from '../../agents/orion-live/s1-execution/signal-adapter.mjs';
import { executionSignal as s2Signal } from '../../agents/orion-live/s2-execution/signal-adapter.mjs';
import { usesS2Z, checkS2Z, freezeStructureGeometry } from './structure-quality.mjs';
import { nextR22Action as s1Action, r22StopProposal as s1Stop } from '../../agents/orion-live/s1-execution/r22-management.mjs';
import { nextR22Action as s2Action, r22StopProposal as s2Stop } from '../../agents/orion-live/s2-execution/r22-management.mjs';
import { units, decimal } from '../../lib/s1-precision.mjs';
import { advanceAggregateProfitLock, aggregateLiquidationNetR, S1_PROFIT_RETENTION_POLICY, S2_PROFIT_RETENTION_POLICY, createAdaptiveFirstHarvestPolicy, resolveProfitRetentionPolicy, validateProfitRetentionPolicy } from '../../agents/shared/profit-retention.mjs';
import { evaluateEntryConfirmation } from '../../agents/shared/entry-confirmation.mjs';
import { latestLossExit } from './entry-quality.mjs';
export const SHADOW_REVISION='JEV-POOL-SHADOW-1';
export const COSTS=Object.freeze({takerFeeRate:0.0005,adverseSlippageRate:0.0005});
export const INITIAL_EQUITY=10000;
const fresh=(t,now,age)=>Number.isFinite(t)&&t<=now+5000&&now-t<=age;
const iso=t=>new Date(t).toISOString();
const runtime={paperRisk:COSTS};
const floor=(q,step)=>Number(decimal(units(q.toFixed(12))/units(step)*units(step)));
function validateManagementPolicy(account,policy) {
 if(!policy)return;
 const expected={S1:S1_PROFIT_RETENTION_POLICY,S2:S2_PROFIT_RETENTION_POLICY}[account];
 if(![expected?.revision,`${account}-P5-ADAPTIVE-FIRST-HARVEST-1`].includes(policy.revision))throw Error('SHADOW_MANAGEMENT_ACCOUNT_MISMATCH');
 validateProfitRetentionPolicy(policy);
}
export function poolCandidates(payload,now) {
 if(payload?.mode!=='OBSERVE_ONLY'||payload.orderAuthority!==false||!fresh(Date.parse(payload.asOf),now,1200000)||!fresh(Date.parse(payload.sourceAsOf),now,1200000))return [];
 const rows=(payload.observations??[]).filter(r=>{
  const d=r.decision;
  if(d?.revision==='JEV-P5-PLAN-DECISION-4'&&(payload.account!=='S2'||d.structure?.status!=='VALID'))return false;
  return r.stage==='LOCKED'&&['JEV-P5-PLAN-DECISION-2','JEV-P5-PLAN-DECISION-3','JEV-P5-PLAN-DECISION-4','JEV-R221-IQ1-PRE-GATE-DECISION-1'].includes(d?.revision)&&d.status==='EVALUATED'&&d.verdict==='YES'
   &&Number.isFinite(d.score)&&d.score>=60&&d.target?.planId===r.id
   &&fresh(Date.parse(d.evaluatedAt),now,1800000)&&fresh(Date.parse(r.sources?.binanceAt),now,1200000);
 }).map(r=>({...r,account:payload.account,tier:'YES'}));
 rows.sort((a,b)=>b.decision.score-a.decision.score||a.id.localeCompare(b.id));
 const seen=new Set();return rows.filter(r=>{if(seen.has(r.symbol))return false;seen.add(r.symbol);return true;});
}
export const shadowKey=r=>`${r.account}:${r.id}:${r.direction}:${r.decision.revision}`;
export function enlist(row,plan,policy,now) {
 if(!plan||plan.id!==row.id||plan.symbol!==row.symbol)return null;
 if(usesS2Z(row.account,policy)&&(row.decision?.revision!=='JEV-P5-PLAN-DECISION-4'||row.decision.structure?.status!=='VALID'
  ||row.decision.structure.geometryHash!==plan.zStructure?.geometryHash||row.px!==plan.intersectionPrice))return null;
 return {key:shadowKey(row),account:row.account,id:row.id,symbol:row.symbol,direction:row.direction,px:row.px,tier:row.tier,
  selectedAt:now,lastPoolAt:now,selection:{decisionScore:row.decision.score,decisionRevision:row.decision.revision,evidenceHash:row.evidenceHash??null},
  policy:structuredClone(policy),policyHash:sha(policy),plan:structuredClone(plan),state:'WAITING',reason:'WAIT_SIGNAL',eligible:true,events:[{at:now,type:'SELECTED',detail:'JEV YES 研究入选'}],position:null};
}
export function syncWaitingPolicy(rows,config,now) {
 let changed=0;
 for(const row of rows) {
  if(row.position||!['WAITING','OUT_OF_POOL'].includes(row.state)||!config[row.account]||row.policyHash===sha(config[row.account]))continue;
  row.policy=structuredClone(config[row.account]);row.policyHash=sha(row.policy);
  event(row,'POLICY_SYNC',now,{detail:'未开仓计划改用当前账户策略；历史事件保留'});
  changed++;
 }
 return changed;
}
export function quoteReady(q,t,now) {return q&&t&&fresh(q.marketTime,now,2000)&&fresh(q.receivedAt,now,2000)&&fresh(t.marketTime,now,2000)&&fresh(t.receivedAt,now,2000)&&q.bid>0&&q.ask>=q.bid&&t.price>0;}
export function marked(row,q) {
 const p=row.position;if(!p||p.status!=='OPEN'||!q)return null;
 const raw=p.direction===1?q.bid:q.ask,exit=raw*(1-p.direction*COSTS.adverseSlippageRate);
 return p.direction*(exit-p.entry)*p.quantity-p.entryFee*p.quantity/p.originalQuantity-exit*p.quantity*COSTS.takerFeeRate;
}
export function bookValues(rows,account,quotes={}) {
 const own=rows.filter(r=>r.account===account), open=own.filter(r=>r.position?.status==='OPEN');
 const realized=own.reduce((v,r)=>v+(r.position?.cumulativeRealizedNetPnl??0)+(r.position?.fundingNet??0),0);
 const float=open.reduce((v,r)=>v+(marked(r,quotes[r.symbol])??0),0);
 return {equity:INITIAL_EQUITY+realized+float,realized,float,open,
  committedRisk:open.reduce((v,r)=>v+r.position.initialPlannedRiskUsdt,0),gross:open.reduce((v,r)=>v+r.position.quantity*(quotes[r.symbol]?.ask??r.position.entry),0)};
}
export function event(row,type,now,extra={}) {row.events.push({at:now,type,...extra});}
export function closeQuantity(row,quantity,q,now,reason) {
 const p=row.position; const raw=p.direction===1?q.bid:q.ask,exit=raw*(1-p.direction*COSTS.adverseSlippageRate);
 const qty=Math.min(quantity,p.quantity),fee=exit*qty*COSTS.takerFeeRate,entryFee=p.entryFee*qty/p.originalQuantity;
 const pnl=p.direction*(exit-p.entry)*qty-entryFee-fee;
 p.quantity=Number((p.quantity-qty).toFixed(12));p.cumulativeRealizedNetPnl+=pnl;p.exitFees+=fee;
 event(row,p.quantity<=1e-12?'CLOSE':'REDUCE',now,{reason,quantity:qty,price:exit,pnl,fee,remaining:p.quantity,bbo:{bid:q.bid,ask:q.ask,marketTime:q.marketTime,updateId:q.updateId}});
 if(p.quantity<=1e-12){p.quantity=0;p.status='CLOSED';p.closedAt=now;row.state='CLOSED';row.reason=reason;}
}
export function manage(row,q,t,bars,rule,now) {
 const p=row.position;if(p?.status!=='OPEN'||!quoteReady(q,t,now))return false;
 validateManagementPolicy(row.account,p.managementPolicy);
 // Contract-price protective stop trigger plus executable side guard.
 if((p.direction===1?t.price<=p.stop:t.price>=p.stop)) {closeQuantity(row,p.quantity,q,now,'STOP');return true;}
 let changed=false;
 for(let i=0;i<4&&p.status==='OPEN';i++) {
  const action=(row.account==='S2'?s2Action:s1Action)(p,{...q,persisted:true,continuity:true},runtime,rule,now);
  p.maximumNetExcursionR=Math.max(p.maximumNetExcursionR,action.netR??0);
  if(p.secondPartialTaken)p.runnerMaximumNetExcursionR=Math.max(p.runnerMaximumNetExcursionR,p.maximumNetExcursionR);
  if(action.type==='CLOSE'){closeQuantity(row,p.quantity,q,now,action.reason);return true;}
  if(action.type==='HOLD')break;
  if(action.type==='REDUCE')closeQuantity(row,Number(action.quantity),q,now,action.stage);
  else event(row,'ZERO_LOT_STAGE',now,{reason:action.stage});
  p[action.flag]=true;p.pendingAggregateFloor=action.aggregateFloor;changed=true;
 }
 if(p.status!=='OPEN')return changed;
 if(p.managementPolicy) {
  // This is a current executable aggregate estimate, including known funding.
  // Unconfirmed funding remains disclosed separately; it is never invented as
  // settled cash or used to qualify a shadow result as complete.
  const currentNetR=aggregateLiquidationNetR(p,p.direction===1?q.bid:q.ask,COSTS);
  const lock=advanceAggregateProfitLock({policy:p.managementPolicy,softLockTaken:p.softLockTaken===true&&p.quantity<p.originalQuantity,
   peakNetR:p.profitRetention?.peakNetR??0,currentNetR,
   existingFloorR:Math.max(p.pendingAggregateFloor??0,p.profitRetention?.floorR??0),accountingComplete:p.accountingComplete===true});
  if(lock.active) {
   const next={active:true,peakNetR:lock.peakNetR,floorR:lock.floorR,revision:lock.revision};
   if(JSON.stringify(p.profitRetention)!==JSON.stringify(next)){p.profitRetention=next;changed=true;}
  }
 }
 const proposal=(row.account==='S2'?s2Stop:s1Stop)(p,{runtime,strategy:row.policy.strategy,bars1h:bars?.['1h']??[],bars15m:bars?.['15m']??[],aggregateFloor:p.pendingAggregateFloor??null});
 if(proposal.changed) {
  const raw=p.direction===1?q.bid:q.ask;
  if(p.direction*(proposal.proposed.stop-raw)>=0){closeQuantity(row,p.quantity,q,now,'PROFIT_FLOOR');return true;}
  const step=Number(rule.tickSize),stop=(p.direction===1?Math.ceil(proposal.proposed.stop/step):Math.floor(proposal.proposed.stop/step))*step;
  if(p.direction*(stop-p.stop)>1e-10){row.position={...proposal.proposed,stop:Number(stop.toFixed(10))};event(row,'STOP_MOVE',now,{price:row.position.stop});changed=true;}
 }
 return changed;
}
export function attemptEntry(row,{plan,bars,barsByInterval,q,t,rule,rows,quotes,now}) {
 if(row.position||!row.eligible)return false;
 validateManagementPolicy(row.account,row.policy.managementPolicy);
 if(row.account==='S1'&&row.policy.entryQualityPolicy?.revision==='V2-IQ1-P1-20260915'){
  // P1 requires the exact consecutive aggregate trades straddling Px and a
  // process-local pre-cross snapshot. A later shadow process cannot recover
  // either fact from candles, so it must wait instead of inventing a pass.
  row.reason='IQ1_EXACT_ANCHOR_WAIT';return false;
 }
 if(!quoteReady(q,t,now)){row.reason='WAIT_MARKET';return false;}
 if(!plan){row.reason='PLAN_UNAVAILABLE';return false;}
 let structure=null;
 if(usesS2Z(row.account,row.policy)){
  if(row.px!==plan.intersectionPrice){row.reason='S2_Z_INTERSECTION_INVALID';return false;}
  structure=checkS2Z(plan,now,barsByInterval?.['15m'],barsByInterval?.['1h']);
  if(!structure.allowed){row.reason=structure.reason;if(structure.terminal){row.eligible=false;row.state='INVALIDATED';event(row,'INVALIDATED',now,{reason:structure.reason});}return false;}
 }
 let answer;try{answer=(row.account==='S2'?s2Signal:s1Signal)(plan,bars??[],row.policy.strategy,now,{bars15m:barsByInterval?.['15m'],bars1h:barsByInterval?.['1h']});}catch{row.reason='PLAN_EVIDENCE';return false;}
 if(!answer.accepted){row.reason=answer.terminal?'INVALIDATED':'WAIT_SIGNAL';if(answer.terminal){row.eligible=false;row.state='INVALIDATED';event(row,'INVALIDATED',now);}return false;}
 const s=answer.signal;
 if(s.direction!==row.direction){row.reason='DIRECTION_CHANGED';return false;}
 if(q.marketTime<s.closedAt||t.marketTime<s.closedAt||q.receivedAt<row.selectedAt){row.reason='WAIT_MARKET';return false;}
 const d=row.direction==='LONG'?1:-1,raw=d===1?q.ask:q.bid,entry=raw*(1+d*COSTS.adverseSlippageRate);
 const distance=d*(raw/row.px-1);
 if(!(distance>0&&distance<=entryBandFraction(row.account)+1e-12)){row.reason='WAIT_PX';return false;}
 if(!rule||now-rule.at>24*3600000){row.reason='WAIT_RULES';return false;}
 const conflicts=rows.filter(r=>r.account===row.account&&r.symbol===row.symbol&&r.position?.status==='OPEN');
 for(const old of conflicts) {
  const p=old.position;
  if(p.direction===d){row.reason='SAME_POSITION';return false;}
  if(p.secondPartialTaken||s.closedAt<=p.openedAt||s.intersectionTime<=p.intersectionTime||(!structure&&s.fourHourLineStatus!=='ACTIVE_4H_TREND')||!(marked(old,q)>0)){row.reason='OPPOSITE_POSITION';return false;}
 }
 const book=bookValues(rows,row.account,quotes),risk=row.policy.risk;
 // Reserve capacity conservatively before any replacement: a rejected entry must not close the old position.
 const replacementRisk=conflicts.reduce((v,r)=>v+r.position.initialPlannedRiskUsdt,0),replacementGross=conflicts.reduce((v,r)=>v+r.position.quantity*raw,0);
 if(book.open.length-conflicts.length>=risk.maximumOpenPositions||book.equity<=0){row.reason='PORTFOLIO_CAP';return false;}
 const stopUnaligned=Number(s.stopPrice),step=Number(rule.tickSize);
 const stop=(d===1?Math.ceil(stopUnaligned/step):Math.floor(stopUnaligned/step))*step;
 const perUnit=d*(entry-stop)+entry*COSTS.takerFeeRate+stop*(COSTS.takerFeeRate+COSTS.adverseSlippageRate);
 if(!(perUnit>0&&d*(entry-stop)>0)){row.reason='STOP_INVALID';return false;}
 let confirmation=null;
 if(row.policy.entryConfirmationPolicy) {
  const own=rows.filter(r=>r.account===row.account&&r.position).map(r=>({...r.position,
   netPnlIncludingKnownFundingUsdt:r.position.cumulativeRealizedNetPnl+r.position.fundingNet,
   fundingAttributionComplete:r.position.fundingThrough>=r.position.closedAt,
   exitAttribution:r.events?.some(e=>['CLOSE','REDUCE'].includes(e.type)&&['STOP','STOP_FIRST'].includes(e.reason))?'OWNED_STOP'
    :r.events?.some(e=>e.type==='CLOSE'&&Number.isFinite(e.quantity)&&e.quantity>0)?'OWNED_OTHER':'UNKNOWN'}));
  confirmation=evaluateEntryConfirmation({policy:row.policy.entryConfirmationPolicy,now,direction:d,signalClosedAt:s.closedAt,
   entryBars:bars,bars1h:barsByInterval?.['1h'],quote:q,entryPrice:raw,modeledEntry:entry,stopPrice:stop,
   initialRiskPerUnit:perUnit,...COSTS,tickSize:step,lastLossExit:latestLossExit(own,{symbol:row.symbol,direction:d,now})});
  row.entryConfirmation=confirmation;
  if(!confirmation.allowed){row.reason=confirmation.reason;return false;}
 }
 const budget=Math.min(book.equity*Number(risk.perTradeRiskFraction),book.equity*Number(risk.portfolioRiskFraction)-book.committedRisk+replacementRisk);
 const nominal=book.equity*risk.maximumGrossNotionalLeverage-book.gross+replacementGross;
 const qty=floor(Math.min(budget/perUnit,nominal/(entry*(1+risk.maximumLeverage*COSTS.takerFeeRate)),Number(rule.marketLot.max)),rule.marketLot.step);
 if(!(qty>=Number(rule.marketLot.min)&&qty*entry>=rule.minNotional)){row.reason='SIZE_TOO_SMALL';return false;}
 if(qty>(d===1?q.askQty:q.bidQty)){row.reason='TOP_BOOK_SIZE';return false;}
 for(const old of conflicts)closeQuantity(old,old.position.quantity,q,now,'OPPOSITE_REPLACE');
 const p={id:row.id,symbol:row.symbol,status:'OPEN',accountingComplete:true,direction:d,entry,quantity:qty,originalQuantity:qty,entryFee:entry*qty*COSTS.takerFeeRate,exitFees:0,
  stop,initialStop:stop,initialRiskPerUnit:perUnit,initialPlannedRiskUsdt:perUnit*qty,cumulativeRealizedNetPnl:0,fundingNet:0,
  openedAt:now,intersectionTime:s.intersectionTime,softLockTaken:false,firstPartialTaken:false,secondPartialTaken:false,maximumNetExcursionR:0,runnerMaximumNetExcursionR:0,
  implementationRevision:row.policy.strategy.implementationRevision, fundingThrough:now, fundingIds:[]};
 if(row.policy.managementPolicy)p.managementPolicy=confirmation
  ?resolveProfitRetentionPolicy(createAdaptiveFirstHarvestPolicy({account:row.account,firstHarvestTarget:confirmation.firstHarvestTarget}),p,COSTS)
  :structuredClone(row.policy.managementPolicy);
 if(structure){p.structureRevision=plan.structureRevision;p.structureGeometry=freezeStructureGeometry(plan);p.zStructure=structuredClone(plan.zStructure);p.structureValidation=structure.summary;}
 if(confirmation)p.entryConfirmation=structuredClone(confirmation);
 if(p.managementPolicy){p.fundingNetUsdt='0';p.fundingAttributionComplete=true;}
 row.position=p;row.state='OPEN';row.reason='ENTRY';event(row,'OPEN',now,{price:entry,quantity:qty,stop,risk:p.initialPlannedRiskUsdt,fee:p.entryFee,bbo:{bid:q.bid,ask:q.ask,marketTime:q.marketTime,updateId:q.updateId},signalClosedAt:s.closedAt,tick:{id:t.id??null,price:t.price,marketTime:t.marketTime}});return true;
}
export function invalidateContinuity(rows,reason,now) {
 for(const r of rows)if(r.position?.status==='OPEN'&&r.eligible){r.eligible=false;r.reason='DATA_GAP';event(r,'DATA_GAP',now,{reason});}
}
export function applyFunding(row,records,through) {
 const p=row.position;if(!p)return;
 for(const f of records) {
  const at=Number(f.fundingTime);if(at<=p.openedAt||at>(p.closedAt??Infinity)||p.fundingIds.includes(at))continue;
  const reduced=row.events.filter(e=>['REDUCE','CLOSE'].includes(e.type)&&e.at<at).reduce((v,e)=>v+e.quantity,0);
  const qty=p.originalQuantity-reduced,amount=-p.direction*qty*Number(f.markPrice)*Number(f.fundingRate);
  if(!Number.isFinite(amount)||!(Number(f.markPrice)>0))throw Error('FUNDING_INVALID');
  p.fundingNet+=amount;p.fundingIds.push(at);event(row,'FUNDING',at,{pnl:amount});
 }
 if(p.managementPolicy)p.fundingNetUsdt=String(p.fundingNet);
 p.fundingThrough=Math.max(p.fundingThrough,through);
}
export function summarize(rows,quotes,now,startedAt,health='RUNNING') {
 return {schemaVersion:1,revision:SHADOW_REVISION,mode:'SHADOW_ONLY',orderAuthority:false,asOf:iso(now),startedAt:iso(startedAt),health,costs:COSTS,initialEquity:INITIAL_EQUITY,
 accounts:['S1','S2'].map(account=>{
  const own=rows.filter(r=>r.account===account),book=bookValues(rows,account,quotes),closed=own.filter(r=>r.position?.status==='CLOSED');
  const valid=closed.filter(r=>r.eligible&&r.position.fundingThrough>=r.position.closedAt);
  const outcomes=valid.map(r=>(r.position.cumulativeRealizedNetPnl+r.position.fundingNet)/r.position.initialPlannedRiskUsdt);
  return {account,selected:own.length,waiting:own.filter(r=>!r.position&&r.state==='WAITING').length,open:book.open.length,closed:closed.length,valid:valid.length,gaps:own.filter(r=>r.position&&!r.eligible).length,
   equity:book.equity,realized:book.realized,unrealized:book.float,netR:outcomes.reduce((a,b)=>a+b,0),winRate:valid.length?valid.filter(r=>r.position.cumulativeRealizedNetPnl+r.position.fundingNet>0).length/valid.length:null,
   initialStops:valid.filter(r=>!r.position.softLockTaken&&['STOP','STOP_FIRST'].includes(r.reason)).length,runnerCount:own.filter(r=>r.position?.secondPartialTaken).length};
 }),rows:rows.slice().sort((a,b)=>(b.events.at(-1)?.at??b.selectedAt)-(a.events.at(-1)?.at??a.selectedAt)).slice(0,200).map(r=>{
  const p=r.position;return {key:r.key,account:r.account,planId:r.id,symbol:r.symbol,direction:r.direction,tier:r.tier,selectedAt:r.selectedAt,state:r.state,reason:r.reason,eligible:r.eligible,px:r.px,policyHash:r.policyHash,selection:r.selection,
   position:p?{entry:p.entry,quantity:p.quantity,originalQuantity:p.originalQuantity,remainingPct:p.quantity/p.originalQuantity*100,initialStop:p.initialStop,stop:p.stop,openedAt:p.openedAt,closedAt:p.closedAt??null,
    realized:p.cumulativeRealizedNetPnl+p.fundingNet,unrealized:marked(r,quotes[r.symbol]),risk:p.initialPlannedRiskUsdt,fees:p.entryFee+p.exitFees,funding:p.fundingNet,
    fundingComplete:p.fundingThrough>=(p.closedAt??now-600000),stage:p.secondPartialTaken?'RUNNER':p.firstPartialTaken?'ONE_R':p.softLockTaken?'SOFT':'INITIAL',
    managementRevision:p.managementPolicy?.revision??'R22-LEGACY',profitRetention:p.profitRetention??null,
    firstHarvest:p.managementPolicy?.firstHarvestResolution?{r:p.managementPolicy.stages[0].r,floorR:p.managementPolicy.stages[0].floor,targetPrice:p.managementPolicy.firstHarvestTarget?.targetPrice??null,referencePrice:p.managementPolicy.firstHarvestTarget?.referencePrice??null}:null,
    fundingAsOf:p.fundingThrough,fundingPending:p.fundingThrough<(p.closedAt??now)}:null,
   events:r.events.slice(-30).sort((a,b)=>b.at-a.at)};
 })};
}
