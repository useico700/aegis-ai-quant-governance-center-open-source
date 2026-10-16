import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeKlines } from "../paper/paper-engine.mjs";
import { sha256, stableStringify, validateFundingEvent, validateLedgerSourceEvent, validateMetadataRecord } from "./contracts.mjs";
import { r13CoverageAt, validateClosedBarSeries } from "./evidence.mjs";
import { BASELINE_REVISION } from "./policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FILES = Object.freeze({
  ledger: ".runtime/orion-v2-mtfx/ledger.ndjson",
  state: ".runtime/orion-v2-mtfx/state.json",
  config: "agents/orion-v2/paper/config.json",
  strategy: "experiments/v2-mtf-trendline-intersection/config.json",
  official: "governance/evidence/v2-c-r13-official-calendar-20260906.json",
  governance: "governance/current-state.json",
});
const SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT"]);
const ROUTES = new Set(["/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/premiumIndex", "/fapi/v1/klines", "/fapi/v1/fundingRate"]);
const invariant = (condition, code) => { if (!condition) throw new Error(code); };
const timestamp = (value) => typeof value === "number" ? value : Date.parse(value);
const numeric = (value) => (typeof value === "number" || (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) && Number.isFinite(Number(value));

function verifySource(raw, cursor) {
  invariant(Number.isSafeInteger(cursor?.sequence) && cursor.sequence >= 0 &&
    (cursor.sequence === 0 ? cursor.hash === "GENESIS" : /^[0-9a-f]{64}$/.test(cursor.hash)), "C_CONTEXT_CURSOR_INVALID");
  invariant(raw.length === 0 || raw.endsWith("\n"), "C_CONTEXT_SOURCE_INCOMPLETE_TAIL");
  let sequence = 0;
  let previousHash = "GENESIS";
  let anchored = cursor.sequence === 0;
  const ids = new Set();
  const records = [];
  for (const line of raw.split("\n").slice(0, -1)) {
    invariant(line.length > 0, "C_CONTEXT_SOURCE_EMPTY_LINE");
    const record = validateLedgerSourceEvent(JSON.parse(line));
    const base = { sequence: record.sequence, previousHash: record.previousHash, eventId: record.eventId, type: record.type, marketTime: record.marketTime, payload: record.payload };
    invariant(record.sequence === sequence + 1 && record.previousHash === previousHash && record.hash === sha256(stableStringify(base)), "C_CONTEXT_SOURCE_CHAIN_INVALID");
    invariant(!ids.has(record.eventId), "C_CONTEXT_SOURCE_DUPLICATE_EVENT_ID");
    ids.add(record.eventId);
    sequence = record.sequence;
    previousHash = record.hash;
    if (sequence === cursor.sequence) {
      invariant(previousHash === cursor.hash, "C_CONTEXT_CURSOR_ANCHOR_MISMATCH");
      anchored = true;
    }
    if (sequence > cursor.sequence && record.type === "PAPER_POSITION_OPENED" && record.payload.book === "MTFX-T") {
      invariant(SYMBOLS.includes(record.payload.symbol), "C_CONTEXT_OPPORTUNITY_SYMBOL_INVALID");
      records.push(record);
    }
  }
  invariant(anchored, "C_CONTEXT_SOURCE_REWOUND");
  return { records, cursor: { sequence, hash: previousHash } };
}

function validateConfig(config) {
  invariant(config?.implementationRevision === BASELINE_REVISION, "C_CONTEXT_SOURCE_REVISION_INVALID");
  invariant(config.venue?.signedRequestsAllowed === false && config.venue.apiKeysAllowed === false && config.venue.orderEndpointsAllowed === false &&
    config.execution?.realOrdersAllowed === false && config.execution.testnetOrdersAllowed === false, "C_CONTEXT_SOURCE_ORDER_PERMISSION_FORBIDDEN");
  invariant(config.venue.restBaseUrl === "https://demo-fapi.binance.com", "C_CONTEXT_PUBLIC_ORIGIN_INVALID");
  const actual = config.venue.universe?.symbols;
  invariant(Array.isArray(actual) && actual.length === SYMBOLS.length && new Set(actual).size === SYMBOLS.length && actual.every((symbol) => SYMBOLS.includes(symbol)), "C_CONTEXT_FIXED_UNIVERSE_INVALID");
}

function metadataRecord(exchange, symbol, receivedAt) {
  const matches = exchange.symbols?.filter((row) => row.symbol === symbol);
  invariant(matches?.length === 1, "C_CONTEXT_METADATA_SYMBOL_MISSING_OR_DUPLICATE");
  const row = matches[0];
  const filter = (kind) => {
    const matches = row.filters?.filter((item) => item.filterType === kind);
    invariant(matches?.length === 1, "C_CONTEXT_METADATA_FILTER_MISSING_OR_DUPLICATE");
    return matches[0];
  };
  const lot = filter("LOT_SIZE");
  const minimum = filter("MIN_NOTIONAL");
  const tickSize = filter("PRICE_FILTER").tickSize;
  const minNotional = minimum.notional ?? minimum.minNotional;
  invariant([tickSize, lot.stepSize, lot.minQty, minNotional].every(numeric), "C_CONTEXT_METADATA_VALUES_INVALID");
  return validateMetadataRecord({ schemaVersion: 1, type: "PUBLIC_EXCHANGE_METADATA", symbol, status: row.status, contractType: row.contractType,
    tickSize: Number(tickSize), stepSize: Number(lot.stepSize), minQty: Number(lot.minQty), minNotional: Number(minNotional),
    sourceAsOf: new Date(receivedAt).toISOString(), sourceSha256: sha256(exchange), origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH" });
}

function closedBars(rows, interval, serverTime) {
  invariant(Array.isArray(rows), "C_CONTEXT_KLINES_INVALID");
  const width = interval === "15m" ? 900_000 : 3_600_000;
  for (const row of rows) {
    invariant(Array.isArray(row) && row.length >= 9 && row.slice(0, 9).every(numeric), "C_CONTEXT_KLINE_VALUES_INVALID");
    const [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades] = row.map(Number);
    invariant(Number.isSafeInteger(openTime) && openTime % width === 0 && closeTime === openTime + width - 1 && low > 0 && high >= Math.max(open, close) && low <= Math.min(open, close) && volume >= 0 && quoteVolume >= 0 && Number.isSafeInteger(trades) && trades >= 0, "C_CONTEXT_KLINE_GEOMETRY_INVALID");
  }
  const bars = normalizeKlines(rows, serverTime);
  return { bars, health: validateClosedBarSeries(bars, interval, serverTime) };
}

async function fundingHistory({ symbol, positions, serverTime, request }) {
  const relevant = positions.filter((position) => position.symbol === symbol);
  if (!relevant.length) return { rows: [], query: { requested: false, startTime: null, endTime: null, responseComplete: false, settlementCoverageEstablished: false, pages: 0 } };
  // Re-query from opening, not a maximum settlement watermark: earlier fees can arrive late.
  const startTime = Math.min(...relevant.map((position) => timestamp(position.openedAt)));
  const endTime = Math.max(...relevant.map((position) => Math.min(position.closedAt == null ? serverTime : timestamp(position.closedAt), serverTime)));
  invariant(Number.isSafeInteger(startTime) && Number.isSafeInteger(endTime) && startTime > 0 && startTime <= endTime, "C_CONTEXT_FUNDING_INTERVAL_INVALID");
  const seen = new Map();
  const typesByTime = new Map();
  let pageStart = startTime;
  for (let page = 1; page <= 16; page += 1) {
    const { data } = await request("/fapi/v1/fundingRate", { symbol, startTime: pageStart, endTime, limit: 1000 });
    invariant(Array.isArray(data) && data.length <= 1000, "C_CONTEXT_FUNDING_HISTORY_INVALID");
    let lastTime = pageStart;
    for (const row of data) {
      const fundingTime = Number(row.fundingTime);
      invariant(row.symbol === symbol && [row.fundingTime, row.fundingRate, row.markPrice].every(numeric) && Number.isSafeInteger(fundingTime) && fundingTime >= pageStart && fundingTime <= endTime && fundingTime >= lastTime && Number(row.markPrice) > 0 &&
        (row.rateType === undefined || ["Regular", "Special"].includes(row.rateType)), "C_CONTEXT_FUNDING_ROW_INVALID");
      lastTime = fundingTime;
      const type = row.rateType ?? "UNSPECIFIED";
      const priorTypes = typesByTime.get(fundingTime) ?? new Set();
      invariant(!priorTypes.size || (type === "UNSPECIFIED" ? priorTypes.has(type) : !priorTypes.has("UNSPECIFIED")), "C_CONTEXT_FUNDING_TYPE_AMBIGUOUS");
      priorTypes.add(type);
      typesByTime.set(fundingTime, priorTypes);
      const key = `${symbol}:${fundingTime}:${type}`;
      const prior = seen.get(key);
      invariant(!prior || (Number(prior.fundingRate) === Number(row.fundingRate) && Number(prior.markPrice) === Number(row.markPrice)), "C_CONTEXT_FUNDING_SETTLEMENT_CONFLICT");
      if (!prior) seen.set(key, row);
    }
    if (data.length < 1000) return { rows: [...seen.values()].sort((a, b) => Number(a.fundingTime) - Number(b.fundingTime)),
      query: { requested: true, startTime, endTime, responseComplete: true, settlementCoverageEstablished: false, pages: page } };
    // Inclusive overlap retains regular/special records sharing the page-boundary timestamp.
    invariant(lastTime > pageStart, "C_CONTEXT_FUNDING_PAGINATION_NO_PROGRESS");
    pageStart = lastTime;
  }
  throw new Error("C_CONTEXT_FUNDING_PAGINATION_LIMIT");
}

/** Read-only inputs only. The caller must durably sequence the WHOLE returned payload before use.
 * `now` may be a clock function (production) or a fixed numeric clock (deterministic tests).
 * `openPositions` must also include CLOSED positions awaiting funding accounting/coverage.
 * `readText` is a test seam; production paths are fixed and no file is ever written here.
 */
export async function collectContextIngress({ sourceCursor, openPositions = [], fetchImpl = fetch, now = Date.now, readText = (file) => fs.readFile(file, "utf8") } = {}) {
  const clock = () => {
    const value = typeof now === "function" ? now() : now;
    invariant(Number.isSafeInteger(value) && value > 0, "C_CONTEXT_RECEIPT_CLOCK_INVALID");
    return value;
  };
  invariant(Array.isArray(openPositions) && openPositions.every((position) => SYMBOLS.includes(position.symbol)), "C_CONTEXT_POSITION_SYMBOL_INVALID");
  invariant(openPositions.every((position) => Number.isSafeInteger(timestamp(position.openedAt)) && timestamp(position.openedAt) > 0 &&
    (position.closedAt == null || (Number.isSafeInteger(timestamp(position.closedAt)) && timestamp(position.closedAt) >= timestamp(position.openedAt)))), "C_CONTEXT_POSITION_CLOCK_INVALID");
  const raw = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([key, file]) => [key, await readText(path.join(ROOT, file))])));
  const observedAt = clock();
  const config = JSON.parse(raw.config);
  validateConfig(config);
  const verified = verifySource(raw.ledger, sourceCursor);
  const sourceState = JSON.parse(raw.state);
  const official = JSON.parse(raw.official);
  const calendar = official.calendar;
  const attestation = { schemaVersion: 1, status: official.status === "VERIFIED_PUBLISHED_SCHEDULES_FOR_DECLARED_CATEGORIES_AS_OF_VERIFIED_AT" ? "VERIFIED_COMPLETE" : "INVALID",
    calendarSha256: sha256(calendar), evidenceSha256: sha256(raw.official), coverageStart: official.coverageStart, coverageEnd: official.coverageEnd,
    coverageEndExclusive: official.coverageEndExclusive, decisionUseNotBefore: official.decisionUseNotBefore, coveredCategories: official.coveredCategories, limitations: official.notEstablished };
  const request = async (route, params = {}) => {
    invariant(ROUTES.has(route), "C_CONTEXT_ROUTE_FORBIDDEN");
    const url = new URL(route, "https://demo-fapi.binance.com");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const startedAt = clock();
    const response = await fetchImpl(url.href, { method: "GET", redirect: "error", credentials: "omit", headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    invariant(response.ok, `C_CONTEXT_PUBLIC_FETCH_${response.status}`);
    const data = await response.json();
    const receivedAt = clock();
    invariant(receivedAt >= startedAt, "C_CONTEXT_RECEIPT_CLOCK_REVERSED");
    return { data, receivedAt, startedAt };
  };
  const time = await request("/fapi/v1/time");
  const serverTime = Number(time.data.serverTime);
  invariant(Number.isSafeInteger(serverTime) && serverTime >= time.startedAt - 10_000 && serverTime <= time.receivedAt + 1_000, "C_CONTEXT_SERVER_CLOCK_INVALID");
  const [exchange, premium] = await Promise.all([request("/fapi/v1/exchangeInfo"), request("/fapi/v1/premiumIndex")]);
  invariant(Array.isArray(premium.data), "C_CONTEXT_FUNDING_QUOTES_INVALID");
  const symbols = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < SYMBOLS.length) {
      const symbol = SYMBOLS[cursor++];
      const metadata = metadataRecord(exchange.data, symbol, exchange.receivedAt);
      const matches = premium.data.filter((row) => row.symbol === symbol);
      invariant(matches.length === 1, "C_CONTEXT_FUNDING_SYMBOL_MISSING_OR_DUPLICATE");
      const quote = matches[0];
      invariant([quote.markPrice, quote.lastFundingRate, quote.time, quote.nextFundingTime].every(numeric), "C_CONTEXT_FUNDING_QUOTE_VALUES_INVALID");
      const fundingQuote = validateFundingEvent({ schemaVersion: 1, type: "PUBLIC_MARK_FUNDING", symbol, markPrice: Number(quote.markPrice), fundingRate: Number(quote.lastFundingRate),
        eventTime: Number(quote.time), nextFundingTime: Number(quote.nextFundingTime), receivedAt: premium.receivedAt, origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH" });
      invariant(fundingQuote.eventTime >= premium.receivedAt - 120_000 && fundingQuote.eventTime <= premium.receivedAt + 1_000 && fundingQuote.nextFundingTime > fundingQuote.eventTime, "C_CONTEXT_FUNDING_QUOTE_CLOCK_INVALID");
      const rows15m = await request("/fapi/v1/klines", { symbol, interval: "15m", limit: 320 });
      const rows1h = await request("/fapi/v1/klines", { symbol, interval: "1h", limit: 1200 });
      const bars15m = closedBars(rows15m.data, "15m", serverTime);
      const bars1h = closedBars(rows1h.data, "1h", serverTime);
      const history = await fundingHistory({ symbol, positions: openPositions, serverTime, request });
      symbols[symbol] = { closedBars15m: bars15m.bars, closedBars1h: bars1h.bars, closedBarHealth: { "15m": bars15m.health, "1h": bars1h.health },
        barsReceivedAt: { "15m": rows15m.receivedAt, "1h": rows1h.receivedAt }, metadata, fundingQuote, fundingHistoryRows: history.rows, fundingQuery: history.query };
    }
  }));
  const collectedAt = clock();
  invariant(collectedAt >= observedAt, "C_CONTEXT_RECEIPT_CLOCK_REVERSED");
  return { schemaVersion: 1, type: "C_SLOW_CONTEXT_INGRESS", collectedAt: new Date(collectedAt).toISOString(), serverTime,
    source: { verifiedCursor: verified.cursor, opportunityRecords: verified.records.map((record) => ({ record, observedAt })),
      baselineAccount: { updatedAt: sourceState.updatedAt ?? null, implementationRevision: sourceState.implementationRevision ?? null, realizedEquityUsdt: sourceState.books?.["MTFX-T"]?.equityUsdt ?? null },
      strategyConfig: JSON.parse(raw.strategy), portfolioProfitProtection: config.portfolioProfitProtection,
      governanceCandidateEntryEngineeringAccepted: JSON.parse(raw.governance).orionV2AccountCompoundABCStudy?.candidateEntryEngineeringAccepted === true },
    symbols, r13: { attestation, calendar, policy: config.eventRisk,
      atCollection: r13CoverageAt({ calendar, attestation, eventTime: collectedAt, policy: config.eventRisk }),
      eligibleByOpportunityEventId: Object.fromEntries(verified.records.map((record) => [record.eventId, r13CoverageAt({ calendar, attestation, eventTime: record.marketTime, policy: config.eventRisk })])) },
    sourceHashes: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, sha256(value)])) };
}
