import { validateRules, freshRules, quoteView } from "./s1-precision.mjs";
import { sanitizeAccountDetails } from './s1-account.mjs';
const text = (value) => typeof value === "string" ? value.slice(0, 160) : null;
function precisionView(input, universe, now) {
  const rules = [], errors = [];
  if (input?.source !== "BINANCE_USDM_MAINNET_EXCHANGE_INFO") return { rules, errors: [{ symbol: "ALL", reason: "RULES_NOT_RECEIVED" }], submissionAllowed: false };
  const seen = new Set();
  for (const raw of (Array.isArray(input.rules) ? input.rules : []).slice(0, 10)) {
    try { if (!universe.includes(raw?.symbol) || seen.has(raw.symbol)) throw new Error("RULE_SYMBOL_SCOPE_OR_DUPLICATE"); const rule = freshRules(validateRules(raw), raw.symbol, now); seen.add(raw.symbol); rules.push(rule); }
    catch (error) { errors.push({ symbol: text(raw?.symbol), reason: text(error.message) }); }
  }
  for (const symbol of universe) if (!seen.has(symbol)) errors.push({ symbol, reason: "RULES_UNAVAILABLE" });
  return { source: "BINANCE_USDM_MAINNET_EXCHANGE_INFO", rules, errors, submissionAllowed: false };
}
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; };
export function sanitizeS1(input, now = Date.now()) {
  if (!input || input.accountLabel !== "S1" || input.mode !== "SCAN_ONLY" || input.realOrdersAllowed !== false || input.newEntriesBlocked !== true) throw new Error("S1_SCOPE_MISMATCH");
  const sourceAsOf = timestamp(input.sourceAsOf);
  if (!sourceAsOf || Date.parse(sourceAsOf) > now + 30000 || now - Date.parse(sourceAsOf) > 900000) throw new Error("INVALID_SOURCE_TIME");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("INVALID_SEQUENCE");
  const account = input.account ?? {};
  const universe = (Array.isArray(input.universe) ? input.universe : []).slice(0, 10).filter((v) => typeof v === "string" && /^[A-Z]{2,12}USDT$/.test(v));
  const precision = precisionView(input.precision, universe, now);
  const marketQuotes = universe.map(symbol => {
    const raw = input.marketQuotes?.find?.(row => row.symbol === symbol);
    try { const result = quoteView({ ...raw, time: Date.parse(raw?.exchangeTime) }, precision.rules.find(rule => rule.symbol === symbol), symbol, now); return { ...result, observedAt: timestamp(raw?.observedAt) }; }
    catch (error) { return { symbol, status: "UNAVAILABLE", reason: text(error.message), executionQualified: false }; }
  });
  return { schemaVersion: 1, accountLabel: "S1", mode: "SCAN_ONLY", revision: "MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION", sourceAsOf,
    sequence: input.sequence, candidateLifecycleRevision: text(input.candidateLifecycleRevision), bootId: text(input.bootId), startedAt: timestamp(input.startedAt), lastSuccessfulScanAt: timestamp(input.lastSuccessfulScanAt),
    status: input.status === "HEALTHY" ? "HEALTHY" : "DEGRADED", scanDurationMs: number(input.scanDurationMs), scannedSymbols: number(input.scannedSymbols),
    universe, precision, marketQuotes,
    account: { observedAt: timestamp(account.observedAt), details: sanitizeAccountDetails(account.details), positionMode: ['HEDGE','ONE_WAY'].includes(account.positionMode) ? account.positionMode : null, fresh: account.fresh === true, userStreamConnected: account.userStreamConnected === true,
      equity: number(account.equity), wallet: number(account.wallet), available: number(account.available), positions: number(account.positions), orders: number(account.orders), algoOrders: number(account.algoOrders) },
    candidates: (Array.isArray(input.candidates) ? input.candidates : []).slice(0, 200).map((row) => ({ id: text(row.id), symbol: text(row.symbol), status: text(row.status), direction: ["LONG", "SHORT"].includes(row.direction) ? row.direction : null,
      directionClosedAt: timestamp(row.directionClosedAt), intersectionTime: timestamp(row.intersectionTime), intersectionPrice: number(row.intersectionPrice), discoveredAt: timestamp(row.discoveredAt), observedAt: timestamp(row.observedAt),
      quality: number(row.quality), reason: text(row.reason), stale: row.stale === true, executable: false, gate1Qualified: false })),
    errors: (Array.isArray(input.errors) ? input.errors : []).slice(0, 10).map((row) => ({ symbol: text(row.symbol), reason: text(row.reason) })),
    publish: { status: text(input.publish?.status), at: timestamp(input.publish?.at) },
    recovery: { restartEnabled: true, watchdogSeconds: 180, stateRecovered: input.recovery?.stateRecovered === true },
    eventGate: { status: ["CALENDAR_UNVERIFIED_PAUSE", "EVENT_WINDOW_PAUSE", "NO_SCHEDULED_WINDOW"].includes(input.eventGate?.status) ? input.eventGate.status : "CALENDAR_UNVERIFIED_PAUSE",
      newEntriesPaused: input.eventGate?.newEntriesPaused !== false, pauseUntil: timestamp(input.eventGate?.pauseUntil), calendarCheckedAt: timestamp(input.eventGate?.calendarCheckedAt),
      beforeMinutes: 30, afterMinutes: 30, existingPositions: "UNCHANGED_ORIGINAL_RULES", signalWindowExtensionAllowed: false },
    realOrdersAllowed: false, newEntriesBlocked: true, tickBboExecutionEvidence: false };
}
export function safeEqual(left, right) { if (!left || left.length !== right.length) return false; let mismatch = 0; for (let i = 0; i < left.length; i++) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i); return mismatch === 0; }
