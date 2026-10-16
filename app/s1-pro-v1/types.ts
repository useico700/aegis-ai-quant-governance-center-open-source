// Re-uses the classic S1 payload types; S1 Pro adds no API surface.
export type { AccountRecord, EquityPoint, History, PositionRow } from "../s1/AccountWorkspace";
export type { CandidatePriority, ExecutionLedger, ExecutionState, FillRow } from "../s1/TradeLedger";
export type { MarketQuote, PrecisionRule } from "../s1/PriceCalibration";
export type { Candidate } from "../s1/CandidateFunnel";
export type { FilteredCandidate } from "../s1/CandidateHistory";
export type { EventGate } from "../s1/RiskCalendar";
import type { AccountRecord, History } from "../s1/AccountWorkspace";
import type { ExecutionLedger } from "../s1/TradeLedger";
import type { MarketQuote, PrecisionRule } from "../s1/PriceCalibration";
import type { Candidate } from "../s1/CandidateFunnel";
import type { EventGate } from "../s1/RiskCalendar";

export type Snapshot = {
  sourceAsOf: string; sequence: number; startedAt: string; bootId: string; status: string; scanDurationMs: number; scannedSymbols: number; universe: string[]; lastSuccessfulScanAt: string | null;
  account: AccountRecord;
  marketQuotes?: MarketQuote[]; precision?: { rules: PrecisionRule[]; errors: { symbol: string; reason: string }[] };
  candidates: Candidate[]; errors: { symbol: string; reason: string }[]; publish: { status: string; at: string | null }; recovery: { stateRecovered: boolean }; eventGate?: EventGate;
};

export type RiskEvent = { id: string; name: string; category: string; tier: string; provider: string; scheduledAt: string; sourceUrl: string };
export type CalendarSource = { provider: string; status: string; verifiedAt: string; coverageEnd: string; error: string | null };
export type RiskCalendarFeed = { checkedAt: string; sources: CalendarSource[]; events: RiskEvent[] };

export type LiveQuoteState = "CONNECTING" | "LIVE" | "PAUSED" | "RECONNECTING" | "UNAVAILABLE";

/** Everything the dashboard renders; produced either by the live poller or by the demo generator. */
export type Feed = {
  snapshot: Snapshot | null;
  history?: History;
  ledger?: ExecutionLedger;
  ledgerError: boolean;
  error: string;
  loading: boolean;
  quotes: MarketQuote[];
  quoteState: LiveQuoteState;
  calendar: RiskCalendarFeed | null;
  calendarFailure: boolean;
  demo: boolean;
};
