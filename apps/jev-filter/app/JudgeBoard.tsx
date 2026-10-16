import { judgeLabels, judgeTone, type Judge, type buildJudgeRows } from '../lib/judge';
const fmt=(v:number|null|undefined,n=1)=>v==null?'—':v.toFixed(n);
const price=(v:number)=>v.toLocaleString('en-US',{maximumSignificantDigits:7});
export function JudgeDetails({judge:j}:{judge:Judge}){
  const t=j.target;
  return <div className="judgeDetails">
    {t&&<p>命题：从 {price(t.referencePrice)} 出发，在 {t.horizonMinutes} 分钟内，先到顺向 {price(t.favorablePrice)}，而非反向 {price(t.adversePrice)}。</p>}
    <p>成立估计 {fmt(j.probabilityTruePct)}% · 覆盖 {fmt(j.coveragePct,0)}% · {j.reasons.join(' · ')}</p>
    <p>技术 {fmt(j.dimensions.technical?.score==null?null:j.dimensions.technical.score*25)} / 合约 {fmt(j.dimensions.derivatives?.score==null?null:j.dimensions.derivatives.score*25)} / 基本面 {fmt(j.dimensions.fundamentals?.score==null?null:j.dimensions.fundamentals.score*25)}</p>
    <p className="warning">风险：{j.risks.join(' · ')||'—'}</p>
    <p>评价 {new Date(j.evaluatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}{t&&` · ${t.entryInterval.toUpperCase()} × 12 根 · 1 ATR`}</p>
    <details><summary>结构化答案 JSON</summary><pre>{JSON.stringify(j,null,2)}</pre></details>
  </div>;
}
export default function JudgeBoard({rows,ready,fault}:{rows:ReturnType<typeof buildJudgeRows>;ready:boolean;fault:boolean}){
  return <section className="potential judgeBoard" aria-labelledby="judge-title">
    <div className="poolHead"><h2 id="judge-title"><span>&gt;</span> 候选裁判 <span>{rows.length}</span></h2><span className="muted">判断题 · 按综合分排序</span><details className="poolRules"><summary>判题口径</summary><p>从评价时的盘口中间价起，未来12根入场周期内顺向1 ATR先于反向1 ATR，即命题成立；超时未达属于不成立。S1看180分钟，S2看60分钟。这是研究标尺，不是策略止损或真实1R。</p><p>成立估计≥60%显示成立，≤40%显示不成立，中间待定。把握度对应显示的结论：否定把握=1−成立估计。综合分=技术50%+合约30%+供给估值20%；缺失维度不评分，剩余权重归一，并显示覆盖率。</p><p>JEV估计未经交易结果校准，不等于实际胜率；新闻、链上和解锁日历未覆盖。到期或数据超过20分钟显示过期。仅排序提示，不影响S1/S2下单。</p></details></div>
    {fault?<p className="poolEmpty warning">连接异常，等待新评价。</p>:!rows.length?<p className="poolEmpty">{ready?'当前筛选下无候选。':'正在读取候选…'}</p>:<div className="poolScroll judgeScroll" tabIndex={0} aria-label="候选裁判结果"><table><thead><tr><th>候选</th><th>判定</th><th>综合分</th><th>判定把握</th><th>主因 / 风险</th><th>证据</th></tr></thead><tbody>{rows.map(row=>{
      const j=row.judge,valid=j?.status==='EVALUATED'&&!row.judgeStale;
      const label=!j?'待裁判':row.judgeStale?'已过期':judgeLabels[j.verdict];
      return <tr key={row.key}><td><span className={row.account.toLowerCase()}>{row.account}</span> <strong>{row.symbol.replace('USDT','')}</strong> <span className={row.direction==='LONG'?'long':'short'}>{row.direction==='LONG'?'多':'空'}</span></td><td className={valid?judgeTone[j.verdict]:'muted'}><b>{label}</b></td><td><b className={valid?'judgeScore':'muted'}>{valid?fmt(j.score,0):'—'}</b><span className="muted"> /100</span></td><td>{valid&&j.confidencePct!=null?<><b>{(j.confidencePct/10).toFixed(1)} 成</b><small>{j.verdict==='NO'?'否定':'肯定'} · {fmt(j.confidencePct)}%</small></>:<span className="muted">—{valid?' 相持':''}</span>}</td><td><span>{j?.reasons[0]??'等待模型评价'}</span><small className="warning">{j?.risks[0]??'—'}</small></td><td>{j?<details><summary>展开</summary><JudgeDetails judge={j}/></details>:<span className="muted">—</span>}</td></tr>;
    })}</tbody></table></div>}
  </section>;
}
