import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function deterministicId(prefix, payload, length = 24) {
  return `${prefix}_${sha256(stableStringify(payload)).slice(0, length)}`;
}

export function round(value, digits = 12) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function parseTime(value, label) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value ?? ""));
  invariant(Number.isFinite(parsed), `V4_RG1_${label}_TIME_INVALID`);
  return parsed;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, filePath);
}

export async function writeTextAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, value, { flag: "wx" });
  await fs.rename(temporary, filePath);
}

export function createAuditLedger(scope) {
  const events = [];
  let previousHash = "GENESIS";
  return {
    append(type, payload = {}) {
      const event = {
        sequence: events.length,
        scope,
        type,
        ...payload,
        previousHash,
      };
      event.eventHash = sha256(`${previousHash}\n${stableStringify(event)}`);
      previousHash = event.eventHash;
      events.push(event);
      return event;
    },
    snapshot() {
      return {
        algorithm: "SHA256_PREVIOUS_HASH_CHAIN_V1",
        eventCount: events.length,
        headHash: previousHash,
        events,
      };
    },
  };
}

export function verifyAuditLedger(ledger) {
  let expectedPrevious = "GENESIS";
  for (let index = 0; index < (ledger?.events?.length ?? 0); index += 1) {
    const event = ledger.events[index];
    const storedHash = event.eventHash;
    const unsigned = { ...event };
    delete unsigned.eventHash;
    const calculated = sha256(`${expectedPrevious}\n${stableStringify(unsigned)}`);
    if (event.sequence !== index || event.previousHash !== expectedPrevious || storedHash !== calculated) {
      return { valid: false, error: `V4_RG1_AUDIT_CHAIN_BREAK_${index}` };
    }
    expectedPrevious = storedHash;
  }
  return {
    valid: expectedPrevious === ledger?.headHash,
    eventCount: ledger?.events?.length ?? 0,
    headHash: expectedPrevious,
  };
}
