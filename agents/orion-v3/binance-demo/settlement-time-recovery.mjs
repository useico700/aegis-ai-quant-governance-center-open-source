import { createHash } from "node:crypto";

export const SETTLEMENT_TIME_RECOVERY_EVENT = "BINANCE_DEMO_PARTIAL_SETTLEMENT_TIME_RECOVERED";
export const SETTLEMENT_TIME_RECOVERY_AUTHORIZATION = "OWNER-DIRECTIVE-V3-SETTLEMENT-TIME-RECOVERY-20260914";

const VENUE = "BINANCE_USDM_TESTNET";
const SOURCE = "SIGNED_GET_USER_TRADES";
const TIME_BASIS = "LAST_FILL_EXCHANGE_TIME";

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(`V3_SETTLEMENT_TIME_RECOVERY_${reason}`);
}

function number(value, name) {
  requireEvidence((typeof value === "number" || typeof value === "string") && value !== "" && Number.isFinite(Number(value)), `INVALID_${name}`);
  return Number(value);
}

function timestamp(value, name) {
  const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  requireEvidence(Number.isSafeInteger(time) && time > 0, `INVALID_${name}`);
  return time;
}

function identifier(value, name) {
  requireEvidence((typeof value === "string" && /^[1-9]\d{0,31}$/.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value > 0), `INVALID_${name}`);
  return String(value);
}

function optionalText(value, name) {
  if (value === null || value === undefined) return null;
  requireEvidence(typeof value === "string" && value.length > 0 && value.length <= 240, `INVALID_${name}`);
  return value;
}

function sameAmount(left, right) {
  // USDT evidence is rounded to 8 decimals; permit that precision plus binary summation noise only.
  return Math.abs(left - right) <= 1e-8 + 16 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function tradeIds(values) {
  requireEvidence(Array.isArray(values) && values.length > 0, "MISSING_TRADE_IDS");
  const ids = values.map((id) => identifier(id, "TRADE_ID"));
  requireEvidence(new Set(ids).size === ids.length, "DUPLICATE_TRADE_IDS");
  return ids.sort();
}

function commission(value, expected, name) {
  requireEvidence(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && Object.hasOwn(value, "USDT"), `INVALID_${name}`);
  const amount = number(value.USDT, name);
  requireEvidence(amount >= 0 && sameAmount(amount, expected), `${name}_MISMATCH`);
  return { USDT: amount };
}

function reference(value) {
  requireEvidence(value && typeof value.path === "string" && value.path.length > 0 && value.path.length <= 500
    && !value.path.startsWith("/") && !value.path.includes("\\") && !value.path.includes(":")
    && value.path.split("/").every((part) => part && part !== "." && part !== "..")
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "INVALID_EVIDENCE_REFERENCE");
  return { path: value.path, sha256: value.sha256 };
}

function validate(row, partial, cost, observedAt, sourceTime) {
  requireEvidence(row?.venue === VENUE && cost?.venue === VENUE && cost?.source === SOURCE, "VENUE_OR_SOURCE_MISMATCH");
  const symbol = row?.symbol;
  requireEvidence(typeof symbol === "string" && /^[A-Z0-9]+USDT$/.test(symbol) && cost.symbol === symbol, "SYMBOL_MISMATCH");
  const intentId = optionalText(row.intentId, "INTENT_ID");
  const outcomeId = optionalText(row.outcomeId, "OUTCOME_ID");
  requireEvidence(intentId !== null || outcomeId !== null, "MISSING_POSITION_IDENTITY");
  const openedAt = timestamp(row.openedAt, "OPENED_AT");
  const closedAt = row.closedAt === null || row.closedAt === undefined ? null : timestamp(row.closedAt, "CLOSED_AT");
  const observedTime = timestamp(observedAt, "OBSERVED_AT");
  const maximumTime = Math.min(timestamp(sourceTime, "SOURCE_TIME"), observedTime, closedAt ?? Infinity);
  requireEvidence((closedAt === null || closedAt >= openedAt) && maximumTime >= openedAt, "INVALID_LIFECYCLE");
  requireEvidence(row.direction === 1 || row.direction === -1, "INVALID_DIRECTION");
  const orderId = identifier(partial?.orderId, "ORDER_ID");
  requireEvidence(identifier(cost.orderId, "COST_ORDER_ID") === orderId, "ORDER_MISMATCH");
  const ids = tradeIds(partial.tradeIds);
  const quantity = number(partial.quantity, "QUANTITY");
  const fill = number(partial.fill, "FILL_PRICE");
  const grossPnl = number(partial.grossPnl, "GROSS_PNL");
  const exitFee = number(partial.exitFee, "EXIT_FEE");
  const entryFeeAllocated = number(partial.entryFeeAllocated, "ENTRY_FEE_ALLOCATED");
  const netPnl = number(partial.netPnl, "NET_PNL");
  requireEvidence(quantity > 0 && fill > 0 && exitFee >= 0 && entryFeeAllocated >= 0, "INVALID_PARTIAL_AMOUNTS");
  requireEvidence(sameAmount(grossPnl - exitFee - entryFeeAllocated, netPnl), "NET_PNL_MISMATCH");
  const exitCommissionByAsset = commission(partial.exitCommissionByAsset, exitFee, "PARTIAL_COMMISSION");
  requireEvidence(cost.status === "ACTUAL_BINANCE_DEMO_TRADES" && cost.allCommissionInUsdt === true, "INCOMPLETE_TRADE_COST");
  requireEvidence(Array.isArray(cost.fills) && cost.fills.length > 0 && cost.tradeCount === cost.fills.length, "INCOMPLETE_FILLS");
  const fills = cost.fills.map((item) => {
    requireEvidence((item.symbol === undefined || item.symbol === symbol) && (item.orderId === undefined || identifier(item.orderId, "FILL_ORDER_ID") === orderId), "FILL_IDENTITY_MISMATCH");
    const result = {
      tradeId: identifier(item.tradeId, "FILL_TRADE_ID"),
      price: number(item.price, "FILL_PRICE"),
      quantity: number(item.quantity, "FILL_QUANTITY"),
      commission: number(item.commission, "FILL_COMMISSION"),
      commissionAsset: item.commissionAsset,
      realizedPnlUsdt: number(item.realizedPnlUsdt, "FILL_REALIZED_PNL"),
      time: timestamp(item.time, "FILL_TIME"),
    };
    requireEvidence(result.price > 0 && result.quantity > 0 && result.commission >= 0 && result.commissionAsset === "USDT", "INVALID_FILL_AMOUNTS");
    requireEvidence(result.time >= openedAt && result.time <= maximumTime, "FILL_TIME_OUTSIDE_LIFECYCLE");
    return result;
  }).sort((left, right) => left.tradeId.localeCompare(right.tradeId));
  requireEvidence(JSON.stringify(tradeIds(fills.map((item) => item.tradeId))) === JSON.stringify(ids), "TRADE_IDS_MISMATCH");
  const sum = (key) => fills.reduce((total, item) => total + item[key], 0);
  const fillQuantity = sum("quantity");
  const fillGrossPnl = sum("realizedPnlUsdt");
  const fillCommission = sum("commission");
  requireEvidence(sameAmount(fillQuantity, quantity), "QUANTITY_MISMATCH");
  requireEvidence(sameAmount(fills.reduce((total, item) => total + item.price * item.quantity, 0) / fillQuantity, fill), "FILL_PRICE_MISMATCH");
  requireEvidence(sameAmount(fillGrossPnl, grossPnl) && sameAmount(number(cost.realizedPnlUsdt, "COST_GROSS_PNL"), grossPnl), "GROSS_PNL_MISMATCH");
  requireEvidence(sameAmount(fillCommission, exitFee) && sameAmount(number(cost.commissionUsdt, "COST_COMMISSION"), exitFee), "EXIT_COMMISSION_MISMATCH");
  commission(cost.commissionByAsset, exitFee, "COST_COMMISSION_BY_ASSET");
  const evaluationCohortId = optionalText(row.evaluationCohortId, "COHORT");
  const implementationRevision = optionalText(row.implementationRevision, "IMPLEMENTATION_REVISION");
  const originalPartialDigest = digest({
    venue: VENUE, symbol, positionIdentity: intentId ? { intentId } : { outcomeId }, openedAt,
    direction: row.direction, entryOrderId: row.entryOrderId == null ? null : identifier(row.entryOrderId, "ENTRY_ORDER_ID"),
    evaluationCohortId, implementationRevision, strategyVersion: optionalText(row.strategyVersion, "STRATEGY_VERSION"),
    partial: { orderId, reason: optionalText(partial.reason, "PARTIAL_REASON"), tradeIds: ids, quantity, fill, grossPnl, exitFee, entryFeeAllocated, netPnl, exitCommissionByAsset },
  });
  const executedAt = Math.max(...fills.map((item) => item.time));
  const tradeCost = { venue: VENUE, source: SOURCE, symbol, status: cost.status, orderId, tradeCount: fills.length, commissionByAsset: { USDT: fillCommission }, commissionUsdt: fillCommission, allCommissionInUsdt: true, realizedPnlUsdt: fillGrossPnl, fills };
  return { symbol, intentId, outcomeId, orderId, evaluationCohortId, implementationRevision, originalPartialDigest, tradeCost, executedAt, observedTime };
}

/** Pure factory: the caller reads/hashes the signed evidence file and appends the returned event.
 * The aggregate returned by queryOrderTradeCost must carry its query's symbol, venue and source.
 * No source row, amount, cohort, account balance, order or historical audit event is changed.
 */
export function createPartialSettlementTimeRecovery({ row, partial, tradeCost, observedAt, evidenceReference } = {}) {
  const value = validate(row, partial, tradeCost, observedAt, observedAt);
  const recoveryId = `v3settlementtime_${digest({ originalPartialDigest: value.originalPartialDigest, fills: value.tradeCost.fills })}`;
  return {
    schemaVersion: 1,
    eventType: SETTLEMENT_TIME_RECOVERY_EVENT,
    authorizationId: SETTLEMENT_TIME_RECOVERY_AUTHORIZATION,
    recoveryId,
    venue: VENUE,
    source: SOURCE,
    occurredAt: new Date(value.observedTime).toISOString(),
    symbol: value.symbol,
    intentId: value.intentId,
    outcomeId: value.outcomeId,
    orderId: value.orderId,
    evaluationCohortId: value.evaluationCohortId,
    implementationRevision: value.implementationRevision,
    originalPartialDigest: value.originalPartialDigest,
    executedAt: value.executedAt,
    timestampSemantics: TIME_BASIS,
    evidenceReference: reference(evidenceReference),
    tradeCost: value.tradeCost,
  };
}

/** A later observation may restore an earlier snapshot's fill; occurredAt is never its x-axis time.
 * Duplicate, equivalent evidence is idempotent. Any conflicting applicable recovery fails closed.
 */
export function recoveredPartialSettlementTime(row, partial, recoveryEvents, sourceTime) {
  try {
    const orderId = identifier(partial?.orderId, "ORDER_ID");
    const candidates = (Array.isArray(recoveryEvents) ? recoveryEvents : []).filter((event) => event?.eventType === SETTLEMENT_TIME_RECOVERY_EVENT && event?.symbol === row?.symbol && String(event?.orderId) === orderId);
    if (!candidates.length) return null;
    let accepted = null;
    for (const event of candidates) {
      requireEvidence(event.schemaVersion === 1 && event.authorizationId === SETTLEMENT_TIME_RECOVERY_AUTHORIZATION && event.venue === VENUE && event.source === SOURCE && event.timestampSemantics === TIME_BASIS, "INVALID_RECOVERY_AUTHORITY");
      const validated = validate(row, partial, event.tradeCost, event.occurredAt, sourceTime);
      const expected = createPartialSettlementTimeRecovery({ row, partial, tradeCost: event.tradeCost, observedAt: event.occurredAt, evidenceReference: event.evidenceReference });
      requireEvidence(event.intentId === validated.intentId && event.outcomeId === validated.outcomeId, "POSITION_IDENTITY_MISMATCH");
      requireEvidence(event.evaluationCohortId === validated.evaluationCohortId && event.implementationRevision === validated.implementationRevision && event.originalPartialDigest === validated.originalPartialDigest, "ORIGINAL_PARTIAL_CHANGED");
      requireEvidence(event.executedAt === validated.executedAt && event.recoveryId === expected.recoveryId, "RECOVERY_CONTENT_MISMATCH");
      requireEvidence(accepted === null || accepted.recoveryId === event.recoveryId, "CONFLICTING_RECOVERY");
      accepted = event;
    }
    return accepted.executedAt;
  } catch {
    return null;
  }
}
