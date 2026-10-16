import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { loadIq1CompatibleHf14 } from './verify-v2-iq1-successor.mjs';
import { loadS2ProfitRetentionSuccessor, loadS2CompatibleIq1 } from './verify-s2-profit-retention-successor.mjs';
import { loadS1R221Iq1Successor } from './verify-s1-r221-iq1-successor.mjs';
import { loadAegisRotation } from './verify-aegis-rotation.mjs';
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HF11_REVISION, HF13_REVISION, HF13_AUTHORIZATION, HF14_AUTHORIZATION, entryDecisionInterval, releasePolicy, requiresDualZ, requiresSingleZ, validateDualZPolicy } from "../agents/orion-v3/binance-demo/release-policy.mjs";
import { validateHighFrequencyConfig } from "../agents/orion-v3/binance-demo/high-frequency-strategy.mjs";

export function verifyV3ReleaseMigration({ current, runtime, strategy, authorization, hf11Authorization }) {
  const release = releasePolicy(strategy);
  const hf13 = requiresDualZ(strategy);
  const hf14 = requiresSingleZ(strategy);
  const governed = current?.orionV3BinanceUsdmDemo;
  const routing = current?.v3ExperimentalStrategyRouting;
  const hf11Id = "OWNER-DIRECTIVE-ORION-V3-HF11-TRUE-4H-MARKET-STATE-GATE-20260826";
  const expectedId = hf14 ? HF14_AUTHORIZATION : hf13 ? HF13_AUTHORIZATION : hf11Id;
  if (!release || !validateDualZPolicy(strategy)) throw new Error("ORION_V3_RELEASE_POLICY_INVALID");
  validateHighFrequencyConfig(strategy);
  if (authorization?.id !== expectedId || authorization.status !== "ACTIVE" ||
      authorization?.release?.implementationRevision !== strategy.implementationRevision ||
      authorization?.appliesTo?.release !== strategy.implementationRevision ||
      authorization?.appliesTo?.agent !== "orion-v3" ||
      authorization?.appliesTo?.venue !== "BINANCE_USDM_TESTNET" ||
      authorization?.appliesTo?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
      strategy.implementationDirectiveId !== expectedId ||
      governed?.implementationRevision !== strategy.implementationRevision ||
      routing?.v3?.implementationRevision !== strategy.implementationRevision ||
      runtime?.strategyParity?.expectedImplementationRevision !== strategy.implementationRevision ||
      runtime?.automaticExecutionAuthorizationId !== expectedId ||
      governed?.automaticExecutionAuthorizationId !== expectedId ||
      routing?.authorizationId !== expectedId ||
      [strategy, runtime, governed, authorization].some((value) => value?.evaluationIsolation?.forwardCohortId !== release.cohort ||
        value?.evaluationIsolation?.baselineCohortId !== "ORION-V3-PRE-HF11-BASELINE-20260826") ||
      routing?.v3?.evaluationCohortId !== release.cohort ||
      runtime?.isolation?.startScope !== release.residentScope || governed?.residentStartScope !== release.residentScope ||
      authorization?.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
      authorization?.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
      authorization?.hardRisk?.maximumOpenPositionsTotal !== 18 ||
      authorization?.hardRisk?.maximumOpenPositionsPerSymbol !== 1 ||
      authorization?.hardRisk?.maximumEffectiveNotionalLeverage !== 10) throw new Error("ORION_V3_RELEASE_AUTHORIZATION_INVALID");
  const presentationMode = hf14 ? "ACCOUNT_RECONCILED_HF11_HF13_HF14_SEPARATE_COHORTS_SINGLE_Z_15M_ENTRY_NO_4H_EXECUTION_GATE"
    : hf13 ? "ACCOUNT_RECONCILED_HF11_HF13_SEPARATE_COHORTS_DUAL_Z_AND_TRUE_4H_GATE"
    : "ACCOUNT_RECONCILED_SUMMARY_WITH_HF11_COHORT_ISOLATION_TRUE_4H_STATE_GATE_FULL_GOVERNED_POSITION_CAPACITY_LEARNING_CURVE_POSITIONS_AND_CANDIDATES";
  const candidateSource = hf14 ? "V3_OWNER_AUTHORIZED_SINGLE_1H_Z_WITH_15M_A_C_AND_NATIVE_15M_CONFIRMATION"
    : hf13 ? "V3_OWNER_AUTHORIZED_DUAL_Z_1H_15M_5M_WITH_RETAINED_TRUE_4H_GATE"
    : "V3_OWNER_AUTHORIZED_TRUE_4H_STATE_1H_15M_5M_MATHEMATICAL_SCANNER";
  if (governed?.equityLearningCurveMonitor?.presentationMode !== presentationMode ||
      runtime?.scanner?.candidateSource !== candidateSource) throw new Error("ORION_V3_RELEASE_PRESENTATION_INVALID");
  if (hf13) {
    const monitor = governed.equityLearningCurveMonitor;
    const transition = authorization.transition;
    const integrity = governed.executionIntegrityRepair;
    const shadow = current.orionV3Hf12aCostGateShadowStudy;
    const hf11Cohort = releasePolicy({ implementationRevision: HF11_REVISION }).cohort;
    if (hf11Authorization?.id !== hf11Id || hf11Authorization?.release?.implementationRevision !== HF11_REVISION ||
        !authorization.supersedes?.includes(hf11Id) ||
        [authorization.strategy?.dualZ, governed.dualZ, routing.v3.dualZ].some((dualZ) =>
          !validateDualZPolicy({ ...strategy, dualZ }) || Object.keys(strategy.dualZ).some((key) => dualZ?.[key] !== strategy.dualZ[key])) ||
        authorization.strategy?.existingFourHourMarketStateGateRetained !== true ||
        transition?.activatedFrom !== strategy.dualZ.forwardOnlyFrom ||
        transition?.preserveAbnormalLossGate !== true || transition?.redLatchResetAuthorized !== false ||
        transition?.preserveProcessedPlanIds !== true || transition?.preserveExistingManagedPositions !== true ||
        transition?.preserveExistingProtectiveOrders !== true || transition?.preserveExistingImplementationAndCohortMetadata !== true ||
        transition?.activationDropsPendingPriorRevisionCandidates !== true || transition?.historicalSignalBackfillAllowed !== false ||
        transition?.newHf11EntriesAfterActivationAllowed !== false || transition?.newHf13EntriesAfterActivationAllowed !== true ||
        transition?.existingPositionEntryRiskStopOrQuantityRecalculationAllowed !== false ||
        authorization.evaluationIsolation?.historicalReclassificationAllowed !== false ||
        governed.evaluationIsolation?.historicalReclassificationAllowed !== false ||
        integrity?.redLatchResetAuthorized !== false || integrity?.entryAdmissionStatus !== "RED_FROZEN" ||
        integrity?.newEntriesAllowed !== false || integrity?.existingPositionManagementAllowedWhenReconciled !== true ||
        monitor.hf13AuthorizationId !== expectedId || monitor.hf13CohortIsolationPublished !== true ||
        monitor.dualZSummaryPublished !== true || monitor.rawDualZPointsPublished !== false ||
        monitor.hf11CohortIsolationPublished !== true ||
        !monitor.hf11CohortClassifications?.includes("HF11_FORWARD") || !monitor.hf11CohortClassifications?.includes("PRE_HF11_BASELINE") ||
        !monitor.visibleSummaryFields?.includes("HF13_COHORT_RESULTS") || !monitor.visibleSummaryFields?.includes("DUAL_Z_CONFIRMATION_SUMMARY") ||
        !monitor.candidatePlanSummaryFields?.includes("DUAL_Z_CONFIRMATION_SUMMARY") ||
        shadow?.sourceImplementationRevision !== HF11_REVISION || shadow?.sourceEvaluationCohortId !== hf11Cohort ||
        shadow?.executionGate !== false || shadow?.automaticPromotionAllowed !== false || shadow?.ordersOrPositionsAffected !== false) {
      throw new Error("ORION_V3_HF13_DUAL_Z_CUTOVER_BOUNDARY_INVALID");
    }
  }
  if (hf14) {
    const monitor = governed.equityLearningCurveMonitor;
    const transition = authorization.transition;
    const integrity = governed.executionIntegrityRepair;
    if (!authorization.supersedes?.includes(HF13_AUTHORIZATION) ||
        authorization.strategy?.fourHourMarketStateGateRetained !== false ||
        authorization.strategy?.marketStateObservationOnly !== true ||
        authorization.strategy?.fourHourRequestInExecutionScan !== false ||
        authorization.strategy?.missingOppositeRangeOrStaleFourHourEvidenceBlocksHf14 !== false ||
        authorization.strategy?.entryDecisionInterval !== "15m" ||
        authorization.strategy?.maximumDirectionDecisionBars !== 2 ||
        authorization.strategy?.maximumReserveBars !== 4 ||
        authorization.strategy?.maximumEntrySignalAgeMs !== 300000 ||
        authorization.strategy?.hf13Comparison?.executionInput !== false ||
        authorization.strategy?.hf13Comparison?.rankingInput !== false ||
        authorization.strategy?.hf13Comparison?.missingOrUnavailableBlocksExecution !== false ||
        [authorization.strategy?.dualZ, governed.dualZ, routing.v3.dualZ].some((dualZ) =>
          !validateDualZPolicy({ ...strategy, dualZ }) || Object.keys(strategy.dualZ).some((key) => dualZ?.[key] !== strategy.dualZ[key])) ||
        transition?.activatedFrom !== strategy.dualZ.forwardOnlyFrom || transition?.preserveAbnormalLossGate !== true ||
        transition?.redLatchResetAuthorized !== false || transition?.preserveProcessedPlanIds !== true ||
        transition?.preserveExistingManagedPositions !== true || transition?.preserveExistingProtectiveOrders !== true ||
        transition?.preserveExistingImplementationAndCohortMetadata !== true ||
        transition?.activationDropsPendingPriorRevisionCandidates !== true || transition?.historicalSignalBackfillAllowed !== false ||
        transition?.newHf13EntriesAfterActivationAllowed !== false || transition?.newHf14EntriesAfterActivationAllowed !== true ||
        integrity?.redLatchResetAuthorized !== false || integrity?.entryAdmissionStatus !== "RED_FROZEN" || integrity?.newEntriesAllowed !== false ||
        monitor?.hf14AuthorizationId !== expectedId || monitor?.hf14CohortIsolationPublished !== true ||
        monitor?.singleZSummaryPublished !== true || monitor?.hf13DualZFilterComparisonPublished !== true ||
        monitor?.hf13DualZFilterComparisonExecutionInput !== false || monitor?.hf13DualZFilterComparisonRankingInput !== false ||
        monitor?.rawZPointsPublished !== false || !monitor?.visibleSummaryFields?.includes("HF14_COHORT_RESULTS") ||
        !monitor?.candidatePlanSummaryFields?.includes("SINGLE_Z_CONFIRMATION_SUMMARY") ||
        !monitor?.candidatePlanSummaryFields?.includes("HF13_DUAL_Z_FILTER_COMPARISON")) {
      throw new Error("ORION_V3_HF14_SINGLE_Z_CUTOVER_BOUNDARY_INVALID");
    }
  }
  return { ...release, presentationMode, candidateSource };
}

export function verifyV3SharedVerifierSuccessor({ strategy, authorization, file, actualBytes, predecessorManifestPath, predecessorManifestBytes, successor }) {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const validDescriptor = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/.test(value.sha256);
  if (!requiresDualZ(strategy) || !releasePolicy(strategy) || !validateDualZPolicy(strategy) ||
      authorization?.id !== HF13_AUTHORIZATION || authorization?.status !== "ACTIVE" ||
      authorization?.release?.implementationRevision !== strategy.implementationRevision ||
      authorization?.appliesTo?.release !== strategy.implementationRevision ||
      file?.path !== "scripts/verify-migration.mjs" || !validDescriptor(file.after) ||
      predecessorManifestPath !== "governance/evidence/manifests/v2-r21-entry-consistency-20260914.json" ||
      successor?.authorizationId !== HF13_AUTHORIZATION || successor?.scope !== "V3_HF13_VERIFIER_ONLY" ||
      successor?.supersedesManifest !== predecessorManifestPath || successor?.path !== file.path ||
      successor?.historicalManifestPreserved !== true || successor?.preservedV2S1Checks !== true ||
      successor?.predecessorManifestSha256 !== digest(predecessorManifestBytes) ||
      !validDescriptor(successor?.before) || !validDescriptor(successor?.after) ||
      successor.before.bytes !== file.after.bytes || successor.before.sha256 !== file.after.sha256 ||
      successor.after.bytes !== actualBytes.length || successor.after.sha256 !== digest(actualBytes)) {
    throw new Error("V3_HF13_SHARED_VERIFIER_SUCCESSOR_INVALID");
  }
  return true;
}

const V2_R221_AUTHORIZATION = "OWNER-DIRECTIVE-V2-R22-1-ENTRY-PROTECTION-CONSISTENCY-20260914";
const V2_R221_REVISION = "MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY";
const V2_R221_BASE = "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION";
const V2_R221_AUTHORIZATION_PATH = "governance/owner-authorizations/2026-09-14-v2-r22-1-entry-protection-consistency.json";
const V2_R221_MANIFEST_PATH = "governance/evidence/manifests/v2-r22-1-entry-protection-consistency-20260914.json";
const V2_R221_EVIDENCE_PATH = "governance/evidence/v2-r22-1-entry-protection-consistency-20260914.json";
const V2_R221_BEFORE_ROOT = "reports/strategy-research/20260914-v2-r221/before/";
const V2_R221_PREDECESSOR_PATHS = [
  "governance/evidence/v2-risk-2pct-10pct-20260911.json",
  "governance/evidence/manifests/v2-r21-integrity-repair-20260913.json",
  "governance/evidence/manifests/v2-r21-entry-consistency-20260914.json",
  "governance/evidence/manifests/v3-hf13-shared-verifier-20260914.json",
  "governance/evidence/v2-monitor-earliest-history-20260905.json",
  "governance/evidence/manifests/orion-v2-account-equity-lock-shadow-v99-source-manifest.json",
  "governance/evidence/manifests/v2-account-compound-abc-v101-source-manifest.json",
];
const V2_R221_CHANGED_PATHS = [
  "agents/orion-v2/paper/config.json", "agents/orion-v2/paper/paper-daemon.mjs", "scripts/verify-migration.mjs",
  "app/v2-ledger/page.tsx", "app/v2-ledger/ledger.module.css", "app/api/mtfx-ledger/route.ts",
];
const V2_R221_ADDED_PATHS = [
  "agents/orion-v2/paper/execution-release.mjs", "tests/v2-r221-execution-release.test.mjs",
  "app/v2-ledger/execution-release.mjs", "app/v2-ledger/execution-release.d.mts", "tests/v2-r221-monitor.test.mjs",
  V2_R221_AUTHORIZATION_PATH, "tests/v2-r221-governance.test.mjs",
];
const v2R221Digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const v2R221DescriptorValid = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/.test(value.sha256);
const v2R221DescriptorMatches = (descriptor, bytes) => v2R221DescriptorValid(descriptor) && bytes != null && descriptor.bytes === bytes.length && descriptor.sha256 === v2R221Digest(bytes);

// The release is a V2-only metadata successor. Its before/after bytes and all
// existing evidence links must remain provable; an arbitrary newer hash is not
// permission to bypass the predecessor's strategy, risk or domain checks.
export function verifyV2R221ReleaseMigration({ current, runtime, authorization, evidence, manifest, sourceBytes, predecessorBytes }) {
  const release = current?.executionDomains?.orionV2Paper?.executionRelease;
  const candidate = current?.activeResearchCandidate;
  const preserves = authorization?.preserves;
  const boundaries = ["riskFractionsChanged", "entryExitLogicChanged", "profitThresholdsChanged", "freezeDurationChanged",
    "initialArmingThreePositionMinimumChanged", "reductionOrCloseThreePositionMinimumChanged", "existingPositionRevisionRetrofitAllowed",
    "historicalLedgerRewriteAllowed", "exchangeCredentialsAllowed", "signedRequestsAllowed", "testnetOrdersAllowed", "realOrdersAllowed",
    "dualZAddedToV2", "foreignExecutionDomainsChanged"];
  if (authorization?.authorizationId !== V2_R221_AUTHORIZATION || authorization?.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" ||
      authorization?.scope !== "ORION_V2_MTFX_PAPER_ONLY" || authorization?.executionRevision !== V2_R221_REVISION ||
      authorization?.baseImplementationRevision !== V2_R221_BASE || authorization?.entryConsistencyRevision !== "V2-R21-ENTRY-CONSISTENCY-1" ||
      !authorization?.supersedes?.includes("OWNER-DIRECTIVE-V2-R21-ENTRY-CONSISTENCY-20260914") ||
      preserves?.existingPositionsAndHistoryUnchanged !== true || preserves?.entryExitAndRiskRulesUnchanged !== true ||
      preserves?.otherExecutionDomainsUnchanged !== true || preserves?.realOrdersAllowed !== false ||
      boundaries.some((key) => authorization?.boundaries?.[key] !== false) ||
      release?.executionRevision !== V2_R221_REVISION || release?.executionDirectiveId !== V2_R221_AUTHORIZATION ||
      release?.baseImplementationRevision !== V2_R221_BASE || release?.entryConsistencyRevision !== "V2-R21-ENTRY-CONSISTENCY-1" ||
      release?.authorization !== V2_R221_AUTHORIZATION_PATH || release?.sourceSupersession !== V2_R221_MANIFEST_PATH ||
      release?.evidence !== V2_R221_EVIDENCE_PATH || !["ACTIVE_IMPLEMENTATION_AUTHORIZED", "ACTIVE_VERIFIED"].includes(release?.status) ||
      release?.newEntriesOnly !== true || release?.existingPositionsAndHistoryUnchanged !== true ||
      release?.entryExitAndRiskRulesUnchanged !== true || release?.otherExecutionDomainsUnchanged !== true ||
      candidate?.implementationRevision !== V2_R221_BASE || candidate?.executionRelease?.executionRevision !== V2_R221_REVISION ||
      candidate?.executionRelease?.executionDirectiveId !== V2_R221_AUTHORIZATION ||
      candidate?.executionRelease?.governancePath !== "executionDomains.orionV2Paper.executionRelease" ||
      runtime?.implementationRevision !== V2_R221_BASE || runtime?.executionRevision !== V2_R221_REVISION ||
      runtime?.executionDirectiveId !== V2_R221_AUTHORIZATION ||
      ["exchangeCredentialsAllowed", "signedRequestsAllowed", "apiKeysAllowed", "orderEndpointsAllowed", "testnetOrdersAllowed", "realOrdersAllowed"]
        .some((key) => current?.executionDomains?.orionV2Paper?.[key] !== false) ||
      evidence?.authorizationId !== V2_R221_AUTHORIZATION || evidence?.status !== release.status ||
      evidence?.executionRevision !== V2_R221_REVISION || evidence?.sourceSupersession !== V2_R221_MANIFEST_PATH ||
      evidence?.implementation?.entryExitAndRiskRulesChanged !== false || evidence?.implementation?.existingPositionsAndHistoryRewritten !== false ||
      evidence?.implementation?.otherExecutionDomainsChanged !== false) throw new Error("V2_R221_AUTHORIZATION_INVALID");
  if (release.status === "ACTIVE_VERIFIED") {
    if (release.runtimeLoaded !== true || !Number.isFinite(Date.parse(release.verifiedAt)) || evidence?.runtime?.loaded !== true)
      throw new Error("V2_R221_RUNTIME_VERIFICATION_MISSING");
  } else if (release.runtimeLoaded !== false || release.verifiedAt !== null || evidence?.runtime?.loaded !== false) {
    throw new Error("V2_R221_PREMATURE_LOADED_CLAIM");
  }
  const allowedPaths = [...V2_R221_CHANGED_PATHS, ...V2_R221_ADDED_PATHS];
  if (manifest?.schemaVersion !== 1 || manifest?.authorizationId !== V2_R221_AUTHORIZATION ||
      manifest?.authorization !== V2_R221_AUTHORIZATION_PATH || manifest?.scope !== "V2_R221_ENTRY_REVISION_AND_MONITOR_ONLY" ||
      manifest?.historicalManifestsPreserved !== true || manifest?.preservedV2S1V3Checks !== true ||
      manifest?.files?.length !== allowedPaths.length || new Set(manifest.files.map((file) => file.path)).size !== allowedPaths.length ||
      manifest.files.some((file) => !allowedPaths.includes(file.path)) ||
      manifest?.predecessors?.length !== V2_R221_PREDECESSOR_PATHS.length ||
      new Set(manifest.predecessors.map((file) => file.path)).size !== V2_R221_PREDECESSOR_PATHS.length ||
      manifest.predecessors.some((file) => !V2_R221_PREDECESSOR_PATHS.includes(file.path))) throw new Error("V2_R221_MANIFEST_SCOPE_INVALID");
  const documents = {};
  for (const file of manifest.predecessors) {
    if (!v2R221DescriptorMatches(file, predecessorBytes?.[file.path])) throw new Error(`V2_R221_PREDECESSOR_DOCUMENT_CHANGED:${file.path}`);
    documents[file.path] = JSON.parse(predecessorBytes[file.path]);
  }
  const [riskPath, integrityPath, entryPath, hf13Path, historyPath, shadowPath, candidatePath] = V2_R221_PREDECESSOR_PATHS;
  const expectedBefore = {
    "agents/orion-v2/paper/config.json": documents[riskPath].sourceSupersession?.files?.find((file) => file.path === "agents/orion-v2/paper/config.json")?.after,
    "agents/orion-v2/paper/paper-daemon.mjs": documents[integrityPath].files?.find((file) => file.path === "agents/orion-v2/paper/paper-daemon.mjs")?.after,
    "scripts/verify-migration.mjs": documents[hf13Path].after,
    "app/v2-ledger/page.tsx": { sha256: documents[historyPath].sourceSupersession?.sha256 },
    "app/v2-ledger/ledger.module.css": documents[shadowPath].files?.find((file) => file.path === "app/v2-ledger/ledger.module.css"),
    "app/api/mtfx-ledger/route.ts": documents[candidatePath].protectedFiles?.find((file) => file.path === "app/api/mtfx-ledger/route.ts"),
  };
  const entryVerifier = documents[entryPath].files?.find((file) => file.path === "scripts/verify-migration.mjs");
  const hf13 = documents[hf13Path];
  if (hf13.supersedesManifest !== entryPath || hf13.predecessorManifestSha256 !== v2R221Digest(predecessorBytes[entryPath]) ||
      hf13.before?.bytes !== entryVerifier?.after?.bytes || hf13.before?.sha256 !== entryVerifier?.after?.sha256)
    throw new Error("V2_R221_HF13_PREDECESSOR_CHAIN_INVALID");
  for (const file of manifest.files) {
    if (!v2R221DescriptorMatches(file.after, sourceBytes?.[file.path])) throw new Error(`V2_R221_SOURCE_HASH:${file.path}`);
    if (V2_R221_ADDED_PATHS.includes(file.path)) {
      if (file.before !== null || file.beforeSource !== null) throw new Error(`V2_R221_ADDITIVE_SOURCE_INVALID:${file.path}`);
      continue;
    }
    const expected = expectedBefore[file.path];
    if (file.beforeSource !== V2_R221_BEFORE_ROOT + file.path || !v2R221DescriptorMatches(file.before, sourceBytes?.[file.beforeSource]) ||
        file.before?.sha256 !== expected?.sha256 || (expected?.bytes != null && file.before.bytes !== expected.bytes))
      throw new Error(`V2_R221_SOURCE_PREDECESSOR_INVALID:${file.path}`);
  }
  const priorConfig = JSON.parse(sourceBytes[V2_R221_BEFORE_ROOT + "agents/orion-v2/paper/config.json"]);
  const currentBaseConfig = { ...runtime };
  delete currentBaseConfig.executionRevision;
  delete currentBaseConfig.executionDirectiveId;
  if (JSON.stringify(priorConfig) !== JSON.stringify(currentBaseConfig)) throw new Error("V2_R221_BASE_CONFIG_CHANGED");
  const protectedPaths = ["agents/orion-v2/paper/paper-engine.mjs", "agents/orion-v2/paper/r21-integrity.mjs"];
  if (manifest?.protectedFiles?.length !== protectedPaths.length || new Set(manifest.protectedFiles.map((file) => file.path)).size !== protectedPaths.length ||
      manifest.protectedFiles.some((file) => !protectedPaths.includes(file.path))) throw new Error("V2_R221_PROTECTED_SCOPE_INVALID");
  for (const file of manifest.protectedFiles) {
    const prior = file.path.endsWith("r21-integrity.mjs") ? documents[entryPath].files.find((item) => item.path === file.path)?.after
      : documents[integrityPath].protectedFiles.find((item) => item.path === file.path);
    if (!v2R221DescriptorMatches(file, sourceBytes?.[file.path]) || file.bytes !== prior?.bytes || file.sha256 !== prior?.sha256)
      throw new Error(`V2_R221_PROTECTED_SOURCE_CHANGED:${file.path}`);
  }
  return manifest;
}

export function matchesV2R221SourceSuccessor(manifest, filePath, expected, actualBytes) {
  if (!manifest || !V2_R221_CHANGED_PATHS.includes(filePath)) return false;
  const file = manifest.files.find((item) => item.path === filePath);
  return file?.before?.sha256 === expected?.sha256 && (expected?.bytes == null || file.before.bytes === expected.bytes) &&
    v2R221DescriptorMatches(file.after, actualBytes);
}

const V2_LAYOUT_AUTHORIZATION = "OWNER-DIRECTIVE-V2-MONITOR-INFORMATION-LAYOUT-20260914";
const V2_LAYOUT_AUTHORIZATION_PATH = "governance/owner-authorizations/2026-09-14-v2-monitor-information-layout.json";
const V2_LAYOUT_MANIFEST_PATH = "governance/evidence/manifests/v2-monitor-information-layout-20260914.json";
const V2_LAYOUT_EVIDENCE_PATH = "governance/evidence/v2-monitor-information-layout-20260914.json";
const V2_LAYOUT_BEFORE_ROOT = "reports/strategy-research/20260914-v2-monitor-layout/before/";
const V2_LAYOUT_CHANGED_PATHS = ["app/v2-ledger/page.tsx", "app/v2-ledger/ledger.module.css", "scripts/verify-migration.mjs"];
const V2_LAYOUT_ADDED_PATHS = ["app/v2-ledger/version-history.json", V2_LAYOUT_AUTHORIZATION_PATH, "tests/v2-monitor-layout-governance.test.mjs"];

export function verifyV2MonitorLayoutMigration({ current, authorization, evidence, manifest, sourceBytes, predecessorManifestBytes }) {
  const pointer = current?.communications?.v2MonitorInformationLayout;
  const release = current?.executionDomains?.orionV2Paper?.executionRelease;
  const boundaries = ["runtimeReloadRequired", "strategyOrRiskChanged", "positionsOrLedgerChanged", "historicalRevisionRewriteAllowed",
    "runtimeOrApiSourceChanged", "otherExecutionDomainsChanged", "siteAccessExpanded"];
  if (authorization?.authorizationId !== V2_LAYOUT_AUTHORIZATION || authorization?.status !== "ACTIVE_PRESENTATION_AUTHORIZED" ||
      authorization?.scope !== "V2_MONITOR_PRESENTATION_ONLY" || authorization?.route !== "/v2-ledger" ||
      boundaries.some((key) => authorization?.boundaries?.[key] !== false) ||
      authorization?.preserves?.runtimeLoadedRevisionAndEvidence !== true || authorization?.preserves?.historicalManifests !== true ||
      authorization?.preserves?.tradingInformationAndHistory !== true ||
      pointer?.authorizationId !== V2_LAYOUT_AUTHORIZATION || pointer?.authorization !== V2_LAYOUT_AUTHORIZATION_PATH ||
      pointer?.sourceSupersession !== V2_LAYOUT_MANIFEST_PATH || pointer?.evidence !== V2_LAYOUT_EVIDENCE_PATH ||
      pointer?.route !== "/v2-ledger" || !["PREPARED", "ACTIVE_PRIVATE_PRODUCTION_VERIFIED"].includes(pointer?.status) ||
      pointer?.runtimeReloadRequired !== false || pointer?.strategyOrRiskChanged !== false ||
      release?.executionRevision !== V2_R221_REVISION || release?.sourceSupersession !== V2_R221_MANIFEST_PATH ||
      evidence?.authorizationId !== V2_LAYOUT_AUTHORIZATION || evidence?.scope !== authorization.scope || evidence?.status !== pointer.status ||
      boundaries.some((key) => evidence?.boundaries?.[key] !== false)) throw new Error("V2_MONITOR_LAYOUT_AUTHORITY_INVALID");
  if (pointer.status === "ACTIVE_PRIVATE_PRODUCTION_VERIFIED" &&
      (evidence?.deployment?.status !== "SUCCEEDED" || evidence?.deployment?.ownerOnlyAccessPreserved !== true))
    throw new Error("V2_MONITOR_LAYOUT_PUBLICATION_UNVERIFIED");
  const allowedPaths = [...V2_LAYOUT_CHANGED_PATHS, ...V2_LAYOUT_ADDED_PATHS];
  if (manifest?.schemaVersion !== 1 || manifest?.authorizationId !== V2_LAYOUT_AUTHORIZATION ||
      manifest?.scope !== "V2_MONITOR_PRESENTATION_AND_HISTORY_GROUPING_ONLY" ||
      manifest?.historicalManifestsPreserved !== true || manifest?.runtimeAndApiSourcePreserved !== true ||
      manifest?.preservedV2S1V3Checks !== true || manifest?.predecessor?.path !== V2_R221_MANIFEST_PATH ||
      !v2R221DescriptorMatches(manifest.predecessor, predecessorManifestBytes) ||
      manifest?.files?.length !== allowedPaths.length || new Set(manifest.files.map((file) => file.path)).size !== allowedPaths.length ||
      manifest.files.some((file) => !allowedPaths.includes(file.path))) throw new Error("V2_MONITOR_LAYOUT_SOURCE_SCOPE_INVALID");
  const predecessor = JSON.parse(predecessorManifestBytes);
  if (predecessor.authorizationId !== V2_R221_AUTHORIZATION || predecessor.authorization !== V2_R221_AUTHORIZATION_PATH ||
      predecessor.scope !== "V2_R221_ENTRY_REVISION_AND_MONITOR_ONLY") throw new Error("V2_MONITOR_LAYOUT_PREDECESSOR_AUTHORITY_INVALID");
  for (const file of manifest.files) {
    if (!v2R221DescriptorMatches(file.after, sourceBytes?.[file.path])) throw new Error(`V2_MONITOR_LAYOUT_SOURCE_HASH:${file.path}`);
    if (V2_LAYOUT_ADDED_PATHS.includes(file.path)) {
      if (file.before !== null || file.beforeSource !== null) throw new Error(`V2_MONITOR_LAYOUT_ADDED_SOURCE_INVALID:${file.path}`);
      continue;
    }
    const prior = predecessor.files.find((item) => item.path === file.path)?.after;
    if (file.beforeSource !== V2_LAYOUT_BEFORE_ROOT + file.path || !v2R221DescriptorMatches(file.before, sourceBytes?.[file.beforeSource]) ||
        file.before?.bytes !== prior?.bytes || file.before?.sha256 !== prior?.sha256)
      throw new Error(`V2_MONITOR_LAYOUT_PREDECESSOR_INVALID:${file.path}`);
  }
  return manifest;
}

export function matchesV2MonitorLayoutSuccessor(manifest, filePath, expected, actualBytes) {
  if (!manifest || !V2_LAYOUT_CHANGED_PATHS.includes(filePath)) return false;
  const file = manifest.files.find((item) => item.path === filePath);
  return file?.before?.bytes === expected?.bytes && file?.before?.sha256 === expected?.sha256 &&
    v2R221DescriptorMatches(file.after, actualBytes);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyMigration() {
const required = [
  ...V2_LAYOUT_ADDED_PATHS,
  V2_LAYOUT_MANIFEST_PATH,
  V2_LAYOUT_EVIDENCE_PATH,
  ...V2_R221_ADDED_PATHS,
  V2_R221_MANIFEST_PATH,
  V2_R221_EVIDENCE_PATH,
  "governance/owner-authorizations/2026-09-11-s1-r22-live-risk.json",
  "governance/evidence/s1-r22-risk-preparation-20260911.json",
  "agents/orion-live/s1-scanner/r22-risk-profile.json",
  "agents/orion-live/s1-scanner/risk-budget.mjs",
  "AGENTS.md",
  "governance/current-state.json",
  "governance/strategy-registry.json",
  "governance/owner-authorizations/2026-09-11-demo-server-replacement.json",
  "governance/evidence/demo-server-replacement-20260911.json",
  "governance/domain-registry.json",
  "scripts/verify-demo-server-replacement.mjs",
  "ops/demo-server/binance-readonly.compose.yaml",
  "governance/owner-authorizations/2026-09-04-local-simulation-demo-server-production-topology.json",
  "governance/evidence/local-simulation-demo-server-production-topology-20260904.json",
  "governance/owner-authorizations/2026-09-08-binance-production-server-only-readonly-deployment.json",
  "governance/evidence/binance-production-server-only-readonly-deployment-20260908.json",
  "governance/owner-authorizations/2026-09-09-s1-spot-to-usdm-full-balance-transfer.json",
  "governance/evidence/s1-spot-to-usdm-full-balance-transfer-20260909.json",
  "agents/orion-live/binance-prod/config.json",
  "agents/orion-live/binance-prod/mainnet-readonly-client.mjs",
  "agents/orion-live/binance-prod/preflight.mjs",
  "agents/orion-live/binance-prod/resident-readonly.mjs",
  "agents/orion-live/binance-prod/retention.mjs",
  "ops/demo-server/aegis-binance-prod-readonly.service",
  "tests/orion-live-binance-prod-readonly.test.mjs",
  "agents/aegis-prime/CHARTER.md",
  "agents/orion-v1/CHARTER.md",
  "agents/orion-v2/CHARTER.md",
  "agents/orion-v3/CHARTER.md",
  "agents/orion-v3/AGENTS.md",
  "agents/orion-v3/binance-demo/config.json",
  "agents/orion-v3/binance-demo/preflight.mjs",
  "agents/orion-v3/binance-demo/snapshot.mjs",
  "agents/orion-v3/binance-demo/resident-scan.mjs",
  "agents/orion-v3/binance-demo/control.mjs",
  "agents/orion-v3/binance-demo/report.mjs",
  "agents/orion-v3/binance-demo/equity-curve.mjs",
  "agents/orion-v3/binance-demo/release-policy.mjs",
  "agents/orion-v3/binance-demo/dual-z.mjs",
  "tests/fixtures/v3-hf11-config.json",
  "tests/v3-dual-z.test.mjs",
  "tests/v3-hf13-strategy.test.mjs",
  "tests/v3-hf13-executor.test.mjs",
  "tests/v3-hf13-gateway-cohorts.test.mjs",
  "tests/v3-hf13-preflight.test.mjs",
  "tests/v3-hf13-migration.test.mjs",
  "governance/evidence/manifests/v3-hf13-shared-verifier-20260914.json",
  "reports/strategy-research/20260914-v3-dual-z/STRATEGY.md",
  "app/api/v3-equity/route.ts",
  "app/api/v4-monitor/route.ts",
  "app/monitor-sync.ts",
  "app/monitor-typography.css",
  "app/monitor-curve.ts",
  "app/v2-ledger/ledger.module.css",
  "app/v2-ledger/account-shadow/engine.mjs",
  "app/v2-ledger/account-shadow/layout.tsx",
  "app/v2-ledger/account-shadow/page.tsx",
  "app/v2-ledger/account-shadow/shadow.module.css",
  "app/api/mtfx-ledger/route.ts",
  "app/v3-equity/curve.ts",
  "app/v3-equity/page.tsx",
  "app/v4-monitor/page.tsx",
  "app/v4-monitor/v4-monitor.module.css",
  "agents/orion-v4/binance-demo/monitor-config.json",
  "agents/orion-v4/binance-demo/monitor-publisher.mjs",
  "agents/orion-v4/binance-demo/monitor-resident.mjs",
  "agents/orion-v4/binance-demo/monitor-supervisor.mjs",
  "agents/orion-v4/binance-demo/monitor-control.mjs",
  "agents/orion-v5/CHARTER.md",
  "agents/orion-v5/AGENTS.md",
  "agents/orion-v5/ctp-paper/config.json",
  "agents/orion-v5/ctp-paper/authoritative-inputs.mjs",
  "agents/orion-v5/ctp-paper/ctp-md-adapter.mjs",
  "agents/orion-v5/ctp-paper/forward-tick-store.mjs",
  "agents/orion-v5/ctp-paper/session-calendar.mjs",
  "agents/orion-v5/ctp-paper/futures-rules.mjs",
  "agents/orion-v5/ctp-paper/ledger.mjs",
  "agents/orion-v5/ctp-paper/ledger-store.mjs",
  "agents/orion-v5/ctp-paper/tick-sequencer.mjs",
  "agents/orion-v5/ctp-paper/mtfx-r22-strategy.mjs",
  "agents/orion-v5/ctp-paper/r22-position-management.mjs",
  "agents/orion-v5/ctp-paper/paper-execution.mjs",
  "agents/orion-v5/ctp-paper/daemon.mjs",
  "agents/orion-v5/ctp-paper/control.mjs",
  "agents/orion-v5/ctp-paper/supervisor.mjs",
  "agents/orion-v5/ctp-paper/efficacy-audit.mjs",
  "agents/orion-v5/ctp-paper/efficacy-report.mjs",
  "agents/orion-v5/ctp-paper/paper-engine.mjs",
  "agents/orion-v5/ctp-paper/position-batches.mjs",
  "agents/orion-v5/ctp-paper/monitor-payload.mjs",
  "app/api/v5-au/route.ts",
  "app/v5-au/bootstrap-snapshot.json",
  "app/v5-au/page.tsx",
  "app/v5-au/v5-au.module.css",
  "experiments/v5-au-mtfx/config.json",
  "experiments/v5-au-mtfx/initial-state.json",
  "governance/owner-authorizations/2026-09-04-orion-v5-au-futures-v2-r22-paper-initialization.json",
  "governance/evidence/orion-v5-au-futures-initialization-20260904.json",
  "governance/owner-authorizations/2026-09-04-orion-v5-au-continuous-paper-residence-and-efficacy.json",
  "governance/evidence/orion-v5-au-continuous-paper-residence-20260904.json",
  "agents/orion-v3/binance-demo/high-frequency-strategy.mjs",
  "agents/orion-v3/binance-demo/leverage-control.mjs",
  "agents/orion-v3-shadow-kelly/CHARTER.md",
  "agents/orion-v3-shadow-kelly/AGENTS.md",
  "agents/orion-v3-shadow-kelly/shadow-kelly.mjs",
  "agents/nexus/NEXUS_AGENT_CHARTER.md",
  "archive/orion-v1-research-foundation/pyproject.toml",
  "archive/orion-v2-shadow-lab/package.json",
  "archive/runtime-snapshots/orion-v2/kill-switch.json",
  "governance/owner-authorizations/2026-08-05-mtfx-paper.json",
  "governance/owner-authorizations/2026-08-06-mtfx-portfolio-only-risk.json",
  "governance/owner-authorizations/2026-08-06-mtfx-per-intersection-1pct.json",
  "governance/owner-authorizations/2026-08-06-mtfx-price-time-structure-0.5.0.json",
  "governance/owner-authorizations/2026-08-06-mtfx-hierarchical-parent-r1.json",
  "governance/owner-authorizations/2026-08-06-mtfx-continuation-lineage-r2.json",
  "governance/owner-authorizations/2026-08-06-mtfx-balanced-lead-window-r3.json",
  "governance/owner-authorizations/2026-08-07-mtfx-one-sided-expansion-r4.json",
  "governance/owner-authorizations/2026-08-07-mtfx-structure-hygiene-h1.json",
  "governance/owner-authorizations/2026-08-07-mtfx-post-cross-confirmation-r5.json",
  "governance/owner-authorizations/2026-08-07-mtfx-multi-anchor-consensus-r6.json",
  "governance/owner-authorizations/2026-08-08-mtfx-deferred-protective-structure-r7.json",
  "governance/owner-authorizations/2026-08-10-mtfx-relaxed-price-confirmation-r8.json",
  "governance/owner-authorizations/2026-08-11-mtfx-one-hour-protective-stop-r9.json",
  "governance/owner-authorizations/2026-08-13-mtfx-cross-close-buffer-r10.json",
  "governance/owner-authorizations/2026-08-13-mtfx-intersection-buffer-stop-r11.json",
  "governance/owner-authorizations/2026-08-13-mtfx-two-bar-cross-buffer-r12.json",
  "governance/owner-authorizations/2026-08-15-mtfx-tier1-event-entry-freeze-r13.json",
  "governance/owner-authorizations/2026-08-17-mtfx-single-symbol-exposure-r14.json",
  "governance/owner-authorizations/2026-08-17-mtfx-current-structure-replacement-r15.json",
  "governance/owner-authorizations/2026-08-18-mtfx-current-structure-capacity-r16.json",
  "governance/owner-authorizations/2026-08-18-mtfx-soft-profit-lock-r17.json",
  "governance/owner-authorizations/2026-08-19-mtfx-entry-quality-guards-r18.json",
  "governance/evidence/orion-v3-hf5-pre-cutover-baseline-20260819.json",
  "governance/evidence/orion-v3-hf5-cutover-20260819.json",
  "governance/evidence/orion-v3-hf6-pre-cutover-baseline-20260820.json",
  "governance/evidence/orion-v3-hf6-tiered-discovery-promotion-20260820.json",
  "governance/owner-authorizations/2026-08-18-mtfx-paper-position-capacity-10.json",
  "governance/owner-authorizations/2026-09-11-v2-risk-2pct-10pct.json",
  "governance/evidence/v2-risk-2pct-10pct-20260911.json",
  "agents/nexus/data/mtfx-tier1-event-calendar.json",
  "governance/owner-authorizations/2026-08-06-mtfx-broadcast-policy.json",
  "governance/owner-authorizations/2026-08-07-mtfx-on-demand-only.json",
  "governance/owner-authorizations/2026-08-07-mtfx-entry-alert-only.json",
  "governance/owner-authorizations/2026-08-07-mtfx-background-entry-alert.json",
  "governance/owner-authorizations/2026-08-07-mtfx-local-entry-notifier.json",
  "governance/owner-authorizations/2026-08-08-mtfx-immediate-entry-notifier.json",
  "governance/owner-authorizations/2026-08-10-mtfx-complete-entry-brief.json",
  "governance/owner-authorizations/2026-08-18-mtfx-modular-on-demand-views.json",
  "governance/owner-authorizations/2026-08-10-mtfx-retire-tp-control-book.json",
  "governance/owner-authorizations/2026-08-07-context-memory-hygiene.json",
  "governance/owner-authorizations/2026-08-07-session-broadcast-host-archive.json",
  "governance/owner-authorizations/2026-08-07-paper-to-live-strict-evaluation.json",
  "governance/owner-authorizations/2026-08-22-aegis-prime-clean-main-thread-rotation.json",
  "governance/owner-authorizations/2026-08-22-orion-v3-clean-main-thread-rotation.json",
  "governance/owner-authorizations/2026-08-22-replaced-main-thread-archive-alignment.json",
  "governance/owner-authorizations/2026-08-23-aegis-prime-context-hygiene-main-thread-rotation.json",
  "governance/owner-authorizations/2026-08-26-aegis-prime-context-hygiene-main-thread-rotation.json",
  "governance/owner-authorizations/2026-09-02-aegis-v2-v3-context-hygiene-rotation.json",
  "governance/owner-authorizations/2026-09-04-aegis-prime-context-hygiene-main-thread-rotation.json",
  "governance/evidence/aegis-prime-clean-main-thread-rotation-20260822.json",
  "governance/evidence/orion-v3-clean-main-thread-rotation-20260822.json",
  "governance/evidence/replaced-main-thread-archive-alignment-20260822.json",
  "governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260823.json",
  "governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260826.json",
  "governance/evidence/aegis-v2-v3-context-hygiene-rotation-20260902.json",
  "governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260904.json",
  "governance/owner-authorizations/2026-08-21-orion-v4-cwr11-cost-floor-exact-rr.json",
  "governance/owner-authorizations/2026-08-21-orion-v4-rg2-independent-range-strategy.json",
  "governance/owner-authorizations/2026-08-22-orion-v4-mtfx-r20-import-and-activation.json",
  "governance/owner-authorizations/2026-08-22-orion-v4-mtfx-r21-alt-profit-retention.json",
  "governance/owner-authorizations/2026-08-22-orion-v4-risk-2pct-10pct.json",
  "governance/evidence/orion-v4-risk-2pct-10pct-20260822.json",
  "governance/owner-authorizations/2026-08-24-orion-v4-v2-execution-parity-except-demo-market-risk.json",
  "governance/evidence/orion-v4-v2-execution-parity-20260824.json",
  "governance/owner-authorizations/2026-08-22-mtfx-r21-alt-profit-retention.json",
  "governance/owner-authorizations/2026-08-28-mtfx-r22-balanced-profit-realization.json",
  "governance/evidence/mtfx-r22-balanced-profit-realization-v2-20260828.json",
  "governance/owner-authorizations/2026-09-05-orion-v2-account-equity-lock-shadow.json",
  "governance/evidence/orion-v2-account-equity-lock-shadow-20260905.json",
  "governance/evidence/orion-v2-account-equity-lock-shadow-remediation-required-20260905.json",
  "governance/evidence/orion-v2-account-equity-lock-shadow-rolling-20260905.json",
  "governance/evidence/manifests/orion-v2-account-equity-lock-shadow-v99-source-manifest.json",
  "app/v2-ledger/account-shadow/rolling.mjs",
  "app/v2-ledger/account-shadow/persistence.mjs",
  "tests/v2-account-rolling.test.mjs",
  "tests/v2-account-shadow-persistence.test.mjs",
  "governance/owner-authorizations/2026-08-21-all-account-presentation-terminology-neutralization.json",
  "governance/owner-authorizations/2026-08-21-orion-v3-equity-learning-curve-monitor.json",
  "governance/owner-authorizations/2026-08-22-orion-v3-equity-live-sync-and-compact-ui.json",
  "governance/owner-authorizations/2026-08-22-orion-v3-monitor-name-and-invocation.json",
  "governance/owner-authorizations/2026-08-22-orion-v3-monitor-candidates-and-readable-typography.json",
  "governance/owner-authorizations/2026-08-24-orion-v3-equity-account-reconciliation-correction.json",
  "governance/owner-authorizations/2026-08-22-all-monitor-presentation-sync.json",
  "governance/owner-authorizations/2026-08-22-orion-v4-distinct-spatial-monitor.json",
  "governance/owner-authorizations/2026-08-25-orion-v4-quant-console-monitor-redesign.json",
  "governance/owner-authorizations/2026-08-22-orion-v2-monitor-hourly-equidistant-curve.json",
  "governance/owner-authorizations/2026-08-22-orion-v2-monitor-mobile-curve-annotation-cleanup.json",
  "governance/owner-authorizations/2026-08-22-all-monitor-trading-terminal-typography.json",
  "governance/owner-authorizations/2026-08-22-all-monitor-hourly-equidistant-curves.json",
  "governance/presentation-contracts/all-monitor-sync-contract-v1.json",
  "governance/evidence/all-monitor-presentation-sync-20260822.json",
  "governance/evidence/orion-v4-distinct-spatial-monitor-20260822.json",
  "governance/evidence/orion-v4-quant-console-monitor-redesign-20260825.json",
  "governance/evidence/orion-v2-monitor-hourly-equidistant-curve-20260822.json",
  "governance/evidence/orion-v2-monitor-mobile-curve-annotation-cleanup-20260822.json",
  "governance/evidence/all-monitor-trading-terminal-typography-20260822.json",
  "governance/evidence/all-monitor-hourly-equidistant-curves-20260822.json",
  "governance/evidence/orion-v3-monitor-candidates-readable-typography-20260822.json",
  "governance/evidence/orion-v3-equity-account-reconciliation-correction-20260825.json",
  "governance/owner-authorizations/2026-08-22-owner-mobile-monitor-chat-links.json",
  "governance/owner-authorizations/2026-08-22-orion-v2-monitor-current-labels.json",
  "governance/owner-authorizations/2026-08-23-orion-v2-monitor-candidate-progress-bars.json",
  "governance/evidence/orion-v2-monitor-candidate-progress-bars-20260823.json",
  "governance/owner-authorizations/2026-08-23-orion-v2-monitor-signed-zero-axis.json",
  "governance/evidence/orion-v2-monitor-signed-zero-axis-20260823.json",
  "governance/owner-authorizations/2026-08-23-orion-v2-monitor-position-layout-readability.json",
  "governance/evidence/orion-v2-monitor-position-layout-readability-20260823.json",
  "experiments/v4-independent-range-reversion/config.json",
  "experiments/v4-mtfx-r20/config.json",
  "governance/owner-authorizations/2026-08-16-binance-usdm-testnet-readonly-reconciliation.json",
  "governance/owner-authorizations/2026-08-18-binance-usdm-demo-hmac-and-testnet-trading-request.json",
  "governance/owner-authorizations/2026-08-18-binance-usdm-free-replay-mcp.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-binance-usdm-demo-development.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-binance-usdm-demo-immediate-trading-cutover.json",
  "governance/owner-authorizations/2026-08-18-v2-v3-central-strategy-distribution.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-account-scan-and-presentation.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-account-capital-5000.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-high-frequency-1h15m5m-r1.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-hf2-15m-runner.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-hf3-candidate-queue.json",
  "governance/owner-authorizations/2026-08-19-orion-v3-hf4-entry-quality-guards.json",
  "governance/owner-authorizations/2026-08-19-orion-v3-hf5-intersection-range-guards.json",
  "governance/owner-authorizations/2026-08-20-orion-v3-hf6-tiered-discovery-promotion.json",
  "governance/owner-authorizations/2026-08-21-orion-v3-hf8-hf3-confirmation-light-chase-guard.json",
  "governance/owner-authorizations/2026-08-26-orion-v3-hf9-independent-lineage-reentry-attribution.json",
  "governance/evidence/orion-v3-hf9-pre-cutover-baseline-20260826.json",
  "governance/evidence/orion-v3-hf9-independent-lineage-reentry-attribution-20260826.json",
  "governance/owner-authorizations/2026-08-26-orion-v3-hf10-two-close-persistence-confirmation.json",
  "governance/evidence/orion-v3-hf10-pre-cutover-baseline-20260826.json",
  "governance/evidence/orion-v3-hf10-two-close-persistence-confirmation-20260826.json",
  "governance/owner-authorizations/2026-08-26-orion-v3-hf11-true-4h-market-state-gate.json",
  "governance/owner-authorizations/2026-09-14-orion-v3-hf13-dual-z.json",
  "governance/owner-authorizations/2026-09-14-orion-v3-hf14-single-z.json",
  "governance/evidence/manifests/v3-hf14-shared-verifier-20260914.json",
  "governance/evidence/orion-v3-hf14-single-z-20260914.json",
  "reports/strategy-research/20260914-v3-hf14/STRATEGY.md",
  "scripts/verify-v3-hf14-successor.mjs",
  "tests/v3-hf14-successor.test.mjs",
  "tests/v3-hf14-single-z.test.mjs",
  "governance/evidence/orion-v3-hf11-pre-cutover-baseline-20260826.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-hf1-10x-independent-governance.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-hf1-automated-binance-demo-execution.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-shadow-kelly-reference.json",
  "governance/owner-authorizations/2026-08-20-orion-v3-shadow-kelly-automatic-version-sync.json",
  "governance/owner-authorizations/2026-08-20-orion-v4-range-strategy-initialization.json",
  "governance/owner-authorizations/2026-08-20-orion-v4-binance-usdm-demo-readonly-datasource.json",
  "governance/owner-authorizations/2026-08-20-orion-v4-binance-usdm-demo-execution-platform.json",
  "governance/owner-authorizations/2026-08-18-orion-v3-fee-ledger-presentation.json",
  "governance/owner-authorizations/2026-08-20-orion-v3-equity-attribution-income-ledger.json",
  "governance/evidence/orion-v3-equity-attribution-optimization-20260820.json",
  "governance/owner-authorizations/2026-08-19-orion-v3-binance-demo-leverage-alignment.json",
  "governance/owner-authorizations/2026-08-07-mtfx-factor-mining.json",
  "governance/owner-authorizations/2026-08-08-mtfx-cross-displacement-factor.json",
  "governance/owner-authorizations/2026-08-08-mtfx-dual-price-shadow-confirmation.json",
  "governance/owner-authorizations/2026-08-10-mtfx-non-entry-post-path-factors.json",
  "governance/owner-authorizations/2026-08-07-mtfx-daily-loss-gate-removed.json",
  "governance/owner-authorizations/2026-08-07-mtfx-loss-gates-removed.json",
  "experiments/v2-mtf-trendline-intersection/config.json",
  "experiments/v3-mtf-high-frequency/config.json",
  "agents/orion-v2/paper/config.json",
  "agents/orion-v2/paper/paper-daemon.mjs",
  "integrations/binance-usdm-testnet/read-only-reconciler.mjs",
  "experiments/v4-range-mean-reversion/src/demo-account.mjs",
  "experiments/v4-range-mean-reversion/src/execution-gateway.mjs",
  "experiments/v4-range-mean-reversion/src/execution-preflight.mjs",
  "experiments/v4-range-mean-reversion/src/execution-report.mjs",
  "experiments/v4-range-mean-reversion/execution-platform.json",
  "integrations/binance-free-replay/src/market-data.mjs",
  "integrations/binance-free-replay/src/backtest.mjs",
  "integrations/binance-free-replay/src/server.mjs",
  "integrations/binance-free-replay/package-lock.json",
  ".codex/config.toml",
  "experiments/v2-execution-reality/testnet-gate.json",
  "integrations/crypto-regime-monitor/tradingview/crypto_regime_v1.pine",
  "tradingview/orion_v2_paper_observer.pine",
  "scripts/session-broadcast-archive.mjs",
];

for (const relative of required) {
  await fs.access(path.join(root, relative));
}

const current = JSON.parse(await fs.readFile(path.join(root, "governance/current-state.json"), "utf8"));
// Validate the live successor separately; old release evidence uses authenticated historical bytes only.
const s1R221Iq1Successor = await loadS1R221Iq1Successor(root, current);
const s2ProfitRetentionSuccessor = await loadS2ProfitRetentionSuccessor(root, current, s1R221Iq1Successor);
const iq1Successor = await loadS2CompatibleIq1(root, current, s2ProfitRetentionSuccessor, s1R221Iq1Successor);
const iq1HistoricalSource = (file, bytes) => iq1Successor ? iq1Successor.normalize(file, bytes) : bytes;
const v3Hf14SharedSuccessor = await loadIq1CompatibleHf14(root, current, iq1Successor);
const hf14HistoricalSource = (file, bytes) => {
  const iq1Bytes = iq1HistoricalSource(file, bytes);
  return v3Hf14SharedSuccessor ? v3Hf14SharedSuccessor.normalize(file, iq1Bytes) : iq1Bytes;
};
const aegisRotationSuccessor = await loadAegisRotation(root, current, hf14HistoricalSource);
const historicalSource = (file, bytes) => {
  const hf14Bytes = hf14HistoricalSource(file, bytes);
  return aegisRotationSuccessor ? aegisRotationSuccessor.normalize(file, hf14Bytes) : hf14Bytes;
};
const productionTopologyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-04-local-simulation-demo-server-production-topology.json"), "utf8"));
const productionTopologyEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/local-simulation-demo-server-production-topology-20260904.json"), "utf8"));
const productionReadOnlyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-08-binance-production-server-only-readonly-deployment.json"), "utf8"));
const productionReadOnlyEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/binance-production-server-only-readonly-deployment-20260908.json"), "utf8"));
const s1SpotToUsdmTransferAuthorization = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-09-s1-spot-to-usdm-full-balance-transfer.json"), "utf8"));
const s1SpotToUsdmTransferEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/s1-spot-to-usdm-full-balance-transfer-20260909.json"), "utf8"));
const productionReadOnlyConfig = JSON.parse(await fs.readFile(path.join(root, "agents/orion-live/binance-prod/config.json"), "utf8"));
const runtime = JSON.parse(await fs.readFile(path.join(root, "agents/orion-v2/paper/config.json"), "utf8"));
let v2MonitorLayoutSuccessor = null;
let v2MonitorLayoutSourceBytes = null;
if (current.communications?.v2MonitorInformationLayout) {
  const [authorization, evidence, manifest] = await Promise.all([V2_LAYOUT_AUTHORIZATION_PATH, V2_LAYOUT_EVIDENCE_PATH, V2_LAYOUT_MANIFEST_PATH]
    .map(async (file) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"))));
  const sourcePaths = [...V2_LAYOUT_CHANGED_PATHS, ...V2_LAYOUT_ADDED_PATHS,
    ...V2_LAYOUT_CHANGED_PATHS.map((file) => V2_LAYOUT_BEFORE_ROOT + file)];
  v2MonitorLayoutSourceBytes = Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, await fs.readFile(path.join(root, file))])));
  v2MonitorLayoutSourceBytes["scripts/verify-migration.mjs"] = historicalSource("scripts/verify-migration.mjs", v2MonitorLayoutSourceBytes["scripts/verify-migration.mjs"]);
  const predecessorManifestBytes = await fs.readFile(path.join(root, V2_R221_MANIFEST_PATH));
  v2MonitorLayoutSuccessor = verifyV2MonitorLayoutMigration({ current, authorization, evidence, manifest,
    sourceBytes: v2MonitorLayoutSourceBytes, predecessorManifestBytes });
}
let v2R221Successor = null;
let v2R221SourceBytes = null;
if (current.executionDomains?.orionV2Paper?.executionRelease) {
  const [authorization, evidence, manifest] = await Promise.all([V2_R221_AUTHORIZATION_PATH, V2_R221_EVIDENCE_PATH, V2_R221_MANIFEST_PATH]
    .map(async (file) => JSON.parse(await fs.readFile(path.join(root, file), "utf8"))));
  const sourcePaths = [...V2_R221_CHANGED_PATHS, ...V2_R221_ADDED_PATHS,
    ...V2_R221_CHANGED_PATHS.map((file) => V2_R221_BEFORE_ROOT + file),
    "agents/orion-v2/paper/paper-engine.mjs", "agents/orion-v2/paper/r21-integrity.mjs"];
  v2R221SourceBytes = Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, await fs.readFile(path.join(root, file))])));
  for (const file of ["scripts/verify-migration.mjs", "agents/orion-v2/paper/paper-daemon.mjs"])
    v2R221SourceBytes[file] = historicalSource(file, v2R221SourceBytes[file]);
  const predecessorBytes = Object.fromEntries(await Promise.all(V2_R221_PREDECESSOR_PATHS.map(async (file) => [file, await fs.readFile(path.join(root, file))])));
  if (v2MonitorLayoutSuccessor) {
    for (const filePath of V2_LAYOUT_CHANGED_PATHS) {
      const prior = manifest.files.find((file) => file.path === filePath)?.after;
      if (!matchesV2MonitorLayoutSuccessor(v2MonitorLayoutSuccessor, filePath, prior, v2R221SourceBytes[filePath]))
        throw new Error(`V2_MONITOR_LAYOUT_R221_LINK_INVALID:${filePath}`);
      v2R221SourceBytes[filePath] = v2MonitorLayoutSourceBytes[V2_LAYOUT_BEFORE_ROOT + filePath];
    }
  }
  v2R221Successor = verifyV2R221ReleaseMigration({ current, runtime, authorization, evidence, manifest, sourceBytes: v2R221SourceBytes, predecessorBytes });
}
const r221SourceMatches = (filePath, expected, bytes) => {
  bytes = historicalSource(filePath, bytes);
  const original = v2R221Successor?.files.find((file) => file.path === filePath)?.after;
  const priorBytes = matchesV2MonitorLayoutSuccessor(v2MonitorLayoutSuccessor, filePath, original, bytes)
    ? v2MonitorLayoutSourceBytes[V2_LAYOUT_BEFORE_ROOT + filePath] : bytes;
  return matchesV2R221SourceSuccessor(v2R221Successor, filePath, expected, priorBytes);
};

const pause = JSON.parse(await fs.readFile(path.join(root, "archive/runtime-snapshots/orion-v2/kill-switch.json"), "utf8"));
const mtfx = JSON.parse(await fs.readFile(path.join(root, "experiments/v2-mtf-trendline-intersection/config.json"), "utf8"));
const authorization = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-06-mtfx-price-time-structure-0.5.0.json"), "utf8"));
const priorImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-06-mtfx-hierarchical-parent-r1.json"), "utf8"));
const continuationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-06-mtfx-continuation-lineage-r2.json"), "utf8"));
const balancedLeadDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-06-mtfx-balanced-lead-window-r3.json"), "utf8"));
const oneSidedImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-one-sided-expansion-r4.json"), "utf8"));
const structureHygieneDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-structure-hygiene-h1.json"), "utf8"));
const postCrossImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-post-cross-confirmation-r5.json"), "utf8"));
const multiAnchorImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-multi-anchor-consensus-r6.json"), "utf8"));
const r7ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-08-mtfx-deferred-protective-structure-r7.json"), "utf8"));
const r8ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-10-mtfx-relaxed-price-confirmation-r8.json"), "utf8"));
const r9ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-11-mtfx-one-hour-protective-stop-r9.json"), "utf8"));
const r10ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-13-mtfx-cross-close-buffer-r10.json"), "utf8"));
const r11ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-13-mtfx-intersection-buffer-stop-r11.json"), "utf8"));
const r12ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-13-mtfx-two-bar-cross-buffer-r12.json"), "utf8"));
const r13ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-15-mtfx-tier1-event-entry-freeze-r13.json"), "utf8"));
const r14ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-17-mtfx-single-symbol-exposure-r14.json"), "utf8"));
const r15ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-17-mtfx-current-structure-replacement-r15.json"), "utf8"));
const r16ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-mtfx-current-structure-capacity-r16.json"), "utf8"));
const r17ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-mtfx-soft-profit-lock-r17.json"), "utf8"));
const r18ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-19-mtfx-entry-quality-guards-r18.json"), "utf8"));
const r19ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-21-mtfx-r19-confirmed-close-entry-and-monitor-recovery.json"), "utf8"));
const r20ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-mtfx-r20-cost-efficiency-gate.json"), "utf8"));
const r21ImplementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-mtfx-r21-alt-profit-retention.json"), "utf8"));
const implementationDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-28-mtfx-r22-balanced-profit-realization.json"), "utf8"));
const tier1EventCalendar = JSON.parse(await fs.readFile(path.join(root, "agents/nexus/data/mtfx-tier1-event-calendar.json"), "utf8"));
const priorBroadcastPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-06-mtfx-broadcast-policy.json"), "utf8"));
const broadcastPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-on-demand-only.json"), "utf8"));
const entryAlertPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-entry-alert-only.json"), "utf8"));
const backgroundEntryAlertPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-background-entry-alert.json"), "utf8"));
const localEntryNotifierPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-local-entry-notifier.json"), "utf8"));
const immediateEntryNotifierPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-08-mtfx-immediate-entry-notifier.json"), "utf8"));
const completeEntryBriefPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-10-mtfx-complete-entry-brief.json"), "utf8"));
const modularOnDemandViewsPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-mtfx-modular-on-demand-views.json"), "utf8"));
const retireTpControlBookPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-10-mtfx-retire-tp-control-book.json"), "utf8"));
const contextMemoryHygienePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-context-memory-hygiene.json"), "utf8"));
const sessionBroadcastArchivePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-session-broadcast-host-archive.json"), "utf8"));
const paperToLiveEvaluationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-paper-to-live-strict-evaluation.json"), "utf8"));
const testnetReadOnlyReconciliationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-16-binance-usdm-testnet-readonly-reconciliation.json"), "utf8"));
const testnetDemoCredentialPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-binance-usdm-demo-hmac-and-testnet-trading-request.json"), "utf8"));
const testnetReadOnlyGate = JSON.parse(await fs.readFile(path.join(root, "experiments/v2-execution-reality/testnet-gate.json"), "utf8"));
const binanceFreeReplayPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-binance-usdm-free-replay-mcp.json"), "utf8"));
const orionV3BinanceDemoPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-orion-v3-binance-usdm-demo-immediate-trading-cutover.json"), "utf8"));
const v2V3CentralDistributionPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-v2-v3-central-strategy-distribution.json"), "utf8"));
const orionV3AccountPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-orion-v3-account-capital-5000.json"), "utf8"));
const orionV3ParitySeparationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-19-orion-v3-hf5-intersection-range-guards.json"), "utf8"));
const priorOrionV3HighFrequencyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-26-orion-v3-hf10-two-close-persistence-confirmation.json"), "utf8"));
const historicalOrionV3Hf11Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-26-orion-v3-hf11-true-4h-market-state-gate.json"), "utf8"));
const historicalOrionV3Hf13Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-14-orion-v3-hf13-dual-z.json"), "utf8"));
const orionV3HighFrequencyStrategy = JSON.parse(await fs.readFile(path.join(root, "experiments/v3-mtf-high-frequency/config.json"), "utf8"));
const orionV3ReleasePolicy = releasePolicy(orionV3HighFrequencyStrategy);
if (!orionV3ReleasePolicy) throw new Error("ORION_V3_RELEASE_POLICY_INVALID");
const orionV3HighFrequencyPolicy = JSON.parse(await fs.readFile(path.join(root, orionV3ReleasePolicy.authorizationPath), "utf8"));
const orionV3AutomaticExecutionPolicy = orionV3HighFrequencyPolicy;
const priorOrionV3ShadowKellyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-orion-v3-shadow-kelly-reference.json"), "utf8"));
const orionV3ShadowKellyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v3-shadow-kelly-automatic-version-sync.json"), "utf8"));
const orionV3FeeLedgerPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-orion-v3-fee-ledger-presentation.json"), "utf8"));
const orionV3EquityAttributionPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v3-equity-attribution-income-ledger.json"), "utf8"));
const orionV3LeverageAlignmentPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-19-orion-v3-binance-demo-leverage-alignment.json"), "utf8"));
const orionV4RetiredReadOnlyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v4-binance-usdm-demo-readonly-datasource.json"), "utf8"));
const orionV4DataSourcePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v4-binance-usdm-demo-execution-platform.json"), "utf8"));
const orionV4PriorPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-21-orion-v4-cwr11-cost-floor-exact-rr.json"), "utf8"));
const orionV4RetiredPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-21-orion-v4-rg2-independent-range-strategy.json"), "utf8"));
const orionV4R20Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-mtfx-r20-import-and-activation.json"), "utf8"));
const orionV4R21Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-mtfx-r21-alt-profit-retention.json"), "utf8"));
const orionV4RiskPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-risk-2pct-10pct.json"), "utf8"));
const orionV4RiskEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-risk-2pct-10pct-20260822.json"), "utf8"));
const orionV4ParityPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-24-orion-v4-v2-execution-parity-except-demo-market-risk.json"), "utf8"));
const orionV4Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-29-orion-v4-mtfx-r22-v2-full-rule-parity.json"), "utf8"));
const orionV4ParityEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-mtfx-r22-v2-full-rule-parity-20260829.json"), "utf8"));
const accountPresentationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-21-all-account-presentation-terminology-neutralization.json"), "utf8"));
const orionV3EquityCurvePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-21-orion-v3-equity-learning-curve-monitor.json"), "utf8"));
const orionV3EquitySyncPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v3-equity-live-sync-and-compact-ui.json"), "utf8"));
const orionV3MonitorInvocationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v3-monitor-name-and-invocation.json"), "utf8"));
const orionV3MonitorCandidatesPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v3-monitor-candidates-and-readable-typography.json"), "utf8"));
const orionV3EquityAccountCorrectionPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-24-orion-v3-equity-account-reconciliation-correction.json"), "utf8"));
const orionV3EquityAccountCorrectionEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v3-equity-account-reconciliation-correction-20260825.json"), "utf8"));
const orionV3Hf10MonitorCorrectionPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-26-orion-v3-hf10-monitor-live-sync-correction.json"), "utf8"));
const orionV3Hf10MonitorCorrectionEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v3-hf10-monitor-live-sync-correction-20260826.json"), "utf8"));
const ownerMobileMonitorPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-owner-mobile-monitor-chat-links.json"), "utf8"));
const monitorEntryHubPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-monitor-entry-hub-thread.json"), "utf8"));
const monitorEntryHubEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/monitor-entry-hub-thread-20260822.json"), "utf8"));
const monitorEntryHubMigrationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-monitor-entry-hub-local-directory-migration.json"), "utf8"));
const monitorEntryHubMigrationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/monitor-entry-hub-local-directory-migration-20260822.json"), "utf8"));
const monitorEntryHubVisibilityPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-monitor-entry-hub-directory-visibility-correction.json"), "utf8"));
const monitorEntryHubVisibilityEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/monitor-entry-hub-directory-visibility-correction-20260822.json"), "utf8"));
const monitorHubV5Policy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-05-monitor-entry-hub-v5.json"), "utf8"));
const monitorHubV5Evidence = JSON.parse(await fs.readFile(path.join(root, monitorHubV5Policy.evidence), "utf8"));
const monitorHubCurrent = current.communications.ownerMonitorInvocation;
if (monitorHubV5Policy.status !== "ACTIVE" ||
    monitorHubCurrent.v5AuthorizationId !== monitorHubV5Policy.id ||
    monitorHubCurrent.dedicatedThreadId !== monitorHubV5Policy.scope.threadId ||
    monitorHubCurrent.dedicatedThreadTitle !== monitorHubV5Policy.scope.threadTitle ||
    monitorHubCurrent.routes["V5 监视器"] !== monitorHubV5Policy.scope.registeredUrl ||
    monitorHubCurrent.routeAvailability["V5 监视器"] !== monitorHubV5Policy.scope.productionAvailability ||
    monitorHubCurrent.latestEvidence !== monitorHubV5Policy.evidence ||
    monitorHubV5Policy.scope.route !== "/v5-au" ||
    monitorHubV5Policy.boundaries.routingOnly !== true ||
    Object.entries(monitorHubV5Policy.boundaries).some(([key, value]) => key !== "routingOnly" && value !== false) ||
    monitorHubV5Evidence.authorizationId !== monitorHubV5Policy.id ||
    monitorHubV5Evidence.thread.id !== monitorHubCurrent.dedicatedThreadId ||
    Object.values(monitorHubV5Evidence.boundaries).some((value) => value !== false)) {
  throw new Error("MONITOR_ENTRY_HUB_V5_ROUTING_AUTHORIZATION_INVALID");
}
const orionV2MonitorLabelsPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v2-monitor-current-labels.json"), "utf8"));
const orionV4GovernanceIntegrationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v4-governance-session-integration.json"), "utf8"));
const aegisPrimeThreadRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-aegis-prime-clean-main-thread-rotation.json"), "utf8"));
const orionV3ThreadRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v3-clean-main-thread-rotation.json"), "utf8"));
const replacedMainThreadArchiveAlignmentPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-replaced-main-thread-archive-alignment.json"), "utf8"));
const previousAegisPrimeContextHygieneRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-23-aegis-prime-context-hygiene-main-thread-rotation.json"), "utf8"));
const aegisPrimeContextHygieneRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-26-aegis-prime-context-hygiene-main-thread-rotation.json"), "utf8"));
const aegisV2V3ContextHygieneRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-02-aegis-v2-v3-context-hygiene-rotation.json"), "utf8"));
const priorSeptemberAegisRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-04-aegis-prime-context-hygiene-main-thread-rotation.json"), "utf8"));
const currentAegisPrimeContextHygieneRotationPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-11-aegis-prime-context-hygiene-main-thread-rotation.json"), "utf8"));
const aegisPrimeThreadRotationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/aegis-prime-clean-main-thread-rotation-20260822.json"), "utf8"));
const orionV3ThreadRotationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v3-clean-main-thread-rotation-20260822.json"), "utf8"));
const replacedMainThreadArchiveAlignmentEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/replaced-main-thread-archive-alignment-20260822.json"), "utf8"));
const aegisPrimeContextHygieneRotationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260826.json"), "utf8"));
const aegisV2V3ContextHygieneRotationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/aegis-v2-v3-context-hygiene-rotation-20260902.json"), "utf8"));
const currentAegisPrimeContextHygieneRotationEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/aegis-prime-context-hygiene-main-thread-rotation-20260911.json"), "utf8"));
const orionV3V4TieredScanPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v3-v4-tiered-scan-universe30.json"), "utf8"));
const orionV4Config = JSON.parse(await fs.readFile(path.join(root, "experiments/v4-mtfx-r20/config.json"), "utf8"));
const orionV4Stopped = current.orionV4OwnerStop?.status === "STOPPED_BY_OWNER";
if (orionV4Stopped) {
  const { validateV4OwnerStop } = await import("./lib/v4-owner-stop.mjs");
  const read = async (name) => JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
  const errors = validateV4OwnerStop({ current,
    authorization: await read("governance/owner-authorizations/2026-09-09-orion-v4-stop.json"),
    scanner: await read(".runtime/orion-v4-binance-demo/scanner.pid.json"),
    supervisor: await read(".runtime/orion-v4-binance-demo/supervisor.pid.json"),
    marker: await read(".runtime/orion-v4-binance-demo/supervisor.stop.json"),
    processAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } },
  });
  if (errors.length) throw new Error(errors.join(","));
}
const orionV4ParityStatus = current.orionV4RangeResearch?.v2FullRuleParityDirective?.status;
const orionV4ParityActive = orionV4ParityStatus === "ACTIVE_VERIFIED_RUNNING_RECONCILED";
const orionV4ParityEngaged = orionV4Stopped || orionV4ParityActive || orionV4ParityStatus === "CUTOVER_VALIDATION_IN_PROGRESS";
const orionV3RiskPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-20-orion-v3-aggressive-growth-risk-1pct-10pct.json"), "utf8"));
const orionV2MonitorRecoveryPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-19-orion-v2-monitor-recovery.json"), "utf8"));
const orionV3Runtime = JSON.parse(await fs.readFile(path.join(root, "agents/orion-v3/binance-demo/config.json"), "utf8"));
const orionV3ReleaseMigration = verifyV3ReleaseMigration({ current, runtime: orionV3Runtime, strategy: orionV3HighFrequencyStrategy, authorization: orionV3HighFrequencyPolicy, hf11Authorization: historicalOrionV3Hf11Policy });
const factorMiningPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-factor-mining.json"), "utf8"));
const crossDisplacementFactorPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-08-mtfx-cross-displacement-factor.json"), "utf8"));
const dualPriceShadowPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-08-mtfx-dual-price-shadow-confirmation.json"), "utf8"));
const nonEntryPostPathPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-10-mtfx-non-entry-post-path-factors.json"), "utf8"));
const dailyLossGateDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-daily-loss-gate-removed.json"), "utf8"));
const lossGatesRemovedDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-07-mtfx-loss-gates-removed.json"), "utf8"));
const positionCapacityDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-18-mtfx-paper-position-capacity-10.json"), "utf8"));
const v2Risk2Pct10PctDirective = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-11-v2-risk-2pct-10pct.json"), "utf8"));

if (!current.execution.paperOrdersAuthorized || current.execution.realOrdersAuthorized || !current.execution.automaticRestartAuthorized) {
  throw new Error("EXECUTION_SCOPE_MUST_BE_PAPER_ONLY");
}
if (
  productionTopologyPolicy.status !== "ACTIVE_TOPOLOGY_INTENT_PENDING_LIVE_ACTIVATION" ||
  productionTopologyPolicy.amends !== "OWNER-DIRECTIVE-QUANT-SERVER-DEPLOYMENT-PROFILE-20260903" ||
  productionTopologyPolicy.topology?.localHostRole !== "TEST_SIMULATION_RESEARCH_AND_HISTORICAL_EVIDENCE" ||
  productionTopologyPolicy.topology?.quantServerRole !== "PRODUCTION_EXECUTION_TARGET_24X7" ||
  productionTopologyPolicy.topology?.existingPaperOrDemoRuntimeMigrationAllowed !== false ||
  productionTopologyPolicy.topology?.automaticOrderMirroringAllowed !== false ||
  productionTopologyPolicy.tickBboBoundary?.historicalLocalRawEvidenceUploadToProductionAllowed !== false ||
  productionTopologyPolicy.tickBboBoundary?.boundedRetentionRequired !== true ||
  productionTopologyPolicy.tickBboBoundary?.retentionParametersStatus !== "PROPOSED_PENDING_OWNER_CONFIRMATION" ||
  productionTopologyPolicy.tickBboBoundary?.openPositionAndPendingOperationEvidenceMayBeEvicted !== false ||
  productionTopologyPolicy.tickBboBoundary?.ledgerOrCompactDecisionEvidenceMayBeEvictedByRawCap !== false ||
  current.deploymentInfrastructure?.topologyAuthorizationId !== productionTopologyPolicy.id ||
  current.deploymentInfrastructure?.runtimeTopology?.localHostRole !== productionTopologyPolicy.topology.localHostRole ||
  current.deploymentInfrastructure?.runtimeTopology?.quantServerRole !== productionTopologyPolicy.topology.quantServerRole ||
  current.deploymentInfrastructure?.runtimeTopology?.existingPaperOrDemoRuntimeMigrationAllowed !== false ||
  current.deploymentInfrastructure?.tickBboRetention?.historicalLocalRawEvidenceUploadToProductionAllowed !== false ||
  current.deploymentInfrastructure?.tickBboRetention?.boundedRetentionRequired !== true ||
  current.deploymentInfrastructure?.tickBboRetention?.parametersStatus !== "ACTIVE_7_DAYS_60_GIB_HARD_LIMIT" ||
  current.deploymentInfrastructure?.tickBboRetention?.rawRetentionDays !== 7 ||
  current.deploymentInfrastructure?.tickBboRetention?.rawMaximumBytes !== 64424509440 ||
  current.deploymentInfrastructure?.tickBboRetention?.pinnedEvidenceEvictionAllowed !== false ||
  current.deploymentInfrastructure?.tickBboRetention?.rawCapMayDeleteLedgerOrCompactDecisionEvidence !== false ||
  current.execution.productionCredentialsAllowed !== true ||
  productionTopologyEvidence.authorizationId !== productionTopologyPolicy.id ||
  productionTopologyEvidence.stateDelta?.liveActivationAuthorized !== false ||
  productionTopologyEvidence.integrity?.serverChanged !== false ||
  productionTopologyEvidence.integrity?.productionEndpointsEnabled !== false ||
  productionTopologyEvidence.integrity?.realOrdersSubmitted !== false
) {
  throw new Error("LOCAL_SIMULATION_QUANT_SERVER_PRODUCTION_TOPOLOGY_INVALID");
}
if (accountPresentationPolicy.status !== "ACTIVE" ||
    current.ownerVisiblePresentationTerminology?.authorizationId !== accountPresentationPolicy.id ||
    current.ownerVisiblePresentationTerminology?.orionV2?.threadTitle !== "ORION V2｜MTFX 纸面交易" ||
    current.ownerVisiblePresentationTerminology?.orionV3?.threadTitle !== "ORION V3｜高频交易" ||
    current.ownerVisiblePresentationTerminology?.orionV4?.threadTitle !== orionV4Policy.presentation?.threadTitle ||
    current.orionV2Conversation?.activeThreadTitle !== accountPresentationPolicy.displayMapping?.orionV2?.threadTitle ||
    current.orionV3BinanceUsdmDemo?.threadTitle !== accountPresentationPolicy.displayMapping?.orionV3?.threadTitle ||
    current.orionV4RangeResearch?.threadTitle !== orionV4Policy.presentation?.threadTitle ||
    current.ownerVisiblePresentationTerminology?.orionV4?.overrideAuthorizationId !== orionV4Policy.id ||
    current.ownerVisiblePresentationTerminology?.internalEnvironmentIdentifiersChanged !== false ||
    current.ownerVisiblePresentationTerminology?.strategyRiskPositionOrderLedgerChanged !== false) {
  throw new Error("OWNER_VISIBLE_ACCOUNT_PRESENTATION_TERMINOLOGY_INVALID");
}
if (orionV3EquityCurvePolicy.status !== "ACTIVE" ||
    orionV3EquitySyncPolicy.status !== "PARTIALLY_SUPERSEDED" ||
    orionV3EquitySyncPolicy.object !== "ORION_V3_EQUITY_MONITOR_ONLY" ||
    orionV3MonitorInvocationPolicy.status !== "ACTIVE" ||
    orionV3MonitorInvocationPolicy.object !== "ORION_V3_OWNER_VISIBLE_MONITOR_ONLY" ||
    orionV3MonitorCandidatesPolicy.status !== "ACTIVE" ||
    orionV3MonitorCandidatesPolicy.object !== "ORION_V3_OWNER_VISIBLE_MONITOR_PRESENTATION_ONLY" ||
    orionV3EquityAccountCorrectionPolicy.status !== "ACTIVE" ||
    orionV3EquityAccountCorrectionPolicy.object !== "ORION_V3_BINANCE_DEMO_ACCOUNT_ATTRIBUTION_AND_MONITOR_PRESENTATION_ONLY" ||
    orionV3EquityAccountCorrectionPolicy.scope?.accountEquation !== "WALLET_BALANCE_PLUS_UNREALIZED_PNL_EQUALS_MARGIN_EQUITY" ||
    orionV3EquityAccountCorrectionPolicy.scope?.readOnly !== true ||
    orionV3EquityAccountCorrectionEvidence.authorizationId !== orionV3EquityAccountCorrectionPolicy.authorizationId ||
    orionV3EquityAccountCorrectionEvidence.productionDeployment?.versionNumber !== 79 ||
    orionV3EquityAccountCorrectionEvidence.productionDeployment?.deploymentStatus !== "SUCCEEDED" ||
    orionV3EquityAccountCorrectionEvidence.productionApiVerification?.accountingBridgeStatus !== "RECONCILED" ||
    orionV3EquityAccountCorrectionEvidence.productionApiVerification?.incomeHistoryComplete !== true ||
    orionV3EquityAccountCorrectionEvidence.productionApiVerification?.walletUnreconciledDifferenceUsdt !== 0 ||
    orionV3EquityAccountCorrectionEvidence.residentPublisherReload?.positionManagementFingerprintBefore !== orionV3EquityAccountCorrectionEvidence.residentPublisherReload?.positionManagementFingerprintAfter ||
    orionV3EquityAccountCorrectionEvidence.boundaries?.strategyChanged !== false ||
    orionV3EquityAccountCorrectionEvidence.boundaries?.riskChanged !== false ||
    orionV3EquityAccountCorrectionEvidence.boundaries?.positionOrOrderMutationByCorrection !== false ||
    orionV3EquityCurvePolicy.object !== "ORION_V3_ONLY" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.authorizationId !== orionV3EquityAccountCorrectionPolicy.authorizationId ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.liveSyncCorrectionAuthorizationId !== orionV3Hf10MonitorCorrectionPolicy.authorizationId ||
    orionV3Hf10MonitorCorrectionEvidence.authorizationId !== orionV3Hf10MonitorCorrectionPolicy.authorizationId ||
    orionV3Hf10MonitorCorrectionEvidence.onlineReadback?.positionCount !== 12 ||
    orionV3Hf10MonitorCorrectionEvidence.onlineReadback?.maximumOpenPositionsTotal !== 18 ||
    orionV3Hf10MonitorCorrectionEvidence.onlineReadback?.executionReconciliationStatus !== "RECONCILED" ||
    orionV3Hf10MonitorCorrectionEvidence.repair?.sitesVersion !== 88 ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.displayName !== "V3 监视器" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.ownerInvocation?.trigger !== "V3 监视器" ||
    ownerMobileMonitorPolicy.status !== "ACTIVE" ||
    ownerMobileMonitorPolicy.object !== "OWNER_MONITOR_INVOCATION_DELIVERY_SURFACE" ||
    monitorEntryHubPolicy.status !== "SUPERSEDED" ||
    monitorEntryHubPolicy.supersededBy !== monitorEntryHubMigrationPolicy.id ||
    monitorEntryHubPolicy.supplements !== ownerMobileMonitorPolicy.authorizationId ||
    monitorEntryHubPolicy.scope?.threadId !== "00000000-0000-4000-8000-000000000000" ||
    monitorEntryHubPolicy.scope?.dataSynchronizationMode !== "LIVE_PRODUCTION_MONITOR_URLS_NO_SNAPSHOT_CACHE" ||
    monitorEntryHubMigrationPolicy.status !== "ACTIVE" ||
    monitorEntryHubMigrationPolicy.supersedes !== monitorEntryHubPolicy.id ||
    monitorEntryHubMigrationPolicy.baseAuthorizationId !== ownerMobileMonitorPolicy.authorizationId ||
    monitorEntryHubMigrationPolicy.scope?.activeThreadId !== "00000000-0000-4000-8000-000000000000" ||
    monitorEntryHubMigrationPolicy.scope?.projectId !== "94c75a21-64eb-4f4e-b213-072171e3f71f" ||
    monitorEntryHubMigrationPolicy.scope?.workingDirectory !== "/path/to/your/project" ||
    monitorEntryHubMigrationPolicy.scope?.sameDirectoryAsAegisMainThread !== true ||
    monitorEntryHubMigrationPolicy.scope?.pinned !== true ||
    monitorEntryHubMigrationPolicy.scope?.presentationRevision !== "MONITOR-SYNC-5-20260822" ||
    monitorEntryHubMigrationPolicy.replacementChain?.replacedThreadArchived !== true ||
    monitorEntryHubMigrationPolicy.replacementChain?.replacedThreadDeleted !== false ||
    monitorEntryHubVisibilityPolicy.status !== "ACTIVE" ||
    monitorEntryHubVisibilityPolicy.supplements !== monitorEntryHubMigrationPolicy.id ||
    monitorEntryHubVisibilityPolicy.overrides?.field !== "scope.pinned" ||
    monitorEntryHubVisibilityPolicy.overrides?.replacementValue !== false ||
    monitorEntryHubVisibilityPolicy.scope?.activeThreadId !== monitorEntryHubMigrationPolicy.scope?.activeThreadId ||
    monitorEntryHubVisibilityPolicy.scope?.projectDirectoryListVisible !== true ||
    monitorEntryHubVisibilityPolicy.scope?.globalPinnedAreaContainsEntry !== false ||
    current.communications?.ownerMonitorInvocation?.authorizationId !== monitorEntryHubVisibilityPolicy.id ||
    current.communications?.ownerMonitorInvocation?.baseAuthorizationId !== ownerMobileMonitorPolicy.authorizationId ||
    current.communications?.ownerMonitorInvocation?.priorHubAuthorizationId !== monitorEntryHubPolicy.id ||
    current.communications?.ownerMonitorInvocation?.locationAuthorizationId !== monitorEntryHubMigrationPolicy.id ||
    current.communications?.ownerMonitorInvocation?.deliverySurface !== "DEDICATED_PROJECT_DIRECTORY_THREAD_PRIMARY_CURRENT_CHAT_FALLBACK" ||
    current.communications?.ownerMonitorInvocation?.dedicatedThreadId !== monitorEntryHubMigrationPolicy.scope?.activeThreadId ||
    current.communications?.ownerMonitorInvocation?.dedicatedThreadProjectId !== monitorEntryHubMigrationPolicy.scope?.projectId ||
    current.communications?.ownerMonitorInvocation?.dedicatedThreadWorkingDirectory !== monitorEntryHubMigrationPolicy.scope?.workingDirectory ||
    current.communications?.ownerMonitorInvocation?.sameDirectoryAsAegisMainThread !== true ||
    current.communications?.ownerMonitorInvocation?.dedicatedThreadPinned !== false ||
    current.communications?.ownerMonitorInvocation?.projectDirectoryListVisible !== true ||
    current.communications?.ownerMonitorInvocation?.globalPinnedAreaContainsEntry !== false ||
    current.communications?.ownerMonitorInvocation?.replacedThreadId !== monitorEntryHubPolicy.scope?.threadId ||
    current.communications?.ownerMonitorInvocation?.replacedThreadArchived !== true ||
    current.communications?.ownerMonitorInvocation?.replacedThreadDeleted !== false ||
    current.communications?.ownerMonitorInvocation?.currentChatFallbackRetained !== true ||
    current.communications?.ownerMonitorInvocation?.dataSynchronizationMode !== "LIVE_PRODUCTION_MONITOR_URLS_NO_SNAPSHOT_CACHE" ||
    current.communications?.ownerMonitorInvocation?.presentationRevision !== "MONITOR-SYNC-11-20260825" ||
    current.communications?.ownerMonitorInvocation?.defaultRightPanelAction !== false ||
    current.communications?.ownerMonitorInvocation?.routes?.["V2 监视器"] !== "https://your-cockpit.example.invalid" ||
    current.communications?.ownerMonitorInvocation?.routes?.["V3 监视器"] !== "https://your-cockpit.example.invalid" ||
    current.communications?.ownerMonitorInvocation?.routes?.["V4 监视器"] !== "https://your-cockpit.example.invalid" ||
    monitorEntryHubEvidence.authorizationId !== monitorEntryHubPolicy.id ||
    monitorEntryHubEvidence.result !== "ACTIVE_PINNED_ENTRY_THREAD" ||
    monitorEntryHubEvidence.thread?.pinned !== true ||
    monitorEntryHubEvidence.thread?.allThreeClickableLinksConfirmed !== true ||
    monitorEntryHubEvidence.synchronization?.monitorSnapshotCopiedOrCached !== false ||
    monitorEntryHubMigrationEvidence.authorizationId !== monitorEntryHubMigrationPolicy.id ||
    monitorEntryHubMigrationEvidence.result !== "ACTIVE_PINNED_ENTRY_THREAD_IN_AEGIS_LOCAL_DIRECTORY" ||
    monitorEntryHubMigrationEvidence.activeThread?.workingDirectory !== monitorEntryHubMigrationPolicy.scope?.workingDirectory ||
    monitorEntryHubMigrationEvidence.activeThread?.pinnedIndex !== 1 ||
    monitorEntryHubMigrationEvidence.replacedThread?.archived !== true ||
    monitorEntryHubMigrationEvidence.replacedThread?.deleted !== false ||
    monitorEntryHubMigrationEvidence.synchronization?.monitorSnapshotCopiedOrCached !== false ||
    monitorEntryHubVisibilityEvidence.authorizationId !== monitorEntryHubVisibilityPolicy.id ||
    monitorEntryHubVisibilityEvidence.result !== "ACTIVE_ENTRY_THREAD_VISIBLE_IN_AEGIS_PROJECT_DIRECTORY" ||
    monitorEntryHubVisibilityEvidence.thread?.pinned !== false ||
    monitorEntryHubVisibilityEvidence.thread?.projectDirectoryListContainsEntry !== true ||
    monitorEntryHubVisibilityEvidence.thread?.projectDirectoryListIndex !== 0 ||
    monitorEntryHubVisibilityEvidence.synchronization?.monitorSnapshotCopiedOrCached !== false ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.ownerInvocation?.authorizationId !== ownerMobileMonitorPolicy.authorizationId ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.ownerInvocation?.action !== "SEND_CLICKABLE_URL_IN_CURRENT_CHAT" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.route !== "/v3-equity" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.baselineUsdt !== 5000 ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.presentationMode !== orionV3ReleaseMigration.presentationMode ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.sourceUpdateMode !== "RESIDENT_60_SECOND_AUTHENTICATED_PUBLISH" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.serviceAccessTokenAuthorized !== true ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.staleAfterSeconds !== 120 ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.comparisonSeriesPresented !== false ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.visibleSummaryFields?.includes("WALLET_BALANCE") ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.visibleSummaryFields?.includes("WALLET_CHANGE_FROM_BASELINE") ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.accountEquation !== "WALLET_BALANCE_PLUS_UNREALIZED_PNL_EQUALS_MARGIN_EQUITY" ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.strategyLearningCurveExplicitlyNotAccountWalletBalance !== true ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.visibleSummaryFields?.includes("CURRENT_POSITION_SUMMARY") ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.visibleSummaryFields?.includes("CANDIDATE_PLAN_SUMMARY") ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.currentPositionSummaryPublished !== true ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.currentPositionMaximumRows !== 18 ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.hf11CohortIsolationPublished !== true ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.hf11CohortClassifications?.includes("PRE_HF11_BASELINE") ||
    !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.hf11CohortClassifications?.includes("HF11_FORWARD") ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.candidatePlanSummaryPublished !== true ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.candidatePlanMaximumRows !== 12 ||
    (!requiresSingleZ(orionV3HighFrequencyStrategy) &&
      (!current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.candidatePlanSummaryFields?.includes("DERIVED_4H_MARKET_STATE") ||
       !current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.candidatePlanSummaryFields?.includes("4H_GATE_RESULT"))) ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.minimumVisibleFontPixels !== 10 ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.credentialsOrderPayloadsPositionQuantitiesRawAnchorsRiskSizingOrHiddenReasoningPublished !== false ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.strategyRiskPositionOrderOrLifecycleChanged !== false ||
    current.orionV3BinanceUsdmDemo?.equityLearningCurveMonitor?.v2OrV4Changed !== false) {
  throw new Error("ORION_V3_EQUITY_LEARNING_CURVE_MONITOR_INVALID");
}
if (orionV2MonitorLabelsPolicy.status !== "ACTIVE" ||
    orionV2MonitorLabelsPolicy.object !== "ORION_V2_ONLINE_READ_ONLY_MONITOR_ONLY" ||
    orionV2MonitorLabelsPolicy.requiredPresentation?.currentImplementation !== "R20_COST_EFFICIENCY_GATE" ||
    orionV2MonitorLabelsPolicy.requiredPresentation?.hardCodedProtectiveStructureLabelAllowed !== false ||
    orionV2MonitorLabelsPolicy.requiredPresentation?.arrivalAndExpiryMustBeDistinct !== true ||
    orionV2MonitorLabelsPolicy.requiredPresentation?.rawInternalEnumsOwnerVisible !== false ||
    current.communications?.onlineMonitorLabels?.authorizationId !== orionV2MonitorLabelsPolicy.id ||
    current.communications?.onlineMonitorLabels?.implementationRevision !== mtfx.implementationRevision ||
    current.communications?.onlineMonitorLabels?.positionStopSource !== "ONLINE_POSITION_EVIDENCE" ||
    current.communications?.onlineMonitorLabels?.monitorHealthSource !== "WEBSOCKET_CONNECTION_AND_SNAPSHOT_FRESHNESS" ||
    current.communications?.onlineMonitorLabels?.hardCodedProtectiveStructureLabelAllowed !== false ||
    current.communications?.onlineMonitorLabels?.arrivalAndExpiryDistinct !== true ||
    current.communications?.onlineMonitorLabels?.rawInternalEnumsOwnerVisible !== false ||
    current.communications?.onlineMonitorLabels?.strategyRiskRuntimePositionOrderLedgerChanged !== false) {
  throw new Error("ORION_V2_ONLINE_MONITOR_LABELS_INVALID");
}
const ownerVisiblePresentationSources = [
  "app/layout.tsx",
  "app/v2-ledger/layout.tsx",
  "app/v2-ledger/page.tsx",
  "app/v2-ledger/labels.ts",
  "app/v3-equity/layout.tsx",
  "app/v3-equity/page.tsx",
  "app/v3-equity/v3-equity.module.css",
  "agents/orion-v2/paper/report.mjs",
  "agents/orion-v2/paper/paper-entry-alert.mjs",
  "agents/orion-v2/paper/event-risk-alert.mjs",
  "agents/orion-v2/paper/strong-candidate-alert.mjs",
  "agents/orion-v3/binance-demo/report.mjs",
  "agents/orion-v4/binance-demo/report.mjs",
  "scripts/render-v2-broadcast.mjs",
  "governance/presentation-contracts/mtfx-presentation-contract-v1.json"
];
for (const relative of ownerVisiblePresentationSources) {
  const source = (await fs.readFile(path.join(root, relative), "utf8"))
    .replaceAll("ACTUAL_BINANCE_DEMO_USER_TRADES", "INTERNAL_COMMISSION_EVIDENCE_ENUM");
  if (/模拟|Demo|DEMO|非真实资金|主网禁用|实盘禁用/.test(source)) {
    throw new Error(`OWNER_VISIBLE_FORBIDDEN_PRESENTATION_TERM_${relative}`);
  }
}
if (current.execution.exchangeCredentialsAllowed !== true ||
    current.execution.exchangeCredentialsScope !== "ORION_V3_AND_V4_SEPARATE_BINANCE_DEMO_KEYCHAIN_PLUS_QUANT_SERVER_ONLY_BINANCE_PRODUCTION_READONLY" ||
    current.execution.productionCredentialsAllowed !== true ||
    current.execution.productionCredentialsScope !== "QUANT_SERVER_ONLY_BINANCE_USDM_READONLY_SHADOW_BN_KEY_PROD_AND_BN_SECRET_PROD") {
  throw new Error("EXCHANGE_CREDENTIAL_SCOPE_INVALID");
}
const productionExecutionDomain = current.executionDomains?.orionLiveBinanceUsdmProduction;
const productionService = current.deploymentInfrastructure?.productionReadOnlyService;
const quantServerReplaced = current.deploymentInfrastructure?.authorizationId === "OWNER-DIRECTIVE-QUANT-SERVER-REPLACEMENT-20260911";
if (quantServerReplaced) await import("./verify-demo-server-replacement.mjs");
if (
  productionReadOnlyPolicy.status !== "ACTIVE_PRODUCTION_CREDENTIAL_AND_READONLY_SHADOW_DEPLOYMENT" ||
  productionReadOnlyPolicy.scope?.server !== "demo-server" ||
  productionReadOnlyPolicy.scope?.remoteHostname !== "VM-0-14-opencloudos" ||
  productionReadOnlyPolicy.scope?.productionCredentialsAllowed !== true ||
  productionReadOnlyPolicy.scope?.productionCredentialMapping?.apiKey !== "BN-KEY-PROD" ||
  productionReadOnlyPolicy.scope?.productionCredentialMapping?.apiSecret !== "BN-SECRET-PROD" ||
  productionReadOnlyPolicy.scope?.credentialUseOutsideQuantServerAllowed !== false ||
  productionReadOnlyPolicy.scope?.binanceUsdmMainnetSignedAccountReadsAllowed !== true ||
  productionReadOnlyPolicy.scope?.orderTestAllowed !== false ||
  productionReadOnlyPolicy.scope?.matchingEngineOrdersAllowed !== false ||
  productionReadOnlyPolicy.scope?.realOrdersAuthorized !== false ||
  productionReadOnlyPolicy.scope?.strategyAssigned !== false ||
  productionReadOnlyPolicy.scope?.newEntriesBlocked !== true ||
  productionReadOnlyPolicy.retention?.rawRetentionDays !== 7 ||
  productionReadOnlyPolicy.retention?.rawMaximumBytes !== 21474836480 ||
  productionReadOnlyPolicy.retention?.segmentMaximumBytes !== 268435456 ||
  productionReadOnlyPolicy.retention?.segmentMaximumDurationMs !== 3600000 ||
  productionReadOnlyPolicy.retention?.pinnedEvidenceEvictionAllowed !== false ||
  productionReadOnlyPolicy.retention?.compactDecisionOrderRiskLedgerEvictionAllowed !== false ||
  productionReadOnlyPolicy.promotion?.automaticPromotionAllowed !== false
) {
  throw new Error("BINANCE_PRODUCTION_READONLY_POLICY_INVALID");
}
if (!quantServerReplaced && (
  productionExecutionDomain?.authorizationId !== productionReadOnlyPolicy.id ||
  productionExecutionDomain?.status !== "DEPLOYED_RUNNING_READY_READ_ONLY_SHADOW" ||
  productionExecutionDomain?.credentialValuesProvisioned !== true ||
  productionExecutionDomain?.credentialMapping?.apiKey !== "BN-KEY-PROD" ||
  productionExecutionDomain?.credentialMapping?.apiSecret !== "BN-SECRET-PROD" ||
  productionExecutionDomain?.signedAccountReadVerified !== true ||
  productionExecutionDomain?.userDataStreamVerified !== true ||
  productionExecutionDomain?.signedAccountReadsAllowed !== true ||
  productionExecutionDomain?.userDataStreamAllowed !== true ||
  productionExecutionDomain?.orderTestAllowed !== false ||
  productionExecutionDomain?.realOrdersAllowed !== false ||
  productionExecutionDomain?.strategyAssigned !== false ||
  productionExecutionDomain?.newEntriesBlocked !== true ||
  productionExecutionDomain?.rawRetentionDays !== 7 ||
  productionExecutionDomain?.rawMaximumBytes !== 21474836480 ||
  productionService?.unit !== "aegis-binance-prod-readonly.service" ||
  productionService?.enabled !== true ||
  productionService?.active !== true ||
  productionService?.status !== "READY_READ_ONLY_SHADOW" ||
  productionService?.credentialValuesProvisioned !== true ||
  productionService?.binanceMainnetPublicTimeReadVerified !== true ||
  productionService?.binanceMainnetSignedAccountReadVerified !== true ||
  productionService?.binanceUserDataStreamVerified !== true ||
  productionService?.realOrdersAllowed !== false ||
  productionService?.newEntriesBlocked !== true ||
  productionReadOnlyConfig.execution?.realOrdersAllowed !== false ||
  productionReadOnlyConfig.execution?.orderTestAllowed !== false ||
  productionReadOnlyConfig.execution?.strategyAssigned !== false ||
  productionReadOnlyConfig.execution?.newEntriesBlocked !== true
)) {
  throw new Error("BINANCE_PRODUCTION_READONLY_CURRENT_STATE_INVALID");
}
if (
  productionReadOnlyEvidence.authorizationId !== productionReadOnlyPolicy.id ||
  productionReadOnlyEvidence.status !== "PRODUCTION_READONLY_SHADOW_READY_SIGNED_ACCOUNT_AND_USER_STREAM_VERIFIED" ||
  productionReadOnlyEvidence.server?.adminSshVerified !== true ||
  productionReadOnlyEvidence.server?.rootSshLoginAllowed !== false ||
  productionReadOnlyEvidence.server?.passwordAuthenticationAllowed !== false ||
  productionReadOnlyEvidence.server?.firewall?.active !== true ||
  productionReadOnlyEvidence.server?.firewall?.defaultTarget !== "DROP" ||
  productionReadOnlyEvidence.service?.enabled !== true ||
  productionReadOnlyEvidence.service?.active !== true ||
  productionReadOnlyEvidence.service?.latestStatus !== "READY_READ_ONLY_SHADOW" ||
  productionReadOnlyEvidence.credentials?.credentialValuesLocatedInProjectDotEnv !== true ||
  productionReadOnlyEvidence.credentials?.serverCredentialFilesPresent !== true ||
  productionReadOnlyEvidence.credentials?.signedAccountReadVerified !== true ||
  productionReadOnlyEvidence.credentials?.userDataStreamVerified !== true
) {
  throw new Error("BINANCE_PRODUCTION_READONLY_DEPLOYMENT_EVIDENCE_INVALID");
}
const latestS1InternalTransfer = productionExecutionDomain?.latestInternalTransfer;
if (
  s1SpotToUsdmTransferAuthorization.id !== "OWNER-DIRECTIVE-S1-SPOT-TO-USDM-FULL-BALANCE-TRANSFER-20260909" ||
  s1SpotToUsdmTransferAuthorization.status !== "CONSUMED_COMPLETED" ||
  s1SpotToUsdmTransferAuthorization.scope?.server !== "demo-server" ||
  s1SpotToUsdmTransferAuthorization.scope?.sourceAccount !== "SPOT_MAIN" ||
  s1SpotToUsdmTransferAuthorization.scope?.destinationAccount !== "USD_M_FUTURES" ||
  s1SpotToUsdmTransferAuthorization.scope?.asset !== "USDT" ||
  s1SpotToUsdmTransferAuthorization.scope?.singleSuccessfulTransferOnly !== true ||
  s1SpotToUsdmTransferAuthorization.scope?.withdrawalAllowed !== false ||
  s1SpotToUsdmTransferAuthorization.scope?.externalAddressTransferAllowed !== false ||
  s1SpotToUsdmTransferAuthorization.scope?.orderSubmissionAllowed !== false ||
  s1SpotToUsdmTransferAuthorization.execution?.amountTransferred !== "95.63641401" ||
  s1SpotToUsdmTransferAuthorization.execution?.transactionId !== "409557701695" ||
  s1SpotToUsdmTransferAuthorization.execution?.postTransferReconciliation !== "SPOT_ZERO_USDM_95.63641401_NO_POSITIONS" ||
  s1SpotToUsdmTransferEvidence.authorizationId !== s1SpotToUsdmTransferAuthorization.id ||
  s1SpotToUsdmTransferEvidence.status !== "TRANSFERRED_AND_RECONCILED" ||
  s1SpotToUsdmTransferEvidence.transfer?.endpoint !== "/sapi/v1/futures/transfer" ||
  s1SpotToUsdmTransferEvidence.transfer?.type !== 1 ||
  s1SpotToUsdmTransferEvidence.transfer?.asset !== "USDT" ||
  s1SpotToUsdmTransferEvidence.transfer?.amount !== "95.63641401" ||
  s1SpotToUsdmTransferEvidence.transfer?.transactionId !== "409557701695" ||
  s1SpotToUsdmTransferEvidence.postTransfer?.spotFreeUsdt !== "0" ||
  s1SpotToUsdmTransferEvidence.postTransfer?.spotLockedUsdt !== "0" ||
  s1SpotToUsdmTransferEvidence.postTransfer?.usdMAvailableBalanceUsdt !== "95.63641401" ||
  s1SpotToUsdmTransferEvidence.postTransfer?.usdMNonFlatPositionCount !== 0 ||
  s1SpotToUsdmTransferEvidence.postTransfer?.usdMOpenOrderCount !== 0 ||
  s1SpotToUsdmTransferEvidence.postTransfer?.usdMOpenAlgoOrderCount !== 0 ||
  s1SpotToUsdmTransferEvidence.latestReadOnlyReconciliation?.nonzeroSpotAssets?.length !== 0 ||
  s1SpotToUsdmTransferEvidence.latestReadOnlyReconciliation?.nonzeroFuturesAssets?.length !== 1 ||
  s1SpotToUsdmTransferEvidence.latestReadOnlyReconciliation?.nonzeroFuturesAssets?.[0]?.asset !== "USDT" ||
  s1SpotToUsdmTransferEvidence.latestReadOnlyReconciliation?.usdMAvailableBalanceUsdt !== "95.63641401" ||
  s1SpotToUsdmTransferEvidence.latestReadOnlyReconciliation?.usdMNonFlatPositionCount !== 0 ||
  s1SpotToUsdmTransferEvidence.integrity?.singleTransferSubmitted !== true ||
  s1SpotToUsdmTransferEvidence.integrity?.automaticRetryUsed !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.externalWithdrawalPerformed !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.orderSubmitted !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.leverageOrMarginModeChanged !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.credentialValueLogged !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.realOrderRuntimeActivated !== false ||
  s1SpotToUsdmTransferEvidence.integrity?.newEntriesBlocked !== true ||
  latestS1InternalTransfer?.authorizationId !== s1SpotToUsdmTransferAuthorization.id ||
  latestS1InternalTransfer?.status !== "TRANSFERRED_AND_RECONCILED" ||
  latestS1InternalTransfer?.amount !== s1SpotToUsdmTransferEvidence.transfer?.amount ||
  latestS1InternalTransfer?.transactionId !== s1SpotToUsdmTransferEvidence.transfer?.transactionId ||
  latestS1InternalTransfer?.spotBalanceAfter !== "0" ||
  latestS1InternalTransfer?.spotNonzeroAssetCountAfter !== 0 ||
  latestS1InternalTransfer?.usdMAvailableBalanceAfter !== "95.63641401" ||
  latestS1InternalTransfer?.realOrdersActivated !== false
) {
  throw new Error("S1_SPOT_TO_USDM_TRANSFER_RECORD_INVALID");
}
const v2ExecutionDomain = current.executionDomains?.orionV2Paper;
if (orionV2MonitorRecoveryPolicy.status !== "ACTIVE" ||
    v2ExecutionDomain?.authorizationId !== orionV2MonitorRecoveryPolicy.id ||
    v2ExecutionDomain.exchangeCredentialsAllowed !== false ||
    v2ExecutionDomain.signedRequestsAllowed !== false ||
    v2ExecutionDomain.apiKeysAllowed !== false ||
    v2ExecutionDomain.orderEndpointsAllowed !== false ||
    v2ExecutionDomain.testnetOrdersAllowed !== false ||
    v2ExecutionDomain.realOrdersAllowed !== false ||
    v2ExecutionDomain.v3CredentialInheritanceAllowed !== false) {
  throw new Error("ORION_V2_EXECUTION_DOMAIN_BOUNDARY_INVALID");
}
if (orionV2MonitorRecoveryPolicy.v2Boundary.exchangeCredentialsAllowed !== false ||
    orionV2MonitorRecoveryPolicy.v2Boundary.signedRequestsAllowed !== false ||
    orionV2MonitorRecoveryPolicy.v2Boundary.apiKeysAllowed !== false ||
    orionV2MonitorRecoveryPolicy.v2Boundary.orderEndpointsAllowed !== false ||
    orionV2MonitorRecoveryPolicy.v2Boundary.testnetOrdersAllowed !== false ||
    orionV2MonitorRecoveryPolicy.v2Boundary.realOrdersAllowed !== false ||
    orionV2MonitorRecoveryPolicy.outcome.runtimeHealth !== "HEALTHY" ||
    orionV2MonitorRecoveryPolicy.outcome.onlineLedgerStatus !== "SYNCED" ||
    orionV2MonitorRecoveryPolicy.outcome.positionEntriesQuantitiesAndStopsPreserved !== true ||
    orionV2MonitorRecoveryPolicy.outcome.v3RuntimeMutated !== false) {
  throw new Error("ORION_V2_MONITOR_RECOVERY_EVIDENCE_INVALID");
}
const v3ExecutionDomain = current.executionDomains?.orionV3BinanceDemo;
if (v3ExecutionDomain?.exchangeCredentialsAllowed !== true ||
    v3ExecutionDomain.exchangeCredentialsScope !== "ORION_V3_BINANCE_DEMO_KEYCHAIN_ONLY" ||
    v3ExecutionDomain.signedRequestsAllowed !== true ||
    v3ExecutionDomain.testnetOrdersAllowed !== true ||
    v3ExecutionDomain.productionCredentialsAllowed !== false ||
    v3ExecutionDomain.realOrdersAllowed !== false ||
    v3ExecutionDomain.v2RuntimeOrLedgerAccessAllowed !== false) {
  throw new Error("ORION_V3_EXECUTION_DOMAIN_BOUNDARY_INVALID");
}
const v4ExecutionDomain = current.executionDomains?.orionV4RangeResearch;
const governanceRouting = current.agentGovernanceRouting;
const v4GovernanceIntegration = current.orionV4RangeResearch?.governanceIntegration;
if (orionV4DataSourcePolicy.status !== "ACTIVE_EXECUTION_PLATFORM_READY_STRATEGY_FAIL_CLOSED" ||
    orionV4RetiredReadOnlyPolicy.status !== "SUPERSEDED_BY_OWNER_DIRECTIVE_ORION_V4_BINANCE_USDM_DEMO_EXECUTION_PLATFORM_PARITY_20260820" ||
    v4ExecutionDomain?.authorizationId !== orionV4Policy.id ||
    v4ExecutionDomain?.dataSourceAuthorizationId !== orionV4DataSourcePolicy.id ||
    v4ExecutionDomain.exchangeCredentialsAllowed !== true ||
    v4ExecutionDomain.exchangeCredentialsScope !== "ORION_V4_DEDICATED_BINANCE_USDM_DEMO_EXECUTION_KEYCHAIN_ONLY" ||
    v4ExecutionDomain.signedRequestsAllowed !== true ||
    !(orionV4Stopped ? ["GET"] : ["GET", "POST", "DELETE"]).every((method) => v4ExecutionDomain.allowedMethods?.includes(method)) ||
    v4ExecutionDomain.orderEndpointCapabilityPrepared !== true ||
    v4ExecutionDomain.dedicatedCredentialBindingReady !== true ||
    v4ExecutionDomain.orderTestEndpointAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.matchingEngineOrderSubmissionAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.initialLeverageAlignmentAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.targetInitialLeverage !== 4 ||
    v4ExecutionDomain.residentScannerAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.forwardPaperOrdersAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.testnetOrdersAllowed !== !orionV4Stopped ||
    v4ExecutionDomain.realOrdersAllowed !== false ||
    v4ExecutionDomain.v2OrV3RuntimeOrLedgerAccessAllowed !== false ||
    orionV4DataSourcePolicy.permissions.orderEndpointCapabilityPrepared !== true ||
    orionV4DataSourcePolicy.permissions.matchingEngineOrderSubmissionAllowedBeforeStrategyActivation !== false ||
    orionV4DataSourcePolicy.permissions.realOrdersAllowed !== false ||
    orionV4DataSourcePolicy.hardRisk.maximumRiskPerEntryFraction !== 0.01 ||
    orionV4DataSourcePolicy.hardRisk.maximumManagedPortfolioRiskFraction !== 0.1 ||
    orionV4DataSourcePolicy.hardRisk.maximumEffectiveNotionalLeverage !== 10 ||
    orionV4DataSourcePolicy.isolation.v3CredentialInheritanceAllowed !== false ||
    orionV4DataSourcePolicy.isolation.v3RuntimeOrLedgerAccessAllowed !== false ||
    orionV4PriorPolicy.status !== "SUPERSEDED" ||
    orionV4PriorPolicy.supersededBy !== orionV4RetiredPolicy.id ||
    orionV4RetiredPolicy.status !== "SUPERSEDED" ||
    orionV4RetiredPolicy.supersededBy !== orionV4R20Policy.id ||
    orionV4R20Policy.status !== "SUPERSEDED" ||
    orionV4R20Policy.supersededBy !== orionV4R21Policy.id ||
    orionV4R21Policy.status !== "SUPERSEDED" ||
    orionV4R21Policy.supersededBy !== orionV4Policy.id ||
    orionV4Policy.status !== "ACTIVE" ||
    orionV4Policy.appliesTo.targetImplementationRevision !== current.orionV4RangeResearch?.activeExecutionStrategyRevision ||
    current.orionV4RangeResearch?.strategyExecutionActivationStatus !== (orionV4Stopped ? "STOPPED_BY_OWNER" : "ACTIVE_OWNER_AUTHORIZED_V4_STRATEGY") ||
    current.orionV4RangeResearch?.matchingEngineOrderSubmissionAllowed !== !orionV4Stopped ||
    current.orionV4RangeResearch?.residentScannerAllowed !== !orionV4Stopped ||
    current.orionV4RangeResearch?.testnetOrdersAllowed !== !orionV4Stopped ||
    current.orionV4RangeResearch?.realOrdersAllowed !== false ||
    current.orionV4RangeResearch?.independentRangeGeometry?.owner !== "ORION_V4" ||
    current.orionV4RangeResearch?.independentRangeGeometry?.status !== "RETIRED_SUPERSEDED_BY_V4_MTFX_R20" ||
    current.orionV4RangeResearch?.independentRangeGeometry?.v2StrategyConfigRevisionHashOrCodeAccessAllowed !== true ||
    current.orionV4RangeResearch?.independentRangeGeometry?.v2RuntimePositionOrderLedgerAccessAllowed !== false ||
    current.orionV4RangeResearch?.independentRangeGeometry?.v3StrategyConfigRevisionHashOrCodeAccessAllowed !== false ||
    current.orionV4RangeResearch?.independentRangeGeometry?.v3RuntimePositionOrderLedgerAccessAllowed !== false ||
    current.orionV4RangeResearch?.scanUniverseAuthorizationId !== orionV3V4TieredScanPolicy.id ||
    current.orionV4RangeResearch?.fixedResearchUniverse?.length !== 10 ||
    current.orionV4RangeResearch?.scanTopology?.structuralDiscoveryIntervalMs !== 60000 ||
    current.orionV4RangeResearch?.scanTopology?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
    current.orionV4RangeResearch?.evaluationCohortId !== orionV4Policy.appliesTo?.targetForwardCohortId ||
    current.orionV4RangeResearch?.riskPolicy?.authorizationId !== orionV4Policy.id ||
    current.orionV4RangeResearch?.riskPolicy?.revision !== orionV4Policy.riskPolicy?.revision ||
    current.orionV4RangeResearch?.executionPlatformHardRiskCeiling?.maximumRiskPerEntryFraction !== 0.01 ||
    current.orionV4RangeResearch?.executionPlatformHardRiskCeiling?.maximumManagedPortfolioRiskFraction !== 0.05 ||
    current.orionV4RangeResearch?.executionPlatformHardRiskCeiling?.maximumEffectiveNotionalLeverage !== 4 ||
    current.orionV4RangeResearch?.mtfxImport?.sourceRevision !== "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" ||
    current.orionV4RangeResearch?.mtfxImport?.v2RuntimePositionOrderLedgerOrCredentialAccessAllowed !== false ||
    orionV4Config.authorizationId !== orionV4Policy.id ||
    orionV4Config.implementationRevision !== orionV4Policy.appliesTo?.targetImplementationRevision ||
    orionV4Config.sourceStrategy?.implementationRevision !== "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" ||
    orionV4Config.portfolioProfitProtection?.excludedSymbols?.join(",") !== "BTCUSDT,ETHUSDT" ||
    orionV4Config.portfolioProfitProtection?.eligibleSymbols?.length !== 8 ||
    orionV4Config.sourceStrategy?.runtimePositionOrderLedgerAccessAllowed !== false ||
    orionV4Config.universe?.symbols?.length !== 10 ||
    orionV4Config.riskPolicy?.authorizationId !== orionV4Policy.id ||
    orionV4Config.riskPolicy?.revision !== orionV4Policy.riskPolicy?.revision ||
    orionV4Config.risk?.maximumRiskPerEntryFraction !== 0.01 ||
    orionV4Config.risk?.maximumPortfolioRiskFraction !== 0.05 ||
    orionV4Config.risk?.riskSizingUtilizationFraction !== 0.98 ||
    orionV4Config.risk?.maximumEffectiveNotionalLeverage !== 4 ||
    orionV4Config.runtime?.scanIntervalMs !== 60000 ||
    orionV4RiskPolicy.status !== "SUPERSEDED" ||
    orionV4RiskPolicy.supersededBy !== orionV4Policy.id ||
    orionV4ParityPolicy.status !== "SUPERSEDED" ||
    orionV4ParityPolicy.supersededBy !== orionV4Policy.id ||
    current.orionV4RangeResearch?.v2ExecutionParityDirective?.status !== "SUPERSEDED" ||
    current.orionV4RangeResearch?.v2FullRuleParityDirective?.authorizationId !== orionV4Policy.id ||
    !(orionV4Stopped ? ["SUSPENDED_BY_OWNER"] : ["CUTOVER_VALIDATION_IN_PROGRESS", "ACTIVE_VERIFIED_RUNNING_RECONCILED"]).includes(current.orionV4RangeResearch?.v2FullRuleParityDirective?.status) ||
    orionV4Policy.riskPolicy?.maximumRiskPerEntryFraction !== 0.01 ||
    orionV4Policy.riskPolicy?.maximumManagedPortfolioRiskFraction !== 0.05 ||
    orionV4Policy.riskPolicy?.maximumEffectiveNotionalLeverage !== 4 ||
    orionV4Policy.riskPolicy?.riskSizingUtilizationFraction !== 0.98 ||
    orionV4Policy.exitManagement?.atHalfNetR?.closeFractionOfOriginal !== 0.4 ||
    orionV4Policy.exitManagement?.atOneNetR?.closeFractionOfOriginal !== 0.25 ||
    orionV4Policy.exitManagement?.atTwoNetR?.closeFractionOfOriginal !== 0.2 ||
    (orionV4ParityEngaged && (orionV4Config.executionParity?.authorizationId !== orionV4Policy.id ||
      orionV4Config.executionParity?.causalBboRequired !== true ||
      orionV4Config.executionParity?.strictlyIncreasingUpdateIdRequired !== true ||
      orionV4Config.evaluationIsolation?.forwardCohortId !== orionV4Policy.appliesTo?.targetForwardCohortId)) ||
    (orionV4ParityActive && (orionV4Policy.implementationOutcome?.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
      orionV4ParityEvidence.result !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
      orionV4ParityEvidence.statePreservation?.liveExchangeFingerprintBefore !== orionV4ParityEvidence.statePreservation?.liveExchangeFingerprintAfter ||
      orionV4ParityEvidence.runtime?.supervisorPidBefore !== orionV4ParityEvidence.runtime?.supervisorPidAfter ||
      orionV4ParityEvidence.runtime?.consecutiveSuccessfulCyclesVerified !== 2 ||
      orionV4ParityEvidence.runtime?.executionReconciliationStatus !== "RECONCILED" ||
      orionV4ParityEvidence.isolation?.v1V2V3Mutated !== false))) {
  throw new Error("ORION_V4_DEMO_EXECUTION_PLATFORM_BOUNDARY_INVALID");
}
const contextRotationWaitingFinalReady = aegisV2V3ContextHygieneRotationEvidence.status === "WAITING_FINAL_READY_VERIFICATION";
const contextRotationArchivePending = aegisV2V3ContextHygieneRotationEvidence.status === "READY_VERIFIED_ARCHIVE_PENDING";
const contextRotationArchiveCompleted = aegisV2V3ContextHygieneRotationEvidence.status === "COMPLETED_READY_VERIFIED_ARCHIVED";
const contextRotationAgents = [
  ["orionV2", "orionV2Conversation"],
  ["orionV3", "orionV3Conversation"]
];
const contextRotationThreadStateValid = contextRotationAgents.every(([agentKey, conversationKey]) => {
  const policyThread = aegisV2V3ContextHygieneRotationPolicy.rotation?.[agentKey];
  const evidenceThread = aegisV2V3ContextHygieneRotationEvidence.threads?.[agentKey];
  const conversation = current[conversationKey];
  const commonValid = policyThread?.newThreadId === governanceRouting?.mainThreads?.[agentKey] &&
    policyThread?.newThreadId === evidenceThread?.newThreadId &&
    policyThread?.newThreadId === conversation?.activeThreadId &&
    policyThread?.replacedThreadId === evidenceThread?.oldThreadId &&
    policyThread?.replacedThreadId === conversation?.replacedThreadId &&
    policyThread?.title === evidenceThread?.title &&
    policyThread?.title === conversation?.activeThreadTitle &&
    conversation?.authorizationId === aegisV2V3ContextHygieneRotationPolicy.id &&
    conversation?.rotationAuthorizationId === aegisV2V3ContextHygieneRotationPolicy.id &&
    conversation?.replacedThreadDeleted === false &&
    conversation?.fullTranscriptReplayAllowed === false;
  if (!commonValid) return false;
  if (contextRotationWaitingFinalReady) {
    return evidenceThread?.initialization === "WAITING_POINTER" &&
      evidenceThread?.ready === false &&
      evidenceThread?.oldThreadArchived === false &&
      conversation?.status === "ACTIVE_CLEAN_MAIN_THREAD_ARCHIVE_PENDING" &&
      conversation?.initializationStatus === "WAITING_FINAL_READY_VERIFICATION" &&
      conversation?.replacedThreadStatus === "READY_VERIFIED_READ_ONLY_ARCHIVE_PENDING" &&
      conversation?.replacedThreadArchiveRecoverable === null &&
      conversation?.replacedThreadArchiveVerifiedAt === null;
  }
  if (contextRotationArchivePending) {
    return evidenceThread?.initialization === "READY" &&
      evidenceThread?.ready === true &&
      evidenceThread?.oldThreadArchived === false &&
      conversation?.status === "ACTIVE_CLEAN_MAIN_THREAD_ARCHIVE_PENDING" &&
      conversation?.initializationStatus === "READY_VERIFIED" &&
      conversation?.replacedThreadStatus === "READY_VERIFIED_READ_ONLY_ARCHIVE_PENDING" &&
      conversation?.replacedThreadArchiveRecoverable === null &&
      conversation?.replacedThreadArchiveVerifiedAt === null;
  }
  return contextRotationArchiveCompleted &&
    evidenceThread?.initialization === "READY" &&
    evidenceThread?.ready === true &&
    evidenceThread?.oldThreadArchived === true &&
    evidenceThread?.oldThreadRecoverable === true &&
    evidenceThread?.oldThreadDeleted === false &&
    conversation?.status === "ACTIVE_CLEAN_MAIN_THREAD" &&
    conversation?.initializationStatus === "READY_VERIFIED" &&
    conversation?.replacedThreadStatus === "READ_ONLY_ARCHIVED_HISTORY" &&
    conversation?.replacedThreadArchiveRecoverable === true &&
    typeof conversation?.replacedThreadArchiveVerifiedAt === "string";
});
const currentAegisRotationWaitingFinalReady = currentAegisPrimeContextHygieneRotationEvidence.status === "WAITING_FINAL_READY_VERIFICATION";
const currentAegisRotationArchivePending = currentAegisPrimeContextHygieneRotationEvidence.status === "READY_VERIFIED_ARCHIVE_PENDING";
const currentAegisRotationCompleted = currentAegisPrimeContextHygieneRotationEvidence.status === "COMPLETED_READY_VERIFIED_ARCHIVED";
// The September 11 policy/evidence remains an immutable historical chain.
// The September 14 live pointer, registry, receipts, and source chain are checked above.
const currentAegisConversation = aegisRotationSuccessor?.historical.aegisPrimeConversation ?? current.aegisPrimeConversation;
const historicalAegisRouting = aegisRotationSuccessor?.historical.agentGovernanceRouting ?? governanceRouting;
const currentAegisCommonValid =
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.activeThreadId === historicalAegisRouting?.mainThreads?.aegisPrime &&
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.activeThreadId === currentAegisPrimeContextHygieneRotationEvidence.newThreadId &&
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.activeThreadId === currentAegisConversation?.activeThreadId &&
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.replacedThreadId === currentAegisPrimeContextHygieneRotationEvidence.replacedThreadId &&
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.replacedThreadId === currentAegisConversation?.replacedThreadId &&
  currentAegisPrimeContextHygieneRotationPolicy.conversation?.activeThreadTitle === currentAegisConversation?.activeThreadTitle &&
  currentAegisConversation?.authorizationId === currentAegisPrimeContextHygieneRotationPolicy.id &&
  currentAegisConversation?.rotationAuthorizationId === currentAegisPrimeContextHygieneRotationPolicy.id &&
  currentAegisPrimeContextHygieneRotationEvidence.newThreadInitialStatus === "WAITING_POINTER" &&
  currentAegisPrimeContextHygieneRotationEvidence.replacedThreadDeleted === false &&
  currentAegisConversation?.replacedThreadDeleted === false &&
  currentAegisConversation?.fullTranscriptReplayAllowed === false;
const currentAegisThreadStateValid = currentAegisCommonValid && (
  currentAegisRotationWaitingFinalReady
    ? currentAegisConversation?.initializationStatus === "WAITING_FINAL_READY_VERIFICATION" &&
      currentAegisPrimeContextHygieneRotationEvidence.replacedThreadArchived === false &&
      currentAegisConversation?.replacedThreadArchiveRecoverable === null
    : currentAegisRotationArchivePending
      ? currentAegisConversation?.initializationStatus === "READY_VERIFIED" &&
        currentAegisPrimeContextHygieneRotationEvidence.newThreadReadyStatus === "READY" &&
        currentAegisPrimeContextHygieneRotationEvidence.replacedThreadArchived === false &&
        currentAegisConversation?.replacedThreadArchiveRecoverable === null
      : currentAegisRotationCompleted &&
        currentAegisConversation?.status === "ACTIVE_CLEAN_MAIN_THREAD" &&
        currentAegisConversation?.initializationStatus === "READY_VERIFIED" &&
        currentAegisPrimeContextHygieneRotationEvidence.newThreadReadyStatus === "READY" &&
        currentAegisPrimeContextHygieneRotationEvidence.replacedThreadArchived === true &&
        currentAegisPrimeContextHygieneRotationEvidence.replacedThreadRecoverable === true &&
        currentAegisConversation?.replacedThreadArchiveRecoverable === true &&
        typeof currentAegisConversation?.replacedThreadArchiveVerifiedAt === "string"
);

if (orionV4GovernanceIntegrationPolicy.status !== "ACTIVE" ||
    governanceRouting?.authorizationId !== orionV4GovernanceIntegrationPolicy.id ||
    governanceRouting?.status !== "ACTIVE_AEGIS_OWNER_AND_PEER_ROUTING" ||
    governanceRouting?.owner !== "Operator" ||
    governanceRouting?.governor !== "AEGIS PRIME" ||
    aegisPrimeThreadRotationPolicy.status !== "ACTIVE" ||
    orionV3ThreadRotationPolicy.status !== "ACTIVE" ||
    replacedMainThreadArchiveAlignmentPolicy.status !== "ACTIVE" ||
    aegisPrimeContextHygieneRotationPolicy.status !== "ACTIVE" ||
    aegisPrimeContextHygieneRotationPolicy.supersedesForAegisPrime !== previousAegisPrimeContextHygieneRotationPolicy.id ||
    aegisV2V3ContextHygieneRotationPolicy.status !== "ACTIVE" ||
    aegisV2V3ContextHygieneRotationPolicy.owner !== "Operator" ||
    aegisV2V3ContextHygieneRotationPolicy.rotation?.namesMustRemainUnchanged !== true ||
    aegisV2V3ContextHygieneRotationPolicy.rotation?.archiveOnlyAfterReady !== true ||
    aegisV2V3ContextHygieneRotationPolicy.rotation?.deletionAllowed !== false ||
    aegisV2V3ContextHygieneRotationPolicy.rotation?.fullTranscriptReplayAllowed !== false ||
    currentAegisPrimeContextHygieneRotationPolicy.status !== "ACTIVE" ||
    currentAegisPrimeContextHygieneRotationPolicy.owner !== "Operator" ||
    currentAegisPrimeContextHygieneRotationPolicy.supersedesForAegisPrime !== priorSeptemberAegisRotationPolicy.id ||
    priorSeptemberAegisRotationPolicy.supersedesForAegisPrime !== aegisV2V3ContextHygieneRotationPolicy.id ||
    currentAegisPrimeContextHygieneRotationPolicy.conversation?.replacedThreadId !== priorSeptemberAegisRotationPolicy.conversation?.activeThreadId ||
    !currentAegisConversation?.priorReplacedThreadIds?.includes(priorSeptemberAegisRotationPolicy.conversation?.replacedThreadId) ||
    currentAegisPrimeContextHygieneRotationPolicy.conversation?.fullTranscriptReplayAllowed !== false ||
    currentAegisPrimeContextHygieneRotationPolicy.conversation?.deletionAuthorized !== false ||
    !replacedMainThreadArchiveAlignmentPolicy.supersedes?.includes(aegisPrimeThreadRotationPolicy.id) ||
    !replacedMainThreadArchiveAlignmentPolicy.supersedes?.includes(orionV3ThreadRotationPolicy.id) ||
    historicalAegisRouting?.aegisMainThreadAuthorizationId !== currentAegisPrimeContextHygieneRotationPolicy.id ||
    governanceRouting?.orionV2MainThreadAuthorizationId !== aegisV2V3ContextHygieneRotationPolicy.id ||
    governanceRouting?.orionV3MainThreadAuthorizationId !== aegisV2V3ContextHygieneRotationPolicy.id ||
    !currentAegisConversation?.priorReplacedThreadIds?.includes(previousAegisPrimeContextHygieneRotationPolicy.conversation.replacedThreadId) ||
    currentAegisThreadStateValid !== true ||
    currentAegisPrimeContextHygieneRotationEvidence.authorizationId !== currentAegisPrimeContextHygieneRotationPolicy.id ||
    currentAegisPrimeContextHygieneRotationEvidence.fullTranscriptCopiedOrReplayed !== false ||
    currentAegisPrimeContextHygieneRotationEvidence.runtimeOrTradingMutation !== false ||
    currentAegisPrimeContextHygieneRotationEvidence.strategyRiskPositionOrderLedgerMonitorMutation !== false ||
    currentAegisPrimeContextHygieneRotationEvidence.strategyRiskPositionOrderLedgerMonitorOrAutomationMutation !== true ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.status !== "VERIFIED_TARGET_ONLY" ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.id !== currentAegisPrimeContextHygieneRotationPolicy.carryoverException?.automationId ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.oldTarget !== currentAegisConversation.replacedThreadId ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.newTarget !== currentAegisConversation.activeThreadId ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.schedulePromptRecipientUnchanged !== true ||
    currentAegisPrimeContextHygieneRotationEvidence.automationCarryover?.readbackVerified !== true ||
    contextRotationThreadStateValid !== true ||
    aegisV2V3ContextHygieneRotationEvidence.authorizationId !== aegisV2V3ContextHygieneRotationPolicy.id ||
    aegisV2V3ContextHygieneRotationEvidence.firstPass?.allCandidatesReadRequiredSources !== true ||
    aegisV2V3ContextHygieneRotationEvidence.firstPass?.allCandidatesReturnedWaitingPointer !== true ||
    aegisV2V3ContextHygieneRotationEvidence.firstPass?.writesOrProcessControlsByCandidates !== 0 ||
    aegisV2V3ContextHygieneRotationEvidence.boundaries?.fullTranscriptCopiedOrReplayed !== false ||
    aegisV2V3ContextHygieneRotationEvidence.boundaries?.runtimeOrProcessControlInvoked !== false ||
    aegisV2V3ContextHygieneRotationEvidence.boundaries?.strategyRiskPositionOrderLedgerMonitorOrAutomationChanged !== false ||
    aegisV2V3ContextHygieneRotationEvidence.boundaries?.threadDeletionAllowed !== false ||
    aegisPrimeThreadRotationEvidence.status !== "COMPLETED_READY_VERIFIED" ||
    aegisPrimeThreadRotationEvidence.newThreadId !== aegisPrimeThreadRotationPolicy.conversation.activeThreadId ||
    aegisPrimeThreadRotationEvidence.replacedThreadArchived !== false ||
    aegisPrimeThreadRotationEvidence.runtimeOrTradingMutation !== false ||
    current.orionV3Conversation?.strategyRiskPositionOrOrderMutationByThreadRotationAllowed !== false ||
    orionV3ThreadRotationEvidence.status !== "COMPLETED_READY_VERIFIED" ||
    orionV3ThreadRotationEvidence.newThreadId !== orionV3ThreadRotationPolicy.conversation.activeThreadId ||
    orionV3ThreadRotationEvidence.replacedThreadArchived !== false ||
    orionV3ThreadRotationEvidence.runtimeOrTradingMutation !== false ||
    replacedMainThreadArchiveAlignmentEvidence.status !== "COMPLETED_VERIFIED" ||
    !replacedMainThreadArchiveAlignmentEvidence.archiveActions?.some((item) => item.agentId === "aegis-prime" && item.threadId === replacedMainThreadArchiveAlignmentPolicy.conversations.aegisPrime.replacedThreadId && item.archived === true && item.recoverable === true && item.deleted === false) ||
    !replacedMainThreadArchiveAlignmentEvidence.archiveActions?.some((item) => item.agentId === "orion-v3" && item.threadId === replacedMainThreadArchiveAlignmentPolicy.conversations.orionV3.replacedThreadId && item.archived === true && item.recoverable === true && item.deleted === false) ||
    replacedMainThreadArchiveAlignmentEvidence.currentMainThreads?.aegisPrime?.threadId !== replacedMainThreadArchiveAlignmentPolicy.conversations.aegisPrime.activeThreadId ||
    replacedMainThreadArchiveAlignmentEvidence.currentMainThreads?.aegisPrime?.archived !== false ||
    replacedMainThreadArchiveAlignmentEvidence.currentMainThreads?.orionV3?.threadId !== replacedMainThreadArchiveAlignmentPolicy.conversations.orionV3.activeThreadId ||
    replacedMainThreadArchiveAlignmentEvidence.currentMainThreads?.orionV3?.archived !== false ||
    replacedMainThreadArchiveAlignmentEvidence.runtimeOrTradingMutation !== false ||
    replacedMainThreadArchiveAlignmentEvidence.strategyRiskPositionOrderLedgerOrMonitorMutation !== false ||
    current.orionV3BinanceUsdmDemo?.threadId !== aegisV2V3ContextHygieneRotationPolicy.rotation.orionV3.newThreadId ||
    current.orionV3ShadowKelly?.sourceThreadId !== aegisV2V3ContextHygieneRotationPolicy.rotation.orionV3.newThreadId ||
    governanceRouting?.mainThreads?.orionV4 !== orionV4GovernanceIntegrationPolicy.scope.mainThreadId ||
    governanceRouting?.registeredPeers?.includes("orion-v4") !== true ||
    ["REPLY_REQUIRED", "ACK_ONLY", "NO_REPLY"].every((mode) => governanceRouting?.responseObligations?.includes(mode)) !== true ||
    governanceRouting?.p0P1EscalationToAegisRequired !== true ||
    governanceRouting?.objectAmbiguityAction !== "FAIL_CLOSED_ASK_OWNER" ||
    governanceRouting?.crossAgentPayloadMode !== "STATE_DELTA_AND_EVIDENCE_POINTERS_ONLY" ||
    governanceRouting?.strategyRiskRuntimeSynchronizationImplied !== false ||
    v4GovernanceIntegration?.authorizationId !== orionV4GovernanceIntegrationPolicy.id ||
    v4GovernanceIntegration?.status !== "ACTIVE_EQUAL_MAIN_THREAD_GOVERNANCE" ||
    v4GovernanceIntegration?.ownerDirectInstructionChannel !== true ||
    v4GovernanceIntegration?.aegisGoverned !== true ||
    v4GovernanceIntegration?.peerMailboxEnabled !== true ||
    v4GovernanceIntegration?.longTermMemoryEnabled !== true ||
    v4GovernanceIntegration?.minimumSufficientContextRecovery !== true ||
    v4GovernanceIntegration?.p0P1EscalationToAegisRequired !== true ||
    v4GovernanceIntegration?.strategyRiskRuntimeIsolationPreserved !== true ||
    v4GovernanceIntegration?.lastHandshakeMessageId !== "AEGIS-V4-GOVERNANCE-INTEGRATION-20260820-001" ||
    v4GovernanceIntegration?.lastHandshakeStatus !== "ACKNOWLEDGED_NO_CONFLICT" ||
    v4GovernanceIntegration?.lastHandshakeRuntimeOrTradingStateChanges !== 0 ||
    v4GovernanceIntegration?.evidence !== "governance/evidence/orion-v4-governance-session-integration-20260820.json" ||
    orionV4GovernanceIntegrationPolicy.boundaries.v2V3V4StrategySynchronizationImplied !== false ||
    orionV4GovernanceIntegrationPolicy.boundaries.sharedCredentialsPositionsOrdersOrLedgersAllowed !== false ||
    orionV4GovernanceIntegrationPolicy.boundaries.realOrdersAllowed !== false) {
  throw new Error("ORION_V4_GOVERNANCE_SESSION_INTEGRATION_INVALID");
}
if (pause.engaged !== true || !String(pause.reason).startsWith("OWNER_PAUSE")) {
  throw new Error("ORION_V2_OWNER_PAUSE_EVIDENCE_MISSING");
}
if (!mtfx.authorization?.paperExecutionAllowed || mtfx.authorization?.realExecutionAllowed || !mtfx.authorization?.automaticRestartAllowed) {
  throw new Error("MTFX_PAPER_AUTHORIZATION_INVALID");
}
if (mtfx.authorization.authorizationId !== authorization.id || authorization.authorization.realOrders !== false) {
  throw new Error("MTFX_OWNER_AUTHORIZATION_CHAIN_INVALID");
}
if (mtfx.implementationRevision !== "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" ||
    mtfx.implementationDirectiveId !== implementationDirective.id ||
    implementationDirective.amends !== r21ImplementationDirective.id ||
    r7ImplementationDirective.amends !== multiAnchorImplementationDirective.id ||
    multiAnchorImplementationDirective.amends !== postCrossImplementationDirective.id ||
    postCrossImplementationDirective.amends !== structureHygieneDirective.id ||
    structureHygieneDirective.amends !== oneSidedImplementationDirective.id ||
    oneSidedImplementationDirective.amends !== balancedLeadDirective.id ||
    balancedLeadDirective.amends !== continuationDirective.id ||
    continuationDirective.amends !== priorImplementationDirective.id ||
    priorImplementationDirective.amends !== authorization.id ||
    priorImplementationDirective.supersededBy !== continuationDirective.id ||
    continuationDirective.supersededBy !== balancedLeadDirective.id ||
    balancedLeadDirective.supersededBy !== oneSidedImplementationDirective.id ||
    oneSidedImplementationDirective.supersededBy !== postCrossImplementationDirective.id ||
    structureHygieneDirective.supersededBy !== postCrossImplementationDirective.id ||
    postCrossImplementationDirective.status !== "SUPERSEDED" ||
    postCrossImplementationDirective.supersededBy !== multiAnchorImplementationDirective.id ||
    multiAnchorImplementationDirective.status !== "SUPERSEDED" ||
    multiAnchorImplementationDirective.supersededBy !== r7ImplementationDirective.id ||
    r7ImplementationDirective.status !== "SUPERSEDED" ||
    r7ImplementationDirective.supersededBy !== r8ImplementationDirective.id ||
    r8ImplementationDirective.status !== "SUPERSEDED" ||
    r8ImplementationDirective.supersededBy !== r9ImplementationDirective.id ||
    r9ImplementationDirective.status !== "SUPERSEDED" ||
    r9ImplementationDirective.supersededBy !== r10ImplementationDirective.id ||
    r10ImplementationDirective.status !== "SUPERSEDED_BEFORE_RUNTIME_CUTOVER" ||
    r10ImplementationDirective.supersededBy !== r11ImplementationDirective.id ||
    r11ImplementationDirective.status !== "SUPERSEDED" ||
    r11ImplementationDirective.supersededBy !== r12ImplementationDirective.id ||
    r12ImplementationDirective.status !== "SUPERSEDED" ||
    r12ImplementationDirective.supersededBy !== r13ImplementationDirective.id ||
    r13ImplementationDirective.status !== "SUPERSEDED" ||
    r13ImplementationDirective.supersededBy !== r14ImplementationDirective.id ||
    r14ImplementationDirective.status !== "SUPERSEDED" ||
    r14ImplementationDirective.supersededBy !== r15ImplementationDirective.id ||
    r15ImplementationDirective.status !== "SUPERSEDED" ||
    r15ImplementationDirective.supersededBy !== r16ImplementationDirective.id ||
    r16ImplementationDirective.status !== "SUPERSEDED" ||
    r16ImplementationDirective.supersededBy !== r17ImplementationDirective.id ||
    r17ImplementationDirective.status !== "SUPERSEDED" ||
    r17ImplementationDirective.supersededBy !== r18ImplementationDirective.id ||
    r18ImplementationDirective.status !== "SUPERSEDED" ||
    r18ImplementationDirective.supersededBy !== r19ImplementationDirective.id ||
    r19ImplementationDirective.status !== "SUPERSEDED" ||
    r19ImplementationDirective.supersededBy !== r20ImplementationDirective.id ||
    r20ImplementationDirective.status !== "SUPERSEDED" ||
    r20ImplementationDirective.supersededBy !== r21ImplementationDirective.id ||
    r21ImplementationDirective.status !== "ACTIVE" ||
    r21ImplementationDirective.forwardV2SupersededBy !== implementationDirective.id ||
    implementationDirective.status !== "ACTIVE" ||
    r12ImplementationDirective.authorizedCorrection?.priceConfirmation?.entryMode !== "TWO_BAR_CROSS_CLOSE_WITH_BUFFER" ||
    r12ImplementationDirective.authorizedCorrection?.priceConfirmation?.crossCloseBufferBps !== 5 ||
    r12ImplementationDirective.authorizedCorrection?.priceConfirmation?.maximumDirectionDecisionBars !== 2 ||
    mtfx.signal?.entryMode !== "TWO_BAR_CROSS_CLOSE_WITH_BUFFER" ||
    mtfx.signal?.crossCloseBufferBps !== 5 ||
    mtfx.signal?.maximumDirectionDecisionBars !== 2 ||
    mtfx.stop?.initialStopMode !== "INTERSECTION_BUFFER" ||
    mtfx.stop?.intersectionBufferBps !== 5 ||
    mtfx.stop?.pivotInterval !== "1h" ||
    mtfx.intersection?.anchorConsensus?.drawingCoordinatesUsed !== false ||
    mtfx.intersection?.anchorConsensus?.mathematicalInputs?.join(",") !== "EXCHANGE_BAR_OPEN_TIME,BAR_HIGH,BAR_LOW" ||
    implementationDirective.preserves.realOrders !== false ||
    implementationDirective.policy?.singleSymbolExposure !== "AT_MOST_ONE_OPEN_POSITION_PER_SYMBOL_ACROSS_ALL_ACTIVE_PAPER_BOOKS" ||
    r20ImplementationDirective.policy?.entryQuality?.maximumEntryDisplacementBps !== 50 ||
    r20ImplementationDirective.policy?.entryQuality?.maximumEntrySignalAgeMs !== 180000 ||
    r20ImplementationDirective.policy?.entryQuality?.displacementReference !== "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE" ||
    r20ImplementationDirective.policy?.entryQuality?.revalidation !== "REQUIRED_ON_EVERY_SIMULATED_SUBMISSION_ATTEMPT" ||
    r20ImplementationDirective.policy?.costEfficiency?.maximumCompleteLifecycleCostR !== 0.12 ||
    r20ImplementationDirective.policy?.costEfficiency?.revalidation !== "REQUIRED_BEFORE_POSITION_SIZING_ON_EVERY_SUBMISSION_ATTEMPT" ||
    r20ImplementationDirective.policy?.costEfficiency?.positionSizingBypassAllowed !== false ||
    r20ImplementationDirective.policy?.costEfficiency?.stopWideningBypassAllowed !== false ||
    r21ImplementationDirective.scope?.excludedSymbols?.join(",") !== "BTCUSDT,ETHUSDT" ||
    mtfx.authorization?.realExecutionAllowed !== false ||
    r20ImplementationDirective.policy?.eventRisk?.freezeNewEntries !== true ||
    r20ImplementationDirective.policy?.eventRisk?.freezeBeforeMinutes !== 30 ||
    r20ImplementationDirective.policy?.eventRisk?.freezeAfterMinutes !== 30 ||
    r20ImplementationDirective.policy?.exitManagement?.atHalfNetR?.closeFractionOfOriginal !== 0.2 ||
    r20ImplementationDirective.policy?.exitManagement?.atHalfNetR?.stopAggregateNetRFloor !== 0.05 ||
    r20ImplementationDirective.policy?.exitManagement?.atOneNetR?.closeFractionOfOriginal !== 0.3 ||
    r20ImplementationDirective.policy?.exitManagement?.atOneNetR?.stopAggregateNetRFloor !== 0.5 ||
    r20ImplementationDirective.policy?.exitManagement?.atTwoNetR?.closeFractionOfOriginal !== 0.25 ||
    r20ImplementationDirective.policy?.exitManagement?.runner !== "REMAINING_25_PERCENT_TRAILS_CONFIRMED_1H_STRUCTURE_ONLY_NO_TIME_EXIT" ||
    mtfx.costAdjustedRisk?.softLockActivationNetR !== 0.5 ||
    mtfx.costAdjustedRisk?.softLockAggregateNetRFloor !== 0.15 ||
    mtfx.costAdjustedRisk?.oneNetRAggregateNetRFloor !== 0.6 ||
    mtfx.exit?.atHalfNetR?.closeFractionOfOriginal !== 0.4 ||
    mtfx.exit?.atOneNetR?.closeFractionOfOriginal !== 0.25 ||
    mtfx.exit?.atTwoNetR?.closeFractionOfOriginal !== 0.2 ||
    mtfx.exit?.runner?.fractionOfOriginal !== 0.15 ||
    implementationDirective.policy?.exitManagement?.atHalfNetR?.closeFractionOfOriginal !== 0.4 ||
    implementationDirective.policy?.exitManagement?.atHalfNetR?.stopAggregateNetRFloor !== 0.15 ||
    implementationDirective.policy?.exitManagement?.atOneNetR?.closeFractionOfOriginal !== 0.25 ||
    implementationDirective.policy?.exitManagement?.atOneNetR?.stopAggregateNetRFloor !== 0.6 ||
    implementationDirective.policy?.exitManagement?.atTwoNetR?.closeFractionOfOriginal !== 0.2 ||
    runtime.paperRisk?.exitVariant !== "PARTIAL_40_SOFT_LOCK_25_20_RUNNER_15_1H_STRUCTURE" ||
    runtime.execution?.singleSymbolExposure !== implementationDirective.policy?.singleSymbolExposure ||
    mtfx.execution?.singleSymbolExposure !== implementationDirective.policy?.singleSymbolExposure ||
    runtime.execution?.automaticSignalReplacement !== "OPPOSITE_CURRENT_FULLY_CONFIRMED_ONLY" ||
    mtfx.execution?.automaticSignalReplacement !== "OPPOSITE_CURRENT_FULLY_CONFIRMED_ONLY" ||
    runtime.execution?.maximumEntryDisplacementBps !== 50 ||
    runtime.execution?.maximumEntrySignalAgeMs !== 180000 ||
    runtime.execution?.entryDisplacementReference !== "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE" ||
    runtime.execution?.maximumCompleteLifecycleCostR !== 0.12 ||
    mtfx.signal?.maximumEntryDisplacementBps !== 50 ||
    mtfx.signal?.maximumEntrySignalAgeMs !== 180000 ||
    mtfx.signal?.entryDisplacementReference !== "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE" ||
    mtfx.signal?.maximumCompleteLifecycleCostR !== 0.12 ||
    mtfx.costAdjustedRisk?.maximumCompleteLifecycleCostR !== 0.12 ||
    mtfx.costAdjustedRisk?.gateBeforePositionSizing !== true ||
    current.activeResearchCandidate?.implementationRevision !== mtfx.implementationRevision ||
    current.activeResearchCandidate?.implementationDirectiveId !== implementationDirective.id ||
    current.activeResearchCandidate?.entryTiming?.entryQuality?.maximumEntryDisplacementBps !== 50 ||
    current.activeResearchCandidate?.entryTiming?.entryQuality?.maximumEntrySignalAgeMs !== 180000 ||
    current.activeResearchCandidate?.entryTiming?.entryQuality?.displacementReference !== "LATEST_EXECUTABLE_PUBLIC_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE" ||
    current.activeResearchCandidate?.entryTiming?.costEfficiency?.maximumCompleteLifecycleCostR !== 0.12 ||
    current.activeResearchCandidate?.entryTiming?.costEfficiency?.revalidation !== "REQUIRED_BEFORE_POSITION_SIZING_ON_EVERY_SUBMISSION_ATTEMPT" ||
    current.activeResearchCandidate?.deployment?.configuredRevision !== mtfx.implementationRevision ||
    !(current.activeResearchCandidate?.deployment?.observedRunningPid > 0) ||
    current.activeResearchCandidate?.deployment?.activationStatus !== "ACTIVE_R22_BALANCED_PROFIT_REALIZATION" ||
    current.activeResearchCandidate?.deployment?.observedRunningRevision !== mtfx.implementationRevision ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.immutableVersionedPositionFingerprintBefore !== current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.immutableVersionedPositionFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.r21ProfitProtectionCoreFingerprintBefore !== current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.r21ProfitProtectionCoreFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.administrativeClosureCount !== 0 ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.retroactiveR22PartialExitCount !== 0 ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.ledgerAndEquityPreserved !== true ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.r21ProfitProtectionStatePreserved !== true ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.websocketConnected !== true ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.onlineLedgerStatus !== "SYNCED" ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.abnormalLossGateStatus !== "CLEAR" ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.residentSupervisorHealth !== "HEALTHY" ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.v3RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.v3SourceMutated !== false ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.v4RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.v4SourceMutated !== false ||
    current.activeResearchCandidate?.deployment?.r22CutoverOutcome?.evidence !== "governance/evidence/mtfx-r22-balanced-profit-realization-v2-20260828.json" ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.immutablePositionIdentityAndEntryFingerprintBefore !== current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.immutablePositionIdentityAndEntryFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.administrativeClosureCount !== 0 ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.ledgerAndEquityPreserved !== true ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.onlineLedgerStatus !== "SYNCED" ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.costEfficiencyGate?.maximumCompleteLifecycleCostR !== 0.12 ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.costEfficiencyGate?.evaluatedBeforePositionSizing !== true ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.v3RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r20CutoverOutcome?.v4RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.immutablePositionAndAccountingFingerprintBefore !== current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.immutablePositionAndAccountingFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.administrativeClosureCount !== 0 ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.ledgerAndEquityPreserved !== true ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.onlineLedgerStatus !== "SYNCED" ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.v3RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r19CutoverOutcome?.v4RuntimeMutated !== false ||
    current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.immutablePositionAndAccountingFingerprintBefore !== current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.immutablePositionAndAccountingFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.administrativeClosureCount !== 0 ||
    current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.ledgerAndEquityPreserved !== true ||
    current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.onlineLedgerStatus !== "SYNCED" ||
    current.activeResearchCandidate?.deployment?.r18CutoverOutcome?.v3RuntimeMutated !== false ||
    runtime.eventRisk?.authorizationId !== implementationDirective.id ||
    runtime.eventRisk?.existingPositions !== r20ImplementationDirective.policy?.eventRisk?.existingPositions ||
    mtfx.eventRisk?.authorizationId !== implementationDirective.id ||
    current.activeResearchCandidate?.eventRisk?.authorizationId !== implementationDirective.id ||
    !Array.isArray(tier1EventCalendar.events) || tier1EventCalendar.events.length < 1 ||
    tier1EventCalendar.events.some((event) => event.tier !== "TIER1" || !event.id || !Number.isFinite(Date.parse(event.scheduledAt)) || !String(event.sourceUrl).startsWith("https://"))) {
  throw new Error("MTFX_IMPLEMENTATION_AUTHORIZATION_CHAIN_INVALID");
}
if (current.incorporatedImplementationPatch?.authorizationId !== structureHygieneDirective.id ||
    current.incorporatedImplementationPatch?.status !== "INCORPORATED_ACTIVE_IN_R7" ||
    structureHygieneDirective.status !== "INCORPORATED_IN_R5" ||
    structureHygieneDirective.activation?.restartCurrentDaemonNow !== true ||
    structureHygieneDirective.activation?.modifyOpenPositions !== false ||
    mtfx.stop?.requireInterveningOppositeStructure !== true ||
    mtfx.stop?.minimumProgressionFractionOfWeakerProminence !== 0.1 ||
    mtfx.stop?.structureHygienePatch !== "ACTIVE") {
  throw new Error("MTFX_STRUCTURE_HYGIENE_PATCH_INVALID");
}
if (authorization.paperScope.riskAllocationMode !== "FIXED_PER_INTERSECTION_CAP" || authorization.paperScope.maximumRiskPerIntersectionFraction !== 0.01 || authorization.paperScope.maximumPortfolioRiskFraction !== 0.05) {
  throw new Error("MTFX_RISK_AUTHORIZATION_INVALID");
}
if (dailyLossGateDirective.status !== "SUPERSEDED" ||
    dailyLossGateDirective.supersededBy !== lossGatesRemovedDirective.id ||
    dailyLossGateDirective.amends !== `${authorization.id}#paperScope.dailyRealizedLossStopFraction` ||
    lossGatesRemovedDirective.status !== "SUPERSEDED" ||
    lossGatesRemovedDirective.supersededBy !== positionCapacityDirective.id ||
    lossGatesRemovedDirective.amends !== dailyLossGateDirective.id ||
    lossGatesRemovedDirective.paperPolicy?.dailyRealizedLossStopEnabled !== false ||
    lossGatesRemovedDirective.paperPolicy?.dailyRealizedLossStopFraction !== null ||
    lossGatesRemovedDirective.paperPolicy?.maximumDrawdownKillEnabled !== false ||
    lossGatesRemovedDirective.paperPolicy?.maximumDrawdownKillFraction !== null ||
    positionCapacityDirective.status !== "ACTIVE" ||
    positionCapacityDirective.amends !== lossGatesRemovedDirective.id ||
    positionCapacityDirective.scopeAmendmentOf !== authorization.id ||
    positionCapacityDirective.experimentalControlConditionsPreserved?.maximumOpenPositions !== 10 ||
    !["AUTHORIZED_PENDING_RUNTIME_VERIFICATION", "ACTIVE_VERIFIED"].includes(v2Risk2Pct10PctDirective.status) ||
    v2Risk2Pct10PctDirective.scope !== "ORION_V2_PAPER_ONLY" ||
    v2Risk2Pct10PctDirective.supersedesOnly?.previousRiskDirectiveId !== positionCapacityDirective.id ||
    v2Risk2Pct10PctDirective.requestedRiskControls?.allocationMode !== "FIXED_PER_INTERSECTION_CAP" ||
    v2Risk2Pct10PctDirective.requestedRiskControls?.maximumRiskPerIntersectionFraction !== 0.02 ||
    v2Risk2Pct10PctDirective.requestedRiskControls?.maximumPortfolioRiskFraction !== 0.1 ||
    v2Risk2Pct10PctDirective.requestedRiskControls?.application !== "FORWARD_ELIGIBLE_NEW_ENTRIES_ONLY" ||
    v2Risk2Pct10PctDirective.preserves?.maximumOpenPositionsTotal !== 10 ||
    v2Risk2Pct10PctDirective.preserves?.maximumLeverage !== 4 ||
    v2Risk2Pct10PctDirective.preserves?.existingPositionQuantityAndInitialRiskUnchangedByCutover !== true ||
    v2Risk2Pct10PctDirective.preserves?.stopWideningAllowed !== false ||
    v2Risk2Pct10PctDirective.preserves?.realOrdersAllowed !== false ||
    v2Risk2Pct10PctDirective.preserves?.testnetOrdersAllowed !== false ||
    v2Risk2Pct10PctDirective.preserves?.otherVersionsAndS1Unchanged !== true ||
    v2Risk2Pct10PctDirective.preserves?.shadowBooksAutomaticInheritanceAllowed !== false ||
    v2Risk2Pct10PctDirective.actualRuntimeEffectiveAt !== "2026-09-10T18:15:51.771Z" ||
    v2Risk2Pct10PctDirective.runtimeEvidence !== "governance/evidence/v2-risk-2pct-10pct-20260911.json" ||
    current.paperRisk?.authorizationId !== v2Risk2Pct10PctDirective.authorizationId ||
    current.paperRisk?.maximumRiskPerIntersectionFraction !== 0.02 ||
    current.paperRisk?.maximumPortfolioRiskFraction !== 0.1 ||
    current.paperRisk?.application !== "FORWARD_ELIGIBLE_NEW_ENTRIES_ONLY" ||
    current.paperRisk?.actualRuntimeEffectiveAt !== v2Risk2Pct10PctDirective.actualRuntimeEffectiveAt ||
    current.paperRisk?.runtimeEvidence !== v2Risk2Pct10PctDirective.runtimeEvidence ||
    current.paperRisk?.dailyRealizedLossStopEnabled !== false ||
    current.paperRisk?.dailyRealizedLossStopFraction !== null ||
    current.paperRisk?.maximumDrawdownKillEnabled !== false ||
    current.paperRisk?.maximumDrawdownKillFraction !== null ||
    runtime.paperRiskDirectiveId !== v2Risk2Pct10PctDirective.authorizationId ||
    runtime.paperRisk?.riskPerIntersectionFraction !== 0.02 ||
    runtime.paperRisk?.maximumPortfolioRiskFraction !== 0.1 ||
    mtfx.futurePaperRisk?.authorizationId !== v2Risk2Pct10PctDirective.authorizationId ||
    mtfx.futurePaperRisk?.maximumRiskPerIntersectionFraction !== 0.02 ||
    mtfx.futurePaperRisk?.maximumPortfolioRiskFraction !== 0.1 ||
    mtfx.futurePaperRisk?.application !== "FORWARD_ELIGIBLE_NEW_ENTRIES_ONLY" ||
    mtfx.signal?.oneEntryMaximumPerIntersection !== true ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.newPid !== 23850 ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.residentSupervisorPid !== 33743 ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.maximumRiskPerIntersectionFraction !== 0.02 ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.maximumPortfolioRiskFraction !== 0.1 ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.immutablePositionFingerprintBefore !== current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.immutablePositionFingerprintAfter ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.ledgerAndEquityPreserved !== true ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.shadowRiskMutated !== false ||
    current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome?.realOrTestnetExecutionEnabled !== false ||
    runtime.paperRisk?.maximumOpenPositionsTotal !== 10 ||
    current.paperRisk?.maximumOpenPositionsTotal !== 10 ||
    runtime.paperRisk?.dailyRealizedLossStopEnabled !== false ||
    runtime.paperRisk?.dailyRealizedLossStopFraction !== null ||
    runtime.paperRisk?.maximumDrawdownKillEnabled !== false ||
    runtime.paperRisk?.maximumDrawdownKillFraction !== null) {
  throw new Error("MTFX_LOSS_GATES_REMOVAL_INVALID");
}
if (current.communications.authorizationId !== modularOnDemandViewsPolicy.id ||
    current.communications.presentationContract?.authorizationId !== modularOnDemandViewsPolicy.id ||
    current.communications.presentationContract?.views?.POSITIONS !== "ON_DEMAND_POSITION_VIEW" ||
    current.communications.presentationContract?.views?.EQUITY !== "ON_DEMAND_EQUITY_VIEW" ||
    current.communications.presentationContract?.views?.CANDIDATES !== "ON_DEMAND_CANDIDATE_VIEW" ||
    current.communications.presentationContract?.views?.PANORAMA !== "ON_DEMAND_ACCOUNT_PANORAMA_VIEW" ||
    current.communications.scheduledConversationBroadcasts !== false ||
    current.communications.onDemandPositionsReport?.command !== "npm run v2:mtfx:paper:positions" ||
    current.communications.onDemandCandidatesReport?.command !== "npm run v2:mtfx:paper:candidates" ||
    current.communications.onDemandEquityReport?.command !== "npm run v2:mtfx:paper:equity" ||
    current.communications.onDemandAccountPanorama?.command !== "npm run v2:mtfx:paper:panorama" ||
    current.communications.genericReportRequest?.fullExpansionAllowed !== false ||
    modularOnDemandViewsPolicy.commandRouting?.["仓位"]?.view !== "POSITIONS v1" ||
    modularOnDemandViewsPolicy.commandRouting?.["候选"]?.view !== "CANDIDATES v1" ||
    modularOnDemandViewsPolicy.commandRouting?.["账号权益"]?.view !== "EQUITY v1" ||
    modularOnDemandViewsPolicy.commandRouting?.["账户全景"]?.view !== "PANORAMA v1" ||
    modularOnDemandViewsPolicy.commandRouting?.["播报"]?.fullExpansionAllowed !== false ||
    modularOnDemandViewsPolicy.delivery?.crossModuleMergingAllowed !== false ||
    modularOnDemandViewsPolicy.delivery?.panoramaIsOnlyMergeException !== true ||
    current.communications.strongCandidateAlerts?.enabled !== false ||
    current.communications.paperEntryAlerts?.enabled !== true ||
    current.communications.paperEntryAlerts?.eventType !== "PAPER_POSITION_OPENED" ||
    current.communications.paperEntryAlerts?.deliveryMode !== "LOCAL_LAUNCHAGENT_MACOS_NOTIFICATION" ||
    current.communications.paperEntryAlerts?.launchAgentLabel !== "com.codex.orion-v2-entry-notifier" ||
    current.communications.paperEntryAlerts?.processMode !== "PERSISTENT_LEDGER_EVENT_WATCHER" ||
    current.communications.paperEntryAlerts?.watchIntervalMilliseconds !== 1000 ||
    current.communications.paperEntryAlerts?.targetNotificationLatencySeconds !== 1 ||
    current.communications.paperEntryAlerts?.messageDetail !== "COMPACT_COMPLETE_ENTRY_EVIDENCE" ||
    current.communications.paperEntryAlerts?.codexAutomationId !== null ||
    current.communications.paperEntryAlerts?.conversationHeartbeatEnabled !== false ||
    current.communications.paperEntryAlerts?.ordinaryCheckCreatesConversationMessage !== false ||
    current.communications.paperEntryAlerts?.ordinaryCheckCreatesChatTask !== false ||
    completeEntryBriefPolicy.status !== "ACTIVE" ||
    completeEntryBriefPolicy.supersedes !== immediateEntryNotifierPolicy.id ||
    immediateEntryNotifierPolicy.status !== "SUPERSEDED" ||
    immediateEntryNotifierPolicy.supersedes !== localEntryNotifierPolicy.id ||
    immediateEntryNotifierPolicy.supersededBy !== completeEntryBriefPolicy.id ||
    localEntryNotifierPolicy.status !== "SUPERSEDED" ||
    localEntryNotifierPolicy.supersededBy !== immediateEntryNotifierPolicy.id ||
    localEntryNotifierPolicy.supersedes !== backgroundEntryAlertPolicy.id ||
    backgroundEntryAlertPolicy.status !== "SUPERSEDED" ||
    backgroundEntryAlertPolicy.supersededBy !== localEntryNotifierPolicy.id ||
    backgroundEntryAlertPolicy.supersedes !== entryAlertPolicy.id ||
    entryAlertPolicy.status !== "SUPERSEDED" ||
    entryAlertPolicy.supersededBy !== backgroundEntryAlertPolicy.id ||
    entryAlertPolicy.supersedes !== broadcastPolicy.id ||
    broadcastPolicy.supersededBy !== entryAlertPolicy.id ||
    broadcastPolicy.supersedes !== priorBroadcastPolicy.id ||
    priorBroadcastPolicy.supersededBy !== broadcastPolicy.id) {
  throw new Error("MTFX_ENTRY_ALERT_ONLY_COMMUNICATION_POLICY_INVALID");
}
if (current.paperBooks?.authorizationId !== retireTpControlBookPolicy.id ||
    current.paperBooks?.active?.length !== 1 ||
    current.paperBooks?.active?.[0] !== "MTFX-T" ||
    current.paperBooks?.retired?.length !== 1 ||
    current.paperBooks?.retired?.[0] !== "MTFX-TP" ||
    current.paperBooks?.retiredBookVisibleInActiveReports !== false ||
    retireTpControlBookPolicy.status !== "ACTIVE" ||
    retireTpControlBookPolicy.policy?.historicalEvidence !== "PRESERVE_READ_ONLY" ||
    runtime.books?.length !== 1 ||
    runtime.books?.[0]?.variant !== "MTFX-T" ||
    runtime.books?.[0]?.entryEnabled !== true) {
  throw new Error("MTFX_TP_CONTROL_BOOK_RETIREMENT_INVALID");
}
if (current.contextMemoryHygiene?.authorizationId !== sessionBroadcastArchivePolicy.id ||
    current.contextMemoryHygiene?.baseAuthorizationId !== contextMemoryHygienePolicy.id ||
    current.contextMemoryHygiene?.protocolVersion !== "1.3.0" ||
    current.contextMemoryHygiene?.status !== "ACTIVE" ||
    current.contextMemoryHygiene?.fullTranscriptReplayDefault !== false ||
    current.contextMemoryHygiene?.crossAgentMode !== "DELTA_AND_EVIDENCE_INDEX_ONLY" ||
    !current.contextMemoryHygiene?.excludedFromNormalConversation?.includes("NO_REPLY") ||
    !current.contextMemoryHygiene?.excludedFromNormalConversation?.includes("HEALTH_HEARTBEAT") ||
    contextMemoryHygienePolicy.status !== "ACTIVE" ||
    sessionBroadcastArchivePolicy.status !== "ACTIVE" ||
    sessionBroadcastArchivePolicy.amends !== contextMemoryHygienePolicy.id ||
    contextMemoryHygienePolicy.policy?.fullTranscriptReplayDefault !== false) {
  throw new Error("CONTEXT_MEMORY_HYGIENE_POLICY_INVALID");
}
if (current.sessionBroadcastArchival?.authorizationId !== sessionBroadcastArchivePolicy.id ||
    current.sessionBroadcastArchival?.status !== "ACTIVE" ||
    current.sessionBroadcastArchival?.mode !== "HOST_COMPACT_EVIDENCE_THEN_ARCHIVE_EPHEMERAL_THREAD" ||
    current.sessionBroadcastArchival?.mainTaskAutoArchive !== false ||
    current.sessionBroadcastArchival?.pinnedTaskAutoArchive !== false ||
    current.sessionBroadcastArchival?.ownerActiveTaskAutoArchive !== false ||
    current.sessionBroadcastArchival?.ephemeralStandaloneBroadcastTaskAutoArchive !== true ||
    current.sessionBroadcastArchival?.deleteTask !== false ||
    current.sessionBroadcastArchival?.failClosed !== true ||
    sessionBroadcastArchivePolicy.policy?.archiveIsReversible !== true ||
    sessionBroadcastArchivePolicy.policy?.failureBehavior !== "KEEP_TASK_UNARCHIVED_AND_REPORT_ARCHIVE_INTEGRITY_FAILURE") {
  throw new Error("SESSION_BROADCAST_ARCHIVE_POLICY_INVALID");
}
if (current.paperToLiveEvaluation?.authorizationId !== paperToLiveEvaluationPolicy.id ||
    current.paperToLiveEvaluation?.status !== "ACTIVE_LONG_TERM_MANDATE" ||
    current.paperToLiveEvaluation?.strictEvidenceRequired !== true ||
    current.paperToLiveEvaluation?.currentStage !== "PAPER_SIMULATION_AND_OWNER_DIRECTED_BINANCE_DEMO" ||
    current.paperToLiveEvaluation?.testnetExecutionAgent !== "ORION V3" ||
    current.paperToLiveEvaluation?.testnetExecutionAuthorizationId !== orionV3BinanceDemoPolicy.id ||
    current.paperToLiveEvaluation?.automaticPromotionAllowed !== false ||
    current.paperToLiveEvaluation?.realExecutionAuthorized !== false ||
    current.paperToLiveEvaluation?.ownerApprovalRequiredForEveryPromotion !== true ||
    paperToLiveEvaluationPolicy.status !== "ACTIVE_LONG_TERM_MANDATE" ||
    paperToLiveEvaluationPolicy.promotionPolicy?.realExecutionAuthorized !== false ||
    paperToLiveEvaluationPolicy.promotionPolicy?.testnetExecutionAuthorized !== false ||
    paperToLiveEvaluationPolicy.promotionPolicy?.ownerApprovalRequiredForEveryPromotion !== true) {
  throw new Error("PAPER_TO_LIVE_STRICT_EVALUATION_MANDATE_INVALID");
}
if (current.binanceUsdmTestnetReadOnlyReconciliation?.authorizationId !== testnetReadOnlyReconciliationPolicy.id ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.credentialProvisioningAuthorizationId !== testnetDemoCredentialPolicy.id ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.status !== "PHASE_1_EVIDENCE_RETAINED_PHASE_2_ACTIVE" ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.stage !== "PHASE_1_READ_ONLY_TOOL_RETAINED_ALONGSIDE_V3_PHASE_2" ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.activation !== "READ_ONLY_TOOL_REQUIRES_EXPLICIT_LOCAL_ENABLEMENT" ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.testnetOrdersAllowed !== false ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.realOrdersAllowed !== false ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.paperRuntimeMutationAllowed !== false ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.paperLedgerMutationAllowed !== false ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.productionEndpointsAllowed !== false ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.effectiveGatewayPermissions !== "THIS_RECONCILIATION_TOOL_REMAINS_GET_ONLY_V3_TRADING_IS_SEPARATE" ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.phase2ActivationAllowedNow !== true ||
    current.binanceUsdmTestnetReadOnlyReconciliation?.phase2ActivationAuthorizationId !== orionV3BinanceDemoPolicy.id ||
    testnetReadOnlyReconciliationPolicy.status !== "ACTIVE_AWAITING_CREDENTIAL_PROVISIONING" ||
    testnetReadOnlyReconciliationPolicy.permissions?.testnetOrders !== false ||
    testnetReadOnlyReconciliationPolicy.permissions?.realOrders !== false ||
    testnetReadOnlyReconciliationPolicy.scope?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    testnetDemoCredentialPolicy.status !== "ACTIVE_CREDENTIAL_PROVISIONED_AND_PHASE2_REQUEST_RECORDED" ||
    testnetDemoCredentialPolicy.phase1?.testnetOrdersAllowed !== false ||
    testnetDemoCredentialPolicy.phase2Request?.activationAllowedNow !== false ||
    testnetDemoCredentialPolicy.phase2Request?.maximumScopeWhenReviewed?.realOrdersAllowed !== false ||
    testnetReadOnlyGate.status !== "ACTIVE_OWNER_AUTHORIZED_BINANCE_DEMO_TRADING" ||
    JSON.stringify(testnetReadOnlyGate.requirements?.keychainAccounts) !== JSON.stringify(["demo-hmac-api-key-v1", "demo-hmac-api-secret-v1"]) ||
    testnetReadOnlyGate.implementation?.orderSubmissionImplemented !== true ||
    testnetReadOnlyGate.implementation?.orderCancellationImplemented !== true ||
    testnetReadOnlyGate.implementation?.productionOrderAllowed !== false ||
    JSON.stringify(testnetReadOnlyGate.requirements?.allowedMethods) !== JSON.stringify(["GET", "POST", "DELETE"])) {
  throw new Error("TESTNET_READ_ONLY_RECONCILIATION_BOUNDARY_INVALID");
}
if (current.binanceUsdmFreeReplay?.authorizationId !== binanceFreeReplayPolicy.id ||
    current.binanceUsdmFreeReplay?.status !== "ACTIVE_PUBLIC_REPLAY_MCP" ||
    current.binanceUsdmFreeReplay?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    JSON.stringify(current.binanceUsdmFreeReplay?.allowedMethods) !== JSON.stringify(["GET"]) ||
    JSON.stringify(current.binanceUsdmFreeReplay?.allowedEndpoints) !== JSON.stringify(["/fapi/v1/klines"]) ||
    current.binanceUsdmFreeReplay?.fullyClosedBarsOnly !== true ||
    current.binanceUsdmFreeReplay?.referenceAdapterIsCurrentMtfx !== false ||
    current.binanceUsdmFreeReplay?.credentialsAllowed !== false ||
    current.binanceUsdmFreeReplay?.signedRequestsAllowed !== false ||
    current.binanceUsdmFreeReplay?.orderEndpointsAllowed !== false ||
    current.binanceUsdmFreeReplay?.paperRuntimeMutationAllowed !== false ||
    current.binanceUsdmFreeReplay?.paperLedgerMutationAllowed !== false ||
    current.binanceUsdmFreeReplay?.testnetOrdersAllowed !== false ||
    current.binanceUsdmFreeReplay?.realOrdersAllowed !== false ||
    current.binanceUsdmFreeReplay?.gate1Eligible !== false ||
    binanceFreeReplayPolicy.status !== "ACTIVE" ||
    binanceFreeReplayPolicy.permissions?.exchangeCredentials !== false ||
    binanceFreeReplayPolicy.permissions?.signedRequests !== false ||
    binanceFreeReplayPolicy.permissions?.orderEndpoints !== false ||
    binanceFreeReplayPolicy.permissions?.testnetOrders !== false ||
    binanceFreeReplayPolicy.permissions?.realOrders !== false ||
    binanceFreeReplayPolicy.evidenceBoundary?.gate1Eligible !== false ||
    binanceFreeReplayPolicy.testnetRelationship?.phase2StillRequiresNewOwnerAuthorization !== true) {
  throw new Error("BINANCE_FREE_REPLAY_BOUNDARY_INVALID");
}
const orionV3Hf14Active = requiresSingleZ(orionV3HighFrequencyStrategy);
const orionV3EntryInterval = entryDecisionInterval(orionV3HighFrequencyStrategy);
const orionV3DecisionReference = `LATEST_EXECUTABLE_BBO_VERSUS_CONFIRMED_${orionV3EntryInterval.toUpperCase()}_DECISION_CLOSE`;
const orionV3AuthorizationDecisionReference = `LATEST_EXECUTABLE_BBO_VERSUS_SECOND_CONFIRMED_${orionV3EntryInterval.toUpperCase()}_DECISION_CLOSE`;
const orionV3MarketStateBoundaryValid = orionV3Hf14Active
  ? current.orionV3BinanceUsdmDemo?.marketStateGate?.executionGate === false &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.observationOnly === true &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.requestInExecutionScan === false &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.missingEvidenceAction === "NOT_AN_EXECUTION_INPUT" &&
    orionV3Runtime.scanner?.marketStateInterval === "OBSERVE_ONLY_NOT_EXECUTION_INPUT" &&
    orionV3HighFrequencyStrategy.marketStateGate?.enabled === false &&
    orionV3HighFrequencyStrategy.marketStateGate?.executionGate === false &&
    orionV3HighFrequencyStrategy.marketStateGate?.observationOnly === true &&
    orionV3HighFrequencyStrategy.marketStateGate?.requestInExecutionScan === false
  : current.orionV3BinanceUsdmDemo?.marketStateGate?.interval === "4h" &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.source === "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.unfinishedBarsAllowed === false &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.oneHourHierarchySubstitutionAllowed === false &&
    current.orionV3BinanceUsdmDemo?.marketStateGate?.symbolSpecificOverridesAllowed === false &&
    orionV3Runtime.scanner?.marketStateInterval === "4h" && orionV3HighFrequencyStrategy.marketStateGate?.enabled === true;
if (!current.agents?.some((agent) => agent.id === "orion-v3" && agent.lifecycle === "ACTIVE_OWNER_AUTHORIZED_AUTOMATED_TESTNET_TRADING" && agent.authority === "L2_BINANCE_USDM_DEMO_AUTOMATED_NO_REAL_EXECUTION") ||
    current.orionV3BinanceUsdmDemo?.authorizationId !== orionV3BinanceDemoPolicy.id ||
    current.orionV3BinanceUsdmDemo?.status !== "ACTIVE_OWNER_AUTHORIZED_AUTOMATED_TESTNET_TRADING" ||
    current.orionV3BinanceUsdmDemo?.automaticExecutionAuthorizationId !== orionV3AutomaticExecutionPolicy.id ||
    current.orionV3BinanceUsdmDemo?.riskPolicyAuthorizationId !== orionV3RiskPolicy.id ||
    current.orionV3BinanceUsdmDemo?.riskPolicyRevision !== orionV3RiskPolicy.riskPolicyRevision ||
    current.orionV3BinanceUsdmDemo?.scanUniverseAuthorizationId !== orionV3V4TieredScanPolicy.id ||
    current.orionV3BinanceUsdmDemo?.networkEnabled !== true ||
    current.orionV3BinanceUsdmDemo?.credentialAccessAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.signedRequestsAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.testnetOrdersAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.orderCancellationAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.initialLeverageAuthorizationId !== orionV3LeverageAlignmentPolicy.id ||
    current.orionV3BinanceUsdmDemo?.exchangeInitialLeverage?.target !== 10 ||
    current.orionV3BinanceUsdmDemo?.exchangeInitialLeverage?.allowedEndpoint !== "POST /fapi/v1/leverage" ||
    current.orionV3BinanceUsdmDemo?.exchangeInitialLeverage?.marginModeChangesAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.realOrdersAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.productionEndpointsAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.v2RuntimeMutationAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.v2LedgerMutationAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.residentStartAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.residentStartScope !== orionV3ReleaseMigration.residentScope ||
    current.orionV3BinanceUsdmDemo?.highFrequencyAuthorizationId !== orionV3HighFrequencyPolicy.id ||
    current.orionV3BinanceUsdmDemo?.strategyVersion !== "ORION-V3-RESEARCH-MTFX-HF-0.5.0" ||
    current.orionV3BinanceUsdmDemo?.implementationRevision !== orionV3HighFrequencyStrategy.implementationRevision ||
    current.orionV3BinanceUsdmDemo?.entryQualityGuards?.maximumEntryDisplacementBps !== 75 ||
    current.orionV3BinanceUsdmDemo?.entryQualityGuards?.maximumEntrySignalAgeMs !== 300000 ||
    current.orionV3BinanceUsdmDemo?.entryQualityGuards?.displacementReference !== orionV3DecisionReference ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.minimumPrimaryHierarchyMultiplier !== 4 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.minimumOpposingHierarchyMultiplier !== 2 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumPrimaryProjectionSpanMultiples !== 2 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumOpposingProjectionSpanMultiples !== 2 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.minimumDiscoveryLeadMinutes !== 5 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumLeadHours !== 6 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.priceProximityRequired !== false ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
    current.orionV3BinanceUsdmDemo?.intersectionRangeGuards?.minimumAutomaticExecutionConsensusSupport !== 1 ||
    current.orionV3BinanceUsdmDemo?.evaluationIsolation?.forwardCohortId !== orionV3ReleaseMigration.cohort ||
    !orionV3MarketStateBoundaryValid ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.interval !== "4h" ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.source !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.pivotRule !== "SYMMETRIC_TWO_LEFT_TWO_RIGHT_PRICE_TIME_PIVOT" ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.unfinishedBarsAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.oneHourHierarchySubstitutionAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.marketStateGate?.symbolSpecificOverridesAllowed !== false ||
    current.orionV3BinanceUsdmDemo?.reentryLineageGate?.enabled !== true ||
    current.orionV3BinanceUsdmDemo?.reentryLineageGate?.requiredChange !== "BOTH_PRIMARY_1H_AND_OPPOSING_15M_CONFIRMED_ANCHOR_PAIRS" ||
    current.orionV3BinanceUsdmDemo?.reentryLineageGate?.missingEvidenceAction !== "FAIL_CLOSED" ||
    current.orionV3BinanceUsdmDemo?.outcomeAttribution?.historicalAccountFactsRewritten !== false ||
    current.orionV3BinanceUsdmDemo?.exchangeInitialLeverage?.symbols?.length !== 30 ||
    current.orionV3BinanceUsdmDemo?.scanTopology?.broadUniverseSize !== 30 ||
    current.orionV3BinanceUsdmDemo?.scanTopology?.structuralDiscoveryIntervalMs !== 300000 ||
    current.orionV3BinanceUsdmDemo?.scanTopology?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
    current.orionV3BinanceUsdmDemo?.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
    current.orionV3BinanceUsdmDemo?.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
    current.orionV3BinanceUsdmDemo?.accountAndPresentationAuthorizationId !== orionV3AccountPolicy.id ||
    current.orionV3BinanceUsdmDemo?.strategyInitialCapitalUsdt !== 5000 ||
    current.orionV3BinanceUsdmDemo?.performanceBaselineUsdt !== 5000 ||
    current.orionV3BinanceUsdmDemo?.equityDisplaySource !== "BINANCE_USDM_DEMO_SIGNED_ACCOUNT_ACTUAL" ||
    current.orionV3BinanceUsdmDemo?.feeLedgerAuthorizationId !== orionV3FeeLedgerPolicy.id ||
    current.orionV3BinanceUsdmDemo?.commissionEvidenceEndpoint !== "GET /fapi/v1/userTrades" ||
    current.orionV3BinanceUsdmDemo?.equityAttributionAuthorizationId !== orionV3EquityAttributionPolicy.id ||
    current.orionV3BinanceUsdmDemo?.equityAttribution?.incomeEndpoint !== "GET /fapi/v1/income" ||
    current.orionV3BinanceUsdmDemo?.equityAttribution?.status !== "ACTIVE_VERIFIED_RECONCILED" ||
    current.orionV3BinanceUsdmDemo?.equityAttribution?.feesDoubleSubtracted !== false ||
    current.orionV3BinanceUsdmDemo?.equityAttribution?.strategyLedgerCoverageStatus !== "RECONCILED" ||
    current.orionV3BinanceUsdmDemo?.maximumOpenPositionsTotal !== 18 ||
    current.orionV3BinanceUsdmDemo?.hardRisk?.maximumEffectiveNotionalLeverage !== 10 ||
    current.orionV3BinanceUsdmDemo?.residentScanner?.status !== "ACTIVE_RESIDENT_AUTOMATED_BINANCE_DEMO_EXECUTION" ||
    current.orionV3BinanceUsdmDemo?.residentScanner?.automaticOrderSubmissionAllowed !== true ||
    current.orionV3BinanceUsdmDemo?.presentationContract !== "V3_CONTROL_POSITIONS_CANDIDATES_V1" ||
    orionV3AccountPolicy.status !== "ACTIVE" ||
    orionV3AccountPolicy.account?.strategyInitialCapitalUsdt !== 5000 ||
    orionV3AccountPolicy.account?.riskEquitySource !== "BINANCE_USDM_DEMO_TOTAL_MARGIN_BALANCE" ||
    orionV3BinanceDemoPolicy.status !== "ACTIVE_ON_DEMAND_BINANCE_DEMO_TRADING" ||
    orionV3BinanceDemoPolicy.activation?.allowedNow !== true ||
    orionV3BinanceDemoPolicy.venueAndMethods?.realOrdersAllowed !== false ||
    orionV3FeeLedgerPolicy.status !== "ACTIVE" ||
    orionV3FeeLedgerPolicy.permissions?.endpoint !== "GET /fapi/v1/userTrades" ||
    orionV3FeeLedgerPolicy.doesNotAuthorize?.includes("ORDER_OR_POSITION_MUTATION") !== true ||
    orionV3EquityAttributionPolicy.status !== "ACTIVE" ||
    orionV3EquityAttributionPolicy.scope?.agent !== "orion-v3" ||
    orionV3EquityAttributionPolicy.scope?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    orionV3EquityAttributionPolicy.scope?.allowedEndpoint !== "GET /fapi/v1/income" ||
    orionV3EquityAttributionPolicy.scope?.incomeHistoryStartTimeMs !== 1787041311000 ||
    orionV3EquityAttributionPolicy.presentation?.feesAlreadyIncludedMustNotBeSubtractedTwice !== true ||
    orionV3EquityAttributionPolicy.doesNotAuthorize?.includes("ORDER_OR_POSITION_MUTATION") !== true ||
    orionV3LeverageAlignmentPolicy.status !== "ACTIVE" ||
    orionV3LeverageAlignmentPolicy.scope?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    orionV3LeverageAlignmentPolicy.scope?.allowedEndpoint !== "POST /fapi/v1/leverage" ||
    orionV3RiskPolicy.status !== "ACTIVE" ||
    orionV3RiskPolicy.scope?.agent !== "orion-v3" ||
    orionV3RiskPolicy.scope?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
    orionV3RiskPolicy.scope?.maximumRiskPerEntryFraction !== 0.01 ||
    orionV3RiskPolicy.scope?.maximumManagedPortfolioRiskFraction !== 0.1 ||
    orionV3RiskPolicy.unchangedHardBoundaries?.maximumEffectiveNotionalLeverage !== 10 ||
    orionV3RiskPolicy.transition?.existingPositionEntryRiskStopOrQuantityRecalculationAllowed !== false ||
    orionV3LeverageAlignmentPolicy.scope?.targetInitialLeverage !== 10 ||
    orionV3LeverageAlignmentPolicy.hardRiskUnchanged?.maximumEffectiveNotionalLeverage !== 10 ||
    orionV3Runtime.orderModule?.status !== "IMPLEMENTED_OWNER_AUTHORIZED_AUTOMATED" ||
    orionV3Runtime.orderModule?.orderSubmissionAllowed !== true ||
    orionV3Runtime.orderModule?.orderCancellationAllowed !== true ||
    orionV3Runtime.orderModule?.initialLeverageAlignmentAuthorizationId !== orionV3LeverageAlignmentPolicy.id ||
    orionV3Runtime.orderModule?.initialLeverageAlignmentAllowed !== true ||
    orionV3Runtime.orderModule?.targetInitialLeverage !== 10 ||
    orionV3Runtime.scanUniverseAuthorizationId !== orionV3V4TieredScanPolicy.id ||
    orionV3Runtime.universe?.symbols?.length !== 30 ||
    orionV3Runtime.orderModule?.marginModeChangesAllowed !== false ||
    orionV3Runtime.strategyParity?.mode !== "OWNER_AUTHORIZED_V3_HIGH_FREQUENCY_DERIVATIVE" ||
    orionV3Runtime.strategyParity?.unversionedLocalOverridesAllowed !== false ||
    orionV3Runtime.strategyParity?.expectedStrategyVersion !== orionV3HighFrequencyStrategy.candidateVersion ||
    orionV3Runtime.strategyParity?.expectedImplementationRevision !== orionV3HighFrequencyStrategy.implementationRevision ||
    orionV3Runtime.venue?.networkEnabled !== true ||
    orionV3Runtime.venue?.productionHostsAllowed !== false ||
    orionV3Runtime.isolation?.startAllowed !== true ||
    orionV3Runtime.isolation?.startScope !== orionV3ReleaseMigration.residentScope ||
    orionV3Runtime.account?.authorizationId !== orionV3AccountPolicy.id ||
    orionV3Runtime.account?.strategyInitialCapitalUsdt !== 5000 ||
    orionV3Runtime.account?.performanceBaselineUsdt !== 5000 ||
    orionV3Runtime.account?.equityAttributionAuthorizationId !== orionV3EquityAttributionPolicy.id ||
    orionV3Runtime.account?.equityAttributionIncomeEndpoint !== "GET /fapi/v1/income" ||
    Date.parse(orionV3Runtime.account?.equityAttributionStartTime ?? "") !== 1787041311000 ||
    orionV3Runtime.account?.riskEquityCeiling !== "BINANCE_USDM_DEMO_TOTAL_MARGIN_BALANCE" ||
    orionV3Runtime.scanner?.scanIntervalMs !== 60000 ||
    orionV3Runtime.scanner?.structuralDiscoveryIntervalMs !== 300000 ||
    orionV3Runtime.scanner?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
    orionV3Runtime.scanner?.candidateSource !== orionV3ReleaseMigration.candidateSource ||
    !orionV3MarketStateBoundaryValid ||
    orionV3Runtime.scanner?.automaticOrderSubmissionAllowed !== true ||
    orionV3Runtime.presentation?.contract !== "V3_CONTROL_POSITIONS_CANDIDATES_V1" ||
    orionV3HighFrequencyStrategy.scanUniverseAuthorizationId !== orionV3V4TieredScanPolicy.id ||
    orionV3HighFrequencyStrategy.execution?.structuralDiscoveryIntervalMs !== 300000 ||
    orionV3HighFrequencyStrategy.execution?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
    orionV3V4TieredScanPolicy.status !== "ACTIVE" ||
    orionV3V4TieredScanPolicy.sharedUniverse?.symbols?.length !== 30 ||
    orionV3V4TieredScanPolicy.hardRiskUnchanged?.maximumRiskPerEntryFraction !== 0.01 ||
    orionV3V4TieredScanPolicy.hardRiskUnchanged?.maximumManagedPortfolioRiskFraction !== 0.1 ||
    orionV3V4TieredScanPolicy.isolation?.realOrdersAllowed !== false ||
    v2V3CentralDistributionPolicy.status !== "SUPERSEDED_FOR_STRATEGY_PARITY_RETAINED_AS_HISTORICAL_ROUTING_EVIDENCE" ||
    v2V3CentralDistributionPolicy.supersededBy !== orionV3ParitySeparationPolicy.id ||
    current.centralStrategyDistribution?.authorizationId !== v2V3CentralDistributionPolicy.id ||
    current.centralStrategyDistribution?.status !== "SUPERSEDED_FOR_STRATEGY_PARITY_RETAINED_AS_HISTORICAL_ROUTING_EVIDENCE" ||
    current.centralStrategyDistribution?.supersededBy !== orionV3ParitySeparationPolicy.id ||
    current.v3ExperimentalStrategyRouting?.authorizationId !== orionV3HighFrequencyPolicy.id ||
    current.v3ExperimentalStrategyRouting?.status !== "ACTIVE_CENTRALLY_GOVERNED_SEPARATE_V3_EXPERIMENT" ||
    current.v3ExperimentalStrategyRouting?.v2?.mutationAllowedByThisDirective !== false ||
    current.v3ExperimentalStrategyRouting?.v3?.riskPolicyAuthorizationId !== orionV3RiskPolicy.id ||
    current.v3ExperimentalStrategyRouting?.v3?.riskPolicyRevision !== orionV3RiskPolicy.riskPolicyRevision ||
    current.v3ExperimentalStrategyRouting?.v3?.maximumRiskPerEntryFraction !== 0.01 ||
    current.v3ExperimentalStrategyRouting?.v3?.maximumManagedPortfolioRiskFraction !== 0.1 ||
    current.v3ExperimentalStrategyRouting?.v3?.maximumOpenPositionsTotal !== 18 ||
    current.v3ExperimentalStrategyRouting?.automaticOrderSubmissionAllowed !== true ||
    current.v3ExperimentalStrategyRouting?.realOrMainnetExecutionAllowed !== false ||
    priorOrionV3HighFrequencyPolicy.status !== "SUPERSEDED" ||
    priorOrionV3HighFrequencyPolicy.supersededBy !== historicalOrionV3Hf11Policy.id ||
    orionV3HighFrequencyPolicy.status !== "ACTIVE" ||
    (orionV3Hf14Active ? (orionV3HighFrequencyPolicy.strategy?.fourHourMarketStateGateRetained !== false ||
      orionV3HighFrequencyPolicy.strategy?.marketStateObservationOnly !== true ||
      orionV3HighFrequencyPolicy.strategy?.fourHourRequestInExecutionScan !== false) :
      (orionV3HighFrequencyPolicy.strategy?.marketStateInterval !== "4h" ||
      orionV3HighFrequencyPolicy.strategy?.marketStateSource !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
      orionV3HighFrequencyPolicy.strategy?.marketStatePivotRule !== "SYMMETRIC_TWO_LEFT_TWO_RIGHT_PRICE_TIME_PIVOT" ||
      orionV3HighFrequencyPolicy.strategy?.unfinishedFourHourBarsAllowed !== false ||
      orionV3HighFrequencyPolicy.strategy?.oneHourHierarchyMultiplierMaySubstituteForTrueFourHourBars !== false ||
      orionV3HighFrequencyPolicy.strategy?.symbolSpecificThresholdsAllowed !== false)) ||
    orionV3HighFrequencyPolicy.strategy?.primaryStructureInterval !== "1h" ||
    orionV3HighFrequencyPolicy.strategy?.opposingStructureInterval !== "15m" ||
    orionV3HighFrequencyPolicy.strategy?.entryDecisionInterval !== orionV3EntryInterval ||
    orionV3HighFrequencyPolicy.strategy?.runnerTrailInterval !== "15m" ||
    (orionV3Hf14Active && (orionV3HighFrequencyPolicy.strategy?.maximumDirectionDecisionBars !== 2 ||
      orionV3HighFrequencyPolicy.strategy?.maximumReserveBars !== 4)) ||
    orionV3HighFrequencyPolicy.strategy?.maximumQueuedCandidatesPerSymbol !== 2 ||
    orionV3HighFrequencyPolicy.strategy?.maximumRankedCandidatesGlobal !== 12 ||
    orionV3HighFrequencyPolicy.strategy?.maximumNewEntriesPerCycle !== 2 ||
    orionV3HighFrequencyPolicy.strategy?.maximumPostConfirmationDisplacementBps !== 75 ||
    orionV3HighFrequencyPolicy.strategy?.maximumEntrySignalAgeMs !== 300000 ||
    orionV3HighFrequencyPolicy.strategy?.antiChaseReference !== orionV3AuthorizationDecisionReference ||
    orionV3HighFrequencyPolicy.strategy?.minimumPrimaryHierarchyMultiplier !== 4 ||
    orionV3HighFrequencyPolicy.strategy?.minimumOpposingHierarchyMultiplier !== 2 ||
    orionV3HighFrequencyPolicy.strategy?.maximumPrimaryProjectionSpanMultiples !== 2 ||
    orionV3HighFrequencyPolicy.strategy?.maximumOpposingProjectionSpanMultiples !== 2 ||
    orionV3HighFrequencyPolicy.strategy?.priceProximityRequired !== false ||
    orionV3HighFrequencyPolicy.strategy?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
    orionV3HighFrequencyPolicy.strategy?.minimumAutomaticExecutionConsensusSupport !== 1 ||
    orionV3HighFrequencyPolicy.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
    orionV3HighFrequencyPolicy.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
    orionV3HighFrequencyPolicy.hardRisk?.maximumOpenPositionsTotal !== 18 ||
    orionV3HighFrequencyStrategy.timeframes?.marketState !== "4h" ||
    !orionV3MarketStateBoundaryValid ||
    orionV3HighFrequencyStrategy.marketStateGate?.interval !== "4h" ||
    orionV3HighFrequencyStrategy.marketStateGate?.source !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
    orionV3HighFrequencyStrategy.marketStateGate?.pivotPolicy?.leftBars !== 2 ||
    orionV3HighFrequencyStrategy.marketStateGate?.pivotPolicy?.rightBars !== 2 ||
    JSON.stringify(orionV3HighFrequencyStrategy.marketStateGate?.pivotPolicy?.hierarchyWindowMultipliers) !== JSON.stringify([1]) ||
    orionV3HighFrequencyStrategy.marketStateGate?.unfinishedBarsAllowed !== false ||
    orionV3HighFrequencyStrategy.marketStateGate?.historicalSignalBackfillAllowed !== false ||
    orionV3HighFrequencyStrategy.marketStateGate?.symbolSpecificOverridesAllowed !== false ||
    orionV3HighFrequencyStrategy.timeframes?.primaryStructure !== "1h" ||
    orionV3HighFrequencyStrategy.timeframes?.opposingStructure !== "15m" ||
    orionV3HighFrequencyStrategy.timeframes?.entryDecision !== orionV3EntryInterval ||
    orionV3HighFrequencyStrategy.timeframes?.runnerTrail !== "15m" ||
    orionV3HighFrequencyStrategy.exit?.runner?.interval !== "15m" ||
    orionV3HighFrequencyStrategy.riskPolicyAuthorizationId !== orionV3RiskPolicy.id ||
    orionV3HighFrequencyStrategy.riskPolicyRevision !== orionV3RiskPolicy.riskPolicyRevision ||
    orionV3HighFrequencyStrategy.risk?.maximumRiskPerIntersectionFraction !== 0.01 ||
    orionV3HighFrequencyStrategy.risk?.maximumPortfolioRiskFraction !== 0.1 ||
    orionV3HighFrequencyStrategy.risk?.maximumLeverage !== 10 ||
    orionV3HighFrequencyStrategy.risk?.maximumOpenPositionsTotal !== 18 ||
    orionV3HighFrequencyStrategy.intersection?.maximumQueuedCandidatesPerSymbol !== 2 ||
    orionV3HighFrequencyStrategy.intersection?.maximumRankedCandidatesGlobal !== 12 ||
    orionV3HighFrequencyStrategy.signal?.maximumEntryDisplacementBps !== 75 ||
    orionV3HighFrequencyStrategy.signal?.maximumEntrySignalAgeMs !== 300000 ||
    orionV3HighFrequencyStrategy.signal?.maximumDirectionDecisionBars !== 2 ||
    orionV3HighFrequencyStrategy.signal?.maximumReserveBars !== 4 ||
    orionV3HighFrequencyStrategy.signal?.confirmationPolicy !== `TWO_CONSECUTIVE_${orionV3EntryInterval.toUpperCase()}_CLOSES_SAME_SIDE_BEYOND_INTERSECTION_BUFFER` ||
    orionV3HighFrequencyStrategy.signal?.failedPersistenceAction !== "EXPIRE_INTERSECTION_WITHOUT_REVERSE" ||
    orionV3HighFrequencyStrategy.signal?.entryDisplacementReference !== orionV3DecisionReference ||
    orionV3HighFrequencyStrategy.pivots?.primary?.minimumRealtimeHierarchyMultiplier !== 4 ||
    orionV3HighFrequencyStrategy.pivots?.opposing?.minimumRealtimeHierarchyMultiplier !== 2 ||
    orionV3HighFrequencyStrategy.intersection?.maximumPrimaryProjectionSpanMultiples !== 2 ||
    orionV3HighFrequencyStrategy.intersection?.maximumOpposingProjectionSpanMultiples !== 2 ||
    orionV3HighFrequencyStrategy.intersection?.minimumDiscoveryLeadMinutes !== 5 ||
    orionV3HighFrequencyStrategy.intersection?.maximumLeadHours !== 6 ||
    orionV3HighFrequencyStrategy.intersection?.priceProximityRequired !== false ||
    orionV3HighFrequencyStrategy.intersection?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
    orionV3HighFrequencyStrategy.intersection?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
    orionV3HighFrequencyStrategy.intersection?.minimumAutomaticExecutionConsensusSupport !== 1 ||
    orionV3HighFrequencyStrategy.intersection?.conditionalSingleHypothesisExecution?.enabled !== false ||
    orionV3HighFrequencyStrategy.execution?.maximumNewEntriesPerCycle !== 2 ||
    orionV3HighFrequencyStrategy.execution?.residentScannerAutomaticOrderSubmissionAllowed !== true ||
    orionV3HighFrequencyStrategy.reentryLineageGate?.enabled !== true ||
    !Number.isFinite(Date.parse(orionV3HighFrequencyStrategy.reentryLineageGate?.enforcedFrom ?? "")) ||
    orionV3HighFrequencyStrategy.reentryLineageGate?.requiredChange !== "BOTH_PRIMARY_1H_AND_OPPOSING_15M_CONFIRMED_ANCHOR_PAIRS" ||
    orionV3HighFrequencyStrategy.reentryLineageGate?.missingEvidenceAction !== "FAIL_CLOSED" ||
    orionV3HighFrequencyPolicy.independentLineageReentryGate?.enabled !== true ||
    orionV3HighFrequencyPolicy.outcomeAttribution?.historicalAccountFactsRewritten !== false ||
    orionV3AutomaticExecutionPolicy.status !== "ACTIVE" ||
    orionV3AutomaticExecutionPolicy.authorizes?.residentAutomaticCandidateExecution !== true ||
    orionV3AutomaticExecutionPolicy.authorizes?.automaticFifteenMinuteRunnerTrailing !== true ||
    current.orionV3BinanceUsdmDemo?.threadId !== aegisV2V3ContextHygieneRotationPolicy.rotation.orionV3.newThreadId ||
    orionV3Runtime.riskPolicyAuthorizationId !== orionV3RiskPolicy.id ||
    orionV3Runtime.riskPolicyRevision !== orionV3RiskPolicy.riskPolicyRevision ||
    orionV3Runtime.centralDistribution?.authorizationId !== orionV3HighFrequencyPolicy.id ||
    orionV3Runtime.centralDistribution?.releaseMode !== "CENTRALLY_GOVERNED_SEPARATE_V3_EXPERIMENT" ||
    orionV3Runtime.centralDistribution?.threadId !== aegisV2V3ContextHygieneRotationPolicy.rotation.orionV3.newThreadId) {
  throw new Error("ORION_V3_BINANCE_DEMO_HIGH_FREQUENCY_BOUNDARY_INVALID");
}
if (!current.agents?.some((agent) => agent.id === "orion-v3-shadow-kelly" && agent.lifecycle === "ACTIVE_OBSERVE_ONLY" && agent.authority === "L2_RESEARCH_OBSERVE_ONLY_NO_EXECUTION") ||
    priorOrionV3ShadowKellyPolicy.status !== "SUPERSEDED" ||
    priorOrionV3ShadowKellyPolicy.supersededBy !== orionV3ShadowKellyPolicy.id ||
    orionV3ShadowKellyPolicy.status !== "ACTIVE" ||
    orionV3ShadowKellyPolicy.mode !== "OBSERVE_ONLY_POSITION_SIZING_REFERENCE" ||
    current.orionV3ShadowKelly?.authorizationId !== orionV3ShadowKellyPolicy.id ||
    current.orionV3ShadowKelly?.status !== "ACTIVE_OBSERVE_ONLY_SEPARATE_THREAD" ||
    current.orionV3ShadowKelly?.threadId !== "00000000-0000-4000-8000-000000000000" ||
    current.orionV3ShadowKelly?.sourceImplementationRevisionMode !== "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE" ||
    current.orionV3ShadowKelly?.currentImplementationRevisionSource !== "orionV3BinanceUsdmDemo.implementationRevision" ||
    current.orionV3ShadowKelly?.automaticVersionSync !== true ||
    current.orionV3ShadowKelly?.versionBucketKey !== "implementationRevision" ||
    current.orionV3ShadowKelly?.historicalVersionBucketsRetained !== true ||
    current.orionV3ShadowKelly?.crossVersionPoolingAllowed !== false ||
    current.orionV3ShadowKelly?.minimumEligibleClosedPositionsPerRevision !== 100 ||
    current.orionV3ShadowKelly?.minimumWinsPerRevision !== 20 ||
    current.orionV3ShadowKelly?.minimumLossesPerRevision !== 20 ||
    current.orionV3ShadowKelly?.fractionalKelly !== 0.25 ||
    current.orionV3ShadowKelly?.maximumReferenceRiskFraction !== 0.005 ||
    current.orionV3ShadowKelly?.executionUse !== "OBSERVE_ONLY" ||
    current.orionV3ShadowKelly?.v3OrderSizingInputAllowed !== false ||
    current.orionV3ShadowKelly?.v3RiskMutationAllowed !== false ||
    current.orionV3ShadowKelly?.periodicBroadcastAllowed !== false ||
    orionV3ShadowKellyPolicy.versionSyncPolicy?.mode !== "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE" ||
    orionV3ShadowKellyPolicy.versionSyncPolicy?.currentRevisionAlwaysDisplayed !== true ||
    orionV3ShadowKellyPolicy.versionSyncPolicy?.historicalRevisionBucketsRetained !== true ||
    orionV3ShadowKellyPolicy.versionSyncPolicy?.crossVersionPoolingAllowed !== false ||
    orionV3ShadowKellyPolicy.versionSyncPolicy?.newOwnerAuthorizationRequiredForReadOnlyVersionRecognition !== false ||
    orionV3ShadowKellyPolicy.dataPolicy?.minimumEligibleClosedPositionsPerRevision !== 100 ||
    orionV3ShadowKellyPolicy.dataPolicy?.minimumWinsPerRevision !== 20 ||
    orionV3ShadowKellyPolicy.dataPolicy?.minimumLossesPerRevision !== 20 ||
    orionV3ShadowKellyPolicy.executionBoundary?.mayReadForOrderSizing !== false ||
    orionV3ShadowKellyPolicy.executionBoundary?.mayChangeV3Risk !== false ||
    orionV3ShadowKellyPolicy.executionBoundary?.mayChangeV3OrdersOrPositions !== false ||
    orionV3ShadowKellyPolicy.executionBoundary?.automaticPromotionAllowed !== false) {
  throw new Error("ORION_V3_SHADOW_KELLY_BOUNDARY_INVALID");
}
const v3AutoExecutorSource = await fs.readFile(path.join(root, "agents/orion-v3/binance-demo/auto-executor.mjs"), "utf8");
if (/shadow-kelly|shadowKellyReferenceRisk|referenceRiskFraction/.test(v3AutoExecutorSource)) {
  throw new Error("ORION_V3_SHADOW_KELLY_MUST_NOT_ENTER_EXECUTION");
}
if (mtfx.candidateVersion !== "ORION-V2-RESEARCH-MTFX-0.5.0" || mtfx.intersection.realtimeCrossMustBeInFutureBlankArea !== true) {
  throw new Error("MTFX_PRICE_TIME_STRUCTURE_VERSION_INVALID");
}
if (current.researchFactorMining?.authorizationId !== dualPriceShadowPolicy.id ||
    current.researchFactorMining?.baseAuthorizationId !== factorMiningPolicy.id ||
    current.researchFactorMining?.crossDisplacementAuthorizationId !== crossDisplacementFactorPolicy.id ||
    current.researchFactorMining?.status !== "ACTIVE_OBSERVE_ONLY" ||
    current.researchFactorMining?.crossDisplacementFactor?.entryGate !== false ||
    current.researchFactorMining?.dualPriceConfirmationShadow?.baselineOrdersBlocked !== false ||
    current.researchFactorMining?.dualPriceConfirmationShadow?.baselineRiskChanged !== false ||
    factorMiningPolicy.status !== "SUPERSEDED" ||
    factorMiningPolicy.supersededBy !== crossDisplacementFactorPolicy.id ||
    crossDisplacementFactorPolicy.status !== "SUPERSEDED" ||
    crossDisplacementFactorPolicy.supersededBy !== dualPriceShadowPolicy.id ||
    crossDisplacementFactorPolicy.amends !== factorMiningPolicy.id ||
    dualPriceShadowPolicy.status !== "ACTIVE" ||
    dualPriceShadowPolicy.amends !== crossDisplacementFactorPolicy.id ||
    dualPriceShadowPolicy.policy?.executionUse !== "OBSERVE_ONLY_SHADOW_DECISION" ||
    dualPriceShadowPolicy.policy?.baselinePaperOrdersContinueUnchanged !== true ||
    dualPriceShadowPolicy.policy?.automaticParameterLearning !== false ||
    dualPriceShadowPolicy.policy?.ownerApprovalRequiredBeforeExecutionUse !== true ||
    dualPriceShadowPolicy.doesNotChange?.includes("BASELINE_ENTRY_CONFIRMATION_RULES") !== true ||
    current.researchFactorMining?.nonEntryPostPathAuthorizationId !== nonEntryPostPathPolicy.id ||
    current.researchFactorMining?.nonEntryPostPathOutcome?.status !== "ACTIVE_OBSERVE_ONLY" ||
    current.researchFactorMining?.nonEntryPostPathOutcome?.executionGate !== false ||
    nonEntryPostPathPolicy.status !== "ACTIVE" ||
    nonEntryPostPathPolicy.supplements !== dualPriceShadowPolicy.id ||
    nonEntryPostPathPolicy.policy?.executionUse !== "OBSERVE_ONLY_NON_ENTRY_POST_PATH_RESEARCH" ||
    nonEntryPostPathPolicy.policy?.counterfactualExecutionModeled !== false ||
    nonEntryPostPathPolicy.policy?.sameBarPathKnown !== false ||
    nonEntryPostPathPolicy.policy?.ownerApprovalRequiredBeforeExecutionUse !== true ||
    nonEntryPostPathPolicy.doesNotChange?.includes("R7_ENTRY_RULES") !== true ||
    mtfx.researchFactorMining?.ownerApprovalRequiredBeforeExecutionUse !== true) {
  throw new Error("MTFX_FACTOR_MINING_POLICY_INVALID");
}
if (current.vulnerabilityDiscovery?.authorizationId !== lossGatesRemovedDirective.id ||
    current.vulnerabilityDiscovery?.status !== "ACTIVE_PAPER_OBSERVATION" ||
    current.vulnerabilityDiscovery?.dailyRealizedLossEntryGateRemoved !== true ||
    current.vulnerabilityDiscovery?.maximumDrawdownDaemonGateRemoved !== true ||
    current.vulnerabilityDiscovery?.automaticParameterLearning !== false ||
    current.vulnerabilityDiscovery?.automaticStrategyPromotion !== false ||
    current.vulnerabilityDiscovery?.ownerApprovalRequiredBeforeExecutionUse !== true ||
    current.vulnerabilityDiscovery?.runtimeCorrections?.[0]?.id !== "POST_CONNECT_BBO_COVERAGE_STICKY_GAP_FIX-20260807" ||
    current.vulnerabilityDiscovery?.runtimeCorrections?.[0]?.historicalGapEvidencePreserved !== true ||
    current.vulnerabilityDiscovery?.runtimeCorrections?.[0]?.recoveryGapPositionsExcludedFromPromotion !== true) {
  throw new Error("MTFX_VULNERABILITY_DISCOVERY_BOUNDARY_INVALID");
}

const v2AccountShadowPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-05-orion-v2-account-equity-lock-shadow.json"), "utf8"));
const v2AccountShadowEvidence = JSON.parse(await fs.readFile(path.join(root, current.orionV2AccountEquityLockShadowStudy.evidence), "utf8"));
const v2AccountShadowEngineSource = await fs.readFile(path.join(root, "app/v2-ledger/account-shadow/engine.mjs"), "utf8");
const v2LedgerApiSource = await fs.readFile(path.join(root, "app/api/mtfx-ledger/route.ts"), "utf8");
const v2AccountShadowState = current.orionV2AccountEquityLockShadowStudy;
const expectedAccountShadowTiers = [
  { minimumPeakProfitFraction: 0, lockFraction: 0, runnerFraction: 1 },
  { minimumPeakProfitFraction: 0.01, lockFraction: 0.5, runnerFraction: 0.5 },
  { minimumPeakProfitFraction: 0.02, lockFraction: 0.65, runnerFraction: 0.35 },
  { minimumPeakProfitFraction: 0.03, lockFraction: 0.7, runnerFraction: 0.3 },
  { minimumPeakProfitFraction: 0.05, lockFraction: 0.75, runnerFraction: 0.25 },
];
if (
  v2AccountShadowPolicy.status !== "ACTIVE" ||
  v2AccountShadowPolicy.appliesTo?.agent !== "orion-v2" ||
  v2AccountShadowPolicy.appliesTo?.runtime !== "ORION-V2-MTFX-PAPER-1.1" ||
  v2AccountShadowPolicy.appliesTo?.book !== "MTFX-T" ||
  v2AccountShadowPolicy.appliesTo?.baselineImplementationRevision !== "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" ||
  v2AccountShadowPolicy.appliesTo?.shadowExperimentId !== "ORION-V2-R22-ACCOUNT-EQUITY-LOCK-SHADOW-20260905" ||
  v2AccountShadowPolicy.appliesTo?.parentMonitorRoute !== "/v2-ledger" ||
  v2AccountShadowPolicy.appliesTo?.shadowMonitorRoute !== "/v2-ledger/account-shadow" ||
  v2AccountShadowPolicy.study?.status !== "ACTIVE_OBSERVE_ONLY" ||
  v2AccountShadowPolicy.study?.historicalBackfillAllowed !== false ||
  v2AccountShadowPolicy.study?.valuationScope !== "INDICATIVE_PRICE_SIDE_ONLY_NO_ORDER_BOOK_DEPTH" ||
  v2AccountShadowPolicy.study?.maximumQuoteAgeMs !== 1000 ||
  v2AccountShadowPolicy.study?.maximumCrossPositionQuoteSkewMs !== 250 ||
  v2AccountShadowPolicy.study?.maximumTransportLagMs !== 20000 ||
  v2AccountShadowPolicy.study?.highWaterConfirmation !== "TWO_DISTINCT_VALID_PRICE_SIDE_FRAMES_AT_LEAST_30_SECONDS_APART_CONFIRM_THE_LOWER_EQUITY" ||
  v2AccountShadowPolicy.study?.stressLockIncrementFraction !== 0.05 ||
  v2AccountShadowPolicy.study?.maximumLockFraction !== 0.8 ||
  v2AccountShadowPolicy.study?.minimumEligibleCompletedCampaignsForReview !== 20 ||
  v2AccountShadowPolicy.study?.requiredGivebackReductionFraction !== 0.3 ||
  v2AccountShadowPolicy.study?.minimumNetOutcomeRetentionFraction !== 0.95 ||
  v2AccountShadowPolicy.study?.minimumTrendGainRetentionFraction !== 0.8 ||
  v2AccountShadowPolicy.study?.automaticPromotionAllowed !== false ||
  v2AccountShadowPolicy.evidenceLimits?.historicalBackfillOrUnobservedGapIntervalMayAdvanceHighWater !== false ||
  v2AccountShadowPolicy.evidenceLimits?.recoveryGapPositionsMayEnterValidationStatistics !== false ||
  v2AccountShadowPolicy.evidenceLimits?.executableHighWaterClaimAllowed !== false ||
  v2AccountShadowPolicy.architecture?.baselineSnapshotStoragePrecedesShadowCalculation !== true ||
  v2AccountShadowPolicy.architecture?.baselineIngestResponseWaitsForShadowCalculation !== false ||
  v2AccountShadowPolicy.architecture?.shadowFailureMayFailBaselineLedgerIngestion !== false ||
  v2AccountShadowPolicy.architecture?.v2DaemonOrPublisherContractChanged !== false ||
  v2AccountShadowPolicy.architecture?.tradingProcessStartStopOrRestartRequired !== false ||
  !Object.values(v2AccountShadowPolicy.preserves ?? {}).every((value) => value === true) ||
  !v2AccountShadowPolicy.doesNotAuthorize?.includes("SHADOW_ACTION_AS_EXECUTION_INPUT") ||
  !v2AccountShadowPolicy.doesNotAuthorize?.includes("AUTOMATIC_POSITION_REDUCTION") ||
  !v2AccountShadowPolicy.doesNotAuthorize?.includes("KELLY_SIZING_ACTIVATION") ||
  !v2AccountShadowPolicy.doesNotAuthorize?.includes("AUTOMATIC_PROMOTION")
) {
  throw new Error("ORION_V2_ACCOUNT_EQUITY_SHADOW_AUTHORIZATION_INVALID");
}
if (
  v2AccountShadowState?.authorizationId !== v2AccountShadowPolicy.id ||
  v2AccountShadowState?.authorizationStatus !== "ACTIVE" ||
  v2AccountShadowState?.operationalStatus !== "ACTIVE_VERIFIED_OBSERVE_ONLY_PRICE_SIDE_VALIDATION_GATED" ||
  v2AccountShadowState?.runtime !== v2AccountShadowPolicy.appliesTo.runtime ||
  v2AccountShadowState?.book !== v2AccountShadowPolicy.appliesTo.book ||
  v2AccountShadowState?.baselineImplementationRevision !== v2AccountShadowPolicy.appliesTo.baselineImplementationRevision ||
  v2AccountShadowState?.experimentId !== v2AccountShadowPolicy.appliesTo.shadowExperimentId ||
  !Number.isFinite(Date.parse(v2AccountShadowState?.prospectiveStart ?? "")) ||
  v2AccountShadowState?.historicalBackfillAllowed !== false ||
  v2AccountShadowState?.valuationScope !== v2AccountShadowPolicy.study.valuationScope ||
  v2AccountShadowState?.evidenceGate?.maximumQuoteAgeMs !== 1000 ||
  v2AccountShadowState?.evidenceGate?.maximumCrossPositionQuoteSkewMs !== 250 ||
  v2AccountShadowState?.evidenceGate?.maximumTransportLagMs !== 20000 ||
  v2AccountShadowState?.evidenceGate?.twoDistinctFrameConfirmationMs !== 30000 ||
  v2AccountShadowState?.evidenceGate?.historicalBackfillOrUnobservedGapIntervalMayAdvanceHighWater !== false ||
  v2AccountShadowState?.evidenceGate?.recoveryGapPositionsMayEnterValidationStatistics !== false ||
  v2AccountShadowState?.evidenceGate?.executableHighWaterClaimAllowed !== false ||
  JSON.stringify(v2AccountShadowState?.profitProtection?.tiers) !== JSON.stringify(expectedAccountShadowTiers) ||
  v2AccountShadowState?.profitProtection?.stressLockIncrementFraction !== 0.05 ||
  v2AccountShadowState?.profitProtection?.maximumLockFraction !== 0.8 ||
  v2AccountShadowState?.profitProtection?.floorMayDecreaseWithinCstDay !== false ||
  v2AccountShadowState?.reviewGate?.minimumEligibleCompletedCampaigns !== 20 ||
  v2AccountShadowState?.reviewGate?.requiredGivebackReductionFraction !== 0.3 ||
  v2AccountShadowState?.reviewGate?.minimumNetOutcomeRetentionFraction !== 0.95 ||
  v2AccountShadowState?.reviewGate?.minimumTrendGainRetentionFraction !== 0.8 ||
  v2AccountShadowState?.reviewGate?.currentRecoveryGapPositions !== v2AccountShadowEvidence.firstForwardObservation.recoveryGapPositions ||
  v2AccountShadowState?.reviewGate?.currentAnalysisEligible !== true ||
  v2AccountShadowState?.reviewGate?.currentValidationStatisticsEligible !== false ||
  v2AccountShadowState?.monitor?.parentRoute !== "/v2-ledger" ||
  v2AccountShadowState?.monitor?.route !== "/v2-ledger/account-shadow" ||
  v2AccountShadowState?.monitor?.parentTopEntry !== true ||
  v2AccountShadowState?.monitor?.automaticRefreshSeconds !== 15 ||
  v2AccountShadowState?.monitor?.productionVersionNumber !== v2AccountShadowEvidence.deployment.versionNumber ||
  v2AccountShadowState?.monitor?.productionDeploymentStatus !== "SUCCEEDED" ||
  v2AccountShadowState?.persistence?.baselineSnapshotStoredBeforeShadowWork !== true ||
  v2AccountShadowState?.persistence?.baselineIngestResponseWaitsForShadowCalculation !== false ||
  v2AccountShadowState?.persistence?.monotonicSourceUpsert !== true ||
  v2AccountShadowState?.persistence?.baselinePublisherContractChanged !== false ||
  v2AccountShadowState?.persistence?.v2DaemonReloadRequired !== false ||
  v2AccountShadowState?.executionInputAllowed !== false ||
  v2AccountShadowState?.kellySizingActivationAllowed !== false ||
  v2AccountShadowState?.automaticPromotionAllowed !== false ||
  v2AccountShadowState?.ownerApprovalRequiredBeforeExecutionUse !== true ||
  v2AccountShadowState?.strategyRiskPositionOrderStopLedgerOrTradingProcessChanged !== false
) {
  throw new Error("ORION_V2_ACCOUNT_EQUITY_SHADOW_CURRENT_STATE_INVALID");
}
if (
  v2AccountShadowEvidence.authorizationId !== v2AccountShadowPolicy.id ||
  v2AccountShadowEvidence.status !== v2AccountShadowState.operationalStatus ||
  v2AccountShadowEvidence.baseline?.runtime !== v2AccountShadowState.runtime ||
  v2AccountShadowEvidence.baseline?.book !== v2AccountShadowState.book ||
  v2AccountShadowEvidence.baseline?.implementationRevision !== v2AccountShadowState.baselineImplementationRevision ||
  v2AccountShadowEvidence.baseline?.strategyRiskPositionOrderStopOrCanonicalLedgerChanged !== false ||
  v2AccountShadowEvidence.implementation?.experimentId !== v2AccountShadowState.experimentId ||
  v2AccountShadowEvidence.implementation?.parentTopEntry !== true ||
  v2AccountShadowEvidence.implementation?.queryGatedShadowPayload !== true ||
  v2AccountShadowEvidence.implementation?.baselineSnapshotStoredBeforeShadowWork !== true ||
  v2AccountShadowEvidence.implementation?.shadowWorkRunsAfterBaselineResponseThroughWaitUntil !== true ||
  v2AccountShadowEvidence.implementation?.shadowFailureIsolatedFromBaselineIngest !== true ||
  v2AccountShadowEvidence.implementation?.monotonicShadowUpsert !== true ||
  v2AccountShadowEvidence.implementation?.historicalBackfillPerformed !== false ||
  v2AccountShadowEvidence.firstForwardObservation?.prospectiveStart !== v2AccountShadowState.prospectiveStart ||
  v2AccountShadowEvidence.firstForwardObservation?.accountShadowStatus !== "ACTIVE_OBSERVE_ONLY" ||
  v2AccountShadowEvidence.firstForwardObservation?.evidenceStatus !== "PRICE_SIDE_EVIDENCE_ACCEPTED" ||
  v2AccountShadowEvidence.firstForwardObservation?.valuationScope !== "INDICATIVE_PRICE_SIDE_ONLY_NO_ORDER_BOOK_DEPTH" ||
  !Number.isInteger(v2AccountShadowEvidence.firstForwardObservation?.recoveryGapPositions) ||
  v2AccountShadowEvidence.firstForwardObservation?.analysisEligible !== true ||
  v2AccountShadowEvidence.firstForwardObservation?.validationStatisticsEligible !== false ||
  v2AccountShadowEvidence.firstForwardObservation?.executableHighWaterClaimMade !== false ||
  v2AccountShadowEvidence.validation?.focusedTests !== "46_PASS_0_FAIL" ||
  v2AccountShadowEvidence.validation?.targetedLint !== "PASS" ||
  v2AccountShadowEvidence.validation?.workspaceSiteBuild !== "PASS" ||
  v2AccountShadowEvidence.validation?.exactPublishedSourceTests !== "44_PASS_0_FAIL" ||
  v2AccountShadowEvidence.validation?.exactPublishedSourceBuild !== "PASS" ||
  v2AccountShadowEvidence.validation?.parentRouteHttpStatus !== 200 ||
  v2AccountShadowEvidence.validation?.shadowRouteHttpStatus !== 200 ||
  v2AccountShadowEvidence.validation?.baselineApiOmitsShadowPayloadWithoutExplicitQuery !== true ||
  v2AccountShadowEvidence.deployment?.versionNumber !== v2AccountShadowState.monitor.productionVersionNumber ||
  v2AccountShadowEvidence.deployment?.status !== "SUCCEEDED" ||
  !/^[0-9a-f]{40}$/.test(v2AccountShadowEvidence.deployment?.sourceCommitSha ?? "") ||
  v2AccountShadowEvidence.runtimeVerification?.tradingProcessControlInvoked !== false ||
  v2AccountShadowEvidence.runtimeVerification?.publisherReloaded !== false ||
  v2AccountShadowEvidence.runtimeVerification?.onlineLedgerStatus !== "SYNCED" ||
  v2AccountShadowEvidence.runtimeVerification?.tradingProcessControlInvoked !== false ||
  v2AccountShadowEvidence.runtimeVerification?.publisherReloaded !== false ||
  v2AccountShadowEvidence.runtimeVerification?.automaticTradingMutationsByThisChange !== 0 ||
  !Object.entries(v2AccountShadowEvidence.boundaries ?? {}).every(([key, value]) => key === "ownerApprovalRequiredBeforeExecutionUse" ? value === true : value === false)
) {
  throw new Error("ORION_V2_ACCOUNT_EQUITY_SHADOW_EVIDENCE_INVALID");
}
if (
  /paper-daemon|control\.mjs|trading-gateway|fetch\(|WebSocket/.test(v2AccountShadowEngineSource) ||
  !v2AccountShadowEngineSource.includes('runtimeId: "ORION-V2-MTFX-PAPER-1.1"') ||
  !v2AccountShadowEngineSource.includes('bookId: "MTFX-T"') ||
  !v2AccountShadowEngineSource.includes('baselineImplementationRevision: "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION"') ||
  !v2AccountShadowEngineSource.includes("frameFingerprint") ||
  !v2AccountShadowEngineSource.includes("observation.frameFingerprint !== state.pendingHigh.frameFingerprint") ||
  !v2AccountShadowEngineSource.includes("ACCOUNT_SHADOW_INITIAL_EVIDENCE_INELIGIBLE") ||
  !v2AccountShadowEngineSource.includes("WAITING_FIRST_VALID_FORWARD_SNAPSHOT") ||
  !v2AccountShadowEngineSource.includes("EVIDENCE_GAP_NO_PATH_INTERPOLATION") ||
  !v2AccountShadowEngineSource.includes("RECOVERY_GAP_POSITIONS_EXCLUDED_FROM_VALIDATION") ||
  !v2AccountShadowEngineSource.includes("promotionEligible: false") ||
  !v2AccountShadowEngineSource.includes("automaticPromotionAllowed: false") ||
  !v2LedgerApiSource.includes('new URL(request.url).searchParams.has("account-shadow")') ||
  !v2LedgerApiSource.includes('await import("@/app/v2-ledger/account-shadow/engine.mjs")') ||
  !v2LedgerApiSource.includes("getRequestExecutionContext()?.waitUntil(accountShadowWork)") ||
  !v2LedgerApiSource.includes("WHERE id = ? AND revision = ? AND source_as_of = ?") ||
  !v2LedgerApiSource.includes("SHADOW_LAGGING_BASELINE_MONITOR_UNAFFECTED") ||
  !v2LedgerApiSource.includes("BACKGROUND_OBSERVE_ONLY_QUEUED")
) {
  throw new Error("ORION_V2_ACCOUNT_EQUITY_SHADOW_IMPLEMENTATION_BOUNDARY_INVALID");
}

// The publication is bound to exact bytes, not an old claim that its checks passed.
const shadowManifestPath = "governance/evidence/manifests/orion-v2-account-equity-lock-shadow-v99-source-manifest.json";
const shadowManifestBytes = await fs.readFile(path.join(root, shadowManifestPath));
const shadowManifest = JSON.parse(shadowManifestBytes);
const shadowDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { ROLLING_POLICY } = await import("../app/v2-ledger/account-shadow/rolling.mjs");
if (v2AccountShadowPolicy.study.persistedStateSchemaVersion !== 5 ||
    v2AccountShadowPolicy.study.implementationPolicyRevision !== "ORION-V2-ACCOUNT-EQUITY-LOCK-SHADOW-POLICY-5" ||
    Object.entries(ROLLING_POLICY).some(([key, value]) => v2AccountShadowPolicy.study.rollingAccount?.[key] !== value) ||
    JSON.stringify(v2AccountShadowState.rollingAccount) !== JSON.stringify(v2AccountShadowPolicy.study.rollingAccount) ||
    v2AccountShadowState.performanceValidated !== false ||
    v2AccountShadowState.persistence.stateKey !== "orion-v2-r22-account-equity-lock-shadow-v5" ||
    v2AccountShadowState.remediationStatus !== "IMPLEMENTATION_AND_PUBLICATION_REVERIFIED_PERFORMANCE_STILL_GATED" ||
    v2AccountShadowEvidence.sourceManifest?.path !== shadowManifestPath ||
    v2AccountShadowEvidence.sourceManifest?.sha256 !== shadowDigest(shadowManifestBytes) ||
    shadowManifest.git.commit !== v2AccountShadowEvidence.deployment.sourceCommitSha ||
    shadowManifest.deployment.versionId !== v2AccountShadowEvidence.deployment.versionId ||
    shadowManifest.deployment.archiveContentHash !== v2AccountShadowEvidence.deployment.archiveContentHash ||
    shadowManifest.files?.length !== 20 ||
    shadowManifest.files.map((item) => item.path).join("\n") !== shadowManifest.files.map((item) => item.path).sort().join("\n") ||
    shadowDigest(shadowManifest.files.map((item) => `${item.path}\t${item.bytes}\t${item.sha256}\n`).join("")) !== shadowManifest.setDigestSha256 ||
    v2AccountShadowEvidence.excludedPriorCohorts?.length !== 4 ||
    v2AccountShadowEvidence.excludedPriorCohorts.some((cohort, index) => cohort.versionNumber !== 95 + index || cohort.preserved !== true || cohort.validationEligible !== false) ||
    v2AccountShadowEvidence.secondForwardObservation.accountShadowRevision <= v2AccountShadowEvidence.firstForwardObservation.accountShadowRevision ||
    v2AccountShadowEvidence.secondForwardObservation.prospectiveStart !== v2AccountShadowState.prospectiveStart ||
    !v2LedgerApiSource.includes("decodeShadowState(previousRow.payload)") ||
    !v2LedgerApiSource.includes("decodeShadowState(shadowRow.payload)") ||
    !v2AccountShadowEngineSource.includes("pendingHighProof") ||
    !v2AccountShadowEngineSource.includes("dayEvidenceExclusions")) {
  throw new Error("ORION_V2_ROLLING_SHADOW_PUBLICATION_INTEGRITY_INVALID");
}
let netEquityReplacement = null;
if (current.communications.v2NetEquityCurve) {
  const pointer = current.communications.v2NetEquityCurve;
  const policy = JSON.parse(await fs.readFile(path.join(root, pointer.authorization), "utf8"));
  const evidence = JSON.parse(await fs.readFile(path.join(root, pointer.evidence), "utf8"));
  if (policy.id !== "OWNER-DIRECTIVE-V2-NET-EQUITY-CURVE-20260911" || policy.id !== pointer.authorizationId ||
      evidence.authorizationId !== policy.id || policy.status !== "AUTHORIZED" || policy.scope !== "V2_MONITOR_NET_EQUITY_ONLY" ||
      evidence.scope !== policy.scope || pointer.status !== evidence.status || evidence.status !== "LOCAL_VALIDATED_NOT_PUBLISHED" ||
      policy.definition !== "SETTLED_ACCOUNT_EQUITY_PLUS_COST_ADJUSTED_UNREALIZED_PNL" || policy.unit !== "USDT" ||
      policy.preserveHistoricalEvidence !== true || policy.otherAccountsChanged !== false || policy.tradingRiskOrProcessesChanged !== false ||
      Object.values(evidence.boundaries).some(v => v !== false) || evidence.history.missingQuotes !== "NULL_NOT_ZERO" ||
      evidence.history.priorSettlementHistoryPreserved !== true || evidence.history.disconnectGapMs !== 180000 ||
      evidence.sourceFiles.map(f=>f.path).join("|") !== "app/v2-ledger/page.tsx|app/api/mtfx-ledger/route.ts|app/v2-ledger/equity.ts|app/v2-ledger/EquityPanel.tsx|db/schema.ts|drizzle/0007_bizarre_william_stryker.sql|drizzle/meta/0007_snapshot.json|drizzle/meta/_journal.json|tests/v2-equity-curve.test.mjs|tests/v2-return-curve.test.mjs") throw new Error("V2_NET_EQUITY_AUTHORIZATION_INVALID");
  for (const file of evidence.sourceFiles) {
    const bytes = await fs.readFile(path.join(root, file.path));
    if (bytes.length !== file.bytes || shadowDigest(bytes) !== file.sha256) throw new Error("V2_NET_EQUITY_SOURCE_HASH:" + file.path);
  }
  netEquityReplacement = evidence;
}
for (const item of shadowManifest.files) {
  if (!item.localWorkspaceMatch) {
    if (item.path !== "package.json") throw new Error("SHADOW_UNDECLARED_SOURCE_DIVERGENCE");
    continue; // The isolated release intentionally excludes unrelated workspace package changes.
  }
  const bytes = await fs.readFile(path.join(root, item.path));
  if (netEquityReplacement && ["app/v2-ledger/page.tsx", "app/api/mtfx-ledger/route.ts"].includes(item.path)) {
    const replacement = netEquityReplacement.sourceFiles.find(f=>f.path===item.path);
    const prior = item.path.endsWith("page.tsx")
      ? JSON.parse(await fs.readFile(path.join(root, current.communications.v2ReturnCurve.evidence), "utf8")).files.find(f=>f.path===item.path).sha256
      : item.sha256;
    if (replacement.beforeSha256 !== prior) throw new Error("V2_NET_EQUITY_PRIOR_CHAIN_INVALID");
    continue; // Exact authorized successor; immutable v99/v100 and return-curve evidence remain intact.
  }
  if (["app/v2-ledger/page.tsx", "app/v2-ledger/ledger.module.css"].includes(item.path) && current.communications.v2ReturnCurve) {
    const pointer = current.communications.v2ReturnCurve;
    const policy = JSON.parse(await fs.readFile(path.join(root, pointer.authorization), "utf8"));
    const evidence = JSON.parse(await fs.readFile(path.join(root, pointer.evidence), "utf8"));
    const priorHistory = JSON.parse(await fs.readFile(path.join(root, current.communications.v2FullHistory.evidence), "utf8"));
    const entry = evidence.files?.find((file) => file.path === item.path);
    const expectedBefore = item.path.endsWith("page.tsx") ? priorHistory.sourceSupersession.sha256 : item.sha256;
    if (policy.id !== "OWNER-DIRECTIVE-V2-RETURN-CURVE-20260911" || policy.status !== "AUTHORIZED" ||
        pointer.authorizationId !== policy.id || evidence.authorizationId !== policy.id ||
        pointer.scope !== "V2_DISPLAY_ONLY" || evidence.scope !== pointer.scope || policy.route !== "/v2-ledger" ||
        pointer.status !== evidence.status ||
        !["LOCAL_VALIDATED_PUBLICATION_UNCONFIRMED", "ACTIVE_VERIFIED"].includes(evidence.status) ||
        policy.fullHistoryPreserved !== true || policy.floatingPnlIncluded !== false ||
        [policy.accountingChanged, policy.tradingRiskOrRuntimeChanged, policy.otherMonitorsChanged].some((value) => value !== false) ||
        Object.values(evidence.boundaries).some((value) => value !== false) ||
        Object.values(evidence.preserves).some((value) => value !== true) ||
        entry?.beforeSha256 !== expectedBefore || entry.bytes !== bytes.length || entry.sha256 !== shadowDigest(bytes) ||
        evidence.files.map((file) => file.path).join("|") !== "app/v2-ledger/page.tsx|app/v2-ledger/ledger.module.css|app/v2-ledger/returns.ts") {
      throw new Error("V2_RETURN_CURVE_SOURCE_SUPERSESSION_INVALID");
    }
    const helper = evidence.files[2];
    const helperBytes = await fs.readFile(path.join(root, helper.path));
    if (helper.bytes !== helperBytes.length || helper.sha256 !== shadowDigest(helperBytes)) throw new Error("V2_RETURN_CURVE_HELPER_INTEGRITY_INVALID");
    continue; // Preserve v99/v100 evidence; only this explicit display-only replacement is accepted.
  }
  if (item.path === "app/v2-ledger/page.tsx" && current.communications.v2FullHistory) {
    const historyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-05-v2-monitor-earliest-history.json"), "utf8"));
    const historyEvidence = JSON.parse(await fs.readFile(path.join(root, current.communications.v2FullHistory.evidence), "utf8"));
    if (historyPolicy.status !== "ACTIVE" || historyPolicy.id !== current.communications.v2FullHistory.authorizationId ||
        historyEvidence.authorizationId !== historyPolicy.id || historyPolicy.scope.route !== "/v2-ledger" ||
        historyEvidence.sourceSupersession.manifest !== shadowManifestPath ||
        historyEvidence.sourceSupersession.path !== item.path ||
        !(historyEvidence.sourceSupersession.sha256 === shadowDigest(bytes) || r221SourceMatches(item.path, historyEvidence.sourceSupersession, bytes)) ||
        historyEvidence.implementation.accountingAndHourlyAggregationChanged !== false ||
        Object.values(historyEvidence.boundaries).some((value) => value !== false)) throw new Error("V2_HISTORY_DISPLAY_SUPERSESSION_INVALID");
    continue; // Preserve the historical release manifest; verify the scoped superseding change.
  }
  if (item.path === "app/v2-ledger/account-shadow/page.tsx" && current.orionV2AccountCompoundABCStudy) {
    const study = current.orionV2AccountCompoundABCStudy;
    const policy = JSON.parse(await fs.readFile(path.join(root, study.authorization), "utf8"));
    const evidence = JSON.parse(await fs.readFile(path.join(root, study.evidence), "utf8"));
    const manifestBytes = await fs.readFile(path.join(root, evidence.sourceManifest.path));
    const manifest = JSON.parse(manifestBytes);
    if (policy.id !== "OWNER-DIRECTIVE-V2-ACCOUNT-COMPOUND-ABC-SHADOW-20260906" ||
        policy.id !== study.authorizationId || evidence.authorizationId !== policy.id ||
        policy.status !== "ACTIVE_RESEARCH_IMPLEMENTATION_AUTHORIZED" ||
        policy.candidateRevision !== "V2-ACCOUNT-COMPOUND-C1-20260906" || study.candidateRevision !== policy.candidateRevision ||
        [study.executionInputAllowed,study.kellySizingActivationAllowed,study.automaticPromotionAllowed,study.performanceValidated,
         policy.gates.executionInputAllowed,policy.gates.kellySizingActivationAllowed,policy.gates.automaticPromotionAllowed,policy.gates.performanceValidated].some((value) => value !== false) ||
        study.annualTargetProbabilityEstimate !== null || evidence.validation.annualTargetProbability !== null ||
        study.candidateEntryEngineeringAccepted !== false ||
        evidence.sourceSupersession.manifest !== shadowManifestPath || evidence.sourceSupersession.path !== item.path ||
        evidence.sourceSupersession.sha256 !== shadowDigest(bytes) ||
        evidence.sourceSupersession.scope !== "ADDITIVE_INDEPENDENT_CANDIDATE_PANEL_ONLY_NO_BASELINE_OR_B_LOGIC_CHANGE" ||
        Object.values(evidence.boundaries).some((value) => value !== false) ||
        evidence.storage.schemaChanges !== false || evidence.storage.baselineOrBRowsModified !== false ||
        evidence.storage.appendOnly !== true || evidence.storage.candidateRowPrefix !== "v2-account-compound-c1-20260906:report:" ||
        evidence.deployment.status !== "SUCCEEDED" || evidence.deployment.ownerOnlyAccessPreserved !== true ||
        evidence.deployment.versionNumber !== study.monitorVersion || manifest.git.commit !== evidence.deployment.sourceCommitSha ||
        manifest.deployment.versionId !== evidence.deployment.versionId || evidence.sourceManifest.sha256 !== shadowDigest(manifestBytes) ||
        manifest.files.length !== 8 || manifest.protectedFiles.length !== 4 ||
        manifest.files.map((entry) => entry.path).join("\n") !== manifest.files.map((entry) => entry.path).sort().join("\n") ||
        shadowDigest(manifest.files.map((entry) => `${entry.path}\t${entry.bytes}\t${entry.sha256}\n`).join("")) !== manifest.setDigestSha256) throw new Error("V2_CANDIDATE_SCOPED_SUPERSESSION_INVALID");
    for (const entry of [...manifest.files, ...manifest.protectedFiles]) {
      const actual = await fs.readFile(path.join(root, entry.path));
      if (netEquityReplacement && entry.path === "app/api/mtfx-ledger/route.ts") {
        const replacement = netEquityReplacement.sourceFiles.find(f=>f.path===entry.path);
        if (replacement.beforeSha256 !== entry.sha256 || replacement.sha256 !== shadowDigest(actual)) throw new Error("V2_NET_EQUITY_PROTECTED_API_CHAIN_INVALID");
        continue;
      }
      if (["agents/orion-v2/paper/config.json", "agents/orion-v2/paper/paper-daemon.mjs"].includes(entry.path) && current.activeResearchCandidate?.deployment?.risk2Pct10PctCutoverOutcome) {
        const outcome = current.activeResearchCandidate.deployment.risk2Pct10PctCutoverOutcome;
        const authorization = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-11-v2-risk-2pct-10pct.json"), "utf8"));
        const riskEvidence = JSON.parse(await fs.readFile(path.join(root, outcome.evidence), "utf8"));
        const replacement = riskEvidence.sourceSupersession?.files?.find((item) => item.path === entry.path);
        let expectedBefore = { bytes: entry.bytes, sha256: entry.sha256 };
        if (entry.path === "agents/orion-v2/paper/paper-daemon.mjs") {
          const isolation = current.executionDomains.orionV2Paper.authorityIsolation;
          const priorSupersession = JSON.parse(await fs.readFile(path.join(root, isolation.sourceSupersession), "utf8"));
          expectedBefore = priorSupersession.files?.find((item) => item.path === entry.path)?.after;
        }
        let riskSourceAfterMatches = replacement?.after?.bytes === actual.length && replacement?.after?.sha256 === shadowDigest(actual) ||
          r221SourceMatches(entry.path, replacement?.after, actual);
        const integrityRepair = current.executionDomains.orionV2Paper.portfolioProtectionIntegrityRepair;
        if (entry.path === "agents/orion-v2/paper/paper-daemon.mjs" && integrityRepair) {
          const repairId = "OWNER-DIRECTIVE-V2-R21-INTEGRITY-REPAIR-20260913";
          const repairAuthorizationPath = "governance/owner-authorizations/2026-09-13-v2-r21-integrity-repair.json";
          const repairManifestPath = "governance/evidence/manifests/v2-r21-integrity-repair-20260913.json";
          const repairEvidencePath = "governance/evidence/v2-r21-integrity-repair-20260913.json";
          if (integrityRepair.authorizationId !== repairId || integrityRepair.authorization !== repairAuthorizationPath ||
              integrityRepair.sourceSupersession !== repairManifestPath || integrityRepair.evidence !== repairEvidencePath ||
              !["PREPARED", "ACTIVE_VERIFIED"].includes(integrityRepair.status)) throw new Error("V2_R21_REPAIR_POINTER_INVALID");
          const repairAuthorization = JSON.parse(await fs.readFile(path.join(root, repairAuthorizationPath), "utf8"));
          const repairManifest = JSON.parse(await fs.readFile(path.join(root, repairManifestPath), "utf8"));
          const repairEvidence = JSON.parse(await fs.readFile(path.join(root, repairEvidencePath), "utf8"));
          const requiredBoundaries = ["riskFractionsChanged", "entryRulesChanged", "profitThresholdsChanged", "minimumThreePositionTriggerChanged", "eligibleSymbolsChanged", "entryRevisionStopOrQuantityRetrofitAllowed", "historicalOutcomeRewriteAllowed", "historicalGapBackfillAllowed", "realOrTestnetOrdersAllowed", "sharedR21OrForeignExecutionDomainMutationAllowed"];
          if (repairAuthorization.schemaVersion !== 1 || repairAuthorization.authorizationId !== repairId ||
              repairAuthorization.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" || repairAuthorization.scope !== "ORION_V2_MTFX_PAPER_ONLY" ||
              repairAuthorization.repairRevision !== "V2-R21-INTEGRITY-1" ||
              requiredBoundaries.some((key) => repairAuthorization.boundaries?.[key] !== false) ||
              Object.values(repairAuthorization.boundaries).some((value) => value !== false) ||
              ["exchangeCredentialsAllowed", "signedRequestsAllowed", "apiKeysAllowed", "orderEndpointsAllowed", "testnetOrdersAllowed", "realOrdersAllowed"]
                .some((key) => current.executionDomains.orionV2Paper[key] !== false) ||
              repairEvidence.authorizationId !== repairId || repairEvidence.status !== integrityRepair.status ||
              repairManifest.schemaVersion !== 1 || repairManifest.authorizationId !== repairId ||
              repairManifest.authorization !== repairAuthorizationPath ||
              repairManifest.scope !== "V2_ONLY_R21_INTEGRITY_NO_STRATEGY_RISK_CHANGE" ||
              repairManifest.supersedesEvidence !== "governance/evidence/v2-risk-2pct-10pct-20260911.json" ||
              repairManifest.supersedesEvidence !== outcome.evidence || repairManifest.historicalManifestPreserved !== true ||
              !Array.isArray(repairManifest.files) || !repairManifest.files.length ||
              !Array.isArray(repairManifest.protectedFiles) || !repairManifest.protectedFiles.length) {
            throw new Error("V2_R21_REPAIR_AUTHORITY_OR_MANIFEST_INVALID");
          }
          const validDigest = (descriptor) => descriptor && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && /^[a-f0-9]{64}$/.test(descriptor.sha256);
          const entryConsistency = current.executionDomains.orionV2Paper.entryProtectionConsistencyRepair;
          let entrySuccessor = null;
          if (entryConsistency) {
            const entryId = "OWNER-DIRECTIVE-V2-R21-ENTRY-CONSISTENCY-20260914";
            const entryAuthPath = "governance/owner-authorizations/2026-09-14-v2-r21-entry-consistency.json";
            const entryManifestPath = "governance/evidence/manifests/v2-r21-entry-consistency-20260914.json";
            const entryEvidencePath = "governance/evidence/v2-r21-entry-consistency-20260914.json";
            const auth = JSON.parse(await fs.readFile(path.join(root, entryAuthPath), "utf8"));
            const entryManifestBytes = await fs.readFile(path.join(root, entryManifestPath));
            entrySuccessor = JSON.parse(entryManifestBytes.toString("utf8"));
            const evidence = JSON.parse(await fs.readFile(path.join(root, entryEvidencePath), "utf8"));
            const allowedPaths = ["agents/orion-v2/paper/r21-integrity.mjs", "scripts/verify-migration.mjs",
              "tests/v2-r21-entry-consistency.test.mjs", entryAuthPath];
            const boundaries = ["riskFractionsChanged", "profitThresholdsChanged", "freezeDurationChanged",
              "initialArmingThreePositionMinimumChanged", "reductionOrCloseThreePositionMinimumChanged",
              "positionExitRulesChanged", "historicalLedgerRewriteAllowed", "realOrTestnetOrdersAllowed",
              "sharedR21OrForeignExecutionDomainMutationAllowed"];
            if (entryConsistency.authorizationId !== entryId || entryConsistency.authorization !== entryAuthPath ||
                entryConsistency.sourceSupersession !== entryManifestPath || entryConsistency.evidence !== entryEvidencePath ||
                !["PREPARED", "ACTIVE_VERIFIED"].includes(entryConsistency.status) ||
                auth.authorizationId !== entryId || auth.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" ||
                auth.scope !== "ORION_V2_MTFX_PAPER_ONLY" || auth.entryAdmissionChanged !== true ||
                auth.repairRevision !== "V2-R21-ENTRY-CONSISTENCY-1" || boundaries.some((key) => auth.boundaries?.[key] !== false) ||
                evidence.authorizationId !== entryId || evidence.status !== entryConsistency.status ||
                entrySuccessor.authorizationId !== entryId || entrySuccessor.supersedesManifest !== repairManifestPath ||
                entrySuccessor.historicalManifestPreserved !== true ||
                entrySuccessor.files?.length !== allowedPaths.length ||
                new Set(entrySuccessor.files.map((file) => file.path)).size !== allowedPaths.length ||
                entrySuccessor.files.some((file) => !allowedPaths.includes(file.path))) throw new Error("V2_R21_ENTRY_SUCCESSOR_AUTHORITY_INVALID");
            for (const file of entrySuccessor.files) {
              const bytes = await fs.readFile(path.join(root, file.path));
              if (!validDigest(file.after) || (file.before !== null && !validDigest(file.before))) throw new Error(`V2_R21_ENTRY_SUCCESSOR_SOURCE_INVALID:${file.path}`);
              if (file.after.bytes !== bytes.length || file.after.sha256 !== shadowDigest(bytes)) {
                if (file.path !== "scripts/verify-migration.mjs" || !(requiresDualZ(orionV3HighFrequencyStrategy) || requiresSingleZ(orionV3HighFrequencyStrategy))) throw new Error(`V2_R21_ENTRY_SUCCESSOR_SOURCE_INVALID:${file.path}`);
                const successor = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/manifests/v3-hf13-shared-verifier-20260914.json"), "utf8"));
                // Validate HF13 against its exact retained bytes before accepting the separately authorized R22.1 successor.
                const hf13Bytes = r221SourceMatches(file.path, successor.after, bytes)
                  ? v2R221SourceBytes[V2_R221_BEFORE_ROOT + file.path] : bytes;
                const hf13Strategy = orionV3Hf14Active ? {
                  implementationRevision: HF13_REVISION,
                  implementationDirectiveId: HF13_AUTHORIZATION,
                  dualZ: historicalOrionV3Hf13Policy.strategy.dualZ,
                } : orionV3HighFrequencyStrategy;
                const hf13Authorization = orionV3Hf14Active ? historicalOrionV3Hf13Policy : orionV3HighFrequencyPolicy;
                verifyV3SharedVerifierSuccessor({ strategy: hf13Strategy, authorization: hf13Authorization,
                  file, actualBytes: hf13Bytes, predecessorManifestPath: entryManifestPath, predecessorManifestBytes: entryManifestBytes, successor });
              }
            }
          }
          const seenRepairPaths = new Set();
          for (const [files, changed] of [[repairManifest.files, true], [repairManifest.protectedFiles, false]]) {
            for (const file of files) {
              if (typeof file?.path !== "string" || !file.path || path.isAbsolute(file.path) ||
                  file.path !== path.posix.normalize(file.path) || file.path.startsWith("../") || file.path.includes("\\") ||
                  seenRepairPaths.has(file.path) || !validDigest(changed ? file.after : file) ||
                  (changed && file.before !== null && !validDigest(file.before))) throw new Error("V2_R21_REPAIR_FILE_DESCRIPTOR_INVALID");
              seenRepairPaths.add(file.path);
              const fileBytes = await fs.readFile(path.join(root, file.path));
              const expected = changed ? file.after : file;
              if (fileBytes.length !== expected.bytes || shadowDigest(fileBytes) !== expected.sha256) {
                if (!changed && s2ProfitRetentionSuccessor.matchesProtectedSource(file.path, expected, fileBytes)) continue;
                if (r221SourceMatches(file.path, expected, fileBytes)) continue;
                if (file.path === "agents/orion-v2/paper/r21-integrity.mjs" && entrySuccessor) {
                  const successor = entrySuccessor.files.find((item) => item.path === file.path);
                  if (successor.before?.bytes !== expected.bytes || successor.before?.sha256 !== expected.sha256) throw new Error("V2_R21_ENTRY_PREDECESSOR_INVALID");
                  continue;
                }
                // This shared verifier also tracks S1 deployment. Only its exact
                // owner-authorized successor may differ; every V2 source file
                // and the original V2 manifest retain their original checks.
                if (file.path !== "scripts/verify-migration.mjs") throw new Error(`V2_R21_REPAIR_SOURCE_INTEGRITY:${file.path}`);
                const successor = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/manifests/s1-readonly-recovery-verifier-20260914.json"), "utf8"));
                const ops = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-14-s1-delegated-ops.json"), "utf8"));
                if (successor.authorizationId !== "OWNER-DIRECTIVE-S1-DELEGATED-OPS-20260914" || successor.authorizationId !== ops.authorizationId ||
                    ops.realOrdersAllowed !== false || ops.strategyRiskOrOtherExecutionDomainsChanged !== false ||
                    successor.path !== file.path || successor.historicalManifestPreserved !== true ||
                    successor.supersedesManifest !== repairManifestPath || !validDigest(successor.before) || !validDigest(successor.after) ||
                    successor.before.bytes !== expected.bytes || successor.before.sha256 !== expected.sha256 ||
                    !(successor.after.bytes === fileBytes.length && successor.after.sha256 === shadowDigest(fileBytes) ||
                      entrySuccessor?.files.some((item) => item.path === file.path &&
                        item.before?.bytes === successor.after.bytes && item.before?.sha256 === successor.after.sha256))) {
                  throw new Error("S1_SHARED_VERIFIER_SUCCESSOR_INVALID");
                }
              }
            }
          }
          const daemonRepair = repairManifest.files.find((file) => file.path === entry.path);
          if (!repairManifest.files.some((file) => file.path === "scripts/verify-migration.mjs") ||
              !daemonRepair?.before || daemonRepair.before.bytes !== replacement?.after?.bytes ||
              daemonRepair.before.sha256 !== replacement?.after?.sha256 ||
              !(daemonRepair.after.bytes === actual.length && daemonRepair.after.sha256 === shadowDigest(actual) ||
                r221SourceMatches(entry.path, daemonRepair.after, actual))) {
            throw new Error("V2_R21_REPAIR_PRIOR_RISK_CHAIN_INVALID");
          }
          // Only daemon bytes follow this authorized successor; the old risk evidence and policy checks below remain mandatory.
          riskSourceAfterMatches = true;
        }
        if (authorization.authorizationId !== "OWNER-DIRECTIVE-V2-RISK-2PCT-10PCT-20260911" ||
            authorization.status !== "ACTIVE_VERIFIED" || authorization.scope !== "ORION_V2_PAPER_ONLY" ||
            riskEvidence.authorizationId !== authorization.authorizationId || riskEvidence.status !== outcome.status ||
            riskEvidence.sourceSupersession.supersedesManifest !== evidence.sourceManifest.path ||
            riskEvidence.sourceSupersession.historicalManifestPreserved !== true ||
            riskEvidence.sourceSupersession.scope !== "V2_ONLY_FORWARD_PAPER_RISK_NO_SHADOW_INHERITANCE" ||
            replacement.before.bytes !== expectedBefore.bytes || replacement.before.sha256 !== expectedBefore.sha256 ||
            !riskSourceAfterMatches ||
            riskEvidence.runtimeRiskPolicy.maximumRiskPerIntersectionFraction !== 0.02 ||
            riskEvidence.runtimeRiskPolicy.maximumPortfolioRiskFraction !== 0.1 ||
            riskEvidence.runtimeRiskPolicy.aggregateIntersectionRiskSplitBypassAllowed !== false ||
            riskEvidence.preservation.immutablePositionFingerprintBefore !== riskEvidence.preservation.immutablePositionFingerprintAfter ||
            riskEvidence.preservation.oldPositionTopUpCount !== 0 || riskEvidence.preservation.stopWideningCount !== 0 ||
            riskEvidence.preservation.historicalRRewriteCount !== 0 || riskEvidence.preservation.administrativeClosureCount !== 0 ||
            Object.entries(riskEvidence.isolation).some(([key, value]) => key !== "realOrTestnetOrderConnectivityEnabled" && value !== false) ||
            riskEvidence.isolation.realOrTestnetOrderConnectivityEnabled !== false) {
          throw new Error("V2_RISK_SOURCE_SUPERSESSION_INVALID");
        }
        continue;
      }
      if (entry.path === "agents/orion-v2/paper/paper-daemon.mjs" && current.executionDomains.orionV2Paper.authorityIsolation) {
        const isolation = current.executionDomains.orionV2Paper.authorityIsolation;
        const supersession = JSON.parse(await fs.readFile(path.join(root, isolation.sourceSupersession), "utf8"));
        const authorization = JSON.parse(await fs.readFile(path.join(root, isolation.authorization), "utf8"));
        const replacement = supersession.files?.[0];
        if (authorization.id !== "OWNER-DIRECTIVE-V2-S1-ISOLATION-PAPER-RECOVERY-20260910" ||
            authorization.status !== "AUTHORIZED" || isolation.authorizationId !== authorization.id ||
            supersession.authorizationId !== authorization.id || supersession.authorization !== isolation.authorization ||
            supersession.supersedesManifest !== evidence.sourceManifest.path || supersession.historicalManifestPreserved !== true ||
            supersession.scope !== "V2_ONLY_AUTHORITY_VALIDATION_NO_STRATEGY_OR_RISK_CHANGE" ||
            supersession.files.length !== 1 || replacement.path !== entry.path ||
            replacement.before.bytes !== entry.bytes || replacement.before.sha256 !== entry.sha256 ||
            replacement.after.bytes !== actual.length || replacement.after.sha256 !== shadowDigest(actual) ||
            isolation.foreignDomainPermissionsGrantOrVetoV2 !== false ||
            isolation.credentialAndOrderBoundarySource !== "executionDomains.orionV2Paper" ||
            ["exchangeCredentialsAllowed", "signedRequestsAllowed", "apiKeysAllowed", "orderEndpointsAllowed", "testnetOrdersAllowed", "realOrdersAllowed"]
              .some((key) => current.executionDomains.orionV2Paper[key] !== false) ||
            authorization.preserves.v2StrategyAndRiskUnchanged !== true || authorization.preserves.s1Unchanged !== true) {
          throw new Error("V2_AUTHORITY_ISOLATION_SUPERSESSION_INVALID");
        }
        continue; // Preserve v101; only the owner-authorized V2 startup boundary changed.
      }
      if ((actual.length !== entry.bytes || shadowDigest(actual) !== entry.sha256) && !r221SourceMatches(entry.path, entry, actual))
        throw new Error(`V2_CANDIDATE_SOURCE_INTEGRITY:${entry.path}`);
    }
    continue; // v99 remains immutable; only this authorized additive panel is superseded.
  }
  if ((bytes.length !== item.bytes || shadowDigest(bytes) !== item.sha256) && !r221SourceMatches(item.path, item, bytes))
    throw new Error(`SHADOW_PUBLISHED_SOURCE_MISMATCH:${item.path}`);
}

const allMonitorSyncPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-all-monitor-presentation-sync.json"), "utf8"));
const allMonitorSyncContract = JSON.parse(await fs.readFile(path.join(root, "governance/presentation-contracts/all-monitor-sync-contract-v1.json"), "utf8"));
const monitorSharedSource = await fs.readFile(path.join(root, "app/monitor-sync.ts"), "utf8");
const v2MonitorSource = await fs.readFile(path.join(root, "app/v2-ledger/page.tsx"), "utf8");
const v2MonitorStyles = await fs.readFile(path.join(root, "app/v2-ledger/ledger.module.css"), "utf8");
const v2AccountShadowMonitorSource = await fs.readFile(path.join(root, "app/v2-ledger/account-shadow/page.tsx"), "utf8");
const v3MonitorSource = await fs.readFile(path.join(root, "app/v3-equity/page.tsx"), "utf8");
const v3Hf12aShadowMonitorSource = await fs.readFile(path.join(root, "app/v3-equity/hf12a-shadow/page.tsx"), "utf8");
const v4MonitorSource = await fs.readFile(path.join(root, "app/v4-monitor/page.tsx"), "utf8");
const v4MonitorStyles = await fs.readFile(path.join(root, "app/v4-monitor/v4-monitor.module.css"), "utf8");
const v4MonitorPublisherSource = await fs.readFile(path.join(root, "agents/orion-v4/binance-demo/monitor-publisher.mjs"), "utf8");
const v4MonitorResidentSource = await fs.readFile(path.join(root, "agents/orion-v4/binance-demo/monitor-resident.mjs"), "utf8");
const v4MonitorPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-distinct-spatial-monitor.json"), "utf8"));
const v4MonitorEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-distinct-spatial-monitor-20260822.json"), "utf8"));
const v4PositionDensityPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-position-orbit-density.json"), "utf8"));
const v4PositionDensityEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-position-orbit-density-20260822.json"), "utf8"));
const v4PalettePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v4-mist-silver-palette.json"), "utf8"));
const v4PaletteEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-mist-silver-palette-20260822.json"), "utf8"));
const v4QuantConsolePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-25-orion-v4-quant-console-monitor-redesign.json"), "utf8"));
const v4QuantConsoleEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v4-quant-console-monitor-redesign-20260825.json"), "utf8"));
const executionResiliencePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-25-v2-v3-v4-execution-resilience-repair.json"), "utf8"));
const executionResilienceEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/v2-v3-v4-execution-resilience-repair-20260825.json"), "utf8"));
const abnormalLossGatePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-25-v2-v3-v4-abnormal-single-loss-circuit-breaker.json"), "utf8"));
const abnormalLossGateEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/v2-v3-v4-abnormal-single-loss-circuit-breaker-20260825.json"), "utf8"));
const v2CandidateProgressPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-23-orion-v2-monitor-candidate-progress-bars.json"), "utf8"));
const v2CandidateProgressEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v2-monitor-candidate-progress-bars-20260823.json"), "utf8"));
const v2SignedZeroAxisPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-23-orion-v2-monitor-signed-zero-axis.json"), "utf8"));
const v2SignedZeroAxisEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v2-monitor-signed-zero-axis-20260823.json"), "utf8"));
const v2PositionLayoutPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-23-orion-v2-monitor-position-layout-readability.json"), "utf8"));
const v2PositionLayoutEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v2-monitor-position-layout-readability-20260823.json"), "utf8"));
const v2MobileTextIntegrityPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-24-orion-v2-monitor-mobile-text-integrity.json"), "utf8"));
const v2MobileTextIntegrityEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v2-monitor-mobile-text-integrity-20260824.json"), "utf8"));
const expectedMonitorRoutes = ["/v2-ledger", "/v2-ledger/account-shadow", "/v3-equity", "/v3-equity/hf12a-shadow", "/v4-monitor"];
if (allMonitorSyncPolicy.status !== "ACTIVE" ||
    allMonitorSyncContract.status !== "ACTIVE" ||
    allMonitorSyncContract.authorizationId !== allMonitorSyncPolicy.id ||
    allMonitorSyncContract.presentationRevision !== "MONITOR-SYNC-11-20260825" ||
    JSON.stringify(allMonitorSyncContract.currentAuthorizedPages.map(({ route }) => route)) !== JSON.stringify(expectedMonitorRoutes) ||
    allMonitorSyncContract.futureAuthorizedMonitorAutoEnrollment !== true ||
    allMonitorSyncContract.propagation?.partialApplicablePageReleaseAllowed !== false ||
    current.communications?.allMonitorPresentationSync?.authorizationId !== allMonitorSyncPolicy.id ||
    current.communications?.allMonitorPresentationSync?.contractId !== allMonitorSyncContract.contractId ||
    current.communications?.allMonitorPresentationSync?.currentRevision !== allMonitorSyncContract.presentationRevision ||
    JSON.stringify(current.communications?.allMonitorPresentationSync?.authorizedPages?.map(({ route }) => route)) !== JSON.stringify(expectedMonitorRoutes) ||
    current.communications?.allMonitorPresentationSync?.latestEvidence !== current.orionV2AccountEquityLockShadowStudy.evidence ||
    current.communications?.allMonitorPresentationSync?.futureAuthorizedMonitorAutoEnrollment !== true ||
    !monitorSharedSource.includes(allMonitorSyncContract.presentationRevision) ||
    !v2MonitorSource.includes("data-monitor-sync-revision") ||
    !v2AccountShadowMonitorSource.includes("data-monitor-sync-revision") ||
    !v3MonitorSource.includes("data-monitor-sync-revision") ||
    !v3Hf12aShadowMonitorSource.includes("data-monitor-sync-revision") ||
    !v4MonitorSource.includes("data-monitor-sync-revision") ||
    v4MonitorPolicy.status !== "ACTIVE" ||
    v4MonitorPolicy.scope?.route !== "/v4-monitor" ||
    v4MonitorPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-4-20260822" ||
    v4MonitorPolicy.synchronization?.visualSystemSharedWithV2OrV3 !== false ||
    v4PositionDensityPolicy.status !== "ACTIVE" ||
    v4PositionDensityPolicy.supplements !== v4MonitorPolicy.id ||
    v4PositionDensityPolicy.scope?.route !== "/v4-monitor" ||
    v4PositionDensityPolicy.scope?.singlePositionLayout !== "FULL_WIDTH_HORIZONTAL_ORBITAL_CARD" ||
    v4PositionDensityPolicy.scope?.multiplePositionLayout !== "TWO_COLUMN_ORBITAL_CARDS" ||
    v4PositionDensityPolicy.scope?.mobileLayout !== "SINGLE_COLUMN" ||
    v4PositionDensityPolicy.dataContract?.changed !== false ||
    v4PositionDensityPolicy.dataContract?.publisherReloadRequired !== false ||
    v4PositionDensityPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-5-20260822" ||
    v4PalettePolicy.status !== "ACTIVE" ||
    v4PalettePolicy.supplements !== v4PositionDensityPolicy.id ||
    v4PalettePolicy.scope?.route !== "/v4-monitor" ||
    v4PalettePolicy.scope?.paletteMode !== "MIST_SILVER_GLACIER_LOW_SATURATION" ||
    v4PalettePolicy.scope?.largeAreaColorPolicy !== "NEUTRAL_LIGHT_SURFACES" ||
    v4PalettePolicy.scope?.accentUse !== "STATUS_AND_PNL_ONLY" ||
    v4PalettePolicy.scope?.spatialOrbitalGeometryRetained !== true ||
    v4PalettePolicy.dataContract?.changed !== false ||
    v4PalettePolicy.dataContract?.publisherReloadRequired !== false ||
    v4PalettePolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-6-20260822" ||
    v4QuantConsolePolicy.status !== "ACTIVE" ||
    v4QuantConsolePolicy.supersedesPresentation !== v4PalettePolicy.id ||
    v4QuantConsolePolicy.scope?.route !== "/v4-monitor" ||
    v4QuantConsolePolicy.scope?.presentationMode !== "V4_QUANT_EXECUTION_CONTROL_CONSOLE" ||
    v4QuantConsolePolicy.scope?.mobileLayout !== "SINGLE_COLUMN_NO_HORIZONTAL_CARD_OVERFLOW" ||
    v4QuantConsolePolicy.readOnlyDataContract?.changed !== true ||
    v4QuantConsolePolicy.readOnlyDataContract?.publisherReloadRequired !== true ||
    v4QuantConsolePolicy.boundaries?.strategyChanged !== false ||
    v4QuantConsolePolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-10-20260824" ||
    v2CandidateProgressPolicy.status !== "ACTIVE" ||
    v2CandidateProgressPolicy.object !== "ORION_V2_MONITOR_CANDIDATE_PRESENTATION_ONLY" ||
    v2CandidateProgressPolicy.scope?.route !== "/v2-ledger" ||
    v2CandidateProgressPolicy.scope?.candidateMetric !== "ANCHOR_STABILITY_SCORE" ||
    v2CandidateProgressPolicy.scope?.presentation !== "ACCESSIBLE_HORIZONTAL_PROGRESS_BAR_WITH_NUMERIC_PERCENT" ||
    v2CandidateProgressPolicy.dataContract?.changed !== false ||
    v2CandidateProgressPolicy.dataContract?.publisherReloadRequired !== false ||
    v2CandidateProgressPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-7-20260823" ||
    current.communications?.v2CandidateProgressBars?.authorizationId !== v2CandidateProgressPolicy.id ||
    current.communications?.v2CandidateProgressBars?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.communications?.v2CandidateProgressBars?.presentationRevision !== "MONITOR-SYNC-7-20260823" ||
    current.communications?.v2CandidateProgressBars?.productionVersionNumber !== 75 ||
    current.communications?.v2CandidateProgressBars?.publisherReloaded !== false ||
    current.communications?.v2CandidateProgressBars?.strategyRiskPositionOrderLedgerOrRuntimeChanged !== false ||
    v2SignedZeroAxisPolicy.status !== "ACTIVE" ||
    v2SignedZeroAxisPolicy.object !== "ORION_V2_MONITOR_REALIZED_PNL_CURVE_PRESENTATION_ONLY" ||
    v2SignedZeroAxisPolicy.scope?.route !== "/v2-ledger" ||
    v2SignedZeroAxisPolicy.scope?.verticalDirection !== "POSITIVE_ABOVE_ZERO_NEGATIVE_BELOW_ZERO" ||
    v2SignedZeroAxisPolicy.scope?.segmentColoring !== "BY_CUMULATIVE_VALUE_RELATIVE_TO_ZERO_NOT_TERMINAL_VALUE" ||
    v2SignedZeroAxisPolicy.dataContract?.changed !== false ||
    v2SignedZeroAxisPolicy.dataContract?.publisherReloadRequired !== false ||
    v2SignedZeroAxisPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-8-20260823" ||
    current.communications?.v2CurveSignPresentation?.authorizationId !== v2SignedZeroAxisPolicy.id ||
    current.communications?.v2CurveSignPresentation?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.communications?.v2CurveSignPresentation?.presentationRevision !== "MONITOR-SYNC-8-20260823" ||
    current.communications?.v2CurveSignPresentation?.productionVersionNumber !== 76 ||
    current.communications?.v2CurveSignPresentation?.sourceCommitSha !== v2SignedZeroAxisEvidence.deployment?.sourceCommitSha ||
    current.communications?.v2CurveSignPresentation?.publisherReloaded !== false ||
    current.communications?.v2CurveSignPresentation?.strategyRiskPositionOrderLedgerOrRuntimeChanged !== false ||
    v2PositionLayoutPolicy.status !== "ACTIVE" ||
    v2PositionLayoutPolicy.object !== "ORION_V2_MONITOR_CURRENT_POSITION_LAYOUT_PRESENTATION_ONLY" ||
    v2PositionLayoutPolicy.scope?.route !== "/v2-ledger" ||
    v2PositionLayoutPolicy.scope?.section !== "CURRENT_OPEN_POSITIONS" ||
    v2PositionLayoutPolicy.scope?.symbolPresentation !== "FULL_BASE_ASSET_AND_QUOTE_ASSET_WITHOUT_ELLIPSIS" ||
    v2PositionLayoutPolicy.scope?.mobileLayout !== "FULL_WIDTH_SYMBOL_IDENTITY_AND_ALIGNED_TWO_COLUMN_METRICS" ||
    v2PositionLayoutPolicy.scope?.minimumVisibleDomFontPixels !== 11 ||
    v2PositionLayoutPolicy.dataContract?.changed !== false ||
    v2PositionLayoutPolicy.dataContract?.publisherReloadRequired !== false ||
    v2PositionLayoutPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-9-20260823" ||
    current.communications?.v2PositionLayoutReadability?.authorizationId !== v2PositionLayoutPolicy.id ||
    current.communications?.v2PositionLayoutReadability?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.communications?.v2PositionLayoutReadability?.presentationRevision !== "MONITOR-SYNC-9-20260823" ||
    current.communications?.v2PositionLayoutReadability?.productionVersionNumber !== 77 ||
    current.communications?.v2PositionLayoutReadability?.sourceCommitSha !== v2PositionLayoutEvidence.deployment?.sourceCommitSha ||
    current.communications?.v2PositionLayoutReadability?.publisherReloaded !== false ||
    current.communications?.v2PositionLayoutReadability?.strategyRiskPositionOrderLedgerOrRuntimeChanged !== false ||
    v2MobileTextIntegrityPolicy.status !== "ACTIVE" ||
    v2MobileTextIntegrityPolicy.object !== "ORION_V2_MONITOR_MOBILE_TEXT_INTEGRITY_PRESENTATION_ONLY" ||
    v2MobileTextIntegrityPolicy.supplements !== v2PositionLayoutPolicy.id ||
    v2MobileTextIntegrityPolicy.scope?.route !== "/v2-ledger" ||
    v2MobileTextIntegrityPolicy.scope?.textOverflowPolicy !== "WRAP_WITHIN_OWN_CONTAINER_WITHOUT_ELLIPSIS_OR_CLIPPING" ||
    v2MobileTextIntegrityPolicy.scope?.horizontalOverflowPolicy !== "NO_PAGE_OR_CARD_HORIZONTAL_OVERFLOW" ||
    v2MobileTextIntegrityPolicy.scope?.candidateIdentityLayout !== "FULL_WIDTH_LABEL_THEN_ICON_AND_SYMBOL" ||
    v2MobileTextIntegrityPolicy.scope?.narrowViewportMaximumPixels !== 430 ||
    v2MobileTextIntegrityPolicy.scope?.narrowViewportLayout !== "SINGLE_COLUMN" ||
    v2MobileTextIntegrityPolicy.scope?.minimumVisibleDomFontPixels !== 11 ||
    v2MobileTextIntegrityPolicy.dataContract?.changed !== false ||
    v2MobileTextIntegrityPolicy.dataContract?.publisherReloadRequired !== false ||
    v2MobileTextIntegrityPolicy.synchronization?.presentationRevision !== "MONITOR-SYNC-10-20260824" ||
    current.communications?.v2MobileTextIntegrity?.authorizationId !== v2MobileTextIntegrityPolicy.id ||
    current.communications?.v2MobileTextIntegrity?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.communications?.v2MobileTextIntegrity?.presentationRevision !== "MONITOR-SYNC-10-20260824" ||
    current.communications?.v2MobileTextIntegrity?.productionVersionNumber !== 78 ||
    current.communications?.v2MobileTextIntegrity?.sourceCommitSha !== v2MobileTextIntegrityEvidence.deployment?.sourceCommitSha ||
    current.communications?.v2MobileTextIntegrity?.rootContractMarker !== "wrap-without-clipping" ||
    current.communications?.v2MobileTextIntegrity?.publisherReloaded !== false ||
    current.communications?.v2MobileTextIntegrity?.strategyRiskPositionOrderLedgerOrRuntimeChanged !== false ||
    current.communications?.v4Monitor?.authorizationId !== v4MonitorPolicy.id ||
    current.communications?.v4Monitor?.latestPresentationAuthorizationId !== abnormalLossGatePolicy.authorizationId ||
    current.communications?.v4Monitor?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.communications?.v4Monitor?.publisherStatus !== "RUNNING_EXECUTION_HEALTH_SEPARATED_VERIFIED" ||
    current.communications?.v4Monitor?.presentationRevision !== allMonitorSyncContract.presentationRevision ||
    current.communications?.v4Monitor?.presentationMode !== "V4_QUANT_EXECUTION_CONTROL_CONSOLE" ||
    current.communications?.v4Monitor?.productionVersionNumber !== 86 ||
    current.communications?.v4Monitor?.latestSharedProductionEvidence !== "governance/evidence/v2-v3-v4-abnormal-single-loss-circuit-breaker-20260825.json" ||
    current.communications?.v4Monitor?.accountEngineAndCausalBboHealthSeparated !== true ||
    current.communications?.v4Monitor?.lastVerifiedDegraded !== false ||
    current.communications?.v4Monitor?.publisherReloadedForLatestPresentation !== true ||
    current.orionV4RangeResearch?.monitor?.authorizationId !== v4MonitorPolicy.id ||
    current.orionV4RangeResearch?.monitor?.latestPresentationAuthorizationId !== abnormalLossGatePolicy.authorizationId ||
    current.orionV4RangeResearch?.monitor?.status !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    current.orionV4RangeResearch?.monitor?.publisherStarted !== true ||
    current.orionV4RangeResearch?.monitor?.presentationRevision !== allMonitorSyncContract.presentationRevision ||
    current.orionV4RangeResearch?.monitor?.presentationMode !== "V4_QUANT_EXECUTION_CONTROL_CONSOLE" ||
    current.orionV4RangeResearch?.monitor?.productionVersionNumber !== 86 ||
    current.orionV4RangeResearch?.monitor?.latestSharedProductionEvidence !== "governance/evidence/v2-v3-v4-abnormal-single-loss-circuit-breaker-20260825.json" ||
    current.orionV4RangeResearch?.monitor?.accountEngineAndCausalBboHealthSeparated !== true ||
    current.orionV4RangeResearch?.monitor?.lastVerifiedDegraded !== false ||
    current.orionV4RangeResearch?.monitor?.publisherIsolation !== "READ_ONLY_STANDALONE_NO_TRADING_SCANNER_RELOAD" ||
    executionResiliencePolicy.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" ||
    executionResilienceEvidence.authorizationId !== executionResiliencePolicy.authorizationId ||
    executionResilienceEvidence.result !== "PASS_ACTIVE_HEALTHY_RECONCILED" ||
    executionResilienceEvidence.productionMonitor?.siteVersion !== 85 ||
    executionResilienceEvidence.productionMonitor?.engineStatus !== "RUNNING" ||
    executionResilienceEvidence.productionMonitor?.causalBboStatus !== "LIVE" ||
    executionResilienceEvidence.productionMonitor?.degraded !== false ||
    current.executionResilienceRepair?.authorizationId !== executionResiliencePolicy.authorizationId ||
    current.executionResilienceRepair?.status !== "ACTIVE_VERIFIED_HEALTHY_RECONCILED" ||
    abnormalLossGatePolicy.status !== "ACTIVE_IMPLEMENTATION_AUTHORIZED" ||
    abnormalLossGatePolicy.policy?.riskBasis !== "IMMUTABLE_INITIAL_PLANNED_RISK_USDT_AT_ENTRY" ||
    abnormalLossGatePolicy.policy?.forwardOnly !== true ||
    abnormalLossGatePolicy.policy?.thresholds?.yellowLossRExclusive !== 1.2 ||
    abnormalLossGatePolicy.policy?.thresholds?.orangeLossRExclusive !== 1.5 ||
    abnormalLossGatePolicy.policy?.thresholds?.redLossRExclusive !== 2 ||
    abnormalLossGatePolicy.policy?.orangeAction?.consecutiveHealthyReconciledCyclesRequired !== 3 ||
    abnormalLossGatePolicy.policy?.redAction?.manualOwnerAuthorizedResetRequired !== true ||
    abnormalLossGateEvidence.authorizationId !== abnormalLossGatePolicy.authorizationId ||
    abnormalLossGateEvidence.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
    abnormalLossGateEvidence.productionMonitorDeployment?.status !== "SUCCEEDED" ||
    abnormalLossGateEvidence.productionMonitorDeployment?.versionNumber !== 86 ||
    abnormalLossGateEvidence.productionMonitorDeployment?.accessMode !== "CUSTOM_OWNER_ONLY" ||
    abnormalLossGateEvidence.runtimeVerification?.orionV3?.executionReconciliationStatus !== "RECONCILED" ||
    abnormalLossGateEvidence.runtimeVerification?.orionV4?.executionReconciliationStatus !== "RECONCILED" ||
    current.abnormalSingleLossCircuitBreaker?.authorizationId !== abnormalLossGatePolicy.authorizationId ||
    current.abnormalSingleLossCircuitBreaker?.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
    current.abnormalSingleLossCircuitBreaker?.monitorPresentationRevision !== allMonitorSyncContract.presentationRevision ||
    v4MonitorEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v4MonitorEvidence.publisher?.consecutiveSuccessfulFullCyclesVerified !== 2 ||
    v4MonitorEvidence.boundaries?.tradingScannerRestarted !== false ||
    v4MonitorEvidence.boundaries?.automaticTradingMutationsInVerifiedCycle !== 0 ||
    v4PositionDensityEvidence.authorizationId !== v4PositionDensityPolicy.id ||
    v4PositionDensityEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v4PositionDensityEvidence.presentationRevision !== "MONITOR-SYNC-5-20260822" ||
    v4PositionDensityEvidence.monitor?.singlePositionLayout !== "FULL_WIDTH_HORIZONTAL_ORBITAL_CARD" ||
    v4PositionDensityEvidence.boundaries?.publisherReloaded !== false ||
    v4PositionDensityEvidence.boundaries?.tradingScannerRestarted !== false ||
    v4PaletteEvidence.authorizationId !== v4PalettePolicy.id ||
    v4PaletteEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v4PaletteEvidence.presentationRevision !== "MONITOR-SYNC-6-20260822" ||
    v4PaletteEvidence.monitor?.paletteMode !== "MIST_SILVER_GLACIER_LOW_SATURATION" ||
    v4PaletteEvidence.monitor?.largeAreaColorPolicy !== "NEUTRAL_LIGHT_SURFACES" ||
    v4PaletteEvidence.monitor?.accentUse !== "STATUS_AND_PNL_ONLY" ||
    v4PaletteEvidence.boundaries?.publisherReloaded !== false ||
    v4PaletteEvidence.boundaries?.tradingScannerRestarted !== false ||
    v4QuantConsoleEvidence.authorizationId !== v4QuantConsolePolicy.id ||
    v4QuantConsoleEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v4QuantConsoleEvidence.presentationRevision !== "MONITOR-SYNC-10-20260824" ||
    v4QuantConsoleEvidence.monitor?.presentationMode !== "V4_QUANT_EXECUTION_CONTROL_CONSOLE" ||
    v4QuantConsoleEvidence.monitor?.desktopVisualInspection !== "PASS" ||
    v4QuantConsoleEvidence.monitor?.mobile390x844VisualInspection !== "PASS" ||
    v4QuantConsoleEvidence.readOnlyDataContract?.productionApiStatus !== "OK" ||
    v4QuantConsoleEvidence.readOnlyDataContract?.historyPointsAtVerification < 2 ||
    v4QuantConsoleEvidence.deployment?.versionNumber !== 82 ||
    v4QuantConsoleEvidence.publisher?.status !== "RUNNING" ||
    v4QuantConsoleEvidence.publisher?.consecutiveSuccessfulFullCyclesVerified < 2 ||
    v4QuantConsoleEvidence.boundaries?.v4TradingScannerRestarted !== false ||
    v4QuantConsoleEvidence.boundaries?.strategyChanged !== false ||
    v2CandidateProgressEvidence.authorizationId !== v2CandidateProgressPolicy.id ||
    v2CandidateProgressEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v2CandidateProgressEvidence.presentationRevision !== "MONITOR-SYNC-7-20260823" ||
    v2CandidateProgressEvidence.deployment?.versionNumber !== 75 ||
    v2CandidateProgressEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.progressBarAndAccessibleLabelMarkersConfirmed !== true ||
    v2CandidateProgressEvidence.boundaries?.v2DaemonRestarted !== false ||
    v2CandidateProgressEvidence.boundaries?.monitorPublisherReloaded !== false ||
    v2SignedZeroAxisEvidence.authorizationId !== v2SignedZeroAxisPolicy.id ||
    v2SignedZeroAxisEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v2SignedZeroAxisEvidence.presentationRevision !== "MONITOR-SYNC-8-20260823" ||
    v2SignedZeroAxisEvidence.deployment?.versionNumber !== 76 ||
    v2SignedZeroAxisEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.signedZeroAxisClientAssetMarkerConfirmed !== true ||
    v2SignedZeroAxisEvidence.boundaries?.v2DaemonRestarted !== false ||
    v2SignedZeroAxisEvidence.boundaries?.monitorPublisherReloaded !== false ||
    v2PositionLayoutEvidence.authorizationId !== v2PositionLayoutPolicy.id ||
    v2PositionLayoutEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v2PositionLayoutEvidence.presentationRevision !== "MONITOR-SYNC-9-20260823" ||
    v2PositionLayoutEvidence.deployment?.versionNumber !== 77 ||
    v2PositionLayoutEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.positionLayoutClientAssetMarkerConfirmed !== true ||
    v2PositionLayoutEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.liveSnapshotApiHttpStatus !== 200 ||
    v2PositionLayoutEvidence.boundaries?.v2DaemonRestarted !== false ||
    v2PositionLayoutEvidence.boundaries?.monitorPublisherReloaded !== false ||
    v2MobileTextIntegrityEvidence.authorizationId !== v2MobileTextIntegrityPolicy.id ||
    v2MobileTextIntegrityEvidence.result !== "ACTIVE_PRIVATE_PRODUCTION_SYNCED" ||
    v2MobileTextIntegrityEvidence.presentationRevision !== "MONITOR-SYNC-10-20260824" ||
    v2MobileTextIntegrityEvidence.deployment?.versionNumber !== 78 ||
    v2MobileTextIntegrityEvidence.deployment?.sourceFilesChangedFromVersion77 !== 3 ||
    v2MobileTextIntegrityEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.mobileTextIntegrityClientAssetMarkerConfirmed !== true ||
    v2MobileTextIntegrityEvidence.pages?.find(({ route }) => route === "/v2-ledger")?.liveSnapshotApiHttpStatus !== 200 ||
    v2MobileTextIntegrityEvidence.pages?.find(({ route }) => route === "/v3-equity")?.presentationRevisionConfirmed !== true ||
    v2MobileTextIntegrityEvidence.pages?.find(({ route }) => route === "/v4-monitor")?.presentationRevisionConfirmed !== true ||
    v2MobileTextIntegrityEvidence.boundaries?.processControlCommandsInvoked !== false ||
    v2MobileTextIntegrityEvidence.boundaries?.monitorPublisherReloaded !== false ||
    !v2MonitorSource.includes("planStabilityProgress") ||
    !v2MonitorSource.includes('role="progressbar"') ||
    !v2MonitorSource.includes("aria-valuenow") ||
    !v2MonitorSource.includes('data-curve-sign-mode="positive-above-negative-below"') ||
    !v2MonitorSource.includes('data-position-layout="symbol-first-aligned-grid"') ||
    !v2MonitorSource.includes('data-mobile-text-contract="wrap-without-clipping"') ||
    !v2MonitorSource.includes("positionIdentity") ||
    !v2MonitorSource.includes("positionMetric") ||
    !v2MonitorSource.includes("paintSignedRegion(inset.top, zeroY, palette.positiveLine") ||
    !v2MonitorSource.includes("paintSignedRegion(zeroY, plotBottom, palette.negativeLine") ||
    !(current.communications.v2ReturnCurve
      ? v2MonitorSource.includes('returnLabel(tick, initialCapital, unit)')
      : v2MonitorSource.includes('tick > 0 ? `+${money(tick)}` : money(tick)')) ||
    !v2MonitorStyles.includes(".planStabilityProgress") ||
    !v2MonitorStyles.includes(".positionSymbol") ||
    !v2MonitorStyles.includes(".positionRow > .positionIdentity") ||
    !v2MonitorStyles.includes("V2 mobile text-integrity contract") ||
    !v2MonitorStyles.includes("overflow-wrap: anywhere") ||
    !v2MonitorStyles.includes(".planRow > .market::before") ||
    !v4MonitorStyles.includes("--canvas: #edf2f3") ||
    !v4MonitorStyles.includes("--green: #16bd83") ||
    !v4MonitorStyles.includes(".dashboardGrid") ||
    !v4MonitorStyles.includes("@media (max-width: 700px)") ||
    v4MonitorStyles.includes("#070812") ||
    !v4MonitorSource.includes("机会雷达") ||
    !v4MonitorSource.includes("信号漏斗") ||
    !v4MonitorSource.includes("数据心跳") ||
    !v4MonitorSource.includes("模拟成交带") ||
    !v4MonitorSource.includes("OrionMark") ||
    !v4MonitorSource.includes("EquityChart") ||
    !v4MonitorPublisherSource.includes("buildV4MonitorSnapshot") ||
    !v4MonitorPublisherSource.includes("settlements") ||
    !v4MonitorResidentSource.includes("READ_ONLY_V4_MONITOR_PUBLISHER") ||
    /executeV4AutomaticCycle|scanV4Once/.test(`${v4MonitorPublisherSource}\n${v4MonitorResidentSource}`)) {
  throw new Error("ALL_MONITOR_PRESENTATION_SYNC_CONTRACT_INVALID");
}

const v2CurvePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v2-monitor-hourly-equidistant-curve.json"), "utf8"));
const v2CurveSource = await fs.readFile(path.join(root, "app/monitor-curve.ts"), "utf8");
if (v2CurvePolicy.status !== "ACTIVE" ||
    v2CurvePolicy.scope?.sameHourAggregation !== "SUM_NET_PNL_AND_COUNT_SETTLEMENTS" ||
    v2CurvePolicy.scope?.horizontalSpacing !== "EQUAL_BY_SETTLEMENT_HOUR_NODE" ||
    v2CurvePolicy.applicability?.v3 !== false ||
    current.communications?.v2MonitorCurve?.authorizationId !== v2CurvePolicy.id ||
    current.communications?.v2MonitorCurve?.status !== "SUPERSEDED_BY_ALL_MONITOR_HOURLY_EQUIDISTANT_CURVES" ||
    !v2CurveSource.includes("groupSettlementsByHour") ||
    !v2CurveSource.includes("ordinalCurveFraction")) {
  throw new Error("ORION_V2_MONITOR_CURVE_PRESENTATION_INVALID");
}

const allMonitorCurvePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-all-monitor-hourly-equidistant-curves.json"), "utf8"));
const v3CurveSource = await fs.readFile(path.join(root, "app/v3-equity/curve.ts"), "utf8");
if (allMonitorCurvePolicy.status !== "ACTIVE" ||
    allMonitorCurvePolicy.scope?.routes?.join(",") !== "/v2-ledger,/v3-equity" ||
    allMonitorCurvePolicy.scope?.sharedHourAndOrdinalAlgorithm !== true ||
    current.communications?.v2MonitorCurve?.supersededBy !== allMonitorCurvePolicy.id ||
    current.communications?.monitorCurves?.authorizationId !== allMonitorCurvePolicy.id ||
    current.communications?.monitorCurves?.presentationRevision !== allMonitorSyncContract.presentationRevision ||
    current.communications?.monitorCurves?.historicalEquityRewritten !== false ||
    !v2CurveSource.includes("ordinalCurveFraction") ||
    !v3CurveSource.includes("groupLearningEquityByHour")) {
  throw new Error("ALL_MONITOR_HOURLY_EQUIDISTANT_CURVES_INVALID");
}

const v2MobileCurvePolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-orion-v2-monitor-mobile-curve-annotation-cleanup.json"), "utf8"));
if (v2MobileCurvePolicy.status !== "ACTIVE" ||
    v2MobileCurvePolicy.scope?.removedAnnotation !== "NOW_AND_RIGHT_SIDE_WAITING_FOR_NEW_SETTLEMENT" ||
    v2MobileCurvePolicy.scope?.mobileTextOverlapAllowed !== false ||
    v2MobileCurvePolicy.applicability?.v3 !== false ||
    current.communications?.v2MonitorMobileCurve?.authorizationId !== v2MobileCurvePolicy.id ||
    current.communications?.v2MonitorMobileCurve?.presentationRevision !== allMonitorSyncContract.presentationRevision ||
    current.communications?.v2MonitorMobileCurve?.mobileTextOverlapAllowed !== false ||
    v2MonitorSource.includes("现在｜右侧等待新结算") ||
    !(current.communications.v2NetEquityCurve
      ? v2MonitorSource.includes("<EquityPanel observations={equityHistory}")
      : current.communications.v2ReturnCurve
      ? v2MonitorSource.includes("累计已实现收益率 · %") && v2MonitorSource.includes("累计已实现收益 · USDT")
      : v2MonitorSource.includes("累计已实现净盈亏 · USDT"))) {
  throw new Error("ORION_V2_MONITOR_MOBILE_CURVE_ANNOTATION_CLEANUP_INVALID");
}

const monitorTypographyPolicy = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-08-22-all-monitor-trading-terminal-typography.json"), "utf8"));
const monitorTypographySource = await fs.readFile(path.join(root, "app/monitor-typography.css"), "utf8");
const v3TypographySource = await fs.readFile(path.join(root, "app/v3-equity/v3-equity.module.css"), "utf8");
if (monitorTypographyPolicy.status !== "ACTIVE" ||
    monitorTypographyPolicy.scope?.minimumVisibleDomFontPixels !== 11 ||
    monitorTypographyPolicy.scope?.routes?.join(",") !== "/v2-ledger,/v3-equity" ||
    current.communications?.monitorTypography?.authorizationId !== monitorTypographyPolicy.id ||
    current.communications?.monitorTypography?.presentationRevision !== allMonitorSyncContract.presentationRevision ||
    current.communications?.monitorTypography?.minimumVisibleDomFontPixels !== 11 ||
    !monitorTypographySource.includes("--monitor-type-caption: 11px") ||
    !v2MonitorSource.includes("compact ? 10 : 11") ||
    !v3TypographySource.includes("monitor-type-caption")) {
  throw new Error("ALL_MONITOR_TRADING_TERMINAL_TYPOGRAPHY_INVALID");
}

const v5Authorization = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-04-orion-v5-au-futures-v2-r22-paper-initialization.json"), "utf8"));
const v5Evidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v5-au-futures-initialization-20260904.json"), "utf8"));
const v5ContinuousAuthorization = JSON.parse(await fs.readFile(path.join(root, "governance/owner-authorizations/2026-09-04-orion-v5-au-continuous-paper-residence-and-efficacy.json"), "utf8"));
const v5ContinuousEvidence = JSON.parse(await fs.readFile(path.join(root, "governance/evidence/orion-v5-au-continuous-paper-residence-20260904.json"), "utf8"));
const v5Config = JSON.parse(await fs.readFile(path.join(root, "experiments/v5-au-mtfx/config.json"), "utf8"));
const v5InitialState = JSON.parse(await fs.readFile(path.join(root, "experiments/v5-au-mtfx/initial-state.json"), "utf8"));
const v5RuntimeConfig = JSON.parse(await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/config.json"), "utf8"));
const v5AdapterSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/ctp-md-adapter.mjs"), "utf8");
const v5RulesSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/futures-rules.mjs"), "utf8");
const v5SessionSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/session-calendar.mjs"), "utf8");
const v5AuthoritativeInputsSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/authoritative-inputs.mjs"), "utf8");
const v5PositionBatchesSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/position-batches.mjs"), "utf8");
const v5TickSequenceSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/tick-sequencer.mjs"), "utf8");
const v5StrategySource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/mtfx-r22-strategy.mjs"), "utf8");
const v5R22ManagementSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/r22-position-management.mjs"), "utf8");
const v5DaemonSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/daemon.mjs"), "utf8");
const v5LedgerStoreSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/ledger-store.mjs"), "utf8");
const v5SupervisorSource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/supervisor.mjs"), "utf8");
const v5EfficacySource = await fs.readFile(path.join(root, "agents/orion-v5/ctp-paper/efficacy-audit.mjs"), "utf8");
const v5CalendarTemplate = JSON.parse(await fs.readFile(path.join(root, "experiments/v5-au-mtfx/trading-calendar.template.json"), "utf8"));
const v5InstrumentTemplate = JSON.parse(await fs.readFile(path.join(root, "experiments/v5-au-mtfx/instrument-metadata.template.json"), "utf8"));
const v5MonitorSource = await fs.readFile(path.join(root, "app/v5-au/page.tsx"), "utf8");
const v5ApiSource = await fs.readFile(path.join(root, "app/api/v5-au/route.ts"), "utf8");
const v5Governed = current.orionV5AuFutures ?? {};
const forbiddenV5MdCalls = ["TraderApi", "ReqOrderInsert", "ReqOrderAction", "ReqQryTradingAccount", "ReqQryInvestorPosition"];
const v5RuntimeSources = [v5AdapterSource, v5RulesSource, v5SessionSource, v5AuthoritativeInputsSource, v5PositionBatchesSource, v5TickSequenceSource, v5StrategySource, v5R22ManagementSource, v5DaemonSource, v5LedgerStoreSource, v5SupervisorSource, v5EfficacySource];
if (
  v5Authorization.status !== "ACTIVE_BUILD_AUTHORIZED_WAITING_CTP_MARKET_DATA" ||
  v5Authorization.conversation?.threadId !== "00000000-0000-4000-8000-000000000000" ||
  v5Authorization.marketData?.interface !== "CTP_MDAPI_ONLY" ||
  v5Authorization.marketData?.traderApiMayBeLoaded !== false ||
  v5ContinuousAuthorization.status !== "ACTIVE_WAITING_EXTERNAL_CTP_READINESS" ||
  v5ContinuousAuthorization.activation?.mode !== "AUTO_START_WHEN_ALL_GATES_PASS" ||
  v5ContinuousAuthorization.efficacy?.primaryDecisionSample?.minimumAttributableClosedTrades !== 100 ||
  v5Config.authorizationId !== v5Authorization.id ||
  v5Config.scope?.initialPaperCapitalCny !== 500000 ||
  v5Config.scope?.product !== "AU" ||
  v5Config.market?.calendarSchema !== "AUTHORITATIVE_TRADING_DAY_RECORD_WITH_DAY_ACTION_DAY_NIGHT_ACTION_DAY_PAIRS_AND_HAS_NIGHT_SESSION" ||
  v5Config.positionBatches?.closeAllocation !== "TODAY_FIRST_THEN_YESTERDAY_FIFO" ||
  v5Config.risk?.maximumRiskPerEntryFraction !== 0.01 ||
  v5Config.risk?.maximumManagedPortfolioRiskFraction !== 0.05 ||
  v5Config.risk?.riskSizingUtilizationFraction !== 0.98 ||
  v5Config.risk?.maximumEffectiveNotionalLeverage !== 4 ||
  v5Config.risk?.integerLotsOnly !== true ||
  v5Config.market?.continuousAdjustedPricesAllowedForFills !== false ||
  v5RuntimeConfig.activation?.residentStartAuthorizedAfterAllGates !== true ||
  v5RuntimeConfig.activation?.automaticStartWithoutRepeatOwnerConfirmation !== true ||
  v5RuntimeConfig.sessionBars?.referenceVersion !== "SHFE-AU-TRADABLE-MINUTE-BARS-1.0.0" ||
  v5RuntimeConfig.tickSequence?.strictExchangeTotalOrderClaimed !== false ||
  v5RuntimeConfig.tickSequence?.callbackQueue !== "SINGLE_ORDERED_BOUNDED_PROMISE_CHAIN" ||
  v5RuntimeConfig.contractStateIsolation?.crossContractStructure !== "FORBIDDEN" ||
  v5RuntimeConfig.dominantContractObservations?.minimumConsecutiveCompletedTradingDays !== 2 ||
  v5RuntimeConfig.r22Management?.afterHalfNetR?.aggregateNetRFloor !== 0.15 ||
  v5RuntimeConfig.r22Management?.afterOneNetR?.aggregateNetRFloor !== 0.6 ||
  v5RuntimeConfig.r22Management?.runner !== "TIGHTER_OF_CONFIRMED_1H_STRUCTURE_AND_R21_CLOSED_15M_ATR" ||
  v5RuntimeConfig.r15Replacement?.sameTickBboReuse !== false ||
  v5RuntimeConfig.authoritativeInputs?.calendarSchemaVersion !== 2 ||
  v5RuntimeConfig.authoritativeInputs?.instrumentMetadataSchemaVersion !== 2 ||
  v5InitialState.account?.equityCny !== 500000 ||
  v5InitialState.positions?.length !== 0 ||
  v5InitialState.paperOrders?.length !== 0 ||
  v5InitialState.realOrders?.length !== 0 ||
  v5Governed.threadId !== v5Authorization.conversation?.threadId ||
  v5Governed.implementationRevision !== "ORION-V5-AU-R22-END-TO-END-2.0.0" ||
  v5Governed.runtime?.sourceImplemented !== true ||
  v5Governed.runtime?.testsPassed !== true ||
  v5Governed.runtime?.residentProcessStarted !== false ||
  v5Governed.runtime?.paperPositions !== 0 ||
  v5Governed.runtime?.paperOrders !== 0 ||
  v5Governed.runtime?.realOrders !== 0 ||
  v5Governed.dataSource?.credentialsProvisioned !== false ||
  v5Governed.dataSource?.connectionStatus !== "NOT_STARTED_WAITING_CONFIGURATION" ||
  v5Governed.monitor?.route !== "/v5-au" ||
  v5Governed.monitor?.automaticRefreshSeconds !== 30 ||
  v5Governed.futuresParity?.actualCloseLegFeeAttributionTested !== true ||
  v5Governed.futuresParity?.deliveryConstraintLotMultipleHardcoded !== false ||
  v5Governed.futuresParity?.dominantContractExcludesNewOpenDisabledOrDeliveryConstraintWindow !== true ||
  v5Evidence.currentFacts?.sourceImplementationComplete !== true ||
  v5Evidence.currentFacts?.componentTestsPassed !== true ||
  v5Evidence.currentFacts?.componentTestCount !== 22 ||
  v5Evidence.currentFacts?.aegisFuturesParityRemediation?.fridayNightAndCrossMidnightToMondayTested !== true ||
  v5Evidence.currentFacts?.aegisFuturesParityRemediation?.sameTradingDayNightOpenDayCloseClassifiedCloseToday !== true ||
  v5Evidence.currentFacts?.aegisFuturesParityRemediation?.deliveryLotMultipleDrivenByVersionedMetadata !== true ||
  v5Evidence.currentFacts?.residentProcessStarted !== false ||
  v5Evidence.currentFacts?.paperOrders !== 0 ||
  v5Evidence.currentFacts?.realOrders !== 0 ||
  v5ContinuousEvidence.currentFacts?.residentSupervisorImplemented !== true ||
  v5ContinuousEvidence.currentFacts?.endToEndSignalRuntimeImplemented !== true ||
  v5ContinuousEvidence.currentFacts?.componentTestCount !== 47 ||
  v5ContinuousEvidence.currentFacts?.residentProcessStarted !== false ||
  v5ContinuousEvidence.currentFacts?.paperOrders !== 0 ||
  v5ContinuousEvidence.currentFacts?.realOrders !== 0 ||
  forbiddenV5MdCalls.some((value) => v5RuntimeSources.some((source) => source.includes(value))) ||
  !v5RulesSource.includes("allocateR22IntegerLots") ||
  !v5RulesSource.includes("WAITING_NEXT_EXECUTABLE_BBO") ||
  !v5RulesSource.includes("ROLL_BLOCKED_OPEN_POSITION") ||
  !v5SessionSource.includes("SESSION_TRADING_DAY_RELATION_MISMATCH") ||
  !v5SessionSource.includes("NIGHT_SESSION_NOT_AUTHORIZED_FOR_TRADING_DAY") ||
  !v5SessionSource.includes("SHFE-AU-TRADABLE-MINUTE-BARS-1.0.0") ||
  !v5TickSequenceSource.includes("NO_STRICT_EXCHANGE_TOTAL_ORDER") ||
  !v5StrategySource.includes("discoverMtfxR22Plan") ||
  !v5StrategySource.includes("R13_EVENT_FREEZE") ||
  !v5StrategySource.includes("R15_CURRENT_FULLY_CONFIRMED") ||
  !v5StrategySource.includes("BLOCKED_CROSS_CONTRACT_STRUCTURE_MIX") ||
  !v5R22ManagementSource.includes("stopForAggregateNetRFloor") ||
  !v5R22ManagementSource.includes("R21_CLOSED_15M_ATR") ||
  !v5R22ManagementSource.includes("CONFIRMED_1H_STRUCTURE") ||
  !v5DaemonSource.includes("PAPER_POSITION_OPENED") ||
  !v5DaemonSource.includes("R15_OPPOSITE_REPLACEMENT") ||
  !v5DaemonSource.includes("NEXT_FRESH_SEQUENCE_QUALIFIED_BBO_ONLY") ||
  !v5DaemonSource.includes("COMPLETED_TRADING_DAY_BATCH") ||
  !v5DaemonSource.includes("barsByInstrument") ||
  !v5DaemonSource.includes("CTP_TICK_QUEUE_OVERLOAD") ||
  !v5DaemonSource.includes("POSITION_STOP_TIGHTENED") ||
  !v5LedgerStoreSource.includes("LEDGER_INTEGRITY_FAILURE") ||
  !v5SupervisorSource.includes("DAEMON_EXIT_RESTART_SCHEDULED") ||
  !v5EfficacySource.includes("primaryDecisionReady") ||
  !v5AuthoritativeInputsSource.includes("validateOfficialShfeCalendar") ||
  !v5AuthoritativeInputsSource.includes("validateAuthoritativeAuMetadata") ||
  !v5AuthoritativeInputsSource.includes("dominantSelectionEligibleInConstraintWindow") ||
  !v5PositionBatchesSource.includes("TODAY_FIRST_THEN_YESTERDAY_FIFO") ||
  !v5PositionBatchesSource.includes("CLOSE_TODAY") ||
  !v5PositionBatchesSource.includes("CLOSE_YESTERDAY") ||
  v5CalendarTemplate.schemaVersion !== 2 ||
  !Object.hasOwn(v5CalendarTemplate.tradingDayRecords?.[0] ?? {}, "nightActionDays") ||
  v5InstrumentTemplate.schemaVersion !== 2 ||
  !Object.hasOwn(v5InstrumentTemplate.instruments?.[0] ?? {}, "volumeMultiple") ||
  !Object.hasOwn(v5InstrumentTemplate.instruments?.[0]?.fees?.exchange ?? {}, "CLOSE_TODAY") ||
  !Object.hasOwn(v5InstrumentTemplate.instruments?.[0]?.fees?.brokerSurcharge ?? {}, "CLOSE_TODAY") ||
  !v5MonitorSource.includes('fetch("/api/v5-au"') ||
  !v5MonitorSource.includes("30_000") ||
  !v5ApiSource.includes("V5_AU_MONITOR_INGEST_TOKEN")
) {
  throw new Error("ORION_V5_AU_FUTURES_SCAFFOLD_INVALID");
}

process.stdout.write(`${JSON.stringify({ status: "OK", files: required.length, mode: current.mode, candidate: mtfx.candidateVersion })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyMigration();
