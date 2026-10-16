import path from "node:path";
import fs from "node:fs/promises";

import { tier1EventWindowAt } from "./event-risk.mjs";
import { readJson, writeJsonAtomic } from "./runtime-utils.mjs";
import { appendChainedAudit } from "../../../integrations/binance-usdm-testnet/audit-ledger.mjs";
import { netLiquidationR, stopForAggregateNetRFloor } from "../../orion-v2/paper/paper-engine.mjs";
import {
  V4_TESTNET_CONFIRMATION, v4CloseManagedPosition, v4FinalizeManagedPositionAbsentOnExchange,
  v4LoadManagedTradingState, v4PersistManagedPositionMetadata, v4PlaceMarketEntry,
  v4PlanAutomaticRiskSizedEntry, v4PlanReplacementRiskSizedEntry, v4ReduceManagedPosition, v4ReplaceManagedProtectiveStop,
} from "../../../experiments/v4-range-mean-reversion/src/execution-gateway.mjs";
import { ROOT, loadMtfxR20Context } from "./context.mjs";
import { V4DemoMarketClient } from "./market-client.mjs";
import { evaluateV4CostEfficiency, updateHourlyStructureTrail } from "./strategy.mjs";
import { markCandidateTerminal, validateCausalEntryEvidence } from "./execution-parity.mjs";
import {
  evaluateR21ProfitProtection,
  initialR21State,
  isR21EligibleSymbol,
  r21AtrTrail,
} from "../../shared/r21-profit-protection.mjs";
import {
  evaluateAbnormalLossGate,
  validateAbnormalLossGateAuthorization,
} from "../../shared/abnormal-loss-gate.mjs";

export const V4_AUTO_STATE_PATH = path.join(ROOT, ".runtime/orion-v4-binance-demo/auto-state.json");
export const V4_AUTO_AUDIT_PATH = path.join(ROOT, ".runtime/orion-v4-binance-demo/auto-audit.ndjson");
const ABNORMAL_LOSS_GATE_AUTH_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-25-v2-v3-v4-abnormal-single-loss-circuit-breaker.json");
const ABNORMAL_LOSS_GATE_SCOPE = "ORION_V4_BINANCE_DEMO";
let executionQueue = Promise.resolve();

function directionOf(position) { return Number(position?.direction) || (position?.side === "BUY" ? 1 : -1); }
function runtimeFor(config) { return { paperRisk: { takerFeeRate: config.risk.takerFeeRate, adverseSlippageRate: config.risk.adverseSlippageRate } }; }
function initialState(strategyActivatedAt, forwardSignalCutoffAt, config, prior = {}) {
  return {
    schemaVersion: 4,
    implementationRevision: config.implementationRevision,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    activatedAt: strategyActivatedAt,
    forwardSignalCutoffAt,
    riskPolicyRevision: config.riskPolicy.revision,
    riskPolicyAuthorizationId: config.riskPolicy.authorizationId,
    processedSignalIds: [],
    r21ProfitProtection: prior.r21ProfitProtection ?? initialR21State(strategyActivatedAt),
    eventRiskWindowsByKey: prior.eventRiskWindowsByKey ?? {},
    eventRiskAuditOutbox: prior.eventRiskAuditOutbox ?? [],
    abnormalLossGate: prior.abnormalLossGate ?? null,
    lastCycleAt: prior.lastCycleAt ?? null,
    lastError: null,
  };
}
async function audit(event) { await appendChainedAudit(V4_AUTO_AUDIT_PATH, { schemaVersion: 1, ...event }); }

async function recordedAutoEventIds() {
  try {
    const body = await fs.readFile(V4_AUTO_AUDIT_PATH, "utf8");
    return new Set(body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)?.eventId).filter(Boolean));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

export async function flushV4EventRiskAuditOutbox(autoState, { append = audit, recordedIds = recordedAutoEventIds } = {}) {
  const recorded = await recordedIds();
  for (const event of autoState.eventRiskAuditOutbox ?? []) {
    if (!recorded.has(event.eventId)) await append(event);
    recorded.add(event.eventId);
  }
  autoState.eventRiskAuditOutbox = [];
  return autoState;
}

export function applyV4EventFreezeState(autoState, eventWindow, policy, now) {
  autoState.eventRiskWindowsByKey ??= {};
  autoState.eventRiskAuditOutbox ??= [];
  for (const event of eventWindow?.events ?? []) {
    const releaseAt = Date.parse(event.scheduledAt);
    const startsAt = releaseAt - Number(policy.freezeBeforeMinutes) * 60_000;
    const endsAt = releaseAt + Number(policy.freezeAfterMinutes) * 60_000;
    const key = `${event.id}:${startsAt}:${endsAt}`;
    if (autoState.eventRiskWindowsByKey[key]) continue;
    const eventId = `V4_R13_FREEZE_START:${key}`;
    autoState.eventRiskWindowsByKey[key] = { eventId: event.id, startsAt, endsAt, freezeStartedAt: now, auditEventId: eventId };
    autoState.eventRiskAuditOutbox.push({ eventId, eventType: "V4_R13_TIER1_EVENT_ENTRY_FREEZE_STARTED", occurredAt: new Date(now).toISOString(), eventIds: [event.id], windowStartsAt: startsAt, windowEndsAt: endsAt });
  }
  return autoState;
}

export function v4EventFreezeCycleDisposition({ entriesAllowed, eventWindow, plans, management }) {
  return { management, entryRows: entriesAllowed && !eventWindow.active ? (plans ?? []).filter((item) => item.signal?.status?.startsWith("CONFIRMED_")) : [] };
}

export function evaluateV4EntryGuard(signal, quote, config, nowOrClocks = Date.now()) {
  const clocks = typeof nowOrClocks === "object" ? nowOrClocks : { decisionMarketTime: nowOrClocks, decisionLocalTime: nowOrClocks };
  const now = Number(clocks.decisionMarketTime);
  const side = signal?.side;
  if (!["BUY", "SELL"].includes(side)) return { allowed: false, terminal: true, reason: "V4_DIRECTION_NOT_CONFIRMED" };
  const executablePrice = side === "BUY" ? Number(quote?.ask) : Number(quote?.bid);
  const referencePrice = Number(signal.entryReferencePrice);
  const decisionBarCloseTime = Number(signal.decisionBarCloseTime);
  const expiresAt = decisionBarCloseTime + Number(config.signal.maximumEntrySignalAgeMs);
  if (!(executablePrice > 0 && referencePrice > 0)) throw new Error("V4_MTFX_ENTRY_BBO_INVALID");
  if (now < decisionBarCloseTime) return { allowed: false, terminal: false, reason: "V4_DECISION_BAR_NOT_CLOSED", expiresAt };
  if (now > expiresAt) return { allowed: false, terminal: true, reason: "V4_SIGNAL_EXPIRED", expiresAt };
  if (config.executionParity?.causalBboRequired === true) {
    const causal = validateCausalEntryEvidence({ quote, decisionBarCloseTime, now, decisionMarketTime: clocks.decisionMarketTime, decisionLocalTime: clocks.decisionLocalTime, stopReadyAt: decisionBarCloseTime, deadline: expiresAt, maximumAgeMs: 15_000 });
    if (!causal.accepted) return { allowed: false, terminal: causal.terminal, reason: causal.reason, expiresAt, causal };
  }
  const displacementBps = Math.abs(executablePrice - referencePrice) / referencePrice * 10_000;
  if (displacementBps > config.signal.maximumEntryDisplacementBps) return { allowed: false, terminal: false, reason: "V4_EXECUTABLE_PRICE_OUTSIDE_DISPLACEMENT", displacementBps, expiresAt };
  const costEfficiency = evaluateV4CostEfficiency({ direction: side === "BUY" ? 1 : -1, rawEntry: executablePrice, initialStop: signal.initialStop, config });
  if (!costEfficiency.allowed) return { allowed: false, terminal: true, reason: costEfficiency.reason, displacementBps, expiresAt, costEfficiency };
  return { allowed: true, terminal: false, reason: "V4_MTFX_ENTRY_GUARDS_PASSED", executablePrice, referencePrice, displacementBps, expiresAt, costEfficiency };
}

export function evaluateV4CurrentStructureReplacement({ plan, signal, existingPosition }) {
  const confirmedAt = Number(signal?.decisionBarCloseTime ?? signal?.confirmedAt);
  const proposedDirection = signal?.side === "BUY" ? 1 : signal?.side === "SELL" ? -1 : Number(signal?.direction);
  const reasons = [];
  if (plan?.fourHourLineStatus !== "ACTIVE_4H_TREND") reasons.push("REPLACEMENT_REQUIRES_ACTIVE_4H_LINEAGE");
  if (!(Number(plan?.intersectionTime) > Number(existingPosition?.intersectionTime))) reasons.push("REPLACEMENT_INTERSECTION_NOT_NEWER_THAN_EXISTING");
  if (!(confirmedAt > Number(existingPosition?.openedAt))) reasons.push("REPLACEMENT_CONFIRMATION_NOT_NEWER_THAN_EXISTING_OPEN");
  if (proposedDirection !== -directionOf(existingPosition)) reasons.push("REPLACEMENT_DIRECTION_NOT_OPPOSITE");
  return { accepted: reasons.length === 0, reason: reasons[0] ?? null, reasons, proposedDirection, directionConfirmedAt: Number.isFinite(confirmedAt) ? confirmedAt : null };
}

export function candidateTerminalStatusForResult(result) {
  if (/EXECUTED|RECOVERED_IDEMPOTENTLY/.test(String(result?.reason ?? ""))) return "CONSUMED";
  if (String(result?.reason ?? "").includes("EXPIRE")) return "EXPIRED";
  return "REJECTED";
}

export async function runV4ReplacementSequence({ eligibility, preview, close }) {
  if (!eligibility?.accepted) return { terminal: true, reason: eligibility?.reason ?? "V4_R15_REPLACEMENT_INELIGIBLE", replacementClosed: false };
  let previewPlan;
  try { previewPlan = await preview(); }
  catch (error) { return { terminal: true, reason: `V4_R15_REPLACEMENT_PREVIEW_REJECTED:${error?.message ?? String(error)}`, replacementClosed: false }; }
  await close();
  return { terminal: false, reason: "V4_R15_REPLACEMENT_PREVIEW_PASSED_AND_OLD_POSITION_CLOSED", replacementClosed: true, previewPlan };
}

function v4StrategyMetadata(row, signal, config, guard) {
  return {
    planId: row.plan.id,
    signalId: signal.signalId,
    strategyVersion: config.candidateVersion,
    intersectionTime: row.plan.intersectionTime,
    intersectionPrice: row.plan.intersectionPrice,
    decisionBarOpenTime: signal.decisionBarOpenTime,
    decisionBarCloseTime: signal.decisionBarCloseTime,
    decisionClose: signal.decisionClose,
    signalInitialRiskPerUnit: signal.initialRiskPerUnit,
    ...(guard ? { entryGuardAtSubmission: guard } : {}),
    sourceStrategyRevision: config.sourceStrategy.implementationRevision,
    sourceRuntimeAccessed: false,
  };
}

export function applyV4Partial(position, order, fallbackQuantity, reason, exactRemainingQuantity = null, feeRate = 0.0007) {
  const quantity = Number(order?.executedQty) || Number(fallbackQuantity);
  const fill = Number(order?.avgPrice) || Number(order?.price) || Number(position.lastExecutablePrice) || Number(position.entryPrice ?? position.entry);
  const originalQuantity = Number(position.originalQuantity);
  const entryFeeAllocated = Number(position.entryFee ?? 0) * quantity / originalQuantity;
  const commission = Number(order?.tradeCost?.commissionUsdt);
  const exitFee = order?.tradeCost?.allCommissionInUsdt === true && Number.isFinite(commission) ? commission : fill * quantity * feeRate;
  const exchangeRealized = Number(order?.tradeCost?.realizedPnlUsdt);
  const grossPnl = Number(order?.tradeCost?.tradeCount) > 0 && Number.isFinite(exchangeRealized) ? exchangeRealized : directionOf(position) * (fill - Number(position.entryPrice ?? position.entry)) * quantity;
  const remainingQuantity = Number.isFinite(Number(exactRemainingQuantity)) ? Math.max(0, Number(exactRemainingQuantity)) : Math.max(0, Number(position.quantity) - quantity);
  const currentPlannedRisk = Number(position.plannedRiskUsdt ?? position.initialPlannedRiskUsdt ?? 0);
  const plannedRiskUsdt = currentPlannedRisk > 0 && originalQuantity > 0 ? currentPlannedRisk * remainingQuantity / Number(position.quantity ?? originalQuantity) : 0;
  return { ...position, quantity: remainingQuantity, remainingQuantity, plannedRiskUsdt, initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt), cumulativeExitFee: Number(position.cumulativeExitFee ?? 0) + exitFee, cumulativeGrossPnl: Number(position.cumulativeGrossPnl ?? 0) + grossPnl, cumulativeRealizedNetPnl: Number(position.cumulativeRealizedNetPnl ?? 0) + grossPnl - entryFeeAllocated - exitFee, partialExits: [...(position.partialExits ?? []), { reason, quantity, fill, entryFeeAllocated, exitFee, grossPnl, netPnl: grossPnl - entryFeeAllocated - exitFee, orderId: order?.orderId ?? null }] };
}

export function applyV4ConfirmedProtectionRiskRelease(position, floor, confirmedStop) {
  if (!(Number(floor) > 0)) return position;
  const target = stopForAggregateNetRFloor(position, runtimeFor({ risk: { takerFeeRate: 0.0007, adverseSlippageRate: 0.0002 } }), floor);
  const protectedAtOrBeyondTarget = directionOf(position) === 1 ? Number(confirmedStop) >= target : Number(confirmedStop) <= target;
  return protectedAtOrBeyondTarget ? { ...position, plannedRiskUsdt: 0, positiveNetRProtectionFloor: floor } : position;
}

export function updateV4ExcursionState(position, currentNetR) {
  const netR = Number(currentNetR);
  if (!Number.isFinite(netR)) return { position, changed: false };
  const maximumNetExcursionR = Math.max(Number(position.maximumNetExcursionR ?? Number.NEGATIVE_INFINITY), netR);
  const minimumNetExcursionR = Math.min(Number(position.minimumNetExcursionR ?? Number.POSITIVE_INFINITY), netR);
  const runnerMaximumNetExcursionR = position.secondPartialTaken === true || ["RUNNER_25", "RUNNER_15"].includes(position.stage)
    ? Math.max(Number(position.runnerMaximumNetExcursionR ?? Number.NEGATIVE_INFINITY), 2, netR)
    : position.runnerMaximumNetExcursionR;
  const changed = maximumNetExcursionR !== position.maximumNetExcursionR || minimumNetExcursionR !== position.minimumNetExcursionR || runnerMaximumNetExcursionR !== position.runnerMaximumNetExcursionR;
  return { position: { ...position, maximumNetExcursionR, minimumNetExcursionR, ...(runnerMaximumNetExcursionR === undefined ? {} : { runnerMaximumNetExcursionR }) }, changed };
}

export function evaluateV4R17CausalPlan(position, quote, config) {
  if (!quote || quote.symbol !== position.symbol || !Number.isSafeInteger(Number(quote.updateId)) || !(Number(quote.eventTime ?? quote.marketTime) > 0) || !(Number(quote.receivedAt) > 0)) throw new Error("V4_R17_CAUSAL_BBO_EVIDENCE_INVALID");
  const normalized = { ...position, direction: directionOf(position), entry: Number(position.entry ?? position.entryPrice), stop: Number(position.stop ?? position.stopPrice), quantity: Number(position.quantity), originalQuantity: Number(position.originalQuantity ?? position.quantity), initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt) };
  const executable = normalized.direction === 1 ? Number(quote.bid) : Number(quote.ask);
  const netR = netLiquidationR(normalized, executable, runtimeFor(config));
  return {
    netR,
    halfR: !(normalized.softLockTaken || normalized.partial20Executed || normalized.partial40Executed) && netR >= 0.5,
    oneR: !(normalized.firstPartialTaken || normalized.partial30Executed || normalized.partial25AtOneRExecuted) && netR >= 1,
    twoR: !(normalized.secondPartialTaken || normalized.partial25Executed || normalized.partial20AtTwoRExecuted) && netR >= 2,
    halfRProtectionStop: stopForAggregateNetRFloor(normalized, runtimeFor(config), config.exit.halfNetRLock),
    oneRProtectionStop: stopForAggregateNetRFloor(normalized, runtimeFor(config), config.exit.oneNetRLock),
    causalEvidence: { updateId: Number(quote.updateId), eventTime: Number(quote.eventTime ?? quote.marketTime), receivedAt: Number(quote.receivedAt) },
  };
}

async function reduceStage(position, fraction, reason, config, clock) {
  const result = await v4ReduceManagedPosition({ intentId: `${position.intentId}:${reason}`, symbol: position.symbol, quantity: Number(position.originalQuantity) * fraction, reason, confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock });
  return applyV4Partial(position, result.order, result.quantity, reason, result.remainingQuantity, config.risk.takerFeeRate);
}

async function tightenToFloor(current, floor, role, config, clock) {
  const stop = stopForAggregateNetRFloor(current, runtimeFor(config), floor);
  const tighter = stop > 0 && (directionOf(current) === 1 ? stop > Number(current.stop ?? current.stopPrice) : stop < Number(current.stop ?? current.stopPrice));
  if (!tighter) {
    const alreadyProtected = stop > 0 && (directionOf(current) === 1 ? Number(current.stop ?? current.stopPrice) >= stop : Number(current.stop ?? current.stopPrice) <= stop);
    return alreadyProtected && floor > 0 ? { ...current, plannedRiskUsdt: 0, positiveNetRProtectionFloor: floor } : current;
  }
  const changed = await v4ReplaceManagedProtectiveStop({ intentId: `${current.intentId}:${role}`, symbol: current.symbol, stopPrice: stop, role, confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock });
  return mergeV4ProtectionState(current, changed.nextState.managedPositions[current.symbol], changed.stopPrice, floor);
}

export function mergeV4ProtectionState(current, gatewayPosition, confirmedStop, floor = 0) {
  return {
    ...gatewayPosition,
    ...current,
    quantity: Number(gatewayPosition?.quantity ?? current.quantity),
    remainingQuantity: Number(gatewayPosition?.remainingQuantity ?? gatewayPosition?.quantity ?? current.remainingQuantity ?? current.quantity),
    stop: Number(confirmedStop),
    stopPrice: Number(confirmedStop),
    stopClientOrderId: gatewayPosition?.stopClientOrderId ?? current.stopClientOrderId,
    stopOrderId: gatewayPosition?.stopOrderId ?? current.stopOrderId,
    stopAlgoId: gatewayPosition?.stopAlgoId ?? current.stopAlgoId,
    ...(Number(floor) > 0 ? { plannedRiskUsdt: 0, positiveNetRProtectionFloor: floor } : {}),
  };
}

async function managePositions(snapshot, config, sourceStrategy, client, clock, r21Actions = [], onlySymbols = null) {
  const state = await v4LoadManagedTradingState();
  const liveBySymbol = new Map((snapshot.positions ?? []).map((row) => [row.symbol, row]));
  const results = [], errors = [];
  for (const position of Object.values(state.managedPositions ?? {})) {
    if (onlySymbols && !onlySymbols.has(position.symbol)) continue;
    try {
      if (!liveBySymbol.has(position.symbol)) { await v4FinalizeManagedPositionAbsentOnExchange({ symbol: position.symbol }, { now: clock() }); results.push({ symbol: position.symbol, action: "RECONCILED_CLOSED", mutated: true }); continue; }
      const quote = await client.book(position.symbol);
      let current = { ...position, direction: directionOf(position), entry: Number(position.entry ?? position.entryPrice), stop: Number(position.stop ?? position.stopPrice), quantity: Number(position.quantity), originalQuantity: Number(position.originalQuantity ?? position.quantity), initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt), status: "OPEN" };
      const executable = current.direction === 1 ? quote.bid : quote.ask;
      let r17Plan = evaluateV4R17CausalPlan(current, quote, config);
      let netR = r17Plan.netR;
      const actions = [];
      let excursion = updateV4ExcursionState(current, netR);
      current = excursion.position;
      let metadataChanged = excursion.changed;
      const r21Action = r21Actions.find((action) => action.positionId === current.intentId || action.symbol === current.symbol);
      if (r21Action?.type === "CLOSE_INITIAL" && isR21EligibleSymbol(current.symbol, config.portfolioProfitProtection)) {
        await v4CloseManagedPosition({ intentId: `${current.intentId}:r21hard`, symbol: current.symbol, reason: "R21_PORTFOLIO_HARD_PROFIT_PROTECTION", confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock });
        results.push({ symbol: current.symbol, action: "R21_PORTFOLIO_HARD_PROFIT_PROTECTION", mutated: true });
        continue;
      }
      if (r21Action?.type === "REDUCE_INITIAL" && current.r21DefenseReductionTaken !== true && isR21EligibleSymbol(current.symbol, config.portfolioProfitProtection)) {
        current = await reduceStage(current, Number(r21Action.fractionOfOriginal), "r21Defense25", config, clock);
        current.r21DefenseReductionTaken = true;
        current.r21DefenseReductionAt = clock();
        actions.push("R21_PORTFOLIO_DEFENSE_REDUCTION");
      }
      if (r17Plan.halfR) { current = await reduceStage(current, config.exit.halfNetRCloseFraction, "halfR40", config, clock); current.partial40Executed = true; current = await tightenToFloor(current, config.exit.halfNetRLock, "lock15", config, clock); current.softLockTaken = true; current.stage = "BALANCED_LOCK_60_REMAINING"; actions.push("PARTIAL_40_AT_0_5R_AND_LOCK_0_15R"); }
      r17Plan = evaluateV4R17CausalPlan(current, quote, config); netR = r17Plan.netR;
      if (r17Plan.oneR) { current = await reduceStage(current, config.exit.oneNetRCloseFraction, "oneR25", config, clock); current.partial25AtOneRExecuted = true; current.firstPartialTaken = true; current = await tightenToFloor(current, config.exit.oneNetRLock, "lock60", config, clock); current.stage = "AFTER_1R_35_REMAINING"; actions.push("PARTIAL_25_AT_1R_AND_LOCK_0_60R"); }
      r17Plan = evaluateV4R17CausalPlan(current, quote, config); netR = r17Plan.netR;
      if (r17Plan.twoR) { current = await reduceStage(current, config.exit.twoNetRCloseFraction, "twoR20", config, clock); current.partial20AtTwoRExecuted = true; current.secondPartialTaken = true; current.stage = "RUNNER_15"; actions.push("PARTIAL_20_AT_2R_RUNNER_15_ACTIVE"); }
      excursion = updateV4ExcursionState(current, netR);
      current = excursion.position;
      metadataChanged ||= excursion.changed;
      if (current.secondPartialTaken) {
        const serverTime = await client.serverTime();
        const [bars1h, bars15m] = await Promise.all([
          client.bars(current.symbol, "1h", 1200, serverTime),
          client.bars(current.symbol, "15m", 320, serverTime),
        ]);
        const trail = updateHourlyStructureTrail(current, bars1h, sourceStrategy);
        if (trail.changed) { const changed = await v4ReplaceManagedProtectiveStop({ intentId: `${current.intentId}:trail1h:${trail.position.lastTrailingStructureConfirmedAt}`, symbol: current.symbol, stopPrice: trail.position.stop, role: "trail1h", confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock }); current = { ...trail.position, ...changed.nextState.managedPositions[current.symbol] }; actions.push("RUNNER_1H_TRAIL_TIGHTENED"); }
        const atrTrail = r21AtrTrail({ ...current, status: "OPEN", direction: directionOf(current) }, bars15m, config.portfolioProfitProtection);
        if (atrTrail.changed && Number(atrTrail.position.lastR21AtrTrailBarCloseTime) > Number(current.lastR21AtrTrailBarCloseTime ?? 0)) {
          const changed = await v4ReplaceManagedProtectiveStop({ intentId: `${current.intentId}:r21atr15m:${atrTrail.position.lastR21AtrTrailBarCloseTime}`, symbol: current.symbol, stopPrice: atrTrail.position.stop, role: "r21atr15m", confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock });
          current = { ...atrTrail.position, ...changed.nextState.managedPositions[current.symbol] };
          actions.push("R21_RUNNER_15M_ATR_TRAIL_TIGHTENED");
        }
      }
      if (actions.length || metadataChanged) await v4PersistManagedPositionMetadata(current.symbol, current, { now: clock() });
      results.push({ symbol: current.symbol, action: actions.join("+") || "NO_MANAGEMENT_CHANGE", currentNetR: netR, mutated: actions.length > 0 });
    } catch (error) { errors.push({ symbol: position.symbol, error: error?.message ?? String(error) }); }
  }
  return { results, errors };
}

export async function executeV4Signal(row, signal, config, autoState, client, clock, dependencies = {}) {
  const now = clock();
  const loadManagedState = dependencies.loadManagedState ?? v4LoadManagedTradingState;
  const placeMarketEntry = dependencies.placeMarketEntry ?? v4PlaceMarketEntry;
  const persistManagedPositionMetadata = dependencies.persistManagedPositionMetadata ?? v4PersistManagedPositionMetadata;
  let managedState = await loadManagedState();
  const intentId = `v4mtfx:${signal.signalId}`;
  const metadata = {
    implementationRevision: config.implementationRevision,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    riskPolicyRevision: config.riskPolicy.revision,
    riskPolicyAuthorizationId: config.riskPolicy.authorizationId,
  };
  const existing = managedState.managedPositions?.[row.symbol];
  // A deterministic, already-filled same-cohort intent is recovery, not a new
  // entry attempt.  Reconcile it before cutoff, BBO freshness, displacement or
  // signal-age gates and never replace its original submission evidence with a
  // later quote.
  if (existing?.intentId === intentId && existing.evaluationCohortId === config.evaluationIsolation.forwardCohortId) {
    const recoveryMetadata = v4StrategyMetadata(row, signal, config, null);
    await placeMarketEntry({ intentId, symbol: row.symbol, side: signal.side, stopPrice: signal.initialStop, ...metadata, strategyMetadata: recoveryMetadata, confirmation: V4_TESTNET_CONFIRMATION, quantity: Number(existing.quantity) }, { now, clock, state: managedState });
    await persistManagedPositionMetadata(row.symbol, recoveryMetadata, { now: clock() });
    return { terminal: true, reason: "V4_MTFX_ENTRY_RECOVERED_IDEMPOTENTLY", side: signal.side, quantity: Number(existing.quantity), guard: existing.entryGuardAtSubmission ?? null };
  }
  if (Number(signal.decisionBarCloseTime) < Number(autoState.forwardSignalCutoffAt)) return { terminal: true, reason: "PRE_RISK_ACTIVATION_SIGNAL_NOT_BACKFILLED" };
  const quote = await client.book(row.symbol);
  const decisionMarketTime = await client.serverTime();
  const guard = evaluateV4EntryGuard(signal, quote, config, { decisionMarketTime, decisionLocalTime: now });
  if (!guard.allowed) return { terminal: guard.terminal, reason: guard.reason, guard };
  const gatewayGuard = { intersectionPrice: row.plan.intersectionPrice, referencePrice: signal.decisionClose, referenceType: "CONFIRMED_15M_DECISION_CLOSE", maximumDisplacementBps: config.signal.maximumEntryDisplacementBps, decisionBarCloseTime: signal.decisionBarCloseTime, decisionReadyMarketTime: signal.decisionBarCloseTime, deadline: Number(signal.decisionBarCloseTime) + Number(config.signal.maximumEntrySignalAgeMs), maximumSignalAgeMs: config.signal.maximumEntrySignalAgeMs, maximumCausalBboAgeMs: 15_000, minimumCausalUpdateIdExclusive: Number(quote.updateId) };
  const strategyMetadata = v4StrategyMetadata(row, signal, config, guard);
  const entryInput = { intentId, symbol: row.symbol, side: signal.side, stopPrice: signal.initialStop, entryGuard: gatewayGuard, ...metadata, strategyMetadata, confirmation: V4_TESTNET_CONFIRMATION };
  const entryEvidenceProvider = async ({ symbol, minimumUpdateIdExclusive }) => {
    const freshQuote = typeof client.bookAfter === "function" ? await client.bookAfter(symbol, minimumUpdateIdExclusive) : await client.book(symbol);
    return { quote: freshQuote, decisionMarketTime: await client.serverTime(), decisionLocalTime: clock() };
  };
  const entryQualityEvaluator = (rawEntry, { normalizedStopPrice } = {}) => evaluateV4CostEfficiency({ direction: signal.side === "BUY" ? 1 : -1, rawEntry, initialStop: Number(normalizedStopPrice ?? signal.initialStop), config });
  const gatewayOptions = { entryEvidenceProvider, entryQualityEvaluator };
  if (existing) {
    const eligibility = evaluateV4CurrentStructureReplacement({ plan: row.plan, signal, existingPosition: existing });
    const replacement = await runV4ReplacementSequence({
      eligibility,
      preview: () => v4PlanReplacementRiskSizedEntry({ ...entryInput, replacement: { existingIntentId: existing.intentId } }, { now, state: managedState, ...gatewayOptions }),
      close: () => v4CloseManagedPosition({ intentId: `v4mtfx:replace:${signal.signalId}`, symbol: row.symbol, reason: "ELIGIBLE_OPPOSITE_SIGNAL_REPLACEMENT", confirmation: V4_TESTNET_CONFIRMATION }, { now: clock(), clock }),
    });
    if (replacement.terminal) return { ...replacement, eligibility };
    managedState = await v4LoadManagedTradingState();
    try {
      const preflight = await v4PlanAutomaticRiskSizedEntry(entryInput, { now: clock(), state: managedState, ...gatewayOptions });
      await v4PlaceMarketEntry({ ...entryInput, entryGuard: { ...gatewayGuard, minimumCausalUpdateIdExclusive: Number(preflight.causalEntryEvidence?.updateId ?? gatewayGuard.minimumCausalUpdateIdExclusive) }, quantity: preflight.quantity }, { now: clock(), clock, state: managedState, ...gatewayOptions });
      await v4PersistManagedPositionMetadata(row.symbol, strategyMetadata, { now: clock() });
      return { terminal: true, reason: "V4_MTFX_OPPOSITE_REPLACEMENT_EXECUTED", side: signal.side, quantity: preflight.quantity, guard };
    } catch (error) {
      return { terminal: true, reason: `V4_R15_POST_CLOSE_FRESH_PREFLIGHT_OR_ENTRY_FAILED_EMPTY_POSITION:${error?.message ?? String(error)}`, replacementClosed: true, guard };
    }
  }
  let preflight;
  try {
    preflight = await v4PlanAutomaticRiskSizedEntry(entryInput, { now, state: managedState, ...gatewayOptions });
    await v4PlaceMarketEntry({ ...entryInput, entryGuard: { ...gatewayGuard, minimumCausalUpdateIdExclusive: Number(preflight.causalEntryEvidence?.updateId ?? gatewayGuard.minimumCausalUpdateIdExclusive) }, quantity: preflight.quantity }, { now: clock(), clock, state: managedState, ...gatewayOptions });
  } catch (error) {
    const message = error?.message ?? String(error);
    if (/COMPLETE_LIFECYCLE_COST_LIMIT|ENTRY_SIGNAL_STALE|CAUSAL_BBO_AFTER_ENTRY_DEADLINE/.test(message)) return { terminal: true, reason: `V4_MTFX_TERMINAL_FINAL_PREFLIGHT_REJECTED:${message}`, guard };
    throw error;
  }
  await v4PersistManagedPositionMetadata(row.symbol, strategyMetadata, { now: clock() });
  return { terminal: true, reason: "V4_MTFX_ENTRY_EXECUTED", side: signal.side, quantity: preflight.quantity, guard };
}

async function executeV4AutomaticCycleUnlocked(snapshot, options = {}) {
  const fixedNow = options.now ?? Date.now();
  const clock = options.clock ?? (options.now === undefined ? Date.now : () => fixedNow);
  const client = options.client ?? new V4DemoMarketClient();
  const [{ authorization, config, sourceStrategy, calendar }, abnormalLossAuthorization] = await Promise.all([
    loadMtfxR20Context(),
    readJson(ABNORMAL_LOSS_GATE_AUTH_PATH),
  ]);
  const abnormalLossAuthority = validateAbnormalLossGateAuthorization(abnormalLossAuthorization, ABNORMAL_LOSS_GATE_SCOPE);
  const strategyActivatedAt = Date.parse(authorization.issuedAt);
  const forwardSignalCutoffAt = Date.parse(config.executionParity?.activatedAt ?? config.riskPolicy.activatedAt);
  const loaded = await readJson(V4_AUTO_STATE_PATH, initialState(strategyActivatedAt, forwardSignalCutoffAt, config));
  const strategyStateMatches = loaded.implementationRevision === config.implementationRevision && Number(loaded.activatedAt) === strategyActivatedAt;
  const riskStateMatches = loaded.riskPolicyRevision === config.riskPolicy.revision && loaded.riskPolicyAuthorizationId === config.riskPolicy.authorizationId && Number(loaded.forwardSignalCutoffAt) === forwardSignalCutoffAt;
  const autoState = strategyStateMatches && riskStateMatches
    ? loaded
    : initialState(strategyActivatedAt, forwardSignalCutoffAt, config, strategyStateMatches ? loaded : {});
  const guardQuotes = Object.fromEntries(await Promise.all(config.portfolioProfitProtection.eligibleSymbols.map(async (symbol) => [symbol, await client.book(symbol)])));
  const managedStateForGuard = await v4LoadManagedTradingState();
  const guardPositions = Object.values(managedStateForGuard.managedPositions ?? {}).flatMap((position) => {
    const quote = guardQuotes[position.symbol];
    if (!quote || !isR21EligibleSymbol(position.symbol, config.portfolioProfitProtection)) return [];
    const normalized = { ...position, direction: directionOf(position), entry: Number(position.entry ?? position.entryPrice), quantity: Number(position.quantity), originalQuantity: Number(position.originalQuantity ?? position.quantity), initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt) };
    const executable = normalized.direction === 1 ? Number(quote.bid) : Number(quote.ask);
    const currentNetR = netLiquidationR(normalized, executable, runtimeFor(config));
    const initialRiskPerUnit = Number(normalized.initialRiskPerUnit ?? normalized.initialPlannedRiskUsdt / normalized.originalQuantity);
    return [{ id: position.intentId, symbol: position.symbol, direction: normalized.direction, initialRiskUsdt: normalized.initialPlannedRiskUsdt, markedNetPnlUsdt: Number(position.cumulativeRealizedNetPnl ?? 0) + currentNetR * initialRiskPerUnit * normalized.quantity, initialStage: position.softLockTaken !== true && position.firstPartialTaken !== true && currentNetR < 0.5 }];
  });
  const guardOutcome = evaluateR21ProfitProtection({ priorState: autoState.r21ProfitProtection, positions: guardPositions, quotes: guardQuotes, equityUsdt: Number(snapshot?.account?.totalMarginBalanceUsdt ?? 0), now: clock(), config: config.portfolioProfitProtection });
  autoState.r21ProfitProtection = {
    ...guardOutcome.state,
    freezeEligibleEntries: guardOutcome.freezeEligibleEntries,
    frozenDirections: guardOutcome.frozenDirections,
  };
  const management = await managePositions(snapshot, config, sourceStrategy, client, clock, guardOutcome.actions);
  const managedStateAfterManagement = await v4LoadManagedTradingState();
  const priorAbnormalLossStatus = autoState.abnormalLossGate?.status ?? "CLEAR";
  autoState.abnormalLossGate = evaluateAbnormalLossGate({
    priorState: autoState.abnormalLossGate,
    closedOutcomes: managedStateAfterManagement.closedPositions,
    now: clock(),
    reconciled: management.errors.length === 0 && snapshot?.executionReconciliation?.status === "RECONCILED",
    scope: ABNORMAL_LOSS_GATE_SCOPE,
    activatedAt: abnormalLossAuthority.activatedAt,
    authorizationId: abnormalLossAuthority.authorizationId,
  });
  if (priorAbnormalLossStatus !== autoState.abnormalLossGate.status) {
    await audit({ eventType: "V4_ABNORMAL_SINGLE_LOSS_GATE_EVALUATED", occurredAt: new Date(clock()).toISOString(), priorStatus: priorAbnormalLossStatus, status: autoState.abnormalLossGate.status, entriesBlocked: autoState.abnormalLossGate.entriesBlocked, activeTrigger: autoState.abnormalLossGate.activeTrigger });
  }
  const entriesAllowed = management.errors.length === 0 && snapshot?.executionReconciliation?.status === "RECONCILED" && config.executionParity?.auditRemediationNewEntriesFailClosed !== true && !autoState.abnormalLossGate.entriesBlocked;
  const eventWindow = tier1EventWindowAt({ now: clock(), policy: config.eventRisk, calendar });
  applyV4EventFreezeState(autoState, eventWindow, config.eventRisk, clock());
  if (autoState.eventRiskAuditOutbox.length) {
    await writeJsonAtomic(V4_AUTO_STATE_PATH, autoState);
    await flushV4EventRiskAuditOutbox(autoState);
    await writeJsonAtomic(V4_AUTO_STATE_PATH, autoState);
  }
  const processed = new Set(autoState.processedSignalIds ?? []), executions = [];
  let newEntries = 0;
  const disposition = v4EventFreezeCycleDisposition({ entriesAllowed, eventWindow, plans: snapshot.plans, management: management.results });
  for (const row of disposition.entryRows) {
    const signal = row.signal;
    if (processed.has(signal.signalId) || newEntries >= config.risk.maximumNewEntriesPerCycle) continue;
    if (
      isR21EligibleSymbol(row.symbol, config.portfolioProfitProtection) &&
      guardOutcome.frozenDirections.includes(Number(signal.direction))
    ) continue;
    try { const result = await executeV4Signal(row, signal, config, autoState, client, clock); if (result.terminal) { processed.add(signal.signalId); if (config.executionParity?.enabled === true) await markCandidateTerminal({ symbol: row.symbol, planId: row.plan.id, signalId: signal.signalId, status: candidateTerminalStatusForResult(result), reason: result.reason }, { activatedAt: forwardSignalCutoffAt, cohortId: config.evaluationIsolation.forwardCohortId, implementationRevision: config.implementationRevision, signalPolicy: sourceStrategy.signal, now: clock() }); } if (/EXECUTED|RECOVERED_IDEMPOTENTLY/.test(result.reason)) newEntries += 1; executions.push({ symbol: row.symbol, signalId: signal.signalId, ...result }); await audit({ eventType: "V4_MTFX_AUTOMATIC_SIGNAL_DECISION", occurredAt: new Date(clock()).toISOString(), symbol: row.symbol, signalId: signal.signalId, result }); }
    catch (error) { executions.push({ symbol: row.symbol, signalId: signal.signalId, terminal: false, reason: error?.message ?? String(error) }); await audit({ eventType: "V4_MTFX_AUTOMATIC_SIGNAL_ERROR_FAIL_CLOSED", occurredAt: new Date(clock()).toISOString(), symbol: row.symbol, signalId: signal.signalId, error: error?.message ?? String(error) }); }
  }
  const errors = management.errors.map((row) => `${row.symbol}:${row.error}`);
  await writeJsonAtomic(V4_AUTO_STATE_PATH, { ...autoState, processedSignalIds: [...processed].slice(-10_000), lastCycleAt: clock(), lastError: errors.length ? errors.join("|") : null, lastManagement: management.results, lastExecutions: executions });
  return { status: errors.length ? "V4_MTFX_POSITION_MANAGEMENT_DEGRADED_FAIL_CLOSED" : "V4_MTFX_AUTOMATIC_CYCLE_COMPLETE", management: management.results, executions, eventFreezeActive: eventWindow.active, r21EligibleEntriesFrozen: guardOutcome.freezeEligibleEntries, r21FrozenDirections: guardOutcome.frozenDirections, newEntriesBlocked: !entriesAllowed || eventWindow.active, newEntriesBlockedByAbnormalLossGate: autoState.abnormalLossGate.entriesBlocked, abnormalLossGate: autoState.abnormalLossGate, positionManagementDegraded: errors.length > 0, mutations: management.results.filter((row) => row.mutated).length + newEntries, lastError: errors.length ? errors.join("|") : null };
}

function serialized(task) {
  const run = executionQueue.then(task);
  executionQueue = run.catch(() => {});
  return run;
}

export function executeV4AutomaticCycle(snapshot, options = {}) {
  return serialized(() => executeV4AutomaticCycleUnlocked(snapshot, options));
}

export function executeV4CausalManagementTick(snapshot, quote, options = {}) {
  return serialized(async () => {
    const fixedNow = options.now ?? Number(quote?.receivedAt) ?? Date.now();
    const clock = options.clock ?? (() => fixedNow);
    const client = options.client;
    const { config, sourceStrategy } = await loadMtfxR20Context();
    if (config.executionParity?.causalBboRequired !== true) return { status: "V4_CAUSAL_MANAGEMENT_NOT_ACTIVE", mutations: 0 };
    const management = await managePositions(snapshot, config, sourceStrategy, client, clock, [], new Set([quote.symbol]));
    const errors = management.errors.map((row) => `${row.symbol}:${row.error}`);
    return { status: errors.length ? "V4_CAUSAL_MANAGEMENT_DEGRADED_FAIL_CLOSED" : "V4_CAUSAL_MANAGEMENT_TICK_COMPLETE", management: management.results, mutations: management.results.filter((row) => row.mutated).length, lastError: errors.length ? errors.join("|") : null };
  });
}
