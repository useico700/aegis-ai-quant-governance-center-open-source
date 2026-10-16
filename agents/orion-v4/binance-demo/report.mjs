import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { fileURLToPath } from "node:url";

import { readJson } from "./runtime-utils.mjs";
import { V4_LATEST_PATH, scanV4Once } from "./snapshot.mjs";

const cst = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const time = (value) => value ? `${cst.format(new Date(value)).replaceAll("/", "-")} CST` : "—";
const money = (value) => `${Number(value ?? 0).toFixed(2)} USDT`;
const price = (value) => Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 8 });

export function formatV4Positions(snapshot) {
  const managed = new Map((snapshot.managedPositions ?? []).map((row) => [row.symbol, row]));
  const lines = ["ORION V4｜MTFX 仓位", `数据：${time(snapshot.accountObservedAt)}｜${snapshot.positions.length}/${snapshot.risk.maximumOpenPositionsTotal} 仓｜保护 ${snapshot.risk.protectedPositionCount}/${snapshot.positions.length}`, "", "| 标的 | 方向 | 数量 | 入场 | 标记 | 浮盈亏 | 保护止损 | 阶段 |", "|---|---:|---:|---:|---:|---:|---:|---|"];
  if (!snapshot.positions.length) lines.push("| 当前空仓 | — | — | — | — | 0.00 USDT | — | — |");
  for (const row of snapshot.positions) { const meta = managed.get(row.symbol); lines.push(`| ${row.symbol} | ${row.side === "SHORT" ? "空" : "多"} | ${price(row.quantity)} | ${price(row.entryPrice)} | ${price(row.markPrice)} | ${money(row.unrealizedProfitUsdt)} | ${price(meta?.stopPrice ?? meta?.stop)} | ${meta?.stage ?? "初始仓"} |`); }
  return lines.join("\n");
}

export function formatV4Candidates(snapshot) {
  const lines = ["ORION V4｜MTFX 候选", `来源：V4 固化的 R20 交易副本｜扫描 ${time(snapshot.scannedAt)}`, "", "| 标的 | 交汇时间 | 交汇价 | 结构 | 状态 | 15M信号 |", "|---|---:|---:|---|---|---|"];
  for (const row of snapshot.plans ?? []) lines.push(`| ${row.symbol} | ${time(row.plan?.intersectionTime)} | ${price(row.plan?.intersectionPrice)} | ${row.plan?.pattern ?? "—"} | ${row.assessment?.reason ?? "—"} | ${row.signal?.status ?? "NO_SIGNAL"} |`);
  return lines.join("\n");
}

export function formatV4Control(snapshot) {
  return ["ORION V4｜MTFX 交易控制台", `运行：${snapshot.lifecycle}｜${snapshot.strategyVersion}｜${snapshot.implementationRevision}`, `账户权益 ${money(snapshot.account?.totalMarginBalanceUsdt)}｜钱包 ${money(snapshot.account?.totalWalletBalanceUsdt)}｜浮盈亏 ${money(snapshot.account?.totalUnrealizedProfitUsdt)}`, `执行一致性：${snapshot.executionReconciliation.status}｜实际有效杠杆 ${snapshot.risk.actualEffectiveNotionalLeverage.toFixed(2)}x / ${snapshot.risk.maximumEffectiveNotionalLeverage}x`, `候选：${snapshot.planCount} 个交汇计划｜${snapshot.confirmedSignalCount} 个已确认信号`, "", formatV4Positions(snapshot), "", formatV4Candidates(snapshot), "", "规则：V2 MTFX R22 全量同步；4H/1H价格时间交汇，15M首个合格收盘锁向；因果BBO执行，50bps、180秒、完整成本≤0.12R；0.5R/1R/2R分别落袋40%/25%/20%，剩15%跟踪；单笔1%、组合5%、最多10仓、4x有效名义杠杆；V4账户、仓位、订单与账本独立。"].join("\n");
}

async function current() { const cached = await readJson(V4_LATEST_PATH, null); return cached?.scannedAt && Date.now() - Date.parse(cached.scannedAt) <= 90_000 ? cached : scanV4Once(); }
if (process.argv[1] === fileURLToPath(import.meta.url)) { const snapshot = await current(); const view = process.argv[2] ?? "control"; process.stdout.write(`${view === "positions" ? formatV4Positions(snapshot) : view === "candidates" ? formatV4Candidates(snapshot) : formatV4Control(snapshot)}\n`); }
