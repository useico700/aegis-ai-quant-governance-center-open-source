import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const read=async p=>JSON.parse(await fs.readFile(new URL('../'+p,import.meta.url),'utf8'));
export async function verifyS2Clone(current,load=read){
 const s=current.s2S1Clone20261013;if(!s)return false;
 assert.ok(['STAGED_DISABLED','DEPLOYED_AND_LIVE_READY'].includes(s.status));
 const a=await load(s.authorization),source=await load(s.sourceS1Authorization),e=await load(s.evidence),p=await load(e.productionReadback),m=await load(e.monitorReadback);
 assert.equal(a.account,'S2');assert.equal(a.owner,'Operator');assert.equal(a.authorizationId,'OWNER-DIRECTIVE-S2-S1-CLONE-20261013');assert.equal(a.status,'OWNER_AUTHORIZED_ACTIVE');
 assert.deepEqual(a.entryStrategy,source.entryStrategy);assert.deepEqual(a.exitStages,source.exitStages);
 for(const key of ['perTradeRiskFraction','portfolioRiskFraction','maximumOpenPositions','maximumLeverage','maximumGrossNotionalLeverage'])assert.equal(a.risk[key],source.risk[key]);
 assert.equal(p.preflight.status,'FLAT_AND_4X_VERIFIED');assert.equal(p.preflight.leverage,4);assert.equal(p.preflight.marginModesPreserved,true);
 assert.equal(p.authorization.ownerAuthorization,a.authorizationId);assert.equal(p.authorization.accountLabel,'S2');assert.deepEqual(p.releaseIntegrity.mismatches,[]);
 assert.ok(p.releaseIntegrity.release.startsWith('/opt/aegis/s2-r22/releases/'));
 assert.equal(p.writers.filter(w=>w.running).length,1);assert.equal(p.writers.find(w=>w.running).name,'aegis-s2-execution');
 for(const w of p.writers.filter(w=>!w.running))assert.equal(w.restartPolicy,'no');
 assert.equal(p.smcAuthorization.enabled,false);assert.equal(p.smcAuthorization.entriesEnabled,false);
 assert.equal(p.execution.accountLabel,'S2');assert.equal(p.execution.strategyRuntime.managementRevision,'R22-LEGACY');assert.equal(p.execution.strategyRuntime.executionRevision,a.entryStrategy.executionRevision);
 assert.equal(p.execution.strategyRuntime.riskPolicy.portfolioFraction,'0.10');assert.equal(p.execution.strategyRuntime.riskPolicy.maximumLeverage,4);
 assert.equal(p.scanner.status,'HEALTHY');assert.equal(p.scanner.scannedSymbols,10);assert.equal(p.scanner.accountLabel,'S2');
 assert.equal(p.monitor.status,'SYNCED');assert.equal(m['s2-monitor'].http,200);assert.equal(m['s2-execution-ledger'].http,200);
 const online=m['s2-execution-ledger'].data.execution;assert.equal(online.strategyRuntime.displayName,'R22 · S2 live risk');
 if(s.status==='DEPLOYED_AND_LIVE_READY'){
  assert.equal(p.execution.liveReady,true);assert.equal(p.execution.entryIncident,null);assert.equal(p.execution.incomeError,null);assert.equal(p.execution.accountActivity.recentWindowsReady,true);
  assert.equal(p.authorization.enabled,true);assert.equal(p.authorization.entriesEnabled,true);assert.equal(online.liveReady,true);assert.equal(online.entriesAllowed,true);
 }else{assert.equal(p.authorization.entriesEnabled,false);assert.equal(p.execution.entriesAllowed,false);}
 assert.equal(current.jevOwnerStop.status,'STOPPED_AND_PRODUCTION_VERIFIED');assert.equal(e.historicalEvidencePreserved,true);assert.equal(e.s1PositionsCopied,false);
 return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify({status:'OK',verified:await verifyS2Clone(await read('governance/current-state.json'))}));
