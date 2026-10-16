import test from 'node:test';
import assert from 'node:assert/strict';
import { directionDecision,createTrade,advanceMinute,netAt,priceAtNetR,chooseTarget,validateBars,QUARTER } from './strategy.mjs';
const policy={feeRate:.0005,slippageRate:.0002,fundingReserveRate:.0003,minimumNetR:3,maxCostR:.12,entry:'MODEL'};
function trade(variant='F1',direction='LONG') {
 const sign=direction==='LONG'?1:-1;
 return createTrade({plan:{id:'x',symbol:'BTCUSDT'},decision:{direction,stop:100-sign*10},target:{target:100+sign*40,riskPerUnit:10.163,netR:3.8},entry:100,enteredAt:60000,policy,variant});
}
test('cost-inclusive protection solves net 0R and +1R for both directions',()=>{
 for(const d of ['LONG','SHORT'])for(const r of [0,1,2]){const t=trade('F1',d);assert.ok(Math.abs(netAt(t,priceAtNetR(t,r))/t.riskPerUnit-r)<1e-10);}
});
test('both stop and target inside a minute are uncertain, never counted as profit',()=>{
 const t=advanceMinute(trade(),{openTime:60000,closeTime:119999,open:100,high:145,low:85,close:110});assert.equal(t.status,'PATH_UNCERTAIN');assert.equal(t.netR,null);
});
test('stop gap is priced at observed opening price',()=>{
 const t=advanceMinute(trade(),{openTime:60000,closeTime:119999,open:85,high:88,low:83,close:86});assert.equal(t.status,'CLOSED');assert.equal(t.events[0].price,85);assert.ok(t.netR<-1);
});
test('a new protection hit in only one ordering remains uncertain',()=>{
 const t=advanceMinute(trade(),{openTime:60000,closeTime:119999,open:100,high:112,low:99,close:111});assert.equal(t.status,'PATH_UNCERTAIN');
});
test('missing minute blocks and cannot jump to a favorable later quote',()=>{
 const t=advanceMinute(trade(),{openTime:120000,closeTime:179999,open:140,high:145,low:130,close:140});assert.equal(t.status,'DATA_GAP');assert.equal(t.netR,null);
});
test('first direction lock failing micro structure cannot change to second direction',()=>{
 const bars=Array.from({length:34},(_,i)=>({openTime:i*QUARTER,closeTime:(i+1)*QUARTER-1,open:100,high:101,low:99,close:100}));
 bars[32].close=101;bars[33].close=98;
 const d=directionDecision({intersectionTime:32*QUARTER+120000,intersectionPrice:100},bars,34*QUARTER,.01);
 assert.equal(d.direction,'LONG');assert.equal(d.confirmedAt,bars[32].closeTime);assert.equal(d.state,'NO_CONFIRMED_MICRO_LEVEL');
});
test('unclosed future micro pivots cannot qualify earlier confirmation',()=>{
 const bars=Array.from({length:40},(_,i)=>({openTime:i*QUARTER,closeTime:(i+1)*QUARTER-1,open:100,high:101,low:99,close:i===32?102:100}));
 const plan={intersectionTime:32*QUARTER+120000,intersectionPrice:100};
 const a=directionDecision(plan,bars,33*QUARTER,.01);bars[37].high=1000;
 assert.deepEqual(directionDecision(plan,bars,33*QUARTER,.01),a);
});
test('invalid and noncontiguous OHLC fail closed',()=>{
 assert.throws(()=>validateBars([{openTime:0,closeTime:59999,open:10,high:9,low:8,close:9}],60000),/INVALID/);
});
test('missing 4H history never falls back to a smaller target timeframe',()=>{
 assert.equal(chooseTarget({bars4h:[],policy}).state,'NO_4H_HISTORY');
});
