// P5 changes admission only. Venue, account, protection and risk checks remain
// in the execution kernel. Importing this module never submits an order.
export const SIMPLE_ADMISSION_REVISION = 'S1-S2-PX-BAND-RISK-ONLY-P5-20260920';
export const S2_THREE_PERCENT_ADMISSION_REVISION = 'S2-PX-BAND-3PCT-P5-20260921';
export const simpleAdmission = value => [SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION]
  .includes(value?.entryAdmissionRevision);
export const simpleAdmissionMaximumPxBps = value => value?.entryAdmissionRevision === S2_THREE_PERCENT_ADMISSION_REVISION ? 300 : 200;

const finite = Number.isFinite;
export function causalPxPlan(plan, now) {
  if (!plan || ![plan.createdAt, plan.intersectionTime, plan.intersectionPrice, now].every(finite)
    || plan.intersectionPrice <= 0 || plan.createdAt > plan.intersectionTime
    || plan.intersectionTime > now || !Array.isArray(plan.anchors) || plan.anchors.length !== 4
    || plan.anchors.some(a => !finite(a.confirmedAt) || a.confirmedAt > plan.createdAt)) return false;
  // Both scanners use the common 15-minute mathematical coordinate, including S2.
  const values = [plan.fourHourLine, plan.oneHourLine].map(line => {
    if (![line?.anchorTime, line?.anchorPrice, line?.slope].every(finite)) return NaN;
    return line.anchorPrice + line.slope * (plan.intersectionTime / 900000 - line.anchorTime);
  });
  return values.every(p => finite(p) && Math.abs(p - plan.intersectionPrice) <= Math.max(1e-7, plan.intersectionPrice * 1e-8))
    && plan.fourHourLine.slope !== plan.oneHourLine.slope;
}

export function validateSimpleAdmission(profile) {
  if (!simpleAdmission(profile) || profile.maximumPxBps !== simpleAdmissionMaximumPxBps(profile)
    || !Number.isFinite(profile.maximumQuoteAgeMs) || profile.maximumQuoteAgeMs <= 0 || profile.maximumQuoteAgeMs > 5000
    || ['correlationExecutionGate', 'eventCalendarExecutionGate', 'campaignCooldownExecutionGate',
      'preCrossTelemetryRequired', 'secondBandCloseRequired'].some(k => profile[k] !== false))
    throw new Error('PX_SIMPLE_ADMISSION_PROFILE_INVALID');
  return profile;
}
