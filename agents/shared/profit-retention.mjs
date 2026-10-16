// Prospective management overlay. A durable entry plan freezes this policy;
// importing the helper must never opt an existing position into new rules.
export const S2_PROFIT_RETENTION_POLICY = Object.freeze({
  revision: 'S2-P5-AGGREGATE-NET-PROFIT-LOCK-1',
  retainPeakFraction: 0.7,
  activateAfter: 'SOFT_CONFIRMED',
  action: 'HARVEST_MAIN_TO_RUNNER',
  runnerRemainingFraction: 0.15,
  stages: Object.freeze([
    Object.freeze({ flag: 'softLockTaken', r: 0.5, cumulative: 60, floor: 0.15, label: 'SOFT' }),
    Object.freeze({ flag: 'firstPartialTaken', r: 1, cumulative: 80, floor: 0.60, label: 'ONE_R' }),
    Object.freeze({ flag: 'secondPartialTaken', r: 2, cumulative: 85, floor: 0.60, label: 'TWO_R' }),
  ]),
});

export const S1_PROFIT_RETENTION_POLICY = Object.freeze({
  revision: 'S1-P5-AGGREGATE-NET-PROFIT-LOCK-1',
  retainPeakFraction: 0.7,
  activateAfter: 'SOFT_CONFIRMED',
  action: 'HARVEST_MAIN_TO_RUNNER',
  runnerRemainingFraction: 0.15,
  stages: Object.freeze([
    Object.freeze({ flag: 'softLockTaken', r: 0.5, cumulative: 60, floor: 0.15, label: 'SOFT' }),
    Object.freeze({ flag: 'firstPartialTaken', r: 1, cumulative: 80, floor: 0.60, label: 'ONE_R' }),
    Object.freeze({ flag: 'secondPartialTaken', r: 2, cumulative: 85, floor: 0.60, label: 'TWO_R' }),
  ]),
});

const adaptiveRevisions = Object.freeze({ S1: 'S1-P5-ADAPTIVE-FIRST-HARVEST-1', S2: 'S2-P5-ADAPTIVE-FIRST-HARVEST-1' });
export const isAdaptiveFirstHarvestPolicy = policy => Object.values(adaptiveRevisions).includes(policy?.revision);
const baseFor = account => account === 'S1' ? S1_PROFIT_RETENTION_POLICY : S2_PROFIT_RETENTION_POLICY;
const policyError = () => { throw new Error('PROFIT_RETENTION_POLICY_INVALID'); };
const stagesFor = firstR => [
  { flag: 'softLockTaken', r: firstR, cumulative: 60, floor: 0.3 * firstR, label: 'SOFT' },
  { flag: 'firstPartialTaken', r: 1, cumulative: 80, floor: 0.60, label: 'ONE_R' },
  { flag: 'secondPartialTaken', r: 2, cumulative: 85, floor: 0.60, label: 'TWO_R' },
];

// The price reference, not an estimated R or today's policy, is frozen in the
// durable plan. A crossed historical extreme has no forward target (null).
export function createAdaptiveFirstHarvestPolicy({ account, firstHarvestTarget = null }) {
  if (!Object.hasOwn(adaptiveRevisions, account)) policyError();
  const policy = { ...baseFor(account), revision: adaptiveRevisions[account], account,
    firstHarvestTarget: firstHarvestTarget === null ? null : structuredClone(firstHarvestTarget),
    firstHarvestResolution: null, firstHarvestInvalid: false, stages: stagesFor(0.5) };
  validateProfitRetentionPolicy(policy);
  return policy;
}

function resolvedFirstHarvest(target, evidence) {
  const { direction, entry, entryFeePerUnit, initialRiskPerUnit, takerFeeRate, adverseSlippageRate } = evidence;
  if (![1, -1].includes(direction) || ![entry, entryFeePerUnit, initialRiskPerUnit, takerFeeRate, adverseSlippageRate].every(Number.isFinite)
    || entry <= 0 || initialRiskPerUnit <= 0 || entryFeePerUnit < 0
    || takerFeeRate < 0 || takerFeeRate >= 1 || adverseSlippageRate < 0 || adverseSlippageRate >= 1
    || (target && target.direction !== direction)) policyError();
  const exit = target ? target.targetPrice * (1 - direction * adverseSlippageRate) : null;
  const targetNetR = target ? (direction * (exit - entry) - entryFeePerUnit - exit * takerFeeRate) / initialRiskPerUnit : null;
  if (target && !Number.isFinite(targetNetR)) policyError();
  // Bad actual fills/costs cannot make the frozen reference profitable by
  // moving it. This is a managed protective exit, never a policy exception.
  const invalid = targetNetR !== null && targetNetR <= 0;
  return { targetNetR, firstR: invalid ? 0 : Math.min(0.5, targetNetR ?? 0.5), invalid };
}

export function validateProfitRetentionPolicy(policy, { allowUnresolved = true } = {}) {
  if (!policy) return true;
  if (isAdaptiveFirstHarvestPolicy(policy)) {
    const base = baseFor(policy.account), target = policy.firstHarvestTarget;
    if (adaptiveRevisions[policy.account] !== policy.revision
      || ['retainPeakFraction', 'activateAfter', 'action', 'runnerRemainingFraction'].some(key => policy[key] !== base[key])) policyError();
    if (target !== null && (!target || target.account !== policy.account || ![1, -1].includes(target.direction)
      || target.revision !== 'S1-S2-ENTRY-RECONFIRM-ROOM-1' || target.source !== 'CLOSED_1H_EXTREME_INSIDE_ONE_TICK'
      || ![target.referencePrice, target.targetPrice, target.estimatedTargetNetR].every(value => Number.isFinite(value) && value > 0)
      || target.direction * (target.referencePrice - target.targetPrice) <= 0 || target.firstStageCapR !== 0.5
      || !Number.isSafeInteger(target.referenceWindowStart) || target.referenceWindowStart < 0 || target.referenceWindowStart % 3600000 !== 0
      || target.referenceWindowEnd !== target.referenceWindowStart + 6 * 3600000 - 1
      || !/^[a-f0-9]{64}$/.test(target.referenceBarsHash))) policyError();
    const evidence = policy.firstHarvestResolution;
    if (evidence === null) {
      if (!allowUnresolved || policy.firstHarvestInvalid !== false || JSON.stringify(policy.stages) !== JSON.stringify(stagesFor(0.5))) policyError();
    } else {
      if (!evidence || evidence.status !== 'ACTUAL_FILL_RESOLVED') policyError();
      const resolved = resolvedFirstHarvest(target, evidence);
      if (evidence.targetNetR !== resolved.targetNetR || policy.firstHarvestInvalid !== resolved.invalid
        || JSON.stringify(policy.stages) !== JSON.stringify(stagesFor(resolved.firstR))) policyError();
    }
    return true;
  }
  const expected = policy.revision === S1_PROFIT_RETENTION_POLICY.revision ? S1_PROFIT_RETENTION_POLICY
    : policy.revision === S2_PROFIT_RETENTION_POLICY.revision ? S2_PROFIT_RETENTION_POLICY : null;
  if (!expected
    || policy.retainPeakFraction !== expected.retainPeakFraction
    || policy.activateAfter !== expected.activateAfter
    || policy.action !== expected.action
    || policy.runnerRemainingFraction !== expected.runnerRemainingFraction
    || JSON.stringify(policy.stages) !== JSON.stringify(expected.stages)) policyError();
  return true;
}

export function resolveProfitRetentionPolicy(policy, position, costs) {
  validateProfitRetentionPolicy(policy);
  if (!isAdaptiveFirstHarvestPolicy(policy)) return policy;
  const original = Number(position.originalQuantity), entryFee = Number(position.entryFee);
  if (!Number.isFinite(original) || original <= 0 || !Number.isFinite(entryFee) || entryFee < 0) policyError();
  const evidence = { status: 'ACTUAL_FILL_RESOLVED', direction: Number(position.direction), entry: Number(position.entry),
    entryFeePerUnit: entryFee / original,
    initialRiskPerUnit: Number(position.initialRiskPerUnit ?? Number(position.initialPlannedRiskUsdt) / original),
    takerFeeRate: Number(costs.takerFeeRate), adverseSlippageRate: Number(costs.adverseSlippageRate) };
  const resolved = resolvedFirstHarvest(policy.firstHarvestTarget, evidence);
  return { ...policy, firstHarvestResolution: { ...evidence, targetNetR: resolved.targetNetR },
    firstHarvestInvalid: resolved.invalid, stages: stagesFor(resolved.firstR) };
}

export function advanceAggregateProfitLock({ policy, softLockTaken, peakNetR = 0,
  currentNetR, existingFloorR = 0, accountingComplete }) {
  if (!policy) return { active: false, peakNetR, floorR: existingFloorR, revision: null };
  validateProfitRetentionPolicy(policy, { allowUnresolved: softLockTaken !== true });
  if (![peakNetR, currentNetR, existingFloorR].every(Number.isFinite)
    || peakNetR < 0 || existingFloorR < 0 || accountingComplete !== true) throw new Error('PROFIT_RETENTION_ACCOUNTING_REQUIRED');
  if (softLockTaken !== true || policy.firstHarvestInvalid === true) return { active: false, peakNetR, floorR: existingFloorR, revision: policy.revision };
  const peak = Math.max(peakNetR, currentNetR, 0);
  return { active: true, peakNetR: peak,
    floorR: Math.max(existingFloorR, peak * policy.retainPeakFraction), revision: policy.revision };
}

// Actual realized net already includes the entry fees allocated to closed
// quantity. Allocate the rest only once. Funding is KNOWN attributed cashflow;
// this valuation does not certify that future/unreported funding is zero.
export function aggregateLiquidationNetR(position, executablePrice, costs) {
  const { direction, entry, initialPlannedRiskUsdt: risk, cumulativeRealizedNetPnl: realized, entryFee } = position;
  const quantity = Number(position.quantity), original = Number(position.originalQuantity);
  const funding = Number(position.fundingNetUsdt);
  const fee = Number(costs.takerFeeRate), slip = Number(costs.adverseSlippageRate);
  const raw = Number(executablePrice);
  if (position.accountingComplete !== true || ![1, -1].includes(direction)
    || ![entry, risk, realized, entryFee, quantity, original, funding, fee, slip, raw].every(Number.isFinite)
    || [entry, risk, quantity, original, raw].some(x => x <= 0)
    || quantity > original || entryFee < 0 || fee < 0 || fee >= 1 || slip < 0 || slip >= 1) throw new Error('PROFIT_RETENTION_VALUATION_INVALID');
  const exit = raw * (1 - direction * slip);
  const remainingNet = direction * (exit - entry) * quantity - entryFee * quantity / original - exit * quantity * fee;
  return (realized + remainingNet + funding) / risk;
}
