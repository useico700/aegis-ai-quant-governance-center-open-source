const IMMUTABLE_REJECTIONS = new Set([
  'SIGNAL_SCOPE_INVALID', 'SIGNAL_INVALID', 'SIGNAL_NON_CAUSAL_OR_EXPIRED',
  'IQ1_NO_CONVERGENCE', 'IQ1_CONFIRMING_CLOSE_WRONG_PX_SIDE',
  'IQ1_PRE_ACTIVATION_EVENT', 'IQ1_STRUCTURE_CHANGED',
  'SMC_SIGNAL_SCOPE_INVALID', 'SMC_MANUAL_AUTHORIZATION_INVALID',
  'SMC_STOP_TARGET_INVALID',
]);

const CAPACITY_WAITS = new Set([
  'POSITION_OR_SIGNAL_ALREADY_USED', 'R21_DIRECTION_ENTRY_FROZEN',
  'RISK_BUDGET_UNAVAILABLE', 'TRIAL_GROSS_CAP_REACHED', 'TRIAL_POSITION_CAP_REACHED',
  'MARGIN_CAPACITY_MISSING', 'IQ1_CORRELATED_GROUP_CAPACITY',
  'IQ1_CORRELATED_OPPOSITE_EXPOSURE',
]);

export function classifyEntryAdmission(reason) {
  if (IMMUTABLE_REJECTIONS.has(reason)) return 'POLICY_REJECT';
  if (CAPACITY_WAITS.has(reason)) return 'CAPACITY_WAIT';
  // A runtime/data/price/cost failure is re-evaluated from fresh evidence on
  // every cycle. Unknown codes stay visible and fail closed without consuming
  // the candidate.
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(reason ?? '') ? 'RETRYABLE' : 'UNCLASSIFIED';
}

export function entryAdmissionRecord(signal, checked, evaluatedAt, reason = checked?.reason) {
  const resolvedReason = reason ?? 'ENTRY_GATE_REJECTED';
  const classification = classifyEntryAdmission(resolvedReason);
  return {
    id: signal.id, symbol: signal.symbol, direction: signal.direction ?? null,
    intersectionTime: signal.intersectionTime ?? null,
    intersectionPrice: signal.iq1Plan?.intersectionPrice ?? null,
    stage: 'EXECUTION_GATE', reason: resolvedReason, classification,
    terminal: classification === 'POLICY_REJECT', evaluatedAt,
  };
}
