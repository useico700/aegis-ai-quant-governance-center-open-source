const DEFAULT_POLICY = Object.freeze({
  experimentId: "ORION-V3-HF12A-COST-GATE-SHADOW-20260830",
  displayName: "HF12-A · 完整成本闸门影子测试",
  status: "ACTIVE_OBSERVE_ONLY",
  prospectiveStart: "2026-08-30T15:22:58.300Z",
  sourceImplementationRevision: "MTFX-V3-HF11-TRUE-4H-MARKET-STATE-GATE",
  maximumCompleteLifecycleCostR: 0.12,
  takerFeeRate: 0.0007,
  adverseSlippageRate: 0.0002,
  minimumAttributableClosedPositions: 100,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function classifyRecord(row, policy) {
  const entryPrice = finite(row?.entryPrice ?? row?.entry);
  const originalQuantity = finite(row?.originalQuantity);
  const initialPlannedRiskUsdt = finite(row?.initialPlannedRiskUsdt);
  const initialRiskPerUnit = originalQuantity > 0 ? initialPlannedRiskUsdt / originalQuantity : 0;
  const completeLifecycleCostPerUnit = entryPrice * 2 * (finite(policy.takerFeeRate) + finite(policy.adverseSlippageRate));
  const completeLifecycleCostR = initialRiskPerUnit > 0 ? completeLifecycleCostPerUnit / initialRiskPerUnit : null;
  const evidenceComplete = entryPrice > 0 && originalQuantity > 0 && initialPlannedRiskUsdt > 0 && Number.isFinite(completeLifecycleCostR);
  return {
    evidenceComplete,
    completeLifecycleCostR,
    classification: !evidenceComplete
      ? "EXCLUDED_MISSING_ENTRY_RISK_EVIDENCE"
      : completeLifecycleCostR <= finite(policy.maximumCompleteLifecycleCostR)
        ? "SHADOW_PASS"
        : "SHADOW_REJECT",
  };
}

function openedAt(row) {
  const value = Number(row?.openedAt);
  return Number.isFinite(value) ? value : Date.parse(row?.openedAtIso ?? "");
}

export function buildV3CostGateShadowStudy(snapshot, inputPolicy = {}) {
  const policy = { ...DEFAULT_POLICY, ...(inputPolicy ?? {}) };
  const prospectiveStartMs = Date.parse(policy.prospectiveStart);
  const closed = (Array.isArray(snapshot?.closedPositions) ? snapshot.closedPositions : [])
    .filter((row) => row?.implementationRevision === policy.sourceImplementationRevision)
    .filter((row) => openedAt(row) >= prospectiveStartMs)
    .filter((row) => row?.attribution?.attributionClass !== "EXECUTION_INCIDENT");
  const open = (Array.isArray(snapshot?.managedPositions) ? snapshot.managedPositions : [])
    .filter((row) => row?.implementationRevision === policy.sourceImplementationRevision)
    .filter((row) => openedAt(row) >= prospectiveStartMs);
  const records = [
    ...closed.map((row) => ({ ...row, recordStatus: "CLOSED" })),
    ...open.map((row) => ({ ...row, recordStatus: "OPEN" })),
  ].map((row) => ({ ...row, shadow: classifyRecord(row, policy) }));
  const eligible = records.filter((row) => row.shadow.evidenceComplete);
  const passed = eligible.filter((row) => row.shadow.classification === "SHADOW_PASS");
  const rejected = eligible.filter((row) => row.shadow.classification === "SHADOW_REJECT");
  const closedEligible = eligible.filter((row) => row.recordStatus === "CLOSED");
  const closedPassed = closedEligible.filter((row) => row.shadow.classification === "SHADOW_PASS");
  const closedRejected = closedEligible.filter((row) => row.shadow.classification === "SHADOW_REJECT");
  const sum = (rows, key) => rows.reduce((total, row) => total + finite(row?.[key]), 0);
  const minimumClosed = Math.max(1, Math.trunc(finite(policy.minimumAttributableClosedPositions, 100)));
  return {
    schemaVersion: 1,
    experimentId: String(policy.experimentId),
    displayName: String(policy.displayName),
    status: "ACTIVE_OBSERVE_ONLY",
    mode: "COUNTERFACTUAL_ON_ACTUAL_HF11_ENTRIES_NO_ORDER_EFFECT",
    prospectiveStart: new Date(prospectiveStartMs).toISOString(),
    sourceImplementationRevision: String(policy.sourceImplementationRevision),
    rule: {
      maximumCompleteLifecycleCostR: finite(policy.maximumCompleteLifecycleCostR),
      takerFeeRate: finite(policy.takerFeeRate),
      adverseSlippageRate: finite(policy.adverseSlippageRate),
      formula: "ENTRY_PRICE_X_2_X_TAKER_FEE_PLUS_ADVERSE_SLIPPAGE_DIVIDED_BY_INITIAL_RISK_PER_UNIT",
    },
    sample: {
      observedEntryCount: records.length,
      eligibleEntryCount: eligible.length,
      passEntryCount: passed.length,
      rejectEntryCount: rejected.length,
      excludedEntryCount: records.length - eligible.length,
      openEntryCount: eligible.filter((row) => row.recordStatus === "OPEN").length,
      attributableClosedCount: closedEligible.length,
      passClosedCount: closedPassed.length,
      rejectClosedCount: closedRejected.length,
      minimumAttributableClosedPositions: minimumClosed,
      progressFraction: Math.min(1, closedEligible.length / minimumClosed),
      readyForReview: closedEligible.length >= minimumClosed,
    },
    outcomes: {
      hf11ObservedNetPnlUsdt: sum(closedEligible, "netPnl"),
      shadowAcceptedNetPnlUsdt: sum(closedPassed, "netPnl"),
      shadowRejectedObservedNetPnlUsdt: sum(closedRejected, "netPnl"),
      hf11ObservedCommissionUsdt: sum(closedEligible, "totalCommissionUsdt"),
      shadowAcceptedCommissionUsdt: sum(closedPassed, "totalCommissionUsdt"),
      shadowRejectedObservedCommissionUsdt: sum(closedRejected, "totalCommissionUsdt"),
      averageCompleteLifecycleCostR: eligible.length
        ? eligible.reduce((total, row) => total + finite(row.shadow.completeLifecycleCostR), 0) / eligible.length
        : null,
    },
    records: records
      .sort((left, right) => openedAt(right) - openedAt(left))
      .slice(0, 60)
      .map((row) => ({
        id: String(row?.outcomeId ?? row?.intentId ?? `${row?.symbol}:${openedAt(row)}`),
        symbol: String(row?.symbol ?? "—"),
        side: finite(row?.direction) === -1 || row?.side === "SELL" ? "SHORT" : "LONG",
        openedAt: openedAt(row),
        closedAt: row.recordStatus === "CLOSED" ? finite(row?.closedAt) : null,
        recordStatus: row.recordStatus,
        classification: row.shadow.classification,
        completeLifecycleCostR: row.shadow.completeLifecycleCostR,
        netPnlUsdt: row.recordStatus === "CLOSED" ? finite(row?.netPnl) : null,
        commissionUsdt: row.recordStatus === "CLOSED" ? finite(row?.totalCommissionUsdt) : null,
      })),
    phaseB: {
      experimentId: "ORION-V3-HF12B-CONSENSUS-2-SHADOW",
      status: "LOCKED_PENDING_HF12A_REVIEW_AND_OWNER_APPROVAL",
      proposedMinimumConsensusSupport: 2,
      recordingActive: false,
    },
    baselineExecutionChanged: false,
    ordersOrPositionsAffected: false,
    automaticPromotionAllowed: false,
  };
}
