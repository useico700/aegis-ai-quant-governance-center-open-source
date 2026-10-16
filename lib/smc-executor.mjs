// Strategy-independent planning only. No exchange credentials, transport or order writer.
import { units, decimal, freshRules, align } from './s1-precision.mjs';

export const SMC_MODULE_REVISION = 'SMC-S2-PLANNER-1';
export const SMC_MODELS = Object.freeze({
  CONTINUATION: '趋势延续 · BOS 后回踩 OB / FVG',
  SWEEP_SHIFT: '流动性扫取 → 结构转向 → 回踩',
});
export const SMC_TIMEFRAMES = Object.freeze({ '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 });
const SCALE = 10n ** 18n;
const BPS = units('10000');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const amount = (value, label, zero = false) => {
  requireValue(typeof value === 'string' && /^\d+(?:\.\d{1,18})?$/.test(value) && value.length <= 50, `${label}须为普通十进制数`);
  const result = units(value);
  requireValue(zero ? result >= 0n : result > 0n, `${label}须${zero ? '不小于零' : '大于零'}`);
  return result;
};
const roundedUp = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/** Arithmetic is a draft estimate, never a probability, risk authorization or admission. */
export function evaluateSmcDraft(raw) {
  try {
    requireValue(raw && typeof raw === 'object', '缺少计划');
    requireValue(Object.hasOwn(SMC_MODELS, raw.model), '请选择交易模型');
    requireValue(raw.direction === 'LONG' || raw.direction === 'SHORT', '请选择做多或做空');
    requireValue(typeof raw.symbol === 'string' && /^[A-Z0-9]{2,20}USDT$/.test(raw.symbol), '请输入 USDT 合约交易对');
    requireValue(Object.hasOwn(SMC_TIMEFRAMES, raw.structureTimeframe) && Object.hasOwn(SMC_TIMEFRAMES, raw.entryTimeframe)
      && SMC_TIMEFRAMES[raw.structureTimeframe] > SMC_TIMEFRAMES[raw.entryTimeframe], '结构周期必须大于入场周期');
    const entry = amount(raw.entry, '入场价'), stop = amount(raw.stop, '止损价'), target = amount(raw.target, '止盈价');
    const quantity = amount(raw.quantity, '数量'), fee = amount(raw.feeBps, '单边手续费 bp', true), slip = amount(raw.slippageBps, '单边滑点 bp', true);
    const funding = amount(raw.fundingCost, '资金费成本预留', true), budget = amount(raw.riskBudget, '草稿风险预算');
    requireValue(fee <= units('1000') && slip <= units('1000'), '手续费或滑点估计超出可接受的草稿范围');
    const long = raw.direction === 'LONG', loss = long ? entry - stop : stop - entry, gain = long ? target - entry : entry - target;
    requireValue(loss > 0n && gain > 0n, long ? '做多须满足：止损 < 入场 < 止盈' : '做空须满足：止盈 < 入场 < 止损');
    // Round losses/costs up and gains down. Each exit has its own notional cost.
    const stopCosts = roundedUp((entry + stop) * quantity * (fee + slip), SCALE * BPS) + funding;
    const targetCosts = roundedUp((entry + target) * quantity * (fee + slip), SCALE * BPS) + funding;
    const risk = roundedUp(loss * quantity, SCALE) + stopCosts;
    const reward = gain * quantity / SCALE - targetCosts;
    requireValue(reward > 0n, '扣除预估费用后，止盈目标没有正收益空间');
    requireValue(risk <= budget, '预计初始风险超过草稿风险预算，请减少数量或调整计划');
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, 2000) : '';
    return { status: 'DRAFT_VALID', moduleRevision: SMC_MODULE_REVISION, submissionAllowed: false,
      plan: { symbol: raw.symbol, model: raw.model, direction: raw.direction, structureTimeframe: raw.structureTimeframe,
        entryTimeframe: raw.entryTimeframe, entry: decimal(entry), stop: decimal(stop), target: decimal(target),
        quantity: decimal(quantity), feeBps: decimal(fee), slippageBps: decimal(slip), fundingCost: decimal(funding), riskBudget: decimal(budget), evidence },
      metrics: { estimatedInitialRisk: decimal(risk), estimatedNetReward: decimal(reward),
        netRewardRiskRatio: decimal(reward * SCALE / risk), notional: decimal(roundedUp(entry * quantity, SCALE)),
        estimatedStopCosts: decimal(stopCosts), estimatedTargetCosts: decimal(targetCosts) } };
  } catch (error) {
    return { status: 'DRAFT_INVALID', submissionAllowed: false, reason: error.message };
  }
}

export function smcPrecisionReview(plan, rules, now) {
  try {
    requireValue(evaluateSmcDraft(plan).status === 'DRAFT_VALID', '计划尚未通过基础校验');
    const rule = freshRules(rules, plan.symbol, now);
    for (const price of [plan.entry, plan.stop, plan.target]) align(price, rule.price, 'EXACT');
    align(plan.quantity, rule.lot, 'EXACT');
    align(plan.quantity, rule.marketLot, 'EXACT');
    requireValue(units(plan.entry) * units(plan.quantity) >= units(rule.minNotional) * SCALE, '低于交易所最小名义金额');
    return { status: 'PRECISION_ONLY', submissionAllowed: false, message: '价格与数量步长匹配；提交前仍须重新核验' };
  } catch { return { status: 'UNVERIFIED', submissionAllowed: false, message: '交易所规则缺失、过时或价格 / 数量不匹配' }; }
}

/** @param {{ execution?: { status?: string | null } | null, executionFresh?: boolean, accountFresh?: boolean }} [input] */
export function smcReadiness({ execution, executionFresh = false, accountFresh = false } = {}) {
  const ownerPaused = executionFresh && execution?.status === 'OWNER_PAUSED';
  return { status: 'PLANNING_ONLY', submissionAllowed: false, strategyRevision: null, riskProfile: null,
    accountState: accountFresh ? '账户快照已同步' : '账户快照待更新',
    executionState: !executionFresh ? 'S2 执行状态待核验' : ownerPaused ? 'S2 已暂停' : 'S2 快照已同步 · 非 SMC 授权',
    blockers: ['SMC 可执行策略版本未冻结', 'SMC 专属风险政策与实盘授权未配置',
      'S2 主机内 SMC 订单适配尚未启用', '待完成逐笔 / BBO、保护单与账户对账验收'] };
}

export function restoreSmcDrafts(serialized) {
  try {
    requireValue(typeof serialized === 'string' && serialized.length <= 200000, '草稿存储过大');
    const rows = JSON.parse(serialized);
    requireValue(Array.isArray(rows), '草稿格式错误');
    const seen = new Set();
    return rows.slice(0, 30).flatMap(row => {
      const checked = evaluateSmcDraft(row?.plan);
      if (row?.schema !== 'SMC_TRADE_PLAN_DRAFT_V1' || row?.account !== 'S2'
        || typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || seen.has(row.id)
        || !Number.isFinite(Date.parse(row.createdAt)) || checked.status !== 'DRAFT_VALID') return [];
      seen.add(row.id);
      return [{ schema: 'SMC_TRADE_PLAN_DRAFT_V1', account: 'S2', id: row.id, createdAt: row.createdAt,
        moduleRevision: SMC_MODULE_REVISION, submissionAllowed: false, plan: checked.plan, metrics: checked.metrics }];
    });
  } catch { return []; }
}
