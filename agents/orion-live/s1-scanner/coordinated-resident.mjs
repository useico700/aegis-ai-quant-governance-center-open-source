import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import crypto from 'node:crypto';
import { reviewCandidateQueue, S1_CANDIDATE_REVIEW_REVISION } from './candidate-lifecycle.mjs';
import { scannerBarReader, scannerRetryDelay, scannerBudgetStopped, choosePlanQueue, resolveEntryConditionRace, candidateView, accountView, advancePxFirstClose, MAX_RETAINED_PLANS_PER_SYMBOL } from './engine.mjs';
import { evaluateEventGate } from './event-gate.mjs';
import { extractRules, quoteView } from '../../../lib/s1-precision.mjs';
import { CoordinatedPublicReads } from '../s1-execution/coordinated-public-reads.mjs';
import { CoordinatedReadSession } from '../s1-execution/coordinated-read-session.mjs';
import { invariant, UNIVERSE, CANDIDATE_LIFECYCLE_REVISION } from '../s1-execution/common.mjs';

// Pin the reviewed S1 configuration, including the full R22 strategy, rather
// than accepting another domain's policy with a copied revision label.
const CONFIG_SHA256 = 'c80432ed9710aef5f726c5e5466ddf2e88940d517c86f1921ceb0b71d811db08';
export function assertCoordinatedScannerConfig(config, hostname, hostIdentity) {
  invariant(hostname === 'aegis-demo-host' && hostIdentity === 'demo-server'
    && crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') === CONFIG_SHA256,
  'COORDINATED_SCANNER_BOUNDARY');
}

function recoveredState(value) {
  invariant(value?.schemaVersion === 1 && Number.isSafeInteger(value.sequence) && value.sequence >= 0
    && value.sequence < Number.MAX_SAFE_INTEGER && value.plans && !Array.isArray(value.plans)
    && Object.getPrototypeOf(value.plans) === Object.prototype
    && Object.entries(value.plans).every(([symbol, plan]) => UNIVERSE.includes(symbol)
      && plan?.symbol === symbol && typeof plan.id === 'string' && plan.id.length > 0 && plan.id.length <= 200)
    && (value.planQueues === undefined || (value.planQueues && !Array.isArray(value.planQueues)
      && Object.entries(value.planQueues).every(([symbol, plans]) => UNIVERSE.includes(symbol)
        && Array.isArray(plans) && plans.length <= MAX_RETAINED_PLANS_PER_SYMBOL
        && plans.every(plan => plan?.symbol === symbol && typeof plan.id === 'string' && plan.id.length > 0 && plan.id.length <= 200)
        && new Set(plans.map(plan => plan.id)).size === plans.length)))
    && (value.lastCandidates === undefined || (Array.isArray(value.lastCandidates) && value.lastCandidates.length <= 200
      && value.lastCandidates.every(row => UNIVERSE.includes(row?.symbol))
      && new Set(value.lastCandidates.map(row => row.id)).size === value.lastCandidates.length))
    && (value.continuity === undefined || (value.continuity && typeof value.continuity === 'object' && !Array.isArray(value.continuity))),
  'S1_STATE_CORRUPT_NO_RESET');
  const state = structuredClone(value);
  state.planQueues ??= Object.fromEntries(Object.entries(state.plans).map(([symbol, plan]) => [symbol, [plan]]));
  state.continuity = { ...state.continuity, freshScanPending: true };
  return state;
}

// Fixed error codes only. Never persist arbitrary HTTP/parser/file messages.
const reason = error => /^(PUBLIC_COORDINATED_(STOPPED|DEADLINE|READ_FAILED|CLOCK|CANCEL_FAILED)|EXCHANGE_CLOCK_SKEW|(INSUFFICIENT|STALE|GAP)_(15m|1h|4h)_(HISTORY|BARS))$/.test(error?.message)
  ? error.message : 'SCANNER_INPUT_UNAVAILABLE';

export class CoordinatedScannerResident {
  #config; #state; #task = null; #closing = null; #stopped = false; #failed = false; #nextAt = 0; #failures = 0;
  #last = null; #previousPublish = { status: 'NOT_CONFIGURED', at: null }; #abort = new AbortController();
  #reads; #readBars; #session; #now; #ports; #bootId = crypto.randomUUID(); #startedAt; #recovered; #drained = false; #recoveryPublished = false;
  constructor({ config, state = { schemaVersion: 1, sequence: 0, plans: {} }, session, hostname, hostIdentity,
    persistState, persistSnapshot, readAccount, readCalendar = async () => null, publishMonitor = null, archiveRetirements = null,
    now = Date.now, fetcher = fetch, sleep }) {
    assertCoordinatedScannerConfig(config, hostname, hostIdentity);
    invariant(session instanceof CoordinatedReadSession && [persistState, persistSnapshot, readAccount, readCalendar, now].every(p => typeof p === 'function')
      && (publishMonitor === null || typeof publishMonitor === 'function'), 'COORDINATED_SCANNER_PORTS');
    this.#config = structuredClone(config); this.#state = recoveredState(state); this.#recovered = state.sequence > 0;
    this.#session = session; this.#now = now; this.#startedAt = new Date(now()).toISOString();
    this.#ports = { persistState, persistSnapshot, readAccount, readCalendar, publishMonitor, archiveRetirements };
    this.#reads = new CoordinatedPublicReads({ session, consumer: 'scanner', now, fetcher, ...(sleep ? { sleep } : {}) });
    this.#readBars = scannerBarReader(this.#reads.get.bind(this.#reads), { assertReadable: () => this.#reads.assertReadable() });
  }
  #active() { return !this.#stopped && !this.#failed && !this.#session.status().stopping; }
  #schedule(action) {
    invariant(this.#active(), 'COORDINATED_SCANNER_STOPPED');
    if (this.#task) return this.#task;
    const task = Promise.resolve().then(action); this.#task = task;
    task.then(() => { this.#task = null; }, () => { this.#failed = true; this.#task = null; }).catch(() => {});
    return task;
  }
  async #prepareRecovery() {
    if (!this.#active() || this.#recoveryPublished) return;
    // Invalidate the prior HEALTHY projection for downstream readers before
    // READY or any public read. Preserve its sequence, plans and all metadata.
    await this.#ports.persistState(structuredClone(this.#state));
    this.#recoveryPublished = true;
  }
  prepareRecovery() { return this.#schedule(() => this.#prepareRecovery()); }
  pulse() { return this.#schedule(() => this.#run()); }
  async #run() {
    if (!this.#active() || this.#now() < this.#nextAt) return;
    await this.#prepareRecovery();
    if (!this.#active()) return;
    invariant(this.#state.sequence < Number.MAX_SAFE_INTEGER, 'S1_STATE_SEQUENCE_EXHAUSTED');
    const start = this.#now(), next = structuredClone(this.#state), rows = [], errors = [], rules = [], precisionErrors = [], quotes = [], retirements = [], discoveryDiagnostics = [];
    let success = 0;
    this.#reads.beginWindow(start + 150000);
    try {
      const { serverTime } = await this.#reads.get('/fapi/v1/time');
      invariant(Number.isSafeInteger(serverTime) && Math.abs(serverTime - this.#now()) <= 30000, 'EXCHANGE_CLOCK_SKEW');
      try {
        const observedAt = new Date(this.#now()).toISOString();
        const info = await this.#reads.get('/fapi/v1/exchangeInfo');
        for (const symbol of this.#config.universe) {
          try { rules.push(extractRules(info, symbol, observedAt)); }
          catch { precisionErrors.push({ symbol, reason: 'SCANNER_RULES_UNAVAILABLE' }); }
        }
      } catch (error) {
        precisionErrors.push({ symbol: 'ALL', reason: reason(error) });
        if (scannerBudgetStopped(error)) throw error;
      }
      for (const symbol of this.#config.universe) {
        if (!this.#active()) return;
        try {
          const bars = {};
          for (const interval of ['15m', '1h', '4h']) bars[interval] = await this.#readBars(symbol, interval, serverTime);
          try {
            const quote = await this.#reads.get('/fapi/v1/ticker/bookTicker', { symbol });
            quotes.push(quoteView(quote, rules.find(rule => rule.symbol === symbol), symbol, this.#now()));
          } catch (error) {
            quotes.push({ symbol, status: 'UNAVAILABLE', reason: reason(error) });
            if (scannerBudgetStopped(error)) throw error;
          }
          this.#reads.assertReadable();
          const result = reviewCandidateQueue({ symbol, existing: next.planQueues[symbol] ?? (next.plans[symbol] ? [next.plans[symbol]] : []),
            bars15m: bars['15m'], bars1h: bars['1h'], bars4h: bars['4h'], now: serverTime, strategy: this.#config.strategy,
            retiredIds: next.retiredCandidateIds ?? {} });
          this.#reads.assertReadable();
          const rendered = result.queue.map(plan => candidateView(plan, bars['15m'], serverTime, this.#config.strategy));
          if (result.queue.length) { next.planQueues[symbol] = result.queue; next.plans[symbol] = result.queue[0]; }
          else { delete next.planQueues[symbol]; delete next.plans[symbol]; }
          discoveryDiagnostics.push({ symbol, ...result.diagnostics });
          retirements.push(...result.retired);
          rows.push(...rendered.map(row => ({ ...row, observedAt: new Date(start).toISOString(), stale: false })));
          success += 1;
        } catch (error) {
          errors.push({ symbol, reason: reason(error) });
          if (scannerBudgetStopped(error)) break;
        }
      }
    } catch (error) { errors.push({ symbol: 'ALL', reason: reason(error) }); }
    finally { await this.#reads.closeWindow(); }
    if (!this.#active()) return;
    // Include old candidates for failed/unvisited symbols without refreshing
    // their evidence time. A successful no-plan result must not resurrect one.
    const failedAt = new Set(errors.map(row => row.symbol));
    const cutoff = errors.find(row => row.symbol !== 'ALL' && scannerBudgetStopped(new Error(row.reason)))?.symbol;
    for (const old of this.#state.lastCandidates ?? []) if (!rows.some(row => row.id === old.id)
      && (failedAt.has('ALL') || failedAt.has(old.symbol) || (cutoff && this.#config.universe.indexOf(old.symbol) >= this.#config.universe.indexOf(cutoff)))) rows.push({ ...old, stale: true });
    let account = null, calendar = null;
    try { account = await this.#ports.readAccount(); } catch { /* Unknown account remains unknown. */ }
    if (!this.#active()) return;
    try { calendar = await this.#ports.readCalendar(this.#abort.signal); } catch { /* Entry gate fails closed. */ }
    if (!this.#active()) return;
    const sourceAsOf = new Date(start).toISOString(), now = this.#now(), healthy = success === this.#config.universe.length;
    next.sequence += 1; next.lastCandidates = rows; next.lastCycleAt = sourceAsOf;
    if (healthy) { next.lastSuccessfulScanAt = sourceAsOf; next.continuity.freshScanPending = false; }
    this.#failures = healthy ? 0 : this.#failures + 1;
    const snapshot = { schemaVersion: 1, accountLabel: 'S1', runtimeId: this.#config.runtimeId, mode: 'SCAN_ONLY', revision: this.#config.strategy.implementationRevision,
      sourceAsOf, sequence: next.sequence, candidateReviewRevision: S1_CANDIDATE_REVIEW_REVISION, candidateLifecycleRevision: CANDIDATE_LIFECYCLE_REVISION, bootId: this.#bootId, startedAt: this.#startedAt, status: healthy ? 'HEALTHY' : 'DEGRADED',
      lastSuccessfulScanAt: next.lastSuccessfulScanAt ?? null, scanDurationMs: now - start, scannedSymbols: success, universe: this.#config.universe,
      account: accountView(account, now), candidates: rows, discoveryDiagnostics, errors, eventGate: evaluateEventGate(calendar, now),
      precision: { source: 'BINANCE_USDM_MAINNET_EXCHANGE_INFO', rules, errors: precisionErrors, submissionAllowed: false }, marketQuotes: quotes,
      publish: this.#previousPublish, recovery: { restartEnabled: true, stateRecovered: this.#recovered, watchdogSeconds: 180 },
      requestBudget: this.#session.readBudgetStatus(), realOrdersAllowed: false, newEntriesBlocked: true, tickBboExecutionEvidence: false };
    // Once commit starts, drain both writes even if stopping. They represent a
    // complete staged cycle, not an atomic pair: the existing consumer rejects
    // a crash between the two via sequence/time mismatch. Never retry a failed
    // commit in-process, overwrite it with STOPPED, or release its owner as clean.
    if (retirements.length) {
      invariant(typeof this.#ports.archiveRetirements === 'function', 'CANDIDATE_ARCHIVE_REQUIRED');
      await this.#ports.archiveRetirements(structuredClone(retirements));
    }
    next.retiredCandidateIds ??= {};
    for (const record of retirements) next.retiredCandidateIds[record.id] = record.retiredAt;
    next.candidateReviewRevision = S1_CANDIDATE_REVIEW_REVISION;
    await this.#ports.persistState(structuredClone(next));
    await this.#ports.persistSnapshot(structuredClone(snapshot));
    this.#state = next; this.#last = snapshot;
    if (this.#active() && this.#ports.publishMonitor) {
      try {
        await this.#ports.publishMonitor(structuredClone(snapshot), this.#abort.signal);
        this.#previousPublish = { status: 'SYNCED', at: new Date(this.#now()).toISOString() };
      } catch { this.#previousPublish = { status: 'SCANNER_PUBLISH_FAILED', at: new Date(this.#now()).toISOString() }; }
    }
    this.#nextAt = this.#now() + scannerRetryDelay({ cycleIntervalMs: this.#config.cycleIntervalMs,
      consecutiveFailures: this.#failures, elapsedMs: this.#now() - start, errors: [...errors, ...precisionErrors] });
  }
  status() {
    return { state: structuredClone(this.#state), snapshot: structuredClone(this.#last), nextScanAt: this.#nextAt,
      stopped: this.#stopped, failed: this.#failed, drainCompleted: this.#drained };
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#stopped = true; this.#abort.abort();
    this.#closing = (async () => {
      const outcomes = await Promise.allSettled([this.#task, this.#reads.closeWindow()]);
      invariant(!this.#failed && outcomes.every(row => row.status === 'fulfilled'), 'COORDINATED_SCANNER_DRAIN_FAILED');
      this.#drained = true;
    })();
    this.#closing.catch(() => {}); return this.#closing;
  }
  async publishStopped() {
    invariant(this.#drained && !this.#failed, 'COORDINATED_SCANNER_DRAIN_INCOMPLETE');
    await this.#ports.persistSnapshot({ ...this.#last, schemaVersion: 1, accountLabel: 'S1', mode: 'SCAN_ONLY', status: 'STOPPED',
      stoppedAt: new Date(this.#now()).toISOString(), shutdownDrainCompleted: true,
      realOrdersAllowed: false, newEntriesBlocked: true, tickBboExecutionEvidence: false });
  }
}
