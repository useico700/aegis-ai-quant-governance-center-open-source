// DEMO ONLY — enabled exclusively by `?demo=1`. Synthetic S1 data for previewing motion; never mixed with live feeds.
import type { Candidate, ExecutionLedger, ExecutionState, FilteredCandidate, History, MarketQuote, PrecisionRule, RiskCalendarFeed, Snapshot } from "./types";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT"];
const BASE: Record<string, { price: number; tick: string; lot: string }> = {
  BTCUSDT: { price: 112_840.5, tick: "0.10", lot: "0.001" }, ETHUSDT: { price: 4_186.21, tick: "0.01", lot: "0.001" },
  SOLUSDT: { price: 214.62, tick: "0.01", lot: "0.01" }, XRPUSDT: { price: 2.8816, tick: "0.0001", lot: "0.1" },
  BNBUSDT: { price: 1_012.4, tick: "0.01", lot: "0.01" }, DOGEUSDT: { price: 0.26184, tick: "0.00001", lot: "1" },
  ZECUSDT: { price: 241.37, tick: "0.01", lot: "0.001" }, HYPEUSDT: { price: 46.912, tick: "0.001", lot: "0.01" },
  LINKUSDT: { price: 23.874, tick: "0.001", lot: "0.01" }, AAVEUSDT: { price: 291.42, tick: "0.01", lot: "0.1" },
};

let seed = 11;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const iso = (ms: number) => new Date(ms).toISOString();
const decimals = (tick: string) => (tick.split(".")[1] ?? "").length;
const fix = (value: number, tick: string) => value.toFixed(decimals(tick));

function quote(symbol: string, now: number, price = BASE[symbol].price): MarketQuote {
  const { tick } = BASE[symbol];
  const spread = Number(tick) * 2;
  return { symbol, status: "QUOTED", bidPrice: fix(price - spread / 2, tick), askPrice: fix(price + spread / 2, tick), exchangeTime: iso(now - 400), observedAt: iso(now), tickSize: tick };
}

function rule(symbol: string, now: number) {
  const { tick, lot } = BASE[symbol];
  return { symbol, observedAt: iso(now), venue: "BINANCE_USDM_MAINNET", status: "TRADING", price: { min: tick, max: "10000000", step: tick }, lot: { min: lot, max: "100000000", step: lot }, marketLot: { min: lot, max: "100000000", step: lot }, minNotional: "5", multiplierUp: "1.05", multiplierDown: "0.95", orderTypes: ["LIMIT", "MARKET", "STOP_MARKET", "TAKE_PROFIT_MARKET"] } as unknown as PrecisionRule;
}

function plan(symbol: string, offsetMs: number, status: string, direction: "LONG" | "SHORT" | null, now: number, pxShift: number, extra: Partial<Candidate> = {}): Candidate {
  const px = BASE[symbol].price * (1 + pxShift);
  return { id: `DEMO-S1-${symbol}-${Math.round(offsetMs / 60000)}`, symbol, status, direction, intersectionTime: iso(now + offsetMs), intersectionPrice: Number(fix(px, BASE[symbol].tick)), observedAt: iso(now), stale: false, reason: status === "WAITING_FIRST_PX_CLOSE" ? "DIRECTION_CLOSE_PENDING" : "", ...extra };
}

export function buildDemoFeed(now = Date.now()) {
  seed = 11;
  const quotes = UNIVERSE.map(symbol => quote(symbol, now));
  const candidates: Candidate[] = [
    plan("ETHUSDT", -9 * 60_000, "FIRST_CLOSE_LOCKED", "LONG", now, -.0064, { directionClosedAt: iso(now - 50_000) }),
    plan("SOLUSDT", -4 * 60_000, "WAITING_FIRST_PX_CLOSE", null, now, .0031),
    plan("BTCUSDT", 27 * 60_000 + 14_000, "FORMING", null, now, -.0042),
    plan("LINKUSDT", 1.6 * 3_600_000, "FORMING", null, now, .0118),
    plan("HYPEUSDT", 3.2 * 3_600_000, "WAITING_CLOSE", null, now, -.021),
    plan("XRPUSDT", 6.8 * 3_600_000, "FORMING", null, now, .006),
    plan("AAVEUSDT", 11.5 * 3_600_000, "FORMING", null, now, -.0135),
    plan("BNBUSDT", 19 * 3_600_000, "FORMING", null, now, .0088),
    plan("ZECUSDT", -52 * 60_000, "CONFIRMED_EXPIRED", "SHORT", now, .004, { directionClosedAt: iso(now - 40 * 60_000) }),
  ];
  const lockedId = candidates[0].id;

  const positions = [
    { symbol: "DOGEUSDT", side: "LONG", quantity: "21400", entryPrice: "0.25912", markPrice: "0.26181", liquidationPrice: "0.18210", unrealized: 57.56, notional: 5602.7, leverage: 5, marginType: "cross" },
    { symbol: "ZECUSDT", side: "SHORT", quantity: "-9.874", entryPrice: "247.12", markPrice: "241.40", liquidationPrice: "331.80", unrealized: 56.48, notional: -2383.6, leverage: 5, marginType: "cross" },
  ];
  const equity = 12_436.82;
  const snapshot: Snapshot = {
    sourceAsOf: iso(now - 6_000), sequence: 48_213, startedAt: iso(now - 3 * 86_400_000), bootId: "demo", status: "HEALTHY", scanDurationMs: 4_820, scannedSymbols: 10, universe: UNIVERSE, lastSuccessfulScanAt: iso(now - 6_000),
    account: {
      observedAt: iso(now - 3_000), fresh: true, userStreamConnected: true, equity, wallet: equity - 114.04, available: 9_210.37, positions: 2, orders: 0, algoOrders: 4, positionMode: "HEDGE",
      details: { unrealized: 114.04, initialMargin: 1_597.26, maintenanceMargin: 39.9, positionMargin: 1_597.26, orderMargin: 0, multiAssetsMargin: false, positionsComplete: true, ordersComplete: true, algoOrdersComplete: true, positionRows: positions,
        regularOrders: [],
        conditionalOrders: [
          { symbol: "DOGEUSDT", side: "SELL", type: "STOP_MARKET", status: "NEW", quantity: "21400", executedQuantity: "0", price: "0", triggerPrice: "0.25340" },
          { symbol: "DOGEUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", status: "NEW", quantity: "8560", executedQuantity: "0", price: "0", triggerPrice: "0.26490" },
          { symbol: "ZECUSDT", side: "BUY", type: "STOP_MARKET", status: "NEW", quantity: "9.874", executedQuantity: "0", price: "0", triggerPrice: "244.90" },
          { symbol: "ZECUSDT", side: "BUY", type: "TAKE_PROFIT_MARKET", status: "NEW", quantity: "2.468", executedQuantity: "0", price: "0", triggerPrice: "236.10" },
        ] },
    },
    marketQuotes: quotes, precision: { rules: UNIVERSE.map(symbol => rule(symbol, now)), errors: [] },
    candidates, errors: [], publish: { status: "OK", at: iso(now - 5_000) }, recovery: { stateRecovered: true },
    eventGate: { status: "OPEN", newEntriesPaused: false, pauseUntil: null, calendarCheckedAt: iso(now - 60_000) },
  };

  // random walk generated backwards from the current equity so the curve ends exactly at the live value
  let value = equity;
  const walk = Array.from({ length: 420 }, () => { const current = value; value -= (random() - .44) * 7; return current; }).reverse();
  const points = walk.map((point, index) => ({ observedAt: iso(now - (420 - index) * 60_000), equity: point, wallet: point - 80, available: point * .74 }));
  // a short outage, drawn as a break in the curve
  points.splice(180, 6);
  const history: History = { status: "OK", points, firstObservedAt: iso(now - 21 * 86_400_000) };

  const execution: ExecutionState = {
    observedAt: iso(now - 4_000), service: "s1-execution", mode: "LIVE", status: "RUNNING", infrastructureReady: true, realOrdersAllowed: true, entriesAllowed: true, liveReady: true, orderAuthorizationStatus: "AUTHORIZED", entryIncident: null,
    entryBlockers: [{ key: "b1", planId: lockedId, symbol: "ETHUSDT", direction: "LONG", reason: "IQ1_CORRELATED_GROUP_CAPACITY", classification: "CAPACITY_WAIT", evaluatedAt: iso(now - 20_000) }],
    positionStages: [
      { symbol: "DOGEUSDT", direction: "LONG", stage: "SOFT", quantity: "12840", originalQuantity: "21400", stop: "0.25340" },
      { symbol: "ZECUSDT", direction: "SHORT", stage: "ONE_R", quantity: "3.456", originalQuantity: "9.874", stop: "244.90" },
    ],
    openPositions: 2, openOrders: 0, openAlgoOrders: 4,
    candidateSource: { state: "READY", reason: null, observedAt: now - 6_000, checkedAt: now - 4_000, candidateCount: candidates.length, lastGoodAt: now - 6_000 },
    candidatePriorities: [
      { planId: lockedId, symbol: "ETHUSDT", direction: "LONG", state: "WAITING", reason: "IQ1_CORRELATED_GROUP_CAPACITY", evaluatedAt: iso(now - 20_000) },
      { planId: "DEMO-DOGE", symbol: "DOGEUSDT", direction: "LONG", state: "POSITION_OPEN", reason: null, evaluatedAt: iso(now - 20_000) },
    ],
    portfolioProtection: { revision: "R21-DEMO", evidenceHold: false, evaluatedAt: iso(now - 30_000), holdReasons: [], campaigns: [
      { direction: "LONG", active: false, positionCount: 1, highWaterPnlUsdt: 61.2, markedPnlUsdt: 57.56, drawdownFraction: .06, entryProtectionTier: "IDLE", regime: "NORMAL", freezeUntil: null },
      { direction: "SHORT", active: false, positionCount: 1, highWaterPnlUsdt: 72.4, markedPnlUsdt: 56.48, drawdownFraction: .22, entryProtectionTier: "IDLE", regime: "NORMAL", freezeUntil: null },
    ] },
    strategyRuntime: {
      displayName: "R22 回滚版 · 4H×1H 交汇 / 15M 收线确认", executionRevision: "MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY", entryQualityRevision: "V2-IQ1-P1-20260915", entryQualityPolicyRevision: "S1-R22-ROLLBACK-20261010",
      baseImplementationRevision: "MTFX-0.5.0-R22", managementRevision: "R22-TIERED-0.5R-1R-2R", portfolioProtectionRevision: "R21-PORTFOLIO-3POS", entryConfirmationRevision: "R22-15M-5BP", costPolicyRevision: "COST-0.12R", candidatePriorityRevision: "PRIORITY-ATR-AGE",
      pxDistanceGateEnabled: false, runtimeLoaded: true,
      riskPolicy: { mode: "LIVE", perTradeFraction: "0.04", portfolioFraction: "0.10", maximumOpenPositions: 4, maximumLeverage: 10, maximumGrossNotionalLeverage: 3, grossNotionalMustNotExceedEquity: false, effectiveMaximumGroupPositions: 2 },
    },
  };

  const filteredCandidates: FilteredCandidate[] = [
    { key: "h1", planId: "DEMO-H1", symbol: "BTCUSDT", direction: "SHORT", stage: "EXECUTION_GATE", reason: "R22_COST_EFFICIENCY_REJECTED", evaluatedAt: iso(now - 3.4 * 3_600_000), intersectionTime: iso(now - 3.6 * 3_600_000), intersectionPrice: 113_920.4 },
    { key: "h2", planId: "DEMO-H2", symbol: "SOLUSDT", direction: "LONG", stage: "SIGNAL_CONFIRMATION", reason: "TWO_BAR_CROSS_CLOSES_INSIDE_BUFFER", evaluatedAt: iso(now - 7.1 * 3_600_000), intersectionTime: iso(now - 7.5 * 3_600_000), intersectionPrice: 209.31 },
    { key: "h3", planId: "DEMO-H3", symbol: "AAVEUSDT", direction: "LONG", stage: "EXECUTION_GATE", reason: "IQ1_CORRELATED_GROUP_CAPACITY", evaluatedAt: iso(now - 13 * 3_600_000), intersectionTime: iso(now - 13.4 * 3_600_000), intersectionPrice: 286.8 },
    { key: "h4", planId: "DEMO-H4", symbol: "XRPUSDT", direction: null, stage: "CANDIDATE_LIFECYCLE", reason: "CANDIDATE_SUPERSEDED", evaluatedAt: iso(now - 20 * 3_600_000), intersectionTime: iso(now - 20.2 * 3_600_000), intersectionPrice: 2.8121 },
  ];

  const fill = (key: string, hoursAgo: number, symbol: string, positionSide: string, side: string, quantity: string, price: string, commission: string, realized: string) =>
    ({ key, tradeId: String(880_000 + Number(key.slice(1))), orderId: String(5_100_000 + Number(key.slice(1)) * 7), symbol, positionSide, side, quantity, price, commission, feeAsset: "USDT", realizedPnlUsdt: realized, netPnlUsdt: (Number(realized) - Number(commission)).toFixed(8), time: now - hoursAgo * 3_600_000, attribution: "STRATEGY", attemptId: null });
  const fills = [
    fill("f1", .6, "ZECUSDT", "SHORT", "BUY", "3.209", "243.11", "0.39005", "12.92"),
    fill("f2", 1.1, "ZECUSDT", "SHORT", "BUY", "3.209", "244.60", "0.39244", "8.14"),
    fill("f3", 2.3, "DOGEUSDT", "LONG", "SELL", "8560", "0.26128", "1.11829", "18.15"),
    fill("f4", 5.4, "DOGEUSDT", "LONG", "BUY", "21400", "0.25912", "2.77258", "0"),
    fill("f5", 9.8, "ZECUSDT", "SHORT", "SELL", "9.874", "247.12", "1.22004", "0"),
    fill("f6", 27, "LINKUSDT", "LONG", "SELL", "212.4", "23.512", "2.49695", "-48.31"),
  ];
  const sum = (key: "commission" | "realizedPnlUsdt" | "netPnlUsdt") => fills.reduce((total, row) => total + Number(row[key]), 0).toFixed(8);
  const ledger: ExecutionLedger = { status: "OK", observedAt: iso(now - 4_000), receivedAt: iso(now - 3_000), execution, filteredCandidates, fills, summary: { fillCount: fills.length, commissionUsdt: sum("commission"), realizedPnlUsdt: sum("realizedPnlUsdt"), netPnlUsdt: sum("netPnlUsdt") } };

  const day = 86_400_000;
  const calendar: RiskCalendarFeed = {
    checkedAt: iso(now - 60_000),
    sources: [
      { provider: "BLS", status: "LIVE_OFFICIAL", verifiedAt: iso(now - 2 * 3_600_000), coverageEnd: iso(now + 60 * day), error: null },
      { provider: "FED", status: "LIVE_OFFICIAL", verifiedAt: iso(now - 5 * 3_600_000), coverageEnd: iso(now + 90 * day), error: null },
    ],
    events: [
      { id: "e0", name: "美国初请失业金人数", category: "LABOR", tier: "TIER2", provider: "DOL", scheduledAt: iso(now - 20 * 3_600_000), sourceUrl: "https://www.dol.gov/" },
      { id: "e1", name: "美国 CPI", category: "INFLATION", tier: "TIER1", provider: "BLS", scheduledAt: iso(now + 1.7 * day), sourceUrl: "https://www.bls.gov/schedule/" },
      { id: "e2", name: "美国 PPI", category: "INFLATION", tier: "TIER2", provider: "BLS", scheduledAt: iso(now + 2.7 * day), sourceUrl: "https://www.bls.gov/schedule/" },
      { id: "e3", name: "美国非农就业", category: "LABOR", tier: "TIER1", provider: "BLS", scheduledAt: iso(now + 5.6 * day), sourceUrl: "https://www.bls.gov/schedule/" },
      { id: "e4", name: "FOMC 利率决议", category: "RATES", tier: "TIER1", provider: "FED", scheduledAt: iso(now + 9.3 * day), sourceUrl: "https://www.federalreserve.gov/" },
      { id: "e5", name: "美国 PCE 物价指数", category: "INFLATION", tier: "TIER2", provider: "BEA", scheduledAt: iso(now + 14.6 * day), sourceUrl: "https://www.bea.gov/" },
    ],
  };
  return { snapshot, history, ledger, calendar };
}

/** Keeps demo timestamps fresh and nudges quotes so the motion system has something to react to. */
export function tickDemo(state: ReturnType<typeof buildDemoFeed>, now = Date.now()): ReturnType<typeof buildDemoFeed> {
  const quotes = (state.snapshot.marketQuotes ?? []).map(row => {
    const mid = (Number(row.bidPrice) + Number(row.askPrice)) / 2;
    return quote(row.symbol, now, mid * (1 + (Math.random() - .5) * .0012));
  });
  const execution = state.ledger.execution!;
  const details = state.snapshot.account.details!;
  const positionRows = details.positionRows.map(row => {
    const live = quotes.find(item => item.symbol === row.symbol);
    const mark = live ? (Number(live.bidPrice) + Number(live.askPrice)) / 2 : Number(row.markPrice);
    const unrealized = (mark - Number(row.entryPrice)) * Number(row.quantity);
    return { ...row, markPrice: String(mark), unrealized: Number(unrealized.toFixed(2)) };
  });
  const unrealized = positionRows.reduce((total, row) => total + (row.unrealized ?? 0), 0);
  const equity = (state.snapshot.account.wallet ?? 0) + unrealized;
  const candidates = state.snapshot.candidates.map(row => row.status === "FIRST_CLOSE_LOCKED" ? { ...row, directionClosedAt: new Date(now - 50_000).toISOString() } : row);
  const points = [...(state.history.points ?? [])];
  const last = points[points.length - 1];
  if (!last || now - Date.parse(last.observedAt) >= 15_000) points.push({ observedAt: new Date(now).toISOString(), equity, wallet: state.snapshot.account.wallet ?? 0, available: state.snapshot.account.available ?? 0 });
  return {
    ...state,
    snapshot: { ...state.snapshot, sourceAsOf: new Date(now - 5_000).toISOString(), lastSuccessfulScanAt: new Date(now - 5_000).toISOString(), marketQuotes: quotes, candidates,
      account: { ...state.snapshot.account, observedAt: new Date(now - 2_000).toISOString(), equity, details: { ...details, unrealized, positionRows } } },
    history: { ...state.history, points: points.slice(-720) },
    ledger: { ...state.ledger, observedAt: new Date(now - 3_000).toISOString(),
      execution: { ...execution, observedAt: new Date(now - 3_000).toISOString(), candidateSource: execution.candidateSource ? { ...execution.candidateSource, observedAt: now - 5_000, checkedAt: now - 3_000 } : execution.candidateSource } },
  };
}
