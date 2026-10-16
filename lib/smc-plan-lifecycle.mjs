// Shared prospective lifecycle. This module never submits orders or simulates fills.
export const PLAN_LIFECYCLE_REVISION = 'SMC-PLAN-LIFECYCLE-1';
export const terminalReasons = ['TARGET_ALREADY_VISITED', 'STOP_ALREADY_VISITED', 'STRUCTURE_ALREADY_BROKEN', 'PATH_UNKNOWN', 'PLAN_EXPIRED'];
export const planFamilyKey = p => p.targetPathRevision && p.sourcePlan ? `PLAN:${p.id}` : p.candidatePathIdentity ? `PLAN:${p.id}` : p.anchor?.time != null
  ? `${p.symbol}:${p.direction}:${p.anchor.time}${p.discoveryRevision === 'SMC-TIMED-ENTRY-1' ? ':TIME1' : ''}${p.targetPolicyRevision === 'SMC-TARGET-4H-2' ? ':HTF2' : p.targetPolicyRevision === 'SMC-TARGET-4H-1' ? ':HTF1' : ''}${p.riskScopeRevision === 'SMC-PLAN-RISK-1' ? ':RISK1' : ''}${p.entryPolicyRevision === 'SMC-ENTRY-PATHS-2' ? ':PATH2' : p.entryPolicyRevision === 'SMC-ENTRY-PATHS-1' ? ':PATH1' : ''}${p.lifecycleGeneration ? `:R2:${p.lifecycleGeneration}` : ''}` : `PLAN:${p.id}`;
const number = n => n != null && Number.isFinite(Number(n)) ? Number(n) : null;
/** @param {object} plan
 * @param {{quote?: object, tick?: object, bars?: Array<object|Array<unknown>>, now?: number, checkExpiry?: boolean}} options */
export function planPriceEvent(plan, { quote, tick, bars = [], now = Date.now(), checkExpiry = true } = {}) {
  const long = plan.direction === 'LONG', target = number(plan.target ?? plan.targetPrice), stop = number(plan.stop ?? plan.stopPrice);
  const from = number(plan.availableAt ?? plan.confirmationAt ?? plan.createdAt ?? plan.observedAt) ?? now;
  const until = checkExpiry && Number.isFinite(plan.expiresAt) ? Math.min(now, plan.expiresAt) : now;
  const event = (reason, at, price, basis) => ({ reason, at, price, basis });
  // Both extremes on a bar do not establish which one happened first.
  for (const row of bars) {
    const b = Array.isArray(row) ? { openTime: Number(row[0]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), closeTime: Number(row[6]) } : row;
    if (!(b.closeTime > from && b.closeTime < until)) continue;
    const t = target != null && (long ? b.high >= target : b.low <= target);
    const s = stop != null && (long ? b.low <= stop : b.high >= stop);
    if (!t && !s) continue;
    if (b.openTime < from || t && s) return event('PATH_UNKNOWN', b.closeTime, null, 'CLOSED_BAR_UNKNOWN_PATH');
    return event(t ? 'TARGET_ALREADY_VISITED' : 'STOP_ALREADY_VISITED', b.closeTime,
      t ? target : stop, 'CLOSED_BAR_EXTREME');
  }
  const at = number(quote?.time ?? quote?.marketTime ?? quote?.quoteAt);
  const bid = number(quote?.bidPrice ?? quote?.bid), ask = number(quote?.askPrice ?? quote?.ask);
  if (at != null && at >= from && at <= until + (until === now ? 1000 : 0) && now - at <= 15000 && bid > 0 && ask >= bid) {
    const executableExit = long ? bid : ask;
    if (target != null && (long ? executableExit >= target : executableExit <= target))
      return event('TARGET_ALREADY_VISITED', at, executableExit, long ? 'BBO_BID' : 'BBO_ASK');
  }
  const tAt = number(tick?.marketTime ?? tick?.time), price = number(tick?.price);
  if (tAt != null && tAt >= from && tAt <= until + (until === now ? 1000 : 0) && now - tAt <= 15000 && price > 0) {
    if (target != null && (long ? price >= target : price <= target)) return event('TARGET_ALREADY_VISITED', tAt, price, 'TICK');
    if (stop != null && (long ? price <= stop : price >= stop)) return event('STOP_ALREADY_VISITED', tAt, price, 'TICK');
  }
  if (checkExpiry && Number.isFinite(plan.expiresAt) && now >= plan.expiresAt)
    return event('PLAN_EXPIRED', plan.expiresAt, null, 'LEASE');
  return null;
}
export function candidateLifecyclePlan(p) { return { ...p, ...(p.targetPathRevision?{candidatePathIdentity:true}:{}), availableAt: p.availableAt ?? p.observedAt }; }
export function compactLifecyclePlan(p) {
  return Object.fromEntries(['id','symbol','direction','anchor','objective','availableAt','observedAt','expiresAt','entry','stop','target','zone','lifecyclePolicy','lifecycleGeneration','supersedesPlanId','tradeScope','discoveryRevision','targetPolicyRevision','targetBasis','riskScopeRevision','entryPolicyRevision','candidatePathIdentity'].map(k => [k, p[k]]));
}
export function emptyLifecycleState() { return { revision: PLAN_LIFECYCLE_REVISION, records: {} }; }
export function validateLifecycleState(state) {
  if (state?.revision !== PLAN_LIFECYCLE_REVISION || !state.records || Array.isArray(state.records)
    || Object.keys(state.records).length > 4096) throw new Error('PLAN_LIFECYCLE_STATE_INVALID');
  for (const [key,r] of Object.entries(state.records)) {
    if (!r.plan || key !== planFamilyKey(r.plan) || !['LONG','SHORT'].includes(r.plan.direction)
      || !Number.isFinite(r.plan.availableAt) || !Number.isFinite(r.plan.anchor?.time ?? r.plan.availableAt)
      || r.terminal && (!terminalReasons.includes(r.terminal.reason) || !Number.isFinite(r.terminal.at)))
      throw new Error('PLAN_LIFECYCLE_RECORD_INVALID');
  }
  return state;
}
export function reconcilePlanLifecycle(state, { plans = [], symbol, quote, tick, bars = [], now, external = null } = {}) {
  const next = structuredClone(validateLifecycleState(state ?? emptyLifecycleState()));
  if (external) {
    validateLifecycleState(external);
    for (const [key,r] of Object.entries(external.records)) if (r.terminal && r.plan.symbol === symbol && !next.records[key]?.terminal) next.records[key] = r;
  }
  for (const p of plans) {
    const key = planFamilyKey(p);
    if (!next.records[key]) {
      next.records[key] = { plan: compactLifecyclePlan(p), terminal: null };
      if (p.targetPolicyRevision) for (const [priorKey, prior] of Object.entries(next.records)) {
        if (priorKey !== key && !prior.terminal && !prior.supersededBy && prior.plan.symbol===p.symbol
          && prior.plan.direction===p.direction && prior.plan.anchor?.time===p.anchor?.time
          && (prior.plan.targetPolicyRevision!==p.targetPolicyRevision || (prior.plan.riskScopeRevision??null)!==(p.riskScopeRevision??null) || (prior.plan.entryPolicyRevision??null)!==(p.entryPolicyRevision??null))) { prior.supersededBy=p.id;prior.supersededAt=now; }
      }
    }
    // Same anchor may refresh volatility, but cannot silently replace its objective.
    else if (!next.records[key].terminal && next.records[key].plan.target === p.target)
      next.records[key].plan.expiresAt = p.expiresAt;
  }
  for (const [key,r] of Object.entries(next.records)) {
    if (r.plan.symbol === symbol && !r.terminal && !r.supersededBy) {
      // A fresh lease may restore data availability, never erase a price event.
      r.terminal = planPriceEvent(r.plan, { quote, tick, bars, now, checkExpiry: r.plan.lifecyclePolicy !== 2 });
      if (r.plan.lifecyclePolicy === 2) r.leaseExpiredAt = now >= r.plan.expiresAt ? r.plan.expiresAt : null;
    }
    if (r.terminal && now - r.terminal.at > 7 * 86400000 && now - (r.plan.anchor?.time ?? r.plan.availableAt) > 7 * 86400000) delete next.records[key];
  }
  validateLifecycleState(next);
  return next;
}

/** Preserve old terminal records. Requalification is possible only for a lease,
 * with uninterrupted closed-bar coverage and no consumed target/stop. */
export function requalifyPlanAnchor({ state, symbol, direction, anchor, bars, now, discoveryRevision = null, targetPolicyRevision = null, riskScopeRevision = null, entryPolicyRevision = null }) {
  const related = Object.values(state?.records ?? {}).filter(r => !r.plan.candidatePathIdentity && r.plan.symbol === symbol
    && r.plan.direction === direction && r.plan.anchor?.time === anchor.time);
  if (related.some(r => r.terminal && !r.supersededBy && r.terminal.reason !== 'PLAN_EXPIRED')) return { blocked: true };
  const scoped = related.filter(r => (r.plan.discoveryRevision ?? null) === discoveryRevision && (r.plan.targetPolicyRevision ?? null) === targetPolicyRevision && (r.plan.riskScopeRevision ?? null) === riskScopeRevision && (r.plan.entryPolicyRevision ?? null) === entryPolicyRevision);
  const active = scoped.find(r => !r.terminal && !r.supersededBy);
  if (active) return { tracked: active.plan, generation: active.plan.lifecycleGeneration ?? null };
  const old = scoped.sort((a,b) => b.plan.availableAt - a.plan.availableAt)[0];
  if (!old) return { generation: null, supersedesPlanId: related.find(r=>!r.terminal&&!r.supersededBy)?.plan.id ?? null };
  const closed = bars.filter(b => b.closeTime < now).sort((a,b) => a.openTime - b.openTime);
  if (!closed.length || closed[0].openTime > old.plan.availableAt
    || now - closed.at(-1).closeTime > 930000
    || closed.some((b,i) => i && b.openTime !== closed[i-1].closeTime + 1)
    || planPriceEvent(old.plan, { bars: closed, now, checkExpiry: false })) return { blocked: true };
  return { tracked: old.plan, generation: old.terminal.at, supersedesPlanId: old.plan.id, requalified: true };
}
export function lifecycleSourceIsActive(plan, { quote, tick, bars, state, now = Date.now() } = {}) {
  if (!plan || state?.records?.[planFamilyKey(plan)]?.terminal || state?.records?.[planFamilyKey(plan)]?.supersededBy) return false;
  return !planPriceEvent(plan, { quote, tick, bars, now });
}

export function sanitizePlanTerminals(rows, symbol, now) {
  if (rows == null) return [];
  if (!Array.isArray(rows) || rows.length > 16) throw new Error('PLAN_TERMINALS_INVALID');
  const state = emptyLifecycleState();
  for (const r of rows) {
    if (!r.terminal || r.plan?.symbol !== symbol || r.terminal.at > now + 5000
      || typeof r.plan.id !== 'string' || r.plan.id.length > 160
      || !Number.isFinite(r.plan.entry) || !Number.isFinite(r.plan.stop)
      || r.plan.target !== null && !Number.isFinite(r.plan.target)) throw new Error('PLAN_TERMINAL_SCOPE');
    state.records[planFamilyKey(r.plan)] = r;
  }
  validateLifecycleState(state); return rows.map(r => ({ plan: compactLifecyclePlan(r.plan), terminal: r.terminal }));
}
