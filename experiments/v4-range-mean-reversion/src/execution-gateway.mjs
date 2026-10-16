import path from "node:path";

import { loadKeychainCredentials } from "./demo-account.mjs";
import {
  DATA_SOURCE_AUTHORIZATION_PATH,
  GOVERNANCE_PATH,
  PROJECT_ROOT,
} from "./context.mjs";
import { invariant, readJson } from "./utils.mjs";

export const V4_TESTNET_CONFIRMATION = "BINANCE_DEMO_ONLY";
export const V4_EXECUTION_RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime", "orion-v4-binance-demo");
export const V4_EXECUTION_STATE_PATH = path.join(V4_EXECUTION_RUNTIME_ROOT, "state.json");
export const V4_EXECUTION_AUDIT_PATH = path.join(V4_EXECUTION_RUNTIME_ROOT, "audit.ndjson");
export const V4_EXECUTION_AUTHORIZATION_ID = "OWNER-DIRECTIVE-ORION-V4-BINANCE-USDM-DEMO-EXECUTION-PLATFORM-PARITY-20260820";

let corePromise;

async function core() {
  if (!corePromise) {
    process.env.AEGIS_BINANCE_DEMO_EXECUTION_PROFILE = "ORION_V4";
    corePromise = import("../../../integrations/binance-usdm-testnet/trading-gateway.mjs?profile=orion-v4");
  }
  return corePromise;
}

export async function assertV4ExecutionPlatformBoundary() {
  const [governance, authorization] = await Promise.all([
    readJson(GOVERNANCE_PATH),
    readJson(DATA_SOURCE_AUTHORIZATION_PATH),
  ]);
  const governed = governance?.orionV4RangeResearch ?? {};
  const domain = governance?.executionDomains?.orionV4RangeResearch ?? {};
  invariant(authorization?.id === V4_EXECUTION_AUTHORIZATION_ID, "V4_EXECUTION_AUTHORIZATION_INVALID");
  invariant(governed.dataSourceAuthorizationId === authorization.id, "V4_EXECUTION_GOVERNANCE_AUTHORIZATION_MISMATCH");
  invariant(domain.dataSourceAuthorizationId === authorization.id, "V4_EXECUTION_DOMAIN_AUTHORIZATION_MISMATCH");
  invariant(authorization.scope?.fixedBaseUrl === "https://demo-fapi.binance.com", "V4_EXECUTION_DEMO_HOST_MISMATCH");
  invariant(authorization.permissions?.orderEndpointCapabilityPrepared === true, "V4_EXECUTION_ORDER_CAPABILITY_NOT_PREPARED");
  invariant(authorization.permissions?.productionHostsAllowed === false && authorization.permissions?.realOrdersAllowed === false, "V4_EXECUTION_PRODUCTION_BOUNDARY_INVALID");
  invariant(authorization.isolation?.v3CredentialInheritanceAllowed === false && authorization.isolation?.v3RuntimeOrLedgerAccessAllowed === false, "V4_EXECUTION_V3_ISOLATION_INVALID");
  invariant(domain.exchangeCredentialsScope === "ORION_V4_DEDICATED_BINANCE_USDM_DEMO_EXECUTION_KEYCHAIN_ONLY", "V4_EXECUTION_KEYCHAIN_SCOPE_INVALID");
  invariant(domain.matchingEngineOrderSubmissionAllowed === false || governed.strategyExecutionActivationStatus === "ACTIVE_OWNER_AUTHORIZED_V4_STRATEGY", "V4_EXECUTION_ACTIVATION_CHAIN_INVALID");
  return { governance, authorization, governed, domain };
}

function withCredentials(options = {}) {
  return { ...options, credentials: options.credentials ?? loadKeychainCredentials() };
}

async function invoke(name, input, options = {}) {
  await assertV4ExecutionPlatformBoundary();
  const gateway = await core();
  invariant(typeof gateway[name] === "function", "V4_EXECUTION_GATEWAY_OPERATION_MISSING");
  return gateway[name](input, withCredentials(options));
}

export async function v4PlanAutomaticRiskSizedEntry(input, options) {
  return invoke("planAutomaticRiskSizedEntry", input, options);
}

export async function v4PlanReplacementRiskSizedEntry(input, options) {
  return invoke("planReplacementRiskSizedEntry", input, options);
}

export async function v4ValidateMarketEntry(input, options) {
  return invoke("validateMarketEntry", input, options);
}

export async function v4PlaceMarketEntry(input, options) {
  return invoke("placeMarketEntry", input, options);
}

export async function v4ReduceManagedPosition(input, options) {
  return invoke("reduceManagedPosition", input, options);
}

export async function v4ReplaceManagedProtectiveStop(input, options) {
  return invoke("replaceManagedProtectiveStop", input, options);
}

export async function v4CloseManagedPosition(input, options) {
  return invoke("closeManagedPosition", input, options);
}

export async function v4CancelManagedOrder(input, options) {
  return invoke("cancelManagedOrder", input, options);
}

export async function v4QueryManagedOrder(input, options) {
  return invoke("queryManagedOrder", input, options);
}

export async function v4EnsureSymbolInitialLeverage(input, options) {
  return invoke("ensureSymbolInitialLeverage", input, options);
}

export async function v4AlignApprovedSymbolLeverage(input, options = {}) {
  await assertV4ExecutionPlatformBoundary();
  const gateway = await core();
  return gateway.alignAllApprovedSymbolLeverage(input, withCredentials(options));
}

export async function v4RecoverPendingTradingOperations(options = {}) {
  await assertV4ExecutionPlatformBoundary();
  const gateway = await core();
  return gateway.recoverPendingTradingOperations(withCredentials(options));
}

export async function v4ReconcileManagedFeeEvidence(options = {}) {
  await assertV4ExecutionPlatformBoundary();
  const gateway = await core();
  return gateway.reconcileManagedFeeEvidence(withCredentials(options));
}

export async function v4LoadManagedTradingState() {
  await assertV4ExecutionPlatformBoundary();
  return (await core()).loadManagedTradingState();
}

export async function v4PersistManagedPositionMetadata(symbol, metadata, options) {
  await assertV4ExecutionPlatformBoundary();
  return (await core()).persistManagedPositionMetadata(symbol, metadata, options);
}

export async function v4FinalizeManagedPositionAbsentOnExchange(input, options) {
  return invoke("finalizeManagedPositionAbsentOnExchange", input, options);
}

export async function v4EvaluateManagedExchangeReconciliation(input) {
  await assertV4ExecutionPlatformBoundary();
  return (await core()).evaluateManagedExchangeReconciliation(input);
}

export async function v4VerifyTradingAuditLedger() {
  await assertV4ExecutionPlatformBoundary();
  return (await core()).verifyTradingAuditLedger();
}
