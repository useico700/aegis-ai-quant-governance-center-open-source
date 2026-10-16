import fs from "node:fs/promises";
import path from "node:path";

import { appendChainedAudit } from "../../../integrations/binance-usdm-testnet/audit-ledger.mjs";
import { ROOT } from "./context.mjs";
import { readJson, writeJsonAtomic } from "./runtime-utils.mjs";

export const V4_PARITY_REVISION = "ORION-V4-MTFX-R22-V2-FULL-RULE-PARITY-20260829";
export const V4_PARITY_AUTHORIZATION_ID = "OWNER-DIRECTIVE-ORION-V4-MTFX-R22-V2-FULL-RULE-PARITY-20260829";
export const V4_PARITY_COHORT_ID = "ORION-V4-MTFX-R22-V2-FULL-RULE-PARITY-FORWARD-20260829";
export const V4_DEMO_STREAM_BASE_URL = "wss://fstream.binancefuture.com/stream";
export const V4_CANDIDATE_LIFECYCLE_PATH = path.join(ROOT, ".runtime/orion-v4-binance-demo/candidate-lifecycle.json");
export const V4_CANDIDATE_AUDIT_PATH = path.join(ROOT, ".runtime/orion-v4-binance-demo/candidate-audit.ndjson");
export const V4_BBO_LATEST_PATH = path.join(ROOT, ".runtime/orion-v4-binance-demo/causal-bbo-latest.json");

const FIFTEEN_MINUTES = 900_000;
const TERMINAL = new Set(["CONSUMED", "REJECTED", "INVALIDATED", "EXPIRED"]);
let lifecycleQueue = Promise.resolve();

function invariant(condition, code) { if (!condition) throw new Error(code); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function planKey(plan) { return String(plan?.id ?? ""); }

export function confirmationReserveDeadline(plan, signalPolicy = {}) {
  return Number(plan?.lockedBarOpenTime) + Number(signalPolicy.maximumReserveBars ?? 4) * FIFTEEN_MINUTES + Number(signalPolicy.maximumEntrySignalAgeMs ?? 180_000);
}

export function normalizeCausalBbo(raw, receivedAt = Date.now(), prior = null) {
  const symbol = String(raw?.symbol ?? raw?.s ?? "").toUpperCase();
  const bid = finite(raw?.bid ?? raw?.bidPrice ?? raw?.b);
  const ask = finite(raw?.ask ?? raw?.askPrice ?? raw?.a);
  const eventTime = finite(raw?.eventTime ?? raw?.E ?? raw?.time);
  const transactionTime = finite(raw?.transactionTime ?? raw?.T ?? eventTime);
  const updateId = finite(raw?.updateId ?? raw?.u ?? raw?.lastUpdateId);
  const localReceivedAt = finite(raw?.receivedAt ?? receivedAt);
  invariant(/^[A-Z0-9]{5,20}$/.test(symbol), "V4_CAUSAL_BBO_SYMBOL_INVALID");
  invariant(bid > 0 && ask >= bid, "V4_CAUSAL_BBO_PRICE_INVALID");
  invariant(eventTime > 0 && transactionTime > 0 && localReceivedAt > 0, "V4_CAUSAL_BBO_DUAL_CLOCK_REQUIRED");
  invariant(Number.isSafeInteger(updateId) && updateId >= 0, "V4_CAUSAL_BBO_UPDATE_ID_REQUIRED");
  invariant(eventTime <= localReceivedAt + 60_000, "V4_CAUSAL_BBO_EVENT_TIME_IN_FUTURE");
  if (prior) {
    invariant(eventTime >= Number(prior.eventTime), "V4_CAUSAL_BBO_EXCHANGE_CLOCK_REGRESSION");
    invariant(updateId > Number(prior.updateId), "V4_CAUSAL_BBO_UPDATE_ID_NOT_STRICTLY_INCREASING");
    invariant(localReceivedAt >= Number(prior.receivedAt), "V4_CAUSAL_BBO_RECEIVE_CLOCK_REGRESSION");
  }
  return { symbol, bid, ask, eventTime, transactionTime, updateId, receivedAt: localReceivedAt, marketTime: eventTime, source: "BINANCE_USDM_DEMO_CAUSAL_BBO" };
}

export function validateCausalEntryEvidence({ quote, decisionBarCloseTime, now, decisionMarketTime = now, decisionLocalTime = now, stopReadyAt = decisionBarCloseTime, deadline = Number(decisionBarCloseTime) + 180_000, maximumAgeMs = 15_000 }) {
  const closeTime = Number(decisionBarCloseTime);
  const localTime = Number(decisionLocalTime);
  const marketDecision = Number(decisionMarketTime);
  const marketTime = Number(quote?.marketTime ?? quote?.eventTime);
  const receivedAt = Number(quote?.receivedAt);
  if (!(closeTime > 0) || marketDecision < closeTime) return { accepted: false, terminal: false, reason: "V4_DECISION_BAR_NOT_CLOSED" };
  if (![marketTime, receivedAt, Number(stopReadyAt), Number(deadline), marketDecision, localTime].every(Number.isFinite)) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_TEMPORAL_EVIDENCE_INCOMPLETE" };
  if (marketTime < Number(stopReadyAt)) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_BEFORE_DECISION_READY" };
  if (marketTime > Number(deadline)) return { accepted: false, terminal: true, reason: "V4_CAUSAL_BBO_AFTER_ENTRY_DEADLINE" };
  if (marketTime > marketDecision) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_AFTER_DECISION_MARKET_CLOCK" };
  if (receivedAt > localTime) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_RECEIVED_AFTER_DECISION_LOCAL_CLOCK" };
  if (!(Number.isSafeInteger(Number(quote.updateId)))) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_UPDATE_ID_REQUIRED" };
  if (marketDecision - marketTime > Number(maximumAgeMs)) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_EXCHANGE_CLOCK_STALE", deadline };
  if (localTime - receivedAt > Number(maximumAgeMs)) return { accepted: false, terminal: false, reason: "V4_CAUSAL_BBO_LOCAL_RECEIVE_STALE", deadline };
  return { accepted: true, terminal: false, reason: "V4_CAUSAL_BBO_FRESH", deadline, marketTime, receivedAt };
}

export function selectCommittedParityPlan({ discovered, previousPlan, now, sourceStrategy, config }) {
  const sameRevision = previousPlan?.implementationRevisionAtDiscovery === sourceStrategy.implementationRevision && previousPlan?.riskPolicyRevisionAtDiscovery === config.riskPolicy.revision;
  const previousUsable = Boolean(previousPlan && sameRevision && now <= confirmationReserveDeadline(previousPlan, sourceStrategy.signal));
  const committed = previousUsable && now >= Number(previousPlan.commitAt);
  if (committed) return { ...previousPlan, committed: true, frozen: now >= Number(previousPlan.lockedBarOpenTime) };
  if (!discovered) return previousUsable ? previousPlan : null;
  if (previousPlan && sameRevision && planKey(discovered) === planKey(previousPlan)) {
    return { ...discovered, createdAt: previousPlan.createdAt, version: previousPlan.version, lifecycleCreatedAt: previousPlan.lifecycleCreatedAt ?? previousPlan.createdAt };
  }
  const createdAt = Number(discovered.createdAt ?? now);
  return {
    ...discovered,
    createdAt,
    version: previousPlan && sameRevision ? Number(previousPlan.version ?? 1) + 1 : 1,
    lifecycleCreatedAt: createdAt,
  };
}

function blankLifecycle({ activatedAt, cohortId, implementationRevision }) {
  return { schemaVersion: 2, activatedAt, cohortId, implementationRevision, activeBySymbol: {}, terminalByPlanId: {}, auditOutbox: [], updatedAt: new Date(activatedAt).toISOString() };
}

export async function loadCandidateLifecycle({ activatedAt, cohortId, implementationRevision, lifecyclePath = V4_CANDIDATE_LIFECYCLE_PATH }) {
  const fallback = blankLifecycle({ activatedAt, cohortId, implementationRevision });
  const state = await readJson(lifecyclePath, fallback);
  if (state.cohortId !== cohortId || state.implementationRevision !== implementationRevision || Number(state.activatedAt) !== Number(activatedAt)) return fallback;
  // Schema 2 adds the durable audit outbox.  Same-cohort schema-1 state is
  // migrated in memory without discarding active or terminal candidates; the
  // next lifecycle mutation atomically persists the upgraded representation.
  state.schemaVersion = 2;
  state.activeBySymbol ??= {};
  state.terminalByPlanId ??= {};
  state.auditOutbox ??= [];
  return state;
}

function lifecycleEventId(event) {
  return [event.eventType, event.cohortId, event.symbol, event.planId, event.status ?? "", event.version ?? "", event.signalId ?? ""].join(":");
}

async function recordedLifecycleEventIds() {
  try {
    const text = await fs.readFile(V4_CANDIDATE_AUDIT_PATH, "utf8");
    return new Set(text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)?.lifecycleEventId).filter(Boolean));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

export async function flushCandidateAuditOutbox(state, { append = appendChainedAudit, recordedIds = recordedLifecycleEventIds } = {}) {
  const recorded = await recordedIds();
  for (const event of state.auditOutbox ?? []) {
    if (!recorded.has(event.lifecycleEventId)) {
      await append(V4_CANDIDATE_AUDIT_PATH, event);
      recorded.add(event.lifecycleEventId);
    }
  }
  state.auditOutbox = [];
  return state;
}

async function mutateLifecycle(context, mutate) {
  const task = lifecycleQueue.then(async () => {
    const state = await loadCandidateLifecycle(context);
    if (state.auditOutbox.length) {
      await flushCandidateAuditOutbox(state);
      await writeJsonAtomic(V4_CANDIDATE_LIFECYCLE_PATH, state);
    }
    const events = [];
    mutate(state, events);
    state.updatedAt = new Date(context.now ?? Date.now()).toISOString();
    state.auditOutbox.push(...events.map((event) => ({ ...event, lifecycleEventId: lifecycleEventId(event) })));
    await writeJsonAtomic(V4_CANDIDATE_LIFECYCLE_PATH, state);
    await flushCandidateAuditOutbox(state);
    await writeJsonAtomic(V4_CANDIDATE_LIFECYCLE_PATH, state);
    return state;
  });
  lifecycleQueue = task.catch(() => {});
  return task;
}

export function applyActiveCandidatesMutation(state, rows, context) {
    const events = [];
    const next = {};
    for (const row of rows) {
      const plan = row?.plan;
      if (!plan || TERMINAL.has(state.terminalByPlanId?.[plan.id]?.status)) continue;
      const prior = state.activeBySymbol?.[row.symbol];
      const createdAt = prior?.planId === plan.id ? prior.createdAt : Number(plan.createdAt ?? context.now);
      const version = prior?.planId === plan.id ? prior.version : Number(plan.version ?? 1);
      const observation = row.signal?.oppositePriceAcceptanceObservation;
      const priorObservation = prior?.oppositePriceAcceptanceObservedAt ? {
        oppositePriceAcceptanceObservedAt: prior.oppositePriceAcceptanceObservedAt,
        oppositePriceAcceptanceObservedDirection: prior.oppositePriceAcceptanceObservedDirection,
        oppositePriceAcceptanceObservedBarOpenTime: prior.oppositePriceAcceptanceObservedBarOpenTime,
      } : null;
      const newObservation = !priorObservation && observation ? {
        oppositePriceAcceptanceObservedAt: observation.observedAt,
        oppositePriceAcceptanceObservedDirection: observation.direction,
        oppositePriceAcceptanceObservedBarOpenTime: observation.barOpenTime,
      } : null;
      next[row.symbol] = { symbol: row.symbol, planId: plan.id, createdAt, version, commitAt: plan.commitAt, committed: context.now >= Number(plan.commitAt), lockedBarOpenTime: plan.lockedBarOpenTime, reserveDeadline: confirmationReserveDeadline(plan, context.signalPolicy), plan: { ...plan, createdAt, version }, signalStatus: row.signal?.status ?? null, ...(priorObservation ?? newObservation ?? {}), updatedAt: context.now };
      if (!prior || prior.planId !== plan.id) events.push({ eventType: "V4_MTFX_CANDIDATE_CREATED", occurredAt: new Date(context.now).toISOString(), symbol: row.symbol, planId: plan.id, createdAt, version, cohortId: context.cohortId });
      else if (!prior.committed && next[row.symbol].committed) events.push({ eventType: "V4_MTFX_CANDIDATE_COMMITTED", occurredAt: new Date(context.now).toISOString(), symbol: row.symbol, planId: plan.id, createdAt, version, commitAt: plan.commitAt, cohortId: context.cohortId });
      if (newObservation) events.push({ eventType: "V4_MTFX_OPPOSITE_PRICE_ACCEPTANCE_OBSERVED", occurredAt: new Date(context.now).toISOString(), symbol: row.symbol, planId: plan.id, version, lockedDirection: row.signal.direction, observedDirection: newObservation.oppositePriceAcceptanceObservedDirection, observedBarOpenTime: newObservation.oppositePriceAcceptanceObservedBarOpenTime, observedAt: newObservation.oppositePriceAcceptanceObservedAt, cohortId: context.cohortId });
    }
    for (const [symbol, prior] of Object.entries(state.activeBySymbol ?? {})) {
      if (!next[symbol] && !state.terminalByPlanId?.[prior.planId]) {
        state.terminalByPlanId[prior.planId] = { ...prior, status: "INVALIDATED", reason: "NO_LONGER_ACTIVE_AFTER_ABSOLUTE_RESERVE", terminalAt: context.now };
        events.push({ eventType: "V4_MTFX_CANDIDATE_TERMINAL", occurredAt: new Date(context.now).toISOString(), symbol, planId: prior.planId, status: "INVALIDATED", reason: "NO_LONGER_ACTIVE_AFTER_ABSOLUTE_RESERVE", cohortId: context.cohortId });
      }
    }
    state.activeBySymbol = next;
    return events.map((event) => ({ ...event, lifecycleEventId: lifecycleEventId(event) }));
}

export async function persistActiveCandidates(rows, context) {
  return mutateLifecycle(context, (state, events) => {
    events.push(...applyActiveCandidatesMutation(state, rows, context).map(({ lifecycleEventId: _ignored, ...event }) => event));
  });
}

export async function markCandidateTerminal({ symbol, planId, status, reason, signalId = null }, context) {
  invariant(TERMINAL.has(status), "V4_CANDIDATE_TERMINAL_STATUS_INVALID");
  return mutateLifecycle(context, (state, events) => {
    if (state.terminalByPlanId?.[planId]) return;
    const prior = state.activeBySymbol?.[symbol];
    state.terminalByPlanId[planId] = { ...(prior ?? { symbol, planId }), status, reason, signalId, terminalAt: context.now };
    if (prior?.planId === planId) delete state.activeBySymbol[symbol];
    events.push({ eventType: "V4_MTFX_CANDIDATE_TERMINAL", occurredAt: new Date(context.now).toISOString(), symbol, planId, signalId, status, reason, cohortId: context.cohortId });
  });
}

export class V4CausalBboFeed {
  constructor({
    symbols,
    WebSocketImpl = WebSocket,
    clock = Date.now,
    onQuote = null,
    streamBaseUrl = V4_DEMO_STREAM_BASE_URL,
    latestPath = V4_BBO_LATEST_PATH,
    staleAfterMs = 10_000,
    watchdogIntervalMs = 2_000,
    reconnectDelayMs = 1_000,
    healthPersistIntervalMs = 5_000,
  } = {}) {
    this.symbols = [...new Set((symbols ?? []).map((value) => String(value).toUpperCase()))];
    this.WebSocketImpl = WebSocketImpl;
    this.clock = clock;
    this.onQuote = onQuote;
    this.streamBaseUrl = streamBaseUrl;
    this.latestPath = latestPath;
    this.quotes = new Map();
    this.socket = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.connectedAt = null;
    this.lastMessageAt = null;
    this.staleAfterMs = staleAfterMs;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.healthPersistIntervalMs = healthPersistIntervalMs;
    this.lastHealthPersistAt = 0;
    this.healthTransitionPending = false;
  }
  url() {
    const url = new URL(this.streamBaseUrl);
    invariant(url.protocol === "wss:" && url.hostname === "fstream.binancefuture.com", "V4_DEMO_STREAM_HOST_INVALID");
    url.searchParams.set("streams", this.symbols.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join("/"));
    return url.toString();
  }
  start() {
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = new this.WebSocketImpl(this.url());
    this.socket = socket;
    this.connectedAt = this.clock();
    socket.addEventListener("open", () => {
      if (socket !== this.socket) return;
      this.connectedAt = this.clock();
      this.lastMessageAt = this.connectedAt;
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      try {
        const envelope = JSON.parse(String(event.data));
        const raw = envelope?.data ?? envelope;
        const symbol = String(raw?.s ?? "").toUpperCase();
        if (!this.symbols.includes(symbol)) return;
        const quote = normalizeCausalBbo(raw, this.clock(), this.quotes.get(symbol));
        this.quotes.set(symbol, quote);
        this.lastMessageAt = this.clock();
        if (this.healthTransitionPending || this.lastMessageAt - this.lastHealthPersistAt >= this.healthPersistIntervalMs) {
          this.healthTransitionPending = false;
          this.lastHealthPersistAt = this.lastMessageAt;
          void this.persistLatest().catch(() => {});
        }
        void this.onQuote?.(quote);
      } catch {}
    });
    const reconnect = () => {
      if (this.stopped || socket !== this.socket) return;
      this.reconnectTimer = setTimeout(() => this.start(), this.reconnectDelayMs);
    };
    socket.addEventListener("close", reconnect);
    socket.addEventListener("error", () => { try { socket.close(); } catch {} });
    this.ensureWatchdog();
    return this;
  }
  ensureWatchdog() {
    if (this.watchdogTimer || this.stopped) return;
    this.watchdogTimer = setInterval(() => {
      if (this.health().status !== "STALE" || !this.socket) return;
      const staleSocket = this.socket;
      this.healthTransitionPending = true;
      void this.persistLatest().catch(() => {});
      try { staleSocket.close(4_000, "V4_CAUSAL_BBO_STALE_SELF_HEAL"); } catch {}
      setTimeout(() => {
        if (!this.stopped && staleSocket === this.socket) this.start();
      }, this.reconnectDelayMs).unref?.();
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref?.();
  }
  health(now = this.clock()) {
    const referenceAt = Number(this.lastMessageAt || this.connectedAt || 0);
    const ageMs = referenceAt > 0 ? Math.max(0, now - referenceAt) : null;
    return {
      status: ageMs !== null && ageMs <= this.staleAfterMs ? "LIVE" : "STALE",
      ageMs,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
    };
  }
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    try { this.socket?.close(); } catch {}
  }
  quote(symbol) { return this.quotes.get(String(symbol).toUpperCase()) ?? null; }
  async waitForCoverage(timeoutMs = 10_000) {
    const deadline = this.clock() + timeoutMs;
    while (this.clock() < deadline) {
      if (this.symbols.every((symbol) => this.quotes.has(symbol))) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("V4_CAUSAL_BBO_COVERAGE_TIMEOUT");
  }
  async persistLatest() {
    await writeJsonAtomic(this.latestPath, { schemaVersion: 1, venue: "BINANCE_USDM_DEMO", streamHost: "fstream.binancefuture.com", updatedAt: new Date(this.clock()).toISOString(), health: this.health(), quotes: Object.fromEntries(this.quotes) });
  }
}
