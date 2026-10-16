const UNIVERSE = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
  'DOGEUSDT', 'ZECUSDT', 'HYPEUSDT', 'LINKUSDT', 'AAVEUSDT',
]);

const finite = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function sanitizeSmcLiveQuotes(input, now = Date.now()) {
  if (!Array.isArray(input)) throw new Error('SMC_LIVE_QUOTES_INVALID');
  const quotes = input.map(row => {
    const symbol = typeof row?.symbol === 'string' && UNIVERSE.has(row.symbol) ? row.symbol : null;
    const bid = finite(row?.bidPrice), ask = finite(row?.askPrice);
    const quoteAt = Number.isSafeInteger(row?.time) ? row.time : null;
    if (!symbol || bid === null || ask === null || ask < bid || quoteAt === null
      || quoteAt > now + 5000 || now - quoteAt > 15000) return null;
    return { symbol, bid, ask, quoteAt };
  }).filter(Boolean);
  const unique = [...new Map(quotes.map(row => [row.symbol, row])).values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!unique.length) throw new Error('SMC_LIVE_QUOTES_EMPTY');
  return {
    schema: 'SMC_LIVE_QUOTES_V1',
    source: 'BINANCE_USDM_BOOK_TICKER',
    observedAt: new Date(Math.max(...unique.map(row => row.quoteAt))).toISOString(),
    quotes: unique,
  };
}
