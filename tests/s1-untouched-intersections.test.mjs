import test from 'node:test';
import assert from 'node:assert/strict';
import {geometricPairs,untouchedPxReview,UNTOUCHED_REVISION} from '../agents/orion-live/s1-scanner/intersection-geometry.mjs';
import {structuralPairs} from '../agents/orion-v2/paper/paper-engine.mjs';
import {findReviewedConvergencePlan} from '../agents/orion-live/s1-scanner/candidate-discovery.mjs';
import {reviewCandidateQueue} from '../agents/orion-live/s1-scanner/candidate-lifecycle.mjs';
import {fixture,hour,now} from './helpers/s1-candidate-lifecycle-fixture.mjs';

const bar=(t,w=hour/4,low=99,high=101)=>({openTime:t,closeTime:t+w-1,open:100,close:100,low,high});
const plan=(px=110)=>({intersectionPrice:px,intersectionTime:4*hour+hour/8,anchors:Array.from({length:4},()=>({confirmedAt:hour-1}))});
const fine=()=>Array.from({length:16},(_,i)=>bar(i*hour/4));

test('wick touch is inclusive; historical touches before causal eligibility do not consume Px',()=>{
 const b=fine();b[0].high=111;
 assert.equal(untouchedPxReview(plan(),[],b,4*hour).reason,null);
 b[5].high=110;
 assert.equal(untouchedPxReview(plan(),[],b,4*hour).reason,'PX_ALREADY_TOUCHED_BEFORE_CROSS');
});
test('missing coverage fails closed and mixed hourly/quarter-hour history joins without a gap',()=>{
 const coarse=[bar(0,hour),bar(hour,hour)],b=fine().slice(7);
 assert.equal(untouchedPxReview(plan(),coarse,b,4*hour).reason,null);
 assert.equal(untouchedPxReview(plan(),[],b,4*hour).reason,'PX_TOUCH_HISTORY_UNVERIFIED');
 assert.equal(untouchedPxReview(plan(),[],fine().filter((_,i)=>i!==9),4*hour).reason,'PX_TOUCH_HISTORY_UNVERIFIED');
});
test('touch inside cross bar cannot be attributed to before or after exact cross with OHLC',()=>{
 const b=[...fine(),bar(4*hour,hour/4,109,111)];
 assert.equal(untouchedPxReview(plan(),[],b,4.25*hour).reason,'PX_CROSS_BAR_TOUCH_ORDER_UNVERIFIED');
 b[16]=bar(4*hour,hour/4,111,112);
 assert.equal(untouchedPxReview(plan(),[],b,4.25*hour).reason,null);
});
test('causal touch start stays explicit rather than resetting when a pivot gains a higher hierarchy',()=>{
 const p={...plan(),touchStartAt:hour};p.anchors.forEach(a=>a.confirmedAt=2*hour-1);
 const b=fine();b[5].high=111;
 assert.equal(untouchedPxReview(p,[],b,4*hour).reason,'PX_ALREADY_TOUCHED_BEFORE_CROSS');
});
test('qualified anchor geometry survives intermediate wick penetration',()=>{
 const f=fixture(),policy=f.strategy.pivots.oneHour;
 const pivots=[{index:2,time:2*hour,coordinate15m:8,price:80,prominenceAbsolute:20,hierarchyMultiplier:1},{index:6,time:6*hour,coordinate15m:24,price:82,prominenceAbsolute:20,hierarchyMultiplier:1}];
 f.bars1h[3].low=70;
 assert.equal(structuralPairs(pivots,[{index:4}],f.bars1h,1,policy).length,0);
 assert.equal(geometricPairs(pivots,[{index:4}],f.bars1h,1,policy).length,1);
});
test('geometric discovery enumerates beyond pair cap while shared legacy default remains capped',()=>{
 const f=fixture();f.strategy.intersection.oneHourPairCandidates=0;
 assert.equal(findReviewedConvergencePlan(f),null);
 const r=reviewCandidateQueue(f);assert.equal(r.queue.length,1);assert.ok(r.diagnostics.testedPairs>0);
 assert.equal(r.queue[0].candidateGeometryRevision,UNTOUCHED_REVISION);
});
test('new policy can reassess old retired geometry without changing tombstones, but never its own consumed id',()=>{
 const f=fixture(),old=findReviewedConvergencePlan(f),retiredIds={[old.id]:now};
 const a=reviewCandidateQueue({...f,retiredIds});assert.equal(a.queue.length,1);assert.notEqual(a.queue[0].id,old.id);
 const b=reviewCandidateQueue({...f,retiredIds:{...retiredIds,[a.queue[0].id]:now}});assert.equal(b.queue.length,0);
 assert.deepEqual(retiredIds,{[old.id]:now});
});
