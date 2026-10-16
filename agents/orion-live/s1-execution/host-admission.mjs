import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import os from 'node:os';
import { SharedReadBudget } from './shared-read-budget.mjs';
import { ReadRequestBudget } from './request-budget.mjs';
import { readBootstrapReceipt, assertBootstrapBudget } from './bootstrap-receipt.mjs';
import { invariant } from './common.mjs';

export const SHARED_READ_ROOT = '/var/lib/aegis/s1-read-admission';

// A stop closes admission synchronously. Outstanding HTTP/body ownership is
// drained, never guessed expired; on timeout the OS owner lock stays held.
export class ResidentReadAdmission {
  constructor(budget) { this.budget = budget; this.pending = new Set(); this.stopping = false; this.closed = false; }
  async run(weight, action) {
    invariant(!this.stopping && !this.closed, 'RESIDENT_READ_ADMISSION_STOPPED');
    const task = this.budget.run(weight, action); this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }
  async runBatch(weights, action) {
    invariant(!this.stopping && !this.closed, 'RESIDENT_READ_ADMISSION_STOPPED');
    const task = this.budget.runBatch(weights, action); this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }
  async runExecutionAccountBatch(weights, action) {
    invariant(!this.stopping && !this.closed, 'RESIDENT_READ_ADMISSION_STOPPED');
    const task = this.budget.consumer === 'SHADOW_RESIDENT'
      ? this.budget.runExecutionAccountBatch(weights, action) : this.budget.runBatch(weights, action);
    this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }
  canStartLowPriorityRead(...args) { return !this.stopping && this.budget.canStartLowPriorityRead(...args); }
  lowPriorityReadDecision(...args) {
    return this.stopping || this.closed ? Object.freeze({ allowed: false, reason: 'STOPPED' })
      : this.budget.lowPriorityReadDecision(...args);
  }
  status() { return { ...this.budget.status(), consumer: this.budget.consumer, residentAdmissionEnrolled: true,
    allIpConsumersVerified: false, stopping: this.stopping }; }
  retainCooldown(until) { this.budget.retainCooldown(until); }
  inheritLegacyState(state) {
    try {
      invariant(state && Buffer.byteLength(JSON.stringify(state)) <= 4096, 'LEGACY_READ_BUDGET_INVALID');
      new ReadRequestBudget({ load: () => state });
      this.budget.retainCooldown(state.blockedUntil);
    } catch {
      this.budget.halt(); throw new Error('LEGACY_READ_BUDGET_INVALID');
    }
  }
  stop() { this.stopping = true; }
  async close(timeoutMs = 30000, { canRelease = () => true } = {}) {
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'RESIDENT_READ_DRAIN_TIMEOUT_INVALID');
    invariant(typeof canRelease === 'function', 'RESIDENT_READ_RELEASE_GUARD_INVALID');
    this.stop(); if (this.closed) return;
    let timer;
    try {
      await Promise.race([Promise.allSettled([...this.pending]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RESIDENT_READ_DRAIN_TIMEOUT')), timeoutMs);
      })]);
      invariant(this.pending.size === 0, 'RESIDENT_READ_DRAIN_INCOMPLETE');
      let allowed = false; try { allowed = canRelease() === true; } catch { /* Do not expose host callback details. */ }
      invariant(allowed, 'RESIDENT_READ_RELEASE_FENCED');
      this.budget.close(); this.closed = true;
    } finally { clearTimeout(timer); }
  }
}

// No path override, auto-bootstrap or fallback to process-local admission.
// A missing/corrupt store stops before production credentials are loaded.
export function assertSharedAdmissionHost() {
  invariant(os.hostname() === 'aegis-demo-host' && process.env.AEGIS_PRODUCTION_HOST_ID === 'demo-server'
    && process.getuid() === 993, 'SHARED_ADMISSION_SERVER_ONLY');
}
export async function openProductionReadAdmission(consumer) {
  assertSharedAdmissionHost();
  const receipt = await readBootstrapReceipt(SHARED_READ_ROOT);
  const budget = await new SharedReadBudget(SHARED_READ_ROOT, consumer).open();
  try { assertBootstrapBudget(budget, receipt); return new ResidentReadAdmission(budget); }
  catch (error) { budget.halt(); budget.close(); throw error; }
}
