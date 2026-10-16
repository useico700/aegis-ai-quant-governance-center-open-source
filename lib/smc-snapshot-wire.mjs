// Lossless HTTP/storage encoding only. Domain admission still validates the
// fully expanded snapshot. No bars, zones, plans or contextual proof are cut.
import {createHash} from 'node:crypto';

export const SMC_SNAPSHOT_WIRE_REVISION='SMC-SNAPSHOT-WIRE-1';
const KINDS=new Set(['CANDIDATE','STRUCTURE_PLAN','STRUCTURE_CONTEXT','TARGET_PATH_FULL','TARGET_PATH_COMPACT','JSON_VALUE']);
const KIND_CODES=['CANDIDATE','STRUCTURE_PLAN','STRUCTURE_CONTEXT','TARGET_PATH_FULL','TARGET_PATH_COMPACT','JSON_VALUE'];
const REF='$r';
const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const check=(ok,code)=>{if(!ok)throw new Error(code);};
function stringify(value){
 try{return JSON.stringify(value,(_k,v)=>{
  if(typeof v==='number'&&!Number.isFinite(v)||['bigint','function','symbol'].includes(typeof v))throw new Error('SMC_WIRE_NOT_JSON');
  return v;
 });}catch{throw new Error('SMC_WIRE_NOT_JSON');}
}
const clone=value=>JSON.parse(stringify(value));
const digest=(kind,symbol,value)=>createHash('sha256').update(stringify([kind,symbol,value])).digest('hex');
const isRef=v=>object(v)&&own(v,REF);
const symbolValid=s=>typeof s==='string'&&/^[A-Z0-9]{3,24}$/.test(s);
function noReferences(value){
 if(!value||typeof value!=='object')return;
 check(!isRef(value),'SMC_WIRE_UNEXPECTED_REFERENCE');
 for(const v of Object.values(value))noReferences(v);
}
function shape(kind,value,symbol){
 check(object(value)&&symbolValid(symbol),'SMC_WIRE_OBJECT_INVALID');
 if(['CANDIDATE','STRUCTURE_PLAN','TARGET_PATH_FULL','TARGET_PATH_COMPACT'].includes(kind))
  check(value.symbol===symbol,'SMC_WIRE_SYMBOL_MISMATCH');
 if(kind==='TARGET_PATH_FULL')check(value.revision==='SMC-TARGET-PATH-1'&&Array.isArray(value.sourceBars)
  &&Array.isArray(value.zones)&&value.evidenceMode!=='COMPACT','SMC_WIRE_FULL_PROOF_REQUIRED');
 if(kind==='TARGET_PATH_COMPACT')check(value.revision==='SMC-TARGET-PATH-1'&&value.evidenceMode==='COMPACT'
  &&value.sourceBars===undefined&&Array.isArray(value.zones),'SMC_WIRE_COMPACT_PROOF_REQUIRED');
}
function transformSnapshot(snapshot,read){
 const result=clone(snapshot);
 const context=(value,symbol)=>read('STRUCTURE_CONTEXT',value,symbol,v=>{noReferences(v);return clone(v);});
 const full=(value,symbol)=>read('TARGET_PATH_FULL',value,symbol,v=>{noReferences(v);return clone(v);});
 const compact=(value,symbol)=>read('TARGET_PATH_COMPACT',value,symbol,v=>{noReferences(v);return clone(v);});
 const plan=(value,symbol)=>read('STRUCTURE_PLAN',value,symbol,v=>{
  const p=clone(v);
  if(v.targetPathEvidence!=null)p.targetPathEvidence=compact(v.targetPathEvidence,symbol);
  return p;
 });
 const candidate=(value,symbol)=>read('CANDIDATE',value,symbol,v=>{
  const c=clone(v);
  if(v.sourcePlan!=null)c.sourcePlan=plan(v.sourcePlan,symbol);
  if(v.sourceContext!=null)c.sourceContext=context(v.sourceContext,symbol);
  if(v.sourceTargetPathEvidence!=null)c.sourceTargetPathEvidence=full(v.sourceTargetPathEvidence,symbol);
  return c;
 });
 if(snapshot.results!=null){
  check(Array.isArray(snapshot.results),'SMC_WIRE_RESULTS_INVALID');
  result.results=snapshot.results.map(row=>{
   check(object(row)&&symbolValid(row.symbol),'SMC_WIRE_RESULT_INVALID');
   const r=clone(row),symbol=row.symbol;
   if(row.structureContext!=null)r.structureContext=context(row.structureContext,symbol);
   if(row.structurePlans!=null){check(Array.isArray(row.structurePlans),'SMC_WIRE_PLANS_INVALID');r.structurePlans=row.structurePlans.map(p=>plan(p,symbol));}
   if(row.candidates!=null){check(Array.isArray(row.candidates),'SMC_WIRE_CANDIDATES_INVALID');r.candidates=row.candidates.map(c=>candidate(c,symbol));}
   return r;
  });
 }
 if(snapshot.candidates!=null){
  check(Array.isArray(snapshot.candidates),'SMC_WIRE_CANDIDATES_INVALID');
  result.candidates=snapshot.candidates.map(c=>candidate(c,c.symbol));
 }
 return result;
}

// A second pass shares only repeated, byte-identical subtrees. It runs after
// whole candidates are pooled, so their two transport copies do not falsely
// make every unique child appear repeated. Symbol remains part of every key.
function shareSubtrees(packed){
 const oldPool=new Map(packed.wirePool.map(e=>[e.sha256,e])),counts=new Map(),pool=new Map(),mapped=new Map();
 const key=(v,s)=>stringify([s,v]);
 const count=(v,s)=>{
  if(!v||typeof v!=='object'||isRef(v))return;
  const json=stringify(v);if(json.length>=64){const k=key(v,s);counts.set(k,(counts.get(k)??0)+1);}
  for(const child of Object.values(v))count(child,s);
 };
 for(const e of oldPool.values())count(e.value,e.symbol);
 for(const r of packed.results??[])count(r,r.symbol);
 const save=(kind,symbol,value)=>{
  const sha256=digest(kind,symbol,value),e={kind,symbol,sha256,value},previous=pool.get(sha256);
  check(!previous||stringify(previous)===stringify(e),'SMC_WIRE_HASH_COLLISION');pool.set(sha256,e);
  return {[REF]:sha256,kind,symbol};
 };
 const encode=(v,s,root=false)=>{
  if(!v||typeof v!=='object')return v;
  if(isRef(v)){
   if(mapped.has(v[REF]))return clone(mapped.get(v[REF]));
   const e=oldPool.get(v[REF]);check(e&&e.symbol===s,'SMC_WIRE_REFERENCE_SCOPE');
   const ref=save(e.kind,s,encode(e.value,s,true));mapped.set(v[REF],ref);return clone(ref);
  }
  const output=Array.isArray(v)?v.map(child=>encode(child,s)):Object.fromEntries(Object.entries(v).map(([k,child])=>[k,encode(child,s)]));
  const count=counts.get(key(v,s))??0;
  const encodedLength=JSON.stringify(output,(_k,child)=>isRef(child)?{[REF]:999}:child).length;
  // Account for reference/pool overhead, especially for small repeated proof
  // objects shared by several model candidates. Unique objects stay inline.
  return !root&&count>1&&(count-1)*encodedLength>count*12+110?save('JSON_VALUE',s,output):output;
 };
 const result={...packed};
 if(packed.results)result.results=packed.results.map(r=>encode(r,r.symbol,true));
 if(packed.candidates)result.candidates=packed.candidates.map(c=>encode(c,c.symbol));
 result.wirePool=[...pool.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256));
 return inlineUnprofitableSubtrees(result);
}

function inlineUnprofitableSubtrees(packed){
 const entries=new Map(packed.wirePool.map(e=>[e.sha256,e])),uses=new Map(),pool=new Map(),cache=new Map();
 const count=v=>{if(!v||typeof v!=='object')return;if(isRef(v)){uses.set(v[REF],(uses.get(v[REF])??0)+1);return;}for(const c of Object.values(v))count(c);};
 const source={...packed};delete source.wirePool;count(source);for(const e of entries.values())count(e.value);
 const encode=v=>{
  if(!v||typeof v!=='object')return v;
  if(isRef(v)){
   if(cache.has(v[REF]))return clone(cache.get(v[REF]));
   const e=entries.get(v[REF]),value=encode(e.value),n=uses.get(e.sha256)??0;
   const length=JSON.stringify(value,(_k,c)=>isRef(c)?{[REF]:9999}:c).length;
   if(e.kind==='JSON_VALUE'&&(n-1)*length<=n*13+115){cache.set(e.sha256,value);return clone(value);}
   const sha256=digest(e.kind,e.symbol,value),ref={[REF]:sha256,kind:e.kind,symbol:e.symbol};
   const next={...e,sha256,value},previous=pool.get(sha256);check(!previous||stringify(previous)===stringify(next),'SMC_WIRE_HASH_COLLISION');
   pool.set(sha256,next);cache.set(e.sha256,ref);return clone(ref);
  }
  return Array.isArray(v)?v.map(encode):Object.fromEntries(Object.entries(v).map(([k,c])=>[k,encode(c)]));
 };
 return {...encode(source),wirePool:[...pool.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))};
}

// Hashes authenticate the full typed/symbol-scoped DAG. On the wire, an index
// avoids repeating a 64-byte hash and its type/symbol at every use. Restoring
// those fields from the pool precedes all digest and scope validation.
function compactWire(packed){
 const pool=packed.wirePool,index=new Map(pool.map((e,i)=>[e.sha256,i]));
 const symbols=[...new Set(pool.map(e=>e.symbol))].sort(),symbolIndex=new Map(symbols.map((s,i)=>[s,i]));
 const walk=v=>{
  if(!v||typeof v!=='object')return v;
  if(isRef(v)){check(index.has(v[REF]),'SMC_WIRE_REFERENCE_MISSING');return {[REF]:index.get(v[REF])};}
  return Array.isArray(v)?v.map(walk):Object.fromEntries(Object.entries(v).map(([k,c])=>[k,walk(c)]));
 };
 const result={...packed};delete result.wirePool;
 return {...walk(result),wireSymbols:symbols,wirePool:pool.map(e=>[KIND_CODES.indexOf(e.kind),symbolIndex.get(e.symbol),e.sha256,walk(e.value)])};
}
function expandWire(packed){
 const entries=packed.wirePool,symbols=packed.wireSymbols;
 check(Array.isArray(symbols)&&symbols.every(symbolValid)&&new Set(symbols).size===symbols.length,'SMC_WIRE_SYMBOLS_INVALID');
 check(Array.isArray(entries)&&entries.every(e=>Array.isArray(e)&&e.length===4&&Number.isInteger(e[0])&&KIND_CODES[e[0]]
  &&Number.isInteger(e[1])&&symbols[e[1]]),'SMC_WIRE_POOL_INVALID');
 const walk=v=>{
  if(!v||typeof v!=='object')return v;
  if(isRef(v)){
   check(Object.keys(v).length===1&&Number.isSafeInteger(v[REF])&&v[REF]>=0,'SMC_WIRE_REFERENCE_INVALID');
   const e=entries[v[REF]];check(e,'SMC_WIRE_REFERENCE_MISSING');
   return {[REF]:e[2],kind:KIND_CODES[e[0]],symbol:symbols[e[1]]};
  }
  return Array.isArray(v)?v.map(walk):Object.fromEntries(Object.entries(v).map(([k,c])=>[k,walk(c)]));
 };
 const result={...packed};delete result.wirePool;delete result.wireSymbols;
 return {...walk(result),wirePool:entries.map(e=>({kind:KIND_CODES[e[0]],symbol:symbols[e[1]],sha256:e[2],value:walk(e[3])}))};
}

/** Content addressing is by the exact JSON serialization AND kind/symbol.
 * Same id with different contents cannot overwrite a previous pooled object.
 */
export function packSmcSnapshot(snapshot){
 check(object(snapshot),'SMC_WIRE_SNAPSHOT_INVALID');
 const source=own(snapshot,'wireRevision')||own(snapshot,'wirePool')||own(snapshot,'wireSymbols')?unpackSmcSnapshot(snapshot):clone(snapshot);
 noReferences(source);
 const pool=new Map();
 const packed=transformSnapshot(source,(kind,value,symbol,transform)=>{
  shape(kind,value,symbol);
  const transformed=transform(value),sha256=digest(kind,symbol,transformed);
  const entry={kind,symbol,sha256,value:transformed},previous=pool.get(sha256);
  check(!previous||stringify(previous)===stringify(entry),'SMC_WIRE_HASH_COLLISION');
  if(!previous)pool.set(sha256,entry);
  return {[REF]:sha256,kind,symbol};
 });
 return compactWire(shareSubtrees({...packed,wireRevision:SMC_SNAPSHOT_WIRE_REVISION,wirePool:[...pool.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256))}));
}

/** Restores independent JSON objects before any existing domain validator.
 * Unknown encodings, altered hashes, missing references, symbol/type swaps,
 * duplicate pool identities, cycles and unused injected pool data fail closed.
 */
export function unpackSmcSnapshot(snapshot){
 check(object(snapshot),'SMC_WIRE_SNAPSHOT_INVALID');
 if(!own(snapshot,'wireRevision')&&!own(snapshot,'wirePool')&&!own(snapshot,'wireSymbols')){noReferences(snapshot);return clone(snapshot);}
 check(snapshot.wireRevision===SMC_SNAPSHOT_WIRE_REVISION&&Array.isArray(snapshot.wirePool),'SMC_WIRE_REVISION_INVALID');
 snapshot=expandWire(snapshot);
 const pool=new Map(),used=new Set(),active=new Set(),cache=new Map();
 for(const e of snapshot.wirePool){
  check(object(e)&&Object.keys(e).length===4&&KINDS.has(e.kind)&&symbolValid(e.symbol)
   &&typeof e.sha256==='string'&&/^[a-f0-9]{64}$/.test(e.sha256)
   &&(object(e.value)||e.kind==='JSON_VALUE'&&Array.isArray(e.value)),'SMC_WIRE_POOL_INVALID');
  check(!pool.has(e.sha256),'SMC_WIRE_POOL_DUPLICATE');
  check(e.sha256===digest(e.kind,e.symbol,e.value),'SMC_WIRE_HASH_MISMATCH');
  pool.set(e.sha256,e);
 }
 const generic=(v,symbol)=>{
  if(!v||typeof v!=='object')return v;
  if(isRef(v)){
   if(v.kind!=='JSON_VALUE')return clone(v);
   check(Object.keys(v).length===3&&v.symbol===symbol,'SMC_WIRE_REFERENCE_SCOPE');
   const id=v[REF],entry=pool.get(id);check(entry,'SMC_WIRE_REFERENCE_MISSING');
   check(entry.kind==='JSON_VALUE'&&entry.symbol===symbol,'SMC_WIRE_REFERENCE_SCOPE');
   check(!active.has(id),'SMC_WIRE_REFERENCE_CYCLE');used.add(id);
   if(cache.has(id))return clone(cache.get(id));
   active.add(id);const output=generic(entry.value,symbol);active.delete(id);cache.set(id,output);return clone(output);
  }
  return Array.isArray(v)?v.map(child=>generic(child,symbol)):Object.fromEntries(Object.entries(v).map(([k,child])=>[k,generic(child,symbol)]));
 };
 const source=clone(snapshot);delete source.wireRevision;delete source.wirePool;
 if(source.results)source.results=source.results.map(r=>generic(r,r.symbol));
 const expanded=transformSnapshot(source,(kind,value,symbol,transform)=>{
  if(!isRef(value)){const v=generic(value,symbol);shape(kind,v,symbol);return transform(v);}
  check(Object.keys(value).length===3&&value.kind===kind&&value.symbol===symbol
   &&typeof value[REF]==='string'&&/^[a-f0-9]{64}$/.test(value[REF]),'SMC_WIRE_REFERENCE_INVALID');
  const id=value[REF],entry=pool.get(id);
  check(entry,'SMC_WIRE_REFERENCE_MISSING');
  check(entry.kind===kind&&entry.symbol===symbol,'SMC_WIRE_REFERENCE_SCOPE');
  check(!active.has(id),'SMC_WIRE_REFERENCE_CYCLE');
  used.add(id);
  if(cache.has(id))return clone(cache.get(id));
  active.add(id);const resolved=generic(entry.value,symbol);shape(kind,resolved,symbol);
  const output=transform(resolved);active.delete(id);cache.set(id,output);
  return clone(output);
 });
 check(used.size===pool.size,'SMC_WIRE_POOL_UNUSED');
 noReferences(expanded);
 return expanded;
}
