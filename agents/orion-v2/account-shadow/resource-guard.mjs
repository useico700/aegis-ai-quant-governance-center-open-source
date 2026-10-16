import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./contracts.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "../../..");
export const LOCAL_RESOURCE_CONTRACT_PATH = path.join(PROJECT_ROOT, "governance/research/v2-c-local-capture-resource-contract-20260906.json");
const REGISTERED_GUARDS = new Map();

export function registerResourceGuard(guard) {
  REGISTERED_GUARDS.set(path.resolve(guard.runtimeRoot), guard);
  return guard;
}

export function registeredResourceGuardForFile(filePath) {
  const absolute = path.resolve(filePath);
  return [...REGISTERED_GUARDS.entries()].find(([root]) => absolute === root || absolute.startsWith(`${root}${path.sep}`))?.[1] ?? null;
}

async function directoryBytes(root) {
  let total = 0;
  const walk = async (directory) => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile()) total += (await fs.stat(filePath)).size;
      else throw new Error("C_LOCAL_RESOURCE_UNSUPPORTED_RUNTIME_ENTRY");
    }
  };
  await walk(root);
  return total;
}

function validateContract(contract, runtimeRoot) {
  if (contract?.schemaVersion !== 1 || contract?.id !== "AEGIS-V2-C-LOCAL-CAPTURE-RESOURCE-CONTRACT-20260906") throw new Error("C_LOCAL_RESOURCE_CONTRACT_ID_INVALID");
  if (contract.scope !== "LOCAL_C_RESEARCH_RUNTIME_ONLY" || contract.runtimeRoot !== ".runtime/orion-v2-account-shadow-c") throw new Error("C_LOCAL_RESOURCE_CONTRACT_SCOPE_INVALID");
  if (path.resolve(runtimeRoot) !== path.join(PROJECT_ROOT, contract.runtimeRoot)) throw new Error("C_LOCAL_RESOURCE_RUNTIME_ROOT_INVALID");
  if (contract.deleteOrEvictAllowed !== false || contract.historicalUploadAllowed !== false || contract.automaticResumeAllowed !== false || contract.productionRetentionParametersInherited !== false) throw new Error("C_LOCAL_RESOURCE_FORBIDDEN_PERMISSION_EXPANSION");
  for (const key of ["maximumTotalBytes", "controlEvidenceReserveBytes", "minimumAvailableDiskBytes", "maximumQueuedRawBytes"]) {
    if (!Number.isSafeInteger(contract[key]) || contract[key] <= 0) throw new Error(`C_LOCAL_RESOURCE_${key.toUpperCase()}_INVALID`);
  }
  if (!(contract.stopNewCandidateEntriesAtFraction > 0 && contract.stopNewCandidateEntriesAtFraction < 1)) throw new Error("C_LOCAL_RESOURCE_SOFT_LIMIT_INVALID");
  return contract;
}

export class LocalResourceGuard {
  constructor({ runtimeRoot, contract, contractSha256, totalBytes, availableDiskBytes, pauseRecord }) {
    this.runtimeRoot = runtimeRoot;
    this.contract = contract;
    this.contractSha256 = contractSha256;
    this.totalBytes = totalBytes;
    this.availableDiskBytes = availableDiskBytes;
    this.pauseRecord = pauseRecord;
    this.queuedBytes = 0;
    this.pausePath = path.join(runtimeRoot, "local-resource-pause.json");
    this.unsafe = false;
  }

  static async create(runtimeRoot) {
    const raw = await fs.readFile(LOCAL_RESOURCE_CONTRACT_PATH, "utf8");
    const contract = validateContract(JSON.parse(raw), runtimeRoot);
    await fs.mkdir(runtimeRoot, { recursive: true });
    const pausePath = path.join(runtimeRoot, "local-resource-pause.json");
    let pauseRecord = null;
    try { pauseRecord = JSON.parse(await fs.readFile(pausePath, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    let totalBytes;
    let availableDiskBytes;
    try {
      const stats = await fs.statfs(runtimeRoot);
      totalBytes = await directoryBytes(runtimeRoot);
      availableDiskBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const failed = new LocalResourceGuard({ runtimeRoot, contract, contractSha256: sha256(raw), totalBytes: contract.maximumTotalBytes - contract.controlEvidenceReserveBytes, availableDiskBytes: 0, pauseRecord });
      await failed.latch("LOCAL_RESOURCE_CHECK_FAILED", { checkError: error.message });
      return registerResourceGuard(failed);
    }
    return registerResourceGuard(new LocalResourceGuard({
      runtimeRoot,
      contract,
      contractSha256: sha256(raw),
      totalBytes,
      availableDiskBytes,
      pauseRecord,
    }));
  }

  async refresh() {
    try {
      const stats = await fs.statfs(this.runtimeRoot);
      this.totalBytes = await directoryBytes(this.runtimeRoot);
      this.availableDiskBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      await this.latch("LOCAL_RESOURCE_CHECK_FAILED", { checkError: error.message });
      throw new Error("LOCAL_RESOURCE_PAUSED_CHECK_FAILED");
    }
    return this.status();
  }

  status() {
    const softLimitBytes = Math.floor(this.contract.maximumTotalBytes * this.contract.stopNewCandidateEntriesAtFraction);
    return {
      implemented: true,
      contractId: this.contract.id,
      contractSha256: this.contractSha256,
      totalBytes: this.totalBytes,
      queuedBytes: this.queuedBytes,
      availableDiskBytes: this.availableDiskBytes,
      maximumTotalBytes: this.contract.maximumTotalBytes,
      softLimitBytes,
      controlEvidenceReserveBytes: this.contract.controlEvidenceReserveBytes,
      maximumQueuedRawBytes: this.contract.maximumQueuedRawBytes,
      paused: this.pauseRecord != null,
      pauseReason: this.pauseRecord?.reason ?? null,
      newCandidateEntriesAllowed: this.pauseRecord == null && this.totalBytes < softLimitBytes,
    };
  }

  async latch(reason, details = {}) {
    if (this.pauseRecord) return this.pauseRecord;
    const record = {
      schemaVersion: 1,
      status: "LOCAL_RESOURCE_PAUSED",
      reason,
      latchedAt: new Date().toISOString(),
      automaticResumeAllowed: false,
      deleteOrEvictAllowed: false,
      contractId: this.contract.id,
      contractSha256: this.contractSha256,
      totalBytes: this.totalBytes,
      queuedBytes: this.queuedBytes,
      availableDiskBytes: this.availableDiskBytes,
      ...details,
    };
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > this.contract.controlEvidenceReserveBytes) throw new Error("C_LOCAL_RESOURCE_PAUSE_RECORD_EXCEEDS_CONTROL_RESERVE");
    if (this.totalBytes + this.queuedBytes + Buffer.byteLength(serialized) > this.contract.maximumTotalBytes) throw new Error("C_LOCAL_RESOURCE_PAUSE_RECORD_EXCEEDS_HARD_TOTAL");
    const temporary = `${this.pausePath}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.pausePath);
    const directory = await fs.open(this.runtimeRoot, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    this.pauseRecord = record;
    this.totalBytes += Buffer.byteLength(serialized);
    return record;
  }

  async writeControlJson(filePath, value) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.contract.controlEvidenceReserveBytes) throw new Error("C_LOCAL_RESOURCE_CONTROL_WRITE_EXCEEDS_RESERVE");
    if (this.totalBytes + this.queuedBytes + bytes > this.contract.maximumTotalBytes) throw new Error("C_LOCAL_RESOURCE_CONTROL_WRITE_EXCEEDS_HARD_TOTAL");
    let oldBytes = 0;
    try { oldBytes = (await fs.stat(filePath)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const temporary = `${filePath}.${process.pid}.${Date.now()}.control.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    this.totalBytes += bytes - oldBytes;
    this.availableDiskBytes = Math.max(0, this.availableDiskBytes - Math.max(0, bytes - oldBytes));
  }

  async reserveAppend(bytes, purpose = "EVIDENCE_APPEND") {
    if (this.unsafe) throw new Error("C_LOCAL_RESOURCE_GUARD_REINITIALIZATION_REQUIRED");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("C_LOCAL_RESOURCE_RESERVATION_BYTES_INVALID");
    if (this.pauseRecord) throw new Error(`LOCAL_RESOURCE_PAUSED_${this.pauseRecord.reason}`);
    if (bytes > this.contract.maximumQueuedRawBytes || this.queuedBytes + bytes > this.contract.maximumQueuedRawBytes) {
      await this.latch("LOCAL_RESOURCE_QUEUE_LIMIT", { requestedBytes: bytes, purpose });
      throw new Error("LOCAL_RESOURCE_PAUSED_QUEUE_LIMIT");
    }
    if (this.availableDiskBytes < this.contract.minimumAvailableDiskBytes + bytes) {
      await this.latch("LOCAL_RESOURCE_MINIMUM_FREE_DISK", { requestedBytes: bytes, purpose });
      throw new Error("LOCAL_RESOURCE_PAUSED_MINIMUM_FREE_DISK");
    }
    const projected = this.totalBytes + this.queuedBytes + bytes + this.contract.controlEvidenceReserveBytes;
    if (projected > this.contract.maximumTotalBytes) {
      await this.latch("LOCAL_RESOURCE_HARD_TOTAL_LIMIT", { requestedBytes: bytes, projectedBytes: projected, purpose });
      throw new Error("LOCAL_RESOURCE_PAUSED_HARD_TOTAL_LIMIT");
    }
    this.queuedBytes += bytes;
    return { bytes, purpose, active: true };
  }

  async reserveReplacement(filePath, bytes, purpose = "ATOMIC_REPLACEMENT") {
    let oldBytes = 0;
    try { oldBytes = (await fs.stat(filePath)).size; }
    catch (error) {
      if (error?.code !== "ENOENT") {
        await this.latch("LOCAL_RESOURCE_CHECK_FAILED", { checkError: error.message, purpose });
        throw new Error("LOCAL_RESOURCE_PAUSED_CHECK_FAILED");
      }
    }
    const reservation = await this.reserveAppend(bytes, purpose);
    reservation.replacement = true;
    reservation.oldBytes = oldBytes;
    return reservation;
  }

  async reserveQueue(bytes, purpose = "RAW_RECEIVE_QUEUE") {
    if (this.unsafe) throw new Error("C_LOCAL_RESOURCE_GUARD_REINITIALIZATION_REQUIRED");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("C_LOCAL_RESOURCE_QUEUE_BYTES_INVALID");
    if (this.pauseRecord) throw new Error(`LOCAL_RESOURCE_PAUSED_${this.pauseRecord.reason}`);
    if (bytes > this.contract.maximumQueuedRawBytes || this.queuedBytes + bytes > this.contract.maximumQueuedRawBytes) {
      await this.latch("LOCAL_RESOURCE_QUEUE_LIMIT", { requestedBytes: bytes, purpose });
      throw new Error("LOCAL_RESOURCE_PAUSED_QUEUE_LIMIT");
    }
    this.queuedBytes += bytes;
    return { bytes, purpose, active: true, queueOnly: true };
  }

  reserveQueueImmediate(bytes, purpose = "RAW_RECEIVE_QUEUE") {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("C_LOCAL_RESOURCE_QUEUE_BYTES_INVALID");
    if (this.unsafe) throw new Error("C_LOCAL_RESOURCE_GUARD_REINITIALIZATION_REQUIRED");
    if (this.pauseRecord) throw new Error(`LOCAL_RESOURCE_PAUSED_${this.pauseRecord.reason}`);
    if (bytes > this.contract.maximumQueuedRawBytes || this.queuedBytes + bytes > this.contract.maximumQueuedRawBytes) throw new Error("LOCAL_RESOURCE_QUEUE_LIMIT_REACHED");
    this.queuedBytes += bytes;
    return { bytes, purpose, active: true, queueOnly: true };
  }

  releaseQueue(reservation) {
    if (!reservation?.active || reservation.queueOnly !== true) return;
    reservation.active = false;
    this.queuedBytes -= reservation.bytes;
  }

  commit(reservation) {
    if (!reservation?.active || reservation.queueOnly === true) throw new Error("C_LOCAL_RESOURCE_RESERVATION_NOT_ACTIVE");
    reservation.active = false;
    this.queuedBytes -= reservation.bytes;
    const delta = reservation.replacement ? reservation.bytes - reservation.oldBytes : reservation.bytes;
    this.totalBytes += delta;
    this.availableDiskBytes = Math.max(0, this.availableDiskBytes - Math.max(0, delta));
  }

  release(reservation) {
    if (!reservation?.active) return;
    reservation.active = false;
    this.queuedBytes -= reservation.bytes;
  }

  async reconcileAfterUncertainWrite(reservation, error) {
    this.unsafe = true;
    if (reservation?.active) {
      reservation.active = false;
      this.queuedBytes -= reservation.bytes;
    }
    try { await this.refresh(); }
    catch { throw new Error(`LOCAL_RESOURCE_PAUSED_UNCERTAIN_WRITE_${error.message}`); }
  }
}
