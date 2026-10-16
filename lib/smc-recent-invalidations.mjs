import policy from './smc-scan-policy.json' with { type: 'json' };

/**
 * Turn plans that left the active candidate set into audit-only tombstones.
 * These records are deliberately kept outside snapshot.candidates so they can
 * never be consumed by the SMC executor as order admission.
 */
export function updateRecentInvalidations(previous, results, now = Date.now()) {
  const active = results.flatMap(row => row.candidates ?? []);
  const activeIds = new Set(active.map(row => row.id));
  const diagnostics = new Map(results.flatMap(row => row.invalidatedPlans ?? [])
    .map(row => [row.id, row]));
  const carried = Array.isArray(previous?.recentInvalidations) ? previous.recentInvalidations : [];
  const disappeared = (previous?.candidates ?? []).filter(candidate => !activeIds.has(candidate.id));
  const created = disappeared.map(candidate => {
    const diagnostic = diagnostics.get(candidate.id);
    return {
      id: candidate.id,
      symbol: candidate.symbol,
      direction: candidate.direction,
      candidateSource: candidate.candidateSource ?? 'AUTOMATIC',
      ownerSelectedAt: candidate.ownerSelectedAt ?? null,
      ownerAutoTradingEnabled: candidate.ownerAutoTradingEnabled ?? null,
      reason: diagnostic?.reason ?? 'REMOVED_FROM_ACTIVE_SET',
      invalidatedAt: now,
      evidenceAt: diagnostic?.detectedAt ?? now,
      timeframe: diagnostic?.timeframe ?? 'SYSTEM',
      level: diagnostic?.level ?? null,
      observed: diagnostic?.observed ?? null,
      entryBand: candidate.entryBand,
      stop: candidate.stop,
      target: candidate.target,
      netR: candidate.netR,
      structure: {
        eventType: candidate.structure?.eventType,
        qualityGrade: candidate.structure?.qualityGrade,
        nPatternQualified: candidate.structure?.nPatternQualified === true,
        bosAt: candidate.structure?.bosAt,
      },
      auditOnly: true,
      orderAuthority: false,
    };
  });
  const normalizedCarried = carried.map(row => ({ ...row,
    candidateSource: row.candidateSource ?? 'AUTOMATIC', ownerSelectedAt: row.ownerSelectedAt ?? null,
    ownerAutoTradingEnabled: row.ownerAutoTradingEnabled
      ?? ((row.candidateSource ?? 'AUTOMATIC') === 'OWNER_SELECTED' ? true : null) }));
  const byId = new Map([...created, ...normalizedCarried]
    .filter(row => row && !activeIds.has(row.id) && now - row.invalidatedAt <= policy.recentInvalidationRetentionMs)
    .map(row => [row.id, row]));
  return [...byId.values()].sort((a, b) => b.invalidatedAt - a.invalidatedAt)
    .slice(0, policy.maximumRecentInvalidations);
}
