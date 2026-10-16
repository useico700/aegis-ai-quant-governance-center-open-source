// Run inside the scanner container via stdin. Secrets stay in its environment.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const local = JSON.parse(await fs.readFile('/var/lib/aegis/s1-scanner/latest.json', 'utf8'));
const account = JSON.parse(await fs.readFile('/var/lib/aegis/binance-prod/latest.json', 'utf8'));
const state = JSON.parse(await fs.readFile('/var/lib/aegis/s1-scanner/state.json', 'utf8'));
const headers = { 'oai-sites-authorization': `Bearer ${process.env.S1_MONITOR_BYPASS_TOKEN}` };
const response = await fetch(process.env.S1_MONITOR_URL, { headers, signal: AbortSignal.timeout(15000) });
const remote = await response.json();
const snapshot = remote.snapshot;
assert.equal(response.status, 200);
assert.equal(remote.status, 'OK');
assert.equal(local.status, 'HEALTHY');
assert.equal(snapshot.status, 'HEALTHY');
assert.ok(snapshot.sequence >= local.sequence);
assert.equal(snapshot.scannedSymbols, 10);
assert.equal(snapshot.account.fresh, true);
assert.equal(snapshot.account.userStreamConnected, true);
assert.ok(Date.now() - Date.parse(snapshot.account.observedAt) < 120000);
assert.equal(account.status, 'READY_READ_ONLY_SHADOW');
assert.equal(snapshot.account.equity, Number(account.account.marginBalanceUsdt));
assert.equal(snapshot.account.wallet, Number(account.account.walletBalanceUsdt));
assert.equal(snapshot.account.available, Number(account.account.availableBalanceUsdt));
for (const key of ['positionsComplete', 'ordersComplete', 'algoOrdersComplete']) assert.equal(snapshot.account.details[key], true);
assert.equal(snapshot.realOrdersAllowed, false);
assert.equal(snapshot.newEntriesBlocked, true);
assert.equal(state.continuity?.freshScanPending, false);
assert.equal(remote.history.firstObservedAt, '2026-09-10T09:30:16.747Z');
assert.ok(remote.history.points.some(point => point.observedAt === snapshot.account.observedAt));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: 'S1_ACCOUNT_SCANNER_WEB_HISTORY_MATCH',
  sourceAsOf: snapshot.sourceAsOf, sequence: snapshot.sequence, bootId: snapshot.bootId,
  scannedSymbols: snapshot.scannedSymbols, candidates: snapshot.candidates.length, publish: snapshot.publish,
  account: { observedAt: snapshot.account.observedAt, equity: snapshot.account.equity, wallet: snapshot.account.wallet,
    available: snapshot.account.available, positions: snapshot.account.positions, orders: snapshot.account.orders,
    algoOrders: snapshot.account.algoOrders, positionMode: snapshot.account.positionMode, userStreamConnected: true },
  historyPoints: remote.history.points.length, firstObservedAt: remote.history.firstObservedAt,
  lastObservedAt: remote.history.points.at(-1)?.observedAt, continuity: state.continuity,
  precisionRules: snapshot.precision?.rules?.length, marketQuotes: snapshot.marketQuotes?.length,
  eventGate: snapshot.eventGate?.status, realOrdersAllowed: false }));
