import { units, decimal, calibrateEntryPlan, freshRules } from '../../../lib/s1-precision.mjs';
import { hash, invariant, fresh, clientId, closeSide, entrySide, REVISION, UNIVERSE } from './common.mjs';
import { evaluateTrialBudget } from './trial-budget.mjs';
import { validateMutation } from './transport.mjs';
import { highLeverageStopSafety } from '../../shared/leverage-stop-safety.mjs';

// Directed orders are a caller-specified intent lane, not a strategy. They add
// one intent source and one exit reason. They never relax an existing gate, never
// get their own budget, and never place a naked position. Offline and pure: no
// network, credentials, signing, timers or submission happen in this module.

const SCALE = units('1');
const BPS = 10000n;
const OVERDUE_FLOOR_MS = 600000;
const min = (...values) => values.reduce((a, b) => a < b ? a : b);
const integerIn = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const decimalString = value => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && units(value) > 0n;

export function validateDirectedBlock(directed) {
  invariant(directed && typeof directed === 'object' && !Array.isArray(directed), 'DIRECTED_BLOCK_MISSING');
  invariant(Array.isArray(directed.allowedSymbols) && directed.allowedSymbols.length > 0
    && directed.allowedSymbols.every(symbol => UNIVERSE.includes(symbol))
    && new Set(directed.allowedSymbols).size === directed.allowedSymbols.length, 'DIRECTED_SYMBOLS_INVALID');
  invariant(decimalString(directed.maximumNotionalUsdt), 'DIRECTED_NOTIONAL_CAP_INVALID');
  invariant(integerIn(directed.maximumHoldMs, 60000, 86400000), 'DIRECTED_HOLD_CAP_INVALID');
  invariant(integerIn(directed.maximumStopDistanceBps, 1, 1000), 'DIRECTED_STOP_CAP_INVALID');
  invariant(integerIn(directed.maximumIntentsPerWindow, 1, Number.MAX_SAFE_INTEGER), 'DIRECTED_RATE_CAP_INVALID');
  invariant(integerIn(directed.windowMs, 60000, Number.MAX_SAFE_INTEGER), 'DIRECTED_WINDOW_INVALID');
  const notBefore = Date.parse(directed.notBefore), notAfter = Date.parse(directed.notAfter);
  // A null or absent validity window is an unfinished draft, never "no expiry".
  invariant(Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore < notAfter, 'DIRECTED_VALIDITY_WINDOW_INVALID');
  return { ...directed, notBefore, notAfter };
}

// Extends the existing authorization contract. entriesEnabled and directedEnabled
// are independent: neither implies the other, so arming strategy entries never
// silently arms directed orders and vice versa.
export function validDirectedAuthorization(config, limitsDigest) {
  if (config?.schema !== 'S2_EXECUTION_AUTHORIZATION_V1' || config.accountLabel !== 'S2'
    || config.strategyRevision !== REVISION || config.trialLimitsDigest !== limitsDigest
    || typeof config.enabled !== 'boolean' || typeof config.entriesEnabled !== 'boolean'
    || typeof config.directedEnabled !== 'boolean') return null;
  if (!config.enabled && (config.entriesEnabled || config.directedEnabled)) return null;
  if (!config.directedEnabled) return { enabled: config.enabled, directedEnabled: false, directed: null };
  try { return { enabled: config.enabled, directedEnabled: true, directed: validateDirectedBlock(config.directed) }; }
  catch { return null; }
}

export async function readDirectedAuthorizationStatus({ trialLimits, load }) {
  try {
    const parsed = validDirectedAuthorization(await load(), hash(trialLimits));
    if (!parsed) return { status: 'INVALID_OR_UNREADABLE', directedEnabled: false };
    if (!parsed.enabled) return { status: 'DISABLED', directedEnabled: false };
    return { status: parsed.directedEnabled ? 'DIRECTED_ENABLED' : 'DIRECTED_DISABLED', directedEnabled: parsed.directedEnabled };
  } catch { return { status: 'INVALID_OR_UNREADABLE', directedEnabled: false }; }
}

export function validateDirectedIntent(intent, directed, recentIntents, now) {
  invariant(intent?.schema === 'S2_DIRECTED_INTENT_V1', 'DIRECTED_INTENT_SCHEMA_INVALID');
  invariant(typeof intent.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(intent.id), 'DIRECTED_INTENT_ID_INVALID');
  invariant(['LONG', 'SHORT'].includes(intent.direction), 'DIRECTED_DIRECTION_INVALID');
  invariant(['OPERATOR', 'AGENT'].includes(intent.requestedBy), 'DIRECTED_REQUESTER_INVALID');
  invariant(UNIVERSE.includes(intent.symbol) && directed.allowedSymbols.includes(intent.symbol), 'DIRECTED_SYMBOL_FORBIDDEN');
  invariant(decimalString(intent.notionalUsdt) && units(intent.notionalUsdt) <= units(directed.maximumNotionalUsdt), 'DIRECTED_NOTIONAL_EXCEEDED');
  invariant(integerIn(intent.holdMs, 60000, directed.maximumHoldMs), 'DIRECTED_HOLD_EXCEEDED');
  invariant(integerIn(intent.stopDistanceBps, 1, directed.maximumStopDistanceBps), 'DIRECTED_STOP_DISTANCE_EXCEEDED');
  invariant(Number.isFinite(intent.createdAt) && fresh(intent.createdAt, now, 60000), 'DIRECTED_INTENT_STALE');
  invariant(now >= directed.notBefore && now < directed.notAfter, 'DIRECTED_AUTHORIZATION_WINDOW_CLOSED');
  // Durable history, not an in-memory counter: a restart must not reset the rate cap.
  invariant(Array.isArray(recentIntents), 'DIRECTED_INTENT_HISTORY_REQUIRED');
  invariant(!recentIntents.some(row => row.id === intent.id), 'DIRECTED_INTENT_ID_ALREADY_USED');
  const inWindow = recentIntents.filter(row => Number.isFinite(row.createdAt) && row.createdAt > now - directed.windowMs);
  invariant(inWindow.length < directed.maximumIntentsPerWindow, 'DIRECTED_INTENT_RATE_LIMIT_REACHED');
  return { status: 'DIRECTED_INTENT_VALID', clientOrderId: clientId('directed', intent.id) };
}

// Same market-evidence, account and precision standard as the strategy entry path.
// The only difference is where the symbol, size and stop distance come from.
export function prepareDirectedEntry(input, now = Date.now()) {
  try {
    const { intent, authorization, bbo, tick, account, rule, trialLimits, recentIntents } = input;
    const parsed = validDirectedAuthorization(authorization, hash(trialLimits));
    invariant(parsed && parsed.enabled && parsed.directedEnabled, 'DIRECTED_EXECUTION_DISARMED');
    invariant(input.killSwitchEngaged !== true, 'OWNER_KILL_SWITCH_ENGAGED');
    const check = validateDirectedIntent(intent, parsed.directed, recentIntents, now);

    invariant(account?.reconciled === true && account.canTrade === true && account.dualSidePosition === true
      && account.multiAssetsMargin === false, 'ACCOUNT_NOT_RECONCILED_HEDGE_SINGLE_ASSET');
    invariant(fresh(Date.parse(account.observedAt), now, 5000) && account.userStreamConnected === true, 'ACCOUNT_OR_USER_STREAM_STALE');
    invariant(input.diskReady === true && input.singleWriter === true && input.noUnknownOrders === true, 'INFRASTRUCTURE_GATE_CLOSED');
    invariant(input.noExistingSymbolPosition === true, 'POSITION_ALREADY_OPEN_FOR_SYMBOL');

    for (const row of [bbo, tick]) {
      invariant(row?.symbol === intent.symbol && fresh(row.marketTime, now, 2000) && fresh(row.receivedAt, now, 2000), 'FORWARD_MARKET_EVIDENCE_STALE');
      invariant(Number.isFinite(row.connectedAt) && row.receivedAt >= row.connectedAt && row.continuity === true && row.persisted === true, 'FORWARD_MARKET_EVIDENCE_INCOMPLETE');
      invariant(Number.isSafeInteger(row.sequence) && row.sequence > 0, 'FORWARD_SEQUENCE_INVALID');
    }
    invariant(String(bbo.updateId).match(/^\d+$/) && BigInt(bbo.updateId) > 0n, 'BBO_UPDATE_ID_REQUIRED');
    const bid = units(bbo.bid), ask = units(bbo.ask);
    invariant(bid > 0n && ask >= bid && units(tick.price) > 0n, 'MARKET_PRICES_INVALID');
    const entry = intent.direction === 'LONG' ? ask : bid;

    const trial = evaluateTrialBudget(account, trialLimits, now);
    invariant(trial.status === 'TRIAL_BUDGET_AVAILABLE_ONLY', trial.reason ?? trial.status);
    invariant(fresh(input.markObservedAt, now, 2000), 'MARK_PRICE_STALE');
    const fee = units(input.takerFeeRate), slip = units(input.adverseSlippageRate);
    invariant(fresh(input.feeObservedAt, now, 300000) && input.feeEvidenceComplete === true
      && fee > 0n && fee < units('0.01') && slip > 0n && slip < units('0.01'), 'FEE_SLIPPAGE_EVIDENCE_INVALID');

    const offset = entry * BigInt(intent.stopDistanceBps) / BPS;
    const stop = intent.direction === 'LONG' ? entry - offset : entry + offset;
    const distance = intent.direction === 'LONG' ? entry - stop : stop - entry;
    invariant(distance > 0n, 'STOP_NOT_PROTECTIVE');
    const costs = (entry * (fee + slip) + stop * (fee + slip) + SCALE - 1n) / SCALE;
    const perUnit = distance + costs;

    const availableMargin = units(account.availableBalanceUsdt);
    const maximumLeverage = trialLimits.maximumLeverage ?? 1;
    invariant(Number.isInteger(input.observedLeverage) && input.observedLeverage >= 1
      && input.observedLeverage <= maximumLeverage, 'MARGIN_CAPACITY_MISSING');
    invariant(highLeverageStopSafety({ leverage: input.observedLeverage, marginType: input.observedMarginType,
      entry, riskPerUnit: perUnit }), 'ISOLATED_HIGH_LEVERAGE_STOP_UNSAFE');
    const leverage = BigInt(input.observedLeverage);
    const marginPerUnit = (entry + leverage - 1n) / leverage + (entry * fee + SCALE - 1n) / SCALE;
    // The directed notional competes inside the shared trial budget. No private quota.
    const notionalBudget = min(units(intent.notionalUsdt), units(trial.remainingGrossNotionalUsdt));
    const riskBudget = units(trial.maximumPlannedLossPerTradeUsdt);
    const quantity = min(notionalBudget * SCALE / entry, riskBudget * SCALE / perUnit, availableMargin * SCALE / marginPerUnit);
    invariant(quantity > 0n, 'DIRECTED_SIZE_ZERO_AFTER_CAPS');

    const calibration = calibrateEntryPlan({ symbol: intent.symbol, direction: intent.direction, orderType: 'LIMIT',
      price: decimal(entry), quantity: decimal(quantity), stopPrice: decimal(stop), workingType: 'CONTRACT_PRICE',
      lastPrice: tick.price, markPrice: input.markPrice, bid: bbo.bid, ask: bbo.ask,
      marketObservedAt: new Date(now).toISOString(), feeSlippagePerUnit: decimal(costs), riskBudget: decimal(riskBudget) },
      freshRules(rule, intent.symbol, now), now);
    // MIN_NOTIONAL_REJECTED_NO_UPSIZE surfaces here: skip below the venue minimum, never upsize.
    invariant(calibration.status === 'CALIBRATED_PRECISION_ONLY', calibration.reason ?? 'PRECISION_REJECTED');

    const plan = { schema: 'S2_VALIDATED_ENTRY_V1', source: 'DIRECTED', id: intent.id, symbol: intent.symbol,
      direction: intent.direction, revision: REVISION, price: calibration.price, quantity: calibration.quantity,
      stopPrice: calibration.stopPrice, plannedRiskUsdt: calibration.estimatedRisk, budgetUsdt: decimal(riskBudget),
      initialRiskPerUnit: decimal(perUnit), takerFeeRate: input.takerFeeRate, adverseSlippageRate: input.adverseSlippageRate,
      trialLimitsFingerprint: hash(trialLimits), notionalBudgetUsdt: decimal(notionalBudget),
      holdMs: intent.holdMs, stopDistanceBps: intent.stopDistanceBps, requestedBy: intent.requestedBy,
      createdAt: now, validUntil: now + 1000,
      evidence: { bboSequence: bbo.sequence, tickSequence: tick.sequence, bboUpdateId: String(bbo.updateId),
        accountObservedAt: account.observedAt, ruleObservedAt: calibration.rulesObservedAt,
        authorizationDigest: hash({ directed: parsed.directed }) } };
    return { status: 'VALIDATED_OFFLINE_NOT_ACTIVATED', clientOrderId: check.clientOrderId, plan: { ...plan, fingerprint: hash(plan) } };
  } catch (error) { return { status: 'REJECTED', reason: error.message }; }
}

export function directedEntryRequest(plan, clientOrderId) {
  const params = { symbol: plan.symbol, side: entrySide(plan.direction), positionSide: plan.direction, type: 'LIMIT',
    quantity: plan.quantity, price: plan.price, timeInForce: 'IOC', newClientOrderId: clientOrderId, newOrderRespType: 'RESULT' };
  validateMutation('POST', '/fapi/v1/order', params);
  return Object.freeze({ kind: 'entry', planId: plan.id, intentId: clientOrderId, method: 'POST', path: '/fapi/v1/order', params: Object.freeze(params) });
}

// The clock starts at the terminal entry fill, not at intent creation and not at
// submission. A deferred exit keeps the protective stop in place; it never becomes
// a silent hold, and OVERDUE never clears itself.
export function evaluateTimedExit(state, now = Date.now()) {
  try {
    const { plan, entry, position } = state;
    invariant(plan?.source === 'DIRECTED' && Number.isSafeInteger(plan.holdMs) && plan.holdMs >= 60000, 'DIRECTED_PLAN_REQUIRED');
    if (position?.status === 'CLOSED') return { status: position.closedBy === 'STOP' ? 'CLOSED_BY_STOP' : 'CLOSED', exitReason: position.closedBy ?? null };
    invariant(entry && entry.terminal === true, 'ENTRY_NOT_TERMINAL');
    const filled = units(entry.executedQty ?? '0');
    if (filled === 0n) return { status: 'NO_FILL', exitReason: 'NO_FILL' };
    invariant(Number.isFinite(entry.filledAt) && entry.filledAt <= now, 'FILL_TIME_INVALID');
    // Protection must exist before any hold is counted as legitimate.
    if (state.protectionInPlace !== true) return { status: 'EMERGENCY_CLOSE_REQUIRED', exitReason: 'PROTECTION_MISSING', dueAt: entry.filledAt + plan.holdMs };
    const dueAt = entry.filledAt + plan.holdMs;
    if (now < dueAt) return { status: 'HOLDING', dueAt, remainingMs: dueAt - now };
    const blocked = [];
    if (state.snapshotFresh !== true) blocked.push('ACCOUNT_SNAPSHOT_STALE');
    if (state.userStreamConnected !== true) blocked.push('USER_STREAM_DISCONNECTED');
    if (state.noUnknownOrders !== true) blocked.push('UNKNOWN_ORDER_PRESENT');
    if (state.exitPending === true) blocked.push('EXIT_ALREADY_PENDING');
    if (!blocked.length) return { status: 'TIMED_EXIT_DUE', exitReason: 'TIMED_EXIT', dueAt, quantity: decimal(units(position?.quantity ?? '0')) };
    const overdueAfter = dueAt + Math.max(plan.holdMs, OVERDUE_FLOOR_MS);
    return { status: now >= overdueAfter ? 'TIMED_EXIT_OVERDUE' : 'TIMED_EXIT_DEFERRED', dueAt, overdueAfter, blockedBy: blocked, autoClears: false };
  } catch (error) { return { status: 'REJECTED', reason: error.message }; }
}

export function directedCloseRequest(plan, quantity, intentId) {
  const params = { symbol: plan.symbol, side: closeSide(plan.direction), positionSide: plan.direction, type: 'MARKET',
    quantity, newClientOrderId: intentId, newOrderRespType: 'RESULT' };
  validateMutation('POST', '/fapi/v1/order', params);
  return Object.freeze({ kind: 'close', planId: plan.id, intentId, method: 'POST', path: '/fapi/v1/order', params: Object.freeze(params) });
}

// Exits are never gated by directedEnabled or the kill switch: disarming must not
// strand an open position. Only new directed entries are blocked.
export function createDirectedMutationPermit({ trialLimits, load, isDirectedEntry }) {
  const limitsDigest = hash(trialLimits);
  return async operation => {
    try {
      validateMutation(operation.method, operation.pathname, operation.params);
      const parsed = validDirectedAuthorization(await load(), limitsDigest);
      if (!parsed || parsed.enabled !== true) return false;
      return isDirectedEntry(operation) ? parsed.directedEnabled === true : true;
    } catch { return false; }
  };
}
