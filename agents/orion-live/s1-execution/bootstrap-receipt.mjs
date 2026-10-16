import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { invariant } from './common.mjs';

const KEYS = ['schema', 'initializedAt', 'completedAt', 'legacyBudgetDigest', 'legacyLastAt', 'legacyBlockedUntil',
  'legacyRequests', 'legacyThrottles', 'minimumBlockedUntil', 'stoppedConsumers', 'legacyCountersAreNotAllIpTotals', 'realOrdersAllowed'];
const CONTAINERS = ['aegis-binance-prod-readonly', 'aegis-s1-scanner', 'aegis-s1-readonly-shadow'];
const time = value => Number.isSafeInteger(value) && value >= 0;
const RECOVERY_IDS = ['f55cf76ec5d34a0972d5065eddb8b96f8b07a0d4ef3ee327cf3b1e028c3dfa32',
  '5f43ff8599bd7c4ef3d62b0a57f3367a3a34d3bc6379a4ec8db76356c7f4536f',
  'af64837467713460f7a6c1228736c49c830dcbc87994c7fed88645fd962a96d3'];

export function validateRecoveryProvenance(recovery, stopped) {
  const keys = ['ownerConfirmationRef', 'failedPlanDigest', 'pendingWitnessDigest', 'recoveryRecordDigest',
    'exitCodes', 'legacyShutdownDrainVerified', 'interruptedWork', 'captureGapStartedAt'];
  invariant(recovery && Object.keys(recovery).sort().join(',') === keys.sort().join(',')
    && recovery.ownerConfirmationRef === 'OWNER-CONFIRM-S1-UNCLEAN-READ-RECOVERY-20260913'
    && recovery.failedPlanDigest === '2769cf3c697da9de46702751edc3e6d99fc5b6b9e24137fdbeb5adf377cec7c7'
    && recovery.pendingWitnessDigest === '498e8e1a90d427af04cdd937b76292d7eb4de917bc81578e847c6cfc150d9d65'
    && typeof recovery.recoveryRecordDigest === 'string' && /^[a-f0-9]{64}$/.test(recovery.recoveryRecordDigest)
    && recovery.recoveryRecordDigest !== '0'.repeat(64)
    && recovery.legacyShutdownDrainVerified === false && recovery.interruptedWork === 'UNKNOWN'
    && recovery.captureGapStartedAt === '2026-09-13T08:56:52.649Z', 'SHARED_RECOVERY_PROVENANCE_INVALID');
  invariant(recovery.exitCodes && Object.keys(recovery.exitCodes).sort().join(',') === [...CONTAINERS].sort().join(',')
    && CONTAINERS.every((name, i) => recovery.exitCodes[name] === (i === 1 ? 143 : 0) && stopped?.[name]?.id === RECOVERY_IDS[i]),
  'SHARED_RECOVERY_EXACT_INCIDENT_REQUIRED');
}

// Root-owned evidence from the stopped-service coordinator, not a trading
// permission. Test owner injection does not change the production factory.
export async function readBootstrapReceipt(root, { ownerUid = 0, now = Date.now } = {}) {
  try {
    try { await fs.lstat(path.join(root, 'bootstrap.pending')); throw new Error('SHARED_BOOTSTRAP_INCOMPLETE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(path.join(root, 'bootstrap.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let receipt;
    try {
      const stat = await handle.stat();
      invariant(stat.isFile() && stat.nlink === 1 && stat.uid === ownerUid && (stat.mode & 0o777) === 0o440
        && stat.size > 0 && stat.size <= 4096, 'SHARED_BOOTSTRAP_RECEIPT_BOUNDARY');
      const bytes = Buffer.alloc(4097); let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset);
        if (!bytesRead) break; offset += bytesRead;
      }
      invariant(offset <= 4096, 'SHARED_BOOTSTRAP_RECEIPT_SIZE');
      receipt = JSON.parse(bytes.toString('utf8', 0, offset));
    } finally { await handle.close(); }
    const recovery = receipt?.schema === 'S1_SHARED_READ_BOOTSTRAP_RECOVERY_V2';
    invariant(receipt && Object.keys(receipt).sort().join(',') === [...KEYS, ...(recovery ? ['recovery'] : [])].sort().join(',')
      && (recovery || receipt.schema === 'S1_SHARED_READ_BOOTSTRAP_V1') && receipt.realOrdersAllowed === false
      && receipt.legacyCountersAreNotAllIpTotals === true && /^[a-f0-9]{64}$/.test(receipt.legacyBudgetDigest), 'SHARED_BOOTSTRAP_RECEIPT_INVALID');
    invariant(['initializedAt', 'completedAt', 'legacyLastAt', 'legacyBlockedUntil', 'legacyRequests', 'legacyThrottles', 'minimumBlockedUntil'].every(k => time(receipt[k]))
      && receipt.legacyLastAt <= receipt.initializedAt && receipt.initializedAt <= receipt.completedAt
      && receipt.completedAt <= receipt.initializedAt + 30000 && receipt.completedAt <= now()
      && receipt.minimumBlockedUntil === Math.max(receipt.initializedAt + 65000, receipt.legacyBlockedUntil), 'SHARED_BOOTSTRAP_RECEIPT_TIME');
    invariant(receipt.stoppedConsumers && Object.keys(receipt.stoppedConsumers).sort().join(',') === [...CONTAINERS].sort().join(',')
      && Object.values(receipt.stoppedConsumers).every(row => row && Object.keys(row).sort().join(',') === 'finishedAt,id,restartCount'
        && /^[a-f0-9]{64}$/.test(row.id) && typeof row.finishedAt === 'string' && row.finishedAt.length <= 40
        && Number.isFinite(Date.parse(row.finishedAt)) && Date.parse(row.finishedAt) <= receipt.initializedAt
        && time(row.restartCount)), 'SHARED_BOOTSTRAP_STOP_EVIDENCE');
    if (recovery) validateRecoveryProvenance(receipt.recovery, receipt.stoppedConsumers);
    return receipt;
  } catch {
    // Do not expose receipt/file/JSON contents through a startup exception.
    throw new Error('SHARED_BOOTSTRAP_RECEIPT_REQUIRED_OR_INVALID');
  }
}

export function assertBootstrapBudget(budget, receipt) {
  const status = budget.status();
  invariant(status.blockedUntil >= receipt.minimumBlockedUntil && status.requests >= receipt.legacyRequests
    && status.throttles >= receipt.legacyThrottles, 'SHARED_BOOTSTRAP_STATE_REGRESSED');
}
