import { createHash } from 'node:crypto';

// Prospective entry guard only. Never rewrite the original signal or change an
// open position. The caller retains Px, account, risk and execution authority.
export const ENTRY_CONFIRMATION_REVISION = 'S1-S2-ENTRY-RECONFIRM-ROOM-1';
const HOUR = 3_600_000;
const QUOTE_MAX_AGE_MS = 2_000;
const numeric = value => {
  if (typeof value !== 'number' && (typeof value !== 'string'
    || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const clock = value => {
  const n = numeric(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function entryConfirmationPolicy(account) {
  const normalized = typeof account === 'string' ? account.toUpperCase() : null;
  if (!['S1', 'S2'].includes(normalized)) throw new Error('ENTRY_CONFIRMATION_ACCOUNT_INVALID');
  return Object.freeze({ revision: ENTRY_CONFIRMATION_REVISION, account: normalized,
    entryIntervalMs: normalized === 'S1' ? 900_000 : 300_000,
    staleAfterMs: normalized === 'S1' ? HOUR : 900_000, roomLookbackHours: 6 });
}

function latestClosedBars(input, interval, count, now) {
  if (!Array.isArray(input) || input.length < count) return null;
  const rows = [];
  for (const raw of input) {
    const bar = Object.fromEntries(['openTime', 'closeTime', 'open', 'high', 'low', 'close']
      .map(key => [key, numeric(raw?.[key])]));
    if (!Number.isSafeInteger(bar.openTime) || bar.openTime < 0
      || !Number.isSafeInteger(bar.closeTime) || bar.openTime % interval !== 0
      || bar.closeTime !== bar.openTime + interval - 1 || bar.closeTime >= now
      || [bar.open, bar.high, bar.low, bar.close].some(x => x === null || x <= 0)
      || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)
      || bar.high < bar.low || (rows.length && bar.openTime <= rows.at(-1).openTime)) return null;
    rows.push(bar);
  }
  const tail = rows.slice(-count);
  const latestOpen = Math.floor(now / interval) * interval - interval;
  if (tail.at(-1).openTime !== latestOpen
    || tail.some((bar, index) => index && bar.openTime !== tail[index - 1].openTime + interval)) return null;
  return tail;
}

export function evaluateEntryConfirmation(input = {}) {
  let proof = null;
  const metrics = {};
  const result = (status, reason, firstHarvestTarget = null) => ({ status,
    allowed: status === 'PASS', reason, terminal: false,
    revision: ENTRY_CONFIRMATION_REVISION, proof, metrics, firstHarvestTarget });
  const wait = reason => result('WAIT', reason);
  try {
    const p = input.policy;
    if (!p || !['S1', 'S2'].includes(p.account)) return wait('ENTRY_CONFIRMATION_POLICY_INVALID');
    const expected = entryConfirmationPolicy(p.account);
    if (p.revision !== expected.revision || ['entryIntervalMs', 'staleAfterMs', 'roomLookbackHours']
      .some(key => numeric(p[key]) !== expected[key])) return wait('ENTRY_CONFIRMATION_POLICY_INVALID');

    const now = clock(input.now), signalClosedAt = clock(input.signalClosedAt);
    const direction = numeric(input.direction);
    if (!now || !signalClosedAt || signalClosedAt > now || ![1, -1].includes(direction))
      return wait('ENTRY_CONFIRMATION_CLOCK_OR_SIGNAL_INVALID');
    const entry = numeric(input.entryPrice), modeledEntry = numeric(input.modeledEntry);
    const stop = numeric(input.stopPrice), risk = numeric(input.initialRiskPerUnit);
    const fee = numeric(input.takerFeeRate), slip = numeric(input.adverseSlippageRate);
    const tick = numeric(input.tickSize);
    if ([entry, modeledEntry, stop, risk, tick].some(x => x === null || x <= 0)
      || fee === null || slip === null || fee < 0 || fee >= 1 || slip < 0 || slip >= 1
      || direction * (entry - stop) <= 0 || direction * (modeledEntry - entry) < 0)
      return wait('ENTRY_CONFIRMATION_COST_OR_PRICE_INVALID');

    const entries = latestClosedBars(input.entryBars, expected.entryIntervalMs, 2, now);
    if (!entries) return wait('ENTRY_CONFIRMATION_ENTRY_BARS_WAIT');
    const hours = latestClosedBars(input.bars1h, HOUR, expected.roomLookbackHours, now);
    if (!hours) return wait('ENTRY_CONFIRMATION_ROOM_BARS_WAIT');
    const [previous, latest] = entries;
    const quote = input.quote;
    const bid = numeric(quote?.bid), ask = numeric(quote?.ask);
    const marketTime = clock(quote?.marketTime), receivedAt = clock(quote?.receivedAt);
    if (bid === null || ask === null || bid <= 0 || ask < bid || !marketTime || !receivedAt
      || marketTime > now || receivedAt > now || now - marketTime > QUOTE_MAX_AGE_MS
      || now - receivedAt > QUOTE_MAX_AGE_MS || marketTime < latest.closeTime
      || receivedAt < latest.closeTime) return wait('ENTRY_CONFIRMATION_QUOTE_WAIT');

    let loss = null;
    // An explicit null means the caller completed its account/symbol/direction
    // ledger review and found no applicable loss. Missing context is unknown.
    if (input.lastLossExit !== null) {
      const l = input.lastLossExit;
      const closedAt = clock(l?.closedAt);
      if (l?.evidenceComplete !== true || !closedAt || closedAt > now
        || typeof l.planId !== 'string' || !l.planId.length
        || typeof l.reason !== 'string' || !l.reason.length)
        return wait('ENTRY_CONFIRMATION_LOSS_EVIDENCE_WAIT');
      loss = { closedAt, planId: l.planId, reason: l.reason };
    }
    const q = direction === 1 ? ask : bid;
    const age = now - signalClosedAt;
    const reconfirm = age > expected.staleAfterMs || loss !== null;
    Object.assign(metrics, { account: expected.account, signalClosedAt, signalAgeMs: age,
      staleAfterMs: expected.staleAfterMs, reconfirmationRequired: reconfirm,
      latestEntryBarOpenTime: latest.openTime, latestEntryBarCloseTime: latest.closeTime,
      lastLossExit: loss, quotePrice: q });
    if (loss && latest.openTime < loss.closedAt) return wait('ENTRY_CONFIRMATION_POST_LOSS_BAR_WAIT');
    if (reconfirm) {
      const level = direction === 1 ? previous.high : previous.low;
      Object.assign(metrics, { breakLevel: level, directionalBody: direction * (latest.close - latest.open) > 0,
        closedBeyondPreviousExtreme: direction * (latest.close - level) > 0,
        quoteHoldsBreakLevel: direction * (q - level) > 0 });
      if (!metrics.directionalBody || !metrics.closedBeyondPreviousExtreme)
        return wait('ENTRY_CONFIRMATION_FRESH_BREAK_WAIT');
      if (!metrics.quoteHoldsBreakLevel) return wait('ENTRY_CONFIRMATION_BREAK_LEVEL_LOST_WAIT');
      proof = { kind: 'LATEST_ENTRY_BAR_RECONFIRMATION', direction,
        barOpenTime: latest.openTime, barCloseTime: latest.closeTime,
        previousBarOpenTime: previous.openTime, previousBarCloseTime: previous.closeTime,
        breakLevel: level, close: latest.close, entryBarsHash: digest(entries),
        lastLossExit: loss, quoteMarketTime: marketTime, quoteReceivedAt: receivedAt };
    }

    const reference = direction === 1 ? Math.max(...hours.map(x => x.high)) : Math.min(...hours.map(x => x.low));
    const ahead = direction * (reference - q);
    Object.assign(metrics, { referencePrice: reference,
      referenceWindowStart: hours[0].openTime, referenceWindowEnd: hours.at(-1).closeTime,
      referenceBarsHash: digest(hours), referenceState: ahead > 0 ? 'AHEAD' : ahead < 0 ? 'BEYOND_REFERENCE' : 'AT_REFERENCE' });
    // A crossed reference is not infinite space or proof that no obstacle exists.
    // The ordinary frozen 0.5R stage remains the caller's management policy.
    if (ahead < 0) return result('PASS', 'ENTRY_CONFIRMATION_REFERENCE_PASSED');
    const target = reference - direction * tick;
    const exit = target * (1 - direction * slip);
    const net = direction * (exit - modeledEntry) - modeledEntry * fee - exit * fee;
    const estimatedTargetNetR = net / risk;
    Object.assign(metrics, { targetPrice: target, estimatedTargetNetR });
    if (![target, exit, net, estimatedTargetNetR].every(Number.isFinite)
      || target <= 0 || exit <= 0 || net <= 0) return wait('ENTRY_CONFIRMATION_WAIT_ROOM_OR_BREAKOUT');
    const firstHarvestTarget = { revision: ENTRY_CONFIRMATION_REVISION, account: expected.account,
      direction, source: 'CLOSED_1H_EXTREME_INSIDE_ONE_TICK', referencePrice: reference,
      targetPrice: target, referenceWindowStart: hours[0].openTime,
      referenceWindowEnd: hours.at(-1).closeTime, referenceBarsHash: metrics.referenceBarsHash,
      firstStageCapR: 0.5, estimatedTargetNetR };
    return result('PASS', reconfirm ? 'ENTRY_CONFIRMATION_RECONFIRMED' : 'ENTRY_CONFIRMATION_CURRENT_SIGNAL', firstHarvestTarget);
  } catch {
    // Malformed evidence must remain a candidate-local wait, never a liveness or
    // global incident exception that could suppress protection of existing risk.
    return wait('ENTRY_CONFIRMATION_EVIDENCE_INVALID');
  }
}
