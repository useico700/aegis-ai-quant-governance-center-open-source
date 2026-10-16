import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SELF = fileURLToPath(import.meta.url);
const NODE_BIN = process.execPath;
const WORKSPACE = process.env.AGENT_MEMORY_WORKSPACE || resolve(dirname(SELF), "..");
const RUNTIME = process.env.AGENT_MEMORY_RUNTIME || resolve(WORKSPACE, ".runtime/agent-memory");
const MEMORY_ROOT = process.env.AGENT_MEMORY_ROOT || resolve(WORKSPACE, "memory");
const CLI = process.env.AGENT_MEMORY_CLI || resolve(WORKSPACE, "scripts/agent-memory.mjs");
const PID_PATH = `${RUNTIME}/resident.pid.json`;
const OUT_PATH = `${RUNTIME}/logs/source-sync.out.log`;
const ERR_PATH = `${RUNTIME}/logs/source-sync.err.log`;
const INTERVAL_MS = 15 * 60_000;

function readPid() {
  try {
    return Number(JSON.parse(readFileSync(PID_PATH, "utf8"))?.pid) || null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, filePath);
}

function log(value) {
  writeFileSync(OUT_PATH, `${JSON.stringify({ ...value, occurredAt: new Date().toISOString() })}\n`, { flag: "a" });
}

function runCommand(command) {
  const result = spawnSync(NODE_BIN, [CLI, ...command], {
    cwd: WORKSPACE,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      AGENT_MEMORY_WORKSPACE: WORKSPACE,
      AGENT_MEMORY_ROOT: MEMORY_ROOT,
    },
  });
  log({
    event: `MEMORY_${command[0].toUpperCase()}`,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim().slice(-2000),
    stderr: result.stderr?.trim().slice(-2000),
  });
  return result.status === 0;
}

mkdirSync(RUNTIME, { recursive: true });
mkdirSync(`${RUNTIME}/logs`, { recursive: true });

if (process.argv.includes("--detach")) {
  const existing = readPid();
  if (alive(existing)) {
    process.stdout.write(`${JSON.stringify({ status: "already_running", pid: existing })}\n`);
    process.exit(0);
  }
  const outFd = openSync(OUT_PATH, "a");
  const errFd = openSync(ERR_PATH, "a");
  const child = spawn(NODE_BIN, [SELF, "--run"], {
    cwd: RUNTIME,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: process.env,
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  process.stdout.write(`${JSON.stringify({ status: "started", pid: child.pid })}\n`);
  process.exit(0);
}

if (!process.argv.includes("--run")) {
  process.stdout.write(`${JSON.stringify({ pid: readPid(), alive: alive(readPid()), intervalMs: INTERVAL_MS })}\n`);
  process.exit(0);
}

writeJsonAtomic(PID_PATH, { pid: process.pid, startedAt: new Date().toISOString(), intervalMs: INTERVAL_MS });
log({ event: "MEMORY_SOURCE_SYNC_RESIDENT_ACTIVE", pid: process.pid, intervalMs: INTERVAL_MS });

let stopping = false;
let interruptWait = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    interruptWait?.();
  });
}

while (!stopping) {
  const checkpointed = runCommand(["checkpoint", "all"]);
  const verified = checkpointed && runCommand(["verify"]);
  if (verified) runCommand(["archive"]);
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, INTERVAL_MS);
    interruptWait = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  interruptWait = null;
}

try {
  if (readPid() === process.pid) unlinkSync(PID_PATH);
} catch {}
log({ event: "MEMORY_SOURCE_SYNC_RESIDENT_STOPPED", pid: process.pid });
