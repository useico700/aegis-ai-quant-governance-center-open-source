import crypto from "node:crypto";
import { parseExchangeJson, assertSafeParsedNumbers } from '../../../lib/exchange-json.mjs';
import { admittedReadJson } from '../s1-execution/admitted-http.mjs';

const SIGNED_GET_PATHS = new Set([
  "/fapi/v2/account",
  "/fapi/v2/positionRisk",
  "/fapi/v1/accountConfig",
  "/fapi/v1/openOrders",
  "/fapi/v1/openAlgoOrders",
]);
const PUBLIC_GET_PATHS = new Set(["/fapi/v1/time", "/fapi/v1/exchangeInfo"]);
const USER_STREAM_PATH = "/fapi/v1/listenKey";

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function assertProductionBaseUrl(value) {
  const url = new URL(value);
  invariant(url.protocol === "https:" && url.hostname === "demo-fapi.binance.com" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash, "PRODUCTION_BASE_URL_NOT_ALLOWLISTED");
  return url;
}

function safeError(code, status = null) {
  const error = new Error(status === null ? code : `${code}_${status}`);
  if (status !== null) error.httpStatus = status;
  return error;
}

async function fetchJson(url, init, { fetchImpl = globalThis.fetch, timeoutMs = 8000, admission } = {}) {
  invariant(fetchImpl !== globalThis.fetch || admission, 'PRODUCTION_SHARED_ADMISSION_REQUIRED');
  if (admission) {
    const result = await admittedReadJson(url, init, { fetcher: fetchImpl, timeoutMs, admission });
    if (!result.ok) {
      const code = Number.isInteger(Number(result.payload?.code)) ? String(Number(result.payload.code)) : 'UNKNOWN';
      throw safeError(`BINANCE_PRODUCTION_READ_FAILED_${code}`, result.status);
    }
    return result.payload;
  }
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let payload;
  if (typeof response.text === "function") {
    const body = await response.text();
    payload = body ? parseExchangeJson(body) : {};
  } else {
    payload = assertSafeParsedNumbers(await response.json());
  }
  if (!response.ok) {
    const exchangeCode = Number.isInteger(Number(payload?.code)) ? String(Number(payload.code)) : "UNKNOWN";
    throw safeError(`BINANCE_PRODUCTION_READ_FAILED_${exchangeCode}`, response.status);
  }
  return payload;
}

export async function publicServerTime(config, options = {}) {
  const base = assertProductionBaseUrl(config.venue.restBaseUrl);
  return fetchJson(new URL("/fapi/v1/time", base), { method: "GET", headers: { "User-Agent": "aegis-binance-prod-readonly/1.0" } }, { ...options, timeoutMs: config.runtime.requestTimeoutMs });
}

export async function signedGet(config, pathName, params, credentials, options = {}) {
  invariant(SIGNED_GET_PATHS.has(pathName), "PRODUCTION_SIGNED_PATH_NOT_ALLOWLISTED");
  const base = assertProductionBaseUrl(config.venue.restBaseUrl);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  query.set("timestamp", String(options.timestamp ?? Date.now()));
  query.set("recvWindow", String(config.runtime.recvWindowMs));
  const signature = crypto.createHmac("sha256", credentials.secretKey).update(query.toString()).digest("hex");
  query.set("signature", signature);
  const url = new URL(pathName, base);
  url.search = query.toString();
  return fetchJson(url, {
    method: "GET",
    headers: {
      "X-MBX-APIKEY": credentials.apiKey,
      "User-Agent": "aegis-binance-prod-readonly/1.0",
    },
  }, { ...options, timeoutMs: config.runtime.requestTimeoutMs });
}

export async function userStreamControl(config, method, credentials, options = {}) {
  invariant(["POST", "PUT", "DELETE"].includes(method), "PRODUCTION_USER_STREAM_METHOD_INVALID");
  const base = assertProductionBaseUrl(config.venue.restBaseUrl);
  const url = new URL(USER_STREAM_PATH, base);
  return fetchJson(url, {
    method,
    headers: {
      "X-MBX-APIKEY": credentials.apiKey,
      "User-Agent": "aegis-binance-prod-readonly/1.0",
    },
  }, { ...options, timeoutMs: config.runtime.requestTimeoutMs });
}

export function assertNoTradingMutation(method, pathName) {
  if (method === "GET" && (SIGNED_GET_PATHS.has(pathName) || PUBLIC_GET_PATHS.has(pathName))) return true;
  if (["POST", "PUT", "DELETE"].includes(method) && pathName === USER_STREAM_PATH) return true;
  throw new Error("PRODUCTION_TRADING_MUTATION_FORBIDDEN");
}

import { projectAccount } from '../../../lib/s1-account.mjs';
function validFiniteDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return false;
  const amount = Number(value);
  // Unknown/coerced/underflowed quantities must never establish a flat account.
  return Number.isFinite(amount) && (amount !== 0 || !/[1-9]/.test(value));
}
export async function readProductionAccount(config, credentials, options = {}) {
  const now = options.now ?? Date.now, startedAt = now();
  invariant(Number.isSafeInteger(startedAt) && startedAt >= 0, 'PRODUCTION_ACCOUNT_TIME_INVALID');
  const server = await publicServerTime(config, options);
  const timestamp = Number(server.serverTime);
  invariant(Number.isFinite(timestamp), "PRODUCTION_SERVER_TIME_INVALID");
  const requestOptions = { ...options, timestamp };
  const [account, positions, accountConfig, openOrders, openAlgoOrders] = await Promise.all([
    signedGet(config, "/fapi/v2/account", {}, credentials, requestOptions),
    signedGet(config, "/fapi/v2/positionRisk", {}, credentials, requestOptions),
    signedGet(config, "/fapi/v1/accountConfig", {}, credentials, requestOptions),
    signedGet(config, "/fapi/v1/openOrders", {}, credentials, requestOptions),
    signedGet(config, "/fapi/v1/openAlgoOrders", {}, credentials, requestOptions),
  ]);
  invariant(Array.isArray(positions) && Array.isArray(openOrders) && Array.isArray(openAlgoOrders) && Array.isArray(account?.assets), 'ACCOUNT_RESPONSE_SHAPE_INVALID');
  // Read modes freshly at lower weight; never default an absent mode to false.
  invariant(accountConfig && !Array.isArray(accountConfig)
    && ['dualSidePosition', 'multiAssetsMargin', 'canTrade'].every(key => typeof accountConfig[key] === 'boolean'), 'ACCOUNT_CONFIGURATION_INCOMPLETE');
  invariant(typeof account.canTrade === 'boolean' && account.canTrade === accountConfig.canTrade
    && (account.multiAssetsMargin === undefined || account.multiAssetsMargin === accountConfig.multiAssetsMargin), 'ACCOUNT_CONFIGURATION_MISMATCH');
  invariant(positions.every(row => row && !Array.isArray(row) && validFiniteDecimal(row.positionAmt)), 'ACCOUNT_POSITION_AMOUNT_INVALID');
  const nonFlat = positions.filter((row) => Number(row.positionAmt) !== 0);
  invariant(account.assets.every(row => row && !Array.isArray(row) && typeof row.asset === 'string'
    && row.asset.length > 0 && row.asset.trim() === row.asset)
    && new Set(account.assets.map(row => row.asset)).size === account.assets.length
    && account.assets.some(row => row.asset === 'USDT'), 'ACCOUNT_ASSET_RESPONSE_INVALID');
  const usdt = account.assets.find(row => row.asset === 'USDT');
  // These fields are explicitly USDT, not account-wide collateral totals.
  // Unknown funds are a failed observation, never a manufactured zero balance.
  invariant(['walletBalance', 'marginBalance', 'availableBalance'].every(key => validFiniteDecimal(usdt[key])), 'ACCOUNT_USDT_BALANCE_INVALID');
  return {
    monitor: projectAccount(account, positions, openOrders, openAlgoOrders),
    observedAt: new Date(startedAt).toISOString(),
    serverTime: timestamp,
    canTrade: account?.canTrade === true,
    feeTier: Number(account?.feeTier ?? 0),
    dualSidePosition: accountConfig.dualSidePosition,
    walletBalanceUsdt: Number(usdt.walletBalance),
    marginBalanceUsdt: Number(usdt.marginBalance),
    availableBalanceUsdt: Number(usdt.availableBalance),
    nonFlatPositionCount: nonFlat.length,
    nonFlatSymbols: nonFlat.map((row) => String(row.symbol)).sort(),
    openOrderCount: Array.isArray(openOrders) ? openOrders.length : 0,
    openAlgoOrderCount: Array.isArray(openAlgoOrders) ? openAlgoOrders.length : 0,
  };
}
