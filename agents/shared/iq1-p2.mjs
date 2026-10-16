import { simpleAdmission, validateSimpleAdmission, causalPxPlan } from './px-band-risk-only.mjs';
import {
  IQ1_REVISION as P1_REVISION,
  validateIq1Profile as validateP1,
  freezeIq1Context as freezeP1,
  iq1Digest as digestP1,
  iq1Anchor as anchorP1,
  buildIq1Correlation as correlationP1,
  evaluateIq1Portfolio as portfolioP1,
} from '../orion-v2/paper/iq1-entry-quality.mjs';

export const IQ1_REVISION = 'S1-S2-IQ1-P4-PX-RIGHT-SIDE-LIVE-BAND-20260918';
export const IQ1_AUTHORIZATION = 'OWNER-DIRECTIVE-S1-S2-R224-IQ1-P4-LIVE-20260918';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const p1 = profile => ({ ...profile, revision: P1_REVISION });
const out = (status, reason, metrics = {}) => ({ allowed: status === 'PASS', status, reason,
  terminal: status === 'REJECT', revision: IQ1_REVISION, metrics });

export function validateIq1Profile(profile, risk) {
  if (profile?.revision !== IQ1_REVISION) throw new Error('IQ1_PROFILE_REVISION_INVALID');
  if (profile?.schemaVersion !== 4 || profile?.pxAtrExecutionGate !== false
    || profile?.pxAtrPurpose !== 'TELEMETRY_ONLY' || profile?.convergenceExecutionGate !== false
    || profile?.convergencePurpose !== 'TELEMETRY_ONLY'
    || (simpleAdmission(profile) ? false : profile?.maximumPxBps !== 200))
    throw new Error('IQ1_PX_AUTHORITY_INVALID');
  if (profile.entryAdmissionRevision != null) return validateSimpleAdmission(profile);
  validateP1(p1(profile), risk);
  return profile;
}

export function freezeIq1Context(plan, bars, profile, observedAt, options) {
  const context = options ? freezeEntryIntervalContext(plan, bars, p1(profile), observedAt, options)
    : freezeP1(plan, bars, p1(profile), observedAt);
  return context ? { ...context, profileRevision: IQ1_REVISION } : null;
}

function freezeEntryIntervalContext(plan, bars, profile, observedAt,
  { barIntervalMs = 900000, lineCoordinateMs = 900000 } = {}) {
  const tx = plan.intersectionTime, px = plan.intersectionPrice;
  if (!positive(barIntervalMs) || !positive(lineCoordinateMs) || !positive(tx) || !positive(px)
    || !finite(observedAt) || observedAt > tx || !finite(plan.createdAt) || plan.createdAt > tx
    || !Array.isArray(plan.anchors) || plan.anchors.length !== 4
    || plan.anchors.some(anchor => !finite(anchor.confirmedAt) || anchor.confirmedAt > tx)) return null;
  const last = Math.floor(tx / barIntervalMs) * barIntervalMs - 1;
  const count = Math.max(profile.atrPeriod * 4 + 1, profile.compressionBars * 2);
  const contiguous = (bars ?? []).filter(bar => finite(bar.closeTime) && bar.closeTime <= last).slice(-count);
  if (contiguous.length !== count || contiguous.at(-1).closeTime !== last || last > observedAt) return null;
  for (let index = 0; index < contiguous.length; index++) {
    const bar = contiguous[index];
    if (![bar.open, bar.high, bar.low, bar.close].every(positive)
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || bar.high < bar.low || bar.closeTime !== bar.openTime + barIntervalMs - 1
      || (index && bar.openTime !== contiguous[index - 1].openTime + barIntervalMs)) return null;
  }
  const ranges = contiguous.slice(1).map((bar, index) => Math.max(bar.high - bar.low,
    Math.abs(bar.high - contiguous[index].close), Math.abs(bar.low - contiguous[index].close)));
  let atr = ranges.slice(0, profile.atrPeriod).reduce((sum, value) => sum + value, 0) / profile.atrPeriod;
  for (const value of ranges.slice(profile.atrPeriod)) atr = ((profile.atrPeriod - 1) * atr + value) / profile.atrPeriod;
  const width = rows => Math.max(...rows.map(bar => bar.high)) - Math.min(...rows.map(bar => bar.low));
  const recent = width(contiguous.slice(-profile.compressionBars));
  const prior = width(contiguous.slice(-2 * profile.compressionBars, -profile.compressionBars));
  const lineAt = (line, at) => line?.anchorPrice + line?.slope * (at / lineCoordinateMs - line?.anchorTime);
  const priorGap = Math.abs(lineAt(plan.fourHourLine, tx - lineCoordinateMs) - lineAt(plan.oneHourLine, tx - lineCoordinateMs));
  const crossGap = Math.abs(lineAt(plan.fourHourLine, tx) - lineAt(plan.oneHourLine, tx));
  if (!positive(atr) || !positive(prior) || ![priorGap, crossGap].every(finite)
    || priorGap <= crossGap || crossGap > Math.max(1e-7, px * 1e-8)) return null;
  return { eventId: plan.id, symbol: plan.symbol, tx, px, atr, compressionRatio: recent / prior,
    dataCutoff: last, observedAt, profileRevision: profile.revision,
    structureDigest: digestP1({ tx, px, anchors: plan.anchors }),
    source: barIntervalMs === 900000 ? 'PRE_CROSS_CLOSED_15M_AND_ORIGINAL_STRUCTURE'
      : 'PRE_CROSS_CLOSED_ENTRY_INTERVAL_AND_ORIGINAL_STRUCTURE' };
}

export function iq1Anchor(context, trade, previousTrade, epoch, profile) {
  const mapped = context ? { ...context, profileRevision: P1_REVISION } : context;
  const anchor = anchorP1(mapped, trade, previousTrade, epoch, p1(profile));
  return anchor ? { ...anchor, context } : null;
}

export function buildIq1Correlation(bundles, symbols, profile, marketNow, receivedAt) {
  return correlationP1(bundles, symbols, p1(profile), marketNow, receivedAt);
}

export function evaluateIq1Portfolio(input) {
  if (simpleAdmission(input.profile)) {
    validateSimpleAdmission(input.profile);
    return out('PASS', 'PX_P5_CORRELATION_NOT_AN_ENTRY_GATE', { policyRevision: input.profile.entryAdmissionRevision });
  }
  const result = portfolioP1({ ...input, profile: p1(input.profile) });
  return { ...result, revision: IQ1_REVISION };
}

export function evaluateIq1Shape({ plan, signal, quote, anchor, context: directContext, profile: p,
  now, localNow, slippageRate = 0 }) {
  if (!positive(now) || !positive(localNow)) return out('UNKNOWN', 'IQ1_CLOCK_UNKNOWN');
  if (plan.iq1Invalidation) return out(plan.iq1Invalidation.status, plan.iq1Invalidation.reason);
  const simplified = simpleAdmission(p);
  if (simplified) {
    validateSimpleAdmission(p);
    if (!causalPxPlan(plan, now)) return out('UNKNOWN', 'PX_CAUSAL_STRUCTURE_MISSING');
  }
  const telemetry = directContext ?? anchor?.context;
  const c = simplified ? { ...telemetry, px: plan.intersectionPrice, tx: plan.intersectionTime } : telemetry;
  if (!simplified && (!c || c.eventId !== plan.id || c.profileRevision !== IQ1_REVISION || !positive(c.atr)))
    return out('UNKNOWN', 'IQ1_PRE_CROSS_CONTEXT_MISSING');
  if (simplified && (![signal?.bar?.openTime, signal?.bar?.closeTime, signal?.bar?.close].every(finite)
    || signal.bar.close <= 0 || signal.bar.openTime >= signal.bar.closeTime
    || signal.bar.closeTime < plan.intersectionTime || signal.bar.closeTime > now))
    return out('UNKNOWN', 'PX_DIRECTION_CLOSE_MISSING');
  const s = signal.direction, q = s === 1 ? quote?.ask : quote?.bid;
  if (![1, -1].includes(s) || !positive(q) || !positive(quote?.bid) || !positive(quote?.ask)
    || quote.ask < quote.bid || !finite(quote.marketTime) || !finite(quote.receivedAt)
    || quote.marketTime > now || quote.receivedAt > localNow
    || now - quote.marketTime > p.maximumQuoteAgeMs || localNow - quote.receivedAt > p.maximumQuoteAgeMs
    || quote.coverageComplete !== true) return out('UNKNOWN', 'IQ1_QUOTE_UNKNOWN');
  const modeledEntry = q * (1 + s * slippageRate);
  if (!finite(slippageRate) || slippageRate < 0 || !positive(modeledEntry))
    return out('UNKNOWN', 'IQ1_EXECUTION_PRICE_UNKNOWN');
  const m = { px: c.px, atr: c.atr, modeledEntry,
    pxBps: (simplified ? Math.abs(q / c.px - 1) : Math.max(Math.abs(q / c.px - 1), Math.abs(modeledEntry / c.px - 1))) * 10000,
    modeledPxBps: Math.abs(modeledEntry / c.px - 1) * 10000,
    pxAtr: positive(c.atr) ? Math.max(Math.abs(q - c.px), Math.abs(modeledEntry - c.px)) / c.atr : null,
    compressionRatio: c.compressionRatio, waitingAgeMs: now - c.tx,
    route: signal.route ?? null, opportunityId: signal.opportunityId ?? null };
  // Px distance authority is the executable quote on the intended side. ATR
  // distance remains audit telemetry and cannot veto a quote inside the authorized band.
  const pxBandFraction = p.maximumPxBps / 10000;
  if (simplified ? (s === 1 ? q > c.px * (1 + pxBandFraction) : q < c.px * (1 - pxBandFraction)) : m.pxBps > p.maximumPxBps)
    return out('WAIT', 'IQ1_PX_SAME_SIDE_BAND_WAIT', m);
  // The closed bar confirms direction. The current executable BBO only needs
  // to enter the current same-side Px band; no second close is required.
  if (s * (signal.bar.close - c.px) <= 0)
    return out('REJECT', 'IQ1_CONFIRMING_CLOSE_WRONG_PX_SIDE', m);
  if (s * (q - c.px) <= 0)
    return out('WAIT', 'IQ1_PX_SAME_SIDE_WAIT', m);
  return out('PASS', simplified ? 'PX_P5_SAME_SIDE_LIVE_BAND_PASSED' : 'IQ1_P4_PX_RIGHT_SIDE_LIVE_BAND_PASSED', m);
}
