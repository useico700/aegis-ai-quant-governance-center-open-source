import { UNIVERSE, hash, invariant, fresh } from './common.mjs';
import { AccountActivityLedger, readAccountActivity, reviewAccountActivity } from './account-activity.mjs';

const HOUR = 3600000, INTERVAL = 30000, OVERLAP = 60000, MAX_AGE = 15 * 60000;
// One failed symbol rotates behind the other nine: reserve one whole retry
// round, a shared-budget recovery window and the complete I/O cutoff. This is
// an earlier queue target, never an extension of source freshness or I/O time.
const COVERAGE_LEAD = UNIVERSE.length * INTERVAL + 65000 + 20000;
const key = symbol => `activityCoverage:${symbol}`;
const safeCode = error => /^[A-Z0-9_]{1,96}$/.test(error?.message ?? '') ? error.message : 'ACTIVITY_HISTORY_READ_FAILED';
const TRANSIENT_HISTORY_ERRORS = new Set(['EXCHANGE_READ_FAILED']);

// Background work reads; the resident's
// single commit lane owns all journal appends. No external activity is adopted,
// and a subsequent empty window never clears a durable incident.
export class AccountActivityMonitor {
  #prepared = null; #preparationFault = null; #planningAt = 0; #suppressedSlot = null;
  constructor({ engine, book, transport, transportForWindow = null, prepareTransportForWindow = null, prioritizeCoverage = false, executionReconciliation = false, stream, canPoll = () => true, now = Date.now }) {
    invariant(typeof executionReconciliation === 'boolean', 'ACTIVITY_EXECUTION_POLICY_INVALID');
    invariant(engine.mode === 'OBSERVE' || (engine.mode === 'LIVE' && executionReconciliation), 'ACTIVITY_MONITOR_OBSERVE_ONLY');
    this.executionReconciliation = engine.mode === 'LIVE' && executionReconciliation;
    invariant(transportForWindow === null || typeof transportForWindow === 'function', 'ACTIVITY_WINDOW_TRANSPORT_INVALID');
    invariant(prepareTransportForWindow === null || typeof prepareTransportForWindow === 'function', 'ACTIVITY_WINDOW_PREPARATION_INVALID');
    invariant(typeof prioritizeCoverage === 'boolean', 'ACTIVITY_COVERAGE_POLICY_INVALID');
    Object.assign(this, { engine, book, transport, transportForWindow, prepareTransportForWindow, prioritizeCoverage, stream, canPoll, now });
    this.ledger = new AccountActivityLedger(book.journal, { pauseEntries: reason => engine.pauseEntries(reason) });
    this.attempted = new Map(); this.buffer = null; this.reading = false; this.committing = false; this.stopped = false;
    this.nextAt = 0; this.hint = null; this.hintGeneration = 0; this.lastError = null; this.checks = 0; this.requiredAfter = now();
    this.requiredAfterBySymbol = new Map();
    let legacyHoldActive = false, legacyTransientSeen = false, legacyPermanentSeen = false;
    for (const event of book.journal.events) {
      if (event.type === 'CONTROL_STATE' && event.key === 'entryIncident') {
        legacyHoldActive = event.value === 'ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED';
        legacyTransientSeen = false; legacyPermanentSeen = false;
      } else if (legacyHoldActive && event.type === 'CONTROL_STATE' && event.key.startsWith('activityCoverage:')
        && event.value?.lastError) {
        if (TRANSIENT_HISTORY_ERRORS.has(event.value.lastError)) legacyTransientSeen = true;
        else legacyPermanentSeen = true;
      }
    }
    this.recoverableHistoryIncident = engine.incident === 'ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED'
      && legacyHoldActive && legacyTransientSeen && !legacyPermanentSeen;
    for (const symbol of UNIVERSE) {
      const prior = book.control.get(key(symbol));
      if (!prior) continue;
      invariant(prior.schema === 'S1_ACTIVITY_COVERAGE_V1' && prior.symbol === symbol
        && Number.isSafeInteger(prior.lastAttemptAt) && prior.lastAttemptAt > 0
        && (prior.coveredThrough === null || Number.isSafeInteger(prior.coveredThrough)), 'ACTIVITY_CURSOR_INVALID');
      this.attempted.set(symbol, prior.lastAttemptAt);
      this.nextAt = Math.max(this.nextAt, prior.lastAttemptAt + INTERVAL);
    }
    this.engine.accountActivityGate = false;
  }
  noteStreamEvent(event) {
    if (!event?.connected || ['ACCOUNT_STREAM_RECONCILE_REQUIRED', 'ACCOUNT_EVENT_RECONCILE_REQUIRED'].includes(event.reason)) {
      this.#suppressedSlot = this.nextAt; this.#cancelPrepared();
    }
    if (!event?.connected) { this.engine.accountActivityGate = false; return; }
    if (event.reason === 'ACCOUNT_STREAM_RECONCILE_REQUIRED') { this.requiredAfter = this.now(); this.requiredAfterBySymbol.clear(); this.engine.accountActivityGate = false; return; }
    if (event.reason !== 'ACCOUNT_EVENT_RECONCILE_REQUIRED') return;
    // An event invalidates coverage, not ownership. Only the later REST history
    // and exact durable fills can establish ownership. Exceptional/foreign
    // events retain the observer's durable hold below.
    if (this.executionReconciliation && (event.kind === 'ACCOUNT_UPDATE'
      || (['ORDER_TRADE_UPDATE', 'TRADE_LITE', 'ALGO_UPDATE'].includes(event.kind) && UNIVERSE.includes(event.symbol)))) {
      this.hintGeneration++;
      const symbols = [...new Set([...(Array.isArray(event.symbols) ? event.symbols : []), event.symbol]
        .filter(symbol => UNIVERSE.includes(symbol)))];
      if (symbols.length) for (const symbol of symbols) this.requiredAfterBySymbol.set(symbol, this.now());
      else { this.requiredAfter = this.now(); this.requiredAfterBySymbol.clear(); }
      this.engine.accountActivityGate = false;
      return;
    }
    // This observer has no owned orders. Any authenticated account event merits
    // review; do not infer cause from a prefix or trust free-form event fields.
    this.hintGeneration++; this.requiredAfter = this.now();
    this.hint = { reason: 'ACCOUNT_ACTIVITY_EVENT_REVIEW_REQUIRED', at: this.now(),
      kind: ['ORDER_TRADE_UPDATE', 'TRADE_LITE', 'MARGIN_CALL', 'ACCOUNT_UPDATE', 'ACCOUNT_CONFIG_UPDATE', 'ALGO_UPDATE'].includes(event.kind) ? event.kind : 'OTHER_ACCOUNT_EVENT',
      symbol: UNIVERSE.includes(event.symbol) ? event.symbol : null };
    this.engine.pauseEntries('ACCOUNT_ACTIVITY_EVENT_REVIEW_REQUIRED'); this.engine.accountActivityGate = false;
  }
  ready() {
    return !this.stopped && !this.#preparationFault && !this.hint && !this.buffer && !this.lastError && this.stream.status().connected
      && UNIVERSE.every(symbol => {
        const c = this.book.control.get(key(symbol));
        const requiredAfter = Math.max(this.requiredAfter, this.requiredAfterBySymbol.get(symbol) ?? 0);
        return c?.lastError === null && c.lastAttemptAt >= requiredAfter && c.coveredThrough >= requiredAfter - 2000
          && fresh(c.lastSuccessAt, this.now(), MAX_AGE) && fresh(c.coveredThrough, this.now(), MAX_AGE);
      });
  }
  #select(at) {
    // Missing, invalidated or aging coverage needs the remaining retry runway.
    // Fair oldest-attempt order within that group keeps a failed symbol from
    // monopolizing other urgent symbols. Fresh symbols enter the same group
    // before expiry; no extra polls, timeouts or source freshness are granted.
    const urgent = symbol => {
      const c = this.book.control.get(key(symbol));
      const requiredAfter = Math.max(this.requiredAfter, this.requiredAfterBySymbol.get(symbol) ?? 0);
      return !c || c.lastError !== null || c.lastAttemptAt < requiredAfter
        || c.coveredThrough < requiredAfter - 2000 || !c.lastSuccessAt || !c.coveredThrough
        || at >= Math.min(c.lastSuccessAt, c.coveredThrough) + MAX_AGE - COVERAGE_LEAD;
    };
    return [...UNIVERSE].sort((a, b) => (this.prioritizeCoverage ? Number(urgent(b)) - Number(urgent(a)) : 0)
      || (this.attempted.get(a) ?? 0) - (this.attempted.get(b) ?? 0) || UNIVERSE.indexOf(a) - UNIVERSE.indexOf(b))[0];
  }
  #window(at, symbol = this.#select(at)) {
      const cursor = this.book.control.get(key(symbol));
      const requiredAfter = Math.max(this.requiredAfter, this.requiredAfterBySymbol.get(symbol) ?? 0);
      invariant(!cursor?.coveredThrough || cursor.coveredThrough <= at, 'ACTIVITY_CURSOR_IN_FUTURE');
      const latestEnd = at - 2000;
      // Re-read at least the recent hour to catch delayed records. A longer
      // outage catches up one hour at a time without silently jumping the gap.
      const startTime = cursor?.coveredThrough ? Math.min(latestEnd - HOUR, cursor.coveredThrough - OVERLAP) : latestEnd - HOUR;
      invariant(startTime >= at - 7 * 86400000, 'ACTIVITY_HISTORY_RETENTION_GAP');
      const endTime = Math.min(latestEnd, startTime + HOUR);
      // Keep an aging coverage target independent of the hard per-attempt I/O
      // deadline. Missing coverage is due from the required reconciliation
      // epoch, not twenty seconds after each unsuccessful retry.
      const coverageTargetAt = cursor?.lastSuccessAt && cursor?.coveredThrough
        ? Math.min(cursor.lastSuccessAt, cursor.coveredThrough) + MAX_AGE - COVERAGE_LEAD : requiredAfter;
      const reconciled = cursor?.lastError === null && cursor.lastAttemptAt >= requiredAfter
        && cursor.coveredThrough >= requiredAfter - 2000;
      const schedulingTargetAt = Math.min(at + 20000, coverageTargetAt, reconciled ? Infinity : requiredAfter);
      return Object.freeze({ symbol, at, startTime, endTime, deadlineAt: at + 20000, schedulingTargetAt,
        cursorFingerprint: hash(cursor ?? null) });
  }
  #fingerprint(window) { return hash({ window, requiredAfter: Math.max(this.requiredAfter, this.requiredAfterBySymbol.get(window.symbol) ?? 0), hintGeneration: this.hintGeneration }); }
  #fault() {
    this.#preparationFault = 'ACCOUNT_ACTIVITY_PREPARATION_FAILED';
    this.engine.pauseEntries(this.#preparationFault); this.engine.accountActivityGate = false;
  }
  #cancelPrepared() {
    if (!this.#prepared) return;
    try {
      invariant(typeof this.#prepared.port.cancel() === 'boolean', 'ACTIVITY_WINDOW_CANCEL_INVALID');
      this.#prepared = null;
    } catch { this.#fault(); } // Retain unknown receipt for stop/close cleanup.
  }
  #prepare(at) {
    if (this.#prepared) {
      const p = this.#prepared;
      if (at >= p.window.at + 15000) {
        this.#cancelPrepared(); this.attempted.set(p.window.symbol, at); this.nextAt = at + INTERVAL;
        this.deferred = 'READ_DISPATCH_DEADLINE'; return true;
      }
      if (!this.stream.status().connected || p.fingerprint !== this.#fingerprint(this.#window(p.window.at))) {
        this.#suppressedSlot = this.nextAt; this.#cancelPrepared();
      }
    }
    if (!this.#preparationFault && !this.#prepared && !this.hint && this.stream.status().connected
      && at < this.nextAt && this.nextAt - at <= INTERVAL && this.#suppressedSlot !== this.nextAt) {
      const window = this.#window(this.nextAt), port = this.prepareTransportForWindow(window);
      // Store the cleanup capability before validating its transport.
      this.#prepared = { window, port, fingerprint: this.#fingerprint(window) };
      invariant(port && typeof port.cancel === 'function' && typeof port.transport?.request === 'function', 'ACTIVITY_WINDOW_PREPARATION_INVALID');
    }
    return false;
  }
  async poll() {
    if (this.stopped || this.reading || this.committing || this.buffer) return;
    const at = this.now();
    if (this.prepareTransportForWindow) {
      try {
        invariant(Number.isSafeInteger(at) && at >= this.#planningAt, 'ACTIVITY_PREPARATION_CLOCK');
        this.#planningAt = at;
        if (this.#preparationFault) return;
        if (!this.canPoll()) {
          this.#suppressedSlot = this.nextAt; this.#cancelPrepared();
          this.deferred = 'WAITING_FOR_READ_BUDGET_HEADROOM'; return;
        }
        if (this.#prepare(at)) return;
      } catch { this.#fault(); this.#cancelPrepared(); return; }
      if (this.#preparationFault || !this.stream.status().connected) return;
    }
    if (at < this.nextAt) return;
    if (!this.prepareTransportForWindow && !this.canPoll()) { this.deferred = 'WAITING_FOR_READ_BUDGET_HEADROOM'; return; }
    this.deferred = null;
    const prepared = this.#prepared; this.#prepared = null; this.#suppressedSlot = null;
    this.reading = true; this.nextAt = at + INTERVAL;
    const symbol = prepared?.window.symbol ?? this.#select(at); this.attempted.set(symbol, at);
    try {
      const window = prepared?.window ?? this.#window(at, symbol), { startTime, endTime, deadlineAt, schedulingTargetAt } = window;
      const transport = prepared?.port.transport ?? (this.transportForWindow ? this.transportForWindow({ deadlineAt, schedulingTargetAt }) : this.transport);
      invariant(transport && typeof transport.request === 'function', 'ACTIVITY_WINDOW_TRANSPORT_INVALID');
      const reader = { request: (...args) => {
        invariant(this.now() < deadlineAt, 'ACTIVITY_HISTORY_DEADLINE');
        return transport.request(...args);
      } };
      if (typeof transport.readInitialWindow === 'function') reader.readInitialWindow = params => {
        invariant(this.now() < deadlineAt, 'ACTIVITY_HISTORY_DEADLINE');
        return transport.readInitialWindow(params);
      };
      const snapshot = await readAccountActivity(reader, { symbol, startTime, endTime, now: this.now, maximumRequests: 6, maximumRows: 1000 });
      this.buffer = { symbol, at, snapshot };
    } catch (error) {
      if (['READ_BUDGET_LOCAL_WEIGHT', 'READ_BUDGET_IP_HEADROOM', 'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN',
        'READ_DISPATCH_DEADLINE', 'READ_DISPATCH_STOPPED'].includes(error?.message)) {
        // Local admission can change between preflight and an individual GET.
        // Keep the entire old cursor and retry later; never save a partial window
        // or manufacture an account incident from ordinary scheduling pressure.
        this.deferred = error.message; return;
      }
      if (TRANSIENT_HISTORY_ERRORS.has(error?.message)) {
        // A transport failure proves no history window. Close the in-memory
        // gate and retry the entire unchanged window, but do not convert a
        // bounded network/venue outage into a permanent account-integrity
        // incident. lastError keeps every intervening cycle fail-closed.
        this.lastError = error.message; this.engine.accountActivityGate = false;
        this.deferred = error.message; return;
      }
      this.lastError = safeCode(error); this.engine.accountActivityGate = false;
      this.engine.pauseEntries('ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED');
      this.buffer = { symbol, at, error: this.lastError };
    } finally {
      this.reading = false;
      if (prepared) { this.#prepared = prepared; this.#cancelPrepared(); }
    }
  }
  async commit() {
    invariant(!this.committing, 'ACTIVITY_MONITOR_CONCURRENT_COMMIT'); this.committing = true;
    try {
      if (this.hint) {
        const generation = this.hintGeneration, hint = { ...this.hint };
        this.engine.incident = hint.reason;
        await this.book.setControl('entryIncident', hint.reason);
        await this.book.setControl('lastAccountActivityHint', hint);
        if (generation === this.hintGeneration) this.hint = null;
      }
      const batch = this.buffer;
      if (batch) {
        const prior = this.book.control.get(key(batch.symbol));
        const recoversLegacyTransportHold = !batch.error && prior?.lastError === 'EXCHANGE_READ_FAILED';
        this.recoverableHistoryIncident ||= recoversLegacyTransportHold;
        let next = { schema: 'S1_ACTIVITY_COVERAGE_V1', symbol: batch.symbol, firstWindowStart: prior?.firstWindowStart ?? batch.snapshot?.startTime ?? null,
          coveredThrough: prior?.coveredThrough ?? null, lastSuccessAt: prior?.lastSuccessAt ?? null,
          lastAttemptAt: batch.at, lastError: batch.error ?? null, lastMaterialDigest: prior?.lastMaterialDigest ?? null,
          lastReviewFingerprint: prior?.lastReviewFingerprint ?? null, windowCount: prior?.windowCount ?? 0 };
        if (batch.error) {
          this.engine.incident = 'ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED';
          await this.book.setControl('entryIncident', this.engine.incident);
        } else {
          const review = reviewAccountActivity(batch.snapshot, { kernel: this.engine.kernel, book: this.book });
          if (this.executionReconciliation && review.issues.length
            && review.issues.every(issue => ['OWNED_TRADE_REQUIRES_LEDGER_RECONCILIATION',
              'POTENTIAL_PROTECTIVE_TRADE_REQUIRES_LIFECYCLE_RECONCILIATION'].includes(issue.code))) {
            // Keep this bounded window and re-review after the engine's normal
            // lifecycle reconciliation. Do not advance coverage, invent fills,
            // or persist a permanent incident for an expected ordering race.
            this.engine.accountActivityGate = false;
            return;
          }
          if (review.issues.length) {
            this.engine.pauseEntries('ACCOUNT_ACTIVITY_REVIEW_REQUIRED'); this.engine.incident = 'ACCOUNT_ACTIVITY_REVIEW_REQUIRED';
            await this.book.setControl('entryIncident', this.engine.incident);
          }
          const digest = hash({ facts: review.facts, forced: review.forced, issues: review.issues });
          if ((review.facts.length || review.forced.length || review.issues.length) && digest !== prior?.lastMaterialDigest) {
            await this.ledger.record(review, this.book);
            next.lastMaterialDigest = digest; next.lastReviewFingerprint = review.fingerprint;
          }
          next = { ...next, coveredThrough: batch.snapshot.endTime, lastSuccessAt: this.now(), windowCount: next.windowCount + 1 };
        }
        await this.book.setControl(key(batch.symbol), next);
        this.buffer = null; this.lastError = batch.error ?? null; this.checks++;
        // Releases only the old production latch created from the exact
        // transient code above, and only after a complete later window makes
        // all ten current cursors ready. Other incidents remain durable.
      }
      if (this.#preparationFault && this.book.control.get('entryIncident') !== this.#preparationFault) {
        this.engine.incident = this.#preparationFault;
        await this.book.setControl('entryIncident', this.#preparationFault);
      }
      if (this.recoverableHistoryIncident && this.ready()
        && this.engine.incident === 'ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED'
        && this.book.control.get('entryIncident') === 'ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED') {
        await this.book.setControl('entryIncident', null);
        this.engine.incident = null; this.recoverableHistoryIncident = false;
        this.engine.resumeEntries?.('ACCOUNT_ACTIVITY_HISTORY_UNVERIFIED');
      }
      this.engine.accountActivityGate = this.ready();
    } catch (error) {
      this.engine.pauseEntries('ACCOUNT_ACTIVITY_COMMIT_FAILED'); this.engine.accountActivityGate = false;
      this.lastError = 'ACCOUNT_ACTIVITY_COMMIT_FAILED'; throw error;
    } finally { this.committing = false; }
  }
  stop() { this.stopped = true; this.engine.accountActivityGate = false; this.#cancelPrepared(); }
  status() {
    const coverage = UNIVERSE.map(symbol => { const c = this.book.control.get(key(symbol));
      return { symbol, coveredThrough: c?.coveredThrough ?? null, lastSuccessAt: c?.lastSuccessAt ?? null,
        lastError: c?.lastError ?? null, windowCount: c?.windowCount ?? 0 }; });
    return { mode: this.executionReconciliation ? 'EXECUTION_HISTORY_RECONCILIATION' : 'OBSERVE_HISTORY_REVIEW_ONLY', recentWindowsReady: !!this.ready(), coverage,
      lastError: this.lastError, pendingHint: !!this.hint, pendingResult: !!this.buffer, reading: this.reading,
      deferred: this.deferred ?? null,
      preparationFault: this.#preparationFault,
      preparedWindow: this.#prepared ? { symbol: this.#prepared.window.symbol, readyAt: this.#prepared.window.at, deadlineAt: this.#prepared.window.deadlineAt } : null,
      checksThisProcess: this.checks, facts: this.ledger.facts.size, reports: this.ledger.reports.size,
      projectionBytes: this.ledger.bytes, pollIntervalMs: INTERVAL, rollingRecheckMs: HOUR,
      fullAccountHistoryProven: false, atomicHistoryProven: false, automaticRecoveryAllowed: false };
  }
}
