import { units, decimal } from '../../../lib/s1-precision.mjs';
import { hash, invariant, terminal, fresh, closeSide, clientId } from './common.mjs';
import { normalizeFill } from './position-ledger.mjs';

const HOLD = 'EXTERNAL_ACTIVITY_PROTECTION_ONLY_REVIEW_REQUIRED';
const withoutSequence = position => ({ ...position, sequence: undefined });
const ownDigest = (kernel, book, planId) => hash({ plan: kernel.plans.get(planId),
  intents: [...kernel.intents.values()].filter(i => i.planId === planId),
  fills: [...book.fills.values()].filter(f => f.planId === planId), income: [...book.income.values()] });
function committedReview(activity, fingerprint) {
  const report = activity.reports.get(fingerprint);
  invariant(report, 'RECOVERY_COMMITTED_ACTIVITY_REVIEW_REQUIRED');
  return activity.materialize(report);
}
function accountQuantity(account, plan, kernel, now) {
  invariant(account?.positionsComplete === true && account.ordersComplete === true && account.algosComplete === true
    && [account.positions, account.orders, account.algos].every(Array.isArray), 'RECOVERY_ACCOUNT_INCOMPLETE');
  invariant(account.dualSidePosition === true && account.multiAssetsMargin === false && account.userStreamConnected === true
    && account.userStreamSequenceStable === true, 'RECOVERY_ACCOUNT_BOUNDARY');
  invariant(fresh(account.observedAt, now, 5000), 'RECOVERY_ACCOUNT_STALE');
  const rows = account.positions.filter(p => p.symbol === plan.symbol);
  invariant(rows.every(p => ['LONG', 'SHORT'].includes(p.positionSide)) && new Set(rows.map(p => p.positionSide)).size === rows.length, 'RECOVERY_ACCOUNT_AMBIGUOUS');
  invariant(rows.every(p => p.positionSide === plan.direction || units(String(p.positionAmt).replace(/^-/, '')) === 0n), 'RECOVERY_OPPOSITE_POSITION_PRESENT');
  const amount = String(rows.find(p => p.positionSide === plan.direction)?.positionAmt ?? '0');
  const quantity = units(amount.replace(/^-/, ''));
  invariant(quantity === 0n || (plan.direction === 'SHORT') === amount.startsWith('-'), 'RECOVERY_POSITION_SIGN_INVALID');
  // A remaining regular order may alter quantity after review. Known protective
  // stops may remain, but their complete contract must match the durable intent.
  invariant(!account.orders.some(o => o.symbol === plan.symbol), 'RECOVERY_OPEN_REGULAR_ORDER');
  for (const algo of account.algos.filter(a => a.symbol === plan.symbol)) {
    const own = [...kernel.intents.values()].find(i => i.planId === plan.id && i.kind === 'stop' && i.params.clientAlgoId === algo.clientAlgoId);
    invariant(own && kernel.validStop(algo, plan, own.params.triggerPrice), 'RECOVERY_FOREIGN_OR_CHANGED_PROTECTION');
  }
  return decimal(quantity);
}
function ownHistoryComplete(kernel, book, plan, review) {
  invariant(![...book.positions.values()].some(p => p.id !== plan.id && p.symbol === plan.symbol && p.status === 'OPEN'), 'RECOVERY_OWNERSHIP_AMBIGUOUS');
  const entry = kernel.intents.get(clientId('entry', plan.id));
  invariant(entry?.kind === 'entry', 'RECOVERY_ENTRY_REQUIRED');
  for (const intent of kernel.intents.values()) {
    if (intent.planId !== plan.id || intent.method !== 'POST') continue;
    const result = intent.result;
    if (['entry', 'close'].includes(intent.kind)) {
      invariant(result && !result.unresolved && terminal(result.status), 'RECOVERY_OWN_ORDER_UNSETTLED');
      const fills = [...book.fills.values()].filter(f => f.planId === plan.id && f.fill.orderId === String(result.orderId));
      invariant(fills.reduce((sum, f) => sum + units(f.fill.quantity), 0n) === units(result.executedQty), 'RECOVERY_OWN_FILL_HISTORY_INCOMPLETE');
    } else if (intent.kind === 'stop') {
      invariant(result && !result.unresolved && ['NEW', 'CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED'].includes(result.algoStatus), 'RECOVERY_OWN_STOP_UNSETTLED');
      if (result.actualOrderId && String(result.actualOrderId) !== '0') invariant(book.control.get(`accounted:${plan.symbol}:${result.actualOrderId}`)?.terminal, 'RECOVERY_STOP_CHILD_UNSETTLED');
    }
  }
  for (const row of book.fills.values()) if (row.planId === plan.id) {
    const fact = review.facts.find(f => f.tradeId === row.fill.id);
    invariant(fact?.planId === plan.id && fact.classification.startsWith('OWNED_')
      && fact.direction === row.fill.direction && fact.side === row.fill.side && fact.orderId === row.fill.orderId
      && fact.quantity === row.fill.quantity && fact.price === row.fill.price && fact.fee === row.fill.commission
      && fact.feeAsset === 'USDT' && fact.realizedPnlUsdt === row.fill.realizedPnl && fact.time === row.fill.time, 'RECOVERY_OWN_TRADE_COVERAGE_INCOMPLETE');
  }
  invariant(review.issues.every(i => ['FORCED_EXIT_REVIEW_REQUIRED', 'UNATTRIBUTED_TRADE_REVIEW_REQUIRED', 'FORCED_ORDER_REVIEW_REQUIRED'].includes(i.code)), 'RECOVERY_HISTORY_HAS_UNRESOLVED_ISSUES');
  invariant(review.forced.every(f => terminal(f.status)), 'RECOVERY_FORCED_ORDER_UNSETTLED');
}
function externalEvents(review, plan, book) {
  const events = [];
  for (const fact of review.facts) {
    if (fact.classification.startsWith('OWNED_')) {
      invariant(fact.planId === plan.id, 'RECOVERY_OTHER_PLAN_ACTIVITY'); continue;
    }
    invariant(fact.direction === plan.direction && fact.side === closeSide(plan.direction)
      && ['LIQUIDATION', 'ADL', 'UNATTRIBUTED_TRADE'].includes(fact.classification), 'RECOVERY_EXTERNAL_OPEN_OR_AMBIGUOUS_LEG');
    const fill = normalizeFill({ symbol: fact.symbol, id: fact.tradeId, orderId: fact.orderId, positionSide: fact.direction,
      side: fact.side, qty: fact.quantity, price: fact.price, commission: fact.fee, commissionAsset: fact.feeAsset,
      realizedPnl: fact.realizedPnlUsdt, time: fact.time }, { symbol: plan.symbol, direction: plan.direction, orderId: fact.orderId, side: closeSide(plan.direction) });
    const prior = book.externalExits.get(`${fact.symbol}:${fact.tradeId}`);
    invariant(!prior || (prior.planId === plan.id && hash(prior.fill) === hash(fill)), 'RECOVERY_EXTERNAL_ALLOCATION_CONFLICT');
    events.push({ type: 'EXTERNAL_POSITION_EXIT', planId: plan.id, cause: fact.classification, sourceReviewFingerprint: review.fingerprint, fill });
  }
  return events;
}

// Offline/operator bookkeeping component only: no transport request, runtime
// activation, incident clear, financial operation, or automatic approval here.
export function prepareExternalRecovery({ kernel, book, activity, planId, reviewFingerprint, account, now = Date.now() }) {
  const plan = kernel.plans.get(planId), base = book.positions.get(planId), quarantine = book.control.get(`positionQuarantine:${planId}`);
  invariant(plan && base?.status === 'OPEN' && quarantine, 'RECOVERY_QUARANTINED_OPEN_POSITION_REQUIRED');
  const review = committedReview(activity, reviewFingerprint);
  invariant(review.symbol === plan.symbol && review.startTime <= base.openedAt && fresh(review.endTime, now, 30000)
    && review.endTime <= account.observedAt, 'RECOVERY_HISTORY_WINDOW_INCOMPLETE_OR_STALE');
  ownHistoryComplete(kernel, book, plan, review);
  const all = externalEvents(review, plan, book);
  const events = all.filter(e => !book.externalExits.has(`${e.fill.symbol}:${e.fill.id}`));
  invariant(events.length > 0 && events.length <= 128 && events.every(e => e.fill.time >= base.openedAt), 'RECOVERY_NEW_EXIT_BATCH_INVALID');
  const existing = [...book.externalExits.values()].filter(e => e.planId === planId);
  invariant(existing.every(e => all.some(a => a.fill.id === e.fill.id)), 'RECOVERY_PREVIOUS_EXIT_COVERAGE_INCOMPLETE');
  invariant(hash(withoutSequence(book.rebuild(plan))) === hash(withoutSequence(base)), 'RECOVERY_BASE_LEDGER_NOT_RECONCILED');
  const target = book.rebuild(plan, { additionalExternalExits: events });
  invariant(target.quantity === accountQuantity(account, plan, kernel, now), 'RECOVERY_VENUE_QUANTITY_MISMATCH');
  const proposal = { schema: 'S1_EXTERNAL_EXIT_RECOVERY_PROPOSAL_V1', planId, reviewFingerprint,
    ownDigest: ownDigest(kernel, book, planId), quarantineDigest: hash(quarantine), priorExternalDigest: hash(existing),
    basePosition: structuredClone(base), tradeIds: events.map(e => e.fill.id), targetQuantity: target.quantity,
    createdAt: now, existingProtectionOnly: true, allowNewEntries: false, allowStrategyManagement: false };
  return { ...proposal, fingerprint: hash(proposal) };
}

export async function applyExternalRecovery({ engine, activity, proposal, decision, account, verificationReviewFingerprint, now = Date.now() }) {
  invariant(engine.mode === 'OBSERVE' && !engine.running && !engine.kernel.busy, 'RECOVERY_REQUIRES_IDLE_OBSERVE_ENGINE');
  invariant(proposal?.schema === 'S1_EXTERNAL_EXIT_RECOVERY_PROPOSAL_V1' && proposal.fingerprint === hash({ ...proposal, fingerprint: undefined }), 'RECOVERY_PROPOSAL_FINGERPRINT_MISMATCH');
  invariant(decision?.proposalFingerprint === proposal.fingerprint && /^OPERATOR_[A-Z0-9_-]{1,80}$/.test(decision.decisionRef)
    && decision.existingProtectionOnly === true && decision.allowNewEntries === false && decision.allowStrategyManagement === false, 'RECOVERY_EXPLICIT_REVIEW_DECISION_REQUIRED');
  proposal = structuredClone(proposal);
  // Persist only the bounded decision contract, never arbitrary operator text.
  decision = { decisionRef: decision.decisionRef, proposalFingerprint: decision.proposalFingerprint, existingProtectionOnly: true, allowNewEntries: false, allowStrategyManagement: false };
  const { book, kernel } = engine, plan = kernel.plans.get(proposal.planId), id = proposal.fingerprint;
  const pendingKey = `externalRecoveryPending:${id}`, completionKey = `positionRecovery:${proposal.planId}`;
  engine.running = true; kernel.busy = true;
  try {
    invariant(plan && ownDigest(kernel, book, plan.id) === proposal.ownDigest, 'RECOVERY_OWN_STATE_CHANGED');
    invariant(hash(book.control.get(`positionQuarantine:${plan.id}`)) === proposal.quarantineDigest, 'RECOVERY_QUARANTINE_CHANGED');
    const priorExternal = [...book.externalExits.values()].filter(e => e.planId === plan.id && e.recoveryId !== id);
    invariant(hash(priorExternal) === proposal.priorExternalDigest, 'RECOVERY_EXTERNAL_STATE_CHANGED');
    const review = committedReview(activity, proposal.reviewFingerprint);
    // A delayed restart must obtain fresh history, not just the same net venue
    // quantity: an external close/reopen could otherwise pass a quantity check.
    const verification = committedReview(activity, verificationReviewFingerprint ?? proposal.reviewFingerprint);
    invariant(verification.symbol === review.symbol && verification.startTime <= review.startTime && verification.endTime >= review.endTime
      && verification.endTime <= account.observedAt && fresh(verification.endTime, now, 30000), 'RECOVERY_FRESH_HISTORY_VERIFICATION_REQUIRED');
    invariant(hash(verification.facts) === hash(review.facts) && hash(verification.forced) === hash(review.forced)
      && hash(verification.issues) === hash(review.issues), 'RECOVERY_ACTIVITY_CHANGED_SINCE_REVIEW');
    ownHistoryComplete(kernel, book, plan, review);
    const events = externalEvents(review, plan, book).filter(e => proposal.tradeIds.includes(e.fill.id))
      .map(e => ({ ...e, recoveryId: id, decisionRef: decision.decisionRef }));
    invariant(events.length === proposal.tradeIds.length && events.length > 0 && events.length <= 128, 'RECOVERY_BATCH_CHANGED');
    // Rebuild against the approved base even after a crash committed a prefix.
    const preview = Object.create(book); preview.positions = new Map([[plan.id, proposal.basePosition]]);
    preview.externalExits = new Map(priorExternal.map(e => [`${e.fill.symbol}:${e.fill.id}`, e]));
    const target = { ...preview.rebuild(plan, { additionalExternalExits: events }), externalRecoveryId: id };
    invariant(target.quantity === proposal.targetQuantity && target.quantity === accountQuantity(account, plan, kernel, now), 'RECOVERY_VENUE_QUANTITY_MISMATCH');
    const current = book.positions.get(plan.id);
    invariant(hash(current) === hash(proposal.basePosition) || hash(withoutSequence(current)) === hash(withoutSequence(target)), 'RECOVERY_POSITION_CHANGED');
    const pending = book.control.get(pendingKey), record = { proposal, decision };
    invariant(!pending || hash(pending) === hash(record), 'RECOVERY_DECISION_CONFLICT');
    if (!pending) {
      invariant(fresh(proposal.createdAt, now, 30000), 'RECOVERY_PROPOSAL_EXPIRED');
      const checked = prepareExternalRecovery({ kernel, book, activity, planId: plan.id, reviewFingerprint: proposal.reviewFingerprint, account, now });
      invariant(hash({ ...checked, createdAt: proposal.createdAt, fingerprint: undefined }) === proposal.fingerprint, 'RECOVERY_PROPOSAL_REVALIDATION_FAILED');
    }
    engine.pauseEntries(HOLD); engine.incident = HOLD;
    await book.setControl('entryIncident', HOLD);
    await book.setControl(pendingKey, record);
    for (const event of events) {
      const prior = book.externalExits.get(`${event.fill.symbol}:${event.fill.id}`);
      if (prior) invariant(hash(prior) === hash(event), 'RECOVERY_COMMITTED_EXIT_CONFLICT');
      else await book.commit(event);
    }
    await book.save(target);
    await engine.lifecycle.finishOperations(plan);
    await book.setControl(completionKey, { status: 'COMMITTED_PROTECTION_ONLY', recoveryId: id, decisionRef: decision.decisionRef,
      quarantineDigest: proposal.quarantineDigest, allowNewEntries: false, allowStrategyManagement: false });
    engine.quarantinedPlans.delete(plan.id); engine.lastSyncAt = null;
    return { status: 'COMMITTED_PROTECTION_ONLY', recoveryId: id, quantity: target.quantity, newEntriesBlocked: true, exchangeMutationPerformed: false };
  } finally { engine.running = false; kernel.busy = false; }
}
