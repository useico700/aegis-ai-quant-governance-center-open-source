import { blockLegacyDirectLaunch } from "../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicId, readJson, sha256, stableStringify, writeJsonAtomic } from "../../agents/orion-v2/paper/runtime-utils.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-16-binance-usdm-testnet-readonly-reconciliation.json");
export const V3_EQUITY_ATTRIBUTION_AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-20-orion-v3-equity-attribution-income-ledger.json");
export const PAPER_STATE_PATH = path.join(ROOT, ".runtime", "orion-v2-mtfx", "state.json");
export const RUNTIME_ROOT = path.join(ROOT, ".runtime", "orion-v2-binance-testnet-reconciliation");
export const LATEST_PATH = path.join(RUNTIME_ROOT, "latest.json");
export const TESTNET_BASE_URL = "https://demo-fapi.binance.com";
export const KEYCHAIN_SERVICE = "aegis-orion-v2-binance-usdm-testnet";
export const KEYCHAIN_ACCOUNT = "read-only-reconciliation-v1";
export const KEYCHAIN_API_KEY_ACCOUNT = "demo-hmac-api-key-v1";
export const KEYCHAIN_API_SECRET_ACCOUNT = "demo-hmac-api-secret-v1";
const ALLOWED_PATHS = new Set(["/fapi/v1/time", "/fapi/v2/account", "/fapi/v2/positionRisk", "/fapi/v1/positionSide/dual", "/fapi/v1/openOrders", "/fapi/v1/openAlgoOrders", "/fapi/v1/income"]);
const INCOME_HISTORY_PAGE_LIMIT = 1_000;
const INCOME_HISTORY_MAX_PAGES = 100;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function assertTestnetBaseUrl(value = TESTNET_BASE_URL) {
  const url = new URL(value);
  invariant(url.protocol === "https:" && url.hostname === "demo-fapi.binance.com" && url.pathname === "/", "TESTNET_BASE_URL_NOT_ALLOWLISTED");
  return url;
}

export function assertReadOnlyRequest(method, pathname) {
  invariant(method === "GET", "TESTNET_RECONCILIATION_METHOD_NOT_READ_ONLY");
  invariant(ALLOWED_PATHS.has(pathname), "TESTNET_RECONCILIATION_ENDPOINT_NOT_ALLOWLISTED");
}

export function createSignedReadOnlyRequest(pathname, credentials, now = Date.now(), query = {}) {
  assertReadOnlyRequest("GET", pathname);
  invariant(typeof credentials?.apiKey === "string" && credentials.apiKey.length >= 8, "TESTNET_API_KEY_INVALID");
  invariant(typeof credentials?.apiSecret === "string" && credentials.apiSecret.length >= 16, "TESTNET_API_SECRET_INVALID");
  const timestamp = String(now);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    invariant(!["signature", "timestamp", "recvWindow"].includes(key), "TESTNET_RECONCILIATION_RESERVED_QUERY_PARAMETER");
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  params.set("recvWindow", "5000");
  params.set("timestamp", timestamp);
  const signature = crypto.createHmac("sha256", credentials.apiSecret).update(params.toString()).digest("hex");
  const url = assertTestnetBaseUrl();
  url.pathname = pathname;
  url.search = `${params.toString()}&signature=${signature}`;
  return {
    url: url.toString(),
    options: {
      method: "GET",
      redirect: "error",
      headers: {
        "X-MBX-APIKEY": credentials.apiKey,
        "user-agent": "aegis-orion-v2-testnet-readonly-reconciliation/1.0",
      },
    },
  };
}

export function parseKeychainCredentials(raw) {
  const parsed = JSON.parse(raw);
  invariant(parsed?.venue === "BINANCE_USDM_TESTNET", "TESTNET_KEYCHAIN_VENUE_INVALID");
  invariant(parsed?.purpose === "READ_ONLY_RECONCILIATION", "TESTNET_KEYCHAIN_PURPOSE_INVALID");
  invariant(typeof parsed?.apiKey === "string" && parsed.apiKey.trim().length >= 8, "TESTNET_KEYCHAIN_API_KEY_INVALID");
  invariant(typeof parsed?.apiSecret === "string" && parsed.apiSecret.trim().length >= 16, "TESTNET_KEYCHAIN_API_SECRET_INVALID");
  return { apiKey: parsed.apiKey.trim(), apiSecret: parsed.apiSecret.trim() };
}

export function parseSplitKeychainCredentials({ apiKey, apiSecret }) {
  invariant(typeof apiKey === "string" && apiKey.trim().length >= 8, "TESTNET_KEYCHAIN_API_KEY_INVALID");
  invariant(typeof apiSecret === "string" && apiSecret.trim().length >= 16, "TESTNET_KEYCHAIN_API_SECRET_INVALID");
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

function readKeychainPassword(account) {
  return execFileSync("/usr/bin/security", [
    "find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function loadKeychainCredentials(readPassword = null) {
  try {
    if (typeof readPassword === "function") return parseKeychainCredentials(readPassword());
    return parseSplitKeychainCredentials({
      apiKey: readKeychainPassword(KEYCHAIN_API_KEY_ACCOUNT),
      apiSecret: readKeychainPassword(KEYCHAIN_API_SECRET_ACCOUNT),
    });
  } catch {
    try {
      return parseKeychainCredentials(readKeychainPassword(KEYCHAIN_ACCOUNT));
    } catch {
      return null;
    }
  }
}

async function fetchJson(pathname, credentials, { fetchImpl = fetch, now = Date.now(), query = {}, readRetry = true } = {}) {
  const request = createSignedReadOnlyRequest(pathname, credentials, now, query);
  let response;
  try {
    response = await fetchImpl(request.url, {
      ...request.options,
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    if (readRetry) return fetchJson(pathname, credentials, { fetchImpl, now: Date.now(), query, readRetry: false });
    throw error;
  }
  if (!response.ok) {
    if (readRetry && (response.status === 429 || response.status >= 500)) {
      return fetchJson(pathname, credentials, { fetchImpl, now: Date.now(), query, readRetry: false });
    }
    throw new Error(`TESTNET_RECONCILIATION_HTTP_${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (readRetry) return fetchJson(pathname, credentials, { fetchImpl, now: Date.now(), query, readRetry: false });
    throw error;
  }
}

function normalizedSide(value) {
  return Number(value) < 0 || String(value ?? "").toUpperCase() === "SHORT" || String(value ?? "").toUpperCase() === "SELL" ? "SHORT" : "LONG";
}

export function compactPaperPositions(state) {
  return Object.values(state?.books ?? {}).flatMap((book) => (book?.openPositions ?? []).map((position) => ({
    symbol: position.symbol,
    side: normalizedSide(position.side ?? position.direction),
    quantity: Number(position.remainingQuantity ?? position.quantity ?? 0),
  }))).filter((position) => position.symbol && position.quantity > 0)
    .sort((a, b) => `${a.symbol}:${a.side}`.localeCompare(`${b.symbol}:${b.side}`));
}

export function compactTestnetPositions(rows) {
  return (Array.isArray(rows) ? rows : []).map((position) => ({
    symbol: position.symbol,
    side: Number(position.positionAmt) < 0 ? "SHORT" : "LONG",
    quantity: Math.abs(Number(position.positionAmt)),
    entryPrice: Number(position.entryPrice) || 0,
    markPrice: Number(position.markPrice) || 0,
    unrealizedProfitUsdt: Number(position.unRealizedProfit ?? position.unrealizedProfit) || 0,
    liquidationPrice: Number(position.liquidationPrice) || 0,
    leverage: Number(position.leverage) || 0,
    marginType: position.marginType ?? null,
    positionSide: position.positionSide ?? null,
  })).filter((position) => position.symbol && position.quantity > 0)
    .sort((a, b) => `${a.symbol}:${a.side}`.localeCompare(`${b.symbol}:${b.side}`));
}

export function reconcilePositions(paperPositions, testnetPositions) {
  const toMap = (positions) => new Map(positions.map((position) => [`${position.symbol}:${position.side}`, position]));
  const paper = toMap(paperPositions);
  const testnet = toMap(testnetPositions);
  const keys = [...new Set([...paper.keys(), ...testnet.keys()])].sort();
  const differences = keys.flatMap((key) => {
    const internal = paper.get(key) ?? null;
    const exchange = testnet.get(key) ?? null;
    if (internal && exchange && Math.abs(internal.quantity - exchange.quantity) < 1e-12) return [];
    return [{ key, paperQuantity: internal?.quantity ?? 0, testnetQuantity: exchange?.quantity ?? 0 }];
  });
  return { matched: differences.length === 0, differences };
}

function compactIncomeHistory(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row?.symbol ?? "",
    incomeType: row?.incomeType ?? "UNKNOWN",
    income: Number(row?.income) || 0,
    asset: row?.asset ?? null,
    info: row?.info ?? "",
    time: Number(row?.time) || null,
    transactionId: row?.tranId ?? null,
    tradeId: row?.tradeId ?? null,
  })).sort((a, b) => Number(a.time) - Number(b.time));
}

export async function fetchCompleteIncomeHistory({ credentials, fetchImpl = fetch, now = Date.now(), startTime, endTime, pageLimit = INCOME_HISTORY_PAGE_LIMIT, maxPages = INCOME_HISTORY_MAX_PAGES } = {}) {
  invariant(Number.isFinite(Number(startTime)), "TESTNET_INCOME_HISTORY_START_TIME_INVALID");
  invariant(Number.isFinite(Number(endTime)), "TESTNET_INCOME_HISTORY_END_TIME_INVALID");
  invariant(Number.isInteger(pageLimit) && pageLimit > 0 && pageLimit <= INCOME_HISTORY_PAGE_LIMIT, "TESTNET_INCOME_HISTORY_PAGE_LIMIT_INVALID");
  invariant(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= INCOME_HISTORY_MAX_PAGES, "TESTNET_INCOME_HISTORY_MAX_PAGES_INVALID");
  const rows = [];
  const fullPageHashes = new Set();
  let pagesFetched = 0;
  let complete = false;
  let stopReason = "MAX_PAGES_REACHED";
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchJson("/fapi/v1/income", credentials, {
      fetchImpl,
      now,
      query: { startTime: Number(startTime), endTime: Number(endTime), page, limit: pageLimit },
    });
    invariant(Array.isArray(batch), "TESTNET_INCOME_HISTORY_RESPONSE_INVALID");
    pagesFetched += 1;
    if (batch.length === pageLimit) {
      const pageHash = sha256(stableStringify(batch));
      if (fullPageHashes.has(pageHash)) {
        stopReason = "REPEATED_FULL_PAGE_DETECTED";
        break;
      }
      fullPageHashes.add(pageHash);
    }
    rows.push(...batch);
    if (batch.length < pageLimit) {
      complete = true;
      stopReason = "SHORT_FINAL_PAGE";
      break;
    }
  }
  return { rows, pagesFetched, pageLimit, complete, stopReason };
}

export async function reconcile({ enabled = process.env.ORION_V2_TESTNET_RECONCILIATION_ENABLED === "1", credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), paperState = null, persist = true, includeIncomeHistory = false, incomeStartTime = null } = {}) {
  const authorization = await readJson(AUTHORIZATION_PATH);
  invariant(authorization?.id === "OWNER-DIRECTIVE-BINANCE-USDM-TESTNET-READONLY-RECONCILIATION-20260816", "TESTNET_RECONCILIATION_AUTHORIZATION_INVALID");
  invariant(authorization?.permissions?.testnetOrders === false && authorization?.permissions?.realOrders === false, "TESTNET_RECONCILIATION_ORDER_BOUNDARY_INVALID");
  invariant(authorization?.scope?.fixedBaseUrl === TESTNET_BASE_URL, "TESTNET_RECONCILIATION_BASE_URL_AUTHORITY_MISMATCH");
  assertTestnetBaseUrl();
  const base = {
    schemaVersion: 1,
    authorizationId: authorization.id,
    mode: "READ_ONLY_RECONCILIATION",
    venue: "BINANCE_USDM_TESTNET",
    baseUrl: TESTNET_BASE_URL,
    checkedAt: new Date(now).toISOString(),
    ordersSubmitted: false,
    orderEndpointsPresent: false,
    paperRuntimeMutated: false,
    paperLedgerMutated: false,
    credentialsPersistedInProject: false,
  };
  if (!enabled) return { ...base, status: "DISABLED_BY_DEFAULT_NO_NETWORK", networkCalls: 0 };
  if (!credentials) return { ...base, status: "AWAITING_LOCAL_KEYCHAIN_CREDENTIALS_NO_NETWORK", networkCalls: 0 };
  let equityAttributionAuthorization = null;
  if (includeIncomeHistory) {
    equityAttributionAuthorization = await readJson(V3_EQUITY_ATTRIBUTION_AUTHORIZATION_PATH);
    invariant(equityAttributionAuthorization?.id === "OWNER-DIRECTIVE-ORION-V3-EQUITY-ATTRIBUTION-INCOME-LEDGER-20260820", "V3_EQUITY_ATTRIBUTION_AUTHORIZATION_INVALID");
    invariant(equityAttributionAuthorization?.status === "ACTIVE" && equityAttributionAuthorization?.scope?.allowedEndpoint === "GET /fapi/v1/income", "V3_EQUITY_ATTRIBUTION_ENDPOINT_NOT_AUTHORIZED");
    invariant(equityAttributionAuthorization?.scope?.fixedBaseUrl === TESTNET_BASE_URL && equityAttributionAuthorization?.scope?.readOnly === true, "V3_EQUITY_ATTRIBUTION_BOUNDARY_INVALID");
    invariant(Number.isFinite(Number(incomeStartTime)) && Number(incomeStartTime) === Number(equityAttributionAuthorization?.scope?.incomeHistoryStartTimeMs), "V3_EQUITY_ATTRIBUTION_START_TIME_INVALID");
  }
  const serverTime = await fetchJson("/fapi/v1/time", credentials, { fetchImpl, now });
  const signedNow = Number(serverTime?.serverTime) || now;
  const [account, positions, positionMode, openOrders, openAlgoOrders] = await Promise.all([
    fetchJson("/fapi/v2/account", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v2/positionRisk", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/positionSide/dual", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/openOrders", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/openAlgoOrders", credentials, { fetchImpl, now: signedNow }),
  ]);
  const incomeEndTime = includeIncomeHistory
    ? Number((await fetchJson("/fapi/v1/time", credentials, { fetchImpl, now: signedNow }))?.serverTime) || signedNow
    : signedNow;
  const incomeHistory = includeIncomeHistory ? await fetchCompleteIncomeHistory({
    credentials,
    fetchImpl,
    now: incomeEndTime,
    startTime: Number(incomeStartTime),
    endTime: incomeEndTime,
  }) : null;
  const incomeRows = incomeHistory?.rows ?? null;
  const currentPaperState = paperState ?? await readJson(PAPER_STATE_PATH, {});
  const paperPositions = compactPaperPositions(currentPaperState);
  const testnetPositions = compactTestnetPositions(positions);
  const reconciliation = reconcilePositions(paperPositions, testnetPositions);
  const snapshot = {
    ...base,
    status: reconciliation.matched ? "RECONCILED_READ_ONLY" : "READ_ONLY_DIFFERENCE_DETECTED",
    networkCalls: 6 + (includeIncomeHistory ? 1 : 0) + (incomeHistory?.pagesFetched ?? 0),
    serverTime: Number(serverTime?.serverTime) || null,
    accountCanTrade: account?.canTrade === true,
    accountMode: {
      multiAssetsMargin: account?.multiAssetsMargin === true,
      dualSidePosition: positionMode?.dualSidePosition,
      oneWayPositionModeObserved: positionMode?.dualSidePosition === false && testnetPositions.every((position) => position.positionSide === "BOTH"),
    },
    accountEquity: {
      totalWalletBalanceUsdt: Number(account?.totalWalletBalance) || 0,
      totalUnrealizedProfitUsdt: Number(account?.totalUnrealizedProfit) || 0,
      totalMarginBalanceUsdt: Number(account?.totalMarginBalance) || 0,
      availableBalanceUsdt: Number(account?.availableBalance) || 0,
      totalInitialMarginUsdt: Number(account?.totalInitialMargin) || 0,
      totalMaintMarginUsdt: Number(account?.totalMaintMargin) || 0,
    },
    incomeHistory: includeIncomeHistory ? compactIncomeHistory(incomeRows) : null,
    incomeHistoryMeta: includeIncomeHistory ? {
      authorizationId: equityAttributionAuthorization.id,
      endpoint: "GET /fapi/v1/income",
      startTime: Number(incomeStartTime),
      endTime: incomeEndTime,
      pagesFetched: incomeHistory.pagesFetched,
      pageLimit: incomeHistory.pageLimit,
      rowCount: Array.isArray(incomeRows) ? incomeRows.length : 0,
      complete: incomeHistory.complete,
      stopReason: incomeHistory.stopReason,
    } : null,
    testnetStandardOpenOrderCount: Array.isArray(openOrders) ? openOrders.length : null,
    testnetOpenAlgoOrderCount: Array.isArray(openAlgoOrders) ? openAlgoOrders.length : null,
    testnetOpenOrderCount: Array.isArray(openOrders) && Array.isArray(openAlgoOrders) ? openOrders.length + openAlgoOrders.length : null,
    testnetOpenOrders: (Array.isArray(openOrders) ? openOrders : []).map((order) => ({
      symbol: order.symbol,
      orderId: order.orderId ?? null,
      clientOrderId: order.clientOrderId ?? null,
      side: order.side ?? null,
      positionSide: order.positionSide ?? null,
      type: order.type ?? null,
      status: order.status ?? null,
      reduceOnly: order.reduceOnly === true,
      closePosition: order.closePosition === true,
    })),
    testnetOpenAlgoOrders: (Array.isArray(openAlgoOrders) ? openAlgoOrders : []).map((order) => ({
      symbol: order.symbol,
      algoId: order.algoId ?? null,
      clientAlgoId: order.clientAlgoId ?? null,
      side: order.side ?? null,
      positionSide: order.positionSide ?? null,
      algoStatus: order.algoStatus ?? order.status ?? null,
      triggerPrice: Number(order.triggerPrice) || 0,
      closePosition: order.closePosition === true,
      workingType: order.workingType ?? null,
      priceProtect: order.priceProtect === true,
    })),
    paperPositions,
    testnetPositions,
    reconciliation,
  };
  snapshot.snapshotId = deterministicId("binance_testnet_readonly_snapshot", {
    checkedAt: snapshot.checkedAt,
    serverTime: snapshot.serverTime,
    paperPositions,
    testnetPositions,
    standardOpenOrderCount: snapshot.testnetStandardOpenOrderCount,
    openAlgoOrderCount: snapshot.testnetOpenAlgoOrderCount,
    incomeHistoryEndTime: snapshot.incomeHistoryMeta?.endTime ?? null,
    incomeHistoryRowCount: snapshot.incomeHistoryMeta?.rowCount ?? null,
  });
  snapshot.snapshotHash = sha256(stableStringify(snapshot));
  if (persist) await writeJsonAtomic(LATEST_PATH, snapshot);
  return snapshot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await reconcile(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "FAIL_CLOSED", error: error?.message ?? String(error), ordersSubmitted: false })}\n`);
    process.exitCode = 1;
  }
}
