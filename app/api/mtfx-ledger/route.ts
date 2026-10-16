import { publicApi } from "../../../lib/public-preview.mjs";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { encodeShadowState, decodeShadowState } from "@/app/v2-ledger/account-shadow/persistence.mjs";
import { validExecutionMetadata } from "@/app/v2-ledger/execution-release.mjs";

const SNAPSHOT_ID = "orion-v2-mtfx-latest";
const ACCOUNT_SHADOW_ID = "orion-v2-r22-account-equity-lock-shadow-v5";
const ACCOUNT_SHADOW_CAS_ATTEMPTS = 4;

type RuntimeEnv = {
  DB: D1Database;
  MTFX_LEDGER_INGEST_TOKEN?: string;
};

async function runtimeEnv(): Promise<RuntimeEnv> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as RuntimeEnv;
}

async function ensureTable(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mtfx_ledger_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      source_as_of TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function ensureAccountShadowTable(db: D1Database) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mtfx_account_shadow_states (
      id TEXT PRIMARY KEY NOT NULL,
      source_as_of TEXT NOT NULL,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revision INTEGER NOT NULL DEFAULT 0,
      input_sha256 TEXT
    )
  `).run();
  try { await db.prepare("ALTER TABLE mtfx_account_shadow_states ADD COLUMN revision INTEGER NOT NULL DEFAULT 0").run(); } catch {}
  try { await db.prepare("ALTER TABLE mtfx_account_shadow_states ADD COLUMN input_sha256 TEXT").run(); } catch {}
}

function changedRows(result: unknown) {
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function persistAccountShadow(db: D1Database, payload: Record<string, unknown>, receivedAt: string) {
  const { advanceAccountShadow, validateAccountShadowTransition, validatePersistedAccountShadowState } = await import("@/app/v2-ledger/account-shadow/engine.mjs");
  await ensureAccountShadowTable(db);
  const inputSerialized = JSON.stringify(payload);
  const inputSha256 = await sha256Hex(inputSerialized);
  const inputSourceAsOf = String(payload.sourceAsOf);
  const observedAtMs = Date.parse(receivedAt);

  for (let attempt = 0; attempt < ACCOUNT_SHADOW_CAS_ATTEMPTS; attempt += 1) {
    const previousRow = await db.prepare(
      "SELECT source_as_of AS sourceAsOf, payload, received_at AS receivedAt, revision, input_sha256 AS inputSha256 FROM mtfx_account_shadow_states WHERE id = ?",
    ).bind(ACCOUNT_SHADOW_ID).first<{ sourceAsOf: string; payload: string; receivedAt: string; revision: number; inputSha256: string | null }>();

    if (!previousRow) {
      const accountShadow = advanceAccountShadow(null, payload, observedAtMs);
      validatePersistedAccountShadowState(accountShadow);
      const shadowSerialized = await encodeShadowState(accountShadow);
      if (utf8Bytes(shadowSerialized).byteLength > 500_000) throw new Error("ACCOUNT_SHADOW_STATE_TOO_LARGE");
      const inserted = await db.prepare(`
        INSERT INTO mtfx_account_shadow_states (id, source_as_of, payload, received_at, revision, input_sha256)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(ACCOUNT_SHADOW_ID, accountShadow.sourceAsOf, shadowSerialized, receivedAt, inputSha256).run();
      if (changedRows(inserted) === 1) return "INSERTED";
      continue;
    }

    if (!Number.isInteger(previousRow.revision) || previousRow.revision < 1 || previousRow.inputSha256 == null || !/^[0-9a-f]{64}$/.test(previousRow.inputSha256)) throw new Error("ACCOUNT_SHADOW_PERSISTED_ROW_INTEGRITY_FAILURE");
    const previousState = validatePersistedAccountShadowState(await decodeShadowState(previousRow.payload));
    if (previousRow.sourceAsOf !== previousState.sourceAsOf) throw new Error("ACCOUNT_SHADOW_PERSISTED_SOURCE_MISMATCH");
    const ordering = inputSourceAsOf.localeCompare(previousRow.sourceAsOf);
    if (ordering < 0) return "OUT_OF_ORDER_IGNORED";
    if (ordering === 0) {
      if (inputSha256 === previousRow.inputSha256) return "IDEMPOTENT_DUPLICATE";
      throw new Error("ACCOUNT_SHADOW_SOURCE_EQUIVOCATION");
    }

    const accountShadow = advanceAccountShadow(previousState, payload, observedAtMs);
    validateAccountShadowTransition(previousState, accountShadow);
    const shadowSerialized = await encodeShadowState(accountShadow);
    if (utf8Bytes(shadowSerialized).byteLength > 500_000) throw new Error("ACCOUNT_SHADOW_STATE_TOO_LARGE");
    const updated = await db.prepare(`
      UPDATE mtfx_account_shadow_states
      SET source_as_of = ?, payload = ?, received_at = ?, revision = revision + 1, input_sha256 = ?
      WHERE id = ? AND revision = ? AND source_as_of = ?
    `).bind(accountShadow.sourceAsOf, shadowSerialized, receivedAt, inputSha256, ACCOUNT_SHADOW_ID, previousRow.revision, previousRow.sourceAsOf).run();
    if (changedRows(updated) === 1) return "UPDATED";
  }
  throw new Error("ACCOUNT_SHADOW_CAS_RETRY_EXHAUSTED");
}

function safeEqual(first: string, second: string) {
  const left = new TextEncoder().encode(first);
  const right = new TextEncoder().encode(second);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("mtfx-ledger", "GET");

  try {
    const { DB } = await runtimeEnv();
    await ensureTable(DB);
    const row = await DB.prepare(
      "SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt FROM mtfx_ledger_snapshots WHERE id = ?",
    ).bind(SNAPSHOT_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string }>();
    if (!row) return Response.json({ status: "WAITING_FOR_FIRST_MTFX_SNAPSHOT" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const baselineEnvelope = {
      status: "OK",
      sourceAsOf: row.sourceAsOf,
      receivedAt: row.receivedAt,
      snapshot: JSON.parse(row.payload),
    };
    const includeAccountShadow = new URL(request.url).searchParams.has("account-shadow");
    if (!includeAccountShadow) return Response.json(baselineEnvelope, { headers: { "Cache-Control": "no-store" } });

    let accountShadow: Record<string, unknown> | null = null;
    let accountShadowStatus = "WAITING_FOR_FIRST_FORWARD_OBSERVATION";
    let accountShadowSourceAsOf: string | null = null;
    let accountShadowReceivedAt: string | null = null;
    let accountShadowRevision: number | null = null;
    try {
      await ensureAccountShadowTable(DB);
      const shadowRow = await DB.prepare(
        "SELECT payload, source_as_of AS sourceAsOf, received_at AS receivedAt, revision, input_sha256 AS inputSha256 FROM mtfx_account_shadow_states WHERE id = ?",
      ).bind(ACCOUNT_SHADOW_ID).first<{ payload: string; sourceAsOf: string; receivedAt: string; revision: number; inputSha256: string | null }>();
      if (shadowRow) {
        const { validatePersistedAccountShadowState } = await import("@/app/v2-ledger/account-shadow/engine.mjs");
        const parsed = validatePersistedAccountShadowState(await decodeShadowState(shadowRow.payload));
        if (parsed.sourceAsOf !== shadowRow.sourceAsOf || !Number.isInteger(shadowRow.revision) || shadowRow.revision < 1 || !/^[0-9a-f]{64}$/.test(shadowRow.inputSha256 ?? "")) throw new Error("ACCOUNT_SHADOW_PERSISTED_ROW_INTEGRITY_FAILURE");
        accountShadow = parsed as Record<string, unknown>;
        accountShadowSourceAsOf = shadowRow.sourceAsOf;
        accountShadowReceivedAt = shadowRow.receivedAt;
        accountShadowRevision = shadowRow.revision;
        accountShadowStatus = Date.parse(shadowRow.sourceAsOf) < Date.parse(row.sourceAsOf)
          ? "SHADOW_LAGGING_BASELINE_MONITOR_UNAFFECTED"
          : accountShadow.prospectiveStart
            ? "ACTIVE_OBSERVE_ONLY"
            : "WAITING_FIRST_VALID_FORWARD_SNAPSHOT";
      }
    } catch {
      accountShadow = null;
      accountShadowStatus = "SHADOW_STATE_INTEGRITY_FAILURE_BASELINE_UNAFFECTED";
    }

    return Response.json({
      ...baselineEnvelope,
      accountShadowStatus,
      accountShadowSourceAsOf,
      accountShadowReceivedAt,
      accountShadowRevision,
      accountShadow,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ status: "UNAVAILABLE", error: error instanceof Error ? error.message : "MTFX ledger unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("mtfx-ledger", "POST");

  try {
    const env = await runtimeEnv();
    const configured = String(env.MTFX_LEDGER_INGEST_TOKEN ?? "");
    const supplied = String(request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!configured || !supplied || !safeEqual(configured, supplied)) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const payload = await request.json() as Record<string, unknown>;
    const serialized = JSON.stringify(payload);
    const sourceAsOf = String(payload.sourceAsOf ?? "");
    const sourceMs = Date.parse(sourceAsOf);
    const valid =
      payload.runtimeId === "ORION-V2-MTFX-PAPER-1.1" &&
      payload.strategyVersion === "ORION-V2-RESEARCH-MTFX-0.5.0" &&
      payload.authorizationId === "OWNER-AUTH-MTFX-PRICE-TIME-STRUCTURE-050-20260806" &&
      payload.realOrdersAllowed === false &&
      Array.isArray(payload.symbols) &&
      payload.books != null && typeof payload.books === "object" &&
      validExecutionMetadata(payload) &&
      Number.isFinite(sourceMs) &&
      new Date(sourceMs).toISOString() === sourceAsOf &&
      utf8Bytes(serialized).byteLength <= 1_000_000;
    if (!valid) return Response.json({ error: "invalid MTFX paper snapshot" }, { status: 400 });
    await ensureTable(env.DB);
    const receivedAt = new Date().toISOString();
    const baselineWrite = await env.DB.prepare(`
      INSERT INTO mtfx_ledger_snapshots (id, source_as_of, payload, received_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_as_of = excluded.source_as_of,
        payload = excluded.payload,
        received_at = excluded.received_at
      WHERE excluded.source_as_of > mtfx_ledger_snapshots.source_as_of
    `).bind(SNAPSHOT_ID, sourceAsOf, serialized, receivedAt).run();

    if (changedRows(baselineWrite) !== 1) {
      const existing = await env.DB.prepare(
        "SELECT source_as_of AS sourceAsOf, payload, received_at AS receivedAt FROM mtfx_ledger_snapshots WHERE id = ?",
      ).bind(SNAPSHOT_ID).first<{ sourceAsOf: string; payload: string; receivedAt: string }>();
      if (!existing) throw new Error("MTFX_BASELINE_MONOTONIC_WRITE_FAILED");
      if (sourceAsOf === existing.sourceAsOf && serialized !== existing.payload) {
        return Response.json({ error: "MTFX snapshot source equivocation" }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      const status = sourceAsOf === existing.sourceAsOf ? "IDEMPOTENT_DUPLICATE" : "OUT_OF_ORDER_IGNORED";
      return Response.json({ status, sourceAsOf: existing.sourceAsOf, receivedAt: existing.receivedAt, accountShadowStatus: "UNCHANGED" });
    }

    const accountShadowWork = persistAccountShadow(env.DB, payload, receivedAt);
    getRequestExecutionContext()?.waitUntil(accountShadowWork);
    void accountShadowWork.catch(() => {});

    return Response.json({ status: "STORED", sourceAsOf, receivedAt, accountShadowStatus: "BACKGROUND_OBSERVE_ONLY_QUEUED" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "MTFX snapshot ingest failed" }, { status: 500 });
  }
}
