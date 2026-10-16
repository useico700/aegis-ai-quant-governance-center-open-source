import {assertPublicEnginePlatform} from './platform.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {upstreamFixture} from './upstream-fixture.mjs';
assertPublicEnginePlatform();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dir=path.join(root,'.runtime/public-demo');await fs.mkdir(dir,{recursive:true});
const lock=path.join(dir,'writer.lock');try{await fs.mkdir(lock);}catch{throw Error('PUBLIC_DEMO_SINGLE_WRITER_LOCKED');}
await fs.writeFile(path.join(lock,'pid'),String(process.pid));
globalThis.fetch=async()=>{throw Error('OFFLINE_SIMULATED_VENUE_HAS_NO_NETWORK');};
let stopped=false;process.once('SIGINT',()=>{stopped=true;});process.once('SIGTERM',()=>{stopped=true;});
try{do{
 for(const account of ['S1','S2']){
  const cleanup=[];const f=await upstreamFixture({after:fn=>cleanup.push(fn)},'LIVE',account);
  try{
   const entry=await f.engine.cycle();f.step();await f.engine.cycle();f.step();await f.engine.cycle();
   const positions=[...f.book.positions.values()];
   const receipt={schemaVersion:1,mode:'LOCAL_SIMULATED_VENUE',synthetic:true,accountLabel:account,recordedAt:new Date().toISOString(),sourceStrategy:'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION',entryStatus:entry.status,executionResult:entry.result?.status??null,protected:entry.result?.status==='PROTECTED_FILL_AWAITING_ACCOUNTING',positions,simulatedVenueCalls:f.venue.calls.length,exchangeRequests:0,realOrdersAllowed:false,source:'UPSTREAM_ENGINE_AND_FAKE_VENUE_TEST_FIXTURE',signalSource:'INJECTED_SYNTHETIC_SIGNAL_NOT_MARKET_SCANNER'};
   if(!receipt.protected||!positions.some(p=>p.status==='OPEN'))throw Error('UPSTREAM_SIMULATED_EXECUTION_FAILED');
   const file=path.join(dir,account+'.json');await fs.writeFile(file+'.tmp',JSON.stringify(receipt,null,2));await fs.rename(file+'.tmp',file);
   console.log(JSON.stringify({account,mode:receipt.mode,entryStatus:receipt.entryStatus,protected:receipt.protected,positions:positions.length,exchangeRequests:0}));
  }finally{for(const fn of cleanup.reverse())await fn();}
 }
 if(!process.argv.includes('--watch')||stopped)break;
 for(let n=0;n<20&&!stopped;n++)await new Promise(r=>setTimeout(r,500));
}while(!stopped);}finally{await fs.rm(lock,{recursive:true,force:true});}
