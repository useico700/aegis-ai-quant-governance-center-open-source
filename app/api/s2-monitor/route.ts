import { publicApi } from "../../../lib/public-preview.mjs";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { sanitizeS2 } from "../../../lib/s2-monitor.mjs";
const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };
async function environment(): Promise<Env> { const { env } = await import("cloudflare:workers"); return env as unknown as Env; }
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("s2-monitor", "GET");

  try {
    const { DB } = await environment();
    const row = await DB.prepare("SELECT payload, received_at AS receivedAt FROM s2_monitor_snapshots WHERE id = ?").bind("S2").first<{ payload: string; receivedAt: string }>();
    if (!row) return Response.json({ status: "WAITING_FIRST_SNAPSHOT", snapshot: null }, { headers });
    const snapshot = JSON.parse(row.payload);
    let history = { status: "UNAVAILABLE", points: [] as unknown[], firstObservedAt: null as string | null };
    try {
      const points = await DB.prepare("SELECT observed_at AS observedAt, equity, wallet, available FROM s2_equity_observations ORDER BY observed_at DESC LIMIT 720").all();
      const first = await DB.prepare("SELECT observed_at AS observedAt FROM s2_equity_observations ORDER BY observed_at ASC LIMIT 1").first<{observedAt: string}>();
      history = {status: "OK", points: points.results.reverse(), firstObservedAt: first?.observedAt ?? null};
    } catch { /* Account snapshot stays usable during history-store outages. */ }
    return Response.json({ status: Date.now() - Date.parse(snapshot.sourceAsOf) > 180000 ? "STALE" : "OK", receivedAt: row.receivedAt, snapshot, history }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE", snapshot: null }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("s2-monitor", "POST");

  try {
    const { DB, S2_MONITOR_INGEST_TOKEN = "" } = await environment();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (S2_MONITOR_INGEST_TOKEN.length < 32 || !safeEqual(supplied, S2_MONITOR_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    if (body.length > 256000) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const snapshot = sanitizeS2(JSON.parse(body));
    const receivedAt = new Date().toISOString();
    const statements = [DB.prepare(`INSERT INTO s2_monitor_snapshots (id, source_as_of, payload, received_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_as_of = excluded.source_as_of, payload = excluded.payload, received_at = excluded.received_at
      WHERE excluded.source_as_of > s2_monitor_snapshots.source_as_of`).bind("S2", snapshot.sourceAsOf, JSON.stringify(snapshot), receivedAt)];
    const a = snapshot.account, age = Date.now() - Date.parse(a.observedAt ?? "");
    if (a.fresh && age >= -5000 && age <= 120000 && [a.equity,a.wallet,a.available].every(v => v !== null)) {
      statements.push(DB.prepare(`INSERT OR IGNORE INTO s2_equity_observations (observed_at,equity,wallet,available)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM s2_monitor_snapshots WHERE id='S2' AND source_as_of=?)`).bind(a.observedAt,a.equity,a.wallet,a.available,snapshot.sourceAsOf));
    }
    const [result] = await DB.batch(statements);
    return Response.json({ status: result.meta.changes ? "SYNCED" : "OLDER_SNAPSHOT_IGNORED", sourceAsOf: snapshot.sourceAsOf }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
