import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./runtime-utils.mjs";
import {
  v4ReconcileManagedFeeEvidence,
  v4RecoverPendingTradingOperations,
} from "../../../experiments/v4-range-mean-reversion/src/execution-gateway.mjs";
import { executeV4AutomaticCycle, executeV4CausalManagementTick } from "./auto-executor.mjs";
import { V4_LATEST_PATH, V4_PID_PATH, V4_RUNTIME_ROOT, scanV4Once } from "./snapshot.mjs";
import { loadMtfxR20Context } from "./context.mjs";
import { V4CausalBboFeed } from "./execution-parity.mjs";
import { V4RealtimeDemoMarketClient } from "./market-client.mjs";

const intervalMs = 60_000;
const processStartedAt = new Date().toISOString();
let stopping = false;
let feed = null;
let latestSnapshot = null;
const lastTickAt = new Map();

export function createLatestQuoteScheduler(handler) {
  const latestBySymbol = new Map();
  const inFlight = new Set();
  const drain = async (symbol) => {
    if (inFlight.has(symbol)) return;
    inFlight.add(symbol);
    try {
      while (latestBySymbol.has(symbol)) {
        const quote = latestBySymbol.get(symbol);
        latestBySymbol.delete(symbol);
        await handler(quote);
      }
    } finally {
      inFlight.delete(symbol);
      if (latestBySymbol.has(symbol)) void drain(symbol);
    }
  };
  return {
    push(quote) { latestBySymbol.set(quote.symbol, quote); void drain(quote.symbol); },
    pendingCount() { return latestBySymbol.size + inFlight.size; },
  };
}

async function writePid(status, detail = {}) {
  await writeJsonAtomic(V4_PID_PATH, { schemaVersion: 1, pid: process.pid, status, startedAt: processStartedAt, ...detail });
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  feed?.stop();
  await writePid("STOPPED", { stoppedAt: new Date().toISOString(), signal }).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  await writePid("STARTING");
  const { config } = await loadMtfxR20Context();
  let marketClient;
  if (config.executionParity?.causalBboRequired === true) {
    const quoteScheduler = createLatestQuoteScheduler(async (quote) => {
      await executeV4CausalManagementTick(latestSnapshot, quote, { client: marketClient, now: quote.receivedAt }).catch(async (error) => {
        await writePid("DEGRADED_FAIL_CLOSED", { lastCausalManagementErrorAt: new Date().toISOString(), lastError: error?.message ?? String(error) }).catch(() => {});
      });
    });
    feed = new V4CausalBboFeed({
      symbols: config.universe.symbols,
      onQuote: async (quote) => {
        if (!latestSnapshot?.positions?.some((row) => row.symbol === quote.symbol)) return;
        if (quote.receivedAt - Number(lastTickAt.get(quote.symbol) ?? 0) < 100) return;
        lastTickAt.set(quote.symbol, quote.receivedAt);
        quoteScheduler.push(quote);
      },
    }).start();
    await feed.waitForCoverage(15_000);
    await feed.persistLatest();
    marketClient = new V4RealtimeDemoMarketClient({ feed });
  }
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const recovery = await v4RecoverPendingTradingOperations({ now: startedAt, clock: Date.now });
      if (recovery.status !== "PENDING_OPERATION_RECOVERY_COMPLETE") throw new Error(`V4_PENDING_RECOVERY_FAILED_${recovery.errors.map((row) => `${row.symbol}:${row.error}`).join("|")}`);
      const fee = await v4ReconcileManagedFeeEvidence({ now: Date.now() }).catch((error) => ({ status: "DEFERRED", changeCount: 0, error: error?.message ?? String(error) }));
      let snapshot = await scanV4Once({ client: marketClient });
      latestSnapshot = snapshot;
      const execution = await executeV4AutomaticCycle(snapshot, { client: marketClient });
      if (execution.mutations > 0) snapshot = await scanV4Once({ client: marketClient });
      snapshot.abnormalLossGate = execution.abnormalLossGate ?? snapshot.abnormalLossGate ?? null;
      await writeJsonAtomic(V4_LATEST_PATH, snapshot);
      latestSnapshot = snapshot;
      await feed?.persistLatest();
      await writePid(execution.positionManagementDegraded ? "DEGRADED_FAIL_CLOSED" : "RUNNING", {
        lastSuccessfulScanAt: snapshot.scannedAt,
        accountObservedAt: snapshot.accountObservedAt,
        planCount: snapshot.planCount,
        economicPrequalifiedCount: snapshot.economicPrequalifiedCount,
        broadUniverseSize: snapshot.system?.broadUniverseSize,
        structuralDiscoveryPerformedThisCycle: snapshot.system?.structuralDiscoveryPerformedThisCycle,
        lastStructuralDiscoveryAt: snapshot.system?.lastStructuralDiscoveryAt,
        nextStructuralDiscoveryAt: snapshot.system?.nextStructuralDiscoveryAt,
        eligibleRangeCount: snapshot.eligibleRangeCount,
        confirmedSignalCount: snapshot.confirmedSignalCount,
        openPositionCount: snapshot.risk.openPositionCount,
        protectedPositionCount: snapshot.risk.protectedPositionCount,
        executionReconciliationStatus: snapshot.executionReconciliation.status,
        executionReconciliationErrors: snapshot.executionReconciliation.errors,
        recoveredPendingOperationCount: recovery.recovered.length,
        feeReconciliationStatus: fee.status,
        feeEvidenceChangesInLastCycle: fee.changeCount,
        automaticExecutionStatus: execution.status,
        automaticMutationsInLastCycle: execution.mutations,
        abnormalLossGateStatus: snapshot.abnormalLossGate?.status ?? "UNKNOWN",
        abnormalLossGateEntriesBlocked: snapshot.abnormalLossGate?.entriesBlocked === true,
        lastError: execution.lastError,
        causalBboStatus: feed ? "LIVE_STRICT_UPDATE_ID_DUAL_CLOCK" : "LEGACY_REST_SCAN_ONLY",
        causalBboCoverageCount: feed?.quotes?.size ?? 0,
      });
    } catch (error) {
      await writePid("DEGRADED_FAIL_CLOSED", { lastFailedScanAt: new Date().toISOString(), lastError: error?.message ?? String(error) }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, intervalMs - (Date.now() - startedAt))));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await run();
}
