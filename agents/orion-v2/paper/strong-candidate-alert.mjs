import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_STATE_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/state.json");
const DEFAULT_ALERT_STATE_PATH = path.join(PROJECT_ROOT, ".runtime/orion-v2-mtfx/alerts/strong-candidate-last-sent.json");

export const STRONG_CANDIDATE_POLICY = Object.freeze({
  maximumLeadMs: 72 * 60 * 60 * 1000,
  minimumFourHourSpan15m: 96,
  minimumOneHourSpan15m: 24,
  minimumFourHourProminenceFraction: 0.12,
  minimumOneHourProminenceFraction: 0.10,
  minimumFourHourPairMoveFraction: 0.03,
  minimumOneHourPairMoveFraction: 0.015,
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function candidateKey(plan) {
  return `${plan.id}:${plan.version ?? 1}:${plan.lockedBarOpenTime}`;
}

export function isStrongCandidate(plan, now = Date.now(), policy = STRONG_CANDIDATE_POLICY) {
  const intersectionTime = finite(plan?.intersectionTime);
  const scale = plan?.scale ?? {};
  if (!plan?.id || plan.frozen || intersectionTime === null || intersectionTime <= now) return false;
  if (intersectionTime - now > policy.maximumLeadMs) return false;
  return finite(scale.fourHourSpan15m) >= policy.minimumFourHourSpan15m
    && finite(scale.oneHourSpan15m) >= policy.minimumOneHourSpan15m
    && finite(scale.fourHourAnchorProminenceFraction) >= policy.minimumFourHourProminenceFraction
    && finite(scale.oneHourAnchorProminenceFraction) >= policy.minimumOneHourProminenceFraction
    && finite(scale.fourHourPairMoveFraction) >= policy.minimumFourHourPairMoveFraction
    && finite(scale.oneHourPairMoveFraction) >= policy.minimumOneHourPairMoveFraction;
}

export function selectStrongCandidates(state, sentKeys = [], now = Date.now(), policy = STRONG_CANDIDATE_POLICY) {
  const sent = new Set(sentKeys);
  return Object.values(state?.plans ?? {})
    .filter((plan) => isStrongCandidate(plan, now, policy) && !sent.has(candidateKey(plan)))
    .sort((first, second) => Number(second.scale?.importance ?? 0) - Number(first.scale?.importance ?? 0));
}

function formatCst(timestamp) {
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

export function renderStrongCandidate(plan) {
  const anchors = Array.isArray(plan.anchors) ? plan.anchors : [];
  const four = anchors.slice(0, 2).map((anchor) => `${anchor.type} ${anchor.price}（${formatCst(anchor.time)}）`).join("；");
  const one = anchors.slice(2, 4).map((anchor) => `${anchor.type} ${anchor.price}（${formatCst(anchor.time)}）`).join("；");
  return [
    `强候选提醒｜${plan.symbol}`,
    `形态：${plan.pattern}｜4H线状态：${plan.fourHourLineStatus}`,
    `4H锚点：${four || "未提供"}`,
    `1H锚点：${one || "未提供"}`,
    `数学交叉：${formatCst(plan.intersectionTime)} CST｜价格约 ${Number(plan.intersectionPrice).toFixed(6)}`,
    `15M确认储备开始：${formatCst(plan.lockedBarOpenTime)} CST`,
    "当前仅为未来候选；交汇后最多等待4根15M，以首个合格的单根或2至3根连续价格接受形态确定纸面方向。",
  ].join("\n");
}

async function readJson(target, fallback) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, target);
}

async function main() {
  const command = process.argv[2] ?? "check";
  const statePath = process.env.MTFX_STATE_PATH ?? DEFAULT_STATE_PATH;
  const alertStatePath = process.env.MTFX_ALERT_STATE_PATH ?? DEFAULT_ALERT_STATE_PATH;
  const now = Date.now();
  const state = await readJson(statePath, null);
  if (!state) throw new Error(`MTFX_STATE_MISSING: ${statePath}`);
  const alertState = await readJson(alertStatePath, { schemaVersion: 1, sentKeys: [] });
  const eligible = Object.values(state.plans ?? {}).filter((plan) => isStrongCandidate(plan, now));

  if (command === "ack-current") {
    const sentKeys = [...new Set([...(alertState.sentKeys ?? []), ...eligible.map(candidateKey)])].slice(-100);
    await writeJsonAtomic(alertStatePath, { schemaVersion: 1, sentKeys, updatedAt: new Date(now).toISOString() });
    process.stdout.write(`${JSON.stringify({ acknowledged: eligible.map(candidateKey) })}\n`);
    return;
  }

  if (command === "status") {
    process.stdout.write(`${JSON.stringify({ eligible: eligible.map(candidateKey), sentKeys: alertState.sentKeys ?? [] }, null, 2)}\n`);
    return;
  }

  if (command !== "check") throw new Error(`UNKNOWN_COMMAND: ${command}`);
  const candidates = selectStrongCandidates(state, alertState.sentKeys ?? [], now);
  if (candidates.length === 0) {
    process.stdout.write("NO_REPLY\n");
    return;
  }

  const selected = candidates[0];
  const sentKeys = [...new Set([...(alertState.sentKeys ?? []), candidateKey(selected)])].slice(-100);
  await writeJsonAtomic(alertStatePath, { schemaVersion: 1, sentKeys, updatedAt: new Date(now).toISOString() });
  process.stdout.write(`${renderStrongCandidate(selected)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
