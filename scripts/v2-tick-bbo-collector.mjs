#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);

import crypto from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "experiments/v2-execution-reality/config.json");
const OUTPUT_ROOT = path.join(ROOT, "var/v2-execution-reality");
const RAW_ROOT = path.join(OUTPUT_ROOT, "raw");
const STATUS_PATH = path.join(OUTPUT_ROOT, "latest.json");
const PID_PATH = path.join(OUTPUT_ROOT, "collector.pid");
const META_PATH = path.join(OUTPUT_ROOT, "meta.ndjson");
const META_STATE_PATH = path.join(OUTPUT_ROOT, "meta-state.json");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, filePath);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validSymbol(value) {
  return typeof value === "string" && /^[A-Z0-9]{2,24}USDT$/.test(value);
}

export function inUniverseCaptureWindow(now, capture) {
  const interval = capture.decisionIntervalMs;
  const position = ((now % interval) + interval) % interval;
  return position >= capture.universeCaptureStartAfterCloseMs &&
    position <= capture.universeCaptureEndAfterCloseMs;
}

export function activeSymbols(latest, state = null, now = Date.now(), capture = null) {
  const symbols = new Set();
  for (const position of latest?.openPositions ?? []) {
    if (validSymbol(position?.symbol)) symbols.add(position.symbol);
  }
  for (const order of latest?.pendingOrders ?? []) {
    const symbol = order?.signal?.symbol ?? order?.symbol;
    if (validSymbol(symbol)) symbols.add(symbol);
  }
  if (capture?.captureUniverseAroundDecision === true && inUniverseCaptureWindow(now, capture)) {
    for (const symbol of state?.latestUniverse ?? []) {
      if (validSymbol(symbol)) symbols.add(symbol);
    }
  }
  return [...symbols].sort();
}

export function normalizeStreamMessage(message, receivedAt = Date.now()) {
  const parsed = typeof message === "string" ? JSON.parse(message) : message;
  const value = parsed?.data ?? parsed;
  if (value?.e === "trade") {
    return {
      kind: "trade",
      symbol: value.s,
      eventTime: Number(value.E),
      transactionTime: Number(value.T),
      tradeId: Number(value.t),
      price: String(value.p),
      quantity: String(value.q),
      buyerIsMaker: Boolean(value.m),
      receivedAt,
      line: [
        "T", Number(value.E), Number(value.T), value.s, Number(value.t),
        String(value.p), String(value.q), value.m ? 1 : 0, receivedAt,
      ],
    };
  }
  if (value?.e === "bookTicker") {
    return {
      kind: "bookTicker",
      symbol: value.s,
      eventTime: Number(value.E),
      transactionTime: Number(value.T ?? value.E),
      updateId: Number(value.u),
      bidPrice: String(value.b),
      bidQuantity: String(value.B),
      askPrice: String(value.a),
      askQuantity: String(value.A),
      receivedAt,
      line: [
        "B", Number(value.E), Number(value.T ?? value.E), value.s, Number(value.u),
        String(value.b), String(value.B), String(value.a), String(value.A), receivedAt,
      ],
    };
  }
  return null;
}

class BufferedRawWriter {
  constructor() {
    this.day = null;
    this.queue = [];
    this.flushTimer = setInterval(() => this.flush(), 250);
    this.flushTimer.unref();
  }

  append(line, timestamp = Date.now()) {
    this.queue.push({ day: utcDay(timestamp), symbol: line[3], text: `${JSON.stringify(line)}\n` });
    if (this.queue.length >= 1000) this.flush();
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    const byTarget = new Map();
    for (const item of batch) {
      const target = `${item.day}/${item.symbol}`;
      byTarget.set(target, `${byTarget.get(target) ?? ""}${item.text}`);
    }
    mkdirSync(RAW_ROOT, { recursive: true });
    for (const [target, contents] of byTarget) {
      const filePath = path.join(RAW_ROOT, `${target}.ndjson`);
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, contents);
    }
  }

  close() {
    clearInterval(this.flushTimer);
    this.flush();
  }
}

class MetaLedger {
  constructor() {
    const saved = readJson(META_STATE_PATH, {});
    this.sequence = Number(saved.sequence ?? 0);
    this.lastHash = saved.lastHash ?? null;
  }

  append(type, payload = {}, occurredAt = Date.now()) {
    const base = {
      sequence: this.sequence + 1,
      previousHash: this.lastHash,
      type,
      occurredAt,
      payload,
    };
    const hash = sha256(JSON.stringify(base));
    const event = { ...base, hash };
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    appendFileSync(META_PATH, `${JSON.stringify(event)}\n`);
    this.sequence = event.sequence;
    this.lastHash = hash;
    writeJsonAtomic(META_STATE_PATH, { sequence: this.sequence, lastHash: this.lastHash });
    return event;
  }
}

function rawStorage() {
  if (!existsSync(RAW_ROOT)) return { files: 0, bytes: 0, oldest: null, newest: null };
  const days = readdirSync(RAW_ROOT).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry)).sort();
  const files = days.flatMap((day) => readdirSync(path.join(RAW_ROOT, day))
    .filter((entry) => entry.endsWith(".ndjson"))
    .map((entry) => `${day}/${entry}`));
  return {
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + statSync(path.join(RAW_ROOT, entry)).size, 0),
    oldest: days[0] ?? null,
    newest: days.at(-1) ?? null,
  };
}

export class TickBboCollector {
  constructor(config, options = {}) {
    this.config = config;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (!this.WebSocketImpl) throw new Error("WEBSOCKET_IMPLEMENTATION_UNAVAILABLE");
    this.writer = options.writer ?? new BufferedRawWriter();
    this.meta = options.meta ?? new MetaLedger();
    this.socket = null;
    this.desired = new Set();
    this.subscribed = new Set();
    this.connectionId = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.lastMessageAt = null;
    this.lastError = null;
    this.requestId = 0;
    this.reconnectAttempts = 0;
    this.stats = {};
    this.lastPersistedBboAt = {};
    this.stopping = false;
  }

  streamNames(symbols) {
    return symbols.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return [`${lower}@trade`, `${lower}@bookTicker`];
    });
  }

  ensureStats(symbol) {
    this.stats[symbol] ??= {
      firstTradeAt: null,
      lastTradeAt: null,
      firstBboAt: null,
      lastBboAt: null,
      trades: 0,
      bboUpdates: 0,
      lastTradeId: null,
      tradeIdGapCount: 0,
      duplicateOrOutOfOrderTrades: 0,
      maximumClockSkewMs: 0,
    };
    return this.stats[symbol];
  }

  setDesired(symbols, at = Date.now()) {
    const limited = symbols.slice(0, this.config.capture.maximumTrackedSymbols);
    const next = new Set(limited);
    const added = [...next].filter((symbol) => !this.desired.has(symbol));
    const removed = [...this.desired].filter((symbol) => !next.has(symbol));
    this.desired = next;
    if (added.length || removed.length) {
      this.meta.append("TRACKING_SET_CHANGED", { added, removed, desired: [...next] }, at);
    }
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) this.synchronizeSubscriptions(at);
  }

  send(method, symbols, at = Date.now()) {
    if (!symbols.length || this.socket?.readyState !== this.WebSocketImpl.OPEN) return;
    const streams = this.streamNames(symbols);
    const id = ++this.requestId;
    this.socket.send(JSON.stringify({ method, params: streams, id }));
    this.meta.append(`${method}_REQUESTED`, { id, symbols, streams, connectionId: this.connectionId }, at);
  }

  synchronizeSubscriptions(at = Date.now()) {
    const add = [...this.desired].filter((symbol) => !this.subscribed.has(symbol));
    const remove = [...this.subscribed].filter((symbol) => !this.desired.has(symbol));
    this.send("SUBSCRIBE", add, at);
    this.send("UNSUBSCRIBE", remove, at);
    for (const symbol of add) this.subscribed.add(symbol);
    for (const symbol of remove) this.subscribed.delete(symbol);
  }

  processMessage(raw, receivedAt = Date.now()) {
    const text = typeof raw === "string" ? raw : raw?.data;
    if (typeof text !== "string") return null;
    let event;
    try {
      event = normalizeStreamMessage(text, receivedAt);
    } catch (error) {
      this.lastError = `INVALID_STREAM_JSON: ${error.message}`;
      return null;
    }
    if (!event || !this.desired.has(event.symbol)) return null;
    this.lastMessageAt = receivedAt;
    const stats = this.ensureStats(event.symbol);
    const skew = Math.abs(receivedAt - event.eventTime);
    if (Number.isFinite(skew)) stats.maximumClockSkewMs = Math.max(stats.maximumClockSkewMs, skew);
    if (event.kind === "trade") {
      this.writer.append(event.line, receivedAt);
      stats.firstTradeAt ??= event.transactionTime;
      stats.lastTradeAt = event.transactionTime;
      stats.trades += 1;
      if (Number.isFinite(stats.lastTradeId)) {
        if (event.tradeId <= stats.lastTradeId) stats.duplicateOrOutOfOrderTrades += 1;
        else if (event.tradeId > stats.lastTradeId + 1) {
          stats.tradeIdGapCount += event.tradeId - stats.lastTradeId - 1;
        }
      }
      stats.lastTradeId = event.tradeId;
    } else {
      stats.bboUpdatesReceived = (stats.bboUpdatesReceived ?? 0) + 1;
      const minimumInterval = this.config.capture.bboMinimumPersistIntervalMs ?? 0;
      if (receivedAt - (this.lastPersistedBboAt[event.symbol] ?? -Infinity) >= minimumInterval) {
        this.writer.append(event.line, receivedAt);
        this.lastPersistedBboAt[event.symbol] = receivedAt;
        stats.bboUpdates += 1;
      }
      stats.firstBboAt ??= event.transactionTime;
      stats.lastBboAt = event.transactionTime;
    }
    return event;
  }

  connect(at = Date.now()) {
    if (this.socket && [this.WebSocketImpl.CONNECTING, this.WebSocketImpl.OPEN].includes(this.socket.readyState)) return;
    this.connectionId = crypto.randomUUID();
    this.socket = new this.WebSocketImpl(this.config.source.websocketUrl);
    this.socket.addEventListener("open", () => {
      const openedAt = Date.now();
      this.connectedAt = openedAt;
      this.disconnectedAt = null;
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.subscribed.clear();
      this.meta.append("WEBSOCKET_OPEN", { connectionId: this.connectionId }, openedAt);
      this.synchronizeSubscriptions(openedAt);
    });
    this.socket.addEventListener("message", (message) => this.processMessage(message, Date.now()));
    this.socket.addEventListener("error", () => {
      this.lastError = "WEBSOCKET_ERROR";
    });
    this.socket.addEventListener("close", (event) => {
      const closedAt = Date.now();
      this.disconnectedAt = closedAt;
      this.meta.append("WEBSOCKET_CLOSE", {
        connectionId: this.connectionId,
        code: event?.code ?? null,
        reason: event?.reason ?? null,
        subscribed: [...this.subscribed],
      }, closedAt);
      this.subscribed.clear();
      this.socket = null;
    });
    this.meta.append("WEBSOCKET_CONNECTING", { connectionId: this.connectionId }, at);
  }

  closeSocket(code = 1000, reason = "collector stop") {
    try {
      this.socket?.close(code, reason);
    } catch {}
  }

  status(latest = null, now = Date.now()) {
    const storage = rawStorage();
    const retentionCutoff = utcDay(now - this.config.capture.rawRetentionDays * 86400000);
    return {
      schemaVersion: 1,
      experimentId: this.config.experimentId,
      status: this.config.status,
      generatedAt: new Date(now).toISOString(),
      source: {
        websocketUrl: this.config.source.websocketUrl,
        v2MarketAsOf: latest?.marketAsOf ?? null,
        v2MarketTime: latest?.marketTime ?? null,
        v2Lifecycle: latest?.lifecycle ?? null,
      },
      connection: {
        state: this.socket?.readyState ?? this.WebSocketImpl.CLOSED,
        connectionId: this.connectionId,
        connectedAt: this.connectedAt,
        disconnectedAt: this.disconnectedAt,
        lastMessageAt: this.lastMessageAt,
        lastError: this.lastError,
      },
      tracking: {
        desiredSymbols: [...this.desired],
        subscribedSymbols: [...this.subscribed],
        symbolStats: this.stats,
      },
      storage: {
        ...storage,
        retentionDays: this.config.capture.rawRetentionDays,
        retentionCutoff,
        expiredFilesPresent: storage.oldest ? storage.oldest.slice(0, 10) < retentionCutoff : false,
        automaticDeletionAllowed: this.config.capture.automaticDeletionAllowed,
      },
      authority: this.config.authority,
    };
  }
}

export async function runCollector(configPath = DEFAULT_CONFIG_PATH) {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const config = readJson(configPath);
  if (!config) throw new Error("EXECUTION_REALITY_CONFIG_UNAVAILABLE");
  const priorPid = Number(readJson(PID_PATH)?.pid);
  if (isAlive(priorPid) && priorPid !== process.pid) {
    process.stdout.write(`${JSON.stringify({ status: "ALREADY_RUNNING", pid: priorPid })}\n`);
    return;
  }
  writeJsonAtomic(PID_PATH, { pid: process.pid, startedAt: new Date().toISOString() });
  const collector = new TickBboCollector(config);
  collector.meta.append("COLLECTOR_STARTED", { pid: process.pid, configPath });
  collector.connect();
  let latest = null;
  let state = null;
  let lastStatusAt = 0;
  let reconnectDelay = config.capture.reconnectMinimumMs;

  const stop = () => {
    collector.stopping = true;
    collector.meta.append("COLLECTOR_STOPPING", { pid: process.pid });
    collector.closeSocket();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!collector.stopping) {
      latest = readJson(config.source.v2LatestPath, latest);
      state = readJson(config.source.v2StatePath, state);
      collector.setDesired(activeSymbols(latest, state, Date.now(), config.capture));
      if (!collector.socket) {
        collector.reconnectAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, config.capture.reconnectMaximumMs);
        collector.connect();
      } else if (collector.socket.readyState === collector.WebSocketImpl.OPEN) {
        reconnectDelay = config.capture.reconnectMinimumMs;
        if (
          collector.desired.size > 0 &&
          collector.lastMessageAt &&
          Date.now() - collector.lastMessageAt > config.capture.staleConnectionMs
        ) {
          collector.meta.append("WEBSOCKET_STALE_RECYCLE", {
            lastMessageAt: collector.lastMessageAt,
            desired: [...collector.desired],
          });
          collector.closeSocket(4000, "stale stream");
        }
      }
      if (Date.now() - lastStatusAt >= config.capture.statusFlushMs) {
        writeJsonAtomic(STATUS_PATH, collector.status(latest));
        lastStatusAt = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, config.capture.statePollMs));
    }
  } finally {
    collector.writer.close();
    writeJsonAtomic(STATUS_PATH, collector.status(latest));
    try {
      if (Number(readJson(PID_PATH)?.pid) === process.pid) unlinkSync(PID_PATH);
    } catch {}
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes("status")) {
    process.stdout.write(`${JSON.stringify(readJson(STATUS_PATH, { status: "NOT_STARTED" }), null, 2)}\n`);
  } else if (process.argv.includes("run")) {
    await runCollector(process.env.V2_EXECUTION_REALITY_CONFIG ?? DEFAULT_CONFIG_PATH);
  } else {
    process.stderr.write("Usage: node scripts/v2-tick-bbo-collector.mjs run|status\n");
    process.exitCode = 64;
  }
}
