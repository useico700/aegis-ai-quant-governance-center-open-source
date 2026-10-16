import { hasUnsafeVenueIdentifier } from '../../../lib/exchange-json.mjs';
import { units, decimal } from '../../../lib/s1-precision.mjs';
import { clientId, closeSide, entrySide, hash, invariant, terminal } from './common.mjs';
import { validateMutation } from './transport.mjs';
import { startReplacement, resumeReplacement, replacementFor, bridgeMatches, closingBridgeMatches } from './stop-replacement.mjs';

export const EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS = 3;
export const hasDispatchProtocol = intent => ['MARKER_V1', 'MARKER_V2_NETWORK'].includes(intent?.dispatchProtocol);
const entryConfirmationDeferral = reason => (typeof reason === 'string' && (/^ENTRY_CONFIRMATION_[A-Z0-9_]+$/.test(reason) || reason === 'ENTRY_PLAN_EXPIRED'))
  && !/MISMATCH|CONFLICT|INTEGRITY|HISTORICAL/.test(reason);

// R22 deliberately has no adaptive entryConfirmation. Unsent proof is a
// dispatch/ledger property, not an adaptive strategy feature.
const releasableEntryPolicy = plan => !!plan?.entryConfirmation
  || (plan?.schema === 'S1_VALIDATED_ENTRY_V1'
    && plan.revision === 'MTFX-0.5.0-R22-BALANCED-PROFIT-REALIZATION');

const safeResponse = row => Object.fromEntries(['symbol', 'side', 'positionSide', 'type', 'orderType', 'status', 'algoStatus', 'orderId', 'algoId', 'actualOrderId', 'clientOrderId', 'clientAlgoId', 'origQty', 'quantity', 'executedQty', 'avgPrice', 'cumQuote', 'triggerPrice', 'closePosition', 'workingType', 'priceProtect', 'updateTime', 'exchangeCode'].filter(key => row?.[key] !== undefined).map(key => [key, row[key]]));

// Dependency-injected transaction kernel. It accepts only a separately validated
// immutable plan. A scanner snapshot is NOT a plan and cannot pass prepareEntry.
// No runtime, credentials, account discovery, or automatic activation lives here.
export class ExecutionKernel {
  constructor({ journal, transport, gates, now = Date.now }) {
    this.journal = journal; this.transport = transport; this.gates = gates; this.now = now;
    this.intents = new Map(); this.plans = new Map(); this.dispatchStarted = new Set(); this.stopReplacements = new Map(); this.emergencyCloseChains = new Map(); this.entryReleaseGenerations = new Map(); this.activeReservations = new Map(); this.historicalActivityPlans = new Set(); this.busy = false;
    for (const event of journal.events) this.project(event);
  }
  project(event) {
    if (event.type === 'STOP_REPLACEMENT_STATE') this.stopReplacements.set(event.state.id, event.state);
    if (event.type === 'EMERGENCY_CLOSE_STATE') this.emergencyCloseChains.set(event.state.rootClientId, event.state);
    if (event.type === 'VENUE_FILL' || event.type === 'EXTERNAL_POSITION_EXIT') this.historicalActivityPlans.add(event.planId);
    if (event.type === 'POSITION_VIEW') this.historicalActivityPlans.add(event.position.id);
    if (event.type === 'PLAN_RESERVED') {
      const generation = event.reservationGeneration ?? 0;
      invariant(generation === (this.entryReleaseGenerations.get(event.plan.id) ?? 0), 'ENTRY_RESERVATION_GENERATION_MISMATCH');
      this.plans.set(event.plan.id, event.plan);
      this.activeReservations.set(event.plan.id, { generation, fingerprint: event.plan.fingerprint });
    }
    if (event.type === 'ENTRY_PRE_DISPATCH_RELEASED') {
      const plan = this.plans.get(event.planId), reservation = this.activeReservations.get(event.planId);
      invariant(releasableEntryPolicy(plan) && event.planFingerprint === plan.fingerprint && reservation?.generation === event.reservationGeneration
        && event.entryIntentId === clientId('entry', plan.id) && this.entryReleaseProof(plan, false) === event.proof,
      'ENTRY_RELEASE_PROOF_MISMATCH');
      this.plans.delete(plan.id); this.intents.delete(event.entryIntentId); this.activeReservations.delete(plan.id);
      this.entryReleaseGenerations.set(plan.id, event.reservationGeneration + 1);
    }
    if (event.type === 'INTENT') this.intents.set(event.id, { ...event, result: null });
    if (event.type === 'DISPATCH_STARTED') {
      invariant(this.intents.has(event.id), 'DISPATCH_WITHOUT_INTENT'); this.dispatchStarted.add(event.id);
    }
    if (event.type === 'OBSERVED') {
      invariant(this.intents.has(event.id), 'OBSERVATION_WITHOUT_INTENT');
      this.intents.get(event.id).result = event.result;
    }
  }
  async record(event) { await this.journal.append(event); this.project(event); }
  async serial(fn) {
    invariant(!this.busy, 'SINGLE_WRITER_BUSY'); this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async acceptObservation(id, row) {
    const intent = this.intents.get(id);
    invariant(intent, 'INTENT_MISSING');
    const algo = intent.path.endsWith('/algoOrder');
    const params = { symbol: intent.params.symbol, [algo ? 'clientAlgoId' : 'origClientOrderId']: intent.params[algo ? 'clientAlgoId' : 'newClientOrderId'] ?? intent.params.origClientOrderId };
    invariant(row?.symbol === params.symbol, 'ORDER_SYMBOL_MISMATCH');
    const actualId = row[algo ? 'clientAlgoId' : 'clientOrderId'];
    invariant(actualId === params[algo ? 'clientAlgoId' : 'origClientOrderId'], 'ORDER_CLIENT_ID_MISMATCH');
    if (intent.method === 'POST') {
      invariant(row.positionSide === intent.params.positionSide && row.side === intent.params.side, 'ORDER_SIDE_MISMATCH');
      invariant((row.orderType ?? row.type) === intent.params.type, 'ORDER_TYPE_MISMATCH');
      if (!algo) {
        invariant(units(row.origQty) === units(intent.params.quantity) && units(row.executedQty) <= units(row.origQty), 'ORDER_QUANTITY_MISMATCH');
        const previous = intent.result?.executedQty;
        invariant(previous === undefined || units(row.executedQty) >= units(previous), 'EXECUTED_QUANTITY_REGRESSION');
      }
    }
    invariant(!hasUnsafeVenueIdentifier(row), 'ORDER_IDENTIFIER_PRECISION_UNSAFE');
    const result = safeResponse(row);
    if (hash(intent.result) !== hash(result)) await this.record({ type: 'OBSERVED', id, at: this.now(), result });
    return result;
  }
  async observe(id) {
    const intent = this.intents.get(id);
    invariant(intent, 'INTENT_MISSING');
    const algo = intent.path.endsWith('/algoOrder');
    const params = { symbol: intent.params.symbol, [algo ? 'clientAlgoId' : 'origClientOrderId']: intent.params[algo ? 'clientAlgoId' : 'newClientOrderId'] ?? intent.params.origClientOrderId };
    try {
      const row = await this.transport.request('GET', intent.path, params);
      return this.acceptObservation(id, row);
    } catch (error) {
      // A not-found response is not evidence that a timed-out order was rejected.
      // Leave risk reserved and prevent resubmission, including after restart.
      if (this.journal.failed) throw error;
      return { unresolved: true, id };
    }
  }
  async once(kind, identity, method, pathname, params, planId, purpose = 'STANDARD') {
    const id = clientId(kind, identity);
    if (this.intents.has(id)) {
      const old = this.intents.get(id);
      invariant(old.method === method && old.path === pathname && hash(old.params) === hash(params) && (old.purpose ?? 'STANDARD') === purpose, 'INTENT_ID_PAYLOAD_CONFLICT');
      const stable = old.path.endsWith('/algoOrder')
        ? (old.method === 'DELETE' ? ['CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED', 'ABSENT_VERIFIED']
          : ['NEW', 'CANCELED', 'FINISHED', 'REJECTED', 'EXPIRED', 'ABSENT_VERIFIED']).includes(old.result?.algoStatus)
        : terminal(old.result?.status);
      if (stable && !hasUnsafeVenueIdentifier(old.result)) return old.result;
      // Marker V1 proves whether an fsynced intent crossed the dispatch
      // boundary. A pre-dispatch gate failure may safely retry the same intent;
      // after the marker exists, a POST is never repeated and only observation
      // by durable client ID is allowed. Legacy intents have no such proof and
      // remain query-only.
      if (old.result !== null || !hasDispatchProtocol(old) || this.dispatchStarted.has(id)) return this.observe(id);
      await this.gates({ kind, planId, params, intentId: id, method, path: pathname, purpose, now: this.now() });
      return this.dispatchIntent(id, method, pathname, params);
    }
    validateMutation(method, pathname, params);
    invariant(purpose === 'STANDARD' || (purpose === 'PROTECTIVE_EMERGENCY' && kind === 'close'), 'INTENT_PURPOSE_INVALID');
    await this.gates({ kind, planId, params, intentId: id, method, path: pathname, purpose, now: this.now() });
    await this.record({ type: 'INTENT', id, kind, planId, method, path: pathname, params, purpose,
      dispatchProtocol: this.transport.supportsDispatchBoundary === true ? 'MARKER_V2_NETWORK' : 'MARKER_V1', at: this.now() });
    // Revalidate after fsync as well. A gate closing here leaves a deliberately
    // unresolved intent, never an automatically retried entry.
    await this.gates({ kind, planId, params, intentId: id, method, path: pathname, purpose, now: this.now() });
    return this.dispatchIntent(id, method, pathname, params);
  }
  async dispatchIntent(id, method, pathname, params) {
    const networkBoundary = this.intents.get(id)?.dispatchProtocol === 'MARKER_V2_NETWORK';
    const beforeDispatch = async () => {
      invariant(!this.journal.failed && !this.dispatchStarted.has(id), 'DISPATCH_BOUNDARY_ALREADY_USED');
      await this.record({ type: 'DISPATCH_STARTED', id, at: this.now() });
    };
    if (networkBoundary) invariant(this.transport.supportsDispatchBoundary === true, 'NETWORK_DISPATCH_BOUNDARY_REQUIRED');
    else await beforeDispatch();
    return this.dispatchAndObserve(id, method, pathname, params, networkBoundary ? { beforeDispatch } : undefined);
  }
  async dispatchAndObserve(id, method, pathname, params, dispatch) {
    let response;
    try { response = await this.transport.request(method, pathname, params, dispatch); }
    catch (error) {
      if (this.journal.failed) throw error;
      if (dispatch && !this.dispatchStarted.has(id)) {
        // V2 has durable proof that the actual network boundary was not crossed.
        // Keep the same immutable intent retryable; never turn a local budget
        // refusal into a venue observation or infer this for old V1 markers.
        throw new Error(/^[A-Z][A-Z0-9_]{0,95}$/.test(error?.message ?? '') ? error.message : 'MUTATION_PRE_DISPATCH_FAILED');
      }
      if (error?.message === 'MUTATION_REJECTED') {
        const algo = pathname.endsWith('/algoOrder');
        response = algo ? { ...params, algoStatus: 'REJECTED', exchangeCode: error.exchangeCode ?? null }
          : { ...params, clientOrderId: params.newClientOrderId, origQty: params.quantity,
            executedQty: '0', status: 'REJECTED', exchangeCode: error.exchangeCode ?? null };
      }
      // Ambiguous transport failures are queried by durable client ID below;
      // a signed deterministic 4xx is a confirmed zero-fill rejection.
    }
    invariant(!dispatch || this.dispatchStarted.has(id), 'NETWORK_DISPATCH_BOUNDARY_NOT_RECORDED');
    if (response !== undefined) {
      try { return await this.acceptObservation(id, response); }
      catch (error) {
        // A complete successful venue response is authoritative and avoids a
        // read-after-write visibility race. If it is malformed, query the
        // durable ID instead; persistence failures still stop immediately.
        if (this.journal.failed) throw error;
      }
    }
    return this.observe(id);
  }
  unresolvedEntries() {
    return [...this.intents.values()].filter(row => row.kind === 'entry' && !terminal(row.result?.status));
  }
  entryReleaseProof(plan, inspectJournal = true) {
    if (!releasableEntryPolicy(plan) || this.plans.get(plan.id)?.fingerprint !== plan.fingerprint
      || this.historicalActivityPlans.has(plan.id)) return null;
    const id = clientId('entry', plan.id), intent = this.intents.get(id);
    if (this.dispatchStarted.has(id) || [...this.intents.values()].some(i => i.planId === plan.id && i.id !== id)) return null;
    if (intent && (intent.planId !== plan.id || intent.kind !== 'entry' || intent.method !== 'POST'
      || intent.path !== '/fapi/v1/order' || intent.params.newClientOrderId !== id
      || !hasDispatchProtocol(intent) || intent.result !== null)) return null;
    // PositionLedger writes through the same journal. Its events need not have
    // been projected by this kernel in-process; check them before committing a
    // release. Replay uses only preceding projected events, never future ones.
    if (inspectJournal) for (const event of this.journal.events) {
      if ((['VENUE_FILL', 'EXTERNAL_POSITION_EXIT'].includes(event.type) && event.planId === plan.id)
        || (event.type === 'POSITION_VIEW' && event.position.id === plan.id)) return null;
    }
    return intent ? `UNSENT_${intent.dispatchProtocol}` : 'NO_ENTRY_INTENT';
  }
  async releaseUnsentEntry(plan, reason) {
    if (!entryConfirmationDeferral(reason)) return false;
    const proof = this.entryReleaseProof(plan);
    if (!proof) return false;
    const reservation = this.activeReservations.get(plan.id);
    await this.record({ type: 'ENTRY_PRE_DISPATCH_RELEASED', planId: plan.id, planFingerprint: plan.fingerprint,
      entryIntentId: clientId('entry', plan.id), reservationGeneration: reservation.generation, proof, reason, at: this.now() });
    return true;
  }
  async releaseAbandonedEntryReservations() {
    // A crash can occur after reservation/intent fsync but before the gate's
    // rejection is caught. Never send that draft on restart: retire only its
    // proven-unsent generation, then require a completely fresh normal entry.
    for (const plan of [...this.plans.values()]) {
      if (this.entryReleaseProof(plan, false)) await this.releaseUnsentEntry(plan, 'ENTRY_CONFIRMATION_INTERRUPTED_BEFORE_DISPATCH');
    }
  }
  async enter(plan) {
    return this.serial(async () => {
      invariant(plan?.schema === 'S1_VALIDATED_ENTRY_V1' && plan.fingerprint === hash({ ...plan, fingerprint: undefined }), 'VALIDATED_PLAN_REQUIRED');
      invariant(!this.plans.has(plan.id), 'INTERSECTION_ALREADY_CONSUMED');
      invariant(this.unresolvedEntries().length === 0, 'UNRESOLVED_ENTRY_BLOCKS_NEW_ENTRIES');
      try { await this.gates({ kind: 'reserve', plan, now: this.now() }); }
      catch (error) {
        if (plan.entryConfirmation && entryConfirmationDeferral(error.message)) return { status: 'ENTRY_CONFIRMATION_DEFERRED',
          reason: error.message, planId: plan.id, releasedReservationGeneration: null };
        throw error;
      }
      await this.record({ type: 'PLAN_RESERVED', at: this.now(), plan, reservationGeneration: this.entryReleaseGenerations.get(plan.id) ?? 0 });
      const id = clientId('entry', plan.id);
      let result;
      try { result = await this.once('entry', plan.id, 'POST', '/fapi/v1/order', {
        symbol: plan.symbol, positionSide: plan.direction, side: entrySide(plan.direction), type: 'LIMIT', timeInForce: 'IOC',
        quantity: plan.quantity, price: plan.price, newOrderRespType: 'RESULT', newClientOrderId: id,
      }, plan.id); }
      catch (error) {
        if (await this.releaseUnsentEntry(plan, error.message)) return { status: 'ENTRY_CONFIRMATION_DEFERRED', reason: error.message,
          planId: plan.id, releasedReservationGeneration: (this.entryReleaseGenerations.get(plan.id) ?? 1) - 1 };
        throw error;
      }
      return this.protectEntry(plan, result);
    });
  }
  async protectEntry(plan, entry) {
    if (entry.unresolved) return { status: 'ENTRY_UNRESOLVED', entry };
    if (units(entry.executedQty) === 0n) return { status: terminal(entry.status) ? 'NO_FILL' : 'ENTRY_UNRESOLVED', entry };
    // Install protection for any positive fill even before IOC terminality.
    // closePosition covers subsequent late partial fills without resizing.
    const protection = await this.installStop(plan, plan.stopPrice, 'initial');
    if (!this.validStop(protection, plan, plan.stopPrice)) {
      const close = await this.emergencyClose(plan, 'initial_protection_failure');
      return { status: close.status === 'FLAT_VERIFIED' ? 'PROTECTION_FAILED_FLAT' : 'CRITICAL_UNPROTECTED_OR_UNRESOLVED', entry, protection, close };
    }
    return { status: terminal(entry.status) ? 'PROTECTED_FILL_AWAITING_ACCOUNTING' : 'PROTECTED_ENTRY_UNRESOLVED', entry, protection };
  }
  validStop(row, plan, stopPrice) {
    try {
      return row?.algoStatus === 'NEW' && row.symbol === plan.symbol && row.positionSide === plan.direction && row.side === closeSide(plan.direction)
        && (row.orderType ?? row.type) === 'STOP_MARKET' && String(row.closePosition) === 'true'
        && row.workingType === 'CONTRACT_PRICE' && String(row.priceProtect) === 'false' && units(row.triggerPrice) === units(stopPrice);
    } catch { return false; }
  }
  async installStop(plan, stopPrice, revision) {
    const identity = `${plan.id}:${revision}`;
    return this.once('stop', identity, 'POST', '/fapi/v1/algoOrder', {
      symbol: plan.symbol, side: closeSide(plan.direction), positionSide: plan.direction, algoType: 'CONDITIONAL', type: 'STOP_MARKET',
      triggerPrice: stopPrice, closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: clientId('stop', identity),
    }, plan.id);
  }
  async position(plan) {
    const rows = await this.transport.request('GET', '/fapi/v2/positionRisk', { symbol: plan.symbol });
    invariant(Array.isArray(rows), 'POSITION_SNAPSHOT_INVALID');
    const matches = rows.filter(row => row.symbol === plan.symbol && row.positionSide === plan.direction);
    invariant(matches.length === 1, 'POSITION_SNAPSHOT_AMBIGUOUS');
    const amount = String(matches[0].positionAmt);
    invariant(plan.direction === 'SHORT' || !amount.startsWith('-'), 'POSITION_SIGN_INVALID');
    invariant(plan.direction === 'LONG' || amount.startsWith('-') || units(amount) === 0n, 'POSITION_SIGN_INVALID');
    const quantity = decimal(units(amount.replace(/^-/, '')));
    invariant(units(quantity) <= units(plan.quantity), 'UNEXPECTED_POSITION_INCREASE');
    return { quantity, row: matches[0] };
  }
  async emergencyClose(plan, reason) {
    // Resolve/cancel outstanding entry first, or it could fill after a close.
    const entryIntent = this.intents.get(clientId('entry', plan.id));
    if (entryIntent && !terminal(entryIntent.result?.status)) {
      await this.once('cancel', `${plan.id}:entry`, 'DELETE', '/fapi/v1/order', { symbol: plan.symbol, origClientOrderId: clientId('entry', plan.id) }, plan.id);
      const entry = await this.observe(entryIntent.id);
      if (!terminal(entry.status)) return { status: 'ENTRY_CANCEL_UNRESOLVED' };
    }
    let position;
    try { position = await this.position(plan); } catch { return { status: 'POSITION_UNRESOLVED' }; }
    if (units(position.quantity) === 0n) return { status: 'FLAT_VERIFIED' };
    const rootIdentity = `${plan.id}:${reason}`, rootClientId = clientId('close', rootIdentity);
    const paramsFor = (identity, quantity) => ({ symbol: plan.symbol, positionSide: plan.direction, side: closeSide(plan.direction),
      type: 'MARKET', quantity, newOrderRespType: 'RESULT', newClientOrderId: clientId('close', identity) });
    let state = this.emergencyCloseChains.get(rootClientId);
    if (!state) {
      // Keep compatibility with an already-dispatched pre-chain emergency ID.
      const params = this.intents.get(rootClientId)?.params ?? paramsFor(rootIdentity, position.quantity);
      state = { schema: 'S1_BOUNDED_EMERGENCY_CLOSE_V1', rootClientId, planId: plan.id, reason,
        identity: rootIdentity, clientId: rootClientId, previousClientId: null, attempt: 1, params };
      await this.record({ type: 'EMERGENCY_CLOSE_STATE', state, at: this.now() });
    }
    invariant(state.planId === plan.id && state.attempt >= 1 && state.attempt <= EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS, 'EMERGENCY_CLOSE_STATE_INVALID');
    const existing = this.intents.get(state.clientId);
    const dispatched = existing && (this.dispatchStarted.has(existing.id) || existing.result !== null || !hasDispatchProtocol(existing));
    if (dispatched) {
      // Unknown/nonterminal outcomes are query-only, regardless of current venue
      // quantity. A new residual ID requires a fresh terminal observation.
      const prior = await this.observe(state.clientId);
      if (prior.unresolved || !terminal(prior.status)) return { status: 'CLOSE_UNRESOLVED', result: prior, attempt: state.attempt };
      try { position = await this.position(plan); } catch { return { status: 'POSITION_UNRESOLVED' }; }
      if (units(position.quantity) === 0n) return { status: 'FLAT_VERIFIED', result: prior, attempt: state.attempt };
      if (state.attempt >= EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS)
        return { status: 'CLOSE_ATTEMPTS_EXHAUSTED', result: prior, attempt: state.attempt, remainingQuantity: position.quantity, newEntriesBlocked: true };
      invariant(units(prior.origQty) === units(state.params.quantity)
        && units(prior.executedQty) < units(prior.origQty)
        && units(position.quantity) <= units(prior.origQty) - units(prior.executedQty), 'EMERGENCY_CLOSE_REMAINDER_RECONCILIATION_REQUIRED');
      // Another owned protective child may also have filled. This is only an
      // upper bound; once() still requires the fresh owned-mutation gate to
      // prove exact remaining quantity across all close/child/external fills.
      // An unexplained smaller venue position never authorizes a residual.
      const identity = `${rootIdentity}:residual:${state.clientId}`;
      state = { ...state, identity, clientId: clientId('close', identity), previousClientId: state.clientId,
        previousStatus: prior.status, previousExecutedQty: prior.executedQty, attempt: state.attempt + 1,
        params: paramsFor(identity, position.quantity) };
      // Fsync the lineage and exact remaining quantity before creating its
      // ordinary INTENT/DISPATCH marker. At most one new POST per invocation.
      await this.record({ type: 'EMERGENCY_CLOSE_STATE', state, at: this.now() });
    }
    const result = await this.once('close', state.identity, 'POST', '/fapi/v1/order', state.params, plan.id, 'PROTECTIVE_EMERGENCY');
    try {
      const after = await this.position(plan);
      const status = units(after.quantity) === 0n && terminal(result.status) ? 'FLAT_VERIFIED'
        : terminal(result.status) && state.attempt >= EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS ? 'CLOSE_ATTEMPTS_EXHAUSTED' : 'CLOSE_UNRESOLVED';
      return { status, result, attempt: state.attempt, remainingQuantity: after.quantity };
    } catch { return { status: 'CLOSE_UNRESOLVED', result }; }
  }
  async tighten(plan, oldStop, newPrice, revision) {
    return this.serial(() => startReplacement(this, plan, oldStop, newPrice, revision));
  }
  activeStopReplacement(plan) { return replacementFor(this, plan); }
  isReplacementBridge(row, plan, quantity) { return bridgeMatches(this, row, plan, quantity); }
  isClosingReplacementBridge(row, plan, quantity) { return closingBridgeMatches(this, row, plan, quantity); }
  async settleFlatStopReplacement(plan) {
    return this.serial(async () => {
      const state = this.activeStopReplacement(plan);
      if (!state) return;
      invariant(state.phase === 'FLAT_RECONCILING' && units((await this.position(plan)).quantity) === 0n, 'REPLACEMENT_FLAT_RECONCILIATION_REQUIRED');
      await this.record({ type: 'STOP_REPLACEMENT_STATE', state: { ...state, phase: 'FLAT', updatedAt: this.now() } });
    });
  }
  async resumeStopReplacement(plan) { return this.serial(() => resumeReplacement(this, plan)); }
  async reduce(plan, quantity, operationId) {
    return this.serial(async () => {
      invariant(this.plans.has(plan.id), 'OWN_PLAN_REQUIRED');
      invariant(!this.activeStopReplacement(plan), 'STOP_REPLACEMENT_PENDING');
      const identity = `${plan.id}:${operationId}`, id = clientId('close', identity);
      // Once persisted, query the ORIGINAL payload, even if a partial fill has
      // reduced the venue quantity. Never mutate an old intention's quantity.
      if (this.intents.has(id)) return this.once('close', identity, 'POST', '/fapi/v1/order', this.intents.get(id).params, plan.id);
      const current = await this.position(plan);
      // The exchange stop may win the race with quote-only STOP_FIRST. No
      // intent exists yet: reconcile its owned child fill before any retry.
      // A positive but insufficient quantity still requires incident review.
      if (units(quantity) > 0n && units(current.quantity) === 0n)
        throw new Error('REDUCTION_VENUE_FLAT_RECONCILE_REQUIRED');
      invariant(units(quantity) > 0n && units(quantity) <= units(current.quantity), 'REDUCTION_EXCEEDS_POSITION');
      return this.once('close', identity, 'POST', '/fapi/v1/order', { symbol: plan.symbol, positionSide: plan.direction, side: closeSide(plan.direction), type: 'MARKET', quantity,
        newOrderRespType: 'RESULT', newClientOrderId: id }, plan.id);
    });
  }
  async recover() {
    return this.serial(async () => {
      const results = [];
      for (const plan of this.plans.values()) {
        const id = clientId('entry', plan.id);
        if (!this.intents.has(id)) { results.push({ id: plan.id, status: 'RESERVED_BEFORE_CRASH_NO_RESUBMISSION' }); continue; }
        const entry = await this.observe(id);
        // Recovery never creates another entry. Full reconciliation must decide
        // ownership, fills, dynamic stop revision and ledger projection first.
        results.push({ id: plan.id, entry, status: 'RECOVERY_RECONCILIATION_REQUIRED' });
      }
      return results;
    });
  }
}
