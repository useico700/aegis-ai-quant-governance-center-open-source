// Compact presentation contract. No execution, credentials, raw ticks or anchors.
export const RESEARCH_ID = "ORION-V3-HF14-PX-DISTANCE-PULLBACK-FORWARD-20260914";
export const MAX_RECORDS = 200;
const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : null;
const str = (v) => typeof v === "string" ? v.slice(0, 160) : "";
const stamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const code = (v) => typeof v === "string" && /^[A-Z0-9_]+$/.test(v) ? v.slice(0, 100) : "UNKNOWN";
const pickNumbers = (v, keys) => Object.fromEntries(keys.map((k) => [k, count(v?.[k])]));
const arm = (v, unknown) => ({ status: unknown ? "UNKNOWN" : code(v?.status), admittedAt: unknown ? null : num(v?.admittedAt), returnedAt: unknown ? null : num(v?.returnedAt) });

export function sanitizePxMonitor(value) {
  const v = value ?? {};
  if (v.researchId !== RESEARCH_ID || !stamp(v.asOf) || v.executionGate !== false || v.ordersAffected !== false) throw new Error("INVALID_RESEARCH_MONITOR_BOUNDARY");
  return {
    schemaVersion: 1, researchId: RESEARCH_ID, asOf: stamp(v.asOf), prospectiveStart: stamp(v.prospectiveStart),
    status: code(v.status), pid: count(v.pid), cycles: count(v.cycles), executionGate: false, ordersAffected: false,
    sourceSnapshotAsOf: stamp(v.sourceSnapshotAsOf), sourceImplementationRevision: str(v.sourceImplementationRevision),
    streams: Object.fromEntries(["public", "market"].map((k) => [k, { status: code(v.streams?.[k]?.status), latestReceivedAt: stamp(v.streams?.[k]?.latestReceivedAt) }])),
    trackedSymbols: (Array.isArray(v.trackedSymbols) ? v.trackedSymbols : []).filter((s) => typeof s === "string" && /^[A-Z0-9]{2,20}$/.test(s)).slice(0, 30),
    evidence: { eventSequence: count(v.evidence?.eventSequence), eventHead: /^[a-f0-9]{64}$/.test(v.evidence?.eventHead) ? v.evidence.eventHead : null, rawBytes: count(v.evidence?.rawBytes), recoveredAheadTail: v.evidence?.recoveredAheadTail === true },
    eligibleSignalCount: count(v.eligibleSignalCount), excludedSignalCount: count(v.excludedSignalCount), totalRecordCount: count(v.totalRecordCount),
    grid: (Array.isArray(v.grid) ? v.grid : []).slice(0, 16).map((g) => ({
      mode: ["PERCENT_BPS", "STRUCTURE_Z"].includes(g.mode) ? g.mode : "UNKNOWN", threshold: num(g.threshold),
      ...pickNumbers(g, ["denominatorEligibleSignals", "currentArmAdmitted", "distanceOnlyArmAdmitted", "pullbackArmAdmitted", "exceeded", "completedExceededDenominator", "physicalPxIntervalReturns", "legacyGatePassedPullbackAdmissions", "pendingPullback", "timedOut", "unknown"]),
      interval: { status: code(g.interval?.status), lower: num(g.interval?.lower), upper: num(g.interval?.upper), estimate: num(g.interval?.estimate), blocks: count(g.interval?.blocks) },
    })),
    records: (Array.isArray(v.records) ? v.records : []).slice(0, MAX_RECORDS).map((r) => ({
      signalId: str(r.signalId), symbol: /^[A-Z0-9]{2,20}$/.test(r.symbol) ? r.symbol : "UNKNOWN", side: ["BUY", "SELL"].includes(r.side) ? r.side : "UNKNOWN",
      confirmedAt: num(r.confirmedAt), expiresAt: num(r.expiresAt), observedAt: num(r.observedAt), px: num(r.px), decisionClose: num(r.decisionClose),
      eligible: r.eligible === true, exclusionReason: code(r.exclusionReason), integrityUnknown: r.integrityUnknown === true,
      integrityUnknownReason: code(r.integrityUnknownReason), observationCount: count(r.observationCount),
      thresholds: Object.fromEntries(Object.entries(r.thresholds ?? {}).filter(([k]) => /^(PERCENT_BPS|STRUCTURE_Z):[0-9.]+$/.test(k)).slice(0, 16).map(([k, t]) => {
        const unknown = t.unknownEvidence === true || r.integrityUnknown === true;
        return [k, { status: unknown ? "UNKNOWN" : code(t.status), reason: code(t.reason), unknownEvidence: unknown, distanceBps: num(t.distanceBps), structureZ: num(t.structureZ), legacyDisplacementBps: num(t.legacyDisplacementBps), currentArm: arm(t.currentArm, unknown), distanceOnlyArm: arm(t.distanceOnlyArm, unknown), pullbackArm: arm(t.pullbackArm, unknown) }];
      })),
    })),
    // No complete outcome producer exists. Never turn empty sums into zero returns.
    pnlStatus: "OUTCOME_PRODUCER_NOT_IMPLEMENTED", netPnl: null, costs: null, netConfidenceLower: null, automaticThresholdPromotionAllowed: false,
  };
}

export function buildPxMonitor(latest, state) {
  if (latest.researchId !== state.researchId || latest.cycles !== state.cycles || latest.evidence?.eventSequence !== state.eventSequence || latest.evidence?.eventHead !== state.eventHead || latest.asOf !== state.updatedAt) throw new Error("RESEARCH_SNAPSHOT_PAIR_MISMATCH");
  const records = Object.values(state.signals ?? {}).sort((a, b) => b.confirmedAt - a.confirmedAt);
  return sanitizePxMonitor({ ...latest, eligibleSignalCount: latest.statistics?.eligibleSignalCount, excludedSignalCount: latest.statistics?.excludedPreStartSignalCount,
    totalRecordCount: records.length, records,
    grid: (latest.statistics?.grid ?? []).map((g) => ({ ...g, interval: { ...g.physicalReturnRateIntervals?.blockBootstrap, blocks: g.physicalReturnRateIntervals?.timeBlockCount } })),
  });
}

export function sourceHealth(snapshot, now = Date.now()) {
  const age = now - Date.parse(snapshot?.asOf);
  return !Number.isFinite(age) || age < -5000 ? "UNKNOWN" : age > 90000 ? "STALE" : "FRESH";
}
