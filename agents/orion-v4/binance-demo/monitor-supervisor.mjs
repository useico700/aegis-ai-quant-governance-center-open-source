import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./runtime-utils.mjs";
import { V4_RUNTIME_ROOT } from "./snapshot.mjs";

export const V4_MONITOR_SUPERVISOR_PID_PATH = path.join(V4_RUNTIME_ROOT, "monitor-supervisor.pid.json");
export const V4_MONITOR_SUPERVISOR_STOP_PATH = path.join(V4_RUNTIME_ROOT, "monitor-supervisor.stop.json");
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "monitor-resident.mjs");
let child = null;
let stopping = false;

async function stopRequested() { try { await fsp.access(V4_MONITOR_SUPERVISOR_STOP_PATH); return true; } catch { return false; } }
async function writeStatus(status, detail = {}) { await writeJsonAtomic(V4_MONITOR_SUPERVISOR_PID_PATH, { schemaVersion: 1, pid: process.pid, status, role: "READ_ONLY_V4_MONITOR_SUPERVISOR", updatedAt: new Date().toISOString(), ...detail }); }
async function stop(signal) { if (stopping) return; stopping = true; try { child?.kill("SIGTERM"); } catch {} await writeStatus("STOPPED", { signal }).catch(() => {}); }

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  await fsp.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await writeStatus("STARTING");
  while (!stopping && !(await stopRequested())) {
    const stdout = fs.openSync(path.join(V4_RUNTIME_ROOT, "monitor.out.log"), "a");
    const stderr = fs.openSync(path.join(V4_RUNTIME_ROOT, "monitor.err.log"), "a");
    child = spawn(process.execPath, [DAEMON], { stdio: ["ignore", stdout, stderr] });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    await writeStatus("RUNNING", { childPid: child.pid, childStartedAt: new Date().toISOString() });
    const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child = null;
    if (stopping || await stopRequested()) break;
    await writeStatus("RESTARTING_AFTER_UNEXPECTED_EXIT", { lastChildExit: result });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await writeStatus("STOPPED");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
