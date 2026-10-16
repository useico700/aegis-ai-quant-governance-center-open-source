// Freeze closedness at the request's time boundary. A cached live candle must
// never become closed merely because a later consumer's wall clock advanced.
export function closedKlinesAtRequest(rows, requestAt, widthMs) {
  if (!Number.isFinite(requestAt) || !Number.isSafeInteger(widthMs) || widthMs <= 0) throw new Error('KLINE_BOUNDARY_INVALID');
  const boundary = Math.floor(requestAt / widthMs) * widthMs;
  if (!Array.isArray(rows) || !rows.some(row => Number(row[6]) === boundary - 1)) throw new Error('LATEST_CLOSED_BAR_MISSING');
  return rows.filter(row => Number(row[6]) < boundary).map(row => row.slice());
}
