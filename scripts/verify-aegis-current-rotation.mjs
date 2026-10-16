import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const CURRENT_ROTATION_ID='OWNER-DIRECTIVE-AEGIS-PRIME-CLEAN-CONTEXT-ROTATION-20261009';
export const CURRENT_ROTATION_ROOT='governance/handoffs/aegis-prime-20261009-clean';
export const CURRENT_ROTATION_AUTH='governance/owner-authorizations/2026-10-09-aegis-prime-clean-context-rotation.json';
export const CURRENT_ROTATION_EVIDENCE='governance/evidence/aegis-prime-clean-context-rotation-20261009.json';
export const CURRENT_ROTATION_MANIFEST='governance/evidence/manifests/aegis-prime-clean-context-rotation-20261009.json';
export const CURRENT_ROTATION_HANDOFF=CURRENT_ROTATION_ROOT+'/HANDOFF.md';
export const PRIOR_SESSION_POINTER='governance/handoffs/aegis-prime-20261004-clean/session-current.json';
export const CURRENT_ROTATION_NEW='00000000-0000-4000-8000-000000000000';
export const CURRENT_ROTATION_OLD='00000000-0000-4000-8000-000000000000';
const PRIOR_ID='OWNER-DIRECTIVE-AEGIS-PRIME-CLEAN-CONTEXT-ROTATION-20260914';
const PRIOR_THREAD='00000000-0000-4000-8000-000000000000';
const PRIOR_MANIFEST='governance/evidence/manifests/aegis-prime-clean-context-rotation-20260914.json';
const OLD_VERIFIER='scripts/verify-aegis-rotation.mjs',OLD_TEST='tests/aegis-clean-rotation.test.mjs';
const UPSTREAM_VERIFIER='scripts/verify-s1-r221-iq1-successor.mjs';
const PREDECESSOR_LINKS={
 [OLD_VERIFIER]:'governance/evidence/manifests/v3-hf14-shared-verifier-20260914.json',
 [OLD_TEST]:'governance/evidence/manifests/s2-profit-retention-source-supersession-20260923.json',
 [UPSTREAM_VERIFIER]:'governance/evidence/manifests/s1-r221-iq1-source-supersession-20260925.json',
};
const before=file=>CURRENT_ROTATION_ROOT+'/before/'+file;
export const CURRENT_ROTATION_SOURCE_PATHS=[
 'scripts/verify-aegis-current-rotation.mjs',OLD_VERIFIER,OLD_TEST,'tests/aegis-current-rotation.test.mjs',
 CURRENT_ROTATION_AUTH,CURRENT_ROTATION_HANDOFF,PRIOR_SESSION_POINTER,PRIOR_MANIFEST,UPSTREAM_VERIFIER,...Object.values(PREDECESSOR_LINKS),
 ...['governance/current-state.json','memory/registry.json',OLD_VERIFIER,OLD_TEST,UPSTREAM_VERIFIER].map(before)
];
const must=(ok,message)=>{if(!ok)throw new Error('AEGIS_CURRENT_ROTATION:'+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const nonempty=value=>typeof value==='string'&&value.length>0;

export function verifyAegisCurrentRotationState({current,registry,authorization,evidence,priorCurrent,priorRegistry,sessionPointer}){
 const c=current.aegisPrimeConversation,p=priorCurrent.aegisPrimeConversation;
 const r=registry.agents.find(a=>a.id==='aegis-prime'),pr=priorRegistry.agents.find(a=>a.id==='aegis-prime');
 must(authorization.id===CURRENT_ROTATION_ID&&authorization.status==='ACTIVE'&&authorization.owner==='Operator','AUTHORIZATION');
 must(authorization.supersedesForAegisPrime===PRIOR_ID&&authorization.newThreadId===CURRENT_ROTATION_NEW
  &&authorization.replacedThreadId===CURRENT_ROTATION_OLD,'AUTHORIZED_IDS');
 must(authorization.fullTranscriptReplayAllowed===false&&authorization.deletionAuthorized===false
  &&authorization.runtimeMutationAllowed===false&&authorization.handoff===CURRENT_ROTATION_HANDOFF,'BOUNDARIES');
 must(p.authorizationId===PRIOR_ID&&p.activeThreadId===PRIOR_THREAD
  &&priorCurrent.agentGovernanceRouting.mainThreads.aegisPrime===PRIOR_THREAD&&pr?.threadId===PRIOR_THREAD,'LEGACY_ROUTING_BASELINE');
 must(sessionPointer.newThreadId===CURRENT_ROTATION_OLD&&sessionPointer.status==='NEW_THREAD_CREATED_AWAITING_READY'
  &&sessionPointer.oldThreadArchived===false&&sessionPointer.fullTranscriptCopied===false&&sessionPointer.runtimeOrTradingMutation===false,'UNRESOLVED_SESSION_HISTORY');
 must(c?.authorizationId===CURRENT_ROTATION_ID&&c.rotationAuthorizationId===CURRENT_ROTATION_ID
  &&c.activeThreadId===CURRENT_ROTATION_NEW&&c.replacedThreadId===CURRENT_ROTATION_OLD,'POINTER');
 must(current.agentGovernanceRouting.mainThreads.aegisPrime===CURRENT_ROTATION_NEW
  &&current.agentGovernanceRouting.aegisMainThreadAuthorizationId===CURRENT_ROTATION_ID&&r?.threadId===CURRENT_ROTATION_NEW,'ROUTING');
 must(c.activeThreadTitle==='AEGIS PRIME｜治理控制面'&&c.fullTranscriptReplayAllowed===false
  &&c.runtimeOrTradingMutationByThreadRotationAllowed===false&&c.replacedThreadDeleted===false,'CONVERSATION_BOUNDARIES');
 must(c.rotationEvidence===CURRENT_ROTATION_EVIDENCE&&c.evidence===CURRENT_ROTATION_EVIDENCE
  &&c.handoffEvidence===CURRENT_ROTATION_HANDOFF,'EVIDENCE_POINTERS');
 const requiredIds=[...(p.priorReplacedThreadIds??[]),p.activeThreadId,p.replacedThreadId,p.accidentalForkThreadId,
  sessionPointer.replacedThreadId,sessionPointer.originalArchivedThreadId].filter(nonempty);
 must(Array.isArray(c.priorReplacedThreadIds)&&requiredIds.every(id=>c.priorReplacedThreadIds.includes(id))
  &&!c.priorReplacedThreadIds.includes(CURRENT_ROTATION_NEW),'HISTORY_PRESERVED');
 const otherRoutes=x=>Object.fromEntries(Object.entries(x.agentGovernanceRouting.mainThreads).filter(([key])=>key!=='aegisPrime'));
 must(same(otherRoutes(current),otherRoutes(priorCurrent)),'OTHER_ROUTES_CHANGED');
 must(same(registry.agents.filter(a=>a.id!=='aegis-prime'),priorRegistry.agents.filter(a=>a.id!=='aegis-prime')),'OTHER_REGISTRY_AGENTS_CHANGED');
 must(['id','displayName','role','lifecycle','authority'].every(k=>r[k]===pr[k])
  &&['identitySources','stateSources'].every(k=>(pr[k]??[]).every(v=>(r[k]??[]).includes(v))),'REGISTRY_HISTORY_PRESERVED');
 must(evidence.authorizationId===CURRENT_ROTATION_ID&&evidence.newThreadId===CURRENT_ROTATION_NEW
  &&evidence.replacedThreadId===CURRENT_ROTATION_OLD&&evidence.legacyRouteThreadId===PRIOR_THREAD
  &&evidence.historicalSessionPointer===PRIOR_SESSION_POINTER,'EVIDENCE_IDS');
 must(evidence.newThreadInitialStatus==='WAITING_POINTER'&&nonempty(evidence.newThreadInitialTurnId)
  &&evidence.fullTranscriptCopiedOrReplayed===false&&evidence.runtimeOrTradingMutation===false
  &&evidence.automationMutation===false&&evidence.replacedThreadDeleted===false,'HANDOFF_BOUNDARIES');
 const stage=evidence.status;
 must(['WAITING_FINAL_READY_VERIFICATION','READY_VERIFIED_ARCHIVE_PENDING','COMPLETED_READY_VERIFIED_ARCHIVED'].includes(stage),'STAGE');
 const waiting=stage==='WAITING_FINAL_READY_VERIFICATION',complete=stage==='COMPLETED_READY_VERIFIED_ARCHIVED';
 must(c.initializationStatus===(waiting?'WAITING_FINAL_READY_VERIFICATION':'READY_VERIFIED'),'INITIALIZATION');
 if(!waiting)must(evidence.newThreadReadyStatus==='READY'&&nonempty(evidence.newThreadReadyTurnId),'READY_RECEIPT');
 if(complete){
  must(c.status==='ACTIVE_CLEAN_MAIN_THREAD'&&c.replacedThreadStatus==='READ_ONLY_ARCHIVED_HISTORY'
   &&c.replacedThreadArchiveRecoverable===true&&nonempty(c.replacedThreadArchiveVerifiedAt),'ARCHIVE_STATE');
  must(evidence.replacedThreadArchived===true&&nonempty(evidence.archiveVerifiedAt),'ARCHIVE_EVIDENCE');
 }else{
  must(c.status==='ACTIVE_CLEAN_MAIN_THREAD_ARCHIVE_PENDING'&&evidence.replacedThreadArchived===false
   &&evidence.archiveVerifiedAt===null&&[null,false].includes(c.replacedThreadArchiveRecoverable)
   &&c.replacedThreadArchiveVerifiedAt===null,'ARCHIVE_BEFORE_READY');
 }
 return true;
}

/** Validates the new live routing separately, then supplies authenticated
 * predecessor bytes to the unmodified September 14/11 verification rules.
 * The migration verifier and all trading/runtime files remain untouched.
 */
export async function loadAegisCurrentRotation(root,current){
 const exists=await fs.access(path.join(root,CURRENT_ROTATION_AUTH)).then(()=>true,()=>false);
 if(!exists&&current.aegisPrimeConversation?.authorizationId!==CURRENT_ROTATION_ID)return null;
 must(current.aegisPrimeConversation?.authorizationId===CURRENT_ROTATION_ID,'ACTIVE_SUCCESSOR_REQUIRED');
 const read=file=>fs.readFile(path.join(root,file));
 const json=async file=>JSON.parse(await read(file));
 const [authorization,evidence,manifest,registry]=await Promise.all([
  json(CURRENT_ROTATION_AUTH),json(CURRENT_ROTATION_EVIDENCE),json(CURRENT_ROTATION_MANIFEST),json('memory/registry.json')]);
 must(manifest.authorizationId===CURRENT_ROTATION_ID&&manifest.scope==='AEGIS_CONVERSATION_ROUTING_AND_VERIFICATION_ONLY'
  &&manifest.historicalManifestsPreserved===true&&manifest.runtimeOrTradingMutation===false,'SOURCE_SCOPE');
 must(same(manifest.files.map(f=>f.path).sort(),[...CURRENT_ROTATION_SOURCE_PATHS].sort()),'SOURCE_SET');
 const sources={};
 for(const file of manifest.files){const bytes=await read(file.path);must(bytes.length===file.bytes&&hash(bytes)===file.sha256,'SOURCE_HASH:'+file.path);sources[file.path]=bytes;}
 const priorCurrent=JSON.parse(sources[before('governance/current-state.json')]),priorRegistry=JSON.parse(sources[before('memory/registry.json')]);
 const sessionPointer=JSON.parse(sources[PRIOR_SESSION_POINTER]);
 for(const [file,manifestPath] of Object.entries(PREDECESSOR_LINKS)){
  const original=JSON.parse(sources[manifestPath]).files.find(f=>f.path===file)?.after,bytes=sources[before(file)];
  must(original?.bytes===bytes.length&&original?.sha256===hash(bytes),'IMMUTABLE_PREDECESSOR_LINK:'+file);
 }
 verifyAegisCurrentRotationState({current,registry,authorization,evidence,priorCurrent,priorRegistry,sessionPointer});
 return {priorCurrent,priorRegistry,normalize(file,bytes){
  if(!Object.hasOwn(PREDECESSOR_LINKS,file))return bytes;
  if(hash(bytes)===hash(sources[before(file)]))return bytes;
  must(hash(bytes)===hash(sources[file]),'CURRENT_SOURCE_DRIFT:'+file);return sources[before(file)];
 }};
}
