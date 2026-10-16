#!/usr/bin/env node

import { compactDatasetResult, gatewayStatus, loadOrDownloadKlines, runMaCrossReplay } from "./operations.mjs";

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) result[rawKey] = inline;
    else if (values[index + 1] && !values[index + 1].startsWith("--")) result[rawKey] = values[++index];
    else result[rawKey] = true;
  }
  return result;
}

function numberOption(args, name) {
  if (args[name] === undefined) return undefined;
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new Error(`CLI_${name.toUpperCase().replaceAll("-", "_")}_INVALID`);
  return value;
}

function commonRequest(args) {
  return {
    symbol: args.symbol,
    interval: args.interval,
    start: args.start,
    end: args.end,
    refresh: args.refresh === true || args.refresh === "true",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "status";
  if (command === "status") return gatewayStatus();
  if (command === "download") return compactDatasetResult(await loadOrDownloadKlines(commonRequest(args)));
  if (command === "backtest-ma") {
    return runMaCrossReplay({
      ...commonRequest(args),
      fastPeriod: numberOption(args, "fast") ?? 20,
      slowPeriod: numberOption(args, "slow") ?? 60,
      initialEquity: numberOption(args, "initial-equity"),
      allocationFraction: numberOption(args, "allocation"),
      feeRate: numberOption(args, "fee-rate"),
      adverseSlippageRate: numberOption(args, "slippage-rate"),
    });
  }
  throw new Error("CLI_COMMAND_MUST_BE_STATUS_DOWNLOAD_OR_BACKTEST_MA");
}

try {
  process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL_CLOSED",
    error: error?.message ?? String(error),
    ordersSubmitted: false,
    paperRuntimeMutated: false,
  })}\n`);
  process.exitCode = 1;
}
