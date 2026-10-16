import { createHash } from 'node:crypto';
import { smcBars } from './smc-bar-evidence.mjs';

export const INTERSECTION_CLOCK_REVISION = 'SMC-INTERSECTION-CLOCK-1';
export const CLOCK_POLICY = Object.freeze({ sourcePair:['4h','15m'], scales:[8,16], coordinate:'LOG',
  prewatchMs:3600000, postWindowMs:7200000, clusterMs:14400000, maximumExtension:8, maximumSourceAgeMs:30*86400000 });
const widths = {'4h':14400000,'15m':900000};
const check = (x,c) => { if(!x) throw new Error(c); };
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,32);
const slope = s => (Math.log(s.p2)-Math.log(s.p1))/((s.t2-s.t1)/3600000);
const sourceKey = s => `${s.tf}:${s.n}:${s.direction}:${s.t1}`;
const geometryKey = s => [sourceKey(s),s.t1,s.p1,s.t2,s.p2];
export function solveIntersection(a,b,logarithmic=true) {
  if (![a.t1,a.t2,a.p1,a.p2,b.t1,b.t2,b.p1,b.p2].every(Number.isFinite)
    || a.t2<=a.t1 || b.t2<=b.t1 || Math.min(a.p1,a.p2,b.p1,b.p2)<=0) return null;
  const y = p => logarithmic ? Math.log(p):p;
  const ma=(y(a.p2)-y(a.p1))/((a.t2-a.t1)/3600000), mb=(y(b.p2)-y(b.p1))/((b.t2-b.t1)/3600000);
  if(Math.abs(ma-mb)<=Math.max(Math.abs(ma),Math.abs(mb),1e-12)*1e-10) return null;
  const hours=(y(b.p1)+mb*((a.t1-b.t1)/3600000)-y(a.p1))/(ma-mb);
  const tx=a.t1+hours*3600000, px=logarithmic?Math.exp(y(a.p1)+ma*hours):y(a.p1)+ma*hours;
  return Number.isFinite(tx)&&Number.isFinite(px)&&Math.abs(tx)<8e15&&Math.abs(px)<1e30 ? {tx,px}:null;
}
const push = (xs,x) => { xs.push(x); if(xs.length>80)xs.shift(); };
const extreme = (xs,from,until,side) => xs.filter(p=>p.t>from&&p.t<until).reduce((best,p)=>!best||side*(p.p-best.p)>0?p:best,null);
function emptyFrame(tf,n) { return {tf,n,lastAt:0,tail:[],highs:[],lows:[],wh:[],wl:[],families:[],consumed:[0,0],lastRoot:0,lastSide:0,atr:null,tr:[]}; }
function pivot(tail,n,side) {
  if(tail.length<n*2+1)return null;
  const i=tail.length-1-n,b=tail[i],field=side===1?'high':'low';
  // Strict unique extrema: flat/equal tops are not fabricated as independent swings.
  if(!tail.slice(i-n,i+n+1).every((p,j)=>j===n||side*(b[field]-p[field])>0))return null;
  return {t:b.openTime,p:b[field],k:tail.at(-1).closeTime+1};
}
function step(f,b,tick) {
  if(f.lastAt)check(b.openTime===f.lastAt,'INTERSECTION_SOURCE_GAP');
  const prev=f.tail.at(-1),tr=prev?Math.max(b.high-b.low,Math.abs(b.high-prev.close),Math.abs(b.low-prev.close)):b.high-b.low;
  const eq=Math.max(tick*2,(f.atr??0)*.02); // Same default tolerance as personal Pine.
  f.tr.push(tr);if(f.tr.length>14)f.tr.shift();
  f.atr=f.atr==null?(f.tr.length===14?f.tr.reduce((a,b)=>a+b,0)/14:null):(f.atr*13+tr)/14;
  f.tail.push(b);if(f.tail.length>f.n*2+1)f.tail.shift();f.lastAt=b.closeTime+1;
  const wn=Math.max(2,Math.floor(f.n/2));
  const ph=pivot(f.tail,f.n,1),pl=pivot(f.tail,f.n,-1),wh=pivot(f.tail,wn,1),wl=pivot(f.tail,wn,-1);
  f.families=f.families.filter(s=>s.direction*(b.close-s.protect.p)>=-eq);
  if(wh&&!wl)push(f.wh,wh);if(wl&&!wh)push(f.wl,wl);if(ph&&!pl)push(f.highs,ph);if(pl&&!ph)push(f.lows,pl);
  if(!ph&&!pl&&!wh&&!wl)return;
  for(const s of f.families) {
    const points=s.direction===1?f.lows:f.highs,witness=s.direction===1?f.wh:f.wl;
    const end=extreme(witness,s.frontier.t,f.lastAt,s.direction);
    const pull=end&&extreme(points,s.frontier.t,end.t,-s.direction);
    if(!pull||!end||pull.t<=s.frontier.t||end.t<=pull.t||s.direction*(end.p-s.frontier.p)<=eq
      ||s.direction*(pull.p-s.protect.p)<=eq||s.direction*(b.close-pull.p)<-eq)continue;
    s.middle=s.frontier;s.protect=pull;s.frontier=end;s.legs++;s.known=Math.max(pull.k,end.k);
    s.witnesses=[...s.witnesses,pull,end].slice(-16);
    const m=(Math.log(pull.p)-Math.log(s.p1))/((pull.t-s.t1)/3600000);
    if(s.direction*m>0&&(s.direction===1?m<slope(s):m>slope(s))) {s.t2=pull.t;s.p2=pull.p;s.k2=pull.k;}
  }
  for(const [slot,side] of [[0,1],[1,-1]]) {
    const points=side===1?f.lows:f.highs,witness=side===1?f.wh:f.wl;
    if(points.length<2)continue;
    const a=points.at(-2),z=points.at(-1);if(z.t<=f.consumed[slot]||side*(z.p-a.p)<=eq)continue;
    const middle=extreme(witness,a.t,z.t,side),end=middle&&witness.find(w=>w.t>z.t&&side*(w.p-middle.p)>eq);
    if(!end)continue;f.consumed[slot]=z.t;
    if(a.t<=f.lastRoot||side===f.lastSide&&f.families.some(s=>s.t1===f.lastRoot)||side*(b.close-z.p)<-eq)continue;
    const parent=f.families.at(-1);
    f.families.push({tf:f.tf,n:f.n,direction:side,t1:a.t,p1:a.p,k1:a.k,t2:z.t,p2:z.p,k2:z.k,
      known:Math.max(a.k,z.k,middle.k,end.k),started:f.lastAt,parent:parent?sourceKey(parent):null,depth:parent?parent.depth+1:0,
      protect:z,frontier:end,middle,legs:1,witnesses:[a,middle,z,end]});
    f.lastRoot=a.t;f.lastSide=side;
  }
  check(f.families.length<=64,'INTERSECTION_FAMILY_CAPACITY');
}
export function emptyIntersectionClock(symbol) { return {revision:INTERSECTION_CLOCK_REVISION,symbol,frames:{},events:{},windows:{},observedAt:0}; }
function eventQuality(e,now) {
 const extension=Math.max(0,(e.tx-e.h.t2)/(e.h.t2-e.h.t1),(e.tx-e.l.t2)/(e.l.t2-e.l.t1));
 const age=now-Math.min(e.h.t2,e.l.t2);
 return {extension,age,qualified:extension<=CLOCK_POLICY.maximumExtension&&age<=CLOCK_POLICY.maximumSourceAgeMs,
  scale:e.h.n+e.l.n,legs:e.h.legs+e.l.legs};
}
const better=(a,b,now)=> {
 const x=eventQuality(a,now),y=eventQuality(b,now);
 return Math.floor(x.extension/4)-Math.floor(y.extension/4)||Math.floor(x.age/(7*86400000))-Math.floor(y.age/(7*86400000))
  ||y.scale-x.scale||y.legs-x.legs||a.tx-b.tx||a.id.localeCompare(b.id);
};
export function validateIntersectionEvent(e) {
 check(e?.revision===INTERSECTION_CLOCK_REVISION&&e.h?.direction===-e.l?.direction,'INTERSECTION_EVENT_SCOPE');
 const solved=solveIntersection(e.h,e.l);
 check(solved&&Math.abs(solved.tx-e.tx)<.01&&Math.abs(solved.px-e.px)<Math.max(1e-9,Math.abs(e.px)*1e-12),'INTERSECTION_MATH_MISMATCH');
 check(e.h.tf==='4h'&&e.l.tf==='15m'&&[8,16].includes(e.h.n)&&[8,16].includes(e.l.n)
  &&e.knownAt>=Math.max(e.h.known,e.l.known)&&e.firstSeenAt>=e.knownAt,'INTERSECTION_CAUSALITY');
 for(const s of [e.h,e.l]) check(s.t1<s.t2&&s.k1>s.t1&&s.k2>s.t2&&s.known>=Math.max(s.k1,s.k2)
  &&s.t1%widths[s.tf]===0&&s.t2%widths[s.tf]===0&&s.k1%widths[s.tf]===0&&s.k2%widths[s.tf]===0
  &&s.k1>=s.t1+(s.n+1)*widths[s.tf]&&s.k2>=s.t2+(s.n+1)*widths[s.tf]
  &&s.legs>=1&&s.witnesses.length>=4&&s.direction*(s.p2-s.p1)>0,'INTERSECTION_SOURCE_PROOF');
 return true;
}
/** Persistent source families. Past OHLC reconstruction never backdates receipt. */
export function updateIntersectionClock({state,symbol,rows,tick,now}) {
 const next=structuredClone(state??emptyIntersectionClock(symbol)),updates=[];
 check(next.revision===INTERSECTION_CLOCK_REVISION&&next.symbol===symbol&&Number.isFinite(tick)&&tick>0,'INTERSECTION_CLOCK_SCOPE');
 const pending=[];
 for(const [tf,width] of Object.entries(widths)) {
  const bars=smcBars(rows[tf],width,now);
  for(const n of CLOCK_POLICY.scales) {
   const key=`${tf}:${n}`,f=next.frames[key]??=emptyFrame(tf,n);
   // Compare closed source overlap for OHLC revisions; volume revisions cannot change geometry.
   for(const old of f.tail) {
    const same=bars.find(b=>b.openTime===old.openTime);
    if(same)check(['open','high','low','close'].every(k=>same[k]===old[k]),'INTERSECTION_SOURCE_REVISION');
   }
   for(const b of bars.filter(b=>b.closeTime+1>f.lastAt))pending.push({key,b});
  }
 }
 pending.sort((a,b)=>a.b.closeTime-b.b.closeTime||a.key.localeCompare(b.key));
 for(const item of pending) {
  step(next.frames[item.key],item.b,tick);
  const high=Object.values(next.frames).filter(f=>f.tf==='4h').flatMap(f=>f.families),low=Object.values(next.frames).filter(f=>f.tf==='15m').flatMap(f=>f.families);
  for(const h of high)for(const l of low) {
   if(h.direction===l.direction)continue;
   const id=`JX-${digest([geometryKey(h),geometryKey(l)])}`;
   if(next.events[id])continue;
   const xy=solveIntersection(h,l);if(!xy||xy.px<=0||xy.tx<now-CLOCK_POLICY.postWindowMs)continue;
   const knownAt=Math.max(h.known,l.known,h.started,l.started);
   const e={revision:INTERSECTION_CLOCK_REVISION,id,...xy,h:structuredClone(h),l:structuredClone(l),knownAt,firstSeenAt:now};
   validateIntersectionEvent(e);next.events[id]=e;updates.push(e);
  }
 }
 for(const [id,e] of Object.entries(next.events))if(e.tx+ CLOCK_POLICY.postWindowMs<now)delete next.events[id];
 check(Object.keys(next.events).length<=10000,'INTERSECTION_EVENT_CAPACITY');
 // Select within fixed time clusters, then pin a representative at prewatch.
 // No exact coordinate averaging and no cancellation merely because price differs.
 const grouped=new Map();
 for(const e of Object.values(next.events)) {
  if(e.firstSeenAt>=e.tx||!eventQuality(e,now).qualified||e.tx<now||e.tx>now+CLOCK_POLICY.prewatchMs)continue;
  const bucket=String(Math.floor(e.tx/CLOCK_POLICY.clusterMs));
  if(!grouped.has(bucket))grouped.set(bucket,[]);grouped.get(bucket).push(e);
 }
 for(const [bucket,pool] of grouped) if(!next.windows[bucket]) {
  pool.sort((a,b)=>better(a,b,now));const e=pool[0];
  next.windows[bucket]={event:e,selectedAt:now,opensAt:e.tx,expiresAt:e.tx+CLOCK_POLICY.postWindowMs};
 }
 for(const [bucket,w] of Object.entries(next.windows))if(w.expiresAt<now)delete next.windows[bucket];
 next.observedAt=now;
 const windows=Object.values(next.windows).sort((a,b)=>a.opensAt-b.opensAt);
 return {state:next,updates,projection:{revision:INTERSECTION_CLOCK_REVISION,observedAt:now,coordinate:'LOG',
  policy:CLOCK_POLICY,sourceCoverage:Object.fromEntries(Object.entries(next.frames).map(([k,f])=>[k,{closedThrough:f.lastAt,activeFamilies:f.families.length}])),
  futureCount:Object.values(next.events).filter(e=>e.tx>now).length,windows,
  active:windows.find(w=>now>=w.opensAt&&now<=w.expiresAt)??null,probabilityStatus:'UNVALIDATED_PROSPECTIVE_FILTER',orderAuthority:false}};
}

export function sanitizeIntersectionClock(value,now) {
 if(value==null)return null;
 check(value.revision===INTERSECTION_CLOCK_REVISION&&value.coordinate==='LOG'&&value.orderAuthority===false
  &&Number.isFinite(value.observedAt)&&value.observedAt<=now+5000&&now-value.observedAt<=360000
  &&Number.isSafeInteger(value.futureCount)&&value.futureCount>=0&&value.futureCount<=10000
  &&Array.isArray(value.windows)&&value.windows.length<=4,'INTERSECTION_PROJECTION_INVALID');
 for(const w of value.windows) {
  validateIntersectionEvent(w.event);
  check(w.opensAt===w.event.tx&&w.expiresAt===w.opensAt+CLOCK_POLICY.postWindowMs
    &&Number.isFinite(w.selectedAt)&&w.selectedAt>=w.event.firstSeenAt&&w.selectedAt<w.opensAt,'INTERSECTION_WINDOW_INVALID');
 }
 const active=value.windows.find(w=>value.observedAt>=w.opensAt&&value.observedAt<=w.expiresAt)??null;
 check(JSON.stringify(value.active)===JSON.stringify(active),'INTERSECTION_ACTIVE_MISMATCH');
 return {revision:value.revision,observedAt:value.observedAt,coordinate:'LOG',futureCount:value.futureCount,
  windows:value.windows,active,probabilityStatus:'UNVALIDATED_PROSPECTIVE_FILTER',orderAuthority:false};
}
