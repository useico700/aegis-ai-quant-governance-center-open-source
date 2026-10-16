import { CoordinatedReadSession } from '../s2-execution/coordinated-read-session.mjs';
import { invariant } from '../s2-execution/common.mjs';
import { publicServerTime, readProductionAccount } from './mainnet-readonly-client.mjs';

// Explicit preflight port, not a production factory. The host still owns its
// 60-second cadence, credentials, stream maintenance and session shutdown.
export class CoordinatedProductionReader {
  #session; #now; #queued = null; #pending = null; #lastRelease = -1; #observedAt = null; #configKey = null; #initialTargetAt;
  constructor(session, { now = Date.now } = {}) {
    invariant(session instanceof CoordinatedReadSession && typeof now === 'function', 'PRODUCTION_READER_COORDINATION_PORTS');
    this.#session = session; this.#now = now;
    this.#initialTargetAt = now();
    invariant(Number.isSafeInteger(this.#initialTargetAt) && this.#initialTargetAt >= 0, 'PRODUCTION_READER_START_TIME_INVALID');
  }
  assertRunning() {
    const s = this.#session.status();
    invariant(s.started && !s.stopping, 'COORDINATED_SESSION_STOPPED');
  }
  read(config, credentials, { fetchImpl = globalThis.fetch } = {}) {
    this.assertRunning();
    invariant(config.runtime.cycleIntervalMs === 60000 && config.runtime.accountStaleAfterMs === 120000,
      'PRODUCTION_READER_CADENCE_MISMATCH');
    const key = JSON.stringify([config.venue, config.runtime]);
    invariant(this.#configKey === null || this.#configKey === key, 'PRODUCTION_READER_CONFIG_CHANGED'); this.#configKey = key;
    if (this.#pending) return this.#pending;
    const task = Promise.resolve().then(() => this.#read(config, credentials, fetchImpl));
    this.#pending = task;
    task.finally(() => { this.#pending = null; }).catch(() => {});
    return task;
  }
  async #read(config, credentials, fetchImpl) {
    this.assertRunning();
    if (!this.#queued) {
      const at = this.#now(), readyAt = Math.max(at, this.#lastRelease + 1);
      // Missing startup evidence was already due when this reader was created.
      // Stream bootstrap or a failed attempt must not make that need younger.
      // This is queue urgency only; account.observedAt still comes from HTTP.
      const deadlineAt = this.#observedAt === null ? this.#initialTargetAt : this.#observedAt + config.runtime.accountStaleAfterMs;
      const handle = this.#session.prepare('reader:account', { readyAt, deadlineAt });
      this.#lastRelease = readyAt; this.#queued = { handle };
    }
    let result;
    try {
      result = await this.#session.execute(this.#queued.handle, async admission => {
        // Two existing public-time GETs plus the five signed account GETs.
        // No request/signing happens while the original queue handle waits.
        const options = { admission, fetchImpl, now: this.#now };
        const server = await publicServerTime(config, options);
        const account = await readProductionAccount(config, credentials, options);
        return { serverTime: Number(server.serverTime), account };
      });
    } catch { this.#queued = null; throw new Error('PRODUCTION_COORDINATED_READ_FAILED'); }
    if (result.status === 'WAIT') return result;
    this.#queued = null; this.assertRunning();
    this.#observedAt = Date.parse(result.value.account.observedAt);
    invariant(Number.isSafeInteger(this.#observedAt), 'PRODUCTION_ACCOUNT_TIME_INVALID');
    return result;
  }
}
