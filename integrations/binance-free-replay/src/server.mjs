#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { reconcile } from "../../binance-usdm-testnet/read-only-reconciler.mjs";
import {
  TESTNET_CONFIRMATION,
  v3CancelManagedOrder,
  v3CloseManagedPosition,
  v3PlaceMarketEntry,
  v3QueryManagedOrder,
  v3ValidateMarketEntry,
} from "../../../agents/orion-v3/binance-demo/trading-gateway.mjs";
import { compactDatasetResult, gatewayStatus, loadOrDownloadKlines, runMaCrossReplay } from "./operations.mjs";

const server = new McpServer({
  name: "aegis-binance-free-replay",
  version: "1.0.0",
}, {
  instructions: "Public replay plus owner-authorized Binance USD-M Demo trading. Every mutation is pinned to demo-fapi.binance.com, requires the BINANCE_DEMO_ONLY literal and write approval, and is constrained by hard risk, deterministic client IDs, and protective stops. Never use production credentials, real funds, transfer, withdraw, change leverage/margin mode, or mutate the paper ledger. Historical OHLC output is screening evidence, not Gate 1 execution evidence.",
});

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function register(name, definition, handler) {
  server.registerTool(name, definition, async (args) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "FAIL_CLOSED", error: error?.message ?? String(error), ordersSubmitted: false }) }],
        isError: true,
      };
    }
  });
}

const replayInput = {
  symbol: z.string().describe("Owner-approved Binance USD-M symbol, for example BTCUSDT."),
  interval: z.enum(["1m", "15m", "1h", "4h"]),
  start: z.string().describe("Inclusive ISO date/time."),
  end: z.string().describe("Exclusive ISO date/time."),
  refresh: z.boolean().optional().default(false),
};

register("binance_free_replay_status", {
  title: "Binance Free Replay Status",
  description: "Show the public-data, testnet read-only, credential, universe, and no-order boundaries without making a network request.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, gatewayStatus);

register("binance_free_replay_download_klines", {
  title: "Download Closed Binance USD-M Klines",
  description: "Download and cache fully closed public USD-M klines for the fixed owner-approved universe. Uses GET only and no credentials.",
  inputSchema: replayInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async (args) => compactDatasetResult(await loadOrDownloadKlines(args)));

register("binance_free_replay_run_ma_cross", {
  title: "Run Reference MA Cross Replay",
  description: "Run the isolated long-only MA crossover reference adapter with closed-bar signals, next-open fills, fees, and adverse slippage. This is not the current MTFX strategy and cannot support promotion.",
  inputSchema: {
    ...replayInput,
    fastPeriod: z.number().int().min(1).max(999).optional().default(20),
    slowPeriod: z.number().int().min(2).max(1000).optional().default(60),
    initialEquity: z.number().positive().optional(),
    allocationFraction: z.number().positive().max(1).optional(),
    feeRate: z.number().min(0).max(0.01).optional(),
    adverseSlippageRate: z.number().min(0).max(0.1).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, runMaCrossReplay);

register("binance_testnet_readonly_reconcile", {
  title: "Binance Testnet Read-only Reconciliation",
  description: "Read the authorized testnet server time, account, positions, and open orders only when the local enablement flag and dedicated Keychain credentials are present. It cannot submit or cancel orders.",
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, () => reconcile());

const testnetEntryInput = {
  intentId: z.string().min(8).max(128).describe("Stable owner intent identifier used to derive idempotent client order IDs."),
  symbol: z.string().describe("One of the ten owner-approved USD-M perpetual symbols."),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  stopPrice: z.number().positive().describe("Required protective stop used for the 1% risk gate and attached STOP_MARKET protection."),
  confirmation: z.literal(TESTNET_CONFIRMATION),
};

register("binance_testnet_validate_market_entry", {
  title: "Validate Binance Demo Market Entry",
  description: "Run account, symbol, quantity, risk, leverage, idempotency, entry and protective-stop validation on Binance Demo. Uses /order/test and never reaches the matching engine.",
  inputSchema: testnetEntryInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, v3ValidateMarketEntry);

register("binance_testnet_place_market_entry", {
  title: "Place Binance Demo Market Entry",
  description: "Place one risk-bounded Binance Demo market entry and its protective STOP_MARKET order. Testnet only; requires explicit literal confirmation and write approval.",
  inputSchema: testnetEntryInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, v3PlaceMarketEntry);

register("binance_testnet_close_managed_position", {
  title: "Close Managed Binance Demo Position",
  description: "Close a position previously opened by this gateway using a reduce-only market order, then cancel its managed protective stop.",
  inputSchema: {
    intentId: z.string().min(8).max(128),
    symbol: z.string(),
    confirmation: z.literal(TESTNET_CONFIRMATION),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, v3CloseManagedPosition);

register("binance_testnet_cancel_managed_order", {
  title: "Cancel Managed Binance Demo Order",
  description: "Cancel only an order recorded as managed by this Binance Demo gateway.",
  inputSchema: {
    symbol: z.string(),
    clientOrderId: z.string().min(1).max(36),
    confirmation: z.literal(TESTNET_CONFIRMATION),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, v3CancelManagedOrder);

register("binance_testnet_query_managed_order", {
  title: "Query Managed Binance Demo Order",
  description: "Query an order recorded as managed by this Binance Demo gateway.",
  inputSchema: { symbol: z.string(), clientOrderId: z.string().min(1).max(36) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, v3QueryManagedOrder);

await server.connect(new StdioServerTransport());
