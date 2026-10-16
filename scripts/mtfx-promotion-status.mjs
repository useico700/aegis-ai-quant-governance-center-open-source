import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(ROOT, ".runtime/orion-v2-mtfx/state.json");
const AUTHORIZATION_PATH = path.join(ROOT, "governance/owner-authorizations/2026-08-05-mtfx-paper.json");
const OOS_PATH = path.join(ROOT, "evidence/mtfx/gate1-oos-latest.json");
const PARITY_PATH = path.join(ROOT, "evidence/mtfx/gate1-execution-latest.json");

async function optionalJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export function evaluateMtfxPromotion({ state, authorization, oos, parity }) {
  const closed = Object.values(state?.books ?? {}).flatMap((book) => book.closedPositions ?? []);
  const attributable = closed.filter((position) => position.executionEvidence === "BBO_CAPTURED" && position.bboCoverageComplete === true);
  const unknownPathCount = closed.filter((position) => position.executionEvidence !== "BBO_CAPTURED" || position.bboCoverageComplete !== true).length;
  const oosChecks = {
    positiveNetExpectancy: Number(oos?.netExpectedR) > 0,
    probabilityPositiveAtLeast90Pct: Number(oos?.probabilityPositiveNetExpectancy) >= 0.90,
    profitFactorAtLeast1_10: Number(oos?.profitFactor) >= 1.10,
    doubleCostStillNonNegative: Number(oos?.doubleCostProfitFactor) >= 1 && Number(oos?.doubleCostNetExpectedR) >= 0,
    positiveWalkForwardFoldsAtLeast60Pct: Number(oos?.positiveWalkForwardFoldFraction) >= 0.60,
    dsrAtLeast90Pct: Number(oos?.deflatedSharpeProbability) >= 0.90,
    pboAtMost20Pct: Number(oos?.probabilityBacktestOverfit) <= 0.20,
    concentrationAtMost30Pct: Number(oos?.maximumProfitConcentrationFraction) <= 0.30,
    removeBestFiveStillNonNegative: Number(oos?.netExpectedRWithoutBestFive) >= 0,
    removeTopCoinAndMonthStillNonNegative: Number(oos?.netExpectedRWithoutTopCoinAndMonth) >= 0,
  };
  const executionChecks = {
    atLeast30ForwardAttributableCloses: attributable.length >= 30,
    noUnknownIntrabarPaths: unknownPathCount === 0,
    orderCostFundingDedupeKillReplayParity: parity?.parityPass === true,
    abnormalDrillPass: parity?.abnormalDrillPass === true,
  };
  const oosCurrentVersion = oos?.strategyVersion === state?.strategyVersion;
  const parityCurrentVersion = parity?.strategyVersion === state?.strategyVersion;
  const allOos = oosCurrentVersion && Object.values(oosChecks).every(Boolean);
  const allExecution = parityCurrentVersion && Object.values(executionChecks).every(Boolean);
  const researchGatePassed = allOos && allExecution;
  const realOrdersAuthorized = authorization?.authorization?.realOrders === true;
  return {
    evaluatedAt: new Date().toISOString(),
    strategyVersion: state?.strategyVersion ?? authorization?.strategyVersion ?? null,
    decision: researchGatePassed ? "ELIGIBLE_FOR_OWNER_MICRO_LIVE_REVIEW" : "CONTINUE_PAPER",
    researchGatePassed,
    realOrdersAuthorized,
    realOrdersAllowed: false,
    automaticPromotionAllowed: false,
    fixedUniverse: state?.symbols ?? [],
    forwardEvidence: { totalClosedPositions: closed.length, attributableClosedPositions: attributable.length, unknownPathCount },
    oosEvidence: { presentForCurrentVersion: oosCurrentVersion, checks: oosChecks },
    executionEvidence: { presentForCurrentVersion: parityCurrentVersion, checks: executionChecks },
    nextBlockingGates: [
      ...(!oosCurrentVersion ? ["OOS:CURRENT_VERSION_REPORT_MISSING"] : []),
      ...Object.entries(oosChecks).filter(([, passed]) => !passed).map(([name]) => `OOS:${name}`),
      ...(!parityCurrentVersion ? ["EXECUTION:CURRENT_VERSION_REPORT_MISSING"] : []),
      ...Object.entries(executionChecks).filter(([, passed]) => !passed).map(([name]) => `EXECUTION:${name}`),
      ...(!realOrdersAuthorized ? ["OWNER:NEW_SEPARATE_MICRO_LIVE_AUTHORIZATION_REQUIRED"] : []),
    ],
    proposedInitialMicroLiveLimits: {
      maximumOpenPositions: 1,
      riskPerTradeFraction: 0.0005,
      maximumPortfolioRiskFraction: 0.0025,
      dailyLossStopFraction: 0.0025,
      weeklyLossStopFraction: 0.0075,
      signals: "A_GRADE_ONLY",
      note: "PROPOSAL_ONLY_NOT_AUTHORIZED",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [state, authorization, oos, parity] = await Promise.all([
    optionalJson(STATE_PATH), optionalJson(AUTHORIZATION_PATH), optionalJson(OOS_PATH), optionalJson(PARITY_PATH),
  ]);
  if (!state || !authorization) throw new Error("MTFX_RUNTIME_OR_AUTHORIZATION_MISSING");
  process.stdout.write(`${JSON.stringify(evaluateMtfxPromotion({ state, authorization, oos, parity }), null, 2)}\n`);
}
