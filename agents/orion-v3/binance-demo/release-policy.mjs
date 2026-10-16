export const HF11_REVISION = "MTFX-V3-HF11-TRUE-4H-MARKET-STATE-GATE";
export const HF13_REVISION = "MTFX-V3-HF13-DUAL-Z-STRUCTURE-GATE";
export const HF13_COHORT = "ORION-V3-HF13-DUAL-Z-FORWARD-20260914";
export const HF13_AUTHORIZATION = "OWNER-DIRECTIVE-ORION-V3-HF13-DUAL-Z-20260914";
export const HF14_REVISION = "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE";
export const HF14_COHORT = "ORION-V3-HF14-SINGLE-Z-FORWARD-20260914";
export const HF14_AUTHORIZATION = "OWNER-DIRECTIVE-ORION-V3-HF14-SINGLE-Z-20260914";

const RELEASES = Object.freeze({
  [HF11_REVISION]: Object.freeze({
    cohort: "ORION-V3-HF11-TRUE-4H-MARKET-STATE-GATE-FORWARD-20260826",
    authorizationPath: "governance/owner-authorizations/2026-08-26-orion-v3-hf11-true-4h-market-state-gate.json",
    residentScope: "ACCOUNT_SCAN_AND_V3_HF11_AUTOMATED_BINANCE_DEMO_EXECUTION",
  }),
  [HF13_REVISION]: Object.freeze({
    cohort: HF13_COHORT,
    authorizationPath: "governance/owner-authorizations/2026-09-14-orion-v3-hf13-dual-z.json",
    residentScope: "ACCOUNT_SCAN_AND_V3_HF13_AUTOMATED_BINANCE_DEMO_EXECUTION",
  }),
  [HF14_REVISION]: Object.freeze({
    cohort: HF14_COHORT,
    authorizationPath: "governance/owner-authorizations/2026-09-14-orion-v3-hf14-single-z.json",
    residentScope: "ACCOUNT_SCAN_AND_V3_HF14_AUTOMATED_BINANCE_DEMO_EXECUTION",
  }),
});

export const releasePolicy = (config) => RELEASES[config?.implementationRevision] ?? null;
export const requiresDualZ = (config) => config?.implementationRevision === HF13_REVISION;
export const requiresSingleZ = (config) => config?.implementationRevision === HF14_REVISION;
export const requiresPrimaryZ = (config) => requiresDualZ(config) || requiresSingleZ(config);
export const entryDecisionInterval = (config) => requiresSingleZ(config) ? "15m" : "5m";

export function validateDualZPolicy(config) {
  if (!requiresPrimaryZ(config)) return config?.dualZ?.enabled !== true;
  const z = config.dualZ;
  const releaseSpecific = requiresDualZ(config)
    ? config.implementationDirectiveId === HF13_AUTHORIZATION && z?.bothRequired === true &&
      z?.primaryRequired !== false && z?.opposingComparisonOnly !== true
    : config.implementationDirectiveId === HF14_AUTHORIZATION && z?.bothRequired === false &&
      z?.primaryRequired === true && z?.opposingComparisonOnly === true;
  return releaseSpecific && z?.enabled === true &&
    z?.primaryInterval === "1h" && z?.opposingInterval === "15m" &&
    z?.pointSource === "CONFIRMED_NATIVE_OHLC_HIGH_LOW" &&
    z?.priceOrderUp === "A<C<B<D" && z?.priceOrderDown === "A>C>B>D" &&
    z?.anchorBinding === "ORIGINAL_TRENDLINE_A_C" &&
    z?.extremePolicy === "UNIQUE_THREE_LEG_ENVELOPE" &&
    z?.confirmationPolicy === "INHERIT_CAUSAL_STRUCTURAL_PIVOTS" &&
    z?.scanOrder === "LATEST_D_THEN_PRICE_DISTANCE_THEN_SCALE" &&
    z?.pendingPriorRevisionAllowed === false &&
    Number.isFinite(Date.parse(z?.forwardOnlyFrom ?? ""));
}
