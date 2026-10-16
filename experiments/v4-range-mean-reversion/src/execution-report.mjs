import { fileURLToPath } from "node:url";

import { snapshotV4DemoAccount } from "./demo-account.mjs";
import { v4LoadManagedTradingState } from "./execution-gateway.mjs";

function sum(rows, field) {
  return rows.reduce((total, row) => total + (Number(row?.[field]) || 0), 0);
}

export async function buildV4ExecutionReport({ enabled = true, credentials, fetchImpl = fetch, now = Date.now(), persist = true } = {}) {
  const [account, state] = await Promise.all([
    snapshotV4DemoAccount({ enabled, credentials, fetchImpl, now, persist }),
    v4LoadManagedTradingState(),
  ]);
  const managedPositions = Object.values(state?.managedPositions ?? {});
  const closedPositions = Array.isArray(state?.closedPositions) ? state.closedPositions : [];
  return {
    schemaVersion: 1,
    report: "ORION_V4_BINANCE_DEMO_EXECUTION_CONTROL",
    generatedAt: new Date(now).toISOString(),
    account,
    managedPositions,
    closedPositions,
    settlementStatistics: {
      completedTradeCount: closedPositions.length,
      completedTradeNetPnlUsdt: sum(closedPositions, "netPnl"),
      completedTradeCommissionUsdt: sum(closedPositions, "totalCommissionUsdt"),
      openPositionPartialRealizedNetPnlUsdt: sum(managedPositions, "cumulativeRealizedNetPnl"),
      exactCommissionEvidenceTradeCount: closedPositions.filter((row) => row.actualCommissionEvidenceComplete === true).length,
      signedRealizedPnlEvidenceTradeCount: closedPositions.filter((row) => row.exchangeRealizedPnlEvidenceComplete === true).length,
      evidenceSource: "BINANCE_DEMO_SIGNED_ACCOUNT_USER_TRADES_AND_INCOME",
    },
    pendingOperationCount: Object.keys(state?.pendingOperations ?? {}).length,
    credentialsRecorded: false,
    v3LedgerReused: false,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await buildV4ExecutionReport(), null, 2)}\n`);
}
