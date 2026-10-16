import { buildEntryLossContext, entryConfirmationCommitIdentity } from '../../shared/entry-loss-context.mjs';
import { rankSameSymbolCandidates } from '../../shared/candidate-proximity.mjs';
import { hasUnsafeVenueIdentifier } from '../../../lib/exchange-json.mjs';
import { units, decimal, align, freshRules } from '../../../lib/s1-precision.mjs';
import { prepareEntry } from './entry-plan.mjs';
import { reconcileAccount } from './reconcile.mjs';
import { positionConflictDecision, pendingOwnedStopHistoryPlans } from './lifecycle.mjs';
import { fresh, invariant, terminal, clientId, hash } from './common.mjs';
import { isR21EligibleSymbol } from '../../shared/r21-profit-protection.mjs';
import { isOwnedEntryCancellation, validateImmediateInitialProtection, validateOwnedMutation } from './owned-mutation.mjs';
import { activePositionQuarantine, absentPreDispatchEntryRecovered, absentCloseRecovered, ownedEntryRecovered, protectionOnlyRecovered } from './recovery-state.mjs';
import { entryAdmissionRecord } from '../../shared/live-entry-admission.mjs';
import { reconcileClosedStopAbsence } from './closed-stop-reconciliation.mjs';
import { structureCommitIdentity } from './signal-adapter.mjs';
import { configureConditionalStop, runConditionalStops } from './conditional-stops.mjs';

const incidentCode = error => typeof error?.message === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.message) ? error.message : 'POSITION_OPERATION_FAILED';
const quarantinePrefix = 'positionQuarantine:';
const rejectedEvaluation = entryAdmissionRecord;
const RETRYABLE_SCHEDULING_ERRORS = new Set(['READ_BUDGET_LOCAL_WEIGHT', 'READ_BUDGET_IP_HEADROOM',
  'READ_BUDGET_CONCURRENCY', 'READ_BUDGET_COOLING_DOWN', 'READ_DISPATCH_DEADLINE',
  'ACCOUNT_READ_TOO_SLOW', 'READ_BUDGET_BATCH_EXPIRED',
  'ORDER_BUDGET_EXHAUSTED', 'ORDER_BUDGET_COOLING_DOWN',
  'COORDINATED_READ_NOT_READY', 'COORDINATED_READ_DEFERRED',
  // These are optimistic pre-submit snapshot conflicts. No order has been sent;
  // retry a fresh fanout instead of permanently quarantining a healthy leg.
  // Durable account-activity reconciliation remains the authority for actual
  // external orders, fills, quantity changes and ownership ambiguity.
  'ACCOUNT_CHANGED_DURING_SUBMISSION_READ', 'SUBMISSION_REUSED_PRE_GATE_SNAPSHOT',
  'SUBMISSION_ACCOUNT_STALE', 'PROTECTIVE_ALGO_STATUS_DEFERRED',
  'REDUCTION_VENUE_FLAT_RECONCILE_REQUIRED']);
const managementRuleReady = rule => rule?.marketLot
  && [rule.marketLot.min, rule.marketLot.step].every(value => typeof value === 'string' && Number(value) > 0);
const planHasStructureTarget = plan => Number.isFinite(Number(plan?.targetPrice)) && Number(plan.targetPrice) > 0
  && plan?.managementMode === 'SMC_STRUCTURE_TARGET';
const retainEvaluations = (...groups) => {
  const retained = new Map();
  for (const row of groups.flat()) {
    if (!row?.id || !row?.reason || row.terminal !== true) continue;
    const key = `${row.id}:${row.stage ?? 'UNKNOWN'}:${row.reason}`;
    if (!retained.has(key) || Number(row.evaluatedAt) > Number(retained.get(key).evaluatedAt)) retained.set(key, row);
  }
  return [...retained.values()].sort((a, b) => Number(b.evaluatedAt) - Number(a.evaluatedAt)).slice(0, 100);
};

export class S2ExecutionEngine {
  constructor({ kernel, book, lifecycle, riskProfile, trialLimits, mode = 'OBSERVE', frameProvider, evidenceArchive, entryQualityRequired = false, prepareEntryFn = prepareEntry, now = Date.now }) {
    invariant(['OBSERVE', 'LIVE'].includes(mode), 'EXECUTION_MODE_INVALID');
    invariant(typeof prepareEntryFn === 'function', 'ENTRY_PREPARATION_PORT_INVALID');
    Object.assign(this, { kernel, book, lifecycle, riskProfile, trialLimits, mode, frameProvider, evidenceArchive, entryQualityRequired, prepareEntryFn, now });
    this.running = false; this.lastSyncAt = null; this.lastDecision = null; this.lastEvaluations = []; this.lastEntryBlockers = []; this.candidatePriorities = [];
    this.quarantinedPlans = new Set([...book.control.keys()].filter(key => key.startsWith(quarantinePrefix)).map(key => key.slice(quarantinePrefix.length)).filter(id => activePositionQuarantine(book, id)));
    this.deferredPlans = pendingOwnedStopHistoryPlans(book);
    this.candidateSource = null;
    this.lastClosedStopReviewAt = 0;
    this.lastOwnerPositionAction = null;
    this.incident = book.control.get('entryIncident') ?? (this.quarantinedPlans.size ? 'POSITION_QUARANTINE_REVIEW_REQUIRED' : null); this.lastError = null;
  }
  pauseEntries(reason) { this.entrySuspended = reason; }
  resumeEntries(reason) { if (this.entrySuspended === reason) this.entrySuspended = null; }
  recordRejection(signal, checked, evaluatedAt, reason = checked?.reason) {
    const row = rejectedEvaluation(signal, checked, evaluatedAt, reason);
    const priority = this.candidatePriorities.find(p => p.planId === signal.id);
    if (priority) { priority.reason = reason; priority.evaluatedAt = evaluatedAt; }
    if (row.terminal) this.lastEvaluations.push(row);
    else this.lastEntryBlockers.push(row);
    return row;
  }
  selectCandidate(signal, state = 'WAITING', reason = null) {
    const row = { planId: signal.id, symbol: signal.symbol, direction: signal.direction,
      state, reason, evaluatedAt: this.now() };
    this.candidatePriorities = [...this.candidatePriorities.filter(p => p.symbol !== signal.symbol), row];
  }
  rankCandidates(frame) {
    const ranked = rankSameSymbolCandidates(frame.signals, frame.market, this.now());
    for (const signal of ranked) {
      if (this.kernel.plans.has(signal.id) || this.book.control.get(`consumed:${signal.id}`)
        || this.candidatePriorities.some(p => p.symbol === signal.symbol)) continue;
      this.selectCandidate(signal);
    }
    // An owned position or unresolved submission is authoritative, even if a
    // newer structure is now closer. Ranking never switches an in-flight order.
    for (const plan of this.kernel.plans.values()) {
      const position = this.book.positions.get(plan.id);
      if (position?.status === 'OPEN') this.selectCandidate(plan, 'POSITION_OPEN');
      else if ([...this.kernel.intents.values()].some(i => i.planId === plan.id && !this.intentSettled(i)))
        this.selectCandidate(plan, 'SUBMITTING');
    }
    return ranked;
  }
  // The exact same frame assembler supplies sizing and every submission gate.
  // The live host/activation file is checked separately at the transport layer.
  frameFor(signal, frame, { afterFlatPreview = false, ignoreUnsentEntryId = null } = {}) {
    const ignored = ignoreUnsentEntryId && this.kernel.intents.get(ignoreUnsentEntryId);
    invariant(!ignored || (ignored.kind === 'entry' && ignored.result === null), 'CANNOT_IGNORE_OBSERVED_ENTRY');
    const positions = [...this.book.positions.values()].filter(p => p.status === 'OPEN');
    const ownPending = [...this.kernel.intents.values()].filter(i => i.id !== ignoreUnsentEntryId && i.kind === 'entry' && !terminal(i.result?.status));
    const mappedPositions = positions.map(p => ({ id: p.id, symbol: p.symbol, direction: p.direction,
      entry: p.entry, quantity: Number(p.quantity), plannedRiskUsdt: p.initialPlannedRiskUsdt,
      riskEvidenceComplete: p.accountingComplete === true,
      committedRiskUsdt: p.exact.initialRiskUsdt, grossNotionalUsdt: String(frame.account.positions.find(row => row.symbol === p.symbol && row.positionSide === (p.direction === 1 ? 'LONG' : 'SHORT'))?.notional).replace(/^-/, ''), exposureEvidenceComplete: true }));
    const mappedPending = ownPending.map(i => { const p = this.kernel.plans.get(i.planId); return { id: `pending:${i.id}`,
      symbol: p.symbol, direction: p.direction === 'LONG' ? 1 : -1, entry: Number(p.price), quantity: Number(p.quantity), plannedRiskUsdt: Number(p.plannedRiskUsdt),
      committedRiskUsdt: p.plannedRiskUsdt, reservedNotionalUsdt: decimal(units(p.price) * units(p.quantity) / units('1')), riskEvidenceComplete: true, exposureEvidenceComplete: true }; });
    const pending = [...this.kernel.intents.values()].filter(i => i.id !== ignoreUnsentEntryId && !this.intentSettled(i)).map(i => ({ id: i.id, clientId: i.params.clientAlgoId ?? i.params.newClientOrderId, resolved: false }));
    const managed = { positions: positions.map(p => ({ id: p.id, symbol: p.symbol, direction: p.direction === 1 ? 'LONG' : 'SHORT', quantity: p.quantity, stopPrice: p.stop, stopClientId: p.stopClientId, accountingComplete: p.accountingComplete })), pending };
    const reconciled = reconcileAccount(frame.account, managed, this.now());
    const hypothetical = afterFlatPreview && positions.length === 1 && positions[0].symbol === signal.symbol && reconciled.status === 'RECONCILED';
    const account = { accountLabel: 'S2', observedAt: new Date(frame.account.observedAt).toISOString(), equityUsdt: frame.account.equityUsdt,
      availableBalanceUsdt: frame.account.availableBalanceUsdt, reconciled: reconciled.status === 'RECONCILED', userStreamConnected: frame.account.userStreamConnected,
      canTrade: frame.account.canTrade, dualSidePosition: frame.account.dualSidePosition, multiAssetsMargin: frame.account.multiAssetsMargin,
      positionsComplete: true, pendingEntriesComplete: true, positions: hypothetical ? [] : mappedPositions, pendingEntries: mappedPending };
    const market = frame.market[signal.symbol] ?? {};
    const campaign = this.book.control.get('r21Campaign')?.state?.campaigns?.[signal.direction];
    const portfolioEntryAllowed = !isR21EligibleSymbol(signal.symbol, this.lifecycle.runtime?.portfolioProfitProtection) || !(campaign?.freezeUntil > this.now());
    const quality = frame.entryQuality?.[signal.id];
    return { ...market, signal, account, rule: frame.rules[signal.symbol], eventGate: frame.eventGate,
      entryConfirmationPolicy: frame.entryConfirmationPolicy ?? null,
      requiredStructureRevision: frame.requiredStructureRevision ?? null,
      lastLossExit: frame.entryConfirmationPolicy ? buildEntryLossContext({ account: 'S2', symbol: signal.symbol, direction: signal.direction,
        book: this.book, kernel: this.kernel, now: this.now() }) : null,
      entryQualityRequired: this.entryQualityRequired,
      entryQuality: quality ? { ...quality, positions: mappedPositions, pending: mappedPending,
        replacementId: hypothetical ? positions[0]?.id ?? null : null } : null,
      portfolioEntryAllowed,
      trialLimits: this.trialLimits, diskReady: frame.diskReady, singleWriter: frame.singleWriter,
      // The host authorization is read into every execution frame. Preserve it
      // through the engine's per-signal projection so owner manual orders do not
      // become indistinguishable from an unauthorized request at preflight or
      // at either durable submission gate.
      manualOrdersEnabled: frame.manualOrdersEnabled === true,
      noUnknownOrders: reconciled.status === 'RECONCILED' && this.accountActivityGate !== false && !this.incident && !this.entrySuspended && !this.quarantinedPlans.size && !this.deferredPlans.size,
      noExistingSymbolPosition: hypothetical || !positions.some(p => p.symbol === signal.symbol), unconsumedSignal: !this.kernel.plans.has(signal.id) && !this.book.control.get(`consumed:${signal.id}`),
      remainingNotionalUsdt: decimal(units(frame.account.equityUsdt) * BigInt(this.trialLimits.maximumGrossNotionalLeverage ?? 1)),
      observedLeverage: frame.leverage[signal.symbol],
      observedMarginType: frame.account.positions.find(row => row.symbol === signal.symbol)?.marginType,
      takerFeeRate: frame.fees[signal.symbol]?.takerFeeRate,
      feeObservedAt: frame.fees[signal.symbol]?.observedAt, feeEvidenceComplete: !!frame.fees[signal.symbol], adverseSlippageRate: '0.0002' };
  }
  intentSettled(intent) {
    if (intent.path.endsWith('/order')) return terminal(intent.result?.status);
    if (intent.method === 'DELETE') {
      const final = row => !row?.unresolved && ['CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED'].includes(row?.algoStatus);
      if (final(intent.result)) return true;
      const plan = this.kernel.plans.get(intent.planId), target = this.kernel.intents.get(intent.params?.clientAlgoId);
      const row = target?.result;
      // A DELETE response can report the pre-cancel NEW state. A later durable
      // observation of that exact owned target's terminal state settles the
      // cancellation without resending it or accepting an unrelated stop.
      return !!(plan && intent.kind === 'cancel' && intent.path === '/fapi/v1/algoOrder'
        && intent.params.symbol === plan.symbol && target?.kind === 'stop' && target.method === 'POST'
        && target.path === intent.path && target.planId === plan.id && target.id === intent.params.clientAlgoId
        && target.params.clientAlgoId === target.id && target.params.symbol === plan.symbol
        && target.params.positionSide === plan.direction && target.params.side === (plan.direction === 'LONG' ? 'SELL' : 'BUY')
        && final(row) && !hasUnsafeVenueIdentifier(row) && row.clientAlgoId === target.id
        && row.symbol === plan.symbol && row.positionSide === plan.direction && row.side === target.params.side
        && (row.orderType ?? row.type) === target.params.type);
    }
    return ['NEW', 'CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED', 'ABSENT_VERIFIED'].includes(intent.result?.algoStatus);
  }
  async submissionGate(request) {
    invariant(this.mode === 'LIVE', 'ENGINE_OBSERVE_ONLY');
    const nonEntry = !['reserve', 'entry'].includes(request.kind);
    const plan = request.plan ?? this.kernel.plans.get(request.planId);
    if (nonEntry) {
      invariant(!this.quarantinedPlans.has(request.planId) || isOwnedEntryCancellation(request, this.kernel), 'POSITION_QUARANTINED_REVIEW_REQUIRED');
      const priorityProtection = validateImmediateInitialProtection(request, { kernel: this.kernel, book: this.book });
      if (priorityProtection) return priorityProtection;
      if (!isOwnedEntryCancellation(request, this.kernel)) {
        // Re-observe unsettled cumulative regular orders before reading account
        // quantity. Do not treat a timed-out close as zero executed quantity.
        for (const intent of this.kernel.intents.values()) {
          if (intent.planId !== request.planId || !['entry', 'close'].includes(intent.kind) || intent.id === request.intentId || terminal(intent.result?.status)) continue;
          invariant(!(await this.kernel.observe(intent.id)).unresolved, 'OWNED_ORDER_REFRESH_UNRESOLVED');
        }
      }
    }
    const refreshStartedAt = this.now();
    const pinnedSignal = nonEntry ? null : plan?.evidence?.revalidationSignal ?? null;
    const frame = await this.frameProvider({ forceAccountRefresh: true, pinnedSignal });
    invariant(frame.singleWriter && frame.account.canTrade && frame.account.dualSidePosition && !frame.account.multiAssetsMargin, 'EXECUTION_ACCOUNT_BOUNDARY');
    invariant(fresh(frame.account.observedAt, this.now(), 5000), 'SUBMISSION_ACCOUNT_STALE');
    if (nonEntry) {
      // A global entry pause does not disable healthy positions' protection.
      // A quarantined leg, however, must not be mutated via another dispatch path.
      invariant(!this.quarantinedPlans.has(request.planId) || isOwnedEntryCancellation(request, this.kernel), 'POSITION_QUARANTINED_REVIEW_REQUIRED');
      invariant(frame.account.observedAt >= refreshStartedAt, 'SUBMISSION_REUSED_PRE_GATE_SNAPSHOT');
      return validateOwnedMutation(request, { kernel: this.kernel, book: this.book, account: frame.account });
    }
    invariant(this.accountActivityGate !== false && !this.entrySuspended && !this.incident && !this.quarantinedPlans.size && !this.deferredPlans.size && frame.account.userStreamConnected && frame.diskReady, 'ENTRY_INCIDENT_OR_INFRASTRUCTURE_GATE');
    invariant(plan && this.now() <= plan.validUntil, 'ENTRY_PLAN_EXPIRED');
    if (plan.structureRevision) invariant(frame.requiredStructureRevision === plan.structureRevision
      && frame.candidateSource?.state !== 'UNAVAILABLE', 'ENTRY_CONFIRMATION_Z_SOURCE_UNAVAILABLE');
    const signal = frame.signals.find(row => row.id === plan.id);
    invariant(signal, plan.structureRevision ? 'ENTRY_CONFIRMATION_Z_SIGNAL_WAIT' : 'ENTRY_SIGNAL_NO_LONGER_VALID');
    const input = this.frameFor(signal, frame, { ignoreUnsentEntryId: request.kind === 'entry' ? clientId('entry', plan.id) : null });
    // The just-reserved plan is intentionally consumed locally; exclude ONLY
    // this unsent entry from the recheck, never another pending exposure.
    input.unconsumedSignal = true;
    const checked = this.prepareEntryFn(input, this.riskProfile, this.now());
    invariant(checked.plan && checked.plan.id === plan.id && checked.plan.symbol === plan.symbol
      && checked.plan.direction === plan.direction && checked.plan.source === plan.source
      && checked.plan.stopPrice === plan.stopPrice && checked.plan.targetPrice === plan.targetPrice
      && (request.kind === 'reserve' || units(checked.plan.quantity) >= units(plan.quantity)),
    checked.reason ?? 'ENTRY_PRE_SUBMISSION_CHANGED');
    if (plan.structureRevision || checked.plan.structureRevision) invariant(
      hash(structureCommitIdentity(plan)) === hash(structureCommitIdentity(checked.plan)), 'ENTRY_CONFIRMATION_Z_STRUCTURE_CHANGED');
    if (plan.entryConfirmation || checked.plan.entryConfirmation) {
      invariant(hash(entryConfirmationCommitIdentity(plan.entryConfirmation, plan.managementPolicy))
        === hash(entryConfirmationCommitIdentity(checked.plan.entryConfirmation, checked.plan.managementPolicy)), 'ENTRY_CONFIRMATION_CHANGED_BEFORE_SUBMISSION');
    }
    invariant(typeof this.evidenceArchive?.pinEntry === 'function', 'ENTRY_EVIDENCE_ARCHIVE_REQUIRED');
    const committedPlan = request.kind === 'reserve' ? checked.plan : plan;
    if (request.kind === 'entry') invariant(request.params?.symbol === committedPlan.symbol
      && request.params?.positionSide === committedPlan.direction
      && units(request.params?.quantity) === units(committedPlan.quantity)
      && request.params?.price === committedPlan.price, 'ENTRY_INTENT_PLAN_MISMATCH');
    const evidence = await this.evidenceArchive.pinEntry({ plan: committedPlan, bbo: input.bbo, tick: input.tick });
    invariant(evidence?.schema === 'S2_PINNED_ENTRY_EVIDENCE_V1' && evidence.planId === committedPlan.id && evidence.symbol === committedPlan.symbol && evidence.bboSequence === input.bbo.sequence && evidence.tickSequence === input.tick.sequence && Array.isArray(evidence.receipts) && evidence.receipts.length > 0 && evidence.receipts.every(row => row.verified === true && row.pinned === true), 'ENTRY_PINNED_EVIDENCE_INVALID');
    await this.book.setControl(`entryEvidence:${committedPlan.id}`, evidence);
    invariant(!this.entrySuspended && this.accountActivityGate !== false, 'ENTRY_SUSPENDED_DURING_COMMIT');
    invariant(this.now() <= committedPlan.validUntil && fresh(input.bbo.marketTime, this.now(), 2000) && fresh(input.tick.marketTime, this.now(), 2000), 'ENTRY_PIN_COMMIT_EXPIRED');
    return request.kind === 'reserve' ? { plan: committedPlan } : undefined;
  }
  async hold(reason) {
    this.incident = reason;
    await this.book.setControl('entryIncident', reason);
  }
  async quarantine(planId, phase, error) {
    const reason = incidentCode(error);
    // Stop dispatch synchronously, then commit the leg before the account hold.
    // Recovery recognizes either record; a partial commit cannot re-enable entry.
    this.quarantinedPlans.add(planId); this.incident = reason; this.lastError = reason;
    if (!this.book.control.has(`${quarantinePrefix}${planId}`) || protectionOnlyRecovered(this.book, planId) || ownedEntryRecovered(this.book, planId) || absentPreDispatchEntryRecovered(this.book, planId) || absentCloseRecovered(this.book, planId)) {
      const previous = this.book.control.get(`${quarantinePrefix}${planId}`);
      await this.book.setControl(`${quarantinePrefix}${planId}`, { phase, reason, at: this.now(), generation: (previous?.generation ?? 0) + 1, status: 'REVIEW_REQUIRED_NO_AUTOMATIC_ADOPTION' });
    }
    await this.hold(reason);
  }
  async managePrices(market, rules) {
    if (this.running || this.mode !== 'LIVE') return { status: 'PRICE_MANAGEMENT_DEFERRED' };
    this.running = true;
    try {
      for (const position of this.book.positions.values()) {
        if ((!position.managementPolicy && !planHasStructureTarget(this.kernel.plans.get(position.id))) || position.status !== 'OPEN' || position.strategyManagementSuspended
          || this.quarantinedPlans.has(position.id) || this.deferredPlans.has(position.id)) continue;
        const plan = this.kernel.plans.get(position.id), quote = market[position.symbol]?.bbo;
        if (!plan || this.kernel.activeStopReplacement(plan)
          || [...this.book.operations.values()].some(op => op.planId === plan.id && !this.book.control.get(`finished:${op.id}`))) continue;
        if (!quote || !fresh(quote.marketTime, this.now(), 2000) || !fresh(quote.receivedAt, this.now(), 2000)
          || quote.persisted !== true || quote.continuity !== true || !managementRuleReady(rules[position.symbol])) continue;
        try {
          const managed = await this.lifecycle.manage(plan, quote, rules[position.symbol]);
          if (managed.type !== 'HOLD') return { status: 'PRICE_MANAGEMENT_ACTION', managed };
        } catch (error) {
          if (RETRYABLE_SCHEDULING_ERRORS.has(error?.message)) this.lastError = error.message;
          else await this.quarantine(position.id, 'PRICE_MANAGEMENT', error);
        }
      }
      return { status: 'PRICE_MANAGEMENT_HOLD' };
    } finally { this.running = false; }
  }
  async processOwnerPositionAction(action, frame) {
    if (!action) return null;
    const reject = reason => ({ id: action.id, status: 'REJECTED', reason });
    try {
      invariant(frame.exitsAllowed === true, 'OWNER_POSITION_EXITS_DISABLED');
      invariant(this.now() <= action.expiresAt, 'OWNER_POSITION_ACTION_EXPIRED');
      const plan = this.kernel.plans.get(action.planId), position = this.book.positions.get(action.planId);
      invariant(plan && position?.status === 'OPEN', 'OWNER_POSITION_NOT_OPEN');
      invariant(plan.symbol === action.symbol && plan.direction === action.direction
        && (position.direction === 1 ? 'LONG' : 'SHORT') === action.direction, 'OWNER_POSITION_SCOPE_MISMATCH');
      invariant(!this.quarantinedPlans.has(plan.id) && !this.deferredPlans.has(plan.id)
        && !position.strategyManagementSuspended, 'OWNER_POSITION_MANAGEMENT_SUSPENDED');
      const quote = frame.market[position.symbol]?.bbo;
      invariant(quote && fresh(quote.marketTime, this.now(), 2000) && fresh(quote.receivedAt, this.now(), 2000)
        && quote.persisted === true && quote.continuity === true, 'MANAGEMENT_QUOTE_STALE');
      let result;
      if (['ARM_STOP_PLAN', 'CANCEL_STOP_PLAN'].includes(action.action)) {
        result = await configureConditionalStop({ book: this.book, position, action, quote,
          rule: frame.rules[position.symbol], now: this.now() });
        return { id: action.id, status: 'COMPLETED', reason: result.status, result };
      } else if (action.action === 'REDUCE') {
        const rule = freshRules(frame.rules[position.symbol], position.symbol, this.now());
        const current = units(position.quantity);
        const raw = decimal(current * BigInt(action.fractionBps) / 10000n);
        invariant(units(raw) > 0n && units(raw) >= units(rule.marketLot.min), 'OWNER_REDUCTION_BELOW_MINIMUM_LOT');
        const quantity = action.fractionBps === 10000 ? decimal(current) : align(raw, rule.marketLot, 'DOWN');
        const remaining = current - units(quantity);
        invariant(remaining === 0n || remaining >= units(rule.marketLot.min), 'OWNER_REDUCTION_LEAVES_DUST');
        result = await this.lifecycle.reduce(plan, position, { quantity, reason: 'OWNER_POSITION_REDUCTION',
          operationId: `owner:${action.id}` }, quote);
      } else if (action.action === 'TIGHTEN_STOP') {
        result = await this.lifecycle.ownerTightenStop(plan, position, frame.account, frame.rules[position.symbol],
          quote, action.stopPrice, action.id);
      } else {
        result = await this.lifecycle.ownerUpdateTarget(plan, position, frame.rules[position.symbol],
          quote, action.targetPrice, action.id);
      }
      if (action.action === 'REDUCE' && ['CANCELED', 'EXPIRED', 'REJECTED'].includes(result?.status))
        return { id: action.id, status: 'REJECTED', reason: `OWNER_REDUCTION_${result.status}`, result };
      const completed = action.action === 'REDUCE' ? result?.status === 'FILLED'
        : action.action === 'TIGHTEN_STOP' ? ['PROTECTION_REPLACED', 'STOP_REPLACEMENT_FLAT'].includes(result?.status)
          : result?.status === 'TARGET_UPDATED';
      const reason = action.action === 'REDUCE'
        ? (completed ? 'OWNER_REDUCTION_COMPLETED' : 'OWNER_REDUCTION_SENT_TO_VENUE')
        : action.action === 'TIGHTEN_STOP'
          ? (completed ? 'OWNER_STOP_REPLACEMENT_COMPLETED' : 'OWNER_STOP_REPLACEMENT_STARTED')
          : (completed ? 'OWNER_TARGET_UPDATE_COMPLETED' : 'OWNER_TARGET_UPDATE_PENDING');
      return { id: action.id, status: completed ? 'COMPLETED' : 'SUBMITTED', reason, result };
    } catch (error) { return reject(incidentCode(error)); }
  }
  async cycle() {
    invariant(!this.running, 'ENGINE_CONCURRENT_CYCLE'); this.running = true;
    try {
      this.cyclePhase = 'FRAME_READ';
      this.lastEntryBlockers = []; this.candidatePriorities = [];
      let frame = await this.frameProvider();
      this.candidateSource = frame.candidateSource ?? null;
      if (this.mode === 'LIVE') await this.kernel.releaseAbandonedEntryReservations?.();
      // Publishers sample every 30-75 seconds while this loop runs every second.
      // Retain terminal outcomes so a real rejection cannot disappear between
      // publisher samples. The external ledger remains the durable archive.
      this.lastEvaluations = retainEvaluations(this.lastEvaluations,
        (frame.candidateEvaluations ?? []).filter(row => row.terminal === true));
      invariant(fresh(frame.account.observedAt, this.now(), 5000), 'ACCOUNT_SNAPSHOT_STALE');
      // One low-priority historical review per minute. A missing venue order
      // needs both the exact client-ID lookup and complete recent algo history;
      // read errors never settle an intent or bypass account reconciliation.
      if (this.mode === 'LIVE' && this.now() - this.lastClosedStopReviewAt >= 60000) {
        this.lastClosedStopReviewAt = this.now();
        try {
          await reconcileClosedStopAbsence({ kernel: this.kernel, book: this.book,
            snapshot: frame.account, read: (method, path, params) => this.kernel.transport.request(method, path, params),
            accountActivityReady: this.accountActivityGate, now: this.now() });
        } catch (error) {
          if (this.kernel.journal.failed) throw error;
          this.lastError = incidentCode(error);
        }
      }
      if (this.mode === 'OBSERVE') {
        this.lastDecision = this.rankCandidates(frame).map(signal => ({ id: signal.id, symbol: signal.symbol, ...this.prepareEntryFn(this.frameFor(signal, frame), this.riskProfile, this.now()) }));
        for (const row of this.lastDecision.filter(row => !row.plan))
          this.recordRejection(frame.signals.find(signal => signal.id === row.id), row, this.now());
        this.lastEvaluations = this.lastEvaluations.slice(0, 100);
        return { status: 'OBSERVE_ONLY_NO_ORDER_CALLS', decisions: this.lastDecision };
      }
      if (this.lastSyncAt !== frame.account.observedAt) {
        for (const plan of this.kernel.plans.values()) {
          if (this.book.control.get(`retired:${plan.id}`) || this.quarantinedPlans.has(plan.id)) continue;
          let phase = 'RECONCILIATION';
          try {
            this.cyclePhase = 'PLAN_SYNC';
            const row = frame.account.positions.find(p => p.symbol === plan.symbol && p.positionSide === plan.direction);
            const quantity = row ? String(row.positionAmt).replace(/^-/, '') : '0';
            const result = await this.lifecycle.sync(plan, { quantity, algos: frame.account.algos, observedAt: frame.account.observedAt,
              positionsComplete: frame.account.positionsComplete, algosComplete: frame.account.algosComplete });
            if (result.newEntriesBlocked) { this.deferredPlans.add(plan.id); await this.hold(result.status); }
            else this.deferredPlans.delete(plan.id);
            // An unresolved entry has not established an owned position snapshot.
            if (result.status === 'ENTRY_UNRESOLVED') continue;
            const p = this.book.positions.get(plan.id);
            if (p?.status === 'CLOSED') {
              phase = 'FLAT_CLEANUP';
              await runConditionalStops({ book: this.book, kernel: this.kernel, lifecycle: this.lifecycle,
                plan, position: p, now: this.now() });
              await this.lifecycle.cleanupFlat(plan, frame.account);
              if (!frame.account.algos.some(a => a.symbol === plan.symbol) && !frame.account.orders.some(o => o.symbol === plan.symbol)) await this.book.setControl(`retired:${plan.id}`, true);
            }
            if (p?.status === 'OPEN') {
              phase = 'PROTECTION';
              this.cyclePhase = 'PLAN_PROTECT';
              const quote = frame.market[p.symbol]?.bbo;
              const protection = await this.lifecycle.protect(plan, p, frame.account, frame.rules[p.symbol], quote, frame.bars[p.symbol]);
              invariant(protection.status !== 'PROTECTION_REPAIR_FAILED', 'PROTECTION_REPAIR_FAILED');
              if (p.actualRiskExceededPlan) { await this.hold('ACTUAL_FILL_RISK_EXCEEDED'); await this.kernel.emergencyClose(plan, 'actual_fill_risk_exceeded'); }
            }
          } catch (error) {
            // A failed leg must not skip protection checks on independent legs.
            // Persistence failure deliberately escapes and stops the whole cycle.
            if (error?.message === 'OWNED_STOP_FILL_HISTORY_PENDING') {
              this.deferredPlans.add(plan.id); this.lastError = error.message;
            } else if (RETRYABLE_SCHEDULING_ERRORS.has(error?.message)) this.lastError = error.message;
            else await this.quarantine(plan.id, phase, error);
          }
        }
        this.lastSyncAt = frame.account.observedAt;
      }
      if (Array.isArray(frame.ownerPositionActions) && frame.ownerPositionActions.length) {
        this.cyclePhase = 'OWNER_POSITION_ACTION';
        this.lastOwnerPositionAction = await this.processOwnerPositionAction(frame.ownerPositionActions[0], frame);
        return { status: 'OWNER_POSITION_ACTION_HANDLED', ownerPositionAction: this.lastOwnerPositionAction };
      }
      for (const p of this.book.positions.values()) {
        if (p.status !== 'OPEN' || p.strategyManagementSuspended || this.quarantinedPlans.has(p.id) || this.deferredPlans.has(p.id)) continue;
        try {
          const plan = this.kernel.plans.get(p.id), quote = frame.market[p.symbol]?.bbo;
          if (this.kernel.activeStopReplacement(plan)) continue;
          this.cyclePhase = 'REDUCTION_RESUME';
          const resumed = await this.lifecycle.resumeOperations(plan);
          if (resumed.status !== 'NO_PENDING_REDUCTION') return resumed;
          // A newly reconnected public stream can be timely before its raw
          // segment is durably persisted or continuity is established. The
          // venue stop remains authoritative during that short window; defer
          // profit management instead of turning data readiness into a durable
          // ownership quarantine.
          if (quote && fresh(quote.marketTime, this.now(), 2000) && fresh(quote.receivedAt, this.now(), 2000)
            && quote.persisted === true && quote.continuity === true) {
            const rule = frame.rules[p.symbol];
            // Exchange filters are populated asynchronously after startup. The
            // venue stop remains active while that cache warms; management must
            // wait rather than turn a temporary metadata gap into quarantine.
            if (!managementRuleReady(rule)) { this.lastError = 'MANAGEMENT_RULES_NOT_READY'; continue; }
            this.cyclePhase = 'POSITION_MANAGE';
            if (frame.exitsAllowed === true) {
              const conditional = await runConditionalStops({ book: this.book, kernel: this.kernel, lifecycle: this.lifecycle,
                plan, position: p, account: frame.account, quote, rule, now: this.now() });
              if (conditional.type !== 'HOLD') return { status: 'CONDITIONAL_STOP_HANDLED', managed: conditional };
            }
            const managed = await this.lifecycle.manage(plan, quote, rule);
            if (managed.type !== 'HOLD') return { status: 'MANAGEMENT_SUBMITTED_OR_DEFERRED', managed };
          }
        } catch (error) {
          if (RETRYABLE_SCHEDULING_ERRORS.has(error?.message)) this.lastError = error.message;
          else await this.quarantine(p.id, 'MANAGEMENT', error);
        }
      }
      const positions = [...this.book.positions.values()].filter(p => p.status === 'OPEN');
      const pendingReplacement = [...this.kernel.plans.values()].some(plan => this.kernel.activeStopReplacement(plan));
      // With the small-trial one-position cap, R21's >=3-position campaign
      // cannot activate. The same implementation supports authorized parity tests.
      // Portfolio decisions require trustworthy quantities for every leg; never
      // silently omit an uncertain leg and reinterpret the portfolio exposure.
      if (!pendingReplacement && !this.quarantinedPlans.size && !this.deferredPlans.size && !positions.some(p => p.strategyManagementSuspended) && (positions.length >= 3 || this.book.control.get('r21Campaign')?.actions?.length)) {
        this.cyclePhase = 'PORTFOLIO_MANAGE';
        await this.lifecycle.portfolio(Object.fromEntries(Object.entries(frame.market).map(([symbol, m]) => [symbol, m.bbo])), Number(frame.account.equityUsdt), frame.rules);
      }
      if (pendingReplacement) return { status: 'PROTECTIVE_STOP_REPLACEMENT_PENDING', newEntriesBlocked: true };
      if (pendingOwnedStopHistoryPlans(this.book).size) return { status: 'OWNED_STOP_FILL_HISTORY_PENDING', newEntriesBlocked: true,
        deferredPlanIds: [...pendingOwnedStopHistoryPlans(this.book)] };
      this.cyclePhase = 'ENTRY_EVALUATION';
      for (const signal of this.rankCandidates(frame)) {
        // Preflight rejections do not consume a symbol's opportunity. A real
        // entry or replacement still returns immediately, including unknown outcomes.
        if (this.kernel.plans.has(signal.id) || this.book.control.get(`consumed:${signal.id}`)) continue;
        const existing = positions.find(p => p.symbol === signal.symbol);
        if (existing && (existing.strategyManagementSuspended || this.quarantinedPlans.has(existing.id) || this.deferredPlans.has(existing.id))) continue;
        const conflict = existing ? positionConflictDecision(signal, existing, frame.market[signal.symbol]?.bbo,
          this.kernel.plans.get(existing.id), { requiredStructureRevision: frame.requiredStructureRevision,
            now: this.now(), bars15m: frame.entryQuality?.[signal.id]?.bars15m,
            bars1h: frame.entryQuality?.[signal.id]?.bars1h }) : null;
        if (existing && conflict.action === 'REPLACE_POSITION') {
          const preview = this.prepareEntryFn(this.frameFor(signal, frame, { afterFlatPreview: true }), this.riskProfile, this.now());
          if (!preview.plan) this.recordRejection(signal, preview, this.now());
          if (!preview.plan) continue;
          const quote = frame.market[signal.symbol].bbo;
          this.selectCandidate(signal, 'SUBMITTING', 'REPLACEMENT_PENDING');
          await this.book.setControl('replacement', { signalId: signal.id, oldPlanId: existing.id,
            reason: conflict.reason, executableNetFloatingProfitUsdt: conflict.executableNetFloatingProfitUsdt,
            executableExitPrice: conflict.executableExitPrice, observedQuoteSequence: quote.sequence });
          await this.lifecycle.reduce(this.kernel.plans.get(existing.id), existing, { quantity: existing.quantity, reason: 'R15_CURRENT_STRUCTURE_REPLACEMENT' }, quote);
          return { status: 'R15_CLOSE_OLD_FIRST' };
        }
        if (existing) {
          this.lastDecision = { id: signal.id, symbol: signal.symbol, status: 'CANDIDATE_RETAINED_WHILE_POSITION_OPEN',
            reason: conflict.reason, executableNetFloatingProfitUsdt: conflict.executableNetFloatingProfitUsdt ?? null };
          continue;
        }
        const replacement = this.book.control.get('replacement');
        if (replacement?.signalId === signal.id) {
          if (!this.book.control.get(`retired:${replacement.oldPlanId}`)) return { status: 'R15_WAITING_RECONCILED_FLAT' };
          if (!(frame.market[signal.symbol]?.bbo?.sequence > replacement.observedQuoteSequence)) return { status: 'R15_WAITING_FRESH_BBO' };
        }
        const checked = this.prepareEntryFn(this.frameFor(signal, frame), this.riskProfile, this.now());
        this.lastDecision = { id: signal.id, status: checked.status, reason: checked.reason };
        if (!checked.plan) this.recordRejection(signal, checked, this.now());
        if (!checked.plan) continue;
        this.selectCandidate(signal, 'SUBMITTING');
        const result = await this.kernel.enter(checked.plan);
        if (result.status === 'ENTRY_CONFIRMATION_DEFERRED') {
          this.recordRejection(signal, { reason: result.reason }, this.now());
          this.selectCandidate(signal, 'WAITING', result.reason);
          return { status: 'ENTRY_CONFIRMATION_WAIT', reason: result.reason, newEntriesBlocked: false };
        }
        return { status: 'ENTRY_CYCLE', result };
      }
      this.lastError = null;
      return { status: this.incident ? 'ENTRY_BLOCKED_INCIDENT'
        : this.candidateSource?.state === 'UNAVAILABLE' ? 'CANDIDATE_SOURCE_UNAVAILABLE' : 'NO_ELIGIBLE_ENTRY', incident: this.incident, quarantinedPlanIds: [...this.quarantinedPlans] };
    } catch (error) {
      this.lastError = String(error.message).match(/^[A-Z0-9_]{1,96}$/) ? error.message : 'EXECUTION_CYCLE_FAILED';
      // Data corruption/ownership failures survive restart. Transport or stale
      // data failures block this cycle and are re-evaluated on a fresh frame.
      if (/MISMATCH|CONFLICT|EXCESS|REGRESSION|INTEGRITY|HISTORICAL|SHORTFALL|UNEXPECTED_POSITION/.test(this.lastError)) await this.hold(this.lastError);
      return { status: 'ENTRY_BLOCKED_INCIDENT', incident: this.incident, error: this.lastError };
    } finally { this.lastEvaluations = retainEvaluations(this.lastEvaluations); this.running = false; this.cyclePhase = 'IDLE'; }
  }
}
