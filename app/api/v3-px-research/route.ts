import { publicApi } from "../../../lib/public-preview.mjs";
import { sanitizePxMonitor } from "../../../lib/v3-px-monitor.mjs";

const ID = "orion-v3-px-research-latest";
const headers = { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "CDN-Cache-Control": "no-store" };
async function runtimeEnv() { const { env } = await import("cloudflare:workers"); return env as unknown as { DB: D1Database; V3_EQUITY_INGEST_TOKEN?: string }; }
async function ensureTable(db: D1Database) { await db.prepare("CREATE TABLE IF NOT EXISTS v3_equity_snapshots (id TEXT PRIMARY KEY NOT NULL, source_as_of TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run(); }
function equal(a: string, b: string) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v3-px-research", "GET");

  try {
    const { DB } = await runtimeEnv(); await ensureTable(DB);
    const row = await DB.prepare("SELECT payload, received_at AS receivedAt FROM v3_equity_snapshots WHERE id = ?").bind(ID).first<{ payload: string; receivedAt: string }>();
    return Response.json(row ? { status: "OK", receivedAt: row.receivedAt, snapshot: sanitizePxMonitor(JSON.parse(row.payload)) } : { status: "WAITING_FOR_FIRST_PUBLICATION", snapshot: null }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE", snapshot: null }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v3-px-research", "POST");

  try {
    const { DB, V3_EQUITY_INGEST_TOKEN = "" } = await runtimeEnv();
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (V3_EQUITY_INGEST_TOKEN.length < 32 || !equal(token, V3_EQUITY_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const reader = request.body?.getReader(); if (!reader) throw new Error("EMPTY_BODY");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers }); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    const snapshot = sanitizePxMonitor(JSON.parse(new TextDecoder().decode(bytes)));
    if (Date.parse(snapshot.asOf) > Date.now() + 60_000) throw new Error("FUTURE_SNAPSHOT");
    await ensureTable(DB); const receivedAt = new Date().toISOString();
    await DB.prepare(`INSERT INTO v3_equity_snapshots (id, source_as_of, payload, received_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_as_of = excluded.source_as_of, payload = excluded.payload, received_at = excluded.received_at
      WHERE excluded.source_as_of > v3_equity_snapshots.source_as_of`).bind(ID, snapshot.asOf, JSON.stringify(snapshot), receivedAt).run();
    return Response.json({ status: "ACCEPTED", sourceAsOf: snapshot.asOf, receivedAt }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
