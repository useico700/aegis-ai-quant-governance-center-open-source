import { assertSafeParsedNumbers } from '../../../lib/exchange-json.mjs';
import { units, decimal } from '../../../lib/s1-precision.mjs';
import { hash, invariant, entrySide, closeSide } from './common.mjs';

import { resolveProfitRetentionPolicy } from '../../shared/profit-retention.mjs';

const SCALE = units('1');
export const signedUnits = value => String(value).startsWith('-') ? -units(String(value).slice(1)) : units(value);
export const signedDecimal = value => value < 0n ? `-${decimal(-value)}` : decimal(value);
const roundProduct = (a, b) => (a * b + SCALE / 2n) / SCALE;

export function normalizeFill(row, { symbol, direction, orderId, side }) {
  assertSafeParsedNumbers({ id: row.id, orderId: row.orderId, expectedOrderId: orderId });
  invariant(row.symbol === symbol && row.positionSide === direction && row.side === side && String(row.orderId) === String(orderId), 'FILL_OWNERSHIP_MISMATCH');
  invariant(/^\d+$/.test(String(row.id)) && /^\d+$/.test(String(row.orderId)), 'FILL_IDENTIFIER_INVALID');
  invariant(row.commissionAsset === 'USDT', 'NON_USDT_FEE_REQUIRES_CONVERSION');
  invariant(Number.isSafeInteger(row.time) && row.time > 0, 'FILL_TIME_INVALID');
  const quantity = units(row.qty), price = units(row.price), commission = units(row.commission), realized = signedUnits(row.realizedPnl);
  invariant(quantity > 0n && price > 0n, 'FILL_PRICE_QUANTITY_INVALID');
  return { id: String(row.id), orderId: String(row.orderId), symbol, direction, side, quantity: decimal(quantity), price: decimal(price),
    commission: decimal(commission), realizedPnl: signedDecimal(realized), time: row.time };
}

// A restart replays compact, idempotent trade facts; it never projects simulated
// fills from an order acknowledgement, a trigger observation, or an OHLC bar.
export class PositionLedger {
  constructor(journal) {
    this.journal = journal; this.positions = new Map(); this.fills = new Map(); this.externalExits = new Map(); this.operations = new Map(); this.income = new Map(); this.control = new Map();
    for (const event of journal.events) this.project(event);
  }
  project(event) {
    if (event.type === 'POSITION_VIEW') {
      const prior = this.positions.get(event.position.id);
      invariant(event.position.sequence === (prior?.sequence ?? 0) + 1, 'POSITION_SEQUENCE_MISMATCH');
      this.positions.set(event.position.id, event.position);
    }
    if (event.type === 'VENUE_FILL') {
      const key = `${event.fill.symbol}:${event.fill.id}`;
      invariant(!this.fills.has(key) && !this.externalExits.has(key), 'DUPLICATE_COMMITTED_FILL'); this.fills.set(key, event);
    }
    if (event.type === 'EXTERNAL_POSITION_EXIT') {
      const key = `${event.fill.symbol}:${event.fill.id}`;
      invariant(!this.fills.has(key) && !this.externalExits.has(key), 'DUPLICATE_EXTERNAL_EXIT'); this.externalExits.set(key, event);
    }
    if (event.type === 'MANAGEMENT_OPERATION') {
      invariant(!this.operations.has(event.id), 'DUPLICATE_MANAGEMENT_OPERATION'); this.operations.set(event.id, event);
    }
    if (event.type === 'INCOME_FACT') {
      invariant(!this.income.has(event.key), 'DUPLICATE_COMMITTED_INCOME'); this.income.set(event.key, event);
    }
    if (event.type === 'CONTROL_STATE') this.control.set(event.key, event.value);
  }
  async commit(event) { await this.journal.append(event); this.project(event); }
  async save(position) {
    const prior = this.positions.get(position.id);
    if (prior && hash({ ...prior, sequence: undefined }) === hash({ ...position, sequence: undefined })) return prior;
    const next = { ...position, sequence: (prior?.sequence ?? 0) + 1 };
    await this.commit({ type: 'POSITION_VIEW', position: next }); return next;
  }
  async setControl(key, value) { if (hash(this.control.get(key) ?? null) !== hash(value)) await this.commit({ type: 'CONTROL_STATE', key, value }); }
  async operation(operation) {
    const existing = this.operations.get(operation.id);
    if (existing) { invariant(hash(existing) === hash({ type: 'MANAGEMENT_OPERATION', ...operation }), 'MANAGEMENT_OPERATION_CONFLICT'); return existing; }
    const event = { type: 'MANAGEMENT_OPERATION', ...operation }; await this.commit(event); return event;
  }
  async recordOrderFills(plan, order, rows, role) {
    const side = role === 'ENTRY' ? entrySide(plan.direction) : closeSide(plan.direction);
    invariant(Array.isArray(rows) && ['ENTRY', 'EXIT'].includes(role), 'FILL_BATCH_INVALID');
    let quantity = 0n; const batch = new Map();
    for (const row of rows) {
      const fill = normalizeFill(row, { symbol: plan.symbol, direction: plan.direction, orderId: order.orderId, side });
      const previous = batch.get(fill.id);
      invariant(!previous || hash(previous) === hash(fill), 'CONFLICTING_DUPLICATE_TRADE');
      if (!previous) { batch.set(fill.id, fill); quantity += units(fill.quantity); }
    }
    invariant(quantity === units(order.executedQty), 'ORDER_FILL_HISTORY_INCOMPLETE');
    invariant([...batch.values()].every(fill => !this.externalExits.has(`${fill.symbol}:${fill.id}`)), 'EXTERNAL_EXIT_CANNOT_BECOME_STRATEGY_FILL');
    for (const fill of batch.values()) {
      const key = `${fill.symbol}:${fill.id}`, prior = this.fills.get(key);
      if (prior) invariant(prior.planId === plan.id && prior.role === role && hash(prior.fill) === hash(fill), 'HISTORICAL_FILL_CHANGED');
      else await this.commit({ type: 'VENUE_FILL', planId: plan.id, role, fill });
    }
  }
  async recordIncome(row) {
    assertSafeParsedNumbers({ tranId: row.tranId });
    invariant(typeof row.incomeType === 'string' && /^\d+$/.test(String(row.tranId)) && Number.isSafeInteger(row.time) && row.time > 0, 'INCOME_FACT_INVALID');
    invariant(row.asset === 'USDT', 'INCOME_ASSET_REQUIRES_CONVERSION');
    const event = { type: 'INCOME_FACT', key: `${row.incomeType}:${row.tranId}`, symbol: row.symbol ?? '', incomeType: row.incomeType, value: signedDecimal(signedUnits(row.income)), time: row.time };
    const alias = this.control.get(`incomeIdentifierAlias:${event.key}`);
    if (alias) {
      const legacy = this.income.get(alias.legacyKey);
      invariant(alias.schema === 'EXACT_INCOME_ALIAS_V1' && alias.exactKey === event.key
        && typeof alias.legacyKey === 'string' && alias.legacyKey !== event.key
        && legacy?.symbol === event.symbol && legacy.incomeType === event.incomeType
        && legacy.value === event.value && legacy.time === event.time,
      'INCOME_IDENTIFIER_ALIAS_CONFLICT');
      return legacy;
    }
    const prior = this.income.get(event.key);
    // Older releases may already have persisted a rounded transaction ID. Do
    // not append the exact spelling as another income fact and count it twice.
    if (!prior && !Number.isSafeInteger(Number(row.tranId))) {
      const possibleLegacy = [...this.income.values()].some(old => old.identifierPrecision !== 'EXACT_V1'
        && old.incomeType === event.incomeType
        && Number(old.key.slice(old.key.indexOf(':') + 1)) === Number(row.tranId));
      invariant(!possibleLegacy, 'INCOME_IDENTIFIER_RECONCILIATION_REQUIRED');
    }
    if (prior) invariant(hash({ ...prior, identifierPrecision: undefined }) === hash(event), 'HISTORICAL_INCOME_CHANGED');
    else await this.commit({ ...event, identifierPrecision: 'EXACT_V1' });
  }
  rebuild(plan, { additionalExternalExits = [] } = {}) {
    const prior = this.positions.get(plan.id);
    const entries = [...this.fills.values()].filter(row => row.planId === plan.id && row.role === 'ENTRY').map(row => row.fill);
    const exits = [...this.fills.values()].filter(row => row.planId === plan.id && row.role === 'EXIT').map(row => row.fill);
    const externalEvents = [...this.externalExits.values(), ...additionalExternalExits].filter(row => row.planId === plan.id);
    invariant(new Set(externalEvents.map(row => `${row.fill.symbol}:${row.fill.id}`)).size === externalEvents.length, 'DUPLICATE_EXTERNAL_EXIT_PREVIEW');
    const external = externalEvents.map(row => row.fill);
    if (!entries.length) return null;
    let original = 0n, closed = 0n, entryQuote = 0n, entryFees = 0n, exitFees = 0n, realized = 0n;
    for (const fill of entries) { original += units(fill.quantity); entryQuote += roundProduct(units(fill.quantity), units(fill.price)); entryFees += units(fill.commission); invariant(signedUnits(fill.realizedPnl) === 0n, 'ENTRY_REALIZED_PNL_UNEXPECTED'); }
    for (const fill of exits) { closed += units(fill.quantity); exitFees += units(fill.commission); realized += signedUnits(fill.realizedPnl); }
    const ownClosed = closed, ownExitFees = exitFees, ownRealized = realized;
    let externalFees = 0n, externalRealized = 0n, externalClosed = 0n;
    for (const fill of external) { externalClosed += units(fill.quantity); externalFees += units(fill.commission); externalRealized += signedUnits(fill.realizedPnl); }
    closed += externalClosed; exitFees += externalFees; realized += externalRealized;
    invariant(original <= units(plan.quantity) && closed <= original, 'FILLS_EXCEED_OWNED_POSITION');
    const quantity = original - closed, entry = entryQuote * SCALE / original;
    const direction = plan.direction === 'LONG' ? 1 : -1;
    const distance = BigInt(direction) * (entry - units(plan.stopPrice));
    const costRisk = distance + (entryFees * SCALE + original - 1n) / original + roundProduct(units(plan.stopPrice), units(plan.takerFeeRate) + units(plan.adverseSlippageRate));
    invariant(costRisk > 0n, 'ACTUAL_ENTRY_RISK_INVALID');
    const initialRisk = (original * costRisk + SCALE - 1n) / SCALE;
    const openedAt = Math.min(...entries.map(row => row.time)), closedAt = quantity === 0n ? Math.max(...[...exits, ...external].map(row => row.time)) : null;
    const allocatedEntryFees = original > 0n ? entryFees * closed / original : 0n;
    // Unknown boundary-time funding remains in the account ledger, never assigned
    // to a position by guessing which same-millisecond event came first.
    const fundingRows = [...this.income.values()].filter(row => row.incomeType === 'FUNDING_FEE' && row.symbol === plan.symbol && row.time >= openedAt && (closedAt === null || row.time <= closedAt));
    const fundingAmbiguous = fundingRows.some(row => row.time === openedAt || row.time === closedAt);
    const funding = fundingRows.filter(row => row.time > openedAt && (closedAt === null || row.time < closedAt)).reduce((sum, row) => sum + signedUnits(row.value), 0n);
    const realizedNet = realized - allocatedEntryFees - exitFees;
    const ownAllocatedEntryFees = entryFees * ownClosed / original;
    const strategyNet = ownRealized - ownAllocatedEntryFees - ownExitFees;
    const position = { ...prior, id: plan.id, symbol: plan.symbol, direction, status: quantity > 0n ? 'OPEN' : 'CLOSED', stage: prior?.stage ?? 'INITIAL', openedAt, closedAt,
      implementationRevision: plan.revision, managementPolicy: plan.managementPolicy ?? null,
      intersectionTime: plan.intersectionTime ?? null, initialStop: plan.stopPrice, stop: prior?.stop ?? plan.stopPrice,
      entry: Number(decimal(entry)), quantity: decimal(quantity), originalQuantity: decimal(original), entryFee: Number(decimal(entryFees)), cumulativeExitFee: Number(decimal(exitFees)),
      initialRiskPerUnit: Number(decimal(costRisk)), initialPlannedRiskUsdt: Number(decimal(initialRisk)), cumulativeRealizedNetPnl: Number(signedDecimal(realizedNet)),
      fundingNetUsdt: signedDecimal(funding), fundingAttributionComplete: !fundingAmbiguous,
      netPnlIncludingKnownFundingUsdt: signedDecimal(realizedNet + funding), accountingComplete: true,
      exact: { entryQuoteUsdt: decimal(entryQuote), entryFeesUsdt: decimal(entryFees), exitFeesUsdt: decimal(exitFees), realizedGrossUsdt: signedDecimal(realized), realizedNetUsdt: signedDecimal(realizedNet), initialRiskUsdt: decimal(initialRisk),
        strategyRealizedNetUsdt: signedDecimal(strategyNet), externalClosedQuantity: decimal(externalClosed), externalExitFeesUsdt: decimal(externalFees),
        externalRealizedGrossUsdt: signedDecimal(externalRealized), externalRealizedNetUsdt: signedDecimal(realizedNet - strategyNet) },
      ...(external.length ? { strategyManagementSuspended: true, promotionStatisticsEligible: false, performanceContaminated: true,
        externalCashFlowAttributionComplete: false, externalExitCount: external.length } : {}),
      actualRiskExceededPlan: initialRisk > units(plan.budgetUsdt),
      softLockTaken: prior?.softLockTaken ?? false, firstPartialTaken: prior?.firstPartialTaken ?? false, secondPartialTaken: prior?.secondPartialTaken ?? false,
      maximumNetExcursionR: prior?.maximumNetExcursionR ?? 0, runnerMaximumNetExcursionR: prior?.runnerMaximumNetExcursionR ?? 0 };
    position.managementPolicy = resolveProfitRetentionPolicy(plan.managementPolicy ?? null, position,
      { takerFeeRate: plan.takerFeeRate, adverseSlippageRate: plan.adverseSlippageRate });
    return position;
  }
}
