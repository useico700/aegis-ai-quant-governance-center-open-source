export const BACKGROUND_READ_REASONS = Object.freeze(['LOCAL_WEIGHT', 'IP_HEADROOM', 'CONCURRENCY',
  'COOLING_DOWN', 'CLOCK_INVALID', 'STORE_UNAVAILABLE', 'HALT_REVIEW', 'STOPPED', 'INPUT_INVALID']);

// Carries the decision from the SAME advisory transaction into existing bounded
// fee outcome telemetry. No second check, request, reservation or error payload.
export function requireBackgroundEligibility(decision) {
  if (decision?.allowed === true && decision.reason === null) return true;
  const reason = decision?.allowed === false && BACKGROUND_READ_REASONS.includes(decision.reason)
    ? decision.reason : 'STORE_UNAVAILABLE';
  throw new Error(`PROBE_READ_${reason}`);
}
