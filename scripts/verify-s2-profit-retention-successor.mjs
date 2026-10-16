import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IQ1_AUTH_PATH, IQ1_MANIFEST, IQ1_CHANGED, IQ1_ADDED, IQ1_PROTECTED,
  IQ1_BEFORE, IQ1_PREDECESSORS, verifyIq1Successor } from './verify-v2-iq1-successor.mjs';

export const S2_SOURCE_MANIFEST = 'governance/evidence/manifests/s2-profit-retention-source-supersession-20260923.json';
export const S2_SOURCE_BEFORE = 'governance/evidence/s2-profit-retention-source-supersession-20260923/before/';
export const S2_SOURCE_AUTH = 'governance/owner-authorizations/2026-09-23-s2-profit-retention-repair.json';
export const S2_SOURCE_EVIDENCE = 'governance/evidence/s2-profit-retention-live-20260923.json';
export const S2_DEPLOYED_MANIFEST = 'reports/s2-profit-retention-20260923/s2-final-source-verification.json';
export const S2_SHARED_SOURCE = 'agents/shared/r21-profit-protection.mjs';
export const S2_VERIFIER_SOURCE = 'scripts/verify-migration.mjs';
export const S2_SOURCE_CHANGED = [S2_SHARED_SOURCE, S2_VERIFIER_SOURCE,
  'tests/v2-iq1-governance.test.mjs', 'tests/aegis-clean-rotation.test.mjs'];
export const S2_SOURCE_ADDED = ['scripts/verify-s2-profit-retention-successor.mjs', 'tests/s2-profit-retention-source-supersession.test.mjs'];
export const S2_SOURCE_PREDECESSORS = ['governance/evidence/manifests/v2-r21-integrity-repair-20260913.json', IQ1_MANIFEST];
const PREDECESSOR_HASHES = ['629312a02d2c2d3cbad83d2b16ac766ab3b7574dbc5c6a645871e5f861b066d1',
  '09edcc5f088b1760f655b705695293bf522bd82ce48b15f6c54ed328983912ea'];
const AUTHORIZATION_ID = 'OWNER-DIRECTIVE-S2-PROFIT-RETENTION-REPAIR-20260923';
const REVISION = 'S2-P5-AGGREGATE-NET-PROFIT-LOCK-1';
const RELEASE = '/opt/aegis/s2-live/releases/aegis-s2-live-20260922T1835Z-profit-cancel-terminal';
const SHARED_AFTER_HASH = '048b70c1509351de53b3396cd1de0cc768ef62501d993933355e5797582b6e5c';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, descriptor) => Buffer.isBuffer(bytes) && bytes.length === descriptor?.bytes && digest(bytes) === descriptor?.sha256;
const must = (condition, reason) => { if (!condition) throw new Error('S2_PROFIT_SOURCE_SUCCESSOR:' + reason); };
const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === actual.length && [...actual].sort().join('\n') === [...expected].sort().join('\n');

// Authenticate this exact prospective ATR change and this verifier's own predecessor.
// No historical manifest is rewritten and no general source-integrity exception exists.
export function verifyS2ProfitRetentionSuccessor({ current, manifest: m, sources }) {
  const state = current?.s2ProfitRetention20260923;
  must(state?.status === 'DEPLOYED_AND_PRODUCTION_VERIFIED' && state.authorization === S2_SOURCE_AUTH &&
    state.managementRevision === REVISION && state.release === RELEASE && state.evidence === S2_SOURCE_EVIDENCE &&
    state.existingPlansRemainFrozen === true && state.riskUnchanged === true, 'ACTIVE_POINTER');
  must(m?.schemaVersion === 1 && m.authorizationId === AUTHORIZATION_ID && m.authorization === S2_SOURCE_AUTH &&
    m.scope === 'S2_OPTIONAL_ATR_WARMUP_AND_MIGRATION_VERIFIER_ONLY' && m.historicalManifestsPreserved === true &&
    m.legacyDefaultBehaviorUnchanged === true && m.deploymentEvidence === S2_SOURCE_EVIDENCE && m.deployedSourceManifest === S2_DEPLOYED_MANIFEST, 'SCOPE');
  must(sameSet(m.files?.map(f => f.path), [...S2_SOURCE_CHANGED, ...S2_SOURCE_ADDED]), 'SOURCE_SET');
  must(sameSet(m.predecessors?.map(f => f.path), S2_SOURCE_PREDECESSORS), 'PREDECESSOR_SET');
  must(sameSet(m.bindings?.map(f => f.path), [S2_SOURCE_AUTH, S2_DEPLOYED_MANIFEST]), 'BINDING_SET');
  for (const f of m.bindings) must(matches(sources[f.path], f), 'BINDING_HASH:' + f.path);
  for (const f of m.predecessors) {
    must(f.sha256 === PREDECESSOR_HASHES[S2_SOURCE_PREDECESSORS.indexOf(f.path)] &&
      f.beforeSource === S2_SOURCE_BEFORE + f.path && matches(sources[f.path], f) &&
      matches(sources[f.beforeSource], f), 'PREDECESSOR_HASH:' + f.path);
  }
  const a = JSON.parse(sources[S2_SOURCE_AUTH]);
  must(a.authorizationId === AUTHORIZATION_ID && a.status === 'OWNER_AUTHORIZED_ACTIVE' && a.account === 'S2' &&
    a.executionHost === 'demo-server/aegis-demo-host' && a.managementRevision === REVISION &&
    a.verificationStatus === 'DEPLOYED_AND_PRODUCTION_VERIFIED' && a.deploymentEvidence === S2_SOURCE_EVIDENCE &&
    a.repairs?.includes('Prospective S2 15M ATR input with pre-entry volatility warmup but post-entry extremes only.') &&
    a.preserves?.includes('S1 live strategy and risk unchanged'), 'AUTHORITY');
  const deployed = JSON.parse(sources[S2_DEPLOYED_MANIFEST]);
  const evidence = JSON.parse(sources[S2_SOURCE_EVIDENCE]);
  must(deployed.release === RELEASE && deployed.allMatch === true && deployed.count === 21 &&
    Object.keys(deployed.files ?? {}).length === 21 && deployed.files[S2_SHARED_SOURCE] === SHARED_AFTER_HASH &&
    evidence.status === 'DEPLOYED_AND_PRODUCTION_VERIFIED' && evidence.release === RELEASE &&
    evidence.ownerAuthorization === S2_SOURCE_AUTH && evidence.sourceManifest === S2_DEPLOYED_MANIFEST &&
    evidence.sourceFilesVerified === 21 && evidence.existingPlanNumericPoliciesFrozen === true &&
    evidence.s1LiveUnchanged === true && evidence.validation?.productionSourceMatch === true, 'DEPLOYMENT_BINDING');
  const repair = JSON.parse(sources[S2_SOURCE_PREDECESSORS[0]]);
  const iq1 = JSON.parse(sources[IQ1_MANIFEST]);
  const retained = new Map();
  for (const f of m.files) {
    must(matches(sources[f.path], f.after), 'CURRENT_HASH:' + f.path);
    if (S2_SOURCE_CHANGED.includes(f.path)) {
      const previous = f.path === S2_SHARED_SOURCE ? repair.protectedFiles.find(x => x.path === f.path) : iq1.files.find(x => x.path === f.path)?.after;
      must(f.beforeSource === S2_SOURCE_BEFORE + f.path && matches(sources[f.beforeSource], f.before) &&
        matches(sources[f.beforeSource], previous), 'PREDECESSOR_LINK:' + f.path);
      retained.set(f.path, { ...f, bytes: Buffer.from(sources[f.beforeSource]) });
    } else must(f.before === null && f.beforeSource === null, 'ADDED_BASELINE');
  }
  must(digest(sources[S2_SHARED_SOURCE]) === SHARED_AFTER_HASH, 'EXACT_SHARED_AFTER');
  return {
    normalizeVerifier(file, bytes) {
      if (file === S2_SHARED_SOURCE || !S2_SOURCE_CHANGED.includes(file)) return bytes;
      const f = retained.get(file);
      if (matches(bytes, f.before)) return bytes;
      must(matches(bytes, f.after), 'UNAUTHENTICATED_VERIFIER');
      return Buffer.from(f.bytes);
    },
    matchesProtectedSource(file, expected, bytes) {
      if (file !== S2_SHARED_SOURCE) return false;
      const f = retained.get(file);
      return expected?.bytes === f.before.bytes && expected?.sha256 === f.before.sha256 && matches(bytes, f.after);
    },
  };
}

export async function loadS2ProfitRetentionSuccessor(root, current, upstream = null) {
  const read = f => fs.readFile(path.join(root, f));
  const manifest = JSON.parse(await read(S2_SOURCE_MANIFEST));
  const paths = [...S2_SOURCE_CHANGED, ...S2_SOURCE_ADDED, ...S2_SOURCE_CHANGED.map(f => S2_SOURCE_BEFORE + f),
    ...S2_SOURCE_PREDECESSORS, ...S2_SOURCE_PREDECESSORS.map(f => S2_SOURCE_BEFORE + f), S2_SOURCE_AUTH, S2_DEPLOYED_MANIFEST, S2_SOURCE_EVIDENCE];
  const sources = Object.fromEntries(await Promise.all(paths.map(async f => [f, upstream ? upstream.normalize(f, await read(f)) : await read(f)])));
  return verifyS2ProfitRetentionSuccessor({ current, manifest, sources });
}

// Keep the existing IQ1 validator and every downstream HF14/rotation check intact.
// Changed verification inputs use authenticated pre-change verifier/fixture bytes.
export async function loadS2CompatibleIq1(root, current, successor, upstream = null) {
  const read = f => fs.readFile(path.join(root, f));
  const [authorization, manifest] = await Promise.all([IQ1_AUTH_PATH, IQ1_MANIFEST].map(async f => JSON.parse(await read(f))));
  const paths = [...IQ1_CHANGED, ...IQ1_ADDED, ...IQ1_PROTECTED, ...[...IQ1_CHANGED, ...IQ1_PROTECTED].map(f => IQ1_BEFORE + f)];
  const [sources, predecessors] = await Promise.all([
    Promise.all(paths.map(async f => { const bytes = await read(f); return [f, successor.normalizeVerifier(f, upstream ? upstream.normalize(f, bytes) : bytes)]; })).then(Object.fromEntries),
    Promise.all(IQ1_PREDECESSORS.map(async f => [f, await read(f)])).then(Object.fromEntries),
  ]);
  const iq1 = verifyIq1Successor({ current, authorization, manifest, sources, predecessors });
  return { normalize: (file, bytes) => iq1.normalize(file,
    successor.normalizeVerifier(file, upstream ? upstream.normalize(file, bytes) : bytes)) };
}
