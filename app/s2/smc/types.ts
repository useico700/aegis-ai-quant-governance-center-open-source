// Types mirror the payloads already consumed by /s2/smc. This module adds no new API surface.

export type Direction = "LONG" | "SHORT";

export type LiveQuote = { symbol: string; bid: number; ask: number; quoteAt: number };
export type LiveQuoteSnapshot = { schema: "SMC_LIVE_QUOTES_V1"; source: "BINANCE_USDM_BOOK_TICKER"; observedAt: string; quotes: LiveQuote[] };

// Read-only projection already validated by the scanner snapshot boundary.
export type IntersectionEvent = { id: string; tx: number; px: number; h?: { tf: string; n: number }; l?: { tf: string; n: number } };
export type IntersectionWindow = { event: IntersectionEvent; selectedAt: number; opensAt: number; expiresAt: number };
export type IntersectionClock = { revision: string; observedAt: number; coordinate: "LOG"; futureCount: number;
  windows: IntersectionWindow[]; active: IntersectionWindow | null; orderAuthority: false };

export type CeTouch = {
  source: "CLOSED_15M_BODY_CROSS" | "CLOSED_15M_WICK_RECLAIM" | "CLOSED_15M_FALSE_BREAK_RECLAIM";
  testedAt: number;
  trigger: number;
  extreme: number;
  open: number;
  close: number;
  falseBreakAt?: number | null;
};

export type Opportunity = {
  modelRevision?: string; intersectionEvent?: { id: string; tx: number; px: number }; sourcePlan?: StructurePlan; sourceContext?: StructureContext;
  id: string; symbol: string; direction: Direction; status: string; entry: number; stop: number; target: number; netR: number; observedAt: number; expiresAt: number;
  candidateSource: "AUTOMATIC" | "OWNER_SELECTED"; ownerSelectedAt: number | null; ownerAutoTradingEnabled?: boolean | null;
  entryHistoryCoverage: "CONTINUOUS_FROM_POI" | "CURRENT_15M_WINDOW_WITH_FULL_4H_VALIDATION" | "CONTINUOUS_FROM_PLAN";
  referenceEntry: number;
  entryBand: { low: number; high: number; ce: number; trigger: number; triggerFraction?: .5; zoneFraction?: .5; half: "CE_TO_FVG_HIGH" | "FVG_LOW_TO_CE" | "CONFIRMED_RETEST_PRICE_BAND" | "TIMED_SMC_REACTION_BAND" | "LOCAL_SMC_REACTION_BAND" };
  zone: { kind: string; low: number; high: number; ce?: number };
  structure: { eventType: "BOS" | "CHOCH" | "MSS" | "LOCAL_RETEST"; priorBias: string; bosAt: number; bosClose: number; volumeRatio: number; bodyFraction: number; bodyAtr?: number; qualityGrade?: string; qualityModel?: string; nPatternQualified?: boolean };
  poiLifecycle?: { mitigationEpisodes: number; touchBars: number; ceBodyCrosses: number; exhausted: false; exhaustedReason: null };
  entryLiquidity?: { model: "CONFIRMED_15M_PIVOT_2X2"; ready: boolean; blocking: Array<{ kind: string; price: number; time: number; confirmedAt: number }>; sweptOnConfirmation: Array<{ kind: string; price: number; time: number; confirmedAt: number }>; stopAdjustedForLiquidity: boolean; provisionalStop: number; adjustedStop: number };
  entryLocation?: { model: "CAUSAL_15M_DUAL_DEALING_RANGE_PERCENTILE"; ready: boolean; percentile: number; robustPercentile: number; rangeLow: number; rangeHigh: number; robustLow: number; robustHigh: number; reason: string | null };
  entryRegime?: { model: "CAUSAL_15M_EXPANSION_EFFICIENCY"; ready: boolean; compressed: boolean; rangeAtr: number; efficiency: number; confirmationRangeAtr: number; directionalCloseLocation: number; reason: string | null };
  entryMicroStructure?: { model: "CLOSED_15M_POST_TOUCH_MICRO_SHIFT"; state: string; ready: boolean; touchAt?: number; confirmedAt?: number; barsElapsed?: number; breakLevel?: number; bodyFraction?: number; rangeAtr?: number; directionalCloseLocation?: number };
  entryConfirmation?: { state: string; mode: "CLOSED_15M_POST_TOUCH_MICRO_STRUCTURE_SHIFT" | "CLOSED_15M_SECOND_BAR_CE_REVERSAL" | "CLOSED_5M_CONTINUATION_RETEST" | "CLOSED_5M_TIMED_SMC_REACTION" | "CLOSED_5M_LOCAL_SMC_REACTION" | "CLOSED_15M_LOCAL_SMC_REACTION"; reversal?: { secondBarAt?: number; secondClose?: number } | null; touchAt?: number | null; touchCount?: number; ceTouch?: CeTouch | null; microStructure?: Opportunity["entryMicroStructure"]; liveBboInsideBand: boolean; closedBarRequired: true };
  confirmationAt: number | null; quoteFresh?: boolean; executionQualified?: boolean;
  distanceToEntry?: { executablePrice: number; absolute: number; percent: number; quoteAt: number; side: "ASK" | "BID"; basis: string } | null;
};

export type StructureObservation = { id: string; symbol: string; direction: Direction; eventType: "BOS" | "CHOCH" | "MSS"; grade: "A" | "B" | "C"; admission: "PLAN_ELIGIBLE" | "OBSERVE_ONLY"; breakAt: number; qualityModel: string; reasons: string[]; nPatternQualified?: boolean;
  liquiditySweep?: { pivot?: { kind?: "HIGH" | "LOW"; price?: number; time?: number }; extreme?: number; sweptAt?: number } | null };
export type ManualZone = { id: string; direction: Direction; kind: "FVG" | "SWING_SUPPORT" | "SWING_RESISTANCE"; low: number; high: number; ce: number;
  availableAt: number; lastTouchAt: number | null; touches: number; distancePercent: number; ageDays: number; orderAuthority: false };
export type ManualCandidate = { symbol: string; direction: Direction; createdAt: number; autoTradingEnabled: boolean;
  selectionMode?: "MANUAL" | "AUTO"; selectionReason?: string | null; planningOnly?: boolean };
export type TargetPath = { revision?: string; state: string; ready: boolean; admissionTarget: number | null; netR: number | null;
  barrier?: { direction: Direction; low: number; high: number; ce: number; availableAt: number } | null; reason?: string | null };
export type StructurePlan = { targetPathRevision?: string; targetPath?: TargetPath; entryPolicyRevision?: string; riskScopeRevision?: string; targetPolicyRevision?: string; targetBasis?: {directionSupport?: {mode: "4H_ALIGNED" | "15M_CONFIRMED_TRANSITION" | null}; scope: "4H_MAIN" | "15M_LOCAL"; obstacles: Array<{price:number;timeframe:string}>}; stopBasis?: { entryValid?: boolean; ready: boolean; timeframe: string; kind?: string; point?: {price:number}; buffer?:number }; availableAt?: number; tickSize?: number; entryReview?: { atr15m?: number; timing: { ready: boolean; state: string } }; opportunity?: { pattern: string; sequenceBias: string; localConflict: boolean; unknownFrames: string[]; location: { ready: boolean }; continuationAtPremium: boolean }; id: string; symbol: string; direction: Direction; observedAt: number; expiresAt: number;
  model: "CONFIRMED_15M_SWING_RETEST"; entry: number; stop: number; target: number | null; netR: number | null;
  zone: { kind: "SWING_SUPPORT" | "SWING_RESISTANCE"; low: number; high: number; ce: number };
  anchor: { time?: number; confirmedAt: number; timeframe: "15M" }; conflicts: string[]; blockers: string[] };
export type StructureContext = {
  revision: string; observedAt: number; structureLookbackDays: number;
  relationships: Record<string, string>;
  frames: Record<string, { status: string; role: string; reason?: string; availableAt?: number; contextDays?: number;
    bias?: string; sequence?: { bias: string; labels: Array<{ label: string }> };
    protectedPoint?: { price: number } | null;
    lastEvent?: { type: string; direction: string; at: number } | null;
    geometry?: { efficiency: number; relativeVolume: number | null; rangePosition: number | null; rSquared: number } }>;
};
export type StopSafetyContext = { structureFrames?: Record<string, unknown> | null; revision: string; symbol: string; observedAt: number; tickSize: number; bars15m: Array<Array<string | number>> };
export type PlanTerminal = { plan: Pick<StructurePlan, "id" | "symbol" | "direction" | "anchor" | "availableAt" | "observedAt" | "expiresAt" | "entry" | "stop" | "target"> & { zone?: { low: number; high: number } }; terminal: { reason: string; at: number; price: number | null; basis: string } };
export type ScanResult = { intersectionClock?: IntersectionClock | null; planTerminals?: PlanTerminal[]; planningQuote?: { bid: number; ask: number; time: number } | null; stopSafetyContext?: StopSafetyContext | null; structureContext?: StructureContext | null; structurePlans?: StructurePlan[]; symbol: string; candidates: Opportunity[]; structures: StructureObservation[]; manualZones?: ManualZone[]; rejected: Record<string, number> };
export type RecentInvalidation = {
  id: string; symbol: string; direction: Direction; reason: string; invalidatedAt: number; evidenceAt: number;
  timeframe: "4H" | "15M" | "SYSTEM"; level: number | null; observed: number | null;
  entryBand: Opportunity["entryBand"]; stop: number; target: number; netR: number;
  structure: { eventType?: "BOS" | "CHOCH" | "MSS"; qualityGrade?: string; nPatternQualified?: boolean; bosAt?: number } | null;
  auditOnly: true; orderAuthority: false;
};
export type Scan = { status: string; sourceAsOf: string; scannedSymbols: number; universe: string[]; candidates: Opportunity[]; recentInvalidations?: RecentInvalidation[]; errors: { symbol: string; reason: string }[]; results: ScanResult[];
  ownerSelectionFeed?: { status: "READY" | "UNAVAILABLE"; checkedAt: number; count: number; reason?: string } };

export type JevAssessment = {
  revision: "JEV-SMC-ASSESS-3";
  verdict: "YES" | "NO" | "WAIT";
  evidenceScore: number | null;
  estimatedProbability: number | null;
  probabilityStatus: "HEURISTIC_UNCALIBRATED" | "UNRATED_MODEL";
  confidence: number;
  marketState: "TRIGGER_CONFIRMED" | "MICRO_STRUCTURE_PENDING" | "LIQUIDITY_SWEEP_PENDING" | "VALUE_LOCATION_PENDING" | "COMPRESSION_PENDING" | "FALSE_BREAK_WATCH" | "NEAR_TRIGGER" | "APPROACHING";
  strategyImpact: "SUPPORTIVE" | "MIXED" | "ADVERSE";
  drivers: Array<{ key: string; label: string; impact: "POSITIVE" | "NEUTRAL" | "NEGATIVE"; points: number; value: string | number | boolean | null }>;
  featureVector: Record<string, string | number | boolean | null>;
  modelFeedback: { status: "FEATURE_VECTOR_READY" | "PARTIAL_EVIDENCE"; executionAuthority: false };
};
export type JevCandidate = { id: string; researchState: string; probability: number | null; probabilityStatus?: string; assessment?: JevAssessment };
export type JevObservation = { observerRevision: string; mode: "OBSERVE_ONLY"; orderAuthority: false; sourceStatus: string; candidates: JevCandidate[]; research: { frozenCount: number; promotionReviewMinimumIndependentOutcomes: number } };

export type LedgerAccount = {
  observedAt: string; fresh?: boolean; equity: number; wallet: number; available: number; unrealized: number; initialMargin: number;
  positions?: number; orders?: number; algoOrders?: number;
};
export type LedgerPosition = { planId: string; symbol: string; direction: string; quantity: number; entry: number; stop: number;
  stopPlans?: { id: string; comparison: string; triggerPrice: number; stopMode: string; stopPrice: number; status: string; expiresAt: number | null }[];
  target: number; targetSource: "STRUCTURE_PLAN" | "OWNER_OVERRIDE"; initialRiskUsdt: number; realizedNetPnl: number;
  unrealizedPnl?: number | null; openedAt: string };
export type LedgerFill = { key: string; planId: string; role: string; symbol: string; direction: string; time: number; price: number; quantity: number; commission: number; realizedPnl: number };
export type LedgerPendingEntry = { planId: string; symbol: string; direction: Direction; price: number; quantity: number;
  stop: number; target: number; initialRiskUsdt: number; grossNotionalUsdt: number; orderMode: "IMMEDIATE" | "LIMIT_GTC";
  timeInForce: "IOC" | "GTC"; status: string; createdAt: string };
export type LedgerExecution = { status: string; liveReady: boolean; entriesAllowed: boolean; exitsAllowed: boolean; manualEntriesEnabled?: boolean; infrastructureReady: boolean; strategyRuntime?: { riskPolicy: Record<string, string | number> } };

export type SmcLedger = {
  status: string; observedAt: string | null;
  snapshot: { observedAt: string; account: LedgerAccount; execution: LedgerExecution;
    priceRules: Array<{ symbol: string; tickSize: string; observedAt: string }>;
    positions: LedgerPosition[]; pendingEntries?: LedgerPendingEntry[]; fills: LedgerFill[] } | null;
  history: Array<{ observedAt: string; equity: number; wallet?: number; available?: number }>;
};

export type Feed = {
  scan: Scan | null;
  scanFailed: boolean;
  jev: JevObservation | null;
  ledger: SmcLedger | null;
  monitorFailed: boolean;
  ledgerFailed: boolean;
};
