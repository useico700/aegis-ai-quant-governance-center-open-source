"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { planPriceEvent, planFamilyKey } from '../../../lib/smc-plan-lifecycle.mjs';
import { SMC_LINK_REVISION, linkedStructure, linkedLayers, linkedPlanLabel, visibleLinkedPlans, primaryLinkedPlan } from '../../../lib/smc-reference-link.mjs';
import { reviewEntryGeometry } from '../../../lib/smc-entry-review.mjs';
import policy from "../../../lib/smc-scan-policy.json";
import { formatSignedEntryPercent, signedEntryBandDistance } from "../../../lib/smc-distance-display.mjs";
import { manualOrderSourceForCandidate } from "../../../lib/smc-manual-order-source.mjs";
import { positionsUnrealizedPnl } from "../../../lib/smc-position-unrealized.mjs";
import HorizonField from "./HorizonField";
import { IntersectionLine, IntersectionAxis, IntersectionCaption } from "./IntersectionGuide";
import { buildIntersectionView } from "./intersection-view.mjs";
import { sourceErrorLabel } from "./source-health.mjs";
import { planProtectionLabel, planRiskView } from "./plan-presentation.mjs";
import ManualOrderPanel, { type ManualOrderContext } from "./ManualOrderPanel";
import PositionControls from "./PositionControls";
import MonitorDisclosure from "./MonitorDisclosure";
import { ScrambleText } from "./Cinematic";
import Image from "next/image";
import { spotlight, useTween } from "./motion";
import type { Direction, Feed, LiveQuoteSnapshot, ManualCandidate, ManualZone, Opportunity, SmcLedger, PlanTerminal } from "./types";
import styles from "./smc-workspace.module.css";

/* ---------- formatting (identical semantics to /s2/smc) ---------- */
const fmt = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : Math.abs(value) >= 10 ? 4 : 6 }).format(value);
const clock = (value: number | string | null | undefined, withDate = false) => value == null ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: withDate ? "2-digit" : undefined, day: withDate ? "2-digit" : undefined, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

const waitingStatus: Record<string, string> = { ARMED_CE_CLOSE: "等待 CE 触及", WAIT_15M_MICRO_STRUCTURE_SHIFT: "CE 已触及，等待 15M 微结构位移", WAIT_CE_REENTRY: "位移已确认，等待回到执行半区", WAIT_LIQUIDITY_SWEEP_RECLAIM: "等待清扫内部流动性并收回", WAIT_VALUE_LOCATION: "位置偏贵/偏便宜，暂不追价", WAIT_15M_EXPANSION_CONFIRMATION: "15M 压缩或确认力度不足", ENTRY_BAND_ACTIVE: "位移确认且价格位于执行半区", WAIT_SECOND_BAR_CE_REVERSAL: "反向大实体已穿CE，等待紧接第二根15M反穿", WAIT_SECOND_BAR_PRICE: "第二根反穿CE已确认，等待盘口回到有效价差", SECOND_BAR_REVERSE_READY: "第二根反穿CE已确认，可进入风险预检" };
const nextActions: Record<string, string> = { ARMED_CE_CLOSE: "等待价格测试 CE 并完成收线", WAIT_15M_MICRO_STRUCTURE_SHIFT: "触及后 4 根 15M 内等待收盘突破前 2 根内部极值", WAIT_CE_REENTRY: "不追价，等待最新 ASK/BID 回到 FVG 方向侧半区", WAIT_LIQUIDITY_SWEEP_RECLAIM: "先清扫 CE 与止损间的确认摆点，再以收盘价回收方向侧", WAIT_VALUE_LOCATION: "同时通过 64 根原始区间与 Q10–Q90 稳健区间位置", WAIT_15M_EXPANSION_CONFIRMATION: "等待非压缩且有方向收盘位置的 15M 确认", ENTRY_BAND_ACTIVE: "进入账户风险、报价质量与保护单预检", WAIT_SECOND_BAR_CE_REVERSAL: "等待紧接下一根大实体收盘，不因未成交旧止损扫荡直接取消", WAIT_SECOND_BAR_PRICE: "等待报价在第二根收盘价0.5%内并保持CE方向侧", SECOND_BAR_REVERSE_READY: "按扫荡极值重算入场前止损并校验净2R与账户风险" };
const rejectedLabels: Record<string, string> = { NO_FVG: "无有效 FVG", FVG_INVALIDATED: "FVG 已失效", N_PATTERN_FVG_INVALIDATED: "N 结构 FVG 已失效", REVERSAL_REQUIRES_LIQUIDITY_SWEEP: "反转结构缺少流动性清扫", POI_REPEATED_MITIGATION: "POI 已被重复回补", POI_EXCESSIVE_CE_BODY_CROSSES: "CE 被实体反复穿越", MICRO_STRUCTURE_SHIFT_NOT_CONFIRMED: "CE 触及后 4 根内未形成微结构位移", N_PATTERN_MICRO_STRUCTURE_SHIFT_NOT_CONFIRMED: "N 结构触及后未形成微结构位移", MICRO_STRUCTURE_CONFIRMATION_EXPIRED: "微结构确认后未回执行带，窗口已过期", N_PATTERN_MICRO_STRUCTURE_CONFIRMATION_EXPIRED: "N 结构位移确认已过期", NET_R_BELOW_2: "净 R 低于 2", N_PATTERN_NET_R_BELOW_2: "N 结构净 R 低于 2", NO_UNSWEPT_STRUCTURE_TARGET: "无未扫结构目标", N_PATTERN_NO_UNSWEPT_TARGET: "N 结构无未扫目标", PROTECTED_STRUCTURE_BROKEN: "保护结构被突破", N_PATTERN_STRUCTURE_INVALIDATED: "N 结构被突破", STOP_REGION_ALREADY_BREACHED: "未成交计划原止损已扫，双K反穿未确认", N_PATTERN_STOP_REGION_ALREADY_BREACHED: "未成交计划原止损已扫，双K反穿未确认", SECOND_BAR_CE_REVERSAL_FAILED: "紧接第二根未反穿CE，计划失效", SECOND_BAR_CE_REVERSAL_EXPIRED: "第二根反穿确认已过期", STRUCTURE_OUTSIDE_ACTIVE_PLAN_HORIZON: "超出 14 天计划窗口", N_PATTERN_OUTSIDE_ACTIVE_PLAN_HORIZON: "N 结构超出 14 天窗口", TARGET_ALREADY_VISITED: "目标已到达 · 旧机会已结束", STOP_ALREADY_VISITED: "保护止损已触达 · 旧方案失效", PATH_UNKNOWN: "同K路径不明 · 停止旧方案", PLAN_EXPIRED: "旧方案已过期", N_PATTERN_TARGET_VISITED: "结构目标已到达", SETUP_EXPIRED: "计划已过期", N_PATTERN_SETUP_EXPIRED: "N 结构计划已过期", REMOVED_FROM_ACTIVE_SET: "已移出有效候选集" };

const POLL_MS = 15000;
const QUOTE_STALE_MS = 10000;
const QUOTE_RECONNECT_MAX_MS = 10000;
const ownerSelectionId = (row: Pick<ManualCandidate, "symbol" | "direction">) => `owner:${row.symbol}:${row.direction}`;
type MarketView = { price: number; absolute: number; percent: number; signedPercent: number; quoteAt: number; side: "ASK" | "BID"; inBand: boolean; live: boolean };
function conditionRows(candidate: Opportunity, market?: MarketView | null) {
  if (candidate.modelRevision === "SMC-S1-PX-1") return [
    {label:"SMC 4H/15M 交汇已提前确认",state:true,value:clock(candidate.intersectionEvent?.tx,true)},
    {label:"S1 Px 15M收线确认方向",state:true,value:clock(candidate.confirmationAt,true)},
    {label:"SMC 最近4H目标 · 成本后净R≥2",state:candidate.netR>=2,value:`${fmt(candidate.netR)}R · 执行前重算`},
    {label:"全仓跟进止损 · 不分批减仓",state:true,value:"S1保护阶段与1H/ATR跟进 · SMC目标止盈"},
  ];
  if (candidate.modelRevision === "SMC-LOCAL-ENTRY-2") return [
    { label: "15M 结构确认", state: true, value: candidate.direction === "LONG" ? "多向结构" : "空向结构" },
    { label: "15M 已收线入场证据", state: true, value: clock(candidate.confirmationAt, true) },
    { label: "候选成本后净 R ≥ 2", state: candidate.netR >= 2, value: `${fmt(candidate.netR)}R · 执行前重算` },
    { label: "实时价格与账户保护复核", state: market?.inBand ?? candidate.status === "ENTRY_BAND_ACTIVE", value: "执行器最终校验 · 交汇不参与准入" },
  ];
  if (candidate.modelRevision === "SMC-LOCAL-ENTRY-1") return [
    { label: "15M 局部结构", state: true, value: candidate.direction === "LONG" ? "HL 支撑" : "LH 阻力" },
    { label: "方案形成后的 5M 触区反应", state: true, value: clock(candidate.confirmationAt, true) },
    { label: "候选成本后净 R ≥ 2", state: candidate.netR >= 2, value: `${fmt(candidate.netR)}R · 执行前重算` },
    { label: "实时价格与账户保护复核", state: market?.inBand ?? candidate.status === "ENTRY_BAND_ACTIVE", value: "执行器最终校验 · 交汇不参与准入" },
  ];
  if (candidate.modelRevision === "SMC-TIMED-ENTRY-1") return [
    { label: "预先识别的交汇时间窗口", state: true, value: clock(candidate.intersectionEvent?.tx, true) },
    { label: "15M 局部结构", state: true, value: candidate.direction === "LONG" ? "HL 支撑" : "LH 阻力" },
    { label: "方案形成后的 5M 触区反应", state: true, value: clock(candidate.confirmationAt, true) },
    { label: "候选成本后净 R ≥ 2", state: candidate.netR >= 2, value: `${fmt(candidate.netR)}R · 执行前重算` },
    { label: "实时价格与账户保护复核", state: market?.inBand ?? candidate.status === "ENTRY_BAND_ACTIVE", value: "执行器最终校验" },
  ];
  if (candidate.modelRevision === "SMC-CONTINUATION-2") return [
    { label: "4H 外部趋势仍有效", state: true, value: "大级别保护优先" },
    { label: "1H 回调阶段已核验", state: true, value: "反向背景须有局部恢复证据" },
    { label: "15M 顺势摆动回踩", state: true, value: candidate.direction === "LONG" ? "HL 支撑" : "LH 阻力" },
    { label: "方案形成后的 5M 收线确认", state: true, value: clock(candidate.confirmationAt, true) },
    { label: "候选成本后净 R ≥ 2", state: candidate.netR >= 2, value: `${fmt(candidate.netR)}R · 执行前重算` },
    { label: "实时价格与账户保护复核", state: market?.inBand ?? candidate.status === "ENTRY_BAND_ACTIVE", value: "执行器最终校验" },
  ];
  const confirmation = candidate.entryConfirmation;
  const touched = Boolean(confirmation?.ceTouch) || candidate.status === "ENTRY_BAND_ACTIVE" || Boolean(confirmation?.reversal?.secondBarAt);
  const inBand = market?.inBand ?? ["ENTRY_BAND_ACTIVE", "SECOND_BAR_REVERSE_READY"].includes(candidate.status);
  const liquidityReady = candidate.entryLiquidity?.ready === true;
  const microReady = candidate.entryMicroStructure?.ready === true;
  const confirmationLabel = confirmation?.reversal?.secondBarAt ? "双K反向穿越CE后收线" : confirmation?.ceTouch?.source === "CLOSED_15M_BODY_CROSS"
    ? "顺向实体穿越"
    : confirmation?.ceTouch?.source === "CLOSED_15M_FALSE_BREAK_RECLAIM"
      ? "双 K 假突破收回"
      : "影线测试后收回";
  return [
    { label: `4H 结构有效 · ${candidate.structure.qualityGrade ?? "A/B"}级 ${candidate.structure.nPatternQualified ? "N / BOS" : candidate.structure.eventType}`, state: true, value: `RVOL ${fmt(candidate.structure.volumeRatio)}×` },
    { label: "4H FVG 与结构目标有效", state: true, value: `${price(candidate.zone.low)}–${price(candidate.zone.high)}` },
    { label: "成本后净盈亏比至少 2R", state: candidate.netR >= 2, value: `${candidate.netR.toFixed(2)}R` },
    { label: "15M CE 已触及", state: touched, value: touched ? confirmationLabel : price(candidate.entryBand.ce) },
    { label: "触及后微结构位移", state: microReady, value: microReady ? `${candidate.entryMicroStructure?.barsElapsed ?? "—"} 根后确认` : "最多等待 4 根" },
    { label: "原始 / 稳健价值位置", state: candidate.entryLocation?.ready === true, value: candidate.entryLocation?.ready ? "双区间通过" : "追价位置" },
    { label: "15M 内部流动性处理", state: liquidityReady, value: liquidityReady ? "已清扫 / 无阻挡" : `${candidate.entryLiquidity?.blocking.length ?? 0} 个未清扫摆点` },
    { label: "保护止损位于清扫区外", state: true, value: candidate.entryLiquidity?.stopAdjustedForLiquidity ? "已按摆点外移" : "无需调整" },
    { label: "位移 K 线已收盘", state: confirmation?.closedBarRequired === true && microReady, value: microReady ? "方向位移成立" : "不以 CE 触及直接成交" },
    { label: `${candidate.distanceToEntry?.side ?? "BBO"} 位于有效入场区域`, state: inBand, value: inBand ? "可成交" : "等待" },
  ];
}

/* ---------- small animated primitives ---------- */
function Tween({ value, digits = 2, format }: { value: number | null | undefined; digits?: number; format?: (value: number) => string }) {
  const tweened = useTween(value ?? null);
  return <>{tweened == null ? "—" : format ? format(tweened) : fmt(tweened, digits)}</>;
}

function Ring({ progress, size = 44, stroke = 3, tone = "mint", children }: { progress: number; size?: number; stroke?: number; tone?: "mint" | "amber" | "red" | "white"; children?: React.ReactNode }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return <span className={styles.ring} data-tone={tone} style={{ width: size, height: size }}>
    <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} className={styles.ringTrack} />
      <circle cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} className={styles.ringValue} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - clamped)} />
    </svg>
    {children != null && <span className={styles.ringLabel}>{children}</span>}
  </span>;
}

function EquityCurve({ history }: { history: SmcLedger["history"] }) {
  const points = history.filter(row => Number.isFinite(row.equity));
  if (points.length < 2) return <div className={styles.curveEmpty}>权益曲线等待更多账本快照</div>;
  const values = points.map(row => row.equity);
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, 1e-9);
  const coords = values.map((value, index) => [index / (values.length - 1) * 100, 6 + (1 - (value - min) / span) * 88] as const);
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L100,100 L0,100 Z`;
  const rising = values[values.length - 1] >= values[0];
  const key = `${points.length}-${values[values.length - 1]}`;
  const [lastX, lastY] = coords[coords.length - 1];
  return <div className={styles.curve} data-rising={rising}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="smcProCurveFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill="url(#smcProCurveFill)" className={styles.curveArea} key={`a${key}`} />
      <path d={line} pathLength={1} className={styles.curveLine} vectorEffect="non-scaling-stroke" key={`l${key}`} />
    </svg>
    <i className={styles.curveHead} style={{ left: `${lastX}%`, top: `${lastY}%` }} />
    <span className={styles.curveMax}>{fmt(max)}</span><span className={styles.curveMin}>{fmt(min)}</span>
  </div>;
}

type NavSection = "candidates" | "positions";

/* ---------- workspace ---------- */
export default function SmcWorkspace() {
  const [feed, setFeed] = useState<Feed>({ scan: null, scanFailed: false, jev: null, ledger: null, monitorFailed: false, ledgerFailed: false });
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [lastPoll, setLastPoll] = useState(0);
  const [now, setNow] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<NavSection>("candidates");
  const [pulse, setPulse] = useState(0);
  const [liveQuotes, setLiveQuotes] = useState<LiveQuoteSnapshot | null>(null);
  const [liveQuotesFailed, setLiveQuotesFailed] = useState(false);
  const [watchlistPickerOpen, setWatchlistPickerOpen] = useState(false);
  const [localPlanTerminals, setLocalPlanTerminals] = useState<Record<string, PlanTerminal>>({});
  const [scanSymbol, setScanSymbol] = useState<string | null>(null);
  const [manualCandidate, setManualCandidate] = useState<ManualOrderContext | null>(null);
  const [manualCandidates, setManualCandidates] = useState<ManualCandidate[]>([]);
  const [dismissedConditionalPlanKeys, setDismissedConditionalPlanKeys] = useState<string[]>([]);
  const [manualCandidateError, setManualCandidateError] = useState("");
  const [manualCandidateNotice, setManualCandidateNotice] = useState("");
  const [autoDirectionPending, setAutoDirectionPending] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const frozenHeadRef = useRef<HTMLDivElement>(null);
  const closeManualOrder = useCallback(() => setManualCandidate(null), []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (window.localStorage.getItem("smc-monitor-theme") === "light") setTheme("light"); });
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggleTheme = () => setTheme(current => {
    const next = current === "dark" ? "light" : "dark";
    window.localStorage.setItem("smc-monitor-theme", next);
    return next;
  });
  const failuresRef = useRef(0);
  const scanRef = useRef<Feed["scan"]>(null);

  // polling — same endpoints and cadence as /s2/smc; no new API, writer or credential
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const request = async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("SNAPSHOT_UNAVAILABLE");
      return response.json();
    };
    const poll = async () => {
      const [scan, jev, smc, monitor, execution, ownerPicks] = await Promise.allSettled([request("/api/smc-opportunities"), request("/api/smc-jev"), request("/api/smc-execution-ledger"), request("/api/s2-monitor"), request("/api/s2-execution-ledger"), request("/api/smc-manual-candidates")]);
      if (disposed) return;
      if (scan.status === "fulfilled") scanRef.current = scan.value.snapshot ?? null;
      setFeed(previous => ({
        scan: scan.status === "fulfilled" ? scan.value.snapshot ?? null : previous.scan,
        scanFailed: scan.status !== "fulfilled" || scan.value.status === "STALE",
        jev: jev.status === "fulfilled" ? jev.value.observation ?? null : null,
        ledger: smc.status === "fulfilled" ? smc.value : previous.ledger,
        monitorFailed: monitor.status !== "fulfilled",
        ledgerFailed: execution.status !== "fulfilled",
      }));
      if (ownerPicks.status === "fulfilled" && ownerPicks.value.status === "OK") {
        setManualCandidates(ownerPicks.value.candidates);
        setDismissedConditionalPlanKeys(ownerPicks.value.dismissedConditionalPlanKeys ?? []);
      }
      failuresRef.current = smc.status === "fulfilled" ? 0 : failuresRef.current + 1;
      setLoading(false); setLastPoll(Date.now()); setNow(Date.now());
      timer = setTimeout(poll, Math.min(60000, POLL_MS * 2 ** Math.min(failuresRef.current, 2)));
    };
    void poll();
    const visible = () => { if (!document.hidden) setRefreshKey(value => value + 1); };
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refreshKey]);

  // Price-only lane. Structure discovery remains on its governed 5-minute cycle;
  // this read-only Binance USD-M stream keeps display BBO and distance current without
  // touching order admission, credentials or the single execution writer.
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 1000;
    const rows = new Map<string, LiveQuoteSnapshot["quotes"][number]>();
    const streams = policy.universe.map(symbol => `${symbol.toLowerCase()}@bookTicker`).join("/");

    const publish = () => {
      const timestamp = Date.now();
      const quotes = [...rows.values()].filter(row => timestamp - row.quoteAt <= QUOTE_STALE_MS);
      if (!quotes.length) { setLiveQuotesFailed(true); return; }
      const crossed = (scanRef.current?.results ?? []).flatMap(result => [...(result.structurePlans ?? []), ...result.candidates.map(p => ({ ...p, availableAt: p.observedAt }))].flatMap(plan => {
        const event = planPriceEvent(plan, { quote: quotes.find(q => q.symbol === plan.symbol), now: timestamp });
        return event ? [{ plan, terminal: event } as PlanTerminal] : [];
      }));
      if (crossed.length) setLocalPlanTerminals(old => ({ ...old, ...Object.fromEntries(crossed.map(r => [planFamilyKey(r.plan), r])) }));
      setLiveQuotes({
        schema: "SMC_LIVE_QUOTES_V1",
        source: "BINANCE_USDM_BOOK_TICKER",
        observedAt: new Date(Math.max(...quotes.map(row => row.quoteAt))).toISOString(),
        quotes,
      });
      setLiveQuotesFailed(false);
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(`wss://fstream.binancefuture.com/stream?streams=${streams}`);
      socket.onopen = () => { retryMs = 1000; };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          const row = message?.data ?? message;
          const symbol = typeof row?.s === "string" && policy.universe.includes(row.s) ? row.s : null;
          const bid = Number(row?.b), ask = Number(row?.a), quoteAt = Number(row?.E ?? row?.T);
          const timestamp = Date.now();
          if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid
            || !Number.isSafeInteger(quoteAt) || quoteAt > timestamp + 5000 || timestamp - quoteAt > QUOTE_STALE_MS) return;
          rows.set(symbol, { symbol, bid, ask, quoteAt });
          if (!disposed) publish();
        } catch { /* malformed upstream rows are ignored and never presented as live */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setLiveQuotesFailed(true);
        reconnectTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(QUOTE_RECONNECT_MAX_MS, retryMs * 2);
      };
    };

    connect();
    const staleTimer = setInterval(publish, 2000);
    return () => {
      disposed = true;
      clearInterval(staleTimer);
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [refreshKey]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, []);

  // Scroll progress, frozen-head geometry and active nav section.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progressRef.current?.style.setProperty("--progress", String(max > 0 ? window.scrollY / max : 0));
        const frozenHeight = frozenHeadRef.current?.getBoundingClientRect().height ?? 0;
        stageRef.current?.style.setProperty("--frozen-height", `${Math.ceil(frozenHeight)}px`);
        const ledgerTop = document.getElementById("smc-ledger")?.getBoundingClientRect().top ?? Infinity;
        setActiveSection(ledgerTop <= window.innerHeight * .58 ? "positions" : "candidates");
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (frozenHeadRef.current) observer?.observe(frozenHeadRef.current);
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);

  /* ---------- derived state (same rules as /s2/smc) ---------- */
  const { scan, jev, ledger } = feed;
  const ageWithin = (value: string | null | undefined, limit: number) => { const age = now - Date.parse(value ?? ""); return now > 0 && age >= -5000 && age <= limit; };
  const scanFresh = !feed.scanFailed && ageWithin(scan?.sourceAsOf, policy.snapshotStaleAfterMs);
  const account = ledger?.snapshot?.account;
  const execution = ledger?.snapshot?.execution;
  const accountFresh = ledger?.status === "OK" && !!account?.fresh && ageWithin(account?.observedAt, 120000);
  const orderCount = (account?.orders ?? 0) + (account?.algoOrders ?? 0);
  const positions = ledger?.snapshot?.positions ?? [];
  const pendingEntries = ledger?.snapshot?.pendingEntries ?? [];
  const fills = ledger?.snapshot?.fills ?? [];
  const reservedRisk = positions.reduce((sum, row) => sum + row.initialRiskUsdt, 0)
    + pendingEntries.reduce((sum, row) => sum + row.initialRiskUsdt, 0);
  const reservedRiskPercent = account?.equity && account.equity > 0 ? reservedRisk / account.equity * 100 : 0;
  const riskPolicy = execution?.strategyRuntime?.riskPolicy ?? null;
  const portfolioCap = Number(riskPolicy?.portfolioFraction ?? .1) * 100;
  const maxPositions = Number(riskPolicy?.maximumOpenPositions ?? 4);
  const liveReady = execution?.liveReady === true;
  const entriesAllowed = execution?.entriesAllowed === true;
  const manualEntriesEnabled = execution?.manualEntriesEnabled === true;

  const quoteMap = useMemo(() => new Map((liveQuotes?.quotes ?? []).map(row => [row.symbol, row])), [liveQuotes]);
  const positionPnls = positionsUnrealizedPnl(positions, quoteMap, now, QUOTE_STALE_MS, accountFresh);
  const marketFor = (candidate: Opportunity): MarketView => {
    const quote = quoteMap.get(candidate.symbol);
    const quoteFresh = !!quote && now - quote.quoteAt >= -5000 && now - quote.quoteAt <= QUOTE_STALE_MS;
    const side = candidate.direction === "LONG" ? "ASK" : "BID";
    const livePrice = quoteFresh ? (side === "ASK" ? quote!.ask : quote!.bid) : null;
    const fallback = candidate.distanceToEntry;
    const executablePrice = livePrice ?? fallback?.executablePrice ?? candidate.referenceEntry;
    const absolute = executablePrice < candidate.entryBand.low ? candidate.entryBand.low - executablePrice : executablePrice > candidate.entryBand.high ? executablePrice - candidate.entryBand.high : 0;
    const percent = executablePrice > 0 ? absolute / executablePrice * 100 : 0;
    const signedPercent = signedEntryBandDistance(executablePrice, candidate.direction, candidate.entryBand)?.percent ?? percent;
    const reversalClose = candidate.entryConfirmation?.reversal?.secondClose;
    const reversalAdmissible = livePrice != null && typeof reversalClose === "number" && candidate.status !== "WAIT_SECOND_BAR_CE_REVERSAL" && (candidate.direction === "LONG" ? executablePrice > candidate.entryBand.ce : executablePrice < candidate.entryBand.ce) && Math.abs(executablePrice - reversalClose) / reversalClose <= 0.005;
    return { price: executablePrice, absolute, percent, signedPercent, quoteAt: livePrice != null ? quote!.quoteAt : fallback?.quoteAt ?? candidate.observedAt, side, inBand: reversalClose == null ? executablePrice >= candidate.entryBand.low && executablePrice <= candidate.entryBand.high : reversalAdmissible, live: livePrice != null };
  };
  const manualKeys = new Set(manualCandidates.map(row => `${row.symbol}:${row.direction}`));
  const candidates = (scan?.candidates ?? []).filter(row => row.expiresAt > now
    && !localPlanTerminals[planFamilyKey(row)] && !planPriceEvent({ ...row, availableAt: row.observedAt }, { quote: quoteMap.get(row.symbol), now })
    && (row.candidateSource !== "OWNER_SELECTED" || manualKeys.has(`${row.symbol}:${row.direction}`))).sort((a, b) => {
    const am = marketFor(a), bm = marketFor(b);
    return Number(bm.inBand) - Number(am.inBand) || am.percent - bm.percent;
  });
  const ownerExecutableCandidates = candidates.filter(row => manualKeys.has(`${row.symbol}:${row.direction}`));
  const automaticCandidates = candidates.filter(row => !manualKeys.has(`${row.symbol}:${row.direction}`));
  const pendingManualCandidates = manualCandidates.filter(row => !candidates.some(candidate =>
    candidate.symbol === row.symbol && candidate.direction === row.direction));
  const rawStructurePlans = (scan?.results ?? []).flatMap(row => row.structurePlans ?? []).filter(row => row.expiresAt > now);
  const structurePlans = rawStructurePlans.filter(p => !localPlanTerminals[planFamilyKey(p)] && !planPriceEvent(p, { quote: quoteMap.get(p.symbol), now }));
  const conditionalInvalidations = [...Object.values(localPlanTerminals), ...(scan?.results ?? []).flatMap(r => r.planTerminals ?? [])]
    .filter((r,i,all) => now - r.terminal.at <= 86400000 && all.findIndex(x => planFamilyKey(x.plan) === planFamilyKey(r.plan)) === i)
    .map(r => ({ id: r.plan.id, symbol: r.plan.symbol, direction: r.plan.direction, invalidatedAt: r.terminal.at, reason: r.terminal.reason,
      entryBand: r.plan.zone ?? { low: r.plan.entry, high: r.plan.entry }, level: r.plan.target, observed: r.terminal.price, timeframe: 'SYSTEM', stop: r.plan.stop, target: r.plan.target, consumedConditional: true }));
  const recentInvalidations = [...(scan?.recentInvalidations ?? []).map(r => ({ ...r, consumedConditional: false })), ...conditionalInvalidations]
    .sort((a,b) => b.invalidatedAt - a.invalidatedAt).slice(0, 6);
  const planFor = (row: Pick<ManualCandidate, "symbol" | "direction">) => structurePlans.find(p => p.symbol === row.symbol && p.direction === row.direction) ?? null;
  const contextFor = (symbol: string) => scan?.results.find(row => row.symbol === symbol)?.structureContext;
  const planningCandidates: ManualCandidate[] = (scan?.results ?? []).flatMap(result => {
    const choices = visibleLinkedPlans(structurePlans.filter(p => p.symbol === result.symbol), result.structureContext,
      { manual: manualCandidates, executable: candidates, dismissedPlanKeys: dismissedConditionalPlanKeys, now });
    return choices.map((plan: typeof structurePlans[number]) => ({ symbol: plan.symbol, direction: plan.direction,
      createdAt: plan.observedAt, autoTradingEnabled: false, planningOnly: true }));
  });
  const primaryPlanIds = new Set((scan?.results ?? []).flatMap(result => {
    if (candidates.some(row => row.symbol === result.symbol)) return [];
    const plans = structurePlans.filter(p => p.symbol === result.symbol && planningCandidates.some(row => row.symbol === p.symbol && row.direction === p.direction));
    const primary = primaryLinkedPlan(plans, result.structureContext, now);
    return primary ? [ownerSelectionId(primary)] : [];
  }));
  const primaryPlanningCandidates = planningCandidates.filter(row => primaryPlanIds.has(ownerSelectionId(row)));
  const secondaryPlanningCandidates = planningCandidates.filter(row => !primaryPlanIds.has(ownerSelectionId(row)));
  const defaultObservationCandidates = [...pendingManualCandidates, ...primaryPlanningCandidates, ...secondaryPlanningCandidates];
  const observationCandidates = [...pendingManualCandidates, ...planningCandidates];
  const selectedOwner = observationCandidates.find(row => ownerSelectionId(row) === selectedId)
    ?? (selectedId == null && !candidates.length ? defaultObservationCandidates[0] ?? null : null);
  const selected = selectedOwner ? null : candidates.find(row => row.id === selectedId || ownerSelectionId(row) === selectedId) ?? candidates[0] ?? null;
  const structures = (scan?.results ?? []).flatMap(result => result.structures ?? []).filter(row => row.admission === "PLAN_ELIGIBLE");
  const selectedMarket = selected ? marketFor(selected) : null;
  const conditions = selected ? conditionRows(selected, selectedMarket) : [];
  const passed = conditions.filter(row => row.state).length;
  const pending = conditions.filter(row => !row.state);
  const jevCandidate = jev?.candidates.find(row => row.id === selected?.id) ?? null;
  const jevAssessment = jevCandidate?.assessment ?? null;
  const jevVerdict = jevAssessment?.verdict ?? (jevCandidate?.probability == null ? "数据不足" : jevCandidate.probability >= .6 ? "YES" : jevCandidate.probability <= .4 ? "NO" : "观望");
  const jevState = jevAssessment ? ({ TRIGGER_CONFIRMED: "触发已确认", MICRO_STRUCTURE_PENDING: "等待微结构位移", VALUE_LOCATION_PENDING: "等待价值位置", COMPRESSION_PENDING: "等待摆脱压缩", LIQUIDITY_SWEEP_PENDING: "等待流动性清扫", FALSE_BREAK_WATCH: "假突破观察", NEAR_TRIGGER: "接近触发", APPROACHING: "等待接近" } as const)[jevAssessment.marketState] : null;
  const rejectionTotals = Object.entries((scan?.results ?? []).reduce<Record<string, number>>((total, result) => { for (const [key, value] of Object.entries(result.rejected ?? {})) total[key] = (total[key] ?? 0) + value; return total; }, {})).sort((a, b) => b[1] - a[1]);
  const decision = !scanFresh || !accountFresh ? "数据冻结" : !liveReady || !entriesAllowed ? "禁止开仓"
    : selected && ["ENTRY_BAND_ACTIVE", "SECOND_BAR_REVERSE_READY"].includes(selected.status)
      && selected.entryLiquidity?.ready === true && selectedMarket?.inBand
      && (Boolean(selected.entryConfirmation?.ceTouch) || Boolean(selected.entryConfirmation?.reversal?.secondBarAt))
      ? "进入下单预检" : "等待触发";
  const decisionTone = decision === "进入下单预检" ? "go" : decision === "等待触发" ? "wait" : "stop";
  const universe = scan?.universe?.length ? scan.universe : policy.universe;
  const scanSelection = scanSymbol ? scan?.results?.find(row => row.symbol === scanSymbol) : null;
  const scanSelectionError = scanSymbol ? scan?.errors?.find(row => row.symbol === scanSymbol) : null;
  const scanSelectionCandidate = scanSymbol ? candidates.find(row => row.symbol === scanSymbol) : null;
  const manualQuoteRow = manualCandidate ? quoteMap.get(manualCandidate.symbol) : null;
  const priceRuleMap = new Map((ledger?.snapshot?.priceRules ?? []).map(row => [row.symbol, row.tickSize]));
  const manualQuote = manualCandidate && manualQuoteRow ? {
    price: manualCandidate.direction === "LONG" ? manualQuoteRow.ask : manualQuoteRow.bid,
    quoteAt: manualQuoteRow.quoteAt, live: now - manualQuoteRow.quoteAt <= QUOTE_STALE_MS,
  } : null;
  const openActiveOrder = (row: Opportunity) => {
    const source = manualOrderSourceForCandidate({ candidateId: row.id, symbol: row.symbol, direction: row.direction,
      ownedByCurrentUser: manualKeys.has(`${row.symbol}:${row.direction}`) });
    setManualCandidate({ symbol: row.symbol, direction: row.direction,
      source: source.source, sourceId: source.sourceId, referenceEntry: row.referenceEntry,
      stop: row.stop, target: row.target!,
      detail: `${row.structure.qualityGrade ?? "A/B"} 级 ${row.structure.eventType} · 候选计划` });
  };
  const addManualCandidate = async (symbol: string, direction: Direction) => {
    setManualCandidateError(""); setManualCandidateNotice("");
    try {
      const response = await fetch("/api/smc-manual-candidates", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, direction }) });
      if (!response.ok) throw new Error("保存失败");
      setDismissedConditionalPlanKeys(rows => rows.filter(item => !item.startsWith(`${symbol}:`)));
      setManualCandidates(rows => rows.some(row => row.symbol === symbol && row.direction === direction) ? rows
        : [{ symbol, direction, createdAt: Date.now(), autoTradingEnabled: true, selectionMode: "MANUAL" }, ...rows]);
    } catch { setManualCandidateError("手动候选保存失败，请重试"); }
  };
  const addAutomaticCandidate = async (symbol: string) => {
    setManualCandidateError(""); setManualCandidateNotice(""); setAutoDirectionPending(symbol);
    try {
      const response = await fetch("/api/smc-manual-candidates", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, direction: "AUTO" }) });
      const result = await response.json() as { direction?: Direction; selectionReason?: string | null; reason?: string };
      if (!response.ok || !result.direction) {
        const labels: Record<string, string> = {
          SMC_AUTO_DIRECTION_NO_VALID_STRUCTURE: "暂无可用于判向的有效结构",
          SMC_AUTO_DIRECTION_NO_EXECUTABLE_PLAN: "当前没有完成完整准入的策略方向",
          SMC_AUTO_DIRECTION_CONFLICTING_STRUCTURES: "多空结构接近，暂不代判",
          SMC_AUTO_DIRECTION_CONFLICTING_ACTIVE_PLANS: "多空候选冲突，暂不代判",
          SMC_AUTO_DIRECTION_SCAN_MISSING: "等待生产扫描快照",
        };
        throw new Error(labels[result.reason ?? ""] ?? "自动判向暂不可用");
      }
      setDismissedConditionalPlanKeys(rows => rows.filter(item => !item.startsWith(`${symbol}:`)));
      const row: ManualCandidate = { symbol, direction: result.direction, createdAt: Date.now(), autoTradingEnabled: true,
        selectionMode: "AUTO", selectionReason: result.selectionReason ?? null };
      setManualCandidates(rows => rows.some(item => item.symbol === symbol && item.direction === result.direction) ? rows : [row, ...rows]);
      setManualCandidateNotice(`系统判定 · ${result.direction === "LONG" ? "做多" : "做空"}${result.selectionReason ? ` · ${result.selectionReason}` : ""}`);
    } catch (error) { setManualCandidateError(error instanceof Error ? error.message : "自动判向暂不可用"); }
    finally { setAutoDirectionPending(null); }
  };
  const removeManualCandidate = async (symbol: string, direction: Direction) => {
    const plan = structurePlans.find(p => p.symbol===symbol && p.direction===direction);
    const planKey = plan ? planFamilyKey(plan) : null;
    try {
      const response = await fetch("/api/smc-manual-candidates", { method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, direction, dismissConditionalPlans: true, planKey }) });
      if (!response.ok) throw new Error("REMOVE_FAILED");
      if(planKey) setDismissedConditionalPlanKeys(rows => rows.includes(planKey) ? rows : [...rows, planKey]);
      setManualCandidate(current => current?.symbol === symbol && current.direction === direction ? null : current);
      setManualCandidates(rows => rows.filter(row => row.symbol !== symbol || row.direction !== direction));
      setSelectedId(current => current === `owner:${symbol}:${direction}` ? null : current);
    } catch { setManualCandidateError("移除失败，请重试"); }
  };
  const toggleOwnerAutoTrading = async (row: ManualCandidate) => {
    setManualCandidateError("");
    const enabled = !row.autoTradingEnabled;
    try {
      const response = await fetch("/api/smc-manual-candidates", { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: row.symbol, direction: row.direction, autoTradingEnabled: enabled }) });
      if (!response.ok) throw new Error("TOGGLE_FAILED");
      setManualCandidates(rows => rows.map(candidate => candidate.symbol === row.symbol && candidate.direction === row.direction
        ? { ...candidate, autoTradingEnabled: enabled } : candidate));
    } catch { setManualCandidateError("自动交易状态更新失败，请重试"); }
  };
  const openManualPick = (row: ManualCandidate) => {
    const proposal = planFor(row);
    if (row.planningOnly && (!scanFresh || !proposal)) return;
    const priceNow = quoteMap.get(row.symbol);
    const executable = row.direction === "LONG" ? priceNow?.ask : priceNow?.bid;
    setManualCandidate({ symbol: row.symbol, direction: row.direction, source: "MANUAL_CANDIDATE",
      sourceId: row.planningOnly ? proposal!.id : `${row.symbol}-${row.direction}`, referenceEntry: proposal?.entry ?? executable ?? 0,
      stop: proposal?.stop ?? 0, target: planRiskView(proposal, scanFresh).manualTarget,
      preferredOrderMode: row.planningOnly ? "LIMIT_GTC" : undefined,
      plannedZone: proposal?.zone,
      detail: proposal ? "当前15M摆动条件方案 · 所有者手动预检" : "尚无当前结构方案" });
  };
  const selectOwnerCandidate = (row: ManualCandidate) => {
    const id = ownerSelectionId(row);
    if (id !== selectedId) { setSelectedId(id); setPulse(value => value + 1); }
  };
  const renderObservationCandidate = (row: ManualCandidate, index: number) => {
              const currentPlan = planFor(row);
              const quote = quoteMap.get(row.symbol);
              const q = row.direction === "LONG" ? quote?.ask : quote?.bid;
              const distance = currentPlan && q && quote && now - quote.quoteAt <= QUOTE_STALE_MS
                ? Math.max(currentPlan.zone.low - q, q - currentPlan.zone.high, 0) / q * 100 : null;
              const remotePlan = !!(currentPlan && q && distance != null && currentPlan.entryReview?.atr15m && Math.max(currentPlan.zone.low-q,q-currentPlan.zone.high,0)>2*currentPlan.entryReview.atr15m);
              const closeness = Math.max(0, 1 - (distance ?? 3) / 3);
              const riskView = planRiskView(currentPlan, scanFresh);
              const protectionReady = riskView.protectionReady;
              const stageCount = currentPlan ? 2 + Number(protectionReady) + Number(protectionReady && (riskView.netR ?? 0) >= 2) + Number(!currentPlan.conflicts.length && !currentPlan.opportunity?.localConflict && currentPlan.opportunity?.unknownFrames.length === 0) : 1;
              return <li key={`owner-${row.symbol}-${row.direction}`} className={styles.manualCandidateItem} style={{ "--i": index } as CSSProperties}>
                <button type="button" className={`${styles.candidate} ${styles.manualCandidate}`} data-active={ownerSelectionId(row) === selectedId} onPointerMove={spotlight} aria-pressed={ownerSelectionId(row) === selectedId} aria-label={`${row.planningOnly ? "条件候选" : "自选候选"} ${row.symbol} ${row.direction === "LONG" ? "做多" : "做空"}，查看候选详情`} onClick={() => selectOwnerCandidate(row)}>
                  <Ring progress={stageCount / 6} size={40} stroke={3} tone="white">{row.symbol.slice(0, 1)}</Ring>
                  <span className={styles.candidateCopy}>
                    <span><strong>{row.symbol.replace("USDT", "")}<small>/USDT</small></strong><em data-dir={row.direction}>{row.direction === "LONG" ? "做多" : "做空"}</em><em className={styles.ownerTag}>{row.planningOnly ? "条件" : "自选"}</em></span>
                    <small>{currentPlan ? !protectionReady ? planProtectionLabel(currentPlan) : riskView.pathNote ?? ((riskView.netR ?? 0) < 2 ? "回报不足 · 仅观察" : remotePlan ? (row.direction === "SHORT" ? "远端计划 · 等待反弹" : "远端计划 · 等待回落") : "等待入场确认") : "等待结构方案"}</small>
                    <i className={styles.closeness}><span style={{ transform: `scaleX(${closeness})` }} /></i>
                  </span>
                  <span className={styles.candidateNums}><strong>{distance == null ? "—" : `${distance.toFixed(2)}%`}</strong><small>{!protectionReady ? "净R待核算" : riskView.netR == null ? "路径待确认" : `${riskView.netR.toFixed(2)} 计划净R`}</small></span>
                </button>
                <span className={`${styles.ownerControls} ${styles.ownerControlsFloat}`}>
                  <button type="button" disabled={row.planningOnly && (!scanFresh || !currentPlan)} className={styles.ownerManualOrder} aria-label={`手动下单 ${row.symbol} ${row.direction === "LONG" ? "做多" : "做空"}`} title="手动下单" onClick={() => openManualPick(row)}><span aria-hidden="true">↗</span></button>
                  {!row.planningOnly && <button type="button" className={styles.ownerAutoToggle} data-active={row.autoTradingEnabled} aria-label={row.autoTradingEnabled ? "关闭该自选候选自动交易" : "开启该自选候选自动交易"} aria-pressed={row.autoTradingEnabled} title={row.autoTradingEnabled ? "自动交易已开启" : "自动交易已关闭"} onClick={() => { void toggleOwnerAutoTrading(row); }}><span aria-hidden="true">ϟ</span></button>}
                  <button type="button" className={styles.manualRemove} aria-label={`移除 ${row.symbol} ${row.direction === "LONG" ? "做多" : "做空"}${row.planningOnly ? "条件方案" : "自选候选"}`} title="移出候选" onClick={() => { void removeManualCandidate(row.symbol, row.direction); }}><span aria-hidden="true">×</span></button>
                </span>
              </li>;
  };
  const renderExecutableCandidate = (candidate: Opportunity, index: number) => {
              const market = marketFor(candidate);
              const rows = conditionRows(candidate, market);
              const ok = rows.filter(row => row.state).length;
              const active = candidate.id === selected?.id;
              const ownerSelected = candidate.candidateSource === "OWNER_SELECTED" || manualKeys.has(`${candidate.symbol}:${candidate.direction}`);
              const ownerControl = ownerSelected ? manualCandidates.find(row => row.symbol === candidate.symbol && row.direction === candidate.direction) : null;
              const closeness = Math.max(0, 1 - market.percent / 3);
              return <li key={candidate.id} className={ownerSelected ? styles.manualCandidateItem : undefined} style={{ "--i": pendingManualCandidates.length + index } as CSSProperties}>
                <button type="button" className={`${styles.candidate} ${ownerSelected ? styles.manualCandidate : ""}`} data-active={active} data-hot={market.inBand} onPointerMove={spotlight} aria-pressed={active} aria-label={`${candidate.symbol} ${candidate.direction === "LONG" ? "做多" : "做空"}，查看候选详情`} onClick={() => selectCandidate(candidate.id)}>
                  <Ring progress={ok / rows.length} size={40} stroke={3} tone={market.inBand ? "mint" : "white"}>{candidate.symbol.slice(0, 1)}</Ring>
                  <span className={styles.candidateCopy}>
                    <span><strong>{candidate.symbol.replace("USDT", "")}<small>/USDT</small></strong><em data-dir={candidate.direction}>{candidate.direction === "LONG" ? "做多" : "做空"}</em>{ownerSelected && <em className={styles.ownerTag}>自选</em>}</span>
                    <small>{market.inBand && (candidate.entryConfirmation?.ceTouch || candidate.entryConfirmation?.reversal?.secondBarAt) ? "实时盘口处于有效入场区域" : candidate.modelRevision === "SMC-S1-PX-1" ? "SMC交汇 · Px收线已确认" : ["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1"].includes(candidate.modelRevision ?? "") ? "结构与K线已确认" : candidate.modelRevision === "SMC-TIMED-ENTRY-1" ? "历史交汇模型" : candidate.modelRevision === "SMC-CONTINUATION-2" ? "顺势回踩 · 等待实时执行复核" : waitingStatus[candidate.status] ?? candidate.status}</small>
                    <i className={styles.closeness}><span style={{ transform: `scaleX(${closeness})` }} /></i>
                  </span>
                  <span className={styles.candidateNums}><strong>{formatSignedEntryPercent(market.signedPercent)}</strong><small>{candidate.netR.toFixed(1)} 净R</small></span>
                </button>
                {ownerControl && <span className={`${styles.ownerControls} ${styles.ownerControlsFloat}`}>
                  <button type="button" className={styles.ownerManualOrder} aria-label={`手动下单 ${candidate.symbol} ${candidate.direction === "LONG" ? "做多" : "做空"}`} title="手动下单" onClick={() => openActiveOrder(candidate)}><span aria-hidden="true">↗</span></button>
                  <button type="button" className={styles.ownerAutoToggle} data-active={ownerControl.autoTradingEnabled} aria-label={ownerControl.autoTradingEnabled ? "关闭该自选候选自动交易" : "开启该自选候选自动交易"} aria-pressed={ownerControl.autoTradingEnabled} title={ownerControl.autoTradingEnabled ? "自动交易已开启" : "自动交易已关闭"} onClick={() => { void toggleOwnerAutoTrading(ownerControl); }}><span aria-hidden="true">ϟ</span></button>
                  <button type="button" className={styles.manualRemove} aria-label={`取消 ${candidate.symbol} ${candidate.direction === "LONG" ? "做多" : "做空"}自选候选`} title="移出候选" onClick={() => { void removeManualCandidate(candidate.symbol, candidate.direction); }}><span aria-hidden="true">×</span></button>
                </span>}
              </li>;
  };

  const currentPrice = selectedMarket?.price ?? null;
  const selectedOwnerPlan = selectedOwner ? planFor(selectedOwner) : null;
  const selectedOwnerLink = linkedStructure(selectedOwner ? contextFor(selectedOwner.symbol) : undefined, now);
  const selectedOwnerRelation = selectedOwner ? linkedPlanLabel(contextFor(selectedOwner.symbol), selectedOwner.direction, now, selectedOwnerPlan) : "方向未定";
  const selectedOwnerZone: ManualZone | null = selectedOwnerPlan ? { ...selectedOwnerPlan.zone,
    id: selectedOwnerPlan.id, direction: selectedOwnerPlan.direction, availableAt: selectedOwnerPlan.anchor.confirmedAt,
    touches: 0, lastTouchAt: null, distancePercent: 0, ageDays: 0, orderAuthority: false } : null;
  const selectedOwnerQuoteRow = selectedOwner ? quoteMap.get(selectedOwner.symbol) : null;
  const selectedOwnerQuoteFresh = !!selectedOwnerQuoteRow && now - selectedOwnerQuoteRow.quoteAt >= -5000 && now - selectedOwnerQuoteRow.quoteAt <= QUOTE_STALE_MS;
  const selectedOwnerDistance = selectedOwnerPlan && selectedOwnerQuoteFresh && selectedOwnerQuoteRow ? (() => {
    const q = selectedOwner?.direction === "LONG" ? selectedOwnerQuoteRow.ask : selectedOwnerQuoteRow.bid;
    return Math.max(selectedOwnerPlan.zone.low - q, q - selectedOwnerPlan.zone.high, 0) / q * 100;
  })() : null;
  const selectedOwnerSide = selectedOwner?.direction === "LONG" ? "ASK" : "BID";
  const selectedOwnerPrice = selectedOwnerQuoteFresh && selectedOwnerQuoteRow
    ? (selectedOwnerSide === "ASK" ? selectedOwnerQuoteRow.ask : selectedOwnerQuoteRow.bid)
    : selectedOwnerZone?.ce ?? null;
  const ownerIntersection = buildIntersectionView({
    clock: scan?.results.find(row => row.symbol === selectedOwner?.symbol)?.intersectionClock,
    scanFresh, now, quotePrice: selectedOwnerPrice, quoteFresh: selectedOwnerQuoteFresh,
  });
  const candidateIntersection = buildIntersectionView({
    clock: scan?.results.find(row => row.symbol === selected?.symbol)?.intersectionClock,
    candidateEvent: selected?.intersectionEvent, scanFresh, now,
    quotePrice: currentPrice, quoteFresh: selectedMarket?.live === true,
  });
  const selectedOwnerRisk = planRiskView(selectedOwnerPlan, scanFresh);
  const selectedOwnerProtectionReady = selectedOwnerRisk.protectionReady;
  const selectedOwnerImmediate = selectedOwnerPlan && selectedOwnerQuoteFresh && selectedOwnerPrice != null && selectedOwnerPlan.tickSize
    ? reviewEntryGeometry({ ...selectedOwnerPlan, target: selectedOwnerPlan.targetPathRevision ? selectedOwnerPlan.targetPath?.admissionTarget ?? null : selectedOwnerPlan.target }, selectedOwnerPrice, selectedOwnerPlan.entryReview?.atr15m ?? 0) : null;
  const selectedOwnerImmediateReady = selectedOwnerProtectionReady && selectedOwnerImmediate?.valid && selectedOwnerPrice != null
    && (selectedOwnerPlan!.direction === "LONG" ? selectedOwnerPrice > selectedOwnerPlan!.stopBasis!.point!.price : selectedOwnerPrice < selectedOwnerPlan!.stopBasis!.point!.price);
  const selectedOwnerStages = selectedOwner ? [
    { label: selectedOwner.planningOnly ? "结构可能性已扫描" : "自选方向已同步", value: `${selectedOwner.symbol} · ${selectedOwner.direction}`, state: scanFresh },
    { label: "当前 15M 摆动回踩", value: selectedOwnerPlan ? `确认于 ${clock(selectedOwnerPlan.anchor.confirmedAt)}` : "等待有效摆动", state: !!selectedOwnerPlan },
    { label: "条件入场与结构保护", value: !selectedOwnerPlan ? "未形成" : selectedOwnerProtectionReady ? `${price(selectedOwnerPlan.entry)} / ${price(selectedOwnerPlan.stop)}` : `${planProtectionLabel(selectedOwnerPlan)} · 暂估 ${price(selectedOwnerPlan.stop)}`, state: selectedOwnerProtectionReady },
    { label: "结构目标与成本后净R", value: !selectedOwnerProtectionReady ? "先确认保护依据，再核算净R" : selectedOwnerRisk.netR != null ? `${price(selectedOwnerRisk.target)} · ${selectedOwnerRisk.netR.toFixed(2)}R` : selectedOwnerRisk.pathNote ?? "等待未扫目标", state: selectedOwnerProtectionReady && (selectedOwnerRisk.netR ?? 0) >= 2 },
    { label: "多周期方向", value: selectedOwnerPlan?.conflicts.length ? `冲突 ${selectedOwnerPlan.conflicts.join(" / ")}` : "背景与触发仍需联合确认", state: !!selectedOwnerPlan && !selectedOwnerPlan.conflicts.length && !selectedOwnerPlan.opportunity?.localConflict && selectedOwnerPlan.opportunity?.unknownFrames.length === 0 },
    { label: "模型确认与执行复核", value: "SMC交汇→S1 Px收线确认；SMC最近4H目标；全仓跟进止损、不分批减仓；实时净2R、Tick/BBO与风控复核", state: false },
  ] : [];
  const selectedOwnerPassed = selectedOwnerStages.filter(row => row.state).length;
  const selectedIsOwner = !!selected && (selected.candidateSource === "OWNER_SELECTED" || manualKeys.has(`${selected.symbol}:${selected.direction}`));

  const selectCandidate = (id: string) => { if (id !== selected?.id) { setSelectedId(id); setPulse(value => value + 1); } };
  const inspectSymbol = (symbol: string) => {
    setScanSymbol(symbol);
    const candidate = candidates.find(row => row.symbol === symbol);
    if (candidate) selectCandidate(candidate.id);
    setRefreshKey(value => value + 1);
  };

  /* ---------- price ladder geometry ---------- */
  const ladder = selected && currentPrice != null ? (() => {
    const values = [selected.stop, selected.target, selected.referenceEntry, selected.zone.low, selected.zone.high, selected.entryBand.low, selected.entryBand.high, selected.entryBand.ce, currentPrice];
    const floor = Math.min(...values), ceiling = Math.max(...values);
    const span = Math.max(ceiling - floor, Math.abs(currentPrice) * .002, Number.EPSILON);
    const y = (value: number) => Math.min(92, Math.max(8, (ceiling - value) / span * 84 + 8));
    const band = (a: number, b: number, min: number) => { const top = Math.min(y(a), y(b)); return { top: `${top}%`, height: `${Math.max(Math.abs(y(a) - y(b)), min)}%` }; };
    // lines stay at true price; labels are nudged apart so dense levels stay readable
    const raw = { target: y(selected.target), ce: y(selected.entryBand.ce), stop: y(selected.stop), live: y(currentPrice) };
    const order = (Object.keys(raw) as Array<keyof typeof raw>).sort((a, b) => raw[a] - raw[b]);
    const labels = { ...raw };
    const gap = 6.2;
    for (let pass = 0; pass < 4; pass++) {
      for (let index = 1; index < order.length; index++) {
        const above = order[index - 1], below = order[index];
        if (labels[below] - labels[above] < gap) { const push = (gap - (labels[below] - labels[above])) / 2; labels[above] -= push; labels[below] += push; }
      }
      const shift = Math.max(0, 5 - labels[order[0]]) - Math.max(0, labels[order[order.length - 1]] - 96);
      for (const key of order) labels[key] += shift;
    }
    const offset = (key: keyof typeof raw) => `${(labels[key] - raw[key]).toFixed(2)}`;
    return {
      offset,
      target: y(selected.target), stop: y(selected.stop), trigger: y(selected.entryBand.trigger), ce: y(selected.entryBand.ce), current: y(currentPrice), entry: y(selected.referenceEntry),
      zone: band(selected.zone.low, selected.zone.high, 2.4), band: band(selected.entryBand.low, selected.entryBand.high, 2),
      reward: band(selected.referenceEntry, selected.target, 0), risk: band(selected.referenceEntry, selected.stop, 0),
    };
  })() : null;

  const ownerLadder = selectedOwner && selectedOwnerZone && selectedOwnerPrice != null ? (() => {
    const low = selectedOwnerZone.low, high = selectedOwnerZone.high, ce = selectedOwnerZone.ce;
    const directionalLow = low;
    const directionalHigh = high;
    const values = [low, high, ce, selectedOwnerPrice, selectedOwnerPlan!.stop, ...(selectedOwnerRisk.target == null ? [] : [selectedOwnerRisk.target])];
    const rawFloor = Math.min(...values), rawCeiling = Math.max(...values);
    const pad = Math.max((rawCeiling - rawFloor) * .16, Math.abs(selectedOwnerPrice) * .0005, Number.EPSILON);
    const floor = rawFloor - pad, ceiling = rawCeiling + pad;
    const span = Math.max(ceiling - floor, Number.EPSILON);
    const y = (value: number) => Math.min(92, Math.max(8, (ceiling - value) / span * 84 + 8));
    const band = (a: number, b: number, min: number) => { const top = Math.min(y(a), y(b)); return { top: `${top}%`, height: `${Math.max(Math.abs(y(a) - y(b)), min)}%` }; };
    const raw = { ce: y(ce), live: y(selectedOwnerPrice), stop: y(selectedOwnerPlan!.stop), target: y(selectedOwnerRisk.target ?? high) };
    const labels = { ...raw };
    const keys = (Object.keys(raw) as Array<keyof typeof raw>).filter(k => k !== "target" || selectedOwnerRisk.target != null).sort((a, b) => raw[a] - raw[b]);
    for (let i = 1; i < keys.length; i++) labels[keys[i]] = Math.max(labels[keys[i]], labels[keys[i - 1]] + 7);
    if (labels[keys.at(-1)!] > 96) { const excess = labels[keys.at(-1)!] - 96; for (const k of keys) labels[k] -= excess; }
    return {
      offset: (key: keyof typeof raw) => `${(labels[key] - raw[key]).toFixed(2)}`,
      ce: raw.ce, current: raw.live, stop: raw.stop, target: raw.target,
      zone: band(low, high, 4),
      band: band(directionalLow, directionalHigh, 3),
    };
  })() : null;

  const geometry = selected && currentPrice != null ? (() => {
    const zoneSpan = Math.max(selected.zone.high - selected.zone.low, Number.EPSILON);
    const x = (value: number) => Math.min(99, Math.max(1, 4 + (value - selected.zone.low) / zoneSpan * 92));
    const position = currentPrice < selected.zone.low ? "BELOW" : currentPrice > selected.zone.high ? "ABOVE" : "INSIDE";
    const riskValues = [selected.target, selected.stop, selected.referenceEntry, currentPrice];
    const rMin = Math.min(...riskValues), rMax = Math.max(...riskValues);
    const pad = Math.max((rMax - rMin) * .035, Math.abs(currentPrice) * .0005, Number.EPSILON);
    const rx = (value: number) => Math.min(97, Math.max(3, (value - (rMin - pad)) / (rMax - rMin + pad * 2) * 100));
    return {
      position,
      bandLeft: Math.min(x(selected.entryBand.low), x(selected.entryBand.high)), bandWidth: Math.abs(x(selected.entryBand.high) - x(selected.entryBand.low)),
      trigger: x(selected.entryBand.trigger), ce: x(selected.entryBand.ce), current: x(currentPrice),
      target: rx(selected.target), entry: rx(selected.referenceEntry), stop: rx(selected.stop), live: rx(currentPrice),
    };
  })() : null;

  const ownerGeometry = selectedOwner && selectedOwnerZone && selectedOwnerPrice != null ? (() => {
    const span = Math.max(selectedOwnerZone.high - selectedOwnerZone.low, Number.EPSILON);
    const x = (value: number) => Math.min(99, Math.max(1, 4 + (value - selectedOwnerZone.low) / span * 92));
    const bandLow = selectedOwnerZone.low;
    const bandHigh = selectedOwnerZone.high;
    return {
      position: selectedOwnerPrice < selectedOwnerZone.low ? "BELOW" : selectedOwnerPrice > selectedOwnerZone.high ? "ABOVE" : "INSIDE",
      bandLeft: Math.min(x(bandLow), x(bandHigh)),
      bandWidth: Math.abs(x(bandHigh) - x(bandLow)),
      ce: x(selectedOwnerZone.ce),
      current: x(selectedOwnerPrice),
    };
  })() : null;

  const tickerItems = universe.map(symbol => {
    const result = scan?.results?.find(row => row.symbol === symbol);
    const candidate = candidates.find(row => row.symbol === symbol);
    const owner = pendingManualCandidates.find(row => row.symbol === symbol);
    const error = scan?.errors?.find(row => row.symbol === symbol);
    return { symbol, candidate, owner, structures: result?.structures?.filter(row => row.admission === "PLAN_ELIGIBLE").length ?? 0, error };
  });

  const pollProgressKey = lastPoll;

  return <main ref={stageRef} id="main-content" className={styles.stage} data-theme={theme}>
    <HorizonField pulseKey={pulse} />
    <div className={styles.grain} aria-hidden="true" />
    <a className={styles.skipLink} href="#smc-ledger">跳到当前持仓</a>

    <div ref={frozenHeadRef} className={styles.frozenHead}>
    <header className={styles.topbar}>
      <div ref={progressRef} className={styles.scrollProgress} aria-hidden="true" />
      <a className={styles.brand} href="/s2/smc" aria-label="SMC 实盘监视器首页">
        <span className={styles.brandMark} aria-hidden="true"><i /></span>
        <span><strong>SMC <em>Live</em></strong><small>交易监视器</small></span>
      </a>
      <nav className={styles.nav} aria-label="SMC 页面导航" data-active={activeSection}>
        <span className={styles.navIndicator} aria-hidden="true" />
        <a href="#smc-candidates" aria-current={activeSection === "candidates" ? "location" : undefined}>候选计划</a>
        <a href="#smc-ledger" aria-current={activeSection === "positions" ? "location" : undefined}>当前持仓</a>
        <a href="/s2">S2 账户</a>
      </nav>
      <div className={styles.topActions}>
        <span className={styles.statusPill} data-online={liveReady}><i />{liveReady ? "执行在线" : "执行核验中"}</span>
        <button type="button" className={styles.themeToggle} onClick={toggleTheme} aria-label={`切换到${theme === "dark" ? "日间" : "夜间"}模式`} aria-pressed={theme === "light"}>
          <span aria-hidden="true">{theme === "dark" ? "☼" : "◐"}</span><b>{theme === "dark" ? "日间" : "夜间"}</b>
        </button>
        <button type="button" className={styles.refresh} disabled={loading} onClick={() => { setLoading(true); setRefreshKey(value => value + 1); }} aria-label="刷新 SMC 快照">
          <span key={pollProgressKey} className={styles.refreshRing} aria-hidden="true" />
          <span>{loading ? "同步中" : "刷新"}</span>
        </button>
      </div>
    </header>

    <div className={`${styles.shell} ${styles.frozenShell}`}>
      {/* ---------- hero ---------- */}
      <section className={styles.hero} aria-label="SMC 总览">
        <div className={styles.heroTitle}>
          <small><i className={scanFresh ? styles.dotLive : styles.dotStale} />{scanFresh ? "LIVE STRUCTURE SCAN" : "SCAN PAUSED"} · 4H 背景 / 多模型入场</small>
          <h1><span className={styles.shine}>Smart Money,</span><br />one window.</h1>
          <p>先看结构计划与距离，再看模型确认、实时净R与账户准入。</p>
        </div>
        <div className={styles.kpis}>
          <article className={styles.kpi} onPointerMove={spotlight} style={{ "--i": 0 } as CSSProperties}>
            <span>账户权益 · USDT</span>
            <b className={styles.kpiValue}>{accountFresh ? <Tween value={account?.equity} /> : "—"}</b>
            <small>可用 {accountFresh ? <Tween value={account?.available} /> : "—"}</small>
          </article>
          <article className={styles.kpi} onPointerMove={spotlight} style={{ "--i": 1 } as CSSProperties}>
            <span>组合风险</span>
            <div className={styles.kpiRow}>
              <Ring progress={accountFresh ? reservedRiskPercent / portfolioCap : 0} size={52} stroke={4} tone={reservedRiskPercent / portfolioCap > .8 ? "red" : reservedRiskPercent / portfolioCap > .5 ? "amber" : "mint"}>{accountFresh ? `${Math.round(reservedRiskPercent / portfolioCap * 100)}%` : "—"}</Ring>
              <b className={styles.kpiValue}>{accountFresh ? <Tween value={reservedRiskPercent} format={value => `${value.toFixed(2)}%`} /> : "—"}<em>/ {portfolioCap}%</em></b>
            </div>
            <small>持仓 {accountFresh ? account?.positions ?? positions.length : "—"}/{maxPositions} · 委托 {accountFresh ? orderCount : "—"}</small>
          </article>
          <article className={styles.kpi} onPointerMove={spotlight} style={{ "--i": 2 } as CSSProperties} data-tone={liveReady ? "go" : execution?.exitsAllowed ? "wait" : "stop"}>
            <span>自动执行</span>
            <div className={styles.kpiRow}><span className={styles.orb} aria-hidden="true" /><b className={styles.kpiValue}><ScrambleText text={liveReady ? "在线" : execution?.exitsAllowed ? "仅保护" : "核验中"} /></b></div>
            <small>{accountFresh ? `同步 ${clock(account?.observedAt)}` : "快照失效"}</small>
          </article>
          <article className={styles.kpi} onPointerMove={spotlight} style={{ "--i": 3 } as CSSProperties}>
            <span>扫描 · {scan ? `${scan.scannedSymbols}/${policy.universe.length}` : "—"} 市场</span>
            <b className={styles.kpiValue}><Tween value={scanFresh ? candidates.length : null} digits={0} /><em>执行候选</em></b>
            <small>{observationCandidates.length} 条件方案 · {structures.length} 结构记录 · {scan ? clock(scan.sourceAsOf) : "等待快照"}</small>
          </article>
        </div>
      </section>

      {(feed.monitorFailed || feed.ledgerFailed) && <p role="alert" className={styles.alert}><i />DATA HOLD · 账户或执行快照已过期</p>}

      {/* ---------- pinned market context ---------- */}
      <div className={styles.stickyRail}>
      <div className={styles.ticker} aria-label="扫描市场">
        <div className={styles.tickerTrack}>
          {[0, 1].map(copy => <div key={copy} className={styles.tickerGroup} aria-hidden={copy === 1}>
            {tickerItems.map(item => <span key={item.symbol} data-state={item.error ? "error" : item.candidate ? item.candidate.direction : item.owner ? item.owner.direction : "idle"}>
              <b>{item.symbol.replace("USDT", "")}</b>
              <em>{item.error ? "ERR" : item.candidate ? `${item.candidate.direction === "LONG" ? "▲ 做多" : "▼ 做空"} ${item.candidate.netR.toFixed(1)}R` : item.owner ? `${item.owner.direction === "LONG" ? "▲ 做多" : "▼ 做空"} · 自选建构` : scan ? `${item.structures} 结构` : "—"}</em>
            </span>)}
          </div>)}
        </div>
      </div>
      </div>
    </div>
    </div>

    <div className={styles.shell}>

      {/* ---------- scanner ---------- */}
      <section id="smc-candidates" className={styles.scanner} aria-labelledby="smc-candidates-title">
        <div className={styles.watchColumn}>
        <aside className={`${styles.panel} ${styles.watchlist}`} onPointerMove={spotlight}>
          <header className={styles.panelHead}>
            <div><h2 id="smc-candidates-title">扫描候选</h2></div>
            <span className={styles.countBadge}>{scanFresh ? automaticCandidates.length + planningCandidates.length : "—"}</span>
          </header>
          {scanFresh && !!scan?.errors?.length && <p className={styles.errorText} role="status">{scan.errors.map(error => `${error.symbol.replace("USDT", "")}：${sourceErrorLabel(error.reason)} · 候选暂停`).join("；")}</p>}
          {planningCandidates.length || automaticCandidates.length ? <ol className={styles.candidateList} aria-label="扫描候选列表">
            {automaticCandidates.map(renderExecutableCandidate)}
            {primaryPlanningCandidates.map(renderObservationCandidate)}
            {secondaryPlanningCandidates.map(renderObservationCandidate)}
          </ol> : <div className={styles.empty}><span className={styles.radar} aria-hidden="true" /><b>{scanFresh ? "暂无有效条件方案" : "等待扫描快照"}</b><small>{structures.length} 个有效结构仍在监视</small></div>}

        </aside>
        <aside className={`${styles.panel} ${styles.watchlist}`} aria-labelledby="smc-owner-title" onPointerMove={spotlight}>
          <header className={styles.panelHead}>
            <div><h2 id="smc-owner-title">自选候选</h2></div>
            <div className={styles.watchlistActions}>
              <span className={styles.countBadge}>{manualCandidates.length}</span>
              <button type="button" className={styles.watchlistAdd} aria-label={watchlistPickerOpen ? "收起添加列表" : "添加自选候选"}
                title={watchlistPickerOpen ? "收起添加列表" : "添加自选候选"} aria-expanded={watchlistPickerOpen} aria-controls="smc-watchlist-picker"
                onClick={() => setWatchlistPickerOpen(open => !open)}><span aria-hidden="true">{watchlistPickerOpen ? "×" : "+"}</span></button>
            </div>
          </header>
          {manualCandidates.length ? <ol className={styles.candidateList} aria-label="自选候选列表">
            {pendingManualCandidates.map(renderObservationCandidate)}
            {ownerExecutableCandidates.map(renderExecutableCandidate)}
          </ol> : <div className={styles.empty}><b>暂无自选</b><small>点击右上角 ＋ 添加关注币种</small></div>}
        {watchlistPickerOpen && <div id="smc-watchlist-picker" className={styles.watchlistPicker} role="region" aria-label="添加自选候选币种">
          <header className={styles.panelHead}><div><small>MARKET SCAN</small><h3>添加自选</h3></div><span className={styles.muted}>{universe.length} 币</span></header>
          <div className={styles.scanCoins}>
            {universe.map(symbol => {
              const result = scan?.results?.find(row => row.symbol === symbol);
              const hasCandidate = candidates.some(row => row.symbol === symbol);
              const code = symbol.replace("USDT", "").toLowerCase();
              return <button key={symbol} type="button" className={styles.scanCoin} data-active={scanSymbol === symbol} onClick={() => inspectSymbol(symbol)} aria-pressed={scanSymbol === symbol}>
                <span className={styles.scanCoinIdentity}><Image src={`/smc/coins/${code}.svg`} alt="" width={26} height={26} unoptimized className={code === "hype" ? styles.hypeLogo : ""} /><strong>{code.toUpperCase()}</strong></span>
                <span className={styles.scanCoinState}>{hasCandidate ? "候选" : result?.structures?.length ? `${result.structures.length} 结构` : "扫描"}</span>
              </button>;
            })}
          </div>
          {scanSymbol && <div className={styles.scanFinding} role="status">
            <div><b>{scanSymbol}</b><button type="button" aria-label="收起扫描结果" onClick={() => setScanSymbol(null)}>×</button></div>
            {!scanFresh ? <p>扫描快照未更新，等待新鲜结构数据。</p>
              : scanSelectionError ? <p>{sourceErrorLabel(scanSelectionError.reason)}。该币候选暂停，原方案不等于行情失效。</p>
              : scanSelectionCandidate ? <><p>已定位有效 {scanSelectionCandidate.structure.qualityGrade ?? "A/B"} 级结构 · {scanSelectionCandidate.direction === "LONG" ? "做多" : "做空"} · {scanSelectionCandidate.netR.toFixed(2)}R</p><button type="button" className={styles.scanSelect} onClick={() => { selectCandidate(scanSelectionCandidate.id); document.getElementById("smc-candidates")?.scrollIntoView({ behavior: "smooth" }); }}>查看候选计划</button></>
                : <p>{scanSelection?.structures?.length ? `发现 ${scanSelection.structures.length} 个结构，当前没有通过完整候选准入。` : "当前未找到可进入候选的有效结构。"} 下一轮扫描将继续评估。</p>}
            <small>来源：生产 SMC-SCAN-13 快照 · {scan ? clock(scan.sourceAsOf) : "等待扫描"}</small>
            {scanFresh && <div className={styles.manualAddChoices}>
              <button type="button" className={styles.autoDirectionChoice} disabled={autoDirectionPending === scanSymbol}
                aria-busy={autoDirectionPending === scanSymbol} onClick={() => addAutomaticCandidate(scanSymbol)}>
                {autoDirectionPending === scanSymbol ? "判向中…" : "⌁ 自动"}
              </button>
              {(["LONG", "SHORT"] as Direction[]).map(direction => {
              return <button key={direction} type="button" onClick={() => addManualCandidate(scanSymbol, direction)}>
                +做{direction === "LONG" ? "多" : "空"}
              </button>;
            })}</div>}
            {manualCandidateNotice && <small className={styles.manualCandidateNotice} role="status">{manualCandidateNotice}</small>}
            {manualCandidateError && <small role="alert">{manualCandidateError}</small>}

          </div>}
        </div>}
        </aside>
        <details className={`${styles.panel} ${styles.invalidations}`}>
          <summary className={styles.invalidationSummary}>
            <span><strong>最近失效</strong></span>
            <span className={styles.countBadge}>{recentInvalidations.length}</span>
          </summary>
          {recentInvalidations.length ? <ol className={styles.invalidationList}>
            {recentInvalidations.map((row, index) => <li key={`${row.id}-${row.invalidatedAt}`} style={{ "--i": index } as CSSProperties}>
              <div className={styles.invalidationTitle}>
                <span className={styles.invalidSymbol}>{row.symbol.slice(0, 1)}</span>
                <div><strong>{row.symbol.replace("USDT", "")}<small>/USDT</small></strong><em data-dir={row.direction}>{row.direction === "LONG" ? "做多" : "做空"}</em></div>
                <time>{clock(row.invalidatedAt)}</time>
              </div>
              <p>{rejectedLabels[row.reason] ?? row.reason}</p>
              <div className={styles.invalidationEvidence}>
                <span>原入场区 <b>{price(row.entryBand.low)}–{price(row.entryBand.high)}</b></span>
                {row.level != null && <span>{row.timeframe} 阈值 <b>{price(row.level)}</b></span>}
                {row.observed != null && <span>实测 <b>{price(row.observed)}</b></span>}
              </div>
              {!row.consumedConditional && row.target != null && <button type="button" className={styles.recheckButton} onClick={() => setManualCandidate({ symbol: row.symbol,
                direction: row.direction, source: "RECENT_INVALIDATION", sourceId: row.id,
                referenceEntry: (row.entryBand.low + row.entryBand.high) / 2, stop: row.stop,
                target: row.target!, detail: "最近失效 · 所有者判断" })}>手动介入</button>}
            </li>)}
          </ol> : <div className={styles.invalidationEmpty}><span>✓</span><div><b>暂无失效记录</b><small>新失效计划将在这里保留 24 小时</small></div></div>}
          <footer className={styles.invalidationFoot}>失效记录不触发自动交易；手动介入由所有者单独提交。</footer>
        </details>

        </div>

        {selectedOwner ? <div className={styles.detail} key={ownerSelectionId(selectedOwner)}>
          <header className={`${styles.panel} ${styles.instrument} ${styles.ownerInstrument}`} onPointerMove={spotlight}>
            <div className={styles.instrumentId}>
              <span className={styles.symbolMark} data-dir={selectedOwner.direction}>{selectedOwner.symbol.slice(0, 1)}</span>
              <div><h2>{selectedOwner.symbol} · {selectedOwner.direction === "LONG" ? "做多" : "做空"}</h2><p>{selectedOwner.planningOnly && !primaryPlanIds.has(ownerSelectionId(selectedOwner)) ? '备选观察' : '条件方案'} · {selectedOwnerPlan ? "等待入场确认" : "等待结构方案"}</p></div>
            </div>
            <div className={styles.quote}>
              <strong>{price(selectedOwnerPrice)}</strong>
              <span>{selectedOwnerQuoteFresh ? "实时" : "结构"} {selectedOwnerSide} · 距条件入场 <b>{selectedOwnerDistance == null ? "—" : `${selectedOwnerDistance.toFixed(2)}%`}</b></span>
            </div>
            <div className={styles.instrumentActions}>
              <button className={styles.ownerRemoveButton} type="button" onClick={() => removeManualCandidate(selectedOwner.symbol, selectedOwner.direction)}>{selectedOwner.planningOnly ? "移除方案" : "移除自选"}</button>
              <button className={styles.manualEntryButton} type="button" disabled={selectedOwner.planningOnly && (!scanFresh || !selectedOwnerPlan)} onClick={() => openManualPick(selectedOwner)}>手动介入</button>
            </div>
          </header>

            <section className={`${styles.panel} ${styles.ladderPanel}`} aria-label={`${selectedOwner.symbol} 价格结构地图`}>
              <header className={styles.panelHead}><div><h3>价格结构</h3></div><span className={styles.rBadge} data-provisional={!selectedOwnerProtectionReady || selectedOwnerRisk.netR == null}>{!selectedOwnerProtectionReady ? "保护待确认" : selectedOwnerRisk.netR == null ? "路径待确认" : `${selectedOwnerRisk.netR.toFixed(2)} 计划净R`}</span></header>
              {ownerLadder && selectedOwnerZone ? <>
                <div className={styles.ladder} style={{ "--now-x": ownerIntersection.nowX == null ? "18%" : `${ownerIntersection.nowX}%` } as CSSProperties}>
                  <IntersectionLine view={ownerIntersection} />
                  <div className={styles.ladderGrid} aria-hidden="true" />
                  <div className={styles.scanBeam} aria-hidden="true" />
                  <div className={styles.fvgZone} style={ownerLadder.zone} />
                  <div className={styles.bandZone} style={ownerLadder.band} />
                  <div className={styles.level} data-kind="ce" style={{ top: `${ownerLadder.ce}%`, "--d": "180ms", "--lo": ownerLadder.offset("ce") } as CSSProperties}><span>IN · 条件入场</span><b>{price(selectedOwnerZone.ce)}</b></div>
                  <div className={styles.level} data-kind="stop" data-provisional={!selectedOwnerProtectionReady} style={{ top: `${ownerLadder.stop}%`, "--lo": ownerLadder.offset("stop") } as CSSProperties}><span>{selectedOwnerProtectionReady ? "SL · 结构止损" : "估 · 止损待确认"}</span><b>{price(selectedOwnerPlan!.stop)}</b></div>
                  {selectedOwnerRisk.target != null && <div className={styles.level} data-kind="target" data-provisional={selectedOwnerRisk.targetProvisional} style={{ top: `${ownerLadder.target}%`, "--lo": ownerLadder.offset("target") } as CSSProperties}><span>{selectedOwnerRisk.targetProvisional ? "参考" : "TP"} · {selectedOwnerRisk.targetLabel}</span><b>{price(selectedOwnerRisk.target)}</b></div>}
                  <div className={styles.live} data-live={selectedOwnerQuoteFresh} style={{ top: `${ownerLadder.current}%`, "--lo": ownerLadder.offset("live") } as CSSProperties}><i className={styles.liveDot} /><span>{selectedOwnerQuoteFresh ? "LIVE" : "SCAN"} · {selectedOwnerSide}</span><b>{price(selectedOwnerPrice)}</b></div>
                </div>
                <IntersectionAxis view={ownerIntersection} />
                <IntersectionCaption view={ownerIntersection} side={selectedOwnerSide} />
                {selectedOwnerRisk.pathNote && <p className={styles.targetPathNote}>{selectedOwnerRisk.pathNote}</p>}
                <footer className={styles.ladderFoot}><span><i data-key="band" />入场区 {price(selectedOwnerZone.low)}–{price(selectedOwnerZone.high)}</span></footer>
                <p className={styles.muted}>止损间距 {((Math.abs(selectedOwnerPlan!.entry-selectedOwnerPlan!.stop)/selectedOwnerPlan!.entry)*100).toFixed(2)}% · {selectedOwnerPlan!.entryReview?.atr15m ? `${(Math.abs(selectedOwnerPlan!.entry-selectedOwnerPlan!.stop)/selectedOwnerPlan!.entryReview!.atr15m!).toFixed(2)} × 15M ATR` : "波动待核对"} · {selectedOwnerProtectionReady ? selectedOwnerPlan!.riskScopeRevision ? "15M主保护外侧" : "局部保护" : `${planProtectionLabel(selectedOwnerPlan)} · 净R待核算`}</p>

              </> : <div className={styles.mapPending}><span className={styles.radar} aria-hidden="true" /><b>等待当前结构方案</b><span>尚无有效的已确认摆动入场区，继续扫描。</span></div>}
            </section>

          <MonitorDisclosure className={styles.planDetails} summary="方案详情">
            <div className={styles.planDetailsBody}>
              <div className={styles.planStatus} aria-label="当前计划状态"><strong>{selectedOwnerPlan ? "条件方案 · 等待触发" : "正在生成方案"}</strong><span>{selectedOwnerStages.find(row => !row.state)?.label ?? "等待账户与风控预检"} · {selectedOwnerStages.find(row => !row.state)?.value ?? "计划条件已通过"}</span></div>
              <p className={styles.muted}>{selectedOwnerRelation} · {selectedOwnerLink.higherUnconfirmed.length ? `${selectedOwnerLink.higherUnconfirmed.map((tf: string) => tf.toUpperCase()).join(" / ")} 待确认` : "最高级别方向已确认"}{selectedOwnerLink.opposingFrames.length ? ` · ${selectedOwnerLink.opposingFrames.map((tf: string) => tf.toUpperCase()).join(" / ")} 方向冲突` : ""}</p>
              {selectedOwnerPlan && <section className={`${styles.panel} ${styles.planBasis}`} aria-label="结构方案依据">
                <p className={styles.muted}>{selectedOwnerProtectionReady ? `${selectedOwnerPlan!.stopBasis!.timeframe.toUpperCase()} ${["EXTERNAL_PROTECTION", "MAIN_15M_PROTECTION"].includes(selectedOwnerPlan!.stopBasis!.kind ?? "") ? "结构保护" : "局部摆动"} ${price(selectedOwnerPlan!.stopBasis!.point!.price)} 外侧` : "结构止损依据待确认"} · 止损距离 {((Math.abs(selectedOwnerPlan!.entry-selectedOwnerPlan!.stop)/selectedOwnerPlan!.entry)*100).toFixed(2)}% · 先定止损，再核算净R与仓位。</p>
                <p className={styles.muted}>{selectedOwnerProtectionReady ? <>计划价净R {selectedOwnerRisk.netR?.toFixed(2) ?? "待路径确认"} · 当前{selectedOwnerSide}估算净R {selectedOwnerPlan!.targetPathRevision === "SMC-TARGET-PATH-1" ? "待实时路径复核" : selectedOwnerImmediateReady ? selectedOwnerImmediate?.netR?.toFixed(2) ?? "—" : "待重新核验保护"}。实时预检以提交时为准。</> : "止损目前仅为估值，尚不能核算可用净R与仓位。目标价格保留作结构参考。"}</p>
                <details className={styles.muted}><summary>与 TradingView 对照 · 方案依据</summary>
                  {['4h', '15m'].map(tf => { const layer = linkedLayers(contextFor(selectedOwner.symbol), tf, now); return <p key={tf}>{tf.toUpperCase()} · {layer.state}<br/>外部主状态 {layer.mainDirection === 'LONG' ? '多' : layer.mainDirection === 'SHORT' ? '空' : '待定'} · 保护点 {layer.protectedPrice == null ? '—' : price(layer.protectedPrice)} · 外部边界 {price(layer.externalBoundary)} · 内部序列 {layer.labels.join(' → ') || '—'}<br/>{layer.eventRole}</p>; })}
                  <p>层级：先周期 4H ＞ 15M，再同周期外部主结构 ＞ 内部摆动。内部突破只作预警；主保护点收线有效破坏后进入过渡，反向结构确认后才改判。本端以 2×2 确认摆动持续维护外部边界；较低新高点/较高新低点归内部，不迁移主保护。TradingView 使用独立大/小摆动尺度，锚点尚未逐事件匹配。</p>
                  <p>{SMC_LINK_REVISION} · {selectedOwnerRelation}<br/>首次发现 {clock(selectedOwnerPlan!.availableAt, true)} · 本次更新 {clock(selectedOwnerPlan!.observedAt, true)}<br/>15M 锚点 {clock(selectedOwnerPlan!.anchor.time, true)} · 确认 {clock(selectedOwnerPlan!.anchor.confirmedAt, true)}<br/>目标：未扫结构 · R：含预估费用、滑点与资金费。TradingView 的冻结结构参考与毛R尺不能视为本方案；需核对合约、源周期、锚点和形成时间。两端独立识别，尚未匹配同一结构事件。自动扫描使用SMC交汇与S1 Px收线确认入场；止盈取SMC最近有效4H目标，止损按S1跟进，全仓不分批减仓；TradingView仍独立观察，须核对来源，不能据画线直接下单。</p>
                </details>
              </section>}
            <section className={styles.decisionCol} aria-label={`${selectedOwner.symbol} 决策状态`}>
              <div className={`${styles.panel} ${styles.decision}`} data-tone="wait" onPointerMove={spotlight}>
                <div className={styles.decisionOrb}>
                  <Ring progress={selectedOwnerPassed / selectedOwnerStages.length} size={132} stroke={5} tone="amber" />
                  <span className={styles.orbitSpin} aria-hidden="true" />
                  <div><small>ADMISSION</small><strong>{selectedOwnerPassed}<em>/{selectedOwnerStages.length}</em></strong></div>
                </div>
                <div className={styles.decisionCopy}>
                  <span className={styles.dirChip} data-dir={selectedOwner.direction}>{selectedOwner.direction === "LONG" ? "LONG · 做多" : "SHORT · 做空"}</span>
                  <strong><ScrambleText text={selectedOwnerPlan ? "条件方案 · 等待触发" : "正在生成方案"} /></strong>
                  <p>{selectedOwnerZone ? selectedOwnerProtectionReady ? "条件方案随结构更新，入场仍待确认" : "止损暂估，目标参考，等待结构保护" : "等待当前有效摆动"}</p>
                  <small>{selectedOwner.planningOnly ? "条件方案等待4H背景与15M结构/K线确认，再交执行器复核；交汇不拦截。" : selectedOwner.autoTradingEnabled ? "自选自动已开启；仍须完整扫描准入与实时风控通过。" : "自选自动已关闭；可查看方案并手动预检。"}</small>
                </div>
              </div>
              <div className={`${styles.panel} ${styles.gate}`} onPointerMove={spotlight}>
                <small>当前阻断</small>
                <strong>{selectedOwnerStages.find(row => !row.state)?.label ?? "等待账户与风控预检"}</strong>
                <span>{selectedOwnerStages.find(row => !row.state)?.value ?? "计划条件已通过"}</span>
              </div>
              <div className={styles.panel}><small>JEV</small><strong>已按所有者指令停止</strong><span className={styles.muted}>历史研究保留，当前不参与</span></div>
            </section>

          {ownerGeometry && selectedOwnerZone && <div className={styles.stripGrid}>
            <section className={`${styles.panel} ${styles.strip}`} aria-label="条件入场区比例图" onPointerMove={spotlight}>
              <header><small>STRUCTURE GEOMETRY · NORMALIZED</small><strong>15M 摆动入场区</strong><span>回踩确认后进场</span></header>
              <div className={styles.rail}>
                <i className={styles.railFvg} />
                <i className={styles.railBand} style={{ left: `${ownerGeometry.bandLeft}%`, width: `${ownerGeometry.bandWidth}%` }} />
                {[0, 25, 50, 75, 100].map(mark => <em key={mark} className={styles.railTick} style={{ left: `${4 + mark * .92}%` }}>{mark}%</em>)}
                <span className={styles.railMark} data-kind="ce" style={{ left: `${ownerGeometry.ce}%` }}><b>{selectedOwnerZone.kind === "FVG" ? "CE" : "MID"}</b></span>
                <span className={styles.railLive} data-position={ownerGeometry.position} style={{ left: `${ownerGeometry.current}%` }}><b>{ownerGeometry.position === "BELOW" ? "◀ 低于结构" : ownerGeometry.position === "ABOVE" ? "高于结构 ▶" : "区间内"}</b></span>
              </div>
              <footer><span>{price(selectedOwnerZone.low)}</span><span>当前条件方案 · 等待触发确认</span><span>{price(selectedOwnerZone.high)}</span></footer>
            </section>
            <section className={`${styles.panel} ${styles.strip}`} aria-label="风险与目标状态" onPointerMove={spotlight}>
              <header><small>RISK PATH · CONDITIONAL</small><strong>{selectedOwnerProtectionReady ? "风险路径" : "结构参考"}</strong><span>{selectedOwnerProtectionReady ? "正式计划准入 ≥ 2.00R" : "保护确认后核算"}</span></header>
              <p className={styles.muted}>条件入场 {price(selectedOwnerPlan!.entry)} · {selectedOwnerProtectionReady ? "结构止损" : "止损估值"} {price(selectedOwnerPlan!.stop)} · {selectedOwnerRisk.targetLabel} {price(selectedOwnerRisk.target)}<br/>{selectedOwnerProtectionReady ? <>成本后净R {selectedOwnerRisk.netR?.toFixed(2) ?? "待核算"} · {selectedOwnerRisk.netR == null ? selectedOwnerRisk.pathNote ?? "等待未扫目标" : selectedOwnerRisk.netR < 2 ? "当前报酬不足，等待更优结构" : "等待完整执行确认"}</> : "保护依据尚未确认，净R与仓位待核算"}</p>
              <footer><span>单笔 {Number(riskPolicy?.perTradeFraction ?? .04) * 100}%</span><span>组合 {portfolioCap}%</span><span>持仓 {account?.positions ?? 0}/{maxPositions} · 委托 {orderCount}</span></footer>
            </section>
          </div>}

          <div className={styles.stripGrid}>
            <section className={`${styles.panel} ${styles.timeline}`} aria-label="准入条件" onPointerMove={spotlight}>
              <header className={styles.panelHead}><div><small>ENTRY ADMISSION</small><h3>准入条件</h3></div><span className={styles.muted}>{selectedOwnerQuoteFresh ? "LIVE BBO" : "SCAN BBO"} {selectedOwnerQuoteRow ? clock(selectedOwnerQuoteRow.quoteAt) : "—"}</span></header>
              <ol>{selectedOwnerStages.map((row, index) => <li key={row.label} data-pass={row.state} style={{ "--i": index } as CSSProperties}><i aria-hidden="true">{row.state ? "✓" : ""}</i><p><b>{row.label}</b><small>{row.value}</small></p></li>)}</ol>
            </section>
            <section className={`${styles.panel} ${styles.diag}`} aria-label="扫描诊断" onPointerMove={spotlight}>
              <details><summary>系统分工与规则</summary><p>扫描器发现机会并更新计划；执行器复核实时净R、风险和保护，负责唯一订单写入；TradingView提供结构观察；监视器展示真实状态并提交操作请求。内部结构不覆盖外部方向，条件方案须经模型确认才能晋级。</p></details><header className={styles.panelHead}><div><small>SCAN DIAGNOSTICS</small><h3>扫描诊断</h3></div><span className={styles.ownerSource}>{selectedOwner.planningOnly ? "条件" : "自选"}</span></header>
              <p className={styles.muted}>120 天背景 · 当前摆动条件方案 · 成本后净 R ≥ 2 才可通过自动风险门，仍需完整执行确认。</p>
              <ul className={styles.bars}>{selectedOwnerStages.map((row, index) => <li key={row.label} style={{ "--i": index } as CSSProperties}><span>{row.label}</span><i><span style={{ transform: `scaleX(${row.state ? 1 : 0})` }} /></i><b>{row.state ? "OK" : "—"}</b></li>)}</ul>
            </section>
          </div>
            </div>
          </MonitorDisclosure>
        </div> : selected && ladder && geometry ? <div className={styles.detail} key={selected.id}>
          <header className={`${styles.panel} ${styles.instrument} ${selectedIsOwner ? styles.ownerInstrument : ""}`} onPointerMove={spotlight}>
            <div className={styles.instrumentId}>
              <span className={styles.symbolMark} data-dir={selected.direction}>{selected.symbol.slice(0, 1)}</span>
              <div><h2>{selected.symbol} · {selected.direction === "LONG" ? "做多" : "做空"}{selectedIsOwner && <em className={styles.ownerTag}>自选</em>}</h2><p>{decision}</p></div>
            </div>
            <div className={styles.quote}>
              <strong><Tween value={currentPrice} format={price} /></strong>
              <span>{selectedMarket?.live ? "实时" : "扫描"} {selectedMarket?.side ?? "BBO"} · 距执行带 <b>{selectedMarket ? formatSignedEntryPercent(selectedMarket.signedPercent) : "—"}</b></span>
            </div>
            <div className={styles.instrumentActions}>
              {selectedIsOwner && <button className={styles.ownerRemoveButton} type="button" onClick={() => removeManualCandidate(selected.symbol, selected.direction)}>移除自选</button>}
              <button className={styles.manualEntryButton} type="button" onClick={() => openActiveOrder(selected)}>手动介入</button>
            </div>
          </header>

            {/* price ladder */}
            <section className={`${styles.panel} ${styles.ladderPanel}`} aria-label={`${selected.symbol} 价格结构地图`}>
              <header className={styles.panelHead}><div><h3>价格结构</h3></div><span className={styles.rBadge}>{selected.netR.toFixed(2)}R</span></header>
              <div className={styles.ladder} style={{ "--now-x": candidateIntersection.nowX == null ? "18%" : `${candidateIntersection.nowX}%` } as CSSProperties}>
                <IntersectionLine view={candidateIntersection} />
                <div className={styles.ladderGrid} aria-hidden="true" />
                <div className={styles.scanBeam} aria-hidden="true" />
                <div className={styles.rewardField} style={ladder.reward}><span>目标路径 · {selected.netR.toFixed(2)}R</span></div>
                <div className={styles.riskField} style={ladder.risk}><span>初始风险 · 1.00R</span></div>
                <div className={styles.fvgZone} style={ladder.zone} />
                <div className={styles.bandZone} style={ladder.band} />
                <div className={styles.level} data-kind="target" style={{ top: `${ladder.target}%`, "--d": "80ms", "--lo": ladder.offset("target") } as CSSProperties}><span>TP · {selected.sourcePlan?.targetBasis?.scope === "4H_MAIN" ? "4H 主目标" : "结构目标"}</span><b>{price(selected.target)}</b></div>
                <div className={styles.level} data-kind="ce" style={{ top: `${ladder.ce}%`, "--d": "180ms", "--lo": ladder.offset("ce") } as CSSProperties}><span>IN · 计划参考入场</span><b>{price(selected.entryBand.ce)}</b></div>
                <div className={styles.level} data-kind="stop" style={{ top: `${ladder.stop}%`, "--d": "320ms", "--lo": ladder.offset("stop") } as CSSProperties}><span>SL · 保护退出</span><b>{price(selected.stop)}</b></div>
                <div className={styles.live} data-live={selectedMarket?.live} style={{ top: `${ladder.current}%`, "--lo": ladder.offset("live") } as CSSProperties}><i className={styles.liveDot} /><span>{selectedMarket?.live ? "LIVE" : "SCAN"} · {selectedMarket?.side ?? "BBO"}</span><b>{price(currentPrice)}</b></div>
              </div>
              <IntersectionAxis view={candidateIntersection} />
              <IntersectionCaption view={candidateIntersection} side={selectedMarket?.side ?? "BID"} />
              <footer className={styles.ladderFoot}><span><i data-key="fvg" />{selected.modelRevision === "SMC-S1-PX-1" ? "Px确认价格区" : ["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1", "SMC-TIMED-ENTRY-1", "SMC-CONTINUATION-2"].includes(selected.modelRevision ?? "") ? "15M 回踩区" : "4H FVG"} {price(selected.zone.low)}–{price(selected.zone.high)}</span><span><i data-key="band" />执行带 {price(selected.entryBand.low)}–{price(selected.entryBand.high)}</span></footer>
            </section>

          <MonitorDisclosure className={styles.planDetails} summary="方案详情">
            <div className={styles.planDetailsBody}>
              <div className={styles.planStatus} aria-label="当前计划状态" data-tone={decisionTone}><strong>{decision}</strong><span>{pending[0]?.label ?? "信号条件全部通过"} · {pending[0]?.value ?? "等待账户与风控预检"}</span></div>
            {/* decision column */}
            <section className={styles.decisionCol} aria-label={`${selected.symbol} 决策状态`}>
              <div className={`${styles.panel} ${styles.decision}`} data-tone={decisionTone} onPointerMove={spotlight}>
                <div className={styles.decisionOrb}>
                  <Ring progress={passed / Math.max(conditions.length, 1)} size={132} stroke={5} tone={decisionTone === "go" ? "mint" : decisionTone === "wait" ? "amber" : "red"} />
                  <span className={styles.orbitSpin} aria-hidden="true" />
                  <div><small>ADMISSION</small><strong>{passed}<em>/{conditions.length}</em></strong></div>
                </div>
                <div className={styles.decisionCopy}>
                  <span className={styles.dirChip} data-dir={selected.direction}>{selected.direction === "LONG" ? "LONG · 做多" : "SHORT · 做空"}</span>
                  <strong><ScrambleText text={decision} /></strong>
                  <p>{selected.modelRevision === "SMC-S1-PX-1" ? "Px方向锁定，等待实时执行复核" : ["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1", "SMC-TIMED-ENTRY-1", "SMC-CONTINUATION-2"].includes(selected.modelRevision ?? "") ? (selected.status === "ENTRY_BAND_ACTIVE" ? "回踩已确认，等待执行复核" : "回踩已确认，等待有效入场价") : waitingStatus[selected.status] ?? selected.status}</p>
                  <small>{selected.modelRevision === "SMC-S1-PX-1" ? "确认后180秒内、盘口偏离收盘≤50bp；净2R、成本与账户保护全部通过后执行" : ["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1", "SMC-TIMED-ENTRY-1", "SMC-CONTINUATION-2"].includes(selected.modelRevision ?? "") ? "实时净2R、止损、账户与价格带全部通过后执行" : nextActions[selected.status] ?? "等待下一次有效确认"}</small>
                </div>
              </div>
              <div className={`${styles.panel} ${styles.gate}`} onPointerMove={spotlight}>
                <small>当前阻断</small>
                <strong>{pending[0]?.label ?? "信号条件全部通过"}</strong>
                <span>{pending[0]?.value ?? "等待账户与风控预检"}</span>
              </div>
              <div className={styles.panel}><small>JEV</small><strong>已按所有者指令停止</strong><span className={styles.muted}>历史研究保留，当前不参与</span></div>
            </section>

          {/* geometry strips */}
          <div className={styles.stripGrid}>
            <section className={`${styles.panel} ${styles.strip}`} aria-label="FVG 与入场带比例图" onPointerMove={spotlight}>
              <header><small>ENTRY GEOMETRY · NORMALIZED</small><strong>{["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1", "SMC-TIMED-ENTRY-1", "SMC-CONTINUATION-2"].includes(selected.modelRevision ?? "") ? "回踩入场区域" : selected.modelRevision === "SMC-S1-PX-1" ? "Px入场区域" : "FVG 入场几何"}</strong><span>{["SMC-LOCAL-ENTRY-2", "SMC-LOCAL-ENTRY-1", "SMC-TIMED-ENTRY-1", "SMC-CONTINUATION-2"].includes(selected.modelRevision ?? "") ? (selected.modelRevision === "SMC-LOCAL-ENTRY-2" ? "15M 确认后有效价格带" : "5M 确认后有效价格带") : selected.modelRevision === "SMC-S1-PX-1" ? "15M确认收盘价±50bp · Px反侧5bp初始止损" : selected.direction === "LONG" ? "多单 · CE → FVG 上轨" : "空单 · FVG 下轨 → CE"}</span></header>
              <div className={styles.rail}>
                <i className={styles.railFvg} />
                <i className={styles.railBand} style={{ left: `${geometry.bandLeft}%`, width: `${geometry.bandWidth}%` }} />
                {[0, 25, 50, 75, 100].map(mark => <em key={mark} className={styles.railTick} style={{ left: `${4 + mark * .92}%` }}>{mark}%</em>)}
                <span className={styles.railMark} data-kind="ce" style={{ left: `${geometry.ce}%` }}><b>CE · CONFIRM</b></span>
                <span className={styles.railLive} data-position={geometry.position} style={{ left: `${geometry.current}%` }}><b>{geometry.position === "BELOW" ? "◀ 低于区域" : geometry.position === "ABOVE" ? "高于区域 ▶" : "区间内"}</b></span>
              </div>
              <footer><span>{price(selected.zone.low)}</span><span>执行带 {price(selected.entryBand.low)} — {price(selected.entryBand.high)}</span><span>{price(selected.zone.high)}</span></footer>
            </section>
            <section className={`${styles.panel} ${styles.strip}`} aria-label="风险与目标比例图" onPointerMove={spotlight}>
              <header><small>RISK PATH · TRUE SCALE</small><strong>风险路径</strong><span>{selected.netR.toFixed(2)}R · 准入 ≥ 2.00R</span></header>
              <div className={styles.rail}>
                <i className={styles.railReward} style={{ left: `${Math.min(geometry.target, geometry.entry)}%`, width: `${Math.abs(geometry.target - geometry.entry)}%` }} />
                <i className={styles.railLoss} style={{ left: `${Math.min(geometry.stop, geometry.entry)}%`, width: `${Math.abs(geometry.stop - geometry.entry)}%` }} />
                <span className={styles.railMark} data-kind="target" style={{ left: `${geometry.target}%` }}><b>TARGET</b></span>
                <span className={styles.railMark} data-kind="entry" style={{ left: `${geometry.entry}%` }}><b>ENTRY</b></span>
                <span className={styles.railMark} data-kind="stop" style={{ left: `${geometry.stop}%` }}><b>STOP</b></span>
                <span className={styles.railLive} style={{ left: `${geometry.live}%` }}><b>{selectedMarket?.live ? "LIVE" : "SCAN"}</b></span>
              </div>
              <footer><span>单笔 {Number(riskPolicy?.perTradeFraction ?? .04) * 100}%</span><span>组合 {portfolioCap}%</span><span>持仓 {account?.positions ?? 0}/{maxPositions} · 委托 {orderCount}</span></footer>
            </section>
          </div>

          {/* admission timeline + diagnostics */}
          <div className={styles.stripGrid}>
            <section className={`${styles.panel} ${styles.timeline}`} aria-label="准入条件" onPointerMove={spotlight}>
              <header className={styles.panelHead}><div><small>ENTRY ADMISSION</small><h3>准入条件</h3></div><span className={styles.muted}>{selectedMarket?.live ? "LIVE BBO" : "SCAN BBO"} {selectedMarket ? clock(selectedMarket.quoteAt) : "—"}</span></header>
              <ol>{conditions.map((row, index) => <li key={row.label} data-pass={row.state} style={{ "--i": index } as CSSProperties}><i aria-hidden="true">{row.state ? "✓" : ""}</i><p><b>{row.label}</b><small>{row.value}</small></p></li>)}</ol>
            </section>
            <section className={`${styles.panel} ${styles.diag}`} aria-label="扫描诊断" onPointerMove={spotlight}>
              <details><summary>系统分工与规则</summary><p>扫描器发现机会并更新计划；执行器复核实时净R、风险和保护，负责唯一订单写入；TradingView提供结构观察；监视器展示真实状态并提交操作请求。内部结构不覆盖外部方向，条件方案须经模型确认才能晋级。</p></details><header className={styles.panelHead}><div><small>SCAN DIAGNOSTICS</small><h3>扫描诊断</h3></div><span className={styles.muted}>{universe.length} 市场 · {structures.length} 结构</span></header>
              <p className={styles.muted}>SMC交汇 → S1 Px入场 → 全仓跟进止损 · SMC目标止盈 · 自动净2R含2 · 不分批减仓</p>
              <ul className={styles.bars}>{rejectionTotals.slice(0, 6).map(([key, value], index) => { const top = rejectionTotals[0]?.[1] || 1; return <li key={key} style={{ "--i": index } as CSSProperties}><span>{rejectedLabels[key] ?? key}</span><i><span style={{ transform: `scaleX(${value / top})` }} /></i><b>{value}</b></li>; })}</ul>
              {!rejectionTotals.length && <p className={styles.muted}>暂无淘汰记录</p>}
              {!!scan?.errors?.length && <p className={styles.errorText}>错误：{scan.errors.map(error => `${error.symbol}:${error.reason}`).join(" · ")}</p>}
            </section>
          </div>
            </div>
          </MonitorDisclosure>
        </div> : <div className={`${styles.panel} ${styles.detailEmpty}`}><span className={styles.radar} aria-hidden="true" /><b>等待有效 SMC 计划</b><span>扫描器仍在监视 {structures.length} 个结构</span></div>}
      </section>

      {/* ---------- ledger ---------- */}
      <section id="smc-ledger" className={styles.ledger} aria-labelledby="smc-ledger-title">
        <header className={styles.sectionHead}>
          <div><h2 id="smc-ledger-title">当前持仓</h2></div>
          <p><i className={accountFresh ? styles.dotLive : styles.dotStale} />{accountFresh ? `币安同步 ${clock(account?.observedAt, true)}` : "等待账户同步"}</p>
        </header>
        <div className={styles.ledgerGrid}>
          <div className={`${styles.panel} ${styles.equityPanel}`} onPointerMove={spotlight}>
            <header className={styles.panelHead}><div><small>账户权益</small><h3><Tween value={accountFresh ? account?.equity : null} /> <em>USDT</em></h3></div></header>
            <EquityCurve history={ledger?.history ?? []} />
            <div className={styles.summary}>
              <div><span>持仓</span><b>{accountFresh ? `${positions.length} / ${maxPositions}` : "—"}</b></div>
              <div><span>浮动盈亏</span><b data-sign={(positionPnls.total ?? 0) >= 0 ? "pos" : "neg"} title="当前持仓浮动盈亏合计，与下方持仓使用同一估值">{fmt(positionPnls.total)}</b></div>
              <div><span>已占风险</span><b>{accountFresh ? fmt(reservedRisk) : "—"}</b></div>
              <div><span>活动委托</span><b>{accountFresh ? orderCount : "—"}</b></div>
            </div>
          </div>
          <div className={styles.positionsCol}>
            {positions.length ? positions.map((row, index) => { const positionPnl = positionPnls.rows[index]; return <article key={row.planId} className={`${styles.panel} ${styles.position}`} style={{ "--i": index } as CSSProperties} onPointerMove={spotlight}>
              <header><strong>{row.symbol}</strong><em data-dir={row.direction}>{row.direction === "LONG" ? "做多" : "做空"}</em></header>
              <dl><div><dt>浮动盈亏</dt><dd data-sign={(positionPnl.value ?? 0) >= 0 ? "pos" : "neg"} title={positionPnl.source === "LIVE_CLOSE_BBO" ? `按实时可平仓价 ${price(positionPnl.closePrice)} 估算` : positionPnl.source === "ACCOUNT_SNAPSHOT" ? "账户快照" : "等待新鲜账户与行情数据"}>{positionPnl.value == null ? "—" : <>{fmt(positionPnl.value)} USDT</>}</dd></div><div><dt>数量</dt><dd>{fmt(row.quantity, 6)}</dd></div><div><dt>开仓均价</dt><dd>{price(row.entry)}</dd></div><div><dt>保护止损</dt><dd>{price(row.stop)}</dd></div><div><dt>当前止盈</dt><dd>{price(row.target)}</dd></div><div><dt>初始风险</dt><dd>{fmt(row.initialRiskUsdt)} USDT</dd></div></dl>
              <PositionControls row={row} enabled={accountFresh && execution?.exitsAllowed === true}
                tickSize={priceRuleMap.get(row.symbol) ?? null}
                quote={quoteMap.get(row.symbol) ?? null}
                scanResult={scan?.results?.find(result => result.symbol === row.symbol) ?? null}
                now={now}
                onRefresh={() => setRefreshKey(value => value + 1)} />
            </article>; }) : <div className={`${styles.panel} ${styles.flat}`}><div><b>当前无持仓</b><span>没有正在承受市场风险的 SMC 仓位</span></div><strong>FLAT</strong></div>}
            <details className={`${styles.panel} ${styles.fills}`}>
              <summary>委托与成交 <span>{orderCount} 委托 · {fills.length} 成交</span></summary>
              <p className={styles.muted}>普通委托 {account?.orders ?? 0} · 条件委托 {account?.algoOrders ?? 0}</p>
              {pendingEntries.length ? <ul>{pendingEntries.map(row => <li key={row.planId}><span>{clock(row.createdAt, true)}</span><b>{row.symbol} · {row.direction === "LONG" ? "做多" : "做空"}</b><span>{price(row.price)} / {fmt(row.quantity, 6)}</span><em>{row.timeInForce} · {row.status}</em></li>)}</ul> : null}
              {fills.length ? <ul>{fills.slice(0, 20).map(row => <li key={row.key}><span>{clock(row.time, true)}</span><b>{row.symbol} · {row.role}</b><span>{fmt(row.price, 6)} / {fmt(row.quantity, 6)}</span><em data-sign={row.realizedPnl >= 0 ? "pos" : "neg"}>{fmt(row.realizedPnl)}</em></li>)}</ul> : <p className={styles.muted}>暂无 SMC 成交记录</p>}
            </details>
          </div>
        </div>
      </section>

      <MonitorDisclosure className={styles.systemDisclosure} summary="系统信息">
        <p>币安 USDⓈ-M · SMC-SCAN-13 / SMC-EXEC-11 · 单一执行器</p>
        <p>4H 结构 · 15M 入场确认 · 扫描间隔 5 分钟 · 执行检查 15 秒{liveQuotesFailed ? " · 实时报价回退中" : ""}</p>
        <p>账户快照 {ledger?.history?.length ?? 0} 条</p>
      </MonitorDisclosure>
    </div>
    {manualCandidate && <ManualOrderPanel key={`${manualCandidate.source}:${manualCandidate.sourceId}:${priceRuleMap.get(manualCandidate.symbol) ?? "awaiting-precision"}`} candidate={manualCandidate} tradePlans={scan?.results.find(row => row.symbol === manualCandidate.symbol)?.structurePlans} stopContext={scan?.results.find(row => row.symbol === manualCandidate.symbol)?.stopSafetyContext}
      quote={manualQuote} accountFresh={accountFresh} liveReady={liveReady} entriesAllowed={entriesAllowed}
      manualEntriesEnabled={manualEntriesEnabled} now={now} account={account} positions={positions}
      pendingEntries={pendingEntries}
      riskPolicy={riskPolicy}
      tickSize={priceRuleMap.get(manualCandidate.symbol) ?? null} onClose={closeManualOrder} />}
  </main>;
}
