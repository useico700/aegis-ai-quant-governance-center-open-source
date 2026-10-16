import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT } from "./context.mjs";
import {
  invariant,
  parseTime,
  readJson,
  sha256,
  stableStringify,
  writeJsonAtomic,
} from "./utils.mjs";

export const PUBLIC_BASE_URL = "https://demo-fapi.binance.com";
export const PUBLIC_KLINE_PATH = "/fapi/v1/klines";
export const V4_MARKET_DATA_ROOT = path.join(PROJECT_ROOT, "market_data", "orion-v4-rg1", "binance-usdm");
export const INTERVAL_MS = Object.freeze({
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
});

const MAX_PAGE_SIZE = 1_500;
const MAX_BAR_COUNT = 500_000;

export function assertPublicBaseUrl(value = PUBLIC_BASE_URL) {
  const url = new URL(value);
  invariant(
    url.protocol === "https:" && url.hostname === "demo-fapi.binance.com" && url.pathname === "/",
    "V4_RG1_PUBLIC_BASE_URL_NOT_ALLOWLISTED",
  );
  invariant(!url.username && !url.password && !url.search && !url.hash, "V4_RG1_PUBLIC_BASE_URL_MUST_BE_CLEAN");
  return url;
}

export function normalizeSymbol(value, config) {
  const symbol = String(value ?? "").trim().toUpperCase();
  invariant(/^[A-Z0-9]{3,20}USDT$/.test(symbol), "V4_RG1_SYMBOL_INVALID");
  invariant(config?.universe?.symbols?.includes(symbol), "V4_RG1_SYMBOL_OUTSIDE_FIXED_RESEARCH_UNIVERSE");
  return symbol;
}

export function normalizeInterval(value, config) {
  const interval = String(value ?? "").trim();
  invariant(Object.hasOwn(INTERVAL_MS, interval), "V4_RG1_INTERVAL_NOT_IMPLEMENTED");
  invariant(config?.data?.allowedIntervals?.includes(interval), "V4_RG1_INTERVAL_OUTSIDE_CONFIG");
  return interval;
}

export function normalizeKlineRow(row) {
  invariant(Array.isArray(row) && row.length >= 9, "V4_RG1_KLINE_ROW_INVALID");
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
  invariant(Object.values(bar).every(Number.isFinite), "V4_RG1_KLINE_NON_FINITE");
  invariant(bar.open > 0 && bar.close > 0 && bar.low > 0, "V4_RG1_KLINE_PRICE_NON_POSITIVE");
  invariant(bar.high >= Math.max(bar.open, bar.close, bar.low), "V4_RG1_KLINE_HIGH_INVALID");
  invariant(bar.low <= Math.min(bar.open, bar.close, bar.high), "V4_RG1_KLINE_LOW_INVALID");
  invariant(bar.volume >= 0 && bar.quoteVolume >= 0 && bar.trades >= 0, "V4_RG1_KLINE_ACTIVITY_INVALID");
  invariant(bar.closeTime > bar.openTime, "V4_RG1_KLINE_TIME_INVALID");
  return bar;
}

export function assessBarIntegrity(bars, interval, config) {
  const intervalMs = INTERVAL_MS[normalizeInterval(interval, config)];
  const gaps = [];
  const duplicates = [];
  const outOfOrder = [];
  const malformedDurations = [];
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (bar.closeTime !== bar.openTime + intervalMs - 1) {
      malformedDurations.push({ openTime: bar.openTime, closeTime: bar.closeTime });
    }
    if (index === 0) continue;
    const previous = bars[index - 1];
    const delta = bar.openTime - previous.openTime;
    if (delta === 0) duplicates.push(bar.openTime);
    else if (delta < 0) outOfOrder.push({ previous: previous.openTime, current: bar.openTime });
    else if (delta !== intervalMs) {
      gaps.push({
        afterOpenTime: previous.openTime,
        beforeOpenTime: bar.openTime,
        missingBars: Math.max(0, Math.round(delta / intervalMs) - 1),
      });
    }
  }
  return {
    status: gaps.length || duplicates.length || outOfOrder.length || malformedDurations.length ? "INCOMPLETE" : "COMPLETE",
    expectedIntervalMs: intervalMs,
    gaps,
    duplicates,
    outOfOrder,
    malformedDurations,
  };
}

function normalizeRange({ start, end, interval, now }) {
  const intervalMs = INTERVAL_MS[interval];
  const startTime = parseTime(start, "START");
  const requestedEndTime = parseTime(end, "END");
  invariant(startTime % intervalMs === 0, "V4_RG1_START_NOT_INTERVAL_ALIGNED");
  invariant(requestedEndTime % intervalMs === 0, "V4_RG1_END_NOT_INTERVAL_ALIGNED");
  invariant(requestedEndTime > startTime, "V4_RG1_RANGE_MUST_BE_POSITIVE");
  const lastFullyClosedBoundary = Math.floor(now / intervalMs) * intervalMs;
  const endTime = Math.min(requestedEndTime, lastFullyClosedBoundary);
  invariant(endTime > startTime, "V4_RG1_RANGE_HAS_NO_FULLY_CLOSED_BARS");
  invariant((endTime - startTime) / intervalMs <= MAX_BAR_COUNT, "V4_RG1_RANGE_TOO_LARGE");
  return { startTime, endTime, requestedEndTime };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestPage({ symbol, interval, startTime, endTime, fetchImpl, requestTimeoutMs, attempts, delayImpl }) {
  const url = assertPublicBaseUrl();
  url.pathname = PUBLIC_KLINE_PATH;
  url.search = new URLSearchParams({
    symbol,
    interval,
    startTime: String(startTime),
    endTime: String(endTime - 1),
    limit: String(MAX_PAGE_SIZE),
  }).toString();

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { "user-agent": "orion-v4-rg1-gate0-public-replay/1.0" },
      });
      if (!response.ok) {
        const error = new Error(`V4_RG1_PUBLIC_HTTP_${response.status}`);
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      invariant(Array.isArray(body), "V4_RG1_PUBLIC_RESPONSE_INVALID");
      return body;
    } catch (error) {
      lastError = error;
      if ([418, 429].includes(error?.status)) throw new Error(`V4_RG1_PUBLIC_RATE_LIMIT_FAIL_CLOSED_${error.status}`);
      if (attempt >= attempts || (Number(error?.status) >= 400 && Number(error?.status) < 500)) throw error;
      await delayImpl(250 * (2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export function datasetPathFor({ symbol, interval, startTime, endTime }, config) {
  const normalizedSymbol = normalizeSymbol(symbol, config);
  const normalizedInterval = normalizeInterval(interval, config);
  return path.join(V4_MARKET_DATA_ROOT, normalizedSymbol, normalizedInterval, `${startTime}-${endTime}.json`);
}

export async function downloadPublicDataset({
  symbol,
  interval,
  start,
  end,
  config,
  authorizationId,
  now = Date.now(),
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
  attempts = 3,
  requestSpacingMs = 180,
  delayImpl = delay,
  persist = true,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol, config);
  const normalizedInterval = normalizeInterval(interval, config);
  const { startTime, endTime, requestedEndTime } = normalizeRange({ start, end, interval: normalizedInterval, now });
  const intervalMs = INTERVAL_MS[normalizedInterval];
  const expectedBarCount = (endTime - startTime) / intervalMs;
  const bars = [];
  let cursor = startTime;
  let pageCount = 0;

  while (cursor < endTime) {
    const rows = await requestPage({
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      startTime: cursor,
      endTime,
      fetchImpl,
      requestTimeoutMs,
      attempts,
      delayImpl,
    });
    pageCount += 1;
    invariant(rows.length > 0, "V4_RG1_PUBLIC_DATA_ENDED_BEFORE_REQUEST_RANGE");
    for (const row of rows) {
      const bar = normalizeKlineRow(row);
      if (bar.openTime >= startTime && bar.openTime < endTime && bar.closeTime < now) bars.push(bar);
    }
    const lastOpenTime = Number(rows.at(-1)?.[0]);
    invariant(Number.isFinite(lastOpenTime) && lastOpenTime >= cursor, "V4_RG1_PUBLIC_PAGINATION_NOT_MONOTONIC");
    cursor = lastOpenTime + intervalMs;
    invariant(cursor > lastOpenTime, "V4_RG1_PUBLIC_PAGINATION_STALLED");
    if (cursor < endTime) await delayImpl(requestSpacingMs);
  }

  const integrity = assessBarIntegrity(bars, normalizedInterval, config);
  invariant(integrity.status === "COMPLETE", "V4_RG1_DOWNLOADED_DATA_GAP_FAIL_CLOSED");
  invariant(bars.length === expectedBarCount, "V4_RG1_DOWNLOADED_RANGE_COVERAGE_INCOMPLETE");
  invariant(bars[0]?.openTime === startTime && bars.at(-1)?.openTime === endTime - intervalMs, "V4_RG1_DOWNLOADED_BOUNDARY_COVERAGE_INCOMPLETE");

  const dataset = {
    schemaVersion: 1,
    ownerAuthorizationId: authorizationId,
    strategyVersion: config.candidateVersion,
    implementationRevision: config.implementationRevision,
    source: "BINANCE_USDM_PUBLIC_REST",
    baseUrl: PUBLIC_BASE_URL,
    endpoint: PUBLIC_KLINE_PATH,
    requestMethod: "GET",
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
    executionUse: "V4_RG1_GATE_0_CLOSED_BAR_RESEARCH_ONLY",
    gate1Eligible: false,
    integrity,
    bars,
  };
  dataset.datasetHash = sha256(stableStringify(dataset));
  const filePath = datasetPathFor(dataset, config);
  if (persist) await writeJsonAtomic(filePath, dataset);
  return { dataset, filePath: persist ? filePath : null };
}

export function validateDataset(dataset, { expectedSymbol, expectedInterval, config, verifyHash = true } = {}) {
  invariant(dataset?.fullyClosedBarsOnly === true, "V4_RG1_REQUIRES_FULLY_CLOSED_BARS");
  invariant(dataset?.credentialsUsed === false && dataset?.signedRequestsUsed === false && dataset?.orderEndpointsPresent === false, "V4_RG1_DATASET_EXECUTION_BOUNDARY_INVALID");
  invariant(dataset?.gate1Eligible === false, "V4_RG1_DATASET_CANNOT_BE_GATE1_ELIGIBLE");
  invariant(normalizeSymbol(dataset.symbol, config) === normalizeSymbol(expectedSymbol ?? dataset.symbol, config), "V4_RG1_DATASET_SYMBOL_MISMATCH");
  invariant(normalizeInterval(dataset.interval, config) === normalizeInterval(expectedInterval ?? dataset.interval, config), "V4_RG1_DATASET_INTERVAL_MISMATCH");
  invariant(Array.isArray(dataset.bars) && dataset.bars.length > 0, "V4_RG1_DATASET_EMPTY");
  for (const rawBar of dataset.bars) normalizeKlineRow([
    rawBar.openTime,
    rawBar.open,
    rawBar.high,
    rawBar.low,
    rawBar.close,
    rawBar.volume,
    rawBar.closeTime,
    rawBar.quoteVolume,
    rawBar.trades,
    rawBar.takerBuyBaseVolume,
    rawBar.takerBuyQuoteVolume,
  ]);
  const recomputedIntegrity = assessBarIntegrity(dataset.bars, dataset.interval, config);
  invariant(recomputedIntegrity.status === "COMPLETE", "V4_RG1_DATA_GAP_FAIL_CLOSED");
  invariant(dataset.integrity?.status === "COMPLETE", "V4_RG1_DECLARED_DATA_INTEGRITY_NOT_COMPLETE");
  invariant(dataset.barCount === dataset.bars.length, "V4_RG1_DATASET_BAR_COUNT_MISMATCH");
  invariant(dataset.bars.every((bar) => bar.closeTime < dataset.capturedAt), "V4_RG1_DATASET_CONTAINS_UNCLOSED_BAR");
  if (verifyHash) {
    const expectedHash = dataset.datasetHash;
    const unsigned = { ...dataset };
    delete unsigned.datasetHash;
    invariant(expectedHash === sha256(stableStringify(unsigned)), "V4_RG1_DATASET_HASH_MISMATCH");
  }
  return { ...dataset, integrity: recomputedIntegrity };
}

export async function loadDataset(filePath, { expectedSymbol, expectedInterval, config } = {}) {
  const resolved = path.resolve(filePath);
  invariant(resolved.startsWith(`${path.resolve(V4_MARKET_DATA_ROOT)}${path.sep}`), "V4_RG1_DATASET_PATH_OUTSIDE_V4_MARKET_DATA_ROOT");
  const dataset = await readJson(resolved);
  return validateDataset(dataset, { expectedSymbol, expectedInterval, config, verifyHash: true });
}

export async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}
