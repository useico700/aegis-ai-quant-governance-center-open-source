import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./runtime-utils.mjs";
import { V4_RUNTIME_ROOT } from "./snapshot.mjs";

export const V4_SUPERVISOR_PID_PATH = path.join(V4_RUNTIME_ROOT, "supervisor.pid.json");
export const V4_SUPERVISOR_STOP_PATH = path.join(V4_RUNTIME_ROOT, "supervisor.stop.json");
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "resident-scan.mjs");
const STATE_PATH = path.join(V4_RUNTIME_ROOT, "state.json");
const SCANNER_PID_PATH = path.join(V4_RUNTIME_ROOT, "scanner.pid.json");
const WATCHDOG_INTERVAL_MS = 2_000;
const UNPROTECTED_ENTRY_LIMIT_MS = 20_000;
const CAUSAL_BBO_DEGRADED_LIMIT_MS = 20_000;
let child = null;
let stopping = false;

async function requested() { try { await fsp.access(V4_SUPERVISOR_STOP_PATH); return true; } catch { return false; } }
async function readJson(filePath) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; } }
async function status(value, detail = {}) { await writeJsonAtomic(V4_SUPERVISOR_PID_PATH, { schemaVersion: 1, pid: process.pid, status: value, supervisorMode: "DETACHED_USER_CONTEXT_RESTART_LOOP", updatedAt: new Date().toISOString(), ...detail }); }
async function stop(signal) { if (stopping) return; stopping = true; try { child?.kill("SIGTERM"); } catch {} await status("STOPPED", { signal }).catch(() => {}); }
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  await fsp.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await status("STARTING");
  while (!stopping && !(await requested())) {
    const stdout = fs.openSync(path.join(V4_RUNTIME_ROOT, "scanner.out.log"), "a");
    const stderr = fs.openSync(path.join(V4_RUNTIME_ROOT, "scanner.err.log"), "a");
    child = spawn(process.execPath, [DAEMON], { stdio: ["ignore", stdout, stderr] });
    fs.closeSync(stdout); fs.closeSync(stderr);
    await status("RUNNING", { childPid: child.pid, childStartedAt: new Date().toISOString() });
    let watchdogReason = null;
    const watchdog = setInterval(async () => {
      if (!child?.pid || stopping || watchdogReason) return;
      const now = Date.now();
      const state = await readJson(STATE_PATH);
      const exposedEntry = Object.values(state?.pendingOperations ?? {}).find((operation) =>
        operation?.kind === "ENTRY"
        && operation?.phase === "ENTRY_FILLED"
        && Number.isFinite(Number(operation?.preparedAt))
        && now - Number(operation.preparedAt) > UNPROTECTED_ENTRY_LIMIT_MS);
      const scanner = await readJson(SCANNER_PID_PATH);
      const degradedAt = Date.parse(scanner?.lastFailedScanAt ?? scanner?.lastCausalManagementErrorAt ?? "");
      const staleBbo = scanner?.pid === child.pid
        && scanner?.status === "DEGRADED_FAIL_CLOSED"
        && String(scanner?.lastError ?? "").includes("V4_CAUSAL_BBO_STALE")
        && Number.isFinite(degradedAt)
        && now - degradedAt > CAUSAL_BBO_DEGRADED_LIMIT_MS;
      if (!exposedEntry && !staleBbo) return;
      watchdogReason = exposedEntry ? "UNPROTECTED_ENTRY_RECOVERY_DEADLINE" : "CAUSAL_BBO_STALE_RECOVERY_DEADLINE";
      await status("RESTARTING_FAIL_CLOSED_WATCHDOG", { childPid: child.pid, watchdogReason }).catch(() => {});
      try { child.kill("SIGTERM"); } catch {}
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();
    const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    clearInterval(watchdog);
    child = null;
    if (stopping || await requested()) break;
    await status("RESTARTING_AFTER_UNEXPECTED_EXIT", { lastChildExit: result, watchdogReason });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await status("STOPPED");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
