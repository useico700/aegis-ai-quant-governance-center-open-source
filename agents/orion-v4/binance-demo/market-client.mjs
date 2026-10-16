import { normalizeKlines } from "./market-bars.mjs";

export const V4_DEMO_MARKET_BASE_URL = "https://demo-fapi.binance.com";

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function symbol(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  invariant(/^[A-Z0-9]{5,20}$/.test(normalized), "V4_MARKET_SYMBOL_INVALID");
  return normalized;
}

async function publicJson(pathname, query = {}, fetchImpl = fetch) {
  const url = new URL(pathname, V4_DEMO_MARKET_BASE_URL);
  invariant(url.hostname === "demo-fapi.binance.com", "V4_MARKET_HOST_INVALID");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { "user-agent": "orion-v4-rg2-market/2.0" },
  });
  if (!response.ok) throw new Error(`V4_MARKET_HTTP_${response.status}`);
  return response.json();
}

export class V4DemoMarketClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async serverTime() {
    const body = await publicJson("/fapi/v1/time", {}, this.fetchImpl);
    const value = Number(body?.serverTime);
    invariant(value > 0, "V4_MARKET_SERVER_TIME_INVALID");
    return value;
  }

  async bars(value, interval, limit, serverTime = Date.now()) {
    invariant(["15m", "1h", "4h"].includes(interval), "V4_MARKET_INTERVAL_INVALID");
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1_500, "V4_MARKET_LIMIT_INVALID");
    const rows = await publicJson("/fapi/v1/klines", { symbol: symbol(value), interval, limit }, this.fetchImpl);
    return normalizeKlines(rows, serverTime);
  }

  async book(value) {
    const receivedAt = Date.now();
    const row = await publicJson("/fapi/v1/ticker/bookTicker", { symbol: symbol(value) }, this.fetchImpl);
    const bid = Number(row?.bidPrice);
    const ask = Number(row?.askPrice);
    invariant(bid > 0 && ask > 0 && bid <= ask, "V4_MARKET_BBO_INVALID");
    const eventTime = Number(row?.time);
    const updateId = Number(row?.lastUpdateId);
    invariant(eventTime > 0, "V4_MARKET_BBO_EVENT_TIME_REQUIRED");
    invariant(Number.isSafeInteger(updateId) && updateId >= 0, "V4_MARKET_BBO_UPDATE_ID_REQUIRED");
    return { symbol: symbol(value), bid, ask, eventTime, transactionTime: eventTime, marketTime: eventTime, receivedAt, updateId, observedAt: receivedAt, source: "BINANCE_USDM_DEMO_REST_BBO" };
  }
}

export class V4RealtimeDemoMarketClient extends V4DemoMarketClient {
  constructor({ feed, fetchImpl = fetch } = {}) { super({ fetchImpl }); this.feed = feed; }
  async book(value) {
    const quote = this.feed?.quote(symbol(value));
    invariant(quote, "V4_CAUSAL_BBO_NOT_YET_AVAILABLE");
    invariant(Date.now() - Number(quote.receivedAt) <= 5_000, "V4_CAUSAL_BBO_STALE");
    return quote;
  }
  async bookAfter(value, minimumUpdateIdExclusive = -1, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const quote = this.feed?.quote(symbol(value));
      if (quote && Number(quote.updateId) > Number(minimumUpdateIdExclusive) && Date.now() - Number(quote.receivedAt) <= 15_000) return quote;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("V4_CAUSAL_BBO_NEWER_UPDATE_TIMEOUT");
  }
}
