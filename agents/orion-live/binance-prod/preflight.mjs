import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { credentialErrorStatus, loadProductionCredentials } from "./credentials.mjs";
import { assertProductionBaseUrl, publicServerTime, readProductionAccount } from "./mainnet-readonly-client.mjs";
import { enforceRawRetention } from "./retention.mjs";
import { CoordinatedProductionReader } from './coordinated-reader.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(DIRECTORY, "config.json");

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

export async function runPreflight({ configPath = DEFAULT_CONFIG_PATH, fetchImpl = globalThis.fetch, hostname = os.hostname(), hostIdentity = process.env.AEGIS_PRODUCTION_HOST_ID, admission = null,
  coordinatedReader = null, configLoader = loadConfig, credentialsLoader = loadProductionCredentials, retentionCheck = enforceRawRetention, now = Date.now } = {}) {
  const config = await configLoader(configPath);
  assertProductionBaseUrl(config.venue.restBaseUrl);
  const base = {
    checkedAt: new Date(now()).toISOString(),
    runtimeId: config.runtimeId,
    mode: config.mode,
    hostname,
    hostIdentity: hostIdentity ?? null,
    hostVerified: hostname === config.host.requiredHostname && hostIdentity === config.host.requiredIdentity,
    realOrdersAllowed: false,
    newEntriesBlocked: true,
  };
  if (!base.hostVerified) return { ...base, status: "HOST_IDENTITY_REJECTED" };
  if (coordinatedReader !== null && (!(coordinatedReader instanceof CoordinatedProductionReader) || admission !== null)) throw new Error('PRODUCTION_PREFLIGHT_COORDINATION_PORTS');
  coordinatedReader?.assertRunning();
  const retention = await retentionCheck(config);
  if (coordinatedReader) {
    coordinatedReader.assertRunning();
    let credentials;
    try { credentials = await credentialsLoader(config); }
    catch (error) { return { ...base, status: credentialErrorStatus(error), retention }; }
    try {
      const result = await coordinatedReader.read(config, credentials, { fetchImpl });
      coordinatedReader.assertRunning();
      if (result.status === 'WAIT') return { ...base, status: 'DEGRADED_FAIL_CLOSED',
        error: 'PRODUCTION_COORDINATED_READ_DEFERRED', retention,
        accountRefresh: { status: 'QUEUED_UNSENT', reason: result.reason, retainedVerifiedSnapshot: false } };
      return accountPreflightResult(base, result.value.account, credentials, retention);
    } catch {
      return { ...base, status: 'SIGNED_ACCOUNT_READ_FAILED', error: 'PRODUCTION_COORDINATED_READ_FAILED', retention };
    }
  }
  const serverTime = await publicServerTime(config, { fetchImpl, admission });
  let credentials;
  try {
    credentials = await credentialsLoader(config);
  } catch (error) {
    return { ...base, status: credentialErrorStatus(error), serverTime: Number(serverTime.serverTime), retention };
  }
  try {
    const account = await readProductionAccount(config, credentials, { fetchImpl, admission, now });
    return accountPreflightResult(base, account, credentials, retention);
  } catch (error) {
    return { ...base, status: "SIGNED_ACCOUNT_READ_FAILED", error: error?.message ?? "UNKNOWN", retention };
  }
}

function accountPreflightResult(base, account, credentials, retention) {
  const accountClean = account.nonFlatPositionCount === 0 && account.openOrderCount === 0 && account.openAlgoOrderCount === 0;
  return { ...base, status: accountClean && !retention.blockNewEntries ? 'READY_READ_ONLY_SHADOW' : 'READ_ONLY_ATTENTION_REQUIRED',
    apiKeyFingerprint: credentials.apiKeyFingerprint, secretKeyFingerprint: credentials.secretKeyFingerprint, account, retention };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runPreflight(), null, 2)}\n`);
}
