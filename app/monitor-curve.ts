export type SettlementLike = { closedAt?: number; netPnl?: number };

export function settlementHourBucket(timestamp: number) {
  return Math.floor(timestamp / 3_600_000) * 3_600_000;
}

export function groupSettlementsByHour<T extends SettlementLike>(settlements: T[]) {
  const grouped = new Map<number, { delta: number; count: number }>();
  for (const settlement of settlements) {
    if (!Number.isFinite(settlement.closedAt) || !Number.isFinite(settlement.netPnl)) continue;
    const timestamp = settlementHourBucket(Number(settlement.closedAt));
    const current = grouped.get(timestamp) ?? { delta: 0, count: 0 };
    grouped.set(timestamp, { delta: current.delta + Number(settlement.netPnl), count: current.count + 1 });
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right);
}

export function ordinalCurveFraction(index: number, pointCount: number, futureReserveFraction = 0.06) {
  if (pointCount <= 1) return 0;
  const reserve = Math.min(Math.max(futureReserveFraction, 0), 0.2);
  return index / (pointCount - 1) * (1 - reserve);
}
