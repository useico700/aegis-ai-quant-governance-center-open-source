import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJson } from "../../orion-v2/paper/runtime-utils.mjs";
import { V3_PID_PATH, V3_RUNTIME_ROOT } from "./snapshot.mjs";
import { SUPERVISOR_PID_PATH, SUPERVISOR_STOP_PATH } from "./supervisor.mjs";

const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "supervisor.mjs");
const LAUNCHD_DOMAIN = `gui/${process.getuid()}`;
const LAUNCHD_LABEL = `${LAUNCHD_DOMAIN}/com.codex.orion-v3-binance-demo-scanner`;

function alive(pid) {
  if (!(Number(pid) > 0)) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function status() {
  const record = await readJson(V3_PID_PATH, {});
  const supervisor = await readJson(SUPERVISOR_PID_PATH, {});
  let supervisorLoaded = false;
  try {
    execFileSync("/bin/launchctl", ["print", LAUNCHD_LABEL], { stdio: "ignore" });
    supervisorLoaded = true;
  } catch {}
  return { ...record, alive: alive(record.pid), supervisorAlive: alive(supervisor.pid), supervisorPid: supervisor.pid ?? null, supervisorStatus: supervisor.status ?? null, supervisorMode: supervisor.supervisorMode ?? null, launchdSupervisorLoaded: supervisorLoaded, supervisorLabel: LAUNCHD_LABEL };
}

async function start() {
  let current = await status();
  if (current.alive && current.supervisorAlive) return { status: "ALREADY_RUNNING", ...current };
  if (current.supervisorAlive) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await status();
      if (current.alive && current.supervisorAlive) return { status: "SUPERVISOR_RECOVERED_CHILD", ...current };
    }
    throw new Error("ORION_V3_SUPERVISOR_ALIVE_WITHOUT_RECOVERED_CHILD");
  }
  if (current.alive) {
    process.kill(Number(current.pid), "SIGTERM");
    for (let attempt = 0; attempt < 40 && alive(current.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (alive(current.pid)) throw new Error("ORION_V3_ORPHAN_SCANNER_STOP_TIMEOUT");
  }
  await fsp.mkdir(V3_RUNTIME_ROOT, { recursive: true });
  if (current.launchdSupervisorLoaded) {
    try { execFileSync("/bin/launchctl", ["bootout", LAUNCHD_LABEL], { stdio: "ignore" }); } catch {}
  }
  await fsp.unlink(SUPERVISOR_STOP_PATH).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const supervisor = spawn(process.execPath, [SUPERVISOR], { detached: true, stdio: "ignore" });
  supervisor.unref();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const next = await status();
    if (next.alive && ["RUNNING", "DEGRADED_FAIL_CLOSED"].includes(next.status)) return { status: "STARTED", ...next };
  }
  throw new Error("ORION_V3_SCANNER_START_TIMEOUT");
}

async function stop() {
  const current = await status();
  if (!current.alive && !current.supervisorAlive) return { status: "ALREADY_STOPPED", ...current };
  await fsp.mkdir(V3_RUNTIME_ROOT, { recursive: true });
  await fsp.writeFile(SUPERVISOR_STOP_PATH, `${JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: "ORION_V3_CONTROL" })}\n`);
  if (current.alive) process.kill(Number(current.pid), "SIGTERM");
  if (current.supervisorAlive) process.kill(Number(current.supervisorPid), "SIGTERM");
  return { status: "STOP_SIGNAL_SENT", pid: current.pid ?? null, supervisorPid: current.supervisorPid ?? null };
}

const command = process.argv[2] ?? "status";
const result = command === "start" ? await start() : command === "stop" ? await stop() : await status();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
