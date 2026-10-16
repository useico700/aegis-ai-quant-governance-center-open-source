"use client";

import { useId, useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { equitySegments } from "../../lib/s1-account.mjs";
import type { Candidate, EquityPoint } from "./types";
import styles from "./s1-pro.module.css";

const money = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const stamp = (value: number | string | null | undefined, withDate = true) => value == null || !Number.isFinite(new Date(value).getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: withDate ? "2-digit" : undefined, day: withDate ? "2-digit" : undefined, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

/* ---------------- heartbeat (ECG) ---------------- */
const BEATS = {
  good: "M0 24 H38 L44 21 L48 27 L52 24 H60 L64 6 L69 42 L74 16 L79 24 H120",
  warn: "M0 24 H66 L70 19 L74 30 L78 24 H120",
  off: "M0 24 H120",
} as const;

export function HeartbeatTrace({ tone }: { tone: keyof typeof BEATS }) {
  const beat = BEATS[tone];
  const repeated = Array.from({ length: 4 }, (_, index) => beat.replace(/^M0 24/, `M${index * 120} 24`).replace(/([HL])(\d+(?:\.\d+)?)/g, (match, command, value) => command === "H" || command === "L" ? `${command}${Number(value) + index * 120}` : match)).join(" ");
  return <div className={styles.ecg} data-tone={tone} aria-hidden="true">
    <svg viewBox="0 0 480 48" preserveAspectRatio="none"><path d={repeated} vectorEffect="non-scaling-stroke" /></svg>
  </div>;
}

/* ---------------- equity chart ---------------- */
type Segment = (EquityPoint & { time: number })[];

export function EquityChart({ points, label }: { points: EquityPoint[]; label: string }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const groups = useMemo(() => equitySegments(points) as Segment[], [points]);
  const valid = groups.flat();
  if (valid.length < 2) return <div className={styles.chartEmpty}><b>{valid.length ? "首份权益采样已记录" : "等待权益历史采样"}</b><span>形成连续采样后显示轨迹，不生成示例曲线。</span></div>;

  const first = valid[0], last = valid[valid.length - 1];
  const low = Math.min(...valid.map(point => point.equity)), high = Math.max(...valid.map(point => point.equity));
  const pad = Math.max((high - low) * .15, Math.abs(high) * .001, .01), bottom = low - pad, top = high + pad;
  const W = 1000, H = 260, left = 8, right = 920, chartTop = 14, chartBottom = 228;
  const x = (time: number) => left + (time - first.time) / Math.max(1, last.time - first.time) * (right - left);
  const y = (value: number) => chartBottom - (value - bottom) / (top - bottom) * (chartBottom - chartTop);
  const line = (group: Segment) => group.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.equity).toFixed(1)}`).join(" ");
  const area = (group: Segment) => group.length < 2 ? "" : `${line(group)} L${x(group[group.length - 1].time).toFixed(1)},${chartBottom} L${x(group[0].time).toFixed(1)},${chartBottom} Z`;
  const delta = last.equity - first.equity;
  const trend = Math.abs(delta) < .005 ? "flat" : delta > 0 ? "up" : "down";
  const focus = hover == null ? null : valid[hover];

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) / rect.width * W;
    const target = first.time + (svgX - left) / (right - left) * (last.time - first.time);
    let best = 0, distance = Infinity;
    for (let index = 0; index < valid.length; index++) { const gap = Math.abs(valid[index].time - target); if (gap < distance) { distance = gap; best = index; } }
    setHover(best);
  };

  return <div className={styles.chart} data-trend={trend}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label} 权益轨迹，窗口变化 ${money(delta)} USDT`} onPointerMove={move} onPointerLeave={() => setHover(null)}>
      <defs><linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".26" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      {[top, (top + bottom) / 2, bottom].map((value, index) => <g key={index} className={styles.chartGrid}><line x1={left} x2={right} y1={y(value)} y2={y(value)} vectorEffect="non-scaling-stroke" /></g>)}
      <line className={styles.chartGuide} x1={left} x2={right} y1={y(last.equity)} y2={y(last.equity)} vectorEffect="non-scaling-stroke" />
      {groups.map((group, index) => <g key={index}>
        {group.length >= 2 && <path className={styles.chartArea} d={area(group)} fill={`url(#${id}-fill)`} />}
        <path className={styles.chartLine} d={line(group)} pathLength={1} vectorEffect="non-scaling-stroke" />
      </g>)}
      {focus && <line className={styles.chartCursor} x1={x(focus.time)} x2={x(focus.time)} y1={chartTop} y2={chartBottom} vectorEffect="non-scaling-stroke" />}
    </svg>
    <i className={styles.chartHead} style={{ left: `${x(last.time) / W * 100}%`, top: `${y(last.equity) / H * 100}%` }} />
    {focus && <i className={styles.chartFocus} style={{ left: `${x(focus.time) / W * 100}%`, top: `${y(focus.equity) / H * 100}%` }} />}
    {focus && <div className={styles.chartTip} style={{ left: `${Math.min(80, Math.max(4, x(focus.time) / W * 100))}%` }}><b>{money(focus.equity)}</b><span>{stamp(focus.observedAt)} · 可用 {money(focus.available)}</span></div>}
    <span className={styles.chartAxisHigh}>{money(top)}</span><span className={styles.chartAxisLow}>{money(bottom)}</span>
    <div className={styles.chartTimes}><span>{stamp(first.observedAt)}</span><span>{stamp((first.time + last.time) / 2)}</span><span>{stamp(last.observedAt)}</span></div>
  </div>;
}

/* ---------------- intersection timeline ---------------- */
const PAST_MS = 60 * 60_000, FUTURE_MS = 24 * 3_600_000, NOW_X = 11;
export const timelineX = (time: number, now: number) => {
  const dt = time - now;
  if (dt <= 0) return Math.max(0, NOW_X + dt / PAST_MS * NOW_X);
  return Math.min(100, NOW_X + Math.sqrt(Math.min(dt, FUTURE_MS) / FUTURE_MS) * (100 - NOW_X));
};
const TERMINAL = new Set(["EXPIRED", "CONFIRMED_EXPIRED", "NON_CAUSAL_OBSERVATION", "INVALIDATED"]);

export function IntersectionTimeline({ candidates, now, stale, priorityIds }: { candidates: Candidate[]; now: number; stale: boolean; priorityIds: Set<string> }) {
  const ticks = [{ at: -PAST_MS, label: "-1h" }, { at: 0, label: "NOW" }, { at: 30 * 60_000, label: "+30m" }, { at: 2 * 3_600_000, label: "+2h" }, { at: 6 * 3_600_000, label: "+6h" }, { at: 12 * 3_600_000, label: "+12h" }, { at: FUTURE_MS, label: "+24h" }];
  const dots = useMemo(() => {
    const rows = candidates.map(plan => ({ plan, time: Date.parse(plan.intersectionTime ?? "") })).filter(row => Number.isFinite(row.time) && now > 0)
      .map(row => ({ ...row, x: timelineX(row.time, now), beyond: row.time - now > FUTURE_MS, past: row.time < now - PAST_MS })).filter(row => !row.past).sort((a, b) => a.x - b.x);
    const lanes: number[] = [-99, -99, -99];
    return rows.map(row => {
      let lane = lanes.findIndex(lastX => row.x - lastX >= 9);
      if (lane < 0) lane = lanes.indexOf(Math.min(...lanes));
      lanes[lane] = row.x;
      return { ...row, lane };
    });
  }, [candidates, now]);

  return <div className={styles.timeline} data-stale={stale}>
    <div className={styles.timelineTrack}>
      <i className={styles.timelinePast} style={{ width: `${NOW_X}%` }} />
      <i className={styles.timelineNow} style={{ left: `${NOW_X}%` }} />
      {ticks.map(tick => <span key={tick.label} className={styles.timelineTick} data-now={tick.at === 0} style={{ left: `${timelineX(now + tick.at, now)}%` }}>{tick.label}</span>)}
      {dots.map(({ plan, x, lane, beyond }) => {
        const terminal = TERMINAL.has(plan.status) || plan.stale;
        const state = terminal ? "dead" : plan.status === "FIRST_CLOSE_LOCKED" ? "locked" : Date.parse(plan.intersectionTime ?? "") <= now ? "arrived" : "upcoming";
        return <span key={plan.id} className={styles.timelineDot} data-state={state} data-dir={plan.direction ?? "NONE"} data-priority={priorityIds.has(plan.id)} style={{ left: `${x}%`, "--lane": lane } as CSSProperties} title={`${plan.symbol} · ${stamp(plan.intersectionTime)}`}>
          <i />
          <b>{plan.symbol.replace(/USDT$/, "")}{beyond ? " ›" : ""}</b>
        </span>;
      })}
    </div>
    <div className={styles.timelineLegend}><span data-k="upcoming">等待交汇</span><span data-k="arrived">已交汇 · 等待收线</span><span data-k="locked">方向已确认</span><span data-k="dead">失效 / 过期</span><em>横轴：过去 1 小时 · 未来 24 小时（平方根刻度）</em></div>
  </div>;
}

/* ---------------- direction split ---------------- */
export function DirectionSplit({ counts }: { counts: { available: boolean; long: number | null; short: number | null; pending: number | null; excluded: number | null } }) {
  const particles = (value: number | null) => value ? Math.min(5, Math.max(1, value)) : 0;
  const paths = { long: "M60 60 C120 60 130 18 220 18", short: "M60 60 C120 60 130 102 220 102" };
  return <div className={styles.split} data-active={counts.available && ((counts.long ?? 0) + (counts.short ?? 0) + (counts.pending ?? 0)) > 0}>
    <svg viewBox="0 0 240 120" aria-hidden="true">
      <path className={styles.splitPath} data-dir="LONG" d={paths.long} />
      <path className={styles.splitPath} data-dir="SHORT" d={paths.short} />
      {(["long", "short"] as const).map(key => Array.from({ length: particles(counts[key]) }, (_, index) => <circle key={`${key}${index}`} r="2.2" className={styles.splitParticle} data-dir={key === "long" ? "LONG" : "SHORT"}>
        <animateMotion dur={`${2.2 + index * .15}s`} begin={`${index * .45}s`} repeatCount="indefinite" path={paths[key]} />
      </circle>))}
      <circle cx="44" cy="60" r="16" className={styles.splitCore} />
    </svg>
    <dl>
      <div data-dir="LONG"><dt>多头已确认</dt><dd>{counts.long ?? "—"}</dd></div>
      <div data-dir="PENDING"><dt>结构待确认</dt><dd>{counts.pending ?? "—"}</dd></div>
      <div data-dir="SHORT"><dt>空头已确认</dt><dd>{counts.short ?? "—"}</dd></div>
    </dl>
  </div>;
}
