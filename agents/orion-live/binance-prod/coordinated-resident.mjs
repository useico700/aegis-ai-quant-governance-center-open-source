import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, runPreflight } from './preflight.mjs';
import { loadProductionCredentials } from './credentials.mjs';
import { enforceRawRetention } from './retention.mjs';
import { readJson, writeJsonAtomic, processAlive, sleep } from './runtime-utils.mjs';
import { CoordinatedProductionReader } from './coordinated-reader.mjs';
import { ProductionUserStreamMonitor } from './user-stream.mjs';
import { coordinatedStreamControl } from '../s1-execution/coordinated-auxiliary-ports.mjs';
import { CoordinatedReadSession } from '../s1-execution/coordinated-read-session.mjs';
import { openProductionCoordinatedReadSession } from '../s1-execution/coordinated-host-admission.mjs';
import { assertSharedAdmissionHost } from '../s1-execution/host-admission.mjs';
import { createShadowHostLifecycle } from '../s1-execution/shadow-shutdown.mjs';
import { invariant } from '../s1-execution/common.mjs';

export function assertCoordinatedReaderConfig(config, hostname, hostIdentity) {
  invariant(config?.mode === 'PRODUCTION_READ_ONLY_SHADOW' && hostname === 'aegis-demo-host' && hostIdentity === 'demo-server'
    && config.host.requiredHostname === hostname && config.host.requiredIdentity === hostIdentity
    && config.venue.restBaseUrl === 'https://demo-fapi.binance.com' && config.venue.userStreamBaseUrl === 'wss://fstream.binancefuture.com/ws'
    && config.runtime.root === '/var/lib/aegis/binance-prod'
    && config.runtime.cycleIntervalMs === 60000 && config.runtime.accountStaleAfterMs === 120000
    && config.runtime.requestTimeoutMs === 8000 && config.runtime.userStreamKeepaliveMs === 3000000
    && config.runtime.userStreamReconnectMaximumMs === 30000
    && config.retention.rawManagement === 'SEGMENTED_WRITER_OBSERVER'
    && config.retention.rawRoot === '/var/lib/aegis/binance-prod/evidence/raw'
    && config.retention.rawMaximumBytes === 42949672960 && config.retention.rawRetentionDays === 7
    && config.execution.realOrdersAllowed === false && config.execution.newEntriesBlocked === true
    && config.execution.strategyAssigned === false && config.execution.orderTestAllowed === false
    && Array.isArray(config.execution.tradingMutationMethodsAllowed) && config.execution.tradingMutationMethodsAllowed.length === 0,
  'COORDINATED_READER_BOUNDARY');
}

// Actual producer composition. The server wrapper supplies real ports; offline
// tests inject synthetic credentials/HTTP/socket/files only at this seam.
export class CoordinatedReaderResident {
  #task = null; #closing = null; #stopped = false; #stream = null; #nextRead = 0; #nextConnect = 0; #last = null;
  #verifiedSnapshot = null;
  #observationClockHighWater = 0;
  constructor({ config, credentials, session, hostname, hostIdentity, publishStatus, retentionCheck = enforceRawRetention,
    now = Date.now, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
    setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    assertCoordinatedReaderConfig(config, hostname, hostIdentity);
    invariant(session instanceof CoordinatedReadSession && typeof publishStatus === 'function', 'COORDINATED_READER_PORTS');
    Object.assign(this, { config, credentials, session, hostname, hostIdentity, publishStatus, retentionCheck, now, fetchImpl,
      WebSocketImpl, setIntervalImpl, clearIntervalImpl });
    this.reader = new CoordinatedProductionReader(session, { now });
    this.control = coordinatedStreamControl({ dispatcher: session.auxiliary, consumer: 'reader' });
  }
  #active() { return !this.#stopped && !this.session.status().stopping; }
  #snapshotCurrent(saved = this.#verifiedSnapshot) {
    if (!saved) return false;
    const stream = this.#stream?.status(), at = this.now(), priorClock = this.#observationClockHighWater;
    if (Number.isSafeInteger(at)) this.#observationClockHighWater = Math.max(priorClock, at);
    const observedAt = Date.parse(saved?.value.account?.observedAt);
    const valid = !saved.invalidated && Number.isSafeInteger(at) && at >= priorClock
      && saved.stream === this.#stream && saved.credentials === this.credentials
      && stream?.connected === true && stream.lastError === null
      && stream.connectedAt === saved.connectedAt && stream.eventCount === saved.eventCount
      && Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= at
      && at - observedAt <= this.config.runtime.accountStaleAfterMs;
    // Revocation is sticky even for a caller holding a pending-publication
    // reference. Status queries do not heartbeat, read the budget or send I/O.
    if (!valid) {
      saved.invalidated = true;
      if (this.#verifiedSnapshot === saved) this.#verifiedSnapshot = null;
    }
    return valid;
  }
  #invalidObservation(value) {
    const invalid = { ...value, status: 'DEGRADED_FAIL_CLOSED', error: 'COORDINATED_READER_ACCOUNT_OBSERVATION_INVALID',
      accountRefresh: { ...value.accountRefresh, retainedVerifiedSnapshot: false, observationValid: false } };
    delete invalid.account;
    return invalid;
  }
  pulse() {
    invariant(this.#active(), 'COORDINATED_READER_STOPPED');
    // Maintenance preparation is not tied to whether an account read is due.
    try { this.#stream?.prepareKeepalive(); } catch { /* Stream exposes a fixed failure and is replaced below. */ }
    if (this.#task) return this.#task;
    const task = Promise.resolve().then(() => this.#run()); this.#task = task;
    task.finally(() => { this.#task = null; }).catch(() => {}); return task;
  }
  async #publish(result, readStream = null) {
    if (!this.#active()) return;
    const userStream = this.#stream?.status() ?? null;
    const requestBudget = this.session.readBudgetStatus();
    let accountRefresh = result.accountRefresh;
    let nextSnapshot = this.#verifiedSnapshot;
    const queued = result.error === 'PRODUCTION_COORDINATED_READ_DEFERRED' && accountRefresh?.status === 'QUEUED_UNSENT';
    if (queued) {
      // Availability of an already verified observation is separate from the
      // next refresh's admission. Never renew its source time, hide the WAIT,
      // reuse across an account event/reconnect, or cross a global cooldown.
      const ordinaryWait = ['READ_COORDINATION_NOT_SELECTED', 'READ_COORDINATION_WAIT_FOR_RELEASE',
        'READ_COORDINATION_WAIT_FOR_BUDGET'].includes(accountRefresh.reason);
      const reusable = ordinaryWait && this.#snapshotCurrent() && this.#verifiedSnapshot.value.status === 'READY_READ_ONLY_SHADOW'
        && result.retention?.blockNewEntries === false
        && Number.isSafeInteger(requestBudget.blockedUntil) && requestBudget.blockedUntil <= this.now()
        && requestBudget.coordination?.allOwnersFresh === true && requestBudget.stopping === false;
      accountRefresh = { ...accountRefresh, retainedVerifiedSnapshot: reusable, observationValid: reusable };
      if (reusable) {
        const prior = this.#verifiedSnapshot.value;
        result = { ...result, status: 'READY_READ_ONLY_SHADOW', account: structuredClone(prior.account),
          apiKeyFingerprint: prior.apiKeyFingerprint, secretKeyFingerprint: prior.secretKeyFingerprint };
      } else nextSnapshot = this.#verifiedSnapshot = null;
    } else if (['READY_READ_ONLY_SHADOW', 'READ_ONLY_ATTENTION_REQUIRED'].includes(result.status) && result.account && !result.error) {
      accountRefresh = { status: 'COMPLETED', reason: null, retainedVerifiedSnapshot: false, observationValid: true };
      // A complete HTTP response spanning an event/reconnect is not a current
      // account observation, including its FIRST publication, not just reuse.
      nextSnapshot = readStream?.stream === this.#stream && userStream?.connected === true
        && userStream.lastError === null && readStream.connectedAt === userStream.connectedAt
        && readStream.eventCount === userStream.eventCount
        ? { value: structuredClone(result), credentials: this.credentials, ...readStream } : null;
      if (!this.#snapshotCurrent(nextSnapshot)) {
        nextSnapshot = this.#verifiedSnapshot = null;
        result = this.#invalidObservation({ ...result, accountRefresh }); accountRefresh = result.accountRefresh;
      } else if (result.status !== 'READY_READ_ONLY_SHADOW') this.#verifiedSnapshot = null;
    } else nextSnapshot = this.#verifiedSnapshot = null;
    const value = { runtimeId: this.config.runtimeId, mode: this.config.mode, hostname: this.hostname,
      hostIdentity: this.hostIdentity, hostVerified: true, ...result, ...(accountRefresh ? { accountRefresh } : {}), userStream, requestBudget,
      realOrdersAllowed: false, newEntriesBlocked: true };
    if (!userStream?.connected || userStream.lastError) value.status = 'DEGRADED_FAIL_CLOSED';
    await this.publishStatus(structuredClone(value)); this.#last = value;
    if (value.account && !this.#snapshotCurrent(nextSnapshot)) {
      this.#verifiedSnapshot = null;
      // A stream event can arrive during the atomic status-file write. Fence
      // the final projection before returning; do not dispatch another read.
      await this.#publish(this.#invalidObservation({ ...value, checkedAt: new Date(this.now()).toISOString() }));
    } else this.#verifiedSnapshot = nextSnapshot;
  }
  async #run() {
    if (!this.#active()) return;
    if (this.#last?.account && !this.#snapshotCurrent()) {
      await this.#publish(this.#invalidObservation({ checkedAt: new Date(this.now()).toISOString() }));
    }
    const state = this.#stream?.status();
    if (!state?.connected || state.lastError) {
      this.#verifiedSnapshot = null;
      if (this.now() < this.#nextConnect) return;
      await this.#stream?.close(); if (!this.#active()) return;
      this.#stream = null;
      const retention = await this.retentionCheck(this.config); if (!this.#active()) return;
      this.#stream = new ProductionUserStreamMonitor(this.config, this.credentials, { now: this.now, control: this.control,
        prepareRenewal: this.control.prepareRenewal, cancelRenewal: this.control.cancelRenewal,
        WebSocketImpl: this.WebSocketImpl, setIntervalImpl: this.setIntervalImpl, clearIntervalImpl: this.clearIntervalImpl, sharedAccountToken: true });
      try { await this.#stream.start({ fetchImpl: this.fetchImpl }); }
      catch {
        this.#nextConnect = this.now() + this.config.runtime.userStreamReconnectMaximumMs;
        await this.#publish({ checkedAt: new Date(this.now()).toISOString(), status: 'DEGRADED_FAIL_CLOSED',
          error: 'COORDINATED_READER_STREAM_UNAVAILABLE', retention }); return;
      }
    }
    if (!this.#active() || this.now() < this.#nextRead) return;
    const readStream = { stream: this.#stream, connectedAt: this.#stream.status().connectedAt, eventCount: this.#stream.status().eventCount };
    const result = await runPreflight({ coordinatedReader: this.reader, configLoader: async () => this.config,
      credentialsLoader: async () => this.credentials, retentionCheck: this.retentionCheck,
      hostname: this.hostname, hostIdentity: this.hostIdentity, fetchImpl: this.fetchImpl, now: this.now });
    if (!this.#active()) return;
    // Only an unsent queued batch gets the one-second retry. Sent failures
    // retain the old 60-second cadence; original source timestamps survive.
    this.#nextRead = this.now() + (result.error === 'PRODUCTION_COORDINATED_READ_DEFERRED' ? 1000 : this.config.runtime.cycleIntervalMs);
    await this.#publish(result, readStream);
  }
  status() {
    let latest = structuredClone(this.#last ?? {});
    if (latest.account && !this.#snapshotCurrent()) latest = this.#invalidObservation(latest);
    return { ...latest, accountLabel: 'S1', mode: 'PRODUCTION_READ_ONLY_SHADOW',
      status: this.#stopped ? 'STOPPED' : latest.status ?? 'STARTING',
      realOrdersAllowed: false, newEntriesBlocked: true, shutdownDrainCompleted: this.drainCompleted ?? false };
  }
  async publishStopped() {
    invariant(this.drainCompleted === true, 'COORDINATED_READER_DRAIN_INCOMPLETE');
    await this.publishStatus({ ...this.status(), checkedAt: new Date(this.now()).toISOString(),
      userStream: this.#stream?.status() ?? null, requestBudget: this.session.readBudgetStatus() });
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#stopped = true;
    this.#closing = (async () => {
      const results = await Promise.allSettled([this.#task, Promise.resolve().then(() => this.#stream?.close())]);
      invariant(results.every(r => r.status === 'fulfilled'), 'COORDINATED_READER_DRAIN_FAILED');
      this.#verifiedSnapshot = null; this.credentials = null; this.drainCompleted = true;
    })();
    this.#closing.catch(() => {}); return this.#closing;
  }
}

// An explicit alternative entry, not selected by existing service commands.
// All three producers must eventually use v2 together; old-budget startup fails.
export async function runCoordinatedReaderHost() {
  assertSharedAdmissionHost();
  invariant(process.argv.length === 3 && process.argv[2] === '--coordinated', 'COORDINATED_READER_ARGUMENTS');
  let session, resident, publishFinal;
  const lifecycle = createShadowHostLifecycle({ signals: process,
    resources: () => ({ budget: session, resident, publishFinal }), onTimeout: () => process.exit(2),
    onFailure: () => { process.exitCode = 2; } });
  try {
    await lifecycle.initialize(async ({ step, checkpoint }) => {
      const config = await step(() => loadConfig());
      assertCoordinatedReaderConfig(config, os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID);
      await step(async () => { session = await openProductionCoordinatedReadSession('ACCOUNT_READER'); });
      const root = config.runtime.root, pidPath = path.join(root, 'resident.pid.json'), latestPath = path.join(root, 'latest.json');
      await step(() => fs.mkdir(root, { recursive: true }));
      const old = await step(() => readJson(pidPath));
      invariant(!old?.pid || !processAlive(old.pid), 'PRODUCTION_READONLY_SINGLE_WRITER_ALREADY_RUNNING');
      const credentials = await step(() => loadProductionCredentials(config));
      session.start();
      resident = new CoordinatedReaderResident({ config, credentials, session, hostname: os.hostname(),
        hostIdentity: process.env.AEGIS_PRODUCTION_HOST_ID, publishStatus: value => writeJsonAtomic(latestPath, value) });
      let pidOwned = false;
      publishFinal = async () => {
        await resident.publishStopped();
        if (pidOwned) { invariant((await readJson(pidPath))?.pid === process.pid, 'COORDINATED_READER_PID_CHANGED'); await fs.unlink(pidPath); }
      };
      await step(async () => {
        await writeJsonAtomic(pidPath, { pid: process.pid, startedAt: new Date().toISOString(), mode: config.mode, readCoordinationVersion: 2 }); pidOwned = true;
      });
      checkpoint();
    });
    while (!lifecycle.status().started) { await resident.pulse(); await sleep(1000); }
    await lifecycle.close();
  } catch (error) { await lifecycle.close(); throw error; }
}
