import { invariant } from './common.mjs';

// Host lifecycle only. No host discovery, files, credentials, network or exit
// at import time. The owning process supplies its existing 35-second hard exit.
export function createShadowShutdown({ resources, onFailure, onTimeout,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, timeoutMs = 35000, settleStartup = null }) {
  invariant([resources, onFailure, onTimeout, setTimer, clearTimer, now].every(p => typeof p === 'function')
    && (settleStartup === null || typeof settleStartup === 'function')
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 35000, 'SHADOW_SHUTDOWN_PORTS');
  let task = null, failed = null, completed = false, phase = 'IDLE', timer;
  const status = () => Object.freeze({ started: task !== null, completed, phase, failure: failed });
  const close = () => {
    if (task) return task;
    let resolve, reject, owned, startedAt, deadlineAt;
    task = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A fire-and-forget signal caller cannot create an unhandled rejection;
    // callers awaiting this exact task still receive its failure.
    task.catch(() => {});
    const fail = code => {
      if (!failed) { failed = code; try { onFailure(code); } catch { /* Fixed local telemetry only. */ } }
      reject(new Error(failed));
    };
    const canRelease = () => { const at = now(); return !failed && Number.isSafeInteger(at) && at >= startedAt && at < deadlineAt; };
    const check = () => invariant(canRelease(), 'SHADOW_SHUTDOWN_ALREADY_FAILED');
    try {
      startedAt = now(); deadlineAt = startedAt + timeoutMs;
      invariant(Number.isSafeInteger(startedAt) && Number.isSafeInteger(deadlineAt), 'SHADOW_SHUTDOWN_CLOCK');
      timer = setTimer(() => {
        if (completed) return;
        fail('SHADOW_SHUTDOWN_TIMEOUT');
        try { onTimeout(); } catch { /* Cannot turn a failed drain into success. */ }
      }, timeoutMs);
      owned = resources();
      invariant(owned && typeof owned === 'object', 'SHADOW_SHUTDOWN_RESOURCES');
      // Fence synchronously, before another signal or the first await. A
      // failure here retains ownership; it must not proceed to resource close.
      phase = 'FENCING';
      owned.resident?.engine?.pauseEntries?.('SHADOW_HOST_SHUTDOWN');
      owned.budget?.stop();
    } catch { fail('SHADOW_SHUTDOWN_FENCE_FAILED'); return task; }
    void Promise.resolve().then(async () => {
      if (settleStartup) {
        check(); phase = 'DRAINING_STARTUP'; await settleStartup();
        // A resource open already in flight may have acquired ownership after
        // the initial fence. The startup checkpoint adopts it before rejecting.
        check(); owned = resources();
        invariant(owned && typeof owned === 'object', 'SHADOW_SHUTDOWN_RESOURCES');
        owned.resident?.engine?.pauseEntries?.('SHADOW_HOST_SHUTDOWN');
        owned.budget?.stop();
      }
      check(); phase = 'DRAINING';
      if (owned.resident) await owned.resident.close();
      else {
        const outcomes = await Promise.allSettled([owned.publicStreams, owned.accountStream]
          .map(stream => Promise.resolve().then(() => stream?.close())));
        invariant(outcomes.every(r => r.status === 'fulfilled'), 'SHADOW_STREAM_DRAIN_FAILED');
      }
      check(); phase = 'DRAINING_READ_PORTS'; await owned.readPorts?.close();
      check(); phase = 'CLOSING_RAW'; await owned.store?.close();
      check(); phase = 'PUBLISHING_FINAL';
      if (owned.resident && owned.publishFinal) await owned.publishFinal(owned.resident.status());
      // The journal flush must succeed before retiring the independent shared
      // budget owner. A failed close/timeout never releases that owner later.
      check(); phase = 'CLOSING_JOURNAL'; await owned.journal?.close();
      check(); phase = 'RELEASING_BUDGET'; await owned.budget?.close(Math.min(30000, deadlineAt - now()), { canRelease });
      check(); clearTimer(timer); completed = true; phase = 'COMPLETE'; resolve();
    }).catch(() => fail('SHADOW_SHUTDOWN_DRAIN_FAILED'));
    return task;
  };
  return Object.freeze({ close, status });
}

// Used by the real host before its first asynchronous resource acquisition.
// Each step must adopt newly opened resources inside its action, before it
// returns; this permits a late successful open to be included in shutdown.
export function createShadowHostLifecycle({ signals = null, ...ports }) {
  invariant(signals === null || (typeof signals.on === 'function' && typeof signals.removeListener === 'function'), 'SHADOW_STARTUP_SIGNALS');
  let startup = null, cleanupAttached = false;
  const shutdown = createShadowShutdown({ ...ports, settleStartup: () => startup?.catch(() => {}) });
  const checkpoint = () => invariant(!shutdown.status().started, 'SHADOW_STARTUP_CANCELED');
  const step = async action => {
    checkpoint(); invariant(typeof action === 'function', 'SHADOW_STARTUP_STEP');
    const result = await action(); checkpoint(); return result;
  };
  const onSignal = () => { void close().catch(() => {}); };
  const close = () => {
    const task = shutdown.close();
    if (!cleanupAttached) {
      cleanupAttached = true;
      task.then(() => {
        for (const name of ['SIGTERM', 'SIGINT']) signals?.removeListener(name, onSignal);
      }, () => {}).catch(() => {});
    }
    return task;
  };
  const initialize = action => {
    checkpoint(); invariant(startup === null && typeof action === 'function', 'SHADOW_STARTUP_ALREADY_STARTED');
    // Not once(): a second signal must join the drain, not restore the default
    // process termination while the journal still has pending writes.
    for (const name of ['SIGTERM', 'SIGINT']) signals?.on(name, onSignal);
    startup = Promise.resolve().then(() => { checkpoint(); return action({ step, checkpoint }); });
    startup.catch(() => {});
    return startup;
  };
  return Object.freeze({ initialize, close, status: shutdown.status });
}
