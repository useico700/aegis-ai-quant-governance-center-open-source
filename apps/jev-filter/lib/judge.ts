import type { Payload } from './payload';
import { mergeFeed } from './feed.ts';
export type JudgeScore = { type:'score'; score:number; confidence:number; probabilities:Record<string,number> };
export type Judge = {
  revision:'JEV-CANDIDATE-JUDGE-1'; status:'EVALUATED'|'UNAVAILABLE'; verdict:'YES'|'NO'|'UNCERTAIN'|'INSUFFICIENT';
  score:number|null; probabilityTruePct:number|null; confidencePct:number|null; coveragePct:number;
  dimensions:Record<'technical'|'derivatives'|'fundamentals',JudgeScore|null>;
  target:{referencePrice:number; atrPrice:number; favorablePrice:number; adversePrice:number; entryInterval:'15m'|'5m';horizonBars:12;horizonMinutes:180|60;observedAt:string;deadlineAt:string}|null;
  evaluatedAt:string; model:string|null;inputHash:string|null;reasons:string[];risks:string[];
};
export const judgeLabels = {YES:'成立',NO:'不成立',UNCERTAIN:'待定',INSUFFICIENT:'缺证据'};
export const judgeTone = {YES:'good',NO:'short',UNCERTAIN:'warning',INSUFFICIENT:'muted'};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const range=(v:unknown,a:number,b:number):v is number=>finite(v)&&v>=a&&v<=b;
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const close=(a:unknown,b:number)=>finite(a)&&Math.abs(a-b)<.11;
export function sanitizeJudge(raw:unknown, account:'S1'|'S2', direction:'LONG'|'SHORT', now:number):Judge|null {
  if(raw==null)return null;
  const fail=():never=>{throw new Error('JEV_JUDGE_INVALID');};
  if(typeof raw!=='object')return fail();
  const j=raw as Judge;
  if(j.revision!=='JEV-CANDIDATE-JUDGE-1'||!['EVALUATED','UNAVAILABLE'].includes(j.status)||!stamp(j.evaluatedAt)||Date.parse(j.evaluatedAt)>now+30_000)return fail();
  const dimensions={} as Judge['dimensions'];
  const weights={technical:.5,derivatives:.3,fundamentals:.2};
  let weighted=0,coverage=0;
  for(const name of Object.keys(weights) as (keyof typeof weights)[]){
    const d=j.dimensions?.[name];
    if(d==null){dimensions[name]=null;continue;}
    if(d.type!=='score'||!range(d.score,0,4)||!range(d.confidence,0,1)||!d.probabilities||Object.keys(d.probabilities).length!==5)return fail();
    const probs=[0,1,2,3,4].map(i=>d.probabilities[i]);
    if(probs.some(p=>!range(p,0,1))||Math.abs(probs.reduce((a,b)=>a+b,0)-1)>.025||Math.abs(probs.reduce((s,p,i)=>s+p*i,0)-d.score)>.06)return fail();
    dimensions[name]={type:'score',score:d.score,confidence:d.confidence,probabilities:Object.fromEntries(probs.map((p,i)=>[i,p]))};
    weighted+=d.score*25*weights[name];coverage+=weights[name];
  }
  let target:Judge['target']=null;
  if(j.target){
    const t=j.target,minutes=account==='S1'?180:60,sign=direction==='LONG'?1:-1;
    if(![t.referencePrice,t.atrPrice,t.favorablePrice,t.adversePrice].every(v=>finite(v)&&v>0)||t.entryInterval!==(account==='S1'?'15m':'5m')||t.horizonBars!==12||t.horizonMinutes!==minutes||!stamp(t.observedAt)||!stamp(t.deadlineAt))return fail();
    if(Date.parse(t.observedAt)>now+30_000||Date.parse(t.observedAt)>Date.parse(j.evaluatedAt)+30_000||Date.parse(t.deadlineAt)-Date.parse(t.observedAt)!==minutes*60_000)return fail();
    if(Math.abs(t.favorablePrice-(t.referencePrice+sign*t.atrPrice))>t.referencePrice*1e-8||Math.abs(t.adversePrice-(t.referencePrice-sign*t.atrPrice))>t.referencePrice*1e-8)return fail();
    target={referencePrice:t.referencePrice,atrPrice:t.atrPrice,favorablePrice:t.favorablePrice,adversePrice:t.adversePrice,entryInterval:t.entryInterval,horizonBars:12,horizonMinutes:minutes,observedAt:t.observedAt,deadlineAt:t.deadlineAt};
  }
  if(j.status==='EVALUATED'){
    if(!target||!dimensions.technical||!range(j.probabilityTruePct,0,100)||!range(j.score,0,100)||!close(j.score,weighted/coverage)||!close(j.coveragePct,coverage*100)||j.model!=='jev-1.13.0'||!/^([a-f0-9]{64})$/.test(j.inputHash??''))return fail();
    const expected=j.probabilityTruePct>=60?'YES':j.probabilityTruePct<=40?'NO':'UNCERTAIN';
    if(j.verdict!==expected||(expected==='UNCERTAIN'?j.confidencePct!==null:!close(j.confidencePct,expected==='YES'?j.probabilityTruePct:100-j.probabilityTruePct)))return fail();
  }else if(j.verdict!=='INSUFFICIENT'||j.score!==null||j.probabilityTruePct!==null||j.confidencePct!==null||j.coveragePct!==0||Object.values(dimensions).some(Boolean))return fail();
  const texts=(list:unknown)=>Array.isArray(list)&&list.length<=8&&list.every(s=>typeof s==='string'&&s.length<=100)?list as string[]:fail();
  return {revision:j.revision,status:j.status,verdict:j.verdict,score:j.score,probabilityTruePct:j.probabilityTruePct,confidencePct:j.confidencePct,coveragePct:j.coveragePct,dimensions,target,
    evaluatedAt:j.evaluatedAt,model:j.status==='EVALUATED'?j.model:null,inputHash:typeof j.inputHash==='string'&&/^[a-f0-9]{64}$/.test(j.inputHash)?j.inputHash:null,reasons:texts(j.reasons),risks:texts(j.risks)};
}
export function buildJudgeRows(accounts:Record<string,Payload>, now:number){
  return mergeFeed([],Object.values(accounts)).map(row=>{
    const fresh=(s:string|null|undefined)=>!!s&&now-Date.parse(s)>=-30_000&&now-Date.parse(s)<=20*60_000;
    const stale=!fresh(row.accountAsOf)||!fresh(accounts[row.account]?.sourceAsOf)||!fresh(row.judge?.evaluatedAt)||!fresh(row.sources.binanceAt)
      || !!row.judge?.target && Date.parse(row.judge.target.deadlineAt)<=now;
    return {...row,judgeStale:stale};
  }).sort((a,b)=>Number(a.judgeStale)-Number(b.judgeStale)||(b.judge?.score??-1)-(a.judge?.score??-1)||a.key.localeCompare(b.key));
}
