export const R21_ELIGIBLE_SYMBOLS = Object.freeze([
  "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
  "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT",
]);

export const R21_EXCLUDED_SYMBOLS = Object.freeze(["BTCUSDT", "ETHUSDT"]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function isR21EligibleSymbol(symbol, config) {
  const eligible = config?.eligibleSymbols ?? R21_ELIGIBLE_SYMBOLS;
  const excluded = new Set(config?.excludedSymbols ?? R21_EXCLUDED_SYMBOLS);
  return eligible.includes(symbol) && !excluded.has(symbol);
}

export function initialR21State(activatedAt = Date.now()) {
  return {
    schemaVersion: 1,
    activatedAt,
    lastSampleAt: null,
    samples: [],
    campaigns: {
      LONG: { active: false, tier: "IDLE", highWaterPnlUsdt: 0, freezeUntil: null },
      SHORT: { active: false, tier: "IDLE", highWaterPnlUsdt: 0, freezeUntil: null },
    },
  };
}

export function sampleR21Quotes(priorState, quotes, now, config) {
  const state = priorState?.schemaVersion === 1 ? structuredClone(priorState) : initialR21State(now);
  const interval = finite(config?.quoteSampleIntervalMs, 60_000);
  if (state.lastSampleAt && now - state.lastSampleAt < interval) return state;
  const prices = {};
  for (const symbol of config?.eligibleSymbols ?? R21_ELIGIBLE_SYMBOLS) {
    const quote = quotes?.[symbol];
    const bid = finite(quote?.bid);
    const ask = finite(quote?.ask);
    if (bid > 0 && ask >= bid) prices[symbol] = (bid + ask) / 2;
  }
  state.samples.push({ at: now, prices });
  const lookback = finite(config?.shockLookbackMs, 180_000);
  state.samples = state.samples.filter((sample) => now - finite(sample.at) <= lookback * 2);
  state.lastSampleAt = now;
  return state;
}

function returnsFromSamples(state, config) {
  const latest = state.samples.at(-1);
  const cutoff = finite(latest?.at) - finite(config?.shockLookbackMs, 180_000);
  const prior = [...state.samples].reverse().find((sample) => finite(sample.at) <= cutoff) ?? state.samples[0];
  if (!latest || prior === latest) return {};
  return Object.fromEntries(Object.entries(latest.prices ?? {}).flatMap(([symbol, price]) => {
    const base = finite(prior.prices?.[symbol]);
    return base > 0 ? [[symbol, (finite(price) - base) / base]] : [];
  }));
}

function tierFor(drawdown, thresholds) {
  if (drawdown >= finite(thresholds?.hard, 0.4)) return "HARD";
  if (drawdown >= finite(thresholds?.defense, 0.3)) return "DEFENSE";
  if (drawdown >= finite(thresholds?.warning, 0.2)) return "WARNING";
  return "ARMED";
}

const TIER_RANK = { IDLE: 0, ARMED: 1, WARNING: 2, DEFENSE: 3, HARD: 4 };

export function evaluateR21ProfitProtection({ priorState, positions, quotes, equityUsdt, now, config }) {
  let state = sampleR21Quotes(priorState, quotes, now, config);
  const returns = returnsFromSamples(state, config);
  const nextCampaigns = { ...state.campaigns };
  const actions = [];
  const minimumCount = finite(config?.minimumSameDirectionPositions, 3);
  const freezeMs = finite(config?.freezeMs, 900_000);

  for (const [label, direction] of [["LONG", 1], ["SHORT", -1]]) {
    const group = (positions ?? []).filter((position) =>
      isR21EligibleSymbol(position.symbol, config) && finite(position.direction) === direction
    );
    let campaign = { ...(state.campaigns?.[label] ?? initialR21State(now).campaigns[label]) };
    if (group.length < minimumCount) {
      nextCampaigns[label] = { active: false, tier: "IDLE", highWaterPnlUsdt: 0, freezeUntil: campaign.freezeUntil && campaign.freezeUntil > now ? campaign.freezeUntil : null };
      continue;
    }

    const markedPnl = group.reduce((sum, position) => sum + finite(position.markedNetPnlUsdt), 0);
    const initialRisk = group.reduce((sum, position) => sum + Math.max(0, finite(position.initialRiskUsdt)), 0);
    const armByEquity = markedPnl >= Math.max(0, finite(equityUsdt)) * finite(config?.armProfitFractionOfEquity, 0.015);
    const armByRisk = initialRisk > 0 && markedPnl / initialRisk >= finite(config?.armProfitMultipleOfInitialRisk, 2);
    if (!campaign.active && !(armByEquity || armByRisk)) {
      nextCampaigns[label] = { ...campaign, tier: "IDLE", freezeUntil: campaign.freezeUntil && campaign.freezeUntil > now ? campaign.freezeUntil : null };
      continue;
    }

    const wasActive = campaign.active === true;
    campaign.active = true;
    campaign.highWaterPnlUsdt = Math.max(wasActive ? finite(campaign.highWaterPnlUsdt) : markedPnl, markedPnl);
    const highWater = Math.max(0, campaign.highWaterPnlUsdt);
    const drawdown = highWater > 0 ? Math.max(0, (highWater - markedPnl) / highWater) : 0;
    const directionalReturns = Object.values(returns).map((value) => direction * finite(value));
    const weakBreadth = directionalReturns.length >= minimumCount &&
      directionalReturns.filter((value) => value > 0).length / directionalReturns.length < finite(config?.trendBreadthMinimumFraction, 0.625);
    const adverseCount = directionalReturns.filter((value) => value <= finite(config?.shockMedianReturnFraction, -0.02)).length;
    const shock = directionalReturns.length >= finite(config?.shockMinimumObservedSymbols, 6) &&
      adverseCount >= finite(config?.shockMinimumAdverseSymbols, 6) &&
      finite(median(directionalReturns), 0) <= finite(config?.shockMedianReturnFraction, -0.02);
    const thresholds = (weakBreadth || shock) ? config?.weakThresholds : config?.normalThresholds;
    const tier = tierFor(drawdown, thresholds);
    const priorTier = campaign.tier ?? "IDLE";
    campaign.tier = tier;
    campaign.markedPnlUsdt = markedPnl;
    campaign.drawdownFraction = drawdown;
    campaign.regime = shock ? "SHOCK" : weakBreadth ? "WEAK" : "PERSISTENT";
    campaign.positionCount = group.length;
    campaign.updatedAt = now;
    if (TIER_RANK[tier] >= TIER_RANK.WARNING) campaign.freezeUntil = Math.max(finite(campaign.freezeUntil), now + freezeMs);

    if (TIER_RANK[tier] > TIER_RANK[priorTier]) {
      const initial = group.filter((position) => position.initialStage === true);
      if (tier === "DEFENSE") {
        for (const position of initial) actions.push({ type: "REDUCE_INITIAL", symbol: position.symbol, positionId: position.id, fractionOfOriginal: finite(config?.initialDefenseReductionFractionOfOriginal, 0.25), direction });
      } else if (tier === "HARD") {
        for (const position of initial) actions.push({ type: "CLOSE_INITIAL", symbol: position.symbol, positionId: position.id, direction });
      }
    }
    nextCampaigns[label] = campaign;
  }

  state = { ...state, campaigns: nextCampaigns, lastEvaluatedAt: now };
  const frozenDirections = Object.entries(nextCampaigns)
    .filter(([, campaign]) => finite(campaign.freezeUntil) > now)
    .map(([label]) => label === "LONG" ? 1 : -1);
  const freezeEligibleEntries = frozenDirections.length > 0;
  return { state, actions, freezeEligibleEntries, frozenDirections, returns };
}

export function r21AtrTrail(position, bars15m, config) {
  if (!isR21EligibleSymbol(position?.symbol, config) || position?.status !== "OPEN" || position?.secondPartialTaken !== true) {
    return { changed: false, position, reason: "R21_RUNNER_NOT_ELIGIBLE" };
  }
  const sinceEntry = (bars15m ?? []).filter((bar) => finite(bar.closeTime) > finite(position.openedAt));
  const bars = config?.usePreEntryAtrHistory === true ? (bars15m ?? []) : sinceEntry;
  const period = finite(config?.runnerAtrPeriod, 14);
  if (bars.length < period + 1 || !sinceEntry.length) return { changed: false, position, reason: "R21_ATR_HISTORY_INSUFFICIENT" };
  const ranges = bars.map((bar, index) => {
    const priorClose = index ? finite(bars[index - 1].close) : finite(bar.close);
    return Math.max(finite(bar.high) - finite(bar.low), Math.abs(finite(bar.high) - priorClose), Math.abs(finite(bar.low) - priorClose));
  });
  const atr = ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
  const maximumR = Math.max(finite(position.runnerMaximumNetExcursionR), finite(position.maximumNetExcursionR));
  const tiers = config?.runnerAtrTiers ?? [{ minimumNetR: 3, multiplier: 4 }, { minimumNetR: 5, multiplier: 3 }, { minimumNetR: 10, multiplier: 2.5 }];
  const tier = [...tiers].sort((a, b) => finite(b.minimumNetR) - finite(a.minimumNetR)).find((item) => maximumR >= finite(item.minimumNetR));
  if (!tier || !(atr > 0)) return { changed: false, position, reason: "R21_ATR_TRAIL_NOT_ARMED" };
  const extreme = position.direction === 1
    ? Math.max(...sinceEntry.map((bar) => finite(bar.high)))
    : Math.min(...sinceEntry.map((bar) => finite(bar.low)));
  const candidate = extreme - finite(position.direction) * finite(tier.multiplier) * atr;
  const currentStop = finite(position.stop ?? position.stopPrice);
  const tighter = position.direction === 1 ? candidate > currentStop : candidate < currentStop;
  if (!tighter || !(candidate > 0)) return { changed: false, position, reason: "R21_ATR_TRAIL_WOULD_NOT_TIGHTEN" };
  const lastBar = bars.at(-1);
  return {
    changed: true,
    reason: "R21_RUNNER_ATR_TRAIL_TIGHTENED",
    position: {
      ...position,
      stop: candidate,
      stopPrice: candidate,
      lastR21AtrTrailBarCloseTime: lastBar.closeTime,
      r21AtrTrail: { period, atr, multiplier: finite(tier.multiplier), maximumNetR: maximumR, barCloseTime: lastBar.closeTime },
    },
  };
}
