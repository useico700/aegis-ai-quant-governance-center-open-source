import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProductionCredentials } from "./credentials.mjs";
import { loadConfig, runPreflight } from "./preflight.mjs";
import { processAlive, readJson, sleep, writeJsonAtomic } from "./runtime-utils.mjs";
import { ProductionUserStreamMonitor } from "./user-stream.mjs";
import { openProductionReadAdmission } from '../s2-execution/host-admission.mjs';
import { runCoordinatedReaderHost } from './coordinated-resident.mjs';

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
let stopping = false;
let stream = null;

async function main() {
  const config = await loadConfig(CONFIG_PATH);
  const admission = await openProductionReadAdmission('S2_ACCOUNT_READER');
  const runtimeRoot = process.env.AEGIS_RUNTIME_ROOT || config.runtime.root;
  const pidPath = path.join(runtimeRoot, "resident.pid.json");
  const latestPath = path.join(runtimeRoot, "latest.json");
  await fs.mkdir(runtimeRoot, { recursive: true });
  const previous = await readJson(pidPath, null);
  if (previous?.pid && processAlive(previous.pid)) throw new Error("PRODUCTION_READONLY_SINGLE_WRITER_ALREADY_RUNNING");
  await writeJsonAtomic(pidPath, { pid: process.pid, startedAt: new Date().toISOString(), mode: config.mode });

  let cycleTask = null, shutdownTask = null;
  const shutdown = (signal) => {
    if (shutdownTask) return shutdownTask;
    stopping = true; admission.stop();
    shutdownTask = (async () => {
      // Hard process termination preserves the central crash reservations; it
      // must never be presented as a clean drain or release the owner early.
      const deadline = setTimeout(() => process.exit(2), 35000);
      try {
        await stream?.close();
        await cycleTask?.catch(() => {});
        await admission.close();
        await writeJsonAtomic(latestPath, { ...(await readJson(latestPath, {})), status: "STOPPED", stoppedAt: new Date().toISOString(), signal,
          shutdownDrainCompleted: true, realOrdersAllowed: false, newEntriesBlocked: true });
        await fs.unlink(pidPath);
      } finally { clearTimeout(deadline); }
    })();
    return shutdownTask;
  };
  const handleSignal = (signal) => {
    void shutdown(signal).then(() => process.exit(0), () => process.exit(2));
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  while (!stopping) {
    cycleTask = (async () => {
    const result = await runPreflight({ admission }).catch((error) => ({
      checkedAt: new Date().toISOString(),
      status: "DEGRADED_FAIL_CLOSED",
      error: error?.message ?? "UNKNOWN",
      realOrdersAllowed: false,
      newEntriesBlocked: true,
    }));
    if (stopping) return;
    if (result.status === "READY_READ_ONLY_SHADOW" || result.status === "READ_ONLY_ATTENTION_REQUIRED") {
      if (!stream || stream.status().lastError) {
        await stream?.close().catch(() => {});
        const credentials = await loadProductionCredentials(config);
        if (stopping) return;
        stream = new ProductionUserStreamMonitor(config, credentials, { admission, sharedAccountToken: true });
        await stream.start().catch((error) => { result.userStreamStartError = error?.message ?? "UNKNOWN"; });
      }
      result.userStream = stream?.status() ?? null;
      if (!result.userStream?.connected) {
        result.status = "DEGRADED_FAIL_CLOSED";
        result.newEntriesBlocked = true;
      }
    }
    if (!stopping) await writeJsonAtomic(latestPath, { ...result, requestBudget: admission.status() });
    })();
    try { await cycleTask; } catch (error) { await shutdown('CYCLE_FAILED'); throw error; }
    cycleTask = null;
    for (let waited = 0; waited < config.runtime.cycleIntervalMs && !stopping; waited += 1000) await sleep(1000);
  }
  await shutdown("LOOP_END");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--coordinated') await runCoordinatedReaderHost();
    else if (process.argv.length === 2) await main();
    else throw new Error('PRODUCTION_READER_ARGUMENTS_FORBIDDEN');
  } catch (error) {
    const canceled = error?.message === 'SHADOW_STARTUP_CANCELED';
    process.stdout.write(JSON.stringify({ status: canceled ? 'READ_ONLY_READER_START_CANCELED' : 'READ_ONLY_READER_FAILED',
      reason: canceled ? error.message : 'PRODUCTION_READER_RUNTIME_FAILED', realOrdersAllowed: false, newEntriesBlocked: true }) + '\n');
    process.exitCode = canceled ? 0 : 2;
  }
}
