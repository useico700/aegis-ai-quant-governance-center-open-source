import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCandidateReport } from "../../../../app/v2-ledger/account-shadow/candidate-contract.mjs";
import {
  advanceAbnormalLoss,
  applyFundingSettlement,
  applyIndependentEntry,
  applyIndependentR21Action,
  applyR22MarketObservation,
  classifyCompletedCampaigns,
  deriveIndependentEntry,
  initialCandidateState,
  observeConfirmedAccountHigh,
  planAccountProtectionDeleverage,
  recomputeAccount,
  r15ReplacementEvidenceReady,
  riskCapacity,
  seedHealthyForwardBaseline,
  validateStateTransition,
} from "../engine.mjs";
import { inputStatus, sha256, stableStringify, validateInputFreshness } from "../contracts.mjs";
import { AppendOnlyLedger } from "../ledger.mjs";
import { commitStateAndAudits, consumeDepth, createDepthPool, observeFundingSchedules, persistDepthPool, reconcileFundingEvidence, recoverPendingExecutionCommit } from "../collector.mjs";
import {
  acknowledgePendingSummary,
  assertIdempotentSequence,
  preparePendingSummary,
  readJsonIfPresent,
  runtimePaths,
  writeJsonAtomic,
} from "../persistence.mjs";
import { C_POLICY } from "../policy.mjs";
import { r13CoverageAt, validateClosedBarSeries } from "../evidence.mjs";
import { rebaseInputHealth } from "../publisher.mjs";
import { LocalResourceGuard, registerResourceGuard } from "../resource-guard.mjs";
import { applyBookTicker, CausalOrderBook, normalizeWsPayload } from "../ws-protocol.mjs";
import { CausalMarketReducer } from "../causal-reducer.mjs";
import { ContinuousMarketCapture } from "../continuous-capture.mjs";

const NOW = Date.parse("2026-09-06T05:00:00.000Z");
const ISO = new Date(NOW).toISOString();

function healthyInputs() {
  return {
    baselineAccount: inputStatus("HEALTHY", ISO, 0),
    eventLedger: inputStatus("HEALTHY", ISO, 0, { cursor: 100 }),
    quote: inputStatus("HEALTHY", ISO, 0, { cursor: 101 }),
    depth: inputStatus("HEALTHY", ISO, 0, { cursor: 102 }),
    funding: inputStatus("HEALTHY", ISO, 0, { cursor: 103 }),
    metadata: inputStatus("HEALTHY", ISO, 0, { sha256: "a".repeat(64) }),
  };
}

function seededState(equity = 100_000) {
  const state = initialCandidateState({ createdAt: ISO, sourceCursor: { sequence: 100, hash: "h" }, carryInPositionIds: ["carry-1"] });
  const seeded = seedHealthyForwardBaseline(state, {
    sourceAsOf: ISO,
    realizedEquityUsdt: equity,
    liquidationNetEquityUsdt: equity,
    inputs: healthyInputs(),
  });
  seeded.blockers = [];
  seeded.capabilities.continuousTickBboDepthCapture = true;
  seeded.localResource = { newCandidateEntriesAllowed: true, paused: false };
  seeded.governanceCandidateEntryEngineeringAccepted = true;
  return seeded;
}

function opportunity(overrides = {}) {
  return {
    sequence: 101,
    previousHash: "h",
    hash: "x",
    eventId: "source-open-1",
    type: "PAPER_POSITION_OPENED",
    marketTime: NOW + 1_000,
    payload: {
      id: "baseline-forward-1",
      symbol: "BTCUSDT",
      direction: 1,
      implementationRevision: "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION",
      intersectionId: "intersection-1",
      intersectionTime: NOW,
      initialStop: 90,
      entryQualityGuard: {
        allowed: true,
        maximumSignalAgeMs: 180_000,
        maximumDisplacementBps: 50,
        referencePrice: 100.4,
        signalExpiresAt: NOW + 180_000,
      },
      costEfficiencyGuard: { allowed: true, maximumCompleteLifecycleCostR: 0.12 },
      ...overrides,
    },
  };
}

function market(depthAsks = [[100, 1], [100.4, 100]]) {
  return {
    quote: { schemaVersion: 1, type: "PUBLIC_BBO", symbol: "BTCUSDT", bid: 99.9, ask: 100, updateId: 1, eventTime: NOW + 2_000, transactionTime: NOW + 2_000, receivedAt: NOW + 2_000 },
    depth: { schemaVersion: 1, type: "PUBLIC_PARTIAL_DEPTH", symbol: "BTCUSDT", lastUpdateId: 1, eventTime: NOW + 2_000, receivedAt: NOW + 2_000, bids: [[99.9, 100]], asks: depthAsks, snapshotSemantics: "TOP_LEVELS_COMPLETE_AT_EVENT_NOT_FULL_DIFF_HISTORY" },
    funding: { schemaVersion: 1, type: "PUBLIC_MARK_FUNDING", symbol: "BTCUSDT", markPrice: 100, fundingRate: 0.0001, eventTime: NOW + 2_000, nextFundingTime: NOW + 8 * 3_600_000, receivedAt: NOW + 2_000 },
    metadata: { schemaVersion: 1, type: "PUBLIC_EXCHANGE_METADATA", symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5, sourceAsOf: ISO, sourceSha256: "b".repeat(64) },
  };
}

const fullContext = { r13Eligible: true, r21PortfolioProtectionReady: true, r22TrailInputsReady: true, localResourceEntryAllowed: true, allInputsHealthy: true, continuousCaptureVerified: true, candidateEntryEngineeringAccepted: true, sourceObservedAt: NOW + 1_500 };

test("frozen fixture validates against the strict AEGIS report validator", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("../fixtures/candidate-summary.example.json", import.meta.url), "utf8"));
  assert.equal(validateCandidateReport(fixture), fixture);
  const schema = JSON.parse(await fs.readFile(new URL("../schemas/candidate-summary.schema.json", import.meta.url), "utf8"));
  for (const field of ["cumulativeRebalanceCostsUsdt", "maximumDrawdownFraction"]) assert.ok(schema.properties.account.required.includes(field));
  assert.ok(schema.properties.validation.required.includes("excludedCompletedCampaigns"));
  assert.equal(schema.$defs.cursorInputStatus.additionalProperties, false);
  assert.equal(schema.$defs.hashInputStatus.additionalProperties, false);
});

test("C starts empty, excludes carry-in and seeds E0/F0 only from healthy forward net equity", () => {
  const waiting = initialCandidateState({ createdAt: ISO, sourceCursor: { sequence: 10, hash: "h" }, carryInPositionIds: ["carry-1"] });
  assert.deepEqual(waiting.positions, []);
  const stillWaiting = seedHealthyForwardBaseline(waiting, { sourceAsOf: ISO, realizedEquityUsdt: 100_000, liquidationNetEquityUsdt: 101_000, inputs: { ...healthyInputs(), depth: inputStatus("STALE", ISO, 2_000, { cursor: 1 }) } });
  assert.equal(stillWaiting.startedAt, null);
  const state = seededState();
  assert.equal(state.account.initialEquityUsdt, 100_000);
  assert.equal(state.account.protectionFloorUsdt, 99_000);
  assert.equal(state.positions.length, 0);
  assert.throws(() => validateStateTransition(state, { ...structuredClone(state), carryInPositionIds: [] }), /C_IMMUTABLE_CARRY_IN_SET_CHANGED/);
});

test("confirmed H requires two different causal books 30-45 seconds apart and uses their lower net", () => {
  const start = seededState();
  const ordinary = observeConfirmedAccountHigh(start, { sourceAsOf: new Date(NOW + 1_000).toISOString(), liquidationNetEquityUsdt: 100_000, healthy: true, bookId: "book-normal" });
  const spike = observeConfirmedAccountHigh(ordinary, { sourceAsOf: new Date(NOW + 2_000).toISOString(), liquidationNetEquityUsdt: 110_000, healthy: true, bookId: "book-spike" });
  assert.equal(spike.account.confirmedHighEquityUsdt, 100_000);
  assert.equal(spike.account.protectionFloorUsdt, 99_000);
  assert.equal(spike.pendingHighProof.liquidationNetEquityUsdt, 110_000);
  const repeated = observeConfirmedAccountHigh(spike, { sourceAsOf: new Date(NOW + 33_000).toISOString(), liquidationNetEquityUsdt: 109_000, healthy: true, bookId: "book-spike" });
  assert.equal(repeated.pendingHighProof, null);
  assert.equal(repeated.account.confirmedHighEquityUsdt, 100_000);
  const first = observeConfirmedAccountHigh(repeated, { sourceAsOf: new Date(NOW + 34_000).toISOString(), liquidationNetEquityUsdt: 108_000, healthy: true, bookId: "book-a" });
  const confirmed = observeConfirmedAccountHigh(first, { sourceAsOf: new Date(NOW + 65_000).toISOString(), liquidationNetEquityUsdt: 106_000, healthy: true, bookId: "book-b" });
  assert.equal(confirmed.account.confirmedHighEquityUsdt, 106_000);
  assert.equal(confirmed.account.protectionFloorUsdt, 103_600);
});

test("risk capacity uses realized-only capital, protection cushion, shared direction and portfolio stress", () => {
  const state = seededState();
  assert.equal(riskCapacity(state, { direction: 1 }), 250);
  state.account.cashRealizedEquityUsdt = 100_000;
  state.account.liquidationNetEquityUsdt = 110_000;
  state.account.protectionFloorUsdt = 99_000;
  state.positions.push({ direction: 1, initialRiskUsdt: 200, stressRiskUsdt: 200 });
  assert.equal(riskCapacity(state, { direction: 1 }), 550);
  state.account.liquidationNetEquityUsdt = 99_400;
  assert.equal(riskCapacity(state, { direction: -1 }), 0);
  state.abnormalLoss.status = "YELLOW";
  assert.equal(riskCapacity(state, { direction: -1 }), 0);
});

test("multi-position valuation requires a fresh causal mark for every open position", () => {
  const state = seededState();
  state.positions = [
    { id: "p1", symbol: "BTCUSDT", direction: 1, entry: 100, stop: 90, quantity: 1, initialRiskUsdt: 10, stressRiskUsdt: 10, lastMark: 101, lastMarkAt: NOW },
    { id: "p2", symbol: "ETHUSDT", direction: -1, entry: 50, stop: 55, quantity: 2, initialRiskUsdt: 10, stressRiskUsdt: 10, lastMark: 49, lastMarkAt: NOW - 2_000 },
  ];
  recomputeAccount(state, { BTCUSDT: { price: 102, observedAt: NOW + 2_000 } }, { valuationAt: NOW + 2_000 });
  assert.ok(state.blockers.includes("C_ACCOUNT_MARK_MISSING_OR_STALE"));
  assert.equal(state.account.availableCandidateRiskUsdt, 0);
  recomputeAccount(state, {
    BTCUSDT: { price: 102, observedAt: NOW + 3_000 },
    ETHUSDT: { price: 48, observedAt: NOW + 3_000 },
  }, { valuationAt: NOW + 3_000 });
  assert.equal(state.blockers.includes("C_ACCOUNT_MARK_MISSING_OR_STALE"), false);
  assert.equal(state.accountValuation.status, "HEALTHY_CAUSAL_MARKS");
});

test("final size is refit from depth, slippage and fees without exceeding risk or leverage", () => {
  const state = seededState();
  const derived = deriveIndependentEntry(state, opportunity(), market(), fullContext);
  assert.equal(derived.accepted, true, derived.blockers?.join(","));
  assert.ok(derived.position.quantity < 25);
  assert.ok(derived.position.initialRiskUsdt <= riskCapacity(state, { direction: 1 }) + 1e-8);
  assert.ok(derived.position.entry > 100);
  assert.ok(Math.abs(derived.position.initialRiskPerUnit * derived.position.quantity - derived.position.initialRiskUsdt) < 1e-9);
  assert.equal(derived.position.costModel.initialRiskIncludesEntryAndModeledStopExitFees, true);
  const opened = applyIndependentEntry(state, derived);
  assert.ok(Math.abs(opened.account.cashRealizedEquityUsdt - (state.account.cashRealizedEquityUsdt - derived.fee.amountUsdt)) < 1e-9);
  assert.ok(Math.abs(opened.account.cumulativeEntryFeesUsdt - derived.fee.amountUsdt) < 1e-9);
});

test("missing inherited R13/R21/R22 gates and stale inputs fail closed", () => {
  const state = seededState();
  const blocked = deriveIndependentEntry(state, opportunity(), market(), { ...fullContext, r21PortfolioProtectionReady: false });
  assert.equal(blocked.accepted, false);
  assert.ok(blocked.blockers.includes("R21_FULL_PORTFOLIO_PROTECTION_INPUT_NOT_READY"));
  const stale = market();
  stale.quote.receivedAt = NOW - C_POLICY.maximumQuoteAgeMs - 1;
  assert.equal(validateInputFreshness({ ...stale, now: NOW }).healthy, false);
});

test("REST evidence HOLD and unaccepted governance engineering gate prohibit new C risk in derive and apply layers", () => {
  const open = seededState();
  const accepted = deriveIndependentEntry(open, opportunity(), market([[100, 100]]), fullContext);
  assert.equal(accepted.accepted, true);
  const hold = structuredClone(open);
  hold.capabilities.continuousTickBboDepthCapture = false;
  hold.blockers = ["CONTINUOUS_TICK_BBO_DEPTH_CAPTURE_INCOMPLETE"];
  assert.equal(riskCapacity(hold, { direction: 1 }), 0);
  const denied = deriveIndependentEntry(hold, opportunity(), market([[100, 100]]), { ...fullContext, continuousCaptureVerified: false });
  assert.equal(denied.accepted, false);
  assert.ok(denied.blockers.includes("C_ENTRY_HARD_GATE_GLOBAL_BLOCKERS_PRESENT"));
  assert.throws(() => applyIndependentEntry(hold, accepted), /C_ENTRY_HARD_GATE_APPLY_REJECTED/);
  const governanceHold = structuredClone(open);
  governanceHold.governanceCandidateEntryEngineeringAccepted = false;
  assert.equal(deriveIndependentEntry(governanceHold, opportunity(), market([[100, 100]]), { ...fullContext, candidateEntryEngineeringAccepted: false }).accepted, false);
});

test("R15 replacement requires both a new quote and a new depth version after old-position close", () => {
  const pending = { oldPositionClosedAtReceiveSeq: 10 };
  assert.equal(r15ReplacementEvidenceReady(pending, { quote: { receiveSeq: 11 }, depth: { decisionReceiveSeq: 10 } }), false);
  assert.equal(r15ReplacementEvidenceReady(pending, { quote: { receiveSeq: 10 }, depth: { decisionReceiveSeq: 11 } }), false);
  assert.equal(r15ReplacementEvidenceReady(pending, { quote: { receiveSeq: 11 }, depth: { decisionReceiveSeq: 11 } }), true);
});

test("R22 derives C exits from C position and rejects a 2R observation atomically without trail inputs", () => {
  const state = seededState();
  const opened = applyIndependentEntry(state, deriveIndependentEntry(state, opportunity(), market([[100, 100]]), fullContext));
  const highMarket = market();
  highMarket.quote = { ...highMarket.quote, bid: 140, ask: 140.1, receivedAt: NOW + 3_000, eventTime: NOW + 3_000, transactionTime: NOW + 3_000 };
  highMarket.depth = { ...highMarket.depth, receivedAt: NOW + 3_000, eventTime: NOW + 3_000, bids: [[140, 100]], asks: [[140.1, 100]] };
  const blocked = applyR22MarketObservation(opened, "BTCUSDT", highMarket);
  assert.equal(blocked.events.length, 0);
  assert.deepEqual(blocked.state, opened);
  const managed = applyR22MarketObservation(opened, "BTCUSDT", highMarket, { inputsReady: true, confirmed1hStop: 110, closed15mAtrStop: 115 });
  assert.deepEqual(managed.events.map((event) => event.reason), ["PARTIAL_40_AT_0_5R", "PARTIAL_25_AT_1R", "PARTIAL_20_AT_2R"]);
  assert.ok(managed.state.positions[0].quantity / managed.state.positions[0].originalQuantity >= 0.15);
  assert.ok(managed.state.positions[0].quantity / managed.state.positions[0].originalQuantity < 0.151);
  assert.equal(managed.state.positions[0].stop, 115);
  const runnerMarket = structuredClone(highMarket);
  runnerMarket.quote.receivedAt = NOW + 3_500;
  runnerMarket.quote.eventTime = NOW + 3_500;
  runnerMarket.quote.transactionTime = NOW + 3_500;
  runnerMarket.depth.receivedAt = NOW + 3_500;
  runnerMarket.depth.eventTime = NOW + 3_500;
  const runner = applyR22MarketObservation(managed.state, "BTCUSDT", runnerMarket, { inputsReady: true, confirmed1hStop: 120, closed15mAtrStop: 125 });
  assert.equal(runner.state.positions[0].stop, 125);
  const locked = structuredClone(opened);
  locked.positions[0].stop = 131;
  const stoppedMarket = structuredClone(highMarket);
  stoppedMarket.quote = { ...stoppedMarket.quote, bid: 130, ask: 130.1 };
  stoppedMarket.depth = { ...stoppedMarket.depth, bids: [[129, 100]], asks: [[130.1, 100]] };
  const stopped = applyR22MarketObservation(locked, "BTCUSDT", stoppedMarket);
  assert.equal(stopped.events[0].reason, "STOP");
});

test("funding history settles once at settlement-time quantity and affects only C realized cash", () => {
  const base = seededState();
  const opened = applyIndependentEntry(base, deriveIndependentEntry(base, opportunity(), market([[100, 100]]), fullContext));
  const settlement = { symbol: "BTCUSDT", fundingTime: NOW + 8 * 3_600_000, fundingRate: 0.001, markPrice: 105 };
  const funded = applyFundingSettlement(opened, settlement);
  const expected = opened.positions[0].quantity * 105 * 0.001;
  assert.ok(Math.abs((opened.account.cashRealizedEquityUsdt - funded.account.cashRealizedEquityUsdt) - expected) < 1e-8);
  assert.equal(applyFundingSettlement(funded, settlement), funded);
  assert.equal(funded.positions[0].lastFundingTime, settlement.fundingTime);
});

test("completed campaigns wait for funding coverage and incomplete paths are excluded", () => {
  const state = seededState();
  state.closedPositions.push({ id: "closed", symbol: "BTCUSDT", openedAt: NOW, closedAt: NOW + 1_000, fundingCoverageThrough: NOW, evidenceEligibility: { continuousTickBboDepth: false, sourceHashContinuous: true, noUnknownSameBarPath: false } });
  assert.equal(classifyCompletedCampaigns(state).validation.excludedCompletedCampaigns, 0);
  state.closedPositions[0].fundingCoverageThrough = NOW + 1_000;
  const classified = classifyCompletedCampaigns(state);
  assert.equal(classified.validation.excludedCompletedCampaigns, 1);
  assert.equal(classified.closedPositions[0].validationDisposition, "EXCLUDED_CAPTURE_INCOMPLETE");
});

test("empty funding history cannot cover a closed campaign before a causally scheduled settlement arrives late", () => {
  const base = seededState();
  const opened = applyIndependentEntry(base, deriveIndependentEntry(base, opportunity(), market([[100, 100]]), fullContext));
  const fundingTime = NOW + 8 * 3_600_000;
  const closedAt = fundingTime + 30_000;
  const position = opened.positions[0];
  position.closedAt = closedAt;
  position.quantity = 0;
  position.evidenceEligibility = { continuousTickBboDepth: true, sourceHashContinuous: true, noUnknownSameBarPath: true };
  opened.positions = [];
  opened.closedPositions = [position];
  let scheduled = observeFundingSchedules(opened, [{ symbol: "BTCUSDT", nextFundingTime: fundingTime }], NOW + 1_000);
  scheduled = observeFundingSchedules(scheduled, [{ symbol: "BTCUSDT", nextFundingTime: fundingTime + 8 * 3_600_000 }], closedAt + 1_000);
  const empty = reconcileFundingEvidence(scheduled, { symbol: "BTCUSDT", rows: [], serverTime: closedAt + 1_000 }).state;
  assert.ok(Number(empty.closedPositions[0].fundingCoverageThrough ?? 0) < closedAt);
  assert.equal(classifyCompletedCampaigns(empty).validation.eligibleCompletedCampaigns, 0);
  const late = reconcileFundingEvidence(empty, { symbol: "BTCUSDT", rows: [{ symbol: "BTCUSDT", fundingTime, fundingRate: 0.001, markPrice: 105 }], serverTime: closedAt + 61_000 }).state;
  assert.equal(late.closedPositions[0].fundingCoverageThrough, closedAt);
  assert.ok(late.closedPositions[0].cumulativeFundingUsdt > 0);
  assert.equal(classifyCompletedCampaigns(late).validation.eligibleCompletedCampaigns, 1);
});

test("account protection reduces excess stress and a floor gap exits only at causal depth", () => {
  const base = seededState();
  let opened = applyIndependentEntry(base, deriveIndependentEntry(base, opportunity(), market([[100, 100]]), fullContext));
  opened.account.liquidationNetEquityUsdt = 100_000;
  opened.account.protectionFloorUsdt = 99_900;
  opened.account.remainingProtectionCushionUsdt = 100;
  opened.account.existingStressRiskUsdt = opened.positions[0].stressRiskUsdt;
  const reduce = planAccountProtectionDeleverage(opened);
  assert.equal(reduce[0].type, "ACCOUNT_PROTECTION_REDUCE");
  assert.equal(reduce[0].reason, "ACCOUNT_PROTECTION_STRESS_EXCEEDS_25_PERCENT_CUSHION");
  opened.account.liquidationNetEquityUsdt = 99_800;
  const exit = planAccountProtectionDeleverage(opened);
  assert.equal(exit[0].type, "ACCOUNT_FLOOR_EXIT");
  const gapMarket = market();
  gapMarket.quote = { ...gapMarket.quote, bid: 80, ask: 80.1, receivedAt: NOW + 4_000, eventTime: NOW + 4_000, transactionTime: NOW + 4_000 };
  gapMarket.depth = { ...gapMarket.depth, bids: [[79, 100]], asks: [[80.1, 100]], receivedAt: NOW + 4_000, eventTime: NOW + 4_000 };
  const result = applyIndependentR21Action(opened, exit[0], gapMarket);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.event.price < gapMarket.quote.bid);
  assert.equal(result.state.positions.length, 0);
  const noDepth = structuredClone(gapMarket); noDepth.depth.bids = [[79, 0.0001]];
  assert.ok(applyIndependentR21Action(opened, exit[0], noDepth).blockers.includes("R22_EXIT_DEPTH_INSUFFICIENT_NO_FILL"));
});

test("stress risk measures current liquidation giveback, not remaining planned entry risk", () => {
  const state = seededState();
  state.positions = [{ id: "profit", symbol: "BTCUSDT", direction: 1, entry: 100, stop: 90, originalQuantity: 10, quantity: 10, initialRiskUsdt: 100, plannedRiskUsdt: 100, stressRiskUsdt: 100, entryFeeUsdt: 0, cumulativeGrossPnlUsdt: 0, cumulativeExitFeesUsdt: 0, cumulativeFundingUsdt: 0, lastMark: 150, lastMarkAt: NOW }];
  recomputeAccount(state, { BTCUSDT: { price: 150, observedAt: NOW } }, { valuationAt: NOW });
  assert.ok(state.account.existingStressRiskUsdt > 500);
  assert.equal(state.account.portfolioPlannedRiskUsdt, 100);
  assert.ok(planAccountProtectionDeleverage(state).length > 0);
});

test("depth consumption survives restart and the same updateId never replenishes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-depth-"));
  const ledger = new AppendOnlyLedger(path.join(directory, "depth-consumption.ndjson"), "DEPTHCONSUMPTION", { retainRecords: true });
  await ledger.initialize();
  const raw = new Map([["BTCUSDT", { ...market().depth, lastUpdateId: 77, bids: [[100, 2]], asks: [[101, 2]] }]]);
  const state = {};
  const first = createDepthPool(state, raw, ledger);
  consumeDepth(first, "BTCUSDT", "bids", 1);
  await persistDepthPool(state, first, ledger, NOW);
  const recoveredLedger = new AppendOnlyLedger(path.join(directory, "depth-consumption.ndjson"), "DEPTHCONSUMPTION", { retainRecords: true });
  await recoveredLedger.initialize();
  const recovered = createDepthPool({}, raw, recoveredLedger);
  assert.equal(recovered.get("BTCUSDT").depth.bids[0][1], 1);
  consumeDepth(recovered, "BTCUSDT", "bids", 0.5);
  assert.equal(recovered.get("BTCUSDT").depth.bids[0][1], 0.5);
  assert.throws(() => createDepthPool({ depthConsumption: { BTCUSDT: { symbol: "BTCUSDT", lastUpdateId: 78, bidsRemaining: [[100, 1]], asksRemaining: [[101, 1]] } } }, raw, { records: [] }), /C_DEPTH_SNAPSHOT_UPDATE_ID_REGRESSION/);
});

test("a crash after atomic execution state preserves consumed depth and replays pending audit exactly once", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-commit-"));
  const stateFile = path.join(directory, "state.json");
  const state = { depthConsumption: {} };
  const raw = new Map([["BTCUSDT", { ...market().depth, lastUpdateId: 88, bids: [[100, 2]], asks: [[101, 2]] }]]);
  const pool = createDepthPool(state, raw, { records: [] });
  consumeDepth(pool, "BTCUSDT", "bids", 1);
  const audit = { type: "FILL", observedAt: NOW, payload: { quantity: 1 }, eventId: "fill-1" };
  await assert.rejects(() => commitStateAndAudits({ stateFile, state, pool, commitId: "commit-1", observedAt: NOW, audits: { events: [audit] }, ledgers: { events: { appendMany: async () => { throw new Error("SIMULATED_CRASH"); } } } }), /SIMULATED_CRASH/);
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(persisted.depthConsumption.BTCUSDT.bidsRemaining[0][1], 1);
  assert.equal(persisted.pendingExecutionCommit.commitId, "commit-1");
  const eventLedger = new AppendOnlyLedger(path.join(directory, "events.ndjson"), "EVENTS", { retainRecords: true });
  await eventLedger.initialize();
  const recovered = await recoverPendingExecutionCommit({ stateFile, state: persisted, ledgers: { events: eventLedger } });
  assert.equal(recovered.pendingExecutionCommit, null);
  assert.equal(eventLedger.records.length, 1);
  await recoverPendingExecutionCommit({ stateFile, state: recovered, ledgers: { events: eventLedger } });
  assert.equal(eventLedger.records.length, 1);
});

test("R13 requires the independent official coverage hash and is never retroactive", async () => {
  const raw = await fs.readFile(new URL("../../../../governance/evidence/v2-c-r13-official-calendar-20260906.json", import.meta.url), "utf8");
  const evidence = JSON.parse(raw);
  const attestation = { schemaVersion: 1, status: "VERIFIED_COMPLETE", calendarSha256: sha256(stableStringify(evidence.calendar)), evidenceSha256: sha256(raw), coverageStart: evidence.coverageStart, coverageEnd: evidence.coverageEnd, coverageEndExclusive: true, decisionUseNotBefore: evidence.decisionUseNotBefore, coveredCategories: evidence.coveredCategories };
  const policy = { enabled: true, freezeBeforeMinutes: 30, freezeAfterMinutes: 30 };
  assert.equal(r13CoverageAt({ calendar: evidence.calendar, attestation, eventTime: Date.parse(evidence.decisionUseNotBefore) - 1, policy }).ready, false);
  assert.equal(r13CoverageAt({ calendar: evidence.calendar, attestation, eventTime: Date.parse(evidence.decisionUseNotBefore), policy }).ready, true);
  assert.equal(r13CoverageAt({ calendar: evidence.calendar, attestation: { ...attestation, evidenceSha256: "x" }, eventTime: NOW, policy }).ready, false);
});

test("closed-bar warmup is causal, continuous and publisher freshness is exact", () => {
  const bars = Array.from({ length: 20 }, (_, index) => ({ openTime: index * 900_000, closeTime: (index + 1) * 900_000 - 1, open: 1, high: 2, low: 0.5, close: 1.5 }));
  assert.equal(validateClosedBarSeries(bars, "15m", 20 * 900_000 + 1).healthy, true);
  bars[10].openTime += 1;
  assert.equal(validateClosedBarSeries(bars, "15m", 20 * 900_000 + 1).healthy, false);
  const reportAt = new Date(NOW + 500).toISOString();
  const rebased = rebaseInputHealth({ inputs: healthyInputs(), blockers: [] }, reportAt);
  assert.equal(rebased.inputs.quote.freshnessMs, 500);
  assert.equal(rebased.inputs.quote.status, "HEALTHY");
});

test("abnormal-loss thresholds latch RED and never auto-release", () => {
  const state = seededState();
  advanceAbnormalLoss(state, 1.21); assert.equal(state.abnormalLoss.status, "YELLOW");
  advanceAbnormalLoss(state, 1.51); assert.equal(state.abnormalLoss.status, "ORANGE");
  advanceAbnormalLoss(state, 1.21); assert.equal(state.abnormalLoss.status, "ORANGE");
  state.abnormalLoss.orangeHealthyCycles = 2;
  advanceAbnormalLoss(state, 0, false); assert.equal(state.abnormalLoss.orangeHealthyCycles, 0);
  advanceAbnormalLoss(state, 2.01); assert.equal(state.abnormalLoss.status, "RED");
  for (let index = 0; index < 10; index += 1) advanceAbnormalLoss(state, 0, true);
  assert.equal(state.abnormalLoss.status, "RED");
  assert.equal(state.abnormalLoss.redLatched, true);
});

test("independent append-only ledger detects tampering and de-duplicates event IDs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-ledger-"));
  const file = path.join(directory, "events.ndjson");
  const ledger = new AppendOnlyLedger(file, "EVENTS");
  await ledger.initialize();
  assert.ok(await ledger.append("OBSERVED", NOW, { x: 1 }, "id-1"));
  assert.equal(await ledger.append("OBSERVED", NOW, { x: 1 }, "id-1"), null);
  const batch = await ledger.appendMany([
    { type: "OBSERVED", observedAt: NOW + 1, payload: { x: 2 }, eventId: "id-2" },
    { type: "OBSERVED", observedAt: NOW + 2, payload: { x: 3 }, eventId: "id-3" },
  ]);
  assert.deepEqual(batch.map((record) => record.sequence), [2, 3]);
  const clean = new AppendOnlyLedger(file, "EVENTS");
  await clean.initialize();
  const raw = await fs.readFile(file, "utf8");
  await fs.writeFile(file, raw.replace('"x":1', '"x":2'));
  await assert.rejects(() => new AppendOnlyLedger(file, "EVENTS").initialize(), /CHAIN_BREAK/);
});

test("a batch written before simulated fsync failure invalidates memory and is recovered by full ledger re-read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-fsync-"));
  const file = path.join(directory, "events.ndjson");
  let invalidated = 0;
  const uncertain = new AppendOnlyLedger(file, "EVENTS", {
    onUnsafeAppend: () => { invalidated += 1; },
    writeBatch: async (serialized) => {
      await fs.appendFile(file, serialized);
      throw new Error("SIMULATED_FSYNC_FAILURE_AFTER_COMPLETE_WRITE");
    },
  });
  await uncertain.initialize();
  await assert.rejects(() => uncertain.append("FILL", NOW, { quantity: 1 }, "uncertain-fill"), /SIMULATED_FSYNC_FAILURE/);
  assert.equal(invalidated, 1);
  await assert.rejects(() => uncertain.append("FILL", NOW + 1, { quantity: 1 }, "next-fill"), /REINITIALIZATION_REQUIRED/);
  const recovered = new AppendOnlyLedger(file, "EVENTS", { retainRecords: true });
  await recovered.initialize();
  assert.equal(recovered.sequence, 1);
  assert.equal(recovered.records[0].eventId, "uncertain-fill");
  assert.equal(await recovered.append("FILL", NOW, { quantity: 1 }, "uncertain-fill"), null);
});

test("uncertain ledger IO freezes every writer sharing the guard until budget and chain are re-read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-shared-guard-"));
  const guard = testResourceGuard(directory);
  const uncertainFile = path.join(directory, "uncertain.ndjson");
  const uncertain = new AppendOnlyLedger(uncertainFile, "UNCERTAIN", {
    resourceGuard: guard,
    writeBatch: async (serialized) => { await fs.appendFile(uncertainFile, serialized); throw new Error("FSYNC_UNCERTAIN"); },
  });
  const peer = new AppendOnlyLedger(path.join(directory, "peer.ndjson"), "PEER", { resourceGuard: guard });
  await uncertain.initialize(); await peer.initialize();
  await assert.rejects(() => uncertain.append("EVENT", NOW, { ok: true }, "u1"), /FSYNC_UNCERTAIN/);
  assert.equal(guard.unsafe, true);
  await assert.rejects(() => peer.append("EVENT", NOW, { ok: true }, "p1"), /GUARD_REINITIALIZATION_REQUIRED/);
  const recoveredGuard = testResourceGuard(directory);
  const recovered = new AppendOnlyLedger(uncertainFile, "UNCERTAIN", { resourceGuard: recoveredGuard, retainRecords: true });
  await recovered.initialize();
  assert.equal(recovered.records.length, 1);
});

test("ledger rejects a complete-looking JSON tail without newline and never repairs or appends to it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-tail-"));
  const file = path.join(directory, "events.ndjson");
  const clean = new AppendOnlyLedger(file, "EVENTS");
  await clean.initialize();
  await clean.append("EVENT", NOW, { ok: true }, "event-1");
  const complete = await fs.readFile(file, "utf8");
  await fs.writeFile(file, complete.trimEnd());
  const before = await fs.readFile(file);
  const recovered = new AppendOnlyLedger(file, "EVENTS");
  await assert.rejects(() => recovered.initialize(), /INCOMPLETE_TRAILING_RECORD/);
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(() => clean.initialize(), /ALREADY_INITIALIZED/);
});

test("local resource guard reserves before append, soft-blocks entries and latches queue overflow without auto-resume", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-resource-"));
  const contract = {
    id: "test-contract",
    maximumTotalBytes: 10_000,
    stopNewCandidateEntriesAtFraction: 0.9,
    controlEvidenceReserveBytes: 1_000,
    minimumAvailableDiskBytes: 100,
    maximumQueuedRawBytes: 50,
  };
  const guard = new LocalResourceGuard({ runtimeRoot: directory, contract, contractSha256: "a".repeat(64), totalBytes: 8_999, availableDiskBytes: 10_000, pauseRecord: null });
  assert.equal(guard.status().newCandidateEntriesAllowed, true);
  const reserved = await guard.reserveAppend(1, "TEST");
  guard.commit(reserved);
  assert.equal(guard.status().newCandidateEntriesAllowed, false);
  await assert.rejects(() => guard.reserveAppend(51, "RAW_BATCH"), /QUEUE_LIMIT/);
  assert.equal(guard.status().paused, true);
  const pause = JSON.parse(await fs.readFile(path.join(directory, "local-resource-pause.json"), "utf8"));
  assert.equal(pause.automaticResumeAllowed, false);
  const restarted = new LocalResourceGuard({ runtimeRoot: directory, contract, contractSha256: "a".repeat(64), totalBytes: 0, availableDiskBytes: 10_000, pauseRecord: pause });
  assert.equal(restarted.status().paused, true);
});

test("WS protocol validates routed event types while bookTicker update-id jumps are not treated as packet gaps", () => {
  const universe = new Set(["BTCUSDT"]);
  const first = normalizeWsPayload("PUBLIC", { e: "bookTicker", E: NOW, T: NOW, s: "BTCUSDT", st: 1, u: 10, b: "100", B: "2", a: "101", A: "3" }, NOW + 1, 1n, universe);
  const jumped = normalizeWsPayload("PUBLIC", { e: "bookTicker", E: NOW + 2, T: NOW + 2, s: "BTCUSDT", st: 1, u: 99, b: "100", B: "2", a: "101", A: "3" }, NOW + 3, 2n, universe);
  assert.equal(applyBookTicker(first, jumped), jumped);
  assert.throws(() => normalizeWsPayload("MARKET", { e: "bookTicker", E: NOW, T: NOW, s: "BTCUSDT", st: 1, u: 1, b: "1", B: "1", a: "2", A: "1" }, NOW, 1n, universe), /EVENT_TYPE_OR_CONNECTION_INVALID/);
  assert.throws(() => normalizeWsPayload("PUBLIC", { e: "bookTicker", E: NOW, T: NOW, s: "ETHUSDT", st: 1, u: 1, b: "1", B: "1", a: "2", A: "1" }, NOW, 1n, universe), /OUTSIDE_FIXED_UNIVERSE/);
});

test("diff-depth bridge enforces pu and virtual consumption survives untouched updates, quantity changes and reconnect snapshots", () => {
  const book = new CausalOrderBook("BTCUSDT");
  book.beginEpoch(1);
  const diff = (receiveSeq, U, u, pu, bids = [], asks = []) => ({ type: "WS_DIFF_DEPTH", symbol: "BTCUSDT", receiveSeq, firstUpdateId: U, finalUpdateId: u, previousFinalUpdateId: pu, bids, asks, eventTime: NOW + receiveSeq, receivedAt: NOW + receiveSeq });
  book.bufferDiff(diff(1, 90, 100, 80, [[99, 10]], []));
  book.bufferDiff(diff(2, 101, 110, 100, [[99, 11]], []));
  assert.equal(book.bridgeSnapshot({ symbol: "BTCUSDT", lastUpdateId: 95, bids: [[99, 9]], asks: [[101, 10]] }, 3).ready, true);
  book.consume("asks", 7);
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 3);
  book.applyDiff(diff(4, 111, 120, 110, [[99, 12]], []));
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 3);
  book.applyDiff(diff(5, 121, 130, 120, [], [[101, 12]]));
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 5);
  book.applyDiff(diff(6, 131, 140, 130, [], [[101, 8]]));
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 1);
  book.applyDiff(diff(7, 141, 150, 140, [], [[101, 0]]));
  book.applyDiff(diff(8, 151, 160, 150, [], [[101, 6]]));
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 6);
  book.consume("asks", 2);
  book.beginEpoch(2);
  book.bufferDiff(diff(9, 161, 170, 160, [[99, 13]], []));
  assert.equal(book.bridgeSnapshot({ symbol: "BTCUSDT", lastUpdateId: 165, bids: [[99, 13]], asks: [[101, 20]] }, 10).ready, true);
  assert.equal(book.snapshot().asks.find(([price]) => price === 101)[1], 18);
  const beforeInsufficient = book.exportState();
  assert.throws(() => book.consume("asks", 100), /AVAILABLE_LIQUIDITY_INSUFFICIENT/);
  assert.deepEqual(book.exportState(), beforeInsufficient);
  for (const invalid of [-1, 0, Number.NaN]) {
    assert.throws(() => book.consume("asks", invalid), /CONSUMPTION_QUANTITY_INVALID/);
    assert.deepEqual(book.exportState(), beforeInsufficient);
  }
  const gap = book.applyDiff(diff(11, 171, 180, 999, [], []));
  assert.equal(gap.blocker, "C_WS_DEPTH_PU_GAP");
  assert.equal(book.ready, false);
});

test("reconnect snapshot omission makes an old level unavailable without treating absence as a new generation", () => {
  const book = new CausalOrderBook("BTCUSDT");
  const diff = (receiveSeq, U, u, pu, bids = [], asks = []) => ({ type: "WS_DIFF_DEPTH", symbol: "BTCUSDT", receiveSeq, firstUpdateId: U, finalUpdateId: u, previousFinalUpdateId: pu, bids, asks, eventTime: NOW + receiveSeq, receivedAt: NOW + receiveSeq });
  book.beginEpoch(1);
  book.bufferDiff(diff(1, 90, 100, 80, [], []));
  book.bridgeSnapshot({ symbol: "BTCUSDT", lastUpdateId: 95, bids: [[99, 10]], asks: [[101, 10], [102, 6]] }, 2);
  book.consume("asks", 7);
  book.beginEpoch(2);
  book.bufferDiff(diff(3, 101, 110, 100, [[99, 11]], []));
  assert.equal(book.bridgeSnapshot({ symbol: "BTCUSDT", lastUpdateId: 105, bids: [[99, 11]], asks: [[102, 6]] }, 4).ready, true);
  assert.equal(book.snapshot().asks.some(([price]) => price === 101), false);
  assert.equal(book.exportState().asks["101"].consumedQuantity, 7);
  assert.equal(book.exportState().asks["101"].generation, 1);
});

test("causal reducer preserves cross-connection receive order instead of exchange-time order and invalidates gaps until a new epoch", async () => {
  const reducer = new CausalMarketReducer({ symbols: ["BTCUSDT"] });
  const base = { receivedAt: NOW, subscriptionVerified: true };
  await reducer.apply({ ...base, type: "WS_CONTROL_RESPONSE", receiveSeq: 1, connectionKind: "PUBLIC", epoch: 1, controlRole: "SUBSCRIPTION_VERIFIED" });
  await reducer.apply({ ...base, type: "WS_CONTROL_RESPONSE", receiveSeq: 2, connectionKind: "MARKET", epoch: 1, controlRole: "SUBSCRIPTION_VERIFIED" });
  await reducer.apply({ ...base, type: "WS_BOOK_TICKER", receiveSeq: 3, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", eventTime: NOW + 200, transactionTime: NOW + 200, updateId: 10, bid: 100, bidQuantity: 2, ask: 101, askQuantity: 3 });
  await reducer.apply({ ...base, type: "WS_DIFF_DEPTH", receiveSeq: 4, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", eventTime: NOW + 100, transactionTime: NOW + 100, firstUpdateId: 90, finalUpdateId: 100, previousFinalUpdateId: 80, bids: [[100, 10]], asks: [[101, 10]] });
  const bridged = await reducer.apply({ ...base, type: "WS_DEPTH_SNAPSHOT", receiveSeq: 5, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", lastUpdateId: 95, bids: [[100, 9]], asks: [[101, 9]] });
  assert.deepEqual(bridged.state.processedOrder.slice(-3).map((item) => item.receiveSeq), [3, 4, 5]);
  assert.deepEqual(bridged.state.processedOrder.slice(-3).map((item) => item.exchangeEventTime), [NOW + 200, NOW + 100, null]);
  assert.equal(bridged.state.continuous, true);
  assert.equal(bridged.decision.evidenceBinding.decisionReceiveSeq, 5);
  await reducer.apply({ ...base, type: "PUBLIC_AGG_TRADE", receiveSeq: 6, connectionKind: "MARKET", epoch: 1, symbol: "BTCUSDT", aggregateTradeId: 10, price: 100, quantity: 1, buyerWasMaker: false, eventTime: NOW + 300, tradeTime: NOW + 300 });
  const gap = await reducer.apply({ ...base, type: "PUBLIC_AGG_TRADE", receiveSeq: 7, connectionKind: "MARKET", epoch: 1, symbol: "BTCUSDT", aggregateTradeId: 12, price: 100, quantity: 1, buyerWasMaker: false, eventTime: NOW + 301, tradeTime: NOW + 301 });
  assert.equal(gap.state.continuous, false);
  assert.equal(gap.state.epochInvalid.MARKET, true);
  assert.throws(() => reducer.decisionView("BTCUSDT", 5), /DECISION_SEQUENCE_NOT_CURRENT/);
});

test("depth bootstrap buffer survives checkpoint restore and duplicate BBO cannot manufacture a new quote decision", async () => {
  const book = new CausalOrderBook("BTCUSDT");
  book.beginEpoch(1);
  book.bufferDiff({ type: "WS_DIFF_DEPTH", symbol: "BTCUSDT", receiveSeq: 1, firstUpdateId: 90, finalUpdateId: 100, previousFinalUpdateId: 80, bids: [[100, 10]], asks: [[101, 10]], eventTime: NOW, receivedAt: NOW });
  const restored = new CausalOrderBook("BTCUSDT", book.exportState());
  assert.equal(restored.bridgeSnapshot({ symbol: "BTCUSDT", lastUpdateId: 95, bids: [[100, 9]], asks: [[101, 9]] }, 2).ready, true);
  const reducer = new CausalMarketReducer({ symbols: ["BTCUSDT"] });
  const base = { receivedAt: NOW };
  await reducer.apply({ ...base, type: "WS_CONTROL_RESPONSE", receiveSeq: 1, connectionKind: "PUBLIC", epoch: 1, controlRole: "SUBSCRIPTION_VERIFIED" });
  await reducer.apply({ ...base, type: "WS_CONTROL_RESPONSE", receiveSeq: 2, connectionKind: "MARKET", epoch: 1, controlRole: "SUBSCRIPTION_VERIFIED" });
  await reducer.apply({ ...base, type: "WS_BOOK_TICKER", receiveSeq: 3, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", eventTime: NOW, transactionTime: NOW, updateId: 10, bid: 100, bidQuantity: 2, ask: 101, askQuantity: 3 });
  await reducer.apply({ ...base, type: "WS_DIFF_DEPTH", receiveSeq: 4, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", eventTime: NOW, transactionTime: NOW, firstUpdateId: 90, finalUpdateId: 100, previousFinalUpdateId: 80, bids: [[100, 10]], asks: [[101, 10]] });
  await reducer.apply({ ...base, type: "WS_DEPTH_SNAPSHOT", receiveSeq: 5, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", lastUpdateId: 95, bids: [[100, 9]], asks: [[101, 9]] });
  const quoteId = reducer.state.quotes.BTCUSDT.quoteId;
  const duplicate = await reducer.apply({ ...base, type: "WS_BOOK_TICKER", receiveSeq: 6, connectionKind: "PUBLIC", epoch: 1, symbol: "BTCUSDT", eventTime: NOW + 1, transactionTime: NOW + 1, updateId: 10, bid: 100, bidQuantity: 2, ask: 101, askQuantity: 3 });
  assert.equal(duplicate.decision, null);
  assert.equal(reducer.state.quotes.BTCUSDT.quoteId, quoteId);
});

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.subscriptions = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(serialized) {
    const request = JSON.parse(serialized);
    if (request.method === "SUBSCRIBE") this.subscriptions = [...request.params];
    const response = request.method === "SUBSCRIBE" ? { result: null, id: request.id } : { result: this.subscriptions, id: request.id };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
  }
  emit(stream, data) { this.onmessage?.({ data: JSON.stringify({ stream, data }) }); }
  close(code = 1000, reason = "TEST_CLOSE") { this.onclose?.({ code, reason }); }
}

function testResourceGuard(directory, maximumQueuedRawBytes = 8 * 1024 * 1024) {
  return registerResourceGuard(new LocalResourceGuard({
    runtimeRoot: directory,
    contract: { id: "test", maximumTotalBytes: 64 * 1024 * 1024, stopNewCandidateEntriesAtFraction: 0.9, controlEvidenceReserveBytes: 1024 * 1024, minimumAvailableDiskBytes: 1, maximumQueuedRawBytes },
    contractSha256: "f".repeat(64),
    totalBytes: 0,
    availableDiskBytes: 1024 * 1024 * 1024,
    pauseRecord: null,
  }));
}

test("continuous capture serializes two socket state writers and fixes receive clocks and global sequence before delayed processing", async () => {
  FakeWebSocket.instances = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-ws-"));
  const guard = testResourceGuard(directory);
  const seen = [];
  const capture = new ContinuousMarketCapture({
    runtimeRoot: directory,
    symbols: ["BTCUSDT"],
    resourceGuard: guard,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: async () => ({ ok: true, json: async () => ({ lastUpdateId: 95, bids: [["100", "10"]], asks: [["101", "10"]] }) }),
    onPersistedEvent: async (event) => { seen.push(event); },
  });
  await capture.start();
  await capture.waitUntilSubscribed();
  await capture.ingestChain;
  const publicSocket = FakeWebSocket.instances.find((socket) => socket.url.includes("/public/"));
  const marketSocket = FakeWebSocket.instances.find((socket) => socket.url.includes("/market/"));
  capture.ingestChain = capture.ingestChain.then(() => new Promise((resolve) => setTimeout(resolve, 30)));
  publicSocket.emit("btcusdt@bookTicker", { e: "bookTicker", E: NOW + 200, T: NOW + 200, s: "BTCUSDT", st: 1, u: 10, b: "100", B: "2", a: "101", A: "3" });
  marketSocket.emit("btcusdt@aggTrade", { e: "aggTrade", E: NOW + 100, T: NOW + 100, s: "BTCUSDT", st: 1, a: 5, p: "100", q: "1", f: 5, l: 5, m: false });
  await capture.ingestChain;
  const book = seen.find((event) => event.type === "WS_BOOK_TICKER");
  const trade = seen.find((event) => event.type === "PUBLIC_AGG_TRADE");
  assert.ok(book.receiveSeq < trade.receiveSeq);
  assert.ok(book.eventTime > trade.eventTime);
  assert.ok(book.processedAt - book.receivedAt >= 25);
  assert.ok(trade.receivedAt <= book.processedAt);
  await capture.persistState();
  const captureState = JSON.parse(await fs.readFile(path.join(directory, "continuous-capture-state.json"), "utf8"));
  assert.equal(captureState.lastReducedReceiveSeq, trade.receiveSeq);
  await capture.stop();
});

test("continuous capture replays raw-fsynced events only from the trusted reducer cursor after both crash windows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-ws-replay-"));
  const guard = testResourceGuard(directory);
  let reducerCursor = 0;
  const crashBeforeEffect = new ContinuousMarketCapture({ runtimeRoot: directory, symbols: ["BTCUSDT"], resourceGuard: guard, onPersistedEvent: async () => { throw new Error("CRASH_BEFORE_EFFECT"); } });
  await crashBeforeEffect.initialize();
  crashBeforeEffect.state.connections.PUBLIC = { epoch: 1, status: "SUBSCRIBED", subscribed: true, listed: true };
  crashBeforeEffect.enqueue("PUBLIC", 1, JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", E: NOW, T: NOW, s: "BTCUSDT", st: 1, u: 10, b: "100", B: "2", a: "101", A: "3" } }), { expectedStreams: ["btcusdt@bookTicker"] });
  await crashBeforeEffect.ingestChain.catch(() => {});
  assert.equal(crashBeforeEffect.rawLedger.sequence, 1);
  const replayed = [];
  const recovered = new ContinuousMarketCapture({ runtimeRoot: directory, symbols: ["BTCUSDT"], resourceGuard: testResourceGuard(directory), getReducedReceiveSeq: async () => reducerCursor, onPersistedEvent: async (event) => { replayed.push(event.receiveSeq); reducerCursor = event.receiveSeq; } });
  await recovered.initialize();
  assert.deepEqual(replayed, [1]);
  assert.equal(reducerCursor, 1);
  const noDuplicate = [];
  const afterEffectCrash = new ContinuousMarketCapture({ runtimeRoot: directory, symbols: ["BTCUSDT"], resourceGuard: testResourceGuard(directory), getReducedReceiveSeq: async () => reducerCursor, onPersistedEvent: async (event) => noDuplicate.push(event.receiveSeq) });
  await afterEffectCrash.initialize();
  assert.deepEqual(noDuplicate, []);
});

test("continuous capture queue overflow latches resources and cannot drop a frame then continue healthy", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-ws-queue-"));
  const guard = new LocalResourceGuard({
    runtimeRoot: directory,
    contract: { id: "test", maximumTotalBytes: 64 * 1024 * 1024, stopNewCandidateEntriesAtFraction: 0.9, controlEvidenceReserveBytes: 1024 * 1024, minimumAvailableDiskBytes: 1, maximumQueuedRawBytes: 32 },
    contractSha256: "f".repeat(64), totalBytes: 0, availableDiskBytes: 1024 * 1024 * 1024, pauseRecord: null,
  });
  const capture = new ContinuousMarketCapture({ runtimeRoot: directory, symbols: ["BTCUSDT"], resourceGuard: guard, onPersistedEvent: async () => {} });
  await capture.initialize();
  capture.state.connections.PUBLIC = { epoch: 1, status: "SUBSCRIBED", subscribed: true, listed: true };
  capture.enqueue("PUBLIC", 1, JSON.stringify({ stream: "btcusdt@bookTicker", data: { e: "bookTicker", E: NOW, T: NOW, s: "BTCUSDT", st: 1, u: 10, b: "100", B: "2", a: "101", A: "3" } }), { expectedStreams: ["btcusdt@bookTicker"] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(guard.status().paused, true);
  assert.ok(capture.fatalError);
  assert.equal(capture.rawLedger.sequence, 0);
});

test("missing capture-state recovers epoch watermarks from trusted reducer before reconnect", async () => {
  FakeWebSocket.instances = [];
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-ws-epoch-"));
  const capture = new ContinuousMarketCapture({
    runtimeRoot: directory,
    symbols: ["BTCUSDT"],
    resourceGuard: testResourceGuard(directory),
    WebSocketImpl: FakeWebSocket,
    getReducerCheckpoint: async () => ({ lastReceiveSeq: 0, publicEpoch: 2, marketEpoch: 4 }),
    onPersistedEvent: async () => {},
  });
  await capture.initialize();
  assert.deepEqual(capture.state.epochs, { PUBLIC: 2, MARKET: 4 });
  await capture.connect("PUBLIC");
  assert.equal(capture.state.epochs.PUBLIC, 3);
  capture.stopping = true;
  for (const socket of capture.sockets.values()) socket.close();
});

test("slow context becomes usable only at its persisted global receive sequence", async () => {
  const reducer = new CausalMarketReducer({ symbols: ["BTCUSDT"] });
  const context = { schemaVersion: 1, type: "C_SLOW_CONTEXT_INGRESS", collectedAt: ISO, sourceHashes: { sample: "a".repeat(64) } };
  await reducer.apply({ type: "SLOW_CONTEXT_READY", receiveSeq: 1, connectionKind: "LOCAL", epoch: 0, receivedAt: NOW, context });
  assert.equal(reducer.state.slowContext.knownAtReceiveSeq, 1);
  assert.equal(reducer.state.slowContext.collectedAt, ISO);
});

test("paused control write cannot use the reserve to exceed the absolute hard total", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-control-hard-"));
  const guard = new LocalResourceGuard({ runtimeRoot: directory, contract: { id: "test", maximumTotalBytes: 10_000, stopNewCandidateEntriesAtFraction: 0.9, controlEvidenceReserveBytes: 2_000, minimumAvailableDiskBytes: 1, maximumQueuedRawBytes: 1_000 }, contractSha256: "f".repeat(64), totalBytes: 9_414, availableDiskBytes: 100_000, pauseRecord: { reason: "TEST" } });
  await assert.rejects(() => guard.writeControlJson(path.join(directory, "status.json"), { payload: "x".repeat(880) }), /CONTROL_WRITE_EXCEEDS_HARD_TOTAL/);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test("pending summary is exact-retry, <=20k, state-first acknowledgement and crash-recoverable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orion-v2-c-publish-"));
  const paths = runtimePaths(directory);
  const state = initialCandidateState({ createdAt: ISO, sourceCursor: { sequence: 1, hash: "h" }, carryInPositionIds: [] });
  await writeJsonAtomic(paths.state, state);
  const inputHealth = { inputs: healthyInputs(), blockers: [] };
  const pending = await preparePendingSummary({ state, inputHealth, sourceAsOf: ISO, pendingPath: paths.pendingSummary });
  const retry = await preparePendingSummary({ state, inputHealth, sourceAsOf: new Date(NOW + 1_000).toISOString(), pendingPath: paths.pendingSummary });
  assert.deepEqual(retry, pending);
  assert.ok(pending.bytes <= 20_000);
  assert.equal(validateCandidateReport(pending.payload), pending.payload);
  const acknowledged = await acknowledgePendingSummary({ state, statePath: paths.state, pendingPath: paths.pendingSummary, acknowledgedPath: paths.acknowledgedSummaries, sequence: 1, digest: pending.digest, acknowledgedAt: ISO });
  assert.equal((await readJsonIfPresent(paths.state)).publicationSequence, 1);
  assert.equal(await readJsonIfPresent(paths.pendingSummary), null);
  const pending2 = await preparePendingSummary({ state: acknowledged, inputHealth, sourceAsOf: new Date(NOW + 1_000).toISOString(), pendingPath: paths.pendingSummary });
  const crashPersisted = structuredClone(acknowledged);
  crashPersisted.publicationSequence = 2;
  crashPersisted.lastPublishedSourceAsOf = pending2.sourceAsOf;
  crashPersisted.lastPublishedDigest = pending2.digest;
  await writeJsonAtomic(paths.state, crashPersisted);
  const recovered = await acknowledgePendingSummary({ state: crashPersisted, statePath: paths.state, pendingPath: paths.pendingSummary, acknowledgedPath: paths.acknowledgedSummaries, sequence: 2, digest: pending2.digest, acknowledgedAt: new Date(NOW + 2_000).toISOString() });
  assert.equal(recovered.publicationSequence, 2);
  assert.equal(await readJsonIfPresent(paths.pendingSummary), null);
  const same = { sequence: 1, payload: { x: 1 } };
  assert.equal(assertIdempotentSequence(same, structuredClone(same)), true);
  assert.throws(() => assertIdempotentSequence(same, { sequence: 1, payload: { x: 2 } }), (error) => error.statusCode === 409);
});

test("summary payload never contains raw positions, orders or event arrays", async () => {
  const fixture = await fs.readFile(new URL("../fixtures/candidate-summary.example.json", import.meta.url), "utf8");
  for (const forbidden of ['"positions"', '"orders"', '"events"', '"opportunities"']) assert.equal(fixture.includes(forbidden), false);
  assert.equal(sha256(stableStringify(JSON.parse(fixture))).length, 64);
});
