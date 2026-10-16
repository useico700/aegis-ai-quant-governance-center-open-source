import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import presentationContract from "../../../governance/presentation-contracts/mtfx-presentation-contract-v1.json" with { type: "json" };

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_LEDGER_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/ledger.ndjson");
const DEFAULT_ALERT_STATE_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/alerts/paper-entry-last-sent.json");
const DEFAULT_NOTIFICATION_LOG_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/alerts/paper-entry-notifications.ndjson");
const DEFAULT_WATCH_INTERVAL_MS = 1000;
const execFileAsync = promisify(execFile);

function formatCst(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(Number(timestamp)));
}

function price(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (Math.abs(numeric) < 0.01) return numeric.toFixed(6);
  if (Math.abs(numeric) < 1) return numeric.toFixed(5);
  return numeric.toFixed(2);
}

export function entryEventKey(record) {
  return String(record?.eventId ?? "");
}

export function selectUnsentPaperEntries(records, sentEventIds = []) {
  const sent = new Set(sentEventIds);
  return (records ?? []).filter((record) =>
    record?.type === "PAPER_POSITION_OPENED" && entryEventKey(record) && !sent.has(entryEventKey(record))
  ).sort((first, second) => Number(first.sequence) - Number(second.sequence));
}

export function renderPaperEntryAlert(record) {
  const position = record.payload ?? {};
  const confirmation = position.confirmationPattern ?? {};
  const composite = confirmation.composite ?? {};
  const structure = position.protectiveStructure ?? {};
  const entryBbo = position.entryBbo ?? {};
  const openedAt = Number(position.openedAt ?? record.marketTime);
  const signalBarOpenTime = Number(position.signalBarOpenTime);
  const signalBarCloseTime = Number(position.signalBarCloseTime);
  const executionSide = Number(position.direction) === 1 ? "Ask 侧" : "Bid 侧";
  const fixedPxStop = String(position.implementationRevision ?? "").includes("R12-TWO-BAR-CROSS-CLOSE-BUFFER-STOP");
  const bboLine = Number.isFinite(Number(entryBbo.ask))
    ? `成交BBO：买 ${price(entryBbo.bid)} / 卖 ${price(entryBbo.ask)}｜执行价含不利滑点`
    : "成交BBO：审计载荷未提供";
  const confirmationLine = Number.isFinite(Number(composite.close))
    ? `15M确认：第 ${confirmation.acceptedReserveBarNumber ?? "—"} 根｜O ${price(composite.open)} H ${price(composite.high)} L ${price(composite.low)} C ${price(composite.close)}`
    : "15M确认：审计载荷未提供";
  const structureLine = Number.isFinite(Number(structure.secondEarlier?.price)) && Number.isFinite(Number(structure.firstNearest?.price))
    ? `保护结构：前低 ${price(structure.secondEarlier.price)} → 近低 ${price(structure.firstNearest.price)}｜0.618 止损`
    : "保护结构：按已确认结构计算初始止损";
  const stopBasisLine = fixedPxStop
    ? `初始止损依据：P× ${Number(position.direction) === 1 ? "−" : "+"} 5bps 固定缓冲｜不等待1H结构`
    : structureLine;
  return [
    `V2纸面开仓｜${presentationContract.views.ENTRY.header}｜${position.symbol ?? "—"} ${Number(position.direction) === 1 ? "做多" : "做空"}`,
    `播报契约：${presentationContract.contractId}｜策略：${position.strategyVersion ?? "—"}｜运行修订：${position.implementationRevision ?? "—"}`,
    `成交时间：${formatCst(openedAt)} CST｜账本入账：${formatCst(record.marketTime)} CST｜账本：${position.book ?? "—"}`,
    `入场位置：${price(position.entry)} USDT｜${executionSide}成交｜纸面仓位`,
    confirmationLine,
    Number.isFinite(signalBarOpenTime) && Number.isFinite(signalBarCloseTime)
      ? `触发15M：${formatCst(signalBarOpenTime)} → ${formatCst(signalBarCloseTime)} CST`
      : "触发15M：审计载荷未提供",
    `交汇：${formatCst(position.intersectionTime)} CST｜P× ${price(position.intersectionPrice)}`,
    bboLine,
    `初始止损：${price(position.initialStop)}｜计划风险：${Number(position.initialPlannedRiskUsdt ?? position.plannedRiskUsdt ?? 0).toFixed(2)} USDT`,
    stopBasisLine,
    position.implementationRevision === "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION"
      ? `管理：净+0.5R ${price(position.softLockPrice)} 平40%并保护合计+0.15R｜净+1R ${price(position.oneRPrice)} 再平25%并保护合计+0.60R｜净+2R ${price(position.twoRPrice)} 再平20%｜余15%跟随1H/已收15M ATR较紧者`
      : ["MTFX-0.5.0-R17-SOFT-PROFIT-LOCK", "MTFX-0.5.0-R18-ENTRY-QUALITY-GUARDS", "MTFX-0.5.0-R19-CONFIRMED-CLOSE-ENTRY-GUARD", "MTFX-0.5.0-R20-COST-EFFICIENCY-GATE", "MTFX-0.5.0-R21-ALT-PROFIT-RETENTION"].includes(position.implementationRevision)
        ? `管理：净+0.5R ${price(position.softLockPrice)} 平20%并软锁利｜净+1R ${price(position.oneRPrice)} 再平30%并锁定组合+0.5R｜净+2R ${price(position.twoRPrice)} 再平25%｜余25%跟随1H`
        : `管理：净+1R ${price(position.oneRPrice)} 平50%并保本｜净+2R ${price(position.twoRPrice)} 再平25%｜余25%跟随1H`,
    `纸面交易｜订单：${position.id ?? record.eventId}`,
  ].join("\n");
}

async function readJson(target, fallback) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readLedger(target) {
  try {
    const raw = await fs.readFile(target, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, target);
}

async function appendLine(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(value)}\n`);
}

export async function deliverMacOsEntryNotification(message) {
  await execFileAsync("/usr/bin/osascript", [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title \"ORION V2 纸面进场\"",
    "-e", "end run",
    message,
  ], { timeout: 10_000 });
}

export async function notifyPendingPaperEntries({
  ledgerPath = DEFAULT_LEDGER_PATH,
  alertStatePath = DEFAULT_ALERT_STATE_PATH,
  notificationLogPath = DEFAULT_NOTIFICATION_LOG_PATH,
  deliver = deliverMacOsEntryNotification,
} = {}) {
  const [records, alertState] = await Promise.all([
    readLedger(ledgerPath),
    readJson(alertStatePath, { schemaVersion: 1, sentEventIds: [] }),
  ]);
  const pending = selectUnsentPaperEntries(records, alertState.sentEventIds ?? []);
  if (pending.length === 0) return { notified: 0, eventIds: [] };
  for (const record of pending) {
    await deliver(renderPaperEntryAlert(record));
    await appendLine(notificationLogPath, {
      eventId: entryEventKey(record),
      positionId: record.payload?.id ?? null,
      symbol: record.payload?.symbol ?? null,
      channel: "MACOS_USER_NOTIFICATION",
      notifiedAt: new Date().toISOString(),
    });
  }
  const sentEventIds = [...new Set([...(alertState.sentEventIds ?? []), ...pending.map(entryEventKey)])].slice(-2000);
  await writeJsonAtomic(alertStatePath, { schemaVersion: 1, sentEventIds, updatedAt: new Date().toISOString() });
  return { notified: pending.length, eventIds: pending.map(entryEventKey) };
}

export async function watchPaperEntryNotifications(options = {}) {
  const intervalMs = Math.max(250, Number(options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS));
  const shouldStop = options.shouldStop ?? (() => false);
  const onError = options.onError ?? ((error) => console.error(error.stack ?? error.message));
  while (!shouldStop()) {
    try {
      await notifyPendingPaperEntries(options);
    } catch (error) {
      onError(error);
    }
    if (shouldStop()) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const command = process.argv[2] ?? "check";
  const ledgerPath = process.env.MTFX_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
  const alertStatePath = process.env.MTFX_ENTRY_ALERT_STATE_PATH ?? DEFAULT_ALERT_STATE_PATH;
  const notificationLogPath = process.env.MTFX_ENTRY_NOTIFICATION_LOG_PATH ?? DEFAULT_NOTIFICATION_LOG_PATH;
  const [records, alertState] = await Promise.all([
    readLedger(ledgerPath),
    readJson(alertStatePath, { schemaVersion: 1, sentEventIds: [] }),
  ]);
  const entryRecords = records.filter((record) => record?.type === "PAPER_POSITION_OPENED" && entryEventKey(record));

  if (command === "ack-current") {
    const sentEventIds = [...new Set([...(alertState.sentEventIds ?? []), ...entryRecords.map(entryEventKey)])].slice(-2000);
    await writeJsonAtomic(alertStatePath, { schemaVersion: 1, sentEventIds, updatedAt: new Date().toISOString() });
    process.stdout.write(`${JSON.stringify({ acknowledged: entryRecords.map(entryEventKey) })}\n`);
    return;
  }

  if (command === "status") {
    const pending = selectUnsentPaperEntries(records, alertState.sentEventIds ?? []);
    process.stdout.write(`${JSON.stringify({ pending: pending.map(entryEventKey), sentEventIds: alertState.sentEventIds ?? [] }, null, 2)}\n`);
    return;
  }

  if (command === "watch") {
    let stopping = false;
    process.once("SIGTERM", () => { stopping = true; });
    process.once("SIGINT", () => { stopping = true; });
    await watchPaperEntryNotifications({
      ledgerPath,
      alertStatePath,
      notificationLogPath,
      intervalMs: Number(process.env.MTFX_ENTRY_WATCH_INTERVAL_MS ?? DEFAULT_WATCH_INTERVAL_MS),
      shouldStop: () => stopping,
    });
    return;
  }

  if (!["check", "notify"].includes(command)) throw new Error(`UNKNOWN_COMMAND: ${command}`);
  const pending = selectUnsentPaperEntries(records, alertState.sentEventIds ?? []);
  if (pending.length === 0) {
    if (command === "check") process.stdout.write("NO_REPLY\n");
    return;
  }
  if (command === "notify") {
    await notifyPendingPaperEntries({ ledgerPath, alertStatePath, notificationLogPath });
    return;
  }
  const sentEventIds = [...new Set([...(alertState.sentEventIds ?? []), ...pending.map(entryEventKey)])].slice(-2000);
  await writeJsonAtomic(alertStatePath, { schemaVersion: 1, sentEventIds, updatedAt: new Date().toISOString() });
  if (command === "check") process.stdout.write(`${pending.map(renderPaperEntryAlert).join("\n\n")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
