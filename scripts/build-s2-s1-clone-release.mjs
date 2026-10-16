import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUTH = 'governance/owner-authorizations/2026-10-13-s2-s1-clone.json';
// Strategy protocol identifiers remain unchanged. Only account ownership,
// production paths, credentials and client-order namespace are remapped.
export function cloneSource(text) {
  return text.replaceAll('s1-execution', 's2-execution').replaceAll('s1-scanner', 's2-scanner')
    .replaceAll('/var/lib/aegis/s2-execution', '/var/lib/aegis/s2-r22-execution')
    .replaceAll('/var/lib/aegis/s2-scanner', '/var/lib/aegis/s2-r22-scanner')
    .replaceAll('/var/lib/aegis/s1-read-admission', '/var/lib/aegis/s2-read-admission')
    .replaceAll("'S1'", "'S2'").replaceAll('"S1"', '"S2"')
    .replaceAll('s1_', 's2_')
    .replaceAll('../binance-prod/', '../binance-prod2/')
    .replaceAll('/var/lib/aegis/binance-prod/', '/var/lib/aegis/binance-prod2/')
    .replaceAll('/var/lib/aegis/binance-prod2/evidence/raw', '/var/lib/aegis/s2-r22-evidence/raw')
    .replaceAll("'/opt/aegis/account-reader/agents/orion-live/binance-prod/config.json'", "new URL('../binance-prod2/config.json', import.meta.url)")
    .replaceAll('R22 · S1 live risk', 'R22 · S2 live risk')
    .replaceAll('CURRENT_RECONCILED_S1_', 'CURRENT_RECONCILED_S2_')
    .replaceAll('S1_EXECUTION_AUTHORIZATION_V1', 'S2_EXECUTION_AUTHORIZATION_V1')
    .replaceAll('S1_MONITOR_URL', 'S2_MONITOR_URL').replaceAll('S1_MONITOR_INGEST_TOKEN', 'S2_MONITOR_INGEST_TOKEN')
    .replaceAll('/api/s1-monitor', '/api/s2-monitor');
}
export async function buildClone(output) {
  await fs.mkdir(output, { recursive: true });
  const manifest = [];
  async function copy(relative, transform = false) {
    const stat = await fs.lstat(path.join(root, relative));
    if (stat.isDirectory()) { for (const name of (await fs.readdir(path.join(root, relative))).sort()) await copy(`${relative}/${name}`, transform); return; }
    if (!stat.isFile() || !/\.(mjs|json)$/.test(relative)) return;
    const original = await fs.readFile(path.join(root, relative), 'utf8');
    const target = transform ? relative.replace('s1-execution/', 's2-execution/').replace('s1-scanner/', 's2-scanner/') : relative;
    let content = transform ? cloneSource(original) : original;
    if (target === 'agents/orion-live/s2-scanner/config.json') {
      const config = JSON.parse(content); config.runtimeId = 'S2-S1-R22-CLONE-20261013';
      config.accountSnapshot = '/var/lib/aegis/s2-r22-monitor/account.json';
      content = JSON.stringify(config, null, 2) + '\n';
    }
    if (target === 'agents/orion-live/s2-execution/small-trial-limits.json') {
      const config = JSON.parse(content); config.riskAuthorization = AUTH;
      content = JSON.stringify(config, null, 2) + '\n';
    }
    await fs.mkdir(path.dirname(path.join(output, target)), { recursive: true });
    await fs.writeFile(path.join(output, target), content);
    const digest = x => crypto.createHash('sha256').update(x).digest('hex');
    manifest.push({ source: relative, target, sourceSha256: digest(original), sha256: digest(content) });
  }
  for (const dir of ['agents/orion-live/s1-execution', 'agents/orion-live/s1-scanner']) await copy(dir, true);
  for (const dir of ['agents/orion-live/binance-prod2', 'agents/orion-v2/paper', 'agents/shared', 'lib']) await copy(dir);
  // Reuse the already-established S2 budget store and its migration protocol.
  for (const name of ['host-admission', 'shared-read-budget', 'bootstrap-receipt']) await copy(`agents/orion-live/s2-execution/${name}.mjs`);
  await copy('scripts/v2-mtf-trendline-intersection.mjs');
  await copy('ops/demo-server/s2-r22-monitor.mjs');
  await copy('ops/demo-server/s2-r22-preflight.mjs');
  await copy(AUTH);
  await fs.writeFile(path.join(output, 'package.json'), '{"type":"module"}\n');
  const finalFiles = [...new Map(manifest.map(row => [row.target, row])).values()];
  await fs.writeFile(path.join(output, 'clone-manifest.json'), JSON.stringify({ revision: 'S2-S1-R22-CLONE-20261013', authorization: AUTH, files: finalFiles }, null, 2));
  return finalFiles;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('ABSOLUTE_EMPTY_OUTPUT_REQUIRED');
  console.log(JSON.stringify({ files: (await buildClone(process.argv[2])).length }));
}
