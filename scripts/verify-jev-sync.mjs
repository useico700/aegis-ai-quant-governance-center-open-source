import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ENTRY_BAND_BPS } from '../integrations/jev/entry-band.mjs';
import { S1_PROFIT_RETENTION_POLICY, S2_PROFIT_RETENTION_POLICY, createAdaptiveFirstHarvestPolicy } from '../agents/shared/profit-retention.mjs';

import { entryConfirmationPolicy, ENTRY_CONFIRMATION_REVISION } from '../agents/shared/entry-confirmation.mjs';
import { S2_Z_STRUCTURE_REVISION, S2_Z_GEOMETRY_POLICY_HASH } from '../agents/shared/s2-z-structure.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const skip=new Set(['node_modules','dist','build','.wrangler','.git','.DS_Store','tsconfig.tsbuildinfo']);
const safePath=value=>typeof value==='string'&&value.length>0&&!path.isAbsolute(value)&&!value.split('/').some(x=>x==='..'||x==='');
const readJson=async(rootPath,relative)=>{
 assert.ok(safePath(relative),`JEV_SYNC_UNSAFE_PATH:${relative}`);
 return JSON.parse(await fs.readFile(path.join(rootPath,relative),'utf8'));
};

export async function fingerprintPaths(rootPath,watchPaths) {
 assert.ok(Array.isArray(watchPaths)&&watchPaths.length>0,'JEV_SYNC_WATCH_PATHS_MISSING');
 const files=new Map();
 async function walk(relative) {
  assert.ok(safePath(relative),`JEV_SYNC_UNSAFE_PATH:${relative}`);
  const full=path.join(rootPath,relative),stat=await fs.lstat(full);
  if(stat.isSymbolicLink())return;
  if(stat.isDirectory()) {
   for(const name of (await fs.readdir(full)).sort()) {
    if(skip.has(name)||name.startsWith('.env'))continue;
    await walk(`${relative}/${name}`);
   }
  } else if(stat.isFile())files.set(relative,hash(await fs.readFile(full)));
 }
 for(const relative of watchPaths)await walk(relative);
 const entries=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0);
 return {fingerprint:hash(entries.map(([name,digest])=>`${name}\0${digest}\n`).join('')),fileCount:entries.length};
}

export async function verifyJevSync(rootPath=root) {
 const contract=await readJson(rootPath,'governance/jev-sync-contract.json');
 assert.equal(contract.schemaVersion,1,'JEV_SYNC_SCHEMA');
 assert.ok(['ACTIVE','OWNER_STOPPED'].includes(contract.status),'JEV_SYNC_INACTIVE');
 const current=await readJson(rootPath,'governance/current-state.json');
 assert.equal(current.jevSynchronization?.contract,'governance/jev-sync-contract.json','JEV_SYNC_STATE_MISSING');
 assert.equal(current.jevSynchronization?.evidence,contract.evidence,'JEV_SYNC_EVIDENCE_POINTER');

 const source=await fingerprintPaths(rootPath,contract.watchPaths);
 assert.equal(source.fingerprint,contract.sourceFingerprint,'JEV_SYNC_SOURCE_CHANGED: update JEV or record a reviewed no-impact decision before release');
 assert.equal(source.fileCount,contract.sourceFileCount,'JEV_SYNC_SOURCE_COUNT');
 const evidence=await readJson(rootPath,contract.evidence);
 assert.ok(['BASELINE_ESTABLISHED','SYNCED_DEPLOYED','NO_JEV_EFFECT_REVIEWED','OWNER_STOPPED_VERIFIED'].includes(evidence.status),'JEV_SYNC_EVIDENCE_STATUS');
 assert.equal(evidence.sourceFingerprint,source.fingerprint,'JEV_SYNC_EVIDENCE_FINGERPRINT');
 assert.equal(evidence.contract,'governance/jev-sync-contract.json','JEV_SYNC_EVIDENCE_CONTRACT');
 if(contract.status==='OWNER_STOPPED') {
  assert.equal(evidence.status,'OWNER_STOPPED_VERIFIED','JEV_STOP_EVIDENCE');
  const authorization=await readJson(rootPath,evidence.authorization);
  assert.equal(authorization.status,'OWNER_AUTHORIZED_ACTIVE_STOP','JEV_STOP_AUTH');
  assert.equal(authorization.owner,'Operator','JEV_STOP_OWNER');
  for(const key of ['observationAllowed','researchInferenceAllowed','shadowExecutionAllowed','automaticRestartAllowed','orderAuthority'])assert.equal(authorization[key],false,`JEV_STOP_AUTH:${key}`);
  const proof=await readJson(rootPath,evidence.productionReadback);
  assert.deepEqual(proof.services.map(row=>row.name).sort(),['aegis-jev-filter','aegis-jev-shadow']);
  for(const row of proof.services){assert.equal(row.running,false);assert.equal(row.pid,0);assert.equal(row.restartPolicy,'no');}
  assert.equal(current.jevOwnerStop?.status,'STOPPED_AND_PRODUCTION_VERIFIED','JEV_STOP_STATE');
  assert.equal(current.jevOwnerStop?.authorization,evidence.authorization,'JEV_STOP_BINDING');
  assert.equal(current.jevOwnerStop?.automaticRestartAllowed,false,'JEV_STOP_RESTART');
  const route=await fs.readFile(path.join(rootPath,'app/api/smc-jev/route.ts'),'utf8');
  assert.ok(route.includes('OWNER_STOPPED')&&!route.includes('observeSmcSnapshot'),'JEV_STOP_REQUEST_OBSERVER');
  assert.equal(evidence.historicalEvidencePreserved,true,'JEV_STOP_HISTORY');
  assert.equal(evidence.orderAuthority,false,'JEV_STOP_ORDER_AUTHORITY');
  assert.ok(typeof evidence.reason==='string'&&evidence.reason.length>30,'JEV_STOP_REASON');
  return {status:'OK',disposition:'OWNER_STOPPED_VERIFIED',sourceFingerprint:source.fingerprint,sourceFileCount:source.fileCount};
 }
 if(evidence.status==='NO_JEV_EFFECT_REVIEWED')assert.ok(typeof evidence.reason==='string'&&evidence.reason.length>=20,'JEV_SYNC_NO_EFFECT_REASON');
 if(evidence.status!=='NO_JEV_EFFECT_REVIEWED'){
  const deployment=await readJson(rootPath,evidence.deploymentEvidence);
  assert.equal(deployment.status,'DEPLOYED_AND_PRODUCTION_VERIFIED','JEV_SYNC_DEPLOYMENT_UNVERIFIED');
 }

 const [s1,s2,shadow,baseAuthorization,s1Authorization,s2Authorization,leverageAuthorization,s1Iq1Profile]=await Promise.all([
  readJson(rootPath,contract.activeStrategyConfig.S1),readJson(rootPath,contract.activeStrategyConfig.S2),
  readJson(rootPath,contract.shadowStrategyConfig),readJson(rootPath,contract.baseAuthorization),
  readJson(rootPath,contract.s1Authorization),readJson(rootPath,contract.s2Authorization),
  readJson(rootPath,contract.leverageAuthorization),readJson(rootPath,contract.s1EntryQualityProfile)
 ]);
 assert.ok(String(baseAuthorization.status).includes('ACTIVE'),'JEV_SYNC_BASE_AUTH_INACTIVE');
 assert.equal(s1Authorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_S1_AUTH_INACTIVE');
 assert.equal(s1Authorization.account,'S1','JEV_SYNC_S1_AUTH_SCOPE');
 assert.equal(s1Authorization.entryStrategy?.pxDistanceGateEnabled,false,'JEV_SYNC_S1_PX_DISTANCE_GATE');
 assert.equal(s2Authorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_S2_AUTH_INACTIVE');
 assert.equal(leverageAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_LEVERAGE_AUTH_INACTIVE');
 assert.deepEqual(leverageAuthorization.accounts,['S2'],'JEV_SYNC_LEVERAGE_ACCOUNT_SCOPE');
 assert.equal(leverageAuthorization.s1Disposition?.binanceCode,-4421,'JEV_SYNC_S1_VENUE_REFUSAL_MISSING');
 assert.equal(leverageAuthorization.risk.maximumLeverage,25,'JEV_SYNC_LEVERAGE_AUTH_INVALID');
 assert.equal(leverageAuthorization.risk.maximumGrossNotionalLeverage,4,'JEV_SYNC_GROSS_CAP_INVALID');
 if(contract.smcAuthorization){
  const [smcAuthorization,smcRiskProfile,smcLedgerProfile]=await Promise.all([
   readJson(rootPath,contract.smcAuthorization),
   readJson(rootPath,'agents/orion-live/smc-execution/risk-profile.json'),
   readJson(rootPath,'lib/smc-ledger-profile.json')
  ]);
  assert.equal(smcAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_SMC_AUTH_INACTIVE');
  assert.equal(smcAuthorization.account,'S2','JEV_SYNC_SMC_ACCOUNT_SCOPE');
  assert.equal(smcAuthorization.risk?.maximumLeverage,25,'JEV_SYNC_SMC_LEVERAGE');
  assert.equal(smcAuthorization.risk?.maximumGrossNotionalLeverage,25,'JEV_SYNC_SMC_GROSS_CAP_AUTH');
  assert.equal(smcRiskProfile.authorizationId,smcAuthorization.authorizationId,'JEV_SYNC_SMC_AUTHORIZATION_ID');
  assert.equal(smcRiskProfile.risk?.maximumGrossNotionalLeverage,25,'JEV_SYNC_SMC_GROSS_CAP_LIVE');
  assert.equal(smcLedgerProfile.risk?.maximumGrossNotionalLeverage,25,'JEV_SYNC_SMC_GROSS_CAP_LEDGER');
  assert.equal(shadow.SMC?.risk?.maximumGrossNotionalLeverage,25,'JEV_SYNC_SMC_GROSS_CAP_SHADOW');
 }
 assert.deepEqual(shadow.S1.strategy,s1.strategy,'JEV_SYNC_S1_STRATEGY_DRIFT');
 assert.deepEqual(shadow.S2.strategy,s2.strategy,'JEV_SYNC_S2_STRATEGY_DRIFT');
 if(contract.s2StructureAuthorization){
  const structureAuthorization=await readJson(rootPath,contract.s2StructureAuthorization);
  assert.equal(structureAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_S2_STRUCTURE_AUTH_INACTIVE');
  assert.equal(structureAuthorization.account,'S2','JEV_SYNC_S2_STRUCTURE_ACCOUNT');
  assert.equal(structureAuthorization.structureRevision,S2_Z_STRUCTURE_REVISION,'JEV_SYNC_S2_STRUCTURE_AUTH_REVISION');
  assert.equal(structureAuthorization.strategyConfiguration,contract.activeStrategyConfig.S2,'JEV_SYNC_S2_STRUCTURE_SOURCE');
  assert.equal(s2.strategy.structureRevision,structureAuthorization.structureRevision,'JEV_SYNC_S2_STRUCTURE_REVISION');
  assert.equal(hash(JSON.stringify({fifteenMinute:s2.strategy.pivots.oneHour,hourly:s2.strategy.pivots.fourHour,
    intersection:s2.strategy.intersection})),S2_Z_GEOMETRY_POLICY_HASH,'JEV_SYNC_S2_STRUCTURE_PARAMETERS');
  assert.equal(current.s2ZStructure?.structureRevision,structureAuthorization.structureRevision,'JEV_SYNC_S2_STRUCTURE_STATE');
  assert.equal(current.s2ZStructure?.status,'DEPLOYED_AND_PRODUCTION_VERIFIED','JEV_SYNC_S2_STRUCTURE_DEPLOYMENT');
  assert.equal(s1.strategy.structureRevision,undefined,'JEV_SYNC_S2_STRUCTURE_LEAKED_TO_S1');
 }
 const managementAuthorization=await readJson(rootPath,contract.s2ManagementAuthorization);
 assert.equal(managementAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_MANAGEMENT_AUTH_INACTIVE');
 assert.equal(managementAuthorization.managementRevision,S2_PROFIT_RETENTION_POLICY.revision,'JEV_SYNC_MANAGEMENT_REVISION');

 const s1ManagementAuthorization=await readJson(rootPath,contract.s1ManagementAuthorization);
 assert.equal(s1ManagementAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_S1_MANAGEMENT_AUTH_INACTIVE');
 assert.equal(s1ManagementAuthorization.account,'S1','JEV_SYNC_S1_MANAGEMENT_ACCOUNT');
 assert.equal(s1ManagementAuthorization.managementRevision,S1_PROFIT_RETENTION_POLICY.revision,'JEV_SYNC_S1_MANAGEMENT_REVISION');
 if(contract.entryConfirmationAuthorization){
  const entryAuthorization=await readJson(rootPath,contract.entryConfirmationAuthorization);
  assert.equal(entryAuthorization.status,'OWNER_AUTHORIZED_ACTIVE','JEV_SYNC_ENTRY_CONFIRMATION_AUTH_INACTIVE');
  assert.deepEqual(entryAuthorization.accounts,['S1','S2'],'JEV_SYNC_ENTRY_CONFIRMATION_SCOPE');
  assert.equal(entryAuthorization.entryConfirmationRevision,ENTRY_CONFIRMATION_REVISION,'JEV_SYNC_ENTRY_CONFIRMATION_REVISION');
  for(const account of ['S1','S2']){
   const expected=entryConfirmationPolicy(account);
   const live=await readJson(rootPath,contract.entryConfirmationProfiles?.[account]);
   assert.deepEqual(live,expected,`JEV_SYNC_LIVE_ENTRY_CONFIRMATION_DRIFT:${account}`);
   assert.deepEqual(shadow[account].entryConfirmationPolicy,expected,`JEV_SYNC_SHADOW_ENTRY_CONFIRMATION_DRIFT:${account}`);
   const management=createAdaptiveFirstHarvestPolicy({account,firstHarvestTarget:null});
   assert.equal(entryAuthorization.managementRevisions?.[account],management.revision,`JEV_SYNC_ADAPTIVE_AUTH_DRIFT:${account}`);
   assert.deepEqual(shadow[account].managementPolicy,management,`JEV_SYNC_ADAPTIVE_MANAGEMENT_DRIFT:${account}`);
  }
 }else{
  assert.deepEqual(shadow.S1.managementPolicy,S1_PROFIT_RETENTION_POLICY,'JEV_SYNC_S1_MANAGEMENT_POLICY_DRIFT');
  assert.deepEqual(shadow.S2.managementPolicy,S2_PROFIT_RETENTION_POLICY,'JEV_SYNC_MANAGEMENT_POLICY_DRIFT');
 }
 const leverage={maximumLeverage:leverageAuthorization.risk.maximumLeverage,
  maximumGrossNotionalLeverage:leverageAuthorization.risk.maximumGrossNotionalLeverage};
 const s1Risk={...baseAuthorization.risk,...Object.fromEntries(
  Object.entries(s1Authorization.risk).filter(([key])=>key in baseAuthorization.risk))};
 assert.deepEqual(shadow.S1.risk,s1Risk,'JEV_SYNC_S1_RISK_DRIFT');
 assert.equal(shadow.S1.entryQualityPolicy?.revision,s1Iq1Profile.revision,'JEV_SYNC_S1_IQ1_REVISION');
 for(const key of Object.keys(s1Iq1Profile))assert.deepEqual(shadow.S1.entryQualityPolicy?.[key],s1Iq1Profile[key],`JEV_SYNC_S1_IQ1_PROFILE:${key}`);
 assert.equal(shadow.S1.entryQualityPolicy?.jevDisposition,'EXACT_TRADE_ANCHOR_REQUIRED_SHADOW_WAITS_WITHOUT_CAUSAL_PROOF','JEV_SYNC_S1_IQ1_JEV_DISPOSITION');
 const s2Risk={...baseAuthorization.risk,...Object.fromEntries(
  Object.entries(s2Authorization.risk).filter(([key])=>key in baseAuthorization.risk))};
 assert.deepEqual(shadow.S2.risk,{...s2Risk,...leverage},'JEV_SYNC_S2_RISK_DRIFT');
 assert.equal(shadow.S1.strategy.signal.entryAdmissionRevision,s1.strategy.signal.entryAdmissionRevision,'JEV_SYNC_S1_REVISION');
 assert.equal(shadow.S2.strategy.signal.entryAdmissionRevision,s2Authorization.entryAdmissionRevision,'JEV_SYNC_S2_REVISION');
 assert.equal(ENTRY_BAND_BPS.S1,s2Authorization.preserves.S1EntryBandBps,'JEV_SYNC_S1_BAND');
 assert.equal(ENTRY_BAND_BPS.S2,s2Authorization.preserves.S2EntryBandBps,'JEV_SYNC_S2_BAND');
 assert.equal(current.jevS1S2RuleSync?.s1PxDistanceGateEnabled,false,'JEV_SYNC_STATE_S1_PX_DISTANCE_GATE');
 assert.equal(current.jevS1S2RuleSync?.s1ExecutionCloseGuardBps,50,'JEV_SYNC_STATE_S1_CLOSE_GUARD');
 assert.equal(current.jevS1S2RuleSync?.s1LegacyEntryBandBps,ENTRY_BAND_BPS.S1,'JEV_SYNC_STATE_S1_LEGACY_BAND');
 assert.equal(current.jevS1S2RuleSync?.s2EntryBandBps,ENTRY_BAND_BPS.S2,'JEV_SYNC_STATE_S2_BAND');
 const site=await fs.readFile(path.join(rootPath,'apps/jev-filter/lib/entry-band.ts'),'utf8');
 const siteMatch=site.match(/account\s*===\s*'S2'\s*\?\s*(\d+)\s*:\s*(\d+)/);
 assert.ok(siteMatch,'JEV_SYNC_SITE_BAND_FORMAT');
 assert.equal(Number(siteMatch[1])*100,ENTRY_BAND_BPS.S2,'JEV_SYNC_SITE_S2_BAND');
 assert.equal(Number(siteMatch[2])*100,ENTRY_BAND_BPS.S1,'JEV_SYNC_SITE_S1_BAND');
 for(const relative of ['apps/jev-filter/app/ShadowBoard.tsx','apps/jev-filter/app/ResearchBoard.tsx']){
  const content=await fs.readFile(path.join(rootPath,relative),'utf8');
  assert.ok(content.includes('取消 IQ1 的 Px')&&content.includes('50bp'),`JEV_SYNC_SITE_WORDING:${relative}`);
 }
 const shadowBoard=await fs.readFile(path.join(rootPath,'apps/jev-filter/app/ShadowBoard.tsx'),'utf8');
 assert.ok(shadowBoard.includes('S1 单笔上限4%、组合10%；S2 单笔上限4%、组合12%'),
  'JEV_SYNC_SITE_RISK_WORDING');
 assert.ok(shadowBoard.includes('IQ1 P1 精确逐笔锚点'),'JEV_SYNC_SITE_S1_IQ1_WORDING');
 assert.ok(shadowBoard.includes('S1 币种初始杠杆上限4倍，S2 上限25倍，总名义敞口仍不超过各账户权益4倍'),
  'JEV_SYNC_SITE_LEVERAGE_WORDING');
 const researchBoard=await fs.readFile(path.join(rootPath,'apps/jev-filter/app/ResearchBoard.tsx'),'utf8');
 assert.ok(researchBoard.includes('实盘口径 4% / 10% / 4仓 / 25×'),'JEV_SYNC_SITE_SMC_RISK_WORDING');
 return {status:'OK',sourceFingerprint:source.fingerprint,sourceFileCount:source.fileCount,s1PxDistanceGateEnabled:false,s1ExecutionCloseGuardBps:50,s1LegacyEntryBandBps:ENTRY_BAND_BPS.S1,s2EntryBandBps:ENTRY_BAND_BPS.S2};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--fingerprint'){
  const contract=await readJson(root,'governance/jev-sync-contract.json');
  process.stdout.write(`${JSON.stringify(await fingerprintPaths(root,contract.watchPaths))}\n`);
 }else process.stdout.write(`${JSON.stringify(await verifyJevSync())}\n`);
}
