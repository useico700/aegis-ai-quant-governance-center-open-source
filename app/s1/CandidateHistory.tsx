import styles from "./s1.module.css";
import { formatBinancePrice } from "../../lib/s1-price-display.mjs";
import type { MarketQuote, PrecisionRule } from "./PriceCalibration";

export type FilteredCandidate = {
  key: string;
  planId: string;
  symbol: string;
  direction: "LONG" | "SHORT" | null;
  stage: "SIGNAL_CONFIRMATION" | "EXECUTION_GATE" | "CANDIDATE_LIFECYCLE";
  reason: string;
  evaluatedAt: string;
  intersectionTime: string | null;
  intersectionPrice: number | null;
  replacementPlanId?: string;
};

const reasons: Record<string, string> = {
  CONFIRMATION_RESERVE_NOT_CLOSED: "入场确认K线尚未收盘",
  CROSS_BUFFER_WAITING_IMMEDIATE_SECOND_BAR: "首根收盘未完成方向确认，等待下一根K线",
  TWO_BAR_CROSS_CLOSES_INSIDE_BUFFER: "连续两根收盘仍位于交汇缓冲区内",
  CROSS_BAR_CLOSE_INSIDE_BUFFER: "交汇K线收盘仍位于缓冲区内",
  CONFIRMATION_RESERVE_EXPIRED: "确认窗口结束，未形成有效突破",
  SIGNAL_EXPIRED: "信号超过执行有效期",
  ENTRY_BARS_UNAVAILABLE: "入场周期K线证据不完整",
  IQ1_PROJECTED_CROSS_FAR_FROM_PRICE: "交汇点距离现价过远",
  IQ1_PX_DISTANCE_EXCEEDED: "成交价距离 Px 超过限制",
  IQ1_PX_SAME_SIDE_BAND_WAIT: "等待实时可执行价进入 Px 同侧 2% 区",
  IQ1_PX_SAME_SIDE_WAIT: "等待实时可执行价回到 Px 的方向同侧",
  IQ1_CONFIRMING_CLOSE_WRONG_PX_SIDE: "方向确认收盘位于 Px 错误一侧",
  IQ1_NO_CONVERGENCE: "交汇前收敛程度不足",
  IQ1_NO_POST_CROSS_EXPANSION: "交汇后尚未形成初始发散",
  IQ1_RETURNING_NOT_EXPANDING: "价格正在回撤，未保持初始发散",
  IQ1_WRONG_PX_SIDE: "价格位于 Px 的错误方向",
  IQ1_CROSS_ANCHOR_MISSING: "缺少交汇时刻逐笔成交锚点",
  IQ1_CONFIRMATION_DATA_UNKNOWN: "确认K线数据不完整",
  IQ1_CORRELATED_OPPOSITE_EXPOSURE: "关联币已有反向敞口",
  IQ1_CORRELATED_GROUP_CAPACITY: "关联币组仓位或风险额度已满",
  IQ1_CORRELATION_OR_CAPACITY_UNKNOWN: "关联性或组合容量证据不足",
  ENTRY_DISPLACEMENT_EXCEEDED: "成交报价偏离信号收盘价超过50bps",
  R22_COST_EFFICIENCY_REJECTED: "止损距离与交易成本的收益风险效率不足",
  EVENT_GATE_CLOSED: "宏观风险事件窗口暂停新仓",
  POSITION_OR_SIGNAL_ALREADY_USED: "同币种已有持仓或信号已经使用",
  EXISTING_SYMBOL_POSITION: "同币种已有持仓",
  RISK_BUDGET_UNAVAILABLE: "单笔或组合风险预算不足",
  TRIAL_GROSS_CAP_REACHED: "账户总名义敞口已达上限",
  TRIAL_POSITION_CAP_REACHED: "账户持仓数量已达上限",
  MARGIN_CAPACITY_MISSING: "可用保证金或杠杆容量不足",
  ACCOUNT_NOT_RECONCILED_HEDGE_SINGLE_ASSET: "账户模式或持仓对账未通过",
  ACCOUNT_OR_USER_STREAM_STALE: "账户快照或账户事件流过时",
  INFRASTRUCTURE_GATE_CLOSED: "执行基础设施就绪门未通过",
  FORWARD_MARKET_EVIDENCE_STALE: "Tick/BBO 前向行情证据过时",
  FORWARD_MARKET_EVIDENCE_INCOMPLETE: "Tick/BBO 连续性证据不完整",
  FEE_SLIPPAGE_EVIDENCE_INVALID: "手续费或滑点证据不足",
  MARK_PRICE_STALE: "标记价格过时",
  STOP_NOT_PROTECTIVE: "初始止损方向不具保护性",
  R21_DIRECTION_ENTRY_FROZEN: "组合方向冻结门正在生效",
  CANDIDATE_SUPERSEDED: "同币种出现更新结构，旧候选已被替代",
  CANDIDATE_REMOVED: "候选已从扫描结果移除",
  NEWER_READY_CANDIDATE_WON_ENTRY_RACE: "同币种更新计划先达到入场条件，旧等待计划已取消",
};

const clock = (value: string | null) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(value)) : "—";
export default function CandidateHistory({ rows = [], quotes, rules }: { rows?: FilteredCandidate[]; quotes?: MarketQuote[]; rules?: PrecisionRule[] }) {
  const quoteBySymbol = new Map(quotes?.map(quote => [quote.symbol, quote]));
  const ruleBySymbol = new Map(rules?.map(rule => [rule.symbol, rule]));
  return <details className={styles.filteredHistory}>
    <summary>
      <span><b>未入场记录</b></span>
      <strong>{rows.length} 条</strong><span className={styles.historyToggle} aria-hidden="true">⌄</span>
    </summary>
    {!rows.length ? <div className={styles.historyEmpty}>暂无未入场历史记录。</div>
      : <div className={styles.historyTable} role="region" aria-label="候选未入场历史，可上下及左右滚动" tabIndex={0}><table>
        <thead><tr><th>评估时间</th><th>交易对 / 方向</th><th>未入场原因</th><th>拦截阶段</th><th>交汇时间 / Px</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>
          <td>{clock(row.evaluatedAt)}</td>
          <td><strong>{row.symbol.replace("USDT", "")}</strong><small>{row.direction === "LONG" ? "做多" : row.direction === "SHORT" ? "做空" : "方向未确认"}</small></td>
          <td><b>{reasons[row.reason] ?? "未通过策略入场条件"}</b><small title={row.reason}>{row.reason}</small></td>
          <td><span className={styles.historyStage}>{row.stage === "SIGNAL_CONFIRMATION" ? "收线确认" : row.stage === "CANDIDATE_LIFECYCLE" ? "候选生命周期" : "执行门"}</span></td>
          <td>{clock(row.intersectionTime)}<small>Px {formatBinancePrice(row.intersectionPrice, quoteBySymbol.get(row.symbol)?.tickSize ?? ruleBySymbol.get(row.symbol)?.price.step, quoteBySymbol.get(row.symbol))}</small></td>
        </tr>)}</tbody>
      </table></div>}
  </details>;
}
