import { createHash } from 'node:crypto';
import policy from './smc-s1-policy.json' with { type: 'json' };
import { advancePxFirstClose, pxFirstCloseSignal } from '../agents/shared/px-first-close.mjs';
import { sanitizeIntersectionClock } from './smc-intersection-clock.mjs';
import { smcBars, confirmedSmcPivots } from './smc-bar-evidence.mjs';
import { assessTargetPath, validate4hFvgEvidence } from './smc-target-path.mjs';
import { smcNetRewardRisk, SMC_SCAN_POLICY } from './smc-scanner.mjs';
import { align } from './s1-precision.mjs';

export const SMC_S1_ENTRY_REVISION = policy.revision;
export const SMC_S1_TRAIL_REVISION = policy.trailRevision;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const M15 = 900000;
const rounded = (price, tick, up) => Number(align(String(price), { step: String(tick), min: String(tick), max: '100000000000' }, up ? 'UP' : 'DOWN'));

// Same prospective objective hierarchy as SMC: nearest unswept genuine4H
// pivot, then the closer valid opposing4H FVG. R never selects a farther target.
export function smcPxTarget({ evidence, bars15m, direction, entry, stop, now }) {
  validate4hFvgEvidence(evidence, now);
  const h = smcBars(evidence.sourceBars, 14400000, now);
  const m = smcBars(bars15m, M15, now), long = direction === 'LONG', tick = evidence.tickSize;
  const objectives = confirmedSmcPivots(h).filter(p => p.kind === (long ? 'HIGH' : 'LOW')
    && !h.slice(p.index + 1).some(b => long ? b.high >= p.price : b.low <= p.price)
    && !m.some(b => b.openTime > p.time && (long ? b.high >= p.price : b.low <= p.price))
    && (long ? p.price - 2 * tick > Math.max(entry, m.at(-1).close)
      : p.price + 2 * tick < Math.min(entry, m.at(-1).close)))
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry) || b.confirmedAt - a.confirmedAt);
  const objective = objectives[0] ?? null;
  const referenceTarget = objective ? rounded(objective.price + (long ? -2 : 2) * tick, tick, !long) : null;
  const path = assessTargetPath({ evidence, direction, entry, stop, referenceTarget, tickSize: tick, now });
  return { objective, referenceTarget, path };
}

export function smcPxConfirmation({ window, bars15m, now }) {
  const clock = { revision: 'SMC-INTERSECTION-CLOCK-1', observedAt: now, coordinate: 'LOG', orderAuthority:false,
    futureCount: 0, windows: [window], active: now >= window.opensAt && now <= window.expiresAt ? window : null };
  sanitizeIntersectionClock(clock, now);
  const event = window.event, crossOpen = Math.floor(event.tx / M15) * M15;
  check(window.selectedAt <= crossOpen && event.firstSeenAt <= window.selectedAt, 'SMC_PX_NON_CAUSAL_DISCOVERY');
  const bars = smcBars(bars15m, M15, now);
  if (now <= crossOpen + M15 - 1) return { accepted: false, terminal: false, reason: 'SMC_PX_WAIT_CROSS_CLOSE' };
  check(bars.some(b => b.openTime === crossOpen), 'SMC_PX_CROSS_BAR_MISSING');
  // Reuse S1's actual direction-lock implementation; first cross bar or its
  // immediate next bar, with the same5bp buffer and no later substitution.
  const plan = advancePxFirstClose({ id: event.id, intersectionTime: event.tx,
    intersectionPrice: event.px, createdAt: window.selectedAt }, bars, now, policy.entryPolicy);
  const signal = pxFirstCloseSignal(plan);
  if (!signal.accepted) return signal;
  if (now - signal.bar.closeTime > policy.maximumSignalAgeMs || now - event.tx > policy.maximumCrossAgeMs)
    return { accepted: false, terminal: true, reason: 'SMC_PX_CONFIRMATION_EXPIRED' };
  return signal;
}

export function smcS1Candidate({ symbol, window, bars15m, evidence, quote, now, selection = null }) {
  const confirmation = smcPxConfirmation({ window, bars15m, now });
  if (!confirmation.accepted) return { candidate: null, assessment: { ready: false, reasons: [confirmation.reason] } };
  check(SMC_SCAN_POLICY.universe.includes(symbol) && evidence.symbol === symbol, 'SMC_PX_SYMBOL');
  if (selection) check(selection.symbol === symbol && ['LONG','SHORT'].includes(selection.direction)
    && Number.isFinite(selection.selectedAt) && selection.selectedAt <= now && typeof selection.autoTradingEnabled === 'boolean', 'SMC_PX_SELECTION');
  const direction = confirmation.direction === 1 ? 'LONG' : 'SHORT', long = direction === 'LONG';
  if (selection && selection.direction !== direction) return { candidate: null, assessment: { ready: false, reasons: ['SMC_PX_OWNER_DIRECTION_MISMATCH'] } };
  check(quote && [quote.bid, quote.ask, quote.time].every(Number.isFinite) && quote.bid > 0 && quote.ask >= quote.bid
    && quote.time <= now + 1000 && now - quote.time <= 15000, 'SMC_PX_QUOTE_STALE');
  // Exact S1 intersectionBufferStop formula; keep this wire/site boundary pure
  // rather than importing the archived paper CLI's top-level-await dependency.
  const rawStop=window.event.px*(1-confirmation.direction*policy.initialStopBufferBps/10000);
  check(Number.isFinite(rawStop)&&rawStop>0,'SMC_PX_STOP_INVALID');
  const stop = rounded(rawStop, evidence.tickSize, !long), entry = long ? quote.ask : quote.bid;
  const displacementBps = Math.abs(entry - confirmation.bar.close) / confirmation.bar.close * 10000;
  if (displacementBps > policy.maximumDisplacementBps) return { candidate: null, assessment: { ready: false, reasons: ['SMC_PX_PRICE_DISPLACEMENT'] } };
  const target = smcPxTarget({ evidence, bars15m, direction, entry, stop, now });
  if (!target.path.ready) return { candidate: null, assessment: { ready: false, reasons: [target.path.reason] } };
  const rr = smcNetRewardRisk({ direction, entry, stop, target: target.path.admissionTarget });
  if (!rr.qualified) return { candidate: null, assessment: { ready: false, reasons: ['SMC_PX_NET_R_BELOW_2'] } };
  const id = `SMC-PX-${createHash('sha256').update(`${symbol}:${window.event.id}`).digest('hex').slice(0,32).toUpperCase()}`;
  const band = { low: confirmation.bar.close * .995, high: confirmation.bar.close * 1.005,
    ce: window.event.px, trigger: window.event.px, half: 'S1_R19_CONFIRMATION_CLOSE_50BPS' };
  const candidate = { id, symbol, direction, revision: SMC_SCAN_POLICY.revision, modelRevision: SMC_S1_ENTRY_REVISION,
    candidateSource: selection ? 'OWNER_SELECTED' : 'AUTOMATIC', ownerSelectedAt: selection?.selectedAt ?? null,
    ownerAutoTradingEnabled: selection?.autoTradingEnabled ?? null, sourceSelection: selection,
    status: 'ENTRY_BAND_ACTIVE', reason: 'SMC_INTERSECTION_S1_PX_CONFIRMED',
    entry, stop, target: target.path.admissionTarget, netR: rr.netR, riskPerUnit: rr.riskPerUnit,
    netRewardPerUnit: rr.netRewardPerUnit, referenceEntry: window.event.px, entryBand: band,
    zone: { kind: 'PX', low: band.low, high: band.high, ce: window.event.px, availableAt: window.selectedAt, entryBand: band },
    intersectionEvent: window.event, sourceWindow: window, intersectionTime: window.event.tx, intersectionPrice: window.event.px,
    sourceReactionBars: bars15m.filter(b => Number(b[6]) < now).slice(-320).map(b => b.slice(0,7).map(Number)),
    sourceTargetPathEvidence: evidence, sourceQuote: quote, targetPathRevision: target.path.revision,
    referenceTarget: target.referenceTarget, objective: target.objective, targetPath: target.path,
    structure: { model: SMC_S1_ENTRY_REVISION, eventType: 'PX_CLOSE', bosAt: confirmation.bar.closeTime,
      currentBias: long ? 'BULLISH' : 'BEARISH', nPatternRequired: false, nPatternQualified: false },
    entryConfirmation: { mode: 'S1_TWO_BAR_PX_CLOSE_5BPS', closedBarRequired: true, confirmation },
    confirmationAt: confirmation.bar.closeTime, observedAt: now, availableAt: confirmation.bar.closeTime,
    expiresAt: Math.min(confirmation.bar.closeTime + policy.maximumSignalAgeMs, window.event.tx + policy.maximumCrossAgeMs),
    stopSafety: { revision: SMC_S1_ENTRY_REVISION, ready: true, reason: null, source: 'S1_PX_BUFFER_5BPS',
      automaticExecutionRequiresFreshBboAndRisk: true },
    quoteFresh: true, orderAuthority: false, executionQualified: false, winProbability: null };
  return { candidate, assessment: { revision: SMC_S1_ENTRY_REVISION, ready: true, reasons: [], stage: 'EXECUTION_RECHECK' } };
}

export function validateSmcS1Candidate(row, now) {
  check(row?.modelRevision === SMC_S1_ENTRY_REVISION && Number.isFinite(row.observedAt) && row.observedAt <= now
    && now - row.observedAt <= 360000 && row.expiresAt > now, 'SMC_PX_CANDIDATE_STALE');
  const expected = smcS1Candidate({ symbol: row.symbol, window: row.sourceWindow, bars15m: row.sourceReactionBars,
    evidence: row.sourceTargetPathEvidence, quote: row.sourceQuote, now: row.observedAt, selection: row.sourceSelection }).candidate;
  check(expected, 'SMC_PX_CANDIDATE_NOT_CONFIRMED');
  for (const key of Object.keys(expected)) check(JSON.stringify(row[key]) === JSON.stringify(expected[key]), `SMC_PX_CANDIDATE_MISMATCH_${key.toUpperCase()}`);
  return true;
}
