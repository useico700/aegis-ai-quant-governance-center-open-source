import { SIMPLE_ADMISSION_REVISION } from '../../shared/px-band-risk-only.mjs';
import { normalizeKlines, INTERVAL_MS } from "../../orion-v2/paper/paper-engine.mjs";
import { sanitizeAccountDetails } from '../../../lib/s1-account.mjs';
import { admittedReadJson } from '../s1-execution/admitted-http.mjs';
import { UNIVERSE, invariant } from '../s1-execution/common.mjs';
import { advancePxFirstClose, pxFirstCloseSignal } from '../../shared/px-first-close.mjs';

export const PUBLIC_PATHS = new Set(["/fapi/v1/time", "/fapi/v1/klines", "/fapi/v1/exchangeInfo", "/fapi/v1/ticker/bookTicker"]);

export const scannerBudgetStopped = error => /PUBLIC_HTTP_(418|429)|READ_BUDGET_|SHARED_BUDGET_|RESIDENT_READ_|PUBLIC_COORDINATED_/.test(error.message);

export function scannerRetryDelay({ cycleIntervalMs, consecutiveFailures, elapsedMs, errors }) {
  invariant(Number.isSafeInteger(cycleIntervalMs) && cycleIntervalMs >= 1000 && cycleIntervalMs <= 300000
    && Number.isSafeInteger(consecutiveFailures) && consecutiveFailures >= 0
    && Number.isFinite(elapsedMs) && elapsedMs >= 0 && Array.isArray(errors), 'SCANNER_RETRY_INPUT_INVALID');
  // Only a locally rejected, never-dispatched request gets this bounded retry.
  // Venue 418/429, IP headroom, durable cooldown, ownership and other errors keep
  // the existing backoff. Every subsequent GET still passes shared admission.
  const localOnly = errors.length > 0 && errors.every(e => e.reason === 'READ_BUDGET_LOCAL_WEIGHT');
  // Start this wait after the failed scan/publish, not at cycle start: a slow
  // scan may have consumed quota just before it was rejected.
  if (localOnly) return Math.max(70000, cycleIntervalMs);
  const cadence = Math.min(300000, cycleIntervalMs * Math.max(1, Math.min(5, consecutiveFailures)));
  return Math.max(1000, cadence - elapsedMs);
}
export async function publicGet(path, query = {}, fetcher = fetch, admission = null) {
  if (!PUBLIC_PATHS.has(path)) throw new Error("PUBLIC_ENDPOINT_NOT_ALLOWED");
  invariant(fetcher !== fetch || admission, 'PRODUCTION_SHARED_ADMISSION_REQUIRED');
  const url = new URL(path, "https://demo-fapi.binance.com");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  if (admission) {
    const result = await admittedReadJson(url, { method: 'GET' }, { fetcher, admission, timeoutMs: 10000 });
    if (!result.ok) throw new Error(`PUBLIC_HTTP_${result.status}`);
    return result.payload;
  }
  const response = await fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}`);
  return response.json();
}

export function validateBars(rows, interval, now) {
  const bars = normalizeKlines(rows, now);
  const width = INTERVAL_MS[interval];
  if (bars.length < 100) throw new Error(`INSUFFICIENT_${interval}_HISTORY`);
  if (now - bars.at(-1).closeTime > width + 30000) throw new Error(`STALE_${interval}_BARS`);
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].openTime - bars[index - 1].openTime !== width) throw new Error(`GAP_${interval}_BARS`);
  }
  return bars;
}

// Exactly thirty possible series. Only fully current closed bars are cached;
// a failed refresh never falls back to the previous boundary's cached history.
export function scannerBarReader(get, { assertReadable = () => {} } = {}) {
  const cache = new Map(), limits = { '15m': 320, '1h': 1200, '4h': 500 };
  return async (symbol, interval, now) => {
    assertReadable();
    invariant(UNIVERSE.includes(symbol) && Object.hasOwn(limits, interval) && Number.isSafeInteger(now) && now > 0, 'SCANNER_BAR_SCOPE');
    const key = `${symbol}:${interval}`, expectedClose = Math.floor(now / INTERVAL_MS[interval]) * INTERVAL_MS[interval] - 1;
    const cached = cache.get(key);
    if (cached?.at(-1)?.closeTime === expectedClose) return structuredClone(cached);
    const bars = validateBars(await get('/fapi/v1/klines', { symbol, interval, limit: limits[interval] }), interval, now);
    assertReadable();
    if (bars.at(-1)?.closeTime === expectedClose) cache.set(key, bars);
    return structuredClone(bars);
  };
}

export function choosePlan(old, discovered, now, strategy) {
  void now; void strategy;
  if (old && !discovered) return old;
  if (old && discovered?.id === old.id) return { ...discovered, createdAt: old.createdAt,
    pxEntryState: old.pxEntryState ?? null };
  return discovered;
}

export const MAX_RETAINED_PLANS_PER_SYMBOL = 20;

const planPriority = plan => {
  const signal = pxFirstCloseSignal(plan);
  const stage = signal.accepted ? 0 : signal.terminal ? 2 : 1;
  const opportunityAt = signal.accepted ? signal.bar.closeTime : Number(plan.intersectionTime);
  return [stage, Number.isFinite(opportunityAt) ? opportunityAt : Number.MAX_SAFE_INTEGER,
    Number.isFinite(plan.createdAt) ? plan.createdAt : Number.MAX_SAFE_INTEGER, plan.id];
};

export function prioritizePlanQueue(plans) {
  return [...plans].sort((a, b) => {
    const aa = planPriority(a), bb = planPriority(b);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2] || String(aa[3]).localeCompare(String(bb[3]));
  });
}

// Same-symbol plans coexist until one of the newer plans actually locks an
// executable close. Only older plans that are still waiting lose that race;
// merely discovering a newer structure never removes an incumbent.
export function resolveEntryConditionRace(plans) {
  invariant(Array.isArray(plans) && plans.every(plan => plan?.symbol && plan?.id), 'CANDIDATE_QUEUE_INVALID');
  // Direction confirmation alone must not cancel a competing opportunity.
  if (plans.some(plan => plan.pxEntryState?.revision === SIMPLE_ADMISSION_REVISION)) return prioritizePlanQueue(plans);
  const ready = plans.filter(plan => pxFirstCloseSignal(plan).accepted)
    .sort((a, b) => Number(pxFirstCloseSignal(a).bar.closeTime) - Number(pxFirstCloseSignal(b).bar.closeTime)
      || Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  if (!ready.length) return prioritizePlanQueue(plans);
  return prioritizePlanQueue(plans.filter(plan => {
    const signal = pxFirstCloseSignal(plan);
    if (signal.accepted || signal.terminal) return true;
    const createdAt = Number(plan.createdAt);
    if (!Number.isFinite(createdAt)) return true;
    return !ready.some(winner => Number.isFinite(Number(winner.createdAt))
      && Number(winner.createdAt) > createdAt);
  }));
}

// A newly discovered structure is an additional opportunity. It may refresh
// its own geometry before Px state begins, but it may never erase another
// live opportunity for the same symbol.
export function choosePlanQueue(existing, discovered, now, strategy) {
  void now; void strategy;
  invariant(Array.isArray(existing) && existing.every(plan => plan?.symbol && plan?.id), 'CANDIDATE_QUEUE_INVALID');
  const byId = new Map(existing.map(plan => [plan.id, plan]));
  if (discovered) {
    const old = byId.get(discovered.id);
    byId.set(discovered.id, old ? { ...discovered, createdAt: old.createdAt,
      pxEntryState: old.pxEntryState ?? null } : discovered);
  }
  invariant(byId.size <= MAX_RETAINED_PLANS_PER_SYMBOL, 'CANDIDATE_QUEUE_CAPACITY');
  return prioritizePlanQueue([...byId.values()]);
}

export function candidateView(plan, bars15m, now, strategy) {
  void bars15m; void strategy;
  const signal = pxFirstCloseSignal(plan);
  const signalAgeMs = signal.accepted ? now - signal.bar.closeTime : null;
  const status = signal.accepted ? 'FIRST_CLOSE_LOCKED' : signal.terminal ? 'INVALIDATED' : 'WAITING_FIRST_PX_CLOSE';
  return { id: plan.id, symbol: plan.symbol, status,
    direction: plan.pxEntryState?.direction === 1 ? 'LONG' : plan.pxEntryState?.direction === -1 ? 'SHORT' : null,
    discoveredAt: new Date(plan.createdAt).toISOString(), intersectionTime: new Date(plan.intersectionTime).toISOString(), intersectionPrice: plan.intersectionPrice,
    directionClosedAt: signal.accepted ? new Date(signal.bar.closeTime).toISOString() : null,
    reason: signal.reason, signalAgeMs, quality: Number.isFinite(plan.anchorQualityScore) ? plan.anchorQualityScore : null,
    executable: false, gate1Qualified: false };
}

export { advancePxFirstClose };

export function accountView(snapshot, now) {
  const account = snapshot?.account;
  const observedAt = account?.observedAt ?? null;
  const ageMs = observedAt ? now - Date.parse(observedAt) : Infinity;
  const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  const equity = finite(account?.marginBalanceUsdt), wallet = finite(account?.walletBalanceUsdt), available = finite(account?.availableBalanceUsdt);
  return { observedAt, details: sanitizeAccountDetails(account?.monitor), positionMode: typeof account?.dualSidePosition === 'boolean' ? account.dualSidePosition ? 'HEDGE' : 'ONE_WAY' : null, fresh: ageMs >= -5000 && ageMs <= 120000 && ['READY_READ_ONLY_SHADOW','READ_ONLY_ATTENTION_REQUIRED'].includes(snapshot?.status) && snapshot?.userStream?.connected !== false && [equity, wallet, available].every((value) => value !== null), userStreamConnected: snapshot?.userStream?.connected === true,
    equity, wallet, available,
    positions: finite(account?.nonFlatPositionCount), orders: finite(account?.openOrderCount), algoOrders: finite(account?.openAlgoOrderCount) };
}
