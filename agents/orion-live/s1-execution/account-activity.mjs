import { units, decimal } from '../../../lib/s1-precision.mjs';
import { signedUnits, signedDecimal } from './position-ledger.mjs';
import { UNIVERSE, hash, invariant, entrySide, closeSide } from './common.mjs';

const identifier = value => {
  invariant((typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,24}$/.test(String(value)), 'ACTIVITY_IDENTIFIER_INVALID');
  return String(value);
};
const timestamp = value => { invariant(Number.isSafeInteger(value) && value > 0, 'ACTIVITY_TIME_INVALID'); return value; };
const directions = new Set(['LONG', 'SHORT', 'BOTH']);
function tradeFact(row, symbol) {
  invariant(row.symbol === symbol && directions.has(row.positionSide) && ['BUY', 'SELL'].includes(row.side), 'ACTIVITY_TRADE_SCOPE_MISMATCH');
  invariant(typeof row.commissionAsset === 'string' && /^[A-Z0-9]{1,20}$/.test(row.commissionAsset), 'ACTIVITY_FEE_ASSET_INVALID');
  invariant(units(row.qty) > 0n && units(row.price) > 0n, 'ACTIVITY_TRADE_QUANTITY_INVALID');
  return { symbol, tradeId: identifier(row.id), orderId: identifier(row.orderId), direction: row.positionSide, side: row.side,
    quantity: decimal(units(row.qty)), price: decimal(units(row.price)), fee: signedDecimal(signedUnits(row.commission)), feeAsset: row.commissionAsset,
    realizedPnlUsdt: signedDecimal(signedUnits(row.realizedPnl)), time: timestamp(row.time) };
}
function forceFact(row, symbol, cause) {
  invariant(row.symbol === symbol && directions.has(row.positionSide) && ['BUY', 'SELL'].includes(row.side), 'ACTIVITY_FORCE_SCOPE_MISMATCH');
  invariant(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(row.status), 'ACTIVITY_FORCE_STATUS_INVALID');
  const original = units(row.origQty), executed = units(row.executedQty);
  invariant(executed <= original, 'ACTIVITY_FORCE_QUANTITY_INVALID');
  // Cause comes from the explicitly filtered signed endpoint, never a client ID
  // prefix. No client ID, free-form venue message or credential-bearing field is retained.
  return { symbol, orderId: identifier(row.orderId), direction: row.positionSide, side: row.side, cause, status: row.status,
    originalQuantity: decimal(original), executedQuantity: decimal(executed), time: timestamp(row.time) };
}

// A time-bounded endpoint may return its newest page. Bisect full pages instead
// of advancing an ID/time from that page and silently skipping older records.
// A full single-millisecond slice is explicitly unresolvable with this API.
async function boundedSlices(request, { symbol, startTime, endTime, path, limit, extra = {}, normalize, key, maximumRows }) {
  const slices = [[startTime, endTime]], facts = new Map(), observed = new Map();
  while (slices.length) {
    const [start, end] = slices.pop();
    const rows = await request(path, { symbol, startTime: start, endTime: end, limit, ...extra });
    invariant(Array.isArray(rows) && rows.length <= limit, 'ACTIVITY_RESPONSE_SHAPE_INVALID');
    const batch = new Map();
    for (const raw of rows) {
      const row = normalize(raw);
      invariant(row.time >= start && row.time <= end, 'ACTIVITY_RECORD_OUTSIDE_SLICE');
      const id = key(row), prior = batch.get(id);
      invariant(!prior || hash(prior) === hash(row), 'ACTIVITY_DUPLICATE_CONFLICT'); batch.set(id, row);
      invariant(!observed.has(id) || hash(observed.get(id)) === hash(row), 'ACTIVITY_RECORD_CHANGED_DURING_READ'); observed.set(id, row);
      invariant(observed.size <= maximumRows, 'ACTIVITY_ROW_BUDGET_EXHAUSTED');
    }
    if (rows.length === limit) {
      invariant(start < end, 'ACTIVITY_SATURATED_MILLISECOND');
      const middle = start + Math.floor((end - start) / 2);
      slices.push([middle + 1, end], [start, middle]);
      continue;
    }
    for (const [id, row] of batch) {
      const prior = facts.get(id);
      invariant(!prior || hash(prior) === hash(row), 'ACTIVITY_HISTORY_CONFLICT'); facts.set(id, row);
      invariant(facts.size <= maximumRows, 'ACTIVITY_ROW_BUDGET_EXHAUSTED');
    }
  }
  invariant([...observed.keys()].every(id => facts.has(id)), 'ACTIVITY_OBSERVED_RECORD_DISAPPEARED');
  return [...facts.values()].sort((a, b) => a.time - b.time || (BigInt(key(a)) < BigInt(key(b)) ? -1 : BigInt(key(a)) > BigInt(key(b)) ? 1 : 0));
}

export async function readAccountActivity(transport, { symbol, startTime, endTime, now = Date.now, maximumRequests = 64, maximumRows = 5000 }) {
  invariant(UNIVERSE.includes(symbol), 'ACTIVITY_SYMBOL_FORBIDDEN');
  invariant(Number.isSafeInteger(startTime) && Number.isSafeInteger(endTime) && startTime > 0 && endTime >= startTime
    && endTime - startTime <= 7 * 86400000 && endTime <= now() && now() - startTime <= 7 * 86400000, 'ACTIVITY_WINDOW_INVALID');
  invariant(Number.isInteger(maximumRequests) && maximumRequests >= 3 && maximumRequests <= 64
    && Number.isInteger(maximumRows) && maximumRows > 0 && maximumRows <= 5000, 'ACTIVITY_BOUNDS_INVALID');
  let requests = 0;
  const initial = new Map();
  const requestKey = (path, params) => JSON.stringify([path, params.symbol, params.startTime, params.endTime, params.limit, params.autoCloseType ?? null]);
  if (typeof transport.readInitialWindow === 'function') {
    // Count all three admitted reads up front, including pages which a later
    // parse/bisection failure never consumes. Extra slices retain the same
    // remaining request budget; prefetched pages are not free hidden requests.
    requests = 3;
    const pages = await transport.readInitialWindow({ symbol, startTime, endTime });
    invariant(Array.isArray(pages) && pages.length === 3, 'ACTIVITY_RESPONSE_SHAPE_INVALID');
    const descriptors = [['/fapi/v1/userTrades', 1000, null], ['/fapi/v1/forceOrders', 100, 'LIQUIDATION'], ['/fapi/v1/forceOrders', 100, 'ADL']];
    descriptors.forEach(([path, limit, autoCloseType], i) => {
      invariant(Array.isArray(pages[i]) && pages[i].length <= limit, 'ACTIVITY_RESPONSE_SHAPE_INVALID');
      initial.set(requestKey(path, { symbol, startTime, endTime, limit, autoCloseType }), pages[i]);
    });
  }
  const request = async (path, params) => {
    const key = requestKey(path, params);
    if (initial.has(key)) { const rows = initial.get(key); initial.delete(key); return rows; }
    invariant(++requests <= maximumRequests, 'ACTIVITY_REQUEST_BUDGET_EXHAUSTED');
    return transport.request('GET', path, params);
  };
  const trades = await boundedSlices(request, { symbol, startTime, endTime, path: '/fapi/v1/userTrades', limit: 1000,
    normalize: row => tradeFact(row, symbol), key: row => row.tradeId, maximumRows });
  const forced = [];
  for (const cause of ['LIQUIDATION', 'ADL']) forced.push(...await boundedSlices(request, { symbol, startTime, endTime, path: '/fapi/v1/forceOrders', limit: 100,
    extra: { autoCloseType: cause }, normalize: row => forceFact(row, symbol, cause), key: row => row.orderId, maximumRows }));
  invariant(trades.length + forced.length <= maximumRows, 'ACTIVITY_ROW_BUDGET_EXHAUSTED');
  const ids = new Set();
  for (const row of forced) { invariant(!ids.has(row.orderId), 'ACTIVITY_FORCE_CAUSE_CONFLICT'); ids.add(row.orderId); }
  const snapshot = { schema: 'S1_ACCOUNT_ACTIVITY_WINDOW_V1', symbol, startTime, endTime, observedAt: now(), requests,
    coverage: 'BOUNDED_REST_WINDOW_FETCHED_NOT_ATOMIC_OR_FINAL', trades, forced };
  return { ...snapshot, fingerprint: hash(snapshot) };
}

export function reviewAccountActivity(snapshot, { kernel, book }) {
  invariant(snapshot?.schema === 'S1_ACCOUNT_ACTIVITY_WINDOW_V1' && snapshot.fingerprint === hash({ ...snapshot, fingerprint: undefined }), 'ACTIVITY_WINDOW_FINGERPRINT_MISMATCH');
  const ownership = new Map(), forced = new Map(snapshot.forced.map(row => [row.orderId, row]));
  const register = (orderId, planId, role) => {
    const id = identifier(orderId), prior = ownership.get(id);
    invariant(!prior || (prior.planId === planId && prior.role === role), 'ACTIVITY_ORDER_OWNERSHIP_CONFLICT'); ownership.set(id, { planId, role });
  };
  for (const intent of kernel.intents.values()) {
    const plan = kernel.plans.get(intent.planId);
    if (!plan || plan.symbol !== snapshot.symbol || intent.method !== 'POST') continue;
    // A recovery-only ABSENT_VERIFIED record proves that dispatch never
    // reached Binance. It has no venue order ID and must not be registered as
    // exchange ownership. Any actual trade in this window remains unattributed
    // and therefore still fails closed below.
    if (intent.result?.status === 'ABSENT_VERIFIED') continue;
    if (['entry', 'close'].includes(intent.kind) && intent.result?.orderId !== undefined) register(intent.result.orderId, plan.id, intent.kind === 'entry' ? 'ENTRY' : 'EXIT');
    if (intent.kind === 'stop' && intent.result?.actualOrderId && String(intent.result.actualOrderId) !== '0') register(intent.result.actualOrderId, plan.id, 'PROTECTIVE_EXIT');
  }
  const issues = [], facts = [];
  for (const trade of snapshot.trades) {
    const own = ownership.get(trade.orderId), force = forced.get(trade.orderId);
    invariant(!(own && force), 'ACTIVITY_FORCED_ORDER_OWNERSHIP_CONFLICT');
    let classification = force?.cause ?? 'UNATTRIBUTED_TRADE', planId = null;
    if (own) {
      const plan = kernel.plans.get(own.planId);
      invariant(trade.direction === plan.direction && trade.side === (own.role === 'ENTRY' ? entrySide(plan.direction) : closeSide(plan.direction)), 'ACTIVITY_OWNED_TRADE_SIDE_MISMATCH');
      classification = `OWNED_${own.role}`; planId = own.planId;
      const recorded = book.fills.get(`${trade.symbol}:${trade.tradeId}`);
      if (!recorded) issues.push({ code: 'OWNED_TRADE_REQUIRES_LEDGER_RECONCILIATION', tradeId: trade.tradeId });
      else {
        const fill = recorded.fill;
        invariant(recorded.planId === planId && recorded.role === (own.role === 'ENTRY' ? 'ENTRY' : 'EXIT')
          && String(fill.orderId) === trade.orderId && fill.direction === trade.direction && fill.side === trade.side
          && fill.quantity === trade.quantity && fill.price === trade.price && fill.commission === trade.fee
          && trade.feeAsset === 'USDT' && fill.realizedPnl === trade.realizedPnlUsdt && fill.time === trade.time, 'ACTIVITY_RECORDED_TRADE_CONFLICT');
      }
    } else {
      // Binance assigns a separate regular order ID only when a conditional
      // stop triggers. The durable algo can still be recorded as NEW without
      // actualOrderId while userTrades already exposes that child fill. Defer
      // this exact same-side exit race to lifecycle reconciliation; it must
      // hydrate the algo and record the fill before this review may clear.
      const potential = [...kernel.intents.values()].filter(intent => {
        const plan = kernel.plans.get(intent.planId), position = book.positions.get(intent.planId);
        return intent.method === 'POST' && intent.kind === 'stop' && intent.result?.algoStatus === 'NEW'
          && !intent.result?.actualOrderId && plan?.symbol === trade.symbol && plan.direction === trade.direction
          && position?.status === 'OPEN' && !book.control.get(`retired:${intent.planId}`)
          && position.openedAt <= trade.time && units(trade.quantity) <= units(position.quantity)
          && trade.side === closeSide(plan.direction);
      });
      if (!force && potential.length === 1) {
        classification = 'POTENTIAL_OWNED_PROTECTIVE_EXIT'; planId = potential[0].planId;
        issues.push({ code: 'POTENTIAL_PROTECTIVE_TRADE_REQUIRES_LIFECYCLE_RECONCILIATION', tradeId: trade.tradeId });
      } else issues.push({ code: force ? 'FORCED_EXIT_REVIEW_REQUIRED' : 'UNATTRIBUTED_TRADE_REVIEW_REQUIRED', tradeId: trade.tradeId });
    }
    if (force) invariant(force.direction === trade.direction && force.side === trade.side, 'ACTIVITY_FORCE_TRADE_SIDE_MISMATCH');
    facts.push({ ...trade, classification, planId });
  }
  for (const row of snapshot.forced) {
    const fills = facts.filter(f => f.orderId === row.orderId);
    const quantity = fills.reduce((sum, f) => sum + units(f.quantity), 0n);
    // A forced order may predate a fill window or still be settling. A mismatch
    // is a review issue, never an invented missing fill or a cleared incident.
    if (quantity !== units(row.executedQuantity)) issues.push({ code: 'FORCED_ORDER_FILL_COVERAGE_UNRESOLVED', orderId: row.orderId });
    issues.push({ code: 'FORCED_ORDER_REVIEW_REQUIRED', orderId: row.orderId, cause: row.cause });
  }
  const netQuantity = facts.reduce((sum, f) => sum + (f.side === 'BUY' ? 1n : -1n) * units(f.quantity), 0n);
  const result = { schema: 'S1_ACCOUNT_ACTIVITY_REVIEW_V1', symbol: snapshot.symbol, startTime: snapshot.startTime, endTime: snapshot.endTime,
    observedAt: snapshot.observedAt, windowFingerprint: snapshot.fingerprint, facts, forced: snapshot.forced, issues,
    status: issues.length ? 'ACTIVITY_REVIEW_REQUIRED' : 'NO_UNRECONCILED_ACTIVITY_IN_FETCHED_WINDOW',
    signedTradeQuantity: signedDecimal(netQuantity), recoveryApproved: false, mutationAllowed: false,
    coverage: snapshot.coverage };
  return { ...result, fingerprint: hash(result) };
}

// Separate account evidence: never project these facts into strategy positions,
// R22 stages, strategy PnL or promotion statistics. Append facts before the report
// marker; a crash can leave a partial batch, never a false completed report.
export class AccountActivityLedger {
  constructor(journal, { maximumBytes = 16 * 1024 ** 2, pauseEntries } = {}) {
    invariant(Number.isInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 16 * 1024 ** 2, 'ACTIVITY_PROJECTION_LIMIT_INVALID');
    this.journal = journal; this.maximumBytes = maximumBytes; this.pauseEntries = pauseEntries; this.bytes = 0;
    this.facts = new Map(); this.parts = new Map(); this.reports = new Map(); this.writing = false;
    for (const event of journal.events) this.project(event);
  }
  project(event) {
    if (!['ACCOUNT_ACTIVITY_FACT', 'ACCOUNT_ACTIVITY_REVIEW_PART', 'ACCOUNT_ACTIVITY_REPORT'].includes(event.type)) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    invariant(this.bytes + bytes <= this.maximumBytes, 'ACTIVITY_PROJECTION_CAPACITY_EXHAUSTED'); this.bytes += bytes;
    if (event.type === 'ACCOUNT_ACTIVITY_FACT') {
      invariant(!this.facts.has(event.key), 'ACTIVITY_DUPLICATE_COMMITTED_FACT'); this.facts.set(event.key, event.fact);
    }
    if (event.type === 'ACCOUNT_ACTIVITY_REVIEW_PART') {
      const key = `${event.fingerprint}:${event.index}`;
      invariant(!this.parts.has(key), 'ACTIVITY_DUPLICATE_REVIEW_PART'); this.parts.set(key, event);
    }
    if (event.type === 'ACCOUNT_ACTIVITY_REPORT') {
      invariant(!this.reports.has(event.fingerprint), 'ACTIVITY_DUPLICATE_REPORT');
      this.materialize(event); this.reports.set(event.fingerprint, event);
    }
  }
  materialize(report) {
    const groups = { facts: [], forced: [], issues: [] };
    for (let index = 0; index < report.partCount; index++) {
      const part = this.parts.get(`${report.fingerprint}:${index}`);
      invariant(part && Object.hasOwn(groups, part.group), 'ACTIVITY_REPORT_PART_MISSING');
      groups[part.group].push(...part.rows);
    }
    groups.facts = groups.facts.map(ref => {
      const fact = this.facts.get(`${report.summary.symbol}:${ref.tradeId}`);
      invariant(fact, 'ACTIVITY_REPORT_FACT_MISSING'); return { ...fact, classification: ref.classification, planId: ref.planId };
    });
    const review = { ...report.summary, ...groups };
    invariant(hash(review) === report.fingerprint, 'ACTIVITY_REPORT_RECONSTRUCTION_MISMATCH');
    return { ...review, fingerprint: report.fingerprint };
  }
  async append(event) {
    invariant(this.bytes + Buffer.byteLength(JSON.stringify(event)) <= this.maximumBytes, 'ACTIVITY_PROJECTION_CAPACITY_EXHAUSTED');
    await this.journal.append(event); this.project(event);
  }
  async record(review, book) {
    invariant(!this.writing, 'ACTIVITY_CONCURRENT_COMMIT'); this.writing = true;
    try {
      invariant(review?.schema === 'S1_ACCOUNT_ACTIVITY_REVIEW_V1' && review.fingerprint === hash({ ...review, fingerprint: undefined }), 'ACTIVITY_REVIEW_FINGERPRINT_MISMATCH');
      review = structuredClone(review);
      if (this.reports.has(review.fingerprint)) return this.reports.get(review.fingerprint);
      if (review.issues.length) {
        invariant(typeof this.pauseEntries === 'function', 'ACTIVITY_ENTRY_PAUSE_PORT_REQUIRED');
        this.pauseEntries('ACCOUNT_ACTIVITY_REVIEW_REQUIRED');
        await book.setControl('entryIncident', 'ACCOUNT_ACTIVITY_REVIEW_REQUIRED');
      }
      for (const fact of review.facts) {
        const key = `${fact.symbol}:${fact.tradeId}`, previous = this.facts.get(key);
        // Classification can become better informed, but immutable exchange
        // trade values cannot change. Keep classification in each review, not
        // in the immutable account trade fact.
        const raw = { ...fact }; delete raw.classification; delete raw.planId;
        if (previous) { invariant(hash(previous) === hash(raw), 'ACTIVITY_HISTORICAL_TRADE_CONFLICT'); continue; }
        invariant(this.facts.size < 100000, 'ACTIVITY_PROJECTION_CAPACITY_EXHAUSTED');
        const event = { type: 'ACCOUNT_ACTIVITY_FACT', key, fact: raw };
        await this.append(event);
      }
      invariant(this.reports.size < 10000, 'ACTIVITY_REPORT_CAPACITY_EXHAUSTED');
      let index = 0;
      for (const [group, rows] of Object.entries({ facts: review.facts.map(({ tradeId, classification, planId }) => ({ tradeId, classification, planId })), forced: review.forced, issues: review.issues })) {
        for (let offset = 0; offset < rows.length; offset += 100) {
          const event = { type: 'ACCOUNT_ACTIVITY_REVIEW_PART', fingerprint: review.fingerprint, index: index++, group, rows: rows.slice(offset, offset + 100) };
          const prior = this.parts.get(`${event.fingerprint}:${event.index}`);
          if (prior) invariant(hash(prior) === hash(event), 'ACTIVITY_REVIEW_PART_CONFLICT');
          else await this.append(event);
        }
      }
      // Preserve property order for the content fingerprint when reconstructing.
      const summary = { ...review }; delete summary.fingerprint;
      summary.facts = []; summary.forced = []; summary.issues = [];
      const event = { type: 'ACCOUNT_ACTIVITY_REPORT', fingerprint: review.fingerprint, symbol: review.symbol,
        startTime: review.startTime, endTime: review.endTime, observedAt: review.observedAt, windowFingerprint: review.windowFingerprint,
        status: review.status, recoveryApproved: false, factCount: review.facts.length, forcedCount: review.forced.length,
        issueCount: review.issues.length, partCount: index, summary };
      this.materialize(event); await this.append(event); return event;
    } finally { this.writing = false; }
  }
}
