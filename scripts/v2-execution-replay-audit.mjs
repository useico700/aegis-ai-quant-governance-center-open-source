#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);

import crypto from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "experiments/v2-execution-reality/config.json");
const OUTPUT_ROOT = path.join(ROOT, "var/v2-execution-reality");
const RAW_ROOT = path.join(OUTPUT_ROOT, "raw");
const META_PATH = path.join(OUTPUT_ROOT, "meta.ndjson");
const AUDIT_LEDGER_PATH = path.join(OUTPUT_ROOT, "execution-audit.ndjson");
const AUDIT_STATE_PATH = path.join(OUTPUT_ROOT, "audit-state.json");
const AUDIT_LATEST_PATH = path.join(OUTPUT_ROOT, "audit-latest.json");
const SETTLE_DELAY_MS = 5000;

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

function readNdjson(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, filePath);
}

function utcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const days = [];
  let cursor = Date.parse(`${utcDay(start)}T00:00:00.000Z`);
  const last = Date.parse(`${utcDay(end)}T00:00:00.000Z`);
  while (cursor <= last) {
    days.push(utcDay(cursor));
    cursor += 86400000;
  }
  return days;
}

export function decodeRawLine(line) {
  const value = typeof line === "string" ? JSON.parse(line) : line;
  if (value?.[0] === "T") {
    return {
      kind: "trade",
      eventTime: Number(value[1]),
      transactionTime: Number(value[2]),
      symbol: value[3],
      tradeId: Number(value[4]),
      price: Number(value[5]),
      quantity: Number(value[6]),
      buyerIsMaker: value[7] === 1,
      receivedAt: Number(value[8]),
    };
  }
  if (value?.[0] === "B") {
    return {
      kind: "bookTicker",
      eventTime: Number(value[1]),
      transactionTime: Number(value[2]),
      symbol: value[3],
      updateId: Number(value[4]),
      bidPrice: Number(value[5]),
      bidQuantity: Number(value[6]),
      askPrice: Number(value[7]),
      askQuantity: Number(value[8]),
      receivedAt: Number(value[9]),
    };
  }
  return null;
}

async function loadRaw(symbol, start, end) {
  const records = [];
  for (const day of daysBetween(start, end)) {
    const filePath = path.join(RAW_ROOT, day, `${symbol}.ndjson`);
    if (!existsSync(filePath)) continue;
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = decodeRawLine(line);
      if (record && record.transactionTime >= start && record.transactionTime <= end) records.push(record);
    }
  }
  return records.sort((a, b) => a.transactionTime - b.transactionTime || a.receivedAt - b.receivedAt);
}

export function buildCoverageIntervals(metaEvents, openEnd = Infinity) {
  const desired = new Set();
  const starts = new Map();
  const intervals = {};
  let connected = false;
  const close = (symbol, at) => {
    const start = starts.get(symbol);
    if (start == null) return;
    (intervals[symbol] ??= []).push({ start, end: at });
    starts.delete(symbol);
  };
  const open = (symbol, at) => {
    if (!starts.has(symbol)) starts.set(symbol, at);
  };
  for (const event of [...metaEvents].sort((a, b) => a.occurredAt - b.occurredAt)) {
    if (event.type === "TRACKING_SET_CHANGED") {
      const next = new Set(event.payload?.desired ?? []);
      for (const symbol of desired) if (!next.has(symbol)) close(symbol, event.occurredAt);
      for (const symbol of next) if (!desired.has(symbol) && connected) open(symbol, event.occurredAt);
      desired.clear();
      for (const symbol of next) desired.add(symbol);
    } else if (event.type === "WEBSOCKET_OPEN") {
      connected = true;
      for (const symbol of desired) open(symbol, event.occurredAt);
    } else if (["WEBSOCKET_CLOSE", "COLLECTOR_STOPPING"].includes(event.type)) {
      for (const symbol of starts.keys()) close(symbol, event.occurredAt);
      connected = false;
    }
  }
  for (const symbol of starts.keys()) close(symbol, openEnd);
  return intervals;
}

function hasCoverage(intervals, symbol, start, end, warmupMs) {
  return (intervals[symbol] ?? []).some(
    (interval) => interval.start <= start - warmupMs && interval.end >= end,
  );
}

function latestBboAround(records, at, maximumPriorAgeMs = 2000, maximumFutureAgeMs = 1000) {
  let prior = null;
  let future = null;
  for (const record of records) {
    if (record.kind !== "bookTicker") continue;
    if (record.transactionTime <= at) prior = record;
    else {
      future = record;
      break;
    }
  }
  if (prior && at - prior.transactionTime <= maximumPriorAgeMs) return prior;
  if (future && future.transactionTime - at <= maximumFutureAgeMs) return future;
  return null;
}

function adverseBps(actual, paper, direction) {
  if (!(actual > 0) || !(paper > 0)) return null;
  return (direction * (actual - paper) / paper) * 10000;
}

export function auditEntryWindow(window, records, coverageComplete) {
  const direction = window.side === "LONG" ? 1 : -1;
  const trades = records.filter((record) => record.kind === "trade");
  const isRetest = window.path === "BREAKOUT_RETEST";
  const trigger = trades.find((trade) => {
    if (isRetest) {
      return direction === 1
        ? trade.price <= window.entry && trade.buyerIsMaker
        : trade.price >= window.entry && !trade.buyerIsMaker;
    }
    return direction === 1 ? trade.price >= window.entry : trade.price <= window.entry;
  });
  if (!coverageComplete) return { status: "CAPTURE_INCOMPLETE", trigger: trigger ?? null };
  if (!trigger) return { status: "PAPER_TRIGGER_NOT_OBSERVED", trigger: null };
  if (isRetest) {
    return {
      status: "LIMIT_TOUCH_QUEUE_UNKNOWN",
      trigger,
      paperFillPrice: window.paperFillPrice,
      limitPrice: window.entry,
      queuePositionKnown: false,
    };
  }
  const bbo = latestBboAround(records, trigger.transactionTime);
  if (!bbo) return { status: "TRIGGER_WITHOUT_EXECUTABLE_BBO", trigger };
  const executablePrice = direction === 1 ? bbo.askPrice : bbo.bidPrice;
  const executableQuantity = direction === 1 ? bbo.askQuantity : bbo.bidQuantity;
  return {
    status: "TRIGGER_EXECUTABLE",
    trigger,
    bbo,
    executablePrice,
    executableQuantity,
    requestedQuantity: window.quantity,
    topOfBookQuantitySufficient: executableQuantity >= window.quantity,
    paperFillPrice: window.paperFillPrice,
    adverseDeviationBps: adverseBps(executablePrice, window.paperFillPrice, direction),
  };
}

export function auditStopWindow(window, records, coverageComplete) {
  const direction = window.side === "LONG" ? 1 : -1;
  const trades = records.filter((record) => record.kind === "trade");
  const trigger = trades.find((trade) =>
    direction === 1 ? trade.price <= window.stopReference : trade.price >= window.stopReference,
  );
  if (!coverageComplete) return { status: "CAPTURE_INCOMPLETE", trigger: trigger ?? null };
  if (!trigger) return { status: "PAPER_TRIGGER_NOT_OBSERVED", trigger: null };
  const bbo = latestBboAround(records, trigger.transactionTime);
  if (!bbo) return { status: "TRIGGER_WITHOUT_EXECUTABLE_BBO", trigger };
  const executablePrice = direction === 1 ? bbo.bidPrice : bbo.askPrice;
  const executableQuantity = direction === 1 ? bbo.bidQuantity : bbo.askQuantity;
  return {
    status: "TRIGGER_EXECUTABLE",
    trigger,
    bbo,
    executablePrice,
    executableQuantity,
    requestedQuantity: window.quantity,
    topOfBookQuantitySufficient: executableQuantity >= window.quantity,
    paperFillPrice: window.paperFillPrice,
    adverseDeviationBps: adverseBps(executablePrice, window.paperFillPrice, direction),
  };
}

export function deriveEvaluationWindows(ledgerEvents, intervalMs = 900000) {
  const orders = new Map();
  const windows = [];
  for (const event of ledgerEvents) {
    const payload = event.payload ?? {};
    if (event.type === "SIM_ORDER_CREATED") {
      orders.set(payload.orderId, { ...payload, createdAt: event.marketTime });
    } else if (event.type === "SIM_ENTRY_FILL") {
      const order = orders.get(payload.orderId);
      if (!order) continue;
      windows.push({
        id: `ENTRY:${payload.positionId}`,
        type: "ENTRY",
        sourceSequence: event.sequence,
        symbol: payload.symbol,
        side: payload.side,
        path: order.path,
        entry: Number(order.entry),
        quantity: Number(payload.quantity),
        paperFillPrice: Number(payload.fillPrice),
        start: Number(order.createdAt),
        end: Number(event.marketTime),
      });
    } else if (
      event.type === "SIM_EXIT_FILL" &&
      ["INITIAL_STOP", "TRAILING_STOP", "SAME_BAR_CONSERVATIVE_STOP"].includes(payload.reason)
    ) {
      windows.push({
        id: `STOP:${event.eventId}`,
        type: "STOP",
        sourceSequence: event.sequence,
        positionId: payload.positionId,
        symbol: payload.symbol,
        side: payload.side,
        reason: payload.reason,
        stopReference: Number(payload.referencePrice),
        quantity: Number(payload.quantity),
        paperFillPrice: Number(payload.fillPrice),
        start: Number(event.marketTime) - intervalMs + 1,
        end: Number(event.marketTime),
      });
    }
  }
  return windows.filter((window) => window.end >= window.start && window.symbol);
}

function validateLedgerChain(events) {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence !== events[index - 1].sequence + 1) throw new Error("V2_LEDGER_SEQUENCE_GAP");
    if (events[index].previousHash !== events[index - 1].hash) throw new Error("V2_LEDGER_HASH_CHAIN_BREAK");
  }
}

function appendAudit(state, result) {
  const base = {
    sequence: state.lastSequence + 1,
    previousHash: state.lastHash,
    eventId: sha256(`${result.window.id}|${result.window.sourceSequence}`),
    type: "EXECUTION_REALITY_AUDIT",
    observedAt: new Date().toISOString(),
    payload: result,
  };
  const hash = sha256(JSON.stringify(base));
  appendFileSync(AUDIT_LEDGER_PATH, `${JSON.stringify({ ...base, hash })}\n`);
  state.lastSequence = base.sequence;
  state.lastHash = hash;
  state.auditedWindowIds.push(result.window.id);
}

function summarize(results, config) {
  const counts = {};
  const executable = [];
  for (const event of results) {
    const status = event.payload.audit.status;
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === "TRIGGER_EXECUTABLE" && Number.isFinite(event.payload.audit.adverseDeviationBps)) {
      executable.push(event.payload.audit.adverseDeviationBps);
    }
  }
  executable.sort((a, b) => a - b);
  const median = executable.length
    ? executable[Math.floor((executable.length - 1) / 2)]
    : null;
  return {
    schemaVersion: 1,
    experimentId: config.experimentId,
    generatedAt: new Date().toISOString(),
    totalAuditedWindows: results.length,
    statusCounts: counts,
    executableDeviationBps: {
      observations: executable.length,
      median,
      maximum: executable.length ? executable.at(-1) : null,
      minimum: executable.length ? executable[0] : null,
    },
    promotionEligibleObservations: results.filter(
      (event) => event.payload.audit.status === "TRIGGER_EXECUTABLE",
    ).length,
    authority: config.authority,
  };
}

export async function runAudit(configPath = CONFIG_PATH, now = Date.now()) {
  const config = readJson(configPath);
  const ledger = readNdjson(config.source.v2LedgerPath);
  validateLedgerChain(ledger);
  const meta = readNdjson(META_PATH);
  const activationAt = meta.find((event) => event.type === "WEBSOCKET_OPEN")?.occurredAt ?? now;
  const intervals = buildCoverageIntervals(meta, now);
  const state = readJson(AUDIT_STATE_PATH, {
    schemaVersion: 1,
    lastSequence: 0,
    lastHash: null,
    auditedWindowIds: [],
  });
  const audited = new Set(state.auditedWindowIds);
  const windows = deriveEvaluationWindows(ledger, config.capture.decisionIntervalMs)
    .filter((window) =>
      window.end >= activationAt &&
      !audited.has(window.id) &&
      now - window.end >= SETTLE_DELAY_MS,
    );
  for (const window of windows) {
    const records = await loadRaw(window.symbol, window.start, window.end);
    const coverageComplete = hasCoverage(
      intervals,
      window.symbol,
      window.start,
      window.end,
      config.coverageGate.minimumWarmupBeforeEvaluationMs,
    );
    const audit = window.type === "ENTRY"
      ? auditEntryWindow(window, records, coverageComplete)
      : auditStopWindow(window, records, coverageComplete);
    appendAudit(state, {
      window,
      coverageComplete,
      rawRecords: {
        trades: records.filter((record) => record.kind === "trade").length,
        bboUpdates: records.filter((record) => record.kind === "bookTicker").length,
      },
      audit,
    });
  }
  state.auditedWindowIds = state.auditedWindowIds.slice(-10000);
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(AUDIT_STATE_PATH, state);
  const results = readNdjson(AUDIT_LEDGER_PATH);
  const summary = summarize(results, config);
  writeJsonAtomic(AUDIT_LATEST_PATH, summary);
  return { appended: windows.length, summary };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.includes("run")) {
    process.stdout.write(`${JSON.stringify(await runAudit())}\n`);
  } else if (process.argv.includes("status")) {
    process.stdout.write(`${JSON.stringify(readJson(AUDIT_LATEST_PATH, { status: "NOT_STARTED" }), null, 2)}\n`);
  } else {
    process.stderr.write("Usage: node scripts/v2-execution-replay-audit.mjs run|status\n");
    process.exitCode = 64;
  }
}
