import { adxSeries, atrSeries, latestBarIndexClosedBefore, olsSlope } from "./indicators.mjs";
import { validateDataset } from "./market-data.mjs";
import {
  createAuditLedger,
  deterministicId,
  invariant,
  round,
  sha256,
  stableStringify,
  verifyAuditLedger,
} from "./utils.mjs";

const EPSILON = 1e-10;

function nearlyEqual(first, second) {
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= scale * EPSILON;
}

function aggregateOhlc(bars) {
  return {
    open: bars[0].open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: bars.at(-1).close,
  };
}

function crossTimeframeIssues(lowerBars, higherBars, lowerIntervalMs, expectedChildren, label) {
  const lowerByOpen = new Map(lowerBars.map((bar) => [bar.openTime, bar]));
  const issues = [];
  let compared = 0;
  for (const higher of higherBars) {
    const children = Array.from({ length: expectedChildren }, (_, index) => lowerByOpen.get(higher.openTime + (index * lowerIntervalMs)));
    if (children.every(Boolean)) {
      compared += 1;
      const aggregate = aggregateOhlc(children);
      for (const field of ["open", "high", "low", "close"]) {
        if (!nearlyEqual(aggregate[field], higher[field])) {
          issues.push({ label, openTime: higher.openTime, field, aggregate: aggregate[field], higher: higher[field] });
        }
      }
    }
  }
  return { compared, issues };
}

export function assessCrossTimeframeConsistency({ fifteenMinute, oneHour, fourHour }) {
  const fifteenToOne = crossTimeframeIssues(fifteenMinute.bars, oneHour.bars, 15 * 60_000, 4, "15M_TO_1H");
  const oneToFour = crossTimeframeIssues(oneHour.bars, fourHour.bars, 60 * 60_000, 4, "1H_TO_4H");
  const issues = [...fifteenToOne.issues, ...oneToFour.issues];
  return {
    status: issues.length ? "INCONSISTENT" : "CONSISTENT",
    comparisons: {
      fifteenMinuteToOneHour: fifteenToOne.compared,
      oneHourToFourHour: oneToFour.compared,
    },
    issues: issues.slice(0, 100),
    truncatedIssueCount: Math.max(0, issues.length - 100),
  };
}

export function buildRangeSnapshots(oneHourBars, config) {
  const hypothesis = config.hypothesis;
  const lookback = hypothesis.rangeLookbackBars1h;
  const atr = atrSeries(oneHourBars, 14);
  const adx = adxSeries(oneHourBars, 14);
  const snapshots = Array(oneHourBars.length).fill(null);

  for (let index = lookback - 1; index < oneHourBars.length; index += 1) {
    const window = oneHourBars.slice(index - lookback + 1, index + 1);
    const atr14 = atr[index];
    const adx14 = adx[index];
    if (!(atr14 > 0) || !Number.isFinite(adx14)) continue;
    const lowerBoundary = Math.min(...window.map((bar) => bar.low));
    const upperBoundary = Math.max(...window.map((bar) => bar.high));
    const height = upperBoundary - lowerBoundary;
    const zoneWidth = height * hypothesis.entryZoneFractionOfRange;
    const midline = (lowerBoundary + upperBoundary) / 2;
    const lowerTouches = window.filter((bar) => bar.low <= lowerBoundary + zoneWidth).length;
    const upperTouches = window.filter((bar) => bar.high >= upperBoundary - zoneWidth).length;
    const heightAtr = height / atr14;
    const slopeBars = window.slice(-24).map((bar) => bar.close);
    const absoluteSlopeAtrPer24Bars = Math.abs(olsSlope(slopeBars) * 24) / atr14;
    const checks = {
      minimumLowerTouches: lowerTouches >= hypothesis.minimumBoundaryTouchesPerSide,
      minimumUpperTouches: upperTouches >= hypothesis.minimumBoundaryTouchesPerSide,
      maximumAdx: adx14 <= hypothesis.maximumAdx14,
      maximumSlope: absoluteSlopeAtrPer24Bars <= hypothesis.maximumAbsoluteLinearSlopeAtrPer24Bars,
      minimumHeightAtr: heightAtr >= hypothesis.minimumRangeHeightAtr14,
      maximumHeightAtr: heightAtr <= hypothesis.maximumRangeHeightAtr14,
    };
    const eligible = Object.values(checks).every(Boolean);
    const snapshot = {
      id: deterministicId("v4rg1_range", {
        start: window[0].openTime,
        end: window.at(-1).closeTime,
        lowerBoundary,
        upperBoundary,
      }),
      eligible,
      startBarIndex: index - lookback + 1,
      endBarIndex: index,
      startTime: window[0].openTime,
      availableAt: window.at(-1).closeTime,
      lowerBoundary,
      upperBoundary,
      midline,
      height,
      zoneWidth,
      lowerTouches,
      upperTouches,
      atr14_1h: atr14,
      adx14_1h: adx14,
      heightAtr14_1h: heightAtr,
      absoluteSlopeAtrPer24Bars,
      checks,
    };
    snapshots[index] = snapshot;
  }
  return { snapshots, atr14_1h: atr, adx14_1h: adx };
}

export function classifyBoundaryRejection(bar, range) {
  const closesInside = bar.close > range.lowerBoundary && bar.close < range.upperBoundary;
  const longCandidate = closesInside
    && bar.low <= range.lowerBoundary + range.zoneWidth
    && bar.close <= range.midline;
  const shortCandidate = closesInside
    && bar.high >= range.upperBoundary - range.zoneWidth
    && bar.close >= range.midline;
  if (longCandidate && shortCandidate) return { status: "AMBIGUOUS_DUAL_BOUNDARY", side: null };
  if (longCandidate) return { status: "SIGNAL", side: "LONG" };
  if (shortCandidate) return { status: "SIGNAL", side: "SHORT" };
  return { status: "NO_SIGNAL", side: null };
}

export function adverseFill(referencePrice, action, rate) {
  invariant(Number.isFinite(referencePrice) && referencePrice > 0, "V4_RG1_FILL_REFERENCE_INVALID");
  invariant(action === "BUY" || action === "SELL", "V4_RG1_FILL_ACTION_INVALID");
  invariant(Number.isFinite(rate) && rate >= 0 && rate < 0.01, "V4_RG1_FILL_SLIPPAGE_INVALID");
  return action === "BUY" ? referencePrice * (1 + rate) : referencePrice * (1 - rate);
}

function slippageCost(referencePrice, fillPrice, quantity, action) {
  return action === "BUY"
    ? Math.max(0, (fillPrice - referencePrice) * quantity)
    : Math.max(0, (referencePrice - fillPrice) * quantity);
}

function breakoutEvidence(range, oneHourBars, atr14_1h, beforeTime) {
  const latestIndex = latestBarIndexClosedBefore(oneHourBars, beforeTime);
  for (let index = range.endBarIndex + 1; index <= latestIndex; index += 1) {
    const bar = oneHourBars[index];
    const atr = atr14_1h[index];
    if (!(atr > 0)) continue;
    const buffer = 0.5 * atr;
    if (bar.close < range.lowerBoundary - buffer || bar.close > range.upperBoundary + buffer) {
      return {
        detectedAt: bar.closeTime,
        oneHourBarIndex: index,
        close: bar.close,
        atr14_1h: atr,
        lowerInvalidation: range.lowerBoundary - buffer,
        upperInvalidation: range.upperBoundary + buffer,
      };
    }
  }
  return null;
}

function entryReferenceStillValid(side, referencePrice, range) {
  if (side === "LONG") return referencePrice > range.lowerBoundary && referencePrice < range.midline;
  return referencePrice < range.upperBoundary && referencePrice > range.midline;
}

function makePosition({ pending, bar, index, replayConfig, ledger }) {
  const action = pending.side === "LONG" ? "BUY" : "SELL";
  const entryReferencePrice = bar.open;
  const entryPrice = adverseFill(entryReferencePrice, action, replayConfig.adverseSlippageRatePerFill);
  const originalQuantity = replayConfig.normalizedNotionalPerTradeUsdt / entryPrice;
  const entryNotional = originalQuantity * entryPrice;
  const entryFee = entryNotional * replayConfig.takerFeeRatePerFill;
  const entrySlippageCost = slippageCost(entryReferencePrice, entryPrice, originalQuantity, action);
  const position = {
    id: deterministicId("v4rg1_trade", {
      signalTime: pending.signalTime,
      entryTime: bar.openTime,
      side: pending.side,
      rangeId: pending.range.id,
    }),
    side: pending.side,
    range: pending.range,
    context4h: pending.context4h,
    signalBar: pending.signalBar,
    signalTime: pending.signalTime,
    entryBarIndex: index,
    entryTime: bar.openTime,
    entryReferencePrice,
    entryPrice,
    originalQuantity,
    remainingQuantity: originalQuantity,
    entryNotional,
    stopPrice: pending.stopPrice,
    firstTargetPrice: pending.range.midline,
    secondTargetPrice: pending.side === "LONG" ? pending.range.upperBoundary : pending.range.lowerBoundary,
    firstTargetFilled: false,
    secondTargetFilled: false,
    grossPnlUsdt: 0,
    feesUsdt: entryFee,
    adverseSlippageCostUsdt: entrySlippageCost,
    fills: [{
      type: "ENTRY",
      action,
      time: bar.openTime,
      referencePrice: entryReferencePrice,
      fillPrice: entryPrice,
      quantity: originalQuantity,
      feeUsdt: entryFee,
      adverseSlippageCostUsdt: entrySlippageCost,
      model: "NEXT_15M_OPEN_WITH_ADVERSE_SLIPPAGE",
      timePrecision: "EXACT_BAR_OPEN_TIME",
    }],
  };
  ledger.append("COUNTERFACTUAL_ENTRY_FILLED", {
    tradeId: position.id,
    side: position.side,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    entryReferencePrice,
    entryPrice,
    originalQuantity,
    normalizedNotionalUsdt: replayConfig.normalizedNotionalPerTradeUsdt,
    entryFeeUsdt: entryFee,
    stopPrice: position.stopPrice,
    firstTargetPrice: position.firstTargetPrice,
    secondTargetPrice: position.secondTargetPrice,
    rangeId: position.range.id,
  });
  return position;
}

function addExitFill(position, { type, time, referencePrice, quantity, replayConfig, ledger, model }) {
  invariant(quantity > 0 && quantity <= position.remainingQuantity + EPSILON, "V4_RG1_EXIT_QUANTITY_INVALID");
  const action = position.side === "LONG" ? "SELL" : "BUY";
  const normalizedQuantity = Math.min(quantity, position.remainingQuantity);
  const fillPrice = adverseFill(referencePrice, action, replayConfig.adverseSlippageRatePerFill);
  const feeUsdt = normalizedQuantity * fillPrice * replayConfig.takerFeeRatePerFill;
  const grossPnlUsdt = position.side === "LONG"
    ? (fillPrice - position.entryPrice) * normalizedQuantity
    : (position.entryPrice - fillPrice) * normalizedQuantity;
  const adverseSlippageCostUsdt = slippageCost(referencePrice, fillPrice, normalizedQuantity, action);
  const fill = {
    type,
    action,
    time,
    referencePrice,
    fillPrice,
    quantity: normalizedQuantity,
    feeUsdt,
    grossPnlUsdt,
    adverseSlippageCostUsdt,
    model,
    timePrecision: model.startsWith("NEXT_15M_OPEN") ? "EXACT_BAR_OPEN_TIME" : "TOUCH_CONTAINED_WITHIN_FULLY_CLOSED_BAR_EXACT_TIME_UNKNOWN",
  };
  position.remainingQuantity = Math.max(0, position.remainingQuantity - normalizedQuantity);
  position.grossPnlUsdt += grossPnlUsdt;
  position.feesUsdt += feeUsdt;
  position.adverseSlippageCostUsdt += adverseSlippageCostUsdt;
  position.fills.push(fill);
  ledger.append("COUNTERFACTUAL_EXIT_FILL", {
    tradeId: position.id,
    ...fill,
    remainingQuantity: position.remainingQuantity,
  });
  return fill;
}

function includedTrade(position, exitReason) {
  const netPnlUsdt = position.grossPnlUsdt - position.feesUsdt;
  const frictionlessPnlUsdt = netPnlUsdt + position.feesUsdt + position.adverseSlippageCostUsdt;
  return {
    id: position.id,
    status: "INCLUDED_PRIMARY_PERFORMANCE",
    side: position.side,
    rangeId: position.range.id,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime: position.fills.at(-1).time,
    exitReason,
    normalizedNotionalUsdt: position.entryNotional,
    entryReferencePrice: position.entryReferencePrice,
    entryPrice: position.entryPrice,
    stopPrice: position.stopPrice,
    firstTargetPrice: position.firstTargetPrice,
    secondTargetPrice: position.secondTargetPrice,
    originalQuantity: position.originalQuantity,
    grossPnlUsdt: position.grossPnlUsdt,
    feesUsdt: position.feesUsdt,
    adverseSlippageCostUsdt: position.adverseSlippageCostUsdt,
    modeledFrictionCostUsdt: position.feesUsdt + position.adverseSlippageCostUsdt,
    frictionlessPnlUsdt,
    netPnlUsdt,
    netReturnOnNormalizedNotional: netPnlUsdt / position.entryNotional,
    holdingBars15m: Math.max(1, Math.round((position.fills.at(-1).time - position.entryTime) / (15 * 60_000)) + 1),
    rangeEvidence: position.range,
    fourHourContext: position.context4h,
    signalBar: position.signalBar,
    fills: position.fills,
  };
}

function excludedAmbiguousTrade(position, bar, touched) {
  return {
    id: position.id,
    status: "EXCLUDED_UNKNOWN_SAME_BAR_PATH",
    side: position.side,
    rangeId: position.range.id,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    ambiguityDetectedAt: bar.closeTime,
    ambiguousBar: bar,
    touched,
    stopPrice: position.stopPrice,
    firstTargetPrice: position.firstTargetPrice,
    secondTargetPrice: position.secondTargetPrice,
    remainingQuantityAtAmbiguity: position.remainingQuantity,
    knownFillsBeforeAmbiguity: position.fills,
    primaryNetPnlUsdt: null,
    exclusionReason: "OHLC_CANNOT_ORDER_STOP_AND_TARGET_TOUCHES_WITHIN_THE_SAME_15M_BAR",
  };
}

function censoredTrade(position, lastBar) {
  return {
    id: position.id,
    status: "RIGHT_CENSORED_AT_DATASET_END",
    side: position.side,
    rangeId: position.range.id,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    censoredAt: lastBar.closeTime,
    remainingQuantity: position.remainingQuantity,
    knownFills: position.fills,
    primaryNetPnlUsdt: null,
    exclusionReason: "NO_STRATEGY_EXIT_OBSERVED_BEFORE_HISTORICAL_DATASET_END",
  };
}

function summarizeIncludedTrades(trades) {
  const winners = trades.filter((trade) => trade.netPnlUsdt > 0);
  const losers = trades.filter((trade) => trade.netPnlUsdt < 0);
  const flats = trades.filter((trade) => trade.netPnlUsdt === 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnlUsdt, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  let cumulative = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  for (const trade of [...trades].sort((first, second) => first.exitTime - second.exitTime)) {
    cumulative += trade.netPnlUsdt;
    peak = Math.max(peak, cumulative);
    maximumDrawdown = Math.max(maximumDrawdown, peak - cumulative);
  }
  return {
    tradeCount: trades.length,
    winCount: winners.length,
    lossCount: losers.length,
    flatCount: flats.length,
    winRate: trades.length ? winners.length / trades.length : null,
    grossProfitUsdt: grossProfit,
    grossLossUsdt: grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    profitFactorStatus: grossLoss > 0 ? "FINITE" : "NO_LOSING_TRADES",
    cumulativeNormalizedNetPnlUsdt: netPnl,
    averageNetPnlUsdt: trades.length ? netPnl / trades.length : null,
    averageNetReturnOnNormalizedNotional: trades.length
      ? trades.reduce((sum, trade) => sum + trade.netReturnOnNormalizedNotional, 0) / trades.length
      : null,
    totalFeesUsdt: trades.reduce((sum, trade) => sum + trade.feesUsdt, 0),
    totalAdverseSlippageCostUsdt: trades.reduce((sum, trade) => sum + trade.adverseSlippageCostUsdt, 0),
    totalModeledFrictionCostUsdt: trades.reduce((sum, trade) => sum + trade.modeledFrictionCostUsdt, 0),
    frictionlessPnlUsdt: trades.reduce((sum, trade) => sum + trade.frictionlessPnlUsdt, 0),
    maximumClosedTradeSequenceDrawdownUsdt: maximumDrawdown,
  };
}

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === "number" ? round(value) : value]));
}

function chronologicalValidation(trades, startTime, endTime, replayConfig) {
  const cutoff = startTime + ((endTime - startTime) * (1 - replayConfig.outOfSampleFraction));
  const inSample = trades.filter((trade) => trade.entryTime < cutoff);
  const outOfSample = trades.filter((trade) => trade.entryTime >= cutoff);
  const foldDuration = (endTime - startTime) / replayConfig.walkForwardFolds;
  const folds = Array.from({ length: replayConfig.walkForwardFolds }, (_, index) => {
    const foldStart = startTime + (index * foldDuration);
    const foldEnd = index === replayConfig.walkForwardFolds - 1 ? endTime : startTime + ((index + 1) * foldDuration);
    const foldTrades = trades.filter((trade) => trade.entryTime >= foldStart && trade.entryTime < foldEnd);
    return {
      fold: index + 1,
      startTime: Math.round(foldStart),
      endTime: Math.round(foldEnd),
      fixedParametersRelearned: false,
      metrics: roundedMetrics(summarizeIncludedTrades(foldTrades)),
    };
  });
  return {
    mode: "FIXED_RULE_CHRONOLOGICAL_EVALUATION_NO_PARAMETER_LEARNING",
    outOfSampleFraction: replayConfig.outOfSampleFraction,
    outOfSampleCutoffTime: Math.round(cutoff),
    inSample: roundedMetrics(summarizeIncludedTrades(inSample)),
    outOfSample: roundedMetrics(summarizeIncludedTrades(outOfSample)),
    walkForwardFolds: folds,
  };
}

function rangeDiagnostics(snapshots) {
  const available = snapshots.filter(Boolean);
  const rejectedBy = {};
  for (const snapshot of available.filter((value) => !value.eligible)) {
    for (const [key, passed] of Object.entries(snapshot.checks)) {
      if (!passed) rejectedBy[key] = (rejectedBy[key] ?? 0) + 1;
    }
  }
  return {
    evaluatedSnapshotCount: available.length,
    eligibleSnapshotCount: available.filter((snapshot) => snapshot.eligible).length,
    rejectedSnapshotCount: available.filter((snapshot) => !snapshot.eligible).length,
    rejectedBy,
  };
}

export function runRg1Replay({ datasets, config, authorizationId, sourceHashes = {} }) {
  const fifteenMinute = validateDataset(datasets.fifteenMinute, {
    expectedSymbol: datasets.fifteenMinute.symbol,
    expectedInterval: "15m",
    config,
    verifyHash: true,
  });
  const oneHour = validateDataset(datasets.oneHour, {
    expectedSymbol: fifteenMinute.symbol,
    expectedInterval: "1h",
    config,
    verifyHash: true,
  });
  const fourHour = validateDataset(datasets.fourHour, {
    expectedSymbol: fifteenMinute.symbol,
    expectedInterval: "4h",
    config,
    verifyHash: true,
  });
  invariant(oneHour.symbol === fifteenMinute.symbol && fourHour.symbol === fifteenMinute.symbol, "V4_RG1_BUNDLE_SYMBOL_MISMATCH");
  const crossTimeframe = assessCrossTimeframeConsistency({ fifteenMinute, oneHour, fourHour });
  invariant(crossTimeframe.status === "CONSISTENT", "V4_RG1_CROSS_TIMEFRAME_OHLC_MISMATCH_FAIL_CLOSED");

  const replayConfig = config.gate0Replay;
  const atr14_15m = atrSeries(fifteenMinute.bars, 14);
  const fourHourAtr = atrSeries(fourHour.bars, 14);
  const { snapshots, atr14_1h } = buildRangeSnapshots(oneHour.bars, config);
  const ledger = createAuditLedger(`${config.candidateVersion}:${fifteenMinute.symbol}`);
  const includedTrades = [];
  const excludedTrades = [];
  const censoredTrades = [];
  const cancellations = [];
  let pendingEntry = null;
  let pendingInvalidation = null;
  let position = null;
  let rejectionSignalCount = 0;
  let dualBoundaryAmbiguityCount = 0;

  ledger.append("REPLAY_STARTED", {
    authorizationId,
    strategyVersion: config.candidateVersion,
    implementationRevision: config.implementationRevision,
    symbol: fifteenMinute.symbol,
    datasetHashes: {
      fifteenMinute: fifteenMinute.datasetHash,
      oneHour: oneHour.datasetHash,
      fourHour: fourHour.datasetHash,
    },
    executionBoundary: "GATE_0_CLOSED_BAR_RESEARCH_ONLY_NO_FORWARD_ORDERS",
  });

  for (let index = 0; index < fifteenMinute.bars.length; index += 1) {
    const bar = fifteenMinute.bars[index];

    if (pendingInvalidation?.fillBarIndex === index && position) {
      addExitFill(position, {
        type: "RANGE_BREAKOUT_INVALIDATION",
        time: bar.openTime,
        referencePrice: bar.open,
        quantity: position.remainingQuantity,
        replayConfig,
        ledger,
        model: "NEXT_15M_OPEN_AFTER_FULLY_CLOSED_1H_INVALIDATION_WITH_ADVERSE_SLIPPAGE",
      });
      const trade = includedTrade(position, "FULLY_CLOSED_1H_RANGE_BREAKOUT_INVALIDATION");
      includedTrades.push(trade);
      ledger.append("COUNTERFACTUAL_TRADE_CLOSED_INCLUDED", { tradeId: trade.id, exitReason: trade.exitReason, netPnlUsdt: trade.netPnlUsdt });
      position = null;
      pendingInvalidation = null;
    }

    if (pendingEntry?.fillBarIndex === index) {
      const invalidation = breakoutEvidence(pendingEntry.range, oneHour.bars, atr14_1h, bar.openTime);
      let cancellationReason = null;
      if (position) cancellationReason = "ONE_POSITION_PER_SYMBOL_ALREADY_OPEN";
      else if (invalidation) cancellationReason = "RANGE_INVALIDATED_BEFORE_NEXT_BAR_OPEN";
      else if (!entryReferenceStillValid(pendingEntry.side, bar.open, pendingEntry.range)) cancellationReason = "NEXT_BAR_OPEN_OUTSIDE_ENTRY_HALF_RANGE";
      if (cancellationReason) {
        const cancellation = {
          signalTime: pendingEntry.signalTime,
          fillTime: bar.openTime,
          side: pendingEntry.side,
          rangeId: pendingEntry.range.id,
          reason: cancellationReason,
          invalidation,
        };
        cancellations.push(cancellation);
        ledger.append("COUNTERFACTUAL_ENTRY_CANCELLED", cancellation);
      } else {
        position = makePosition({ pending: pendingEntry, bar, index, replayConfig, ledger });
      }
      pendingEntry = null;
    }

    if (position) {
      const stopTouched = position.side === "LONG" ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      const firstTargetTouched = !position.firstTargetFilled
        && (position.side === "LONG" ? bar.high >= position.firstTargetPrice : bar.low <= position.firstTargetPrice);
      const secondTargetTouched = !position.secondTargetFilled
        && (position.side === "LONG" ? bar.high >= position.secondTargetPrice : bar.low <= position.secondTargetPrice);
      if (stopTouched && (firstTargetTouched || secondTargetTouched)) {
        const touched = { stop: true, firstTarget: firstTargetTouched, secondTarget: secondTargetTouched };
        const excluded = excludedAmbiguousTrade(position, bar, touched);
        excludedTrades.push(excluded);
        ledger.append("COUNTERFACTUAL_TRADE_EXCLUDED_UNKNOWN_SAME_BAR_PATH", {
          tradeId: position.id,
          detectedAt: bar.closeTime,
          barOpenTime: bar.openTime,
          touched,
          reason: excluded.exclusionReason,
        });
        position = null;
        pendingInvalidation = null;
      } else {
        if (firstTargetTouched) {
          addExitFill(position, {
            type: "FIRST_TARGET_MIDLINE",
            time: bar.closeTime,
            referencePrice: position.firstTargetPrice,
            quantity: position.originalQuantity * replayConfig.firstTargetExitFraction,
            replayConfig,
            ledger,
            model: "INTRABAR_LEVEL_TOUCH_WITH_ADVERSE_SLIPPAGE",
          });
          position.firstTargetFilled = true;
        }
        if (secondTargetTouched && position.remainingQuantity > EPSILON) {
          addExitFill(position, {
            type: "SECOND_TARGET_OPPOSITE_BOUNDARY",
            time: bar.closeTime,
            referencePrice: position.secondTargetPrice,
            quantity: position.remainingQuantity,
            replayConfig,
            ledger,
            model: "INTRABAR_LEVEL_TOUCH_WITH_ADVERSE_SLIPPAGE",
          });
          position.secondTargetFilled = true;
        }
        if (stopTouched && position.remainingQuantity > EPSILON) {
          const gapReference = position.side === "LONG"
            ? Math.min(position.stopPrice, bar.open)
            : Math.max(position.stopPrice, bar.open);
          addExitFill(position, {
            type: "INITIAL_STOP",
            time: bar.closeTime,
            referencePrice: gapReference,
            quantity: position.remainingQuantity,
            replayConfig,
            ledger,
            model: gapReference === position.stopPrice
              ? "INTRABAR_STOP_LEVEL_WITH_ADVERSE_SLIPPAGE"
              : "BAR_OPEN_GAP_THROUGH_STOP_WITH_ADVERSE_SLIPPAGE",
          });
        }
        if (position.remainingQuantity <= EPSILON) {
          const exitReason = position.secondTargetFilled ? "OPPOSITE_BOUNDARY_TARGET" : "INITIAL_STOP";
          const trade = includedTrade(position, exitReason);
          includedTrades.push(trade);
          ledger.append("COUNTERFACTUAL_TRADE_CLOSED_INCLUDED", { tradeId: trade.id, exitReason, netPnlUsdt: trade.netPnlUsdt });
          position = null;
          pendingInvalidation = null;
        }
      }
    }

    if (position && !pendingInvalidation) {
      const invalidation = breakoutEvidence(position.range, oneHour.bars, atr14_1h, bar.closeTime + 1);
      if (invalidation && invalidation.detectedAt === bar.closeTime) {
        if (index + 1 < fifteenMinute.bars.length) {
          pendingInvalidation = { fillBarIndex: index + 1, evidence: invalidation };
          ledger.append("RANGE_BREAKOUT_INVALIDATION_CONFIRMED", {
            tradeId: position.id,
            ...invalidation,
            plannedFillTime: fifteenMinute.bars[index + 1].openTime,
          });
        }
      }
    }

    if (!position && !pendingEntry && index + 1 < fifteenMinute.bars.length && atr14_15m[index] > 0) {
      const oneHourIndex = latestBarIndexClosedBefore(oneHour.bars, bar.openTime);
      const range = snapshots[oneHourIndex];
      if (range?.eligible) {
        const classification = classifyBoundaryRejection(bar, range);
        if (classification.status === "AMBIGUOUS_DUAL_BOUNDARY") {
          dualBoundaryAmbiguityCount += 1;
          ledger.append("REJECTION_SIGNAL_EXCLUDED_DUAL_BOUNDARY", {
            barOpenTime: bar.openTime,
            barCloseTime: bar.closeTime,
            rangeId: range.id,
          });
        } else if (classification.status === "SIGNAL") {
          const fourHourIndex = latestBarIndexClosedBefore(fourHour.bars, bar.openTime);
          if (fourHourIndex >= 0) {
            rejectionSignalCount += 1;
            const context4h = {
              role: "OBSERVE_ONLY_NOT_AN_ENTRY_GATE",
              barIndex: fourHourIndex,
              openTime: fourHour.bars[fourHourIndex].openTime,
              closeTime: fourHour.bars[fourHourIndex].closeTime,
              close: fourHour.bars[fourHourIndex].close,
              atr14_4h: fourHourAtr[fourHourIndex] ?? null,
            };
            const stopPrice = classification.side === "LONG"
              ? range.lowerBoundary - (0.5 * atr14_15m[index])
              : range.upperBoundary + (0.5 * atr14_15m[index]);
            pendingEntry = {
              fillBarIndex: index + 1,
              side: classification.side,
              signalTime: bar.closeTime,
              signalBar: { ...bar, atr14_15m: atr14_15m[index] },
              range,
              context4h,
              stopPrice,
            };
            ledger.append("CLOSED_BAR_REJECTION_SIGNAL", {
              side: classification.side,
              signalTime: bar.closeTime,
              plannedFillTime: fifteenMinute.bars[index + 1].openTime,
              rangeId: range.id,
              stopPrice,
              causalInputs: ["PRIOR_FULLY_CLOSED_1H_RANGE", "FULLY_CLOSED_15M_REJECTION", "PRIOR_FULLY_CLOSED_4H_CONTEXT"],
            });
          }
        }
      }
    }
  }

  if (position) {
    const censored = censoredTrade(position, fifteenMinute.bars.at(-1));
    censoredTrades.push(censored);
    ledger.append("COUNTERFACTUAL_TRADE_RIGHT_CENSORED", { tradeId: position.id, censoredAt: censored.censoredAt, reason: censored.exclusionReason });
    position = null;
  }
  if (pendingEntry) {
    const cancellation = {
      signalTime: pendingEntry.signalTime,
      side: pendingEntry.side,
      rangeId: pendingEntry.range.id,
      reason: "DATASET_ENDED_BEFORE_NEXT_BAR_OPEN",
    };
    cancellations.push(cancellation);
    ledger.append("COUNTERFACTUAL_ENTRY_CANCELLED", cancellation);
  }
  ledger.append("REPLAY_COMPLETED", {
    includedTradeCount: includedTrades.length,
    excludedUnknownSameBarPathCount: excludedTrades.length,
    rightCensoredTradeCount: censoredTrades.length,
    cancelledEntryCount: cancellations.length,
  });

  const auditLedger = ledger.snapshot();
  invariant(verifyAuditLedger(auditLedger).valid, "V4_RG1_AUDIT_LEDGER_SELF_VERIFICATION_FAILED");
  const evaluationStartTime = Math.max(fifteenMinute.startTime, oneHour.startTime, fourHour.startTime);
  const evaluationEndTime = Math.min(fifteenMinute.endTime, oneHour.endTime, fourHour.endTime);
  const primaryMetrics = roundedMetrics(summarizeIncludedTrades(includedTrades));
  const byDirection = Object.fromEntries(["LONG", "SHORT"].map((side) => [
    side,
    roundedMetrics(summarizeIncludedTrades(includedTrades.filter((trade) => trade.side === side))),
  ]));
  const minimumClosed = config.researchControls.minimumClosedSamplesBeforeRuleReview;
  const minimumPerBucket = config.researchControls.minimumSamplesPerBucket;
  const sampleReview = {
    minimumClosedSamplesBeforeRuleReview: minimumClosed,
    minimumSamplesPerBucket: minimumPerBucket,
    closedSampleThresholdMet: includedTrades.length >= minimumClosed,
    directionBuckets: Object.fromEntries(Object.entries(byDirection).map(([side, metrics]) => [side, {
      count: metrics.tradeCount,
      thresholdMet: metrics.tradeCount >= minimumPerBucket,
    }])),
  };

  const report = {
    schemaVersion: 1,
    mode: "ORION_V4_RG1_GATE_0_LOCAL_REPLAY",
    generatedAt: new Date(Math.max(fifteenMinute.capturedAt, oneHour.capturedAt, fourHour.capturedAt)).toISOString(),
    strategy: {
      id: config.candidateVersion,
      displayName: config.displayName,
      implementationRevision: config.implementationRevision,
      family: "RANGE_BOUND_MEAN_REVERSION",
      parametersFixedDuringReplay: true,
      automaticParameterLearning: false,
    },
    governanceBoundary: {
      authorizationId,
      authority: "L2_RESEARCH_PAPER_DEVELOPMENT_NO_EXECUTION",
      stage: "GATE_0_CLOSED_BAR_RESEARCH_AND_ISOLATED_PAPER_DEVELOPMENT",
      residentScannerStarted: false,
      forwardPaperPositionsGenerated: false,
      credentialsUsed: false,
      signedRequestsUsed: false,
      orderEndpointsUsed: false,
      v2OrV3StateMutated: false,
      paperRiskPolicy: "NOT_AUTHORIZED_PENDING_OWNER_REVIEW",
      automaticPromotionAllowed: false,
    },
    sourceHashes: {
      ...sourceHashes,
      config: sourceHashes.config ?? sha256(stableStringify(config)),
    },
    datasetEvidence: {
      symbol: fifteenMinute.symbol,
      evaluationStartTime,
      evaluationEndTime,
      datasets: {
        fifteenMinute: {
          hash: fifteenMinute.datasetHash,
          source: fifteenMinute.source,
          interval: fifteenMinute.interval,
          startTime: fifteenMinute.startTime,
          endTime: fifteenMinute.endTime,
          barCount: fifteenMinute.barCount,
          integrity: fifteenMinute.integrity.status,
        },
        oneHour: {
          hash: oneHour.datasetHash,
          source: oneHour.source,
          interval: oneHour.interval,
          startTime: oneHour.startTime,
          endTime: oneHour.endTime,
          barCount: oneHour.barCount,
          integrity: oneHour.integrity.status,
        },
        fourHour: {
          hash: fourHour.datasetHash,
          source: fourHour.source,
          interval: fourHour.interval,
          startTime: fourHour.startTime,
          endTime: fourHour.endTime,
          barCount: fourHour.barCount,
          integrity: fourHour.integrity.status,
        },
      },
      crossTimeframeConsistency: crossTimeframe,
    },
    fixedRuleContract: {
      range: {
        lookbackBars1h: config.hypothesis.rangeLookbackBars1h,
        boundaryMethod: replayConfig.rangeBoundaryMethod,
        boundaryTouchTolerance: replayConfig.boundaryTouchTolerance,
        minimumTouchesPerSide: config.hypothesis.minimumBoundaryTouchesPerSide,
        maximumAdx14_1h: config.hypothesis.maximumAdx14,
        maximumAbsoluteSlopeAtrPer24Bars: config.hypothesis.maximumAbsoluteLinearSlopeAtrPer24Bars,
        minimumRangeHeightAtr14_1h: config.hypothesis.minimumRangeHeightAtr14,
        maximumRangeHeightAtr14_1h: config.hypothesis.maximumRangeHeightAtr14,
      },
      signalAndFill: {
        confirmation: config.hypothesis.confirmation,
        signalTiming: replayConfig.signalTiming,
        fillTiming: replayConfig.fillTiming,
      },
      exits: {
        initialStop: config.hypothesis.initialStop,
        firstTarget: config.hypothesis.firstTarget,
        firstTargetExitFraction: replayConfig.firstTargetExitFraction,
        secondTarget: config.hypothesis.secondTarget,
        secondTargetExitFraction: replayConfig.secondTargetExitFraction,
        breakoutInvalidation: config.hypothesis.breakoutInvalidation,
        breakoutInvalidationFillTiming: replayConfig.breakoutInvalidationFillTiming,
      },
      accountingNormalization: {
        normalizedNotionalPerTradeUsdt: replayConfig.normalizedNotionalPerTradeUsdt,
        isCapitalOrRiskAuthorization: false,
        compounding: false,
      },
      costs: {
        takerFeeRatePerFill: replayConfig.takerFeeRatePerFill,
        adverseSlippageRatePerFill: replayConfig.adverseSlippageRatePerFill,
      },
    },
    diagnostics: {
      rangeSnapshots: rangeDiagnostics(snapshots),
      rejectionSignalCount,
      dualBoundarySignalAmbiguityCount: dualBoundaryAmbiguityCount,
      entryCount: includedTrades.length + excludedTrades.length + censoredTrades.length,
      includedClosedTradeCount: includedTrades.length,
      excludedUnknownSameBarPathCount: excludedTrades.length,
      rightCensoredTradeCount: censoredTrades.length,
      cancelledEntryCount: cancellations.length,
      cancellationsByReason: Object.fromEntries([...new Set(cancellations.map((item) => item.reason))].map((reason) => [reason, cancellations.filter((item) => item.reason === reason).length])),
    },
    primaryPerformance: {
      inclusionRule: "ONLY_FULLY_RESOLVED_TRADES_WITH_NO_UNKNOWN_STOP_TARGET_SAME_BAR_ORDER",
      metrics: primaryMetrics,
      byDirection,
      sampleReview,
    },
    chronologicalValidation: chronologicalValidation(includedTrades, evaluationStartTime, evaluationEndTime, replayConfig),
    evidenceBoundary: {
      classification: "GATE_0_CLOSED_BAR_SCREENING_ONLY",
      gate1Eligible: false,
      promotionEligible: false,
      sameBarAmbiguityAction: replayConfig.sameBarAmbiguityAction,
      dataGapAction: "FAIL_CLOSED_BEFORE_PERFORMANCE",
      limitations: [
        "NO_TICK_PATH_EVIDENCE",
        "NO_EXECUTABLE_BBO_EVIDENCE",
        "SPREAD_NOT_MODELED",
        "QUEUE_POSITION_UNKNOWN",
        "FUNDING_NOT_MODELED",
        "LIQUIDATION_NOT_MODELED",
        "NORMALIZED_NOTIONAL_IS_NOT_A_RISK_POLICY",
        "UNKNOWN_SAME_BAR_STOP_TARGET_PATHS_EXCLUDED_FROM_PRIMARY_PERFORMANCE",
        "OWNER_APPROVAL_REQUIRED_FOR_ANY_FORWARD_PAPER_TESTNET_OR_REAL_ACTIVATION",
      ],
    },
    cancellations,
    trades: {
      included: includedTrades,
      excludedUnknownSameBarPath: excludedTrades,
      rightCensored: censoredTrades,
    },
    auditLedger,
  };
  report.reportId = deterministicId("orion_v4_rg1_gate0", {
    strategy: report.strategy,
    datasetHashes: {
      fifteenMinute: fifteenMinute.datasetHash,
      oneHour: oneHour.datasetHash,
      fourHour: fourHour.datasetHash,
    },
    fixedRuleContract: report.fixedRuleContract,
  });
  report.reportHash = sha256(stableStringify(report));
  return report;
}

export function compactReplayReport(report) {
  return {
    reportId: report.reportId,
    reportHash: report.reportHash,
    mode: report.mode,
    strategy: report.strategy,
    governanceBoundary: report.governanceBoundary,
    datasetEvidence: report.datasetEvidence,
    diagnostics: report.diagnostics,
    primaryPerformance: report.primaryPerformance,
    chronologicalValidation: report.chronologicalValidation,
    evidenceBoundary: report.evidenceBoundary,
    auditLedger: {
      algorithm: report.auditLedger.algorithm,
      eventCount: report.auditLedger.eventCount,
      headHash: report.auditLedger.headHash,
    },
  };
}
