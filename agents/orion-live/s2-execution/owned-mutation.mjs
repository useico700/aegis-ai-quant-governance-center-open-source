import { units, decimal } from '../../../lib/s1-precision.mjs';
import { clientId, closeSide, entrySide, invariant, terminal } from './common.mjs';
import { validateMutation } from './transport.mjs';
import { activePositionQuarantine, verifiedAbsentClose } from './recovery-state.mjs';

export function isOwnedEntryCancellation(request, kernel) {
  const plan = kernel.plans.get(request.planId), intent = plan && kernel.intents.get(clientId('entry', plan.id));
  return !!(plan && intent?.kind === 'entry' && intent.method === 'POST' && intent.planId === plan.id
    && intent.path === '/fapi/v1/order' && intent.params.symbol === plan.symbol && intent.params.positionSide === plan.direction
    && intent.params.side === entrySide(plan.direction)
    && request.kind === 'cancel' && request.method === 'DELETE' && request.path === '/fapi/v1/order'
    && request.params?.symbol === plan.symbol && request.params.origClientOrderId === intent.params.newClientOrderId);
}

// Cumulative, venue-observed quantities may be newer than the fee ledger (e.g.
// immediate entry protection). They are not a fill, PnL or fee projection.
function observedQuantity(intent, plan, side, context) {
  const row = intent?.result;
  if (context && side === closeSide(plan.direction) && verifiedAbsentClose({ ...context, plan, intent, order: row })) return 0n;
  invariant(row && !row.unresolved && row.symbol === plan.symbol && row.positionSide === plan.direction && row.side === side
    && row.clientOrderId === intent.params.newClientOrderId && row.orderId !== undefined, 'OWNED_ORDER_OBSERVATION_REQUIRED');
  const quantity = units(row.executedQty);
  invariant(units(row.origQty) === units(intent.params.quantity) && quantity <= units(row.origQty), 'OWNED_ORDER_QUANTITY_MISMATCH');
  return quantity;
}

function isExactInitialProtection(request, { kernel, book, account, plan }) {
  if (request.kind !== 'stop' || request.method !== 'POST' || request.path !== '/fapi/v1/algoOrder'
    || request.intentId !== clientId('stop', `${plan.id}:initial`)
    || request.params?.clientAlgoId !== request.intentId
    || request.params.triggerPrice !== plan.stopPrice
    || request.params.positionSide !== plan.direction || request.params.side !== closeSide(plan.direction)
    || request.params.type !== 'STOP_MARKET' || request.params.closePosition !== 'true'
    || request.params.workingType !== 'CONTRACT_PRICE' || request.params.priceProtect !== 'false'
    || book.positions.has(plan.id)) return false;
  const entry = kernel.intents.get(clientId('entry', plan.id));
  if (!entry || !terminal(entry.result?.status)) return false;
  let filled;
  try { filled = observedQuantity(entry, plan, entrySide(plan.direction)); } catch { return false; }
  if (filled <= 0n) return false;
  const symbolPositions = account.positions.filter(row => row.symbol === plan.symbol
    && units(String(row.positionAmt ?? '0').replace(/^-/, '')) > 0n);
  if (symbolPositions.length !== 1) return false;
  const amount = String(symbolPositions[0].positionAmt), quantity = units(amount.replace(/^-/, ''));
  if (symbolPositions[0].positionSide !== plan.direction || quantity !== filled
    || (plan.direction === 'SHORT' ? !amount.startsWith('-') : amount.startsWith('-'))) return false;
  // During the immediate fill-to-stop handoff the owned entry event can advance
  // the user stream between account fanout reads. Permit only the exact initial
  // full-position stop when the venue leg exactly equals the durable fill and no
  // other same-symbol order or conditional order exists.
  return !account.orders.some(row => row.symbol === plan.symbol)
    && !account.algos.some(row => row.symbol === plan.symbol);
}

// A confirmed owned fill must be protected even when the shared REST reader is
// temporarily out of background capacity. This narrow gate authorizes only the
// kernel-generated first close-position stop. It cannot open exposure, resize a
// leg, replace a stop, close a position, or act on an unobserved entry.
export function validateImmediateInitialProtection(request, { kernel, book }) {
  const plan = kernel.plans.get(request.planId);
  if (!plan || request.kind !== 'stop' || request.method !== 'POST' || request.path !== '/fapi/v1/algoOrder'
    || request.intentId !== clientId('stop', `${plan.id}:initial`)
    || request.params?.clientAlgoId !== request.intentId
    || request.params.symbol !== plan.symbol || request.params.triggerPrice !== plan.stopPrice
    || request.params.positionSide !== plan.direction || request.params.side !== closeSide(plan.direction)
    || request.params.algoType !== 'CONDITIONAL' || request.params.type !== 'STOP_MARKET'
    || request.params.closePosition !== 'true' || request.params.workingType !== 'CONTRACT_PRICE'
    || request.params.priceProtect !== 'false' || book.positions.has(plan.id)
    || activePositionQuarantine(book, plan.id)) return null;
  validateMutation(request.method, request.path, request.params);
  if ([...book.positions.values()].some(p => p.symbol === plan.symbol && p.status === 'OPEN')) return null;
  const entry = kernel.intents.get(clientId('entry', plan.id));
  if (!entry || entry.kind !== 'entry' || entry.planId !== plan.id || entry.method !== 'POST'
    || entry.path !== '/fapi/v1/order' || entry.params.symbol !== plan.symbol
    || entry.params.positionSide !== plan.direction || entry.params.side !== entrySide(plan.direction)
    || entry.result?.unresolved) return null;
  let filled;
  try { filled = observedQuantity(entry, plan, entrySide(plan.direction)); } catch { return null; }
  if (filled <= 0n) return null;
  const evidence = book.control.get(`entryEvidence:${plan.id}`);
  if (!/^S[12]_PINNED_ENTRY_EVIDENCE_V1$/.test(evidence?.schema ?? '')
    || evidence.planId !== plan.id || evidence.symbol !== plan.symbol
    || !Array.isArray(evidence.receipts) || !evidence.receipts.length
    || evidence.receipts.some(row => row?.verified !== true || row?.pinned !== true)) return null;
  const stops = [...kernel.intents.values()].filter(intent => intent.planId === plan.id && intent.kind === 'stop');
  if (stops.some(intent => intent.id !== request.intentId)
    || stops.some(intent => intent.id === request.intentId && intent.result !== null)) return null;
  return { status: 'OWNED_INITIAL_PROTECTION_PRIORITY_VALIDATED', quantity: decimal(filled) };
}

export function validateOwnedMutation(request, { kernel, book, account }) {
  const plan = kernel.plans.get(request.planId);
  invariant(plan && ['LONG', 'SHORT'].includes(plan.direction), 'OWNED_MUTATION_PLAN_REQUIRED');
  validateMutation(request.method, request.path, request.params);
  invariant(request.params.symbol === plan.symbol, 'OWNED_MUTATION_SYMBOL_MISMATCH');
  invariant(account.positionsComplete === true && account.ordersComplete === true && account.algosComplete === true
    && [account.positions, account.orders, account.algos].every(Array.isArray), 'OWNED_MUTATION_SNAPSHOT_INCOMPLETE');
  const exactInitialProtection = isExactInitialProtection(request, { kernel, book, account, plan });
  invariant(account.userStreamSequenceStable === true || exactInitialProtection, 'ACCOUNT_CHANGED_DURING_SUBMISSION_READ');
  if (isOwnedEntryCancellation(request, kernel)) {
    // Cancel only the exact durable entry identity, even when its outcome or
    // position ownership is uncertain. No unrelated order or protection changes.
    return { status: 'OWNED_ENTRY_CANCELLATION_VALIDATED' };
  }
  invariant(['stop', 'close', 'cancel'].includes(request.kind), 'OWNED_MUTATION_KIND_INVALID');
  invariant(!activePositionQuarantine(book, plan.id), 'POSITION_QUARANTINED_REVIEW_REQUIRED');
  invariant(![...book.positions.values()].some(p => p.id !== plan.id && p.symbol === plan.symbol && p.status === 'OPEN'), 'AMBIGUOUS_SYMBOL_OWNERSHIP');
  const entry = kernel.intents.get(clientId('entry', plan.id));
  invariant(entry?.kind === 'entry' && entry.planId === plan.id, 'OWNED_ENTRY_INTENT_REQUIRED');
  let expected = observedQuantity(entry, plan, entrySide(plan.direction));
  invariant(expected <= units(plan.quantity), 'OWNED_ENTRY_EXCEEDS_PLAN');
  const own = [...kernel.intents.values()].filter(i => i.planId === plan.id && i.method === 'POST');
  const regularIds = new Map([[entry.params.newClientOrderId, entry]]), algoIds = new Set(), childOrderIds = new Set();
  for (const intent of own) {
    if (intent.kind === 'close') {
      regularIds.set(intent.params.newClientOrderId, intent);
      if (intent.id === request.intentId) continue; // This unsent intention only.
      expected -= observedQuantity(intent, plan, closeSide(plan.direction), { kernel, book });
      if (request.kind === 'close') invariant(terminal(intent.result.status), 'OWNED_CLOSE_STILL_PENDING');
    }
    if (intent.kind === 'stop') {
      algoIds.add(intent.params.clientAlgoId);
      const rawChild = intent.result?.actualOrderId;
      // Binance reports an empty actualOrderId while a conditional algo is
      // still NEW. That means no child order exists yet; treating the empty
      // field as an order id would falsely quarantine the position as soon as
      // profit management tries to reduce it.
      if (rawChild === undefined || rawChild === null || rawChild === '' || String(rawChild) === '0') continue;
      const child = String(rawChild);
      invariant(/^\d+$/.test(child), 'PROTECTIVE_CHILD_ORDER_ID_INVALID');
      invariant(!childOrderIds.has(child), 'DUPLICATE_PROTECTIVE_CHILD_ORDER'); childOrderIds.add(child);
      const accounted = book.control.get(`accounted:${plan.symbol}:${child}`);
      invariant(accounted?.terminal === true, 'PROTECTIVE_CHILD_RECONCILIATION_REQUIRED');
      const fills = [...book.fills.values()].filter(event => event.planId === plan.id && event.role === 'EXIT' && event.fill.symbol === plan.symbol && String(event.fill.orderId) === child);
      invariant(fills.reduce((sum, event) => sum + units(event.fill.quantity), 0n) === units(accounted.executedQty), 'PROTECTIVE_CHILD_FILL_QUANTITY_MISMATCH');
      expected -= units(accounted.executedQty);
    }
  }
  for (const event of book.externalExits?.values() ?? []) if (event.planId === plan.id) expected -= units(event.fill.quantity);
  invariant(expected >= 0n, 'OWNED_EXIT_EXCEEDS_ENTRY');
  const rows = account.positions.filter(row => row.symbol === plan.symbol && row.positionSide === plan.direction);
  invariant(rows.length <= 1, 'POSITION_SNAPSHOT_AMBIGUOUS');
  const amount = String(rows[0]?.positionAmt ?? '0'), quantity = units(amount.replace(/^-/, ''));
  invariant(quantity === 0n || (plan.direction === 'SHORT' ? amount.startsWith('-') : !amount.startsWith('-')), 'POSITION_SIGN_INVALID');
  invariant(quantity === expected, 'SUBMISSION_OWNED_QUANTITY_MISMATCH');
  const sameLeg = row => row.symbol === plan.symbol && (!row.positionSide || row.positionSide === plan.direction || row.positionSide === 'BOTH');
  invariant(account.orders.filter(sameLeg).every(row => regularIds.has(row.clientOrderId) || childOrderIds.has(String(row.orderId))), 'SUBMISSION_FOREIGN_ORDER_ON_LEG');
  for (const row of account.orders.filter(sameLeg)) {
    const intent = regularIds.get(row.clientOrderId);
    invariant(intent && row.symbol === plan.symbol && row.positionSide === plan.direction && row.side === intent.params.side
      && units(row.origQty) === units(intent.params.quantity), 'SUBMISSION_OPEN_ORDER_CONTRACT_MISMATCH');
  }
  invariant(account.algos.filter(sameLeg).every(row => algoIds.has(row.clientAlgoId)), 'SUBMISSION_FOREIGN_ALGO_ON_LEG');
  if (request.kind === 'cancel') {
    invariant(request.method === 'DELETE' && request.path === '/fapi/v1/algoOrder', 'OWNED_CANCEL_TARGET_INVALID');
    const target = own.find(i => i.kind === 'stop' && i.params.clientAlgoId === request.params.clientAlgoId);
    invariant(target, 'OWNED_STOP_CANCEL_TARGET_REQUIRED');
    if (quantity === 0n) {
      invariant(book.positions.get(plan.id)?.status === 'CLOSED'
        && !account.positions.some(row => row.symbol === plan.symbol && units(String(row.positionAmt).replace(/^-/, '')) > 0n), 'FLAT_STOP_CLEANUP_NOT_RECONCILED');
    } else {
      // The new stop must still exist now, match its durable contract, and be
      // no weaker than the canceled stop. Earlier NEW acceptance is insufficient.
      const replacements = own.filter(i => i.kind === 'stop' && i !== target && i.result?.algoStatus === 'NEW');
      const verifiedFullReplacement = replacements.some(i => account.algos.some(row => row.clientAlgoId === i.params.clientAlgoId
        && kernel.validStop(row, plan, i.params.triggerPrice)
        && (plan.direction === 'LONG' ? units(row.triggerPrice) >= units(target.params.triggerPrice) : units(row.triggerPrice) <= units(target.params.triggerPrice))));
      const replacement = kernel.activeStopReplacement?.(plan);
      const verifiedBridgeReplacement = replacement?.phase === 'BRIDGE_VERIFIED'
        && replacement.oldClientId === target.params.clientAlgoId
        && request.intentId === clientId('cancel', replacement.cancelOldIdentity)
        && account.algos.some(row => kernel.isReplacementBridge(row, plan, decimal(quantity))
          && (plan.direction === 'LONG' ? units(row.triggerPrice) > units(target.params.triggerPrice) : units(row.triggerPrice) < units(target.params.triggerPrice)));
      invariant(verifiedFullReplacement || verifiedBridgeReplacement, 'REPLACEMENT_STOP_NOT_CURRENTLY_VERIFIED');
    }
  } else {
    invariant(request.intentId === (request.kind === 'close' ? request.params.newClientOrderId : request.params.clientAlgoId), 'OWNED_MUTATION_INTENT_ID_MISMATCH');
    invariant(request.method === 'POST' && request.params.positionSide === plan.direction && request.params.side === closeSide(plan.direction), 'OWNED_MUTATION_SIDE_MISMATCH');
    invariant(quantity > 0n, 'OWNED_OPEN_QUANTITY_REQUIRED');
    if (request.kind === 'close') {
      if (request.purpose === 'PROTECTIVE_EMERGENCY') invariant(units(request.params.quantity) === quantity, 'PROTECTIVE_EMERGENCY_REQUIRES_EXACT_REMAINDER');
      if (book.positions.get(plan.id)?.strategyManagementSuspended) invariant(request.purpose === 'PROTECTIVE_EMERGENCY' && units(request.params.quantity) === quantity, 'RECOVERED_POSITION_MANAGEMENT_SUSPENDED');
      invariant(request.path === '/fapi/v1/order' && request.params.type === 'MARKET' && units(request.params.quantity) <= quantity, 'SUBMISSION_REDUCTION_EXCEEDS_OWNED_QUANTITY');
      invariant(terminal(entry.result.status), 'ENTRY_MUST_BE_TERMINAL_BEFORE_REDUCTION');
    } else {
      invariant(request.path === '/fapi/v1/algoOrder', 'OWNED_STOP_ENDPOINT_REQUIRED');
      if (request.params.closePosition === 'false') {
        const replacement = kernel.activeStopReplacement?.(plan);
        invariant(replacement?.phase === 'STARTED' && request.intentId === replacement.bridgeClientId
          && units(request.params.quantity) === quantity && units(request.params.quantity) === units(replacement.quantity)
          && units(request.params.triggerPrice) === units(replacement.newPrice), 'OWNED_PROTECTIVE_BRIDGE_CONTRACT_REQUIRED');
        invariant(account.algos.some(row => row.clientAlgoId === replacement.oldClientId
          && kernel.validStop(row, plan, replacement.oldPrice)), 'BRIDGE_REQUIRES_CURRENT_ORIGINAL_STOP');
      }
      const minimumStop = book.positions.get(plan.id)?.stop ?? plan.stopPrice;
      invariant(plan.direction === 'LONG' ? units(request.params.triggerPrice) >= units(minimumStop) : units(request.params.triggerPrice) <= units(minimumStop), 'SUBMISSION_STOP_WIDENING_FORBIDDEN');
    }
  }
  return { status: 'OWNED_MUTATION_VALIDATED', quantity: decimal(quantity) };
}
