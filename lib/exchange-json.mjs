// Preserve large JSON integer tokens before JavaScript Number loses precision.
// Venue IDs are opaque identities, not quantities for arithmetic. Safe numeric
// fields (timestamps, rates, counts) retain their existing representation.
export function parseExchangeJson(text) {
  if (typeof text !== 'string') throw new Error('EXCHANGE_JSON_TEXT_REQUIRED');
  JSON.parse(text); // Validate original grammar, including malformed numeric tokens.
  const protectedText = text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"')) return token;
    const number = Number(token);
    if (!Number.isFinite(number)) throw new Error('EXCHANGE_JSON_NONFINITE_NUMBER');
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
      if (!/^-?\d+$/.test(token)) throw new Error('EXCHANGE_JSON_UNSAFE_NONCANONICAL_INTEGER');
      return JSON.stringify(token);
    }
    return token;
  });
  return JSON.parse(protectedText);
}

// A pre-parsed synthetic transport cannot recover lost digits. Refuse unknown
// precision instead of converting an already rounded Number to a string.
export function assertSafeParsedNumbers(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error('EXCHANGE_JSON_ALREADY_ROUNDED');
  }
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertSafeParsedNumbers(child);
  return value;
}
export const hasUnsafeVenueIdentifier = row => ['orderId', 'algoId', 'actualOrderId'].some(key =>
  typeof row?.[key] === 'number' && !Number.isSafeInteger(row[key]));
