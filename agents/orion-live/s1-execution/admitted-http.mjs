import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { parseExchangeJson, assertSafeParsedNumbers } from '../../../lib/exchange-json.mjs';
import { readRequestWeight } from './request-budget.mjs';
import { invariant } from './common.mjs';

// Shared admission covers headers AND complete body consumption/cancellation.
// Never use a fetch-only wrapper: resolving Response is not request completion.
export async function admittedReadJson(urlInput, init, { admission, fetcher = fetch, timeoutMs = 5000, maximumBytes = 4 * 1024 ** 2,
  observeResponse = () => {} } = {}) {
  let url;
  try { url = new URL(urlInput); } catch { throw new Error('ADMITTED_HTTP_URL_INVALID'); }
  invariant(url.origin === 'https://demo-fapi.binance.com' && !url.username && !url.password && !url.hash, 'ADMITTED_HTTP_ORIGIN');
  invariant(admission && typeof admission.run === 'function', 'SHARED_HTTP_ADMISSION_REQUIRED');
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000
    && Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 4 * 1024 ** 2, 'ADMITTED_HTTP_LIMITS');
  const method = init?.method ?? 'GET';
  invariant(Object.keys(init ?? {}).every(k => ['method', 'headers'].includes(k)), 'ADMITTED_HTTP_OPTIONS');
  // Only weighting inputs are extracted. Signing data never enters the store.
  invariant(url.searchParams.getAll('limit').length <= 1 && url.searchParams.getAll('symbol').length <= 1, 'ADMITTED_HTTP_AMBIGUOUS_WEIGHT');
  const params = Object.fromEntries(['limit', 'symbol'].filter(k => url.searchParams.has(k)).map(k => [k, url.searchParams.get(k)]));
  const weight = readRequestWeight(method, url.pathname, params);
  let bound = admission;
  if (typeof admission.bindRequest === 'function') {
    // Bind only non-secret request semantics. Never pass a URL, headers or
    // signing values to the coordinator. Unknown/duplicate keys fail closed.
    const fields = ['symbol', 'limit', 'interval', 'startTime', 'endTime', 'autoCloseType'];
    const ignored = ['timestamp', 'signature', 'recvWindow'];
    const keys = [...url.searchParams.keys()];
    invariant(new Set(keys).size === keys.length && keys.every(k => fields.includes(k) || ignored.includes(k)), 'ADMITTED_HTTP_BINDING_PARAMETERS');
    const query = Object.fromEntries(keys.filter(k => fields.includes(k)).sort().map(k => [k, url.searchParams.get(k)]));
    invariant(Object.values(query).every(v => v.length <= 64), 'ADMITTED_HTTP_BINDING_PARAMETERS');
    bound = admission.bindRequest(Object.freeze({ method, pathname: url.pathname, params: Object.freeze(query) }));
    invariant(bound && typeof bound.run === 'function', 'ADMITTED_HTTP_BINDING_REQUIRED');
  }
  return bound.run(weight, async observe => {
    invariant(typeof observe === 'function', 'SHARED_HTTP_OBSERVER_REQUIRED');
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
    let response, reader, status = null, bodyComplete = false;
    try {
      response = await fetcher(url, { ...init, method, redirect: 'error', signal: abort.signal }); status = response.status ?? null;
      const metadata = { status, usedWeight: url.pathname === '/fapi/v1/ticker/bookTicker' ? null : response.headers?.get('x-mbx-used-weight-1m') ?? null,
        retryAfter: response.headers?.get('retry-after') ?? null, serverDate: response.headers?.get('date') ?? null };
      await observe(metadata); await observeResponse(metadata);
      let payload;
      if (response.body?.getReader) {
        reader = response.body.getReader(); const buffer = Buffer.alloc(maximumBytes); let bytes = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) { bodyComplete = true; break; }
          invariant(value instanceof Uint8Array && value.byteLength <= maximumBytes - bytes, 'ADMITTED_HTTP_BODY_LIMIT');
          buffer.set(value, bytes); bytes += value.byteLength;
        }
        const text = buffer.toString('utf8', 0, bytes); payload = text ? parseExchangeJson(text) : {};
      } else {
        // Compatibility only for injected synthetic transports, never native I/O.
        invariant(fetcher !== fetch || response.body === null, 'ADMITTED_HTTP_BODY_STREAM_REQUIRED');
        if (typeof response.text === 'function') {
          const text = await response.text(); invariant(Buffer.byteLength(text) <= maximumBytes, 'ADMITTED_HTTP_BODY_LIMIT'); payload = text ? parseExchangeJson(text) : {};
        } else { payload = assertSafeParsedNumbers(await response.json()); invariant(Buffer.byteLength(JSON.stringify(payload)) <= maximumBytes, 'ADMITTED_HTTP_BODY_LIMIT'); }
        bodyComplete = true;
      }
      invariant(!abort.signal.aborted, 'ADMITTED_HTTP_DEADLINE');
      return { payload, ok: response.ok === true, status };
    } catch {
      // Original network/parser errors may contain signed URLs or response text.
      const safe = new Error('ADMITTED_HTTP_READ_FAILED'); safe.httpStatus = status; throw safe;
    } finally {
      clearTimeout(timer);
      if (!bodyComplete) {
        abort.abort();
        if (reader) await reader.cancel().catch(() => {});
        else await response?.body?.cancel?.().catch(() => {});
      }
      try { reader?.releaseLock(); } catch { throw new Error('ADMITTED_HTTP_CLEANUP_FAILED'); }
    }
  });
}
