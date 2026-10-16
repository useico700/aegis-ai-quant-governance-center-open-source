import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateV4OwnerStop } from "./lib/v4-owner-stop.mjs";

const ROOT = process.env.AGENT_MEMORY_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEMORY_ROOT = process.env.AGENT_MEMORY_ROOT || path.join(ROOT, "memory");
const REGISTRY_PATH = path.join(MEMORY_ROOT, "registry.json");
const DECISIONS_PATH = path.join(MEMORY_ROOT, "shared", "decisions.json");
const MANIFEST_PATH = path.join(MEMORY_ROOT, "manifest.json");
const EVENTS_PATH = path.join(MEMORY_ROOT, "events.ndjson");
const LOCK_PATH = path.join(MEMORY_ROOT, "runtime", "writer.lock");
const HOST_ARCHIVE_ROOT = process.env.AGENT_MEMORY_ARCHIVE_ROOT || path.join(os.homedir(), "Library", "Application Support", "AEGISMemory", "archives", "aegis-ai-quant-governance-center");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWrite(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    await fs.mkdir(LOCK_PATH);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = await fs.stat(LOCK_PATH);
    if (Date.now() - stat.mtimeMs < 5 * 60_000) throw new Error("MEMORY_WRITER_ALREADY_ACTIVE");
    await fs.rm(LOCK_PATH, { recursive: true });
    await fs.mkdir(LOCK_PATH);
  }
  await fs.writeFile(path.join(LOCK_PATH, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
}

async function releaseLock() {
  await fs.rm(LOCK_PATH, { recursive: true, force: true });
}

async function withWriterLock(fn) {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

async function loadRegistry() {
  const registry = await readJson(REGISTRY_PATH);
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.agents)) {
    throw new Error("MEMORY_REGISTRY_INVALID");
  }
  const ids = registry.agents.map((agent) => agent.id);
  if (new Set(ids).size !== ids.length) throw new Error("MEMORY_REGISTRY_DUPLICATE_AGENT");
  return registry;
}

async function inspectSource(filePath) {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
  try {
    const [contents, stat] = await Promise.all([fs.readFile(resolvedPath), fs.stat(resolvedPath)]);
    return {
      path: resolvedPath,
      status: "OK",
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: sha256(contents),
    };
  } catch (error) {
    return { path: resolvedPath, status: "MISSING", error: error?.code || String(error) };
  }
}

function findByEnding(entries, ending) {
  return entries.find((entry) => entry.path.endsWith(ending))?.value ?? null;
}

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

function compactBook(book = {}, fallback = {}) {
  const openPositions = Array.isArray(book.openPositions) ? book.openPositions : [];
  return {
    equityUsdt: book.equityUsdt ?? fallback.equityUsdt ?? null,
    realizedPnlUsdt: book.realizedPnlUsdt ?? fallback.realizedPnlUsdt ?? null,
    openPositionCount: openPositions.length || fallback.openPositions || fallback.openPositionCount || 0,
    newEntriesBlocked: book.newEntriesBlocked ?? fallback.newEntriesBlocked ?? false,
    blockReason: book.blockReason ?? fallback.blockReason ?? null,
  };
}

function validateOrionV2({ authorization, paperRiskDirective, current, latest, state, daemon, runtimeConfig, strategyConfig, killSwitch }) {
  const errors = [];
  const warnings = [];
  const addMismatch = (code, values) => {
    if (unique(values).length > 1 || values.some((value) => value === null || value === undefined)) errors.push(code);
  };
  const strategyVersion = authorization.strategyVersion ?? strategyConfig.candidateVersion ?? null;
  const authorizationId = authorization.id ?? null;
  addMismatch("STRATEGY_VERSION_MISMATCH", [strategyVersion, strategyConfig.candidateVersion, runtimeConfig.strategyVersion, latest.strategyVersion, state.strategyVersion, current.activeResearchCandidate?.id]);
  addMismatch("AUTHORIZATION_ID_MISMATCH", [authorizationId, strategyConfig.authorization?.authorizationId, runtimeConfig.authorizationId, latest.authorizationId, state.authorizationId, current.activeResearchCandidate?.authorizationId]);
  addMismatch("PAPER_RISK_DIRECTIVE_ID_MISMATCH", [runtimeConfig.paperRiskDirectiveId, latest.paperRiskDirectiveId, state.paperRiskDirectiveId, current.paperRisk?.authorizationId]);

  const baseRisk = authorization.paperScope ?? {};
  const expectedRisk = paperRiskDirective.requestedRiskControls ?? {};
  const expectedMaximumOpenPositions = paperRiskDirective.preserves?.maximumOpenPositionsTotal ?? baseRisk.maximumOpenPositions;
  const runtimeRisk = runtimeConfig.paperRisk ?? {};
  const riskChecks = [
    ["RISK_ALLOCATION_MODE_MISMATCH", expectedRisk.allocationMode, runtimeRisk.riskAllocationMode],
    ["RISK_PER_INTERSECTION_MISMATCH", expectedRisk.maximumRiskPerIntersectionFraction, runtimeRisk.riskPerIntersectionFraction],
    ["PORTFOLIO_RISK_MISMATCH", expectedRisk.maximumPortfolioRiskFraction, runtimeRisk.maximumPortfolioRiskFraction],
    ["MAX_OPEN_POSITIONS_TOTAL_MISMATCH", expectedMaximumOpenPositions, runtimeRisk.maximumOpenPositionsTotal],
    ["MAX_LEVERAGE_MISMATCH", paperRiskDirective.preserves?.maximumLeverage, runtimeRisk.maximumLeverage],
  ];
  for (const [code, expected, actual] of riskChecks) if (expected === null || expected === undefined || actual !== expected) errors.push(code);
  if (current.paperRisk?.dailyRealizedLossStopEnabled !== false ||
      current.paperRisk?.dailyRealizedLossStopFraction !== null ||
      runtimeRisk.dailyRealizedLossStopEnabled !== false ||
      runtimeRisk.dailyRealizedLossStopFraction !== null) {
    errors.push("DAILY_REALIZED_LOSS_GATE_REMOVAL_MISMATCH");
  }
  if (current.paperRisk?.maximumDrawdownKillEnabled !== false ||
      current.paperRisk?.maximumDrawdownKillFraction !== null ||
      runtimeRisk.maximumDrawdownKillEnabled !== false ||
      runtimeRisk.maximumDrawdownKillFraction !== null) {
    errors.push("MAXIMUM_DRAWDOWN_GATE_REMOVAL_MISMATCH");
  }

  const realOrderFlags = [
    authorization.authorization?.realOrders,
    current.execution?.realOrdersAuthorized,
    runtimeConfig.execution?.realOrdersAllowed,
    latest.realOrdersAllowed,
    state.execution?.realOrdersAllowed,
  ];
  if (realOrderFlags.some((value) => value !== false)) errors.push("REAL_ORDER_PROHIBITION_MISMATCH");

  const requiredSymbols = baseRisk.mandatorySymbols ?? [];
  const configuredSymbols = runtimeConfig.venue?.universe?.mandatorySymbols ?? [];
  const expectedUniverse = baseRisk.universeSymbols ?? [];
  const configuredUniverse = runtimeConfig.venue?.universe?.symbols ?? [];
  const scannedSymbols = latest.symbols ?? state.symbols ?? [];
  if (requiredSymbols.some((symbol) => !configuredSymbols.includes(symbol) || !scannedSymbols.includes(symbol))) {
    errors.push("MANDATORY_SYMBOL_MISSING");
  }
  if (expectedUniverse.length !== 10 || JSON.stringify(expectedUniverse) !== JSON.stringify(configuredUniverse)) {
    errors.push("FIXED_UNIVERSE_CONFIGURATION_MISMATCH");
  }
  const heldSymbols = new Set(Object.values(state.books ?? {}).flatMap((book) => (book.openPositions ?? []).map((position) => position.symbol)));
  if (expectedUniverse.some((symbol) => !scannedSymbols.includes(symbol)) || scannedSymbols.some((symbol) => !expectedUniverse.includes(symbol) && !heldSymbols.has(symbol))) {
    errors.push("FIXED_UNIVERSE_RUNTIME_MISMATCH");
  }

  const totalOpenPositions = Object.values(state.books ?? {}).reduce(
    (sum, book) => sum + (Array.isArray(book.openPositions) ? book.openPositions.length : 0),
    0,
  );
  if (totalOpenPositions > Number(expectedMaximumOpenPositions)) errors.push("MAX_OPEN_POSITIONS_TOTAL_BREACH");

  const active = latest.lifecycle === "ACTIVE_PAPER_SIMULATION" || state.lifecycle === "ACTIVE_PAPER_SIMULATION";
  const daemonIsAlive = processAlive(daemon.pid);
  if (active && !daemonIsAlive) errors.push("DAEMON_NOT_ALIVE");
  if (active && killSwitch.engaged !== false) errors.push("KILL_SWITCH_NOT_CLEARED");

  const scanIntervalMs = Number(runtimeConfig.marketData?.scanIntervalMs) || 60_000;
  const lastSuccessfulScanMs = toEpochMs(latest.lastSuccessfulScanAt ?? state.lastSuccessfulScanAt);
  const runtimeFreshnessMaxMs = Math.max(scanIntervalMs * 3, 5 * 60_000);
  const scanAgeMs = lastSuccessfulScanMs === null ? null : Math.max(0, Date.now() - lastSuccessfulScanMs);
  if (active && (scanAgeMs === null || scanAgeMs > runtimeFreshnessMaxMs)) errors.push("RUNTIME_SCAN_STALE");
  if (active && latest.websocket?.connected !== true) warnings.push("WEBSOCKET_OFFLINE");
  if (active && latest.onlineLedger?.status !== "SYNCED") warnings.push("ONLINE_LEDGER_NOT_SYNCED");

  const nonFreshnessErrors = errors.filter((error) => error !== "RUNTIME_SCAN_STALE");
  return {
    status: nonFreshnessErrors.length ? "BLOCKED_SEMANTIC_MISMATCH" : errors.includes("RUNTIME_SCAN_STALE") ? "STALE_RUNTIME" : "READY",
    errors,
    warnings,
    runtimeFreshnessMaxMs,
    daemonIsAlive,
  };
}

function markedPositionNetPnl(position) {
  const values = [position?.direction, position?.lastMarkPrice, position?.entry, position?.remainingQuantity, position?.realizedNetPnl].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [direction, mark, entry, quantity, bookedNet] = values;
  return bookedNet + direction * (mark - entry) * quantity;
}

function compactPosition(position) {
  return {
    id: position?.id ?? null,
    symbol: position?.symbol ?? "UNKNOWN",
    side: position?.side ?? null,
    grade: position?.grade ?? null,
    strategyVersion: position?.strategyVersion ?? null,
    entry: position?.entry ?? null,
    mark: position?.lastMarkPrice ?? null,
    quantity: position?.remainingQuantity ?? null,
    stop: position?.currentStop ?? null,
    plannedRisk: position?.plannedRisk ?? null,
    markedNetPnl: markedPositionNetPnl(position),
  };
}

function summarizeUnknownJson(value) {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (!value || typeof value !== "object") return { type: typeof value, value };
  const summary = { type: "object", keys: Object.keys(value).slice(0, 30) };
  for (const key of ["status", "lifecycle", "updatedAt", "generatedAt", "asOf", "observedAt", "count"]) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  for (const key of ["items", "events", "alerts", "watchlist", "incidents", "positions", "orders"]) {
    if (Array.isArray(value[key])) summary[`${key}Count`] = value[key].length;
  }
  return summary;
}

async function readStateSources(agent) {
  const entries = [];
  for (const filePath of agent.stateSources ?? []) {
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(ROOT, filePath);
    const value = await readJson(resolvedPath, null);
    entries.push({ path: resolvedPath, value });
  }
  return entries;
}

function buildCurrentState(agent, stateEntries) {
  if (agent.id === "orion-v2") {
    const killSwitch = findByEnding(stateEntries, "/kill-switch.json") ?? {};
    const strategyConfig = findByEnding(stateEntries, "/experiments/v2-mtf-trendline-intersection/config.json") ?? {};
    const runtimeConfig = findByEnding(stateEntries, "/agents/orion-v2/paper/config.json") ?? {};
    const current = findByEnding(stateEntries, "/governance/current-state.json") ?? {};
    const latest = findByEnding(stateEntries, "/.runtime/orion-v2-mtfx/latest.json") ?? {};
    const state = findByEnding(stateEntries, "/.runtime/orion-v2-mtfx/state.json") ?? {};
    const daemon = findByEnding(stateEntries, "/.runtime/orion-v2-mtfx/daemon.pid.json") ?? {};
    const authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-06-mtfx-price-time-structure-0.5.0.json") ?? {};
    const paperRiskDirective = findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-11-v2-risk-2pct-10pct.json") ?? {};
    const positions = Object.values(state.books ?? {}).flatMap((book) => (book.openPositions ?? []).map(compactPosition));
    const killSwitchEngaged = killSwitch.engaged === true;
    const books = Object.fromEntries(Object.entries(state.books ?? latest.books ?? {}).map(([name, book]) => [
      name,
      compactBook(book, latest.books?.[name]),
    ]));
    const semanticValidation = validateOrionV2({ authorization, paperRiskDirective, current, latest, state, daemon, runtimeConfig, strategyConfig, killSwitch });
    return {
      sourceOfTruth: "OWNER_AUTHORIZED_MTFX_PAPER_RUNTIME",
      strategyVersion: authorization.strategyVersion ?? strategyConfig.candidateVersion ?? current.activeResearchCandidate?.id ?? null,
      lifecycle: latest.lifecycle ?? state.lifecycle ?? agent.lifecycle,
      authority: agent.authority,
      control: {
        ownerPaused: false,
        killSwitchEngaged,
        reason: killSwitch.reason ?? null,
        changedAt: killSwitch.changedAt ?? null,
        automaticRestartAllowed: authorization.authorization?.automaticRestart === true && runtimeConfig.execution?.automaticRestartAllowed === true,
      },
      authorizationId: authorization.id ?? current.activeResearchCandidate?.authorizationId ?? null,
      marketAsOf: latest.lastSuccessfulScanAt ?? null,
      daemonPid: daemon.pid ?? null,
      daemonAlive: semanticValidation.daemonIsAlive,
      riskPolicy: {
        status: "OWNER_AUTHORIZED_PAPER_ONLY",
        paperRiskDirectiveId: current.paperRisk?.authorizationId ?? runtimeConfig.paperRiskDirectiveId ?? null,
        riskAllocationMode: paperRiskDirective.requestedRiskControls?.allocationMode ?? null,
        riskPerIntersectionFraction: paperRiskDirective.requestedRiskControls?.maximumRiskPerIntersectionFraction ?? null,
        maximumPortfolioRiskFraction: paperRiskDirective.requestedRiskControls?.maximumPortfolioRiskFraction ?? null,
        maximumOpenPositionsTotal: paperRiskDirective.preserves?.maximumOpenPositionsTotal ?? authorization.paperScope?.maximumOpenPositions ?? null,
        maximumLeverage: paperRiskDirective.preserves?.maximumLeverage ?? authorization.paperScope?.maximumLeverage ?? null,
        paperOrdersAllowed: current.execution?.paperOrdersAuthorized ?? false,
        realOrdersAllowed: false,
        dailyStopEnabled: current.paperRisk?.dailyRealizedLossStopEnabled === true,
        dailyStopFraction: current.paperRisk?.dailyRealizedLossStopFraction ?? null,
        maximumDrawdownKillEnabled: current.paperRisk?.maximumDrawdownKillEnabled === true,
        maximumDrawdownKillFraction: current.paperRisk?.maximumDrawdownKillFraction ?? null,
        mandatorySymbols: authorization.paperScope?.mandatorySymbols ?? [],
      },
      account: {
        books,
      },
      positions,
      openPositionCount: positions.length,
      maximumOpenPositionsScope: "ALL_BOOKS_COMBINED",
      pendingOrderCount: state.pendingOrders?.length ?? 0,
      planCount: Array.isArray(latest.plans) ? latest.plans.length : Object.keys(state.plans ?? {}).length,
      dataQuality: {
        websocket: latest.websocket ?? null,
        onlineLedger: latest.onlineLedger ?? state.onlineLedger ?? null,
        scanErrors: state.scanErrors ?? [],
      },
      semanticValidation,
      quarantineReasons: killSwitchEngaged ? [killSwitch.reason ?? "KILL_SWITCH"] : [],
    };
  }

  if (agent.id === "orion-v3") {
    const current = findByEnding(stateEntries, "/governance/current-state.json") ?? {};
    const v3 = findByEnding(stateEntries, "/agents/orion-v3/binance-demo/config.json") ?? {};
    const v2Runtime = findByEnding(stateEntries, "/agents/orion-v2/paper/config.json") ?? {};
    const v2Strategy = findByEnding(stateEntries, "/experiments/v2-mtf-trendline-intersection/config.json") ?? {};
    const v3Strategy = findByEnding(stateEntries, "/experiments/v3-mtf-high-frequency/config.json") ?? {};
    const testnetGate = findByEnding(stateEntries, "/experiments/v2-execution-reality/testnet-gate.json") ?? {};
    const authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-18-orion-v3-binance-usdm-demo-immediate-trading-cutover.json") ?? {};
    const distribution = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-18-v2-v3-central-strategy-distribution.json") ?? {};
    const accountPolicy = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-18-orion-v3-account-capital-5000.json") ?? {};
    const parityHfAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-19-orion-v3-hf5-intersection-range-guards.json") ?? {};
    const priorHfAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-20-orion-v3-hf7-near-term-ranked-execution.json") ?? {};
    const hf8Authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-21-orion-v3-hf8-hf3-confirmation-light-chase-guard.json") ?? {};
    const hf9Authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-26-orion-v3-hf9-independent-lineage-reentry-attribution.json") ?? {};
    const hf10Authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-26-orion-v3-hf10-two-close-persistence-confirmation.json") ?? {};
    const hf11Authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-26-orion-v3-hf11-true-4h-market-state-gate.json") ?? {};
    const hf13Authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-14-orion-v3-hf13-dual-z.json") ?? {};
    const hfAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-14-orion-v3-hf14-single-z.json") ?? {};
    const scanAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-20-orion-v3-v4-tiered-scan-universe30.json") ?? {};
    const automaticAuthorization = hfAuthorization;
    const v3Latest = findByEnding(stateEntries, "/.runtime/orion-v3-binance-demo/latest.json") ?? {};
    const scannerPid = findByEnding(stateEntries, "/.runtime/orion-v3-binance-demo/scanner.pid.json") ?? {};
    const errors = [];
    const warnings = [];
    if (v3.lifecycle !== "ACTIVE_OWNER_AUTHORIZED_AUTOMATED_TESTNET_TRADING" ||
        v3.authorizationId !== authorization.id ||
        current.orionV3BinanceUsdmDemo?.authorizationId !== authorization.id ||
        current.orionV3BinanceUsdmDemo?.status !== "ACTIVE_OWNER_AUTHORIZED_AUTOMATED_TESTNET_TRADING") errors.push("V3_LIFECYCLE_OR_AUTHORIZATION_MISMATCH");
    if (v3.strategyParity?.mode !== "OWNER_AUTHORIZED_V3_HIGH_FREQUENCY_DERIVATIVE" ||
        v3.strategyParity?.expectedStrategyVersion !== v3Strategy.candidateVersion ||
        v3.strategyParity?.expectedImplementationRevision !== v3Strategy.implementationRevision ||
        v2Strategy.candidateVersion !== v2Runtime.strategyVersion ||
        current.activeResearchCandidate?.id !== v2Runtime.strategyVersion ||
        current.activeResearchCandidate?.implementationRevision !== v2Runtime.implementationRevision ||
        v3.strategyParity?.unversionedLocalOverridesAllowed !== false ||
        hfAuthorization.status !== "ACTIVE" ||
        hfAuthorization.release?.strategyFamily !== v3Strategy.candidateVersion ||
        hfAuthorization.release?.implementationRevision !== v3Strategy.implementationRevision ||
        hfAuthorization.strategy?.fourHourMarketStateGateRetained !== false ||
        hfAuthorization.strategy?.marketStateObservationOnly !== true ||
        hfAuthorization.strategy?.fourHourRequestInExecutionScan !== false ||
        hfAuthorization.strategy?.primaryStructureInterval !== "1h" ||
        hfAuthorization.strategy?.opposingStructureInterval !== "15m" ||
        hfAuthorization.strategy?.entryDecisionInterval !== "15m" ||
        hfAuthorization.strategy?.maximumDirectionDecisionBars !== 2 ||
        hfAuthorization.strategy?.maximumReserveBars !== 4 ||
        v3Strategy.timeframes?.marketState !== "4h" ||
        v3Strategy.timeframes?.primaryStructure !== "1h" ||
        v3Strategy.timeframes?.opposingStructure !== "15m" ||
        v3Strategy.timeframes?.entryDecision !== "15m" ||
        v3Strategy.marketStateGate?.enabled !== false ||
        v3Strategy.marketStateGate?.executionGate !== false ||
        v3Strategy.marketStateGate?.observationOnly !== true ||
        v3Strategy.marketStateGate?.requestInExecutionScan !== false ||
        v3Strategy.marketStateGate?.source !== "BINANCE_USDM_DEMO_FULLY_CLOSED_OHLC" ||
        v3Strategy.marketStateGate?.pivotPolicy?.leftBars !== 2 ||
        v3Strategy.marketStateGate?.pivotPolicy?.rightBars !== 2 ||
        JSON.stringify(v3Strategy.marketStateGate?.pivotPolicy?.hierarchyWindowMultipliers) !== JSON.stringify([1]) ||
        v3Strategy.marketStateGate?.unfinishedBarsAllowed !== false ||
        v3Strategy.marketStateGate?.historicalSignalBackfillAllowed !== false ||
        v3Strategy.marketStateGate?.symbolSpecificOverridesAllowed !== false ||
        v3Strategy.timeframes?.runnerTrail !== "15m" ||
        v3Strategy.exit?.runner?.interval !== "15m" ||
        v3Strategy.signal?.maximumEntryDisplacementBps !== 75 ||
        v3Strategy.signal?.maximumEntrySignalAgeMs !== 300000 ||
        v3Strategy.signal?.interval !== "15m" ||
        v3Strategy.signal?.maximumDirectionDecisionBars !== 2 ||
        v3Strategy.signal?.maximumReserveBars !== 4 ||
        v3Strategy.signal?.entryDisplacementReference !== "LATEST_EXECUTABLE_BBO_VERSUS_CONFIRMED_15M_DECISION_CLOSE" ||
        v3Strategy.pivots?.primary?.minimumRealtimeHierarchyMultiplier !== 4 ||
        v3Strategy.pivots?.opposing?.minimumRealtimeHierarchyMultiplier !== 2 ||
        v3Strategy.intersection?.maximumPrimaryProjectionSpanMultiples !== 2 ||
        v3Strategy.intersection?.maximumOpposingProjectionSpanMultiples !== 2 ||
        v3Strategy.intersection?.maximumDiscoveryPriceDistanceBps !== 750 ||
        v3Strategy.intersection?.maximumFormalCandidateDiscoveryDistanceBps !== 200 ||
        v3Strategy.intersection?.observationCandidatePromotionRequiresFreshExecutionBbo !== true ||
        v3Strategy.intersection?.minimumAutomaticExecutionConsensusSupport !== 1 ||
        v3Strategy.intersection?.conditionalSingleHypothesisExecution?.enabled !== false ||
        v3Strategy.reentryLineageGate?.enabled !== true ||
        !Number.isFinite(Date.parse(v3Strategy.reentryLineageGate?.enforcedFrom ?? "")) ||
        v3Strategy.reentryLineageGate?.requiredChange !== "BOTH_PRIMARY_1H_AND_OPPOSING_15M_CONFIRMED_ANCHOR_PAIRS" ||
        v3Strategy.reentryLineageGate?.missingEvidenceAction !== "FAIL_CLOSED" ||
        v3Strategy.dualZ?.bothRequired !== false ||
        v3Strategy.dualZ?.primaryRequired !== true ||
        v3Strategy.dualZ?.opposingComparisonOnly !== true ||
        v3Strategy.risk?.maximumLeverage !== 10) errors.push("V3_HIGH_FREQUENCY_STRATEGY_MISMATCH");
    const requiredFalseValues = [
      v3.isolation?.v2RuntimeMutationAllowed,
      v3.isolation?.v2LedgerMutationAllowed,
      v3.isolation?.sharedPositionsAllowed,
      v3.isolation?.sharedOrdersAllowed,
      current.execution?.realOrdersAuthorized,
      current.orionV3BinanceUsdmDemo?.realOrdersAllowed,
      current.orionV3BinanceUsdmDemo?.productionEndpointsAllowed,
    ];
    const requiredTrueValues = [
      v3.venue?.networkEnabled,
      v3.venue?.credentialAccessAllowed,
      v3.venue?.signedRequestsAllowed,
      v3.orderModule?.orderSubmissionAllowed,
      v3.orderModule?.orderCancellationAllowed,
      current.execution?.testnetOrderActivationAllowed,
      current.orionV3BinanceUsdmDemo?.testnetOrdersAllowed,
      testnetGate.implementation?.orderSubmissionImplemented,
      testnetGate.implementation?.orderCancellationImplemented,
    ];
    if (testnetGate.status !== "ACTIVE_OWNER_AUTHORIZED_BINANCE_DEMO_TRADING" ||
        requiredFalseValues.some((value) => value !== false) ||
        requiredTrueValues.some((value) => value !== true) ||
        v3.orderModule?.status !== "IMPLEMENTED_OWNER_AUTHORIZED_AUTOMATED" ||
        v3.venue?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
        v3.orderModule?.literalMutationConfirmation !== "BINANCE_DEMO_ONLY") errors.push("V3_ORDER_OR_CREDENTIAL_BOUNDARY_MISMATCH");
    const v3ScanAgeMs = toEpochMs(v3Latest.scannedAt) === null ? null : Math.max(0, Date.now() - toEpochMs(v3Latest.scannedAt));
    if (accountPolicy.id !== "OWNER-DIRECTIVE-ORION-V3-ACCOUNT-CAPITAL-5000-20260818" ||
        current.orionV3BinanceUsdmDemo?.accountAndPresentationAuthorizationId !== accountPolicy.id ||
        v3.account?.authorizationId !== accountPolicy.id ||
        v3.account?.strategyInitialCapitalUsdt !== 5000 ||
        v3.presentation?.contract !== "V3_CONTROL_POSITIONS_CANDIDATES_V1" ||
        v3.scanner?.automaticOrderSubmissionAllowed !== true ||
        v3.isolation?.startAllowed !== true ||
        v3.isolation?.startScope !== "ACCOUNT_SCAN_AND_V3_HF14_AUTOMATED_BINANCE_DEMO_EXECUTION" ||
        !["RUNNING", "DEGRADED_FAIL_CLOSED"].includes(scannerPid.status) ||
        !processAlive(scannerPid.pid) ||
        v3ScanAgeMs === null || v3ScanAgeMs > 180000 ||
        v3Latest.account?.equitySource !== "BINANCE_USDM_DEMO_SIGNED_ACCOUNT_ACTUAL" ||
        v3Latest.strategyVersion !== "ORION-V3-RESEARCH-MTFX-HF-0.5.0" ||
        v3Latest.implementationRevision !== "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE" ||
        scanAuthorization.status !== "ACTIVE" ||
        v3.scanUniverseAuthorizationId !== scanAuthorization.id ||
        current.orionV3BinanceUsdmDemo?.scanUniverseAuthorizationId !== scanAuthorization.id ||
        v3.universe?.symbols?.length !== 30 ||
        v3.scanner?.structuralDiscoveryIntervalMs !== 300000 ||
        v3.scanner?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
        v3Latest.system?.broadUniverseSize !== 30 ||
        v3Latest.system?.structuralDiscoveryIntervalMs !== 300000 ||
        v3Latest.system?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
        v3Latest.evaluationIsolation?.forwardCohortId !== "ORION-V3-HF14-SINGLE-Z-FORWARD-20260914" ||
        v3Latest.accounting?.outcomeAttribution?.historicalAccountFactsRewritten !== false ||
        v3Latest.risk?.maximumRiskPerEntryFraction !== current.orionV3BinanceUsdmDemo?.hardRisk?.maximumRiskPerEntryFraction ||
        v3Latest.risk?.maximumPortfolioRiskFraction !== current.orionV3BinanceUsdmDemo?.hardRisk?.maximumManagedPortfolioRiskFraction ||
        v3Latest.risk?.maximumOpenPositionsTotal !== 18 ||
        v3Latest.risk?.maximumLeverage !== 10 ||
        v3Latest.system?.automaticOrderSubmissionAllowed !== true) errors.push("V3_ACCOUNT_SCAN_OR_PRESENTATION_MISMATCH");
    if (distribution.id !== "OWNER-DIRECTIVE-V2-V3-CENTRAL-STRATEGY-DISTRIBUTION-20260818" ||
        distribution.status !== "SUPERSEDED_FOR_STRATEGY_PARITY_RETAINED_AS_HISTORICAL_ROUTING_EVIDENCE" ||
        distribution.supersededBy !== parityHfAuthorization.id ||
        parityHfAuthorization.status !== "SUPERSEDED" ||
        priorHfAuthorization.status !== "SUPERSEDED" ||
        priorHfAuthorization.supersededBy !== hf8Authorization.id ||
        hf8Authorization.status !== "SUPERSEDED" ||
        hf8Authorization.supersededBy !== hf9Authorization.id ||
        hf9Authorization.status !== "SUPERSEDED" ||
        hf9Authorization.supersededBy !== hf10Authorization.id ||
        hf10Authorization.status !== "SUPERSEDED" ||
        hf10Authorization.supersededBy !== hf11Authorization.id ||
        hf11Authorization.status !== "ACTIVE" ||
        !hf13Authorization.supersedes?.includes(hf11Authorization.id) ||
        hf13Authorization.status !== "ACTIVE" ||
        !hfAuthorization.supersedes?.includes(hf13Authorization.id) ||
        current.centralStrategyDistribution?.authorizationId !== distribution.id ||
        current.centralStrategyDistribution?.status !== "SUPERSEDED_FOR_STRATEGY_PARITY_RETAINED_AS_HISTORICAL_ROUTING_EVIDENCE" ||
        current.v3ExperimentalStrategyRouting?.authorizationId !== hfAuthorization.id ||
        current.v3ExperimentalStrategyRouting?.automaticOrderSubmissionAllowed !== true ||
        automaticAuthorization.status !== "ACTIVE" ||
        automaticAuthorization.authorizes?.residentAutomaticCandidateExecution !== true ||
        current.orionV3BinanceUsdmDemo?.automaticExecutionAuthorizationId !== automaticAuthorization.id ||
        v3.centralDistribution?.authorizationId !== hfAuthorization.id ||
        v3.centralDistribution?.releaseMode !== "CENTRALLY_GOVERNED_SEPARATE_V3_EXPERIMENT" ||
        v3.centralDistribution?.threadId !== agent.threadId) errors.push("V3_HIGH_FREQUENCY_ROUTING_MISMATCH");
    if (scannerPid.status === "DEGRADED_FAIL_CLOSED") warnings.push(`V3_RUNTIME_DEGRADED_FAIL_CLOSED_${scannerPid.lastError ?? "UNKNOWN"}`);
    const semanticValidation = { status: errors.length ? "BLOCKED_SEMANTIC_MISMATCH" : "READY", errors, warnings };
    return {
      sourceOfTruth: "ORION_V3_BINANCE_DEMO_CONFIG_PLUS_OWNER_AUTHORIZED_HIGH_FREQUENCY_STRATEGY",
      strategyVersion: v3Strategy.candidateVersion ?? null,
      implementationRevision: v3Strategy.implementationRevision ?? null,
      lifecycle: v3.lifecycle ?? agent.lifecycle,
      authority: agent.authority,
      authorizationId: authorization.id ?? null,
      venue: v3.venue?.name ?? null,
      orderModuleStatus: v3.orderModule?.status ?? null,
      activation: "OWNER_AUTHORIZED_AUTOMATED_BINANCE_DEMO_ONLY",
      centralDistribution: v3.centralDistribution ?? null,
      account: v3Latest.account ?? null,
      scanner: {
        pid: scannerPid.pid ?? null,
        alive: processAlive(scannerPid.pid),
        status: scannerPid.status ?? null,
        lastSuccessfulScanAt: scannerPid.lastSuccessfulScanAt ?? null,
        planCount: v3Latest.planCount ?? null,
        openPositionCount: v3Latest.risk?.openPositionCount ?? null,
      },
      strategyParity: {
        baseReference: v3Strategy.baseStrategy?.implementationRevision ?? null,
        sourceDefinition: v3.strategyParity?.strategyConfig ?? null,
        unversionedLocalOverridesAllowed: v3.strategyParity?.unversionedLocalOverridesAllowed ?? null,
      },
      semanticValidation,
      quarantineReasons: errors,
    };
  }

  if (agent.id === "orion-v3-shadow-kelly") {
    const current = findByEnding(stateEntries, "/governance/current-state.json") ?? {};
    const priorAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-18-orion-v3-shadow-kelly-reference.json") ?? {};
    const authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-20-orion-v3-shadow-kelly-automatic-version-sync.json") ?? {};
    const latest = findByEnding(stateEntries, "/.runtime/orion-v3-shadow-kelly/latest.json") ?? {};
    const errors = [];
    if (priorAuthorization.status !== "SUPERSEDED" || priorAuthorization.supersededBy !== authorization.id ||
        authorization.status !== "ACTIVE" || authorization.mode !== "OBSERVE_ONLY_POSITION_SIZING_REFERENCE" ||
        current.orionV3ShadowKelly?.authorizationId !== authorization.id || current.orionV3ShadowKelly?.status !== "ACTIVE_OBSERVE_ONLY_SEPARATE_THREAD") errors.push("V3_SHADOW_KELLY_AUTHORIZATION_MISMATCH");
    if (current.orionV3ShadowKelly?.threadId !== agent.threadId || authorization.conversation?.threadId !== agent.threadId ||
        current.orionV3ShadowKelly?.periodicBroadcastAllowed !== false || current.orionV3ShadowKelly?.v3TradingThreadBroadcastAllowed !== false) errors.push("V3_SHADOW_KELLY_CONTEXT_ISOLATION_MISMATCH");
    if (latest.executionUse !== "OBSERVE_ONLY" || latest.v3OrderSizingInputAllowed !== false ||
        current.orionV3ShadowKelly?.v3OrderSizingInputAllowed !== false || current.orionV3ShadowKelly?.v3RiskMutationAllowed !== false ||
        authorization.executionBoundary?.automaticPromotionAllowed !== false) errors.push("V3_SHADOW_KELLY_EXECUTION_BOUNDARY_MISMATCH");
    if (authorization.versionSyncPolicy?.mode !== "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE" ||
        authorization.versionSyncPolicy?.crossVersionPoolingAllowed !== false ||
        current.orionV3ShadowKelly?.automaticVersionSync !== true || current.orionV3ShadowKelly?.crossVersionPoolingAllowed !== false ||
        latest.versionSyncMode !== "AUTOMATIC_FROM_GOVERNANCE_CURRENT_STATE" ||
        latest.currentImplementationRevision !== current.orionV3BinanceUsdmDemo?.implementationRevision ||
        latest.sourceImplementationRevision !== latest.currentImplementationRevision ||
        latest.sample?.minimumEligible !== 100 || latest.sample?.minimumWinsAndLosses !== 20 ||
        latest.metrics?.maximumReferenceRiskFraction !== 0.005 || latest.causality?.crossVersionPoolingAllowed !== false ||
        latest.causality?.automaticReadOnlyVersionRecognition !== true ||
        !Array.isArray(latest.revisionBuckets) || !latest.revisionBuckets.some((bucket) => bucket.implementationRevision === latest.currentImplementationRevision) ||
        latest.revisionBuckets.some((bucket) => bucket.sample?.minimumEligible !== 100 || bucket.sample?.minimumWinsAndLosses !== 20)) errors.push("V3_SHADOW_KELLY_SAMPLE_POLICY_MISMATCH");
    const semanticValidation = { status: errors.length ? "BLOCKED_SEMANTIC_MISMATCH" : "READY", errors, warnings: [] };
    return {
      sourceOfTruth: "V3_CANONICAL_CLOSED_OUTCOMES_OBSERVE_ONLY",
      lifecycle: agent.lifecycle,
      authority: agent.authority,
      threadId: agent.threadId,
      sourceImplementationRevision: latest.sourceImplementationRevision ?? null,
      currentImplementationRevision: latest.currentImplementationRevision ?? null,
      versionSyncMode: latest.versionSyncMode ?? null,
      executionUse: latest.executionUse ?? null,
      sample: latest.sample ?? null,
      metrics: latest.metrics ?? null,
      revisionBuckets: latest.revisionBuckets ?? [],
      semanticValidation,
      quarantineReasons: errors,
    };
  }

  if (agent.id === "orion-v4") {
    const current = findByEnding(stateEntries, "/governance/current-state.json") ?? {};
    const authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-29-orion-v4-mtfx-r22-v2-full-rule-parity.json") ?? {};
    const parityEvidence = findByEnding(stateEntries, "/governance/evidence/orion-v4-mtfx-r22-v2-full-rule-parity-20260829.json") ?? {};
    const priorStrategyAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-22-orion-v4-mtfx-r21-alt-profit-retention.json") ?? {};
    const priorRiskAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-22-orion-v4-risk-2pct-10pct.json") ?? {};
    const priorParityAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-24-orion-v4-v2-execution-parity-except-demo-market-risk.json") ?? {};
    const governanceAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-08-20-orion-v4-governance-session-integration.json") ?? {};
    const strategy = findByEnding(stateEntries, "/experiments/v4-mtfx-r20/config.json") ?? {};
    const latest = findByEnding(stateEntries, "/.runtime/orion-v4-binance-demo/strategy-latest.json") ?? {};
    const scanner = findByEnding(stateEntries, "/.runtime/orion-v4-binance-demo/scanner.pid.json") ?? {};
    const governed = current.orionV4RangeResearch ?? {};
    const routing = current.agentGovernanceRouting ?? {};
    const errors = [];
    const ownerStopped = current.orionV4OwnerStop?.status === "STOPPED_BY_OWNER";
    if (ownerStopped) errors.push(...validateV4OwnerStop({ current,
      authorization: findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-09-orion-v4-stop.json"),
      scanner,
      supervisor: findByEnding(stateEntries, "/.runtime/orion-v4-binance-demo/supervisor.pid.json"),
      marker: findByEnding(stateEntries, "/.runtime/orion-v4-binance-demo/supervisor.stop.json"),
      processAlive,
    }));
    if (authorization.status !== "ACTIVE" || governed.authorizationId !== authorization.id) {
      errors.push("V4_AUTHORIZATION_MISMATCH");
    }
    if (authorization.riskPolicy?.authorizationId !== authorization.id || governed.riskPolicy?.authorizationId !== authorization.id || governed.riskPolicy?.revision !== authorization.riskPolicy?.revision) {
      errors.push("V4_RISK_AUTHORIZATION_MISMATCH");
    }
    if (authorization.implementationOutcome?.status !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
        governed.v2FullRuleParityDirective?.authorizationId !== authorization.id ||
        governed.v2FullRuleParityDirective?.status !== (ownerStopped ? "SUSPENDED_BY_OWNER" : "ACTIVE_VERIFIED_RUNNING_RECONCILED") ||
        parityEvidence.result !== "ACTIVE_VERIFIED_RUNNING_RECONCILED" ||
        parityEvidence.statePreservation?.liveExchangeFingerprintBefore !== parityEvidence.statePreservation?.liveExchangeFingerprintAfter) {
      errors.push("V4_EXECUTION_PARITY_AUTHORIZATION_MISMATCH");
    }
    if (priorStrategyAuthorization.status !== "SUPERSEDED" || priorRiskAuthorization.status !== "SUPERSEDED" || priorParityAuthorization.status !== "SUPERSEDED") errors.push("V4_SUPERSESSION_CHAIN_MISMATCH");
    if (governed.strategyVersion !== strategy.candidateVersion || governed.implementationRevision !== strategy.implementationRevision) {
      errors.push("V4_STRATEGY_REVISION_MISMATCH");
    }
    if (governed.threadId !== agent.threadId || governed.threadTitle !== current.ownerVisiblePresentationTerminology?.orionV4?.threadTitle ||
        governanceAuthorization.status !== "ACTIVE" || governed.governanceIntegration?.authorizationId !== governanceAuthorization.id ||
        current.ownerVisiblePresentationTerminology?.status !== "ACTIVE_ALL_CURRENT_ACCOUNT_SURFACES" ||
        routing.mainThreads?.orionV4 !== agent.threadId ||
        routing.mainThreads?.aegisPrime !== current.aegisPrimeConversation?.activeThreadId) {
      errors.push("V4_THREAD_ROUTING_MISMATCH");
    }
    if (governed.residentScannerAllowed !== !ownerStopped || governed.matchingEngineOrderSubmissionAllowed !== !ownerStopped ||
        governed.testnetOrdersAllowed !== !ownerStopped || governed.realOrdersAllowed !== false || governed.productionEndpointsAllowed !== false ||
        governed.v2OrV3RuntimeMutationAllowed !== false || governed.v2OrV3LedgerMutationAllowed !== false ||
        governed.sharedPositionsOrOrdersAllowed !== false || strategy.venue?.fixedBaseUrl !== "https://demo-fapi.binance.com" ||
        strategy.sourceStrategy?.runtimePositionOrderLedgerAccessAllowed !== false ||
        strategy.sourceStrategy?.runtimeMutationAllowed !== false ||
        strategy.risk?.maximumRiskPerEntryFraction !== 0.01 || strategy.risk?.maximumPortfolioRiskFraction !== 0.05 ||
        strategy.risk?.riskSizingUtilizationFraction !== 0.98 ||
        strategy.riskPolicy?.authorizationId !== authorization.id || strategy.riskPolicy?.revision !== authorization.riskPolicy?.revision ||
        strategy.risk?.maximumEffectiveNotionalLeverage !== 4) {
      errors.push("V4_EXECUTION_BOUNDARY_MISMATCH");
    }
    if (latest.strategyVersion !== strategy.candidateVersion || latest.implementationRevision !== strategy.implementationRevision ||
        strategy.universe?.symbols?.length !== 10 ||
        strategy.runtime?.scanIntervalMs !== 60000 ||
        latest.system?.broadUniverseSize !== 10 || latest.system?.structuralDiscoveryIntervalMs !== 60000 ||
        latest.system?.candidatePositionAndReconciliationIntervalMs !== 60000 ||
        latest.evaluationCohortId !== authorization.appliesTo?.targetForwardCohortId ||
        latest.riskPolicyAuthorizationId !== authorization.id || latest.riskPolicyRevision !== authorization.riskPolicy?.revision ||
        latest.risk?.maximumRiskPerEntryFraction !== 0.01 || latest.risk?.maximumPortfolioRiskFraction !== 0.05 ||
        latest.system?.sourceStrategyReadOnly !== true || latest.system?.sourceRuntimeAccessed !== false ||
        latest.system?.candidateLifecycleDurable !== true || latest.system?.causalBboRequired !== true ||
        (!ownerStopped && (scanner.status !== "RUNNING" || scanner.causalBboStatus !== "LIVE_STRICT_UPDATE_ID_DUAL_CLOCK" ||
        scanner.causalBboCoverageCount !== 10)) || latest.executionReconciliation?.status !== "RECONCILED") {
      errors.push("V4_RUNTIME_ALIGNMENT_MISMATCH");
    }
    const semanticValidation = { status: errors.length ? "BLOCKED_SEMANTIC_MISMATCH" : "READY", errors, warnings: [] };
    return {
      sourceOfTruth: "ORION_V4_MTFX_R22_V2_FULL_RULE_PARITY_AND_ISOLATED_DEMO_RUNTIME",
      lifecycle: agent.lifecycle,
      authority: agent.authority,
      threadId: agent.threadId,
      authorizationId: authorization.id ?? null,
      strategyVersion: strategy.candidateVersion ?? null,
      implementationRevision: strategy.implementationRevision ?? null,
      stage: governed.stage ?? strategy.lifecycle ?? null,
      activation: ownerStopped ? "STOPPED_BY_OWNER" : "OWNER_AUTHORIZED_AUTOMATED_BINANCE_DEMO_ONLY",
      ownerStop: ownerStopped ? current.orionV4OwnerStop : null,
      governanceIntegration: {
        status: governed.governanceIntegration?.status ?? null,
        authorizationId: governanceAuthorization.id ?? null,
        governor: routing.governor ?? null,
        owner: routing.owner ?? null,
        mailboxProtocol: routing.mailboxProtocol ?? null,
        responseObligations: routing.responseObligations ?? [],
        p0P1EscalationToAegisRequired: routing.p0P1EscalationToAegisRequired === true,
      },
      account: latest.account ?? null,
      positions: latest.positions ?? [],
      scanner: {
        pid: scanner.pid ?? null,
        status: scanner.status ?? null,
        lastSuccessfulScanAt: scanner.lastSuccessfulScanAt ?? null,
        planCount: scanner.planCount ?? null,
        economicPrequalifiedCount: scanner.economicPrequalifiedCount ?? null,
        eligibleRangeCount: scanner.eligibleRangeCount ?? null,
        openPositionCount: scanner.openPositionCount ?? null,
      },
      riskPolicy: {
        status: governed.paperRiskPolicy ?? "NOT_AUTHORIZED",
        authorizationId: authorization.id ?? null,
        revision: authorization.riskPolicy?.revision ?? null,
        maximumRiskPerEntryFraction: strategy.risk?.maximumRiskPerEntryFraction ?? null,
        maximumPortfolioRiskFraction: strategy.risk?.maximumPortfolioRiskFraction ?? null,
        riskSizingUtilizationFraction: strategy.risk?.riskSizingUtilizationFraction ?? null,
        forwardCohortId: strategy.evaluationIsolation?.forwardCohortId ?? null,
      },
      semanticValidation,
      quarantineReasons: errors,
    };
  }

  if (agent.id === "orion-v5") {
    const current = findByEnding(stateEntries, "/governance/current-state.json") ?? {};
    const authorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-04-orion-v5-au-futures-v2-r22-paper-initialization.json") ?? {};
    const evidence = findByEnding(stateEntries, "/governance/evidence/orion-v5-au-futures-initialization-20260904.json") ?? {};
    const residenceAuthorization = findByEnding(stateEntries, "/governance/owner-authorizations/2026-09-04-orion-v5-au-continuous-paper-residence-and-efficacy.json") ?? {};
    const residenceEvidence = findByEnding(stateEntries, "/governance/evidence/orion-v5-au-continuous-paper-residence-20260904.json") ?? {};
    const governed = current.orionV5AuFutures ?? {};
    const conversation = current.orionV5Conversation ?? {};
    const domain = current.executionDomains?.orionV5AuPaper ?? {};
    const errors = [];
    const warnings = [];
    if (authorization.id !== governed.authorizationId || authorization.id !== conversation.authorizationId || authorization.id !== domain.initializationAuthorizationId) {
      errors.push("V5_AUTHORIZATION_MISMATCH");
    }
    if (residenceAuthorization.id !== governed.continuousPaperResidence?.authorizationId || residenceAuthorization.id !== conversation.continuousPaperAuthorizationId || residenceAuthorization.id !== domain.authorizationId) {
      errors.push("V5_CONTINUOUS_PAPER_AUTHORIZATION_MISMATCH");
    }
    if (agent.threadId !== conversation.activeThreadId || agent.threadId !== governed.threadId || agent.threadId !== authorization.conversation?.threadId) {
      errors.push("V5_THREAD_ROUTING_MISMATCH");
    }
    if (authorization.scope?.product !== "GOLD_FUTURES_AU" || governed.venue?.exchange !== "SHFE" || governed.venue?.product !== "AU") {
      errors.push("V5_AU_SCOPE_MISMATCH");
    }
    if (authorization.scope?.initialPaperCapitalCny !== 500000 || governed.venue?.initialPaperCapitalCny !== 500000) {
      errors.push("V5_INITIAL_CAPITAL_MISMATCH");
    }
    if (governed.riskPolicy?.maximumRiskPerEntryFraction !== 0.01 || governed.riskPolicy?.maximumManagedPortfolioRiskFraction !== 0.05 || governed.riskPolicy?.maximumEffectiveNotionalLeverage !== 4 || governed.riskPolicy?.riskSizingUtilizationFraction !== 0.98) {
      errors.push("V5_RISK_POLICY_MISMATCH");
    }
    if (domain.ctpMdApiAllowed !== true || domain.ctpTraderApiAllowed !== false || domain.orderInsertOrActionAllowed !== false || domain.realOrdersAllowed !== false) {
      errors.push("V5_CTP_EXECUTION_BOUNDARY_MISMATCH");
    }
    if (residenceAuthorization.activation?.mode !== "AUTO_START_WHEN_ALL_GATES_PASS" || governed.continuousPaperResidence?.autoStartWhenAllGatesPass !== true || domain.automaticStartAfterAllGates !== true) {
      errors.push("V5_CONTINUOUS_PAPER_AUTOSTART_MISMATCH");
    }
    if (residenceAuthorization.efficacy?.automaticRealPromotionAllowed !== false || governed.efficacyEvaluation?.automaticRealPromotionAllowed !== false || domain.automaticRealPromotionAllowed !== false) {
      errors.push("V5_REAL_PROMOTION_BOUNDARY_MISMATCH");
    }
    if (governed.monitor?.route !== "/v5-au" || governed.monitor?.dedicatedRuntimeAndPayload !== true) {
      errors.push("V5_MONITOR_BOUNDARY_MISMATCH");
    }
    if (governed.dataSource?.credentialsProvisioned !== true) warnings.push("CTP_MARKET_DATA_CONFIGURATION_PENDING");
    if (governed.runtime?.residentProcessStarted !== true) warnings.push("V5_RUNTIME_NOT_STARTED");
    return {
      sourceOfTruth: "ORION_V5_AU_GOVERNANCE_AND_DEDICATED_PAPER_RUNTIME",
      strategyVersion: governed.strategyVersion ?? null,
      implementationRevision: governed.implementationRevision ?? null,
      lifecycle: governed.status ?? agent.lifecycle,
      authority: governed.authority ?? agent.authority,
      threadId: governed.threadId ?? agent.threadId,
      authorizationId: authorization.id ?? null,
      continuousPaperAuthorizationId: residenceAuthorization.id ?? null,
      stage: governed.stage ?? null,
      venue: governed.venue ?? null,
      riskPolicy: governed.riskPolicy ?? null,
      dataSource: governed.dataSource ?? null,
      monitor: governed.monitor ?? null,
      runtime: governed.runtime ?? null,
      continuousPaperResidence: governed.continuousPaperResidence ?? null,
      efficacyEvaluation: governed.efficacyEvaluation ?? null,
      initializationEvidenceStatus: evidence.status ?? null,
      continuousPaperEvidenceStatus: residenceEvidence.status ?? null,
      semanticValidation: {
        status: errors.length ? "BLOCKED_SEMANTIC_MISMATCH" : "READY",
        errors,
        warnings,
      },
      quarantineReasons: errors,
    };
  }

  if (agent.id === "nexus") {
    return {
      sourceOfTruth: "NEXUS_REGISTERED_STATE_FILES",
      lifecycle: agent.lifecycle,
      sources: stateEntries.map((entry) => ({ path: entry.path, summary: summarizeUnknownJson(entry.value) })),
    };
  }

  if (agent.id === "orion-v1") {
    const latest = stateEntries[0]?.value ?? {};
    return {
      sourceOfTruth: "OWNER_STOP_DECISION_PLUS_V1_ARCHIVE_METADATA",
      lifecycle: "STOPPED_BY_OWNER",
      authority: "READ_ONLY_ARCHIVE",
      automaticRestartAllowed: false,
      activePositionCount: 0,
      activePositions: [],
      archivedSnapshot: {
        classification: "PRE_STOP_HISTORICAL_ONLY",
        currentStateAuthority: false,
        capturedAt: latest?.capturedAt ?? latest?.asOf ?? null,
        historicalStatus: latest?.status ?? null,
        note: "历史快照不得解释为当前持仓；V1当前唯一有效状态为老板停止、只读归档、零受管活动仓位。",
      },
    };
  }

  return {
    sourceOfTruth: "AEGIS_GOVERNANCE_FILES",
    lifecycle: agent.lifecycle,
    cockpitDataSync: "PAUSED_FOR_RESTRUCTURE",
    memoryService: "ACTIVE",
  };
}

async function decisionsFor(agentId) {
  const document = await readJson(DECISIONS_PATH, { decisions: [] });
  return (document.decisions ?? []).filter((decision) =>
    Array.isArray(decision.audience) && (decision.audience.includes(agentId) || decision.audience.includes("all")),
  );
}

function activeItems(items) {
  return items.filter((item) => !["RESOLVED", "REVOKED", "CANCELLED"].includes(item.status) && !String(item.status).startsWith("SUPERSEDED"));
}

function isRevocationGuard(item) {
  return item?.status === "REVOKED" || String(item?.id ?? "").startsWith("REVOKE-");
}

async function enforceHotCheckpointRetention(registry) {
  const retention = registry.retention ?? {};
  if (retention.archiveInsteadOfDelete !== true) return { archivedCheckpointCount: 0 };
  const hotDays = Math.max(1, Number(retention.hotCheckpointDays) || 30);
  const minimumHot = Math.max(1, Number(retention.minimumHotCheckpointsPerAgent) || 32);
  const cutoffMs = Date.now() - hotDays * 86_400_000;
  let archivedCheckpointCount = 0;
  for (const agent of registry.agents) {
    const relativeDirectory = path.join("agents", agent.id, "checkpoints");
    const sourceDirectory = path.join(MEMORY_ROOT, relativeDirectory);
    let filenames = [];
    try {
      filenames = (await fs.readdir(sourceDirectory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const candidates = filenames.slice(0, Math.max(0, filenames.length - minimumHot));
    for (const filename of candidates) {
      const sourcePath = path.join(sourceDirectory, filename);
      const stat = await fs.stat(sourcePath);
      if (stat.mtimeMs >= cutoffMs) continue;
      const archivePath = path.join(HOST_ARCHIVE_ROOT, "memory", relativeDirectory, filename);
      const [sourceBytes, archiveBytes] = await Promise.all([fs.readFile(sourcePath), fs.readFile(archivePath)]);
      if (sha256(sourceBytes) !== sha256(archiveBytes)) throw new Error(`ARCHIVE_CHECKPOINT_MISMATCH_${agent.id}_${filename}`);
      await fs.rm(sourcePath);
      archivedCheckpointCount += 1;
    }
  }
  return { archivedCheckpointCount, hotDays, minimumHot };
}

async function archiveToHost() {
  const integrity = await verify();
  if (integrity.status !== "PASS") {
    return { status: "SKIPPED_UNVERIFIED", archiveRoot: HOST_ARCHIVE_ROOT, integrity };
  }
  const registry = await loadRegistry();
  const manifest = await readJson(MANIFEST_PATH, null);
  const archiveHash = sha256(stableStringify({
    workspace: ROOT,
    manifest,
    eventHead: integrity.eventChain.head,
  }));
  const receiptPath = path.join(HOST_ARCHIVE_ROOT, "receipt.json");
  const previousReceipt = await readJson(receiptPath, null);
  if (previousReceipt?.archiveHash === archiveHash) {
    const retention = await enforceHotCheckpointRetention(registry);
    return { status: "UNCHANGED", archiveRoot: HOST_ARCHIVE_ROOT, archiveHash, retention };
  }
  await fs.mkdir(HOST_ARCHIVE_ROOT, { recursive: true });
  await fs.cp(MEMORY_ROOT, path.join(HOST_ARCHIVE_ROOT, "memory"), {
    recursive: true,
    force: true,
    filter: (source) => !source.includes(`${path.sep}runtime${path.sep}`) && !source.endsWith(`${path.sep}runtime`),
  });
  const receipt = {
    schemaVersion: 1,
    role: "COLD_ARCHIVE_NOT_RUNTIME_AUTHORITY",
    sourceWorkspace: ROOT,
    sourceMemoryRoot: MEMORY_ROOT,
    archivedAt: new Date().toISOString(),
    archiveHash,
    eventHead: integrity.eventChain.head,
    recoveryRule: "RESTORE_TO_PROJECT_AND_REVALIDATE_LIVE_SOURCES_BEFORE_USE",
  };
  await atomicWriteJson(receiptPath, receipt);
  const retention = await enforceHotCheckpointRetention(registry);
  return { status: "ARCHIVED", archiveRoot: HOST_ARCHIVE_ROOT, archiveHash, receipt, retention };
}

async function checkpointContent(agent) {
  const sourcePaths = [...(agent.identitySources ?? []), ...(agent.stateSources ?? [])];
  const sourceIntegrity = await Promise.all(sourcePaths.map(inspectSource));
  const identitySourcePaths = new Set((agent.identitySources ?? []).map((source) => path.isAbsolute(source) ? source : path.resolve(ROOT, source)));
  const stateSourcePaths = new Set((agent.stateSources ?? []).map((source) => path.isAbsolute(source) ? source : path.resolve(ROOT, source)));
  const identityMissing = sourceIntegrity
    .filter((source) => identitySourcePaths.has(source.path) && source.status !== "OK")
    .map((source) => source.path);
  const stateMissing = sourceIntegrity
    .filter((source) => stateSourcePaths.has(source.path) && source.status !== "OK")
    .map((source) => source.path);
  const stateEntries = await readStateSources(agent);
  const directivesDocument = await readJson(path.join(MEMORY_ROOT, "agents", agent.id, "directives.json"), { directives: [] });
  const cursor = await readJson(path.join(MEMORY_ROOT, "agents", agent.id, "message-cursor.json"), {
    lastProcessedMessageId: null,
    updatedAt: null,
  });
  const currentState = buildCurrentState(agent, stateEntries);
  let recoveryStatus = "READY";
  if (identityMissing.length) recoveryStatus = "BLOCKED_IDENTITY_SOURCE_MISSING";
  else if (stateMissing.length) recoveryStatus = "BLOCKED_STATE_SOURCE_MISSING";
  else if (currentState.semanticValidation?.status && currentState.semanticValidation.status !== "READY") {
    recoveryStatus = currentState.semanticValidation.status;
  }
  return {
    profile: {
      id: agent.id,
      displayName: agent.displayName,
      role: agent.role,
      threadId: agent.threadId,
      declaredLifecycle: agent.lifecycle,
      authority: agent.authority,
      owner: "Operator",
      governor: "AEGIS PRIME",
    },
    currentState,
    decisions: await decisionsFor(agent.id),
    directives: directivesDocument.directives ?? [],
    messageCursor: cursor,
    sourceIntegrity,
    recoveryGate: {
      status: recoveryStatus,
      identityMissing,
      stateMissing,
      semanticErrors: currentState.semanticValidation?.errors ?? [],
      semanticWarnings: currentState.semanticValidation?.warnings ?? [],
      precedence: [
        "RUNTIME_AND_IMMUTABLE_LEDGER",
        "LATEST_NON_REVOKED_OWNER_DECISION",
        "ACTIVE_CONFIG_AND_HASH",
        "VERSIONED_CHARTER",
        "MEMORY_CHECKPOINT",
        "CHAT_SUMMARY",
      ],
    },
  };
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function prioritizeStartupItems(items) {
  const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...items].sort((first, second) => {
    const priorityDelta = (priorityRank[first.priority] ?? 9) - (priorityRank[second.priority] ?? 9);
    if (priorityDelta !== 0) return priorityDelta;
    return String(second.updatedAt ?? "").localeCompare(String(first.updatedAt ?? ""));
  });
}

function compactCurrentStateForStartup(currentState = {}) {
  const positions = Array.isArray(currentState.positions) ? currentState.positions : [];
  return {
    sourceOfTruth: currentState.sourceOfTruth,
    strategyVersion: currentState.strategyVersion,
    lifecycle: currentState.lifecycle,
    authority: currentState.authority,
    riskPolicy: currentState.riskPolicy,
    implementationRevision: currentState.implementationRevision,
    venue: currentState.venue,
    orderModuleStatus: currentState.orderModuleStatus,
    activation: currentState.activation,
    strategyParity: currentState.strategyParity,
    control: currentState.control,
    authorizationId: currentState.authorizationId,
    marketAsOf: currentState.marketAsOf,
    daemonPid: currentState.daemonPid,
    daemonAlive: currentState.daemonAlive,
    account: currentState.account,
    maximumOpenPositionsScope: currentState.maximumOpenPositionsScope,
    semanticValidation: currentState.semanticValidation,
    positions: positions.map((position) => ({
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entry: position.entry,
      mark: position.mark,
      stop: position.stop,
      plannedRisk: position.plannedRisk,
      markedNetPnl: position.markedNetPnl,
    })),
  };
}

function startupPack(snapshot, maxChars) {
  const { content } = snapshot;
  const revokedDecisions = content.decisions.filter(isRevocationGuard);
  const activeDecisions = prioritizeStartupItems(activeItems(content.decisions).filter((item) => !isRevocationGuard(item)));
  const activeDirectives = prioritizeStartupItems(activeItems(content.directives));
  const sources = content.sourceIntegrity.map((source) =>
    `- ${source.status === "OK" ? "OK" : "MISSING"} · ${source.path} · ${source.sha256?.slice(0, 12) ?? "—"}`,
  );
  let text = `# ${content.profile.displayName} · STARTUP MEMORY\n\n`;
  text += `- 生成时间：${snapshot.capturedAt}\n- 内容哈希：${snapshot.contentHash}\n- 身份：${content.profile.displayName}｜${content.profile.role}\n- 所有者：老板（Operator）\n- 权限：${content.profile.authority}\n- 恢复闸门：${content.recoveryGate.status}\n\n`;
  text += "## 必读规则\n\n先以运行状态、老板最新未撤销授权和当前配置为准。不得用会话摘要覆盖持仓、订单、风险或权限。发现冲突时停止扩大行动并上报 AEGIS。\n\n";
  if (content.currentState?.riskPolicy) {
    const risk = content.currentState.riskPolicy;
    text += `## 当前硬边界\n\n- authorizationId=${content.currentState.authorizationId ?? "—"}; strategyVersion=${content.currentState.strategyVersion ?? "—"}; paperOrdersAllowed=${risk.paperOrdersAllowed}; realOrdersAllowed=${risk.realOrdersAllowed}; riskPerIntersectionFraction=${risk.riskPerIntersectionFraction}; maximumPortfolioRiskFraction=${risk.maximumPortfolioRiskFraction}; maximumOpenPositionsTotal=${risk.maximumOpenPositionsTotal}; maximumLeverage=${risk.maximumLeverage}\n\n`;
  }
  text += "## 当前指令（按优先级）\n\n";
  text += activeDirectives.length ? activeDirectives.map((item) => `- ${item.id}｜${item.priority}｜${item.summary}`).join("\n") : "- 无";
  text += "\n\n## 已撤销决策警戒\n\n";
  text += revokedDecisions.length ? revokedDecisions.map((item) => `- ${item.id}｜${item.summary ?? item.decision}`).join("\n") : "- 无";
  text += `\n\n## 当前权威状态（精简；操作前必须重读实时文件）\n\n${jsonBlock(compactCurrentStateForStartup(content.currentState))}\n\n`;
  text += "## 有效决策\n\n";
  text += activeDecisions.length ? activeDecisions.map((item) => `- ${item.id}｜${item.summary ?? item.decision}`).join("\n") : "- 无";
  text += `\n\n## 消息游标\n\n- 最后处理消息：${content.messageCursor.lastProcessedMessageId ?? "未登记"}\n`;
  text += `\n## 来源完整性\n\n${sources.join("\n")}\n`;
  text += "\n## 写回义务\n\n身份、授权、风险、策略版本、持仓/订单生命周期、P0/P1任务和撤销事项发生变化时，必须立即形成检查点；普通无变化心跳不写入长期记忆。\n";
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 96))}\n\n[启动包已按Token预算截断；完整状态见 latest.json]\n`;
  }
  return text;
}

async function appendEvent(payload) {
  let previousHash = "GENESIS";
  let index = 0;
  try {
    const raw = await fs.readFile(EVENTS_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines.at(-1));
      previousHash = last.eventHash;
      index = Number(last.index) + 1;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const event = { index, at: new Date().toISOString(), ...payload, previousHash };
  event.eventHash = sha256(`${previousHash}\n${stableStringify(event)}`);
  await fs.appendFile(EVENTS_PATH, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

async function checkpointAgent(agent, registry) {
  const capturedAt = new Date().toISOString();
  const content = await checkpointContent(agent);
  const contentHash = sha256(stableStringify(content));
  const agentRoot = path.join(MEMORY_ROOT, "agents", agent.id);
  const latestPath = path.join(agentRoot, "latest.json");
  const previous = await readJson(latestPath, null);
  const changed = previous?.contentHash !== contentHash;
  const snapshot = { schemaVersion: 1, agentId: agent.id, capturedAt, contentHash, content };

  if (changed) {
    const stamp = capturedAt.replaceAll(":", "-").replaceAll(".", "-");
    await atomicWriteJson(path.join(agentRoot, "checkpoints", `${stamp}-${contentHash.slice(0, 12)}.json`), snapshot);
    await atomicWriteJson(latestPath, snapshot);
    await atomicWrite(path.join(agentRoot, "STARTUP.md"), startupPack(snapshot, registry.startupPackMaxChars ?? 6000));
    await appendEvent({ type: "AGENT_MEMORY_CHECKPOINT", agentId: agent.id, contentHash });
  }

  return {
    agentId: agent.id,
    changed,
    contentHash,
    capturedAt: changed ? capturedAt : previous?.capturedAt,
    checkedAt: capturedAt,
    recoveryGate: content.recoveryGate.status,
  };
}

async function updateManifest(results, registry) {
  const previous = await readJson(MANIFEST_PATH, { schemaVersion: 1, agents: {} });
  const agents = { ...(previous.agents ?? {}) };
  for (const result of results) agents[result.agentId] = result;
  const allResults = registry.agents.map((agent) => agents[agent.id]).filter(Boolean);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    checkpointIntervalMinutes: registry.checkpointIntervalMinutes,
    health: allResults.length === registry.agents.length && allResults.every((result) => result.recoveryGate === "READY") ? "HEALTHY" : "DEGRADED",
    agents,
  };
  await atomicWriteJson(MANIFEST_PATH, manifest);
  return manifest;
}

async function checkpoint(target) {
  return withWriterLock(async () => {
    const registry = await loadRegistry();
    const agents = target === "all" ? registry.agents : registry.agents.filter((agent) => agent.id === target);
    if (!agents.length) throw new Error(`UNKNOWN_AGENT_${target}`);
    const results = [];
    for (const agent of agents) results.push(await checkpointAgent(agent, registry));
    const manifest = await updateManifest(results, registry);
    return { status: manifest.health === "HEALTHY" ? "PASS" : "DEGRADED", results };
  });
}

async function verifyEventChain() {
  let raw;
  try {
    raw = await fs.readFile(EVENTS_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { valid: false, events: 0, error: "EVENT_LEDGER_MISSING" };
    throw error;
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  let expectedPrevious = "GENESIS";
  for (let index = 0; index < lines.length; index += 1) {
    const event = JSON.parse(lines[index]);
    const storedHash = event.eventHash;
    const payload = { ...event };
    delete payload.eventHash;
    const calculated = sha256(`${expectedPrevious}\n${stableStringify(payload)}`);
    if (event.index !== index || event.previousHash !== expectedPrevious || storedHash !== calculated) {
      return { valid: false, events: lines.length, error: `EVENT_CHAIN_BREAK_${index}` };
    }
    expectedPrevious = storedHash;
  }
  return { valid: true, events: lines.length, head: expectedPrevious };
}

async function verify() {
  const registry = await loadRegistry();
  const manifest = await readJson(MANIFEST_PATH, null);
  const checks = [];
  for (const agent of registry.agents) {
    const latest = await readJson(path.join(MEMORY_ROOT, "agents", agent.id, "latest.json"), null);
    const startupExists = await fs.access(path.join(MEMORY_ROOT, "agents", agent.id, "STARTUP.md")).then(() => true).catch(() => false);
    const calculated = latest ? sha256(stableStringify(latest.content)) : null;
    const storedIntegrityValid = Boolean(latest && startupExists && latest.contentHash === calculated && manifest?.agents?.[agent.id]?.contentHash === latest.contentHash);
    const live = await checkpointContent(agent);
    const liveRecoveryGate = live.recoveryGate.status;
    const valid = storedIntegrityValid && liveRecoveryGate === "READY";
    checks.push({ agentId: agent.id, valid, storedIntegrityValid, liveRecoveryGate, startupExists, contentHash: latest?.contentHash ?? null });
  }
  const eventChain = await verifyEventChain();
  const checkpointIntervalMs = Number(registry.checkpointIntervalMinutes || 15) * 60_000;
  const manifestGeneratedAt = toEpochMs(manifest?.generatedAt);
  const manifestAgeMs = manifestGeneratedAt === null ? null : Math.max(0, Date.now() - manifestGeneratedAt);
  const freshness = {
    valid: manifestAgeMs !== null && manifestAgeMs <= checkpointIntervalMs * 2,
    manifestAgeMs,
    maximumAgeMs: checkpointIntervalMs * 2,
  };
  const status = checks.every((check) => check.valid) && eventChain.valid && freshness.valid ? "PASS" : "FAIL";
  return { status, checkedAt: new Date().toISOString(), checks, eventChain, freshness };
}

async function status() {
  const manifest = await readJson(MANIFEST_PATH, null);
  const integrity = await verify();
  return { manifest, integrity };
}

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function remember(args) {
  const agentId = flagValue(args, "--agent");
  const id = flagValue(args, "--id");
  const kind = flagValue(args, "--kind", "DIRECTIVE");
  const text = flagValue(args, "--text");
  const priority = flagValue(args, "--priority", "P1");
  const statusValue = flagValue(args, "--status", "ACTIVE");
  if (!agentId || !id || !text) throw new Error("REMEMBER_REQUIRES_AGENT_ID_TEXT");
  const registry = await loadRegistry();
  if (!registry.agents.some((agent) => agent.id === agentId)) throw new Error(`UNKNOWN_AGENT_${agentId}`);
  const filePath = path.join(MEMORY_ROOT, "agents", agentId, "directives.json");
  const document = await readJson(filePath, { schemaVersion: 1, directives: [] });
  const item = { id, kind, status: statusValue, priority, summary: text, updatedAt: new Date().toISOString() };
  const index = document.directives.findIndex((candidate) => candidate.id === id);
  if (index >= 0) document.directives[index] = { ...document.directives[index], ...item };
  else document.directives.push(item);
  await atomicWriteJson(filePath, document);
  await appendEvent({ type: "MEMORY_ITEM_UPSERTED", agentId, itemId: id, itemHash: sha256(stableStringify(item)) });
  const result = await checkpointAgent(registry.agents.find((agent) => agent.id === agentId), registry);
  await updateManifest([result], registry);
  return result;
}

async function updateCursor(args) {
  const agentId = flagValue(args, "--agent");
  const messageId = flagValue(args, "--message-id");
  if (!agentId || !messageId) throw new Error("CURSOR_REQUIRES_AGENT_AND_MESSAGE_ID");
  const registry = await loadRegistry();
  const agent = registry.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`UNKNOWN_AGENT_${agentId}`);
  const cursor = { lastProcessedMessageId: messageId, updatedAt: new Date().toISOString() };
  await atomicWriteJson(path.join(MEMORY_ROOT, "agents", agentId, "message-cursor.json"), cursor);
  await appendEvent({ type: "MESSAGE_CURSOR_UPDATED", agentId, messageId });
  const result = await checkpointAgent(agent, registry);
  await updateManifest([result], registry);
  return result;
}

async function searchMemory(query, agentId = null) {
  const registry = await loadRegistry();
  const agents = agentId ? registry.agents.filter((agent) => agent.id === agentId) : registry.agents;
  if (!agents.length) throw new Error(`UNKNOWN_AGENT_${agentId}`);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const agent of agents) {
    const latest = await readJson(path.join(MEMORY_ROOT, "agents", agent.id, "latest.json"), null);
    if (!latest) continue;
    for (const [kind, items] of [["decision", latest.content.decisions], ["directive", latest.content.directives]]) {
      for (const item of items ?? []) {
        const haystack = JSON.stringify(item).toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        if (score) results.push({ agentId: agent.id, kind, score, item });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

async function printStartup(agentId) {
  const filePath = path.join(MEMORY_ROOT, "agents", agentId, "STARTUP.md");
  return fs.readFile(filePath, "utf8");
}

async function main() {
  const [command = "status", target = null, ...rest] = process.argv.slice(2);
  let output;
  if (command === "checkpoint") output = await checkpoint(target ?? "all");
  else if (command === "verify") output = await verify();
  else if (command === "status") output = await status();
  else if (command === "archive") output = await archiveToHost();
  else if (command === "startup") {
    process.stdout.write(await printStartup(target));
    return;
  } else if (command === "remember") output = await withWriterLock(() => remember([target, ...rest].filter(Boolean)));
  else if (command === "cursor") output = await withWriterLock(() => updateCursor([target, ...rest].filter(Boolean)));
  else if (command === "search") {
    const searchArgs = [target, ...rest].filter(Boolean);
    const agentId = flagValue(searchArgs, "--agent");
    const agentFlagIndex = searchArgs.indexOf("--agent");
    if (agentFlagIndex >= 0) searchArgs.splice(agentFlagIndex, 2);
    output = await searchMemory(searchArgs.join(" "), agentId);
  }
  else throw new Error(`UNKNOWN_COMMAND_${command}`);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output?.status === "FAIL") process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "ERROR", error: error?.stack || String(error) })}\n`);
  process.exitCode = 1;
});
