import assert from 'node:assert/strict';
export async function verifyS1R22Rollback(current,read){
 const state=current.s1R22Rollback20261010;if(!state)return false;
 const auth=await read(state.authorization),e=await read(state.evidence),p=await read(e.productionReadback),r=p.execution.strategyRuntime;
 assert.equal(auth.authorizationId,'OWNER-DIRECTIVE-S1-R22-ROLLBACK-20261010');assert.equal(auth.owner,'Operator');assert.equal(auth.account,'S1');assert.equal(auth.status,'OWNER_AUTHORIZED_ACTIVE');
 assert.equal(auth.entryStrategy.executionRevision,'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION');assert.equal(auth.entryStrategy.pxDistanceGateEnabled,false);assert.equal(auth.entryStrategy.entryQualityRevision,null);
 const profile=await read('agents/orion-live/s1-execution/iq1-p1-profile.json');assert.equal(profile.policyRevision,'S1-R22-ROLLBACK-20261010');assert.equal(profile.pxDistanceGateEnabled,false);
 assert.equal(r.entryQualityPolicyRevision,profile.policyRevision);assert.equal(r.executionRevision,auth.entryStrategy.executionRevision);assert.equal(r.entryQualityRevision,null);assert.equal(r.pxDistanceGateEnabled,false);assert.equal(r.maximumCompleteLifecycleCostR,.12);assert.equal(r.prospectiveManagementPolicy,null);assert.equal(r.portfolioProtectionRevision,auth.portfolioProtectionRevision);assert.equal(r.candidatePriorityRevision,auth.candidatePriorityRevision);
 const limits=await read('agents/orion-live/s1-execution/small-trial-limits.json');for(const k of ['perTradeRiskFraction','portfolioRiskFraction','maximumOpenPositions','maximumLeverage','maximumGrossNotionalLeverage'])assert.equal(limits[k],auth.risk[k]);assert.equal(limits.perTradeRiskFraction,'0.04');assert.equal(limits.portfolioRiskFraction,'0.10');
 assert.deepEqual(auth.exitStages.map(x=>[x.netR,x.cumulativeReductionPct,x.aggregateFloorR]),[[.5,40,.15],[1,65,.6],[2,85,.6]]);
 assert.equal(p.singleS1Writer,true);assert.equal(p.S2LegacyRemainsPaused,true);assert.equal(p.authorization.ownerAuthorization,auth.authorizationId);assert.deepEqual(p.releaseIntegrity.mismatches,[]);assert.equal(current.jevOwnerStop.status,'STOPPED_AND_PRODUCTION_VERIFIED');
 if(state.status==='DEPLOYED_AND_LIVE_READY'){assert.equal(p.authorization.entriesEnabled,true);assert.equal(p.execution.liveReady,true);assert.equal(p.execution.entriesAllowed,true);assert.equal(p.execution.entryIncident,null);const m=await read(e.monitorReadback);assert.equal(m.httpStatus,200);assert.equal(m.execution.strategyRuntime.executionRevision,auth.entryStrategy.executionRevision);}else {assert.equal(state.status,'STAGED_PENDING_READINESS');assert.equal(p.authorization.entriesEnabled,false);}
 return true;
}
