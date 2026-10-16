const check = (ok, code) => { if (!ok) throw new Error(code); };

const triggerWeight = {
  ENTRY_BAND_ACTIVE: 8,
  SECOND_BAR_REVERSE_READY: 8,
  WAIT_SECOND_BAR_PRICE: 5,
  WAIT_SECOND_BAR_CE_REVERSAL: 4,
  WAIT_CE_REENTRY: 3,
  WAIT_15M_MICRO_STRUCTURE_SHIFT: 2.5,
  ARMED_CE_CLOSE: 2,
};

const finite = value => Number.isFinite(Number(value));
const rounded = value => Number(Number(value).toFixed(2));

function candidateScore(row) {
  const grade = row.structure?.qualityGrade === 'A' ? 8 : 4;
  const distance = finite(row.distanceToEntry?.percent) ? Number(row.distanceToEntry.percent) : 6;
  return grade + (triggerWeight[row.status] ?? 0) + Math.min(6, Number(row.netR ?? 0))
    + Math.max(0, 5 - Math.min(5, distance));
}

const H4 = 4 * 60 * 60 * 1000;

/**
 * Produce presentation-only structure/FVG pairs from scanner observations.
 * A nearby raw FVG must not borrow an unrelated structure merely because both
 * point in the same direction. Full candidate admission remains authoritative.
 */
export function pairedSmcStructureZones(result, direction) {
  const structures = (result?.structures ?? [])
    .filter(row => row.direction === direction && row.admission === 'PLAN_ELIGIBLE' && ['A', 'B'].includes(row.grade))
    .sort((a, b) => Number(b.breakAt) - Number(a.breakAt));
  const zones = (result?.manualZones ?? []).filter(row => row.direction === direction && row.kind === 'FVG');
  return structures.flatMap(structure => {
    const matches = zones.filter(zone => Math.abs(Number(zone.availableAt) - Number(structure.breakAt)) <= 2 * H4)
      .sort((a, b) => Math.abs(Number(a.availableAt) - Number(structure.breakAt)) - Math.abs(Number(b.availableAt) - Number(structure.breakAt))
        || Number(a.distancePercent) - Number(b.distancePercent));
    return matches.length ? [{ structure, zone: matches[0] }] : [];
  });
}

/**
 * Read-only direction selection for an owner-added SMC candidate.
 * It never creates an order or bypasses the normal scanner. The returned
 * direction is persisted as an ordinary OWNER_SELECTED request and must still
 * pass the complete structure, CE, risk and execution admission chain.
 */
export function selectSmcOwnerDirection(snapshot, symbol, now = Date.now()) {
  check(snapshot && Array.isArray(snapshot.results) && Array.isArray(snapshot.candidates), 'SMC_AUTO_DIRECTION_SNAPSHOT_INVALID');
  check(typeof symbol === 'string' && snapshot.universe?.includes(symbol), 'SMC_AUTO_DIRECTION_SYMBOL_INVALID');
  check(Number.isFinite(now), 'SMC_AUTO_DIRECTION_TIME_INVALID');
  const result = snapshot.results.find(row => row.symbol === symbol);
  check(result, 'SMC_AUTO_DIRECTION_SYMBOL_NOT_SCANNED');

  const automatic = snapshot.candidates.filter(row => row.symbol === symbol && row.candidateSource === 'AUTOMATIC')
    .map(row => ({ direction: row.direction, score: candidateScore(row), at: Number(row.structure?.bosAt ?? row.observedAt), row }))
    .sort((a, b) => b.score - a.score || b.at - a.at);
  if (automatic.length) {
    const best = automatic[0], opposite = automatic.find(row => row.direction !== best.direction);
    check(!opposite || best.score - opposite.score >= 1.5 || best.at > opposite.at,
      'SMC_AUTO_DIRECTION_CONFLICTING_ACTIVE_PLANS');
    return { direction: best.direction, basis: 'ACTIVE_AUTOMATIC_CANDIDATE', score: rounded(best.score),
      reason: `${best.row.structure?.qualityGrade ?? 'A/B'}级结构 · ${Number(best.row.netR).toFixed(2)}R · ${best.row.status}`,
      referenceId: best.row.id };
  }

  // AUTO means that production has completed structure, paired POI, target and
  // current lifecycle admission. Raw observations remain available to an
  // explicit owner watch, but they cannot manufacture a directional plan.
  check(false, 'SMC_AUTO_DIRECTION_NO_EXECUTABLE_PLAN');
}
