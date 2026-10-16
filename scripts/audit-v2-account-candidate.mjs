import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
// Read-only governance audit. This module never initializes ledgers, controls
// processes, reads credentials, connects to an exchange, or publishes data.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { validateCandidateReport } from "../app/v2-ledger/account-shadow/candidate-contract.mjs";
import { calculateRuntimeSourceHash } from "../agents/orion-v2/account-shadow/runtime-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const optionalJson = async (file) => { try { return await readJson(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

export async function verifyLedgerFile(file, domain, { maximumBytes = 512 * 1024 * 1024, maximumIds = 1_000_000 } = {}) {
  const before = await fs.stat(file);
  if (before.size > maximumBytes) return { domain, status:"AUDIT_SIZE_BOUND_EXCEEDED", bytes:before.size };
  if (!before.size) return { domain, status:"VERIFIED_EMPTY", sequence:0, hash:"GENESIS", bytes:0 };
  const handle = await fs.open(file, "r");
  const last = Buffer.alloc(1);
  try { await handle.read(last,0,1,before.size-1); } finally { await handle.close(); }
  if (last[0] !== 10) return { domain, status:"APPEND_IN_PROGRESS", bytes:before.size };
  let sequence = 0, previousHash = "GENESIS";
  const ids = new Set();
  const stream = createReadStream(file,{ encoding:"utf8",start:0,end:before.size-1 });
  const lines = readline.createInterface({ input:stream,crlfDelay:Infinity });
  try {
  for await (const line of lines) {
    if (!line) throw new Error(`C_AUDIT_EMPTY_LEDGER_LINE_${domain}`);
    const r = JSON.parse(line);
    const base = { schemaVersion:1,domain,sequence:r.sequence,previousHash:r.previousHash,eventId:r.eventId,type:r.type,observedAt:r.observedAt,payload:r.payload };
    if (r.schemaVersion !== 1 || r.domain !== domain || r.sequence !== sequence + 1 || r.previousHash !== previousHash
      || typeof r.eventId !== "string" || !r.eventId || r.hash !== hash(canonical(base)) || ids.has(r.eventId)) throw new Error(`C_AUDIT_LEDGER_INTEGRITY_${domain}_${sequence+1}`);
    ids.add(r.eventId); if (ids.size > maximumIds) return { domain,status:"AUDIT_ID_BOUND_EXCEEDED",bytes:before.size };
    sequence = r.sequence; previousHash = r.hash;
  }
  } finally { lines.close(); stream.destroy(); }
  const after = await fs.stat(file);
  if (after.ino === before.ino && after.size > before.size && after.mtimeMs >= before.mtimeMs) return {
    domain,status:"VERIFIED_FIXED_PREFIX_DURING_APPEND",sequence,hash:previousHash,bytes:before.size,postReadBytes:after.size,
    limitation:"Only the exact newline-terminated prefix read at the initial snapshot was verified; the subsequently appended tail was not read."
  };
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return { domain,status:"CHANGED_DURING_READ",bytes:before.size };
  return { domain,status:"VERIFIED",sequence,hash:previousHash,bytes:before.size };
}

export function inspectRecordedProcess(record, inspect = (pid) => execFileSync("/bin/ps",["-p",String(pid),"-o","command="],{ encoding:"utf8",stdio:["ignore","pipe","pipe"] })) {
  if (!record) return { status:"NOT_RECORDED" };
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.command !== "string") throw new Error("C_AUDIT_PROCESS_RECORD_INVALID");
  try {
    const command = inspect(record.pid).trim();
    if (!command) return { status:"NOT_RUNNING",pid:record.pid };
    return { status:command === record.command ? "RUNNING_COMMAND_MATCH" : "PID_COMMAND_MISMATCH",pid:record.pid };
  } catch (error) {
    const denied = ["EPERM","EACCES"].includes(error.code) || /not permitted|permission denied/i.test(String(error.stderr ?? error.message));
    return { status:denied ? "UNVERIFIED_PERMISSION_DENIED" : "UNVERIFIED_PROCESS_QUERY_FAILED",pid:record.pid };
  }
}

export function verifyAuditBoundaries(study, report) {
  if (study.authorizationId !== "OWNER-DIRECTIVE-V2-ACCOUNT-COMPOUND-ABC-SHADOW-20260906"
    || study.candidateRevision !== "V2-ACCOUNT-COMPOUND-C1-20260906"
    || [study.executionInputAllowed,study.kellySizingActivationAllowed,study.automaticPromotionAllowed,study.performanceValidated].some((v) => v !== false)
    || study.annualTargetProbabilityEstimate !== null) throw new Error("C_AUDIT_GOVERNANCE_BOUNDARY");
  validateCandidateReport(report);
  return { executionInputAllowed:false,kellySizingActivationAllowed:false,automaticPromotionAllowed:false,performanceValidated:false,annualTargetProbability:null };
}

export function inspectLoadedSource(record, health, expectedHash) {
  if (!record || !health || health.pid !== record.pid || !health.runtimeSourceSha256) return { status:"LOADED_SOURCE_NOT_ATTESTED",expectedHash,loadedHash:null };
  return { status:health.runtimeSourceSha256 === expectedHash && record.runtimeSourceSha256 === expectedHash ? "RECORDED_CURRENT_SOURCE" : "RECORDED_SOURCE_MISMATCH",expectedHash,loadedHash:health.runtimeSourceSha256 };
}

export async function auditCandidate({ root = ROOT, runtimeRoot = path.join(ROOT,".runtime/orion-v2-account-shadow-c"), includeMarket = false, now = Date.now() } = {}) {
  const stateFile = path.join(runtimeRoot,"state.json");
  const before = await fs.readFile(stateFile,"utf8");
  const state = JSON.parse(before);
  const report = await readJson(path.join(runtimeRoot,"latest-summary.json"));
  const governance = await readJson(path.join(root,"governance/current-state.json"));
  const boundaries = verifyAuditBoundaries(governance.orionV2AccountCompoundABCStudy,report);
  if (state.startedAt !== report.startedAt || state.account.initialEquityUsdt !== report.account.initialEquityUsdt) throw new Error("C_AUDIT_COHORT_MISMATCH");
  const publisher = await optionalJson(path.join(runtimeRoot,"publisher-status.json"));
  const resident = await optionalJson(path.join(runtimeRoot,"resident-health.json"));
  const processRecord = await optionalJson(path.join(runtimeRoot,"resident.pid.json"));
  const runtimeSource = await calculateRuntimeSourceHash();
  const files = { events:"events.ndjson",fees:"fees.ndjson",positions:"positions.ndjson",depthConsumption:"depth-consumption.ndjson" };
  if (includeMarket) Object.assign(files,{ quotes:"quotes.ndjson",depth:"depth.ndjson",trades:"trades.ndjson",bars:"bars.ndjson",funding:"funding.ndjson",metadata:"metadata.ndjson",marketRaw:"market-events.ndjson" });
  const ledgers = [];
  for (const [domain,file] of Object.entries(files)) {
    try { ledgers.push(await verifyLedgerFile(path.join(runtimeRoot,file),domain.toUpperCase())); }
    catch (error) { if (error.code === "ENOENT") ledgers.push({domain:domain.toUpperCase(),status:"NOT_INITIALIZED"}); else throw error; }
  }
  const changed = before !== await fs.readFile(stateFile,"utf8");
  const completeAudit = !changed && ledgers.every((l) => ["VERIFIED","VERIFIED_EMPTY"].includes(l.status));
  return { schemaVersion:1,asOf:new Date(now).toISOString(),status:completeAudit ? "VERIFIED_RESEARCH_BOUNDARIES_ONLY" : "SNAPSHOT_REVIEW_REQUIRED",boundaries,
    runtimeSnapshotChanged:changed,process:inspectRecordedProcess(processRecord),source:inspectLoadedSource(processRecord,resident,runtimeSource.sha256),
    health:resident ? { status:resident.status,publicationSequence:resident.publicationSequence,ageMs:now-Date.parse(resident.completedAt??resident.failedAt) } : null,
    candidate:{ status:report.status,startedAt:report.startedAt,sourceAsOf:report.sourceAsOf,sourceAgeMs:now-Date.parse(report.sourceAsOf),openPositions:report.account.openPositionCount,closedPositions:report.account.closedPositionCount,
      eligibleCampaigns:report.validation.eligibleCompletedCampaigns,excludedCampaigns:report.validation.excludedCompletedCampaigns,availableRiskUsdt:report.account.availableCandidateRiskUsdt,blockers:report.gates.blockers },
    publication:publisher ? { status:publisher.status,sequence:publisher.sequence,httpStatus:publisher.httpStatus,digest:publisher.digest } : null,
    ledgers,marketLedgersChecked:includeMarket,continuousTickPathValidated:false,
    limitation:"Hash/shape checks are not evidence of causal strategy completeness, future returns, or annual-target probability." };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await auditCandidate({ includeMarket:process.argv.includes("--include-market") }),null,2)); }
  catch (error) { console.log(JSON.stringify({status:"INTEGRITY_HOLD",error:error.message}));process.exitCode=1; }
}
