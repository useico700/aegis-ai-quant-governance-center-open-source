"use client";
import { useState } from 'react';
import type { LogRow } from '../lib/feed';

const time=(value:string|null|undefined)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'—';
const price=(value:number)=>value.toLocaleString('en-US',{maximumSignificantDigits:8});
const coin=(symbol:string)=>symbol.replace(/USDT$/,'');
const stateFor=(row:LogRow,now:number)=>{
  const decision=row.decision;
  if(!decision||now-Date.parse(row.accountAsOf)>20*60_000||now-Date.parse(row.sources.binanceAt??'')>20*60_000
    ||decision.target&&Date.parse(decision.target.deadlineAt)<=now)
    return {name:'待更新',tone:'waiting',reason:'等待新鲜行情与策略判定',score:null};
  if(decision.status!=='EVALUATED')return {name:'等待',tone:'waiting',reason:decision.reason,score:null};
  if(decision.verdict==='YES')return {name:'YES',tone:'yes',reason:'模型支持这笔原策略计划',score:decision.score};
  if(decision.verdict==='NO')return {name:'NO',tone:'no',reason:'模型不支持这笔原策略计划',score:decision.score};
  return {name:'待定',tone:'waiting',reason:'方向证据接近五五开，继续观察',score:decision.score};
};
export default function DecisionBoard({rows,now,ready,fault}:{rows:LogRow[];now:number;ready:boolean;fault:boolean}){
  const [selectedKey,setSelectedKey]=useState<string|null>(null);
  const ordered=[...rows].sort((a,b)=>(stateFor(b,now).score??-1)-(stateFor(a,now).score??-1)
    ||a.account.localeCompare(b.account)||a.symbol.localeCompare(b.symbol)||a.id.localeCompare(b.id));
  const selected=ordered.find(row=>row.key===selectedKey)??ordered[0]??null;
  const counts=ordered.reduce((count,row)=>{const name=stateFor(row,now).name;
    if(name==='YES')count.yes++;else if(name==='NO')count.no++;else count.wait++;return count;},{yes:0,no:0,wait:0});
  const active=selected?stateFor(selected,now):null;
  const decision=selected?.decision,target=decision?.target;
  const support=active?.score;
  const band=selected?.account==='S2'?'同侧 Px 3% 区':'Px 正确侧 + 确认收盘 50bp 区';
  return <section className="decisionBoard" aria-label="当前策略决策">
    <div className="decisionConsoleHead">
      <div><span className="consoleEyebrow">AEGIS / JEV / PUBLIC RESEARCH</span><h2>当前策略决策<span className="consoleCursor" aria-hidden="true">_</span></h2>
        <p>原策略形成计划后可接入独立研究评审；本开源预览尚未启用推理，不显示真实概率或账户授权。</p></div>
      <div className="decisionCounters" aria-label="当前判定数量">
        <span className="yes"><b>{String(counts.yes).padStart(2,'0')}</b><small>YES</small></span>
        <span className="no"><b>{String(counts.no).padStart(2,'0')}</b><small>NO</small></span>
        <span className="waiting"><b>{String(counts.wait).padStart(2,'0')}</b><small>等待</small></span>
      </div>
    </div>
    {fault&&<div className="decisionConnection" role="status">! 数据连接暂时中断，显示最近一次结果；等待新评价。</div>}
    <div className="decisionQuadrants">
      <section className="decisionPane decisionQueue" aria-label="计划清单">
        <div className="paneTitle"><span><i aria-hidden="true">■</i> <span className="paneIndexWide">02</span><span className="paneIndexNarrow">01</span> / 计划清单</span><span>{String(ordered.length).padStart(2,'0')} 条</span></div>
        <div className="queueLegend" aria-hidden="true"><span>账户 / 币种 / 方向</span><span>判断</span><span>分数 ↓</span></div>
        <div className="queueRows">
          {!ordered.length?<div className="queueEmpty">{ready?'当前筛选下没有候选计划。':'正在读取策略计划…'}<span className="cursor" aria-hidden="true">▋</span></div>:
            ordered.map((row,index)=>{const state=stateFor(row,now);return <button type="button" className={`queueRow ${state.tone}`} aria-pressed={selected?.key===row.key}
              onClick={()=>setSelectedKey(row.key)} key={row.key}>
              <span className="queueIndex">{String(index+1).padStart(2,'0')}</span>
              <span className="queuePlan"><b className={row.account.toLowerCase()}>{row.account}</b><strong>{coin(row.symbol)}</strong><small>{row.direction==='LONG'?'多':'空'}</small></span>
              <span className="queueVerdict">{state.name}</span><span className="queueScore">{state.score===null?'--':state.score.toFixed(0)}</span>
            </button>;})}
        </div>
        <div className="paneFoot"><span>↓ 分数从高到低 · 无分数置后</span><span>CLICK TO INSPECT</span></div>
      </section>

      <section className="decisionPane decisionReadout" aria-label="所选计划判定">
        <div className="paneTitle"><span><i aria-hidden="true">■</i> <span className="paneIndexWide">01</span><span className="paneIndexNarrow">02</span> / 决策读数</span><span>{selected?`${selected.account} · ${coin(selected.symbol)}`:'NO TARGET'}</span></div>
        {!selected?<div className="readoutEmpty"><span>&gt; SELECT SIGNAL</span><p>从计划清单选择一个计划，查看判定与依据。</p></div>:<div className="readoutContent">
          <div className="readoutTop">
            <div className="readoutIdentity"><span className={selected.account.toLowerCase()}>{selected.account}</span><strong>{coin(selected.symbol)}</strong><span>{selected.direction==='LONG'?'做多 ↑':'做空 ↓'}</span></div>
            <time>更新 {time(decision?.evaluatedAt??selected.accountAsOf)}</time>
          </div>
          <div className={`readoutVerdict ${active?.tone}`}><span>{active?.name}</span><p>{active?.reason}</p></div>
          <div className="readoutScore"><div><span>模型支持度 / 100</span><strong>{support===null||support===undefined?'--':support.toFixed(0)}</strong></div>
            <div className="pixelScale" aria-label={support===null||support===undefined?'暂无有效模型分数':`模型支持度 ${support.toFixed(0)} 分`}>
              {Array.from({length:20},(_,i)=><span key={i} className={support!==null&&support!==undefined&&i<Math.round(support/5)?'lit':''}/>)}
            </div><small>分数未经当前策略结果校准；不能按胜率理解。</small></div>
          <div className="readoutPrices"><div><span>采样入场</span><strong>{target?price(target.referencePrice):'—'}</strong></div>
            <div><span>初始止损</span><strong>{target?price(target.initialStop):'—'}</strong></div>
            <div><span>净 +1R 目标</span><strong>{target?price(target.netOneRPrice):'—'}</strong></div></div>
          {decision?.structure&&<p className="validationNote">S2 · 15M Z 形态 → 1H 两点趋势线 → 5M 入场。{decision.structure.status==='VALID'?'结构证据已核对。':'结构未就绪，继续等待。'}</p>}
          {decision?.entryQuality&&<div className="readoutTrace"><div className="traceTitle">&gt; 首档落袋</div>
            <p>{decision.entryQuality.firstHarvestR===null?decision.reason:`预计净 ${decision.entryQuality.firstHarvestR.toFixed(3)}R，累计减仓 60%`}</p>
            <p>{decision.entryQuality.targetPrice!==null?`前方 6H 高低点内侧参考 ${price(decision.entryQuality.targetPrice)}；成交后按实际成本冻结。`:decision.entryQuality.status==='PASS'?'突破前方参考后，采用标准净 0.5R 首档。':'入场条件未齐，尚未形成首档目标。'}后续 1R / 2R 分批，保留 15% 尾仓。</p>
            <p>模型仍判断净 +1R 先于初始止损；首档提前不代表胜率提高。</p></div>}
          <div className="readoutTrace"><div className="traceTitle">&gt; 判定路径 / TRACE</div>
            <p><span>01</span> 原策略计划已列入观察清单</p>
            <p><span>02</span> {decision?.reason??'等待可评估机会'}</p>
            <p><span>03</span> {band} · {target?`观察 ${target.horizonMinutes} 分钟`:'待取得有效盘口与止损'}</p></div>
          <div className="readoutBoundary"><span>RESEARCH ONLY</span><p>YES 不直接开仓或放大实盘仓位；S1 还须通过 IQ1 P1 精确逐笔锚点、形态与组合容量门。模拟手续费每侧 0.05%、每次不利滑点 5bp；真实成交与资金费另行核对。</p></div>
          <div className="readoutPlanId">PLAN / {selected.id}</div>
        </div>}
      </section>
    </div>
  </section>;
}
