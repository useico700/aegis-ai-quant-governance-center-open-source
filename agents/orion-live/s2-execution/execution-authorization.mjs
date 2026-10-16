import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { hash, invariant, REVISION } from './common.mjs';
import { validateMutation } from './transport.mjs';

export const EXECUTION_AUTHORIZATION_FILE = '/etc/aegis/s2-execution-control/authorization.json';

export function disabledExecutionAuthorization(trialLimits) {
  return { schema: 'S2_EXECUTION_AUTHORIZATION_V1', accountLabel: 'S2', strategyRevision: REVISION,
    trialLimitsDigest: hash(trialLimits), enabled: false, entriesEnabled: false };
}

export async function readExecutionAuthorization() {
  const handle = await fs.open(EXECUTION_AUTHORIZATION_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    invariant(stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0 && stat.size <= 4096, 'EXECUTION_AUTHORIZATION_FILE_INVALID');
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    invariant(length <= 4096, 'EXECUTION_AUTHORIZATION_FILE_TOO_LARGE');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

function validAuthorization(config, limitsDigest) {
  return config?.schema === 'S2_EXECUTION_AUTHORIZATION_V1'
    && config.accountLabel === 'S2'
    && config.strategyRevision === REVISION
    && config.trialLimitsDigest === limitsDigest
    && typeof config.enabled === 'boolean'
    && typeof config.entriesEnabled === 'boolean'
    && (config.enabled || !config.entriesEnabled);
}

// A heartbeat may expose only this bounded authorization summary. It never
// returns the file contents or digest and it grants no capability: every venue
// mutation still re-reads the root-owned file through createExecutionAuthorization.
export async function readExecutionAuthorizationStatus({ trialLimits, load = readExecutionAuthorization }) {
  try {
    const config = await load();
    if (!validAuthorization(config, hash(trialLimits))) {
      return { status: 'INVALID_OR_UNREADABLE', enabled: false, entriesEnabled: false };
    }
    if (!config.enabled) return { status: 'DISABLED', enabled: false, entriesEnabled: false };
    const entriesEnabled = config.entriesEnabled && (!trialLimits.entryAdmissionRevision
      || config.entryAdmissionRevision === trialLimits.entryAdmissionRevision);
    return { status: entriesEnabled ? 'ENABLED_ENTRIES_AND_EXITS' : 'ENABLED_EXITS_ONLY',
      enabled: true, entriesEnabled };
  } catch {
    return { status: 'INVALID_OR_UNREADABLE', enabled: false, entriesEnabled: false };
  }
}

// No writer or enable command. The operator supplies an exact configuration;
// missing, unreadable or mismatched files deny the operation. Read every time.
export function createExecutionAuthorization({ trialLimits, load = readExecutionAuthorization }) {
  const limitsDigest = hash(trialLimits);
  return async operation => {
    try {
      validateMutation(operation.method, operation.pathname, operation.params);
      const config = await load();
      if (!validAuthorization(config, limitsDigest) || config.enabled !== true) return false;
      const entry = operation.method === 'POST' && operation.pathname === '/fapi/v1/order'
        && operation.params.side === (operation.params.positionSide === 'LONG' ? 'BUY' : 'SELL');
      // Admission-version mismatch blocks new exposure, never owned protection.
      return !entry || (config.entriesEnabled && (!trialLimits.entryAdmissionRevision
        || config.entryAdmissionRevision === trialLimits.entryAdmissionRevision));
    } catch { return false; }
  };
}
