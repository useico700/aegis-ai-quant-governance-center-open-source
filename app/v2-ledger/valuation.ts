export type V2MarkedPosition = {
  direction: 1 | -1;
  entry: number;
  quantity: number;
  originalQuantity?: number;
  lastBid?: number | null;
  lastAsk?: number | null;
  entryFee?: number;
};

export type V2MarkingCosts = {
  takerFeeRate: number;
  adverseSlippageRate: number;
};

/**
 * Mirrors ORION V2's PANORAMA/CONTROL live valuation. Book equity already
 * contains every realized partial, so this function deliberately returns only
 * the remaining position's cost-adjusted unrealized P&L.
 */
export function calculateUnrealizedNetPnl(position: V2MarkedPosition, costs: V2MarkingCosts) {
  const direction = Number(position.direction);
  const entry = Number(position.entry);
  const quantity = Number(position.quantity);
  const executableBbo = direction === 1 ? Number(position.lastBid) : Number(position.lastAsk);
  if ((direction !== 1 && direction !== -1) || !Number.isFinite(entry) || !Number.isFinite(quantity) || !(executableBbo > 0)) return null;

  const slippageRate = Number(costs.adverseSlippageRate) || 0;
  const feeRate = Number(costs.takerFeeRate) || 0;
  const estimatedExit = executableBbo * (direction === 1 ? 1 - slippageRate : 1 + slippageRate);
  const estimatedExitFee = estimatedExit * quantity * feeRate;
  const originalQuantity = Number(position.originalQuantity ?? quantity);
  const remainingEntryFee = Number(position.entryFee || 0) * (originalQuantity > 0 ? quantity / originalQuantity : 1);

  return direction * (estimatedExit - entry) * quantity - remainingEntryFee - estimatedExitFee;
}
