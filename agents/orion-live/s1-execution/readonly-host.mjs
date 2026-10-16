import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProbeHost, boundedJsonFile, candidateSnapshot, readOnlyMetadataPorts, SHADOW_BACKGROUND_READ_HEADROOM, requireBackgroundEligibility } from './readonly-ports.mjs';
import { readCredentialFile, loadProductionCredentials } from '../binance-prod/credentials.mjs';
import { SignedTransport, ACCOUNT_BATCH_PATHS } from './transport.mjs';
import { sqliteBudgetState, readRequestWeight } from './request-budget.mjs';
import { openProductionReadAdmission } from './host-admission.mjs';
import { openProductionCoordinatedReadSession } from './coordinated-host-admission.mjs';
import { CoordinatedShadowReads } from './coordinated-shadow-reads.mjs';
import { assertCoordinatedScannerConfig } from '../s1-scanner/coordinated-resident.mjs';
import { admittedReadJson } from './admitted-http.mjs';
import { boundedResponseJson } from './bounded-http.mjs';
import { SQLiteJournal } from './sqlite-journal.mjs';
import { SegmentedEvidenceStore } from './segmented-evidence.mjs';
import { AccountCache } from './account-reader.mjs';
import { AccountStream, PublicStreams } from './streams.mjs';
import { ForwardEvidence } from './market-evidence.mjs';
import { ExecutionFrameProvider } from './frame-provider.mjs';
import { EntryCalendarCache } from './entry-calendar-cache.mjs';
import { ExecutionKernel } from './kernel.mjs';
import { PositionLedger } from './position-ledger.mjs';
import { PositionLifecycle } from './lifecycle.mjs';
import { S1ExecutionEngine } from './engine.mjs';
import { S1Resident } from './resident.mjs';
import { createShadowHostLifecycle } from './shadow-shutdown.mjs';
import { AccountActivityMonitor } from './activity-monitor.mjs';
import { UNIVERSE, fresh, invariant } from './common.mjs';

export const SHADOW_ROOT = '/var/lib/aegis/s1-shadow';
export const CANONICAL_RAW_ROOT = '/var/lib/aegis/binance-prod/evidence/raw';

// Read-only diagnostics, not order permission. Keep each source's timestamp
// contract: rule observations are ISO strings; fee observations are epoch ms.
// In particular Date.parse(epochMs) returns NaN for valid current fee times.
export function readonlyInputReadiness({ provider, lastFrame, market, historyReady,
  candidateError, calendarError, clockError, clockVerifiedAt, captureReady, now }) {
  invariant(Number.isSafeInteger(now) && now > 0, 'SHADOW_READINESS_CLOCK_INVALID');
  const missing = {
    rules: UNIVERSE.filter(s => typeof provider.rules[s]?.observedAt !== 'string'
      || !fresh(Date.parse(provider.rules[s].observedAt), now, 300000)),
    fees: UNIVERSE.filter(s => !Number.isSafeInteger(provider.fees[s]?.observedAt)
      || provider.fees[s].observedAt <= 0 || !fresh(provider.fees[s].observedAt, now, 300000)),
    bars: UNIVERSE.filter(s => !(provider.bars[s]?.bars15m?.length >= 100 && provider.bars[s]?.bars1h?.length >= 100)),
    tick: UNIVERSE.filter(s => !(market[s]?.tick?.persisted && fresh(market[s].tick.marketTime, now, 2000))),
    bbo: UNIVERSE.filter(s => !(market[s]?.bbo?.persisted && fresh(market[s].bbo.marketTime, now, 2000))),
  };
  const checks = {
    accountFresh: !!lastFrame && fresh(lastFrame.account.observedAt, now, 5000),
    accountStreamConnected: !!lastFrame?.account.userStreamConnected,
    historyReady: !!historyReady,
    tickFresh: missing.tick.length === 0, bboFresh: missing.bbo.length === 0,
    candidateVerified: !candidateError, calendarReadVerified: !calendarError,
    clockVerified: !clockError && fresh(clockVerifiedAt, now, 120000),
    captureReady: !!captureReady,
    rulesFresh: missing.rules.length === 0, feesFresh: missing.fees.length === 0,
    barsReady: missing.bars.length === 0,
    calendarCoverageVerified: !!lastFrame && lastFrame.eventGate.status !== 'CALENDAR_UNVERIFIED_PAUSE',
  };
  return { inputReady: Object.values(checks).every(Boolean), checks, missing };
}

export function assertObservationBoundary(config, snapshot, now = Date.now()) {
  invariant(config?.retention?.rawManagement === 'SEGMENTED_WRITER_OBSERVER' && config.retention.rawRoot === CANONICAL_RAW_ROOT
    && config.retention.rawMaximumBytes === 42949672960 && config.retention.rawRetentionDays === 7
    && config.execution?.realOrdersAllowed === false && config.execution.newEntriesBlocked === true, 'SHADOW_READER_BOUNDARY_REQUIRED');
  invariant(snapshot?.retention?.rawManagement === 'SEGMENTED_WRITER_OBSERVER' && snapshot.retention.observerOnly === true
    && snapshot.retention.rawMaximumBytes === config.retention.rawMaximumBytes
    && fresh(Date.parse(snapshot.checkedAt), now, 120000) && snapshot.realOrdersAllowed === false && snapshot.newEntriesBlocked === true, 'SHADOW_READER_OBSERVER_NOT_VERIFIED');
}

// Constant OBSERVE mode: neither an argument nor an environment flag can arm it.
// It exercises the actual frame/preflight loop and persists forward raw evidence,
// but never calls order-test, financial mutations, or the live lifecycle branch.
export async function runReadOnlyHost() {
  assertProbeHost(os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID, process.getuid());
  const coordinated = process.argv.length === 3 && process.argv[2] === '--coordinated';
  invariant(process.argv.length === 2 || coordinated, 'SHADOW_ARGUMENTS_FORBIDDEN');
  let journal, store, resident, budget, publicStreams, accountStream, activityMonitor, publishFinal, readPorts, feedEvents = 0;
  const shutdown = createShadowHostLifecycle({ signals: process,
    resources: () => ({ store, resident, budget, publicStreams, accountStream, publishFinal, journal, readPorts }),
    onTimeout: () => process.exit(2),
    onFailure: () => { process.stdout.write('{"status":"SHADOW_SHUTDOWN_DRAIN_FAILED","realOrdersAllowed":false}\n'); process.exitCode = 2; } });
  const close = shutdown.close;
  try {
    return await shutdown.initialize(async ({ step, checkpoint }) => {
      const readerConfig = await step(() => boundedJsonFile('/opt/aegis/account-reader/agents/orion-live/binance-prod/config.json'));
      assertObservationBoundary(readerConfig, await step(() => boundedJsonFile('/var/lib/aegis/binance-prod/latest.json')));
      const strategyConfig = await step(() => boundedJsonFile(new URL('../s1-scanner/config.json', import.meta.url)));
      if (coordinated) assertCoordinatedScannerConfig(strategyConfig, os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID);
      const profile = await step(() => boundedJsonFile(new URL('../s1-scanner/r22-risk-profile.json', import.meta.url)));
      const trialLimits = await step(() => boundedJsonFile(new URL('./small-trial-limits.json', import.meta.url)));
      // Assign ownership inside the guarded step, before its post-await fence.
      await step(async () => { journal = await new SQLiteJournal(path.join(SHADOW_ROOT, 'audit')).open(); });
      await step(async () => { budget = await (coordinated ? openProductionCoordinatedReadSession('SHADOW_RESIDENT') : openProductionReadAdmission('SHADOW_RESIDENT')); });
      if (coordinated) budget.start();
      else {
        const previousBudget = sqliteBudgetState(journal).load();
        budget.inheritLegacyState(previousBudget);
      }
      await step(async () => { store = await new SegmentedEvidenceStore(CANONICAL_RAW_ROOT, { assertWriter: () => !!journal.owner && !!journal.db && !journal.failed,
        onRecovery: gap => journal.append({ type: 'SHADOW_RAW_RECOVERY_GAP', ...gap }) }).open(); });
      const credentials = await step(() => loadProductionCredentials(readerConfig));
      if (coordinated) {
        readPorts = new CoordinatedShadowReads({ session: budget, credentials, onChange: event => activityMonitor?.noteStreamEvent(event) });
        accountStream = readPorts.accountStream;
        await step(() => readPorts.initialize());
      }
      const transport = coordinated ? null : new SignedTransport({ credentials, admission: budget });
      const signed = coordinated ? readPorts.closedTransport : { readAccountBatch: () => transport.readAccountBatch(), request: (method, pathname, params = {}) => {
        invariant(method === 'GET', 'SHADOW_FINANCIAL_MUTATION_FORBIDDEN');
        return transport.request(method, pathname, params);
      } };
      const venueJson = async (method, pathname, params = {}) => {
        invariant(!coordinated, 'SHADOW_LEGACY_READ_FORBIDDEN');
        const url = new URL(pathname, 'https://demo-fapi.binance.com'); url.search = new URLSearchParams(params).toString();
        try {
          const response = await admittedReadJson(url, { method,
            headers: pathname.endsWith('/listenKey') ? { 'X-MBX-APIKEY': credentials.apiKey } : {} }, { admission: budget });
          invariant(response.ok, 'SHADOW_HTTP_READ_FAILED'); return response.payload;
        } catch { throw new Error('SHADOW_HTTP_READ_FAILED'); }
      };
      if (!coordinated) {
        const info = await step(() => venueJson('GET', '/fapi/v1/exchangeInfo'));
        invariant(info.rateLimits?.some(r => r.rateLimitType === 'REQUEST_WEIGHT' && r.interval === 'MINUTE' && r.intervalNum === 1 && r.limit >= 2400), 'SHADOW_VENUE_RATE_LIMIT_REVIEW_REQUIRED');
      }
      let clockVerifiedAt = 0, clockError = 'CLOCK_NOT_VERIFIED';
      const refreshClock = async () => {
        if (fresh(clockVerifiedAt, Date.now(), 60000)) return;
        const before = Date.now(), server = await venueJson('GET', '/fapi/v1/time'), after = Date.now();
        invariant(after - before <= 1000 && Math.abs(server.serverTime - after) <= 1000, 'SHADOW_CLOCK_SKEW');
        clockVerifiedAt = after; clockError = null;
      };
      if (coordinated) { clockVerifiedAt = readPorts.clockVerifiedAt; clockError = readPorts.clockError; }
      else {
        await step(refreshClock);
        accountStream = new AccountStream({ createToken: async () => (await venueJson('POST', '/fapi/v1/listenKey')).listenKey,
          renewToken: () => venueJson('PUT', '/fapi/v1/listenKey'), onChange: event => activityMonitor?.noteStreamEvent(event) });
      }
      const evidence = new ForwardEvidence({ maximumQueue: 10000, persist: async rows => {
        const receipt = await store.append(rows); feedEvents += rows.length; return receipt;
      } });
      publicStreams = new PublicStreams({ evidence, onGap: gap => resident?.noteGap(gap) });
      let candidateError = null, scannerSequence = null, lastFrame = null;
      const calendarToken = await step(() => readCredentialFile('/etc/aegis/secrets/s1-probe/calendar-token'));
      const calendarCache = new EntryCalendarCache({ load: async () => {
        const response = await fetch('https://your-cockpit.example.invalid', { method: 'GET', redirect: 'error',
          signal: AbortSignal.timeout(5000), headers: { 'oai-sites-authorization': `Bearer ${calendarToken}` } });
        invariant(response.ok, 'CALENDAR_READ_FAILED'); return boundedResponseJson(response, 1024 * 1024);
      } });
      const provider = new ExecutionFrameProvider({ publicStreams, strategy: strategyConfig.strategy,
        ...(coordinated ? readPorts.framePorts() : { accountCache: new AccountCache({ transport: signed, userStream: accountStream }), ...readOnlyMetadataPorts({
          canRead: weight => requireBackgroundEligibility(budget.lowPriorityReadDecision(weight, SHADOW_BACKGROUND_READ_HEADROOM)),
          publicGet: (p, args) => venueJson('GET', p, args), signedGet: (p, args) => signed.request('GET', p, args) }) }),
        loadCalendar: () => calendarCache.read(), loadCandidates: async () => {
          try {
            const latest = await boundedJsonFile('/var/lib/aegis/s1-scanner/latest.json'), state = await boundedJsonFile('/var/lib/aegis/s1-scanner/state.json');
            const result = candidateSnapshot(state, latest, Date.now()); scannerSequence = result.sequence; candidateError = null; return result;
          } catch { candidateError = 'SCANNER_INPUT_UNVERIFIED'; throw new Error(candidateError); }
        }, infrastructure: async () => ({ diskReady: store.status().captureReady && fresh(clockVerifiedAt, Date.now(), 120000), singleWriter: !!journal.owner && !!store.writerLease?.held }) });
      const book = new PositionLedger(journal);
      let engine;
      const kernel = new ExecutionKernel({ journal, transport: signed, gates: () => { throw new Error('SHADOW_NO_EXECUTION_GATE'); } });
      invariant(!kernel.plans.size && !kernel.intents.size && !book.positions.size, 'SHADOW_MUST_NOT_OPEN_LIVE_LEDGER');
      const lifecycle = new PositionLifecycle({ kernel, book, runtime: {}, strategy: strategyConfig.strategy });
      engine = new S1ExecutionEngine({ kernel, book, lifecycle, riskProfile: profile, trialLimits, mode: 'OBSERVE', frameProvider: async () => { lastFrame = await provider.read(); return lastFrame; } });
      activityMonitor = new AccountActivityMonitor({ engine, book, transport: signed, stream: accountStream,
        ...(coordinated ? readPorts.activityPorts() : { canPoll: () => budget.canStartLowPriorityRead(45, SHADOW_BACKGROUND_READ_HEADROOM) }) });
      const publishStatus = async state => {
        const now = Date.now(), market = publicStreams.market();
        const calendarRefresh = calendarCache.status(), calendarError = calendarRefresh.error;
        const raw = store.status();
        const inputReadiness = readonlyInputReadiness({ provider, lastFrame, market, historyReady: activityMonitor.ready(),
          candidateError, calendarError, clockError, clockVerifiedAt, captureReady: raw.captureReady, now });
        const currentBbo = UNIVERSE.length - inputReadiness.missing.bbo.length;
        const currentTick = UNIVERSE.length - inputReadiness.missing.tick.length;
        const summary = { ...state, service: 'aegis-s1-readonly-shadow', checkedAt: new Date(now).toISOString(), liveReady: false, newEntriesBlocked: true,
          cycleIntervalMs: 15000, fullLiveTimingAccepted: false, accountReadBatchAdmission: true, venueSnapshotAtomic: false,
          readCoordinationVersion: coordinated ? 2 : 1, unsentAccountRetryMs: coordinated ? 1000 : 15000,
          accountConfigurationRead: 'FRESH_ACCOUNT_CONFIG', accountBatchRequestCount: 5,
          accountBatchReservedWeight: ACCOUNT_BATCH_PATHS.reduce((sum, pathname) => sum + readRequestWeight('GET', pathname), 0),
          backgroundReadHeadroomWeight: SHADOW_BACKGROUND_READ_HEADROOM,
          feeRefreshDiagnostics: provider.feeDiagnostics(), calendarRefresh,
          currentBbo, currentTick, durableEventsThisProcess: feedEvents, warmupDiscarded: evidence.warmupDiscarded,
          raw, requestBudget: coordinated ? budget.readBudgetStatus() : budget.status(), scannerSequence, candidateError, calendarError, clockError,
          inputReady: inputReadiness.inputReady, inputReadiness,
          account: lastFrame ? { observedAt: lastFrame.account.observedAt, equityUsdt: lastFrame.account.equityUsdt,
            positions: lastFrame.account.positions.filter(p => Number(p.positionAmt) !== 0).length, orders: lastFrame.account.orders.length, algos: lastFrame.account.algos.length } : null,
          decisionCount: Array.isArray(engine.lastDecision) ? engine.lastDecision.length : 0, calendarStatus: lastFrame?.eventGate.status ?? null };
        const temporary = path.join(SHADOW_ROOT, 'latest.next');
        const handle = await fs.open(temporary, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(JSON.stringify(summary)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, path.join(SHADOW_ROOT, 'latest.json'));
      };
      publishFinal = publishStatus;
      resident = new S1Resident({ engine, book, publicStreams, accountStream, transport: signed, publishStatus, activityMonitor,
        resumeQueuedAccounts: coordinated, coordinatedFeeProvider: coordinated ? provider : null,
        refreshContext: async () => {
          if (coordinated) {
            try { await readPorts.refreshContext(provider); }
            finally { clockVerifiedAt = readPorts.clockVerifiedAt; clockError = readPorts.clockError; }
          } else {
            try { await refreshClock(); } catch { clockError = 'CLOCK_UNVERIFIED'; }
            await provider.refreshMarketContext();
          }
        }, refreshFees: () => provider.refreshFees(), refreshCalendar: () => calendarCache.refresh(),
        onStall: () => { void close().then(() => { process.exitCode = 2; }, () => {}); } });
      await step(() => journal.append({ type: 'SHADOW_STARTING', at: Date.now(), mode: 'OBSERVE', strategyRevision: strategyConfig.strategy.implementationRevision }));
      checkpoint();
      resident.start({ cycleIntervalMs: 15000 });
      process.stdout.write('{"status":"READ_ONLY_SHADOW_STARTED","realOrdersAllowed":false,"newEntriesBlocked":true}\n');
      return { close, resident };
    });
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await runReadOnlyHost(); }
  catch (error) {
    const canceled = error?.message === 'SHADOW_STARTUP_CANCELED';
    process.stdout.write(JSON.stringify({ status: canceled ? 'READ_ONLY_SHADOW_START_CANCELED' : 'READ_ONLY_SHADOW_START_FAILED',
      reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SHADOW_UNEXPECTED_ERROR', realOrdersAllowed: false }) + '\n');
    process.exitCode = canceled ? 0 : 1;
  }
}
