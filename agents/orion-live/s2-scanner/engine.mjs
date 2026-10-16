import { SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION } from '../../shared/px-band-risk-only.mjs';
import { normalizeKlines, findConvergencePlan, INTERVAL_MS } from "../../orion-v2/paper/paper-engine.mjs";
import { sanitizeAccountDetails } from '../../../lib/s1-account.mjs';
import { admittedReadJson } from '../s2-execution/admitted-http.mjs';
import { UNIVERSE, invariant } from '../s2-execution/common.mjs';
import { advancePxFirstClose, pxFirstCloseSignal } from '../../shared/px-first-close.mjs';
import { S2_Z_STRUCTURE_REVISION, discoverS2ZPlans, refreshS2ZPlanEvidence } from '../../shared/s2-z-structure.mjs';

export const PUBLIC_PATHS = new Set(["/fapi/v1/time", "/fapi/v1/klines", "/fapi/v1/exchangeInfo", "/fapi/v1/ticker/bookTicker"]);
export const ENTRY_INTERVAL_MS = 300000;

export function signalForPlan5m({ plan, bars5m, now, signalPolicy }) {
  const maximumReserveBars = Number(signalPolicy.maximumReserveBars ?? 4);
  const maximumDirectionDecisionBars = Number(signalPolicy.maximumDirectionDecisionBars ?? 2);
  const reserveBars = (bars5m ?? []).filter(bar => bar.openTime >= plan.lockedBarOpenTime
    && bar.openTime < plan.lockedBarOpenTime + maximumReserveBars * ENTRY_INTERVAL_MS
    && bar.closeTime < now).sort((a, b) => a.openTime - b.openTime);
  const upper = plan.intersectionPrice * (1 + Number(signalPolicy.crossCloseBufferBps ?? 5) / 10000);
  const lower = plan.intersectionPrice * (1 - Number(signalPolicy.crossCloseBufferBps ?? 5) / 10000);
  const decision = reserveBars.slice(0, maximumDirectionDecisionBars).find(bar => bar.close >= upper || bar.close <= lower);
  if (decision) {
    const direction = decision.close >= upper ? 1 : -1;
    return { accepted: true, terminal: true, reason: 'TWO_BAR_CROSS_CLOSE_BEYOND_BUFFER', bar: decision,
      patternBars: [decision], patternLength: 1, direction, crossCloseBufferBps: Number(signalPolicy.crossCloseBufferBps ?? 5) };
  }
  if (reserveBars.length >= maximumDirectionDecisionBars) return { accepted: false, terminal: true,
    reason: 'TWO_BAR_CROSS_CLOSES_INSIDE_BUFFER', reserveBars };
  return { accepted: false, terminal: false,
    reason: reserveBars.length ? 'CROSS_BUFFER_WAITING_IMMEDIATE_SECOND_BAR' : 'CONFIRMATION_RESERVE_NOT_CLOSED', reserveBars };
}

export function discoverS2Plan({ symbol, bars5m, bars15m, bars1h, now, strategy }) {
  if (strategy.structureRevision === S2_Z_STRUCTURE_REVISION)
    return discoverS2ZPlans({ symbol, bars5m, bars15m, bars1h, now, strategy })[0] ?? null;
  const discoveryStrategy = structuredClone(strategy);
  // The inherited geometry is expressed on the common 15-minute coordinate.
  // Boundary ambiguity and locking are re-evaluated below on the requested 5m clock.
  discoveryStrategy.intersection.ambiguousBoundaryMs = 0;
  const plan = findConvergencePlan({ symbol, bars15m: bars5m, bars1h: bars15m, bars4h: bars1h,
    now, strategy: discoveryStrategy });
  if (!plan) return null;
  const containingOpen = Math.floor(plan.intersectionTime / ENTRY_INTERVAL_MS) * ENTRY_INTERVAL_MS;
  const boundaryDistance = Math.min(plan.intersectionTime - containingOpen,
    containingOpen + ENTRY_INTERVAL_MS - plan.intersectionTime);
  if (boundaryDistance < Number(strategy.intersection.ambiguousBoundaryMs)) return null;
  return { ...plan, pattern: plan.pattern === '4H_DESC_HIGH__1H_ASC_LOW'
    ? '1H_DESC_HIGH__15M_ASC_LOW' : '1H_ASC_LOW__15M_DESC_HIGH',
  lockedBarOpenTime: containingOpen, primaryLineStatus: plan.fourHourLineStatus,
  timeframeContract: { primaryStructure: '1h', opposingStructure: '15m', entryDecision: '5m' } };
}

export function discoverS2Plans(input) {
  return input.strategy?.structureRevision === S2_Z_STRUCTURE_REVISION
    ? discoverS2ZPlans(input) : [discoverS2Plan(input)].filter(Boolean);
}

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
  const width = interval === '5m' ? ENTRY_INTERVAL_MS : INTERVAL_MS[interval];
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
  const cache = new Map(), limits = { '5m': 320, '15m': 1200, '1h': 500 };
  return async (symbol, interval, now) => {
    assertReadable();
    invariant(UNIVERSE.includes(symbol) && Object.hasOwn(limits, interval) && Number.isSafeInteger(now) && now > 0, 'SCANNER_BAR_SCOPE');
    const width = interval === '5m' ? ENTRY_INTERVAL_MS : INTERVAL_MS[interval];
    const key = `${symbol}:${interval}`, expectedClose = Math.floor(now / width) * width - 1;
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
export const MAX_PENDING_Z_PLANS_PER_SYMBOL = 20;

export function reconcileS2ZPlanQueue({ existing = [], pending = [], discovered = [], bars5m, bars15m, bars1h, now, strategy }) {
  const byId = new Map(), archive = [];
  const record = (plan, reason, compact = false) => ({ eventId: `${plan.id}:${reason}:${plan.zStructure?.geometryHash ?? 'LEGACY'}`,
    reason, archivedAt: now, plan: compact ? { id: plan.id, symbol: plan.symbol, createdAt: plan.createdAt,
      intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice, structureRevision: plan.structureRevision,
      geometryHash: plan.zStructure?.geometryHash, evidenceHash: plan.zStructure?.evidenceHash, anchors: plan.anchors,
      zPoints: plan.zStructure?.z?.points, executionEligible: false } : plan });
  // Preserve the first discovery, all causal point clocks and its geometry hash.
  // A newer scan may enrich raw path evidence; it never re-identifies a plan.
  for (const plan of [...existing, ...pending, ...discovered]) {
    if (byId.has(plan.id)) continue;
    if (plan.structureRevision !== S2_Z_STRUCTURE_REVISION) {
      archive.push(record(plan, 'S2_LEGACY_STRUCTURE_RETIRED_FOR_NEW_ENTRY')); continue;
    }
    const checked = refreshS2ZPlanEvidence(plan, { now, bars15m, bars1h });
    if (checked.structureValidation.terminal) { archive.push(record(checked, checked.structureValidation.reason)); continue; }
    const advanced = checked.structureValidation.allowed ? advancePxFirstClose(checked, bars5m, now, strategy.signal) : checked;
    if (pxFirstCloseSignal(advanced).terminal) { archive.push(record(advanced, pxFirstCloseSignal(advanced).reason)); continue; }
    byId.set(plan.id, advanced);
  }
  const all = [...byId.values()];
  const incumbentIds = new Set(existing.filter(p => p.structureRevision === S2_Z_STRUCTURE_REVISION).map(p => p.id));
  const incumbents = prioritizePlanQueue(all.filter(p => incumbentIds.has(p.id)));
  const waiting = all.filter(p => !incumbentIds.has(p.id)).sort((a, b) =>
    b.zStructure.z.points.D.time - a.zStructure.z.points.D.time || a.intersectionTime - b.intersectionTime || a.id.localeCompare(b.id));
  const queue = prioritizePlanQueue([...incumbents, ...waiting.splice(0, Math.max(0, MAX_RETAINED_PLANS_PER_SYMBOL - incumbents.length))]);
  invariant(queue.length <= MAX_RETAINED_PLANS_PER_SYMBOL, 'CANDIDATE_QUEUE_CAPACITY');
  const pendingQueue = waiting.slice(0, MAX_PENDING_Z_PLANS_PER_SYMBOL).map(plan => ({ ...plan,
    capacityWait: { status: 'CANDIDATE_CAPACITY_WAIT', executionEligible: false, observedAt: now } }));
  for (const plan of waiting.slice(MAX_PENDING_Z_PLANS_PER_SYMBOL)) archive.push(record(plan, 'CANDIDATE_CAPACITY_WAIT_COMPACT', true));
  return { queue: queue.map(({ capacityWait, ...plan }) => plan), pending: pendingQueue, archive,
    capacity: { active: queue.length, pending: pendingQueue.length, deferred: Math.max(0, waiting.length - MAX_PENDING_Z_PLANS_PER_SYMBOL),
      maximumActive: MAX_RETAINED_PLANS_PER_SYMBOL, maximumPending: MAX_PENDING_Z_PLANS_PER_SYMBOL } };
}

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
  if (plans.some(plan => [SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION]
    .includes(plan.pxEntryState?.revision))) return prioritizePlanQueue(plans);
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

export function candidateView(plan, bars5m, now, strategy) {
  void bars5m; void strategy;
  const signal = pxFirstCloseSignal(plan);
  const signalAgeMs = signal.accepted ? now - signal.bar.closeTime : null;
  const structure = plan.structureRevision === S2_Z_STRUCTURE_REVISION ? plan.structureValidation : null;
  const status = structure && !structure.allowed ? (structure.terminal ? 'INVALIDATED' : 'STRUCTURE_EVIDENCE_WAIT')
    : signal.accepted ? 'FIRST_CLOSE_LOCKED' : signal.terminal ? 'INVALIDATED' : 'WAITING_FIRST_PX_CLOSE';
  return { id: plan.id, symbol: plan.symbol, status,
    direction: plan.pxEntryState?.direction === 1 ? 'LONG' : plan.pxEntryState?.direction === -1 ? 'SHORT' : null,
    discoveredAt: new Date(plan.createdAt).toISOString(), intersectionTime: new Date(plan.intersectionTime).toISOString(), intersectionPrice: plan.intersectionPrice,
    reason: structure && !structure.allowed ? structure.reason : signal.reason, structureRevision: plan.structureRevision ?? null,
    structureGeometryHash: plan.zStructure?.geometryHash ?? null, signalAgeMs, quality: Number.isFinite(plan.anchorQualityScore) ? plan.anchorQualityScore : null,
    executable: false, gate1Qualified: false };
}

export { advancePxFirstClose };

export function accountView(snapshot, now) {
  const account = snapshot?.account;
  const observedAt = account?.observedAt ?? null;
  const ageMs = observedAt ? now - Date.parse(observedAt) : Infinity;
  const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  const equity = finite(account?.marginBalanceUsdt ?? account?.equity), wallet = finite(account?.walletBalanceUsdt ?? account?.wallet), available = finite(account?.availableBalanceUsdt ?? account?.available);
  return { observedAt, details: sanitizeAccountDetails(account?.monitor ?? account?.details), positionMode: account?.positionMode ?? (typeof account?.dualSidePosition === 'boolean' ? account.dualSidePosition ? 'HEDGE' : 'ONE_WAY' : null), fresh: ageMs >= -5000 && ageMs <= 120000 && ['READY_READ_ONLY_SHADOW','READ_ONLY_ATTENTION_REQUIRED','HEALTHY'].includes(snapshot?.status) && [equity, wallet, available].every((value) => value !== null), userStreamConnected: snapshot?.userStream?.connected === true || account?.userStreamConnected === true,
    equity, wallet, available,
    positions: finite(account?.nonFlatPositionCount ?? account?.positions), orders: finite(account?.openOrderCount ?? account?.orders), algoOrders: finite(account?.openAlgoOrderCount ?? account?.algoOrders) };
}
