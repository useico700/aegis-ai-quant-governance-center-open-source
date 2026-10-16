"use client";

import { useCallback, useEffect, useState } from "react";
import bootstrapSnapshot from "./bootstrap-snapshot.json";
import styles from "./v5-au.module.css";

type DisplayRow = Record<string, unknown>;
type Snapshot = Omit<typeof bootstrapSnapshot, "positions" | "candidates" | "fills"> & { positions: DisplayRow[]; candidates: DisplayRow[]; fills: DisplayRow[] };
type Envelope = { status: string; sourceAsOf: string; receivedAt: string; snapshot: Snapshot };
const initialEnvelope: Envelope = { status: "BOOTSTRAP_SNAPSHOT", sourceAsOf: bootstrapSnapshot.sourceAsOf, receivedAt: bootstrapSnapshot.sourceAsOf, snapshot: bootstrapSnapshot as Snapshot };
const cny = (value: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const shown = (value: string | number | null) => value == null || value === "" ? "—" : String(value);
const statusLabel = (value: string) => ({ WAITING_CTP_CONFIGURATION: "等待 CTP 配置", WAITING_CTP_CONFIGURATION_NOT_STARTED: "等待 CTP 配置 / 未启动", CLOSED_WAITING_CALENDAR: "闭市 / 等待日历", WAITING_CAUSAL_OBSERVATIONS: "等待因果观测" }[value] ?? value.replaceAll("_", " "));
const field = (row: DisplayRow, key: string) => shown(typeof row[key] === "string" || typeof row[key] === "number" ? row[key] as string | number : null);

export default function V5AuPage() {
  const [envelope, setEnvelope] = useState<Envelope>(initialEnvelope);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (visible = true) => {
    if (visible) setRefreshing(true);
    try {
      const response = await fetch("/api/v5-au", { cache: "no-store" });
      if (!response.ok) throw new Error("监视器数据暂不可用");
      setEnvelope(await response.json() as Envelope); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "监视器数据暂不可用"); }
    finally { if (visible) setRefreshing(false); }
  }, []);
  useEffect(() => { const first = window.setTimeout(() => void refresh(false), 0); const timer = window.setInterval(() => void refresh(false), 30_000); return () => { window.clearTimeout(first); window.clearInterval(timer); }; }, [refresh]);
  const snapshot = envelope.snapshot;
  const stages = ["0.5R", "1R", "2R", "Runner"];
  const marginUsage = snapshot.account.equityCny > 0 ? snapshot.account.marginUsedCny / snapshot.account.equityCny * 100 : 0;
  const riskUsage = snapshot.account.equityCny > 0 ? snapshot.risk.managedRiskCny / snapshot.account.equityCny * 100 : 0;

  return <main className={styles.page} data-v5-au-monitor="dedicated-read-only" data-refresh-seconds="30">
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}><span className={styles.mark}>AU</span><div><p>ORION V5</p><h1>黄金期货控制台</h1></div></div>
        <div className={styles.headerState}><i/><div><b>{statusLabel(snapshot.status)}</b><small>{shown(snapshot.sourceAsOf)}</small></div><button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "···" : "刷新"}</button></div>
      </header>
      {(error || snapshot.risk.entriesBlocked) && <aside className={styles.notice}><b>{error ? "数据链路提示" : "开仓闸门关闭"}</b><span>{error ?? statusLabel(snapshot.risk.blockReason)}</span></aside>}

      <section className={styles.hero}>
        <div><span className={styles.eyebrow}>V5 黄金账户 · CNY</span><strong>{cny(snapshot.account.equityCny)}</strong><small>初始资金 ¥{cny(snapshot.account.initialCapitalCny)} · 可用 ¥{cny(snapshot.account.availableCny)}</small></div>
        <div className={styles.heroMetrics}><span><small>已实现</small><b>¥{cny(snapshot.account.realizedPnlCny)}</b></span><span><small>未实现</small><b>¥{cny(snapshot.account.unrealizedPnlCny)}</b></span><span><small>保证金</small><b>¥{cny(snapshot.account.marginUsedCny)}</b></span><span><small>累计费用</small><b>¥{cny(snapshot.account.feesCny)}</b></span></div>
      </section>

      <section className={styles.grid}>
        <article className={styles.marketCard}>
          <div className={styles.cardTitle}><span>01</span><div><h2>CTP 行情</h2><p>生产 MdApi · 只读 · 双时钟</p></div></div>
          <div className={styles.contract}><div><small>当前合约</small><strong>{shown(snapshot.market.currentInstrumentId)}</strong></div><em>{snapshot.market.exchange} · {snapshot.market.product}</em></div>
          <dl className={styles.definition}><div><dt>连接</dt><dd>{statusLabel(snapshot.connection.status)}</dd></div><div><dt>交易日</dt><dd>{shown(snapshot.market.tradingDay)}</dd></div><div><dt>时段</dt><dd>{statusLabel(snapshot.market.session)}</dd></div><div><dt>前向 Tick</dt><dd>{shown(snapshot.connection.lastForwardTickAt)}</dd></div></dl>
          <div className={styles.bbo}><span><small>Bid 1</small><b>{shown(snapshot.market.bidPrice1)}</b><em>{shown(snapshot.market.bidVolume1)} 手</em></span><span><small>Ask 1</small><b>{shown(snapshot.market.askPrice1)}</b><em>{shown(snapshot.market.askVolume1)} 手</em></span></div>
        </article>

        <article className={styles.riskCard}>
          <div className={styles.cardTitle}><span>02</span><div><h2>风险与容量</h2><p>整数手 · 风险 / 杠杆 / 保证金三重约束</p></div></div>
          <div className={styles.gauges}><div><span style={{ width: `${Math.min(100, riskUsage / 5 * 100)}%` }}/><b>组合风险 {riskUsage.toFixed(2)}% / 5.00%</b></div><div><span style={{ width: `${Math.min(100, marginUsage)}%` }}/><b>保证金占用 {marginUsage.toFixed(2)}%</b></div></div>
          <dl className={styles.definition}><div><dt>单次风险</dt><dd>1.00% × 98%</dd></div><div><dt>有效名义杠杆</dt><dd>≤ 4.00x</dd></div><div><dt>持仓</dt><dd>{snapshot.risk.openPositionCount} / 1</dd></div><div><dt>当前风险额</dt><dd>¥{cny(snapshot.risk.managedRiskCny)}</dd></div></dl>
        </article>

        <article className={styles.planCard}>
          <div className={styles.cardTitle}><span>03</span><div><h2>整数分批计划</h2><p>最接近 R22 累计比例 · 最后阶段清仓</p></div></div>
          <div className={styles.planTotal}><span>原始计划</span><b>{snapshot.partialPlan.originalLots} 手</b></div>
          <div className={styles.stages}>{stages.map((label, index) => <div key={label}><span>{label}</span><b>{snapshot.partialPlan.stageLots[index] ?? 0} 手</b><small>累计 {snapshot.partialPlan.cumulativeLots[index] ?? 0}</small></div>)}</div>
          <p className={styles.hint}>手数不足的阶段确定性延后；任何取整都不得突破风险上限。</p>
        </article>

        <article className={styles.rollCard}>
          <div className={styles.cardTitle}><span>04</span><div><h2>主力与换月</h2><p>成交量 → 持仓量 → 合约号，全部因果</p></div></div>
          <div className={styles.rollState}><b>{statusLabel(snapshot.roll.status)}</b><span>当前 {shown(snapshot.roll.currentInstrumentId)}</span><span>候选 {shown(snapshot.roll.pendingInstrumentId)}</span></div>
          <p className={styles.hint}>持仓中禁止静默换约；连续复权价不得参与模拟成交。</p>
        </article>
      </section>

      <section className={styles.tables}>
        <article><div className={styles.cardTitle}><span>05</span><div><h2>持仓与候选</h2><p>当前合约、入场、标记、止损与阶段</p></div></div>{snapshot.positions.length ? <div className={styles.rows}>{snapshot.positions.map((row, index) => <div key={field(row,"id") + index}><b>{field(row,"instrumentId")} · {field(row,"side")}</b><span>{field(row,"lots")} 手 · 入场 {field(row,"entryPrice")} · 标记 {field(row,"markPrice")} · 止损 {field(row,"stopPrice")}</span><em>{field(row,"stage")}</em></div>)}</div> : <div className={styles.empty}>当前无持仓</div>}{snapshot.candidates.length ? <div className={styles.rows}>{snapshot.candidates.map((row, index) => <div key={field(row,"id") + index}><b>{field(row,"instrumentId")} · {field(row,"side")}</b><span>交汇 {field(row,"intersectionTime")} · {field(row,"intersectionPrice")}</span><em>{field(row,"status")}</em></div>)}</div> : <div className={styles.empty}>当前无候选</div>}</article>
        <article><div className={styles.cardTitle}><span>06</span><div><h2>成交与费用</h2><p>平今 / 平昨 / 券商加收独立归因</p></div></div><div className={styles.feeGrid}><span><small>开仓</small><b>¥{cny(snapshot.fees.openCny)}</b></span><span><small>平今</small><b>¥{cny(snapshot.fees.closeTodayCny)}</b></span><span><small>平昨</small><b>¥{cny(snapshot.fees.closeYesterdayCny)}</b></span><span><small>券商加收</small><b>¥{cny(snapshot.fees.brokerSurchargeCny)}</b></span></div>{snapshot.fills.length ? <div className={styles.rows}>{snapshot.fills.map((row, index) => <div key={field(row,"id") + index}><b>{field(row,"instrumentId")} · {field(row,"action")}</b><span>{field(row,"lots")} 手 @ {field(row,"price")} · 费用 ¥{field(row,"feeCny")}</span><em>{field(row,"exchangeTimestamp")}</em></div>)}</div> : <div className={styles.empty}>尚无成交记录</div>}</article>
      </section>
      <footer><span>纸面订单 {snapshot.system.paperOrderCount}</span><span>真实订单 {snapshot.system.realOrderCount}</span><span>常驻进程 {snapshot.system.residentProcessStarted ? "已启动" : "未启动"}</span><span>每 30 秒刷新</span></footer>
    </div>
  </main>;
}
