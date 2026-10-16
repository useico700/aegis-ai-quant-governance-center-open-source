import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildV3EquityCurve } from "../agents/orion-v3/binance-demo/equity-curve.mjs";
import {
  createPartialSettlementTimeRecovery,
  recoveredPartialSettlementTime,
  SETTLEMENT_TIME_RECOVERY_AUTHORIZATION,
  SETTLEMENT_TIME_RECOVERY_EVENT,
} from "../agents/orion-v3/binance-demo/settlement-time-recovery.mjs";
import { appendChainedAudit, verifyChainedAudit } from "../integrations/binance-usdm-testnet/audit-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = "reports/strategy-research/20260914-v3-settlement-time-recovery";
const runtime = path.join(root, ".runtime/orion-v3-binance-demo");
const targets = [
  ["SOLUSDT", "4184957713"], ["ARBUSDT", "323838370"], ["SUIUSDT", "1062428479"],
  ["LTCUSDT", "1579490529"], ["FILUSDT", "325484798"], ["BCHUSDT", "2574770476"], ["APTUSDT", "471050129"],
];
const hash = (body) => createHash("sha256").update(body).digest("hex");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const readAudit = async () => (await fs.readFile(path.join(runtime, "audit.ndjson"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);

async function recover(apply) {
  const authorization = await readJson(path.join(root, "governance/owner-authorizations/2026-09-14-orion-v3-settlement-time-recovery.json"));
  assert.equal(authorization.authorizationId, SETTLEMENT_TIME_RECOVERY_AUTHORIZATION);
  assert.equal(authorization.status, "ACTIVE_IMPLEMENTATION_AUTHORIZED");
  assert.equal(authorization.boundaries.rewriteOriginalFillsOrOutcomes, false);
  const auditBefore = await fs.readFile(path.join(runtime, "audit.ndjson"));
  assert.equal((await verifyChainedAudit(path.join(runtime, "audit.ndjson"))).status, "VALID");
  const snapshot = await readJson(path.join(runtime, "latest.json"));
  const events = await readAudit();
  const candidates = [];
  const identities = [];
  for (const [symbol, orderId] of targets) {
    const matches = [...snapshot.closedPositions, ...snapshot.managedPositions].flatMap((row) =>
      row.symbol === symbol ? (row.partialExits ?? []).filter((partial) => String(partial.orderId) === orderId).map((partial) => ({ row, partial })) : []);
    assert.equal(matches.length, 1, `Ambiguous original partial: ${symbol}:${orderId}`);
    const { row, partial } = matches[0];
    const relative = `${directory}/${symbol}-${orderId}-signed-trades.json`;
    const bytes = await fs.readFile(path.join(root, relative));
    const evidence = JSON.parse(bytes);
    assert.equal(evidence.source, "SIGNED_GET_USER_TRADES");
    assert.equal(evidence.venue, "BINANCE_USDM_TESTNET");
    assert.equal(evidence.symbol, symbol);
    assert.equal(String(evidence.orderId), orderId);
    const candidate = createPartialSettlementTimeRecovery({
      row, partial,
      tradeCost: { ...evidence.result, symbol, venue: evidence.venue, source: evidence.source },
      observedAt: new Date().toISOString(),
      evidenceReference: { path: relative, sha256: hash(bytes) },
    });
    const authorized = authorization.targetSettlements.filter((target) => target.symbol === symbol && String(target.orderId) === orderId);
    assert.equal(authorized.length, 1, "RECOVERY_TARGET_NOT_AUTHORIZED");
    assert.equal(authorized[0].recoveryId, candidate.recoveryId, "RECOVERY_EVIDENCE_NOT_AUTHORIZED");
    const prior = events.filter((event) => event.eventType === SETTLEMENT_TIME_RECOVERY_EVENT && event.symbol === symbol && String(event.orderId) === orderId);
    if (prior.length) {
      assert.equal(recoveredPartialSettlementTime(row, partial, prior, Date.parse(snapshot.accountObservedAt)), candidate.executedAt, `Conflicting recovery: ${symbol}:${orderId}`);
      assert.ok(prior.every((event) => event.recoveryId === candidate.recoveryId), "RECOVERY_ID_CONFLICT");
    } else candidates.push(candidate);
    identities.push({ symbol, orderId, executedAt: candidate.executedAt, netPnlUsdt: partial.netPnl, recoveryId: candidate.recoveryId });
  }
  const before = buildV3EquityCurve(snapshot, events);
  const preview = buildV3EquityCurve(snapshot, [...events, ...candidates]);
  assert.equal(preview.metrics.settlementEvidence.status, "COMPLETE");
  assert.equal(preview.metrics.settlementEvidence.unlocatedSettlementCount, 0);
  assert.deepEqual(preview.current, before.current);
  assert.ok(Math.abs(preview.curve.points.at(-1).realizedLearningEquityUsdt - preview.current.realizedLearningEquityUsdt) < 1e-8);
  assert.equal(preview.curve.points.length - before.curve.points.length, candidates.length);
  for (const row of identities) assert.equal(preview.curve.points.find((point) => point.id === `partial:${row.symbol}:${row.orderId}`).timestamp, row.executedAt);
  const appended = [];
  if (apply) for (const event of candidates) appended.push(await appendChainedAudit(path.join(runtime, "audit.ndjson"), event));
  const auditVerification = await verifyChainedAudit(path.join(runtime, "audit.ndjson"));
  assert.equal(auditVerification.status, "VALID");
  const auditAfter = await fs.readFile(path.join(runtime, "audit.ndjson"));
  assert.ok(auditAfter.subarray(0, auditBefore.length).equals(auditBefore), "ORIGINAL_AUDIT_PREFIX_CHANGED");
  const after = buildV3EquityCurve(snapshot, apply ? await readAudit() : [...events, ...candidates]);
  assert.equal(after.metrics.settlementEvidence.status, "COMPLETE");
  const summary = {
    status: apply ? "APPLIED" : "VALIDATED_PREVIEW", recordedAt: new Date().toISOString(),
    authorizationId: SETTLEMENT_TIME_RECOVERY_AUTHORIZATION, sourceAsOf: snapshot.accountObservedAt,
    identities, appendedEventCount: appended.length, plannedEventCount: candidates.length,
    eventIds: appended.map((event) => event.eventId), auditVerification,
    before: { pointCount: before.curve.points.length, metrics: before.metrics, terminalEquityUsdt: before.curve.points.at(-1).realizedLearningEquityUsdt },
    after: { pointCount: after.curve.points.length, metrics: after.metrics, terminalEquityUsdt: after.curve.points.at(-1).realizedLearningEquityUsdt },
    originalAuditPrefix: { bytes: auditBefore.length, sha256: hash(auditBefore), preserved: true },
    originalFinancialRecordsWritten: false, exchangeRequestsByApplication: 0,
  };
  const receipt = apply ? (appended.length ? "application.json" : "idempotency-verification.json") : "preview.json";
  await fs.writeFile(path.join(root, directory, receipt), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: summary.status, appended: appended.length, planned: candidates.length, beforeMissing: before.metrics.settlementEvidence.unlocatedSettlementCount, afterMissing: after.metrics.settlementEvidence.unlocatedSettlementCount, recoveredNetPnlUsdt: identities.reduce((sum, row) => sum + row.netPnlUsdt, 0), receipt: `${directory}/${receipt}` })}\n`);
}

assert.ok(process.argv.slice(2).every((arg) => arg === "--apply"), "UNSUPPORTED_RECOVERY_ARGUMENT");
const apply = process.argv.includes("--apply");
const lockPath = path.join(runtime, "settlement-time-recovery.lock");
const lock = apply ? await fs.open(lockPath, "wx") : null;
try { await recover(apply); }
finally { if (lock) { await lock.close(); await fs.unlink(lockPath); } }
