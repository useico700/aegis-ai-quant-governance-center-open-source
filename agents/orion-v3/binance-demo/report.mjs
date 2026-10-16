import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { fileURLToPath } from "node:url";

import { readJson } from "../../orion-v2/paper/runtime-utils.mjs";
import { V3_LATEST_PATH, scanV3Once } from "./snapshot.mjs";

const CST = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const displayMoneyNumber = (value) => Math.abs(Number(value ?? 0)) < 0.005 ? 0 : Number(value ?? 0);
const money = (value) => `${displayMoneyNumber(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
const signedMoney = (value) => `${displayMoneyNumber(value) > 0 ? "+" : ""}${money(value)}`;
const price = (value) => Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 });
const time = (value) => value ? `${CST.format(new Date(value)).replaceAll("/", "-")} CST` : "—";
const rate = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 10_000).toFixed(2)} bps` : "—";
const HF13_REVISION = "MTFX-V3-HF13-DUAL-Z-STRUCTURE-GATE";
const HF14_REVISION = "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE";
const HF11_REVISION = "MTFX-V3-HF11-TRUE-4H-MARKET-STATE-GATE";
const isHf13 = (snapshot) => snapshot.implementationRevision === HF13_REVISION;
const isHf14 = (snapshot) => snapshot.implementationRevision === HF14_REVISION;
function cohortLabel(value, classification) {
  const id = String(value ?? "");
  if (/^ORION-V3-PRE-HF11(?:-|$)/.test(id)) return "HF11前";
  if (/^ORION-V3-HF13(?:-|$)/.test(id)) return "HF13前向";
  if (/^ORION-V3-HF14(?:-|$)/.test(id)) return "HF14前向";
  if (/^ORION-V3-HF11(?:-|$)/.test(id)) return "HF11前向";
  const legacyVersion = id.match(/^ORION-V3-(?:PRE-)?HF(\d+)(?:-|$)/);
  if (legacyVersion && Number(legacyVersion[1]) < 11) return "HF11前";
  if (classification === "PRE_HF11_BASELINE") return "HF11前";
  return id ? "未分类" : "未分群";
}
const cohortDisplay = (value, classification) => `${cohortLabel(value, classification)}（${value ?? "ID缺失"}）`;
const state4h = (value) => value === "LONG_ONLY" ? "仅多" : value === "SHORT_ONLY" ? "仅空" : "震荡/过渡";
const stateGate = (value) => value === "ALLOWED" ? "通过" : value === "WAITING_FOR_5M_DIRECTION" ? "待5M方向" : "影子/受阻";

function dualZState(row, name, interval) {
  return row.dualZ?.schemaVersion === 1 && row.dualZ?.[name]?.status === "CONFIRMED"
    && row.dualZ[name].interval === interval ? "已确认" : "缺失/未确认";
}

function strategyRules(snapshot) {
  const existingRules = "HF10双5M持续确认及HF9独立1H＋15M谱系重入继续生效；第二根确认后BBO须距离其收盘≤75bps且信号≤300秒。单笔1%，组合10%，最多18仓，最大有效名义杠杆10x。";
  const fourHourRules = "只使用 Binance USD-M 账户完整收盘的原生4H OHLC；最近两组已确认高低点同升仅多、同降仅空，其余影子受阻。";
  if (isHf13(snapshot)) return `规则：HF13要求1H主Z与15M反向Z同时完成因果确认，绑定原A/C趋势线；向上A<C<B<D，向下A>C>B>D。5M沿原两根同侧收盘持续确认，保留4H状态门：${fourHourRules}${existingRules}`;
  if (isHf14(snapshot)) return "规则：HF14要求1H主Z完成因果确认，15M保留原A/C反向趋势线与交汇，不要求15M完整Z。交汇后两根原生15M同侧收盘确认；第二根后BBO距其收盘≤75bps且信号≤300秒。HF14的4H方向门已撤销，4H不是候选、排名或下单输入。单笔1%，组合10%，最多18仓，最大有效名义杠杆10x。";
  if (snapshot.implementationRevision === HF11_REVISION) return `规则：HF11${fourHourRules}${existingRules}`;
  return `规则：当前快照版本 ${snapshot.implementationRevision ?? "未提供"}；未提供该版本的规则说明。`;
}

function duration(ms) {
  const future = Number(ms);
  if (!Number.isFinite(future)) return "—";
  const sign = future >= 0 ? "后" : "前";
  const minutes = Math.floor(Math.abs(future) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${rest}分${sign}`;
}

function entryState(value, interval = "5M") {
  return ({
    WAITING_FOR_CROSS: "等待交汇",
    WAITING_FIRST_5M_CLOSE: "等待第1根5M收盘",
    WAITING_FIRST_15M_CLOSE: "等待第1根15M收盘",
    WAITING_SECOND_5M_CLOSE: "等待第2根5M收盘",
    WAITING_SECOND_PERSISTENCE_CLOSE: `等待第2根同向${interval}持续确认`,
    CONFIRMED_LONG: `${interval}确认做多`,
    CONFIRMED_SHORT: `${interval}确认做空`,
    EXPIRED_INSIDE_BUFFER: "两根均在缓冲区/失效",
    EXPIRED_FIRST_CLOSE_NOT_CONFIRMED: "首根未越界/失效",
    EXPIRED_SECOND_CLOSE_NOT_PERSISTENT: "第2根未保持同向/失效",
  })[value] ?? "—";
}

export function formatPositions(snapshot) {
  const rows = snapshot.positions ?? [];
  const equity = Number(snapshot.account?.totalMarginBalanceUsdt ?? 0);
  const managedBySymbol = new Map((snapshot.managedPositions ?? []).map((row) => [row.symbol, row]));
  const actualPortfolioLeverage = Number(snapshot.risk?.actualEffectiveNotionalLeverage ?? 0);
  const lines = [
    "ORION V3｜高频交易仓位 · POSITIONS v3",
    `数据：${time(snapshot.accountObservedAt)}｜${rows.length} / ${snapshot.risk.maximumOpenPositionsTotal} 仓｜组合实际有效杠杆 ${actualPortfolioLeverage.toFixed(2)}x / 上限 ${Number(snapshot.risk?.maximumLeverage ?? 10).toFixed(0)}x`,
    "",
    "| 批次 | 标的 | 方向 | 数量 | 入场价 | 标记价 | 浮动盈亏 | 已扣开仓费率 / 开仓费 | 交易所档位 / 仓位有效杠杆 | 强平价 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  if (!rows.length) lines.push("| — | 当前空仓 | — | — | — | — | 0.00 USDT | — | — / 0.00x | — |");
  for (const row of rows) {
    const managed = managedBySymbol.get(row.symbol);
    const evidence = managed?.entryFeeEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES" ? "实" : "估";
    const positionNotional = Math.abs(Number(row.quantity ?? 0) * Number(row.markPrice ?? 0));
    const actualPositionLeverage = equity > 0 ? positionNotional / equity : 0;
    lines.push(`| ${cohortDisplay(managed?.evaluationCohortId)} | ${row.symbol} | ${row.side === "SHORT" ? "空" : "多"} | ${price(row.quantity)} | ${price(row.entryPrice)} | ${price(row.markPrice)} | ${money(row.unrealizedProfitUsdt)} | ${rate(managed?.entryFeeRate)} / ${money(managed?.entryFee)}（${evidence}） | ${row.leverage || "—"}x / ${actualPositionLeverage.toFixed(2)}x | ${price(row.liquidationPrice) || "—"} |`);
  }
  return lines.join("\n");
}

export function formatCandidates(snapshot, now = Date.now()) {
  const rows = [...(snapshot.plans ?? [])].sort((a, b) => Number(a.intersectionTime) - Number(b.intersectionTime));
  const hf13 = isHf13(snapshot);
  const hf14 = isHf14(snapshot);
  const source = hf14 ? "V3 1H主Z＋15M原A/C交汇＋双15M入场（4H非执行输入）" : hf13 ? "V3 1H主Z＋15M反向Z交汇＋双5M入场（保留真实4H状态门）" : snapshot.implementationRevision === HF11_REVISION ? "V3 真实4H状态门＋1H／15M交汇＋双5M入场" : "V3 当前快照候选";
  const structureColumn = hf14 ? "1H Z／HF13双Z过滤对照 | " : hf13 ? "1H Z／15M Z | " : "";
  const marketColumn = hf14 ? "4H边界" : "4H状态／门";
  const entryInterval = hf14 ? "15M" : "5M";
  const lines = ["ORION V3｜高频候选计划 · CANDIDATES v3", `来源：${source} ${snapshot.implementationRevision}｜评估批次：${snapshot.evaluationCohortId ?? "—"}｜扫描：${time(snapshot.sourceStrategyScanAt)}`, "", `| 标的 | 队列 | 结构 | 1H谱系 | ${structureColumn}${marketColumn} | 数学交汇时间 | 倒计时 | P× | ${entryInterval}入场状态 | 候选层级／执行 | 稳定度 |`, `|---|---:|---|---|${hf13 || hf14 ? "---|" : ""}---|---:|---:|---:|---|---|---:|`];
  if (!rows.length) lines.push(`| 当前无候选 | — | — | — | ${hf13 || hf14 ? "— | " : ""}— | — | — | — | — | — | — |`);
  for (const row of rows) {
    const primaryZ = dualZState(row, "primary", "1h");
    const opposingZ = dualZState(row, "opposing", "15m");
    const singlePrimaryZ = row.singleZ?.primary?.status === "CONFIRMED" && row.singleZ?.primary?.interval === "1h" ? "已确认" : "缺失/未确认";
    const comparison = row.dualZComparison?.status === "WOULD_PASS_HF13_DUAL_Z_FILTER" ? "旧双Z过滤会通过" : row.dualZComparison?.status === "WOULD_FAIL_HF13_DUAL_Z_FILTER" ? "旧双Z过滤不通过" : "对照未知";
    const quality = hf14 && (singlePrimaryZ !== "已确认" || row.singleZ?.status !== "CONFIRMED")
      ? "仅观察／1H Z证据缺失"
      : hf14 && row.singleZGate?.allowed === false
        ? "仅观察／单Z校验受阻"
      : hf13 && (primaryZ !== "已确认" || opposingZ !== "已确认" || row.dualZ?.status !== "CONFIRMED")
      ? "仅观察／双Z证据缺失"
      : hf13 && row.dualZGate?.allowed === false
        ? "仅观察／双Z校验受阻"
        : row.intersectionQuality?.automaticExecutionAllowed !== true
      ? "仅观察／共识不足"
      : row.intersectionQuality?.freshExecutionBboPromotionRequired === true
        ? `${entryInterval}确认／待确认收盘后BBO复核`
        : "正式候选／可自动执行";
    const structure = hf14 ? `${singlePrimaryZ}／${comparison} | ` : hf13 ? `${primaryZ}／${opposingZ} | ` : "";
    const market = hf14 ? "已撤销／非执行输入" : `${state4h(row.marketState4h?.state)}／${stateGate(row.marketStateGate?.status)}`;
    lines.push(`| ${row.symbol} | ${row.candidateQueue ? `${row.candidateQueue.position}/${row.candidateQueue.size}` : "—"} | ${String(row.pattern ?? "—").replace("1H_", "1H ").replace("__15M_", " × 15M ")} | ${row.primaryLineStatus ?? "—"} | ${structure}${market} | ${time(row.intersectionTime)} | ${duration(Number(row.intersectionTime) - now)} | ${price(row.intersectionPrice)} | ${entryState(row.entryDecision?.status, entryInterval)} | ${quality}／支持${row.anchorConsensus?.support ?? 0} | ${row.anchorConsensus?.grade ?? "—"} / ${(Number(row.anchorConsensus?.stabilityScore ?? 0) * 100).toFixed(1)}% |`);
  }
  return lines.join("\n");
}

function partialFeeSummary(rows) {
  if (!Array.isArray(rows) || !rows.length) return "—";
  return rows.map((row, index) => `第${index + 1}次 ${rate(row.exitFeeRate)} / ${money(row.exitFee)}`).join("；");
}

export function formatClosedTrades(snapshot) {
  const rows = [...(snapshot.closedPositions ?? [])].sort((a, b) => Number(b.closedAt) - Number(a.closedAt));
  const accounting = snapshot.accounting ?? {};
  const lines = [
    "V3 完整平仓交易手续费与净盈亏 · COMPLETE TRADE LEDGER v2",
    `累计：${rows.length} 笔完整平仓｜手续费 ${money(accounting.totalCommissionUsdt)}｜完整平仓交易净盈亏 ${signedMoney(accounting.completedTradeNetPnlUsdt ?? accounting.realizedNetPnlUsdt)}`,
    "说明：净盈亏已扣归属手续费，不能再减一次；此表不包含尚未完全平仓的分批止盈。带“估算”表示成交明细暂未取得。",
    "",
    "| 批次 | 平仓时间 | 标的/方向 | 开仓费率 / 开仓费 | 分批出场费率 / 费用 | 最终平仓费率 / 平仓费 | 总手续费 | 扣费后净盈亏 | 证据 |",
    "|---|---|---|---:|---|---:|---:|---:|---|",
  ];
  if (!rows.length) lines.push("| — | 暂无已平仓交易 | — | — | — | — | 0.00 USDT | 0.00 USDT | — |");
  for (const row of rows.slice(0, 20)) {
    const evidence = row.actualCommissionEvidenceComplete === true ? "Binance 成交明细" : "估算/混合";
    lines.push(`| ${cohortDisplay(row.evaluationCohortId)} | ${time(row.closedAt)} | ${row.symbol ?? "—"} / ${Number(row.direction) === -1 ? "空" : "多"} | ${rate(row.entryCommissionRate)} / ${money(row.entryCommissionUsdt)} | ${partialFeeSummary(row.partialExits)} | ${rate(row.finalExitCommissionRate)} / ${money(row.finalExitCommissionUsdt)} | ${money(row.totalCommissionUsdt)} | ${money(row.netPnl)} | ${evidence} |`);
  }
  return lines.join("\n");
}

export function formatControl(snapshot, now = Date.now()) {
  const a = snapshot.account;
  const r = snapshot.risk;
  const e = snapshot.equityAttribution ?? {};
  const reconciliationLabel = ({
    RECONCILED: "已对账",
    DIFFERENCE_DETECTED: "存在未对账差额",
    INCOME_HISTORY_PARTIAL: "资金流水不完整",
    NON_USDT_INCOME_REQUIRES_SEPARATE_VALUATION: "存在非USDT流水，需单独估值",
    INCOME_HISTORY_NOT_REQUESTED: "未取得资金流水",
  })[e.status] ?? e.status ?? "未知";
  const baselineCohort = (snapshot.accounting?.cohorts ?? []).find((row) => row.classification === "PRE_HF11_BASELINE") ?? {};
  const forwardCohort = (snapshot.accounting?.cohorts ?? []).find((row) => row.classification === "HF11_FORWARD") ?? {};
  const cohortSummary = (isHf13(snapshot) || isHf14(snapshot))
    ? `效果隔离：${(snapshot.accounting?.cohorts ?? []).map((row) => `${cohortDisplay(row.evaluationCohortId, row.classification)} ${row.closedTradeCount ?? 0} 笔完整平仓 / ${row.openPositionCount ?? 0} 笔在途，净盈亏 ${signedMoney(row.realizedNetPnlUsdt)}`).join("；") || "未取得批次统计"}。各批次不混算。`
    : `效果隔离：HF11前 ${baselineCohort.closedTradeCount ?? 0} 笔完整平仓 / ${baselineCohort.openPositionCount ?? 0} 笔在途，净盈亏 ${signedMoney(baselineCohort.realizedNetPnlUsdt)}；HF11前向 ${forwardCohort.closedTradeCount ?? 0} 笔完整平仓 / ${forwardCohort.openPositionCount ?? 0} 笔在途，净盈亏 ${signedMoney(forwardCohort.realizedNetPnlUsdt)}。两批次不混算。`;
  const outcomeAttribution = snapshot.accounting?.outcomeAttribution ?? {};
  const lossGate = snapshot.abnormalLossGate ?? {};
  const lossGateTrigger = lossGate.activeTrigger;
  return [
    "ORION V3｜高频交易控制台 · CONTROL v3",
    `运行：${snapshot.lifecycle}｜策略 ${snapshot.strategyDisplayName ?? snapshot.strategyVersion}｜${snapshot.implementationRevision}`,
    `数据：账户 ${time(snapshot.accountObservedAt)}｜策略扫描 ${time(snapshot.sourceStrategyScanAt)}`,
    "",
    "账户权益（交易所账户口径）",
    "",
    "| 策略起始基准 | 钱包变化 | 钱包余额 | 未实现盈亏 | 保证金权益 | 权益相对基准 |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${money(a.strategyInitialCapitalUsdt)} | ${signedMoney(e.walletBalanceDeltaFromBaselineUsdt ?? a.walletBalanceDeltaFromBaselineUsdt)} | ${money(a.totalWalletBalanceUsdt)} | ${signedMoney(a.totalUnrealizedProfitUsdt)} | ${money(a.totalMarginBalanceUsdt)} | ${signedMoney(e.equityDeltaFromBaselineUsdt ?? a.equityDeltaFromBaselineUsdt)} |`,
    `权益公式：${money(a.strategyInitialCapitalUsdt)} ${Number(e.walletBalanceDeltaFromBaselineUsdt ?? 0) >= 0 ? "+" : "−"} ${money(Math.abs(Number(e.walletBalanceDeltaFromBaselineUsdt ?? 0)))} 钱包变化 ${Number(a.totalUnrealizedProfitUsdt ?? 0) >= 0 ? "+" : "−"} ${money(Math.abs(Number(a.totalUnrealizedProfitUsdt ?? 0)))} 未实现 = ${money(a.totalMarginBalanceUsdt)}。${signedMoney(e.equityDeltaFromBaselineUsdt ?? a.actualMinusStrategyBaselineUsdt)} 是账户权益快照，不等同于策略累计净利润。`,
    "",
    `交易所资金流水对账（${time(e.incomeHistoryStartTime)} 起）`,
    "",
    "| 已实现盈亏（未扣费） | 交易手续费 | 资金费 | 转入/奖励/其他 | 流水合计 | 钱包未对账差额 |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${signedMoney(e.exchangeRealizedPnlUsdt)} | ${signedMoney(e.exchangeCommissionUsdt)} | ${signedMoney(e.exchangeFundingFeeUsdt)} | ${signedMoney(e.exchangeOtherAdjustmentsUsdt)} | ${signedMoney(e.exchangeIncomeLedgerTotalUsdt)} | ${signedMoney(e.walletUnreconciledDifferenceUsdt)} |`,
    `对账状态：${reconciliationLabel}｜资金流水 ${e.incomeHistoryRowCount ?? 0} 条。交易手续费已进入钱包和权益，不再二次扣减。`,
    "",
    "策略账本统计（与账户权益桥分开）",
    "",
    "| 完整平仓交易净盈亏 | 开放仓分批已实现净盈亏 | 策略已实现小计 | 当前未实现 | 完整平仓手续费 |",
    "|---:|---:|---:|---:|---:|",
    `| ${signedMoney(e.completedTradeNetPnlUsdt)} | ${signedMoney(e.openPositionPartialRealizedNetPnlUsdt)} | ${signedMoney(e.strategyLedgerRealizedNetPnlUsdt)} | ${signedMoney(e.unrealizedPnlUsdt)} | ${money(e.completedTradeCommissionUsdt)} |`,
    `口径：两项“净盈亏”均已扣对应分配手续费；开放仓尚有 ${money(e.openPositionUnallocatedEntryCommissionUsdt)} 入场手续费已从交易所钱包扣除，但尚未分配到未平仓剩余数量的策略实现统计。`,
    `策略到钱包归因桥：${signedMoney(e.strategyLedgerRealizedNetPnlUsdt)} 策略已实现 − ${money(e.openPositionUnallocatedEntryCommissionUsdt)} 未分配入场费 ${Number(e.exchangeFundingFeeUsdt ?? 0) >= 0 ? "+" : "−"} ${money(Math.abs(Number(e.exchangeFundingFeeUsdt ?? 0)))} 资金费 ${Number(e.strategyLedgerCoverageDifferenceUsdt ?? 0) >= 0 ? "+" : "−"} ${money(Math.abs(Number(e.strategyLedgerCoverageDifferenceUsdt ?? 0)))} 成交归属/账本覆盖差额 = ${signedMoney(e.walletBalanceDeltaFromBaselineUsdt)} 钱包变化。`,
    Math.abs(Number(e.strategyLedgerCoverageDifferenceUsdt ?? 0)) < 0.01 ? "策略账本覆盖：已与交易所钱包对齐。" : `策略账本覆盖：存在 ${signedMoney(e.strategyLedgerCoverageDifferenceUsdt)} 成交归属/覆盖差额；这不是账户权益未对账，也不得当作策略利润。`,
    cohortSummary,
    `归因分账：策略结果 ${outcomeAttribution.strategyOutcomes?.closedTradeCount ?? 0} 笔 / ${signedMoney(outcomeAttribution.strategyOutcomes?.realizedNetPnlUsdt)}；执行事故 ${outcomeAttribution.executionIncidents?.closedTradeCount ?? 0} 笔 / ${signedMoney(outcomeAttribution.executionIncidents?.realizedNetPnlUsdt)}。账户总账仍完整保留，不追溯改写。`,
    "",
    "账户与风险",
    "",
    `| 仓位 | 挂单 | 单笔风险 | 组合上限 | 交易所目标档位 | 当前实际 / 最大有效杠杆 | 风险权益上限 |`,
    "|---:|---:|---:|---:|---:|---:|---:|",
    `| ${r.openPositionCount} / ${r.maximumOpenPositionsTotal} | ${r.openOrderCount} | ${(r.maximumRiskPerEntryFraction * 100).toFixed(2)}% | ${(r.maximumPortfolioRiskFraction * 100).toFixed(2)}% | ${r.exchangeInitialLeverageTarget ?? 10}x | ${Number(r.actualEffectiveNotionalLeverage ?? 0).toFixed(2)}x / ${r.maximumLeverage}x | ${money(r.riskEquityCeilingUsdt)} |`,
    `执行一致性：${snapshot.executionReconciliation?.status ?? "MISSING"}｜保护覆盖 ${r.protectedPositionCount ?? 0}/${r.openPositionCount ?? 0}｜普通挂单 ${r.standardOpenOrderCount ?? 0}｜Algo保护单 ${r.protectiveAlgoOrderCount ?? 0}${snapshot.executionReconciliation?.errors?.length ? `｜异常 ${snapshot.executionReconciliation.errors.join("；")}` : ""}`,
    `异常单笔亏损闸门：${lossGate.status ?? "UNKNOWN"}｜新开仓 ${lossGate.entriesBlocked ? "冻结" : "允许"}｜${lossGateTrigger ? `${lossGateTrigger.symbol} 计划最大 ${money(lossGateTrigger.plannedMaximumLossUsdt)} / 实际亏损 ${money(lossGateTrigger.actualLossUsdt)} / ${Number.isFinite(Number(lossGateTrigger.actualLossR)) ? `${Number(lossGateTrigger.actualLossR).toFixed(2)}R` : "R证据缺失"}` : "前向监测正常"}`,
    "",
    formatPositions(snapshot),
    "",
    formatClosedTrades(snapshot),
    "",
    formatCandidates(snapshot, now),
    "",
    strategyRules(snapshot),
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

async function currentSnapshot() {
  const cached = await readJson(V3_LATEST_PATH, null);
  const age = cached?.scannedAt ? Date.now() - Date.parse(cached.scannedAt) : Infinity;
  return age <= 90_000 ? cached : scanV3Once();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const snapshot = await currentSnapshot();
  const view = process.argv[2] ?? "control";
  const output = view === "positions" ? formatPositions(snapshot) : view === "candidates" ? formatCandidates(snapshot) : formatControl(snapshot);
  process.stdout.write(`${output}\n`);
}
