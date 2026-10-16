import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertProbeHost, boundedJsonFile, candidateSnapshot, readOnlyMetadataPorts, unpersistedProbeMarket } from './readonly-ports.mjs';
import { readCredentialFile, loadProductionCredentials } from '../binance-prod2/credentials.mjs';
import { SignedTransport } from './transport.mjs';
import { AccountCache } from './account-reader.mjs';
import { AccountStream, PublicStreams } from './streams.mjs';
import { ForwardEvidence } from './market-evidence.mjs';
import { ExecutionFrameProvider } from './frame-provider.mjs';
import { UNIVERSE, fresh, invariant } from './common.mjs';

// One-shot real-network contract probe, NOT a trader or continuous shadow soak.
// No kernel, order lifecycle, SQLite writer or mutable production state mounts.
export async function runReadOnlyProbe() {
  assertProbeHost(os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID, process.getuid());
  invariant(process.argv.length === 2, 'PROBE_ARGUMENTS_FORBIDDEN');
  const startedAt = Date.now(), deadline = startedAt + 120000;
  let requests = 0, blocked = false, stopped = false, events = 0, gaps = 0;
  const credentials = await loadProductionCredentials({ credentials: { apiKeyFile: '/etc/aegis/secrets/binance-prod2/BN-KEY-PROD2', secretKeyFile: '/etc/aegis/secrets/binance-prod2/BN-SECRET-PROD2', requiredOwnerUid: 0, requiredMode: '0440' } });
  const hardTimeout = setTimeout(() => { process.stdout.write('{"status":"READ_ONLY_PROBE_TIMEOUT","realOrdersAllowed":false}\n'); process.exit(2); }, 125000);
  const transport = new SignedTransport({ credentials });
  const budget = () => { invariant(!blocked && Date.now() < deadline && ++requests <= 64, 'PROBE_REQUEST_BUDGET_OR_CIRCUIT'); };
  const jsonRequest = async (url, init = {}) => {
    budget();
    try {
      const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if ([418, 429].includes(response.status)) blocked = true;
      invariant(response.ok, 'PROBE_HTTP_READ_FAILED');
      const reader = response.body.getReader(), buffers = []; let total = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.length;
        if (total > 4 * 1024 ** 2) { await reader.cancel(); throw new Error('PROBE_RESPONSE_TOO_LARGE'); }
        buffers.push(value);
      }
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch { throw new Error('PROBE_HTTP_READ_FAILED'); }
  };
  const signedGet = async (pathname, params) => {
    budget();
    try { return await transport.request('GET', pathname, params); }
    catch (error) { if ([418, 429].includes(error.httpStatus)) blocked = true; throw error; }
  };
  const publicGet = async (pathname, params = {}) => {
    invariant(['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/klines'].includes(pathname), 'PROBE_PUBLIC_ENDPOINT');
    const url = new URL(pathname, 'https://demo-fapi.binance.com'); url.search = new URLSearchParams(params).toString();
    return jsonRequest(url, { method: 'GET' });
  };
  const token = async method => {
    invariant(['POST', 'PUT'].includes(method), 'PROBE_LISTEN_CONTROL_FORBIDDEN');
    return jsonRequest('https://demo-fapi.binance.com/fapi/v1/listenKey', { method, headers: { 'X-MBX-APIKEY': credentials.apiKey } });
  };
  const accountStream = new AccountStream({ createToken: async () => (await token('POST')).listenKey, renewToken: () => token('PUT') });
  // Forward validation is exercised, but this memory sink is explicitly stripped
  // of persistence qualification before entering a frame. Never keep raw events.
  const evidence = new ForwardEvidence({ maximumQueue: 10000, persist: async rows => { events += rows.length; } });
  let rejectedEvent = null;
  const ingest = evidence.ingest.bind(evidence);
  evidence.ingest = message => {
    const connectedAt = evidence.connectedAt, receivedAt = Date.now(), accepted = ingest(message);
    if (!accepted) rejectedEvent = { reason: evidence.gapReason, symbol: message.s, type: message.e,
      marketLagMs: receivedAt - message.T, eventLagMs: receivedAt - message.E, connectionAgeMs: receivedAt - connectedAt };
    return accepted;
  };
  const gapReasons = {};
  const streams = new PublicStreams({ evidence, onGap: gap => { gaps++; gapReasons[gap.reason] = (gapReasons[gap.reason] ?? 0) + 1; } });
  let pumping;
  try {
    const clockBefore = Date.now(), server = await publicGet('/fapi/v1/time'), clockAfter = Date.now();
    const clock = { roundTripMs: clockAfter - clockBefore, midpointOffsetMs: server.serverTime - (clockBefore + clockAfter) / 2 };
    invariant(Math.abs(server.serverTime - clockAfter) <= 1000, 'PROBE_CLOCK_SKEW');
    pumping = (async () => {
      while (!stopped) { await streams.pulse(); await accountStream.pulse(); await delay(100); }
    })().catch(() => { stopped = true; });
    const readyDeadline = Date.now() + 20000;
    while ((!accountStream.status().connected || evidence.connectedAt === null) && Date.now() < readyDeadline && !stopped) await delay(100);
    invariant(accountStream.status().connected && evidence.connectedAt !== null, 'PROBE_STREAMS_NOT_CONNECTED');
    const scannerConfig = await boundedJsonFile(new URL('../s2-scanner/config.json', import.meta.url));
    let scannerSequence = null, candidateError = null, calendarError = null;
    const provider = new ExecutionFrameProvider({
      accountCache: new AccountCache({ transport: { request: (method, pathname, params) => { invariant(method === 'GET', 'PROBE_GET_ONLY'); return signedGet(pathname, params); } }, userStream: accountStream }),
      publicStreams: { market: () => unpersistedProbeMarket(streams.market()) }, strategy: scannerConfig.strategy,
      ...readOnlyMetadataPorts({ publicGet, signedGet }),
      loadCandidates: async () => {
        try {
          const latest = await boundedJsonFile('/var/lib/aegis/s2-scanner/latest.json');
          const state = await boundedJsonFile('/var/lib/aegis/s2-scanner/state.json');
          const snapshot = candidateSnapshot(state, latest, Date.now()); scannerSequence = snapshot.sequence; candidateError = null; return snapshot;
        } catch { candidateError = 'PROBE_SCANNER_INPUT_UNAVAILABLE'; throw new Error(candidateError); }
      },
      loadCalendar: async () => {
        try {
          const key = await readCredentialFile('/etc/aegis/secrets/s1-probe/calendar-token');
          const calendar = await jsonRequest('https://your-cockpit.example.invalid', { method: 'GET', headers: { 'oai-sites-authorization': `Bearer ${key}` } });
          calendarError = null; return calendar;
        } catch { calendarError = 'PROBE_CALENDAR_INPUT_UNAVAILABLE'; throw new Error(calendarError); }
      },
      infrastructure: async () => ({ diskReady: false, singleWriter: false }),
    });
    await provider.refreshEntryContext();
    const summarize = frame => ({ accountObservedAt: frame.account.observedAt, equityUsdt: frame.account.equityUsdt,
      userStreamStable: frame.account.userStreamConnected, canTrade: frame.account.canTrade, dualSidePosition: frame.account.dualSidePosition,
      multiAssetsMargin: frame.account.multiAssetsMargin, positions: frame.account.positions.filter(p => Number(p.positionAmt) !== 0).length,
      orders: frame.account.orders.length, algos: frame.account.algos.length, rulesSymbols: Object.keys(frame.rules).length,
      feeSymbols: Object.keys(frame.fees).length, barSymbols: UNIVERSE.filter(s => frame.bars[s].bars1h.length && frame.bars[s].bars15m.length).length,
      freshBboSymbols: UNIVERSE.filter(s => fresh(frame.market[s]?.bbo?.marketTime, Date.now(), 2000)).length,
      freshTickSymbols: UNIVERSE.filter(s => fresh(frame.market[s]?.tick?.marketTime, Date.now(), 2000)).length,
      signalCount: frame.signals.length, scannerSequence, candidateError, calendarError, calendarStatus: frame.eventGate.status });
    const first = summarize(await provider.read());
    process.stdout.write(JSON.stringify({ status: 'READ_ONLY_PROBE_OBSERVING', elapsedMs: Date.now() - startedAt, requests, first, realOrdersAllowed: false }) + '\n');
    await delay(30000);
    const last = summarize(await provider.read({ forceAccountRefresh: true }));
    const metadataAccepted = last.rulesSymbols === 10 && last.feeSymbols === 10 && last.barSymbols === 10;
    const inputsAccepted = first.userStreamStable && last.userStreamStable && metadataAccepted && !candidateError && !calendarError && last.calendarStatus !== 'CALENDAR_UNVERIFIED_PAUSE' && last.freshBboSymbols === 10 && last.freshTickSymbols === 10 && gaps === 0 && rejectedEvent === null;
    return { schemaVersion: 1, status: inputsAccepted ? 'READ_ONLY_PROBE_INPUTS_ACCEPTED' : 'READ_ONLY_PROBE_INPUT_GAPS',
      checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, requests, eventsObserved: events, warmupDiscarded: evidence.warmupDiscarded, connectionGaps: gaps, gapReasons: { ...gapReasons }, rejectedEvent, clock, first, last,
      realOrdersAllowed: false, newEntriesBlocked: true, durableEvidence: false, liveReady: false, continuousSoakAccepted: false };
  } finally {
    stopped = true; streams.close(); accountStream.close();
    await pumping; clearTimeout(hardTimeout);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runReadOnlyProbe()) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ status: 'READ_ONLY_PROBE_FAILED', reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_UNEXPECTED_ERROR', realOrdersAllowed: false }) + '\n'); process.exitCode = 1; }
}
