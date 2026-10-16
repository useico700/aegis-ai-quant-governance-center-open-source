import { setTimeout as delay } from 'node:timers/promises';
import { invariant, fresh } from './common.mjs';
import { SignedTransport } from './transport.mjs';
import { AccountCache } from './account-reader.mjs';
import { AccountStream } from './streams.mjs';
import { CoordinatedReadSession } from './coordinated-read-session.mjs';
import { CoordinatedPublicReads } from './coordinated-public-reads.mjs';
import { coordinatedStreamControl, coordinatedActivityTransport, prepareCoordinatedActivityTransport } from './coordinated-auxiliary-ports.mjs';
import { readOnlyMetadataPorts } from './readonly-ports.mjs';

// Actual read-only composition. The host owns session startup, fixed identity,
// credential loading and final resource release. Tests inject synthetic ports.
export class CoordinatedShadowReads {
  #session; #now; #sleep; #public; #time = null; #contextTask = null;
  #transport; #closed = false; #closing = null; #initializationStarted = false; #abort = new AbortController();
  constructor({ session, credentials, now = Date.now, fetcher = fetch, WebSocketImpl = globalThis.WebSocket,
    sleep = (ms, signal) => delay(ms, undefined, { signal }), onChange = () => {} }) {
    invariant(session instanceof CoordinatedReadSession && session.status().started && !session.status().stopping,
      'COORDINATED_SHADOW_SESSION_REQUIRED');
    this.#session = session; this.#now = now; this.#sleep = sleep;
    this.#transport = admission => { this.#active(); return new SignedTransport({ credentials, admission, fetcher, now }); };
    this.#public = new CoordinatedPublicReads({ session, consumer: 'shadow', now, fetcher, sleep,
      observeTiming: timing => { if (timing.pathname === '/fapi/v1/time') this.#time = timing; } });
    this.clockVerifiedAt = 0; this.clockError = 'CLOCK_NOT_VERIFIED';
    const config = { venue: { restBaseUrl: 'https://demo-fapi.binance.com' }, runtime: { requestTimeoutMs: 5000 } };
    const control = coordinatedStreamControl({ dispatcher: session.auxiliary, consumer: 'shadow' });
    let plannedAt = null;
    this.accountStream = new AccountStream({ now, WebSocketImpl, onChange,
      createToken: async () => { this.#active(); return (await control(config, 'POST', credentials, { fetchImpl: fetcher })).listenKey; },
      prepareRenewal: ({ readyAt }) => { this.#active(); control.prepareRenewal({ readyAt, timeoutMs: 5000 }); plannedAt = readyAt; },
      cancelRenewal: () => { control.cancelRenewal(); plannedAt = null; },
      renewToken: async () => {
        this.#active();
        invariant(plannedAt !== null && plannedAt === this.accountStream.renewedAt + 1200000
          && now() >= plannedAt && now() < plannedAt + 5000, 'COORDINATED_SHADOW_RENEWAL_PLAN_REQUIRED');
        try { return await control(config, 'PUT', credentials, { fetchImpl: fetcher }); }
        finally { plannedAt = null; }
      } });
    this.accountCache = new AccountCache({ readSession: session, createAdmittedTransport: this.#transport, userStream: this.accountStream, now });
    this.metadata = readOnlyMetadataPorts({ now, publicGet: this.#public.get.bind(this.#public), assertPublicReadable: () => this.#public.assertReadable() });
    // No generic read/mutation escape hatch is handed to the kernel/lifecycle.
    // All actual signed reads must come through a fixed admitted lane below.
    this.closedTransport = Object.freeze({ request: async () => { throw new Error('SHADOW_GENERIC_TRANSPORT_FORBIDDEN'); } });
  }
  #active() {
    invariant(!this.#closed && !this.#session.status().stopping, 'COORDINATED_SHADOW_STOPPED');
  }
  framePorts() {
    return { accountCache: this.accountCache, ...this.metadata, ageRuleTargets: true, feeReadSession: this.#session,
      loadAdmittedFees: (symbol, admission) => {
        this.#active();
        return readOnlyMetadataPorts({ now: this.#now, signedGet: (p, q) => this.#transport(admission).request('GET', p, q) }).loadFees(symbol);
      } };
  }
  activityPorts() {
    return { prioritizeCoverage: true,
      prepareTransportForWindow: window => {
        this.#active(); return prepareCoordinatedActivityTransport({ ...window,
          dispatcher: this.#session.auxiliary, createTransport: this.#transport });
      },
      transportForWindow: ({ deadlineAt, schedulingTargetAt }) => {
      this.#active(); return coordinatedActivityTransport({ dispatcher: this.#session.auxiliary, deadlineAt, schedulingTargetAt,
        reserveHistoryIo: true, createTransport: this.#transport });
    } };
  }
  async refreshClock() {
    this.#active();
    if (fresh(this.clockVerifiedAt, this.#now(), 60000)) return;
    try {
      this.#time = null;
      const server = await this.#public.get('/fapi/v1/time'), timing = this.#time;
      // Queue delay is not network RTT. These times are sampled inside actual
      // admission and after body consumption; the original 1s checks remain.
      invariant(timing && Number.isSafeInteger(server?.serverTime) && timing.completedAt >= timing.startedAt
        && timing.completedAt - timing.startedAt <= 1000 && Math.abs(server.serverTime - timing.completedAt) <= 1000,
      'SHADOW_CLOCK_SKEW');
      this.clockVerifiedAt = timing.completedAt; this.clockError = null;
    } catch (error) { this.clockError = 'CLOCK_UNVERIFIED'; throw error; }
  }
  #window(action) {
    this.#active();
    invariant(!this.#contextTask, 'COORDINATED_SHADOW_CONTEXT_BUSY');
    const task = Promise.resolve().then(async () => {
      this.#active(); this.#public.beginWindow(this.#now() + 30000);
      try { return await action(); } finally { await this.#public.closeWindow(); }
    });
    this.#contextTask = task;
    task.then(() => { this.#contextTask = null; }, () => { this.#contextTask = null; }).catch(() => {});
    return task;
  }
  async initialize() {
    // Establish the authenticated stream before account/context/history work
    // competes for the same IP budget. No disconnected snapshot is readiness.
    this.#active(); invariant(!this.#initializationStarted, 'COORDINATED_SHADOW_ALREADY_INITIALIZED'); this.#initializationStarted = true;
    await this.accountStream.pulse(); this.#active();
    const until = this.#now() + 10000;
    while (!this.accountStream.status().connected && !this.accountStream.status().lastError && this.#now() < until) {
      const before = this.#now();
      await this.#sleep(Math.min(100, until - before), this.#abort.signal); this.#active();
      invariant(this.#now() > before, 'COORDINATED_SHADOW_STARTUP_CLOCK');
    }
    invariant(this.accountStream.status().connected, 'COORDINATED_SHADOW_STREAM_START_FAILED');
    return this.#window(async () => {
      const info = await this.#public.get('/fapi/v1/exchangeInfo');
      invariant(info.rateLimits?.some(r => r.rateLimitType === 'REQUEST_WEIGHT' && r.interval === 'MINUTE' && r.intervalNum === 1 && r.limit >= 2400),
        'SHADOW_VENUE_RATE_LIMIT_REVIEW_REQUIRED');
      await this.refreshClock();
    });
  }
  refreshContext(provider) {
    return this.#window(async () => {
      try { await this.refreshClock(); } catch { /* Clock expires independently; never fake readiness. */ }
      await provider.refreshMarketContext();
    });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true; this.#abort.abort();
    this.#session.stop();
    this.#closing = (async () => {
      const results = await Promise.allSettled([this.#public.closeWindow(), this.accountStream.close(), this.#contextTask]);
      invariant(results.every(r => r.status === 'fulfilled'), 'COORDINATED_SHADOW_READ_DRAIN_FAILED');
    })();
    this.#closing.catch(() => {}); return this.#closing;
  }
}
