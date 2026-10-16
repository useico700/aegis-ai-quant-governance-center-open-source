import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAndValidateAuthority, PATHS, RUNTIME_ROOT } from "./paper-daemon.mjs";
import {
  buildPaperStatusReport,
  renderPaperCandidatesMarkdown,
  renderPaperEquityMarkdown,
  renderPaperPanoramaMarkdown,
  renderPaperPositionsMarkdown,
  renderPaperStatusMarkdown,
} from "./report.mjs";
import { readJson, writeJsonAtomic } from "./runtime-utils.mjs";

const PAPER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = path.join(PAPER_ROOT, "paper-daemon.mjs");
const LOG_PATH = path.join(RUNTIME_ROOT, "daemon.log");
const ERROR_PATH = path.join(RUNTIME_ROOT, "daemon-error.log");
const SUPERVISOR_PID_PATH = path.join(RUNTIME_ROOT, "health-supervisor.pid.json");
const SUPERVISOR_STATE_PATH = path.join(RUNTIME_ROOT, "health-supervisor-state.json");

async function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !(await alive(pid));
}

async function status() {
  const [pidRecord, killSwitch, state, latest, runtime, supervisorPidRecord, supervisorState] = await Promise.all([
    readJson(PATHS.pid, null),
    readJson(PATHS.killSwitch, null),
    readJson(PATHS.state, null),
    readJson(PATHS.latest, null),
    readJson(PATHS.runtimeConfig, null),
    readJson(SUPERVISOR_PID_PATH, null),
    readJson(SUPERVISOR_STATE_PATH, null),
  ]);
  const pid = Number(pidRecord?.pid);
  const supervisorPid = Number(supervisorPidRecord?.pid);
  const report = state && runtime ? buildPaperStatusReport(state, runtime) : null;
  return {
    daemon: { pid: Number.isInteger(pid) ? pid : null, alive: await alive(pid) },
    residentSupervisor: { pid: Number.isInteger(supervisorPid) ? supervisorPid : null, alive: await alive(supervisorPid), health: supervisorState?.health ?? null, faults: supervisorState?.faults ?? [] },
    killSwitch,
    lifecycle: state?.lifecycle ?? null,
    strategyVersion: state?.strategyVersion ?? null,
    implementationRevision: state?.implementationRevision ?? runtime?.implementationRevision ?? null,
    implementationDirectiveId: state?.implementationDirectiveId ?? runtime?.implementationDirectiveId ?? null,
    authorizationId: state?.authorizationId ?? null,
    paperRiskDirectiveId: state?.paperRiskDirectiveId ?? runtime?.paperRiskDirectiveId ?? null,
    latest: latest ? {
      heartbeatAt: latest.heartbeatAt,
      lastScanAt: latest.lastScanAt,
      lastSuccessfulScanAt: latest.lastSuccessfulScanAt,
      symbolCount: Array.isArray(latest.symbols) ? latest.symbols.length : 0,
      symbols: latest.symbols,
      planCount: Array.isArray(latest.plans) ? latest.plans.length : 0,
      websocket: latest.websocket,
      onlineLedger: latest.onlineLedger,
      abnormalLossGate: latest.abnormalLossGate,
      lastPositionBroadcastAt: latest.lastPositionBroadcast?.generatedAt ?? null,
      realOrdersAllowed: latest.realOrdersAllowed,
      paperRiskDirectiveId: latest.paperRiskDirectiveId,
    } : null,
    report,
    runtimeRoot: RUNTIME_ROOT,
  };
}

async function spawnDaemon(authority, automaticRestart) {
  const ledgerToken = execFileSync("/usr/bin/security", [
    "find-generic-password",
    "-a", authority.runtime.onlineLedger.keychainAccount,
    "-s", authority.runtime.onlineLedger.keychainService,
    "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (ledgerToken.length < 32) throw new Error("ONLINE_LEDGER_KEYCHAIN_TOKEN_MISSING_OR_SHORT");
  const sitesBypassToken = execFileSync("/usr/bin/security", [
    "find-generic-password",
    "-a", authority.runtime.onlineLedger.sitesBypassKeychainAccount,
    "-s", authority.runtime.onlineLedger.sitesBypassKeychainService,
    "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (sitesBypassToken.length < 32) throw new Error("SITES_BYPASS_KEYCHAIN_TOKEN_MISSING_OR_SHORT");
  const stdout = await fs.open(LOG_PATH, "a");
  const stderr = await fs.open(ERROR_PATH, "a");
  const child = spawn(process.execPath, [DAEMON_PATH], {
    cwd: PAPER_ROOT,
    detached: true,
    stdio: ["ignore", stdout.fd, stderr.fd],
    env: {
      PATH: process.env.PATH ?? "",
      MTFX_LEDGER_INGEST_TOKEN: ledgerToken,
      MTFX_SITES_BYPASS_TOKEN: sitesBypassToken,
    },
  });
  child.unref();
  await writeJsonAtomic(PATHS.pid, {
    schemaVersion: 1,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    authorizationId: authority.runtime.authorizationId,
    paperRiskDirectiveId: authority.runtime.paperRiskDirectiveId,
    automaticRestart,
  });
  await stdout.close();
  await stderr.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { status: "started", ...(await status()) };
}

async function start() {
  const authority = await loadAndValidateAuthority();
  await fs.mkdir(RUNTIME_ROOT, { recursive: true });
  const current = await status();
  if (current.daemon.alive) return { status: "already_running", ...current };
  await writeJsonAtomic(PATHS.killSwitch, {
    schemaVersion: 1,
    engaged: false,
    reason: null,
    changedAt: new Date().toISOString(),
    changedBy: "OWNER_AUTHORIZED_CONTROL_START",
    authorizationId: authority.runtime.authorizationId,
  });
  return spawnDaemon(authority, false);
}

async function recover() {
  const authority = await loadAndValidateAuthority();
  const current = await status();
  if (current.daemon.alive) return { status: "already_running", ...current };
  if (current.killSwitch?.engaged !== false) throw new Error("AUTOMATIC_RECOVERY_REFUSED_KILL_SWITCH_NOT_CLEAR");
  if (current.killSwitch?.authorizationId !== authority.runtime.authorizationId) throw new Error("AUTOMATIC_RECOVERY_REFUSED_AUTHORIZATION_MISMATCH");
  return spawnDaemon(authority, true);
}

// A configuration cutover must preserve the simulated book. SIGUSR2 asks the
// daemon to persist a recovery snapshot (including any open positions) before
// it exits; unlike SIGTERM it does not administratively close the book.
async function reloadPreservingPositions() {
  const authority = await loadAndValidateAuthority();
  const current = await status();
  if (!current.daemon.alive) return recover();
  if (current.killSwitch?.engaged !== false) {
    throw new Error("POSITION_PRESERVING_RELOAD_REFUSED_KILL_SWITCH_NOT_CLEAR");
  }
  process.kill(current.daemon.pid, "SIGUSR2");
  const exited = await waitForExit(current.daemon.pid, 8_000);
  if (!exited) throw new Error("POSITION_PRESERVING_RELOAD_DAEMON_DID_NOT_EXIT");
  const restarted = await recover();
  return { status: "reloaded_preserving_positions", priorPid: current.daemon.pid, authorizationId: authority.runtime.authorizationId, ...restarted };
}

async function stop(reason) {
  const current = await status();
  const authorizationId = current.authorizationId ?? current.killSwitch?.authorizationId ?? "OWNER-AUTH-MTFX-PRICE-TIME-STRUCTURE-050-20260806";
  await writeJsonAtomic(PATHS.killSwitch, {
    schemaVersion: 1,
    engaged: true,
    reason,
    changedAt: new Date().toISOString(),
    changedBy: "OWNER_CONTROL",
    authorizationId,
  });
  if (current.daemon.alive) process.kill(current.daemon.pid, "SIGTERM");
  return { status: "stop_requested", reason, daemon: current.daemon };
}

const command = process.argv[2] ?? "status";
let result;
if (command === "start") result = await start();
else if (["status", "health", "report", "positions", "candidates", "equity", "panorama"].includes(command)) result = await status();
else if (["stop", "engage", "kill-switch"].includes(command)) result = await stop(process.argv.slice(3).join(" ").trim() || "OWNER_MANUAL_STOP");
else if (command === "recover") result = await recover();
else if (["reload", "reload-preserving-positions"].includes(command)) result = await reloadPreservingPositions();
else if (["clear", "restart"].includes(command)) {
  process.stderr.write(`${JSON.stringify({ status: "refused", reason: "USE_EXPLICIT_START_AFTER_OWNER_AUTHORITY_VALIDATION" })}\n`);
  process.exitCode = 3;
} else {
  process.stderr.write("Usage: control.mjs start|status|health|report|positions|candidates|equity|panorama|recover|reload|stop [reason]\n");
  process.exitCode = 2;
}
if (result) {
  const rendered = command === "report"
    ? renderPaperStatusMarkdown(result)
    : command === "positions"
      ? renderPaperPositionsMarkdown(result)
      : command === "candidates"
        ? renderPaperCandidatesMarkdown(result)
        : command === "equity"
          ? renderPaperEquityMarkdown(result)
          : command === "panorama"
            ? renderPaperPanoramaMarkdown(result)
      : null;
  process.stdout.write(rendered ?? `${JSON.stringify(result, null, 2)}\n`);
}
