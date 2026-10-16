import { createHash } from 'node:crypto';
import { TypeSafeClient, VERSION, noul } from '@typesafe-ai/sdk';

// Explicitly invoked local connectivity check. No exchange or account data.
const startedAt = Date.now();
const request = {
  model: 'jev-1.13.0',
  state: { document: 'This is a synthetic SDK connectivity check.' },
  questions: {
    connectivity: noul('Does `document` explicitly describe a connectivity check?'),
  },
};
const base = {
  sdk: '@typesafe-ai/sdk',
  sdkVersion: VERSION,
  syntheticProbe: true,
  mode: 'CONNECTIVITY_CHECK_ONLY',
  orderAuthority: false,
  startedAt: new Date(startedAt).toISOString(),
  requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
};
let result;
try {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('JEV_KEY_MISSING');
  const client = new TypeSafeClient({
    baseURL: 'https://api.typesafe.ai',
    timeout: 8000,
    retry: { maxRetries: 0 },
    logLevel: 'off',
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  });
  const response = await client.systemOne(request);
  const answer = response.answers?.connectivity;
  if (response.model !== request.model || answer?.type !== 'noul'
    || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error('JEV_RESPONSE_INVALID');
  }
  result = {
    ...base,
    status: 'EVALUATED',
    model: response.model,
    answer: { type: 'noul', noul: answer.noul },
    usage: Object.fromEntries(['input_tokens', 'output_tokens']
      .filter(key => Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0)
      .map(key => [key, response.usage[key]])),
  };
} catch (error) {
  // Never log provider response bodies, credentials, or raw SDK/network errors.
  const code = ['JEV_KEY_MISSING', 'JEV_RESPONSE_INVALID'].includes(error?.message)
    ? error.message
    : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
      ? `JEV_HTTP_${error.status}` : 'JEV_SDK_REQUEST_FAILED';
  result = { ...base, status: 'UNAVAILABLE', code };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify({ ...result, latencyMs: Date.now() - startedAt })}\n`);
