"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./candidate.module.css";

type Input = { status: string; sourceAsOf: string | null; freshnessMs: number | null };
type Report = {
  sequence: number; sourceAsOf: string; startedAt: string | null; status: string;
  sourceScope: { carryInPositionCount: number };
  account: {
    initialEquityUsdt: number | null; cashRealizedEquityUsdt: number | null; liquidationNetEquityUsdt: number | null;
    confirmedHighEquityUsdt: number | null; protectionFloorUsdt: number | null; remainingProtectionCushionUsdt: number | null;
    existingStressRiskUsdt: number; availableCandidateRiskUsdt: number; openPositionCount: number; closedPositionCount: number;
    cumulativeEntryFeesUsdt: number; cumulativeExitFeesUsdt: number; cumulativeFundingUsdt: number; cumulativeRebalanceCostsUsdt: number; maximumDrawdownFraction: number;
  };
  inputs: Record<string, Input>;
  gates: { abnormalLoss: { status: string }; blockers: string[] };
  validation: { eligibleCompletedCampaigns: number; excludedCompletedCampaigns: number; annualTargetProbability: null; performanceValidated: false };
};
type Point = { sourceAsOf: string; equityUsdt: number; floorUsdt: number; complete: boolean };
type Envelope = { status: string; candidate: Report | null; observations: Point[] };
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "—" : format.format(n);
const time = (s: string | null | undefined) => s ? new Date(s).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
const inputNames: Record<string, string> = { baselineAccount: "账户基线", eventLedger: "前向事件", quote: "双边报价", depth: "档位深度", funding: "资金费行情", metadata: "合约规则" };
const inputStatus: Record<string, string> = { HEALTHY: "采集正常", WAITING: "等待", STALE: "过期", GAP: "断档", INVALID: "不合格" };
const labels: Record<string, string> = {
  WAITING_HEALTHY_FORWARD_BASELINE: "等待合格前向起点", ACTIVE_OBSERVE_ONLY: "独立记账中", EVIDENCE_HOLD: "证据暂停", RED_LATCHED_MANUAL_RESET_REQUIRED: "RED 锁存 · 新增风险冻结",
  WAITING_FIRST_HEALTHY_FORWARD_ACCOUNT_NET_EQUITY: "等待首个健康账户净值，尚未建立候选本金",
  WAITING_PUBLIC_QUOTE_DEPTH_FUNDING_AND_METADATA: "等待报价、深度、资金费与合约规则齐备",
  BASELINE_EXECUTED_OPPORTUNITY_SUBSET_NOT_COMPLETE_SIGNAL_UNIVERSE: "只观察基准已执行机会，不代表全部信号",
  R22_FULL_RULE_EVIDENCE_REQUIRED: "完整 R22 规则证据尚未齐备",
};

function CandidateCurve({ points }: { points: Point[] }) {
  if (points.length < 2) return <p className={styles.empty}>尚无可绘制的独立候选路径；不会用基准收益乘比例补出曲线。</p>;
  const values = points.flatMap((p) => [p.equityUsdt, p.floorUsdt]);
  const lo = Math.min(...values), hi = Math.max(...values), pad = Math.max(10, (hi - lo) * .12);
  const start = Date.parse(points[0].sourceAsOf), end = Date.parse(points.at(-1)!.sourceAsOf);
  const x = (p: Point) => 20 + 920 * (Date.parse(p.sourceAsOf) - start) / Math.max(1, end - start);
  const y = (n: number) => 180 - 160 * (n - lo + pad) / (hi - lo + 2 * pad);
  const segments: Point[][] = []; let current: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p.complete || (i > 0 && Date.parse(p.sourceAsOf) - Date.parse(points[i - 1].sourceAsOf) > 45000)) { if (current.length) segments.push(current); current = []; }
    if (p.complete) current.push(p);
  }
  if (current.length) segments.push(current);
  return <><svg viewBox="0 0 960 200" className={styles.chart} role="img" aria-label="C 候选独立清算净值及保护线，证据缺口不连线">
    {[30,100,170].map((v) => <line key={v} x1="20" x2="940" y1={v} y2={v} stroke="#ffffff16"/>)}
    {segments.map((segment, i) => <g key={i}><polyline fill="none" stroke="#b89cf2" strokeWidth="2.5" points={segment.map((p) => `${x(p)},${y(p.equityUsdt)}`).join(" ")}/><polyline fill="none" stroke="#e7b663" strokeDasharray="5 4" points={segment.map((p) => `${x(p)},${y(p.floorUsdt)}`).join(" ")}/></g>)}
  </svg><div className={styles.caption}><span>{time(points[0].sourceAsOf)}</span><span>紫：C 净值 · 琥珀：保护线 · 缺口不连线</span><span>{time(points.at(-1)!.sourceAsOf)}</span></div></>;
}

export default function CandidateStudyPanel({ baseline }: { baseline?: { aEquity: number; bEquity: number | null; sourceAsOf: string } }) {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(0);
  const refresh = useCallback(async () => {
    const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("/api/v2-account-candidate", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("UNAVAILABLE");
      const next = await response.json() as Envelope;
      setEnvelope((old) => old?.candidate && (!next.candidate || next.candidate.sequence < old.candidate.sequence) ? old : next);
      setNow(Date.now()); setError(false);
    } catch { setError(true); setNow(Date.now()); }
    finally { window.clearTimeout(timeout); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 15000);
    const ageTimer = window.setInterval(() => setNow(Date.now()), 1000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh); window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", visible);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.clearInterval(ageTimer); window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const r = envelope?.candidate, a = r?.account;
  const stale = !!r && (envelope?.status === "CANDIDATE_FEED_STALE" || now - Date.parse(r.sourceAsOf) > 120000);
  const baselineStale = !!baseline && now - Date.parse(baseline.sourceAsOf) > 120000;
  return <section className={styles.panel} aria-label="ABC 独立账户研究" data-candidate-execution="false">
    <div className={styles.head}><div><small>ACCOUNT RESEARCH · A / B / C</small><h2>复利与利润保护 · 三组对照</h2><p>保留原规则与原影子；新增 C 独立账本。各组起点、机会和成本尚未完整匹配，不做优劣排名。</p></div><button type="button" onClick={() => void refresh()}>刷新候选</button></div>
    <div className={styles.groups}>
      <article><small>A · 现行 R22</small><strong>{money(baseline?.aEquity)}</strong><span>清算侧参考净值 · 规则不变</span><p>来自原账户，不受 B / C 的任何动作影响。</p></article>
      <article><small>B · 原滚动影子</small><strong>{money(baseline?.bEquity)}</strong><span>指示性权益 · 原历史保留</span><p>按基准净值变化映射，不等于独立成交。</p></article>
      <article className={styles.candidate}><small>C · 独立复利候选</small><strong>{money(a?.liquidationNetEquityUsdt)}</strong><span aria-live="polite">{error ? "候选读取异常 · 原数据保留" : stale ? "候选数据过期 · 暂停评估" : labels[r?.status ?? ""] ?? "等待独立前向数据"}</span><p>不复制旧仓，不用浮盈扩大本金，不自动解除 RED。</p></article>
    </div>
    {baselineStale && <p className={styles.notice}>A / B 参考数据已过期，保留上次值；此时不能与 C 作同步比较。</p>}
    <div className={styles.notice}>年度净收益超过 100% 的概率：<b>尚不可估计</b>。此前条件模型不是当前 V2 的成功率；20 个周期只用于初审。</div>
    <div className={styles.metrics}>
      <span><small>C 已实现权益</small><b>{money(a?.cashRealizedEquityUsdt)}</b></span>
      <span><small>确认高点 / 保护线</small><b>{money(a?.confirmedHighEquityUsdt)} / {money(a?.protectionFloorUsdt)}</b></span>
      <span><small>已占用压力风险 / 新增预算</small><b>{money(a?.existingStressRiskUsdt)} / {money(a?.availableCandidateRiskUsdt)}</b></span>
      <span><small>持仓 / 完整已平</small><b>{a ? `${a.openPositionCount} / ${a.closedPositionCount}` : "—"}</b></span>
      <span><small>入场费 / 退出费 / 资金费净支出</small><b>{money(a?.cumulativeEntryFeesUsdt)} / {money(a?.cumulativeExitFeesUsdt)} / {money(a?.cumulativeFundingUsdt)}</b></span>
      <span><small>独立再平衡成本 / 最大回撤</small><b>{money(a?.cumulativeRebalanceCostsUsdt)} / {a ? `${(a.maximumDrawdownFraction * 100).toFixed(2)}%` : "—"}</b></span>
    </div>
    <div className={styles.inputs}>{Object.entries(inputNames).map(([k, label]) => <span key={k} className={r?.inputs[k]?.status === "HEALTHY" && !stale && !error ? styles.ready : ""}>{label}<b>{stale || error ? "待复核" : inputStatus[r?.inputs[k]?.status ?? ""] ?? "等待"}</b></span>)}</div>
    <p className={styles.empty}>采集正常不等于成交证据完整；资金费行情也不代表结算费用已经对账。规则或结算证据不足时，C 保持暂停。</p>
    <p className={styles.empty}>C 初始本金是按前向起点净值冻结的假设现金禀赋，不代表 A 已实现或可提取资金；此后只将 C 自身已实现净收益纳入复利。</p>
    <CandidateCurve points={envelope?.observations ?? []}/>
    <details><summary>研究规则与证据边界</summary><p>初始保护线为本金的 99%；确认收益达到 5% 后，保护峰值利润的 60%。单个风险组上限 0.75%，且所有新增风险共享保护余量的 25%，先扣已有压力风险；现行 1% / 5% / 4 倍上限继续约束。</p><p>只观察 A 已执行的机会子集，不补造被 A 拒绝的信号。旧仓排除 {r?.sourceScope.carryInPositionCount ?? "—"} 笔；合格周期 {r?.validation.eligibleCompletedCampaigns ?? 0}，排除周期 {r?.validation.excludedCompletedCampaigns ?? 0}。保护线不是现金隔离或成交保证。</p><p>前向起点 {time(r?.startedAt)}；C 源时间 {time(r?.sourceAsOf)}；A / B 源时间 {time(baseline?.sourceAsOf)}。曲线展示最近 360 次持久摘要，全部历史保留；摘要不代替逐 tick 成交证据。</p><ul>{r?.gates.blockers.map((reason) => <li key={reason}>{labels[reason] ?? <><span>证据闸门：</span><code>{reason}</code></>}</li>)}</ul></details>
  </section>;
}
