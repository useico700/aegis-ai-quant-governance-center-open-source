import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import { fileURLToPath } from "node:url";

import {
  alignAllApprovedSymbolLeverage,
  TESTNET_CONFIRMATION,
} from "../../../integrations/binance-usdm-testnet/trading-gateway.mjs";

export async function alignV3Leverage(options = {}) {
  return alignAllApprovedSymbolLeverage({ confirmation: TESTNET_CONFIRMATION }, options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await alignV3Leverage();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL_CLOSED",
      error: error?.message ?? String(error),
      productionHostUsed: false,
      ordersSubmitted: false,
    })}\n`);
    process.exitCode = 1;
  }
}
