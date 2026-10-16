import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, sha256, stableStringify, writeJsonAtomic } from "../../agents/orion-v2/paper/runtime-utils.mjs";
import { appendChainedAudit, verifyChainedAudit } from "./audit-ledger.mjs";
import { TESTNET_BASE_URL, assertTestnetBaseUrl, loadKeychainCredentials } from "./read-only-reconciler.mjs";
import { evaluateFourHourMarketStateGate } from "../../agents/orion-v3/binance-demo/high-frequency-strategy.mjs";
import { validateDualZPlanEvidence, validateSingleZPlanEvidence } from "../../agents/orion-v3/binance-demo/dual-z.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXECUTION_PROFILE = process.env.AEGIS_BINANCE_DEMO_EXECUTION_PROFILE === "ORION_V4" ? "ORION_V4" : "ORION_V3";
const V4_EXECUTION_AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-20-orion-v4-binance-usdm-demo-execution-platform.json");
const V4_STRATEGY_AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-29-orion-v4-mtfx-r22-v2-full-rule-parity.json");
const V4_RISK_POLICY_AUTHORIZATION_PATH = V4_STRATEGY_AUTHORIZATION_PATH;
const TIERED_SCAN_UNIVERSE_AUTHORIZATION_PATH = path.join(ROOT, "governance", "owner-authorizations", "2026-08-20-orion-v3-v4-tiered-scan-universe30.json");
const PROFILE = EXECUTION_PROFILE === "ORION_V4" ? Object.freeze({
  authorizationPath: V4_EXECUTION_AUTHORIZATION_PATH,
  runtimeDirectory: "orion-v4-binance-demo",
  outcomePrefix: "v4outcome",
  defaultEvaluationCohortId: "ORION-V4-PRE-STRATEGY-NO-TRADES-20260820",
  leverageAuthorizationId: "OWNER-DIRECTIVE-ORION-V4-BINANCE-USDM-DEMO-EXECUTION-PLATFORM-PARITY-20260820",
  universeAuthorizationId: "OWNER-DIRECTIVE-ORION-V3-V4-TIERED-SCAN-UNIVERSE30-20260820",
  userAgent: "aegis-orion-v4-binance-demo-trading/1.0",
}) : Object.freeze({
  authorizationPath: null,
  runtimeDirectory: "orion-v3-binance-demo",
  outcomePrefix: "v3outcome",
  defaultEvaluationCohortId: "ORION-V3-PRE-HF5-BASELINE-20260819",
  leverageAuthorizationId: "OWNER-DIRECTIVE-ORION-V3-BINANCE-DEMO-LEVERAGE-ALIGNMENT-10X-20260819",
  universeAuthorizationId: "OWNER-DIRECTIVE-ORION-V3-V4-TIERED-SCAN-UNIVERSE30-20260820",
  userAgent: "aegis-orion-v3-binance-demo-trading/1.0",
});
export const TRADING_AUTHORIZATION_PATH = PROFILE.authorizationPath ?? path.join(ROOT, "governance", "owner-authorizations", "2026-08-18-orion-v3-binance-usdm-demo-immediate-trading-cutover.json");
export const ALGO_STOP_AUTHORIZATION_PATH = PROFILE.authorizationPath ?? path.join(ROOT, "governance", "owner-authorizations", "2026-08-18-orion-v3-binance-usdm-demo-algo-stop-adapter.json");
export const FEE_LEDGER_AUTHORIZATION_PATH = PROFILE.authorizationPath ?? path.join(ROOT, "governance", "owner-authorizations", "2026-08-18-orion-v3-fee-ledger-presentation.json");
export const LEVERAGE_ALIGNMENT_AUTHORIZATION_PATH = PROFILE.authorizationPath ?? path.join(ROOT, "governance", "owner-authorizations", "2026-08-19-orion-v3-binance-demo-leverage-alignment.json");
export const RISK_POLICY_AUTHORIZATION_PATH = EXECUTION_PROFILE === "ORION_V4" ? V4_RISK_POLICY_AUTHORIZATION_PATH : path.join(ROOT, "governance", "owner-authorizations", "2026-08-20-orion-v3-aggressive-growth-risk-1pct-10pct.json");
export const TRADING_RUNTIME_ROOT = path.join(ROOT, ".runtime", PROFILE.runtimeDirectory);
export const TRADING_STATE_PATH = path.join(TRADING_RUNTIME_ROOT, "state.json");
export const TRADING_AUDIT_PATH = path.join(TRADING_RUNTIME_ROOT, "audit.ndjson");
const V3_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "TRXUSDT", "SUIUSDT", "NEARUSDT", "ETCUSDT", "FILUSDT", "ATOMUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "INJUSDT", "WIFUSDT", "SEIUSDT", "UNIUSDT", "TAOUSDT", "RENDERUSDT"];
const V4_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT"];
export const OWNER_APPROVED_TESTNET_SYMBOLS = Object.freeze(EXECUTION_PROFILE === "ORION_V4" ? V4_SYMBOLS : V3_SYMBOLS);
export const TESTNET_CONFIRMATION = "BINANCE_DEMO_ONLY";
export const TESTNET_INITIAL_LEVERAGE = EXECUTION_PROFILE === "ORION_V4" ? 4 : 10;
export const TESTNET_RISK_LIMITS = Object.freeze({
  maximumRiskPerEntryFraction: 0.01,
  maximumManagedPortfolioRiskFraction: EXECUTION_PROFILE === "ORION_V4" ? 0.05 : 0.1,
  maximumEffectiveNotionalLeverage: EXECUTION_PROFILE === "ORION_V4" ? 4 : 10,
  maximumOpenPositionsTotal: EXECUTION_PROFILE === "ORION_V4" ? 10 : 18,
  riskSizingUtilizationFraction: 0.98,
  takerFeeRate: 0.0007,
  adverseSlippageRate: 0.0002,
});

const ALLOWED_REQUESTS = new Map([
  ["GET", new Set(["/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/ticker/bookTicker", "/fapi/v2/account", "/fapi/v2/positionRisk", "/fapi/v1/positionSide/dual", "/fapi/v1/openOrders", "/fapi/v1/openAlgoOrders", "/fapi/v1/order", "/fapi/v1/algoOrder", "/fapi/v1/userTrades"])],
  ["POST", new Set(["/fapi/v1/order", "/fapi/v1/order/test", "/fapi/v1/algoOrder", "/fapi/v1/leverage"])],
  ["DELETE", new Set(["/fapi/v1/order", "/fapi/v1/algoOrder"])],
]);
const SHADOW_KELLY_STRATEGY_VERSION = "ORION-V3-RESEARCH-MTFX-HF-0.5.0";
const SHADOW_KELLY_REVISION_PATTERN = /^MTFX-V3-HF\d+(?:-|$)/;
const SHADOW_KELLY_MANAGED_CLOSE_REASONS = new Set(["STRATEGY_MANAGED_CLOSE", "ELIGIBLE_OPPOSITE_SIGNAL_REPLACEMENT", "CONFIRMED_PROTECTIVE_STOP"]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function finitePositive(value, code) {
  const number = Number(value);
  invariant(Number.isFinite(number) && number > 0, code);
  return number;
}

function riskEquityFromSignedAccount(account, code = "TESTNET_ACCOUNT_EQUITY_INVALID") {
  return finitePositive(EXECUTION_PROFILE === "ORION_V3" ? account?.totalMarginBalance : account?.totalMarginBalance ?? account?.totalWalletBalance, code);
}

export function cancelUnsubmittedV3PreparedEntry(state, { operationId, preparationId, now, reason }) {
  const operation = state?.pendingOperations?.[operationId];
  invariant(EXECUTION_PROFILE === "ORION_V3" && preparationId && operation?.preparationId === preparationId && operation?.kind === "ENTRY" && operation?.phase === "PREPARED" && operation?.entryOrderId == null && operation?.entryFill == null && operation?.postFillRiskVerificationRequired !== true, "TESTNET_V3_UNSUBMITTED_PREPARATION_IDENTITY_UNKNOWN");
  const nextState = structuredClone(state);
  delete nextState.pendingOperations[operationId];
  nextState.updatedAt = new Date(now).toISOString();
  return {
    nextState,
    event: { schemaVersion: 1, eventType: "BINANCE_DEMO_V3_ENTRY_PREPARATION_CANCELLED_BEFORE_SUBMISSION", occurredAt: nextState.updatedAt, venue: "BINANCE_USDM_TESTNET", symbol: operation.symbol, intentId: operation.input?.intentId ?? null, operationId, preparationId, reason, matchingEnginePostAttempted: false, credentialsRecorded: false, productionHostUsed: false },
  };
}

export function validateV3FourHourEntryGuard(input, now = Date.now()) {
  if (EXECUTION_PROFILE !== "ORION_V3") return null;
  const revision = input?.implementationRevision ?? input?.strategyMetadata?.implementationRevision;
  if (revision === "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE") return null;
  if (!/^MTFX-V3-HF(?:11|13)(?:-|$)/.test(revision ?? "") && !input?.entryGuard?.marketState4h) return null;
  const marketState = input?.entryGuard?.marketState4h ?? input?.strategyMetadata?.marketState4h;
  const direction = String(input?.side).toUpperCase() === "BUY" ? 1 : -1;
  invariant(input?.entryGuard?.marketStateDirection == null || Number(input.entryGuard.marketStateDirection) === direction, "TESTNET_V3_4H_ENTRY_DIRECTION_EVIDENCE_MISMATCH");
  const gate = evaluateFourHourMarketStateGate(marketState, direction, now);
  invariant(gate.orderSubmissionAllowed === true, `TESTNET_V3_4H_ENTRY_GATE_${gate.status}`);
  return structuredClone({ checkedAt: now, marketState4h: marketState, gate });
}

export function validateV3DualZEntryGuard(input, now = Date.now()) {
  if (EXECUTION_PROFILE !== "ORION_V3") return null;
  const metadata = input?.strategyMetadata;
  if (![input?.implementationRevision, metadata?.implementationRevision].some((revision) => /^MTFX-V3-HF13(?:-|$)/.test(revision ?? ""))) return null;
  invariant(input?.implementationRevision === "MTFX-V3-HF13-DUAL-Z-STRUCTURE-GATE" &&
    input?.evaluationCohortId === "ORION-V3-HF13-DUAL-Z-FORWARD-20260914" &&
    metadata?.implementationRevision === input.implementationRevision &&
    metadata?.evaluationCohortId === input.evaluationCohortId, "TESTNET_V3_DUAL_Z_REVISION_OR_COHORT_MISMATCH");
  invariant(Number(input?.entryGuard?.intersectionPrice) === metadata?.intersectionPrice, "TESTNET_V3_DUAL_Z_ENTRY_INTERSECTION_MISMATCH");
  const gate = validateDualZPlanEvidence(metadata, { now });
  invariant(gate.allowed === true, `TESTNET_V3_${gate.reason}`);
  return structuredClone({ checkedAt: now, gate, dualZ: metadata.dualZ });
}

export function validateV3SingleZEntryGuard(input, now = Date.now()) {
  if (EXECUTION_PROFILE !== "ORION_V3") return null;
  const metadata = input?.strategyMetadata;
  if (![input?.implementationRevision, metadata?.implementationRevision].some((revision) => /^MTFX-V3-HF14(?:-|$)/.test(revision ?? ""))) return null;
  invariant(input?.implementationRevision === "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE" &&
    input?.evaluationCohortId === "ORION-V3-HF14-SINGLE-Z-FORWARD-20260914" &&
    metadata?.implementationRevision === input.implementationRevision &&
    metadata?.evaluationCohortId === input.evaluationCohortId, "TESTNET_V3_SINGLE_Z_REVISION_OR_COHORT_MISMATCH");
  invariant(Number(input?.entryGuard?.intersectionPrice) === metadata?.intersectionPrice, "TESTNET_V3_SINGLE_Z_ENTRY_INTERSECTION_MISMATCH");
  invariant(input?.entryGuard?.marketState4h == null && input?.entryGuard?.marketStateDirection == null,
    "TESTNET_V3_HF14_4H_MUST_NOT_BE_ENTRY_INPUT");
  const gate = validateSingleZPlanEvidence(metadata, { now });
  invariant(gate.allowed === true, `TESTNET_V3_${gate.reason}`);
  return structuredClone({ checkedAt: now, gate, singleZ: metadata.singleZ, opposingAnchorEvidence: metadata.anchors?.slice(2) ?? null });
}

export function validateStrategyEntryGuard(entryGuard, referencePrice, now = Date.now()) {
  invariant(entryGuard && typeof entryGuard === "object", "TESTNET_STRATEGY_ENTRY_GUARD_REQUIRED");
  const executablePrice = finitePositive(referencePrice, "TESTNET_BOOK_TICKER_INVALID");
  const intersectionPrice = finitePositive(entryGuard.intersectionPrice, "TESTNET_ENTRY_GUARD_INTERSECTION_INVALID");
  const guardReferencePrice = finitePositive(entryGuard.referencePrice ?? intersectionPrice, "TESTNET_ENTRY_GUARD_REFERENCE_INVALID");
  const maximumDisplacementBps = finitePositive(entryGuard.maximumDisplacementBps, "TESTNET_ENTRY_GUARD_DISPLACEMENT_LIMIT_INVALID");
  const decisionBarCloseTime = finitePositive(entryGuard.decisionBarCloseTime, "TESTNET_ENTRY_GUARD_DECISION_TIME_INVALID");
  const maximumSignalAgeMs = finitePositive(entryGuard.maximumSignalAgeMs, "TESTNET_ENTRY_GUARD_SIGNAL_AGE_INVALID");
  invariant(now >= decisionBarCloseTime, "TESTNET_ENTRY_DECISION_BAR_NOT_CLOSED");
  invariant(now <= decisionBarCloseTime + maximumSignalAgeMs, "TESTNET_ENTRY_SIGNAL_STALE");
  const displacementBps = Math.abs(executablePrice - guardReferencePrice) / guardReferencePrice * 10_000;
  invariant(displacementBps <= maximumDisplacementBps, "TESTNET_ENTRY_DISPLACEMENT_LIMIT");
  return {
    intersectionPrice,
    referencePrice: guardReferencePrice,
    referenceType: entryGuard.referenceType ?? "MATHEMATICAL_INTERSECTION_PRICE",
    executablePrice,
    displacementBps,
    maximumDisplacementBps,
    decisionBarCloseTime,
    maximumSignalAgeMs,
    signalExpiresAt: decisionBarCloseTime + maximumSignalAgeMs,
  };
}

function defaultState() {
  return { schemaVersion: 2, venue: "BINANCE_USDM_TESTNET", managedPositions: {}, managedOrders: {}, pendingOperations: {}, closedPositions: [], updatedAt: null };
}

export function aggregateOrderTradeCost(rows, orderId = null) {
  const trades = (Array.isArray(rows) ? rows : []).filter((row) => orderId === null || String(row.orderId) === String(orderId));
  const commissionByAsset = {};
  for (const trade of trades) {
    const asset = String(trade.commissionAsset ?? "UNKNOWN").toUpperCase();
    commissionByAsset[asset] = Number(commissionByAsset[asset] ?? 0) + Number(trade.commission ?? 0);
  }
  const assets = Object.keys(commissionByAsset);
  const allCommissionInUsdt = trades.length > 0 && assets.every((asset) => asset === "USDT");
  return {
    status: trades.length ? "ACTUAL_BINANCE_DEMO_TRADES" : "NO_MATCHING_TRADES_YET",
    orderId: orderId === null ? null : String(orderId),
    tradeCount: trades.length,
    commissionByAsset,
    commissionUsdt: allCommissionInUsdt ? Number(commissionByAsset.USDT ?? 0) : null,
    allCommissionInUsdt,
    realizedPnlUsdt: trades.reduce((sum, trade) => sum + Number(trade.realizedPnl ?? 0), 0),
    fills: trades.map((trade) => ({
      tradeId: trade.id ?? null,
      price: Number(trade.price ?? 0),
      quantity: Number(trade.qty ?? 0),
      commission: Number(trade.commission ?? 0),
      commissionAsset: trade.commissionAsset ?? null,
      realizedPnlUsdt: Number(trade.realizedPnl ?? 0),
      time: Number(trade.time ?? 0) || null,
    })),
  };
}

function v3ClosedEntryEvidence(managed, finalOrder, reason) {
  if (EXECUTION_PROFILE !== "ORION_V3") return {};
const keys = ["riskPolicyRevision", "riskPolicyAuthorizationId", "marketState4h", "marketStateGateAtSubmission", "entryConfirmationEvidence", "strategyEntryGuard", "entryPreFillRiskEvidence", "entryRiskEvidence", "postFillRiskAssessment", "entryIntegrityIncident", "entryFourHourGateAtSubmission", "entryDualZGateAtSubmission", "entrySingleZGateAtSubmission", "dualZ", "singleZ", "dualZComparison", "firstDiscoveredAt", "entryFillTimeEvidence", "entryObservedAt", "protectionIntegrityFailure"];
  const evidence = Object.fromEntries(keys.filter((key) => Object.hasOwn(managed ?? {}, key)).map((key) => [key, structuredClone(managed[key])]));
  for (const [prefix, cost] of [["entry", managed?.entryTradeCost], ["final", finalOrder?.tradeCost]]) {
    if (Array.isArray(cost?.fills) && cost.fills.length) {
      evidence[`${prefix}Fills`] = structuredClone(cost.fills);
      evidence[`${prefix}TradeIds`] = cost.fills.map((fill) => fill.tradeId).filter((id) => id != null);
    }
  }
  if (["PROTECTIVE_STOP_SUBMISSION_FAILED_ENTRY_ROLLBACK", "UNPROTECTED_ENTRY_ROLLBACK_AFTER_STOP_CROSSED"].includes(reason)) evidence.protectionIntegrityFailure = true;
  return evidence;
}

export function buildClosedPositionOutcome(managed, finalOrder, { now = Date.now(), reason = "STRATEGY_MANAGED_CLOSE", source = "BINANCE_DEMO_ORDER_RESULT" } = {}) {
  const originalQuantity = Number(managed?.originalQuantity ?? managed?.quantity);
  const remainingQuantity = Number(finalOrder?.executedQty ?? managed?.quantity);
  const finalExitPrice = Number(finalOrder?.avgPrice ?? finalOrder?.price);
  const direction = Number(managed?.direction) || (managed?.side === "BUY" ? 1 : -1);
  const entryPrice = Number(managed?.entry ?? managed?.entryPrice);
  const completeFinalFill = finalOrder?.status === "FILLED" && remainingQuantity > 0 && finalExitPrice > 0;
  const finalEntryFeeAllocated = completeFinalFill && originalQuantity > 0
    ? Number(managed?.entryFee ?? 0) * remainingQuantity / originalQuantity
    : null;
  const actualFinalCommission = Number(finalOrder?.tradeCost?.commissionUsdt);
  const actualFinalRealizedPnl = Number(finalOrder?.tradeCost?.realizedPnlUsdt);
  const hasActualFinalRealizedPnl = Number(finalOrder?.tradeCost?.tradeCount) > 0 && Number.isFinite(actualFinalRealizedPnl);
  const finalExitFee = completeFinalFill
    ? (finalOrder?.tradeCost?.allCommissionInUsdt === true && Number.isFinite(actualFinalCommission)
      ? actualFinalCommission
      : finalExitPrice * remainingQuantity * TESTNET_RISK_LIMITS.takerFeeRate)
    : null;
  const finalGrossPnl = completeFinalFill
    ? (hasActualFinalRealizedPnl ? actualFinalRealizedPnl : direction * (finalExitPrice - entryPrice) * remainingQuantity)
    : null;
  const finalNetPnl = completeFinalFill ? finalGrossPnl - finalEntryFeeAllocated - finalExitFee : null;
  const netPnl = completeFinalFill ? Number(managed?.cumulativeRealizedNetPnl ?? 0) + finalNetPnl : null;
  const initialPlannedRiskUsdt = Number(managed?.initialPlannedRiskUsdt);
  const realizedR = completeFinalFill && initialPlannedRiskUsdt > 0 ? netPnl / initialPlannedRiskUsdt : null;
  const entryCommissionUsdt = Number(managed?.entryFee ?? 0);
  const partialExitCommissionUsdt = Number(managed?.cumulativeExitFee ?? 0);
  const totalCommissionUsdt = completeFinalFill ? entryCommissionUsdt + partialExitCommissionUsdt + finalExitFee : null;
  const entryNotionalUsdt = entryPrice * originalQuantity;
  const finalExitNotionalUsdt = completeFinalFill ? finalExitPrice * remainingQuantity : null;
  const partialFeeEvidenceComplete = (managed?.partialExits ?? []).every((row) => row.feeEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES");
  const actualCommissionEvidenceComplete = completeFinalFill && managed?.entryFeeEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES" &&
    finalOrder?.tradeCost?.allCommissionInUsdt === true && partialFeeEvidenceComplete;
  const partialRealizedPnlEvidenceComplete = (managed?.partialExits ?? []).every((row) => row.realizedPnlEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES");
  const exchangeRealizedPnlEvidenceComplete = completeFinalFill && hasActualFinalRealizedPnl && partialRealizedPnlEvidenceComplete;
  const exchangeRealizedPnlUsdt = completeFinalFill
    ? Number(managed?.entryTradeCost?.realizedPnlUsdt ?? 0) + Number(managed?.cumulativeGrossPnl ?? 0) + finalGrossPnl
    : null;
  const strategyManagedReason = SHADOW_KELLY_MANAGED_CLOSE_REASONS.has(reason);
  const shadowKellyEligible = completeFinalFill &&
    managed?.strategyVersion === SHADOW_KELLY_STRATEGY_VERSION &&
    SHADOW_KELLY_REVISION_PATTERN.test(managed?.implementationRevision ?? "") &&
    actualCommissionEvidenceComplete &&
    exchangeRealizedPnlEvidenceComplete &&
    Number.isFinite(realizedR) &&
    strategyManagedReason;
  const exclusionReasons = [];
  if (!completeFinalFill) exclusionReasons.push("MISSING_FINAL_FILL");
  if (managed?.strategyVersion !== SHADOW_KELLY_STRATEGY_VERSION) exclusionReasons.push("OTHER_STRATEGY_FAMILY");
  if (!SHADOW_KELLY_REVISION_PATTERN.test(managed?.implementationRevision ?? "")) exclusionReasons.push("UNKNOWN_OR_NON_V3_HF_REVISION");
  if (!exchangeRealizedPnlEvidenceComplete) exclusionReasons.push("MISSING_ACTUAL_REALIZED_PNL_EVIDENCE");
  if (!actualCommissionEvidenceComplete) exclusionReasons.push("MISSING_ACTUAL_COMMISSION_EVIDENCE");
  if (!strategyManagedReason) exclusionReasons.push("EXTERNAL_OR_UNMANAGED_CLOSE");
  if (!(initialPlannedRiskUsdt > 0)) exclusionReasons.push("MISSING_INITIAL_RISK");
  return {
    schemaVersion: 1,
    outcomeId: `${PROFILE.outcomePrefix}_${sha256(stableStringify({
      intentId: managed?.intentId,
      symbol: managed?.symbol,
      openedAt: managed?.openedAt,
      finalOrderId: finalOrder?.orderId ?? null,
      finalClientOrderId: finalOrder?.clientOrderId ?? finalOrder?.origClientOrderId ?? null,
      reason,
    })).slice(0, 24)}`,
    venue: "BINANCE_USDM_TESTNET",
    symbol: managed?.symbol ?? null,
    intentId: managed?.intentId ?? null,
    planId: managed?.planId ?? null,
    pattern: managed?.pattern ?? null,
    strategyVersion: managed?.strategyVersion ?? null,
    implementationRevision: managed?.implementationRevision ?? null,
    evaluationCohortId: managed?.evaluationCohortId ?? PROFILE.defaultEvaluationCohortId,
    intersectionTime: managed?.intersectionTime ?? null,
    intersectionPrice: managed?.intersectionPrice ?? null,
    decisionBarOpenTime: managed?.decisionBarOpenTime ?? null,
    decisionBarCloseTime: managed?.decisionBarCloseTime ?? null,
    decisionClose: managed?.decisionClose ?? null,
    maximumEntryDisplacementBps: managed?.maximumEntryDisplacementBps ?? null,
    maximumEntrySignalAgeMs: managed?.maximumEntrySignalAgeMs ?? null,
    entryGuardAtSubmission: managed?.entryGuardAtSubmission ?? null,
    primaryLineStatus: managed?.primaryLineStatus ?? null,
    anchorConsensus: managed?.anchorConsensus ?? null,
    intersectionRange: managed?.intersectionRange ?? null,
    intersectionQuality: managed?.intersectionQuality ?? null,
    anchors: managed?.anchors ?? null,
    scale: managed?.scale ?? null,
    structureLineage: managed?.structureLineage ?? null,
    reentryLineageGuardAtSubmission: managed?.reentryLineageGuardAtSubmission ?? null,
    ...v3ClosedEntryEvidence(managed, finalOrder, reason),
    direction,
    openedAt: managed?.openedAt ?? null,
    closedAt: now,
    closeReason: reason,
    source,
    entryPrice,
    entryOrderId: managed?.entryOrderId ?? null,
    finalExitPrice: completeFinalFill ? finalExitPrice : null,
    originalQuantity,
    finalExitQuantity: completeFinalFill ? remainingQuantity : null,
    initialPlannedRiskUsdt,
    cumulativePartialNetPnl: Number(managed?.cumulativeRealizedNetPnl ?? 0),
    exchangeRealizedPnlUsdt,
    exchangeRealizedPnlEvidenceComplete,
    finalNetPnl,
    netPnl,
    realizedR,
    entryCommissionUsdt,
    entryCommissionRate: entryNotionalUsdt > 0 ? entryCommissionUsdt / entryNotionalUsdt : null,
    partialExitCommissionUsdt,
    finalExitCommissionUsdt: finalExitFee,
    finalExitCommissionRate: finalExitNotionalUsdt > 0 ? finalExitFee / finalExitNotionalUsdt : null,
    totalCommissionUsdt,
    entryCommissionByAsset: managed?.entryTradeCost?.commissionByAsset ?? { USDT: entryCommissionUsdt },
    finalExitCommissionByAsset: finalOrder?.tradeCost?.commissionByAsset ?? (finalExitFee === null ? {} : { USDT: finalExitFee }),
    actualCommissionEvidenceComplete,
    feeEvidence: actualCommissionEvidenceComplete ? "ACTUAL_BINANCE_DEMO_USER_TRADES" : "MIXED_OR_CONSERVATIVE_MODEL",
    partialExits: managed?.partialExits ?? [],
    finalOrderId: finalOrder?.orderId ?? null,
    finalClientOrderId: finalOrder?.clientOrderId ?? finalOrder?.origClientOrderId ?? null,
    completeFinalFill,
    shadowKellyEligible,
    shadowKellyExclusionReasons: shadowKellyEligible ? [] : exclusionReasons,
    costEvidence: completeFinalFill
      ? (actualCommissionEvidenceComplete && exchangeRealizedPnlEvidenceComplete ? "ACTUAL_BINANCE_DEMO_REALIZED_PNL_AND_COMMISSIONS" : actualCommissionEvidenceComplete ? "ACTUAL_FILL_PRICES_AND_BINANCE_DEMO_COMMISSIONS" : "ACTUAL_FILL_PRICES_PLUS_AUTHORIZED_TAKER_FEE_MODEL")
      : "INCOMPLETE",
  };
}

function appendClosedOutcome(state, outcome) {
  const existing = new Set((state.closedPositions ?? []).map((row) => row.outcomeId));
  return existing.has(outcome.outcomeId) ? [...(state.closedPositions ?? [])] : [...(state.closedPositions ?? []), outcome].slice(-10000);
}

export function assertTradingBaseUrl(value = TESTNET_BASE_URL) {
  return assertTestnetBaseUrl(value);
}

export function assertTradingRequest(method, pathname) {
  const normalizedMethod = String(method ?? "").toUpperCase();
  invariant(ALLOWED_REQUESTS.get(normalizedMethod)?.has(pathname) === true, "TESTNET_TRADING_REQUEST_NOT_ALLOWLISTED");
  return { method: normalizedMethod, pathname };
}

export function normalizeTestnetSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  invariant(OWNER_APPROVED_TESTNET_SYMBOLS.includes(symbol), "TESTNET_SYMBOL_OUTSIDE_OWNER_APPROVED_UNIVERSE");
  return symbol;
}

export function normalizeIntentId(value) {
  const intentId = String(value ?? "").trim();
  invariant(/^[A-Za-z0-9._:-]{8,128}$/.test(intentId), "TESTNET_INTENT_ID_INVALID");
  return intentId;
}

export function deterministicClientOrderId(intentId, suffix = "entry") {
  const normalized = normalizeIntentId(intentId);
  const normalizedSuffix = String(suffix).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 8);
  return `aegis_${normalizedSuffix}_${sha256(normalized).slice(0, 20)}`.slice(0, 36);
}

export function createSignedTradingRequest(method, pathname, params, credentials, now = Date.now()) {
  const allowed = assertTradingRequest(method, pathname);
  invariant(typeof credentials?.apiKey === "string" && credentials.apiKey.length >= 8, "TESTNET_API_KEY_INVALID");
  invariant(typeof credentials?.apiSecret === "string" && credentials.apiSecret.length >= 16, "TESTNET_API_SECRET_INVALID");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, typeof value === "boolean" ? String(value) : String(value));
  }
  query.set("recvWindow", "5000");
  query.set("timestamp", String(now));
  const signature = crypto.createHmac("sha256", credentials.apiSecret).update(query.toString()).digest("hex");
  query.set("signature", signature);
  const url = assertTradingBaseUrl();
  url.pathname = pathname;
  url.search = query.toString();
  return {
    url: url.toString(),
    options: {
      method: allowed.method,
      redirect: "error",
      headers: {
        "X-MBX-APIKEY": credentials.apiKey,
        "user-agent": PROFILE.userAgent,
      },
    },
  };
}

async function loadAuthorization() {
  const universeAuthorization = await readJson(TIERED_SCAN_UNIVERSE_AUTHORIZATION_PATH);
  if (EXECUTION_PROFILE === "ORION_V4") {
    const [platformAuthorization, strategyAuthorization, riskPolicyAuthorization] = await Promise.all([
      readJson(V4_EXECUTION_AUTHORIZATION_PATH), readJson(V4_STRATEGY_AUTHORIZATION_PATH), readJson(V4_RISK_POLICY_AUTHORIZATION_PATH),
    ]);
    invariant(platformAuthorization?.id === "OWNER-DIRECTIVE-ORION-V4-BINANCE-USDM-DEMO-EXECUTION-PLATFORM-PARITY-20260820", "V4_TESTNET_TRADING_AUTHORIZATION_INVALID");
    invariant(["ACTIVE_AWAITING_DEDICATED_CREDENTIAL_PROVISIONING", "ACTIVE_PLATFORM_READY_AWAITING_STRATEGY_ACTIVATION", "ACTIVE_EXECUTION_PLATFORM_READY_STRATEGY_FAIL_CLOSED", "ACTIVE"].includes(platformAuthorization?.status), "V4_TESTNET_TRADING_AUTHORIZATION_INACTIVE");
    invariant(platformAuthorization?.scope?.fixedBaseUrl === TESTNET_BASE_URL, "V4_TESTNET_TRADING_AUTHORIZATION_HOST_MISMATCH");
    invariant(platformAuthorization?.permissions?.orderEndpointCapabilityPrepared === true, "V4_TESTNET_ORDER_CAPABILITY_NOT_AUTHORIZED");
    invariant(strategyAuthorization?.status === "ACTIVE" && strategyAuthorization?.id === "OWNER-DIRECTIVE-ORION-V4-MTFX-R22-V2-FULL-RULE-PARITY-20260829", "V4_MTFX_STRATEGY_AUTHORIZATION_INVALID");
    invariant(strategyAuthorization?.executionScope?.startupAllowedNow === true, "V4_MTFX_STARTUP_NOT_AUTHORIZED");
    invariant(Array.isArray(strategyAuthorization?.executionScope?.fixedUniverse) && OWNER_APPROVED_TESTNET_SYMBOLS.every((symbol) => strategyAuthorization.executionScope.fixedUniverse.includes(symbol)), "V4_MTFX_UNIVERSE_INVALID");
    invariant(strategyAuthorization?.hardRisk?.maximumRiskPerEntryFraction === TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction && strategyAuthorization?.hardRisk?.maximumManagedPortfolioRiskFraction === TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "V4_MTFX_BASE_RISK_AUTHORIZATION_MUTATED");
    invariant(strategyAuthorization?.hardRisk?.maximumEffectiveNotionalLeverage === TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage, "V4_TESTNET_LEVERAGE_RISK_AUTHORIZATION_MISMATCH");
    invariant(riskPolicyAuthorization?.id === strategyAuthorization.id && riskPolicyAuthorization?.riskPolicy?.authorizationId === strategyAuthorization.id, "V4_TESTNET_RISK_POLICY_AUTHORIZATION_INVALID");
    invariant(riskPolicyAuthorization?.riskPolicy?.revision === "V4-RISK-V2-PARITY-1PCT-5PCT-20260829", "V4_TESTNET_RISK_POLICY_REVISION_INVALID");
    invariant(riskPolicyAuthorization?.riskPolicy?.maximumRiskPerEntryFraction === TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction, "V4_TESTNET_PER_ENTRY_RISK_AUTHORIZATION_MISMATCH");
    invariant(riskPolicyAuthorization?.riskPolicy?.maximumManagedPortfolioRiskFraction === TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "V4_TESTNET_PORTFOLIO_RISK_AUTHORIZATION_MISMATCH");
    invariant(riskPolicyAuthorization?.riskPolicy?.riskSizingUtilizationFraction === TESTNET_RISK_LIMITS.riskSizingUtilizationFraction, "V4_TESTNET_RISK_UTILIZATION_AUTHORIZATION_MISMATCH");
    invariant(riskPolicyAuthorization?.riskPolicy?.maximumEffectiveNotionalLeverage === TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage, "V4_TESTNET_SUPPLEMENTAL_LEVERAGE_MISMATCH");
    return riskPolicyAuthorization;
  }
  invariant(universeAuthorization?.id === PROFILE.universeAuthorizationId && universeAuthorization?.status === "ACTIVE", "TESTNET_UNIVERSE30_AUTHORIZATION_INVALID");
  invariant(universeAuthorization?.sharedUniverse?.selection === "FIXED_OWNER_APPROVED_BINANCE_DEMO_30", "TESTNET_UNIVERSE30_SELECTION_INVALID");
  invariant(Array.isArray(universeAuthorization?.sharedUniverse?.symbols) && universeAuthorization.sharedUniverse.symbols.length === 30, "TESTNET_UNIVERSE30_SIZE_INVALID");
  invariant(OWNER_APPROVED_TESTNET_SYMBOLS.every((symbol) => universeAuthorization.sharedUniverse.symbols.includes(symbol)), "TESTNET_UNIVERSE30_SYMBOL_MISMATCH");
  invariant(universeAuthorization?.hardRiskUnchanged?.maximumRiskPerEntryFraction === TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction && universeAuthorization?.hardRiskUnchanged?.maximumManagedPortfolioRiskFraction === TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "TESTNET_UNIVERSE30_RISK_EXPANSION_FORBIDDEN");
  invariant(universeAuthorization?.isolation?.productionHostsAllowed === false && universeAuthorization?.isolation?.realOrdersAllowed === false, "TESTNET_UNIVERSE30_PRODUCTION_BOUNDARY_INVALID");
  const [authorization, algoStopAuthorization, feeLedgerAuthorization, leverageAlignmentAuthorization, riskPolicyAuthorization] = await Promise.all([
    readJson(TRADING_AUTHORIZATION_PATH),
    readJson(ALGO_STOP_AUTHORIZATION_PATH),
    readJson(FEE_LEDGER_AUTHORIZATION_PATH),
    readJson(LEVERAGE_ALIGNMENT_AUTHORIZATION_PATH),
    readJson(RISK_POLICY_AUTHORIZATION_PATH),
  ]);
  invariant(authorization?.id === "OWNER-DIRECTIVE-ORION-V3-BINANCE-USDM-DEMO-IMMEDIATE-TRADING-CUTOVER-20260818", "TESTNET_TRADING_AUTHORIZATION_INVALID");
  invariant(authorization?.status === "ACTIVE_ON_DEMAND_BINANCE_DEMO_TRADING", "TESTNET_TRADING_AUTHORIZATION_INACTIVE");
  invariant(authorization?.venueAndMethods?.fixedBaseUrl === TESTNET_BASE_URL, "TESTNET_TRADING_AUTHORIZATION_HOST_MISMATCH");
  invariant(authorization?.venueAndMethods?.realOrdersAllowed === false && authorization?.activation?.allowedNow === true, "TESTNET_TRADING_AUTHORIZATION_SCOPE_INVALID");
  invariant(algoStopAuthorization?.id === "OWNER-DIRECTIVE-ORION-V3-BINANCE-USDM-DEMO-ALGO-STOP-ADAPTER-20260818", "TESTNET_ALGO_STOP_AUTHORIZATION_INVALID");
  invariant(algoStopAuthorization?.status === "ACTIVE", "TESTNET_ALGO_STOP_AUTHORIZATION_INACTIVE");
  invariant(algoStopAuthorization?.appliesTo?.fixedBaseUrl === TESTNET_BASE_URL, "TESTNET_ALGO_STOP_AUTHORIZATION_HOST_MISMATCH");
  invariant(algoStopAuthorization?.executionAdapterCorrection?.protectiveConditionalOrderEndpoint === "POST /fapi/v1/algoOrder", "TESTNET_ALGO_STOP_ENDPOINT_NOT_AUTHORIZED");
  invariant(algoStopAuthorization?.hardRiskUnchanged?.maximumRiskPerEntryFraction === 0.005, "TESTNET_ALGO_STOP_HISTORICAL_RISK_SCOPE_INVALID");
  invariant(feeLedgerAuthorization?.id === "OWNER-DIRECTIVE-ORION-V3-FEE-LEDGER-PRESENTATION-20260818", "TESTNET_FEE_LEDGER_AUTHORIZATION_INVALID");
  invariant(feeLedgerAuthorization?.status === "ACTIVE", "TESTNET_FEE_LEDGER_AUTHORIZATION_INACTIVE");
  invariant(feeLedgerAuthorization?.permissions?.endpoint === "GET /fapi/v1/userTrades", "TESTNET_FEE_LEDGER_ENDPOINT_NOT_AUTHORIZED");
  invariant(leverageAlignmentAuthorization?.id === "OWNER-DIRECTIVE-ORION-V3-BINANCE-DEMO-LEVERAGE-ALIGNMENT-10X-20260819", "TESTNET_LEVERAGE_ALIGNMENT_AUTHORIZATION_INVALID");
  invariant(leverageAlignmentAuthorization?.status === "ACTIVE", "TESTNET_LEVERAGE_ALIGNMENT_AUTHORIZATION_INACTIVE");
  invariant(leverageAlignmentAuthorization?.scope?.fixedBaseUrl === TESTNET_BASE_URL, "TESTNET_LEVERAGE_ALIGNMENT_HOST_MISMATCH");
  invariant(leverageAlignmentAuthorization?.scope?.allowedEndpoint === "POST /fapi/v1/leverage", "TESTNET_LEVERAGE_ALIGNMENT_ENDPOINT_NOT_AUTHORIZED");
  invariant(leverageAlignmentAuthorization?.scope?.targetInitialLeverage === TESTNET_INITIAL_LEVERAGE, "TESTNET_LEVERAGE_ALIGNMENT_TARGET_INVALID");
  invariant(universeAuthorization?.v3?.targetInitialLeverage === TESTNET_INITIAL_LEVERAGE, "TESTNET_UNIVERSE30_LEVERAGE_INVALID");
  invariant(riskPolicyAuthorization?.id === "OWNER-DIRECTIVE-ORION-V3-AGGRESSIVE-GROWTH-RISK-1PCT-10PCT-20260820", "TESTNET_RISK_POLICY_AUTHORIZATION_INVALID");
  invariant(riskPolicyAuthorization?.status === "ACTIVE", "TESTNET_RISK_POLICY_AUTHORIZATION_INACTIVE");
  invariant(riskPolicyAuthorization?.scope?.fixedBaseUrl === TESTNET_BASE_URL, "TESTNET_RISK_POLICY_HOST_MISMATCH");
  invariant(riskPolicyAuthorization?.scope?.maximumRiskPerEntryFraction === TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction, "TESTNET_PER_ENTRY_RISK_AUTHORIZATION_MISMATCH");
  invariant(riskPolicyAuthorization?.scope?.maximumManagedPortfolioRiskFraction === TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "TESTNET_PORTFOLIO_RISK_AUTHORIZATION_MISMATCH");
  invariant(riskPolicyAuthorization?.unchangedHardBoundaries?.maximumEffectiveNotionalLeverage === TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage, "TESTNET_LEVERAGE_RISK_AUTHORIZATION_MISMATCH");
  return authorization;
}

async function assertMatchingEngineActivation() {
  if (EXECUTION_PROFILE !== "ORION_V4") return true;
  const current = await readJson(path.join(ROOT, "governance", "current-state.json"));
  const governed = current?.orionV4RangeResearch ?? {};
  invariant(governed.strategyExecutionActivationStatus === "ACTIVE_OWNER_AUTHORIZED_V4_STRATEGY", "V4_STRATEGY_NOT_ACTIVATED_MATCHING_ENGINE_FAIL_CLOSED");
  invariant(governed.matchingEngineOrderSubmissionAllowed === true, "V4_MATCHING_ENGINE_ORDER_SUBMISSION_NOT_AUTHORIZED");
  invariant(typeof governed.activeExecutionStrategyRevision === "string" && governed.activeExecutionStrategyRevision.length > 0, "V4_ACTIVE_EXECUTION_STRATEGY_REVISION_MISSING");
  invariant(governed.riskPolicy?.authorizationId === "OWNER-DIRECTIVE-ORION-V4-MTFX-R22-V2-FULL-RULE-PARITY-20260829", "V4_ACTIVE_RISK_POLICY_MISSING");
  invariant(governed.executionPlatformHardRiskCeiling?.maximumRiskPerEntryFraction === TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction && governed.executionPlatformHardRiskCeiling?.maximumManagedPortfolioRiskFraction === TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "V4_ACTIVE_RISK_CEILING_MISMATCH");
  return true;
}

class BinanceRequestError extends Error {
  constructor(status, body) {
    super(`BINANCE_TESTNET_HTTP_${status}_${body?.code ?? "UNKNOWN"}`);
    this.name = "BinanceRequestError";
    this.status = status;
    this.binanceCode = Number(body?.code);
    this.binanceMessage = typeof body?.msg === "string" ? body.msg : null;
  }
}

async function requestJson(method, pathname, params, credentials, { fetchImpl = fetch, now = Date.now(), timestampRetry = true, readRetry = true } = {}) {
  const request = createSignedTradingRequest(method, pathname, params, credentials, now);
  let response;
  let body;
  try {
    response = await fetchImpl(request.url, { ...request.options, signal: AbortSignal.timeout(8_000) });
    body = await response.json();
  } catch (error) {
    if (method === "GET" && readRetry) return requestJson(method, pathname, params, credentials, { fetchImpl, now: Date.now(), timestampRetry, readRetry: false });
    throw error;
  }
  if (!response.ok) {
    if (method === "GET" && readRetry && (response.status === 429 || response.status >= 500)) {
      return requestJson(method, pathname, params, credentials, { fetchImpl, now: Date.now(), timestampRetry, readRetry: false });
    }
    if (timestampRetry && Number(body?.code) === -1021) {
      const serverTime = await publicJson("/fapi/v1/time", {}, { fetchImpl });
      const correctedNow = Number(serverTime?.serverTime);
      invariant(Number.isFinite(correctedNow) && correctedNow > 0, "TESTNET_SERVER_TIME_INVALID");
      return requestJson(method, pathname, params, credentials, { fetchImpl, now: correctedNow, timestampRetry: false, readRetry });
    }
    throw new BinanceRequestError(response.status, body);
  }
  return body;
}

async function publicJson(pathname, params, { fetchImpl = fetch, readRetry = true } = {}) {
  assertTradingRequest("GET", pathname);
  const url = assertTradingBaseUrl();
  url.pathname = pathname;
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  let response;
  let body;
  try {
    response = await fetchImpl(url.toString(), { method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000) });
    body = await response.json();
  } catch (error) {
    if (readRetry) return publicJson(pathname, params, { fetchImpl, readRetry: false });
    throw error;
  }
  if (!response.ok) {
    if (readRetry && (response.status === 429 || response.status >= 500)) return publicJson(pathname, params, { fetchImpl, readRetry: false });
    throw new BinanceRequestError(response.status, body);
  }
  return body;
}

export async function queryOrderTradeCost({ symbol, orderId }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now() } = {}) {
  await loadAuthorization();
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  invariant(orderId !== undefined && orderId !== null && String(orderId).length > 0, "TESTNET_ORDER_ID_REQUIRED_FOR_FEE_LEDGER");
  const rows = await requestJson("GET", "/fapi/v1/userTrades", { symbol: normalizedSymbol, orderId, limit: 1000 }, credentials, { fetchImpl, now });
  return aggregateOrderTradeCost(rows, orderId);
}

async function safeOrderTradeCost(symbol, orderId, credentials, options) {
  if (orderId === undefined || orderId === null || String(orderId).length === 0) {
    return { status: "ORDER_ID_UNAVAILABLE", orderId: null, tradeCount: 0, commissionByAsset: {}, commissionUsdt: null, allCommissionInUsdt: false, realizedPnlUsdt: 0, fills: [] };
  }
  try {
    return await queryOrderTradeCost({ symbol, orderId }, { credentials, ...options });
  } catch (error) {
    return {
      status: "BINANCE_DEMO_TRADE_COST_TEMPORARILY_UNAVAILABLE",
      orderId: String(orderId),
      tradeCount: 0,
      commissionByAsset: {},
      commissionUsdt: null,
      allCommissionInUsdt: false,
      realizedPnlUsdt: 0,
      fills: [],
      errorCode: error?.message ?? String(error),
    };
  }
}

function checkConfirmation(value) {
  invariant(value === TESTNET_CONFIRMATION, "TESTNET_LITERAL_CONFIRMATION_REQUIRED");
}

function filterFor(symbolInfo, type) {
  return symbolInfo?.filters?.find((filter) => filter.filterType === type) ?? null;
}

function aligned(value, step) {
  if (!(step > 0)) return true;
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-8;
}

export function validateMarketQuantity({ exchangeInfo, symbol, quantity, referencePrice }) {
  const symbolInfo = exchangeInfo?.symbols?.find((row) => row.symbol === symbol);
  invariant(symbolInfo?.status === "TRADING", "TESTNET_SYMBOL_NOT_TRADING");
  const marketLot = filterFor(symbolInfo, "MARKET_LOT_SIZE") ?? filterFor(symbolInfo, "LOT_SIZE");
  const minQty = Number(marketLot?.minQty ?? 0);
  const maxQty = Number(marketLot?.maxQty ?? Number.POSITIVE_INFINITY);
  const stepSize = Number(marketLot?.stepSize ?? 0);
  invariant(quantity >= minQty && quantity <= maxQty && aligned(quantity, stepSize), "TESTNET_QUANTITY_FILTER_REJECTED");
  const minimumNotional = Number(filterFor(symbolInfo, "MIN_NOTIONAL")?.notional ?? 0);
  invariant(quantity * referencePrice >= minimumNotional, "TESTNET_MIN_NOTIONAL_REJECTED");
  return { minQty, maxQty, stepSize, minimumNotional };
}

function nonFlatPositions(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => Math.abs(Number(row.positionAmt)) > 1e-12);
}

export function assertSupportedAccountMode(account, positions, positionMode = null) {
  invariant(account?.multiAssetsMargin === false, "TESTNET_MULTI_ASSET_MARGIN_MODE_UNSUPPORTED");
  invariant(positionMode?.dualSidePosition === false, "TESTNET_HEDGE_POSITION_MODE_UNSUPPORTED");
  for (const position of nonFlatPositions(positions)) {
    invariant(position?.positionSide === "BOTH", "TESTNET_HEDGE_POSITION_MODE_UNSUPPORTED");
  }
  return true;
}

function assertOneWayPositionRows(positions) {
  for (const position of nonFlatPositions(positions)) {
    invariant(position?.positionSide === "BOTH", "TESTNET_HEDGE_POSITION_MODE_UNSUPPORTED");
  }
}

export function evaluateManagedExchangeReconciliation({ accountMode, positions, openOrders, openAlgoOrders, managedState }) {
  const errors = [];
  const managedPositions = managedState?.managedPositions ?? {};
  const liveBySymbol = new Map((Array.isArray(positions) ? positions : []).map((row) => [row.symbol, row]));
  const activeAlgo = (Array.isArray(openAlgoOrders) ? openAlgoOrders : []).filter((row) => ["NEW", "PENDING_NEW"].includes(String(row?.algoStatus ?? row?.status)));
  const referencedAlgoIds = new Set(Object.values(managedPositions).map((row) => row?.stopClientOrderId).filter(Boolean));
  const protection = [];

  if (accountMode?.multiAssetsMargin !== false) errors.push("TESTNET_MULTI_ASSET_MARGIN_MODE_UNSUPPORTED");
  if (accountMode?.oneWayPositionModeObserved !== true) errors.push("TESTNET_HEDGE_POSITION_MODE_UNSUPPORTED");
  for (const order of Array.isArray(openOrders) ? openOrders : []) {
    errors.push(`TESTNET_UNEXPECTED_STANDARD_OPEN_ORDER_${order.symbol ?? "UNKNOWN"}_${order.clientOrderId ?? order.orderId ?? "UNKNOWN"}`);
  }
  for (const live of liveBySymbol.values()) {
    const managed = managedPositions[live.symbol];
    if (!managed) {
      errors.push(`TESTNET_UNMANAGED_EXISTING_POSITION_${live.symbol}`);
      continue;
    }
    const managedDirection = Number(managed.direction) || (managed.side === "BUY" ? 1 : -1);
    const liveDirection = live.side === "SHORT" ? -1 : 1;
    if (managedDirection !== liveDirection) errors.push(`TESTNET_MANAGED_POSITION_DIRECTION_MISMATCH_${live.symbol}`);
    if (Math.abs(Number(managed.quantity ?? managed.remainingQuantity) - Number(live.quantity)) > 1e-8) {
      errors.push(`TESTNET_MANAGED_POSITION_QUANTITY_MISMATCH_${live.symbol}`);
    }
    const stops = activeAlgo.filter((row) => row.clientAlgoId === managed.stopClientOrderId);
    if (stops.length !== 1) {
      errors.push(`TESTNET_PROTECTIVE_STOP_COUNT_${live.symbol}_${stops.length}`);
      protection.push({ symbol: live.symbol, status: stops.length ? "DUPLICATE" : "MISSING", stopClientOrderId: managed.stopClientOrderId ?? null });
      continue;
    }
    const stop = stops[0];
    const expectedSide = liveDirection === 1 ? "SELL" : "BUY";
    const stopMismatch = stop.symbol !== live.symbol || stop.side !== expectedSide || stop.positionSide !== "BOTH" ||
      stop.closePosition !== true || stop.workingType !== "MARK_PRICE" || stop.priceProtect !== true ||
      Math.abs(Number(stop.triggerPrice) - Number(managed.stopPrice ?? managed.stop)) > 1e-8;
    if (stopMismatch) errors.push(`TESTNET_PROTECTIVE_STOP_FIELD_MISMATCH_${live.symbol}`);
    protection.push({
      symbol: live.symbol,
      status: stopMismatch ? "FIELD_MISMATCH" : "PROTECTED",
      stopClientOrderId: stop.clientAlgoId,
      stopOrderId: stop.algoId ?? null,
      triggerPrice: Number(stop.triggerPrice),
    });
  }
  const managedAbsentOnExchange = Object.keys(managedPositions).filter((symbol) => !liveBySymbol.has(symbol));
  for (const order of activeAlgo) {
    if (!referencedAlgoIds.has(order.clientAlgoId)) {
      errors.push(`TESTNET_UNMANAGED_OPEN_ALGO_ORDER_${order.symbol ?? "UNKNOWN"}_${order.clientAlgoId ?? order.algoId ?? "UNKNOWN"}`);
    }
  }
  return {
    status: errors.length ? "FAIL_CLOSED" : "RECONCILED",
    checkedAt: new Date().toISOString(),
    errors,
    livePositionCount: liveBySymbol.size,
    managedPositionCount: Object.keys(managedPositions).length,
    standardOpenOrderCount: Array.isArray(openOrders) ? openOrders.length : 0,
    activeAlgoOrderCount: activeAlgo.length,
    protectedPositionCount: protection.filter((row) => row.status === "PROTECTED").length,
    protection,
    managedAbsentOnExchange,
    pendingOperationCount: Object.keys(managedState?.pendingOperations ?? {}).length,
  };
}

export function assertSymbolFlatAfterManagedClose(rows, symbol) {
  invariant(!nonFlatPositions(rows).some((position) => position.symbol === symbol), "TESTNET_MANAGED_CLOSE_NOT_FLAT");
  return true;
}

function positionNotional(row) {
  return Math.abs(Number(row.positionAmt)) * Math.abs(Number(row.markPrice));
}

function managedPortfolioRisk(state) {
  return Object.values(state.managedPositions ?? {}).reduce((sum, position) => sum + Number(position.plannedRiskUsdt ?? 0), 0);
}

function floorToStep(value, step) {
  if (!(step > 0)) return value;
  return Math.floor((value + step * 1e-9) / step) * step;
}

function decimalPlaces(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.replace(/0+$/, "").split(".")[1]?.length ?? 0 : 0;
}

function stepFormatted(value, step) {
  const places = decimalPlaces(step);
  return Number(value).toFixed(places);
}

function stopToTick(value, tick, direction) {
  if (!(tick > 0)) return value;
  const rounded = direction === 1
    ? Math.ceil((value - tick * 1e-9) / tick) * tick
    : Math.floor((value + tick * 1e-9) / tick) * tick;
  return Number(stepFormatted(rounded, tick));
}

function protectiveStopForSymbol({ exchangeInfo, symbol, stopPrice, direction, referencePrice }) {
  const symbolInfo = exchangeInfo?.symbols?.find((row) => row.symbol === symbol);
  const priceFilter = filterFor(symbolInfo, "PRICE_FILTER");
  const tickSize = Number(priceFilter?.tickSize ?? 0);
  const normalized = stopToTick(finitePositive(stopPrice, "TESTNET_STOP_PRICE_INVALID"), tickSize, direction);
  invariant(normalized >= Number(priceFilter?.minPrice ?? 0), "TESTNET_STOP_PRICE_BELOW_MINIMUM");
  invariant(normalized <= Number(priceFilter?.maxPrice ?? Number.POSITIVE_INFINITY), "TESTNET_STOP_PRICE_ABOVE_MAXIMUM");
  invariant(direction === 1 ? normalized < referencePrice : normalized > referencePrice, "TESTNET_STOP_NOT_PROTECTIVE");
  return {
    stopPrice: normalized,
    priceTickSize: tickSize,
    stopPriceParam: stepFormatted(normalized, tickSize),
  };
}

export function calculateRiskSizedQuantity({ equity, referencePrice, stopPrice, existingNotional = 0, managedRiskUsdt = 0, exchangeInfo, symbol }) {
  const normalizedEquity = finitePositive(equity, "TESTNET_ACCOUNT_EQUITY_INVALID");
  const normalizedPrice = finitePositive(referencePrice, "TESTNET_BOOK_TICKER_INVALID");
  const normalizedStop = finitePositive(stopPrice, "TESTNET_STOP_PRICE_INVALID");
  const hardRiskBudget = Math.min(
    normalizedEquity * TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction,
    normalizedEquity * TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction - Number(managedRiskUsdt),
  );
  const riskBudget = hardRiskBudget * TESTNET_RISK_LIMITS.riskSizingUtilizationFraction;
  invariant(riskBudget > 0, "TESTNET_PORTFOLIO_RISK_LIMIT");
  const costPerUnit = normalizedPrice * 2 * (TESTNET_RISK_LIMITS.takerFeeRate + TESTNET_RISK_LIMITS.adverseSlippageRate);
  const riskPerUnit = Math.abs(normalizedPrice - normalizedStop) + costPerUnit;
  invariant(riskPerUnit > 0, "TESTNET_RISK_PER_UNIT_INVALID");
  const leverageCapacityNotional = normalizedEquity * TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage - Number(existingNotional);
  invariant(leverageCapacityNotional > 0, "TESTNET_EFFECTIVE_LEVERAGE_LIMIT");
  const symbolInfo = exchangeInfo?.symbols?.find((row) => row.symbol === symbol);
  const lot = filterFor(symbolInfo, "MARKET_LOT_SIZE") ?? filterFor(symbolInfo, "LOT_SIZE");
  const stepSize = Number(lot?.stepSize ?? 0);
  const maximum = Math.min(riskBudget / riskPerUnit, leverageCapacityNotional / normalizedPrice, Number(lot?.maxQty ?? Number.POSITIVE_INFINITY));
  const quantity = floorToStep(maximum, stepSize);
  invariant(quantity >= Number(lot?.minQty ?? 0) && quantity > 0, "TESTNET_RISK_SIZED_QUANTITY_BELOW_MINIMUM");
  return quantity;
}

async function fetchEntryContext(symbol, credentials, options) {
  const now = options.now ?? Date.now();
  const [account, positions, positionMode, openOrders, openAlgoOrders, exchangeInfo, bookTicker] = await Promise.all([
    requestJson("GET", "/fapi/v2/account", {}, credentials, { ...options, now }),
    requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { ...options, now }),
    requestJson("GET", "/fapi/v1/positionSide/dual", {}, credentials, { ...options, now }),
    requestJson("GET", "/fapi/v1/openOrders", {}, credentials, { ...options, now }),
    requestJson("GET", "/fapi/v1/openAlgoOrders", { symbol }, credentials, { ...options, now }),
    publicJson("/fapi/v1/exchangeInfo", {}, options),
    publicJson("/fapi/v1/ticker/bookTicker", { symbol }, options),
  ]);
  assertSupportedAccountMode(account, positions, positionMode);
  return { account, positions, positionMode, openOrders, openAlgoOrders, exchangeInfo, bookTicker };
}

async function executableEntryReference({ context, symbol, side, entryGuard, now, entryEvidenceProvider = null, priorCausalEvidence = null }) {
  const restPrice = finitePositive(side === "BUY" ? context.bookTicker?.askPrice : context.bookTicker?.bidPrice, "TESTNET_BOOK_TICKER_INVALID");
  if (typeof entryEvidenceProvider !== "function") return { referencePrice: restPrice, restPrice, causalEntryEvidence: null };
  const minimumUpdateIdExclusive = Math.max(Number(entryGuard?.minimumCausalUpdateIdExclusive ?? -1), Number(priorCausalEvidence?.updateId ?? -1));
  const supplied = await entryEvidenceProvider({ symbol, side, minimumUpdateIdExclusive });
  const quote = supplied?.quote ?? supplied;
  const decisionMarketTime = Number(supplied?.decisionMarketTime);
  const decisionLocalTime = Number(supplied?.decisionLocalTime ?? now);
  const marketTime = Number(quote?.marketTime ?? quote?.eventTime);
  const receivedAt = Number(quote?.receivedAt);
  const updateId = Number(quote?.updateId);
  const readyAt = Number(entryGuard?.decisionReadyMarketTime ?? entryGuard?.decisionBarCloseTime);
  const deadline = Number(entryGuard?.deadline ?? Number(entryGuard?.decisionBarCloseTime) + Number(entryGuard?.maximumSignalAgeMs));
  const maximumAgeMs = Number(entryGuard?.maximumCausalBboAgeMs ?? 15_000);
  invariant([marketTime, receivedAt, updateId, decisionMarketTime, decisionLocalTime, readyAt, deadline, maximumAgeMs].every(Number.isFinite), "TESTNET_CAUSAL_BBO_TEMPORAL_EVIDENCE_INCOMPLETE");
  invariant(Number.isSafeInteger(updateId) && updateId > minimumUpdateIdExclusive, "TESTNET_CAUSAL_BBO_UPDATE_ID_NOT_STRICTLY_INCREASING");
  invariant(marketTime >= readyAt, "TESTNET_CAUSAL_BBO_BEFORE_DECISION_READY");
  invariant(marketTime <= deadline, "TESTNET_CAUSAL_BBO_AFTER_ENTRY_DEADLINE");
  invariant(marketTime <= decisionMarketTime, "TESTNET_CAUSAL_BBO_AFTER_DECISION_MARKET_CLOCK");
  invariant(receivedAt <= decisionLocalTime, "TESTNET_CAUSAL_BBO_RECEIVED_AFTER_DECISION_LOCAL_CLOCK");
  invariant(decisionMarketTime - marketTime <= maximumAgeMs, "TESTNET_CAUSAL_BBO_EXCHANGE_CLOCK_STALE");
  invariant(decisionLocalTime - receivedAt <= maximumAgeMs, "TESTNET_CAUSAL_BBO_LOCAL_RECEIVE_STALE");
  const causalPrice = finitePositive(side === "BUY" ? quote?.ask : quote?.bid, "TESTNET_CAUSAL_BBO_PRICE_INVALID");
  const referencePrice = side === "BUY" ? Math.max(restPrice, causalPrice) : Math.min(restPrice, causalPrice);
  return {
    referencePrice,
    restPrice,
    causalEntryEvidence: { symbol, side, bid: Number(quote.bid), ask: Number(quote.ask), marketTime, eventTime: Number(quote.eventTime ?? marketTime), transactionTime: Number(quote.transactionTime ?? marketTime), receivedAt, updateId, decisionMarketTime, decisionLocalTime, readyAt, deadline, maximumAgeMs, causalPrice, restPrice, executablePrice: referencePrice, conservativePriceSelection: referencePrice === causalPrice ? "CAUSAL" : "REST_MORE_ADVERSE" },
  };
}

function assertEntryQuality(entryQualityEvaluator, referencePrice, context = {}) {
  if (typeof entryQualityEvaluator !== "function") return null;
  const result = entryQualityEvaluator(referencePrice, { referencePrice, ...context });
  invariant(result?.allowed === true, `TESTNET_ENTRY_COMPLETE_LIFECYCLE_COST_LIMIT:${result?.reason ?? "REJECTED"}`);
  return result;
}

function strategyMetadataForPosition(value) {
  if (value == null) return null;
  invariant(value && typeof value === "object" && !Array.isArray(value), "TESTNET_STRATEGY_METADATA_INVALID");
  const keys = [
    "planId", "signalId", "strategyVersion", "pattern", "intersectionTime", "intersectionPrice",
    "decisionBarOpenTime", "decisionBarCloseTime", "decisionClose", "signalInitialRiskPerUnit",
    "maximumEntryDisplacementBps", "maximumEntrySignalAgeMs", "entryGuardAtSubmission",
    "discoveryPromotion", "primaryLineStatus", "anchorConsensus", "intersectionRange",
    "intersectionQuality", "anchors", "scale", "structureLineage", "reentryLineageGuardAtSubmission",
    "sourceStrategyRevision", "sourceRuntimeAccessed",
  ];
  if (EXECUTION_PROFILE === "ORION_V3") keys.push("marketState4h", "marketStateGateAtSubmission", "entryConfirmationEvidence", "dualZ", "singleZ", "dualZComparison", "firstDiscoveredAt");
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, structuredClone(value[key])]));
}

function mergeRecordedEntryMetadata(position, metadata) {
  const merged = { ...position, ...metadata };
  if (EXECUTION_PROFILE === "ORION_V3") {
    const immutableKeys = ["marketState4h", "marketStateGateAtSubmission", "entryConfirmationEvidence", "entryPreFillRiskEvidence", "entryRiskEvidence", "postFillRiskAssessment", "entryFourHourGateAtSubmission", "entryDualZGateAtSubmission", "entrySingleZGateAtSubmission", "dualZ", "singleZ", "dualZComparison", "firstDiscoveredAt", "entryFillTimeEvidence", "entryObservedAt", "implementationRevision", "evaluationCohortId"];
    if (position.dualZ || position.singleZ) immutableKeys.push("pattern", "anchors", "intersectionTime", "intersectionPrice");
    for (const key of immutableKeys) {
      if (Object.hasOwn(position, key)) merged[key] = structuredClone(position[key]);
    }
  }
  return merged;
}

function assertReplacementPreviewIdentity({ replacement, currentState, context, symbol }) {
  const managed = currentState.managedPositions?.[symbol];
  invariant(managed, "TESTNET_REPLACEMENT_LOCAL_POSITION_MISSING");
  invariant(String(replacement?.existingIntentId ?? "") === String(managed.intentId ?? ""), "TESTNET_REPLACEMENT_LOCAL_INTENT_MISMATCH");
  const active = nonFlatPositions(context.positions);
  const live = active.find((position) => position.symbol === symbol);
  invariant(live && active.filter((position) => position.symbol === symbol).length === 1, "TESTNET_REPLACEMENT_EXCHANGE_POSITION_MISSING_OR_AMBIGUOUS");
  const managedDirection = Number(managed.direction) || (managed.side === "BUY" ? 1 : -1);
  invariant((Number(live.positionAmt) > 0 ? 1 : -1) === managedDirection, "TESTNET_REPLACEMENT_DIRECTION_MISMATCH");
  invariant(Math.abs(Math.abs(Number(live.positionAmt)) - Number(managed.quantity)) <= 1e-8, "TESTNET_REPLACEMENT_QUANTITY_MISMATCH");
  invariant(Math.abs(Number(live.entryPrice) - Number(managed.entryPrice ?? managed.entry)) <= 1e-8, "TESTNET_REPLACEMENT_ENTRY_PRICE_MISMATCH");
  const stopClientOrderId = String(managed.stopClientOrderId ?? "");
  const managedProtection = currentState.managedOrders?.[stopClientOrderId];
  invariant(stopClientOrderId && managedProtection?.symbol === symbol && managedProtection?.role === "PROTECTIVE_STOP", "TESTNET_REPLACEMENT_LOCAL_PROTECTION_ID_MISMATCH");
  const activeProtection = (Array.isArray(context.openAlgoOrders) ? context.openAlgoOrders : []).filter((order) =>
    order.symbol === symbol && ["NEW", "PENDING_NEW"].includes(String(order.algoStatus ?? order.status))
  );
  invariant(activeProtection.length === 1, "TESTNET_REPLACEMENT_ACTIVE_PROTECTION_NOT_UNIQUE");
  const protective = activeProtection[0];
  invariant(String(protective.clientAlgoId ?? "") === stopClientOrderId, "TESTNET_REPLACEMENT_ACTIVE_PROTECTION_ID_MISMATCH");
  invariant(protective, "TESTNET_REPLACEMENT_ACTIVE_PROTECTION_MISSING");
  invariant(protective.closePosition === true, "TESTNET_REPLACEMENT_PROTECTION_NOT_FULL_REMAINING_QUANTITY");
  invariant(protective.side === (managedDirection === 1 ? "SELL" : "BUY"), "TESTNET_REPLACEMENT_PROTECTION_DIRECTION_MISMATCH");
  invariant(Math.abs(Number(protective.triggerPrice) - Number(managed.stopPrice ?? managed.stop)) <= 1e-8, "TESTNET_REPLACEMENT_PROTECTION_TRIGGER_MISMATCH");
  for (const position of active) invariant(position.symbol === symbol || currentState.managedPositions?.[position.symbol], "TESTNET_UNMANAGED_EXISTING_POSITION");
  const capacityState = structuredClone(currentState);
  delete capacityState.managedPositions[symbol];
  return { managed, live, protective, capacityState, capacityPositions: active.filter((position) => position.symbol !== symbol) };
}

export async function planAutomaticRiskSizedEntry({ intentId, symbol, side, stopPrice, entryGuard, implementationRevision = null, evaluationCohortId = null, riskPolicyRevision = null, riskPolicyAuthorizationId = null, strategyMetadata = null, confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null, entryEvidenceProvider = null, entryQualityEvaluator = null } = {}) {
  await loadAuthorization();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const normalizedSide = String(side ?? "").toUpperCase();
  invariant(normalizedSide === "BUY" || normalizedSide === "SELL", "TESTNET_SIDE_INVALID");
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const context = await fetchEntryContext(normalizedSymbol, credentials, { fetchImpl, now });
  const equity = riskEquityFromSignedAccount(context.account);
  const reference = await executableEntryReference({ context, symbol: normalizedSymbol, side: normalizedSide, entryGuard, now, entryEvidenceProvider });
  const referencePrice = reference.referencePrice;
  const direction = normalizedSide === "BUY" ? 1 : -1;
  const normalizedStop = protectiveStopForSymbol({ exchangeInfo: context.exchangeInfo, symbol: normalizedSymbol, stopPrice, direction, referencePrice });
  assertEntryQuality(entryQualityEvaluator, referencePrice, { normalizedStopPrice: normalizedStop.stopPrice });
  const activePositions = nonFlatPositions(context.positions);
  const quantity = calculateRiskSizedQuantity({
    equity,
    referencePrice,
    stopPrice: normalizedStop.stopPrice,
    existingNotional: activePositions.reduce((sum, position) => sum + positionNotional(position), 0),
    managedRiskUsdt: managedPortfolioRisk(currentState),
    exchangeInfo: context.exchangeInfo,
    symbol: normalizedSymbol,
  });
  return preflightMarketEntry({ intentId, symbol: normalizedSymbol, side: normalizedSide, quantity, stopPrice, entryGuard, implementationRevision, evaluationCohortId, riskPolicyRevision, riskPolicyAuthorizationId, strategyMetadata, confirmation }, { credentials, fetchImpl, now, state: currentState, entryEvidenceProvider, entryQualityEvaluator, priorCausalEvidence: reference.causalEntryEvidence });
}

export async function planReplacementRiskSizedEntry({ replacement, ...input }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null, entryEvidenceProvider = null, entryQualityEvaluator = null } = {}) {
  await loadAuthorization();
  checkConfirmation(input.confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const symbol = normalizeTestnetSymbol(input.symbol);
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const context = await fetchEntryContext(symbol, credentials, { fetchImpl, now });
  const verified = assertReplacementPreviewIdentity({ replacement, currentState, context, symbol });
  const side = String(input.side ?? "").toUpperCase();
  invariant(side === "BUY" || side === "SELL", "TESTNET_SIDE_INVALID");
  const equity = riskEquityFromSignedAccount(context.account);
  const reference = await executableEntryReference({ context, symbol, side, entryGuard: input.entryGuard, now, entryEvidenceProvider });
  const referencePrice = reference.referencePrice;
  const direction = side === "BUY" ? 1 : -1;
  const normalizedStop = protectiveStopForSymbol({ exchangeInfo: context.exchangeInfo, symbol, stopPrice: input.stopPrice, direction, referencePrice });
  assertEntryQuality(entryQualityEvaluator, referencePrice, { normalizedStopPrice: normalizedStop.stopPrice });
  const quantity = calculateRiskSizedQuantity({
    equity,
    referencePrice,
    stopPrice: normalizedStop.stopPrice,
    existingNotional: verified.capacityPositions.reduce((sum, position) => sum + positionNotional(position), 0),
    managedRiskUsdt: managedPortfolioRisk(verified.capacityState),
    exchangeInfo: context.exchangeInfo,
    symbol,
  });
  const plan = await preflightMarketEntry({ ...input, symbol, side, quantity }, { credentials, fetchImpl, now, state: currentState, replacementPreview: replacement, entryEvidenceProvider, entryQualityEvaluator, priorCausalEvidence: reference.causalEntryEvidence });
  return { ...plan, replacementPreview: { existingIntentId: verified.managed.intentId, symbol, direction: Number(verified.managed.direction) || (verified.managed.side === "BUY" ? 1 : -1), quantity: Number(verified.managed.quantity), protectionClientOrderId: verified.protective.clientAlgoId, excludedFromProspectiveCapacityOnly: true, matchingEngineOrdersSubmitted: 0 } };
}

export async function preflightMarketEntry({ intentId, symbol, side, quantity, stopPrice, entryGuard, implementationRevision = null, evaluationCohortId = null, riskPolicyRevision = null, riskPolicyAuthorizationId = null, strategyMetadata = null, confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null, replacementPreview = null, entryEvidenceProvider = null, entryQualityEvaluator = null, priorCausalEvidence = null } = {}) {
  await loadAuthorization();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedIntentId = normalizeIntentId(intentId);
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const normalizedSide = String(side ?? "").toUpperCase();
  invariant(normalizedSide === "BUY" || normalizedSide === "SELL", "TESTNET_SIDE_INVALID");
  const normalizedQuantity = finitePositive(quantity, "TESTNET_QUANTITY_INVALID");
  const requestedStopPrice = finitePositive(stopPrice, "TESTNET_STOP_PRICE_INVALID");
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  if (EXECUTION_PROFILE === "ORION_V3") invariant(!Object.values(currentState.pendingOperations ?? {}).some((operation) => operation?.postFillRiskVerificationRequired || operation?.riskIntegrityFailure), "TESTNET_V3_PENDING_RISK_INTEGRITY_FAILURE_BLOCKS_ENTRY");
  if (EXECUTION_PROFILE === "ORION_V3") invariant(![...Object.values(currentState.managedPositions ?? {}), ...(currentState.closedPositions ?? [])].some((position) => position?.entryIntegrityIncident && position.entryIntegrityIncident.status !== "RESOLVED_BY_OWNER"), "TESTNET_V3_ENTRY_INTEGRITY_INCIDENT_BLOCKS_ENTRY");
  const context = await fetchEntryContext(normalizedSymbol, credentials, { fetchImpl, now });
  invariant(context.account?.canTrade === true, "TESTNET_ACCOUNT_CANNOT_TRADE");
  const equity = riskEquityFromSignedAccount(context.account);
  const reference = await executableEntryReference({ context, symbol: normalizedSymbol, side: normalizedSide, entryGuard, now, entryEvidenceProvider, priorCausalEvidence });
  const referencePrice = reference.referencePrice;
  // Entry quality is a gateway invariant, not an optional strategy hint.
  // Idempotent recovery of an already-filled entry is handled before this
  // preflight; every path that can create a new position must supply and pass
  // the governed displacement and signal-age evidence.
  const strategyEntryGuard = validateStrategyEntryGuard(entryGuard, referencePrice, reference.causalEntryEvidence?.decisionMarketTime ?? now);
  const entryFourHourGateAtSubmission = validateV3FourHourEntryGuard({ side: normalizedSide, entryGuard, implementationRevision, strategyMetadata }, now);
  const entryDualZGateAtSubmission = validateV3DualZEntryGuard({ entryGuard, implementationRevision, evaluationCohortId, strategyMetadata }, now);
  const entrySingleZGateAtSubmission = validateV3SingleZEntryGuard({ entryGuard, implementationRevision, evaluationCohortId, strategyMetadata }, now);
  const direction = normalizedSide === "BUY" ? 1 : -1;
  const normalizedStop = protectiveStopForSymbol({
    exchangeInfo: context.exchangeInfo,
    symbol: normalizedSymbol,
    stopPrice: requestedStopPrice,
    direction,
    referencePrice,
  });
  const normalizedStopPrice = normalizedStop.stopPrice;
  const entryQuality = assertEntryQuality(entryQualityEvaluator, referencePrice, { normalizedStopPrice });
  const activePositions = nonFlatPositions(context.positions);
  const replacement = replacementPreview ? assertReplacementPreviewIdentity({ replacement: replacementPreview, currentState, context, symbol: normalizedSymbol }) : null;
  const capacityState = replacement?.capacityState ?? currentState;
  const capacityPositions = replacement?.capacityPositions ?? activePositions;
  for (const position of capacityPositions) invariant(capacityState.managedPositions?.[position.symbol], "TESTNET_UNMANAGED_EXISTING_POSITION");
  invariant(!capacityPositions.some((position) => position.symbol === normalizedSymbol), "TESTNET_SINGLE_SYMBOL_POSITION_LIMIT");
  invariant(capacityPositions.length < TESTNET_RISK_LIMITS.maximumOpenPositionsTotal, "TESTNET_OPEN_POSITION_LIMIT");
  invariant(!(Array.isArray(context.openOrders) ? context.openOrders : []).some((order) => order.symbol === normalizedSymbol), "TESTNET_SYMBOL_HAS_OPEN_ORDER");
  const unknownSymbolAlgo = (Array.isArray(context.openAlgoOrders) ? context.openAlgoOrders : []).filter((order) =>
    order.symbol === normalizedSymbol && (!replacement || String(order.clientAlgoId ?? "") !== String(replacement.protective.clientAlgoId ?? ""))
  );
  invariant(unknownSymbolAlgo.length === 0, "TESTNET_SYMBOL_HAS_OPEN_ALGO_ORDER");
  invariant(!capacityState.managedPositions?.[normalizedSymbol], "TESTNET_MANAGED_POSITION_ALREADY_EXISTS");
  const filters = validateMarketQuantity({ exchangeInfo: context.exchangeInfo, symbol: normalizedSymbol, quantity: normalizedQuantity, referencePrice });
  const notional = normalizedQuantity * referencePrice;
  const roundTripCostReserve = notional * 2 * (TESTNET_RISK_LIMITS.takerFeeRate + TESTNET_RISK_LIMITS.adverseSlippageRate);
  const plannedRiskUsdt = Math.abs(referencePrice - normalizedStopPrice) * normalizedQuantity + roundTripCostReserve;
  invariant(plannedRiskUsdt <= equity * TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction, "TESTNET_PER_ENTRY_RISK_LIMIT");
  invariant(managedPortfolioRisk(capacityState) + plannedRiskUsdt <= equity * TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction, "TESTNET_PORTFOLIO_RISK_LIMIT");
  const existingNotional = capacityPositions.reduce((sum, position) => sum + positionNotional(position), 0);
  invariant(existingNotional + notional <= equity * TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage, "TESTNET_EFFECTIVE_LEVERAGE_LIMIT");
  return {
    status: "PREFLIGHT_PASSED_BINANCE_DEMO_ONLY",
    intentId: normalizedIntentId,
    symbol: normalizedSymbol,
    side: normalizedSide,
    quantity: normalizedQuantity,
    stopPrice: normalizedStopPrice,
    stopPriceParam: normalizedStop.stopPriceParam,
    priceTickSize: normalizedStop.priceTickSize,
    referencePrice,
    equity,
    notional,
    plannedRiskUsdt,
    plannedRiskFraction: plannedRiskUsdt / equity,
    effectiveNotionalLeverageAfter: (existingNotional + notional) / equity,
    entryClientOrderId: deterministicClientOrderId(normalizedIntentId, "entry"),
    stopClientOrderId: deterministicClientOrderId(normalizedIntentId, "stop"),
    filters,
    strategyEntryGuard,
    causalEntryEvidence: reference.causalEntryEvidence,
    entryQuality,
    implementationRevision,
    evaluationCohortId,
    riskPolicyRevision,
    riskPolicyAuthorizationId,
    strategyMetadata: strategyMetadataForPosition(strategyMetadata),
    ...(EXECUTION_PROFILE === "ORION_V3" ? {
      entryFourHourGateAtSubmission,
      entryDualZGateAtSubmission,
      entrySingleZGateAtSubmission,
      preFillRiskEvidence: {
        observedAt: now,
        equitySource: "SIGNED_TOTAL_MARGIN_BALANCE",
        equityUsdt: equity,
        accountEquitySnapshot: Object.fromEntries(["totalMarginBalance", "totalWalletBalance", "totalUnrealizedProfit", "updateTime"].filter((key) => Object.hasOwn(context.account, key)).map((key) => [key, context.account[key]])),
        referencePrice,
        quantity: normalizedQuantity,
        stopPrice: normalizedStopPrice,
        notionalUsdt: notional,
        plannedRiskUsdt,
        existingManagedRiskUsdt: managedPortfolioRisk(capacityState),
        existingNotionalUsdt: existingNotional,
        bookTicker: structuredClone(context.bookTicker),
        strategyEntryGuard: structuredClone(strategyEntryGuard),
        riskPolicyRevision,
        riskPolicyAuthorizationId,
      },
    } : {}),
    state: capacityState,
  };
}

function entryParams(plan) {
  return {
    symbol: plan.symbol,
    side: plan.side,
    type: "MARKET",
    quantity: stepFormatted(plan.quantity, plan.filters?.stepSize),
    newClientOrderId: plan.entryClientOrderId,
    newOrderRespType: "RESULT",
  };
}

function algoStopParams(plan) {
  return {
    algoType: "CONDITIONAL",
    symbol: plan.symbol,
    side: plan.side === "BUY" ? "SELL" : "BUY",
    type: "STOP_MARKET",
    triggerPrice: plan.stopPriceParam ?? stepFormatted(plan.stopPrice, plan.priceTickSize),
    closePosition: true,
    workingType: "MARK_PRICE",
    priceProtect: true,
    clientAlgoId: plan.stopClientOrderId,
    newOrderRespType: "ACK",
  };
}

export function immutableInitialRiskBasis({ entryPrice, stopPrice, quantity, actualEntryCommission = null, executionProfile = EXECUTION_PROFILE }) {
  const notional = Number(entryPrice) * Number(quantity);
  const modeled = Math.abs(Number(entryPrice) - Number(stopPrice)) * Number(quantity) + notional * 2 * (TESTNET_RISK_LIMITS.takerFeeRate + TESTNET_RISK_LIMITS.adverseSlippageRate);
  if (executionProfile !== "ORION_V4") return modeled;
  const hasActualEntryCommission = actualEntryCommission !== null && actualEntryCommission !== undefined && Number.isFinite(Number(actualEntryCommission));
  invariant(!hasActualEntryCommission || Number(actualEntryCommission) >= 0, "TESTNET_ACTUAL_ENTRY_COMMISSION_NEGATIVE");
  const entryCost = hasActualEntryCommission ? Number(actualEntryCommission) : notional * TESTNET_RISK_LIMITS.takerFeeRate;
  const stopExitCost = Number(stopPrice) * Number(quantity) * (TESTNET_RISK_LIMITS.takerFeeRate + TESTNET_RISK_LIMITS.adverseSlippageRate);
  return Math.abs(Number(entryPrice) - Number(stopPrice)) * Number(quantity) + entryCost + stopExitCost;
}

// Recheck the existing V3 limits with filled prices and current signed equity.
// Actual commissions are retained separately; they do not silently replace or
// get added to the authorized round-trip risk model or change the R baseline.
export function assessV3PostFillRisk({ plan, entry, entryTradeCost = null, account, positions, state, now = Date.now() }) {
  invariant(EXECUTION_PROFILE === "ORION_V3", "TESTNET_V3_POST_FILL_PROFILE_REQUIRED");
  const equity = riskEquityFromSignedAccount(account, "TESTNET_V3_POST_FILL_EQUITY_UNKNOWN");
  invariant(Array.isArray(positions), "TESTNET_V3_POST_FILL_POSITIONS_UNKNOWN");
  for (const row of positions) invariant(typeof row?.symbol === "string" && row?.positionAmt != null && Number.isFinite(Number(row.positionAmt)), "TESTNET_V3_POST_FILL_POSITION_ROW_UNKNOWN");
  assertOneWayPositionRows(positions);
  const quantity = finitePositive(entry?.executedQty, "TESTNET_V3_POST_FILL_QUANTITY_UNKNOWN");
  const entryPrice = finitePositive(entry?.avgPrice, "TESTNET_V3_POST_FILL_PRICE_UNKNOWN");
  const stopPrice = finitePositive(plan?.stopPrice, "TESTNET_V3_POST_FILL_STOP_UNKNOWN");
  invariant(entry?.status === "FILLED", "TESTNET_V3_POST_FILL_ORDER_INCOMPLETE");
  const livePositions = nonFlatPositions(positions);
  invariant(new Set(livePositions.map((row) => row.symbol)).size === livePositions.length, "TESTNET_V3_POST_FILL_POSITION_ROWS_AMBIGUOUS");
  const matching = livePositions.filter((row) => row.symbol === plan.symbol);
  invariant(matching.length === 1, "TESTNET_V3_POST_FILL_POSITION_UNKNOWN");
  const live = matching[0];
  invariant((Number(live.positionAmt) > 0 ? "BUY" : "SELL") === plan.side && Math.abs(Math.abs(Number(live.positionAmt)) - quantity) <= 1e-8, "TESTNET_V3_POST_FILL_POSITION_MISMATCH");
  for (const row of livePositions) {
    finitePositive(row.markPrice, "TESTNET_V3_POST_FILL_MARK_UNKNOWN");
    invariant(row.symbol === plan.symbol || state?.managedPositions?.[row.symbol], "TESTNET_V3_POST_FILL_UNMANAGED_POSITION");
  }
  const otherManaged = Object.values(state?.managedPositions ?? {}).filter((row) => row.symbol !== plan.symbol);
  const existingManagedRiskUsdt = otherManaged.reduce((sum, row) => {
    const risk = Number(row.plannedRiskUsdt);
    invariant(row.plannedRiskUsdt != null && Number.isFinite(risk) && risk >= 0, "TESTNET_V3_POST_FILL_MANAGED_RISK_UNKNOWN");
    return sum + risk;
  }, 0);
  const postFillRiskUsdt = immutableInitialRiskBasis({ entryPrice, stopPrice, quantity, executionProfile: "ORION_V3" });
  const portfolioRiskUsdt = existingManagedRiskUsdt + postFillRiskUsdt;
  const grossNotionalUsdt = livePositions.reduce((sum, row) => sum + positionNotional(row), 0);
  const violations = [];
  if (postFillRiskUsdt > equity * TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction) violations.push("PER_ENTRY_RISK_LIMIT");
  if (portfolioRiskUsdt > equity * TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction) violations.push("PORTFOLIO_RISK_LIMIT");
  if (grossNotionalUsdt > equity * TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage) violations.push("EFFECTIVE_NOTIONAL_LEVERAGE_LIMIT");
  const preFill = plan.preFillRiskEvidence == null ? null : structuredClone(plan.preFillRiskEvidence);
  const payload = {
    schemaVersion: 1,
    executionProfile: "ORION_V3",
    riskBasis: "EXISTING_V3_ABSOLUTE_STOP_DISTANCE_PLUS_MODELED_ROUND_TRIP_COST",
    status: violations.length ? "BREACHED" : "PASSED",
    preFillEvidenceStatus: preFill ? "OBSERVED_BEFORE_SUBMISSION" : "LEGACY_PRE_FILL_EVIDENCE_UNAVAILABLE",
    preFill,
    postFill: {
      observedAt: now,
      equitySource: "SIGNED_TOTAL_MARGIN_BALANCE",
      equityUsdt: equity,
      accountEquitySnapshot: Object.fromEntries(["totalMarginBalance", "totalWalletBalance", "totalUnrealizedProfit", "updateTime"].filter((key) => Object.hasOwn(account, key)).map((key) => [key, account[key]])),
      quantity,
      entryPrice,
      stopPrice,
      entryNotionalUsdt: entryPrice * quantity,
      plannedRiskUsdt: postFillRiskUsdt,
      modeledRoundTripCostUsdt: entryPrice * quantity * 2 * (TESTNET_RISK_LIMITS.takerFeeRate + TESTNET_RISK_LIMITS.adverseSlippageRate),
      existingManagedRiskUsdt,
      portfolioRiskUsdt,
      grossNotionalUsdt,
      perEntryLimitUsdt: equity * TESTNET_RISK_LIMITS.maximumRiskPerEntryFraction,
      portfolioLimitUsdt: equity * TESTNET_RISK_LIMITS.maximumManagedPortfolioRiskFraction,
      effectiveNotionalLeverage: grossNotionalUsdt / equity,
      maximumEffectiveNotionalLeverage: TESTNET_RISK_LIMITS.maximumEffectiveNotionalLeverage,
      entryOrderId: entry.orderId ?? null,
      entryTradeCost: entryTradeCost == null ? null : structuredClone(entryTradeCost),
      signedPositions: livePositions.map((row) => ({ symbol: row.symbol, positionSide: row.positionSide, positionAmt: row.positionAmt, entryPrice: row.entryPrice, markPrice: row.markPrice })),
    },
    riskDeltaUsdt: preFill ? postFillRiskUsdt - Number(preFill.plannedRiskUsdt) : null,
    violations,
  };
  return { ...payload, evidenceHash: sha256(stableStringify(payload)) };
}

export function v3EntryFillTimeEvidence(entry, entryTradeCost = null) {
  const fills = Array.isArray(entryTradeCost?.fills) ? entryTradeCost.fills : [];
  const timedFills = fills.filter((fill) => Number.isFinite(Number(fill?.time)) && Number(fill.time) > 0);
  if (timedFills.length) {
    const times = timedFills.map((fill) => Number(fill.time));
    const firstObservedFillAt = Math.min(...times);
    const lastObservedFillAt = Math.max(...times);
    const coveredQuantity = timedFills.reduce((sum, fill) => sum + Number(fill.quantity ?? 0), 0);
    return { openedAt: firstObservedFillAt, source: "SIGNED_BINANCE_DEMO_USER_TRADES", firstObservedFillAt, lastObservedFillAt, coverage: timedFills.length === fills.length && Math.abs(coveredQuantity - Number(entry?.executedQty)) <= 1e-8 ? "COMPLETE_ENTRY_FILL_TIMES" : "OBSERVED_FILL_TIMES_ONLY" };
  }
  const updateTime = Number(entry?.updateTime);
  if (entry?.status === "FILLED" && Number.isFinite(updateTime) && updateTime > 0) return { openedAt: updateTime, source: "SIGNED_FILLED_ORDER_UPDATE_TIME", firstObservedFillAt: null, lastObservedFillAt: null, coverage: "FILLED_ORDER_UPDATE_ONLY" };
  return { openedAt: null, source: "UNKNOWN_ACTUAL_FILL_TIME", firstObservedFillAt: null, lastObservedFillAt: null, coverage: "UNKNOWN" };
}

function managedPositionFromExecution(plan, entry, protectiveStop, now, entryTradeCost = null) {
  const quantity = Number(entry?.executedQty) || plan.quantity;
  const entryPrice = Number(entry?.avgPrice) || plan.referencePrice;
  const notional = entryPrice * quantity;
  const actualEntryCommission = Number(entryTradeCost?.commissionUsdt);
  const hasActualEntryCommission = entryTradeCost?.allCommissionInUsdt === true && Number.isFinite(actualEntryCommission);
  const entryFee = hasActualEntryCommission ? actualEntryCommission : notional * TESTNET_RISK_LIMITS.takerFeeRate;
  const plannedRiskUsdt = immutableInitialRiskBasis({ entryPrice, stopPrice: plan.stopPrice, quantity, actualEntryCommission: hasActualEntryCommission ? actualEntryCommission : null });
  const preservedTiming = plan.preservedEntryTiming;
  const preservedOpenedAt = Number(preservedTiming?.openedAt);
  const fillTimeEvidence = EXECUTION_PROFILE === "ORION_V3" ? (preservedOpenedAt > 0 && Number.isFinite(preservedOpenedAt)
    ? structuredClone(preservedTiming.entryFillTimeEvidence ?? { openedAt: preservedOpenedAt, source: "PREVIOUSLY_RECORDED_MANAGED_OPENED_AT", coverage: "LEGACY_RECORDED_TIME" })
    : v3EntryFillTimeEvidence(entry, entryTradeCost)) : null;
  const openedAt = EXECUTION_PROFILE === "ORION_V3" ? (preservedOpenedAt > 0 && Number.isFinite(preservedOpenedAt) ? preservedOpenedAt : fillTimeEvidence.openedAt) : now;
  return {
    intentId: plan.intentId,
    symbol: plan.symbol,
    side: plan.side,
    quantity,
    originalQuantity: quantity,
    entryPrice,
    entry: entryPrice,
    stopPrice: plan.stopPrice,
    stop: plan.stopPrice,
    plannedRiskUsdt,
    initialPlannedRiskUsdt: plannedRiskUsdt,
    initialRiskPerUnit: plannedRiskUsdt / quantity,
    direction: plan.side === "BUY" ? 1 : -1,
    status: "OPEN",
    stage: "INITIAL_PROTECTION",
    entryFee,
    entryFeeRate: notional > 0 ? entryFee / notional : null,
    entryFeeEvidence: hasActualEntryCommission ? "ACTUAL_BINANCE_DEMO_USER_TRADES" : "AUTHORIZED_CONSERVATIVE_TAKER_FEE_MODEL",
    entryTradeCost,
    cumulativeExitFee: 0,
    cumulativeGrossPnl: 0,
    cumulativeRealizedNetPnl: 0,
    partialExits: [],
    strategyEntryGuard: plan.strategyEntryGuard ?? null,
    implementationRevision: plan.implementationRevision ?? null,
    evaluationCohortId: plan.evaluationCohortId ?? null,
    riskPolicyRevision: plan.riskPolicyRevision ?? null,
    riskPolicyAuthorizationId: plan.riskPolicyAuthorizationId ?? null,
    ...(plan.strategyMetadata ?? {}),
    ...(EXECUTION_PROFILE === "ORION_V3" ? {
      entryFillTimeEvidence: fillTimeEvidence,
      entryObservedAt: preservedTiming?.entryObservedAt ?? plan.entryObservedAt ?? now,
      ...(plan.preFillRiskEvidence ? { entryPreFillRiskEvidence: structuredClone(plan.preFillRiskEvidence) } : {}),
      ...(plan.entryRiskEvidence ? { entryRiskEvidence: structuredClone(plan.entryRiskEvidence), postFillRiskAssessment: structuredClone(plan.entryRiskEvidence) } : {}),
      ...(plan.entryFourHourGateAtSubmission ? { entryFourHourGateAtSubmission: structuredClone(plan.entryFourHourGateAtSubmission) } : {}),
      ...(plan.entryDualZGateAtSubmission ? { entryDualZGateAtSubmission: structuredClone(plan.entryDualZGateAtSubmission) } : {}),
      ...(plan.entrySingleZGateAtSubmission ? { entrySingleZGateAtSubmission: structuredClone(plan.entrySingleZGateAtSubmission) } : {}),
    } : {}),
    entryClientOrderId: plan.entryClientOrderId,
    stopClientOrderId: plan.stopClientOrderId,
    entryOrderId: entry?.orderId ?? null,
    stopOrderId: protectiveStop?.algoId ?? protectiveStop?.orderId ?? null,
    stopAlgoId: protectiveStop?.algoId ?? null,
    openedAt,
    openedAtIso: openedAt === null ? null : new Date(openedAt).toISOString(),
  };
}

async function verifyV3ProtectedEntryRisk({ plan, entry, entryTradeCost, protectiveStop, state, credentials, fetchImpl, now, persist }) {
  if (EXECUTION_PROFILE !== "ORION_V3") return null;
  plan.entryObservedAt = now;
  const operation = state.pendingOperations[plan.entryClientOrderId];
  operation.phase = "POST_FILL_RISK_UNVERIFIED";
  operation.postFillRiskVerificationRequired = true;
  operation.preFillRiskEvidence ??= plan.preFillRiskEvidence == null ? null : structuredClone(plan.preFillRiskEvidence);
  operation.entryOrderId = entry.orderId ?? null;
  operation.entryFill = structuredClone(entry);
  operation.entryTradeCost = entryTradeCost == null ? null : structuredClone(entryTradeCost);
  operation.stopOrderId = protectiveStop?.algoId ?? protectiveStop?.orderId ?? null;
  // The fill and full-position protection are real exchange effects even if
  // the subsequent signed account request fails. Preserve them before reads.
  state.managedPositions[plan.symbol] ??= managedPositionFromExecution(plan, entry, protectiveStop, now, entryTradeCost);
  state.managedOrders[plan.entryClientOrderId] = { symbol: plan.symbol, role: "ENTRY", orderId: entry.orderId ?? null };
  state.managedOrders[plan.stopClientOrderId] = { symbol: plan.symbol, role: "PROTECTIVE_STOP", orderKind: "ALGO", orderId: protectiveStop?.algoId ?? null };
  state.updatedAt = new Date(now).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, state);
  let evidence;
  try {
    const [account, positions] = await Promise.all([
      requestJson("GET", "/fapi/v2/account", {}, credentials, { fetchImpl, now }),
      requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now }),
    ]);
    evidence = assessV3PostFillRisk({ plan, entry, entryTradeCost, account, positions, state, now });
  } catch (cause) {
    operation.riskIntegrityFailure = true;
    operation.riskVerificationError = cause?.message ?? String(cause);
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, state);
    const error = new Error("TESTNET_V3_POST_FILL_RISK_UNVERIFIED", { cause });
    error.riskIntegrityFailure = true;
    error.recoveredState = state;
    throw error;
  }
  operation.entryRiskEvidence = structuredClone(evidence);
  state.managedPositions[plan.symbol].entryRiskEvidence = structuredClone(evidence);
  state.managedPositions[plan.symbol].postFillRiskAssessment = structuredClone(evidence);
  if (evidence.status === "BREACHED") {
    state.managedPositions[plan.symbol].entryIntegrityIncident = {
      kind: "POST_FILL_AUTHORIZED_RISK_LIMIT_BREACHED",
      status: "OWNER_RECONCILIATION_REQUIRED",
      recordedAt: now,
      evidenceHash: evidence.evidenceHash,
      violations: [...evidence.violations],
      protectionVerified: true,
      ownerResetRequired: true,
    };
    // Exchange effects and protection are known. This is a settled integrity
    // incident, not an unresolved ENTRY that would disable position management.
    delete state.pendingOperations[plan.entryClientOrderId];
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, state);
    if (persist) await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_V3_POST_FILL_RISK_INTEGRITY_FAILURE", occurredAt: new Date(now).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: plan.symbol, intentId: plan.intentId, entryRiskEvidence: evidence, protectiveStopVerified: true, action: "KEEP_PROTECTION_BLOCK_NEW_ENTRY_REQUIRE_CONTROLLED_RECONCILIATION", credentialsRecorded: false, productionHostUsed: false });
    const error = new Error("TESTNET_V3_POST_FILL_RISK_LIMIT_BREACHED");
    error.riskIntegrityFailure = true;
    error.recoveredState = state;
    throw error;
  }
  operation.phase = "POST_FILL_RISK_VERIFIED";
  delete operation.riskIntegrityFailure;
  delete operation.riskVerificationError;
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, state);
  return evidence;
}

function buildRolledBackEntryOutcome({ plan, entry, entryTradeCost, rollback, rollbackTradeCost, now, reason, source }) {
  const openedAt = Number(entry?.updateTime ?? entry?.time) || now;
  const managed = managedPositionFromExecution(plan, entry, null, openedAt, entryTradeCost);
  return buildClosedPositionOutcome(managed, { ...rollback, tradeCost: rollbackTradeCost }, {
    now,
    reason,
    source,
  });
}

async function rollbackUnprotectedEntry(plan, entry, credentials, options) {
  const rollbackClientOrderId = deterministicClientOrderId(plan.intentId, "rollback");
  return submitRecoverable({
    symbol: plan.symbol,
    side: plan.side === "BUY" ? "SELL" : "BUY",
    type: "MARKET",
    quantity: Number(entry?.executedQty) || plan.quantity,
    reduceOnly: true,
    newClientOrderId: rollbackClientOrderId,
    newOrderRespType: "RESULT",
  }, credentials, options);
}

async function queryByClientOrderId(symbol, clientOrderId, credentials, options) {
  try {
    return await requestJson("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }, credentials, options);
  } catch (error) {
    if (error?.binanceCode === -2013) return null;
    throw error;
  }
}

async function queryAlgoByClientId(clientAlgoId, credentials, options) {
  try {
    return await requestJson("GET", "/fapi/v1/algoOrder", { clientAlgoId }, credentials, options);
  } catch (error) {
    if (error?.binanceCode === -2013 || error?.binanceCode === -2011) return null;
    throw error;
  }
}

async function submitRecoverable(params, credentials, options) {
  try {
    return await requestJson("POST", "/fapi/v1/order", params, credentials, options);
  } catch (error) {
    const recovered = await queryByClientOrderId(params.symbol, params.newClientOrderId, credentials, options);
    if (recovered) return recovered;
    throw error;
  }
}

async function submitRecoverableAlgo(params, credentials, options) {
  try {
    return await requestJson("POST", "/fapi/v1/algoOrder", params, credentials, options);
  } catch (error) {
    const recovered = await queryAlgoByClientId(params.clientAlgoId, credentials, options);
    if (recovered) return recovered;
    throw error;
  }
}

async function cancelAlgoByClientId(clientAlgoId, credentials, options) {
  try {
    return await requestJson("DELETE", "/fapi/v1/algoOrder", { clientAlgoId }, credentials, options);
  } catch (error) {
    if (error?.binanceCode === -2011 || error?.binanceCode === -2013) return null;
    throw error;
  }
}

function algoAsFinalFill(algo) {
  const executedQty = Number(algo?.actualQty);
  const avgPrice = Number(algo?.actualPrice);
  const filled = algo?.algoStatus === "FINISHED" && executedQty > 0 && avgPrice > 0;
  return {
    ...algo,
    status: filled ? "FILLED" : algo?.algoStatus,
    orderId: algo?.actualOrderId || algo?.algoId || null,
    clientOrderId: algo?.clientAlgoId ?? null,
    executedQty: filled ? String(executedQty) : "0",
    avgPrice: filled ? String(avgPrice) : "0",
  };
}

function assertFilledMarketOrder(order, expectedQuantity, code = "TESTNET_MARKET_ORDER_FILL_INCOMPLETE") {
  assertFilledMarketOrderQuantity(order, expectedQuantity, code);
  invariant(Number(order?.avgPrice) > 0, "TESTNET_MARKET_ORDER_AVERAGE_PRICE_MISSING");
  return order;
}

function assertFilledMarketOrderQuantity(order, expectedQuantity, code = "TESTNET_MARKET_ORDER_FILL_INCOMPLETE") {
  const executed = Number(order?.executedQty);
  invariant(order?.status === "FILLED" && Number.isFinite(executed) && Math.abs(executed - Number(expectedQuantity)) <= 1e-8, code);
  return order;
}

export function hydrateFilledOrderAverageFromTrades(order, tradeCost) {
  if (Number(order?.avgPrice) > 0) return order;
  const fills = (tradeCost?.fills ?? []).filter((fill) => Number(fill?.price) > 0 && Number(fill?.quantity) > 0);
  const filledQuantity = fills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
  const filledNotional = fills.reduce((sum, fill) => sum + Number(fill.price) * Number(fill.quantity), 0);
  const executedQuantity = Number(order?.executedQty);
  if (order?.status !== "FILLED" || !(executedQuantity > 0) || Math.abs(filledQuantity - executedQuantity) > 1e-8 || !(filledNotional > 0)) return order;
  return {
    ...order,
    avgPrice: String(filledNotional / filledQuantity),
    averagePriceEvidence: "ACTUAL_BINANCE_DEMO_USER_TRADES",
  };
}

async function resolveFilledMarketOrder(order, { symbol, clientOrderId, credentials, fetchImpl, now }) {
  let resolved = order;
  if (resolved?.status === "FILLED" && Number(resolved?.executedQty) > 0 && !(Number(resolved?.avgPrice) > 0) && clientOrderId) {
    const refreshed = await queryByClientOrderId(symbol, clientOrderId, credentials, { fetchImpl, now });
    if (refreshed) resolved = refreshed;
  }
  let tradeCost = null;
  if (resolved?.status === "FILLED" && Number(resolved?.executedQty) > 0 && !(Number(resolved?.avgPrice) > 0)) {
    tradeCost = await safeOrderTradeCost(symbol, resolved?.orderId ?? order?.orderId, credentials, { fetchImpl, now });
    resolved = hydrateFilledOrderAverageFromTrades(resolved, tradeCost);
  }
  return { order: resolved, tradeCost };
}

function assertActiveProtectiveAlgo(order, plan) {
  invariant(order && ["NEW", "PENDING_NEW"].includes(String(order.algoStatus ?? order.status)), "TESTNET_PROTECTIVE_STOP_NOT_ACTIVE");
  invariant(order.symbol === plan.symbol, "TESTNET_PROTECTIVE_STOP_SYMBOL_MISMATCH");
  invariant(order.clientAlgoId === plan.stopClientOrderId, "TESTNET_PROTECTIVE_STOP_CLIENT_ID_MISMATCH");
  invariant(order.side === (plan.side === "BUY" ? "SELL" : "BUY"), "TESTNET_PROTECTIVE_STOP_SIDE_MISMATCH");
  invariant(order.positionSide === "BOTH", "TESTNET_PROTECTIVE_STOP_POSITION_MODE_MISMATCH");
  invariant(order.closePosition === true, "TESTNET_PROTECTIVE_STOP_CLOSE_POSITION_REQUIRED");
  invariant(order.workingType === "MARK_PRICE", "TESTNET_PROTECTIVE_STOP_WORKING_TYPE_MISMATCH");
  invariant(order.priceProtect === true, "TESTNET_PROTECTIVE_STOP_PRICE_PROTECT_REQUIRED");
  invariant(Math.abs(Number(order.triggerPrice) - Number(plan.stopPrice)) <= 1e-8, "TESTNET_PROTECTIVE_STOP_TRIGGER_MISMATCH");
  return order;
}

export async function recordTradingAudit(event) {
  return appendChainedAudit(TRADING_AUDIT_PATH, event);
}

async function recordAudit(event) {
  return recordTradingAudit(event);
}

export async function verifyTradingAuditLedger() {
  return verifyChainedAudit(TRADING_AUDIT_PATH);
}

function leverageRow(rows, symbol) {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.find((row) => row?.symbol === symbol) ?? null;
}

export async function ensureSymbolInitialLeverage({ symbol, confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), persist = true } = {}) {
  await loadAuthorization();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const positions = await requestJson("GET", "/fapi/v2/positionRisk", { symbol: normalizedSymbol }, credentials, { fetchImpl, now });
  const observedLeverage = Number(leverageRow(positions, normalizedSymbol)?.leverage);
  if (observedLeverage === TESTNET_INITIAL_LEVERAGE) {
    return {
      status: "BINANCE_DEMO_INITIAL_LEVERAGE_ALREADY_ALIGNED",
      symbol: normalizedSymbol,
      priorLeverage: observedLeverage,
      leverage: TESTNET_INITIAL_LEVERAGE,
      changed: false,
    };
  }
  const result = await requestJson("POST", "/fapi/v1/leverage", {
    symbol: normalizedSymbol,
    leverage: TESTNET_INITIAL_LEVERAGE,
  }, credentials, { fetchImpl, now });
  invariant(result?.symbol === normalizedSymbol, "TESTNET_LEVERAGE_ALIGNMENT_SYMBOL_MISMATCH");
  invariant(Number(result?.leverage) === TESTNET_INITIAL_LEVERAGE, "TESTNET_LEVERAGE_ALIGNMENT_NOT_CONFIRMED");
  const audit = persist ? await recordAudit({
    schemaVersion: 1,
    eventType: "BINANCE_DEMO_INITIAL_LEVERAGE_ALIGNED",
    occurredAt: new Date(now).toISOString(),
    venue: "BINANCE_USDM_TESTNET",
    symbol: normalizedSymbol,
    priorLeverage: Number.isFinite(observedLeverage) ? observedLeverage : null,
    leverage: TESTNET_INITIAL_LEVERAGE,
    authorizationId: PROFILE.leverageAuthorizationId,
    universeAuthorizationId: PROFILE.universeAuthorizationId,
    credentialsRecorded: false,
    productionHostUsed: false,
  }) : null;
  return {
    status: "BINANCE_DEMO_INITIAL_LEVERAGE_ALIGNED",
    symbol: normalizedSymbol,
    priorLeverage: Number.isFinite(observedLeverage) ? observedLeverage : null,
    leverage: TESTNET_INITIAL_LEVERAGE,
    changed: true,
    auditEventHash: audit?.eventHash ?? null,
  };
}

export async function alignAllApprovedSymbolLeverage({ confirmation }, options = {}) {
  const results = [];
  for (const symbol of OWNER_APPROVED_TESTNET_SYMBOLS) {
    results.push(await ensureSymbolInitialLeverage({ symbol, confirmation }, options));
  }
  return {
    status: "BINANCE_DEMO_APPROVED_UNIVERSE_LEVERAGE_ALIGNED",
    leverage: TESTNET_INITIAL_LEVERAGE,
    symbolCount: results.length,
    changedCount: results.filter((row) => row.changed).length,
    results,
  };
}

export async function validateMarketEntry(input, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null } = {}) {
  const plan = await preflightMarketEntry(input, { credentials, fetchImpl, now, state });
  await requestJson("POST", "/fapi/v1/order/test", entryParams(plan), credentials, { fetchImpl, now });
  return {
    status: "VALIDATED_BY_BINANCE_DEMO_NO_MATCHING_ENGINE_SUBMISSION",
    venue: "BINANCE_USDM_TESTNET",
    symbol: plan.symbol,
    side: plan.side,
    quantity: plan.quantity,
    stopPrice: plan.stopPrice,
    plannedRiskUsdt: plan.plannedRiskUsdt,
    plannedRiskFraction: plan.plannedRiskFraction,
    effectiveNotionalLeverageAfter: plan.effectiveNotionalLeverageAfter,
    entryClientOrderId: plan.entryClientOrderId,
    stopClientOrderId: plan.stopClientOrderId,
    protectiveStopValidation: "LOCAL_EXCHANGE_FILTERS_ALGO_ENDPOINT_HAS_NO_TEST_ROUTE",
    matchingEngineOrdersSubmitted: 0,
    realOrdersSubmitted: 0,
  };
}

export async function placeMarketEntry(input, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), clock = null, state = null, persist = true, entryEvidenceProvider = null, entryQualityEvaluator = null } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(input?.confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedIntentId = normalizeIntentId(input?.intentId);
  const normalizedSymbol = normalizeTestnetSymbol(input?.symbol);
  const normalizedSide = String(input?.side ?? "").toUpperCase();
  invariant(normalizedSide === "BUY" || normalizedSide === "SELL", "TESTNET_SIDE_INVALID");
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const entryClientOrderId = deterministicClientOrderId(normalizedIntentId, "entry");
  const stopClientOrderId = deterministicClientOrderId(normalizedIntentId, "stop");
  const pendingEntry = currentState.pendingOperations?.[entryClientOrderId];
  if (EXECUTION_PROFILE === "ORION_V3") invariant(pendingEntry?.phase !== "POST_FILL_RISK_BREACHED", "TESTNET_V3_POST_FILL_RISK_BREACH_REQUIRES_CONTROLLED_RECONCILIATION");
  const existing = await queryByClientOrderId(normalizedSymbol, entryClientOrderId, credentials, { fetchImpl, now });
  if (existing) {
    const existingStop = await queryAlgoByClientId(stopClientOrderId, credentials, { fetchImpl, now });
    if (currentState.managedPositions?.[normalizedSymbol] && existingStop && !(EXECUTION_PROFILE === "ORION_V3" && pendingEntry?.postFillRiskVerificationRequired && pendingEntry?.phase !== "POST_FILL_RISK_VERIFIED")) {
      invariant(currentState.managedPositions[normalizedSymbol].intentId === normalizedIntentId, "TESTNET_IDEMPOTENT_POSITION_INTENT_MISMATCH");
      if (EXECUTION_PROFILE === "ORION_V3" && pendingEntry?.phase === "POST_FILL_RISK_VERIFIED") {
        const managed = currentState.managedPositions[normalizedSymbol];
        invariant(managed.entryRiskEvidence?.status === "PASSED" && managed.entryRiskEvidence?.evidenceHash === pendingEntry.entryRiskEvidence?.evidenceHash, "TESTNET_V3_PENDING_VERIFIED_RISK_EVIDENCE_MISMATCH");
        assertActiveProtectiveAlgo(existingStop, managed);
      }
      const strategyMetadata = strategyMetadataForPosition(input?.strategyMetadata);
      if (currentState.pendingOperations?.[entryClientOrderId] && persist) {
        const cleanedState = structuredClone(currentState);
        if (strategyMetadata) cleanedState.managedPositions[normalizedSymbol] = mergeRecordedEntryMetadata(cleanedState.managedPositions[normalizedSymbol], strategyMetadata);
        delete cleanedState.pendingOperations[entryClientOrderId];
        cleanedState.updatedAt = new Date(now).toISOString();
        await writeJsonAtomic(TRADING_STATE_PATH, cleanedState);
      } else if (strategyMetadata && persist) {
        const reconciledState = structuredClone(currentState);
        reconciledState.managedPositions[normalizedSymbol] = mergeRecordedEntryMetadata(reconciledState.managedPositions[normalizedSymbol], strategyMetadata);
        reconciledState.updatedAt = new Date(now).toISOString();
        await writeJsonAtomic(TRADING_STATE_PATH, reconciledState);
      }
      return { status: strategyMetadata ? "IDEMPOTENT_EXISTING_TESTNET_ORDER_METADATA_RECONCILED" : "IDEMPOTENT_EXISTING_TESTNET_ORDER", venue: "BINANCE_USDM_TESTNET", order: existing, protectiveStop: existingStop, realOrdersSubmitted: 0 };
    }
    const context = await fetchEntryContext(normalizedSymbol, credentials, { fetchImpl, now });
    const live = nonFlatPositions(context.positions).find((position) => position.symbol === normalizedSymbol);
    invariant(live, "TESTNET_EXISTING_ENTRY_LIVE_POSITION_MISSING");
    invariant((Number(live.positionAmt) > 0 ? "BUY" : "SELL") === normalizedSide, "TESTNET_EXISTING_ENTRY_DIRECTION_MISMATCH");
    for (const position of nonFlatPositions(context.positions)) {
      invariant(position.symbol === normalizedSymbol || currentState.managedPositions?.[position.symbol], "TESTNET_UNMANAGED_EXISTING_POSITION");
    }
    const quantity = Math.abs(Number(live.positionAmt));
    if (EXECUTION_PROFILE === "ORION_V3" && pendingEntry?.postFillRiskVerificationRequired) assertFilledMarketOrderQuantity(existing, quantity, "TESTNET_V3_PENDING_RISK_POSITION_CHANGED");
    const entryPrice = Number(existing?.avgPrice) || Number(live.entryPrice);
    const executable = finitePositive(normalizedSide === "BUY" ? context.bookTicker?.bidPrice : context.bookTicker?.askPrice, "TESTNET_BOOK_TICKER_INVALID");
    const recoveryPlanBase = {
      intentId: normalizedIntentId,
      symbol: normalizedSymbol,
      side: normalizedSide,
      quantity,
      stopPrice: Number(input?.stopPrice),
      referencePrice: entryPrice,
      entryClientOrderId,
      stopClientOrderId,
      implementationRevision: input?.implementationRevision ?? null,
      evaluationCohortId: input?.evaluationCohortId ?? null,
      riskPolicyRevision: input?.riskPolicyRevision ?? null,
      riskPolicyAuthorizationId: input?.riskPolicyAuthorizationId ?? null,
      strategyMetadata: strategyMetadataForPosition(input?.strategyMetadata),
      ...(EXECUTION_PROFILE === "ORION_V3" ? {
        preFillRiskEvidence: pendingEntry?.preFillRiskEvidence ?? null,
        entryFourHourGateAtSubmission: pendingEntry?.entryFourHourGateAtSubmission ?? null,
        entryDualZGateAtSubmission: pendingEntry?.entryDualZGateAtSubmission ?? null,
        entrySingleZGateAtSubmission: pendingEntry?.entrySingleZGateAtSubmission ?? null,
        strategyEntryGuard: pendingEntry?.preFillRiskEvidence?.strategyEntryGuard ?? null,
        preservedEntryTiming: currentState.managedPositions?.[normalizedSymbol] ? {
          openedAt: currentState.managedPositions[normalizedSymbol].openedAt,
          entryObservedAt: currentState.managedPositions[normalizedSymbol].entryObservedAt,
          entryFillTimeEvidence: currentState.managedPositions[normalizedSymbol].entryFillTimeEvidence,
        } : null,
      } : {}),
    };
    let normalizedStop;
    try {
      normalizedStop = protectiveStopForSymbol({
        exchangeInfo: context.exchangeInfo,
        symbol: normalizedSymbol,
        stopPrice: input?.stopPrice,
        direction: normalizedSide === "BUY" ? 1 : -1,
        referencePrice: executable,
      });
    } catch (error) {
      if (error?.message !== "TESTNET_STOP_NOT_PROTECTIVE") throw error;
      const rollbackClientOrderId = deterministicClientOrderId(normalizedIntentId, "rollback");
      const submittedRollback = await rollbackUnprotectedEntry(recoveryPlanBase, { ...existing, executedQty: quantity }, credentials, { fetchImpl, now });
      const resolvedRollback = await resolveFilledMarketOrder(submittedRollback, {
        symbol: normalizedSymbol,
        clientOrderId: rollbackClientOrderId,
        credentials,
        fetchImpl,
        now,
      });
      const rollback = assertFilledMarketOrder(resolvedRollback.order, quantity, "TESTNET_ENTRY_ROLLBACK_FILL_INCOMPLETE");
      const entryTradeCost = await safeOrderTradeCost(normalizedSymbol, existing?.orderId, credentials, { fetchImpl, now });
      const rollbackTradeCost = resolvedRollback.tradeCost ?? await safeOrderTradeCost(normalizedSymbol, rollback?.orderId, credentials, { fetchImpl, now });
      const outcome = buildRolledBackEntryOutcome({
        plan: recoveryPlanBase,
        entry: { ...existing, executedQty: quantity, avgPrice: entryPrice },
        entryTradeCost,
        rollback,
        rollbackTradeCost,
        now,
        reason: "UNPROTECTED_ENTRY_ROLLBACK_AFTER_STOP_CROSSED",
        source: "BINANCE_DEMO_PENDING_ENTRY_RECOVERY",
      });
      const nextState = structuredClone(currentState);
      nextState.pendingOperations ??= {};
      delete nextState.pendingOperations[entryClientOrderId];
      nextState.closedPositions = appendClosedOutcome(nextState, outcome);
      nextState.updatedAt = new Date(now).toISOString();
      if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
      if (persist) await recordAudit({
        schemaVersion: 1,
        eventType: "BINANCE_DEMO_UNPROTECTED_ENTRY_ROLLED_BACK_AFTER_STOP_CROSSED",
        occurredAt: new Date(now).toISOString(),
        venue: "BINANCE_USDM_TESTNET",
        symbol: normalizedSymbol,
        intentId: normalizedIntentId,
        entryOrderId: existing?.orderId ?? null,
        rollbackOrderId: rollback?.orderId ?? null,
        outcomeId: outcome.outcomeId,
        netPnlUsdt: outcome.netPnl,
        plannedStopPrice: Number(input?.stopPrice),
        executablePrice: executable,
        credentialsRecorded: false,
        productionHostUsed: false,
      });
      return {
        status: "BINANCE_DEMO_UNPROTECTED_ENTRY_ROLLED_BACK_AFTER_STOP_CROSSED",
        venue: "BINANCE_USDM_TESTNET",
        order: existing,
        rollback,
        outcome,
        recoveredState: nextState,
        realOrdersSubmitted: 0,
      };
    }
    const stopPrice = normalizedStop.stopPrice;
    const recoveryPlan = {
      ...recoveryPlanBase,
      stopPrice,
      stopPriceParam: normalizedStop.stopPriceParam,
      priceTickSize: normalizedStop.priceTickSize,
    };
    let protectiveStop = existingStop;
    if (!protectiveStop) {
      if (!(normalizedSide === "BUY" ? stopPrice < executable : stopPrice > executable)) {
        await rollbackUnprotectedEntry(recoveryPlan, existing, credentials, { fetchImpl, now });
        throw new Error("TESTNET_RECOVERY_STOP_NO_LONGER_PROTECTIVE_ENTRY_ROLLED_BACK");
      }
      try {
        protectiveStop = await submitRecoverableAlgo(algoStopParams(recoveryPlan), credentials, { fetchImpl, now });
      } catch {
        // A transport failure during recovery is not an exchange rejection.
        // V3 must establish the deterministic stop's status before a rollback.
        const recoveredStop = EXECUTION_PROFILE === "ORION_V3" ? await queryAlgoByClientId(stopClientOrderId, credentials, { fetchImpl, now }) : null;
        if (recoveredStop) protectiveStop = assertActiveProtectiveAlgo(recoveredStop, recoveryPlan);
        else {
          await rollbackUnprotectedEntry(recoveryPlan, existing, credentials, { fetchImpl, now });
          throw new Error("TESTNET_RECOVERY_PROTECTIVE_STOP_FAILED_ENTRY_ROLLED_BACK");
        }
      }
    }
    protectiveStop = assertActiveProtectiveAlgo(await queryAlgoByClientId(stopClientOrderId, credentials, { fetchImpl, now }), recoveryPlan);
    const entryTradeCost = await safeOrderTradeCost(normalizedSymbol, existing?.orderId, credentials, { fetchImpl, now });
    const nextState = structuredClone(currentState);
    if (EXECUTION_PROFILE === "ORION_V3") {
      nextState.pendingOperations ??= {};
      nextState.pendingOperations[entryClientOrderId] ??= { kind: "ENTRY", symbol: normalizedSymbol, preparedAt: now, input: structuredClone(input) };
      // This is recovery of a known fill: expired entry evidence must never
      // prevent its protection or authorize a second market entry.
      recoveryPlan.entryRiskEvidence = await verifyV3ProtectedEntryRisk({ plan: recoveryPlan, entry: { ...existing, executedQty: quantity, avgPrice: entryPrice }, entryTradeCost, protectiveStop, state: nextState, credentials, fetchImpl, now, persist });
    }
    const recoveredOpenedAt = EXECUTION_PROFILE === "ORION_V3" ? currentState.managedPositions?.[normalizedSymbol]?.openedAt ?? (Number(existing?.updateTime ?? existing?.time) || now) : now;
    nextState.managedPositions[normalizedSymbol] = managedPositionFromExecution(recoveryPlan, { ...existing, executedQty: quantity, avgPrice: entryPrice }, protectiveStop, recoveredOpenedAt, entryTradeCost);
    nextState.managedOrders[entryClientOrderId] = { symbol: normalizedSymbol, role: "ENTRY", orderId: existing?.orderId ?? null };
    nextState.managedOrders[stopClientOrderId] = { symbol: normalizedSymbol, role: "PROTECTIVE_STOP", orderKind: "ALGO", orderId: protectiveStop?.algoId ?? null };
    nextState.pendingOperations ??= {};
    delete nextState.pendingOperations[entryClientOrderId];
    nextState.updatedAt = new Date(now).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
    if (persist) await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_ENTRY_STATE_RECOVERED_IDEMPOTENTLY", occurredAt: new Date(now).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: normalizedSymbol, intentId: normalizedIntentId, entryOrderId: existing?.orderId ?? null, stopOrderId: protectiveStop?.algoId ?? null, ...(EXECUTION_PROFILE === "ORION_V3" ? { entryRiskEvidence: recoveryPlan.entryRiskEvidence } : {}), credentialsRecorded: false, productionHostUsed: false });
    return { status: "IDEMPOTENT_EXISTING_TESTNET_ENTRY_RECOVERED", venue: "BINANCE_USDM_TESTNET", order: existing, protectiveStop, recoveredState: nextState, realOrdersSubmitted: 0 };
  }
  if (EXECUTION_PROFILE === "ORION_V3") invariant(!pendingEntry?.postFillRiskVerificationRequired, "TESTNET_V3_PENDING_RISK_ENTRY_ORDER_UNKNOWN");
  if (EXECUTION_PROFILE === "ORION_V3") invariant(!pendingEntry, "TESTNET_V3_EXISTING_PENDING_ENTRY_REQUIRES_RECOVERY");
  const entryClock = typeof clock === "function" ? clock : () => now;
  let plan = await preflightMarketEntry(input, { credentials, fetchImpl, now, state: currentState, entryEvidenceProvider, entryQualityEvaluator });
  let priorCausalEvidence = plan.causalEntryEvidence;
  const leverageAlignment = await ensureSymbolInitialLeverage({
    symbol: plan.symbol,
    confirmation: input?.confirmation,
  }, { credentials, fetchImpl, now, persist });

  // Leverage alignment and the exchange order-test are network round trips.
  // Re-run the full preflight on a fresh BBO after each one so a price move or
  // signal expiry cannot slip through between the original check and the
  // matching-engine submission. The second check also revalidates risk sizing
  // at the updated executable price.
  const orderTestAt = entryClock();
  plan = await preflightMarketEntry(input, { credentials, fetchImpl, now: orderTestAt, state: currentState, entryEvidenceProvider, entryQualityEvaluator, priorCausalEvidence });
  priorCausalEvidence = plan.causalEntryEvidence;
  await requestJson("POST", "/fapi/v1/order/test", entryParams(plan), credentials, { fetchImpl, now: orderTestAt });
  const submissionAt = entryClock();
  plan = await preflightMarketEntry(input, { credentials, fetchImpl, now: submissionAt, state: currentState, entryEvidenceProvider, entryQualityEvaluator, priorCausalEvidence });
  let workingState = structuredClone(currentState);
  workingState.pendingOperations ??= {};
  workingState.pendingOperations[plan.entryClientOrderId] = {
    schemaVersion: 1,
    kind: "ENTRY",
    phase: "PREPARED",
    preparedAt: submissionAt,
    symbol: plan.symbol,
    clientOrderId: plan.entryClientOrderId,
    ...(EXECUTION_PROFILE === "ORION_V3" ? { preparationId: crypto.randomUUID(), preFillRiskEvidence: structuredClone(plan.preFillRiskEvidence), entryFourHourGateAtSubmission: structuredClone(plan.entryFourHourGateAtSubmission), entryDualZGateAtSubmission: structuredClone(plan.entryDualZGateAtSubmission), entrySingleZGateAtSubmission: structuredClone(plan.entrySingleZGateAtSubmission) } : {}),
    input: {
      intentId: plan.intentId,
      symbol: plan.symbol,
      side: plan.side,
      quantity: plan.quantity,
      stopPrice: plan.stopPrice,
      entryGuard: input.entryGuard,
      implementationRevision: plan.implementationRevision,
      evaluationCohortId: plan.evaluationCohortId,
      riskPolicyRevision: plan.riskPolicyRevision,
      riskPolicyAuthorizationId: plan.riskPolicyAuthorizationId,
      strategyMetadata: plan.strategyMetadata,
      causalEntryEvidence: plan.causalEntryEvidence,
      entryQuality: plan.entryQuality,
      confirmation: TESTNET_CONFIRMATION,
    },
  };
  workingState.updatedAt = new Date(submissionAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  if (persist && EXECUTION_PROFILE === "ORION_V3") await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_V3_ENTRY_RISK_BEFORE_SUBMISSION", occurredAt: new Date(submissionAt).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: plan.symbol, intentId: plan.intentId, preFillRiskEvidence: plan.preFillRiskEvidence, preFillEvidenceHash: sha256(stableStringify(plan.preFillRiskEvidence)), entryFourHourGateAtSubmission: plan.entryFourHourGateAtSubmission, entryDualZGateAtSubmission: plan.entryDualZGateAtSubmission, entrySingleZGateAtSubmission: plan.entrySingleZGateAtSubmission, credentialsRecorded: false, productionHostUsed: false });
  const entrySubmittedAt = entryClock();
  if (EXECUTION_PROFILE === "ORION_V3") {
    try {
      validateStrategyEntryGuard(input.entryGuard, plan.referencePrice, entrySubmittedAt);
      plan.entryFourHourGateAtSubmission = validateV3FourHourEntryGuard(input, entrySubmittedAt);
      plan.entryDualZGateAtSubmission = validateV3DualZEntryGuard(input, entrySubmittedAt);
      plan.entrySingleZGateAtSubmission = validateV3SingleZEntryGuard(input, entrySubmittedAt);
    } catch (error) {
      // This catch encloses only local validation before the first POST. Never
      // use it for a request failure, an older preparation, or an unknown fill.
      const preparationId = workingState.pendingOperations[plan.entryClientOrderId].preparationId;
      const latestState = persist ? await readJson(TRADING_STATE_PATH, null) : workingState;
      const cancelled = cancelUnsubmittedV3PreparedEntry(latestState, { operationId: plan.entryClientOrderId, preparationId, now: entrySubmittedAt, reason: error.message });
      if (persist) {
        await writeJsonAtomic(TRADING_STATE_PATH, cancelled.nextState);
        await recordAudit(cancelled.event);
      }
      error.recoveredState = cancelled.nextState;
      error.cancelledPreparationEvent = cancelled.event;
      throw error;
    }
  }
  let entry = await submitRecoverable(entryParams(plan), credentials, { fetchImpl, now: entrySubmittedAt });
  // Protection is the first post-fill obligation. Binance Demo may return a
  // fully-filled market order with avgPrice=0; accounting hydration must never
  // delay the already-planned full-position protective stop.
  entry = assertFilledMarketOrderQuantity(entry, plan.quantity, "TESTNET_ENTRY_FILL_INCOMPLETE");
  workingState.pendingOperations[plan.entryClientOrderId].phase = "ENTRY_FILLED";
  workingState.pendingOperations[plan.entryClientOrderId].entryOrderId = entry.orderId ?? null;
  if (EXECUTION_PROFILE === "ORION_V3") {
    workingState.pendingOperations[plan.entryClientOrderId].entryFill = structuredClone(entry);
    workingState.pendingOperations[plan.entryClientOrderId].entryFourHourGateAtSubmission = structuredClone(plan.entryFourHourGateAtSubmission);
    workingState.pendingOperations[plan.entryClientOrderId].entryDualZGateAtSubmission = structuredClone(plan.entryDualZGateAtSubmission);
    workingState.pendingOperations[plan.entryClientOrderId].entrySingleZGateAtSubmission = structuredClone(plan.entrySingleZGateAtSubmission);
  }
  workingState.updatedAt = new Date(entrySubmittedAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  let protectiveStop;
  try {
    const stopSubmittedAt = entryClock();
    await submitRecoverableAlgo(algoStopParams(plan), credentials, { fetchImpl, now: stopSubmittedAt });
    protectiveStop = assertActiveProtectiveAlgo(await queryAlgoByClientId(plan.stopClientOrderId, credentials, { fetchImpl, now: entryClock() }), plan);
    workingState.pendingOperations[plan.entryClientOrderId].phase = "PROTECTION_VERIFIED";
    workingState.pendingOperations[plan.entryClientOrderId].stopOrderId = protectiveStop?.algoId ?? protectiveStop?.orderId ?? null;
    workingState.updatedAt = new Date(stopSubmittedAt).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  } catch {
    // A failed verification request is not proof that Binance rejected the
    // stop mutation. Re-query the deterministic stop first: if it is active,
    // keep the protected position; if its state is still unknowable, leave the
    // pending operation for fail-closed recovery instead of flattening beside
    // a possibly-live orphan stop.
    const recoveredProtectiveStop = await queryAlgoByClientId(plan.stopClientOrderId, credentials, { fetchImpl, now: entryClock() });
    if (recoveredProtectiveStop) {
      protectiveStop = assertActiveProtectiveAlgo(recoveredProtectiveStop, plan);
      workingState.pendingOperations[plan.entryClientOrderId].phase = "PROTECTION_VERIFIED";
      workingState.pendingOperations[plan.entryClientOrderId].stopOrderId = protectiveStop?.algoId ?? protectiveStop?.orderId ?? null;
      workingState.updatedAt = new Date(entryClock()).toISOString();
      if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
    } else {
      const rollbackClientOrderId = deterministicClientOrderId(plan.intentId, "rollback");
    const submittedRollback = await rollbackUnprotectedEntry(plan, entry, credentials, { fetchImpl, now: entryClock() });
    const rollbackQuantityConfirmed = assertFilledMarketOrderQuantity(submittedRollback, plan.quantity, "TESTNET_ENTRY_ROLLBACK_FILL_INCOMPLETE");
    workingState.pendingOperations[plan.entryClientOrderId].phase = "ROLLBACK_FILLED";
    workingState.pendingOperations[plan.entryClientOrderId].rollbackOrderId = rollbackQuantityConfirmed.orderId ?? null;
    workingState.updatedAt = new Date(entryClock()).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
    const resolvedRollback = await resolveFilledMarketOrder(rollbackQuantityConfirmed, {
      symbol: plan.symbol,
      clientOrderId: rollbackClientOrderId,
      credentials,
      fetchImpl,
      now: entryClock(),
    });
    const rollback = resolvedRollback.order;
    assertFilledMarketOrder(rollback, plan.quantity, "TESTNET_ENTRY_ROLLBACK_FILL_INCOMPLETE");
    const resolvedEntryAfterRollback = await resolveFilledMarketOrder(entry, {
      symbol: plan.symbol,
      clientOrderId: plan.entryClientOrderId,
      credentials,
      fetchImpl,
      now: entryClock(),
    });
    entry = assertFilledMarketOrder(resolvedEntryAfterRollback.order, plan.quantity, "TESTNET_ENTRY_FILL_INCOMPLETE");
    const entryTradeCost = resolvedEntryAfterRollback.tradeCost ?? await safeOrderTradeCost(plan.symbol, entry?.orderId, credentials, { fetchImpl, now: entryClock() });
    const rollbackTradeCost = resolvedRollback.tradeCost ?? await safeOrderTradeCost(plan.symbol, rollback?.orderId, credentials, { fetchImpl, now: entryClock() });
    const outcome = buildRolledBackEntryOutcome({
      plan,
      entry,
      entryTradeCost,
      rollback,
      rollbackTradeCost,
      now: entryClock(),
      reason: "PROTECTIVE_STOP_SUBMISSION_FAILED_ENTRY_ROLLBACK",
      source: "BINANCE_DEMO_ENTRY_LIFECYCLE_ROLLBACK",
    });
    workingState.pendingOperations ??= {};
    delete workingState.pendingOperations[plan.entryClientOrderId];
    workingState.closedPositions = appendClosedOutcome(workingState, outcome);
    workingState.updatedAt = new Date(entryClock()).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
    if (persist) await recordAudit({
      schemaVersion: 1,
      eventType: "TESTNET_ENTRY_ROLLED_BACK_AFTER_PROTECTIVE_STOP_FAILURE",
      occurredAt: new Date(submissionAt).toISOString(),
      venue: "BINANCE_USDM_TESTNET",
      symbol: plan.symbol,
      intentId: plan.intentId,
      entryOrderId: entry?.orderId ?? null,
      rollbackOrderId: rollback?.orderId ?? null,
      outcomeId: outcome.outcomeId,
      netPnlUsdt: outcome.netPnl,
      credentialsRecorded: false,
      productionHostUsed: false,
    });
    throw new Error("TESTNET_PROTECTIVE_STOP_FAILED_ENTRY_ROLLED_BACK");
    }
  }
  const resolvedEntry = await resolveFilledMarketOrder(entry, {
    symbol: plan.symbol,
    clientOrderId: plan.entryClientOrderId,
    credentials,
    fetchImpl,
    now: entryClock(),
  });
  entry = assertFilledMarketOrder(resolvedEntry.order, plan.quantity, "TESTNET_ENTRY_FILL_INCOMPLETE");
  const positionsAfterEntry = await requestJson("GET", "/fapi/v2/positionRisk", { symbol: plan.symbol }, credentials, { fetchImpl, now: entryClock() });
  assertOneWayPositionRows(positionsAfterEntry);
  const liveAfterEntry = nonFlatPositions(positionsAfterEntry).find((row) => row.symbol === plan.symbol);
  invariant(liveAfterEntry, "TESTNET_ENTRY_POSITION_NOT_OBSERVED");
  invariant((Number(liveAfterEntry.positionAmt) > 0 ? "BUY" : "SELL") === plan.side, "TESTNET_ENTRY_POSITION_DIRECTION_MISMATCH");
  invariant(Math.abs(Math.abs(Number(liveAfterEntry.positionAmt)) - plan.quantity) <= 1e-8, "TESTNET_ENTRY_POSITION_QUANTITY_MISMATCH");
  const entryTradeCost = resolvedEntry.tradeCost ?? await safeOrderTradeCost(plan.symbol, entry?.orderId, credentials, { fetchImpl, now: entryClock() });
  const nextState = structuredClone(workingState);
  if (EXECUTION_PROFILE === "ORION_V3") plan.entryRiskEvidence = await verifyV3ProtectedEntryRisk({ plan, entry, entryTradeCost, protectiveStop, state: nextState, credentials, fetchImpl, now: entryClock(), persist });
  nextState.managedPositions[plan.symbol] = managedPositionFromExecution(plan, entry, protectiveStop, submissionAt, entryTradeCost);
  nextState.managedOrders[plan.entryClientOrderId] = { symbol: plan.symbol, role: "ENTRY", orderId: entry?.orderId ?? null };
  nextState.managedOrders[plan.stopClientOrderId] = { symbol: plan.symbol, role: "PROTECTIVE_STOP", orderKind: "ALGO", orderId: protectiveStop?.algoId ?? null };
  delete nextState.pendingOperations[plan.entryClientOrderId];
  nextState.updatedAt = new Date(submissionAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  const audit = persist ? await recordAudit({
    schemaVersion: 1,
    eventType: "BINANCE_DEMO_MARKET_ENTRY_WITH_PROTECTIVE_STOP_SUBMITTED",
    occurredAt: new Date(submissionAt).toISOString(),
    venue: "BINANCE_USDM_TESTNET",
    symbol: plan.symbol,
    side: plan.side,
    quantity: nextState.managedPositions[plan.symbol].quantity,
    stopPrice: plan.stopPrice,
    plannedRiskUsdt: plan.plannedRiskUsdt,
    ...(EXECUTION_PROFILE === "ORION_V3" ? { entryRiskEvidence: plan.entryRiskEvidence, actualInitialPlannedRiskUsdt: nextState.managedPositions[plan.symbol].initialPlannedRiskUsdt } : {}),
    entryOrderId: entry?.orderId ?? null,
    stopOrderId: protectiveStop?.algoId ?? null,
    credentialsRecorded: false,
    productionHostUsed: false,
  }) : null;
  return {
    status: "BINANCE_DEMO_ENTRY_AND_PROTECTIVE_STOP_SUBMITTED",
    venue: "BINANCE_USDM_TESTNET",
    entry,
    protectiveStop,
    leverageAlignment,
    ...(EXECUTION_PROFILE === "ORION_V3" ? { entryRiskEvidence: plan.entryRiskEvidence, recoveredState: nextState } : {}),
    auditEventHash: audit?.eventHash ?? null,
    realOrdersSubmitted: 0,
  };
}

export async function reconcileRolledBackEntryOutcome(input, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null, persist = true } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(input?.confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const intentId = normalizeIntentId(input?.intentId);
  const symbol = normalizeTestnetSymbol(input?.symbol);
  const side = String(input?.side ?? "").toUpperCase();
  invariant(side === "BUY" || side === "SELL", "TESTNET_SIDE_INVALID");
  const quantity = finitePositive(input?.quantity, "TESTNET_ROLLBACK_RECONCILIATION_QUANTITY_INVALID");
  const stopPrice = finitePositive(input?.stopPrice, "TESTNET_ROLLBACK_RECONCILIATION_STOP_INVALID");
  const entryClientOrderId = deterministicClientOrderId(intentId, "entry");
  const rollbackClientOrderId = deterministicClientOrderId(intentId, "rollback");
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  invariant(!currentState.managedPositions?.[symbol], "TESTNET_ROLLBACK_RECONCILIATION_LOCAL_POSITION_STILL_MANAGED");
  const existingOutcome = (currentState.closedPositions ?? []).find((row) => row?.intentId === intentId && row?.finalClientOrderId === rollbackClientOrderId);
  if (existingOutcome) return { status: "BINANCE_DEMO_ENTRY_ROLLBACK_OUTCOME_ALREADY_RECONCILED", outcome: existingOutcome, nextState: currentState, realOrdersSubmitted: 0 };

  const [entryResult, rollbackResult, positions] = await Promise.all([
    queryByClientOrderId(symbol, entryClientOrderId, credentials, { fetchImpl, now }),
    queryByClientOrderId(symbol, rollbackClientOrderId, credentials, { fetchImpl, now }),
    requestJson("GET", "/fapi/v2/positionRisk", { symbol }, credentials, { fetchImpl, now }),
  ]);
  assertOneWayPositionRows(positions);
  invariant(!nonFlatPositions(positions).some((row) => row.symbol === symbol), "TESTNET_ROLLBACK_RECONCILIATION_POSITION_NOT_FLAT");
  invariant(entryResult, "TESTNET_ROLLBACK_RECONCILIATION_ENTRY_MISSING");
  invariant(rollbackResult, "TESTNET_ROLLBACK_RECONCILIATION_ROLLBACK_MISSING");
  const resolvedEntry = await resolveFilledMarketOrder(entryResult, { symbol, clientOrderId: entryClientOrderId, credentials, fetchImpl, now });
  const resolvedRollback = await resolveFilledMarketOrder(rollbackResult, { symbol, clientOrderId: rollbackClientOrderId, credentials, fetchImpl, now });
  const entry = assertFilledMarketOrder(resolvedEntry.order, quantity, "TESTNET_ROLLBACK_RECONCILIATION_ENTRY_INCOMPLETE");
  const rollback = assertFilledMarketOrder(resolvedRollback.order, quantity, "TESTNET_ROLLBACK_RECONCILIATION_ROLLBACK_INCOMPLETE");
  invariant(entry.side === side, "TESTNET_ROLLBACK_RECONCILIATION_ENTRY_DIRECTION_MISMATCH");
  invariant(rollback.side === (side === "BUY" ? "SELL" : "BUY") && rollback.reduceOnly === true, "TESTNET_ROLLBACK_RECONCILIATION_NOT_REDUCE_ONLY");
  const entryTradeCost = resolvedEntry.tradeCost ?? await safeOrderTradeCost(symbol, entry.orderId, credentials, { fetchImpl, now });
  const rollbackTradeCost = resolvedRollback.tradeCost ?? await safeOrderTradeCost(symbol, rollback.orderId, credentials, { fetchImpl, now });
  const plan = {
    intentId,
    symbol,
    side,
    quantity,
    stopPrice,
    referencePrice: Number(entry.avgPrice),
    entryClientOrderId,
    stopClientOrderId: deterministicClientOrderId(intentId, "stop"),
    implementationRevision: input?.implementationRevision ?? null,
    evaluationCohortId: input?.evaluationCohortId ?? null,
    riskPolicyRevision: input?.riskPolicyRevision ?? null,
    riskPolicyAuthorizationId: input?.riskPolicyAuthorizationId ?? null,
    strategyMetadata: strategyMetadataForPosition(input?.strategyMetadata),
  };
  const outcome = buildRolledBackEntryOutcome({
    plan,
    entry,
    entryTradeCost,
    rollback,
    rollbackTradeCost,
    now,
    reason: "UNPROTECTED_ENTRY_ROLLBACK_AFTER_STOP_CROSSED",
    source: "BINANCE_DEMO_SIGNED_ORDER_AND_USER_TRADES_RECONCILIATION",
  });
  invariant(outcome.completeFinalFill && outcome.actualCommissionEvidenceComplete && outcome.exchangeRealizedPnlEvidenceComplete, "TESTNET_ROLLBACK_RECONCILIATION_EVIDENCE_INCOMPLETE");
  const nextState = structuredClone(currentState);
  nextState.pendingOperations ??= {};
  delete nextState.pendingOperations[entryClientOrderId];
  nextState.closedPositions = appendClosedOutcome(nextState, outcome);
  nextState.updatedAt = new Date(now).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  if (persist) await recordAudit({
    schemaVersion: 1,
    eventType: "BINANCE_DEMO_ENTRY_ROLLBACK_OUTCOME_RECONCILED",
    occurredAt: new Date(now).toISOString(),
    venue: "BINANCE_USDM_TESTNET",
    symbol,
    intentId,
    entryOrderId: entry.orderId ?? null,
    rollbackOrderId: rollback.orderId ?? null,
    outcomeId: outcome.outcomeId,
    netPnlUsdt: outcome.netPnl,
    credentialsRecorded: false,
    productionHostUsed: false,
  });
  return { status: "BINANCE_DEMO_ENTRY_ROLLBACK_OUTCOME_RECONCILED", outcome, nextState, realOrdersSubmitted: 0 };
}

export async function reduceManagedPosition({ intentId, symbol, quantity, reason, confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), clock = null, state = null, persist = true, requireExistingOrder = false } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedIntentId = normalizeIntentId(intentId);
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const requestNow = typeof clock === "function" ? clock : () => now;
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managed = currentState.managedPositions?.[normalizedSymbol];
  invariant(managed, "TESTNET_MANAGED_POSITION_NOT_FOUND");
  const [positions, exchangeInfo] = await Promise.all([
    requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now: requestNow() }),
    publicJson("/fapi/v1/exchangeInfo", {}, { fetchImpl }),
  ]);
  assertOneWayPositionRows(positions);
  const live = nonFlatPositions(positions).find((position) => position.symbol === normalizedSymbol);
  invariant(live, "TESTNET_LIVE_POSITION_NOT_FOUND");
  const liveQuantity = Math.abs(Number(live.positionAmt));
  const symbolInfo = exchangeInfo?.symbols?.find((row) => row.symbol === normalizedSymbol);
  const lot = filterFor(symbolInfo, "MARKET_LOT_SIZE") ?? filterFor(symbolInfo, "LOT_SIZE");
  const reducedQuantity = floorToStep(Math.min(finitePositive(quantity, "TESTNET_REDUCE_QUANTITY_INVALID"), liveQuantity), Number(lot?.stepSize ?? 0));
  const clientOrderId = deterministicClientOrderId(normalizedIntentId, String(reason ?? "reduce").slice(0, 8));
  const existingOrder = await queryByClientOrderId(normalizedSymbol, clientOrderId, credentials, { fetchImpl, now: requestNow() });
  invariant(existingOrder || !requireExistingOrder, "TESTNET_EXPECTED_PARTIAL_REDUCTION_ORDER_NOT_FOUND");
  invariant(existingOrder || (reducedQuantity > 0 && reducedQuantity < liveQuantity), "TESTNET_PARTIAL_REDUCTION_MUST_LEAVE_POSITION");
  const params = { symbol: normalizedSymbol, side: Number(live.positionAmt) > 0 ? "SELL" : "BUY", type: "MARKET", quantity: stepFormatted(reducedQuantity, Number(lot?.stepSize ?? 0)), reduceOnly: true, newClientOrderId: clientOrderId, newOrderRespType: "RESULT" };
  let workingState = currentState;
  if (!existingOrder && persist) {
    workingState = structuredClone(currentState);
    workingState.pendingOperations ??= {};
    workingState.pendingOperations[clientOrderId] = {
      kind: "PARTIAL_REDUCE",
      symbol: normalizedSymbol,
      preparedAt: requestNow(),
      input: { intentId: normalizedIntentId, symbol: normalizedSymbol, quantity: reducedQuantity, reason, confirmation },
    };
    workingState.updatedAt = new Date(requestNow()).toISOString();
    await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  }
  if (!existingOrder) await requestJson("POST", "/fapi/v1/order/test", params, credentials, { fetchImpl, now: requestNow() });
  const submittedOrder = existingOrder ?? await submitRecoverable(params, credentials, { fetchImpl, now: requestNow() });
  invariant(submittedOrder?.status === "FILLED" && Math.abs(Number(submittedOrder?.executedQty) - reducedQuantity) <= 1e-8, existingOrder ? "TESTNET_PARTIAL_REDUCTION_FILL_INCOMPLETE" : "TESTNET_PARTIAL_REDUCTION_FILL_QUANTITY_MISMATCH");
  const tradeCost = await safeOrderTradeCost(normalizedSymbol, submittedOrder?.orderId, credentials, { fetchImpl, now: requestNow() });
  const order = { ...hydrateFilledOrderAverageFromTrades(submittedOrder, tradeCost), tradeCost };
  assertFilledMarketOrder(order, reducedQuantity, "TESTNET_PARTIAL_REDUCTION_FILL_INCOMPLETE");
  const executedQuantity = Number(order.executedQty);
  const positionsAfterReduction = await requestJson("GET", "/fapi/v2/positionRisk", { symbol: normalizedSymbol }, credentials, { fetchImpl, now: requestNow() });
  assertOneWayPositionRows(positionsAfterReduction);
  const liveAfterReduction = nonFlatPositions(positionsAfterReduction).find((position) => position.symbol === normalizedSymbol);
  const remainingQuantity = Math.abs(Number(liveAfterReduction?.positionAmt));
  const expectedRemaining = existingOrder ? liveQuantity : Math.max(0, liveQuantity - executedQuantity);
  invariant(Math.abs(remainingQuantity - expectedRemaining) <= 1e-8, "TESTNET_PARTIAL_REDUCTION_POSITION_QUANTITY_MISMATCH");
  invariant(remainingQuantity > 0, "TESTNET_PARTIAL_REDUCTION_MUST_LEAVE_POSITION");
  const nextState = structuredClone(workingState);
  nextState.managedPositions[normalizedSymbol].quantity = remainingQuantity;
  nextState.managedPositions[normalizedSymbol].remainingQuantity = remainingQuantity;
  nextState.managedOrders[clientOrderId] = { symbol: normalizedSymbol, role: String(reason ?? "PARTIAL_REDUCE"), orderId: order?.orderId ?? null };
  delete nextState.pendingOperations?.[clientOrderId];
  const completedAt = requestNow();
  nextState.updatedAt = new Date(completedAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  if (persist) await recordAudit({ schemaVersion: 1, eventType: existingOrder ? "BINANCE_DEMO_MANAGED_POSITION_PARTIAL_RECOVERED_IDEMPOTENTLY" : "BINANCE_DEMO_MANAGED_POSITION_PARTIALLY_REDUCED", occurredAt: new Date(completedAt).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: normalizedSymbol, quantity: executedQuantity, remainingQuantity, reason, orderId: order?.orderId ?? null, averagePrice: Number(order?.avgPrice), averagePriceEvidence: order?.averagePriceEvidence ?? "BINANCE_DEMO_ORDER_RESULT", credentialsRecorded: false, productionHostUsed: false });
  return { status: existingOrder ? "BINANCE_DEMO_MANAGED_POSITION_PARTIAL_RECOVERED_IDEMPOTENTLY" : "BINANCE_DEMO_MANAGED_POSITION_PARTIALLY_REDUCED", venue: "BINANCE_USDM_TESTNET", quantity: executedQuantity, remainingQuantity, idempotentRecovery: Boolean(existingOrder), order, nextState, realOrdersSubmitted: 0 };
}

export async function replaceManagedProtectiveStop({ intentId, symbol, stopPrice, role = "stopnext", confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), clock = null, state = null, persist = true } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedIntentId = normalizeIntentId(intentId);
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const requestNow = typeof clock === "function" ? clock : () => now;
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managed = currentState.managedPositions?.[normalizedSymbol];
  invariant(managed, "TESTNET_MANAGED_POSITION_NOT_FOUND");
  const [positions, exchangeInfo, book] = await Promise.all([
    requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now: requestNow() }),
    publicJson("/fapi/v1/exchangeInfo", {}, { fetchImpl }),
    publicJson("/fapi/v1/ticker/bookTicker", { symbol: normalizedSymbol }, { fetchImpl }),
  ]);
  assertOneWayPositionRows(positions);
  const live = nonFlatPositions(positions).find((position) => position.symbol === normalizedSymbol);
  invariant(live, "TESTNET_LIVE_POSITION_NOT_FOUND");
  const direction = Number(live.positionAmt) > 0 ? 1 : -1;
  const prior = Number(managed.stopPrice ?? managed.stop);
  const symbolInfo = exchangeInfo?.symbols?.find((row) => row.symbol === normalizedSymbol);
  const tick = Number(filterFor(symbolInfo, "PRICE_FILTER")?.tickSize ?? 0);
  const nextStop = stopToTick(finitePositive(stopPrice, "TESTNET_STOP_PRICE_INVALID"), tick, direction);
  invariant(direction === 1 ? nextStop > prior : nextStop < prior, "TESTNET_STOP_MUST_ONLY_TIGHTEN");
  const executable = finitePositive(direction === 1 ? book?.bidPrice : book?.askPrice, "TESTNET_BOOK_TICKER_INVALID");
  invariant(direction === 1 ? nextStop < executable : nextStop > executable, "TESTNET_REPLACEMENT_STOP_NOT_PROTECTIVE");
  const pending = managed.pendingStopReplacement;
  const replacementIntentId = `stop-replace:${sha256(stableStringify({ normalizedIntentId, role, symbol: normalizedSymbol, priorClientOrderId: managed.stopClientOrderId, nextStop })).slice(0, 24)}`;
  const requestedClientOrderId = deterministicClientOrderId(replacementIntentId, String(role).slice(0, 8));
  const resumesPendingReplacement = pending && Number(pending.targetStopPrice) === nextStop && pending.targetClientOrderId;
  const clientOrderId = resumesPendingReplacement ? pending.targetClientOrderId : requestedClientOrderId;
  const paramsFor = (triggerPrice, algoClientOrderId) => ({
    algoType: "CONDITIONAL",
    symbol: normalizedSymbol,
    side: direction === 1 ? "SELL" : "BUY",
    type: "STOP_MARKET",
    triggerPrice: stepFormatted(triggerPrice, tick),
    closePosition: true,
    workingType: "MARK_PRICE",
    priceProtect: true,
    clientAlgoId: algoClientOrderId,
    newOrderRespType: "ACK",
  });
  const verifiedStop = async (order, triggerPrice, algoClientOrderId) => {
    const queried = await queryAlgoByClientId(algoClientOrderId, credentials, { fetchImpl, now: requestNow() });
    return assertActiveProtectiveAlgo(queried ?? order, {
      symbol: normalizedSymbol,
      side: direction === 1 ? "BUY" : "SELL",
      stopPrice: triggerPrice,
      stopClientOrderId: algoClientOrderId,
    });
  };
  const commitStop = async (sourceState, order, committedStop, committedClientOrderId, replacedClientOrderId, status, eventType) => {
    const nextState = structuredClone(sourceState);
    if (replacedClientOrderId) delete nextState.managedOrders[replacedClientOrderId];
    const nextManaged = nextState.managedPositions[normalizedSymbol];
    nextManaged.stopPrice = committedStop;
    nextManaged.stop = committedStop;
    nextManaged.stopClientOrderId = committedClientOrderId;
    nextManaged.stopOrderId = order?.algoId ?? null;
    nextManaged.stopAlgoId = order?.algoId ?? null;
    delete nextManaged.pendingStopReplacement;
    nextState.managedOrders[committedClientOrderId] = { symbol: normalizedSymbol, role: "PROTECTIVE_STOP", orderKind: "ALGO", orderId: order?.algoId ?? null };
    const committedAt = requestNow();
    nextState.updatedAt = new Date(committedAt).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
    if (persist) await recordAudit({ schemaVersion: 1, eventType, occurredAt: new Date(committedAt).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: normalizedSymbol, priorStop: prior, stopPrice: committedStop, orderId: order?.algoId ?? null, targetStopPrice: nextStop, credentialsRecorded: false, productionHostUsed: false });
    return { status, venue: "BINANCE_USDM_TESTNET", stopPrice: committedStop, order, nextState, realOrdersSubmitted: 0 };
  };

  let workingState = structuredClone(currentState);
  if (!resumesPendingReplacement) {
    const preparedAt = requestNow();
    workingState.managedPositions[normalizedSymbol].pendingStopReplacement = {
      schemaVersion: 1,
      phase: "PREPARED",
      preparedAt,
      priorStopPrice: prior,
      priorClientOrderId: managed.stopClientOrderId,
      targetStopPrice: nextStop,
      targetClientOrderId: clientOrderId,
      role,
    };
    workingState.updatedAt = new Date(preparedAt).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  }

  const existingTarget = await queryAlgoByClientId(clientOrderId, credentials, { fetchImpl, now: requestNow() });
  if (existingTarget && ["NEW", "PENDING_NEW"].includes(String(existingTarget.algoStatus ?? existingTarget.status))) {
    await cancelAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: requestNow() });
    return commitStop(workingState, await verifiedStop(existingTarget, nextStop, clientOrderId), nextStop, clientOrderId, managed.stopClientOrderId, "BINANCE_DEMO_PROTECTIVE_STOP_TIGHTENED_IDEMPOTENTLY", "BINANCE_DEMO_PROTECTIVE_STOP_TIGHTENED_IDEMPOTENTLY");
  }

  await cancelAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: requestNow() });
  const oldStopCanceledAt = requestNow();
  workingState.managedPositions[normalizedSymbol].pendingStopReplacement.phase = "OLD_STOP_CANCELED";
  workingState.managedPositions[normalizedSymbol].pendingStopReplacement.oldStopCanceledAt = oldStopCanceledAt;
  workingState.updatedAt = new Date(oldStopCanceledAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);

  let order;
  try {
    order = await submitRecoverableAlgo(paramsFor(nextStop, clientOrderId), credentials, { fetchImpl, now: requestNow() });
  } catch (replacementError) {
    const [positionsAfterFailure, freshBook] = await Promise.all([
      requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now: requestNow() }),
      publicJson("/fapi/v1/ticker/bookTicker", { symbol: normalizedSymbol }, { fetchImpl }),
    ]);
    const liveAfterFailure = nonFlatPositions(positionsAfterFailure).find((position) => position.symbol === normalizedSymbol);
    if (!liveAfterFailure) throw new Error("TESTNET_POSITION_CLOSED_DURING_STOP_REPLACEMENT");
    const freshExecutable = finitePositive(direction === 1 ? freshBook?.bidPrice : freshBook?.askPrice, "TESTNET_BOOK_TICKER_INVALID");
    const priorStillProtective = direction === 1 ? prior < freshExecutable : prior > freshExecutable;
    if (priorStillProtective) {
      const recoveryIntentId = `stop-restore:${sha256(stableStringify({ clientOrderId, prior })).slice(0, 24)}`;
      const recoveryClientOrderId = deterministicClientOrderId(recoveryIntentId, "restore");
      let recoveryOrder;
      try {
        recoveryOrder = await submitRecoverableAlgo(paramsFor(prior, recoveryClientOrderId), credentials, { fetchImpl, now: requestNow() });
        recoveryOrder = await verifiedStop(recoveryOrder, prior, recoveryClientOrderId);
      } catch {
        recoveryOrder = null;
      }
      if (recoveryOrder) {
        await commitStop(workingState, recoveryOrder, prior, recoveryClientOrderId, managed.stopClientOrderId, "BINANCE_DEMO_PRIOR_PROTECTIVE_STOP_RESTORED", "BINANCE_DEMO_STOP_REPLACEMENT_FAILED_PRIOR_PROTECTION_RESTORED");
        throw new Error("TESTNET_REPLACEMENT_STOP_FAILED_PRIOR_PROTECTION_RESTORED");
      }
    }
    try {
      await closeManagedPosition({ intentId: `${normalizedIntentId}:protection-rollback`, symbol: normalizedSymbol, reason: "PROTECTIVE_STOP_REPLACEMENT_RECOVERY_FAILED", confirmation }, { credentials, fetchImpl, now: requestNow(), clock, state: workingState, persist });
    } catch (rollbackError) {
      if (persist) await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_CRITICAL_PROTECTION_RECOVERY_AND_ROLLBACK_FAILED", occurredAt: new Date(requestNow()).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: normalizedSymbol, replacementError: replacementError?.message ?? String(replacementError), rollbackError: rollbackError?.message ?? String(rollbackError), credentialsRecorded: false, productionHostUsed: false });
      throw new Error("TESTNET_PROTECTION_RECOVERY_AND_ROLLBACK_FAILED");
    }
    throw new Error("TESTNET_REPLACEMENT_STOP_FAILED_POSITION_ROLLED_BACK");
  }
  order = await verifiedStop(order, nextStop, clientOrderId);
  return commitStop(workingState, order, nextStop, clientOrderId, managed.stopClientOrderId, "BINANCE_DEMO_PROTECTIVE_STOP_TIGHTENED", "BINANCE_DEMO_PROTECTIVE_STOP_TIGHTENED");
}

export async function persistManagedPositionMetadata(symbol, metadata, { now = Date.now(), state = null } = {}) {
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  invariant(currentState.managedPositions?.[normalizedSymbol], "TESTNET_MANAGED_POSITION_NOT_FOUND");
  const nextState = structuredClone(currentState);
  nextState.managedPositions[normalizedSymbol] = mergeRecordedEntryMetadata(nextState.managedPositions[normalizedSymbol], metadata);
  if (metadata?.pendingStopReplacement === null) delete nextState.managedPositions[normalizedSymbol].pendingStopReplacement;
  nextState.updatedAt = new Date(now).toISOString();
  await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  return nextState;
}

export async function loadManagedTradingState() {
  return readJson(TRADING_STATE_PATH, defaultState());
}

export async function finalizeManagedPositionAbsentOnExchange({ symbol, reason = "PROTECTIVE_STOP_OR_EXTERNAL_CLOSE" }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null } = {}) {
  await assertMatchingEngineActivation();
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managed = currentState.managedPositions?.[normalizedSymbol];
  invariant(managed, "TESTNET_MANAGED_POSITION_NOT_FOUND");
  const positions = await requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now });
  assertOneWayPositionRows(positions);
  invariant(!nonFlatPositions(positions).some((position) => position.symbol === normalizedSymbol), "TESTNET_LIVE_POSITION_STILL_PRESENT");
  let finalAlgo = managed.stopClientOrderId
    ? await queryAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now })
    : null;
  if (finalAlgo && ["NEW", "PENDING_NEW"].includes(String(finalAlgo.algoStatus ?? finalAlgo.status))) {
    await cancelAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: Date.now() });
    finalAlgo = await queryAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: Date.now() });
    invariant(!finalAlgo || !["NEW", "PENDING_NEW"].includes(String(finalAlgo.algoStatus ?? finalAlgo.status)), "TESTNET_STALE_PROTECTIVE_STOP_CANCEL_FAILED");
  }
  const rawFinalOrder = finalAlgo ? algoAsFinalFill(finalAlgo) : null;
  const finalTradeCost = rawFinalOrder?.orderId
    ? await safeOrderTradeCost(normalizedSymbol, rawFinalOrder.orderId, credentials, { fetchImpl, now })
    : null;
  const finalOrder = rawFinalOrder ? { ...rawFinalOrder, tradeCost: finalTradeCost } : null;
  const confirmedProtectiveStop = finalOrder?.status === "FILLED";
  const outcome = buildClosedPositionOutcome(managed, finalOrder, {
    now,
    reason: confirmedProtectiveStop ? "CONFIRMED_PROTECTIVE_STOP" : reason,
    source: confirmedProtectiveStop ? "BINANCE_DEMO_PROTECTIVE_STOP_ORDER_RESULT" : "BINANCE_DEMO_POSITION_ABSENCE_RECONCILIATION",
  });
  const nextState = structuredClone(currentState);
  delete nextState.managedPositions[normalizedSymbol];
  if (managed.entryClientOrderId) delete nextState.managedOrders[managed.entryClientOrderId];
  if (managed.stopClientOrderId) delete nextState.managedOrders[managed.stopClientOrderId];
  nextState.pendingOperations ??= {};
  for (const [operationId, operation] of Object.entries(nextState.pendingOperations)) {
    if (operation?.symbol === normalizedSymbol) delete nextState.pendingOperations[operationId];
  }
  nextState.closedPositions = appendClosedOutcome(nextState, outcome);
  nextState.updatedAt = new Date(now).toISOString();
  await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_MANAGED_POSITION_RECONCILED_CLOSED", occurredAt: new Date(now).toISOString(), venue: "BINANCE_USDM_TESTNET", symbol: normalizedSymbol, reason: outcome.closeReason, outcomeId: outcome.outcomeId, realizedR: outcome.realizedR, shadowKellyEligible: outcome.shadowKellyEligible, credentialsRecorded: false, productionHostUsed: false });
  return { status: "BINANCE_DEMO_MANAGED_POSITION_RECONCILED_CLOSED", outcome, nextState, realOrdersSubmitted: 0 };
}

export async function closeManagedPosition({ intentId, symbol, reason = "STRATEGY_MANAGED_CLOSE", confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), clock = null, state = null, persist = true } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedIntentId = normalizeIntentId(intentId);
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const requestNow = typeof clock === "function" ? clock : () => now;
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managed = currentState.managedPositions?.[normalizedSymbol];
  invariant(managed, "TESTNET_MANAGED_POSITION_NOT_FOUND");
  const closeClientOrderId = deterministicClientOrderId(normalizedIntentId, "close");
  const pending = currentState.pendingOperations?.[closeClientOrderId] ?? null;
  const [positions, existingCloseOrder] = await Promise.all([
    requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now: requestNow() }),
    queryByClientOrderId(normalizedSymbol, closeClientOrderId, credentials, { fetchImpl, now: requestNow() }),
  ]);
  assertOneWayPositionRows(positions);
  const live = nonFlatPositions(positions).find((position) => position.symbol === normalizedSymbol);
  if (!live && !existingCloseOrder) {
    return finalizeManagedPositionAbsentOnExchange({ symbol: normalizedSymbol, reason }, { credentials, fetchImpl, now: requestNow(), state: currentState });
  }
  const quantity = Number(pending?.quantity) || Number(existingCloseOrder?.executedQty) || Math.abs(Number(live?.positionAmt)) || Number(managed.quantity);
  const managedDirection = Number(managed.direction) || (managed.side === "BUY" ? 1 : -1);
  const side = pending?.side ?? (managedDirection === 1 ? "SELL" : "BUY");
  const params = { symbol: normalizedSymbol, side, type: "MARKET", quantity, reduceOnly: true, newClientOrderId: closeClientOrderId, newOrderRespType: "RESULT" };
  let workingState = structuredClone(currentState);
  workingState.pendingOperations ??= {};
  if (!pending) {
    const preparedAt = requestNow();
    workingState.pendingOperations[closeClientOrderId] = {
      schemaVersion: 1,
      kind: "CLOSE",
      phase: "PREPARED",
      preparedAt,
      symbol: normalizedSymbol,
      clientOrderId: closeClientOrderId,
      quantity,
      side,
      input: { intentId: normalizedIntentId, symbol: normalizedSymbol, reason, confirmation: TESTNET_CONFIRMATION },
    };
    workingState.updatedAt = new Date(preparedAt).toISOString();
    if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  }
  let submittedCloseOrder = existingCloseOrder;
  const idempotentRecovery = Boolean(existingCloseOrder);
  if (!submittedCloseOrder) {
    await requestJson("POST", "/fapi/v1/order/test", params, credentials, { fetchImpl, now: requestNow() });
    submittedCloseOrder = await submitRecoverable(params, credentials, { fetchImpl, now: requestNow() });
  }
  const resolvedClose = await resolveFilledMarketOrder(submittedCloseOrder, {
    symbol: normalizedSymbol,
    clientOrderId: closeClientOrderId,
    credentials,
    fetchImpl,
    now: requestNow(),
  });
  submittedCloseOrder = resolvedClose.order;
  assertFilledMarketOrder(submittedCloseOrder, quantity, "TESTNET_MANAGED_CLOSE_FILL_INCOMPLETE");
  workingState.pendingOperations[closeClientOrderId].phase = "CLOSE_FILLED";
  workingState.pendingOperations[closeClientOrderId].closeOrderId = submittedCloseOrder?.orderId ?? null;
  workingState.updatedAt = new Date(requestNow()).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, workingState);
  const positionsAfterClose = await requestJson("GET", "/fapi/v2/positionRisk", {}, credentials, { fetchImpl, now: requestNow() });
  assertOneWayPositionRows(positionsAfterClose);
  assertSymbolFlatAfterManagedClose(positionsAfterClose, normalizedSymbol);
  await cancelAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: requestNow() });
  const lingeringStop = managed.stopClientOrderId ? await queryAlgoByClientId(managed.stopClientOrderId, credentials, { fetchImpl, now: requestNow() }) : null;
  invariant(!lingeringStop || !["NEW", "PENDING_NEW"].includes(String(lingeringStop.algoStatus ?? lingeringStop.status)), "TESTNET_MANAGED_CLOSE_PROTECTIVE_STOP_STILL_ACTIVE");
  const closeTradeCost = resolvedClose.tradeCost ?? await safeOrderTradeCost(normalizedSymbol, submittedCloseOrder?.orderId, credentials, { fetchImpl, now: requestNow() });
  const closeOrder = { ...submittedCloseOrder, tradeCost: closeTradeCost };
  const nextState = structuredClone(workingState);
  const completedAt = requestNow();
  const outcome = buildClosedPositionOutcome(managed, closeOrder, { now: completedAt, reason, source: "BINANCE_DEMO_MANAGED_CLOSE_ORDER_RESULT" });
  delete nextState.managedPositions[normalizedSymbol];
  if (managed.entryClientOrderId) delete nextState.managedOrders[managed.entryClientOrderId];
  if (managed.stopClientOrderId) delete nextState.managedOrders[managed.stopClientOrderId];
  nextState.managedOrders[closeClientOrderId] = { symbol: normalizedSymbol, role: "CLOSE", orderId: closeOrder?.orderId ?? null };
  delete nextState.pendingOperations[closeClientOrderId];
  nextState.closedPositions = appendClosedOutcome(nextState, outcome);
  nextState.updatedAt = new Date(completedAt).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  const audit = persist ? await recordAudit({
    schemaVersion: 1,
    eventType: idempotentRecovery ? "BINANCE_DEMO_MANAGED_POSITION_CLOSE_RECOVERED_IDEMPOTENTLY" : "BINANCE_DEMO_MANAGED_POSITION_CLOSED",
    occurredAt: new Date(completedAt).toISOString(),
    venue: "BINANCE_USDM_TESTNET",
    symbol: normalizedSymbol,
    quantity,
    reason,
    closeOrderId: closeOrder?.orderId ?? null,
    outcomeId: outcome.outcomeId,
    realizedR: outcome.realizedR,
    shadowKellyEligible: outcome.shadowKellyEligible,
    credentialsRecorded: false,
    productionHostUsed: false,
  }) : null;
  return { status: idempotentRecovery ? "BINANCE_DEMO_MANAGED_POSITION_CLOSE_RECOVERED_IDEMPOTENTLY" : "BINANCE_DEMO_MANAGED_POSITION_CLOSED", venue: "BINANCE_USDM_TESTNET", closeOrder, outcome, auditEventHash: audit?.eventHash ?? null, idempotentRecovery, realOrdersSubmitted: 0 };
}

export async function recoverPendingTradingOperations({ credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), clock = null } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const requestNow = typeof clock === "function" ? clock : () => now;
  const recovered = [];
  const errors = [];
  let currentState = await readJson(TRADING_STATE_PATH, defaultState());
  for (const [operationId, operation] of Object.entries(currentState.pendingOperations ?? {})) {
    try {
      if (operation?.kind === "ENTRY") {
        const rollbackClientOrderId = deterministicClientOrderId(operation.input?.intentId, "rollback");
        const existingRollback = await queryByClientOrderId(operation.symbol, rollbackClientOrderId, credentials, { fetchImpl, now: requestNow() });
        if (existingRollback) {
          const result = await reconcileRolledBackEntryOutcome({
            ...operation.input,
            quantity: operation.input?.quantity,
            confirmation: TESTNET_CONFIRMATION,
          }, { credentials, fetchImpl, now: requestNow(), state: currentState, persist: true });
          recovered.push({ operationId, kind: "ENTRY_ROLLBACK", status: result.status });
          currentState = await readJson(TRADING_STATE_PATH, defaultState());
          continue;
        }
        const existing = await queryByClientOrderId(operation.symbol, operationId, credentials, { fetchImpl, now: requestNow() });
        if (!existing) {
          const positions = await requestJson("GET", "/fapi/v2/positionRisk", { symbol: operation.symbol }, credentials, { fetchImpl, now: requestNow() });
          assertOneWayPositionRows(positions);
          const live = nonFlatPositions(positions).find((row) => row.symbol === operation.symbol);
          invariant(!live, `TESTNET_PENDING_ENTRY_ORDER_MISSING_WITH_LIVE_POSITION_${operation.symbol}`);
          invariant(requestNow() - Number(operation.preparedAt) >= 30_000, `TESTNET_PENDING_ENTRY_EXCHANGE_STATUS_STILL_UNCERTAIN_${operation.symbol}`);
          const nextState = structuredClone(currentState);
          delete nextState.pendingOperations[operationId];
          nextState.updatedAt = new Date(requestNow()).toISOString();
          await writeJsonAtomic(TRADING_STATE_PATH, nextState);
          await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_PENDING_ENTRY_CLEARED_NO_EXCHANGE_EFFECT", occurredAt: nextState.updatedAt, venue: "BINANCE_USDM_TESTNET", symbol: operation.symbol, operationId, credentialsRecorded: false, productionHostUsed: false });
          recovered.push({ operationId, kind: "ENTRY", status: "CLEARED_NO_EXCHANGE_EFFECT" });
        } else {
          const result = await placeMarketEntry(operation.input, { credentials, fetchImpl, now: requestNow(), clock, state: currentState, persist: true });
          recovered.push({ operationId, kind: "ENTRY", status: result.status });
        }
      } else if (operation?.kind === "CLOSE") {
        const result = await closeManagedPosition(operation.input, { credentials, fetchImpl, now: requestNow(), clock, state: currentState, persist: true });
        recovered.push({ operationId, kind: "CLOSE", status: result.status });
      } else if (operation?.kind === "PARTIAL_REDUCE") {
        invariant(deterministicClientOrderId(operation.input?.intentId, String(operation.input?.reason ?? "reduce").slice(0, 8)) === operationId, `TESTNET_PENDING_PARTIAL_OPERATION_ID_MISMATCH_${operationId}`);
        const existing = await queryByClientOrderId(operation.symbol, operationId, credentials, { fetchImpl, now: requestNow() });
        if (!existing) {
          const positions = await requestJson("GET", "/fapi/v2/positionRisk", { symbol: operation.symbol }, credentials, { fetchImpl, now: requestNow() });
          assertOneWayPositionRows(positions);
          const live = nonFlatPositions(positions).find((row) => row.symbol === operation.symbol);
          const managed = currentState.managedPositions?.[operation.symbol];
          invariant(live && managed && Math.abs(Math.abs(Number(live.positionAmt)) - Number(managed.quantity)) <= 1e-8, `TESTNET_PENDING_PARTIAL_ORDER_MISSING_WITH_POSITION_DELTA_${operation.symbol}`);
          invariant(requestNow() - Number(operation.preparedAt) >= 30_000, `TESTNET_PENDING_PARTIAL_EXCHANGE_STATUS_STILL_UNCERTAIN_${operation.symbol}`);
          const nextState = structuredClone(currentState);
          delete nextState.pendingOperations[operationId];
          nextState.updatedAt = new Date(requestNow()).toISOString();
          await writeJsonAtomic(TRADING_STATE_PATH, nextState);
          await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_PENDING_PARTIAL_REDUCTION_CLEARED_NO_EXCHANGE_EFFECT", occurredAt: nextState.updatedAt, venue: "BINANCE_USDM_TESTNET", symbol: operation.symbol, operationId, credentialsRecorded: false, productionHostUsed: false });
          recovered.push({ operationId, kind: "PARTIAL_REDUCE", status: "CLEARED_NO_EXCHANGE_EFFECT" });
        } else {
          const result = await reduceManagedPosition(operation.input, { credentials, fetchImpl, now: requestNow(), clock, state: currentState, persist: true });
          recovered.push({ operationId, kind: "PARTIAL_REDUCE", status: result.status });
        }
      } else {
        throw new Error(`TESTNET_PENDING_OPERATION_KIND_UNKNOWN_${operationId}`);
      }
    } catch (error) {
      errors.push({ operationId, kind: operation?.kind ?? null, symbol: operation?.symbol ?? null, error: error?.message ?? String(error) });
    }
    currentState = await readJson(TRADING_STATE_PATH, defaultState());
  }
  for (const managed of Object.values(currentState.managedPositions ?? {})) {
    const pending = managed?.pendingStopReplacement;
    if (!pending) continue;
    try {
      const result = await replaceManagedProtectiveStop({
        intentId: `recovery:${managed.symbol}:${pending.targetClientOrderId}`,
        symbol: managed.symbol,
        stopPrice: pending.targetStopPrice,
        role: pending.role ?? "recover",
        confirmation: TESTNET_CONFIRMATION,
      }, { credentials, fetchImpl, now: requestNow(), clock, state: currentState, persist: true });
      recovered.push({ operationId: pending.targetClientOrderId, kind: "STOP_REPLACEMENT", status: result.status });
    } catch (error) {
      errors.push({ operationId: pending.targetClientOrderId, kind: "STOP_REPLACEMENT", symbol: managed.symbol, error: error?.message ?? String(error) });
    }
    currentState = await readJson(TRADING_STATE_PATH, defaultState());
  }
  return {
    status: errors.length ? "PENDING_OPERATION_RECOVERY_FAIL_CLOSED" : "PENDING_OPERATION_RECOVERY_COMPLETE",
    recovered,
    errors,
  };
}

export async function reconcileManagedFeeEvidence({ credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), maximumRecords = 20 } = {}) {
  await loadAuthorization();
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const currentState = await readJson(TRADING_STATE_PATH, defaultState());
  const nextState = structuredClone(currentState);
  const changes = [];
  let inspected = 0;
  const actualCost = async (symbol, orderId) => {
    if (orderId === undefined || orderId === null) return null;
    const cost = await queryOrderTradeCost({ symbol, orderId }, { credentials, fetchImpl, now: Date.now() });
    return cost.allCommissionInUsdt === true ? cost : null;
  };

  for (const managed of Object.values(nextState.managedPositions ?? {})) {
    if (inspected >= maximumRecords) break;
    if (managed.entryFeeEvidence !== "ACTUAL_BINANCE_DEMO_USER_TRADES") {
      inspected += 1;
      const cost = await actualCost(managed.symbol, managed.entryOrderId).catch(() => null);
      if (cost) {
        managed.entryFee = Number(cost.commissionUsdt);
        managed.entryFeeRate = Number(managed.entryPrice) * Number(managed.originalQuantity) > 0
          ? managed.entryFee / (Number(managed.entryPrice) * Number(managed.originalQuantity))
          : null;
        managed.entryTradeCost = cost;
        managed.entryFeeEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
        changes.push({ symbol: managed.symbol, kind: "OPEN_ENTRY", orderId: managed.entryOrderId });
      }
    }
    for (const partial of managed.partialExits ?? []) {
      if (inspected >= maximumRecords) break;
      if (partial.feeEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES" && partial.realizedPnlEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES") continue;
      inspected += 1;
      const cost = await actualCost(managed.symbol, partial.orderId).catch(() => null);
      if (!cost) continue;
      partial.exitFee = Number(cost.commissionUsdt);
      partial.exitFeeRate = Number(partial.fill) * Number(partial.quantity) > 0 ? partial.exitFee / (Number(partial.fill) * Number(partial.quantity)) : null;
      partial.exitCommissionByAsset = cost.commissionByAsset;
      partial.feeEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
      partial.grossPnl = Number(cost.realizedPnlUsdt);
      partial.realizedPnlEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
      partial.tradeIds = (cost.fills ?? []).map((fill) => fill.tradeId).filter((tradeId) => tradeId !== null && tradeId !== undefined);
      changes.push({ symbol: managed.symbol, kind: "OPEN_PARTIAL_REALIZED_PNL", orderId: partial.orderId });
    }
    if (managed.entryFeeEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES") {
      for (const partial of managed.partialExits ?? []) {
        partial.entryFeeAllocated = Number(managed.entryFee) * Number(partial.quantity) / Number(managed.originalQuantity);
        partial.netPnl = Number(partial.grossPnl) - partial.entryFeeAllocated - Number(partial.exitFee);
      }
      managed.cumulativeExitFee = (managed.partialExits ?? []).reduce((sum, row) => sum + Number(row.exitFee ?? 0), 0);
      managed.cumulativeGrossPnl = (managed.partialExits ?? []).reduce((sum, row) => sum + Number(row.grossPnl ?? 0), 0);
      managed.cumulativeRealizedNetPnl = (managed.partialExits ?? []).reduce((sum, row) => sum + Number(row.netPnl ?? 0), 0);
    }
  }

  for (const closed of nextState.closedPositions ?? []) {
    if (inspected >= maximumRecords) break;
    if (closed.actualCommissionEvidenceComplete === true && closed.exchangeRealizedPnlEvidenceComplete === true && closed.completeFinalFill === true) continue;
    inspected += 1;
    const entryCost = await actualCost(closed.symbol, closed.entryOrderId).catch(() => null);
    const finalCost = await actualCost(closed.symbol, closed.finalOrderId).catch(() => null);
    const partialCosts = [];
    for (const partial of closed.partialExits ?? []) partialCosts.push(await actualCost(closed.symbol, partial.orderId).catch(() => null));
    if (!entryCost || !finalCost || partialCosts.some((cost) => !cost)) continue;
    closed.entryCommissionUsdt = Number(entryCost.commissionUsdt);
    closed.entryCommissionByAsset = entryCost.commissionByAsset;
    const originalQuantity = Number(closed.originalQuantity);
    let cumulativePartialNetPnl = 0;
    let partialExitCommissionUsdt = 0;
    for (let index = 0; index < (closed.partialExits ?? []).length; index += 1) {
      const partial = closed.partialExits[index];
      const cost = partialCosts[index];
      partial.exitFee = Number(cost.commissionUsdt);
      partial.exitFeeRate = Number(partial.fill) * Number(partial.quantity) > 0 ? partial.exitFee / (Number(partial.fill) * Number(partial.quantity)) : null;
      partial.exitCommissionByAsset = cost.commissionByAsset;
      partial.grossPnl = Number(cost.realizedPnlUsdt);
      partial.realizedPnlEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
      partial.tradeIds = (cost.fills ?? []).map((fill) => fill.tradeId).filter((tradeId) => tradeId !== null && tradeId !== undefined);
      partial.entryFeeAllocated = closed.entryCommissionUsdt * Number(partial.quantity) / originalQuantity;
      partial.netPnl = Number(partial.grossPnl) - partial.entryFeeAllocated - partial.exitFee;
      partial.feeEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
      partialExitCommissionUsdt += partial.exitFee;
      cumulativePartialNetPnl += partial.netPnl;
    }
    const finalFills = (finalCost.fills ?? []).filter((fill) => Number(fill.quantity) > 0 && Number(fill.price) > 0);
    const reconstructedFinalQuantity = finalFills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
    const reconstructedFinalNotional = finalFills.reduce((sum, fill) => sum + Number(fill.quantity) * Number(fill.price), 0);
    const finalQuantity = Number(closed.finalExitQuantity) > 0 ? Number(closed.finalExitQuantity) : reconstructedFinalQuantity;
    const finalPrice = Number(closed.finalExitPrice) > 0 ? Number(closed.finalExitPrice) : (reconstructedFinalQuantity > 0 ? reconstructedFinalNotional / reconstructedFinalQuantity : 0);
    if (!(finalQuantity > 0 && finalPrice > 0)) continue;
    const finalEntryFeeAllocated = closed.entryCommissionUsdt * finalQuantity / originalQuantity;
    const finalExitCommissionUsdt = Number(finalCost.commissionUsdt);
    const finalGrossPnl = Number(finalCost.realizedPnlUsdt);
    const finalNetPnl = finalGrossPnl - finalEntryFeeAllocated - finalExitCommissionUsdt;
    const exchangeRealizedPnlUsdt = Number(entryCost.realizedPnlUsdt) + partialCosts.reduce((sum, cost) => sum + Number(cost.realizedPnlUsdt), 0) + Number(finalCost.realizedPnlUsdt);
    closed.cumulativePartialNetPnl = cumulativePartialNetPnl;
    closed.partialExitCommissionUsdt = partialExitCommissionUsdt;
    closed.finalExitQuantity = finalQuantity;
    closed.finalExitPrice = finalPrice;
    closed.finalExitCommissionUsdt = finalExitCommissionUsdt;
    closed.finalExitCommissionRate = finalPrice * finalQuantity > 0 ? finalExitCommissionUsdt / (finalPrice * finalQuantity) : null;
    closed.finalExitCommissionByAsset = finalCost.commissionByAsset;
    closed.totalCommissionUsdt = closed.entryCommissionUsdt + partialExitCommissionUsdt + finalExitCommissionUsdt;
    closed.finalNetPnl = finalNetPnl;
    closed.exchangeRealizedPnlUsdt = exchangeRealizedPnlUsdt;
    closed.exchangeRealizedPnlEvidenceComplete = true;
    closed.entryTradeIds = (entryCost.fills ?? []).map((fill) => fill.tradeId).filter((tradeId) => tradeId !== null && tradeId !== undefined);
    closed.finalTradeIds = (finalCost.fills ?? []).map((fill) => fill.tradeId).filter((tradeId) => tradeId !== null && tradeId !== undefined);
    closed.netPnl = exchangeRealizedPnlUsdt - closed.totalCommissionUsdt;
    closed.realizedR = Number(closed.initialPlannedRiskUsdt) > 0 ? closed.netPnl / Number(closed.initialPlannedRiskUsdt) : null;
    closed.completeFinalFill = true;
    closed.actualCommissionEvidenceComplete = true;
    closed.feeEvidence = "ACTUAL_BINANCE_DEMO_USER_TRADES";
    closed.costEvidence = "ACTUAL_BINANCE_DEMO_REALIZED_PNL_AND_COMMISSIONS";
    closed.finalFillReconstructedFrom = Number(closed.finalExitQuantity) > 0 && finalFills.length ? "BINANCE_DEMO_USER_TRADES" : (closed.finalFillReconstructedFrom ?? null);
    const shadowKellyManagedClose = SHADOW_KELLY_MANAGED_CLOSE_REASONS.has(closed.closeReason);
    closed.shadowKellyEligible = closed.strategyVersion === SHADOW_KELLY_STRATEGY_VERSION &&
      SHADOW_KELLY_REVISION_PATTERN.test(closed.implementationRevision ?? "") &&
      shadowKellyManagedClose &&
      Number.isFinite(Number(closed.realizedR));
    closed.shadowKellyExclusionReasons = closed.shadowKellyEligible ? [] : [
      ...(closed.strategyVersion === SHADOW_KELLY_STRATEGY_VERSION ? [] : ["OTHER_STRATEGY_FAMILY"]),
      ...(SHADOW_KELLY_REVISION_PATTERN.test(closed.implementationRevision ?? "") ? [] : ["UNKNOWN_OR_NON_V3_HF_REVISION"]),
      ...(shadowKellyManagedClose ? [] : ["EXTERNAL_OR_UNMANAGED_CLOSE"]),
      ...(Number.isFinite(Number(closed.realizedR)) ? [] : ["MISSING_REALIZED_R"]),
    ];
    changes.push({ symbol: closed.symbol, kind: "CLOSED_OUTCOME", outcomeId: closed.outcomeId });
  }
  if (changes.length) {
    nextState.updatedAt = new Date(now).toISOString();
    await writeJsonAtomic(TRADING_STATE_PATH, nextState);
    await recordAudit({ schemaVersion: 1, eventType: "BINANCE_DEMO_FEE_EVIDENCE_RECONCILED", occurredAt: nextState.updatedAt, venue: "BINANCE_USDM_TESTNET", changes, credentialsRecorded: false, productionHostUsed: false });
  }
  return { status: "BINANCE_DEMO_FEE_EVIDENCE_RECONCILIATION_COMPLETE", inspected, changeCount: changes.length, changes };
}

export async function cancelManagedOrder({ symbol, clientOrderId, confirmation }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null, persist = true } = {}) {
  await loadAuthorization();
  await assertMatchingEngineActivation();
  checkConfirmation(confirmation);
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const normalizedClientOrderId = String(clientOrderId ?? "");
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managedOrder = currentState.managedOrders?.[normalizedClientOrderId];
  invariant(managedOrder?.symbol === normalizedSymbol, "TESTNET_ORDER_NOT_MANAGED_BY_GATEWAY");
  const order = managedOrder.orderKind === "ALGO" || managedOrder.role === "PROTECTIVE_STOP"
    ? await cancelAlgoByClientId(normalizedClientOrderId, credentials, { fetchImpl, now })
    : await requestJson("DELETE", "/fapi/v1/order", { symbol: normalizedSymbol, origClientOrderId: normalizedClientOrderId }, credentials, { fetchImpl, now });
  const nextState = structuredClone(currentState);
  delete nextState.managedOrders[normalizedClientOrderId];
  nextState.updatedAt = new Date(now).toISOString();
  if (persist) await writeJsonAtomic(TRADING_STATE_PATH, nextState);
  return { status: "BINANCE_DEMO_MANAGED_ORDER_CANCELED", venue: "BINANCE_USDM_TESTNET", order, realOrdersSubmitted: 0 };
}

export async function queryManagedOrder({ symbol, clientOrderId }, { credentials = loadKeychainCredentials(), fetchImpl = fetch, now = Date.now(), state = null } = {}) {
  await loadAuthorization();
  invariant(credentials, "TESTNET_KEYCHAIN_CREDENTIALS_MISSING");
  const normalizedSymbol = normalizeTestnetSymbol(symbol);
  const currentState = state ?? await readJson(TRADING_STATE_PATH, defaultState());
  const managedOrder = currentState.managedOrders?.[clientOrderId];
  invariant(managedOrder?.symbol === normalizedSymbol, "TESTNET_ORDER_NOT_MANAGED_BY_GATEWAY");
  const order = managedOrder.orderKind === "ALGO" || managedOrder.role === "PROTECTIVE_STOP"
    ? await requestJson("GET", "/fapi/v1/algoOrder", { clientAlgoId: clientOrderId }, credentials, { fetchImpl, now })
    : await requestJson("GET", "/fapi/v1/order", { symbol: normalizedSymbol, origClientOrderId: clientOrderId }, credentials, { fetchImpl, now });
  return { status: "BINANCE_DEMO_MANAGED_ORDER", venue: "BINANCE_USDM_TESTNET", order, realOrdersSubmitted: 0 };
}
