import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotV4DemoAccount } from "./demo-account.mjs";
import {
  V4_EXECUTION_AUDIT_PATH,
  V4_EXECUTION_STATE_PATH,
  assertV4ExecutionPlatformBoundary,
  v4LoadManagedTradingState,
  v4VerifyTradingAuditLedger,
} from "./execution-gateway.mjs";
import { PROJECT_ROOT } from "./context.mjs";
import { readJson } from "./utils.mjs";

export const EXECUTION_PLATFORM_CONFIG_PATH = path.join(PROJECT_ROOT, "experiments", "v4-range-mean-reversion", "execution-platform.json");

async function exists(value) {
  try { await fs.access(value); return true; } catch { return false; }
}

export async function runV4ExecutionPreflight({ enabled = true, credentials, fetchImpl = fetch, now = Date.now(), persist = true } = {}) {
  const [{ governed, domain, authorization }, config] = await Promise.all([
    assertV4ExecutionPlatformBoundary(),
    readJson(EXECUTION_PLATFORM_CONFIG_PATH),
  ]);
  const snapshot = await snapshotV4DemoAccount({ enabled, credentials, fetchImpl, now, persist });
  const credentialReady = snapshot.status === "READ_ONLY_ACCOUNT_SNAPSHOT";
  const accountModeReady = credentialReady && snapshot.accountMode?.multiAssetsMargin === false && snapshot.accountMode?.dualSidePosition === false;
  const accountClean = credentialReady && snapshot.openPositionCount === 0 && snapshot.standardOpenOrderCount === 0 && snapshot.algoOpenOrderCount === 0;
  const state = await v4LoadManagedTradingState();
  const auditExists = await exists(V4_EXECUTION_AUDIT_PATH);
  const audit = auditExists ? await v4VerifyTradingAuditLedger() : { status: "EMPTY_VALID", recordCount: 0, errors: [] };
  const strategyActivated = governed.strategyExecutionActivationStatus === "ACTIVE_OWNER_AUTHORIZED_V4_STRATEGY" && domain.matchingEngineOrderSubmissionAllowed === true;
  const errors = [];
  if (!credentialReady) errors.push(snapshot.status);
  if (credentialReady && !accountModeReady) errors.push("V4_ACCOUNT_MODE_NOT_ONE_WAY_SINGLE_ASSET");
  if (credentialReady && !accountClean && !strategyActivated) errors.push("V4_ACCOUNT_NOT_CLEAN_BEFORE_STRATEGY_ACTIVATION");
  if (audit.status !== "VALID" && audit.status !== "EMPTY_VALID") errors.push("V4_AUDIT_LEDGER_INVALID");
  return {
    schemaVersion: 1,
    status: errors.length ? "V4_EXECUTION_PLATFORM_AWAITING_SETUP" : strategyActivated ? "READY_FOR_OWNER_AUTHORIZED_V4_STRATEGY_EXECUTION" : "V4_EXECUTION_PLATFORM_READY_STRATEGY_FAIL_CLOSED",
    checkedAt: new Date(now).toISOString(),
    errors,
    authorizationId: authorization.id,
    runtimeId: config.runtimeId,
    credentialReady,
    accountCanTrade: snapshot.accountCanTrade === true,
    accountModeReady,
    accountClean,
    accountMode: snapshot.accountMode ?? null,
    accountEquity: snapshot.accountEquity ?? null,
    openPositionCount: snapshot.openPositionCount ?? 0,
    standardOpenOrderCount: snapshot.standardOpenOrderCount ?? 0,
    algoOpenOrderCount: snapshot.algoOpenOrderCount ?? 0,
    hardRisk: config.hardRisk,
    executionSafety: config.executionSafety,
    strategyActivation: {
      status: governed.strategyExecutionActivationStatus,
      activeExecutionStrategyRevision: governed.activeExecutionStrategyRevision ?? null,
      matchingEngineOrderSubmissionAllowed: domain.matchingEngineOrderSubmissionAllowed === true,
      residentStrategyScannerAllowed: governed.residentScannerAllowed === true,
    },
    localState: {
      path: path.relative(PROJECT_ROOT, V4_EXECUTION_STATE_PATH),
      managedPositionCount: Object.keys(state?.managedPositions ?? {}).length,
      closedPositionCount: Array.isArray(state?.closedPositions) ? state.closedPositions.length : 0,
      pendingOperationCount: Object.keys(state?.pendingOperations ?? {}).length,
    },
    audit,
    v3CredentialRuntimeOrLedgerReused: false,
    productionHostUsed: false,
    realOrdersSubmitted: 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await runV4ExecutionPreflight(), null, 2)}\n`);
}
