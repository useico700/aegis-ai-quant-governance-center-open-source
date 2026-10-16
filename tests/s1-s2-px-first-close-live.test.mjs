import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePxFirstClose, pxFirstCloseSignal, PX_FIRST_CLOSE_REVISION, R221_TWO_BAR_REVISION } from '../agents/shared/px-first-close.mjs';
import { SIMPLE_ADMISSION_REVISION, S2_THREE_PERCENT_ADMISSION_REVISION } from '../agents/shared/px-band-risk-only.mjs';
import { choosePlanQueue as chooseS1PlanQueue, resolveEntryConditionRace as resolveS1EntryConditionRace } from '../agents/orion-live/s1-scanner/engine.mjs';
import { choosePlanQueue as chooseS2PlanQueue, resolveEntryConditionRace as resolveS2EntryConditionRace } from '../agents/orion-live/s2-scanner/engine.mjs';

const I = 300000, T = 1800000000000;
const bar = (index, close) => ({ openTime: T + index * I, closeTime: T + (index + 1) * I - 1,
  open: close, high: close, low: close, close });
const plan = () => ({ id: 'plan-a', symbol: 'BTCUSDT', createdAt: T - I,
  intersectionTime: T + 1000, intersectionPrice: 100 });
const r221={entryMode:'TWO_BAR_CROSS_CLOSE_WITH_BUFFER',maximumDirectionDecisionBars:2,crossCloseBufferBps:5};

test('R22.1 accepts a far first decision close without a Px distance gate',()=>{
 const updated=advancePxFirstClose(plan(),[bar(0,104)],T+I,r221),signal=pxFirstCloseSignal(updated);
 assert.equal(updated.pxEntryState.revision,R221_TWO_BAR_REVISION);
 assert.equal(signal.accepted,true);assert.equal(signal.direction,1);assert.equal(signal.route,'R221_TWO_BAR_CLOSE');
});

test('R22.1 gives the buffer exactly two decision bars then expires',()=>{
 const first=advancePxFirstClose(plan(),[bar(0,100.01)],T+I,r221);
 assert.equal(pxFirstCloseSignal(first).accepted,false);assert.equal(first.pxEntryState.decisionBarsProcessed,1);
 const second=advancePxFirstClose(first,[bar(1,99.99)],T+2*I,r221),signal=pxFirstCloseSignal(second);
 assert.equal(signal.accepted,false);assert.equal(signal.terminal,true);assert.equal(signal.reason,'R221_TWO_BAR_DIRECTION_EXPIRED');
});

test('far plan waits without expiry and locks the first directional pullback close', () => {
  const first = advancePxFirstClose(plan(), [bar(0, 104), bar(1, 103)], T + 2 * I);
  assert.equal(pxFirstCloseSignal(first).accepted, false);
  assert.equal(first.pxEntryState.direction, 1);
  const muchLater = advancePxFirstClose(first, [bar(20, 101.6)], T + 21 * I);
  const signal = pxFirstCloseSignal(muchLater);
  assert.equal(signal.accepted, true);
  assert.equal(signal.route, 'FIRST_PULLBACK');
  assert.equal(muchLater.pxEntryState.revision, PX_FIRST_CLOSE_REVISION);
});

test('near plan locks directly and later closes cannot mint another opportunity', () => {
  const locked = advancePxFirstClose(plan(), [bar(0, 101), bar(1, 101.5)], T + 2 * I);
  const id = locked.pxEntryState.opportunity.id;
  const replayed = advancePxFirstClose(locked, [bar(2, 101.2)], T + 3 * I);
  assert.equal(replayed.pxEntryState.opportunity.id, id);
  assert.equal(pxFirstCloseSignal(replayed).route, 'DIRECT_NEAR_PX');
});

test('P5 first-close route follows each account band and never asserts a pullback', () => {
  const s2Policy = { entryAdmissionRevision: S2_THREE_PERCENT_ADMISSION_REVISION };
  const s1Policy = { entryAdmissionRevision: SIMPLE_ADMISSION_REVISION };
  const s2 = advancePxFirstClose(plan(), [bar(0, 102.5)], T + I, s2Policy);
  const s1 = advancePxFirstClose(plan(), [bar(0, 102.5)], T + I, s1Policy);
  assert.equal(pxFirstCloseSignal(s2).route, 'DIRECT_NEAR_PX');
  assert.equal(pxFirstCloseSignal(s1).route, 'FIRST_CLOSE_OUTSIDE_BAND');
  assert.equal(pxFirstCloseSignal(advancePxFirstClose(plan(), [bar(0, 103.1)], T + I, s2Policy)).route, 'FIRST_CLOSE_OUTSIDE_BAND');
  const recorded = { ...s2, pxEntryState: { ...s2.pxEntryState,
    route: 'FIRST_PULLBACK', opportunity: { ...s2.pxEntryState.opportunity, route: 'FIRST_PULLBACK' } } };
  assert.equal(pxFirstCloseSignal(recorded).route, 'DIRECT_NEAR_PX');
  assert.equal(pxFirstCloseSignal(recorded).opportunityId, s2.pxEntryState.opportunity.id);
  assert.equal(recorded.pxEntryState.opportunity.route, 'FIRST_PULLBACK');
});

test('reverse completed close invalidates before or after a locked opportunity', () => {
  for (const closes of [[104, 99], [101, 99]]) {
    const updated = advancePxFirstClose(plan(), closes.map((close, index) => bar(index, close)), T + closes.length * I);
    const signal = pxFirstCloseSignal(updated);
    assert.equal(signal.accepted, false);
    assert.equal(signal.terminal, true);
    assert.equal(signal.reason, 'REVERSE_PX_CLOSE');
  }
});

test('each plan owns independent Px state', () => {
  const old = advancePxFirstClose(plan(), [bar(0, 104)], T + I);
  const same = { ...plan(), pxEntryState: old.pxEntryState };
  assert.equal(same.pxEntryState.direction, 1);
  const next = advancePxFirstClose({ ...plan(), id: 'plan-b', intersectionTime: T + I + 1000 }, [bar(1, 99)], T + 2 * I);
  assert.equal(next.pxEntryState.planId, 'plan-b');
  assert.equal(next.pxEntryState.direction, -1);
});

test('S1 and S2 retain an entry-ready incumbent when a newer structure appears', () => {
  for (const choosePlanQueue of [chooseS1PlanQueue, chooseS2PlanQueue]) {
    const old = advancePxFirstClose(plan(), [bar(0, 101)], T + I);
    const newer = { ...plan(), id: 'plan-b', createdAt: T + I, intersectionTime: T + I + 1000 };
    const queue = choosePlanQueue([old], newer, T + 2 * I, {});
    assert.deepEqual(queue.map(row => row.id), ['plan-a', 'plan-b']);
    assert.equal(pxFirstCloseSignal(queue[0]).accepted, true);
    assert.equal(queue[1].pxEntryState, undefined);
  }
});

test('S1 and S2 retire only an older waiting plan when a newer plan locks entry first', () => {
  for (const resolveEntryConditionRace of [resolveS1EntryConditionRace, resolveS2EntryConditionRace]) {
    const oldWaiting = advancePxFirstClose(plan(), [bar(0, 104)], T + I);
    const newerReady = advancePxFirstClose({ ...plan(), id: 'plan-b', createdAt: T,
      intersectionTime: T + 1000 }, [bar(0, 101)], T + I);
    assert.deepEqual(resolveEntryConditionRace([oldWaiting, newerReady]).map(row => row.id), ['plan-b']);
  }
});

test('S1 and S2 keep both plans while the newer plan has not reached entry', () => {
  for (const resolveEntryConditionRace of [resolveS1EntryConditionRace, resolveS2EntryConditionRace]) {
    const oldWaiting = advancePxFirstClose(plan(), [bar(0, 104)], T + I);
    const newerWaiting = advancePxFirstClose({ ...plan(), id: 'plan-b', createdAt: T,
      intersectionTime: T + 1000 }, [bar(0, 104)], T + I);
    assert.deepEqual(resolveEntryConditionRace([oldWaiting, newerWaiting]).map(row => row.id), ['plan-a', 'plan-b']);
  }
});

test('S1 and S2 keep an older ready opportunity when a newer plan also becomes ready', () => {
  for (const resolveEntryConditionRace of [resolveS1EntryConditionRace, resolveS2EntryConditionRace]) {
    const oldReady = advancePxFirstClose(plan(), [bar(0, 101)], T + I);
    const newerReady = advancePxFirstClose({ ...plan(), id: 'plan-b', createdAt: T,
      intersectionTime: T + 1000 }, [bar(0, 101.5)], T + I);
    assert.deepEqual(resolveEntryConditionRace([oldReady, newerReady]).map(row => row.id), ['plan-a', 'plan-b']);
  }
});
