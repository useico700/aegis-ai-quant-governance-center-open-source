import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { fileURLToPath } from "node:url";

import {
  TESTNET_CONFIRMATION,
  deterministicClientOrderId,
  loadManagedTradingState,
  persistManagedPositionMetadata,
  recordTradingAudit,
  reduceManagedPosition,
} from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";
import { applyActualPartial } from "./auto-executor.mjs";

const AUTHORIZATION_ID = "OWNER-DIRECTIVE-ORION-V3-PARTIAL-EXIT-FILL-RECOVERY-20260820";
const EXPECTED = Object.freeze({
  symbol: "SOLUSDT",
  baseIntentId: "hf3:v3hf_cross_85d682af972f470eca5af9a8",
  reason: "twoR25",
  orderId: 4184957713,
  clientOrderId: "aegis_twoR25_22814b667c9a5465c987",
  executedQuantity: 2.18,
  remainingQuantity: 2.2,
  averagePrice: 83.73,
  tradeId: 86796125,
});

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function approximatelyEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 1e-8;
}

export async function recoverKnownSolTwoRPartial({ now = Date.now } = {}) {
  const before = await loadManagedTradingState();
  const position = before.managedPositions?.[EXPECTED.symbol];
  invariant(position, "V3_SOL_RECOVERY_MANAGED_POSITION_MISSING");
  const existingPartial = (position.partialExits ?? []).find((row) => String(row.orderId) === String(EXPECTED.orderId));
  if (existingPartial) {
    invariant(position.partial25Executed === true && position.secondPartialTaken === true && approximatelyEqual(position.quantity, EXPECTED.remainingQuantity), "V3_SOL_RECOVERY_ALREADY_RECORDED_STATE_INCOMPLETE");
    return { status: "V3_SOL_TWO_R_PARTIAL_ALREADY_RECOVERED", orderId: EXPECTED.orderId, quantity: position.quantity };
  }
  invariant(position.intentId === EXPECTED.baseIntentId, "V3_SOL_RECOVERY_INTENT_MISMATCH");
  invariant(position.firstPartialTaken === true && position.partial25Executed !== true && position.secondPartialTaken !== true, "V3_SOL_RECOVERY_STAGE_MISMATCH");
  invariant(approximatelyEqual(position.quantity, 4.38), "V3_SOL_RECOVERY_LOCAL_QUANTITY_UNEXPECTED");

  const partialIntentId = `${position.intentId}:${EXPECTED.reason}`;
  invariant(deterministicClientOrderId(partialIntentId, EXPECTED.reason) === EXPECTED.clientOrderId, "V3_SOL_RECOVERY_CLIENT_ORDER_ID_MISMATCH");
  const result = await reduceManagedPosition({
    intentId: partialIntentId,
    symbol: EXPECTED.symbol,
    quantity: EXPECTED.executedQuantity,
    reason: EXPECTED.reason,
    confirmation: TESTNET_CONFIRMATION,
  }, { now: now(), clock: now, requireExistingOrder: true });

  invariant(result.idempotentRecovery === true, "V3_SOL_RECOVERY_WOULD_SUBMIT_NEW_ORDER");
  invariant(String(result.order?.orderId) === String(EXPECTED.orderId), "V3_SOL_RECOVERY_ORDER_ID_MISMATCH");
  invariant(approximatelyEqual(result.quantity, EXPECTED.executedQuantity), "V3_SOL_RECOVERY_EXECUTED_QUANTITY_MISMATCH");
  invariant(approximatelyEqual(result.remainingQuantity, EXPECTED.remainingQuantity), "V3_SOL_RECOVERY_REMAINING_QUANTITY_MISMATCH");
  invariant(approximatelyEqual(result.order?.avgPrice, EXPECTED.averagePrice), "V3_SOL_RECOVERY_AVERAGE_PRICE_MISMATCH");
  invariant(result.order?.averagePriceEvidence === "ACTUAL_BINANCE_DEMO_USER_TRADES" || Number(result.order?.avgPrice) > 0, "V3_SOL_RECOVERY_AVERAGE_PRICE_EVIDENCE_MISSING");
  invariant(result.order?.tradeCost?.allCommissionInUsdt === true, "V3_SOL_RECOVERY_COMMISSION_EVIDENCE_INCOMPLETE");
  invariant((result.order?.tradeCost?.fills ?? []).some((fill) => Number(fill.tradeId) === EXPECTED.tradeId), "V3_SOL_RECOVERY_TRADE_ID_MISSING");

  const reconciledState = await loadManagedTradingState();
  const reconciledPosition = reconciledState.managedPositions?.[EXPECTED.symbol];
  invariant(reconciledPosition && !(reconciledPosition.partialExits ?? []).some((row) => String(row.orderId) === String(EXPECTED.orderId)), "V3_SOL_RECOVERY_PARTIAL_DUPLICATE_DETECTED");
  const recovered = {
    ...applyActualPartial(reconciledPosition, result.order, result.quantity, EXPECTED.reason, result.remainingQuantity),
    partial25Executed: true,
    secondPartialTaken: true,
    twoRReachedAt: Number(result.order?.updateTime) || now(),
    stage: "RUNNER_25",
    plannedRiskUsdt: 0,
    lastExecutablePrice: Number(result.order.avgPrice),
  };
  await persistManagedPositionMetadata(EXPECTED.symbol, recovered, { now: now() });
  const audit = await recordTradingAudit({
    schemaVersion: 1,
    eventType: "BINANCE_DEMO_MANAGED_PARTIAL_EXIT_LEDGER_RECOVERED_FROM_SIGNED_TRADES",
    occurredAt: new Date(now()).toISOString(),
    authorizationId: AUTHORIZATION_ID,
    venue: "BINANCE_USDM_TESTNET",
    symbol: EXPECTED.symbol,
    reason: EXPECTED.reason,
    orderId: EXPECTED.orderId,
    clientOrderId: EXPECTED.clientOrderId,
    tradeIds: result.order.tradeCost.fills.map((fill) => fill.tradeId),
    quantity: result.quantity,
    remainingQuantity: result.remainingQuantity,
    averagePrice: Number(result.order.avgPrice),
    realizedPnlUsdt: Number(result.order.tradeCost.realizedPnlUsdt),
    commissionUsdt: Number(result.order.tradeCost.commissionUsdt),
    exchangeOrdersSubmittedByRecovery: 0,
    strategyChanged: false,
    riskChanged: false,
    credentialsRecorded: false,
    productionHostUsed: false,
  });
  return {
    status: "V3_SOL_TWO_R_PARTIAL_RECOVERED_FROM_SIGNED_TRADES",
    orderId: EXPECTED.orderId,
    tradeIds: result.order.tradeCost.fills.map((fill) => fill.tradeId),
    quantity: result.quantity,
    remainingQuantity: result.remainingQuantity,
    averagePrice: Number(result.order.avgPrice),
    realizedPnlUsdt: Number(result.order.tradeCost.realizedPnlUsdt),
    commissionUsdt: Number(result.order.tradeCost.commissionUsdt),
    auditEventHash: audit.eventHash,
    exchangeOrdersSubmittedByRecovery: 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await recoverKnownSolTwoRPartial();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
