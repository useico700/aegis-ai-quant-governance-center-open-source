import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadAegisCurrentRotation } from './verify-aegis-current-rotation.mjs';

export const S1_IQ1_SOURCE_MANIFEST = 'governance/evidence/manifests/s1-r221-iq1-source-supersession-20260925.json';
export const S1_IQ1_SOURCE_BEFORE = 'governance/evidence/s1-r221-iq1-source-supersession-20260925/before/';
export const S1_IQ1_SOURCE_CHANGED = [
  'agents/orion-v2/paper/iq1-entry-quality.mjs',
  'scripts/verify-migration.mjs',
  'scripts/verify-s2-profit-retention-successor.mjs',
];
export const S1_IQ1_SOURCE_ADDED = [
  'scripts/verify-s1-r221-iq1-successor.mjs',
  'tests/s1-r221-iq1-source-supersession.test.mjs',
];
const AUTH = 'governance/owner-authorizations/2026-09-25-s1-r221-iq1-p1-risk-4pct-live.json';
const EVIDENCE = 'governance/evidence/s1-r221-iq1-p1-risk4-live-20260925.json';
const PREDECESSORS = ['governance/evidence/manifests/v2-iq1-execution-20260915.json',
  'governance/evidence/manifests/s2-profit-retention-source-supersession-20260923.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const matches = (bytes, descriptor) => Buffer.isBuffer(bytes) && bytes.length === descriptor?.bytes && digest(bytes) === descriptor?.sha256;
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const must = (condition, reason) => { if (!condition) throw new Error(`S1_R221_IQ1_SOURCE_SUCCESSOR:${reason}`); };

export function verifyS1R221Iq1Successor({ current, manifest, sources }) {
  const state = current?.s1R221Iq1P1NoDistance20260925;
  must(state?.status === 'DEPLOYED_AND_PRODUCTION_VERIFIED' && state.authorization === AUTH &&
    state.evidence === EVIDENCE && state.pxDistanceGateEnabled === false && state.executionCloseGuardBps === 50 &&
    state.liveReady === true && state.entriesAllowed === true, 'ACTIVE_POINTER');
  must(manifest?.schemaVersion === 1 && manifest.authorization === AUTH && manifest.deploymentEvidence === EVIDENCE &&
    manifest.scope === 'S1_R221_IQ1_OPTIONAL_PX_DISTANCE_GATE_AND_SUCCESSOR_CHAIN_ONLY' &&
    manifest.historicalManifestsPreserved === true && manifest.legacyDefaultBehaviorUnchanged === true, 'SCOPE');
  must(sameSet(manifest.files?.map(row => row.path), [...S1_IQ1_SOURCE_CHANGED, ...S1_IQ1_SOURCE_ADDED]), 'SOURCE_SET');
  must(sameSet(manifest.bindings?.map(row => row.path), [AUTH, EVIDENCE]), 'BINDING_SET');
  must(sameSet(manifest.predecessors?.map(row => row.path), PREDECESSORS), 'PREDECESSOR_SET');
  for (const row of manifest.bindings) must(matches(sources[row.path], row), `BINDING:${row.path}`);
  for (const row of manifest.predecessors) must(matches(sources[row.path], row), `PREDECESSOR:${row.path}`);
  const iq1Predecessor = JSON.parse(sources[PREDECESSORS[0]]);
  const s2Predecessor = JSON.parse(sources[PREDECESSORS[1]]);
  const authorization = JSON.parse(sources[AUTH]);
  const evidence = JSON.parse(sources[EVIDENCE]);
  must(authorization.status === 'OWNER_AUTHORIZED_ACTIVE' && authorization.verificationStatus === 'DEPLOYED_AND_PRODUCTION_VERIFIED' &&
    authorization.entryStrategy?.pxDistanceGateEnabled === false && authorization.risk?.perTradeRiskFraction === '0.04' &&
    evidence.status === 'DEPLOYED_AND_PRODUCTION_VERIFIED' && evidence.strategy?.pxDistanceGateEnabled === false &&
    evidence.strategy?.executionCloseGuardBps === 50, 'AUTHORIZATION_BINDING');
  const retained = new Map();
  for (const row of manifest.files) {
    must(matches(sources[row.path], row.after), `CURRENT_HASH:${row.path}`);
    if (S1_IQ1_SOURCE_CHANGED.includes(row.path)) {
      must(row.beforeSource === S1_IQ1_SOURCE_BEFORE + row.path && matches(sources[row.beforeSource], row.before), `BEFORE_HASH:${row.path}`);
      const predecessor = row.path === 'agents/orion-v2/paper/iq1-entry-quality.mjs'
        ? iq1Predecessor.files.find(item => item.path === row.path)?.after
        : s2Predecessor.files.find(item => item.path === row.path)?.after;
      must(predecessor?.bytes === row.before.bytes && predecessor?.sha256 === row.before.sha256, `PREDECESSOR_LINK:${row.path}`);
      retained.set(row.path, { ...row, bytes: Buffer.from(sources[row.beforeSource]) });
    } else must(row.before === null && row.beforeSource === null, `ADDED_BASELINE:${row.path}`);
  }
  const source = sources['agents/orion-v2/paper/iq1-entry-quality.mjs'].toString('utf8');
  must(source.includes('pxDistanceGateEnabled') && source.includes('maximumDecisionCloseDisplacementBps'), 'EXPECTED_IMPLEMENTATION');
  return {
    normalize(file, bytes) {
      const row = retained.get(file);
      if (!row || matches(bytes, row.before)) return bytes;
      must(matches(bytes, row.after), `UNAUTHENTICATED_SOURCE:${file}`);
      return Buffer.from(row.bytes);
    },
  };
}

export async function loadS1R221Iq1Successor(root, current) {
  const routing = await loadAegisCurrentRotation(root, current);
  const read = async file => {
    const bytes = await fs.readFile(path.join(root, file));
    return routing ? routing.normalize(file, bytes) : bytes;
  };
  const manifest = JSON.parse(await read(S1_IQ1_SOURCE_MANIFEST));
  const paths = [...S1_IQ1_SOURCE_CHANGED, ...S1_IQ1_SOURCE_ADDED,
    ...S1_IQ1_SOURCE_CHANGED.map(file => S1_IQ1_SOURCE_BEFORE + file), AUTH, EVIDENCE, ...PREDECESSORS];
  const sources = Object.fromEntries(await Promise.all(paths.map(async file => [file, await read(file)])));
  const successor = verifyS1R221Iq1Successor({ current, manifest, sources });
  return {normalize(file, bytes) {
    return successor.normalize(file, routing ? routing.normalize(file, bytes) : bytes);
  }};
}
