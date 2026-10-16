import path from "node:path";
import { fileURLToPath } from "node:url";

import { invariant, readJson, sha256, stableStringify } from "./utils.mjs";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CONFIG_PATH = path.join(PROJECT_ROOT, "experiments", "v4-range-mean-reversion", "config.json");
export const GOVERNANCE_PATH = path.join(PROJECT_ROOT, "governance", "current-state.json");
export const AUTHORIZATION_PATH = path.join(
  PROJECT_ROOT,
  "governance",
  "owner-authorizations",
  "2026-08-20-orion-v4-range-strategy-initialization.json",
);
export const DATA_SOURCE_AUTHORIZATION_PATH = path.join(
  PROJECT_ROOT,
  "governance",
  "owner-authorizations",
  "2026-08-20-orion-v4-binance-usdm-demo-execution-platform.json",
);

function allFalse(values) {
  return values.every((value) => value === false);
}

export function assertV4ResearchBoundary({ governance, authorization, dataSourceAuthorization, config }) {
  const governed = governance?.orionV4RangeResearch ?? {};
  const domain = governance?.executionDomains?.orionV4RangeResearch ?? {};
  const archivedAndSuperseded = governed.authorizationId !== authorization.id;
  invariant(authorization?.status === "ACTIVE", "V4_RG1_AUTHORIZATION_NOT_ACTIVE");
  invariant(config.authorizationId === authorization.id, "V4_RG1_CONFIG_AUTHORIZATION_MISMATCH");
  invariant(archivedAndSuperseded || governed.strategyVersion === config.candidateVersion, "V4_RG1_STRATEGY_VERSION_MISMATCH");
  invariant(archivedAndSuperseded || governed.implementationRevision === config.implementationRevision, "V4_RG1_IMPLEMENTATION_REVISION_MISMATCH");
  invariant(config.researchControls?.paperRiskPolicy === "NOT_AUTHORIZED_PENDING_OWNER_REVIEW", "V4_RG1_CONFIG_PAPER_RISK_NOT_FAIL_CLOSED");
  invariant(config.data?.gate === "GATE_0_SCREENING_ONLY", "V4_RG1_CONFIG_DATA_GATE_MISMATCH");
  invariant(config.data?.dataGapAction === "FAIL_CLOSED", "V4_RG1_DATA_GAP_POLICY_MISMATCH");
  invariant(config.data?.sameBarPathUnknown === true, "V4_RG1_SAME_BAR_UNCERTAINTY_MUST_BE_DECLARED");
  invariant(dataSourceAuthorization?.amends === authorization.id, "V4_RG1_DATA_SOURCE_AUTHORIZATION_CHAIN_INVALID");
  invariant(
    ["ACTIVE_AWAITING_DEDICATED_CREDENTIAL_PROVISIONING", "ACTIVE_PLATFORM_READY_AWAITING_STRATEGY_ACTIVATION", "ACTIVE_EXECUTION_PLATFORM_READY_STRATEGY_FAIL_CLOSED", "ACTIVE"].includes(dataSourceAuthorization?.status),
    "V4_RG1_DATA_SOURCE_AUTHORIZATION_NOT_ACTIVE",
  );
  invariant(governed.dataSourceAuthorizationId === dataSourceAuthorization.id, "V4_RG1_DATA_SOURCE_GOVERNANCE_MISMATCH");
  invariant(domain.dataSourceAuthorizationId === dataSourceAuthorization.id, "V4_RG1_DATA_SOURCE_DOMAIN_MISMATCH");
  invariant(governed.exchangeCredentialAccessAllowed === true, "V4_RG1_READ_ONLY_CREDENTIAL_ACCESS_NOT_AUTHORIZED");
  invariant(governed.signedRequestsAllowed === true, "V4_RG1_SIGNED_READ_ACCESS_NOT_AUTHORIZED");
  invariant(domain.exchangeCredentialsAllowed === true, "V4_RG1_DOMAIN_CREDENTIAL_ACCESS_NOT_AUTHORIZED");
  invariant(domain.signedRequestsAllowed === true && domain.apiKeysAllowed === true, "V4_RG1_DOMAIN_SIGNED_READ_NOT_AUTHORIZED");
  invariant(domain.exchangeCredentialsScope === "ORION_V4_DEDICATED_BINANCE_USDM_DEMO_EXECUTION_KEYCHAIN_ONLY", "V4_RG1_DOMAIN_CREDENTIAL_SCOPE_INVALID");
  invariant(domain.orderEndpointCapabilityPrepared === true, "V4_RG1_ORDER_CAPABILITY_NOT_PREPARED");
  invariant(dataSourceAuthorization.permissions?.orderEndpointCapabilityPrepared === true, "V4_RG1_DATA_SOURCE_ORDER_CAPABILITY_NOT_PREPARED");
  invariant(
    governed.venue?.strategyCapitalBaselineUsdt === dataSourceAuthorization.scope?.strategyCapitalBaselineUsdt,
    "V4_RG1_STRATEGY_CAPITAL_BASELINE_MISMATCH",
  );
  invariant(governed.venue?.nonBaselineAssetsIncluded === false, "V4_RG1_NON_BASELINE_ASSETS_MUST_BE_EXCLUDED");

  invariant(allFalse([
    config.execution?.residentScannerAllowed,
    config.execution?.forwardPaperOrdersAllowed,
    config.execution?.testnetOrdersAllowed,
    config.execution?.realOrdersAllowed,
    config.execution?.automaticPromotionAllowed,
    authorization.scope?.residentScannerStartAllowed,
    authorization.scope?.forwardPaperOrderGenerationAllowed,
    authorization.scope?.exchangeCredentialAccessAllowed,
    authorization.scope?.signedRequestsAllowed,
    authorization.scope?.testnetOrdersAllowed,
    authorization.scope?.realOrdersAllowed,
    authorization.scope?.productionEndpointsAllowed,
    authorization.scope?.v2OrV3RuntimeMutationAllowed,
    authorization.scope?.v2OrV3LedgerMutationAllowed,
    authorization.scope?.sharedPositionsOrOrdersAllowed,
  ]), "V4_RG1_PROHIBITED_CAPABILITY_ENABLED");
  invariant(governed.realOrdersAllowed === false && domain.realOrdersAllowed === false, "V4_RG1_CURRENT_PRODUCTION_BOUNDARY_INVALID");

  const replay = config.gate0Replay ?? {};
  invariant(replay.normalizedNotionalIsRiskAuthorization === false, "V4_RG1_NORMALIZED_NOTIONAL_CANNOT_AUTHORIZE_RISK");
  invariant(Number.isFinite(replay.normalizedNotionalPerTradeUsdt) && replay.normalizedNotionalPerTradeUsdt > 0, "V4_RG1_NORMALIZED_NOTIONAL_INVALID");
  invariant(Number.isFinite(replay.takerFeeRatePerFill) && replay.takerFeeRatePerFill >= 0 && replay.takerFeeRatePerFill < 0.01, "V4_RG1_FEE_RATE_INVALID");
  invariant(Number.isFinite(replay.adverseSlippageRatePerFill) && replay.adverseSlippageRatePerFill >= 0 && replay.adverseSlippageRatePerFill < 0.01, "V4_RG1_SLIPPAGE_RATE_INVALID");
  invariant(replay.firstTargetExitFraction + replay.secondTargetExitFraction === 1, "V4_RG1_TARGET_FRACTIONS_INVALID");
  invariant(replay.sameBarAmbiguityAction === "EXCLUDE_WHOLE_TRADE_FROM_PRIMARY_PERFORMANCE", "V4_RG1_SAME_BAR_ACTION_NOT_FAIL_CLOSED");
  invariant(replay.queuePositionKnown === false && replay.spreadModeled === false && replay.fundingModeled === false, "V4_RG1_OHLC_LIMITATIONS_NOT_EXPLICIT");
  return true;
}

export async function loadV4Context() {
  const [governance, authorization, dataSourceAuthorization, config] = await Promise.all([
    readJson(GOVERNANCE_PATH),
    readJson(AUTHORIZATION_PATH),
    readJson(DATA_SOURCE_AUTHORIZATION_PATH),
    readJson(CONFIG_PATH),
  ]);
  assertV4ResearchBoundary({ governance, authorization, dataSourceAuthorization, config });
  return {
    governance,
    authorization,
    dataSourceAuthorization,
    config,
    hashes: {
      governance: sha256(stableStringify(governance)),
      authorization: sha256(stableStringify(authorization)),
      dataSourceAuthorization: sha256(stableStringify(dataSourceAuthorization)),
      config: sha256(stableStringify(config)),
    },
  };
}
