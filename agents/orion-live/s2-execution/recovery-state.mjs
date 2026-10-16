import { hash, clientId, closeSide } from './common.mjs';
import { units } from '../../../lib/s1-precision.mjs';

const profitAbsenceKey = 'profitDispatchAbsenceRecovery:20260923';
function profitAbsenceReceipt(book, planId, intentId) {
  const receipt = book.control.get(profitAbsenceKey);
  try {
    return receipt?.schema === 'PROFIT_DISPATCH_ABSENCE_RECOVERY_V1' && receipt.phase === 'commit'
      && receipt.planId === planId && /^[a-f0-9]{64}$/.test(receipt.replacementId ?? '')
      && Array.isArray(receipt.absentIds) && receipt.absentIds.length === 2
      && new Set(receipt.absentIds).size === 2 && receipt.absentIds.includes(intentId)
      && /^s2_close_[a-f0-9]{26}$/.test(intentId ?? '')
      && receipt.absentIds.filter(id => /^s2_stop_[a-f0-9]{26}$/.test(id)).length === 1
      && receipt.ordersSubmitted === 0 && receipt.directQueriesPerId === 2 && receipt.directQueryCode === -2013
      && receipt.tradesAfterIntent === 0 && receipt.legacyMarkersPreserved === true
      && Number.isSafeInteger(receipt.historyCount) && receipt.historyCount > 0 && receipt.historyCount < 1000
      && Number.isSafeInteger(receipt.at) && Number.isSafeInteger(receipt.reviewedThrough)
      && receipt.reviewedThrough > 0 && receipt.at >= receipt.reviewedThrough
      && receipt.oldStop?.status === 'NEW' && /^s2_stop_[a-f0-9]{26}$/.test(receipt.oldStop.id ?? '')
      && units(receipt.oldStop.trigger) > 0n && units(receipt.currentQuantity) > 0n ? receipt : null;
  } catch { return null; }
}

// One committed incident proof may settle its exact legacy emergency identity
// without inventing a venue orderId or a zero-quantity trade. A bare ABSENT label
// is never evidence of an order's absence or permission to alter owned quantity.
export function verifiedAbsentClose({ kernel, book, plan, intent, order = intent?.result }) {
  try {
    const receipt = profitAbsenceReceipt(book, plan.id, intent?.id);
    const state = receipt && kernel.stopReplacements.get(receipt.replacementId);
    return !!(receipt && intent?.kind === 'close' && intent.planId === plan.id
      && kernel.intents.get(intent.id) === intent && intent.method === 'POST' && intent.path === '/fapi/v1/order'
      && intent.purpose === 'PROTECTIVE_EMERGENCY' && intent.dispatchProtocol === 'MARKER_V1'
      && kernel.dispatchStarted.has(intent.id)
      && intent.id === clientId('close', `${plan.id}:stop_replacement:${receipt.replacementId}`)
      && intent.params.newClientOrderId === intent.id && intent.params.symbol === plan.symbol
      && intent.params.positionSide === plan.direction && intent.params.side === closeSide(plan.direction)
      && intent.params.type === 'MARKET' && units(intent.params.quantity) > 0n
      && units(intent.params.quantity) === units(receipt.currentQuantity)
      && Number.isSafeInteger(intent.at) && intent.at > 0 && receipt.reviewedThrough > intent.at + 10000
      && order && !order.unresolved && order.status === 'ABSENT_VERIFIED' && order.orderId === undefined
      && order.clientOrderId === intent.id && order.symbol === plan.symbol
      && order.positionSide === plan.direction && order.side === closeSide(plan.direction) && order.type === 'MARKET'
      && units(order.executedQty) === 0n && units(order.origQty) === units(intent.params.quantity)
      && hash(order) === hash(intent.result)
      && state?.planId === plan.id && state.phase === 'BRIDGE_REJECTED_OLD_RETAINED'
      && state.recoveryReason === 'DOUBLE_QUERY_HISTORY_ABSENCE_ORIGINAL_NEW' && state.ordersSubmitted === 0
      && receipt.absentIds.includes(state.bridgeClientId) && receipt.oldStop.id === state.oldClientId
      && units(receipt.oldStop.trigger) === units(state.oldPrice));
  } catch { return false; }
}

export function absentCloseRecovered(book, planId) {
  const recovery = book.control.get(`positionRecovery:${planId}`), quarantine = book.control.get(`positionQuarantine:${planId}`);
  const receipt = recovery && profitAbsenceReceipt(book, planId, recovery.intentId), position = book.positions.get(planId);
  return !!(receipt && recovery.status === 'COMMITTED_ABSENT_CLOSE_RECOVERY' && recovery.planId === planId
    && quarantine?.phase === 'RECONCILIATION' && quarantine.reason === 'ORDER_UNRESOLVED'
    && recovery.quarantineDigest === hash(quarantine) && recovery.absenceReceiptDigest === hash(receipt)
    && Number.isSafeInteger(recovery.recoveredAt) && recovery.recoveredAt >= receipt.at
    && recovery.recoveredAt >= quarantine.at
    && position?.id === planId && ['OPEN', 'CLOSED'].includes(position.status) && position.strategyManagementSuspended !== true);
}

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
    && /^\d+$/.test(recovery.entryOrderId ?? '') && /^s2_stop_[a-f0-9]{26}$/.test(recovery.stopClientId ?? '')
    // Position views legitimately evolve after recovery (evidence-gap marking,
    // trailing stops, partial exits and final closure). The quarantine generation
    // is the revocation boundary; any later incident must write a new generation.
    && position?.id === planId && ['OPEN', 'CLOSED'].includes(position.status)
    && position.strategyManagementSuspended !== true);
}
export function absentPreDispatchEntryRecovered(book, planId) {
  const recovery = book.control.get(`positionRecovery:${planId}`);
  const quarantine = book.control.get(`positionQuarantine:${planId}`);
  const absence = book.control.get(`entryRecovery:${recovery?.intentId}`);
  return !!(recovery?.status === 'COMMITTED_ABSENT_PRE_DISPATCH'
    && recovery.planId === planId && recovery.quarantineDigest === hash(quarantine)
    && quarantine?.reason === 'ORDER_UNRESOLVED'
    && /^s2_entry_[a-f0-9]{26}$/.test(recovery.intentId ?? '')
    && absence?.schema === 'PRE_DISPATCH_ABSENCE_V1' && absence.planId === planId
    && absence.dispatchStarted === false && absence.venueOrderFound === false
    && absence.accountTrades === 0 && !book.positions.has(planId));
}
export function activePositionQuarantine(book, planId) {
  return book.control.has(`positionQuarantine:${planId}`)
    && !protectionOnlyRecovered(book, planId) && !ownedEntryRecovered(book, planId)
    && !absentPreDispatchEntryRecovered(book, planId) && !absentCloseRecovered(book, planId);
}
