import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultArchiveRoot = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "AEGISMemory",
  "archives",
  "aegis-ai-quant-governance-center",
  "session-broadcasts",
);

const NON_MATERIAL_KINDS = new Set([
  "NO_REPLY",
  "NO_CHANGE_SCAN",
  "HEALTH_HEARTBEAT",
  "BACKGROUND_POLL_PROMPT",
  "DUPLICATE_REPORT",
  "REPEATED_ACK",
]);

const FORBIDDEN_FIELDS = new Set([
  "transcript",
  "messages",
  "hiddenReasoning",
  "chainOfThought",
  "fullPrompt",
  "fullOutput",
]);

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertNoForbiddenFields(value, trail = "payload") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new Error(`FORBIDDEN_BROADCAST_ARCHIVE_FIELD:${trail}.${key}`);
    }
    assertNoForbiddenFields(child, `${trail}.${key}`);
  }
}

function compactString(value, name, maximumLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`BROADCAST_ARCHIVE_${name}_REQUIRED`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`BROADCAST_ARCHIVE_${name}_TOO_LONG`);
  }
  return normalized;
}

export function normalizeBroadcastArchiveRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("BROADCAST_ARCHIVE_OBJECT_REQUIRED");
  }
  assertNoForbiddenFields(input);

  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const kind = typeof input.kind === "string" ? input.kind.trim().toUpperCase() : "";
  if (input.material !== true || !summary || summary === "NO_REPLY" || NON_MATERIAL_KINDS.has(kind)) {
    return {
      skipped: true,
      status: "SKIPPED_NON_MATERIAL",
      nextAction: input.threadRole === "EPHEMERAL_STANDALONE"
        ? "ARCHIVE_STANDALONE_THREAD_WITH_SET_THREAD_ARCHIVED"
        : "KEEP_MAIN_THREAD_ACTIVE",
    };
  }

  const threadRole = compactString(input.threadRole, "THREAD_ROLE", 64);
  if (!["MAIN", "EPHEMERAL_STANDALONE"].includes(threadRole)) {
    throw new Error("BROADCAST_ARCHIVE_THREAD_ROLE_INVALID");
  }

  const evidenceRefs = input.evidenceRefs ?? [];
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length > 50) {
    throw new Error("BROADCAST_ARCHIVE_EVIDENCE_REFS_INVALID");
  }

  return {
    skipped: false,
    record: {
      schemaVersion: 1,
      eventId: compactString(input.eventId, "EVENT_ID", 256),
      sourceThreadId: compactString(input.sourceThreadId, "SOURCE_THREAD_ID", 256),
      threadRole,
      kind: compactString(input.kind, "KIND", 128),
      summary: compactString(summary, "SUMMARY", 2000),
      evidenceRefs: evidenceRefs.map((value) => compactString(value, "EVIDENCE_REF", 1024)),
      completedAt: compactString(input.completedAt, "COMPLETED_AT", 64),
    },
  };
}

async function readLines(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export class SessionBroadcastArchive {
  constructor(root = process.env.SESSION_BROADCAST_ARCHIVE_ROOT || defaultArchiveRoot) {
    this.root = root;
    this.indexPath = path.join(root, "events.ndjson");
    this.lockPath = path.join(root, ".write-lock");
  }

  async withLock(callback) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fs.mkdir(this.lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error("BROADCAST_ARCHIVE_LOCK_TIMEOUT");
    try {
      return await callback();
    } finally {
      await fs.rmdir(this.lockPath).catch(() => {});
    }
  }

  async record(input) {
    const normalized = normalizeBroadcastArchiveRecord(input);
    if (normalized.skipped) return normalized;

    return this.withLock(async () => {
      const records = await readLines(this.indexPath);
      const duplicate = records.find((record) => record.eventId === normalized.record.eventId);
      if (duplicate) {
        return {
          status: "DEDUPLICATED",
          eventId: duplicate.eventId,
          sequence: duplicate.sequence,
          hash: duplicate.hash,
          nextAction: normalized.record.threadRole === "EPHEMERAL_STANDALONE"
            ? "ARCHIVE_STANDALONE_THREAD_WITH_SET_THREAD_ARCHIVED"
            : "KEEP_MAIN_THREAD_ACTIVE",
        };
      }

      const previousHash = records.at(-1)?.hash ?? null;
      const unsigned = {
        ...normalized.record,
        sequence: records.length + 1,
        previousHash,
        archivedAt: new Date().toISOString(),
      };
      const record = { ...unsigned, hash: sha256(stableStringify(unsigned)) };
      await fs.appendFile(this.indexPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });

      const verification = await this.verify();
      if (verification.status !== "PASS") {
        throw new Error("BROADCAST_ARCHIVE_VERIFY_FAILED");
      }
      return {
        status: "RECORDED",
        eventId: record.eventId,
        sequence: record.sequence,
        hash: record.hash,
        archiveRoot: this.root,
        nextAction: record.threadRole === "EPHEMERAL_STANDALONE"
          ? "ARCHIVE_STANDALONE_THREAD_WITH_SET_THREAD_ARCHIVED"
          : "KEEP_MAIN_THREAD_ACTIVE",
      };
    });
  }

  async verify() {
    const records = await readLines(this.indexPath);
    let previousHash = null;
    const eventIds = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.sequence !== index + 1 || record.previousHash !== previousHash) {
        return { status: "FAIL", reason: "CHAIN_LINK_INVALID", sequence: index + 1 };
      }
      if (eventIds.has(record.eventId)) {
        return { status: "FAIL", reason: "DUPLICATE_EVENT_ID", sequence: index + 1 };
      }
      const { hash, ...unsigned } = record;
      if (hash !== sha256(stableStringify(unsigned))) {
        return { status: "FAIL", reason: "RECORD_HASH_INVALID", sequence: index + 1 };
      }
      eventIds.add(record.eventId);
      previousHash = hash;
    }
    return { status: "PASS", records: records.length, headHash: previousHash, archiveRoot: this.root };
  }

  async status() {
    const verification = await this.verify();
    return { ...verification, mode: "COMPACT_DELTA_AND_EVIDENCE_ONLY" };
  }
}

async function main() {
  const command = process.argv[2] || "status";
  const archive = new SessionBroadcastArchive();
  if (command === "record") {
    if (!process.argv[3]) throw new Error("BROADCAST_ARCHIVE_JSON_ARGUMENT_REQUIRED");
    process.stdout.write(`${JSON.stringify(await archive.record(JSON.parse(process.argv[3])))}\n`);
    return;
  }
  if (command === "verify") {
    const result = await archive.verify();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await archive.status())}\n`);
    return;
  }
  throw new Error(`UNKNOWN_BROADCAST_ARCHIVE_COMMAND:${command}`);
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  await main();
}
