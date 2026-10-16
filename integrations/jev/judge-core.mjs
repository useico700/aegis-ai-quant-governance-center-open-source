import { MODEL, sha, summarizeBars } from './filter-core.mjs';
import { ENTRY_BAND_BPS } from './entry-band.mjs';

export const JUDGE_REVISION = 'JEV-CANDIDATE-JUDGE-1';
export const WEIGHTS = Object.freeze({technical:0.5,derivatives:0.3,fundamentals:0.2});
const finite = v => typeof v === 'number' && Number.isFinite(v);
const unit = v => finite(v) && v >= 0 && v <= 1;
const rounded = (v,n=1) => Number(v.toFixed(n));
export function missingJudgeEvidence(account, market, metrics) {
  const intervals = account === 'S1' ? ['4h','1h','15m'] : ['1h','15m','5m'];
  const errors = Object.values(market?.errors ?? {});
  const reasons = [];
  if (errors.includes('PUBLIC_WEIGHT_HIGH')) reasons.push('公共行情读取额度暂满');
  else if (errors.includes('PUBLIC_COOLDOWN') || errors.some(code => ['PUBLIC_HTTP_418','PUBLIC_HTTP_429'].includes(code))) reasons.push('交易所公共行情限频');
  if (intervals.some(tf => !summarizeBars(market?.bars?.[tf]))) reasons.push('周期 K 线暂缺');
  const bid=Number(market?.quote?.bid), ask=Number(market?.quote?.ask);
  if (!finite(bid) || bid<=0 || !finite(ask) || ask<bid || !finite(metrics.spreadBps)) reasons.push('盘口报价暂缺');
  if (!finite(metrics.quoteVolumeUsd24h) || metrics.quoteVolumeUsd24h<=0) reasons.push('24 小时成交额暂缺');
  return reasons.length ? reasons.slice(0,8) : ['必要行情或周期证据缺失'];
}
const rubric = [
  'Strong current evidence opposes the preset direction.',
  'Evidence mildly opposes the preset direction; material weaknesses dominate.',
  'Known evidence is balanced or neutral; no clear directional advantage.',
  'Several observations support the preset direction with limited counter-evidence.',
  'Strong, mutually consistent evidence supports the preset direction with no material supplied counter-signal.'
];
export function judgeContext(candidate, account, market, metrics, sources) {
  const interval = account === 'S1' ? '15m' : '5m';
  const intervals = account === 'S1' ? ['4h','1h','15m'] : ['1h','15m','5m'];
  const bid=Number(market?.quote?.bid), ask=Number(market?.quote?.ask);
  const referencePrice=(bid+ask)/2;
  const technical=Object.fromEntries(intervals.map(tf=>[tf,summarizeBars(market?.bars?.[tf])]));
  const entry=technical[interval];
  const observedAt=sources.binanceAt;
  const required=intervals.every(tf=>technical[tf]) && finite(bid) && bid>0 && finite(ask) && ask>=bid
    && finite(metrics.spreadBps) && metrics.spreadBps>=0 && finite(metrics.quoteVolumeUsd24h)
    && metrics.quoteVolumeUsd24h>0 && finite(entry?.atrPrice) && entry.atrPrice>0 && Number.isFinite(Date.parse(observedAt));
  if(!required)return null;
  const horizonMinutes=12*(account==='S1'?15:5), sign=candidate.direction==='LONG'?1:-1;
  const target={referencePrice,atrPrice:entry.atrPrice,favorablePrice:referencePrice+sign*entry.atrPrice,adversePrice:referencePrice-sign*entry.atrPrice,
    entryInterval:interval,horizonBars:12,horizonMinutes,observedAt,deadlineAt:new Date(Date.parse(observedAt)+horizonMinutes*60_000).toISOString()};
  if(Math.min(target.favorablePrice,target.adversePrice)<=0)return null;
  return {account,symbol:candidate.symbol,direction:candidate.direction,stage:candidate.stage,px:candidate.px,intersectionTime:candidate.intersectionTime,
    target,technical,metrics,sources,available:{technical:true,
      derivatives:[metrics.fundingPct,metrics.openInterestUsd,metrics.oiChangePct1h].every(finite),
      fundamentals:!!sources.coingeckoAt && [metrics.marketCapUsd,metrics.fdvToCap,metrics.circulatingRatio].every(finite)},
    missing:['No news, unlock calendar or on-chain flow evidence supplied.','No actual entry, stop or fill path supplied. ATR barriers are research targets, not strategy stop/1R.']};
}
export function judgeQuestions(key, context) {
  if(!context)return {};
  const prefix=`For candidate ${key} only, use its supplied preset direction and current evidence. Never invent missing news, future paths, fills or strategy parameters. This is independent research, not an execution instruction.`;
  const questions={ [`${key}:judge:truth`]:{type:'noul',instructions:`${prefix} Will price reach target.favorablePrice before target.adversePrice within the fixed horizon from target.observedAt to target.deadlineAt? This is a first-touch event from the sampled referencePrice, including candidates awaiting intersection. Consider multi-timeframe closed-bar technical evidence, liquidity, derivatives positioning and available supply/valuation. A high value means the preset direction succeeds, for both LONG and SHORT.`,criteria:{true:'The favorable 1 ATR barrier is touched first before the deadline.',false:'The adverse 1 ATR barrier is touched first OR no favorable-first resolution occurs by the deadline.'}} };
  const instructions={technical:'Rate directional technical support using each timeframe, closed-bar momentum, ATR, volume, distance to Px and spread. Do not count correlated technical indicators as independent confirmations.',derivatives:'Rate directional support from funding and open interest jointly with price; rising OI alone is not bullish or bearish. Do not infer liquidation or order-flow data.',fundamentals:'Rate directional support from supplied market cap, FDV/cap, circulating supply ratio and turnover. Size alone is not bullish; expensive valuation alone is not bearish. Neutral is appropriate when static supply data provides no short-horizon edge. Missing news is unknown.'};
  for(const dimension of Object.keys(WEIGHTS))if(context.available[dimension])questions[`${key}:judge:${dimension}`]={type:'score',instructions:`${prefix} ${instructions[dimension]}`,criteria:rubric};
  return questions;
}
export function readJudgeAnswer(answer, kind) {
  if(kind==='truth')return answer?.type==='noul' && unit(answer.noul)?{type:'noul',noul:answer.noul}:null;
  if(answer?.type!=='score'||!finite(answer.score)||answer.score<0||answer.score>4||!unit(answer.confidence))return null;
  // API distributions/scores are rounded independently to two decimals.
  const p=answer.probabilities;
  if(!p || Object.keys(p).length!==5 || [0,1,2,3,4].some(i=>!unit(p[i])) || Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)>.025)return null;
  if(Math.abs([0,1,2,3,4].reduce((s,i)=>s+i*p[i],0)-answer.score)>.06)return null;
  return {type:'score',score:answer.score,confidence:answer.confidence,probabilities:Object.fromEntries([0,1,2,3,4].map(i=>[i,p[i]]))};
}
export function buildJudge(key, context, answers, evaluatedAt, missingEvidence = []) {
  const base={revision:JUDGE_REVISION,status:'UNAVAILABLE',verdict:'INSUFFICIENT',score:null,probabilityTruePct:null,confidencePct:null,
    coveragePct:0,dimensions:{technical:null,derivatives:null,fundamentals:null},target:context?.target??null,
    evaluatedAt,model:null,inputHash:context?sha({revision:JUDGE_REVISION,context}):null,reasons:[],risks:[]};
  if(!context)return {...base,reasons:['行情读取未完成'],risks:missingEvidence.length?missingEvidence:['必要行情或周期证据缺失']};
  const truth=readJudgeAnswer(answers?.[`${key}:judge:truth`],'truth');
  const dimensions=Object.fromEntries(Object.keys(WEIGHTS).map(name=>[name,context.available[name]?readJudgeAnswer(answers?.[`${key}:judge:${name}`],name):null]));
  if(!truth || !dimensions.technical || Object.keys(WEIGHTS).some(name=>context.available[name]&&!dimensions[name]))return {...base,risks:['模型答案暂缺或格式无效']};
  const coverage=Object.keys(WEIGHTS).reduce((s,k)=>s+(dimensions[k]?WEIGHTS[k]:0),0);
  const score=rounded(Object.keys(WEIGHTS).reduce((s,k)=>s+(dimensions[k]?dimensions[k].score/4*100*WEIGHTS[k]:0),0)/coverage);
  const probabilityTruePct=rounded(truth.noul*100);
  // Deadband is a display convention, never an entry gate or a calibrated guarantee.
  const verdict=probabilityTruePct>=60?'YES':probabilityTruePct<=40?'NO':'UNCERTAIN';
  const confidencePct=verdict==='UNCERTAIN'?null:rounded((verdict==='YES'?truth.noul:1-truth.noul)*100);
  const names={technical:'技术',derivatives:'合约',fundamentals:'基本面'};
  const ranked=Object.keys(WEIGHTS).filter(k=>dimensions[k]).sort((a,b)=>verdict==='NO'?dimensions[a].score-dimensions[b].score:dimensions[b].score-dimensions[a].score);
  const reasons=[`${names[ranked[0]]}证据 ${rounded(dimensions[ranked[0]].score*25)}/100`];
  const risks=[];
  for(const name of Object.keys(WEIGHTS))if(!dimensions[name])risks.push(`${names[name]}缺数`);
  const m=context.metrics;
  if(m.pxDistancePct<=0)risks.push('Px反侧');else if(m.pxDistancePct>ENTRY_BAND_BPS[context.account]/100)risks.push('Px区外');
  if((verdict==='YES'&&score<50)||(verdict==='NO'&&score>50))risks.push('方向判断与综合分分歧');
  if(verdict==='UNCERTAIN')risks.push('方向证据相持');
  if(context.stage==='UPCOMING')risks.push('尚未交汇');
  if(!risks.length)risks.push('新闻与解锁事件未覆盖');
  return {...base,status:'EVALUATED',verdict,score,probabilityTruePct,confidencePct,coveragePct:rounded(coverage*100),dimensions,
    model:MODEL,reasons,risks};
}
