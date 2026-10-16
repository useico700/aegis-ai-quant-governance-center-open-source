const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const ID = /^[1-9]\d{0,24}$/;
const SYMBOL = /^[A-Z]{2,12}USDT$/;
const PLAN_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const DECIMAL = /^-?\d+(?:\.\d{1,8})?$/;
const COST_POLICY_REVISION = 'S1-S2-COST-IN-RISK-C1-20260919';
const ACTIVE_S1_DISPLAY_NAME = 'R22.1 + IQ1 P1 · 4% risk · current profit lock';
const ACTIVE_S1_BASE_REVISION = 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION';
const ACTIVE_S1_EXECUTION_REVISION = 'MTFX-0.5.0-R22.1-ENTRY-PROTECTION-CONSISTENCY';
const ACTIVE_S1_ENTRY_QUALITY_REVISION = 'V2-IQ1-P1-20260915';
const ACTIVE_S1_MANAGEMENT_REVISION = 'S1-P5-ADAPTIVE-FIRST-HARVEST-1';
const ACTIVE_S1_CONFIRMATION_REVISION = 'S1-S2-ENTRY-RECONFIRM-ROOM-1';
const SIMPLE_ADMISSION_REVISION = 'S1-S2-PX-BAND-RISK-ONLY-P5-20260920';
const text = value => typeof value === 'string' ? value.slice(0, 128) : null;
const timestamp = value => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const decimal = (value, { positive = false, unsigned = false } = {}) => {
  const result = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof result !== 'string' || !DECIMAL.test(result)) return null;
  if (unsigned && result.startsWith('-')) return null;
  if (positive && Number(result) <= 0) return null;
  return result;
};
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
const eventTimestamp = value => {
  const at = typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value);
  return Number.isFinite(at) && Math.abs(at) <= 8.64e15 ? new Date(at).toISOString() : null;
};

function sanitizeCandidateSource(raw, now) {
  // A missing field is an older publisher, never evidence of an empty scan.
  if (raw == null) return null;
  const sourceTime = value => Number.isSafeInteger(value) && value > 0 && value <= now + 30000 ? value : null;
  const checkedAt = sourceTime(raw.checkedAt), observedAt = sourceTime(raw.observedAt), lastGoodAt = sourceTime(raw.lastGoodAt);
  const candidateCount = count(raw.candidateCount);
  if (!['READY', 'UNAVAILABLE'].includes(raw.state) || checkedAt === null
    || (raw.state === 'READY' && (raw.reason !== null || observedAt === null || lastGoodAt !== observedAt || candidateCount === null || candidateCount > 200))
    || (raw.state === 'UNAVAILABLE' && (!CODE.test(raw.reason ?? '') || raw.candidateCount !== null))) {
    throw new Error('S1_CANDIDATE_SOURCE_INVALID');
  }
  return { state: raw.state, reason: raw.state === 'READY' ? null : raw.reason,
    observedAt, checkedAt, candidateCount: raw.state === 'READY' ? candidateCount : null, lastGoodAt };
}

function units8(value) {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  return negative ? -result : result;
}
function decimal8(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100000000n;
  const fraction = String(absolute % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function sanitizeS1ExecutionLedger(input, now = Date.now(), { runtimeProfile = 'ACTIVE_S1' } = {}) {
  if (!input || input.accountLabel !== 'S1' || input.venue !== 'BINANCE_USDM_MAINNET') throw new Error('S1_LEDGER_SCOPE_MISMATCH');
  const observedAt = timestamp(input.observedAt);
  const observedMs = Date.parse(observedAt ?? '');
  if (!observedAt || observedMs > now + 30000 || now - observedMs > 900000) throw new Error('S1_LEDGER_SOURCE_TIME_INVALID');
  const rawExecution = input.execution ?? {};
  const status = text(rawExecution.status);
  const entryIncident = rawExecution.entryIncident == null ? null : text(rawExecution.entryIncident);
  const authorizationStatus = text(rawExecution.orderAuthorizationStatus);
  if ((status && !CODE.test(status)) || (entryIncident && !CODE.test(entryIncident)) || (authorizationStatus && !CODE.test(authorizationStatus))) throw new Error('S1_EXECUTION_STATUS_INVALID');
  const rawRuntime = rawExecution.strategyRuntime;
  let strategyRuntime = null;
  if (rawRuntime != null) {
    const risk = rawRuntime.riskPolicy;
    const management = rawRuntime.prospectiveManagementPolicy;
    const confirmation = rawRuntime.entryConfirmationPolicy;
    const activeS1 = runtimeProfile === 'ACTIVE_S1';
    const p5 = rawRuntime.entryAdmissionRevision === SIMPLE_ADMISSION_REVISION && rawRuntime.displayName === 'Px 2% · P5';
    const adapterCost = p5 || rawRuntime.displayName === 'R22.4 + IQ1 P4 + C1'
      ? rawRuntime.costPolicyRevision === COST_POLICY_REVISION
      : rawRuntime.displayName === 'R22.4 + IQ1 P4' && rawRuntime.costPolicyRevision == null;
    const r22Rollback = rawRuntime.displayName === 'R22 · S1 live risk' && rawRuntime.entryQualityPolicyRevision === 'S1-R22-ROLLBACK-20261010' && rawRuntime.pxDistanceGateEnabled === false && rawRuntime.executionRevision === ACTIVE_S1_BASE_REVISION && rawRuntime.entryQualityRevision === null && rawRuntime.managementRevision === 'R22-LEGACY' && management === null && confirmation === null;
    const paperFinal = r22Rollback || rawRuntime.displayName === 'R22.1 + IQ1 P1 · paper final · S1 live risk'
      && rawRuntime.entryQualityPolicyRevision === 'S1-IQ1-P1-PAPER-FINAL-20261010' && rawRuntime.pxDistanceGateEnabled === true
      && rawRuntime.managementRevision === 'R22-LEGACY' && management === null && confirmation === null;
    const activeValid = rawRuntime.entryAdmissionRevision == null && rawRuntime.accountLabel === 'S1' && rawRuntime.runtimeLoaded === true
      && (paperFinal || rawRuntime.displayName === ACTIVE_S1_DISPLAY_NAME)
      && rawRuntime.baseImplementationRevision === ACTIVE_S1_BASE_REVISION
        && rawRuntime.costPolicyRevision === COST_POLICY_REVISION
        && (r22Rollback || rawRuntime.executionRevision === ACTIVE_S1_EXECUTION_REVISION)
        && (r22Rollback || rawRuntime.entryQualityRevision === ACTIVE_S1_ENTRY_QUALITY_REVISION)
        && (paperFinal || (management?.revision === ACTIVE_S1_MANAGEMENT_REVISION && management.retainPeakFraction === 0.7
        && management.runnerRemainingFraction === 0.15
        && confirmation?.revision === ACTIVE_S1_CONFIRMATION_REVISION && confirmation.account === 'S1'))
        && risk?.mode === 'LIVE_PERCENT_RISK' && risk.perTradeFraction === '0.04'
        && risk.portfolioFraction === '0.10' && risk.maximumOpenPositions === 8
      && risk.maximumLeverage === 4 && risk.maximumGrossNotionalLeverage === 4
      && risk.grossNotionalMustNotExceedEquity === false && risk.effectiveMaximumGroupPositions === 2;
    const adapterValid = runtimeProfile === 'S2_ADAPTER' && rawRuntime.accountLabel === 'S1' && rawRuntime.runtimeLoaded === true
      && adapterCost && (p5 || rawRuntime.entryAdmissionRevision == null)
      && rawRuntime.executionRevision === 'MTFX-0.5.0-R22.4-PX-RIGHT-SIDE-LIVE-BAND'
      && rawRuntime.entryQualityRevision === 'S1-S2-IQ1-P4-PX-RIGHT-SIDE-LIVE-BAND-20260918'
      && risk?.mode === 'LIVE_PERCENT_RISK' && risk.perTradeFraction === '0.02'
      && risk.portfolioFraction === '0.10' && risk.maximumOpenPositions === 8
      && [4, 25].includes(risk.maximumLeverage) && risk.maximumGrossNotionalLeverage === 4
      && risk.grossNotionalMustNotExceedEquity === false && (p5 ? risk.effectiveMaximumGroupPositions === null : risk.effectiveMaximumGroupPositions === 2);
    if (activeS1 ? !activeValid : !adapterValid) {
      throw new Error('S1_EXECUTION_STRATEGY_RUNTIME_INVALID');
    }
    strategyRuntime = { displayName: rawRuntime.displayName,
      ...(activeS1 ? { baseImplementationRevision: rawRuntime.baseImplementationRevision } : {}),
      costPolicyRevision: rawRuntime.costPolicyRevision ?? null,
      entryAdmissionRevision: p5 ? SIMPLE_ADMISSION_REVISION : null,
      candidatePriorityRevision: text(rawRuntime.candidatePriorityRevision),
      maximumCompleteLifecycleCostR: rawRuntime.maximumCompleteLifecycleCostR === 0.12 ? 0.12 : null,
      executionRevision: text(rawRuntime.executionRevision), entryQualityRevision: text(rawRuntime.entryQualityRevision),
      ...(activeS1 ? { managementRevision: paperFinal ? 'R22-LEGACY' : management.revision, entryConfirmationRevision: paperFinal ? null : confirmation.revision,
        entryQualityPolicyRevision: text(rawRuntime.entryQualityPolicyRevision), pxDistanceGateEnabled: rawRuntime.pxDistanceGateEnabled !== false, portfolioProtectionRevision: text(rawRuntime.portfolioProtectionRevision) } : {}),
      runtimeLoaded: true, riskPolicy: { mode: risk.mode, perTradeFraction: risk.perTradeFraction,
        portfolioFraction: risk.portfolioFraction, maximumOpenPositions: risk.maximumOpenPositions,
        maximumLeverage: risk.maximumLeverage, maximumGrossNotionalLeverage: risk.maximumGrossNotionalLeverage,
        grossNotionalMustNotExceedEquity: false, effectiveMaximumGroupPositions: risk.effectiveMaximumGroupPositions } };
  }
  const entryBlockers = (Array.isArray(rawExecution.entryBlockers) ? rawExecution.entryBlockers : []).slice(0, 100).map(raw => {
    const planId = text(raw?.id), symbol = text(raw?.symbol), reason = text(raw?.reason);
    const classification = text(raw?.classification);
    const evaluatedAt = eventTimestamp(raw?.evaluatedAt), evaluatedMs = Date.parse(evaluatedAt ?? '');
    if (!PLAN_ID.test(planId ?? '') || !SYMBOL.test(symbol ?? '') || !CODE.test(reason ?? '')
      || !['RETRYABLE', 'CAPACITY_WAIT', 'UNCLASSIFIED'].includes(classification ?? '')
      || raw?.terminal !== false || !evaluatedAt || evaluatedMs > now + 30000 || now - evaluatedMs > 900000
      || ![null, 'LONG', 'SHORT'].includes(raw?.direction ?? null)) throw new Error('S1_ENTRY_BLOCKER_INVALID');
    return { key: `${planId}:${reason}`, planId, symbol, direction: raw.direction ?? null,
      reason, classification, evaluatedAt };
  });
  const prioritySymbols = new Set();
  const candidatePriorities = (Array.isArray(rawExecution.candidatePriorities) ? rawExecution.candidatePriorities : []).slice(0, 100).map(raw => {
    const planId = text(raw?.planId), symbol = text(raw?.symbol), reason = text(raw?.reason);
    const evaluatedAt = eventTimestamp(raw?.evaluatedAt);
    if (!PLAN_ID.test(planId ?? '') || !SYMBOL.test(symbol ?? '') || prioritySymbols.has(symbol)
      || !['LONG', 'SHORT'].includes(raw?.direction) || !['WAITING', 'SUBMITTING', 'POSITION_OPEN'].includes(raw?.state)
      || (reason && !CODE.test(reason)) || !evaluatedAt || Date.parse(evaluatedAt) > now + 30000)
      throw new Error('S1_CANDIDATE_PRIORITY_INVALID');
    prioritySymbols.add(symbol);
    return { planId, symbol, direction: raw.direction, state: raw.state, reason, evaluatedAt };
  });
  const positionStages = (Array.isArray(rawExecution.positionStages) ? rawExecution.positionStages : []).slice(0, 8).map(raw => {
    const symbol = text(raw?.symbol), direction = raw?.direction, stage = raw?.stage;
    const quantity = decimal(raw?.quantity, { positive: true, unsigned: true });
    const originalQuantity = decimal(raw?.originalQuantity, { positive: true, unsigned: true });
    const stop = decimal(raw?.stop, { positive: true, unsigned: true });
    if (!SYMBOL.test(symbol ?? '') || !['LONG', 'SHORT'].includes(direction)
      || !['INITIAL', 'SOFT', 'ONE_R', 'TAIL'].includes(stage)
      || !quantity || !originalQuantity || !stop || Number(quantity) > Number(originalQuantity)) {
      throw new Error('S1_POSITION_STAGE_INVALID');
    }
    return { symbol, direction, stage, quantity, originalQuantity, stop };
  });
  let portfolioProtection = null;
  if (rawExecution.portfolioProtection != null) {
    const p = rawExecution.portfolioProtection;
    if (p.revision !== 'V2-R21-ENTRY-CONSISTENCY-1' || typeof p.evidenceHold !== 'boolean'
      || !Array.isArray(p.campaigns) || p.campaigns.length !== 2
      || new Set(p.campaigns.map(c => c.direction)).size !== 2) throw new Error('S1_PORTFOLIO_PROTECTION_INVALID');
    const campaigns = p.campaigns.map(c => {
      if (!['LONG','SHORT'].includes(c.direction) || typeof c.active !== 'boolean'
        || !Number.isInteger(c.positionCount) || c.positionCount < 0 || c.positionCount > 8
        || ![c.highWaterPnlUsdt,c.markedPnlUsdt,c.drawdownFraction].every(Number.isFinite)
        || c.highWaterPnlUsdt < 0 || c.drawdownFraction < 0
        || !['IDLE','ARMED','WARNING','DEFENSE','HARD'].includes(c.entryProtectionTier)
        || !['WARMUP','PERSISTENT','WEAK','SHOCK'].includes(c.regime)
        || (c.freezeUntil != null && !Number.isFinite(c.freezeUntil))) throw new Error('S1_PORTFOLIO_PROTECTION_INVALID');
      return { direction:c.direction,active:c.active,positionCount:c.positionCount,
        highWaterPnlUsdt:c.highWaterPnlUsdt,markedPnlUsdt:c.markedPnlUsdt,drawdownFraction:c.drawdownFraction,
        entryProtectionTier:c.entryProtectionTier,regime:c.regime,freezeUntil:eventTimestamp(c.freezeUntil) };
    });
    portfolioProtection = { revision:p.revision,evidenceHold:p.evidenceHold,evaluatedAt:eventTimestamp(p.evaluatedAt),
      holdReasons:(Array.isArray(p.holdReasons)?p.holdReasons:[]).slice(0,30).map(x=>text(x)),campaigns };
  }
  const execution = {
    observedAt,
    service: rawExecution.service === 'aegis-s1-execution' ? rawExecution.service : null,
    mode: ['LIVE', 'OBSERVE'].includes(rawExecution.mode) ? rawExecution.mode : null,
    status,
    infrastructureReady: rawExecution.infrastructureReady === true,
    realOrdersAllowed: rawExecution.realOrdersAllowed === true,
    entriesAllowed: rawExecution.entriesAllowed === true,
    liveReady: rawExecution.liveReady === true,
    orderAuthorizationStatus: authorizationStatus,
    entryIncident,
    entryBlockers,
    portfolioProtection,
    candidatePriorities,
    candidateSource: sanitizeCandidateSource(rawExecution.candidateSource, now),
    positionStages,
    openPositions: count(rawExecution.openPositions),
    openOrders: count(rawExecution.openOrders),
    openAlgoOrders: count(rawExecution.openAlgoOrders),
    strategyRuntime,
  };
  const seen = new Set();
  const attribution = ['OWNER_DIRECTED_TEST', 'STRATEGY', 'EXTERNAL_UNATTRIBUTED'].includes(input.attribution)
    ? input.attribution : 'EXTERNAL_UNATTRIBUTED';
  const fills = (Array.isArray(input.fills) ? input.fills : []).slice(0, 100).map(raw => {
    const tradeId = String(raw?.tradeId ?? raw?.id ?? ''), orderId = String(raw?.orderId ?? '');
    const symbol = text(raw?.symbol), positionSide = raw?.positionSide ?? raw?.direction;
    const quantity = decimal(raw?.quantity ?? raw?.qty, { positive: true, unsigned: true });
    const price = decimal(raw?.price, { positive: true, unsigned: true });
    const commission = decimal(raw?.commission ?? raw?.fee, { unsigned: true });
    const realizedPnlUsdt = decimal(raw?.realizedPnlUsdt ?? raw?.realizedPnl);
    const time = Number(raw?.time);
    if (!ID.test(tradeId) || !ID.test(orderId) || !SYMBOL.test(symbol ?? '') || !['LONG', 'SHORT', 'BOTH'].includes(positionSide)
      || !['BUY', 'SELL'].includes(raw?.side) || !quantity || !price || commission == null || realizedPnlUsdt == null
      || raw?.feeAsset !== 'USDT' && raw?.commissionAsset !== 'USDT'
      || !Number.isSafeInteger(time) || time <= 0 || time > now + 30000 || now - time > 90 * 86400000) throw new Error('S1_FILL_INVALID');
    const key = `${symbol}:${tradeId}`;
    if (seen.has(key)) throw new Error('S1_FILL_DUPLICATE');
    seen.add(key);
    return { key, tradeId, orderId, symbol, positionSide, side: raw.side, quantity, price, commission,
      feeAsset: 'USDT', realizedPnlUsdt, netPnlUsdt: decimal8(units8(realizedPnlUsdt) - units8(commission)), time, attribution,
      attemptId: typeof raw?.attemptId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.attemptId) ? raw.attemptId : null };
  });
  const filteredCandidates = (Array.isArray(input.filteredCandidates) ? input.filteredCandidates : []).slice(0, 100).map(raw => {
    const planId = text(raw?.id), symbol = text(raw?.symbol), reason = text(raw?.reason);
    const replacementPlanId = raw?.replacementPlanId == null ? null : text(raw.replacementPlanId);
    const evaluatedAt = eventTimestamp(raw?.evaluatedAt), evaluatedMs = Date.parse(evaluatedAt ?? '');
    const intersectionTime = raw?.intersectionTime == null ? null : eventTimestamp(raw.intersectionTime);
    const intersectionPrice = typeof raw?.intersectionPrice === 'number' && Number.isFinite(raw.intersectionPrice) && raw.intersectionPrice > 0
      ? raw.intersectionPrice : null;
    if (!PLAN_ID.test(planId ?? '') || !SYMBOL.test(symbol ?? '') || !CODE.test(reason ?? '')
      || !['SIGNAL_CONFIRMATION', 'EXECUTION_GATE', 'CANDIDATE_LIFECYCLE'].includes(raw?.stage) || raw?.terminal !== true
      || !evaluatedAt || evaluatedMs > now + 30000 || now - evaluatedMs > 30 * 86400000
      || ![null, 'LONG', 'SHORT'].includes(raw?.direction ?? null) || raw?.intersectionTime != null && !intersectionTime
      || replacementPlanId !== null && !PLAN_ID.test(replacementPlanId)) {
      throw new Error('S1_FILTERED_CANDIDATE_INVALID');
    }
    return { key: `${planId}:${reason}`, planId, symbol, direction: raw.direction ?? null, stage: raw.stage,
      reason, evaluatedAt, intersectionTime, intersectionPrice,
      ...(replacementPlanId === null ? {} : { replacementPlanId }) };
  });
  return { schemaVersion: 1, accountLabel: 'S1', venue: 'BINANCE_USDM_MAINNET', observedAt, execution, filteredCandidates, fills };
}

export function summarizeS1Fills(fills) {
  let commission = 0n, realized = 0n;
  for (const row of Array.isArray(fills) ? fills : []) {
    const fee = decimal(row?.commission, { unsigned: true });
    const pnl = decimal(row?.realizedPnlUsdt);
    if (fee == null || pnl == null) continue;
    commission += units8(fee); realized += units8(pnl);
  }
  return { fillCount: Array.isArray(fills) ? fills.length : 0,
    commissionUsdt: decimal8(commission), realizedPnlUsdt: decimal8(realized), netPnlUsdt: decimal8(realized - commission) };
}
