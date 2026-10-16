"use client";

import styles from "./smc-equity-ledger.module.css";

type Account = { observedAt: string | null; equity: number | null; wallet: number | null; available: number | null; positions: number | null; orders: number | null; algoOrders: number | null; unrealized: number | null; initialMargin: number | null };
type Position = { planId: string; symbol: string; direction: string; quantity: number; entry: number; stop: number; target: number; initialRiskUsdt: number; realizedNetPnl: number; openedAt: string };
type Fill = { key: string; planId: string; role: string; symbol: string; direction: string; time: number; price: number; quantity: number; commission: number; realizedPnl: number };
type Ledger = { status: string; observedAt: string | null; snapshot: { account: Account; execution: { status: string; liveReady: boolean; entriesAllowed: boolean; exitsAllowed: boolean; infrastructureReady: boolean }; positions: Position[]; fills: Fill[] } | null; history: Array<{ observedAt: string; equity: number }> } | null;

const number = (value: number | null | undefined, digits = 2) => value == null ? "—" : new Intl.NumberFormat("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const time = (value: string | number | null | undefined) => value == null ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

export default function SmcEquityLedger({ accountFresh, ledger }: { accountFresh: boolean; ledger: Ledger }) {
  const account = ledger?.snapshot?.account;
  const positions = ledger?.snapshot?.positions ?? [];
  const fills = ledger?.snapshot?.fills ?? [];
  const orders = (account?.orders ?? 0) + (account?.algoOrders ?? 0);
  const totalRisk = positions.reduce((sum, row) => sum + row.initialRiskUsdt, 0);
  const riskPercent = account?.equity && account.equity > 0 ? totalRisk / account.equity * 100 : 0;

  return <section className={styles.ledger} aria-labelledby="smc-ledger-title">
    <header className={styles.heading}>
      <div><span>实时账户</span><h2 id="smc-ledger-title">当前持仓</h2></div>
      <p><i className={accountFresh ? styles.live : styles.stale} />{accountFresh ? `币安同步 ${time(account?.observedAt)}` : "等待账户同步"}</p>
    </header>

    <div className={styles.positionSummary} aria-label="持仓与风险摘要">
      <div><span>持仓</span><b>{accountFresh ? `${positions.length} / 4` : "—"}</b></div>
      <div><span>浮动盈亏</span><b className={(account?.unrealized ?? 0) >= 0 ? styles.positive : styles.negative}>{accountFresh ? `${number(account?.unrealized)} USDT` : "—"}</b></div>
      <div><span>已占风险</span><b>{accountFresh ? `${number(totalRisk)} USDT` : "—"}</b><small>{accountFresh ? `${riskPercent.toFixed(2)}% / 10%` : ""}</small></div>
      <div><span>活动委托</span><b>{accountFresh ? orders : "—"}</b></div>
    </div>

    {positions.length ? <div className={styles.positionList} role="list" aria-label="SMC 当前持仓列表">
      {positions.map(row => <article key={row.planId} role="listitem">
        <div className={styles.positionIdentity}><div><strong>{row.symbol}</strong><span className={row.direction === "LONG" ? styles.long : styles.short}>{row.direction === "LONG" ? "做多" : "做空"}</span></div><small>{time(row.openedAt)}</small></div>
        <dl><div><dt>数量</dt><dd>{number(row.quantity, 6)}</dd></div><div><dt>开仓均价</dt><dd>{number(row.entry, 6)}</dd></div><div><dt>保护止损</dt><dd>{number(row.stop, 6)}</dd></div><div><dt>当前止盈</dt><dd>{number(row.target, 6)}</dd></div><div><dt>初始风险</dt><dd>{number(row.initialRiskUsdt)} USDT</dd></div></dl>
        <p>{row.planId}</p>
      </article>)}
    </div> : <div className={styles.flatState}><div><b>当前无持仓</b><span>没有正在承受市场风险的 SMC 仓位</span></div><strong>FLAT</strong></div>}

    <details className={styles.activityDetails}>
      <summary>委托与成交 <span>{orders} 委托 · {fills.length} 成交</span></summary>
      <div className={styles.activityBody}>
        <p>普通委托 {account?.orders ?? 0} · 条件委托 {account?.algoOrders ?? 0}</p>
        {fills.length ? <ul>{fills.slice(0, 20).map(row => <li key={row.key}><span>{time(row.time)}</span><b>{row.symbol} · {row.role}</b><span>{number(row.price, 6)} / {number(row.quantity, 6)}</span><em className={row.realizedPnl >= 0 ? styles.positive : styles.negative}>{number(row.realizedPnl)}</em></li>)}</ul> : <p>暂无 SMC 成交记录</p>}
      </div>
    </details>
  </section>;
}
