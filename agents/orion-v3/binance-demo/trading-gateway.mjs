import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson } from "../../orion-v2/paper/runtime-utils.mjs";
import {
  TESTNET_CONFIRMATION,
  cancelManagedOrder,
  closeManagedPosition,
  placeMarketEntry,
  queryManagedOrder,
  validateMarketEntry,
} from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export { TESTNET_CONFIRMATION };

export async function assertV3StrategyParity() {
  const [v3, v3Strategy, current] = await Promise.all([
    readJson(path.join(ROOT, "agents/orion-v3/binance-demo/config.json")),
    readJson(path.join(ROOT, "experiments/v3-mtf-high-frequency/config.json")),
    readJson(path.join(ROOT, "governance/current-state.json")),
  ]);
  if (v3?.strategyParity?.mode !== "OWNER_AUTHORIZED_V3_HIGH_FREQUENCY_DERIVATIVE" ||
      v3?.strategyParity?.unversionedLocalOverridesAllowed !== false ||
      v3?.strategyParity?.expectedStrategyVersion !== v3Strategy?.candidateVersion ||
      v3?.strategyParity?.expectedImplementationRevision !== v3Strategy?.implementationRevision ||
      current?.orionV3BinanceUsdmDemo?.strategyVersion !== v3Strategy?.candidateVersion ||
      current?.orionV3BinanceUsdmDemo?.implementationRevision !== v3Strategy?.implementationRevision ||
      v3?.riskPolicyAuthorizationId !== "OWNER-DIRECTIVE-ORION-V3-AGGRESSIVE-GROWTH-RISK-1PCT-10PCT-20260820" ||
      v3?.riskPolicyRevision !== "V3-RISK-2-AGGRESSIVE-GROWTH-1PCT-10PCT-20260820" ||
      v3Strategy?.riskPolicyAuthorizationId !== v3?.riskPolicyAuthorizationId ||
      v3Strategy?.riskPolicyRevision !== v3?.riskPolicyRevision ||
      current?.orionV3BinanceUsdmDemo?.riskPolicyAuthorizationId !== v3?.riskPolicyAuthorizationId ||
      current?.orionV3BinanceUsdmDemo?.riskPolicyRevision !== v3?.riskPolicyRevision ||
      v3Strategy?.risk?.maximumRiskPerIntersectionFraction !== 0.01 ||
      v3Strategy?.risk?.maximumPortfolioRiskFraction !== 0.1 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumRiskPerEntryFraction !== 0.01 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumManagedPortfolioRiskFraction !== 0.1 ||
      v3Strategy?.risk?.maximumLeverage !== 10 ||
      current?.orionV3BinanceUsdmDemo?.hardRisk?.maximumEffectiveNotionalLeverage !== 10) {
    throw new Error("ORION_V3_HIGH_FREQUENCY_STRATEGY_AUTHORIZATION_FAILED_CLOSED");
  }
  return {
    sourceAgent: "ORION V3",
    executionAgent: "ORION V3",
    baseReference: v3Strategy.baseStrategy?.implementationRevision,
    strategyVersion: v3Strategy.candidateVersion,
    implementationRevision: v3Strategy.implementationRevision,
    unversionedLocalOverridesAllowed: false,
  };
}

async function withParity(operation, input) {
  const strategyParity = await assertV3StrategyParity();
  return { ...(await operation(input)), strategyParity };
}

export function v3ValidateMarketEntry(input) {
  return withParity(validateMarketEntry, input);
}

export function v3PlaceMarketEntry(input) {
  return withParity(placeMarketEntry, input);
}

export function v3CloseManagedPosition(input) {
  return withParity(closeManagedPosition, input);
}

export function v3CancelManagedOrder(input) {
  return withParity(cancelManagedOrder, input);
}

export function v3QueryManagedOrder(input) {
  return withParity(queryManagedOrder, input);
}
