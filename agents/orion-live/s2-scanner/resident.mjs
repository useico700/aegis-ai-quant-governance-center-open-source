import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from 'node:url';
import { publicGet as requestPublic, scannerBarReader, scannerRetryDelay, scannerBudgetStopped, choosePlanQueue, resolveEntryConditionRace, candidateView, accountView, discoverS2Plans, reconcileS2ZPlanQueue, advancePxFirstClose } from "./engine.mjs";
import { S2_Z_STRUCTURE_REVISION } from '../../shared/s2-z-structure.mjs';
import { packS2ZState, hydrateS2ZState, reserveS2ZStateCapacity, structureArchiveBatches } from '../../shared/s2-z-state-codec.mjs';
import { appendS2StructureArchive } from './coordinated-host.mjs';
import { openProductionReadAdmission } from '../s2-execution/host-admission.mjs';
import { evaluateEventGate } from "./event-gate.mjs";
import { extractRules, quoteView } from "../../../lib/s1-precision.mjs";
import { CANDIDATE_LIFECYCLE_REVISION } from '../s2-execution/common.mjs';

async function legacyMain() {
const config = JSON.parse(await fs.readFile(new URL("./config.json", import.meta.url), "utf8"));
if (os.hostname() !== config.requiredHostname || config.mode !== "SCAN_ONLY" || config.realOrdersAllowed !== false || config.paperOrdersAllowed !== false || config.newEntriesBlocked !== true) throw new Error("S2_BOUNDARY_MISMATCH");
const admission = await openProductionReadAdmission('CANDIDATE_SCANNER');
const publicGet = (pathname, query) => requestPublic(pathname, query, fetch, admission);
const readBars = scannerBarReader(publicGet);
const root = config.runtimeRoot;
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const read = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } };
const atomic = async (file, data) => { const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(data) + "\n", { mode: 0o600 }); await fs.rename(tmp, file); };
let state = hydrateS2ZState(await read(path.join(root, "state.json"), { schemaVersion: 1, sequence: 0, plans: {} }));
if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.sequence) || !state.plans) throw new Error("S2_STATE_CORRUPT_NO_RESET");
state.planQueues ??= Object.fromEntries(Object.entries(state.plans).map(([symbol, plan]) => [symbol, [plan]]));
const bootId = crypto.randomUUID();
const recoveredOnBoot = state.sequence > 0 && state.continuity?.freshScanPending !== true;
const startedAt = new Date().toISOString();
let lastCompleted = Date.now(), stopping = false;
const notify = async (...args) => { if (process.env.NOTIFY_SOCKET) await promisify(execFile)("/usr/bin/systemd-notify", args).catch(() => {}); };
await notify("--ready", "--status=S2 candidate scanner starting; execution blocked");
const watchdog = setInterval(() => {
  if (process.connected) process.send({ type: "S2_PROGRESS", completedAt: lastCompleted });
  if (Date.now() - lastCompleted < 150000) void notify("WATCHDOG=1");
}, 20000);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopping = true; admission.stop(); });
const budgetStopped = scannerBudgetStopped;
let consecutiveFailures = 0;
let previousPublish = { status: "NOT_CONFIGURED", at: null };
while (!stopping) {
  const previousState = structuredClone(state);
  const cycleStart = Date.now();
  const rows = [], errors = [];
  const precisionRules = [], precisionErrors = [];
  const marketQuotes = [];
  let success = 0;
  try {
    const { serverTime } = await publicGet("/fapi/v1/time");
    if (!Number.isFinite(serverTime) || Math.abs(serverTime - Date.now()) > 30000) throw new Error("EXCHANGE_CLOCK_SKEW");
    try {
      const info = await publicGet("/fapi/v1/exchangeInfo");
      const observedAt = new Date().toISOString();
      for (const symbol of config.universe) {
        try { precisionRules.push(extractRules(info, symbol, observedAt)); }
        catch (error) { precisionErrors.push({ symbol, reason: error.message }); }
      }
    } catch (error) {
      precisionErrors.push({ symbol: "ALL", reason: error.message });
      if (budgetStopped(error)) throw error;
    }
    for (const symbol of config.universe) {
      if (stopping) break;
      try {
        const bars = {};
        for (const interval of ['5m', '15m', '1h']) {
          bars[interval] = await readBars(symbol, interval, serverTime);
        }
        try {
          const quote = await publicGet("/fapi/v1/ticker/bookTicker", { symbol });
          marketQuotes.push(quoteView(quote, precisionRules.find(rule => rule.symbol === symbol), symbol, Date.now()));
        } catch (error) {
          marketQuotes.push({ symbol, status: "UNAVAILABLE", reason: error.message });
          if (budgetStopped(error)) throw error;
        }
        const discovered = discoverS2Plans({ symbol, bars5m: bars["5m"], bars15m: bars["15m"], bars1h: bars["1h"], now: serverTime, strategy: config.strategy });
        const retained = state.planQueues[symbol] ?? (state.plans[symbol] ? [state.plans[symbol]] : []);
        let queue;
        if (config.strategy.structureRevision === S2_Z_STRUCTURE_REVISION) {
          const transition = reconcileS2ZPlanQueue({ existing: retained, pending: state.pendingZDiscoveries?.[symbol] ?? [], discovered,
            bars5m: bars['5m'], bars15m: bars['15m'], bars1h: bars['1h'], now: serverTime, strategy: config.strategy });
          const knownArchive = new Set(state.structureArchiveIndex ?? []);
          const records = transition.archive.filter(record => { if (knownArchive.has(record.eventId)) return false; knownArchive.add(record.eventId); return true; });
          for (const batch of structureArchiveBatches(records)) await appendS2StructureArchive(root, batch, serverTime);
          state.structureArchiveIndex = [...knownArchive].slice(-2000);
          queue = transition.queue; state.pendingZDiscoveries ??= {}; state.pendingZDiscoveries[symbol] = transition.pending;
          state.zCapacity ??= {}; state.zCapacity[symbol] = transition.capacity;
        } else queue = resolveEntryConditionRace(choosePlanQueue(retained.filter(plan => !state.lastCandidates?.some(row => row.id === plan.id && row.status === 'INVALIDATED')),
          discovered[0] ?? null, serverTime, config.strategy).map(plan => advancePxFirstClose(plan, bars['5m'], serverTime, config.strategy.signal)));
        if (queue.length) {
          state.planQueues[symbol] = queue; state.plans[symbol] = queue[0];
          rows.push(...queue.map(plan => ({ ...candidateView(plan, bars["5m"], serverTime, config.strategy), observedAt: new Date().toISOString(), stale: false })));
        } else { delete state.planQueues[symbol]; delete state.plans[symbol]; }
        success += 1;
      } catch (error) {
        errors.push({ symbol, reason: error.message });
        const prior = state.lastCandidates?.filter((row) => row.symbol === symbol) ?? [];
        rows.push(...prior.map(row => ({ ...row, stale: true })));
        // Respect rate limits across the entire universe, not one request at a time.
        if (budgetStopped(error)) break;
      }
    }
  } catch (error) { errors.push({ symbol: "ALL", reason: error.message }); rows.push(...(state.lastCandidates ?? []).map((row) => ({ ...row, stale: true }))); }
  if (config.strategy.structureRevision === S2_Z_STRUCTURE_REVISION) {
    const bounded = reserveS2ZStateCapacity(state, previousState, { now: Date.now() });
    const knownArchive = new Set(bounded.state.structureArchiveIndex ?? []);
    const records = bounded.archive.filter(record => { if (knownArchive.has(record.eventId)) return false; knownArchive.add(record.eventId); return true; });
    for (const batch of structureArchiveBatches(records)) await appendS2StructureArchive(root, batch, Date.now());
    bounded.state.structureArchiveIndex = [...knownArchive].slice(-2000); state = bounded.state;
    const kept = new Set(Object.values(state.planQueues ?? {}).flat().map(plan => plan.id));
    for (let i = rows.length - 1; i >= 0; i--) if (!kept.has(rows[i].id)) rows.splice(i, 1);
  }
  const now = Date.now();
  const sourceAsOf = new Date(now).toISOString();
  let account;
  try { account = accountView(await read(config.accountSnapshot, null), now); } catch { account = accountView(null, now); }
  let calendar = null;
  if (process.env.S2_MONITOR_BYPASS_TOKEN) {
    try {
      const response = await fetch("https://your-cockpit.example.invalid", { headers: { "oai-sites-authorization": `Bearer ${process.env.S2_MONITOR_BYPASS_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
      if (response.ok) calendar = await response.json();
    } catch { /* Calendar outage is fail-closed for entries, not a scan shutdown. */ }
  }
  const eventGate = evaluateEventGate(calendar, Date.now());
  state.sequence += 1;
  state.structureRevision = config.strategy.structureRevision ?? null;
  state.lastCandidates = rows;
  state.lastCycleAt = sourceAsOf;
  if (success === config.universe.length) {
    state.lastSuccessfulScanAt = sourceAsOf;
    if (state.continuity?.freshScanPending) state.continuity.freshScanPending = false;
  }
  consecutiveFailures = success === config.universe.length ? 0 : consecutiveFailures + 1;
  const snapshot = { schemaVersion: 1, accountLabel: "S2", runtimeId: config.runtimeId, mode: "SCAN_ONLY", revision: config.strategy.implementationRevision,
    structureRevision: state.structureRevision, zCapacity: state.zCapacity ?? null, zStorageCapacity: state.zStorageCapacity ?? null,
    sourceAsOf, sequence: state.sequence, candidateLifecycleRevision: CANDIDATE_LIFECYCLE_REVISION, bootId, startedAt, status: success === config.universe.length ? "HEALTHY" : "DEGRADED",
    lastSuccessfulScanAt: state.lastSuccessfulScanAt ?? null, scanDurationMs: now - cycleStart, scannedSymbols: success, universe: config.universe,
    account, candidates: rows, errors, eventGate,
    precision: { source: "BINANCE_USDM_MAINNET_EXCHANGE_INFO", rules: precisionRules, errors: precisionErrors, submissionAllowed: false }, marketQuotes,
    publish: previousPublish, recovery: { restartEnabled: true, stateRecovered: recoveredOnBoot, watchdogSeconds: 180 },
    requestBudget: admission.status(), realOrdersAllowed: false, newEntriesBlocked: true, tickBboExecutionEvidence: false };
  await atomic(path.join(root, "state.json"), packS2ZState(state));
  await atomic(path.join(root, "latest.json"), snapshot);
  lastCompleted = now;
  process.stdout.write(JSON.stringify({ sourceAsOf, sequence: state.sequence, status: snapshot.status, scannedSymbols: success, candidates: rows.length, errors }) + "\n");
  if (process.env.S2_MONITOR_URL && process.env.S2_MONITOR_INGEST_TOKEN) {
    try {
      const url = new URL(process.env.S2_MONITOR_URL);
      if (url.origin !== "https://your-cockpit.example.invalid" || url.pathname !== "/api/s1-monitor") throw new Error("MONITOR_DESTINATION_DENIED");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${process.env.S2_MONITOR_INGEST_TOKEN}` };
      if (process.env.S2_MONITOR_BYPASS_TOKEN) headers["oai-sites-authorization"] = `Bearer ${process.env.S2_MONITOR_BYPASS_TOKEN}`;
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(snapshot), redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`PUBLISH_HTTP_${response.status}`);
      const receipt = await response.json();
      if (!["SYNCED", "OLDER_SNAPSHOT_IGNORED"].includes(receipt.status)) throw new Error("PUBLISH_RECEIPT_INVALID");
      previousPublish = { status: "SYNCED", at: new Date().toISOString() };
    } catch (error) { previousPublish = { status: error.message, at: new Date().toISOString() }; }
  }
  const delay = scannerRetryDelay({ cycleIntervalMs: config.cycleIntervalMs, consecutiveFailures,
    elapsedMs: Date.now() - cycleStart, errors: [...errors, ...precisionErrors] });
  // Keep watchdog alive during intentional backoff; a hung scan still loses its watchdog.
  for (let waited = 0; waited < delay && !stopping; waited += 1000) { await new Promise((resolve) => setTimeout(resolve, 1000)); lastCompleted = Date.now(); }
}
clearInterval(watchdog);
await admission.close();
await notify("--stopping");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--coordinated') {
      const { runCoordinatedScannerHost } = await import('./coordinated-host.mjs');
      await runCoordinatedScannerHost();
    } else if (process.argv.length === 2) await legacyMain();
    else throw new Error('SCANNER_ARGUMENTS');
  } catch (error) {
    const canceled = error?.message === 'SHADOW_STARTUP_CANCELED';
    process.stderr.write(canceled ? 'S2_SCANNER_STARTUP_CANCELED\n' : 'S2_SCANNER_HOST_FAILED\n');
    process.exitCode = canceled ? 0 : 2;
  }
}
