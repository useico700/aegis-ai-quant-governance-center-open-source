import { publicApi } from "../../../lib/public-preview.mjs";
import { planFamilyKey } from "../../../lib/smc-plan-lifecycle.mjs";
import { validatedPullbackPlan } from "../../../lib/smc-pullback-scope.mjs";
import { evaluateStopSafety, stopSafetyMetrics } from "../../../lib/smc-stop-safety.mjs";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { isCurrentConditionalManualSource } from "../../../lib/smc-manual-order-source.mjs";
import { validateSmcManualIntent } from "../../../lib/smc-manual-intent.mjs";
import { normalizePriceByPurpose } from "../../../lib/smc-price-input.mjs";
import { unpackSmcSnapshot } from "../../../lib/smc-snapshot-wire.mjs";

import { manualExecutionEvidence, projectManualOrderReceipt, sameManualOrderRequest } from "../../../lib/smc-manual-receipt.mjs";

const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };
async function context() {
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as Env;
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_manual_orders (
    id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    status TEXT NOT NULL, payload TEXT NOT NULL, owner_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL, result TEXT
  )`).run();
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_plan_dismissals (
    owner_id TEXT NOT NULL, plan_key TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, dismissed_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,plan_key)
  )`).run();
  return runtime;
}
async function sourceExists(DB: D1Database, ownerId: string, intent: ReturnType<typeof validateSmcManualIntent>) {
  if (intent.source === "MANUAL_CANDIDATE") {
    if (intent.sourceId !== `${intent.symbol}-${intent.direction}`) {
      const scan = await DB.prepare("SELECT payload FROM smc_scan_snapshots WHERE id='SMC'").first<{ payload: string }>();
      if(!scan) return false;
      const snapshot=unpackSmcSnapshot(JSON.parse(scan.payload));
      if(!isCurrentConditionalManualSource(snapshot,intent)) return false;
      const plan=snapshot.results.flatMap((r: {structurePlans?: Array<{id:string}>})=>r.structurePlans??[]).find((p: {id:string})=>p.id===intent.sourceId);
      const dismissed = await DB.prepare("SELECT plan_key FROM smc_plan_dismissals WHERE owner_id=? AND plan_key=?")
        .bind(ownerId,planFamilyKey(plan)).first();
      return !dismissed;
    }
    const row = await DB.prepare("SELECT symbol FROM smc_manual_candidates WHERE owner_id=? AND symbol=? AND direction=?")
      .bind(ownerId, intent.symbol, intent.direction).first<{ symbol: string }>();
    return row?.symbol === intent.symbol;
  }
  const row = await DB.prepare("SELECT payload FROM smc_scan_snapshots WHERE id='SMC'").first<{ payload: string }>();
  if (!row) return false;
  const snapshot = unpackSmcSnapshot(JSON.parse(row.payload));
  const collection = intent.source === "ACTIVE_CANDIDATE" ? snapshot.candidates : snapshot.recentInvalidations;
  return Array.isArray(collection) && collection.some((entry: { id: string; symbol: string; direction: string }) =>
    entry.id === intent.sourceId && entry.symbol === intent.symbol && entry.direction === intent.direction);
}
type ReceiptRow = { status: string; payload: string; result: string | null; expiresAt: number; owner_id: string };
async function executionSnapshot(DB: D1Database) {
  const row = await DB.prepare("SELECT payload FROM smc_execution_snapshots WHERE id='SMC'").first<{ payload: string }>();
  return row ? JSON.parse(row.payload) : null;
}
async function receiptRow(DB: D1Database, id: string) {
  return DB.prepare("SELECT status,payload,result,owner_id,expires_at AS expiresAt FROM smc_manual_orders WHERE id=?")
    .bind(id).first<ReceiptRow>();
}
function serviceAuthorized(request: Request, env: Env) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return (env.S2_MONITOR_INGEST_TOKEN?.length ?? 0) >= 32 && safeEqual(supplied, env.S2_MONITOR_INGEST_TOKEN ?? "");
}
function ownerAuthorized(request: Request) {
  const origin = new URL(request.url).origin;
  return request.headers.get("origin") === origin
    && request.headers.get("sec-fetch-site") !== "cross-site"
    && Boolean(request.headers.get("oai-authenticated-user-id"));
}

export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-order", "GET");

  try {
    const env = await context();
    const url = new URL(request.url);
    if (url.searchParams.get("pending") === "1") {
      if (!serviceAuthorized(request, env)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
      const rows = await env.DB.prepare("SELECT payload FROM smc_manual_orders WHERE status='QUEUED' AND expires_at>? ORDER BY created_at DESC LIMIT 32")
        .bind(Date.now()).all<{ payload: string }>();
      return Response.json({ status: "OK", intents: rows.results.map(row => JSON.parse(row.payload)) }, { headers });
    }
    if (!request.headers.get("oai-authenticated-user-id")) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const id = url.searchParams.get("id");
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) return Response.json({ status: "INVALID_ID" }, { status: 400, headers });
    const row = await receiptRow(env.DB, id);
    if (!row || row.owner_id !== request.headers.get("oai-authenticated-user-id"))
      return Response.json({ status: "NOT_FOUND" }, { headers, status: 404 });
    return Response.json(projectManualOrderReceipt(row, await executionSnapshot(env.DB)), { headers });
  } catch { return Response.json({ status: "UNAVAILABLE" }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-order", "POST");

  try {
    const env = await context();
    if (!ownerAuthorized(request)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const raw = await request.text();
    if (raw.length > 2048) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const input = JSON.parse(raw);
    const ownerId = request.headers.get("oai-authenticated-user-id")!;
    if (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id))
      return Response.json({ status: "INVALID_ID" }, { status: 400, headers });
    const existing = await receiptRow(env.DB, input.id);
    const snapshot = await executionSnapshot(env.DB);
    if (existing) {
      if (existing.owner_id !== ownerId || !sameManualOrderRequest(JSON.parse(existing.payload), input))
        return Response.json({ status: "IDEMPOTENCY_CONFLICT" }, { status: 409, headers });
      return Response.json(projectManualOrderReceipt(existing, snapshot), { status: 200, headers });
    }
    const tickSize = snapshot?.priceRules?.find((rule: { symbol: string }) => rule.symbol === input.symbol)?.tickSize ?? null;
    const stopPrice = normalizePriceByPurpose(input.stopPrice, tickSize, input.direction, "STOP");
    const targetPrice = normalizePriceByPurpose(input.targetPrice, tickSize, input.direction, "TARGET");
    const limitPrice = input.orderMode === "LIMIT_GTC"
      ? normalizePriceByPurpose(input.limitPrice, tickSize, input.direction, "ENTRY") : null;
    if (!tickSize || !stopPrice || !targetPrice || (input.orderMode === "LIMIT_GTC" && !limitPrice))
      return Response.json({ status: "PRICE_PRECISION_UNAVAILABLE" }, { status: 409, headers });
    const intent = validateSmcManualIntent({ ...input, stopPrice, targetPrice, limitPrice, createdAt: Date.now() });
    if (!(await sourceExists(env.DB, ownerId, intent))) return Response.json({ status: "SOURCE_NOT_FOUND" }, { status: 409, headers });
    if (snapshot?.positions?.some((row: { symbol: string; quantity: number }) => row.symbol === intent.symbol && row.quantity > 0))
      return Response.json({ status: "SAME_SYMBOL_POSITION" }, { status: 409, headers });
    const scanRecord = await env.DB.prepare("SELECT payload FROM smc_scan_snapshots WHERE id='SMC'").first<{ payload: string }>();
    const scanRow = scanRecord ? unpackSmcSnapshot(JSON.parse(scanRecord.payload)).results?.find((row: { symbol: string }) => row.symbol === intent.symbol) : null;
    const intendedEntry = intent.orderMode === "LIMIT_GTC" ? Number(intent.limitPrice) : Number(scanRow?.structurePlans?.find((p: { direction: string }) => p.direction === intent.direction)?.entry ?? scanRow?.candidates?.find((p: { direction: string }) => p.direction === intent.direction)?.entry);
    const riskCost = (intendedEntry + Number(intent.stopPrice)) * .0008 + intendedEntry * .0002 + Number(intent.stopPrice) * .0007;
    const stopSafety = evaluateStopSafety({ context: scanRow?.stopSafetyContext, tradePlan:validatedPullbackPlan(scanRow?.structurePlans,intent.symbol,intent.direction,scanRow?.stopSafetyContext,Date.now()), symbol: intent.symbol, direction: intent.direction,
      entry: intendedEntry, stop: Number(intent.stopPrice), bid: intendedEntry, ask: intendedEntry, tick: intendedEntry,
      riskCostPerUnit: riskCost, now: Date.now() });
    if (intent.orderMode === "IMMEDIATE") stopSafetyMetrics(scanRow?.stopSafetyContext, intent.symbol, Date.now());
    if (intent.orderMode === "LIMIT_GTC" && !stopSafety.ready) return Response.json({ status: "STOP_SAFETY_REJECTED", reason: stopSafety.reason }, { status: 409, headers });
    const updatedAt = Date.now();
    // One atomic insertion: a second request must never reject work already read by the executor.
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO smc_manual_orders
      (id,created_at,expires_at,status,payload,owner_id,updated_at)
      SELECT ?,?,?,'QUEUED',?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM smc_manual_orders WHERE status IN ('QUEUED','RECEIVED') AND expires_at>?
        AND json_extract(payload,'$.symbol')=?)`)
      .bind(intent.id, intent.createdAt, intent.expiresAt, JSON.stringify(intent), ownerId, updatedAt, updatedAt, intent.symbol).run();
    if (!inserted.meta.changes) {
      const replay = await receiptRow(env.DB, intent.id);
      if (replay) {
        if (replay.owner_id !== ownerId || !sameManualOrderRequest(JSON.parse(replay.payload), intent))
          return Response.json({ status: "IDEMPOTENCY_CONFLICT" }, { status: 409, headers });
        return Response.json(projectManualOrderReceipt(replay, snapshot), { headers });
      }
      const pending = await env.DB.prepare(`SELECT id,status,owner_id,expires_at AS expiresAt FROM smc_manual_orders
        WHERE status IN ('QUEUED','RECEIVED') AND expires_at>? AND json_extract(payload,'$.symbol')=? ORDER BY created_at DESC LIMIT 1`)
        .bind(updatedAt, intent.symbol).first<{ id: string; status: string; owner_id: string; expiresAt: number }>();
      return Response.json({ status: "PENDING_MANUAL_ORDER", ...(pending?.owner_id === ownerId
        ? { id: pending.id, orderStatus: pending.status, expiresAt: pending.expiresAt } : {}) }, { status: 409, headers });
    }
    return Response.json({ status: "QUEUED", id: intent.id, expiresAt: intent.expiresAt }, { status: 202, headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}

export async function PATCH(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-order", "PATCH");

  try {
    const env = await context();
    if (!serviceAuthorized(request, env)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const raw = await request.text();
    if (raw.length > 2048) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const update = JSON.parse(raw);
    if (typeof update.id !== "string" || !/^[a-f0-9-]{36}$/.test(update.id)
      || !["RECEIVED", "REJECTED", "SUBMITTED", "NO_FILL"].includes(update.status)
      || typeof update.reason !== "string" || !/^[A-Z0-9_]{1,96}$/.test(update.reason))
      return Response.json({ status: "INVALID_UPDATE" }, { status: 400, headers });
    const row = await receiptRow(env.DB, update.id);
    if (!row) return Response.json({ status: "NOT_FOUND" }, { status: 404, headers });
    const proof = update.status === "SUBMITTED"
      ? manualExecutionEvidence(await executionSnapshot(env.DB), JSON.parse(row.payload)) : null;
    const repair = proof && row.status !== "SUBMITTED" && !["QUEUED", "RECEIVED"].includes(row.status);
    const result = await env.DB.prepare(`UPDATE smc_manual_orders SET status=?,result=?,updated_at=?
      WHERE id=? AND (status IN ('QUEUED','RECEIVED') OR (status=? AND ?=1))`)
      .bind(update.status, JSON.stringify({ reason: update.reason, at: Date.now(), ...(proof ?? {}),
        ...(repair ? { previousReceipt: { status: row.status, result: row.result ? JSON.parse(row.result) : null } } : {}) }),
        Date.now(), update.id, row.status, repair ? 1 : 0).run();
    return Response.json({ status: result.meta.changes ? "SYNCED" : "UNCHANGED" }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
