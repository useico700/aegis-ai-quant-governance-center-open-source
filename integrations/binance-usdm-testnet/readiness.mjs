import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GATE_PATH = path.join(PROJECT_ROOT, "experiments/v2-execution-reality/testnet-gate.json");

function keychainRecordExists(service, account) {
  try {
    execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function evaluateTestnetReadiness({ keychainCheck = keychainRecordExists } = {}) {
  const gate = JSON.parse(await fs.readFile(GATE_PATH, "utf8"));
  const requirements = gate.requirements;
  const authorizationPath = path.resolve(PROJECT_ROOT, requirements.explicitOwnerAuthorizationFile);
  let authorization = null;
  try {
    authorization = JSON.parse(await fs.readFile(authorizationPath, "utf8"));
  } catch {}

  const authorizationValid = authorization?.id === "OWNER-DIRECTIVE-ORION-V3-BINANCE-USDM-DEMO-IMMEDIATE-TRADING-CUTOVER-20260818" &&
    authorization?.status === "ACTIVE_ON_DEMAND_BINANCE_DEMO_TRADING" &&
    authorization?.activation?.allowedNow === true &&
    authorization?.venueAndMethods?.realOrdersAllowed === false;
  const endpointValid = requirements.allowedHosts.length === 1 && requirements.allowedHosts[0] === "demo-fapi.binance.com";
  const keychainAccounts = Array.isArray(requirements.keychainAccounts)
    ? requirements.keychainAccounts
    : [requirements.keychainAccount].filter(Boolean);
  const checks = {
    explicitOwnerAuthorization: authorizationValid,
    testnetEndpointAllowlisted: endpointValid,
    dedicatedTestnetKeychainConfigured: keychainAccounts.length > 0 && keychainAccounts.every((account) => keychainCheck(requirements.keychainService, account)),
    methodsNarrowlyAllowlisted: JSON.stringify(requirements.allowedMethods) === JSON.stringify(["GET", "POST", "DELETE"]),
    orderValidationImplemented: gate.implementation.orderValidationImplemented === true,
    orderSubmissionImplemented: gate.implementation.orderSubmissionImplemented === true,
    orderCancellationImplemented: gate.implementation.orderCancellationImplemented === true,
    hardRiskImplemented: gate.implementation.protectiveStopRequired === true && gate.implementation.protectiveStopFailureRollbackImplemented === true,
    deterministicIdempotencyImplemented: gate.implementation.deterministicClientOrderIdImplemented === true,
    everyMutationNeedsLiteralConfirmation: gate.implementation.perCallWriteApprovalAndLiteralConfirmationRequired === true && requirements.literalMutationConfirmation === "BINANCE_DEMO_ONLY",
    automaticPaperMirroringDisabled: gate.implementation.automaticPaperToTestnetMirroringImplemented === false,
    paperStateMutationForbidden: gate.implementation.paperRuntimeMutationAllowed === false && gate.implementation.paperLedgerMutationAllowed === false,
    productionOrderAllowed: gate.implementation.productionOrderAllowed === true,
  };
  const ready = checks.explicitOwnerAuthorization &&
    checks.testnetEndpointAllowlisted &&
    checks.dedicatedTestnetKeychainConfigured &&
    checks.methodsNarrowlyAllowlisted &&
    checks.orderValidationImplemented &&
    checks.orderSubmissionImplemented &&
    checks.orderCancellationImplemented &&
    checks.hardRiskImplemented &&
    checks.deterministicIdempotencyImplemented &&
    checks.everyMutationNeedsLiteralConfirmation &&
    checks.automaticPaperMirroringDisabled &&
    checks.paperStateMutationForbidden &&
    !checks.productionOrderAllowed;

  return {
    gateId: gate.gateId,
    status: ready ? "READY_FOR_BINANCE_DEMO_TRADING" : gate.status,
    purpose: gate.purpose,
    endpointHost: "demo-fapi.binance.com",
    checks,
    secretMaterialReturned: false,
    credentialExposureStatus: requirements.credentialExposureStatus ?? "NOT_RECORDED",
    capabilityActivated: ready,
    productionOrdersSubmitted: false,
  };
}
