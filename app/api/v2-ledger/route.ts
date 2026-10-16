import { publicApi } from "../../../lib/public-preview.mjs";
const SNAPSHOT_ID = "orion-v2-latest";

type RuntimeEnv = {
  DB: D1Database;
  V2_LEDGER_INGEST_TOKEN?: string;
};

async function runtimeEnv(): Promise<RuntimeEnv> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as RuntimeEnv;
}

async function ensureTable(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS v2_ledger_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      source_as_of TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v2-ledger", "GET");

  try {
    const { DB } = await runtimeEnv();
    await ensureTable(DB);
    const row = await DB.prepare(
      "SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt FROM v2_ledger_snapshots WHERE id = ?",
    ).bind(SNAPSHOT_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string }>();

    if (!row) {
      return Response.json({ status: "WAITING_FOR_FIRST_SNAPSHOT" }, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return Response.json({
      status: "OK",
      sourceAsOf: row.sourceAsOf,
      receivedAt: row.receivedAt,
      snapshot: JSON.parse(row.payload),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      status: "UNAVAILABLE",
      error: error instanceof Error ? error.message : "V2 ledger unavailable",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v2-ledger", "POST");

  void request;
  return Response.json({
    error: "owner pause: V2 ledger ingestion is read-only after migration",
  }, { status: 423, headers: { "Cache-Control": "no-store" } });
  /* Historical implementation retained below for audit and future owner-authorized recovery.
  try {
    const env = await runtimeEnv();
    const configuredToken = text(env.V2_LEDGER_INGEST_TOKEN);
    const suppliedToken = text(request.headers.get("authorization")).replace(/^Bearer\s+/i, "");
    if ((!configuredToken && !isLocal(request)) || (configuredToken && !safeEqual(configuredToken, suppliedToken))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const payload = await request.json() as Record<string, unknown>;
    const sourceAsOf = text(payload.sourceAsOf);
    const serialized = JSON.stringify(payload);
    if (!sourceAsOf || serialized.length > 750_000 || !Array.isArray(payload.positions) || !payload.account) {
      return Response.json({ error: "invalid V2 ledger snapshot" }, { status: 400 });
    }

    await ensureTable(env.DB);
    const receivedAt = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO v2_ledger_snapshots (id, source_as_of, payload, received_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_as_of = excluded.source_as_of,
        payload = excluded.payload,
        received_at = excluded.received_at
    `).bind(SNAPSHOT_ID, sourceAsOf, serialized, receivedAt).run();

    return Response.json({ status: "STORED", sourceAsOf, receivedAt });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "snapshot ingest failed",
    }, { status: 500 });
  }
  */
}
