import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_RUNTIME_ROOT } from "./collector.mjs";
import { readJsonIfPresent, writeJsonAtomic } from "./persistence.mjs";
import { calculateRuntimeSourceHash } from "./runtime-source.mjs";
import { LocalResourceGuard } from "./resource-guard.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PID_PATH = path.join(DEFAULT_RUNTIME_ROOT, "resident.pid.json");

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function start() {
  const existing = await readJsonIfPresent(PID_PATH);
  if (existing?.pid && alive(existing.pid)) return { status: "ALREADY_RUNNING", ...existing };
  const resourceGuard = await LocalResourceGuard.create(DEFAULT_RUNTIME_ROOT);
  if (resourceGuard.status().paused) return { status: "REFUSED_LOCAL_RESOURCE_PAUSED", resource: resourceGuard.status() };
  await fs.mkdir(DEFAULT_RUNTIME_ROOT, { recursive: true });
  const stdout = await fs.open(path.join(DEFAULT_RUNTIME_ROOT, "resident.log"), "a", 0o600);
  const stderr = await fs.open(path.join(DEFAULT_RUNTIME_ROOT, "resident-error.log"), "a", 0o600);
  const child = spawn(process.execPath, [path.join(MODULE_DIR, "resident.mjs")], { cwd: MODULE_DIR, detached: true, stdio: ["ignore", stdout.fd, stderr.fd], env: { PATH: process.env.PATH ?? "" } });
  child.unref();
  await stdout.close(); await stderr.close();
  const runtimeSource = await calculateRuntimeSourceHash();
  const record = { schemaVersion: 1, pid: child.pid, command: `${process.execPath} ${path.join(MODULE_DIR, "resident.mjs")}`, runtimeSourceSha256: runtimeSource.sha256, startedAt: new Date().toISOString(), scope: "ORION_V2_ACCOUNT_SHADOW_C_READ_ONLY_COLLECTOR_AND_PUBLISHER" };
  await writeJsonAtomic(PID_PATH, record);
  return { status: "STARTED", ...record };
}

async function status() {
  const pid = await readJsonIfPresent(PID_PATH);
  const runtimeSource = await calculateRuntimeSourceHash();
  const health = await readJsonIfPresent(path.join(DEFAULT_RUNTIME_ROOT, "resident-health.json"));
  const running = Boolean(pid?.pid && alive(pid.pid));
  const loadedHash = health?.pid === pid?.pid ? health.runtimeSourceSha256 ?? null : null;
  return { status: running ? loadedHash === runtimeSource.sha256 ? "RUNNING_CURRENT_SOURCE" : "RUNNING_SOURCE_MISMATCH" : "STOPPED", expectedRuntimeSourceSha256: runtimeSource.sha256, loadedRuntimeSourceSha256: loadedHash, pid, health, publisher: await readJsonIfPresent(path.join(DEFAULT_RUNTIME_ROOT, "publisher-status.json")) };
}

const command = process.argv[2] ?? "status";
const result = command === "start" ? await start() : command === "status" ? await status() : (() => { throw new Error("USAGE: control.mjs [start|status]"); })();
console.log(JSON.stringify(result, null, 2));
