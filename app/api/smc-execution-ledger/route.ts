import { publicApi } from "../../../lib/public-preview.mjs";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { sanitizeSmcExecutionLedger } from "../../../lib/smc-execution-ledger.mjs";
const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };
async function environment(): Promise<Env> { const { env } = await import("cloudflare:workers"); return env as unknown as Env; }
async function ensureTables(DB: D1Database) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS smc_execution_snapshots (id TEXT PRIMARY KEY NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL)").run();
  await DB.prepare("CREATE TABLE IF NOT EXISTS smc_equity_history (observed_at TEXT PRIMARY KEY NOT NULL, equity REAL NOT NULL, wallet REAL NOT NULL, available REAL NOT NULL, received_at TEXT NOT NULL)").run();
}
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-execution-ledger", "GET");

  try { const { DB } = await environment(); await ensureTables(DB);
    const [row, history] = await Promise.all([
      DB.prepare("SELECT observed_at AS observedAt,payload,received_at AS receivedAt FROM smc_execution_snapshots WHERE id='SMC'").first<{observedAt:string;payload:string;receivedAt:string}>(),
      DB.prepare("SELECT observed_at AS observedAt,equity,wallet,available FROM smc_equity_history ORDER BY observed_at DESC LIMIT 720").all(),
    ]);
    const age = row ? Date.now() - Date.parse(row.observedAt) : Infinity;
    return Response.json({ status: !row ? "WAITING_FIRST_SNAPSHOT" : age < -5000 || age > 180000 ? "STALE" : "OK",
      observedAt: row?.observedAt ?? null, receivedAt: row?.receivedAt ?? null, snapshot: row ? JSON.parse(row.payload) : null,
      history: history.results.reverse() }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE", snapshot: null, history: [] }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-execution-ledger", "POST");

  try { const { DB, S2_MONITOR_INGEST_TOKEN = "" } = await environment();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (S2_MONITOR_INGEST_TOKEN.length < 32 || !safeEqual(supplied, S2_MONITOR_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text(); if (body.length > 128000) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const snapshot = sanitizeSmcExecutionLedger(JSON.parse(body)); await ensureTables(DB); const receivedAt = new Date().toISOString();
    await DB.batch([DB.prepare("INSERT INTO smc_execution_snapshots (id,observed_at,payload,received_at) VALUES ('SMC',?,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,payload=excluded.payload,received_at=excluded.received_at WHERE excluded.observed_at > smc_execution_snapshots.observed_at").bind(snapshot.observedAt, JSON.stringify(snapshot), receivedAt),
      DB.prepare("INSERT OR IGNORE INTO smc_equity_history (observed_at,equity,wallet,available,received_at) VALUES (?,?,?,?,?)").bind(snapshot.account.observedAt, snapshot.account.equity, snapshot.account.wallet, snapshot.account.available, receivedAt)]);
    return Response.json({ status: "SYNCED", observedAt: snapshot.observedAt }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
