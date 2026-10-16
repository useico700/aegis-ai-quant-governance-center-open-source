import { UNIVERSE, invariant } from './common.mjs';
import { readRequestWeight } from './request-budget.mjs';
import { ACCOUNT_BATCH_PATHS } from './transport.mjs';

// Trusted, finite read-cost catalog. No payload, credentials, order endpoint,
// caller-supplied weights or caller-supplied owner/priority lane are accepted.
// This does NOT authorize requests; the eventual transport still validates
// actual endpoint/parameters and binds each admitted slot to its exact weight.
const catalog = new Map();
const add = (id, consumer, lane, weights) => catalog.set(id, Object.freeze({ id, consumer, lane,
  weights: Object.freeze(weights), weight: weights.reduce((a, b) => a + b, 0) }));
const account = ACCOUNT_BATCH_PATHS.map(p => readRequestWeight('GET', p));
add('reader:account', 'ACCOUNT_READER', 'reader', [1, ...account, 1]);
add('shadow:account', 'SHADOW_RESIDENT', 'shadow', [...account]);
for (const [prefix, consumer, lane] of [['reader', 'ACCOUNT_READER', 'reader'], ['scanner', 'CANDIDATE_SCANNER', 'scanner'], ['shadow', 'SHADOW_RESIDENT', 'context']]) {
  add(`${prefix}:time`, consumer, lane, [1]);
  add(`${prefix}:rules`, consumer, lane, [1]);
}
for (const [prefix, consumer, lane] of [['reader', 'ACCOUNT_READER', 'reader'], ['shadow', 'SHADOW_RESIDENT', 'shadow']]) {
  for (const method of ['post', 'put', 'delete']) add(`${prefix}:stream:${method}`, consumer, lane,
    [readRequestWeight(method.toUpperCase(), '/fapi/v1/listenKey')]);
}
for (const symbol of UNIVERSE) {
  const s = symbol.toLowerCase();
  add(`shadow:fee:${s}`, 'SHADOW_RESIDENT', 'fees', [20]);
  add(`shadow:history:${s}`, 'SHADOW_RESIDENT', 'history', [5, 20, 20]);
  add(`shadow:trades:${s}`, 'SHADOW_RESIDENT', 'history', [5]);
  for (const cause of ['liquidation', 'adl']) add(`shadow:forced:${s}:${cause}`, 'SHADOW_RESIDENT', 'history', [20]);
  add(`scanner:quote:${s}`, 'CANDIDATE_SCANNER', 'scanner', [2]);
  for (const [interval, limit] of [['15m', 320], ['1h', 1200], ['4h', 500]]) {
    const weight = readRequestWeight('GET', '/fapi/v1/klines', { limit });
    add(`scanner:bar:${s}:${interval}`, 'CANDIDATE_SCANNER', 'scanner', [weight]);
    if (interval !== '4h') add(`shadow:bar:${s}:${interval}`, 'SHADOW_RESIDENT', 'context', [weight]);
  }
}
invariant(catalog.size <= 128, 'READ_INTENT_CATALOG_CAPACITY');
export const READ_INTENT_IDS = Object.freeze([...catalog.keys()]);
export function readIntentSpec(id) {
  invariant(typeof id === 'string' && catalog.has(id), 'READ_INTENT_UNKNOWN');
  return catalog.get(id);
}
