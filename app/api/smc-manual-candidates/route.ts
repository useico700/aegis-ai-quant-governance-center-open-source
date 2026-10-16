import { publicApi } from "../../../lib/public-preview.mjs";
import policy from "../../../lib/smc-scan-policy.json";
import { safeEqual } from "../../../lib/s1-monitor.mjs";
import { sanitizeSmcScan } from "../../../lib/smc-scan-snapshot.mjs";
import { unpackSmcSnapshot } from "../../../lib/smc-snapshot-wire.mjs";
import { selectSmcOwnerDirection } from "../../../lib/smc-owner-direction.mjs";

import { sanitizeStructurePlans } from "../../../lib/smc-structure-plan.mjs";
import { planFamilyKey } from "../../../lib/smc-plan-lifecycle.mjs";

const headers = { "Cache-Control": "no-store" };
type Env = { DB: D1Database; S2_MONITOR_INGEST_TOKEN?: string };

async function context() {
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as Env;
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_manual_candidates (
    owner_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
    created_at INTEGER NOT NULL, auto_trading_enabled INTEGER NOT NULL DEFAULT 1,
    selection_mode TEXT NOT NULL DEFAULT 'MANUAL', selection_reason TEXT,
    PRIMARY KEY(owner_id,symbol,direction)
  )`).run();
  const columns = await runtime.DB.prepare("PRAGMA table_info(smc_manual_candidates)").all();
  if (!columns.results.some(row => (row as { name?: string }).name === "auto_trading_enabled")) {
    await runtime.DB.prepare("ALTER TABLE smc_manual_candidates ADD COLUMN auto_trading_enabled INTEGER NOT NULL DEFAULT 1").run();
  }
  if (!columns.results.some(row => (row as { name?: string }).name === "selection_mode")) {
    await runtime.DB.prepare("ALTER TABLE smc_manual_candidates ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'MANUAL'").run();
  }
  if (!columns.results.some(row => (row as { name?: string }).name === "selection_reason")) {
    await runtime.DB.prepare("ALTER TABLE smc_manual_candidates ADD COLUMN selection_reason TEXT").run();
  }
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_conditional_dismissals (
    owner_id TEXT NOT NULL, symbol TEXT NOT NULL, dismissed_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,symbol)
  )`).run();
  await runtime.DB.prepare(`CREATE TABLE IF NOT EXISTS smc_plan_dismissals (
    owner_id TEXT NOT NULL, plan_key TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL, dismissed_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,plan_key)
  )`).run();
  return runtime;
}

function owner(request: Request, mutation: boolean) {
  const id = request.headers.get("oai-authenticated-user-id");
  if (!id) return null;
  if (mutation && (request.headers.get("origin") !== new URL(request.url).origin
    || request.headers.get("sec-fetch-site") === "cross-site")) return null;
  return id;
}

function scope(raw: unknown, allowAuto = false) {
  const row = raw as { symbol?: string; direction?: string };
  if (!policy.universe.includes(row?.symbol ?? "") || !["LONG", "SHORT", ...(allowAuto ? ["AUTO"] : [])].includes(row?.direction ?? "")) throw new Error("SMC_MANUAL_CANDIDATE_SCOPE");
  return { symbol: row.symbol!, direction: row.direction! };
}

async function automaticDirection(DB: D1Database, symbol: string) {
  const row = await DB.prepare("SELECT payload FROM smc_scan_snapshots WHERE id='SMC'").first<{ payload: string }>();
  if (!row) throw new Error("SMC_AUTO_DIRECTION_SCAN_MISSING");
  return selectSmcOwnerDirection(sanitizeSmcScan(unpackSmcSnapshot(JSON.parse(row.payload))), symbol);
}

const candidateProjection = (row: Record<string, unknown>) => ({ ...row,
  autoTradingEnabled: Number(row.autoTradingEnabled) === 1,
  selectionMode: row.selectionMode === "AUTO" ? "AUTO" : "MANUAL",
  selectionReason: typeof row.selectionReason === "string" ? row.selectionReason : null,
});

export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-candidates", "GET");

  try {
    if (new URL(request.url).searchParams.get("service") === "1") {
      const { env } = await import("cloudflare:workers");
      const token = (env as unknown as Env).S2_MONITOR_INGEST_TOKEN ?? "";
      const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (token.length < 32 || !safeEqual(token, supplied)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
      const { DB } = await context();
      const rows = await DB.prepare("SELECT symbol,direction,MAX(created_at) AS createdAt,MAX(auto_trading_enabled) AS autoTradingEnabled,MAX(selection_mode) AS selectionMode,MAX(selection_reason) AS selectionReason FROM smc_manual_candidates GROUP BY symbol,direction ORDER BY createdAt DESC LIMIT 20").all();
      return Response.json({ status: "OK", candidates: rows.results.map(row => candidateProjection(row as Record<string, unknown>)) }, { headers });
    }
    const id = owner(request, false);
    if (!id) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const { DB } = await context();
    const rows = await DB.prepare("SELECT symbol,direction,created_at AS createdAt,auto_trading_enabled AS autoTradingEnabled,selection_mode AS selectionMode,selection_reason AS selectionReason FROM smc_manual_candidates WHERE owner_id=? ORDER BY created_at DESC LIMIT 20")
      .bind(id).all();
    const dismissed = await DB.prepare("SELECT plan_key FROM smc_plan_dismissals WHERE owner_id=? ORDER BY dismissed_at DESC LIMIT 200")
      .bind(id).all<{ plan_key: string }>();
    return Response.json({ status: "OK", candidates: rows.results.map(row => candidateProjection(row as Record<string, unknown>)),
      dismissedConditionalSymbols: [], dismissedConditionalPlanKeys: dismissed.results.map(row => row.plan_key) }, { headers });
  } catch { return Response.json({ status: "UNAVAILABLE" }, { status: 503, headers }); }
}

export async function PATCH(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-candidates", "PATCH");

  try {
    const id = owner(request, true);
    if (!id) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    if (body.length > 256) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const raw = JSON.parse(body) as { symbol?: string; direction?: string; autoTradingEnabled?: unknown };
    const { symbol, direction } = scope(raw);
    if (typeof raw.autoTradingEnabled !== "boolean") throw new Error("SMC_OWNER_AUTO_TOGGLE_INVALID");
    const { DB } = await context();
    const result = await DB.prepare("UPDATE smc_manual_candidates SET auto_trading_enabled=? WHERE owner_id=? AND symbol=? AND direction=?")
      .bind(raw.autoTradingEnabled ? 1 : 0, id, symbol, direction).run();
    if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ status: "NOT_FOUND" }, { status: 404, headers });
    return Response.json({ status: "UPDATED", symbol, direction, autoTradingEnabled: raw.autoTradingEnabled }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-candidates", "POST");

  try {
    const id = owner(request, true);
    if (!id) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    if (body.length > 256) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const requested = scope(JSON.parse(body), true);
    const { DB } = await context();
    const selected = requested.direction === "AUTO" ? await automaticDirection(DB, requested.symbol) : null;
    const symbol = requested.symbol, direction = selected?.direction ?? requested.direction;
    const selectionMode = selected ? "AUTO" : "MANUAL", selectionReason = selected?.reason ?? null;
    await DB.batch([
      DB.prepare("INSERT OR IGNORE INTO smc_manual_candidates (owner_id,symbol,direction,created_at,selection_mode,selection_reason) VALUES (?,?,?,?,?,?)")
        .bind(id, symbol, direction, Date.now(), selectionMode, selectionReason),
      DB.prepare("DELETE FROM smc_plan_dismissals WHERE owner_id=? AND symbol=? AND direction=?").bind(id, symbol, direction),
    ]);
    return Response.json({ status: "SAVED", symbol, direction, selectionMode, selectionReason,
      directionBasis: selected?.basis ?? "OWNER_EXPLICIT", directionScore: selected?.score ?? null }, { headers });
  } catch (error) {
    const reason = error instanceof Error && /^SMC_AUTO_DIRECTION_/.test(error.message) ? error.message : "REJECTED";
    return Response.json({ status: reason === "REJECTED" ? "REJECTED" : "DIRECTION_UNAVAILABLE", reason }, { status: reason === "REJECTED" ? 400 : 409, headers });
  }
}

export async function DELETE(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-manual-candidates", "DELETE");

  try {
    const id = owner(request, true);
    if (!id) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    const body = await request.text();
    if (body.length > 256) return Response.json({ status: "TOO_LARGE" }, { status: 413, headers });
    const raw = JSON.parse(body) as { dismissConditionalPlans?: unknown; planKey?: unknown };
    const { symbol, direction } = scope(raw);
    if (raw.dismissConditionalPlans != null && typeof raw.dismissConditionalPlans !== "boolean") throw new Error("SMC_DISMISS_INVALID");
    const { DB } = await context();
    const statements = [DB.prepare("DELETE FROM smc_manual_candidates WHERE owner_id=? AND symbol=? AND direction=?")
      .bind(id, symbol, direction)];
    let dismissedPlanKey: string | null = null;
    if (raw.dismissConditionalPlans === true && raw.planKey != null) {
      if(typeof raw.planKey !== "string" || raw.planKey.length > 160) throw new Error("SMC_DISMISS_SCOPE");
      const snapshot = await DB.prepare("SELECT payload FROM smc_scan_snapshots WHERE id='SMC'").first<{ payload: string }>();
      const plans = snapshot ? unpackSmcSnapshot(JSON.parse(snapshot.payload)).results.filter((r: {symbol:string})=>r.symbol===symbol).flatMap((r: {structurePlans?: unknown[]}) => sanitizeStructurePlans(r.structurePlans ?? [],symbol,Date.now())) : [];
      const plan = plans.find((p: {symbol:string;direction:string}) => p.symbol===symbol && p.direction===direction && planFamilyKey(p)===raw.planKey);
      if(!plan) return Response.json({status:"PLAN_CHANGED_REFRESH"},{status:409,headers});
      dismissedPlanKey = raw.planKey;
      statements.push(DB.prepare("INSERT INTO smc_plan_dismissals (owner_id,plan_key,symbol,direction,dismissed_at) VALUES (?,?,?,?,?) ON CONFLICT(owner_id,plan_key) DO UPDATE SET dismissed_at=excluded.dismissed_at")
        .bind(id,dismissedPlanKey,symbol,direction,Date.now()));
    }
    await DB.batch(statements);
    return Response.json({ status: "REMOVED", symbol, direction, conditionalPlansDismissed: dismissedPlanKey !== null, dismissedPlanKey }, { headers });
  } catch { return Response.json({ status: "REJECTED" }, { status: 400, headers }); }
}
