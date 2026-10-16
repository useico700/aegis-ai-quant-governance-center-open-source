import { parentSupportsPullback } from './smc-pullback-scope.mjs';
import { createHash } from 'node:crypto';
import { smcNetRewardRisk, SMC_SCAN_POLICY } from './smc-scanner.mjs';
import { sanitizeStructurePlans } from './smc-structure-plan.mjs';
import { sanitizeStructureContext } from './smc-structure-context.mjs';
import { planPriceEvent } from './smc-plan-lifecycle.mjs';

export const CONTINUATION_REVISION = 'SMC-CONTINUATION-2';
const check = (ok, code) => { if (!ok) throw new Error(code); };
const finite = n => typeof n === 'number' && Number.isFinite(n);
const inside = (x, b) => x >= b.low && x <= b.high;

/** Model-specific admission, not a vote across all four directional states. */
export function continuationAssessment(plan, context, quote, now) {
  const reasons = [], long = plan.direction === 'LONG', expected = long ? 'BULLISH' : 'BEARISH';
  if (plan.stopBasis && (!plan.stopBasis.ready || plan.stopBasis.entryValid === false)) reasons.push('STRUCTURAL_STOP_UNCONFIRMED');
  const parent = context?.frames?.['4h'], hour = context?.frames?.['1h'];
  const event = parent?.lastExternalEvent;
  if (!parentSupportsPullback(plan,parent,now)) reasons.push('PARENT_TREND_NOT_CONFIRMED');
  const local = plan.tradeScope === 'SMC-PULLBACK-SCOPE-1' && plan.stopBasis?.kind === 'LOCAL_PULLBACK_INVALIDATION';
  if (hour?.status !== 'READY' || !['BULLISH','BEARISH','TRANSITION','RANGE'].includes(hour.bias)) reasons.push('HOUR_CONTEXT_UNAVAILABLE');
  else if (!['TRANSITION','RANGE',expected].includes(hour.bias) && !local) reasons.push('HOUR_DIRECTION_CONFLICT');
  if ((!local && ![expected, 'RANGE'].includes(plan.opportunity?.sequenceBias))
    || plan.opportunity.anchorLabel !== (long ? 'HL' : 'LH')) reasons.push('WAIT_CONTINUATION_SEQUENCE');
  const t = plan.entryReview?.timing;
  if (!t?.ready) reasons.push(t?.state ?? 'TIMING_UNAVAILABLE');
  // Historical touches cannot become new executable signals on discovery.
  if (t?.ready && (t.touchAt <= plan.availableAt || t.confirmation.openTime <= plan.availableAt)) reasons.push('TRIGGER_PREDATES_PLAN');
  if (!(plan.netR >= 2)) reasons.push('NET_R_BELOW_2');
  const q = quote, fresh = q && finite(q.time) && now - q.time >= -1000 && now - q.time <= 15000
    && finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask >= q.bid;
  if (!fresh) reasons.push('QUOTE_UNAVAILABLE');
  if (planPriceEvent(plan, { quote: q, now })) reasons.push('PLAN_NOT_ACTIVE');
  let band = null;
  if (t?.ready && plan.entryReview.planned.entryFor2R != null) {
    const tolerance = t.atr5m * .25, cap = plan.entryReview.planned.entryFor2R;
    band = long ? { low: plan.zone.low, high: Math.min(t.confirmation.close + tolerance, cap) }
      : { low: Math.max(t.confirmation.close - tolerance, cap), high: plan.zone.high };
    if (!(band.high > band.low)) reasons.push('NO_EXECUTABLE_PRICE_BAND');
  }
  const price = fresh ? (long ? q.ask : q.bid) : null;
  const ready = reasons.length === 0;
  return { revision: CONTINUATION_REVISION, ready, reasons,
    stage: !ready ? 'CONDITIONAL' : inside(price, band) ? 'EXECUTION_RECHECK' : 'WAIT_PRICE',
    band, price, parentEpisodeId: parent?.episodeId ?? null, parentEvent: event ?? null };
}

export function continuationCandidate(plan, context, quote, now, selection = null) {
  check(selection == null || selection.symbol === plan.symbol && selection.direction === plan.direction
    && finite(selection.selectedAt) && selection.selectedAt <= now && typeof selection.autoTradingEnabled === 'boolean', 'CONTINUATION_OWNER_SELECTION');
  const normalized = sanitizeStructureContext(context, now);
  const a = continuationAssessment(plan, normalized, quote, now);
  if (!a.ready) return { candidate: null, assessment: a };
  const active = a.stage === 'EXECUTION_RECHECK';
  const entry = active ? a.price : Math.max(a.band.low, Math.min(a.band.high, plan.entry));
  const rr = smcNetRewardRisk({ ...plan, entry });
  if (!rr.qualified) return { candidate: null, assessment: { ...a, ready: false, reasons: ['NET_R_BELOW_2'] } };
  const t = plan.entryReview.timing, parent = normalized.frames['4h'];
  const id = `SMC-CONT-${createHash('sha256').update(`${plan.id}:${parent.episodeId}:${t.confirmation.closeTime}`).digest('hex').slice(0,32).toUpperCase()}`;
  const band = { ...a.band, ce: plan.entry, trigger: plan.entry, half: 'CONFIRMED_RETEST_PRICE_BAND' };
  const distance = a.price < band.low ? band.low - a.price : a.price > band.high ? a.price - band.high : 0;
  return { assessment: a, candidate: {
    id, symbol: plan.symbol, direction: plan.direction, revision: SMC_SCAN_POLICY.revision, modelRevision: CONTINUATION_REVISION,
    candidateSource: selection ? 'OWNER_SELECTED' : 'AUTOMATIC', ownerSelectedAt: selection?.selectedAt ?? null, ownerAutoTradingEnabled: selection?.autoTradingEnabled ?? null, sourceSelection: selection,
    status: active ? 'ENTRY_BAND_ACTIVE' : 'WAIT_CE_REENTRY', reason: active ? 'CONTINUATION_CONFIRMED' : 'WAIT_CONTINUATION_PRICE',
    entry, stop: plan.stop, target: plan.target, netR: rr.netR, riskPerUnit: rr.riskPerUnit, netRewardPerUnit: rr.netRewardPerUnit,
    referenceEntry: plan.entry, entryBand: band, zone: { ...plan.zone, availableAt: plan.availableAt, entryBand: { low: band.low, high: band.high } },
    sourcePlan: structuredClone(plan), sourceContext: normalized, sourceQuote: quote,
    anchor: plan.anchor, availableAt: plan.availableAt, lifecyclePolicy: 2, lifecycleGeneration: plan.lifecycleGeneration,
    structure: { eventType: a.parentEvent.type === 'BOS' ? 'BOS' : 'MSS', bosAt: a.parentEvent.at,
      currentBias: parent.bias, protectedPivot: parent.protectedPoint, parentEpisodeId: parent.episodeId,
      model: CONTINUATION_REVISION, nPatternRequired: false, nPatternQualified: false },
    entryConfirmation: { mode: 'CLOSED_5M_CONTINUATION_RETEST', state: active ? 'ENTRY_BAND_ACTIVE' : 'WAIT_CE_REENTRY',
      closedBarRequired: true, timing: t, liveBboInsideBand: active },
    confirmationAt: t.confirmation.closeTime, observedAt: now,
    expiresAt: Math.min(plan.expiresAt, t.confirmation.closeTime + SMC_SCAN_POLICY.entryMicroStructureMaximumAgeMs),
    entryHistoryCoverage: 'CONTINUOUS_FROM_PLAN', quoteFresh: true,
    distanceToEntry: { executablePrice: a.price, absolute: distance, percent: distance / plan.entry * 100,
      quoteAt: quote.time, side: plan.direction === 'LONG' ? 'ASK' : 'BID', basis: 'NEAREST_ENTRY_BAND_EDGE' },
    orderAuthority: false, executionQualified: false, winProbability: null,
  } };
}

export function validateContinuationCandidate(row, now) {
  check(row?.modelRevision === CONTINUATION_REVISION && finite(row.observedAt)
    && now - row.observedAt <= 360000 && now - row.observedAt >= -5000 && row.expiresAt > now, 'CONTINUATION_STALE');
  sanitizeStructurePlans([row.sourcePlan], row.symbol, row.observedAt);
  const expected = continuationCandidate(row.sourcePlan, row.sourceContext, row.sourceQuote, row.observedAt, row.sourceSelection).candidate;
  check(expected !== null, 'CONTINUATION_MODEL_NOT_CONFIRMED');
  for (const key of Object.keys(expected)) check(JSON.stringify(row[key]) === JSON.stringify(expected[key]), `CONTINUATION_MISMATCH_${key.toUpperCase()}`);
  return true;
}
