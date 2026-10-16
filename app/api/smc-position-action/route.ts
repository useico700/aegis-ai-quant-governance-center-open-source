import { publicApi } from "../../../lib/public-preview.mjs";
import { safeEqual } from '../../../lib/s1-monitor.mjs';
import { validateSmcPositionAction } from '../../../lib/smc-position-action.mjs';
import { normalizePriceByPurpose } from '../../../lib/smc-price-input.mjs';

const headers = { 'Cache-Control': 'no-store' };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };

async function context() {
  const { env } = await import('cloudflare:workers');
  const runtime = env as unknown as Env;
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_position_actions (
    id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    status TEXT NOT NULL, payload TEXT NOT NULL, owner_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL, result TEXT
  )`).run();
  return runtime;
}
function serviceAuthorized(request: Request, env: Env) {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return (env.S2_MONITOR_INGEST_TOKEN?.length ?? 0) >= 32 && safeEqual(supplied, env.S2_MONITOR_INGEST_TOKEN ?? '');
}
function ownerAuthorized(request: Request) {
  const origin = new URL(request.url).origin;
  return request.headers.get('origin') === origin && request.headers.get('sec-fetch-site') !== 'cross-site'
    && Boolean(request.headers.get('oai-authenticated-user-id'));
}
async function currentPositionContext(DB: D1Database, planId: string, symbol: string, direction: string) {
  const row = await DB.prepare("SELECT observed_at AS observedAt,payload FROM smc_execution_snapshots WHERE id='SMC'")
    .first<{ observedAt: string; payload: string }>();
  if (!row || Date.now() - Date.parse(row.observedAt) > 180000) return null;
  const snapshot = JSON.parse(row.payload);
  const position = Array.isArray(snapshot.positions) && snapshot.positions.some((entry: { planId:string;symbol:string;direction:string;status:string }) =>
    entry.planId === planId && entry.symbol === symbol && entry.direction === direction && entry.status === 'OPEN');
  const rule = Array.isArray(snapshot.priceRules) ? snapshot.priceRules.find((entry: { symbol?: string }) => entry.symbol === symbol) : null;
  return position ? { tickSize: typeof rule?.tickSize === 'string' ? rule.tickSize : null } : null;
}

export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-position-action", "GET");

  try {
    const env = await context(), url = new URL(request.url);
    if (url.searchParams.get('pending') === '1') {
      if (!serviceAuthorized(request, env)) return Response.json({ status: 'UNAUTHORIZED' }, { status: 401, headers });
      const rows = await env.DB.prepare("SELECT payload FROM smc_position_actions WHERE status IN ('QUEUED','SUBMITTED') AND expires_at>? ORDER BY created_at ASC LIMIT 8")
        .bind(Date.now()).all<{ payload: string }>();
      return Response.json({ status: 'OK', actions: rows.results.map(row => JSON.parse(row.payload)) }, { headers });
    }
    const ownerId = request.headers.get('oai-authenticated-user-id');
    if (!ownerId) return Response.json({ status: 'UNAUTHORIZED' }, { status: 401, headers });
    const id = url.searchParams.get('id');
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return Response.json({ status: 'INVALID_ID' }, { status: 400, headers });
    const row = await env.DB.prepare('SELECT status,result,expires_at AS expiresAt FROM smc_position_actions WHERE id=? AND owner_id=?')
      .bind(id, ownerId).first<{ status:string; result:string|null; expiresAt:number }>();
    return Response.json(row ? { status: row.status === 'QUEUED' && Date.now() > row.expiresAt ? 'EXPIRED' : row.status,
      result: row.result ? JSON.parse(row.result) : null } : { status: 'NOT_FOUND' }, { status: row ? 200 : 404, headers });
  } catch { return Response.json({ status: 'UNAVAILABLE' }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-position-action", "POST");

  try {
    const env = await context();
    if (!ownerAuthorized(request)) return Response.json({ status: 'UNAUTHORIZED' }, { status: 401, headers });
    const raw = await request.text();
    if (raw.length > 2048) return Response.json({ status: 'TOO_LARGE' }, { status: 413, headers });
    const input = JSON.parse(raw);
    const position = await currentPositionContext(env.DB, input.planId, input.symbol, input.direction);
    if (!position) return Response.json({ status: 'POSITION_NOT_FOUND' }, { status: 409, headers });
    const needsStop = input.action === 'TIGHTEN_STOP' || input.action === 'ARM_STOP_PLAN' && input.stopMode === 'FIXED';
    const normalizedStop = needsStop
      ? normalizePriceByPurpose(input.stopPrice, position.tickSize, input.direction, 'STOP') : null;
    const normalizedTarget = input.action === 'UPDATE_TARGET'
      ? normalizePriceByPurpose(input.targetPrice, position.tickSize, input.direction, 'TARGET') : null;
    if (needsStop && !normalizedStop)
      return Response.json({ status: 'PRICE_PRECISION_UNAVAILABLE' }, { status: 409, headers });
    if (input.action === 'UPDATE_TARGET' && !normalizedTarget)
      return Response.json({ status: 'PRICE_PRECISION_UNAVAILABLE' }, { status: 409, headers });
    const action = validateSmcPositionAction({ ...input,
      ...(normalizedStop ? { stopPrice: Number(normalizedStop) } : {}),
      ...(normalizedTarget ? { targetPrice: Number(normalizedTarget) } : {}), createdAt: Date.now() });
    const ownerId = request.headers.get('oai-authenticated-user-id')!;
    const inflight = await env.DB.prepare(`SELECT id FROM smc_position_actions WHERE owner_id=?
      AND (status IN ('QUEUED','RECEIVED') OR (status='SUBMITTED' AND updated_at>?))
      AND json_extract(payload,'$.planId')=? LIMIT 1`).bind(ownerId, Date.now() - 120000, action.planId).first();
    if (inflight) return Response.json({ status: 'ACTION_IN_PROGRESS' }, { status: 409, headers });
    await env.DB.prepare("INSERT INTO smc_position_actions (id,created_at,expires_at,status,payload,owner_id,updated_at) VALUES (?,?,?,'QUEUED',?,?,?)")
      .bind(action.id, action.createdAt, action.expiresAt, JSON.stringify(action), ownerId, Date.now()).run();
    return Response.json({ status: 'QUEUED', id: action.id, expiresAt: action.expiresAt }, { status: 202, headers });
  } catch { return Response.json({ status: 'REJECTED' }, { status: 400, headers }); }
}

export async function PATCH(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-position-action", "PATCH");

  try {
    const env = await context();
    if (!serviceAuthorized(request, env)) return Response.json({ status: 'UNAUTHORIZED' }, { status: 401, headers });
    const raw = await request.text();
    if (raw.length > 2048) return Response.json({ status: 'TOO_LARGE' }, { status: 413, headers });
    const update = JSON.parse(raw);
    if (typeof update.id !== 'string' || !/^[a-f0-9-]{36}$/.test(update.id)
      || !['SUBMITTED','COMPLETED','REJECTED'].includes(update.status)
      || typeof update.reason !== 'string' || !/^[A-Z0-9_]{1,96}$/.test(update.reason))
      return Response.json({ status: 'INVALID_UPDATE' }, { status: 400, headers });
    const result = await env.DB.prepare("UPDATE smc_position_actions SET status=?,result=?,updated_at=? WHERE id=? AND status IN ('QUEUED','RECEIVED','SUBMITTED')")
      .bind(update.status, JSON.stringify({ reason: update.reason, at: Date.now() }), Date.now(), update.id).run();
    return Response.json({ status: result.meta.changes ? 'SYNCED' : 'UNCHANGED' }, { headers });
  } catch { return Response.json({ status: 'REJECTED' }, { status: 400, headers }); }
}
