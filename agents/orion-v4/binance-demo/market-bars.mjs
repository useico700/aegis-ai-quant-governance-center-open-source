export const INTERVAL_MS = Object.freeze({ "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 });

export function normalizeKlines(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error("V4_KLINES_NOT_ARRAY");
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    takerBuyBaseVolume: Number(row[9]),
    takerBuyQuoteVolume: Number(row[10]),
  })).filter((bar) => bar.openTime > 0 && bar.closeTime < now && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}
