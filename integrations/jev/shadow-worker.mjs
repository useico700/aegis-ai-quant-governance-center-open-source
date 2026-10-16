import { blockLegacyDirectLaunch } from "../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { readS2ScannerState } from './scanner-state-read.mjs';
import { scannerPlans } from './structure-quality.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseExchangeJson } from '../../lib/exchange-json.mjs';
import { COIN_IDS } from './filter-core.mjs';
import { poolCandidates, shadowKey, enlist, syncWaitingPolicy, quoteReady, manage, attemptEntry, invalidateContinuity, applyFunding, summarize, event } from './shadow-core.mjs';
import { observeSmcSnapshot } from './smc-observer.mjs';
const root='/var/lib/aegis/jev-shadow';
const read=async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch{return null;}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function run() {
 if(os.hostname()!=='aegis-demo-host'||process.env.AEGIS_PRODUCTION_HOST_ID!=='demo-server'||process.getuid()!==993)throw Error('SHADOW_HOST_BOUNDARY');
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const db=new DatabaseSync(`${root}/shadow.sqlite`);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rows(key TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,payload TEXT NOT NULL);');
 const rows=db.prepare('SELECT payload FROM rows').all().map(r=>JSON.parse(r.payload));
 const meta=k=>{const r=db.prepare('SELECT payload FROM meta WHERE key=?').get(k);return r?JSON.parse(r.payload):null;};
 const set=(k,v)=>db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(k,JSON.stringify(v));
 const save=r=>db.prepare('INSERT OR REPLACE INTO rows VALUES(?,?)').run(r.key,JSON.stringify(r));
 const startedAt=meta('startedAt')??Date.now();set('startedAt',startedAt);
 invalidateContinuity(rows,'PROCESS_RESTART',Date.now());rows.forEach(save);
 const config=await read(new URL('./shadow-config/strategy.json',import.meta.url));
 if(!config?.S1||!config?.S2||!config?.SMC)throw Error('SHADOW_POLICY_MISSING');
 syncWaitingPolicy(rows,config,Date.now());rows.forEach(save);
 let stopped=false,connected=false,lastMessage=0,cooldown=meta('cooldown')??0,requestTimes=[];
 let sockets=[],generation=0;
 let plans={},quotes={},ticks={},bars={},rules={},health='CONNECTING',sourceHealth='WAIT_SOURCE',smcObservation=null;
 const atom=async(file,data)=>{await fs.writeFile(`${file}.tmp`,JSON.stringify(data),{mode:0o600});await fs.rename(`${file}.tmp`,file);};
 const get=async(endpoint,params={})=>{
  if(!['/fapi/v1/exchangeInfo','/fapi/v1/klines','/fapi/v1/fundingRate'].includes(endpoint))throw Error('PUBLIC_PATH_INVALID');
  const now=Date.now();requestTimes=requestTimes.filter(t=>now-t<60000);
  if(now<cooldown||requestTimes.length>=30)throw Error('PUBLIC_COOLDOWN');
  requestTimes.push(now);const url=new URL(endpoint,'https://demo-fapi.binance.com');url.search=new URLSearchParams(params);
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(7000)});
  if([418,429].includes(response.status)){cooldown=now+Math.max(300,Number(response.headers.get('retry-after'))||300)*1000;set('cooldown',cooldown);}
  const weight=Number(response.headers.get('x-mbx-used-weight-1m'));if(Number.isFinite(weight)&&weight>1500){cooldown=now+60000;set('cooldown',cooldown);}
  if(!response.ok)throw Error('PUBLIC_READ_FAILED');return response.json();
 };
 const updateRules=async()=>{const info=await get('/fapi/v1/exchangeInfo');for(const s of info.symbols??[])if(COIN_IDS[s.symbol]&&s.status==='TRADING'&&s.contractType==='PERPETUAL'){
  const f=Object.fromEntries(s.filters.map(f=>[f.filterType,f])),lot=f.MARKET_LOT_SIZE;
  rules[s.symbol]={at:Date.now(),tickSize:f.PRICE_FILTER.tickSize,minNotional:Number(f.MIN_NOTIONAL.notional),marketLot:{min:lot.minQty,step:lot.stepSize,max:lot.maxQty}};
 }};
 const activeSymbols=()=>[...new Set(rows.filter(r=>r.position?.status==='OPEN'||(!r.position&&r.eligible)).map(r=>r.symbol))];
 const processSymbol=(symbol,now)=>{
  const q=quotes[symbol],t=ticks[symbol];if(!connected||!quoteReady(q,t,now))return;
  for(const r of rows.filter(r=>r.symbol===symbol&&r.position?.status==='OPEN')) {
   if(r.lastEvidenceAt&&now-r.lastEvidenceAt>10000&&r.eligible){r.eligible=false;event(r,'DATA_GAP',now,{reason:'QUOTE_COVERAGE_GAP'});save(r);}
   r.lastEvidenceAt=now;
   try{if(rules[symbol]&&manage(r,q,t,bars[symbol],rules[symbol],now))save(r);}catch{health='MANAGEMENT_RETRY';}
  }
  for(const r of rows.filter(r=>r.symbol===symbol&&!r.position&&r.eligible).sort((a,b)=>Math.abs(q.ask/a.px-1)-Math.abs(q.ask/b.px-1)||a.selectedAt-b.selectedAt)) {
   const previous=r.reason, otherEvents=rows.filter(x=>x.symbol===symbol&&x.position?.status==='OPEN').map(x=>[x,x.events.length]);
   try{if(attemptEntry(r,{plan:plans[r.account]?.get(r.id),bars:bars[symbol]?.[r.account==='S1'?'15m':'5m'],barsByInterval:bars[symbol],q,t,rule:rules[symbol],rows,quotes,now})||r.reason!==previous){r.lastEvidenceAt=now;save(r);}}catch{r.reason='SHADOW_EVIDENCE_RETRY';save(r);}
   for(const [x,n] of otherEvents)if(x.events.length!==n)save(x);
  }
 };
 const connect=()=>{
  const gen=++generation;
  const groups={public:Object.keys(COIN_IDS).map(s=>`${s.toLowerCase()}@depth5@100ms`),market:Object.keys(COIN_IDS).flatMap(s=>['aggTrade','kline_1h','kline_15m','kline_5m'].map(k=>`${s.toLowerCase()}@${k}`))};
  sockets=[];
  for(const [kind,streams] of Object.entries(groups)){
  const ws=new WebSocket(`wss://fstream.binancefuture.com/${kind}/stream?streams=${streams.join('/')}`);sockets.push(ws);ws.lastAt=Date.now();
  ws.onopen=()=>{if(gen!==generation)return;connected=sockets.length===2&&sockets.every(x=>x.readyState===1);if(connected)health='RUNNING';};
  ws.onmessage=e=>{
   if(gen!==generation)return;const now=Date.now();lastMessage=now;ws.lastAt=now;
   try {let d=parseExchangeJson(e.data).data;if(!d||!COIN_IDS[d.s])return;
    if(d.e==='depthUpdate'){const prev=quotes[d.s];if(prev&&BigInt(d.u)<=BigInt(prev.updateId))return;if(prev&&String(d.pu)!==String(prev.updateId)){invalidateContinuity(rows.filter(r=>r.symbol===d.s),'DEPTH_SEQUENCE_GAP',now);rows.filter(r=>r.symbol===d.s).forEach(save);}
     d={e:'bookTicker',s:d.s,T:d.T,E:d.E,u:d.u,b:d.b?.[0]?.[0],B:d.b?.[0]?.[1],a:d.a?.[0]?.[0],A:d.a?.[0]?.[1]};}
    if(d.e==='bookTicker'&&![d.b,d.a,d.B,d.A].every(v=>Number(v)>0))throw Error('BBO_INVALID');
    if(d.e==='bookTicker'){
     const prev=quotes[d.s];if(prev&&(BigInt(d.u)<=BigInt(prev.updateId)||d.T<prev.marketTime))return;
     quotes[d.s]={bid:Number(d.b),ask:Number(d.a),bidQty:Number(d.B),askQty:Number(d.A),marketTime:d.T??d.E,receivedAt:now,updateId:String(d.u)};
    }else if(d.e==='aggTrade'){
     if(ticks[d.s]&&(d.T<ticks[d.s].marketTime||BigInt(d.a)<=BigInt(ticks[d.s].id)))return;
     if(ticks[d.s]?.id&&BigInt(d.a)!==BigInt(ticks[d.s].id)+1n){invalidateContinuity(rows.filter(r=>r.symbol===d.s),'TRADE_SEQUENCE_GAP',now);rows.filter(r=>r.symbol===d.s).forEach(save);}
     ticks[d.s]={price:Number(d.p),marketTime:d.T,receivedAt:now,id:String(d.a)};
    }else if(d.e==='kline'&&d.k?.x&&d.k.T<now){
     const k=d.k;if(!bars[d.s]?.[k.i])return;
     const b={openTime:k.t,closeTime:k.T,open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v)};
     const list=bars[d.s][k.i];if(b.openTime>list.at(-1)?.openTime){if(b.openTime!==list.at(-1).closeTime+1){invalidateContinuity(rows.filter(r=>r.symbol===d.s),'BAR_GAP',now);rows.filter(r=>r.symbol===d.s).forEach(save);}bars[d.s][k.i]=[...list,b].slice(-1000);}
    }
    processSymbol(d.s,now);
   }catch{health='STREAM_PARSE_RETRY';invalidateContinuity(rows,'STREAM_PARSE_GAP',now);rows.forEach(save);}
  };
  ws.onerror=()=>{health='RECONNECTING';};
  ws.onclose=()=>{if(gen!==generation)return;++generation;connected=false;health='RECONNECTING';quotes={};ticks={};bars={};invalidateContinuity(rows,'STREAM_DISCONNECTED',Date.now());rows.forEach(save);for(const sock of sockets)try{sock.close();}catch{}if(!stopped)setTimeout(connect,5000);};
  }
 };
 const refreshSources=async()=>{
  const now=Date.now();let allFresh=true;
  try { smcObservation=observeSmcSnapshot(await read('/data/smc-scanner/latest.json'),config.SMC,now); }
  catch { smcObservation={sourceStatus:'INVALID',candidates:[],research:{status:'UNAVAILABLE'},shadow:{status:'OBSERVE_ONLY',simulatedEntryAllowed:false,liveOrderAuthority:false}}; }
  for(const account of ['S1','S2']) {
   const payload=await read(`/data/jev/${account.toLowerCase()}-observation.json`),snapshot=await read(`/data/${account.toLowerCase()}-scanner/latest.json`);
   let state=account==='S2'?await readS2ScannerState('/data/s2-scanner/state.json'):await read('/data/s1-scanner/state.json');
   let planEvidence=true;try{plans[account]=scannerPlans(account,state);}catch{planEvidence=false;plans[account]=new Map();}
   const fresh=planEvidence&&now-Date.parse(snapshot?.sourceAsOf)<180000&&now-Date.parse(payload?.asOf)<1200000;
   const pool=fresh?poolCandidates(payload,now):[];if(!fresh)allFresh=false;
   const keys=new Set(pool.map(shadowKey));
   for(const r of rows.filter(r=>r.account===account&&!r.position&&r.state!=='INVALIDATED')) {
    r.eligible=keys.has(r.key);r.state=r.eligible?'WAITING':'OUT_OF_POOL';if(!r.eligible)r.reason=fresh?'OUT_OF_POOL':'WAIT_SOURCE';save(r);
   }
   for(const r of pool) {
    const known=rows.find(x=>x.key===shadowKey(r));
    if(known){known.lastPoolAt=now;continue;}
    if(rows.some(x=>x.account===account&&x.id===r.id&&x.position))continue;
    const record=enlist(r,plans[account].get(r.id),config[account],now);if(record){rows.push(record);save(record);}
   }
  }
  sourceHealth=allFresh?'RUNNING':'WAIT_SOURCE';
  if(connected&&allFresh&&activeSymbols().every(s=>rules[s]&&['1h','15m','5m'].every(i=>bars[s]?.[i]?.length)))health='RUNNING';
 };
 const refreshBars=async()=>{
  for(const symbol of activeSymbols())for(const interval of ['1h','15m','5m'])if(!bars[symbol]?.[interval])try{
   const width={'1h':3600000,'15m':900000,'5m':300000}[interval];
   const raw=await get('/fapi/v1/klines',{symbol,interval,limit:'1000'}),now=Date.now();
   const list=raw.map(k=>({openTime:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5]),closeTime:Number(k[6])})).filter(b=>b.closeTime<now);
   if(list.length<30||now-list.at(-1).closeTime>width+60000||list.some((b,i)=>i&&b.openTime!==list[i-1].closeTime+1))throw Error('BARS_GAP');
   bars[symbol]??={};bars[symbol][interval]=list;
  }catch{health='DATA_RETRY';}
 };
 const funding=async()=>{
  for(const symbol of new Set(rows.filter(r=>r.position&&(r.position.status==='OPEN'||r.position.fundingThrough<r.position.closedAt)).map(r=>r.symbol)))try{
   const own=rows.filter(r=>r.symbol===symbol&&r.position),from=Math.min(...own.map(r=>r.position.fundingThrough)),through=Date.now()-60000;
   if(through<=from)continue;
   const records=await get('/fapi/v1/fundingRate',{symbol,startTime:String(from),endTime:String(through),limit:'1000'});
   const covered=records.length===1000?Number(records.at(-1).fundingTime):through;
   own.forEach(r=>{applyFunding(r,records,covered);save(r);});
  }catch{/* Unreconciled funding explicitly excluded from valid closed results. */}
 };
 const publish=async()=>{
  const now=Date.now(),status=!connected?'RECONNECTING':sourceHealth!=='RUNNING'?sourceHealth:health;
  const summary=summarize(rows,quotes,now,startedAt,status);
  await atom(`${root}/smc-status.json`,{...smcObservation,asOf:new Date(now).toISOString(),orderAuthority:false});
  // Stale marks are never presented as current floating profit.
  for(const a of summary.accounts)if(rows.some(r=>r.account===a.account&&r.position?.status==='OPEN'&&!quoteReady(quotes[r.symbol],ticks[r.symbol],now))){a.unrealized=null;a.equity=null;}
  for(const r of summary.rows)if(r.position&&r.position.unrealized!==null&&!quoteReady(quotes[r.symbol],ticks[r.symbol],now))r.position.unrealized=null;
  await atom(`${root}/latest.json`,summary);
  try {
   const token=process.env.JEV_FILTER_INGEST_TOKEN,bypass=process.env.JEV_FILTER_BYPASS_TOKEN;
   if(!token||!bypass)throw Error('PUBLISH_SECRET_MISSING');
   const response=await fetch('https://your-cockpit.example.invalid',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'oai-sites-authorization':`Bearer ${bypass}`},body:JSON.stringify(summary)});
   const result=await response.json();if(!response.ok||!['SYNCED','OLDER_IGNORED'].includes(result.status))throw Error('PUBLISH_FAILED');
   await atom(`${root}/status.json`,{at:new Date().toISOString(),status,receipt:result.status,selected:rows.length,open:rows.filter(r=>r.position?.status==='OPEN').length,orderAuthority:false});
  }catch{await atom(`${root}/status.json`,{at:new Date().toISOString(),status,receipt:'RETRYING',orderAuthority:false});}
  rows.filter(r=>r.position?.status==='OPEN').forEach(save);db.exec('PRAGMA wal_checkpoint(PASSIVE)');
 };
 process.on('SIGTERM',()=>{stopped=true;sockets.forEach(x=>x.close());});process.on('SIGINT',()=>{stopped=true;sockets.forEach(x=>x.close());});
 await refreshSources();await updateRules().catch(()=>{health='WAIT_RULES';});connect();
 let lastSource=0,lastPublish=0,lastFunding=0,lastRules=Date.now();
 while(!stopped){const now=Date.now();
  if(now-lastSource>=10000){await refreshSources();await refreshBars();lastSource=Date.now();}
  if(now-lastFunding>=600000){await funding();lastFunding=Date.now();}
  if(now-lastRules>=21600000){await updateRules().catch(()=>{});lastRules=now;}
  if(sockets.some(s=>now-s.lastAt>15000)){sockets.forEach(s=>s.close());}
  if(now-lastPublish>=30000){await publish();lastPublish=Date.now();}
  await delay(1000);
 }
 rows.forEach(save);db.close();
}
if(process.argv[1]===new URL(import.meta.url).pathname)run().catch(()=>{console.error('SHADOW_WORKER_FAILED');process.exitCode=1;});
