const SYMBOLS = new Set(['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ZECUSDT','HYPEUSDT','LINKUSDT','AAVEUSDT']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PLAN = /^[A-Za-z0-9:_-]{1,180}$/;

const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateSmcPositionAction(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('SMC_POSITION_ACTION_REQUIRED');
  if (!UUID.test(input.id ?? '')) throw new Error('SMC_POSITION_ACTION_ID_INVALID');
  if (!PLAN.test(input.planId ?? '')) throw new Error('SMC_POSITION_ACTION_PLAN_INVALID');
  if (!SYMBOLS.has(input.symbol) || !['LONG', 'SHORT'].includes(input.direction)) throw new Error('SMC_POSITION_ACTION_SCOPE_INVALID');
  if (!['REDUCE', 'TIGHTEN_STOP', 'UPDATE_TARGET', 'ARM_STOP_PLAN', 'CANCEL_STOP_PLAN'].includes(input.action)) throw new Error('SMC_POSITION_ACTION_TYPE_INVALID');
  if (!Number.isSafeInteger(input.createdAt) || Math.abs(now - input.createdAt) > 300000) throw new Error('SMC_POSITION_ACTION_TIME_INVALID');
  const expiresAt = input.createdAt + 300000;
  if (input.action === 'CANCEL_STOP_PLAN') {
    if (!UUID.test(input.stopPlanId ?? '')) throw new Error('STOP_PLAN_ID_INVALID');
    return Object.freeze({ schema: 'SMC_OWNER_POSITION_ACTION_V1', id: input.id, planId: input.planId,
      symbol: input.symbol, direction: input.direction, action: input.action, stopPlanId: input.stopPlanId,
      createdAt: input.createdAt, expiresAt });
  }
  if (input.action === 'ARM_STOP_PLAN') {
    if (!['GTE','LTE'].includes(input.comparison) || !finitePositive(input.triggerPrice)) throw new Error('STOP_PLAN_TRIGGER_INVALID');
    if (!['FIXED','ENTRY'].includes(input.stopMode) || input.stopMode === 'FIXED' && !finitePositive(input.stopPrice)) throw new Error('STOP_PLAN_PRICE_INVALID');
    if (input.planExpiresAt != null && (!Number.isSafeInteger(input.planExpiresAt) || input.planExpiresAt <= now)) throw new Error('STOP_PLAN_EXPIRY_INVALID');
    return Object.freeze({ schema: 'SMC_OWNER_POSITION_ACTION_V1', id: input.id, planId: input.planId,
      symbol: input.symbol, direction: input.direction, action: input.action, triggerPrice: input.triggerPrice,
      comparison: input.comparison, stopMode: input.stopMode, stopPrice: input.stopMode === 'FIXED' ? input.stopPrice : null,
      planExpiresAt: input.planExpiresAt ?? null, createdAt: input.createdAt, expiresAt });
  }
  if (input.action === 'REDUCE') {
    if (!Number.isSafeInteger(input.fractionBps) || input.fractionBps < 100 || input.fractionBps > 10000)
      throw new Error('SMC_POSITION_ACTION_FRACTION_INVALID');
    return Object.freeze({ schema: 'SMC_OWNER_POSITION_ACTION_V1', id: input.id, planId: input.planId,
      symbol: input.symbol, direction: input.direction, action: input.action, fractionBps: input.fractionBps,
      createdAt: input.createdAt, expiresAt });
  }
  if (input.action === 'UPDATE_TARGET') {
    if (!finitePositive(input.targetPrice)) throw new Error('SMC_POSITION_ACTION_TARGET_INVALID');
    return Object.freeze({ schema: 'SMC_OWNER_POSITION_ACTION_V1', id: input.id, planId: input.planId,
      symbol: input.symbol, direction: input.direction, action: input.action, targetPrice: input.targetPrice,
      createdAt: input.createdAt, expiresAt });
  }
  if (!finitePositive(input.stopPrice)) throw new Error('SMC_POSITION_ACTION_STOP_INVALID');
  return Object.freeze({ schema: 'SMC_OWNER_POSITION_ACTION_V1', id: input.id, planId: input.planId,
    symbol: input.symbol, direction: input.direction, action: input.action, stopPrice: input.stopPrice,
    createdAt: input.createdAt, expiresAt });
}

export function positionActionError(error) {
  return /^[A-Z0-9_]{1,96}$/.test(error?.message ?? '') ? error.message : 'SMC_POSITION_ACTION_REJECTED';
}

export function sanitizeStopPlans(rows = []) {
  if (!Array.isArray(rows) || rows.length > 24) throw new Error('STOP_PLAN_PROJECTION_INVALID');
  return rows.map(r => {
    if (!UUID.test(r.id ?? '') || !['GTE','LTE'].includes(r.comparison) || !['FIXED','ENTRY'].includes(r.stopMode)
      || !finitePositive(r.triggerPrice) || !finitePositive(r.stopPrice)
      || !['ARMED','TRIGGERED','WAIT_PRICE','SUBMITTED','COMPLETED','CANCELLED','EXPIRED','POSITION_CLOSED'].includes(r.status)
      || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.updatedAt)
      || r.expiresAt != null && !Number.isSafeInteger(r.expiresAt)
      || r.triggeredAt != null && !Number.isSafeInteger(r.triggeredAt)) throw new Error('STOP_PLAN_PROJECTION_INVALID');
    return { id: r.id, comparison: r.comparison, triggerPrice: r.triggerPrice, stopMode: r.stopMode, stopPrice: r.stopPrice,
      status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, expiresAt: r.expiresAt ?? null,
      triggeredAt: r.triggeredAt ?? null, reason: /^[A-Z0-9_]{1,96}$/.test(r.reason ?? '') ? r.reason : null };
  });
}
