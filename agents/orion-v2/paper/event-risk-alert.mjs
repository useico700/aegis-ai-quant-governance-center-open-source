import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextTier1EventWindow, tier1EventWindowAt } from "./event-risk.mjs";
import { readJson, sleep, writeJsonAtomic } from "./runtime-utils.mjs";

const PAPER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(PAPER_ROOT, "../../..");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx");
const PATHS = {
  runtime: path.join(PAPER_ROOT, "config.json"),
  calendar: path.join(PROJECT_ROOT, "agents/nexus/data/mtfx-tier1-event-calendar.json"),
  state: path.join(RUNTIME_ROOT, "alerts/event-risk-last-sent.json"),
  log: path.join(RUNTIME_ROOT, "alerts/event-risk-notifications.ndjson"),
};

function formatCst(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value)).replace(/\//g, "/");
}

export function eventWindowNotification(eventWindow) {
  const names = eventWindow.events.map((event) => event.name).join(" / ");
  return {
    title: "ORION V2｜重要数据窗口",
    message: `${names}：已冻结新纸面开仓（${formatCst(eventWindow.windowStart)}–${formatCst(eventWindow.windowEnd)} CST）；现有仓位按原规则管理。`,
  };
}

function sendMacNotification(notification) {
  // Arguments, rather than a shell string, prevent event names from becoming code.
  execFileSync("/usr/bin/osascript", ["-e", `display notification ${JSON.stringify(notification.message)} with title ${JSON.stringify(notification.title)}`], {
    stdio: "ignore",
    timeout: 5_000,
  });
}

export async function checkOnce({ now = Date.now(), notify = sendMacNotification } = {}) {
  const [runtime, calendar, prior] = await Promise.all([
    readJson(PATHS.runtime, null),
    readJson(PATHS.calendar, null),
    readJson(PATHS.state, { schemaVersion: 1, sentWindowKeys: [] }),
  ]);
  const eventWindow = tier1EventWindowAt({ now, policy: runtime?.eventRisk, calendar });
  const next = nextTier1EventWindow({ now, policy: runtime?.eventRisk, calendar });
  if (!eventWindow.active) return { status: "NO_ACTIVE_EVENT_WINDOW", next };
  const windowKey = `${eventWindow.eventIds.join("+")}@${eventWindow.windowStart}`;
  const sentWindowKeys = Array.isArray(prior?.sentWindowKeys) ? prior.sentWindowKeys : [];
  if (sentWindowKeys.includes(windowKey)) return { status: "ALREADY_NOTIFIED", eventWindow, next };
  const notification = eventWindowNotification(eventWindow);
  notify(notification);
  const nextState = {
    schemaVersion: 1,
    sentWindowKeys: [...sentWindowKeys, windowKey].slice(-100),
    lastSentAt: new Date(now).toISOString(),
    lastEventIds: eventWindow.eventIds,
    lastWindowStart: eventWindow.windowStart,
  };
  await fs.mkdir(path.dirname(PATHS.log), { recursive: true });
  await Promise.all([
    writeJsonAtomic(PATHS.state, nextState),
    fs.appendFile(PATHS.log, `${JSON.stringify({ at: new Date(now).toISOString(), windowKey, eventIds: eventWindow.eventIds, notification })}\n`),
  ]);
  return { status: "NOTIFIED", eventWindow, next };
}

async function watch() {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (!stopping) {
    try {
      await checkOnce();
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ type: "MTFX_EVENT_RISK_NOTIFIER_ERROR", message: error.message, at: new Date().toISOString() })}\n`);
    }
    await sleep(30_000);
  }
}

const command = process.argv[2] ?? "check";
if (command === "watch") {
  await watch();
} else if (command === "check") {
  process.stdout.write(`${JSON.stringify(await checkOnce())}\n`);
} else {
  process.stderr.write("Usage: event-risk-alert.mjs check|watch\n");
  process.exitCode = 2;
}
