import { tier1EventWindowAt, validateTier1EventCalendar } from "../paper/event-risk.mjs";
import { updateHourlyStructureTrail } from "../paper/paper-engine.mjs";
import { evaluateR21ProfitProtection, initialR21State, r21AtrTrail } from "../../shared/r21-profit-protection.mjs";
import { sha256, stableStringify } from "./contracts.mjs";

const INTERVAL = { "15m": 900_000, "1h": 3_600_000 };

export function validateClosedBarSeries(bars, interval, serverTime) {
  const width = INTERVAL[interval];
  const minimum = interval === "15m" ? 20 : 12;
  if (!Array.isArray(bars) || bars.length < minimum) return { healthy: false, reason: `${interval.toUpperCase()}_WARMUP_INSUFFICIENT` };
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (![bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.closeTime].every(Number.isFinite) || bar.closeTime >= serverTime || bar.high < bar.low) return { healthy: false, reason: `${interval.toUpperCase()}_BAR_INVALID_OR_OPEN` };
    if (index && bar.openTime - bars[index - 1].openTime !== width) return { healthy: false, reason: `${interval.toUpperCase()}_BAR_GAP` };
  }
  const latest = bars.at(-1);
  if (serverTime - latest.closeTime > width + 10_000) return { healthy: false, reason: `${interval.toUpperCase()}_BAR_STALE` };
  return { healthy: true, lastCloseTime: latest.closeTime, warmupSha256: sha256(stableStringify(bars)) };
}

export function r13CoverageAt({ calendar, attestation, eventTime, policy }) {
  try { validateTier1EventCalendar(calendar); } catch { return { ready: false, eligible: false, blocker: "R13_CALENDAR_INVALID" }; }
  const categories = ["FOMC_RATE_DECISION_AND_PRESS_CONFERENCE", "US_CPI", "US_EMPLOYMENT_SITUATION", "US_PCE"];
  const calendarSha256 = sha256(stableStringify(calendar));
  if (attestation?.schemaVersion !== 1 || attestation.status !== "VERIFIED_COMPLETE" || attestation.calendarSha256 !== calendarSha256 ||
    !categories.every((category) => attestation.coveredCategories?.includes(category)) || !/^[0-9a-f]{64}$/.test(attestation.evidenceSha256 ?? "")) {
    return { ready: false, eligible: false, blocker: "R13_OFFICIAL_CALENDAR_COVERAGE_ATTESTATION_MISSING_OR_INVALID" };
  }
  const decisionUseNotBefore = Date.parse(attestation.decisionUseNotBefore);
  const coverageStart = Date.parse(attestation.coverageStart);
  const coverageEnd = Date.parse(attestation.coverageEnd);
  if (attestation.coverageEndExclusive !== true || !Number.isFinite(decisionUseNotBefore) || eventTime < decisionUseNotBefore) return { ready: false, eligible: false, blocker: "R13_DECISION_BEFORE_ATTESTATION_NOT_RETROACTIVELY_ELIGIBLE" };
  if (!Number.isFinite(coverageStart) || !Number.isFinite(coverageEnd) || eventTime < coverageStart || eventTime >= coverageEnd) return { ready: false, eligible: false, blocker: "R13_EVENT_TIME_OUTSIDE_ATTESTED_COVERAGE" };
  const window = tier1EventWindowAt({ now: eventTime, policy, calendar });
  return { ready: true, eligible: !window.active, blocker: window.active ? "R13_SCHEDULED_TIER1_EVENT_ENTRY_FREEZE" : null, calendarSha256, coverageStart: new Date(coverageStart).toISOString(), coverageEnd: new Date(coverageEnd).toISOString(), eventIds: window.eventIds ?? [] };
}

function markedPositions(state) {
  return state.positions.map((position) => {
    const gross = position.direction * (position.lastMark - position.entry) * position.quantity;
    const exitFee = position.lastMark * position.quantity * 0.0007;
    return {
      id: position.id,
      symbol: position.symbol,
      direction: position.direction,
      initialRiskUsdt: position.initialRiskUsdt,
      markedNetPnlUsdt: -position.entryFeeUsdt + position.cumulativeGrossPnlUsdt - position.cumulativeExitFeesUsdt - position.cumulativeFundingUsdt + gross - exitFee,
      initialStage: !position.halfTaken && !position.oneTaken,
    };
  });
}

export function evaluateIndependentR21({ state, quotes, now, config }) {
  const quoteObject = Object.fromEntries([...quotes].map(([symbol, quote]) => [symbol, { bid: quote.bid, ask: quote.ask }]));
  const outcome = evaluateR21ProfitProtection({ priorState: state.r21State ?? initialR21State(now), positions: markedPositions(state), quotes: quoteObject, equityUsdt: state.account.cashRealizedEquityUsdt ?? 0, now, config });
  return { ...outcome, ready: config?.enabled === true && (config.eligibleSymbols ?? []).every((symbol) => quotes.has(symbol)) };
}

export function deriveIndependentR22Trail({ position, bars15m, bars1h, strategy, r21Config, serverTime }) {
  const health15m = validateClosedBarSeries(bars15m, "15m", serverTime);
  const health1h = validateClosedBarSeries(bars1h, "1h", serverTime);
  if (!health15m.healthy || !health1h.healthy) return { inputsReady: false, blockers: [health15m.reason, health1h.reason].filter(Boolean) };
  if (!position) return { inputsReady: true, confirmed1hStop: null, closed15mAtrStop: null, health15m, health1h };
  const compatible = { ...position, status: "OPEN", secondPartialTaken: position.twoTaken, maximumNetExcursionR: position.maximumNetExcursionR ?? 0, runnerMaximumNetExcursionR: position.runnerMaximumNetExcursionR ?? null };
  const structure = updateHourlyStructureTrail(compatible, bars1h, strategy);
  const afterStructure = structure.changed ? structure.position : compatible;
  const atr = r21AtrTrail(afterStructure, bars15m, r21Config);
  return {
    inputsReady: true,
    confirmed1hStop: structure.changed ? structure.position.stop : position.stop,
    closed15mAtrStop: atr.changed ? atr.position.stop : position.stop,
    structure,
    atr,
    health15m,
    health1h,
  };
}
