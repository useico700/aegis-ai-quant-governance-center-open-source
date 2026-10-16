export function remainingTime(target?: number, now = Date.now()) {
  if (!target) return "—";
  const seconds = Math.round((target - now) / 1000);
  if (seconds <= 0) return "已到达";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${days ? `${days}天 ` : ""}${hours}小时 ${minutes}分`;
}

export function implementationLabel(revision?: string) {
  const labels: Record<string, string> = {
    "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION": "R22 · 平衡落袋",
    "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION": "R21 · 八币浮盈保护",
    "MTFX-0.5.0-R20-COST-EFFICIENCY-GATE": "R20 · 成本效率闸门",
    "MTFX-0.5.0-R19-CONFIRMED-CLOSE-ENTRY-GUARD": "R19 · 确认收盘防追价",
    "MTFX-0.5.0-R18-ENTRY-QUALITY-GUARDS": "R18 · 入场质量验证",
  };
  return labels[revision ?? ""] ?? revision?.replace("MTFX-0.5.0-", "") ?? "—";
}

export function gateText(status?: string) {
  const labels: Record<string, string> = {
    PRICE_LOCKED_WAITING_STRUCTURE: "方向已确认，等待保护就绪",
    INTERSECTION_BUFFER_STOP_READY_WAITING_BBO: "保护就绪，等待有效报价",
    STRUCTURE_READY_WAITING_BBO: "结构就绪，等待有效报价",
    STRUCTURE_READY_WAITING_SIGNAL_TIME: "结构就绪，等待信号时点",
    TIER1_EVENT_ENTRY_FROZEN: "风险事件窗口内暂停新入场",
    R21_SAME_DIRECTION_ENTRY_FROZEN: "组合保护中，暂停该方向新入场",
    STRUCTURE_READY_WAITING_CAPACITY: "结构就绪，等待风险容量",
    STRUCTURE_READY_WAITING_PRICE_REENTRY: "超出防追价范围，等待价格回归",
    STRUCTURE_READY_WAITING_PROTECTIVE_BBO: "等待价格回到保护边界",
    OPENED: "验证通过，已生成仓位",
    EXPIRED: "验证时效已结束",
    REJECTED: "验证未通过",
  };
  return status ? labels[status] ?? "验证状态已更新" : "等待交汇";
}

export function gateReasonLabel(reason?: string) {
  const labels: Record<string, string> = {
    COMPLETE_LIFECYCLE_COST_EXCEEDS_0_12R: "完整往返成本超过0.12R",
    V2_COST_EFFICIENCY_EVIDENCE_INVALID: "成本证据不完整",
    ENTRY_PRICE_OUTSIDE_MAXIMUM_DISPLACEMENT_WAITING_FOR_REENTRY: "价格偏离确认收盘超过50bps",
    ENTRY_SIGNAL_EXPIRED_BEFORE_SIMULATED_SUBMISSION: "确认信号已超过180秒",
    MAXIMUM_OPEN_POSITIONS_REACHED: "开放仓位数量已满",
    PORTFOLIO_RISK_LIMIT_REACHED: "组合风险容量不足",
    NON_POSITIVE_POSITION_SIZE: "当前风险容量无法形成仓位",
    INTERSECTION_BUFFER_STOP_NOT_PROTECTIVE: "当前价格不满足保护边界",
    FIBONACCI_STOP_NOT_PROTECTIVE: "当前价格不满足结构保护边界",
    SAME_SYMBOL_OPEN_POSITION_EXISTS: "同一标的已有开放仓位",
    REPLACEMENT_DIRECTION_NOT_OPPOSITE: "已有同向持仓，禁止重复开仓",
    REPLACEMENT_REQUIRES_ACTIVE_4H_LINEAGE: "候选未沿用当前有效4H趋势，不能替换已有持仓",
    REPLACEMENT_INTERSECTION_NOT_NEWER_THAN_EXISTING: "候选交汇不晚于已有持仓的交汇，不能替换",
    REPLACEMENT_CONFIRMATION_NOT_NEWER_THAN_EXISTING_OPEN: "候选确认时间不晚于已有持仓开仓时间，不能替换",
    MULTIPLE_SAME_SYMBOL_OPEN_POSITIONS: "同一标的存在多个开放仓位，无法确定替换对象",
    R21_SAME_DIRECTION_ENTRY_FROZEN: "组合保护暂时冻结该方向的新入场",
    SCHEDULED_TIER1_EVENT_ENTRY_FREEZE: "一级风险事件窗口内暂停新入场",
    ENTRY_DECISION_BAR_NOT_CLOSED: "确认K线尚未收盘，等待信号生效",
    BBO_COVERAGE_INCOMPLETE: "报价覆盖不完整，等待连接后的有效报价",
    BBO_TEMPORAL_EVIDENCE_INCOMPLETE: "报价时间证据不完整，等待有效报价",
    BBO_MARKET_TIME_BEFORE_STRUCTURE_READY: "报价早于保护就绪，等待更新报价",
    BBO_MARKET_TIME_AFTER_ENTRY_DEADLINE: "报价晚于本次入场截止时间",
    BBO_MARKET_TIME_AFTER_DECISION_CLOCK: "报价的交易所时间晚于当前决策时间，等待时间一致",
    BBO_RECEIVED_AFTER_DECISION_CLOCK: "报价接收时间晚于当前本地决策时间，等待时间一致",
    BBO_STALE_AT_DECISION: "报价已过期，等待更新报价",
    ENTRY_SIGNAL_FUTURE_BEFORE_SIMULATED_SUBMISSION: "等待确认信号生效",
  };
  return reason ? labels[reason] ?? "状态原因已记录" : null;
}

export function stageLabel(stage?: string) {
  const labels: Record<string, string> = {
    INITIAL: "初始管理",
    SOFT_LOCK_80_REMAINING: "0.5R后 · 剩80%",
    BALANCED_LOCK_60_REMAINING: "0.5R后 · 剩60%",
    BREAK_EVEN: "盈利保护",
    AFTER_ONE_R: "1R后 · 剩50%",
    AFTER_1R_50_REMAINING: "1R后 · 剩50%",
    AFTER_1R_35_REMAINING: "1R后 · 剩35%",
    RUNNER_25: "2R后 · 25%尾仓",
    RUNNER_15: "2R后 · 15%尾仓",
    CLOSED: "已平仓",
  };
  return labels[stage ?? ""] ?? "管理状态已更新";
}

export function managementLabel(position: {
  stage?: string;
  softLockArmed?: boolean;
  breakEvenArmed?: boolean;
  firstPartialTaken?: boolean;
  secondPartialTaken?: boolean;
}) {
  if (["RUNNER_25", "RUNNER_15"].includes(position.stage ?? "") || position.secondPartialTaken) return "1H结构追踪";
  if (["AFTER_1R_50_REMAINING", "AFTER_1R_35_REMAINING", "AFTER_ONE_R"].includes(position.stage ?? "")) return "已完成0.5R与1R减仓";
  if (position.softLockArmed) return "0.5R盈利保护已启用";
  if (position.breakEvenArmed) return "盈利保护已启用";
  if (position.firstPartialTaken) return "首档减仓已完成";
  return "等待0.5R首档";
}

export function stopSourceLabel(position: {
  direction: 1 | -1;
  initialStop?: number;
  stop?: number;
  stage?: string;
  softLockArmed?: boolean;
  breakEvenArmed?: boolean;
  protectiveStructure?: { source?: string } | null;
}) {
  const initial = Number(position.initialStop);
  const current = Number(position.stop);
  const tolerance = Math.max(Math.abs(initial), 1) * 1e-10;
  const tightened = Number.isFinite(initial) && Number.isFinite(current) &&
    (position.direction === 1 ? current > initial + tolerance : current < initial - tolerance);
  if (["RUNNER_25", "RUNNER_15"].includes(position.stage ?? "") && tightened) return "1H结构追踪已收紧";
  if (tightened && (position.softLockArmed || position.breakEvenArmed)) return "盈利保护已收紧";
  if (tightened) return "当前保护已收紧";
  const source = position.protectiveStructure?.source ?? "";
  if (source === "CANONICAL_INTERSECTION_PRICE_WITH_FIXED_BUFFER") return "交汇价缓冲初始保护";
  if (source.includes("0618") || source.includes("CONFIRMED_STRUCTURE")) return "1H结构0.618初始保护";
  return "初始保护";
}

export function exitReasonLabel(reason?: string) {
  const labels: Record<string, string> = {
    STOP: "保护止损触发",
    RUNNER_STOP: "尾仓追踪止损触发",
    OPPOSITE_CURRENT_STRUCTURE_REPLACEMENT: "当前反向结构替代",
    ADMINISTRATIVE_OWNER_PROCESS_SIGTERM: "历史进程退出结算",
    OWNER_AUTHORIZED_SAME_SYMBOL_CONFLICT_NORMALIZATION: "历史同标的冲突归一",
  };
  return reason ? labels[reason] ?? "策略退出" : "—";
}

export function patternLabel(pattern?: string) {
  const labels: Record<string, string> = {
    "4H_ASC_LOW__1H_DESC_HIGH": "4H抬高低点 × 1H降低高点",
    "4H_DESC_HIGH__1H_ASC_LOW": "4H降低高点 × 1H抬高低点",
  };
  return labels[pattern ?? ""] ?? "价格—时间结构交汇";
}

export function gradeLabel(grade?: string) {
  return ({ HIGH: "高", MEDIUM: "中", LOW: "低" } as Record<string, string>)[grade ?? ""] ?? "—";
}

export function eventSourceLabel(source?: string) {
  const labels: Record<string, string> = {
    OFFICIAL_RELEASE_CALENDAR: "官方发布日历",
    OFFICIAL_ECONOMIC_CALENDAR: "官方经济日历",
    VERIFIED_TIER1_CALENDAR: "已验证一级日历",
  };
  return labels[source ?? ""] ?? "已验证日历来源";
}

export function planWindowLabel({ start, status, now }: { start?: number; status?: string; now: number }) {
  if (status === "OPENED") return { label: "已生成仓位", detail: "该交汇已完成入场验证" };
  if (status === "EXPIRED") return { label: "验证时效已结束", detail: "该交汇不会延后补入" };
  if (status === "REJECTED") return { label: "验证未通过", detail: "原因见入场验证状态" };
  if (start && now < start) return { label: remainingTime(start, now), detail: "尚未到达交汇时刻" };
  return { label: "交汇时刻已到", detail: "已到达不等于已过期" };
}
