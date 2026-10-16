"use client";
import { useId, useState } from "react";
import { equitySegments } from "../../lib/s1-account.mjs";
import { candidateInputState } from "../../lib/s1-candidate-funnel.mjs";
import type { ExecutionState } from "./TradeLedger";
import { createBinanceDisplay } from "../../lib/s1-price-display.mjs";
import type { MarketQuote, PrecisionRule } from "./PriceCalibration";
import styles from "./account-workspace.module.css";
export type PositionRow = {symbol: string | null; side: string | null; quantity: string | null; entryPrice: string | null; markPrice: string | null; liquidationPrice: string | null; unrealized: number | null; notional: number | null; leverage: number | null; marginType: string | null};
type OrderRow = {symbol: string | null; side: string | null; type: string | null; status: string | null; quantity: string | null; executedQuantity: string | null; price: string | null; triggerPrice: string | null};
export type AccountRecord = {observedAt: string | null; fresh: boolean; userStreamConnected: boolean; equity: number | null; wallet: number | null; available: number | null; positions: number | null; orders: number | null; algoOrders: number | null; positionMode?: string | null; details?: {unrealized: number | null; initialMargin: number | null; maintenanceMargin: number | null; positionMargin: number | null; orderMargin: number | null; multiAssetsMargin: boolean | null; positionsComplete: boolean; ordersComplete: boolean; algoOrdersComplete: boolean; positionRows: PositionRow[]; regularOrders: OrderRow[]; conditionalOrders: OrderRow[]} | null};
export type EquityPoint = {observedAt: string; equity: number; wallet: number; available: number};
export type History = {status: string; points: EquityPoint[]; firstObservedAt: string | null};
const money = (value: number | null | undefined, digits = 2) => value == null ? "—" : new Intl.NumberFormat("en-US",{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
const time = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(value)) : "—";
const sign = (value: number | null | undefined) => value == null ? "—" : `${value > 0 ? "+" : ""}${money(value)}`;
const stageLabel = (stage: ExecutionState["positionStages"][number]) => {
  const remaining = Math.round(Number(stage.quantity) / Number(stage.originalQuantity) * 100);
  if (stage.stage === "TAIL") return `${remaining}%尾仓`;
  if (stage.stage === "ONE_R") return "1R止盈";
  if (stage.stage === "SOFT") return "0.5R保护";
  return "初始仓";
};
export default function AccountWorkspace({accountLabel="S1",account,history,fresh,execution,executionFresh,rules,quotes,view="all",now=0,inputStateOverride}:{accountLabel?:string;accountOnly?:boolean;account?:AccountRecord;history?:History;fresh:boolean;execution?:ExecutionState|null;executionFresh:boolean;rules?:PrecisionRule[];quotes?:MarketQuote[];view?:"all"|"equity"|"positions";now?:number;inputStateOverride?:"READY"|"UNAVAILABLE"|"UNKNOWN"}) {
  const display = createBinanceDisplay(rules, quotes);
  const inputState = inputStateOverride ?? candidateInputState(execution, executionFresh, now);
  const [tab,setTab] = useState("positions");
  const chartId=useId().replaceAll(":","");
  const d=account?.details, points=history?.points ?? [];
  const groups=equitySegments(points) as (EquityPoint & {time:number})[][];
  const valid=groups.flat(), first=valid[0],last=valid.at(-1);
  const low=valid.length?Math.min(...valid.map(p=>p.equity)):0,high=valid.length?Math.max(...valid.map(p=>p.equity)):0;
  const padding=Math.max((high-low)*.15,Math.abs(high)*.001,.01), bottom=low-padding,top=high+padding;
  const x=(t:number)=>36+((t-(first?.time??0))/Math.max(1,(last?.time??0)-(first?.time??0)))*612;
  const y=(v:number)=>174-(v-bottom)/(top-bottom)*144;
  const path=(group:(EquityPoint & {time:number})[])=>group.map((p,j)=>`${j?"L":"M"}${x(p.time)},${y(p.equity)}`).join(" ");
  const area=(group:(EquityPoint & {time:number})[])=>group.length<2?"":`${path(group)} L${x(group.at(-1)!.time)},174 L${x(group[0].time)},174 Z`;
  const delta=first&&last?last.equity-first.equity:null;
  const deltaPercent=delta!=null&&first?.equity?delta/Math.abs(first.equity)*100:null;
  const trendClass=delta==null||Math.abs(delta)<.005?styles.neutral:delta>0?styles.positive:styles.negative;
  const midpoint=first&&last?new Date((first.time+last.time)/2).toISOString():null;
  const utilization=d?.initialMargin!=null&&account?.equity!=null&&account.equity>0?d.initialMargin/account.equity*100:null;
  const long=d?.positionsComplete?d.positionRows.filter(p=>p.side==="LONG").reduce((sum,p)=>sum+Math.abs(p.notional??0),0):null;
  const short=d?.positionsComplete?d.positionRows.filter(p=>p.side==="SHORT").reduce((sum,p)=>sum+Math.abs(p.notional??0),0):null;
  const exposureKnown=!!d?.positionsComplete&&d.positionRows.every(p=>p.notional!==null);
  const count=tab==="positions"?account?.positions:tab==="orders"?account?.orders:account?.algoOrders;
  const complete=tab==="positions"?d?.positionsComplete:tab==="orders"?d?.ordersComplete:d?.algoOrdersComplete;
  const orderRows=tab==="orders"?d?.regularOrders:d?.conditionalOrders;
  const positionStage = (position: PositionRow) => executionFresh ? execution?.positionStages?.find(row => row.symbol===position.symbol&&row.direction===position.side) : undefined;
  const titles={positions:"持仓",orders:"普通挂单",algo:"条件挂单"};
  return <>
    {view!=="positions" && <section className={styles.overview} aria-label="账户权益与资金">
      <div className={styles.equity}>
        <div className={styles.heading}><div><span className={styles.kicker}>账户权益 · USDT 资产口径</span><h2>权益轨迹</h2></div><span className={fresh?styles.live:styles.warning}>{fresh?"账户已同步":"历史快照 / 待核验"}</span></div>
        <div className={styles.equityNumbers}><dl><div className={styles.trendMetric}><dt>窗口变化</dt><dd className={trendClass}>{sign(delta)} <small>{deltaPercent==null?"—":`${deltaPercent>0?"+":""}${money(deltaPercent)}%`}</small></dd></div><div><dt>采样区间</dt><dd>{valid.length?`${money(low)} — ${money(high)}`:"—"}</dd></div></dl></div>
        <div className={styles.chart}>
          {valid.length>=2 ? <svg viewBox="0 0 720 214" role="img" aria-labelledby={`${chartId}-title ${chartId}-desc`}><title id={`${chartId}-title`}>{accountLabel} 已记录权益采样</title><desc id={`${chartId}-desc`}>按真实时间绘制，窗口变化{sign(delta)} USDT，超过三分钟的数据缺口断开。</desc><defs><linearGradient id={`${chartId}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className={`${styles.areaStart} ${trendClass}`}/><stop offset="1" className={`${styles.areaEnd} ${trendClass}`}/></linearGradient></defs>{[top,(top+bottom)/2,bottom].map((v,i)=><g key={i}><line x1="36" x2="648" y1={y(v)} y2={y(v)} className={styles.grid}/><text x="704" y={y(v)+4} textAnchor="end">{money(v)}</text></g>)}<line x1="36" x2="648" y1={y(last!.equity)} y2={y(last!.equity)} className={`${styles.currentGuide} ${trendClass}`}/>{groups.map((group,i)=><g key={i}>{group.length>=2&&<path className={styles.area} d={area(group)} fill={`url(#${chartId}-fill)`}/>}<path className={`${styles.curve} ${trendClass}`} d={path(group)}/>{group.length===1&&<circle cx={x(group[0].time)} cy={y(group[0].equity)} r="2.5" className={`${styles.point} ${trendClass}`}/>}</g>)}<circle cx={x(first!.time)} cy={y(first!.equity)} r="3" className={`${styles.startPoint} ${trendClass}`}/><circle cx={x(last!.time)} cy={y(last!.equity)} r="8" className={`${styles.endpointHalo} ${trendClass}`}/><circle cx={x(last!.time)} cy={y(last!.equity)} r="3.5" className={`${styles.point} ${trendClass}`}/><text x="36" y="207">{time(first?.observedAt)}</text><text x="342" y="207" textAnchor="middle">{time(midpoint)}</text><text x="648" y="207" textAnchor="end">{time(last?.observedAt)}</text></svg>:<div className={styles.chartEmpty}><span>{valid.length?"首份权益采样已记录":"等待权益历史采样"}</span><p>形成连续采样后显示轨迹，不生成示例曲线。</p></div>}
        </div>
        
        <details className={styles.disclosure}><summary>采样明细与口径</summary><p>最近 720 次有效采样 · 首次记录 {time(history?.firstObservedAt)} · 超过 3 分钟缺口断线。</p><p>权益变化包含划转影响，不能直接作为净收益。真实成交和手续费在下方成交流水独立对账；资金费与资金划转尚未形成完整归因，因此暂不计算胜率、年化和净值回撤。历史采样仅从此模块启用后积累，保留记录不删除。{history?.status==="UNAVAILABLE"?" 历史存储当前不可用。":""}</p><div className={styles.scroll}><table><caption>最近 20 次权益采样</caption><thead><tr><th>北京时间</th><th>权益</th><th>钱包余额</th><th>可用余额</th></tr></thead><tbody>{valid.slice(-20).reverse().map(p=><tr key={p.observedAt}><td>{time(p.observedAt)}</td><td>{money(p.equity,4)}</td><td>{money(p.wallet,4)}</td><td>{money(p.available,4)}</td></tr>)}</tbody></table></div></details>
      </div>
      <aside className={styles.funds} aria-labelledby="funds-title"><div className={styles.heading}><h2 id="funds-title">账户资金</h2><span>USDT</span></div>
        <div className={styles.fundHero} data-stale={!fresh}><span>账户权益</span><div className={styles.currentEquity}><strong>{money(account?.equity)}</strong><span>USDT</span></div></div>
        <dl className={styles.fundList} data-stale={!fresh}>
          <div><dt>可用资金</dt><dd>{money(account?.available)}</dd></div>
          <div><dt>未实现盈亏</dt><dd className={d?.unrealized==null?"":d.unrealized>0?styles.positive:d.unrealized<0?styles.negative:styles.neutral}>{sign(d?.unrealized)}</dd></div>
        </dl>
        <dl className={styles.accountCounts}>
          <div data-stale={!fresh}><dt>当前持仓</dt><dd>{account?.positions??"—"}</dd><small>普通 {account?.orders??"—"} · 条件 {account?.algoOrders??"—"}</small></div>
          <div data-stale={inputState!=="READY"}><dt>优先计划</dt><dd>{inputState==="READY"?execution?.candidatePriorities?.filter(row=>row.state==="WAITING").length??"—":"—"}</dd><small>{inputState==="UNAVAILABLE"?"扫描输入暂不可用":inputState!=="READY"?"执行计划待核验":"每币一个 · 靠近优先"}</small></div>
        </dl>
        <details className={styles.disclosure}><summary>资金与保证金明细</summary><dl className={styles.fundList}>{[["钱包余额",money(account?.wallet)],["持仓初始保证金",money(d?.positionMargin)],["挂单初始保证金",money(d?.orderMargin)],["维持保证金",money(d?.maintenanceMargin)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className={styles.utilization}><div><span>初始保证金 / 权益</span><strong>{utilization==null?"—":money(utilization,1)+"%"}</strong></div>{utilization!==null&&<meter min={0} max={100} value={Math.max(0,Math.min(100,utilization))} aria-label="初始保证金占权益比例"/>}<small>资金占用指标，不等于强平风险率。</small></div>
        <div className={styles.accountMeta}><span>持仓模式</span><strong>{account?.positionMode==="HEDGE"?"双向持仓":account?.positionMode==="ONE_WAY"?"单向持仓":"待同步"}</strong><span>多资产保证金</span><strong>{d?.multiAssetsMargin==null?"待同步":d.multiAssetsMargin?"开启 · 此处仅 USDT 资产":"关闭"}</strong><span>账户数据时间</span><strong>{time(account?.observedAt)}</strong></div>
      </details></aside>
    </section>}
    {view!=="equity" && <section id="positions" className={styles.positions} aria-labelledby="positions-title">
      <div className={styles.heading}><div><span className={styles.kicker}>实时账户敞口</span><h2 id="positions-title">持仓与风险</h2></div><span className={fresh?styles.live:styles.warning}>{fresh?"账户已核验":"当前状态待核验"}</span></div>
      <div className={styles.exposure}><div><span>多头名义</span><strong className={styles.live}>{exposureKnown?money(long):"—"} <small>USDT</small></strong></div><div><span>空头名义</span><strong className={styles.short}>{exposureKnown?money(short):"—"} <small>USDT</small></strong></div></div>
      <div className={styles.tabs} role="group" aria-label="持仓与委托视图">{Object.entries(titles).map(([id,label])=><button type="button" key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}<span>{id==="positions"?account?.positions??"—":id==="orders"?account?.orders??"—":account?.algoOrders??"—"}</span></button>)}</div>
      {count===0&&fresh ? <div className={styles.empty}><span className={styles.emptyMark} aria-hidden="true">0</span><h3>当前无{titles[tab as keyof typeof titles]}</h3></div>:!complete ? <div className={styles.empty}><h3>{fresh?"明细等待同步":"保留上次快照，当前状态待核验"}</h3><p>汇总数量 {count??"—"}；数据不完整时不显示为零。</p></div>:<div className={styles.scroll}>{tab==="positions"?<table><thead><tr>{["交易对 / 方向","数量","入场价","标记价","仓位阶段","浮动盈亏 · USDT","杠杆 / 保证金","强平价参考"].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{d?.positionRows.map((p,i)=>{const stage=positionStage(p);return <tr key={`${p.symbol}-${p.side}-${i}`}><td><strong>{p.symbol}</strong><small className={p.side==="LONG"?styles.live:styles.short}>{p.side==="LONG"?"多头":"空头"}</small></td><td>{display.quantity(p.quantity, p.symbol)}</td><td>{display.price(p.entryPrice, p.symbol)}</td><td>{display.price(p.markPrice, p.symbol)}</td><td>{stage?<><strong className={styles.stage}>{stageLabel(stage)}</strong><small>止损 {display.price(stage.stop, p.symbol)}</small></>:<span className={styles.muted}>账户持仓</span>}</td><td>{sign(p.unrealized)}</td><td>{p.leverage??"—"}× / {p.marginType==="cross"?"全仓":p.marginType==="isolated"?"逐仓":"—"}</td><td>{p.liquidationPrice&&Number(p.liquidationPrice)>0?display.price(p.liquidationPrice, p.symbol):"未提供有效强平价"}</td></tr>})}</tbody></table>:<table><thead><tr>{["交易对","方向","类型 / 状态","数量","委托价","触发价"].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody>{orderRows?.map((o,i)=><tr key={i}><td>{o.symbol}</td><td>{o.side==="BUY"?"买入":o.side==="SELL"?"卖出":"—"}</td><td>{o.type} / {o.status}</td><td>{display.quantity(o.quantity, o.symbol)}</td><td>{display.price(o.price, o.symbol)}</td><td>{display.price(o.triggerPrice, o.symbol)}</td></tr>)}</tbody></table>}</div>}
      <details className={styles.disclosure}><summary>统计口径</summary><p>候选不计作持仓；条件单数量不代表止损覆盖率。</p></details>
    </section>}
  </>;
}
