import { hydrateS2ZState } from '../../agents/shared/s2-z-state-codec.mjs';
import { S2_Z_STRUCTURE_REVISION, validateS2ZPlanEvidence } from '../../agents/shared/s2-z-structure.mjs';
export { S2_Z_STRUCTURE_REVISION };
export const S2_Z_DECISION_REVISION='JEV-P5-PLAN-DECISION-4';
export const S2_Z_RESEARCH_REVISION='JEV-P5-DECISION-REVIEW-5';
export const usesS2Z=(account,policy)=>account==='S2'&&policy?.strategy?.structureRevision===S2_Z_STRUCTURE_REVISION;
export const isS2ZRow=(account,row)=>account==='S2'&&(row?.structureRevision===S2_Z_STRUCTURE_REVISION||row?.decision?.revision===S2_Z_DECISION_REVISION);
export function structureWaitText(reason) {
 if(reason==='S2_Z_STRUCTURE_REQUIRED')return '等待新的15分钟 Z 形态计划';
 if(reason==='S2_Z_NATIVE_EVIDENCE_GAP_OR_CONFLICT')return 'Z形态行情缺失或不一致，等待复核';
 if(reason==='S2_Z_CLOCK_INVALID')return 'Z形态时间证据待核对';
 if(['S2_Z_KEY_C_BROKEN_BEFORE_PX','S2_Z_1H_LINE_BROKEN_BEFORE_PX','S2_Z_15M_LINE_BROKEN_BEFORE_PX'].includes(reason))return '交点前原结构已破坏，等待新计划';
 return 'Z形态证据待核对';
}
export function checkS2Z(plan,now,bars15m,bars1h) {
 const result=validateS2ZPlanEvidence(plan,{now,bars15m,bars1h});
 return {...result,summary:{revision:S2_Z_STRUCTURE_REVISION,status:result.status,reason:result.reason,
  geometryHash:result.evidence?.geometryHash??null,checkedAt:now}};
}
export function compactZStructure(plan) {
 const z=plan?.zStructure;
 if(!z)return null;
 return {revision:plan.structureRevision,geometryHash:z.geometryHash,z:{interval:'15m',direction:z.z.direction,
  points:Object.fromEntries(Object.entries(z.z.points).map(([key,p])=>[key,{time:p.time,price:p.price,confirmedAt:p.confirmedAt}])),confirmedAt:z.z.confirmedAt},
  hourly:{interval:'1h',direction:z.hourly.direction,anchors:plan.anchors.slice(0,2).map(p=>({time:p.time,price:p.price,confirmedAt:p.confirmedAt}))},
  orderDirectionComesFrom:'5M_PX_FIRST_CLOSE',oneHourZRequired:false};
}

export function scannerPlans(account,state) {
 const source=account==='S2'?hydrateS2ZState(state):state;
 return new Map([...Object.values(source?.plans??{}),...Object.values(source?.planQueues??{}).flat()].map(plan=>[plan.id,plan]));
}

// Together with zStructure this reproduces the validator input independently
// of mutable scanner state. The public/model summary remains much smaller.
export function freezeStructureGeometry(plan) {
 return structuredClone(Object.fromEntries(['id','symbol','createdAt','pattern','anchors','fourHourLine','oneHourLine',
  'intersectionTime','intersectionPrice','lockedBarOpenTime','structureRevision'].map(key=>[key,plan[key]])));
}
