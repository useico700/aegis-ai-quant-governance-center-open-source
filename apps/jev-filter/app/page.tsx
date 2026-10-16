"use client";
import { useEffect, useMemo, useState } from 'react';
import DecisionBoard from './DecisionBoard';
import ResearchBoard from './ResearchBoard';
import ShadowBoard from './ShadowBoard';
import { mergeFeed } from '../lib/feed';
import type { Payload, SmcPayload } from '../lib/payload';

type ResponseBody={status:string;accounts:Record<string,Payload>;smc:SmcPayload|null};
export default function Page(){
  const [view,setView]=useState<'decision'|'research'|'shadow'>('decision');
  const [data,setData]=useState<ResponseBody|null>(null),[fault,setFault]=useState(false),[now,setNow]=useState(0);
  const [account,setAccount]=useState('ALL'),[direction,setDirection]=useState('ALL'),[verdict,setVerdict]=useState('ALL'),[query,setQuery]=useState('');
  useEffect(()=>{let active=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    const read=async()=>{try{const response=await fetch('/api/observations',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])});
      if(!response.ok)throw Error('READ_FAILED');const next=await response.json() as ResponseBody;
      if(active){setData(next);setFault(false);setNow(Date.now());}
    }catch{if(active){setFault(true);setNow(Date.now());}}finally{if(active)timer=setTimeout(read,30_000);}};
    void read();return()=>{active=false;controller.abort();clearTimeout(timer);};
  },[]);
  const rows=useMemo(()=>mergeFeed([],Object.values(data?.accounts??{})).filter(row=>{
    const term=query.trim().toUpperCase();
    return (account==='ALL'||row.account===account)&&(direction==='ALL'||row.direction===direction)
      &&(verdict==='ALL'||(verdict==='WAIT'?row.decision?.verdict==='WAIT'||!row.decision:row.decision?.status==='EVALUATED'&&row.decision?.verdict===verdict))
      &&(!term||row.symbol.includes(term)||row.id.toUpperCase().includes(term));
  }),[data,account,direction,verdict,query]);
  const fresh=(name:string)=>!!data?.accounts[name]&&now-Date.parse(data.accounts[name].asOf)<20*60_000;
  return <main className="terminal decisionPage">
    <header className="toolbar"><div className="statusline"><h1><span aria-hidden="true">&gt;_</span> JEV 决策</h1>
      <span className={!fault&&fresh('S1')&&fresh('S2')?'good':'warning'} role="status">● {fault?'连接重试中':!data?'连接中':fresh('S1')&&fresh('S2')?'持续观察':'等待新数据'}</span>
      <div className="sources">{(['S1','S2'] as const).map(a=><span key={a} className={fresh(a)?a.toLowerCase():'warning'}>{a} {fresh(a)?'在线':'待更新'}</span>)}<span className={data?.smc?.sourceStatus==='READY' && data.smc.sourceHealth?.status!=='DEGRADED'?'good':'warning'}>SMC {data?.smc?.sourceHealth?.status==='DEGRADED'?'数据异常':data?.smc?.sourceStatus==='READY'?'实时':'待更新'}</span></div>
      <span className="mode">独立研究 · 不控制下单</span></div>
      <nav className="decisionNav" aria-label="JEV 页面"><button type="button" aria-pressed={view==='decision'} onClick={()=>{setView('decision');if(account==='SMC')setAccount('ALL');}}>当前决策</button><button type="button" aria-pressed={view==='research'} onClick={()=>setView('research')}>结果验证</button><button type="button" aria-pressed={view==='shadow'} onClick={()=>{setView('shadow');if(account==='SMC')setAccount('ALL');}}>模拟交易</button></nav>
      <div className="filters" role="search" aria-label="筛选候选"><select aria-label="账户" value={account} onChange={e=>setAccount(e.target.value)}><option value="ALL">全部账户</option><option>S1</option><option>S2</option>{view==='research'&&<option>SMC</option>}</select>
        {view==='decision'&&<><select aria-label="方向" value={direction} onChange={e=>setDirection(e.target.value)}><option value="ALL">全部方向</option><option value="LONG">做多</option><option value="SHORT">做空</option></select>
        <select aria-label="决策" value={verdict} onChange={e=>setVerdict(e.target.value)}><option value="ALL">全部判断</option><option value="YES">YES</option><option value="NO">NO</option><option value="WAIT">等待</option></select>
        <input aria-label="搜索币种" type="search" placeholder="搜索币种" value={query} onChange={e=>setQuery(e.target.value)}/></>}</div>
    </header>
    {view==='decision'?<DecisionBoard rows={rows} now={now} ready={!!data} fault={fault}/>:view==='research'?<ResearchBoard accounts={data?.accounts??{}} smc={data?.smc??null} account={account} now={now}/>:<ShadowBoard account={account} direction={direction} query={query}/>}
    <footer><span>开源模式 · 推理与影子未启用 · 当前不作为入场门</span><span>YES / NO 仅供研究，不放大实盘仓位</span></footer>
  </main>;
}
