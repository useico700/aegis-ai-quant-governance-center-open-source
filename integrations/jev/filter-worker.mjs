import { blockLegacyDirectLaunch } from "../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { readS2ScannerState } from './scanner-state-read.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { COIN_IDS, MODEL, buildMetrics, parseBars, publicWeightWindow, selectCandidates, sha } from './filter-core.mjs';
import { scannerPlans, usesS2Z, S2_Z_DECISION_REVISION } from './structure-quality.mjs';
import { DECISION_REVISION, S1_IQ1_DECISION_REVISION, strategyOpportunity, decisionQuestion, scoreDecision } from './strategy-decision.mjs';
import { entryBandFraction } from './entry-band.mjs';
import { freezeTrial, observedOpportunity, researchSummary, trialKey } from './research-core.mjs';
import { ResearchStore, settleTrials, matchLedger, readEntryLossContexts } from './research-store.mjs';
import { entryConfirmationPolicy } from '../../agents/shared/entry-confirmation.mjs';
import { inferAnswers, postObservation } from './transport-retry.mjs';
import { observeSmcSnapshot } from './smc-observer.mjs';

// Independent observer: public market reads + read-only scanner snapshots.
// No exchange credentials or order path. Ledger matching stays local; the model
// only receives public evidence and scanner structures.
const origin = 'https://your-cockpit.example.invalid';
const root = '/var/lib/aegis/jev-filter';
const input = { S1:'/data/s1-scanner/latest.json', S2:'/data/s2-scanner/latest.json', SMC:'/data/smc-scanner/latest.json' };
const output = account => path.join(root, `${account.toLowerCase()}-observation.json`);
const cachePath = account => path.join(root, `${account.toLowerCase()}-model-cache.json`);
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const safeRead = async file => { try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { return null; } };
const atomic = async (file,value) => { const tmp=`${file}.${process.pid}.tmp`; await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600}); await fs.rename(tmp,file); };
const bounded = (value,min,max) => typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
let exchangeRules=null,exchangeRulesAt=0;
async function tickRules() {
 if(exchangeRules&&Date.now()-exchangeRulesAt<3600000)return exchangeRules;
 const response=await binance('/fapi/v1/exchangeInfo');
 if(!Array.isArray(response.symbols))throw Error('PUBLIC_RULES_INVALID');
 exchangeRules=new Map(response.symbols.map(r=>[r.symbol,Number(r.filters?.find(f=>f.filterType==='PRICE_FILTER')?.tickSize)]));
 exchangeRulesAt=Date.now();return exchangeRules;
}
let weightWindow = publicWeightWindow(null,Date.now()), cooldownUntil = 0;
const safePublicCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.message ?? '') ? error.message : 'PUBLIC_READ_FAILED';
async function binance(endpoint,params={}) {
  if(Date.now()<cooldownUntil)throw new Error('PUBLIC_COOLDOWN');
  weightWindow=publicWeightWindow(weightWindow,Date.now());
  if(weightWindow.usedWeight>=1500)throw new Error('PUBLIC_WEIGHT_HIGH');
  const url=new URL(endpoint,'https://demo-fapi.binance.com');
  if(url.origin!=='https://demo-fapi.binance.com'||!['/fapi/v1/exchangeInfo','/fapi/v1/aggTrades','/fapi/v1/klines','/fapi/v1/ticker/bookTicker','/fapi/v1/ticker/24hr','/fapi/v1/premiumIndex','/fapi/v1/openInterest','/futures/data/openInterestHist'].includes(url.pathname))throw new Error('PUBLIC_PATH_INVALID');
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(7000)});
  const weight=Number(response.headers.get('x-mbx-used-weight-1m'));
  weightWindow=publicWeightWindow(weightWindow,Date.now(),weight);
  if(!response.ok){if([418,429].includes(response.status))cooldownUntil=Date.now()+Math.max(300,Number(response.headers.get('retry-after'))||300)*1000;throw new Error(`PUBLIC_HTTP_${response.status}`);}
  const body=await response.json();
  await wait(120);
  return body;
}
async function fundamentals() {
  const ids=[...new Set(Object.values(COIN_IDS))];
  const url=new URL('https://api.coingecko.com/api/v3/coins/markets');
  url.searchParams.set('vs_currency','usd');url.searchParams.set('ids',ids.join(','));url.searchParams.set('per_page',String(ids.length));url.searchParams.set('page','1');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error(`FUNDAMENTALS_HTTP_${response.status}`);
  const rows=await response.json();
  if(!Array.isArray(rows))throw new Error('FUNDAMENTALS_INVALID');
  return new Map(rows.filter(row=>ids.includes(row?.id) && row.symbol===Object.entries(COIN_IDS).find(([,id])=>id===row.id)?.[0]?.replace('USDT','').toLowerCase()
    && Date.now()-Date.parse(row.last_updated)<=30*60_000).map(row=>[row.id,row]));
}
async function marketFor(symbol, intervals) {
  const result={bars:{},quote:null,ticker:null,premium:null,openInterest:null,oiHistory:null,errors:{},asOf:new Date().toISOString()};
  for(const interval of intervals) {
    try { result.bars[interval]=parseBars(await binance('/fapi/v1/klines',{symbol,interval,limit:55}),interval); }
    catch(error) { result.bars[interval]=null;result.errors[interval]=safePublicCode(error); }
  }
  for(const [key,endpoint,params] of [
    ['quote','/fapi/v1/ticker/bookTicker',{symbol}],['ticker','/fapi/v1/ticker/24hr',{symbol}],['premium','/fapi/v1/premiumIndex',{symbol}],
    ['openInterest','/fapi/v1/openInterest',{symbol}],['oiHistory','/futures/data/openInterestHist',{symbol,period:'1h',limit:2}]]) {
    try { result[key]=await binance(endpoint,params); } catch(error) { result[key]=null;result.errors[key]=safePublicCode(error); }
  }
  if(result.quote) result.quote={bid:result.quote.bidPrice,ask:result.quote.askPrice};
  return result;
}
const client = new TypeSafeClient({ baseURL:'https://api.typesafe.ai', timeout:20000, retry:{maxRetries:0}, logLevel:'off', fetch:(url,init)=>fetch(url,{...init,redirect:'error'}) });
async function evaluateAccount(account, selected, market, coins, plans, policy, now, lossContexts, ticks) {
  const evidence=[],quoteRefreshed=new Set();
  const grouped=selected.map((candidate,index)=>[index,candidate]).sort((a,b)=>a[1].symbol.localeCompare(b[1].symbol)||a[0]-b[0]);
  for(const [index,candidate] of grouped) {
    const publicData=market.get(candidate.symbol)??{};
    // Refresh once per symbol, then evaluate all its plans together before
    // the two-second check expires. Public data only; no execution budget.
    if(publicData.bars?.['1h']&&!quoteRefreshed.has(candidate.symbol))try {
      quoteRefreshed.add(candidate.symbol);
      const q=await binance('/fapi/v1/ticker/bookTicker',{symbol:candidate.symbol});
      const receivedAt=Date.now();
      publicData.quote={bid:Number(q.bidPrice),ask:Number(q.askPrice),marketTime:Number(q.time),receivedAt};
      publicData.asOf=new Date(receivedAt).toISOString();
    }catch(error){publicData.quote=null;publicData.errors.quote=safePublicCode(error);}
    const checkedAt=Date.now();
    const coin=coins.get(COIN_IDS[candidate.symbol])??null;
    const enriched={...candidate,account};
    const metrics=buildMetrics({candidate:enriched,bars:publicData.bars,quote:publicData.quote,ticker:publicData.ticker,premium:publicData.premium,
      openInterest:publicData.openInterest,oiHistory:publicData.oiHistory,coin});
    const required=!!(publicData.bars?.[account==='S1'?'15m':'5m']&&publicData.bars?.['1h']&&publicData.quote&&publicData.ticker
      && bounded(metrics.spreadBps,0,2000)&&bounded(metrics.quoteVolumeUsd24h,0,1e15));
    const sources={binanceAt:publicData.asOf??null,coingeckoAt:coin?.last_updated??null};
    const decision=strategyOpportunity(account,candidate,plans.get(candidate.id),{...publicData.quote,asOf:publicData.asOf},policy,checkedAt,publicData.bars?.['1h'],{entryBars:publicData.bars?.[account==='S1'?'15m':'5m'],bars15m:publicData.bars?.['15m'],
      tickSize:ticks?.get(candidate.symbol),lossContextObservedAt:lossContexts.observedAt,lastLossExit:lossContexts.has(`${candidate.symbol}:${candidate.direction}`)?lossContexts.get(`${candidate.symbol}:${candidate.direction}`):{evidenceComplete:false}});
    evidence.push({key:`c${index}`,candidate,metrics,required,sources,decision});
  }
  const ready=evidence.filter(row=>row.required&&row.decision.status==='READY');
  const questions=Object.fromEntries(ready.map(row=>[`${row.key}:decision`,decisionQuestion(row.key)]));
  const state={ venue:'BINANCE_USDM_PERPETUAL',strategy:account==='S1'&&policy.entryQualityPolicy?'MTFX-0.5.0-R22.1 + IQ1 P1 pre-gate research':'MTFX-0.5.0-R22 P5',accountTimeframe:account==='S1'?'4h/1h intersection; 15m entry':usesS2Z(account,policy)?'15m complete Z first; historical 1h two-point lines (no 1h Z required); 5m Px entry direction':'1h/15m intersection; 5m entry',
    interpretation:'Read-only prospective research. No order or risk authority. Targets include 5bp adverse slippage and 0.05% fee on each side.',
    candidates:ready.map(row=>({key:row.key,symbol:row.candidate.symbol,direction:row.candidate.direction,
      target:row.decision.target,entryQuality:row.decision.entryQuality,structure:row.decision.structureContext??null,metrics:row.metrics,fundamentalDataAvailable:row.sources.coingeckoAt!==null})) };
  const key=sha({revision:usesS2Z(account,policy)?S2_Z_DECISION_REVISION:account==='S1'&&policy.entryQualityPolicy?S1_IQ1_DECISION_REVISION:DECISION_REVISION,model:MODEL,account,state,questions});
  let cache=await safeRead(cachePath(account));
  if(!ready.length)cache={answers:{},evaluatedAt:new Date().toISOString()};
  else if(cache?.key!==key) {
    const result=await inferAnswers(client,{model:MODEL,state,questions});
    cache={key:result.complete?key:null,answers:result.answers,state,questions,evaluatedAt:new Date().toISOString(),
      inputHash:sha({state,questions,model:MODEL}),failureCode:result.failureCode,attempts:result.attempts};
    await atomic(cachePath(account),cache);
    if(result.failureCode)process.stderr.write(`${JSON.stringify({at:new Date().toISOString(),account,status:'MODEL_UNAVAILABLE',code:result.failureCode,attempts:result.attempts})}\n`);
  }
  return evidence.map(row=>{
    const decision=row.required?scoreDecision(row.decision,cache.answers?.[`${row.key}:decision`]??null,cache.evaluatedAt,{state,question:questions[`${row.key}:decision`]})
      : row.decision.status==='READY'?{...row.decision,status:'UNAVAILABLE',reason:'必要行情或周期证据缺失'}:row.decision;
    const evaluated=decision.status==='EVALUATED';
    return {...(usesS2Z(account,policy)?{structureRevision:policy.strategy.structureRevision}:{}),id:row.candidate.id,symbol:row.candidate.symbol,direction:row.candidate.direction,stage:row.candidate.stage,px:row.candidate.px,
      intersectionTime:row.candidate.intersectionTime,observedAt:row.candidate.observedAt,status:evaluated?'EVALUATED':'UNAVAILABLE',
      label:evaluated?(decision.verdict==='YES'?'FOCUS':decision.verdict==='NO'?'CAUTION':'WATCH'):'INSUFFICIENT',
      confidence:evaluated?decision.score/100:null,model:evaluated?MODEL:null,evaluatedAt:evaluated?decision.evaluatedAt:null,
      evidenceHash:row.required?sha({revision:decision.revision,candidate:row.candidate,metrics:row.metrics,sourceTimes:row.sources,decisionTarget:decision.target,structure:decision.structure??null}):null,
      judge:null,directional:null,decision,metrics:row.metrics,sources:row.sources};
  });
}
async function publish(payload) {
  const token=process.env.JEV_FILTER_INGEST_TOKEN, bypass=process.env.JEV_FILTER_BYPASS_TOKEN;
  if(!token || token.length<32 || !bypass)throw new Error('PUBLISH_TOKEN_MISSING');
  return postObservation(fetch,`${origin}/api/observations`,payload,{ingestToken:token,bypassToken:bypass});
}
export async function cycle() {
  if(os.hostname()!=='aegis-demo-host'||process.env.AEGIS_PRODUCTION_HOST_ID!=='demo-server'||process.getuid()!==993)throw new Error('JEV_FILTER_HOST_BOUNDARY');
  if(!process.env.TYPESAFE_API_KEY)throw new Error('JEV_KEY_MISSING');
  const now=Date.now(); weightWindow=publicWeightWindow(null,now); cooldownUntil=Math.max(cooldownUntil,(await safeRead(path.join(root,'public-cooldown.json')))?.until??0);
  const snapshots=Object.fromEntries(await Promise.all(['S1','S2'].map(async account=>[account,await safeRead(input[account])])));
  const policies=await safeRead(new URL('./shadow-config/strategy.json',import.meta.url));
  if(!policies?.S1||!policies?.S2||!policies?.SMC)throw Error('JEV_STRATEGY_POLICY_MISSING');
  const smc=observeSmcSnapshot(await safeRead(input.SMC),policies.SMC,now);
  await atomic(path.join(root,'smc-observation.json'),smc);
  // Independent read-only coverage attribution, once per scanner snapshot.
  const coveragePath=path.join(root,'smc-opportunity-receipt.json');
  if(smc.sourceStatus==='READY' && (await safeRead(coveragePath))?.sourceAsOf!==smc.sourceAsOf) {
    const receipt={recordedAt:new Date(now).toISOString(),sourceAsOf:smc.sourceAsOf,
      revision:policies.SMC.opportunityRevision,modelRevision:policies.SMC.activeEntryModel,orderAuthority:false,
      rows:smc.opportunityReviews.map(r=>({symbol:r.symbol,futureCount:r.clock?.futureCount??0,
        clockEventId:r.clock?.active?.event.id??null,window:r.clock?.active?{opensAt:r.clock.active.opensAt,expiresAt:r.clock.active.expiresAt}:null,
        legacyCandidateCount:r.legacyCandidateCount,models:r.models}))};
    await fs.appendFile(path.join(root,`smc-opportunity-${new Date(now).toISOString().slice(0,10)}.jsonl`),JSON.stringify(receipt)+'\n');
    await atomic(coveragePath,receipt);
  }
  for(const account of ['S1','S2'])if(JSON.stringify(policies[account].entryConfirmationPolicy)!==JSON.stringify(entryConfirmationPolicy(account)))throw Error('JEV_ENTRY_POLICY_MISSING');
  const select=(account,snapshot,at,options)=>selectCandidates(snapshot,at,options).map(row=>usesS2Z(account,policies[account])?{...row,structureRevision:policies[account].strategy.structureRevision}:row);
  const selected=Object.fromEntries(['S1','S2'].map(account=>[account,select(account,snapshots[account],now)]));
  const nearSymbols=new Set();
  for(const account of ['S1','S2'])for(const row of select(account,snapshots[account],now,{allPlans:true})){
    if(row.stage!=='LOCKED')continue;
    const q=(snapshots[account]?.marketQuotes??[]).find(q=>q.symbol===row.symbol);
    const raw=row.direction==='LONG'?Number(q?.askPrice):Number(q?.bidPrice);
    const distance=(row.direction==='LONG'?1:-1)*(raw/row.px-1);
    if(raw>0&&distance>0&&(account==='S1'&&policies.S1.entryQualityPolicy||distance<=entryBandFraction(account)+0.005))nearSymbols.add(row.symbol);
  }
  let coins=new Map();if(nearSymbols.size)try{coins=await fundamentals();}catch{/* Missing external fundamentals remain unknown. */}
  const market=new Map();
  for(const symbol of nearSymbols) {
    const intervals=new Set(['1h','15m']);
    if(selected.S1.some(row=>row.symbol===symbol))intervals.add('4h');
    if(selected.S2.some(row=>row.symbol===symbol))intervals.add('5m');
    market.set(symbol,await marketFor(symbol,intervals));
  }
  for(const account of ['S1','S2'])for(const row of selected[account])if(!market.has(row.symbol)){
    const q=(snapshots[account]?.marketQuotes??[]).find(q=>q.symbol===row.symbol);
    market.set(row.symbol,{bars:{},quote:q?{bid:q.bidPrice,ask:q.askPrice}:null,ticker:null,premium:null,openInterest:null,
      oiHistory:null,errors:{},asOf:snapshots[account]?.sourceAsOf??null});
  }
  const receipts={}, researchStatus={};
  const store=new ResearchStore(path.join(root,'research.sqlite'));
  try {
  cooldownUntil=Math.max(cooldownUntil,store.meta('publicCooldown')??0);
  const tickProgress=await settleTrials(store,binance);
  let ticks=null;if(nearSymbols.size)try{ticks=await tickRules();}catch{/* Missing exact tick sizes keep confirmation waiting. */}
  for(const account of ['S1','S2']) {
    // Refresh the signal snapshot and quote immediately before inference.
    snapshots[account]=await safeRead(input[account]);
    if(!snapshots[account]||Date.now()-Date.parse(snapshots[account].sourceAsOf)>180_000){receipts[account]='SCANNER_STALE';continue;}
    selected[account]=select(account,snapshots[account],Date.now());
    const history=store.all(),known=new Set(history.map(r=>r.key));
    const ready=select(account,snapshots[account],Date.now(),{allPlans:true}).filter(r=>!known.has(trialKey(account,r))&&observedOpportunity(account,r,market.get(r.symbol),Date.now()));
    const union=[...new Map([...selected[account],...ready].map(r=>[r.id,r])).values()];
    const scannerState=account==='S2'?await readS2ScannerState('/data/s2-scanner/state.json'):await safeRead('/data/s1-scanner/state.json');
    let plans=new Map();try{plans=scannerPlans(account,scannerState);}catch{/* Broken references are missing evidence, never permission. */}
    const ledger=matchLedger(store,account,`/data/${account.toLowerCase()}-audit/execution.sqlite`);
    const lossContexts=readEntryLossContexts(account,`/data/${account.toLowerCase()}-audit/execution.sqlite`,union,Date.now());
    const evaluated=await evaluateAccount(account,union,market,coins,plans,policies[account],Date.now(),lossContexts,ticks);
    let frozen=0;
    for(const row of evaluated)if(store.insert(freezeTrial(account,row,market.get(row.symbol),Date.now(),history,plans.get(row.id))))frozen++;
    const research={...researchSummary(store.all(),account,Date.now(),policies[account]),ledgerStatus:ledger,
      labelerStatus:store.all().some(r=>r.account===account&&!r.result&&r.error)?'RETRYING':'RUNNING',
      deferred:ready.filter(r=>!store.all().some(t=>t.key===trialKey(account,r))).length};
    const visible=new Set(selected[account].map(r=>r.id));
    const observations=evaluated.filter(r=>visible.has(r.id));
    const payload={schemaVersion:1,mode:'OBSERVE_ONLY',orderAuthority:false,account,asOf:new Date().toISOString(),sourceAsOf:snapshots[account].sourceAsOf,observations,research};
    await atomic(output(account),payload);
    try { receipts[account]=await publish(payload); } catch(error) { receipts[account]=/^PUBLISH_[A-Z0-9_]+$/.test(error?.message)?error.message:'PUBLISH_FAILED'; }
    researchStatus[account]={frozen,total:research.total,pending:research.pending,settled:research.base.n,ledger,deferred:research.deferred,tickRequests:tickProgress.requests};
  }
  store.setMeta('publicCooldown',cooldownUntil);await atomic(path.join(root,'public-cooldown.json'),{until:cooldownUntil});store.prune();
  } finally {store.close();}
  const smcPayload={schemaVersion:1,account:'SMC',observerRevision:smc.observerRevision,mode:'OBSERVE_ONLY',orderAuthority:false,
    strategyRevision:smc.strategyRevision,scannerRevision:smc.scannerRevision,asOf:smc.asOf,sourceAsOf:smc.sourceAsOf,
    sourceStatus:smc.sourceStatus,sourceHealth:smc.sourceHealth,candidates:smc.candidates,structureContexts:smc.structureContexts,opportunityReviews:smc.opportunityReviews,structurePlans:smc.structurePlans,research:smc.research,shadow:smc.shadow};
  try { receipts.SMC=await publish(smcPayload); } catch(error) { receipts.SMC=/^PUBLISH_[A-Z0-9_]+$/.test(error?.message)?error.message:'PUBLISH_FAILED'; }
  return {at:new Date().toISOString(),counts:{...Object.fromEntries(['S1','S2'].map(account=>[account,selected[account].length])),SMC:smc.candidates.length},receipts,
    research:{...researchStatus,SMC:smc.research},smcSourceStatus:smc.sourceStatus,mode:'OBSERVE_ONLY',orderAuthority:false};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  await fs.mkdir(root,{recursive:true,mode:0o700});
  do {
    try { const result=await cycle(); await atomic(path.join(root,'status.json'),result); process.stdout.write(`${JSON.stringify(result)}\n`); }
    catch(error) { process.stderr.write(`${JSON.stringify({at:new Date().toISOString(),status:'DEGRADED',code:/^[A-Z0-9_]+$/.test(error?.message)?error.message:'JEV_OBSERVER_FAILED'})}\n`); }
    if(process.argv.includes('--once'))break;
    await wait(300_000);
  } while(true);
}
