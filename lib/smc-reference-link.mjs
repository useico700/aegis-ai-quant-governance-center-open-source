// Presentation contract only. Never promotes, rejects or submits an order.
import { planFamilyKey } from './smc-plan-lifecycle.mjs';
export const SMC_LINK_REVISION = 'SMC-LINK-1';
const frames = ['4h', '1h', '15m', '5m'];
const direction = bias => bias === 'BULLISH' ? 'LONG' : bias === 'BEARISH' ? 'SHORT' : null;

export function linkedStructure(context, now = Date.now()) {
  const selected = context?.timeframeProfile === 'SMC-4H15M-1' ? ['4h','15m'] : frames;
  const rows = selected.map(timeframe => {
    const frame = context?.frames?.[timeframe];
    const known = frame?.status === 'READY' && Number.isFinite(frame.availableAt) && frame.availableAt <= now;
    return { timeframe, direction: known ? direction(frame.bias) : null };
  });
  const index = rows.findIndex(row => row.direction);
  const primary = rows[index];
  return { revision: SMC_LINK_REVISION, direction: primary?.direction ?? null, timeframe: primary?.timeframe ?? null,
    higherUnconfirmed: index < 0 ? selected.slice() : rows.slice(0, index).map(row => row.timeframe),
    opposingFrames: primary ? rows.slice(index + 1).filter(row => row.direction && row.direction !== primary.direction).map(row => row.timeframe) : [],
    orderAuthority: false };
}

// The preserved protection/episode is the main state of this detector, not a
// claim that its 2x2 pivots equal Pine's separately scaled external pivots.
export function linkedLayers(context, timeframe, now = Date.now()) {
  const row = context?.frames?.[timeframe];
  const known = row?.status === 'READY' && Number.isFinite(row.availableAt) && row.availableAt <= now;
  const main = known ? direction(row.bias) : null;
  const internal = known ? direction(row.sequence?.bias) : null;
  const state = !known ? '数据不可用' : row.bias === 'TRANSITION' ? '外部保护已破 · 待反转确认'
    : !main ? '外部主方向未定' : internal && internal !== main ? '内部反向 · 回调/反转预警'
      : internal ? '内外同向' : row.sequence?.bias === 'RANGE' ? '内部整理 · 主结构保留' : '内部待确认';
  const event = known ? row.lastEvent?.type : null;
  return { timeframe, mainDirection: main, internalDirection: internal, state,
    mainBias: known ? row.bias : 'UNKNOWN', internalBias: known ? row.sequence?.bias ?? 'UNKNOWN' : 'UNKNOWN',
    protectedPrice: main && Number.isFinite(row.protectedPoint?.price) ? row.protectedPoint.price : null,
    labels: known ? (row.sequence?.labels ?? []).map(p => p.label).slice(-6) : [],
    eventRole: event === 'INTERNAL_BREAK' ? '内部突破 · 不改主方向' : event === 'CHOCH' ? '外部保护破坏 · 过渡'
      : event === 'TREND_CONFIRMED' ? '主趋势确认' : event === 'BOS' ? '主方向延续' : '暂无确认事件',
    externalBoundary: known && Number.isFinite(row.externalBoundary?.price) ? row.externalBoundary.price : null,
    model: 'SMC-CONTEXT-2:2x2-held-external-boundary', orderAuthority: false };
}

export function linkedPlanLabel(context, planDirection, now = Date.now(), plan = null) {
  if(plan?.targetPolicyRevision==='SMC-TARGET-4H-2' && plan.direction===planDirection) {
    const mode=plan.targetBasis?.directionSupport?.mode;
    if(mode==='15M_CONFIRMED_TRANSITION') return '15M转向已确认 · 4H背景保留';
    if(mode==='4H_ALIGNED') return '顺4H方向 · 等待入场确认';
    return '方向待确认 · 4H目标参考';
  }
  const state = linkedStructure(context, now);
  const relation = !state.direction ? '方向未定' : state.direction === planDirection ? '顺主方向' : '逆主方向 · 待反转';
  return `${relation}${state.timeframe ? `（${state.timeframe.toUpperCase()}）` : ''}`;
}

export function rankLinkedPlans(plans, context, now = Date.now()) {
  const state = linkedStructure(context, now);
  const r = p => Number.isFinite(p.netR) ? p.netR : -Infinity;
  const active=p=>p.targetPolicyRevision==='SMC-TARGET-4H-2' && !!p.targetBasis?.directionSupport?.mode;
  return [...plans].sort((a, b) => Number(active(b))-Number(active(a)) || Number(b.targetBasis?.directionSupport?.mode==='15M_CONFIRMED_TRANSITION')-Number(a.targetBasis?.directionSupport?.mode==='15M_CONFIRMED_TRANSITION') || Number(b.direction === state.direction) - Number(a.direction === state.direction)
    || r(b) - r(a) || a.id.localeCompare(b.id));
}

// A watchlist selection hides only that direction, never the opposite plan.
/**
 * @param {Array<object>} plans
 * @param {object | null | undefined} context
 * @param {{manual?: Array<{symbol: string, direction: string}>, executable?: Array<{symbol: string, direction: string}>, dismissed?: boolean, dismissedPlanKeys?: Array<string>, now?: number}} options
 */
export function visibleLinkedPlans(plans, context, { manual = [], executable = [], dismissed = false, dismissedPlanKeys = [], now = Date.now() } = {}) {
  if (dismissed) return [];
  return rankLinkedPlans(plans.filter(p => p.target != null && p.expiresAt > now && !dismissedPlanKeys.includes(planFamilyKey(p))
    && ![...manual, ...executable].some(row => row.symbol === p.symbol && row.direction === p.direction)), context, now);
}

// Only a matching main-direction plan belongs in the default decision list.
// A higher countertrend R never manufactures a preferred trading direction.
export function primaryLinkedPlan(plans, context, now = Date.now()) {
  const current=rankLinkedPlans(plans,context,now).find(p=>p.targetPolicyRevision==='SMC-TARGET-4H-2' && !!p.targetBasis?.directionSupport?.mode);
  if(current) return current;
  const state = linkedStructure(context, now);
  return state.direction ? rankLinkedPlans(plans, context, now).find(p => p.direction === state.direction) ?? null : null;
}
