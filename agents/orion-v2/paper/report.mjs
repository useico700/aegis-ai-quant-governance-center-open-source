import { summarizeTrendCapture } from "./paper-engine.mjs";
import { ABNORMAL_LOSS_GATE_POLICY } from "../../shared/abnormal-loss-gate.mjs";
import presentationContract from "../../../governance/presentation-contracts/mtfx-presentation-contract-v1.json" with { type: "json" };

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function shanghaiDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function shanghaiDateKey(timestamp) {
  const parts = shanghaiDateParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shanghaiWeekKey(timestamp) {
  const parts = shanghaiDateParts(timestamp);
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function positionMark(position) {
  return Number(position.direction) === 1 ? Number(position.lastBid) : Number(position.lastAsk);
}

// Quotes are refreshed continuously by the daemon, while canonical position
// snapshots are intentionally committed only on a management transition. Use
// the current in-memory BBO solely for a presentation mark; never write it
// back into the position or let it alter the audit-ledger state.
function liveMarkedPosition(state, position) {
  const quote = state?.lastQuotes?.[position.symbol];
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!(bid > 0) || !(ask >= bid)) return position;
  return {
    ...position,
    lastBid: bid,
    lastAsk: ask,
    lastMarkedAt: Number(quote.receivedAt ?? quote.marketTime ?? position.lastMarkedAt ?? 0) || null,
  };
}

function markedPosition(position, runtime) {
  const direction = Number(position.direction);
  const entry = Number(position.entry);
  const quantity = Number(position.quantity);
  const executable = positionMark(position);
  const slippageRate = Number(runtime.paperRisk.adverseSlippageRate) || 0;
  const feeRate = Number(runtime.paperRisk.takerFeeRate) || 0;
  const estimatedExit = executable * (direction === 1 ? 1 - slippageRate : 1 + slippageRate);
  const estimatedExitFee = estimatedExit * quantity * feeRate;
  const originalQuantity = Number(position.originalQuantity ?? quantity);
  const remainingEntryFee = Number(position.entryFee || 0) * (originalQuantity > 0 ? quantity / originalQuantity : 1);
  const unrealizedNetPnlUsdt = direction * (estimatedExit - entry) * quantity - remainingEntryFee - estimatedExitFee;
  const initialPlannedRiskUsdt = Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt) || 0;
  return {
    id: position.id,
    book: position.book,
    symbol: position.symbol,
    side: direction === 1 ? "LONG" : "SHORT",
    openedAt: position.openedAt,
    entry,
    mark: executable,
    quantity,
    originalQuantity,
    remainingPct: originalQuantity > 0 ? quantity / originalQuantity * 100 : 0,
    grossNotionalUsdt: entry * quantity,
    initialStop: position.initialStop,
    currentStop: position.stop,
    target: position.target,
    plannedRiskUsdt: Number(position.plannedRiskUsdt) || 0,
    initialPlannedRiskUsdt,
    abnormalLossThresholdsUsdt: initialPlannedRiskUsdt > 0 ? {
      yellow: initialPlannedRiskUsdt * ABNORMAL_LOSS_GATE_POLICY.yellowLossRExclusive,
      orange: initialPlannedRiskUsdt * ABNORMAL_LOSS_GATE_POLICY.orangeLossRExclusive,
      red: initialPlannedRiskUsdt * ABNORMAL_LOSS_GATE_POLICY.redLossRExclusive,
    } : null,
    unrealizedNetPnlUsdt,
    currentNetR: initialPlannedRiskUsdt > 0 ? unrealizedNetPnlUsdt / initialPlannedRiskUsdt : null,
    breakEvenArmed: position.breakEvenArmed === true,
    softLockArmed: position.softLockArmed === true,
    stage: position.stage ?? "INITIAL",
    softLockPrice: position.softLockPrice ?? null,
    oneRPrice: position.oneRPrice ?? null,
    twoRPrice: position.twoRPrice ?? position.target ?? null,
    maximumNetExcursionR: position.maximumNetExcursionR ?? null,
    minimumNetExcursionR: position.minimumNetExcursionR ?? null,
  };
}

export function buildPaperStatusReport(state, runtime, now = Date.now()) {
  const storedBooks = Object.values(state?.books ?? {});
  const activeVariants = new Set((runtime.books ?? [])
    .filter((book) => book.entryEnabled === true)
    .map((book) => book.variant));
  // Retired or unconfigured books stay in immutable history but never appear on
  // the active control surface, nor influence current risk/accounting.
  const riskBooks = storedBooks.filter((book) => activeVariants.has(book.variant));
  const positions = riskBooks.flatMap((book) => (book.openPositions ?? [])
    .map((position) => markedPosition(liveMarkedPosition(state, position), runtime)));
  const closed = riskBooks.flatMap((book) => book.closedPositions ?? []);
  const realizedNetPnlUsdt = sum(riskBooks.map((book) => book.realizedPnlUsdt));
  const unrealizedNetPnlUsdt = sum(positions.map((position) => position.unrealizedNetPnlUsdt));
  const initialEquityUsdt = sum(riskBooks.map((book) => book.initialEquityUsdt));
  const realizedEquityUsdt = sum(riskBooks.map((book) => book.equityUsdt));
  const markedEquityUsdt = realizedEquityUsdt + unrealizedNetPnlUsdt;
  const peakEquityUsdt = sum(riskBooks.map((book) => book.peakEquityUsdt));
  const entryFeesPaidUsdt = sum(positions.map((position) => {
    const original = riskBooks.flatMap((book) => book.openPositions ?? []).find((candidate) => candidate.id === position.id);
    return original?.entryFee;
  })) + sum(closed.map((position) => position.entryFee));
  const exitFeesPaidUsdt = sum(closed.map((position) => position.exitFee)) +
    sum(riskBooks.flatMap((book) => book.openPositions ?? []).map((position) => position.cumulativeExitFee));
  const fundingPnlUsdt = sum(closed.map((position) => position.fundingPnl));
  const activeRiskUsdt = sum(positions.map((position) => position.plannedRiskUsdt));
  const portfolioRiskLimitUsdt = sum(riskBooks.map((book) => Number(book.equityUsdt || 0) * Number(runtime.paperRisk.maximumPortfolioRiskFraction || 0)));
  const grossNotionalUsdt = sum(positions.map((position) => position.grossNotionalUsdt));
  const currentDay = shanghaiDateKey(now);
  const currentWeek = shanghaiWeekKey(now);
  const dailyNetPnlUsdt = sum(riskBooks.map((book) => book.day === currentDay ? book.dayRealizedPnlUsdt : 0));
  const weeklyNetPnlUsdt = sum(closed.filter((position) => shanghaiWeekKey(position.closedAt ?? 0) === currentWeek).map((position) => position.netPnl));
  const wins = closed.filter((position) => Number(position.netPnl) > 0);
  const losses = closed.filter((position) => Number(position.netPnl) < 0);
  const grossProfitUsdt = sum(wins.map((position) => position.netPnl));
  const grossLossUsdt = Math.abs(sum(losses.map((position) => position.netPnl)));
  const maximumOpenPositionsTotal = Number(runtime.paperRisk.maximumOpenPositionsTotal) || 0;
  return {
    generatedAt: new Date(now).toISOString(),
    account: {
      initialEquityUsdt,
      realizedEquityUsdt,
      markedEquityUsdt,
      realizedNetPnlUsdt,
      unrealizedNetPnlUsdt,
      totalNetPnlUsdt: realizedNetPnlUsdt + unrealizedNetPnlUsdt,
      cumulativeTradingCostUsdt: entryFeesPaidUsdt + exitFeesPaidUsdt - fundingPnlUsdt,
      feesPaidUsdt: entryFeesPaidUsdt + exitFeesPaidUsdt,
      fundingPnlUsdt,
      dailyNetPnlUsdt,
      weeklyNetPnlUsdt,
      drawdownUsdt: Math.min(0, markedEquityUsdt - peakEquityUsdt),
    },
    risk: {
      activeRiskUsdt,
      portfolioRiskLimitUsdt,
      usagePct: portfolioRiskLimitUsdt > 0 ? activeRiskUsdt / portfolioRiskLimitUsdt * 100 : 0,
      grossNotionalUsdt,
      effectiveLeverage: markedEquityUsdt > 0 ? grossNotionalUsdt / markedEquityUsdt : 0,
      maximumLeverage: Number(runtime.paperRisk.maximumLeverage) || 0,
      openPositions: positions.length,
      maximumOpenPositionsTotal,
      dailyRealizedLossStopEnabled: runtime.paperRisk.dailyRealizedLossStopEnabled === true,
      maximumDrawdownKillEnabled: runtime.paperRisk.maximumDrawdownKillEnabled === true,
      abnormalLossGate: state?.abnormalLossGate ?? null,
      scope: "CANONICAL_MTFX_T_ONLY",
    },
    performance: {
      closedPositions: closed.length,
      wins: wins.length,
      winRatePct: closed.length ? wins.length / closed.length * 100 : null,
      profitFactor: grossLossUsdt > 0 ? grossProfitUsdt / grossLossUsdt : null,
      trendCapture: summarizeTrendCapture(closed),
    },
    books: Object.fromEntries(riskBooks.map((book) => [book.variant, {
      equityUsdt: book.equityUsdt,
      realizedPnlUsdt: book.realizedPnlUsdt,
      openPositions: book.openPositions?.length ?? 0,
      closedPositions: book.closedPositions?.length ?? 0,
      newEntriesBlocked: state?.abnormalLossGate?.entriesBlocked === true || book.newEntriesBlocked === true,
      blockReason: state?.abnormalLossGate?.entriesBlocked === true ? `ABNORMAL_SINGLE_LOSS_${state.abnormalLossGate.status}` : book.blockReason ?? null,
      entryEnabled: true,
    }])),
    plans: Object.values(state?.plans ?? {}).map((plan) => ({
      id: plan.id,
      symbol: plan.symbol,
      pattern: plan.pattern,
      fourHourLineStatus: plan.fourHourLineStatus ?? "ACTIVE_4H_TREND",
      intersectionTime: plan.intersectionTime,
      intersectionWindowStart: plan.intersectionWindowStart ?? plan.intersectionTime,
      intersectionWindowEnd: plan.intersectionWindowEnd ?? plan.intersectionTime,
      lockedBarOpenTime: plan.lockedBarOpenTime,
      commitAt: plan.commitAt ?? null,
      committed: plan.committed === true,
      frozen: plan.frozen === true,
      entryGate: plan.entryGateByBook?.["MTFX-T"] ?? Object.values(plan.entryGateByBook ?? {})[0] ?? null,
      importance: plan.scale?.importance ?? null,
      anchorConsensus: plan.anchorConsensus ?? null,
      anchorQualityScore: plan.anchorQualityScore ?? null,
      weakestHierarchy: Math.min(
        Number(plan.scale?.fourHourHierarchyMultiplier ?? 1),
        Number(plan.scale?.oneHourHierarchyMultiplier ?? 1),
      ),
    })).sort((first, second) => Number(first.lockedBarOpenTime) - Number(second.lockedBarOpenTime)),
    positions,
  };
}

function number(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
}

function signed(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric > 0 ? "+" : numeric < 0 ? "−" : ""}${number(Math.abs(numeric))}`;
}

function candidatePlanState(plan) {
  const gate = plan.entryGate;
  if (!gate) return plan.frozen ? "已锁定" : plan.committed ? "承诺区" : "计划中";
  if (gate.status === "PRICE_LOCKED_WAITING_STRUCTURE") {
    const observed = gate.lastStructureReserveBarNumber ?? gate.lockedPriceConfirmation?.reserveBarNumber ?? 0;
    const direction = gate.lockedPriceConfirmation?.direction === 1 ? "多" : "空";
    return `${direction}向已确认 · 等待止损 ${observed}/4`;
  }
  if (gate.status === "STRUCTURE_READY_WAITING_BBO") return "止损已就绪 · 等待BBO";
  if (gate.status === "STRUCTURE_READY_WAITING_PROTECTIVE_BBO") return "止损已就绪 · 等待保护价";
  if (gate.status === "STRUCTURE_READY_WAITING_CAPACITY") return "止损已就绪 · 等待风险容量";
  if (gate.status === "OPENED") return "已开仓";
  if (gate.status === "EXPIRED") return "已过期";
  if (gate.status === "REJECTED") return "已拒绝";
  return gate.status;
}

function price(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (Math.abs(numeric) < 0.01) return numeric.toFixed(6);
  if (Math.abs(numeric) < 1) return numeric.toFixed(5);
  return numeric.toFixed(2);
}

function time(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function compactTime(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function compactWindow(start, end) {
  const first = compactTime(start);
  const second = compactTime(end);
  if (first === "—" || second === "—") return "—";
  if (Number(start) === Number(end)) return first;
  return `${first}–${second}`;
}

function countdown(target, now) {
  const remaining = Number(target) - Number(now);
  if (!Number.isFinite(remaining)) return "时间未知";
  if (remaining <= 0) return "已到达";
  const totalMinutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}天${hours}小时${minutes}分`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分钟`;
}

function stageLabel(stage) {
  return ({
    INITIAL: "初始防守",
    SOFT_LOCK_80_REMAINING: "软锁利后80%",
    BALANCED_LOCK_60_REMAINING: "锁利后60%",
    BREAK_EVEN: "保本管理",
    AFTER_ONE_R: "已减仓50%",
    AFTER_1R_35_REMAINING: "+1R后35%",
    RUNNER_25: "25%尾仓",
    RUNNER_15: "15%尾仓",
    CLOSED: "已平仓",
  })[stage] ?? String(stage ?? "未知阶段");
}

function blockReasonLabel(reason) {
  return ({
    DAILY_REALIZED_LOSS_STOP: "日内已实现亏损闸门",
    MAXIMUM_DRAWDOWN_KILL_SWITCH: "最大回撤熔断",
    PORTFOLIO_RISK_LIMIT_REACHED: "组合风险上限",
    ABNORMAL_SINGLE_LOSS_YELLOW: "单笔异常亏损黄色观察",
    ABNORMAL_SINGLE_LOSS_ORANGE: "单笔异常亏损橙色恢复期",
    ABNORMAL_SINGLE_LOSS_RED: "单笔异常亏损红色人工解锁",
  })[reason] ?? reason ?? "风险闸门";
}

function positionManagementLabel(position) {
  if (["RUNNER_25", "RUNNER_15"].includes(position.stage)) return "1H尾仓追踪";
  if (position.softLockArmed) return "软锁利";
  if (position.breakEvenArmed) return "保本";
  if (position.currentNetR >= 1) return "≥1R待确认";
  return "初始止损";
}

function rLevelsLabel(position) {
  return position.softLockPrice == null
    ? `+1R ${price(position.oneRPrice)} · +2R ${price(position.twoRPrice)}`
    : `+0.5R ${price(position.softLockPrice)} · +1R ${price(position.oneRPrice)} · +2R ${price(position.twoRPrice)}`;
}

export function renderPaperPositionsMarkdown(status) {
  const report = status.report;
  const contract = presentationContract.views.POSITIONS;
  const contractHeader = contract?.header ?? "POSITIONS v1";
  if (!report) return `### ORION V2｜${contractHeader}｜当前纸面持仓\n\n**状态异常：无法读取纸面仓位。**\n`;

  const lines = [
    `### ORION V2｜${contractHeader}｜当前纸面持仓`,
    "",
    `${presentationContract.contractId} · ${time(report.generatedAt)} CST`,
    "",
    `策略 ${status.strategyVersion ?? "—"} · 修订 ${status.implementationRevision ?? "—"} · 纸面交易`,
    "",
    "| # | 账本 / 标的 · 阶段 | 开仓 · 入场 / 标记 | 浮动净盈亏 · R | 当前 / 初始止损 · R位 | 数量 · 风险 / 敞口 |",
    "| ---: | :--- | :--- | :--- | :--- | :--- |",
  ];
  if (report.positions?.length) {
    for (const [index, position] of report.positions.entries()) {
      const direction = position.side === "LONG" ? "做多" : "做空";
      lines.push(`| ${index + 1} | ${position.book ?? "—"}<br>**${position.symbol}** ${direction}<br>${stageLabel(position.stage)} · ${positionManagementLabel(position)} | ${compactTime(position.openedAt)} CST<br>${price(position.entry)} / ${price(position.mark)} | ${signed(position.unrealizedNetPnlUsdt)} USDT<br>${position.currentNetR == null ? "—" : `${signed(position.currentNetR)}R`} | ${price(position.currentStop)} / ${price(position.initialStop)}<br>${rLevelsLabel(position)} | ${number(position.quantity, 4)} / ${number(position.remainingPct, 1)}%<br>${number(position.plannedRiskUsdt)} USDT / ${number(position.grossNotionalUsdt)} USDT |`);
    }
  } else {
    lines.push("| — | 当前空仓 | — | — | — | — |");
  }
  return `${lines.join("\n")}\n`;
}

export function renderPaperStatusMarkdown(status) {
  const report = status.report;
  const contractHeader = presentationContract.views.CONTROL.header;
  if (!report) return `### ORION V2｜${contractHeader}｜MTFX 纸面交易控制台\n\n**状态异常：无法读取纸面账本报表。**`;
  const account = report.account;
  const risk = report.risk;
  const performance = report.performance;
  const trendCapture = performance.trendCapture ?? {};
  const latest = status.latest ?? {};
  const websocket = latest.websocket ?? {};
  const onlineLedger = latest.onlineLedger ?? {};
  const generatedAtMs = Date.parse(report.generatedAt);
  const lastScanMs = Number(latest.lastSuccessfulScanAt);
  const scanAgeMs = Number.isFinite(generatedAtMs) && Number.isFinite(lastScanMs) ? Math.max(0, generatedAtMs - lastScanMs) : null;
  const scanFresh = scanAgeMs !== null && scanAgeMs <= 5 * 60_000;
  const residentHealthy = status.residentSupervisor?.alive === true && ["HEALTHY", "RECOVERED"].includes(status.residentSupervisor?.health);
  const runtimeTone = status.daemon?.alive && residentHealthy && websocket.connected && !status.killSwitch?.engaged && onlineLedger.status === "SYNCED" && scanFresh ? "正常" : "异常";
  const activeBooks = Object.entries(report.books ?? {}).filter(([, value]) => value.entryEnabled !== false);
  const blockedBooks = activeBooks.filter(([, value]) => value.newEntriesBlocked);
  const entryGate = blockedBooks.length
    ? blockedBooks.map(([book, value]) => `${book} 已阻止（${blockReasonLabel(value.blockReason)}）`).join("、")
    : "允许符合规则的新纸面仓位";
  const lines = [
    `### ORION V2｜${contractHeader}｜MTFX 纸面交易控制台`,
    "",
    `**${runtimeTone}** · ${time(report.generatedAt)} CST`,
    "",
    `${presentationContract.contractId} · ${time(report.generatedAt)} CST`,
    "",
    `策略 ${status.strategyVersion ?? "—"} · 修订 ${status.implementationRevision ?? "—"} · 纸面交易`,
    "",
    `新仓：${entryGate}`,
  ];
  if (!scanFresh) lines.push("", `扫描：${scanAgeMs === null ? "时间未知" : `延迟 ${number(scanAgeMs / 60_000, 1)} 分钟`}`);
  const accountAndBookRows = [
    "",
    "#### ① 账户与风险",
    "",
    "| 账户（MTFX-T） | 当前值 |",
    "| :--- | ---: |",
    `| 实时估算权益 | ${number(account.markedEquityUsdt)} USDT |`,
    `| 账面权益（仅已实现） | ${number(account.realizedEquityUsdt)} USDT |`,
    `| 总净盈亏 | ${signed(account.totalNetPnlUsdt)} USDT |`,
    `| 已实现净盈亏 | ${signed(account.realizedNetPnlUsdt)} USDT |`,
    `| 浮动净盈亏 | ${signed(account.unrealizedNetPnlUsdt)} USDT |`,
    `| 今日 / 本周 | ${signed(account.dailyNetPnlUsdt)} / ${signed(account.weeklyNetPnlUsdt)} USDT |`,
    `| 当前回撤 | ${signed(account.drawdownUsdt)} USDT |`,
    `| 累计成本 | ${number(account.cumulativeTradingCostUsdt)} USDT |`,
    `| 亏损闸门 | ${risk.dailyRealizedLossStopEnabled || risk.maximumDrawdownKillEnabled ? "旧日内/回撤开启" : "关闭（旧日内/回撤）"} · 异常单笔 ${risk.abnormalLossGate?.status ?? "CLEAR"}${risk.abnormalLossGate?.entriesBlocked ? " · 已冻结新仓" : " · 新仓未冻结"} |`,
    "",
    "**账本**",
    "",
    "| 账本 | 当前权益 | 已实现净盈亏 | 持仓数 | 新仓权限 |",
    "| :--- | ---: | ---: | ---: | :--- |",
  ].filter(Boolean);
  lines.push(...accountAndBookRows);
  for (const [book, value] of Object.entries(report.books ?? {})) {
    const gate = value.newEntriesBlocked
        ? `已阻止新仓：${blockReasonLabel(value.blockReason)}`
        : "允许新仓";
    lines.push(`| **${book}** | ${number(value.equityUsdt)} USDT | ${signed(value.realizedPnlUsdt)} USDT | ${value.openPositions} | ${gate} |`);
  }
  lines.push(
    "",
    "**组合风险**",
    "",
    "| 计划风险占用 | 风险上限 | 使用率 | 持仓数 | 持仓上限 | 名义敞口 | 有效杠杆 | 杠杆上限 |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${number(risk.activeRiskUsdt)} USDT | ${number(risk.portfolioRiskLimitUsdt)} USDT | ${number(risk.usagePct)}% | ${risk.openPositions} | ${risk.maximumOpenPositionsTotal} | ${number(risk.grossNotionalUsdt)} USDT | ${number(risk.effectiveLeverage)}x | ${number(risk.maximumLeverage, 0)}x |`,
    "",
    "**交易统计**",
    "",
    "| 已平仓 | 胜率 | Profit Factor | 可归因样本 | 先到净+2R | 尾仓净+3R｜已到2R条件 | 尾仓净+5R｜已到2R条件 |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${performance.closedPositions} | ${performance.winRatePct == null ? "—" : `${number(performance.winRatePct, 1)}%`} | ${performance.profitFactor == null ? "—" : number(performance.profitFactor)} | ${trendCapture.attributableClosedPositions ?? 0} | ${trendCapture.probabilityTwoNetRBeforeFinalStop == null ? "—" : `${number(trendCapture.probabilityTwoNetRBeforeFinalStop * 100, 1)}%`} | ${trendCapture.probabilityRunnerThreeNetRGivenTwoNetR == null ? "—" : `${number(trendCapture.probabilityRunnerThreeNetRGivenTwoNetR * 100, 1)}%`} | ${trendCapture.probabilityRunnerFiveNetRGivenTwoNetR == null ? "—" : `${number(trendCapture.probabilityRunnerFiveNetRGivenTwoNetR * 100, 1)}%`} |`,
    "",
    "#### ② 当前持仓",
    "",
    "| # | 标的 / 阶段 | 开仓 · 入场 / 标记 | 浮动净盈亏 · R | 保护与目标 | 数量 · 风险 / 敞口 |",
    "| ---: | :--- | :--- | :--- | :--- | :--- |",
  );
  if (report.positions?.length) {
    for (const [index, position] of report.positions.entries()) {
      const direction = position.side === "LONG" ? "做多" : "做空";
      lines.push(`| ${index + 1} | **${position.symbol}** ${direction}<br>${stageLabel(position.stage)} · ${positionManagementLabel(position)} | ${compactTime(position.openedAt)} CST<br>${price(position.entry)} / ${price(position.mark)} | ${signed(position.unrealizedNetPnlUsdt)} USDT<br>${position.currentNetR == null ? "—" : `${signed(position.currentNetR)}R`} | 止损 ${price(position.currentStop)} / ${price(position.initialStop)}<br>${rLevelsLabel(position)} | ${number(position.quantity, 4)} / ${number(position.remainingPct, 1)}%<br>${number(position.plannedRiskUsdt)} USDT / ${number(position.grossNotionalUsdt)} USDT |`);
    }
  } else {
    lines.push("| — | 当前空仓 | — | — | 等待交汇后的合格15M确认形态 | — |");
  }
  lines.push(
    "",
    "#### ③ 候选计划",
    "",
    `扫描 ${latest.symbolCount ?? "—"}｜候选 ${report.plans?.length ?? 0}｜CST`,
    "",
    "| # | 币种 | 结构 | 4H谱系 | 弱侧等级 | 数学交汇窗口 | 距窗口开始 | 精确主交点 | 距主交点 | 15M储备开始 | 距储备 | 锚点稳定度 | 状态 |",
    "| ---: | :--- | :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  );
  if (report.plans?.length) {
    for (const [index, plan] of report.plans.entries()) {
      const pattern = plan.pattern === "4H_DESC_HIGH__1H_ASC_LOW" ? "4H降高 × 1H升低" : "4H升低 × 1H降高";
      const lineage = plan.fourHourLineStatus === "PREVIOUS_4H_CANDIDATE" ? "前序4H" : "当前4H";
      const windowStart = plan.intersectionWindowStart ?? plan.intersectionTime;
      const windowEnd = plan.intersectionWindowEnd ?? plan.intersectionTime;
      const windowCountdown = countdown(windowStart, generatedAtMs);
      const crossCountdown = countdown(plan.intersectionTime, generatedAtMs);
      const reserveCountdown = countdown(plan.lockedBarOpenTime, generatedAtMs);
      const stabilityScore = Number(plan.anchorConsensus?.stabilityScore);
      const stabilityGrade = ({ HIGH: "高", MEDIUM: "中", LOW: "低" })[plan.anchorConsensus?.grade] ?? "待计算";
      const stability = Number.isFinite(stabilityScore)
        ? `${stabilityGrade} ${number(stabilityScore * 100, 0)}% · ${plan.anchorConsensus.support}组`
        : "旧计划待重算";
      const planState = candidatePlanState(plan);
      lines.push(`| ${index + 1} | **${plan.symbol}** | ${pattern} | ${lineage} | H${plan.weakestHierarchy} | ${compactWindow(windowStart, windowEnd)} CST | ${windowCountdown} | ${compactTime(plan.intersectionTime)} CST | ${crossCountdown} | ${compactTime(plan.lockedBarOpenTime)} CST | ${reserveCountdown} | ${stability} | ${planState} |`);
    }
  } else {
    lines.push("| — | 当前无合格候选 | — | — | — | — | — | — | — | — | — | — | 继续扫描 |");
  }
  lines.push(
    "",
    "#### ④ 系统",
    "",
    "| 运行项目 | 当前状态 |",
    "| :--- | :--- |",
    `| 纸面进程 / 常驻监督 | ${status.daemon?.alive ? "在线" : "离线"} / ${status.residentSupervisor?.alive ? status.residentSupervisor.health ?? "在线" : "离线"} |`,
    `| WebSocket / 在线账本 | ${websocket.connected ? "在线" : "离线"} / ${onlineLedger.status ?? "—"} |`,
    `| 最近成功扫描 | ${compactTime(latest.lastSuccessfulScanAt)} CST（${scanFresh ? "新鲜" : "延迟"}） |`,
    `| 数据缺口 / 重连次数 | ${websocket.gapDetected ? "有" : "无"} / ${websocket.reconnects ?? "—"} |`,
    `| Kill switch / 实盘 | ${status.killSwitch?.engaged ? "开启" : "关闭"} / ${latest.realOrdersAllowed === false ? "禁用" : String(latest.realOrdersAllowed ?? "—")} |`,
  );
  return `${lines.join("\n")}\n`;
}

function controlSection(status, startMarker, endMarker = null) {
  const control = renderPaperStatusMarkdown(status).trimEnd().split("\n");
  const start = control.indexOf(startMarker);
  if (start < 0) throw new Error(`CONTROL_SECTION_MISSING_${startMarker}`);
  const end = endMarker ? control.indexOf(endMarker, start + 1) : control.length;
  if (endMarker && end < 0) throw new Error(`CONTROL_SECTION_MISSING_${endMarker}`);
  return control.slice(start, end);
}

function modularHeader(status, viewKey, title) {
  const report = status.report;
  const header = presentationContract.views[viewKey]?.header ?? `${viewKey} v1`;
  if (!report) return [`### ORION V2｜${header}｜${title}`, "", `**状态异常：无法读取${title}。**`];
  return [
    `### ORION V2｜${header}｜${title}`,
    "",
    `${presentationContract.contractId} · ${time(report.generatedAt)} CST`,
    "",
    `策略 ${status.strategyVersion ?? "—"} · 修订 ${status.implementationRevision ?? "—"} · 纸面交易`,
    "",
  ];
}

function standaloneSection(section, title) {
  const copy = [...section];
  copy[0] = `#### ${title}`;
  return copy;
}

export function renderPaperEquityMarkdown(status) {
  if (!status.report) return `${modularHeader(status, "EQUITY", "账户权益").join("\n")}\n`;
  const body = standaloneSection(controlSection(status, "#### ① 账户与风险", "#### ② 当前持仓"), "账户权益");
  return `${[...modularHeader(status, "EQUITY", "账户权益"), ...body].join("\n")}\n`;
}

export function renderPaperCandidatesMarkdown(status) {
  if (!status.report) return `${modularHeader(status, "CANDIDATES", "候选计划").join("\n")}\n`;
  const body = standaloneSection(controlSection(status, "#### ③ 候选计划", "#### ④ 系统"), "候选计划");
  return `${[...modularHeader(status, "CANDIDATES", "候选计划"), ...body].join("\n")}\n`;
}

export function renderPaperPanoramaMarkdown(status) {
  if (!status.report) return `${modularHeader(status, "PANORAMA", "账户全景").join("\n")}\n`;
  const account = controlSection(status, "#### ① 账户与风险", "#### ② 当前持仓");
  const positions = controlSection(status, "#### ② 当前持仓", "#### ③ 候选计划");
  const candidates = controlSection(status, "#### ③ 候选计划", "#### ④ 系统");
  return `${[...modularHeader(status, "PANORAMA", "账户全景"), ...account, ...positions, ...candidates].join("\n")}\n`;
}
