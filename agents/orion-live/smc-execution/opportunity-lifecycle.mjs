import fs from 'node:fs/promises';
import { emptyLifecycleState, validateLifecycleState, reconcilePlanLifecycle, planFamilyKey, planPriceEvent, candidateLifecyclePlan } from '../../../lib/smc-plan-lifecycle.mjs';
// Observe the SAME persisted Tick/BBO stream used by the sole order writer.
// No exchange calls, sockets, hidden orders or independent execution authority.
export class OpportunityLifecycleTracker {
  constructor({ root = '/var/lib/aegis/smc-execution', scanPath = '/var/lib/aegis/smc-scanner/latest.json', now = Date.now } = {}) {
    Object.assign(this, { root, scanPath, now }); this.state = emptyLifecycleState(); this.tail = Promise.resolve(); this.lastRead = 0; this.available = false;
  }
  async open() {
    try { this.state = validateLifecycleState(JSON.parse(await fs.readFile(`${this.root}/opportunity-terminals.json`, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await this.refresh(); return this;
  }
  async save() {
    validateLifecycleState(this.state);
    const p = `${this.root}/opportunity-terminals.json`;
    await fs.writeFile(`${p}.next`, JSON.stringify(this.state), { mode: 0o600 }); await fs.rename(`${p}.next`, p);
  }
  serialize(fn) { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
  refresh() { return this.serialize(() => this.refreshInternal()); }
  async refreshInternal() {
    const now = this.now(); if (now - this.lastRead < 1000) return;
    this.lastRead = now; this.available = false;
    try {
      const s = JSON.parse(await fs.readFile(this.scanPath, 'utf8'));
      const at = Date.parse(s.sourceAsOf);
      if (s.revision !== 'SMC-SCAN-13' || s.orderAuthority !== false || !Array.isArray(s.results)
        || !Number.isFinite(at) || now - at > 360000 || at > now + 5000) return;
      this.snapshot = s;
      this.currentPlans = new Map(s.results.flatMap(r => [...(r.structurePlans ?? []), ...(r.candidates ?? []).map(candidateLifecyclePlan)]).map(p => [planFamilyKey(p), p]));
      for (const row of s.results) {
        for (const r of row.planTerminals ?? []) if (r.terminal) this.state.records[planFamilyKey(r.plan)] = r;
        this.state = reconcilePlanLifecycle(this.state, { symbol: row.symbol,
          plans: [...(row.structurePlans ?? []), ...(row.candidates ?? []).map(candidateLifecyclePlan)], now });
      }
      this.available = true; await this.save();
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  observe(rows) { return this.serialize(() => this.observeInternal(rows)); }
  async observeInternal(rows) {
    await this.refreshInternal(); let changed = false;
    for (const row of rows) {
      if (!row.continuity || !['TICK','BBO'].includes(row.type)) continue;
      for (const r of Object.values(this.state.records)) {
        if (r.terminal || r.supersededBy || r.plan.symbol !== row.symbol) continue;
        const market = { now: row.marketTime, checkExpiry: false, ...(row.type === 'TICK' ? { tick: row } : { quote: row }) };
        const current = this.currentPlans?.get(planFamilyKey(r.plan));
        const event = planPriceEvent(r.plan, market) ?? (current ? planPriceEvent({ ...current, availableAt: Math.max(current.availableAt, current.observedAt) }, market) : null);
        if (event) { r.terminal = event; changed = true; }
      }
    }
    if (changed) await this.save();
  }
  sourceStatus(id, symbol, direction, now) {
    const conditional = /^SMC-STRUCTURE-PLAN-[12]:/.test(id);
    if (!conditional) return { required: false };
    const p = this.snapshot?.results?.find(r => r.symbol === symbol)?.structurePlans?.find(p => p.id === id && p.direction === direction);
    const r = Object.values(this.state.records).find(r => r.plan.id === id);
    if (r?.supersededBy) return { required:true,ready:false,reason:'CONDITIONAL_SOURCE_SUPERSEDED' };
    if (r?.terminal) return { required: true, ready: false, reason: r.terminal.reason };
    if (!this.available || !p || p.expiresAt <= now) return { required: true, ready: false, reason: 'CONDITIONAL_SOURCE_EXPIRED' };
    const family = this.state.records[planFamilyKey(p)];
    return family?.terminal ? { required: true, ready: false, reason: family.terminal.reason }
      : { required: true, ready: true, plan: p };
  }
}
