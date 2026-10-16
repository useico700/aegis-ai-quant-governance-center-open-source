import { sanitizeStopPlans } from './smc-position-action.mjs';
const finite = (value, minimum = -1e15, maximum = 1e15) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const text = (value, pattern, maximum = 160) => typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : null;

export function sanitizeSmcExecutionLedger(input, now = Date.now()) {
  if (input?.service !== 'aegis-smc-execution' || input?.venue !== 'BINANCE_USDM_MAINNET'
    || input?.strategyRuntime?.strategyRevision !== 'SMC-EXEC-11' || input?.strategyRuntime?.accountLabel !== 'S2') throw new Error('SMC_EXECUTION_SCOPE_MISMATCH');
  const observedAt = iso(input.observedAt);
  if (!observedAt || Math.abs(now - Date.parse(observedAt)) > 600000) throw new Error('SMC_EXECUTION_TIME_INVALID');
  const a = input.account;
  if (!a || !iso(a.observedAt)) throw new Error('SMC_ACCOUNT_MISSING');
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
  const account = { observedAt: iso(a.observedAt), fresh: a.fresh === true, userStreamConnected: a.userStreamConnected === true,
    canTrade: a.canTrade === true, equity: finite(a.equity, 0), wallet: finite(a.wallet, -1e12), available: finite(a.available, -1e12),
    positions: count(a.positions), orders: count(a.orders), algoOrders: count(a.algoOrders), unrealized: finite(a.unrealized),
    initialMargin: finite(a.initialMargin, 0), positionMode: ['HEDGE','ONE_WAY'].includes(a.positionMode) ? a.positionMode : null,
    multiAssetsMargin: typeof a.multiAssetsMargin === 'boolean' ? a.multiAssetsMargin : null };
  if ([account.equity, account.wallet, account.available, account.positions, account.orders, account.algoOrders].some(v => v === null)) throw new Error('SMC_ACCOUNT_INVALID');
  const p = input.strategyRuntime.riskPolicy;
  if (p?.perTradeFraction !== '0.04' || p?.portfolioFraction !== '0.10' || p?.maximumOpenPositions !== 4 || p?.maximumLeverage !== 25 || p?.maximumGrossNotionalLeverage !== 25) throw new Error('SMC_RISK_SCOPE_MISMATCH');
  const positions = (input.strategyLedger?.positions ?? []).slice(0, 8).map(row => ({ planId: text(row.planId, /^[A-Za-z0-9:_-]+$/),
    symbol: text(row.symbol, /^[A-Z0-9]{3,20}$/), direction: ['LONG','SHORT'].includes(row.direction) ? row.direction : null,
    quantity: finite(row.quantity, 0), entry: finite(row.entry, 0), stop: finite(row.stop, 0), target: finite(row.target, 0),
    targetSource: ['STRUCTURE_PLAN','OWNER_OVERRIDE'].includes(row.targetSource) ? row.targetSource : null,
    stopPlans: sanitizeStopPlans(row.stopPlans),
    initialRiskUsdt: finite(row.initialRiskUsdt, 0),
    realizedNetPnl: finite(row.realizedNetPnl), unrealizedPnl: finite(row.unrealizedPnl),
    openedAt: iso(row.openedAt), status: row.status === 'OPEN' ? 'OPEN' : null }));
  if (positions.some(row => Object.entries(row).some(([key, value]) => key !== 'unrealizedPnl' && value === null))) throw new Error('SMC_POSITION_INVALID');
  const pendingEntries = (input.strategyLedger?.pendingEntries ?? []).slice(0, 8).map(row => ({
    planId: text(row.planId, /^[A-Za-z0-9:_-]+$/), symbol: text(row.symbol, /^[A-Z0-9]{3,20}$/),
    direction: ['LONG','SHORT'].includes(row.direction) ? row.direction : null,
    price: finite(row.price, 0), quantity: finite(row.quantity, 0), stop: finite(row.stop, 0), target: finite(row.target, 0),
    initialRiskUsdt: finite(row.initialRiskUsdt, 0), grossNotionalUsdt: finite(row.grossNotionalUsdt, 0),
    orderMode: ['IMMEDIATE','LIMIT_GTC'].includes(row.orderMode) ? row.orderMode : null,
    timeInForce: ['IOC','GTC'].includes(row.timeInForce) ? row.timeInForce : null,
    status: text(row.status, /^[A-Z0-9_]+$/, 32), createdAt: iso(row.createdAt),
  }));
  if (pendingEntries.some(row => Object.values(row).some(value => value === null))) throw new Error('SMC_PENDING_ENTRY_INVALID');
  const fills = (input.strategyLedger?.fills ?? []).slice(0, 100).map(row => ({ key: text(row.key, /^[A-Za-z0-9:._-]+$/, 300),
    planId: text(row.planId, /^[A-Za-z0-9:_-]+$/), role: ['ENTRY','EXIT'].includes(row.role) ? row.role : null,
    symbol: text(row.symbol, /^[A-Z0-9]{3,20}$/), direction: ['LONG','SHORT'].includes(row.direction) ? row.direction : null,
    time: Number.isSafeInteger(row.time) && row.time > 0 ? row.time : null, price: finite(row.price, 0), quantity: finite(row.quantity, 0),
    commission: finite(row.commission, 0), realizedPnl: finite(row.realizedPnl) }));
  if (fills.some(row => Object.values(row).some(v => v === null))) throw new Error('SMC_FILL_INVALID');
  const priceRules = (input.priceRules ?? []).slice(0, 20).map(row => ({
    symbol: text(row.symbol, /^[A-Z0-9]{3,20}$/),
    tickSize: text(String(row.tickSize ?? ''), /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e-?\d+)?$/i, 40),
    observedAt: iso(row.observedAt),
  }));
  if (priceRules.some(row => Object.values(row).some(v => v === null))
    || new Set(priceRules.map(row => row.symbol)).size !== priceRules.length
    || priceRules.some(row => Number(row.tickSize) <= 0)) throw new Error('SMC_PRICE_RULE_INVALID');
  const leverageAlignment = input.leverageAlignment && typeof input.leverageAlignment === 'object'
    ? { expectedLeverage: finite(input.leverageAlignment.expectedLeverage, 1, 125),
      ready: input.leverageAlignment.ready === true,
      mismatches: Array.isArray(input.leverageAlignment.mismatches) ? input.leverageAlignment.mismatches.length : 0 }
    : null;
  const entryBlockers = Array.isArray(input.entryBlockers) ? input.entryBlockers.slice(0, 20).map(row => ({
    symbol: text(row.symbol, /^[A-Z0-9]{3,20}$/),
    reason: text(row.reason, /^[A-Z0-9_]+$/, 96),
    terminal: row.terminal === true,
  })) : [];
  return { observedAt, account, execution: { status: text(input.status, /^[A-Z0-9_]+$/), liveReady: input.liveReady === true,
    entriesAllowed: input.entriesAllowed === true, exitsAllowed: input.exitsAllowed === true,
    manualEntriesEnabled: input.manualEntriesEnabled === true, infrastructureReady: input.infrastructureReady === true,
    orderAuthorizationStatus: text(input.orderAuthorizationStatus, /^[A-Z0-9_]+$/), strategyRuntime: input.strategyRuntime,
    leverageAlignment, entryBlockers }, priceRules, positions, pendingEntries, fills };

}
