import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJson } from "./runtime-utils.mjs";
import { GOVERNANCE_PATH } from "./context.mjs";
import { V4_PID_PATH, V4_RUNTIME_ROOT } from "./snapshot.mjs";
import { V4_SUPERVISOR_PID_PATH, V4_SUPERVISOR_STOP_PATH } from "./supervisor.mjs";

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "supervisor.mjs");
function alive(pid) { if (!(Number(pid) > 0)) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }

async function status() {
  const record = await readJson(V4_PID_PATH, {});
  const supervisor = await readJson(V4_SUPERVISOR_PID_PATH, {});
  return { ...record, alive: alive(record.pid), supervisorAlive: alive(supervisor.pid), supervisorPid: supervisor.pid ?? null, supervisorStatus: supervisor.status ?? null, supervisorMode: supervisor.supervisorMode ?? null };
}

async function start() {
  const governance = await readJson(GOVERNANCE_PATH, {});
  if (governance.orionV4OwnerStop?.automaticRestartAllowed === false ||
      governance.orionV4RangeResearch?.residentScannerAllowed !== true ||
      governance.executionDomains?.orionV4RangeResearch?.residentScannerAllowed !== true) {
    throw new Error("V4_STOPPED_BY_OWNER_RESTART_REQUIRES_NEW_AUTHORIZATION");
  }
  let current = await status();
  if (current.alive && current.supervisorAlive) return { status: "ALREADY_RUNNING", ...current };
  if (current.supervisorAlive) {
    for (let attempt = 0; attempt < 120; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 250)); current = await status(); if (current.alive) return { status: "SUPERVISOR_RECOVERED_CHILD", ...current }; }
    throw new Error("ORION_V4_SUPERVISOR_ALIVE_WITHOUT_CHILD");
  }
  if (current.alive) process.kill(Number(current.pid), "SIGTERM");
  await fsp.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await fsp.unlink(V4_SUPERVISOR_STOP_PATH).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const supervisor = spawn(process.execPath, [SUPERVISOR], { detached: true, stdio: "ignore" });
  supervisor.unref();
  for (let attempt = 0; attempt < 120; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 250)); const next = await status(); if (next.alive && ["RUNNING", "DEGRADED_FAIL_CLOSED"].includes(next.status)) return { status: "STARTED", ...next }; }
  throw new Error("ORION_V4_SCANNER_START_TIMEOUT");
}

async function stop() {
  const current = await status();
  if (!current.alive && !current.supervisorAlive) return { status: "ALREADY_STOPPED", ...current };
  await fsp.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await fsp.writeFile(V4_SUPERVISOR_STOP_PATH, `${JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: "ORION_V4_CONTROL" })}\n`);
  if (current.alive) process.kill(Number(current.pid), "SIGTERM");
  if (current.supervisorAlive) process.kill(Number(current.supervisorPid), "SIGTERM");
  return { status: "STOP_SIGNAL_SENT", pid: current.pid ?? null, supervisorPid: current.supervisorPid ?? null };
}

const command = process.argv[2] ?? "status";
const result = command === "start" ? await start() : command === "stop" ? await stop() : await status();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
