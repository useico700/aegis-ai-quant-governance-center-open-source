import { structuralPivots } from "../../orion-v2/paper/paper-engine.mjs";

const INTERVAL_MS = { "1h": 3_600_000, "15m": 900_000 };
const PATTERN_DIRECTIONS = {
  "1H_ASC_LOW__15M_DESC_HIGH": [1, -1],
  "1H_DESC_HIGH__15M_ASC_LOW": [-1, 1],
};
const positive = (value) => Number.isFinite(value) && value > 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const near = (first, second, scale = 1) => Number.isFinite(first) && Number.isFinite(second) &&
  Math.abs(first - second) <= Number.EPSILON * 64 * Math.max(Math.abs(first), Math.abs(second), scale);

function validBars(bars, interval, asOf) {
  const duration = INTERVAL_MS[interval];
  if (!duration || !timestamp(asOf) || !Array.isArray(bars) || !bars.length) return false;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!bar || !timestamp(bar.openTime) || !timestamp(bar.closeTime) ||
        ![bar.open, bar.high, bar.low, bar.close].every(positive) ||
        bar.openTime % duration !== 0 || bar.closeTime - bar.openTime !== duration - 1 ||
        bar.closeTime >= asOf || bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close, bar.high) ||
        (bar.interval !== undefined && bar.interval !== interval) ||
        (bar.closed !== undefined && bar.closed !== true) ||
        (bar.isClosed !== undefined && bar.isClosed !== true) ||
        (index > 0 && bar.openTime - bars[index - 1].openTime !== duration)) return false;
  }
  return bars.at(-1).closeTime === Math.floor(asOf / duration) * duration - 1;
}

function validPolicy(policy) {
  return policy && Number.isInteger(policy.searchWindowBars) && policy.searchWindowBars > 0 &&
    Number.isInteger(policy.leftBars ?? 2) && (policy.leftBars ?? 2) > 0 &&
    Number.isInteger(policy.rightBars ?? 2) && (policy.rightBars ?? 2) > 0 &&
    (policy.hierarchyWindowMultipliers === undefined ||
      (Array.isArray(policy.hierarchyWindowMultipliers) && policy.hierarchyWindowMultipliers.length > 0 &&
        policy.hierarchyWindowMultipliers.every((value) => Number.isInteger(value) && value > 0)));
}

function matchesPivot(point, pivot) {
  return point && pivot && ["type", "index", "time", "price", "confirmedAt"]
    .every((key) => point[key] === pivot[key]);
}

function uniqueExtreme(bars, firstIndex, lastIndex, point) {
  const field = point.type === "HIGH" ? "high" : "low";
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    if (index === point.index) {
      if (bars[index][field] !== point.price) return false;
    } else if (point.type === "HIGH" ? bars[index][field] >= point.price : bars[index][field] <= point.price) {
      return false;
    }
  }
  return true;
}

function priceOrder({ A, B, C, D }, direction) {
  return direction === 1
    ? A.price < C.price && C.price < B.price && B.price < D.price
    : A.price > C.price && C.price > B.price && B.price > D.price;
}

function linePriceAt(first, second, time) {
  return first.price + (second.price - first.price) * ((time - first.time) / (second.time - first.time));
}

/**
 * Complete one already-qualified A/C trendline with a causal B/D explanation.
 * The caller retains its existing A/C representativeness and lineage filters.
 * All input bars must be ordered, contiguous, native and fully closed; this
 * function never silently removes bad bars or extends the policy search window.
 */
export function findConfirmedZForPair({ pair, bars, direction, interval, policy, asOf, referencePrice } = {}) {
  if (![1, -1].includes(direction) || !validPolicy(policy) || !positive(referencePrice) ||
      !validBars(bars, interval, asOf)) return null;
  const anchorType = direction === 1 ? "LOW" : "HIGH";
  const oppositeType = direction === 1 ? "HIGH" : "LOW";
  const anchors = structuralPivots(bars, anchorType, policy);
  const A = anchors.find((pivot) => matchesPivot(pair?.first, pivot));
  const C = anchors.find((pivot) => matchesPivot(pair?.second, pivot));
  const earliestIndex = Math.max(0, bars.length - policy.searchWindowBars);
  if (!A || !C || A.index < earliestIndex || A.index >= C.index ||
      Math.sign(C.price - A.price) !== direction) return null;
  const opposites = structuralPivots(bars, oppositeType, policy);
  const B = opposites.find((pivot) => pivot.index > A.index && pivot.index < C.index &&
    uniqueExtreme(bars, A.index, C.index, pivot));
  if (!B || !uniqueExtreme(bars, A.index, B.index, A)) return null;
  // Newest confirmed D first. Small intervening swings are allowed only when
  // they do not violate the complete leg's unique absolute extreme envelope.
  for (const D of opposites.filter((pivot) => pivot.index > C.index).sort((a, b) => b.time - a.time)) {
    const points = { A, B, C, D };
    const confirmedAt = Math.max(...Object.values(points).map((point) => point.confirmedAt));
    if (confirmedAt >= asOf || !priceOrder(points, direction) ||
        !uniqueExtreme(bars, B.index, D.index, C) ||
        !uniqueExtreme(bars, C.index, D.index, D)) continue;
    const projectedPrice = linePriceAt(A, C, asOf);
    if (!positive(projectedPrice)) continue;
    const prices = Object.values(points).map((point) => point.price);
    return {
      schemaVersion: 1,
      status: "CONFIRMED",
      interval,
      direction,
      points,
      confirmedAt,
      spanBars: D.index - A.index,
      amplitudeFraction: (Math.max(...prices) - Math.min(...prices)) / A.price,
      priceDistanceBps: Math.abs(referencePrice - projectedPrice) / Math.max(referencePrice, projectedPrice) * 10_000,
      referencePrice,
      observedAt: asOf,
      asOf,
      lastClosedBarCloseTime: bars.at(-1).closeTime,
      searchWindowBars: policy.searchWindowBars,
      source: "NATIVE_FULLY_CLOSED_OHLC",
      contiguous: true,
    };
  }
  return null;
}

function validateZ(z, interval, direction, discoveryTime, now) {
  if (z?.schemaVersion !== 1 || z?.status !== "CONFIRMED" || z.interval !== interval || z.direction !== direction) {
    return "MISSING_OR_UNCONFIRMED";
  }
  const duration = INTERVAL_MS[interval];
  const points = ["A", "B", "C", "D"].map((name) => z.points?.[name]);
  const anchorType = direction === 1 ? "LOW" : "HIGH";
  for (const [index, point] of points.entries()) {
    const expectedType = index % 2 === 0 ? anchorType : anchorType === "LOW" ? "HIGH" : "LOW";
    if (!point || point.type !== expectedType || !positive(point.price) ||
        !timestamp(point.time) || point.time % duration !== 0 ||
        !Number.isInteger(point.index) || point.index < 0 ||
        !timestamp(point.confirmedAt) || (point.confirmedAt + 1) % duration !== 0 ||
        point.confirmedAt < point.time + 2 * duration - 1 ||
        (index > 0 && (point.time <= points[index - 1].time || point.index <= points[index - 1].index ||
          point.time - points[index - 1].time !== (point.index - points[index - 1].index) * duration))) {
      return "POINT_EVIDENCE_INVALID";
    }
    if (point.confirmedAt >= discoveryTime || point.confirmedAt >= now) return "CONFIRMATION_AFTER_DISCOVERY";
  }
  if (!priceOrder(z.points, direction)) return "PRICE_ORDER_INVALID";
  if (z.confirmedAt !== Math.max(...points.map((point) => point.confirmedAt))) return "CONFIRMATION_MISMATCH";
  if (!timestamp(z.observedAt) || z.asOf !== z.observedAt || z.observedAt > now ||
      z.observedAt < discoveryTime || z.confirmedAt >= z.observedAt ||
      z.lastClosedBarCloseTime !== Math.floor(z.observedAt / duration) * duration - 1 ||
      points.some((point) => point.confirmedAt > z.lastClosedBarCloseTime)) return "OBSERVATION_INVALID";
  if (z.lastClosedBarCloseTime !== Math.floor(now / duration) * duration - 1) return "SOURCE_STALE";
  const { A, D } = z.points;
  const prices = points.map((point) => point.price);
  if (z.spanBars !== D.index - A.index || !positive(z.amplitudeFraction) ||
      !near(z.amplitudeFraction, (Math.max(...prices) - Math.min(...prices)) / A.price) ||
      !Number.isFinite(z.priceDistanceBps) || z.priceDistanceBps < 0) return "MEASUREMENTS_INVALID";
  return null;
}

/** Validate persisted discovery evidence again before any entry/retry decision. */
export function validateDualZPlanEvidence(plan, { now = Date.now() } = {}) {
  const reject = (reason) => ({ allowed: false, reason });
  const dual = plan?.dualZ;
  if (dual?.schemaVersion !== 1 || dual?.status !== "CONFIRMED") return reject("DUAL_Z_MISSING_OR_UNCONFIRMED");
  const directions = PATTERN_DIRECTIONS[plan.pattern];
  if (!directions) return reject("DUAL_Z_PATTERN_INVALID");
  if (!timestamp(now) || !timestamp(plan.firstDiscoveredAt) || plan.firstDiscoveredAt > now ||
      !positive(plan.intersectionTime) || plan.firstDiscoveredAt >= plan.intersectionTime ||
      !positive(plan.intersectionPrice)) return reject("DUAL_Z_DISCOVERY_NOT_FORWARD");
  for (const [index, name] of ["primary", "opposing"].entries()) {
    const reason = validateZ(dual[name], index === 0 ? "1h" : "15m", directions[index], plan.firstDiscoveredAt, now);
    if (reason) return reject(`DUAL_Z_${name.toUpperCase()}_${reason}`);
  }
  if (dual.confirmedAt !== Math.max(dual.primary.confirmedAt, dual.opposing.confirmedAt)) {
    return reject("DUAL_Z_CONFIRMATION_MISMATCH");
  }
  const boundPoints = [dual.primary.points.A, dual.primary.points.C, dual.opposing.points.A, dual.opposing.points.C];
  if (!Array.isArray(plan.anchors) || plan.anchors.length !== 4 ||
      boundPoints.some((point, index) => ["type", "time", "price", "confirmedAt"]
        .some((key) => point[key] !== plan.anchors[index]?.[key]))) return reject("DUAL_Z_ANCHOR_MISMATCH");
  // Recompute from the actual A/C anchors in a local time coordinate to avoid
  // subtracting large epoch intercepts. Tolerance only covers floating error.
  const [firstA, firstC, secondA, secondC] = boundPoints;
  const firstSlope = (firstC.price - firstA.price) / (firstC.time - firstA.time);
  const secondSlope = (secondC.price - secondA.price) / (secondC.time - secondA.time);
  const secondPriceAtFirstA = linePriceAt(secondA, secondC, firstA.time);
  const crossTime = firstA.time + (secondPriceAtFirstA - firstA.price) / (firstSlope - secondSlope);
  const crossPrice = linePriceAt(firstA, firstC, crossTime);
  const priceScale = Math.max(Math.abs(firstSlope * firstA.time), Math.abs(secondSlope * secondA.time), crossPrice);
  if (!positive(crossTime) || !positive(crossPrice) || !near(plan.intersectionTime, crossTime) ||
      !near(plan.intersectionPrice, crossPrice, priceScale) ||
      !near(linePriceAt(secondA, secondC, plan.intersectionTime), plan.intersectionPrice, priceScale) ||
      !near(linePriceAt(firstA, firstC, plan.intersectionTime), plan.intersectionPrice, priceScale)) {
    return reject("DUAL_Z_INTERSECTION_MISMATCH");
  }
  return { allowed: true, reason: "DUAL_Z_CONFIRMED" };
}

/**
 * HF14 validates only the primary 1H Z. The opposing 15M A/C anchors still
 * define the intersecting line, but a complete opposing Z is deliberately not
 * an admission requirement. The compact HF13 comparison receipt is frozen at
 * discovery and is never used for ranking or execution.
 */
export function validateSingleZPlanEvidence(plan, { now = Date.now() } = {}) {
  const reject = (reason) => ({ allowed: false, reason });
  const single = plan?.singleZ;
  if (single?.schemaVersion !== 1 || single?.status !== "CONFIRMED") return reject("SINGLE_Z_MISSING_OR_UNCONFIRMED");
  const directions = PATTERN_DIRECTIONS[plan?.pattern];
  if (!directions) return reject("SINGLE_Z_PATTERN_INVALID");
  if (!timestamp(now) || !timestamp(plan?.firstDiscoveredAt) || plan.firstDiscoveredAt > now ||
      !positive(plan?.intersectionTime) || plan.firstDiscoveredAt >= plan.intersectionTime ||
      !positive(plan?.intersectionPrice)) return reject("SINGLE_Z_DISCOVERY_NOT_FORWARD");
  const reason = validateZ(single.primary, "1h", directions[0], plan.firstDiscoveredAt, now);
  if (reason) return reject(`SINGLE_Z_PRIMARY_${reason}`);
  if (single.confirmedAt !== single.primary.confirmedAt) return reject("SINGLE_Z_CONFIRMATION_MISMATCH");
  const boundPoints = [single.primary.points.A, single.primary.points.C];
  if (!Array.isArray(plan.anchors) || plan.anchors.length !== 4 ||
      boundPoints.some((point, index) => ["type", "time", "price", "confirmedAt"]
        .some((key) => point[key] !== plan.anchors[index]?.[key]))) return reject("SINGLE_Z_PRIMARY_ANCHOR_MISMATCH");
  // The HF13 counterfactual is telemetry only. Missing or malformed comparison
  // data is reported as UNKNOWN and must never become an HF14 admission input.
  const comparison = plan?.dualZComparison;
  const comparisonStatus = comparison?.schemaVersion === 1 && comparison?.primaryConfirmed === true &&
    ["WOULD_PASS_HF13_DUAL_Z_FILTER", "WOULD_FAIL_HF13_DUAL_Z_FILTER"].includes(comparison?.status) &&
    comparison.opposingConfirmed === (comparison.status === "WOULD_PASS_HF13_DUAL_Z_FILTER") &&
    timestamp(comparison?.evaluatedAt) && comparison.evaluatedAt === plan.firstDiscoveredAt &&
    comparison.executionInput === false && comparison.rankingInput === false
    ? comparison.status
    : "UNKNOWN";
  const [firstA, firstC, secondA, secondC] = plan.anchors;
  const opposingType = directions[1] === 1 ? "LOW" : "HIGH";
  const anchorEvidenceInvalid = [secondA, secondC].some((point) =>
    !point || point.type !== opposingType || !positive(point.price) || !timestamp(point.time) ||
    point.time % INTERVAL_MS["15m"] !== 0 || !timestamp(point.confirmedAt) ||
    (point.confirmedAt + 1) % INTERVAL_MS["15m"] !== 0 ||
    point.confirmedAt < point.time + 2 * INTERVAL_MS["15m"] - 1 ||
    point.confirmedAt >= plan.firstDiscoveredAt || point.confirmedAt >= now ||
    !(Number(point.hierarchyMultiplier) >= 2) || !positive(Number(point.prominenceAbsolute)));
  if ([firstA, firstC].some((point) => !point || !positive(point.price) || !timestamp(point.time)) ||
      anchorEvidenceInvalid || firstA.time >= firstC.time || secondA.time >= secondC.time ||
      Math.sign(secondC.price - secondA.price) !== directions[1] ||
      !(Number(plan?.scale?.opposingHierarchyMultiplier) >= 2)) {
    return reject("SINGLE_Z_INTERSECTION_ANCHORS_INVALID");
  }
  const firstSlope = (firstC.price - firstA.price) / (firstC.time - firstA.time);
  const secondSlope = (secondC.price - secondA.price) / (secondC.time - secondA.time);
  const secondPriceAtFirstA = linePriceAt(secondA, secondC, firstA.time);
  const crossTime = firstA.time + (secondPriceAtFirstA - firstA.price) / (firstSlope - secondSlope);
  const crossPrice = linePriceAt(firstA, firstC, crossTime);
  const priceScale = Math.max(Math.abs(firstSlope * firstA.time), Math.abs(secondSlope * secondA.time), crossPrice);
  if (!positive(crossTime) || !positive(crossPrice) || !near(plan.intersectionTime, crossTime) ||
      !near(plan.intersectionPrice, crossPrice, priceScale) ||
      !near(linePriceAt(secondA, secondC, plan.intersectionTime), plan.intersectionPrice, priceScale) ||
      !near(linePriceAt(firstA, firstC, plan.intersectionTime), plan.intersectionPrice, priceScale)) {
    return reject("SINGLE_Z_INTERSECTION_MISMATCH");
  }
  return { allowed: true, reason: "SINGLE_Z_CONFIRMED", comparisonStatus };
}
