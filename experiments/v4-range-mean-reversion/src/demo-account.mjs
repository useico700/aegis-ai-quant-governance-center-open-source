import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_SOURCE_AUTHORIZATION_PATH,
  GOVERNANCE_PATH,
  PROJECT_ROOT,
} from "./context.mjs";
import { invariant, readJson, sha256, stableStringify, writeJsonAtomic } from "./utils.mjs";

export const DEMO_BASE_URL = "https://demo-fapi.binance.com";
export const KEYCHAIN_SERVICE = "aegis-orion-v4-binance-usdm-demo";
export const KEYCHAIN_API_KEY_ACCOUNT = "v4-execution-hmac-api-key-v1";
export const KEYCHAIN_API_SECRET_ACCOUNT = "v4-execution-hmac-api-secret-v1";
export const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime", "orion-v4-binance-demo");
export const LATEST_PATH = path.join(RUNTIME_ROOT, "latest.json");

const ALLOWED_PATHS = new Set([
  "/fapi/v1/time",
  "/fapi/v2/account",
  "/fapi/v2/positionRisk",
  "/fapi/v1/positionSide/dual",
  "/fapi/v1/openOrders",
  "/fapi/v1/openAlgoOrders",
]);

export function assertDemoBaseUrl(value = DEMO_BASE_URL) {
  const url = new URL(value);
  invariant(
    url.protocol === "https:" && url.hostname === "demo-fapi.binance.com" && url.pathname === "/",
    "V4_DEMO_BASE_URL_NOT_ALLOWLISTED",
  );
  return url;
}

export function assertReadOnlyRequest(method, pathname) {
  invariant(method === "GET", "V4_DEMO_METHOD_NOT_READ_ONLY");
  invariant(ALLOWED_PATHS.has(pathname), "V4_DEMO_ENDPOINT_NOT_ALLOWLISTED");
}

export function parseSplitKeychainCredentials({ apiKey, apiSecret }) {
  invariant(typeof apiKey === "string" && apiKey.trim().length >= 8, "V4_DEMO_API_KEY_INVALID");
  invariant(typeof apiSecret === "string" && apiSecret.trim().length >= 16, "V4_DEMO_API_SECRET_INVALID");
  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

function readKeychainPassword(account) {
  return execFileSync("/usr/bin/security", [
    "find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function loadKeychainCredentials(readPassword = readKeychainPassword) {
  try {
    return parseSplitKeychainCredentials({
      apiKey: readPassword(KEYCHAIN_API_KEY_ACCOUNT),
      apiSecret: readPassword(KEYCHAIN_API_SECRET_ACCOUNT),
    });
  } catch {
    return null;
  }
}

export function createSignedReadOnlyRequest(pathname, credentials, now = Date.now(), query = {}) {
  assertReadOnlyRequest("GET", pathname);
  const normalized = parseSplitKeychainCredentials(credentials);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    invariant(!["signature", "timestamp", "recvWindow"].includes(key), "V4_DEMO_RESERVED_QUERY_PARAMETER");
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  params.set("recvWindow", "5000");
  params.set("timestamp", String(now));
  const signature = crypto.createHmac("sha256", normalized.apiSecret).update(params.toString()).digest("hex");
  const url = assertDemoBaseUrl();
  url.pathname = pathname;
  url.search = `${params.toString()}&signature=${signature}`;
  return {
    url: url.toString(),
    options: {
      method: "GET",
      redirect: "error",
      headers: {
        "X-MBX-APIKEY": normalized.apiKey,
        "user-agent": "orion-v4-binance-demo-readonly/1.0",
      },
    },
  };
}

async function fetchJson(pathname, credentials, { fetchImpl, now }) {
  const request = createSignedReadOnlyRequest(pathname, credentials, now);
  const response = await fetchImpl(request.url, {
    ...request.options,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`V4_DEMO_HTTP_${response.status}`);
  return response.json();
}

function compactPositions(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row?.symbol ?? null,
    side: Number(row?.positionAmt) < 0 ? "SHORT" : "LONG",
    quantity: Math.abs(Number(row?.positionAmt) || 0),
    entryPrice: Number(row?.entryPrice) || 0,
    markPrice: Number(row?.markPrice) || 0,
    unrealizedProfitUsdt: Number(row?.unRealizedProfit ?? row?.unrealizedProfit) || 0,
    leverage: Number(row?.leverage) || 0,
    marginType: row?.marginType ?? null,
    positionSide: row?.positionSide ?? null,
  })).filter((row) => row.symbol && row.quantity > 0)
    .sort((a, b) => `${a.symbol}:${a.side}`.localeCompare(`${b.symbol}:${b.side}`));
}

function compactOrders(rows, orderKind = "STANDARD") {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    symbol: row?.symbol ?? null,
    orderId: row?.orderId ?? row?.algoId ?? null,
    clientOrderId: row?.clientOrderId ?? row?.clientAlgoId ?? null,
    algoId: row?.algoId ?? null,
    clientAlgoId: row?.clientAlgoId ?? null,
    side: row?.side ?? null,
    positionSide: row?.positionSide ?? null,
    type: row?.type ?? row?.orderType ?? null,
    status: row?.status ?? null,
    reduceOnly: row?.reduceOnly === true,
    closePosition: row?.closePosition === true,
    algoStatus: row?.algoStatus ?? null,
    triggerPrice: Number(row?.triggerPrice ?? row?.stopPrice) || null,
    workingType: row?.workingType ?? null,
    priceProtect: row?.priceProtect === true,
    orderKind,
  })).filter((row) => row.symbol);
}

export async function snapshotV4DemoAccount({
  enabled = process.env.ORION_V4_BINANCE_DEMO_READONLY_ENABLED === "1",
  credentials = loadKeychainCredentials(),
  fetchImpl = fetch,
  now = Date.now(),
  persist = true,
} = {}) {
  const [governance, authorization] = await Promise.all([
    readJson(GOVERNANCE_PATH),
    readJson(DATA_SOURCE_AUTHORIZATION_PATH),
  ]);
  const governed = governance?.orionV4RangeResearch ?? {};
  const domain = governance?.executionDomains?.orionV4RangeResearch ?? {};
  invariant(["ACTIVE_AWAITING_DEDICATED_CREDENTIAL_PROVISIONING", "ACTIVE_PLATFORM_READY_AWAITING_STRATEGY_ACTIVATION", "ACTIVE_EXECUTION_PLATFORM_READY_STRATEGY_FAIL_CLOSED", "ACTIVE"].includes(authorization?.status), "V4_DEMO_AUTHORIZATION_NOT_ACTIVE");
  invariant(governed.dataSourceAuthorizationId === authorization.id, "V4_DEMO_GOVERNANCE_AUTHORIZATION_MISMATCH");
  invariant(domain.dataSourceAuthorizationId === authorization.id, "V4_DEMO_EXECUTION_DOMAIN_AUTHORIZATION_MISMATCH");
  invariant(authorization.scope?.fixedBaseUrl === DEMO_BASE_URL, "V4_DEMO_AUTHORIZED_HOST_MISMATCH");
  invariant(authorization.permissions?.orderEndpointCapabilityPrepared === true && authorization.permissions?.realOrdersAllowed === false, "V4_DEMO_ORDER_BOUNDARY_INVALID");
  invariant(domain.exchangeCredentialsScope === "ORION_V4_DEDICATED_BINANCE_USDM_DEMO_EXECUTION_KEYCHAIN_ONLY", "V4_DEMO_CREDENTIAL_SCOPE_INVALID");
  assertDemoBaseUrl();

  const base = {
    schemaVersion: 1,
    authorizationId: authorization.id,
    strategyVersion: governed.strategyVersion,
    implementationRevision: governed.implementationRevision,
    mode: "V4_BINANCE_USDM_DEMO_EXECUTION_PLATFORM_ACCOUNT_SOURCE",
    product: "USD_M_PERPETUAL",
    venue: "BINANCE_USDM_DEMO",
    baseUrl: DEMO_BASE_URL,
    checkedAt: new Date(now).toISOString(),
    strategyCapitalBaselineAsset: "USDT",
    strategyCapitalBaselineUsdt: 5000,
    ordersSubmitted: false,
    orderEndpointCapabilityPrepared: true,
    matchingEngineOrderSubmissionAllowed: governed.matchingEngineOrderSubmissionAllowed === true,
    residentScannerStarted: false,
    forwardPositionsGenerated: false,
    credentialsPersistedInProject: false,
    v2OrV3RuntimeMutated: false,
    v2OrV3LedgerMutated: false,
  };
  if (!enabled) return { ...base, status: "DISABLED_BY_DEFAULT_NO_NETWORK", networkCalls: 0 };
  if (!credentials) return { ...base, status: "AWAITING_DEDICATED_V4_KEYCHAIN_CREDENTIALS_NO_NETWORK", networkCalls: 0 };

  const serverTime = await fetchJson("/fapi/v1/time", credentials, { fetchImpl, now });
  const signedNow = Number(serverTime?.serverTime) || now;
  const [account, positions, positionMode, standardOrders, algoOrders] = await Promise.all([
    fetchJson("/fapi/v2/account", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v2/positionRisk", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/positionSide/dual", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/openOrders", credentials, { fetchImpl, now: signedNow }),
    fetchJson("/fapi/v1/openAlgoOrders", credentials, { fetchImpl, now: signedNow }),
  ]);
  const openPositions = compactPositions(positions);
  const openStandardOrders = compactOrders(standardOrders, "STANDARD");
  const openAlgoOrders = compactOrders(algoOrders, "ALGO");
  const snapshot = {
    ...base,
    status: "READ_ONLY_ACCOUNT_SNAPSHOT",
    networkCalls: 6,
    serverTime: Number(serverTime?.serverTime) || null,
    accountCanTrade: account?.canTrade === true,
    accountMode: {
      multiAssetsMargin: account?.multiAssetsMargin === true,
      dualSidePosition: positionMode?.dualSidePosition,
      oneWayPositionModeObserved: positionMode?.dualSidePosition === false,
    },
    accountEquity: {
      totalWalletBalanceUsdt: Number(account?.totalWalletBalance) || 0,
      totalUnrealizedProfitUsdt: Number(account?.totalUnrealizedProfit) || 0,
      totalMarginBalanceUsdt: Number(account?.totalMarginBalance) || 0,
      availableBalanceUsdt: Number(account?.availableBalance) || 0,
      totalInitialMarginUsdt: Number(account?.totalInitialMargin) || 0,
      totalMaintMarginUsdt: Number(account?.totalMaintMargin) || 0,
    },
    openPositionCount: openPositions.length,
    openPositions,
    standardOpenOrderCount: openStandardOrders.length,
    algoOpenOrderCount: openAlgoOrders.length,
    openStandardOrders,
    openAlgoOrders,
    openOrders: [...openStandardOrders, ...openAlgoOrders],
  };
  snapshot.snapshotHash = sha256(stableStringify(snapshot));
  if (persist) await writeJsonAtomic(LATEST_PATH, snapshot);
  return snapshot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const snapshot = await snapshotV4DemoAccount();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}
