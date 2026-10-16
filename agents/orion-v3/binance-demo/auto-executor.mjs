import path from "node:path";
import { fileURLToPath } from "node:url";

import { tier1EventWindowAt } from "../../orion-v2/paper/event-risk.mjs";
import { netLiquidationR, stopForAggregateNetRFloor, updateConfirmedStructureTrail } from "../../orion-v2/paper/paper-engine.mjs";
import { readJson, writeJsonAtomic } from "../../orion-v2/paper/runtime-utils.mjs";
import { appendChainedAudit } from "../../../integrations/binance-usdm-testnet/audit-ledger.mjs";
import {
  TESTNET_CONFIRMATION,
  TESTNET_RISK_LIMITS,
  closeManagedPosition,
  finalizeManagedPositionAbsentOnExchange,
  loadManagedTradingState,
  persistManagedPositionMetadata,
  placeMarketEntry,
  planAutomaticRiskSizedEntry,
  reduceManagedPosition,
  replaceManagedProtectiveStop,
} from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";
import { V3DemoMarketClient, evaluateFourHourMarketStateGate, validateHighFrequencyConfig } from "./high-frequency-strategy.mjs";
import {
  validateAbnormalLossGateAuthorization,
} from "../../shared/abnormal-loss-gate.mjs";
import { evaluateV3IntegrityGate } from "./integrity-repair.mjs";
import { entryDecisionInterval, releasePolicy, requiresDualZ, requiresSingleZ } from "./release-policy.mjs";
import { validateDualZPlanEvidence, validateSingleZPlanEvidence } from "./dual-z.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const AUTO_STATE_PATH = path.join(ROOT, ".runtime/orion-v3-binance-demo/auto-state.json");
export const AUTO_AUDIT_PATH = path.join(ROOT, ".runtime/orion-v3-binance-demo/auto-audit.ndjson");
const CONFIG_PATH = path.join(ROOT, "experiments/v3-mtf-high-frequency/config.json");
const CALENDAR_PATH = path.join(ROOT, "agents/nexus/data/mtfx-tier1-event-calendar.json");
const ABNORMAL_LOSS_GATE_AUTH_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-25-v2-v3-v4-abnormal-single-loss-circuit-breaker.json");
const ABNORMAL_LOSS_GATE_SCOPE = "ORION_V3_BINANCE_DEMO";
const INTEGRITY_REPAIR_AUTH_PATH = path.join(ROOT, "governance/owner-authorizations/2026-09-12-orion-v3-hf11-integrity-repair.json");

const runtime = {
  paperRisk: {
    exitVariant: "PARTIAL_20_SOFT_LOCK_30_25_RUNNER_15M_STRUCTURE",
    takerFeeRate: TESTNET_RISK_LIMITS.takerFeeRate,
    adverseSlippageRate: TESTNET_RISK_LIMITS.adverseSlippageRate,
    excursionRecordStepR: 0.05,
  },
};

function initialAutoState(now, implementationRevision = null, evaluationCohortId = null, riskPolicyRevision = null) {
  return { schemaVersion: 1, implementationRevision, evaluationCohortId, riskPolicyRevision, activatedAt: now, processedPlanIds: [], terminalDecisions: {}, abnormalLossGate: null, lastCycleAt: null, lastError: null };
}

// A strategy release starts a new signal cohort, not a new risk or idempotency history.
export function transitionAutomaticState(prior, config, now) {
  const cohort = config.evaluationIsolation.forwardCohortId;
  if (!prior) return initialAutoState(now, config.implementationRevision, cohort, config.riskPolicyRevision);
  if (prior.implementationRevision === config.implementationRevision && prior.evaluationCohortId === cohort && prior.riskPolicyRevision === config.riskPolicyRevision) return prior;
  return {
    ...prior,
    implementationRevision: config.implementationRevision,
    evaluationCohortId: cohort,
    riskPolicyRevision: config.riskPolicyRevision,
    activatedAt: now,
    releaseTransitions: [...(prior.releaseTransitions ?? []), {
      fromRevision: prior.implementationRevision ?? null,
      fromCohort: prior.evaluationCohortId ?? null,
      toRevision: config.implementationRevision,
      toCohort: cohort,
      activatedAt: now,
      preservedGateStatus: prior.abnormalLossGate?.status ?? null,
    }].slice(-50),
  };
}

async function audit(event) {
  await appendChainedAudit(AUTO_AUDIT_PATH, { schemaVersion: 1, ...event });
}

function entrySide(decision) {
  return decision?.status === "CONFIRMED_LONG" ? "BUY" : decision?.status === "CONFIRMED_SHORT" ? "SELL" : null;
}

export function evaluateEntryExecutionGuard(plan, quote, config, now = Date.now()) {
  const side = entrySide(plan?.entryDecision);
  if (!side) return { allowed: false, terminal: false, reason: "ENTRY_DIRECTION_NOT_CONFIRMED" };
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!(bid > 0 && ask > 0 && bid <= ask)) throw new Error(`V3_HF11_BBO_INVALID_${plan?.symbol ?? "UNKNOWN"}`);
  const decisionBarCloseTime = Number(plan?.entryDecision?.decisionBarCloseTime);
  const maximumSignalAgeMs = Number(config?.signal?.maximumEntrySignalAgeMs);
  const maximumDisplacementBps = Number(config?.signal?.maximumEntryDisplacementBps);
  const confirmationClosePrice = Number(plan?.entryDecision?.decisionClose);
  const referenceType = `CONFIRMED_${entryDecisionInterval(config).toUpperCase()}_DECISION_CLOSE`;
  if (!(decisionBarCloseTime > 0 && maximumSignalAgeMs > 0 && maximumDisplacementBps > 0 && confirmationClosePrice > 0)) {
    throw new Error("V3_HF11_ENTRY_GUARD_CONFIGURATION_INVALID");
  }
  const signalExpiresAt = decisionBarCloseTime + maximumSignalAgeMs;
  if (now < decisionBarCloseTime) {
    return { allowed: false, terminal: false, reason: "ENTRY_DECISION_BAR_NOT_CLOSED", decisionBarCloseTime, signalExpiresAt };
  }
  if (now > signalExpiresAt) {
    return { allowed: false, terminal: true, reason: "ENTRY_SIGNAL_EXPIRED_BEFORE_SUBMISSION", decisionBarCloseTime, signalExpiresAt, signalAgeMs: now - decisionBarCloseTime };
  }
  const executablePrice = side === "BUY" ? ask : bid;
  const displacementBps = Math.abs(executablePrice - confirmationClosePrice) / confirmationClosePrice * 10_000;
  if (displacementBps > maximumDisplacementBps) {
    return {
      allowed: false,
      terminal: false,
      reason: "ENTRY_PRICE_OUTSIDE_MAXIMUM_DISPLACEMENT_WAITING_FOR_REENTRY",
      executablePrice,
      referencePrice: confirmationClosePrice,
      referenceType,
      displacementBps,
      maximumDisplacementBps,
      decisionBarCloseTime,
      signalExpiresAt,
    };
  }
  return {
    allowed: true,
    terminal: false,
    reason: "ENTRY_EXECUTION_GUARDS_PASSED",
    executablePrice,
    referencePrice: confirmationClosePrice,
    referenceType,
    displacementBps,
    maximumDisplacementBps,
    decisionBarCloseTime,
    signalExpiresAt,
    maximumSignalAgeMs,
  };
}

export function applyActualPartial(position, order, fallbackQuantity, reason, exactRemainingQuantity = null) {
  const quantity = Number(order?.executedQty) || Number(fallbackQuantity);
  const fill = Number(order?.avgPrice) || Number(order?.price) || Number(position.lastExecutablePrice) || Number(position.entry);
  const originalQuantity = Number(position.originalQuantity);
  const entryFeeAllocated = Number(position.entryFee ?? 0) * quantity / originalQuantity;
  const actualExitCommission = Number(order?.tradeCost?.commissionUsdt);
  const hasActualExitCommission = order?.tradeCost?.allCommissionInUsdt === true && Number.isFinite(actualExitCommission);
  const actualRealizedPnl = Number(order?.tradeCost?.realizedPnlUsdt);
  const hasActualRealizedPnl = Number(order?.tradeCost?.tradeCount) > 0 && Number.isFinite(actualRealizedPnl);
  const exitFee = hasActualExitCommission ? actualExitCommission : fill * quantity * TESTNET_RISK_LIMITS.takerFeeRate;
  const exitNotional = fill * quantity;
  const grossPnl = hasActualRealizedPnl ? actualRealizedPnl : Number(position.direction) * (fill - Number(position.entry)) * quantity;
  const netPnl = grossPnl - entryFeeAllocated - exitFee;
  const remainingQuantity = exactRemainingQuantity !== null && exactRemainingQuantity !== undefined && Number.isFinite(Number(exactRemainingQuantity)) && Number(exactRemainingQuantity) >= 0
    ? Number(exactRemainingQuantity)
    : Math.max(0, Number(position.quantity) - quantity);
  return {
    ...position,
    quantity: remainingQuantity,
    remainingQuantity,
    cumulativeExitFee: Number(position.cumulativeExitFee ?? 0) + exitFee,
    cumulativeGrossPnl: Number(position.cumulativeGrossPnl ?? 0) + grossPnl,
    cumulativeRealizedNetPnl: Number(position.cumulativeRealizedNetPnl ?? 0) + netPnl,
    partialExits: [...(position.partialExits ?? []), {
      reason,
      orderId: order?.orderId ?? null,
      quantity,
      fill,
      entryFeeAllocated,
      exitFee,
      exitFeeRate: exitNotional > 0 ? exitFee / exitNotional : null,
      exitCommissionByAsset: order?.tradeCost?.commissionByAsset ?? { USDT: exitFee },
      feeEvidence: hasActualExitCommission ? "ACTUAL_BINANCE_DEMO_USER_TRADES" : "AUTHORIZED_CONSERVATIVE_TAKER_FEE_MODEL",
      realizedPnlEvidence: hasActualRealizedPnl ? "ACTUAL_BINANCE_DEMO_USER_TRADES" : "FILL_PRICE_ARITHMETIC_FALLBACK",
      tradeIds: (order?.tradeCost?.fills ?? []).map((trade) => trade.tradeId).filter((tradeId) => tradeId !== null && tradeId !== undefined),
      fills: order?.tradeCost?.fills ?? [],
      executedAt: order?.tradeCost?.fills?.length
        ? Math.max(0, ...order.tradeCost.fills.map((trade) => Number(trade.time)).filter(Number.isFinite)) || Number(order?.updateTime) || null
        : Number(order?.updateTime) || null,
      grossPnl,
      netPnl,
    }],
  };
}

function managedDirection(position) {
  return Number(position.direction) || (position.side === "BUY" ? 1 : -1);
}

export function decideSameSymbolTransition(existing, plan, incomingSide) {
  if (!existing) return { action: "OPEN_NEW" };
  const existingSide = managedDirection(existing) === 1 ? "BUY" : "SELL";
  if (existingSide === incomingSide) return { action: "KEEP_EXISTING", reason: "SAME_DIRECTION_POSITION_ALREADY_MANAGED" };
  if (Number(plan.intersectionTime) <= Number(existing.intersectionTime ?? existing.openedAt ?? 0)) {
    return { action: "KEEP_EXISTING", reason: "STALE_OPPOSITE_SIGNAL_CANNOT_REPLACE_NEWER_POSITION" };
  }
  return { action: "CLOSE_FLAT_THEN_REVERSE", reason: "NEWER_FULLY_CONFIRMED_OPPOSITE_SIGNAL" };
}

function anchorLineage(anchors, pattern = null) {
  if (!Array.isArray(anchors) || anchors.length !== 4) return null;
  const normalized = anchors.map((anchor) => ({ type: String(anchor?.type ?? ""), time: Number(anchor?.time) }));
  if (normalized.some((anchor) => !["HIGH", "LOW"].includes(anchor.type) || !(anchor.time > 0))) return null;
  const encode = (rows) => rows.map((anchor) => `${anchor.type}@${anchor.time}`).join("|");
  return {
    schemaVersion: 1,
    pattern: pattern ?? null,
    primary1h: encode(normalized.slice(0, 2)),
    opposing15m: encode(normalized.slice(2, 4)),
    composite: `${pattern ?? "UNKNOWN_PATTERN"}:${encode(normalized)}`,
  };
}

export function structureLineageFor(record) {
  return record?.structureLineage?.schemaVersion === 1 ? record.structureLineage : anchorLineage(record?.anchors, record?.pattern);
}

export function evaluateIndependentLineageReentryGuard({ plan, managedState, config }) {
  const policy = config?.reentryLineageGate;
  if (policy?.enabled !== true) return { allowed: true, reason: "INDEPENDENT_LINEAGE_REENTRY_GATE_DISABLED" };
  const candidate = structureLineageFor(plan);
  if (!candidate) return { allowed: false, terminal: true, reason: "CANDIDATE_STRUCTURE_LINEAGE_EVIDENCE_MISSING" };

  const existing = managedState?.managedPositions?.[plan.symbol] ?? null;
  const enforcedFrom = Date.parse(policy?.enforcedFrom ?? "");
  if (!Number.isFinite(enforcedFrom)) return { allowed: false, terminal: true, reason: "INDEPENDENT_LINEAGE_REENTRY_ENFORCEMENT_TIME_INVALID" };
  const completed = [...(managedState?.closedPositions ?? [])]
    .filter((row) => row?.symbol === plan.symbol && (row?.implementationRevision === config.implementationRevision || Number(row?.closedAt) >= enforcedFrom))
    .sort((left, right) => Number(right?.closedAt ?? 0) - Number(left?.closedAt ?? 0))[0] ?? null;
  const reference = existing ?? completed;
  if (!reference) return { allowed: true, reason: "NO_POST_ENFORCEMENT_SAME_SYMBOL_LINEAGE", candidate };

  const prior = structureLineageFor(reference);
  if (!prior) {
    return {
      allowed: false,
      terminal: true,
      reason: "PRIOR_SAME_SYMBOL_STRUCTURE_LINEAGE_EVIDENCE_MISSING_FAIL_CLOSED",
      referenceType: existing ? "CURRENT_MANAGED_POSITION" : "LATEST_POST_ENFORCEMENT_COMPLETED_POSITION",
      priorIntentId: reference.intentId ?? null,
    };
  }
  const primaryChanged = candidate.primary1h !== prior.primary1h;
  const opposingChanged = candidate.opposing15m !== prior.opposing15m;
  if (!primaryChanged || !opposingChanged) {
    return {
      allowed: false,
      terminal: true,
      reason: "SAME_SYMBOL_REENTRY_REQUIRES_NEW_INDEPENDENT_1H_AND_15M_LINEAGES",
      referenceType: existing ? "CURRENT_MANAGED_POSITION" : "LATEST_POST_ENFORCEMENT_COMPLETED_POSITION",
      priorIntentId: reference.intentId ?? null,
      primaryChanged,
      opposingChanged,
      candidate,
      prior,
    };
  }
  return {
    allowed: true,
    reason: "NEW_INDEPENDENT_1H_AND_15M_LINEAGES_CONFIRMED",
    referenceType: existing ? "CURRENT_MANAGED_POSITION" : "LATEST_POST_ENFORCEMENT_COMPLETED_POSITION",
    priorIntentId: reference.intentId ?? null,
    primaryChanged,
    opposingChanged,
    candidate,
    prior,
  };
}

export function evaluateHf11PlanExecutionGate(plan, config, now = Date.now()) {
  if (plan?.implementationRevision !== config?.implementationRevision ||
      plan?.evaluationCohortId !== config?.evaluationIsolation?.forwardCohortId ||
      plan?.riskPolicyRevision !== config?.riskPolicyRevision) {
    return {
      allowed: false,
      terminal: true,
      reason: "HF11_PLAN_REVISION_OR_COHORT_MISMATCH_FAIL_CLOSED",
    };
  }
  const direction = Number(plan?.entryDecision?.direction);
  if (requiresSingleZ(config)) {
    const marketStateGate = plan?.marketStateGate;
    if (marketStateGate?.status !== "OBSERVE_ONLY_NOT_EXECUTION_INPUT" ||
        plan?.entryDecision?.marketStateGateStatus !== "OBSERVE_ONLY_NOT_EXECUTION_INPUT") {
      return { allowed: false, terminal: true, reason: "HF14_4H_OBSERVATION_BOUNDARY_MISMATCH_FAIL_CLOSED", marketStateGate };
    }
    const singleZGate = validateSingleZPlanEvidence(plan, { now });
    const cutoff = Date.parse(config.dualZ?.forwardOnlyFrom ?? "");
    if (!Number.isFinite(cutoff) || Number(plan?.firstDiscoveredAt) < cutoff) return { allowed: false, terminal: true, reason: "HF14_PRE_ACTIVATION_CANDIDATE_NOT_BACKFILLED", marketStateGate, singleZGate };
    if (!singleZGate.allowed) return { ...singleZGate, terminal: !singleZGate.reason.endsWith("SOURCE_STALE"), marketStateGate, singleZGate };
    if (plan?.singleZGate?.allowed !== true || plan?.entryDecision?.singleZGateStatus !== singleZGate.reason) return { allowed: false, terminal: true, reason: "HF14_SINGLE_Z_GATE_EVIDENCE_MISMATCH_FAIL_CLOSED", marketStateGate, singleZGate };
    return { allowed: true, terminal: false, reason: "HF14_SINGLE_Z_GATE_PASSED_4H_OBSERVE_ONLY", marketStateGate, singleZGate };
  }
  const marketStateGate = evaluateFourHourMarketStateGate(plan?.marketState4h, direction, now);
  if (!marketStateGate.orderSubmissionAllowed) {
    return {
      allowed: false,
      terminal: marketStateGate.status !== "BLOCKED_STALE_4H_EVIDENCE",
      reason: `HF11_4H_MARKET_STATE_${marketStateGate.status}`,
      marketStateGate,
    };
  }
  if (plan?.marketStateGate?.status !== marketStateGate.status ||
      plan?.entryDecision?.marketStateGateStatus !== marketStateGate.status) {
    return {
      allowed: false,
      terminal: true,
      reason: "HF11_4H_MARKET_STATE_GATE_EVIDENCE_MISMATCH_FAIL_CLOSED",
      marketStateGate,
    };
  }
  if (requiresDualZ(config)) {
    const dualZGate = validateDualZPlanEvidence(plan, { now });
    const cutoff = Date.parse(config.dualZ?.forwardOnlyFrom ?? "");
    if (!Number.isFinite(cutoff) || Number(plan?.firstDiscoveredAt) < cutoff) return { allowed: false, terminal: true, reason: "HF13_PRE_ACTIVATION_CANDIDATE_NOT_BACKFILLED", marketStateGate, dualZGate };
    if (!dualZGate.allowed) return { ...dualZGate, terminal: !dualZGate.reason.endsWith("SOURCE_STALE"), marketStateGate, dualZGate };
    if (plan?.dualZGate?.allowed !== true || plan?.entryDecision?.dualZGateStatus !== dualZGate.reason) return { allowed: false, terminal: true, reason: "HF13_DUAL_Z_GATE_EVIDENCE_MISMATCH_FAIL_CLOSED", marketStateGate, dualZGate };
    return { allowed: true, terminal: false, reason: "HF13_DUAL_Z_AND_4H_MARKET_STATE_GATES_PASSED", marketStateGate, dualZGate };
  }
  return { allowed: true, terminal: false, reason: "HF11_PLAN_AND_4H_MARKET_STATE_GATE_PASSED", marketStateGate };
}

async function reduceStage(position, fraction, reason, clock) {
  const requested = Number(position.originalQuantity) * fraction;
  const now = clock();
  const result = await reduceManagedPosition({
    intentId: `${position.intentId}:${reason}`,
    symbol: position.symbol,
    quantity: requested,
    reason,
    confirmation: TESTNET_CONFIRMATION,
  }, { now, clock });
  return applyActualPartial(position, result.order, result.quantity, reason, result.remainingQuantity);
}

async function manageOnePosition(position, live, config, client, now, clock = Date.now) {
  if (!live) {
    await finalizeManagedPositionAbsentOnExchange({ symbol: position.symbol }, { now: clock() });
    return { symbol: position.symbol, action: "RECONCILED_CLOSED", mutated: true };
  }
  const quote = await client.book(position.symbol);
  if (!(quote.bid > 0 && quote.ask > 0 && quote.bid <= quote.ask)) throw new Error(`V3_HF11_BBO_INVALID_${position.symbol}`);
  let current = {
    ...position,
    direction: managedDirection(position),
    entry: Number(position.entry ?? position.entryPrice),
    stop: Number(position.stop ?? position.stopPrice),
    quantity: Number(position.quantity ?? live.quantity),
    originalQuantity: Number(position.originalQuantity ?? position.quantity ?? live.quantity),
    initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt),
    implementationRevision: position.implementationRevision ?? config.implementationRevision,
    status: "OPEN",
    lastExecutablePrice: managedDirection(position) === 1 ? quote.bid : quote.ask,
  };
  const executable = current.direction === 1 ? quote.bid : quote.ask;
  let currentNetR = netLiquidationR(current, executable, runtime);
  const actions = [];

  if (!current.partial20Executed && currentNetR >= 0.5) {
    current = await reduceStage(current, 0.2, "halfR20", clock);
    current.partial20Executed = true;
    current.stage = "HF4_HALF_R_PARTIAL_AWAITING_LOCK";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("PARTIAL_20_AT_0_5R");
    currentNetR = netLiquidationR(current, executable, runtime);
  }
  if (current.partial20Executed && !current.softLockTaken) {
    const stop = stopForAggregateNetRFloor(current, runtime, 0.05);
    if (stop > 0 && (current.direction === 1 ? stop > current.stop : stop < current.stop)) {
      const changed = await replaceManagedProtectiveStop({ intentId: `${current.intentId}:lock05`, symbol: current.symbol, stopPrice: stop, role: "lock05", confirmation: TESTNET_CONFIRMATION }, { now: clock(), clock });
      current = { ...current, ...changed.nextState.managedPositions[current.symbol], stop: changed.stopPrice, stopPrice: changed.stopPrice };
      delete current.pendingStopReplacement;
    }
    current.softLockTaken = true;
    current.plannedRiskUsdt = 0;
    current.stage = "SOFT_LOCK_80_REMAINING";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("LOCK_AGGREGATE_0_05R");
  }

  if (!current.partial30Executed && !current.firstPartialTaken && currentNetR >= 1) {
    current = await reduceStage(current, 0.3, "oneR30", clock);
    current.partial30Executed = true;
    current.stage = "HF4_ONE_R_PARTIAL_AWAITING_LOCK";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("PARTIAL_30_AT_1R");
    currentNetR = netLiquidationR(current, executable, runtime);
  }
  if (current.partial30Executed && !current.firstPartialTaken) {
    const stop = stopForAggregateNetRFloor(current, runtime, 0.5);
    if (stop > 0 && (current.direction === 1 ? stop > current.stop : stop < current.stop)) {
      const changed = await replaceManagedProtectiveStop({ intentId: `${current.intentId}:lock50`, symbol: current.symbol, stopPrice: stop, role: "lock50", confirmation: TESTNET_CONFIRMATION }, { now: clock(), clock });
      current = { ...current, ...changed.nextState.managedPositions[current.symbol], stop: changed.stopPrice, stopPrice: changed.stopPrice };
      delete current.pendingStopReplacement;
    }
    current.firstPartialTaken = true;
    current.oneRReachedAt = clock();
    current.plannedRiskUsdt = 0;
    current.stage = "AFTER_1R_50_REMAINING";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("LOCK_AGGREGATE_0_5R");
  }

  if (current.firstPartialTaken && !current.partial25Executed && !current.secondPartialTaken && currentNetR >= 2) {
    current = await reduceStage(current, 0.25, "twoR25", clock);
    current.partial25Executed = true;
    current.stage = "HF4_TWO_R_PARTIAL_COMMITTED";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("PARTIAL_25_AT_2R");
    currentNetR = netLiquidationR(current, executable, runtime);
  }
  if (current.partial25Executed && !current.secondPartialTaken) {
    current.secondPartialTaken = true;
    current.twoRReachedAt = clock();
    current.stage = "RUNNER_25";
    await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
    actions.push("RUNNER_25_ACTIVE");
  }

  if (current.secondPartialTaken) {
    if (!Number.isFinite(current.openedAt) || current.openedAt <= 0) {
      throw new Error("V3_RUNNER_ENTRY_TIME_EVIDENCE_MISSING");
    }
    const serverTime = await client.serverTime();
    const bars15m = await client.bars(current.symbol, "15m", 500, serverTime);
    const trail = updateConfirmedStructureTrail(current, bars15m, config.pivots.runner, "15m");
    if (trail.changed) {
      const changed = await replaceManagedProtectiveStop({ intentId: `${current.intentId}:trail:${trail.position.lastTrailingStructureConfirmedAt}`, symbol: current.symbol, stopPrice: trail.position.stop, role: "trail15m", confirmation: TESTNET_CONFIRMATION }, { now: clock(), clock });
      current = { ...trail.position, ...changed.nextState.managedPositions[current.symbol], stop: changed.stopPrice, stopPrice: changed.stopPrice };
      delete current.pendingStopReplacement;
      await persistManagedPositionMetadata(current.symbol, current, { now: clock() });
      actions.push("RUNNER_15M_TRAIL_TIGHTENED");
    }
  }
  return { symbol: current.symbol, action: actions.length ? actions.join("+") : "NO_MANAGEMENT_CHANGE", currentNetR, mutated: actions.length > 0 };
}

export async function runPositionManagementPass({ managedPositions, livePositions, config, client, clock, manager = manageOnePosition, auditEvent = audit }) {
  const management = [];
  const errors = [];
  for (const position of Object.values(managedPositions ?? {})) {
    const live = (livePositions ?? []).find((row) => row.symbol === position.symbol) ?? null;
    const attemptNow = clock();
    try {
      management.push(await manager(position, live, config, client, attemptNow, clock));
    } catch (error) {
      const errorCode = error?.message ?? String(error);
      const result = { symbol: position.symbol, action: "MANAGEMENT_ERROR_FAIL_CLOSED", error: errorCode, mutated: false };
      management.push(result);
      errors.push(result);
      await auditEvent({ eventType: "V3_HF11_POSITION_MANAGEMENT_ERROR_FAIL_CLOSED", occurredAt: new Date(attemptNow).toISOString(), evaluationCohortId: config.evaluationIsolation.forwardCohortId, symbol: position.symbol, error: errorCode });
    }
  }
  return { management, errors };
}

async function executePlan(plan, autoState, eventWindow, config, now, clock, client) {
  const side = entrySide(plan.entryDecision);
  if (!side) return null;
  const hf11PlanGate = evaluateHf11PlanExecutionGate(plan, config, clock());
  if (!hf11PlanGate.allowed) return hf11PlanGate;
  if (plan.intersectionQuality?.automaticExecutionAllowed !== true) {
    return {
      terminal: true,
      reason: "HF11_INTERSECTION_QUALITY_FAIL_CLOSED",
      intersectionQuality: plan.intersectionQuality ?? null,
    };
  }
  if (plan.entryDecision?.orderSubmissionAllowed !== true) return null;
  if (Number(plan.entryDecision.decisionBarCloseTime) < Number(autoState.activatedAt)) return { terminal: true, reason: "PRE_ACTIVATION_SIGNAL_NOT_BACKFILLED" };
  if (eventWindow.active) return { terminal: true, reason: "TIER1_EVENT_ENTRY_FREEZE" };
  const quote = await client.book(plan.symbol);
  const entryGuard = evaluateEntryExecutionGuard(plan, quote, config, clock());
  if (!entryGuard.allowed) return { terminal: entryGuard.terminal, reason: entryGuard.reason, entryGuard };
  const discoveryPromotion = {
    required: plan.intersectionQuality?.freshExecutionBboPromotionRequired === true,
    discoveryTier: plan.intersectionRange?.discoveryTier ?? null,
    discoveryPriceDistanceBps: plan.intersectionRange?.discoveryPriceDistanceBps ?? null,
    minimumClusterDiscoveryPriceDistanceBps: plan.intersectionRange?.minimumClusterDiscoveryPriceDistanceBps ?? null,
    promotionReference: `LATEST_EXECUTABLE_BBO_VERSUS_CONFIRMED_${entryDecisionInterval(config).toUpperCase()}_DECISION_CLOSE`,
    promotionMaximumDisplacementBps: config.signal.maximumEntryDisplacementBps,
    promotionDisplacementBps: entryGuard.displacementBps,
    promotedAtExecution: plan.intersectionQuality?.freshExecutionBboPromotionRequired === true,
    passed: true,
  };
  let managedState = await loadManagedTradingState();
  const existing = managedState.managedPositions?.[plan.symbol];
  const transition = decideSameSymbolTransition(existing, plan, side);
  if (transition.action === "KEEP_EXISTING") return { terminal: true, reason: transition.reason };
  const reentryLineageGuard = evaluateIndependentLineageReentryGuard({ plan, managedState, config });
  if (!reentryLineageGuard.allowed) return { terminal: reentryLineageGuard.terminal, reason: reentryLineageGuard.reason, reentryLineageGuard };
  if (transition.action === "CLOSE_FLAT_THEN_REVERSE") {
    const replacementGate = evaluateHf11PlanExecutionGate(plan, config, clock());
    if (!replacementGate.allowed) return replacementGate;
    const releasePrefix = requiresSingleZ(config) ? "hf14" : requiresDualZ(config) ? "hf13" : "hf11";
    await closeManagedPosition({ intentId: `${releasePrefix}:replace:${plan.id}`, symbol: plan.symbol, reason: "ELIGIBLE_OPPOSITE_SIGNAL_REPLACEMENT", confirmation: TESTNET_CONFIRMATION }, { now: clock() });
    managedState = await loadManagedTradingState();
  }
  const releasePrefix = requiresSingleZ(config) ? "hf14" : requiresDualZ(config) ? "hf13" : "hf11";
  const intentId = `${releasePrefix}:${plan.id}`;
  const gatewayEntryGuard = {
    intersectionPrice: plan.intersectionPrice,
    referencePrice: plan.entryDecision.decisionClose,
    referenceType: `CONFIRMED_${entryDecisionInterval(config).toUpperCase()}_DECISION_CLOSE`,
    maximumDisplacementBps: config.signal.maximumEntryDisplacementBps,
    decisionBarCloseTime: plan.entryDecision.decisionBarCloseTime,
    maximumSignalAgeMs: config.signal.maximumEntrySignalAgeMs,
    ...(requiresSingleZ(config) ? {} : {
      marketState4h: plan.marketState4h,
      marketStateDirection: Number(plan.entryDecision.direction),
    }),
  };
  const entryMetadata = {
    implementationRevision: config.implementationRevision,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    riskPolicyRevision: config.riskPolicyRevision,
    riskPolicyAuthorizationId: config.riskPolicyAuthorizationId,
  };
  const strategyMetadata = {
    ...entryMetadata,
    dualZ: plan.dualZ ?? null,
    singleZ: plan.singleZ ?? null,
    dualZComparison: plan.dualZComparison ?? null,
    firstDiscoveredAt: plan.firstDiscoveredAt,
    planId: plan.id,
    pattern: plan.pattern,
    strategyVersion: config.candidateVersion,
    intersectionTime: plan.intersectionTime,
    intersectionPrice: plan.intersectionPrice,
    decisionBarOpenTime: plan.entryDecision.decisionBarOpenTime,
    decisionBarCloseTime: plan.entryDecision.decisionBarCloseTime,
    decisionClose: plan.entryDecision.decisionClose,
    entryConfirmationEvidence: {
      interval: entryDecisionInterval(config),
      policy: plan.entryDecision.confirmationPolicy,
      first: { openTime: plan.entryDecision.firstDecisionBarOpenTime, closeTime: plan.entryDecision.firstDecisionBarCloseTime, close: plan.entryDecision.firstDecisionClose },
      second: { openTime: plan.entryDecision.decisionBarOpenTime, closeTime: plan.entryDecision.decisionBarCloseTime, close: plan.entryDecision.decisionClose },
    },
    maximumEntryDisplacementBps: config.signal.maximumEntryDisplacementBps,
    maximumEntrySignalAgeMs: config.signal.maximumEntrySignalAgeMs,
    entryGuardAtSubmission: entryGuard,
    discoveryPromotion,
    primaryLineStatus: plan.primaryLineStatus,
    anchorConsensus: plan.anchorConsensus,
    intersectionRange: plan.intersectionRange,
    intersectionQuality: plan.intersectionQuality,
    anchors: plan.anchors,
    scale: plan.scale,
    structureLineage: reentryLineageGuard.candidate,
    reentryLineageGuardAtSubmission: reentryLineageGuard,
    marketState4h: plan.marketState4h,
    marketStateGateAtSubmission: hf11PlanGate.marketStateGate,
  };
  const beforePreflight = evaluateHf11PlanExecutionGate(plan, config, clock());
  if (!beforePreflight.allowed) return beforePreflight;
  const preflight = await planAutomaticRiskSizedEntry({ intentId, symbol: plan.symbol, side, stopPrice: plan.entryDecision.initialStop, entryGuard: gatewayEntryGuard, strategyMetadata, ...entryMetadata, confirmation: TESTNET_CONFIRMATION }, { now: clock(), state: managedState });
  const beforeSubmission = evaluateHf11PlanExecutionGate(plan, config, clock());
  if (!beforeSubmission.allowed) return beforeSubmission;
  await placeMarketEntry({ intentId, symbol: plan.symbol, side, quantity: preflight.quantity, stopPrice: plan.entryDecision.initialStop, entryGuard: gatewayEntryGuard, strategyMetadata, ...entryMetadata, confirmation: TESTNET_CONFIRMATION }, { now: clock(), clock, state: managedState });
  await persistManagedPositionMetadata(plan.symbol, {
    dualZ: plan.dualZ ?? null,
    singleZ: plan.singleZ ?? null,
    dualZComparison: plan.dualZComparison ?? null,
    firstDiscoveredAt: plan.firstDiscoveredAt,
    planId: plan.id,
    pattern: plan.pattern,
    strategyVersion: config.candidateVersion,
    implementationRevision: config.implementationRevision,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    riskPolicyRevision: config.riskPolicyRevision,
    riskPolicyAuthorizationId: config.riskPolicyAuthorizationId,
    intersectionTime: plan.intersectionTime,
    intersectionPrice: plan.intersectionPrice,
    decisionBarOpenTime: plan.entryDecision.decisionBarOpenTime,
    decisionBarCloseTime: plan.entryDecision.decisionBarCloseTime,
    decisionClose: plan.entryDecision.decisionClose,
    maximumEntryDisplacementBps: config.signal.maximumEntryDisplacementBps,
    maximumEntrySignalAgeMs: config.signal.maximumEntrySignalAgeMs,
    entryGuardAtSubmission: entryGuard,
    discoveryPromotion,
    primaryLineStatus: plan.primaryLineStatus,
    anchorConsensus: plan.anchorConsensus,
    intersectionRange: plan.intersectionRange,
    intersectionQuality: plan.intersectionQuality,
    anchors: plan.anchors,
    scale: plan.scale,
    structureLineage: reentryLineageGuard.candidate,
    reentryLineageGuardAtSubmission: reentryLineageGuard,
    marketState4h: plan.marketState4h,
    marketStateGateAtSubmission: hf11PlanGate.marketStateGate,
  }, { now });
  return {
    terminal: true,
    reason: existing ? "OPPOSITE_REPLACEMENT_EXECUTED" : requiresSingleZ(config) ? "NEW_HF14_ENTRY_EXECUTED" : requiresDualZ(config) ? "NEW_HF13_ENTRY_EXECUTED" : "NEW_HF11_ENTRY_EXECUTED",
    side,
    quantity: preflight.quantity,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    entryGuard,
    discoveryPromotion,
    reentryLineageGuard,
    marketStateGate: hf11PlanGate.marketStateGate,
  };
}

export async function executeV3AutomaticCycle(snapshot, options = {}) {
  const fixedNow = options.now ?? Date.now();
  const clock = options.clock ?? (options.now === undefined ? Date.now : () => fixedNow);
  const client = options.client ?? new V3DemoMarketClient();
  const now = clock();
  const config = await readJson(CONFIG_PATH);
  validateHighFrequencyConfig(config);
  const release = releasePolicy(config);
  if (!release) throw new Error("V3_RELEASE_NOT_AUTHORIZED");
  const [authorization, calendar, abnormalLossAuthorization, repairAuthorization] = await Promise.all([
    readJson(path.join(ROOT, release.authorizationPath)),
    readJson(CALENDAR_PATH),
    readJson(ABNORMAL_LOSS_GATE_AUTH_PATH),
    readJson(INTEGRITY_REPAIR_AUTH_PATH),
  ]);
  if (authorization?.status !== "ACTIVE" || authorization?.appliesTo?.release !== config?.implementationRevision || config?.execution?.residentScannerAutomaticOrderSubmissionAllowed !== true) {
    throw new Error("V3_HF11_AUTOMATIC_EXECUTION_NOT_AUTHORIZED");
  }
  const abnormalLossAuthority = validateAbnormalLossGateAuthorization(abnormalLossAuthorization, ABNORMAL_LOSS_GATE_SCOPE);
  if (snapshot?.executionReconciliation?.status !== "RECONCILED") {
    const errors = snapshot?.executionReconciliation?.errors ?? ["V3_EXECUTION_RECONCILIATION_MISSING"];
    await audit({
      eventType: "V3_BINANCE_DEMO_EXECUTION_RECONCILIATION_FAIL_CLOSED",
      occurredAt: new Date(now).toISOString(),
      errors,
    });
    return {
      status: "V3_BINANCE_DEMO_EXECUTION_RECONCILIATION_FAIL_CLOSED",
      evaluationCohortId: config.evaluationIsolation.forwardCohortId,
      management: [],
      executions: [],
      eventFreezeActive: false,
      positionManagementDegraded: true,
      lastError: errors.join("|"),
      newEntriesBlockedByPositionManagement: true,
      mutations: 0,
    };
  }
  const forwardCohortId = config.evaluationIsolation.forwardCohortId;
  const loadedAutoState = await readJson(AUTO_STATE_PATH, initialAutoState(now, config.implementationRevision, forwardCohortId, config.riskPolicyRevision));
  const autoState = transitionAutomaticState(loadedAutoState, config, now);
  if (autoState !== loadedAutoState) await writeJsonAtomic(AUTO_STATE_PATH, autoState);
  const managedState = await loadManagedTradingState();
  const managementPass = await runPositionManagementPass({ managedPositions: managedState.managedPositions, livePositions: snapshot.positions, config, client, clock });
  const management = managementPass.management;
  const managedStateAfterManagement = await loadManagedTradingState();
  const priorAbnormalLossStatus = autoState.abnormalLossGate?.status ?? "CLEAR";
  autoState.abnormalLossGate = evaluateV3IntegrityGate({
    priorState: autoState.abnormalLossGate,
    closedOutcomes: managedStateAfterManagement.closedPositions,
    managedPositions: managedStateAfterManagement.managedPositions,
    now: clock(),
    reconciled: managementPass.errors.length === 0 && snapshot?.executionReconciliation?.status === "RECONCILED",
    authority: abnormalLossAuthority,
    repairAuthorization,
  });
  // Persist the latch before any new-entry admission, even if a later step fails.
  await writeJsonAtomic(AUTO_STATE_PATH, autoState);
  if (priorAbnormalLossStatus !== autoState.abnormalLossGate.status || autoState.abnormalLossGate.activeTrigger?.closedAt === autoState.abnormalLossGate.lastEvaluatedAt) {
    await audit({
      eventType: "V3_ABNORMAL_SINGLE_LOSS_GATE_EVALUATED",
      occurredAt: new Date(clock()).toISOString(),
      priorStatus: priorAbnormalLossStatus,
      status: autoState.abnormalLossGate.status,
      entriesBlocked: autoState.abnormalLossGate.entriesBlocked,
      activeTrigger: autoState.abnormalLossGate.activeTrigger,
      integrityRepair: autoState.abnormalLossGate.integrityRepair ?? null,
    });
  }
  const eventWindow = tier1EventWindowAt({ now, policy: { enabled: true, freezeBeforeMinutes: config.eventRisk.freezeBeforeMinutes, freezeAfterMinutes: config.eventRisk.freezeAfterMinutes }, calendar });
  const executions = [];
  const executionErrors = [];
  const processed = new Set(autoState.processedPlanIds ?? []);
  const maximumNewEntriesPerCycle = Number(config.execution.maximumNewEntriesPerCycle);
  let newEntriesThisCycle = 0;
  for (const plan of managementPass.errors.length || autoState.abnormalLossGate.entriesBlocked ? [] : (snapshot.plans ?? [])) {
    if (processed.has(plan.id)) continue;
    const attemptNow = clock();
    if (newEntriesThisCycle >= maximumNewEntriesPerCycle) {
      const result = { terminal: false, reason: "MAXIMUM_NEW_ENTRIES_PER_CYCLE_REACHED", maximumNewEntriesPerCycle };
      executions.push({ planId: plan.id, symbol: plan.symbol, ...result });
      await audit({ eventType: "V3_HF11_AUTOMATIC_PLAN_DECISION", occurredAt: new Date(attemptNow).toISOString(), evaluationCohortId: config.evaluationIsolation.forwardCohortId, planId: plan.id, symbol: plan.symbol, result });
      continue;
    }
    try {
      const result = await executePlan(plan, autoState, eventWindow, config, attemptNow, clock, client);
      if (!result) continue;
      if (result.terminal) processed.add(plan.id);
      if (/EXECUTED/.test(result.reason ?? "")) newEntriesThisCycle += 1;
      executions.push({ planId: plan.id, symbol: plan.symbol, ...result });
      await audit({ eventType: "V3_HF11_AUTOMATIC_PLAN_DECISION", occurredAt: new Date(attemptNow).toISOString(), evaluationCohortId: config.evaluationIsolation.forwardCohortId, planId: plan.id, symbol: plan.symbol, result });
    } catch (error) {
      const failure = { planId: plan.id, symbol: plan.symbol, terminal: false, reason: error?.message ?? String(error) };
      executions.push(failure);
      executionErrors.push(failure);
      const afterFailure = await loadManagedTradingState();
      const priorStatus = autoState.abnormalLossGate.status;
      autoState.abnormalLossGate = evaluateV3IntegrityGate({ priorState: autoState.abnormalLossGate, closedOutcomes: afterFailure.closedPositions, managedPositions: afterFailure.managedPositions, repairAuthorization, authority: abnormalLossAuthority, now: clock(), reconciled: false });
      await writeJsonAtomic(AUTO_STATE_PATH, autoState);
      await audit({ eventType: "V3_HF11_AUTOMATIC_PLAN_ERROR_FAIL_CLOSED", occurredAt: new Date(attemptNow).toISOString(), evaluationCohortId: config.evaluationIsolation.forwardCohortId, planId: plan.id, symbol: plan.symbol, error: error?.message ?? String(error) });
      await audit({ eventType: "V3_ENTRY_ERROR_GATE_REASSESSED", occurredAt: new Date(clock()).toISOString(), priorStatus, status: autoState.abnormalLossGate.status, entriesBlocked: autoState.abnormalLossGate.entriesBlocked, activeTrigger: autoState.abnormalLossGate.activeTrigger, furtherEntryAttemptsStopped: true });
      break;
    }
  }
  const lastError = managementPass.errors.length
    ? `V3_POSITION_MANAGEMENT_ERRORS_${managementPass.errors.map((row) => `${row.symbol}:${row.error}`).join("|")}`
    : executionErrors.length ? `V3_ENTRY_ERROR_${executionErrors[0].reason}` : null;
  const nextState = { ...autoState, processedPlanIds: [...processed].slice(-10000), lastCycleAt: clock(), lastError, lastManagement: management, lastExecutions: executions };
  await writeJsonAtomic(AUTO_STATE_PATH, nextState);
  return {
    status: managementPass.errors.length ? "V3_HF11_POSITION_MANAGEMENT_DEGRADED_FAIL_CLOSED" : executionErrors.length ? "V3_HF11_ENTRY_ERROR_FAIL_CLOSED" : (requiresSingleZ(config) ? "V3_HF14_AUTOMATIC_CYCLE_COMPLETE" : requiresDualZ(config) ? "V3_HF13_AUTOMATIC_CYCLE_COMPLETE" : "V3_HF11_AUTOMATIC_CYCLE_COMPLETE"),
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    management,
    executions,
    eventFreezeActive: eventWindow.active,
    positionManagementDegraded: managementPass.errors.length > 0,
    lastError,
    newEntriesBlockedByPositionManagement: managementPass.errors.length > 0,
    newEntriesBlockedByAbnormalLossGate: autoState.abnormalLossGate.entriesBlocked,
    newEntriesBlockedByEntryError: executionErrors.length > 0,
    requiresReconciliation: executionErrors.length > 0,
    abnormalLossGate: autoState.abnormalLossGate,
    mutations: management.filter((row) => row.mutated === true).length + executions.filter((row) => /EXECUTED/.test(row.reason)).length,
  };
}
