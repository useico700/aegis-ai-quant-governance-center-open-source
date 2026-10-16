import { invariant, fresh } from './common.mjs';
import { CoordinatedReadSession } from './coordinated-read-session.mjs';

// Non-mutating, account-wide snapshot. Start time is deliberately conservative;
// a long REST fan-out must not become 'fresh' merely when its last call returns.
export async function readExecutionAccount(transport, userStream, now = Date.now) {
  const startedAt = now(), before = userStream.status();
  const [account, positions, mode, margin, orders, algoResult] = await (typeof transport.readAccountBatch === 'function' ? transport.readAccountBatch() : Promise.all([
    transport.request('GET', '/fapi/v2/account'), transport.request('GET', '/fapi/v2/positionRisk'),
    transport.request('GET', '/fapi/v1/positionSide/dual'), transport.request('GET', '/fapi/v1/multiAssetsMargin'),
    transport.request('GET', '/fapi/v1/openOrders'), transport.request('GET', '/fapi/v1/openAlgoOrders'),
  ]));
  const algos = Array.isArray(algoResult) ? algoResult : algoResult?.orders;
  invariant(Array.isArray(positions) && Array.isArray(orders) && Array.isArray(algos), 'ACCOUNT_RESPONSE_INCOMPLETE');
  invariant(fresh(startedAt, now(), 5000), 'ACCOUNT_READ_TOO_SLOW');
  const after = userStream.status(), stable = before.connected && after.connected && before.sequence === after.sequence;
  const leverage = {};
  for (const row of positions) {
    const value = Number(row.leverage);
    if (!Number.isInteger(value) || value < 1) continue;
    invariant(!leverage[row.symbol] || leverage[row.symbol] === value, 'POSITION_LEVERAGE_MISMATCH'); leverage[row.symbol] = value;
  }
  return { account: { observedAt: startedAt, equityUsdt: account.totalMarginBalance, availableBalanceUsdt: account.availableBalance,
    walletBalanceUsdt: account.totalWalletBalance, canTrade: account.canTrade === true,
    positions, orders, algos, positionsComplete: true, ordersComplete: true, algosComplete: true,
    dualSidePosition: mode.dualSidePosition === true, multiAssetsMargin: margin.multiAssetsMargin !== false,
    userStreamConnected: stable, userStreamSequence: after.sequence, userStreamChangedDuringRead: !stable,
    userStreamSequenceStable: Number.isSafeInteger(before.sequence) && before.sequence === after.sequence }, leverage };
}

export class AccountCache {
  constructor({ transport, userStream, now = Date.now, minimumRefreshMs = 2000, readSession = null, createAdmittedTransport = null }) {
    invariant(readSession === null ? createAdmittedTransport === null
      : readSession instanceof CoordinatedReadSession && typeof createAdmittedTransport === 'function', 'ACCOUNT_COORDINATED_PORTS');
    Object.assign(this, { transport, userStream, now, minimumRefreshMs }); this.latest = null; this.pending = null;
    this.readSession = readSession; this.createAdmittedTransport = createAdmittedTransport;
    this.queuedRead = null; this.lastReleaseAt = -1;
  }
  async read({ force = false } = {}) {
    if (this.readSession) {
      const lifecycle = this.readSession.status();
      invariant(lifecycle.started && !lifecycle.stopping, 'COORDINATED_SESSION_STOPPED');
    }
    const status = this.userStream.status(), cached = this.latest?.account;
    if (!force && cached && cached.userStreamConnected && status.connected && status.sequence === cached.userStreamSequence && fresh(cached.observedAt, this.now(), this.minimumRefreshMs)) return this.latest;
    if (this.pending) {
      if (!force) return this.pending;
      // A submission refresh may not reuse a request begun before the gate.
      // Wait for the existing reader to drain, then issue a new full snapshot.
      await this.pending;
      return this.read({ force: true });
    }
    this.pending = this.readSession ? this.#readCoordinated() : readExecutionAccount(this.transport, this.userStream, this.now);
    try {
      const latest = await this.pending;
      if (this.readSession) invariant(!this.readSession.status().stopping, 'COORDINATED_SESSION_STOPPED');
      this.latest = latest; return this.latest;
    }
    finally { this.pending = null; }
  }
  async #readCoordinated() {
    if (!this.queuedRead) {
      const at = this.now(), readyAt = Math.max(at, this.lastReleaseAt + 1);
      // Scheduling target only. Missing account data is unusable now; an old
      // snapshot keeps its original five-second expiry throughout queue waits.
      const deadlineAt = this.latest?.account.observedAt == null ? at : this.latest.account.observedAt + 5000;
      const handle = this.readSession.prepare('shadow:account', { readyAt, deadlineAt });
      this.lastReleaseAt = readyAt; this.queuedRead = { handle, readyAt, deadlineAt };
    }
    let result;
    try {
      result = await this.readSession.execute(this.queuedRead.handle, admission => {
        const transport = this.createAdmittedTransport(admission);
        invariant(typeof transport?.readAccountBatch === 'function', 'ACCOUNT_COORDINATED_BATCH_REQUIRED');
        // Observe stream sequence and snapshot start AFTER admission, before
        // the first HTTP call. Queue time is not a fresh account observation.
        return readExecutionAccount(transport, this.userStream, this.now);
      });
    } catch {
      this.queuedRead = null; throw new Error('ACCOUNT_COORDINATED_READ_FAILED');
    }
    if (result.status === 'WAIT') throw new Error('ACCOUNT_COORDINATED_READ_DEFERRED');
    this.queuedRead = null; return result.value;
  }
}
