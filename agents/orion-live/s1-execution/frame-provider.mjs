import { isDeepStrictEqual } from 'node:util';
import { entryConfirmationPolicy as expectedEntryConfirmationPolicy } from '../../shared/entry-confirmation.mjs';
import { simpleAdmission } from '../../shared/px-band-risk-only.mjs';
import { executionSignal, entryEventGate } from './signal-adapter.mjs';
import { UNIVERSE, REVISION, invariant, fresh } from './common.mjs';
import { BACKGROUND_READ_REASONS } from './read-eligibility.mjs';
import { CoordinatedReadSession } from './coordinated-read-session.mjs';
import { IQ1_REVISION, buildIq1Correlation, freezeIq1Context, iq1Anchor } from '../../orion-v2/paper/iq1-entry-quality.mjs';
import { pxFirstCloseSignal } from '../../shared/px-first-close.mjs';

const FEE_REFRESH_MS = 240000, FEE_SLOT_MS = FEE_REFRESH_MS / UNIVERSE.length;
const FEE_ERRORS = new Set(['PROBE_BACKGROUND_READ_DEFERRED', 'READ_BUDGET_LOCAL_WEIGHT',
  'READ_BUDGET_IP_HEADROOM', 'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN',
  'SHARED_BUDGET_UNAVAILABLE', 'SHARED_BUDGET_HALT_REVIEW_REQUIRED',
  ...BACKGROUND_READ_REASONS.map(reason => `PROBE_READ_${reason}`)]);
const diagnosticTime = value => Number.isSafeInteger(value) && value > 0 ? value : null;

// Explicit ports avoid importing the local paper daemon, its account, env or
// runtime history. Cached inputs keep their ORIGINAL observation timestamps.
export class ExecutionFrameProvider {
  constructor({ accountCache, publicStreams, strategy, loadCandidates, loadCalendar, loadRules, loadFees, loadBars, canReadFees = () => true, feeReadSession = null, loadAdmittedFees = null, ageRuleTargets = false, assertContextReadable = () => {}, infrastructure, entryQualityProfile = null, entryQualityLoadedAt = null, entryConfirmationPolicy = null, now = Date.now }) {
    invariant(strategy?.implementationRevision === REVISION, 'FRAME_STRATEGY_REVISION_MISMATCH');
    invariant(typeof ageRuleTargets === 'boolean', 'FRAME_RULE_TARGET_POLICY_INVALID');
    invariant(feeReadSession === null ? loadAdmittedFees === null
      : feeReadSession instanceof CoordinatedReadSession && typeof loadAdmittedFees === 'function', 'FRAME_COORDINATED_FEE_PORTS');
    invariant(entryQualityProfile === null || (entryQualityProfile.revision === IQ1_REVISION
      && Number.isFinite(entryQualityLoadedAt) && entryQualityLoadedAt > 0), 'FRAME_ENTRY_QUALITY_CONFIGURATION');
    Object.assign(this, { accountCache, publicStreams, strategy, loadCandidates, loadCalendar, loadRules, loadFees, loadBars, canReadFees, infrastructure, now });
    this.assertContextReadable = assertContextReadable;
    this.ageRuleTargets = ageRuleTargets;
    this.rules = {}; this.fees = {}; this.bars = {}; this.refreshed = new Map(); this.refreshing = null;
    this.feeEpoch = this.now(); this.nextFeeSlotAt = this.feeEpoch; this.feeAttempted = new Map();
    this.feeRefreshing = null;
    this.feeResults = new Map();
    this.feeDispatchAttempts = [];
    this.feeReadSession = feeReadSession; this.loadAdmittedFees = loadAdmittedFees;
    this.queuedFee = null; this.feeQueueRelease = new Map();
    invariant(simpleAdmission(strategy.signal) === simpleAdmission(entryQualityProfile), 'FRAME_ADMISSION_POLICY_MISMATCH');
    this.entryQualityProfile = entryQualityProfile; this.entryQualityLoadedAt = entryQualityLoadedAt;
    invariant(entryConfirmationPolicy === null || isDeepStrictEqual(entryConfirmationPolicy, expectedEntryConfirmationPolicy('S1')),
      'FRAME_ENTRY_CONFIRMATION_POLICY_INVALID');
    this.entryConfirmationPolicy = entryConfirmationPolicy === null ? null : Object.freeze({ ...entryConfirmationPolicy });
    this.iq1Contexts = new Map();
    this.lastCandidatePlans = new Map();
    this.lastGoodCandidateAt = null;
  }
  noteFeeResult(symbol, attemptedAt, outcome, error = null) {
    // Process-local fixed-universe telemetry. It must never retry, change the
    // scheduler or renew evidence, even when diagnostic construction fails.
    try {
      if (!UNIVERSE.includes(symbol)) return;
      const code = outcome === 'FAILED' ? (FEE_ERRORS.has(error?.message) ? error.message : 'FEE_READ_FAILED') : outcome;
      this.feeResults.set(symbol, { attemptedAt: diagnosticTime(attemptedAt),
        completedAt: outcome === 'PENDING' ? null : diagnosticTime(this.now()), outcome: code });
    } catch { /* Telemetry cannot change admission or fee evidence. */ }
  }
  feeDiagnostics() {
    return { schemaVersion: 1, processLocal: true, nextSlotAt: diagnosticTime(this.nextFeeSlotAt),
      symbols: UNIVERSE.map(symbol => ({ symbol, observedAt: diagnosticTime(this.fees[symbol]?.observedAt),
        ...(this.feeResults.get(symbol) ?? { attemptedAt: null, completedAt: null, outcome: 'NOT_ATTEMPTED' }) })) };
  }
  async refreshEntryContext() {
    // Compatibility helper for one-shot callers. Resident supervision uses the
    // two lanes separately so slow rules/bars cannot postpone a fee slot.
    await Promise.all([this.refreshFees(), this.refreshMarketContext()]);
  }
  async refreshFees() {
    if (this.feeRefreshing) return this.feeRefreshing;
    this.feeRefreshing = this.runFeeRefresh();
    try { await this.feeRefreshing; } finally { this.feeRefreshing = null; }
  }
  async runFeeRefresh() {
    if (this.feeReadSession) return this.runCoordinatedFeeRefresh();
    // Pre-dispatch advisory deferral leaves the symbol and slot pending for the
    // next supervised pulse. Once loadFees is called, even a rejection consumes
    // the slot: unknown network outcomes are never refunded or retried in place.
    // Delayed eligibility can bunch absolute slots, so additionally preserve the
    // old envelope of at most three dispatch attempts in any 65-second window.
    const feeAt = this.now();
    if (feeAt < this.nextFeeSlotAt) return;
    this.feeDispatchAttempts = this.feeDispatchAttempts.filter(at => feeAt - at < 65000);
    if (this.feeDispatchAttempts.length >= 3) return;
    const due = UNIVERSE.filter(symbol => !fresh(this.refreshed.get(`fee:${symbol}`), feeAt, FEE_REFRESH_MS))
      .sort((a, b) => (this.feeAttempted.get(a) ?? -1) - (this.feeAttempted.get(b) ?? -1) || UNIVERSE.indexOf(a) - UNIVERSE.indexOf(b));
    if (due.length) {
      const symbol = due[0];
      try {
        if (this.canReadFees() !== true) {
          this.noteFeeResult(symbol, feeAt, 'FAILED', new Error('PROBE_BACKGROUND_READ_DEFERRED'));
          return;
        }
      } catch (error) {
        this.noteFeeResult(symbol, feeAt, 'FAILED', error);
        return;
      }
      this.nextFeeSlotAt = this.feeEpoch + (Math.floor((feeAt - this.feeEpoch) / FEE_SLOT_MS) + 1) * FEE_SLOT_MS;
      this.feeDispatchAttempts.push(feeAt);
      this.feeAttempted.set(symbol, feeAt);
      this.noteFeeResult(symbol, feeAt, 'PENDING');
      try {
        this.fees[symbol] = await this.loadFees(symbol); this.refreshed.set(`fee:${symbol}`, feeAt);
        this.noteFeeResult(symbol, feeAt, 'SUCCESS');
      } catch (error) {
        // The original fee timestamp remains; entry gates reject missing/stale fees.
        this.noteFeeResult(symbol, feeAt, 'FAILED', error);
      }
    }
  }
  async runCoordinatedFeeRefresh() {
    // Explicit opt-in only. Production still uses the legacy branch until all
    // three producers and their v2 lifecycle are wired and accepted together.
    const lifecycle = this.feeReadSession.status();
    invariant(lifecycle.started && !lifecycle.stopping, 'COORDINATED_SESSION_STOPPED');
    const at = this.now();
    this.feeDispatchAttempts = this.feeDispatchAttempts.filter(t => at - t < 65000);
    if (!this.queuedFee) {
      const byAttempt = (a, b) => (this.feeAttempted.get(a) ?? -1) - (this.feeAttempted.get(b) ?? -1)
        || UNIVERSE.indexOf(a) - UNIVERSE.indexOf(b);
      const due = UNIVERSE.filter(s => !fresh(this.refreshed.get(`fee:${s}`), at, FEE_REFRESH_MS)).sort(byAttempt);
      // Announce known due work even while its slot/window is unavailable.
      // Waiting to register until a completion-relative pulse after the slot
      // adds another rounded ten-second release delay. Announcing is not I/O:
      // eligibleAt and the dispatch guards below retain every original limit.
      // When all symbols are fresh, announce the first known upcoming refresh
      // before it is due. The 65s scheduling lead is not a freshness extension.
      const symbol = due[0] ?? [...UNIVERSE].sort((a, b) => this.refreshed.get(`fee:${a}`) - this.refreshed.get(`fee:${b}`) || byAttempt(a, b))[0];
      const eligibleAt = Math.max(at, this.nextFeeSlotAt, (this.feeQueueRelease.get(symbol) ?? -1) + 1,
        due.length ? at : this.refreshed.get(`fee:${symbol}`) + FEE_REFRESH_MS + 1,
        this.feeDispatchAttempts.length >= 3 ? this.feeDispatchAttempts[0] + 65000 : at);
      const readyAt = this.feeEpoch + Math.ceil((eligibleAt - this.feeEpoch) / 10000) * 10000;
      const deadlineAt = this.fees[symbol] ? Math.max(0, this.fees[symbol].observedAt + 300000 - 65000) : this.feeEpoch;
      const handle = this.feeReadSession.prepare(`shadow:fee:${symbol.toLowerCase()}`, { readyAt, deadlineAt });
      this.feeQueueRelease.set(symbol, readyAt); this.queuedFee = { symbol, handle, readyAt, deadlineAt };
    }
    const queued = this.queuedFee;
    if (at < queued.readyAt || at < this.nextFeeSlotAt || this.feeDispatchAttempts.length >= 3) return;
    let dispatchedAt = null;
    try {
      const result = await this.feeReadSession.execute(queued.handle, admission => {
        // This callback is reached only after atomic shared admission. WAIT
        // neither constructs a signing transport nor consumes a fee slot.
        dispatchedAt = this.now();
        this.nextFeeSlotAt = this.feeEpoch + (Math.floor((dispatchedAt - this.feeEpoch) / FEE_SLOT_MS) + 1) * FEE_SLOT_MS;
        this.feeDispatchAttempts.push(dispatchedAt); this.feeAttempted.set(queued.symbol, dispatchedAt);
        this.noteFeeResult(queued.symbol, dispatchedAt, 'PENDING');
        return this.loadAdmittedFees(queued.symbol, admission);
      });
      if (result.status === 'WAIT') return;
      this.queuedFee = null;
      invariant(!this.feeReadSession.status().stopping, 'COORDINATED_SESSION_STOPPED');
      this.fees[queued.symbol] = result.value; this.refreshed.set(`fee:${queued.symbol}`, dispatchedAt);
      this.noteFeeResult(queued.symbol, dispatchedAt, 'SUCCESS');
    } catch (error) {
      // A sent failure rotates at the next original slot; no automatic replay.
      // The session also discards a successful but post-stop late response.
      this.queuedFee = null; this.noteFeeResult(queued.symbol, dispatchedAt ?? at, 'FAILED', error);
    }
  }
  async refreshMarketContext() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const observedAt = this.now();
      if (!fresh(this.refreshed.get('rules'), observedAt, 240000)) {
        try {
          this.assertContextReadable();
          // Queue urgency follows the original evidence clock across failed
          // refreshes. It is not the caller-owned complete window's cutoff.
          const prior = this.refreshed.get('rules');
          const target = prior == null ? this.feeEpoch : Math.max(0, prior + 300000 - 65000);
          const rules = await (this.ageRuleTargets ? this.loadRules({ schedulingTargetAt: Math.min(observedAt, target) }) : this.loadRules());
          this.assertContextReadable();
          this.rules = rules; this.refreshed.set('rules', observedAt);
        }
        catch { /* Existing timestamps will expire; never label failed refresh current. */ }
      }
      // Bars stay serial and coalesced within their own supervised lane.
      for (const symbol of UNIVERSE) {
        if (!fresh(this.refreshed.get(`bars:${symbol}`), this.now(), 30000)) {
          try {
            this.assertContextReadable();
            const bars = await this.loadBars(symbol);
            this.assertContextReadable();
            for (const list of [bars.bars1h, bars.bars15m]) invariant(Array.isArray(list) && list.length <= 1500 && list.every((bar, index) => Number.isFinite(bar.openTime) && bar.closeTime <= this.now() && bar.closeTime > bar.openTime && (index === 0 || bar.openTime > list[index - 1].closeTime)), 'CLOSED_BARS_INVALID');
            this.bars[symbol] = bars; this.refreshed.set(`bars:${symbol}`, observedAt);
          } catch { /* Missing bar history never becomes fabricated signal evidence. */ }
        }
      }
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }
  async read({ forceAccountRefresh = false } = {}) {
    // Context refresh runs as a separate resident task, not on the exit/protect
    // path. Startup with empty context is safe: no signal can pass preflight.
    const current = await this.accountCache.read({ force: forceAccountRefresh });
    const signals = [], candidateEvaluations = [], entryQuality = {};
    const market = this.publicStreams.market();
    let calendar = null;
    if (!simpleAdmission(this.entryQualityProfile)) {
      try { calendar = await this.loadCalendar(); } catch { /* Legacy policy pauses entries on missing calendar. */ }
    }
    let candidateSource = { state: 'UNAVAILABLE', reason: 'CANDIDATE_SOURCE_NOT_CHECKED',
      observedAt: null, checkedAt: this.now(), candidateCount: null, lastGoodAt: this.lastGoodCandidateAt };
    try {
      const candidates = await this.loadCandidates();
      candidateSource.observedAt = diagnosticTime(candidates?.observedAt);
      invariant(fresh(candidates.observedAt, this.now(), 180000) && Array.isArray(candidates.plans) && candidates.plans.length <= 200, 'SCANNER_SNAPSHOT_INVALID');
      const seen = new Set(), currentCandidatePlans = new Map();
      for (const plan of candidates.plans) {
        if (!UNIVERSE.includes(plan.symbol)) continue;
        invariant(!seen.has(plan.id), 'SCANNER_DUPLICATE_PLAN'); seen.add(plan.id);
        currentCandidatePlans.set(plan.id, plan);
        if (!this.bars[plan.symbol]) {
          candidateEvaluations.push({ id: plan.id, symbol: plan.symbol, direction: ['LONG', 'SHORT'].includes(plan.direction) ? plan.direction : null,
            intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice,
            stage: 'SIGNAL_CONFIRMATION', reason: 'ENTRY_BARS_UNAVAILABLE', terminal: false, evaluatedAt: this.now() });
          continue;
        }
        try {
          if (this.entryQualityProfile && !simpleAdmission(this.entryQualityProfile)) {
            if (this.now() < plan.intersectionTime) this.publicStreams.watchIntersection?.(plan.id, plan.symbol, plan.intersectionTime);
            if (!this.iq1Contexts.has(plan.id)) {
              const causalObservedAt = Math.min(candidates.observedAt,
                Math.floor(plan.intersectionTime / 900000) * 900000 - 1);
              const context = freezeIq1Context(plan, this.bars[plan.symbol].bars15m,
                this.entryQualityProfile, causalObservedAt);
              if (context) this.iq1Contexts.set(plan.id, context);
            }
          }
          const result = executionSignal(plan, this.bars[plan.symbol].bars15m, this.strategy, this.now());
          if (result.accepted) {
            signals.push(result.signal);
            if (this.entryQualityProfile) {
              const pair = simpleAdmission(this.entryQualityProfile) ? null : this.publicStreams.intersectionAnchor?.(plan.id);
              const convert = row => row ? { tradeId: row.updateId, price: Number(row.price), marketTime: row.marketTime,
                receivedAt: row.receivedAt, epoch: row.epoch, sequence: row.sequence } : null;
              const epoch = market[plan.symbol]?.tick?.epoch ?? pair?.epoch ?? null;
              const anchor = simpleAdmission(this.entryQualityProfile) ? null : iq1Anchor(this.iq1Contexts.get(plan.id), convert(pair?.trade),
                convert(pair?.previous), epoch, this.entryQualityProfile);
              entryQuality[plan.id] = { profile: this.entryQualityProfile, loadedAt: this.entryQualityLoadedAt,
                epoch, anchor, context: this.iq1Contexts.get(plan.id), plan: result.signal.iq1Plan,
                bars: this.bars[plan.symbol].bars15m, bars1h: this.bars[plan.symbol].bars1h, barIntervalMs: 900000 };
            }
          } else {
            candidateEvaluations.push({ id: plan.id, symbol: plan.symbol, direction: ['LONG', 'SHORT'].includes(plan.direction) ? plan.direction : null,
              intersectionTime: plan.intersectionTime, intersectionPrice: plan.intersectionPrice,
              stage: 'SIGNAL_CONFIRMATION', reason: result.reason, terminal: result.terminal === true, evaluatedAt: this.now() });
          }
        } catch (error) {
          candidateEvaluations.push({ id: plan.id, symbol: plan.symbol, stage: 'SIGNAL_CONFIRMATION',
            reason: error.message, terminal: false, evaluatedAt: this.now() });
        }
      }
      for (const previous of this.lastCandidatePlans.values()) {
        if (currentCandidatePlans.has(previous.id)) continue;
        const previousCreatedAt = Number(previous.createdAt);
        const previousSignal = pxFirstCloseSignal(previous);
        const winner = !previousSignal.accepted && !previousSignal.terminal ? signals.filter(signal => signal.symbol === previous.symbol
          && Number.isFinite(previousCreatedAt) && Number(signal.discoveredAt) > previousCreatedAt)
          .sort((a, b) => Number(a.closedAt) - Number(b.closedAt)
            || Number(a.discoveredAt) - Number(b.discoveredAt)
            || String(a.id).localeCompare(String(b.id)))[0] ?? null : null;
        const previousDirection = previous.pxEntryState?.direction === 1 ? 'LONG'
          : previous.pxEntryState?.direction === -1 ? 'SHORT'
            : ['LONG', 'SHORT'].includes(previous.direction) ? previous.direction : null;
        candidateEvaluations.push({ id: previous.id, symbol: previous.symbol,
          direction: previousDirection,
          intersectionTime: previous.intersectionTime, intersectionPrice: previous.intersectionPrice,
          stage: 'CANDIDATE_LIFECYCLE', reason: winner ? 'NEWER_READY_CANDIDATE_WON_ENTRY_RACE' : 'CANDIDATE_REMOVED',
          replacementPlanId: winner?.id ?? null, terminal: true, evaluatedAt: this.now() });
        this.iq1Contexts.delete(previous.id);
      }
      signals.sort((a, b) => Number(a.closedAt) - Number(b.closedAt)
        || Number(a.intersectionTime) - Number(b.intersectionTime)
        || String(a.id).localeCompare(String(b.id)));
      // Commit the comparison base only after a complete candidate read. A
      // failed scanner read is not evidence that any previous plan disappeared.
      this.lastCandidatePlans = currentCandidatePlans;
      this.lastGoodCandidateAt = candidates.observedAt;
      candidateSource = { state: 'READY', reason: null, observedAt: candidates.observedAt,
        checkedAt: this.now(), candidateCount: candidates.plans.length, lastGoodAt: this.lastGoodCandidateAt };
    } catch (error) {
      signals.length = 0; candidateEvaluations.length = 0;
      candidateSource = { ...candidateSource, checkedAt: this.now(),
        reason: /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.message ?? '') ? error.message : 'CANDIDATE_SOURCE_READ_FAILED' };
    }
    if (this.entryQualityProfile && !simpleAdmission(this.entryQualityProfile)) {
      let correlation;
      try { correlation = buildIq1Correlation(this.bars, UNIVERSE, this.entryQualityProfile, this.now(), this.now()); }
      catch { correlation = { valid: false, reason: 'CORRELATION_UNKNOWN', receivedAt: this.now() }; }
      for (const value of Object.values(entryQuality)) value.correlation = correlation;
    }
    return { ...current, market, signals, candidateEvaluations, candidateSource, rules: this.rules, fees: this.fees, entryQuality, entryConfirmationPolicy: this.entryConfirmationPolicy,
      bars: Object.fromEntries(UNIVERSE.map(symbol => [symbol, this.bars[symbol] ?? { bars1h: [], bars15m: [] }])),
      eventGate: entryEventGate(calendar, this.now(), this.entryQualityProfile), ...await this.infrastructure() };
  }
}
