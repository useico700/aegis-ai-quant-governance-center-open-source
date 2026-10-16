// S1-only, side-effect-free decimal calibration. No network, credentials or submission.
// Fixed-point integers prevent binary-float remainders and scientific-notation order strings.
const SCALE = 10n ** 18n;
export const RULE_MAX_AGE_MS = 300000;
const fail = (condition, code) => { if (!condition) throw new Error(code); };
export function units(value) {
  const text = String(value);
  fail(text.length <= 90, 'DECIMAL_TOO_LONG');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  fail(match, 'INVALID_DECIMAL');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0);
  const power = 18 + exponent - fraction.length;
  fail(Number.isInteger(exponent) && power >= 0 && power <= 54, 'UNSUPPORTED_DECIMAL_SCALE');
  return BigInt(match[1] + fraction) * 10n ** BigInt(power);
}
export function decimal(value) {
  fail(typeof value === 'bigint' && value >= 0n, 'NEGATIVE_DECIMAL');
  const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}
const positive = value => { const x = units(value); fail(x > 0n, 'NON_POSITIVE_VALUE'); return x; };
const plain = value => decimal(units(value));
export function formatPrice(value, tick) {
  const places = (plain(tick).split('.')[1] ?? '').length;
  const [whole, fraction = ''] = plain(value).split('.');
  return fraction.length || places ? `${whole}.${fraction.padEnd(places, '0')}` : whole;
}
const range = (minimum, maximum, step) => {
  const result = { min: plain(minimum), max: decimal(positive(maximum)), step: decimal(positive(step)) };
  fail(units(result.max) >= units(result.min), 'INVALID_FILTER_RANGE');
  return result;
};
export function extractRules(info, symbol, observedAt) {
  fail(Array.isArray(info?.symbols), 'EXCHANGE_INFO_INVALID');
  const matches = info.symbols.filter(row => row.symbol === symbol);
  fail(matches.length === 1, 'SYMBOL_RULES_MISSING_OR_DUPLICATE');
  const row = matches[0];
  fail(row.quoteAsset === 'USDT' && row.marginAsset === 'USDT' && row.contractType === 'PERPETUAL' && row.status === 'TRADING', 'SYMBOL_NOT_TRADABLE_USDT_PERPETUAL');
  const filter = type => { const found = row.filters?.filter(item => item.filterType === type); fail(found?.length === 1, `FILTER_MISSING_OR_DUPLICATE_${type}`); return found[0]; };
  const price = filter('PRICE_FILTER'), lot = filter('LOT_SIZE'), market = filter('MARKET_LOT_SIZE'), notional = filter('MIN_NOTIONAL'), percent = filter('PERCENT_PRICE');
  return validateRules({ symbol, observedAt, venue: 'BINANCE_USDM_MAINNET', status: 'TRADING',
    price: range(price.minPrice, price.maxPrice, price.tickSize), lot: range(lot.minQty, lot.maxQty, lot.stepSize), marketLot: range(market.minQty, market.maxQty, market.stepSize),
    minNotional: decimal(positive(notional.notional)), multiplierUp: decimal(positive(percent.multiplierUp)), multiplierDown: decimal(positive(percent.multiplierDown)),
    orderTypes: row.orderTypes });
}
export function validateRules(rule) {
  fail(rule?.venue === 'BINANCE_USDM_MAINNET' && rule.status === 'TRADING' && /^[A-Z0-9]{2,20}USDT$/.test(rule.symbol), 'RULE_SCOPE_INVALID');
  fail(Number.isFinite(Date.parse(rule.observedAt)), 'RULE_TIMESTAMP_INVALID');
  const output = { symbol: rule.symbol, observedAt: new Date(rule.observedAt).toISOString(), venue: 'BINANCE_USDM_MAINNET', status: 'TRADING',
    price: range(rule.price?.min, rule.price?.max, rule.price?.step), lot: range(rule.lot?.min, rule.lot?.max, rule.lot?.step), marketLot: range(rule.marketLot?.min, rule.marketLot?.max, rule.marketLot?.step),
    minNotional: decimal(positive(rule.minNotional)), multiplierUp: decimal(positive(rule.multiplierUp)), multiplierDown: decimal(positive(rule.multiplierDown)),
    orderTypes: ['LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'].filter(type => rule.orderTypes?.includes(type)) };
  fail(units(output.multiplierDown) <= SCALE && units(output.multiplierUp) >= SCALE, 'INVALID_PERCENT_FILTER');
  return output;
}
export function freshRules(rule, symbol, now = Date.now()) {
  const valid = validateRules(rule), age = now - Date.parse(valid.observedAt);
  fail(valid.symbol === symbol, 'SYMBOL_RULE_MISMATCH');
  fail(Number.isFinite(now) && age >= -5000 && age <= RULE_MAX_AGE_MS, 'RULES_STALE');
  return valid;
}
export function align(value, filter, mode) {
  fail(['DOWN', 'UP', 'EXACT'].includes(mode), 'ROUNDING_MODE_INVALID');
  const raw = positive(value), min = units(filter.min), max = positive(filter.max), step = positive(filter.step);
  // Do not silently pull an out-of-range plan into the permitted price/quantity range.
  fail(raw >= min && raw <= max, 'FILTER_RANGE_REJECTED');
  const offset = raw - min, remainder = offset % step;
  if (mode === 'EXACT') fail(remainder === 0n, 'FILTER_STEP_REJECTED');
  const result = raw - remainder + (mode === 'UP' && remainder ? step : 0n);
  fail(result > 0n && result >= min && result <= max, 'ROUNDED_VALUE_OUT_OF_RANGE');
  return decimal(result);
}
export function referenceCalibration(price, rule, symbol, now = Date.now()) {
  try {
    const valid = freshRules(rule, symbol, now);
    const lower = align(price, valid.price, 'DOWN'), upper = align(price, valid.price, 'UP');
    return { status: 'REFERENCE_ONLY', lower, upper, tickSize: valid.price.step, quantityStep: valid.lot.step, marketQuantityStep: valid.marketLot.step, observedAt: valid.observedAt, executable: false };
  } catch (error) { return { status: 'UNAVAILABLE', reason: error.message, executable: false }; }
}
export function quoteView(quote, rule, symbol, now = Date.now()) {
  const valid = freshRules(rule, symbol, now);
  fail(quote?.symbol === symbol, 'QUOTE_SYMBOL_MISMATCH');
  const exchangeTime = Number(quote.time), age = now - exchangeTime;
  fail(Number.isFinite(exchangeTime) && age >= -5000 && age <= 90000, 'QUOTE_STALE');
  const bidPrice = align(quote.bidPrice, valid.price, 'EXACT'), askPrice = align(quote.askPrice, valid.price, 'EXACT');
  fail(positive(bidPrice) <= positive(askPrice), 'CROSSED_BOOK');
  return { symbol, status: 'QUOTED', bidPrice, askPrice, exchangeTime: new Date(exchangeTime).toISOString(), observedAt: new Date(now).toISOString(), tickSize: valid.price.step, executionQualified: false };
}
export function alignTrigger(price, rule, direction, purpose, referencePrice, now = Date.now()) {
  const valid = freshRules(rule, rule?.symbol, now);
  fail(['LONG', 'SHORT'].includes(direction) && ['STOP', 'TAKE_PROFIT'].includes(purpose), 'TRIGGER_PURPOSE_INVALID');
  // LONG stop up / SHORT stop down tightens protection. TP rounds towards the market.
  const up = purpose === 'STOP' ? direction === 'LONG' : direction === 'SHORT';
  const result = align(price, valid.price, up ? 'UP' : 'DOWN');
  const ref = positive(referencePrice), raw = positive(price), adjusted = positive(result);
  const below = purpose === 'STOP' ? direction === 'LONG' : direction === 'SHORT';
  fail(below ? raw < ref && adjusted < ref : raw > ref && adjusted > ref, 'TRIGGER_CROSSED_REFERENCE');
  return result;
}
export function calibrateEntryPlan(plan, rule, now = Date.now()) {
  try {
    const valid = freshRules(rule, plan?.symbol, now);
    fail(['LONG', 'SHORT'].includes(plan.direction), 'DIRECTION_REQUIRED');
    fail(['LIMIT', 'MARKET'].includes(plan.orderType) && valid.orderTypes.includes(plan.orderType) && valid.orderTypes.includes('STOP_MARKET'), 'ORDER_TYPE_UNSUPPORTED');
    const age = now - Date.parse(plan.marketObservedAt);
    fail(Number.isFinite(age) && age >= -1000 && age <= 5000, 'MARKET_REFERENCE_STALE');
    fail(['MARK_PRICE', 'CONTRACT_PRICE'].includes(plan.workingType), 'WORKING_TYPE_REQUIRED');
    const mark = positive(plan.markPrice), bid = positive(plan.bid), ask = positive(plan.ask);
    fail(bid <= ask, 'CROSSED_BOOK');
    const entry = plan.orderType === 'LIMIT' ? align(plan.price, valid.price, plan.direction === 'LONG' ? 'DOWN' : 'UP') : decimal(plan.direction === 'LONG' ? ask : bid);
    if (plan.orderType === 'LIMIT') fail(plan.direction === 'LONG' ? positive(entry) * SCALE <= mark * units(valid.multiplierUp) : positive(entry) * SCALE >= mark * units(valid.multiplierDown), 'PERCENT_PRICE_REJECTED');
    const lot = plan.orderType === 'MARKET' ? valid.marketLot : valid.lot;
    const quantity = align(plan.quantity, lot, 'DOWN');
    // Both the intended entry and attached market protection must support this quantity.
    align(quantity, valid.lot, 'EXACT'); align(quantity, valid.marketLot, 'EXACT');
    const triggerReference = plan.workingType === 'MARK_PRICE' ? decimal(mark) : decimal(positive(plan.lastPrice));
    const stopPrice = alignTrigger(plan.stopPrice, valid, plan.direction, 'STOP', triggerReference, now);
    const rawEntry = plan.orderType === 'LIMIT' ? positive(plan.price) : positive(entry), rawStop = positive(plan.stopPrice), e = positive(entry), stop = positive(stopPrice);
    const rawDistance = plan.direction === 'LONG' ? rawEntry - rawStop : rawStop - rawEntry;
    const distance = plan.direction === 'LONG' ? e - stop : stop - e;
    fail(rawDistance > 0n && distance > 0n && distance <= rawDistance, 'ROUNDING_WIDENED_OR_INVALIDATED_RISK');
    const q = positive(quantity), costs = units(plan.feeSlippagePerUnit), budget = positive(plan.riskBudget);
    const riskScaled = (distance + costs) * q;
    fail(riskScaled <= budget * SCALE, 'RISK_BUDGET_EXCEEDED');
    const notionalPrice = plan.orderType === 'MARKET' ? mark : e;
    fail(notionalPrice * q >= positive(valid.minNotional) * SCALE, 'MIN_NOTIONAL_REJECTED_NO_UPSIZE');
    return { status: 'CALIBRATED_PRECISION_ONLY', symbol: valid.symbol, direction: plan.direction, orderType: plan.orderType, ...(plan.orderType === 'LIMIT' ? { price: entry } : {}),
      referenceEntryPrice: entry, quantity, stopPrice, workingType: plan.workingType, estimatedRisk: decimal((riskScaled + SCALE - 1n) / SCALE),
      rulesObservedAt: valid.observedAt, executable: false, submissionAllowed: false,
      remainingExecutionGates: ['OWNER_AUTHORIZATION', 'ACCOUNT_AND_MARGIN', 'EVENT_GATE', 'SIGNAL_AND_TICK_BBO', 'CURRENT_EXCHANGE_ORDER_LIMITS', 'IMMEDIATE_PRE_SUBMISSION_RECHECK'] };
  } catch (error) { return { status: 'REJECTED', reason: error.message, executable: false, submissionAllowed: false }; }
}
