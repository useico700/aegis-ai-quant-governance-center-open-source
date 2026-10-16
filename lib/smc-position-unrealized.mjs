const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function positionUnrealizedPnl(position, quote, now = Date.now(), staleAfterMs = 10000) {
  const quantity = finite(position?.quantity);
  const entry = finite(position?.entry);
  const snapshot = finite(position?.unrealizedPnl);
  const quoteAt = finite(quote?.quoteAt);
  const direction = position?.direction;
  const closePrice = direction === 'LONG' ? finite(quote?.bid) : direction === 'SHORT' ? finite(quote?.ask) : null;
  const quoteFresh = quantity !== null && quantity > 0 && entry !== null && entry > 0 && closePrice !== null && closePrice > 0
    && quoteAt !== null && Number.isSafeInteger(quoteAt) && now - quoteAt >= -5000 && now - quoteAt <= staleAfterMs;
  if (quoteFresh) {
    const value = direction === 'LONG' ? (closePrice - entry) * quantity : (entry - closePrice) * quantity;
    return { value, source: 'LIVE_CLOSE_BBO', closePrice, quoteAt };
  }
  if (snapshot !== null) return { value: snapshot, source: 'ACCOUNT_SNAPSHOT', closePrice: null, quoteAt: null };
  return { value: null, source: 'UNAVAILABLE', closePrice: null, quoteAt: null };
}

// The summary and cards consume one valuation pass. Sum displayed cents so the
// visible total reconciles even when multiple positions round independently.
export function positionsUnrealizedPnl(positions, quotes, now, staleAfterMs, accountFresh) {
  const rows = positions.map(position => {
    const pnl = accountFresh
      ? positionUnrealizedPnl(position, quotes.get(position.symbol), now, staleAfterMs)
      : { value: null, source: 'UNAVAILABLE', closePrice: null, quoteAt: null };
    return { ...pnl, value: pnl.value === null ? null : Number(pnl.value.toFixed(2)) };
  });
  const complete = accountFresh && rows.every(row => row.value !== null);
  const total = complete ? rows.reduce((cents, row) => cents + Math.round(row.value * 100), 0) / 100 : null;
  return { rows, total };
}
