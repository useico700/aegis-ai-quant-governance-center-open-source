import { createHash } from 'node:crypto';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const REVISION = 'JEV-S1-S2-OBSERVE-1';
export const QUESTIONS = Object.freeze({
  phase: { type: 'choice', instructions: 'Classify the CURRENT market phase from the supplied closed OHLCV bars and trendline intersection context. Use only supplied evidence; do not predict profitability. If evidence cannot distinguish phases, select insufficient.', criteria: {
    convergence: 'Recent price range and swings are contracting before a directional expansion.',
    early_expansion: 'A contraction has recently ended and directional range expansion is beginning.',
    sustained_expansion: 'Directional range expansion has continued beyond its initial impulse.',
    range: 'Alternating movements lack a sustained direction or clear contraction-expansion sequence.',
    insufficient: 'Evidence is insufficient or contradictory.' } },
  retracement: { type: 'choice', instructions: 'Relative to candidate.direction, classify the recent pullback using supplied closed bars. Do not infer entry permission or order actions.', criteria: {
    orderly: 'Pullback is counter-directional with lower momentum than the preceding directional impulse.',
    adverse: 'Counter-directional movement is strengthening and undermining the preceding directional impulse.',
    absent: 'No identifiable recent pullback is present.',
    insufficient: 'Direction is unknown or evidence does not support a classification.' } },
});
const widths = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const fresh = (time, now, age) => finite(time) && time <= now + 5000 && now - time <= age;

// Explicit allowlist: account balances, holdings, credentials and arbitrary source
// strings never enter a provider request. Callers supply numeric public evidence.
export function prepareState(input, now = Date.now()) {
  assert(['S1', 'S2'].includes(input?.accountLabel), 'JEV_ACCOUNT_INVALID');
  assert(fresh(input.asOf, now, 180000), 'JEV_SNAPSHOT_STALE');
  const c = input.candidate;
  assert(/^[A-Z0-9]{2,20}USDT$/.test(c?.symbol), 'JEV_SYMBOL_INVALID');
  assert(finite(c.px) && c.px > 0 && finite(c.intersectionTime), 'JEV_CANDIDATE_INVALID');
  assert(['LONG', 'SHORT', null].includes(c.direction), 'JEV_DIRECTION_INVALID');
  const intervals = input.accountLabel === 'S1' ? ['4h', '1h', '15m'] : ['1h', '15m', '5m'];
  const bars = {};
  for (const interval of intervals) {
    const rows = input.bars?.[interval];
    assert(Array.isArray(rows) && rows.length >= 24 && rows.length <= 1000, 'JEV_BARS_MISSING');
    const selected = rows.slice(-48);
    bars[interval] = selected.map((b, i) => {
      assert(['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume'].every(k => finite(b[k])), 'JEV_BAR_INVALID');
      assert(b.low > 0 && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close) && b.volume >= 0, 'JEV_BAR_INVALID');
      assert(b.closeTime === b.openTime + widths[interval] - 1 && b.closeTime < input.asOf, 'JEV_BAR_NOT_CLOSED');
      assert(i === 0 || b.openTime === selected[i - 1].openTime + widths[interval], 'JEV_BAR_GAP');
      return Object.fromEntries(['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume'].map(k => [k, b[k]]));
    });
    assert(fresh(bars[interval].at(-1).closeTime, input.asOf, widths[interval] + 30000), 'JEV_BARS_STALE');
  }
  const q = input.quote;
  assert(fresh(q?.asOf, now, 15000) && q.asOf <= input.asOf + 5000 && finite(q.bid) && finite(q.ask) && q.bid > 0 && q.ask >= q.bid, 'JEV_QUOTE_INVALID');
  return { asOf: input.asOf, venue: 'BINANCE_USDM_PERPETUAL', intervals,
    candidate: { symbol: c.symbol, direction: c.direction, px: c.px, intersectionTime: c.intersectionTime },
    quote: { asOf: q.asOf, bid: q.bid, ask: q.ask }, bars };
}
export function validateResponse(body) {
  assert(typeof body?.model === 'string' && body.model.length <= 120, 'JEV_RESPONSE_INVALID');
  const answers = {};
  for (const [key, question] of Object.entries(QUESTIONS)) {
    const a = body.answers?.[key], keys = Object.keys(question.criteria);
    assert(a?.type === 'choice' && keys.includes(a.choice) && finite(a.confidence) && a.confidence >= 0 && a.confidence <= 1, 'JEV_RESPONSE_INVALID');
    const p = a.probabilities;
    assert(p && Object.keys(p).length === keys.length && keys.every(k => finite(p[k]) && p[k] >= 0 && p[k] <= 1), 'JEV_RESPONSE_INVALID');
    assert(Math.abs(keys.reduce((sum, k) => sum + p[k], 0) - 1) <= 0.001, 'JEV_RESPONSE_INVALID');
    assert(p[a.choice] >= Math.max(...keys.map(k => p[k])) - 0.000001, 'JEV_RESPONSE_INVALID');
    answers[key] = { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(keys.map(k => [k, p[k]])) };
  }
  return { model: body.model, answers, usage: Object.fromEntries(['input_tokens', 'output_tokens'].filter(k => Number.isSafeInteger(body.usage?.[k]) && body.usage[k] >= 0).map(k => [k, body.usage[k]])) };
}

export async function evaluate(input, { apiKey = process.env.TYPESAFE_API_KEY, model = process.env.JEV_MODEL_ID ?? 'jev-latest', fetcher = fetch, now = Date.now } = {}) {
  const startedAt = now();
  const base = { revision: REVISION, mode: 'OBSERVE_ONLY', accountLabel: input?.accountLabel, evaluatedAt: startedAt, orderAuthority: false };
  try {
    const state = prepareState(input, startedAt);
    assert(typeof apiKey === 'string' && apiKey.trim().length > 0, 'JEV_KEY_MISSING');
    assert(typeof model === 'string' && /^jev-[a-zA-Z0-9.-]{1,80}$/.test(model), 'JEV_MODEL_INVALID');
    const request = { model, state, questions: QUESTIONS };
    const inputHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) return { ...base, inputHash, status: 'UNAVAILABLE', code: `JEV_HTTP_${response.status}`, latencyMs: now() - startedAt };
    const result = validateResponse(await response.json());
    const completedAt = now();
    assert(fresh(state.asOf, completedAt, 180000) && fresh(state.quote.asOf, completedAt, 15000), 'JEV_RESULT_STALE');
    return { ...base, inputHash, status: 'EVALUATED', ...result, completedAt, latencyMs: completedAt - startedAt };
  } catch (error) {
    // Never persist provider bodies, Authorization, or raw network error messages.
    return { ...base, status: 'UNAVAILABLE', code: /^JEV_[A-Z_]+$/.test(error.message) ? error.message : 'JEV_REQUEST_FAILED', latencyMs: now() - startedAt };
  }
}
