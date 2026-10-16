import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { parseExchangeJson, assertSafeParsedNumbers } from '../../../lib/exchange-json.mjs';
import { invariant } from './common.mjs';

export async function boundedResponseJson(response, maximumBytes = 4 * 1024 ** 2) {
  // Synthetic transports without a stream remain supported by contract tests.
  if (!response.body?.getReader) {
    const value = assertSafeParsedNumbers(await response.json());
    invariant(Buffer.byteLength(JSON.stringify(value)) <= maximumBytes, 'READ_RESPONSE_TOO_LARGE'); return value;
  }
  const reader = response.body.getReader(), buffers = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; invariant(total <= maximumBytes, 'READ_RESPONSE_TOO_LARGE'); buffers.push(value);
    }
    return parseExchangeJson(Buffer.concat(buffers).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
