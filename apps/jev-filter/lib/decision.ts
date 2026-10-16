export type Decision = {
  revision:'JEV-P5-PLAN-DECISION-1'|'JEV-P5-PLAN-DECISION-2'|'JEV-P5-PLAN-DECISION-3'|'JEV-P5-PLAN-DECISION-4'|'JEV-R221-IQ1-PRE-GATE-DECISION-1';status:'WAITING'|'UNAVAILABLE'|'EVALUATED';verdict:'YES'|'NO'|'WAIT';
  score:number|null;evaluatedAt:string|null;model:string|null;inputHash:string|null;reason:string;
  structure?:{revision:'S2-15M-Z-FIRST-1H-PX-1';status:'VALID'|'WAIT'|'INVALID';reason:string;geometryHash:string|null;checkedAt:number}|null;
  entryQuality?:{revision:string;status:'PASS'|'WAIT';reason:string;firstHarvestR:number|null;targetPrice:number|null;referencePrice:number|null;managementRevision:string|null}|null;
  target:{referencePrice:number;entryPrice:number;initialStop:number;netOneRPrice:number;favorablePrice:number;adversePrice:number;
    initialRiskPerUnit:number;entryInterval:'15m'|'5m';horizonMinutes:180|60;observedAt:string;deadlineAt:string;
    strategyRevision:string;planId:string;signalClosedAt:number;entryQualityRevision?:string;executionRevision?:string;
    oneHourLookbackBars?:12|null;oneHourExtremePrice?:number|null;oneHourRoomR?:number|null}|null;
};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const stamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function sanitizeDecision(value:unknown,account:'S1'|'S2',direction:'LONG'|'SHORT',id:string,now:number):Decision|null {
  if(value==null)return null;const d=value as Decision;
  if(typeof d!=='object'||!['JEV-P5-PLAN-DECISION-1','JEV-P5-PLAN-DECISION-2','JEV-P5-PLAN-DECISION-3','JEV-P5-PLAN-DECISION-4','JEV-R221-IQ1-PRE-GATE-DECISION-1'].includes(d.revision)||!['WAITING','UNAVAILABLE','EVALUATED'].includes(d.status)
    ||!['YES','NO','WAIT'].includes(d.verdict)||typeof d.reason!=='string'||d.reason.length>100)throw Error('JEV_DECISION_INVALID');
  let structure:Decision['structure']=null;
  if(d.structure!=null){const z=d.structure;
    if(account!=='S2'||d.revision!=='JEV-P5-PLAN-DECISION-4'||z.revision!=='S2-15M-Z-FIRST-1H-PX-1'
      ||!['VALID','WAIT','INVALID'].includes(z.status)||typeof z.reason!=='string'||!/^S2_Z_[A-Z0-9_]{1,80}$/.test(z.reason)
      ||!finite(z.checkedAt)||z.checkedAt>now+30000||(z.geometryHash!==null&&!/^[a-f0-9]{64}$/.test(z.geometryHash))
      ||(z.status==='VALID'&&z.geometryHash===null))throw Error('JEV_STRUCTURE_INVALID');
    structure={revision:z.revision,status:z.status,reason:z.reason,geometryHash:z.geometryHash,checkedAt:z.checkedAt};
  }
  if(d.revision==='JEV-P5-PLAN-DECISION-4'&&(account!=='S2'||(d.status==='EVALUATED'&&structure?.status!=='VALID')))throw Error('JEV_STRUCTURE_INVALID');
  let quality:Decision['entryQuality']=null;
  if(d.entryQuality!=null){
    const q=d.entryQuality;
    if(q.revision!=='S1-S2-ENTRY-RECONFIRM-ROOM-1'||!['PASS','WAIT'].includes(q.status)
      ||typeof q.reason!=='string'||!/^ENTRY_CONFIRMATION_[A-Z_]{1,60}$/.test(q.reason)
      ||q.managementRevision!==`${account}-P5-ADAPTIVE-FIRST-HARVEST-1`
      ||(q.firstHarvestR!==null&&(!finite(q.firstHarvestR)||q.firstHarvestR<=0||q.firstHarvestR>.5))
      ||[q.targetPrice,q.referencePrice].some(x=>x!==null&&(!finite(x)||x<=0))
      ||(q.targetPrice===null)!==(q.referencePrice===null)
      ||(q.status==='WAIT'&&q.firstHarvestR!==null)||(q.status==='PASS'&&q.firstHarvestR===null))throw Error('JEV_ENTRY_QUALITY_INVALID');
    quality={revision:q.revision,status:q.status,reason:q.reason,firstHarvestR:q.firstHarvestR,
      targetPrice:q.targetPrice,referencePrice:q.referencePrice,managementRevision:q.managementRevision};
  }
  const t=d.target,sign=direction==='LONG'?1:-1;
  if(t){
    if(t.planId!==id||t.strategyRevision!=='MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION'
      ||t.entryInterval!==(account==='S1'?'15m':'5m')||t.horizonMinutes!==(account==='S1'?180:60)
      ||![t.referencePrice,t.entryPrice,t.initialStop,t.netOneRPrice,t.favorablePrice,t.adversePrice,t.initialRiskPerUnit,t.signalClosedAt].every(finite)
      ||Math.min(t.referencePrice,t.entryPrice,t.initialStop,t.netOneRPrice,t.initialRiskPerUnit)<=0
      ||sign*(t.referencePrice-t.initialStop)<=0||sign*(t.netOneRPrice-t.referencePrice)<=0
      ||t.favorablePrice!==t.netOneRPrice||t.adversePrice!==t.initialStop||!stamp(t.observedAt)||!stamp(t.deadlineAt)
      ||Date.parse(t.observedAt)>now+30_000||Date.parse(t.deadlineAt)-Date.parse(t.observedAt)!==t.horizonMinutes*60_000
      ||t.signalClosedAt>Date.parse(t.observedAt)
      ||(d.revision==='JEV-R221-IQ1-PRE-GATE-DECISION-1'&&(account!=='S1'||t.entryQualityRevision!=='V2-IQ1-P1-20260915'||t.executionRevision!=='MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY')))
      throw Error('JEV_DECISION_TARGET_INVALID');
    if(d.revision!=='JEV-P5-PLAN-DECISION-1' && (t.oneHourLookbackBars!==null&&t.oneHourLookbackBars!==12
      ||(t.oneHourExtremePrice!==null&&!finite(t.oneHourExtremePrice))
      ||(t.oneHourRoomR!==null&&!finite(t.oneHourRoomR))
      ||(t.oneHourLookbackBars===null)!==(t.oneHourExtremePrice===null)
      ||(t.oneHourExtremePrice===null)!==(t.oneHourRoomR===null)))throw Error('JEV_DECISION_ROOM_INVALID');
  }
  if(d.status==='EVALUATED'){
    if(!t||!finite(d.score)||d.score<0||d.score>100||!stamp(d.evaluatedAt)||Date.parse(d.evaluatedAt??'')>now+30_000
      ||d.model!=='jev-1.13.0'||!/^([a-f0-9]{64})$/.test(d.inputHash??'')
      ||d.verdict!==(d.score>=60?'YES':d.score<=40?'NO':'WAIT'))throw Error('JEV_DECISION_SCORE_INVALID');
  }else if(d.verdict!=='WAIT'||d.score!==null||d.evaluatedAt!==null||d.model!==null||d.inputHash!==null)throw Error('JEV_DECISION_STATE_INVALID');
  return {revision:d.revision,status:d.status,verdict:d.verdict,score:d.score,evaluatedAt:d.evaluatedAt,model:d.model,inputHash:d.inputHash,reason:d.reason,entryQuality:quality,structure,
    target:t?{referencePrice:t.referencePrice,entryPrice:t.entryPrice,initialStop:t.initialStop,netOneRPrice:t.netOneRPrice,
      favorablePrice:t.favorablePrice,adversePrice:t.adversePrice,initialRiskPerUnit:t.initialRiskPerUnit,entryInterval:t.entryInterval,
      horizonMinutes:t.horizonMinutes,observedAt:t.observedAt,deadlineAt:t.deadlineAt,strategyRevision:t.strategyRevision,planId:t.planId,signalClosedAt:t.signalClosedAt,
      ...(d.revision!=='JEV-P5-PLAN-DECISION-1'?{oneHourLookbackBars:t.oneHourLookbackBars,oneHourExtremePrice:t.oneHourExtremePrice,oneHourRoomR:t.oneHourRoomR}:{}),
      ...(d.revision==='JEV-R221-IQ1-PRE-GATE-DECISION-1'?{entryQualityRevision:t.entryQualityRevision,executionRevision:t.executionRevision}:{})}:null};
}
