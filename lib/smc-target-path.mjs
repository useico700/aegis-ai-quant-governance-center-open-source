// Prospective4H target-path evidence. This module never grants order authority.
// Formation uses the existing scanner's A/B displacement rules. Validity uses
// the formal FVG model's one CLOSED4H close through the far edge, not a quote.
import { createHash } from 'node:crypto';
import { smcBars } from './smc-bar-evidence.mjs';
import { smcNetRewardRisk } from './smc-scanner.mjs';
import policy from './smc-scan-policy.json' with { type: 'json' };

export const TARGET_PATH_REVISION = 'SMC-TARGET-PATH-1';
const H4 = 14400000, MAX_SNAPSHOT_AGE = 360000;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)] ?? 0;
const rounded = n => Number(n.toPrecision(12));
const priceRound = (n,tick,up) => rounded((up ? Math.ceil(n/tick-1e-8) : Math.floor(n/tick+1e-8))*tick);
const row = b => [b.openTime,b.open,b.high,b.low,b.close,b.volume,b.closeTime];
function atr(bars,index) {
  const start=Math.max(1,index-13),part=bars.slice(start,index+1);
  return part.reduce((sum,b,i)=>sum+Math.max(b.high-b.low,Math.abs(b.high-bars[start+i-1].close),Math.abs(b.low-bars[start+i-1].close)),0)/part.length;
}
function displacementQuality(bars,index,direction) {
  // Require the existing20-bar baseline; do not infer a grade at history's edge.
  if(index<20)return null;
  const bar=bars[index],long=direction==='LONG',a=atr(bars,index);
  const baseline=median(bars.slice(index-20,index).map(b=>b.volume));
  const current={bodyAtr:Math.abs(bar.close-bar.open)/Math.max(a,Number.EPSILON),
    bodyFraction:Math.abs(bar.close-bar.open)/Math.max(bar.high-bar.low,Number.EPSILON),
    volumeRatio:baseline>0?bar.volume/baseline:0};
  const directional=long?bar.close>bar.open:bar.close<bar.open;
  const strong=directional&&current.bodyAtr>=policy.strongDisplacementBodyAtr
    &&current.bodyFraction>=policy.strongDisplacementBodyFraction&&current.volumeRatio>=policy.strongDisplacementVolumeRatio;
  const base=directional&&current.bodyAtr>=policy.displacementBodyAtr
    &&current.bodyFraction>=policy.displacementBodyFraction&&current.volumeRatio>=policy.displacementVolumeRatio;
  if(strong||base)return {grade:strong?'A':'B',model:'SINGLE_BAR',bars:1,metrics:current};
  for(let width=2;width<=policy.cumulativeDisplacementBars;width++) {
    const leg=bars.slice(index-width+1,index+1),signed=long?leg.at(-1).close-leg[0].open:leg[0].open-leg.at(-1).close;
    const metrics={bodyAtr:signed/Math.max(a,Number.EPSILON),
      bodyFraction:signed/Math.max(leg.reduce((sum,b)=>sum+Math.max(b.high-b.low,Number.EPSILON),0),Number.EPSILON),
      volumeRatio:baseline>0?Math.max(...leg.map(b=>b.volume))/baseline:0};
    if(signed>0&&metrics.bodyAtr>=policy.cumulativeDisplacementBodyAtr
      &&metrics.bodyFraction>=policy.cumulativeDisplacementBodyFraction&&metrics.volumeRatio>=policy.cumulativeDisplacementVolumeRatio)
      return {grade:'B',model:'CUMULATIVE_LEG',bars:width,metrics};
  }
  return null;
}
export function build4hFvgEvidence({symbol,bars4h,tickSize,now}) {
  check(typeof symbol==='string'&&/^[A-Z0-9]{3,24}$/.test(symbol)&&Number.isFinite(now),'TARGET_PATH_SCOPE_INVALID');
  const tick=Number(tickSize);
  check(Number.isFinite(tick)&&tick>0,'TARGET_PATH_TICK_INVALID');
  const bars=smcBars(bars4h,H4,now),zones=[];
  for(let i=21;i<bars.length;i++) {
    const first=bars[i-2],third=bars[i];
    for(const direction of ['LONG','SHORT']) {
      const long=direction==='LONG';
      if(!(long?third.low>first.high+2*tick:third.high<first.low-2*tick))continue;
      const quality=displacementQuality(bars,i-1,direction);
      if(!quality)continue;
      const low=long?first.high:third.high,high=long?third.low:first.low,later=bars.slice(i+1);
      // Matches viableDisplacementFvgContexts: one completed4H close breaks the
      // far boundary. Wick touches or instantaneous prices do not retire it.
      if(later.some(b=>long?b.close<low:b.close>high))continue;
      const touched=later.filter(b=>b.low<=high&&b.high>=low);
      zones.push({id:`4H-FVG-${direction}-${third.closeTime}`,timeframe:'4H',kind:'FVG',direction,
        low:rounded(low),high:rounded(high),ce:rounded((low+high)/2),availableAt:third.closeTime,
        quality,sourceBars:bars.slice(i-2,i+1).map(row),lastTouchAt:touched.at(-1)?.closeTime??null,
        touchBars:touched.length,validity:'NO_CLOSED_4H_FAR_EDGE_BREAK',orderAuthority:false});
    }
  }
  return {revision:TARGET_PATH_REVISION,symbol,observedAt:now,availableAt:bars.at(-1).closeTime,
    tickSize:tick,sourceBars:bars.map(row),zones,orderAuthority:false};
}
function validateFreshness(evidence,now) {
  check(evidence?.revision===TARGET_PATH_REVISION&&Number.isFinite(now)&&Number.isFinite(evidence.observedAt)
    &&now>=evidence.observedAt&&now-evidence.observedAt<=MAX_SNAPSHOT_AGE,'TARGET_PATH_EVIDENCE_STALE');
  check(Number.isFinite(evidence.availableAt)&&evidence.availableAt<now
    &&now-evidence.availableAt<=H4+30000,'TARGET_PATH_4H_STALE');
}
export function validate4hFvgEvidence(evidence,now) {
  validateFreshness(evidence,now);
  const expected=build4hFvgEvidence({symbol:evidence.symbol,bars4h:evidence.sourceBars,tickSize:evidence.tickSize,now:evidence.observedAt});
  check(JSON.stringify(evidence)===JSON.stringify(expected),'TARGET_PATH_EVIDENCE_MISMATCH');
  return true;
}
export function compact4hFvgEvidence(evidence) {
  validate4hFvgEvidence(evidence,evidence.observedAt);
  const {sourceBars,...rest}=evidence;
  return {...structuredClone(rest),evidenceMode:'COMPACT',
    sourceBarsSha256:createHash('sha256').update(JSON.stringify(sourceBars)).digest('hex'),
    sourceBarCount:sourceBars.length,sourceFrom:sourceBars[0][0]};
}
// A compact proof checks shape, causality and freshness ONLY. Its digest is a
// provenance label, not proof that no opposing zone was omitted. Live admission
// must reconstruct from trusted complete4H history independently.
export function validateCompact4hFvgEvidence(evidence,now) {
  validateFreshness(evidence,now);
  check(evidence.evidenceMode==='COMPACT'&&evidence.sourceBars===undefined
    &&typeof evidence.symbol==='string'&&/^[A-Z0-9]{3,24}$/.test(evidence.symbol)
    &&evidence.orderAuthority===false&&Number.isFinite(evidence.tickSize)&&evidence.tickSize>0
    &&typeof evidence.sourceBarsSha256==='string'&&/^[a-f0-9]{64}$/.test(evidence.sourceBarsSha256)
    &&Number.isInteger(evidence.sourceBarCount)&&evidence.sourceBarCount>=80&&evidence.sourceBarCount<=1500
    &&Number.isSafeInteger(evidence.sourceFrom)&&evidence.sourceFrom%H4===0
    &&evidence.availableAt===evidence.sourceFrom+evidence.sourceBarCount*H4-1
    &&Array.isArray(evidence.zones)&&evidence.zones.length<=2*(evidence.sourceBarCount-2),
    'TARGET_PATH_COMPACT_INVALID');
  const ids=new Set();
  for(const z of evidence.zones) {
    const long=z?.direction==='LONG',q=z?.quality,m=q?.metrics,src=z?.sourceBars;
    check(z?.timeframe==='4H'&&z.kind==='FVG'&&['LONG','SHORT'].includes(z.direction)
      &&z.id===`4H-FVG-${z.direction}-${z.availableAt}`&&!ids.has(z.id)
      &&[z.low,z.high,z.ce,z.availableAt].every(Number.isFinite)&&z.low>0&&z.high>z.low
      &&z.ce===rounded((z.low+z.high)/2)&&z.availableAt<=evidence.availableAt
      &&z.validity==='NO_CLOSED_4H_FAR_EDGE_BREAK'&&z.orderAuthority===false
      &&Number.isInteger(z.touchBars)&&z.touchBars>=0&&z.touchBars<evidence.sourceBarCount
      &&(z.lastTouchAt===null?z.touchBars===0:Number.isSafeInteger(z.lastTouchAt)&&z.touchBars>0
        &&z.lastTouchAt>z.availableAt&&z.lastTouchAt<=evidence.availableAt&&(z.lastTouchAt+1)%H4===0)
      &&Array.isArray(src)&&src.length===3&&src.every((r,i)=>Array.isArray(r)&&r.length===7
        &&r.every(Number.isFinite)&&Number.isSafeInteger(r[0])&&r[0]%H4===0&&r[6]===r[0]+H4-1
        &&r[3]>0&&r[5]>=0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])
        &&r[0]>=evidence.sourceFrom&&(!i||r[0]===src[i-1][0]+H4))
      &&src[2][6]===z.availableAt
      &&z.low===rounded(long?src[0][2]:src[2][2])&&z.high===rounded(long?src[2][3]:src[0][3])
      &&z.high-z.low>2*evidence.tickSize
      &&['A','B'].includes(q?.grade)&&['SINGLE_BAR','CUMULATIVE_LEG'].includes(q?.model)
      &&Number.isInteger(q.bars)&&q.bars>0&&q.bars<=policy.cumulativeDisplacementBars
      &&[m?.bodyAtr,m?.bodyFraction,m?.volumeRatio].every(n=>Number.isFinite(n)&&n>=0),
      'TARGET_PATH_COMPACT_ZONE_INVALID');
    const qualified=q.model==='SINGLE_BAR'?q.bars===1&&m.bodyAtr>=policy.displacementBodyAtr
      &&m.bodyFraction>=policy.displacementBodyFraction&&m.volumeRatio>=policy.displacementVolumeRatio
      :q.grade==='B'&&q.bars>=2&&m.bodyAtr>=policy.cumulativeDisplacementBodyAtr
        &&m.bodyFraction>=policy.cumulativeDisplacementBodyFraction&&m.volumeRatio>=policy.cumulativeDisplacementVolumeRatio;
    check(qualified&&(q.grade!=='A'||m.bodyAtr>=policy.strongDisplacementBodyAtr
      &&m.bodyFraction>=policy.strongDisplacementBodyFraction&&m.volumeRatio>=policy.strongDisplacementVolumeRatio),
      'TARGET_PATH_COMPACT_QUALITY_INVALID');
    ids.add(z.id);
  }
  return true;
}
export function assessTargetPath({evidence,direction,entry,stop,referenceTarget=null,tickSize,now}) {
  const result={revision:TARGET_PATH_REVISION,state:'UNAVAILABLE',ready:false,admissionTarget:null,netR:null,
    barrier:null,reason:null,entry,referenceTarget,evidenceAt:evidence?.availableAt??null,orderAuthority:false};
  try {if(evidence?.evidenceMode==='COMPACT')validateCompact4hFvgEvidence(evidence,now);else validate4hFvgEvidence(evidence,now);} catch(error) {return {...result,reason:/^[A-Z0-9_]+$/.test(error.message)?error.message:'TARGET_PATH_EVIDENCE_INVALID'};}
  const tick=Number(tickSize),long=direction==='LONG';
  if(!['LONG','SHORT'].includes(direction)||![entry,stop,tick].every(n=>Number.isFinite(n)&&n>0)
    ||tick!==evidence.tickSize||!(long?stop<entry:stop>entry)
    ||referenceTarget!==null&&(!Number.isFinite(referenceTarget)||referenceTarget<=0||!(long?referenceTarget>entry:referenceTarget<entry)))
    return {...result,reason:'TARGET_PATH_GEOMETRY_INVALID'};
  const opposing=evidence.zones.filter(z=>z.direction!==(long?'LONG':'SHORT'));
  const inside=opposing.filter(z=>entry>=z.low&&entry<=z.high)
    .sort((a,b)=>(a.high-a.low)-(b.high-b.low)||b.availableAt-a.availableAt)[0];
  if(inside)return {...result,state:'INSIDE_OPPOSING_4H_POI',barrier:inside,reason:'INSIDE_OPPOSING_4H_POI'};
  // A still-valid zone behind price matters only when the declared initial
  // stop would cross back through it. No arbitrary age/percent/ATR distance
  // cap: historical zones outside this trade's risk corridor are irrelevant.
  const crossed=opposing.filter(z=>long?entry>z.high&&stop<=z.high:entry<z.low&&stop>=z.low)
    .sort((a,b)=>Math.abs((long?a.high:a.low)-entry)-Math.abs((long?b.high:b.low)-entry)||b.availableAt-a.availableAt)[0];
  if(crossed)return {...result,state:'CROSSED_UNCONFIRMED',barrier:crossed,reason:'OPPOSING_4H_POI_CROSS_UNCONFIRMED'};
  const ahead=opposing.filter(z=>long?z.low>entry:z.high<entry)
    .sort((a,b)=>Math.abs((long?a.low:a.high)-entry)-Math.abs((long?b.low:b.high)-entry)||b.availableAt-a.availableAt)[0];
  const near=ahead?priceRound((long?ahead.low:ahead.high)+(long?-2:2)*tick,tick,!long):null;
  const choosesZone=near!==null&&(referenceTarget===null||(long?near<referenceTarget:near>referenceTarget));
  const target=choosesZone?near:referenceTarget;
  if(target===null)return {...result,state:'NO_TARGET',reason:'NO_REAL_4H_TARGET'};
  if(!(long?target>entry:target<entry))return {...result,state:'APPROACHING_OPPOSING_4H_POI',barrier:ahead,reason:'NO_SPACE_BEFORE_OPPOSING_4H_POI'};
  const rr=smcNetRewardRisk({direction,entry,stop,target});
  return {...result,state:choosesZone?'APPROACHING_OPPOSING_4H_POI':'CLEAR',ready:rr.qualified,
    admissionTarget:target,netR:rr.netR,barrier:choosesZone?ahead:null,
    reason:rr.qualified?'TARGET_PATH_NET_2R':'TARGET_PATH_NET_R_BELOW_2'};
}
