"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import tier1Calendar from "@/agents/nexus/data/mtfx-tier1-event-calendar.json";
import paperRuntimeConfig from "@/agents/orion-v2/paper/config.json";
import { groupSettlementsByHour, ordinalCurveFraction } from "../monitor-curve";
import { abnormalLossGateLabel, MONITOR_COMMON_COPY, MONITOR_PRESENTATION_REVISION } from "../monitor-sync";
import styles from "./ledger.module.css";
import { executionReleaseView, positionExecutionLabel } from "./execution-release.mjs";
import versionHistory from "./version-history.json";
import { calculateUnrealizedNetPnl } from "./valuation";
import {
  exitReasonLabel,
  eventSourceLabel,
  gateReasonLabel,
  gateText,
  gradeLabel,
  implementationLabel,
  managementLabel,
  patternLabel,
  planWindowLabel,
  remainingTime,
  stageLabel,
  stopSourceLabel,
} from "./labels";

type Direction = "LONG" | "SHORT";
type MonitorTheme = "light" | "dark";

type EntryGate = {
  status?: string;
  direction?: Direction | 1 | -1;
  reserveBarNumber?: number;
  lockedConfirmation?: { bar?: { openTime?: number; open?: number; high?: number; low?: number; close?: number } };
  lockedProtectiveStructure?: { stop?: number; evaluatedAt?: number };
  lastExecutionReason?: string;
  lastCostEfficiencyGuard?: { completeLifecycleCostR?: number; maximumCompleteLifecycleCostR?: number } | null;
};

type Plan = {
  id: string;
  symbol: string;
  pattern: string;
  intersectionTime: number;
  intersectionPrice: number;
  intersectionWindowStart?: number;
  intersectionWindowEnd?: number;
  lockedBarOpenTime?: number;
  fourHourLineStatus?: string;
  anchorQualityScore?: number;
  anchorConsensus?: { support?: number; stabilityScore?: number; grade?: string; timeWindowMinutes?: number; priceDispersionBps?: number; perturbationSensitivityScore?: number } | null;
  entryGateByBook?: Record<string, EntryGate>;
  frozen?: boolean;
};

type Position = {
  id: string;
  symbol: string;
  direction: 1 | -1;
  implementationRevision?: string;
  executionRevision?: string;
  executionDirectiveId?: string;
  executionReleaseLoadedAt?: number | string;
  entry: number;
  initialStop?: number;
  stop: number;
  target?: number | null;
  quantity: number;
  originalQuantity?: number;
  plannedRiskUsdt?: number;
  initialPlannedRiskUsdt?: number;
  stage?: string;
  openedAt?: number;
  lastBid?: number | null;
  lastAsk?: number | null;
  entryFee?: number;
  cumulativeRealizedNetPnl?: number;
  breakEvenArmed?: boolean;
  softLockArmed?: boolean;
  firstPartialTaken?: boolean;
  secondPartialTaken?: boolean;
  protectiveStructure?: { source?: string } | null;
};

type ClosedPosition = Position & {
  closedAt?: number;
  exit?: number;
  netPnl?: number;
  realizedR?: number;
  exitReason?: string;
};

type Book = {
  initialEquityUsdt: number;
  equityUsdt: number;
  realizedPnlUsdt: number;
  dayRealizedPnlUsdt: number;
  openPositions: Position[];
  recentClosedPositions: ClosedPosition[];
  settlementHistory?: Array<{ id: string; openedAt?: number; closedAt?: number; netPnl?: number }>;
  settlementHistoryStartedAt?: number;
  newEntriesBlocked: boolean;
  blockReason?: string | null;
};

type Snapshot = {
  sourceAsOf: string;
  runtimeId: string;
  strategyVersion: string;
  implementationRevision: string;
  executionRelease?: unknown;
  portfolioProtection?: unknown;
  lifecycle: string;
  symbols: string[];
  plans: Plan[];
  books: Record<string, Book>;
  abnormalLossGate?: { status: string; entriesBlocked: boolean; manualResetRequired?: boolean; orangeHealthyCycles?: number; orangeHealthyCyclesRequired?: number; activeTrigger?: { symbol?: string; plannedMaximumLossUsdt?: number; actualLossUsdt?: number; actualLossR?: number | null; excessLossUsdt?: number } | null } | null;
  riskPolicy: { riskPerIntersectionFraction: number; maximumPortfolioRiskFraction: number; maximumOpenPositionsTotal: number; maximumLeverage: number; dailyRealizedLossStopEnabled: boolean };
  websocket: { connected: boolean; reconnects?: number; gapDetected?: boolean; lastEventAt?: number };
  onlineLedger?: { status?: string; lastReceivedAt?: string | null; lastError?: string | null };
  killSwitch?: { engaged?: boolean } | null;
  realOrdersAllowed: false;
  testnetOrdersAllowed: false;
};

type Envelope = { snapshot: Snapshot; sourceAsOf: string; receivedAt: string };

type Tier1Event = {
  id: string;
  tier: "TIER1";
  category: string;
  name: string;
  scheduledAt: string;
  source: string;
};

const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const priceFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function money(value: number) {
  return `${value < 0 ? "−" : ""}${moneyFormatter.format(Math.abs(value))}`;
}

function price(value?: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : priceFormatter.format(value);
}

function time(value?: number | string | null) {
  return value == null ? "—" : timeFormatter.format(new Date(value));
}

function eventWindow(event: Tier1Event) {
  const releaseAt = new Date(event.scheduledAt).getTime();
  return { releaseAt, start: releaseAt - 30 * 60_000, end: releaseAt + 30 * 60_000 };
}

function eventStatus(event: Tier1Event, now: number) {
  const window = eventWindow(event);
  if (now >= window.start && now < window.end) return { label: "新开仓冻结中", tone: "active" as const, target: window.end };
  if (now < window.start) {
    const near = window.start - now <= 72 * 60 * 60_000;
    return { label: near ? "临近冻结" : "已排期", tone: near ? "near" as const : "scheduled" as const, target: window.start };
  }
  return { label: "已结束", tone: "ended" as const, target: window.end };
}

function directionLabel(direction?: Direction | number) {
  return direction === "LONG" || direction === 1 ? "多" : direction === "SHORT" || direction === -1 ? "空" : "—";
}

function activeRisk(positions: Position[]) {
  return positions.reduce((sum, item) => sum + Math.max(0, item.plannedRiskUsdt ?? item.initialPlannedRiskUsdt ?? 0), 0);
}

const PAPER_MARKING_COSTS = {
  takerFeeRate: paperRuntimeConfig.paperRisk.takerFeeRate,
  adverseSlippageRate: paperRuntimeConfig.paperRisk.adverseSlippageRate,
} as const;

function floatingPnl(position: Position) {
  return calculateUnrealizedNetPnl(position, PAPER_MARKING_COSTS);
}

function aggregateNetR(position: Position, unrealizedNetPnl: number | null) {
  const initialRisk = Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt);
  if (!(initialRisk > 0) || unrealizedNetPnl == null) return null;
  return (Number(position.cumulativeRealizedNetPnl ?? 0) + unrealizedNetPnl) / initialRisk;
}

function remainingPct(position: Position) {
  const original = Number(position.originalQuantity ?? position.quantity);
  return original > 0 ? position.quantity / original * 100 : 0;
}

function gateDetail(gate?: EntryGate) {
  const reason = gateReasonLabel(gate?.lastExecutionReason);
  if (reason) return reason;
  const cost = gate?.lastCostEfficiencyGuard?.completeLifecycleCostR;
  const maximum = gate?.lastCostEfficiencyGuard?.maximumCompleteLifecycleCostR;
  if (Number.isFinite(cost) && Number.isFinite(maximum)) return `成本 ${Number(cost).toFixed(3)}R / 上限 ${Number(maximum).toFixed(2)}R`;
  return gate?.direction ? `${directionLabel(gate.direction)}向 · 第 ${gate.reserveBarNumber ?? "—"} 根15M确认` : "交汇15M及下一根内等待有效收盘";
}

type CurvePoint = { timestamp: number; value: number; delta: number; settlementCount: number; isOrigin?: boolean };
type CurveRange = "1D" | "1W" | "1M" | "ALL";

const curveRangeOptions: Array<{ value: CurveRange; label: string; durationMs: number | null }> = [
  { value: "1D", label: "1日", durationMs: 24 * 3_600_000 },
  { value: "1W", label: "1周", durationMs: 7 * 24 * 3_600_000 },
  { value: "1M", label: "1月", durationMs: 30 * 24 * 3_600_000 },
  { value: "ALL", label: "全部历史", durationMs: null },
];

function chartTime(value?: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

function niceStep(value: number) {
  const exponent = Math.floor(Math.log10(Math.max(value, Number.EPSILON)));
  const fraction = value / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

function curveScale(points: CurvePoint[]) {
  const values = [0, ...points.map((point) => point.value).filter(Number.isFinite)];
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  if (rawMinimum === 0 && rawMaximum === 0) {
    return { minimum: -1, maximum: 1, ticks: [-1, 0, 1] };
  }
  const rawSpan = Math.max(rawMaximum - rawMinimum, 1);
  const referenceSpan = rawMinimum >= 0 ? Math.max(rawMaximum, 1) : rawMaximum <= 0 ? Math.max(Math.abs(rawMinimum), 1) : rawSpan;
  const step = niceStep(referenceSpan / 4);
  const minimum = rawMinimum >= 0 ? 0 : Math.floor(rawMinimum / step) * step;
  const maximum = rawMaximum <= 0 ? 0 : Math.ceil(rawMaximum / step) * step;
  const ticks: number[] = [];
  for (let value = minimum; value <= maximum + step * 0.25; value += step) ticks.push(Math.abs(value) < step / 1000 ? 0 : value);
  // Keep extrema and their markers inside the plot. Tick bounds alone can put a
  // new high/low directly on the canvas edge, where the stroke is clipped.
  const tickSpan = Math.max(maximum - minimum, step, 1);
  const visualPadding = Math.max(tickSpan * 0.1, step * 0.3);
  return { minimum: minimum - visualPadding, maximum: maximum + visualPadding, ticks };
}

function drawMonotoneCurve(context: CanvasRenderingContext2D, coordinates: Array<{ x: number; y: number }>) {
  const path = new Path2D();
  if (!coordinates.length) return path;
  path.moveTo(coordinates[0].x, coordinates[0].y);
  if (coordinates.length === 1) return path;

  const slopes = coordinates.slice(1).map((point, index) => {
    const previous = coordinates[index];
    const width = point.x - previous.x;
    return width > 0.5 ? (point.y - previous.y) / width : 0;
  });
  const tangents = coordinates.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === coordinates.length - 1) return slopes.at(-1) ?? 0;
    const previous = slopes[index - 1];
    const next = slopes[index];
    return previous * next <= 0 ? 0 : (previous + next) / 2;
  });

  // Fritsch-Carlson limiting prevents the Bezier controls from overshooting a
  // settlement high/low. This matters when several settlements share nearly
  // the same timestamp and therefore have very different adjacent slopes.
  for (let index = 0; index < slopes.length; index += 1) {
    const slope = slopes[index];
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const startRatio = tangents[index] / slope;
    const endRatio = tangents[index + 1] / slope;
    if (startRatio < 0) tangents[index] = 0;
    if (endRatio < 0) tangents[index + 1] = 0;
    const limitedStartRatio = tangents[index] / slope;
    const limitedEndRatio = tangents[index + 1] / slope;
    const magnitude = Math.hypot(limitedStartRatio, limitedEndRatio);
    if (magnitude > 3) {
      const scale = 3 / magnitude;
      tangents[index] = scale * limitedStartRatio * slope;
      tangents[index + 1] = scale * limitedEndRatio * slope;
    }
  }

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const from = coordinates[index];
    const to = coordinates[index + 1];
    const width = to.x - from.x;
    if (width <= 0.5) {
      path.lineTo(to.x, to.y);
      continue;
    }
    path.bezierCurveTo(
      from.x + width / 3, from.y + tangents[index] * width / 3,
      to.x - width / 3, to.y - tangents[index + 1] * width / 3,
      to.x, to.y,
    );
  }
  return path;
}

function RealizedPnlCurve({ points, theme }: { points: CurvePoint[]; theme: MonitorTheme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let geometry: { left: number; right: number; top: number; bottom: number; pointXs: number[] } | null = null;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const compact = width < 680;
      const inset = { top: 22, right: compact ? 12 : 22, bottom: 34, left: compact ? 58 : 78 };
      const { minimum, maximum, ticks } = curveScale(points);
      const plotWidth = Math.max(1, width - inset.left - inset.right);
      const plotHeight = Math.max(1, height - inset.top - inset.bottom);
      const x = (index: number) => inset.left + ordinalCurveFraction(index, points.length) * plotWidth;
      const y = (value: number) => inset.top + (maximum - value) / Math.max(maximum - minimum, 1) * plotHeight;
      const zeroY = y(0);
      const palette = theme === "dark" ? {
        grid: "rgba(239, 232, 219, .11)",
        zero: "rgba(239, 232, 219, .30)",
        zeroLabel: "#c5bfb4",
        tickLabel: "#8e8a81",
        verticalGrid: "rgba(239, 232, 219, .08)",
        axisLabel: "#98938a",
        emptyLabel: "#98938a",
        positiveLine: "#66b586",
        negativeLine: "#f06b5e",
        positiveFill: "rgba(102, 181, 134, .21)",
        negativeFill: "rgba(240, 107, 94, .18)",
        areaEnd: "rgba(24, 23, 20, 0)",
        marker: "#1d1c19",
        guide: "rgba(239, 232, 219, .19)",
        annotation: "#b0aaa0",
        futureFill: "rgba(239, 232, 219, .025)",
        tooltipFill: "rgba(36, 34, 30, .97)",
        tooltipText: "#f5efe5",
        tooltipMuted: "#bab4a9",
      } : {
        grid: "rgba(91, 80, 67, .15)",
        zero: "rgba(66, 56, 46, .55)",
        zeroLabel: "#665e54",
        tickLabel: "#918a7f",
        verticalGrid: "rgba(91, 80, 67, .10)",
        axisLabel: "#918a7f",
        emptyLabel: "#918a7f",
        positiveLine: "#2f8a60",
        negativeLine: "#e3483b",
        positiveFill: "rgba(47, 138, 96, .18)",
        negativeFill: "rgba(227, 72, 59, .16)",
        areaEnd: "rgba(250, 247, 239, 0)",
        marker: "#faf7ef",
        guide: "rgba(79, 68, 56, .22)",
        annotation: "#756e64",
        futureFill: "rgba(91, 80, 67, .025)",
        tooltipFill: "rgba(40, 37, 31, .97)",
        tooltipText: "#f5f6f2",
        tooltipMuted: "#d0c9bd",
      };

      const latestX = x(Math.max(points.length - 1, 0));
      context.fillStyle = palette.futureFill;
      context.fillRect(latestX, inset.top, Math.max(0, width - inset.right - latestX), plotHeight);

      context.font = `${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "right";
      context.textBaseline = "middle";
      for (const tick of [...ticks].reverse()) {
        const lineY = y(tick);
        context.strokeStyle = tick === 0 ? palette.zero : palette.grid;
        context.lineWidth = tick === 0 ? 1.5 : 1;
        context.setLineDash(tick === 0 ? [6, 4] : []);
        context.beginPath(); context.moveTo(inset.left, lineY); context.lineTo(width - inset.right, lineY); context.stroke();
        context.setLineDash([]);
        context.fillStyle = tick === 0 ? palette.zeroLabel : palette.tickLabel;
        context.fillText(tick === 0 ? "0.00" : tick > 0 ? `+${money(tick)}` : money(tick), inset.left - 10, lineY);
      }

      const lastIndex = Math.max(points.length - 1, 0);
      const verticalTicks = compact
        ? [0, lastIndex]
        : [0, Math.round(lastIndex / 2), lastIndex];
      context.strokeStyle = palette.verticalGrid;
      context.setLineDash([2, 6]);
      for (const index of [...new Set(verticalTicks)]) { const lineX = x(index); context.beginPath(); context.moveTo(lineX, inset.top); context.lineTo(lineX, height - inset.bottom); context.stroke(); }
      context.setLineDash([]);
      context.fillStyle = palette.axisLabel;
      context.font = `${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textBaseline = "alphabetic";
      context.textAlign = "left";
      context.fillText(chartTime(points[0]?.timestamp), x(0), height - 8);
      if (!compact && points.length > 2) {
        const middleIndex = Math.round(lastIndex / 2);
        context.textAlign = "center";
        context.fillText(chartTime(points[middleIndex]?.timestamp), x(middleIndex), height - 8);
      }
      context.textAlign = "right";
      context.fillText(chartTime(points[lastIndex]?.timestamp), latestX, height - 8);

      context.strokeStyle = palette.guide;
      context.lineWidth = 1;
      context.setLineDash([3, 5]);
      context.beginPath(); context.moveTo(latestX, inset.top); context.lineTo(latestX, height - inset.bottom); context.stroke();
      context.setLineDash([]);

      context.fillStyle = palette.axisLabel;
      context.font = `600 ${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText("累计已实现净盈亏 · USDT", inset.left, 3);

      if (!points.length) {
        context.fillStyle = palette.emptyLabel;
        context.font = "500 10px Arial, PingFang SC, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("等待首笔已平仓纸面记录", inset.left + plotWidth / 2, inset.top + plotHeight / 2);
        return;
      }

      const coordinates = points.map((point, index) => ({ x: x(index), y: y(point.value) }));
      geometry = { left: inset.left, right: latestX, top: inset.top, bottom: height - inset.bottom, pointXs: coordinates.map((point) => point.x) };
      const terminalValue = points.at(-1)?.value ?? 0;
      const path = drawMonotoneCurve(context, coordinates);
      const area = new Path2D(path);
      area.lineTo(coordinates.at(-1)?.x ?? inset.left, zeroY);
      area.lineTo(coordinates[0].x, zeroY);
      area.closePath();
      const plotBottom = height - inset.bottom;
      const paintSignedRegion = (
        clipTop: number,
        clipBottom: number,
        lineColor: string,
        fillStart: string,
        fillEnd: string,
      ) => {
        const top = Math.max(inset.top, Math.min(plotBottom, clipTop));
        const bottom = Math.max(inset.top, Math.min(plotBottom, clipBottom));
        if (bottom <= top) return;
        context.save();
        context.beginPath();
        context.rect(inset.left, top, plotWidth, bottom - top);
        context.clip();
        const fill = context.createLinearGradient(0, top, 0, bottom);
        fill.addColorStop(0, fillStart);
        fill.addColorStop(1, fillEnd);
        context.fillStyle = fill;
        context.fill(area);
        context.strokeStyle = lineColor;
        context.lineWidth = 2.5;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.stroke(path);
        context.restore();
      };
      paintSignedRegion(inset.top, zeroY, palette.positiveLine, palette.positiveFill, palette.areaEnd);
      paintSignedRegion(zeroY, plotBottom, palette.negativeLine, palette.areaEnd, palette.negativeFill);

      for (let index = 1; index < coordinates.length; index += 1) {
        const coordinate = coordinates[index];
        const pointLineColor = points[index].value >= 0 ? palette.positiveLine : palette.negativeLine;
        context.fillStyle = palette.marker;
        context.strokeStyle = pointLineColor;
        context.lineWidth = 1.4;
        context.beginPath();
        context.arc(coordinate.x, coordinate.y, compact ? 2.1 : 2.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      const latestCoordinate = coordinates.at(-1);
      if (latestCoordinate && hoverIndexRef.current == null) {
        const terminalLineColor = terminalValue >= 0 ? palette.positiveLine : palette.negativeLine;
        context.fillStyle = palette.marker; context.strokeStyle = terminalLineColor; context.lineWidth = 2;
        context.beginPath(); context.arc(latestCoordinate.x, latestCoordinate.y, 4.2, 0, Math.PI * 2); context.fill(); context.stroke();
        context.strokeStyle = palette.guide; context.lineWidth = 1; context.setLineDash([3, 5]);
        context.beginPath(); context.moveTo(latestCoordinate.x, inset.top); context.lineTo(latestCoordinate.x, height - inset.bottom); context.stroke(); context.setLineDash([]);
        context.fillStyle = palette.annotation; context.textAlign = latestCoordinate.x > width * .7 ? "right" : "left"; context.textBaseline = "top";
        context.fillText(`账本已实现 ${terminalValue >= 0 ? "+" : ""}${money(terminalValue)}`, latestCoordinate.x + (latestCoordinate.x > width * .7 ? -7 : 7), inset.top + 5);
      }

      const hoverIndex = hoverIndexRef.current;
      if (hoverIndex != null && coordinates[hoverIndex] && points[hoverIndex]) {
        const coordinate = coordinates[hoverIndex];
        const point = points[hoverIndex];
        context.strokeStyle = palette.guide;
        context.lineWidth = 1;
        context.setLineDash([3, 4]);
        context.beginPath(); context.moveTo(coordinate.x, inset.top); context.lineTo(coordinate.x, height - inset.bottom); context.stroke();
        context.beginPath(); context.moveTo(inset.left, coordinate.y); context.lineTo(width - inset.right, coordinate.y); context.stroke();
        context.setLineDash([]);
        context.fillStyle = point.value >= 0 ? palette.positiveLine : palette.negativeLine;
        context.strokeStyle = palette.marker;
        context.lineWidth = 2;
        context.beginPath(); context.arc(coordinate.x, coordinate.y, 5, 0, Math.PI * 2); context.fill(); context.stroke();

        const boxWidth = compact ? 174 : 202;
        const boxHeight = point.isOrigin ? 55 : 70;
        const boxX = coordinate.x + boxWidth + 14 > width - inset.right ? coordinate.x - boxWidth - 12 : coordinate.x + 12;
        const boxY = Math.min(height - inset.bottom - boxHeight - 4, Math.max(inset.top + 4, coordinate.y - boxHeight / 2));
        context.fillStyle = palette.tooltipFill;
        context.beginPath();
        context.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
        context.fill();
        context.fillStyle = palette.tooltipMuted;
        context.font = `600 ${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText(point.isOrigin ? "可见区间起点" : `${point.settlementCount} 笔结算 · ${chartTime(point.timestamp)} CST`, boxX + 10, boxY + 9);
        context.fillStyle = palette.tooltipText;
        context.font = `650 ${compact ? 11 : 12}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        context.fillText(`累计 ${point.value >= 0 ? "+" : ""}${money(point.value)} USDT`, boxX + 10, boxY + 27);
        if (!point.isOrigin) {
          context.fillStyle = point.delta >= 0 ? palette.positiveLine : palette.negativeLine;
          context.font = `620 ${compact ? 10 : 11}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          context.fillText(`本节点 ${point.delta >= 0 ? "+" : ""}${money(point.delta)} USDT`, boxX + 10, boxY + 47);
        }
      }
    };
    draw();
    const onPointerMove = (event: PointerEvent) => {
      if (!geometry?.pointXs.length) return;
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      if (pointerX < geometry.left || pointerX > geometry.right || pointerY < geometry.top || pointerY > geometry.bottom) {
        if (hoverIndexRef.current !== null) { hoverIndexRef.current = null; draw(); }
        return;
      }
      let nearest = 0;
      let distance = Number.POSITIVE_INFINITY;
      geometry.pointXs.forEach((pointX, index) => {
        const nextDistance = Math.abs(pointX - pointerX);
        if (nextDistance < distance) { nearest = index; distance = nextDistance; }
      });
      if (hoverIndexRef.current !== nearest) { hoverIndexRef.current = nearest; draw(); }
    };
    const onPointerLeave = () => { hoverIndexRef.current = null; draw(); };
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(draw);
    if (observer) observer.observe(canvas);
    else window.addEventListener("resize", draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", draw);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [points, theme]);

  return <canvas ref={canvasRef} className={styles.curveCanvas} role="img" data-curve-sign-mode="positive-above-negative-below" aria-label="已平仓结算按小时合并并等距展开的累计净盈亏曲线；零轴以上为绿色正值，零轴以下为红色负值；移动光标可查看每个小时节点" />;
}

export default function V2LedgerPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<"plans" | "history">("plans");
  const [curveRange, setCurveRange] = useState<CurveRange>("ALL");
  const [theme, setTheme] = useState<MonitorTheme>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDialogElement>(null);

  const openDetails = (section: "versions" | "runtime" | "protection" = "versions") => {
    const dialog = detailsRef.current;
    if (!dialog) return;
    dialog.showModal();
    for (const group of dialog.querySelectorAll<HTMLDetailsElement>("[data-details-section]")) {
      group.open = group.dataset.detailsSection === section;
    }
    dialog.querySelector<HTMLElement>(`[data-details-section="${section}"]`)?.scrollIntoView({ block: "start" });
    setDetailsOpen(true);
  };

  useEffect(() => {
    if (!detailsOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [detailsOpen]);

  useEffect(() => {
    const saved = window.localStorage.getItem("mtfx-monitor-theme");
    if (saved === "dark" || saved === "light") setTheme(saved);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.monitorTheme = theme;
    if (themeReady) window.localStorage.setItem("mtfx-monitor-theme", theme);
    return () => { delete document.documentElement.dataset.monitorTheme; };
  }, [theme, themeReady]);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/mtfx-ledger", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "等待 ORION V2 首个在线快照" : "在线账本暂时不可用");
      const payload = await response.json() as Envelope;
      setSnapshot(payload.snapshot);
      setReceivedAt(payload.receivedAt);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "在线账本暂时不可用");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [refresh]);

  const derived = useMemo(() => {
    const book = snapshot ? Object.values(snapshot.books)[0] : null;
    const positions = book?.openPositions ?? [];
    const float = positions.reduce((sum, position) => sum + (floatingPnl(position) ?? 0), 0);
    const risk = activeRisk(positions);
    const planRows = [...(snapshot?.plans ?? [])].sort(
      (a, b) => (a.intersectionWindowStart ?? a.intersectionTime) - (b.intersectionWindowStart ?? b.intersectionTime),
    );
    return { book, positions, float, risk, planRows };
  }, [snapshot]);

  const realizedCurve = useMemo(() => {
    const closed = [...(derived.book?.settlementHistory ?? derived.book?.recentClosedPositions ?? [])]
      .filter((position) => Number.isFinite(position.netPnl) && Number.isFinite(position.closedAt))
      .sort((left, right) => (left.closedAt ?? 0) - (right.closedAt ?? 0));
    const selectedOption = curveRangeOptions.find((option) => option.value === curveRange) ?? curveRangeOptions.at(-1)!;
    const cutoff = selectedOption.durationMs == null ? Number.NEGATIVE_INFINITY : now - selectedOption.durationMs;
    const selected = closed.filter((position) => (position.closedAt ?? 0) >= cutoff);
    const groupedRows = groupSettlementsByHour(selected);
    const rangeDelta = groupedRows.reduce((sum, [, group]) => sum + group.delta, 0);
    const ledgerRealized = derived.book?.realizedPnlUsdt ?? 0;
    const baseline = ledgerRealized - rangeDelta;
    const firstCloseAt = groupedRows[0]?.[0] ?? now;
    const firstOpenedAt = selected.reduce((minimum, position) => Math.min(minimum, position.openedAt ?? position.closedAt ?? firstCloseAt), firstCloseAt);
    const rangeStart = selectedOption.durationMs == null
      ? Math.min(derived.book?.settlementHistoryStartedAt ?? firstOpenedAt, firstOpenedAt, firstCloseAt - 15 * 60_000)
      : cutoff;
    let cumulative = baseline;
    const points: CurvePoint[] = [{ timestamp: rangeStart, value: baseline, delta: 0, settlementCount: 0, isOrigin: true }];
    for (const [timestamp, group] of groupedRows) {
      cumulative += group.delta;
      points.push({ timestamp, value: cumulative, delta: group.delta, settlementCount: group.count });
    }
    return { points, rangeStart, rangeDelta, baseline, sampleCount: selected.length, hourNodeCount: groupedRows.length, firstCloseAt: groupedRows[0]?.[0], lastCloseAt: groupedRows.at(-1)?.[0] };
  }, [curveRange, derived.book?.realizedPnlUsdt, derived.book?.recentClosedPositions, derived.book?.settlementHistory, derived.book?.settlementHistoryStartedAt, now]);

  const freshness = useMemo(() => {
    if (!receivedAt) return { label: "等待在线快照", stale: true };
    const seconds = Math.max(0, Math.floor((now - new Date(receivedAt).getTime()) / 1000));
    return seconds > 90 ? { label: `${Math.ceil(seconds / 60)} 分钟前`, stale: true } : { label: seconds < 15 ? "刚刚更新" : `${seconds} 秒前`, stale: false };
  }, [now, receivedAt]);

  const eventTape = useMemo(() => {
    const events = (tier1Calendar.events as Tier1Event[])
      .filter((event) => eventWindow(event).end > now)
      .sort((left, right) => eventWindow(left).releaseAt - eventWindow(right).releaseAt)
      .slice(0, 6);
    return events.map((event) => ({ event, status: eventStatus(event, now) }));
  }, [now]);

  if (!snapshot || !derived.book) return <main className={styles.loadingPage} data-theme={theme} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}>
    <div className={styles.loadingMark}>M</div><h1>MTFX 在线监视器</h1><p>{error || "正在连接 ORION V2 在线快照…"}</p>
    <button onClick={() => void refresh(true)} disabled={refreshing}>{refreshing ? "读取中" : "重新读取"}</button>
  </main>;

  const { book, positions, float, risk, planRows } = derived;
  const riskLimit = book.equityUsdt * snapshot.riskPolicy.maximumPortfolioRiskFraction;
  const markedEquity = book.equityUsdt + float;
  const totalPnl = markedEquity - book.initialEquityUsdt;
  const monitorOnline = snapshot.websocket.connected && !freshness.stale;
  const curvePnl = realizedCurve.points.at(-1)?.value ?? book.realizedPnlUsdt;
  const firstCurveTime = realizedCurve.firstCloseAt;
  const lastCurveTime = realizedCurve.lastCloseAt;
  const nextForwardPlan = planRows.find((plan) => (plan.intersectionWindowStart ?? plan.intersectionTime) > now);
  const maximumCompleteLifecycleCostR = paperRuntimeConfig.execution.maximumCompleteLifecycleCostR;
  const release = executionReleaseView(snapshot, now);
  const currentImplementationLabel = release.label ?? implementationLabel(snapshot.implementationRevision);
  const currentVersion = release.shortLabel ?? implementationLabel(snapshot.implementationRevision).split(" · ")[0];
  const sourceTime = Date.parse(snapshot.sourceAsOf);
  const heartbeatAge = Math.max(0, Math.floor((now - sourceTime) / 1000));
  const heartbeatCurrent = Number.isFinite(sourceTime) && sourceTime <= now + 5_000 && heartbeatAge <= 90;
  const heartbeatAgeLabel = Number.isFinite(heartbeatAge) ? heartbeatAge < 60 ? `${heartbeatAge} 秒前` : `${Math.floor(heartbeatAge / 60)} 分 ${heartbeatAge % 60} 秒前` : "等待时间数据";
  const frozenCampaigns = release.campaigns.filter((campaign) => campaign.frozen);
  const entriesRestricted = book.newEntriesBlocked || snapshot.abnormalLossGate?.entriesBlocked || snapshot.killSwitch?.engaged;
  const positionVersions = [
    ...positions.map((position) => ({ ...position, recordStatus: "持仓中" })),
    ...book.recentClosedPositions.slice().reverse().map((position) => ({ ...position, recordStatus: "已平仓" })),
  ];

  return <main
    className={styles.page}
    data-theme={theme}
    data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}
    data-mobile-text-contract="wrap-without-clipping"
    data-information-layout="trading-first-system-drawer-v1"
  >
    <header className={styles.header}>
      <div className={styles.identity}><span>V2</span><div><h1>交易监视器</h1><p>纸面账户 · USDT</p></div></div>
      <div className={styles.headerMeta}>
        <button type="button" className={styles.versionButton} onClick={() => openDetails("versions")} aria-haspopup="dialog" aria-controls="v2-system-details" aria-expanded={detailsOpen} aria-label={`${currentVersion}，展开更新日志与系统详情`} title="更新日志与系统详情"><span>{currentVersion}</span><span aria-hidden="true">⌄</span></button>
        <button onClick={() => void refresh(true)} disabled={refreshing}>{refreshing ? MONITOR_COMMON_COPY.refreshing : MONITOR_COMMON_COPY.refresh}</button>
        <button
          type="button"
          className={styles.themeToggle}
          onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          aria-label={theme === "light" ? "切换至夜间模式" : "切换至日间模式"}
          aria-pressed={theme === "dark"}
          title={theme === "light" ? "夜间模式" : "日间模式"}
        ><span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span></button>
      </div>
    </header>

    <section className={styles.heartbeatBar} aria-label="心跳信息">
      <div className={styles.heartbeatState} data-live={heartbeatCurrent}><i aria-hidden="true" /><b>账本心跳</b><span>{heartbeatCurrent ? "正常" : "延迟"}</span></div>
      <dl><div><dt>最近更新</dt><dd>{time(snapshot.sourceAsOf)} CST</dd></div><div><dt>距今</dt><dd>{heartbeatAgeLabel}</dd></div><div><dt>行情连接</dt><dd>{!heartbeatCurrent ? "待确认" : snapshot.websocket.connected ? "在线" : "中断"}</dd></div></dl>
      <button type="button" onClick={() => openDetails("runtime")}>运行详情 <span aria-hidden="true">↗</span></button>
    </section>
    {(error || freshness.stale || !release.live) && <div className={styles.tradeNotice} role="status">{error || "账户数据更新延迟，当前数值可能已过期。"}<button type="button" onClick={() => void refresh(true)}>刷新数据</button></div>}
    {entriesRestricted && <div className={styles.tradeNotice} role="status"><span>新入场已暂停 · {snapshot.killSwitch?.engaged ? "运行已暂停" : snapshot.abnormalLossGate?.entriesBlocked ? abnormalLossGateLabel(snapshot.abnormalLossGate.status) : gateReasonLabel(book.blockReason ?? undefined) ?? "入场条件暂未满足"}</span><button type="button" onClick={() => openDetails("runtime")}>查看详情</button></div>}
    {release.protectionFresh && frozenCampaigns.length > 0 && <div className={styles.tradeNotice} role="status"><span>组合保护 · {frozenCampaigns.map((campaign) => campaign.directionLabel).join("、")}暂停新入场</span><button type="button" onClick={() => openDetails("protection")}>查看保护状态</button></div>}

    <section className={styles.metrics} aria-label="账户与风险概览">
      <article className={styles.primaryMetric}><small>账户权益 · 含浮动</small><strong>{money(markedEquity)} <em>USDT</em></strong><span className={totalPnl >= 0 ? styles.positive : styles.negative}>{money(totalPnl)} · {(totalPnl / book.initialEquityUsdt * 100).toFixed(2)}%</span></article>
      <article><small>已实现净盈亏</small><strong className={book.realizedPnlUsdt >= 0 ? styles.positive : styles.negative}>{money(book.realizedPnlUsdt)}</strong><span>日内 {money(book.dayRealizedPnlUsdt)} USDT</span></article>
      <article><small>浮动净盈亏</small><strong className={float >= 0 ? styles.positive : styles.negative}>{money(float)}</strong><span>{positions.length ? "按当前 BBO、费用及滑点净标记" : "当前无开放仓位"}</span></article>
      <article><small>组合计划风险</small><strong>{money(risk)}</strong><span>{(risk / riskLimit * 100).toFixed(1)}% / 上限 {money(riskLimit)} USDT</span></article>
      <article><small>开放仓位</small><strong>{positions.length} <em>/ {snapshot.riskPolicy.maximumOpenPositionsTotal}</em></strong><span>单交汇 ≤ {(snapshot.riskPolicy.riskPerIntersectionFraction * 100).toFixed(0)}% · 杠杆 ≤ {snapshot.riskPolicy.maximumLeverage}×</span></article>
    </section>

    <section className={styles.curvePanel} aria-label="已实现收益曲线">
      <div className={styles.curveHead}>
        <div>
          <div className={styles.curveRanges} role="group" aria-label="收益曲线时间范围">
            {curveRangeOptions.map((option) => <button type="button" key={option.value} className={curveRange === option.value ? styles.activeRange : ""} onClick={() => setCurveRange(option.value)}>{option.label}</button>)}
          </div>
          <small>REALIZED SETTLEMENT PATH · USDT</small><h2>已平仓结算路径</h2><p>同一小时的结算合并为一个节点，并按结算小时等距展开；曲线上升表示该小时净盈利，下降表示净亏损。移动光标可查看小时、结算笔数、节点变化和累计净盈亏。</p>
        </div>
        <div className={styles.curveValue}><b className={curvePnl >= 0 ? styles.positive : styles.negative}>{curvePnl >= 0 ? "+" : ""}{money(curvePnl)} USDT</b><small>当前账本已实现</small></div>
      </div>
      <div className={styles.curveMeta}>
        <span><small>初始资金</small><b>{money(book.initialEquityUsdt)} USDT</b></span>
        <span><small>可见起点累计</small><b>{money(realizedCurve.baseline)} USDT</b></span>
        <span><small>区间净变化</small><b className={realizedCurve.rangeDelta >= 0 ? styles.positive : styles.negative}>{money(realizedCurve.rangeDelta)} USDT</b></span>
        <span><small>{book.settlementHistory ? "区间结算样本" : "等待完整历史同步 · 当前为最近快照"}</small><b>{realizedCurve.sampleCount} 笔 · {realizedCurve.hourNodeCount} 小时节点</b></span>
      </div>
      <div className={styles.curvePlot}><RealizedPnlCurve points={realizedCurve.points} theme={theme} /></div>
      <div className={styles.curveFoot}><span>{firstCurveTime ? `首个小时节点 · ${chartTime(firstCurveTime)} CST` : "区间暂无新结算"}</span><span>横轴按结算小时等距 · 纵轴为累计净盈亏</span><span>{lastCurveTime ? `最近小时节点 · ${chartTime(lastCurveTime)} CST` : "—"}</span></div>
    </section>

    <section className={styles.monitor} aria-label={MONITOR_COMMON_COPY.positions} data-position-layout="symbol-first-aligned-grid">
      <div className={styles.sectionHead}><div><small>OPEN POSITIONS</small><h2>{MONITOR_COMMON_COPY.positions}</h2><p>浮动净额按当前可执行BBO及完整成本标记；止损来源、初始保护与当前管理阶段均来自在线账本。</p></div><span className={styles.positionCount}>{positions.length} / {snapshot.riskPolicy.maximumOpenPositionsTotal} 开放仓位</span></div>
      <div className={styles.tableWrap}><div className={`${styles.row} ${styles.positionHeader}`}><span>标的 / 方向</span><span>入场</span><span>当前 BBO</span><span>当前 / 初始止损</span><span>初始计划风险</span><span>浮动净盈亏</span><span>仓位管理</span></div>
        {positions.length ? positions.map((position) => {
          const pnl = floatingPnl(position);
          const netR = aggregateNetR(position, pnl);
          const quoteAsset = position.symbol.endsWith("USDT") ? "USDT" : "";
          const baseAsset = quoteAsset ? position.symbol.slice(0, -quoteAsset.length) : position.symbol;
          return <div className={`${styles.row} ${styles.positionRow}`} key={position.id}>
            <span className={`${styles.market} ${styles.positionIdentity}`} data-label="标的 / 方向"><i>{baseAsset.slice(0, 1)}</i><b className={styles.positionIdentityCopy}><span className={styles.positionSymbol} aria-label={position.symbol}>{baseAsset}{quoteAsset ? <em>/ {quoteAsset}</em> : null}</span><small className={position.direction === 1 ? styles.long : styles.short}>{directionLabel(position.direction)} · 剩 {remainingPct(position).toFixed(0)}%</small></b></span>
            <span className={styles.positionMetric} data-label="入场"><b>{price(position.entry)}</b><small>{time(position.openedAt)} CST</small></span>
            <span className={styles.positionMetric} data-label="当前 BBO"><b>{position.direction === 1 ? price(position.lastBid) : price(position.lastAsk)}</b><small>{position.direction === 1 ? "Bid 可执行标记" : "Ask 可执行标记"}</small></span>
            <span className={styles.positionMetric} data-label="当前 / 初始止损"><b>{price(position.stop)}</b><small>初始 {price(position.initialStop)} · {stopSourceLabel(position)}</small></span>
            <span className={styles.positionMetric} data-label="初始计划风险"><b>{money(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt ?? 0)}</b><small>{netR == null ? "累计R待计算" : `累计约 ${netR.toFixed(2)}R`}</small></span>
            <span className={styles.positionMetric} data-label="浮动净盈亏"><b className={pnl == null || pnl >= 0 ? styles.positive : styles.negative}>{pnl == null ? "—" : money(pnl)}</b><small>当前剩余仓净额</small></span>
            <span className={styles.positionMetric} data-label="仓位管理"><b>{stageLabel(position.stage)}</b><small>{managementLabel(position)}</small></span>
          </div>;
        }) : <div className={styles.empty}>当前没有开放仓位</div>}
      </div>
    </section>

    <section className={styles.eventRisk} aria-label="Tier 1 风险事件">
      <div className={styles.eventIntro}>
        <small>TIER‑1 EVENT RISK · CURRENT RULE</small>
        <h2>风险事件</h2>
        <p>仅显示已验证的一级宏观日历；公布前后各30分钟暂停新入场，已有仓位继续按原规则管理。</p>
      </div>
      <div className={styles.eventViewport} aria-live="polite">
        <div className={styles.eventTrack}>
          {[...eventTape, ...eventTape].map(({ event, status }, index) => <article className={styles.eventCard} key={`${event.id}-${index}`} data-tone={status.tone}>
            <span className={styles.eventState}>{status.label}</span>
            <b>{event.name}</b>
            <small>{time(event.scheduledAt)} CST · {status.tone === "active" ? `恢复倒计时 ${remainingTime(status.target, now)}` : `暂停倒计时 ${remainingTime(status.target, now)}`}</small>
          </article>)}
        </div>
      </div>
      <div className={styles.eventFoot}><span>{eventTape[0] ? `下一项来源：${eventSourceLabel(eventTape[0].event.source)}` : "等待下一份已验证日历"}</span><span>仅风险提示，不构成交易信号</span></div>
    </section>

    <section className={styles.monitor}>
      <div className={styles.sectionHead}><div><small>DEMO MONITOR</small><h2>{view === "plans" ? `${MONITOR_COMMON_COPY.candidates}与交汇倒计时` : "已平仓纸面记录"}</h2><p>所有时间为 Asia/Shanghai；候选按数学交汇窗口开始时间排序。</p></div>
        <div className={styles.tabs}><button className={view === "plans" ? styles.activeTab : ""} onClick={() => setView("plans")}>{MONITOR_COMMON_COPY.candidates} {planRows.length}</button><button className={view === "history" ? styles.activeTab : ""} onClick={() => setView("history")}>历史 {book.recentClosedPositions.length}</button></div></div>

      {view === "plans" && <div className={styles.forwardNotice}><span>下个交汇</span>{nextForwardPlan ? <b>{nextForwardPlan.symbol} · {time(nextForwardPlan.intersectionWindowStart ?? nextForwardPlan.intersectionTime)} CST · {remainingTime(nextForwardPlan.intersectionWindowStart ?? nextForwardPlan.intersectionTime, now)}</b> : <b>暂无前向交汇，等待新结构形成</b>}</div>}

      {view === "plans" && <div className={styles.tableWrap}><div className={`${styles.row} ${styles.planHeader}`}><span>标的 / 结构</span><span>4H 谱系</span><span>数学交汇窗口</span><span>精确交点 P×</span><span>交汇倒计时</span><span>入场验证状态</span><span>锚点稳定度</span></div>
        {planRows.map((plan) => {
          const gate = plan.entryGateByBook?.["MTFX-T"];
          const timing = planWindowLabel({ start: plan.intersectionWindowStart ?? plan.intersectionTime, status: gate?.status, now });
          const stability = Math.min(100, Math.max(0, (plan.anchorConsensus?.stabilityScore ?? plan.anchorQualityScore ?? 0) * 100));
          return <div className={`${styles.row} ${styles.planRow}`} key={plan.id}>
          <span className={styles.market} data-label="标的 / 结构"><i>{plan.symbol.slice(0, 1)}</i><b>{plan.symbol}<small>{patternLabel(plan.pattern)}</small></b></span>
          <span data-label="4H 谱系"><b>{plan.fourHourLineStatus === "ACTIVE_4H_TREND" ? "当前4H趋势" : "前序4H候选"}</b><small>{plan.frozen ? "结构已锁定" : "仍在观察"}</small></span>
          <span data-label="数学交汇窗口"><b>{time(plan.intersectionWindowStart ?? plan.intersectionTime)}</b><small>结束 {time(plan.intersectionWindowEnd ?? plan.intersectionTime)} CST</small></span>
          <span data-label="精确交点 P×"><b>{price(plan.intersectionPrice)}</b><small>数学价格，不等于成交价</small></span>
          <span data-label="交汇倒计时"><b className={timing.label.includes("已") ? styles.warning : ""}>{timing.label}</b><small>{timing.detail}</small></span>
          <span data-label="入场验证状态"><b>{gateText(gate?.status)}</b><small>{gateDetail(gate)}</small></span>
          <span className={styles.planStabilityCell} data-label="锚点稳定度">
            <span className={styles.planStabilityValue}><b>{stability.toFixed(1)}%</b><em>{gradeLabel(plan.anchorConsensus?.grade)}稳定</em></span>
            <span
              className={styles.planStabilityProgress}
              role="progressbar"
              aria-label={`${plan.symbol} 锚点稳定度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Number(stability.toFixed(1))}
            ><i style={{ width: `${stability}%` }} /></span>
            <small>支持 {plan.anchorConsensus?.support ?? 0} 组锚点假设</small>
          </span>
        </div>;
        })}</div>}

      {view === "history" && <div className={styles.tableWrap}><div className={`${styles.row} ${styles.historyHeader}`}><span>平仓时间</span><span>标的 / 方向</span><span>入场 → 退出</span><span>初始计划风险</span><span>净盈亏 / R</span><span>退出原因</span><span>证据状态</span></div>
        {[...book.recentClosedPositions].reverse().map((position) => <div className={`${styles.row} ${styles.historyRow}`} key={position.id}><span data-label="平仓时间"><b>{time(position.closedAt)}</b><small>已完成结算</small></span><span className={styles.market} data-label="标的 / 方向"><i>{position.symbol.slice(0, 1)}</i><b>{position.symbol}<small className={position.direction === 1 ? styles.long : styles.short}>{directionLabel(position.direction)}</small></b></span><span data-label="入场 → 退出"><b>{price(position.entry)}</b><small>→ {price(position.exit)}</small></span><span data-label="初始计划风险"><b>{money(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt ?? 0)}</b><small>USDT</small></span><span data-label="净盈亏 / R"><b className={(position.netPnl ?? 0) >= 0 ? styles.positive : styles.negative}>{money(position.netPnl ?? 0)}</b><small>{position.realizedR == null ? "—" : `${position.realizedR.toFixed(2)}R`}</small></span><span data-label="退出原因"><b>{exitReasonLabel(position.exitReason)}</b><small>按实际结算记录</small></span><span data-label="证据状态"><b>已记录</b><small>结算记录可追溯</small></span></div>)}</div>}
    </section>

    <footer className={styles.footer}><span>纸面账户 · 所有时间为北京时间</span><span>数据时间 {time(snapshot.sourceAsOf)} CST</span></footer>
    {/* Version and operational information stay outside the default trading surface. */}
    <dialog id="v2-system-details" ref={detailsRef} className={styles.systemDrawer} aria-labelledby="v2-system-title" onClose={() => setDetailsOpen(false)} onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
    }}>
      <div className={styles.drawerHeader}><div><small>ORION V2</small><h2 id="v2-system-title">版本与系统</h2></div><button type="button" onClick={() => detailsRef.current?.close()} aria-label="关闭版本与系统详情">×</button></div>
      <div className={styles.drawerBody}>
        <details className={styles.infoGroup} data-details-section="versions" open>
          <summary><span><b>版本更新日志</b><small>从初始版本到当前修订</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}>
            <div className={styles.currentRelease}><span>当前快照版本</span><b>{currentImplementationLabel}</b><small>{release.status}</small></div>
            <p className={styles.groupNote}>按版本记录变化。授权或记录日期不等于进程加载时间；历史内容保留当时规则。</p>
            <div className={styles.releaseTimeline}>
              {versionHistory.entries.map((entry, index) => <details className={styles.releaseEntry} key={entry.version} open={index === 0}>
                <summary><span className={styles.releaseCode}>{entry.version}</span><span className={styles.releaseHeadline}><b>{entry.title}</b><small>{entry.date} · {entry.dateLabel}</small></span>{entry.version === currentVersion && <em>当前</em>}<span aria-hidden="true">⌄</span></summary>
                <ul>{entry.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
              </details>)}
            </div>
            {versionHistory.unnumberedUpdates.length > 0 && <details className={styles.releaseEntry}><summary><span className={styles.releaseHeadline}><b>独立配置与修复记录</b><small>沿用原版本号的补充更新</small></span><span aria-hidden="true">⌄</span></summary><div className={styles.supplementalUpdates}>{versionHistory.unnumberedUpdates.map((entry) => <article key={entry.id}><b>{entry.title}</b><small>{entry.date} · {entry.dateLabel}</small><ul>{entry.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul></article>)}</div></details>}
          </div>
        </details>

        <details className={styles.infoGroup} data-details-section="runtime">
          <summary><span><b>运行与数据同步</b><small>进程、加载时间和数据完整性</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}>
            <dl className={styles.systemFacts}>
              <div><dt>MTFX 引擎</dt><dd className={monitorOnline ? styles.positive : styles.warning}>{monitorOnline ? "运行中" : "状态待确认"}</dd></div>
              <div><dt>修订验证</dt><dd>{release.status}</dd></div>
              <div><dt>本进程加载</dt><dd>{time(release.loadedAt)} CST</dd></div>
              <div><dt>保护验证</dt><dd>{time(release.verifiedAt)} CST</dd></div>
              <div><dt>最近有效评估</dt><dd>{time(release.lastAcceptedAt)} CST</dd></div>
              <div><dt>行情 / 在线快照</dt><dd>{snapshot.websocket.connected ? "在线" : "中断"} / {freshness.stale ? MONITOR_COMMON_COPY.stale : MONITOR_COMMON_COPY.healthy}</dd></div>
              <div><dt>数据完整性</dt><dd>{snapshot.websocket.gapDetected ? "有历史缺口标记" : "覆盖正常"}</dd></div>
              <div><dt>运行总开关</dt><dd>{snapshot.killSwitch?.engaged ? "已暂停" : "允许运行"}</dd></div>
              <div><dt>快照源时间</dt><dd>{time(snapshot.sourceAsOf)} CST</dd></div>
              <div><dt>服务器接收</dt><dd>{time(receivedAt)} CST</dd></div>
            </dl>
          </div>
        </details>

        <details className={styles.infoGroup} data-details-section="protection">
          <summary><span><b>组合保护与入场检查</b><small>多空冻结状态、保护阶段和风险限制</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}>
            <dl className={styles.systemFacts}>
              <div><dt>异常单笔亏损闸门</dt><dd className={snapshot.abnormalLossGate?.entriesBlocked ? styles.negative : ""}>{abnormalLossGateLabel(snapshot.abnormalLossGate?.status)}</dd></div>
              <div><dt>单交汇风险</dt><dd>≤ {(snapshot.riskPolicy.riskPerIntersectionFraction * 100).toFixed(0)}%</dd></div>
              <div><dt>组合风险</dt><dd>≤ {(snapshot.riskPolicy.maximumPortfolioRiskFraction * 100).toFixed(0)}%</dd></div>
              <div><dt>仓位 / 杠杆上限</dt><dd>{snapshot.riskPolicy.maximumOpenPositionsTotal} 笔 / {snapshot.riskPolicy.maximumLeverage}×</dd></div>
            </dl>
            <div className={styles.drawerCampaigns}>{release.campaigns.map((campaign) => <article key={campaign.direction}><h3>{campaign.directionLabel}组合</h3><b className={!release.protectionFresh || campaign.frozen ? styles.warning : styles.positive}>{campaign.state}</b><span>纳入保护 {campaign.positionCount ?? "—"} 笔</span><span>入场保护：{campaign.tier}</span><span>出场保护：{campaign.actionTier}</span><span>利润回吐 {campaign.drawdownFraction == null ? "—" : `${(campaign.drawdownFraction * 100).toFixed(1)}%`}</span><small>{campaign.freezeUntil ? `账本冻结至 ${time(campaign.freezeUntil)} CST` : "账本无当前冻结期限"}</small></article>)}</div>
            <p className={styles.groupNote}>{release.evidenceHold ? "保护证据不足，入场保持冻结。" : "本组合保护之外，新开仓还须通过其他入场与风险检查。"}保护已启动后，剩余1–2笔仓位也继续执行同向入场冻结；减仓和平仓仍遵循原条件。</p>
          </div>
        </details>

        <details className={styles.infoGroup}>
          <summary><span><b>策略与计算说明</b><small>时间框架、入场验证和盈亏口径</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}>
            <h3>当前策略规则</h3><p>4H主趋势、1H反向趋势线形成交汇；在交汇15M或紧邻下一根15M中，使用首根符合条件的完整收盘确认方向，再校验可执行BBO的偏离、信号时效和完整往返成本。</p>
            <dl className={styles.systemFacts}><div><dt>相对确认收盘防追价</dt><dd>≤ 50bps</dd></div><div><dt>确认信号有效期</dt><dd>≤ 180秒</dd></div><div><dt>完整往返成本上限</dt><dd>≤ {maximumCompleteLifecycleCostR.toFixed(2)}R</dd></div><div><dt>复核时机</dt><dd>新入场、等待重试与反向替代</dd></div></dl>
            <h3>盈亏与曲线</h3><p>账户权益包含浮动净盈亏。浮动净额按当前可执行BBO及费用、滑点标记；曲线按实际已平仓结算合并小时节点，不将浮盈记作已实现收益。</p>
            <h3>监视器权限</h3><p>只读页面，显示纸面交易账本，不包含下单、停止、策略或风险修改控制。</p>
          </div>
        </details>

        <details className={styles.infoGroup}>
          <summary><span><b>订单版本记录</b><small>持仓与最近平仓各自绑定的入场版本</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}>
            <p className={styles.groupNote}>历史版本以每笔订单入场记录为准，不随当前版本变更。</p>
            <div className={styles.orderVersions}>{positionVersions.length ? positionVersions.map((position) => <div key={position.id}><b>{position.symbol}<small>{position.recordStatus} · {directionLabel(position.direction)} · {time(position.openedAt)}</small></b><span>{positionExecutionLabel(position) ?? implementationLabel(position.implementationRevision)}</span></div>) : <p>暂无订单记录。</p>}</div>
          </div>
        </details>

        <details className={styles.infoGroup}>
          <summary><span><b>账户影子验证</b><small>独立对照与候选方案</small></span><span aria-hidden="true">＋</span></summary>
          <div className={styles.groupBody}><p>查看账户权益影子与独立候选方案的对照记录。</p><a className={styles.shadowEntry} href="/v2-ledger/account-shadow">打开账户影子验证 <span aria-hidden="true">↗</span></a></div>
        </details>
      </div>
    </dialog>
  </main>;
}
