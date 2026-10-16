import path from "node:path";

import { PROJECT_ROOT } from "./context.mjs";
import { round, writeJsonAtomic, writeTextAtomic } from "./utils.mjs";

export const V4_REPORT_ROOT = path.join(PROJECT_ROOT, "backtest_report", "orion-v4-rg1");

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "—";
}

function metric(value, digits = 4) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  return String(round(value, digits));
}

function percent(value) {
  return Number.isFinite(value) ? `${metric(value * 100, 2)}%` : "—";
}

function tableCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownTable(columns, rows) {
  const header = `| ${columns.map(tableCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`).join("\n");
  return `${header}\n${separator}\n${body}`;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows, columns) {
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

export function renderMinimumValidationMarkdown(report) {
  const datasets = Object.values(report.datasetEvidence.datasets);
  const metrics = report.primaryPerformance.metrics;
  const sample = report.primaryPerformance.sampleReview;
  const directionRows = Object.entries(report.primaryPerformance.byDirection).map(([side, values]) => [
    side,
    values.tradeCount,
    values.winCount,
    values.lossCount,
    percent(values.winRate),
    metric(values.cumulativeNormalizedNetPnlUsdt),
    metric(values.totalModeledFrictionCostUsdt),
  ]);
  const foldRows = report.chronologicalValidation.walkForwardFolds.map((fold) => [
    fold.fold,
    iso(fold.startTime),
    iso(fold.endTime),
    fold.metrics.tradeCount,
    metric(fold.metrics.cumulativeNormalizedNetPnlUsdt),
    fold.fixedParametersRelearned ? "是" : "否",
  ]);
  const gateDecision = "保持 Gate 0；禁止晋级或激活";
  return `# V4 区间回归 · RG1｜Gate 0 最小充分验证报告

- 报告 ID：\`${report.reportId}\`
- 报告哈希：\`${report.reportHash}\`
- 策略版本：\`${report.strategy.id}\`
- 实现修订：\`${report.strategy.implementationRevision}\`
- 证据时间：${report.generatedAt}
- 结论：**${gateDecision}**

## 边界结论

本报告只使用公开、完整收盘的 15M／1H／4H OHLC 做本地历史反事实回放。未启动常驻扫描，未生成前向纸面仓，未访问凭据，未发送签名请求或订单，也未读写 V2/V3 的策略、风险、运行时、仓位、订单或账本。归一化每笔 1,000 USDT 名义仅用于可比核算，不是资金或风险授权。

## 数据证据

${markdownTable(
    ["周期", "来源", "起点", "终点（不含）", "K线数", "完整性", "数据集哈希"],
    datasets.map((dataset) => [
      dataset.interval,
      dataset.source,
      iso(dataset.startTime),
      iso(dataset.endTime),
      dataset.barCount,
      dataset.integrity,
      `\`${dataset.hash}\``,
    ]),
  )}

- 跨周期 OHLC 聚合一致性：\`${report.datasetEvidence.crossTimeframeConsistency.status}\`
- 15M→1H 对照：${report.datasetEvidence.crossTimeframeConsistency.comparisons.fifteenMinuteToOneHour} 根
- 1H→4H 对照：${report.datasetEvidence.crossTimeframeConsistency.comparisons.oneHourToFourHour} 根
- 数据缺口策略：发现缺口、重复、乱序、周期长度异常、哈希错误或跨周期不一致即失败关闭，不产出绩效。

## 固定规则与成本

- 1H 区间：48 根滚动极值；上下边界各至少 3 次触碰；ADX14 ≤ 22；24 根收盘 OLS 斜率绝对值 × 24 / ATR14 ≤ 0.15；区间高度为 2–8 ATR14。
- 15M 入场：边界触及或短暂越界后完整收盘回到区间；仅在下一根 15M 开盘进行反事实成交。
- 初损：边界外 0.5 × 15M ATR14；50% 在中线退出，余 50% 在对侧边界退出；1H 收盘越界 0.5 × 1H ATR14 后于下一根 15M 开盘失效退出。
- 成本：每次成交 ${percent(report.fixedRuleContract.costs.takerFeeRatePerFill)} 费用 + ${percent(report.fixedRuleContract.costs.adverseSlippageRatePerFill)} 不利滑点。
- 同K路径：若同一根 15M 同时触及止损和任一目标，整笔从主绩效排除，保留不可变审计事件。

## 样本漏斗

${markdownTable(
    ["指标", "数量"],
    [
      ["可评估 1H 区间快照", report.diagnostics.rangeSnapshots.evaluatedSnapshotCount],
      ["合格区间快照", report.diagnostics.rangeSnapshots.eligibleSnapshotCount],
      ["边界拒绝信号", report.diagnostics.rejectionSignalCount],
      ["完成入场", report.diagnostics.entryCount],
      ["纳入主绩效的完整平仓", report.diagnostics.includedClosedTradeCount],
      ["同K路径未知排除", report.diagnostics.excludedUnknownSameBarPathCount],
      ["数据末端右删失", report.diagnostics.rightCensoredTradeCount],
      ["入场取消", report.diagnostics.cancelledEntryCount],
    ],
  )}

## 主绩效（仅归一化研究账本）

${markdownTable(
    ["完整平仓", "胜", "负", "胜率", "累计净损益 USDT", "费用 USDT", "不利滑点 USDT", "无摩擦损益 USDT", "利润因子"],
    [[
      metrics.tradeCount,
      metrics.winCount,
      metrics.lossCount,
      percent(metrics.winRate),
      metric(metrics.cumulativeNormalizedNetPnlUsdt),
      metric(metrics.totalFeesUsdt),
      metric(metrics.totalAdverseSlippageCostUsdt),
      metric(metrics.frictionlessPnlUsdt),
      metric(metrics.profitFactor),
    ]],
  )}

${markdownTable(
    ["方向", "样本", "胜", "负", "胜率", "累计净损益 USDT", "总摩擦成本 USDT"],
    directionRows,
  )}

样本门槛：完整平仓至少 ${sample.minimumClosedSamplesBeforeRuleReview} 笔，固定方向桶各至少 ${sample.minimumSamplesPerBucket} 笔。当前总样本门槛：\`${sample.closedSampleThresholdMet ? "MET" : "NOT_MET"}\`；LONG：\`${sample.directionBuckets.LONG.thresholdMet ? "MET" : "NOT_MET"}\`；SHORT：\`${sample.directionBuckets.SHORT.thresholdMet ? "MET" : "NOT_MET"}\`。

## 时间隔离验证

- 固定规则、无参数学习；样本外比例：${percent(report.chronologicalValidation.outOfSampleFraction)}。
- 样本内完整平仓：${report.chronologicalValidation.inSample.tradeCount}；归一化净损益：${metric(report.chronologicalValidation.inSample.cumulativeNormalizedNetPnlUsdt)} USDT。
- 样本外完整平仓：${report.chronologicalValidation.outOfSample.tradeCount}；归一化净损益：${metric(report.chronologicalValidation.outOfSample.cumulativeNormalizedNetPnlUsdt)} USDT。

${markdownTable(["折", "起点", "终点", "完整平仓", "归一化净损益 USDT", "重学参数"], foldRows)}

## 审计与阻断项

- 隔离账本事件：${report.auditLedger.eventCount}；链头：\`${report.auditLedger.headHash}\`。
- Gate 1+ 仍缺少 Tick、可执行 BBO、点差、延迟和队列位置证据；资金费、强平路径未建模。
- OHLC 无法证明同K内止损／目标先后；未知路径样本已排除，但这不把其余 OHLC 样本升级为执行证据。
- 当前风险策略仍为 \`NOT_AUTHORIZED_PENDING_OWNER_REVIEW\`，任何前向纸面、测试网、主网、硬风险或生命周期晋级都必须回到 AEGIS 并取得老板新的明确授权。

最终判定：**${gateDecision}**。
`;
}

export async function writeReplayArtifacts(report, { outputRoot = V4_REPORT_ROOT } = {}) {
  const directory = path.join(outputRoot, report.datasetEvidence.symbol, report.reportId);
  const reportPath = path.join(directory, "report.json");
  const markdownPath = path.join(directory, "VALIDATION_REPORT.md");
  const tradesPath = path.join(directory, "included-trades.csv");
  const exclusionsPath = path.join(directory, "excluded-samples.csv");
  await writeJsonAtomic(reportPath, report);
  await writeTextAtomic(markdownPath, renderMinimumValidationMarkdown(report));
  await writeTextAtomic(tradesPath, rowsToCsv(report.trades.included, [
    "id", "side", "signalTime", "entryTime", "exitTime", "exitReason", "entryReferencePrice", "entryPrice",
    "stopPrice", "firstTargetPrice", "secondTargetPrice", "normalizedNotionalUsdt", "feesUsdt",
    "adverseSlippageCostUsdt", "modeledFrictionCostUsdt", "frictionlessPnlUsdt", "netPnlUsdt",
    "netReturnOnNormalizedNotional", "holdingBars15m",
  ]));
  const exclusions = [
    ...report.trades.excludedUnknownSameBarPath.map((item) => ({ ...item, category: "UNKNOWN_SAME_BAR_PATH" })),
    ...report.trades.rightCensored.map((item) => ({ ...item, category: "RIGHT_CENSORED" })),
  ];
  await writeTextAtomic(exclusionsPath, rowsToCsv(exclusions, [
    "id", "category", "status", "side", "rangeId", "signalTime", "entryTime", "ambiguityDetectedAt",
    "censoredAt", "remainingQuantityAtAmbiguity", "remainingQuantity", "exclusionReason",
  ]));
  return { directory, reportPath, markdownPath, tradesPath, exclusionsPath };
}
