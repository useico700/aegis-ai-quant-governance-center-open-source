"use client";

import { useState, type CSSProperties } from "react";
import { createBinanceDisplay } from "../../lib/s1-price-display.mjs";
import { partitionCandidateFunnel } from "../../lib/s1-candidate-funnel.mjs";
import { arrivalCountdown, candidateStatusNote } from "../../lib/s1-arrival.mjs";
import { summarizePxDistance } from "../../lib/s1-px-distance.mjs";
import { calendarFreshness, DAY, eventPhase, rollingEvents } from "../../lib/s1-risk-calendar.mjs";
import { useTween, spotlight } from "./motion";
import type { AccountRecord, Candidate, EventGate, ExecutionLedger, ExecutionState, FilteredCandidate, FillRow, MarketQuote, PrecisionRule, RiskCalendarFeed, RiskEvent } from "./types";
import styles from "./s1-pro.module.css";

const money = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const signedMoney = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${money(value)}`;
const eight = (value: string | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 }).format(Number(value));
const signedEight = (value: string | null | undefined) => value == null ? "—" : `${Number(value) > 0 ? "+" : ""}${eight(value)}`;
export const clock = (value: string | number | null | undefined) => value != null && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)) : "—";
const shortStamp = (at: string, date = true) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...(date ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
const sideLabel = (value: string | null | undefined) => value === "LONG" ? "多头" : value === "SHORT" ? "空头" : "方向待定";

export function Tween({ value, format = value => money(value) }: { value: number | null | undefined; format?: (value: number) => string }) {
  const tweened = useTween(value ?? null);
  return <>{tweened == null ? "—" : format(tweened)}</>;
}

function Tabs<T extends string>({ items, value, onChange, label }: { items: readonly (readonly [T, string, number | null | undefined])[]; value: T; onChange: (value: T) => void; label: string }) {
  const index = Math.max(0, items.findIndex(item => item[0] === value));
  return <div className={styles.tabsScroll}><div className={styles.tabs} role="group" aria-label={label} style={{ "--count": items.length, "--index": index } as CSSProperties}>
    <span className={styles.tabsIndicator} aria-hidden="true" />
    {items.map(([id, title, count]) => <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>{title}<em>{count ?? "—"}</em></button>)}
  </div></div>;
}

/* ================= positions ================= */
const STAGES = [["INITIAL", "初始仓"], ["SOFT", "0.5R 保护"], ["ONE_R", "1R 止盈"], ["TAIL", "尾仓跟踪"]] as const;

export function PositionsPanel({ account, fresh, execution, executionFresh, quotes, rules, now }: { account?: AccountRecord; fresh: boolean; execution?: ExecutionState | null; executionFresh: boolean; quotes: MarketQuote[]; rules: PrecisionRule[]; now: number }) {
  const [tab, setTab] = useState<"positions" | "orders" | "algo">("positions");
  const details = account?.details, display = createBinanceDisplay(rules, quotes);
  const positions = details?.positionRows ?? [];
  const orders = tab === "orders" ? details?.regularOrders : details?.conditionalOrders;
  const complete = tab === "positions" ? details?.positionsComplete : tab === "orders" ? details?.ordersComplete : details?.algoOrdersComplete;
  const count = tab === "positions" ? account?.positions : tab === "orders" ? account?.orders : account?.algoOrders;
  const limit = execution?.strategyRuntime?.riskPolicy.maximumOpenPositions;
  const tabs = [["positions", "持仓", account?.positions], ["orders", "普通挂单", account?.orders], ["algo", "条件挂单", account?.algoOrders]] as const;
  const known = !!details?.positionsComplete && positions.every(row => row.notional !== null);
  const long = known ? positions.filter(row => row.side === "LONG").reduce((sum, row) => sum + Math.abs(row.notional ?? 0), 0) : null;
  const short = known ? positions.filter(row => row.side === "SHORT").reduce((sum, row) => sum + Math.abs(row.notional ?? 0), 0) : null;

  return <section id="positions" className={`${styles.panel} ${styles.reveal}`} aria-labelledby="s1p-positions-title" onPointerMove={spotlight}>
    <header className={styles.panelHead}>
      <div><small>OPEN POSITIONS · 实时账户敞口</small><h2 id="s1p-positions-title">持仓与管理</h2></div>
      <span className={styles.badge}>{account?.positions ?? "—"}{limit ? ` / ${limit}` : ""} 开放仓位</span>
    </header>
    <div className={styles.exposure}>
      <div data-dir="LONG"><span>多头名义</span><b><Tween value={long} /></b><small>USDT</small></div>
      <div data-dir="SHORT"><span>空头名义</span><b><Tween value={short} /></b><small>USDT</small></div>
      <div><span>同步</span><b className={fresh ? styles.good : styles.warn}>{fresh ? "账户已核验" : "待核验"}</b><small>{clock(account?.observedAt)}</small></div>
    </div>
    <Tabs items={tabs} value={tab} onChange={setTab} label="持仓与委托视图" />
    {!fresh && <p className={styles.inlineAlert}>以下为上次账户快照，当前仓位与盈亏待核验。</p>}
    {!complete ? <div className={styles.empty}><b>明细等待同步</b><span>已知数量 {count ?? "—"}，数据缺失不显示为零。</span></div>
      : count === 0 ? <div className={styles.empty}><b>{fresh ? "当前无" : "上次快照无"}{tabs.find(item => item[0] === tab)?.[1]}</b><span>{tab === "positions" ? "没有正在承受市场风险的 S1 仓位" : "没有挂单"}</span></div>
      : tab === "positions" ? <div className={styles.positionGrid}>{positions.map((row, index) => {
        const stage = executionFresh ? execution?.positionStages?.find(item => item.symbol === row.symbol && item.direction === row.side) : undefined;
        const stageIndex = stage ? STAGES.findIndex(item => item[0] === stage.stage) : -1;
        const remaining = stage && Number(stage.originalQuantity) > 0 ? Number(stage.quantity) / Number(stage.originalQuantity) * 100 : null;
        const quote = quotes.find(item => item.symbol === row.symbol), age = now - Date.parse(quote?.exchangeTime ?? "");
        const quoteFresh = fresh && quote?.status === "QUOTED" && age >= -5000 && age <= 10000;
        const mark = quoteFresh ? row.side === "LONG" ? quote?.bidPrice : row.side === "SHORT" ? quote?.askPrice : null : null;
        const entry = Number(row.entryPrice), stop = Number(stage?.stop), live = Number(mark ?? row.markPrice);
        const values = [entry, stop, live].filter(Number.isFinite);
        const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(hi - lo, Math.abs(entry) * 1e-4);
        const pos = (value: number) => Number.isFinite(value) ? 6 + (value - lo) / span * 88 : null;
        return <article key={`${row.symbol}-${row.side}-${index}`} className={styles.position} data-dir={row.side} style={{ "--i": index } as CSSProperties} onPointerMove={spotlight}>
          <header>
            <span className={styles.coin}>{row.symbol?.slice(0, 1)}</span>
            <div><strong>{row.symbol?.replace(/USDT$/, "")}<small>/USDT</small></strong><em data-dir={row.side}>{sideLabel(row.side)}{remaining != null ? ` · 剩 ${remaining.toFixed(0)}%` : ""}</em></div>
            <b className={row.unrealized == null ? "" : row.unrealized >= 0 ? styles.pos : styles.neg}><Tween value={row.unrealized} format={signedMoney} /><small>USDT 浮动</small></b>
          </header>
          <ol className={styles.stages} aria-label="仓位阶段">{STAGES.map(([key, label], stepIndex) => <li key={key} data-state={stageIndex < 0 ? "unknown" : stepIndex < stageIndex ? "done" : stepIndex === stageIndex ? "now" : "next"}><i /><span>{label}</span></li>)}</ol>
          <div className={styles.priceRail} aria-label="止损、入场与当前价格">
            <i className={styles.priceRailTrack} />
            {pos(stop) != null && <span data-k="stop" style={{ left: `${pos(stop)}%` }}><b>SL</b><em>{display.price(stage?.stop, row.symbol)}</em></span>}
            {pos(entry) != null && <span data-k="entry" style={{ left: `${pos(entry)}%` }}><b>ENTRY</b><em>{display.price(row.entryPrice, row.symbol)}</em></span>}
            {pos(live) != null && <span data-k="live" style={{ left: `${pos(live)}%` }}><b>{mark ? row.side === "LONG" ? "BID" : "ASK" : "MARK"}</b><em>{display.price(mark ?? row.markPrice, row.symbol)}</em></span>}
          </div>
          <dl>
            <div><dt>数量</dt><dd>{display.quantity(row.quantity, row.symbol)}</dd></div>
            <div><dt>名义</dt><dd>{money(row.notional == null ? null : Math.abs(row.notional))}</dd></div>
            <div><dt>杠杆 / 保证金</dt><dd>{row.leverage ?? "—"}× · {row.marginType === "cross" ? "全仓" : row.marginType === "isolated" ? "逐仓" : "待同步"}</dd></div>
            <div><dt>强平参考</dt><dd>{row.liquidationPrice && Number(row.liquidationPrice) > 0 ? display.price(row.liquidationPrice, row.symbol) : "未提供"}</dd></div>
          </dl>
          <footer>{stage ? `执行器保护价 ${display.price(stage.stop, row.symbol)} · 原始数量 ${display.quantity(stage.originalQuantity, row.symbol)}` : "保护状态待同步 · 浮动盈亏未扣完整成本"}</footer>
        </article>;
      })}</div>
      : <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{["标的", "方向", "类型 / 状态", "数量", "委托价", "触发价"].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{orders?.map((row, index) => <tr key={index} style={{ "--i": index } as CSSProperties}><td><strong>{row.symbol?.replace(/USDT$/, "")}</strong></td><td>{row.side === "BUY" ? "买入" : row.side === "SELL" ? "卖出" : "—"}</td><td>{row.type}<small>{row.status}</small></td><td>{display.quantity(row.quantity, row.symbol)}</td><td>{display.price(row.price, row.symbol)}</td><td>{display.price(row.triggerPrice, row.symbol)}</td></tr>)}</tbody></table></div>}
    <p className={styles.footnote}>候选不计作持仓；条件单数量不代表止损覆盖率。浮动盈亏采用交易所账户口径。</p>
  </section>;
}

/* ================= candidates ================= */
type Stage = "all" | "upcoming" | "arrived" | "locked" | "inactive";

export function CandidatesPanel({ candidates, execution, ready, unavailable, partialScan, loading, quotes, rules, now, scannedSymbols, universeSize, children }: { candidates: Candidate[]; execution?: ExecutionState | null; ready: boolean; unavailable: boolean; partialScan: boolean; loading: boolean; quotes: MarketQuote[]; rules: PrecisionRule[]; now: number; scannedSymbols?: number; universeSize?: number; children?: React.ReactNode }) {
  const [tab, setTab] = useState<Stage>("all");
  const ordered = [...candidates].sort((a, b) => (Date.parse(a.intersectionTime ?? "") || Infinity) - (Date.parse(b.intersectionTime ?? "") || Infinity) || a.id.localeCompare(b.id));
  const groups = partitionCandidateFunnel(ordered, now, unavailable), past = [...groups.inactive, ...groups.unknown] as Candidate[];
  const choices = [["all", "全部", ordered.length], ["upcoming", "等待交汇", groups.upcoming.length], ["arrived", "等待确认", groups.arrived.length], ["locked", "已确认", groups.locked.length], ["inactive", "失效 / 待核验", past.length]] as const;
  const rows = ({ all: ordered, upcoming: groups.upcoming, arrived: groups.arrived, locked: groups.locked, inactive: past } as Record<Stage, Candidate[]>)[tab];
  const display = createBinanceDisplay(rules, quotes);
  const gate = execution?.strategyRuntime?.pxDistanceGateEnabled !== false;

  return <section id="candidates" className={`${styles.panel} ${styles.reveal}`} aria-labelledby="s1p-candidates-title" onPointerMove={spotlight}>
    <header className={styles.panelHead}>
      <div><small>DEMO MONITOR · 4H × 1H 交汇</small><h2 id="s1p-candidates-title">候选计划</h2></div>
      <span className={styles.badge}>扫描 {scannedSymbols ?? "—"} / {universeSize ?? "—"} · {candidates.length} 个计划</span>
    </header>
    {children}
    <Tabs items={choices} value={tab} onChange={setTab} label="候选计划阶段" />
    {(!ready || unavailable) && !loading && <p className={styles.inlineAlert}>扫描或执行输入待恢复，保留的计划仅供查看，不代表当前可入场。{partialScan ? "本轮扫描不完整。" : ""}现有持仓管理独立继续。</p>}
    {!rows.length ? <div className={styles.empty}><b>{loading ? "正在读取候选" : !ready ? "候选状态待恢复" : !ordered.length ? "暂无符合结构条件的候选" : "当前阶段暂无计划"}</b><span>{!ready ? "输入未确认，空列表不代表本轮没有候选。" : "等待扫描器下一轮结构更新。"}</span></div>
      : <ol className={styles.planList}>{rows.map((plan, index) => {
        const priority = ready ? execution?.candidatePriorities?.find(row => row.planId === plan.id) : undefined;
        const intersectionAt = Date.parse(plan.intersectionTime ?? "");
        const future = intersectionAt > now, expired = ["EXPIRED", "CONFIRMED_EXPIRED", "NON_CAUSAL_OBSERVATION", "INVALIDATED"].includes(plan.status);
        const confirmed = plan.status === "FIRST_CLOSE_LOCKED", rowStale = unavailable || plan.stale;
        const title = rowStale ? "快照待核验" : expired ? plan.status === "INVALIDATED" ? "结构已失效" : "入场窗口已结束" : confirmed ? !ready ? "已确认 · 待输入恢复" : priority?.state === "POSITION_OPEN" ? "已有持仓" : priority?.state === "SUBMITTING" ? "执行处理中" : priority?.state === "WAITING" ? "当前优先计划" : "已确认 · 结构备查" : future ? "等待交汇" : "等待 15M 收线确认";
        const feedback = priority?.reason;
        const note = !ready ? "仅供查看，当前不可据此入场" : expired ? "不再参与本次入场" : feedback ? /PORTFOLIO|CAPACITY|CORRELATION|GROUP/.test(feedback) ? "等待仓位与相关组额度" : /ACCOUNT|EVIDENCE|QUOTE|STALE|INFRASTRUCTURE/.test(feedback) ? "等待账户与行情校验" : "等待执行器条件复核" : confirmed ? "确认方向不等于已成交" : candidateStatusNote(plan, now, rowStale, "15M");
        const quote = quotes.find(row => row.symbol === plan.symbol), age = now - Date.parse(quote?.exchangeTime ?? "");
        const current = !rowStale && quote?.status === "QUOTED" && age >= -5000 && age <= 10000;
        const distance = current ? summarizePxDistance([plan], quote, 200)?.representative.status ?? null : null;
        const offset = distance ? Math.max(-3, Math.min(3, distance.pxOffsetPercent)) : null;
        const state = rowStale || expired ? "dead" : confirmed ? priority?.state === "WAITING" ? "priority" : "locked" : future ? "upcoming" : "arrived";
        const soon = future && intersectionAt - now < 3_600_000;
        return <li key={plan.id} className={styles.plan} data-state={state} data-soon={soon} style={{ "--i": index } as CSSProperties}>
          <div className={styles.planId}><span className={styles.coin} data-dir={plan.direction ?? "NONE"}>{plan.symbol.slice(0, 1)}</span><div><strong>{plan.symbol.replace(/USDT$/, "")}<small>/USDT</small></strong><em data-dir={plan.direction ?? "NONE"}>{sideLabel(plan.direction)}</em></div></div>
          <div className={styles.planTime}><small>数学交汇</small><b>{clock(plan.intersectionTime)}</b></div>
          <div className={styles.planCountdown}><small>{future ? "倒计时" : "距交汇"}</small><b data-warn={!future || expired}>{arrivalCountdown(plan.intersectionTime, now, rowStale, plan.status)}</b></div>
          <div className={styles.planPx}><small>精确交点 P×</small><b>{display.price(plan.intersectionPrice, plan.symbol)}</b>
            <i className={styles.pxGauge} data-gate={gate} title={distance ? `相对 Px ${distance.pxOffsetPercent.toFixed(2)}%` : "等待新鲜报价"}><span className={styles.pxBand} data-dir={plan.direction ?? "NONE"} /><span className={styles.pxZero} />{offset != null && <span className={styles.pxNeedle} style={{ left: `${50 + offset / 3 * 50}%` }} />}</i>
            <small>{distance ? `${distance.referenceLabel} 相对 Px ${distance.pxOffsetPercent > 0 ? "+" : ""}${distance.pxOffsetPercent.toFixed(2)}%${gate ? "" : " · 仅观测"}` : "等待新鲜报价"}</small>
          </div>
          <div className={styles.planBbo}><small>当前 BBO</small><b>{current ? display.price(quote?.bidPrice, plan.symbol) : "—"}</b><small>{current ? `Ask ${display.price(quote?.askPrice, plan.symbol)}` : "盘口待更新"}</small></div>
          <div className={styles.planStatus}><b>{title}</b><small>{note}</small>{plan.directionClosedAt && <small>确认 {clock(plan.directionClosedAt)}</small>}</div>
          <details className={styles.planMore}><summary aria-label={`${plan.symbol} 计划详情`}>详情</summary><div><p>计划编号</p><code>{plan.id}</code><p>数据时间 {clock(plan.observedAt)}</p>{feedback && <p>执行反馈 {feedback}</p>}<p>原始交点价 {plan.intersectionPrice ?? "—"}</p></div></details>
        </li>;
      })}</ol>}
    <p className={styles.footnote}>4H 结构 × 1H 对向结构 → 15M 收线确认。未来交汇保留“方向待定”，不提前推定多空。时间统一为北京时间。</p>
  </section>;
}

/* ================= fills ================= */
const action = (row: FillRow) => row.positionSide === "LONG" ? row.side === "BUY" ? "买入开多" : "卖出平多" : row.positionSide === "SHORT" ? row.side === "SELL" ? "卖出开空" : "买入平空" : row.side === "BUY" ? "买入" : "卖出";

export function FillsPanel({ ledger, failure, now, quotes, rules }: { ledger?: ExecutionLedger; failure: boolean; now: number; quotes: MarketQuote[]; rules: PrecisionRule[] }) {
  const display = createBinanceDisplay(rules, quotes);
  const execution = ledger?.execution, observedAt = execution?.observedAt, age = observedAt && now ? now - Date.parse(observedAt) : Infinity;
  const fresh = !failure && ledger?.status === "OK" && age >= -5000 && age <= 180000;
  const fills = ledger?.fills ?? [], summary = ledger?.summary;
  const tiles = [["成交笔数", summary?.fillCount ?? null, "交易所逐笔成交", 0], ["手续费", summary ? Number(summary.commissionUsdt) : null, "USDT", 4], ["已实现价差", summary ? Number(summary.realizedPnlUsdt) : null, "USDT", 4], ["成交净结果", summary ? Number(summary.netPnlUsdt) : null, "价差减手续费 · USDT", 4]] as const;
  return <section id="fills" className={`${styles.panel} ${styles.reveal}`} aria-labelledby="s1p-fills-title" onPointerMove={spotlight}>
    <header className={styles.panelHead}><div><small>S1 · BINANCE USDⓈ-M</small><h2 id="s1p-fills-title">成交流水</h2></div><span className={styles.badge} data-tone={execution?.entryIncident ? "warn" : fresh ? "good" : "muted"}>{fresh ? "已同步" : "同步待核验"}</span></header>
    <div className={styles.tiles}>{tiles.map(([label, value, hint, digits], index) => <div key={label} style={{ "--i": index } as CSSProperties}><span>{label}</span><b className={index >= 2 && value != null ? value < 0 ? styles.neg : styles.pos : ""}><Tween value={value} format={number => index >= 2 ? `${number > 0 ? "+" : ""}${money(number, digits)}` : money(number, digits)} /></b><small>{hint}</small></div>)}</div>
    {!fresh && ledger && <p className={styles.inlineAlert}>同步时间 {clock(ledger.observedAt)} · 当前快照已过时或连接异常。</p>}
    {failure && <p className={styles.inlineAlert}>成交流水同步暂时不可用；下表保留上次已核验记录。</p>}
    {!fills.length ? <div className={styles.empty}><b>暂无已同步成交</b><span>只有交易所确认的真实成交才进入流水。</span></div> : <div className={styles.tableWrap} role="region" aria-label="S1 最近真实成交流水" tabIndex={0}><table className={styles.table}>
      <thead><tr>{["北京时间", "交易对 / 方向", "动作", "数量", "成交价", "手续费", "已实现价差", "净结果", "订单 / 成交"].map(title => <th key={title}>{title}</th>)}</tr></thead>
      <tbody>{fills.map((row, index) => <tr key={row.key} style={{ "--i": index } as CSSProperties}>
        <td>{clock(row.time)}</td><td><strong>{row.symbol.replace(/USDT$/, "")}</strong><small data-dir={row.positionSide}>{sideLabel(row.positionSide)}</small></td>
        <td>{action(row)}<small>{row.attribution === "OWNER_DIRECTED_TEST" ? "老板指令测试" : row.attribution === "STRATEGY" ? "S1 策略" : "账户外部成交"}</small></td>
        <td>{display.quantity(row.quantity, row.symbol)}</td><td>{display.price(row.price, row.symbol)}</td><td>{eight(row.commission)}</td>
        <td className={Number(row.realizedPnlUsdt) < 0 ? styles.neg : ""}>{signedEight(row.realizedPnlUsdt)}</td><td className={Number(row.netPnlUsdt) < 0 ? styles.neg : styles.pos}>{signedEight(row.netPnlUsdt)}</td>
        <td><small>#{row.orderId}<br />成交 #{row.tradeId}</small></td>
      </tr>)}</tbody></table></div>}
    <p className={styles.footnote}>页面展示最近 100 笔已记录成交，按交易所 tradeId 去重。已实现价差不含手续费；成交净结果＝已实现价差－手续费。</p>
  </section>;
}

/* ================= not-entered history ================= */
const REASONS: Record<string, string> = {
  CONFIRMATION_RESERVE_NOT_CLOSED: "入场确认K线尚未收盘", CROSS_BUFFER_WAITING_IMMEDIATE_SECOND_BAR: "首根收盘未完成方向确认，等待下一根K线", TWO_BAR_CROSS_CLOSES_INSIDE_BUFFER: "连续两根收盘仍位于交汇缓冲区内",
  CROSS_BAR_CLOSE_INSIDE_BUFFER: "交汇K线收盘仍位于缓冲区内", CONFIRMATION_RESERVE_EXPIRED: "确认窗口结束，未形成有效突破", SIGNAL_EXPIRED: "信号超过执行有效期", ENTRY_BARS_UNAVAILABLE: "入场周期K线证据不完整",
  IQ1_PROJECTED_CROSS_FAR_FROM_PRICE: "交汇点距离现价过远", IQ1_PX_DISTANCE_EXCEEDED: "成交价距离 Px 超过限制", IQ1_PX_SAME_SIDE_BAND_WAIT: "等待实时可执行价进入 Px 同侧 2% 区", IQ1_PX_SAME_SIDE_WAIT: "等待实时可执行价回到 Px 的方向同侧",
  IQ1_CONFIRMING_CLOSE_WRONG_PX_SIDE: "方向确认收盘位于 Px 错误一侧", IQ1_NO_CONVERGENCE: "交汇前收敛程度不足", IQ1_NO_POST_CROSS_EXPANSION: "交汇后尚未形成初始发散", IQ1_RETURNING_NOT_EXPANDING: "价格正在回撤，未保持初始发散",
  IQ1_WRONG_PX_SIDE: "价格位于 Px 的错误方向", IQ1_CROSS_ANCHOR_MISSING: "缺少交汇时刻逐笔成交锚点", IQ1_CONFIRMATION_DATA_UNKNOWN: "确认K线数据不完整", IQ1_CORRELATED_OPPOSITE_EXPOSURE: "关联币已有反向敞口",
  IQ1_CORRELATED_GROUP_CAPACITY: "关联币组仓位或风险额度已满", IQ1_CORRELATION_OR_CAPACITY_UNKNOWN: "关联性或组合容量证据不足", ENTRY_DISPLACEMENT_EXCEEDED: "成交报价偏离信号收盘价超过50bps", R22_COST_EFFICIENCY_REJECTED: "止损距离与交易成本的收益风险效率不足",
  EVENT_GATE_CLOSED: "宏观风险事件窗口暂停新仓", POSITION_OR_SIGNAL_ALREADY_USED: "同币种已有持仓或信号已经使用", EXISTING_SYMBOL_POSITION: "同币种已有持仓", RISK_BUDGET_UNAVAILABLE: "单笔或组合风险预算不足",
  TRIAL_GROSS_CAP_REACHED: "账户总名义敞口已达上限", TRIAL_POSITION_CAP_REACHED: "账户持仓数量已达上限", MARGIN_CAPACITY_MISSING: "可用保证金或杠杆容量不足", ACCOUNT_NOT_RECONCILED_HEDGE_SINGLE_ASSET: "账户模式或持仓对账未通过",
  ACCOUNT_OR_USER_STREAM_STALE: "账户快照或账户事件流过时", INFRASTRUCTURE_GATE_CLOSED: "执行基础设施就绪门未通过", FORWARD_MARKET_EVIDENCE_STALE: "Tick/BBO 前向行情证据过时", FORWARD_MARKET_EVIDENCE_INCOMPLETE: "Tick/BBO 连续性证据不完整",
  FEE_SLIPPAGE_EVIDENCE_INVALID: "手续费或滑点证据不足", MARK_PRICE_STALE: "标记价格过时", STOP_NOT_PROTECTIVE: "初始止损方向不具保护性", R21_DIRECTION_ENTRY_FROZEN: "组合方向冻结门正在生效",
  CANDIDATE_SUPERSEDED: "同币种出现更新结构，旧候选已被替代", CANDIDATE_REMOVED: "候选已从扫描结果移除", NEWER_READY_CANDIDATE_WON_ENTRY_RACE: "同币种更新计划先达到入场条件，旧等待计划已取消",
};

export function HistoryPanel({ rows, quotes, rules }: { rows: FilteredCandidate[]; quotes: MarketQuote[]; rules: PrecisionRule[] }) {
  const display = createBinanceDisplay(rules, quotes);
  return <details id="candidate-history" className={`${styles.panel} ${styles.drawer}`}>
    <summary><span><b>未入场记录</b><small>收线确认 · 执行门 · 候选生命周期</small></span><strong>{rows.length} 条</strong><i aria-hidden="true" /></summary>
    {!rows.length ? <div className={styles.empty}><b>暂无未入场历史记录</b></div> : <div className={styles.tableWrap} role="region" aria-label="候选未入场历史" tabIndex={0}><table className={styles.table}>
      <thead><tr><th>评估时间</th><th>交易对 / 方向</th><th>未入场原因</th><th>拦截阶段</th><th>交汇时间 / Px</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}>
        <td>{clock(row.evaluatedAt)}</td><td><strong>{row.symbol.replace(/USDT$/, "")}</strong><small data-dir={row.direction ?? "NONE"}>{row.direction === "LONG" ? "做多" : row.direction === "SHORT" ? "做空" : "方向未确认"}</small></td>
        <td><b>{REASONS[row.reason] ?? "未通过策略入场条件"}</b><small title={row.reason}>{row.reason}</small></td>
        <td><span className={styles.chip}>{row.stage === "SIGNAL_CONFIRMATION" ? "收线确认" : row.stage === "CANDIDATE_LIFECYCLE" ? "候选生命周期" : "执行门"}</span></td>
        <td>{clock(row.intersectionTime)}<small>Px {display.price(row.intersectionPrice, row.symbol)}</small></td>
      </tr>)}</tbody></table></div>}
  </details>;
}

/* ================= risk calendar ================= */
const remaining = (at: string, now: number) => { const minutes = Math.ceil((Date.parse(at) - now) / 60000); if (minutes <= 0) return "计划时间已过"; const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60; return `还有 ${days ? `${days}天 ` : ""}${hours}时 ${mins}分`; };

export function CalendarPanel({ calendar, failure, now, eventGate, scannerFresh, onRefresh }: { calendar: RiskCalendarFeed | null; failure: boolean; now: number; eventGate?: EventGate; scannerFresh: boolean; onRefresh: () => void }) {
  const [days, setDays] = useState(30);
  const events = calendar && now ? rollingEvents(calendar.events, now, days) as RiskEvent[] : [];
  const active = events.filter(event => eventPhase(event, now) === "WINDOW");
  const upcoming = events.find(event => Date.parse(event.scheduledAt) >= now);
  const unverified = !calendar || !now || failure || calendar.sources.some(source => ["INCOMPLETE", "NEEDS_RECHECK"].includes(calendarFreshness(source, now, now + 30 * 60000)));
  const pause = active.length > 0 || unverified || !scannerFresh || eventGate?.newEntriesPaused !== false;
  const stateLabel = unverified ? "日历待核验 · 禁止新入场" : active.length ? "风险窗口 · 暂停新入场" : !scannerFresh || !eventGate ? "扫描侧状态待同步" : eventGate.newEntriesPaused ? "扫描侧限制新入场" : "当前不在已知事件窗口";
  return <section id="risk-calendar" className={`${styles.panel} ${styles.reveal}`} aria-labelledby="s1p-calendar-title" onPointerMove={spotlight}>
    <header className={styles.panelHead}>
      <div><small>MACRO EVENTS · 北京时间</small><h2 id="s1p-calendar-title">风险事件日历</h2></div>
      <div className={styles.calendarControls}><label htmlFor="s1p-calendar-range">范围</label><select id="s1p-calendar-range" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>未来 7 天</option><option value={30}>未来 30 天</option></select><button type="button" onClick={onRefresh}>更新日历</button></div>
    </header>
    <div className={styles.gateBanner} data-paused={pause} role="status"><i /><b>{stateLabel}</b><span>{active.length ? active.map(event => event.name).join(" / ") : upcoming ? `下一事件：${upcoming.name} · ${remaining(upcoming.scheduledAt, now)}` : "所选时段暂无已登记事件，不代表没有风险"}</span></div>
    <div className={styles.eventTrack} role="region" aria-label="可横向滚动的风险事件列表" tabIndex={0}>
      {events.map((event, index) => { const phase = eventPhase(event, now), at = Date.parse(event.scheduledAt); return <article key={event.id} className={styles.event} data-phase={phase} data-tier={event.tier} style={{ "--i": index } as CSSProperties}>
        <header><time dateTime={event.scheduledAt}>{shortStamp(event.scheduledAt)}</time><span>{event.tier === "TIER1" ? "重点" : "关注"}</span></header>
        <h3>{event.name}</h3>
        <p>{phase === "WINDOW" ? now < at ? "公布前暂停窗口" : "公布后暂停窗口" : remaining(event.scheduledAt, now)}</p>
        <div><span>新入场暂停</span><b>{shortStamp(new Date(at - 1800000).toISOString(), false)}–{shortStamp(new Date(at + 1800000).toISOString(), false)}</b></div>
        <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.provider} 官方计划 ↗</a>
      </article>; })}
      {!events.length && <div className={styles.empty}><b>{calendar ? "此区间暂无已核验事件" : failure ? "日历连接异常，系统保持禁止新入场" : "正在读取官方事件计划…"}</b></div>}
    </div>
    <div className={styles.sources}>{calendar?.sources.map(source => { const freshness = calendarFreshness(source, now, now + days * DAY); return <div key={source.provider}><b>{source.provider}</b><span>{freshness === "INCOMPLETE" ? "所选范围覆盖不足" : freshness === "NEEDS_RECHECK" ? "计划已超过复核时限" : source.status === "LIVE_OFFICIAL" ? "官方源已刷新" : "使用已核验备用计划"}</span><small>核验 {shortStamp(source.verifiedAt)} · 覆盖至 {shortStamp(source.coverageEnd)}</small></div>; })}</div>
    <p className={styles.footnote}>公布前后各 30 分钟暂停新入场，已有仓位按原规则管理。突发政策、交易所故障与未登记的代币事件不在此日历覆盖内。</p>
  </section>;
}
