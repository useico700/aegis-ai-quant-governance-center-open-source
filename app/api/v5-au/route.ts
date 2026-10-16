import { publicApi } from "../../../lib/public-preview.mjs";
import bootstrapSnapshot from "../../v5-au/bootstrap-snapshot.json";

const SNAPSHOT_ID = "orion-v5-au-monitor-latest";
const headers = { "Cache-Control": "no-store" };
type RuntimeEnv = { DB: D1Database; V5_AU_MONITOR_INGEST_TOKEN?: string };
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const shortText = (value: unknown, fallback = "") => typeof value === "string" ? value.slice(0, 160) : fallback;
const nullableText = (value: unknown) => typeof value === "string" && value ? value.slice(0, 160) : null;
function safeEqual(left: string, right: string) { if (!left || left.length !== right.length) return false; let mismatch = 0; for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index); return mismatch === 0; }

function sanitizeSnapshot(input: Record<string, unknown>) {
  const sourceAsOf = shortText(input.sourceAsOf);
  if (!sourceAsOf || !Number.isFinite(Date.parse(sourceAsOf))) throw new Error("INVALID_SOURCE_TIME");
  const connection = (input.connection ?? {}) as Record<string, unknown>;
  const market = (input.market ?? {}) as Record<string, unknown>;
  const account = (input.account ?? {}) as Record<string, unknown>;
  const risk = (input.risk ?? {}) as Record<string, unknown>;
  const roll = (input.roll ?? {}) as Record<string, unknown>;
  const fees = (input.fees ?? {}) as Record<string, unknown>;
  const partial = (input.partialPlan ?? {}) as Record<string, unknown>;
  const system = (input.system ?? {}) as Record<string, unknown>;
  const lots = (value: unknown) => (Array.isArray(value) ? value : []).slice(0, 4).map((row) => Math.max(0, Math.floor(finite(row))));
  const rows = (value: unknown, maximum: number) => (Array.isArray(value) ? value : []).slice(0, maximum) as Record<string, unknown>[];
  const instrument = (value: unknown) => /^au\d{4}$/i.test(shortText(value)) ? shortText(value).toLowerCase() : null;
  const positions = rows(input.positions, 4).map((row) => ({ id: shortText(row.id), instrumentId: instrument(row.instrumentId), side: row.side === "SHORT" ? "SHORT" : "LONG", lots: Math.max(0, Math.floor(finite(row.lots))), entryPrice: finite(row.entryPrice), markPrice: finite(row.markPrice), stopPrice: finite(row.stopPrice), stage: shortText(row.stage, "OPEN"), tradingDay: shortText(row.tradingDay), unrealizedPnlCny: finite(row.unrealizedPnlCny), marginCny: finite(row.marginCny) }));
  const candidates = rows(input.candidates, 12).map((row) => ({ id: shortText(row.id), instrumentId: instrument(row.instrumentId), side: row.side === "SHORT" ? "SHORT" : "LONG", status: shortText(row.status, "WATCHING"), intersectionTime: shortText(row.intersectionTime), intersectionPrice: finite(row.intersectionPrice), confirmation: shortText(row.confirmation), reason: shortText(row.reason) }));
  const fills = rows(input.fills, 20).map((row) => ({ id: shortText(row.id), instrumentId: instrument(row.instrumentId), side: row.side === "SHORT" ? "SHORT" : "LONG", action: shortText(row.action), lots: Math.max(0, Math.floor(finite(row.lots))), price: finite(row.price), feeCny: finite(row.feeCny), slippageCny: finite(row.slippageCny), exchangeTimestamp: shortText(row.exchangeTimestamp), localReceivedAt: shortText(row.localReceivedAt), reason: shortText(row.reason) }));
  return {
    schemaVersion: 1,
    runtimeId: "ORION-V5-AU-CTP-PAPER",
    sourceAsOf,
    status: shortText(input.status, "WAITING_CTP_CONFIGURATION_NOT_STARTED"),
    connection: { status: shortText(connection.status, "WAITING_CTP_CONFIGURATION"), lastForwardTickAt: nullableText(connection.lastForwardTickAt), lastExecutableBboAt: nullableText(connection.lastExecutableBboAt), evidence: "FORWARD_CTP_TICK_AND_BBO_ONLY_FOR_GATE1_PLUS" },
    market: { exchange: "SHFE", product: "AU", currentInstrumentId: nullableText(market.currentInstrumentId), tradingDay: nullableText(market.tradingDay), actionDay: nullableText(market.actionDay), session: shortText(market.session, "CLOSED_WAITING_CALENDAR"), bidPrice1: market.bidPrice1 == null ? null : finite(market.bidPrice1), bidVolume1: market.bidVolume1 == null ? null : finite(market.bidVolume1), askPrice1: market.askPrice1 == null ? null : finite(market.askPrice1), askVolume1: market.askVolume1 == null ? null : finite(market.askVolume1) },
    account: { currency: "CNY", initialCapitalCny: finite(account.initialCapitalCny, 500000), equityCny: finite(account.equityCny, 500000), availableCny: finite(account.availableCny, 500000), marginUsedCny: finite(account.marginUsedCny), realizedPnlCny: finite(account.realizedPnlCny), unrealizedPnlCny: finite(account.unrealizedPnlCny), feesCny: finite(account.feesCny) },
    risk: { maximumRiskPerEntryFraction: 0.01, maximumManagedPortfolioRiskFraction: 0.05, riskSizingUtilizationFraction: 0.98, maximumEffectiveNotionalLeverage: 4, managedRiskCny: finite(risk.managedRiskCny), effectiveNotionalCny: finite(risk.effectiveNotionalCny), openPositionCount: Math.max(0, Math.floor(finite(risk.openPositionCount))), entriesBlocked: risk.entriesBlocked !== false, blockReason: shortText(risk.blockReason, "WAITING_CTP_CONFIGURATION") },
    roll: { status: shortText(roll.status, "WAITING_CAUSAL_OBSERVATIONS"), currentInstrumentId: nullableText(roll.currentInstrumentId), pendingInstrumentId: nullableText(roll.pendingInstrumentId) },
    positions, candidates, fills,
    fees: { totalCny: finite(fees.totalCny), openCny: finite(fees.openCny), closeTodayCny: finite(fees.closeTodayCny), closeYesterdayCny: finite(fees.closeYesterdayCny), brokerSurchargeCny: finite(fees.brokerSurchargeCny) },
    partialPlan: { originalLots: Math.max(0, Math.floor(finite(partial.originalLots))), stageLots: lots(partial.stageLots), cumulativeLots: lots(partial.cumulativeLots), deferredStages: lots(partial.deferredStages) },
    system: { refreshSeconds: 30, residentProcessStarted: system.residentProcessStarted === true, paperOrderCount: Math.max(0, Math.floor(finite(system.paperOrderCount))), realOrderCount: 0, strictExchangeTotalOrderClaimed: false, localReceiveOrderOnly: true, lastReceiveSequence: Math.max(0, Math.floor(finite(system.lastReceiveSequence))), integrityReasons: (Array.isArray(system.integrityReasons) ? system.integrityReasons : []).slice(0, 8).map((value) => shortText(value)) },
  };
}

async function runtimeEnv(): Promise<RuntimeEnv> { const { env } = await import("cloudflare:workers"); return env as unknown as RuntimeEnv; }
async function ensureTable(db: D1Database) { await db.prepare(`CREATE TABLE IF NOT EXISTS v5_au_monitor_snapshots (id TEXT PRIMARY KEY NOT NULL, source_as_of TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run(); }

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v5-au", "GET");

  try {
    const { DB } = await runtimeEnv(); await ensureTable(DB);
    const row = await DB.prepare("SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt FROM v5_au_monitor_snapshots WHERE id = ?").bind(SNAPSHOT_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string }>();
    if (!row) return Response.json({ status: "BOOTSTRAP_SNAPSHOT", sourceAsOf: bootstrapSnapshot.sourceAsOf, receivedAt: bootstrapSnapshot.sourceAsOf, snapshot: sanitizeSnapshot(bootstrapSnapshot as unknown as Record<string, unknown>) }, { headers });
    return Response.json({ status: "OK", sourceAsOf: row.sourceAsOf, receivedAt: row.receivedAt, snapshot: JSON.parse(row.payload) }, { headers });
  } catch (error) { return Response.json({ status: "UNAVAILABLE", error: error instanceof Error ? error.message : "V5 AU monitor unavailable" }, { status: 503, headers }); }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v5-au", "POST");

  try {
    const { DB, V5_AU_MONITOR_INGEST_TOKEN = "" } = await runtimeEnv();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (V5_AU_MONITOR_INGEST_TOKEN.length < 32 || !safeEqual(supplied, V5_AU_MONITOR_INGEST_TOKEN)) return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers });
    if (Number(request.headers.get("content-length") ?? 0) > 250000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers });
    const snapshot = sanitizeSnapshot(await request.json() as Record<string, unknown>); const payload = JSON.stringify(snapshot);
    if (payload.length > 250000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers });
    await ensureTable(DB); const receivedAt = new Date().toISOString();
    await DB.prepare(`INSERT INTO v5_au_monitor_snapshots (id, source_as_of, payload, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_as_of = excluded.source_as_of, payload = excluded.payload, received_at = excluded.received_at`).bind(SNAPSHOT_ID, snapshot.sourceAsOf, payload, receivedAt).run();
    return Response.json({ status: "SYNCED", sourceAsOf: snapshot.sourceAsOf, receivedAt }, { headers });
  } catch (error) { return Response.json({ status: "REJECTED", error: error instanceof Error ? error.message : "INVALID_SNAPSHOT" }, { status: 400, headers }); }
}
