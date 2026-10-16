"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { abnormalLossGateLabel, MONITOR_COMMON_COPY, MONITOR_PRESENTATION_REVISION } from "../monitor-sync";
import bootstrapSnapshot from "./bootstrap-snapshot.json";
import styles from "./v4-monitor.module.css";

type Direction = "LONG" | "SHORT";
type Filter = "ALL" | "NEAR" | "QUALIFIED" | "CONFIRMED";
type Position = { symbol: string; side: Direction; entryPrice: number; markPrice: number; unrealizedPnlUsdt: number; leverage: number; stopPrice: number; stage: string; openedAt: number; protected: boolean; plannedMaximumLossUsdt?: number; redLossThresholdUsdt?: number };
type Candidate = { id: string; symbol: string; pattern: string; intersectionTime: number; intersectionPrice: number; stabilityScore: number; support: number; signalStatus: string; economicPrequalified: boolean; assessmentReason?: string; signalReason?: string; committed?: boolean; anchorQualityScore?: number; fourHourHierarchyMultiplier?: number; oneHourHierarchyMultiplier?: number };
type Campaign = { active: boolean; tier: string; highWaterPnlUsdt: number; freezeUntil: number | null };
type Settlement = { symbol: string; side: Direction; closedAt: number; netPnlUsdt: number; realizedR: number | null; reason: string };
type HistoryPoint = { sourceAsOf: string; marginEquityUsdt: number; walletBalanceUsdt: number; unrealizedPnlUsdt: number };
type Snapshot = {
  sourceAsOf: string; strategyDisplayName: string; implementationRevision: string; baselineUsdt?: number;
  account: { walletBalanceUsdt: number; marginEquityUsdt: number; availableBalanceUsdt: number; unrealizedPnlUsdt: number };
  risk: { maximumRiskPerEntryFraction: number; maximumPortfolioRiskFraction: number; maximumOpenPositionsTotal: number; maximumEffectiveNotionalLeverage: number; actualEffectiveNotionalLeverage: number; openPositionCount: number; protectedPositionCount: number };
  execution: { status: string; accountReconciliationStatus?: string; engineStatus?: string; engineLastError?: string; automaticCycleAt?: string; causalBboStatus?: string; causalBboAgeMs?: number | null; degraded?: boolean; pendingOperationCount: number; standardOpenOrderCount: number; activeAlgoOrderCount: number };
  abnormalLossGate?: { status: string; entriesBlocked: boolean; manualResetRequired: boolean; orangeHealthyCycles: number; orangeHealthyCyclesRequired: number; activeTrigger: { symbol: string; plannedMaximumLossUsdt: number; actualLossUsdt: number; actualLossR: number | null; excessLossUsdt: number; trigger: string } | null };
  system: { planCount: number; economicPrequalifiedCount: number; confirmedSignalCount: number; broadUniverseSize: number; scanIntervalMs: number };
  r21ProfitProtection: { minimumSameDirectionPositions: number; eligibleSymbols: string[]; excludedSymbols: string[]; freezeEligibleEntries: boolean; frozenDirections: string[]; lastEvaluatedAt: number; campaigns: Record<Direction, Campaign> };
  positions: Position[]; candidates: Candidate[]; settlements?: Settlement[];
};
type Envelope = { status: string; sourceAsOf: string; receivedAt: string; snapshot: Snapshot; history?: HistoryPoint[] };

const bootstrap = bootstrapSnapshot as Snapshot;
const initialEnvelope: Envelope = { status: "BOOTSTRAP_SNAPSHOT", sourceAsOf: bootstrap.sourceAsOf, receivedAt: bootstrap.sourceAsOf, snapshot: bootstrap, history: [{ sourceAsOf: bootstrap.sourceAsOf, marginEquityUsdt: bootstrap.account.marginEquityUsdt, walletBalanceUsdt: bootstrap.account.walletBalanceUsdt, unrealizedPnlUsdt: bootstrap.account.unrealizedPnlUsdt }] };
const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const compactTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function money(value: number) { const normalized = Math.abs(value) < .005 ? 0 : value; return `${normalized < 0 ? "−" : ""}${moneyFormatter.format(Math.abs(normalized))}`; }
function signed(value: number) { return `${value > 0 ? "+" : ""}${money(value)}`; }
function percent(value: number, signedValue = false) { const normalized = Math.abs(value) < .005 ? 0 : value; return `${signedValue && normalized > 0 ? "+" : normalized < 0 ? "−" : ""}${Math.abs(normalized).toFixed(2)}%`; }
function price(value: number) { return value.toLocaleString("en-US", { maximumFractionDigits: 8 }); }
function time(value: number | string, compact = false) { return (compact ? compactTimeFormatter : timeFormatter).format(new Date(value)).replaceAll("/", "-"); }
function asset(symbol: string) { return symbol.replace(/USDT$/, ""); }
function stage(value: string) { return ({ INITIAL_PROTECTION: "初始保护", SOFT_LOCK_80_REMAINING: "柔性锁利", AFTER_1R_50_REMAINING: "1R 管理", RUNNER_25: "尾仓巡航" } as Record<string, string>)[value] ?? "持续管理"; }
function pattern(value: string) { return value === "4H_ASC_LOW__1H_DESC_HIGH" ? "4H 上升低点 × 1H 下降高点" : value === "4H_DESC_HIGH__1H_ASC_LOW" ? "4H 下降高点 × 1H 上升低点" : value.replaceAll("_", " "); }
function countdown(target: number, now: number) { const difference = target - now; if (difference <= 0) return "交汇已到达"; const minutes = Math.ceil(difference / 60_000); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes % 60}分` : `${minutes}分钟`; }
function signalLabel(candidate: Candidate) { if (candidate.signalStatus.startsWith("CONFIRMED_LONG")) return "已确认 · 多"; if (candidate.signalStatus.startsWith("CONFIRMED_SHORT")) return "已确认 · 空"; if (candidate.economicPrequalified) return "经济预选"; if (candidate.committed) return "结构已承诺"; return "观察"; }
function campaignLabel(campaign: Campaign) { if (!campaign.active) return "待机"; return ({ WARNING: "预警", DEFENSE: "防守", HARD: "强保护" } as Record<string, string>)[campaign.tier] ?? campaign.tier; }
function directionalMove(position: Position) { if (!position.entryPrice) return 0; const raw = (position.markPrice - position.entryPrice) / position.entryPrice * 100; return position.side === "LONG" ? raw : -raw; }
function protectionDistance(position: Position) { if (!position.markPrice || !position.stopPrice) return 0; return Math.abs(position.markPrice - position.stopPrice) / position.markPrice * 100; }
function candidateScore(candidate: Candidate) { return (candidate.stabilityScore * .7 + (candidate.anchorQualityScore ?? candidate.stabilityScore) * .3) * 100; }

function OrionMark() {
  return <svg viewBox="0 0 48 48" role="img" aria-label="ORION V4">
    <circle cx="24" cy="24" r="5.5" />
    <ellipse cx="24" cy="24" rx="18" ry="8.5" />
    <ellipse cx="24" cy="24" rx="18" ry="8.5" transform="rotate(60 24 24)" />
    <ellipse cx="24" cy="24" rx="18" ry="8.5" transform="rotate(120 24 24)" />
    <circle className={styles.logoNode} cx="40" cy="30" r="2.5" />
  </svg>;
}

function EquityChart({ points }: { points: HistoryPoint[] }) {
  const [selected, setSelected] = useState(points.at(-1) ?? null);
  useEffect(() => setSelected(points.at(-1) ?? null), [points]);
  const geometry = useMemo(() => {
    const values = points.map((point) => point.marginEquityUsdt);
    const minRaw = Math.min(...values, 5_000), maxRaw = Math.max(...values, 5_000), pad = Math.max((maxRaw - minRaw) * .18, 8);
    const min = minRaw - pad, max = maxRaw + pad;
    const x = (index: number) => points.length <= 1 ? 320 : 28 + index / (points.length - 1) * 584;
    const y = (value: number) => 13 + (max - value) / Math.max(max - min, 1) * 86;
    const coordinates = points.map((point, index) => ({ point, x: x(index), y: y(point.marginEquityUsdt) }));
    return { coordinates, line: coordinates.map((row) => `${row.x},${row.y}`).join(" ") };
  }, [points]);
  const active = selected ?? points.at(-1);
  return <div className={styles.equityChart}>
    <div className={styles.chartReadout}><span>{active ? time(active.sourceAsOf, true) : "等待历史"}</span><b>{active ? `${money(active.marginEquityUsdt)} USDT` : "—"}</b></div>
    <svg viewBox="0 0 640 118" preserveAspectRatio="none" role="img" aria-label="V4 账户权益轨迹">
      {[0, 1, 2].map((row) => <line key={row} x1="28" x2="612" y1={14 + row * 42} y2={14 + row * 42} className={styles.chartGrid}/>) }
      {geometry.coordinates.length > 1 && <polygon points={`${geometry.line} 612,100 28,100`} className={styles.chartFill}/>}<polyline points={geometry.line} className={styles.chartLine}/>
      {geometry.coordinates.map((row) => <circle key={row.point.sourceAsOf} cx={row.x} cy={row.y} r="8" className={styles.chartHit} onPointerEnter={() => setSelected(row.point)} onPointerDown={() => setSelected(row.point)}/>) }
      {geometry.coordinates.map((row) => <circle key={`${row.point.sourceAsOf}:dot`} cx={row.x} cy={row.y} r="2.7" className={styles.chartDot}/>) }
    </svg>
    <div className={styles.chartAxis}><span>{points[0] ? time(points[0].sourceAsOf, true) : "—"}</span><span>{points.at(-1) ? time(points.at(-1)!.sourceAsOf, true) : "—"}</span></div>
  </div>;
}

export default function V4MonitorPage() {
  const [envelope, setEnvelope] = useState<Envelope>(initialEnvelope);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clock, setClock] = useState(() => Date.parse(initialEnvelope.sourceAsOf));
  const [filter, setFilter] = useState<Filter>("ALL");
  const [expandedCandidate, setExpandedCandidate] = useState<string | null>(null);
  const [expandedPosition, setExpandedPosition] = useState<string | null>(null);
  const snapshot = envelope.snapshot;

  const refresh = useCallback(async (visible = true) => {
    if (visible) setRefreshing(true);
    try { const response = await fetch("/api/v4-monitor", { cache: "no-store" }); if (!response.ok) throw new Error("监视器数据暂不可用"); setEnvelope(await response.json() as Envelope); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "监视器数据暂不可用"); }
    finally { if (visible) setRefreshing(false); }
  }, []);
  useEffect(() => { setClock(Date.now()); void refresh(false); const syncTimer = window.setInterval(() => void refresh(false), 30_000); const clockTimer = window.setInterval(() => setClock(Date.now()), 10_000); return () => { window.clearInterval(syncTimer); window.clearInterval(clockTimer); }; }, [refresh]);

  const baseline = snapshot.baselineUsdt ?? 5_000;
  const accountChange = snapshot.account.marginEquityUsdt - baseline;
  const accountChangeFraction = baseline > 0 ? accountChange / baseline * 100 : 0;
  const ageMs = Math.max(0, clock - Date.parse(snapshot.sourceAsOf));
  const accountHealthy = (snapshot.execution.accountReconciliationStatus ?? snapshot.execution.status) === "RECONCILED";
  const engineHealthy = snapshot.execution.engineStatus === "RUNNING";
  const causalBboHealthy = snapshot.execution.causalBboStatus === "LIVE";
  const operationalHealthy = accountHealthy && engineHealthy && causalBboHealthy && snapshot.execution.degraded !== true;
  const stale = ageMs > 120_000 || envelope.status !== "OK" || !operationalHealthy;
  const leverageUsage = Math.min(1, snapshot.risk.actualEffectiveNotionalLeverage / Math.max(snapshot.risk.maximumEffectiveNotionalLeverage, .01));
  const riskRing = { "--risk": `${Math.max(1.4, leverageUsage * 100)}%` } as CSSProperties;
  const history = envelope.history?.length ? envelope.history : [{ sourceAsOf: snapshot.sourceAsOf, marginEquityUsdt: snapshot.account.marginEquityUsdt, walletBalanceUsdt: snapshot.account.walletBalanceUsdt, unrealizedPnlUsdt: snapshot.account.unrealizedPnlUsdt }];
  const eligibleSet = useMemo(() => new Set(snapshot.r21ProfitProtection.eligibleSymbols), [snapshot.r21ProfitProtection.eligibleSymbols]);
  const directionCounts = useMemo(() => snapshot.positions.reduce((result, position) => { if (eligibleSet.has(position.symbol)) result[position.side] += 1; return result; }, { LONG: 0, SHORT: 0 } as Record<Direction, number>), [eligibleSet, snapshot.positions]);
  const allCandidates = useMemo(() => [...snapshot.candidates].sort((left, right) => left.intersectionTime - right.intersectionTime), [snapshot.candidates]);
  const nearCount = allCandidates.filter((candidate) => candidate.intersectionTime > clock && candidate.intersectionTime - clock <= 6 * 60 * 60_000).length;
  const qualityCount = allCandidates.filter((candidate) => candidate.stabilityScore >= .65).length;
  const dataGapCount = snapshot.execution.pendingOperationCount + (accountHealthy ? 0 : 1) + (engineHealthy ? 0 : 1) + (causalBboHealthy ? 0 : 1);
  const candidates = allCandidates.filter((candidate) => filter === "ALL" || filter === "NEAR" && candidate.intersectionTime > clock && candidate.intersectionTime - clock <= 6 * 60 * 60_000 || filter === "QUALIFIED" && candidate.economicPrequalified || filter === "CONFIRMED" && candidate.signalStatus.startsWith("CONFIRMED"));
  const funnels = [["结构候选", snapshot.system.planCount], ["稳定度 ≥ 0.65", qualityCount], ["经济预选", snapshot.system.economicPrequalifiedCount], ["15M 已确认", snapshot.system.confirmedSignalCount], ["当前持仓", snapshot.risk.openPositionCount]] as const;
  const maximumFunnel = Math.max(...funnels.map(([, value]) => value), 1);

  return <main className={styles.page} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}>
    <div className={styles.shell}>
      <header className={styles.topbar}><div className={styles.brandLockup}><div className={styles.mark}><OrionMark/></div><div><strong>ORION <em>V4</em></strong><small>MTFX · FORWARD CONTROL</small></div></div><nav aria-label="监视器区域"><a href="#overview">总览</a><a href="#opportunities">机会</a><a href="#positions">持仓</a><a href="#risk">风险</a></nav><div className={styles.syncControls}><div className={stale ? styles.staleSignal : styles.liveSignal}><i/><span>{stale ? MONITOR_COMMON_COPY.stale : MONITOR_COMMON_COPY.healthy}</span><small>{time(snapshot.sourceAsOf)}</small></div><button type="button" onClick={() => void refresh()} disabled={refreshing} aria-label={MONITOR_COMMON_COPY.refresh}>{refreshing ? "···" : "↻"}</button></div></header>
      {error && <div className={styles.notice}><b>数据链路提示</b><span>{error}，当前保留最近一次有效快照。</span></div>}
      {!error && !operationalHealthy && <div className={styles.notice}><b>执行链路已降级</b><span>账户对账 {accountHealthy ? "正常" : "异常"} · 自动引擎 {engineHealthy ? "正常" : snapshot.execution.engineStatus ?? "未知"} · 因果 BBO {causalBboHealthy ? "正常" : snapshot.execution.causalBboStatus ?? "未知"}{snapshot.execution.engineLastError ? ` · ${snapshot.execution.engineLastError}` : ""}</span></div>}
      {snapshot.abnormalLossGate?.entriesBlocked && <div className={styles.notice}><b>异常单笔亏损{abnormalLossGateLabel(snapshot.abnormalLossGate.status)} · 新开仓已冻结</b><span>{snapshot.abnormalLossGate.activeTrigger ? `${snapshot.abnormalLossGate.activeTrigger.symbol} · 计划最大 ${money(snapshot.abnormalLossGate.activeTrigger.plannedMaximumLossUsdt)} USDT · 实际 ${money(snapshot.abnormalLossGate.activeTrigger.actualLossUsdt)} USDT · ${snapshot.abnormalLossGate.activeTrigger.actualLossR?.toFixed(2) ?? "—"}R · 超额 ${money(snapshot.abnormalLossGate.activeTrigger.excessLossUsdt)} USDT` : snapshot.abnormalLossGate.manualResetRequired ? "等待老板授权解锁" : `健康对账 ${snapshot.abnormalLossGate.orangeHealthyCycles}/${snapshot.abnormalLossGate.orangeHealthyCyclesRequired}`}</span></div>}

      <section className={styles.accountPanel} id="overview">
        <div className={styles.panelHeader}><div><p><i/> ORION V4 · FORWARD DEMO</p><h1>V4—MTFX <span>R22</span></h1><small>4H / 1H 价格时间交汇 · 15M 两根收盘确认</small></div><div className={styles.modeActions}><span>◇ 仅模拟 · 无主网路由</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>↻ 刷新</button></div></div>
        <div className={styles.accountGrid}>
          <article className={styles.equitySummary}><small>账户权益</small><div className={styles.equityValue}><strong>{money(snapshot.account.marginEquityUsdt)}</strong><em>USDT</em></div><b className={accountChange >= 0 ? styles.positive : styles.negative}>{signed(accountChange)} · {percent(accountChangeFraction, true)}</b><div className={styles.balanceGrid}><span><small>可用余额</small><b>{money(snapshot.account.availableBalanceUsdt)}</b></span><span><small>钱包余额</small><b>{money(snapshot.account.walletBalanceUsdt)}</b></span></div></article>
          <article className={styles.trajectory}><div className={styles.subhead}><span>权益轨迹</span><small>{money(history[0]?.marginEquityUsdt ?? baseline)} → {money(history.at(-1)?.marginEquityUsdt ?? snapshot.account.marginEquityUsdt)}</small></div><EquityChart points={history}/></article>
          <article className={styles.riskSummary} id="risk"><div className={styles.riskRing} style={riskRing}><div><strong>{percent(leverageUsage * 100)}</strong><small>杠杆占用</small></div></div><dl><div><dt>组合风险上限</dt><dd>{percent(snapshot.risk.maximumPortfolioRiskFraction * 100)}</dd></div><div><dt>持仓槽位</dt><dd>{snapshot.risk.openPositionCount} / {snapshot.risk.maximumOpenPositionsTotal}</dd></div><div><dt>单笔风险</dt><dd>{percent(snapshot.risk.maximumRiskPerEntryFraction * 100)}</dd></div><div><dt>有效杠杆</dt><dd>{snapshot.risk.actualEffectiveNotionalLeverage.toFixed(2)}x / {snapshot.risk.maximumEffectiveNotionalLeverage}x</dd></div></dl></article>
        </div>
      </section>

      <section className={styles.kpiStrip} aria-label="运行状态摘要"><article><small>结构候选</small><strong>{snapshot.system.planCount}</strong><span>固定十币扫描</span></article><article><small>近场机会</small><strong className={styles.green}>{nearCount}</strong><span>未来 ≤ 6 小时</span></article><article><small>高稳定结构</small><strong>{qualityCount}</strong><span>稳定度 ≥ 0.65</span></article><article><small>15M 已确认</small><strong className={styles.blue}>{snapshot.system.confirmedSignalCount}</strong><span>两根收盘后</span></article><article><small>数据缺口</small><strong className={dataGapCount ? styles.negative : styles.green}>{dataGapCount}</strong><span>{dataGapCount ? "fail-closed" : "链路正常"}</span></article><article><small>亏损闸门</small><strong className={snapshot.abnormalLossGate?.entriesBlocked ? styles.negative : styles.green}>{abnormalLossGateLabel(snapshot.abnormalLossGate?.status)}</strong><span>{snapshot.abnormalLossGate?.entriesBlocked ? "新仓冻结" : "前向监测"}</span></article></section>

      <section className={styles.dashboardGrid}>
        <article className={styles.radarCard} id="opportunities">
          <div className={styles.cardHeader}><div><span>01</span><div><h2>机会雷达</h2><p>按交汇时刻、结构质量与确认状态排序</p></div></div><div className={styles.filters}>{(["ALL", "NEAR", "QUALIFIED", "CONFIRMED"] as Filter[]).map((value) => <button type="button" key={value} onClick={() => setFilter(value)} className={filter === value ? styles.filterActive : ""}>{({ ALL: "全部", NEAR: "近场", QUALIFIED: "预选", CONFIRMED: "确认" } as Record<Filter, string>)[value]}</button>)}</div></div>
          <div className={styles.radarLegend}><span>标的 / 结构</span><span>交汇时刻</span><span>稳定度</span><span>评分</span><span>状态</span></div>
          <div className={styles.radarRows}>{candidates.length ? candidates.map((candidate, index) => { const expanded = expandedCandidate === candidate.id, score = candidateScore(candidate); return <div className={styles.radarItem} key={candidate.id}><button type="button" className={styles.radarRow} onClick={() => setExpandedCandidate(expanded ? null : candidate.id)} aria-expanded={expanded}><span className={styles.rank}>{String(index + 1).padStart(2, "0")}</span><span className={styles.radarSymbol}><b>{asset(candidate.symbol)}</b><small>{pattern(candidate.pattern)}</small></span><span className={styles.radarTime}><b>{time(candidate.intersectionTime, true)}</b><small>{countdown(candidate.intersectionTime, clock)}</small></span><span className={styles.stabilityCell}><b>{percent(candidate.stabilityScore * 100)}</b><i><em style={{ width: `${candidate.stabilityScore * 100}%` }}/></i></span><span className={styles.score}>{percent(score)}</span><span className={candidate.signalStatus.startsWith("CONFIRMED") ? styles.statusConfirmed : candidate.economicPrequalified ? styles.statusQualified : styles.statusWatch}>{signalLabel(candidate)}</span></button>{expanded && <div className={styles.radarDetail}><span><small>交汇价</small><b>{price(candidate.intersectionPrice)}</b></span><span><small>锚点质量</small><b>{percent((candidate.anchorQualityScore ?? 0) * 100)}</b></span><span><small>层级</small><b>4H {candidate.fourHourHierarchyMultiplier || "—"}× · 1H {candidate.oneHourHierarchyMultiplier || "—"}×</b></span><span><small>支持</small><b>{candidate.support}</b></span><span><small>信号原因</small><b>{candidate.signalReason?.replaceAll("_", " ")}</b></span></div>}</div>; }) : <div className={styles.empty}>该筛选下暂无候选计划</div>}</div>
        </article>

        <div className={styles.middleStack}>
          <article className={styles.funnelCard}><div className={styles.cardHeader}><div><span>02</span><div><h2>信号漏斗</h2><p>当前扫描周期</p></div></div></div><div className={styles.funnels}>{funnels.map(([label, value], index) => <div key={label}><span>{label}</span><i><em style={{ width: `${Math.max(value ? 8 : 0, value / maximumFunnel * 100)}%`, animationDelay: `${index * 55}ms` }}/></i><b>{value}</b></div>)}</div><footer><span>候选总量 {snapshot.system.planCount}</span><span>累计已结算 {snapshot.settlements?.length ?? 0}</span></footer></article>
          <article className={styles.heartbeatCard}><div className={styles.cardHeader}><div><span>03</span><div><h2>数据心跳</h2><p>账户、引擎与行情分层核验</p></div></div><b className={stale ? styles.warnPill : styles.okPill}>● {stale ? "链路降级" : "运行正常"}</b></div><div className={styles.heartbeatTime}><small>最近扫描</small><b>{time(snapshot.sourceAsOf)}</b><span>{Math.floor(ageMs / 1000)} 秒前</span></div><div className={styles.heartbeatGrid}><span><small>账户对账</small><b>{accountHealthy ? "正常" : "异常"}</b></span><span><small>自动引擎</small><b>{engineHealthy ? "运行" : "降级"}</b></span><span><small>因果 BBO</small><b>{causalBboHealthy ? "实时" : "陈旧"}</b></span><span><small>待恢复事务</small><b>{snapshot.execution.pendingOperationCount}</b></span></div></article>
          <article className={styles.shieldCard}><div className={styles.cardHeader}><div><span>R22</span><div><h2>浮盈保护</h2><p>V2 R22 · 八币合资格仓位</p></div></div></div>{(["LONG", "SHORT"] as Direction[]).map((direction) => { const campaign = snapshot.r21ProfitProtection.campaigns[direction]; return <div className={styles.shieldLane} key={direction}><span>{direction === "LONG" ? "多向" : "空向"}</span><i><em style={{ width: `${Math.min(100, directionCounts[direction] / Math.max(snapshot.r21ProfitProtection.minimumSameDirectionPositions, 1) * 100)}%` }}/></i><b>{directionCounts[direction]} / {snapshot.r21ProfitProtection.minimumSameDirectionPositions}</b><small>{campaignLabel(campaign)}</small></div>; })}</article>
        </div>

        <div className={styles.rightStack}>
          <article className={styles.positionsCard} id="positions"><div className={styles.cardHeader}><div><span>04</span><div><h2>{MONITOR_COMMON_COPY.positions}</h2><p>交易所状态与策略管理分离</p></div></div><b className={styles.countPill}>{snapshot.positions.length} / {snapshot.risk.maximumOpenPositionsTotal}</b></div><div className={styles.positionList}>{snapshot.positions.length ? snapshot.positions.map((position) => { const move = directionalMove(position), expanded = expandedPosition === position.symbol; return <button type="button" key={position.symbol} className={styles.positionRow} onClick={() => setExpandedPosition(expanded ? null : position.symbol)} aria-expanded={expanded}><span className={styles.positionSymbol}><b>{asset(position.symbol)}</b><small className={position.side === "LONG" ? styles.long : styles.short}>{position.side === "LONG" ? "多" : "空"}</small></span><span className={styles.positionPnl}><small>浮动</small><b className={position.unrealizedPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(position.unrealizedPnlUsdt)}</b></span><span className={styles.protection}><i/><b>{position.protected ? "保护在线" : "等待保护"}</b><small>{stage(position.stage)}</small></span>{expanded && <span className={styles.positionDetail}><em><small>入场</small><b>{price(position.entryPrice)}</b></em><em><small>标记</small><b>{price(position.markPrice)}</b></em><em><small>方向推进</small><b className={move >= 0 ? styles.positive : styles.negative}>{percent(move, true)}</b></em><em><small>保护余距</small><b>{percent(protectionDistance(position))}</b></em><em><small>计划最大亏损</small><b>{money(position.plannedMaximumLossUsdt ?? 0)} USDT</b></em></span>}</button>; }) : <div className={styles.empty}>当前没有运行中的仓位</div>}</div></article>
          <article className={styles.tapeCard}><div className={styles.cardHeader}><div><span>05</span><div><h2>模拟成交带</h2><p>仅展示已结算策略摘要</p></div></div></div><div className={styles.tape}>{snapshot.settlements?.length ? [...snapshot.settlements].reverse().map((row, index) => <div key={`${row.symbol}:${row.closedAt}:${index}`}><span><b>{asset(row.symbol)}</b><small>{row.side === "LONG" ? "多" : "空"} · {time(row.closedAt, true)}</small></span><b className={row.netPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(row.netPnlUsdt)}</b><small>{row.realizedR == null ? row.reason : `${row.realizedR.toFixed(2)}R`}</small></div>) : <div className={styles.empty}>尚无已结算成交记录</div>}</div></article>
        </div>
      </section>
      <footer className={styles.footer}><span>账户起始资金 {money(baseline)} USDT</span><span>DEMO · READ ONLY MONITOR</span><span>自动刷新 {Math.round(snapshot.system.scanIntervalMs / 1000)} 秒</span><span>{MONITOR_PRESENTATION_REVISION}</span></footer>
    </div>
  </main>;
}
