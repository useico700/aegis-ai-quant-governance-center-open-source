export type ShadowEvent={at:number;type:string;reason?:string;price?:number;quantity?:number;pnl?:number;fee?:number;remaining?:number;stop?:number;risk?:number;detail?:string};
export type ShadowRow={key:string;account:'S1'|'S2';planId:string;symbol:string;direction:'LONG'|'SHORT';tier:'EDGE'|'LEAN'|'YES';selectedAt:number;state:string;reason:string;eligible:boolean;px:number;policyHash:string;selection:{p1R?:number;pStop?:number;evR?:number;score?:number|null;decisionScore?:number;decisionRevision?:string;evidenceHash:string|null};position:null|{entry:number;quantity:number;originalQuantity:number;remainingPct:number;initialStop:number;stop:number;openedAt:number;closedAt:number|null;realized:number;unrealized:number|null;risk:number;fees:number;funding:number;fundingComplete:boolean;stage:string;fundingAsOf?:number;fundingPending?:boolean;managementRevision?:string;firstHarvest?:{r:number;floorR:number;targetPrice:number|null;referencePrice:number|null}|null;profitRetention?:{peakNetR:number;floorR:number;revision:string}|null};events:ShadowEvent[]};
export type Shadow={schemaVersion:1;revision:string;mode:'SHADOW_ONLY';orderAuthority:false;asOf:string;startedAt:string;health:string;costs:{takerFeeRate:number;adverseSlippageRate:number};initialEquity:number;accounts:{account:'S1'|'S2';selected:number;waiting:number;open:number;closed:number;valid:number;gaps:number;equity:number|null;realized:number;unrealized:number|null;netR:number;winRate:number|null;initialStops:number;runnerCount:number}[];rows:ShadowRow[]};
const num=(v:unknown):number=>{if(typeof v!=='number'||!Number.isFinite(v))throw Error('SHADOW_NUMBER');return v;};
const str=(v:unknown,max=220):string=>{if(typeof v!=='string'||v.length>max)throw Error('SHADOW_TEXT');return v;};
const nullable=(v:unknown)=>v===null?null:num(v);
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('SHADOW_OBJECT');return v as Record<string,unknown>;};
const choose=<T extends string>(v:unknown,allowed:T[]):T=>{if(!allowed.includes(v as T))throw Error('SHADOW_ENUM');return v as T;};
const boolean=(v:unknown)=>{if(typeof v!=='boolean')throw Error('SHADOW_BOOL');return v;};
const numbers=(o:Record<string,unknown>,ks:string[])=>Object.fromEntries(ks.map(k=>[k,num(o[k])]));
export function sanitizeShadow(input:unknown,now=Date.now()):Shadow {
 const o=record(input);if(o.schemaVersion!==1||o.mode!=='SHADOW_ONLY'||o.orderAuthority!==false||o.revision!=='JEV-POOL-SHADOW-1')throw Error('SHADOW_SCOPE');
 const asOf=str(o.asOf),startedAt=str(o.startedAt);if(!Number.isFinite(Date.parse(asOf))||Math.abs(now-Date.parse(asOf))>120000||!(Date.parse(startedAt)<=Date.parse(asOf)))throw Error('SHADOW_TIME');
 const costs=record(o.costs);if(num(costs.takerFeeRate)!==.0005||num(costs.adverseSlippageRate)!==.0005||o.initialEquity!==10000)throw Error('SHADOW_POLICY');
 if(!Array.isArray(o.accounts)||o.accounts.length!==2||!Array.isArray(o.rows)||o.rows.length>200)throw Error('SHADOW_ROWS');
 const accounts=o.accounts.map(v=>{const a=record(v);return {account:choose(a.account,['S1','S2']),...numbers(a,['selected','waiting','open','closed','valid','gaps','realized','netR','initialStops','runnerCount']),equity:nullable(a.equity),unrealized:nullable(a.unrealized),winRate:nullable(a.winRate)};});
 if(new Set(accounts.map(a=>a.account)).size!==2)throw Error('SHADOW_ACCOUNTS');
 const rows=o.rows.map(v=>{
  const r=record(v),s=record(r.selection);if(!Array.isArray(r.events)||r.events.length>30)throw Error('SHADOW_EVENTS');
  const account=choose(r.account,['S1','S2']),currentManagementRevision=`${account}-P5-AGGREGATE-NET-PROFIT-LOCK-1`,adaptiveRevision=`${account}-P5-ADAPTIVE-FIRST-HARVEST-1`;
  const p=r.position===null?null:record(r.position);
  const managementRevision=p?.managementRevision===undefined?'R22-LEGACY':choose(p.managementRevision,['R22-LEGACY',currentManagementRevision,adaptiveRevision]);
  const lock=p?.profitRetention==null?null:record(p.profitRetention);
  const profitRetention=lock?{peakNetR:num(lock.peakNetR),floorR:num(lock.floorR),revision:choose(lock.revision,[currentManagementRevision,adaptiveRevision])}:null;
  if(profitRetention&&(managementRevision!==profitRetention.revision||profitRetention.peakNetR<0||profitRetention.floorR<0))throw Error('SHADOW_PROFIT_POLICY');
  const h=p?.firstHarvest==null?null:record(p.firstHarvest);
  const firstHarvest=h?{r:num(h.r),floorR:num(h.floorR),targetPrice:nullable(h.targetPrice),referencePrice:nullable(h.referencePrice)}:null;
  if(firstHarvest&&(managementRevision!==adaptiveRevision||firstHarvest.r<0||firstHarvest.r>.5
    ||Math.abs(firstHarvest.floorR-firstHarvest.r*.3)>1e-12
    ||[firstHarvest.targetPrice,firstHarvest.referencePrice].some(n=>n!==null&&n<=0)
    ||(firstHarvest.targetPrice===null)!==(firstHarvest.referencePrice===null)))throw Error('SHADOW_FIRST_HARVEST');
  const tier=choose(r.tier,['EDGE','LEAN','YES']);
  const selection=tier==='YES'?{decisionScore:num(s.decisionScore),decisionRevision:choose(s.decisionRevision,['JEV-P5-PLAN-DECISION-1','JEV-P5-PLAN-DECISION-2','JEV-P5-PLAN-DECISION-3','JEV-P5-PLAN-DECISION-4','JEV-R221-IQ1-PRE-GATE-DECISION-1']),evidenceHash:s.evidenceHash===null?null:str(s.evidenceHash,64)}
    :{p1R:num(s.p1R),pStop:num(s.pStop),evR:num(s.evR),score:nullable(s.score),evidenceHash:s.evidenceHash===null?null:str(s.evidenceHash,64)};
  if(selection.decisionRevision==='JEV-P5-PLAN-DECISION-4'&&r.account!=='S2')throw Error('SHADOW_STRUCTURE_ACCOUNT');
  if(tier==='YES'&&(selection.decisionScore===undefined||selection.decisionScore<60||selection.decisionScore>100))throw Error('SHADOW_DECISION_SCORE');
  return {key:str(r.key),account:choose(r.account,['S1','S2']),planId:str(r.planId),symbol:choose(r.symbol,['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ZECUSDT','HYPEUSDT','LINKUSDT','AAVEUSDT']),direction:choose(r.direction,['LONG','SHORT']),tier,selectedAt:num(r.selectedAt),state:choose(r.state,['WAITING','OUT_OF_POOL','INVALIDATED','OPEN','CLOSED']),reason:str(r.reason,100),eligible:boolean(r.eligible),px:num(r.px),policyHash:str(r.policyHash,64),selection,
   position:p?{...numbers(p,['entry','quantity','originalQuantity','remainingPct','initialStop','stop','openedAt','realized','risk','fees','funding']),closedAt:nullable(p.closedAt),unrealized:nullable(p.unrealized),fundingComplete:boolean(p.fundingComplete),stage:choose(p.stage,['INITIAL','SOFT','ONE_R','RUNNER']),managementRevision,profitRetention,firstHarvest,...(p.fundingAsOf===undefined?{}:{fundingAsOf:num(p.fundingAsOf)}),...(p.fundingPending===undefined?{}:{fundingPending:boolean(p.fundingPending)})}:null,
   events:r.events.map(v=>{const e=record(v);const out:ShadowEvent={at:num(e.at),type:choose(e.type,['SELECTED','OPEN','REDUCE','CLOSE','STOP_MOVE','FUNDING','ZERO_LOT_STAGE','DATA_GAP','INVALIDATED','POLICY_SYNC'])};for(const k of ['reason','detail'] as const)if(e[k]!==undefined)out[k]=str(e[k]);for(const k of ['price','quantity','pnl','fee','remaining','stop','risk'] as const)if(e[k]!==undefined)out[k]=num(e[k]);return out;})};
 });
 return {schemaVersion:1,revision:'JEV-POOL-SHADOW-1',mode:'SHADOW_ONLY',orderAuthority:false,asOf,startedAt,health:str(o.health,50),costs:{takerFeeRate:.0005,adverseSlippageRate:.0005},initialEquity:10000,accounts,rows} as Shadow;
}
