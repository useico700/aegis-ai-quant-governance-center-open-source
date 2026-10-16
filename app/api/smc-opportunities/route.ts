import { publicApi } from "../../../lib/public-preview.mjs";
import {packSmcSnapshot,unpackSmcSnapshot} from "../../../lib/smc-snapshot-wire.mjs";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { sanitizeSmcScan } from "../../../lib/smc-scan-snapshot.mjs";
const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };
async function database() {
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as Env;
  await runtime.DB.prepare("CREATE TABLE IF NOT EXISTS smc_scan_snapshots (id TEXT PRIMARY KEY, source_as_of TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL)").run();
  return runtime;
}
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-opportunities", "GET");

  try {
    const { DB } = await database();
    const row = await DB.prepare("SELECT payload, received_at AS receivedAt FROM smc_scan_snapshots WHERE id = ?").bind("SMC").first<{ payload: string; receivedAt: string }>();
    if (!row) return Response.json({ status: "WAITING_FIRST_SCAN", snapshot: null }, { headers });
    const snapshot = unpackSmcSnapshot(JSON.parse(row.payload)), age = Date.now() - Date.parse(snapshot.sourceAsOf);
    return Response.json({ status: age < -5000 || age > snapshot.policy.snapshotStaleAfterMs ? "STALE" : "OK", snapshot, receivedAt: row.receivedAt }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE", snapshot: null }, { headers, status: 503 }); }
}
export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-opportunities", "POST");

  try {
    const { env } = await import("cloudflare:workers");
    const token = (env as unknown as Env).S2_MONITOR_INGEST_TOKEN ?? "";
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (token.length < 32 || !safeEqual(token, supplied)) return Response.json({ status: "UNAUTHORIZED" }, { headers, status: 401 });
    const text = await request.text();
    // Model proofs and four atomic frames are bounded below the D1 row limit.
    if (new TextEncoder().encode(text).byteLength > 1_500_000) return Response.json({ status: "TOO_LARGE" }, { headers, status: 413 });
    const snapshot = sanitizeSmcScan(unpackSmcSnapshot(JSON.parse(text))), { DB } = await database();
    const payload = JSON.stringify(packSmcSnapshot(snapshot));
    if (new TextEncoder().encode(payload).byteLength > 1_500_000) return Response.json({ status: "TOO_LARGE" }, { headers, status: 413 });
    const result = await DB.prepare("INSERT INTO smc_scan_snapshots (id, source_as_of, payload, received_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_as_of=excluded.source_as_of,payload=excluded.payload,received_at=excluded.received_at WHERE excluded.source_as_of > smc_scan_snapshots.source_as_of")
      .bind("SMC", snapshot.sourceAsOf, payload, new Date().toISOString()).run();
    return Response.json({ status: result.meta.changes ? "SYNCED" : "OLDER_SNAPSHOT_IGNORED", sourceAsOf: snapshot.sourceAsOf }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { headers, status: 400 }); }
}
