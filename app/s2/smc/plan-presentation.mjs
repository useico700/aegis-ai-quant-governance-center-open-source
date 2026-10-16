// Presentation only. These values never authorize an order or alter a plan.
/** @param {import('./types').StructurePlan | null | undefined} plan */
export const planProtectionReady = plan => !!plan && plan.stopBasis?.ready === true
  && plan.stopBasis.entryValid !== false && Number.isFinite(plan.stopBasis.point?.price) && Number(plan.stopBasis.point?.price) > 0;
/** @param {import('./types').StructurePlan | null | undefined} plan */
export const planProtectionLabel = plan => plan?.stopBasis?.entryValid === false ? "入场已越保护点" : "结构保护待确认";
const validPrice = value => Number.isFinite(value) && value > 0;
const pathLabels = {
  APPROACHING_OPPOSING_4H_POI: "前方4H反向FVG · 目标取近侧边界",
  INSIDE_OPPOSING_4H_POI: "已在4H反向FVG内 · 等待新的入场结构",
  CROSSED_UNCONFIRMED: "已穿越4H反向FVG · 突破尚未确认",
  UNAVAILABLE: "4H目标路径待核验",
  NO_TARGET: "暂无可用4H目标",
};
/** @param {import('./types').StructurePlan | null | undefined} plan */
export function planRiskView(plan, fresh = true) {
  const protectionReady = fresh && planProtectionReady(plan);
  const usesTargetPath = plan?.targetPathRevision === 'SMC-TARGET-PATH-1';
  const path = usesTargetPath ? plan.targetPath : null;
  const hasPathTarget = validPrice(path?.admissionTarget);
  const target = usesTargetPath ? hasPathTarget ? path.admissionTarget : plan?.target ?? null : plan?.target ?? null;
  const netR = protectionReady ? usesTargetPath ? hasPathTarget ? path.netR : null : plan?.netR ?? null : null;
  const label = usesTargetPath ? hasPathTarget ? '4H路径目标' : '4H远端参考'
    : plan?.targetBasis?.scope === '4H_MAIN' ? '4H目标参考' : plan?.targetBasis?.scope === '15M_LOCAL' ? '15M目标参考' : '结构目标参考';
  return { protectionReady, target, netR: Number.isFinite(netR) ? netR : null, targetLabel: label,
    targetProvisional: !protectionReady || !usesTargetPath || !hasPathTarget,
    pathNote: usesTargetPath ? pathLabels[path?.state ?? 'UNAVAILABLE'] ?? null : null,
    // A blocked path must not prefill its distant reference as a manual target.
    manualTarget: usesTargetPath ? hasPathTarget ? Number(path.admissionTarget) : 0 : plan?.target ?? 0 };
}
