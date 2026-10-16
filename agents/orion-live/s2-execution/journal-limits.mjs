import { S2_Z_STRUCTURE_REVISION } from '../../shared/s2-z-structure.mjs';

export const STANDARD_JOURNAL_EVENT_MAX_BYTES = 60000;
export const S2_Z_PLAN_RESERVED_MAX_BYTES = 9 * 1024 ** 2;

// Only the initial immutable S2 Z reservation carries the native source proof.
// Orders, observations, controls and position views keep their existing limit.
// This is a storage boundary, never a substitute for prepareEntry validation.
export function journalEventMaximumBytes(event) {
  return event?.type === 'PLAN_RESERVED'
    && event.plan?.schema === 'S2_VALIDATED_ENTRY_V1'
    && event.plan.structureRevision === S2_Z_STRUCTURE_REVISION
    && event.plan.zStructure?.revision === S2_Z_STRUCTURE_REVISION
    ? S2_Z_PLAN_RESERVED_MAX_BYTES : STANDARD_JOURNAL_EVENT_MAX_BYTES;
}

export function journalGrowthReservationBytes(payloadBytes) {
  // Allow a full additional WAL and database representation plus SQLite pages.
  return Math.max(262144, payloadBytes * 2 + 262144);
}

export function prospectiveReservationSize(plan, at) {
  // Use the widest supported generation so retries cannot outgrow preflight.
  const event = { type: 'PLAN_RESERVED', at, plan, reservationGeneration: Number.MAX_SAFE_INTEGER };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  return { bytes, maximumBytes: journalEventMaximumBytes(event), allowed: bytes <= journalEventMaximumBytes(event) };
}
