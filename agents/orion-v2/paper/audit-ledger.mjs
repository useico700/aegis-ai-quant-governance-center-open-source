import fs from "node:fs/promises";
import { appendLine, deterministicId, sha256, stableStringify } from "./runtime-utils.mjs";

export class AuditLedger {
  constructor(filePath) {
    this.filePath = filePath;
    this.sequence = 0;
    this.previousHash = "GENESIS";
    this.eventIds = new Set();
    this.records = [];
    this.recordsById = new Map();
  }

  async initialize() {
    let raw = "";
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return;
    }
    let expectedPrevious = "GENESIS";
    for (const line of raw.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      const base = {
        sequence: record.sequence,
        previousHash: record.previousHash,
        eventId: record.eventId,
        type: record.type,
        marketTime: record.marketTime,
        payload: record.payload,
      };
      const expectedHash = sha256(stableStringify(base));
      if (record.previousHash !== expectedPrevious || record.hash !== expectedHash) {
        throw new Error(`AUDIT_CHAIN_BREAK_AT_${record.sequence}`);
      }
      expectedPrevious = record.hash;
      this.sequence = record.sequence;
      this.previousHash = record.hash;
      this.eventIds.add(record.eventId);
      this.records.push(record);
      this.recordsById.set(record.eventId, record);
    }
  }

  async append(type, marketTime, payload, providedEventId = null) {
    const eventId = providedEventId ?? deterministicId("evt", { type, marketTime, payload });
    if (this.eventIds.has(eventId)) return null;
    const base = {
      sequence: this.sequence + 1,
      previousHash: this.previousHash,
      eventId,
      type,
      marketTime,
      payload,
    };
    const record = { ...base, hash: sha256(stableStringify(base)) };
    await appendLine(this.filePath, JSON.stringify(record));
    this.sequence = record.sequence;
    this.previousHash = record.hash;
    this.eventIds.add(eventId);
    this.records.push(record);
    this.recordsById.set(eventId, record);
    return record;
  }

  get(eventId) {
    return this.recordsById.get(eventId) ?? null;
  }

  byType(type) {
    return this.records.filter((record) => record.type === type);
  }
}
