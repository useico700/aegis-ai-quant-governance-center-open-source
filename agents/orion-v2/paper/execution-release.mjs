import { V2_R21_ENTRY_CONSISTENCY_REVISION } from "./r21-integrity.mjs";

export const V2_R221_EXECUTION_REVISION = "MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY";
export const V2_R221_EXECUTION_DIRECTIVE = "OWNER-DIRECTIVE-V2-R22-1-ENTRY-PROTECTION-CONSISTENCY-20260914";
export const V2_R221_BASE_REVISION = "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION";
export const EXECUTION_RELEASE_POSITION_FIELDS = ["executionRevision", "executionDirectiveId", "executionReleaseLoadedAt"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const time = (value) => finite(value) && value > 0;

// This patch identifies the already-authorized admission repair. It must never
// replace the base R22 selector used by versioned entry and exit calculations.
export function validateV2ExecutionReleaseAuthority({ runtime, governance, directive }) {
  const declared = governance?.executionDomains?.orionV2Paper?.executionRelease;
  const candidate = governance?.activeResearchCandidate?.executionRelease;
  if (runtime?.executionRevision == null && runtime?.executionDirectiveId == null && declared == null
    && candidate?.executionRevision == null && candidate?.executionDirectiveId == null) return null;
  invariant(runtime?.executionRevision === V2_R221_EXECUTION_REVISION
    && runtime?.executionDirectiveId === V2_R221_EXECUTION_DIRECTIVE
    && runtime?.implementationRevision === V2_R221_BASE_REVISION, "V2_EXECUTION_RELEASE_RUNTIME_INVALID");
  invariant(declared?.executionRevision === V2_R221_EXECUTION_REVISION
    && declared?.executionDirectiveId === V2_R221_EXECUTION_DIRECTIVE
    && declared?.baseImplementationRevision === V2_R221_BASE_REVISION
    && declared?.entryConsistencyRevision === V2_R21_ENTRY_CONSISTENCY_REVISION
    && ["ACTIVE_IMPLEMENTATION_AUTHORIZED", "ACTIVE_VERIFIED"].includes(declared?.status), "V2_EXECUTION_RELEASE_GOVERNANCE_INVALID");
  invariant(candidate?.executionRevision === V2_R221_EXECUTION_REVISION
    && candidate?.executionDirectiveId === V2_R221_EXECUTION_DIRECTIVE, "V2_EXECUTION_RELEASE_CANDIDATE_INVALID");
  invariant(directive?.authorizationId === V2_R221_EXECUTION_DIRECTIVE
    && directive?.scope === "ORION_V2_MTFX_PAPER_ONLY"
    && directive?.status === "ACTIVE_IMPLEMENTATION_AUTHORIZED"
    && directive?.executionRevision === V2_R221_EXECUTION_REVISION
    && directive?.baseImplementationRevision === V2_R221_BASE_REVISION
    && directive?.entryConsistencyRevision === V2_R21_ENTRY_CONSISTENCY_REVISION, "V2_EXECUTION_RELEASE_DIRECTIVE_INVALID");
  invariant(directive?.preserves?.existingPositionsAndHistoryUnchanged === true
    && directive?.preserves?.entryExitAndRiskRulesUnchanged === true
    && directive?.preserves?.otherExecutionDomainsUnchanged === true
    && directive?.preserves?.realOrdersAllowed === false, "V2_EXECUTION_RELEASE_SCOPE_INVALID");
  return Object.freeze({ schemaVersion: 1, executionRevision: V2_R221_EXECUTION_REVISION,
    executionDirectiveId: V2_R221_EXECUTION_DIRECTIVE, baseImplementationRevision: V2_R221_BASE_REVISION,
    entryConsistencyRevision: V2_R21_ENTRY_CONSISTENCY_REVISION });
}

export function confirmV2ExecutionRelease(release, decisionRecord) {
  if (!release || release.status === "ACTIVE_VERIFIED") return release;
  const evidence = decisionRecord?.payload?.evidence;
  if (decisionRecord?.type !== "PAPER_R21_PROFIT_PROTECTION_EVALUATED"
    || !Number.isInteger(decisionRecord?.sequence) || decisionRecord.sequence <= release.loadLedgerSequence
    || evidence?.accepted !== true || evidence.entryConsistencyRevision !== release.entryConsistencyRevision
    || decisionRecord?.payload?.state?.entryConsistencyRevision !== release.entryConsistencyRevision
    || !time(evidence?.evaluatedAt) || !time(evidence?.localEvaluatedAt) || evidence.localEvaluatedAt < release.loadedAt) return release;
  return { ...release, status: "ACTIVE_VERIFIED", verifiedAt: evidence.localEvaluatedAt,
    verifiedDecisionAt: evidence.evaluatedAt,
    verificationDecisionEventId: decisionRecord.eventId, verificationLedgerSequence: decisionRecord.sequence };
}

export function bindV2ExecutionRelease(position, release) {
  if (!release) return position;
  invariant(position?.implementationRevision === release.baseImplementationRevision
    && release.executionRevision === V2_R221_EXECUTION_REVISION
    && release.executionDirectiveId === V2_R221_EXECUTION_DIRECTIVE
    && time(release.loadedAt) && Number.isInteger(release.loadLedgerSequence) && release.loadLedgerSequence > 0,
  "V2_EXECUTION_RELEASE_NOT_DURABLY_LOADED");
  invariant(EXECUTION_RELEASE_POSITION_FIELDS.every((field) => position[field] == null), "V2_EXECUTION_RELEASE_POSITION_ALREADY_BOUND");
  return { ...position, executionRevision: release.executionRevision,
    executionDirectiveId: release.executionDirectiveId, executionReleaseLoadedAt: release.loadedAt };
}

export function v2PortfolioProtectionSnapshot(state) {
  const tiers = ["IDLE", "ARMED", "WARNING", "DEFENSE", "HARD"];
  const entryTier = (campaign) => campaign?.entryProtectionTier ??
    (campaign?.active === false && campaign?.positionCount === 0 && campaign?.id == null ? "IDLE" : null);
  if (!state || state.entryConsistencyRevision !== V2_R21_ENTRY_CONSISTENCY_REVISION
    || !["LONG", "SHORT"].every((label) => {
      const campaign = state.campaigns?.[label];
      return campaign && Number.isInteger(campaign.positionCount) && campaign.positionCount >= 0
        && tiers.includes(entryTier(campaign)) && tiers.includes(campaign.tier)
        && [campaign.markedPnlUsdt, campaign.highWaterPnlUsdt, campaign.drawdownFraction].every(finite);
    })) return null;
  const frozenDirections = [1, -1].filter((direction) => (state.frozenDirections ?? []).includes(direction));
  return {
    schemaVersion: 1, revision: state.revision ?? null,
    entryConsistencyRevision: state.entryConsistencyRevision ?? null,
    lastEvaluatedAt: time(state.lastEvaluatedAt) ? state.lastEvaluatedAt : null,
    lastAcceptedAt: time(state.lastAcceptedAt) ? state.lastAcceptedAt : null,
    evidenceHold: state.evidenceHold === true,
    holdReasons: Array.isArray(state.holdReasons) ? state.holdReasons.filter((reason) => typeof reason === "string").slice(0, 16) : [],
    frozenDirections: frozenDirections.map((direction) => direction === 1 ? "LONG" : "SHORT"),
    campaigns: Object.fromEntries([["LONG", 1], ["SHORT", -1]].map(([label, direction]) => {
      const campaign = state.campaigns?.[label];
      return [label, campaign ? {
        active: campaign.active === true,
        positionCount: Number.isInteger(campaign.positionCount) && campaign.positionCount >= 0 ? campaign.positionCount : null,
        regime: ["WARMUP", "PERSISTENT", "WEAK", "SHOCK"].includes(campaign.regime) ? campaign.regime : null,
        entryProtectionTier: entryTier(campaign),
        actionTier: ["IDLE", "ARMED", "WARNING", "DEFENSE", "HARD"].includes(campaign.tier) ? campaign.tier : null,
        markedPnlUsdt: finite(campaign.markedPnlUsdt) ? campaign.markedPnlUsdt : null,
        highWaterPnlUsdt: finite(campaign.highWaterPnlUsdt) ? campaign.highWaterPnlUsdt : null,
        drawdownFraction: finite(campaign.drawdownFraction) ? campaign.drawdownFraction : null,
        freezeUntil: time(campaign.freezeUntil) ? campaign.freezeUntil : null,
        // Publish the committed decision, never infer release from wall-clock expiry.
        entriesFrozen: state.evidenceHold === true || frozenDirections.includes(direction),
      } : null];
    })),
  };
}
