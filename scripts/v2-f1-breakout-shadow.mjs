#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "./public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = path.join(ROOT, "experiments/v2-f1-breakout-distance/config.json");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "var/v2-f1-shadow");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function readNdjson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`INVALID_NDJSON_LINE_${index + 1}: ${error.message}`);
    }
  });
}

export function validateSourceChain(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!Number.isInteger(event.sequence) || !event.eventId || !event.hash) {
      throw new Error(`SOURCE_LEDGER_EVENT_INVALID_${index + 1}`);
    }
    if (index > 0) {
      const previous = events[index - 1];
      if (event.sequence !== previous.sequence + 1) {
        throw new Error(`SOURCE_LEDGER_SEQUENCE_GAP_${previous.sequence}_${event.sequence}`);
      }
      if (event.previousHash !== previous.hash) {
        throw new Error(`SOURCE_LEDGER_HASH_CHAIN_BREAK_${event.sequence}`);
      }
    }
  }
  return true;
}

export function candidateDecision(signal, minimumBreakoutDistanceAtr) {
  const distanceAtr = Number(signal?.distanceAtr);
  if (!Number.isFinite(distanceAtr)) {
    return { accepted: false, reason: "DISTANCE_ATR_MISSING", distanceAtr: null };
  }
  return {
    accepted: distanceAtr >= minimumBreakoutDistanceAtr,
    reason: distanceAtr >= minimumBreakoutDistanceAtr
      ? "MIN_BREAKOUT_DISTANCE_PASS"
      : "MIN_BREAKOUT_DISTANCE_FILTERED",
    distanceAtr,
  };
}

export function initialState(config, activationSequence, activationHash, activatedAt) {
  return {
    schemaVersion: 1,
    experimentId: config.experimentId,
    candidateVersion: config.candidateVersion,
    minimumBreakoutDistanceAtr: config.singleMajorChange.candidate,
    activatedAt,
    activationSequence,
    activationHash,
    lastSourceSequence: 0,
    lastSourceHash: null,
    shadowLastSequence: 0,
    shadowLastHash: null,
    signals: {},
    orders: {},
    positions: {},
    outcomes: {},
    updatedAt: activatedAt,
  };
}

function phaseFor(sourceSequence, state) {
  return sourceSequence <= state.activationSequence
    ? "RETROSPECTIVE_SCREENING_ONLY"
    : "FORWARD_OOS";
}

function compactSignal(payload, event, state, config) {
  const decision = candidateDecision(payload, config.singleMajorChange.candidate);
  return {
    signalId: payload.signalId,
    sourceSequence: event.sequence,
    sourceEventId: event.eventId,
    sourceStrategyVersion: payload.strategyVersion ?? null,
    decisionCloseTime: payload.decisionCloseTime ?? event.marketTime,
    phase: phaseFor(event.sequence, state),
    symbol: payload.symbol,
    side: payload.side,
    grade: payload.grade,
    path: payload.path,
    distanceAtr: decision.distanceAtr,
    candidateAccepted: decision.accepted,
    candidateReason: decision.reason,
    controlOrderCreated: false,
    controlOrderStatus: null,
    positionId: null,
    plannedRisk: null,
  };
}

export function applySourceEvents(state, events, config) {
  const emitted = [];
  for (const event of events) {
    if (event.sequence <= state.lastSourceSequence) continue;
    const payload = event.payload ?? {};
    if (event.type === "SIGNAL_ELIGIBLE" && payload.signalId) {
      const signal = compactSignal(payload, event, state, config);
      state.signals[payload.signalId] = signal;
      emitted.push({
        type: "F1_FILTER_DECISION",
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        marketTime: event.marketTime,
        payload: signal,
      });
    } else if (event.type === "SIM_ORDER_CREATED" && payload.signalId) {
      const signal = state.signals[payload.signalId];
      if (signal) {
        signal.controlOrderCreated = true;
        signal.controlOrderStatus = "PENDING";
        state.orders[payload.orderId] = payload.signalId;
      }
    } else if (["SIM_ORDER_EXPIRED", "SIM_ORDER_REJECTED", "SIM_ORDER_CANCELLED"].includes(event.type)) {
      const signalId = payload.signalId ?? state.orders[payload.orderId];
      const signal = state.signals[signalId];
      if (signal) signal.controlOrderStatus = event.type.replace("SIM_ORDER_", "");
    } else if (event.type === "SIM_ENTRY_FILL" && payload.positionId && payload.signalId) {
      const signal = state.signals[payload.signalId];
      if (signal) {
        signal.controlOrderStatus = "FILLED";
        signal.positionId = payload.positionId;
        const plannedRisk = Number(payload.plannedRisk);
        signal.plannedRisk = Number.isFinite(plannedRisk) && plannedRisk > 0 ? plannedRisk : null;
        state.positions[payload.positionId] = payload.signalId;
      }
    } else if (event.type === "POSITION_CLOSED" && payload.positionId) {
      const signalId = state.positions[payload.positionId];
      const signal = state.signals[signalId];
      if (signal && !state.outcomes[payload.positionId]) {
        const realizedNetPnl = Number(payload.realizedNetPnl);
        const outcome = {
          positionId: payload.positionId,
          signalId,
          sourceEventId: event.eventId,
          sourceSequence: event.sequence,
          phase: signal.phase,
          symbol: signal.symbol,
          side: signal.side,
          grade: signal.grade,
          path: signal.path,
          distanceAtr: signal.distanceAtr,
          candidateAccepted: signal.candidateAccepted,
          closeReason: payload.reason ?? null,
          realizedNetPnl: Number.isFinite(realizedNetPnl) ? realizedNetPnl : null,
          plannedRisk: signal.plannedRisk,
          realizedR: Number.isFinite(realizedNetPnl) && signal.plannedRisk
            ? realizedNetPnl / signal.plannedRisk
            : null,
          candidateObservedNetPnl: signal.candidateAccepted && Number.isFinite(realizedNetPnl)
            ? realizedNetPnl
            : 0,
          avoidedLoss: !signal.candidateAccepted && realizedNetPnl < 0 ? -realizedNetPnl : 0,
          missedProfit: !signal.candidateAccepted && realizedNetPnl > 0 ? realizedNetPnl : 0,
        };
        state.outcomes[payload.positionId] = outcome;
        emitted.push({
          type: "F1_CONTROL_OUTCOME_OBSERVED",
          sourceEventId: event.eventId,
          sourceSequence: event.sequence,
          marketTime: event.marketTime,
          payload: outcome,
        });
      }
    }
    state.lastSourceSequence = event.sequence;
    state.lastSourceHash = event.hash;
  }
  return emitted;
}

function enrichRiskMetricsFromSource(state, events) {
  for (const event of events) {
    if (event.type !== "SIM_ENTRY_FILL") continue;
    const payload = event.payload ?? {};
    const signal = state.signals[payload.signalId];
    if (!signal) continue;
    const plannedRisk = Number(payload.plannedRisk);
    if (Number.isFinite(plannedRisk) && plannedRisk > 0) signal.plannedRisk = plannedRisk;
  }
  for (const outcome of Object.values(state.outcomes)) {
    const signal = state.signals[outcome.signalId];
    const plannedRisk = Number(signal?.plannedRisk ?? outcome.plannedRisk);
    outcome.plannedRisk = Number.isFinite(plannedRisk) && plannedRisk > 0 ? plannedRisk : null;
    outcome.realizedR = outcome.plannedRisk && Number.isFinite(outcome.realizedNetPnl)
      ? outcome.realizedNetPnl / outcome.plannedRisk
      : null;
  }
}

function profitFactor(outcomes) {
  const grossProfit = outcomes.reduce(
    (sum, outcome) => sum + Math.max(outcome.realizedNetPnl ?? 0, 0),
    0,
  );
  const grossLoss = outcomes.reduce(
    (sum, outcome) => sum + Math.max(-(outcome.realizedNetPnl ?? 0), 0),
    0,
  );
  if (grossLoss === 0) return grossProfit > 0 ? null : 0;
  return grossProfit / grossLoss;
}

function meanR(outcomes) {
  const values = outcomes.map((outcome) => outcome.realizedR).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function phaseSummary(state, phase) {
  const signals = Object.values(state.signals).filter((signal) => signal.phase === phase);
  const outcomes = Object.values(state.outcomes).filter((outcome) => outcome.phase === phase);
  const accepted = signals.filter((signal) => signal.candidateAccepted);
  const filtered = signals.filter((signal) => !signal.candidateAccepted);
  const acceptedOutcomes = outcomes.filter((outcome) => outcome.candidateAccepted);
  const filteredOutcomes = outcomes.filter((outcome) => !outcome.candidateAccepted);
  const controlNetPnl = outcomes.reduce((sum, outcome) => sum + (outcome.realizedNetPnl ?? 0), 0);
  const candidateObservedNetPnl = acceptedOutcomes.reduce(
    (sum, outcome) => sum + (outcome.realizedNetPnl ?? 0),
    0,
  );
  const controlWinners = outcomes.filter((outcome) => outcome.realizedNetPnl > 0);
  const retainedWinners = acceptedOutcomes.filter((outcome) => outcome.realizedNetPnl > 0);
  const controlInitialStops = outcomes.filter((outcome) => outcome.closeReason === "INITIAL_STOP");
  const filteredInitialStops = filteredOutcomes.filter(
    (outcome) => outcome.closeReason === "INITIAL_STOP",
  );
  return {
    signals: signals.length,
    acceptedSignals: accepted.length,
    filteredSignals: filtered.length,
    filterFraction: signals.length ? filtered.length / signals.length : null,
    controlOrdersCreated: signals.filter((signal) => signal.controlOrderCreated).length,
    controlFills: signals.filter((signal) => signal.controlOrderStatus === "FILLED").length,
    attributedClosedTrades: outcomes.length,
    controlNetPnl,
    candidateObservedNetPnl,
    controlWinRate: outcomes.length ? controlWinners.length / outcomes.length : null,
    candidateObservedWinRate: acceptedOutcomes.length
      ? retainedWinners.length / acceptedOutcomes.length
      : null,
    controlProfitFactor: profitFactor(outcomes),
    candidateObservedProfitFactor: profitFactor(acceptedOutcomes),
    controlNetExpectancyR: meanR(outcomes),
    candidateObservedNetExpectancyR: meanR(acceptedOutcomes),
    conditionalDeltaNetPnl: candidateObservedNetPnl - controlNetPnl,
    avoidedLoss: filteredOutcomes.reduce((sum, outcome) => sum + outcome.avoidedLoss, 0),
    missedProfit: filteredOutcomes.reduce((sum, outcome) => sum + outcome.missedProfit, 0),
    winnerRetentionFraction: controlWinners.length ? retainedWinners.length / controlWinners.length : null,
    initialStopRemovalFraction: controlInitialStops.length
      ? filteredInitialStops.length / controlInitialStops.length
      : null,
  };
}

export function buildSummary(state, config, sourceEventCount) {
  return {
    schemaVersion: 1,
    experimentId: state.experimentId,
    candidateVersion: state.candidateVersion,
    status: config.status,
    generatedAt: new Date().toISOString(),
    threshold: {
      field: "minimumBreakoutDistanceAtr",
      control: config.singleMajorChange.control,
      candidate: config.singleMajorChange.candidate,
    },
    isolation: {
      paperRuntimeUnaffected: true,
      paperLedgerUnaffected: true,
      orderAuthority: false,
    },
    activation: {
      activatedAt: state.activatedAt,
      sourceSequence: state.activationSequence,
      sourceHash: state.activationHash,
    },
    source: {
      ledgerPath: config.source.ledgerPath,
      events: sourceEventCount,
      lastSequence: state.lastSourceSequence,
      lastHash: state.lastSourceHash,
    },
    retrospective: phaseSummary(state, "RETROSPECTIVE_SCREENING_ONLY"),
    forward: phaseSummary(state, "FORWARD_OOS"),
    promotionGate: config.promotionGate,
    limitations: config.limitations,
  };
}

function loadShadowLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const events = readNdjson(filePath);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].previousHash !== events[index - 1].hash) {
      throw new Error(`SHADOW_LEDGER_HASH_CHAIN_BREAK_${events[index].sequence}`);
    }
  }
  return events;
}

function appendShadowEvents(filePath, emitted, state, existingIds) {
  if (!emitted.length) return 0;
  const lines = [];
  for (const event of emitted) {
    const eventId = sha256(`${state.experimentId}|${event.type}|${event.sourceEventId}`);
    if (existingIds.has(eventId)) continue;
    const core = {
      sequence: state.shadowLastSequence + 1,
      previousHash: state.shadowLastHash,
      eventId,
      experimentId: state.experimentId,
      type: event.type,
      sourceEventId: event.sourceEventId,
      sourceSequence: event.sourceSequence,
      marketTime: event.marketTime,
      observedAt: new Date().toISOString(),
      payload: event.payload,
    };
    const record = { ...core, hash: sha256(JSON.stringify(core)) };
    lines.push(JSON.stringify(record));
    state.shadowLastSequence = record.sequence;
    state.shadowLastHash = record.hash;
    existingIds.add(eventId);
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${lines.join("\n")}\n`);
  }
  return lines.length;
}

export function runObserver({ configPath = DEFAULT_CONFIG_PATH, outputRoot = DEFAULT_OUTPUT_ROOT } = {}) {
  const config = readJson(configPath);
  if (!config) throw new Error("F1_CONFIG_MISSING");
  const sourceEvents = readNdjson(config.source.ledgerPath);
  validateSourceChain(sourceEvents);
  const sourceTail = sourceEvents.at(-1);
  if (!sourceTail) throw new Error("F1_SOURCE_LEDGER_EMPTY");
  fs.mkdirSync(outputRoot, { recursive: true });
  const statePath = path.join(outputRoot, "state.json");
  const latestPath = path.join(outputRoot, "latest.json");
  const ledgerPath = path.join(outputRoot, "events.ndjson");
  const lockPath = path.join(outputRoot, "observer.lock");
  let lock;
  try {
    lock = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") return { status: "SKIP_LOCKED" };
    throw error;
  }
  try {
    let state = readJson(statePath);
    if (!state) {
      const activatedAt = new Date().toISOString();
      state = initialState(config, sourceTail.sequence, sourceTail.hash, activatedAt);
    }
    if (
      state.experimentId !== config.experimentId ||
      state.minimumBreakoutDistanceAtr !== config.singleMajorChange.candidate
    ) {
      throw new Error("F1_STATE_CONFIG_MISMATCH");
    }
    const shadowLedger = loadShadowLedger(ledgerPath);
    state.shadowLastSequence = shadowLedger.at(-1)?.sequence ?? 0;
    state.shadowLastHash = shadowLedger.at(-1)?.hash ?? null;
  const emitted = applySourceEvents(state, sourceEvents, config);
  enrichRiskMetricsFromSource(state, sourceEvents);
    const appended = appendShadowEvents(
      ledgerPath,
      emitted,
      state,
      new Set(shadowLedger.map((event) => event.eventId)),
    );
    state.updatedAt = new Date().toISOString();
    const summary = buildSummary(state, config, sourceEvents.length);
    writeJsonAtomic(statePath, state);
    writeJsonAtomic(latestPath, summary);
    return { status: "PASS", appended, summary };
  } finally {
    try { if (lock != null) fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function main() {
  const command = process.argv[2] ?? "run";
  if (command === "run") {
    const result = runObserver();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "status") {
    const summary = readJson(path.join(DEFAULT_OUTPUT_ROOT, "latest.json"));
    if (!summary) throw new Error("F1_STATUS_NOT_INITIALIZED");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error(`UNKNOWN_COMMAND_${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
