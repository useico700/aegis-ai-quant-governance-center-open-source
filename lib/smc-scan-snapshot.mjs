import { SMC_S1_ENTRY_REVISION, validateSmcS1Candidate } from './smc-s1-entry.mjs';
import {validateCandidateTargetPath} from './smc-target-path-candidate.mjs';
import { DUAL_FRAME_ENTRY_REVISION, validateDualFrameCandidate } from './smc-dual-frame-entry.mjs';
import { LOCAL_ENTRY_REVISION, validateLocalSmcCandidate } from './smc-local-entry.mjs';
import { projectIntersectionObservation } from './smc-intersection-observation.mjs';
import { TIMED_ENTRY_REVISION, validateTimedEntryCandidate } from './smc-timed-entry.mjs';
import { CONTINUATION_REVISION, validateContinuationCandidate } from './smc-continuation.mjs';
import { sanitizePlanTerminals } from './smc-plan-lifecycle.mjs';
import { stopSafetyMetrics } from './smc-stop-safety.mjs';
import policy from './smc-scan-policy.json' with { type: 'json' };
import { smcNetRewardRisk } from './smc-scanner.mjs';
import { sanitizeStructureContext } from './smc-structure-context.mjs';
import { sanitizeStructurePlans } from './smc-structure-plan.mjs';
const check = (ok, code) => { if (!ok) throw new Error(code); };
export function sanitizeSmcScan(raw, now = Date.now()) {
  check(raw?.revision === policy.revision && raw.mode === policy.mode && raw.orderAuthority === false, 'SMC_SCOPE');
  check(Number.isFinite(Date.parse(raw.sourceAsOf)) && now - Date.parse(raw.sourceAsOf) >= -5000 && now - Date.parse(raw.sourceAsOf) <= policy.snapshotStaleAfterMs, 'SMC_STALE');
  check(JSON.stringify(raw.universe) === JSON.stringify(policy.universe), 'SMC_UNIVERSE');
  check(Array.isArray(raw.results) && raw.results.length <= policy.universe.length && new Set(raw.results.map(r => r.symbol)).size === raw.results.length, 'SMC_RESULTS');
  const results = raw.results.map(row => {
    check(policy.universe.includes(row.symbol) && Array.isArray(row.candidates) && row.candidates.length <= policy.maximumCandidatesPerSymbol
      && Array.isArray(row.structures) && row.structures.length <= policy.maximumStructureObservationsPerSymbol, 'SMC_SYMBOL');
    check(row.manualZones == null || (Array.isArray(row.manualZones) && row.manualZones.length <= 8), 'SMC_MANUAL_ZONES');
    const manualZones = (row.manualZones ?? []).map(zone => {
      check(typeof zone.id === 'string' && zone.id.length <= 80 && ['LONG', 'SHORT'].includes(zone.direction)
        && ['FVG', 'SWING_SUPPORT', 'SWING_RESISTANCE'].includes(zone.kind) && zone.orderAuthority === false
        && (zone.kind === 'FVG' || zone.kind === (zone.direction === 'LONG' ? 'SWING_SUPPORT' : 'SWING_RESISTANCE'))
        && [zone.low, zone.high, zone.ce, zone.availableAt, zone.distancePercent, zone.ageDays].every(Number.isFinite)
        && zone.low > 0 && zone.low < zone.ce && zone.ce < zone.high
        && zone.distancePercent >= 0 && zone.distancePercent <= 12
        && zone.ageDays >= 0 && zone.ageDays <= 65
        && Number.isSafeInteger(zone.touches) && zone.touches >= 0
        && (zone.lastTouchAt == null || Number.isFinite(zone.lastTouchAt)), 'SMC_MANUAL_ZONE_INVALID');
      return zone;
    });
    for (const structure of row.structures) check(structure.symbol === row.symbol && structure.orderAuthority === false
      && typeof structure.id === 'string' && ['LONG', 'SHORT'].includes(structure.direction)
      && ['BOS', 'CHOCH', 'MSS', 'INTERNAL_BREAK', 'UNCONFIRMED_BREAK'].includes(structure.eventType) && ['BULLISH', 'BEARISH', 'RANGE'].includes(structure.priorBias)
      && policy.structureGrades.includes(structure.grade) && ['PLAN_ELIGIBLE', 'OBSERVE_ONLY'].includes(structure.admission)
      && (structure.grade === 'C' || structure.reasons.includes('REVERSAL_WITHOUT_LIQUIDITY_SWEEP') || structure.reasons.includes('INTERNAL_OR_UNCONFIRMED_EXTERNAL_STRUCTURE'))
        === (structure.admission === 'OBSERVE_ONLY')
      && Number.isFinite(structure.breakAt) && Number.isFinite(structure.breakClose)
      && Number.isFinite(structure.bodyAtr) && Number.isFinite(structure.bodyFraction) && Number.isFinite(structure.volumeRatio)
      && ['SINGLE_BAR', 'CUMULATIVE_LEG', 'OBSERVE_ONLY'].includes(structure.qualityModel)
      && Number.isInteger(structure.qualityBars) && structure.qualityBars >= 1 && structure.qualityBars <= policy.cumulativeDisplacementBars
      && Array.isArray(structure.reasons) && structure.reasons.length <= 4, 'SMC_STRUCTURE_OBSERVATION');
    for (const candidate of row.candidates) {
      if (candidate.modelRevision === SMC_S1_ENTRY_REVISION) {
        validateSmcS1Candidate(candidate,now);
        check(candidate.symbol === row.symbol,'SMC_PX_SYMBOL');
        continue;
      }
      if ([CONTINUATION_REVISION, TIMED_ENTRY_REVISION, LOCAL_ENTRY_REVISION, DUAL_FRAME_ENTRY_REVISION].includes(candidate.modelRevision)) {
        (candidate.modelRevision === DUAL_FRAME_ENTRY_REVISION ? validateDualFrameCandidate : candidate.modelRevision === LOCAL_ENTRY_REVISION ? validateLocalSmcCandidate : candidate.modelRevision === TIMED_ENTRY_REVISION ? validateTimedEntryCandidate : validateContinuationCandidate)(candidate, now);
        check(candidate.symbol === row.symbol && candidate.stopSafety?.ready === true, 'CONTINUATION_STOP_SAFETY');
        continue;
      }
      if(candidate.targetPathRevision)validateCandidateTargetPath(candidate,now);
      check(candidate.symbol === row.symbol && candidate.revision === policy.revision && candidate.orderAuthority === false && candidate.executionQualified === false && candidate.winProbability === null, 'SMC_CANDIDATE_SCOPE');
      check(['AUTOMATIC', 'OWNER_SELECTED'].includes(candidate.candidateSource)
        && (candidate.candidateSource === 'OWNER_SELECTED'
          ? Number.isFinite(candidate.ownerSelectedAt) && candidate.ownerSelectedAt <= now + 5000
            && typeof candidate.ownerAutoTradingEnabled === 'boolean'
          : candidate.ownerSelectedAt == null && candidate.ownerAutoTradingEnabled == null), 'SMC_CANDIDATE_SOURCE');
      check(['CONTINUOUS_FROM_POI', 'CURRENT_15M_WINDOW_WITH_FULL_4H_VALIDATION'].includes(candidate.entryHistoryCoverage)
        && (candidate.entryHistoryCoverage !== 'CURRENT_15M_WINDOW_WITH_FULL_4H_VALIDATION' || candidate.candidateSource === 'OWNER_SELECTED'),
      'SMC_ENTRY_HISTORY_COVERAGE');
      check(['LONG', 'SHORT'].includes(candidate.direction)
        && ['ARMED_CE_CLOSE', 'WAIT_15M_MICRO_STRUCTURE_SHIFT', 'WAIT_CE_REENTRY', 'WAIT_LIQUIDITY_SWEEP_RECLAIM', 'WAIT_VALUE_LOCATION', 'WAIT_15M_EXPANSION_CONFIRMATION', 'ENTRY_BAND_ACTIVE', 'WAIT_SECOND_BAR_CE_REVERSAL', 'WAIT_SECOND_BAR_PRICE', 'SECOND_BAR_REVERSE_READY'].includes(candidate.status),
      'SMC_CANDIDATE_STATUS');
      check([candidate.entry, candidate.stop, candidate.target, candidate.netR, candidate.riskPerUnit, candidate.netRewardPerUnit].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0) && candidate.netR >= 2, 'SMC_CANDIDATE_PRICES');
      check(candidate.direction === 'LONG' ? candidate.stop < candidate.entry && candidate.entry < candidate.target : candidate.target < candidate.entry && candidate.entry < candidate.stop, 'SMC_CANDIDATE_DIRECTION');
      const recalculated = smcNetRewardRisk(candidate);
      check(recalculated.qualified && Math.abs(recalculated.netR - candidate.netR) < 1e-8, 'SMC_NET_R_MISMATCH');
      if (candidate.distanceToEntry != null) {
        const distance = candidate.distanceToEntry;
        const expectedAbsolute = distance.executablePrice < candidate.entryBand.low
          ? candidate.entryBand.low - distance.executablePrice
          : distance.executablePrice > candidate.entryBand.high ? distance.executablePrice - candidate.entryBand.high : 0;
        const expectedPercent = expectedAbsolute / candidate.entryBand.ce * 100;
        check(candidate.quoteFresh === true && ['ASK', 'BID'].includes(distance.side) && distance.side === (candidate.direction === 'LONG' ? 'ASK' : 'BID')
          && distance.basis === 'NEAREST_ENTRY_BAND_EDGE'
          && [distance.executablePrice, distance.absolute, distance.percent, distance.quoteAt].every(Number.isFinite)
          && distance.executablePrice > 0 && distance.absolute >= 0 && distance.percent >= 0
          && Math.abs(distance.absolute - expectedAbsolute) <= Math.max(1e-9, expectedAbsolute * 1e-8)
          && Math.abs(distance.percent - expectedPercent) <= Math.max(1e-9, expectedPercent * 1e-8)
          && distance.quoteAt <= candidate.observedAt + 1000 && candidate.observedAt - distance.quoteAt <= 15000, 'SMC_ENTRY_DISTANCE');
      }
      check(typeof candidate.id === 'string' && candidate.id.length <= 150 && candidate.zone && ['FVG', 'FVG_OB'].includes(candidate.zone.kind)
        && Number.isFinite(candidate.zone.low) && candidate.zone.low > 0 && candidate.zone.high > candidate.zone.low && candidate.structure && Number.isFinite(candidate.structure.bosAt)
        && ['BOS', 'CHOCH', 'MSS'].includes(candidate.structure.eventType) && candidate.structure.nPatternRequired === false
        && ['BULLISH', 'BEARISH', 'RANGE'].includes(candidate.structure.priorBias)
        && candidate.structure.brokenPivot && candidate.structure.protectedPivot
        && candidate.structure.hierarchy?.revision === 'SMC-HIERARCHY-1'
        && candidate.structure.hierarchy.scope === 'EXTERNAL' && candidate.structure.hierarchy.externalQualified === true
        && ['BOS', 'TREND_CONFIRMED'].includes(candidate.structure.hierarchy.event)
        && candidate.structure.hierarchy.eventAt === candidate.structure.bosAt
        && candidate.structure.hierarchy.endpointAt === candidate.structure.brokenPivot.time
        && candidate.structure.hierarchy.endpointAvailableAt === candidate.structure.brokenPivot.confirmedAt
        && policy.executionCandidateGrades.includes(candidate.structure.qualityGrade)
        && ['SINGLE_BAR', 'CUMULATIVE_LEG'].includes(candidate.structure.qualityModel)
        && Number.isInteger(candidate.structure.qualityBars) && candidate.structure.qualityBars >= 1
        && candidate.structure.qualityBars <= policy.cumulativeDisplacementBars
        && candidate.entryBand && Number.isFinite(candidate.entryBand.low) && Number.isFinite(candidate.entryBand.high)
        && Number.isFinite(candidate.entryBand.ce) && Number.isFinite(candidate.entryBand.trigger)
        && candidate.entryBand.low < candidate.entryBand.high
        && candidate.entryBand.zoneFraction === 0.5
        && candidate.entryBand.triggerFraction === 0.5
        && candidate.entryBand.half === (candidate.direction === 'LONG'
          ? 'CE_TO_FVG_HIGH' : 'FVG_LOW_TO_CE')
        && (candidate.direction === 'LONG'
          ? candidate.entryBand.low === candidate.entryBand.ce && candidate.entryBand.high === candidate.zone.high
          : candidate.entryBand.low === candidate.zone.low && candidate.entryBand.high === candidate.entryBand.ce)
        && candidate.entryBand.trigger === candidate.entryBand.ce
        && candidate.referenceEntry === candidate.entryBand.trigger
        && candidate.zone.ce === candidate.entryBand.ce
        && candidate.zone.entryBand?.low === candidate.entryBand.low && candidate.zone.entryBand?.high === candidate.entryBand.high
        && candidate.poiLifecycle && Number.isSafeInteger(candidate.poiLifecycle.mitigationEpisodes)
        && candidate.poiLifecycle.mitigationEpisodes >= 0
        && candidate.poiLifecycle.mitigationEpisodes <= policy.maximumPoiMitigationEpisodes
        && Number.isSafeInteger(candidate.poiLifecycle.ceBodyCrosses) && candidate.poiLifecycle.ceBodyCrosses >= 0
        && candidate.poiLifecycle.ceBodyCrosses <= policy.maximumPoiCeBodyCrosses
        && candidate.poiLifecycle.exhausted === false && candidate.poiLifecycle.exhaustedReason === null
        && candidate.entryLiquidity?.model === 'CONFIRMED_15M_PIVOT_2X2'
        && candidate.entryLiquidity.lookbackBars === policy.entryLiquidityLookbackBars15m
        && Array.isArray(candidate.entryLiquidity.blocking) && Array.isArray(candidate.entryLiquidity.sweptOnConfirmation)
        && typeof candidate.entryLiquidity.ready === 'boolean'
        && Number.isFinite(candidate.entryLiquidity.provisionalStop) && candidate.entryLiquidity.provisionalStop > 0
        && candidate.entryLiquidity.adjustedStop === candidate.stop
        && candidate.entryLiquidity.stopAdjustedForLiquidity === (candidate.entryLiquidity.adjustedStop !== candidate.entryLiquidity.provisionalStop)
        && candidate.entryMicroStructure?.model === 'CLOSED_15M_POST_TOUCH_MICRO_SHIFT'
        && typeof candidate.entryMicroStructure.ready === 'boolean'
        && (candidate.status === 'WAIT_LIQUIDITY_SWEEP_RECLAIM')
          === (candidate.entryMicroStructure.ready && !candidate.entryLiquidity.ready
            && Boolean(candidate.entryConfirmation?.ceTouch))
        && candidate.entryLocation?.model === 'CAUSAL_15M_DUAL_DEALING_RANGE_PERCENTILE'
        && [candidate.entryLocation.percentile, candidate.entryLocation.robustLow,
          candidate.entryLocation.robustHigh, candidate.entryLocation.robustPercentile].every(Number.isFinite)
        && typeof candidate.entryLocation.ready === 'boolean'
        && candidate.entryRegime?.model === 'CAUSAL_15M_EXPANSION_EFFICIENCY'
        && [candidate.entryRegime.rangeAtr, candidate.entryRegime.efficiency,
          candidate.entryRegime.confirmationRangeAtr, candidate.entryRegime.directionalCloseLocation].every(Number.isFinite)
        && typeof candidate.entryRegime.ready === 'boolean'
        && (candidate.status === 'WAIT_VALUE_LOCATION')
          === (candidate.entryMicroStructure.ready && candidate.entryLiquidity.ready && !candidate.entryLocation.ready
            && Boolean(candidate.entryConfirmation?.ceTouch))
        && (candidate.status === 'WAIT_15M_EXPANSION_CONFIRMATION')
          === (candidate.entryMicroStructure.ready && candidate.entryLiquidity.ready
            && candidate.entryLocation.ready && !candidate.entryRegime.ready
            && Boolean(candidate.entryConfirmation?.ceTouch))
        && candidate.entryConfirmation?.state === candidate.status
        && (candidate.entryConfirmation?.mode === 'CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT'
          || candidate.entryConfirmation?.mode === 'CLOSED_15M_SECOND_BAR_CE_REVERSAL')
        && candidate.entryConfirmation?.closedBarRequired === true
        && (candidate.entryConfirmation?.mode === 'CLOSED_15M_SECOND_BAR_CE_REVERSAL'
          ? candidate.entryConfirmation.reversal?.firstBarAt >= candidate.zone.availableAt
            && candidate.entryConfirmation.reversal?.oldStop > 0
            && typeof candidate.entryConfirmation.reversal?.plannedStopSwept === 'boolean'
            && candidate.entryConfirmation.reversal?.revisedStop === candidate.entryLiquidity.provisionalStop
            && (candidate.status === 'WAIT_SECOND_BAR_CE_REVERSAL'
              || (candidate.entryConfirmation.reversal.secondBarAt === candidate.confirmationAt
                && candidate.entryConfirmation.reversal.secondBarAt > candidate.entryConfirmation.reversal.firstBarAt
                && (candidate.direction === 'LONG'
                  ? candidate.entryConfirmation.reversal.secondClose > candidate.entryBand.ce
                  : candidate.entryConfirmation.reversal.secondClose < candidate.entryBand.ce)))
          : (candidate.status === 'ARMED_CE_CLOSE' || (candidate.entryConfirmation?.ceTouch
          && ['CLOSED_15M_BODY_CROSS', 'CLOSED_15M_WICK_RECLAIM', 'CLOSED_15M_FALSE_BREAK_RECLAIM'].includes(candidate.entryConfirmation.ceTouch.source)
          && Number.isFinite(candidate.entryConfirmation.ceTouch.testedAt)
          && Number.isFinite(candidate.entryConfirmation.ceTouch.close)
          && candidate.entryConfirmation.ceTouch.close >= candidate.entryBand.low
          && candidate.entryConfirmation.ceTouch.close <= candidate.entryBand.high
          && candidate.entryConfirmation.microStructure?.model === candidate.entryMicroStructure.model
          && candidate.entryConfirmation.microStructure?.state === candidate.entryMicroStructure.state)))
        && Number.isFinite(candidate.confirmationAt)
        && (candidate.status !== 'ENTRY_BAND_ACTIVE' || (candidate.entry >= candidate.entryBand.low
          && candidate.entry <= candidate.entryBand.high && candidate.entryConfirmation.liveBboInsideBand === true))
        && (candidate.status !== 'SECOND_BAR_REVERSE_READY' || (candidate.quoteFresh === true
          && (candidate.direction === 'LONG' ? candidate.entry > candidate.entryBand.ce : candidate.entry < candidate.entryBand.ce)))
        && candidate.observedAt <= now + 5000 && now - candidate.observedAt <= policy.snapshotStaleAfterMs && candidate.expiresAt > now, 'SMC_EVIDENCE');
      if (candidate.structure.nPatternQualified === true) {
        const pattern = candidate.structure.nPattern;
        check(policy.nPatternRole === 'EVALUATED_STRUCTURE_MODEL' && pattern?.A && pattern?.B && pattern?.C && pattern?.D
          && Number.isFinite(pattern.D.close) && Number.isFinite(pattern.D.bodyAtr)
          && Number.isFinite(pattern.D.bodyFraction) && Number.isFinite(pattern.D.volumeRatio)
          && pattern.D.bodyAtr >= policy.displacementBodyAtr
          && pattern.D.bodyFraction >= policy.displacementBodyFraction
          && pattern.D.volumeRatio >= policy.displacementVolumeRatio, 'SMC_N_PATTERN_EVIDENCE');
      }
    }
    let structureContext = null;
    try { structureContext = sanitizeStructureContext(row.structureContext, now); } catch { /* Optional context fails unavailable, never becomes an order gate. */ }
    let stopContext = null;
    if (row.stopSafetyContext) { stopSafetyMetrics(row.stopSafetyContext, row.symbol, now); stopContext = row.stopSafetyContext; }
    let structurePlans = [];
    try { structurePlans = sanitizeStructurePlans(row.structurePlans, row.symbol, now); } catch { /* A planning error cannot admit a candidate. */ }
    return { symbol: row.symbol, candidates: row.candidates, structures: row.structures, manualZones,
      structureContext, structurePlans, stopSafetyContext: stopContext,
      planTerminals: sanitizePlanTerminals(row.planTerminals, row.symbol, now),
      planningQuote: row.planningQuote && [row.planningQuote.bid,row.planningQuote.ask,row.planningQuote.time].every(Number.isFinite)
        && row.planningQuote.bid > 0 && row.planningQuote.ask >= row.planningQuote.bid && row.planningQuote.time <= now + 1000 ? row.planningQuote : null,
      ...projectIntersectionObservation(row.intersectionClock,now), baselineCandidateCount: row.baselineCandidateCount ?? null,
      modelAssessments: Array.isArray(row.modelAssessments) ? row.modelAssessments.slice(0,2) : [],
      rejected: row.rejected, last4hCloseAt: row.last4hCloseAt, last15mCloseAt: row.last15mCloseAt };
  });
  check(raw.recentInvalidations == null || (Array.isArray(raw.recentInvalidations)
    && raw.recentInvalidations.length <= policy.maximumRecentInvalidations), 'SMC_RECENT_INVALIDATIONS');
  const activeIds = new Set(results.flatMap(row => row.candidates).map(row => row.id));
  const recentInvalidations = (raw.recentInvalidations ?? []).map(row => {
    check(typeof row.id === 'string' && row.id.length <= 150 && !activeIds.has(row.id)
      && policy.universe.includes(row.symbol) && ['LONG', 'SHORT'].includes(row.direction)
      && ['AUTOMATIC', 'OWNER_SELECTED'].includes(row.candidateSource)
      && (row.candidateSource === 'OWNER_SELECTED' ? Number.isFinite(row.ownerSelectedAt)
        && typeof row.ownerAutoTradingEnabled === 'boolean'
        : row.ownerSelectedAt == null && row.ownerAutoTradingEnabled == null)
      && typeof row.reason === 'string' && /^[A-Z0-9_]+$/.test(row.reason)
      && Number.isFinite(row.invalidatedAt) && row.invalidatedAt <= now + 5000
      && now - row.invalidatedAt <= policy.recentInvalidationRetentionMs
      && Number.isFinite(row.evidenceAt) && row.evidenceAt <= row.invalidatedAt + 5000
      && ['4H', '15M', 'SYSTEM'].includes(row.timeframe)
      && (row.level == null || (Number.isFinite(row.level) && row.level > 0))
      && (row.observed == null || (Number.isFinite(row.observed) && row.observed > 0))
      && row.entryBand && [row.entryBand.low, row.entryBand.high, row.entryBand.ce].every(value => Number.isFinite(value) && value > 0)
      && row.entryBand.low < row.entryBand.high
      && [row.stop, row.target, row.netR].every(value => Number.isFinite(value) && value > 0)
      && row.auditOnly === true && row.orderAuthority === false, 'SMC_RECENT_INVALIDATION');
    return { id: row.id, symbol: row.symbol, direction: row.direction,
      candidateSource: row.candidateSource, ownerSelectedAt: row.ownerSelectedAt ?? null,
      ownerAutoTradingEnabled: row.ownerAutoTradingEnabled ?? null, reason: row.reason,
      invalidatedAt: row.invalidatedAt, evidenceAt: row.evidenceAt, timeframe: row.timeframe,
      level: row.level ?? null, observed: row.observed ?? null,
      entryBand: row.entryBand, stop: row.stop, target: row.target, netR: row.netR,
      structure: row.structure ?? null, auditOnly: true, orderAuthority: false };
  });
  check(Array.isArray(raw.errors) && raw.errors.length <= policy.universe.length + 1, 'SMC_ERRORS');
  const errors = raw.errors.map(e => ({ symbol: policy.universe.includes(e.symbol) ? e.symbol : 'GLOBAL', reason: String(e.reason).slice(0, 160) }));
  for (const row of results) {
    const unavailable = Object.entries(row.structureContext?.frames ?? {}).find(([,frame]) => frame.status === 'UNAVAILABLE');
    if (unavailable && !errors.some(e => e.symbol === row.symbol)) {
      errors.push({symbol:row.symbol,reason:`${unavailable[0].toUpperCase()}_${unavailable[1].reason ?? 'CONTEXT_UNAVAILABLE'}`});
    }
  }
  check(raw.ownerSelectionFeed && ['READY', 'UNAVAILABLE'].includes(raw.ownerSelectionFeed.status)
    && Number.isFinite(raw.ownerSelectionFeed.checkedAt) && raw.ownerSelectionFeed.checkedAt <= now + 5000
    && Number.isSafeInteger(raw.ownerSelectionFeed.count) && raw.ownerSelectionFeed.count >= 0
    && raw.ownerSelectionFeed.count <= policy.universe.length * 2, 'SMC_OWNER_SELECTION_FEED');
  return { revision: policy.revision, mode: policy.mode, orderAuthority: false, sourceAsOf: raw.sourceAsOf, universe: policy.universe,
    status: results.length === policy.universe.length && !errors.length ? 'HEALTHY' : 'DEGRADED', results, errors,
    policy, scannedSymbols: results.length, candidates: results.flatMap(r => r.candidates), recentInvalidations,
    ownerSelectionFeed: raw.ownerSelectionFeed,
    producer: 'SMC_READ_ONLY_HOST_SCANNER' };
}
