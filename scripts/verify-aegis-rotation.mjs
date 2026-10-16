import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadV3Hf14SharedSuccessor } from './verify-v3-hf14-successor.mjs';
import { loadAegisCurrentRotation } from './verify-aegis-current-rotation.mjs';

export const ROTATION_ID = 'OWNER-DIRECTIVE-AEGIS-PRIME-CLEAN-CONTEXT-ROTATION-20260914';
export const ROTATION_ROOT = 'governance/evidence/aegis-prime-rotation-20260914';
export const ROTATION_AUTH = 'governance/owner-authorizations/2026-09-14-aegis-prime-clean-context-rotation.json';
export const ROTATION_EVIDENCE = 'governance/evidence/aegis-prime-clean-context-rotation-20260914.json';
export const ROTATION_MANIFEST = 'governance/evidence/manifests/aegis-prime-clean-context-rotation-20260914.json';
const NEW = '00000000-0000-4000-8000-000000000000';
const OLD = '00000000-0000-4000-8000-000000000000';
const FORK = '00000000-0000-4000-8000-000000000000';
const SELF = 'scripts/verify-migration.mjs';
const PRIOR_AUTH = 'OWNER-DIRECTIVE-AEGIS-PRIME-CONTEXT-HYGIENE-MAIN-THREAD-ROTATION-20260911';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const must = (condition, message) => { if (!condition) throw new Error(`AEGIS_ROTATION:${message}`); };

export function verifyAegisRotationState({current, registry, authorization, evidence, historical}) {
  const c = current.aegisPrimeConversation;
  must(authorization.id === ROTATION_ID && authorization.status === 'ACTIVE' && authorization.owner === 'Operator', 'AUTHORIZATION');
  must(authorization.supersedesForAegisPrime === PRIOR_AUTH && authorization.fullTranscriptReplayAllowed === false && authorization.deletionAuthorized === false && authorization.runtimeMutationAllowed === false, 'BOUNDARIES');
  must(authorization.newThreadId === NEW && authorization.replacedThreadId === OLD && authorization.accidentalForkThreadId === FORK, 'AUTHORIZED_IDS');
  must(c.authorizationId === ROTATION_ID && c.rotationAuthorizationId === ROTATION_ID && c.activeThreadId === NEW && c.replacedThreadId === OLD && c.accidentalForkThreadId === FORK, 'POINTER');
  must(c.activeThreadTitle === 'AEGIS PRIME｜治理控制面' && c.fullTranscriptReplayAllowed === false && c.runtimeOrTradingMutationByThreadRotationAllowed === false && c.replacedThreadDeleted === false, 'CONVERSATION_BOUNDARIES');
  must(c.rotationEvidence === ROTATION_EVIDENCE && c.evidence === ROTATION_EVIDENCE && c.handoffEvidence === authorization.handoff, 'EVIDENCE_POINTERS');
  must(current.agentGovernanceRouting.mainThreads.aegisPrime === NEW && current.agentGovernanceRouting.aegisMainThreadAuthorizationId === ROTATION_ID && registry.agents.find(a => a.id === 'aegis-prime')?.threadId === NEW, 'ROUTING');
  must(historical.aegisPrimeConversation.activeThreadId === OLD && historical.aegisPrimeConversation.authorizationId === PRIOR_AUTH && historical.agentGovernanceRouting.mainThreads.aegisPrime === OLD, 'HISTORICAL_CHAIN');
  must([historical.aegisPrimeConversation.replacedThreadId, FORK, ...historical.aegisPrimeConversation.priorReplacedThreadIds].every(id => c.priorReplacedThreadIds.includes(id)), 'HISTORY_PRESERVED');
  must(evidence.authorizationId === ROTATION_ID && evidence.newThreadId === NEW && evidence.replacedThreadId === OLD && evidence.accidentalForkThreadId === FORK, 'EVIDENCE_IDS');
  must(evidence.newThreadInitialStatus === 'WAITING_POINTER' && typeof evidence.newThreadInitialTurnId === 'string' && evidence.fullTranscriptCopiedOrReplayed === false && evidence.runtimeOrTradingMutation === false && evidence.automationMutation === false, 'HANDOFF_BOUNDARIES');
  must(evidence.automationCarryover.id === 'v2' && evidence.automationCarryover.status === 'NOT_FOUND_IN_CURRENT_CONFIG_OBLIGATION_PRESERVED' && evidence.automationCarryover.obligationPreserved === true && evidence.automationCarryover.recreated === false, 'AUTOMATION_TRUTH');
  const stage = evidence.status;
  must(['WAITING_FINAL_READY_VERIFICATION', 'READY_VERIFIED_ARCHIVE_PENDING', 'COMPLETED_READY_VERIFIED_ARCHIVED'].includes(stage), 'STAGE');
  must(c.initializationStatus === (stage === 'WAITING_FINAL_READY_VERIFICATION' ? stage : 'READY_VERIFIED'), 'INITIALIZATION');
  if (stage !== 'WAITING_FINAL_READY_VERIFICATION') must(evidence.newThreadReadyStatus === 'READY' && typeof evidence.newThreadReadyTurnId === 'string', 'READY_RECEIPT');
  if (stage === 'COMPLETED_READY_VERIFIED_ARCHIVED') {
    must(c.status === 'ACTIVE_CLEAN_MAIN_THREAD' && c.replacedThreadStatus === 'READ_ONLY_ARCHIVED_HISTORY' && c.replacedThreadArchiveRecoverable === true && typeof c.replacedThreadArchiveVerifiedAt === 'string', 'ARCHIVE_STATE');
    must(evidence.replacedThreadArchived === true && evidence.accidentalForkArchived === true && typeof evidence.archiveVerifiedAt === 'string' && evidence.replacedThreadDeleted === false && evidence.accidentalForkDeleted === false, 'ARCHIVE_EVIDENCE');
  } else must(evidence.accidentalForkArchived === false, 'ARCHIVE_BEFORE_READY');
  return true;
}

export async function loadAegisRotation(root, current, sourceNormalizer = null) {
  if (!sourceNormalizer) {
    const hf14 = await loadV3Hf14SharedSuccessor(root, current);
    sourceNormalizer = (file, bytes) => hf14 ? hf14.normalize(file, bytes) : bytes;
  }
  const currentRouting = await loadAegisCurrentRotation(root, current, sourceNormalizer);
  const predecessorCurrent = currentRouting?.priorCurrent ?? current;
  const pointer = predecessorCurrent.aegisPrimeConversation;
  const exists = await fs.access(path.join(root, ROTATION_AUTH)).then(() => true, () => false);
  if (!exists && pointer?.authorizationId !== ROTATION_ID) return null;
  must(pointer?.authorizationId === ROTATION_ID, 'ACTIVE_SUCCESSOR_REQUIRED');
  const read = f => fs.readFile(path.join(root, f));
  const readSource = async f => sourceNormalizer(f, currentRouting ? currentRouting.normalize(f, await read(f)) : await read(f));
  const json = async f => JSON.parse(await read(f));
  const [authorization, evidence, manifest, liveRegistry] = await Promise.all([json(ROTATION_AUTH), json(ROTATION_EVIDENCE), json(ROTATION_MANIFEST), json('memory/registry.json')]);
  const registry = currentRouting?.priorRegistry ?? liveRegistry;
  must(manifest.authorizationId === ROTATION_ID && manifest.scope === 'AEGIS_CONVERSATION_ROUTING_AND_VERIFICATION_ONLY', 'SOURCE_SCOPE');
  const expected = [SELF, 'scripts/verify-aegis-rotation.mjs', 'tests/aegis-clean-rotation.test.mjs', ROTATION_AUTH,
    'governance/handoffs/aegis-prime-rotation-20260914.md', ROTATION_ROOT + '/historical-routing.json',
    ROTATION_ROOT + '/before/' + SELF, ROTATION_ROOT + '/before/governance/current-state.json', ROTATION_ROOT + '/before/memory/registry.json',
    'governance/evidence/manifests/v2-monitor-information-layout-20260914.json',
    'governance/owner-authorizations/2026-09-11-aegis-prime-context-hygiene-main-thread-rotation.json',
    'governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260911.json'];
  must(JSON.stringify(manifest.files.map(f => f.path).sort()) === JSON.stringify(expected.sort()), 'SOURCE_SET');
  const sources = {};
  for (const f of manifest.files) {
    const bytes = await readSource(f.path);
    must(bytes.length === f.bytes && hash(bytes) === f.sha256, `SOURCE_HASH:${f.path}`);
    sources[f.path] = bytes;
  }
  const historical = JSON.parse(sources[ROTATION_ROOT + '/historical-routing.json']);
  const before = JSON.parse(sources[ROTATION_ROOT + '/before/governance/current-state.json']);
  must(JSON.stringify(historical) === JSON.stringify({aegisPrimeConversation:before.aegisPrimeConversation, agentGovernanceRouting:before.agentGovernanceRouting}), 'BASELINE_LINK');
  const priorManifest = JSON.parse(sources['governance/evidence/manifests/v2-monitor-information-layout-20260914.json']);
  const prior = priorManifest.files.find(f => f.path === SELF)?.after;
  const beforeSource = sources[ROTATION_ROOT + '/before/' + SELF];
  must(prior?.sha256 === hash(beforeSource) && prior?.bytes === beforeSource.length, 'IMMUTABLE_PREDECESSOR_LINK');
  verifyAegisRotationState({current:predecessorCurrent, registry, authorization, evidence, historical});
  return { historical, normalize(filePath, bytes) {
    if (filePath !== SELF) return bytes;
    must(hash(bytes) === hash(sources[SELF]), 'CURRENT_SOURCE_DRIFT');
    return beforeSource;
  }};
}
