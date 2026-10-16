import { createHash } from "node:crypto";
import { BASELINE_REVISION, CANDIDATE_REVISION, C_POLICY, SOURCE_SCOPE, STUDY_ID } from "./policy.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const nonnegative = (value) => finite(value) && value >= 0;
const integer = (value) => Number.isInteger(value);
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

function require(condition, code) {
  if (!condition) throw new Error(code);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

export function validateLedgerSourceEvent(event) {
  require(event && typeof event === "object", "SOURCE_EVENT_OBJECT_REQUIRED");
  require(integer(event.sequence) && event.sequence >= 1, "SOURCE_EVENT_SEQUENCE_INVALID");
  require(typeof event.eventId === "string" && event.eventId.length > 0, "SOURCE_EVENT_ID_INVALID");
  require(typeof event.type === "string" && event.type.length > 0, "SOURCE_EVENT_TYPE_INVALID");
  require(finite(event.marketTime), "SOURCE_EVENT_MARKET_TIME_INVALID");
  require(typeof event.previousHash === "string" && typeof event.hash === "string", "SOURCE_EVENT_CHAIN_FIELDS_INVALID");
  require(event.payload && typeof event.payload === "object", "SOURCE_EVENT_PAYLOAD_INVALID");
  return event;
}

export function validateQuoteEvent(event) {
  require(event?.schemaVersion === 1 && event?.type === "PUBLIC_BBO", "QUOTE_CONTRACT_INVALID");
  require(/^[A-Z0-9]+USDT$/.test(event.symbol ?? ""), "QUOTE_SYMBOL_INVALID");
  require(positive(event.bid) && positive(event.ask) && event.ask >= event.bid, "QUOTE_PRICE_INVALID");
  require(integer(event.updateId) && event.updateId >= 0, "QUOTE_UPDATE_ID_INVALID");
  require([event.eventTime, event.transactionTime, event.receivedAt].every(finite), "QUOTE_CLOCK_INVALID");
  require(event.receivedAt >= event.eventTime - 60_000, "QUOTE_RECEIPT_CLOCK_INVALID");
  return event;
}

export function validateDepthEvent(event) {
  require(event?.schemaVersion === 1 && event?.type === "PUBLIC_PARTIAL_DEPTH", "DEPTH_CONTRACT_INVALID");
  require(/^[A-Z0-9]+USDT$/.test(event.symbol ?? ""), "DEPTH_SYMBOL_INVALID");
  require(integer(event.lastUpdateId) && event.lastUpdateId >= 0, "DEPTH_UPDATE_ID_INVALID");
  require(finite(event.eventTime) && finite(event.receivedAt), "DEPTH_CLOCK_INVALID");
  for (const side of [event.bids, event.asks]) {
    require(Array.isArray(side) && side.length > 0 && side.length <= 20, "DEPTH_LEVELS_INVALID");
    for (const level of side) require(Array.isArray(level) && level.length === 2 && positive(level[0]) && nonnegative(level[1]), "DEPTH_LEVEL_INVALID");
  }
  require(event.snapshotSemantics === "TOP_LEVELS_COMPLETE_AT_EVENT_NOT_FULL_DIFF_HISTORY", "DEPTH_SEMANTICS_INVALID");
  return event;
}

export function validateTradeEvent(event) {
  require(event?.schemaVersion === 1 && event?.type === "PUBLIC_AGG_TRADE", "TRADE_CONTRACT_INVALID");
  require(/^[A-Z0-9]+USDT$/.test(event.symbol ?? ""), "TRADE_SYMBOL_INVALID");
  require(integer(event.aggregateTradeId) && event.aggregateTradeId >= 0, "TRADE_ID_INVALID");
  require(positive(event.price) && positive(event.quantity), "TRADE_VALUE_INVALID");
  require(typeof event.buyerWasMaker === "boolean", "TRADE_AGGRESSOR_INVALID");
  require([event.eventTime, event.tradeTime, event.receivedAt].every(finite), "TRADE_CLOCK_INVALID");
  return event;
}

export function validateFundingEvent(event) {
  require(event?.schemaVersion === 1 && event?.type === "PUBLIC_MARK_FUNDING", "FUNDING_CONTRACT_INVALID");
  require(/^[A-Z0-9]+USDT$/.test(event.symbol ?? ""), "FUNDING_SYMBOL_INVALID");
  require(positive(event.markPrice) && finite(event.fundingRate), "FUNDING_VALUE_INVALID");
  require([event.eventTime, event.nextFundingTime, event.receivedAt].every(finite), "FUNDING_CLOCK_INVALID");
  return event;
}

export function validateMetadataRecord(record) {
  require(record?.schemaVersion === 1 && record?.type === "PUBLIC_EXCHANGE_METADATA", "METADATA_CONTRACT_INVALID");
  require(/^[A-Z0-9]+USDT$/.test(record.symbol ?? ""), "METADATA_SYMBOL_INVALID");
  require(record.status === "TRADING" && record.contractType === "PERPETUAL", "METADATA_MARKET_INVALID");
  require([record.tickSize, record.stepSize, record.minQty, record.minNotional].every(nonnegative), "METADATA_LIMIT_INVALID");
  require(positive(record.tickSize) && positive(record.stepSize) && positive(record.minQty), "METADATA_INCREMENT_INVALID");
  require(iso(record.sourceAsOf) && /^[0-9a-f]{64}$/.test(record.sourceSha256 ?? ""), "METADATA_EVIDENCE_INVALID");
  return record;
}

export function validateInputFreshness({ quote, depth, funding, metadata, now }) {
  const blockers = [];
  const checks = [
    [quote, validateQuoteEvent, C_POLICY.maximumQuoteAgeMs, "QUOTE"],
    [depth, validateDepthEvent, C_POLICY.maximumDepthAgeMs, "DEPTH"],
    [funding, validateFundingEvent, C_POLICY.maximumFundingAgeMs, "FUNDING"],
  ];
  for (const [input, validate, maximumAge, name] of checks) {
    try { validate(input); } catch { blockers.push(`${name}_INVALID_OR_MISSING`); continue; }
    if (now - input.receivedAt > maximumAge || input.receivedAt > now + 1_000) blockers.push(`${name}_STALE_OR_FUTURE`);
  }
  try { validateMetadataRecord(metadata); } catch { blockers.push("METADATA_INVALID_OR_MISSING"); }
  if (metadata && now - Date.parse(metadata.sourceAsOf) > C_POLICY.maximumMetadataAgeMs) blockers.push("METADATA_STALE");
  if (quote?.symbol && [depth?.symbol, funding?.symbol, metadata?.symbol].some((symbol) => symbol !== quote.symbol)) blockers.push("CROSS_INPUT_SYMBOL_MISMATCH");
  return { healthy: blockers.length === 0, blockers };
}

export function inputStatus(status = "WAITING", sourceAsOf = null, freshnessMs = null, extra = {}) {
  return { status, sourceAsOf, freshnessMs, ...extra };
}

export function buildCandidateSummary(state, inputHealth, sequence, sourceAsOf) {
  const breakerBlockers = state.abnormalLoss.status === "CLEAR" ? [] : [`ABNORMAL_LOSS_GATE_${state.abnormalLoss.status}`];
  const blockers = [...new Set([...(state.blockers ?? []), ...(inputHealth.blockers ?? []), ...breakerBlockers])].sort();
  const seeded = state.startedAt != null;
  const account = state.account;
  const allInputsHealthy = Object.values(inputHealth.inputs ?? {}).every((input) => input?.status === "HEALTHY");
  const status = state.abnormalLoss.status === "RED" ? "RED_LATCHED_MANUAL_RESET_REQUIRED"
    : !seeded ? "WAITING_HEALTHY_FORWARD_BASELINE" : blockers.length ? "EVIDENCE_HOLD" : "ACTIVE_OBSERVE_ONLY";
  const publishedAvailableRisk = status === "ACTIVE_OBSERVE_ONLY" && allInputsHealthy && state.abnormalLoss.status === "CLEAR"
    ? account.availableCandidateRiskUsdt : 0;
  return {
    schemaVersion: 1,
    studyId: STUDY_ID,
    candidateRevision: CANDIDATE_REVISION,
    sequence,
    sourceAsOf,
    startedAt: state.startedAt,
    status,
    sourceScope: { ...SOURCE_SCOPE, carryInPositionCount: state.carryInPositionIds.length },
    account: {
      currency: "USDT",
      initialEquityUsdt: account.initialEquityUsdt,
      cashRealizedEquityUsdt: account.cashRealizedEquityUsdt,
      liquidationNetEquityUsdt: account.liquidationNetEquityUsdt,
      confirmedHighEquityUsdt: account.confirmedHighEquityUsdt,
      protectionFloorUsdt: account.protectionFloorUsdt,
      remainingProtectionCushionUsdt: account.remainingProtectionCushionUsdt,
      existingStressRiskUsdt: account.existingStressRiskUsdt,
      availableCandidateRiskUsdt: publishedAvailableRisk,
      portfolioPlannedRiskUsdt: account.portfolioPlannedRiskUsdt,
      grossNotionalUsdt: account.grossNotionalUsdt,
      openPositionCount: state.positions.length,
      closedPositionCount: state.closedPositions.length,
      cumulativeEntryFeesUsdt: account.cumulativeEntryFeesUsdt,
      cumulativeExitFeesUsdt: account.cumulativeExitFeesUsdt,
      cumulativeFundingUsdt: account.cumulativeFundingUsdt,
      cumulativeRebalanceCostsUsdt: account.cumulativeRebalanceCostsUsdt,
      realizedPnlUsdt: account.realizedPnlUsdt,
      markToMarketNetPnlUsdt: account.markToMarketNetPnlUsdt,
      maximumDrawdownFraction: account.maximumDrawdownFraction,
    },
    inputs: inputHealth.inputs,
    gates: {
      executionInputAllowed: false,
      kellySizingActivationAllowed: false,
      automaticPromotionAllowed: false,
      realizedOnlyCompounding: true,
      correlatedRiskShared: true,
      riskLimits: {
        candidateFraction: C_POLICY.maximumRiskFraction,
        perIntersectionFraction: C_POLICY.maximumPerIntersectionFraction,
        portfolioFraction: C_POLICY.maximumPortfolioRiskFraction,
        cushionUseFraction: C_POLICY.cushionRiskUseFraction,
        maximumLeverage: C_POLICY.maximumLeverage,
        maximumPositions: C_POLICY.maximumPositions,
      },
      strategyInheritance: { baselineRevision: BASELINE_REVISION, r13: "REQUIRED", r15: "REQUIRED", r19: "REQUIRED", r20: "REQUIRED", r21: "REQUIRED", r22: "REQUIRED" },
      abnormalLoss: {
        status: state.abnormalLoss.status,
        yellowAboveR: 1.2,
        orangeAboveR: 1.5,
        redAboveR: 2,
        automaticRedReleaseAllowed: false,
      },
      blockers,
    },
    validation: {
      performanceValidated: false,
      annualTargetProbability: null,
      annualTargetProbabilityPublicationAllowed: false,
      eligibleCompletedCampaigns: state.validation.eligibleCompletedCampaigns,
      excludedCompletedCampaigns: state.validation.excludedCompletedCampaigns,
      minimumEligibleCampaigns: 20,
      completeIndependentSignalUniverse: false,
      missingDataInvented: false,
    },
  };
}
