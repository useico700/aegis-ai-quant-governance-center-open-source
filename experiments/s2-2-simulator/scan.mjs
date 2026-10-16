import fs from 'node:fs';
import crypto from 'node:crypto';
import { findReviewedConvergencePlan } from '../../agents/orion-live/s1-scanner/candidate-discovery.mjs';
import { structureReviewer } from '../../agents/orion-live/s1-scanner/candidate-lifecycle.mjs';
import { untouchedPxReview } from '../../agents/orion-live/s1-scanner/intersection-geometry.mjs';
import { equivalentIntersection, selectionPolicy } from '../../agents/orion-live/s1-scanner/candidate-selection.mjs';
import { directionDecision,chooseTarget,structureLabels,validateBars,QUARTER } from './strategy.mjs';
const root=new URL('../../',import.meta.url), report=new URL('reports/s2-2-simulation-20261014/',root);
const read=url=>JSON.parse(fs.readFileSync(url));
const policy=read(new URL('policy.json',import.meta.url)),strategy=read(new URL('geometry.json',import.meta.url));
const dataset=read(new URL('dataset.json',report));
const result={schemaVersion:1,name:'S2-2',runId:`s2-2-${dataset.start}-${dataset.end}`,revision:policy.revision,
 mode:'HISTORICAL_SCREENING',status:'SCANNING',orderAuthority:false,accountDependency:null,startedAt:new Date().toISOString(),
 window:{start:dataset.start,end:dataset.end,discoveryStart:dataset.discoveryStart},policy,
 source:{type:dataset.source,sha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('dataset.json',report))).digest('hex'),historicalCorrections:dataset.historicalCorrections.length},
 candidates:[],offers:[],errors:[],symbols:[],rejections:{},scanDiagnostics:{},trades:[],controls:[]};
const reject=reason=>result.rejections[reason]=(result.rejections[reason]??0)+1;
function view(p) {return {id:p.id,symbol:p.symbol,createdAt:p.createdAt,intersectionTime:p.intersectionTime,intersectionPrice:p.intersectionPrice,pattern:p.pattern,quality:p.anchorQualityScore,state:p.state,reason:p.reason,direction:p.decision?.direction??null,decision:p.decision??null,target:p.target??null,finishedAt:p.finishedAt??null,structures:p.structures??null};}
for(const symbol of policy.universe) {
 try {
  const {frames,tick}=dataset.market[symbol];for(const [tf,w] of [['4h',14400000],['1h',3600000],['15m',QUARTER]])validateBars(frames[tf],w);
  const active=[],all=[],seen=new Set(),selections=selectionPolicy(strategy);let discoveries=0;
  for(let now=dataset.discoveryStart;now<=dataset.end;now+=QUARTER) {
   const bars15m=frames['15m'].filter(b=>b.closeTime<now).slice(-320),bars1h=frames['1h'].filter(b=>b.closeTime<now).slice(-1200),bars4h=frames['4h'].filter(b=>b.closeTime<now).slice(-500);
   if(bars1h.length<1000||bars4h.length<360||bars15m.length<300)throw Error('INSUFFICIENT_WARMUP');
   const reviewer=now%3600000===0?structureReviewer(bars4h,bars1h,strategy,now):null;
   const finish=(p,state)=>{p.state=state;p.reason=state;p.finishedAt=now;if(p.intersectionTime>=dataset.start){reject(state);result.candidates.push(view(p));}};
   for(const p of [...active]) {
    if(now-p.intersectionTime>1800000){finish(p,'WINDOW_EXPIRED');continue;}
    if(now<p.intersectionTime) {
     const rr=reviewer&&now<p.intersectionTime-7200000?reviewer(p):{reason:null};
     const touch=untouchedPxReview(p,bars1h,bars15m,now);
     if(rr.reason||touch.reason)finish(p,rr.reason??touch.reason);
     continue;
    }
    // Only the cross-bar can straddle the timestamp. If it contains Px,
    // OHLC cannot prove whether the first touch was before or after the cross.
    const crossBar=bars15m.find(b=>b.openTime===p.lockedBarOpenTime);
    if(crossBar&&crossBar.low<=p.intersectionPrice&&crossBar.high>=p.intersectionPrice){finish(p,'CROSS_TOUCH_ORDER_UNKNOWN');continue;}
    const d=directionDecision(p,bars15m,now,tick);p.decision=d;
    if(d.state==='WAIT_DIRECTION')continue;
    if(d.state!=='CONFIRMED'){finish(p,d.state);continue;}
    p.structures=[...structureLabels(symbol,bars4h,tick,'4H'),...structureLabels(symbol,bars1h,tick,'1H')].slice(-32);
    p.target=chooseTarget({bars4h,decision:d,entry:d.confirmationClose,tick,now,policy});
    // Entry-price revalidation requires minute evidence, including when the
    // confirmation-close price cannot yet achieve 3R. Keep the original window.
    p.state='NEEDS_MINUTE_EVIDENCE';p.finishedAt=now;
    if(p.intersectionTime>=dataset.start){result.candidates.push(view(p));result.offers.push({plan:p,decision:d,referenceTarget:p.target,bars4h,tick});}
   }
   for(let i=active.length-1;i>=0;i--)if(active[i].finishedAt)active.splice(i,1);
   if(reviewer) {
    const discovered=[];const diag={};
    findReviewedConvergencePlan({symbol,bars15m,bars1h,bars4h,now,strategy,geometricOnly:true,diagnostics:diag,candidateFilter:p=>{
     if(seen.has(p.id)||all.some(q=>equivalentIntersection(p,q,selections)))return false;
     if(reviewer(p).reason||untouchedPxReview(p,bars1h,bars15m,now).reason)return false;
     discovered.push(p);return true;
    }});
    discovered.sort((a,b)=>(b.anchorConsensus?.stabilityScore??0)-(a.anchorConsensus?.stabilityScore??0)||b.anchorQualityScore-a.anchorQualityScore||a.intersectionTime-b.intersectionTime);
    for(const p of discovered) {
     if(active.length>=20)break;
     if(all.some(q=>equivalentIntersection(p,q,selections)))continue;
     p.state='WAIT_DIRECTION';active.push(p);all.push(p);seen.add(p.id);discoveries++;
    }
    result.scanDiagnostics[symbol]=diag;
   }
  }
  result.candidates.push(...active.filter(p=>p.intersectionTime>=dataset.start).map(view));
  result.symbols.push({symbol,status:'SCANNED',discoveries,remaining:active.length});
  console.log(JSON.stringify({symbol,discoveries,offers:result.offers.filter(x=>x.plan.symbol===symbol).length}));
 }catch(e){result.errors.push({symbol,reason:e.message});console.log(JSON.stringify({symbol,error:e.message}));}
}
result.status=result.errors.length?'PARTIAL_DATA':'SCREENING_COMPLETE';result.completedAt=new Date().toISOString();
fs.writeFileSync(new URL('scan.json',report),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,offers:result.offers.length,candidates:result.candidates.length,rejections:result.rejections}));
