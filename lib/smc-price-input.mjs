import { decimal, formatPrice, units } from './s1-precision.mjs';

const MODES = new Set(['DOWN', 'UP', 'NEAREST']);

export function canonicalTickSize(tickSize) {
  try {
    const tick = units(tickSize);
    if (tick <= 0n) return null;
    return decimal(tick);
  } catch { return null; }
}

export function priceInputStep(tickSize) {
  return canonicalTickSize(tickSize) ?? 'any';
}

export function priceFractionDigits(tickSize) {
  const tick = canonicalTickSize(tickSize);
  if (!tick) return null;
  return tick.includes('.') ? tick.length - tick.indexOf('.') - 1 : 0;
}

export function formatPriceDigitStream(value, tickSize) {
  const places = priceFractionDigits(tickSize);
  if (places === null) return '';
  let digits = String(value ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (!digits) return '';
  if (places === 0) return digits;
  digits = digits.padStart(places + 1, '0');
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

export function priceRoundingMode(direction, purpose) {
  if (purpose === 'STOP') return direction === 'LONG' ? 'UP' : 'DOWN';
  if (purpose === 'TARGET') return direction === 'LONG' ? 'DOWN' : 'UP';
  return 'NEAREST';
}

export function normalizePriceForTick(value, tickSize, mode = 'NEAREST') {
  const tickText = canonicalTickSize(tickSize);
  if (!tickText || !MODES.has(mode)) return null;
  try {
    const raw = units(value), tick = units(tickText);
    if (raw <= 0n) return null;
    const remainder = raw % tick;
    let aligned = raw - remainder;
    if (remainder && (mode === 'UP' || (mode === 'NEAREST' && remainder * 2n >= tick))) aligned += tick;
    if (aligned <= 0n) return null;
    return formatPrice(decimal(aligned), tickText);
  } catch { return null; }
}

export function formatPriceForInput(value, tickSize) {
  return normalizePriceForTick(value, tickSize, 'NEAREST') ?? '';
}

export function formatPriceForDisplay(value, tickSize) {
  const fixed = formatPriceForInput(value, tickSize);
  if (!fixed) return '—';
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function normalizePriceByPurpose(value, tickSize, direction, purpose) {
  return normalizePriceForTick(value, tickSize, priceRoundingMode(direction, purpose));
}
