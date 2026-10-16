import { fresh, invariant } from './common.mjs';

const REFRESH_INTERVAL_MS = 20000;
const USABLE_LIFETIME_MS = 30000;

// Entry-only metadata. Refresh owns the network work; read never performs I/O
// or waits on a pending request. Source timestamps are never renewed here.
export class EntryCalendarCache {
  constructor({ load, now = Date.now }) {
    invariant(typeof load === 'function' && typeof now === 'function', 'CALENDAR_CACHE_PORT_INVALID');
    Object.assign(this, { load, now });
    this.value = null; this.attemptedAt = null; this.completedAt = null; this.successfulAt = null;
    this.pending = null; this.error = 'CALENDAR_NOT_READ';
  }
  read() {
    if (!this.value || this.error || !fresh(this.successfulAt, this.now(), USABLE_LIFETIME_MS)) return null;
    return structuredClone(this.value);
  }
  status() {
    return { attemptedAt: this.attemptedAt, completedAt: this.completedAt,
      inFlight: !!this.pending, error: this.pending ? 'CALENDAR_REFRESH_PENDING'
        : this.error ?? (fresh(this.successfulAt, this.now(), USABLE_LIFETIME_MS) ? null : 'CALENDAR_CACHE_STALE') };
  }
  async refresh() {
    if (this.pending) return this.pending;
    const at = this.now();
    invariant(Number.isSafeInteger(at) && at > 0, 'CALENDAR_CACHE_CLOCK_INVALID');
    if (fresh(this.attemptedAt, at, REFRESH_INTERVAL_MS)) return;
    // Keep the last successful immutable value readable while the replacement
    // is in flight. The 20s refresh lead leaves 10s before its fixed 30s
    // usability deadline; a failure still invalidates immediately.
    this.attemptedAt = at; this.completedAt = null;
    this.pending = Promise.resolve().then(async () => {
      try {
        const value = await this.load(), completedAt = this.now();
        invariant(value && typeof value === 'object' && !Array.isArray(value), 'CALENDAR_RESPONSE_INVALID');
        invariant(fresh(at, completedAt, USABLE_LIFETIME_MS), 'CALENDAR_REFRESH_STALE');
        this.value = structuredClone(value); this.successfulAt = at; this.error = null;
      } catch { this.value = null; this.successfulAt = null; this.error = 'CALENDAR_UNAVAILABLE'; }
      finally {
        const completedAt = this.now();
        this.completedAt = Number.isSafeInteger(completedAt) && completedAt > 0 ? completedAt : null;
      }
    });
    try { await this.pending; } finally { this.pending = null; }
  }
}
