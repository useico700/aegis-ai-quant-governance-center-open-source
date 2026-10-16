import fs from 'node:fs';
import { chooseTarget,createTrade,advanceMinute } from './strategy.mjs';
const report=new URL('../../reports/s2-2-simulation-20261014/',import.meta.url);
const read=p=>JSON.parse(fs.readFileSync(new URL(p,report)));
const scan=read('scan.json'),minutes=read('minutes.json'),dataset=read('dataset.json');
const result=structuredClone(scan);let covered=0;
result.rejections={...scan.rejections};
for(const o of scan.offers) {
 const {plan,decision,tick}=o;
 const rows=minutes.bars.filter(b=>b.symbol===plan.symbol&&b.openTime>decision.confirmedAt&&b.openTime<=decision.deadline);
 const expected=Math.floor((decision.deadline-(decision.confirmedAt+1))/60000)+1;
 const complete=rows.length===expected&&rows.every((b,i)=>b.openTime===decision.confirmedAt+1+i*60000&&b.evidenceHealthy);
 let status=rows.length?'ENTRY_DATA_UNHEALTHY':'ENTRY_EVIDENCE_MISSING',target=o.referenceTarget,entry=null;
 if(complete) {
  covered++;
  for(const b of rows) {
   if(Math.abs(b.open/decision.confirmationClose-1)*10000>50){status='ENTRY_TOO_FAR';continue;}
   const bars4h=dataset.market[plan.symbol].frames['4h'].filter(v=>v.closeTime<b.openTime).slice(-500);
   target=chooseTarget({bars4h,decision,entry:b.open,tick,now:b.openTime,policy:scan.policy});status=target.state;
   if(status==='RESEARCH_SPACE_PASS'){entry=b;status='SIMULATED_ENTRY';break;}
  }
 }
 const c=result.candidates.find(c=>c.id===plan.id);Object.assign(c,{state:status,reason:status,target,minuteCoverage:{available:rows.length,expected,complete},referenceTarget:o.referenceTarget});
 if(entry) {
  for(const variant of ['F1','R22_PARTIAL_MODEL']) {
   let trade=createTrade({plan,decision,target,entry:entry.open,enteredAt:entry.openTime,policy:scan.policy,variant});
   const tape=minutes.bars.filter(b=>b.symbol===plan.symbol&&b.openTime>=entry.openTime&&b.closeTime<dataset.end);
   for(const b of tape) {if(!b.evidenceHealthy){trade={...trade,status:'DATA_GAP',reason:'MINUTE_EVIDENCE_UNHEALTHY',netR:null};break;}trade=advanceMinute(trade,b);if(trade.status!=='OPEN')break;}
   if(trade.status==='OPEN'&&trade.lastAt<dataset.end-1)trade={...trade,status:'DATA_GAP',reason:'EXIT_EVIDENCE_NOT_COMPLETE',netR:null};
   (variant==='F1'?result.trades:result.controls).push(trade);
  }
 }else result.rejections[status]=(result.rejections[status]??0)+1;
}
const cohort=result.candidates.filter(c=>c.intersectionTime<=dataset.end);
result.rejections={};
for(const c of cohort)if(!['WAIT_DIRECTION','SIMULATED_ENTRY'].includes(c.state))result.rejections[c.state]=(result.rejections[c.state]??0)+1;
const closed=result.trades.filter(t=>t.status==='CLOSED'),uncertain=result.trades.filter(t=>['PATH_UNCERTAIN','DATA_GAP'].includes(t.status));
result.stats={candidates:cohort.length,confirmed:scan.offers.length,simulatedEntries:result.trades.length,closed:closed.length,uncertain:uncertain.length,
 netR:closed.length?closed.reduce((s,t)=>s+t.netR,0):null,meanNetR:closed.length?closed.reduce((s,t)=>s+t.netR,0)/closed.length:null,
 winRate:closed.length?closed.filter(t=>t.netR>0).length/closed.length:null,pending:result.candidates.length-cohort.length,entryCoverage:covered,
 entryEvidenceMissing:scan.offers.length-covered,portfolioDrawdown:null,actualFillRate:null};
result.source.minuteFiles=minutes.files;result.source.minuteEvidence=minutes.source;
result.notes=[`通过结构确认 ${scan.offers.length} 个，其中 ${covered} 个具备原入场窗口的连续分钟证据；其余 ${scan.offers.length-covered} 个保留未验证状态，不能视为确定未成交。`,
 '本轮重点检查规则能否形成可交易机会。账户回撤、阶段保护效果与真实成交率，需要足够完整成交样本后再评估。',
 '最近有效 FVG 即使未达精选标准也保留为阻挡，本轮严格按草案执行，没有跳过近目标凑高 R。'];
result.completedAt=new Date().toISOString();result.status=scan.errors.length||covered<scan.offers.length?'PARTIAL_EVIDENCE':'SCREENING_COMPLETE';
result.validation={causalBars:true,discoveryCadence:'1H_AT_CLOSE',candidateMaintenanceCadence:'15M_AT_CLOSE',executionEvidence:'TICK_DERIVED_1M_SCREENING',gate1Qualified:false,liveOrderAuthority:false,
 historicalVintageLimit:'Retained corrected OHLC, no claim of point-in-time dataset vintage.',control:'SIMPLIFIED_R22_PARTIAL_EXIT_ONLY_NOT_FULL_STRATEGY_PARITY',portfolioSimulation:false};
delete result.offers;
fs.writeFileSync(new URL('result.json',report),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,stats:result.stats,rejections:result.rejections},null,2));
