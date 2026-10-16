import { align, freshRules } from '../../../lib/s1-precision.mjs';
import { fresh, invariant } from './common.mjs';

export const STOP_PLAN_REVISION = 'SMC-CONDITIONAL-STOP-1';
const terminal = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'POSITION_CLOSED']);
const key = id => `conditionalStops:${id}`;
export const conditionalStopPlans = (book, id) => book.control.get(key(id))?.plans ?? [];
const save = async (book, id, rows) => {
  const active = rows.filter(r => !terminal.has(r.status));
  const history = rows.filter(r => terminal.has(r.status)).slice(-16);
  await book.setControl(key(id), { revision: STOP_PLAN_REVISION, plans: [...history, ...active] });
};
const meets = (price, row) => row.comparison === 'GTE' ? price >= row.triggerPrice : price <= row.triggerPrice;

/** Store a future condition, never amend a venue stop when arming it. */
export async function configureConditionalStop({ book, position, action, quote, rule, now }) {
  const rows = conditionalStopPlans(book, position.id), existing = rows.find(r => r.id === action.id);
  if (existing) return { status: 'STOP_PLAN_ARMED', id: existing.id };
  if (action.action === 'CANCEL_STOP_PLAN') {
    const row = rows.find(r => r.id === action.stopPlanId);
    invariant(row, 'STOP_PLAN_NOT_FOUND');
    invariant(row.status !== 'SUBMITTED', 'STOP_PLAN_REPLACEMENT_PENDING');
    if (!terminal.has(row.status)) await save(book, position.id, rows.map(r => r === row
      ? { ...r, status: 'CANCELLED', updatedAt: now } : r));
    return { status: 'STOP_PLAN_CANCELLED', id: row.id };
  }
  invariant(action.action === 'ARM_STOP_PLAN', 'STOP_PLAN_ACTION_INVALID');
  invariant(rows.filter(r => !terminal.has(r.status)).length < 8, 'STOP_PLAN_LIMIT');
  rule = freshRules(rule, position.symbol, now);
  const rawStop = action.stopMode === 'ENTRY' ? String(position.entry) : String(action.stopPrice);
  // Round towards protection, using the venue grid. Validate against the trigger
  // price here; the actual quote and venue stop are rechecked on execution.
  const stop = align(rawStop, rule.price, position.direction === 1 ? 'UP' : 'DOWN');
  invariant(position.direction * (Number(stop) - Number(position.stop)) > 0, 'OWNER_STOP_MUST_TIGHTEN');
  invariant(position.direction * (action.triggerPrice - Number(stop)) > 0, 'STOP_PLAN_STOP_BEYOND_TRIGGER');
  invariant(!meets(Number(position.direction === 1 ? quote.bid : quote.ask), action), 'STOP_PLAN_TRIGGER_ALREADY_REACHED');
  const row = { id: action.id, comparison: action.comparison, triggerPrice: action.triggerPrice,
    stopMode: action.stopMode, stopPrice: Number(stop), expiresAt: action.planExpiresAt ?? null,
    createdAt: now, updatedAt: now, armedAfterSequence: quote.sequence, status: 'ARMED',
    triggeredAt: null, triggerQuoteSequence: null, reason: null };
  await save(book, position.id, [...rows, row]);
  return { status: 'STOP_PLAN_ARMED', id: row.id };
}

/** Called only by the sole execution engine with a fresh reconciled account. */
export async function runConditionalStops({ book, kernel, lifecycle, plan, position, account, quote, rule, now }) {
  const rows = conditionalStopPlans(book, position.id);
  if (!rows.some(r => !terminal.has(r.status))) return { type: 'HOLD' };
  if (position.status !== 'OPEN') {
    await save(book, position.id, rows.map(r => terminal.has(r.status) ? r : { ...r, status: 'POSITION_CLOSED', updatedAt: now }));
    return { type: 'HOLD' };
  }
  if (kernel.activeStopReplacement(plan)) return { type: 'HOLD' };
  if (!quote || !fresh(quote.marketTime, now, 2000) || !fresh(quote.receivedAt, now, 2000)
    || quote.persisted !== true || quote.continuity !== true || !fresh(account?.observedAt, now, 5000)) return { type: 'HOLD' };
  if (position.stopClientId && !account.algos?.some(a => a.clientAlgoId === position.stopClientId
    && a.algoStatus === 'NEW' && Number(a.triggerPrice) === Number(position.stop))) return { type: 'HOLD' };
  const price = Number(position.direction === 1 ? quote.bid : quote.ask);
  if (!(price > 0)) return { type: 'HOLD' };
  const update = async row => save(book, position.id, conditionalStopPlans(book, position.id).map(r => r.id === row.id ? row : r));
  for (let row of rows.filter(r => !terminal.has(r.status))) {
    // Already-tightened protection satisfies a plan without a duplicate order.
    if (position.direction * (Number(position.stop) - row.stopPrice) >= 0) {
      await update({ ...row, status: 'COMPLETED', updatedAt: now, reason: 'CURRENT_STOP_ALREADY_PROTECTS' });
      continue;
    }
    if (row.expiresAt != null && now >= row.expiresAt && row.triggeredAt == null) {
      await update({ ...row, status: 'EXPIRED', updatedAt: now }); continue;
    }
    if (row.triggeredAt == null) {
      if (quote.receivedAt <= row.createdAt || !meets(price, row)) continue;
      row = { ...row, triggeredAt: now, triggerQuoteSequence: quote.sequence, status: 'TRIGGERED', updatedAt: now };
      await update(row); // Durable latch before an exchange intention.
    }
    if (position.direction * (price - row.stopPrice) <= 0) {
      if (row.status !== 'WAIT_PRICE') await update({ ...row, status: 'WAIT_PRICE', reason: 'STOP_PLAN_PRICE_RECHECK', updatedAt: now });
      continue;
    }
    // lifecycle preserves the old exchange protection until replacement verified.
    let result;
    try { result = await lifecycle.ownerTightenStop(plan, position, account, rule, quote, row.stopPrice, `conditional:${row.id}`); }
    catch (error) {
      // Both failures precede mutation: recheck advanced price/protection while
      // preserving the existing exchange stop and durable trigger.
      if (error.message === 'MANAGEMENT_QUOTE_STALE') return { type: 'HOLD' };
      if (!['TRIGGER_CROSSED_REFERENCE', 'OWNER_STOP_MUST_TIGHTEN'].includes(error.message)) throw error;
      if (row.reason !== error.message) await update({ ...row, status: 'WAIT_PRICE', reason: error.message, updatedAt: now });
      continue;
    }
    const completed = ['PROTECTION_REPLACED', 'STOP_REPLACEMENT_FLAT'].includes(result.status);
    await update({ ...row, status: completed ? 'COMPLETED' : 'SUBMITTED', updatedAt: now, reason: result.status });
    return { type: 'CONDITIONAL_STOP', id: row.id, result };
  }
  return { type: 'HOLD' };
}
