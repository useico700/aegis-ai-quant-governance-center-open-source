import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { collectOnce, DEFAULT_RUNTIME_ROOT, invalidateHealthyFrame, invalidateRuntimeCaches } from "./collector.mjs";
import { loadPublicationSecrets, publishOnce } from "./publisher.mjs";
import { writeJsonAtomic } from "./persistence.mjs";
import { calculateRuntimeSourceHash } from "./runtime-source.mjs";
import { LocalResourceGuard } from "./resource-guard.mjs";

export async function runResident({ runtimeRoot = DEFAULT_RUNTIME_ROOT, intervalMs = 15_000 } = {}) {
  const secrets = await loadPublicationSecrets();
  const runtimeSource = await calculateRuntimeSourceHash();
  let resourceGuard = await LocalResourceGuard.create(runtimeRoot);
  for (;;) {
    const cycleStartedAt = new Date().toISOString();
    try {
      const collected = await collectOnce({ runtimeRoot, resourceGuard });
      const published = await publishOnce({ runtimeRoot, resourceGuard, ...secrets });
      const evidenceHold = collected.state.blockers.length > 0 || collected.inputHealth.blockers.length > 0;
      await writeJsonAtomic(path.join(runtimeRoot, "resident-health.json"), { status: evidenceHold ? "RUNNING_EVIDENCE_HOLD" : "HEALTHY_OBSERVE_ONLY", pid: process.pid, runtimeSourceSha256: runtimeSource.sha256, cycleStartedAt, completedAt: new Date().toISOString(), collectorCycle: collected.state.lastCollectorCycleAt, publicationSequence: published.sequence, publisherStatus: published.responseStatus, blockers: [...new Set([...collected.state.blockers, ...collected.inputHealth.blockers])] });
    } catch (error) {
      if (error.message.startsWith("LOCAL_RESOURCE_PAUSED_")) {
        await resourceGuard.writeControlJson(path.join(runtimeRoot, "resident-health.json"), { status: "LOCAL_RESOURCE_PAUSED", pid: process.pid, runtimeSourceSha256: runtimeSource.sha256, cycleStartedAt, pausedAt: new Date().toISOString(), error: error.message, automaticResumeAllowed: false });
        return;
      }
      if (resourceGuard.unsafe) {
        invalidateRuntimeCaches(runtimeRoot);
        resourceGuard = await LocalResourceGuard.create(runtimeRoot);
      }
      await invalidateHealthyFrame(runtimeRoot, `RESIDENT_CYCLE_FAILED_${error.message}`);
      await writeJsonAtomic(path.join(runtimeRoot, "resident-health.json"), { status: "FAIL_CLOSED_RETRYING", pid: process.pid, runtimeSourceSha256: runtimeSource.sha256, cycleStartedAt, failedAt: new Date().toISOString(), error: error.message });
    }
    await delay(intervalMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runResident().catch((error) => { console.error(error.message); process.exitCode = 1; });
