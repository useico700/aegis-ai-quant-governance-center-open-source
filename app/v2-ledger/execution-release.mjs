export const R221_REVISION = "MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY";
export const R221_DIRECTIVE = "OWNER-DIRECTIVE-V2-R22-1-ENTRY-PROTECTION-CONSISTENCY-20260914";
export const R22_BASE = "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION";
const REPAIR = "V2-R21-ENTRY-CONSISTENCY-1";
const TIERS = new Set(["IDLE", "ARMED", "WARNING", "DEFENSE", "HARD"]);
const DIRECTIONS = ["LONG", "SHORT"];
const ms = (value) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const timestamp = (value) => Number.isFinite(ms(value)) && ms(value) > 0;
const recent = (value, now) => timestamp(value) && ms(value) <= now + 5_000 && now - ms(value) <= 90_000;
const record = (value) => value != null && typeof value === "object" && !Array.isArray(value);

export function validExecutionRelease(release, base) {
  return record(release) && release.schemaVersion === 1 &&
    release.executionRevision === R221_REVISION && release.executionDirectiveId === R221_DIRECTIVE &&
    base === R22_BASE && release.baseImplementationRevision === base &&
    release.entryConsistencyRevision === REPAIR && timestamp(release.loadedAt) &&
    Number.isInteger(release.processId) && release.processId > 0 &&
    ["ACTIVE_VERIFIED", "AWAITING_FRESH_EVIDENCE"].includes(release.status) &&
    (release.status === "ACTIVE_VERIFIED"
      ? timestamp(release.verifiedAt) && timestamp(release.verifiedDecisionAt) && ms(release.verifiedAt) >= ms(release.loadedAt)
      : release.verifiedAt == null);
}

export function validPortfolioProtection(protection) {
  if (!record(protection) || protection.schemaVersion !== 1 || protection.entryConsistencyRevision !== REPAIR ||
      typeof protection.evidenceHold !== "boolean" || !Array.isArray(protection.frozenDirections) ||
      protection.frozenDirections.some((d) => !DIRECTIONS.includes(d)) ||
      !Array.isArray(protection.holdReasons) || protection.holdReasons.some((s) => typeof s !== "string" || s.length > 200) ||
      !record(protection.campaigns)) return false;
  if ([protection.lastAcceptedAt, protection.lastEvaluatedAt].some((v) => v != null && !timestamp(v))) return false;
  return DIRECTIONS.every((direction) => {
    const c = protection.campaigns[direction];
    return record(c) && typeof c.active === "boolean" && typeof c.entriesFrozen === "boolean" &&
      Number.isInteger(c.positionCount) && c.positionCount >= 0 &&
      TIERS.has(c.entryProtectionTier) && TIERS.has(c.actionTier) &&
      [c.markedPnlUsdt, c.highWaterPnlUsdt, c.drawdownFraction].every(Number.isFinite) &&
      (c.freezeUntil == null || timestamp(c.freezeUntil));
  });
}

// Older snapshots remain valid; new metadata must be internally consistent.
export function validExecutionMetadata(snapshot) {
  if (snapshot.executionRelease != null && !validExecutionRelease(snapshot.executionRelease, snapshot.implementationRevision)) return false;
  if (snapshot.portfolioProtection != null && !validPortfolioProtection(snapshot.portfolioProtection)) return false;
  if (snapshot.executionRelease?.status === "ACTIVE_VERIFIED") {
    return snapshot.portfolioProtection?.entryConsistencyRevision === REPAIR &&
      timestamp(snapshot.portfolioProtection.lastAcceptedAt) &&
      ms(snapshot.portfolioProtection.lastAcceptedAt) >= ms(snapshot.executionRelease.verifiedDecisionAt);
  }
  return true;
}

export function executionReleaseView(snapshot, now = Date.now()) {
  const release = snapshot?.executionRelease;
  const valid = validExecutionRelease(release, snapshot?.implementationRevision) && validExecutionMetadata(snapshot);
  const live = recent(snapshot?.sourceAsOf, now);
  const protection = snapshot?.portfolioProtection;
  const protectionValid = validPortfolioProtection(protection);
  const protectionFresh = valid && release.status === "ACTIVE_VERIFIED" && live && protectionValid && recent(protection.lastAcceptedAt, now) && recent(protection.lastEvaluatedAt, now);
  const verified = valid && release.status === "ACTIVE_VERIFIED";
  const status = !valid ? "未收到修订加载凭据" : !live ? "快照过期，运行状态待确认" : verified ? "本进程已加载并验证" : "已加载，等待保护数据验证";
  const tierLabels = { IDLE: "未启动", ARMED: "保护已启动", WARNING: "预警", DEFENSE: "防守", HARD: "硬保护" };
  const campaigns = DIRECTIONS.map((direction) => {
    const c = protectionValid ? protection.campaigns[direction] : null;
    const frozen = !!c && (protection.evidenceHold || c.entriesFrozen || protection.frozenDirections.includes(direction));
    return {
      direction, directionLabel: direction === "LONG" ? "多头" : "空头", frozen,
      state: !protectionFresh ? "状态待确认" : frozen ? "暂停同向新入场" : "本保护未冻结",
      tier: c ? tierLabels[c.entryProtectionTier] : "—",
      actionTier: c ? tierLabels[c.actionTier] : "—",
      positionCount: c?.positionCount ?? null,
      drawdownFraction: c?.active ? c.drawdownFraction : null,
      freezeUntil: frozen ? c?.freezeUntil ?? null : null,
    };
  });
  return {
    label: valid ? "R22.1 · 开仓保护一致性修复" : null,
    shortLabel: valid ? "R22.1" : null, status, valid, verified, live,
    loadedAt: valid ? release.loadedAt : null, verifiedAt: verified ? release.verifiedAt : null,
    protectionFresh, evidenceHold: protectionValid ? protection.evidenceHold : null,
    lastAcceptedAt: protectionValid ? protection.lastAcceptedAt : null, campaigns,
  };
}

// Version belongs to each entry, never inherited from the monitor's current release.
export function positionExecutionLabel(position) {
  return position?.implementationRevision === R22_BASE && position.executionRevision === R221_REVISION &&
    position.executionDirectiveId === R221_DIRECTIVE && timestamp(position.executionReleaseLoadedAt)
    ? "R22.1" : null;
}
