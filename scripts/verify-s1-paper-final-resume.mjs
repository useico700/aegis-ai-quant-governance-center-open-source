import { verifyS1R22Rollback } from './verify-s1-r22-rollback.mjs';
import assert from 'node:assert/strict';
export async function verifyS1PaperFinalResume(current,read){
 if(current.s1R22Rollback20261010)return verifyS1R22Rollback(current,read);
 const state=current.s1PaperFinalLive20261010;
 if(!state)return false;
 assert.ok(['STAGED_DISABLED_PENDING_READINESS','DEPLOYED_AND_LIVE_READY'].includes(state.status));
 const auth=await read(state.authorization),evidence=await read(state.evidence);
 assert.equal(auth.owner,'Operator');assert.equal(auth.status,'OWNER_AUTHORIZED_ACTIVE');
 assert.equal(auth.account,'S1');assert.equal(auth.executionHost,'demo-server/aegis-demo-host');
 assert.equal(auth.ownerClarification,'我实盘是需要执行V2这套规则');
 assert.equal(auth.entryStrategy.pxDistanceGateEnabled,true);assert.equal(auth.entryStrategy.maximumPxBps,200);assert.equal(auth.entryStrategy.maximumPxAtr,1);assert.equal(auth.entryStrategy.maximumCompleteLifecycleCostR,0.12);
 assert.equal(auth.entryStrategy.entryConfirmationPolicy,null);assert.equal(auth.managementPolicy,null);
 assert.equal(auth.portfolioProtectionRevision,'V2-R21-ENTRY-CONSISTENCY-1');
 assert.deepEqual(auth.exitStages.map(x=>[x.netR,x.cumulativeReductionPct,x.aggregateFloorR]),[[0.5,40,0.15],[1,65,0.6],[2,85,0.6]]);
 const profile=await read('agents/orion-live/s1-execution/iq1-p1-profile.json');
 assert.equal(profile.policyRevision,auth.entryStrategy.entryQualityPolicyRevision);assert.equal(profile.pxDistanceGateEnabled,true);
 const limits=await read('agents/orion-live/s1-execution/small-trial-limits.json');
 for(const k of ['perTradeRiskFraction','portfolioRiskFraction','maximumOpenPositions','maximumLeverage','maximumGrossNotionalLeverage'])assert.equal(limits[k],auth.risk[k]);
 assert.equal(limits.perTradeRiskFraction,'0.04');assert.equal(limits.portfolioRiskFraction,'0.10');
 const paper=await read('agents/orion-v2/paper/config.json');
 assert.deepEqual(await read('agents/orion-live/s1-execution/portfolio-protection-profile.json'),paper.portfolioProfitProtection);
 assert.equal(evidence.authorization,state.authorization);assert.equal(evidence.historicalPositionsAndFillsRewritten,false);
 const proof=await read(evidence.productionReadback),runtime=proof.execution.strategyRuntime;
 assert.equal(runtime.entryQualityPolicyRevision,profile.policyRevision);assert.equal(runtime.pxDistanceGateEnabled,true);
 assert.equal(runtime.portfolioProtectionRevision,auth.portfolioProtectionRevision);assert.equal(runtime.maximumCompleteLifecycleCostR,0.12);assert.equal(runtime.candidatePriorityRevision,auth.candidatePriorityRevision);assert.equal(runtime.prospectiveManagementPolicy,null);assert.equal(runtime.entryConfirmationPolicy,null);
 assert.equal(proof.singleS1Writer,true);assert.equal(proof.S2LegacyRemainsPaused,true);
 assert.equal(proof.execution.entryIncident,null);
 assert.equal(proof.authorization.ownerAuthorization,auth.authorizationId);
 assert.equal(current.jevOwnerStop.status,'STOPPED_AND_PRODUCTION_VERIFIED');
 if(state.status==='DEPLOYED_AND_LIVE_READY'){
  assert.equal(proof.authorization.enabled,true);assert.equal(proof.authorization.entriesEnabled,true);
  assert.equal(proof.execution.liveReady,true);assert.equal(proof.execution.entriesAllowed,true);
  assert.equal(proof.execution.accountActivity.recentWindowsReady,true);
  assert.equal(proof.execution.accountStream.connected,true);
  const monitor=await read(evidence.monitorReadback);assert.equal(monitor.httpStatus,200);
  assert.equal(monitor.execution.strategyRuntime.entryQualityPolicyRevision,profile.policyRevision);
  assert.equal(monitor.execution.strategyRuntime.portfolioProtectionRevision,auth.portfolioProtectionRevision);
 }else{assert.equal(proof.authorization.enabled,false);assert.equal(proof.authorization.entriesEnabled,false);}
 return true;
}
