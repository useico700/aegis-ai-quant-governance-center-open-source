import { evaluateV2R21ProfitProtection as evaluateR22ProfitProtection } from './r22-portfolio-integrity.mjs';
import { netLiquidationR } from '../../orion-v2/paper/paper-engine.mjs';
import { evaluateV2R21ProfitProtection } from '../../orion-v2/paper/r21-integrity.mjs';
import { hasUnsafeVenueIdentifier } from '../../../lib/exchange-json.mjs';
import { units, decimal, align, alignTrigger, freshRules } from '../../../lib/s1-precision.mjs';
import { invariant, terminal, clientId, closeSide, fresh } from './common.mjs';
import { readOrderFills } from './history-reader.mjs';
import { nextR22Action, r22StopProposal } from './r22-management.mjs';
import { evaluateR21ProfitProtection, initialR21State, isR21EligibleSymbol } from '../../shared/r21-profit-protection.mjs';
import { advanceAggregateProfitLock, aggregateLiquidationNetR, resolveProfitRetentionPolicy } from '../../shared/profit-retention.mjs';
import { hasDispatchProtocol } from './kernel.mjs';

export function replacementEligible(signal, position) {
  return signal?.symbol === position.symbol && ['LONG', 'SHORT'].includes(signal.direction)
    && [signal.intersectionTime, position.intersectionTime, signal.closedAt, position.openedAt].every(value => Number.isFinite(value) && value > 0)
    && signal.fourHourLineStatus === 'ACTIVE_4H_TREND'
    && signal.intersectionTime > position.intersectionTime && signal.closedAt > position.openedAt
    && (signal.direction === 'LONG' ? 1 : -1) === -position.direction;
}

export function positionConflictDecision(signal, position, quote, positionPlan) {
  if (signal?.symbol !== position?.symbol) return { action: 'NO_CONFLICT', reason: 'DIFFERENT_SYMBOL' };
  const signalDirection = signal.direction === 'LONG' ? 1 : signal.direction === 'SHORT' ? -1 : 0;
  if (!signalDirection) return { action: 'HOLD_POSITION', reason: 'NEW_DIRECTION_UNKNOWN' };
  if (signalDirection === position.direction) return { action: 'HOLD_POSITION', reason: 'SAME_DIRECTION_POSITION_EXISTS' };
  if (!replacementEligible(signal, position)) return { action: 'HOLD_POSITION', reason: 'OPPOSITE_SIGNAL_NOT_NEWER' };
  // The final runner exists specifically to capture an extended one-way move.
  // A later opposite candidate must remain queued until that runner is closed
  // by its own management; it may neither replace nor hedge the runner.
  if (position.secondPartialTaken === true) return { action: 'HOLD_POSITION', reason: 'RUNNER_POSITION_BLOCKS_OPPOSITE_ENTRY' };
  const values = [quote?.bid, quote?.ask, position.entry, position.quantity, position.originalQuantity,
    position.entryFee, positionPlan?.takerFeeRate, positionPlan?.adverseSlippageRate].map(Number);
  if (!values.every(Number.isFinite) || values.slice(0, 5).some(value => value <= 0)
    || values.slice(5).some(value => value < 0)) return { action: 'HOLD_POSITION', reason: 'FLOATING_PROFIT_EVIDENCE_INCOMPLETE' };
  const [bid, ask, entry, quantity, originalQuantity, entryFee, takerFeeRate, adverseSlippageRate] = values;
  const executable = (position.direction === 1 ? bid : ask) * (1 - position.direction * adverseSlippageRate);
  const gross = position.direction * (executable - entry) * quantity;
  const allocatedEntryFee = entryFee * quantity / originalQuantity;
  const estimatedExitFee = executable * quantity * takerFeeRate;
  const executableNetFloatingProfitUsdt = gross - allocatedEntryFee - estimatedExitFee;
  return executableNetFloatingProfitUsdt > 0
    ? { action: 'REPLACE_POSITION', reason: 'OPPOSITE_SIGNAL_AND_POSITIVE_EXECUTABLE_NET_FLOATING_PROFIT', executableNetFloatingProfitUsdt, executableExitPrice: executable }
    : { action: 'HOLD_POSITION', reason: 'OPPOSITE_SIGNAL_BUT_NO_EXECUTABLE_NET_FLOATING_PROFIT', executableNetFloatingProfitUsdt, executableExitPrice: executable };
}

export class PositionLifecycle {
  constructor({ kernel, book, runtime, strategy, now = Date.now }) { this.kernel = kernel; this.book = book; this.runtime = runtime; this.strategy = strategy; this.now = now; }
  runtimeFor(plan) {
    const rates = [plan.takerFeeRate, plan.adverseSlippageRate];
    invariant(rates.every(value => typeof value === 'string' && value.trim() !== ''
      && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) < 1), 'PLAN_COST_RATES_REQUIRED');
    return { ...this.runtime, paperRisk: { ...this.runtime.paperRisk,
      takerFeeRate: Number(plan.takerFeeRate), adverseSlippageRate: Number(plan.adverseSlippageRate) } };
  }
  async observeProfitRetention(plan, position, quote) {
    if (!plan.managementPolicy || !position.managementPolicy || position.status !== 'OPEN'
      || !fresh(quote?.marketTime, this.now(), 2000) || !fresh(quote?.receivedAt, this.now(), 2000)
      || quote.persisted !== true || quote.continuity !== true) return position;
    const managementPolicy = resolveProfitRetentionPolicy(plan.managementPolicy, position, this.runtimeFor(plan).paperRisk);
    const currentNetR = aggregateLiquidationNetR(position,
      position.direction === 1 ? quote.bid : quote.ask, this.runtimeFor(plan).paperRisk);
    const profitRetention = advanceAggregateProfitLock({ policy: managementPolicy,
      softLockTaken: position.softLockTaken === true && units(position.quantity) < units(position.originalQuantity),
      peakNetR: position.profitRetention?.peakNetR ?? 0, currentNetR,
      existingFloorR: Math.max(position.pendingAggregateFloor ?? 0, position.profitRetention?.floorR ?? 0),
      accountingComplete: position.accountingComplete });
    return this.book.save({ ...position, managementPolicy, profitRetention });
  }
  async accountOrder(plan, order, role) {
    invariant(order && !order.unresolved && order.orderId !== undefined && order.executedQty !== undefined, 'ORDER_UNRESOLVED');
    const key = `accounted:${plan.symbol}:${order.orderId}`, done = this.book.control.get(key);
    if (done?.terminal && done.executedQty === order.executedQty) return;
    if (units(order.executedQty) === 0n) {
      await this.book.setControl(key, { executedQty: order.executedQty, terminal: terminal(order.status) });
      return;
    }
    const rows = await readOrderFills(this.kernel.transport, { symbol: plan.symbol, orderId: order.orderId, executedQty: order.executedQty });
    await this.book.recordOrderFills(plan, order, rows, role);
    await this.book.setControl(key, { executedQty: order.executedQty, terminal: terminal(order.status) });
  }
  async sync(plan, venuePosition) {
    const entryIntent = this.kernel.intents.get(clientId('entry', plan.id));
    if (!entryIntent) return { status: 'RESERVED_NO_ENTRY_NEVER_RESUBMIT' };
    const entry = terminal(entryIntent.result?.status) && !hasUnsafeVenueIdentifier(entryIntent.result) ? entryIntent.result : await this.kernel.observe(entryIntent.id);
    if (entry.unresolved) return { status: 'ENTRY_UNRESOLVED', newEntriesBlocked: true };
    // Protect before potentially slower history reads; for an already-managed
    // position do not restore an old wider stop or create another initial stop.
    if (units(entry.executedQty) > 0n && !this.book.positions.has(plan.id) && units(venuePosition.quantity) > 0n) {
      const protection = await this.kernel.protectEntry(plan, entry);
      invariant(protection.status.startsWith('PROTECTED_'), protection.status);
    }
    await this.accountOrder(plan, entry, 'ENTRY');
    for (const intent of this.kernel.intents.values()) {
      if (intent.planId !== plan.id || intent.kind !== 'close') continue;
      // Marker-v1 records an intent before the last submission gate. If that
      // gate rejects, no exchange request exists yet. Let resumeOperations()
      // re-run the fresh gate and dispatch the same durable identity; querying
      // it here would misclassify the intentionally unsent intent as unknown.
      if (hasDispatchProtocol(intent) && !this.kernel.dispatchStarted.has(intent.id) && intent.result === null) continue;
      const order = terminal(intent.result?.status) && !hasUnsafeVenueIdentifier(intent.result) ? intent.result : await this.kernel.observe(intent.id);
      await this.accountOrder(plan, order, 'EXIT');
      invariant(terminal(order.status), 'CLOSE_ORDER_NOT_TERMINAL');
    }
    // Triggered protective algos produce a normal order with a venue-generated
    // client ID. Ownership comes from our durable algo's actualOrderId mapping.
    for (const intent of this.kernel.intents.values()) {
      if (intent.planId !== plan.id || intent.kind !== 'stop') continue;
      const settled = !hasUnsafeVenueIdentifier(intent.result)
        && ['CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED', 'ABSENT_VERIFIED'].includes(intent.result?.algoStatus);
      const active = !settled && Array.isArray(venuePosition.algos)
        ? venuePosition.algos.find(row => row.clientAlgoId === intent.params.clientAlgoId && row.algoStatus === 'NEW') : null;
      if (active) {
        invariant(this.kernel.validStop(active, plan, intent.params.triggerPrice)
          || this.kernel.isReplacementBridge(active, plan, venuePosition.quantity)
          || this.kernel.isClosingReplacementBridge(active, plan, venuePosition.quantity), 'ACCOUNT_SNAPSHOT_PROTECTIVE_ALGO_INVALID');
        if (intent.result === null) await this.kernel.acceptObservation(intent.id, active);
      }
      let algo = settled ? intent.result : active ?? await this.kernel.observe(intent.id);
      // A tightening POST can be accepted by Binance before its clientAlgoId is
      // query-visible. While the ledger still points at another verified stop,
      // retain that protection and let protect() adopt the replacement from a
      // complete account snapshot instead of quarantining the position.
      const currentStopClientId = this.book.positions.get(plan.id)?.stopClientId;
      const hasVerifiedAlternate = [...this.kernel.intents.values()].some(other => other.planId === plan.id
        && other.kind === 'stop' && other.id !== intent.id
        && this.kernel.validStop(other.result, plan, other.params.triggerPrice));
      const replacement = this.kernel.activeStopReplacement(plan);
      const hasCurrentBridgeAlternate = replacement?.oldClientId === intent.id
        && Array.isArray(venuePosition.algos) && venuePosition.algos.some(row => row.clientAlgoId === replacement.bridgeClientId
          && this.kernel.isReplacementBridge(row, plan, venuePosition.quantity));
      // Only the current complete account snapshot's exact active bridge can
      // cover an unreadable original during transfer. Cached bridge acceptance
      // cannot do so; resume still queries the original's cancellation outcome.
      if (algo.unresolved && ((currentStopClientId && intent.params.clientAlgoId !== currentStopClientId)
        || hasVerifiedAlternate || hasCurrentBridgeAlternate)) continue;
      if (algo.unresolved && units(venuePosition.quantity) === 0n) throw new Error('PROTECTIVE_ALGO_STATUS_DEFERRED');
      invariant(!algo.unresolved, 'PROTECTIVE_ALGO_UNRESOLVED');
      if (algo.actualOrderId && String(algo.actualOrderId) !== '0') {
        const order = await this.kernel.transport.request('GET', '/fapi/v1/order', { symbol: plan.symbol, orderId: algo.actualOrderId });
        invariant(order.symbol === plan.symbol && order.positionSide === plan.direction && order.side === closeSide(plan.direction) && String(order.orderId) === String(algo.actualOrderId), 'ALGO_CHILD_ORDER_MISMATCH');
        await this.accountOrder(plan, order, 'EXIT');
        invariant(terminal(order.status), 'ALGO_CHILD_ORDER_NOT_TERMINAL');
      }
    }
    const rebuilt = this.book.rebuild(plan);
    if (!rebuilt) return { status: 'NO_FILL', newEntriesBlocked: !terminal(entry.status) };
    invariant(units(rebuilt.quantity) === units(venuePosition.quantity), 'VENUE_AND_FILL_QUANTITY_MISMATCH');
    const position = await this.book.save(rebuilt);
    await this.finishOperations(plan);
    return { status: position.status, position: this.book.positions.get(plan.id), newEntriesBlocked: !terminal(entry.status) || position.actualRiskExceededPlan };
  }
  async finishOperations(plan) {
    let position = this.book.positions.get(plan.id);
    for (const operation of this.book.operations.values()) {
      if (operation.planId !== plan.id || this.book.control.get(`finished:${operation.id}`)) continue;
      if (position?.strategyManagementSuspended) {
        await this.book.setControl(`finished:${operation.id}`, { status: 'INTERRUPTED_EXTERNAL_ACTIVITY', recoveryId: position.externalRecoveryId ?? null });
        continue;
      }
      // Observation of the required quantity decrease, not POST acceptance,
      // commits the R22 stage. A stopped-out position never opens a new stage.
      if (units(position.quantity) > units(operation.targetQuantity)) continue;
      if (position.status === 'OPEN' && operation.flag) {
        position = await this.book.save({ ...position, [operation.flag]: true, stage: operation.stage,
          pendingAggregateFloor: Math.max(position.pendingAggregateFloor ?? 0, operation.aggregateFloor ?? 0) });
      }
      await this.book.setControl(`finished:${operation.id}`, true);
    }
  }
  async resumeOperations(plan) {
    await this.finishOperations(plan);
    for (const operation of this.book.operations.values()) {
      if (operation.planId !== plan.id || this.book.control.get(`finished:${operation.id}`)) continue;
      const position = this.book.positions.get(plan.id);
      if (!position || position.status !== 'OPEN') continue;
      const id = clientId('close', `${plan.id}:${operation.id}`), intent = this.kernel.intents.get(id);
      if (intent) {
        const result = terminal(intent.result?.status) && !hasUnsafeVenueIdentifier(intent.result) ? intent.result : await this.kernel.reduce(plan, operation.quantity, operation.id);
        // The venue result can become terminal before the following account
        // snapshot rebuilds local quantity. Validate the terminal fill itself;
        // requiring the pre-dispatch ledger view to have already changed turns
        // every successful resumed MARKET reduction into a false incident.
        invariant(!terminal(result.status) || units(result.executedQty ?? '0') === units(operation.quantity), 'TERMINAL_REDUCTION_SHORTFALL_REVIEW_REQUIRED');
        return { status: 'EXISTING_REDUCTION_RECONCILING', result };
      }
      invariant(units(position.quantity) === units(operation.baseQuantity), 'PENDING_OPERATION_POSITION_CHANGED');
      return { status: 'DURABLE_REDUCTION_RESUMED', result: await this.kernel.reduce(plan, operation.quantity, operation.id) };
    }
    return { status: 'NO_PENDING_REDUCTION' };
  }
  async reduce(plan, position, action, quote) {
    invariant(!position.strategyManagementSuspended, 'RECOVERED_POSITION_MANAGEMENT_SUSPENDED');
    invariant(fresh(quote.receivedAt, this.now(), 2000), 'MANAGEMENT_QUOTE_STALE');
    const quantity = units(action.quantity), remaining = units(position.quantity);
    invariant(quantity > 0n && quantity <= remaining, 'MANAGEMENT_QUANTITY_INVALID');
    const unfinished = [...this.book.operations.values()].find(row => row.planId === plan.id && !this.book.control.get(`finished:${row.id}`));
    if (unfinished) {
      const id = clientId('close', `${plan.id}:${unfinished.id}`);
      if (this.kernel.intents.has(id)) return this.kernel.observe(id);
      // An operation durable before a crash but without a network intention
      // may resume only after checking it against current position and fresh BBO.
      invariant(units(unfinished.baseQuantity) === remaining, 'PENDING_OPERATION_POSITION_CHANGED');
      return this.kernel.reduce(plan, unfinished.quantity, unfinished.id);
    }
    const operation = { id: action.operationId ?? `${plan.id}:${action.stage ?? action.reason}:${position.sequence}`, planId: plan.id,
      quantity: decimal(quantity), baseQuantity: position.quantity, targetQuantity: decimal(remaining - quantity), flag: action.flag ?? null,
      stage: action.stage ?? action.reason, aggregateFloor: action.aggregateFloor ?? null, observedQuoteSequence: quote.sequence, at: this.now() };
    await this.book.operation(operation);
    return this.kernel.reduce(plan, operation.quantity, operation.id);
  }
  async protect(plan, position, snapshot, rule, quote, bars) {
    if (this.kernel.activeStopReplacement(plan)) {
      const replacement = await this.kernel.resumeStopReplacement(plan);
      if (replacement.next && this.kernel.validStop(replacement.next, plan, replacement.next.triggerPrice))
        await this.book.save({ ...position, stop: replacement.next.triggerPrice, stopClientId: replacement.next.clientAlgoId });
      return replacement;
    }
    const ownedStops = [...this.kernel.intents.values()].filter(row => row.planId === plan.id && row.kind === 'stop');
    const ids = new Set(ownedStops.map(row => row.params.clientAlgoId));
    const active = snapshot.algos.filter(row => ids.has(row.clientAlgoId) && row.algoStatus === 'NEW');
    const intentsByClientId = new Map(ownedStops.map(row => [row.params.clientAlgoId, row]));
    // The account fanout may observe a newly accepted stop before the direct
    // read-after-write query does. Commit that exact owned venue row so restart
    // reconciliation sees a resolved intent without another mutation.
    for (const row of active) {
      const intent = intentsByClientId.get(row.clientAlgoId);
      if (intent?.result === null) await this.kernel.acceptObservation(intent.id, row);
    }
    const desired = position.stop;
    const valid = active.filter(row => this.kernel.validStop(row, plan, row.triggerPrice));
    // A verified venue stop is the source of truth; its current effective price
    // must never be loosened merely because a local projection was interrupted.
    valid.sort((a, b) => position.direction * (Number(b.triggerPrice) - Number(a.triggerPrice)));
    let old = valid[0];
    if (old) {
      invariant(position.direction === 1 ? Number(old.triggerPrice) >= Number(desired) : Number(old.triggerPrice) <= Number(desired), 'VENUE_PROTECTION_WEAKER_THAN_LEDGER');
      if (String(position.stop) !== String(old.triggerPrice) || position.stopClientId !== old.clientAlgoId) position = await this.book.save({ ...position, stop: old.triggerPrice, stopClientId: old.clientAlgoId });
    } else {
      const attempted = await this.kernel.installStop(plan, String(desired), `repair:${position.stopClientId ?? 'initial'}`);
      if (!this.kernel.validStop(attempted, plan, desired)) {
        return { status: 'PROTECTION_REPAIR_FAILED', close: await this.kernel.emergencyClose(plan, 'protection_watchdog') };
      }
      old = attempted; position = await this.book.save({ ...position, stop: attempted.triggerPrice, stopClientId: attempted.clientAlgoId });
    }
    if (position.strategyManagementSuspended) return { status: 'RECOVERED_POSITION_PROTECTION_ONLY' };
    if (!quote || !fresh(quote.marketTime, this.now(), 2000)) return { status: 'VENUE_PROTECTION_VERIFIED_NO_FRESH_QUOTE' };
    // Startup account reconciliation can precede the exchange-filter cache.
    // Keep verifying/repairing venue protection above; defer discretionary
    // tightening until a rule exists. Invalid supplied rules still fail closed.
    if (rule == null) return { status: 'VENUE_PROTECTION_VERIFIED_RULES_PENDING' };
    position = await this.observeProfitRetention(plan, position, quote);
    const proposal = r22StopProposal(position, { runtime: this.runtimeFor(plan), strategy: this.strategy, bars1h: bars.bars1h, bars15m: bars.bars15m,
      aggregateFloor: position.pendingAggregateFloor ?? null });
    if (!proposal.changed) return { status: 'PROTECTION_VERIFIED' };
    const raw = position.direction === 1 ? quote.bid : quote.ask;
    if (position.direction === 1 ? Number(proposal.proposed.stop) >= Number(raw) : Number(proposal.proposed.stop) <= Number(raw)) {
      return { status: 'PROFIT_FLOOR_CROSSED_CLOSE_REQUESTED', close: await this.reduce(plan, position, { quantity: position.quantity, reason: 'AGGREGATE_FLOOR_CROSSED' }, quote) };
    }
    const price = alignTrigger(String(proposal.proposed.stop), rule, plan.direction, 'STOP', raw, this.now());
    if (price === old.triggerPrice) return { status: 'STOP_ALREADY_ON_GRID' };
    position = await this.book.save({ ...position, desiredStop: price });
    const absentAttempts = ownedStops.filter(row => row.params.triggerPrice === price && row.result?.algoStatus === 'ABSENT_VERIFIED').length;
    const revision = absentAttempts ? `trail:${price}:retry:${absentAttempts}` : `trail:${price}`;
    const result = await this.kernel.tighten(plan, old, price, revision);
    if (result.status.startsWith('PROTECTION_REPLACED') || result.status.startsWith('NEW_STOP_VERIFIED')) await this.book.save({ ...proposal.proposed, stop: price, stopClientId: result.next.clientAlgoId, pendingAggregateFloor: position.pendingAggregateFloor });
    return result;
  }
  async manage(plan, quote, rule) {
    let position = this.book.positions.get(plan.id);
    invariant(position?.status === 'OPEN', 'OPEN_OWNED_POSITION_REQUIRED');
    invariant(!position.strategyManagementSuspended, 'RECOVERED_POSITION_MANAGEMENT_SUSPENDED');
    position = await this.observeProfitRetention(plan, position, quote);
    const action = nextR22Action(position, quote, this.runtimeFor(plan), rule, this.now());
    const maxR = Math.max(position.maximumNetExcursionR, action.netR ?? position.maximumNetExcursionR);
    if (maxR !== position.maximumNetExcursionR) position = await this.book.save({ ...position, maximumNetExcursionR: maxR, runnerMaximumNetExcursionR: position.secondPartialTaken ? Math.max(position.runnerMaximumNetExcursionR, maxR) : position.runnerMaximumNetExcursionR });
    if (action.type === 'HOLD') return action;
    if (action.type === 'DEFER_ZERO_LOT_STAGE') {
      await this.book.operation({ id: `${plan.id}:${action.stage}:${position.sequence}`, planId: plan.id, quantity: '0', baseQuantity: position.quantity, targetQuantity: position.quantity, flag: action.flag, stage: action.stage, aggregateFloor: action.aggregateFloor, at: this.now(), observedQuoteSequence: quote.sequence });
      await this.finishOperations(plan); return action;
    }
    return this.reduce(plan, position, action, quote);
  }
  async portfolio(quotes, equityUsdt, rules) {
    const positions = [...this.book.positions.values()].filter(row => row.status === 'OPEN');
    invariant(!positions.some(p => p.strategyManagementSuspended), 'RECOVERED_POSITION_MANAGEMENT_SUSPENDED');
    for (const position of positions) invariant(fresh(quotes[position.symbol]?.receivedAt, this.now(), 2000), 'PORTFOLIO_QUOTE_INCOMPLETE');
    const marked = positions.map(p => {
      const q = quotes[p.symbol], plan = this.kernel.plans.get(p.id);
      invariant(plan, 'PORTFOLIO_PLAN_REQUIRED');
      const markedNetPnlUsdt = aggregateLiquidationNetR(p, p.direction === 1 ? q.bid : q.ask,
        this.runtimeFor(plan).paperRisk) * p.initialPlannedRiskUsdt;
      invariant(Number.isFinite(markedNetPnlUsdt), 'PORTFOLIO_NET_PNL_INVALID');
      const netR = this.runtime.paperFinalV2 ? netLiquidationR(p, Number(p.direction === 1 ? q.bid : q.ask), this.runtimeFor(plan)) : null;
      const v2MarkedPnl = this.runtime.paperFinalV2 ? p.cumulativeRealizedNetPnl + netR * p.initialRiskPerUnit * Number(p.quantity) : markedNetPnlUsdt;
      invariant(Number.isFinite(v2MarkedPnl), 'PORTFOLIO_V2_VALUATION_INVALID');
      return { ...p, markedNetPnlUsdt: v2MarkedPnl,
        initialRiskUsdt: p.initialPlannedRiskUsdt, initialStage: !p.softLockTaken && !p.firstPartialTaken && (this.runtime.paperFinalV2 ? netR < 0.5 : !p.secondPartialTaken) };
    });
    const priorCampaign = this.book.control.get('r21Campaign');
    let result;
    if (this.runtime.paperFinalV2 === true) {
      const now = this.now();
      const rows = Object.values(quotes).filter(Boolean);
      const first = rows[0];
      const connectionEpoch = { id: first ? `${first.epoch}:${first.connectedAt}` : null,
        connected: rows.length > 0 && rows.every(q => q.continuity === true && q.persisted === true && q.epoch === first.epoch && q.connectedAt === first.connectedAt),
        connectedAt: first?.connectedAt };
      const v2Quotes = Object.fromEntries(Object.entries(quotes).map(([symbol, q]) => [symbol, q ? {
        ...q, bid: Number(q.bid), ask: Number(q.ask),
        connectionEpoch: `${q.epoch}:${q.connectedAt}` } : null]));
      const closedPositions = [...this.book.positions.values()].filter(p => p.status === 'CLOSED');
      const priorState = priorCampaign?.state?.schemaVersion === 2 ? priorCampaign.state : null;
      result = (this.runtime.r22Rollback ? evaluateR22ProfitProtection : evaluateV2R21ProfitProtection)({ priorState, positions: marked.map(p => ({ ...p,
        r21DefenseReductionTaken: [...this.book.operations.values()].some(op => op.planId === p.id && op.stage === 'R21_REDUCE_INITIAL') })),
        closedPositions, quotes: v2Quotes, equityUsdt, now, localNow: now, connectionEpoch,
        config: this.runtime.portfolioProfitProtection });
    } else {
    const priorState = structuredClone(priorCampaign?.state ?? initialR21State(this.now()));
    // Changing membership changes the valuation base. Start a new comparable
    // cohort; closing a profitable leg is not a price drawdown in the others.
    for (const [label, direction] of [['LONG', 1], ['SHORT', -1]]) {
      const cohortKey = marked.filter(p => p.direction === direction && isR21EligibleSymbol(p.symbol, this.runtime.portfolioProfitProtection)).map(p => p.id).sort().join('|');
      const campaign = priorState.campaigns[label];
      if (campaign.cohortKey !== cohortKey) priorState.campaigns[label] = {
        ...initialR21State(this.now()).campaigns[label], cohortKey, freezeUntil: campaign.freezeUntil };
    }
    result = evaluateR21ProfitProtection({ priorState, positions: marked, quotes, equityUsdt, now: this.now(), config: this.runtime.portfolioProfitProtection });
    }
    // Persist campaign and actions before execution, so tier changes survive crashes.
    let queued = [...(priorCampaign?.actions ?? []), ...result.actions.map(action => ({ ...action, id: clientId('campaign', action.actionId ?? `${this.now()}:${JSON.stringify(action)}`) }))];
    queued = [...new Map(queued.map(action => [action.id, action])).values()];
    invariant(queued.every(action => typeof action.id === 'string' && action.id.length > 0) && new Set(queued.map(action => action.id)).size === queued.length, 'R21_ACTION_ID_MISSING_OR_DUPLICATE');
    await this.book.setControl('r21Campaign', { state: result.state, actions: queued, evidence: result.evidence ?? null });
    const remove = async (action, status) => {
      await this.book.setControl(`r21Action:${action.id}`, { status, operationId: this.book.operations.has(action.id) ? action.id : null });
      queued = queued.filter(row => row.id !== action.id);
      await this.book.setControl('r21Campaign', { state: result.state, actions: queued, evidence: result.evidence ?? null });
    };
    if (result.state.evidenceHold === true) return result;
    for (const action of [...queued]) {
      const completed = this.book.control.get(`r21Action:${action.id}`);
      if (completed) { await remove(action, completed.status); continue; }
      // The stable campaign action ID IS the durable management operation ID.
      // If a crash follows a venue fill but precedes queue removal, replay sees
      // this operation and never creates a second 25% reduction.
      if (this.book.operations.has(action.id)) { await remove(action, 'DURABLE_OPERATION_ALREADY_RECORDED'); continue; }
      const p = this.book.positions.get(action.positionId);
      if (!p || p.status !== 'OPEN' || p.softLockTaken || p.firstPartialTaken || p.secondPartialTaken) { await remove(action, 'INITIAL_STAGE_NO_LONGER_ELIGIBLE'); continue; }
      invariant(action.symbol === p.symbol && action.direction === p.direction && ['CLOSE_INITIAL', 'REDUCE_INITIAL'].includes(action.type) && (action.type !== 'REDUCE_INITIAL' || action.fractionOfOriginal === 0.25), 'R21_ACTION_SCOPE_INVALID');
      if ([...this.book.operations.values()].some(op => op.planId === p.id && !this.book.control.get(`finished:${op.id}`))) return { ...result, pendingDispatch: true };
      const rule = freshRules(rules[p.symbol], p.symbol, this.now()), plan = this.kernel.plans.get(p.id);
      const raw = action.type === 'CLOSE_INITIAL' ? p.quantity : decimal(units(p.originalQuantity) * 25n / 100n);
      if (units(raw) < units(rule.marketLot.min)) { await remove(action, 'REDUCTION_BELOW_LEGAL_LOT'); continue; }
      const quantity = align(raw, rule.marketLot, 'DOWN');
      await this.reduce(plan, p, { quantity, reason: `R21_${action.type}`, operationId: action.id }, quotes[p.symbol]);
      invariant(this.book.operations.has(action.id), 'R21_OPERATION_NOT_DURABLE');
      await remove(action, 'DURABLE_OPERATION_DISPATCHED');
    }
    return result;
  }
  async cleanupFlat(plan, snapshot) {
    invariant(this.book.positions.get(plan.id)?.status === 'CLOSED', 'CLOSED_LEDGER_POSITION_REQUIRED');
    invariant(!snapshot.positions.some(row => row.symbol === plan.symbol && units(String(row.positionAmt).replace(/^-/, '')) > 0n), 'VENUE_NOT_FLAT');
    for (const intent of this.kernel.intents.values()) {
      if (intent.planId !== plan.id || intent.kind !== 'stop') continue;
      if (!snapshot.algos.some(row => row.clientAlgoId === intent.params.clientAlgoId)) continue;
      await this.kernel.once('cancel', `${plan.id}:flat:${intent.params.clientAlgoId}`, 'DELETE', '/fapi/v1/algoOrder', { symbol: plan.symbol, clientAlgoId: intent.params.clientAlgoId }, plan.id);
    }
    // Keep replacement admission blocked until fills rebuilt CLOSED and a later
    // complete snapshot confirms all owned live protection has been cleaned up.
    const replacement = this.kernel.activeStopReplacement(plan);
    if (replacement?.phase === 'FLAT_RECONCILING'
      && !snapshot.algos.some(row => this.kernel.intents.get(row.clientAlgoId)?.planId === plan.id))
      await this.kernel.settleFlatStopReplacement(plan);
  }
}
