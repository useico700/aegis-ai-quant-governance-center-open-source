import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { clientId as s1ClientId } from '../../agents/orion-live/s1-execution/common.mjs';
import { clientId as s2ClientId } from '../../agents/orion-live/s2-execution/common.mjs';
import { PositionLedger as S1PositionLedger } from '../../agents/orion-live/s1-execution/position-ledger.mjs';
import { PositionLedger as S2PositionLedger } from '../../agents/orion-live/s2-execution/position-ledger.mjs';
import { buildEntryLossContext } from '../../agents/shared/entry-loss-context.mjs';
import { sha } from './filter-core.mjs';
import { consumeTradePage, tradeOutcome } from './research-core.mjs';

// Only this observer-owned database is writable. Predictions are insert-only;
// later writes update outcome, cursor and locally matched trade fields only.
export class ResearchStore {
  constructor(file) {
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS trials(key TEXT PRIMARY KEY, frozen TEXT NOT NULL, progress TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pages(hash TEXT PRIMARY KEY, recorded INTEGER NOT NULL, proof TEXT NOT NULL, raw BLOB);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(account TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,id));`);
  }
  all() {return this.db.prepare('SELECT frozen,progress FROM trials ORDER BY updated,key').all().map(r=>({...JSON.parse(r.frozen),...JSON.parse(r.progress)}));}
  insert(trial) {if(!trial)return false;return this.db.prepare('INSERT OR IGNORE INTO trials VALUES(?,?,?,?)').run(trial.key,JSON.stringify(trial),JSON.stringify({result:trial.result,cursor:trial.cursor,trade:trial.trade}),trial.frozenAt).changes>0;}
  progress(trial, now) {this.db.prepare('UPDATE trials SET progress=?,updated=? WHERE key=?').run(JSON.stringify({result:trial.result,cursor:trial.cursor,trade:trial.trade,error:trial.error??null}),now,trial.key);}
  meta(key) {const r=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);return r?JSON.parse(r.value):null;}
  setMeta(key,value) {this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  savePage(symbol,params,rows,now) {
    const hash=sha({symbol,params,rows});
    this.db.prepare('INSERT OR IGNORE INTO pages VALUES(?,?,?,?)').run(hash,now,JSON.stringify({symbol,params,count:rows.length,first:rows[0]??null,last:rows.at(-1)??null}),gzipSync(JSON.stringify(rows)));
    return hash;
  }
  prune() {
    let size=Number(this.db.prepare('SELECT COALESCE(SUM(length(raw)),0) AS n FROM pages').get().n);
    // Reclaim reusable SQLite pages; retain hashes, endpoints and trial hit facts.
    if(size>128*1024*1024)for(const r of this.db.prepare('SELECT hash,length(raw) AS n FROM pages WHERE raw IS NOT NULL ORDER BY recorded LIMIT 2000').all()) {
      this.db.prepare('UPDATE pages SET raw=NULL WHERE hash=?').run(r.hash);size-=r.n;if(size<=96*1024*1024)break;
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close(){this.db.close();}
}

export async function settleTrials(store, publicGet, now=Date.now(), budget=12) {
  const cache=new Map();let requests=0;
  const pending=store.all().filter(r=>!r.result);
  for(const trial of pending) {
    if(now-trial.cursor.time>47*3600000){trial.result={status:'DATA_WINDOW_EXPIRED',y:null,resolvedAt:now};store.progress(trial,now);continue;}
    const through=Math.min(trial.deadlineAt,now-2000,trial.cursor.time+3599999);
    if(through<trial.cursor.time)continue;
    const params=trial.cursor.lastId===null?{symbol:trial.symbol,startTime:trial.cursor.time,endTime:through,limit:1000}:{symbol:trial.symbol,fromId:String(BigInt(trial.cursor.lastId)+1n),limit:1000};
    const cacheKey=JSON.stringify(params);
    if(!cache.has(cacheKey)&&requests>=budget)continue;
    try {
      if(!cache.has(cacheKey)){requests++;cache.set(cacheKey,await publicGet('/fapi/v1/aggTrades',params));}
      const rows=cache.get(cacheKey), proof=store.savePage(trial.symbol,params,rows,now);
      const update=consumeTradePage(trial,rows,through,now);
      trial.cursor=update.cursor;trial.result=update.result?{...update.result,proof}:null;trial.error=null;
    } catch(error) {
      const code=/^(RESEARCH_|PUBLIC_)[A-Z0-9_]+$/.test(error?.message)?error.message:'PUBLIC_READ_FAILED';
      trial.error=code;
      if(code.startsWith('RESEARCH_'))trial.result={status:'DATA_GAP',y:null,resolvedAt:now};
      if(code==='PUBLIC_HTTP_429'||code==='PUBLIC_HTTP_418'||code==='PUBLIC_WEIGHT_HIGH'||code==='PUBLIC_COOLDOWN'){store.progress(trial,now);break;}
    }
    store.progress(trial,now);
  }
  return {requests,pending:store.all().filter(r=>!r.result).length};
}

export function matchLedger(store,account,file,now=Date.now()) {
  // Never instantiate the live journal or request a writable connection.
  let source;
  try {
    source=new DatabaseSync(file,{readOnly:true});
    source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
    const cursor=store.meta(`ledger:${account}`)??{seq:0,digest:null};
    if(cursor.seq && source.prepare('SELECT digest FROM events WHERE sequence=?').get(cursor.seq)?.digest!==cursor.digest)throw new Error('LEDGER_HISTORY_CHANGED');
    const head=source.prepare('SELECT sequence AS seq,digest FROM events ORDER BY sequence DESC LIMIT 1').get();
    const events=source.prepare("SELECT sequence AS seq,digest,payload FROM events WHERE sequence>? AND sequence<=? AND json_extract(payload,'$.type')='POSITION_VIEW' ORDER BY sequence LIMIT 2000").all(cursor.seq,head?.seq??0);
    store.db.exec('BEGIN');
    try {
      for(const event of events) {
        const e=JSON.parse(event.payload);
        if(e.type==='POSITION_VIEW'&&e.position?.id) {
          const p=e.position;
          // Bind the position to its latest active reservation generation. A
          // released draft is never treated as a traded structure.
          const reservationRow=account==='S2'&&p.id.startsWith('s2z1_')?source.prepare("SELECT payload FROM events WHERE sequence<=? AND ((json_extract(payload,'$.type')='PLAN_RESERVED' AND json_extract(payload,'$.plan.id')=?) OR (json_extract(payload,'$.type')='ENTRY_PRE_DISPATCH_RELEASED' AND json_extract(payload,'$.planId')=?)) ORDER BY sequence DESC LIMIT 1").get(event.seq,p.id,p.id):null;
          const reservation=reservationRow?JSON.parse(reservationRow.payload):null,plan=reservation?.type==='PLAN_RESERVED'?reservation.plan:null;
          const structure=plan?.symbol===p.symbol&&['LONG','SHORT'].includes(plan.direction)&&plan.direction===(p.direction===1?'LONG':'SHORT')
            &&plan.structureRevision==='S2-15M-Z-FIRST-1H-PX-1'&&/^[a-f0-9]{64}$/.test(plan.zStructure?.geometryHash??'')
            ?{structureRevision:plan.structureRevision,structureGeometryHash:plan.zStructure.geometryHash}:{};
          const minimal={...structure,id:p.id,symbol:p.symbol,direction:p.direction,status:p.status,openedAt:p.openedAt,closedAt:p.closedAt,
            exact:{initialRiskUsdt:p.exact?.initialRiskUsdt},netPnlIncludingKnownFundingUsdt:p.netPnlIncludingKnownFundingUsdt,
            accountingComplete:p.accountingComplete,fundingAttributionComplete:p.fundingAttributionComplete,
            managementRevision:p.managementPolicy?.revision??'R22-LEGACY'};
          store.db.prepare('INSERT INTO positions VALUES(?,?,?) ON CONFLICT(account,id) DO UPDATE SET payload=excluded.payload').run(account,p.id,JSON.stringify(minimal));
        }
      }
      const end=events.length===2000?events.at(-1):head;
      if(end)store.setMeta(`ledger:${account}`,{seq:end.seq,digest:end.digest});
      store.db.exec('COMMIT');
    } catch(error){store.db.exec('ROLLBACK');throw error;}
    // A capped replay is incomplete, so no trade statistics are claimed yet.
    if(events.length===2000)return 'CATCHING_UP';
    const positions=new Map(store.db.prepare('SELECT id,payload FROM positions WHERE account=?').all(account).map(r=>[r.id,JSON.parse(r.payload)]));
    for(const trial of store.all().filter(r=>r.account===account)) {
      trial.trade=tradeOutcome(trial,positions.get(trial.planId));
      // Preserve tick scheduling fairness; ledger refresh must not reset it.
      store.db.prepare('UPDATE trials SET progress=? WHERE key=?').run(JSON.stringify({result:trial.result,cursor:trial.cursor,trade:trial.trade,error:trial.error??null}),trial.key);
    }
    return 'SYNCED';
  } catch(error) {return error?.message==='LEDGER_HISTORY_CHANGED'?'HISTORY_CHANGED':'UNAVAILABLE';}
  finally {source?.close();}
}

// Pure projection for loss attribution only. The release proof mirrors the
// durable runtime protocol, with no transport or execution methods available.
export function projectEntryHistory(account,events) {
 const journal={events,append(){throw Error('JEV_READ_ONLY');}},kernel={plans:new Map(),intents:new Map(),journal};
 const generations=new Map(),reservations=new Map(),activity=new Set(),dispatch=new Set();
 const clientId=account==='S1'?s1ClientId:s2ClientId;
 for(const event of events){
  if(['VENUE_FILL','EXTERNAL_POSITION_EXIT'].includes(event.type))activity.add(event.planId);
  if(event.type==='POSITION_VIEW')activity.add(event.position.id);
  if(event.type==='PLAN_RESERVED'){
   const g=event.reservationGeneration??0;
   if(!Number.isSafeInteger(g)||g<0||g!==(generations.get(event.plan.id)??0))throw Error('JEV_RELEASE_GENERATION');
   kernel.plans.set(event.plan.id,event.plan);reservations.set(event.plan.id,g);
  }
  if(event.type==='INTENT')kernel.intents.set(event.id,{...event,result:null});
  if(event.type==='DISPATCH_STARTED'){if(!kernel.intents.has(event.id))throw Error('JEV_DISPATCH_INTENT');dispatch.add(event.id);}
  if(event.type==='OBSERVED'){if(!kernel.intents.has(event.id))throw Error('JEV_LEDGER_INTENT_MISSING');kernel.intents.get(event.id).result=event.result;}
  if(event.type==='ENTRY_PRE_DISPATCH_RELEASED'){
   const p=kernel.plans.get(event.planId),id=clientId('entry',event.planId),i=kernel.intents.get(id);
   const proof=i?`UNSENT_${i.dispatchProtocol}`:'NO_ENTRY_INTENT';
   const releasablePolicy=!!p?.entryConfirmation||(account==='S1'&&p?.schema==='S1_VALIDATED_ENTRY_V1'&&p.revision==='MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION');
   if(!releasablePolicy||event.planFingerprint!==p.fingerprint||event.entryIntentId!==id
     ||event.reservationGeneration!==reservations.get(p.id)||activity.has(p.id)||dispatch.has(id)
     ||[...kernel.intents.values()].some(x=>x.planId===p.id&&x.id!==id)
     ||(i&&(i.planId!==p.id||i.kind!=='entry'||i.method!=='POST'||i.path!=='/fapi/v1/order'
       ||i.params?.newClientOrderId!==id||!['MARKER_V1','MARKER_V2_NETWORK'].includes(i.dispatchProtocol)||i.result!==null))
     ||event.proof!==proof)throw Error('JEV_RELEASE_PROOF');
   kernel.plans.delete(p.id);kernel.intents.delete(id);reservations.delete(p.id);generations.set(p.id,event.reservationGeneration+1);
  }
 }
 const book=new (account==='S1'?S1PositionLedger:S2PositionLedger)(journal);
 return {book,kernel};
}

// A separate bounded, read-only event projection supplies the exact same owned
// fill attribution as live. It never instantiates a kernel or writable journal.
export function readEntryLossContexts(account,file,candidates,now=Date.now()) {
 const contexts=new Map(),keys=[...new Map(candidates.map(r=>[`${r.symbol}:${r.direction}`,r])).values()];
 contexts.observedAt=now;
 let source;
 try {
  source=new DatabaseSync(file,{readOnly:true});source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
  const raw=source.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.type') IN ('POSITION_VIEW','PLAN_RESERVED','INTENT','OBSERVED','VENUE_FILL','EXTERNAL_POSITION_EXIT','MANAGEMENT_OPERATION','INCOME_FACT','DISPATCH_STARTED','ENTRY_PRE_DISPATCH_RELEASED') ORDER BY sequence LIMIT 100001").all();
  if(raw.length>100000)throw Error('LEDGER_PROJECTION_LIMIT');
  const events=raw.map(r=>JSON.parse(r.payload)),{book,kernel}=projectEntryHistory(account,events);
  for(const r of keys)contexts.set(`${r.symbol}:${r.direction}`,buildEntryLossContext({account,symbol:r.symbol,direction:r.direction,book,kernel,now}));
 }catch{for(const r of keys)contexts.set(`${r.symbol}:${r.direction}`,{evidenceComplete:false});}
 finally{source?.close();}
 return contexts;
}
