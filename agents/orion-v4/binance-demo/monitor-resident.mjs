import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import monitorConfig from "./monitor-config.json" with { type: "json" };
import { publishCurrentV4Monitor } from "./monitor-publisher.mjs";
import { writeJsonAtomic } from "./runtime-utils.mjs";
import { V4_RUNTIME_ROOT } from "./snapshot.mjs";

export const V4_MONITOR_PID_PATH = path.join(V4_RUNTIME_ROOT, "monitor-resident.pid.json");
const intervalMs = Math.max(15_000, Number(monitorConfig.publishIntervalMs) || 60_000);
const processStartedAt = new Date().toISOString();
let stopping = false;

async function writeStatus(status, detail = {}) {
  await writeJsonAtomic(V4_MONITOR_PID_PATH, {
    schemaVersion: 1,
    pid: process.pid,
    status,
    role: "READ_ONLY_V4_MONITOR_PUBLISHER",
    startedAt: processStartedAt,
    updatedAt: new Date().toISOString(),
    ...detail,
  });
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  await writeStatus("STOPPED", { stoppedAt: new Date().toISOString(), signal }).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

async function run() {
  await fs.mkdir(V4_RUNTIME_ROOT, { recursive: true });
  await writeStatus("STARTING");
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const sync = await publishCurrentV4Monitor();
      await writeStatus("RUNNING", {
        lastSuccessfulPublishAt: new Date().toISOString(),
        sourceAsOf: sync.sourceAsOf,
        receivedAt: sync.receivedAt,
        lastError: null,
      });
    } catch (error) {
      await writeStatus("SYNC_DEFERRED", {
        lastFailedPublishAt: new Date().toISOString(),
        lastError: error?.message ?? String(error),
      }).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, intervalMs - (Date.now() - startedAt))));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
