// Prospective target horizon. No R input: geometry determines the target first.
export const LEGACY_TARGET_POLICY_REVISION = 'SMC-TARGET-4H-1';
export const TARGET_POLICY_REVISION = 'SMC-TARGET-4H-2';
const H4 = 14400000;
const freshParent = (f,now) => f?.status==='READY' && Number.isFinite(f.availableAt) && f.availableAt<=now && now-f.availableAt<=H4+120000;
const point = p => p ? Object.fromEntries(['kind','price','time','confirmedAt','timeframe'].map(k => [k,p[k]])) : null;
export function supports4hTarget(frame, direction, entry, now) {
  const long = direction === 'LONG', p = frame?.protectedPoint;
  return frame?.status === 'READY' && frame.bias === (long ? 'BULLISH' : 'BEARISH')
    && Number.isFinite(frame.availableAt) && frame.availableAt <= now && now-frame.availableAt <= H4+120000
    && typeof frame.episodeId === 'string' && !!frame.episodeId
    && p?.kind === (long ? 'LOW' : 'HIGH') && Number.isFinite(p.price)
    && Number.isFinite(p.confirmedAt) && p.confirmedAt <= frame.availableAt
    && (long ? p.price < entry : p.price > entry);
}
// Keep the closed4H state intact. A confirmed15M episode can establish a
// tradable direction without pretending that the unfinished4H bar has closed.
export function targetDirectionSupport(frame, localFrame, direction, entry, now, revision = TARGET_POLICY_REVISION) {
  if (supports4hTarget(frame,direction,entry,now)) return '4H_ALIGNED';
  if (revision !== TARGET_POLICY_REVISION || frame?.status !== 'READY'
    || !Number.isFinite(frame.availableAt) || frame.availableAt > now || now-frame.availableAt > H4+120000) return null;
  const long=direction==='LONG',p=localFrame?.protectedPoint,e=localFrame?.lastExternalEvent;
  if (localFrame?.status!=='READY' || localFrame.bias!==(long?'BULLISH':'BEARISH')
    || !Number.isFinite(localFrame.availableAt) || localFrame.availableAt>now || now-localFrame.availableAt>1020000
    || typeof localFrame.episodeId!=='string' || !localFrame.episodeId
    || !['BOS','TREND_CONFIRMED'].includes(e?.type) || e.scope!=='EXTERNAL' || e.direction!==direction
    || e.episodeId!==localFrame.episodeId || !Number.isFinite(e.at) || e.at>localFrame.availableAt
    || p?.kind!==(long?'LOW':'HIGH') || !(p.price>0) || !Number.isFinite(p.confirmedAt)
    || p.confirmedAt>localFrame.availableAt || !(long?p.price<entry:p.price>entry)) return null;
  return '15M_CONFIRMED_TRANSITION';
}
const supportFrame = f => f ? {status:f.status,bias:f.bias,episodeId:f.episodeId,availableAt:f.availableAt,
  protectedPoint:point(f.protectedPoint),lastExternalEvent:f.lastExternalEvent ? {type:f.lastExternalEvent.type,
    scope:f.lastExternalEvent.scope,direction:f.lastExternalEvent.direction,at:f.lastExternalEvent.at,episodeId:f.lastExternalEvent.episodeId,level:f.lastExternalEvent.level,endpointAvailableAt:f.lastExternalEvent.endpointAvailableAt}:null}:null;
export function selectTargetHierarchy({ targets, frame, localFrame, direction, entry, now, tracked = null, revision = TARGET_POLICY_REVISION }) {
  const mode = targetDirectionSupport(frame,localFrame,direction,entry,now,revision);
  // Target horizon is independent of directional admission for v2. Even an
  // unconfirmed conditional plan receives a genuine4H target, never a forced
  //15M downgrade. Missing4H data cannot manufacture a target.
  const supported = revision===TARGET_POLICY_REVISION ? freshParent(frame,now) : !!mode;
  if(revision===TARGET_POLICY_REVISION && !supported) return {invalid:true};
  const scope = revision===TARGET_POLICY_REVISION ? '4H_MAIN' : tracked?.targetBasis?.scope ?? (supported ? '4H_MAIN' : '15M_LOCAL');
  if (scope === '4H_MAIN' && !supported) return { invalid: true };
  const eligible = targets.filter(p => p.timeframe === (scope === '4H_MAIN' ? '4H' : '15M'));
  let objective = eligible[0] ?? null;
  if (tracked?.objective) {
    objective = eligible.find(p => p.time === tracked.objective.time && p.price === tracked.objective.price) ?? null;
    // A new nearer major barrier cannot be silently crossed to keep the old R.
    if (!objective || scope === '4H_MAIN' && objective !== eligible[0]) return { invalid: true };
  }
  const long = direction === 'LONG';
  const obstacles = objective && scope === '4H_MAIN' ? targets.filter(p => p.timeframe === '15M'
    && (long ? p.price < objective.price : p.price > objective.price)).map(point) : [];
  return { objective, basis: { revision, scope,
    support: scope === '4H_MAIN' ? { bias:frame.bias, episodeId:frame.episodeId, availableAt:frame.availableAt,
      protectedPoint:point({...frame.protectedPoint,timeframe:'4H'}) } : null,
    ...(revision===TARGET_POLICY_REVISION ? {directionSupport:scope==='4H_MAIN'?{mode,parent:supportFrame(frame),local:supportFrame(localFrame)}:null}:{}),
    objective:point(objective), obstacles, obstacleRole:'REFERENCE_ONLY_NO_AUTOMATIC_PARTIAL_EXIT',
    selection:'NEAREST_UNSWEPT_WITHIN_STRUCTURAL_SCOPE_NO_R_INPUT' } };
}
export function validateTargetBasis(plan) {
  if (plan.targetPolicyRevision == null) return true; // Historical plans retain their original policy.
  const b=plan.targetBasis,long=plan.direction==='LONG';
  const valid=[LEGACY_TARGET_POLICY_REVISION,TARGET_POLICY_REVISION].includes(plan.targetPolicyRevision) && b?.revision===plan.targetPolicyRevision
    && ['4H_MAIN','15M_LOCAL'].includes(b.scope)
    && b.selection==='NEAREST_UNSWEPT_WITHIN_STRUCTURAL_SCOPE_NO_R_INPUT'
    && b.obstacleRole==='REFERENCE_ONLY_NO_AUTOMATIC_PARTIAL_EXIT'
    && JSON.stringify(b.objective)===JSON.stringify(plan.objective)
    && (!plan.objective || plan.objective.timeframe===(b.scope==='4H_MAIN'?'4H':'15M'))
    && Array.isArray(b.obstacles) && b.obstacles.length<=1500
    && b.obstacles.every(p=>p.timeframe==='15M'&&p.kind===(long?'HIGH':'LOW')&&Number.isFinite(p.price)
      && Number.isFinite(p.confirmedAt)&&p.confirmedAt<=plan.observedAt&&plan.objective
      && (long?p.price>plan.entry&&p.price<plan.objective.price:p.price<plan.entry&&p.price>plan.objective.price))
    && (b.scope==='4H_MAIN' ? (plan.targetPolicyRevision===LEGACY_TARGET_POLICY_REVISION
      ? supports4hTarget({status:'READY',...b.support},plan.direction,plan.entry,plan.observedAt)
      : !!b.directionSupport && freshParent(b.directionSupport.parent,plan.observedAt)
        && b.directionSupport.mode===targetDirectionSupport(b.directionSupport.parent,b.directionSupport.local,plan.direction,plan.entry,plan.observedAt))
      : b.support===null && b.obstacles.length===0);
  if(!valid)throw new Error('STRUCTURE_TARGET_POLICY_INVALID');
  return true;
}
