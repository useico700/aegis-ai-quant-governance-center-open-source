import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCandidateReport } from "../../../app/v2-ledger/account-shadow/candidate-contract.mjs";
import { DEFAULT_RUNTIME_ROOT, SOURCE_CONFIG_PATH } from "./collector.mjs";
import { acknowledgePendingSummary, preparePendingSummary, readJsonIfPresent, runtimePaths, writeJsonAtomic } from "./persistence.mjs";
import { LocalResourceGuard } from "./resource-guard.mjs";

export const CANDIDATE_ENDPOINT = "https://your-cockpit.example.invalid";

function keychainSecret(account, service) {
  const value = execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (value.length < 32) throw new Error("C_PUBLISH_KEYCHAIN_SECRET_MISSING_OR_SHORT");
  return value;
}

export async function loadPublicationSecrets() {
  const config = JSON.parse(await fs.readFile(SOURCE_CONFIG_PATH, "utf8"));
  return {
    ingestToken: keychainSecret(config.onlineLedger.keychainAccount, config.onlineLedger.keychainService),
    sitesBypassToken: keychainSecret(config.onlineLedger.sitesBypassKeychainAccount, config.onlineLedger.sitesBypassKeychainService),
  };
}

export function rebaseInputHealth(inputHealth, sourceAsOf) {
  const reportTime = Date.parse(sourceAsOf);
  const limits = { baselineAccount: 30_000, eventLedger: 30_000, quote: 1_000, depth: 1_000, funding: 120_000, metadata: 86_400_000 };
  const inputs = {};
  for (const [name, input] of Object.entries(inputHealth.inputs)) {
    const sourceTime = Date.parse(input.sourceAsOf);
    const freshnessMs = Number.isFinite(sourceTime) ? Math.max(0, reportTime - sourceTime) : null;
    const proof = name === "metadata" ? input.sha256 != null : name === "baselineAccount" ? true : input.cursor != null;
    const status = ["GAP", "INVALID"].includes(input.status) ? input.status
      : freshnessMs != null && freshnessMs <= limits[name] && proof ? "HEALTHY" : input.sourceAsOf == null ? "WAITING" : "STALE";
    inputs[name] = { ...input, status, freshnessMs };
  }
  const blockers = Object.entries(inputs).filter(([, input]) => input.status !== "HEALTHY").map(([name]) => `${name.toUpperCase()}_NOT_HEALTHY`);
  return { inputs, blockers };
}

export async function publishOnce({ runtimeRoot = DEFAULT_RUNTIME_ROOT, ingestToken, sitesBypassToken, resourceGuard: providedResourceGuard = null } = {}) {
  const resourceGuard = providedResourceGuard ?? await LocalResourceGuard.create(runtimeRoot);
  if (resourceGuard.status().paused) throw new Error(`LOCAL_RESOURCE_PAUSED_${resourceGuard.status().pauseReason ?? "LATCHED"}`);
  const paths = runtimePaths(runtimeRoot);
  const state = await readJsonIfPresent(paths.state);
  if (!state?.lastInputHealth) throw new Error("C_PUBLISH_STATE_OR_INPUT_HEALTH_MISSING");
  const sourceAsOf = new Date().toISOString();
  const inputHealth = rebaseInputHealth(state.lastInputHealth, sourceAsOf);
  const pending = await preparePendingSummary({ state, inputHealth, sourceAsOf, pendingPath: paths.pendingSummary });
  validateCandidateReport(pending.payload, Date.now());
  const response = await fetch(CANDIDATE_ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "oai-sites-authorization": `Bearer ${sitesBypassToken}`,
      "content-type": "application/json",
      "user-agent": "orion-v2-account-shadow-c/1.0-read-only",
    },
    body: JSON.stringify(pending.payload),
  });
  const body = await response.json().catch(() => ({}));
  const accepted = response.status === 200 && ["STORED_OBSERVE_ONLY", "IDEMPOTENT_DUPLICATE"].includes(body.status);
  if (!accepted) {
    await writeJsonAtomic(path.join(runtimeRoot, "publisher-status.json"), { status: "PENDING_RETRY", at: new Date().toISOString(), sequence: pending.sequence, httpStatus: response.status, responseStatus: body.status ?? null, digest: pending.digest });
    throw new Error(`C_PUBLISH_HTTP_${response.status}_${body.error ?? body.status ?? "UNKNOWN"}`);
  }
  const next = await acknowledgePendingSummary({ state, statePath: paths.state, pendingPath: paths.pendingSummary, acknowledgedPath: paths.acknowledgedSummaries, sequence: pending.sequence, digest: pending.digest, acknowledgedAt: new Date().toISOString() });
  const status = { status: "ACKNOWLEDGED", at: new Date().toISOString(), sequence: pending.sequence, sourceAsOf: pending.sourceAsOf, httpStatus: response.status, responseStatus: body.status, digest: pending.digest };
  await writeJsonAtomic(path.join(runtimeRoot, "publisher-status.json"), status);
  return { state: next, ...status };
}

async function main() {
  const secrets = await loadPublicationSecrets();
  const result = await publishOnce({ ...secrets });
  console.log(JSON.stringify({ status: result.status, at: result.at, sequence: result.sequence, sourceAsOf: result.sourceAsOf, httpStatus: result.httpStatus, responseStatus: result.responseStatus, digest: result.digest }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
