import fs from "node:fs/promises";
import path from "node:path";
import { buildCandidateSummary, sha256, stableStringify } from "./contracts.mjs";
import { validateCandidateState, validateStateTransition } from "./engine.mjs";
import { registeredResourceGuardForFile } from "./resource-guard.mjs";

export const MAX_SUMMARY_BYTES = 20_000;

export async function readJsonIfPresent(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const resourceGuard = registeredResourceGuardForFile(filePath);
  const reservation = resourceGuard ? await resourceGuard.reserveReplacement(filePath, Buffer.byteLength(serialized), `ATOMIC_JSON_${path.basename(filePath)}`) : null;
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    if (reservation) resourceGuard.commit(reservation);
  } catch (error) {
    if (reservation) await resourceGuard.reconcileAfterUncertainWrite(reservation, error);
    throw error;
  }
}

async function appendLineDurable(filePath, serialized, purpose) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const resourceGuard = registeredResourceGuardForFile(filePath);
  const reservation = resourceGuard ? await resourceGuard.reserveAppend(Buffer.byteLength(serialized), purpose) : null;
  try {
    const handle = await fs.open(filePath, "a", 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    if (reservation) resourceGuard.commit(reservation);
  } catch (error) {
    if (reservation) await resourceGuard.reconcileAfterUncertainWrite(reservation, error);
    throw error;
  }
}

export function runtimePaths(runtimeRoot) {
  return {
    state: path.join(runtimeRoot, "state.json"),
    pendingSummary: path.join(runtimeRoot, "pending-summary.json"),
    acknowledgedSummaries: path.join(runtimeRoot, "acknowledged-summaries.ndjson"),
    sourceCursor: path.join(runtimeRoot, "source-cursor.json"),
  };
}

export async function persistState(filePath, previous, next) {
  if (previous) validateStateTransition(previous, next);
  else validateCandidateState(next);
  await writeJsonAtomic(filePath, next);
  return next;
}

export async function preparePendingSummary({ state, inputHealth, sourceAsOf, pendingPath }) {
  validateCandidateState(state);
  const existing = await readJsonIfPresent(pendingPath);
  if (existing) {
    const digest = sha256(stableStringify(existing.payload));
    if (existing.digest !== digest || existing.sequence !== existing.payload?.sequence) throw new Error("C_PENDING_SUMMARY_INTEGRITY_INVALID");
    return existing;
  }
  const sourceMs = Date.parse(sourceAsOf);
  if (!Number.isFinite(sourceMs)) throw new Error("C_SUMMARY_SOURCE_AS_OF_INVALID");
  if (state.lastPublishedSourceAsOf != null && sourceMs <= Date.parse(state.lastPublishedSourceAsOf)) throw new Error("C_SUMMARY_SOURCE_AS_OF_NOT_STRICTLY_INCREASING");
  const sequence = state.publicationSequence + 1;
  if (sequence < 1) throw new Error("C_SUMMARY_SEQUENCE_INVALID");
  const payload = buildCandidateSummary(state, inputHealth, sequence, sourceAsOf);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_SUMMARY_BYTES) throw new Error("C_SUMMARY_EXCEEDS_20KB");
  const pending = { schemaVersion: 1, sequence, sourceAsOf, digest: sha256(stableStringify(payload)), bytes, payload };
  await writeJsonAtomic(pendingPath, pending);
  return pending;
}

async function recordAcknowledgementOnce(acknowledgedPath, record) {
  const raw = await fs.readFile(acknowledgedPath, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error));
  const existing = raw.split("\n").filter(Boolean).map(JSON.parse).find((candidate) => candidate.sequence === record.sequence);
  if (existing) {
    if (existing.digest !== record.digest || existing.sourceAsOf !== record.sourceAsOf) throw new Error("C_ACKNOWLEDGEMENT_SEQUENCE_CONFLICT");
    return;
  }
  await fs.mkdir(path.dirname(acknowledgedPath), { recursive: true });
  await appendLineDurable(acknowledgedPath, `${JSON.stringify(record)}\n`, "ACKNOWLEDGED_SUMMARY_APPEND");
}

export async function acknowledgePendingSummary({ state, statePath, pendingPath, acknowledgedPath, sequence, digest, acknowledgedAt }) {
  const pending = await readJsonIfPresent(pendingPath);
  if (!pending) {
    if (state.publicationSequence === sequence && state.lastPublishedDigest === digest) return state;
    throw new Error("C_PENDING_SUMMARY_MISSING");
  }
  if (pending.sequence !== sequence || pending.digest !== digest) throw new Error("C_PENDING_SUMMARY_ACK_MISMATCH");
  if (state.publicationSequence === sequence && state.lastPublishedDigest === digest) {
    await recordAcknowledgementOnce(acknowledgedPath, { schemaVersion: 1, sequence, sourceAsOf: pending.sourceAsOf, digest, acknowledgedAt });
    await fs.unlink(pendingPath);
    return state;
  }
  if (sequence !== state.publicationSequence + 1) throw new Error("C_PENDING_SUMMARY_ACK_SEQUENCE_GAP");
  const next = structuredClone(state);
  next.publicationSequence = sequence;
  next.lastPublishedSourceAsOf = pending.sourceAsOf;
  next.lastPublishedDigest = digest;
  validateStateTransition(state, next);
  await writeJsonAtomic(statePath, next);
  await recordAcknowledgementOnce(acknowledgedPath, { schemaVersion: 1, sequence, sourceAsOf: pending.sourceAsOf, digest, acknowledgedAt });
  await fs.unlink(pendingPath);
  return next;
}

export function assertIdempotentSequence(existing, incoming) {
  if (existing.sequence !== incoming.sequence) return false;
  if (sha256(stableStringify(existing.payload)) !== sha256(stableStringify(incoming.payload))) {
    const error = new Error("C_SEQUENCE_PAYLOAD_CONFLICT");
    error.statusCode = 409;
    throw error;
  }
  return true;
}
