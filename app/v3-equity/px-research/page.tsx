"use client";

import { useCallback, useEffect, useState } from "react";
import { sourceHealth } from "../../../lib/v3-px-monitor.mjs";
import styles from "./research.module.css";

type Arm = { status: string; admittedAt: number | null; returnedAt: number | null };
type Threshold = { status: string; reason: string; unknownEvidence: boolean; distanceBps: number | null; structureZ: number | null; legacyDisplacementBps: number | null; currentArm: Arm; distanceOnlyArm: Arm; pullbackArm: Arm };
type Signal = { signalId: string; symbol: string; side: string; confirmedAt: number | null; expiresAt: number | null; observedAt: number | null; px: number | null; decisionClose: number | null; eligible: boolean; exclusionReason: string; integrityUnknown: boolean; integrityUnknownReason: string; observationCount: number | null; thresholds: Record<string, Threshold> };
type Grid = { mode: string; threshold: number; denominatorEligibleSignals: number | null; currentArmAdmitted: number | null; distanceOnlyArmAdmitted: number | null; pullbackArmAdmitted: number | null; exceeded: number | null; completedExceededDenominator: number | null; physicalPxIntervalReturns: number | null; legacyGatePassedPullbackAdmissions: number | null; pendingPullback: number | null; timedOut: number | null; unknown: number | null; interval: { status: string; lower: number | null; upper: number | null; estimate: number | null; blocks: number | null } };
type Snapshot = { asOf: string; prospectiveStart: string; status: string; pid: number; cycles: number; sourceSnapshotAsOf: string; trackedSymbols: string[]; streams: Record<string, { status: string; latestReceivedAt: string | null }>; evidence: { eventSequence: number | null; eventHead: string | null; rawBytes: number | null; recoveredAheadTail: boolean }; eligibleSignalCount: number | null; excludedSignalCount: number | null; totalRecordCount: number | null; grid: Grid[]; records: Signal[] };
const labels: Record<string, string> = { UNKNOWN: "证据未知", WAITING: "等待价格条件", UNDECIDED: "尚未判定", ADMITTED: "价格条件通过", DIRECT_ADMITTED: "直接通过", PULLBACK_ADMITTED: "回踩后通过", TIMED_OUT: "信号已超时", REJECTED_OVER_DISTANCE: "距离过远", REJECTED_BELOW_MINIMUM: "未满足最低边界", REJECTED_LEGACY_75BPS: "未通过原 75bps 门", WAITING_FOR_PX_PULLBACK: "等待回踩", WAITING_LEGACY_GATE_AFTER_RETURN: "已回踩，等待原门通过", CAUSAL_TICK_BBO_CONTINUITY_INCOMPLETE: "Tick/BBO 连续证据不足", PRE_PROSPECTIVE_START_LEFT_TRUNCATED: "早于研究起点，排除统计", UNCOMMITTED_EVENT_TAIL_AFTER_CRASH: "恢复时发现未提交事件，证据待核验", PX_OR_EXECUTABLE_BBO_MISSING: "缺少 Px 或可执行报价", FROZEN_PRIMARY_1H_B_C_MISSING: "缺少原始结构尺度", EVIDENCE_INCOMPLETE: "证据不足" };
const label = (v?: string) => labels[v ?? "UNKNOWN"] ?? v ?? "证据未知";
const num = (v: number | null | undefined, digits = 2) => v == null ? "—" : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const time = (v: number | string | null | undefined) => v == null || !Number.isFinite(new Date(v).getTime()) ? "—" : new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const rate = (n: number | null | undefined, d: number | null | undefined) => n == null || !d ? "—" : `${(100 * n / d).toFixed(1)}%`;
const gridLabel = (g: Grid) => g.mode === "PERCENT_BPS" ? `${g.threshold} bps · ${(g.threshold / 100).toFixed(2)}%` : `${g.threshold} × 原 1H 结构幅度`;

export default function PxResearchPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [now, setNow] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/v3-px-research?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("同步失败，已保留上次数据");
      const data = await response.json();
      if (!data.snapshot) { setError("等待首份研究数据发布"); return; }
      setSnapshot((old) => old && Date.parse(old.asOf) > Date.parse(data.snapshot.asOf) ? old : data.snapshot);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "同步失败"); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => { setNow(Date.now()); void refresh(); }, 0);
    const sync = window.setInterval(() => void refresh(), 30000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const resume = () => { setNow(Date.now()); void refresh(); };
    const visible = () => { if (document.visibilityState === "visible") resume(); };
    window.addEventListener("focus", resume); window.addEventListener("online", resume); window.addEventListener("pageshow", resume); document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(initial); clearInterval(sync); clearInterval(clock); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const fresh = snapshot && now > 0 && sourceHealth(snapshot, now) === "FRESH";
  const g = snapshot?.grid.find((row) => `${row.mode}:${row.threshold}` === selection) ?? snapshot?.grid[0];
  const key = g ? `${g.mode}:${g.threshold}` : "";
  const arms = [{ name: "原规则", field: "currentArmAdmitted", record: "currentArm" }, { name: "距离门", field: "distanceOnlyArmAdmitted", record: "distanceOnlyArm" }, { name: "距离门＋回踩", field: "pullbackArmAdmitted", record: "pullbackArm" }] as const;
  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.header}><div><a href="/v3-equity">← V3 监视器</a><h1>Px 距离与回踩研究</h1></div><button onClick={() => void refresh()}>刷新数据</button></header>
    <div className={styles.boundary}><strong>仅研究 · 未接入交易执行</strong><span>三方案比较价格准入条件，不代表实际或模拟成交。阈值选择只切换观察视图。</span></div>
    {error && <p className={styles.warning} role="status">{error}</p>}
    {!snapshot ? <section className={styles.panel}><p>正在读取研究记录…</p></section> : <>
      <section className={styles.health} aria-label="研究运行状态"><div><small>研究心跳</small><b className={fresh && snapshot.status === "RUNNING_FORWARD_OBSERVE_ONLY" ? styles.good : styles.warn}>{!fresh ? "数据已过期或时间未知" : snapshot.status === "RUNNING_FORWARD_OBSERVE_ONLY" ? "运行中" : "预热或降级"}</b><span>源时间 {time(snapshot.asOf)}</span></div>
        {[ ["public", "BBO 报价"], ["market", "Tick 成交"] ].map(([id, title]) => { const s = snapshot.streams[id]; const age = s?.latestReceivedAt && now > 0 ? now - Date.parse(s.latestReceivedAt) : null; const live = fresh && s?.status === "LIVE" && age !== null && age >= 0 && age < 90000; return <div key={id}><small>{title}</small><b className={live ? styles.good : styles.warn}>{live ? "持续接收" : "待更新或断流"}</b><span>最近接收 {time(s?.latestReceivedAt)}</span></div>; })}
        <div><small>信号源</small><b>HF14 · 单 Z</b><span>更新时间 {time(snapshot.sourceSnapshotAsOf)}</span></div>
      </section>
      <section className={styles.metrics} aria-label="样本与记录"><div><small>合格信号 · 共同分母</small><b>{num(snapshot.eligibleSignalCount, 0)}</b></div><div><small>研究起点前排除</small><b>{num(snapshot.excludedSignalCount, 0)}</b></div><div><small>所选阈值证据未知</small><b>{num(g?.unknown, 0)}</b></div><div><small>已记录原始事件</small><b>{num(snapshot.evidence.eventSequence, 0)}</b></div></section>
      <section className={styles.panel}><div className={styles.sectionHead}><h2>三方案价格准入对照</h2><label>观察阈值<select value={key} onChange={(e) => setSelection(e.target.value)}>{snapshot.grid.map((row) => <option key={`${row.mode}:${row.threshold}`} value={`${row.mode}:${row.threshold}`}>{gridLabel(row)}</option>)}</select></label></div>
        <p className={styles.muted}>通过率＝价格条件通过数 ÷ 全部合格信号。未知样本保留在分母；此比例不等于成交率或胜率。</p>
        <div className={styles.compare}>{arms.map((a) => <article key={a.name}><h3>{a.name}</h3><strong>{rate(g?.[a.field], g?.denominatorEligibleSignals)}</strong><p>{num(g?.[a.field], 0)} / {num(g?.denominatorEligibleSignals, 0)} 条通过</p><span>净收益、费用、净收益置信下界：不可计算</span></article>)}</div>
        <div className={styles.facts}><span>超距 {num(g?.exceeded, 0)}</span><span>回到 Px 区间 {num(g?.physicalPxIntervalReturns, 0)}</span><span>回踩且通过原门 {num(g?.legacyGatePassedPullbackAdmissions, 0)}</span><span>等待回踩 {num(g?.pendingPullback, 0)}</span><span>回踩等待超时 {num(g?.timedOut, 0)}</span></div>
        <p className={styles.muted}>回踩率 {rate(g?.physicalPxIntervalReturns, g?.completedExceededDenominator)} · 完成观察的超距样本 {num(g?.completedExceededDenominator, 0)} · 时间块 {num(g?.interval.blocks, 0)} · 95% 时间块重采样区间 {g?.interval.status === "TIME_BLOCK_RESAMPLED" ? `${rate(g.interval.lower, 1)}–${rate(g.interval.upper, 1)}` : "证据不足"}</p>
      </section>
      <section className={styles.panel}><div className={styles.sectionHead}><h2>逐笔信号记录</h2><span>展示最近 {snapshot.records.length} / {num(snapshot.totalRecordCount, 0)} 条</span></div>
        {!snapshot.records.length ? <p className={styles.empty}>研究起点后尚无信号记录。采集继续运行。</p> : <div className={styles.records}>{snapshot.records.map((r) => { const t = r.thresholds[key]; return <details key={r.signalId}><summary><b>{r.symbol} <em className={r.side === "BUY" ? styles.good : styles.warn}>{r.side === "BUY" ? "多" : r.side === "SELL" ? "空" : "未知"}</em></b><time>{time(r.confirmedAt)}</time><span>Px {num(r.px, 8)}</span><span className={!r.eligible || t?.unknownEvidence || r.integrityUnknown ? styles.warn : ""}>{!r.eligible ? "排除统计" : r.integrityUnknown ? "证据未知" : label(t?.status)}</span><span>查看详情</span></summary>
          <div className={styles.detail}><dl><dt>确认价</dt><dd>{num(r.decisionClose, 8)}</dd><dt>最近观测偏离</dt><dd>{num(t?.distanceBps)} bps / {num(t?.structureZ, 4)} × 结构</dd><dt>相对确认价偏离</dt><dd>{num(t?.legacyDisplacementBps)} bps</dd><dt>首次发现 / 截止</dt><dd>{time(r.observedAt)} / {time(r.expiresAt)}</dd><dt>证据说明</dt><dd>{!r.eligible ? label(r.exclusionReason) : r.integrityUnknown ? label(r.integrityUnknownReason) : label(t?.reason)}</dd></dl>
          <div className={styles.armRows}>{arms.map((a) => { const v = t?.[a.record]; return <div key={a.name}><b>{a.name}</b><span>{r.eligible ? label(v?.status) : "排除统计"}</span><span>首次价格准入：{time(v?.admittedAt)}</span>{a.record === "pullbackArm" && <span>返回区间：{time(v?.returnedAt)}</span>}</div>; })}</div><small className={styles.id}>信号编号 {r.signalId}</small></div>
        </details>; })}</div>}
      </section>
      <section className={styles.panel}><h2>研究边界与证据</h2><p>完整的三方案成交、容量、退出及费用回放尚未实现，净收益和最优交易阈值不可计算。未回踩不等于错过盈利机会；错过盈利机会的比例同样等待完整回放。</p><p className={styles.muted}>前向起点 {time(snapshot.prospectiveStart)}（北京时间） · 原 75bps 确认价门与 300 秒有效期保留。页面每 30 秒同步，超过 90 秒未更新会提示过期。原始事件与完整记录保存在本机研究日志，页面仅展示有限摘要。</p><details><summary>查看采集凭据</summary><p className={styles.muted}>进程 {snapshot.pid} · 周期 {num(snapshot.cycles, 0)} · 采集币种 {snapshot.trackedSymbols.join("、")} · 原始数据 {num((snapshot.evidence.rawBytes ?? 0) / 1048576)} MiB</p><p className={styles.id}>事件链头 {snapshot.evidence.eventHead ?? "未知"}</p></details></section>
    </>}
  </div></main>;
}
