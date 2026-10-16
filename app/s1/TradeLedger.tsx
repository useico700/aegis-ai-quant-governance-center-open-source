"use client";
import { useEffect, useRef } from "react";
import { createBinanceDisplay } from "../../lib/s1-price-display.mjs";
import { candidateInputState } from "../../lib/s1-candidate-funnel.mjs";
import type { MarketQuote, PrecisionRule } from "./PriceCalibration";
import styles from "./trade-ledger.module.css";
import type { FilteredCandidate } from "./CandidateHistory";

export type CandidatePriority = { planId: string; symbol: string; direction: "LONG" | "SHORT"; state: "WAITING" | "SUBMITTING" | "POSITION_OPEN"; reason: string | null; evaluatedAt: string };
export type CandidateSource = { state: "READY" | "UNAVAILABLE"; reason: string | null; observedAt: number | null; checkedAt: number; candidateCount: number | null; lastGoodAt: number | null };
export type ExecutionState = { publicSimulation?: boolean; portfolioProtection?: { revision: string; evidenceHold: boolean; evaluatedAt: string | null; holdReasons: (string | null)[]; campaigns: { direction: string; active: boolean; positionCount: number; highWaterPnlUsdt: number; markedPnlUsdt: number; drawdownFraction: number; entryProtectionTier: string; regime: string; freezeUntil: string | null }[] } | null; candidateSource?: CandidateSource | null; candidatePriorities?: CandidatePriority[]; observedAt: string | null; service: string | null; mode: string | null; status: string | null; infrastructureReady: boolean; realOrdersAllowed: boolean; entriesAllowed: boolean; liveReady: boolean; orderAuthorizationStatus: string | null; entryIncident: string | null; entryBlockers: { key: string; planId: string | null; symbol: string | null; direction: "LONG" | "SHORT" | null; reason: string | null; classification: "RETRYABLE" | "CAPACITY_WAIT" | "UNCLASSIFIED" | null; evaluatedAt: string | null }[]; positionStages: { symbol: string; direction: "LONG" | "SHORT"; stage: "INITIAL" | "SOFT" | "ONE_R" | "TAIL"; quantity: string; originalQuantity: string; stop: string }[]; openPositions: number | null; openOrders: number | null; openAlgoOrders: number | null; strategyRuntime: null | { entryAdmissionRevision?: string | null; baseImplementationRevision?: string | null; costPolicyRevision?: string | null; candidatePriorityRevision?: string | null; displayName: string; executionRevision: string | null; entryQualityRevision: string | null; managementRevision?: string | null; entryConfirmationRevision?: string | null; entryQualityPolicyRevision?: string | null; pxDistanceGateEnabled?: boolean; portfolioProtectionRevision?: string | null; maximumCompleteLifecycleCostR?: number | null; runtimeLoaded: boolean; riskPolicy: { mode: string; perTradeFraction: string; portfolioFraction: string; maximumOpenPositions: number; maximumLeverage: number; maximumGrossNotionalLeverage: number; grossNotionalMustNotExceedEquity: boolean; effectiveMaximumGroupPositions: number | null } } };
export type FillRow = { key: string; tradeId: string; orderId: string; symbol: string; positionSide: string; side: string; quantity: string; price: string; commission: string; feeAsset: string; realizedPnlUsdt: string; netPnlUsdt: string; time: number; attribution: string; attemptId: string | null };
export type ExecutionLedger = { status: string; observedAt: string | null; receivedAt: string | null; execution: ExecutionState | null; filteredCandidates: FilteredCandidate[]; fills: FillRow[]; summary: { fillCount: number; commissionUsdt: string; realizedPnlUsdt: string; netPnlUsdt: string } };

const time = (value: number | string | null | undefined) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
const number = (value: string | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(Number(value));
const signed = (value: string | null | undefined) => value == null ? "—" : `${Number(value) > 0 ? "+" : ""}${number(value)}`;
const incidentLabel = (incident: string) => {
  if (/^ACCOUNT_(ACTIVITY|STREAM)_/.test(incident)) return "暂停 · 账户活动待复核";
  if (/^(READ_BUDGET_|READ_DISPATCH_|COORDINATED_READ_)/.test(incident)) return "恢复中 · 读取调度";
  if (/(POSITION|PROTECTION|STOP|QUARANTINE|OWNED)/.test(incident)) return "暂停 · 持仓保护待复核";
  return "暂停 · 执行异常待复核";
};
export const executionLabel = (execution: ExecutionState | null | undefined, fresh: boolean, now = Date.now(), inputStateOverride?: "READY" | "UNAVAILABLE" | "UNKNOWN") => {
  if (!execution || !fresh) return "状态待核验";
  if ((execution as ExecutionState & {publicSimulation?:boolean}).publicSimulation) return "本地模拟 · 订单写入关闭";
  if (execution.entryIncident) return incidentLabel(execution.entryIncident);
  if (execution.realOrdersAllowed && !execution.entriesAllowed) return "暂停 · 新开仓受限";
  const sourceState = inputStateOverride ?? candidateInputState(execution, fresh, now);
  if (execution.realOrdersAllowed && sourceState === "UNAVAILABLE") return "运行中 · 等待扫描恢复";
  if (execution.realOrdersAllowed && sourceState === "UNKNOWN") return "运行中 · 候选状态待核验";
  if (execution.liveReady) return "正常 · 自动交易";
  if (execution.realOrdersAllowed && execution.entriesAllowed && !execution.infrastructureReady) return "预热中 · 安全校验";
  if (execution.realOrdersAllowed) return "已授权 · 安全校验";
  return "未启用";
};
const action = (row: FillRow) => row.positionSide === "LONG" ? row.side === "BUY" ? "买入开多" : "卖出平多"
  : row.positionSide === "SHORT" ? row.side === "SELL" ? "卖出开空" : "买入平空" : row.side === "BUY" ? "买入" : "卖出";

export default function TradeLedger({ accountLabel = "S1", accountOnly = false, ledger, now, rules, quotes, failure = false }: { accountLabel?: string; accountOnly?: boolean; ledger?: ExecutionLedger; now: number; rules?: PrecisionRule[]; quotes?: MarketQuote[]; failure?: boolean }) {
  const display = createBinanceDisplay(rules, quotes);
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => { if (window.location.hash === "#fills" && disclosure.current) disclosure.current.open = true; };
    const navigate = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest('a[href="#fills"]') && disclosure.current) disclosure.current.open = true; };
    reveal();
    window.addEventListener("hashchange", reveal);
    document.addEventListener("click", navigate);
    return () => { window.removeEventListener("hashchange", reveal); document.removeEventListener("click", navigate); };
  }, []);
  const execution = ledger?.execution, observedAt = accountOnly ? ledger?.observedAt : execution?.observedAt, age = observedAt && now ? now - Date.parse(observedAt) : Infinity;
  const fresh = !failure && ledger?.status === "OK" && age >= -5000 && age <= 180000;
  const fills = ledger?.fills ?? [], summary = ledger?.summary;
  return <details ref={disclosure} id="fills" className={styles.ledger} aria-labelledby="fills-title">
    <summary className={styles.heading}><div><span>{accountLabel} · BINANCE USDⓈ-M</span><h2 id="fills-title">成交流水 <span className={styles.count}>{summary?.fillCount ?? "—"} 笔</span></h2></div><strong className={execution?.entryIncident ? styles.hold : fresh ? styles.live : styles.muted}>{fresh ? "已同步" : "同步待核验"}</strong><span className={styles.toggle}><span className={styles.whenClosed}>展开</span><span className={styles.whenOpen}>收起</span><span className={styles.chevron} aria-hidden="true">⌄</span></span></summary>
    <div className={styles.body}>
    <div className={styles.summary}>
      <div><span>最近成交笔数</span><b>{summary?.fillCount ?? "—"}</b><small>交易所逐笔成交</small></div>
      <div><span>手续费</span><b>{number(summary?.commissionUsdt)}</b><small>USDT</small></div>
      <div><span>已实现价差</span><b className={Number(summary?.realizedPnlUsdt ?? 0) < 0 ? styles.negative : styles.live}>{signed(summary?.realizedPnlUsdt)}</b><small>USDT</small></div>
      <div><span>成交净结果</span><b className={Number(summary?.netPnlUsdt ?? 0) < 0 ? styles.negative : styles.live}>{signed(summary?.netPnlUsdt)}</b><small>价差减手续费 · USDT</small></div>
    </div>
    {!fresh && ledger && <p className={styles.notice}>同步时间 {time(ledger.observedAt)} · 当前快照已过时或连接异常。</p>}
    {failure && <p className={styles.notice}>成交流水同步暂时不可用；下表保留上次已核验记录。</p>}
    {!fills.length ? <div className={styles.empty}><h3>暂无已同步成交</h3><p>候选计划不会在这里显示；只有交易所确认的真实成交才进入流水。</p></div> : <div className={styles.scroll} role="region" aria-label={`${accountLabel} 最近真实成交流水`} tabIndex={0}><table>
      <thead><tr><th>北京时间</th><th>交易对 / 方向</th><th>动作</th><th>数量</th><th>成交价</th><th>手续费</th><th>已实现价差</th><th>净结果</th><th>订单 / 成交</th></tr></thead>
      <tbody>{fills.map(row => <tr key={row.key}>
        <td>{time(row.time)}</td><td><strong>{row.symbol.replace("USDT", "")}</strong><small>{row.positionSide === "LONG" ? "多头" : row.positionSide === "SHORT" ? "空头" : "双向"}</small></td>
        <td>{action(row)}<small>{row.attribution === "OWNER_DIRECTED_TEST" ? "老板指令测试" : row.attribution === "STRATEGY" ? `${accountLabel} 策略` : "账户外部成交"}</small></td>
        <td>{display.quantity(row.quantity, row.symbol)}</td><td>{display.price(row.price, row.symbol)}</td><td>{number(row.commission)} USDT</td><td className={Number(row.realizedPnlUsdt) < 0 ? styles.negative : ""}>{signed(row.realizedPnlUsdt)}</td><td className={Number(row.netPnlUsdt) < 0 ? styles.negative : styles.live}>{signed(row.netPnlUsdt)}</td><td><small>#{row.orderId}<br />成交 #{row.tradeId}</small></td>
      </tr>)}</tbody>
    </table></div>}
    <p className={styles.caption}>{accountOnly ? "初次同步近7天，页面展示最近100笔已记录成交。" : "页面展示最近100笔已记录成交。"}流水按交易所 tradeId 去重并持久保留。已实现价差不含手续费；成交净结果＝已实现价差－手续费。老板指令测试、策略与账户外部成交分开归因。</p>

    </div>
  </details>;
}
