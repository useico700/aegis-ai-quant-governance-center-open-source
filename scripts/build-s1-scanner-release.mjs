import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "dist-production");
const FILES = [
  "package.json",
  "agents/orion-live/AGENTS.md",
  "agents/orion-live/s1-scanner/config.json",
  "agents/orion-live/s1-scanner/engine.mjs",
  "agents/orion-live/s1-scanner/candidate-lifecycle.mjs",
  "agents/orion-live/s1-scanner/candidate-selection.mjs",
  "governance/owner-authorizations/2026-10-13-s1-candidate-selection.json",
  "agents/orion-live/s1-scanner/candidate-discovery.mjs",
  "agents/orion-live/s1-scanner/intersection-geometry.mjs",
  "governance/owner-authorizations/2026-10-12-s1-untouched-intersections.json",
  "governance/owner-authorizations/2026-10-11-s1-intersection-lifecycle-repair.json",
  "agents/orion-live/s1-scanner/event-gate.mjs",
  "agents/orion-live/s1-scanner/resident.mjs",
  "agents/orion-live/s1-scanner/coordinated-resident.mjs",
  "agents/orion-live/s1-scanner/coordinated-host.mjs",
  "agents/orion-live/binance-prod/runtime-utils.mjs",
  "agents/orion-live/s1-execution/coordinated-public-reads.mjs",
  "agents/orion-live/s1-execution/shadow-shutdown.mjs",
  "lib/s1-precision.mjs",
  "lib/exchange-json.mjs",
  "agents/shared/px-band-risk-only.mjs",
  "agents/shared/px-first-close.mjs",
  "lib/s1-account.mjs",
  "agents/orion-live/s1-execution/admitted-http.mjs",
  "agents/orion-live/s1-execution/request-budget.mjs",
  "agents/orion-live/s1-execution/common.mjs",
  "agents/orion-live/s1-execution/shared-read-budget.mjs",
  "agents/orion-live/s1-execution/host-admission.mjs",
  "agents/orion-live/s1-execution/coordinated-host-admission.mjs",
  "agents/orion-live/s1-execution/coordinated-read-session.mjs",
  "agents/orion-live/s1-execution/coordinated-read-budget.mjs",
  "agents/orion-live/s1-execution/intent-read-bridge.mjs",
  "agents/orion-live/s1-execution/read-request-bindings.mjs",
  "agents/orion-live/s1-execution/bounded-read-dispatch.mjs",
  "agents/orion-live/s1-execution/read-deadline-planner.mjs",
  "agents/orion-live/s1-execution/read-intent-catalog.mjs",
  "agents/orion-live/s1-execution/transport.mjs",
  "agents/orion-live/s1-execution/bounded-http.mjs",
  "agents/orion-live/s1-execution/bootstrap-receipt.mjs",
  "agents/orion-v2/paper/paper-engine.mjs",
  "agents/orion-v2/paper/runtime-utils.mjs",
  "scripts/v2-mtf-trendline-intersection.mjs",
  "ops/demo-server/aegis-s1-scanner.service",
  "ops/demo-server/s1-supervisor.mjs",
  "ops/demo-server/s1-scanner.compose.yaml",
  "governance/owner-authorizations/2026-09-11-s1-resume-sync.json",
  "governance/owner-authorizations/2026-09-11-demo-server-replacement.json",
  "governance/owner-authorizations/2026-09-10-s1-r22-scanner-monitor.json",
  "governance/owner-authorizations/2026-09-10-s1-risk-calendar-entry-window.json",
  "governance/owner-authorizations/2026-09-10-s1-exchange-precision-calibration.json"
];

const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const now = new Date();
const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "aegis-s1-release-"));
const releaseRoot = path.join(work, "release");
const manifestFiles = [];
try {
  for (const relative of FILES) {
    const source = path.join(ROOT, relative);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('UNSAFE_RELEASE_INPUT');
    const target = path.join(releaseRoot, relative);
    const data = await fs.readFile(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    manifestFiles.push({ path: relative, bytes: data.length, sha256: hash(data) });
  }
  const sourceFingerprint = hash(Buffer.from(manifestFiles.map((row) => `${row.sha256}  ${row.path}`).join("\n")));
  const releaseId = `aegis-s1-scanner-${timestamp}-${sourceFingerprint.slice(0, 12)}`;
  const manifest = {
    schemaVersion: 1,
    releaseId,
    generatedAt: now.toISOString(),
    mode: "S1_R22_SCAN_ONLY",
    realOrdersAllowed: false,
    historicalRuntimeIncluded: false,
    secretsIncluded: false,
    sourceFingerprint,
    files: manifestFiles,
  };
  await fs.writeFile(path.join(releaseRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await fs.mkdir(OUTPUT, { recursive: true });
  const archive = path.join(OUTPUT, `${releaseId}.tar.gz`);
  execFileSync("/usr/bin/tar", ["--no-xattrs", "-czf", archive, "-C", releaseRoot, "."], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const archiveData = await fs.readFile(archive);
  const archiveHash = hash(archiveData);
  await fs.writeFile(`${archive}.sha256`, `${archiveHash}  ${path.basename(archive)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ releaseId, archive, archiveSha256: archiveHash, sourceFingerprint, fileCount: manifestFiles.length, archiveBytes: archiveData.length }, null, 2)}\n`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
