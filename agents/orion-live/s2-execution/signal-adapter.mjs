import { simpleAdmission, causalPxPlan, SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION } from '../../shared/px-band-risk-only.mjs';
import { intersectionBufferStop } from '../../orion-v2/paper/paper-engine.mjs';
import { advancePxFirstClose, pxFirstCloseSignal } from '../../shared/px-first-close.mjs';
import { evaluateEventGate } from '../s2-scanner/event-gate.mjs';
import { REVISION, invariant } from './common.mjs';
import { S2_Z_STRUCTURE_REVISION, validateS2ZPlanEvidence } from '../../shared/s2-z-structure.mjs';

// The additional bars are existing cached evidence, never a synchronous venue
// read. Legacy strategies retain their historical interpretation for replay.
export function executionSignal(plan, bars5m, strategy, now, { bars15m, bars1h } = {}) {
  const simplified = simpleAdmission(strategy.signal);
  invariant(strategy.implementationRevision === REVISION, 'S2_STRATEGY_REVISION_MISMATCH');
  if (strategy.structureRevision != null) {
    invariant(strategy.structureRevision === S2_Z_STRUCTURE_REVISION, 'S2_STRUCTURE_POLICY_MISMATCH');
    const structure = validateS2ZPlanEvidence(plan, { now, bars15m, bars1h });
    if (!structure.allowed) return { accepted: false, terminal: structure.terminal === true,
      reason: structure.reason, structureStatus: structure.status };
  }
  if (simplified) plan = advancePxFirstClose(plan, bars5m, now, strategy.signal);
  if (!simplified && [SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION].includes(plan.pxEntryState?.revision))
    return { accepted: false, terminal: false, reason: 'PX_ADMISSION_POLICY_MISMATCH' };
  const signal = pxFirstCloseSignal(plan);
  if (!signal.accepted) return { accepted: false, reason: signal.reason, terminal: signal.terminal === true };
  invariant(simplified ? causalPxPlan(plan, now) : Number.isFinite(plan.createdAt) && plan.createdAt <= signal.bar.openTime, 'NON_CAUSAL_SCANNER_PLAN');
  const stop = intersectionBufferStop(signal.direction, plan.intersectionPrice, strategy.signal.crossCloseBufferBps, signal.bar);
  invariant(stop.accepted, 'STOP_PLAN_REJECTED');
  const iq1Plan = Object.freeze({ id: plan.id, symbol: plan.symbol, createdAt: plan.createdAt,
    intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice,
    anchors: plan.anchors, fourHourLine: plan.fourHourLine, oneHourLine: plan.oneHourLine,
    ...(strategy.structureRevision ? { structureRevision: plan.structureRevision, zStructure: structuredClone(plan.zStructure),
      pattern: plan.pattern, lockedBarOpenTime: plan.lockedBarOpenTime } : {}) });
  return { accepted: true, signal: { id: plan.id, symbol: plan.symbol, revision: REVISION, direction: signal.direction === 1 ? 'LONG' : 'SHORT',
    entryAdmissionRevision: simplified ? strategy.signal.entryAdmissionRevision : null,
    closedAt: signal.bar.closeTime, close: String(signal.bar.close), discoveredAt: plan.createdAt, firstBarOpenTime: signal.bar.openTime,
    intersectionTime: plan.intersectionTime, fourHourLineStatus: plan.fourHourLineStatus, stopPrice: String(stop.stop),
    iq1Direction: signal.direction, iq1Bar: signal.bar, iq1Plan, pxOpportunityId: signal.opportunityId,
    pxEntryRoute: signal.route,
    ...(strategy.structureRevision ? { structureRevision: plan.structureRevision, zStructure: structuredClone(plan.zStructure) } : {}) } };
}

// Geometry is frozen; validation windows may grow between ordinary polls.
// Full proof validation must precede this identity comparison at every gate.
export const structureCommitIdentity = plan => plan?.structureRevision ? {
  revision: plan.structureRevision, geometryHash: plan.zStructure?.geometryHash,
} : null;

export function entryEventGate(calendar, now, policy = null) {
  if (simpleAdmission(policy)) return { allowed: true, newEntriesPaused: false,
    status: 'PX_P5_CALENDAR_INFORMATION_ONLY', checkedAt: now, validUntil: now + 1000 };
  const result = evaluateEventGate(calendar, now);
  const deadline = result.nextWindowAt ? Date.parse(result.nextWindowAt) : now + 1000;
  return { ...result, allowed: result.newEntriesPaused === false, checkedAt: now, validUntil: Math.min(now + 1000, deadline) };
}
