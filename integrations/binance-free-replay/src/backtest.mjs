import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  deterministicId,
  sha256,
  stableStringify,
  writeJsonAtomic,
} from "../../../agents/orion-v2/paper/runtime-utils.mjs";
import { PROJECT_ROOT } from "./market-data.mjs";

export const REPORT_ROOT = path.join(PROJECT_ROOT, "backtest_report");
const runtimeConfig = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "agents/orion-v2/paper/config.json"), "utf8"));

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function smaSeries(values, period) {
  invariant(Number.isInteger(period) && period >= 1, "SMA_PERIOD_INVALID");
  const result = Array(values.length).fill(null);
  let rolling = 0;
  for (let index = 0; index < values.length; index += 1) {
    rolling += values[index];
    if (index >= period) rolling -= values[index - period];
    if (index >= period - 1) result[index] = rolling / period;
  }
  return result;
}

export function adverseFill(referencePrice, side, adverseSlippageRate) {
  invariant(Number.isFinite(referencePrice) && referencePrice > 0, "REPLAY_REFERENCE_PRICE_INVALID");
  invariant(Number.isFinite(adverseSlippageRate) && adverseSlippageRate >= 0 && adverseSlippageRate < 0.1, "REPLAY_SLIPPAGE_INVALID");
  invariant(side === "BUY" || side === "SELL", "REPLAY_SIDE_INVALID");
  return side === "BUY"
    ? referencePrice * (1 + adverseSlippageRate)
    : referencePrice * (1 - adverseSlippageRate);
}

function round(value, digits = 12) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function maximumDrawdown(equityCurve) {
  let peak = -Infinity;
  let peakAt = null;
  let maximum = 0;
  let maximumPeakAt = null;
  let maximumTroughAt = null;
  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakAt = point.time;
    }
    if (!(peak > 0)) continue;
    const drawdown = (peak - point.equity) / peak;
    if (drawdown > maximum) {
      maximum = drawdown;
      maximumPeakAt = peakAt;
      maximumTroughAt = point.time;
    }
  }
  return { fraction: maximum, peakAt: maximumPeakAt, troughAt: maximumTroughAt };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows, columns) {
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

function closeLongPosition(position, { referencePrice, time, barIndex, reason, feeRate, adverseSlippageRate }) {
  const exitPrice = adverseFill(referencePrice, "SELL", adverseSlippageRate);
  const exitNotional = position.quantity * exitPrice;
  const exitFee = exitNotional * feeRate;
  const grossPnl = (exitPrice - position.entryPrice) * position.quantity;
  const netPnl = grossPnl - position.entryFee - exitFee;
  const equityAfter = position.equityBefore + netPnl;
  return {
    trade: {
      id: deterministicId("replay_trade", { entryTime: position.entryTime, exitTime: time, entryPrice: position.entryPrice, exitPrice }),
      side: "LONG",
      entrySignalTime: position.entrySignalTime,
      entryTime: position.entryTime,
      entryReferencePrice: position.entryReferencePrice,
      entryPrice: position.entryPrice,
      exitSignalTime: position.exitSignalTime,
      exitTime: time,
      exitReferencePrice: referencePrice,
      exitPrice,
      quantity: position.quantity,
      entryNotional: position.entryNotional,
      exitNotional,
      entryFee: position.entryFee,
      exitFee,
      totalFees: position.entryFee + exitFee,
      grossPnl,
      netPnl,
      returnOnAllocatedNotional: netPnl / position.entryNotional,
      returnOnAccountEquity: netPnl / position.equityBefore,
      holdingBars: Math.max(1, barIndex - position.entryBarIndex + 1),
      exitReason: reason,
      fillModel: reason === "END_OF_RANGE"
        ? "FULLY_CLOSED_FINAL_BAR_CLOSE_WITH_ADVERSE_SLIPPAGE"
        : "NEXT_BAR_OPEN_WITH_ADVERSE_SLIPPAGE",
    },
    equityAfter,
  };
}

function buyAndHoldBaseline(bars, { initialEquity, allocationFraction, feeRate, adverseSlippageRate }) {
  if (bars.length < 1) return null;
  const entryPrice = adverseFill(bars[0].open, "BUY", adverseSlippageRate);
  const entryNotional = initialEquity * allocationFraction;
  const quantity = entryNotional / entryPrice;
  const entryFee = entryNotional * feeRate;
  const exitPrice = adverseFill(bars.at(-1).close, "SELL", adverseSlippageRate);
  const exitNotional = quantity * exitPrice;
  const netPnl = (exitPrice - entryPrice) * quantity - entryFee - exitNotional * feeRate;
  return {
    entryTime: bars[0].openTime,
    exitTime: bars.at(-1).closeTime,
    netPnl,
    totalReturnFraction: netPnl / initialEquity,
  };
}

export function runMaCrossBacktest(dataset, {
  fastPeriod = 20,
  slowPeriod = 60,
  initialEquity = runtimeConfig.books[0].initialEquityUsdt,
  allocationFraction = 1,
  feeRate = runtimeConfig.paperRisk.takerFeeRate,
  adverseSlippageRate = runtimeConfig.paperRisk.adverseSlippageRate,
} = {}) {
  invariant(dataset?.fullyClosedBarsOnly === true, "REPLAY_REQUIRES_FULLY_CLOSED_BARS");
  invariant(dataset?.integrity?.status === "COMPLETE", "REPLAY_DATA_GAP_FAIL_CLOSED");
  invariant(dataset?.credentialsUsed === false && dataset?.signedRequestsUsed === false && dataset?.orderEndpointsPresent === false, "REPLAY_EXECUTION_BOUNDARY_INVALID");
  invariant(Number.isInteger(fastPeriod) && Number.isInteger(slowPeriod) && fastPeriod >= 1 && slowPeriod > fastPeriod && slowPeriod <= 1_000, "MA_PERIODS_INVALID");
  invariant(Number.isFinite(initialEquity) && initialEquity > 0, "REPLAY_INITIAL_EQUITY_INVALID");
  invariant(Number.isFinite(allocationFraction) && allocationFraction > 0 && allocationFraction <= 1, "REPLAY_ALLOCATION_FRACTION_INVALID");
  invariant(Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 0.01, "REPLAY_FEE_RATE_INVALID");
  invariant(Number.isFinite(adverseSlippageRate) && adverseSlippageRate >= 0 && adverseSlippageRate < 0.1, "REPLAY_SLIPPAGE_RATE_INVALID");

  const bars = dataset.bars;
  invariant(Array.isArray(bars) && bars.length >= slowPeriod + 2, "REPLAY_INSUFFICIENT_BARS");
  const closes = bars.map((bar) => bar.close);
  const fast = smaSeries(closes, fastPeriod);
  const slow = smaSeries(closes, slowPeriod);
  const trades = [];
  const equityCurve = [];
  const signals = [];
  let realizedEquity = initialEquity;
  let position = null;
  let pending = null;
  let exposedBars = 0;

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (pending?.fillBarIndex === index) {
      if (pending.action === "ENTER_LONG" && !position) {
        const entryReferencePrice = bar.open;
        const entryPrice = adverseFill(entryReferencePrice, "BUY", adverseSlippageRate);
        const entryNotional = realizedEquity * allocationFraction;
        position = {
          entrySignalTime: pending.signalTime,
          entryTime: bar.openTime,
          entryReferencePrice,
          entryPrice,
          entryNotional,
          quantity: entryNotional / entryPrice,
          entryFee: entryNotional * feeRate,
          equityBefore: realizedEquity,
          entryBarIndex: index,
          exitSignalTime: null,
        };
      } else if (pending.action === "EXIT_LONG" && position) {
        position.exitSignalTime = pending.signalTime;
        const closed = closeLongPosition(position, {
          referencePrice: bar.open,
          time: bar.openTime,
          barIndex: index,
          reason: "MA_BEARISH_CROSS",
          feeRate,
          adverseSlippageRate,
        });
        trades.push(closed.trade);
        realizedEquity = closed.equityAfter;
        position = null;
      }
      pending = null;
    }

    if (position) exposedBars += 1;

    const previousIndex = index - 1;
    if (!pending && index + 1 < bars.length && previousIndex >= 0 && fast[index] !== null && slow[index] !== null && fast[previousIndex] !== null && slow[previousIndex] !== null) {
      const bullishCross = fast[previousIndex] <= slow[previousIndex] && fast[index] > slow[index];
      const bearishCross = fast[previousIndex] >= slow[previousIndex] && fast[index] < slow[index];
      if (!position && bullishCross) {
        pending = { action: "ENTER_LONG", signalTime: bar.closeTime, fillBarIndex: index + 1 };
        signals.push({ time: bar.closeTime, barIndex: index, action: "ENTER_LONG", fillBarIndex: index + 1, causalInput: "FULLY_CLOSED_BAR" });
      } else if (position && bearishCross) {
        pending = { action: "EXIT_LONG", signalTime: bar.closeTime, fillBarIndex: index + 1 };
        signals.push({ time: bar.closeTime, barIndex: index, action: "EXIT_LONG", fillBarIndex: index + 1, causalInput: "FULLY_CLOSED_BAR" });
      }
    }

    let markEquity = realizedEquity;
    if (position) {
      const executableMark = adverseFill(bar.close, "SELL", adverseSlippageRate);
      const estimatedExitFee = executableMark * position.quantity * feeRate;
      markEquity = position.equityBefore + (executableMark - position.entryPrice) * position.quantity - position.entryFee - estimatedExitFee;
    }
    equityCurve.push({
      time: bar.closeTime,
      equity: markEquity,
      realizedEquity,
      position: position ? "LONG" : "FLAT",
      close: bar.close,
    });
  }

  if (position) {
    const lastIndex = bars.length - 1;
    const lastBar = bars[lastIndex];
    const closed = closeLongPosition(position, {
      referencePrice: lastBar.close,
      time: lastBar.closeTime,
      barIndex: lastIndex,
      reason: "END_OF_RANGE",
      feeRate,
      adverseSlippageRate,
    });
    trades.push(closed.trade);
    realizedEquity = closed.equityAfter;
    equityCurve[equityCurve.length - 1] = {
      ...equityCurve.at(-1),
      equity: realizedEquity,
      realizedEquity,
      position: "FLAT",
    };
  }

  const winners = trades.filter((trade) => trade.netPnl > 0);
  const losers = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = realizedEquity - initialEquity;
  const totalReturnFraction = netPnl / initialEquity;
  const elapsedYears = (bars.at(-1).closeTime - bars[0].openTime) / (365.25 * 86_400_000);
  const cagr = elapsedYears > 0 && realizedEquity > 0 ? (realizedEquity / initialEquity) ** (1 / elapsedYears) - 1 : null;
  const drawdown = maximumDrawdown(equityCurve);
  const totalFees = trades.reduce((sum, trade) => sum + trade.totalFees, 0);

  const report = {
    schemaVersion: 1,
    mode: "FREE_PUBLIC_HISTORICAL_REPLAY",
    strategy: {
      id: "MA_CROSS_LONG_ONLY_REFERENCE_V1",
      role: "REFERENCE_ADAPTER_NOT_CURRENT_MTFX_STRATEGY",
      fastPeriod,
      slowPeriod,
      signalTiming: "FULLY_CLOSED_BAR",
      fillTiming: "NEXT_BAR_OPEN",
      finalPositionHandling: "FULLY_CLOSED_FINAL_BAR_CLOSE",
      shorting: false,
    },
    dataset: {
      hash: dataset.datasetHash,
      source: dataset.source,
      symbol: dataset.symbol,
      interval: dataset.interval,
      startTime: dataset.startTime,
      endTime: dataset.endTime,
      barCount: dataset.barCount,
      integrity: dataset.integrity,
    },
    assumptions: {
      initialEquityUsdt: initialEquity,
      allocationFraction,
      leverage: 1,
      takerFeeRate: feeRate,
      adverseSlippageRate,
      fundingModeled: false,
      liquidationModeled: false,
      bboModeled: false,
      queuePositionModeled: false,
    },
    metrics: {
      endingEquityUsdt: realizedEquity,
      netPnlUsdt: netPnl,
      totalReturnFraction,
      cagr,
      maximumDrawdownFraction: drawdown.fraction,
      maximumDrawdownPeakAt: drawdown.peakAt,
      maximumDrawdownTroughAt: drawdown.troughAt,
      tradeCount: trades.length,
      winCount: winners.length,
      lossCount: losers.length,
      winRate: trades.length ? winners.length / trades.length : null,
      grossProfitUsdt: grossProfit,
      grossLossUsdt: grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      profitFactorStatus: grossLoss > 0 ? "FINITE" : "NO_LOSING_TRADES",
      averageNetPnlUsdt: trades.length ? netPnl / trades.length : null,
      averageTradeReturnOnAllocatedNotional: trades.length ? trades.reduce((sum, trade) => sum + trade.returnOnAllocatedNotional, 0) / trades.length : null,
      averageHoldingBars: trades.length ? trades.reduce((sum, trade) => sum + trade.holdingBars, 0) / trades.length : null,
      totalFeesUsdt: totalFees,
      exposureFractionOfBars: exposedBars / bars.length,
    },
    baseline: buyAndHoldBaseline(bars, { initialEquity, allocationFraction, feeRate, adverseSlippageRate }),
    evidenceBoundary: {
      classification: "CLOSED_BAR_SCREENING_ONLY",
      gate1Eligible: false,
      currentMtfxStrategyBacktest: false,
      currentPaperLedgerMutated: false,
      credentialsUsed: false,
      signedRequestsUsed: false,
      orderEndpointsPresent: false,
      limitations: [
        "This reference MA adapter is not ORION V2 MTFX 0.5.0.",
        "Historical OHLC does not provide executable BBO, latency, funding, liquidation, or queue-position evidence.",
        "Results cannot promote the strategy or authorize testnet/real execution.",
      ],
    },
    signals,
    trades,
    equityCurve,
  };
  report.reportId = deterministicId("binance_free_replay", {
    datasetHash: dataset.datasetHash,
    strategy: report.strategy,
    assumptions: report.assumptions,
  });
  report.reportHash = sha256(stableStringify(report));
  return report;
}

export async function writeBacktestReport(report) {
  const directory = path.join(REPORT_ROOT, report.dataset.symbol, report.reportId);
  await fs.mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "report.json");
  const tradesPath = path.join(directory, "trades.csv");
  const equityPath = path.join(directory, "equity.csv");
  await writeJsonAtomic(reportPath, report);
  await fs.writeFile(tradesPath, rowsToCsv(report.trades, [
    "id", "side", "entrySignalTime", "entryTime", "entryReferencePrice", "entryPrice",
    "exitSignalTime", "exitTime", "exitReferencePrice", "exitPrice", "quantity",
    "entryNotional", "exitNotional", "entryFee", "exitFee", "totalFees", "grossPnl",
    "netPnl", "returnOnAllocatedNotional", "returnOnAccountEquity", "holdingBars", "exitReason", "fillModel",
  ]));
  await fs.writeFile(equityPath, rowsToCsv(report.equityCurve, ["time", "equity", "realizedEquity", "position", "close"]));
  return { directory, reportPath, tradesPath, equityPath };
}

export function compactReport(report) {
  return {
    reportId: report.reportId,
    reportHash: report.reportHash,
    mode: report.mode,
    strategy: report.strategy,
    dataset: report.dataset,
    assumptions: report.assumptions,
    metrics: Object.fromEntries(Object.entries(report.metrics).map(([key, value]) => [key, typeof value === "number" ? round(value) : value])),
    baseline: report.baseline,
    evidenceBoundary: report.evidenceBoundary,
  };
}
