"use client";

import { useCallback, useEffect, useState } from "react";
import { MONITOR_COMMON_COPY, MONITOR_PRESENTATION_REVISION } from "../../monitor-sync";
import styles from "./shadow.module.css";

type RecordRow = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  openedAt: number;
  closedAt: number | null;
  recordStatus: "OPEN" | "CLOSED";
  classification: "SHADOW_PASS" | "SHADOW_REJECT" | "EXCLUDED_MISSING_ENTRY_RISK_EVIDENCE";
  completeLifecycleCostR: number | null;
  netPnlUsdt: number | null;
  commissionUsdt: number | null;
};

type CostGateStudy = {
  experimentId: string;
  displayName: string;
  status: string;
  prospectiveStart: string;
  sourceImplementationRevision: string;
  rule: { maximumCompleteLifecycleCostR: number; takerFeeRate: number; adverseSlippageRate: number };
  sample: { observedEntryCount: number; eligibleEntryCount: number; passEntryCount: number; rejectEntryCount: number; excludedEntryCount: number; openEntryCount: number; attributableClosedCount: number; passClosedCount: number; rejectClosedCount: number; minimumAttributableClosedPositions: number; progressFraction: number; readyForReview: boolean };
  outcomes: { hf11ObservedNetPnlUsdt: number; shadowAcceptedNetPnlUsdt: number; shadowRejectedObservedNetPnlUsdt: number; hf11ObservedCommissionUsdt: number; shadowAcceptedCommissionUsdt: number; shadowRejectedObservedCommissionUsdt: number; averageCompleteLifecycleCostR: number | null };
  records: RecordRow[];
  phaseB: { status: string; proposedMinimumConsensusSupport: number; recordingActive: boolean };
  baselineExecutionChanged: boolean;
  ordersOrPositionsAffected: boolean;
};

type Envelope = { status: string; sourceAsOf: string; snapshot: { shadowStudies?: { costGate?: CostGateStudy } } };

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function signed(value: number | null) { return value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${money.format(Math.abs(value))}`; }
function time(value: number | string) { return dateTime.format(new Date(value)).replaceAll("/", "-"); }
function resultLabel(value: RecordRow["classification"]) { return value === "SHADOW_PASS" ? "通过 0.12R" : value === "SHADOW_REJECT" ? "影子剔除" : "证据不足"; }

export default function Hf12aShadowPage() {
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/v3-equity?shadow=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("测试数据暂不可用");
      setEnvelope(await response.json() as Envelope);
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "测试数据暂不可用"); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const resume = () => void refresh();
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); };
  }, [refresh]);

  const study = envelope?.snapshot.shadowStudies?.costGate;
  if (!study || study.status !== "ACTIVE_OBSERVE_ONLY") return <main className={styles.loading} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}><div>HF12-A</div><p>{error ?? "正在等待首份前向测试快照…"}</p><a href="/v3-equity">返回 V3 监视器</a></main>;
  const progress = Math.round(study.sample.progressFraction * 100);

  return <main className={styles.page} data-monitor-sync-revision={MONITOR_PRESENTATION_REVISION}>
    <div className={styles.shell}>
      <header className={styles.header}>
        <div><a href="/v3-equity">← V3 监视器</a><p>OBSERVE ONLY · FORWARD RECORD</p><h1>HF12-A 成本闸门测试记录</h1></div>
        <div className={styles.live}><i/><span>{MONITOR_COMMON_COPY.healthy} · 影子记录中</span><small>{MONITOR_COMMON_COPY.sourceTime} · {time(envelope.sourceAsOf)} CST</small></div>
      </header>

      <section className={styles.boundary}><b>HF11继续按原规则运行</b><span>本页只做前向反事实记录；不拦截订单、不改变仓位、不自动晋级。</span></section>

      <section className={styles.hero}>
        <div><small>完整生命周期成本上限</small><strong>≤ {study.rule.maximumCompleteLifecycleCostR.toFixed(2)}R</strong><p>手续费与不利滑点，在入场时统一换算为风险占比。</p></div>
        <div className={styles.progress}><span><b>{study.sample.attributableClosedCount}</b> / {study.sample.minimumAttributableClosedPositions} 笔可归因平仓</span><div><i style={{ width: `${progress}%` }}/></div><small>{study.sample.readyForReview ? "已达到首轮复盘门槛" : `前向样本进度 ${progress}%`}</small></div>
      </section>

      <section className={styles.metrics}>
        <article><small>已观察入场</small><b>{study.sample.observedEntryCount}</b><span>当前开放 {study.sample.openEntryCount}</span></article>
        <article><small>成本通过</small><b className={styles.positive}>{study.sample.passEntryCount}</b><span>已平 {study.sample.passClosedCount}</span></article>
        <article><small>影子剔除</small><b className={styles.warning}>{study.sample.rejectEntryCount}</b><span>已平 {study.sample.rejectClosedCount}</span></article>
        <article><small>平均完整成本</small><b>{study.outcomes.averageCompleteLifecycleCostR == null ? "—" : `${study.outcomes.averageCompleteLifecycleCostR.toFixed(3)}R`}</b><span>固定规则，不调参</span></article>
      </section>

      <section className={styles.compare}>
        <div><small>HF11同期实际结果</small><b className={study.outcomes.hf11ObservedNetPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(study.outcomes.hf11ObservedNetPnlUsdt)} USDT</b><span>手续费 {money.format(study.outcomes.hf11ObservedCommissionUsdt)}</span></div>
        <i>→</i>
        <div><small>HF12-A影子保留结果</small><b className={study.outcomes.shadowAcceptedNetPnlUsdt >= 0 ? styles.positive : styles.negative}>{signed(study.outcomes.shadowAcceptedNetPnlUsdt)} USDT</b><span>手续费 {money.format(study.outcomes.shadowAcceptedCommissionUsdt)}</span></div>
        <div className={styles.rejected}><small>被闸门剔除交易的同期结果</small><b>{signed(study.outcomes.shadowRejectedObservedNetPnlUsdt)} USDT</b><span>仅反事实归因</span></div>
      </section>

      <section className={styles.records}>
        <div className={styles.sectionHead}><div><p>只收录启动后的HF11入场，执行事故排除在策略有效性外</p><h2>逐笔前向记录</h2></div><span>启动 {time(study.prospectiveStart)}</span></div>
        <div className={styles.tableHead}><span>标的</span><span>入场时间</span><span>完整成本</span><span>影子判定</span><span>结果</span><span>手续费</span></div>
        {study.records.length ? study.records.map((row) => <article key={row.id}>
          <div><b>{row.symbol}</b><small className={row.side === "LONG" ? styles.positive : styles.negative}>{row.side === "LONG" ? "多" : "空"}</small></div>
          <time>{time(row.openedAt)}</time>
          <strong>{row.completeLifecycleCostR == null ? "—" : `${row.completeLifecycleCostR.toFixed(3)}R`}</strong>
          <span className={row.classification === "SHADOW_PASS" ? styles.pass : row.classification === "SHADOW_REJECT" ? styles.reject : styles.excluded}>{resultLabel(row.classification)}</span>
          <b className={row.netPnlUsdt == null ? undefined : row.netPnlUsdt >= 0 ? styles.positive : styles.negative}>{row.recordStatus === "OPEN" ? "持仓中" : `${signed(row.netPnlUsdt)} USDT`}</b>
          <span>{row.commissionUsdt == null ? "—" : money.format(row.commissionUsdt)}</span>
        </article>) : <div className={styles.empty}>启动后尚无新入场；系统会在下一笔HF11入场时自动开始记录。</div>}
      </section>

      <section className={styles.nextPhase}><div><small>下一阶段</small><h2>HF12-B · 至少两个交汇依据</h2></div><span>锁定中</span><p>只有HF12-A达到100笔可归因平仓并完成复盘后，才会单独申请启动；当前不记录、不执行。</p></section>
    </div>
  </main>;
}
