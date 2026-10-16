import { smcBars, confirmedSmcPivots } from './smc-bar-evidence.mjs';
export { smcBars, confirmedSmcPivots };
import { canonicalExternalEventType, externalEventRequiresSweep } from './smc-structure-context.mjs';
import { traceContextBars } from './smc-structure-context.mjs';
import { STOP_SLIPPAGE_BPS, stopSafetyContext, plannedSafeStop } from './smc-stop-safety.mjs';
import policy from './smc-scan-policy.json' with { type: 'json' };
export { policy as SMC_SCAN_POLICY };

const H4 = 14400000, M15 = 900000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const rounded = value => Number(value.toPrecision(12));
const bodyFraction = bar => Math.abs(bar.close - bar.open) / Math.max(bar.high - bar.low, Number.EPSILON);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const quantile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const offset = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const lower = Math.floor(offset), upper = Math.ceil(offset), weight = offset - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};
const priceRound = (value, tick, up) => rounded((up ? Math.ceil(value / tick - 1e-8) : Math.floor(value / tick + 1e-8)) * tick);


function atr(bars, index = bars.length - 1) {
  const start = Math.max(1, index - 13);
  const ranges = bars.slice(start, index + 1).map((bar, offset) => Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[start + offset - 1].close),
    Math.abs(bar.low - bars[start + offset - 1].close),
  ));
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export function smcStructureBias(pivots) {
  const highs = pivots.filter(pivot => pivot.kind === 'HIGH').slice(-2);
  const lows = pivots.filter(pivot => pivot.kind === 'LOW').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return 'BULLISH';
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return 'BEARISH';
  return 'RANGE';
}

function htfLiquiditySweep({ bars, pivot, direction, breakIndex, buffer }) {
  if (!pivot) return null;
  const long = direction === 'LONG';
  const start = Math.max(pivot.index + 1, breakIndex - policy.maximumSweepLookbackBars4h);
  let sweep = null;
  for (let index = start; index < breakIndex; index++) {
    const bar = bars[index];
    const valid = long
      ? bar.low < pivot.price - buffer && bar.close > pivot.price
      : bar.high > pivot.price + buffer && bar.close < pivot.price;
    if (valid) sweep = { pivot, barIndex: index, sweptAt: bar.closeTime, extreme: long ? bar.low : bar.high };
  }
  return sweep;
}

function displacement(bar, previousBars, atrValue) {
  const baseline = median(previousBars.map(row => row.volume));
  return {
    bodyFraction: bodyFraction(bar),
    volumeRatio: baseline > 0 ? bar.volume / baseline : 0,
    bodyAtr: Math.abs(bar.close - bar.open) / Math.max(atrValue, Number.EPSILON),
  };
}

function displacementQuality(bars, breakIndex, atrValue, direction) {
  const bar = bars[breakIndex], long = direction === 'LONG';
  const prior = bars.slice(Math.max(0, breakIndex - 20), breakIndex);
  const current = displacement(bar, prior, atrValue);
  const directional = long ? bar.close > bar.open : bar.close < bar.open;
  const strong = directional && current.bodyAtr >= policy.strongDisplacementBodyAtr
    && current.bodyFraction >= policy.strongDisplacementBodyFraction
    && current.volumeRatio >= policy.strongDisplacementVolumeRatio;
  const base = directional && current.bodyAtr >= policy.displacementBodyAtr
    && current.bodyFraction >= policy.displacementBodyFraction
    && current.volumeRatio >= policy.displacementVolumeRatio;
  if (strong || base) return { grade: strong ? 'A' : 'B', model: 'SINGLE_BAR', bars: 1, metrics: current };
  const baseline = median(prior.map(row => row.volume));
  for (let width = 2; width <= policy.cumulativeDisplacementBars; width++) {
    const leg = bars.slice(Math.max(0, breakIndex - width + 1), breakIndex + 1);
    if (leg.length !== width) continue;
    const signedMove = long ? leg.at(-1).close - leg[0].open : leg[0].open - leg.at(-1).close;
    const totalRange = leg.reduce((sum, row) => sum + Math.max(row.high - row.low, Number.EPSILON), 0);
    const metrics = {
      bodyAtr: signedMove / Math.max(atrValue, Number.EPSILON),
      bodyFraction: signedMove / Math.max(totalRange, Number.EPSILON),
      volumeRatio: baseline > 0 ? Math.max(...leg.map(row => row.volume)) / baseline : 0,
    };
    if (signedMove > 0 && metrics.bodyAtr >= policy.cumulativeDisplacementBodyAtr
      && metrics.bodyFraction >= policy.cumulativeDisplacementBodyFraction
      && metrics.volumeRatio >= policy.cumulativeDisplacementVolumeRatio) {
      return { grade: 'B', model: 'CUMULATIVE_LEG', bars: width, metrics };
    }
  }
  return { grade: 'C', model: 'OBSERVE_ONLY', bars: 1, metrics: current };
}

function fvgsInDisplacementLeg(bars, breakIndex, direction, tick) {
  const start = Math.max(2, breakIndex - policy.fvgDisplacementLegBackwardBars);
  const end = Math.min(bars.length - 1, breakIndex + policy.fvgDisplacementLegForwardBars);
  const breakAvailableAt = bars[breakIndex].closeTime;
  const output = [];
  for (let index = start; index <= end; index++) {
    const fvg = fvgAt(bars, index, direction, tick);
    if (fvg) output.push({ ...fvg, availableAt: Math.max(fvg.availableAt, breakAvailableAt) });
  }
  return output;
}

// A displacement can leave more than one same-direction FVG.  The newest gap
// is preferred, but it must not hide an older, still-fresh gap from the same
// causal leg after the newest gap has been invalidated or consumed.
export function viableDisplacementFvgContexts({ fvgs, bars4h, bars15m, direction, tick,
  orderBlock = null, ownerSelected = false }) {
  check(Array.isArray(fvgs) && Array.isArray(bars4h) && Array.isArray(bars15m)
    && ['LONG', 'SHORT'].includes(direction) && Number.isFinite(tick) && tick > 0,
  'FVG_FALLBACK_INPUT_INVALID');
  const long = direction === 'LONG';
  // Automatic scanning keeps the existing newest-gap policy. Falling back to
  // an older same-leg gap is an owner-selected observation feature only, so a
  // repair for a manual watch item cannot silently expand the automatic live
  // candidate set across the rest of the universe.
  const ordered = [...fvgs].sort((a, b) => b.availableAt - a.availableAt);
  const scoped = ownerSelected ? ordered : ordered.slice(0, 1);
  return scoped.map(raw => {
    const zone = { ...raw };
    if (orderBlock && Math.max(zone.low, orderBlock.low) < Math.min(zone.high, orderBlock.high)) {
      zone.kind = 'FVG_OB'; zone.orderBlock = orderBlock;
      zone.invalidation = long ? Math.min(zone.invalidation, orderBlock.invalidation)
        : Math.max(zone.invalidation, orderBlock.invalidation);
    }
    const band = entryBand(zone, direction, tick);
    zone.ce = band.ce; zone.entryBand = { low: band.low, high: band.high };
    const after4h = bars4h.filter(row => row.openTime > zone.availableAt);
    const fvgBreak = after4h.find(row => long ? row.close < zone.low : row.close > zone.high);
    if (fvgBreak) return { eligible: false, zone, band,
      invalidation: { reason: 'FVG_INVALIDATED', detectedAt: fvgBreak.closeTime,
        timeframe: '4H', level: rounded(long ? zone.low : zone.high), observed: rounded(fvgBreak.close) } };
    const after15m = bars15m.filter(row => row.openTime > zone.availableAt);
    if (!after15m.length || (!ownerSelected && after15m[0].openTime - zone.availableAt > M15 + 1)) {
      return { eligible: false, zone, band, rejection: 'WAIT_15M_AFTER_POI' };
    }
    const partialCoverage = after15m[0].openTime - zone.availableAt > M15 + 1;
    const poiLifecycle = smcPoiLifecycle({ bars: bars15m, zone, direction, tick });
    if (poiLifecycle.exhausted) return { eligible: false, zone, band,
      invalidation: { reason: poiLifecycle.exhaustedReason,
        detectedAt: poiLifecycle.lastTouchAt, timeframe: '15M', level: rounded(band.ce) } };
    return { eligible: true, zone, band, after4h, after15m, partialCoverage, poiLifecycle };
  });
}

function fvgAt(bars, thirdIndex, direction, tick) {
  if (thirdIndex < 2 || !bars[thirdIndex]) return null;
  const long = direction === 'LONG', first = bars[thirdIndex - 2], third = bars[thirdIndex];
  const exists = long ? third.low > first.high + 2 * tick : third.high < first.low - 2 * tick;
  if (!exists) return null;
  const low = long ? first.high : third.high, high = long ? third.low : first.low;
  return { kind: 'FVG', low, high, invalidation: long ? low : high, availableAt: third.closeTime };
}

// Observation lane for owner-selected symbols. It deliberately searches the full
// 60-day 4H history and never grants automatic entry/order authority.
export function nearbySmcZones(bars, quote, tick, now) {
  const current = Number(quote?.bidPrice ?? quote?.bid), span = bars.slice(-policy.structureLookbackBars4h);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(tick) || tick <= 0) return [];
  const found = [];
  for (let index = 2; index < span.length; index++) {
    for (const direction of ['LONG', 'SHORT']) {
      const zone = fvgAt(span, index, direction, tick);
      if (!zone) continue;
      const later = span.slice(index + 1), long = direction === 'LONG';
      let broken = false, consecutive = 0, touches = 0, lastTouchAt = null, episodes = 0, inside = false, ceBodyCrosses = 0;
      const ce = (zone.low + zone.high) / 2;
      for (const bar of later) {
        const overlaps = bar.low <= zone.high && bar.high >= zone.low;
        if (overlaps && !inside) episodes++;
        inside = overlaps;
        if (overlaps) { touches++; lastTouchAt = bar.closeTime; }
        if ((bar.open < ce && bar.close > ce) || (bar.open > ce && bar.close < ce)) ceBodyCrosses++;
        consecutive = long ? bar.close < zone.low - tick ? consecutive + 1 : 0
          : bar.close > zone.high + tick ? consecutive + 1 : 0;
        if (consecutive >= 2) { broken = true; break; }
      }
      if (broken || episodes > policy.maximumPoiMitigationEpisodes || ceBodyCrosses > policy.maximumPoiCeBodyCrosses
        || (long ? current < zone.low : current > zone.high)) continue;
      const edge = long ? zone.high : zone.low;
      const distancePercent = Math.abs(current - edge) / current * 100;
      if (distancePercent > 12) continue;
      found.push({ id: `${direction}-${zone.availableAt}`, direction, kind: 'FVG',
        low: rounded(zone.low), high: rounded(zone.high), ce: rounded((zone.low + zone.high) / 2),
        availableAt: zone.availableAt, lastTouchAt, touches, mitigationEpisodes: episodes, ceBodyCrosses,
        distancePercent: rounded(distancePercent),
        ageDays: rounded((now - zone.availableAt) / 86400000), orderAuthority: false });
    }
  }
  for (const direction of ['LONG', 'SHORT']) {
    if (found.some(zone => zone.direction === direction)) continue;
    const long = direction === 'LONG';
    const pivots = confirmedSmcPivots(span).filter(pivot => pivot.kind === (long ? 'LOW' : 'HIGH'));
    for (const pivot of pivots) {
      const level = pivot.price;
      if (long ? level > current : level < current) continue;
      const later = span.slice(pivot.index + 1);
      let consecutive = 0, broken = false, touches = 0, lastTouchAt = null;
      const width = Math.max(2 * tick, atr(span, pivot.index) * .12);
      for (const bar of later) {
        if (Math.abs((long ? bar.low : bar.high) - level) <= width) { touches++; lastTouchAt = bar.closeTime; }
        consecutive = long ? bar.close < level - tick ? consecutive + 1 : 0
          : bar.close > level + tick ? consecutive + 1 : 0;
        if (consecutive >= 2) { broken = true; break; }
      }
      if (broken) continue;
      const low = long ? level : Math.max(tick, level - width);
      const high = long ? level + width : level;
      const edge = long ? high : low;
      const distancePercent = Math.abs(current - edge) / current * 100;
      if (distancePercent > 12) continue;
      found.push({ id: `${direction}-SWING-${pivot.time}`, direction,
        kind: long ? 'SWING_SUPPORT' : 'SWING_RESISTANCE', low: rounded(low), high: rounded(high),
        ce: rounded((low + high) / 2), availableAt: pivot.confirmedAt, lastTouchAt, touches,
        distancePercent: rounded(distancePercent), ageDays: rounded((now - pivot.confirmedAt) / 86400000), orderAuthority: false });
    }
  }
  return found.sort((a, b) => a.distancePercent - b.distancePercent || b.availableAt - a.availableAt).slice(0, 8);
}

function orderBlockBefore(bars, breakIndex, direction) {
  const long = direction === 'LONG';
  for (let index = breakIndex - 1; index >= Math.max(0, breakIndex - policy.maximumOrderBlockLookbackBars4h); index--) {
    const bar = bars[index];
    if (long ? bar.close < bar.open : bar.close > bar.open) return {
      kind: 'OB', low: Math.min(bar.open, bar.close), high: Math.max(bar.open, bar.close),
      invalidation: long ? bar.low : bar.high, availableAt: bars[breakIndex].closeTime,
      sourceBarOpenTime: bar.openTime,
    };
  }
  return null;
}

function entryBand(zone, direction, tick) {
  const rawCe = (zone.low + zone.high) / 2;
  const ce = priceRound(rawCe, tick, direction === 'LONG');
  const trigger = ce;
  return direction === 'LONG'
    ? { low: ce, high: zone.high, ce, trigger, triggerFraction: 0.5,
      zoneFraction: 0.5, half: 'CE_TO_FVG_HIGH' }
    : { low: zone.low, high: ce, ce, trigger, triggerFraction: 0.5,
      zoneFraction: 0.5, half: 'FVG_LOW_TO_CE' };
}

function priceDistanceToBand(price, band) {
  if (!Number.isFinite(price)) return null;
  const absolute = price < band.low ? band.low - price : price > band.high ? price - band.high : 0;
  return { absolute: rounded(absolute), percent: rounded(absolute / band.ce * 100) };
}

export function smcPoiLifecycle({ bars, zone, direction, tick }) {
  const band = entryBand(zone, direction, tick);
  const start = Math.max(0, bars.findIndex(row => row.openTime > zone.availableAt));
  let mitigationEpisodes = 0, touchBars = 0, ceBodyCrosses = 0, inside = false, firstTouchAt = null, lastTouchAt = null;
  for (let index = start; index < bars.length; index++) {
    const bar = bars[index];
    const overlaps = bar.low <= zone.high && bar.high >= zone.low;
    if (overlaps && !inside) mitigationEpisodes++;
    inside = overlaps;
    if (overlaps) {
      touchBars++;
      firstTouchAt ??= bar.closeTime;
      lastTouchAt = bar.closeTime;
    }
    if ((bar.open < band.ce && bar.close > band.ce) || (bar.open > band.ce && bar.close < band.ce)) ceBodyCrosses++;
  }
  const exhaustedReason = mitigationEpisodes > policy.maximumPoiMitigationEpisodes
    ? 'POI_REPEATED_MITIGATION'
    : ceBodyCrosses > policy.maximumPoiCeBodyCrosses ? 'POI_EXCESSIVE_CE_BODY_CROSSES' : null;
  return { mitigationEpisodes, touchBars, ceBodyCrosses, firstTouchAt, lastTouchAt,
    maximumMitigationEpisodes: policy.maximumPoiMitigationEpisodes,
    maximumCeBodyCrosses: policy.maximumPoiCeBodyCrosses, exhausted: exhaustedReason !== null, exhaustedReason };
}

const pivotWasSwept = ({ bars, pivot, untilIndex, direction, buffer, includeUntil = false }) => {
  const end = Math.min(bars.length, untilIndex + (includeUntil ? 1 : 0));
  return bars.slice(pivot.index + 1, end).some(bar => direction === 'LONG'
    ? bar.low < pivot.price - buffer : bar.high > pivot.price + buffer);
};

export function smcEntryLiquidityContext({ bars, zone, direction, tick, confirmationAt, provisionalStop }) {
  const long = direction === 'LONG', band = entryBand(zone, direction, tick), a15 = atr(bars);
  const confirmationIndex = confirmationAt == null ? bars.length - 1
    : bars.findIndex(bar => bar.closeTime === confirmationAt);
  const causalEnd = confirmationIndex < 0 ? bars.length - 1 : confirmationIndex;
  const lookbackStart = Math.max(0, causalEnd - policy.entryLiquidityLookbackBars15m);
  const pivots = confirmedSmcPivots(bars, policy.entryLiquidityPivotLeft, policy.entryLiquidityPivotRight)
    .filter(pivot => pivot.kind === (long ? 'LOW' : 'HIGH') && pivot.index >= lookbackStart
      && pivot.confirmedAt < (bars[causalEnd]?.openTime ?? Infinity));
  const buffer = Math.max(2 * tick, a15 * policy.entryLiquiditySweepBufferAtr);
  const unswept = pivots.filter(pivot => !pivotWasSwept({ bars, pivot, untilIndex: causalEnd,
    direction, buffer, includeUntil: false }));
  const between = unswept.filter(pivot => long
    ? pivot.price > provisionalStop && pivot.price < band.ce
    : pivot.price < provisionalStop && pivot.price > band.ce);
  const confirmationBar = bars[causalEnd] ?? null;
  const sweptOnConfirmation = between.filter(pivot => confirmationBar && (long
    ? confirmationBar.low < pivot.price - buffer : confirmationBar.high > pivot.price + buffer));
  const blocking = between.filter(pivot => !sweptOnConfirmation.includes(pivot));
  const beyond = unswept.filter(pivot => long
    ? pivot.price <= provisionalStop && provisionalStop - pivot.price <= a15 * policy.stopLiquiditySearchBeyondAtr
    : pivot.price >= provisionalStop && pivot.price - provisionalStop <= a15 * policy.stopLiquiditySearchBeyondAtr)
    .sort((a, b) => long ? a.price - b.price : b.price - a.price);
  const stopPool = beyond[0] ?? null;
  const adjustedStop = stopPool
    ? priceRound(stopPool.price + (long ? -1 : 1) * a15 * policy.stopLiquidityBufferAtr, tick, !long)
    : provisionalStop;
  return {
    model: 'CONFIRMED_15M_PIVOT_2X2', lookbackBars: policy.entryLiquidityLookbackBars15m,
    sweepBufferAtr: policy.entryLiquiditySweepBufferAtr, blocking: blocking.map(pivot => ({
      kind: pivot.kind, price: rounded(pivot.price), time: pivot.time, confirmedAt: pivot.confirmedAt })),
    sweptOnConfirmation: sweptOnConfirmation.map(pivot => ({ kind: pivot.kind, price: rounded(pivot.price),
      time: pivot.time, confirmedAt: pivot.confirmedAt })),
    stopPool: stopPool ? { kind: stopPool.kind, price: rounded(stopPool.price), time: stopPool.time,
      confirmedAt: stopPool.confirmedAt } : null,
    provisionalStop: rounded(provisionalStop), adjustedStop: rounded(adjustedStop),
    stopAdjustedForLiquidity: adjustedStop !== provisionalStop,
    ready: blocking.length === 0,
  };
}

export function smcEntryLocationContext({ bars, direction, confirmationAt, referenceEntry }) {
  const confirmationIndex = confirmationAt == null ? bars.length - 1
    : bars.findIndex(bar => bar.closeTime === confirmationAt);
  const causalEnd = confirmationIndex < 0 ? bars.length - 1 : confirmationIndex;
  const window = bars.slice(Math.max(0, causalEnd - policy.entryLocationLookbackBars15m + 1), causalEnd + 1);
  const rangeLow = Math.min(...window.map(bar => bar.low));
  const rangeHigh = Math.max(...window.map(bar => bar.high));
  const percentile = (referenceEntry - rangeLow) / Math.max(rangeHigh - rangeLow, Number.EPSILON);
  const robustLow = quantile(window.map(bar => bar.low), policy.entryLocationRobustLowerQuantile);
  const robustHigh = quantile(window.map(bar => bar.high), policy.entryLocationRobustUpperQuantile);
  const robustPercentile = (referenceEntry - robustLow) / Math.max(robustHigh - robustLow, Number.EPSILON);
  const rawReady = direction === 'LONG'
    ? percentile <= policy.maximumLongEntryRangePercentile
    : percentile >= policy.minimumShortEntryRangePercentile;
  const robustReady = direction === 'LONG'
    ? robustPercentile <= policy.maximumLongEntryRobustPercentile
    : robustPercentile >= policy.minimumShortEntryRobustPercentile;
  const ready = rawReady && robustReady;
  return {
    model: 'CAUSAL_15M_DUAL_DEALING_RANGE_PERCENTILE', lookbackBars: window.length,
    rangeLow: rounded(rangeLow), rangeHigh: rounded(rangeHigh), referenceEntry: rounded(referenceEntry),
    percentile: rounded(percentile), robustLow: rounded(robustLow), robustHigh: rounded(robustHigh),
    robustPercentile: rounded(robustPercentile), rawReady, robustReady, ready,
    limit: direction === 'LONG' ? policy.maximumLongEntryRangePercentile : policy.minimumShortEntryRangePercentile,
    robustLimit: direction === 'LONG' ? policy.maximumLongEntryRobustPercentile : policy.minimumShortEntryRobustPercentile,
    reason: ready ? null : direction === 'LONG' ? 'LONG_ENTRY_RELATIVE_PREMIUM' : 'SHORT_ENTRY_RELATIVE_DISCOUNT',
  };
}

export function smcEntryRegimeContext({ bars, direction, confirmationAt }) {
  const confirmationIndex = confirmationAt == null ? bars.length - 1
    : bars.findIndex(bar => bar.closeTime === confirmationAt);
  const causalEnd = confirmationIndex < 0 ? bars.length - 1 : confirmationIndex;
  const start = Math.max(0, causalEnd - policy.entryRegimeLookbackBars15m + 1);
  const window = bars.slice(start, causalEnd + 1);
  const currentAtr = atr(bars, causalEnd);
  const range = Math.max(...window.map(bar => bar.high)) - Math.min(...window.map(bar => bar.low));
  const path = Math.abs(window[0].close - window[0].open)
    + window.slice(1).reduce((sum, bar, index) => sum + Math.abs(bar.close - window[index].close), 0);
  const efficiency = Math.abs(window.at(-1).close - window[0].open) / Math.max(path, Number.EPSILON);
  const rangeAtr = range / Math.max(currentAtr, Number.EPSILON);
  const confirmation = bars[causalEnd];
  const confirmationRange = Math.max(confirmation.high - confirmation.low, Number.EPSILON);
  const directionalCloseLocation = direction === 'LONG'
    ? (confirmation.close - confirmation.low) / confirmationRange
    : (confirmation.high - confirmation.close) / confirmationRange;
  const confirmationRangeAtr = confirmationRange / Math.max(currentAtr, Number.EPSILON);
  const compressed = rangeAtr <= policy.entryCompressionMaximumRangeAtr
    && efficiency <= policy.entryCompressionMaximumEfficiency;
  const confirmationImpulseReady = confirmationRangeAtr >= policy.entryConfirmationMinimumRangeAtr
    && directionalCloseLocation >= policy.entryConfirmationMinimumDirectionalCloseLocation;
  return {
    model: 'CAUSAL_15M_EXPANSION_EFFICIENCY', lookbackBars: window.length,
    rangeAtr: rounded(rangeAtr), efficiency: rounded(Math.min(1, efficiency)), compressed,
    confirmationRangeAtr: rounded(confirmationRangeAtr),
    directionalCloseLocation: rounded(directionalCloseLocation), confirmationImpulseReady,
    ready: !compressed && confirmationImpulseReady,
    reason: compressed ? 'ENTRY_REGIME_COMPRESSION' : confirmationImpulseReady ? null : 'ENTRY_CONFIRMATION_WEAK_IMPULSE',
  };
}

export function smcMicroStructureConfirmationContext({ bars, direction, ceTouchAt, tick, now, quote, band }) {
  const long = direction === 'LONG';
  const touchIndex = ceTouchAt == null ? -1 : bars.findIndex(bar => bar.closeTime === ceTouchAt);
  if (touchIndex < 0) return { model: 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT', state: 'WAIT_CE_TOUCH', ready: false };
  const maxIndex = Math.min(bars.length - 1, touchIndex + policy.entryMicroStructureMaximumBarsAfterTouch);
  let shift = null;
  for (let index = touchIndex + 1; index <= maxIndex; index++) {
    const bar = bars[index];
    const previous = bars.slice(Math.max(0, index - policy.entryMicroStructureLookbackBars), index);
    if (previous.length !== policy.entryMicroStructureLookbackBars) continue;
    const a15 = atr(bars, index), range = Math.max(bar.high - bar.low, Number.EPSILON);
    const breakLevel = long ? Math.max(...previous.map(row => row.high)) : Math.min(...previous.map(row => row.low));
    const breakBuffer = Math.max(2 * tick, a15 * policy.entryMicroStructureBreakBufferAtr);
    const directionalBody = long ? bar.close > bar.open : bar.close < bar.open;
    const structureBreak = long ? bar.close >= breakLevel + breakBuffer : bar.close <= breakLevel - breakBuffer;
    const body = bodyFraction(bar);
    const rangeAtr = range / Math.max(a15, Number.EPSILON);
    const closeLocation = long ? (bar.close - bar.low) / range : (bar.high - bar.close) / range;
    if (directionalBody && structureBreak
      && body >= policy.entryMicroStructureMinimumBodyFraction
      && rangeAtr >= policy.entryMicroStructureMinimumRangeAtr
      && closeLocation >= policy.entryMicroStructureMinimumDirectionalCloseLocation) {
      shift = { barIndex: index, confirmedAt: bar.closeTime, breakLevel: rounded(breakLevel),
        breakBuffer: rounded(breakBuffer), close: rounded(bar.close), bodyFraction: rounded(body),
        rangeAtr: rounded(rangeAtr), directionalCloseLocation: rounded(closeLocation) };
      break;
    }
  }
  const barsElapsed = Math.max(0, bars.length - 1 - touchIndex);
  if (!shift) return { model: 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT', state: barsElapsed >= policy.entryMicroStructureMaximumBarsAfterTouch
    ? 'MICRO_SHIFT_WINDOW_EXPIRED' : 'WAIT_15M_MICRO_STRUCTURE_SHIFT', ready: false,
  touchAt: ceTouchAt, touchIndex, barsElapsed, maximumBarsAfterTouch: policy.entryMicroStructureMaximumBarsAfterTouch };
  const ageMs = now - shift.confirmedAt;
  const quoteAge = now - Number(quote?.time), bid = Number(quote?.bidPrice), ask = Number(quote?.askPrice);
  const quoteFresh = Number.isFinite(quoteAge) && quoteAge >= -1000 && quoteAge <= 15000 && bid > 0 && ask >= bid;
  const executablePrice = quoteFresh ? (long ? ask : bid) : null;
  const insideBand = executablePrice !== null && executablePrice >= band.low && executablePrice <= band.high;
  return { model: 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT', state: ageMs > policy.entryMicroStructureMaximumAgeMs
    ? 'MICRO_SHIFT_CONFIRMATION_EXPIRED' : insideBand ? 'ENTRY_BAND_ACTIVE' : 'WAIT_CE_REENTRY',
  ready: ageMs <= policy.entryMicroStructureMaximumAgeMs, touchAt: ceTouchAt, touchIndex,
  barsElapsed: shift.barIndex - touchIndex, maximumBarsAfterTouch: policy.entryMicroStructureMaximumBarsAfterTouch,
  maximumAgeMs: policy.entryMicroStructureMaximumAgeMs, ageMs, quoteFresh, executablePrice, insideBand, ...shift };
}

function findInternalConfirmation({ bars, zone, direction, tick, now, quote }) {
  const long = direction === 'LONG', band = entryBand(zone, direction, tick), a15 = atr(bars);
  const firstIndex = bars.findIndex(row => row.openTime > zone.availableAt);
  const confirmations = [];
  for (let index = Math.max(0, firstIndex); index < bars.length; index++) {
    const bar = bars[index];
    const touchedCe = long ? bar.low <= band.ce : bar.high >= band.ce;
    const closeInDirectionalBand = bar.close >= band.low && bar.close <= band.high;
    const previous = index > Math.max(0, firstIndex) ? bars[index - 1] : null;
    const previousFalseBreak = previous && (long
      ? previous.open > band.ce && previous.close < band.ce && previous.close < previous.open
      : previous.open < band.ce && previous.close > band.ce && previous.close > previous.open);
    const falseBreakReclaim = previousFalseBreak && closeInDirectionalBand;
    if ((!touchedCe && !falseBreakReclaim) || !closeInDirectionalBand) continue;
    const bodyCross = long
      ? bar.open < band.ce && bar.close >= band.ce && bar.close > bar.open
      : bar.open > band.ce && bar.close <= band.ce && bar.close < bar.open;
    const source = falseBreakReclaim
      ? 'CLOSED_15M_FALSE_BREAK_RECLAIM'
      : bodyCross ? 'CLOSED_15M_BODY_CROSS' : 'CLOSED_15M_WICK_RECLAIM';
    confirmations.push({ index, bar, previous: falseBreakReclaim ? previous : null, source });
  }
  const age = now - Number(quote?.time), bid = Number(quote?.bidPrice), ask = Number(quote?.askPrice);
  const quoteFresh = Number.isFinite(age) && age >= -1000 && age <= 15000 && bid > 0 && ask >= bid;
  const executablePrice = quoteFresh ? (long ? ask : bid) : null;
  const insideBand = executablePrice !== null && executablePrice >= band.low && executablePrice <= band.high;
  const firstConfirmation = confirmations[0];
  const ceTouch = firstConfirmation ? {
    source: firstConfirmation.source, barIndex: firstConfirmation.index,
    testedAt: firstConfirmation.bar.closeTime, trigger: rounded(band.trigger),
    extreme: rounded(long ? firstConfirmation.bar.low : firstConfirmation.bar.high),
    open: rounded(firstConfirmation.bar.open), close: rounded(firstConfirmation.bar.close),
    falseBreakAt: firstConfirmation.previous?.closeTime ?? null,
  } : null;
  const status = insideBand && ceTouch ? 'ENTRY_BAND_ACTIVE' : ceTouch ? 'WAIT_CE_REENTRY' : 'ARMED_CE_CLOSE';
  return {
    status, band, touches: confirmations.length, touchAt: ceTouch?.testedAt ?? null, ceTouch,
    confirmationAt: ceTouch?.testedAt ?? now, quoteFresh, executablePrice, insideBand, atr15: a15,
  };
}

export function classifySmcEntry(args) {
  return findInternalConfirmation(args);
}

// A planned stop is an invalidation reference until an order fills. A sweep on
// the first opposite-body CE break may arm exactly one following 15M candle.
export function classifySmcSecondBarReversal({ bars, stop, band, direction, tick, now, quote, atr15 }) {
  const long = direction === 'LONG';
  const sweptIndex = bars.findIndex(row => long ? row.low <= stop : row.high >= stop);
  const oppositeCross = bar => !!bar && (long
    ? bar.open > band.ce && bar.close < band.ce && bar.close < bar.open
    : bar.open < band.ce && bar.close > band.ce && bar.close > bar.open);
  const largeBody = bar => !!bar && bodyFraction(bar) >= policy.secondBarReversalMinimumBodyFraction
    && Math.abs(bar.close - bar.open) >= atr15 * policy.secondBarReversalMinimumBodyAtr;
  const firstIndex = sweptIndex >= 0 ? sweptIndex
    : oppositeCross(bars.at(-2)) && largeBody(bars.at(-2)) ? bars.length - 2
      : oppositeCross(bars.at(-1)) && largeBody(bars.at(-1)) ? bars.length - 1 : -1;
  if (firstIndex < 0) return { state: 'NO_STOP_SWEEP' };
  const plannedStopSwept = sweptIndex >= 0;
  const first = bars[firstIndex], second = bars[firstIndex + 1];
  const firstCross = oppositeCross(first);
  const firstLarge = largeBody(first);
  if (!firstCross || !firstLarge) return { state: 'INVALID', reason: 'STOP_REGION_ALREADY_BREACHED', first };
  const extreme = long ? Math.min(first.low, second?.low ?? first.low) : Math.max(first.high, second?.high ?? first.high);
  const revisedStop = priceRound(extreme + (long ? -1 : 1) * atr15 * policy.stopBufferAtr, tick, !long);
  if (!second) return { state: 'WAIT_SECOND_BAR', stop: revisedStop, first,
    evidence: { firstBarAt: first.closeTime, firstBarExtreme: long ? first.low : first.high,
      oldStop: stop, plannedStopSwept } };
  const secondCross = long
    ? second.open < band.ce && second.close > band.ce && second.close > second.open
    : second.open > band.ce && second.close < band.ce && second.close < second.open;
  const secondLarge = bodyFraction(second) >= policy.secondBarReversalMinimumBodyFraction
    && Math.abs(second.close - second.open) >= atr15 * policy.secondBarReversalMinimumBodyAtr;
  if (!secondCross || !secondLarge) return { state: 'INVALID', reason: 'SECOND_BAR_CE_REVERSAL_FAILED', first, second };
  if (now - second.closeTime > policy.secondBarReversalMaximumAgeMs)
    return { state: 'INVALID', reason: 'SECOND_BAR_CE_REVERSAL_EXPIRED', first, second };
  const age = now - Number(quote?.time), bid = Number(quote?.bidPrice), ask = Number(quote?.askPrice);
  const quoteFresh = Number.isFinite(age) && age >= -1000 && age <= 15000 && bid > 0 && ask >= bid;
  const executablePrice = quoteFresh ? (long ? ask : bid) : null;
  const drift = executablePrice === null ? null : Math.abs(executablePrice - second.close) / second.close;
  const admissible = executablePrice !== null && (long ? executablePrice > band.ce : executablePrice < band.ce)
    && drift <= policy.secondBarReversalMaximumPriceDriftFraction;
  return { state: admissible ? 'SECOND_BAR_REVERSE_READY' : 'WAIT_SECOND_BAR_PRICE', stop: revisedStop,
    entry: admissible ? priceRound(executablePrice, tick, long) : priceRound(second.close, tick, long),
    confirmationAt: second.closeTime, quoteFresh, executablePrice,
    evidence: { source: 'CLOSED_15M_SECOND_BAR_CE_REVERSAL', firstBarAt: first.closeTime,
      firstBarExtreme: long ? first.low : first.high, firstOpen: first.open, firstHigh: first.high,
      firstLow: first.low, firstClose: first.close, secondBarAt: second.closeTime,
      secondOpen: second.open, secondHigh: second.high, secondLow: second.low, secondClose: second.close,
      secondExtreme: long ? second.low : second.high, oldStop: stop, revisedStop, atr15, plannedStopSwept,
      maximumPriceDriftFraction: policy.secondBarReversalMaximumPriceDriftFraction } };
}

export function smcNetRewardRisk({ entry, stop, target, direction }) {
  check([entry, stop, target].every(value => Number.isFinite(value) && value > 0)
    && ['LONG', 'SHORT'].includes(direction), 'PLAN_PRICES_INVALID');
  const sign = direction === 'LONG' ? 1 : -1;
  const rate = (policy.feeBpsPerSide + policy.slippageBpsPerSide) / 10000;
  const risk = sign * (entry - stop) + (entry + stop) * rate + entry * policy.fundingReserveBps / 10000
    + stop * Math.max(0, (policy.stopSlippageBps ?? STOP_SLIPPAGE_BPS) - policy.slippageBpsPerSide) / 10000;
  const reward = sign * (target - entry) - (entry + target) * rate - entry * policy.fundingReserveBps / 10000;
  if (sign * (entry - stop) <= 0 || reward <= 0) return { qualified: false, netR: null };
  return { qualified: reward >= policy.minimumNetRewardRisk * risk, netR: reward / risk,
    riskPerUnit: risk, netRewardPerUnit: reward };
}

/** Closed-bar screening only. Live order authority remains in the single SMC executor. */
export function scanSmcSymbol({ symbol, bars4h, bars15m, quote, tickSize, now, ownerSelections = [], structureContext = null }) {
  check(policy.universe.includes(symbol) && Number.isFinite(now), 'SCAN_SCOPE_INVALID');
  check(!quote || quote.symbol === symbol, 'QUOTE_SYMBOL_MISMATCH');
  check(Array.isArray(ownerSelections) && ownerSelections.length <= 2 && ownerSelections.every(row =>
    row?.symbol === symbol && ['LONG', 'SHORT'].includes(row.direction)
    && Number.isFinite(row.selectedAt) && typeof row.autoTradingEnabled === 'boolean'
    && row.selectedAt <= now + 5000), 'OWNER_SELECTION_SCOPE_INVALID');
  const ownerSelection = new Map(ownerSelections.map(row => [row.direction, row]));
  const candidateSource = direction => ownerSelection.has(direction) ? 'OWNER_SELECTED' : 'AUTOMATIC';
  const candidateExpiresAt = (breakClose, direction) => candidateSource(direction) === 'OWNER_SELECTED'
    ? now + policy.ownerSelectionLeaseMs : breakClose + policy.maximumCandidateAgeBars4h * H4;
  const h = smcBars(bars4h, H4, now), m = smcBars(bars15m, M15, now);
  const pivots4h = confirmedSmcPivots(h, policy.externalSwingLeft, policy.externalSwingRight);
  const tick = Number(tickSize); check(tick > 0 && Number.isFinite(tick), 'TICK_SIZE_MISSING');
  const stopContext = structureContext ? stopSafetyContext({symbol,bars15m,tickSize,now,structureContext}) : null;
  const hierarchy = traceContextBars({ symbol, timeframe: '4h', tick, bars: h });
  const hierarchyEvents = new Map(hierarchy.events.map(e => [`${e.at}:${e.direction}`, e]));
  const hierarchyFor = (at, direction, endpoint) => {
    const event = hierarchyEvents.get(`${at}:${direction}`);
    const matches = event && event.endpointId.endsWith(`:${endpoint.time}`) && Math.abs(event.level - endpoint.price) < tick / 2;
    return { revision: 'SMC-HIERARCHY-1', scope: matches ? event.scope : 'UNCONFIRMED',
      event: matches ? event.type : 'NO_MATCHING_EXTERNAL_EVENT',
      externalQualified: Boolean(matches && ['BOS', 'TREND_CONFIRMED'].includes(event.type)),
      endpointId: matches ? event.endpointId : null, endpointAt: matches ? endpoint.time : null,
      endpointAvailableAt: matches ? event.endpointAvailableAt : null, eventAt: matches ? event.at : null,
      protectedPointId: matches ? event.protectedPointId : null };
  };
  const candidates = [], structures = [], invalidatedPlans = [], rejected = {};
  const reject = reason => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  const invalidate = (id, direction, reason, evidence = {}) => {
    reject(reason);
    invalidatedPlans.push({ id, symbol, direction, reason, ...evidence });
  };
  const observe = row => structures.push({ symbol, ...row, orderAuthority: false });
  const structureStartIndex = Math.max(60, h.length - policy.structureLookbackBars4h);
  const candidateStartTime = now - policy.maximumCandidateAgeBars4h * H4;
  for (let breakIndex = structureStartIndex; breakIndex < h.length; breakIndex++) {
    const breakBar = h[breakIndex], previous = h[breakIndex - 1], a4 = atr(h, breakIndex - 1);
    const known = pivots4h.filter(pivot => pivot.confirmedAt < breakBar.openTime);
    const priorBias = smcStructureBias(known);
    for (const direction of ['LONG', 'SHORT']) {
      const long = direction === 'LONG';
      const hierarchyEvent = hierarchyEvents.get(`${breakBar.closeTime}:${direction}`);
      const externalEvent = hierarchyEvent && ['BOS', 'TREND_CONFIRMED'].includes(hierarchyEvent.type);
      const brokenPivot = externalEvent ? known.find(p => hierarchyEvent.endpointId.endsWith(`:${p.time}`) && p.kind === (long ? 'HIGH' : 'LOW'))
        : known.filter(pivot => pivot.kind === (long ? 'HIGH' : 'LOW')).at(-1);
      const protectedPivot = externalEvent ? known.find(p => hierarchyEvent.protectedPointId?.endsWith(`:${p.time}`) && p.kind === (long ? 'LOW' : 'HIGH'))
        : known.filter(pivot => pivot.kind === (long ? 'LOW' : 'HIGH')).at(-1);
      if (!brokenPivot || !protectedPivot) continue;
      const buffer = Math.max(2 * tick, a4 * policy.bosBufferAtr);
      const crossed = long
        ? breakBar.close > brokenPivot.price + buffer && previous.close <= brokenPivot.price + buffer
        : breakBar.close < brokenPivot.price - buffer && previous.close >= brokenPivot.price - buffer;
      if (!crossed) continue;
      const quality = displacementQuality(h, breakIndex, a4, direction), metrics = quality.metrics;
      const eventType = externalEvent ? canonicalExternalEventType(hierarchyEvent.type) : priorBias === (long ? 'BULLISH' : 'BEARISH') ? 'BOS'
        : priorBias === (long ? 'BEARISH' : 'BULLISH') ? 'CHOCH' : 'MSS';
      const liquiditySweep = htfLiquiditySweep({ bars: h, pivot: protectedPivot, direction,
        breakIndex, buffer: Math.max(2 * tick, a4 * policy.externalSweepBufferAtr) });
      const missingReversalSweep = externalEventRequiresSweep(externalEvent ? hierarchyEvent : { type: eventType, priorBias, direction }) && policy.reversalRequiresLiquiditySweep && !liquiditySweep;
      const grade = missingReversalSweep && quality.grade === 'A' ? 'B' : quality.grade;
      const observationReasons = [...(quality.grade === 'C' ? ['WEAK_DISPLACEMENT'] : []),
        ...(missingReversalSweep ? ['REVERSAL_WITHOUT_LIQUIDITY_SWEEP'] : [])];
      const structureHierarchy = hierarchyFor(breakBar.closeTime, direction, brokenPivot);
      if (!structureHierarchy.externalQualified) observationReasons.push('INTERNAL_OR_UNCONFIRMED_EXTERNAL_STRUCTURE');
      const observationOnly = grade === 'C' || missingReversalSweep || !structureHierarchy.externalQualified;
      observe({ id: `${symbol}-${direction}-${eventType}-${breakBar.openTime}`, direction, eventType: structureHierarchy.externalQualified ? eventType : structureHierarchy.event === 'CHOCH' ? 'CHOCH' : structureHierarchy.scope === 'INTERNAL' ? 'INTERNAL_BREAK' : 'UNCONFIRMED_BREAK', priorBias,
        grade, admission: observationOnly ? 'OBSERVE_ONLY' : 'PLAN_ELIGIBLE', breakAt: breakBar.closeTime,
        breakClose: breakBar.close, qualityModel: quality.model, qualityBars: quality.bars,
        bodyAtr: rounded(metrics.bodyAtr), bodyFraction: rounded(metrics.bodyFraction),
        volumeRatio: rounded(metrics.volumeRatio), liquiditySweep: liquiditySweep ?? null, reasons: observationReasons, hierarchy: structureHierarchy });
      if (!structureHierarchy.externalQualified) { reject('EXTERNAL_STRUCTURE_NOT_CONFIRMED'); continue; }
      if (grade === 'C') { reject('STRUCTURE_OBSERVE_ONLY_WEAK_QUALITY'); continue; }
      if (missingReversalSweep) { reject('REVERSAL_REQUIRES_LIQUIDITY_SWEEP'); continue; }
      if (breakBar.closeTime < candidateStartTime && !ownerSelection.has(direction)) { reject('STRUCTURE_OUTSIDE_ACTIVE_PLAN_HORIZON'); continue; }
      const fvgs = fvgsInDisplacementLeg(h, breakIndex, direction, tick);
      if (!fvgs.length) { reject('NO_FVG'); continue; }
      const structureBreak = h.slice(breakIndex + 1).find(row => long ? row.close < protectedPivot.price : row.close > protectedPivot.price);
      if (structureBreak) {
        invalidate(`${symbol}-${direction}-${eventType}-${breakBar.openTime}-${fvgs.at(-1).availableAt}`, direction,
          'PROTECTED_STRUCTURE_BROKEN', { detectedAt: structureBreak.closeTime,
          timeframe: '4H', level: rounded(protectedPivot.price), observed: rounded(structureBreak.close) }); continue;
      }
      const alternatives = viableDisplacementFvgContexts({ fvgs, bars4h: h, bars15m: m, direction, tick,
        orderBlock: orderBlockBefore(h, breakIndex, direction), ownerSelected: ownerSelection.has(direction) });
      let selected = null;
      for (const alternative of alternatives) {
        const id = `${symbol}-${direction}-${eventType}-${breakBar.openTime}-${alternative.zone.availableAt}`;
        if (alternative.invalidation) {
          const { reason, ...evidence } = alternative.invalidation;
          invalidate(id, direction, reason, { ...evidence, detectedAt: evidence.detectedAt ?? now });
        } else if (alternative.rejection) reject(alternative.rejection);
        else { selected = { ...alternative, planId: id }; break; }
      }
      if (!selected) continue;
      const { zone, band, planId, after4h, after15m, partialCoverage, poiLifecycle } = selected;
      let trigger = findInternalConfirmation({ bars: m, zone, direction, tick, now, quote });
      const referenceEntry = rounded(band.trigger);
      let entry = referenceEntry;
      const stopBase = zone.invalidation;
      let stop = priceRound(stopBase + (long ? -1 : 1) * trigger.atr15 * policy.stopBufferAtr, tick, !long);
      const historicalStopBreak = partialCoverage && after4h.find(row => long ? row.low <= stop : row.high >= stop);
      if (historicalStopBreak) {
        invalidate(planId, direction, 'HISTORICAL_STOP_REGION_BREACHED', { detectedAt: historicalStopBreak.closeTime,
          timeframe: '4H', level: rounded(stop), observed: rounded(long ? historicalStopBreak.low : historicalStopBreak.high) }); continue;
      }
      const stopBreak = after15m.find(row => long ? row.low <= stop : row.high >= stop);
      const reversal = classifySmcSecondBarReversal({ bars: after15m, stop, band, direction, tick, now, quote, atr15: trigger.atr15 });
      const reversible = ['WAIT_SECOND_BAR', 'SECOND_BAR_REVERSE_READY', 'WAIT_SECOND_BAR_PRICE'].includes(reversal.state);
      if (stopBreak && !reversible) {
        invalidate(planId, direction, reversal.reason ?? 'STOP_REGION_ALREADY_BREACHED', { detectedAt: stopBreak.closeTime,
          timeframe: '15M', level: rounded(stop), observed: rounded(long ? stopBreak.low : stopBreak.high) }); continue;
      }
      if (reversible) {
        stop = reversal.stop;
        entry = reversal.entry ?? referenceEntry;
        trigger = { ...trigger, status: reversal.state === 'WAIT_SECOND_BAR' ? 'WAIT_SECOND_BAR_CE_REVERSAL'
          : reversal.state === 'SECOND_BAR_REVERSE_READY' ? 'SECOND_BAR_REVERSE_READY' : 'WAIT_SECOND_BAR_PRICE',
          reversal: reversal.evidence, confirmationAt: reversal.confirmationAt ?? reversal.first.closeTime,
          quoteFresh: reversal.quoteFresh ?? false, executablePrice: reversal.executablePrice ?? null };
      }
      const entryMicroStructure = trigger.reversal ? {
        model: 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT', state: trigger.status, ready: true,
        touchAt: trigger.touchAt, confirmedAt: trigger.confirmationAt, source: 'SECOND_BAR_FALSE_BREAK_RECLAIM',
      } : smcMicroStructureConfirmationContext({ bars: m, direction, ceTouchAt: trigger.ceTouch?.testedAt,
        tick, now, quote, band });
      if (!trigger.reversal && entryMicroStructure.state === 'MICRO_SHIFT_WINDOW_EXPIRED') {
        invalidate(planId, direction, 'MICRO_STRUCTURE_SHIFT_NOT_CONFIRMED', {
          detectedAt: trigger.ceTouch.testedAt + policy.entryMicroStructureMaximumBarsAfterTouch * M15,
          timeframe: '15M', level: rounded(band.ce), observed: rounded(trigger.ceTouch.close) }); continue;
      }
      if (!trigger.reversal && entryMicroStructure.state === 'MICRO_SHIFT_CONFIRMATION_EXPIRED') {
        invalidate(planId, direction, 'MICRO_STRUCTURE_CONFIRMATION_EXPIRED', {
          detectedAt: entryMicroStructure.confirmedAt + policy.entryMicroStructureMaximumAgeMs,
          timeframe: 'SYSTEM', level: rounded(band.ce), observed: rounded(entryMicroStructure.close) }); continue;
      }
      if (!trigger.reversal && trigger.ceTouch) trigger = { ...trigger,
        status: entryMicroStructure.state, confirmationAt: entryMicroStructure.confirmedAt ?? trigger.ceTouch.testedAt,
        quoteFresh: entryMicroStructure.quoteFresh ?? trigger.quoteFresh,
        executablePrice: entryMicroStructure.executablePrice ?? trigger.executablePrice,
        insideBand: entryMicroStructure.insideBand ?? false };
      entry = ['ENTRY_BAND_ACTIVE', 'SECOND_BAR_REVERSE_READY'].includes(trigger.status)
        ? priceRound(trigger.executablePrice, tick, long) : referenceEntry;
      const evidenceAt = trigger.reversal ? trigger.confirmationAt
        : entryMicroStructure.confirmedAt ?? trigger.ceTouch?.testedAt ?? trigger.confirmationAt;
      const entryLiquidity = smcEntryLiquidityContext({ bars: m, zone, direction, tick,
        confirmationAt: evidenceAt, provisionalStop: stop });
      stop = entryLiquidity.adjustedStop;
      if (stopContext) {
        const safer = plannedSafeStop({context:stopContext,symbol,direction,entry,anchor:stop,now,costModel:policy});
        stop = long ? Math.min(stop,safer) : Math.max(stop,safer);
        entryLiquidity.adjustedStop = stop;
        entryLiquidity.stopAdjustedForLiquidity = stop !== entryLiquidity.provisionalStop;
      }
      const entryLocation = smcEntryLocationContext({ bars: m, direction,
        confirmationAt: evidenceAt, referenceEntry });
      const entryRegime = smcEntryRegimeContext({ bars: m, direction, confirmationAt: evidenceAt });
      if ((entryMicroStructure.ready && trigger.ceTouch) || trigger.reversal) {
        if (!entryLiquidity.ready) trigger = { ...trigger, status: 'WAIT_LIQUIDITY_SWEEP_RECLAIM', insideBand: false };
        else if (!entryLocation.ready) trigger = { ...trigger, status: 'WAIT_VALUE_LOCATION', insideBand: false };
        else if (!entryRegime.ready) trigger = { ...trigger, status: 'WAIT_15M_EXPANSION_CONFIRMATION', insideBand: false };
      }
      const targetKind = long ? 'HIGH' : 'LOW';
      const targets = pivots4h.filter(pivot => pivot.kind === targetKind && (long ? pivot.price > entry : pivot.price < entry)
        && !h.slice(pivot.index + 1).some(row => long ? row.high >= pivot.price : row.low <= pivot.price))
        .sort((a, b) => long ? a.price - b.price : b.price - a.price);
      if (!targets.length) { invalidate(planId, direction, 'NO_UNSWEPT_STRUCTURE_TARGET', { detectedAt: now, timeframe: '4H' }); continue; }
      const target = priceRound(targets[0].price + (long ? -2 : 2) * tick, tick, !long);
      const rr = smcNetRewardRisk({ entry, stop, target, direction });
      if (!rr.qualified) { invalidate(planId, direction, 'NET_R_BELOW_2', { detectedAt: now, timeframe: '15M', level: rounded(target), observed: rounded(entry) }); continue; }
      const targetVisit = after15m.find(row => long ? row.high >= target : row.low <= target);
      if (targetVisit) {
        invalidate(planId, direction, 'TARGET_ALREADY_VISITED', { detectedAt: targetVisit.closeTime,
          timeframe: '15M', level: rounded(target), observed: rounded(long ? targetVisit.high : targetVisit.low) }); continue;
      }
      const distance = priceDistanceToBand(trigger.executablePrice, band);
      const expiresAt = candidateExpiresAt(breakBar.closeTime, direction);
      if (expiresAt <= now) { invalidate(planId, direction, 'SETUP_EXPIRED', { detectedAt: expiresAt, timeframe: 'SYSTEM' }); continue; }
      candidates.push({
        id: planId,
        symbol, direction, status: trigger.status, revision: policy.revision,
        candidateSource: candidateSource(direction), ownerSelectedAt: ownerSelection.get(direction)?.selectedAt ?? null,
        ownerAutoTradingEnabled: ownerSelection.get(direction)?.autoTradingEnabled ?? null,
        entry, referenceEntry, entryBand: { low: rounded(band.low), high: rounded(band.high), ce: rounded(band.ce),
          trigger: rounded(band.trigger), triggerFraction: band.triggerFraction,
          zoneFraction: band.zoneFraction, half: band.half },
        stop, target, netR: rounded(rr.netR), riskPerUnit: rounded(rr.riskPerUnit), netRewardPerUnit: rounded(rr.netRewardPerUnit),
        zone: { ...zone, low: rounded(zone.low), high: rounded(zone.high), invalidation: rounded(zone.invalidation),
          ce: rounded(zone.ce), entryBand: { low: rounded(band.low), high: rounded(band.high) } },
        poiLifecycle,
        entryLiquidity,
        entryLocation,
        entryRegime,
        entryMicroStructure,
        structure: {
          eventType, priorBias, hierarchy: structureHierarchy, currentBias: long ? 'BULLISH' : 'BEARISH', brokenPivot, protectedPivot,
          bosAt: breakBar.closeTime, bosClose: breakBar.close, volumeRatio: rounded(metrics.volumeRatio),
          bodyFraction: rounded(metrics.bodyFraction), bodyAtr: rounded(metrics.bodyAtr), liquiditySweep, targetPivot: targets[0],
          qualityGrade: grade, qualityModel: quality.model, qualityBars: quality.bars,
          missingHigherTimeframeSweep: missingReversalSweep, nPatternRequired: false,
        },
        entryConfirmation: { state: trigger.status, mode: trigger.reversal ? 'CLOSED_15M_SECOND_BAR_CE_REVERSAL' : 'CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT', reversal: trigger.reversal ?? null,
          touchAt: trigger.touchAt, touchCount: trigger.touches, ceTouch: trigger.ceTouch,
          microStructure: entryMicroStructure, liveBboInsideBand: trigger.insideBand, closedBarRequired: true },
        distanceToEntry: distance === null ? null : {
          executablePrice: rounded(trigger.executablePrice), absolute: distance.absolute, percent: distance.percent,
          quoteAt: Number(quote.time), side: long ? 'ASK' : 'BID', basis: 'NEAREST_ENTRY_BAND_EDGE',
        },
        confirmationAt: trigger.confirmationAt,
        entryHistoryCoverage: partialCoverage ? 'CURRENT_15M_WINDOW_WITH_FULL_4H_VALIDATION' : 'CONTINUOUS_FROM_POI',
        entryBarCloseAt: m.at(-1).closeTime, quoteFresh: trigger.quoteFresh,
        observedAt: now, expiresAt, orderAuthority: false, executionQualified: false, winProbability: null,
        reason: trigger.status,
      });
    }
  }
  if (policy.nPatternRole === 'EVALUATED_STRUCTURE_MODEL') {
    for (let breakIndex = structureStartIndex; breakIndex < h.length; breakIndex++) {
      const breakBar = h[breakIndex], previous = h[breakIndex - 1], a4 = atr(h, breakIndex - 1);
      const known = pivots4h.filter(pivot => pivot.confirmedAt < breakBar.openTime);
      for (const direction of ['LONG', 'SHORT']) {
        const long = direction === 'LONG', outerKind = long ? 'LOW' : 'HIGH', breakKind = long ? 'HIGH' : 'LOW';
        const c = known.filter(pivot => pivot.kind === outerKind).at(-1);
        const b = known.filter(pivot => pivot.kind === breakKind && pivot.index < (c?.index ?? -1)).at(-1);
        const a = known.filter(pivot => pivot.kind === outerKind && pivot.index < (b?.index ?? -1)).at(-1);
        if (!a || !b || !c || !(long ? c.price > a.price : c.price < a.price)) continue;
        const buffer = Math.max(2 * tick, a4 * policy.bosBufferAtr);
        const crossed = long
          ? breakBar.close > b.price + buffer && previous.close <= b.price + buffer
          : breakBar.close < b.price - buffer && previous.close >= b.price - buffer;
        if (!crossed || h.slice(c.index + 1, breakIndex).some(row => long
          ? row.close > b.price + buffer : row.close < b.price - buffer)) continue;
        const quality = displacementQuality(h, breakIndex, a4, direction), metrics = quality.metrics;
        const structureHierarchy = hierarchyFor(breakBar.closeTime, direction, b);
        structureHierarchy.externalQualified = structureHierarchy.externalQualified && structureHierarchy.protectedPointId?.endsWith(`:${c.time}`) === true;
        const eventType = canonicalExternalEventType(structureHierarchy.event);
        const liquiditySweep = htfLiquiditySweep({ bars: h, pivot: c, direction,
          breakIndex, buffer: Math.max(2 * tick, a4 * policy.externalSweepBufferAtr) });
        const missingReversalSweep = externalEventRequiresSweep(hierarchyEvents.get(`${breakBar.closeTime}:${direction}`)) && policy.reversalRequiresLiquiditySweep && !liquiditySweep;
        observe({ id: `${symbol}-${direction}-N-${breakBar.openTime}`, direction, eventType: structureHierarchy.externalQualified ? eventType : structureHierarchy.scope === 'INTERNAL' ? 'INTERNAL_BREAK' : 'UNCONFIRMED_BREAK', priorBias: 'RANGE',
          grade: quality.grade, admission: quality.grade === 'C' || !structureHierarchy.externalQualified || missingReversalSweep ? 'OBSERVE_ONLY' : 'PLAN_ELIGIBLE',
          breakAt: breakBar.closeTime, breakClose: breakBar.close, qualityModel: quality.model, qualityBars: quality.bars,
          bodyAtr: rounded(metrics.bodyAtr), bodyFraction: rounded(metrics.bodyFraction), volumeRatio: rounded(metrics.volumeRatio),
          liquiditySweep: liquiditySweep ?? null, reasons: [...(missingReversalSweep ? ['REVERSAL_WITHOUT_LIQUIDITY_SWEEP'] : []), ...(quality.grade === 'C' ? ['N_PATTERN_WEAK_DISPLACEMENT'] : []), ...(!structureHierarchy.externalQualified ? ['INTERNAL_OR_UNCONFIRMED_EXTERNAL_STRUCTURE'] : [])],
          nPatternQualified: quality.grade !== 'C' && structureHierarchy.externalQualified, hierarchy: structureHierarchy });
        if (!structureHierarchy.externalQualified) { reject('N_PATTERN_EXTERNAL_STRUCTURE_NOT_CONFIRMED'); continue; }
        if (quality.grade === 'C') { reject('N_PATTERN_OBSERVE_ONLY_WEAK_QUALITY'); continue; }
        if (missingReversalSweep) { reject('N_PATTERN_REVERSAL_REQUIRES_LIQUIDITY_SWEEP'); continue; }
        if (breakBar.closeTime < candidateStartTime && !ownerSelection.has(direction)) { reject('N_PATTERN_OUTSIDE_ACTIVE_PLAN_HORIZON'); continue; }
        const fvgs = fvgsInDisplacementLeg(h, breakIndex, direction, tick);
        if (!fvgs.length) { reject('N_PATTERN_NO_FVG'); continue; }
        const structureBreak = h.slice(breakIndex + 1).find(row => long ? row.close < c.price : row.close > c.price);
        if (structureBreak) {
          invalidate(`${symbol}-${direction}-${breakBar.openTime}-${fvgs.at(-1).availableAt}`, direction,
            'N_PATTERN_STRUCTURE_INVALIDATED', { detectedAt: structureBreak.closeTime,
            timeframe: '4H', level: rounded(c.price), observed: rounded(structureBreak.close) }); continue;
        }
        const alternatives = viableDisplacementFvgContexts({ fvgs, bars4h: h, bars15m: m, direction, tick,
          orderBlock: orderBlockBefore(h, breakIndex, direction), ownerSelected: ownerSelection.has(direction) });
        let selected = null;
        for (const alternative of alternatives) {
          const id = `${symbol}-${direction}-${breakBar.openTime}-${alternative.zone.availableAt}`;
          if (alternative.invalidation) {
            const { reason, ...evidence } = alternative.invalidation;
            invalidate(id, direction, reason === 'FVG_INVALIDATED' ? 'N_PATTERN_FVG_INVALIDATED'
              : `N_PATTERN_${reason}`, { ...evidence, detectedAt: evidence.detectedAt ?? now });
          } else if (alternative.rejection) reject(`N_PATTERN_${alternative.rejection}`);
          else { selected = { ...alternative, planId: id }; break; }
        }
        if (!selected) continue;
        const { zone, band, planId, after4h, after15m, partialCoverage, poiLifecycle } = selected;
        let trigger = findInternalConfirmation({ bars: m, zone, direction, tick, now, quote });
        const referenceEntry = rounded(band.trigger);
        let entry = referenceEntry;
        const stopBase = zone.invalidation;
        let stop = priceRound(stopBase + (long ? -1 : 1) * trigger.atr15 * policy.stopBufferAtr, tick, !long);
        const historicalStopBreak = partialCoverage && after4h.find(row => long ? row.low <= stop : row.high >= stop);
        if (historicalStopBreak) {
          invalidate(planId, direction, 'N_PATTERN_HISTORICAL_STOP_REGION_BREACHED', { detectedAt: historicalStopBreak.closeTime,
            timeframe: '4H', level: rounded(stop), observed: rounded(long ? historicalStopBreak.low : historicalStopBreak.high) }); continue;
        }
        const stopBreak = after15m.find(row => long ? row.low <= stop : row.high >= stop);
        const reversal = classifySmcSecondBarReversal({ bars: after15m, stop, band, direction, tick, now, quote, atr15: trigger.atr15 });
        const reversible = ['WAIT_SECOND_BAR', 'SECOND_BAR_REVERSE_READY', 'WAIT_SECOND_BAR_PRICE'].includes(reversal.state);
        if (stopBreak && !reversible) {
          invalidate(planId, direction, reversal.reason ?? 'N_PATTERN_STOP_REGION_ALREADY_BREACHED', { detectedAt: stopBreak.closeTime,
            timeframe: '15M', level: rounded(stop), observed: rounded(long ? stopBreak.low : stopBreak.high) }); continue;
        }
        if (reversible) {
          stop = reversal.stop;
          entry = reversal.entry ?? referenceEntry;
          trigger = { ...trigger, status: reversal.state === 'WAIT_SECOND_BAR' ? 'WAIT_SECOND_BAR_CE_REVERSAL'
            : reversal.state === 'SECOND_BAR_REVERSE_READY' ? 'SECOND_BAR_REVERSE_READY' : 'WAIT_SECOND_BAR_PRICE',
            reversal: reversal.evidence, confirmationAt: reversal.confirmationAt ?? reversal.first.closeTime,
            quoteFresh: reversal.quoteFresh ?? false, executablePrice: reversal.executablePrice ?? null };
        }
        const entryMicroStructure = trigger.reversal ? {
          model: 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT', state: trigger.status, ready: true,
          touchAt: trigger.touchAt, confirmedAt: trigger.confirmationAt, source: 'SECOND_BAR_FALSE_BREAK_RECLAIM',
        } : smcMicroStructureConfirmationContext({ bars: m, direction, ceTouchAt: trigger.ceTouch?.testedAt,
          tick, now, quote, band });
        if (!trigger.reversal && entryMicroStructure.state === 'MICRO_SHIFT_WINDOW_EXPIRED') {
          invalidate(planId, direction, 'N_PATTERN_MICRO_STRUCTURE_SHIFT_NOT_CONFIRMED', {
            detectedAt: trigger.ceTouch.testedAt + policy.entryMicroStructureMaximumBarsAfterTouch * M15,
            timeframe: '15M', level: rounded(band.ce), observed: rounded(trigger.ceTouch.close) }); continue;
        }
        if (!trigger.reversal && entryMicroStructure.state === 'MICRO_SHIFT_CONFIRMATION_EXPIRED') {
          invalidate(planId, direction, 'N_PATTERN_MICRO_STRUCTURE_CONFIRMATION_EXPIRED', {
            detectedAt: entryMicroStructure.confirmedAt + policy.entryMicroStructureMaximumAgeMs,
            timeframe: 'SYSTEM', level: rounded(band.ce), observed: rounded(entryMicroStructure.close) }); continue;
        }
        if (!trigger.reversal && trigger.ceTouch) trigger = { ...trigger,
          status: entryMicroStructure.state, confirmationAt: entryMicroStructure.confirmedAt ?? trigger.ceTouch.testedAt,
          quoteFresh: entryMicroStructure.quoteFresh ?? trigger.quoteFresh,
          executablePrice: entryMicroStructure.executablePrice ?? trigger.executablePrice,
          insideBand: entryMicroStructure.insideBand ?? false };
        entry = ['ENTRY_BAND_ACTIVE', 'SECOND_BAR_REVERSE_READY'].includes(trigger.status)
          ? priceRound(trigger.executablePrice, tick, long) : referenceEntry;
        const evidenceAt = trigger.reversal ? trigger.confirmationAt
          : entryMicroStructure.confirmedAt ?? trigger.ceTouch?.testedAt ?? trigger.confirmationAt;
        const entryLiquidity = smcEntryLiquidityContext({ bars: m, zone, direction, tick,
          confirmationAt: evidenceAt, provisionalStop: stop });
        stop = entryLiquidity.adjustedStop;
      if (stopContext) {
        const safer = plannedSafeStop({context:stopContext,symbol,direction,entry,anchor:stop,now,costModel:policy});
        stop = long ? Math.min(stop,safer) : Math.max(stop,safer);
        entryLiquidity.adjustedStop = stop;
        entryLiquidity.stopAdjustedForLiquidity = stop !== entryLiquidity.provisionalStop;
      }
        const entryLocation = smcEntryLocationContext({ bars: m, direction,
          confirmationAt: evidenceAt, referenceEntry });
        const entryRegime = smcEntryRegimeContext({ bars: m, direction, confirmationAt: evidenceAt });
        if ((entryMicroStructure.ready && trigger.ceTouch) || trigger.reversal) {
          if (!entryLiquidity.ready) trigger = { ...trigger, status: 'WAIT_LIQUIDITY_SWEEP_RECLAIM', insideBand: false };
          else if (!entryLocation.ready) trigger = { ...trigger, status: 'WAIT_VALUE_LOCATION', insideBand: false };
          else if (!entryRegime.ready) trigger = { ...trigger, status: 'WAIT_15M_EXPANSION_CONFIRMATION', insideBand: false };
        }
        const targets = known.filter(pivot => pivot.kind === breakKind && (long ? pivot.price > entry : pivot.price < entry)
          && !h.slice(pivot.index + 1).some(row => long ? row.high >= pivot.price : row.low <= pivot.price))
          .sort((x, y) => long ? x.price - y.price : y.price - x.price);
        if (!targets.length) { invalidate(planId, direction, 'N_PATTERN_NO_UNSWEPT_TARGET', { detectedAt: now, timeframe: '4H' }); continue; }
        const target = priceRound(targets[0].price + (long ? -2 : 2) * tick, tick, !long);
        const rr = smcNetRewardRisk({ entry, stop, target, direction });
        if (!rr.qualified) { invalidate(planId, direction, 'N_PATTERN_NET_R_BELOW_2', { detectedAt: now, timeframe: '15M', level: rounded(target), observed: rounded(entry) }); continue; }
        const targetVisit = after15m.find(row => long ? row.high >= target : row.low <= target);
        if (targetVisit) {
          invalidate(planId, direction, 'N_PATTERN_TARGET_VISITED', { detectedAt: targetVisit.closeTime,
            timeframe: '15M', level: rounded(target), observed: rounded(long ? targetVisit.high : targetVisit.low) }); continue;
        }
        const expiresAt = candidateExpiresAt(breakBar.closeTime, direction);
        if (expiresAt <= now) { invalidate(planId, direction, 'N_PATTERN_SETUP_EXPIRED', { detectedAt: expiresAt, timeframe: 'SYSTEM' }); continue; }
        const distance = priceDistanceToBand(trigger.executablePrice, band);
        candidates.push({
          id: planId,
          symbol, direction, status: trigger.status, revision: policy.revision,
          candidateSource: candidateSource(direction), ownerSelectedAt: ownerSelection.get(direction)?.selectedAt ?? null,
          ownerAutoTradingEnabled: ownerSelection.get(direction)?.autoTradingEnabled ?? null,
          entry, referenceEntry,
          entryBand: { low: rounded(band.low), high: rounded(band.high), ce: rounded(band.ce),
            trigger: rounded(band.trigger), triggerFraction: band.triggerFraction,
            zoneFraction: band.zoneFraction, half: band.half },
          stop, target, netR: rounded(rr.netR), riskPerUnit: rounded(rr.riskPerUnit),
          netRewardPerUnit: rounded(rr.netRewardPerUnit),
          zone: { ...zone, low: rounded(zone.low), high: rounded(zone.high), invalidation: rounded(zone.invalidation),
            ce: rounded(zone.ce), entryBand: { low: rounded(band.low), high: rounded(band.high) } },
          poiLifecycle,
          entryLiquidity,
          entryLocation,
          entryRegime,
          entryMicroStructure,
          structure: {
            eventType, priorBias: 'RANGE', hierarchy: structureHierarchy, currentBias: long ? 'BULLISH' : 'BEARISH',
            brokenPivot: b, protectedPivot: c, bosAt: breakBar.closeTime, bosClose: breakBar.close,
            volumeRatio: rounded(metrics.volumeRatio), bodyFraction: rounded(metrics.bodyFraction),
            bodyAtr: rounded(metrics.bodyAtr), liquiditySweep: liquiditySweep ?? null, targetPivot: targets[0],
            qualityGrade: quality.grade, qualityModel: quality.model, qualityBars: quality.bars,
            missingHigherTimeframeSweep: false,
            nPatternRequired: false, nPatternQualified: true,
            nPattern: { A: a, B: b, C: c, D: { openTime: breakBar.openTime, closeTime: breakBar.closeTime,
              close: breakBar.close, bodyFraction: rounded(metrics.bodyFraction), bodyAtr: rounded(metrics.bodyAtr),
              volumeRatio: rounded(metrics.volumeRatio) } },
          },
          entryConfirmation: { state: trigger.status, mode: trigger.reversal ? 'CLOSED_15M_SECOND_BAR_CE_REVERSAL' : 'CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT', reversal: trigger.reversal ?? null,
            touchAt: trigger.touchAt, touchCount: trigger.touches, ceTouch: trigger.ceTouch,
            microStructure: entryMicroStructure, liveBboInsideBand: trigger.insideBand, closedBarRequired: true },
          distanceToEntry: distance === null ? null : {
            executablePrice: rounded(trigger.executablePrice), absolute: distance.absolute, percent: distance.percent,
            quoteAt: Number(quote.time), side: long ? 'ASK' : 'BID', basis: 'NEAREST_ENTRY_BAND_EDGE',
          },
          confirmationAt: trigger.confirmationAt,
          entryHistoryCoverage: partialCoverage ? 'CURRENT_15M_WINDOW_WITH_FULL_4H_VALIDATION' : 'CONTINUOUS_FROM_POI',
          entryBarCloseAt: m.at(-1).closeTime, quoteFresh: trigger.quoteFresh,
          observedAt: now, expiresAt, orderAuthority: false, executionQualified: false,
          winProbability: null, reason: trigger.status,
        });
      }
    }
  }
  const unique = [...new Map(candidates.sort((a, b) => b.structure.bosAt - a.structure.bosAt)
    .map(candidate => [`${candidate.direction}:${candidate.zone.availableAt}`, candidate])).values()].slice(0, policy.maximumCandidatesPerSymbol);
  const latestStructures = [...new Map(structures.sort((a, b) => b.breakAt - a.breakAt)
    .map(row => [`${row.direction}:${row.eventType}:${row.breakAt}`, row])).values()].slice(0, policy.maximumStructureObservationsPerSymbol);
  return { symbol, candidates: unique, structures: latestStructures,
    manualZones: nearbySmcZones(h, quote, tick, now), invalidatedPlans, rejected,
    last4hCloseAt: h.at(-1).closeTime, last15mCloseAt: m.at(-1).closeTime };
}
