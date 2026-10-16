"use client";
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import styles from "./s1.module.css";
import { candidateDisplayView, usesS1Structure } from "../../lib/s1-candidate-funnel.mjs";
import SignalFlow from "./SignalFlow";
import StrategyDetails from "./StrategyDetails";
import HeaderMarketBackdrop from "./HeaderMarketBackdrop";
import MonitorNavigation from "./MonitorNavigation";
import AccountWorkspace, { type AccountRecord, type History } from "./AccountWorkspace";
import TradeLedger, { executionLabel, type ExecutionLedger } from "./TradeLedger";
import { type MarketQuote, type PrecisionRule } from "./PriceCalibration";
import RiskCalendar, { type EventGate } from "./RiskCalendar";
import CandidateFunnel, { type Candidate } from "./V2CandidatePlans";
import V2Positions from "./V2Positions";
import v2Styles from "./v2-panels.module.css";
import { useLiveMarketQuotes } from "./useLiveMarketQuotes";
type Snapshot = { sourceAsOf: string; sequence: number; startedAt: string; bootId: string; status: string; scanDurationMs: number; scannedSymbols: number; universe: string[]; lastSuccessfulScanAt: string | null;
  account: AccountRecord;
  marketQuotes?: MarketQuote[]; precision?: { rules: PrecisionRule[]; errors: { symbol: string; reason: string }[] }; candidates: Candidate[]; errors: { symbol: string; reason: string }[]; publish: { status: string; at: string | null }; recovery: { stateRecovered: boolean }; eventGate?: EventGate };
const clock = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
export default function AccountMonitor({ accountLabel = "S1" }: { accountLabel?: "S1" | "S2" }) {
  const isS2 = accountLabel === "S2";
  const accountOnly = false;
  const route = accountLabel.toLowerCase();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [candidateReference, setCandidateReference] = useState<{ accountLabel: string; sourceAsOf: string; candidates: Candidate[] } | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<History | undefined>();
  const [ledger, setLedger] = useState<ExecutionLedger | undefined>();
  const [ledgerError, setLedgerError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>, failures = 0;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const request = (url: string) => fetch(url, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        const [monitorResponse, ledgerResponse] = await Promise.allSettled([request(`/api/${route}-monitor`), request(`/api/${route}-execution-ledger`)]);
        if (monitorResponse.status !== "fulfilled" || !monitorResponse.value.ok) throw new Error("MONITOR_UNAVAILABLE");
        const result = await monitorResponse.value.json() as { snapshot: Snapshot | null; history?: History };
        if (!disposed) { setSnapshot(result.snapshot); setHistory(result.history); setError(result.snapshot ? "" : "等待服务器首份快照"); failures = 0; }
        if (ledgerResponse.status === "fulfilled" && ledgerResponse.value.ok) {
          const nextLedger = await ledgerResponse.value.json() as ExecutionLedger;
          if (!disposed) { setLedger(nextLedger); setLedgerError(false); }
        } else if (!disposed) setLedgerError(true);
      } catch { if (!disposed) { setError("连接异常，正在自动重连；下方保留上次快照"); failures++; } }
      finally { if (!disposed) { setLoading(false); timer = setTimeout(poll, Math.min(60000, 15000 * 2 ** Math.min(failures, 2))); } }
    };
    void poll();
    const visible = () => { if (!document.hidden) setRefreshKey((v) => v + 1); };
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refreshKey, route]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, []);
  useEffect(() => {
    const reveal = () => {
      if (isS2 && window.location.hash === "#smc") { window.location.replace("/s2/smc"); return; }
      const target = document.querySelector(window.location.hash || "#overview");
      if (target instanceof HTMLDetailsElement) target.open = true;
      const parent = target?.closest("details");
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [isS2]);
  const refresh = useCallback(() => { setLoading(true); setRefreshKey((value) => value + 1); }, []);
  const age = snapshot && now ? Math.max(0, Math.floor((now - Date.parse(snapshot.sourceAsOf)) / 1000)) : null;
  const stale = age === null || age > 180;
  const accountAge = snapshot?.account.observedAt && now ? now - Date.parse(snapshot.account.observedAt) : Infinity;
  const accountHealthy = !stale && !error && snapshot?.account.fresh && accountAge >= -5000 && accountAge <= 120000;
  const executionAge = ledger?.execution?.observedAt && now ? now - Date.parse(ledger.execution.observedAt) : Infinity;
  const executionFresh = !ledgerError && ledger?.status === "OK" && executionAge >= -5000 && executionAge <= 180000;
  const healthy = !stale && !error && snapshot?.status === "HEALTHY";
  const candidateView = candidateDisplayView({ snapshot, reference: candidateReference, accountLabel, execution: ledger?.execution, executionFresh, now, monitorError: !!error });
  const s1Structure = usesS1Structure(accountLabel, ledger?.execution);
  const inputState = candidateView.inputState as "READY" | "UNAVAILABLE" | "UNKNOWN";
  useEffect(() => { if (candidateView.reference !== candidateReference) setCandidateReference(candidateView.reference); }, [candidateView.reference, candidateReference]);
  const candidateSourceUnavailable = inputState === "UNAVAILABLE";
  const executionHealthy = !accountOnly && executionFresh && !!ledger?.execution?.liveReady && !ledger.execution.entryIncident && inputState === "READY";
  const allHeartbeatsNormal = !!accountHealthy && healthy && executionHealthy;
  const liveMarket = useLiveMarketQuotes(snapshot?.marketQuotes ?? []);
  const positionPanel = <V2Positions inputStateOverride={inputState} now={now} rules={snapshot?.precision?.rules} quotes={liveMarket.quotes} view="positions" accountLabel={accountLabel} accountOnly={accountOnly} account={snapshot?.account} fresh={!!accountHealthy} execution={ledger?.execution} executionFresh={executionFresh} />;
  const candidatePanel = accountOnly ? <section id="candidates" className={styles.panel}><div className={styles.panelHead}><div><span className={styles.panelKicker}>策略入口</span><h2>候选计划</h2></div></div><div className={styles.empty}><h3>尚未配置 S2 策略扫描</h3><p>此账户只展示自己的资金、持仓、委托与成交。</p></div></section> : <CandidateFunnel inputStateOverride={inputState} partialScan={candidateView.partialScan} execution={ledger?.execution} executionFresh={executionFresh} candidates={candidateView.candidates} filteredCandidates={ledger?.filteredCandidates ?? []} quotes={liveMarket.quotes} liveQuoteState={liveMarket.state} rules={snapshot?.precision?.rules} now={now} stale={stale} error={!!error} loading={loading} scannedSymbols={snapshot?.scannedSymbols} universeSize={snapshot?.universe.length} accountLabel={accountLabel} />;
  return <main className={`${styles.page} ${isS2 ? styles.s2 : ""}`}>
    <a href="#candidates" className={styles.skip}>跳至候选计划</a>
    <div id="monitor-chrome" className={styles.frozenTop}>
    <MonitorNavigation accountLabel={accountLabel} />
    <header id="overview" className={styles.header}><HeaderMarketBackdrop /><a className={styles.brand} href={`/${route}`} aria-label={`${accountLabel} 监视器首页`}><Image className={styles.mobileLogo} src={`/${route}-logo.svg`} width={36} height={36} alt="" priority /><div className={styles.brandCopy}><h1>{accountLabel} 监视器</h1><small>开源模拟账户 {accountLabel === "S1" ? "1" : "2"} · Binance USDⓈ-M</small></div></a><div className={styles.headerRight}><a className={styles.scope} href="/s2-2">S2-2 模拟 ↗</a><a className={`${styles.scope} ${styles.smcEntry}`} href="/s2/smc">{isS2 ? "SMC 工作台 ↗" : "SMC 监视器 ↗"}</a><a className={styles.scope} href={isS2 ? "/s1" : "/s2"}>{isS2 ? "S1 监视器 ↗" : "S2 监视器 ↗"}</a><button type="button" onClick={refresh} disabled={loading}>{loading ? "刷新中…" : "刷新数据"}</button></div></header>
    </div>
    <section className={styles.heartbeat} aria-labelledby="heartbeat-title" aria-live="polite"><div className={styles.heartbeatTitle}><span className={`${styles.pulse} ${allHeartbeatsNormal ? styles.pulseGood : styles.pulseWarning}`} aria-hidden="true" /><h2 id="heartbeat-title">心跳监测</h2></div><div className={styles.heartbeatGrid}>
      <article><span>账户心跳</span><strong className={accountHealthy ? styles.good : styles.warning}>{accountHealthy ? "正常" : "待恢复"}</strong><small>{clock(snapshot?.account.observedAt)}</small></article>
      <article><span>扫描心跳</span><strong className={accountOnly ? styles.dim : healthy && !candidateSourceUnavailable ? styles.good : styles.warning}>{accountOnly ? "未配置" : candidateSourceUnavailable ? "输入暂不可用" : healthy ? "正常" : "待恢复"}</strong><small>{accountOnly ? "仅账户观察" : clock(snapshot?.lastSuccessfulScanAt)}</small></article>
      <article><span>执行心跳</span><strong className={accountOnly ? styles.dim : executionHealthy ? styles.good : styles.warning}>{accountOnly ? "未配置" : executionLabel(ledger?.execution, executionFresh, now, inputState)}</strong><small>{accountOnly ? "无执行器" : clock(ledger?.execution?.observedAt)}</small></article>
    </div></section>
    <div id="equity" className={styles.equityStage}><AccountWorkspace inputStateOverride={inputState} now={now} rules={snapshot?.precision?.rules} quotes={liveMarket.quotes} view="equity" accountLabel={accountLabel} accountOnly={accountOnly} account={snapshot?.account} history={history} fresh={!!accountHealthy} execution={ledger?.execution} executionFresh={executionFresh} /></div>
    <SignalFlow structureProfile={s1Structure ? "S1" : "S2"} candidates={candidateView.candidates} fresh={healthy} configured={!accountOnly} accountLabel={accountLabel} />
    {error && <p className={styles.alert} role="alert">{error}</p>}
    {stale && snapshot && <p className={styles.alert} role="alert">数据超过 180 秒未更新。候选和账户数值仅供历史参考，不能视为当前状态。</p>}
    {s1Structure ? <div className={v2Styles.workspace}>{positionPanel}{candidatePanel}</div> : <div className={styles.workspace}><div className={styles.primaryColumn}>{candidatePanel}</div><aside className={styles.positionColumn}>{positionPanel}</aside></div>}
    <section id="more-data" className={styles.moreData} aria-labelledby="more-data-title"><div className={styles.moreHead}><div><span className={styles.eyebrow}>SECONDARY DATA</span><h2 id="more-data-title">更多资料</h2></div></div>
      <TradeLedger rules={snapshot?.precision?.rules} quotes={liveMarket.quotes} accountLabel={accountLabel} accountOnly={accountOnly} ledger={ledger} now={now} failure={ledgerError} />
      <details id="risk-calendar" className={styles.drawer}><summary><span><b>风险事件日历</b><small>宏观事件 · 新入场暂停窗口</small></span><strong>{snapshot?.eventGate?.newEntriesPaused ? "窗口生效" : "当前无窗口"}</strong><span className={styles.expand} aria-hidden="true">＋</span></summary><div className={styles.drawerBody}><RiskCalendar now={now} eventGate={snapshot?.eventGate} scannerFresh={!stale && !error} /></div></details>
    <details id="runtime" className={styles.runtime}><summary><span><b>运行详情</b><small>策略与版本 · 同步与恢复</small></span><span className={styles.expand} aria-hidden="true">＋</span></summary>
      <div className={styles.runtimeBody}><StrategyDetails execution={ledger?.execution} fresh={executionFresh} accountLabel={accountLabel} /><div className={styles.rail}><section className={styles.panel}><h2>运行与同步</h2><dl>
        <div><dt>账户</dt><dd>{accountLabel} · Binance USDⓈ-M</dd></div><div><dt>数据同步</dt><dd>{healthy ? "正常" : "待核验"}</dd></div>
        <div><dt>账户数据时间</dt><dd>{clock(snapshot?.account.observedAt)}</dd></div><div><dt>流水数据时间</dt><dd>{clock(ledger?.observedAt)}</dd></div>
        <div><dt>执行进程</dt><dd className={executionHealthy ? styles.good : styles.warning}>{accountOnly ? "未配置 · 仅账户观察" : executionLabel(ledger?.execution, executionFresh, now, inputState)}</dd></div>
        {!accountOnly && <div><dt>执行状态时间</dt><dd>{clock(ledger?.execution?.observedAt)}</dd></div>}
        {ledger?.execution?.entryIncident && <div><dt>当前拦截</dt><dd className={styles.warning}>{ledger.execution.entryIncident}</dd></div>}
        {!!ledger?.execution?.entryBlockers?.length && <div><dt>实时入场等待</dt><dd className={styles.warning}>{ledger.execution.entryBlockers.slice(0, 4).map(row => `${row.symbol?.replace("USDT", "") ?? "—"} · ${row.reason}`).join("；")}</dd></div>}
        <div><dt>循环序号</dt><dd>{snapshot?.sequence ?? "—"}</dd></div><div><dt>本次进程启动</dt><dd>{clock(snapshot?.startedAt)}</dd></div>
        {!accountOnly && <><div><dt>扫描覆盖</dt><dd>{snapshot ? `${snapshot.scannedSymbols} / ${snapshot.universe.length}` : "—"}</dd></div><div><dt>最近完整扫描</dt><dd>{clock(snapshot?.lastSuccessfulScanAt)}</dd></div><div><dt>账户事件流</dt><dd>{accountHealthy && snapshot?.account.userStreamConnected ? "已连接" : "待核验"}</dd></div></>}
      </dl></section><section className={styles.panel}><h2>恢复与来源</h2><div className={styles.recovery}><span>自动重连</span><p>网页刷新 15 秒 · 失败退避至 60 秒<br />超过 180 秒明确标记过时，保留历史数据。</p></div><div className={styles.recovery}><span>账户隔离</span><p>{accountLabel} 使用独立账户快照、权益历史与成交流水。候选扫描只观察；真实执行状态由 {accountLabel} 执行进程提供。</p></div><div className={styles.recovery}><span>完整性 / 连接问题</span><p>{snapshot?.errors.length ? snapshot.errors.map(row => `${row.symbol}: ${row.reason}`).join(" · ") : snapshot ? "本快照无同步错误" : "尚无证据"}</p></div></section></div></div>
    </details></section>
    <footer className={styles.footer}><span>{accountLabel} / Binance USDⓈ-M · 本地模拟 · 原架构源码</span></footer>
  </main>;
}
