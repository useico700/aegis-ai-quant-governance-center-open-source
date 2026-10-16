import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, writeJsonAtomic, sleep } from '../binance-prod/runtime-utils.mjs';
import { assertSharedAdmissionHost } from '../s1-execution/host-admission.mjs';
import { openProductionCoordinatedReadSession } from '../s1-execution/coordinated-host-admission.mjs';
import { createShadowHostLifecycle } from '../s1-execution/shadow-shutdown.mjs';
import { invariant } from '../s1-execution/common.mjs';
import { archiveCandidateRetirements } from './candidate-lifecycle.mjs';
import { CoordinatedScannerResident, assertCoordinatedScannerConfig } from './coordinated-resident.mjs';

const ORIGIN = 'https://your-cockpit.example.invalid';
// No exchange credentials. Optional existing calendar/monitor destinations only.
export function scannerMonitorPorts(env = process.env, fetcher = fetch) {
  const bypass = env.S1_MONITOR_BYPASS_TOKEN, ingest = env.S1_MONITOR_INGEST_TOKEN;
  const target = env.S1_MONITOR_URL;
  if (target && ingest) {
    const url = new URL(target);
    invariant(url.origin === ORIGIN && url.pathname === '/api/s1-monitor' && !url.username && !url.password
      && !url.search && !url.hash, 'MONITOR_DESTINATION_DENIED');
  }
  const headers = bypass ? { 'oai-sites-authorization': `Bearer ${bypass}` } : {};
  return {
    readCalendar: async signal => {
      if (!bypass || signal.aborted) return null;
      const response = await fetcher(`${ORIGIN}/api/s1-risk-calendar`, { headers, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      return response.ok ? response.json() : null;
    },
    publishMonitor: target && ingest ? async (snapshot, signal) => {
      invariant(!signal.aborted, 'SCANNER_MONITOR_STOPPED');
      const response = await fetcher(target, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${ingest}` },
        body: JSON.stringify(snapshot), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      invariant(response.ok, 'SCANNER_MONITOR_HTTP_FAILED');
      invariant(['SYNCED', 'OLDER_SNAPSHOT_IGNORED'].includes((await response.json())?.status), 'SCANNER_MONITOR_RECEIPT_INVALID');
    } : null,
  };
}

// Explicit alternative only. Existing service/supervisor commands stay on v1.
// This requires the existing external worker.lock and a migrated shared store;
// the owner lock prevents duplicate coordinated writers. No automatic migration.
export async function runCoordinatedScannerHost() {
  assertSharedAdmissionHost();
  invariant(process.argv.length === 3 && process.argv[2] === '--coordinated', 'COORDINATED_SCANNER_ARGUMENTS');
  let session, resident, watchdog, lastCompleted = Date.now();
  const notify = async (...args) => {
    if (process.env.NOTIFY_SOCKET) await promisify(execFile)('/usr/bin/systemd-notify', args, { timeout: 1000 }).catch(() => {});
  };
  const lifecycle = createShadowHostLifecycle({ signals: process, timeoutMs: 24000,
    resources: () => ({ budget: session, resident, publishFinal: async () => { await resident.publishStopped(); await notify('--stopping'); } }),
    onFailure: () => { process.exitCode = 2; }, onTimeout: () => process.exit(2) });
  try {
    await lifecycle.initialize(async ({ step, checkpoint }) => {
      const config = await step(() => readJson(new URL('./config.json', import.meta.url)));
      assertCoordinatedScannerConfig(config, os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID);
      const ports = scannerMonitorPorts();
      await step(async () => { session = await openProductionCoordinatedReadSession('CANDIDATE_SCANNER'); });
      await step(() => fs.mkdir(config.runtimeRoot, { recursive: true, mode: 0o700 }));
      const state = await step(() => readJson(path.join(config.runtimeRoot, 'state.json'), { schemaVersion: 1, sequence: 0, plans: {} }));
      session.start();
      resident = new CoordinatedScannerResident({ config, state, session, hostname: os.hostname(), hostIdentity: process.env.AEGIS_PRODUCTION_HOST_ID,
        archiveRetirements: records => archiveCandidateRetirements(config.runtimeRoot, records),
        persistState: value => writeJsonAtomic(path.join(config.runtimeRoot, 'state.json'), value),
        persistSnapshot: value => writeJsonAtomic(path.join(config.runtimeRoot, 'latest.json'), value),
        readAccount: () => readJson(config.accountSnapshot), ...ports });
      await step(() => resident.prepareRecovery());
      await step(() => notify('--ready', '--status=S1 coordinated candidate scanner starting; execution blocked'));
      checkpoint();
      watchdog = setInterval(() => {
        if (process.connected) process.send({ type: 'S1_PROGRESS', completedAt: lastCompleted });
        if (Date.now() - lastCompleted < 150000) void notify('WATCHDOG=1');
      }, 20000);
    });
    while (!lifecycle.status().started) {
      await resident.pulse();
      // pulse waits for an actual scan, but returns promptly during intentional
      // backoff. A hung scan cannot keep advancing the watchdog progress time.
      lastCompleted = Date.now();
      await sleep(1000);
    }
    await lifecycle.close();
  } catch (error) { await lifecycle.close(); throw error; }
  finally { clearInterval(watchdog); }
}
