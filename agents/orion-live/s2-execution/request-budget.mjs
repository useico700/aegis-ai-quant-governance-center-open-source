import { invariant } from './common.mjs';

export const BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE = 2400;

// S1 and S2 share one production egress IP. Each domain owns half of the
// exchange-advertised request budget while response headers enforce the full
// IP-wide Binance ceiling across both domains.
export const READ_REQUEST_BUDGET_MAXIMUM_WEIGHT = 1200;

// State is persisted before dispatch, including uncertain requests and server
// cooling-off periods. The IP ceiling matches Binance exchangeInfo; protected
// account-read headroom is reserved inside each execution domain.
export class ReadRequestBudget {
  constructor({ load = () => null, save = () => {}, now = Date.now, maximumWeight = 900, ipCeiling = BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE, maximumConcurrent = 8 } = {}) {
    Object.assign(this, { load, save, now, maximumWeight, ipCeiling, maximumConcurrent });
    invariant(Number.isInteger(maximumWeight) && maximumWeight > 0 && maximumWeight <= READ_REQUEST_BUDGET_MAXIMUM_WEIGHT && Number.isInteger(ipCeiling) && ipCeiling > 0 && ipCeiling <= BINANCE_USDM_REQUEST_WEIGHT_PER_MINUTE && Number.isInteger(maximumConcurrent) && maximumConcurrent > 0 && maximumConcurrent <= 8, 'READ_BUDGET_LIMITS_INVALID');
    this.inFlight = 0; this.pendingWeight = 0; this.failed = false;
    this.state = load() ?? { version: 1, lastAt: now(), blockedUntil: 0, blocks: [], ipAt: 0, ipUsed: 0, ipWindow: 0, requests: 0, throttles: 0 };
    const s = this.state;
    invariant(s.version === 1 && Array.isArray(s.blocks) && s.blocks.length <= 14 && s.blocks.every(b => Number.isSafeInteger(b.at) && Number.isSafeInteger(b.weight) && b.weight >= 0)
      && ['lastAt', 'blockedUntil', 'ipAt', 'ipUsed', 'ipWindow', 'requests', 'throttles'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0), 'READ_BUDGET_STATE_INVALID');
  }
  commit() { try { this.save(this.state); } catch { this.failed = true; throw new Error('READ_BUDGET_PERSIST_FAILED'); } }
  canStartLowPriorityRead(weight = 45, headroom = 160) {
    return this.lowPriorityReadDecision(weight, headroom).allowed;
  }
  lowPriorityReadDecision(weight = 45, headroom = 160) {
    invariant(Number.isSafeInteger(weight) && weight > 0 && Number.isSafeInteger(headroom) && headroom >= 0, 'READ_BUDGET_PRIORITY_INPUT_INVALID');
    const at = this.now(), s = this.state;
    const result = reason => Object.freeze({ allowed: reason === null, reason });
    // Same predicate/order as the boolean advisory check. Report only the first
    // failed condition, never claim it is the only source of pressure.
    if (this.failed) return result('STORE_UNAVAILABLE');
    if (at < s.lastAt) return result('CLOCK_INVALID');
    if (at < s.blockedUntil) return result('COOLING_DOWN');
    if (this.inFlight > 1 || this.inFlight >= this.maximumConcurrent) return result('CONCURRENCY');
    const spent = s.blocks.filter(b => at - b.at < 65000).reduce((n, b) => n + b.weight, 0);
    const ipUsed = at - s.ipAt >= 60000 ? 0 : s.ipUsed;
    // Advisory admission, not a reservation or permission to bypass run().
    // Every actual request still passes durable admission immediately before I/O.
    if (!(spent + weight + headroom <= this.maximumWeight)) return result('LOCAL_WEIGHT');
    if (!(ipUsed + weight + headroom <= this.ipCeiling)) return result('IP_HEADROOM');
    return result(null);
  }
  reserve(weight) {
    const at = this.now(), s = this.state;
    invariant(!this.failed && Number.isSafeInteger(at) && at >= s.lastAt, 'READ_BUDGET_CLOCK_OR_STORE_INVALID');
    invariant(Number.isSafeInteger(weight) && weight > 0 && weight <= this.maximumWeight, 'READ_BUDGET_WEIGHT_INVALID');
    invariant(at >= s.blockedUntil, 'READ_BUDGET_COOLING_DOWN');
    invariant(this.inFlight < this.maximumConcurrent, 'READ_BUDGET_CONCURRENCY');
    // A 5-second bucket is retained for its full lifetime plus one minute.
    s.blocks = s.blocks.filter(b => at - b.at < 65000);
    const spent = s.blocks.reduce((n, b) => n + b.weight, 0);
    invariant(spent + weight <= this.maximumWeight, 'READ_BUDGET_LOCAL_WEIGHT');
    // Keep the observed high-water for a full minute after receipt; never
    // reclaim allowance early based on a local fixed-minute boundary.
    if (at - s.ipAt >= 60000) s.ipUsed = 0;
    invariant(s.ipUsed + weight <= this.ipCeiling, 'READ_BUDGET_IP_HEADROOM');
    const bucket = Math.floor(at / 5000) * 5000;
    let row = s.blocks.find(b => b.at === bucket);
    if (!row) { row = { at: bucket, weight: 0 }; s.blocks.push(row); }
    row.weight += weight; s.ipUsed += weight; s.lastAt = at; s.requests++;
    this.commit(); this.inFlight++; this.pendingWeight += weight;
  }
  observe({ status, usedWeight, retryAfter, serverDate }) {
    const at = this.now(), s = this.state;
    invariant(!this.failed && at >= s.lastAt, 'READ_BUDGET_CLOCK_OR_STORE_INVALID');
    if (usedWeight !== null && usedWeight !== undefined) {
      invariant(/^\d{1,9}$/.test(String(usedWeight)), 'READ_BUDGET_HEADER_INVALID');
      const serverAt = Date.parse(serverDate), window = Math.floor(serverAt / 60000);
      // Only a fresh server Date can advance the venue's fixed-minute window.
      // Pending requests remain reserved; late/out-of-order headers cannot
      // lower this window's observed high-water or undo a cooldown.
      if (Number.isFinite(serverAt) && Math.abs(at - serverAt) <= 5000 && window > s.ipWindow) {
        s.ipWindow = window; s.ipUsed = Number(usedWeight) + this.pendingWeight;
      } else if (!Number.isFinite(serverAt) || window >= s.ipWindow) s.ipUsed = Math.max(s.ipUsed, Number(usedWeight) + this.pendingWeight);
      s.ipAt = at;
    }
    if ([418, 429].includes(status)) {
      // Never shorten an existing cooldown or retry blindly on a missing header.
      const seconds = /^\d+(?:\.\d+)?$/.test(String(retryAfter)) ? Number(retryAfter) : 0;
      const wait = status === 418 ? 3 * 86400000 : 60000;
      s.blockedUntil = Math.max(s.blockedUntil, at + Math.max(wait, Number.isFinite(seconds) ? seconds * 1000 : 0)); s.throttles++;
    }
    s.lastAt = at; this.commit();
  }
  async run(weight, action) {
    this.reserve(weight);
    try { return await action(); } finally { this.inFlight--; this.pendingWeight -= weight; }
  }
  status() { return { workerOnlyAdmission: true, legacyServicesEnrolled: false, inFlight: this.inFlight, requests: this.state.requests,
    maximumWeightPerRollingMinute: this.maximumWeight, observedIpUsed: this.state.ipUsed, ipCeiling: this.ipCeiling,
    blockedUntil: this.state.blockedUntil, throttles: this.state.throttles, persistenceFailed: this.failed }; }
}

export function sqliteBudgetState(journal) {
  invariant(journal.db && journal.owner && !journal.failed, 'READ_BUDGET_JOURNAL_REQUIRED');
  journal.db.exec('CREATE TABLE IF NOT EXISTS read_budget (id INTEGER PRIMARY KEY CHECK (id=1), state TEXT NOT NULL)');
  return {
    load: () => { const row = journal.db.prepare('SELECT state FROM read_budget WHERE id=1').get(); return row ? JSON.parse(row.state) : null; },
    save: state => {
      invariant(journal.db && journal.owner && !journal.failed, 'READ_BUDGET_JOURNAL_REQUIRED');
      const data = JSON.stringify(state); invariant(Buffer.byteLength(data) <= 4096, 'READ_BUDGET_STATE_TOO_LARGE');
      journal.db.prepare('INSERT INTO read_budget VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(data);
    },
  };
}

// Upper bounds for the exact read-only endpoint set. Unknown endpoints never
// default to 1. Account and position weights match the current USD-M contract.
export function readRequestWeight(method, pathname, params = {}) {
  if (pathname === '/fapi/v1/listenKey' && ['POST', 'PUT', 'DELETE'].includes(method)) return 1;
  invariant(method === 'GET', 'READ_BUDGET_MUTATION_FORBIDDEN');
  if (['/fapi/v1/time', '/fapi/v1/exchangeInfo'].includes(pathname)) return 1;
  if (['/fapi/v2/account', '/fapi/v2/positionRisk'].includes(pathname)) return 5;
  // Official accountConfig contract verified 2026-09-14: both account modes
  // in one USER_DATA GET. Existing endpoint upper bounds remain unchanged.
  if (pathname === '/fapi/v1/accountConfig') return 5;
  if (['/fapi/v1/positionSide/dual', '/fapi/v1/multiAssetsMargin'].includes(pathname)) return 30;
  if (['/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders'].includes(pathname)) return 40;
  if (pathname === '/fapi/v1/commissionRate') return 20;
  if (pathname === '/fapi/v1/userTrades') return 5;
  if (pathname === '/fapi/v1/allAlgoOrders') return 5;
  if (pathname === '/fapi/v1/income') return 30;
  if (['/fapi/v1/order', '/fapi/v1/algoOrder'].includes(pathname)) return 1;
  if (pathname === '/fapi/v1/ticker/bookTicker') return params.symbol ? 2 : 5;
  if (pathname === '/fapi/v1/forceOrders') return params.symbol ? 20 : 50;
  if (pathname === '/fapi/v1/klines') {
    const limit = Number(params.limit ?? 500);
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 1500, 'READ_BUDGET_KLINE_LIMIT');
    return limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
  }
  throw new Error('READ_BUDGET_ENDPOINT_UNKNOWN');
}
