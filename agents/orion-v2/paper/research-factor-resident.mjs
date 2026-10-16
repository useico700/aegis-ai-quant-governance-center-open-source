import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mineFactorSnapshot } from "./research-factor-miner.mjs";
import { readJson, sleep, writeJsonAtomic } from "./runtime-utils.mjs";

const PAPER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(PAPER_ROOT, "../../../.runtime/orion-v2-mtfx/research");
const PID_PATH = path.join(RUNTIME_ROOT, "factor-miner.pid.json");
const STATE_PATH = path.join(RUNTIME_ROOT, "factor-resident-state.json");
const LOG_PATH = path.join(RUNTIME_ROOT, "factor-resident.log");
const ERROR_PATH = path.join(RUNTIME_ROOT, "factor-resident-error.log");
const INTERVAL_MS = 60_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function status() {
  const [pidRecord, state] = await Promise.all([readJson(PID_PATH, {}), readJson(STATE_PATH, {})]);
  const pid = Number(pidRecord.pid);
  return { process: "ORION_V2_FACTOR_MINER", pid: Number.isInteger(pid) ? pid : null, alive: alive(pid), state };
}

async function detach() {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  const prior = await readJson(PID_PATH, {});
  if (alive(Number(prior.pid))) return { status: "already_running", ...(await status()) };
  const outFd = openSync(LOG_PATH, "a");
  const errFd = openSync(ERROR_PATH, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run"], {
    cwd: PAPER_ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: { PATH: process.env.PATH ?? "" },
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  await writeJsonAtomic(PID_PATH, { schemaVersion: 1, pid: child.pid, startedAt: new Date().toISOString() });
  await sleep(500);
  return { status: "started", ...(await status()) };
}

async function run() {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  await writeJsonAtomic(PID_PATH, { schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() });
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  while (!stopping) {
    const checkedAt = Date.now();
    try {
      const result = await mineFactorSnapshot({ now: checkedAt });
      await writeJsonAtomic(STATE_PATH, { schemaVersion: 1, health: "HEALTHY", checkedAt: new Date(checkedAt).toISOString(), result, executionUse: "OBSERVE_ONLY" });
    } catch (error) {
      await writeJsonAtomic(STATE_PATH, { schemaVersion: 1, health: "DEGRADED", checkedAt: new Date(checkedAt).toISOString(), error: error.message, executionUse: "OBSERVE_ONLY" });
    }
    await sleep(INTERVAL_MS);
  }
}

const command = process.argv[2] ?? "--status";
if (command === "--detach") process.stdout.write(`${JSON.stringify(await detach(), null, 2)}\n`);
else if (command === "--status") process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
else if (command === "--run") await run();
else {
  process.stderr.write("Usage: research-factor-resident.mjs --detach|--status|--run\n");
  process.exitCode = 2;
}
