import { invariant } from "./utils.mjs";

export function trueRangeSeries(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
}

export function atrSeries(bars, period = 14) {
  invariant(Number.isInteger(period) && period >= 1, "V4_RG1_ATR_PERIOD_INVALID");
  const ranges = trueRangeSeries(bars);
  const result = Array(bars.length).fill(null);
  if (bars.length < period) return result;
  let smoothed = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = smoothed;
  for (let index = period; index < bars.length; index += 1) {
    smoothed = ((smoothed * (period - 1)) + ranges[index]) / period;
    result[index] = smoothed;
  }
  return result;
}

export function adxSeries(bars, period = 14) {
  invariant(Number.isInteger(period) && period >= 2, "V4_RG1_ADX_PERIOD_INVALID");
  const result = Array(bars.length).fill(null);
  if (bars.length < (2 * period)) return result;

  const trueRanges = Array(bars.length).fill(0);
  const positiveDm = Array(bars.length).fill(0);
  const negativeDm = Array(bars.length).fill(0);
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previous = bars[index - 1];
    const upward = bar.high - previous.high;
    const downward = previous.low - bar.low;
    positiveDm[index] = upward > downward && upward > 0 ? upward : 0;
    negativeDm[index] = downward > upward && downward > 0 ? downward : 0;
    trueRanges[index] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  }

  let smoothedTrueRange = trueRanges.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedPositiveDm = positiveDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedNegativeDm = negativeDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  const dx = Array(bars.length).fill(null);

  for (let index = period; index < bars.length; index += 1) {
    if (index > period) {
      smoothedTrueRange = smoothedTrueRange - (smoothedTrueRange / period) + trueRanges[index];
      smoothedPositiveDm = smoothedPositiveDm - (smoothedPositiveDm / period) + positiveDm[index];
      smoothedNegativeDm = smoothedNegativeDm - (smoothedNegativeDm / period) + negativeDm[index];
    }
    const positiveDi = smoothedTrueRange > 0 ? (100 * smoothedPositiveDm) / smoothedTrueRange : 0;
    const negativeDi = smoothedTrueRange > 0 ? (100 * smoothedNegativeDm) / smoothedTrueRange : 0;
    const denominator = positiveDi + negativeDi;
    dx[index] = denominator > 0 ? (100 * Math.abs(positiveDi - negativeDi)) / denominator : 0;
  }

  const firstAdxIndex = (2 * period) - 1;
  let adx = dx.slice(period, firstAdxIndex + 1).reduce((sum, value) => sum + value, 0) / period;
  result[firstAdxIndex] = adx;
  for (let index = firstAdxIndex + 1; index < bars.length; index += 1) {
    adx = ((adx * (period - 1)) + dx[index]) / period;
    result[index] = adx;
  }
  return result;
}

export function olsSlope(values) {
  invariant(Array.isArray(values) && values.length >= 2, "V4_RG1_OLS_VALUES_INVALID");
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

export function latestBarIndexClosedBefore(bars, time) {
  let low = 0;
  let high = bars.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].closeTime < time) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}
