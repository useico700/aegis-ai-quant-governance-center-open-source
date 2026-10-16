import { publicApi } from "../../../../../lib/public-preview.mjs";
import { cursorFor, parseCursor } from "../../../lib/feed";
import { sanitizePayload, sanitizeSmcPayload } from "../../../lib/payload";

type Env = { DB: D1Database; JEV_FILTER_INGEST_TOKEN?: string };
const headers = { "Cache-Control": "no-store" };
// Transport/storage capacity, not candidate admission or order-risk policy.
// SMC carries complete structural evidence before the existing sanitizer.
const smcPayloadMaxBytes = 1_500_000;
const legacyPayloadMaxBytes = 256_000;
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const latestSchema = `CREATE TABLE IF NOT EXISTS jev_filter_snapshots (
  account TEXT PRIMARY KEY CHECK (account IN ('S1','S2')),
  as_of TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL
)`;
const historySchema = `CREATE TABLE IF NOT EXISTS jev_filter_observation_history (
  account TEXT NOT NULL CHECK (account IN ('S1','S2')),
  as_of TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (account, as_of)
)`;
const smcLatestSchema = `CREATE TABLE IF NOT EXISTS jev_smc_snapshots (
  account TEXT PRIMARY KEY CHECK (account = 'SMC'),
  as_of TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL
)`;
const smcHistorySchema = `CREATE TABLE IF NOT EXISTS jev_smc_observation_history (
  account TEXT NOT NULL CHECK (account = 'SMC'),
  as_of TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (account, as_of)
)`;
async function ensureSchema(DB: D1Database) {
  await DB.prepare(latestSchema).run();
  await DB.prepare(historySchema).run();
  await DB.prepare(smcLatestSchema).run();
  await DB.prepare(smcHistorySchema).run();
}
async function environment(): Promise<Env> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as Env;
}
function sameSecret(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}
export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("observations", "GET");

  const params = new URL(request.url).searchParams;
  let cursor;
  try { cursor = parseCursor(params.get('before') ?? params.get('after')); }
  catch { return Response.json({ status: 'INVALID_CURSOR' }, { status: 400, headers }); }
  const forward = params.has('after');
  if (params.has('after') && params.has('before')) return Response.json({ status: 'INVALID_CURSOR' }, { status: 400, headers });
  try {
    const { DB } = await environment();
    await ensureSchema(DB);
    const rows = await DB.prepare("SELECT account, as_of AS asOf, received_at AS receivedAt, payload FROM jev_filter_snapshots").all<{ account: string; asOf: string; receivedAt: string; payload: string }>();
    const history = await DB.prepare("SELECT account, COUNT(*) AS samples, MIN(as_of) AS firstAsOf, MAX(as_of) AS lastAsOf FROM jev_filter_observation_history GROUP BY account").all<{ account: string; samples: number; firstAsOf: string; lastAsOf: string }>();
    const smcRows = await DB.prepare("SELECT payload FROM jev_smc_snapshots WHERE account = 'SMC' LIMIT 1").all<{ payload: string }>();
    const smc=smcRows.results[0]??null;
    const comparison = forward ? '>' : '<';
    const where = cursor ? `WHERE (as_of ${comparison} ? OR (as_of = ? AND account ${comparison} ?))` : '';
    const query = DB.prepare(`SELECT account, as_of AS asOf, payload FROM jev_filter_observation_history ${where} ORDER BY as_of ${forward ? 'ASC' : 'DESC'}, account ${forward ? 'ASC' : 'DESC'} LIMIT 13`);
    const log = await (cursor ? query.bind(cursor.asOf, cursor.asOf, cursor.account) : query).all<{ account: string; asOf: string; payload: string }>();
    const page = log.results.slice(0, 12);
    const ordered = forward ? page : [...page].reverse();
    const feed = { batches: ordered.map(row => JSON.parse(row.payload)), hasMore: log.results.length > 12,
      oldest: ordered.length ? cursorFor(ordered[0]) : null, newest: ordered.length ? cursorFor(ordered[ordered.length - 1]) : null };
    return Response.json({ feed, status: "OK", serverTime: new Date().toISOString(), accounts: Object.fromEntries(rows.results.map(row => [row.account, JSON.parse(row.payload)])), smc:smc?JSON.parse(smc.payload):null, history: Object.fromEntries(history.results.map(row => [row.account, row])) }, { headers });
  } catch {
    return Response.json({ status: "UNAVAILABLE", accounts: {}, smc:null }, { status: 503, headers });
  }
}
export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("observations", "POST");

  try {
    const { DB, JEV_FILTER_INGEST_TOKEN = "" } = await environment();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (JEV_FILTER_INGEST_TOKEN.length < 32 || !sameSecret(supplied, JEV_FILTER_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    const bodyBytes = utf8Bytes(body);
    if (bodyBytes > smcPayloadMaxBytes) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const raw=JSON.parse(body) as Record<string,unknown>;
    if (raw?.account !== 'SMC' && bodyBytes > legacyPayloadMaxBytes) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    if(raw.account==='SMC'){
      const payload=sanitizeSmcPayload(raw,Date.now()), serialized=JSON.stringify(payload);
      if (utf8Bytes(serialized) > smcPayloadMaxBytes) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
      await ensureSchema(DB);const receivedAt=new Date().toISOString();
      await DB.prepare("INSERT OR IGNORE INTO jev_smc_observation_history (account, as_of, received_at, payload) VALUES ('SMC', ?, ?, ?)").bind(payload.asOf,receivedAt,serialized).run();
      const result=await DB.prepare(`INSERT INTO jev_smc_snapshots (account, as_of, received_at, payload) VALUES ('SMC', ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET as_of=excluded.as_of, received_at=excluded.received_at, payload=excluded.payload
        WHERE excluded.as_of > jev_smc_snapshots.as_of`).bind(payload.asOf,receivedAt,serialized).run();
      return Response.json({status:result.meta.changes?'SYNCED':'OLDER_IGNORED',account:'SMC',asOf:payload.asOf},{headers});
    }
    const payload = sanitizePayload(raw, Date.now());
    const serialized = JSON.stringify(payload);
    if (utf8Bytes(serialized) > smcPayloadMaxBytes) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    await ensureSchema(DB);
    const receivedAt = new Date().toISOString();
    await DB.prepare("INSERT OR IGNORE INTO jev_filter_observation_history (account, as_of, received_at, payload) VALUES (?, ?, ?, ?)").bind(payload.account, payload.asOf, receivedAt, serialized).run();
    const result = await DB.prepare(`INSERT INTO jev_filter_snapshots (account, as_of, received_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET as_of=excluded.as_of, received_at=excluded.received_at, payload=excluded.payload
      WHERE excluded.as_of > jev_filter_snapshots.as_of`).bind(payload.account, payload.asOf, receivedAt, serialized).run();
    return Response.json({ status: result.meta.changes ? "SYNCED" : "OLDER_IGNORED", account: payload.account, asOf: payload.asOf }, { headers });
  } catch {
    return Response.json({ status: "REJECTED" }, { status: 400, headers });
  }
}
