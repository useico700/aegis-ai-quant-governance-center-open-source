import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sha256,
  sleep,
  stableStringify,
  writeJsonAtomic,
} from "../../../agents/orion-v2/paper/runtime-utils.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PUBLIC_BASE_URL = "https://demo-fapi.binance.com";
export const PUBLIC_KLINE_PATH = "/fapi/v1/klines";
export const MARKET_DATA_ROOT = path.join(PROJECT_ROOT, "market_data", "binance-usdm");
export const INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
});

const runtimeConfig = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "agents/orion-v2/paper/config.json"), "utf8"));
export const OWNER_APPROVED_SYMBOLS = Object.freeze([...runtimeConfig.venue.universe.symbols]);
const OWNER_APPROVED_SYMBOL_SET = new Set(OWNER_APPROVED_SYMBOLS);
const MAX_PAGE_SIZE = 1_500;
const MAX_BAR_COUNT = 500_000;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function assertPublicBaseUrl(value = PUBLIC_BASE_URL) {
  const url = new URL(value);
  invariant(url.protocol === "https:" && url.hostname === "demo-fapi.binance.com" && url.pathname === "/", "BINANCE_PUBLIC_BASE_URL_NOT_ALLOWLISTED");
  invariant(!url.username && !url.password && !url.search && !url.hash, "BINANCE_PUBLIC_BASE_URL_MUST_BE_CLEAN");
  return url;
}

export function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  invariant(/^[A-Z0-9]{3,20}USDT$/.test(symbol), "REPLAY_SYMBOL_INVALID");
  invariant(OWNER_APPROVED_SYMBOL_SET.has(symbol), "REPLAY_SYMBOL_OUTSIDE_OWNER_APPROVED_UNIVERSE");
  return symbol;
}

export function normalizeInterval(value) {
  const interval = String(value ?? "").trim();
  invariant(Object.hasOwn(INTERVAL_MS, interval), "REPLAY_INTERVAL_NOT_ALLOWLISTED");
  return interval;
}

export function parseTime(value, label) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value ?? ""));
  invariant(Number.isFinite(parsed), `REPLAY_${label}_TIME_INVALID`);
  return parsed;
}

export function normalizeRange({ start, end, now = Date.now() }) {
  const startTime = parseTime(start, "START");
  const requestedEndTime = parseTime(end, "END");
  invariant(requestedEndTime > startTime, "REPLAY_RANGE_MUST_BE_POSITIVE");
  invariant(startTime < now, "REPLAY_START_MUST_BE_HISTORICAL");
  return { startTime, endTime: Math.min(requestedEndTime, now), requestedEndTime };
}

export function normalizeKlineRow(row) {
  invariant(Array.isArray(row) && row.length >= 9, "BINANCE_KLINE_ROW_INVALID");
  const bar = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    takerBuyBaseVolume: Number(row[9] ?? 0),
    takerBuyQuoteVolume: Number(row[10] ?? 0),
  };
  invariant(Object.values(bar).every(Number.isFinite), "BINANCE_KLINE_NON_FINITE");
  invariant(bar.open > 0 && bar.high >= bar.open && bar.high >= bar.close && bar.high >= bar.low, "BINANCE_KLINE_HIGH_INVALID");
  invariant(bar.low > 0 && bar.low <= bar.open && bar.low <= bar.close, "BINANCE_KLINE_LOW_INVALID");
  invariant(bar.closeTime > bar.openTime, "BINANCE_KLINE_TIME_INVALID");
  return bar;
}

export function assessBarIntegrity(bars, interval) {
  const intervalMs = INTERVAL_MS[normalizeInterval(interval)];
  const gaps = [];
  const duplicates = [];
  const outOfOrder = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    const delta = current.openTime - previous.openTime;
    if (delta === 0) duplicates.push(current.openTime);
    else if (delta < 0) outOfOrder.push({ previous: previous.openTime, current: current.openTime });
    else if (delta !== intervalMs) gaps.push({ afterOpenTime: previous.openTime, beforeOpenTime: current.openTime, missingBars: Math.max(0, Math.round(delta / intervalMs) - 1) });
  }
  return {
    status: gaps.length || duplicates.length || outOfOrder.length ? "INCOMPLETE" : "COMPLETE",
    expectedIntervalMs: intervalMs,
    gaps,
    duplicates,
    outOfOrder,
  };
}

async function requestKlinePage({
  symbol,
  interval,
  startTime,
  endTime,
  fetchImpl,
  requestTimeoutMs,
  attempts,
  sleepImpl,
}) {
  const base = assertPublicBaseUrl();
  base.pathname = PUBLIC_KLINE_PATH;
  base.search = new URLSearchParams({
    symbol,
    interval,
    startTime: String(startTime),
    endTime: String(endTime - 1),
    limit: String(MAX_PAGE_SIZE),
  }).toString();

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(base, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { "user-agent": "aegis-binance-free-replay/1.0-public-only" },
      });
      if (!response.ok) {
        const error = new Error(`BINANCE_PUBLIC_HTTP_${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers?.get?.("retry-after") ?? null;
        throw error;
      }
      const body = await response.json();
      invariant(Array.isArray(body), "BINANCE_PUBLIC_KLINES_RESPONSE_INVALID");
      return body;
    } catch (error) {
      lastError = error;
      if ([418, 429].includes(error?.status)) {
        throw new Error(`BINANCE_PUBLIC_RATE_LIMIT_FAIL_CLOSED_${error.status}`);
      }
      if (attempt >= attempts || (Number(error?.status) >= 400 && Number(error?.status) < 500)) throw error;
      await sleepImpl(250 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export function cachePathFor({ symbol, interval, startTime, endTime }) {
  const safeSymbol = normalizeSymbol(symbol);
  const safeInterval = normalizeInterval(interval);
  return path.join(MARKET_DATA_ROOT, safeSymbol, safeInterval, `${startTime}-${endTime}.json`);
}

export async function downloadKlines({
  symbol,
  interval,
  start,
  end,
  now = Date.now(),
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
  attempts = 3,
  requestSpacingMs = 180,
  sleepImpl = sleep,
  persist = true,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedInterval = normalizeInterval(interval);
  const { startTime, endTime, requestedEndTime } = normalizeRange({ start, end, now });
  invariant(endTime > startTime, "REPLAY_RANGE_HAS_NO_CLOSED_BARS");

  const intervalMs = INTERVAL_MS[normalizedInterval];
  const requestedBars = Math.ceil((endTime - startTime) / intervalMs);
  invariant(requestedBars <= MAX_BAR_COUNT, "REPLAY_RANGE_TOO_LARGE");

  const byOpenTime = new Map();
  let cursor = startTime;
  let pageCount = 0;
  while (cursor < endTime) {
    const rows = await requestKlinePage({
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      startTime: cursor,
      endTime,
      fetchImpl,
      requestTimeoutMs,
      attempts,
      sleepImpl,
    });
    pageCount += 1;
    if (!rows.length) break;
    for (const row of rows) {
      const bar = normalizeKlineRow(row);
      if (bar.openTime >= startTime && bar.openTime < endTime && bar.closeTime < now) byOpenTime.set(bar.openTime, bar);
    }
    const lastOpenTime = Number(rows.at(-1)?.[0]);
    invariant(Number.isFinite(lastOpenTime) && lastOpenTime >= cursor, "BINANCE_PUBLIC_PAGINATION_NOT_MONOTONIC");
    const nextCursor = lastOpenTime + intervalMs;
    invariant(nextCursor > cursor, "BINANCE_PUBLIC_PAGINATION_STALLED");
    cursor = nextCursor;
    if (rows.length < MAX_PAGE_SIZE) break;
    await sleepImpl(requestSpacingMs);
  }

  const bars = [...byOpenTime.values()].sort((first, second) => first.openTime - second.openTime);
  invariant(bars.length > 0, "REPLAY_NO_CLOSED_KLINES_RETURNED");
  const integrity = assessBarIntegrity(bars, normalizedInterval);
  const dataset = {
    schemaVersion: 1,
    source: "BINANCE_USDM_PUBLIC_REST",
    baseUrl: PUBLIC_BASE_URL,
    endpoint: PUBLIC_KLINE_PATH,
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    startTime,
    endTime,
    requestedEndTime,
    capturedAt: now,
    barCount: bars.length,
    pageCount,
    fullyClosedBarsOnly: true,
    credentialsUsed: false,
    signedRequestsUsed: false,
    orderEndpointsPresent: false,
    executionUse: "CLOSED_BAR_RESEARCH_AND_SCREENING_ONLY",
    gate1Eligible: false,
    integrity,
    bars,
  };
  dataset.datasetHash = sha256(stableStringify(dataset));
  const filePath = cachePathFor(dataset);
  if (persist) await writeJsonAtomic(filePath, dataset);
  return { dataset, filePath: persist ? filePath : null };
}

export async function loadDataset(filePath) {
  const resolved = path.resolve(filePath);
  invariant(resolved.startsWith(`${path.resolve(MARKET_DATA_ROOT)}${path.sep}`), "REPLAY_DATASET_PATH_OUTSIDE_MARKET_DATA_ROOT");
  const dataset = JSON.parse(await fs.readFile(resolved, "utf8"));
  const expectedHash = dataset.datasetHash;
  const unsigned = { ...dataset };
  delete unsigned.datasetHash;
  invariant(expectedHash === sha256(stableStringify(unsigned)), "REPLAY_DATASET_HASH_MISMATCH");
  invariant(dataset.credentialsUsed === false && dataset.signedRequestsUsed === false && dataset.orderEndpointsPresent === false, "REPLAY_DATASET_EXECUTION_BOUNDARY_INVALID");
  invariant(normalizeSymbol(dataset.symbol) === dataset.symbol, "REPLAY_DATASET_SYMBOL_INVALID");
  invariant(normalizeInterval(dataset.interval) === dataset.interval, "REPLAY_DATASET_INTERVAL_INVALID");
  return dataset;
}
