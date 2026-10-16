/** Candidate direction evidence only; never market pressure or an execution signal. */
export function signalFlow(candidates, fresh, configured = true) {
  if (!configured || !fresh || !Array.isArray(candidates)) return { available: false, long: null, short: null, pending: null, excluded: null };
  const counts = { available: true, long: 0, short: 0, pending: 0, excluded: 0 };
  for (const row of candidates) {
    if (row.stale) { counts.excluded++; continue; }
    if (['CONFIRMED_SCAN_ONLY', 'FIRST_CLOSE_LOCKED'].includes(row.status) && row.direction === 'LONG') counts.long++;
    else if (['CONFIRMED_SCAN_ONLY', 'FIRST_CLOSE_LOCKED'].includes(row.status) && row.direction === 'SHORT') counts.short++;
    else if (['FORMING', 'WAITING_CLOSE', 'WAITING_FIRST_PX_CLOSE'].includes(row.status)) counts.pending++;
    else counts.excluded++;
  }
  return counts;
}
