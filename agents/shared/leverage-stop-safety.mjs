// A high initial leverage setting can bring isolated liquidation ahead of the
// strategy stop. The conservative 2% entry-to-stop allowance at 25x leaves
// roughly half of the 4% initial margin for maintenance, mark/last divergence,
// fees and execution delay. It does not make a stop fill guaranteed.
export function highLeverageStopSafety({ leverage, marginType, entry, riskPerUnit }) {
  if (!Number.isSafeInteger(leverage) || leverage < 1 || leverage > 25) return false;
  if (leverage <= 4) return true;
  if (!['cross', 'isolated'].includes(marginType)) return false;
  if (marginType === 'cross') return true;
  return typeof entry === 'bigint' && entry > 0n && typeof riskPerUnit === 'bigint'
    && riskPerUnit > 0n && riskPerUnit * 100n <= entry * 2n;
}
