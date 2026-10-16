import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpsStore, advanceOps, evaluateOps, readOpsInput, validateOpsState } from './ops-monitor.mjs';

const ROOT = '/var/lib/aegis/s1-ops', SHADOW = '/var/lib/aegis/s1-shadow';
async function inputs() {
  const safe = async file => { try { return await readOpsInput(file); } catch { return null; } };
  const [reader, scanner, shadow] = await Promise.all([
    safe('/var/lib/aegis/binance-prod2/latest.json'), safe('/var/lib/aegis/s2-scanner/latest.json'), safe(path.join(SHADOW, 'latest.json')),
  ]);
  let disk = null, auditBytes = null;
  try { const s = await fs.statfs(ROOT); disk = { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize }; } catch { /* Classifier reports missing measurement. */ }
  try {
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        const s = await fs.lstat(path.join(SHADOW, 'audit', 'execution.sqlite' + suffix));
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('OPS_AUDIT_BOUNDARY'); bytes += s.size;
      } catch (error) { if (!suffix || error.code !== 'ENOENT') throw error; }
    }
    auditBytes = bytes;
  } catch { /* Unknown is not zero usage. */ }
  return { reader, scanner, shadow, disk, auditBytes };
}
export async function runOpsHost() {
  if (os.hostname() !== 'aegis-demo-host' || process.getuid() !== 993 || process.env.AEGIS_PRODUCTION_HOST_ID !== 'demo-server') throw new Error('OPS_QUANT_SERVER_REQUIRED');
  if (Object.keys(process.env).some(k => /BN.*(KEY|SECRET).*PROD|BINANCE.*(KEY|SECRET)|NODE_OPTIONS/i.test(k))) throw new Error('OPS_CREDENTIAL_ENV_FORBIDDEN');
  if (process.argv.length === 3 && ['--health', '--status'].includes(process.argv[2])) {
    const state = validateOpsState(await readOpsInput(path.join(ROOT, 'latest.json'), 65536)), age = Date.now() - state.checkedAt;
    const alive = !state.stopped && age >= -5000 && age <= 45000;
    if (process.argv[2] === '--status') process.stdout.write(JSON.stringify({ monitorAlive: alive, checkedAt: state.checkedAt,
      activeAlerts: Object.entries(state.alerts).filter(([, a]) => a.active).map(([code, a]) => ({ code, since: a.transitionAt })),
      externalDeliveryVerified: false, liveReady: false, tradingStateChanged: false }) + '\n');
    if (!alive) throw new Error('OPS_MONITOR_STALE'); return;
  }
  if (process.argv.length !== 2) throw new Error('OPS_ARGUMENTS_INVALID');
  const store = await new OpsStore(ROOT).open(), abort = new AbortController(); let stopped = false;
  const stop = () => { stopped = true; abort.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopped) {
      const input = await inputs(), now = Date.now(), next = advanceOps(store.state, evaluateOps(input, now), now);
      await store.save(next.state);
      // Commit before emitting. This stdout is not an external delivery receipt.
      for (const event of next.transitions) process.stdout.write(JSON.stringify({ ...event, externalDeliveryVerified: false }) + '\n');
      await delay(10000, undefined, { signal: abort.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
    await store.save({ ...store.state, stopped: true });
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); store.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await runOpsHost(); }
  catch { process.stderr.write('S2_OPS_MONITOR_FAILED_REVIEW_REQUIRED\n'); process.exitCode = 1; }
}
