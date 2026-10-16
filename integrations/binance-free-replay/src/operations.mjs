import fs from "node:fs/promises";

import { compactReport, runMaCrossBacktest, writeBacktestReport } from "./backtest.mjs";
import {
  INTERVAL_MS,
  MARKET_DATA_ROOT,
  OWNER_APPROVED_SYMBOLS,
  PROJECT_ROOT,
  PUBLIC_BASE_URL,
  PUBLIC_KLINE_PATH,
  cachePathFor,
  downloadKlines,
  loadDataset,
  normalizeInterval,
  normalizeRange,
  normalizeSymbol,
} from "./market-data.mjs";
import { evaluateTestnetReadiness } from "../../binance-usdm-testnet/readiness.mjs";

export async function gatewayStatus() {
  return {
    gatewayId: "AEGIS-BINANCE-FREE-REPLAY-MCP-1.0",
    status: "READY_PUBLIC_REPLAY_AND_BINANCE_DEMO_TRADING",
    projectRoot: PROJECT_ROOT,
    publicReplay: {
      baseUrl: PUBLIC_BASE_URL,
      endpoint: PUBLIC_KLINE_PATH,
      allowedMethods: ["GET"],
      allowedSymbols: OWNER_APPROVED_SYMBOLS,
      allowedIntervals: Object.keys(INTERVAL_MS),
      marketDataRoot: MARKET_DATA_ROOT,
      credentialsRequired: false,
      signedRequestsAllowed: false,
      orderEndpointsPresent: false,
      currentPaperRuntimeMutationAllowed: false,
      evidenceUse: "CLOSED_BAR_RESEARCH_AND_SCREENING_ONLY",
    },
    testnet: await evaluateTestnetReadiness(),
    executionBoundary: {
      testnetOrdersAllowed: true,
      realOrdersAllowed: false,
      orderCancellationAllowed: true,
      leverageOrMarginChangesAllowed: false,
      transfersAllowed: false,
      withdrawalsAllowed: false,
      productionCredentialsAllowed: false,
      automaticPaperToTestnetMirroringAllowed: false,
      everyMutationRequires: "BINANCE_DEMO_ONLY",
    },
  };
}

export async function loadOrDownloadKlines({ symbol, interval, start, end, refresh = false, ...downloadOptions }) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedInterval = normalizeInterval(interval);
  const now = downloadOptions.now ?? Date.now();
  const { startTime, endTime } = normalizeRange({ start, end, now });
  const filePath = cachePathFor({ symbol: normalizedSymbol, interval: normalizedInterval, startTime, endTime });
  if (!refresh) {
    try {
      const dataset = await loadDataset(filePath);
      return { dataset, filePath, cache: "HIT" };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        try { await fs.access(filePath); } catch { return downloadAndTag(); }
        throw error;
      }
    }
  }
  return downloadAndTag();

  async function downloadAndTag() {
    const downloaded = await downloadKlines({
      symbol: normalizedSymbol,
      interval: normalizedInterval,
      start,
      end,
      now,
      ...downloadOptions,
    });
    return { ...downloaded, cache: "MISS" };
  }
}

export async function runMaCrossReplay({
  symbol,
  interval,
  start,
  end,
  fastPeriod = 20,
  slowPeriod = 60,
  initialEquity,
  allocationFraction,
  feeRate,
  adverseSlippageRate,
  refresh = false,
  ...downloadOptions
}) {
  const loaded = await loadOrDownloadKlines({ symbol, interval, start, end, refresh, ...downloadOptions });
  const report = runMaCrossBacktest(loaded.dataset, {
    fastPeriod,
    slowPeriod,
    ...(initialEquity === undefined ? {} : { initialEquity }),
    ...(allocationFraction === undefined ? {} : { allocationFraction }),
    ...(feeRate === undefined ? {} : { feeRate }),
    ...(adverseSlippageRate === undefined ? {} : { adverseSlippageRate }),
  });
  const paths = await writeBacktestReport(report);
  return {
    cache: loaded.cache,
    datasetPath: loaded.filePath,
    report: compactReport(report),
    paths,
  };
}

export function compactDatasetResult({ dataset, filePath, cache = "MISS" }) {
  const { bars: _bars, ...metadata } = dataset;
  return { cache, filePath, dataset: metadata };
}
