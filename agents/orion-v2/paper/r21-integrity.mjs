// V2-only R21 accounting/evidence repair. No exchange, persistence or execution I/O.
import { R21_ELIGIBLE_SYMBOLS, R21_EXCLUDED_SYMBOLS } from "../../shared/r21-profit-protection.mjs";

export const V2_R21_INTEGRITY_REVISION = "V2-R21-INTEGRITY-1";
export const V2_R21_ENTRY_CONSISTENCY_REVISION = "V2-R21-ENTRY-CONSISTENCY-1";
const DIRECTIONS = [["LONG", 1], ["SHORT", -1]];
const RANK = { IDLE: 0, ARMED: 1, WARNING: 2, DEFENSE: 3, HARD: 4 };
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0;
const clone = (value) => structuredClone(value);
const identifier = (value) => typeof value === "string" && value.length > 0;
const updateId = (value) => /^(0|[1-9]\d*)$/.test(String(value)) ? BigInt(value) : null;
const emptyCampaign = (freezeUntil = null) => ({ id: null, startedAt: null, active: false, tier: "IDLE",
  highWaterPnlUsdt: 0, markedPnlUsdt: 0, drawdownFraction: 0, regime: "WARMUP", positionCount: 0,
  freezeUntil, members: {} });

function settings(config = {}) {
  const eligibleSymbols = (config.eligibleSymbols ?? R21_ELIGIBLE_SYMBOLS)
    .filter((symbol) => !(config.excludedSymbols ?? R21_EXCLUDED_SYMBOLS).includes(symbol));
  const maximumQuoteAgeMs = config.maximumQuoteAgeMs ?? 1000;
  const quoteSampleIntervalMs = config.quoteSampleIntervalMs ?? 60_000;
  const result = { eligibleSymbols, maximumQuoteAgeMs, maximumQuoteSkewMs: config.maximumQuoteSkewMs ?? 1000,
    quoteSampleIntervalMs, maximumSampleGapMs: config.maximumSampleGapMs ?? quoteSampleIntervalMs * 2 + maximumQuoteAgeMs * 2,
    shockLookbackMs: config.shockLookbackMs ?? 180_000,
    minimumSameDirectionPositions: config.minimumSameDirectionPositions ?? 3,
    armProfitFractionOfEquity: config.armProfitFractionOfEquity ?? 0.015,
    armProfitMultipleOfInitialRisk: config.armProfitMultipleOfInitialRisk ?? 2,
    normalThresholds: config.normalThresholds ?? { warning: 0.2, defense: 0.3, hard: 0.4 },
    weakThresholds: config.weakThresholds ?? { warning: 0.15, defense: 0.25, hard: 0.35 },
    trendBreadthMinimumFraction: config.trendBreadthMinimumFraction ?? 0.625,
    shockMinimumObservedSymbols: config.shockMinimumObservedSymbols ?? 6,
    shockMinimumAdverseSymbols: config.shockMinimumAdverseSymbols ?? 6,
    shockMedianReturnFraction: config.shockMedianReturnFraction ?? -0.02,
    freezeMs: config.freezeMs ?? 900_000,
    initialDefenseReductionFractionOfOriginal: config.initialDefenseReductionFractionOfOriginal ?? 0.25 };
  if (!eligibleSymbols.length || new Set(eligibleSymbols).size !== eligibleSymbols.length
    || ![result.maximumQuoteAgeMs, result.maximumQuoteSkewMs, result.quoteSampleIntervalMs,
      result.maximumSampleGapMs, result.shockLookbackMs].every(positive)) throw new Error("V2_R21_CONFIGURATION_INVALID");
  return result;
}

function seed(prior, now) {
  if (prior?.schemaVersion === 2) {
    if (prior.revision !== V2_R21_INTEGRITY_REVISION || !Array.isArray(prior.samples)
      || !Array.isArray(prior.completedCampaigns) || !prior.campaigns) throw new Error("V2_R21_STATE_INVALID");
    for (const [label] of DIRECTIONS) {
      const campaign = prior.campaigns[label];
      if (!campaign?.members || !Object.hasOwn(RANK, campaign.tier)
        || !finite(campaign.highWaterPnlUsdt)) throw new Error("V2_R21_CAMPAIGN_INVALID");
    }
    return clone(prior);
  }
  if (prior && prior.schemaVersion !== 1) throw new Error("V2_R21_SCHEMA_UNSUPPORTED");
  return { schemaVersion: 2, revision: V2_R21_INTEGRITY_REVISION,
    activatedAt: prior?.activatedAt ?? now, initializedAt: null, lastEvaluatedAt: null, lastAcceptedAt: null,
    samples: [], lastSampleAt: null, connectionEpoch: null, lastQuoteEvidence: {},
    evidenceHold: true, holdReasons: ["WAITING_FIRST_COMPLETE_FRESH_FRAME"], completedCampaigns: [],
    migration: { fromSchemaVersion: prior?.schemaVersion ?? null, status: "WAITING_FIRST_COMPLETE_FRESH_FRAME",
      priorCampaigns: clone(prior?.campaigns ?? null), appliedAt: null, retrospectiveActionsAllowed: false },
    campaigns: Object.fromEntries(DIRECTIONS.map(([label]) => [label, {
      ...emptyCampaign(prior?.campaigns?.[label]?.freezeUntil ?? null),
      ...(prior?.campaigns?.[label] ?? {}), members: {},
    }])) };
}

export function validateV2R21QuoteFrame({ quotes, now, localNow, connectionEpoch, priorQuotes = {}, config = {} }) {
  const policy = settings(config);
  const reasons = [];
  const evidence = {};
  if (!positive(now) || !positive(localNow)) reasons.push("DECISION_CLOCK_INVALID");
  if (connectionEpoch?.connected !== true || !identifier(connectionEpoch?.id)
    || !positive(connectionEpoch?.connectedAt) || connectionEpoch.connectedAt > localNow) reasons.push("CONNECTION_EPOCH_INVALID");
  for (const symbol of policy.eligibleSymbols) {
    const q = quotes?.[symbol];
    if (!q) { reasons.push(`${symbol}:QUOTE_MISSING`); continue; }
    evidence[symbol] = { bid: q.bid ?? null, ask: q.ask ?? null, marketTime: q.marketTime ?? null,
      receivedAt: q.receivedAt ?? null, updateId: q.updateId == null ? null : String(q.updateId),
      connectionEpoch: q.connectionEpoch ?? null, marketTimeSource: q.marketTimeSource ?? null };
    if (q.marketTimeSource === "LOCAL_FALLBACK") reasons.push(`${symbol}:EXCHANGE_TIMESTAMP_MISSING`);
    if (!positive(q.bid) || !positive(q.ask) || q.ask < q.bid) reasons.push(`${symbol}:QUOTE_PRICE_INVALID`);
    if (!positive(q.marketTime) || !positive(q.receivedAt) || updateId(q.updateId) == null) {
      reasons.push(`${symbol}:QUOTE_TIME_OR_UPDATE_ID_MISSING`); continue;
    }
    if (!identifier(q.connectionEpoch) || q.connectionEpoch !== connectionEpoch?.id
      || q.receivedAt < connectionEpoch?.connectedAt) reasons.push(`${symbol}:QUOTE_CONNECTION_EPOCH_MISMATCH`);
    if (q.marketTime > now || q.receivedAt > localNow) reasons.push(`${symbol}:QUOTE_FROM_FUTURE`);
    if (now - q.marketTime > policy.maximumQuoteAgeMs || localNow - q.receivedAt > policy.maximumQuoteAgeMs) reasons.push(`${symbol}:QUOTE_STALE`);
    const prior = priorQuotes[symbol];
    if (prior && prior.connectionEpoch === q.connectionEpoch) {
      if (q.marketTime < prior.marketTime || updateId(q.updateId) < updateId(prior.updateId)) reasons.push(`${symbol}:QUOTE_REGRESSED`);
      if (updateId(q.updateId) === updateId(prior.updateId)
        && (q.marketTime !== prior.marketTime || q.bid !== prior.bid || q.ask !== prior.ask)) reasons.push(`${symbol}:QUOTE_UPDATE_EQUIVOCATION`);
    }
  }
  const times = Object.values(evidence).map((q) => q.marketTime).filter(positive);
  const receipts = Object.values(evidence).map((q) => q.receivedAt).filter(positive);
  const marketSkewMs = times.length ? Math.max(...times) - Math.min(...times) : null;
  const receiptSkewMs = receipts.length ? Math.max(...receipts) - Math.min(...receipts) : null;
  if (marketSkewMs > policy.maximumQuoteSkewMs || receiptSkewMs > policy.maximumQuoteSkewMs) reasons.push("CROSS_SYMBOL_QUOTE_SKEW");
  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)], quotes: evidence,
    marketSkewMs, receiptSkewMs, sourceMarketTime: times.length ? Math.max(...times) : null, policy };
}

function completedCampaign(campaign, now) {
  const members = Object.values(campaign.members);
  const finalNetPnlUsdt = members.reduce((sum, member) => sum + member.lastNetPnlUsdt, 0);
  return { id: campaign.id, startedAt: campaign.startedAt, endedAt: now, finalNetPnlUsdt,
    highWaterPnlUsdt: campaign.active ? Math.max(campaign.highWaterPnlUsdt, finalNetPnlUsdt) : campaign.highWaterPnlUsdt,
    memberCount: members.length, closedMemberIds: members.map((member) => member.id) };
}

function reconcileMembers(state, positions, closedPositions, now, quotes) {
  const reasons = [];
  const closed = new Map();
  for (const row of closedPositions) {
    if (identifier(row?.id)) closed.set(row.id, [...(closed.get(row.id) ?? []), row]);
  }
  const matchedClosures = [];
  const unobservedClosures = [];
  const excludedClosures = [];
  for (const [label, direction] of DIRECTIONS) {
    let campaign = state.campaigns[label];
    const group = positions.filter((position) => position.direction === direction);
    const openIds = new Set(group.map((position) => position.id));
    for (const member of Object.values(campaign.members)) {
      const stillOpen = openIds.has(member.id);
      const matches = closed.get(member.id) ?? [];
      if (member.status === "CLOSED") {
        if (stillOpen) reasons.push(`${member.id}:CLOSED_MEMBER_REOPENED`);
        if (matches.length && (matches.length !== 1 || matches[0].cumulativeRealizedNetPnl !== member.lastNetPnlUsdt
          || matches[0].closedAt !== member.closedAt || matches[0].symbol !== member.symbol
          || matches[0].direction !== direction
          || (matches[0].openedAt != null && member.openedAt != null && matches[0].openedAt !== member.openedAt))) reasons.push(`${member.id}:CLOSED_EVIDENCE_CHANGED`);
        continue;
      }
      if (stillOpen) {
        if (matches.length) reasons.push(`${member.id}:MEMBER_BOTH_OPEN_AND_CLOSED`);
        continue;
      }
      const row = matches[0];
      if (matches.length !== 1 || row.symbol !== member.symbol || row.direction !== direction
        || (row.openedAt != null && member.openedAt != null && row.openedAt !== member.openedAt)
        || !finite(row.cumulativeRealizedNetPnl) || !positive(row.closedAt)
        || row.closedAt < (member.openedAt ?? member.firstObservedQuoteAt ?? member.joinedAt) || row.closedAt > now) {
        reasons.push(`${member.id}:MISSING_OR_INVALID_MEMBER_SETTLEMENT`); continue;
      }
      campaign.members[member.id] = { ...member, status: "CLOSED", lastNetPnlUsdt: row.cumulativeRealizedNetPnl, closedAt: row.closedAt };
      matchedClosures.push(clone(row));
    }
    // A real lifecycle may open and settle between scans. Admit only terminal evidence
    // connected to this already-observed episode; never import arbitrary closed history.
    if (campaign.id) {
      let coveredUntil = Math.max(campaign.startedAt, ...Object.values(campaign.members)
        .map((member) => member.status === "OPEN" && openIds.has(member.id) ? now : member.closedAt ?? campaign.startedAt));
      const candidates = [];
      for (const [id, matches] of closed) {
        if (campaign.members[id] || openIds.has(id)) continue;
        const row = matches[0];
        if (row.direction !== direction || !state.eligibleSymbols.includes(row.symbol)
          || !positive(row.closedAt) || row.closedAt < campaign.startedAt) continue;
        if (matches.length !== 1 || !positive(row.openedAt) || !finite(row.cumulativeRealizedNetPnl)
          || row.openedAt > row.closedAt || row.closedAt > now) {
          reasons.push(`${id}:UNOBSERVED_LIFECYCLE_EVIDENCE_INVALID`); continue;
        }
        if (row.openedAt < campaign.startedAt) {
          excludedClosures.push({ id, reason: "ENTRY_PRECEDES_CAMPAIGN_BASELINE" }); continue;
        }
        candidates.push({ ...row, candidateType: "CLOSED" });
      }
      for (const row of group) if (!campaign.members[row.id]) candidates.push({ ...row, candidateType: "OPEN",
        openedAt: positive(row.openedAt) ? row.openedAt : quotes[row.symbol]?.marketTime });
      candidates.sort((left, right) => left.openedAt - right.openedAt);
      for (const row of candidates) {
        if (row.openedAt > coveredUntil) {
          if (row.candidateType === "CLOSED") excludedClosures.push({ id: row.id, reason: "NO_CONTINUOUS_CAMPAIGN_OVERLAP" });
          continue;
        }
        coveredUntil = Math.max(coveredUntil, row.candidateType === "OPEN" ? now : row.closedAt);
        if (row.candidateType === "CLOSED") {
          campaign.members[row.id] = { id: row.id, symbol: row.symbol, direction, openedAt: row.openedAt,
            joinedAt: now, firstObservedQuoteAt: null, status: "CLOSED", closedAt: row.closedAt,
            lastNetPnlUsdt: row.cumulativeRealizedNetPnl, admission: "COMPLETE_UNOBSERVED_LIFECYCLE_SETTLEMENT_ONLY" };
          const settlement = clone(row);
          delete settlement.candidateType;
          unobservedClosures.push(settlement);
        }
      }
      // A proven flat gap ends the old episode. Do not attach a later newly-open
      // position to its HWM merely because both appeared in one scan interval.
      const priorMembers = Object.values(campaign.members);
      if (group.length && priorMembers.length && priorMembers.every((member) => member.status === "CLOSED")
        && group.every((row) => positive(row.openedAt) && row.openedAt > coveredUntil)) {
        state.completedCampaigns = [...state.completedCampaigns, completedCampaign(campaign, coveredUntil)].slice(-32);
        campaign = emptyCampaign(campaign.freezeUntil);
        state.campaigns[label] = campaign;
      }
    }
    if (group.length && !campaign.id) {
      campaign.id = `v2-r21:${label}:${now}`;
      campaign.startedAt = now;
    }
    for (const row of group) {
      const prior = campaign.members[row.id];
      if (prior && (prior.symbol !== row.symbol || prior.direction !== direction)) reasons.push(`${row.id}:MEMBER_IDENTITY_CHANGED`);
      if (!prior && closed.has(row.id)) reasons.push(`${row.id}:MEMBER_BOTH_OPEN_AND_CLOSED`);
      const openedAt = positive(row.openedAt) ? row.openedAt : prior?.openedAt ?? quotes[row.symbol]?.marketTime;
      if (!positive(openedAt) || openedAt > now || (prior?.openedAt != null && openedAt !== prior.openedAt)) reasons.push(`${row.id}:MEMBER_OPEN_TIME_INVALID`);
      campaign.members[row.id] = { id: row.id, symbol: row.symbol, direction, openedAt,
        firstObservedQuoteAt: prior?.firstObservedQuoteAt ?? quotes[row.symbol]?.marketTime,
        joinedAt: prior?.joinedAt ?? now, status: "OPEN", closedAt: null, lastNetPnlUsdt: row.markedNetPnlUsdt };
    }
    if (Object.keys(campaign.members).length > 512) reasons.push(`${label}:CAMPAIGN_MEMBER_CAPACITY`);
  }
  return { reasons, matchedClosures, unobservedClosures, excludedClosures };
}

function advanceSamples(state, frame, now, policy, continuityBroken) {
  const source = frame.sourceMarketTime;
  if (continuityBroken || (state.lastAcceptedAt != null && now - state.lastAcceptedAt > policy.maximumSampleGapMs)) {
    state.samples = []; state.lastSampleAt = null;
  }
  if (state.lastSampleAt == null || source - state.lastSampleAt >= policy.quoteSampleIntervalMs) {
    if (state.lastSampleAt != null && source - state.lastSampleAt > policy.maximumSampleGapMs) state.samples = [];
    state.samples.push({ at: source, prices: Object.fromEntries(Object.entries(frame.quotes).map(([symbol, quote]) => [symbol, (quote.bid + quote.ask) / 2])) });
    state.samples = state.samples.filter((sample) => source - sample.at <= policy.shockLookbackMs * 2 + policy.maximumSampleGapMs);
    state.lastSampleAt = source;
  }
  const latest = state.samples.at(-1);
  const anchor = [...state.samples].reverse().find((sample) => sample.at <= latest.at - policy.shockLookbackMs);
  const returns = anchor ? Object.fromEntries(policy.eligibleSymbols.map((symbol) => [symbol, latest.prices[symbol] / anchor.prices[symbol] - 1])) : {};
  return { complete: Boolean(anchor), from: anchor?.at ?? null, to: latest.at,
    durationMs: anchor ? latest.at - anchor.at : null, samples: clone(state.samples), returns };
}

function response(state, evidence, actions, now) {
  const frozenDirections = state.evidenceHold ? [1, -1] : DIRECTIONS
    .filter(([label]) => finite(state.campaigns[label].freezeUntil) && state.campaigns[label].freezeUntil > now)
    .map(([, direction]) => direction);
  state.freezeEligibleEntries = frozenDirections.length > 0;
  state.frozenDirections = frozenDirections;
  return { state, actions, frozenDirections, freezeEligibleEntries: frozenDirections.length > 0, evidence };
}

export function evaluateV2R21ProfitProtection({ priorState, positions, closedPositions, quotes, equityUsdt,
  now, localNow, connectionEpoch, clockEvidence = null, config = {} }) {
  const policy = settings(config);
  const original = seed(priorState, now);
  const frame = validateV2R21QuoteFrame({ quotes, now, localNow, connectionEpoch, priorQuotes: original.lastQuoteEvidence, config });
  const reasons = [...frame.reasons];
  if (clockEvidence != null) {
    const { serverTime, requestLocalAt, responseLocalAt, uncertaintyMs } = clockEvidence;
    if (![serverTime, requestLocalAt, responseLocalAt].every(positive) || !finite(uncertaintyMs)
      || responseLocalAt < requestLocalAt || localNow < responseLocalAt
      || uncertaintyMs !== responseLocalAt - requestLocalAt || uncertaintyMs > policy.maximumQuoteAgeMs
      || now !== serverTime + (localNow - requestLocalAt)) reasons.push("DECISION_CLOCK_MEASUREMENT_INVALID");
  }
  if (!Array.isArray(positions) || !Array.isArray(closedPositions)) reasons.push("POSITION_COLLECTION_MISSING");
  const eligible = (Array.isArray(positions) ? positions : []).filter((row) => policy.eligibleSymbols.includes(row?.symbol));
  const ids = new Set();
  for (const row of eligible) {
    if (!identifier(row.id) || ids.has(row.id) || ![1, -1].includes(row.direction)
      || !finite(row.markedNetPnlUsdt) || !positive(row.initialRiskUsdt) || typeof row.initialStage !== "boolean") reasons.push("POSITION_IDENTITY_OR_VALUATION_INVALID");
    ids.add(row.id);
  }
  if (!positive(equityUsdt)) reasons.push("EQUITY_INVALID");
  if (original.lastEvaluatedAt != null && now < original.lastEvaluatedAt) reasons.push("DECISION_CLOCK_REGRESSED");
  const firstFrame = original.initializedAt == null;
  const state = clone(original);
  state.eligibleSymbols = [...policy.eligibleSymbols];
  if (firstFrame) state.campaigns = Object.fromEntries(DIRECTIONS.map(([label]) => [label, emptyCampaign(original.campaigns[label].freezeUntil)]));
  const reconciliation = reconcileMembers(state, eligible, Array.isArray(closedPositions) ? closedPositions : [], now, frame.quotes);
  reasons.push(...reconciliation.reasons);
  const evidence = { revision: V2_R21_INTEGRITY_REVISION, entryConsistencyRevision: V2_R21_ENTRY_CONSISTENCY_REVISION,
    evaluatedAt: now, localEvaluatedAt: localNow,
    accepted: reasons.length === 0, reasons: [...new Set(reasons)], policy: clone(policy),
    connectionEpoch: clone(connectionEpoch ?? null), clockEvidence: clone(clockEvidence), quotes: frame.quotes,
    marketSkewMs: frame.marketSkewMs, receiptSkewMs: frame.receiptSkewMs,
    equityUsdt, positions: clone(eligible), matchedClosures: reconciliation.matchedClosures,
    unobservedClosures: reconciliation.unobservedClosures, excludedClosures: reconciliation.excludedClosures,
    firstFreshBaseline: firstFrame, priorCampaigns: clone(original.campaigns), campaigns: {} };
  if (reasons.length) {
    original.evidenceHold = true; original.holdReasons = evidence.reasons;
    original.samples = []; original.lastSampleAt = null;
    if (positive(now) && (original.lastEvaluatedAt == null || now >= original.lastEvaluatedAt)) original.lastEvaluatedAt = now;
    evidence.status = "EVIDENCE_HOLD";
    return response(original, evidence, [], now);
  }
  const continuityBroken = original.evidenceHold || original.connectionEpoch?.id !== connectionEpoch.id;
  evidence.continuityBroken = continuityBroken;
  evidence.breadth = advanceSamples(state, frame, now, policy, continuityBroken);
  const actions = [];
  for (const [label, direction] of DIRECTIONS) {
    const group = eligible.filter((row) => row.direction === direction);
    const campaign = state.campaigns[label];
    const members = Object.values(campaign.members);
    const pnl = members.reduce((sum, member) => sum + member.lastNetPnlUsdt, 0);
    const initialRisk = group.reduce((sum, row) => sum + row.initialRiskUsdt, 0);
    const enoughPositions = group.length >= policy.minimumSameDirectionPositions;
    const armByEquity = pnl >= equityUsdt * policy.armProfitFractionOfEquity;
    const armByRisk = initialRisk > 0 && pnl >= initialRisk * policy.armProfitMultipleOfInitialRisk;
    campaign.positionCount = group.length;
    campaign.markedPnlUsdt = pnl;
    if (campaign.id && group.length === 0) {
      const completed = completedCampaign(campaign, now);
      state.completedCampaigns = [...state.completedCampaigns, completed].slice(-32);
      evidence.campaigns[label] = { ...clone(campaign), ended: true, completion: completed };
      state.campaigns[label] = emptyCampaign(campaign.freezeUntil);
      continue;
    }
    if (!campaign.active && enoughPositions && (armByEquity || armByRisk)) campaign.active = true;
    if (campaign.active) campaign.highWaterPnlUsdt = Math.max(campaign.highWaterPnlUsdt, pnl);
    const high = campaign.highWaterPnlUsdt;
    campaign.drawdownFraction = high > 0 ? Math.max(0, (high - pnl) / high) : 0;
    const directional = Object.values(evidence.breadth.returns).map((value) => direction * value);
    const positiveBreadth = directional.filter((value) => value > 0).length;
    const sorted = [...directional].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    const median = sorted.length ? sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2 : null;
    const weak = evidence.breadth.complete && directional.length >= policy.minimumSameDirectionPositions
      && positiveBreadth / directional.length < policy.trendBreadthMinimumFraction;
    const shock = evidence.breadth.complete && directional.length >= policy.shockMinimumObservedSymbols
      && directional.filter((value) => value <= policy.shockMedianReturnFraction).length >= policy.shockMinimumAdverseSymbols
      && median <= policy.shockMedianReturnFraction;
    const thresholds = weak || shock ? policy.weakThresholds : policy.normalThresholds;
    campaign.regime = shock ? "SHOCK" : weak ? "WEAK" : evidence.breadth.complete ? "PERSISTENT" : "WARMUP";
    // Once armed, entry protection follows profit pressure even with one/two
    // members left. The original three-position condition still gates exits.
    campaign.entryProtectionTier = !campaign.active ? "IDLE"
      : campaign.drawdownFraction >= thresholds.hard ? "HARD"
        : campaign.drawdownFraction >= thresholds.defense ? "DEFENSE"
          : campaign.drawdownFraction >= thresholds.warning ? "WARNING" : "ARMED";
    if (enoughPositions) campaign.tier = campaign.entryProtectionTier;
    if (group.length > 0 && RANK[campaign.entryProtectionTier] >= RANK.WARNING && !firstFrame) campaign.freezeUntil = Math.max(campaign.freezeUntil ?? 0, now + policy.freezeMs);
    if (!firstFrame && enoughPositions) {
      for (const position of group.filter((row) => row.initialStage)) {
        if (campaign.tier === "HARD") actions.push({ type: "CLOSE_INITIAL", symbol: position.symbol,
          positionId: position.id, direction, campaignId: campaign.id, actionId: `${campaign.id}:${position.id}:CLOSE_INITIAL` });
        else if (campaign.tier === "DEFENSE" && position.r21DefenseReductionTaken !== true) actions.push({ type: "REDUCE_INITIAL", symbol: position.symbol,
          positionId: position.id, direction, fractionOfOriginal: policy.initialDefenseReductionFractionOfOriginal,
          campaignId: campaign.id, actionId: `${campaign.id}:${position.id}:REDUCE_INITIAL` });
      }
    }
    campaign.updatedAt = now;
    evidence.campaigns[label] = { ...clone(campaign), initialRiskUsdt: initialRisk,
      armByEquity, armByRisk, enoughPositions, thresholds: clone(thresholds), positiveBreadth,
      breadthObservedSymbols: directional.length, medianDirectionalReturn: median,
      actionSuppressedReason: firstFrame ? "FIRST_FRESH_BASELINE_NO_RETROSPECTIVE_ACTION" : !enoughPositions ? "FEWER_THAN_THREE_OPEN_POSITIONS" : null };
  }
  if (firstFrame) {
    state.initializedAt = now;
    state.migration.status = "FIRST_FRESH_BASELINE_ESTABLISHED_NO_RETROSPECTIVE_ACTION";
    state.migration.appliedAt = now;
  }
  state.lastEvaluatedAt = now; state.lastAcceptedAt = now;
  state.entryConsistencyRevision = V2_R21_ENTRY_CONSISTENCY_REVISION;
  state.connectionEpoch = clone(connectionEpoch); state.lastQuoteEvidence = frame.quotes;
  state.evidenceHold = false; state.holdReasons = [];
  evidence.status = firstFrame ? "FIRST_FRESH_BASELINE" : "FRESH_ACCOUNTING_EVIDENCE_ACCEPTED";
  return response(state, evidence, actions, now);
}
