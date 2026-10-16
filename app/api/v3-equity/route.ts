import { publicApi } from "../../../lib/public-preview.mjs";
import { currentCandidateView } from "../../v3-equity/execution-view.mjs";
import bootstrapSnapshot from "../../v3-equity/bootstrap-snapshot.json";

const SNAPSHOT_ID = "orion-v3-equity-latest";

type RuntimeEnv = {
  DB: D1Database;
  V3_EQUITY_INGEST_TOKEN?: string;
};

const jsonHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
};

function finite(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.slice(0, 180) : fallback;
}

function nullableAmount(value: unknown) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e12 ? number : null;
}

function sanitizeSettlementEvidence(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  const allowedReasons = ["MISSING_SETTLEMENT_TIME", "MISSING_SETTLEMENT_AMOUNT", "MISSING_COMPLETED_TRADE_AMOUNT", "CLOSED_TRADE_SETTLEMENTS_DO_NOT_RECONCILE", "OPEN_PARTIAL_SETTLEMENTS_DO_NOT_RECONCILE", "ACCOUNTING_TOTAL_NOT_FULLY_ATTRIBUTED", "INVALID_SETTLEMENT_EVIDENCE"];
  const suppliedReasons = Array.isArray(row.reasons) ? row.reasons : [];
  const reasons = [...new Set(suppliedReasons.filter((reason): reason is string => typeof reason === "string" && allowedReasons.includes(reason)))];
  const count = (input: unknown) => typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 1_000_000 ? input : null;
  const unlocatedSettlementCount = count(row.unlocatedSettlementCount);
  const partialCount = count(row.unlocatedPartialCount);
  const unlocatedPartialCount = partialCount !== null && unlocatedSettlementCount !== null && partialCount <= unlocatedSettlementCount ? partialCount : null;
  const unlocatedNetPnlUsdt = nullableAmount(row.unlocatedNetPnlUsdt);
  const accountingResidualUsdt = nullableAmount(row.accountingResidualUsdt);
  const valid = suppliedReasons.length === reasons.length && unlocatedSettlementCount !== null && unlocatedPartialCount !== null && unlocatedNetPnlUsdt !== null && accountingResidualUsdt !== null;
  const complete = row.status === "COMPLETE" && valid && reasons.length === 0 && unlocatedSettlementCount === 0 && unlocatedNetPnlUsdt !== null && Math.abs(unlocatedNetPnlUsdt) <= 1e-8 && accountingResidualUsdt !== null && Math.abs(accountingResidualUsdt) <= 1e-8 && row.drawdownEligible === true;
  if (row.status === "COMPLETE" && !complete) reasons.push("INVALID_SETTLEMENT_EVIDENCE");
  return {
    status: complete ? "COMPLETE" : row.status === "COMPLETE" || row.status === "INCOMPLETE_SETTLEMENT_EVIDENCE" ? "INCOMPLETE_SETTLEMENT_EVIDENCE" : "UNKNOWN",
    reasons: [...new Set(reasons)],
    unlocatedSettlementCount,
    unlocatedPartialCount,
    unlocatedNetPnlUsdt,
    accountingResidualUsdt,
    drawdownEligible: complete,
  };
}

function safeEqual(left: string, right: string) {
  if (!left || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
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
    activeTrigger: row.activeTrigger ? {
      symbol: text(trigger.symbol, "—"),
      plannedMaximumLossUsdt: finite(trigger.plannedMaximumLossUsdt),
      actualLossUsdt: finite(trigger.actualLossUsdt),
      actualLossR: trigger.actualLossR == null ? null : finite(trigger.actualLossR),
      excessLossUsdt: finite(trigger.excessLossUsdt),
      trigger: text(trigger.trigger),
    } : null,
  };
}

function sanitizeCostGateShadow(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  const rule = (row.rule ?? {}) as Record<string, unknown>;
  const sample = (row.sample ?? {}) as Record<string, unknown>;
  const outcomes = (row.outcomes ?? {}) as Record<string, unknown>;
  const phaseB = (row.phaseB ?? {}) as Record<string, unknown>;
  const records = Array.isArray(row.records) ? row.records : [];
  const nullableFinite = (input: unknown) => input == null || !Number.isFinite(Number(input)) ? null : Number(input);
  return {
    schemaVersion: 1,
    experimentId: text(row.experimentId),
    displayName: text(row.displayName, "HF12-A · 完整成本闸门影子测试"),
    status: row.status === "ACTIVE_OBSERVE_ONLY" ? "ACTIVE_OBSERVE_ONLY" : "INACTIVE",
    mode: text(row.mode),
    prospectiveStart: text(row.prospectiveStart),
    sourceImplementationRevision: text(row.sourceImplementationRevision),
    rule: {
      maximumCompleteLifecycleCostR: finite(rule.maximumCompleteLifecycleCostR, 0.12),
      takerFeeRate: finite(rule.takerFeeRate),
      adverseSlippageRate: finite(rule.adverseSlippageRate),
      formula: text(rule.formula),
    },
    sample: {
      observedEntryCount: finite(sample.observedEntryCount),
      eligibleEntryCount: finite(sample.eligibleEntryCount),
      passEntryCount: finite(sample.passEntryCount),
      rejectEntryCount: finite(sample.rejectEntryCount),
      excludedEntryCount: finite(sample.excludedEntryCount),
      openEntryCount: finite(sample.openEntryCount),
      attributableClosedCount: finite(sample.attributableClosedCount),
      passClosedCount: finite(sample.passClosedCount),
      rejectClosedCount: finite(sample.rejectClosedCount),
      minimumAttributableClosedPositions: finite(sample.minimumAttributableClosedPositions, 100),
      progressFraction: Math.max(0, Math.min(1, finite(sample.progressFraction))),
      readyForReview: sample.readyForReview === true,
    },
    outcomes: {
      hf11ObservedNetPnlUsdt: finite(outcomes.hf11ObservedNetPnlUsdt),
      shadowAcceptedNetPnlUsdt: finite(outcomes.shadowAcceptedNetPnlUsdt),
      shadowRejectedObservedNetPnlUsdt: finite(outcomes.shadowRejectedObservedNetPnlUsdt),
      hf11ObservedCommissionUsdt: finite(outcomes.hf11ObservedCommissionUsdt),
      shadowAcceptedCommissionUsdt: finite(outcomes.shadowAcceptedCommissionUsdt),
      shadowRejectedObservedCommissionUsdt: finite(outcomes.shadowRejectedObservedCommissionUsdt),
      averageCompleteLifecycleCostR: nullableFinite(outcomes.averageCompleteLifecycleCostR),
    },
    records: records.slice(0, 60).map((value) => {
      const record = value as Record<string, unknown>;
      return {
        id: text(record.id),
        symbol: text(record.symbol, "—"),
        side: record.side === "SHORT" ? "SHORT" : "LONG",
        openedAt: finite(record.openedAt),
        closedAt: nullableFinite(record.closedAt),
        recordStatus: record.recordStatus === "CLOSED" ? "CLOSED" : "OPEN",
        classification: ["SHADOW_PASS", "SHADOW_REJECT", "EXCLUDED_MISSING_ENTRY_RISK_EVIDENCE"].includes(text(record.classification))
          ? text(record.classification)
          : "EXCLUDED_MISSING_ENTRY_RISK_EVIDENCE",
        completeLifecycleCostR: nullableFinite(record.completeLifecycleCostR),
        netPnlUsdt: nullableFinite(record.netPnlUsdt),
        commissionUsdt: nullableFinite(record.commissionUsdt),
      };
    }),
    phaseB: {
      experimentId: text(phaseB.experimentId),
      status: text(phaseB.status, "LOCKED_PENDING_HF12A_REVIEW_AND_OWNER_APPROVAL"),
      proposedMinimumConsensusSupport: finite(phaseB.proposedMinimumConsensusSupport, 2),
      recordingActive: phaseB.recordingActive === true,
    },
    baselineExecutionChanged: row.baselineExecutionChanged === true,
    ordersOrPositionsAffected: row.ordersOrPositionsAffected === true,
    automaticPromotionAllowed: row.automaticPromotionAllowed === true,
  };
}

function sanitizeDualZ(value: unknown, sourceAsOf: string) {
  const row = (value ?? {}) as Record<string, unknown>;
  const primaryInterval = row.primaryInterval === "1h" ? "1h" : null;
  const opposingInterval = row.opposingInterval === "15m" ? "15m" : null;
  const confirmedAt = typeof row.confirmedAt === "number" && Number.isFinite(row.confirmedAt)
    && row.confirmedAt > 0 && row.confirmedAt <= Date.parse(sourceAsOf) ? row.confirmedAt : null;
  const confirmed = row.schemaVersion === 1 && row.status === "CONFIRMED"
    && primaryInterval === "1h" && opposingInterval === "15m" && confirmedAt !== null;
  return {
    schemaVersion: 1,
    status: confirmed ? "CONFIRMED" : value == null || row.status === "MISSING" ? "MISSING" : "NOT_CONFIRMED",
    primaryInterval,
    opposingInterval,
    confirmedAt: confirmed ? confirmedAt : null,
  };
}

function sanitizeSingleZ(value: unknown, sourceAsOf: string) {
  const row = (value ?? {}) as Record<string, unknown>;
  const primaryInterval = row.primaryInterval === "1h" ? "1h" : null;
  const confirmedAt = typeof row.confirmedAt === "number" && Number.isFinite(row.confirmedAt)
    && row.confirmedAt > 0 && row.confirmedAt <= Date.parse(sourceAsOf) ? row.confirmedAt : null;
  const confirmed = row.schemaVersion === 1 && row.status === "CONFIRMED" && primaryInterval === "1h" && confirmedAt !== null;
  return { schemaVersion: 1, status: confirmed ? "CONFIRMED" : value == null || row.status === "MISSING" ? "MISSING" : "NOT_CONFIRMED",
    primaryInterval, confirmedAt: confirmed ? confirmedAt : null };
}

function sanitizeSnapshot(input: Record<string, unknown>) {
  const current = (input.current ?? {}) as Record<string, unknown>;
  const metrics = (input.metrics ?? {}) as Record<string, unknown>;
  const accountingBridge = (input.accountingBridge ?? {}) as Record<string, unknown>;
  const executionHealth = (input.executionHealth ?? {}) as Record<string, unknown>;
  const risk = (input.risk ?? {}) as Record<string, unknown>;
  const curve = (input.curve ?? {}) as Record<string, unknown>;
  const positions = Array.isArray(input.currentPositions) ? input.currentPositions : [];
  const candidates = Array.isArray(input.candidatePlans) ? input.candidatePlans : [];
  const cohorts = Array.isArray(input.cohorts) ? input.cohorts : [];
  const shadowStudies = (input.shadowStudies ?? {}) as Record<string, unknown>;
  const points = Array.isArray(curve.points) ? curve.points : [];
  const sourceAsOf = text(input.sourceAsOf);
  if (!sourceAsOf || !Number.isFinite(Date.parse(sourceAsOf))) throw new Error("INVALID_SOURCE_TIME");
  const implementationRevision = text(input.implementationRevision) || null;
  const inferredPositionLimit = implementationRevision && /HF(?:10|11|13|14)-/.test(implementationRevision) ? 18 : 10;
  const maximumOpenPositionsTotal = Math.min(18, Math.max(1, Math.trunc(finite(risk.maximumOpenPositionsTotal, inferredPositionLimit))));
  const settlementEvidence = sanitizeSettlementEvidence(metrics.settlementEvidence);
  return {
    schemaVersion: 1,
    runtimeId: text(input.runtimeId, "ORION-V3-EQUITY-LEARNING-CURVE-1.0"),
    sourceAsOf,
    accountObservedAt: text(input.accountObservedAt, sourceAsOf),
    strategyDisplayName: text(input.strategyDisplayName, "V3 高频交易"),
    implementationRevision,
    evaluationCohortId: text(input.evaluationCohortId) || null,
    baselineUsdt: finite(input.baselineUsdt, 5_000),
    current: {
      walletBalanceUsdt: finite(current.walletBalanceUsdt, finite(current.marginEquityUsdt) - finite(current.unrealizedPnlUsdt)),
      walletChangeUsdt: finite(current.walletChangeUsdt, finite(current.marginEquityUsdt) - finite(current.unrealizedPnlUsdt) - finite(input.baselineUsdt, 5_000)),
      unrealizedPnlUsdt: finite(current.unrealizedPnlUsdt),
      marginEquityUsdt: finite(current.marginEquityUsdt),
      realizedLearningEquityUsdt: finite(current.realizedLearningEquityUsdt),
    },
    metrics: {
      closedTradeCount: finite(metrics.closedTradeCount),
      partialSettlementCount: finite(metrics.partialSettlementCount),
      totalRealizedNetPnlUsdt: finite(metrics.totalRealizedNetPnlUsdt),
      maximumDrawdownUsdt: settlementEvidence.drawdownEligible ? nullableAmount(metrics.maximumDrawdownUsdt) : null,
      settlementEvidence,
    },
    risk: {
      maximumOpenPositionsTotal,
    },
    accountingBridge: {
      status: text(accountingBridge.status, "INCOME_HISTORY_NOT_REQUESTED"),
      incomeHistoryComplete: accountingBridge.incomeHistoryComplete === true,
      incomeHistoryRowCount: finite(accountingBridge.incomeHistoryRowCount),
      accountEquationDifferenceUsdt: finite(accountingBridge.accountEquationDifferenceUsdt),
      walletUnreconciledDifferenceUsdt: finite(accountingBridge.walletUnreconciledDifferenceUsdt),
      strategyLedgerCoverageDifferenceUsdt: finite(accountingBridge.strategyLedgerCoverageDifferenceUsdt),
      openPositionUnallocatedEntryCommissionUsdt: finite(accountingBridge.openPositionUnallocatedEntryCommissionUsdt),
      fundingFeeUsdt: finite(accountingBridge.fundingFeeUsdt),
    },
    executionHealth: {
      status: text(executionHealth.status, "MISSING"),
      errors: (Array.isArray(executionHealth.errors) ? executionHealth.errors : []).slice(0, 12).map((value) => text(value)).filter(Boolean),
      livePositionCount: finite(executionHealth.livePositionCount),
      managedPositionCount: finite(executionHealth.managedPositionCount),
      protectedPositionCount: finite(executionHealth.protectedPositionCount),
      pendingOperationCount: finite(executionHealth.pendingOperationCount),
      standardOpenOrderCount: finite(executionHealth.standardOpenOrderCount),
      activeAlgoOrderCount: finite(executionHealth.activeAlgoOrderCount),
    },
    abnormalLossGate: sanitizeAbnormalLossGate(input.abnormalLossGate),
    currentPositions: positions.slice(0, maximumOpenPositionsTotal).map((value) => {
      const row = value as Record<string, unknown>;
      return {
        symbol: text(row.symbol, "—"),
        side: row.side === "SHORT" ? "SHORT" : "LONG",
        entryPrice: finite(row.entryPrice),
        markPrice: finite(row.markPrice),
        unrealizedPnlUsdt: finite(row.unrealizedPnlUsdt),
        stage: text(row.stage, "OPEN"),
        managed: row.managed === true,
        protectionStatus: row.protectionStatus === "PROTECTED" ? "PROTECTED" : "UNPROTECTED",
        ...(finite(row.plannedMaximumLossUsdt) > 0 ? { plannedMaximumLossUsdt: finite(row.plannedMaximumLossUsdt), redLossThresholdUsdt: finite(row.redLossThresholdUsdt) } : {}),
      };
    }),
    cohorts: cohorts.slice(0, 6).map((value) => {
      const row = value as Record<string, unknown>;
      return {
        evaluationCohortId: text(row.evaluationCohortId) || null,
        classification: text(row.classification, "UNCLASSIFIED"),
        openPositionCount: finite(row.openPositionCount),
        closedTradeCount: finite(row.closedTradeCount),
        realizedNetPnlUsdt: finite(row.realizedNetPnlUsdt),
        totalCommissionUsdt: finite(row.totalCommissionUsdt),
      };
    }),
    shadowStudies: {
      costGate: sanitizeCostGateShadow(shadowStudies.costGate),
    },
    candidatePlans: candidates.slice(0, 12).map((value) => {
      const row = value as Record<string, unknown>;
      return {
        id: text(row.id),
        symbol: text(row.symbol, "—"),
        pattern: text(row.pattern, "—"),
        primaryLineStatus: text(row.primaryLineStatus, "—"),
        intersectionTime: finite(row.intersectionTime),
        intersectionPrice: finite(row.intersectionPrice),
        queuePosition: finite(row.queuePosition),
        queueSize: finite(row.queueSize),
        entryStatus: text(row.entryStatus, "WAITING_FOR_CROSS"),
        direction: [-1, 0, 1].includes(finite(row.direction)) ? finite(row.direction) : 0,
        automaticExecutionAllowed: row.automaticExecutionAllowed === true,
        ...(implementationRevision === "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE" ? {
          singleZ: sanitizeSingleZ(row.singleZ, sourceAsOf),
        } : implementationRevision === "MTFX-V3-HF13-DUAL-Z-STRUCTURE-GATE" ? {
          dualZ: sanitizeDualZ(row.dualZ, sourceAsOf),
        } : {}),
        stabilityScore: finite(row.stabilityScore),
        support: finite(row.support),
      };
    }),
    curve: {
      points: points.slice(-2_000).map((value) => {
        const row = value as Record<string, unknown>;
        return {
          id: text(row.id),
          timestamp: finite(row.timestamp),
          kind: ["BASELINE", "CLOSED_TRADE", "PARTIAL_EXIT"].includes(text(row.kind)) ? text(row.kind) : "CLOSED_TRADE",
          symbol: text(row.symbol, "—"),
          deltaUsdt: finite(row.deltaUsdt),
          realizedLearningEquityUsdt: finite(row.realizedLearningEquityUsdt),
        };
      }),
    },
  };
}

async function runtimeEnv(): Promise<RuntimeEnv> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as RuntimeEnv;
}

async function ensureTable(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS v3_equity_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      source_as_of TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v3-equity", "GET");

  try {
    const { DB } = await runtimeEnv();
    await ensureTable(DB);
    const row = await DB.prepare(
      "SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt FROM v3_equity_snapshots WHERE id = ?",
    ).bind(SNAPSHOT_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string }>();
    const snapshot = sanitizeSnapshot(row ? JSON.parse(row.payload) : bootstrapSnapshot as unknown as Record<string, unknown>);
    const status = row ? "OK" : "BOOTSTRAP_SNAPSHOT";
    const view = currentCandidateView(snapshot, Date.now(), status);
    return Response.json({
      status,
      sourceAsOf: snapshot.sourceAsOf,
      receivedAt: row?.receivedAt ?? snapshot.sourceAsOf,
      snapshot: { ...snapshot, candidatePlans: view.candidatePlans },
      candidateStatus: view.status,
    }, { headers: jsonHeaders });
  } catch (error) {
    return Response.json({ status: "UNAVAILABLE", error: error instanceof Error ? error.message : "V3 equity unavailable" }, {
      status: 503,
      headers: jsonHeaders,
    });
  }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("v3-equity", "POST");

  try {
    const { DB, V3_EQUITY_INGEST_TOKEN = "" } = await runtimeEnv();
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (V3_EQUITY_INGEST_TOKEN.length < 32 || !safeEqual(supplied, V3_EQUITY_INGEST_TOKEN)) {
      return Response.json({ status: "UNAUTHORIZED" }, { status: 401, headers: jsonHeaders });
    }
    const declaredSize = Number(request.headers.get("content-length") ?? 0);
    if (declaredSize > 500_000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers: jsonHeaders });
    const snapshot = sanitizeSnapshot(await request.json() as Record<string, unknown>);
    const payload = JSON.stringify(snapshot);
    if (payload.length > 500_000) return Response.json({ status: "PAYLOAD_TOO_LARGE" }, { status: 413, headers: jsonHeaders });
    await ensureTable(DB);
    const receivedAt = new Date().toISOString();
    await DB.prepare(`
      INSERT INTO v3_equity_snapshots (id, source_as_of, payload, received_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_as_of = excluded.source_as_of, payload = excluded.payload, received_at = excluded.received_at
    `).bind(SNAPSHOT_ID, snapshot.sourceAsOf, payload, receivedAt).run();
    return Response.json({ status: "SYNCED", sourceAsOf: snapshot.sourceAsOf, receivedAt }, { headers: jsonHeaders });
  } catch (error) {
    return Response.json({ status: "REJECTED", error: error instanceof Error ? error.message : "INVALID_SNAPSHOT" }, { status: 400, headers: jsonHeaders });
  }
}
