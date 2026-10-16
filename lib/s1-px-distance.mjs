const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function pxDistanceStatus({ px, direction = null, bid, ask, maximumPxBps = 200 }) {
  const referencePx = finitePositive(px);
  const bidPrice = finitePositive(bid);
  const askPrice = finitePositive(ask);
  if (referencePx === null || bidPrice === null || askPrice === null || bidPrice > askPrice
    || ![200, 300].includes(maximumPxBps)) return null;

  const normalizedDirection = direction === "LONG" || direction === "SHORT" ? direction : null;
  const marketPrice = normalizedDirection === "LONG" ? askPrice : normalizedDirection === "SHORT" ? bidPrice : (bidPrice + askPrice) / 2;
  const band = maximumPxBps / 10000;
  const lower = normalizedDirection === "LONG" ? referencePx : referencePx * (1 - band);
  const upper = normalizedDirection === "SHORT" ? referencePx : referencePx * (1 + band);
  const epsilon = Math.max(referencePx * 1e-12, Number.EPSILON);
  const atPx = Math.abs(marketPrice - referencePx) <= epsilon;
  const position = atPx ? "AT_PX" : marketPrice < lower ? "BELOW" : marketPrice > upper ? "ABOVE" : "INSIDE";
  const distancePrice = position === "BELOW" ? lower - marketPrice : position === "ABOVE" ? marketPrice - upper : 0;

  return {
    direction: normalizedDirection,
    referenceLabel: normalizedDirection === "LONG" ? "卖一" : normalizedDirection === "SHORT" ? "买一" : "中间价",
    marketPrice,
    px: referencePx,
    lower,
    upper,
    position,
    distancePrice,
    distancePercent: distancePrice / referencePx * 100,
    pxOffsetPercent: (marketPrice - referencePx) / referencePx * 100,
  };
}

export function summarizePxDistance(plans, quote, maximumPxBps = 200) {
  if (!quote || quote.status !== "QUOTED") return null;
  const statuses = plans.map((plan) => ({
    plan,
    status: pxDistanceStatus({ px: plan.intersectionPrice, direction: plan.direction, bid: quote.bidPrice, ask: quote.askPrice, maximumPxBps }),
  })).filter((row) => row.status !== null);
  if (!statuses.length) return null;

  const inside = statuses.filter((row) => row.status.position === "INSIDE");
  const atPx = statuses.filter((row) => row.status.position === "AT_PX");
  const nearest = [...statuses].sort((left, right) => left.status.distancePercent - right.status.distancePercent)[0];
  return {
    total: statuses.length,
    inside: inside.length,
    atPx: atPx.length,
    representative: inside[0] ?? atPx[0] ?? nearest,
  };
}
