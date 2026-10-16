import { hash } from './common.mjs';

// An append-only recovery record resolves exactly one quarantine generation.
// New incidents invalidate it without deleting the prior incident or decision.
export function protectionOnlyRecovered(book, planId) {
  const recovery = book.control.get(`positionRecovery:${planId}`), quarantine = book.control.get(`positionQuarantine:${planId}`), position = book.positions.get(planId);
  return !!(recovery?.status === 'COMMITTED_PROTECTION_ONLY' && quarantine && recovery.quarantineDigest === hash(quarantine)
    && position?.externalRecoveryId === recovery.recoveryId && position.strategyManagementSuspended === true);
}
export function ownedEntryRecovered(book, planId) {
  const recovery = book.control.get(`positionRecovery:${planId}`), quarantine = book.control.get(`positionQuarantine:${planId}`), position = book.positions.get(planId);
  return !!(recovery?.status === 'COMMITTED_OWNED_ENTRY_RECOVERY' && quarantine
    && recovery.quarantineDigest === hash(quarantine) && recovery.planId === planId
    && /^\d+$/.test(recovery.entryOrderId ?? '') && /^s1_stop_[a-f0-9]{26}$/.test(recovery.stopClientId ?? '')
    // Position views legitimately evolve after recovery (evidence-gap marking,
    // trailing stops, partial exits and final closure). The quarantine generation
    // is the revocation boundary; any later incident must write a new generation.
    && position?.id === planId && ['OPEN', 'CLOSED'].includes(position.status)
    && position.strategyManagementSuspended !== true);
}
export function activePositionQuarantine(book, planId) {
  return book.control.has(`positionQuarantine:${planId}`) && !protectionOnlyRecovered(book, planId) && !ownedEntryRecovered(book, planId);
}
