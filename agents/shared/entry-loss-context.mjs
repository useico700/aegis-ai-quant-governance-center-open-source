import { createHash } from 'node:crypto';
import { units } from '../../lib/s1-precision.mjs';
import { hasUnsafeVenueIdentifier } from '../../lib/exchange-json.mjs';

const signed = value => String(value).startsWith('-') ? -units(String(value).slice(1)) : units(String(value));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const unknown = (planId = null, closedAt = null) => ({ evidenceComplete: false, planId, closedAt, reason: 'RECENT_EXIT_EVIDENCE_UNKNOWN' });

// Pure account-local projection. No exchange calls, durable mutations, global
// entry pause or management gate. A later completed trade replaces older loss
// context; another direction/account cannot inherit it.
export function buildEntryLossContext({ account, symbol, direction, book, kernel, now = Date.now() }) {
  try {
    if (!['S1', 'S2'].includes(account) || !['LONG', 'SHORT'].includes(direction)
      || !(book?.positions instanceof Map) || !(kernel?.plans instanceof Map)) return unknown();
    const d = direction === 'LONG' ? 1 : -1;
    const candidates = [...book.positions.values()].filter(p => p.symbol === symbol && p.direction === d && p.status === 'CLOSED');
    if (!candidates.length) return null;
    if (candidates.some(p => !Number.isSafeInteger(p.closedAt) || p.closedAt <= 0 || p.closedAt > now)) return unknown();
    candidates.sort((a, b) => b.closedAt - a.closedAt || String(a.id).localeCompare(String(b.id)));
    const latest = candidates[0], plan = kernel.plans.get(latest.id);
    if (candidates[1]?.closedAt === latest.closedAt || !plan || plan.schema !== `${account}_VALIDATED_ENTRY_V1`
      || plan.symbol !== symbol || plan.direction !== direction) return unknown(latest.id, latest.closedAt);
    const rebuilt = book.rebuild(plan);
    if (!rebuilt || rebuilt.status !== 'CLOSED' || units(rebuilt.quantity) !== 0n || rebuilt.closedAt !== latest.closedAt
      || rebuilt.accountingComplete !== true || rebuilt.fundingAttributionComplete !== true) return unknown(latest.id, latest.closedAt);
    const net = signed(rebuilt.exact.realizedNetUsdt) + signed(rebuilt.fundingNetUsdt);
    if (net >= 0n) return null;
    if (units(rebuilt.exact.externalClosedQuantity ?? '0') > 0n) return unknown(latest.id, latest.closedAt);
    const exits = [...book.fills.values()].filter(e => e.planId === plan.id && e.role === 'EXIT');
    if (!exits.length) return unknown(latest.id, latest.closedAt);
    const owned = [...kernel.intents.values()].filter(i => i.planId === plan.id && i.id.startsWith(`${account.toLowerCase()}_`) && i.method === 'POST'
      && i.params?.symbol === symbol && i.params.positionSide === direction
      && i.params.side === (direction === 'LONG' ? 'SELL' : 'BUY'));
    const stopIds = new Set(), closeIds = new Set(), stopEvidence = [];
    const add = (intent, result) => {
      if (!result || result.unresolved || hasUnsafeVenueIdentifier(result)
        || result.symbol !== symbol || result.positionSide !== direction
        || result.side !== (direction === 'LONG' ? 'SELL' : 'BUY')) return;
      if (intent.kind === 'stop' && /^\d+$/.test(String(result.actualOrderId)) && String(result.actualOrderId) !== '0') {
        stopIds.add(String(result.actualOrderId));
        stopEvidence.push({ intentId: intent.id, orderId: String(result.actualOrderId) });
      }
      if (intent.kind === 'close' && /^\d+$/.test(String(result.orderId))) {
        closeIds.add(String(result.orderId));
        const operation = [...book.operations.values()].find(op => op.planId === plan.id
          && `${account.toLowerCase()}_close_${digest(`${plan.id}:${op.id}`).slice(0, 26)}` === intent.id);
        if (operation?.stage === 'STOP_FIRST') {
          stopIds.add(String(result.orderId)); stopEvidence.push({ intentId: intent.id, orderId: String(result.orderId), operationId: operation.id });
        }
      }
    };
    for (const intent of owned) add(intent, intent.result);
    // Usually current intent projection is sufficient. A later cancel read may
    // omit an already observed child ID; only then replay that owned history.
    if (exits.some(e => !stopIds.has(String(e.fill.orderId)) && !closeIds.has(String(e.fill.orderId)))) {
      const byId = new Map(owned.map(i => [i.id, i]));
      for (const event of kernel.journal?.events ?? []) if (event.type === 'OBSERVED' && byId.has(event.id)) add(byId.get(event.id), event.result);
    }
    if (exits.some(e => !stopIds.has(String(e.fill.orderId)) && !closeIds.has(String(e.fill.orderId)))) return unknown(latest.id, latest.closedAt);
    const stopFills = exits.filter(e => stopIds.has(String(e.fill.orderId)) && units(e.fill.quantity) > 0n);
    if (!stopFills.length) return null;
    const facts = stopFills.map(e => ({ tradeId: String(e.fill.id), orderId: String(e.fill.orderId), time: e.fill.time, quantity: e.fill.quantity }));
    return { evidenceComplete: true, account, symbol, direction, planId: plan.id, closedAt: rebuilt.closedAt,
      reason: 'OWNED_STOP_CLOSED_NET_LOSS', realizedNetUsdt: rebuilt.exact.realizedNetUsdt,
      knownFundingUsdt: rebuilt.fundingNetUsdt, evidenceHash: digest({ planId: plan.id, closedAt: rebuilt.closedAt,
        realizedNetUsdt: rebuilt.exact.realizedNetUsdt, funding: rebuilt.fundingNetUsdt, stopFills: facts }), stopFills: facts };
  } catch { return unknown(); }
}

// Ignore observation timestamps and estimated R which change on an ordinary
// fresh quote. Preserve every fact that decides eligibility or frozen policy.
export function entryConfirmationCommitIdentity(confirmation, policy) {
  if (!confirmation && !policy) return null;
  const { quoteMarketTime, quoteReceivedAt, ...proof } = confirmation?.proof ?? {};
  const { estimatedTargetNetR, ...target } = confirmation?.firstHarvestTarget ?? {};
  return { revision: confirmation?.revision, policy: confirmation?.policy, costs: confirmation?.costs,
    originalSignalClosedAt: confirmation?.metrics?.signalClosedAt,
    reference: confirmation?.reference,
    proof: confirmation?.proof ? proof : null, lastLossExit: confirmation?.lastLossExit ?? null,
    target: confirmation?.firstHarvestTarget ? target : null,
    managementRevision: policy?.revision, retainPeakFraction: policy?.retainPeakFraction,
    runnerRemainingFraction: policy?.runnerRemainingFraction, stages: policy?.stages };
}
