import { lifecycleSourceIsActive, planFamilyKey } from './smc-plan-lifecycle.mjs';
import policy from "./smc-scan-policy.json" with { type: "json" };
import { sanitizeStructurePlans } from "./smc-structure-plan.mjs";

// A conditional scenario is an owner manual source, never an admitted auto plan.
export function isCurrentConditionalManualSource(snapshot, intent, now = Date.now()) {
  try {
    const asOf = Date.parse(snapshot?.sourceAsOf);
    if (intent?.source !== "MANUAL_CANDIDATE" || !policy.universe.includes(intent.symbol)
      || snapshot?.revision !== policy.revision || snapshot.mode !== policy.mode || snapshot.orderAuthority !== false
      || !Number.isFinite(now) || !Number.isFinite(asOf) || now - asOf < -5000
      || now - asOf > policy.snapshotStaleAfterMs) return false;
    const result = snapshot.results?.find(row => row.symbol === intent.symbol);
    return sanitizeStructurePlans(result?.structurePlans ?? [], intent.symbol, now)
      .some(plan => plan.id === intent.sourceId && plan.symbol === intent.symbol && plan.direction === intent.direction
        && !(result.planTerminals ?? []).some(r => planFamilyKey(r.plan) === planFamilyKey(plan))
        && lifecycleSourceIsActive(plan, { quote: result.planningQuote, now }));
  } catch { return false; }
}

/** @returns {{source: "MANUAL_CANDIDATE"|"ACTIVE_CANDIDATE", sourceId: string}} */
export function manualOrderSourceForCandidate({ candidateId, symbol, direction, ownedByCurrentUser }) {
  if (ownedByCurrentUser) {
    return {
      source: "MANUAL_CANDIDATE",
      sourceId: `${symbol}-${direction}`,
    };
  }

  return {
    source: "ACTIVE_CANDIDATE",
    sourceId: candidateId,
  };
}
