import policy from './smc-scan-policy.json' with { type: 'json' };

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;
// The live loop performs bounded account and evidence reconciliation before it
// may submit. Keep the owner ticket alive across several supervised cycles;
// every cycle still reprices and revalidates current Tick/BBO and stop/target.
export const MANUAL_INTENT_TTL_MS = 180000;

export function validateSmcManualIntent(raw, now = Date.now()) {
  const legacy = raw?.schema === 'SMC_OWNER_MANUAL_INTENT_V1';
  const current = raw?.schema === 'SMC_OWNER_MANUAL_INTENT_V2';
  const orderMode = legacy ? 'IMMEDIATE' : raw?.orderMode;
  const limitPrice = orderMode === 'LIMIT_GTC' ? raw?.limitPrice : null;
  if ((!legacy && !current)
    || typeof raw.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.id)
    || !policy.universe.includes(raw.symbol)
    || !['LONG', 'SHORT'].includes(raw.direction)
    || !['ACTIVE_CANDIDATE', 'RECENT_INVALIDATION', 'MANUAL_CANDIDATE'].includes(raw.source)
    || typeof raw.sourceId !== 'string' || raw.sourceId.length < 1 || raw.sourceId.length > 160
    || ![raw.stopPrice, raw.targetPrice].every(value => typeof value === 'string' && DECIMAL.test(value) && Number(value) > 0)
    || !['IMMEDIATE', 'LIMIT_GTC'].includes(orderMode)
    || (orderMode === 'LIMIT_GTC' && !(typeof limitPrice === 'string' && DECIMAL.test(limitPrice) && Number(limitPrice) > 0))
    || !Number.isSafeInteger(raw.createdAt) || raw.createdAt > now + 5000
    || now - raw.createdAt > MANUAL_INTENT_TTL_MS) throw new Error('SMC_MANUAL_INTENT_INVALID');
  return Object.freeze({ schema: raw.schema, id: raw.id, symbol: raw.symbol, direction: raw.direction,
    source: raw.source, sourceId: raw.sourceId, stopPrice: raw.stopPrice,
    targetPrice: raw.targetPrice, orderMode, limitPrice,
    timeInForce: orderMode === 'LIMIT_GTC' ? 'GTC' : 'IOC',
    createdAt: raw.createdAt, expiresAt: raw.createdAt + MANUAL_INTENT_TTL_MS });
}
