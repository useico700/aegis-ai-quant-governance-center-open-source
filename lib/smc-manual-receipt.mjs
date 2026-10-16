// Receipt reconciliation only: this module cannot submit or amend venue orders.
export function sameManualOrderRequest(stored, input) {
  const mode = input.schema === 'SMC_OWNER_MANUAL_INTENT_V1' ? 'IMMEDIATE' : input.orderMode;
  return ['id', 'symbol', 'direction', 'source', 'sourceId'].every(key => stored[key] === input[key])
    && stored.orderMode === mode
    && ['stopPrice', 'targetPrice', ...(mode === 'LIMIT_GTC' ? ['limitPrice'] : [])]
      .every(key => Number.isFinite(Number(input[key])) && Number(stored[key]) === Number(input[key]));
}
export function manualExecutionEvidence(snapshot, intent) {
  const planId = `MANUAL-${intent.id.replaceAll('-', '').toUpperCase()}`;
  const matches = row => row.planId === planId && row.symbol === intent.symbol
    && row.direction === intent.direction && Number(row.quantity) > 0;
  const position = snapshot?.positions?.find(matches);
  const fills = snapshot?.fills?.filter(row => matches(row) && row.role === 'ENTRY') ?? [];
  if (position || fills.length) {
    const quantity = fills.length ? fills.reduce((sum, row) => sum + row.quantity, 0) : position.quantity;
    const entry = fills.length ? fills.reduce((sum, row) => sum + row.quantity * row.price, 0) / quantity : position.entry;
    return { executionState: 'FILLED', planId, quantity, entry };
  }
  const pending = snapshot?.pendingEntries?.find(matches);
  return pending ? { executionState: 'RESTING', planId, quantity: pending.quantity, entry: pending.price } : null;
}
export function projectManualOrderReceipt(row, snapshot, now = Date.now()) {
  const intent = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const previous = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
  const savedFill = row.status === 'SUBMITTED' && previous?.executionState === 'FILLED'
    && previous.planId === `MANUAL-${intent.id.replaceAll('-', '').toUpperCase()}`
    && Number(previous.quantity) > 0 && Number(previous.entry) > 0
      ? { executionState: 'FILLED', planId: previous.planId, quantity: previous.quantity, entry: previous.entry } : null;
  const proof = savedFill ?? manualExecutionEvidence(snapshot, intent);
  if (proof) return { id: intent.id, status: 'SUBMITTED', ...proof, expiresAt: row.expiresAt ?? row.expires_at,
    result: { reason: proof.executionState === 'FILLED' ? 'FILL_CONFIRMED' : 'RESTING_CONFIRMED',
      ...(row.status !== 'SUBMITTED' ? { previousReceipt: { status: row.status, result: previous } } : {}) } };
  const expired = ['QUEUED', 'RECEIVED'].includes(row.status) && now > (row.expiresAt ?? row.expires_at);
  // A queued ticket's time limit is not proof that an in-flight order never filled.
  return { id: intent.id, status: expired ? 'UNKNOWN' : row.status,
    expiresAt: row.expiresAt ?? row.expires_at, result: expired ? { reason: 'RECEIPT_PENDING_RECONCILIATION' } : previous };
}
const reasons = {
  INTENT_EXPIRED: '指令已过期，未执行', SOURCE_NOT_FOUND: '候选依据已失效，请刷新计划',
  PRICE_PRECISION_UNAVAILABLE: '交易所报价精度尚未同步', SAME_SYMBOL_POSITION: '该币种已有持仓，请查看持仓',
  PENDING_MANUAL_ORDER: '已有指令待执行，请等待回执', IDEMPOTENCY_CONFLICT: '同一指令的价格内容发生冲突',
  SUPERSEDED_BY_NEW_MANUAL_INTENT: '旧指令状态待核验，请以对应成交账本为准',
  RECEIPT_PENDING_RECONCILIATION: '结果待核验，请勿重复提交',
};
export function manualReceiptLabel(receipt) {
  if (receipt?.executionState === 'FILLED') return `已成交 · ${receipt.quantity} · 均价 ${receipt.entry}`;
  if (receipt?.executionState === 'RESTING') return '挂单中';
  const labels = { QUEUED: '待执行', RECEIVED: '执行中', SUBMITTED: '已送达交易所，等待成交核验',
    NO_FILL: '未成交', EXPIRED: '指令已过期', UNKNOWN: '结果待核验，请勿重复提交', REJECTED: '未执行' };
  const reason = receipt?.result?.reason;
  return `${labels[receipt?.status] ?? reasons[receipt?.status] ?? receipt?.status ?? ''}${reason ? ` · ${reasons[reason] ?? reason}` : ''}`;
}
