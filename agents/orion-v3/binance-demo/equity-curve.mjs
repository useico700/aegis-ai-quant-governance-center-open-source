import { recoveredPartialSettlementTime, SETTLEMENT_TIME_RECOVERY_EVENT } from "./settlement-time-recovery.mjs";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asTime(value, fallback) {
  const timestamp = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function cohortLabel(value) {
  const cohort = String(value ?? "");
  const baseline = cohort.match(/PRE-(HF\d+)-BASELINE/);
  if (baseline) return `${baseline[1]} 前基线`;
  const forward = cohort.match(/(?:^|-)HF(\d+)(?:-|$)/);
  return forward ? `HF${forward[1]} 前向` : "历史未分群";
}

function dualZSummary(value, sourceTime) {
  const primaryInterval = value?.primary?.interval === "1h" ? "1h" : null;
  const opposingInterval = value?.opposing?.interval === "15m" ? "15m" : null;
  const timestamp = asTime(value?.confirmedAt, NaN);
  const confirmed = value?.schemaVersion === 1 && value?.status === "CONFIRMED"
    && primaryInterval === "1h" && opposingInterval === "15m"
    && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= sourceTime;
  return {
    schemaVersion: 1,
    status: confirmed ? "CONFIRMED" : value == null ? "MISSING" : "NOT_CONFIRMED",
    primaryInterval,
    opposingInterval,
    confirmedAt: confirmed ? timestamp : null,
  };
}

function singleZSummary(value, sourceTime) {
  const primaryInterval = value?.primary?.interval === "1h" ? "1h" : null;
  const timestamp = asTime(value?.confirmedAt, NaN);
  const confirmed = value?.schemaVersion === 1 && value?.status === "CONFIRMED" &&
    primaryInterval === "1h" && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= sourceTime;
  return {
    schemaVersion: 1,
    status: confirmed ? "CONFIRMED" : value == null ? "MISSING" : "NOT_CONFIRMED",
    primaryInterval,
    confirmedAt: confirmed ? timestamp : null,
  };
}

function amount(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function partialTimeKey(symbol, orderId) {
  return `${symbol}:${orderId}`;
}

export function partialExitTimes(auditEvents = []) {
  const result = new Map();
  const symbolsByOrder = new Map();
  for (const event of auditEvents) {
    if (event?.eventType !== "BINANCE_DEMO_MANAGED_POSITION_PARTIALLY_REDUCED") continue;
    const orderId = String(event?.orderId ?? "");
    const timestamp = asTime(event?.occurredAt, NaN);
    if (!orderId || !Number.isFinite(timestamp)) continue;
    const symbol = String(event?.symbol ?? "");
    const key = partialTimeKey(symbol, orderId);
    result.set(key, Math.min(result.get(key) ?? Infinity, timestamp));
    const symbols = symbolsByOrder.get(orderId) ?? new Set();
    symbols.add(symbol);
    symbolsByOrder.set(orderId, symbols);
  }
  // Preserve the legacy order-only lookup only when it is unambiguous.
  for (const [orderId, symbols] of symbolsByOrder) {
    if (symbols.size === 1) result.set(orderId, result.get(partialTimeKey([...symbols][0], orderId)));
  }
  return result;
}

function partialSettlementTime(row, partial, partialTimes, sourceTime, recoveryEvents) {
  const orderId = String(partial?.orderId ?? "");
  const explicit = asTime(partial?.executedAt ?? partial?.settledAt ?? partial?.filledAt, NaN);
  const fills = partial?.tradeCost?.fills ?? partial?.fills;
  const fillTimes = Array.isArray(fills) ? fills.map((fill) => asTime(fill?.time, NaN)) : [];
  const actualFillTime = fillTimes.length && fillTimes.every(Number.isFinite) ? Math.max(...fillTimes) : NaN;
  const originalTime = Number.isFinite(explicit) ? explicit : Number.isFinite(actualFillTime) ? actualFillTime
    : partialTimes.get(partialTimeKey(row?.symbol ?? "", orderId)) ?? partialTimes.get(partialTimeKey("", orderId)) ?? NaN;
  const timestamp = Number.isFinite(originalTime) ? originalTime
    : recoveredPartialSettlementTime(row, partial, recoveryEvents, sourceTime);
  const openedAt = asTime(row?.openedAt, -Infinity);
  const closedAt = asTime(row?.closedAt, sourceTime);
  return Number.isFinite(timestamp) && timestamp >= openedAt && timestamp <= Math.min(closedAt, sourceTime) ? timestamp : null;
}

export function buildV3EquityCurve(snapshot, auditEvents = []) {
  const baselineUsdt = finite(snapshot?.account?.strategyInitialCapitalUsdt, 5_000);
  const sourceTime = asTime(snapshot?.accountObservedAt ?? snapshot?.scannedAt, Date.now());
  const baselineAt = asTime(snapshot?.equityAttribution?.incomeHistoryStartTime, sourceTime);
  const partialTimes = partialExitTimes(auditEvents);
  const recoveryEvents = auditEvents.filter((event) => event?.eventType === SETTLEMENT_TIME_RECOVERY_EVENT);
  const closed = Array.isArray(snapshot?.closedPositions) ? snapshot.closedPositions : [];
  const managed = Array.isArray(snapshot?.managedPositions) ? snapshot.managedPositions : [];
  const managedBySymbol = new Map(managed.map((row) => [row?.symbol, row]));
  const protectionBySymbol = new Map((snapshot?.executionReconciliation?.protection ?? []).map((row) => [row?.symbol, row]));
  const hf14Active = snapshot?.implementationRevision === "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE";
  const currentPositions = (Array.isArray(snapshot?.positions) ? snapshot.positions : []).map((row) => {
    const isManaged = managedBySymbol.has(row?.symbol);
    const local = managedBySymbol.get(row?.symbol) ?? {};
    const plannedMaximumLossUsdt = finite(local?.initialPlannedRiskUsdt ?? local?.plannedRiskUsdt);
    return {
      symbol: String(row?.symbol ?? "—"),
      side: row?.side === "SHORT" ? "SHORT" : "LONG",
      entryPrice: finite(row?.entryPrice),
      markPrice: finite(row?.markPrice),
      unrealizedPnlUsdt: finite(row?.unrealizedProfitUsdt),
      stage: managedBySymbol.get(row?.symbol)?.stage ?? (isManaged ? "OPEN" : "UNMANAGED"),
      managed: isManaged,
      protectionStatus: protectionBySymbol.get(row?.symbol)?.status === "PROTECTED" ? "PROTECTED" : "UNPROTECTED",
      ...(plannedMaximumLossUsdt > 0 ? { plannedMaximumLossUsdt, redLossThresholdUsdt: plannedMaximumLossUsdt * 2 } : {}),
    };
  });
  const candidatePlans = (Array.isArray(snapshot?.plans) ? snapshot.plans : []).map((row) => ({
    id: String(row?.id ?? `${row?.symbol ?? "UNKNOWN"}:${row?.intersectionTime ?? 0}`),
    symbol: String(row?.symbol ?? "—"),
    pattern: String(row?.pattern ?? "—"),
    primaryLineStatus: String(row?.primaryLineStatus ?? "—"),
    intersectionTime: finite(row?.intersectionTime),
    intersectionPrice: finite(row?.intersectionPrice),
    queuePosition: finite(row?.candidateQueue?.globalPosition ?? row?.candidateQueue?.position),
    queueSize: finite(row?.candidateQueue?.globalSize ?? row?.candidateQueue?.size),
    entryStatus: String(row?.entryDecision?.status ?? "WAITING_FOR_CROSS"),
    direction: finite(row?.entryDecision?.direction),
    automaticExecutionAllowed: row?.intersectionQuality?.automaticExecutionAllowed === true,
    marketState4h: ["LONG_ONLY", "SHORT_ONLY", "RANGE_OR_TRANSITION", "NOT_REQUIRED"].includes(row?.marketState4h?.state)
      ? row.marketState4h.state
      : "RANGE_OR_TRANSITION",
    marketStateGateStatus: String(row?.marketStateGate?.status ?? "BLOCKED_INSUFFICIENT_4H_EVIDENCE"),
    marketStateGateAllowed: row?.marketStateGate?.orderSubmissionAllowed === true,
    dualZ: dualZSummary(row?.dualZ, sourceTime),
    ...(hf14Active || row?.singleZ != null ? {
      singleZ: singleZSummary(row?.singleZ, sourceTime),
      hf13DualZFilterComparison: ["WOULD_PASS_HF13_DUAL_Z_FILTER", "WOULD_FAIL_HF13_DUAL_Z_FILTER"].includes(row?.dualZComparison?.status)
        ? row.dualZComparison.status
        : "UNKNOWN",
    } : {}),
    stabilityScore: finite(row?.anchorConsensus?.stabilityScore),
    support: finite(row?.anchorConsensus?.support),
  })).sort((left, right) => left.intersectionTime - right.intersectionTime || left.queuePosition - right.queuePosition);
  const events = [];
  const unlocatedSettlements = [];
  const evidenceIssues = new Set();
  let partialSettlementCount = 0;
  const addEvent = (event) => {
    if (event.deltaUsdt === null) {
      evidenceIssues.add("MISSING_SETTLEMENT_AMOUNT");
      unlocatedSettlements.push({ ...event, timestamp: null, exclusionReason: "MISSING_SETTLEMENT_AMOUNT" });
    } else if (!Number.isFinite(event.timestamp)) {
      evidenceIssues.add("MISSING_SETTLEMENT_TIME");
      unlocatedSettlements.push({ ...event, timestamp: null, exclusionReason: "MISSING_SETTLEMENT_TIME" });
    } else {
      events.push(event);
    }
  };
  const partialTotal = (row) => (row?.partialExits ?? []).reduce((sum, partial) => sum + (amount(partial?.netPnl) ?? 0), 0);
  const addPartials = (row) => {
    for (const [index, partial] of (row?.partialExits ?? []).entries()) {
      partialSettlementCount += 1;
      const orderId = String(partial?.orderId ?? "");
      addEvent({
        id: `partial:${row?.symbol}:${orderId || `${row?.intentId ?? row?.entryOrderId ?? row?.planId ?? row?.openedAt ?? "unknown"}:${index}`}`,
        timestamp: partialSettlementTime(row, partial, partialTimes, sourceTime, recoveryEvents),
        kind: "PARTIAL_EXIT",
        symbol: String(row?.symbol ?? "—"),
        direction: finite(row?.direction) === -1 ? "SHORT" : "LONG",
        deltaUsdt: amount(partial?.netPnl),
        realizedR: null,
        cohortId: row?.evaluationCohortId ?? null,
        cohortLabel: cohortLabel(row?.evaluationCohortId),
      });
    }
  };

  // Regression evidence: reports/strategy-research/20260912-v3-last48h/logic-audit.md §3.
  // A position closing must not move its already-settled partials to closedAt.
  for (const row of closed) {
    addPartials(row);
    const netPnl = amount(row?.netPnl);
    const partialNetPnl = amount(row?.cumulativePartialNetPnl) ?? partialTotal(row);
    const finalNetPnl = amount(row?.finalNetPnl) ?? (netPnl === null ? null : netPnl - partialNetPnl);
    if (netPnl === null) evidenceIssues.add("MISSING_COMPLETED_TRADE_AMOUNT");
    if (netPnl !== null && finalNetPnl !== null && Math.abs(netPnl - partialTotal(row) - finalNetPnl) > 1e-8) {
      evidenceIssues.add("CLOSED_TRADE_SETTLEMENTS_DO_NOT_RECONCILE");
    }
    const closedAt = asTime(row?.closedAt, NaN);
    addEvent({
      id: `closed:${row?.outcomeId ?? `${row?.symbol}:${row?.closedAt}`}`,
      timestamp: Number.isFinite(closedAt) && closedAt <= sourceTime ? closedAt : null,
      kind: "CLOSED_TRADE",
      symbol: String(row?.symbol ?? "—"),
      direction: finite(row?.direction) === -1 ? "SHORT" : "LONG",
      deltaUsdt: finalNetPnl,
      completedOnlyDeltaUsdt: netPnl,
      realizedR: amount(row?.realizedR),
      cohortId: row?.evaluationCohortId ?? null,
      cohortLabel: cohortLabel(row?.evaluationCohortId),
    });
  }

  for (const row of managed) {
    addPartials(row);
    const cumulative = amount(row?.cumulativeRealizedNetPnl);
    if (cumulative !== null && Math.abs(cumulative - partialTotal(row)) > 1e-8) evidenceIssues.add("OPEN_PARTIAL_SETTLEMENTS_DO_NOT_RECONCILE");
  }

  events.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  let completedOnlyEquityUsdt = baselineUsdt;
  let realizedLearningEquityUsdt = baselineUsdt;
  let peak = baselineUsdt;
  let maximumDrawdownUsdt = 0;
  const points = [{
    id: "baseline",
    timestamp: baselineAt,
    kind: "BASELINE",
    symbol: "起始基准",
    direction: null,
    deltaUsdt: 0,
    realizedR: null,
    cohortId: null,
    cohortLabel: "起始",
    completedOnlyEquityUsdt,
    realizedLearningEquityUsdt,
  }];

  for (const event of events) {
    if (event.kind === "CLOSED_TRADE") completedOnlyEquityUsdt += event.completedOnlyDeltaUsdt ?? 0;
    realizedLearningEquityUsdt += event.deltaUsdt;
    peak = Math.max(peak, realizedLearningEquityUsdt);
    maximumDrawdownUsdt = Math.max(maximumDrawdownUsdt, peak - realizedLearningEquityUsdt);
    points.push({ ...event, completedOnlyEquityUsdt, realizedLearningEquityUsdt });
  }

  // Win rate and PF use full closed-position outcomes, never a mix of partial legs and trades.
  const closedOutcomes = closed.map((row) => amount(row?.netPnl)).filter((value) => value !== null);
  const wins = closedOutcomes.filter((value) => value > 0);
  const losses = closedOutcomes.filter((value) => value < 0);
  const grossProfitUsdt = wins.reduce((sum, value) => sum + value, 0);
  const grossLossUsdt = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const completedNetPnlUsdt = amount(snapshot?.accounting?.completedTradeNetPnlUsdt) ?? closedOutcomes.reduce((sum, value) => sum + value, 0);
  const partialNetPnlUsdt = amount(snapshot?.accounting?.openPositionPartialRealizedNetPnlUsdt)
    ?? managed.reduce((sum, row) => sum + (amount(row?.cumulativeRealizedNetPnl) ?? partialTotal(row)), 0);
  const totalRealizedNetPnlUsdt = completedNetPnlUsdt + partialNetPnlUsdt;
  const timedSettlementNetPnlUsdt = events.reduce((sum, event) => sum + event.deltaUsdt, 0);
  const recordedSettlementNetPnlUsdt = timedSettlementNetPnlUsdt + unlocatedSettlements.reduce((sum, event) => sum + (event.deltaUsdt ?? 0), 0);
  const accountingResidualUsdt = totalRealizedNetPnlUsdt - recordedSettlementNetPnlUsdt;
  if (Math.abs(accountingResidualUsdt) > 1e-8) evidenceIssues.add("ACCOUNTING_TOTAL_NOT_FULLY_ATTRIBUTED");
  const timeEvidenceComplete = evidenceIssues.size === 0;
  const settlementEvidence = {
    status: timeEvidenceComplete ? "COMPLETE" : "INCOMPLETE_SETTLEMENT_EVIDENCE",
    reasons: [...evidenceIssues],
    unlocatedSettlementCount: unlocatedSettlements.length,
    unlocatedPartialCount: unlocatedSettlements.filter((row) => row.kind === "PARTIAL_EXIT").length,
    timedSettlementNetPnlUsdt,
    unlocatedNetPnlUsdt: totalRealizedNetPnlUsdt - timedSettlementNetPnlUsdt,
    accountingResidualUsdt,
    totalRealizedNetPnlUsdt,
    drawdownEligible: timeEvidenceComplete,
  };

  return {
    schemaVersion: 1,
    runtimeId: "ORION-V3-EQUITY-LEARNING-CURVE-1.0",
    sourceAsOf: new Date(sourceTime).toISOString(),
    accountObservedAt: snapshot?.accountObservedAt ?? snapshot?.scannedAt ?? new Date(sourceTime).toISOString(),
    strategyDisplayName: snapshot?.strategyDisplayName ?? snapshot?.strategyVersion ?? "V3 高频交易",
    implementationRevision: snapshot?.implementationRevision ?? null,
    evaluationCohortId: snapshot?.evaluationCohortId ?? null,
    baselineUsdt,
    current: {
      walletBalanceUsdt: finite(snapshot?.account?.totalWalletBalanceUsdt),
      walletChangeUsdt: finite(snapshot?.account?.totalWalletBalanceUsdt) - baselineUsdt,
      unrealizedPnlUsdt: finite(snapshot?.account?.totalUnrealizedProfitUsdt),
      marginEquityUsdt: finite(snapshot?.account?.totalMarginBalanceUsdt),
      availableBalanceUsdt: finite(snapshot?.account?.availableBalanceUsdt),
      completedOnlyEquityUsdt: baselineUsdt + completedNetPnlUsdt,
      realizedLearningEquityUsdt: baselineUsdt + completedNetPnlUsdt + partialNetPnlUsdt,
    },
    metrics: {
      closedTradeCount: closed.length,
      partialSettlementCount,
      timedPartialSettlementCount: events.filter((row) => row.kind === "PARTIAL_EXIT").length,
      completedNetPnlUsdt,
      partialNetPnlUsdt,
      totalRealizedNetPnlUsdt,
      outcomeStatisticsBasis: "COMPLETED_TRADES_NET_OF_FEES",
      outcomeStatisticsCount: closedOutcomes.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closedOutcomes.length ? wins.length / closedOutcomes.length : 0,
      profitFactor: grossLossUsdt > 0 ? grossProfitUsdt / grossLossUsdt : null,
      maximumDrawdownUsdt: timeEvidenceComplete ? maximumDrawdownUsdt : null,
      maximumDrawdownFraction: timeEvidenceComplete ? (baselineUsdt > 0 ? maximumDrawdownUsdt / baselineUsdt : 0) : null,
      observedTimedPathDrawdownUsdt: maximumDrawdownUsdt,
      settlementEvidence,
      accountReconciled: snapshot?.equityAttribution?.status === "RECONCILED",
    },
    risk: {
      maximumOpenPositionsTotal: finite(snapshot?.risk?.maximumOpenPositionsTotal, /HF(?:10|11|13)-/.test(snapshot?.implementationRevision ?? "") ? 18 : 10),
    },
    accountingBridge: {
      status: snapshot?.equityAttribution?.status ?? "INCOME_HISTORY_NOT_REQUESTED",
      incomeHistoryComplete: snapshot?.equityAttribution?.incomeHistoryComplete === true,
      incomeHistoryRowCount: finite(snapshot?.equityAttribution?.incomeHistoryRowCount),
      accountEquationDifferenceUsdt: finite(snapshot?.equityAttribution?.accountEquationDifferenceUsdt),
      walletUnreconciledDifferenceUsdt: finite(snapshot?.equityAttribution?.walletUnreconciledDifferenceUsdt),
      strategyLedgerCoverageDifferenceUsdt: finite(snapshot?.equityAttribution?.strategyLedgerCoverageDifferenceUsdt),
      openPositionUnallocatedEntryCommissionUsdt: finite(snapshot?.equityAttribution?.openPositionUnallocatedEntryCommissionUsdt),
      fundingFeeUsdt: finite(snapshot?.equityAttribution?.exchangeFundingFeeUsdt),
    },
    executionHealth: {
      status: snapshot?.executionReconciliation?.status ?? "MISSING",
      errors: (snapshot?.executionReconciliation?.errors ?? []).map((value) => String(value)).slice(0, 12),
      livePositionCount: finite(snapshot?.executionReconciliation?.livePositionCount),
      managedPositionCount: finite(snapshot?.executionReconciliation?.managedPositionCount),
      protectedPositionCount: finite(snapshot?.executionReconciliation?.protectedPositionCount),
      pendingOperationCount: finite(snapshot?.executionReconciliation?.pendingOperationCount),
      standardOpenOrderCount: finite(snapshot?.executionReconciliation?.standardOpenOrderCount),
      activeAlgoOrderCount: finite(snapshot?.executionReconciliation?.activeAlgoOrderCount),
    },
    abnormalLossGate: snapshot?.abnormalLossGate ?? null,
    currentPositions,
    candidatePlans,
    cohorts: snapshot?.accounting?.cohorts ?? [],
    curve: { baselineAt: new Date(baselineAt).toISOString(), points, settlementEvidence, unlocatedSettlements },
  };
}
