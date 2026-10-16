import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { isDeepStrictEqual } from 'node:util';
import { entryConfirmationPolicy as expectedEntryConfirmationPolicy } from '../../shared/entry-confirmation.mjs';
import { simpleAdmission, SIMPLE_ADMISSION_REVISION } from '../../shared/px-band-risk-only.mjs';
import { CANDIDATE_PRIORITY_REVISION } from '../../shared/candidate-proximity.mjs';
import { COST_POLICY_REVISION } from './entry-plan.mjs';
import { createAdaptiveFirstHarvestPolicy } from '../../shared/profit-retention.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTION_REVISION, ENTRY_QUALITY_REVISION, hash, invariant, fresh } from './common.mjs';
import { assertSharedAdmissionHost, openProductionReadAdmission } from './host-admission.mjs';
import { boundedJsonFile, candidateSnapshot, readOnlyMetadataPorts, SHADOW_BACKGROUND_READ_HEADROOM } from './readonly-ports.mjs';
import { loadProductionCredentials, readCredentialFile } from '../binance-prod/credentials.mjs';
import { SignedTransport } from './transport.mjs';
import { admittedReadJson } from './admitted-http.mjs';
import { boundedResponseJson } from './bounded-http.mjs';
import { SQLiteJournal } from './sqlite-journal.mjs';
import { SegmentedEvidenceStore } from './segmented-evidence.mjs';
import { ForwardEvidence } from './market-evidence.mjs';
import { PublicStreams, AccountStream } from './streams.mjs';
import { AccountCache } from './account-reader.mjs';
import { ExecutionFrameProvider } from './frame-provider.mjs';
import { EntryCalendarCache } from './entry-calendar-cache.mjs';
import { EntryEvidenceArchive } from './entry-evidence.mjs';
import { createProductionExecutionRuntime } from './execution-runtime.mjs';
import { AccountActivityMonitor } from './activity-monitor.mjs';
import { readExecutionAuthorizationStatus } from './execution-authorization.mjs';
import { validateIq1Profile } from '../../orion-v2/paper/iq1-entry-quality.mjs';

export const EXECUTION_ROOT = '/var/lib/aegis/s1-execution';
const RAW_ROOT = '/var/lib/aegis/binance-prod/evidence/raw';

export function binanceOrderLimits(info) {
  const read = (interval, intervalNum) => {
    const rows = info?.rateLimits?.filter(row => row.rateLimitType === 'ORDERS'
      && row.interval === interval && row.intervalNum === intervalNum);
    invariant(rows?.length === 1 && Number.isSafeInteger(rows[0].limit) && rows[0].limit > 0,
      'EXECUTION_ORDER_LIMIT_UNKNOWN');
    return rows[0].limit;
  };
  const orders10s = read('SECOND', 10), orders60s = read('MINUTE', 1);
  invariant(orders60s >= orders10s, 'EXECUTION_ORDER_LIMIT_INVALID');
  return Object.freeze({ orders10s, orders60s });
}

export function executionHostStatus(state, authorization, { mode, captureReady, strategyRuntime = null }) {
  const infrastructureReady = mode === 'LIVE'
    && captureReady === true
    && state.status !== 'STOPPED'
    && state.lastCycleAt !== null
    && state.cycleDiagnostic?.error === null
    && state.entryIncident === null
    && state.accountActivity?.recentWindowsReady === true
    && state.accountActivity?.lastError === null
    && state.accountStream?.connected === true
    && state.publicConnected === true
    && [state.contextError, state.feeTaskError,
      simpleAdmission(strategyRuntime) ? null : state.calendarTaskError,
      state.accountTaskError, state.watchdogError].every(value => value === null);
  const scoped = mode === 'LIVE' ? authorization
    : { status: 'DISABLED_BY_MODE', enabled: false, entriesEnabled: false };
  return { ...state,
    infrastructureReady,
    realOrdersAllowed: scoped.enabled === true,
    entriesAllowed: scoped.entriesEnabled === true,
    orderAuthorizationStatus: scoped.status,
    liveReady: infrastructureReady && scoped.entriesEnabled === true && state.candidateSource?.state !== 'UNAVAILABLE',
    service: 'aegis-s1-execution', strategyRuntime };
}

// Separate from the observer: no observer ledger is opened as a live ledger.
// Importing this module has no side effects. Only an operator launches the CLI.
export async function runExecutionHost({ mode = 'OBSERVE' } = {}) {
  assertSharedAdmissionHost();
  invariant(['OBSERVE', 'LIVE'].includes(mode), 'EXECUTION_HOST_MODE_INVALID');
  let budget, journal, store, publicStreams, accountStream, execution, initialization, closing;
  let stopping = false, clockAt = 0;
  const checkpoint = () => invariant(!stopping, 'EXECUTION_STARTUP_CANCELED');
  const step = async action => { checkpoint(); const result = await action(); checkpoint(); return result; };
  const close = () => {
    if (closing) return closing;
    stopping = true; execution?.engine.pauseEntries('HOST_SHUTDOWN');
    closing = (async () => {
      await initialization?.catch(() => {});
      if (execution) await execution.close();
      else await Promise.all([publicStreams?.close(), accountStream?.close()]);
      // Keep admission and storage available while current protection drains.
      budget?.stop();
      await store?.close();
      await journal?.close();
      await budget?.close();
      process.off('SIGTERM', signal); process.off('SIGINT', signal);
    })();
    return closing;
  };
  const signal = () => {
    const timer = setTimeout(() => process.exit(2), 35000);
    void close().then(() => clearTimeout(timer), () => { process.exitCode = 2; });
  };
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  initialization = (async () => {
    const config = await step(() => boundedJsonFile('/opt/aegis/account-reader/agents/orion-live/binance-prod/config.json'));
    const scanner = await step(() => boundedJsonFile(new URL('../s1-scanner/config.json', import.meta.url)));
    const riskProfile = await step(() => boundedJsonFile(new URL('../s1-scanner/r22-risk-profile.json', import.meta.url)));
    const trialLimits = await step(() => boundedJsonFile(new URL('./small-trial-limits.json', import.meta.url)));
    const iq1SourceProfile = await step(() => boundedJsonFile(new URL('./iq1-p1-profile.json', import.meta.url)));
    validateIq1Profile(iq1SourceProfile, { maximumOpenPositionsTotal: 2,
      maximumPortfolioRiskFraction: 0.04, maximumLeverage: 1 });
    const iq1Profile = simpleAdmission(iq1SourceProfile) ? iq1SourceProfile : validateIq1Profile({ ...iq1SourceProfile,
      maximumGroupPositions: Math.min(iq1SourceProfile.maximumGroupPositions, trialLimits.maximumOpenPositions) }, {
      maximumOpenPositionsTotal: trialLimits.maximumOpenPositions,
      maximumPortfolioRiskFraction: iq1SourceProfile.maximumGroupRiskFraction,
      maximumLeverage: iq1SourceProfile.maximumGroupNotionalLeverage });
    invariant(simpleAdmission(iq1Profile) === simpleAdmission(scanner.strategy.signal)
      && simpleAdmission(iq1Profile) === simpleAdmission(trialLimits), 'HOST_ADMISSION_POLICY_MISMATCH');
    const simplified = simpleAdmission(iq1Profile);
    const r22Rollback = iq1SourceProfile.policyRevision === 'S1-R22-ROLLBACK-20261010';
    const paperFinal = r22Rollback || iq1SourceProfile.policyRevision === 'S1-IQ1-P1-PAPER-FINAL-20261010';
    const entryConfirmationPolicy = paperFinal ? null : await step(() => boundedJsonFile(new URL('./entry-confirmation-profile.json', import.meta.url)));
    invariant(paperFinal || isDeepStrictEqual(entryConfirmationPolicy, expectedEntryConfirmationPolicy('S1')),
      'HOST_ENTRY_CONFIRMATION_POLICY_MISMATCH');
    const entryQualityLoadedAt = Date.now();
    const strategyRuntime = Object.freeze({ costPolicyRevision: COST_POLICY_REVISION, candidatePriorityRevision: r22Rollback ? 'R22-SCANNER-UNIVERSE-ORDER' : paperFinal ? 'V2-IQ1-P1-CANDIDATE-ORDER-20260915' : CANDIDATE_PRIORITY_REVISION, entryAdmissionRevision: simplified ? SIMPLE_ADMISSION_REVISION : null, displayName: r22Rollback ? 'R22 · S1 live risk' : simplified ? 'Px 2% · P5' : paperFinal ? 'R22.1 + IQ1 P1 · paper final · S1 live risk' : 'R22.1 + IQ1 P1 · 4% risk · current profit lock', baseImplementationRevision: scanner.strategy.implementationRevision,
      executionRevision: r22Rollback ? scanner.strategy.implementationRevision : EXECUTION_REVISION, entryQualityRevision: r22Rollback ? null : ENTRY_QUALITY_REVISION,
      ...(paperFinal ? { maximumCompleteLifecycleCostR:0.12 } : {}),
      prospectiveManagementPolicy: paperFinal ? null : createAdaptiveFirstHarvestPolicy({ account: 'S1', firstHarvestTarget: null }),
      portfolioProtectionRevision: r22Rollback ? 'R22-R21-THREE-POSITION-PROTECTION' : paperFinal ? 'V2-R21-ENTRY-CONSISTENCY-1' : 'R21-LEGACY',
      managementRevision: paperFinal ? 'R22-LEGACY' : 'S1-P5-ADAPTIVE-FIRST-HARVEST-1',
      entryQualityPolicyRevision: iq1SourceProfile.policyRevision, pxDistanceGateEnabled: iq1SourceProfile.pxDistanceGateEnabled !== false,
      entryConfirmationPolicy,
      sourceProfileDigest: hash(iq1SourceProfile), effectiveProfileDigest: hash(iq1Profile),
      effectiveMaximumGroupPositions: simplified ? null : iq1Profile.maximumGroupPositions, loadedAt: entryQualityLoadedAt,
      riskPolicy: Object.freeze({ mode: trialLimits.mode, perTradeFraction: trialLimits.perTradeRiskFraction,
        portfolioFraction: trialLimits.portfolioRiskFraction, maximumOpenPositions: trialLimits.maximumOpenPositions,
        grossNotionalMustNotExceedEquity: trialLimits.grossNotionalMustNotExceedEquity,
        maximumLeverage: trialLimits.maximumLeverage,
        maximumGrossNotionalLeverage: trialLimits.maximumGrossNotionalLeverage,
        effectiveMaximumGroupPositions: simplified ? null : iq1Profile.maximumGroupPositions }),
      runtimeLoaded: true, accountLabel: 'S1' });
    // Fees and slippage come from each durable plan. Total and correlated-group
    // capacity are enforced independently before each new entry.
    invariant(trialLimits.schemaVersion === 2 && trialLimits.mode === 'LIVE_PERCENT_RISK'
      && trialLimits.status === 'OWNER_RISK_RECORDED'
      && trialLimits.perTradeRiskFraction === riskProfile.risk.perTradeFraction
      && trialLimits.portfolioRiskFraction === riskProfile.risk.portfolioFraction
      && trialLimits.maximumOpenPositions === 8 && trialLimits.maximumLeverage === 4
      && trialLimits.maximumGrossNotionalLeverage === 4
      && trialLimits.strategyRevision === scanner.strategy.implementationRevision
      && riskProfile.strategyRevision === scanner.strategy.implementationRevision, 'EXECUTION_STRATEGY_RUNTIME_REQUIRED');
    const runtime = { paperRisk: {}, paperFinalV2: paperFinal, r22Rollback,
      portfolioProfitProtection: paperFinal ? { ...await step(() => boundedJsonFile(new URL('./portfolio-protection-profile.json', import.meta.url))), requireThreePositionsForEntryFreeze: r22Rollback } : undefined };
    await step(async () => { budget = await openProductionReadAdmission('SHADOW_RESIDENT'); });
    await step(async () => { journal = await new SQLiteJournal(path.join(EXECUTION_ROOT, 'audit')).open(); });
    await step(async () => { store = await new SegmentedEvidenceStore(RAW_ROOT, { maximumBytes: 42949672960,
      assertWriter: () => !!journal.owner && !journal.failed }).open(); });
    const credentials = await step(() => loadProductionCredentials(config));
    const readPort = new SignedTransport({ credentials, admission: budget });
    const venueJson = async (method, pathname, params = {}) => {
      invariant(method === 'GET' || (pathname === '/fapi/v1/listenKey' && ['POST', 'PUT'].includes(method)), 'EXECUTION_PUBLIC_MUTATION_FORBIDDEN');
      const url = new URL(pathname, 'https://demo-fapi.binance.com'); url.search = new URLSearchParams(params);
      const result = await admittedReadJson(url, { method, headers: pathname.endsWith('/listenKey') ? { 'X-MBX-APIKEY': credentials.apiKey } : {} }, { admission: budget });
      invariant(result.ok, 'EXECUTION_CONTEXT_READ_FAILED'); return result.payload;
    };
    const info = await step(() => venueJson('GET', '/fapi/v1/exchangeInfo'));
    const orderLimits = binanceOrderLimits(info);
    const refreshClock = async () => {
      if (fresh(clockAt, Date.now(), 60000)) return;
      clockAt = 0;
      const before = Date.now(), server = await venueJson('GET', '/fapi/v1/time'), after = Date.now();
      invariant(after - before <= 1000 && Math.abs(server.serverTime - after) <= 1000, 'EXECUTION_CLOCK_SKEW'); clockAt = after;
    };
    await step(refreshClock);
    accountStream = new AccountStream({ createToken: async () => (await venueJson('POST', '/fapi/v1/listenKey')).listenKey,
      renewToken: () => venueJson('PUT', '/fapi/v1/listenKey'),
      onChange: event => execution?.resident.activityMonitor?.noteStreamEvent(event) });
    publicStreams = new PublicStreams({ evidence: new ForwardEvidence({ maximumQueue: 10000, persist: rows => store.append(rows) }),
      onGap: gap => execution?.resident.noteGap(gap) });
    const calendarToken = await step(() => readCredentialFile('/etc/aegis/secrets/s1-probe/calendar-token'));
    const calendar = new EntryCalendarCache({ load: async () => {
      const response = await fetch('https://your-cockpit.example.invalid', {
        redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'oai-sites-authorization': `Bearer ${calendarToken}` } });
      invariant(response.ok, 'CALENDAR_READ_FAILED'); return boundedResponseJson(response, 1048576);
    } });
    const provider = new ExecutionFrameProvider({ publicStreams, strategy: scanner.strategy,
      entryQualityProfile: iq1Profile, entryQualityLoadedAt, entryConfirmationPolicy,
      accountCache: new AccountCache({ transport: readPort, userStream: accountStream }),
      ...readOnlyMetadataPorts({ publicGet: (p, args) => venueJson('GET', p, args), signedGet: (p, args) => readPort.request('GET', p, args),
        canRead: weight => budget.canStartLowPriorityRead(weight, 265) }),
      loadCalendar: () => calendar.read(), loadCandidates: async () => candidateSnapshot(
        await boundedJsonFile('/var/lib/aegis/s1-scanner/state.json'), await boundedJsonFile('/var/lib/aegis/s1-scanner/latest.json'), Date.now()),
      infrastructure: async () => ({ diskReady: store.status().captureReady && fresh(clockAt, Date.now(), 120000),
        singleWriter: !!journal.owner && !!store.writerLease?.held }) });
    execution = createProductionExecutionRuntime({ credentials, ipBudget: budget,
      maximumOrders10s: orderLimits.orders10s, maximumOrders60s: orderLimits.orders60s,
      journal, readPort, runtime, strategy: scanner.strategy, riskProfile, trialLimits, mode,
      frameProvider: options => provider.read(options), evidenceArchive: new EntryEvidenceArchive({ store }), entryQualityRequired: true,
      residentPorts: { publicStreams, accountStream, refreshContext: async () => { await refreshClock(); await provider.refreshMarketContext(); },
        priceFrame: () => ({ market: publicStreams.market(), rules: provider.rules }),
        refreshFees: () => provider.refreshFees(), refreshCalendar: () => calendar.refresh(),
        publishStatus: async state => {
          const filename = path.join(EXECUTION_ROOT, 'latest.json');
          const authorization = await readExecutionAuthorizationStatus({ trialLimits });
          const status = executionHostStatus(state, authorization, { mode, captureReady: store.status().captureReady, strategyRuntime });
          await fs.writeFile(`${filename}.next`, JSON.stringify(status), { mode: 0o600 });
          await fs.rename(`${filename}.next`, filename);
        }, onStall: signal } });
    // The monitor starts closed and only releases recent-history coverage.
    // It cannot clear durable incidents or grant the separate order authority.
    execution.resident.activityMonitor = new AccountActivityMonitor({
      engine: execution.engine, book: execution.book, transport: readPort,
      stream: accountStream, executionReconciliation: mode === 'LIVE', prioritizeCoverage: true,
      // Same bounded three-read window and headroom already used by the
      // production observer. Individual GETs remain charged by shared admission.
      canPoll: () => budget.canStartLowPriorityRead(45, SHADOW_BACKGROUND_READ_HEADROOM) });
    await step(() => journal.append({ type: 'EXECUTION_HOST_STARTING', at: Date.now(), mode, strategyRevision: scanner.strategy.implementationRevision }));
    checkpoint(); execution.start({ cycleIntervalMs: 15000 });
    return { execution, close };
  })();
  try { return await initialization; }
  catch (error) { await close(); throw error; }
}

export function executionModeFromArgs(args) {
  invariant(Array.isArray(args) && (args.length === 0
    || (args.length === 1 && ['--observe', '--live'].includes(args[0]))), 'EXECUTION_HOST_ARGUMENTS_FORBIDDEN');
  return args[0] === '--live' ? 'LIVE' : 'OBSERVE';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runExecutionHost({ mode: executionModeFromArgs(process.argv.slice(2)) });
  } catch {
    process.stdout.write('{"status":"EXECUTION_HOST_START_FAILED","realOrdersAllowed":false}\n');
    process.exitCode = 1;
  }
}
