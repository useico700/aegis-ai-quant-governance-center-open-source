import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { sha256, stableStringify } from "./contracts.mjs";

export const GENESIS = "GENESIS";

export class AppendOnlyLedger {
  constructor(filePath, domain, { retainRecords = false, onUnsafeAppend = null, writeBatch = null, resourceGuard = null } = {}) {
    this.filePath = filePath;
    this.domain = domain;
    this.sequence = 0;
    this.previousHash = GENESIS;
    this.eventIds = new Set();
    this.retainRecords = retainRecords;
    this.records = [];
    this.initialized = false;
    this.unsafe = false;
    this.onUnsafeAppend = onUnsafeAppend;
    this.resourceGuard = resourceGuard;
    this.writeBatch = writeBatch ?? (async (serialized) => {
      const handle = await fs.open(this.filePath, "a", 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); }
      finally { await handle.close(); }
    });
  }

  async initialize() {
    if (this.initialized) throw new Error(`ACCOUNT_SHADOW_C_LEDGER_ALREADY_INITIALIZED_${this.domain}`);
    try { await fs.access(this.filePath); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(this.filePath, "a", 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const stats = await fs.stat(this.filePath);
    if (stats.size > 0) {
      const handle = await fs.open(this.filePath, "r");
      const byte = Buffer.alloc(1);
      try { await handle.read(byte, 0, 1, stats.size - 1); }
      finally { await handle.close(); }
      if (byte[0] !== 0x0a) throw new Error(`ACCOUNT_SHADOW_C_LEDGER_INCOMPLETE_TRAILING_RECORD_${this.domain}`);
    }
    let prior = GENESIS;
    let expectedSequence = 1;
    const lines = readline.createInterface({ input: createReadStream(this.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      const base = { schemaVersion: 1, domain: this.domain, sequence: record.sequence, previousHash: record.previousHash, eventId: record.eventId, type: record.type, observedAt: record.observedAt, payload: record.payload };
      if (record.domain !== this.domain || record.sequence !== expectedSequence || record.previousHash !== prior || record.hash !== sha256(stableStringify(base))) {
        throw new Error(`ACCOUNT_SHADOW_C_LEDGER_CHAIN_BREAK_${this.domain}_${expectedSequence}`);
      }
      if (this.eventIds.has(record.eventId)) throw new Error(`ACCOUNT_SHADOW_C_LEDGER_DUPLICATE_${this.domain}_${record.eventId}`);
      this.eventIds.add(record.eventId);
      if (this.retainRecords) this.records.push(record);
      this.sequence = record.sequence;
      this.previousHash = record.hash;
      prior = record.hash;
      expectedSequence += 1;
    }
    this.initialized = true;
    return { domain: this.domain, sequence: this.sequence, hash: this.previousHash };
  }

  async append(type, observedAt, payload, eventId) {
    const records = await this.appendMany([{ type, observedAt, payload, eventId }]);
    return records[0] ?? null;
  }

  async replayAfter(sequence, callback) {
    if (!this.initialized) throw new Error(`ACCOUNT_SHADOW_C_LEDGER_NOT_INITIALIZED_${this.domain}`);
    const lines = readline.createInterface({ input: createReadStream(this.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.sequence > sequence) await callback(record);
    }
  }

  async appendMany(items) {
    if (this.unsafe) throw new Error(`ACCOUNT_SHADOW_C_LEDGER_REINITIALIZATION_REQUIRED_${this.domain}`);
    const records = [];
    const batchIds = new Set();
    let sequence = this.sequence;
    let previousHash = this.previousHash;
    for (const { type, observedAt, payload, eventId } of items) {
      if (this.eventIds.has(eventId) || batchIds.has(eventId)) continue;
      const base = { schemaVersion: 1, domain: this.domain, sequence: sequence + 1, previousHash, eventId, type, observedAt, payload };
      const record = { ...base, hash: sha256(stableStringify(base)) };
      records.push(record);
      batchIds.add(eventId);
      sequence = record.sequence;
      previousHash = record.hash;
    }
    if (!records.length) return [];
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const serialized = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const reservation = this.resourceGuard ? await this.resourceGuard.reserveAppend(Buffer.byteLength(serialized), `LEDGER_${this.domain}`) : null;
    try {
      await this.writeBatch(serialized);
      if (reservation) this.resourceGuard.commit(reservation);
    }
    catch (error) {
      this.unsafe = true;
      this.onUnsafeAppend?.(error);
      if (reservation) await this.resourceGuard.reconcileAfterUncertainWrite(reservation, error);
      throw error;
    }
    this.sequence = sequence;
    this.previousHash = previousHash;
    for (const eventId of batchIds) this.eventIds.add(eventId);
    if (this.retainRecords) this.records.push(...records);
    return records;
  }
}

export function ledgerPaths(runtimeRoot) {
  return {
    events: path.join(runtimeRoot, "events.ndjson"),
    fees: path.join(runtimeRoot, "fees.ndjson"),
    positions: path.join(runtimeRoot, "positions.ndjson"),
    quotes: path.join(runtimeRoot, "quotes.ndjson"),
    depth: path.join(runtimeRoot, "depth.ndjson"),
    trades: path.join(runtimeRoot, "trades.ndjson"),
    bars: path.join(runtimeRoot, "bars.ndjson"),
    depthConsumption: path.join(runtimeRoot, "depth-consumption.ndjson"),
    funding: path.join(runtimeRoot, "funding.ndjson"),
    metadata: path.join(runtimeRoot, "metadata.ndjson"),
  };
}
