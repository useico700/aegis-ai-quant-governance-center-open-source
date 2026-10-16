import { invariant, UNIVERSE } from './common.mjs';
import { BoundedReadDispatch } from './bounded-read-dispatch.mjs';
import { userStreamControl } from '../binance-prod2/mainnet-readonly-client.mjs';

// One fixed deadline per COMPLETE history window, not twenty seconds per page.
// Transport/signing is constructed only inside the post-admission callback.
export function prepareCoordinatedActivityTransport({ dispatcher, createTransport, symbol, at, startTime, endTime, schedulingTargetAt }) {
  invariant(dispatcher instanceof BoundedReadDispatch && typeof createTransport === 'function' && UNIVERSE.includes(symbol), 'COORDINATED_HISTORY_PORTS');
  const plan = dispatcher.prepareHistory(`shadow:history:${symbol.toLowerCase()}`,
    { readyAt: at, schedulingTargetAt, context: { startTime, endTime } });
  try {
    const transport = coordinatedActivityTransport({ dispatcher, createTransport, preparedHistoryPlan: plan,
      deadlineAt: plan.deadlineAt, schedulingTargetAt, reserveHistoryIo: true });
    return Object.freeze({ transport, cancel: () => dispatcher.cancelUnstartedHistory(plan) });
  } catch (error) { dispatcher.cancelUnstartedHistory(plan); throw error; }
}

export function coordinatedActivityTransport({ dispatcher, createTransport, deadlineAt, schedulingTargetAt = deadlineAt, reserveHistoryIo = false, preparedHistoryPlan = null }) {
  invariant(dispatcher instanceof BoundedReadDispatch && typeof createTransport === 'function', 'COORDINATED_HISTORY_PORTS');
  invariant(typeof reserveHistoryIo === 'boolean', 'COORDINATED_HISTORY_IO_RESERVE');
  invariant(preparedHistoryPlan === null || reserveHistoryIo && preparedHistoryPlan.deadlineAt === deadlineAt
    && preparedHistoryPlan.schedulingTargetAt === schedulingTargetAt, 'COORDINATED_HISTORY_PLAN');
  let initialCompleted = preparedHistoryPlan === null;
  return Object.freeze({ readInitialWindow({ symbol, startTime, endTime }) {
    invariant(UNIVERSE.includes(symbol), 'COORDINATED_HISTORY_SCOPE');
    const id = `shadow:history:${symbol.toLowerCase()}`;
    invariant(preparedHistoryPlan === null || preparedHistoryPlan.id === id
      && preparedHistoryPlan.context?.startTime === startTime && preparedHistoryPlan.context?.endTime === endTime,
    'COORDINATED_HISTORY_PLAN_BINDING');
    const action = admission => {
      const transport = createTransport(admission);
      return Promise.all([
        transport.request('GET', '/fapi/v1/userTrades', { symbol, startTime, endTime, limit: 1000 }),
        ...['LIQUIDATION', 'ADL'].map(autoCloseType => transport.request('GET', '/fapi/v1/forceOrders', { symbol, startTime, endTime, limit: 100, autoCloseType })),
      ]);
    };
    if (preparedHistoryPlan === null) return dispatcher.run(id, { deadlineAt, schedulingTargetAt, reserveHistoryIo, context: { startTime, endTime } }, action);
    return dispatcher.runPreparedHistory(preparedHistoryPlan, action).then(value => { initialCompleted = true; return value; });
  }, request(method, pathname, params) {
    invariant(method === 'GET' && params && UNIVERSE.includes(params.symbol), 'COORDINATED_HISTORY_SCOPE');
    const trades = pathname === '/fapi/v1/userTrades', forced = pathname === '/fapi/v1/forceOrders';
    invariant(trades || forced, 'COORDINATED_HISTORY_SCOPE');
    // Additional slices must follow the completed prepared batch, remain inside
    // its immutable symbol/window and share its ORIGINAL complete cutoff.
    invariant(preparedHistoryPlan === null || initialCompleted
      && preparedHistoryPlan.id === `shadow:history:${params.symbol.toLowerCase()}`
      && params.startTime >= preparedHistoryPlan.context.startTime && params.endTime <= preparedHistoryPlan.context.endTime
      && params.startTime <= params.endTime, 'COORDINATED_HISTORY_PLAN_BINDING');
    invariant(Object.keys(params).sort().join(',') === (trades ? 'endTime,limit,startTime,symbol' : 'autoCloseType,endTime,limit,startTime,symbol')
      && params.limit === (trades ? 1000 : 100) && (trades || ['LIQUIDATION', 'ADL'].includes(params.autoCloseType)), 'COORDINATED_HISTORY_PARAMETERS');
    const query = Object.freeze({ ...params }), symbol = query.symbol.toLowerCase();
    const id = trades ? `shadow:trades:${symbol}` : `shadow:forced:${symbol}:${query.autoCloseType.toLowerCase()}`;
    return dispatcher.run(id, { deadlineAt, schedulingTargetAt, reserveHistoryIo, context: { startTime: query.startTime, endTime: query.endTime } },
      admission => createTransport(admission).request(method, pathname, query));
  } });
}

// Matches ProductionUserStreamMonitor's injectable control signature; it is
// also usable as AccountStream's create/renew callbacks. No token is passed to
// the intent store and this port does not decide whether DELETE is appropriate.
export function coordinatedStreamControl({ dispatcher, consumer }) {
  invariant(dispatcher instanceof BoundedReadDispatch && ['reader', 'shadow'].includes(consumer), 'COORDINATED_STREAM_PORTS');
  let prepared = null, tokenTargetAt = dispatcher.now();
  const cancelRenewal = () => { if (prepared) { dispatcher.cancelPrepared(prepared); prepared = null; } };
  const control = async (config, method, credentials, options = {}) => {
    invariant(['POST', 'PUT', 'DELETE'].includes(method), 'COORDINATED_STREAM_METHOD');
    const timeoutMs = config.runtime.requestTimeoutMs;
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000, 'COORDINATED_STREAM_TIMEOUT');
    if (method !== 'PUT') cancelRenewal();
    const plan = method === 'PUT' ? prepared : null;
    if (plan) invariant(plan.deadlineAt - plan.readyAt === timeoutMs, 'COORDINATED_STREAM_TIMEOUT');
    const deadlineAt = plan?.deadlineAt ?? dispatcher.now() + timeoutMs;
    const action = admission => {
      const remaining = deadlineAt - dispatcher.now();
      invariant(remaining > 0, 'COORDINATED_STREAM_TIMEOUT');
      return userStreamControl({ ...config, runtime: { ...config.runtime, requestTimeoutMs: remaining } },
        method, credentials, { ...options, admission });
    };
    if (!plan) {
      // Token acquisition is already needed at construction. Preserve that
      // original scheduling target across caller-driven failed attempts; the
      // separate per-attempt I/O deadline and reconnect backoff never change.
      // Completing a token request does not assert socket/account freshness.
      const schedulingTargetAt = method === 'POST' ? (tokenTargetAt ??= dispatcher.now()) : deadlineAt;
      const value = await dispatcher.run(`${consumer}:stream:${method.toLowerCase()}`, { deadlineAt, schedulingTargetAt }, action);
      if (method === 'POST' && typeof value?.listenKey === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(value.listenKey)) tokenTargetAt = null;
      return value;
    }
    // runPrepared consumes or cancels the exact old receipt, never re-announces
    // a later cutoff. Early calls retain their plan for the correct release.
    try { const task = dispatcher.runPrepared(plan, action); prepared = null; return task; }
    catch (error) {
      if (error?.message !== 'READ_DISPATCH_MAINTENANCE_NOT_RELEASED') prepared = null;
      throw error;
    }
  };
  control.prepareRenewal = ({ readyAt, timeoutMs }) => {
    prepared = dispatcher.prepareMaintenance(`${consumer}:stream:put`, { readyAt, timeoutMs });
  };
  control.cancelRenewal = cancelRenewal;
  return control;
}
