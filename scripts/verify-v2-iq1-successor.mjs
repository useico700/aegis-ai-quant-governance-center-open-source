import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {IQ1_REVISION,IQ1_AUTHORIZATION,iq1Digest,validateIq1Profile} from '../agents/orion-v2/paper/iq1-entry-quality.mjs';
import {loadV3Hf14SharedSuccessor,verifyV3Hf14SharedSuccessor,HF14_SHARED_AUTH_PATH,
  HF14_SHARED_MANIFEST,HF14_SHARED_PREDECESSOR,HF14_SHARED_CHANGED,HF14_SHARED_ADDED,
  HF14_SHARED_BEFORE_ROOT} from './verify-v3-hf14-successor.mjs';
export const IQ1_AUTH_PATH='governance/owner-authorizations/2026-09-15-v2-iq1-execution.json';
export const IQ1_MANIFEST='governance/evidence/manifests/v2-iq1-execution-20260915.json';
export const IQ1_BEFORE='reports/strategy-research/20260915-v2-iq1-execution/before/';
export const IQ1_CHANGED=['agents/orion-v2/paper/paper-daemon.mjs','scripts/verify-migration.mjs','tests/aegis-clean-rotation.test.mjs'];
export const IQ1_ADDED=['agents/orion-v2/paper/iq1-entry-quality.mjs','agents/orion-v2/paper/iq1-profile.json',
  'scripts/verify-v2-iq1-successor.mjs','tests/v2-iq1-entry-quality.test.mjs','tests/v2-iq1-governance.test.mjs',IQ1_AUTH_PATH];
export const IQ1_PROTECTED=['agents/orion-v2/paper/config.json','agents/orion-v2/paper/paper-engine.mjs','agents/orion-v2/paper/r21-integrity.mjs'];
export const IQ1_PREDECESSORS=['governance/evidence/manifests/v2-r22-1-entry-protection-consistency-20260914.json',HF14_SHARED_MANIFEST,'governance/evidence/manifests/aegis-prime-clean-context-rotation-20260914.json'];
const hash=b=>createHash('sha256').update(b).digest('hex');
const must=(v,c)=>{if(!v)throw Error('V2_IQ1_SUCCESSOR_'+c);};
const matches=(b,d)=>Buffer.isBuffer(b)&&b.length===d?.bytes&&hash(b)===d?.sha256;
const sameSet=(actual,expected)=>JSON.stringify([...actual].sort())===JSON.stringify([...expected].sort());

export function verifyIq1Successor({current,authorization:a,manifest:m,sources,predecessors}){
 const domain=current?.executionDomains?.orionV2Paper,p=domain?.entryQuality;
 must(p?.enabled===true&&p.revision===IQ1_REVISION&&p.authorizationId===IQ1_AUTHORIZATION&&
   p.authorization===IQ1_AUTH_PATH&&p.sourceSupersession===IQ1_MANIFEST,'POINTER');
 must(a?.authorizationId===IQ1_AUTHORIZATION&&a.scope==='ORION_V2_PAPER_ONLY'&&a.executionAuthorized===true&&
   a.newEntriesOnly===true&&a.preserveExistingPositions===true&&a.exitRulesChanged===false&&
   a.otherExecutionDomainsChanged===false&&a.realOrdersAllowed===false&&a.testnetOrdersAllowed===false,'AUTHORITY');
 for(const k of ['exchangeCredentialsAllowed','signedRequestsAllowed','apiKeysAllowed','orderEndpointsAllowed','testnetOrdersAllowed','realOrdersAllowed'])must(domain[k]===false,'PAPER_BOUNDARY_'+k);
 must(m?.schemaVersion===1&&m.authorizationId===IQ1_AUTHORIZATION&&m.scope==='V2_IQ1_NEW_PAPER_ENTRY_ADMISSION_ONLY'&&m.historicalManifestsPreserved===true,'SCOPE');
 must(sameSet((m.files??[]).map(x=>x.path),[...IQ1_CHANGED,...IQ1_ADDED]),'SOURCE_SET');
 must(sameSet((m.protectedFiles??[]).map(x=>x.path),IQ1_PROTECTED),'PROTECTED_SET');
 must(sameSet((m.predecessors??[]).map(x=>x.path),IQ1_PREDECESSORS),'PREDECESSOR_SET');
 for(const f of m.predecessors)must(matches(predecessors[f.path],f),'PREDECESSOR_HASH_'+f.path);
 const priorDaemon=JSON.parse(predecessors[IQ1_PREDECESSORS[0]]).files.find(f=>f.path===IQ1_CHANGED[0]);
 const priorVerifier=JSON.parse(predecessors[HF14_SHARED_MANIFEST]).files.find(f=>f.path===IQ1_CHANGED[1]);
 const priorTest=JSON.parse(predecessors[IQ1_PREDECESSORS[2]]).files.find(f=>f.path===IQ1_CHANGED[2]);
 const retained=new Map();
 for(const f of m.files){
   must(matches(sources[f.path],f.after),'CURRENT_HASH_'+f.path);
   if(IQ1_CHANGED.includes(f.path)){
     must(f.beforeSource===IQ1_BEFORE+f.path,'BEFORE_PATH');
     const before=sources[f.beforeSource];
     must(matches(before,f.before)&&matches(before,f.path===IQ1_CHANGED[0]?priorDaemon.after:f.path===IQ1_CHANGED[1]?priorVerifier.after:priorTest),'PREDECESSOR_LINK_'+f.path);
     retained.set(f.path,{...f,bytes:before});
   }else must(f.before===null&&f.beforeSource===null,'ADDED_BASELINE');
 }
 for(const f of m.protectedFiles){
   must(matches(sources[f.path],f)&&matches(sources[IQ1_BEFORE+f.path],f),'PROTECTED_HASH_'+f.path);
 }
 const config=JSON.parse(sources[IQ1_PROTECTED[0]]),profile=JSON.parse(sources['agents/orion-v2/paper/iq1-profile.json']);
 validateIq1Profile(profile,config.paperRisk);
 must(iq1Digest(profile)===a.profileDigest&&a.profileDigest===p.profileDigest,'PROFILE_BINDING');
 must(config.executionRevision===a.baseExecutionRevision&&config.implementationRevision===a.baseImplementationRevision,'BASE_REVISION');
 return {normalize(file,bytes){const f=retained.get(file);if(!f)return bytes;
   if(matches(bytes,f.before))return bytes;must(matches(bytes,f.after),'UNAUTHENTICATED_SOURCE_'+file);return Buffer.from(f.bytes);}};
}
export async function loadIq1Successor(root,current){
 if(!current?.executionDomains?.orionV2Paper?.entryQuality)return null;
 const read=f=>fs.readFile(path.join(root,f));
 const [a,m]=await Promise.all([IQ1_AUTH_PATH,IQ1_MANIFEST].map(async f=>JSON.parse(await read(f))));
 const sourcePaths=[...IQ1_CHANGED,...IQ1_ADDED,...IQ1_PROTECTED,...[...IQ1_CHANGED,...IQ1_PROTECTED].map(f=>IQ1_BEFORE+f)];
 const [sources,predecessors]=await Promise.all([Promise.all(sourcePaths.map(async f=>[f,await read(f)])).then(Object.fromEntries),
   Promise.all(IQ1_PREDECESSORS.map(async f=>[f,await read(f)])).then(Object.fromEntries)]);
 return verifyIq1Successor({current,authorization:a,manifest:m,sources,predecessors});
}
// Authenticate the prior shared verifier against its unchanged HF14 manifest.
// This avoids rewriting any V3 source or historical manifest for a V2 release.
export async function loadIq1CompatibleHf14(root,current,successor){
 if(!successor)return loadV3Hf14SharedSuccessor(root,current);
 const read=f=>fs.readFile(path.join(root,f));
 const paths=[...HF14_SHARED_CHANGED,...HF14_SHARED_ADDED,...HF14_SHARED_CHANGED.map(f=>HF14_SHARED_BEFORE_ROOT+f)];
 const [authorization,manifest,predecessorManifestBytes,sourceBytes]=await Promise.all([
   read(HF14_SHARED_AUTH_PATH).then(JSON.parse),read(HF14_SHARED_MANIFEST).then(JSON.parse),read(HF14_SHARED_PREDECESSOR),
   Promise.all(paths.map(async f=>[f,successor.normalize(f,await read(f))])).then(Object.fromEntries)]);
 return verifyV3Hf14SharedSuccessor({authorization,manifest,predecessorManifestBytes,sourceBytes});
}
