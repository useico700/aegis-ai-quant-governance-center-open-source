const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const httpStatus = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;

// Keep provider and network diagnostics bounded; never persist response bodies.
export async function inferAnswers(client, request, { delay = pause } = {}) {
  const ids = Object.keys(request.questions);
  if (!ids.length) return { answers: {}, complete: true, failureCode: null, attempts: 0 };
  let answers = {}, failureCode = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await client.systemOne(request);
      if (response.model !== request.model) return { answers: {}, complete: false, failureCode: 'JEV_MODEL_MISMATCH', attempts: attempt };
      answers = Object.fromEntries(ids.map(id => [id, response.answers?.[id]])
        .filter(([, answer]) => answer?.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1));
      if (Object.keys(answers).length === ids.length) return { answers, complete: true, failureCode: null, attempts: attempt };
      failureCode = 'JEV_RESPONSE_INCOMPLETE';
    } catch (error) {
      const status = httpStatus(error);
      failureCode = status ? `JEV_HTTP_${status}` : 'JEV_SDK_REQUEST_FAILED';
      if (status && status < 500) return { answers: {}, complete: false, failureCode, attempts: attempt };
    }
    if (attempt === 1) await delay(800);
  }
  return { answers, complete: false, failureCode, attempts: 2 };
}

// Snapshot writes are idempotent by (account, asOf); a timeout may occur after
// the site committed the row, so retrying the same payload is safe.
export async function postObservation(fetcher, url, payload, { ingestToken, bypassToken, delay = pause } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}`, 'oai-sites-authorization': `Bearer ${bypassToken}` },
      body: JSON.stringify(payload) });
      if (!response.ok) {
        if (response.status < 500 || attempt === 2) throw new Error(`PUBLISH_HTTP_${response.status}`);
      } else {
        const body = await response.json();
        if (['SYNCED', 'OLDER_IGNORED'].includes(body.status)) return body.status;
        throw new Error('PUBLISH_RECEIPT_INVALID');
      }
    } catch (error) {
      if (/^PUBLISH_(HTTP_[1-4]\d\d|RECEIPT_INVALID)$/.test(error?.message ?? '') || attempt === 2)
        throw new Error(/^PUBLISH_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PUBLISH_NETWORK_FAILED');
    }
    await delay(800);
  }
}
