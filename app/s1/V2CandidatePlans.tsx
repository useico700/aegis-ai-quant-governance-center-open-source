"use client";
import { usesS1Structure } from "../../lib/s1-candidate-funnel.mjs";
import { useState, type ComponentProps } from "react";
import CandidateFunnel, { type Candidate } from "./CandidateFunnel";
import CandidateHistory from "./CandidateHistory";
import PriceCalibration from "./PriceCalibration";
import { partitionCandidateFunnel, candidateInputState } from "../../lib/s1-candidate-funnel.mjs";
import { arrivalCountdown, candidateStatusNote } from "../../lib/s1-arrival.mjs";
import { createBinanceDisplay } from "../../lib/s1-price-display.mjs";
import styles from "./v2-panels.module.css";
export type { Candidate } from "./CandidateFunnel";
const clock=(v:string|null|undefined)=>v&&Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(v)):'—';
const direction=(v:string|null)=>v==='LONG'?'多头':v==='SHORT'?'空头':'方向待定';
export default function V2CandidatePlans(props:ComponentProps<typeof CandidateFunnel>){
 const [tab,setTab]=useState('all');
 if(!usesS1Structure(props.accountLabel, props.execution))return <CandidateFunnel {...props}/>;
 const {candidates=[],filteredCandidates=[],execution,executionFresh,quotes=[],rules=[],now,stale,error,loading,scannedSymbols,universeSize,partialScan}=props;
 const ready=(props.inputStateOverride??candidateInputState(execution,executionFresh,now))==='READY',unavailable=stale||error;
 const ordered=[...candidates].sort((a,b)=>(Date.parse(a.intersectionTime??'')||Infinity)-(Date.parse(b.intersectionTime??'')||Infinity)||a.id.localeCompare(b.id));
 const groups=partitionCandidateFunnel(ordered,now,unavailable),past=[...groups.inactive,...groups.unknown] as Candidate[];
 const choices=[{id:'all',label:'全部计划',rows:ordered},{id:'upcoming',label:'等待交汇',rows:groups.upcoming},{id:'arrived',label:'等待确认',rows:groups.arrived},{id:'locked',label:'已确认',rows:groups.locked},{id:'inactive',label:'失效 / 待核验',rows:past}];
 const rows=(choices.find(c=>c.id===tab)?.rows??ordered) as Candidate[],next=ready?groups.upcoming[0] as Candidate|undefined:undefined;
 const display=createBinanceDisplay(rules,quotes);
 return <section id="candidates" className={styles.panel} aria-label="候选计划与交汇倒计时" data-candidate-layout="v2-aligned-plan-list">
  <header className={styles.head}><div><small>DEMO MONITOR</small><h2>候选计划与交汇倒计时</h2><p>每个交汇独立一行，按数学交汇时间排序；时间统一为北京时间。</p></div><span className={styles.badge}>{candidates.length} 个计划</span></header>
  <div className={styles.toolbar}><div className={styles.tabs} role="group" aria-label="候选计划阶段">{choices.map(c=><button key={c.id} type="button" aria-pressed={tab===c.id} onClick={()=>setTab(c.id)}>{c.label} {c.rows.length}</button>)}</div><span>扫描 {scannedSymbols??'—'} / {universeSize??'—'} 个交易对</span></div>
  <div className={styles.notice}><span>下个交汇</span><b>{!ready?'候选输入待核验':next?`${next.symbol.replace(/USDT$/,'')} · ${clock(next.intersectionTime)} · ${arrivalCountdown(next.intersectionTime,now,false,next.status)}`:'暂无前向交汇，等待新结构形成'}</b></div>
  {(!ready||unavailable)&&!loading&&<p className={styles.alert} role="status">扫描或执行输入待恢复，保留的计划仅供查看，不代表当前可入场。{partialScan?'本轮扫描不完整。':''}现有持仓管理独立继续。</p>}
  <div className={styles.scroll}><div className={`${styles.row} ${styles.plans} ${styles.header}`} aria-hidden="true">{['标的 / 方向','数学交汇时间','精确交点 P×','交汇倒计时','当前 BBO','入场验证状态','结构详情'].map(label=><div key={label}>{label}</div>)}</div>
  {!rows.length?<div className={styles.empty}>{loading?'正在读取候选':!ready?'候选状态待恢复':!ordered.length?'暂无符合结构条件的候选':'当前阶段暂无计划'}<p>{!ready?'输入未确认，空列表不代表本轮没有候选。':'等待扫描器下一轮结构更新。'}</p></div>:rows.map(plan=>{
   const priority=ready?execution?.candidatePriorities?.find(p=>p.planId===plan.id):undefined;
   const future=Date.parse(plan.intersectionTime??'')>now,expired=['EXPIRED','CONFIRMED_EXPIRED','NON_CAUSAL_OBSERVATION','INVALIDATED'].includes(plan.status);
   const confirmed=plan.status==='FIRST_CLOSE_LOCKED',rowStale=unavailable||plan.stale;
   const title=rowStale?'快照待核验':expired?plan.status==='INVALIDATED'?'结构已失效':'入场窗口已结束':confirmed?!ready?'已确认 · 待输入恢复':priority?.state==='POSITION_OPEN'?'已有持仓':priority?.state==='SUBMITTING'?'执行处理中':priority?.state==='WAITING'?'当前优先计划':'已确认 · 结构备查':future?'等待交汇':'等待 15M 收线确认';
   const feedback=priority?.reason;
   const note=!ready?'仅供查看，当前不可据此入场':expired?'不再参与本次入场':feedback?/PORTFOLIO|CAPACITY|CORRELATION|GROUP/.test(feedback)?'等待仓位与相关组额度':/ACCOUNT|EVIDENCE|QUOTE|STALE|INFRASTRUCTURE/.test(feedback)?'等待账户与行情校验':'等待执行器条件复核':confirmed?'确认方向不等于已成交':candidateStatusNote(plan,now,rowStale,'15M');
   const quote=quotes.find(q=>q.symbol===plan.symbol),age=now-Date.parse(quote?.exchangeTime??'');
   const current=!rowStale&&quote?.status==='QUOTED'&&age>=-5000&&age<=10000;
   const rule=rules.find(r=>r.symbol===plan.symbol);
   return <article className={`${styles.row} ${styles.plans}`} key={plan.id} aria-label={`${plan.symbol} ${clock(plan.intersectionTime)} 候选`}>
    <div className={styles.identity} data-label="标的 / 方向"><i aria-hidden="true">{plan.symbol.slice(0,1)}</i><b><span className={styles.symbol}>{plan.symbol.replace(/USDT$/,'')}<em>/ USDT</em></span><small className={plan.direction==='LONG'?styles.positive:plan.direction==='SHORT'?styles.negative:styles.muted}>{direction(plan.direction)}</small><small>4H × 1H 交汇</small></b></div>
    <div data-label="数学交汇时间"><b>{clock(plan.intersectionTime)}</b><small>Asia/Shanghai · 精确时点</small></div>
    <div data-label="精确交点 P×"><b>{display.price(plan.intersectionPrice,plan.symbol)}</b><small>数学价格，不等于成交价</small></div>
    <div data-label="交汇倒计时"><b className={!future||expired?styles.warning:undefined}>{arrivalCountdown(plan.intersectionTime,now,rowStale,plan.status)}</b><small>{future?'等待交汇时刻':'以已收线证据判断方向'}</small></div>
    <div data-label="当前 BBO"><b>{current?display.price(quote?.bidPrice,plan.symbol):'—'}</b><small>{current?`Bid · Ask ${display.price(quote?.askPrice,plan.symbol)}`:'盘口待更新'}</small><small>{current?'当前买一 / 卖一':'等待新鲜报价'}</small></div>
    <div data-label="入场验证状态"><b className={rowStale||expired||!ready?styles.warning:confirmed?styles.positive:undefined}>{title}</b><small>{note}</small>{plan.directionClosedAt&&<small>确认 {clock(plan.directionClosedAt)}</small>}</div>
    <div data-label="结构详情"><details className={styles.details}><summary>计划详情</summary><p>计划编号</p><code>{plan.id}</code><p>数据时间 {clock(plan.observedAt)}</p>{feedback&&<p>执行反馈 {feedback}</p>}<PriceCalibration price={plan.intersectionPrice} symbol={plan.symbol} rule={rule} quote={quote} now={now} stale={rowStale}/></details></div>
   </article>;
  })}</div>
  <div id="candidate-history" className={styles.history}><CandidateHistory rows={filteredCandidates} quotes={quotes} rules={rules}/></div>
  <footer className={styles.foot}><span>4H 结构 × 1H 对向结构 → 15M 收线确认</span><span>未来交汇保留“方向待定”，不提前推定多空。</span></footer>
 </section>;
}
