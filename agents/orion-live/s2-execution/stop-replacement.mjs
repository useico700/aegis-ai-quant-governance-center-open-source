import { units } from '../../../lib/s1-precision.mjs';
import { clientId, closeSide, hash, invariant } from './common.mjs';

// Binance has no conditional-order amend API. A quantity STOP_MARKET is a
// temporary bridge, not a new entry: preserve the old close-all stop until the
// bridge is accepted and a fresh ownership gate proves exact quantity coverage.
// A rejected/unknown bridge never permits cancellation of the original stop.
export const STOP_REPLACEMENT_SCHEMA = 'S2_PROTECTED_STOP_REPLACEMENT_V1';
const DONE = new Set(['COMPLETE', 'BRIDGE_REJECTED_OLD_RETAINED', 'FLAT']);
export const replacementActive = state => state?.schema === STOP_REPLACEMENT_SCHEMA && !DONE.has(state.phase);

export function replacementFor(kernel, plan) {
  const pending = [...kernel.stopReplacements.values()].filter(s => s.planId === plan.id && replacementActive(s));
  invariant(pending.length <= 1, 'MULTIPLE_STOP_REPLACEMENTS_FOR_PLAN');
  return pending[0] ?? null;
}

export function bridgeMatches(kernel, row, plan, quantity) {
  try {
    const state = [...kernel.stopReplacements.values()].find(s => s.planId === plan.id && s.bridgeClientId === row?.clientAlgoId);
    const intent = state && kernel.intents.get(state.bridgeClientId);
    return !!(state && intent?.kind === 'stop' && intent.planId === plan.id && row.algoStatus === 'NEW'
      && row.symbol === plan.symbol && row.positionSide === plan.direction && row.side === closeSide(plan.direction)
      && (row.orderType ?? row.type) === 'STOP_MARKET' && String(row.closePosition) === 'false'
      && row.workingType === 'CONTRACT_PRICE' && String(row.priceProtect) === 'false'
      && units(row.triggerPrice) === units(state.newPrice) && units(row.quantity) === units(state.quantity)
      && units(intent.params.quantity) === units(state.quantity) && units(quantity) === units(state.quantity) && units(quantity) > 0n);
  } catch { return false; }
}

// Ownership identification during an emergency exit is not proof of protective
// coverage. Partial exits can leave the old bridge larger than current exposure;
// only CLOSING recovery may recognize it, never the old-stop cancellation gate.
export function closingBridgeMatches(kernel, row, plan, quantity) {
  try {
    const state = replacementFor(kernel, plan);
    return row?.clientAlgoId === state?.bridgeClientId
      && ((state?.phase === 'CLOSING' && units(quantity) > 0n && units(quantity) <= units(state.quantity))
        || (state?.phase === 'FLAT_RECONCILING' && units(quantity) === 0n))
      && bridgeMatches(kernel, row, plan, state.quantity);
  } catch { return false; }
}

async function save(kernel, state, change) {
  const next = { ...state, ...change, updatedAt: kernel.now() };
  await kernel.record({ type: 'STOP_REPLACEMENT_STATE', state: next });
  return next;
}

function pending(state, reason, next = null) {
  return { status: next ? 'NEW_STOP_VERIFIED_BRIDGE_CANCEL_UNRESOLVED' : 'STOP_REPLACEMENT_PENDING',
    replacementId: state.id, phase: state.phase, reason, ...(next ? { next } : {}), newEntriesBlocked: true };
}

function originalCancelMayHaveDispatched(kernel, state) {
  const intent = kernel.intents.get(clientId('cancel', state.cancelOldIdentity));
  if (!intent) return false;
  return intent.result !== null || kernel.dispatchStarted.has(intent.id)
    || !['MARKER_V1', 'MARKER_V2_NETWORK'].includes(intent.dispatchProtocol);
}

function originalReadPendingBeforeCancel(kernel, state, row) {
  return row?.unresolved === true && !originalCancelMayHaveDispatched(kernel, state);
}

async function flatten(kernel, plan, state, reason) {
  if (state.phase !== 'CLOSING') state = await save(kernel, state, { phase: 'CLOSING', failureReason: reason });
  const close = await kernel.emergencyClose(plan, `stop_replacement:${state.id}`);
  if (close.status === 'FLAT_VERIFIED') await save(kernel, state, { phase: 'FLAT_RECONCILING' });
  return { status: 'STOP_REPLACEMENT_FAILED_CLOSE_REQUESTED', replacementId: state.id, reason, close, newEntriesBlocked: true };
}

// Caller holds the kernel's single-writer serial boundary throughout each pass.
export async function resumeReplacement(kernel, plan, suppliedState = replacementFor(kernel, plan)) {
  try { return await resumeReplacementPass(kernel, plan, suppliedState); }
  catch (error) {
    const active = replacementFor(kernel, plan);
    const bridgeChild = active && kernel.intents.get(active.bridgeClientId)?.result?.actualOrderId;
    if (!kernel.journal.failed && active?.phase === 'CLOSING' && error?.message === 'PROTECTIVE_CHILD_RECONCILIATION_REQUIRED'
      && /^\d+$/.test(String(bridgeChild ?? '')) && String(bridgeChild) !== '0')
      return pending(active, 'OWNED_BRIDGE_CHILD_RECONCILIATION_PENDING');
    if (kernel.journal.failed || !['OWNED_OPEN_QUANTITY_REQUIRED', 'SUBMISSION_OWNED_QUANTITY_MISMATCH',
      'BRIDGE_REQUIRES_CURRENT_ORIGINAL_STOP', 'REPLACEMENT_STOP_NOT_CURRENTLY_VERIFIED',
      'OWNED_PROTECTIVE_BRIDGE_CONTRACT_REQUIRED', 'PROTECTIVE_CHILD_RECONCILIATION_REQUIRED'].includes(error?.message)) throw error;
    let position;
    try { position = await kernel.position(plan); } catch { throw error; }
    if (units(position.quantity) !== 0n) throw error;
    // A triggered owned stop can win this race. Fresh flatness permits only a
    // reconciliation pause, never an ownership assumption or another mutation.
    const state = replacementFor(kernel, plan);
    if (!state) throw error;
    await save(kernel, state, { phase: 'FLAT_RECONCILING', flatGateReason: error.message });
    return { status: 'STOP_REPLACEMENT_FLAT_RECONCILIATION_PENDING', replacementId: state.id, newEntriesBlocked: true };
  }
}

async function resumeReplacementPass(kernel, plan, suppliedState) {
  let state = suppliedState;
  if (!state) return { status: 'NO_PENDING_STOP_REPLACEMENT' };
  invariant(state.schema === STOP_REPLACEMENT_SCHEMA && state.planId === plan.id, 'STOP_REPLACEMENT_STATE_INVALID');
  if (state.phase === 'COMPLETE') return { status: 'PROTECTION_REPLACED', next: kernel.intents.get(state.nextClientId)?.result, replacementId: state.id };
  if (state.phase === 'BRIDGE_REJECTED_OLD_RETAINED') return { status: 'OLD_STOP_RETAINED', reason: 'PROTECTIVE_BRIDGE_REJECTED', replacementId: state.id, next: kernel.intents.get(state.bridgeClientId)?.result };
  if (state.phase === 'FLAT') return { status: 'STOP_REPLACEMENT_FLAT', replacementId: state.id };
  if (state.phase === 'CLOSING') return flatten(kernel, plan, state, state.failureReason);

  const current = await kernel.position(plan);
  if (units(current.quantity) === 0n) {
    await save(kernel, state, { phase: 'FLAT_RECONCILING' });
    return { status: 'STOP_REPLACEMENT_FLAT_RECONCILIATION_PENDING', replacementId: state.id, newEntriesBlocked: true };
  }
  // Partial fills or external position changes are not guessed away. The old
  // stop is retained until cancellation; afterwards any mismatch only reduces.
  if (units(current.quantity) !== units(state.quantity)) {
    if (['STARTED', 'BRIDGE_VERIFIED'].includes(state.phase)) {
      // A crash may leave BRIDGE_VERIFIED after the old DELETE already reached
      // Binance. Only a fresh NEW observation proves the original still backs us.
      const old = await kernel.observe(state.oldClientId);
      if (kernel.validStop(old, plan, state.oldPrice)) return pending(state, 'BRIDGE_QUANTITY_RECONCILIATION_REQUIRED');
      if (originalReadPendingBeforeCancel(kernel, state, old)) return pending(state, 'ORIGINAL_STOP_READ_PENDING_BEFORE_CANCEL');
    }
    return flatten(kernel, plan, state, 'BRIDGE_QUANTITY_CHANGED_AFTER_CANCEL');
  }

  if (state.phase === 'STARTED') {
    const bridge = await kernel.once('stop', state.bridgeIdentity, 'POST', '/fapi/v1/algoOrder', {
      symbol: plan.symbol, side: closeSide(plan.direction), positionSide: plan.direction,
      algoType: 'CONDITIONAL', type: 'STOP_MARKET', triggerPrice: state.newPrice,
      closePosition: 'false', quantity: state.quantity, workingType: 'CONTRACT_PRICE',
      priceProtect: 'false', clientAlgoId: state.bridgeClientId,
    }, plan.id);
    if (['REJECTED', 'ABSENT_VERIFIED'].includes(bridge.algoStatus)) {
      state = await save(kernel, state, { phase: 'BRIDGE_REJECTED_OLD_RETAINED', exchangeCode: bridge.exchangeCode ?? null });
      return { status: 'OLD_STOP_RETAINED', reason: 'PROTECTIVE_BRIDGE_REJECTED', next: bridge, replacementId: state.id };
    }
    if (!bridgeMatches(kernel, bridge, plan, current.quantity)) {
      const old = await kernel.observe(state.oldClientId);
      if (kernel.validStop(old, plan, state.oldPrice)) return pending(state, 'BRIDGE_NOT_VERIFIED');
      // A denied/failed read is not evidence that the pre-existing stop is gone.
      // Before our DELETE crossed its durable dispatch boundary, retain the old
      // order and wait for reads; do not convert shared-budget pressure to a sell.
      if (originalReadPendingBeforeCancel(kernel, state, old)) return pending(state, 'ORIGINAL_STOP_READ_PENDING_BEFORE_CANCEL');
      return flatten(kernel, plan, state, 'NO_VERIFIED_STOP_WHILE_BRIDGE_UNKNOWN');
    }
    state = await save(kernel, state, { phase: 'BRIDGE_VERIFIED' });
  }

  if (state.phase === 'BRIDGE_VERIFIED') {
    // Re-read a previously accepted bridge after crash or between passes. The
    // cancellation's submission gate independently checks the full fresh book.
    const bridge = await kernel.observe(state.bridgeClientId);
    if (!bridgeMatches(kernel, bridge, plan, current.quantity)) {
      const old = await kernel.observe(state.oldClientId);
      if (kernel.validStop(old, plan, state.oldPrice)) return pending(state, 'BRIDGE_NO_LONGER_VERIFIED');
      if (originalReadPendingBeforeCancel(kernel, state, old)) return pending(state, 'ORIGINAL_STOP_READ_PENDING_BEFORE_CANCEL');
      return flatten(kernel, plan, state, 'NO_VERIFIED_STOP_BEFORE_ORIGINAL_CANCEL');
    }
    await kernel.once('cancel', state.cancelOldIdentity, 'DELETE', '/fapi/v1/algoOrder',
      { symbol: plan.symbol, clientAlgoId: state.oldClientId }, plan.id);
    const old = await kernel.observe(state.oldClientId);
    if (old.algoStatus !== 'CANCELED') return pending(state, 'OLD_STOP_CANCELLATION_NOT_CONFIRMED');
    state = await save(kernel, state, { phase: 'OLD_CANCELED' });
  }

  if (state.phase === 'OLD_CANCELED') {
    const next = await kernel.installStop(plan, state.newPrice, state.nextRevision);
    if (['REJECTED', 'ABSENT_VERIFIED'].includes(next.algoStatus)) return flatten(kernel, plan, state, 'NEW_CLOSE_ALL_STOP_REJECTED');
    if (!kernel.validStop(next, plan, state.newPrice)) {
      const bridge = await kernel.observe(state.bridgeClientId);
      if (bridgeMatches(kernel, bridge, plan, current.quantity)) return pending(state, 'NEW_CLOSE_ALL_STOP_NOT_VERIFIED');
      return flatten(kernel, plan, state, 'NO_VERIFIED_STOP_AFTER_ORIGINAL_CANCEL');
    }
    state = await save(kernel, state, { phase: 'NEW_VERIFIED' });
  }

  const next = await kernel.observe(state.nextClientId);
  if (!kernel.validStop(next, plan, state.newPrice)) {
    const bridge = await kernel.observe(state.bridgeClientId);
    if (bridgeMatches(kernel, bridge, plan, current.quantity)) return pending(state, 'NEW_CLOSE_ALL_STOP_NO_LONGER_VERIFIED');
    return flatten(kernel, plan, state, 'NO_VERIFIED_STOP_BEFORE_BRIDGE_CANCEL');
  }
  // No ordinary reductions occur while replacementActive remains true. This
  // keeps the bridge's exact quantity valid until the close-all stop takes over.
  await kernel.once('cancel', state.cancelBridgeIdentity, 'DELETE', '/fapi/v1/algoOrder',
    { symbol: plan.symbol, clientAlgoId: state.bridgeClientId }, plan.id);
  const bridge = await kernel.observe(state.bridgeClientId);
  if (!['CANCELED', 'EXPIRED', 'FINISHED'].includes(bridge.algoStatus)) return pending(state, 'BRIDGE_CANCELLATION_NOT_CONFIRMED', next);
  state = await save(kernel, state, { phase: 'COMPLETE' });
  return { status: 'PROTECTION_REPLACED', next, replacementId: state.id };
}

export async function startReplacement(kernel, plan, oldStop, newPrice, revision) {
  const active = replacementFor(kernel, plan);
  if (active) return resumeReplacement(kernel, plan, active);
  invariant(kernel.plans.has(plan.id), 'OWN_PLAN_REQUIRED');
  invariant(kernel.validStop(oldStop, plan, oldStop.triggerPrice)
    && kernel.intents.get(oldStop.clientAlgoId)?.planId === plan.id, 'OLD_PROTECTION_INVALID');
  invariant(plan.direction === 'LONG' ? units(newPrice) > units(oldStop.triggerPrice) : units(newPrice) < units(oldStop.triggerPrice), 'STOP_WIDENING_FORBIDDEN');
  const current = await kernel.position(plan);
  if (units(current.quantity) === 0n) return { status: 'STOP_REPLACEMENT_FLAT' };
  const id = hash({ planId: plan.id, old: oldStop.clientAlgoId, price: newPrice, quantity: current.quantity, revision });
  const prior = kernel.stopReplacements.get(id);
  if (prior) return resumeReplacement(kernel, plan, prior);
  const bridgeIdentity = `${plan.id}:bridge:${id}`, nextRevision = `replacement:${id}`;
  const state = { schema: STOP_REPLACEMENT_SCHEMA, id, planId: plan.id, phase: 'STARTED',
    oldClientId: oldStop.clientAlgoId, oldPrice: oldStop.triggerPrice, newPrice, quantity: current.quantity,
    bridgeIdentity, bridgeClientId: clientId('stop', bridgeIdentity), nextRevision,
    nextClientId: clientId('stop', `${plan.id}:${nextRevision}`),
    cancelOldIdentity: `${plan.id}:replace-old:${id}`, cancelBridgeIdentity: `${plan.id}:replace-bridge:${id}`,
    createdAt: kernel.now() };
  await save(kernel, state, {});
  return resumeReplacement(kernel, plan, state);
}
