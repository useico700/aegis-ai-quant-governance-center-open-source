import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = "/path/to/your/project Support/OrionV2Broadcaster";
const RUNTIME_ROOT = "/path/to/your/project";
const LATEST_PATH = `${RUNTIME_ROOT}/latest.json`;
const PAPER_STATE_PATH = `${RUNTIME_ROOT}/state.json`;
const DAEMON_PID_PATH = `${RUNTIME_ROOT}/daemon.pid.json`;
const SUPERVISOR_PID_PATH = `${RUNTIME_ROOT}/health-supervisor.pid.json`;
const SUPERVISOR_STATE_PATH = `${RUNTIME_ROOT}/health-supervisor-state.json`;
const KILL_SWITCH_PATH = `${RUNTIME_ROOT}/kill-switch.json`;
const STATE_PATH = `${ROOT}/broadcast-gate-state.json`;
const HEARTBEAT_MS = 60 * 60_000;

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, path);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function alive(pidRecord) {
  const pid = Number(pidRecord?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function positionView(position) {
  return {
    id: position?.id ?? null,
    book: position?.book ?? null,
    symbol: position?.symbol ?? null,
    direction: position?.direction ?? null,
    entry: position?.entry ?? null,
    quantity: position?.quantity ?? null,
    stop: position?.stop ?? null,
    target: position?.target ?? null,
    breakEvenArmed: position?.breakEvenArmed === true,
  };
}

function lifecycleView({ latest, paperState, daemonPid, supervisorPid, supervisorState, killSwitch }) {
  const books = Object.fromEntries(Object.entries(paperState?.books ?? {}).map(([name, book]) => [name, {
    equityUsdt: book?.equityUsdt ?? null,
    realizedPnlUsdt: book?.realizedPnlUsdt ?? null,
    newEntriesBlocked: book?.newEntriesBlocked === true,
    blockReason: book?.blockReason ?? null,
    openPositions: (book?.openPositions ?? []).map(positionView)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    closedPositionCount: Array.isArray(book?.closedPositions) ? book.closedPositions.length : 0,
  }]));
  return stable({
    daemonAlive: alive(daemonPid),
    supervisorAlive: alive(supervisorPid),
    supervisorHealth: supervisorState?.health ?? null,
    supervisorFaults: supervisorState?.faults ?? [],
    lifecycle: paperState?.lifecycle ?? latest?.lifecycle ?? null,
    strategyVersion: paperState?.strategyVersion ?? latest?.strategyVersion ?? null,
    authorizationId: paperState?.authorizationId ?? latest?.authorizationId ?? null,
    symbols: latest?.symbols ?? paperState?.symbols ?? [],
    planCount: Array.isArray(latest?.plans) ? latest.plans.length : 0,
    books,
    websocketConnected: latest?.websocket?.connected === true,
    websocketGapDetected: latest?.websocket?.gapDetected === true,
    onlineLedgerStatus: latest?.onlineLedger?.status ?? null,
    killSwitchEngaged: killSwitch?.engaged !== false,
    realOrdersAllowed: latest?.realOrdersAllowed ?? null,
  });
}

const latest = readJson(LATEST_PATH);
const paperState = readJson(PAPER_STATE_PATH);
if (!latest || !paperState) throw new Error("MTFX_BROADCAST_RUNTIME_MISSING");
const view = lifecycleView({
  latest,
  paperState,
  daemonPid: readJson(DAEMON_PID_PATH),
  supervisorPid: readJson(SUPERVISOR_PID_PATH),
  supervisorState: readJson(SUPERVISOR_STATE_PATH),
  killSwitch: readJson(KILL_SWITCH_PATH),
});
const signature = createHash("sha256").update(JSON.stringify(view)).digest("hex");
const state = readJson(STATE_PATH, {});
const now = Date.now();

if (process.argv.includes("--commit") || process.argv.includes("--seed")) {
  writeJsonAtomic(STATE_PATH, {
    schemaVersion: 1,
    lastBroadcastAt: new Date(now).toISOString(),
    lastBroadcastSignature: signature,
    lastBroadcastView: view,
    mode: "MTFX_MATERIAL_DELTA_PLUS_HOURLY_HEARTBEAT",
  });
  process.stdout.write(`COMMITTED ${signature}\n`);
} else {
  const lastAt = Date.parse(state.lastBroadcastAt);
  if (!state.lastBroadcastSignature) process.stdout.write("BROADCAST INITIAL\n");
  else if (state.lastBroadcastSignature !== signature) process.stdout.write("BROADCAST MATERIAL_DELTA\n");
  else if (!Number.isFinite(lastAt) || now - lastAt >= HEARTBEAT_MS) process.stdout.write("BROADCAST HOURLY_HEARTBEAT\n");
  else process.stdout.write(`SKIP NO_MATERIAL_DELTA nextHeartbeatMs=${HEARTBEAT_MS - (now - lastAt)}\n`);
}
