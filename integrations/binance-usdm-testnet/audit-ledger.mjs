import fs from "node:fs/promises";
import path from "node:path";

import { sha256, stableStringify } from "../../agents/orion-v2/paper/runtime-utils.mjs";

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 400;

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error("V3_AUDIT_LEDGER_LOCK_TIMEOUT");
}

async function releaseLock(handle, lockPath) {
  await handle.close().catch(() => {});
  await fs.unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function readLastRecord(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.length ? { record: JSON.parse(lines.at(-1)), lineCount: lines.length } : { record: null, lineCount: 0 };
  } catch (error) {
    if (error?.code === "ENOENT") return { record: null, lineCount: 0 };
    throw error;
  }
}

export async function appendChainedAudit(filePath, event) {
  const lockPath = `${filePath}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const { record: previous, lineCount } = await readLastRecord(filePath);
    const previousHash = previous?.eventHash ?? null;
    const priorSequence = Number(previous?.sequence);
    const sequence = Number.isSafeInteger(priorSequence) && priorSequence > 0 ? priorSequence + 1 : 1;
    const chainEpoch = Number(previous?.chainEpoch) || (previous ? 2 : 1);
    const eventId = `v3evt_${sha256(stableStringify({ filePath: path.basename(filePath), chainEpoch, sequence, previousHash, event })).slice(0, 24)}`;
    const payload = {
      ...event,
      auditSchemaVersion: 2,
      chainEpoch,
      sequence,
      previousHash,
      eventId,
    };
    if (sequence === 1) payload.legacyRecordCountBeforeChain = lineCount;
    const record = { ...payload, eventHash: sha256(stableStringify(payload)) };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`);
    return record;
  } finally {
    await releaseLock(lock, lockPath);
  }
}

export async function verifyChainedAudit(filePath) {
  let rows;
  try {
    rows = (await fs.readFile(filePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "EMPTY", recordCount: 0, chainedRecordCount: 0, errors: [] };
    throw error;
  }
  const errors = [];
  let chainStarted = false;
  let previousHash = null;
  let expectedSequence = 1;
  let chainedRecordCount = 0;
  let unverifiableLegacyRecordCount = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const { eventHash, ...payload } = row;
    if (eventHash) {
      if (eventHash !== sha256(stableStringify(payload))) errors.push(`EVENT_HASH_MISMATCH_${index + 1}`);
    } else if (row.auditSchemaVersion !== 2) {
      unverifiableLegacyRecordCount += 1;
    }
    if (row.auditSchemaVersion === 2) {
      if (!chainStarted) {
        chainStarted = true;
        previousHash = index > 0 ? rows[index - 1]?.eventHash ?? null : null;
      }
      if (row.sequence !== expectedSequence) errors.push(`SEQUENCE_MISMATCH_${index + 1}`);
      if (row.previousHash !== previousHash) errors.push(`PREVIOUS_HASH_MISMATCH_${index + 1}`);
      previousHash = row.eventHash;
      expectedSequence += 1;
      chainedRecordCount += 1;
    } else if (chainStarted) {
      errors.push(`LEGACY_RECORD_AFTER_CHAIN_${index + 1}`);
    }
  }
  return {
    status: errors.length ? "INVALID" : "VALID",
    recordCount: rows.length,
    chainedRecordCount,
    legacyRecordCount: rows.length - chainedRecordCount,
    unverifiableLegacyRecordCount,
    lastEventHash: rows.at(-1)?.eventHash ?? null,
    errors,
  };
}
