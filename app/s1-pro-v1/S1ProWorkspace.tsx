"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { candidateDisplayView, partitionCandidateFunnel } from "../../lib/s1-candidate-funnel.mjs";
import { arrivalCountdown } from "../../lib/s1-arrival.mjs";
import { signalFlow } from "../../lib/s1-signal-flow.mjs";
import { executionLabel } from "../s1/TradeLedger";
import { useLiveMarketQuotes } from "../s1/useLiveMarketQuotes";
import Backdrop from "./Backdrop";
import { IntroSequence, ScrambleText } from "./Cinematic";
import { buildDemoFeed, tickDemo } from "./demo-data";
import { spotlight, useTween } from "./motion";
import { CalendarPanel, CandidatesPanel, FillsPanel, HistoryPanel, PositionsPanel, Tween, clock } from "./Panels";
import { DirectionSplit, EquityChart, HeartbeatTrace, IntersectionTimeline } from "./Visuals";
import type { Candidate, ExecutionLedger, Feed, History, RiskCalendarFeed, Snapshot } from "./types";
import styles from "./s1-pro.module.css";

const POLL_MS = 15000;
const INTRO_KEY = "s1-pro-intro-seen";
const money = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signedMoney = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
const percent = (value: string | number) => new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(Number(value));

type Mode = { kind: "pending" } | { kind: "live" | "demo"; intro: boolean };

/* ======================================================================
   Entry: decide live vs demo on the client, then mount the matching feed.
   ====================================================================== */
export default function S1ProWorkspace() {
  const [mode, setMode] = useState<Mode>({ kind: "pending" });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      let seen = false;
      try { seen = window.sessionStorage.getItem(INTRO_KEY) === "1"; } catch { seen = false; }
      const intro = params.get("intro") === "1" ? true : params.get("intro") === "0" ? false : !seen;
      setMode({ kind: params.get("demo") === "1" ? "demo" : "live", intro });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  if (mode.kind === "pending") return <main className={styles.stage}><Backdrop /></main>;
  return mode.kind === "demo" ? <DemoRoot intro={mode.intro} /> : <LiveRoot intro={mode.intro} />;
}

/* ---------- live feed: same endpoints, cadence and backoff as /s1 ---------- */
function LiveRoot({ intro }: { intro: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<History | undefined>();
  const [ledger, setLedger] = useState<ExecutionLedger | undefined>();
  const [ledgerError, setLedgerError] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastPoll, setLastPoll] = useState(0);
  const [calendar, setCalendar] = useState<RiskCalendarFeed | null>(null);
  const [calendarFailure, setCalendarFailure] = useState(false);
  const [calendarKey, setCalendarKey] = useState(0);

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const request = (url: string) => fetch(url, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const [monitor, execution] = await Promise.allSettled([request("/api/s1-monitor"), request("/api/s1-execution-ledger")]);
        if (monitor.status !== "fulfilled" || !monitor.value.ok) throw new Error("MONITOR_UNAVAILABLE");
        const result = await monitor.value.json() as { snapshot: Snapshot | null; history?: History };
        if (!disposed) { setSnapshot(result.snapshot); setHistory(result.history); setError(result.snapshot ? "" : "等待服务器首份快照"); failures = 0; }
        if (execution.status === "fulfilled" && execution.value.ok) {
          const next = await execution.value.json() as ExecutionLedger;
          if (!disposed) { setLedger(next); setLedgerError(false); }
        } else if (!disposed) setLedgerError(true);
      } catch { if (!disposed) { setError("连接异常，正在自动重连；下方保留上次快照"); failures++; } }
      finally { if (!disposed) { setLoading(false); setLastPoll(Date.now()); timer = setTimeout(poll, Math.min(60000, POLL_MS * 2 ** Math.min(failures, 2))); } }
    };
    void poll();
    const visible = () => { if (!document.hidden) setRefreshKey(value => value + 1); };
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refreshKey]);

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/s1-risk-calendar", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), cache: "no-cache" });
        if (!response.ok) throw new Error("CALENDAR_UNAVAILABLE");
        const result = await response.json() as RiskCalendarFeed;
        if (!Array.isArray(result.events) || !Array.isArray(result.sources)) throw new Error("INVALID_CALENDAR");
        if (!disposed) { setCalendar(result); setCalendarFailure(false); }
      } catch { if (!disposed) setCalendarFailure(true); }
      finally { if (!disposed) timer = setTimeout(load, 60000); }
    };
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [calendarKey]);

  const live = useLiveMarketQuotes(snapshot?.marketQuotes ?? []);
  const feed: Feed = { snapshot, history, ledger, ledgerError, error, loading, quotes: live.quotes, quoteState: live.state, calendar, calendarFailure, demo: false };
  return <Dashboard feed={feed} intro={intro} lastPoll={lastPoll} onRefresh={() => { setLoading(true); setRefreshKey(value => value + 1); }} onCalendarRefresh={() => setCalendarKey(value => value + 1)} />;
}

/* ---------- demo feed: synthetic, only with ?demo=1 ---------- */
function DemoRoot({ intro }: { intro: boolean }) {
  const [state, setState] = useState<ReturnType<typeof buildDemoFeed> | null>(null);
  const [lastPoll, setLastPoll] = useState(0);
  useEffect(() => {
    const first = requestAnimationFrame(() => { setState(buildDemoFeed()); setLastPoll(Date.now()); });
    const tick = setInterval(() => setState(previous => previous ? tickDemo(previous) : previous), 1500);
    const cycle = setInterval(() => setLastPoll(Date.now()), POLL_MS);
    return () => { cancelAnimationFrame(first); clearInterval(tick); clearInterval(cycle); };
  }, []);
  const feed: Feed = { snapshot: state?.snapshot ?? null, history: state?.history, ledger: state?.ledger, ledgerError: false, error: "", loading: !state, quotes: state?.snapshot.marketQuotes ?? [], quoteState: "LIVE", calendar: state?.calendar ?? null, calendarFailure: false, demo: true };
  return <Dashboard feed={feed} intro={intro} lastPoll={lastPoll} onRefresh={() => setLastPoll(Date.now())} onCalendarRefresh={() => undefined} />;
}

/* ======================================================================
   Dashboard: presentation only. Health rules mirror /s1 exactly.
   ====================================================================== */
const NAV = [["overview", "概览"], ["equity", "权益"], ["positions", "持仓"], ["candidates", "候选"], ["fills", "成交"], ["risk-calendar", "事件"], ["runtime", "运行"]] as const;
const QUOTE_LABEL = { CONNECTING: "实时行情连接中", LIVE: "实时行情", PAUSED: "页面隐藏 · 行情暂停", RECONNECTING: "实时行情重连中", UNAVAILABLE: "实时行情暂不可用" } as const;

function Dashboard({ feed, intro, lastPoll, onRefresh, onCalendarRefresh }: { feed: Feed; intro: boolean; lastPoll: number; onRefresh: () => void; onCalendarRefresh: () => void }) {
  const { snapshot, history, ledger, ledgerError, error, loading, quotes, quoteState, calendar, calendarFailure, demo } = feed;
  const [now, setNow] = useState(0);
  const [showIntro, setShowIntro] = useState(intro);
  const [active, setActive] = useState<string>("overview");
  const [candidateReference, setCandidateReference] = useState<{ accountLabel: string; sourceAsOf: string; candidates: Candidate[] } | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, []);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progressRef.current?.style.setProperty("--progress", String(max > 0 ? window.scrollY / max : 0));
        let current = "overview";
        for (const [id] of NAV) { const top = document.getElementById(`s1p-${id}`)?.getBoundingClientRect().top; if (top != null && top <= 140) current = id; }
        if (window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = "runtime";
        setActive(current);
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);

  const finishIntro = useCallback(() => { setShowIntro(false); try { window.sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* storage unavailable */ } }, []);

  /* ----- health (identical rules to /s1) ----- */
  const age = snapshot && now ? Math.max(0, Math.floor((now - Date.parse(snapshot.sourceAsOf)) / 1000)) : null;
  const stale = age === null || age > 180;
  const accountAge = snapshot?.account.observedAt && now ? now - Date.parse(snapshot.account.observedAt) : Infinity;
  const accountHealthy = !stale && !error && !!snapshot?.account.fresh && accountAge >= -5000 && accountAge <= 120000;
  const executionAge = ledger?.execution?.observedAt && now ? now - Date.parse(ledger.execution.observedAt) : Infinity;
  const executionFresh = !ledgerError && ledger?.status === "OK" && executionAge >= -5000 && executionAge <= 180000;
  const healthy = !stale && !error && snapshot?.status === "HEALTHY";
  const view = candidateDisplayView({ snapshot, reference: candidateReference, accountLabel: "S1", execution: ledger?.execution, executionFresh, now, monitorError: !!error });
  const inputState = view.inputState as "READY" | "UNAVAILABLE" | "UNKNOWN";
  useEffect(() => {
    if (view.reference === candidateReference) return;
    const frame = requestAnimationFrame(() => setCandidateReference(view.reference));
    return () => cancelAnimationFrame(frame);
  }, [view.reference, candidateReference]);
  const candidates = view.candidates as Candidate[];
  const sourceUnavailable = inputState === "UNAVAILABLE";
  const execution = ledger?.execution;
  const executionHealthy = executionFresh && !!execution?.liveReady && !execution.entryIncident && inputState === "READY";
  const allNormal = accountHealthy && healthy && executionHealthy;
  const ready = inputState === "READY";
  const unavailable = stale || !!error;

  const account = snapshot?.account, details = account?.details;
  const points = history?.points ?? [];
  const firstPoint = points.find(point => Number.isFinite(point.equity)), lastPoint = [...points].reverse().find(point => Number.isFinite(point.equity));
  const windowDelta = firstPoint && lastPoint ? lastPoint.equity - firstPoint.equity : null;
  const windowPercent = windowDelta != null && firstPoint?.equity ? windowDelta / Math.abs(firstPoint.equity) * 100 : null;
  const utilization = details?.initialMargin != null && account?.equity != null && account.equity > 0 ? details.initialMargin / account.equity * 100 : null;
  const groups = partitionCandidateFunnel([...candidates].sort((a, b) => (Date.parse(a.intersectionTime ?? "") || Infinity) - (Date.parse(b.intersectionTime ?? "") || Infinity)), now, unavailable);
  const next = ready ? groups.upcoming[0] as Candidate | undefined : undefined;
  const priorityIds = new Set((ready ? execution?.candidatePriorities ?? [] : []).filter(row => row.state === "WAITING" || row.state === "SUBMITTING").map(row => row.planId));
  const waitingPlans = ready ? execution?.candidatePriorities?.filter(row => row.state === "WAITING").length ?? null : null;
  const counts = signalFlow(candidates, healthy, true);
  const execLabel = executionLabel(execution, executionFresh, now, inputState);
  const risk = execution?.strategyRuntime?.riskPolicy;
  const runtime = execution?.strategyRuntime;
  const nextSeconds = next && now ? (Date.parse(next.intersectionTime ?? "") - now) / 1000 : null;
  const equityTween = useTween(account?.equity ?? null);

  const beats = [
    { id: "account", label: "账户心跳", ok: accountHealthy, value: accountHealthy ? "正常" : "待恢复", at: clock(account?.observedAt) },
    { id: "scan", label: "扫描心跳", ok: healthy && !sourceUnavailable, value: sourceUnavailable ? "输入暂不可用" : healthy ? "正常" : "待恢复", at: clock(snapshot?.lastSuccessfulScanAt) },
    { id: "exec", label: "执行心跳", ok: executionHealthy, value: execLabel, at: clock(execution?.observedAt) },
  ];

  return <main className={styles.stage} data-demo={demo}>
    <Backdrop />
    <div className={styles.grain} aria-hidden="true" />
    {showIntro && <IntroSequence onDone={finishIntro} />}
    <a href="#s1p-candidates" className={styles.skip}>跳至候选计划</a>

    <header className={styles.topbar}>
      <div ref={progressRef} className={styles.progress} aria-hidden="true" />
      <a className={styles.brand} href="/s1-pro" aria-label="S1 Pro 首页">
        <span className={styles.brandMark} aria-hidden="true"><svg viewBox="0 0 64 64"><path d="M36 18H24L17 25L37 39L30 46H17" /><path d="M43 24L49 18V46" /></svg></span>
        <span><strong>S1 <em>Pro</em></strong><small>开源模拟账户 1 · BINANCE USDⓈ-M</small></span>
      </a>
      <nav className={styles.nav} aria-label="S1 Pro 页面导航" style={{ "--index": Math.max(0, NAV.findIndex(item => item[0] === active)) } as CSSProperties}>
        <span className={styles.navIndicator} aria-hidden="true" />
        {NAV.map(([id, label]) => <a key={id} href={`#s1p-${id}`} aria-current={active === id ? "location" : undefined}>{label}</a>)}
      </nav>
      <div className={styles.actions}>
        {demo && <span className={styles.demoBadge}>DEMO 演示数据</span>}
        <span className={styles.pill} data-ok={allNormal}><i />{allNormal ? "ALL SYSTEMS NOMINAL" : "CHECK REQUIRED"}</span>
        <a className={styles.ghost} href="/s1">经典版</a>
        <button type="button" className={styles.refresh} disabled={loading} onClick={onRefresh} aria-label="刷新 S1 数据">
          <span key={lastPoll} className={styles.refreshRing} aria-hidden="true" /><span>{loading ? "刷新中" : "刷新"}</span>
        </button>
      </div>
    </header>

    <div className={styles.shell}>
      {/* ------------------ hero ------------------ */}
      <section id="s1p-overview" className={styles.hero} aria-label="S1 概览">
        <div className={styles.heroCopy}>
          <small><i data-ok={allNormal} />{allNormal ? "LIVE · 自动交易运行中" : "LIVE · 状态待核验"} · 序号 {snapshot?.sequence ?? "—"}</small>
          <h1><span>4H</span><em>×</em><span>1H</span></h1>
          <p>趋势线交汇 · 15M 收线确认方向 · 执行器独立风控。<br />账户、扫描、执行三条心跳实时核验。</p>
        </div>
        <article className={styles.nextCard} onPointerMove={spotlight} data-soon={nextSeconds != null && nextSeconds < 3600}>
          <header><small>NEXT INTERSECTION · 下一次交汇</small>{next && <span className={styles.coin} data-dir={next.direction ?? "NONE"}>{next.symbol.slice(0, 1)}</span>}</header>
          {next ? <>
            <strong><ScrambleText text={next.symbol.replace(/USDT$/, "")} /><small>/USDT · 方向待定</small></strong>
            <b className={styles.countdown}>{arrivalCountdown(next.intersectionTime, now, unavailable, next.status)}</b>
            <dl><div><dt>数学交汇</dt><dd>{clock(next.intersectionTime)}</dd></div><div><dt>待交汇计划</dt><dd>{groups.upcoming.length}</dd></div></dl>
          </> : <div className={styles.nextEmpty}><b>{!ready ? "候选输入待核验" : "暂无前向交汇"}</b><span>{!ready ? "输入恢复前不显示倒计时" : "等待新结构形成"}</span></div>}
        </article>
      </section>

      {/* ------------------ heartbeats ------------------ */}
      <section className={styles.heartbeats} aria-labelledby="s1p-hb-title" aria-live="polite">
        <h2 id="s1p-hb-title" className={styles.srOnly}>心跳监测</h2>
        {beats.map((beat, index) => <article key={beat.id} className={styles.beat} data-ok={beat.ok} style={{ "--i": index } as CSSProperties} onPointerMove={spotlight}>
          <div><span>{beat.label}</span><b><ScrambleText text={beat.value} /></b><small>{beat.at}</small></div>
          <HeartbeatTrace tone={beat.ok ? "good" : snapshot ? "warn" : "off"} />
        </article>)}
      </section>

      {error && <p className={styles.alert} role="alert"><i />{error}</p>}
      {stale && snapshot && <p className={styles.alert} role="alert"><i />数据超过 180 秒未更新。候选和账户数值仅供历史参考，不能视为当前状态。</p>}

      {/* ------------------ intersection timeline ------------------ */}
      <section className={`${styles.panel} ${styles.timelinePanel}`} aria-label="交汇时间轴" onPointerMove={spotlight}>
        <header className={styles.panelHead}><div><small>INTERSECTION TIMELINE</small><h2>交汇时间轴</h2></div><span className={styles.badge}>{QUOTE_LABEL[quoteState]}</span></header>
        <IntersectionTimeline candidates={candidates} now={now} stale={unavailable} priorityIds={priorityIds} />
      </section>

      {/* ------------------ equity ------------------ */}
      <section id="s1p-equity" className={styles.equityGrid} aria-label="账户权益与资金">
        <div className={`${styles.panel} ${styles.equityPanel}`} onPointerMove={spotlight}>
          <header className={styles.panelHead}><div><small>EQUITY · USDT 资产口径</small><h2>权益轨迹</h2></div><span className={styles.badge} data-tone={accountHealthy ? "good" : "warn"}>{accountHealthy ? "账户已同步" : "历史快照 / 待核验"}</span></header>
          <div className={styles.equityHead}>
            <strong data-stale={!accountHealthy}>{equityTween == null ? "—" : money(equityTween)}<small>USDT</small></strong>
            <dl>
              <div><dt>窗口变化</dt><dd data-sign={windowDelta == null ? "" : windowDelta >= 0 ? "pos" : "neg"}>{windowDelta == null ? "—" : <Tween value={windowDelta} format={signedMoney} />}<small>{windowPercent == null ? "" : ` ${windowPercent > 0 ? "+" : ""}${money(windowPercent)}%`}</small></dd></div>
              <div><dt>采样</dt><dd>{points.length} 次<small> · 3 分钟缺口断线</small></dd></div>
            </dl>
          </div>
          <EquityChart points={points} label="S1" />
          <p className={styles.footnote}>权益变化包含划转影响，不能直接作为净收益。真实成交与手续费在成交流水独立对账。{history?.status === "UNAVAILABLE" ? " 历史存储当前不可用。" : ""}</p>
        </div>
        <aside className={`${styles.panel} ${styles.funds}`} onPointerMove={spotlight} aria-label="账户资金">
          <header className={styles.panelHead}><div><small>FUNDS</small><h2>账户资金</h2></div></header>
          <dl className={styles.fundList} data-stale={!accountHealthy}>
            <div><dt>可用资金</dt><dd><Tween value={account?.available} /></dd></div>
            <div><dt>未实现盈亏</dt><dd data-sign={details?.unrealized == null ? "" : details.unrealized >= 0 ? "pos" : "neg"}><Tween value={details?.unrealized} format={signedMoney} /></dd></div>
            <div><dt>钱包余额</dt><dd><Tween value={account?.wallet} /></dd></div>
          </dl>
          <div className={styles.utilization}>
            <div className={styles.gauge} style={{ "--p": Math.max(0, Math.min(100, utilization ?? 0)) } as CSSProperties} data-known={utilization != null}><span>{utilization == null ? "—" : `${money(utilization, 1)}%`}</span></div>
            <p><b>初始保证金 / 权益</b><span>资金占用指标，不等于强平风险率。</span></p>
          </div>
          <dl className={styles.counts}>
            <div><dt>当前持仓</dt><dd>{account?.positions ?? "—"}</dd><small>普通 {account?.orders ?? "—"} · 条件 {account?.algoOrders ?? "—"}</small></div>
            <div><dt>优先计划</dt><dd>{waitingPlans ?? "—"}</dd><small>{inputState === "UNAVAILABLE" ? "扫描输入暂不可用" : !ready ? "执行计划待核验" : "每币一个 · 靠近优先"}</small></div>
          </dl>
          <dl className={styles.meta}>
            <div><dt>持仓模式</dt><dd>{account?.positionMode === "HEDGE" ? "双向持仓" : account?.positionMode === "ONE_WAY" ? "单向持仓" : "待同步"}</dd></div>
            <div><dt>多资产保证金</dt><dd>{details?.multiAssetsMargin == null ? "待同步" : details.multiAssetsMargin ? "开启 · 仅 USDT" : "关闭"}</dd></div>
            <div><dt>维持保证金</dt><dd>{money(details?.maintenanceMargin)}</dd></div>
          </dl>
        </aside>
      </section>

      {/* ------------------ positions & candidates ------------------ */}
      <div id="s1p-positions" className={styles.anchor} />
      <PositionsPanel account={account} fresh={accountHealthy} execution={execution} executionFresh={executionFresh} quotes={quotes} rules={snapshot?.precision?.rules ?? []} now={now} />

      <div id="s1p-candidates" className={styles.anchor} />
      <CandidatesPanel candidates={candidates} execution={execution} ready={ready} unavailable={unavailable} partialScan={view.partialScan} loading={loading} quotes={quotes} rules={snapshot?.precision?.rules ?? []} now={now} scannedSymbols={snapshot?.scannedSymbols} universeSize={snapshot?.universe.length}>
        <DirectionSplit counts={counts} />
        {!counts.available && <p className={styles.footnote}>数据待同步或已过时：方向统计暂不可用。</p>}
      </CandidatesPanel>
      <HistoryPanel rows={ledger?.filteredCandidates ?? []} quotes={quotes} rules={snapshot?.precision?.rules ?? []} />

      {/* ------------------ secondary ------------------ */}
      <div className={styles.sectionHead}><small>SECONDARY DATA</small><h2>更多资料</h2></div>
      <div id="s1p-fills" className={styles.anchor} />
      <FillsPanel ledger={ledger} failure={ledgerError} now={now} quotes={quotes} rules={snapshot?.precision?.rules ?? []} />
      <div id="s1p-risk-calendar" className={styles.anchor} />
      <CalendarPanel calendar={calendar} failure={calendarFailure} now={now} eventGate={snapshot?.eventGate} scannerFresh={!stale && !error} onRefresh={onCalendarRefresh} />

      <details id="s1p-runtime" className={`${styles.panel} ${styles.drawer} ${styles.runtime}`}>
        <summary><span><b>运行详情</b><small>策略与版本 · 风险限额 · 同步与恢复</small></span><strong data-ok={!!(executionFresh && runtime?.runtimeLoaded)}>{executionFresh && runtime?.runtimeLoaded ? "执行进程已载入" : "当前版本待核验"}</strong><i aria-hidden="true" /></summary>
        <div className={styles.runtimeBody}>
          <section>
            <h3>{runtime?.displayName ?? "等待策略回报"}</h3>
            {risk ? <dl className={styles.limits}>
              <div><dt>单笔风险</dt><dd>≤ {percent(risk.perTradeFraction)}</dd></div><div><dt>组合风险</dt><dd>≤ {percent(risk.portfolioFraction)}</dd></div>
              <div><dt>持仓上限</dt><dd>{risk.maximumOpenPositions} 仓</dd></div><div><dt>最大杠杆</dt><dd>{risk.maximumLeverage} 倍</dd></div>
              <div><dt>总名义敞口</dt><dd>≤ 权益 × {risk.maximumGrossNotionalLeverage}</dd></div>{risk.effectiveMaximumGroupPositions != null && <div><dt>同组持仓上限</dt><dd>{risk.effectiveMaximumGroupPositions} 仓</dd></div>}
            </dl> : <p className={styles.footnote}>执行进程尚未返回风险限额。</p>}
            {execution?.portfolioProtection && <><h4>组合保护</h4><div className={styles.campaigns}>{execution.portfolioProtection.campaigns.map(campaign => <div key={campaign.direction} data-dir={campaign.direction}>
              <b>{campaign.direction === "LONG" ? "多头组合" : "空头组合"} · {campaign.active ? "已激活" : "未激活"} · {campaign.positionCount} 仓</b>
              <i><span style={{ transform: `scaleX(${Math.min(1, campaign.drawdownFraction / .4)})` }} /></i>
              <small>高点回吐 {(campaign.drawdownFraction * 100).toFixed(1)}% · 净盈亏 {campaign.markedPnlUsdt.toFixed(2)} / 高点 {campaign.highWaterPnlUsdt.toFixed(2)} USDT</small>
            </div>)}</div></>}
            <a className={styles.link} href="/s1#runtime">完整策略说明（经典版）↗</a>
          </section>
          <section>
            <h4>执行版本</h4>
            <dl className={styles.versions}>{([["执行引擎", runtime?.executionRevision], ["入场质量模块", runtime?.entryQualityRevision], ["入场质量政策", runtime?.entryQualityPolicyRevision], ["基础策略内核", runtime?.baseImplementationRevision], ["利润管理", runtime?.managementRevision], ["组合保护", runtime?.portfolioProtectionRevision], ["入场重确认", runtime?.entryConfirmationRevision], ["费用计入规则", runtime?.costPolicyRevision], ["候选优先级", runtime?.candidatePriorityRevision]] as const).filter(([, value]) => value != null).map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
          </section>
          <section>
            <h4>运行与同步</h4>
            <dl className={styles.syncList}>
              <div><dt>数据同步</dt><dd>{healthy ? "正常" : "待核验"}</dd></div><div><dt>账户数据时间</dt><dd>{clock(account?.observedAt)}</dd></div>
              <div><dt>流水数据时间</dt><dd>{clock(ledger?.observedAt)}</dd></div><div><dt>执行进程</dt><dd data-ok={executionHealthy}>{execLabel}</dd></div>
              <div><dt>执行状态时间</dt><dd>{clock(execution?.observedAt)}</dd></div>
              {execution?.entryIncident && <div><dt>当前拦截</dt><dd data-ok="false">{execution.entryIncident}</dd></div>}
              {!!execution?.entryBlockers?.length && <div><dt>实时入场等待</dt><dd data-ok="false">{execution.entryBlockers.slice(0, 4).map(row => `${row.symbol?.replace("USDT", "") ?? "—"} · ${row.reason}`).join("；")}</dd></div>}
              <div><dt>循环序号</dt><dd>{snapshot?.sequence ?? "—"}</dd></div><div><dt>本次进程启动</dt><dd>{clock(snapshot?.startedAt)}</dd></div>
              <div><dt>扫描覆盖</dt><dd>{snapshot ? `${snapshot.scannedSymbols} / ${snapshot.universe.length}` : "—"}</dd></div><div><dt>最近完整扫描</dt><dd>{clock(snapshot?.lastSuccessfulScanAt)}</dd></div>
              <div><dt>账户事件流</dt><dd>{accountHealthy && account?.userStreamConnected ? "已连接" : "待核验"}</dd></div>
              <div><dt>完整性</dt><dd>{snapshot?.errors.length ? snapshot.errors.map(row => `${row.symbol}: ${row.reason}`).join(" · ") : snapshot ? "本快照无同步错误" : "尚无证据"}</dd></div>
            </dl>
            <p className={styles.footnote}>网页刷新 15 秒，失败退避至 60 秒；超过 180 秒明确标记过时并保留历史数据。S1 使用独立账户快照、权益历史与成交流水；候选扫描只观察，真实执行状态由 S1 执行进程提供。</p>
          </section>
        </div>
      </details>

      <footer className={styles.footer}><span>S1 PRO · BINANCE USDⓈ-M · READ-ONLY MONITOR</span><span>{QUOTE_LABEL[quoteState]} · 页面刷新 15S · 本地模拟 · 原架构源码</span></footer>
    </div>
  </main>;
}
