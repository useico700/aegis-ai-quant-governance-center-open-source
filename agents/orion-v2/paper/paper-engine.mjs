import {
  candleDirection,
  costAdjustedRiskPlan,
  intersectLines,
  lineFromPivots,
} from "../../../scripts/v2-mtf-trendline-intersection.mjs";
import { deterministicId, shanghaiDay } from "./runtime-utils.mjs";

export const INTERVAL_MS = { "15m": 900000, "1h": 3600000, "4h": 14400000 };

export function normalizeKlines(rows, serverTime) {
  if (!Array.isArray(rows)) throw new Error("KLINES_NOT_ARRAY");
  return rows.map((row) => ({
    openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
    close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]),
    quoteVolume: Number(row[7]), trades: Number(row[8]),
  })).filter((bar) =>
    [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.closeTime].every(Number.isFinite) &&
    bar.closeTime < serverTime && bar.high >= bar.low && bar.closeTime > bar.openTime
  ).sort((first, second) => first.openTime - second.openTime);
}

// Retained for diagnostics only. MTFX 0.5.0 does not use ATR to form or filter signals.
export function atrSeries(bars, period = 14) {
  const result = Array(bars.length).fill(null);
  const ranges = bars.map((bar, index) => {
    const previousClose = index > 0 ? bars[index - 1].close : bar.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
  let rolling = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    rolling += ranges[index];
    if (index >= period) rolling -= ranges[index - period];
    if (index >= period - 1) result[index] = rolling / period;
  }
  return result;
}

/**
 * Causal price-only swing points. `time` is always exchange bar OPEN time; this
 * removes the half-bar drift that existed in 0.4.0. An opposite swing must occur
 * between same-type anchors before a trendline pair can be formed.
 */
export function confirmedPivots(bars, type, { leftBars = 2, rightBars = 2 } = {}) {
  const pivots = [];
  for (let index = leftBars; index < bars.length - rightBars; index += 1) {
    const bar = bars[index];
    const window = bars.slice(index - leftBars, index + rightBars + 1);
    const value = type === "HIGH" ? bar.high : bar.low;
    const values = window.map((candidate) => type === "HIGH" ? candidate.high : candidate.low);
    const uniqueExtreme = type === "HIGH"
      ? values.every((candidate, offset) => offset === leftBars || value > candidate)
      : values.every((candidate, offset) => offset === leftBars || value < candidate);
    if (!uniqueExtreme) continue;
    const opposite = type === "HIGH"
      ? Math.min(...window.map((candidate) => candidate.low))
      : Math.max(...window.map((candidate) => candidate.high));
    pivots.push({
      type,
      index,
      time: bar.openTime,
      coordinate15m: bar.openTime / INTERVAL_MS["15m"],
      price: value,
      confirmedAt: bars[index + rightBars].closeTime,
      prominenceAbsolute: Math.abs(value - opposite),
    });
  }
  return pivots;
}

/**
 * Adds a causal multi-scale qualification to the base pivots used for 4H/1H
 * structure discovery. A pivot only receives a wider hierarchy multiplier
 * after every right-hand bar for that wider window has closed.
 */
export function structuralPivots(bars, type, timeframePolicy) {
  const base = confirmedPivots(bars, type, timeframePolicy);
  const multipliers = [...new Set(timeframePolicy.hierarchyWindowMultipliers ?? [1])]
    .filter((value) => Number.isInteger(value) && value >= 1)
    .sort((first, second) => first - second);
  const leftBars = timeframePolicy.leftBars ?? 2;
  const rightBars = timeframePolicy.rightBars ?? 2;
  return base.map((pivot) => {
    let hierarchyMultiplier = 1;
    let confirmedAt = pivot.confirmedAt;
    for (const multiplier of multipliers) {
      const scaledLeft = leftBars * multiplier;
      const scaledRight = rightBars * multiplier;
      if (pivot.index < scaledLeft || pivot.index + scaledRight >= bars.length) continue;
      const value = pivot.price;
      const window = bars.slice(pivot.index - scaledLeft, pivot.index + scaledRight + 1);
      const uniqueExtreme = window.every((candidate, offset) => {
        if (offset === scaledLeft) return true;
        return type === "HIGH" ? value > candidate.high : value < candidate.low;
      });
      if (!uniqueExtreme) continue;
      hierarchyMultiplier = multiplier;
      confirmedAt = bars[pivot.index + scaledRight].closeTime;
    }
    return {
      ...pivot,
      baseConfirmedAt: pivot.confirmedAt,
      confirmedAt,
      hierarchyMultiplier,
      hierarchySpanBars: (leftBars + rightBars) * hierarchyMultiplier + 1,
    };
  });
}

function hasOppositeBetween(opposites, first, second) {
  return opposites.some((pivot) => pivot.index > first.index && pivot.index < second.index);
}

function respectsAnchorEnvelope(bars, first, second, line, direction, toleranceAbsolute) {
  for (let index = first.index + 1; index < second.index; index += 1) {
    const coordinate15m = bars[index].openTime / INTERVAL_MS["15m"];
    const linePrice = line.anchorPrice + line.slope * (coordinate15m - line.anchorTime);
    if (direction === -1 && bars[index].high > linePrice + toleranceAbsolute) return false;
    if (direction === 1 && bars[index].low < linePrice - toleranceAbsolute) return false;
  }
  return true;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function scoreAboveFloor(value, floor) {
  if (!(value >= 0)) return 0;
  if (!(floor > 0)) return value > 0 ? 1 : 0;
  return clamp01(value / (floor * 2));
}

function preferredAgeScore(ageFraction, preferred = {}) {
  const minimum = Number(preferred.minimum ?? 0);
  const maximum = Number(preferred.maximum ?? 1);
  if (!(ageFraction >= 0) || !(maximum > minimum)) return 0;
  if (ageFraction < minimum) return minimum > 0 ? clamp01(ageFraction / minimum) : 1;
  if (ageFraction > maximum) return clamp01(maximum / ageFraction);
  return 1;
}

export function anchorPairQuality(pair, timeframePolicy = {}) {
  const multipliers = timeframePolicy.hierarchyWindowMultipliers ?? [1];
  const maximumHierarchy = Math.max(1, ...multipliers);
  const hierarchyScore = Math.log2(Math.max(1, pair.hierarchyMultiplier ?? 1) + 1) /
    Math.log2(maximumHierarchy + 1);
  const prominenceScore = scoreAboveFloor(
    pair.anchorProminenceFraction,
    timeframePolicy.minimumAnchorProminenceFractionOfVisibleRange,
  );
  const moveScore = scoreAboveFloor(
    pair.pairMoveFraction,
    timeframePolicy.minimumPairMoveFractionOfVisibleRange,
  );
  const spanScore = scoreAboveFloor(
    pair.spanFraction,
    timeframePolicy.minimumPairSpanFractionOfSearchWindow,
  );
  const ageScore = preferredAgeScore(
    pair.secondAnchorAgeFraction,
    timeframePolicy.preferredSecondAnchorAgeFraction,
  );
  return clamp01((hierarchyScore + prominenceScore + moveScore + spanScore + ageScore) / 5);
}

export function structuralPairs(pivots, opposites, bars, direction, timeframePolicy) {
  const minimumSeparationBars = timeframePolicy.minimumAnchorSeparationBars ?? timeframePolicy.minimumSeparationBars ?? 1;
  const { searchWindowBars } = timeframePolicy;
  const earliestIndex = Math.max(0, bars.length - searchWindowBars);
  const recent = pivots.filter((pivot) => pivot.index >= earliestIndex);
  const visibleBars = bars.slice(-searchWindowBars);
  const visibleRange = Math.max(...visibleBars.map((bar) => bar.high)) - Math.min(...visibleBars.map((bar) => bar.low));
  if (!(visibleRange > 0)) return [];
  const toleranceAbsolute = visibleRange * (timeframePolicy.maximumIntermediateViolationFractionOfVisibleRange ?? 0);
  const pairs = [];
  for (let secondIndex = 1; secondIndex < recent.length; secondIndex += 1) {
    const second = recent[secondIndex];
    for (let firstIndex = 0; firstIndex < secondIndex; firstIndex += 1) {
      const first = recent[firstIndex];
      if (second.index - first.index < minimumSeparationBars) continue;
      if (Math.sign(second.price - first.price) !== direction) continue;
      if (!hasOppositeBetween(opposites, first, second)) continue;
      const anchorProminenceFraction = (first.prominenceAbsolute + second.prominenceAbsolute) / (2 * visibleRange);
      const pairMoveFraction = Math.abs(second.price - first.price) / visibleRange;
      const spanFraction = (second.index - first.index) / searchWindowBars;
      if (anchorProminenceFraction < timeframePolicy.minimumAnchorProminenceFractionOfVisibleRange) continue;
      if (pairMoveFraction < timeframePolicy.minimumPairMoveFractionOfVisibleRange) continue;
      if (spanFraction < timeframePolicy.minimumPairSpanFractionOfSearchWindow) continue;
      const line = lineFromPivots(
        { time: first.coordinate15m, price: first.price },
        { time: second.coordinate15m, price: second.price },
      );
      if (!respectsAnchorEnvelope(bars, first, second, line, direction, toleranceAbsolute)) continue;
      const span15m = second.coordinate15m - first.coordinate15m;
      const hierarchyMultiplier = Math.min(first.hierarchyMultiplier ?? 1, second.hierarchyMultiplier ?? 1);
      const importance = span15m * (first.prominenceAbsolute + second.prominenceAbsolute) *
        (1 + pairMoveFraction) * (1 + Math.log2(hierarchyMultiplier));
      const pair = {
        first, second, line, span15m, importance, hierarchyMultiplier,
        anchorProminenceFraction, pairMoveFraction, spanFraction,
        secondAnchorAgeFraction: (bars.length - 1 - second.index) / searchWindowBars,
      };
      pair.qualityScore = anchorPairQuality(pair, timeframePolicy);
      pairs.push(pair);
    }
  }
  return pairs.sort((a, b) =>
    b.hierarchyMultiplier - a.hierarchyMultiplier ||
    b.importance - a.importance ||
    b.second.time - a.second.time
  );
}

export function fourHourLineage(pairs, timeframePolicy = {}) {
  const minimumHierarchy = timeframePolicy.minimumRealtimeHierarchyMultiplier ?? 1;
  const qualified = pairs.filter((pair) => pair.hierarchyMultiplier >= minimumHierarchy);
  const source = qualified.length ? qualified : pairs;
  if (!source.length) return [];
  const latestSecondTime = Math.max(...source.map((pair) => pair.second.time));
  const active = source.filter((pair) => pair.second.time === latestSecondTime)
    .sort((a, b) =>
      b.hierarchyMultiplier - a.hierarchyMultiplier ||
      b.importance - a.importance ||
      b.first.time - a.first.time
    )[0];
  const previous = source.filter((pair) => pair !== active && pair.second.time <= active.first.time)
    .sort((a, b) =>
      Number(b.second.time === active.first.time) - Number(a.second.time === active.first.time) ||
      b.second.time - a.second.time ||
      b.hierarchyMultiplier - a.hierarchyMultiplier ||
      b.importance - a.importance
    )[0] ?? null;
  return [active, previous].filter(Boolean)
    .map((pair, index) => ({
      ...pair,
      lineageStatus: index === 0 ? "ACTIVE_4H_TREND" : "PREVIOUS_4H_CANDIDATE",
      lineageVersion: index === 0 ? 1 : 0,
    }));
}

/**
 * Keeps several legitimate anchor hypotheses inside each of the two authorised
 * 4H lineages. The lifecycle is still bounded to ACTIVE/PREVIOUS; only the
 * anchor explanation within a lineage is plural.
 */
export function fourHourLineageHypotheses(pairs, timeframePolicy = {}) {
  const minimumHierarchy = timeframePolicy.minimumRealtimeHierarchyMultiplier ?? 1;
  const qualified = pairs.filter((pair) => pair.hierarchyMultiplier >= minimumHierarchy);
  const source = qualified.length ? qualified : pairs;
  if (!source.length) return [];
  const maximumHypotheses = Math.max(1, Number(timeframePolicy.maximumAnchorHypothesesPerLineage ?? 1));
  const sortPairs = (items) => [...items].sort((a, b) =>
    b.hierarchyMultiplier - a.hierarchyMultiplier ||
    b.qualityScore - a.qualityScore ||
    b.importance - a.importance ||
    b.first.time - a.first.time
  );
  const activeSecondTime = Math.max(...source.map((pair) => pair.second.time));
  const active = sortPairs(source.filter((pair) => pair.second.time === activeSecondTime))
    .slice(0, maximumHypotheses);
  const activeReference = active[0];
  const previousPool = source.filter((pair) => pair.second.time <= activeReference.first.time);
  const previousSecondTime = previousPool.length
    ? Math.max(...previousPool.map((pair) => pair.second.time))
    : null;
  const previous = previousSecondTime == null
    ? []
    : sortPairs(previousPool.filter((pair) => pair.second.time === previousSecondTime))
      .slice(0, maximumHypotheses);
  return [
    ...active.map((pair) => ({ ...pair, lineageStatus: "ACTIVE_4H_TREND", lineageVersion: 1 })),
    ...previous.map((pair) => ({ ...pair, lineageStatus: "PREVIOUS_4H_CANDIDATE", lineageVersion: 0 })),
  ];
}

export function lockedBarOpenTime(intersectionTime) {
  return Math.floor(intersectionTime / INTERVAL_MS["15m"]) * INTERVAL_MS["15m"];
}

export function isPlanCommitted(plan, now) {
  return Number.isFinite(plan?.commitAt) && now >= plan.commitAt;
}

export function compareConvergenceCandidates(a, b) {
  const activePriority = (candidate) => candidate.fourHourLineStatus === "ACTIVE_4H_TREND" ? 1 : 0;
  const weakestHierarchy = (candidate) => Math.min(
    Number(candidate.scale.fourHourHierarchyMultiplier ?? 1),
    Number(candidate.scale.oneHourHierarchyMultiplier ?? 1),
  );
  const weakestNormalizedStructure = (candidate) => Math.min(
    Number(candidate.scale.fourHourAnchorProminenceFraction ?? 0),
    Number(candidate.scale.oneHourAnchorProminenceFraction ?? 0),
    Number(candidate.scale.fourHourPairMoveFraction ?? 0),
    Number(candidate.scale.oneHourPairMoveFraction ?? 0),
  );
  return activePriority(b) - activePriority(a) ||
    Number(b.anchorConsensus?.stabilityScore ?? 0) - Number(a.anchorConsensus?.stabilityScore ?? 0) ||
    Number(b.anchorQualityScore ?? 0) - Number(a.anchorQualityScore ?? 0) ||
    weakestHierarchy(b) - weakestHierarchy(a) ||
    b.scale.fourHourHierarchyMultiplier - a.scale.fourHourHierarchyMultiplier ||
    b.scale.oneHourHierarchyMultiplier - a.scale.oneHourHierarchyMultiplier ||
    weakestNormalizedStructure(b) - weakestNormalizedStructure(a) ||
    b.scale.importance - a.scale.importance ||
    a.intersectionTime - b.intersectionTime ||
    b.latestConfirmation - a.latestConfirmation;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function anchorIntersectionSensitivity(candidate, policy = {}, minimumSlopeDifference = 1e-12) {
  const anchors = candidate?.anchors ?? [];
  if (anchors.length !== 4 || !Number.isFinite(candidate?.intersectionCoordinate15m)) {
    return { score: 0, validPerturbations: 0, totalPerturbations: 8, medianDriftMinutes: null, maximumDriftMinutes: null };
  }
  const steps = [
    INTERVAL_MS["4h"] / INTERVAL_MS["15m"],
    INTERVAL_MS["4h"] / INTERVAL_MS["15m"],
    INTERVAL_MS["1h"] / INTERVAL_MS["15m"],
    INTERVAL_MS["1h"] / INTERVAL_MS["15m"],
  ].map((step) => step * Number(policy.perturbationBars ?? 1));
  const drifts = [];
  let totalPerturbations = 0;
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    for (const sign of [-1, 1]) {
      totalPerturbations += 1;
      const shifted = anchors.map((anchor, index) => ({
        ...anchor,
        coordinate15m: anchor.coordinate15m + (index === anchorIndex ? sign * steps[index] : 0),
      }));
      if (!(shifted[1].coordinate15m > shifted[0].coordinate15m) ||
        !(shifted[3].coordinate15m > shifted[2].coordinate15m)) continue;
      const fourLine = lineFromPivots(
        { time: shifted[0].coordinate15m, price: shifted[0].price },
        { time: shifted[1].coordinate15m, price: shifted[1].price },
      );
      const oneLine = lineFromPivots(
        { time: shifted[2].coordinate15m, price: shifted[2].price },
        { time: shifted[3].coordinate15m, price: shifted[3].price },
      );
      const cross = intersectLines(fourLine, oneLine, minimumSlopeDifference);
      if (!cross.valid) continue;
      drifts.push(Math.abs(cross.time - candidate.intersectionCoordinate15m) * 15);
    }
  }
  const medianDriftMinutes = median(drifts);
  const maximumDriftMinutes = drifts.length ? Math.max(...drifts) : null;
  const stableDriftMinutes = Math.max(1, Number(policy.stablePerturbationDriftMinutes ?? 240));
  const validFraction = totalPerturbations ? drifts.length / totalPerturbations : 0;
  const driftScore = medianDriftMinutes == null ? 0 : 1 / (1 + medianDriftMinutes / stableDriftMinutes);
  return {
    score: clamp01(validFraction * driftScore),
    validPerturbations: drifts.length,
    totalPerturbations,
    medianDriftMinutes,
    maximumDriftMinutes,
  };
}

function candidateClusterKey(candidate) {
  return `${candidate.pattern}|${candidate.fourHourLineStatus}`;
}

function bpsDistance(first, second) {
  const denominator = Math.max(Math.abs(first), Math.abs(second), Number.EPSILON);
  return Math.abs(first - second) / denominator * 10_000;
}

export function clusterConvergenceCandidates(candidates, policy = {}, minimumSlopeDifference = 1e-12) {
  if (!candidates.length) return [];
  const radiusMs = Math.max(1, Number(policy.clusterTimeRadiusMinutes ?? 120)) * 60_000;
  const priceRadiusBps = Math.max(1, Number(policy.clusterPriceRadiusBps ?? 100));
  const minimumHighSupport = Math.max(1, Number(policy.highStabilityMinimumSupport ?? 3));
  const maximumEvidence = Math.max(1, Number(policy.maximumEvidenceHypotheses ?? 12));
  const gradeHigh = Number(policy.gradeThresholds?.high ?? 0.75);
  const gradeMedium = Number(policy.gradeThresholds?.medium ?? 0.55);
  const weights = {
    support: Number(policy.stabilityWeights?.support ?? 0.4),
    time: Number(policy.stabilityWeights?.timeDispersion ?? 0.15),
    price: Number(policy.stabilityWeights?.priceDispersion ?? 0.1),
    quality: Number(policy.stabilityWeights?.pairQuality ?? 0.15),
    sensitivity: Number(policy.stabilityWeights?.perturbationSensitivity ?? 0.2),
  };
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const clusters = [];
  const seen = new Set();
  for (const seed of candidates) {
    const members = candidates.filter((candidate) =>
      candidateClusterKey(candidate) === candidateClusterKey(seed) &&
      Math.abs(candidate.intersectionTime - seed.intersectionTime) <= radiusMs &&
      bpsDistance(candidate.intersectionPrice, seed.intersectionPrice) <= priceRadiusBps
    );
    const signature = members.map((candidate) => candidate.id).sort().join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);
    const enriched = members.map((candidate) => ({
      ...candidate,
      anchorSensitivity: candidate.anchorSensitivity ?? anchorIntersectionSensitivity(
        candidate,
        policy,
        minimumSlopeDifference,
      ),
    }));
    const totalQuality = enriched.reduce((sum, candidate) => sum + Math.max(0.001, candidate.anchorQualityScore), 0);
    const centerTime = enriched.reduce((sum, candidate) =>
      sum + candidate.intersectionTime * Math.max(0.001, candidate.anchorQualityScore), 0) / totalQuality;
    const centerPrice = enriched.reduce((sum, candidate) =>
      sum + candidate.intersectionPrice * Math.max(0.001, candidate.anchorQualityScore), 0) / totalQuality;
    const canonical = [...enriched].sort((a, b) =>
      (Math.abs(a.intersectionTime - centerTime) / radiusMs + bpsDistance(a.intersectionPrice, centerPrice) / priceRadiusBps) -
      (Math.abs(b.intersectionTime - centerTime) / radiusMs + bpsDistance(b.intersectionPrice, centerPrice) / priceRadiusBps) ||
      compareConvergenceCandidates(a, b)
    )[0];
    const times = enriched.map((candidate) => candidate.intersectionTime);
    const prices = enriched.map((candidate) => candidate.intersectionPrice);
    const windowStart = Math.min(...times);
    const windowEnd = Math.max(...times);
    const timeDispersionScore = clamp01(1 - (windowEnd - windowStart) / (2 * radiusMs));
    const priceDispersion = bpsDistance(Math.min(...prices), Math.max(...prices));
    const priceDispersionScore = clamp01(1 - priceDispersion / (2 * priceRadiusBps));
    const supportScore = clamp01(enriched.length / minimumHighSupport);
    const pairQualityScore = enriched.reduce((sum, candidate) => sum + candidate.anchorQualityScore, 0) / enriched.length;
    const perturbationSensitivityScore = enriched.reduce((sum, candidate) => sum + candidate.anchorSensitivity.score, 0) / enriched.length;
    const stabilityScore = clamp01((
      supportScore * Math.max(0, weights.support) +
      timeDispersionScore * Math.max(0, weights.time) +
      priceDispersionScore * Math.max(0, weights.price) +
      pairQualityScore * Math.max(0, weights.quality) +
      perturbationSensitivityScore * Math.max(0, weights.sensitivity)
    ) / weightTotal);
    const grade = stabilityScore >= gradeHigh && enriched.length >= minimumHighSupport
      ? "HIGH"
      : stabilityScore >= gradeMedium ? "MEDIUM" : "LOW";
    clusters.push({
      ...canonical,
      intersectionCenterTime: centerTime,
      intersectionCenterPrice: centerPrice,
      intersectionWindowStart: windowStart,
      intersectionWindowEnd: windowEnd,
      lockedBarOpenTime: lockedBarOpenTime(canonical.intersectionTime),
      anchorConsensus: {
        method: "MULTI_ANCHOR_INTERSECTION_CLUSTER_AND_ONE_BAR_PERTURBATION",
        support: enriched.length,
        stabilityScore,
        grade,
        timeWindowMinutes: (windowEnd - windowStart) / 60_000,
        priceDispersionBps: priceDispersion,
        pairQualityScore,
        perturbationSensitivityScore,
        lowStabilityAction: "KEEP_FOR_PAPER_OBSERVATION_NOT_BLOCK",
        hypotheses: enriched.sort(compareConvergenceCandidates).slice(0, maximumEvidence).map((candidate) => ({
          id: candidate.id,
          intersectionTime: candidate.intersectionTime,
          intersectionPrice: candidate.intersectionPrice,
          anchorQualityScore: candidate.anchorQualityScore,
          sensitivity: candidate.anchorSensitivity,
          anchors: candidate.anchors.map((anchor) => ({
            type: anchor.type,
            time: anchor.time,
            price: anchor.price,
            hierarchyMultiplier: anchor.hierarchyMultiplier,
          })),
        })),
      },
    });
  }
  return clusters.sort(compareConvergenceCandidates);
}

export function findConvergencePlan({ symbol, bars15m, bars1h, bars4h, now, strategy }) {
  if (!bars15m.at(-1) || !bars1h.at(-1) || !bars4h.at(-1)) return null;
  const high4 = structuralPivots(bars4h, "HIGH", strategy.pivots.fourHour);
  const low4 = structuralPivots(bars4h, "LOW", strategy.pivots.fourHour);
  const high1 = structuralPivots(bars1h, "HIGH", strategy.pivots.oneHour);
  const low1 = structuralPivots(bars1h, "LOW", strategy.pivots.oneHour);
  const structures = [
    {
      pattern: "4H_DESC_HIGH__1H_ASC_LOW",
      four: fourHourLineageHypotheses(structuralPairs(high4, low4, bars4h, -1, strategy.pivots.fourHour), strategy.pivots.fourHour),
      one: structuralPairs(low1, high1, bars1h, 1, strategy.pivots.oneHour),
    },
    {
      pattern: "4H_ASC_LOW__1H_DESC_HIGH",
      four: fourHourLineageHypotheses(structuralPairs(low4, high4, bars4h, 1, strategy.pivots.fourHour), strategy.pivots.fourHour),
      one: structuralPairs(high1, low1, bars1h, -1, strategy.pivots.oneHour),
    },
  ];
  const nowCoordinate = now / INTERVAL_MS["15m"];
  const candidates = [];
  for (const structure of structures) {
    for (const four of structure.four.slice(0, strategy.intersection.fourHourPairCandidates)) {
      for (const one of structure.one.slice(0, strategy.intersection.oneHourPairCandidates)) {
        const latestConfirmation = Math.max(four.second.confirmedAt, one.second.confirmedAt);
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
        const id = deterministicId("mtfx050r6", {
          symbol,
          pattern: structure.pattern,
          fourHourLineStatus: four.lineageStatus,
          anchors: anchors.map((item) => [item.type, item.time, item.price]),
        });
        const anchorQualityScore = (Number(four.qualityScore ?? 0) + Number(one.qualityScore ?? 0)) / 2;
        candidates.push({
          id,
          version: 1,
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
        });
      }
    }
  }
  return clusterConvergenceCandidates(
    candidates,
    strategy.intersection.anchorConsensus,
    strategy.intersection.minimumSlopeDifferencePer15m,
  )[0] ?? null;
}

function compositePriceBar(bars) {
  const first = bars[0];
  const last = bars.at(-1);
  return {
    openTime: first.openTime,
    closeTime: last.closeTime,
    open: first.open,
    high: Math.max(...bars.map((bar) => bar.high)),
    low: Math.min(...bars.map((bar) => bar.low)),
    close: last.close,
  };
}

function priceAcceptance(patternBars, plan, signalPolicy) {
  const composite = compositePriceBar(patternBars);
  const range = composite.high - composite.low;
  const entryMode = signalPolicy.entryMode ?? "CONTIGUOUS_PRICE_PATTERN";
  if (entryMode === "CROSS_BAR_CLOSE_WITH_BUFFER" || entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER") {
    const intersectionPrice = Number(plan.intersectionPrice);
    const bufferBps = Number(signalPolicy.crossCloseBufferBps ?? 5);
    if (!(intersectionPrice > 0) || !(bufferBps >= 0)) return null;
    const upperTrigger = intersectionPrice * (1 + bufferBps / 10_000);
    const lowerTrigger = intersectionPrice * (1 - bufferBps / 10_000);
    const direction = composite.close >= upperTrigger ? 1 : composite.close <= lowerTrigger ? -1 : 0;
    if (direction === 0) return null;
    return {
      composite,
      direction,
      bodyToRange: range > 0 ? Math.abs(composite.close - composite.open) / range : null,
      closeLocation: range > 0 ? (composite.close - composite.low) / range : null,
      crossCloseBufferBps: bufferBps,
      upperTrigger,
      lowerTrigger,
    };
  }
  const direction = candleDirection(composite);
  if (!(range > 0) || direction === 0) return null;
  const bodyToRange = Math.abs(composite.close - composite.open) / range;
  const closeLocation = (composite.close - composite.low) / range;
  const minimumBodyToRange = Number(signalPolicy.minimumBodyToRange ?? 0.5);
  const longMinimumCloseLocation = Number(signalPolicy.longMinimumCloseLocation ?? 0.75);
  const shortMaximumCloseLocation = Number(signalPolicy.shortMaximumCloseLocation ?? 0.25);
  if (bodyToRange < minimumBodyToRange) return null;
  if (direction === 1 && (closeLocation < longMinimumCloseLocation || composite.close <= plan.intersectionPrice)) return null;
  if (direction === -1 && (closeLocation > shortMaximumCloseLocation || composite.close >= plan.intersectionPrice)) return null;
  return { composite, direction, bodyToRange, closeLocation };
}

export function confirmationReserveState({ plan, bars15m, now, signalPolicy = {} }) {
  const maximumReserveBars = Number(signalPolicy.maximumReserveBars ?? 4);
  const entryMode = signalPolicy.entryMode ?? "CONTIGUOUS_PRICE_PATTERN";
  const allowedPatternLengths = [...(signalPolicy.allowedPatternLengths ?? [1, 2, 3])]
    .filter((length) => Number.isInteger(length) && length > 0)
    .sort((a, b) => a - b);
  const reserveEndOpenTime = plan.lockedBarOpenTime + maximumReserveBars * INTERVAL_MS["15m"];
  const reserveBars = bars15m.filter((bar) =>
    bar.openTime >= plan.lockedBarOpenTime &&
    bar.openTime < reserveEndOpenTime &&
    bar.closeTime < now
  ).sort((a, b) => a.openTime - b.openTime);
  const acceptedSignals = [];
  if (entryMode === "CROSS_BAR_CLOSE_WITH_BUFFER" || entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER") {
    const maximumDirectionDecisionBars = entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER"
      ? Number(signalPolicy.maximumDirectionDecisionBars ?? 2)
      : 1;
    for (const crossBar of reserveBars.slice(0, maximumDirectionDecisionBars)) {
      const acceptance = priceAcceptance([crossBar], plan, signalPolicy);
      if (acceptance) {
        acceptedSignals.push({
          accepted: true,
          terminal: true,
          reason: entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER"
            ? "TWO_BAR_CROSS_CLOSE_BEYOND_BUFFER"
            : "CROSS_BAR_CLOSE_BEYOND_BUFFER",
          bar: crossBar,
          patternBars: [crossBar],
          patternLength: 1,
          directionDecisionBarNumber: Math.round((crossBar.openTime - plan.lockedBarOpenTime) / INTERVAL_MS["15m"]) + 1,
          composite: acceptance.composite,
          direction: acceptance.direction,
          bodyToRange: acceptance.bodyToRange,
          closeLocation: acceptance.closeLocation,
          crossCloseBufferBps: acceptance.crossCloseBufferBps,
          upperTrigger: acceptance.upperTrigger,
          lowerTrigger: acceptance.lowerTrigger,
          entryPlan: {
            accepted: true,
            action: entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER"
              ? "AFTER_FIRST_ELIGIBLE_CLOSE_IN_CROSS_OR_IMMEDIATE_NEXT_15M_BAR"
              : "AFTER_CROSS_15M_BAR_CLOSE",
            reason: acceptance.direction === 1 ? "CLOSE_ABOVE_INTERSECTION_BUFFER" : "CLOSE_BELOW_INTERSECTION_BUFFER",
          },
        });
        break;
      }
    }
    return {
      maximumReserveBars,
      reserveBars,
      reserveBarsObserved: reserveBars.length,
      reserveComplete: reserveBars.length >= maximumReserveBars,
      maximumDirectionDecisionBars,
      signalDecisionComplete: reserveBars.length >= maximumDirectionDecisionBars,
      latestReserveBar: reserveBars.at(-1) ?? null,
      acceptedSignals,
    };
  }
  for (let end = 0; end < reserveBars.length; end += 1) {
    for (const length of allowedPatternLengths) {
      const start = end - length + 1;
      if (start < 0) continue;
      const patternBars = reserveBars.slice(start, end + 1);
      const acceptance = priceAcceptance(patternBars, plan, signalPolicy);
      if (!acceptance) continue;
      acceptedSignals.push({
        accepted: true,
        terminal: true,
        reason: "POST_CROSS_PRICE_PATTERN_ACCEPTED",
        bar: patternBars.at(-1),
        patternBars,
        patternLength: length,
        composite: acceptance.composite,
        direction: acceptance.direction,
        bodyToRange: acceptance.bodyToRange,
        closeLocation: acceptance.closeLocation,
        entryPlan: {
          accepted: true,
          action: "IMMEDIATE_AFTER_ACCEPTED_PATTERN_CLOSE",
          reason: acceptance.direction === 1 ? "BULLISH_PRICE_ACCEPTANCE" : "BEARISH_PRICE_ACCEPTANCE",
        },
      });
      break;
    }
  }
  return {
    maximumReserveBars,
    reserveBars,
    reserveBarsObserved: reserveBars.length,
    reserveComplete: reserveBars.length >= maximumReserveBars,
    latestReserveBar: reserveBars.at(-1) ?? null,
    acceptedSignals,
  };
}

export function signalForPlan({ plan, bars15m, now, signalPolicy = {} }) {
  const reserve = confirmationReserveState({ plan, bars15m, now, signalPolicy });
  if (!reserve.reserveBars.length) {
    return {
      accepted: false,
      terminal: false,
      reason: "CONFIRMATION_RESERVE_NOT_CLOSED",
      ...reserve,
    };
  }
  if (reserve.acceptedSignals.length) {
    return {
      ...reserve.acceptedSignals[0],
      ...reserve,
    };
  }
  const crossCloseBufferedMode = signalPolicy.entryMode === "CROSS_BAR_CLOSE_WITH_BUFFER" || signalPolicy.entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER";
  if (crossCloseBufferedMode && reserve.signalDecisionComplete) {
    return {
      accepted: false,
      terminal: true,
      reason: signalPolicy.entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER"
        ? "TWO_BAR_CROSS_CLOSES_INSIDE_BUFFER"
        : "CROSS_BAR_CLOSE_INSIDE_BUFFER",
      bar: reserve.latestReserveBar,
      ...reserve,
    };
  }
  if (crossCloseBufferedMode && reserve.reserveBars.length < reserve.maximumDirectionDecisionBars) {
    return {
      accepted: false,
      terminal: false,
      reason: signalPolicy.entryMode === "TWO_BAR_CROSS_CLOSE_WITH_BUFFER"
        ? "CROSS_BUFFER_WAITING_IMMEDIATE_SECOND_BAR"
        : "CONFIRMATION_RESERVE_OPEN",
      bar: reserve.latestReserveBar,
      ...reserve,
    };
  }
  if (reserve.reserveComplete) {
    return {
      accepted: false,
      terminal: true,
      reason: "CONFIRMATION_RESERVE_EXPIRED",
      bar: reserve.latestReserveBar,
      ...reserve,
    };
  }
  return {
    accepted: false,
    terminal: false,
    reason: "CONFIRMATION_RESERVE_OPEN",
    bar: reserve.latestReserveBar,
    ...reserve,
  };
}

export function fibonacciStructureStop(direction, firstNearest, secondEarlier, ratio = 0.618) {
  if (![1, -1].includes(direction) || ![firstNearest, secondEarlier, ratio].every(Number.isFinite)) {
    return { accepted: false, reason: "INVALID_FIBONACCI_STOP_INPUT" };
  }
  if (direction === 1 && !(firstNearest > secondEarlier)) {
    return { accepted: false, reason: "LONG_REQUIRES_NEAREST_HIGHER_LOW" };
  }
  if (direction === -1 && !(firstNearest < secondEarlier)) {
    return { accepted: false, reason: "SHORT_REQUIRES_NEAREST_LOWER_HIGH" };
  }
  return {
    accepted: true,
    reason: "FIBONACCI_0618_STRUCTURE_STOP",
    stop: firstNearest + ratio * (secondEarlier - firstNearest),
  };
}

export function intersectionBufferStop(direction, intersectionPrice, bufferBps = 5, cutoffBar = null) {
  const cross = Number(intersectionPrice);
  const buffer = Number(bufferBps);
  if (![1, -1].includes(direction) || !(cross > 0) || !(buffer >= 0)) {
    return { accepted: false, reason: "INTERSECTION_BUFFER_STOP_INPUT_INVALID" };
  }
  return {
    accepted: true,
    reason: "INTERSECTION_BUFFER_INITIAL_STOP",
    source: "CANONICAL_INTERSECTION_PRICE_WITH_FIXED_BUFFER",
    stop: cross * (1 - direction * buffer / 10_000),
    intersectionPrice: cross,
    bufferBps: buffer,
    evaluatedAt: cutoffBar?.closeTime ?? null,
    evaluationBarOpenTime: cutoffBar?.openTime ?? null,
    secondEarlier: null,
    firstNearest: null,
    progressionFractionOfWeakerProminence: null,
  };
}

export function protectiveStructurePlan({
  direction,
  pivots,
  oppositePivots,
  ratio = 0.618,
  requireInterveningOppositeStructure = true,
  minimumProgressionFractionOfWeakerProminence = 0,
}) {
  const selected = Array.isArray(pivots) ? pivots.slice(-2) : [];
  if (selected.length !== 2) {
    return { accepted: false, reason: "TWO_NEAREST_CONFIRMED_STRUCTURE_POINTS_REQUIRED" };
  }
  const [secondEarlier, firstNearest] = selected;
  if (requireInterveningOppositeStructure && !hasOppositeBetween(oppositePivots ?? [], secondEarlier, firstNearest)) {
    return { accepted: false, reason: "INTERVENING_OPPOSITE_STRUCTURE_REQUIRED" };
  }
  const stopPlan = fibonacciStructureStop(direction, firstNearest.price, secondEarlier.price, ratio);
  if (!stopPlan.accepted) return stopPlan;
  const progression = direction * (firstNearest.price - secondEarlier.price);
  const weakerProminence = Math.min(
    Number(secondEarlier.prominenceAbsolute),
    Number(firstNearest.prominenceAbsolute),
  );
  if (minimumProgressionFractionOfWeakerProminence > 0 && !(weakerProminence > 0)) {
    return { accepted: false, reason: "PROTECTIVE_STRUCTURE_PROMINENCE_REQUIRED" };
  }
  const progressionFractionOfWeakerProminence = weakerProminence > 0 ? progression / weakerProminence : null;
  if (progressionFractionOfWeakerProminence < minimumProgressionFractionOfWeakerProminence) {
    return {
      accepted: false,
      reason: "PROTECTIVE_STRUCTURE_PROGRESSION_TOO_SMALL",
      progressionFractionOfWeakerProminence,
    };
  }
  return {
    ...stopPlan,
    secondEarlier,
    firstNearest,
    progression,
    weakerProminence,
    progressionFractionOfWeakerProminence,
  };
}

export function protectiveStructureAtCutoff({ direction, bars15m, bars1h = null, strategy, cutoffBar }) {
  if (!Number.isFinite(cutoffBar?.closeTime)) {
    return { accepted: false, reason: "PROTECTIVE_STRUCTURE_CUTOFF_BAR_REQUIRED" };
  }
  const structureTimeframe = strategy?.stop?.pivotInterval ?? "15m";
  const sourceBars = structureTimeframe === "1h" ? bars1h : bars15m;
  if (!Array.isArray(sourceBars) || !sourceBars.length) {
    return { accepted: false, reason: "PROTECTIVE_STRUCTURE_TIMEFRAME_BARS_REQUIRED", structureTimeframe };
  }
  // A 15M confirmation supplies the decision clock.  The selected 1H
  // structure may only use candles that were fully closed by that clock.
  const history = sourceBars.filter((bar) => bar.closeTime <= cutoffBar.closeTime);
  if (!history.length) {
    return { accepted: false, reason: "PROTECTIVE_STRUCTURE_TIMEFRAME_HISTORY_REQUIRED", structureTimeframe };
  }
  const pivotType = direction === 1 ? "LOW" : "HIGH";
  const oppositeType = direction === 1 ? "HIGH" : "LOW";
  const pivotPolicy = structureTimeframe === "1h" ? strategy?.pivots?.oneHour : strategy?.pivots;
  const pivots = confirmedPivots(history, pivotType, pivotPolicy)
    .filter((pivot) => pivot.confirmedAt <= cutoffBar.closeTime);
  const oppositePivots = confirmedPivots(history, oppositeType, pivotPolicy)
    .filter((pivot) => pivot.confirmedAt <= cutoffBar.closeTime);
  const result = protectiveStructurePlan({
    direction,
    pivots,
    oppositePivots,
    ratio: strategy.stop.fibonacciRatio,
    requireInterveningOppositeStructure:
      strategy.stop.structureHygienePatch === "ACTIVE" && strategy.stop.requireInterveningOppositeStructure === true,
    minimumProgressionFractionOfWeakerProminence:
      strategy.stop.structureHygienePatch === "ACTIVE"
        ? strategy.stop.minimumProgressionFractionOfWeakerProminence ?? 0
        : 0,
  });
  return {
    ...result,
    evaluatedAt: cutoffBar.closeTime,
    evaluationBarOpenTime: cutoffBar.openTime,
    structureTimeframe,
    structureSourceCutoffBarOpenTime: history.at(-1)?.openTime ?? null,
    availablePivotCount: pivots.length,
    availableOppositePivotCount: oppositePivots.length,
  };
}

export function createPaperPosition({
  plan,
  signal,
  quote,
  bars15m,
  bars1h = null,
  book,
  runtime,
  strategy,
  now,
  structureEvaluationBar = signal.bar,
  lockedProtectiveStructure = null,
  entryQualityGuard = null,
}) {
  if (["MTFX-0.5.0-R18-ENTRY-QUALITY-GUARDS", "MTFX-0.5.0-R19-CONFIRMED-CLOSE-ENTRY-GUARD", "MTFX-0.5.0-R20-COST-EFFICIENCY-GATE", "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION", "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION"].includes(runtime.implementationRevision) && entryQualityGuard?.allowed !== true) {
    return { accepted: false, reason: "V2_ENTRY_QUALITY_GUARD_REQUIRED" };
  }
  const direction = signal.direction;
  const rawEntry = direction === 1 ? quote.ask : quote.bid;
  const slippage = runtime.paperRisk.adverseSlippageRate;
  const entry = rawEntry * (direction === 1 ? 1 + slippage : 1 - slippage);
  const stopPlan = lockedProtectiveStructure ?? protectiveStructureAtCutoff({
    direction,
    bars15m,
    bars1h,
    strategy,
    cutoffBar: structureEvaluationBar,
  });
  if (!stopPlan.accepted) return stopPlan;
  const { secondEarlier, firstNearest } = stopPlan;
  if (!(direction * (entry - stopPlan.stop) > 0)) {
    return { accepted: false, reason: stopPlan.source === "CANONICAL_INTERSECTION_PRICE_WITH_FIXED_BUFFER"
      ? "INTERSECTION_BUFFER_STOP_NOT_PROTECTIVE" : "FIBONACCI_STOP_NOT_PROTECTIVE" };
  }

  const feeRate = runtime.paperRisk.takerFeeRate;
  const costPlan = costAdjustedRiskPlan({
    direction,
    entry,
    initialStop: stopPlan.stop,
    entryCostPerUnit: entry * feeRate,
    initialStopExitCostPerUnit: stopPlan.stop * (feeRate + slippage),
    breakEvenExitCostPerUnit: entry * (feeRate + slippage),
    firstTakeProfitExitCostPerUnit: entry * (feeRate + slippage),
    softTakeProfitNetR: 0.5,
    firstTakeProfitNetR: 1,
    secondTakeProfitNetR: 2,
  });
  if (!costPlan.accepted) return costPlan;
  const costEfficiencyGuard = ["MTFX-0.5.0-R20-COST-EFFICIENCY-GATE", "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION", "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION"].includes(runtime.implementationRevision)
    ? evaluateV2CostEfficiencyGate({
      entry,
      initialRiskPerUnit: costPlan.initialRiskPerUnit,
      takerFeeRate: feeRate,
      adverseSlippageRate: slippage,
      maximumCompleteLifecycleCostR: runtime.execution.maximumCompleteLifecycleCostR,
    })
    : null;
  if (costEfficiencyGuard && !costEfficiencyGuard.allowed) {
    return {
      accepted: false,
      reason: costEfficiencyGuard.reason,
      costEfficiencyGuard,
    };
  }
  const capacity = paperBookCapacity({ book, runtime, entry });
  const riskBudget = capacity.availableRiskForNextPosition;
  if (!(riskBudget > 0)) return { accepted: false, reason: "PORTFOLIO_RISK_LIMIT_REACHED" };
  let quantity = Math.min(riskBudget / costPlan.initialRiskPerUnit, capacity.remainingNotional / entry);
  if (!(quantity > 0)) return { accepted: false, reason: "NON_POSITIVE_POSITION_SIZE" };
  const entryFee = quantity * entry * feeRate;
  const initialPlannedRiskUsdt = quantity * costPlan.initialRiskPerUnit;
  return {
    accepted: true,
    position: {
      id: deterministicId("paperpos050", { book: book.variant, plan: plan.id }),
      book: book.variant, strategyVersion: runtime.strategyVersion, symbol: plan.symbol, direction,
      implementationRevision: runtime.implementationRevision,
      status: "OPEN", stage: "INITIAL", openedAt: now,
      signalBarOpenTime: signal.bar.openTime, signalBarCloseTime: signal.bar.closeTime,
      confirmationPattern: {
        length: signal.patternLength,
        firstBarOpenTime: signal.patternBars[0].openTime,
        lastBarOpenTime: signal.bar.openTime,
        acceptedReserveBarNumber:
          Math.round((signal.bar.openTime - plan.lockedBarOpenTime) / INTERVAL_MS["15m"]) + 1,
        bodyToRange: signal.bodyToRange,
        closeLocation: signal.closeLocation,
        composite: signal.composite,
      },
      intersectionId: plan.id, intersectionTime: plan.intersectionTime,
      intersectionPrice: plan.intersectionPrice,
      entry, originalQuantity: quantity, quantity,
      initialStop: stopPlan.stop, stop: stopPlan.stop,
      protectiveStructure: {
        source: stopPlan.source ?? "CONFIRMED_STRUCTURE_0618",
        intersectionPrice: stopPlan.intersectionPrice ?? null,
        bufferBps: stopPlan.bufferBps ?? null,
        secondEarlier,
        firstNearest,
        fibonacciRatio: strategy.stop.fibonacciRatio,
        progressionFractionOfWeakerProminence: stopPlan.progressionFractionOfWeakerProminence,
        readyAt: stopPlan.evaluatedAt ?? structureEvaluationBar?.closeTime ?? signal.bar.closeTime,
        evaluationBarOpenTime: stopPlan.evaluationBarOpenTime ?? structureEvaluationBar?.openTime ?? signal.bar.openTime,
        readyReserveBarNumber: Math.round((
          (stopPlan.evaluationBarOpenTime ?? structureEvaluationBar?.openTime ?? signal.bar.openTime) -
          plan.lockedBarOpenTime
        ) / INTERVAL_MS["15m"]) + 1,
      },
      softLockPrice: costPlan.softTakeProfitPrice,
      oneRPrice: costPlan.firstTakeProfitPrice,
      twoRPrice: costPlan.secondTakeProfitPrice,
      target: costPlan.secondTakeProfitPrice,
      breakEvenActivationPrice: costPlan.firstTakeProfitPrice,
      breakEvenStopPrice: costPlan.breakEvenStopPrice,
      softLockTaken: false, softLockArmed: false, softLockReachedAt: null,
      firstPartialTaken: false, secondPartialTaken: false,
      initialRiskPerUnit: costPlan.initialRiskPerUnit,
      initialPlannedRiskUsdt, plannedRiskUsdt: initialPlannedRiskUsdt,
      entryFee, cumulativeExitFee: 0, cumulativeGrossPnl: 0, cumulativeRealizedNetPnl: 0,
      maximumNetExcursionR: 0, minimumNetExcursionR: 0, runnerMaximumNetExcursionR: null,
      oneRReachedAt: null, twoRReachedAt: null,
      lastTrailingStructureConfirmedAt: null,
      bboCoverageComplete: quote.coverageComplete === true,
      executionEvidence: quote.coverageComplete === true ? "BBO_CAPTURED" : "CAPTURE_INCOMPLETE",
      entryBbo: {
        bid: quote.bid,
        ask: quote.ask,
        marketTime: quote.marketTime ?? null,
        eventTime: quote.eventTime ?? null,
        transactionTime: quote.transactionTime ?? null,
        updateId: quote.updateId ?? null,
        receivedAt: quote.receivedAt ?? null,
        decisionMarketTime: now,
      },
      entryQualityGuard,
      costEfficiencyGuard,
      lastBid: quote.bid, lastAsk: quote.ask, lastMarkedAt: now,
    },
  };
}

export function evaluateV2CostEfficiencyGate({
  entry,
  initialRiskPerUnit,
  takerFeeRate,
  adverseSlippageRate,
  maximumCompleteLifecycleCostR,
}) {
  const values = [entry, initialRiskPerUnit, takerFeeRate, adverseSlippageRate, maximumCompleteLifecycleCostR];
  if (!values.every(Number.isFinite) || !(entry > 0) || !(initialRiskPerUnit > 0) ||
      takerFeeRate < 0 || adverseSlippageRate < 0 || !(maximumCompleteLifecycleCostR > 0)) {
    return {
      allowed: false,
      reason: "V2_COST_EFFICIENCY_EVIDENCE_INVALID",
      completeLifecycleCostR: null,
      maximumCompleteLifecycleCostR,
    };
  }
  const modeledRoundTripRate = 2 * (takerFeeRate + adverseSlippageRate);
  const modeledCompleteLifecycleCostPerUnit = entry * modeledRoundTripRate;
  const completeLifecycleCostR = modeledCompleteLifecycleCostPerUnit / initialRiskPerUnit;
  const allowed = completeLifecycleCostR <= maximumCompleteLifecycleCostR;
  return {
    allowed,
    reason: allowed ? "V2_COST_EFFICIENCY_GUARD_PASSED" : "COMPLETE_LIFECYCLE_COST_EXCEEDS_0_12R",
    completeLifecycleCostR,
    maximumCompleteLifecycleCostR,
    modeledRoundTripRate,
    modeledCompleteLifecycleCostPerUnit,
    initialRiskPerUnit,
    evaluatedBeforePositionSizing: true,
  };
}

export function paperBookCapacity({ book, runtime, entry }) {
  const activePlannedRisk = book.openPositions.reduce((sum, position) => sum + Math.max(0, position.plannedRiskUsdt), 0);
  const portfolioRiskLimit = book.equityUsdt * runtime.paperRisk.maximumPortfolioRiskFraction;
  const remainingPortfolioRisk = Math.max(0, portfolioRiskLimit - activePlannedRisk);
  const activeNotional = book.openPositions.reduce((sum, position) => sum + position.entry * position.quantity, 0);
  const notionalLimit = book.equityUsdt * runtime.paperRisk.maximumLeverage;
  const remainingNotional = Math.max(0, notionalLimit - activeNotional);
  return {
    activePlannedRisk, portfolioRiskLimit, remainingPortfolioRisk,
    availableRiskForNextPosition: Math.min(book.equityUsdt * runtime.paperRisk.riskPerIntersectionFraction, remainingPortfolioRisk),
    activeNotional, notionalLimit, remainingNotional, entry,
  };
}

function executeFraction(updated, executable, fractionOfOriginal, runtime, now, reason) {
  const quantity = Math.min(updated.quantity, updated.originalQuantity * fractionOfOriginal);
  const slippage = runtime.paperRisk.adverseSlippageRate;
  const exit = executable * (updated.direction === 1 ? 1 - slippage : 1 + slippage);
  const exitFee = exit * quantity * runtime.paperRisk.takerFeeRate;
  const allocatedEntryFee = updated.entryFee * (quantity / updated.originalQuantity);
  const grossPnl = updated.direction * (exit - updated.entry) * quantity;
  const netPnl = grossPnl - allocatedEntryFee - exitFee;
  updated.quantity = Math.max(0, updated.quantity - quantity);
  updated.cumulativeExitFee += exitFee;
  updated.cumulativeGrossPnl += grossPnl;
  updated.cumulativeRealizedNetPnl += netPnl;
  updated.partialExits = [...(updated.partialExits ?? []), { reason, at: now, exit, quantity, exitFee, allocatedEntryFee, grossPnl, netPnl }];
  return netPnl;
}

export function netLiquidationR(position, executable, runtime) {
  const slippage = runtime.paperRisk.adverseSlippageRate;
  const feeRate = runtime.paperRisk.takerFeeRate;
  const exit = executable * (position.direction === 1 ? 1 - slippage : 1 + slippage);
  const entryFeePerUnit = Number(position.entryFee ?? 0) / Number(position.originalQuantity ?? position.quantity);
  const netPnlPerUnit = position.direction * (exit - position.entry) - entryFeePerUnit - exit * feeRate;
  const initialRiskPerUnit = Number(position.initialRiskPerUnit ??
    position.initialPlannedRiskUsdt / Number(position.originalQuantity ?? position.quantity));
  return initialRiskPerUnit > 0 ? netPnlPerUnit / initialRiskPerUnit : 0;
}

function usesSoftProfitLock(position, runtime) {
  return ["MTFX-0.5.0-R17-SOFT-PROFIT-LOCK", "MTFX-0.5.0-R18-ENTRY-QUALITY-GUARDS", "MTFX-0.5.0-R19-CONFIRMED-CLOSE-ENTRY-GUARD", "MTFX-0.5.0-R20-COST-EFFICIENCY-GATE", "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION", "MTFX-V3-HF1-HIGH-FREQUENCY-CROSS", "MTFX-V3-HF2-15M-RUNNER"].includes(position?.implementationRevision) &&
    ["PARTIAL_20_SOFT_LOCK_30_25_RUNNER_1H_STRUCTURE", "PARTIAL_20_SOFT_LOCK_30_25_RUNNER_15M_STRUCTURE", "PARTIAL_40_SOFT_LOCK_25_20_RUNNER_15_1H_STRUCTURE"].includes(runtime?.paperRisk?.exitVariant);
}

function usesBalancedProfitRealization(position, runtime) {
  return position?.implementationRevision === "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION" &&
    runtime?.paperRisk?.exitVariant === "PARTIAL_40_SOFT_LOCK_25_20_RUNNER_15_1H_STRUCTURE";
}

// Given realized partial exits, solve the BBO stop threshold that leaves the
// full position at the requested aggregate net-R floor. It includes entry fee,
// the partial's actual fill and fee, and the remaining stop exit fee/slippage.
// A market gap through a stop can still fill worse; the invariant is exact at
// the recorded BBO threshold, never a promise about an unknown gap path.
export function stopForAggregateNetRFloor(position, runtime, aggregateNetRFloor) {
  const quantity = Number(position.quantity);
  const originalQuantity = Number(position.originalQuantity);
  const initialRisk = Number(position.initialPlannedRiskUsdt);
  const entry = Number(position.entry);
  const feeRate = Number(runtime.paperRisk.takerFeeRate ?? 0);
  const slippage = Number(runtime.paperRisk.adverseSlippageRate ?? 0);
  const realized = Number(position.cumulativeRealizedNetPnl ?? 0);
  if (!(quantity > 0 && originalQuantity > 0 && initialRisk > 0 && entry > 0)) return null;
  const remainingEntryFee = Number(position.entryFee ?? 0) * quantity / originalQuantity;
  const requiredRemainingNet = aggregateNetRFloor * initialRisk - realized;
  let exit;
  let executable;
  if (position.direction === 1) {
    exit = (requiredRemainingNet + quantity * entry + remainingEntryFee) / (quantity * (1 - feeRate));
    executable = exit / (1 - slippage);
  } else {
    exit = (quantity * entry - remainingEntryFee - requiredRemainingNet) / (quantity * (1 + feeRate));
    executable = exit / (1 + slippage);
  }
  return Number.isFinite(executable) && executable > 0 ? executable : null;
}

function tightenProfitFloorStop(position, runtime, aggregateNetRFloor) {
  const candidate = stopForAggregateNetRFloor(position, runtime, aggregateNetRFloor);
  if (!(candidate > 0)) return null;
  return position.direction === 1
    ? Math.max(Number(position.stop), candidate)
    : Math.min(Number(position.stop), candidate);
}

function trendOutcome(position) {
  const maximumNetExcursionR = Number(position.maximumNetExcursionR ?? 0);
  const minimumNetExcursionR = Number(position.minimumNetExcursionR ?? 0);
  const runnerMaximumNetExcursionR = Number(position.runnerMaximumNetExcursionR ?? 0);
  return {
    reachedOneNetR: position.firstPartialTaken === true,
    reachedTwoNetR: position.secondPartialTaken === true,
    runnerActivated: position.secondPartialTaken === true,
    runnerReachedThreeNetR: position.secondPartialTaken === true && runnerMaximumNetExcursionR >= 3,
    runnerReachedFiveNetR: position.secondPartialTaken === true && runnerMaximumNetExcursionR >= 5,
    maximumNetExcursionR,
    minimumNetExcursionR,
    runnerMaximumNetExcursionR: position.secondPartialTaken === true ? runnerMaximumNetExcursionR : null,
    timeToOneNetRMs: position.oneRReachedAt ? position.oneRReachedAt - position.openedAt : null,
    timeToTwoNetRMs: position.twoRReachedAt ? position.twoRReachedAt - position.openedAt : null,
    pathEfficiency: maximumNetExcursionR > 0
      ? maximumNetExcursionR / (maximumNetExcursionR + Math.abs(Math.min(0, minimumNetExcursionR)))
      : 0,
  };
}

export function summarizeTrendCapture(closedPositions) {
  const attributable = (closedPositions ?? []).filter((position) =>
    position?.trendOutcome && position?.executionEvidence === "BBO_CAPTURED"
  );
  const count = attributable.length;
  const reachedTwo = attributable.filter((position) => position.trendOutcome.reachedTwoNetR);
  const runnerThree = reachedTwo.filter((position) => position.trendOutcome.runnerReachedThreeNetR);
  const runnerFive = reachedTwo.filter((position) => position.trendOutcome.runnerReachedFiveNetR);
  const sum = (items, selector) => items.reduce((total, item) => total + Number(selector(item) ?? 0), 0);
  return {
    attributableClosedPositions: count,
    probabilityTwoNetRBeforeFinalStop: count ? reachedTwo.length / count : null,
    probabilityRunnerThreeNetRGivenTwoNetR: reachedTwo.length ? runnerThree.length / reachedTwo.length : null,
    probabilityRunnerFiveNetRGivenTwoNetR: reachedTwo.length ? runnerFive.length / reachedTwo.length : null,
    meanRealizedR: count ? sum(attributable, (item) => item.realizedR) / count : null,
    meanMaximumNetExcursionR: count ? sum(attributable, (item) => item.trendOutcome.maximumNetExcursionR) / count : null,
    status: count === 0 ? "NO_ATTRIBUTABLE_FORWARD_SAMPLE" : "DESCRIPTIVE_ONLY_NOT_PROMOTION_EVIDENCE",
  };
}

export function updatePaperPosition(position, quote, runtime, now, reasonOverride = null, managementAction = null) {
  if (position.status !== "OPEN") return { changed: false, position, events: [], realizedDelta: 0 };
  const executable = position.direction === 1 ? quote.bid : quote.ask;
  const updated = {
    ...position,
    originalQuantity: Number(position.originalQuantity ?? position.quantity),
    initialPlannedRiskUsdt: Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt),
    cumulativeExitFee: Number(position.cumulativeExitFee ?? 0),
    cumulativeGrossPnl: Number(position.cumulativeGrossPnl ?? 0),
    cumulativeRealizedNetPnl: Number(position.cumulativeRealizedNetPnl ?? 0),
    partialExits: [...(position.partialExits ?? [])],
    lastBid: quote.bid,
    lastAsk: quote.ask,
    lastMarkedAt: now,
  };
  let changed = false;
  let realizedDelta = 0;
  const events = [];
  const currentNetR = netLiquidationR(updated, executable, runtime);
  const excursionStepR = Number(runtime.paperRisk.excursionRecordStepR ?? 0.05);
  const priorMaximum = Number(position.maximumNetExcursionR ?? 0);
  const priorMinimum = Number(position.minimumNetExcursionR ?? 0);
  const nextMaximum = Math.max(priorMaximum, currentNetR);
  const nextMinimum = Math.min(priorMinimum, currentNetR);
  if (nextMaximum - priorMaximum >= excursionStepR || priorMinimum - nextMinimum >= excursionStepR) changed = true;
  updated.maximumNetExcursionR = nextMaximum;
  updated.minimumNetExcursionR = nextMinimum;
  if (updated.secondPartialTaken) {
    updated.runnerMaximumNetExcursionR = Math.max(Number(position.runnerMaximumNetExcursionR ?? 2), currentNetR);
  }
  const stopHit = position.direction === 1 ? executable <= updated.stop : executable >= updated.stop;
  if (reasonOverride || stopHit) {
    const exitReason = reasonOverride ?? "STOP";
    realizedDelta += executeFraction(updated, executable, updated.quantity / updated.originalQuantity, runtime, now, exitReason);
    updated.status = "CLOSED"; updated.stage = "CLOSED"; updated.closedAt = now;
    updated.exit = updated.partialExits.at(-1).exit; updated.exitReason = exitReason;
    updated.exitFee = updated.cumulativeExitFee; updated.grossPnl = updated.cumulativeGrossPnl;
    updated.netPnl = updated.cumulativeRealizedNetPnl;
    updated.realizedR = updated.netPnl / updated.initialPlannedRiskUsdt;
    updated.trendOutcome = trendOutcome(updated);
    updated.settlementDeltaNetPnl = realizedDelta;
    return { changed: true, closed: true, position: updated, events: [{ type: "POSITION_CLOSED", reason: exitReason }], realizedDelta };
  }

  if (managementAction?.type === "REDUCE_INITIAL" && updated.r21DefenseReductionTaken !== true) {
    const fraction = Math.max(0, Math.min(1, Number(managementAction.fractionOfOriginal ?? 0.25)));
    if (fraction > 0) {
      realizedDelta += executeFraction(updated, executable, fraction, runtime, now, "R21_PORTFOLIO_DEFENSE_REDUCTION");
      updated.r21DefenseReductionTaken = true;
      updated.r21DefenseReductionAt = now;
      updated.r21DefenseReductionFractionOfOriginal = fraction;
      updated.plannedRiskUsdt = Number(updated.plannedRiskUsdt) * (updated.quantity / updated.originalQuantity);
      events.push({ type: "R21_PORTFOLIO_DEFENSE_REDUCTION", fractionOfOriginal: fraction });
      changed = true;
    }
  }

  const balancedProfitRealization = usesBalancedProfitRealization(updated, runtime);
  const legacySoftProfitLock = usesSoftProfitLock(updated, runtime);
  if ((legacySoftProfitLock || balancedProfitRealization) && !updated.softLockTaken && currentNetR >= 0.5) {
    const closeFraction = balancedProfitRealization ? 0.4 : 0.2;
    const aggregateNetRFloor = balancedProfitRealization ? 0.15 : 0.05;
    const exitReason = balancedProfitRealization ? "PARTIAL_40_AT_0_5R_NET_BALANCED_LOCK" : "PARTIAL_20_AT_0_5R_NET_SOFT_LOCK";
    realizedDelta += executeFraction(updated, executable, closeFraction, runtime, now, exitReason);
    const stop = tightenProfitFloorStop(updated, runtime, aggregateNetRFloor);
    if (!(stop > 0)) throw new Error("SOFT_LOCK_STOP_CALCULATION_FAILED");
    updated.softLockTaken = true; updated.softLockArmed = true; updated.softLockReachedAt = now;
    updated.stop = stop; updated.plannedRiskUsdt = 0; updated.stage = balancedProfitRealization ? "BALANCED_LOCK_60_REMAINING" : "SOFT_LOCK_80_REMAINING";
    events.push(
      { type: exitReason },
      { type: "STOP_MOVED_TO_NET_SOFT_LOCK", stop: updated.stop, aggregateNetRFloor, gapRisk: "BBO_GAP_CAN_FILL_WORSE" },
    );
    changed = true;
  }

  const oneRHit = currentNetR >= 1;
  if (!updated.firstPartialTaken && oneRHit) {
    const closeFraction = balancedProfitRealization ? 0.25 : legacySoftProfitLock ? 0.3 : 0.5;
    const exitReason = balancedProfitRealization ? "PARTIAL_25_AT_1R_NET_BALANCED_LOCK" : legacySoftProfitLock ? "PARTIAL_30_AT_1R_NET_PROFIT_LOCK" : "PARTIAL_50_AT_1R_NET";
    realizedDelta += executeFraction(updated, executable, closeFraction, runtime, now, exitReason);
    updated.firstPartialTaken = true; updated.oneRReachedAt = now; updated.breakEvenArmed = true;
    updated.stage = balancedProfitRealization ? "AFTER_1R_35_REMAINING" : "AFTER_1R_50_REMAINING";
    updated.stop = (legacySoftProfitLock || balancedProfitRealization)
      ? tightenProfitFloorStop(updated, runtime, balancedProfitRealization ? 0.6 : 0.5)
      : (position.direction === 1 ? Math.max(updated.stop, updated.breakEvenStopPrice) : Math.min(updated.stop, updated.breakEvenStopPrice));
    if (!(updated.stop > 0)) throw new Error("ONE_R_PROFIT_LOCK_STOP_CALCULATION_FAILED");
    updated.plannedRiskUsdt = 0;
    events.push(
      { type: exitReason },
      (legacySoftProfitLock || balancedProfitRealization)
        ? { type: "STOP_MOVED_TO_NET_PROFIT_LOCK", stop: updated.stop, aggregateNetRFloor: balancedProfitRealization ? 0.6 : 0.5, gapRisk: "BBO_GAP_CAN_FILL_WORSE" }
        : { type: "STOP_MOVED_TO_NET_BREAK_EVEN", stop: updated.stop },
    );
    changed = true;
  }
  const twoRHit = currentNetR >= 2;
  if (updated.firstPartialTaken && !updated.secondPartialTaken && twoRHit) {
    const closeFraction = balancedProfitRealization ? 0.2 : 0.25;
    const exitReason = balancedProfitRealization ? "PARTIAL_20_AT_2R_NET_BALANCED_LOCK" : "PARTIAL_25_AT_2R_NET";
    realizedDelta += executeFraction(updated, executable, closeFraction, runtime, now, exitReason);
    updated.secondPartialTaken = true; updated.twoRReachedAt = now; updated.stage = balancedProfitRealization ? "RUNNER_15" : "RUNNER_25";
    updated.runnerMaximumNetExcursionR = Math.max(2, currentNetR);
    events.push({ type: exitReason }, { type: balancedProfitRealization ? "RUNNER_15_ACTIVATED" : "RUNNER_25_ACTIVATED" });
    changed = true;
  }
  updated.settlementDeltaNetPnl = realizedDelta;
  return { changed, closed: false, position: updated, events, realizedDelta };
}

export function updateConfirmedStructureTrail(position, bars, pivotConfig, interval = "1h") {
  if (position.status !== "OPEN" || !position.secondPartialTaken) return { changed: false, position, reason: "RUNNER_NOT_ACTIVE" };
  const type = position.direction === 1 ? "LOW" : "HIGH";
  const label = String(interval).toUpperCase();
  const pivots = confirmedPivots(bars, type, pivotConfig).filter((pivot) => pivot.confirmedAt > position.openedAt);
  if (pivots.length < 2) return { changed: false, position, reason: `TWO_POST_ENTRY_${label}_POINTS_REQUIRED` };
  const earlier = pivots.at(-2);
  const latest = pivots.at(-1);
  if (latest.confirmedAt <= Number(position.lastTrailingStructureConfirmedAt ?? 0)) return { changed: false, position, reason: `NO_NEW_CONFIRMED_${label}_STRUCTURE` };
  const valid = position.direction === 1 ? latest.price > earlier.price : latest.price < earlier.price;
  if (!valid) return { changed: false, position, reason: position.direction === 1 ? `NO_NEW_${label}_HIGHER_LOW` : `NO_NEW_${label}_LOWER_HIGH` };
  const tightened = position.direction === 1 ? latest.price > position.stop : latest.price < position.stop;
  if (!tightened) return { changed: false, position, reason: "STRUCTURE_WOULD_NOT_TIGHTEN_STOP" };
  return {
    changed: true,
    reason: `RUNNER_TRAIL_UPDATED_ON_CONFIRMED_${label}_STRUCTURE`,
    position: { ...position, stop: latest.price, lastTrailingStructureConfirmedAt: latest.confirmedAt, trailingStructure: { interval, earlier, latest } },
  };
}

export function updateHourlyStructureTrail(position, bars1h, strategy) {
  return updateConfirmedStructureTrail(position, bars1h, strategy.pivots.oneHour, "1h");
}

export function defaultBook(variant, initialEquityUsdt, now = Date.now()) {
  return {
    variant, initialEquityUsdt, equityUsdt: initialEquityUsdt, peakEquityUsdt: initialEquityUsdt,
    realizedPnlUsdt: 0, day: shanghaiDay(now), dayStartEquityUsdt: initialEquityUsdt,
    dayRealizedPnlUsdt: 0, openPositions: [], closedPositions: [], observedRetests: [],
    consumedIntersectionIds: [], newEntriesBlocked: false, blockReason: null,
  };
}

export function reconcileDailyRealizedLossPolicy(book, runtime) {
  const enabled = runtime.paperRisk.dailyRealizedLossStopEnabled === true;
  const fraction = Number(runtime.paperRisk.dailyRealizedLossStopFraction);
  if (enabled && Number.isFinite(fraction) && fraction > 0) return { changed: false, book };
  if (book.blockReason !== "DAILY_REALIZED_LOSS_STOP") return { changed: false, book };
  return {
    changed: true,
    book: { ...book, newEntriesBlocked: false, blockReason: null },
  };
}

function applyRealizedDelta(book, realizedDelta, runtime, now) {
  const currentDay = shanghaiDay(now);
  const next = { ...book };
  if (next.day !== currentDay) {
    next.day = currentDay; next.dayStartEquityUsdt = next.equityUsdt; next.dayRealizedPnlUsdt = 0;
  }
  next.realizedPnlUsdt += realizedDelta;
  next.dayRealizedPnlUsdt += realizedDelta;
  next.equityUsdt += realizedDelta;
  next.peakEquityUsdt = Math.max(next.peakEquityUsdt, next.equityUsdt);
  const dailyLoss = Math.max(0, -next.dayRealizedPnlUsdt);
  const drawdown = (next.peakEquityUsdt - next.equityUsdt) / next.peakEquityUsdt;
  const dailyStopFraction = Number(runtime.paperRisk.dailyRealizedLossStopFraction);
  if (runtime.paperRisk.dailyRealizedLossStopEnabled === true &&
      Number.isFinite(dailyStopFraction) && dailyStopFraction > 0 &&
      dailyLoss >= next.dayStartEquityUsdt * dailyStopFraction) {
    next.newEntriesBlocked = true; next.blockReason = "DAILY_REALIZED_LOSS_STOP";
  } else if (next.blockReason === "DAILY_REALIZED_LOSS_STOP") {
    next.newEntriesBlocked = false; next.blockReason = null;
  }
  const maximumDrawdownKillFraction = Number(runtime.paperRisk.maximumDrawdownKillFraction);
  const killRequired = runtime.paperRisk.maximumDrawdownKillEnabled === true &&
    Number.isFinite(maximumDrawdownKillFraction) && maximumDrawdownKillFraction > 0 &&
    drawdown >= maximumDrawdownKillFraction;
  return { book: next, drawdown, killRequired };
}

export function applyPositionResult(book, result, runtime, now = Date.now()) {
  const applied = applyRealizedDelta(book, Number(result.realizedDelta ?? 0), runtime, now);
  const next = applied.book;
  next.openPositions = result.closed
    ? next.openPositions.filter((position) => position.id !== result.position.id)
    : next.openPositions.map((position) => position.id === result.position.id ? result.position : position);
  if (result.closed) next.closedPositions = [...next.closedPositions, result.position].slice(-500);
  return { ...applied, book: next };
}

export function applyClosedPosition(book, closedPosition, runtime, now = Date.now()) {
  return applyPositionResult(book, {
    closed: true,
    position: closedPosition,
    realizedDelta: Number.isFinite(closedPosition.settlementDeltaNetPnl) ? closedPosition.settlementDeltaNetPnl : closedPosition.netPnl,
  }, runtime, now);
}
