import fs from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATHS, RUNTIME_ROOT } from "./paper-daemon.mjs";
import { readJson, sleep, writeJsonAtomic } from "./runtime-utils.mjs";

const PAPER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_PATH = path.join(PAPER_ROOT, "control.mjs");
const SUPERVISOR_PID_PATH = path.join(RUNTIME_ROOT, "health-supervisor.pid.json");
const SUPERVISOR_STATE_PATH = path.join(RUNTIME_ROOT, "health-supervisor-state.json");
const SUPERVISOR_LOG_PATH = path.join(RUNTIME_ROOT, "health-supervisor.log");
const SUPERVISOR_ERROR_PATH = path.join(RUNTIME_ROOT, "health-supervisor-error.log");
const CHECK_INTERVAL_MS = 15_000;
const RATE_WINDOW_MS = 30 * 60_000;
const MAX_RECOVERIES_PER_WINDOW = 3;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function appendLog(event) {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  await fs.appendFile(SUPERVISOR_LOG_PATH, `${JSON.stringify({ ...event, occurredAt: new Date().toISOString() })}\n`);
}

async function snapshot() {
  const [runtime, pidRecord, latest, state, killSwitch, supervisorState] = await Promise.all([
    readJson(PATHS.runtimeConfig, {}),
    readJson(PATHS.pid, {}),
    readJson(PATHS.latest, {}),
    readJson(PATHS.state, {}),
    readJson(PATHS.killSwitch, {}),
    readJson(SUPERVISOR_STATE_PATH, {}),
  ]);
  const now = Date.now();
  const daemonPid = Number(pidRecord.pid);
  const heartbeatAgeMs = Number.isFinite(Number(latest.heartbeatAt)) ? Math.max(0, now - Number(latest.heartbeatAt)) : null;
  const scanAgeMs = Number.isFinite(Number(latest.lastSuccessfulScanAt)) ? Math.max(0, now - Number(latest.lastSuccessfulScanAt)) : null;
  const websocketAgeMs = Number.isFinite(Number(latest.websocket?.lastEventAt)) ? Math.max(0, now - Number(latest.websocket.lastEventAt)) : null;
  const heartbeatLimitMs = Math.max(Number(runtime.marketData?.heartbeatMs || 5000) * 6, 45_000);
  const scanLimitMs = Math.max(Number(runtime.marketData?.scanIntervalMs || 60_000) * 4, 5 * 60_000);
  const websocketLimitMs = 60_000;
  const recentRateLimit = (state.scanErrors ?? []).filter((error) => /PUBLIC_HTTP_(418|429)/.test(String(error.message)) && now - Number(error.at) <= RATE_LIMIT_COOLDOWN_MS).at(-1) ?? null;
  const faults = [];
  if (!isAlive(daemonPid)) faults.push("DAEMON_DEAD");
  if (heartbeatAgeMs === null || heartbeatAgeMs > heartbeatLimitMs) faults.push("HEARTBEAT_STALE");
  if (scanAgeMs === null || scanAgeMs > scanLimitMs) faults.push("SCAN_STALE");
  if (latest.websocket?.connected !== true || websocketAgeMs === null || websocketAgeMs > websocketLimitMs) faults.push("WEBSOCKET_UNHEALTHY");
  return { now, runtime, daemonPid, pidRecord, latest, state, killSwitch, supervisorState, heartbeatAgeMs, scanAgeMs, websocketAgeMs, heartbeatLimitMs, scanLimitMs, websocketLimitMs, recentRateLimit, faults };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(250);
  return !isAlive(pid);
}

async function waitForHealthyStart(priorPid, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pidRecord, latest] = await Promise.all([readJson(PATHS.pid, {}), readJson(PATHS.latest, {})]);
    const pid = Number(pidRecord.pid);
    const heartbeatAgeMs = Number.isFinite(Number(latest.heartbeatAt)) ? Date.now() - Number(latest.heartbeatAt) : Infinity;
    if (pid !== priorPid && isAlive(pid) && heartbeatAgeMs <= 20_000 && latest.websocket?.connected === true) {
      return { verified: true, pid, heartbeatAgeMs };
    }
    await sleep(500);
  }
  return { verified: false, pid: Number((await readJson(PATHS.pid, {})).pid) || null };
}

async function recover(health, supervisorState) {
  const history = (supervisorState.recoveries ?? []).filter((value) => health.now - Number(value.at) <= RATE_WINDOW_MS);
  if (history.length >= MAX_RECOVERIES_PER_WINDOW) {
    await appendLog({ event: "MTFX_RECOVERY_RATE_LIMITED", faults: health.faults, recoveriesInWindow: history.length });
    return { ...supervisorState, health: "RECOVERY_RATE_LIMITED", consecutiveFailures: supervisorState.consecutiveFailures, recoveries: history };
  }
  if (isAlive(health.daemonPid)) {
    process.kill(health.daemonPid, "SIGUSR2");
    const exited = await waitForExit(health.daemonPid, 8_000);
    if (!exited && isAlive(health.daemonPid)) {
      process.kill(health.daemonPid, "SIGKILL");
      await waitForExit(health.daemonPid, 2_000);
    }
  }
  const output = execFileSync(process.execPath, [CONTROL_PATH, "recover"], {
    cwd: PAPER_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = await waitForHealthyStart(health.daemonPid);
  const event = { at: Date.now(), priorPid: health.daemonPid, faults: health.faults };
  history.push(event);
  await appendLog({ event: "MTFX_PAPER_AUTOMATIC_RECOVERY", ...event, controlResult: JSON.parse(output).status, healthyStartVerified: started.verified, newPid: started.pid });
  return { ...supervisorState, health: started.verified ? "RECOVERED" : "RECOVERY_START_UNVERIFIED", consecutiveFailures: 0, recoveries: history, lastRecovery: { ...event, healthyStartVerified: started.verified, newPid: started.pid } };
}

export async function checkOnce() {
  const health = await snapshot();
  const previous = health.supervisorState;
  const base = {
    schemaVersion: 1,
    checkedAt: new Date(health.now).toISOString(),
    supervisorPid: process.pid,
    daemonPid: health.daemonPid,
    faults: health.faults,
    heartbeatAgeMs: health.heartbeatAgeMs,
    scanAgeMs: health.scanAgeMs,
    websocketAgeMs: health.websocketAgeMs,
    onlineLedgerStatus: health.latest.onlineLedger?.status ?? null,
    recoveries: previous.recoveries ?? [],
    lastRecovery: previous.lastRecovery ?? null,
  };
  if (health.killSwitch?.engaged !== false) {
    const next = { ...base, health: "OWNER_KILL_SWITCH_NO_RECOVERY", consecutiveFailures: 0 };
    await writeJsonAtomic(SUPERVISOR_STATE_PATH, next);
    return next;
  }
  if (health.recentRateLimit) {
    const next = { ...base, health: "RATE_LIMIT_COOLDOWN_NO_RESTART", consecutiveFailures: 0, rateLimitError: health.recentRateLimit };
    await writeJsonAtomic(SUPERVISOR_STATE_PATH, next);
    return next;
  }
  if (!health.faults.length) {
    const next = { ...base, health: "HEALTHY", consecutiveFailures: 0 };
    await writeJsonAtomic(SUPERVISOR_STATE_PATH, next);
    return next;
  }
  const lastRecoveryAgeMs = health.now - Number(previous.lastRecovery?.at ?? 0);
  if (!health.faults.includes("DAEMON_DEAD") && lastRecoveryAgeMs >= 0 && lastRecoveryAgeMs < 45_000) {
    const next = { ...base, health: "POST_RECOVERY_GRACE", consecutiveFailures: 0, recoveryGraceRemainingMs: 45_000 - lastRecoveryAgeMs };
    await writeJsonAtomic(SUPERVISOR_STATE_PATH, next);
    return next;
  }
  const consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
  const immediate = health.faults.includes("DAEMON_DEAD");
  if (!immediate && consecutiveFailures < 3) {
    const next = { ...base, health: "DEGRADED_CONFIRMING", consecutiveFailures };
    await writeJsonAtomic(SUPERVISOR_STATE_PATH, next);
    return next;
  }
  const recovered = await recover(health, { ...base, consecutiveFailures });
  await writeJsonAtomic(SUPERVISOR_STATE_PATH, recovered);
  return recovered;
}

async function detach() {
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  const prior = await readJson(SUPERVISOR_PID_PATH, {});
  if (isAlive(Number(prior.pid))) return { status: "already_running", pid: Number(prior.pid) };
  const outFd = openSync(SUPERVISOR_LOG_PATH, "a");
  const errFd = openSync(SUPERVISOR_ERROR_PATH, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--run"], {
    cwd: PAPER_ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  await writeJsonAtomic(SUPERVISOR_PID_PATH, { schemaVersion: 1, pid: child.pid, startedAt: new Date().toISOString() });
  return { status: "started", pid: child.pid };
}

const command = process.argv[2] ?? "--status";
if (command === "--detach") {
  process.stdout.write(`${JSON.stringify(await detach(), null, 2)}\n`);
} else if (command === "--once") {
  process.stdout.write(`${JSON.stringify(await checkOnce(), null, 2)}\n`);
} else if (command === "--status") {
  const [pid, state] = await Promise.all([readJson(SUPERVISOR_PID_PATH, {}), readJson(SUPERVISOR_STATE_PATH, {})]);
  process.stdout.write(`${JSON.stringify({ daemon: "MTFX_HEALTH_SUPERVISOR", pid: Number(pid.pid) || null, alive: isAlive(Number(pid.pid)), state }, null, 2)}\n`);
} else if (command === "--run") {
  await writeJsonAtomic(SUPERVISOR_PID_PATH, { schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() });
  await appendLog({ event: "MTFX_HEALTH_SUPERVISOR_ACTIVE", pid: process.pid, intervalMs: CHECK_INTERVAL_MS });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopping) {
    try { await checkOnce(); } catch (error) { await appendLog({ event: "MTFX_HEALTH_SUPERVISOR_ERROR", error: error.message }); }
    await sleep(CHECK_INTERVAL_MS);
  }
  await appendLog({ event: "MTFX_HEALTH_SUPERVISOR_STOPPED", pid: process.pid });
} else {
  process.stderr.write("Usage: health-supervisor.mjs --detach|--run|--once|--status\n");
  process.exitCode = 2;
}
