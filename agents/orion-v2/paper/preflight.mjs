import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateAuthority, PublicMarketClient } from "./paper-daemon.mjs";

const paperRoot = path.dirname(fileURLToPath(import.meta.url));
const authority = await loadAndValidateAuthority();
const market = new PublicMarketClient(authority.runtime);
const sourceFiles = ["paper-daemon.mjs", "paper-engine.mjs", "control.mjs"];
const source = (await Promise.all(sourceFiles.map((name) => fs.readFile(path.join(paperRoot, name), "utf8")))).join("\n");

const forbiddenPatterns = [
  /\/fapi\/v1\/order/i,
  /\/fapi\/v1\/batchOrders/i,
  /X-MBX-APIKEY/i,
  /createHmac/i,
  /apiSecret/i,
];
for (const pattern of forbiddenPatterns) {
  if (pattern.test(source)) throw new Error(`FORBIDDEN_ORDER_OR_CREDENTIAL_CAPABILITY_${pattern}`);
}

const serverTime = await market.serverTime();
const universe = await market.selectUniverse();
const tickSizes = await market.tickSizes(universe);
const probes = [];
const probeSymbols = [...new Set([...authority.runtime.venue.universe.mandatorySymbols, universe.find((symbol) => !authority.runtime.venue.universe.mandatorySymbols.includes(symbol))])].filter(Boolean);
for (const symbol of probeSymbols) {
  const [bars, quote] = await Promise.all([
    market.bars(symbol, "15m", 20, serverTime),
    market.bookTicker(symbol),
  ]);
  if (bars.length < 15 || !(quote.bid > 0 && quote.ask >= quote.bid) || !(tickSizes[symbol] > 0)) {
    throw new Error(`PUBLIC_MARKET_PREFLIGHT_FAILED_${symbol}`);
  }
  probes.push({ symbol, closedBars15m: bars.length, bid: quote.bid, ask: quote.ask, tickSize: tickSizes[symbol] });
}

process.stdout.write(`${JSON.stringify({
  status: "READY",
  runtimeId: authority.runtime.runtimeId,
  strategyVersion: authority.runtime.strategyVersion,
  implementationRevision: authority.runtime.implementationRevision,
  implementationDirectiveId: authority.runtime.implementationDirectiveId,
  authorizationId: authority.runtime.authorizationId,
  paperRiskDirectiveId: authority.runtime.paperRiskDirectiveId,
  dailyRealizedLossStopEnabled: authority.runtime.paperRisk.dailyRealizedLossStopEnabled,
  maximumDrawdownKillEnabled: authority.runtime.paperRisk.maximumDrawdownKillEnabled,
  maximumDrawdownKillFraction: authority.runtime.paperRisk.maximumDrawdownKillFraction,
  publicMarketOnly: true,
  apiKeysUsed: false,
  orderEndpointsPresent: false,
  realOrdersAllowed: false,
  universeSize: universe.length,
  mandatorySymbols: authority.runtime.venue.universe.mandatorySymbols,
  universe,
  serverTime,
  probes,
}, null, 2)}\n`);
