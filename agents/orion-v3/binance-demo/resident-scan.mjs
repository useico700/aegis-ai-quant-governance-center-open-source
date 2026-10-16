import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../orion-v2/paper/runtime-utils.mjs";
import { reconcileManagedFeeEvidence, recoverPendingTradingOperations } from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";
import { V3_LATEST_PATH, V3_PID_PATH, V3_RUNTIME_ROOT, scanV3Once } from "./snapshot.mjs";
import { executeV3AutomaticCycle } from "./auto-executor.mjs";
import { publishCurrentV3Equity } from "./equity-publisher.mjs";

const intervalMs = 60_000;
const processStartedAt = new Date().toISOString();
const repairRevision = "V3-HF14-SINGLE-Z-PRESERVING-INTEGRITY-REPAIR-20260914";
let loadedSourceHashes = {};
let stopping = false;

async function writePid(status, detail = {}) {
  await writeJsonAtomic(V3_PID_PATH, {
    schemaVersion: 1,
    pid: process.pid,
    status,
    startedAt: processStartedAt,
    repairRevision,
    loadedSourceHashes,
    ...detail,
  });
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  await writePid("STOPPED", { stoppedAt: new Date().toISOString(), signal }).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  const sources = ["./dual-z.mjs", "./release-policy.mjs", "./snapshot.mjs", "./preflight.mjs", "./resident-scan.mjs", "./auto-executor.mjs", "./high-frequency-strategy.mjs", "./equity-curve.mjs", "./equity-publisher.mjs", "./integrity-repair.mjs", "../../../integrations/binance-usdm-testnet/trading-gateway.mjs", "../../shared/abnormal-loss-gate.mjs"];
  loadedSourceHashes = Object.fromEntries(await Promise.all(sources.map(async (source) => [source, createHash("sha256").update(await fs.readFile(new URL(source, import.meta.url))).digest("hex")])));
  await writePid("STARTING");
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const recovery = await recoverPendingTradingOperations({ now: startedAt, clock: Date.now }).catch((error) => ({
        status: "PENDING_OPERATION_RECOVERY_FAIL_CLOSED",
        recovered: [],
        errors: [{ symbol: null, error: error?.message ?? String(error) }],
      }));
      const recoveryError = recovery.status === "PENDING_OPERATION_RECOVERY_COMPLETE"
        ? null
        : `V3_PENDING_OPERATION_RECOVERY_FAILED_${recovery.errors.map((row) => `${row.symbol ?? "UNKNOWN"}:${row.error}`).join("|")}`;
      const feeReconciliation = recoveryError ? {
        status: "BINANCE_DEMO_FEE_EVIDENCE_RECONCILIATION_DEFERRED_BY_RECOVERY_FAILURE",
        changeCount: 0,
        error: recoveryError,
      } : await reconcileManagedFeeEvidence({ now: Date.now() }).catch((error) => ({
        status: "BINANCE_DEMO_FEE_EVIDENCE_RECONCILIATION_DEFERRED",
        changeCount: 0,
        error: error?.message ?? String(error),
      }));
      let snapshot = await scanV3Once({ now: startedAt });
      const automaticExecution = recoveryError ? {
        status: "V3_PENDING_OPERATION_RECOVERY_FAIL_CLOSED",
        positionManagementDegraded: true,
        mutations: 0,
        lastError: recoveryError,
      } : await executeV3AutomaticCycle(snapshot);
      if (automaticExecution.mutations > 0 || automaticExecution.requiresReconciliation) snapshot = await scanV3Once({ now: Date.now() });
      snapshot.abnormalLossGate = automaticExecution.abnormalLossGate ?? snapshot.abnormalLossGate ?? null;
      await writeJsonAtomic(V3_LATEST_PATH, snapshot);
      const equitySync = await publishCurrentV3Equity({ snapshot }).catch((error) => ({
        status: "SYNC_DEFERRED",
        sourceAsOf: snapshot.accountObservedAt ?? snapshot.scannedAt,
        receivedAt: null,
        error: error?.message ?? String(error),
      }));
      await writePid(automaticExecution.positionManagementDegraded ? "DEGRADED_FAIL_CLOSED" : "RUNNING", {
        implementationRevision: snapshot.implementationRevision,
        evaluationCohortId: snapshot.evaluationCohortId,
        lastSuccessfulScanAt: snapshot.scannedAt,
        accountObservedAt: snapshot.accountObservedAt,
        planCount: snapshot.planCount,
        broadUniverseSize: snapshot.system?.broadUniverseSize,
        structuralDiscoveryPerformedThisCycle: snapshot.system?.structuralDiscoveryPerformedThisCycle,
        lastStructuralDiscoveryAt: snapshot.system?.lastStructuralDiscoveryAt,
        nextStructuralDiscoveryAt: snapshot.system?.nextStructuralDiscoveryAt,
        openPositionCount: snapshot.risk.openPositionCount,
        protectiveAlgoOrderCount: snapshot.risk.protectiveAlgoOrderCount,
        protectedPositionCount: snapshot.risk.protectedPositionCount,
        executionReconciliationStatus: snapshot.executionReconciliation?.status ?? "MISSING",
        executionReconciliationErrors: snapshot.executionReconciliation?.errors ?? [],
        recoveredPendingOperationCount: recovery.recovered.length,
        pendingOperationRecoveryStatus: recovery.status,
        pendingOperationRecoveryErrors: recovery.errors,
        feeReconciliationStatus: feeReconciliation.status,
        feeEvidenceChangesInLastCycle: feeReconciliation.changeCount,
        feeReconciliationError: feeReconciliation.error ?? null,
        automaticExecutionStatus: automaticExecution.status,
        automaticMutationsInLastCycle: automaticExecution.mutations,
        abnormalLossGateStatus: snapshot.abnormalLossGate?.status ?? "UNKNOWN",
        abnormalLossGateEntriesBlocked: snapshot.abnormalLossGate?.entriesBlocked === true,
        lastError: recoveryError ?? automaticExecution.lastError,
        equitySyncStatus: equitySync.status,
        equitySourceAsOf: equitySync.sourceAsOf,
        equityReceivedAt: equitySync.receivedAt,
        equitySyncError: equitySync.error ?? null,
      });
    } catch (error) {
      await writePid("DEGRADED_FAIL_CLOSED", {
        lastFailedScanAt: new Date().toISOString(),
        lastError: error?.message ?? String(error),
      }).catch(() => {});
    }
    const remaining = Math.max(1_000, intervalMs - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(V3_RUNTIME_ROOT, { recursive: true });
  await run();
}
