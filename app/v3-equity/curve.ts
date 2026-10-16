import { settlementHourBucket } from "../monitor-curve.ts";

export type EquityPoint = {
  id: string;
  timestamp: number;
  kind: "BASELINE" | "CLOSED_TRADE" | "PARTIAL_EXIT";
  symbol: string;
  deltaUsdt: number;
  realizedLearningEquityUsdt: number;
};

export type HourlyEquityPoint = EquityPoint & { settlementCount: number };

export function groupLearningEquityByHour(points: EquityPoint[]): HourlyEquityPoint[] {
  const ordered = [...points].filter((point) => Number.isFinite(point.timestamp)).sort((left, right) => left.timestamp - right.timestamp);
  const baseline = ordered.find((point) => point.kind === "BASELINE");
  const groups = new Map<number, { deltaUsdt: number; settlementCount: number; latest: EquityPoint; symbols: Set<string> }>();

  for (const point of ordered) {
    if (point.kind === "BASELINE") continue;
    const timestamp = settlementHourBucket(point.timestamp);
    const current = groups.get(timestamp) ?? { deltaUsdt: 0, settlementCount: 0, latest: point, symbols: new Set<string>() };
    current.deltaUsdt += point.deltaUsdt;
    current.settlementCount += 1;
    current.latest = point;
    if (point.symbol) current.symbols.add(point.symbol);
    groups.set(timestamp, current);
  }

  const hourly = [...groups.entries()].sort(([left], [right]) => left - right).map(([timestamp, group]) => ({
    ...group.latest,
    id: `hour-${timestamp}`,
    timestamp,
    symbol: [...group.symbols].join(" / ") || group.latest.symbol,
    deltaUsdt: group.deltaUsdt,
    settlementCount: group.settlementCount,
  }));

  return baseline ? [{ ...baseline, settlementCount: 0 }, ...hourly] : hourly;
}
