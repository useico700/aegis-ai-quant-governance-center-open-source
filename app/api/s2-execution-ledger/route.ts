import { publicApi } from "../../../lib/public-preview.mjs";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { sanitizeS2Ledger, summarizeS2Fills } from "../../../lib/s2-monitor.mjs";

const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };
async function environment(): Promise<Env> { const { env } = await import("cloudflare:workers"); return env as unknown as Env; }
async function ensureTables(DB: D1Database) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS s2_execution_snapshots (
    id TEXT PRIMARY KEY NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS s2_trade_fills (
    key TEXT PRIMARY KEY NOT NULL, trade_time INTEGER NOT NULL, payload TEXT NOT NULL,
    observed_at TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS s2_filtered_candidates (
    key TEXT PRIMARY KEY NOT NULL, evaluated_at TEXT NOT NULL, payload TEXT NOT NULL,
    observed_at TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await DB.prepare("CREATE INDEX IF NOT EXISTS idx_s2_trade_fills_time ON s2_trade_fills (trade_time)").run();
  await DB.prepare("CREATE INDEX IF NOT EXISTS idx_s2_filtered_candidates_time ON s2_filtered_candidates (evaluated_at)").run();
}

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("s2-execution-ledger", "GET");

  try {
    const { DB } = await environment();
    await ensureTables(DB);
    const [execution, rows, filteredRows] = await Promise.all([
      DB.prepare("SELECT observed_at AS observedAt, payload, received_at AS receivedAt FROM s2_execution_snapshots WHERE id='S2'").first<{ observedAt: string; payload: string; receivedAt: string }>(),
      DB.prepare("SELECT payload FROM s2_trade_fills ORDER BY trade_time DESC LIMIT 100").all<{ payload: string }>(),
      DB.prepare("SELECT payload FROM s2_filtered_candidates ORDER BY evaluated_at DESC LIMIT 100").all<{ payload: string }>(),
    ]);
    const fills = rows.results.map(row => JSON.parse(row.payload));
    const filteredCandidates = filteredRows.results.map(row => JSON.parse(row.payload));
    return Response.json({ status: execution ? (Date.now() - Date.parse(execution.observedAt) > 180000 ? "STALE" : "OK") : "WAITING_FIRST_SNAPSHOT",
      receivedAt: execution?.receivedAt ?? null, observedAt: execution?.observedAt ?? null,
      execution: execution ? JSON.parse(execution.payload) : null, filteredCandidates, fills, summary: summarizeS2Fills(fills) }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE", execution: null, filteredCandidates: [], fills: [], summary: summarizeS2Fills([]) }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("s2-execution-ledger", "POST");

  try {
    const { DB, S2_MONITOR_INGEST_TOKEN = "" } = await environment();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (S2_MONITOR_INGEST_TOKEN.length < 32 || !safeEqual(supplied, S2_MONITOR_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    if (body.length > 128000) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const snapshot = sanitizeS2Ledger(JSON.parse(body));
    await ensureTables(DB);
    const receivedAt = new Date().toISOString();
    const statements = [DB.prepare(`INSERT INTO s2_execution_snapshots (id,observed_at,payload,received_at) VALUES ('S2',?,?,?)
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload,received_at=excluded.received_at
      WHERE excluded.observed_at > s2_execution_snapshots.observed_at`).bind(snapshot.observedAt, JSON.stringify(snapshot.execution), receivedAt),
      ...snapshot.fills.map(row => DB.prepare("INSERT OR IGNORE INTO s2_trade_fills (key,trade_time,payload,observed_at,received_at) VALUES (?,?,?,?,?)")
        .bind(row.key, row.time, JSON.stringify(row), snapshot.observedAt, receivedAt)),
      ...snapshot.filteredCandidates.map(row => DB.prepare("INSERT OR IGNORE INTO s2_filtered_candidates (key,evaluated_at,payload,observed_at,received_at) VALUES (?,?,?,?,?)")
        .bind(row.key, row.evaluatedAt, JSON.stringify(row), snapshot.observedAt, receivedAt))];
    const results = await DB.batch(statements);
    const filteredOffset = 1 + snapshot.fills.length;
    return Response.json({ status: "SYNCED", observedAt: snapshot.observedAt,
      executionUpdated: (results[0]?.meta?.changes ?? 0) > 0,
      fillsInserted: results.slice(1, filteredOffset).reduce((sum, row) => sum + Number(row.meta?.changes ?? 0), 0),
      filteredCandidatesInserted: results.slice(filteredOffset).reduce((sum, row) => sum + Number(row.meta?.changes ?? 0), 0) }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
