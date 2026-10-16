import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { SMC_S1_ENTRY_REVISION } from '../../../lib/smc-s1-entry.mjs';
import {TARGET_PATH_REVISION,build4hFvgEvidence} from '../../../lib/smc-target-path.mjs';
import { OpportunityLifecycleTracker } from './opportunity-lifecycle.mjs';
import { stopSafetyContext } from '../../../lib/smc-stop-safety.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant, fresh, hash } from '../s2-execution/common.mjs';
import { assertSharedAdmissionHost, openProductionReadAdmission } from '../s2-execution/host-admission.mjs';
import { boundedJsonFile, readOnlyMetadataPorts, SHADOW_BACKGROUND_READ_HEADROOM } from '../s2-execution/readonly-ports.mjs';
import { loadProductionCredentials, readCredentialFile } from '../binance-prod2/credentials.mjs';
import { SignedTransport } from '../s2-execution/transport.mjs';
import { admittedReadJson } from '../s2-execution/admitted-http.mjs';
import { boundedResponseJson } from '../s2-execution/bounded-http.mjs';
import { SQLiteJournal } from '../s2-execution/sqlite-journal.mjs';
import { SegmentedEvidenceStore } from '../s2-execution/segmented-evidence.mjs';
import { ForwardEvidence } from '../s2-execution/market-evidence.mjs';
import { PublicStreams, AccountStream } from '../s2-execution/streams.mjs';
import { AccountCache } from '../s2-execution/account-reader.mjs';
import { ExecutionFrameProvider } from '../s2-execution/frame-provider.mjs';
import { EntryCalendarCache } from '../s2-execution/entry-calendar-cache.mjs';
import { EntryEvidenceArchive } from '../s2-execution/entry-evidence.mjs';
import { AccountActivityMonitor } from '../s2-execution/activity-monitor.mjs';
import { binanceOrderLimits } from '../s2-execution/execution-host.mjs';
import { SMC_EXECUTION_REVISION, applyOwnerSelectedAutoControls, createSmcProductionExecutionRuntime, latestManualIntents, prepareSmcEntry,
  readSmcAuthorizationStatus, smcCandidateSnapshot, smcExecutionSignal, smcLeverageAlignment,
  validateSmcRiskProfile, guardRestingSmcEntries } from './live-core.mjs';
import { validateSmcManualIntent } from '../../../lib/smc-manual-intent.mjs';
import { validateSmcPositionAction } from '../../../lib/smc-position-action.mjs';

export const SMC_EXECUTION_ROOT = '/var/lib/aegis/smc-execution';
const RAW_ROOT = '/var/lib/aegis/binance-prod2/evidence/raw';
const SCAN_PATH = '/var/lib/aegis/smc-scanner/latest.json';
const COCKPIT_ORIGIN = process.env.S2_MONITOR_ORIGIN ?? 'https://your-cockpit.example.invalid';
const manualEndpoint = `${COCKPIT_ORIGIN}/api/smc-manual-order`;
const ownerCandidateEndpoint = `${COCKPIT_ORIGIN}/api/smc-manual-candidates?service=1`;
const positionActionEndpoint = `${COCKPIT_ORIGIN}/api/smc-position-action`;
function monitorHeaders() {
  const token = process.env.S2_MONITOR_INGEST_TOKEN;
  const bypass = process.env.S2_MONITOR_BYPASS_TOKEN ?? process.env.S1_MONITOR_BYPASS_TOKEN;
  invariant(token?.length >= 32 && bypass?.length >= 32, 'SMC_MANUAL_SERVICE_CREDENTIAL_MISSING');
  return { Authorization: `Bearer ${token}`, 'oai-sites-authorization': `Bearer ${bypass}` };
}
async function readManualIntents(now) {
  let response = null, lastError = null;
  // The authenticated private-site worker regularly needs 3-4 seconds after a
  // cold start. A three-second cutoff made valid owner tickets invisible for
  // most of their lifetime. Retry the read itself; order dispatch remains
  // idempotent and no ticket is acknowledged by this read.
  for (let attempt = 0; attempt < 2 && !response?.ok; attempt++) {
    try {
      response = await fetch(`${manualEndpoint}?pending=1`, { redirect: 'error',
        signal: AbortSignal.timeout(12000), headers: monitorHeaders() });
      if (!response.ok && response.status < 500) break;
    } catch (error) { lastError = error; }
  }
  if (!response && lastError) throw lastError;
  invariant(response.ok, 'SMC_MANUAL_QUEUE_UNAVAILABLE');
  const payload = await boundedResponseJson(response, 16384);
  invariant(payload.status === 'OK' && Array.isArray(payload.intents) && payload.intents.length <= 32, 'SMC_MANUAL_QUEUE_INVALID');
  return payload.intents.map(row => validateSmcManualIntent(row, now));
}
async function updateManualIntent(id, status, reason) {
  const response = await fetch(manualEndpoint, { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { ...monitorHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status, reason }) });
  invariant(response.ok, 'SMC_MANUAL_RECEIPT_FAILED');
}
async function readPositionActions(now) {
  let response = null, lastError = null;
  for (let attempt = 0; attempt < 2 && !response?.ok; attempt++) {
    try {
      response = await fetch(`${positionActionEndpoint}?pending=1`, { redirect: 'error',
        signal: AbortSignal.timeout(12000), headers: monitorHeaders() });
      if (!response.ok && response.status < 500) break;
    } catch (error) { lastError = error; }
  }
  if (!response && lastError) throw lastError;
  invariant(response.ok, 'SMC_POSITION_ACTION_QUEUE_UNAVAILABLE');
  const payload = await boundedResponseJson(response, 16384);
  invariant(payload.status === 'OK' && Array.isArray(payload.actions) && payload.actions.length <= 8,
    'SMC_POSITION_ACTION_QUEUE_INVALID');
  return payload.actions.map(row => validateSmcPositionAction(row, now));
}
async function updatePositionAction(id, status, reason) {
  const response = await fetch(positionActionEndpoint, { method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { ...monitorHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status, reason }) });
  invariant(response.ok, 'SMC_POSITION_ACTION_RECEIPT_FAILED');
}
async function readOwnerAutoControls(now) {
  let response = null, lastError = null;
  for (let attempt = 0; attempt < 2 && !response?.ok; attempt++) {
    try {
      response = await fetch(ownerCandidateEndpoint, { redirect: 'error',
        signal: AbortSignal.timeout(12000), headers: monitorHeaders() });
      if (!response.ok && response.status < 500) break;
    } catch (error) { lastError = error; }
  }
  if (!response && lastError) throw lastError;
  invariant(response.ok, 'SMC_OWNER_AUTO_CONTROL_UNAVAILABLE');
  const payload = await boundedResponseJson(response, 16384);
  invariant(payload.status === 'OK' && Array.isArray(payload.candidates) && payload.candidates.length <= 20,
    'SMC_OWNER_AUTO_CONTROL_INVALID');
  return { status: 'READY', checkedAt: now, controls: payload.candidates.map(row => ({
    symbol: row.symbol, direction: row.direction, autoTradingEnabled: row.autoTradingEnabled,
  })) };
}

const amount = value => Number.isFinite(Number(value)) ? Number(value) : null;
function accountProjection(account) {
  if (!account) return null;
  const positions = account.positions.filter(row => Math.abs(Number(row.positionAmt)) > 0);
  return { observedAt: new Date(account.observedAt).toISOString(), fresh: fresh(account.observedAt, Date.now(), 120000),
    userStreamConnected: account.userStreamConnected === true, canTrade: account.canTrade === true,
    equity: amount(account.equityUsdt), wallet: amount(account.walletBalanceUsdt), available: amount(account.availableBalanceUsdt),
    positions: positions.length, orders: account.orders.length, algoOrders: account.algos.length,
    unrealized: positions.reduce((sum, row) => sum + Number(row.unRealizedProfit ?? 0), 0),
    initialMargin: positions.reduce((sum, row) => sum + Number(row.positionInitialMargin ?? 0), 0),
    positionMode: account.dualSidePosition ? 'HEDGE' : 'ONE_WAY', multiAssetsMargin: account.multiAssetsMargin === true };
}
function strategyLedgerProjection(book, kernel, account) {
  const venuePositions = new Map((account?.positions ?? []).filter(row => Math.abs(Number(row.positionAmt)) > 0).map(row => {
    const amount = Number(row.positionAmt);
    const direction = row.positionSide === 'LONG' ? 'LONG' : row.positionSide === 'SHORT' ? 'SHORT' : amount > 0 ? 'LONG' : 'SHORT';
    return [`${row.symbol}:${direction}`, row];
  }));
  const positions = [...book.positions.values()].filter(row => row.status === 'OPEN').slice(0, 8).map(row => ({
    planId: row.id, symbol: row.symbol, direction: row.direction === 1 ? 'LONG' : 'SHORT', quantity: amount(row.quantity),
    entry: amount(row.entry), stop: amount(row.stop), target: amount(row.targetPrice ?? kernel.plans.get(row.id)?.targetPrice),
    targetSource: row.targetPrice ? (row.targetSource ?? 'OWNER_OVERRIDE') : 'STRUCTURE_PLAN',
    stopPlans: book.control.get(`conditionalStops:${row.id}`)?.plans ?? [],
    initialRiskUsdt: amount(row.initialPlannedRiskUsdt),
    realizedNetPnl: amount(row.cumulativeRealizedNetPnl),
    unrealizedPnl: amount(venuePositions.get(`${row.symbol}:${row.direction === 1 ? 'LONG' : 'SHORT'}`)?.unRealizedProfit),
    openedAt: new Date(row.openedAt).toISOString(), status: row.status,
  }));
  const fills = [...book.fills.values()].slice(-100).reverse().map(row => ({
    key: `${row.planId}:${row.role}:${row.fill.symbol}:${row.fill.time}:${row.fill.price}:${row.fill.quantity}`,
    planId: row.planId, role: row.role, symbol: row.fill.symbol, direction: row.fill.direction,
    time: row.fill.time, price: amount(row.fill.price), quantity: amount(row.fill.quantity),
    commission: amount(row.fill.commission), realizedPnl: amount(row.fill.realizedPnl),
  }));
  const pendingEntries = kernel.unresolvedEntries().slice(0, 8).flatMap(row => {
    const plan = kernel.plans.get(row.planId);
    if (!plan) return [];
    return [{ planId: plan.id, symbol: plan.symbol, direction: plan.direction,
      price: amount(plan.price), quantity: amount(plan.quantity), stop: amount(plan.stopPrice),
      target: amount(plan.targetPrice), initialRiskUsdt: amount(plan.plannedRiskUsdt),
      grossNotionalUsdt: amount(plan.price) * amount(plan.quantity),
      orderMode: plan.orderMode ?? 'IMMEDIATE', timeInForce: row.params?.timeInForce ?? plan.timeInForce ?? 'IOC',
      status: row.result?.status ?? 'PENDING', createdAt: new Date(plan.createdAt).toISOString() }];
  });
  return { positions, pendingEntries, fills };
}
async function publishCockpit(snapshot) {
  const token = process.env.S2_MONITOR_INGEST_TOKEN;
  const bypass = process.env.S2_MONITOR_BYPASS_TOKEN ?? process.env.S1_MONITOR_BYPASS_TOKEN;
  if (!token || !bypass) throw new Error('SMC_LEDGER_PUBLISH_CONFIG_MISSING');
  const response = await fetch(`${COCKPIT_ORIGIN}/api/smc-execution-ledger`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'oai-sites-authorization': `Bearer ${bypass}` }, body: JSON.stringify(snapshot) });
  if (!response.ok) throw new Error(`SMC_LEDGER_PUBLISH_HTTP_${response.status}`);
}

function priceRuleProjection(rules) {
  return Object.values(rules ?? {}).filter(rule => rule?.symbol && rule?.price?.step && rule?.observedAt).map(rule => ({
    symbol: rule.symbol, tickSize: String(rule.price.step), observedAt: new Date(rule.observedAt).toISOString(),
  })).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
function smcHostStatus(state, authorization, { mode, captureReady, strategyRuntime, account, book, kernel, rules }) {
  const leverageAlignment = smcLeverageAlignment(account, strategyRuntime.riskPolicy.maximumLeverage);
  const infrastructureReady = mode === 'LIVE' && captureReady === true && state.status !== 'STOPPED'
    && state.lastCycleAt !== null && state.cycleDiagnostic?.error === null && state.entryIncident === null
    && state.accountActivity?.recentWindowsReady === true && state.accountActivity?.lastError === null
    && state.accountStream?.connected === true && state.publicConnected === true
    && [state.contextError, state.feeTaskError, state.calendarTaskError, state.accountTaskError, state.watchdogError]
      .every(value => value === null) && leverageAlignment.ready;
  const scoped = mode === 'LIVE' ? authorization
    : { status: 'DISABLED_BY_MODE', enabled: false, entriesEnabled: false, exitsEnabled: false };
  return { ...state, infrastructureReady, realOrdersAllowed: scoped.enabled === true,
    entriesAllowed: scoped.entriesEnabled === true, exitsAllowed: scoped.exitsEnabled === true,
    manualEntriesEnabled: scoped.manualEntriesEnabled === true,
    orderAuthorizationStatus: scoped.status,
    liveReady: infrastructureReady && scoped.entriesEnabled === true && state.candidateSource?.state !== 'UNAVAILABLE',
    service: 'aegis-smc-execution', strategyRuntime, venue: 'BINANCE_USDM_MAINNET',
    observedAt: new Date(state.asOf).toISOString(), leverageAlignment,
    account: accountProjection(account), priceRules: priceRuleProjection(rules), strategyLedger: strategyLedgerProjection(book, kernel, account) };
}

function decisionProjection(status) {
  return {
    observedAt: status.observedAt, status: status.status, liveReady: status.liveReady,
    lastError: status.lastError ?? null, entryIncident: status.entryIncident ?? null,
    entriesAllowed: status.entriesAllowed, exitsAllowed: status.exitsAllowed,
    leverageAlignment: status.leverageAlignment,
    candidateSource: status.candidateSource,
    entryBlockers: (status.entryBlockers ?? []).map(row => ({ id: row.id, symbol: row.symbol,
      direction: row.direction, stage: row.stage, reason: row.reason, terminal: row.terminal })),
  };
}

export function smcManualIntentReceipt({ entry, blocker, expired = false }) {
  if (entry?.result) {
    const status = Number(entry.result.executedQty ?? 0) > 0 ? 'SUBMITTED'
      : ['EXPIRED', 'CANCELED', 'REJECTED'].includes(entry.result.status) ? 'NO_FILL' : 'SUBMITTED';
    return { status, reason: status === 'NO_FILL' ? 'ORDER_NO_FILL' : 'ORDER_SENT_TO_VENUE' };
  }
  if (blocker?.reason && blocker.terminal === true) {
    return { status: 'REJECTED', reason: /^[A-Z0-9_]{1,96}$/.test(blocker.reason)
      ? blocker.reason : 'MANUAL_ORDER_TERMINAL_REJECTION' };
  }
  if (expired) return { status: 'REJECTED', reason: 'INTENT_EXPIRED' };
  return null;
}

export async function runSmcExecutionHost({ mode = 'LIVE' } = {}) {
  assertSharedAdmissionHost();
  invariant(mode === 'LIVE', 'SMC_EXECUTION_LIVE_MODE_REQUIRED');
  let budget, journal, store, lifecycleTracker, publicStreams, accountStream, execution, initialization, closing;
  let stopping = false, clockAt = 0, latestAccount = null, latestDecisionFingerprint = null, latestPositionActions = [];
  const pendingManual = new Map(), pendingPositionActions = new Map();
  const checkpoint = () => invariant(!stopping, 'EXECUTION_STARTUP_CANCELED');
  const step = async action => { checkpoint(); const result = await action(); checkpoint(); return result; };
  const close = () => {
    if (closing) return closing;
    stopping = true; execution?.engine.pauseEntries('HOST_SHUTDOWN');
    closing = (async () => {
      await initialization?.catch(() => {});
      if (execution) await execution.close();
      else await Promise.all([publicStreams?.close(), accountStream?.close()]);
      budget?.stop();
      await store?.close(); await journal?.close(); await budget?.close();
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
    const config = await step(() => boundedJsonFile(new URL('../binance-prod2/config.json', import.meta.url)));
    const riskProfile = await step(() => boundedJsonFile(new URL('./risk-profile.json', import.meta.url)));
    const trialLimits = await step(() => boundedJsonFile(new URL('./trial-limits.json', import.meta.url)));
    validateSmcRiskProfile(riskProfile, trialLimits);
    const strategy = Object.freeze({ implementationRevision: SMC_EXECUTION_REVISION, structureRevision: null, signal: {},
      candidateMaximumAgeMs: riskProfile.candidateMaximumAgeMs,
      confirmationMaximumAgeMs: riskProfile.confirmationMaximumAgeMs });
    const strategyRuntime = Object.freeze({ displayName: 'SMC交汇 · S1 Px入场与跟进止损 · SMC目标 · 全仓无分批减仓', entryPolicyRevision: riskProfile.entryPolicyRevision, automaticPartialExits: false,
      strategyRevision: SMC_EXECUTION_REVISION, scannerRevision: riskProfile.scannerRevision,
      riskPolicy: Object.freeze({ perTradeFraction: riskProfile.risk.perTradeFraction,
        portfolioFraction: riskProfile.risk.portfolioFraction, maximumOpenPositions: riskProfile.risk.maximumOpenPositions,
        maximumLeverage: riskProfile.risk.maximumLeverage,
        maximumGrossNotionalLeverage: riskProfile.risk.maximumGrossNotionalLeverage }),
      minimumNetRewardRisk: riskProfile.minimumNetRewardRisk, runtimeLoaded: true, accountLabel: 'S2' });
    const runtime = { paperRisk: {} };
    await step(async () => { budget = await openProductionReadAdmission('SHADOW_RESIDENT'); });
    await step(async () => { journal = await new SQLiteJournal(path.join(SMC_EXECUTION_ROOT, 'audit')).open(); });
    await step(async () => { store = await new SegmentedEvidenceStore(RAW_ROOT, { maximumBytes: 42949672960,
      assertWriter: () => !!journal.owner && !journal.failed }).open(); });
    lifecycleTracker = await step(() => new OpportunityLifecycleTracker().open());
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
    publicStreams = new PublicStreams({ evidence: new ForwardEvidence({ maximumQueue: 10000, persist: async rows => { const receipt = await store.append(rows); await lifecycleTracker.observe(rows); return receipt; } }),
      onGap: gap => execution?.resident.noteGap(gap) });
    const calendarToken = await step(() => readCredentialFile('/etc/aegis/secrets/s1-probe/calendar-token'));
    const calendar = new EntryCalendarCache({ load: async () => {
      const response = await fetch('https://your-cockpit.example.invalid', {
        redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'oai-sites-authorization': `Bearer ${calendarToken}` } });
      invariant(response.ok, 'CALENDAR_READ_FAILED'); return boundedResponseJson(response, 1048576);
    } });
    const provider = new ExecutionFrameProvider({ publicStreams, strategy, candidateSignal: smcExecutionSignal,
      candidateMaximumAgeMs: riskProfile.candidateMaximumAgeMs,
      accountCache: new AccountCache({ transport: readPort, userStream: accountStream }),
      ...readOnlyMetadataPorts({ publicGet: (p, args) => venueJson('GET', p, args), signedGet: (p, args) => readPort.request('GET', p, args),
        canRead: weight => budget.canStartLowPriorityRead(weight, 265) }),
      loadCalendar: () => calendar.read(), loadCandidates: async () => {
        const now = Date.now();
        const automatic = smcCandidateSnapshot(await boundedJsonFile(SCAN_PATH), riskProfile, now);
        const authorization = await readSmcAuthorizationStatus({ limits: trialLimits });
        const [ownerResult, manualResult, positionActionResult] = await Promise.allSettled([
          readOwnerAutoControls(now),
          authorization.manualEntriesEnabled ? readManualIntents(now) : Promise.resolve([]),
          authorization.exitsEnabled ? readPositionActions(now) : Promise.resolve([]),
        ]);
        let ownerControlFeed = { status: 'UNAVAILABLE', checkedAt: now, controls: [] };
        if (ownerResult.status === 'fulfilled') ownerControlFeed = ownerResult.value;
        else await journal.append({ type: 'SMC_OWNER_AUTO_CONTROL_READ_FAILED', at: now,
          reason: /^[A-Z0-9_]+$/.test(ownerResult.reason?.message ?? '') ? ownerResult.reason.message : 'SMC_OWNER_AUTO_CONTROL_UNAVAILABLE' });
        const governedAutomatic = { ...automatic,
          plans: applyOwnerSelectedAutoControls(automatic.plans, ownerControlFeed, now) };
        if (!authorization.manualEntriesEnabled) return governedAutomatic;
        let intents = [];
        if (manualResult.status === 'fulfilled') intents = manualResult.value;
        else await journal.append({ type: 'SMC_MANUAL_QUEUE_READ_FAILED', at: now,
          reason: /^[A-Z0-9_]+$/.test(manualResult.reason?.message ?? '') ? manualResult.reason.message : 'SMC_MANUAL_QUEUE_UNAVAILABLE' });
        for (const intent of intents) pendingManual.set(intent.id, intent);
        if (positionActionResult.status === 'fulfilled') latestPositionActions = positionActionResult.value;
        else {
          latestPositionActions = [];
          await journal.append({ type: 'SMC_POSITION_ACTION_QUEUE_READ_FAILED', at: now,
            reason: /^[A-Z0-9_]+$/.test(positionActionResult.reason?.message ?? '')
              ? positionActionResult.reason.message : 'SMC_POSITION_ACTION_QUEUE_UNAVAILABLE' });
        }
        for (const action of latestPositionActions) pendingPositionActions.set(action.id, action);
        intents = latestManualIntents(intents);
        return { ...governedAutomatic, plans: [...intents.map(intent => ({
          id: `MANUAL-${intent.id.replaceAll('-', '').toUpperCase()}`, symbol: intent.symbol,
          direction: intent.direction, status: 'OWNER_MANUAL_PENDING', intent,
          createdAt: intent.createdAt, observedAt: intent.createdAt,
          intersectionTime: intent.createdAt, intersectionPrice: 1, referencePrice: 1,
        })), ...governedAutomatic.plans] };
      },
      infrastructure: async () => {
        const authorization = await readSmcAuthorizationStatus({ limits: trialLimits });
        return { diskReady: store.status().captureReady && fresh(clockAt, Date.now(), 120000),
          singleWriter: !!journal.owner && !!store.writerLease?.held,
          manualOrdersEnabled: authorization.manualEntriesEnabled === true,
          exitsAllowed: authorization.exitsEnabled === true };
      } });
    execution = createSmcProductionExecutionRuntime({ credentials, ipBudget: budget,
      maximumOrders10s: orderLimits.orders10s, maximumOrders60s: orderLimits.orders60s,
      journal, readPort, runtime, strategy, riskProfile, trialLimits, mode,
      frameProvider: async options => { let frame = await provider.read(options); latestAccount = frame.account;
        // Local scanner evidence only; no additional exchange requests or order writer.
        for (const symbol of Object.keys(frame.market)) {
          try {
            const input = await boundedJsonFile(`/var/lib/aegis/smc-scanner/${symbol}-evidence.json`);
            invariant(input.symbol === symbol && fresh(input.now, Date.now(), 360000), 'SMC_STOP_CONTEXT_STALE');
            frame.market[symbol].intersectionClock = (await boundedJsonFile(SCAN_PATH)).results?.find(r=>r.symbol===symbol)?.intersectionClock;
            frame.market[symbol].stopSafetyContext = {...stopSafetyContext(input),targetPathEvidence:build4hFvgEvidence(input)};
            await lifecycleTracker.refresh();
            frame.market[symbol].conditionalLifecycle = { available: lifecycleTracker.available, state: lifecycleTracker.state,
              plans: lifecycleTracker.snapshot?.results?.find(r => r.symbol === symbol)?.structurePlans ?? [] };
          } catch { frame.market[symbol].stopSafetyContext = null; frame.market[symbol].conditionalLifecycle = { available: false }; }
        }
        if (!options?.forceAccountRefresh && await guardRestingSmcEntries({ kernel: execution.kernel, market: frame.market, fees: frame.fees, now: Date.now() })) {
          const contexts = Object.fromEntries(Object.entries(frame.market).map(([symbol, m]) => [symbol, { intersectionClock:m.intersectionClock,stopSafetyContext: m.stopSafetyContext, conditionalLifecycle: m.conditionalLifecycle }]));
          frame = await provider.read({ ...options, forceAccountRefresh: true }); latestAccount = frame.account;
          for (const [symbol, m] of Object.entries(frame.market)) Object.assign(m, contexts[symbol] ?? { stopSafetyContext: null, conditionalLifecycle: { available: false } });
        }
        for (const [symbol,m] of Object.entries(frame.market)) {
          frame.bars[symbol] ??= {}; frame.bars[symbol].smcStopContext=m.stopSafetyContext;
        }
        return { ...frame, ownerPositionActions: options?.pinnedSignal ? [] : latestPositionActions }; },
      evidenceArchive: new EntryEvidenceArchive({ store }),
      entryQualityRequired: false, prepareEntryFn: (input,profile,now)=>prepareSmcEntry({...input,requiredTargetPathRevision:TARGET_PATH_REVISION},profile,now),
      residentPorts: { publicStreams, accountStream, refreshContext: async () => { await refreshClock(); await provider.refreshMarketContext(); },
        priceFrame: () => ({ market: publicStreams.market(), rules: provider.rules }),
        refreshFees: () => provider.refreshFees(), refreshCalendar: () => calendar.refresh(),
        publishStatus: async state => {
          for (const [id, intent] of pendingManual) {
            const planId = `MANUAL-${id.replaceAll('-', '').toUpperCase()}`;
            const entry = [...execution.kernel.intents.values()].find(row => row.planId === planId && row.kind === 'entry');
            const blocker = execution.engine.lastEntryBlockers?.find(row => row.id === planId);
            const receipt = smcManualIntentReceipt({ entry, blocker, expired: Date.now() > intent.expiresAt });
            if (!receipt) continue;
            try { await updateManualIntent(id, receipt.status, receipt.reason); pendingManual.delete(id); }
            catch { /* Retry receipt; never resubmit an owned intent. */ }
          }
          const ownerAction = execution.engine.lastOwnerPositionAction;
          if (ownerAction && pendingPositionActions.has(ownerAction.id)) {
            try {
              await updatePositionAction(ownerAction.id, ownerAction.status, ownerAction.reason);
              if (ownerAction.status !== 'SUBMITTED') pendingPositionActions.delete(ownerAction.id);
            } catch { /* A repeated action id is durable and safe to retry. */ }
          }
          const filename = path.join(SMC_EXECUTION_ROOT, 'latest.json');
          const authorization = await readSmcAuthorizationStatus({ limits: trialLimits });
          const status = smcHostStatus(state, authorization, { mode, captureReady: store.status().captureReady,
            strategyRuntime, account: latestAccount, book: execution.book, kernel: execution.kernel, rules: provider.rules });
          await fs.writeFile(`${filename}.next`, JSON.stringify(status), { mode: 0o600 });
          await fs.rename(`${filename}.next`, filename);
          const decision = decisionProjection(status);
          const fingerprint = hash({ ...decision, observedAt: undefined });
          if (fingerprint !== latestDecisionFingerprint) {
            await fs.appendFile(path.join(SMC_EXECUTION_ROOT, 'entry-decisions.jsonl'),
              `${JSON.stringify({ ...decision, fingerprint })}\n`, { mode: 0o600 });
            latestDecisionFingerprint = fingerprint;
          }
          try { await publishCockpit(status); await fs.writeFile(path.join(SMC_EXECUTION_ROOT, 'publish.json'),
            JSON.stringify({ status: 'SYNCED', observedAt: status.observedAt, at: new Date().toISOString() }), { mode: 0o600 }); }
          catch (error) { await fs.writeFile(path.join(SMC_EXECUTION_ROOT, 'publish.json'),
            JSON.stringify({ status: 'FAILED', reason: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'SMC_LEDGER_PUBLISH_FAILED', at: new Date().toISOString() }), { mode: 0o600 }); }
        }, onStall: signal } });
    execution.resident.activityMonitor = new AccountActivityMonitor({
      engine: execution.engine, book: execution.book, transport: readPort, stream: accountStream,
      executionReconciliation: true, prioritizeCoverage: true,
      canPoll: () => budget.canStartLowPriorityRead(45, SHADOW_BACKGROUND_READ_HEADROOM) });
    await step(() => journal.append({ type: 'EXECUTION_HOST_STARTING', at: Date.now(), mode,
      strategyRevision: SMC_EXECUTION_REVISION, riskProfileDigest: hash(riskProfile) }));
    checkpoint(); execution.start({ cycleIntervalMs: 15000 });
    return { execution, close };
  })();
  try { return await initialization; }
  catch (error) { await close(); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    invariant(process.argv.length === 3 && process.argv[2] === '--live', 'SMC_EXECUTION_ARGUMENTS_FORBIDDEN');
    await runSmcExecutionHost({ mode: 'LIVE' });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'SMC_EXECUTION_HOST_START_FAILED', reason: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'START_FAILED', realOrdersAllowed: false })}\n`);
    process.exitCode = 1;
  }
}
