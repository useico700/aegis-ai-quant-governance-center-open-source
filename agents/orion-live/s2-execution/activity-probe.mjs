import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertProbeHost } from './readonly-ports.mjs';
import { loadProductionCredentials } from '../binance-prod2/credentials.mjs';
import { SignedTransport } from './transport.mjs';
import { ReadRequestBudget, readRequestWeight } from './request-budget.mjs';
import { boundedResponseJson } from './bounded-http.mjs';
import { readAccountActivity, reviewAccountActivity } from './account-activity.mjs';
import { UNIVERSE, invariant } from './common.mjs';

export async function auditRecentActivity(transport, { now = Date.now, progress = () => {} } = {}) {
  const endTime = now() - 60000, startTime = endTime - 3600000, symbols = [];
  // One minute settlement allowance is not a finality or completeness guarantee.
  // No strategy ledger is mounted, so historical ownership remains unattributed.
  for (const symbol of UNIVERSE) {
    const snapshot = await readAccountActivity(transport, { symbol, startTime, endTime, now, maximumRequests: 9, maximumRows: 2000 });
    const review = reviewAccountActivity(snapshot, { kernel: { plans: new Map(), intents: new Map() }, book: { fills: new Map() } });
    const item = { symbol, trades: snapshot.trades.length, liquidations: snapshot.forced.filter(f => f.cause === 'LIQUIDATION').length,
      adl: snapshot.forced.filter(f => f.cause === 'ADL').length, reviewIssues: review.issues.length, requests: snapshot.requests };
    symbols.push(item); progress(item);
  }
  return { status: 'RECENT_ACTIVITY_WINDOWS_FETCHED_NOT_RECOVERY_APPROVED', checkedAt: new Date(now()).toISOString(), startTime, endTime,
    symbols, recoveryApproved: false, realOrdersAllowed: false, liveReady: false, newEntriesBlocked: true,
    financialLedgerModified: false, strategyOwnershipEvaluated: false, coverage: 'BOUNDED_REST_WINDOW_NOT_ATOMIC_OR_FINAL' };
}

export async function runActivityProbe() {
  assertProbeHost(os.hostname(), process.env.AEGIS_PRODUCTION_HOST_ID, process.getuid());
  invariant(process.argv.length === 2, 'ACTIVITY_PROBE_ARGUMENTS_FORBIDDEN');
  const deadline = Date.now() + 120000;
  const budget = new ReadRequestBudget({ maximumWeight: 600, ipCeiling: 1600, maximumConcurrent: 1 });
  const timeout = setTimeout(() => { process.stdout.write('{"status":"ACTIVITY_PROBE_TIMEOUT","realOrdersAllowed":false}\n'); process.exit(2); }, 125000);
  try {
    await budget.run(1, async () => {
      const response = await fetch('https://demo-fapi.binance.com/fapi/v1/time', { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
      budget.observe({ status: response.status, usedWeight: response.headers.get('x-mbx-used-weight-1m'), retryAfter: response.headers.get('retry-after'), serverDate: response.headers.get('date') });
      invariant(response.ok, 'ACTIVITY_PROBE_CLOCK_HTTP_FAILED');
      const clock = await boundedResponseJson(response);
      invariant(Number.isSafeInteger(clock.serverTime) && Math.abs(clock.serverTime - Date.now()) <= 1000, 'ACTIVITY_PROBE_CLOCK_SKEW');
    });
    const credentials = await loadProductionCredentials({ credentials: { apiKeyFile: '/etc/aegis/secrets/binance-prod2/BN-KEY-PROD2', secretKeyFile: '/etc/aegis/secrets/binance-prod2/BN-SECRET-PROD2', requiredOwnerUid: 0, requiredMode: '0440' } });
    const signed = new SignedTransport({ credentials, observeResponse: event => budget.observe(event) });
    const transport = { request: (method, pathname, params) => {
      invariant(method === 'GET' && ['/fapi/v1/userTrades', '/fapi/v1/forceOrders'].includes(pathname), 'ACTIVITY_PROBE_GET_HISTORY_ONLY');
      invariant(Date.now() < deadline && budget.state.requests < 60, 'ACTIVITY_PROBE_REQUEST_OR_TIME_LIMIT');
      return budget.run(readRequestWeight(method, pathname, params), () => signed.request(method, pathname, params));
    } };
    const result = await auditRecentActivity(transport, { progress: item => process.stdout.write(JSON.stringify({ status: 'ACTIVITY_SYMBOL_FETCHED', ...item, realOrdersAllowed: false }) + '\n') });
    return { ...result, budget: budget.status(), oneShotBudgetNotSharedOrRestartPersistent: true };
  } finally { clearTimeout(timeout); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runActivityProbe()) + '\n'); }
  catch (error) {
    process.stdout.write(JSON.stringify({ status: 'ACTIVITY_PROBE_FAILED', reason: /^[A-Z0-9_]{1,96}$/.test(error.message) ? error.message : 'ACTIVITY_PROBE_UNEXPECTED_ERROR', exchangeCode: Number.isInteger(error.exchangeCode) ? error.exchangeCode : null, realOrdersAllowed: false }) + '\n');
    process.exitCode = 1;
  }
}
