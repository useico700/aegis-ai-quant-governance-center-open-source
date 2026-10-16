import { verifyS1PaperFinalResume } from './verify-s1-paper-final-resume.mjs';
import assert from 'node:assert/strict';

// Operational pause supersedes old deployment readiness without rewriting it.
// This is an offline governance validator, never runtime order admission.
export async function loadS1S2OwnerPause(current, read) {
  if(current.s1PaperFinalLive20261010){
    await verifyS1PaperFinalResume(current,read);
    const historical=await read(current.s1PaperFinalLive20261010.priorStateSnapshot);
    return loadS1S2OwnerPause(historical,read);
  }
  const pause=current.s1S2OwnerPause20260926;
  if(!pause)return false;
  assert.equal(pause.status,'PAUSED_AND_PRODUCTION_VERIFIED');
  assert.equal(current.mode,'S1_S2_OWNER_PAUSED');
  const auth=await read(pause.authorization),evidence=await read(pause.evidence);
  assert.equal(auth.status,'OWNER_AUTHORIZED_ACTIVE_PAUSE');
  assert.deepEqual(auth.accounts,['S1','S2']);
  assert.equal(auth.owner,'Operator');
  assert.equal(auth.expiry,'UNTIL_EXPLICIT_OWNER_RESUME');
  for(const k of ['scanAllowed','automaticEntriesAllowed','automaticExitsAllowed','realOrdersAllowed','automaticRestartAllowed'])assert.equal(auth[k],false,k);
  assert.equal(evidence.status,'PAUSED_AND_PRODUCTION_VERIFIED');
  assert.equal(evidence.authorization,pause.authorization);
  const proof=await read(evidence.productionReadback),site=await read(evidence.cockpitReadback);
  const expected=['aegis-s1-execution','aegis-s2-execution','aegis-s1-scanner','aegis-s2-scanner'].sort();
  assert.deepEqual(proof.containers.map(x=>x.name).sort(),expected);
  for(const c of proof.containers){assert.equal(c.running,false);assert.equal(c.pid,0);assert.equal(c.exitCode,0);assert.equal(c.restartPolicy,'no');}
  assert.equal(proof.orderMutations,0);assert.equal(proof.resumeRequiresNewOwnerInstruction,true);
  for(const account of ['S1','S2']) {
    const runtime=proof.executionAuthorizations[account];assert.equal(runtime.enabled,false);assert.equal(runtime.entriesEnabled,false);assert.equal(runtime.rootOwned,true);
    const observed=proof.accounts.find(x=>x.account===account);assert.ok(observed);
    for(const k of ['positions','orders','algoOrders'])assert.equal(observed[k],0);
    const projection=site.results.find(x=>x.account===account);assert.equal(projection.httpStatus,200);assert.equal(projection.execution.status,'OWNER_PAUSED');
    for(const k of ['liveReady','entriesAllowed','realOrdersAllowed'])assert.equal(projection.execution[k],false);
    const domain=Object.values(current.executionDomains).find(x=>x.accountLabel===account);assert.equal(domain.status,'OWNER_PAUSED');
    for(const k of ['liveReady','entriesAllowed','realOrdersAllowed'])assert.equal(domain[k],false);
  }
  assert.equal(current.s1S2LiveAutomation.status,'OWNER_PAUSED');
  for(const k of ['automaticEntries','automaticExits','realOrdersAllowed','automaticRestartAllowed'])assert.equal(current.s1S2LiveAutomation[k],false);
  return true;
}
