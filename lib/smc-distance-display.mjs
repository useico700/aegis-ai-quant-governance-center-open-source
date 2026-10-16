export function signedEntryBandDistance(price, direction, band) {
  const value = Number(price);
  const low = Number(band?.low);
  const high = Number(band?.high);
  if (!Number.isFinite(value) || !Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) return null;

  const normalizedDirection = String(direction).toUpperCase();
  if (normalizedDirection !== "LONG" && normalizedDirection !== "SHORT") return null;

  // Positive means the executable quote has not reached the first edge yet.
  // Negative means it has crossed that edge and is continuing through the band.
  const edge = normalizedDirection === "LONG" ? high : low;
  const absolute = normalizedDirection === "LONG" ? value - edge : edge - value;
  return {
    edge,
    absolute,
    percent: absolute / edge * 100,
    inBand: value >= low && value <= high,
  };
}

export function formatSignedEntryPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return "—";
  const threshold = 0.5 * 10 ** -digits;
  const normalized = Math.abs(value) < threshold ? 0 : value;
  return `${normalized.toFixed(digits)}%`;
}
