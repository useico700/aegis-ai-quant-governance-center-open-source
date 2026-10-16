import crypto from 'node:crypto';
import os from 'node:os';
import { invariant, UNIVERSE } from './common.mjs';
import { units } from '../../../lib/s1-precision.mjs';
import { boundedResponseJson } from './bounded-http.mjs';
import { admittedReadJson } from './admitted-http.mjs';
import { readRequestWeight } from './request-budget.mjs';

export const ACCOUNT_BATCH_PATHS = Object.freeze(['/fapi/v2/account', '/fapi/v2/positionRisk',
  '/fapi/v1/accountConfig', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders']);

const READS = new Set(['/fapi/v2/account', '/fapi/v2/positionRisk', '/fapi/v1/accountConfig', '/fapi/v1/positionSide/dual', '/fapi/v1/multiAssetsMargin', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders', '/fapi/v1/order', '/fapi/v1/algoOrder', '/fapi/v1/allAlgoOrders', '/fapi/v1/userTrades', '/fapi/v1/forceOrders', '/fapi/v1/income', '/fapi/v1/commissionRate']);
const WRITES = new Set(['POST /fapi/v1/order', 'POST /fapi/v1/algoOrder', 'DELETE /fapi/v1/order', 'DELETE /fapi/v1/algoOrder']);
const productionOrderTransports = new WeakSet();
const identifier = value => typeof value === 'string' && /^s2_[a-z]+_[a-f0-9]{26}$/.test(value);
const positiveDecimal = value => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && units(value) > 0n;

export function validateMutation(method, pathname, params) {
  invariant(WRITES.has(`${method} ${pathname}`), 'MUTATION_ENDPOINT_FORBIDDEN');
  invariant(UNIVERSE.includes(params.symbol), 'SYMBOL_FORBIDDEN');
  let allowed;
  if (method === 'DELETE') {
    const id = pathname.endsWith('/algoOrder') ? 'clientAlgoId' : 'origClientOrderId';
    allowed = ['symbol', id];
    invariant(identifier(params[id]), 'OWN_ORDER_ID_REQUIRED');
  } else {
    invariant(['LONG', 'SHORT'].includes(params.positionSide), 'HEDGE_POSITION_SIDE_REQUIRED');
    invariant(['BUY', 'SELL'].includes(params.side), 'SIDE_INVALID');
    if (pathname.endsWith('/algoOrder')) {
      allowed = ['symbol', 'side', 'positionSide', 'algoType', 'type', 'triggerPrice', 'closePosition', 'quantity', 'workingType', 'priceProtect', 'clientAlgoId'];
      const full = params.closePosition === 'true' && params.quantity === undefined;
      const bridge = params.closePosition === 'false' && positiveDecimal(params.quantity);
      invariant(params.algoType === 'CONDITIONAL' && params.type === 'STOP_MARKET' && (full || bridge), 'FULL_POSITION_OR_QUANTITY_BRIDGE_STOP_REQUIRED');
      invariant(params.side === (params.positionSide === 'LONG' ? 'SELL' : 'BUY'), 'STOP_MUST_CLOSE');
      invariant(params.workingType === 'CONTRACT_PRICE' && params.priceProtect === 'false', 'STOP_TRIGGER_POLICY_INVALID');
      invariant(positiveDecimal(params.triggerPrice) && identifier(params.clientAlgoId), 'STOP_FIELDS_INVALID');
    } else {
      allowed = ['symbol', 'side', 'positionSide', 'type', 'quantity', 'price', 'timeInForce', 'newClientOrderId', 'newOrderRespType'];
      invariant(positiveDecimal(params.quantity) && identifier(params.newClientOrderId) && params.newOrderRespType === 'RESULT', 'ORDER_FIELDS_INVALID');
      invariant(params.type === 'LIMIT' || params.type === 'MARKET', 'ORDER_TYPE_FORBIDDEN');
      if (params.type === 'LIMIT') invariant(['IOC', 'GTC'].includes(params.timeInForce)
        && positiveDecimal(params.price), 'ENTRY_LIMIT_FIELDS_REQUIRED');
      else {
        invariant(params.price === undefined && params.timeInForce === undefined, 'MARKET_FIELDS_INVALID');
        invariant(params.side === (params.positionSide === 'LONG' ? 'SELL' : 'BUY'), 'MARKET_ONLY_FOR_CLOSING');
      }
    }
  }
  invariant(Object.keys(params).every(key => allowed.includes(key)), 'UNEXPECTED_MUTATION_PARAMETER');
  return true;
}

// Existing construction remains read-only on the real network. Only the separate
// server-only order factory below grants this capability; it is not wired into
// the observer and does not itself authorize any order.
export class SignedTransport {
  constructor({ credentials, fetcher = fetch, mutationPermit = async () => false, now = Date.now, observeResponse = () => {}, admission = null }) {
    this.credentials = credentials; this.fetcher = fetcher; this.mutationPermit = mutationPermit; this.now = now; this.blockedUntil = 0;
    this.observeResponse = observeResponse;
    this.admission = admission;
  }
  async request(method, pathname, params = {}, dispatch) {
    return this.#request(method, pathname, params, this.admission, dispatch);
  }
  async readAccountBatch() {
    if (this.fetcher === fetch) {
      invariant(os.hostname() === 'aegis-demo-host' && process.env.AEGIS_PRODUCTION_HOST_ID === 'demo-server', 'PRODUCTION_SERVER_ONLY');
      invariant(this.admission, 'PRODUCTION_SHARED_ADMISSION_REQUIRED');
    }
    invariant(this.now() >= this.blockedUntil, 'EXCHANGE_RATE_LIMIT_CIRCUIT_OPEN');
    let results;
    if (!this.admission) results = await Promise.all(ACCOUNT_BATCH_PATHS.map(p => this.request('GET', p)));
    else {
      invariant(typeof this.admission.runBatch === 'function', 'SHARED_BATCH_ADMISSION_REQUIRED');
      const admit = typeof this.admission.runExecutionAccountBatch === 'function'
        ? this.admission.runExecutionAccountBatch.bind(this.admission) : this.admission.runBatch.bind(this.admission);
      results = await admit(ACCOUNT_BATCH_PATHS.map(p => readRequestWeight('GET', p)), slots =>
        Promise.all(ACCOUNT_BATCH_PATHS.map((p, i) => this.#request('GET', p, {}, slots[i]))));
    }
    // One fresh accountConfig GET replaces the two mode GETs; neither field is
    // cached or inferred. Preserve the reader's six-field result contract.
    const [account, positions, config, orders, algos] = results;
    invariant(config && !Array.isArray(config) && ['dualSidePosition', 'multiAssetsMargin', 'canTrade'].every(k => typeof config[k] === 'boolean'), 'ACCOUNT_CONFIGURATION_INCOMPLETE');
    invariant(typeof account?.canTrade === 'boolean' && account.canTrade === config.canTrade
      && (account.multiAssetsMargin === undefined || account.multiAssetsMargin === config.multiAssetsMargin), 'ACCOUNT_CONFIGURATION_MISMATCH');
    return [account, positions, { dualSidePosition: config.dualSidePosition }, { multiAssetsMargin: config.multiAssetsMargin }, orders, algos];
  }
  async #request(method, pathname, params, admission, dispatch) {
    const mutation = method !== 'GET';
    if (this.fetcher === fetch) {
      invariant(os.hostname() === 'aegis-demo-host' && process.env.AEGIS_PRODUCTION_HOST_ID === 'demo-server', 'PRODUCTION_SERVER_ONLY');
      invariant(!mutation || productionOrderTransports.has(this), 'PRODUCTION_MUTATION_ADAPTER_NOT_RELEASED');
      invariant(mutation || admission, 'PRODUCTION_SHARED_ADMISSION_REQUIRED');
    }
    if (mutation) {
      // Bind authorization and signing to the same flat order payload even if
      // the caller changes its object while the asynchronous permit is pending.
      params = Object.freeze({ ...params });
      validateMutation(method, pathname, params);
      const request = Object.freeze({ method, pathname, params });
      invariant(await this.mutationPermit(request) === true, 'LIVE_EXECUTION_DISARMED');
    } else invariant(READS.has(pathname), 'READ_ENDPOINT_FORBIDDEN');
    invariant(this.now() >= this.blockedUntil, 'EXCHANGE_RATE_LIMIT_CIRCUIT_OPEN');
    invariant(!Object.keys(params).some(key => ['timestamp', 'signature', 'recvWindow'].includes(key)), 'RESERVED_SIGNING_PARAMETER');
    const query = new URLSearchParams(Object.entries({ ...params, timestamp: this.now(), recvWindow: 3000 }).map(([key, value]) => [key, String(value)]));
    query.set('signature', crypto.createHmac('sha256', this.credentials.secretKey).update(query.toString()).digest('hex'));
    const url = new URL(pathname, 'https://demo-fapi.binance.com');
    if (method !== 'POST') url.search = query.toString();
    let networkAttempted = false;
    try {
      if (admission) {
        invariant(!mutation, 'SHARED_ADMISSION_READ_ONLY');
        const result = await admittedReadJson(url, { method, headers: { 'X-MBX-APIKEY': this.credentials.apiKey } },
          { fetcher: this.fetcher, admission, observeResponse: this.observeResponse });
        if (!result.ok) {
          const error = new Error('EXCHANGE_READ_FAILED'); error.httpStatus = result.status;
          error.exchangeCode = Number.isInteger(result.payload?.code) ? result.payload.code : null; throw error;
        }
        return result.payload;
      }
      // Local order/IP admission and the final authorization, circuit and
      // signing checks have completed. Fsync the caller's V2 marker here,
      // immediately before invoking the only mutation network boundary.
      if (mutation && dispatch) {
        invariant(typeof dispatch.beforeDispatch === 'function', 'NETWORK_DISPATCH_BOUNDARY_REQUIRED');
        await dispatch.beforeDispatch();
      }
      networkAttempted = true;
      const response = await this.fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'X-MBX-APIKEY': this.credentials.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }, ...(method === 'POST' ? { body: query.toString() } : {}) });
      const reportedWeight = response.headers?.get('x-mbx-used-weight-1m') ?? null;
      // A mutation is durably pre-charged before dispatch. Binance may return a
      // missing or non-canonical optional weight header on order endpoints; do
      // not turn that telemetry field into a global admission halt after the
      // venue has already accepted the order. The pre-charge remains and is
      // never refunded. Read responses keep their strict header validation.
      const usedWeight = mutation && !/^\d{1,9}$/.test(String(reportedWeight ?? '')) ? null : reportedWeight;
      await this.observeResponse({ status: response.status, usedWeight,
        orderCount10s: response.headers?.get('x-mbx-order-count-10s') ?? null, orderCount60s: response.headers?.get('x-mbx-order-count-1m') ?? null,
        retryAfter: response.headers?.get('retry-after') ?? null, serverDate: response.headers?.get('date') ?? null });
      if ([418, 429].includes(response.status)) {
        const seconds = Number(response.headers.get('retry-after'));
        this.blockedUntil = this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60000);
      }
      const body = await boundedResponseJson(response);
      if (!response.ok) {
        const deterministicMutationRejection = mutation && response.status >= 400 && response.status < 500
          && ![408, 418, 429].includes(response.status) && Number.isInteger(body?.code);
        const error = new Error(deterministicMutationRejection ? 'MUTATION_REJECTED'
          : mutation ? 'MUTATION_OUTCOME_UNRESOLVED' : 'EXCHANGE_READ_FAILED');
        error.exchangeCode = Number.isInteger(body?.code) ? body.code : null;
        error.httpStatus = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (mutation && !networkAttempted) throw new Error(/^[A-Z][A-Z0-9_]{0,95}$/.test(error?.message ?? '')
        ? error.message : 'MUTATION_PRE_DISPATCH_FAILED');
      if (!mutation && admission && ['READ_BUDGET_LOCAL_WEIGHT', 'READ_BUDGET_IP_HEADROOM', 'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN', 'READ_BUDGET_BATCH_EXPIRED'].includes(error.message)) {
        throw new Error(error.message); // Fixed local scheduling codes, no venue data.
      }
      // Never expose fetch errors (which can contain a signed URL) or venue msg.
      const safe = new Error(mutation && error.message === 'MUTATION_REJECTED' ? 'MUTATION_REJECTED'
        : mutation ? 'MUTATION_OUTCOME_UNRESOLVED' : 'EXCHANGE_READ_FAILED');
      safe.exchangeCode = error.exchangeCode ?? null;
      safe.httpStatus = error.httpStatus ?? null;
      throw safe;
    }
  }
}

// No automatic start, credentials discovery, account reads or retry. The host
// must supply a per-request authorization callback; omission stays disarmed.
// Keep this separate from the shared GET admission lane and existing observers.
export function createProductionOrderPort({ credentials, mutationPermit = async () => false, orderBudget = null }) {
  invariant(os.hostname() === 'aegis-demo-host' && process.env.AEGIS_PRODUCTION_HOST_ID === 'demo-server', 'PRODUCTION_SERVER_ONLY');
  invariant(typeof credentials?.apiKey === 'string' && credentials.apiKey.length > 0
    && typeof credentials?.secretKey === 'string' && credentials.secretKey.length > 0, 'PRODUCTION_CREDENTIALS_REQUIRED');
  invariant(typeof mutationPermit === 'function', 'MUTATION_PERMIT_REQUIRED');
  const transport = new SignedTransport({ credentials, mutationPermit, observeResponse: meta => orderBudget.observe(meta) });
  productionOrderTransports.add(transport);
  return Object.freeze({ supportsDispatchBoundary: true, request(method, pathname, params = {}, dispatch) {
    validateMutation(method, pathname, params);
    const operation = Object.freeze({ method, pathname, params: Object.freeze({ ...params }) });
    return (async () => {
      invariant(await mutationPermit(operation) === true, 'LIVE_EXECUTION_DISARMED');
      invariant(typeof orderBudget?.run === 'function' && typeof orderBudget?.observe === 'function', 'PRODUCTION_ORDER_BUDGET_REQUIRED');
      return orderBudget.run(operation, () => transport.request(method, pathname, operation.params, dispatch));
    })();
  } });
}
