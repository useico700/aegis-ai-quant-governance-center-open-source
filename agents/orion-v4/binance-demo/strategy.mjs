import {
  evaluateV2CostEfficiencyGate,
  findConvergencePlan,
  intersectionBufferStop,
  signalForPlan,
  updateHourlyStructureTrail,
} from "../../orion-v2/paper/paper-engine.mjs";
import { costAdjustedRiskPlan } from "../../../scripts/v2-mtf-trendline-intersection.mjs";
import { deterministicId } from "./runtime-utils.mjs";
import { confirmationReserveDeadline, selectCommittedParityPlan } from "./execution-parity.mjs";

const FIFTEEN_MINUTES = 900_000;

export function evaluateV4CostEfficiency({ direction, rawEntry, initialStop, config }) {
  const slippage = Number(config.risk.adverseSlippageRate);
  const feeRate = Number(config.risk.takerFeeRate);
  const entry = Number(rawEntry) * (direction === 1 ? 1 + slippage : 1 - slippage);
  if (!(direction * (entry - Number(initialStop)) > 0)) return { allowed: false, reason: "INTERSECTION_BUFFER_STOP_NOT_PROTECTIVE", entry, initialRiskPerUnit: null };
  const costPlan = costAdjustedRiskPlan({
    direction,
    entry,
    initialStop: Number(initialStop),
    entryCostPerUnit: entry * feeRate,
    initialStopExitCostPerUnit: Number(initialStop) * (feeRate + slippage),
    breakEvenExitCostPerUnit: entry * (feeRate + slippage),
    firstTakeProfitExitCostPerUnit: entry * (feeRate + slippage),
    softTakeProfitNetR: 0.5,
    firstTakeProfitNetR: 1,
    secondTakeProfitNetR: 2,
  });
  if (!costPlan.accepted) return { allowed: false, reason: costPlan.reason, entry, initialRiskPerUnit: null };
  return evaluateV2CostEfficiencyGate({ entry, initialRiskPerUnit: costPlan.initialRiskPerUnit, takerFeeRate: feeRate, adverseSlippageRate: slippage, maximumCompleteLifecycleCostR: config.signal.maximumCompleteLifecycleCostR });
}

export function selectV4MtfxPlan({ discovered, previousPlan, now, sourceStrategy, config }) {
  return selectCommittedParityPlan({ discovered, previousPlan, now, sourceStrategy, config });
}

export function buildV4MtfxSignal({ plan, bars15m, now, sourceStrategy, config }) {
  if (!plan) return { status: "NO_SIGNAL", reason: "NO_MTFX_INTERSECTION_PLAN" };
  const decision = signalForPlan({ plan, bars15m, now, signalPolicy: sourceStrategy.signal });
  if (!decision.accepted) return { status: "NO_SIGNAL", reason: decision.reason, terminal: decision.terminal === true };
  if (Number(plan.createdAt) > Number(decision.bar?.openTime)) return { status: "NO_SIGNAL", reason: "V4_MTFX_LOOKAHEAD_GUARD_REJECTED", terminal: true };
  const stopPlan = intersectionBufferStop(decision.direction, plan.intersectionPrice, sourceStrategy.stop.intersectionBufferBps, decision.bar);
  if (!stopPlan.accepted) return { status: "NO_SIGNAL", reason: stopPlan.reason, terminal: true };
  const entry = Number(decision.bar.close);
  const costEfficiency = evaluateV4CostEfficiency({ direction: decision.direction, rawEntry: entry, initialStop: stopPlan.stop, config });
  if (!costEfficiency.allowed) return { status: "NO_SIGNAL", reason: costEfficiency.reason, terminal: true, costEfficiency };
  const side = decision.direction === 1 ? "BUY" : "SELL";
  const reserveDeadline = confirmationReserveDeadline(plan, sourceStrategy.signal);
  const oppositeThreshold = Number(plan.intersectionPrice) * (1 - decision.direction * Number(sourceStrategy.signal.crossCloseBufferBps) / 10_000);
  const oppositeBar = (bars15m ?? []).find((bar) =>
    Number(bar.closeTime) > Number(decision.bar.closeTime) &&
    Number(bar.closeTime) <= Number(now) &&
    Number(bar.closeTime) <= reserveDeadline &&
    (decision.direction === 1 ? Number(bar.close) <= oppositeThreshold : Number(bar.close) >= oppositeThreshold)
  );
  return {
    status: decision.direction === 1 ? "CONFIRMED_LONG" : "CONFIRMED_SHORT",
    signalId: deterministicId("v4mtfxr21", { planId: plan.id, barOpenTime: decision.bar.openTime, side, riskPolicyRevision: config.riskPolicy.revision }),
    planId: plan.id,
    symbol: plan.symbol,
    side,
    direction: decision.direction,
    decisionBarOpenTime: decision.bar.openTime,
    decisionBarCloseTime: decision.bar.closeTime,
    decisionClose: entry,
    entryReferencePrice: entry,
    initialStop: stopPlan.stop,
    initialRiskPerUnit: costEfficiency.initialRiskPerUnit,
    riskPolicyRevision: config.riskPolicy.revision,
    riskPolicyAuthorizationId: config.riskPolicy.authorizationId,
    evaluationCohortId: config.evaluationIsolation.forwardCohortId,
    costEfficiency,
    directionDecisionBarNumber: decision.directionDecisionBarNumber,
    ...(oppositeBar ? { oppositePriceAcceptanceObservation: { observedAt: Number(oppositeBar.closeTime), barOpenTime: Number(oppositeBar.openTime), direction: -decision.direction } } : {}),
  };
}

export function scanSymbolMtfx({ symbol, bars15m, bars1h, bars4h, sourceStrategy, config, previousRow = null, now }) {
  const discovered = findConvergencePlan({ symbol, bars15m, bars1h, bars4h, now, strategy: sourceStrategy });
  const riskTaggedDiscovery = discovered ? {
    ...discovered,
    riskPolicyRevisionAtDiscovery: config.riskPolicy.revision,
    riskPolicyAuthorizationIdAtDiscovery: config.riskPolicy.authorizationId,
    evaluationCohortIdAtDiscovery: config.evaluationIsolation.forwardCohortId,
  } : null;
  const plan = selectV4MtfxPlan({ discovered: riskTaggedDiscovery, previousPlan: previousRow?.plan ?? null, now, sourceStrategy, config });
  const signal = buildV4MtfxSignal({ plan, bars15m, now, sourceStrategy, config });
  return {
    symbol,
    plan,
    assessment: {
      eligible: Boolean(plan),
      economicPrequalified: signal.costEfficiency?.allowed === true,
      reason: plan ? "MTFX_INTERSECTION_PLAN_ACTIVE" : "NO_MTFX_INTERSECTION_PLAN",
    },
    signal,
  };
}

export { updateHourlyStructureTrail };
