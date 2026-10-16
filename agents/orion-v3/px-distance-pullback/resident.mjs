#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateObservation, rollingTimeValidation, signalReceipt, summarizeGrid, summarizeNetOutcomes } from "./statistics.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const RUNTIME = path.resolve(ROOT, CONFIG.runtime.root);
const SOURCE = path.resolve(ROOT, CONFIG.runtime.sourceSnapshot);
const LATEST = path.join(RUNTIME, "latest.json");
const PID = path.join(RUNTIME, "resident.pid.json");
const STATE = path.join(RUNTIME, "state.json");
const EVENTS = path.join(RUNTIME, "market-events.ndjson");
const OWNER_LOCK = path.join(RUNTIME, "resident.owner.lock");
const AUTH_PATH = path.join(ROOT, "governance/owner-authorizations/2026-09-14-orion-v3-px-distance-pullback-forward-research.json");
const CURRENT_STATE_PATH = path.join(ROOT, "governance/current-state.json");
const CODE_PATHS = [fileURLToPath(import.meta.url), path.join(path.dirname(fileURLToPath(import.meta.url)), "statistics.mjs")];

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function processAlive(pid) { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } }
export function validateResearchBoundary(config, { authorization = readJson(AUTH_PATH, {}), current = readJson(CURRENT_STATE_PATH, {}) } = {}) {
  const publicUrl = new URL(config.venue.publicStreamBaseUrl), marketUrl = new URL(config.venue.marketStreamBaseUrl);
  if (config.researchBoundary.executionGate !== false || config.researchBoundary.rankingInput !== false || config.researchBoundary.ordersAffected !== false || config.researchBoundary.redResetAllowed !== false || config.researchBoundary.automaticThresholdPromotionAllowed !== false) throw new Error("RESEARCH_EXECUTION_BOUNDARY_INVALID");
  if (!Number.isFinite(Date.parse(config.prospectiveStart))) throw new Error("RESEARCH_PROSPECTIVE_START_INVALID");
  if (config.venue.credentialsAllowed !== false || config.venue.signedRequestsAllowed !== false || config.venue.orderRequestsAllowed !== false) throw new Error("RESEARCH_NETWORK_BOUNDARY_INVALID");
  if (config.venue.allowedHost !== "fstream.binancefuture.com" || [publicUrl, marketUrl].some((url) => url.protocol !== "wss:" || url.hostname !== "fstream.binancefuture.com")) throw new Error("RESEARCH_STREAM_HOST_INVALID");
  if (publicUrl.pathname !== "/public/stream" || marketUrl.pathname !== "/market/stream") throw new Error("RESEARCH_STREAM_SPLIT_INVALID");
  const study = current.orionV3PxDistancePullbackResearch;
  if (authorization.id !== config.authorizationId || authorization.status !== "ACTIVE" || authorization.prohibits?.executionGate !== true || authorization.prohibits?.credentialsOrSignedRequests !== true || study?.authorizationId !== config.authorizationId || study?.status !== "ACTIVE_FORWARD_OBSERVE_ONLY" || study?.executionGate !== false || study?.rankingInput !== false || study?.ordersAffected !== false) throw new Error("RESEARCH_GOVERNANCE_AUTHORIZATION_MISMATCH");
}

export function recoverEventTail(filePath) {
  if (!fs.existsSync(filePath)) return { sequence: 0, head: "GENESIS", rows: [] };
  const rows = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let sequence = 0, head = "GENESIS";
  for (const row of rows) { const payload = { sequence: row.sequence, previousHash: row.previousHash, type: row.type, at: row.at, payload: row.payload }; if (row.sequence !== sequence + 1 || row.previousHash !== head || row.hash !== sha(JSON.stringify(payload))) throw new Error("RESEARCH_EVENT_CHAIN_INVALID"); sequence = row.sequence; head = row.hash; }
  return { sequence, head, rows };
}

export class ForwardResearchResident {
  constructor({ config = CONFIG, WebSocketImpl = globalThis.WebSocket, clock = Date.now, append = null, runtimeRoot = RUNTIME, sourcePath = SOURCE } = {}) {
    if (!WebSocketImpl) throw new Error("WEBSOCKET_UNAVAILABLE");
    this.config = config; this.WebSocketImpl = WebSocketImpl; this.clock = clock; this.runtimeRoot = runtimeRoot; this.sourcePath = sourcePath;
    this.paths = { latest: path.join(runtimeRoot, "latest.json"), pid: path.join(runtimeRoot, "resident.pid.json"), state: path.join(runtimeRoot, "state.json"), events: path.join(runtimeRoot, "market-events.ndjson"), ownerLock: path.join(runtimeRoot, "resident.owner.lock") };
    this.state = readJson(this.paths.state, { schemaVersion: 1, researchId: config.researchId, signals: {}, cycles: 0, eventSequence: 0, eventHead: "GENESIS" });
    if (this.state.researchId !== config.researchId) throw new Error("RESEARCH_STATE_ID_MISMATCH");
    const tail = append ? { sequence: this.state.eventSequence, head: this.state.eventHead, rows: [] } : recoverEventTail(this.paths.events);
    if (Number(this.state.eventSequence) > tail.sequence) throw new Error("RESEARCH_STATE_AHEAD_OF_EVENT_CHAIN");
    this.recoveredAheadTail = tail.sequence > Number(this.state.eventSequence);
    if (this.recoveredAheadTail) for (const signal of Object.values(this.state.signals)) { signal.integrityUnknown = true; signal.integrityUnknownReason = "UNCOMMITTED_EVENT_TAIL_AFTER_CRASH"; }
    this.state.eventSequence = tail.sequence; this.state.eventHead = tail.head;
    this.quotes = new Map(); this.ticks = new Map(); this.bboHistory = new Map(); this.tickHistory = new Map(); this.continuity = new Map(); this.sockets = {}; this.symbols = [];
    this.startedAt = this.clock(); this.lastCycleAt = null; this.lastError = null; this.appendOverride = append; this.stopping = false; this.reconnectTimer = null; this.reconnectScheduled = false;
    this.fatalResearchError = null;
    this.loadedConfigSha256 = sha(JSON.stringify(config));
    this.loadedCodeSha256 = sha(CODE_PATHS.map((file) => fs.readFileSync(file, "utf8")).join("\n--MODULE--\n"));
  }
  appendEvent(type, payload, at = this.clock()) {
    const base = { sequence: Number(this.state.eventSequence) + 1, previousHash: this.state.eventHead, type, at, payload };
    const row = { ...base, hash: sha(JSON.stringify(base)) };
    if (this.appendOverride) this.appendOverride(row); else { fs.mkdirSync(this.runtimeRoot, { recursive: true }); if (fs.existsSync(this.paths.events) && fs.statSync(this.paths.events).size >= this.config.runtime.maximumRawEvidenceBytes) throw new Error("RESEARCH_RAW_STORAGE_LIMIT"); fs.appendFileSync(this.paths.events, `${JSON.stringify(row)}\n`, { mode: 0o600 }); }
    this.state.eventSequence = row.sequence; this.state.eventHead = row.hash; return row;
  }
  streamUrl(kind, symbols) {
    const base = kind === "public" ? this.config.venue.publicStreamBaseUrl : this.config.venue.marketStreamBaseUrl;
    const suffix = kind === "public" ? "bookTicker" : "aggTrade";
    const url = new URL(base); url.searchParams.set("streams", symbols.map((symbol) => `${symbol.toLowerCase()}@${suffix}`).join("/")); return url.toString();
  }
  resetContinuity(symbols, at, reason) {
    this.quotes.clear(); this.ticks.clear(); this.bboHistory.clear(); this.tickHistory.clear();
    for (const symbol of symbols) this.continuity.set(symbol, { epoch: `${at}:${symbol}`, publicConnectedAt: null, marketConnectedAt: null, firstBboAt: null, firstTickAt: null, gapAt: reason === "INITIAL_CONNECT" ? null : at, reason, bboCount: 0, tickCount: 0, lastBboUpdateId: null, lastAggTradeId: null });
  }
  connect(kind, symbols) {
    const old = this.sockets[kind]; if (old) { old.intentional = true; try { old.close(); } catch {} }
    if (!symbols.length || this.stopping) return;
    const socket = new this.WebSocketImpl(this.streamUrl(kind, symbols)); this.sockets[kind] = socket;
    socket.addEventListener("open", () => { if (socket !== this.sockets[kind]) return; const at = this.clock(); for (const symbol of symbols) { const row = this.continuity.get(symbol); if (row) row[kind === "public" ? "publicConnectedAt" : "marketConnectedAt"] = at; } this.appendEvent("STREAM_OPEN", { kind, symbols, host: this.config.venue.allowedHost }); });
    socket.addEventListener("message", (event) => { if (socket !== this.sockets[kind] || this.fatalResearchError) return; try { this.ingest(kind, JSON.parse(String(event.data)), this.clock()); } catch (error) { this.lastError = `MESSAGE_${kind}_${error.message}`; if (/STORAGE|EVENT_CHAIN|STATE_AHEAD/.test(error.message)) this.fatalResearchError = this.lastError; } });
    socket.addEventListener("error", () => { try { socket.close(); } catch {} });
    socket.addEventListener("close", () => { if (socket !== this.sockets[kind] || this.stopping || socket.intentional) return; this.schedulePairReconnect(`${kind.toUpperCase()}_STREAM_CLOSED`); });
  }
  schedulePairReconnect(reason) {
    if (this.stopping || this.reconnectScheduled) return;
    this.reconnectScheduled = true; const at = this.clock(); this.resetContinuity(this.symbols, at, reason); this.appendEvent("STREAM_PAIR_GAP", { reason, symbols: this.symbols });
    for (const socket of Object.values(this.sockets)) { socket.intentional = true; try { socket.close(); } catch {} }
    this.reconnectTimer = setTimeout(() => { this.reconnectScheduled = false; this.connect("public", this.symbols); this.connect("market", this.symbols); }, this.config.runtime.reconnectDelayMs);
  }
  setSymbols(symbols) {
    const next = [...new Set([...this.symbols, ...symbols])].sort().slice(0, this.config.researchBoundary.maximumUniverseSize);
    if (JSON.stringify(next) === JSON.stringify(this.symbols)) return;
    this.symbols = next; const at = this.clock(); this.resetContinuity(next, at, this.state.cycles ? "SUBSCRIPTION_SET_CHANGED" : "INITIAL_CONNECT");
    this.appendEvent("TRACKED_CANDIDATE_SYMBOLS_CHANGED", { symbols: next }); this.connect("public", next); this.connect("market", next);
  }
  ingest(kind, envelope, receivedAt = this.clock()) {
    const raw = envelope?.data ?? envelope, symbol = String(raw?.s ?? "").toUpperCase(); if (!this.symbols.includes(symbol)) return false;
    const continuity = this.continuity.get(symbol); if (!continuity) return false;
    const eventTime = Number(raw.E), transactionTime = Number(raw.T ?? raw.E);
    if (!(eventTime > 0) || eventTime > receivedAt + 60_000) throw new Error("EXCHANGE_CLOCK_INVALID");
    if (kind === "public" && raw.e === "bookTicker") {
      const updateId = Number(raw.u), bid = Number(raw.b), ask = Number(raw.a); if (!(ask >= bid && bid > 0) || !Number.isSafeInteger(updateId)) throw new Error("BBO_INVALID");
      if (continuity.lastBboUpdateId !== null && updateId <= continuity.lastBboUpdateId) { continuity.gapAt = receivedAt; continuity.reason = "BBO_UPDATE_NOT_INCREASING"; return false; }
      continuity.lastBboUpdateId = updateId; continuity.bboCount += 1; continuity.firstBboAt ??= eventTime;
      const quote = { symbol, bid, ask, eventTime, transactionTime, receivedAt, updateId, epoch: continuity.epoch }; this.quotes.set(symbol, quote); const history = (this.bboHistory.get(symbol) ?? []).filter((row) => row.eventTime >= receivedAt - this.config.signal.maximumSignalAgeMs - this.config.runtime.cycleIntervalMs); history.push(quote); this.bboHistory.set(symbol, history); this.appendEvent("BBO", quote, receivedAt); this.observeSignals(symbol, quote, receivedAt); return true;
    }
    if (kind === "market" && raw.e === "aggTrade") {
      const aggregateTradeId = Number(raw.a), price = Number(raw.p), quantity = Number(raw.q); if (!(price > 0 && quantity > 0) || !Number.isSafeInteger(aggregateTradeId)) throw new Error("TICK_INVALID");
      if (continuity.lastAggTradeId !== null && aggregateTradeId !== continuity.lastAggTradeId + 1) { continuity.gapAt = receivedAt; continuity.reason = "AGG_TRADE_ID_GAP"; }
      continuity.lastAggTradeId = aggregateTradeId; continuity.tickCount += 1; continuity.firstTickAt ??= eventTime;
      const tick = { symbol, price, quantity, buyerIsMaker: Boolean(raw.m), aggregateTradeId, eventTime, transactionTime, receivedAt, epoch: continuity.epoch }; this.ticks.set(symbol, tick); const history = (this.tickHistory.get(symbol) ?? []).filter((row) => row.receivedAt >= receivedAt - this.config.signal.maximumSignalAgeMs - this.config.runtime.cycleIntervalMs); history.push(tick); this.tickHistory.set(symbol, history); this.appendEvent("TICK", tick, receivedAt); return true;
    }
    return false;
  }
  continuityComplete(signal, quote, now) {
    const row = this.continuity.get(signal.symbol);
    const tick = [...(this.tickHistory.get(signal.symbol) ?? [])].reverse().find((candidate) => candidate.receivedAt <= now && candidate.eventTime <= now);
    return Boolean(!signal.integrityUnknown && row?.firstBboAt && row?.firstTickAt && row.firstBboAt <= signal.confirmedAt && row.firstTickAt <= signal.confirmedAt && !row.gapAt && quote?.epoch === row.epoch && tick?.epoch === row.epoch && quote.receivedAt <= now && quote.eventTime <= now && quote.receivedAt >= signal.observedAt && now - quote.receivedAt >= 0 && now - quote.receivedAt <= this.config.runtime.streamStaleAfterMs && now - tick.receivedAt >= 0 && now - tick.receivedAt <= this.config.runtime.streamStaleAfterMs);
  }
  observeSignal(signal, quote, now) {
    if (signal.eligible === false) return;
    const complete = this.continuityComplete(signal, quote, now);
    for (const [mode, thresholds] of [["PERCENT_BPS", this.config.frozenParameterGrid.percentageDistanceBps], ["STRUCTURE_Z", this.config.frozenParameterGrid.structureDistanceMultipliers]]) for (const threshold of thresholds) {
      const key = `${mode}:${threshold}`, prior = signal.thresholds[key] ?? {};
      signal.thresholds[key] = { ...evaluateObservation({ signal, quote, now, threshold, mode, prior, minimumDistanceBps: this.config.signal.minimumDistanceFromPxBps, legacyMaximumBps: this.config.signal.maximumLegacyBboDisplacementFromSecond15mCloseBps, continuityComplete: complete }), confirmedAt: signal.confirmedAt };
    }
    signal.observationCount = Number(signal.observationCount ?? 0) + 1; signal.lastObservedAt = now;
  }
  observeSignals(symbol, quote, now) {
    for (const signal of Object.values(this.state.signals)) {
      if (signal.symbol !== symbol || now > signal.expiresAt + this.config.runtime.cycleIntervalMs) continue;
      this.observeSignal(signal, quote, now);
    }
  }
  discoverSignals(snapshot, now) {
    for (const plan of snapshot?.plans ?? []) {
      const receipt = signalReceipt(plan, now, this.config.signal.maximumSignalAgeMs, Date.parse(this.config.prospectiveStart)); if (!receipt.eligible || this.state.signals[receipt.signalId]) continue;
      this.state.signals[receipt.signalId] = { ...receipt, sourceVisibleAt: now, thresholds: {}, observationCount: 0, actualFillOutcome: 0, pnl: null, pnlEvidenceStatus: "OUTCOME_PRODUCER_NOT_IMPLEMENTED" };
      this.appendEvent("HF14_SIGNAL_REGISTERED", receipt, now);
      const history = (this.bboHistory.get(receipt.symbol) ?? []).filter((quote) => quote.receivedAt >= receipt.observedAt && quote.eventTime >= receipt.confirmedAt && quote.eventTime <= receipt.expiresAt).sort((a, b) => a.receivedAt - b.receivedAt || a.eventTime - b.eventTime);
      for (const quote of history) this.observeSignal(this.state.signals[receipt.signalId], quote, quote.receivedAt);
    }
  }
  finalizeExpiredSignals(now) {
    const expectedThresholdCount = this.config.frozenParameterGrid.percentageDistanceBps.length + this.config.frozenParameterGrid.structureDistanceMultipliers.length;
    for (const signal of Object.values(this.state.signals)) { const thresholdStates = Object.values(signal.thresholds ?? {}); if (now > signal.expiresAt && (thresholdStates.length < expectedThresholdCount || !thresholdStates.every((state) => state.terminal === true))) this.observeSignal(signal, this.quotes.get(signal.symbol), now); }
  }
  async cycle() {
    if (this.fatalResearchError) throw new Error(this.fatalResearchError);
    const now = this.clock(), snapshot = readJson(this.sourcePath, null); if (!snapshot) throw new Error("HF14_SOURCE_SNAPSHOT_MISSING");
    if (snapshot.implementationRevision !== this.config.sourceImplementationRevision || snapshot.evaluationCohortId !== this.config.sourceEvaluationCohortId) throw new Error("HF14_SOURCE_REVISION_MISMATCH");
    const universe = readJson(path.join(ROOT, "agents/orion-v3/binance-demo/config.json"), {})?.universe?.symbols ?? [];
    if (universe.length !== 30) throw new Error("HF14_UNIVERSE_BOUNDARY_MISMATCH");
    const unfinishedSymbols = Object.values(this.state.signals).filter((signal) => !Object.values(signal.thresholds ?? {}).every((state) => state.terminal === true)).map((signal) => signal.symbol);
    const candidateSymbols = [...(snapshot.plans ?? []).map((plan) => plan.symbol), ...unfinishedSymbols].filter((symbol) => universe.includes(symbol)); this.setSymbols(candidateSymbols);
    const prospectiveStart = Date.parse(this.config.prospectiveStart);
    for (const signal of Object.values(this.state.signals)) if (signal.confirmedAt < prospectiveStart && signal.eligible !== false) { signal.eligible = false; signal.exclusionReason = "PRE_PROSPECTIVE_START_LEFT_TRUNCATED"; signal.excludedAt = now; this.appendEvent("SIGNAL_EXCLUDED_FROM_FORWARD_DENOMINATOR", { signalId: signal.signalId, reason: signal.exclusionReason, prospectiveStart }, now); }
    this.discoverSignals(snapshot, now);
    this.finalizeExpiredSignals(now);
    const signals = Object.values(this.state.signals), grid = summarizeGrid(signals, this.config), rolling = rollingTimeValidation(signals, this.config), netOutcomes = summarizeNetOutcomes(signals, { blockMs: this.config.statistics.correlationBlockMs, minimumEligibleSignals: this.config.statistics.minimumEligibleSignals, minimumIndependentTimeBlocks: this.config.statistics.minimumIndependentTimeBlocks });
    this.state.cycles = Number(this.state.cycles) + 1; this.state.updatedAt = new Date(now).toISOString(); writeJson(this.paths.state, this.state);
    const health = { public: this.streamHealth("public", now), market: this.streamHealth("market", now) };
    const eligibleSignalCount = signals.filter((signal) => signal.eligible !== false).length;
    writeJson(this.paths.latest, { schemaVersion: 1, researchId: this.config.researchId, authorizationId: this.config.authorizationId, status: health.public.status === "LIVE" && health.market.status === "LIVE" ? "RUNNING_FORWARD_OBSERVE_ONLY" : "COLLECTING_STREAM_WARMUP_OR_DEGRADED", asOf: new Date(now).toISOString(), pid: process.pid, prospectiveStart: this.config.prospectiveStart, loadedConfigSha256: this.loadedConfigSha256, loadedCodeSha256: this.loadedCodeSha256, sourceSnapshotSha256: sha(JSON.stringify(snapshot)), sourceImplementationRevision: snapshot.implementationRevision, sourceSnapshotAsOf: snapshot.scannedAt, sourcePlanCount: snapshot.planCount, trackedSymbols: this.symbols, executionGate: false, rankingInput: false, ordersAffected: false, redResetAllowed: false, credentialsRead: false, signedRequests: 0, orderRequests: 0, cycles: this.state.cycles, streams: health, evidence: { eventSequence: this.state.eventSequence, eventHead: this.state.eventHead, eventPath: path.relative(ROOT, this.paths.events), rawBytes: fs.existsSync(this.paths.events) ? fs.statSync(this.paths.events).size : 0, recoveredAheadTail: this.recoveredAheadTail }, statistics: { eligibleSignalCount, excludedPreStartSignalCount: signals.length - eligibleSignalCount, unfilledOutcomeValue: 0, unknownEvidenceValue: null, pnlStatus: "OUTCOME_PRODUCER_NOT_IMPLEMENTED", grid, rollingTimeValidation: rolling, netOutcomeContract: netOutcomes, automaticThresholdPromotionAllowed: false }, limitations: ["OUTCOME_PRODUCER_NOT_IMPLEMENTED", ...(eligibleSignalCount ? ["NO_COMPLETE_FEE_ATTRIBUTED_CAUSAL_ARM_OUTCOMES"] : ["NO_POST_START_FULLY_CONFIRMED_HF14_SIGNAL_YET"]), "NO_PNL_OR_THRESHOLD_CONCLUSION_ALLOWED"] });
    this.lastCycleAt = now; this.lastError = null;
  }
  streamHealth(kind, now) { const socket = this.sockets[kind], latest = kind === "public" ? Math.max(0, ...[...this.quotes.values()].map((q) => q.receivedAt)) : Math.max(0, ...[...this.ticks.values()].map((q) => q.receivedAt)); const ageMs = latest ? now - latest : null; return { status: socket?.readyState === this.WebSocketImpl.OPEN && ageMs !== null && ageMs <= this.config.runtime.streamStaleAfterMs ? "LIVE" : "WARMUP_OR_STALE", latestReceivedAt: latest ? new Date(latest).toISOString() : null, ageMs, trackedSymbolCount: this.symbols.length }; }
  async start() {
    validateResearchBoundary(this.config); fs.mkdirSync(this.runtimeRoot, { recursive: true });
    const prior = readJson(this.paths.pid, null); if (prior?.pid && prior.pid !== process.pid && processAlive(prior.pid)) throw new Error("RESEARCH_RESIDENT_ALREADY_RUNNING");
    try { const descriptor = fs.openSync(this.paths.ownerLock, "wx", 0o600); fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(this.startedAt).toISOString() })}\n`); fs.closeSync(descriptor); } catch (error) { const owner = readJson(this.paths.ownerLock, null); if (owner?.pid && processAlive(owner.pid)) throw new Error("RESEARCH_OWNER_LOCK_HELD"); fs.rmSync(this.paths.ownerLock, { force: true }); const descriptor = fs.openSync(this.paths.ownerLock, "wx", 0o600); fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date(this.startedAt).toISOString() })}\n`); fs.closeSync(descriptor); }
    writeJson(this.paths.pid, { schemaVersion: 1, pid: process.pid, status: "STARTING", startedAt: new Date(this.startedAt).toISOString(), prospectiveStart: this.config.prospectiveStart, loadedConfigSha256: this.loadedConfigSha256, loadedCodeSha256: this.loadedCodeSha256, executionGate: false, ordersAffected: false });
    await this.cycle(); writeJson(this.paths.pid, { schemaVersion: 1, pid: process.pid, status: "RUNNING", startedAt: new Date(this.startedAt).toISOString(), prospectiveStart: this.config.prospectiveStart, loadedConfigSha256: this.loadedConfigSha256, loadedCodeSha256: this.loadedCodeSha256, executionGate: false, ordersAffected: false });
    this.timer = setInterval(() => this.cycle().catch((error) => { this.lastError = error.message; if (/STORAGE|EVENT_CHAIN|STATE_AHEAD/.test(error.message)) this.fatalResearchError = error.message; writeJson(this.paths.latest, { ...readJson(this.paths.latest, {}), status: "DEGRADED_RESEARCH_ONLY", lastError: error.message, fatalResearchError: this.fatalResearchError, executionGate: false, ordersAffected: false }); }), this.config.runtime.cycleIntervalMs);
  }
  stop() { this.stopping = true; clearInterval(this.timer); clearTimeout(this.reconnectTimer); for (const socket of Object.values(this.sockets)) { socket.intentional = true; try { socket.close(); } catch {} } writeJson(this.paths.pid, { ...readJson(this.paths.pid, {}), status: "STOPPED", stoppedAt: new Date(this.clock()).toISOString() }); try { const owner = readJson(this.paths.ownerLock, null); if (owner?.pid === process.pid) fs.rmSync(this.paths.ownerLock); } catch {} }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resident = new ForwardResearchResident();
  process.on("SIGTERM", () => { resident.stop(); process.exit(0); }); process.on("SIGINT", () => { resident.stop(); process.exit(0); });
  resident.start().catch((error) => { writeJson(LATEST, { schemaVersion: 1, status: "DEGRADED_RESEARCH_ONLY", lastError: error.message, executionGate: false, ordersAffected: false }); process.exitCode = 1; });
}
