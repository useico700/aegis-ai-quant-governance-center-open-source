#!/usr/bin/env node

import { loadV4Context } from "./context.mjs";
import {
  datasetPathFor,
  downloadPublicDataset,
  fileExists,
  loadDataset,
  normalizeSymbol,
} from "./market-data.mjs";
import { compactReplayReport, runRg1Replay } from "./replay.mjs";
import { writeReplayArtifacts } from "./report.mjs";
import { invariant, parseTime } from "./utils.mjs";

function flag(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function request(args, context) {
  const symbol = normalizeSymbol(flag(args, "--symbol"), context.config);
  const startTime = parseTime(flag(args, "--start"), "START");
  const endTime = parseTime(flag(args, "--end"), "END");
  invariant(endTime > startTime, "V4_RG1_RANGE_MUST_BE_POSITIVE");
  return { symbol, startTime, endTime };
}

async function downloadBundle(args, context) {
  const { symbol, startTime, endTime } = request(args, context);
  const refresh = hasFlag(args, "--refresh");
  const results = [];
  for (const interval of ["15m", "1h", "4h"]) {
    const expectedPath = datasetPathFor({ symbol, interval, startTime, endTime }, context.config);
    if (!refresh && await fileExists(expectedPath)) {
      const dataset = await loadDataset(expectedPath, { expectedSymbol: symbol, expectedInterval: interval, config: context.config });
      results.push({ interval, cache: "HIT", filePath: expectedPath, datasetHash: dataset.datasetHash, barCount: dataset.barCount });
      continue;
    }
    const downloaded = await downloadPublicDataset({
      symbol,
      interval,
      start: startTime,
      end: endTime,
      config: context.config,
      authorizationId: context.authorization.id,
    });
    results.push({
      interval,
      cache: refresh ? "REFRESHED" : "MISS_DOWNLOADED",
      filePath: downloaded.filePath,
      datasetHash: downloaded.dataset.datasetHash,
      barCount: downloaded.dataset.barCount,
    });
  }
  return {
    status: "PASS",
    mode: "V4_RG1_PUBLIC_FULLY_CLOSED_BAR_DOWNLOAD_ONLY",
    authorizationId: context.authorization.id,
    symbol,
    startTime,
    endTime,
    credentialsUsed: false,
    signedRequestsUsed: false,
    orderEndpointsUsed: false,
    datasets: results,
  };
}

async function replayBundle(args, context) {
  const { symbol, startTime, endTime } = request(args, context);
  const paths = Object.fromEntries(["15m", "1h", "4h"].map((interval) => [
    interval,
    datasetPathFor({ symbol, interval, startTime, endTime }, context.config),
  ]));
  for (const [interval, filePath] of Object.entries(paths)) {
    invariant(await fileExists(filePath), `V4_RG1_LOCAL_${interval.toUpperCase()}_DATASET_MISSING_RUN_DOWNLOAD_FIRST`);
  }
  const [fifteenMinute, oneHour, fourHour] = await Promise.all([
    loadDataset(paths["15m"], { expectedSymbol: symbol, expectedInterval: "15m", config: context.config }),
    loadDataset(paths["1h"], { expectedSymbol: symbol, expectedInterval: "1h", config: context.config }),
    loadDataset(paths["4h"], { expectedSymbol: symbol, expectedInterval: "4h", config: context.config }),
  ]);
  const report = runRg1Replay({
    datasets: { fifteenMinute, oneHour, fourHour },
    config: context.config,
    authorizationId: context.authorization.id,
    sourceHashes: context.hashes,
  });
  const artifacts = await writeReplayArtifacts(report);
  return {
    status: "PASS",
    report: compactReplayReport(report),
    artifacts,
  };
}

async function main() {
  const [command = "validate", ...args] = process.argv.slice(2);
  const context = await loadV4Context();
  let output;
  if (command === "validate") {
    output = {
      status: "PASS",
      identity: "ORION V4",
      strategyVersion: context.config.candidateVersion,
      implementationRevision: context.config.implementationRevision,
      authority: context.governance.orionV4RangeResearch.authority,
      stage: context.governance.orionV4RangeResearch.stage,
      paperRiskPolicy: context.governance.orionV4RangeResearch.paperRiskPolicy,
      executionBoundary: "GATE_0_RESEARCH_ONLY_NO_FORWARD_EXECUTION",
      sourceHashes: context.hashes,
    };
  } else if (command === "download") {
    output = await downloadBundle(args, context);
  } else if (command === "replay") {
    output = await replayBundle(args, context);
  } else {
    throw new Error(`V4_RG1_UNKNOWN_COMMAND_${command}`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "ERROR", error: error?.stack || String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
