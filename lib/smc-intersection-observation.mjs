import { sanitizeIntersectionClock } from './smc-intersection-clock.mjs';
const note = (status, reason = null) => ({ revision: 'SMC-INTERSECTION-MARKER-1', admissionEffect: 'NONE', status, reason, orderAuthority: false });
export function projectIntersectionObservation(value, now) {
  try {
    const intersectionClock = sanitizeIntersectionClock(value, now);
    return { intersectionClock, intersectionObservation: note(intersectionClock ? 'READY' : 'UNAVAILABLE') };
  } catch {
    return { intersectionClock: null, intersectionObservation: note('UNAVAILABLE', 'MARKER_DATA_UNAVAILABLE') };
  }
}
// Source/read/persistence failures remove the marker, never the symbol's plan.
export async function observeIntersectionSafely(work) {
  try { return { clock: await work(), observation: note('READY') }; }
  catch (error) { return { clock: null, observation: note('UNAVAILABLE', /^[A-Z0-9_]{1,100}$/.test(error?.message) ? error.message : 'MARKER_DATA_UNAVAILABLE') }; }
}
