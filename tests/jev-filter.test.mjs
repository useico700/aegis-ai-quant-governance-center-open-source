import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, parseBars, buildMetrics, publicWeightWindow, questionFor, readAnswer, outcomeQuestionFor, readOutcomeAnswer, buildDirectionalLayer } from '../integrations/jev/filter-core.mjs';
import { sanitizePayload } from '../apps/jev-filter/lib/payload.ts';

const now=Date.parse('2026-09-20T12:45:00Z');
test('JEV public soft weight resets with the exchange minute and retains the same-minute ceiling',()=>{
 const high=publicWeightWindow(null,now,1500);
 assert.equal(high.usedWeight,1500);
 assert.equal(publicWeightWindow(high,now+1000,20).usedWeight,1500);
 assert.equal(publicWeightWindow(high,now+60_000).usedWeight,0);
 assert.equal(publicWeightWindow(high,now+60_000,23).usedWeight,23);
});
const makeBars=(interval,width)=>Array.from({length:40},(_,i)=>{
  const time=now-40*width+i*width;
  return [time,String(100+i*.1),String(101+i*.1),String(99+i*.1),String(100.5+i*.1),'100',time+width-1];
});
test('candidate selector stays account-scoped and keeps one current plan per symbol',()=>{
  const snapshot={accountLabel:'S1',mode:'SCAN_ONLY',sourceAsOf:new Date(now).toISOString(),marketQuotes:[{symbol:'BTCUSDT',bidPrice:'101',askPrice:'101.1'}],candidates:[
    {id:'old',symbol:'BTCUSDT',direction:'LONG',status:'WAITING_FIRST_PX_CLOSE',intersectionPrice:100,intersectionTime:new Date(now-1000).toISOString()},
    {id:'locked',symbol:'BTCUSDT',direction:'LONG',status:'FIRST_CLOSE_LOCKED',intersectionPrice:100,intersectionTime:new Date(now-1000).toISOString()},
    {id:'invalid',symbol:'ETHUSDT',direction:'SHORT',status:'INVALIDATED',intersectionPrice:100,intersectionTime:new Date(now-1000).toISOString()},
  ]};
  assert.deepEqual(selectCandidates(snapshot,now).map(x=>x.id),['locked']);
  assert.deepEqual(selectCandidates({...snapshot,candidates:[...snapshot.candidates,{id:'closer',symbol:'BTCUSDT',direction:'LONG',status:'WAITING_FIRST_PX_CLOSE',intersectionPrice:101,intersectionTime:new Date(now-1000).toISOString()}]},now).map(x=>x.id),['closer']);
  assert.deepEqual(selectCandidates({...snapshot,sourceAsOf:new Date(now-190000).toISOString()},now),[]);
});
test('only contiguous closed candles enter technical features',()=>{
  const raw=makeBars('15m',900000);
  const bars=parseBars(raw,'15m',now);
  assert.equal(bars.length,40);
  assert.equal(parseBars([...raw.slice(0,25),...raw.slice(26)],'15m',now),null);
  const metrics=buildMetrics({candidate:{account:'S1',direction:'LONG',px:100},bars:{'15m':bars,'1h':parseBars(makeBars('1h',3600000),'1h',now)},
    quote:{bid:'104',ask:'104.1'},ticker:{quoteVolume:'1000000',priceChangePercent:'2'},premium:{lastFundingRate:'0.0001'},openInterest:{openInterest:'100'},
    oiHistory:[{sumOpenInterestValue:'1000'},{sumOpenInterestValue:'1100'}],coin:{market_cap:100000000,fully_diluted_valuation:200000000,circulating_supply:50,total_supply:100}});
  assert.equal(metrics.marketCapUsd,100000000);assert.equal(metrics.fdvToCap,2);assert.equal(metrics.circulatingRatio,50);
  assert.equal(metrics.oiChangePct1h,10);assert.equal(metrics.fundingPct,.01);assert.ok(metrics.rsi14>0);
});
test('Jev response is a bounded four-way classification, never a win probability',()=>{
  assert.equal(questionFor('c0').type,'choice');
  const answer=readAnswer({type:'choice',choice:'focus',confidence:.8,probabilities:{focus:.8,watch:.1,caution:.05,insufficient:.05}});
  assert.equal(answer.choice,'focus');
  assert.equal(readAnswer({type:'choice',choice:'focus',confidence:1,probabilities:{focus:1}}),null);
});
test('directional probability layer is strategy-relative and bounded',()=>{
  assert.equal(outcomeQuestionFor('c0').type,'choice');
  const answer=readOutcomeAnswer({type:'choice',choice:'one_r_first',confidence:.7,probabilities:{one_r_first:.55,half_r_only:.25,stop_first:.1,timeout_chop:.1}});
  const layer=buildDirectionalLayer(answer,'2026-09-20T12:40:00.000Z');
  assert.equal(layer.status,'EVALUATED');
  assert.equal(layer.model,'jev-1.13.0');
  assert.ok(layer.p1R>40 && layer.p1R<60);
  assert.ok(layer.pStop>=0 && layer.pStop<=100);
  assert.ok(['EDGE','LEAN','FLAT','AVOID'].includes(layer.label));
  assert.equal(readOutcomeAnswer({type:'choice',choice:'one_r_first',confidence:.7,probabilities:{one_r_first:1}}),null);
});
test('published records are allowlisted and cannot carry trade authority or account data',()=>{
  const item={id:'plan-1',symbol:'BTCUSDT',direction:'LONG',stage:'LOCKED',px:100,intersectionTime:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),status:'EVALUATED',label:'FOCUS',confidence:.8,model:'jev-1.13.0',evaluatedAt:new Date(now).toISOString(),evidenceHash:'a'.repeat(64),
    directional:{schemaVersion:1,status:'EVALUATED',label:'EDGE',probabilityPct:62,p05R:73,p1R:62,pStop:22,pTimeout:16,evR:.31,confidence:.7,model:'jev-1.13.0',evaluatedAt:new Date(now).toISOString(),positionSize:'large'},
    metrics:{marketCapUsd:100000000},sources:{binanceAt:new Date(now).toISOString(),coingeckoAt:new Date(now).toISOString()},secret:'do-not-publish'};
  const record=sanitizePayload({schemaVersion:1,mode:'OBSERVE_ONLY',orderAuthority:false,account:'S1',asOf:new Date(now).toISOString(),sourceAsOf:new Date(now).toISOString(),observations:[item],accountBalance:123},now);
  assert.equal(record.observations[0].metrics.marketCapUsd,100000000);
  assert.equal(record.observations[0].directional.p1R,62);
  assert.doesNotMatch(JSON.stringify(record),/do-not-publish|accountBalance|positionSize/);
  assert.throws(()=>sanitizePayload({...record,orderAuthority:true},now),/JEV_SCOPE_INVALID/);
});

test('terminal stream deduplicates polling but retains successive observations and both accounts', async () => {
  const { mergeFeed, filterFeed } = await import('../apps/jev-filter/lib/feed.ts');
  const row = {id:'plan-1',symbol:'BTCUSDT',direction:'LONG',status:'EVALUATED',directional:{label:'EDGE',status:'EVALUATED'}};
  const first = {account:'S1',asOf:'2026-09-20T12:00:00.000Z',observations:[row]};
  const second = {...first,asOf:'2026-09-20T12:01:00.000Z'};
  const other = {...first,account:'S2',observations:[{...row,direction:'SHORT',directional:{label:'AVOID',status:'EVALUATED'}}]};
  const lines = mergeFeed(mergeFeed([], [second]), [first,other,second]);
  assert.equal(lines.length,3);
  assert.deepEqual(lines.map(r=>r.accountAsOf),[second.asOf,first.asOf,first.asOf]);
  assert.deepEqual(lines.map(r=>r.account),['S1','S1','S2']);
  assert.equal(filterFeed(lines,'S2','SHORT','AVOID','btc').length,1);
  assert.equal(filterFeed(lines,'S1','SHORT','ALL','').length,0);
  assert.equal(filterFeed(lines,'ALL','ALL','EDGE','eth').length,0);
  assert.equal(filterFeed(lines,'ALL','ALL','UNAVAILABLE','').length,0);
});
test('history cursor uses time and account to preserve simultaneous batches', async () => {
  const { parseCursor, cursorFor } = await import('../apps/jev-filter/lib/feed.ts');
  const row = {account:'S2',asOf:'2026-09-20T12:00:00.000Z'};
  assert.deepEqual(parseCursor(cursorFor(row)),row);
  assert.equal(parseCursor(null),null);
  for(const value of ['invalid','2026-09-20T12:00:00.000Z|S3',"2026-09-20T12:00:00.000Z|S1|extra"]) assert.throws(()=>parseCursor(value));
});

test('potential pool uses current fresh evidence, removes expired or missing candidates and ranks quality', async () => {
  const { buildPotentialPool } = await import('../apps/jev-filter/lib/potential.ts');
  const at = new Date(now).toISOString();
  const candidate = (id, overrides = {}) => ({id,symbol:'BTCUSDT',direction:'LONG',stage:'ARRIVED',px:100,observedAt:at,intersectionTime:at,status:'EVALUATED',label:'WATCH',evaluatedAt:at,
    directional:{status:'EVALUATED',p1R:60,pStop:20,evR:.3,confidence:.6,evaluatedAt:at},metrics:{pxDistancePct:1,ema20SlopePct:1,volumeRatio:1.2,marketCapUsd:1000},sources:{binanceAt:at,coingeckoAt:at},...overrides});
  const payload = (account,observations) => ({schemaVersion:1,mode:'OBSERVE_ONLY',orderAuthority:false,account,asOf:at,sourceAsOf:at,observations});
  const rows = [candidate('best'),candidate('duplicate'),candidate('weak',{symbol:'ETHUSDT',directional:{status:'EVALUATED',p1R:45,pStop:30,evR:.05,confidence:.6,evaluatedAt:at}}),candidate('caution',{symbol:'AAVEUSDT',label:'CAUTION'}),candidate('old',{symbol:'SOLUSDT',evaluatedAt:new Date(now-31*60_000).toISOString()})];
  const pool = buildPotentialPool({S1:payload('S1',rows)},now);
  assert.equal(pool.rows.length,2);
  assert.deepEqual(pool.rows.map(r=>r.tier),['EDGE','LEAN']);
  assert.equal(pool.rows[0].note,'优先复核入场条件');
  assert.equal(buildPotentialPool({S1:payload('S1',[])},now).rows.length,0);
  assert.equal(buildPotentialPool({S1:payload('S1',rows)},now+21*60_000).rows.length,0);
  assert.equal(buildPotentialPool({S1:payload('S1',[candidate('x',{sources:{binanceAt:null}})])},now).rows.length,0);
  assert.equal(buildPotentialPool({S1:payload('S1',[candidate('x',{metrics:{pxDistancePct:null}})])},now).rows.length,0);
  assert.equal(buildPotentialPool({S1:payload('S1',rows)},now-60_000).rows.length,0);
});
test('potential pool preserves account identity, flags opposing signals and avoids inventing entry approval', async () => {
  const { buildPotentialPool } = await import('../apps/jev-filter/lib/potential.ts');
  const at = new Date(now).toISOString();
  const row = {id:'plan',symbol:'BTCUSDT',direction:'LONG',stage:'UPCOMING',status:'EVALUATED',label:'FOCUS',evaluatedAt:at,directional:{status:'EVALUATED',p1R:60,pStop:20,evR:.3,confidence:.7,evaluatedAt:at},metrics:{pxDistancePct:3},sources:{binanceAt:at}};
  const p = (account,r) => ({account,mode:'OBSERVE_ONLY',orderAuthority:false,asOf:at,sourceAsOf:at,observations:[r]});
  const pool = buildPotentialPool({S1:p('S1',row),S2:p('S2',{...row,direction:'SHORT'})},now);
  assert.equal(pool.rows.length,2);
  assert.ok(pool.rows.every(r=>r.conflict && r.note==='先复核方向分歧'));
  assert.equal(buildPotentialPool({S1:p('S1',row)},now).rows[0].note,'等待交汇');
  assert.equal(buildPotentialPool({S1:p('S1',{...row,stage:'ARRIVED'})},now).rows[0].note,'等待靠近 Px');
  assert.equal(buildPotentialPool({S1:p('S1',{...row,stage:'ARRIVED',metrics:{pxDistancePct:-1}})},now).rows[0].note,'等待回到 Px 同侧');
});
