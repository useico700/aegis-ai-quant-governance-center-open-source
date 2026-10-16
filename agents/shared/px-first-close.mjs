import crypto from 'node:crypto';
import { simpleAdmission, simpleAdmissionMaximumPxBps, SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION } from './px-band-risk-only.mjs';

export const PX_FIRST_CLOSE_REVISION = 'S1-S2-PX-FIRST-CLOSE-P2-20260916';
export const R221_TWO_BAR_REVISION = 'S1-R221-TWO-BAR-CLOSE-20260925';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const side = (close, px) => close > px ? 1 : close < px ? -1 : 0;
const inBand = (close, px, direction, maximumPxBps = 200) => direction === 1
  ? close > px && close <= px * (1 + maximumPxBps / 10_000)
  : close < px && close >= px * (1 - maximumPxBps / 10_000);
const routeFor = (close, px, direction, revision) => {
  const simplified = [SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION].includes(revision);
  const maximumPxBps = simplified ? simpleAdmissionMaximumPxBps({ entryAdmissionRevision: revision }) : 200;
  return inBand(close, px, direction, maximumPxBps) ? 'DIRECT_NEAR_PX'
    : simplified ? 'FIRST_CLOSE_OUTSIDE_BAND' : 'FIRST_PULLBACK';
};

const initialState = plan => ({ schemaVersion: 1, revision: PX_FIRST_CLOSE_REVISION,
  planId: plan.id, direction: null, route: null, processedCloseTime: null,
  opportunity: null, invalidatedAt: null, reason: 'DIRECTION_CLOSE_PENDING' });

function validBar(bar) {
  return [bar?.openTime, bar?.closeTime, bar?.open, bar?.high, bar?.low, bar?.close].every(finite)
    && bar.openTime < bar.closeTime && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= bar.low;
}

export function advancePxFirstClose(plan, bars, now, policy = null) {
  if (!plan || typeof plan.id !== 'string' || !finite(plan.intersectionTime)
    || !finite(plan.intersectionPrice) || plan.intersectionPrice <= 0 || !finite(now)) {
    throw new Error('PX_FIRST_CLOSE_PLAN_INVALID');
  }
  const simplified = simpleAdmission(policy);
  const r221 = policy?.entryMode === 'TWO_BAR_CROSS_CLOSE_WITH_BUFFER'
    && policy?.maximumDirectionDecisionBars === 2;
  const revision = simplified ? policy.entryAdmissionRevision : r221 ? R221_TWO_BAR_REVISION : PX_FIRST_CLOSE_REVISION;
  const existing = plan.pxEntryState;
  const compatible = existing?.planId === plan.id && (existing.revision === revision
    || (simplified && [PX_FIRST_CLOSE_REVISION, SIMPLE_ADMISSION_REVISION].includes(existing.revision)));
  let state = compatible ? structuredClone(existing) : initialState(plan);
  state.revision = revision;
  // Preserve terminal state and opportunity identity across the policy migration.
  // An older far-close state may recover its direction bar only from actual OHLC.
  if (simplified && !state.opportunity && state.direction !== null && state.invalidatedAt === null) {
    const known = (bars ?? []).filter(bar => validBar(bar) && bar.closeTime >= plan.intersectionTime
      && bar.closeTime <= now && bar.closeTime <= state.processedCloseTime
      && side(bar.close, plan.intersectionPrice) === state.direction).sort((a, b) => a.closeTime - b.closeTime)[0];
    if (known) state.processedCloseTime = known.closeTime - 1;
  }
  const ordered = (bars ?? []).filter(bar => validBar(bar) && bar.closeTime >= plan.intersectionTime
    && bar.closeTime <= now && (state.processedCloseTime === null || bar.closeTime > state.processedCloseTime))
    .sort((a, b) => a.openTime - b.openTime);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].openTime <= ordered[index - 1].openTime) throw new Error('PX_FIRST_CLOSE_BAR_ORDER_INVALID');
  }
  if (r221) {
    const buffer = Number(policy.crossCloseBufferBps);
    if (!Number.isFinite(buffer) || buffer < 0 || buffer > 100) throw new Error('R221_CLOSE_BUFFER_INVALID');
    state.decisionBarsProcessed = Number.isInteger(state.decisionBarsProcessed) ? state.decisionBarsProcessed : 0;
    const firstTwo = ordered.slice(0, Math.max(0, 2 - state.decisionBarsProcessed));
    for (const bar of firstTwo) {
      state.processedCloseTime = bar.closeTime;
      state.decisionBarsProcessed += 1;
      if (state.invalidatedAt !== null || state.opportunity) continue;
      const upper = plan.intersectionPrice * (1 + buffer / 10_000);
      const lower = plan.intersectionPrice * (1 - buffer / 10_000);
      const direction = bar.close >= upper ? 1 : bar.close <= lower ? -1 : 0;
      if (direction === 0) {
        state.reason = 'R221_DIRECTION_CLOSE_PENDING';
        continue;
      }
      state.direction = direction; state.route = 'R221_TWO_BAR_CLOSE';
      const label = direction === 1 ? 'LONG' : 'SHORT';
      state.opportunity = { id: hash({ revision, planId: plan.id, direction: label,
        closedAt: bar.closeTime, close: String(bar.close) }), direction: label,
      numericDirection: direction, route: state.route, closedAt: bar.closeTime,
      bar: { openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open,
        high: bar.high, low: bar.low, close: bar.close } };
      state.reason = 'R221_DIRECTION_CLOSE_LOCKED';
    }
    if (!state.opportunity && state.invalidatedAt === null && state.decisionBarsProcessed >= 2) {
      state.invalidatedAt = state.processedCloseTime;
      state.reason = 'R221_TWO_BAR_DIRECTION_EXPIRED';
    }
    return Object.freeze({ ...plan, pxEntryState: Object.freeze(state) });
  }
  for (const bar of ordered) {
    const barSide = side(bar.close, plan.intersectionPrice);
    state.processedCloseTime = bar.closeTime;
    if (state.invalidatedAt !== null) continue;
    if (state.direction === null) {
      if (barSide === 0) { state.reason = 'DIRECTION_CLOSE_PENDING'; continue; }
      state.direction = barSide;
      state.route = routeFor(bar.close, plan.intersectionPrice, barSide, revision);
    } else if (barSide === -state.direction) {
      state.invalidatedAt = bar.closeTime; state.reason = 'REVERSE_PX_CLOSE'; continue;
    }
    if (!state.opportunity && (simplified || inBand(bar.close, plan.intersectionPrice, state.direction))) {
      const direction = state.direction === 1 ? 'LONG' : 'SHORT';
      state.opportunity = { id: hash({ revision, planId: plan.id,
        direction, closedAt: bar.closeTime, close: String(bar.close) }), direction,
      numericDirection: state.direction, route: state.route, closedAt: bar.closeTime,
      bar: { openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open,
        high: bar.high, low: bar.low, close: bar.close } };
      state.reason = simplified ? 'DIRECTION_CLOSE_CONFIRMED_WAIT_LIVE_BAND' : 'PX_FIRST_QUALIFYING_CLOSE_LOCKED';
    } else if (!state.opportunity) state.reason = 'PX_FIRST_PULLBACK_PENDING';
  }
  return Object.freeze({ ...plan, pxEntryState: Object.freeze(state) });
}

export function pxFirstCloseSignal(plan) {
  const state = plan?.pxEntryState;
  if (![PX_FIRST_CLOSE_REVISION, R221_TWO_BAR_REVISION, SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION].includes(state?.revision) || state.planId !== plan.id) {
    return { accepted: false, terminal: false, reason: 'PX_FIRST_CLOSE_STATE_PENDING' };
  }
  if (state.invalidatedAt !== null) return { accepted: false, terminal: true, reason: state.reason ?? 'REVERSE_PX_CLOSE' };
  if (!state.opportunity) return { accepted: false, terminal: false, reason: state.reason };
  return { accepted: true, terminal: false, reason: 'FIRST_QUALIFYING_CLOSE',
    direction: state.opportunity.numericDirection,
    bar: state.opportunity.bar,
    // Old persisted telemetry can say FIRST_PULLBACK for an S2 2–3% first close.
    // Correct the readout without rewriting the immutable opportunity identity.
    route: [SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION].includes(state.revision)
      && Number.isFinite(state.opportunity.bar?.close) && Number.isFinite(plan.intersectionPrice)
      ? routeFor(state.opportunity.bar.close, plan.intersectionPrice, state.opportunity.numericDirection, state.revision)
      : state.opportunity.route,
    opportunityId: state.opportunity.id };
}
