export const STUDY_ID = "V2-ACCOUNT-COMPOUND-ABC-20260906";
export const CANDIDATE_REVISION = "V2-ACCOUNT-COMPOUND-C1-20260906";
export const AUTHORIZATION_ID = "OWNER-DIRECTIVE-V2-ACCOUNT-COMPOUND-ABC-SHADOW-20260906";
export const BASELINE_REVISION = "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION";

export const C_POLICY = Object.freeze({
  initialFloorFraction: 0.99,
  profitActivationFraction: 0.05,
  profitLockFraction: 0.6,
  maximumRiskFraction: 0.0075,
  cushionRiskUseFraction: 0.25,
  maximumPerIntersectionFraction: 0.01,
  maximumPortfolioRiskFraction: 0.05,
  maximumLeverage: 4,
  maximumPositions: 10,
  takerFeeRate: 0.0007,
  adverseSlippageRate: 0.0002,
  stressGapFraction: 0.005,
  maximumCompleteLifecycleCostR: 0.12,
  maximumSignalAgeMs: 180_000,
  maximumEntryDisplacementBps: 50,
  maximumQuoteAgeMs: 1_000,
  maximumDepthAgeMs: 1_000,
  maximumFundingAgeMs: 120_000,
  maximumMetadataAgeMs: 86_400_000,
  abnormalLoss: Object.freeze({ yellowAboveR: 1.2, orangeAboveR: 1.5, redAboveR: 2 }),
  r22: Object.freeze({
    halfNetR: Object.freeze({ threshold: 0.5, closeFraction: 0.4, aggregateFloorR: 0.15 }),
    oneNetR: Object.freeze({ threshold: 1, closeFraction: 0.25, aggregateFloorR: 0.6 }),
    twoNetR: Object.freeze({ threshold: 2, closeFraction: 0.2, runnerFraction: 0.15 }),
  }),
  realizedOnlyCompounding: true,
  correlatedRiskShared: true,
  executionInputAllowed: false,
  kellySizingActivationAllowed: false,
  automaticPromotionAllowed: false,
});

export const SOURCE_SCOPE = Object.freeze({
  mode: "BASELINE_EXECUTED_OPPORTUNITY_SUBSET_ONLY",
  baselineLedger: "V2_APPEND_ONLY_PAPER_LEDGER_READ_ONLY",
  fullIndependentSignalUniverse: false,
  baselineRejectedOpportunitiesSynthesized: false,
  historicalBackfillAllowed: false,
  carryInDisposition: "EXCLUDED_NOT_COPIED_AS_CANDIDATE_ENTRIES",
  inferenceBoundary: "INCOMPLETE_FOR_FULL_ACCOUNT_OR_ANNUAL_PROBABILITY_INFERENCE",
});

export const REQUIRED_STRATEGY_GATES = Object.freeze(["R13", "R15", "R19", "R20", "R21", "R22"]);
