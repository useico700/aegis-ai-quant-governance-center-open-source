import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { invariant } from './common.mjs';
import { readIncomeWindow } from './history-reader.mjs';
import { ExecutionFrameProvider } from './frame-provider.mjs';

const CYCLE_ERROR_CODES = new Set(['READ_BUDGET_LOCAL_WEIGHT', 'READ_BUDGET_IP_HEADROOM',
  'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN', 'READ_BUDGET_BATCH_EXPIRED',
  'SHARED_BUDGET_UNAVAILABLE', 'SHARED_BUDGET_HALT_REVIEW_REQUIRED',
  'ACCOUNT_SNAPSHOT_STALE', 'ACCOUNT_READ_TOO_SLOW', 'ACCOUNT_RESPONSE_INCOMPLETE',
  'ACCOUNT_COORDINATED_READ_DEFERRED', 'ACCOUNT_COORDINATED_READ_FAILED', 'COORDINATED_SESSION_STOPPED']);
const cycleErrorCode = value => CYCLE_ERROR_CODES.has(value) ? value : 'EXECUTION_CYCLE_FAILED';
// Coordinated read windows may legitimately remain active for up to 150s.
// Keep the watchdog beyond that bounded horizon so it detects a real stall
// instead of terminating an in-flight account/history reconciliation.
export const RESIDENT_STARTUP_STALL_MS = 180000;
export const RESIDENT_STEADY_STALL_MS = 180000;
export const residentIsStalled = ({ now, startedAt, lastCycleAt }) =>
  now - (lastCycleAt ?? startedAt) > (lastCycleAt === null ? RESIDENT_STARTUP_STALL_MS : RESIDENT_STEADY_STALL_MS);

// Bounded serial coordinator, no credentials or automatic activation. A host
// adapter must inject all ports and owns process supervision. The public flush
// loop is independent of slower REST cycles; only the cycle writes the ledger.
export class S2Resident {
  constructor({ engine, book, publicStreams, accountStream, transport, publishStatus, activityMonitor = null, refreshContext = async () => {}, refreshFees = null, refreshCalendar = null, priceFrame = null, now = Date.now, onStall = () => {}, shutdownTimeoutMs = 30000, resumeQueuedAccounts = false, coordinatedFeeProvider = null }) {
    invariant(Number.isInteger(shutdownTimeoutMs) && shutdownTimeoutMs > 0 && shutdownTimeoutMs <= 30000, 'RESIDENT_SHUTDOWN_TIMEOUT_INVALID');
    invariant(typeof resumeQueuedAccounts === 'boolean' && (!resumeQueuedAccounts || engine.mode === 'OBSERVE')
      && (coordinatedFeeProvider === null || (engine.mode === 'OBSERVE' && coordinatedFeeProvider instanceof ExecutionFrameProvider
        && coordinatedFeeProvider.feeReadSession)), 'RESIDENT_COORDINATED_SCHEDULING_INVALID');
    this.resumeQueuedAccounts = resumeQueuedAccounts; this.coordinatedFeeProvider = coordinatedFeeProvider;
    invariant(priceFrame === null || typeof priceFrame === 'function', 'PRICE_FRAME_PORT_INVALID');
    Object.assign(this, { engine, book, publicStreams, accountStream, transport, publishStatus, activityMonitor, refreshContext, refreshFees, refreshCalendar, priceFrame, now, onStall, shutdownTimeoutMs });
    this.pendingGaps = []; this.gapOverflow = false; this.stopped = true;
    this.lastCycleAt = null; this.lastResult = null; this.lastIncomePoll = null;
    this.cycleDiagnostic = null; this.cyclePhase = 'IDLE'; this.currentCycleStartedAt = null; this.delayReportedFor = null;
    this.tasks = new Map(); this.timers = new Map(); this.runners = new Map(); this.closed = false;
  }
  noteGap(gap) {
    if (this.pendingGaps.length >= 64) { this.gapOverflow = true; return; }
    this.pendingGaps.push({ type: gap.type, reason: gap.reason ?? gap.type, at: gap.at });
  }
  async reconcileIncome() {
    if (this.engine.mode !== 'LIVE' || !this.book.positions.size || this.now() - (this.lastIncomePoll ?? 0) < 60000) return;
    const first = Math.min(...[...this.book.positions.values()].map(p => p.openedAt));
    const watermark = this.book.control.get('incomeWatermark') ?? first;
    // Never silently skip a >7-day outage. Catch up in bounded windows, and
    // overlap the preceding day to include late exchange income facts.
    const start = Math.max(first, watermark - 86400000), end = Math.min(this.now(), start + 7 * 86400000);
    const rows = await readIncomeWindow(this.transport, start, end);
    for (const row of rows) await this.book.recordIncome(row);
    await this.book.setControl('incomeWatermark', end);
    for (const plan of this.engine.kernel.plans.values()) {
      if (!this.book.positions.has(plan.id)) continue;
      const position = this.book.rebuild(plan); if (position) await this.book.save(position);
    }
    this.lastIncomePoll = this.now();
  }
  async drainGaps() {
    let batch = this.book.control.get('residentGapBatch');
    if (!batch) {
      const gaps = this.pendingGaps.splice(0), overflow = this.gapOverflow; this.gapOverflow = false;
      if (!gaps.length && !overflow) return;
      batch = { targetCount: (this.book.control.get('evidenceGapCount') ?? 0) + gaps.length + Number(overflow),
        last: gaps.at(-1) ?? { type: 'GAP_QUEUE_OVERFLOW', at: this.now() } };
      try { await this.book.setControl('residentGapBatch', batch); }
      catch (error) {
        for (const gap of gaps) this.noteGap(gap);
        this.gapOverflow ||= overflow;
        throw error;
      }
    }
    // The target count is absolute, not an increment on replay. A crash after
    // any of these commits resumes the same batch without losing the gap.
    for (const p of this.book.positions.values()) if (p.status === 'OPEN') await this.book.save({ ...p, evidenceGap: true, promotionStatisticsEligible: false });
    await this.book.setControl('lastEvidenceGap', batch.last);
    await this.book.setControl('evidenceGapCount', batch.targetCount);
    await this.book.setControl('residentGapBatch', null);
  }
  cycleOnce() {
    invariant(!this.closed, 'RESIDENT_CLOSED');
    invariant(!this.cycling, 'RESIDENT_CONCURRENT_CYCLE'); this.cycling = true;
    this.cyclePromise = Promise.resolve(this.pricePromise).then(() => this.runCycle()).finally(() => { this.cycling = false; });
    return this.cyclePromise;
  }
  async runCycle() {
    const startedAt = this.now(); this.currentCycleStartedAt = startedAt;
    try {
      this.cyclePhase = 'GAP_DRAIN';
      await this.drainGaps();
      this.cyclePhase = 'ACTIVITY_COMMIT';
      await this.activityMonitor?.commit();
      this.cyclePhase = 'ENGINE_CYCLE';
      this.lastResult = await this.engine.cycle();
      // Use this cycle's result, never engine.lastError left over from an earlier
      // failure. A successful OBSERVE return does not reset that legacy field.
      this.cycleDiagnostic = { startedAt, completedAt: this.now(),
        error: this.lastResult?.error == null ? null : cycleErrorCode(this.lastResult.error) };
      // Funding failure must not prevent protection/account sync above.
      this.cyclePhase = 'INCOME_RECONCILIATION';
      try { await this.reconcileIncome(); this.incomeError = null; }
      catch { this.incomeError = 'INCOME_RECONCILIATION_REQUIRED'; }
      this.lastCycleAt = this.now();
      this.cyclePhase = 'STATUS_PUBLISH';
      await this.publishStatus(this.status());
      return this.lastResult;
    } catch (error) {
      this.lastFailedPhase = this.cyclePhase;
      this.lastFailedCode = /^[A-Z0-9_]{1,96}$/.test(error?.message ?? '') ? error.message : 'UNCLASSIFIED_CYCLE_FAILURE';
      this.lastResult = { status: 'RESIDENT_CYCLE_FAILED' };
      this.cycleDiagnostic = { startedAt, completedAt: this.now(), error: cycleErrorCode(error?.message) };
      throw error;
    } finally { this.cyclePhase = 'IDLE'; this.currentCycleStartedAt = null; }
  }
  status() {
    const positionStages = [...this.book.positions.values()].filter(position => position.status === 'OPEN').slice(0, 8).map(position => ({
      symbol: position.symbol,
      direction: position.direction === 1 ? 'LONG' : 'SHORT',
      stage: position.secondPartialTaken === true ? 'TAIL' : position.firstPartialTaken === true ? 'ONE_R'
        : position.softLockTaken === true ? 'SOFT' : 'INITIAL',
      quantity: String(position.quantity), originalQuantity: String(position.originalQuantity), stop: String(position.stop),
    }));
    return { schemaVersion: 1, accountLabel: 'S2', mode: this.engine.mode, asOf: this.now(),
      status: this.stopped ? 'STOPPED' : this.lastResult?.status ?? 'STARTING', lastCycleAt: this.lastCycleAt,
      cycleDiagnostic: this.cycleDiagnostic ? { ...this.cycleDiagnostic } : null,
      // Mode alone cannot prove current file authority or submission gates.
      realOrdersAllowed: this.engine.mode === 'OBSERVE' ? false : null,
      orderAuthorizationStatus: this.engine.mode === 'OBSERVE' ? 'DISABLED_BY_MODE' : 'CHECKED_PER_OPERATION_NOT_PROVEN_BY_HEARTBEAT',
      productionMutationAdapterReleased: this.engine.mode === 'OBSERVE' ? false : null,
      accountStream: this.accountStream.status(), publicConnected: this.publicStreams.evidence.connectedAt !== null,
      entryEvaluations: Array.isArray(this.engine.lastEvaluations) ? this.engine.lastEvaluations.slice(0, 100) : [],
      entryBlockers: Array.isArray(this.engine.lastEntryBlockers) ? this.engine.lastEntryBlockers.slice(0, 100) : [],
      candidatePriorities: this.engine.candidatePriorities ?? [],
      candidateSource: this.engine.candidateSource ? { ...this.engine.candidateSource } : null,
      entryIncident: this.engine.incident, incomeError: this.incomeError ?? null,
      contextError: this.contextError ?? null, feeTaskError: this.feeTaskError ?? null, calendarTaskError: this.calendarTaskError ?? null, accountTaskError: this.accountTaskError ?? null,
      profitTaskError: this.profitTaskError ?? null,
      watchdogError: this.watchdogError ?? null,
      cyclePhase: this.cyclePhase, engineCyclePhase: this.engine.cyclePhase ?? 'IDLE',
      accountActivity: this.activityMonitor?.status() ?? null,
      shutdownDrainCompleted: this.shutdownDrainCompleted ?? false,
      openPositions: positionStages.length, positionStages,
      journalSequence: this.book.journal.sequence };
  }
  start({ cycleIntervalMs = 1000 } = {}) {
    invariant(Number.isInteger(cycleIntervalMs) && cycleIntervalMs >= 1000 && cycleIntervalMs <= 15000, 'RESIDENT_CYCLE_INTERVAL_INVALID');
    invariant(!this.closed && this.stopped, 'RESIDENT_ALREADY_STARTED_OR_CLOSED'); this.stopped = false; this.startedAt = this.now();
    this.loop('feed', () => this.publicStreams.pulse(), 100, () => this.noteGap({ type: 'PUBLIC_PULSE_FAILED', at: this.now() }));
    this.loop('account', async () => { await this.accountStream.pulse(); this.accountTaskError = null; }, 1000, () => { this.accountTaskError = 'ACCOUNT_PULSE_FAILED'; });
    this.loop('context', async () => { await this.refreshContext(); this.contextError = null; }, 10000, () => { this.contextError = 'CONTEXT_REFRESH_FAILED'; });
    if (this.refreshFees) this.loop('fees', async () => { await this.refreshFees(); this.feeTaskError = null; }, () => this.feeRetryDelay(), () => { this.feeTaskError = 'FEE_REFRESH_FAILED'; });
    if (this.refreshCalendar) this.loop('calendar', async () => { await this.refreshCalendar(); this.calendarTaskError = null; }, 10000, () => { this.calendarTaskError = 'CALENDAR_REFRESH_FAILED'; });
    if (this.activityMonitor) this.loop('activity', () => this.activityMonitor.poll(), 1000, () => { this.engine.pauseEntries('ACCOUNT_ACTIVITY_POLL_FAILED'); });
    // Quote-only checks do not poll REST. Only an actual reduction goes through
    // the existing fresh-account submission gate. Both paths share one writer.
    if (this.priceFrame) this.loop('profit', async () => {
      if (this.cycling || this.stopped) return;
      const frame = this.priceFrame();
      this.pricePromise = this.engine.managePrices(frame.market, frame.rules);
      try {
        const result = await this.pricePromise;
        this.profitTaskError = null;
        if (result.status === 'PRICE_MANAGEMENT_ACTION') this.wakeLoop('cycle');
      } finally { this.pricePromise = null; }
    }, 500, () => { this.profitTaskError = 'PRICE_MANAGEMENT_FAILED'; });
    this.loop('cycle', () => this.cycleOnce(), () => this.cycleRetryDelay(cycleIntervalMs), () => {
      this.lastResult = { status: 'RESIDENT_CYCLE_FAILED' };
      process.stdout.write(`${JSON.stringify({ status: 'RESIDENT_CYCLE_FAILED', cyclePhase: this.lastFailedPhase ?? 'UNKNOWN',
        error: this.cycleDiagnostic?.error ?? 'EXECUTION_CYCLE_FAILED', cause: this.lastFailedCode ?? 'UNCLASSIFIED_CYCLE_FAILURE' })}\n`);
    });
    this.loop('watchdog', async () => {
      const now = this.now();
      if (this.cycling && Number.isSafeInteger(this.currentCycleStartedAt)
        && now - this.currentCycleStartedAt > 30000 && this.delayReportedFor !== this.currentCycleStartedAt) {
        this.delayReportedFor = this.currentCycleStartedAt;
        process.stdout.write(`${JSON.stringify({ status: 'RESIDENT_CYCLE_DELAYED', cyclePhase: this.cyclePhase,
          engineCyclePhase: this.engine.cyclePhase ?? 'IDLE' })}\n`);
      }
      if (residentIsStalled({ now, startedAt: this.startedAt, lastCycleAt: this.lastCycleAt }))
        await this.onStall({ type: 'RESIDENT_STALLED', at: now });
    }, 5000, () => { this.watchdogError = 'STALL_CALLBACK_FAILED'; });
  }
  cycleRetryDelay(cycleIntervalMs) {
    return this.resumeQueuedAccounts && this.cycleDiagnostic?.error === 'ACCOUNT_COORDINATED_READ_DEFERRED' ? 1000 : cycleIntervalMs;
  }
  feeRetryDelay() {
    const queued = this.coordinatedFeeProvider?.queuedFee;
    return queued ? Math.min(10000, Math.max(1000, queued.readyAt - this.now())) : 10000;
  }
  loop(name, action, delay, onError) {
    const run = () => {
      if (this.stopped || this.tasks.has(name)) return;
      const task = Promise.resolve().then(() => {
        // start() queues the first pulse. close() may fence the resident before
        // that microtask runs; only already-started work belongs in the drain.
        if (!this.stopped) return action();
      }).catch(onError).finally(() => {
        this.tasks.delete(name);
        if (!this.stopped) this.timers.set(name, setTimeout(run, typeof delay === 'function' ? delay() : delay));
      });
      this.tasks.set(name, task);
    };
    this.runners.set(name, run);
    run();
  }
  wakeLoop(name) {
    if (this.stopped || this.tasks.has(name) || !this.runners.has(name)) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(this.runners.get(name), 0));
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true; this.closed = true;
    // Synchronous entry pause precedes awaiting any task. Protective exits are
    // not canceled, and neither this method nor its timeout closes the journal.
    this.engine.pauseEntries?.('RESIDENT_SHUTDOWN');
    this.activityMonitor?.stop();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.closePromise = this.drainShutdown();
    return this.closePromise;
  }
  async drainShutdown() {
    const closures = [this.publicStreams, this.accountStream].map(stream => Promise.resolve().then(() => stream.close()));
    const pending = [...this.tasks.values(), ...closures];
    if (this.cycling) pending.push(this.cyclePromise);
    let timer;
    try {
      const drain = async () => {
        const results = await Promise.allSettled(pending);
        invariant(results.every(result => result.status === 'fulfilled'), 'RESIDENT_SHUTDOWN_TASK_FAILED');
        await this.activityMonitor?.commit();
        // Closing a socket itself emits a coverage gap. Preserve that final
        // gap before the host may close the journal, even with no next cycle.
        do { await this.drainGaps(); }
        while (this.pendingGaps.length || this.gapOverflow || this.book.control.get('residentGapBatch'));
      };
      await Promise.race([
        drain(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('RESIDENT_SHUTDOWN_DRAIN_TIMEOUT')), this.shutdownTimeoutMs); }),
      ]);
      this.shutdownDrainCompleted = true;
    } finally { clearTimeout(timer); }
  }
}
