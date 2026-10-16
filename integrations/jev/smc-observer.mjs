import { blockLegacyDirectLaunch } from "../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { DUAL_FRAME_ENTRY_REVISION, validateDualFrameCandidate } from '../../lib/smc-dual-frame-entry.mjs';
import { LOCAL_ENTRY_REVISION, validateLocalSmcCandidate } from '../../lib/smc-local-entry.mjs';
import { TIMED_ENTRY_REVISION, validateTimedEntryCandidate } from '../../lib/smc-timed-entry.mjs';
import { CONTINUATION_REVISION, validateContinuationCandidate } from '../../lib/smc-continuation.mjs';
import { PLAN_LIFECYCLE_REVISION, sanitizePlanTerminals, planFamilyKey, lifecycleSourceIsActive } from '../../lib/smc-plan-lifecycle.mjs';
import { STOP_SAFETY_REVISION, STOP_SLIPPAGE_BPS } from '../../lib/smc-stop-safety.mjs';
import { sanitizeStructureContext, externalStructureEvidence } from '../../lib/smc-structure-context.mjs';
import { sanitizeStructurePlans, STRUCTURE_PLAN_REVISION, OPPORTUNITY_SEARCH_REVISION } from '../../lib/smc-structure-plan.mjs';
export const JEV_SMC_OBSERVER_REVISION = 'JEV-SMC-OUTCOME-23';

export const JEV_SMC_ASSESSMENT_REVISION = 'JEV-SMC-ASSESS-3';

const finite = value => Number.isFinite(Number(value));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const rounded = (value, places = 3) => Number(Number(value).toFixed(places));

function driver(key, label, impact, points, value) {
  return { key, label, impact, points, value };
}

export function assessSmcCandidate(row) {
  if ([LOCAL_ENTRY_REVISION,DUAL_FRAME_ENTRY_REVISION].includes(row.modelRevision)) return {
    revision: JEV_SMC_ASSESSMENT_REVISION, verdict: 'WAIT', evidenceScore: null, estimatedProbability: null,
    probabilityStatus: 'UNRATED_MODEL', confidence: 0, marketState: row.status === 'ENTRY_BAND_ACTIVE' ? 'TRIGGER_CONFIRMED' : 'APPROACHING',
    strategyImpact: 'MIXED', drivers: [driver('LOCAL_SMC', row.sourcePlan.entryPolicyRevision==='SMC-ENTRY-PATHS-2'?'模型入场位置与最近4H目标路径；交汇仅标记':'局部结构与K线确认；交汇仅标记', 'NEUTRAL', 0, row.modelRevision)],
    featureVector: { modelRevision: row.modelRevision, intersectionAdmissionEffect: 'NONE',
      triggerAt: row.confirmationAt, plannedNetR: row.sourcePlan.entryPolicyRevision==='SMC-ENTRY-PATHS-2'
        ? row.sourcePlan.stopBasis?.ready&&row.sourcePlan.stopBasis.entryValid!==false?row.sourcePlan.targetPath?.netR??null:null : row.sourcePlan.netR,
      candidateNetR: row.netR, entryPolicyRevision:row.sourcePlan.entryPolicyRevision??null,
      targetPathRevision:row.targetPath?.revision??null,admissionTarget:row.target,referenceTarget:row.referenceTarget??row.target,
      targetPath:row.targetPath??null,opportunity: row.jevOpportunity, targetPolicyRevision: row.sourcePlan.targetPolicyRevision ?? null, targetBasis: row.sourcePlan.targetBasis ?? null },
    modelFeedback: { status: 'FEATURE_VECTOR_READY', executionAuthority: false },
  };
  if (row.modelRevision === TIMED_ENTRY_REVISION) return {
    revision: JEV_SMC_ASSESSMENT_REVISION, verdict: 'WAIT', evidenceScore: null, estimatedProbability: null,
    probabilityStatus: 'UNRATED_MODEL', confidence: 0, marketState: row.status === 'ENTRY_BAND_ACTIVE' ? 'TRIGGER_CONFIRMED' : 'APPROACHING',
    strategyImpact: 'MIXED', drivers: [driver('TIMED_SMC', '交汇窗口与局部结构反应；前向验证中', 'NEUTRAL', 0, row.intersectionEvent.id)],
    featureVector: { modelRevision: row.modelRevision, intersectionId: row.intersectionEvent.id, intersectionAt: row.intersectionEvent.tx,
      sourceKnownAt: row.intersectionEvent.knownAt, firstSeenAt: row.intersectionEvent.firstSeenAt,
      triggerAt: row.confirmationAt, plannedNetR: row.sourcePlan.netR, candidateNetR: row.netR, opportunity: row.jevOpportunity, targetPolicyRevision: row.sourcePlan.targetPolicyRevision ?? null, targetBasis: row.sourcePlan.targetBasis ?? null },
    modelFeedback: { status: 'FEATURE_VECTOR_READY', executionAuthority: false },
  };
  if (row.modelRevision === CONTINUATION_REVISION) return {
    revision: JEV_SMC_ASSESSMENT_REVISION, verdict: 'WAIT', evidenceScore: null, estimatedProbability: null,
    probabilityStatus: 'UNRATED_MODEL', confidence: 0, marketState: row.status === 'ENTRY_BAND_ACTIVE' ? 'TRIGGER_CONFIRMED' : 'APPROACHING',
    strategyImpact: 'MIXED', drivers: [driver('CONTINUATION', '顺势回踩模型已确认；概率尚未校准', 'NEUTRAL', 0, row.modelRevision)],
    featureVector: { modelRevision: row.modelRevision, parentEpisodeId: row.structure.parentEpisodeId,
      triggerAt: row.confirmationAt, plannedNetR: row.sourcePlan.netR, candidateNetR: row.netR },
    modelFeedback: { status: 'FEATURE_VECTOR_READY', executionAuthority: false },
  };

  const drivers = [];
  let score = 50;
  const grade = row.structure?.qualityGrade ?? null;
  if (grade === 'A') { score += 12; drivers.push(driver('STRUCTURE_GRADE', 'A 级结构', 'POSITIVE', 12, grade)); }
  else if (grade === 'B') { score += 6; drivers.push(driver('STRUCTURE_GRADE', 'B 级结构', 'POSITIVE', 6, grade)); }
  else { score -= 7; drivers.push(driver('STRUCTURE_GRADE', '结构等级缺失', 'NEGATIVE', -7, grade)); }

  const bodyAtr = Number(row.structure?.bodyAtr);
  if (finite(bodyAtr) && bodyAtr >= 1) { score += 7; drivers.push(driver('DISPLACEMENT', '位移强', 'POSITIVE', 7, rounded(bodyAtr))); }
  else if (finite(bodyAtr) && bodyAtr >= .65) { score += 3; drivers.push(driver('DISPLACEMENT', '位移合格', 'POSITIVE', 3, rounded(bodyAtr))); }
  else { score -= 4; drivers.push(driver('DISPLACEMENT', finite(bodyAtr) ? '位移偏弱' : '位移证据缺失', 'NEGATIVE', -4, finite(bodyAtr) ? rounded(bodyAtr) : null)); }

  const bodyFraction = Number(row.structure?.bodyFraction);
  if (finite(bodyFraction) && bodyFraction >= .65) { score += 6; drivers.push(driver('BODY_QUALITY', '实体占比强', 'POSITIVE', 6, rounded(bodyFraction))); }
  else if (finite(bodyFraction) && bodyFraction >= .5) { score += 3; drivers.push(driver('BODY_QUALITY', '实体占比合格', 'POSITIVE', 3, rounded(bodyFraction))); }
  else { score -= 4; drivers.push(driver('BODY_QUALITY', finite(bodyFraction) ? '实体占比偏弱' : '实体证据缺失', 'NEGATIVE', -4, finite(bodyFraction) ? rounded(bodyFraction) : null)); }

  const volumeRatio = Number(row.structure?.volumeRatio);
  if (finite(volumeRatio) && volumeRatio >= 1.4) { score += 7; drivers.push(driver('VOLUME', '量能扩张', 'POSITIVE', 7, rounded(volumeRatio))); }
  else if (finite(volumeRatio) && volumeRatio >= 1) { score += 3; drivers.push(driver('VOLUME', '量能确认', 'POSITIVE', 3, rounded(volumeRatio))); }
  else { score -= 5; drivers.push(driver('VOLUME', finite(volumeRatio) ? '量能不足' : '量能证据缺失', 'NEGATIVE', -5, finite(volumeRatio) ? rounded(volumeRatio) : null)); }

  const netR = Number(row.netR);
  if (netR >= 3) { score += 8; drivers.push(driver('NET_R', '净 R 充足', 'POSITIVE', 8, rounded(netR, 2))); }
  else if (netR >= 2.5) { score += 5; drivers.push(driver('NET_R', '净 R 良好', 'POSITIVE', 5, rounded(netR, 2))); }
  else { score += 2; drivers.push(driver('NET_R', '净 R 达标', 'NEUTRAL', 2, rounded(netR, 2))); }

  const microStructureReady = row.entryMicroStructure?.ready === true;
  const microBars = Number(row.entryMicroStructure?.barsElapsed);
  if (microStructureReady) { score += 8; drivers.push(driver('MICRO_STRUCTURE', '15M 微结构位移已确认', 'POSITIVE', 8, finite(microBars) ? microBars : null)); }
  else { score -= 18; drivers.push(driver('MICRO_STRUCTURE', 'CE 触及后尚无微结构位移', 'NEGATIVE', -18, row.entryMicroStructure?.state ?? null)); }

  const liquidityReady = row.entryLiquidity?.ready === true;
  const blockingPools = Array.isArray(row.entryLiquidity?.blocking) ? row.entryLiquidity.blocking.length : null;
  if (liquidityReady) { score += 6; drivers.push(driver('ENTRY_LIQUIDITY', '入场侧流动性已处理', 'POSITIVE', 6, blockingPools ?? 0)); }
  else { score -= 18; drivers.push(driver('ENTRY_LIQUIDITY', '仍有未清扫内部流动性', 'NEGATIVE', -18, blockingPools)); }

  const locationReady = row.entryLocation?.ready === true;
  const locationPercentile = Number(row.entryLocation?.robustPercentile);
  if (locationReady) { score += 5; drivers.push(driver('ENTRY_LOCATION', '入场位于价值侧', 'POSITIVE', 5, finite(locationPercentile) ? rounded(locationPercentile, 2) : null)); }
  else { score -= 14; drivers.push(driver('ENTRY_LOCATION', '入场处于相对追价位置', 'NEGATIVE', -14, finite(locationPercentile) ? rounded(locationPercentile, 2) : null)); }

  const regimeReady = row.entryRegime?.ready === true;
  const rangeAtr = Number(row.entryRegime?.rangeAtr);
  const efficiency = Number(row.entryRegime?.efficiency);
  if (regimeReady) { score += 5; drivers.push(driver('ENTRY_REGIME', '15M 位移环境合格', 'POSITIVE', 5, finite(efficiency) ? rounded(efficiency, 2) : null)); }
  else { score -= 14; drivers.push(driver('ENTRY_REGIME', row.entryRegime?.compressed ? '15M 压缩盘整' : '确认力度不足', 'NEGATIVE', -14, finite(rangeAtr) ? rounded(rangeAtr, 2) : null)); }

  const mitigationEpisodes = Number(row.poiLifecycle?.mitigationEpisodes);
  const ceBodyCrosses = Number(row.poiLifecycle?.ceBodyCrosses);
  if (mitigationEpisodes === 0) { score += 5; drivers.push(driver('POI_FRESHNESS', 'POI 尚未消耗', 'POSITIVE', 5, 0)); }
  else if (mitigationEpisodes === 1 && ceBodyCrosses <= 2) drivers.push(driver('POI_FRESHNESS', 'POI 首次回补', 'NEUTRAL', 0, mitigationEpisodes));
  else { score -= 20; drivers.push(driver('POI_FRESHNESS', 'POI 已反复消耗', 'NEGATIVE', -20, finite(mitigationEpisodes) ? mitigationEpisodes : null)); }

  const triggerReady = microStructureReady && liquidityReady && locationReady && regimeReady
    && ['ENTRY_BAND_ACTIVE', 'SECOND_BAR_REVERSE_READY'].includes(row.status);
  if (triggerReady) { score += 10; drivers.push(driver('TRIGGER', '15M 触发确认', 'POSITIVE', 10, row.status)); }
  else { score -= 6; drivers.push(driver('TRIGGER', '等待 15M 因果确认', 'NEGATIVE', -6, row.status)); }

  if (row.quoteFresh === true) { score += 4; drivers.push(driver('QUOTE', '盘口新鲜', 'POSITIVE', 4, true)); }
  else { score -= 8; drivers.push(driver('QUOTE', '盘口未确认', 'NEGATIVE', -8, false)); }

  const distance = Number(row.distanceToEntry?.percent);
  if (finite(distance) && distance === 0) { score += 5; drivers.push(driver('DISTANCE', '价格已在执行带', 'POSITIVE', 5, 0)); }
  else if (finite(distance) && distance <= .5) { score += 3; drivers.push(driver('DISTANCE', '接近执行带', 'POSITIVE', 3, rounded(distance, 2))); }
  else if (finite(distance) && distance > 2) { score -= 5; drivers.push(driver('DISTANCE', '距离执行带较远', 'NEGATIVE', -5, rounded(distance, 2))); }
  else drivers.push(driver('DISTANCE', finite(distance) ? '等待接近执行带' : '距离证据缺失', 'NEUTRAL', 0, finite(distance) ? rounded(distance, 2) : null));

  score = Math.round(clamp(score, 0, 100));
  const completeness = [grade, bodyAtr, bodyFraction, volumeRatio, netR, row.status, row.quoteFresh,
    row.distanceToEntry?.percent, row.entryLiquidity?.ready, row.poiLifecycle?.mitigationEpisodes,
    row.entryLocation?.ready, row.entryRegime?.ready, row.entryMicroStructure?.ready]
    .filter(value => value !== null && value !== undefined && (typeof value !== 'number' || Number.isFinite(value))).length / 13;
  const estimatedProbability = rounded(clamp(.25 + score * .0055, .25, .8), 2);
  const verdict = !triggerReady ? 'WAIT' : score >= 70 ? 'YES' : score <= 45 ? 'NO' : 'WAIT';
  const marketState = row.status === 'WAIT_15M_MICRO_STRUCTURE_SHIFT' ? 'MICRO_STRUCTURE_PENDING'
    : row.status === 'WAIT_LIQUIDITY_SWEEP_RECLAIM' ? 'LIQUIDITY_SWEEP_PENDING'
    : row.status === 'WAIT_VALUE_LOCATION' ? 'VALUE_LOCATION_PENDING'
    : row.status === 'WAIT_15M_EXPANSION_CONFIRMATION' ? 'COMPRESSION_PENDING'
    : triggerReady ? 'TRIGGER_CONFIRMED'
    : row.status === 'WAIT_SECOND_BAR_CE_REVERSAL' ? 'FALSE_BREAK_WATCH'
      : finite(distance) && distance <= .5 ? 'NEAR_TRIGGER' : 'APPROACHING';
  const strategyImpact = score >= 70 ? 'SUPPORTIVE' : score <= 45 ? 'ADVERSE' : 'MIXED';
  return {
    revision: JEV_SMC_ASSESSMENT_REVISION,
    verdict,
    evidenceScore: score,
    estimatedProbability,
    probabilityStatus: 'HEURISTIC_UNCALIBRATED',
    confidence: rounded(completeness, 2),
    marketState,
    strategyImpact,
    drivers: drivers.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 4),
    featureVector: { grade, bodyAtr: finite(bodyAtr) ? rounded(bodyAtr) : null, bodyFraction: finite(bodyFraction) ? rounded(bodyFraction) : null,
      volumeRatio: finite(volumeRatio) ? rounded(volumeRatio) : null, netR: rounded(netR, 2), status: row.status,
      quoteFresh: row.quoteFresh === true, distancePercent: finite(distance) ? rounded(distance, 2) : null,
      microStructureReady, microStructureState: row.entryMicroStructure?.state ?? null,
      microStructureBars: finite(microBars) ? microBars : null,
      liquidityReady, blockingPools, stopAdjustedForLiquidity: row.entryLiquidity?.stopAdjustedForLiquidity === true,
      locationReady, locationPercentile: finite(locationPercentile) ? rounded(locationPercentile, 2) : null,
      regimeReady, rangeAtr: finite(rangeAtr) ? rounded(rangeAtr, 2) : null,
      efficiency: finite(efficiency) ? rounded(efficiency, 2) : null,
      mitigationEpisodes: finite(mitigationEpisodes) ? mitigationEpisodes : null,
      ceBodyCrosses: finite(ceBodyCrosses) ? ceBodyCrosses : null },
    modelFeedback: { status: completeness >= .75 ? 'FEATURE_VECTOR_READY' : 'PARTIAL_EVIDENCE', executionAuthority: false },
  };
}

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function observeSmcSnapshot(snapshot, policy, now = Date.now()) {
  if (policy?.observerRevision !== JEV_SMC_OBSERVER_REVISION || policy?.strategyRevision !== 'SMC-EXEC-11'
    || policy?.scannerRevision !== 'SMC-SCAN-13' || policy?.orderAuthority !== false) throw new Error('JEV_SMC_POLICY_INVALID');
  const sourceAt = time(snapshot?.sourceAsOf);
  const fresh = sourceAt !== null && now - sourceAt >= -5000 && now - sourceAt <= Number(policy.snapshotStaleAfterMs);
  const sourceValid = snapshot?.revision === policy.scannerRevision && snapshot?.orderAuthority === false
    && Array.isArray(snapshot?.candidates) && Array.isArray(snapshot?.results);
  const structureContexts = fresh && sourceValid ? snapshot.results.flatMap(result => {
    try { const context = sanitizeStructureContext(result.structureContext, now);
      return context ? [{ symbol: result.symbol, context }] : []; } catch { return []; }
  }) : [];
  const opportunityReviews = fresh && sourceValid ? snapshot.results.map(r => ({ symbol: r.symbol, clock: r.intersectionClock ?? null, models: r.modelAssessments ?? [], legacyCandidateCount: r.baselineCandidateCount ?? null, orderAuthority: false })) : [];
  const structureObservations = fresh && sourceValid ? snapshot.results.flatMap(result => result.structures ?? []).map(row => ({
    id: row.id, symbol: row.symbol, direction: row.direction, eventType: row.eventType, grade: row.grade,
    admission: row.admission, breakAt: row.breakAt, qualityModel: row.qualityModel,
    bodyAtr: row.bodyAtr, bodyFraction: row.bodyFraction, volumeRatio: row.volumeRatio,
    reasons: row.reasons, hierarchy: row.hierarchy ?? null, executionAuthority: false,
  })) : [];
  const structurePlans = fresh && sourceValid ? snapshot.results.flatMap(result => {
    try { const retired = sanitizePlanTerminals(result.planTerminals, result.symbol, now);
      return sanitizeStructurePlans(result.structurePlans, result.symbol, now).filter(p => !retired.some(r => planFamilyKey(r.plan) === planFamilyKey(p))
        && lifecycleSourceIsActive(p, { quote: result.planningQuote, now })); } catch { return []; }
  }) : [];
  const candidates = fresh && sourceValid ? snapshot.candidates.filter(row => !snapshot.results.some(r => (r.planTerminals ?? []).some(t => planFamilyKey(t.plan) === planFamilyKey(row))) && ['AUTOMATIC', 'OWNER_SELECTED'].includes(row.candidateSource)
    && (row.candidateSource === 'OWNER_SELECTED' ? Number.isFinite(row.ownerSelectedAt) : row.ownerSelectedAt == null)
    && ([CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION, DUAL_FRAME_ENTRY_REVISION].includes(row.modelRevision) ? (() => { try { return (row.modelRevision === DUAL_FRAME_ENTRY_REVISION ? validateDualFrameCandidate : row.modelRevision === LOCAL_ENTRY_REVISION ? validateLocalSmcCandidate : row.modelRevision === TIMED_ENTRY_REVISION ? validateTimedEntryCandidate : validateContinuationCandidate)(row, now); } catch { return false; } })() : externalStructureEvidence(row.structure)) && row.confirmationAt >= policy.activationAt
    && ['ARMED_CE_CLOSE','WAIT_15M_MICRO_STRUCTURE_SHIFT','WAIT_CE_REENTRY','WAIT_LIQUIDITY_SWEEP_RECLAIM','WAIT_VALUE_LOCATION','WAIT_15M_EXPANSION_CONFIRMATION','ENTRY_BAND_ACTIVE','WAIT_SECOND_BAR_CE_REVERSAL','WAIT_SECOND_BAR_PRICE','SECOND_BAR_REVERSE_READY'].includes(row.status)
    && Number(row.netR) >= policy.minimumNetRewardRisk
    && row.stopSafety?.revision === STOP_SAFETY_REVISION && row.stopSafety.ready === true).map(row => {
      const assessment = assessSmcCandidate(row);
      return ({
      modelRevision: row.modelRevision ?? null, id: row.id, symbol: row.symbol, direction: row.direction, sourceStatus: row.status, observedAt: row.observedAt,
      confirmationAt: row.confirmationAt, entry: row.entry, stop: row.stop, target: row.target, netR: row.netR,
      entryPolicyRevision:row.sourcePlan?.entryPolicyRevision??null, targetPathRevision:row.targetPath?.revision??null,
      referenceTarget:row.referenceTarget??row.target, targetPath:row.targetPath??null,
      structureGrade: row.structure?.qualityGrade ?? null, structureQualityModel: row.structure?.qualityModel ?? null,
      candidateSource: row.candidateSource,
      ownerSelectedAt: row.ownerSelectedAt ?? null,
      researchCohort: row.candidateSource === 'OWNER_SELECTED' ? 'OWNER_SELECTED_STRUCTURE' : 'AUTOMATIC_DISCOVERY',
      stopSafetyRevision: row.stopSafety.revision, structuralStopBasis: row.stopSafety.structuralBasis ?? null,
      entryMode: row.entryConfirmation?.mode ?? null,
      reversal: row.entryConfirmation?.reversal ?? null,
      poiLifecycle: row.poiLifecycle ?? null,
      entryLiquidity: row.entryLiquidity ?? null,
      entryLocation: row.entryLocation ?? null,
      entryRegime: row.entryRegime ?? null,
      entryMicroStructure: row.entryMicroStructure ?? null,
      researchState: ['ENTRY_BAND_ACTIVE','SECOND_BAR_REVERSE_READY'].includes(row.status) ? 'PROSPECTIVE_OUTCOME_FROZEN' : 'WAIT_CAUSAL_CONFIRMATION',
      assessment,
      probability: assessment.estimatedProbability, probabilityStatus: assessment.probabilityStatus, executionAuthority: false,
    }); }) : [];
  return { schemaVersion: 1, observerRevision: JEV_SMC_OBSERVER_REVISION, mode: 'OBSERVE_ONLY', orderAuthority: false,
    strategyRevision: policy.strategyRevision, scannerRevision: policy.scannerRevision, asOf: new Date(now).toISOString(),
    sourceAsOf: sourceAt === null ? null : new Date(sourceAt).toISOString(), sourceStatus: !sourceValid ? 'INVALID' : fresh ? 'READY' : 'STALE',
    sourceHealth: sourceValid ? {status:snapshot.status === 'HEALTHY' ? 'HEALTHY' : 'DEGRADED',
      errors:(snapshot.errors ?? []).map(e => ({symbol:e.symbol,reason:e.reason})).slice(0,11)} : null,
    candidates, structureObservations, opportunityReviews, structureContexts, structurePlans, research: { status: 'ACTIVE_HEURISTIC_ASSESSMENT', probabilityGateActive: false, conditionalPlanCount: structurePlans.length,
      stopSafetyRevision: STOP_SAFETY_REVISION, stopSlippageBps: STOP_SLIPPAGE_BPS,
      riskScopeRevision: 'SMC-PLAN-RISK-1', entryPolicyRevision:'SMC-ENTRY-PATHS-2',targetPathRevision:'SMC-TARGET-PATH-1',
      stopSafetyPolicy: 'RISK1_4H_TARGET_15M_MAIN_PROTECTION_PLUS_BUFFER_NOISE_LIQUIDITY_COST_NO_R_DRIVEN_SHRINK_LEGACY_POSITIONS_PRESERVED',
      structureHierarchyRevision: 'SMC-HIERARCHY-1', structureContextRevision: 'SMC-CONTEXT-2',
      externalAdmissionPolicy: 'LOCAL_ENTRY2_4H15M_LOCAL_RETEST_ALLOWED_MACRO_CONFLICT_CONTEXT_ONLY_LEGACY_EXTERNAL_EVENTS_REQUIRE_HELD_BOUNDARY',
      conditionalEntryReviewRevision: 'SMC-ENTRY-REVIEW-3',
      conditionalPlanRevision: STRUCTURE_PLAN_REVISION, opportunitySearchRevision: OPPORTUNITY_SEARCH_REVISION, planLifecycleRevision: PLAN_LIFECYCLE_REVISION,
      opportunityPolicy: 'PATH2_MODEL_LOCATION_FIRST_4H_OPPOSING_FVG_AND_PIVOT_TARGET_PATH_15M_CONFIRMED_TRANSITION',
      lifecyclePolicy: 'PERSISTED_TICK_BBO_AND_CLOSED_BAR_TERMINALS_NO_CONSUMED_FAMILY_REVIVAL_NO_RETROACTIVE_FILL',
      conditionalTimingPolicy: 'PATH2_CAUSAL_MODEL_LOCATION_TARGET_PATH_NET2_INTERSECTION_MARKER_ONLY',
      conditionalPlanPolicy: 'LOCAL_ENTRY2_4H15M_JEV_OPPORTUNITY_REVIEW_SHARED_VALIDATOR_UNRATED_NO_SHADOW_ENTRY', frozenCount: candidates.filter(row => row.researchState === 'PROSPECTIVE_OUTCOME_FROZEN').length,
      outcomeDefinition: 'PROSPECTIVE_PATH2_4H15M;MODEL_SPECIFIC_ENTRY_LOCATION_NOT_CHASING_LATE_DIRECTION;CAUSAL_CONFIRMED_FVG_RETEST_NO_PREFORMATION_FILL;TARGET_PATH1_NEAREST_REAL_4H_OPPOSING_GRADED_FVG_OR_PIVOT;INSIDE_OR_RISK_CORRIDOR_CROSS_UNCONFIRMED_RETAINS_CONDITIONAL_PLAN_NULL_ADMISSION_R;ONE_CLOSED_4H_FAR_EDGE_BREAK_INVALIDATES_FVG;ACTUAL_BBO_REBUILDS_TARGET_PATH_AND_NET2_INCLUSIVE;RISK1_CONFIRMED_PROTECTION_NO_R_DRIVEN_STOP_SHRINK;INTERSECTION_MARKER_ONLY;CONDITIONAL_STOP1_TIGHTEN_ONLY;FROZEN_HISTORY_AND_OPEN_POSITIONS_ORIGINAL_POLICY;INDEPENDENT_STRUCTURAL_EVENT_COHORTS;NO_RETROACTIVE_FILL;UNRATED_NO_PROBABILITY_GATE_NO_SHADOW_ENTRY_NO_ORDER_AUTHORITY',
      historicalBackfill: false, structureLookbackBars4h: policy.structureLookbackBars4h,
      activePlanHorizonBars4h: policy.maximumCandidateAgeBars4h,
      ownerSelectedPlanHorizonBars4h: policy.ownerSelectedCandidateMaximumAgeBars4h,
      ownerSelectedOutcomeSegregation: true,
      promotionReviewMinimumIndependentOutcomes: policy.promotionReviewMinimumIndependentOutcomes },
    shadow: { status: 'OBSERVE_ONLY', simulatedEntryAllowed: false, liveOrderAuthority: false,
      reason: 'SMC_LIVE_IS_NOT_GATED_BY_HEURISTIC_UNCALIBRATED_JEV_ASSESSMENT' } };
}
