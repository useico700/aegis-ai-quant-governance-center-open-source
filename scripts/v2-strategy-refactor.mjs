import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = path.join(
  ROOT,
  "experiments/v2-strategy-refactor-0.3.0/config.json",
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateRefactorConfig(config) {
  invariant(config?.schemaVersion === 1, "CONFIG_SCHEMA_VERSION");
  invariant(config?.authorization?.paperExecutionAllowed === false, "PAPER_EXECUTION_MUST_BE_FALSE");
  invariant(config?.authorization?.realExecutionAllowed === false, "REAL_EXECUTION_MUST_BE_FALSE");
  invariant(config?.authorization?.automaticRestartAllowed === false, "AUTOMATIC_RESTART_MUST_BE_FALSE");
  invariant(config?.walkForward?.finalBlindOpened === false, "FINAL_BLIND_MUST_REMAIN_CLOSED");
  invariant(config?.primaryEvent?.interval === "15m", "PRIMARY_EVENT_MUST_BE_15M");
  invariant(config?.primaryEvent?.tickBboRequiredForPromotion === true, "TICK_BBO_GATE_REQUIRED");

  const cells = config?.phase1TimeframeCells ?? [];
  invariant(cells.length === 4, "PHASE1_REQUIRES_FOUR_CELLS");
  const ids = new Set(cells.map((cell) => cell.id));
  for (const id of [
    "TF0_15M_ONLY",
    "TF1_15M_PLUS_4H",
    "TF2_15M_PLUS_1H",
    "TF3_15M_PLUS_4H_PLUS_1H",
  ]) invariant(ids.has(id), `MISSING_CELL_${id}`);

  const controls = cells.filter((cell) => cell.primaryControl === true);
  invariant(controls.length === 1 && controls[0].id === "TF0_15M_ONLY", "INVALID_PRIMARY_CONTROL");
  invariant(config?.promotionGate?.minimumOosNetExpectancyRExclusive === 0, "EXPECTANCY_GATE_CHANGED");
  invariant(config?.promotionGate?.minimumProbabilityPositiveExpectancy >= 0.9, "PROBABILITY_GATE_TOO_LOW");
  invariant(config?.promotionGate?.minimumProfitFactor >= 1.1, "PROFIT_FACTOR_GATE_TOO_LOW");
  invariant(config?.promotionGate?.minimumTwoXCostNetExpectancyR >= 0, "TWO_X_EXPECTANCY_GATE_TOO_LOW");
  invariant(config?.promotionGate?.tickBboExecutionReplayRequired === true, "EXECUTION_REPLAY_GATE_REQUIRED");
  invariant(config?.promotionGate?.ownerApprovalRequired === true, "OWNER_APPROVAL_GATE_REQUIRED");
  return true;
}

export function breakoutDirection({ close, priorHigh, priorLow, atr, bufferAtr }) {
  if (![close, priorHigh, priorLow, atr, bufferAtr].every(Number.isFinite) || atr <= 0) {
    return { direction: 0, reason: "INVALID_BREAKOUT_INPUT" };
  }
  const buffer = atr * bufferAtr;
  const long = close > priorHigh + buffer;
  const short = close < priorLow - buffer;
  if (long === short) return { direction: 0, reason: "NO_UNIQUE_15M_BREAKOUT" };
  return { direction: long ? 1 : -1, reason: "15M_BREAKOUT" };
}

export function evaluateTimeframeCell({ direction, fourHourDirection = 0, oneHourScore = 0 }, cell) {
  invariant([1, -1].includes(direction), "PRIMARY_DIRECTION_REQUIRED");
  let riskMultiplier = 1;
  const reasons = [];

  if (cell.fourHourMode === "HARD_DIRECTIONAL_AGREEMENT") {
    if (fourHourDirection !== direction) {
      return { eligible: false, riskMultiplier: 0, reason: "FOUR_HOUR_DISAGREEMENT" };
    }
    reasons.push("FOUR_HOUR_AGREES");
  } else if (cell.fourHourMode === "SOFT_RISK_MULTIPLIER") {
    const relation = fourHourDirection === direction ? "agree" : fourHourDirection === 0 ? "neutral" : "oppose";
    riskMultiplier = cell.riskMultipliers?.[relation];
    invariant(Number.isFinite(riskMultiplier) && riskMultiplier >= 0 && riskMultiplier <= 1, "INVALID_SOFT_RISK_MULTIPLIER");
    reasons.push(`FOUR_HOUR_${relation.toUpperCase()}`);
  } else {
    invariant(cell.fourHourMode === "OFF", "UNKNOWN_FOUR_HOUR_MODE");
  }

  if (cell.oneHourMode === "HARD_MINIMUM_SCORE") {
    if (oneHourScore < cell.minimumOneHourScore) {
      return { eligible: false, riskMultiplier: 0, reason: "ONE_HOUR_SCORE_BELOW_MINIMUM" };
    }
    reasons.push("ONE_HOUR_SCORE_PASS");
  } else {
    invariant(cell.oneHourMode === "OFF", "UNKNOWN_ONE_HOUR_MODE");
  }

  return {
    eligible: true,
    riskMultiplier,
    reason: reasons.length ? reasons.join("+") : "15M_ONLY",
  };
}

export async function loadRefactorConfig(configPath = DEFAULT_CONFIG_PATH) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  validateRefactorConfig(config);
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = await loadRefactorConfig(process.argv[2] ?? DEFAULT_CONFIG_PATH);
  process.stdout.write(`${JSON.stringify({
    status: "VALID",
    experimentId: config.experimentId,
    candidateVersion: config.candidateVersion,
    executionAllowed: false,
    phase1Cells: config.phase1TimeframeCells.map((cell) => cell.id),
  }, null, 2)}\n`);
}
