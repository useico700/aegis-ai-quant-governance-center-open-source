// S1 adapter for the protected V2 finder. Geometry, ids and scoring use the
// same shared primitives. Only S1 supplies a pre-ranking eligibility filter.
// Default parity with the frozen finder is covered by regression tests.
import { structuralPivots, structuralPairs, fourHourLineageHypotheses, lockedBarOpenTime,
  clusterConvergenceCandidates, INTERVAL_MS } from '../../orion-v2/paper/paper-engine.mjs';
import { geometricPairs, UNTOUCHED_REVISION } from './intersection-geometry.mjs';
import { deterministicId } from '../../orion-v2/paper/runtime-utils.mjs';
import { intersectLines } from '../../../scripts/v2-mtf-trendline-intersection.mjs';

export function findReviewedConvergencePlan({ symbol, bars15m, bars1h, bars4h, now, strategy, candidateFilter = null, geometricOnly = false, diagnostics = null }) {
  if (!bars15m.at(-1) || !bars1h.at(-1) || !bars4h.at(-1)) return null;
  const high4 = structuralPivots(bars4h, "HIGH", strategy.pivots.fourHour);
  const low4 = structuralPivots(bars4h, "LOW", strategy.pivots.fourHour);
  const high1 = structuralPivots(bars1h, "HIGH", strategy.pivots.oneHour);
  const low1 = structuralPivots(bars1h, "LOW", strategy.pivots.oneHour);
  const pairs = geometricOnly ? geometricPairs : structuralPairs;
  const structures = [
    {
      pattern: "4H_DESC_HIGH__1H_ASC_LOW",
      four: fourHourLineageHypotheses(pairs(high4, low4, bars4h, -1, strategy.pivots.fourHour), strategy.pivots.fourHour),
      one: pairs(low1, high1, bars1h, 1, strategy.pivots.oneHour),
    },
    {
      pattern: "4H_ASC_LOW__1H_DESC_HIGH",
      four: fourHourLineageHypotheses(pairs(low4, high4, bars4h, 1, strategy.pivots.fourHour), strategy.pivots.fourHour),
      one: pairs(high1, low1, bars1h, -1, strategy.pivots.oneHour),
    },
  ];
  if (diagnostics) Object.assign(diagnostics, { patterns: structures.map(s => ({ pattern: s.pattern, fourHourHypotheses: s.four.length, oneHourPairs: s.one.length })), testedPairs: 0, timeEligible: 0, accepted: 0 });
  const candidates = [];
  for (const structure of structures) {
    for (const four of structure.four.slice(0, strategy.intersection.fourHourPairCandidates)) {
      for (const one of (geometricOnly ? structure.one : structure.one.slice(0, strategy.intersection.oneHourPairCandidates))) {
        if (diagnostics) diagnostics.testedPairs++;
        const latestConfirmation = Math.max(...(geometricOnly ? [four.first, four.second, one.first, one.second] : [four.second, one.second]).map(a => a.confirmedAt));
        if (latestConfirmation >= now) continue;
        const cross = intersectLines(four.line, one.line, strategy.intersection.minimumSlopeDifferencePer15m);
        if (!cross.valid) continue;
        const intersectionTime = cross.time * INTERVAL_MS["15m"];
        const latestAnchorCoordinate = Math.max(four.second.coordinate15m, one.second.coordinate15m);
        if (cross.time <= latestAnchorCoordinate) continue;
        if (intersectionTime <= now) continue;
        if (Number.isFinite(strategy.intersection.minimumDiscoveryLeadHours) &&
          intersectionTime < now + strategy.intersection.minimumDiscoveryLeadHours * INTERVAL_MS["1h"]) continue;
        if (Number.isFinite(strategy.intersection.maximumLeadHours) &&
          intersectionTime > now + strategy.intersection.maximumLeadHours * INTERVAL_MS["1h"]) continue;
        const containingOpen = Math.floor(intersectionTime / INTERVAL_MS["15m"]) * INTERVAL_MS["15m"];
        const lockedOpen = lockedBarOpenTime(intersectionTime);
        const boundaryDistance = Math.min(
          intersectionTime - containingOpen,
          containingOpen + INTERVAL_MS["15m"] - intersectionTime,
        );
        if (boundaryDistance < strategy.intersection.ambiguousBoundaryMs) continue;
        const anchors = [four.first, four.second, one.first, one.second];
        const commitmentLeadHours = Number.isFinite(strategy.intersection.commitmentLeadHours)
          ? strategy.intersection.commitmentLeadHours
          : 0;
        const id = deterministicId(geometricOnly ? "s1geo1" : "mtfx050r6", {
          symbol,
          pattern: structure.pattern,
          fourHourLineStatus: four.lineageStatus,
          anchors: anchors.map((item) => [item.type, item.time, item.price]),
        });
        const anchorQualityScore = (Number(four.qualityScore ?? 0) + Number(one.qualityScore ?? 0)) / 2;
        const candidate = {
          id,
          version: 1,
          ...(geometricOnly ? { candidateGeometryRevision: UNTOUCHED_REVISION, previousPolicyGeometryId: id.replace(/^s1geo1_/, "mtfx050r6_"), touchStartAt: Math.max(...anchors.map((a, i) => { const policy = i < 2 ? strategy.pivots.fourHour : strategy.pivots.oneHour; return a.time + (policy.rightBars * (policy.minimumRealtimeHierarchyMultiplier ?? 1) + 1) * (i < 2 ? INTERVAL_MS["4h"] : INTERVAL_MS["1h"]); })) } : {}),
          symbol,
          pattern: structure.pattern,
          fourHourLineStatus: four.lineageStatus,
          createdAt: now,
          latestConfirmation,
          intersectionCoordinate15m: cross.time,
          intersectionTime,
          intersectionPrice: cross.price,
          lockedBarOpenTime: lockedOpen,
          commitAt: intersectionTime - commitmentLeadHours * INTERVAL_MS["1h"],
          committed: now >= intersectionTime - commitmentLeadHours * INTERVAL_MS["1h"],
          frozen: now >= lockedOpen,
          implementationRevisionAtDiscovery: strategy.implementationRevision,
          selectionObjective: "MULTI_ANCHOR_STABLE_INTERSECTION_PRIOR",
          anchorQualityScore,
          scale: {
            fourHourSpan15m: four.span15m,
            oneHourSpan15m: one.span15m,
            fourHourAnchorProminenceFraction: four.anchorProminenceFraction,
            oneHourAnchorProminenceFraction: one.anchorProminenceFraction,
            fourHourPairMoveFraction: four.pairMoveFraction,
            oneHourPairMoveFraction: one.pairMoveFraction,
            fourHourHierarchyMultiplier: four.hierarchyMultiplier,
            oneHourHierarchyMultiplier: one.hierarchyMultiplier,
            importance: four.importance + one.importance,
          },
          fourHourLine: four.line,
          oneHourLine: one.line,
          anchors,
        };
        if (diagnostics) diagnostics.timeEligible++;
        if (!candidateFilter || candidateFilter(candidate)) { candidates.push(candidate); if (diagnostics) diagnostics.accepted++; }
      }
    }
  }
  return clusterConvergenceCandidates(
    candidates,
    strategy.intersection.anchorConsensus,
    strategy.intersection.minimumSlopeDifferencePer15m,
  )[0] ?? null;
}
