import { CANDIDATE_ROW_PREFIX, candidateRowId, validateCandidateReport, validateCandidateTransition } from "./candidate-contract.mjs";
import { encodeShadowState, decodeShadowState } from "./persistence.mjs";

const headers = { "Cache-Control": "no-store" };
async function rows(db, limit = 1) {
  const result = await db.prepare("SELECT id, payload, input_sha256 AS inputSha256, source_as_of AS sourceAsOf, revision, received_at AS receivedAt FROM mtfx_account_shadow_states WHERE id >= ? AND id <= ? ORDER BY id DESC LIMIT ?")
    .bind(`${CANDIDATE_ROW_PREFIX}000000000001`, `${CANDIDATE_ROW_PREFIX}999999999999`, limit).all();
  return result.results ?? [];
}
async function unpack(row) {
  const report = validateCandidateReport(await decodeShadowState(row.payload));
  if (row.id !== candidateRowId(report.sequence) || row.revision !== report.sequence || row.sourceAsOf !== report.sourceAsOf || row.inputSha256 !== JSON.parse(row.payload).state_sha256) throw new Error("CANDIDATE_ROW_INTEGRITY");
  return report;
}
function authorized(expected, supplied) {
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < Math.max(expected.length, supplied.length); i++) diff |= (expected.charCodeAt(i) || 0) ^ (supplied.charCodeAt(i) || 0);
  return expected.length > 0 && diff === 0;
}
async function limitedJson(request) {
  if (Number(request.headers.get("content-length")) > 20000 || !request.body) throw new Error("CANDIDATE_PAYLOAD_TOO_LARGE");
  const reader = request.body.getReader(); let size = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 20000) { await reader.cancel(); throw new Error("CANDIDATE_PAYLOAD_TOO_LARGE"); } chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

// Dependency injection keeps tests off the real D1 service. No schema mutation or A/B writes.
export function createCandidateHandlers(runtimeEnv, clock = Date.now) {
  return {
    async GET() {
      try {
        const { DB } = await runtimeEnv(); const historyRows = await rows(DB, 360);
        if (!historyRows.length) return Response.json({ status: "WAITING_FOR_INDEPENDENT_FEED", candidate: null, observations: [] }, { headers });
        const reports = await Promise.all(historyRows.map(unpack)); const latest = reports[0];
        for (let i = reports.length - 1; i > 0; i--) validateCandidateTransition(reports[i], reports[i - 1]);
        if (reports.length < 360 && reports.at(-1).sequence !== 1) throw new Error("CANDIDATE_HISTORY_GAP");
        const stale = clock() - Date.parse(latest.sourceAsOf) > 120000;
        return Response.json({ status: stale ? "CANDIDATE_FEED_STALE" : "OBSERVE_ONLY", receivedAt: historyRows[0].receivedAt, candidate: latest,
          observations: reports.reverse().filter((r) => r.startedAt !== null).map((r) => ({ sourceAsOf: r.sourceAsOf, equityUsdt: r.account.liquidationNetEquityUsdt, floorUsdt: r.account.protectionFloorUsdt,
            complete: r.status === "ACTIVE_OBSERVE_ONLY" && r.gates.blockers.length === 0 && r.gates.abnormalLoss.status === "CLEAR" && Object.values(r.inputs).every((i) => i.status === "HEALTHY") })) }, { headers });
      } catch { return Response.json({ status: "CANDIDATE_INTEGRITY_HOLD", candidate: null, observations: [] }, { status: 503, headers }); }
    },
    async POST(request) {
      try {
        const { DB, MTFX_LEDGER_INGEST_TOKEN = "" } = await runtimeEnv();
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!authorized(MTFX_LEDGER_INGEST_TOKEN, token)) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers });
        const candidate = validateCandidateReport(await limitedJson(request), clock());
        const previousRow = (await rows(DB))[0]; const previous = previousRow ? await unpack(previousRow) : null;
        const serialized = await encodeShadowState(candidate);
        if (previous && candidate.sequence <= previous.sequence) {
          const row = await DB.prepare("SELECT id, payload, input_sha256 AS inputSha256, source_as_of AS sourceAsOf, revision, received_at AS receivedAt FROM mtfx_account_shadow_states WHERE id = ?").bind(candidateRowId(candidate.sequence)).first();
          if (row && JSON.stringify(await unpack(row)) === JSON.stringify(candidate)) return Response.json({ status: "IDEMPOTENT_DUPLICATE", sequence: candidate.sequence }, { headers });
          return Response.json({ error: "CANDIDATE_SEQUENCE_CONFLICT" }, { status: 409, headers });
        }
        validateCandidateTransition(previous, candidate);
        const result = await DB.prepare("INSERT INTO mtfx_account_shadow_states (id, source_as_of, payload, received_at, revision, input_sha256) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
          .bind(candidateRowId(candidate.sequence), candidate.sourceAsOf, serialized, new Date(clock()).toISOString(), candidate.sequence, JSON.parse(serialized).state_sha256).run();
        if (Number(result.meta?.changes ?? 0) !== 1) return Response.json({ error: "CANDIDATE_CONCURRENT_WRITE_RETRY" }, { status: 409, headers });
        return Response.json({ status: "STORED_OBSERVE_ONLY", sequence: candidate.sequence }, { headers });
      } catch (error) {
        const message = error instanceof Error && error.message.startsWith("CANDIDATE_") ? error.message : "CANDIDATE_INGEST_HOLD";
        return Response.json({ error: message }, { status: message === "CANDIDATE_PAYLOAD_TOO_LARGE" ? 413 : 400, headers });
      }
    },
  };
}
