import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeKlines } from "../paper/paper-engine.mjs";
import {
  buildCandidateSummary,
  inputStatus,
  sha256,
  stableStringify,
  validateDepthEvent,
  validateFundingEvent,
  validateLedgerSourceEvent,
  validateMetadataRecord,
  validateQuoteEvent,
  validateTradeEvent,
} from "./contracts.mjs";
import { applyFundingSettlement, applyIndependentEntry, applyIndependentR21Action, applyR22MarketObservation, classifyCompletedCampaigns, deriveIndependentEntry, evaluateEntryHardGate, initialCandidateState, observeConfirmedAccountHigh, planAccountProtectionDeleverage, recomputeAccount, seedHealthyForwardBaseline, validateStateTransition } from "./engine.mjs";
import { deriveIndependentR22Trail, evaluateIndependentR21, r13CoverageAt, validateClosedBarSeries } from "./evidence.mjs";
import { AppendOnlyLedger, ledgerPaths } from "./ledger.mjs";
import { BASELINE_REVISION, C_POLICY } from "./policy.mjs";
import { readJsonIfPresent, runtimePaths, writeJsonAtomic } from "./persistence.mjs";
import { LocalResourceGuard } from "./resource-guard.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(MODULE_DIR, "../../..");
export const DEFAULT_RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime/orion-v2-account-shadow-c");
export const SOURCE_STATE_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/state.json");
export const SOURCE_LEDGER_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/ledger.ndjson");
export const SOURCE_CONFIG_PATH = path.join(PROJECT_ROOT, "agents/orion-v2/paper/config.json");
export const EVENT_CALENDAR_PATH = path.join(PROJECT_ROOT, "agents/nexus/data/mtfx-tier1-event-calendar.json");
export const R13_OFFICIAL_EVIDENCE_PATH = path.join(PROJECT_ROOT, "governance/evidence/v2-c-r13-official-calendar-20260906.json");
export const STRATEGY_CONFIG_PATH = path.join(PROJECT_ROOT, "experiments/v2-mtf-trendline-intersection/config.json");
export const GOVERNANCE_STATE_PATH = path.join(PROJECT_ROOT, "governance/current-state.json");

function requireInvariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function validateReadOnlySourceConfig(config) {
  requireInvariant(config?.implementationRevision === BASELINE_REVISION, "C_SOURCE_REVISION_MISMATCH");
  requireInvariant(config?.venue?.signedRequestsAllowed === false, "C_SIGNED_SOURCE_REQUESTS_FORBIDDEN");
  requireInvariant(config?.venue?.apiKeysAllowed === false, "C_SOURCE_API_KEYS_FORBIDDEN");
  requireInvariant(config?.venue?.orderEndpointsAllowed === false, "C_SOURCE_ORDER_ENDPOINTS_FORBIDDEN");
  requireInvariant(config?.execution?.realOrdersAllowed === false && config?.execution?.testnetOrdersAllowed === false, "C_SOURCE_ORDER_MODE_FORBIDDEN");
  const symbols = config?.venue?.universe?.symbols;
  requireInvariant(Array.isArray(symbols) && symbols.length === 10 && new Set(symbols).size === 10, "C_FIXED_UNIVERSE_INVALID");
  requireInvariant(config.venue.restBaseUrl === "https://demo-fapi.binance.com", "C_PUBLIC_REST_ORIGIN_INVALID");
  return config;
}

export async function readVerifiedSourceLedger(filePath = SOURCE_LEDGER_PATH) {
  const raw = await fs.readFile(filePath, "utf8");
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  let previousHash = "GENESIS";
  let sequence = 0;
  const records = [];
  for (const line of complete.split("\n").filter(Boolean)) {
    const record = JSON.parse(line);
    validateLedgerSourceEvent(record);
    const base = { sequence: record.sequence, previousHash: record.previousHash, eventId: record.eventId, type: record.type, marketTime: record.marketTime, payload: record.payload };
    requireInvariant(record.sequence === sequence + 1, "C_SOURCE_LEDGER_SEQUENCE_GAP");
    requireInvariant(record.previousHash === previousHash, "C_SOURCE_LEDGER_PREVIOUS_HASH_MISMATCH");
    requireInvariant(record.hash === sha256(stableStringify(base)), "C_SOURCE_LEDGER_HASH_MISMATCH");
    records.push(record);
    sequence = record.sequence;
    previousHash = record.hash;
  }
  return { records, cursor: { sequence, hash: previousHash } };
}

function asNumber(value, code) {
  const number = Number(value);
  requireInvariant(Number.isFinite(number), code);
  return number;
}

export function normalizeMetadata(exchangeInfo, symbol, receivedAt) {
  const source = exchangeInfo.symbols.find((candidate) => candidate.symbol === symbol);
  requireInvariant(source, "C_METADATA_SYMBOL_MISSING");
  const filter = (type) => source.filters.find((candidate) => candidate.filterType === type) ?? {};
  const price = filter("PRICE_FILTER");
  const lot = filter("LOT_SIZE");
  const minimumNotional = filter("MIN_NOTIONAL");
  const record = {
    schemaVersion: 1,
    type: "PUBLIC_EXCHANGE_METADATA",
    symbol,
    status: source.status,
    contractType: source.contractType,
    tickSize: asNumber(price.tickSize, "C_METADATA_TICK_SIZE_INVALID"),
    stepSize: asNumber(lot.stepSize, "C_METADATA_STEP_SIZE_INVALID"),
    minQty: asNumber(lot.minQty, "C_METADATA_MIN_QTY_INVALID"),
    minNotional: asNumber(minimumNotional.notional ?? minimumNotional.minNotional ?? 0, "C_METADATA_MIN_NOTIONAL_INVALID"),
    sourceAsOf: new Date(receivedAt).toISOString(),
    sourceSha256: sha256(stableStringify(exchangeInfo)),
    origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH",
  };
  return validateMetadataRecord(record);
}

export function normalizeQuote(raw, receivedAt) {
  return validateQuoteEvent({
    schemaVersion: 1,
    type: "PUBLIC_BBO",
    symbol: raw.symbol,
    bid: asNumber(raw.bidPrice, "C_QUOTE_BID_INVALID"),
    ask: asNumber(raw.askPrice, "C_QUOTE_ASK_INVALID"),
    bidQuantity: asNumber(raw.bidQty, "C_QUOTE_BID_QTY_INVALID"),
    askQuantity: asNumber(raw.askQty, "C_QUOTE_ASK_QTY_INVALID"),
    updateId: Number(raw.lastUpdateId ?? 0),
    eventTime: Number(raw.time ?? receivedAt),
    transactionTime: Number(raw.time ?? receivedAt),
    receivedAt,
    origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH",
  });
}

export function normalizeDepth(raw, symbol, receivedAt) {
  return validateDepthEvent({
    schemaVersion: 1,
    type: "PUBLIC_PARTIAL_DEPTH",
    symbol,
    lastUpdateId: Number(raw.lastUpdateId),
    eventTime: Number(raw.E ?? receivedAt),
    transactionTime: Number(raw.T ?? raw.E ?? receivedAt),
    receivedAt,
    bids: raw.bids.map(([price, quantity]) => [Number(price), Number(quantity)]),
    asks: raw.asks.map(([price, quantity]) => [Number(price), Number(quantity)]),
    snapshotSemantics: "TOP_LEVELS_COMPLETE_AT_EVENT_NOT_FULL_DIFF_HISTORY",
    origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH",
  });
}

export function normalizeFunding(raw, receivedAt) {
  return validateFundingEvent({
    schemaVersion: 1,
    type: "PUBLIC_MARK_FUNDING",
    symbol: raw.symbol,
    markPrice: asNumber(raw.markPrice, "C_FUNDING_MARK_INVALID"),
    fundingRate: asNumber(raw.lastFundingRate, "C_FUNDING_RATE_INVALID"),
    eventTime: Number(raw.time ?? receivedAt),
    nextFundingTime: Number(raw.nextFundingTime),
    receivedAt,
    origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH",
  });
}

export function normalizeTrade(raw, symbol, receivedAt, evidenceScope = "FORWARD_PUBLIC_TRADE") {
  return validateTradeEvent({
    schemaVersion: 1,
    type: "PUBLIC_AGG_TRADE",
    symbol,
    aggregateTradeId: Number(raw.a),
    price: asNumber(raw.p, "C_TRADE_PRICE_INVALID"),
    quantity: asNumber(raw.q, "C_TRADE_QUANTITY_INVALID"),
    buyerWasMaker: Boolean(raw.m),
    eventTime: Number(raw.T),
    tradeTime: Number(raw.T),
    receivedAt,
    evidenceScope,
    origin: "BINANCE_USDM_PUBLIC_REST_NO_AUTH",
  });
}

async function fetchJson(url, timeoutMs = 8_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`C_PUBLIC_FETCH_${response.status}`);
  return response.json();
}

async function collectBarEvidence({ baseUrl, symbols, serverTime, state, runtimeRoot, ledger }) {
  state.marketCursors.bars15m ??= {};
  state.marketCursors.bars1h ??= {};
  const bundles = new Map();
  await Promise.all(symbols.map(async (symbol) => {
    const [rows15m, rows1h] = await Promise.all([
      fetchJson(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=320`),
      fetchJson(`${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1200`),
    ]);
    const bars15m = normalizeKlines(rows15m, serverTime);
    const bars1h = normalizeKlines(rows1h, serverTime);
    const health15m = validateClosedBarSeries(bars15m, "15m", serverTime);
    const health1h = validateClosedBarSeries(bars1h, "1h", serverTime);
    const prior15m = Number(state.marketCursors.bars15m[symbol] ?? 0);
    const prior1h = Number(state.marketCursors.bars1h[symbol] ?? 0);
    const events = [];
    if (!prior15m || !prior1h) {
      events.push({ type: "INDICATOR_WARMUP_ATTESTED", observedAt: serverTime, payload: { symbol, evidenceScope: "INDICATOR_WARMUP_ONLY_NOT_ENTRY_OR_FILL", bars15m: bars15m.length, bars1h: bars1h.length, sha256: sha256(stableStringify({ bars15m, bars1h })) }, eventId: eventId("bar_warmup", { symbol, firstObservedAt: state.createdAt }) });
    }
    for (const [interval, bars, prior] of [["15m", bars15m, prior15m], ["1h", bars1h, prior1h]]) {
      for (const bar of bars.filter((candidate) => candidate.closeTime > prior)) {
        events.push({ type: "FORWARD_CLOSED_BAR", observedAt: serverTime, payload: { symbol, interval, evidenceScope: "FORWARD_INDICATOR_INPUT_NOT_FILL", ...bar }, eventId: eventId("bar", { symbol, interval, openTime: bar.openTime }) });
      }
    }
    await writeJsonAtomic(path.join(runtimeRoot, "warmup", `${symbol}.json`), { schemaVersion: 1, symbol, capturedAt: new Date(serverTime).toISOString(), evidenceScope: "INDICATOR_WARMUP_ONLY_NOT_HISTORICAL_CANDIDATE_OR_FILL", bars15m, bars1h, health15m, health1h });
    bundles.set(symbol, { bars15m, bars1h, health15m, health1h, events });
  }));
  await ledger.appendMany([...bundles.values()].flatMap((bundle) => bundle.events));
  for (const [symbol, bundle] of bundles) {
    state.marketCursors.bars15m[symbol] = bundle.bars15m.at(-1)?.closeTime ?? 0;
    state.marketCursors.bars1h[symbol] = bundle.bars1h.at(-1)?.closeTime ?? 0;
  }
  return bundles;
}

export function observeFundingSchedules(state, fundingRecords, observedAt) {
  const next = structuredClone(state);
  next.marketCursors.fundingSchedule ??= {};
  for (const funding of fundingRecords) {
    const symbol = funding.symbol;
    const nextFundingTime = Number(funding.nextFundingTime);
    requireInvariant(Number.isFinite(nextFundingTime) && nextFundingTime > 0, "C_NEXT_FUNDING_TIME_INVALID");
    const book = next.marketCursors.fundingSchedule[symbol] ?? { currentNextFundingTime: null, currentObservedAt: null, expected: [] };
    const priorTime = Number(book.currentNextFundingTime);
    if (Number.isFinite(priorTime) && priorTime > 0 && priorTime !== nextFundingTime) {
      const prior = book.expected.find((item) => item.fundingTime === priorTime && item.status === "SCHEDULED");
      if (prior && priorTime > observedAt) {
        prior.status = "SUPERSEDED_BEFORE_DUE";
        prior.supersededAt = new Date(observedAt).toISOString();
      }
    }
    let expected = book.expected.find((item) => item.fundingTime === nextFundingTime);
    if (!expected) {
      expected = { fundingTime: nextFundingTime, status: "SCHEDULED", firstObservedAt: new Date(observedAt).toISOString() };
      book.expected.push(expected);
    } else if (expected.status === "SUPERSEDED_BEFORE_DUE") {
      expected.status = "SCHEDULED";
      delete expected.supersededAt;
    }
    expected.lastObservedAt = new Date(observedAt).toISOString();
    book.currentNextFundingTime = nextFundingTime;
    book.currentObservedAt = new Date(observedAt).toISOString();
    book.expected = book.expected.sort((a, b) => a.fundingTime - b.fundingTime).slice(-200);
    next.marketCursors.fundingSchedule[symbol] = book;
  }
  return next;
}

export function reconcileFundingEvidence(state, { symbol, rows, serverTime }) {
  let next = state;
  const applied = [];
  const grouped = new Map();
  for (const row of rows) {
    requireInvariant(row.symbol === symbol && ["Regular", "Special", undefined].includes(row.rateType), "C_FUNDING_HISTORY_CONTRACT_INVALID");
    const fundingTime = Number(row.fundingTime);
    const prior = grouped.get(fundingTime);
    const markPrice = Number(row.markPrice);
    if (prior && Math.abs(prior.markPrice - markPrice) > 1e-8) throw new Error("C_FUNDING_HISTORY_MARK_CONFLICT");
    grouped.set(fundingTime, { symbol, fundingTime, fundingRate: Number(prior?.fundingRate ?? 0) + Number(row.fundingRate), markPrice });
  }
  for (const settlement of [...grouped.values()].sort((a, b) => a.fundingTime - b.fundingTime)) {
    if (![settlement.fundingTime, settlement.fundingRate, settlement.markPrice].every(Number.isFinite)) throw new Error("C_FUNDING_HISTORY_INVALID");
    const before = next;
    next = applyFundingSettlement(next, settlement);
    if (next !== before) applied.push({ ...settlement, costUsdt: next.account.cumulativeFundingUsdt - before.account.cumulativeFundingUsdt });
    next.marketCursors.fundingSettlements ??= {};
    next.marketCursors.fundingSettlements[symbol] = Math.max(Number(next.marketCursors.fundingSettlements[symbol] ?? 0), settlement.fundingTime);
    const schedule = next.marketCursors.fundingSchedule?.[symbol];
    if (schedule) {
      let proof = schedule.expected.find((item) => item.fundingTime === settlement.fundingTime);
      if (!proof) {
        proof = { fundingTime: settlement.fundingTime, firstObservedAt: new Date(serverTime).toISOString() };
        schedule.expected.push(proof);
      }
      proof.status = "RESOLVED_BY_HISTORY";
      proof.resolvedAt = new Date(serverTime).toISOString();
    }
  }
  const schedule = next.marketCursors.fundingSchedule?.[symbol];
  if (schedule) {
    for (const position of [...next.positions, ...next.closedPositions].filter((item) => item.symbol === symbol)) {
      const end = Number(position.closedAt ?? serverTime);
      const applicable = schedule.expected.filter((item) => item.status !== "SUPERSEDED_BEFORE_DUE" && item.fundingTime > position.openedAt && item.fundingTime <= end);
      const unresolved = applicable.filter((item) => item.status !== "RESOLVED_BY_HISTORY");
      if (!unresolved.length && Number(schedule.currentNextFundingTime) > end) {
        position.fundingCoverageThrough = Math.max(Number(position.fundingCoverageThrough ?? 0), end);
      } else {
        const firstUnresolved = Math.min(...unresolved.map((item) => item.fundingTime), Infinity);
        const resolvedThrough = Math.max(...applicable.filter((item) => item.status === "RESOLVED_BY_HISTORY" && item.fundingTime < firstUnresolved).map((item) => item.fundingTime), Number(position.fundingCoverageThrough ?? 0));
        position.fundingCoverageThrough = Math.min(end, resolvedThrough);
      }
    }
  }
  return { state: next, applied };
}

export async function settleFunding({ baseUrl, state, serverTime, eventsLedger, feesLedger }) {
  state.marketCursors.fundingSettlements ??= {};
  const fundingPending = [...state.positions, ...state.closedPositions].filter((position) => Number(position.fundingCoverageThrough ?? 0) < Number(position.closedAt ?? serverTime));
  const symbols = [...new Set(fundingPending.map((position) => position.symbol))];
  let next = state;
  const events = [];
  const fees = [];
  for (const symbol of symbols) {
    const symbolPositions = [...next.positions, ...next.closedPositions].filter((candidate) => candidate.symbol === symbol && Number(candidate.fundingCoverageThrough ?? 0) < Number(candidate.closedAt ?? serverTime));
    const earliest = Math.min(...symbolPositions.map((candidate) => Number(candidate.lastFundingTime ?? candidate.openedAt)), serverTime);
    const cursor = Number.isFinite(earliest) ? earliest : serverTime;
    const rows = await fetchJson(`${baseUrl}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${Math.max(0, cursor + 1)}&endTime=${serverTime}&limit=1000`);
    const reconciled = reconcileFundingEvidence(next, { symbol, rows, serverTime });
    next = reconciled.state;
    for (const settlement of reconciled.applied) {
        const payload = { ...settlement, cashAccounting: "C_REALIZED_CASH_DEBIT_POSITIVE_OR_CREDIT_NEGATIVE" };
        events.push({ type: "FUNDING_SETTLED", observedAt: serverTime, payload, eventId: eventId("funding_settlement", { symbol, fundingTime: settlement.fundingTime }) });
        fees.push({ type: "FUNDING_COST", observedAt: serverTime, payload, eventId: eventId("funding_fee", { symbol, fundingTime: settlement.fundingTime }) });
    }
  }
  await eventsLedger.appendMany(events);
  await feesLedger.appendMany(fees);
  return next;
}

function eventId(domain, payload) {
  return `c_${domain}_${sha256(stableStringify(payload)).slice(0, 24)}`;
}

export function createDepthPool(state, depths, consumptionLedger) {
  const latestLedger = new Map();
  for (const record of consumptionLedger.records) latestLedger.set(record.payload.symbol, record.payload);
  const pool = new Map();
  for (const [symbol, depth] of depths) {
    const persisted = latestLedger.get(symbol) ?? state.depthConsumption?.[symbol];
    if (Number.isFinite(Number(persisted?.lastUpdateId)) && depth.lastUpdateId < Number(persisted.lastUpdateId)) {
      throw new Error(`C_DEPTH_SNAPSHOT_UPDATE_ID_REGRESSION_${symbol}`);
    }
    const sameSnapshot = Number(persisted?.lastUpdateId) === depth.lastUpdateId;
    pool.set(symbol, { depth: { ...depth, bids: structuredClone(sameSnapshot ? persisted.bidsRemaining : depth.bids), asks: structuredClone(sameSnapshot ? persisted.asksRemaining : depth.asks) }, consumed: false });
  }
  return pool;
}

function snapshotDepthPool(state, pool) {
  state.depthConsumption ??= {};
  for (const [symbol, entry] of pool) {
    state.depthConsumption[symbol] = {
      symbol,
      lastUpdateId: entry.depth.lastUpdateId,
      bidsRemaining: structuredClone(entry.depth.bids),
      asksRemaining: structuredClone(entry.depth.asks),
    };
  }
}

async function deliverAuditBatch(ledgers, audits) {
  for (const [domain, items] of Object.entries(audits)) {
    requireInvariant(ledgers[domain] && Array.isArray(items), `C_EXECUTION_AUDIT_DOMAIN_INVALID_${domain}`);
    await ledgers[domain].appendMany(items);
  }
}

function depthAuditItem(pool, symbol, observedAt, commitId) {
  const entry = pool.get(symbol);
  const payload = { symbol, lastUpdateId: entry.depth.lastUpdateId, bidsRemaining: structuredClone(entry.depth.bids), asksRemaining: structuredClone(entry.depth.asks), commitId };
  return { type: "DEPTH_LIQUIDITY_CONSUMED", observedAt, payload, eventId: eventId("depth_execution_commit", { commitId, symbol, remainingSha256: sha256(stableStringify(payload)) }) };
}

export async function commitStateAndAudits({ stateFile, state, pool, ledgers, commitId, observedAt, audits }) {
  if (pool) snapshotDepthPool(state, pool);
  requireInvariant(!state.pendingExecutionCommit, "C_PRIOR_EXECUTION_COMMIT_PENDING");
  state.pendingExecutionCommit = { schemaVersion: 1, commitId, observedAt, audits };
  await writeJsonAtomic(stateFile, state);
  await deliverAuditBatch(ledgers, audits);
  state.pendingExecutionCommit = null;
  await writeJsonAtomic(stateFile, state);
  return state;
}

export async function recoverPendingExecutionCommit({ stateFile, state, ledgers }) {
  if (!state?.pendingExecutionCommit) return state;
  await deliverAuditBatch(ledgers, state.pendingExecutionCommit.audits);
  state.pendingExecutionCommit = null;
  await writeJsonAtomic(stateFile, state);
  return state;
}

export function consumeDepth(pool, symbol, side, quantity) {
  const entry = pool.get(symbol);
  if (!entry) throw new Error("C_DEPTH_POOL_SYMBOL_MISSING");
  let remaining = quantity;
  for (const level of entry.depth[side]) {
    const take = Math.min(remaining, level[1]);
    level[1] = Math.max(0, level[1] - take);
    remaining -= take;
    if (remaining <= 1e-10) break;
  }
  if (remaining > 1e-8) throw new Error("C_DEPTH_CONSUMPTION_RECONCILIATION_FAILED");
  entry.consumed = true;
}

export async function persistDepthPool(state, pool, ledger, observedAt) {
  state.depthConsumption ??= {};
  for (const [symbol, entry] of pool) {
    const payload = { symbol, lastUpdateId: entry.depth.lastUpdateId, bidsRemaining: entry.depth.bids, asksRemaining: entry.depth.asks };
    state.depthConsumption[symbol] = payload;
    if (entry.consumed) await ledger.append("DEPTH_LIQUIDITY_CONSUMED", observedAt, payload, eventId("depth_consumption", { symbol, lastUpdateId: entry.depth.lastUpdateId, remainingSha256: sha256(stableStringify(payload)) }));
  }
}

export function calculateBaselineAccountObservation(sourceState, quoteMap, config) {
  const book = sourceState?.books?.["MTFX-T"];
  requireInvariant(book && Number.isFinite(book.equityUsdt), "C_BASELINE_BOOK_INVALID");
  let openNetPnl = 0;
  for (const position of book.openPositions ?? []) {
    const quote = quoteMap.get(position.symbol);
    requireInvariant(quote, `C_BASELINE_QUOTE_MISSING_${position.symbol}`);
    const rawExit = position.direction === 1 ? quote.bid : quote.ask;
    const exit = rawExit * (position.direction === 1 ? 1 - config.paperRisk.adverseSlippageRate : 1 + config.paperRisk.adverseSlippageRate);
    const gross = position.direction * (exit - position.entry) * position.quantity;
    const remainingEntryFee = Number(position.entryFee ?? 0) * Number(position.quantity) / Number(position.originalQuantity ?? position.quantity);
    const exitFee = exit * position.quantity * config.paperRisk.takerFeeRate;
    openNetPnl += gross - remainingEntryFee - exitFee;
  }
  return {
    realizedEquityUsdt: book.equityUsdt,
    liquidationNetEquityUsdt: book.equityUsdt + openNetPnl,
    openNetPnlUsdt: openNetPnl,
  };
}

const LEDGER_CACHE = new Map();
const RESOURCE_GUARD_CACHE = new Map();

export function invalidateRuntimeCaches(runtimeRoot = DEFAULT_RUNTIME_ROOT) {
  LEDGER_CACHE.delete(runtimeRoot);
  RESOURCE_GUARD_CACHE.delete(runtimeRoot);
}

async function resourceGuardFor(runtimeRoot) {
  if (!RESOURCE_GUARD_CACHE.has(runtimeRoot)) RESOURCE_GUARD_CACHE.set(runtimeRoot, await LocalResourceGuard.create(runtimeRoot));
  const guard = RESOURCE_GUARD_CACHE.get(runtimeRoot);
  await guard.refresh();
  return guard;
}

async function initializeLedgers(runtimeRoot, resourceGuard) {
  if (LEDGER_CACHE.has(runtimeRoot)) return LEDGER_CACHE.get(runtimeRoot);
  const paths = ledgerPaths(runtimeRoot);
  const result = {};
  const invalidateAll = () => invalidateRuntimeCaches(runtimeRoot);
  for (const [domain, filePath] of Object.entries(paths)) {
    const ledger = new AppendOnlyLedger(filePath, domain.toUpperCase(), { retainRecords: domain === "depthConsumption", onUnsafeAppend: invalidateAll, resourceGuard });
    await ledger.initialize();
    result[domain] = ledger;
  }
  LEDGER_CACHE.set(runtimeRoot, result);
  return result;
}

function aggregateInputHealth({ now, sourceState, sourceCursor, config, quotes, depths, funding, metadata }) {
  const symbols = config.venue.universe.symbols;
  const age = (timestamp) => Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
  const quoteAsOf = Math.min(...symbols.map((symbol) => quotes.get(symbol)?.receivedAt ?? 0));
  const depthAsOf = Math.min(...symbols.map((symbol) => depths.get(symbol)?.receivedAt ?? 0));
  const fundingAsOf = Math.min(...symbols.map((symbol) => funding.get(symbol)?.receivedAt ?? 0));
  const metadataAsOf = Math.min(...symbols.map((symbol) => Date.parse(metadata.get(symbol)?.sourceAsOf ?? 0)));
  const baselineHealthy = sourceState.implementationRevision === BASELINE_REVISION && now - sourceState.updatedAt <= 30_000;
  const healthy = (map) => symbols.every((symbol) => map.has(symbol));
  const inputs = {
    baselineAccount: inputStatus(baselineHealthy ? "HEALTHY" : "STALE", new Date(sourceState.updatedAt).toISOString(), age(sourceState.updatedAt)),
    eventLedger: inputStatus("HEALTHY", new Date(now).toISOString(), 0, { cursor: sourceCursor.sequence }),
    quote: inputStatus(healthy(quotes) && age(quoteAsOf) <= 1_000 ? "HEALTHY" : "STALE", quoteAsOf ? new Date(quoteAsOf).toISOString() : null, age(quoteAsOf), { cursor: Math.max(...[...quotes.values()].map((item) => item.updateId)) }),
    depth: inputStatus(healthy(depths) && age(depthAsOf) <= 1_000 ? "HEALTHY" : "STALE", depthAsOf ? new Date(depthAsOf).toISOString() : null, age(depthAsOf), { cursor: Math.max(...[...depths.values()].map((item) => item.lastUpdateId)) }),
    funding: inputStatus(healthy(funding) && age(fundingAsOf) <= 120_000 ? "HEALTHY" : "STALE", fundingAsOf ? new Date(fundingAsOf).toISOString() : null, age(fundingAsOf), { cursor: Math.max(...[...funding.values()].map((item) => item.eventTime)) }),
    metadata: inputStatus(healthy(metadata) && age(metadataAsOf) <= 86_400_000 ? "HEALTHY" : "STALE", metadataAsOf ? new Date(metadataAsOf).toISOString() : null, age(metadataAsOf), { sha256: healthy(metadata) ? sha256(stableStringify([...metadata.values()])) : null }),
  };
  const blockers = Object.entries(inputs).filter(([, input]) => input.status !== "HEALTHY").map(([name]) => `${name.toUpperCase()}_NOT_HEALTHY`);
  return { inputs, blockers };
}

async function fetchTrades({ baseUrl, symbol, state }) {
  const prior = state.marketCursors.trades?.[symbol] ?? null;
  const url = prior == null
    ? `${baseUrl}/fapi/v1/aggTrades?symbol=${symbol}&limit=1`
    : `${baseUrl}/fapi/v1/aggTrades?symbol=${symbol}&fromId=${prior + 1}&limit=1000`;
  const raw = await fetchJson(url);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (prior != null && Number(raw[0].a) !== prior + 1) throw new Error(`C_PUBLIC_TRADE_CURSOR_GAP_${symbol}`);
  return raw.map((item) => {
    const receivedAt = Date.now();
    const scope = prior == null ? "CURSOR_BOOTSTRAP_NOT_FILL_EVIDENCE" : "FORWARD_PUBLIC_TRADE";
    return normalizeTrade(item, symbol, receivedAt, scope);
  });
}

function assertSourceCursorContinuity(state, verified) {
  const cursor = state.sourceCursor;
  requireInvariant(cursor.sequence <= verified.cursor.sequence, "C_SOURCE_LEDGER_TRUNCATED");
  if (cursor.sequence > 0) requireInvariant(verified.records[cursor.sequence - 1]?.hash === cursor.hash, "C_PERSISTED_SOURCE_CURSOR_HASH_MISMATCH");
}

async function recordForwardSourceEvents(state, verified, ledger) {
  assertSourceCursorContinuity(state, verified);
  const opportunities = [];
  for (const record of verified.records.slice(state.sourceCursor.sequence)) {
    if (record.type === "PAPER_POSITION_OPENED" && record.payload?.book === "MTFX-T") {
      const observed = {
        sourceEventId: record.eventId,
        sourceSequence: record.sequence,
        observedAt: Date.now(),
        baselinePositionId: record.payload.id,
        symbol: record.payload.symbol,
      };
      opportunities.push({ record, observed });
      await ledger.append("BASELINE_EXECUTED_OPPORTUNITY_SUBSET_OBSERVED", observed.observedAt, observed, eventId("source", observed));
    }
    state.sourceCursor = { sequence: record.sequence, hash: record.hash };
  }
  return opportunities;
}

export async function collectOnce({ runtimeRoot = DEFAULT_RUNTIME_ROOT, resourceGuard: providedResourceGuard = null } = {}) {
  const runtime = runtimePaths(runtimeRoot);
  const resourceGuard = providedResourceGuard ?? await resourceGuardFor(runtimeRoot);
  if (providedResourceGuard) await resourceGuard.refresh();
  const resourceStatus = resourceGuard.status();
  if (resourceStatus.paused) {
    const pausedState = await readJsonIfPresent(runtime.state);
    if (pausedState && !pausedState.localResourcePauseAppliedAt) {
      pausedState.localResource = resourceStatus;
      pausedState.blockers = [...new Set([...(pausedState.blockers ?? []), "LOCAL_RESOURCE_PAUSED"] )];
      for (const position of pausedState.positions ?? []) {
        position.evidenceEligibility = { ...(position.evidenceEligibility ?? {}), continuousTickBboDepth: false, noUnknownSameBarPath: false, reason: "CAPTURE_INCOMPLETE_RESOURCE_PAUSE" };
      }
      pausedState.localResourcePauseAppliedAt = new Date().toISOString();
      await resourceGuard.writeControlJson(runtime.state, pausedState);
    }
    throw new Error(`LOCAL_RESOURCE_PAUSED_${resourceStatus.pauseReason ?? "LATCHED"}`);
  }
  const config = validateReadOnlySourceConfig(JSON.parse(await fs.readFile(SOURCE_CONFIG_PATH, "utf8")));
  const officialEvidenceRaw = await fs.readFile(R13_OFFICIAL_EVIDENCE_PATH, "utf8");
  const officialEvidence = JSON.parse(officialEvidenceRaw);
  const calendar = officialEvidence.calendar;
  const r13Attestation = {
    schemaVersion: 1,
    status: officialEvidence.status === "VERIFIED_PUBLISHED_SCHEDULES_FOR_DECLARED_CATEGORIES_AS_OF_VERIFIED_AT" ? "VERIFIED_COMPLETE" : "INVALID",
    calendarSha256: sha256(stableStringify(calendar)),
    evidenceSha256: sha256(officialEvidenceRaw),
    coverageStart: officialEvidence.coverageStart,
    coverageEnd: officialEvidence.coverageEnd,
    coverageEndExclusive: officialEvidence.coverageEndExclusive,
    decisionUseNotBefore: officialEvidence.decisionUseNotBefore,
    coveredCategories: officialEvidence.coveredCategories,
    limitations: officialEvidence.notEstablished,
  };
  await writeJsonAtomic(path.join(runtimeRoot, "r13-coverage-attestation.json"), r13Attestation);
  const strategy = JSON.parse(await fs.readFile(STRATEGY_CONFIG_PATH, "utf8"));
  const sourceState = JSON.parse(await fs.readFile(SOURCE_STATE_PATH, "utf8"));
  const governanceState = JSON.parse(await fs.readFile(GOVERNANCE_STATE_PATH, "utf8"));
  const verified = await readVerifiedSourceLedger();
  const existing = await readJsonIfPresent(runtime.state);
  const carryIns = (sourceState.books?.["MTFX-T"]?.openPositions ?? []).map((position) => position.id);
  let state = existing ?? initialCandidateState({ createdAt: new Date().toISOString(), sourceCursor: verified.cursor, carryInPositionIds: carryIns });
  state.governanceCandidateEntryEngineeringAccepted = governanceState.orionV2AccountCompoundABCStudy?.candidateEntryEngineeringAccepted === true;
  state.blockers = state.blockers.filter((value) => value !== "CANDIDATE_ENTRY_ENGINEERING_NOT_ACCEPTED");
  if (!state.governanceCandidateEntryEngineeringAccepted) state.blockers.push("CANDIDATE_ENTRY_ENGINEERING_NOT_ACCEPTED");
  state.blockers = state.blockers.filter((value) => !["RAW_EVIDENCE_RETENTION_POLICY_PENDING_OWNER_CONFIRMATION", "LOCAL_RESOURCE_BUDGET_NOT_IMPLEMENTED", "LOCAL_RESOURCE_ENTRY_SOFT_LIMIT"].includes(value));
  state.localResource = resourceStatus;
  state.capabilities.localResourceBudget = true;
  if (!resourceStatus.newCandidateEntriesAllowed && !resourceStatus.paused) state.blockers.push("LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
  state.capabilities.independentRebalanceAccounting ??= true;
  state.capabilities.continuousTickBboDepthCapture = false;
  if (!state.blockers.includes("CONTINUOUS_TICK_BBO_DEPTH_CAPTURE_INCOMPLETE")) state.blockers.push("CONTINUOUS_TICK_BBO_DEPTH_CAPTURE_INCOMPLETE");
  if (state.lastHealthyAccountObservationAt && Date.now() - Date.parse(state.lastHealthyAccountObservationAt) > 45_000) {
    state.healthFrameExclusions = [...(state.healthFrameExclusions ?? []), { at: new Date().toISOString(), reason: "HEALTHY_FRAME_GAP_EXCEEDED_45S_NO_INTERPOLATION" }].slice(-100);
    state.healthyAccountFrameCount = 0;
    state.lastHealthyAccountObservationAt = null;
    state.pendingHighProof = null;
    state.healthEpoch = Number(state.healthEpoch ?? 0) + 1;
  }
  const ledgers = await initializeLedgers(runtimeRoot, resourceGuard);
  state = await recoverPendingExecutionCommit({ stateFile: runtime.state, state, ledgers });
  const previous = structuredClone(state);
  const sourceOpportunities = existing ? await recordForwardSourceEvents(state, verified, ledgers.events) : [];
  state.marketCursors.trades ??= {};
  const baseUrl = config.venue.restBaseUrl;
  const serverTime = Number((await fetchJson(`${baseUrl}/fapi/v1/time`)).serverTime);
  requireInvariant(Number.isFinite(serverTime), "C_PUBLIC_SERVER_TIME_INVALID");
  const metadataReceivedAt = Date.now();
  const exchangeInfo = await fetchJson(`${baseUrl}/fapi/v1/exchangeInfo`);
  const metadata = new Map();
  for (const symbol of config.venue.universe.symbols) {
    const record = normalizeMetadata(exchangeInfo, symbol, metadataReceivedAt);
    metadata.set(symbol, record);
    await ledgers.metadata.append(record.type, metadataReceivedAt, record, eventId("metadata", record));
  }
  const barBundles = await collectBarEvidence({ baseUrl, symbols: config.venue.universe.symbols, serverTime, state, runtimeRoot, ledger: ledgers.bars });
  const rawFunding = await fetchJson(`${baseUrl}/fapi/v1/premiumIndex`);
  const fundingBySymbol = new Map(rawFunding.map((item) => [item.symbol, item]));
  const fundingScheduleRecords = config.venue.universe.symbols.map((symbol) => normalizeFunding(fundingBySymbol.get(symbol), Date.now()));
  state = observeFundingSchedules(state, fundingScheduleRecords, serverTime);
  try {
    state = await settleFunding({ baseUrl, state, serverTime, eventsLedger: ledgers.events, feesLedger: ledgers.fees });
    state.capabilities.fundingSettlement = true;
  } catch (error) {
    state.capabilities.fundingSettlement = false;
    state.blockers.push("FUNDING_SETTLEMENT_STREAM_NOT_READY");
    state.lastFundingSettlementError = error.message;
  }
  const quotes = new Map();
  const depths = new Map();
  const funding = new Map();
  const allTrades = [];
  const marketBundles = await Promise.all(config.venue.universe.symbols.map(async (symbol) => {
    const [rawDepth, trades] = await Promise.all([
      fetchJson(`${baseUrl}/fapi/v1/depth?symbol=${symbol}&limit=20`),
      fetchTrades({ baseUrl, symbol, state }),
    ]);
    return { symbol, depth: normalizeDepth(rawDepth, symbol, Date.now()), trades };
  }));
  const rawQuotes = await fetchJson(`${baseUrl}/fapi/v1/ticker/bookTicker`);
  const quoteBySymbol = new Map(rawQuotes.map((item) => [item.symbol, item]));
  for (const bundle of marketBundles) {
    const { symbol } = bundle;
    const receivedAt = Date.now();
    const quote = normalizeQuote(quoteBySymbol.get(symbol), receivedAt);
    const fundingRecord = normalizeFunding(fundingBySymbol.get(symbol), receivedAt);
    const depth = bundle.depth;
    quotes.set(symbol, quote); depths.set(symbol, depth); funding.set(symbol, fundingRecord);
    await ledgers.quotes.append(quote.type, quote.receivedAt, quote, eventId("quote", quote));
    await ledgers.depth.append(depth.type, depth.receivedAt, depth, eventId("depth", depth));
    await ledgers.funding.append(fundingRecord.type, fundingRecord.receivedAt, fundingRecord, eventId("funding", fundingRecord));
    for (const trade of bundle.trades) {
      allTrades.push({ type: trade.type, observedAt: trade.receivedAt, payload: trade, eventId: eventId("trade", trade) });
      state.marketCursors.trades[symbol] = trade.aggregateTradeId;
    }
  }
  await ledgers.trades.appendMany(allTrades);
  state.marketCursors.quotes = Object.fromEntries([...quotes].map(([symbol, value]) => [symbol, value.updateId]));
  state.marketCursors.depth = Object.fromEntries([...depths].map(([symbol, value]) => [symbol, value.lastUpdateId]));
  state.marketCursors.funding = Object.fromEntries([...funding].map(([symbol, value]) => [symbol, value.eventTime]));
  state.marketCursors.metadataSha256 = sha256(stableStringify([...metadata.values()]));
  const now = Date.now();
  const inputHealth = aggregateInputHealth({ now, sourceState, sourceCursor: verified.cursor, config, quotes, depths, funding, metadata });
  const baseline = calculateBaselineAccountObservation(sourceState, quotes, config);
  const depthPool = createDepthPool(state, depths, ledgers.depthConsumption);
  if (!state.startedAt) {
    state = seedHealthyForwardBaseline(state, { ...baseline, inputs: inputHealth.inputs, sourceAsOf: new Date(now).toISOString() });
  } else {
    const candidateMarks = Object.fromEntries(state.positions.map((position) => {
      const quote = quotes.get(position.symbol);
      const executable = position.direction === 1
        ? quote.bid * (1 - C_POLICY.adverseSlippageRate)
        : quote.ask * (1 + C_POLICY.adverseSlippageRate);
      return [position.symbol, { price: executable, observedAt: quote.receivedAt }];
    }));
    recomputeAccount(state, candidateMarks, { valuationAt: now });
    const bookId = sha256(stableStringify(config.venue.universe.symbols.map((symbol) => ({
      symbol,
      quoteUpdateId: quotes.get(symbol)?.updateId,
      depthUpdateId: depths.get(symbol)?.lastUpdateId,
    }))));
    state = observeConfirmedAccountHigh(state, {
      sourceAsOf: new Date(now).toISOString(),
      liquidationNetEquityUsdt: state.account.liquidationNetEquityUsdt,
      healthy: inputHealth.blockers.length === 0,
      bookId,
    });
  }
  const r13Now = r13CoverageAt({ calendar, attestation: r13Attestation, eventTime: serverTime, policy: config.eventRisk });
  state.capabilities.r13Calendar = r13Now.ready;
  const r22Ready = [...barBundles.values()].every((bundle) => bundle.health15m.healthy && bundle.health1h.healthy);
  state.capabilities.r22CausalIndicators = r22Ready;
  state.capabilities.r22IndependentManagement = r22Ready && state.capabilities.continuousTickBboDepthCapture;
  for (const current of [...state.positions]) {
    const bars = barBundles.get(current.symbol);
    const trail = deriveIndependentR22Trail({ position: current, bars15m: bars?.bars15m, bars1h: bars?.bars1h, strategy, r21Config: config.portfolioProfitProtection, serverTime });
    const result = applyR22MarketObservation(state, current.symbol, { quote: quotes.get(current.symbol), depth: depthPool.get(current.symbol).depth, metadata: metadata.get(current.symbol) }, trail);
    if (result.blockers.length) { state.blockers.push(...result.blockers); continue; }
    const priorPosition = state.positions.find((candidate) => candidate.id === current.id);
    state = result.state;
    const nextPosition = [...state.positions, ...state.closedPositions].find((candidate) => candidate.id === current.id);
    if (result.events.length) {
      consumeDepth(depthPool, current.symbol, current.direction === 1 ? "bids" : "asks", result.events.reduce((sum, event) => sum + event.quantity, 0));
      const position = [...state.positions, ...state.closedPositions].find((candidate) => candidate.id === current.id);
      const commitId = eventId("commit_r22", { positionId: current.id, at: serverTime, position });
      await commitStateAndAudits({ stateFile: runtime.state, state, pool: depthPool, ledgers, commitId, observedAt: serverTime, audits: {
        events: result.events.map((event) => ({ type: event.reason, observedAt: serverTime, payload: { positionId: current.id, commitId, ...event }, eventId: eventId("r22", { positionId: current.id, reason: event.reason, at: serverTime }) })),
        fees: result.events.map((event) => ({ type: "EXIT_FEE", observedAt: serverTime, payload: { positionId: current.id, commitId, amountUsdt: event.exitFeeUsdt, reason: event.reason }, eventId: eventId("exit_fee", { positionId: current.id, reason: event.reason, at: serverTime }) })),
        positions: [{ type: "POSITION_STATE", observedAt: serverTime, payload: position, eventId: eventId("position_r22", { positionId: current.id, at: serverTime, position }) }],
        depthConsumption: [depthAuditItem(depthPool, current.symbol, serverTime, commitId)],
      } });
      depthPool.get(current.symbol).consumed = false;
    } else if (stableStringify(priorPosition) !== stableStringify(nextPosition)) {
      const commitId = eventId("commit_r22_trail", { positionId: current.id, at: serverTime, position: nextPosition });
      await commitStateAndAudits({ stateFile: runtime.state, state, pool: null, ledgers, commitId, observedAt: serverTime, audits: {
        positions: [{ type: "POSITION_STATE_R22_TRAIL_ONLY", observedAt: serverTime, payload: nextPosition, eventId: eventId("position_r22_trail", { positionId: current.id, at: serverTime, position: nextPosition }) }],
      } });
    }
  }
  const r21 = evaluateIndependentR21({ state, quotes, now: serverTime, config: config.portfolioProfitProtection });
  state.r21State = r21.state;
  state.r21FrozenDirections = r21.frozenDirections;
  state.capabilities.r21PortfolioProtection = r21.ready;
  state.blockers = state.blockers.filter((blocker) => ![
    "R13_CALENDAR_COVERAGE_NOT_READY",
    "R21_FULL_PORTFOLIO_PROTECTION_INPUT_NOT_READY",
    "R22_CONFIRMED_1H_AND_CLOSED_15M_ATR_TRAIL_INPUT_NOT_READY",
    "FUNDING_SETTLEMENT_STREAM_NOT_READY",
    "R21_REBALANCE_ACTION_EXECUTION_NOT_READY",
    "BASELINE_EXECUTED_OPPORTUNITY_SUBSET_NOT_COMPLETE_SIGNAL_UNIVERSE",
  ].includes(blocker));
  if (!r13Now.ready) state.blockers.push(r13Now.blocker ?? "R13_CALENDAR_COVERAGE_NOT_READY");
  if (!r21.ready) state.blockers.push("R21_FULL_PORTFOLIO_PROTECTION_INPUT_NOT_READY");
  const actionKey = (action) => `${action.type}:${action.positionId}`;
  const pendingByKey = new Map([...(state.pendingR21Actions ?? []), ...r21.actions].map((action) => [actionKey(action), action]));
  state.pendingR21Actions = [...pendingByKey.values()];
  for (const action of [...state.pendingR21Actions]) {
    const target = state.positions.find((candidate) => candidate.id === action.positionId);
    const result = applyIndependentR21Action(state, action, { quote: quotes.get(action.symbol), depth: depthPool.get(action.symbol).depth, metadata: metadata.get(action.symbol) });
    if (result.blockers.length) { state.blockers.push("R21_REBALANCE_ACTION_EXECUTION_PENDING", ...result.blockers); continue; }
    state = result.state;
    consumeDepth(depthPool, action.symbol, target.direction === 1 ? "bids" : "asks", result.event.quantity);
    state.pendingR21Actions = state.pendingR21Actions.filter((candidate) => actionKey(candidate) !== actionKey(action));
    const position = [...state.positions, ...state.closedPositions].find((candidate) => candidate.id === action.positionId);
    const commitId = eventId("commit_r21", { action, at: serverTime, position });
    await commitStateAndAudits({ stateFile: runtime.state, state, pool: depthPool, ledgers, commitId, observedAt: serverTime, audits: {
      events: [{ type: "R21_REBALANCE_APPLIED", observedAt: serverTime, payload: { positionId: action.positionId, action: action.type, commitId, event: result.event }, eventId: eventId("r21_action", { action, at: serverTime }) }],
      fees: [{ type: "R21_REBALANCE_COST", observedAt: serverTime, payload: { positionId: action.positionId, commitId, amountUsdt: result.event.rebalanceCostUsdt }, eventId: eventId("r21_cost", { action, at: serverTime }) }],
      positions: [{ type: "POSITION_STATE", observedAt: serverTime, payload: position, eventId: eventId("position_r21", { action, at: serverTime, position }) }],
      depthConsumption: [depthAuditItem(depthPool, action.symbol, serverTime, commitId)],
    } });
    depthPool.get(action.symbol).consumed = false;
  }
  const protectionActions = planAccountProtectionDeleverage(state);
  for (const action of protectionActions) {
    const target = state.positions.find((candidate) => candidate.id === action.positionId);
    const result = applyIndependentR21Action(state, action, { quote: quotes.get(action.symbol), depth: depthPool.get(action.symbol).depth, metadata: metadata.get(action.symbol) });
    if (result.blockers.length) { state.blockers.push("ACCOUNT_PROTECTION_REBALANCE_PENDING", ...result.blockers); continue; }
    state = result.state;
    consumeDepth(depthPool, action.symbol, target.direction === 1 ? "bids" : "asks", result.event.quantity);
    const position = [...state.positions, ...state.closedPositions].find((candidate) => candidate.id === action.positionId);
    const commitId = eventId("commit_account_protection", { action, at: serverTime, position });
    await commitStateAndAudits({ stateFile: runtime.state, state, pool: depthPool, ledgers, commitId, observedAt: serverTime, audits: {
      events: [{ type: "ACCOUNT_PROTECTION_REBALANCE_APPLIED", observedAt: serverTime, payload: { positionId: action.positionId, action: action.type, commitId, event: result.event }, eventId: eventId("account_protection", { action, at: serverTime }) }],
      fees: [{ type: "ACCOUNT_PROTECTION_REBALANCE_COST", observedAt: serverTime, payload: { positionId: action.positionId, commitId, amountUsdt: result.event.rebalanceCostUsdt }, eventId: eventId("account_protection_cost", { action, at: serverTime }) }],
      positions: [{ type: "POSITION_STATE", observedAt: serverTime, payload: position, eventId: eventId("position_account_protection", { action, at: serverTime, position }) }],
      depthConsumption: [depthAuditItem(depthPool, action.symbol, serverTime, commitId)],
    } });
    depthPool.get(action.symbol).consumed = false;
  }
  if (!r22Ready) state.blockers.push("R22_CONFIRMED_1H_AND_CLOSED_15M_ATR_TRAIL_INPUT_NOT_READY");
  for (const { record, observed } of sourceOpportunities) {
    const r13 = r13CoverageAt({ calendar, attestation: r13Attestation, eventTime: record.marketTime, policy: config.eventRisk });
    const bars = barBundles.get(record.payload.symbol);
    const trail = deriveIndependentR22Trail({ position: null, bars15m: bars?.bars15m, bars1h: bars?.bars1h, strategy, r21Config: config.portfolioProfitProtection, serverTime });
    const candidateMarket = {
      quote: quotes.get(record.payload.symbol),
      depth: depthPool.get(record.payload.symbol).depth,
      funding: funding.get(record.payload.symbol),
      metadata: metadata.get(record.payload.symbol),
    };
    const context = {
      r13Eligible: r13.ready && r13.eligible,
      r21PortfolioProtectionReady: r21.ready,
      r21EntryFrozen: r21.frozenDirections.includes(record.payload.direction),
      r22TrailInputsReady: trail.inputsReady,
      r15ReplacementExecutionReady: true,
      localResourceEntryAllowed: resourceGuard.status().newCandidateEntriesAllowed,
      allInputsHealthy: inputHealth.blockers.length === 0,
      continuousCaptureVerified: state.capabilities.continuousTickBboDepthCapture === true,
      candidateEntryEngineeringAccepted: state.governanceCandidateEntryEngineeringAccepted,
      sourceObservedAt: observed.observedAt,
    };
    state.localResource = await resourceGuard.refresh();
    context.localResourceEntryAllowed = state.localResource.newCandidateEntriesAllowed;
    state.blockers = state.blockers.filter((value) => value !== "LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
    if (!context.localResourceEntryAllowed) state.blockers.push("LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
    const existingSameSymbol = state.positions.find((candidate) => candidate.symbol === record.payload.symbol);
    if (existingSameSymbol) {
      const preliminary = deriveIndependentEntry(state, record, candidateMarket, context);
      if (preliminary.accepted) {
        const closeAction = { type: "ACCOUNT_PROTECTION_CLOSE", positionId: existingSameSymbol.id, symbol: existingSameSymbol.symbol, reason: "R15_CLOSE_OLD_BEFORE_CONFIRMED_OPPOSITE_CURRENT_STRUCTURE" };
        const closed = applyIndependentR21Action(state, closeAction, candidateMarket);
        if (!closed.blockers.length) {
          state = closed.state;
          consumeDepth(depthPool, existingSameSymbol.symbol, existingSameSymbol.direction === 1 ? "bids" : "asks", closed.event.quantity);
          const position = state.closedPositions.find((candidate) => candidate.id === existingSameSymbol.id);
          const commitId = eventId("commit_r15_close", { sourceEventId: record.eventId, position });
          await commitStateAndAudits({ stateFile: runtime.state, state, pool: depthPool, ledgers, commitId, observedAt: serverTime, audits: {
            events: [{ type: "R15_REPLACEMENT_OLD_POSITION_CLOSED", observedAt: serverTime, payload: { positionId: existingSameSymbol.id, commitId, event: closed.event }, eventId: eventId("r15_close", { sourceEventId: record.eventId, positionId: existingSameSymbol.id }) }],
            fees: [{ type: "R15_REPLACEMENT_COST", observedAt: serverTime, payload: { positionId: existingSameSymbol.id, commitId, amountUsdt: closed.event.rebalanceCostUsdt }, eventId: eventId("r15_cost", { sourceEventId: record.eventId, positionId: existingSameSymbol.id }) }],
            positions: [{ type: "POSITION_STATE", observedAt: serverTime, payload: position, eventId: eventId("position_r15_close", { sourceEventId: record.eventId, position }) }],
            depthConsumption: [depthAuditItem(depthPool, existingSameSymbol.symbol, serverTime, commitId)],
          } });
          depthPool.get(existingSameSymbol.symbol).consumed = false;
          candidateMarket.depth = depthPool.get(record.payload.symbol).depth;
        } else context.r15ReplacementExecutionReady = false;
      }
    }
    state.localResource = await resourceGuard.refresh();
    context.localResourceEntryAllowed = state.localResource.newCandidateEntriesAllowed;
    state.blockers = state.blockers.filter((value) => value !== "LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
    if (!context.localResourceEntryAllowed) state.blockers.push("LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
    let derived = deriveIndependentEntry(state, record, candidateMarket, context);
    if (derived.accepted) {
      state.localResource = await resourceGuard.refresh();
      context.localResourceEntryAllowed = state.localResource.newCandidateEntriesAllowed;
      if (!context.localResourceEntryAllowed) {
        state.blockers.push("LOCAL_RESOURCE_ENTRY_SOFT_LIMIT");
        derived = { accepted: false, blockers: ["C_ENTRY_HARD_GATE_LOCAL_RESOURCE_NOT_ALLOWED"] };
      }
    }
    const opportunity = { ...observed, disposition: derived.accepted ? "CANDIDATE_C_ENTRY_RECORDED" : "BLOCKED_NO_C_FILL", blockers: derived.blockers };
    state.opportunities.push(opportunity);
    if (derived.accepted) {
      if (!evaluateEntryHardGate(state, context).open) throw new Error("C_COLLECTOR_ENTRY_HARD_GATE_BYPASS_ATTEMPT");
      derived.position.evidenceEligibility = { continuousTickBboDepth: false, sourceHashContinuous: true, noUnknownSameBarPath: false, reason: "REST_BBO_DEPTH_SNAPSHOTS_DO_NOT_PROVE_INTER_SNAPSHOT_PATH" };
      state = applyIndependentEntry(state, derived);
      consumeDepth(depthPool, record.payload.symbol, record.payload.direction === 1 ? "asks" : "bids", derived.position.quantity);
      const committedAt = Date.now();
      const commitId = eventId("commit_entry", { sourceEventId: record.eventId, position: derived.position });
      await commitStateAndAudits({ stateFile: runtime.state, state, pool: depthPool, ledgers, commitId, observedAt: committedAt, audits: {
        events: [{ type: "CANDIDATE_ENTRY_RECORDED", observedAt: committedAt, payload: { sourceEventId: record.eventId, candidatePositionId: derived.position.id, commitId }, eventId: eventId("entry", derived.position) }],
        fees: [{ type: derived.fee.type, observedAt: committedAt, payload: { candidatePositionId: derived.position.id, commitId, ...derived.fee }, eventId: eventId("entry_fee", derived.position) }],
        positions: [{ type: "POSITION_STATE", observedAt: committedAt, payload: derived.position, eventId: eventId("position_open", derived.position) }],
        depthConsumption: [depthAuditItem(depthPool, record.payload.symbol, committedAt, commitId)],
      } });
      depthPool.get(record.payload.symbol).consumed = false;
    }
  }
  state.blockers = [...new Set(state.blockers)];
  state = classifyCompletedCampaigns(state);
  await persistDepthPool(state, depthPool, ledgers.depthConsumption, serverTime);
  if (inputHealth.blockers.length === 0) {
    state.lastHealthyAccountObservationAt = new Date(now).toISOString();
  } else {
    state.healthFrameExclusions = [...(state.healthFrameExclusions ?? []), { at: new Date(now).toISOString(), reason: "INPUT_HEALTH_FAILURE_RESETS_TWO_FRAME_CONFIRMATION", blockers: inputHealth.blockers }].slice(-100);
    state.healthyAccountFrameCount = 0;
    state.lastHealthyAccountObservationAt = null;
    state.pendingHighProof = null;
    state.healthEpoch = Number(state.healthEpoch ?? 0) + 1;
  }
  state.lastInputHealth = inputHealth;
  state.lastCollectorCycleAt = new Date(now).toISOString();
  validateStateTransition(previous, state);
  await writeJsonAtomic(runtime.state, state);
  await writeJsonAtomic(path.join(runtimeRoot, "latest-summary.json"), buildCandidateSummary(state, inputHealth, state.publicationSequence + 1, new Date(now).toISOString()));
  return { runtimeRoot, sourceCursor: state.sourceCursor, state, inputHealth, baseline };
}

export async function invalidateHealthyFrame(runtimeRoot = DEFAULT_RUNTIME_ROOT, reason = "COLLECTOR_CYCLE_FAILED") {
  const filePath = runtimePaths(runtimeRoot).state;
  const state = await readJsonIfPresent(filePath);
  if (!state) return null;
  state.healthyAccountFrameCount = 0;
  state.lastHealthyAccountObservationAt = null;
  state.pendingHighProof = null;
  state.healthEpoch = Number(state.healthEpoch ?? 0) + 1;
  state.healthFrameExclusions = [...(state.healthFrameExclusions ?? []), { at: new Date().toISOString(), reason }].slice(-100);
  await writeJsonAtomic(filePath, state);
  return state;
}

export async function runCollector({ runtimeRoot = DEFAULT_RUNTIME_ROOT, intervalMs = 1_000 } = {}) {
  for (;;) {
    try { await collectOnce({ runtimeRoot }); }
    catch (error) {
      await writeJsonAtomic(path.join(runtimeRoot, "collector-error.json"), { at: new Date().toISOString(), code: error.message, failClosed: true });
    }
    await delay(intervalMs);
  }
}

async function main() {
  const command = process.argv[2] ?? "once";
  if (command === "once") {
    const result = await collectOnce();
    console.log(JSON.stringify({ status: result.state.startedAt ? "COLLECTED_FAIL_CLOSED" : "WAITING_HEALTHY_BASELINE", runtimeRoot: result.runtimeRoot, sourceCursor: result.sourceCursor, blockers: result.state.blockers, inputBlockers: result.inputHealth.blockers }, null, 2));
    return;
  }
  if (command === "run") return runCollector();
  if (command === "status") {
    console.log(JSON.stringify(await readJsonIfPresent(runtimePaths(DEFAULT_RUNTIME_ROOT).state), null, 2));
    return;
  }
  throw new Error("USAGE: collector.mjs [once|run|status]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
