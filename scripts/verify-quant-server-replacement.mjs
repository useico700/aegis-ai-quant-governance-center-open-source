import { loadS1S2OwnerPause } from './verify-s1-s2-owner-pause.mjs';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const read = async (name) => JSON.parse(await fs.readFile(new URL(name, root), "utf8"));
const [activeCurrent, authorization, evidence, registry, accountConfig, scannerConfig] = await Promise.all([
  read("governance/current-state.json"),
  read("governance/owner-authorizations/2026-09-11-demo-server-replacement.json"),
  read("governance/evidence/demo-server-replacement-20260911.json"),
  read("governance/domain-registry.json"),
  read("agents/orion-live/binance-prod/config.json"),
  read("agents/orion-live/s1-scanner/config.json"),
]);
const ownerPaused = await loadS1S2OwnerPause(activeCurrent, read);
// Old infrastructure assertions refer to their immutable deployment snapshot;
// the owner-authorized successor above has its own full production validator.
const current = activeCurrent.s1PaperFinalLive20261010 ? await read(activeCurrent.s1PaperFinalLive20261010.priorStateSnapshot) : activeCurrent;
const infra = current.deploymentInfrastructure;
const server = infra.servers.quantServer;
const service = infra.productionReadOnlyService;
const execution = current.executionDomains.orionLiveBinanceUsdmProduction;
const liveHost = execution.liveHostDeploymentEvidence ? await read(execution.liveHostDeploymentEvidence) : null;
const latestIncident = execution.latestIncidentEvidence ? await read(execution.latestIncidentEvidence) : null;
const entryBlockedByIncident = latestIncident?.postCondition?.entryIncident === 'ACCOUNT_ACTIVITY_REVIEW_REQUIRED'
  && latestIncident?.postCondition?.liveReady === false;
const recovery = execution.readOnlyRecoveryEvidence ? await read(execution.readOnlyRecoveryEvidence) : null;
const priority = execution.priorityDeploymentEvidence ? await read(execution.priorityDeploymentEvidence) : null;
const batch = execution.batchDeploymentEvidence ? await read(execution.batchDeploymentEvidence) : null;
const configuration = execution.accountConfigurationDeploymentEvidence ? await read(execution.accountConfigurationDeploymentEvidence) : null;
const scheduling = execution.readSchedulingDeploymentEvidence ? await read(execution.readSchedulingDeploymentEvidence) : null;
const readinessPreparation = execution.requestedExecution?.componentPreparation?.readinessStatusPreparation;
const readinessDeployment = execution.readinessStatusDeploymentEvidence ? await read(execution.readinessStatusDeploymentEvidence) : null;
const opsPreparation = execution.requestedExecution?.componentPreparation;
if (infra.projectOnlyWorkScope) {
  const scope = infra.projectOnlyWorkScope, directive = await read(scope.authorization);
  assert.equal(directive.ownerRequest, '不要管宝塔升级的问题，服务器情况你不要关心');
  for (const key of ['environmentInvestigationAllowed', 'localWorkRequiresEnvironmentConfirmation',
    'historicalEnvironmentEvidenceVerifiedByOwner', 'serverDeploymentAcceptanceGranted']) {
    assert.equal(scope[key], false); assert.equal(directive[key], false);
  }
  assert.equal(directive.rawMaximumBytes, 64424509440);
  assert.equal(directive.rawRetentionDays, 7);
  assert.equal(directive.realOrdersAllowed, false);
  assert.equal(directive.pinnedOrFinancialEvidenceDeletionAllowed, false);
}
if (opsPreparation?.calendarLanePreparation?.cadenceReviewEvidence) {
  const d = await read(opsPreparation.calendarLanePreparation.cadenceReviewEvidence);
  assert.equal(d.status, 'EXACT_CADENCE_MODEL_TESTED_RUNTIME_SCHEDULING_NOT_ACCEPTED');
  assert.equal(d.scopeAuthorization, infra.projectOnlyWorkScope.authorization);
  assert.equal(d.scope.serverConnected, false);
  assert.equal(d.scope.productionSourceChanged, false);
  assert.equal(d.scope.realOrdersAllowed, false);
  assert.equal(d.findings.actualServerRootCauseProven, false);
  assert.equal(opsPreparation.calendarLanePreparation.calendarDecouplingAloneProvesScheduling, false);
  assert.equal(d.reproduction.oldAttemptCount, 38);
  assert.equal(d.reproduction.exactAttemptCount, 40);
  assert.equal(d.tests.failed, 0);
  assert.equal(d.matrix.results.length, 12);
  assert.equal(new Set(d.matrix.results.map(r => `${r.shadowDurationMs}:${r.readerOffsetMs}`)).size, 12);
  for (const row of d.matrix.results) {
    assert.ok([150, 3000, 5000].includes(row.shadowDurationMs));
    assert.ok([0, 15000, 30000, 45000].includes(row.readerOffsetMs));
    assert.equal(row.samples, 1201);
    assert.equal(row.historyFresh, row.samples);
    assert.equal(row.bothFresh, row.feesFresh);
    assert.ok(row.maximumSpent <= d.limits.maximumWeight);
    assert.ok(row.shadow.refused > 0);
    assert.equal(row.shadow.weight, row.shadow.accepted * d.limits.accountBatchWeight);
    if (row.shadowDurationMs === 150) assert.ok(row.feesFresh < row.samples);
  }
}
if (opsPreparation?.calendarLanePreparation?.coordinationReviewEvidence) {
  const d = await read(opsPreparation.calendarLanePreparation.coordinationReviewEvidence);
  assert.equal(d.status, 'READ_COORDINATION_PROPOSALS_REJECTED_OFFLINE');
  assert.equal(opsPreparation.calendarLanePreparation.singleLaneCoordinationAccepted, false);
  for (const flag of ['liveReadinessProven', 'serverConnected', 'productionSourceChanged', 'realOrdersAllowed']) assert.equal(d[flag], false);
  assert.equal(d.matrix.rows.length, 80);
  assert.equal(d.summary.length, 5);
  for (const summary of d.summary) {
    const rows = d.matrix.rows.filter(r => r.proposal === summary.proposal);
    assert.equal(rows.length, 16);
    assert.equal(new Set(rows.map(r => `${r.shadowDurationMs}:${r.readerOffsetMs}`)).size, 16);
    assert.equal(summary.feeFreshAllSamplesCases, rows.filter(r => r.feesFresh === r.samples).length);
    assert.equal(summary.historyFreshAllSamplesCases, rows.filter(r => r.historyFresh === r.samples).length);
    assert.equal(summary.zeroShadowRefusalCases, rows.filter(r => r.shadowRefused === 0).length);
    assert.equal(summary.shadowAgeOver30000Cases, rows.filter(r => r.shadowReadAgeOver30000Samples > 0).length);
    assert.equal(summary.maximumShadowReadAge, Math.max(...rows.map(r => r.maximumShadowReadAge)));
    assert.ok(rows.some(r => r.feesFresh < r.samples));
    assert.ok(rows.every(r => r.maximumSpent <= 900 && r.historyFresh === r.samples));
  }
  assert.equal(d.limitsUnchanged.accountSnapshotFreshnessMs, 5000);
  assert.equal(d.limitsUnchanged.rawMaximumBytes, 64424509440);
}
if (opsPreparation?.calendarLanePreparation?.unifiedCoordinatorPreparation) {
  const state = opsPreparation.calendarLanePreparation.unifiedCoordinatorPreparation;
  const d = await read(state.evidence);
  const durable = state.durablePreparationEvidence ? await read(state.durablePreparationEvidence) : null;
  if (state.mixedWorkloadDiagnosis) {
    const mixed = state.mixedWorkloadDiagnosis, r = await read(mixed.evidence), data = await read(r.results);
    assert.equal(mixed.status, 'LOCAL_MIXED_READ_COMPONENT_COUNTEREXAMPLES_REPRODUCED_NOT_ACCEPTED');
    assert.equal(r.status, mixed.status);
    assert.equal(r.extends, state.publicReadPreparation.evidence);
    for (const key of ['wholeWorkloadAccepted', 'queuedResumeVariantsAppliedToRuntime', 'serverActivated']) assert.equal(mixed[key], false);
    assert.equal(r.findings.wholeWorkloadAccepted, false);
    assert.equal(r.findings.deployedRootCauseProven, false);
    assert.equal(r.tests.regressionPassMeansCounterexampleReproducedNotReadiness, true);
    assert.equal(data.wholeWorkloadAccepted, false); assert.equal(data.results.length, 3);
    for (const row of data.results) {
      assert.equal(row.liveReadinessProven, false);
      assert.ok(row.feesFresh < row.samples);
      assert.ok(row.maximumSpent <= 900 && row.maximumInflight <= 8 && row.maximumQueued <= 128);
    }
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440); assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.tests.newTests, r.tests.newPassed); assert.equal(r.tests.newFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
  }
  if (state.publicReadPreparation) {
    const publicRead = state.publicReadPreparation, r = await read(publicRead.evidence);
    assert.equal(publicRead.status, 'LOCAL_SCAN_CONTEXT_PUBLIC_WINDOWS_TESTED_NOT_HOST_WIRED');
    assert.equal(r.status, publicRead.status);
    assert.equal(r.extends, state.independentReaderPreparation.evidence);
    assert.equal(publicRead.actualCachesAndFrameProviderTested, true);
    for (const key of ['productionRuntimeWired', 'wholeWorkloadAccepted', 'serverActivated']) assert.equal(publicRead[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.boundaries.maximumWindowAheadMs, 150000);
    assert.equal(r.boundaries.callerMustChooseOriginalShorterCutoffWhenApplicable, true);
    assert.equal(r.boundaries.sourceFreshnessThresholdsUnchanged, true);
    assert.equal(r.boundaries.hostFactoriesUseV2, false);
    assert.equal(r.tests.newTests, r.tests.newPassed);
    assert.equal(r.tests.newFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
  }
  if (state.independentReaderPreparation) {
    const reader = state.independentReaderPreparation, r = await read(reader.evidence);
    assert.equal(reader.status, 'LOCAL_INDEPENDENT_READER_PREFLIGHT_COORDINATED_NOT_HOST_WIRED');
    assert.equal(r.status, reader.status);
    assert.equal(r.extends, state.accountCachePreparation.evidence);
    assert.equal(reader.actualPreflightOptionalCoordinationTested, true);
    for (const key of ['productionRuntimeWired', 'wholeWorkloadAccepted', 'serverActivated']) assert.equal(reader[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.implemented.actualPreflightOptionalCoordination, true);
    assert.equal(r.implemented.accountObservationUsesStartOnBothPaths, true);
    assert.equal(r.implemented.residentMainStillUsesV1, true);
    assert.equal(r.limitsUnchanged.accountReaderCycleIntervalMs, 60000);
    assert.equal(r.limitsUnchanged.accountReaderStaleAfterMs, 120000);
    assert.equal(r.limitsUnchanged.executionAccountSnapshotMaximumAgeMs, 5000);
    assert.equal(r.limitsUnchanged.readerBatchWeight, 107);
    assert.equal(r.tests.newTests, r.tests.newPassed);
    assert.equal(r.tests.newFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
  }
  if (state.accountCachePreparation) {
    const account = state.accountCachePreparation, r = await read(account.evidence);
    assert.equal(account.status, 'LOCAL_ACCOUNT_CACHE_COORDINATION_TESTED_NOT_PRODUCTION_WIRED');
    assert.equal(r.status, account.status);
    assert.equal(r.extends, state.feeProviderPreparation.evidence);
    assert.equal(account.actualAccountCacheOptionalCoordinationTested, true);
    for (const key of ['productionRuntimeWired', 'wholeWorkloadAccepted', 'serverActivated']) assert.equal(account[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.implemented.actualAccountCacheOptionalSessionPort, true);
    assert.equal(r.implemented.accountAndFeeFinalPublicationCheckStop, true);
    assert.equal(r.implemented.legacyProductionBranchUnchanged, true);
    assert.equal(r.limitsUnchanged.accountSnapshotMaximumAgeMs, 5000);
    assert.equal(r.limitsUnchanged.accountBatchWeight, 105);
    assert.equal(r.limitsUnchanged.accountBatchRequests, 5);
    assert.equal(r.tests.targetedTests, r.tests.targetedPassed);
    assert.equal(r.tests.targetedFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
  }
  if (state.feeProviderPreparation) {
    const fee = state.feeProviderPreparation, r = await read(fee.evidence);
    assert.equal(fee.status, 'LOCAL_FRAME_PROVIDER_FEE_COORDINATION_TESTED_NOT_PRODUCTION_WIRED');
    assert.equal(r.status, fee.status);
    assert.equal(r.extends, state.sessionLifecyclePreparation.evidence);
    assert.equal(fee.actualProviderOptionalCoordinationTested, true);
    for (const key of ['productionRuntimeWired', 'wholeWorkloadAccepted', 'serverActivated']) assert.equal(fee[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.implemented.actualExecutionFrameProviderOptionalSessionPort, true);
    assert.equal(r.implemented.waitDoesNotConsumeFeeSlot, true);
    assert.equal(r.implemented.legacyProductionBranchUnchanged, true);
    assert.equal(r.limitsUnchanged.refreshStrictlyAfterMs, 240000);
    assert.equal(r.limitsUnchanged.feeFreshnessMs, 300000);
    assert.equal(r.limitsUnchanged.maximumAttemptsPer65000Ms, 3);
    assert.equal(r.tests.newTests, r.tests.newPassed);
    assert.equal(r.tests.newFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
  }
  if (state.sessionLifecyclePreparation) {
    const lifecycle = state.sessionLifecyclePreparation, r = await read(lifecycle.evidence);
    assert.equal(lifecycle.status, 'LOCAL_COORDINATED_SESSION_LIFECYCLE_TESTED_NOT_RUNTIME_WIRED_OR_DEPLOYED');
    assert.equal(r.status, lifecycle.status);
    assert.equal(r.extends, state.migrationPreparation.evidence);
    assert.equal(lifecycle.explicitHeartbeatAndDrainLocallyTested, true);
    for (const key of ['productionRuntimeWired', 'wholeResidentShutdownVerified', 'serverActivated']) assert.equal(lifecycle[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.verified.heartbeatIntervalMs, 10000);
    assert.equal(r.verified.nativeLocalProcesses, 3);
    assert.equal(r.verified.timedOutDrainCannotReleaseOwnerLater, true);
    assert.equal(r.verified.ownerRegistrationUsesTransactionTimestamp, true);
    assert.equal(r.verified.databaseAndSidecarsMaximumBytesUnchanged, 1048576);
    assert.equal(r.verified.defaultSchemaVersionUnchanged, 1);
    assert.equal(r.tests.componentTests, r.tests.componentPassed);
    assert.equal(r.tests.componentFailed, 0);
    for (const prefix of ['fullS1', 'offlineAcceptance']) {
      assert.equal(r.tests[`${prefix}Tests`], r.tests[`${prefix}Passed`] + r.tests[`${prefix}Skipped`]);
      assert.equal(r.tests[`${prefix}Failed`], 0);
    }
    assert.equal(r.tests.offlineIncludesBridgeAuxiliaryAndSession, true);
  }
  if (state.migrationPreparation) {
    const migration = state.migrationPreparation, m = await read(migration.evidence);
    assert.equal(migration.status, 'LOCAL_QUIESCENT_V1_TO_V2_MIGRATION_TESTED_NOT_EXECUTED_IN_PRODUCTION');
    assert.equal(m.status, migration.status);
    assert.equal(m.extends, state.durablePreparationEvidence);
    assert.equal(migration.quiescentMigrationLocallyTested, true);
    assert.equal(migration.durableMigrationReceiptImplemented, true);
    assert.equal(migration.productionMigrationExecuted, false);
    assert.equal(migration.productionMigrationBackupAccepted, false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionMigrationExecuted', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(m.scope[key], false);
    assert.equal(m.scope.rawMaximumBytes, 64424509440);
    assert.equal(m.scope.rawRetentionDays, 7);
    assert.equal(m.schema.defaultVersionUnchanged, 1);
    assert.equal(m.schema.preparedVersion, 2);
    assert.equal(m.schema.databaseAndSidecarsMaximumBytesUnchanged, 1048576);
    assert.equal(m.schema.productionCallerOrCliProvided, false);
    assert.equal(m.verified.unknownPendingRejectedWithoutMutation, true);
    assert.equal(m.verified.schemaVersionStateAndReceiptSingleTransaction, true);
    assert.equal(m.verified.minimumDrainMs, 65000);
    assert.equal(m.tests.newTests, m.tests.newPassed);
    assert.equal(m.tests.newFailed, 0);
    assert.equal(m.tests.fullS1Tests, m.tests.fullS1Passed + m.tests.fullS1Skipped);
    assert.equal(m.tests.fullS1Failed, 0);
    assert.equal(m.tests.offlineAcceptanceTests, m.tests.offlineAcceptancePassed + m.tests.offlineAcceptanceSkipped);
    assert.equal(m.tests.offlineAcceptanceFailed, 0);
  }
  if (state.readerLifecyclePreparation) {
    const lifecycle = state.readerLifecyclePreparation, r = await read(lifecycle.evidence);
    assert.equal(lifecycle.status, 'LOCAL_READER_STREAM_DRAIN_TESTED_NOT_PACKAGED_OR_DEPLOYED');
    assert.equal(r.status, lifecycle.status);
    assert.equal(r.extends, state.auxiliaryPreparation.evidence);
    assert.equal(lifecycle.readerStreamDrainLocallyTested, true);
    assert.equal(lifecycle.productionReaderUpdated, false);
    assert.equal(lifecycle.wholeResidentShutdownVerified, false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionActivated', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(r.scope[key], false);
    assert.equal(r.scope.rawMaximumBytes, 64424509440);
    assert.equal(r.scope.rawRetentionDays, 7);
    assert.equal(r.reproduction.initialNewTests, r.reproduction.initialNewFailed);
    assert.equal(r.reproduction.initialFullRegressionExitCode, 1);
    assert.equal(r.reproduction.initialOfflineAcceptanceExitCode, 1);
    assert.equal(r.verified.postAndPutCompleteBodiesDrained, true);
    assert.equal(r.verified.pendingOwnerCannotClose, true);
    assert.equal(r.verified.wholeCoordinatedResidentShutdownAccepted, false);
    assert.equal(r.tests.newTests, r.tests.newPassed);
    assert.equal(r.tests.fullS1Tests, r.tests.fullS1Passed + r.tests.fullS1Skipped);
    assert.equal(r.tests.fullS1Failed, 0);
    assert.equal(r.tests.offlineAcceptanceTests, r.tests.offlineAcceptancePassed + r.tests.offlineAcceptanceSkipped);
    assert.equal(r.tests.offlineAcceptanceFailed, 0);
    assert.equal(r.tests.offlineAcceptanceIncludesNewLifecycle, true);
  }
  if (state.auxiliaryPreparation) {
    const auxiliary = state.auxiliaryPreparation, a = await read(auxiliary.evidence);
    assert.equal(auxiliary.status, 'LOCAL_PAGINATION_AND_STREAM_PORTS_TESTED_NOT_RUNTIME_WIRED_OR_PACKAGED');
    assert.equal(a.status, auxiliary.status);
    assert.equal(a.extends, state.requestBindingPreparation.evidence);
    assert.equal(auxiliary.historyAndStreamLocalPortsImplemented, true);
    assert.equal(auxiliary.actualWindowMonitorFixtureAccepted, true);
    for (const key of ['productionRuntimeWired', 'wholeResidentShutdownVerified', 'serverActivated']) assert.equal(auxiliary[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionHostBindingChanged', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(a.scope[key], false);
    assert.equal(a.scope.rawMaximumBytes, 64424509440);
    assert.equal(a.scope.rawRetentionDays, 7);
    assert.equal(a.catalog.totalIds, 124);
    assert.equal(auxiliary.catalogIds, a.catalog.totalIds);
    assert.equal(a.catalog.totalIds, a.catalog.originalIdsRetained + a.catalog.addedSinglePageIds + a.catalog.addedMaintenanceIds);
    assert.equal(a.capacityFixture.queuedReceipts, a.catalog.totalIds);
    assert.ok(a.capacityFixture.databaseAndSidecarBytes <= a.capacityFixture.maximumBytesUnchanged);
    assert.equal(a.capacityFixture.maximumBytesUnchanged, 1048576);
    assert.equal(a.capacityFixture.serverMeasurement, false);
    assert.equal(a.verified.historyMaximumRequestsUnchanged, 6);
    assert.equal(a.verified.historyTotalDeadlineMsUnchanged, 20000);
    assert.equal(a.verified.actualMonitorNewPositions, 0);
    assert.equal(a.tests.newTests, a.tests.newPassed);
    assert.equal(a.tests.newFailed, 0);
    assert.equal(a.tests.fullS1Tests, a.tests.fullS1Passed + a.tests.fullS1Skipped);
    assert.equal(a.tests.fullS1Failed, 0);
    assert.equal(a.tests.existingOfflineAcceptanceIncludesNewAuxiliaryPorts, false);
  }
  if (state.requestBindingPreparation) {
    const binding = state.requestBindingPreparation, b = await read(binding.evidence);
    assert.equal(binding.status, 'LOCAL_REQUEST_BINDING_TESTED_NOT_RUNTIME_WIRED_OR_PACKAGED');
    assert.equal(b.status, binding.status);
    assert.equal(b.extends, state.durablePreparationEvidence);
    assert.equal(binding.exactRequestsLocallyBound, true);
    assert.equal(binding.selectionBeforeSigningTested, true);
    for (const key of ['allEndpointCoverageComplete', 'productionRuntimeWired', 'serverActivated']) assert.equal(binding[key], false);
    for (const key of ['serverConnected', 'serverChanged', 'productionCredentialsLoaded', 'networkRequestsMade', 'packageBuilt', 'productionHostBindingChanged', 'realOrdersAllowed', 'financialOrPinnedEvidenceDeleted']) assert.equal(b.scope[key], false);
    assert.equal(b.scope.rawMaximumBytes, 64424509440);
    assert.equal(b.scope.rawRetentionDays, 7);
    assert.equal(b.verified.selectionBeforeSigning, true);
    assert.equal(b.verified.additionalHistoryPageRejectedBeforeFetch, true);
    assert.equal(b.verified.bridgeCompletedMeansHttpSuccess, false);
    assert.equal(b.verified.bridgeCompletedMeansEvidenceFresh, false);
    assert.equal(b.tests.newTests, b.tests.newPassed);
    assert.equal(b.tests.newFailed, 0);
    assert.equal(b.tests.fullS1Tests, b.tests.fullS1Passed + b.tests.fullS1Skipped);
    assert.equal(b.tests.fullS1Failed, 0);
    assert.equal(b.tests.existingOfflineAcceptanceIncludesNewBridge, false);
  }
  assert.equal(state.status, durable ? 'LOCAL_DURABLE_COMPONENT_TESTED_NOT_WIRED_OR_PACKAGED' : 'LOCAL_PROTOTYPE_TESTED_NOT_WIRED_OR_PACKAGED');
  assert.equal(d.status, 'LOCAL_UNIFIED_READ_COORDINATOR_PROTOTYPE_NOT_WIRED_OR_PACKAGED');
  assert.equal(state.atomicSharedAdmissionImplemented, !!durable);
  for (const key of ['serverActivated', 'liveReadinessProven']) assert.equal(state[key], false);
  if (durable) {
    assert.equal(durable.status, 'LOCAL_DURABLE_READ_COORDINATION_TESTED_NOT_WIRED_OR_PACKAGED');
    assert.equal(durable.supersedesLocalAtomicImplementationStatusOnly, state.evidence);
    assert.equal(state.preparedSchemaVersion, 2);
    for (const key of ['productionSchemaVersionChanged', 'runtimeBindingComplete', 'durableWorkloadIntegrationAccepted']) assert.equal(state[key], false);
    assert.equal(state.inPlaceMigrationImplemented, !!state.migrationPreparation);
    assert.equal(durable.schema.defaultVersion, 1); assert.equal(durable.schema.preparedVersion, 2);
    assert.equal(durable.schema.tables.length, 6);
    assert.equal(durable.atomicity.selectionPhaseChargePendingAndClaimsSameTransaction, true);
    assert.equal(durable.atomicity.actualDistributedHostIntegrationAccepted, false);
    for (const key of ['serverConnected', 'serverChanged', 'credentialsLoaded', 'productionHostBindingChanged', 'productionActivated', 'realOrdersAllowed']) assert.equal(durable.scope[key], false);
    assert.equal(durable.scope.rawMaximumBytes, 64424509440);
    assert.equal(durable.crashEvidence.reservedRequests, durable.crashEvidence.requestsAfterRecovery);
    assert.equal(durable.crashEvidence.recoveredRequests, 5);
    assert.equal(durable.crashEvidence.blockedUntilAfterRecovery - durable.crashEvidence.clockAtCrash, 65000);
    assert.equal(durable.crashEvidence.unknownOutcomeWeightRefunded, false);
    assert.equal(durable.capacityEvidence.remainingIntentReceipts, 1);
    assert.equal(durable.tests.fullS1Tests, durable.tests.fullS1Passed + durable.tests.fullS1Skipped + durable.tests.fullS1Failed);
    assert.equal(durable.tests.existingOfflineAcceptanceIncludesNewCoordinator, false);
  }
  for (const key of ['serverConnected', 'serverChanged', 'packageBuilt', 'realOrdersAllowed', 'credentialsLoaded', 'productionRuntimeWiringChanged']) assert.equal(d.scope[key], false);
  assert.equal(d.planner.maximumIntents, 128);
  assert.equal(d.planner.selectionIsReservation, false);
  assert.equal(d.limitsUnchanged.rawMaximumBytes, 64424509440);
  assert.equal(d.limitsUnchanged.accountSnapshotFreshnessMs, 5000);
  assert.equal(d.experiments.sweeps.length, 2);
  for (const sweep of d.experiments.sweeps) {
    assert.equal(sweep.rows.length, 240);
    assert.equal(new Set(sweep.rows.map(row => `${row[0]}:${row[1]}`)).size, 240);
    assert.equal(createHash('sha256').update(JSON.stringify(sweep.rows)).digest('hex'), sweep.rowsSha256);
    for (const row of sweep.rows) {
      assert.equal(row.length, 11);
      assert.ok(row.every(value => Number.isSafeInteger(value) && value >= 0));
      assert.ok([0, 150, 3000, 5000].includes(row[0]));
      assert.ok(row[1] < 60000 && row[1] % 1000 === 0);
      assert.equal(row[2], 3001);
      assert.ok(row.slice(3, 8).every(value => value <= row[2]));
      assert.ok(row[8] <= 900 && row[9] <= 128);
    }
    const failed = sweep.rows.filter(row => row.slice(3, 8).some(value => value !== row[2])).length;
    assert.equal(failed, sweep.failedCases);
    assert.equal(failed, sweep.announceFutureFees ? 0 : 11);
  }
  assert.equal(d.tests.fullS1Tests, d.tests.fullS1Passed + d.tests.fullS1Skipped + d.tests.fullS1Failed);
  assert.equal(d.findings.liveReadinessProven, false);
}
const calendarLanePackage = opsPreparation?.calendarLanePreparation?.packageEvidence
  ? await read(opsPreparation.calendarLanePreparation.packageEvidence) : null;
if (opsPreparation?.calendarLanePreparation?.environmentChangeEvidence) {
  const state = opsPreparation.calendarLanePreparation, d = await read(state.environmentChangeEvidence);
  assert.equal(d.status, 'PANEL_ENVIRONMENT_CHANGE_OBSERVED_DEPLOYMENT_REMAINS_PAUSED');
  assert.equal(d.server, server.host);
  assert.equal(state.panelPythonObserved, '3.13.14');
  assert.equal(d.upgradeEvidence.currentPanelPython, 'Python 3.13.14');
  assert.equal(d.upgradeEvidence.upgradeEnvRequests.length, 1);
  assert.equal(d.upgradeEvidence.upgradeEnvRequests[0].action, 'upgrade_env');
  assert.equal(d.findings.ownerIntentConfirmed, false);
  assert.equal(d.findings.permissionChangeDirectCauseVerified, false);
  assert.equal(state.panelEnvironmentOwnerIntentConfirmed, false);
  assert.equal(d.current.metadata.length, 8);
  assert.ok(d.current.metadata.every(f => f.mode === '0600' && f.uid === 0 && f.gid === 0));
  assert.equal(d.scope.serverMutationPerformed, false);
  assert.equal(d.scope.newReleaseUploaded, false);
  assert.equal(d.scope.realOrdersAllowed, false);
  const observed = await read('governance/evidence/s1-batch-dispatch-observation-20260914.json');
  assert.deepEqual(d.current.generations, observed.current.generations);
  assert.deepEqual(d.current.opsGeneration, observed.current.monitor.generation);
  assert.deepEqual(d.current.budget.database, observed.current.budget.database);
  assert.deepEqual(d.current.budget.owners, observed.current.budget.owners);
  assert.ok(d.current.budget.requests >= observed.current.budget.requests);
  assert.equal(d.current.budget.recoveredRequests, observed.current.budget.recoveredRequests);
}
if (opsPreparation?.calendarLanePreparation) {
  const state = opsPreparation.calendarLanePreparation, d = await read(state.evidence);
  assert.equal(state.status, calendarLanePackage ? 'PACKAGED_SERVER_PRECHECK_BLOCKED_NOT_UPLOADED' : 'LOCAL_TESTED_NOT_PACKAGED_OR_DEPLOYED');
  assert.equal(d.status, 'LOCAL_CALENDAR_LANE_TESTED_NOT_PACKAGED_OR_DEPLOYED');
  assert.equal(state.serverStaged, false);
  assert.equal(state.serverActivated, false);
  assert.equal(state.exactServerRootCauseConfirmed, false);
  assert.equal(state.schedulingAccepted, false);
  assert.equal(d.findings.inlineCalendarWaitReproduced, true);
  assert.equal(d.findings.exactServerRootCauseConfirmed, false);
  assert.equal(d.findings.syntheticCalendarDelayMs, 5001);
  assert.equal(d.implementation.frameCalendarReadMemoryOnly, true);
  assert.equal(d.implementation.independentSupervisedCalendarLane, true);
  assert.equal(d.implementation.cacheAttemptFreshnessMs, 30000);
  assert.equal(d.implementation.httpDeadlineMs, 5000);
  assert.equal(d.implementation.sourceTimestampsAndEventGateUnchanged, true);
  assert.equal(d.implementation.failedOrPendingCalendarBlocksEntries, true);
  assert.equal(d.implementation.shutdownDrainsCalendarTask, true);
  assert.equal(d.validation.redRegression.fail, 1);
  assert.equal(d.validation.targeted.pass, 55);
  assert.equal(d.validation.regression.fail, 0);
  assert.equal(d.validation.offline.fail, 0);
  assert.equal(d.files.length, 8);
  assert.ok(d.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 0));
  assert.equal(d.productionScope.serverActivated, false);
  assert.equal(d.productionScope.realOrdersAllowed, false);
  assert.equal(d.productionScope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.productionScope.quotaOrFreshnessRelaxed, false);
  assert.equal(d.conclusions.fullLiveReady, false);
}
if (calendarLanePackage) {
  const d = calendarLanePackage, state = opsPreparation.calendarLanePreparation;
  assert.equal(d.status, 'CALENDAR_LANE_PACKAGED_SERVER_PRECHECK_BLOCKED_NOT_UPLOADED');
  assert.equal(d.release.releaseId, state.releaseId);
  assert.equal(d.release.fileCount, 143);
  assert.equal(d.release.allArchiveFilesAndLocalBytesVerified, true);
  assert.equal(d.release.delta.changed.length, 5);
  assert.deepEqual(d.release.delta.added, ['agents/orion-live/s1-execution/entry-calendar-cache.mjs', 'tests/s1-entry-calendar-cache.test.mjs']);
  assert.deepEqual(d.release.delta.removed, []);
  assert.equal(d.serverPrecheck.completed, false);
  assert.equal(d.serverPrecheck.reason, 'RELEASE_FILE_OWNER_MODE');
  assert.equal(d.serverPrecheck.beforeUploadOrServerMutation, true);
  assert.equal(d.serverPrecheck.allFourComposeContentsMatchPinned, true);
  assert.equal(d.serverPrecheck.changeActorOrCauseVerified, false);
  assert.equal(d.serverPrecheck.metadata.length, 8);
  assert.ok(d.serverPrecheck.metadata.every(f => f.uid === 0 && f.gid === 0 && f.mode === '0o600' && f.nlink === 1 && !f.symlink));
  assert.ok(d.serverPrecheck.metadata.filter(f => f.file === '.env').every(f => f.bytes === 0));
  assert.equal(d.serverPrecheck.opsComposeComparison.opsComposeContentMatchesPinned, true);
  assert.equal(d.scope.permissionsChangedByThisTurn, false);
  assert.equal(d.scope.serverStaged, false);
  assert.equal(d.scope.serverActivated, false);
  assert.equal(d.scope.serverTestsRun, false);
  assert.equal(d.scope.realOrdersAllowed, false);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(opsPreparation.latestLocalPreparationReleaseId, state.releaseId);
  assert.equal(opsPreparation.latestLocalPreparationDeployed, false);
  assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, false);
}
const batchDispatchAcceptance = opsPreparation?.batchDispatchPreparation?.serverAcceptanceEvidence
  ? await read(opsPreparation.batchDispatchPreparation.serverAcceptanceEvidence) : null;
const batchDispatchDeployment = opsPreparation?.batchDispatchPreparation?.activationEvidence
  ? await read(opsPreparation.batchDispatchPreparation.activationEvidence) : null;
const batchDispatchObservation = opsPreparation?.batchDispatchPreparation?.observationEvidence
  ? await read(opsPreparation.batchDispatchPreparation.observationEvidence) : null;
if (opsPreparation?.batchDispatchPreparation) {
  const state = opsPreparation.batchDispatchPreparation, d = await read(state.evidence);
  assert.equal(state.status, batchDispatchObservation ? 'SHADOW_OBSERVATION_COMPLETED_NOT_ACCEPTED' : batchDispatchDeployment ? 'SHADOW_ACTIVATED_OBSERVATION_RUNNING' : batchDispatchAcceptance ? 'SERVER_ISOLATED_ACCEPTED_NOT_ACTIVATED' : 'LOCAL_TESTED_AND_PACKAGED_NOT_SERVER_STAGED');
  assert.equal(d.status, 'LOCAL_BATCH_DISPATCH_RETIMING_TESTED_AND_PACKAGED_NOT_DEPLOYED');
  assert.equal(state.serverStaged, batchDispatchAcceptance !== null);
  assert.equal(state.serverActivated, batchDispatchDeployment !== null);
  assert.equal(state.serverExactFailureCauseConfirmed, false);
  assert.equal(state.schedulingAccepted, false);
  assert.equal(d.reproduction.elapsedMs, 1);
  assert.equal(d.validation.redRegression.fail, 3);
  assert.equal(d.validation.targeted.pass, 134);
  assert.equal(d.validation.regression.fail, 0);
  assert.equal(d.validation.offline.fail, 0);
  assert.equal(d.implementation.maximumElapsedReservationAgeExclusiveMs, 5000);
  assert.equal(d.implementation.originalPendingTimestampPreserved, true);
  assert.equal(d.implementation.chargeTransferredWithinSameSqliteClaimTransaction, true);
  assert.equal(d.implementation.earlierCreditReleaseAllowed, false);
  assert.equal(d.implementation.quotaIncrease, false);
  assert.equal(d.implementation.schemaChanged, false);
  assert.equal(d.release.releaseId, state.releaseId);
  assert.equal(d.release.fileCount, 141);
  assert.deepEqual(d.release.delta.changed, ['agents/orion-live/s1-execution/README.md', 'agents/orion-live/s1-execution/shared-read-budget.mjs', 'tests/s1-shared-read-budget.test.mjs']);
  assert.deepEqual(d.release.delta.added, []);
  assert.deepEqual(d.release.delta.removed, []);
  if (!calendarLanePackage) {
    assert.equal(opsPreparation.latestLocalPreparationReleaseId, state.releaseId);
    assert.equal(opsPreparation.latestLocalPreparationDeployed, batchDispatchDeployment !== null);
    assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, batchDispatchAcceptance !== null && batchDispatchDeployment === null);
  }
  assert.equal(d.productionScope.realOrdersAllowed, false);
  assert.equal(d.productionScope.serverActivated, false);
  assert.equal(d.productionScope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
}
if (batchDispatchAcceptance) {
  const d = batchDispatchAcceptance, prep = opsPreparation.batchDispatchPreparation, run = d.serverAcceptance;
  assert.equal(d.status, 'SERVER_ISOLATED_BATCH_DISPATCH_ACCEPTED_NOT_ACTIVATED');
  assert.equal(d.server, server.host);
  assert.equal(d.release.releaseId, prep.releaseId);
  assert.equal(d.release.fileCount, 141);
  assert.equal(d.release.delta.changed.length, 3);
  assert.deepEqual(d.release.delta.added, []);
  assert.deepEqual(d.release.delta.removed, []);
  assert.deepEqual(run.counts, { tests: 661, pass: 655, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(run.container.status, 'exited');
  assert.equal(run.container.exitCode, 0);
  assert.equal(run.container.oom, false);
  assert.equal(run.container.restartCount, 0);
  assert.equal(run.container.network, 'none');
  assert.equal(run.container.readonly, true);
  assert.equal(run.container.user, '993:993');
  assert.equal(run.container.mounts.length, 1);
  assert.equal(run.source.verifiedFiles, 141);
  assert.equal(run.source.manifestSha256, d.release.manifestSha256);
  assert.deepEqual(run.before.generations, run.after.generations);
  assert.deepEqual(run.before.monitor, run.after.monitor);
  assert.deepEqual(run.before.budget.database, run.after.budget.database);
  assert.deepEqual(run.before.budget.owners, run.after.budget.owners);
  assert.equal(run.before.preservedDigest, run.after.preservedDigest);
  assert.equal(run.before.budget.recoveredRequests, run.after.budget.recoveredRequests);
  assert.ok(run.after.budget.requests >= run.before.budget.requests);
  assert.equal(Object.keys(d.auditHashes).length, 5);
  assert.ok(Object.values(d.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
  assert.equal(d.preStageReadOnlyFailurePreserved.beforeServerMutation, true);
  assert.equal(d.preStageReadOnlyFailurePreserved.testRerun, false);
  assert.equal(d.pinnedHostObserverBindingChanged, false);
  assert.equal(d.serverActivated, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
}
if (batchDispatchDeployment) {
  const d = batchDispatchDeployment, prep = opsPreparation.batchDispatchPreparation;
  assert.equal(d.status, 'SHADOW_BATCH_DISPATCH_ACTIVATED_OBSERVATION_RUNNING');
  assert.equal(d.server, server.host);
  assert.equal(d.shadowRelease.id, prep.releaseId);
  assert.equal(d.controller.sha256, prep.controllerSha256);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.equal(d.controller.testsPassed, 15);
  assert.deepEqual(d.controller.steps.map(s => s.phase), ['STOP_SHADOW', 'SWITCH_SHADOW', 'START_SHADOW', 'VERIFY_RUNTIME']);
  assert.ok(d.controller.steps.every(s => s.artifact === d.controller.sha256 && s.realOrdersAllowed === false));
  const stop = d.controller.steps[0].result, start = d.controller.steps[2].result.generation;
  assert.equal(stop.exitCode, 0);
  assert.ok(Date.parse(start.startedAt) - Date.parse(stop.generation.finishedAt) >= 65000);
  assert.equal(start.restarts, 0);
  assert.deepEqual(start, d.after.generations[2]);
  assert.equal(d.controller.steps[3].result.batchDispatchRetimingLoaded, true);
  assert.equal(d.controller.steps[3].result.mountedFilesVerified, 141);
  assert.deepEqual(d.before.generations.slice(0, 2), d.after.generations.slice(0, 2));
  assert.deepEqual(d.before.monitor, d.after.monitor);
  assert.deepEqual(d.before.budget.database, d.after.budget.database);
  assert.deepEqual(d.before.budget.owners, d.after.budget.owners);
  assert.equal(d.before.preservedDigest, d.after.preservedDigest);
  assert.equal(d.before.budget.recoveredRequests, d.after.budget.recoveredRequests);
  assert.ok(d.after.budget.requests >= d.before.budget.requests);
  assert.equal(Object.keys(d.auditHashes).length, 9);
  assert.ok(Object.values(d.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
  assert.equal(d.scope.preparedPointerChanged, false);
  assert.equal(d.scope.pinnedHostObserverBindingChanged, false);
  assert.equal(d.scope.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.observation.execSessionId, prep.observationExecSessionId);
  assert.equal(d.observation.completed, false);
  assert.equal(d.observation.confirmedLive, true);
  assert.equal(d.observation.plannedSamples, 31);
  assert.equal(d.observation.plannedSeconds, 900);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.fullLiveReady, false);
}
if (batchDispatchObservation) {
  const d = batchDispatchObservation, prep = opsPreparation.batchDispatchPreparation;
  assert.equal(d.status, 'BATCH_DISPATCH_OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(d.server, server.host);
  assert.equal(d.activationEvidence, prep.activationEvidence);
  assert.equal(d.execSessionId, prep.observationExecSessionId);
  assert.equal(d.execTransport.exitCode, prep.observationExitCode);
  assert.equal(d.execTransport.serverObservationRestarted, false);
  assert.equal(d.serverCompletionExitCode, 0);
  assert.equal(prep.observationServerCompletionExitCode, 0);
  assert.equal(prep.observationStatus, 'COMPLETED_NOT_ACCEPTED');
  assert.equal(prep.observationCompleted, true);
  assert.equal(d.completed, true);
  assert.equal(d.summary.samples, 31);
  // Absolute scheduled samples can differ by sub-millisecond wall-clock jitter.
  assert.ok(d.summary.durationSeconds >= 899.999);
  assert.equal(d.summary.frameDiagnostics.length, 31);
  assert.equal(d.summary.capturedRecordCountsAreNotTotalAttempts, true);
  for (const [key, count] of Object.entries(d.summary.checks)) {
    assert.equal(d.summary.frameDiagnostics.filter(row => row.checks[key]).length, count);
  }
  assert.equal(d.summary.inputReadySamples,
    d.summary.frameDiagnostics.filter(row => Object.values(row.checks).every(Boolean)).length);
  assert.equal(d.summary.captureReadySamples, d.summary.checks.captureReady);
  const records = d.summary.distinctCapturedAttemptRecordsWithinWindow, counts = {};
  assert.equal(new Set(records.map(row => `${row.symbol}:${row.attemptedAt}`)).size, records.length);
  assert.ok(records.every(row => row.attemptedAt >= d.summary.startAt * 1000 && row.attemptedAt <= d.summary.endAt * 1000));
  for (const row of records) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  assert.deepEqual(counts, d.summary.outcomesOfDistinctCapturedRecordsWithinWindow);
  assert.equal(d.completion.sampleIndex.length, 31);
  assert.ok(d.completion.sampleIndex.every((v, i) => v.file === `${String(i).padStart(2, '0')}.json` && /^[a-f0-9]{64}$/.test(v.sha256)));
  assert.match(d.completedSha256, /^[a-f0-9]{64}$/);
  assert.equal(d.completion.exitCode, 0);
  assert.equal(d.completion.realOrdersAllowed, false);
  assert.deepEqual(d.completion.before.generations, d.completion.after.generations);
  assert.deepEqual(d.completion.after.generations, d.current.generations);
  assert.deepEqual(d.current.generations, batchDispatchDeployment.after.generations);
  assert.deepEqual(d.completion.before.monitor, d.current.monitor);
  assert.deepEqual(d.completion.before.budget.database, d.current.budget.database);
  assert.deepEqual(d.completion.before.budget.owners, d.current.budget.owners);
  assert.equal(d.completion.before.preservedDigest, d.current.preservedDigest);
  assert.equal(d.completion.before.budget.recoveredRequests, d.current.budget.recoveredRequests);
  assert.ok(d.current.budget.requests >= d.completion.before.budget.requests);
  assert.equal(d.conclusions.sustainedSchedulingAccepted, false);
  assert.equal(d.conclusions.firstFailedConditionIsNotExclusiveRootCause, true);
  assert.equal(d.conclusions.wholeGoalCompleted, false);
  assert.equal(d.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.ok(d.storage.finalRawBytes < d.storage.rawMaximumBytes);
  assert.equal(d.storage.rawRetentionDays, 7);
  assert.equal(d.storage.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.storage.localHistoricalEvidenceUploaded, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.newEntriesBlocked, true);
}
const advisoryReasonAcceptance = opsPreparation?.advisoryReasonPreparation?.serverAcceptanceEvidence
  ? await read(opsPreparation.advisoryReasonPreparation.serverAcceptanceEvidence) : null;
const advisoryReasonDeployment = opsPreparation?.advisoryReasonPreparation?.activationEvidence
  ? await read(opsPreparation.advisoryReasonPreparation.activationEvidence) : null;
const advisoryReasonObservation = opsPreparation?.advisoryReasonPreparation?.observationEvidence
  ? await read(opsPreparation.advisoryReasonPreparation.observationEvidence) : null;
if (opsPreparation?.advisoryReasonPreparation) {
  const state = opsPreparation.advisoryReasonPreparation, d = await read(state.evidence);
  assert.equal(state.status, advisoryReasonObservation ? 'SHADOW_OBSERVATION_COMPLETED_NOT_ACCEPTED' : advisoryReasonDeployment ? 'SHADOW_ACTIVATED_OBSERVATION_RUNNING' : advisoryReasonAcceptance ? 'SERVER_ISOLATED_ACCEPTED_NOT_ACTIVATED' : 'LOCAL_TESTED_NOT_PACKAGED_OR_DEPLOYED');
  assert.equal(d.status, 'LOCAL_ADVISORY_REASON_DIAGNOSTICS_TESTED_NOT_PACKAGED');
  assert.equal(d.implementation.sameBooleanPredicateAndCheckOrder, true);
  assert.equal(d.implementation.sameSharedTransactionNoAdditionalQuery, true);
  assert.equal(d.implementation.noAdditionalExchangeRequests, true);
  assert.equal(d.implementation.rawExceptionOrPathExported, false);
  assert.equal(d.implementation.feeDiagnosticRowsMaximum, 10);
  assert.equal(d.implementation.reasonAllowlist.length, 9);
  assert.equal(d.implementation.headroomUnchanged, 265);
  assert.equal(d.validation.targeted.pass, 128);
  assert.equal(d.validation.regression.fail, 0);
  assert.equal(d.validation.offline.fail, 0);
  assert.equal(d.productionScope.realOrdersAllowed, false);
  assert.equal(d.productionScope.serverActivated, false);
  assert.equal(state.productionDeferralCauseConfirmed, false);
}
if (advisoryReasonAcceptance) {
  const d = advisoryReasonAcceptance, prep = opsPreparation.advisoryReasonPreparation;
  assert.equal(d.status, 'SERVER_ISOLATED_ADVISORY_REASON_ACCEPTED_NOT_ACTIVATED');
  assert.equal(d.server, server.host);
  assert.equal(d.release.releaseId, prep.releaseId);
  assert.equal(d.release.fileCount, 141);
  assert.equal(d.release.delta.changed.length, 13);
  assert.deepEqual(d.release.delta.added, ['agents/orion-live/s1-execution/read-eligibility.mjs']);
  assert.deepEqual(d.release.delta.removed, []);
  if (!opsPreparation.batchDispatchPreparation) {
    assert.equal(opsPreparation.latestLocalPreparationReleaseId, prep.releaseId);
    assert.equal(opsPreparation.latestLocalPreparationDeployed, advisoryReasonDeployment !== null);
    assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, advisoryReasonDeployment === null);
  }
  assert.equal(prep.serverStaged, true);
  assert.equal(prep.serverActivated, advisoryReasonDeployment !== null);
  const run = d.serverAcceptance;
  assert.deepEqual(run.counts, { tests: 643, pass: 637, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(run.container.status, 'exited');
  assert.equal(run.container.exitCode, 0);
  assert.equal(run.container.oom, false);
  assert.equal(run.container.restartCount, 0);
  assert.equal(run.container.network, 'none');
  assert.equal(run.container.readonly, true);
  assert.equal(run.container.user, '993:993');
  assert.equal(run.container.mounts.length, 1);
  assert.equal(run.source.verifiedFiles, 141);
  assert.equal(run.source.manifestSha256, d.release.manifestSha256);
  assert.deepEqual(run.before.generations, run.after.generations);
  assert.deepEqual(run.before.monitor, run.after.monitor);
  assert.deepEqual(run.before.budget.database, run.after.budget.database);
  assert.deepEqual(run.before.budget.owners, run.after.budget.owners);
  assert.equal(run.before.preservedDigest, run.after.preservedDigest);
  assert.equal(run.before.budget.recoveredRequests, run.after.budget.recoveredRequests);
  assert.ok(run.after.budget.requests >= run.before.budget.requests);
  assert.equal(run.verificationFailurePreserved.onlyFinalLineEndingsRemoved, true);
  assert.equal(run.verificationFailurePreserved.expectedBytes - run.verificationFailurePreserved.actualBytes, 1);
  assert.equal(run.verificationFailurePreserved.testRerun, false);
  assert.equal(Object.keys(d.auditHashes).length, 6);
  assert.ok(Object.values(d.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
  assert.equal(d.pinnedHostObserverBindingChanged, false);
  assert.equal(d.serverActivated, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
}
if (advisoryReasonDeployment) {
  const d = advisoryReasonDeployment, prep = opsPreparation.advisoryReasonPreparation;
  assert.equal(d.status, 'SHADOW_ADVISORY_REASON_ACTIVATED_OBSERVATION_RUNNING');
  assert.equal(d.server, server.host);
  assert.equal(d.shadowRelease.id, prep.releaseId);
  assert.equal(d.controller.sha256, prep.controllerSha256);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.deepEqual(d.controller.steps.map(s => s.phase), ['STOP_SHADOW', 'SWITCH_SHADOW', 'START_SHADOW', 'VERIFY_RUNTIME']);
  assert.ok(d.controller.steps.every(s => s.artifact === d.controller.sha256 && s.realOrdersAllowed === false));
  const stop = d.controller.steps[0].result, start = d.controller.steps[2].result.generation;
  assert.equal(stop.exitCode, 0);
  assert.ok(Date.parse(start.startedAt) - Date.parse(stop.generation.finishedAt) >= 65000);
  assert.equal(start.restarts, 0);
  assert.deepEqual(start, d.after.generations[2]);
  assert.equal(d.controller.steps[3].result.advisoryReasonDiagnosticsLoaded, true);
  assert.equal(d.controller.steps[3].result.mountedFilesVerified, 141);
  assert.deepEqual(d.before.generations.slice(0, 2), d.after.generations.slice(0, 2));
  assert.deepEqual(d.before.monitor, d.after.monitor);
  assert.deepEqual(d.before.budget.database, d.after.budget.database);
  assert.deepEqual(d.before.budget.owners, d.after.budget.owners);
  assert.equal(d.before.preservedDigest, d.after.preservedDigest);
  assert.equal(d.before.budget.recoveredRequests, d.after.budget.recoveredRequests);
  assert.ok(d.after.budget.requests >= d.before.budget.requests);
  assert.equal(Object.keys(d.auditHashes).length, 9);
  assert.ok(Object.values(d.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
  assert.equal(d.scope.preparedPointerChanged, false);
  assert.equal(d.scope.pinnedHostObserverBindingChanged, false);
  assert.equal(d.scope.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.observation.execSessionId, prep.observationExecSessionId);
  assert.equal(d.observation.completed, false);
  assert.equal(d.observation.confirmedLive, true);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.fullLiveReady, false);
}
if (advisoryReasonObservation) {
  const d = advisoryReasonObservation, state = opsPreparation.advisoryReasonPreparation;
  assert.equal(d.status, 'ADVISORY_REASON_OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(d.server, server.host);
  assert.equal(d.activationEvidence, state.activationEvidence);
  assert.equal(state.observationStatus, 'COMPLETED_NOT_ACCEPTED');
  assert.equal(state.observationCompleted, true);
  assert.equal(state.observationExitCode, 255);
  assert.equal(state.observationServerCompletionExitCode, 0);
  assert.equal(state.schedulingAccepted, false);
  assert.equal(d.execSessionId, state.observationExecSessionId);
  assert.equal(d.execTransport.exitCode, state.observationExitCode);
  assert.equal(d.execTransport.terminatedAfterVerifiedServerCompletion, true);
  assert.equal(d.execTransport.serverObservationRestarted, false);
  assert.equal(d.serverCompletionExitCode, 0);
  assert.equal(d.completed, true);
  assert.equal(d.summary.samples, 31);
  assert.ok(d.summary.durationSeconds >= 900);
  assert.equal(d.summary.sampleChecks.length, 31);
  assert.equal(d.summary.capturedRecordCountsAreNotTotalAttempts, true);
  for (const [key, count] of Object.entries(d.summary.checks)) {
    assert.equal(d.summary.sampleChecks.filter(row => row.checks[key]).length, count);
  }
  assert.equal(d.summary.inputReadySamples,
    d.summary.sampleChecks.filter(row => Object.values(row.checks).every(Boolean)).length);
  assert.equal(d.summary.captureReadySamples, d.summary.checks.captureReady);
  const records = d.summary.distinctCapturedAttemptRecordsWithinWindow;
  assert.equal(new Set(records.map(row => `${row.symbol}:${row.attemptedAt}`)).size, records.length);
  assert.ok(records.every(row => row.attemptedAt >= d.summary.startAt * 1000 && row.attemptedAt <= d.summary.endAt * 1000));
  const counts = {};
  for (const row of records) counts[row.outcome] = (counts[row.outcome] || 0) + 1;
  assert.deepEqual(counts, d.summary.outcomesOfDistinctCapturedRecordsWithinWindow);
  assert.equal(d.completion.sampleIndex.length, 31);
  assert.ok(d.completion.sampleIndex.every((v, i) => v.file === `${String(i).padStart(2, '0')}.json` && /^[a-f0-9]{64}$/.test(v.sha256)));
  assert.match(d.completedSha256, /^[a-f0-9]{64}$/);
  assert.equal(d.completion.exitCode, 0);
  assert.equal(d.completion.realOrdersAllowed, false);
  assert.deepEqual(d.completion.before.generations, d.completion.after.generations);
  assert.deepEqual(d.completion.after.generations, d.current.generations);
  assert.deepEqual(d.completion.before.monitor, d.current.monitor);
  assert.deepEqual(d.completion.before.budget.database, d.current.budget.database);
  assert.deepEqual(d.completion.before.budget.owners, d.current.budget.owners);
  assert.equal(d.completion.before.preservedDigest, d.current.preservedDigest);
  assert.equal(d.completion.before.budget.recoveredRequests, d.current.budget.recoveredRequests);
  assert.ok(d.current.budget.requests >= d.completion.before.budget.requests);
  assert.equal(d.conclusions.sustainedSchedulingAccepted, false);
  assert.equal(d.conclusions.firstFailedConditionIsNotExclusiveRootCause, true);
  assert.equal(d.conclusions.allDeferralsProvenLocalWeight, false);
  assert.equal(d.conclusions.wholeGoalCompleted, false);
  assert.equal(d.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.ok(d.storage.finalRawBytes < d.storage.rawMaximumBytes);
  assert.equal(d.storage.rawRetentionDays, 7);
  assert.equal(d.storage.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.storage.localHistoricalEvidenceUploaded, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.newEntriesBlocked, true);
}
if (opsPreparation?.readSchedulingModel) {
  const model = opsPreparation.readSchedulingModel, d = await read(model.evidence);
  assert.equal(d.status, 'LOCAL_CAPACITY_MODEL_REJECTS_NAIVE_PRIORITY_NOT_DEPLOYED');
  assert.equal(model.status, 'LOCAL_DIAGNOSTIC_REJECTED_NAIVE_PRIORITY');
  assert.equal(d.results.length, 16);
  assert.equal(d.modelScope.liveReadinessProven, false);
  assert.ok(d.results.every(r => r.maximumSpent <= 900 && r.shadowRefusals > 0));
  assert.ok(d.results.filter(r => r.options.historyYieldsToFees).every(r => r.historyFresh < r.samples));
  assert.equal(d.findings.observedContinuousFeeStalenessNotReproduced, true);
  assert.equal(d.findings.productionWeightConstantsChanged, false);
  assert.equal(d.validation.targeted.pass, 101);
  assert.equal(d.validation.targeted.fail, 0);
  assert.equal(d.serverActivated, false);
  assert.equal(model.schedulingAccepted, false);
  assert.equal(d.realOrdersAllowed, false);
}
if (opsPreparation?.observerClockPreparation) {
  const preparation = opsPreparation.observerClockPreparation, d = await read(preparation.evidence);
  assert.equal(preparation.status, advisoryReasonAcceptance ? 'SERVER_ISOLATED_ACCEPTED_NOT_BOUND_TO_HOST' : 'LOCAL_TESTED_NOT_PACKAGED_OR_DEPLOYED');
  if (advisoryReasonAcceptance) {
    assert.equal(preparation.packagedReleaseId, advisoryReasonAcceptance.release.releaseId);
    assert.equal(preparation.pinnedHostObserverBindingChanged, false);
  }
  assert.equal(d.status, 'LOCAL_OBSERVER_CLOCK_FIX_TESTED_NOT_PACKAGED_OR_DEPLOYED');
  assert.equal(d.reproduction.beforeFixExitCode, 1);
  assert.equal(d.reproduction.beforeFixError, 'ADMISSION_OBSERVER_CLOCK_OR_BLOCKS');
  assert.equal(d.productionFailureCauseConfirmed, false);
  assert.equal(d.implementation.dynamicObservationTimeSampledAfterSqlStateRead, true);
  assert.equal(d.implementation.explicitAsOfTimeRemainsFixed, true);
  assert.equal(d.implementation.clockRollbackStillRejected, true);
  assert.equal(d.implementation.actualFutureStateStillRejected, true);
  assert.equal(d.implementation.timeNeverAdvancedFromStoredLastAt, true);
  assert.equal(d.implementation.queryOnlyTransactionPreserved, true);
  assert.equal(d.validation.targeted.pass, 84);
  assert.equal(d.validation.regression.fail, 0);
  assert.equal(d.validation.offline.fail, 0);
  assert.equal(d.productionScope.pinnedControllerOrObserverOverwritten, false);
  assert.equal(d.productionScope.realOrdersAllowed, false);
  assert.equal(preparation.serverActivated, false);
}
const feeDeployment = opsPreparation?.feeLanePreparation?.activationEvidence
  ? await read(opsPreparation.feeLanePreparation.activationEvidence) : null;
const feeObservation = opsPreparation?.feeLanePreparation?.observationEvidence
  ? await read(opsPreparation.feeLanePreparation.observationEvidence) : null;
const feeTelemetryDeployment = opsPreparation?.feeTelemetryPreparation?.activationEvidence
  ? await read(opsPreparation.feeTelemetryPreparation.activationEvidence) : null;
const feeTelemetryObservation = opsPreparation?.feeTelemetryPreparation?.observationEvidence
  ? await read(opsPreparation.feeTelemetryPreparation.observationEvidence) : null;
const feeEligibilityDeployment = opsPreparation?.feeEligibilityPreparation?.activationEvidence
  ? await read(opsPreparation.feeEligibilityPreparation.activationEvidence) : null;
const feeEligibilityObservation = opsPreparation?.feeEligibilityPreparation?.observationEvidence
  ? await read(opsPreparation.feeEligibilityPreparation.observationEvidence) : null;
if (opsPreparation?.feeEligibilityPreparation) {
  const pending = opsPreparation.feeEligibilityPreparation, d = await read(pending.evidence);
  const accepted = pending.serverAcceptanceEvidence ? await read(pending.serverAcceptanceEvidence) : null;
  assert.equal(d.status, 'LOCAL_FEE_ELIGIBILITY_PREPARED_NOT_SERVER_STAGED');
  assert.equal(pending.status, feeEligibilityObservation ? 'SHADOW_OBSERVATION_COMPLETED_NOT_ACCEPTED' : feeEligibilityDeployment ? 'SHADOW_ACTIVATED_OBSERVATION_RUNNING' : accepted ? 'SERVER_ISOLATED_ACCEPTED_NOT_ACTIVATED' : 'LOCAL_TESTED_NOT_SERVER_STAGED');
  assert.equal(d.release.releaseId, pending.releaseId);
  if (!advisoryReasonAcceptance) {
    assert.equal(opsPreparation.latestLocalPreparationReleaseId, pending.releaseId);
    assert.equal(opsPreparation.latestLocalPreparationDeployed, feeEligibilityDeployment !== null);
    assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, accepted !== null && feeEligibilityDeployment === null);
  }
  assert.equal(pending.serverStaged, accepted !== null);
  assert.equal(pending.serverActivated, feeEligibilityDeployment !== null);
  assert.equal(d.release.fileCount, 140);
  assert.equal(d.implementation.preDispatchEligibilityBeforeSlotConsumption, true);
  assert.equal(d.implementation.maximumDispatchAttemptsPer65000Ms, 3);
  assert.equal(d.implementation.afterLoadFeesInvocationEveryOutcomeConsumesSlot, true);
  assert.equal(d.implementation.advisoryHeadroomUnchanged, 265);
  assert.equal(d.implementation.hardAccountReaderReserveUnchanged, 160);
  assert.equal(d.implementation.freshnessMsUnchanged, 300000);
  assert.equal(d.implementation.quotaUniverseAccountCadenceRiskOrTradePermissionsChanged, false);
  assert.equal(d.validation.targeted.pass, 25);
  assert.equal(d.validation.regression.fail, 0);
  assert.equal(d.validation.offline.fail, 0);
  assert.equal(d.sourceDelta.changed.length, 5);
  assert.deepEqual(d.sourceDelta.added, []);
  assert.deepEqual(d.sourceDelta.removed, []);
  assert.equal(d.productionScope.serverActivated, false);
  assert.equal(d.productionScope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.realOrdersAllowed, false);
  if (accepted) {
    assert.equal(accepted.status, 'SERVER_ISOLATED_FEE_ELIGIBILITY_ACCEPTED_NOT_ACTIVATED');
    assert.equal(accepted.server, server.host);
    assert.equal(accepted.localPreparationEvidence, pending.evidence);
    assert.equal(accepted.release.releaseId, pending.releaseId);
    assert.equal(accepted.release.archiveSha256, d.release.archiveSha256);
    assert.equal(accepted.release.manifestSha256, d.release.manifestSha256);
    assert.equal(accepted.release.verifiedFiles, 140);
    assert.equal(accepted.serverActivated, false);
    assert.equal(accepted.realOrdersAllowed, false);
    const run = accepted.serverAcceptance;
    assert.deepEqual(run.counts, { tests: 632, pass: 626, fail: 0, cancelled: 0, skipped: 6 });
    assert.equal(run.container.exitCode, 0);
    assert.equal(run.container.oom, false);
    assert.equal(run.container.restartCount, 0);
    assert.equal(run.networkMode, 'none');
    assert.equal(run.uid, '993:993');
    assert.equal(run.readonlyRoot, true);
    assert.equal(run.productionCredentialsMounted, false);
    assert.deepEqual(run.before.generations, run.after.generations);
    assert.deepEqual(run.before.monitor, run.after.monitor);
    assert.deepEqual(run.before.budget.database, run.after.budget.database);
    assert.deepEqual(run.before.budget.owners, run.after.budget.owners);
    assert.equal(run.before.preservedDigest, run.after.preservedDigest);
    assert.ok(run.after.budget.requests >= run.before.budget.requests);
    assert.equal(run.before.budget.recoveredRequests, run.after.budget.recoveredRequests);
    assert.equal(run.preparedPointerChanged, false);
    assert.equal(run.activePointersChanged, false);
    assert.equal(accepted.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
    assert.equal(Object.keys(accepted.auditHashes).length, 5);
    assert.ok(Object.values(accepted.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
    assert.equal(accepted.sourceDeltaFromActiveShadow.changed.length, 5);
    assert.deepEqual(accepted.sourceDeltaFromActiveShadow.added, []);
    assert.deepEqual(accepted.sourceDeltaFromActiveShadow.removed, []);
    assert.equal(accepted.postTestVerificationFailure.error, 'SHARED_BUDGET_QUERY_CHILD_NONZERO');
    assert.equal(accepted.postTestVerificationFailure.cause, 'UNDETERMINED');
    assert.equal(accepted.postTestVerificationFailure.testRerun, false);
    assert.equal(accepted.postTestVerificationFailure.budgetReset, false);
    assert.equal(accepted.postTestVerificationFailure.subsequentReadOnlyVerificationPassed, true);
    assert.match(accepted.postTestVerificationFailure.sha256, /^[a-f0-9]{64}$/);
  }
}
if (feeEligibilityObservation) {
  const d = feeEligibilityObservation, state = opsPreparation.feeEligibilityPreparation;
  assert.equal(d.status, 'FEE_ELIGIBILITY_OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(state.observationStatus, 'COMPLETED_NOT_ACCEPTED');
  assert.equal(state.observationCompleted, true);
  assert.equal(state.observationExitCode, 0);
  assert.equal(d.execSessionId, state.observationExecSessionId);
  assert.equal(d.exitCode, 0);
  assert.equal(d.completed, true);
  assert.equal(d.summary.samples, 31);
  assert.ok(d.summary.durationSeconds >= 900);
  assert.equal(d.summary.checks.feesFresh, 0);
  assert.equal(d.summary.checks.accountFresh, 28);
  assert.equal(d.summary.inputReadySamples, 0);
  assert.equal(d.summary.captureReadySamples, 31);
  assert.equal(d.summary.capturedRecordCountsAreNotTotalAttempts, true);
  assert.equal(d.summary.sampleChecks.length, 31);
  for (const [key, count] of Object.entries(d.summary.checks)) {
    assert.equal(d.summary.sampleChecks.filter(row => row.checks[key]).length, count);
  }
  assert.equal(d.completion.sampleIndex.length, 31);
  assert.ok(d.completion.sampleIndex.every((v, i) => v.file === `${String(i).padStart(2, '0')}.json` && /^[a-f0-9]{64}$/.test(v.sha256)));
  assert.match(d.completedSha256, /^[a-f0-9]{64}$/);
  assert.equal(d.completion.exitCode, 0);
  assert.deepEqual(d.completion.before.generations, d.completion.after.generations);
  assert.deepEqual(d.completion.after.generations, d.current.generations);
  assert.deepEqual(d.completion.before.monitor, d.current.monitor);
  assert.deepEqual(d.completion.before.budget.database, d.current.budget.database);
  assert.deepEqual(d.completion.before.budget.owners, d.current.budget.owners);
  assert.equal(d.completion.before.preservedDigest, d.current.preservedDigest);
  assert.equal(d.completion.before.budget.recoveredRequests, d.current.budget.recoveredRequests);
  assert.ok(d.current.budget.requests >= d.completion.before.budget.requests);
  assert.equal(d.conclusions.windowShadowRefusalCountDelta, 3);
  assert.equal(d.conclusions.sustainedSchedulingAccepted, false);
  assert.equal(d.conclusions.allDeferralsProvenWeightRatherThanConcurrencyOrStoreFailure, false);
  assert.equal(d.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.ok(d.storage.finalRawBytes < d.storage.rawMaximumBytes);
  assert.equal(d.storage.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.storage.localHistoricalEvidenceUploaded, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.newEntriesBlocked, true);
}
if (feeEligibilityDeployment) {
  const d = feeEligibilityDeployment;
  assert.equal(d.status, 'SHADOW_FEE_ELIGIBILITY_ACTIVATED_OBSERVATION_RUNNING');
  assert.equal(d.server, server.host);
  assert.equal(d.shadowRelease.id, opsPreparation.feeEligibilityPreparation.releaseId);
  assert.equal(d.controller.sha256, opsPreparation.feeEligibilityPreparation.controllerSha256);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.deepEqual(d.controller.steps.map(s => s.phase), ['STOP_SHADOW', 'SWITCH_SHADOW', 'START_SHADOW', 'VERIFY_RUNTIME']);
  assert.ok(d.controller.steps.every(s => s.artifact === d.controller.sha256 && s.realOrdersAllowed === false));
  const stopped = d.controller.steps[0].result.generation, started = d.controller.steps[2].result.generation;
  assert.equal(d.controller.steps[0].result.exitCode, 0);
  assert.equal(stopped.id, started.id);
  assert.ok(Date.parse(started.startedAt) - Date.parse(stopped.finishedAt) >= 65000);
  assert.equal(started.restarts, 0);
  assert.deepEqual(started, d.after.generations[2]);
  assert.equal(d.controller.steps[3].result.mountedFilesVerified, 140);
  assert.equal(d.controller.steps[3].result.pendingFeeEligibilityLoaded, true);
  assert.deepEqual(d.before.generations.slice(0, 2), d.after.generations.slice(0, 2));
  assert.deepEqual(d.before.monitor, d.after.monitor);
  assert.deepEqual(d.before.budget.database, d.after.budget.database);
  assert.deepEqual(d.before.budget.owners, d.after.budget.owners);
  assert.equal(d.before.preservedDigest, d.after.preservedDigest);
  assert.equal(d.before.budget.recoveredRequests, d.after.budget.recoveredRequests);
  assert.ok(d.after.budget.requests >= d.before.budget.requests);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.scope.preparedPointerChanged, false);
  assert.equal(d.scope.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.scope.localHistoricalEvidenceUploaded, false);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.fullLiveReady, false);
  assert.equal(d.sustainedSchedulingAccepted, false);
  assert.equal(d.observation.execSessionId, opsPreparation.feeEligibilityPreparation.observationExecSessionId);
  assert.equal(d.observation.completed, false);
}
if (opsPreparation?.feeTelemetryPreparation) {
  const pending = opsPreparation.feeTelemetryPreparation;
  const report = await read(pending.evidence);
  const accepted = pending.serverAcceptanceEvidence ? await read(pending.serverAcceptanceEvidence) : null;
  assert.equal(pending.status, feeTelemetryObservation ? 'SHADOW_TELEMETRY_OBSERVATION_COMPLETED_NOT_ACCEPTED' : feeTelemetryDeployment ? 'SHADOW_TELEMETRY_ACTIVATED_DIAGNOSIS_PENDING' : accepted ? 'SERVER_ISOLATED_ACCEPTED_NOT_ACTIVATED' : 'LOCAL_TESTED_NOT_SERVER_STAGED');
  assert.equal(report.status, 'LOCAL_FEE_TELEMETRY_PREPARED_NOT_SERVER_STAGED');
  assert.equal(report.release.releaseId, pending.releaseId);
  if (!opsPreparation.feeEligibilityPreparation) assert.equal(opsPreparation.latestLocalPreparationReleaseId, pending.releaseId);
  if (!opsPreparation.feeEligibilityPreparation) assert.equal(opsPreparation.latestLocalPreparationDeployed, feeTelemetryDeployment !== null);
  assert.equal(pending.serverStaged, accepted !== null);
  if (!opsPreparation.feeEligibilityPreparation) assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, accepted !== null && feeTelemetryDeployment === null);
  assert.equal(pending.serverActivated, feeTelemetryDeployment !== null);
  assert.equal(report.productionScope.serverActivated, false);
  assert.equal(report.productionScope.observationSourceChanged, false);
  assert.equal(report.productionScope.realOrdersAllowed, false);
  assert.equal(report.implementation.maximumSymbolRows, 10);
  assert.equal(report.implementation.requestOrFreshnessPolicyChanged, false);
  assert.equal(report.validation.regression.fail, 0);
  assert.equal(report.validation.offline.fail, 0);
  if (accepted) {
    assert.equal(accepted.status, 'SERVER_ISOLATED_FEE_TELEMETRY_ACCEPTED_NOT_ACTIVATED');
    assert.equal(accepted.server, server.host);
    assert.equal(accepted.localPreparationEvidence, pending.evidence);
    assert.equal(accepted.release.releaseId, pending.releaseId);
    assert.equal(accepted.release.archiveSha256, report.release.archiveSha256);
    assert.equal(accepted.release.manifestSha256, report.release.manifestSha256);
    assert.equal(accepted.release.verifiedFiles, 140);
    assert.equal(accepted.serverActivated, false);
    assert.equal(accepted.realOrdersAllowed, false);
    const run = accepted.serverAcceptance;
    assert.deepEqual(run.counts, { tests: 627, pass: 621, fail: 0, cancelled: 0, skipped: 6 });
    assert.equal(run.container.exitCode, 0);
    assert.equal(run.container.oom, false);
    assert.equal(run.container.restartCount, 0);
    assert.equal(run.networkMode, 'none');
    assert.equal(run.uid, '993:993');
    assert.equal(run.readonlyRoot, true);
    assert.equal(run.productionCredentialsMounted, false);
    assert.deepEqual(run.before.generations, run.after.generations);
    assert.deepEqual(run.before.monitor, run.after.monitor);
    assert.deepEqual(run.before.budget.database, run.after.budget.database);
    assert.deepEqual(run.before.budget.owners, run.after.budget.owners);
    assert.equal(run.before.preservedDigest, run.after.preservedDigest);
    assert.ok(run.after.budget.requests >= run.before.budget.requests);
    assert.equal(run.before.budget.recoveredRequests, run.after.budget.recoveredRequests);
    assert.equal(run.preparedPointerChanged, false);
    assert.equal(run.activePointersChanged, false);
    assert.equal(accepted.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
    assert.equal(Object.keys(accepted.auditHashes).length, 5);
    assert.ok(Object.values(accepted.auditHashes).every(s => /^[a-f0-9]{64}$/.test(s)));
    assert.equal(accepted.sourceDeltaFromActiveShadow.changed.length, 4);
    assert.deepEqual(accepted.sourceDeltaFromActiveShadow.added, []);
    assert.deepEqual(accepted.sourceDeltaFromActiveShadow.removed, []);
  }
}
if (feeTelemetryObservation) {
  const d = feeTelemetryObservation;
  assert.equal(d.status, 'FEE_TELEMETRY_OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(d.execSessionId, opsPreparation.feeTelemetryPreparation.observationExecSessionId);
  assert.equal(d.exitCode, 0);
  assert.equal(d.completed, true);
  assert.equal(d.summary.samples, 21);
  assert.ok(d.summary.durationSeconds >= 300);
  assert.equal(d.summary.checks.feesFresh, 0);
  assert.equal(d.summary.inputReadySamples, 0);
  assert.equal(d.summary.captureReadySamples, 21);
  assert.deepEqual(d.summary.outcomesWithinWindow, { PROBE_BACKGROUND_READ_DEFERRED: 10, SUCCESS: 3 });
  assert.equal(d.completion.sampleIndex.length, 21);
  assert.ok(d.completion.sampleIndex.every((v, i) => v.file === `${String(i).padStart(2, '0')}.json` && /^[a-f0-9]{64}$/.test(v.sha256)));
  assert.deepEqual(d.completion.before.generations, d.completion.after.generations);
  assert.deepEqual(d.completion.after.generations, d.current.generations);
  assert.deepEqual(d.completion.before.monitor, d.current.monitor);
  assert.deepEqual(d.completion.before.budget.database, d.current.budget.database);
  assert.deepEqual(d.completion.before.budget.owners, d.current.budget.owners);
  assert.equal(d.completion.before.budget.recoveredRequests, d.current.budget.recoveredRequests);
  assert.ok(d.current.budget.requests >= d.completion.before.budget.requests);
  assert.equal(d.conclusions.sustainedSchedulingAccepted, false);
  assert.equal(d.conclusions.allDeferralsProvenWeightRatherThanConcurrencyOrStoreFailure, false);
  assert.equal(d.realOrdersAllowed, false);
}
if (feeTelemetryDeployment) {
  const d = feeTelemetryDeployment;
  assert.equal(d.status, 'SHADOW_FEE_TELEMETRY_ACTIVATED_DIAGNOSIS_PENDING');
  assert.equal(d.server, server.host);
  assert.equal(d.shadowRelease.id, opsPreparation.feeTelemetryPreparation.releaseId);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.equal(d.controller.sha256, opsPreparation.feeTelemetryPreparation.controllerSha256);
  assert.deepEqual(d.controller.steps.map(s => s.phase), ['STOP_SHADOW', 'SWITCH_SHADOW', 'START_SHADOW', 'VERIFY_RUNTIME']);
  assert.ok(d.controller.steps.every(s => s.artifact === d.controller.sha256 && s.realOrdersAllowed === false));
  const stopped = d.controller.steps[0].result.generation;
  const started = d.controller.steps[2].result.generation;
  assert.equal(d.controller.steps[0].result.exitCode, 0);
  assert.equal(stopped.id, started.id);
  assert.ok(Date.parse(started.startedAt) - Date.parse(stopped.finishedAt) >= 65000);
  assert.equal(started.restarts, 0);
  assert.equal(d.controller.steps[3].result.mountedFilesVerified, 140);
  assert.equal(d.controller.steps[3].result.feeResultTelemetryLoaded, true);
  assert.deepEqual(d.before.generations.slice(0, 2), d.after.generations.slice(0, 2));
  assert.deepEqual(started, d.after.generations[2]);
  assert.deepEqual(d.before.monitor, d.after.monitor);
  assert.deepEqual(d.before.budget.database, d.after.budget.database);
  assert.deepEqual(d.before.budget.owners, d.after.budget.owners);
  assert.equal(d.before.preservedDigest, d.after.preservedDigest);
  assert.ok(d.after.budget.requests >= d.before.budget.requests);
  assert.equal(d.before.budget.recoveredRequests, d.after.budget.recoveredRequests);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.fullLiveReady, false);
  assert.equal(d.sustainedSchedulingAccepted, false);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.scope.rawRetentionDays, 7);
  assert.equal(d.scope.preparedPointerChanged, false);
  assert.equal(d.scope.financialOrPinnedEvidenceDeleted, false);
  assert.equal(d.scope.localHistoricalEvidenceUploaded, false);
  assert.equal(d.validation.controllerTestsPassed, 14);
  assert.equal(d.validation.componentTestsPassed, 110);
  assert.equal(d.runtime.feeRefreshDiagnostics.schemaVersion, 1);
  assert.equal(d.runtime.feeRefreshDiagnostics.processLocal, true);
  assert.equal(d.runtime.feeRefreshDiagnostics.symbols.length, 10);
}
if (opsPreparation?.feeLanePreparation) {
  const pending = opsPreparation.feeLanePreparation;
  const report = await read(pending.evidence);
  const accepted = pending.serverAcceptanceEvidence ? await read(pending.serverAcceptanceEvidence) : null;
  assert.equal(pending.status, feeObservation ? 'SHADOW_ACTIVATED_OBSERVATION_COMPLETED_NOT_ACCEPTED' : feeDeployment ? 'SHADOW_ACTIVATED_OBSERVATION_RUNNING' : accepted ? 'SERVER_ISOLATED_ACCEPTED_NOT_ACTIVATED' : 'LOCAL_TESTED_NOT_SERVER_STAGED');
  assert.equal(report.status, 'LOCAL_FEE_LANE_REPAIR_TESTED_NOT_SERVER_STAGED');
  assert.equal(pending.releaseId, report.release.releaseId);
  if (!opsPreparation.feeTelemetryPreparation) assert.equal(opsPreparation.latestLocalPreparationReleaseId, pending.releaseId);
  if (!opsPreparation.feeTelemetryPreparation) assert.equal(opsPreparation.latestLocalPreparationInactiveStagedOnServer, accepted !== null && feeDeployment === null);
  assert.equal(pending.serverStaged, accepted !== null);
  assert.equal(pending.serverActivated, feeDeployment !== null);
  assert.equal(report.serverStaged, false);
  assert.equal(report.serverActivated, false);
  assert.equal(report.realOrdersAllowed, false);
  assert.equal(report.sustainedSchedulingAccepted, false);
  assert.equal(report.implementation.feeSlotMs, 24000);
  assert.equal(report.implementation.feeRefreshMs, 240000);
  assert.equal(report.implementation.feeFreshnessMs, 300000);
  assert.equal(report.implementation.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(report.implementation.rawRetentionDays, 7);
  assert.equal(report.validation.s1AndReaderRegression.fail, 0);
  assert.equal(report.validation.offlineAcceptance.fail, 0);
  if (accepted) {
    assert.equal(accepted.status, 'SERVER_ISOLATED_FEE_LANE_ACCEPTED_NOT_ACTIVATED');
    assert.equal(accepted.server, server.host);
    assert.equal(accepted.localPreparationEvidence, pending.evidence);
    assert.equal(accepted.release.releaseId, pending.releaseId);
    assert.equal(accepted.release.archiveSha256, report.release.archiveSha256);
    assert.equal(accepted.release.verifiedFiles, 140);
    assert.equal(accepted.serverStaged, true);
    assert.equal(accepted.serverActivated, false);
    assert.equal(accepted.realOrdersAllowed, false);
    assert.equal(accepted.sustainedSchedulingAccepted, false);
    const run = accepted.serverAcceptance;
    assert.deepEqual(run.counts, { tests: 624, pass: 618, fail: 0, cancelled: 0, skipped: 6 });
    assert.equal(run.container.exitCode, 0);
    assert.equal(run.container.oom, false);
    assert.equal(run.container.restartCount, 0);
    assert.equal(run.networkMode, 'none');
    assert.equal(run.productionCredentialsMounted, false);
    assert.equal(run.uid, '993:993');
    assert.equal(run.readonlyRoot, true);
    assert.deepEqual(run.before.generations, run.after.generations);
    assert.deepEqual(run.before.monitor, run.after.monitor);
    assert.deepEqual(run.before.budget.database, run.after.budget.database);
    assert.deepEqual(run.before.budget.owners, run.after.budget.owners);
    assert.equal(run.before.preservedDigest, run.after.preservedDigest);
    assert.ok(run.after.budget.requests >= run.before.budget.requests);
    assert.equal(run.after.budget.recoveredRequests, run.before.budget.recoveredRequests);
    assert.equal(run.preparedPointerChanged, false);
    assert.equal(run.activePointersChanged, false);
    assert.equal(Object.keys(accepted.auditHashes).length, 5);
    assert.ok(Object.values(accepted.auditHashes).every(value => /^[a-f0-9]{64}$/.test(value)));
    assert.equal(accepted.storage.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
    assert.equal(accepted.storage.financialOrPinnedEvidenceEvicted, false);
    assert.equal(accepted.sourceDeltaFromActiveShadow.changed.length, 11);
    assert.deepEqual(accepted.sourceDeltaFromActiveShadow.removed, []);
  }
}
if (feeObservation) {
  const report = feeObservation, o = report.observation;
  assert.equal(report.status, 'FEE_LANE_OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(o.execSessionId, opsPreparation.feeLanePreparation.observationExecSessionId);
  assert.equal(o.completed, true);
  assert.equal(o.exitCode, 0);
  assert.equal(opsPreparation.feeLanePreparation.observationCompleted, true);
  assert.equal(o.sampleCount, 31);
  assert.equal(report.measurements.length, 31);
  assert.equal(o.sampleIndex.length, 31);
  assert.ok(o.sampleIndex.every((r, i) => r.file === `${String(i).padStart(2, '0')}.json` && /^[a-f0-9]{64}$/.test(r.sha256)));
  assert.ok(o.elapsedSeconds >= 899);
  assert.equal(o.indexHashesVerified, true);
  assert.equal(o.checkPassCounts.feesFresh, 0);
  assert.equal(o.inputReadyCount, 0);
  for (const [name, count] of Object.entries(o.checkPassCounts)) assert.equal(count, report.measurements.filter(m => m.checks[name]).length);
  assert.equal(o.shadowRefusalsInWindow.length, 3);
  assert.ok(o.shadowRefusalsInWindow.every(r => r.at >= o.startedAt * 1000 && r.at <= o.endedAt * 1000));
  assert.deepEqual(report.before.generations, report.after.generations);
  assert.deepEqual(report.after.generations, report.current.generations);
  assert.deepEqual(report.before.monitor, report.current.monitor);
  assert.deepEqual(report.before.budget.database, report.current.budget.database);
  assert.deepEqual(report.before.budget.owners, report.current.budget.owners);
  assert.equal(report.before.preservedDigest, report.current.preservedDigest);
  assert.ok(report.current.budget.requests >= report.before.budget.requests);
  assert.equal(report.current.budget.recoveredRequests, report.before.budget.recoveredRequests);
  assert.equal(report.realOrdersAllowed, false);
  assert.equal(report.sustainedSchedulingAccepted, false);
  assert.equal(report.fullLiveReady, false);
}
if (feeDeployment) {
  const d = feeDeployment;
  assert.equal(d.status, 'SHADOW_FEE_LANE_ACTIVATED_OBSERVATION_RUNNING');
  assert.equal(d.shadowRelease.id, opsPreparation.feeLanePreparation.releaseId);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.equal(d.controller.sha256, opsPreparation.feeLanePreparation.controllerSha256);
  assert.deepEqual(d.controller.steps.map(s => s.phase), ['STOP_SHADOW', 'SWITCH_SHADOW', 'START_SHADOW', 'VERIFY_RUNTIME']);
  assert.ok(d.controller.steps.every(s => s.artifact === d.controller.sha256 && s.realOrdersAllowed === false));
  const stopped = d.controller.steps[0].result.generation;
  const started = d.controller.steps[2].result.generation;
  assert.equal(d.controller.steps[0].result.exitCode, 0);
  assert.equal(stopped.id, started.id);
  assert.ok(Date.parse(started.startedAt) - Date.parse(stopped.finishedAt) >= 65000);
  assert.equal(started.restarts, 0);
  assert.equal(d.controller.steps[3].result.mountedFilesVerified, 140);
  assert.deepEqual(d.before.generations.slice(0, 2), d.after.generations.slice(0, 2));
  assert.deepEqual(started, d.after.generations[2]);
  assert.deepEqual(d.before.monitor, d.after.monitor);
  assert.deepEqual(d.before.budget.database, d.after.budget.database);
  assert.deepEqual(d.before.budget.owners, d.after.budget.owners);
  assert.equal(d.before.preservedDigest, d.after.preservedDigest);
  assert.ok(d.after.budget.requests >= d.before.budget.requests);
  assert.equal(d.before.budget.recoveredRequests, d.after.budget.recoveredRequests);
  assert.equal(d.realOrdersAllowed, false);
  assert.equal(d.fullLiveReady, false);
  assert.equal(d.sustainedSchedulingAccepted, false);
  assert.equal(d.scope.rawMaximumBytes, infra.tickBboRetention.rawMaximumBytes);
  assert.equal(d.observation.execSessionId, opsPreparation.feeLanePreparation.observationExecSessionId);
  assert.equal(d.observation.completed, false);
  assert.equal(d.observation.durationSeconds, 900);
}
const readerDeployment = opsPreparation?.accountReaderConfigurationPreparation?.activationEvidence
  ? await read(opsPreparation.accountReaderConfigurationPreparation.activationEvidence) : null;
if (opsPreparation?.accountReaderConfigurationPreparation) {
  const pending = opsPreparation.accountReaderConfigurationPreparation;
  const report = await read(pending.evidence);
  assert.equal(pending.status, readerDeployment ? 'ACTIVATED_SHORT_OBSERVATION_COMPLETED' : 'SERVER_ACCEPTED_NOT_ACTIVATED');
  assert.equal(report.status, 'LOCAL_READER_CONFIGURATION_PREPARED_NOT_SERVER_STAGED');
  assert.equal(report.release.releaseId, pending.releaseId);
  assert.equal(report.server, server.host);
  assert.equal(report.serverStaged, false);
  assert.equal(report.serverActivated, false);
  assert.equal(pending.serverStaged, true);
  assert.equal(pending.serverActivated, readerDeployment !== null);
  assert.equal(report.implementation.newSignedWeight, pending.signedWeight);
  assert.equal(pending.signedWeight, 105);
  assert.equal(pending.fullPreflightWeight, 107);
  assert.equal(report.implementation.readerWeightReserve, 160);
  assert.equal(report.implementation.fullAccountPositionsOrdersAndAlgoCoveragePreserved, true);
  assert.equal(report.implementation.legacyFallback, false);
  assert.deepEqual(accountConfig.venue.signedReadPaths, ['/fapi/v2/account', '/fapi/v2/positionRisk',
    '/fapi/v1/accountConfig', '/fapi/v1/openOrders', '/fapi/v1/openAlgoOrders']);
  assert.equal(report.validation.targeted.fail, 0);
  assert.equal(report.validation.regression.fail, 0);
  assert.equal(report.release.fileCount, 22);
  assert.equal(report.release.staticImportClosureVerified, true);
  assert.equal(report.realOrdersAllowed, false);
  const accepted = await read(pending.serverAcceptanceEvidence);
  assert.equal(accepted.status, 'SERVER_ISOLATED_READER_CONFIGURATION_ACCEPTED_NOT_ACTIVATED');
  assert.equal(accepted.localPreparationEvidence, pending.evidence);
  assert.equal(accepted.server, server.host);
  assert.equal(accepted.serverStaged, true);
  assert.equal(accepted.serverActivated, false);
  assert.equal(accepted.testPackage.releaseId, pending.testPackageReleaseId);
  assert.equal(accepted.testPackage.fileCount, 140);
  assert.equal(accepted.staging.staged[0].releaseId, pending.releaseId);
  assert.equal(accepted.staging.staged[0].verifiedFiles, 22);
  assert.equal(accepted.staging.commonFilesVerified.length, 14);
  assert.deepEqual(accepted.staging.before.generations, accepted.staging.after.generations);
  const testRun = accepted.serverAcceptance;
  assert.equal(testRun.container.exitCode, 0);
  assert.equal(testRun.container.oom, false);
  assert.equal(testRun.container.restartCount, 0);
  assert.ok(Date.parse(testRun.container.finishedAt) > Date.parse(testRun.container.startedAt));
  assert.deepEqual(testRun.counts, { tests: 620, pass: 614, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(testRun.networkMode, 'none');
  assert.equal(testRun.productionCredentialsMounted, false);
  assert.equal(testRun.readonlyRoot, true);
  assert.equal(testRun.uid, '993:993');
  assert.equal(testRun.cpus, 0.5);
  assert.equal(testRun.memoryBytes, 256 * 1024 ** 2);
  assert.deepEqual(testRun.before.generations, testRun.after.generations);
  assert.deepEqual(testRun.before.monitor, testRun.after.monitor);
  assert.deepEqual(testRun.before.budget.database, testRun.after.budget.database);
  assert.ok(testRun.after.budget.requests >= testRun.before.budget.requests);
  assert.equal(testRun.activePointersChanged, false);
  assert.equal(testRun.preparedPointerChanged, false);
  assert.equal(accepted.realOrdersAllowed, false);
}
if (readerDeployment) {
  const d = readerDeployment;
  const pending = opsPreparation.accountReaderConfigurationPreparation;
  assert.equal(d.status, 'READER_CONFIG_ACTIVATED_SHORT_OBSERVATION_COMPLETED');
  assert.equal(d.server, server.host);
  assert.equal(d.accountReaderRelease.id, pending.releaseId);
  assert.equal(d.accountReaderRelease.previousRelease, recovery.accountReaderRelease.id);
  assert.equal(d.accountReaderRelease.previousReleaseEvidence, execution.readOnlyRecoveryEvidence);
  assert.equal(d.accountReaderRelease.previousReleaseRetained, true);
  assert.equal(d.accountReaderRelease.mountedSourceFilesVerified, 22);
  assert.equal(d.controller.sha256, pending.controllerSha256);
  assert.equal(d.controller.phase, 4);
  assert.equal(d.controller.pending, null);
  assert.equal(d.controller.completed, true);
  assert.deepEqual(d.controller.completedRecords.map(r => r.phase), ['STOP_READER', 'SWITCH_READER', 'START_READER', 'VERIFY_RUNTIME']);
  assert.ok(Date.parse(d.proofAfter.generations[0].startedAt) - Date.parse(d.controller.completedRecords[0].result.generation.finishedAt) >= 65000);
  assert.deepEqual(d.proofBefore.generations.slice(1), d.proofAfter.generations.slice(1));
  assert.deepEqual(d.proofBefore.monitor, d.proofAfter.monitor);
  assert.deepEqual(d.proofBefore.budget.database, d.proofAfter.budget.database);
  assert.equal(d.proofBefore.preservedDigest, d.proofAfter.preservedDigest);
  assert.ok(d.proofAfter.budget.requests >= d.proofBefore.budget.requests);
  assert.equal(d.firstFreshAccountRead.status, 'READY_READ_ONLY_SHADOW');
  assert.equal(d.firstFreshAccountRead.streamConnected, true);
  assert.equal(d.observation.sessionId, pending.observationSessionId);
  assert.equal(d.observation.status, 'COMPLETED');
  assert.equal(d.observation.exitCode, 0);
  assert.equal(d.observation.samples, 7);
  assert.equal(d.observation.allHashesVerified, true);
  assert.equal(d.observation.sampleIndex.length, 7);
  d.observation.sampleIndex.forEach((row, i) => {
    assert.equal(row.file, `${String(i).padStart(2, '0')}.json`);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
  });
  assert.ok(d.observation.endedAt - d.observation.startedAt >= 120);
  assert.deepEqual(d.observation.before.generations, d.observation.after.generations);
  assert.equal(d.observation.distinctReaderCheckedAt.length, 3);
  assert.equal(d.observation.newAccountFramesWithinWindow, 2);
  assert.deepEqual(d.observation.readerStatuses, ['READY_READ_ONLY_SHADOW']);
  assert.equal(d.observation.captureReadySamples, 7);
  assert.equal(d.observation.inputReadySamples, 0);
  assert.equal(d.observation.checkPassCounts.feesFresh, 0);
  assert.equal(d.scope.onlyReaderRestarted, true);
  assert.equal(d.scope.previousControllersNotReplayed, true);
  assert.equal(d.scope.rawMaximumBytes, 60 * 1024 ** 3);
  assert.equal(d.fullLiveReady, false);
  assert.equal(d.sustainedSchedulingAccepted, false);
  assert.equal(d.realOrdersAllowed, false);
}
const telemetryDeployment = opsPreparation?.refusalTelemetryPreparation?.activationEvidence
  ? await read(opsPreparation.refusalTelemetryPreparation.activationEvidence) : null;
const backgroundPreparation = opsPreparation?.backgroundEligibilityPreparation
  ? await read(opsPreparation.backgroundEligibilityPreparation.evidence) : null;
const backgroundDeployment = opsPreparation?.backgroundEligibilityPreparation?.activationEvidence
  ? await read(opsPreparation.backgroundEligibilityPreparation.activationEvidence) : null;
if (backgroundPreparation) {
  const a = backgroundPreparation;
  assert.equal(a.status, 'BACKGROUND_ELIGIBILITY_OFFLINE_ACCEPTED_NOT_ACTIVATED');
  assert.equal(a.server, server.host);
  assert.equal(a.preparation.releaseId, opsPreparation.serverPreparationReleaseId);
  assert.equal(a.preparation.releaseId, opsPreparation.backgroundEligibilityPreparation.releaseId);
  assert.equal(a.implementation.backgroundAdvisoryHeadroom, 265);
  assert.equal(a.implementation.accountReaderHardReserveUnchanged, 160);
  assert.equal(a.implementation.shadowAccountBatchWeight, 105);
  assert.equal(a.implementation.advisoryNotAtomicReservation, true);
  assert.equal(a.preparation.verifiedFiles, 139);
  assert.equal(a.serverOfflineAcceptance.exitCode, 0);
  assert.deepEqual(a.serverOfflineAcceptance.counts, { tests: 584, pass: 578, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(a.serverOfflineAcceptance.networkMode, 'none');
  assert.equal(a.serverOfflineAcceptance.productionCredentialsMounted, false);
  assert.deepEqual(a.proofBefore.generations, a.proofAfter.generations);
  assert.deepEqual(a.proofBefore.monitor, a.proofAfter.monitor);
  assert.equal(a.fullLiveReady, false);
  assert.equal(a.realOrdersAllowed, false);
  assert.equal(opsPreparation.backgroundEligibilityPreparation.serviceActivated, backgroundDeployment !== null);
}
if (backgroundDeployment) {
  const a = backgroundDeployment;
  assert.equal(a.status, 'BACKGROUND_ELIGIBILITY_ACTIVATED_OBSERVATION_COMPLETED_NOT_ACCEPTED');
  assert.equal(a.server, server.host);
  assert.equal(a.shadowRelease.id, backgroundPreparation.preparation.releaseId);
  assert.equal(a.preparationEvidence, opsPreparation.backgroundEligibilityPreparation.evidence);
  assert.equal(a.controller.sha256, opsPreparation.backgroundEligibilityPreparation.controllerSha256);
  assert.equal(a.controller.phase, 4);
  assert.equal(a.controller.pending, null);
  assert.equal(a.mountedSourceFilesVerified, 139);
  assert.equal(a.initialSnapshot.backgroundReadHeadroomWeight, 265);
  assert.equal(a.backgroundAdvisoryHeadroom, 265);
  assert.equal(a.accountReaderHardReserveUnchanged, 160);
  assert.deepEqual(a.proofBefore.generations.slice(0, 2), a.proofAfter.generations.slice(0, 2));
  assert.deepEqual(a.proofBefore.monitor, a.proofAfter.monitor);
  assert.deepEqual(a.proofBefore.budget.database, a.proofAfter.budget.database);
  assert.ok(a.proofAfter.budget.requests >= a.proofBefore.budget.requests);
  assert.ok(Date.parse(a.captureGap.newStartedAt) - Date.parse(a.captureGap.oldStoppedAt) >= 65000);
  assert.equal(a.observation.sessionId, opsPreparation.backgroundEligibilityPreparation.observationExecSessionId);
  assert.equal(a.observation.plannedSamples, 31);
  assert.equal(a.observation.maximumSampleBytes, 8192);
  assert.equal(a.observation.status, 'COMPLETED');
  assert.equal(a.observation.exitCode, 0);
  assert.equal(a.observation.completed, true);
  const o = await read(a.observation.resultEvidence);
  const preparationState = opsPreparation.backgroundEligibilityPreparation;
  assert.equal(preparationState.observationEvidence, a.observation.resultEvidence);
  assert.equal(preparationState.observationStatus, 'COMPLETED');
  assert.equal(preparationState.observationCompleted, true);
  assert.equal(preparationState.observationExitCode, 0);
  assert.equal(o.status, 'OBSERVATION_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(o.sessionId, a.observation.sessionId);
  assert.equal(o.exitCode, 0);
  assert.equal(o.samples, 31);
  assert.equal(o.sampleIndex.length, 31);
  assert.ok(o.endedAt - o.startedAt >= 600);
  assert.ok(o.completedAt >= o.endedAt);
  assert.equal(o.allIndexHashesVerified, true);
  for (const [i, entry] of o.sampleIndex.entries()) {
    assert.equal(entry.file, `${String(i).padStart(2, '0')}.json`);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.at >= o.startedAt && entry.at <= o.endedAt);
    if (i) assert.ok(entry.at > o.sampleIndex[i - 1].at);
  }
  assert.deepEqual(o.proofBefore.generations, o.proofAfter.generations);
  assert.deepEqual(o.proofBefore.monitor, o.proofAfter.monitor);
  assert.deepEqual(o.proofBefore.budget.database, o.proofAfter.budget.database);
  assert.ok(o.proofAfter.budget.requests >= o.proofBefore.budget.requests);
  assert.equal(o.checkPassCounts.feesFresh, 0);
  assert.equal(o.inputReadySamples, 0);
  assert.equal(o.captureReadySamples, 31);
  assert.equal(o.rawMaximumBytes, 60 * 1024 ** 3);
  assert.equal(o.rawRetentionDays, 7);
  assert.equal(o.realOrdersAllowed, false);
  assert.equal(o.sustainedSchedulingAccepted, false);
  assert.equal(a.fullLiveReady, false);
  assert.equal(a.realOrdersAllowed, false);
  assert.equal(a.sustainedSchedulingAccepted, false);
}
if (opsPreparation?.refusalTelemetryPreparation) {
  const d = opsPreparation.refusalTelemetryPreparation;
  const report = await read(d.evidence);
  assert.equal(report.status, 'REFUSAL_TELEMETRY_OFFLINE_ACCEPTED_NOT_ACTIVATED');
  assert.equal(report.server, server.host);
  assert.equal(report.preparation.releaseId, d.releaseId);
  if (backgroundPreparation) {
    assert.equal(backgroundPreparation.preparation.previousPreparedReleaseId, d.releaseId);
    assert.equal(backgroundPreparation.previousPreparationEvidence, d.evidence);
    assert.equal(opsPreparation.serverPreparationEvidence, opsPreparation.backgroundEligibilityPreparation.evidence);
  } else {
    assert.equal(d.releaseId, opsPreparation.serverPreparationReleaseId);
    assert.equal(d.evidence, opsPreparation.serverPreparationEvidence);
  }
  assert.equal(report.preparation.verifiedFiles, 139);
  assert.equal(report.preparation.sourceVerifiedBeforeAndAfter, true);
  assert.equal(report.preparation.preparedPointerChanged, true);
  assert.equal(report.implementation.maximumRecentRefusals, 8);
  assert.equal(report.implementation.processLocal, true);
  assert.equal(report.implementation.durableAudit, false);
  assert.equal(report.implementation.originalAdmissionAndExceptionsPreserved, true);
  assert.equal(report.serverOfflineAcceptance.exitCode, 0);
  assert.deepEqual(report.serverOfflineAcceptance.counts, { tests: 574, pass: 568, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(report.serverOfflineAcceptance.networkMode, 'none');
  assert.equal(report.serverOfflineAcceptance.productionCredentialsMounted, false);
  assert.deepEqual(report.proofBefore.core.generations, report.proofAfter.core.generations);
  assert.deepEqual(report.proofBefore.generation, report.proofAfter.generation);
  assert.deepEqual(report.proofBefore.core.budget.database, report.proofAfter.core.budget.database);
  assert.ok(report.proofAfter.core.budget.requests >= report.proofBefore.core.budget.requests);
  assert.equal(report.storage.rawMaximumBytes, 60 * 1024 ** 3);
  for (const key of ['allResidentGenerationsUnchanged', 'allActiveSourcePointersUnchanged', 'budgetIdentityPreserved']) assert.equal(report[key], true);
  for (const key of ['fullLiveReady', 'realOrdersAllowed', 'sustainedSchedulingAccepted']) assert.equal(report[key], false);
  assert.equal(d.serviceActivated, telemetryDeployment !== null);
  if (telemetryDeployment) {
    const a = telemetryDeployment;
    assert.equal(a.status, 'REFUSAL_TELEMETRY_ACTIVATED_SCHEDULING_NOT_ACCEPTED');
    assert.equal(a.server, server.host);
    assert.equal(a.shadowRelease.id, d.releaseId);
    assert.equal(a.preparationEvidence, d.evidence);
    assert.equal(a.controller.phase, 4);
    assert.equal(a.controller.pending, null);
    assert.equal(a.controller.sha256, d.controllerSha256);
    assert.equal(a.mountedSourceFilesVerified, 139);
    assert.deepEqual(a.proofBefore.generations.slice(0, 2), a.proofAfter.generations.slice(0, 2));
    assert.deepEqual(a.proofBefore.monitor, a.proofAfter.monitor);
    assert.deepEqual(a.proofBefore.budget.database, a.proofAfter.budget.database);
    assert.ok(a.proofAfter.budget.requests >= a.proofBefore.budget.requests);
    assert.equal(a.realOrdersAllowed, false);
    assert.equal(a.fullLiveReady, false);
    assert.equal(a.sustainedSchedulingAccepted, false);
    assert.equal(a.observation.status, 'COMPLETED');
    assert.equal(a.observation.exitCode, 0);
    assert.equal(a.observation.samples.length, 37);
    assert.ok(a.observation.endedAt - a.observation.startedAt >= 180);
    assert.equal(a.observation.distinctRefusals.length, 3);
    assert.equal(a.observation.distinctStaleAccountFrames, 1);
    assert.equal(a.observation.historyReadyProjectionValid, false);
    const refusal = a.observation.distinctRefusals.find(r => r.sequence === 3);
    const failed = a.observation.distinctFailedCycles[0];
    assert.equal(failed.cycle.error, refusal.code);
    assert.ok(failed.cycle.startedAt <= refusal.at && refusal.at <= failed.cycle.completedAt);
    assert.equal(refusal.pressure.rollingWeight, 751);
    assert.equal(refusal.stage, 'ACCOUNT_READER_RESERVE');
    assert.equal(Date.parse(failed.checkedAt) - failed.accountObservedAt, 15186);
    assert.equal(a.diagnosis.previousPressureDiagnosticStaleFrameCauseStillUnverified, true);
  }
}
if (opsPreparation?.readPressureDiagnosis) {
  const d = opsPreparation.readPressureDiagnosis;
  const report = await read(d.evidence);
  assert.equal(report.status, 'READ_PRESSURE_DIAGNOSTIC_COMPLETED_SCHEDULING_NOT_ACCEPTED');
  assert.equal(report.server, server.host);
  assert.equal(report.diagnosticRelease.releaseId, d.releaseId);
  assert.equal(report.diagnosticRelease.verifiedFiles, 139);
  assert.deepEqual(report.diagnosticRelease.onlyChangedFiles,
    ['ops/demo-server/s1-read-admission-observer.mjs', 'tests/s1-read-admission-observer.test.mjs']);
  assert.equal(report.serverFixtureAcceptance.exitCode, 0);
  assert.equal(report.serverFixtureAcceptance.passed, 20);
  assert.equal(report.observation.exitCode, 0);
  assert.equal(report.observation.samples.length, 37);
  assert.ok(report.observation.samples.at(-1).at - report.observation.samples[0].at >= 180);
  const samples = report.observation.samples;
  assert.equal(samples.filter(s => s.budget.pressure.nonReaderRemainingWeight < 105).length, 23);
  assert.ok(samples.some(s => s.scanner.sequence === 3429 && s.scanner.errors.some(e => e.reason === 'READ_BUDGET_LOCAL_WEIGHT')));
  const staleFrames = new Set(samples.filter(s => Date.parse(s.shadow.checkedAt) - s.shadow.accountObservedAt > 5000).map(s => s.shadow.checkedAt));
  assert.equal(staleFrames.size, 1);
  for (const sample of samples) {
    assert.equal(sample.budget.pressure.admissionGranted, false);
    assert.equal(sample.budget.pressure.completedWeightAttributionAvailable, false);
    assert.equal(sample.shadow.realOrdersAllowed, false);
  }
  assert.equal(report.allGenerationsUnchanged, true);
  assert.equal(report.allActiveSourcePointersUnchanged, true);
  for (const key of ['fullLiveReady', 'realOrdersAllowed', 'sustainedSchedulingAccepted']) assert.equal(report[key], false);
  assert.equal(d.accountFrameFailureCauseVerified, false);
  assert.equal(d.serviceActivated, false);
}
if (opsPreparation?.opsCompatibilityDeploymentEvidence) {
  const ops = await read(opsPreparation.opsCompatibilityDeploymentEvidence);
  assert.equal(ops.status, 'OPS_COMPATIBILITY_ACTIVATED_OBSERVED_NOT_LIVE_ACCEPTED');
  assert.equal(ops.server, server.host);
  assert.equal(ops.supersedesDiagnosis, opsPreparation.opsCompatibilityDiagnosisEvidence);
  assert.equal(ops.preparation.releaseId, opsPreparation.opsMonitorReleaseId);
  if (opsPreparation.refusalTelemetryPreparation) {
    const next = await read(opsPreparation.refusalTelemetryPreparation.evidence);
    assert.equal(next.preparation.previousPreparedReleaseId, ops.preparation.releaseId);
    assert.equal(next.previousPreparationEvidence, opsPreparation.opsCompatibilityDeploymentEvidence);
  } else assert.equal(ops.preparation.releaseId, opsPreparation.serverPreparationReleaseId);
  assert.equal(ops.preparation.verifiedFiles, 139);
  assert.equal(ops.preparation.sourceVerifiedBeforeAndAfter, true);
  assert.equal(ops.serverOfflineAcceptance.exitCode, 0);
  assert.deepEqual(ops.serverOfflineAcceptance.counts, { tests: 564, pass: 558, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(ops.serverOfflineAcceptance.networkMode, 'none');
  assert.equal(ops.serverOfflineAcceptance.productionCredentialsMounted, false);
  assert.equal(ops.controller.phase, 4);
  assert.equal(ops.controller.pending, null);
  assert.equal(ops.controller.completed, true);
  assert.equal(ops.coreGenerationsPreserved, true);
  assert.equal(ops.mountedSourceFilesVerified, 139);
  assert.equal(ops.diagnosticHistoryPreserved, true);
  assert.equal(ops.sqliteLeaseIdentityPreserved, true);
  assert.equal(ops.rawMaximumBytes, 60 * 1024 ** 3);
  assert.equal(ops.rawWarningBytes, 54 * 1024 ** 3);
  assert.equal(ops.observation.exitCode, 0);
  assert.equal(ops.observation.samples.length, 7);
  assert.ok(ops.observation.samples.at(-1).at - ops.observation.samples[0].at >= 60);
  for (const sample of ops.observation.samples) {
    assert.equal(sample.opsHealth, 'healthy');
    assert.equal(sample.alerts.RAW_CAPACITY_HIGH.active, false);
    assert.equal(sample.alerts.REQUEST_BUDGET_UNAVAILABLE.active, false);
    assert.equal(sample.alerts.ENTRY_INCIDENT_REVIEW_REQUIRED.active, true);
    assert.equal(sample.realOrdersAllowed, false);
    assert.equal(sample.newEntriesBlocked, true);
  }
  assert.equal(opsPreparation.opsCapacityAndSharedBudgetCompatibilityAccepted, true);
  for (const key of ['composeChanged', 'strategyRiskChanged', 'budgetCounterReset', 'retainedIncidentCleared',
    'fullLiveReady', 'realOrdersAllowed', 'externalAlertDeliveryVerified', 'offServerDisasterRecoveryAccepted']) assert.equal(ops[key], false);
  assert.equal(ops.newEntriesBlocked, true);
}
if (readinessPreparation) {
  const prepared = await read(readinessPreparation.evidence);
  assert.equal(prepared.status, 'READINESS_STATUS_FIX_OFFLINE_ACCEPTED_NOT_ACTIVATED');
  assert.equal(prepared.server, server.host);
  assert.equal(prepared.previousDeploymentEvidence, execution.readSchedulingDeploymentEvidence);
  assert.equal(prepared.preparation.releaseId, readinessPreparation.releaseId);
  assert.equal(prepared.preparation.verifiedFiles, 139);
  assert.equal(prepared.preparation.sourceVerifiedBeforeAndAfter, true);
  assert.equal(prepared.preparation.active, false);
  assert.deepEqual(prepared.preparation.onlyChangedFiles, [
    'agents/orion-live/s1-execution/README.md', 'agents/orion-live/s1-execution/readonly-host.mjs', 'tests/s1-request-budget.test.mjs']);
  assert.equal(prepared.serverOfflineAcceptance.exitCode, 0);
  assert.deepEqual(prepared.serverOfflineAcceptance.counts, { tests: 559, pass: 553, fail: 0, cancelled: 0, skipped: 6 });
  assert.equal(prepared.serverOfflineAcceptance.networkMode, 'none');
  assert.equal(prepared.serverOfflineAcceptance.productionCredentialsMounted, false);
  assert.equal(prepared.allActiveGenerationsPreserved, true);
  for (const key of ['realOrdersAllowed', 'fullLiveReady', 'sustainedSchedulingAccepted']) assert.equal(prepared[key], false);
  assert.equal(prepared.newEntriesBlocked, true);
  assert.equal(readinessPreparation.serverActivated, !!readinessDeployment);
  if (readinessDeployment) {
    assert.equal(readinessDeployment.preparationEvidence, readinessPreparation.evidence);
    assert.equal(readinessDeployment.previousDeploymentEvidence, execution.readSchedulingDeploymentEvidence);
    assert.equal(readinessDeployment.shadowRelease.id, prepared.preparation.releaseId);
    assert.equal(readinessDeployment.shadowRelease.manifestSha256, prepared.preparation.manifestSha256);
    assert.equal(readinessDeployment.shadowRelease.previousRelease, scheduling.shadowRelease.id);
    assert.equal(readinessDeployment.controller.phase, 4);
    assert.equal(readinessDeployment.controller.pending, null);
    assert.equal(readinessDeployment.controller.completed, true);
    assert.equal(readinessDeployment.controller.priorControllersReplayed, false);
    assert.equal(readinessDeployment.readerAndScannerGenerationsPreserved, true);
    assert.equal(readinessDeployment.mountedManifestVerified, true);
    assert.equal(readinessDeployment.freshAccountReadAndReadinessChecksVerified, true);
    for (const key of ['budgetCounterReset', 'composeChanged', 'strategyRiskChanged', 'retainedIncidentCleared',
      'realOrdersAllowed', 'fullLiveReady', 'sustainedSchedulingAccepted']) assert.equal(readinessDeployment[key], false);
    assert.equal(readinessDeployment.newEntriesBlocked, true);
    const observed = await read(readinessDeployment.observation.evidence);
    assert.equal(observed.deploymentEvidence, execution.readinessStatusDeploymentEvidence);
    assert.equal(observed.observationProcessExitCode, 0);
    assert.equal(observed.status, 'COMPLETED_STATUS_FIX_OBSERVED_NOT_LIVE_ACCEPTED');
    assert.equal(observed.samples.length, 13);
    observed.samples.forEach((sample, index) => {
      assert.equal(sample.index, index);
      if (index) assert.ok(sample.at > observed.samples[index - 1].at);
      assert.equal(sample.generationsUnchanged, true);
      assert.equal(sample.allThreeRunning, true);
      assert.equal(sample.shadow.realOrdersAllowed, false);
      assert.equal(sample.shadow.newEntriesBlocked, true);
    });
    assert.ok(observed.samples.at(-1).at - observed.samples[0].at >= 360);
    assert.equal(observed.finalProofVerified, true);
    assert.equal(observed.feeTimestampFixObserved, true);
    assert.ok(observed.samples.some(s => s.shadow.inputReadiness.checks.feesFresh));
    assert.equal(observed.sustainedSchedulingAccepted, false);
    assert.equal(observed.fullLiveReady, false);
    assert.equal(observed.retainedIncidentCleared, false);
  }
}
if (scheduling) {
  assert.equal(scheduling.status, 'READ_SCHEDULING_ACTIVATED_SUSTAINED_ACCEPTANCE_PENDING');
  assert.equal(scheduling.server, server.host);
  assert.equal(scheduling.previousDeploymentEvidence, execution.accountConfigurationDeploymentEvidence);
  assert.equal(scheduling.shadowRelease.previousRelease, configuration.shadowRelease.id);
  assert.equal(scheduling.scannerRelease.previousRelease, priority.scannerRelease.id);
  assert.equal(scheduling.journal.phase, 7);
  assert.equal(scheduling.journal.pending, null);
  assert.equal(scheduling.journal.completed, true);
  assert.equal(scheduling.journal.priorFailureReplayed, false);
  for (const field of ['readerGenerationPreserved', 'budgetDatabaseIdentityPreserved', 'mountedManifestsVerified',
    'kernelAdmissionEnrollmentVerified', 'freshAccountConfigReadVerified', 'scannerSequenceAdvanced']) assert.equal(scheduling[field], true);
  for (const field of ['composeChanged', 'budgetCounterReset', 'sustainedSchedulingAccepted', 'fullLiveReady', 'realOrdersAllowed']) assert.equal(scheduling[field], false);
  assert.equal(scheduling.newEntriesBlocked, true);
  assert.equal(scheduling.feeSlotMs, 24000);
  assert.equal(scheduling.localWeightOnlyRetryWaitMs, 70000);
  assert.equal(scheduling.maximumWeightPerRollingMinute, 900);
  assert.equal(scheduling.maximumConcurrent, 8);
  assert.equal(execution.requestedExecution.componentPreparation.readSchedulingPreparation.serverActivated, true);
  const observed = await read(scheduling.observation.evidence);
  assert.equal(observed.server, server.host);
  assert.equal(observed.execSessionId, scheduling.observation.execSessionId);
  assert.equal(observed.deploymentEvidence, execution.readSchedulingDeploymentEvidence);
  assert.ok(observed.samples.length > 0 && observed.samples.length <= observed.plannedSamples);
  observed.samples.forEach((sample, index) => {
    assert.equal(sample.index, index);
    assert.ok(Number.isFinite(sample.at));
    if (index) assert.ok(sample.at > observed.samples[index - 1].at);
  });
  if (observed.observationProcessExitCode !== null) {
    assert.equal(observed.observationProcessExitCode, 0);
    assert.equal(observed.status, 'COMPLETED_SCHEDULING_NOT_ACCEPTED');
    assert.equal(observed.samples.length, 31);
    assert.ok(observed.samples.at(-1).at - observed.samples[0].at >= 900);
    assert.equal(observed.finalProofVerified, true);
    assert.equal(observed.sustainedSchedulingAccepted, false);
    assert.equal(observed.fullLiveReady, false);
    assert.equal(observed.realOrdersAllowed, false);
    assert.equal(observed.newEntriesBlocked, true);
    assert.ok(observed.samples.every(s => s.allThreeRunning && s.generationsUnchanged && s.allRestartCountsZero));
    assert.ok(observed.samples.some(s => s.scanner.errors.some(e => e.reason === 'READ_BUDGET_LOCAL_WEIGHT')));
    assert.equal(execution.requestedExecution.componentPreparation.readSchedulingPreparation.observationStatus, observed.status);
  }
}
if (configuration) {
  assert.equal(configuration.status, 'ACCOUNT_CONFIG_ACTIVATED_SUSTAINED_ACCEPTANCE_PENDING');
  assert.equal(configuration.server, server.host);
  assert.equal(configuration.previousDeploymentEvidence, execution.batchDeploymentEvidence);
  assert.equal(configuration.shadowRelease.previousRelease, batch.shadowRelease.id);
  assert.equal(configuration.journal.phase, 4);
  assert.equal(configuration.journal.pending, null);
  assert.equal(configuration.journal.completed, true);
  assert.equal(configuration.journal.priorFailureReplayed, false);
  for (const field of ['readerGenerationPreserved', 'scannerGenerationPreserved', 'budgetDatabaseIdentityPreserved',
    'mountedManifestVerified', 'kernelAdmissionEnrollmentVerified', 'freshAccountConfigReadVerified']) assert.equal(configuration[field], true);
  for (const field of ['composeChanged', 'budgetCounterReset', 'venueSnapshotAtomic', 'sustainedSchedulingAccepted',
    'fullLiveReady', 'realOrdersAllowed']) assert.equal(configuration[field], false);
  assert.equal(configuration.newEntriesBlocked, true);
  assert.equal(configuration.accountBatchRequestCount, 5);
  assert.equal(configuration.accountBatchReservedWeight, 105);
  assert.equal(configuration.maximumWeightPerRollingMinute, 900);
  assert.equal(configuration.maximumConcurrent, 8);
  assert.equal(configuration.accountReaderWeightHeadroom, 160);
  assert.equal(execution.requestedExecution.componentPreparation.accountConfigurationPreparation.serverActivated, true);
  const observed = await read(configuration.observationEvidence);
  assert.equal(observed.deploymentEvidence, execution.accountConfigurationDeploymentEvidence);
  assert.equal(observed.observationProcessExitCode, 0);
  assert.equal(observed.sampleCount, observed.samples.length);
  assert.equal(observed.allThreeRunningAndZeroRestarts, true);
  assert.equal(observed.allGenerationsUnchanged, true);
  assert.equal(observed.accountConfigMarkersAllSamples, true);
  assert.equal(observed.distinctPostActivationScannerScans, 1);
  assert.equal(observed.postActivationHealthyScans, 0);
  assert.equal(observed.scannerDegradationObserved, true);
  assert.equal(observed.sustainedSchedulingAccepted, false);
}
if (batch) {
  assert.equal(batch.status, 'BATCH_ACTIVATED_SUSTAINED_ACCEPTANCE_PENDING');
  assert.equal(batch.server, server.host);
  assert.equal(batch.previousDeploymentEvidence, execution.priorityDeploymentEvidence);
  assert.equal(batch.shadowRelease.previousRelease, priority.shadowRelease.id);
  assert.equal(batch.journal.phase, 4);
  assert.equal(batch.journal.pending, null);
  assert.equal(batch.journal.completed, true);
  assert.equal(batch.journal.priorFailureReplayed, false);
  assert.equal(batch.readerGenerationPreserved, true);
  assert.equal(batch.scannerGenerationPreserved, true);
  assert.equal(batch.composeChanged, false);
  assert.equal(batch.budgetDatabaseIdentityPreserved, true);
  assert.equal(batch.budgetCounterReset, false);
  assert.equal(batch.shadowBatchAdmissionLoaded, true);
  assert.equal(batch.shadowLockWaitMs, 250);
  assert.equal(batch.venueSnapshotAtomic, false);
  assert.equal(batch.mountedManifestVerified, true);
  assert.equal(batch.kernelAdmissionEnrollmentVerified, true);
  assert.equal(batch.maximumWeightPerRollingMinute, 900);
  assert.equal(batch.maximumConcurrent, 8);
  assert.equal(batch.sustainedSchedulingAccepted, false);
  assert.equal(batch.fullLiveReady, false);
  assert.equal(batch.realOrdersAllowed, false);
  assert.equal(batch.newEntriesBlocked, true);
  assert.equal(execution.requestedExecution.componentPreparation.accountBatchPreparation.serverActivated, true);
  const observation = await read(batch.observationEvidence);
  assert.equal(observation.deploymentEvidence, execution.batchDeploymentEvidence);
  assert.equal(observation.allThreeRunningAndZeroRestarts, true);
  assert.equal(observation.allGenerationsUnchanged, true);
  assert.equal(observation.scannerDegradationObserved, true);
  assert.equal(observation.sustainedSchedulingAccepted, false);
}
if (priority) {
  assert.equal(priority.status, 'PRIORITY_ACTIVATED_SUSTAINED_ACCEPTANCE_PENDING');
  assert.equal(priority.server, server.host);
  assert.equal(priority.previousRecoveryEvidence, execution.readOnlyRecoveryEvidence);
  assert.equal(priority.scannerRelease.previousRelease, recovery.scannerRelease.id);
  assert.equal(priority.shadowRelease.previousRelease, recovery.shadowRelease.id);
  assert.equal(priority.journal.phase, 7);
  assert.equal(priority.journal.pending, null);
  assert.equal(priority.journal.priorRecoveryQualitySupersededIncomplete, true);
  assert.equal(priority.journal.priorRecoveryPhase, 10);
  assert.equal(priority.readerGenerationPreserved, true);
  assert.equal(priority.budgetDatabaseIdentityPreserved, true);
  assert.equal(priority.budgetCounterReset, false);
  assert.equal(priority.mountedReleaseManifestsVerified, true);
  assert.equal(priority.kernelAdmissionEnrollmentVerified, true);
  assert.equal(priority.accountReaderWeightHeadroom, 160);
  assert.equal(priority.maximumWeightPerRollingMinute, 900);
  assert.equal(priority.sustainedSchedulingAccepted, false);
  assert.equal(priority.realOrdersAllowed, false);
  assert.equal(priority.fullLiveReady, false);
  assert.equal(priority.newEntriesBlocked, true);
  for (const row of priority.services) {
    assert.equal(row.status, 'running');
    assert.equal(row.restartCount, 0);
    assert.equal(row.restartPolicy, 'unless-stopped');
  }
  assert.equal(execution.requestedExecution.componentPreparation.continuousReadOnlyHostReleaseId,
    batchDispatchDeployment ? batchDispatchDeployment.shadowRelease.id : advisoryReasonDeployment ? advisoryReasonDeployment.shadowRelease.id : feeEligibilityDeployment ? feeEligibilityDeployment.shadowRelease.id : feeTelemetryDeployment ? feeTelemetryDeployment.shadowRelease.id : feeDeployment ? feeDeployment.shadowRelease.id : backgroundDeployment ? backgroundDeployment.shadowRelease.id : telemetryDeployment ? telemetryDeployment.shadowRelease.id : readinessDeployment ? readinessDeployment.shadowRelease.id : scheduling ? scheduling.shadowRelease.id : configuration ? configuration.shadowRelease.id : batch ? batch.shadowRelease.id : priority.shadowRelease.id);
}
if (recovery) {
  assert.ok(['RUNNING_READ_ONLY_RECOVERY_VERIFIED', 'RUNNING_READ_ONLY_RECOVERY_ACCEPTANCE_PENDING'].includes(recovery.status));
  assert.equal(recovery.server.host, server.host);
  assert.equal(recovery.recoveryJournal.phase, recovery.status === 'RUNNING_READ_ONLY_RECOVERY_VERIFIED' ? 11 : 10);
  assert.equal(recovery.recoveryJournal.pending, null);
  assert.equal(recovery.originalIncidentPreserved, true);
  assert.equal(recovery.legacyShutdownDrainVerified, false);
  assert.equal(recovery.realOrdersAllowed, false);
  assert.equal(recovery.newEntriesBlocked, true);
  assert.equal(recovery.fullLiveReady, false);
  // Recovery evidence is immutable and records the superseded 60 GiB policy.
  assert.equal(recovery.storage.maximumRawPayloadBytes, 64424509440);
  assert.equal(recovery.services.length, 3);
  for (const row of recovery.services) {
    assert.equal(row.status, 'running');
    assert.equal(row.health, 'healthy');
    assert.equal(row.restartPolicy, 'unless-stopped');
    assert.equal(row.restartCount, 0);
    assert.match(row.id, /^[a-f0-9]{64}$/);
    assert.equal(row.residentAdmissionEnrolled, true);
  }
}
const maintenanceHold = execution.candidateScanner.maintenanceRecoveryHold === true;
if (maintenanceHold || recovery) {
  // Historical deployment success must not force a false RUNNING assertion
  // after a documented maintenance failure. Accept only the linked incident,
  // never an arbitrary stopped status or relaxed execution permission.
  assert.equal(execution.candidateScanner.maintenanceEvidence, "governance/evidence/s1-read-cutover-failed-stop-20260913.json");
  const incident = await read(execution.candidateScanner.maintenanceEvidence);
  assert.equal(incident.status, "CUTOVER_FROZEN_AFTER_SCANNER_EXIT_143_RECOVERY_REVIEW_REQUIRED");
  assert.equal(incident.cutover.failed, true);
  assert.equal(incident.cutover.phase, 1);
  assert.equal(incident.cutover.pending, "STOP_SCANNER");
  assert.equal(incident.cutover.journalResetOrPendingReplayed, false);
  assert.equal(incident.actualServiceState.scanner.status, "exited");
  assert.equal(incident.actualServiceState.scanner.exitCode, 143);
  assert.equal(incident.actualServiceState.shadow.status, "exited");
  assert.equal(incident.actualServiceState.reader.status, "running");
  assert.equal(incident.scannerWitness.status, "PENDING");
  assert.equal(incident.scannerWitness.completedReceiptPublished, false);
  assert.equal(incident.captureGapOngoing, true);
  assert.equal(incident.realOrdersAllowed, false);
  assert.equal(incident.liveReady, false);
  assert.equal(execution.candidateScanner.active, !!recovery);
  if (!recovery) {
    assert.equal(execution.candidateScanner.latestSequence, incident.actualServiceState.scanner.lastSequence);
    assert.equal(execution.candidateScanner.latestSourceAsOf, incident.actualServiceState.scanner.lastCycleAt);
  } else {
    assert.equal(maintenanceHold, false);
    assert.ok(execution.candidateScanner.latestSequence > incident.actualServiceState.scanner.lastSequence);
  }
}
assert.equal(authorization.id, "OWNER-DIRECTIVE-QUANT-SERVER-REPLACEMENT-20260911");
assert.equal(infra.authorizationId, authorization.id);
assert.equal(evidence.authorizationId, authorization.id);
assert.equal(registry.authorizationId, authorization.id);
assert.equal(server.host, authorization.server.host);
assert.equal(server.host, "192.0.2.10");
assert.equal(server.dnsTarget, server.host);
assert.equal(registry.targetIp, server.host);
assert.equal(server.remoteHostname, evidence.remoteHostname);
assert.equal(server.sshUser, "deployer");
assert.equal(server.deployerVerified, true);
assert.equal(evidence.deployerSshAndSudoVerified, true);
assert.equal(evidence.sshHostKey.ownerVerified, true);
assert.equal(evidence.privateKeyMode, "0600");
assert.equal(server.hostFirewallEnableAllowed, false);
assert.equal(evidence.hostFirewallChanged, false);
assert.equal(registry.ingress, "BT_NGINX_REVERSE_PROXY");
assert.equal(registry.preferredApplicationRuntime, "BT_DOCKER_COMPOSE");
assert.equal(accountConfig.host.requiredHostname, server.remoteHostname);
assert.equal(scannerConfig.requiredHostname, server.remoteHostname);
assert.equal(accountConfig.host.requiredIdentity, "demo-server");
assert.equal(execution.credentialUseOutsideQuantServerAllowed, false);
assert.equal(execution.signedAccountReadsAllowed, true);
assert.equal(execution.userDataStreamAllowed, true);
assert.equal(execution.credentialMapping.apiKey, "BN-KEY-PROD");
assert.equal(execution.credentialMapping.apiSecret, "BN-SECRET-PROD");
for (const boundary of [service, accountConfig.execution, scannerConfig]) {
  assert.equal(boundary.realOrdersAllowed, false);
  assert.equal(boundary.newEntriesBlocked, true);
}
assert.equal(execution.realOrdersAllowed, !ownerPaused && liveHost?.realOrdersActivated === true);
assert.equal(execution.newEntriesBlocked, ownerPaused || liveHost?.realOrdersActivated !== true || entryBlockedByIncident);
assert.equal(execution.orderTestAllowed, false);
assert.equal(execution.strategyAssigned, Boolean(liveHost));
assert.equal(accountConfig.execution.orderTestAllowed, false);
assert.equal(accountConfig.execution.strategyAssigned, false);
assert.deepEqual(accountConfig.execution.tradingMutationMethodsAllowed, []);
assert.equal(scannerConfig.paperOrdersAllowed, false);
assert.equal(execution.candidateScanner.exchangeCredentialAccessAllowed, false);
assert.equal(accountConfig.retention.rawRetentionDays, 7);
assert.equal(accountConfig.retention.rawMaximumBytes, 42949672960);
assert.equal(execution.desiredRawMaximumBytes, accountConfig.retention.rawMaximumBytes);
assert.equal(current.s1S2RollingRawEvidenceRetention.maximumBytesPerAccount, accountConfig.retention.rawMaximumBytes);
assert.equal(execution.rawMaximumBytes, 42949672960);
const capacityAuthorization = await read(current.s1S2RollingRawEvidenceRetention.authorization);
assert.equal(capacityAuthorization.authorizationId, "OWNER-DIRECTIVE-S1-S2-ROLLING-RAW-EVIDENCE-RETENTION-20260917");
assert.equal(capacityAuthorization.scope.maximumBytesPerAccount, accountConfig.retention.rawMaximumBytes);
assert.equal(capacityAuthorization.previousMaximumBytesPerAccount, 64424509440);
assert.equal(capacityAuthorization.scope.maximumAgeDays, 7);
assert.equal(capacityAuthorization.scope.diskEvictionUsedPercent, 78);
assert.equal(capacityAuthorization.scope.diskTargetUsedPercent, 72);
assert.equal(capacityAuthorization.scope.diskHardBlockUsedPercent, 85);
assert.equal(capacityAuthorization.scope.minimumFreeBytes, 5368709120);
assert.equal(capacityAuthorization.retention.pinnedEntryEvidenceEvictionAllowed, false);
assert.equal(capacityAuthorization.retention.compactDecisionOrderRiskLedgerEvictionAllowed, false);
assert.equal(current.s1S2RollingRawEvidenceRetention.maximumBytesPerAccount, 42949672960);
assert.equal(execution.rawCapacityDeploymentStatus, 'DEPLOYED_VERIFIED');
assert.equal(accountConfig.retention.pinnedEvidenceEvictionAllowed, false);
assert.equal(accountConfig.retention.compactLedgerEvictionAllowed, false);
assert.equal(service.runtimeManager, "BT_DOCKER_COMPOSE");
assert.equal(service.unit, null);
assert.equal(service.composeProject, evidence.accountDeployment.btProject);
assert.equal(service.composePath, evidence.accountDeployment.composePath);
assert.equal(service.containerName, evidence.accountDeployment.containerName);
// Migration evidence is immutable: a later accepted reader release must carry
// an explicit replacement link, not rewrite the historical migration snapshot.
if (recovery) {
  assert.equal(service.releaseId, readerDeployment ? readerDeployment.accountReaderRelease.id : recovery.accountReaderRelease.id);
  assert.equal(service.releaseSha256, readerDeployment ? readerDeployment.accountReaderRelease.archiveSha256 : recovery.accountReaderRelease.archiveSha256);
  if (readerDeployment) assert.equal(service.releaseEvidence, opsPreparation.accountReaderConfigurationPreparation.activationEvidence);
  const previous = await read(recovery.accountReaderRelease.previousReleaseEvidence);
  assert.equal(recovery.accountReaderRelease.previousRelease, previous.accountReaderRelease.id);
  assert.equal(previous.accountReaderRelease.previousRelease, evidence.accountDeployment.releaseId);
  assert.equal(recovery.accountReaderRelease.previousReleaseRetained, true);
  assert.equal(recovery.accountReaderRelease.containerReleaseAndObserverModeReadBackVerified, true);
} else if (service.releaseId === evidence.accountDeployment.releaseId) {
  assert.equal(service.releaseSha256, evidence.accountDeployment.archiveSha256);
} else {
  assert.match(service.releaseEvidence, /^governance\/evidence\/[a-z0-9-]+\.json$/);
  const update = await read(service.releaseEvidence);
  assert.equal(update.accountReaderRelease.previousRelease, evidence.accountDeployment.releaseId);
  assert.equal(update.accountReaderRelease.previousReleaseRetained, true);
  assert.equal(update.accountReaderRelease.id, service.releaseId);
  assert.equal(update.accountReaderRelease.archiveSha256, service.releaseSha256);
  assert.equal(update.accountReaderRelease.containerReleaseAndObserverModeReadBackVerified, true);
  assert.equal(update.accountReaderRelease.healthy, true);
  assert.equal(update.accountReaderRelease.userStreamConnected, true);
  assert.equal(update.server.host, server.host);
  assert.equal(update.realOrdersAllowed, false);
  assert.equal(update.newEntriesBlocked, true);
  assert.equal(update.ordersOrderTestsLeverageChangesTransfersPerformed, false);
  assert.equal(accountConfig.retention.rawManagement, 'SEGMENTED_WRITER_OBSERVER');
  assert.equal(service.rawManagement, accountConfig.retention.rawManagement);
  assert.equal(service.rawDeletionAllowed, false);
  assert.equal(update.storage.accountReaderDeletesRaw, false);
  assert.equal(update.storage.canonicalRawRoot, accountConfig.retention.rawRoot);
  // The 60 GiB source change is not deployed yet. Preserve the old release's
  // actual 20 GiB evidence instead of treating a desired config as live state.
  assert.equal(update.storage.maximumRawPayloadBytes, infra.tickBboRetention.lastVerifiedDeployedRawMaximumBytes);
  assert.equal(update.storage.minimumFreeBytes, accountConfig.retention.minimumFreeBytes);
}
assert.equal(service.active, evidence.accountDeployment.containerRunning);
assert.equal(service.enabled, evidence.dockerBootEnabled);
assert.equal(evidence.accountDeployment.btStackRegistrationVerified, true);
assert.deepEqual(evidence.accountDeployment.publicPorts, []);
assert.equal(service.credentialValuesProvisioned, evidence.productionCredentialsCopied);
assert.equal(execution.credentialValuesProvisioned, evidence.productionCredentialsCopied);
assert.equal(service.binanceMainnetSignedAccountReadVerified, evidence.binance.accountReadVerified);
assert.equal(execution.signedAccountReadVerified, evidence.binance.accountReadVerified);
assert.equal(service.binanceUserDataStreamVerified, evidence.binance.userDataStreamVerified);
assert.equal(execution.userDataStreamVerified, evidence.binance.userDataStreamVerified);
if (evidence.accountDeployment.ready) {
  assert.equal(evidence.binance.accountReadVerified, true);
  assert.equal(evidence.binance.userDataStreamVerified, true);
  assert.equal(service.status, "READY_READ_ONLY_SHADOW");
  const activated = liveHost?.realOrdersActivated === true;
  assert.equal(execution.status, ownerPaused ? 'OWNER_PAUSED' : entryBlockedByIncident ? 'LIVE_HOST_ACCOUNT_ACTIVITY_REVIEW_REQUIRED_FLAT_PATCH_STAGED_NOT_ACTIVE'
    : liveHost ? liveHost.status === 'LIVE_HOST_ARMED_INTERMITTENT_FAIL_CLOSED_MARKET_JITTER_FIX_STAGED'
    ? "DEPLOYED_RUNNING_LIVE_HOST_ARMED_INTERMITTENT_FAIL_CLOSED_FIX_STAGED"
    : liveHost.status === 'LIVE_HOST_DISARMED_MARKET_JITTER_FIX_DEPLOYED_VERIFIED'
      ? "DEPLOYED_RUNNING_LIVE_HOST_DISARMED_JITTER_FIX_VERIFIED_READY_FOR_OWNER_REARM"
      : liveHost.status === 'LIVE_HOST_ARMED_MARKET_JITTER_FIX_VERIFIED_WAITING_ELIGIBLE_ENTRY'
        ? "DEPLOYED_RUNNING_LIVE_HOST_ARMED_JITTER_FIX_VERIFIED_WAITING_ELIGIBLE_ENTRY"
      : activated ? "DEPLOYED_RUNNING_LIVE_HOST_ARMED_WAITING_ELIGIBLE_ENTRY"
      : "DEPLOYED_RUNNING_LIVE_HOST_DISARMED_NOT_TRADING"
    : maintenanceHold ? "ACCOUNT_READER_RUNNING_SCANNER_SHADOW_STOPPED_CUTOVER_RECOVERY_REVIEW" : "DEPLOYED_RUNNING_READY_READ_ONLY_SHADOW");
  if (liveHost) {
    assert.ok(new Set(['LIVE_EXECUTION_HOST_RUNNING_AUTHORIZATION_DISABLED_NOT_TRADING',
      'LIVE_HOST_RUNNING_DISARMED_RECONNECT_COVERAGE_IN_PROGRESS',
      'LIVE_HOST_RUNNING_DISARMED_ACCOUNT_ACTIVITY_READY',
      'LIVE_HOST_RUNNING_DISARMED_INFRASTRUCTURE_READY',
      'LIVE_HOST_RUNNING_DISARMED_TRANSIENT_RECOVERY_VERIFIED',
      'LIVE_HOST_ARMED_WAITING_ELIGIBLE_ENTRY_VERIFIED',
      'LIVE_HOST_ARMED_INTERMITTENT_FAIL_CLOSED_MARKET_JITTER_FIX_STAGED',
      'LIVE_HOST_DISARMED_MARKET_JITTER_FIX_DEPLOYED_VERIFIED',
      'LIVE_HOST_ARMED_MARKET_JITTER_FIX_VERIFIED_WAITING_ELIGIBLE_ENTRY']).has(liveHost.status));
    assert.equal(liveHost.server, server.host);
    assert.equal(liveHost.containerState, 'running');
    assert.equal(liveHost.heartbeat.mode, 'LIVE');
    assert.equal(typeof liveHost.heartbeat.liveReady, 'boolean');
    if (activated) {
      assert.deepEqual(liveHost.authorizationStatus.enabled, true);
      assert.deepEqual(liveHost.authorizationStatus.entriesEnabled, true);
      assert.equal(liveHost.authorizationFile.ownerUid, 0);
      assert.equal(liveHost.authorizationFile.groupGid, 993);
      assert.equal(liveHost.authorizationFile.mode, '0640');
      assert.equal(liveHost.ownerOrTrustedOperatorActivated, true);
      assert.equal(liveHost.assistantActivatedTrading, false);
    } else assert.deepEqual(liveHost.authorization, { enabled: false, entriesEnabled: false });
    assert.equal(liveHost.realOrderRequestsAuthorized, activated);
    assert.equal(liveHost.realOrdersActivated, activated);
    if (liveHost.status === 'LIVE_HOST_DISARMED_MARKET_JITTER_FIX_DEPLOYED_VERIFIED') {
      assert.equal(liveHost.cutover.livePointerAtomicallyReplaced, true);
      assert.equal(liveHost.cutover.rollbackTriggered, false);
      assert.equal(liveHost.fix.captureContinuityMaximumLagMs, 5000);
      assert.equal(liveHost.fix.entryEvidenceMaximumLagMs, 2000);
      assert.equal(liveHost.readyForOwnerRearm, true);
      assert.equal(liveHost.consecutiveHeartbeats.length, 2);
      assert.equal(liveHost.consecutiveHeartbeats.every(row => row.infrastructureReady === true
        && row.orderAuthorizationStatus === 'DISABLED' && row.liveReady === false
        && row.openPositions === 0 && row.cycleError === null), true);
    }
    if (liveHost.status === 'LIVE_HOST_ARMED_MARKET_JITTER_FIX_VERIFIED_WAITING_ELIGIBLE_ENTRY') {
      assert.equal(liveHost.fix.captureContinuityMaximumLagMs, 5000);
      assert.equal(liveHost.fix.entryEvidenceMaximumLagMs, 2000);
      assert.equal(liveHost.consecutiveObservations.length, 2);
      assert.equal(liveHost.consecutiveObservations.every(row => row.liveReady === true
        && row.status === 'NO_ELIGIBLE_ENTRY' && row.openPositions === 0), true);
      assert.equal(liveHost.journal.unresolvedIntents, 0);
      assert.equal(liveHost.productionOrderTestRun, false);
    }
    assert.equal(execution.requestedExecution.serverDeployed, true);
    assert.equal(execution.requestedExecution.realOrdersActivated, activated);
    assert.equal(execution.realOrdersAllowed, !ownerPaused && activated);
    assert.equal(execution.newEntriesBlocked, ownerPaused || !activated || entryBlockedByIncident);
  }
} else {
  assert.equal(service.status, evidence.accountDeployment.status);
  assert.equal(execution.status, "DEPLOYED_ACCOUNT_AUTHENTICATION_BLOCKED");
}
if (entryBlockedByIncident) {
  const directed = execution.ownerDirectedBtcLongAttempt;
  const oneShot = await read(directed.authorization);
  assert.equal(latestIncident.authorizationId, 'OWNER-DIRECTIVE-S1-BTC-LONG-ONE-PERCENT-20260915');
  assert.equal(oneShot.status, 'CONSUMED_FAILSAFE_FLAT');
  assert.equal(oneShot.terminalResult.additionalEntryAuthorized, false);
  assert.equal(directed.status, 'TWO_GUARDED_ATTEMPTS_FAILSAFE_FLAT');
  assert.equal(directed.contractType, 'PERPETUAL');
  assert.equal(directed.symbol, 'BTCUSDT');
  assert.equal(directed.positionSide, 'LONG');
  assert.equal(directed.entryFillCount, 2);
  assert.equal(directed.emergencyExitFillCount, 2);
  assert.equal(directed.finalPositionQuantity, '0');
  assert.equal(directed.finalOpenOrdinaryOrders, 0);
  assert.equal(directed.finalOpenAlgoOrders, 0);
  assert.equal(directed.netResultUsdt, '-0.17201369');
  assert.equal(latestIncident.integrity.thirdEntryAttempted, false);
  assert.equal(latestIncident.repair.serverStaged, true);
  assert.equal(latestIncident.repair.serverActivated, false);
  assert.equal(execution.requestedExecution.status, 'ACCOUNT_ACTIVITY_REVIEW_REQUIRED_FLAT_PATCH_STAGED_NOT_ACTIVE');
  assert.equal(execution.requestedExecution.smallTrialPreparation.newEntriesBlocked, true);
  assert.equal(execution.requestedExecution.componentPreparation.productionHostCurrentCycleStatus, 'ENTRY_BLOCKED_INCIDENT');
  assert.equal(execution.requestedExecution.componentPreparation.productionHostEntryIncident, 'ACCOUNT_ACTIVITY_REVIEW_REQUIRED');
}
if (execution.candidateScanner.resumeEvidence) {
  const resumed = await read(execution.candidateScanner.resumeEvidence);
  assert.equal(resumed.status, "RUNNING_SYNCED");
  assert.equal(resumed.server, server.host);
  assert.equal(resumed.authorizationId, execution.candidateScanner.resumeAuthorizationId);
  if (priority) {
    const observationPath = execution.requestedExecution.componentPreparation.accountReaderPriorityPreparation.initialObservationEvidence;
    const observation = await read(observationPath);
    assert.equal(observation.deploymentEvidence, execution.priorityDeploymentEvidence);
    assert.equal(observation.scannerDegradationObserved, true);
    assert.equal(observation.sustainedSchedulingAccepted, false);
    assert.equal(execution.candidateScanner.status, ownerPaused ? 'OWNER_PAUSED' : scheduling ? 'RUNNING_SCHEDULING_ACCEPTANCE_PENDING' : 'RUNNING_DEGRADED');
  } else assert.equal(execution.candidateScanner.status, ownerPaused ? 'OWNER_PAUSED' : maintenanceHold ? "STOPPED_EXIT_143_MAINTENANCE_RECOVERY_REVIEW" : resumed.status);
  assert.equal(execution.candidateScanner.containerName, resumed.scannerDeployment.container);
  assert.equal(execution.candidateScanner.releaseId, scheduling ? scheduling.scannerRelease.id : priority ? priority.scannerRelease.id : recovery ? recovery.scannerRelease.id : resumed.release.id);
  if (priority) assert.equal(execution.candidateScanner.releaseSha256, scheduling ? scheduling.scannerRelease.archiveSha256 : priority.scannerRelease.archiveSha256);
  assert.equal(resumed.realOrdersAllowed, false);
  assert.equal(resumed.history.existingHistoryDeleted, false);
} else if (!evidence.scannerDeployment.serviceStarted) {
  assert.equal(execution.candidateScanner.status, "CODE_STAGED_STATE_AND_PUBLISHER_RESTORE_PENDING");
}
assert.equal(registry.wildcard, "*.qmt.luyuras.com");
assert.equal(new Set(registry.sites.map((site) => site.domain)).size, registry.sites.length);
for (const site of registry.sites) {
  for (const key of registry.requiredFieldsPerSite) assert.ok(Object.hasOwn(site, key), `DOMAIN_REGISTRY_MISSING_${key}`);
}
