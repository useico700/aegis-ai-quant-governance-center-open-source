import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "../../orion-v2/paper/runtime-utils.mjs";
import { V3_RUNTIME_ROOT } from "./snapshot.mjs";

export const SUPERVISOR_PID_PATH = path.join(V3_RUNTIME_ROOT, "supervisor.pid.json");
export const SUPERVISOR_STOP_PATH = path.join(V3_RUNTIME_ROOT, "supervisor.stop.json");
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "resident-scan.mjs");
const OUT = path.join(V3_RUNTIME_ROOT, "scanner.out.log");
const ERR = path.join(V3_RUNTIME_ROOT, "scanner.err.log");
const STATE_PATH = path.join(V3_RUNTIME_ROOT, "state.json");
const WATCHDOG_INTERVAL_MS = 2_000;
const UNPROTECTED_ENTRY_LIMIT_MS = 20_000;
let child = null;
let stopping = false;

async function stopRequested() {
  try {
    await fsp.access(SUPERVISOR_STOP_PATH);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; }
}

async function writeStatus(status, detail = {}) {
  await writeJsonAtomic(SUPERVISOR_PID_PATH, {
    schemaVersion: 1,
    pid: process.pid,
    status,
    supervisorMode: "DETACHED_USER_CONTEXT_RESTART_LOOP",
    updatedAt: new Date().toISOString(),
    ...detail,
  });
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child?.pid) {
    try { child.kill("SIGTERM"); } catch {}
  }
  await writeStatus("STOPPED", { signal }).catch(() => {});
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  await fsp.mkdir(V3_RUNTIME_ROOT, { recursive: true });
  await writeStatus("STARTING");
  while (!stopping && !(await stopRequested())) {
    const stdout = fs.openSync(OUT, "a");
    const stderr = fs.openSync(ERR, "a");
    child = spawn(process.execPath, [DAEMON], { stdio: ["ignore", stdout, stderr] });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    await writeStatus("RUNNING", { childPid: child.pid, childStartedAt: new Date().toISOString() });
    let watchdogReason = null;
    const watchdog = setInterval(async () => {
      if (!child?.pid || stopping || watchdogReason) return;
      const state = await readJson(STATE_PATH);
      const now = Date.now();
      const exposedEntry = Object.values(state?.pendingOperations ?? {}).find((operation) =>
        operation?.kind === "ENTRY"
        && operation?.phase === "ENTRY_FILLED"
        && Number.isFinite(Number(operation?.preparedAt))
        && now - Number(operation.preparedAt) > UNPROTECTED_ENTRY_LIMIT_MS);
      if (!exposedEntry) return;
      watchdogReason = "UNPROTECTED_ENTRY_RECOVERY_DEADLINE";
      await writeStatus("RESTARTING_FAIL_CLOSED_WATCHDOG", { childPid: child.pid, watchdogReason }).catch(() => {});
      try { child.kill("SIGTERM"); } catch {}
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();
    const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    clearInterval(watchdog);
    child = null;
    if (stopping || await stopRequested()) break;
    await writeStatus("RESTARTING_AFTER_UNEXPECTED_EXIT", { lastChildExit: result, watchdogReason });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await writeStatus("STOPPED");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
