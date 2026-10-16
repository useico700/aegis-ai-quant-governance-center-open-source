import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "./runtime-utils.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const CONFIG_PATH = path.join(ROOT, "experiments/v4-mtfx-r20/config.json");
export const SOURCE_STRATEGY_PATH = path.join(ROOT, "experiments/v2-mtf-trendline-intersection/config.json");
export const GOVERNANCE_PATH = path.join(ROOT, "governance/current-state.json");
export const AUTHORIZATION_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-29-orion-v4-mtfx-r22-v2-full-rule-parity.json");
export const SOURCE_AUTHORIZATION_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-28-mtfx-r22-balanced-profit-realization.json");
export const PLATFORM_AUTHORIZATION_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-20-orion-v4-binance-usdm-demo-execution-platform.json");
export const CALENDAR_PATH = path.join(ROOT, "agents/nexus/data/mtfx-tier1-event-calendar.json");

function invariant(condition, code) { if (!condition) throw new Error(code); }

export function validateMtfxR20Boundary({ governance, authorization, sourceAuthorization, platformAuthorization, config, sourceStrategy }) {
  const governed = governance?.orionV4RangeResearch ?? {};
  const domain = governance?.executionDomains?.orionV4RangeResearch ?? {};
  invariant(authorization?.status === "ACTIVE" && authorization?.id === config?.authorizationId, "V4_MTFX_AUTHORIZATION_INVALID");
  invariant(authorization?.riskPolicy?.authorizationId === config?.riskPolicy?.authorizationId, "V4_MTFX_RISK_AUTHORIZATION_INVALID");
  invariant(authorization?.riskPolicy?.revision === config?.riskPolicy?.revision, "V4_MTFX_RISK_POLICY_REVISION_MISMATCH");
  invariant(governed.authorizationId === authorization.id && domain.authorizationId === authorization.id, "V4_MTFX_GOVERNANCE_AUTHORIZATION_MISMATCH");
  invariant(governed.strategyVersion === config.candidateVersion, "V4_MTFX_GOVERNED_STRATEGY_VERSION_MISMATCH");
  invariant(governed.implementationRevision === config.implementationRevision, "V4_MTFX_GOVERNED_REVISION_MISMATCH");
  invariant(governed.activeExecutionStrategyRevision === config.implementationRevision, "V4_MTFX_ACTIVE_REVISION_MISMATCH");
  invariant(governed.strategyExecutionActivationStatus === "ACTIVE_OWNER_AUTHORIZED_V4_STRATEGY", "V4_MTFX_STRATEGY_NOT_ACTIVE");
  invariant(governed.residentScannerAllowed === true && governed.matchingEngineOrderSubmissionAllowed === true, "V4_MTFX_EXECUTION_NOT_ACTIVE");
  invariant(domain.residentScannerAllowed === true && domain.matchingEngineOrderSubmissionAllowed === true, "V4_MTFX_DOMAIN_NOT_ACTIVE");
  invariant(config.venue?.fixedBaseUrl === "https://demo-fapi.binance.com", "V4_MTFX_HOST_MISMATCH");
  invariant(sourceAuthorization?.status === "ACTIVE" && sourceAuthorization?.id === config.sourceStrategy.authorizationId, "V4_MTFX_SOURCE_AUTHORIZATION_INVALID");
  invariant(sourceStrategy?.candidateVersion === config.sourceStrategy.strategyVersion && sourceStrategy?.implementationRevision === config.sourceStrategy.implementationRevision, "V4_MTFX_SOURCE_REVISION_MISMATCH");
  invariant(config.sourceStrategy.runtimePositionOrderLedgerAccessAllowed === false && config.sourceStrategy.runtimeMutationAllowed === false, "V4_MTFX_V2_ISOLATION_INVALID");
  invariant(config.risk.maximumRiskPerEntryFraction === 0.01 && config.risk.maximumPortfolioRiskFraction === 0.05, "V4_MTFX_RISK_MISMATCH");
  invariant(config.risk.riskSizingUtilizationFraction === 0.98, "V4_MTFX_RISK_UTILIZATION_MISMATCH");
  invariant(authorization.riskPolicy?.maximumRiskPerEntryFraction === config.risk.maximumRiskPerEntryFraction && authorization.riskPolicy?.maximumManagedPortfolioRiskFraction === config.risk.maximumPortfolioRiskFraction, "V4_MTFX_RISK_FIELDS_MISMATCH");
  invariant(authorization.riskPolicy?.riskSizingUtilizationFraction === config.risk.riskSizingUtilizationFraction, "V4_MTFX_RISK_UTILIZATION_AUTHORIZATION_MISMATCH");
  invariant(governed.riskPolicy?.authorizationId === authorization.id && governed.riskPolicy?.revision === authorization.riskPolicy.revision, "V4_MTFX_GOVERNED_RISK_POLICY_MISMATCH");
  invariant(governed.executionPlatformHardRiskCeiling?.maximumRiskPerEntryFraction === 0.01 && governed.executionPlatformHardRiskCeiling?.maximumManagedPortfolioRiskFraction === 0.05, "V4_MTFX_GOVERNED_RISK_CEILING_MISMATCH");
  invariant(config.risk.maximumEffectiveNotionalLeverage === 4 && config.risk.maximumOpenPositionsTotal === 10, "V4_MTFX_HARD_LIMIT_MISMATCH");
  invariant(config.universe.symbols.length === 10 && config.universe.symbols.every((symbol) => authorization.executionScope.fixedUniverse.includes(symbol)), "V4_MTFX_UNIVERSE_MISMATCH");
  invariant(JSON.stringify(config.portfolioProfitProtection?.excludedSymbols) === JSON.stringify(["BTCUSDT", "ETHUSDT"]), "V4_R21_BTC_ETH_EXCLUSION_INVALID");
  invariant(config.portfolioProfitProtection?.eligibleSymbols?.length === 8 && !config.portfolioProfitProtection.eligibleSymbols.includes("BTCUSDT") && !config.portfolioProfitProtection.eligibleSymbols.includes("ETHUSDT"), "V4_R21_ELIGIBLE_UNIVERSE_INVALID");
  invariant(platformAuthorization?.permissions?.orderEndpointCapabilityPrepared === true, "V4_MTFX_PLATFORM_NOT_READY");
  if (config.executionParity?.enabled === true) {
    invariant(authorization?.fullRuleParity?.targetImplementationRevision === config.implementationRevision, "V4_EXECUTION_PARITY_TARGET_REVISION_MISMATCH");
    invariant(authorization?.fullRuleParity?.targetForwardCohortId === config.evaluationIsolation.forwardCohortId, "V4_EXECUTION_PARITY_COHORT_MISMATCH");
    invariant(config.executionParity.authorizationId === authorization.id, "V4_EXECUTION_PARITY_CONFIG_AUTHORIZATION_MISMATCH");
    invariant(config.executionParity.causalBboRequired === true && config.executionParity.candidateLifecycleDurable === true, "V4_EXECUTION_PARITY_REQUIRED_SEMANTICS_MISSING");
    invariant(governed.v2FullRuleParityDirective?.authorizationId === authorization.id && ["CUTOVER_VALIDATION_IN_PROGRESS", "ACTIVE_VERIFIED_RUNNING_RECONCILED"].includes(governed.v2FullRuleParityDirective?.status), "V4_EXECUTION_PARITY_NOT_GOVERNED_ACTIVE_OR_VALIDATING");
  }
  return true;
}

export async function loadMtfxR20Context() {
  const [governance, authorization, sourceAuthorization, platformAuthorization, config, sourceStrategy, calendar] = await Promise.all([
    readJson(GOVERNANCE_PATH), readJson(AUTHORIZATION_PATH), readJson(SOURCE_AUTHORIZATION_PATH), readJson(PLATFORM_AUTHORIZATION_PATH),
    readJson(CONFIG_PATH), readJson(SOURCE_STRATEGY_PATH), readJson(CALENDAR_PATH),
  ]);
  validateMtfxR20Boundary({ governance, authorization, sourceAuthorization, platformAuthorization, config, sourceStrategy });
  return { governance, authorization, sourceAuthorization, platformAuthorization, config, sourceStrategy, calendar };
}

export const loadRg2Context = loadMtfxR20Context;
