"use client";
import { usesS1Structure } from "../../lib/s1-candidate-funnel.mjs";
import { useState, type ComponentProps } from "react";
import AccountWorkspace from "./AccountWorkspace";
import { createBinanceDisplay } from "../../lib/s1-price-display.mjs";
import styles from "./v2-panels.module.css";
const number=(v:number|null|undefined)=>v==null||!Number.isFinite(v)?"—":new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const signed=(v:number|null|undefined)=>v==null?"—":`${v>0?"+":""}${number(v)}`;
const side=(v:string|null)=>v==="LONG"?"多头":v==="SHORT"?"空头":"方向待核验";
export default function V2Positions(props:ComponentProps<typeof AccountWorkspace>){
 const [tab,setTab]=useState("positions");
 if(!usesS1Structure(props.accountLabel, props.execution))return <AccountWorkspace {...props}/>;
 const {account,execution,executionFresh,fresh,quotes=[],rules=[],now=0}=props,d=account?.details;
 const display=createBinanceDisplay(rules,quotes),positions=d?.positionRows??[],orders=tab==="orders"?d?.regularOrders:d?.conditionalOrders;
 const complete=tab==="positions"?d?.positionsComplete:tab==="orders"?d?.ordersComplete:d?.algoOrdersComplete;
 const count=tab==="positions"?account?.positions:tab==="orders"?account?.orders:account?.algoOrders;
 const tabs=[['positions','持仓',account?.positions],['orders','普通挂单',account?.orders],['algo','条件挂单',account?.algoOrders]] as const;
 const limit=execution?.strategyRuntime?.riskPolicy.maximumOpenPositions;
 return <section id="positions" className={styles.panel} aria-label="持仓与委托" data-position-layout="symbol-first-aligned-grid">
  <header className={styles.head}><div><small>OPEN POSITIONS</small><h2>持仓与管理</h2><p>按标的对齐入场、盘口、保护止损和仓位阶段；浮动盈亏采用交易所账户口径。</p></div><span className={styles.badge}>{account?.positions??"—"}{limit?` / ${limit}`:""} 开放仓位</span></header>
  <div className={styles.toolbar}><div className={styles.tabs} role="group" aria-label="持仓与委托视图">{tabs.map(([id,title,n])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{title} {n??"—"}</button>)}</div><span>{fresh?"账户已同步":"历史快照 · 当前状态待核验"}</span></div>
  {!fresh&&<p className={styles.alert} role="status">以下为上次账户快照，当前仓位与盈亏待核验。</p>}
  {!complete?<div className={styles.empty}>明细等待同步<p>已知数量 {count??"—"}，数据缺失不显示为零。</p></div>:count===0?<div className={styles.empty}>{fresh?"当前无":"上次快照无"}{tabs.find(x=>x[0]===tab)?.[1]}</div>:<div className={styles.scroll}>
  {tab==="positions"?<><div className={`${styles.row} ${styles.positions} ${styles.header}`} aria-hidden="true">{['标的 / 方向','入场','当前 BBO','当前止损','仓位 / 名义','浮动盈亏','仓位管理'].map(label=><div key={label}>{label}</div>)}</div>{positions.map((p,i)=>{
   const stage=executionFresh?execution?.positionStages?.find(s=>s.symbol===p.symbol&&s.direction===p.side):undefined;
   const quote=quotes.find(q=>q.symbol===p.symbol),age=now-Date.parse(quote?.exchangeTime??'');
   const quoteFresh=fresh&&quote?.status==='QUOTED'&&age>=-5000&&age<=10000;
   const mark=quoteFresh?(p.side==='LONG'?quote?.bidPrice:p.side==='SHORT'?quote?.askPrice:null):null;
   const remaining=stage&&Number(stage.originalQuantity)>0?Number(stage.quantity)/Number(stage.originalQuantity)*100:null;
   const label=stage?({INITIAL:'初始仓',SOFT:'0.5R 保护',ONE_R:'1R 止盈',TAIL:'尾仓跟踪'}[stage.stage]??'管理中'):'账户持仓';
   return <article className={`${styles.row} ${styles.positions}`} key={`${p.symbol}-${p.side}-${i}`} aria-label={`${p.symbol} ${side(p.side)}`}>
    <div className={styles.identity} data-label="标的 / 方向"><i aria-hidden="true">{p.symbol?.slice(0,1)}</i><b><span className={styles.symbol}>{p.symbol?.replace(/USDT$/,'')}<em>/ USDT</em></span><small className={p.side==='LONG'?styles.positive:p.side==='SHORT'?styles.negative:styles.muted}>{side(p.side)}{remaining!=null?` · 剩 ${remaining.toFixed(0)}%`:''}</small></b></div>
    <div data-label="入场"><b>{display.price(p.entryPrice,p.symbol)}</b><small>交易所持仓均价</small></div>
    <div data-label="当前 BBO"><b>{display.price(mark,p.symbol)}</b><small>{mark?(p.side==='LONG'?'Bid 可执行参考':'Ask 可执行参考'):'盘口待更新'}</small><small>标记 {display.price(p.markPrice,p.symbol)}</small></div>
    <div data-label="当前止损"><b>{display.price(stage?.stop,p.symbol)}</b><small>{stage?'执行器保护价':'保护状态待同步'}</small></div>
    <div data-label="仓位 / 名义"><b>{display.quantity(p.quantity,p.symbol)}</b><small>{number(p.notional==null?null:Math.abs(p.notional))} USDT</small></div>
    <div data-label="浮动盈亏"><b className={p.unrealized==null?styles.muted:p.unrealized>=0?styles.positive:styles.negative}>{signed(p.unrealized)}</b><small>USDT · 未扣完整成本</small></div>
    <div data-label="仓位管理"><b>{label}</b><small>{p.leverage??'—'}× · {p.marginType==='cross'?'全仓':p.marginType==='isolated'?'逐仓':'保证金模式待同步'}</small><details className={styles.details}><summary>持仓详情</summary><p>强平参考 {p.liquidationPrice&&Number(p.liquidationPrice)>0?display.price(p.liquidationPrice,p.symbol):'未提供'}</p><p>原始数量 {display.quantity(stage?.originalQuantity,p.symbol)}</p><p>初始风险、初始止损、累计净 R：尚未同步。</p></details></div>
   </article>;
  })}</>:<><div className={`${styles.row} ${styles.orders} ${styles.header}`} aria-hidden="true">{['标的','方向','类型 / 状态','数量','委托价','触发价'].map(label=><div key={label}>{label}</div>)}</div>{orders?.map((o,i)=><article key={i} className={`${styles.row} ${styles.orders}`}><div data-label="标的"><b>{o.symbol}</b></div><div data-label="方向"><b>{o.side==='BUY'?'买入':o.side==='SELL'?'卖出':'—'}</b></div><div data-label="类型 / 状态"><b>{o.type}</b><small>{o.status}</small></div><div data-label="数量"><b>{display.quantity(o.quantity,o.symbol)}</b></div><div data-label="委托价"><b>{display.price(o.price,o.symbol)}</b></div><div data-label="触发价"><b>{display.price(o.triggerPrice,o.symbol)}</b></div></article>)}</>}
  </div>}
  <footer className={styles.foot}><span>{props.accountLabel} · Binance USDⓈ-M 模拟账户</span><span>候选不计作持仓；条件单数量不代表止损覆盖率。</span></footer>
 </section>;
}
