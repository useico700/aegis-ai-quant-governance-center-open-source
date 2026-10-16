"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ordinalCurveFraction } from "../monitor-curve";
import { abnormalLossGateLabel, MONITOR_COMMON_COPY, MONITOR_PRESENTATION_REVISION } from "../monitor-sync";
import { groupLearningEquityByHour, type EquityPoint, type HourlyEquityPoint } from "./curve";
import { currentCandidateView } from "./execution-view.mjs";
import styles from "./v3-equity.module.css";

type Position = { symbol: string; side: "LONG" | "SHORT"; entryPrice: number; markPrice: number; unrealizedPnlUsdt: number; stage: string; managed?: boolean; protectionStatus?: "PROTECTED" | "UNPROTECTED"; plannedMaximumLossUsdt?: number; redLossThresholdUsdt?: number };
type SingleZ = { schemaVersion: 1; status: "CONFIRMED" | "NOT_CONFIRMED" | "MISSING"; primaryInterval: "1h" | null; confirmedAt: number | null };
type CandidatePlan = { id: string; symbol: string; pattern: string; primaryLineStatus: string; intersectionTime: number; intersectionPrice: number; queuePosition: number; queueSize: number; entryStatus: string; direction: -1 | 0 | 1; automaticExecutionAllowed: boolean; singleZ?: SingleZ; stabilityScore: number; support: number };
type Cohort = { evaluationCohortId: string | null; classification: string; openPositionCount: number; closedTradeCount: number; realizedNetPnlUsdt: number; totalCommissionUsdt: number };
type SettlementEvidence = { status: string; reasons: string[]; unlocatedSettlementCount: number | null; unlocatedPartialCount: number | null; unlocatedNetPnlUsdt: number | null; accountingResidualUsdt: number | null; drawdownEligible: boolean };
type Snapshot = {
  sourceAsOf: string;
  implementationRevision?: string | null;
  strategyDisplayName?: string;
  evaluationCohortId?: string | null;
  baselineUsdt: number;
  current: { walletBalanceUsdt?: number; walletChangeUsdt?: number; marginEquityUsdt: number; unrealizedPnlUsdt: number; realizedLearningEquityUsdt: number };
  metrics: { totalRealizedNetPnlUsdt: number; closedTradeCount?: number; partialSettlementCount?: number; maximumDrawdownUsdt?: number | null; settlementEvidence?: SettlementEvidence };
  risk?: { maximumOpenPositionsTotal: number };
  accountingBridge?: { status: string; incomeHistoryComplete: boolean; incomeHistoryRowCount: number; accountEquationDifferenceUsdt: number; walletUnreconciledDifferenceUsdt: number; strategyLedgerCoverageDifferenceUsdt: number; openPositionUnallocatedEntryCommissionUsdt: number; fundingFeeUsdt: number };
  executionHealth?: { status: string; errors: string[]; livePositionCount: number; managedPositionCount: number; protectedPositionCount: number; pendingOperationCount: number; standardOpenOrderCount: number; activeAlgoOrderCount: number };
  abnormalLossGate?: { status: string; entriesBlocked: boolean; manualResetRequired: boolean; orangeHealthyCycles: number; orangeHealthyCyclesRequired: number; activeTrigger: { symbol: string; plannedMaximumLossUsdt: number; actualLossUsdt: number; actualLossR: number | null; excessLossUsdt: number; trigger: string } | null };
  currentPositions?: Position[];
  candidatePlans?: CandidatePlan[];
  cohorts?: Cohort[];
  curve: { points: EquityPoint[] };
};
type Envelope = { status: string; sourceAsOf: string; receivedAt: string; snapshot: Snapshot };

const moneyFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const compactTimeFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function money(value: number) { const normalized = Math.abs(value) < .005 ? 0 : value; return `${normalized < 0 ? "−" : ""}${moneyFormat.format(Math.abs(normalized))}`; }
function signed(value: number) { return `${value > 0 ? "+" : ""}${money(value)}`; }
function time(value: number | string, compact = false) { return (compact ? compactTimeFormat : timeFormat).format(new Date(value)).replaceAll("/", "-"); }
function price(value: number) { return value.toLocaleString("en-US", { maximumFractionDigits: 8 }); }
function stage(value: string) {
  return ({ INITIAL_PROTECTION: "初始保护", SOFT_LOCK_80_REMAINING: "锁利 · 80%", AFTER_1R_50_REMAINING: "1R · 50%", RUNNER_25: "尾仓 · 25%", OPEN: "管理中", UNMANAGED: "未纳管" } as Record<string, string>)[value] ?? "管理中";
}
function pattern(value: string) {
  return value.replace("1H_ASC_LOW__15M_DESC_HIGH", "1H 上升低点 × 15M 下降高点").replace("1H_DESC_HIGH__15M_ASC_LOW", "1H 下降高点 × 15M 上升低点");
}
function entryStatus(value: string, direction: number, interval = "5M") {
  if (direction === 1 || value.includes("LONG")) return "已确认 · 多";
  if (direction === -1 || value.includes("SHORT")) return "已确认 · 空";
  return ({ WAITING_FOR_CROSS: "等待交汇", WAITING_SECOND_5M_CLOSE: "等待第二根 5M", WAITING_FIRST_15M_CLOSE: "等待第一根 15M", WAITING_SECOND_PERSISTENCE_CLOSE: `等待第二根 ${interval}`, EXPIRED: "确认时效已结束", REJECTED: "确认未通过" } as Record<string, string>)[value] ?? `等待 ${interval} 确认`;
}
function cohortLabel(cohort: Cohort) {
  const baseline = cohort.classification.match(/^PRE_(HF\d+)_BASELINE$/);
  if (baseline) return `${baseline[1]} 前基线`;
  const forward = cohort.classification.match(/^(HF\d+)_FORWARD$/);
  return forward ? `${forward[1]} 前向` : cohort.classification === "UNCLASSIFIED" ? "历史未分群" : cohort.classification;
}
function singleZLabel(value: SingleZ | undefined) {
  return value?.status === "CONFIRMED" ? "1H Z 已确认" : "1H Z 待确认";
}
function countdown(target: number, now: number) {
  const remaining = target - now;
  if (remaining <= 0) return "交汇时刻已到";
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分钟`;
}

function EquityCurve({ points, selected, onSelect }: { points: HourlyEquityPoint[]; selected: HourlyEquityPoint | null; onSelect: (point: HourlyEquityPoint | null) => void }) {
  const geometry = useMemo(() => {
    const values = points.map((point) => point.realizedLearningEquityUsdt);
    const minRaw = Math.min(...values);
    const maxRaw = Math.max(...values);
    const pad = Math.max((maxRaw - minRaw) * .16, 16);
    const min = minRaw - pad;
    const max = maxRaw + pad;
    const first = points[0]?.timestamp ?? 0;
    const last = points.at(-1)?.timestamp ?? first + 1;
    const x = (index: number) => 54 + ordinalCurveFraction(index, points.length) * 926;
    const y = (value: number) => 18 + (max - value) / Math.max(max - min, 1) * 226;
    const coordinates = points.map((point, index) => ({ point, x: x(index), y: y(point.realizedLearningEquityUsdt) }));
    return { min, max, first, last, lastX: coordinates.at(-1)?.x ?? 54, coordinates, line: coordinates.map((row) => `${row.x},${row.y}`).join(" ") };
  }, [points]);

  if (!points.length) return <div className={styles.empty}>尚无已结算曲线数据</div>;
  const active = selected ?? points.at(-1)!;
  const activeCoordinate = geometry.coordinates.find((row) => row.point.id === active.id) ?? geometry.coordinates.at(-1)!;
  return <div className={styles.plot}>
    <svg viewBox="0 0 1000 280" preserveAspectRatio="none" role="img" aria-label="V3 监视器权益曲线">
      <defs>
        <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#49d7b1" stopOpacity=".24"/><stop offset="1" stopColor="#49d7b1" stopOpacity="0"/></linearGradient>
        <filter id="lineGlow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {[0, 1, 2, 3].map((row) => <line key={row} x1="54" x2="980" y1={18 + row * 75.3} y2={18 + row * 75.3} className={styles.gridLine}/>) }
      <polygon points={`${geometry.line} ${geometry.lastX},244 54,244`} fill="url(#equityFill)"/>
      <polyline points={geometry.line} className={styles.curveGlow}/>
      <polyline points={geometry.line} className={styles.curveLine}/>
      {geometry.coordinates.map((row) => <circle key={row.point.id} cx={row.x} cy={row.y} r="12" fill="transparent" onPointerEnter={() => onSelect(row.point)} onPointerDown={() => onSelect(row.point)} className={styles.hitPoint}/>) }
      <line x1={activeCoordinate.x} x2={activeCoordinate.x} y1="18" y2="244" className={styles.guideLine}/>
      <circle cx={activeCoordinate.x} cy={activeCoordinate.y} r="5" className={styles.activePoint}/>
    </svg>
    <div className={styles.yLabels}><span>{money(geometry.max)}</span><span>{money((geometry.max + geometry.min) / 2)}</span><span>{money(geometry.min)}</span></div>
    <div className={styles.xLabels}><span>{time(geometry.first, true)}</span><span>{time(geometry.last, true)}</span></div>
  </div>;
}

export default function V3EquityPage() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [selected, setSelected] = useState<HourlyEquityPoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const points = useMemo(() => envelope ? groupLearningEquityByHour(envelope.snapshot.curve.points) : [], [envelope]);

  const refresh = useCallback(async (visible = true) => {
    if (visible) setRefreshing(true);
    try {
      const response = await fetch(`/api/v3-equity?refresh=${Date.now()}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      });
      if (!response.ok) throw new Error("权益数据暂不可用");
      const data = await response.json() as Envelope;
      setEnvelope((current) => {
        if (!current) return data;
        const currentTime = Date.parse(current.sourceAsOf || current.snapshot.sourceAsOf);
        const nextTime = Date.parse(data.sourceAsOf || data.snapshot.sourceAsOf);
        return Number.isFinite(currentTime) && Number.isFinite(nextTime) && nextTime < currentTime ? current : data;
      });
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "权益数据暂不可用"); }
    finally { if (visible) setRefreshing(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const syncTimer = window.setInterval(() => void refresh(false), 30_000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 10_000);
    const resume = () => { setClock(Date.now()); void refresh(false); };
    const visibility = () => { if (document.visibilityState === "visible") resume(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    return () => {
      window.clearInterval(syncTimer);
      window.clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
    };
  }, [refresh]);

  if (!envelope) return <main className={styles.loading} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}><span>V3</span><p>{error ?? "正在同步权益数据…"}</p><button onClick={() => void refresh()}>{MONITOR_COMMON_COPY.refresh}</button></main>;
  const { snapshot } = envelope;
  const point = selected ?? points.at(-1) ?? null;
  const positions = snapshot.currentPositions ?? [];
  const candidateView = currentCandidateView(snapshot, clock, envelope.status, Boolean(error));
  const candidates = candidateView.candidatePlans;
  const cohorts = [...(snapshot.cohorts ?? [])].sort((left, right) => Number(right.evaluationCohortId === snapshot.evaluationCohortId) - Number(left.evaluationCohortId === snapshot.evaluationCohortId));
  const sourceVersion = snapshot.implementationRevision?.match(/(?:^|-)HF(\d+)(?:-|$)/)?.[1];
  const sourceVersionLabel = sourceVersion ? `HF${sourceVersion}` : "版本待确认";
  const bootstrap = envelope.status === "BOOTSTRAP_SNAPSHOT";
  const maximumOpenPositions = snapshot.risk?.maximumOpenPositionsTotal ?? (/HF(?:10|11|13|14)-/.test(snapshot.implementationRevision ?? "") ? 18 : 10);
  const accountChange = snapshot.current.marginEquityUsdt - snapshot.baselineUsdt;
  const walletBalance = Number.isFinite(snapshot.current.walletBalanceUsdt) ? snapshot.current.walletBalanceUsdt! : snapshot.current.marginEquityUsdt - snapshot.current.unrealizedPnlUsdt;
  const walletChange = Number.isFinite(snapshot.current.walletChangeUsdt) ? snapshot.current.walletChangeUsdt! : walletBalance - snapshot.baselineUsdt;
  const sourceAge = clock - Date.parse(envelope.sourceAsOf || snapshot.sourceAsOf);
  const stale = envelope.status !== "OK" || !Number.isFinite(sourceAge) || sourceAge > 120_000 || sourceAge < -5000 || Boolean(error);
  const executionHealthy = snapshot.executionHealth?.status === "RECONCILED";
  const strategyLedgerCoverageDifference = snapshot.accountingBridge?.strategyLedgerCoverageDifferenceUsdt ?? 0;
  const strategyLedgerCovered = Math.abs(strategyLedgerCoverageDifference) < 0.01;
  const settlementEvidence = snapshot.metrics.settlementEvidence;
  const settlementTimelineComplete = settlementEvidence?.status === "COMPLETE" && settlementEvidence.drawdownEligible;

  return <main className={styles.page} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}>
    <a className={styles.testPortal} href="/v3-equity/px-research" aria-label="打开 Px 距离与回踩研究记录"><span>Px 距离与回踩研究</span><span>仅研究 · 查看三方案对照 →</span></a>
    <a className={styles.testPortal} href="/v3-equity/hf12a-shadow" aria-label="打开 HF12-A 影子测试数据记录">
      <span>TEST</span><b>HF12-A 数据记录</b><i>↗</i>
    </a>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.identity}><span className={styles.brand}>V3</span><div><p>ORION · {sourceVersionLabel}</p><h1>V3 监视器</h1></div></div>
        <div className={styles.sync}><span className={stale ? styles.staleDot : styles.liveDot}/><div><b>{stale ? MONITOR_COMMON_COPY.stale : MONITOR_COMMON_COPY.healthy}</b><small>{MONITOR_COMMON_COPY.sourceTime} · {time(envelope.sourceAsOf)} CST</small></div><button aria-label={MONITOR_COMMON_COPY.refresh} title={MONITOR_COMMON_COPY.refresh} onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "···" : "↻"}</button></div>
      </header>

      {stale && <div className={styles.notice}><b>{bootstrap ? `内置历史快照 · ${sourceVersionLabel}` : "数据已过期 · 当前信号已隐藏"}</b><span>{error ?? (bootstrap ? "尚未收到最新运行数据，以下为历史记录" : "以下余额和持仓为上次记录，等待最新快照")}</span></div>}
      {!executionHealthy && <div className={styles.criticalNotice}><b>执行一致性异常 · 新开仓已冻结</b><span>保护 {snapshot.executionHealth?.protectedPositionCount ?? 0}/{snapshot.executionHealth?.livePositionCount ?? positions.length} · 待恢复 {snapshot.executionHealth?.pendingOperationCount ?? 0} · {(snapshot.executionHealth?.errors ?? ["执行对账缺失"]).join(" · ")}</span></div>}
      {snapshot.abnormalLossGate?.entriesBlocked && <div className={styles.criticalNotice}><b>异常单笔亏损{abnormalLossGateLabel(snapshot.abnormalLossGate.status)} · 新开仓已冻结</b><span>{snapshot.abnormalLossGate.activeTrigger ? `${snapshot.abnormalLossGate.activeTrigger.symbol} · 计划最大 ${money(snapshot.abnormalLossGate.activeTrigger.plannedMaximumLossUsdt)} USDT · 实际 ${money(snapshot.abnormalLossGate.activeTrigger.actualLossUsdt)} USDT · ${snapshot.abnormalLossGate.activeTrigger.actualLossR?.toFixed(2) ?? "—"}R · 超额 ${money(snapshot.abnormalLossGate.activeTrigger.excessLossUsdt)} USDT` : snapshot.abnormalLossGate.manualResetRequired ? "等待老板授权解锁" : `健康对账 ${snapshot.abnormalLossGate.orangeHealthyCycles}/${snapshot.abnormalLossGate.orangeHealthyCyclesRequired}`}</span></div>}
      {!strategyLedgerCovered && <div className={styles.accountingNotice}><b>收益归因未闭合 · 不得作为策略收益</b><span>账户与策略结算账本相差 {signed(strategyLedgerCoverageDifference)} USDT，等待成交归属证据补齐</span></div>}

      <section className={styles.summary} aria-label="权益摘要">
        <div className={styles.primaryMetric}><small>{stale ? "上次权益" : "当前权益"}</small><strong>{money(snapshot.current.marginEquityUsdt)}</strong><em>USDT</em><span className={accountChange >= 0 ? styles.positive : styles.negative}>{signed(accountChange)} / 起始</span></div>
        <div className={styles.metric}><small>钱包余额</small><b>{money(walletBalance)}</b><span>USDT</span></div>
        <div className={styles.metric}><small>钱包累计变化</small><b className={walletChange >= 0 ? styles.positive : styles.negative}>{signed(walletChange)}</b><span>USDT</span></div>
        <div className={styles.metric}><small>{stale ? "上次浮动" : "当前浮动"}</small><b className={snapshot.current.unrealizedPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(snapshot.current.unrealizedPnlUsdt)}</b><span>USDT</span></div>
      </section>

      {cohorts.length > 0 && <details className={styles.cohorts}>
        <summary className={styles.cohortTitle}><h2>历史成交按版本汇总</h2><span>展开查看</span></summary>
        <div className={styles.cohortGrid}>{cohorts.map((cohort) => <article className={cohort.evaluationCohortId === snapshot.evaluationCohortId ? styles.forwardCohort : styles.baselineCohort} key={cohort.evaluationCohortId ?? cohort.classification} title={cohort.evaluationCohortId ?? cohort.classification}>
          <div><small>{cohortLabel(cohort)}</small><b className={cohort.realizedNetPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(cohort.realizedNetPnlUsdt)} USDT</b></div>
          <dl><div><dt>已平</dt><dd>{cohort.closedTradeCount}</dd></div><div><dt>持仓</dt><dd>{cohort.openPositionCount}</dd></div><div><dt>手续费</dt><dd>{money(cohort.totalCommissionUsdt)}</dd></div></dl>
        </article>)}</div>
      </details>}

      <section className={styles.chartCard}>
        <div className={styles.sectionHead}><div><p>策略结算学习口径 · 不等同账户钱包余额</p><h2>{settlementTimelineComplete ? "策略已实现权益" : "已知时点的结算曲线"}</h2></div>{point && <div className={styles.pointMeta}><span>{point.kind === "BASELINE" ? "起始" : point.settlementCount > 1 ? `${point.settlementCount} 笔结算` : point.symbol} · {time(point.timestamp, true)}</span><b className={point.deltaUsdt >= 0 ? styles.positive : styles.negative}>{signed(point.deltaUsdt)} USDT</b><small>{money(point.realizedLearningEquityUsdt)} USDT</small></div>}</div>
        {!settlementTimelineComplete && <div className={styles.accountingNotice} role="status"><b>历史结算时点证据不完整 · 暂不计算完整最大回撤</b><span>{settlementEvidence?.unlocatedSettlementCount ? `${settlementEvidence.unlocatedSettlementCount} 笔结算（含 ${settlementEvidence.unlocatedPartialCount ?? "待核对"} 笔分批）缺少完整时点或金额证据。` : "部分结算的时点或金额证据尚待核对。"}{settlementEvidence?.unlocatedNetPnlUsdt != null ? ` 尚未归入曲线的净收益 ${signed(settlementEvidence.unlocatedNetPnlUsdt)} USDT。` : ""}曲线仅展示可定位记录，终值可能与当前累计收益不同；上方账户权益保留实际余额。</span></div>}
        <EquityCurve points={points} selected={selected} onSelect={setSelected}/>
      </section>

      <section className={styles.positions}>
        <div className={styles.positionsHead}><div><h2>{stale ? "上次持仓记录" : MONITOR_COMMON_COPY.positions}</h2><span>{positions.length} / {maximumOpenPositions} 仓</span></div><small>浮动 {signed(snapshot.current.unrealizedPnlUsdt)} USDT</small></div>
        <div className={styles.tableHead}><span>标的 / 方向</span><span>价格路径</span><span>浮动盈亏</span><span>管理阶段</span></div>
        {positions.length ? positions.map((position) => <article className={styles.position} key={position.symbol}>
          <div className={styles.symbol}><b>{position.symbol}</b><span className={position.side === "LONG" ? styles.long : styles.short}>{position.side === "LONG" ? "多" : "空"}</span></div>
          <div className={styles.pricePath}><small>入场</small><b>{price(position.entryPrice)}</b><i>→</i><small>{stale ? "上次标记" : "标记"}</small><b>{price(position.markPrice)}</b></div>
          <div className={styles.pnl}><b className={position.unrealizedPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(position.unrealizedPnlUsdt)}</b><small>USDT</small></div>
          <div className={`${styles.stage} ${position.protectionStatus === "PROTECTED" ? styles.protected : styles.unprotected}`}>{position.protectionStatus === "PROTECTED" ? `${stale ? "上次：" : ""}已保护 · ${stage(position.stage)}` : `${position.managed === false ? "未纳管 · " : ""}无保护`}<small>计划最大亏损 {position.plannedMaximumLossUsdt ? `${money(position.plannedMaximumLossUsdt)} USDT` : "—"}</small></div>
        </article>) : <div className={styles.empty}>{stale ? "上次记录为空仓" : "当前空仓"}</div>}
      </section>

      <section className={styles.candidates} aria-label="V3 候选计划">
        <div className={styles.candidatesHead}><div><h2>{MONITOR_COMMON_COPY.candidates}</h2>{candidateView.status === "CURRENT" && <span>{candidates.length} 个</span>}</div>{candidateView.status === "CURRENT" && <small>1H 单Z · 15M 交汇 · 15M 入场</small>}</div>
        {candidates.length > 0 && <div className={styles.candidateTableHead}><span>标的 / 队列</span><span>结构 / Z 证据</span><span>数学交汇</span><span>交汇价</span><span>15M 确认 / 质量</span></div>}
        {candidates.length ? candidates.map((candidate) => <article className={styles.candidate} key={candidate.id}>
          <div className={styles.candidateSymbol}><b>{candidate.symbol}</b><span>{candidate.queuePosition || "—"}/{candidate.queueSize || candidates.length}</span></div>
          <div className={styles.candidateStructure}><b>{pattern(candidate.pattern)}</b><small>{candidate.primaryLineStatus === "ACTIVE_1H_TREND" ? "当前 1H 结构" : "保留 1H 结构"}</small><small>{singleZLabel(candidate.singleZ)}</small></div>
          <div className={styles.candidateTime}><b>{time(candidate.intersectionTime, true)}</b><small>{countdown(candidate.intersectionTime, clock)}</small></div>
          <div className={styles.candidatePrice}>{price(candidate.intersectionPrice)}</div>
          <div className={styles.candidateState}><b className={candidate.direction === 1 ? styles.positive : candidate.direction === -1 ? styles.negative : undefined}>15M · {entryStatus(candidate.entryStatus, candidate.direction, "15M")}</b><small>{candidate.automaticExecutionAllowed ? "正式候选" : "观察候选"} · 稳定 {(candidate.stabilityScore * 100).toFixed(0)}% · 支持 {candidate.support}</small></div>
        </article>) : <div className={styles.empty}>{candidateView.status === "STALE" ? "数据已过期，候选状态待更新" : candidateView.status === "INACTIVE_REVISION" ? "等待当前执行版本的候选数据" : MONITOR_COMMON_COPY.emptyCandidates}</div>}
      </section>

      <footer><span>每 30 秒自动同步</span><span>异常亏损闸门 · {abnormalLossGateLabel(snapshot.abnormalLossGate?.status)}</span><span>{Math.max(points.length - 1, 0)} 个小时节点 · {candidateView.status === "CURRENT" ? `${candidates.length} 个候选` : "候选待更新"}</span></footer>
    </div>
  </main>;
}
