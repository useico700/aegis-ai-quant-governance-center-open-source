export type OutcomeStats = { n: number; hits: number; rate: number | null; interval: [number,number] | null; brier: number | null; meanP: number | null };
export type TradeStats = { n: number; meanNetR: number | null; sumNetR: number | null; drawdownR: number | null };
export type Research = {
  revision: string; asOf: string; account: 'S1'|'S2'; mode: 'OBSERVE_ONLY'; orderAuthority: false;
  total: number; independent: number; overlapping: number; pending: number; excludedEvidence: number; deferred: number;
  base: OutcomeStats; selected: OutcomeStats; excluded: OutcomeStats; retention: number | null;
  bins: (OutcomeStats & {from:number;to:number})[];
  calibration: {outOfSampleN:number; rawBrier:number|null; calibratedBrier:number|null};
  actual: {all:TradeStats;retained:TradeStats;omitted:TradeStats;open:number;unmatched:number;
    byManagementPolicy?:{revision:string;all:TradeStats;retained:TradeStats;omitted:TradeStats}[]};
  conclusion: 'ACCUMULATING'|'REVIEW_REQUIRED'; promotionAllowed: false;
  ledgerStatus: 'SYNCED'|'CATCHING_UP'|'HISTORY_CHANGED'|'UNAVAILABLE'; labelerStatus: 'RUNNING'|'RETRYING';
  latest: {key:string;symbol:string;direction:'LONG'|'SHORT';p:number|null;frozenAt:number;status:string;netR:number|null;tradeStatus:string}[];
};
const fail=():never=>{throw new Error('JEV_RESEARCH_INVALID');};
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const num=(v:unknown,min=-1e9,max=1e9):number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:fail();
const count=(v:unknown):number=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):fail();
const nullable=(v:unknown,min=-1e9,max=1e9)=>v===null?null:num(v,min,max);
const oneOf=<T extends string>(v:unknown,allowed:T[]):T=>allowed.includes(v as T)?v as T:fail();
const stats=(v:unknown):OutcomeStats=>{const r=obj(v),n=count(r.n),hits=count(r.hits);if(hits>n)fail();return {n,hits,rate:nullable(r.rate,0,1),interval:r.interval===null?null:Array.isArray(r.interval)&&r.interval.length===2?[num(r.interval[0],0,1),num(r.interval[1],0,1)]:fail(),brier:nullable(r.brier,0,1),meanP:nullable(r.meanP,0,1)};};
const trades=(v:unknown):TradeStats=>{const r=obj(v);return {n:count(r.n),meanNetR:nullable(r.meanNetR),sumNetR:nullable(r.sumNetR),drawdownR:nullable(r.drawdownR,0)};};
export function sanitizeResearch(value:unknown,account:'S1'|'S2',now:number):Research|null {
  if(value==null)return null;
  const r=obj(value),at=typeof r.asOf==='string'?Date.parse(r.asOf):NaN;
  if(!['JEV-PROSPECTIVE-REVIEW-1','JEV-P5-DECISION-REVIEW-2','JEV-P5-DECISION-REVIEW-3','JEV-P5-DECISION-REVIEW-4','JEV-P5-DECISION-REVIEW-5','JEV-R221-IQ1-PRE-GATE-REVIEW-1'].includes(String(r.revision))||r.account!==account||r.mode!=='OBSERVE_ONLY'||r.orderAuthority!==false||r.promotionAllowed!==false||!Number.isFinite(at)||at>now+30000||now-at>30*60000)fail();
  const c=obj(r.calibration),a=obj(r.actual);
  const byManagementPolicy=a.byManagementPolicy===undefined?[]:a.byManagementPolicy;
  if(!Array.isArray(byManagementPolicy)||byManagementPolicy.length>20)fail();
  if(!Array.isArray(r.bins)||r.bins.length!==5||!Array.isArray(r.latest)||r.latest.length>15)fail();
  if(r.revision==='JEV-P5-DECISION-REVIEW-5'&&account!=='S2')fail();
  if(r.revision==='JEV-R221-IQ1-PRE-GATE-REVIEW-1'&&account!=='S1')fail();
  return {revision:r.revision as string,asOf:new Date(at).toISOString(),account,mode:'OBSERVE_ONLY',orderAuthority:false,
    total:count(r.total),independent:count(r.independent),overlapping:count(r.overlapping),pending:count(r.pending),excludedEvidence:count(r.excludedEvidence),deferred:count(r.deferred),
    base:stats(r.base),selected:stats(r.selected),excluded:stats(r.excluded),retention:nullable(r.retention,0,1),
    bins:(r.bins as unknown[]).map((v,i)=>{const b=obj(v);if(Math.abs(num(b.from)-i*.2)>1e-9||Math.abs(num(b.to)-(i+1)*.2)>1e-9)fail();return {from:num(b.from),to:num(b.to),...stats(b)};}),
    calibration:{outOfSampleN:count(c.outOfSampleN),rawBrier:nullable(c.rawBrier,0,1),calibratedBrier:nullable(c.calibratedBrier,0,1)},
    actual:{all:trades(a.all),retained:trades(a.retained),omitted:trades(a.omitted),open:count(a.open),unmatched:count(a.unmatched),
      byManagementPolicy:(byManagementPolicy as unknown[]).map(value=>{const group=obj(value);if(typeof group.revision!=='string'||!/^[A-Z0-9_-]{1,100}$/.test(group.revision))fail();return {revision:group.revision as string,all:trades(group.all),retained:trades(group.retained),omitted:trades(group.omitted)};})},
    conclusion:oneOf(r.conclusion,['ACCUMULATING','REVIEW_REQUIRED']),promotionAllowed:false,
    ledgerStatus:oneOf(r.ledgerStatus,['SYNCED','CATCHING_UP','HISTORY_CHANGED','UNAVAILABLE']),labelerStatus:oneOf(r.labelerStatus,['RUNNING','RETRYING']),
    latest:(r.latest as unknown[]).map(v=>{const t=obj(v);if(typeof t.key!=='string'||!/^[a-f0-9]{64}$/.test(t.key)||typeof t.symbol!=='string'||!/^[A-Z]{2,12}USDT$/.test(t.symbol))fail();return {key:t.key as string,symbol:t.symbol as string,direction:oneOf(t.direction,['LONG','SHORT']),p:nullable(t.p,0,1),frozenAt:num(t.frozenAt,0,now+30000),
      status:oneOf(t.status,['PENDING','UNSCORED','FAVORABLE','ADVERSE','TIMEOUT','AMBIGUOUS','AMBIGUOUS_PAGE_BOUNDARY','PREDECISION_TOUCH','DATA_WINDOW_EXPIRED','DATA_GAP']),netR:nullable(t.netR),tradeStatus:oneOf(t.tradeStatus,['UNMATCHED','MISMATCH','PREEXISTING','STALE_PREDICTION','OPEN','CLOSED','ACCOUNTING_INCOMPLETE'])};})};
}
