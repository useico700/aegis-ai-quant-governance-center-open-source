import { publicApi } from "../../../lib/public-preview.mjs";
import bootstrapSnapshot from "../../v4-monitor/bootstrap-snapshot.json";

const SNAPSHOT_ID = "orion-v4-monitor-latest";
const jsonHeaders = { "Cache-Control": "no-store" };

type RuntimeEnv = { DB: D1Database; V4_MONITOR_INGEST_TOKEN?: string };
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value.slice(0, 180) : fallback;
function safeEqual(left: string, right: string) { if (!left || left.length !== right.length) return false; let mismatch = 0; for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index); return mismatch === 0; }

function sanitizeCampaign(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  return { active: row.active === true, tier: text(row.tier, "IDLE"), highWaterPnlUsdt: finite(row.highWaterPnlUsdt), freezeUntil: row.freezeUntil == null ? null : finite(row.freezeUntil) };
}

function sanitizeAbnormalLossGate(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  const trigger = (row.activeTrigger ?? {}) as Record<string, unknown>;
  const status = ["CLEAR", "YELLOW", "ORANGE", "RED"].includes(text(row.status)) ? text(row.status) : "UNKNOWN";
  return {
    status,
    entriesBlocked: row.entriesBlocked === true,
    manualResetRequired: row.manualResetRequired === true,
    orangeHealthyCycles: finite(row.orangeHealthyCycles),
    orangeHealthyCyclesRequired: finite(row.orangeHealthyCyclesRequired, 3),
    activeTrigger: row.activeTrigger ? { symbol: text(trigger.symbol, "—"), plannedMaximumLossUsdt: finite(trigger.plannedMaximumLossUsdt), actualLossUsdt: finite(trigger.actualLossUsdt), actualLossR: trigger.actualLossR == null ? null : finite(trigger.actualLossR), excessLossUsdt: finite(trigger.excessLossUsdt), trigger: text(trigger.trigger) } : null,
  };
}

function sanitizeSnapshot(input: Record<string, unknown>) {
  const account = (input.account ?? {}) as Record<string, unknown>;
  const risk = (input.risk ?? {}) as Record<string, unknown>;
  const execution = (input.execution ?? {}) as Record<string, unknown>;
  const system = (input.system ?? {}) as Record<string, unknown>;
  const protection = (input.r21ProfitProtection ?? {}) as Record<string, unknown>;
  const campaigns = (protection.campaigns ?? {}) as Record<string, unknown>;
  const sourceAsOf = text(input.sourceAsOf);
  if (!sourceAsOf || !Number.isFinite(Date.parse(sourceAsOf))) throw new Error("INVALID_SOURCE_TIME");
  const positions = Array.isArray(input.positions) ? input.positions : [];
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const settlements = Array.isArray(input.settlements) ? input.settlements : [];
  return {
    schemaVersion: 1,
    runtimeId: text(input.runtimeId, "ORION-V4-MTFX-R22-MONITOR-1.0"),
    sourceAsOf,
    strategyDisplayName: text(input.strategyDisplayName, "V4 MTFX · R22"),
    implementationRevision: text(input.implementationRevision),
    evaluationCohortId: text(input.evaluationCohortId),
    baselineUsdt: finite(input.baselineUsdt, 5_000),
    account: { walletBalanceUsdt: finite(account.walletBalanceUsdt), marginEquityUsdt: finite(account.marginEquityUsdt), availableBalanceUsdt: finite(account.availableBalanceUsdt), unrealizedPnlUsdt: finite(account.unrealizedPnlUsdt) },
    risk: { maximumRiskPerEntryFraction: finite(risk.maximumRiskPerEntryFraction), maximumPortfolioRiskFraction: finite(risk.maximumPortfolioRiskFraction), maximumOpenPositionsTotal: finite(risk.maximumOpenPositionsTotal), maximumEffectiveNotionalLeverage: finite(risk.maximumEffectiveNotionalLeverage), actualEffectiveNotionalLeverage: finite(risk.actualEffectiveNotionalLeverage), openPositionCount: finite(risk.openPositionCount), protectedPositionCount: finite(risk.protectedPositionCount) },
    execution: {
      status: text(execution.status, "UNKNOWN"),
      accountReconciliationStatus: text(execution.accountReconciliationStatus, text(execution.status, "UNKNOWN")),
      engineStatus: text(execution.engineStatus, "UNKNOWN"),
      engineLastError: text(execution.engineLastError),
      automaticCycleAt: text(execution.automaticCycleAt),
      causalBboStatus: text(execution.causalBboStatus, "UNKNOWN"),
      causalBboAgeMs: execution.causalBboAgeMs == null ? null : finite(execution.causalBboAgeMs),
      degraded: execution.degraded === true,
      pendingOperationCount: finite(execution.pendingOperationCount),
      standardOpenOrderCount: finite(execution.standardOpenOrderCount),
      activeAlgoOrderCount: finite(execution.activeAlgoOrderCount),
    },
    abnormalLossGate: sanitizeAbnormalLossGate(input.abnormalLossGate),
    system: { planCount: finite(system.planCount), economicPrequalifiedCount: finite(system.economicPrequalifiedCount), confirmedSignalCount: finite(system.confirmedSignalCount), broadUniverseSize: finite(system.broadUniverseSize), scanIntervalMs: finite(system.scanIntervalMs, 60_000) },
    r21ProfitProtection: {
      minimumSameDirectionPositions: finite(protection.minimumSameDirectionPositions, 3),
      eligibleSymbols: (Array.isArray(protection.eligibleSymbols) ? protection.eligibleSymbols : []).slice(0, 20).map((value) => text(value)),
      excludedSymbols: (Array.isArray(protection.excludedSymbols) ? protection.excludedSymbols : []).slice(0, 20).map((value) => text(value)),
      freezeEligibleEntries: protection.freezeEligibleEntries === true,
      frozenDirections: (Array.isArray(protection.frozenDirections) ? protection.frozenDirections : []).slice(0, 2).map((value) => text(value)),
      lastEvaluatedAt: finite(protection.lastEvaluatedAt),
      campaigns: { LONG: sanitizeCampaign(campaigns.LONG), SHORT: sanitizeCampaign(campaigns.SHORT) },
    },
    positions: positions.slice(0, 10).map((value) => { const row = value as Record<string, unknown>; return { symbol: text(row.symbol, "—"), side: row.side === "SHORT" ? "SHORT" : "LONG", entryPrice: finite(row.entryPrice), markPrice: finite(row.markPrice), unrealizedPnlUsdt: finite(row.unrealizedPnlUsdt), leverage: finite(row.leverage), stopPrice: finite(row.stopPrice), stage: text(row.stage, "OPEN"), openedAt: finite(row.openedAt), protected: row.protected === true, ...(finite(row.plannedMaximumLossUsdt) > 0 ? { plannedMaximumLossUsdt: finite(row.plannedMaximumLossUsdt), redLossThresholdUsdt: finite(row.redLossThresholdUsdt) } : {}) }; }),
    candidates: candidates.slice(0, 10).map((value) => { const row = value as Record<string, unknown>; return { id: text(row.id), symbol: text(row.symbol, "—"), pattern: text(row.pattern, "—"), intersectionTime: finite(row.intersectionTime), intersectionPrice: finite(row.intersectionPrice), stabilityScore: Math.min(1, Math.max(0, finite(row.stabilityScore))), support: finite(row.support), signalStatus: text(row.signalStatus, "NO_SIGNAL"), economicPrequalified: row.economicPrequalified === true, assessmentReason: text(row.assessmentReason, "MTFX_INTERSECTION_PLAN_ACTIVE"), signalReason: text(row.signalReason, "CONFIRMATION_RESERVE_NOT_CLOSED"), committed: row.committed === true, anchorQualityScore: Math.min(1, Math.max(0, finite(row.anchorQualityScore))), fourHourHierarchyMultiplier: finite(row.fourHourHierarchyMultiplier), oneHourHierarchyMultiplier: finite(row.oneHourHierarchyMultiplier) }; }),
    settlements: settlements.slice(0, 12).map((value) => { const row = value as Record<string, unknown>; return { symbol: text(row.symbol, "—"), side: row.side === "SHORT" ? "SHORT" : "LONG", closedAt: finite(row.closedAt), netPnlUsdt: finite(row.netPnlUsdt), realizedR: row.realizedR == null ? null : finite(row.realizedR), reason: text(row.reason, "已结算") }; }),
  };
}

async function runtimeEnv(): Promise<RuntimeEnv> { const { env } = await import("cloudflare:workers"); return env as unknown as RuntimeEnv; }
async function ensureTable(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS v4_monitor_snapshots (id TEXT PRIMARY KEY NOT NULL, source_as_of TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS v4_monitor_history (source_as_of TEXT PRIMARY KEY NOT NULL, margin_equity_usdt REAL NOT NULL, wallet_balance_usdt REAL NOT NULL, unrealized_pnl_usdt REAL NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`),
  ]);
}

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v4-monitor", "GET");

  try {
    const { DB } = await runtimeEnv();
    await ensureTable(DB);
    const [row, historyResult] = await Promise.all([
      DB.prepare("SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt FROM v4_monitor_snapshots WHERE id = ?").bind(SNAPSHOT_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string }>(),
      DB.prepare("SELECT source_as_of AS sourceAsOf, margin_equity_usdt AS marginEquityUsdt, wallet_balance_usdt AS walletBalanceUsdt, unrealized_pnl_usdt AS unrealizedPnlUsdt FROM v4_monitor_history ORDER BY source_as_of DESC LIMIT 48").all<{ sourceAsOf: string; marginEquityUsdt: number; walletBalanceUsdt: number; unrealizedPnlUsdt: number }>(),
    ]);
    if (!row) return Response.json({ status: "BOOTSTRAP_SNAPSHOT", sourceAsOf: bootstrapSnapshot.sourceAsOf, receivedAt: bootstrapSnapshot.sourceAsOf, snapshot: sanitizeSnapshot(bootstrapSnapshot as unknown as Record<string, unknown>), history: [{ sourceAsOf: bootstrapSnapshot.sourceAsOf, marginEquityUsdt: bootstrapSnapshot.account.marginEquityUsdt, walletBalanceUsdt: bootstrapSnapshot.account.walletBalanceUsdt, unrealizedPnlUsdt: bootstrapSnapshot.account.unrealizedPnlUsdt }] }, { headers: jsonHeaders });
    return Response.json({ status: "OK", sourceAsOf: row.sourceAsOf, receivedAt: row.receivedAt, snapshot: JSON.parse(row.payload), history: [...(historyResult.results ?? [])].reverse() }, { headers: jsonHeaders });
  } catch (error) {
    return Response.json({ status: "UNAVAILABLE", error: error instanceof Error ? error.message : "V4 monitor unavailable" }, { status: 503, headers: jsonHeaders });
  }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v4-monitor", "POST");

  try {
    const { DB, V4_MONITOR_INGEST_TOKEN = "" } = await runtimeEnv();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (V4_MONITOR_INGEST_TOKEN.length < 32 || !safeEqual(supplied, V4_MONITOR_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers: jsonHeaders });
    if (Number(request.headers.get("content-length") ?? 0) > 350_000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers: jsonHeaders });
    const snapshot = sanitizeSnapshot(await request.json() as Record<string, unknown>);
    const payload = JSON.stringify(snapshot);
    if (payload.length > 350_000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers: jsonHeaders });
    await ensureTable(DB);
    const receivedAt = new Date().toISOString();
    await DB.batch([
      DB.prepare(`INSERT INTO v4_monitor_snapshots (id, source_as_of, payload, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_as_of = excluded.source_as_of, payload = excluded.payload, received_at = excluded.received_at`).bind(SNAPSHOT_ID, snapshot.sourceAsOf, payload, receivedAt),
      DB.prepare(`INSERT INTO v4_monitor_history (source_as_of, margin_equity_usdt, wallet_balance_usdt, unrealized_pnl_usdt, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_as_of) DO UPDATE SET margin_equity_usdt = excluded.margin_equity_usdt, wallet_balance_usdt = excluded.wallet_balance_usdt, unrealized_pnl_usdt = excluded.unrealized_pnl_usdt, received_at = excluded.received_at`).bind(snapshot.sourceAsOf, snapshot.account.marginEquityUsdt, snapshot.account.walletBalanceUsdt, snapshot.account.unrealizedPnlUsdt, receivedAt),
      DB.prepare(`DELETE FROM v4_monitor_history WHERE source_as_of NOT IN (SELECT source_as_of FROM v4_monitor_history ORDER BY source_as_of DESC LIMIT 240)`),
    ]);
    return Response.json({ status: "SYNCED", sourceAsOf: snapshot.sourceAsOf, receivedAt }, { headers: jsonHeaders });
  } catch (error) {
    return Response.json({ status: "REJECTED", error: error instanceof Error ? error.message : "INVALID_SNAPSHOT" }, { status: 400, headers: jsonHeaders });
  }
}
