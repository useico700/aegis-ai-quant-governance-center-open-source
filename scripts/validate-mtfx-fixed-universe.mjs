import { loadAndValidateAuthority, PublicMarketClient } from "../agents/orion-v2/paper/paper-daemon.mjs";

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const { runtime, authorization } = await loadAndValidateAuthority();
const market = new PublicMarketClient(runtime);
const symbols = runtime.venue.universe.symbols;
const [serverTime, info, tickers, books] = await Promise.all([
  market.serverTime(),
  market.exchangeInfo(),
  market.request("/fapi/v1/ticker/24hr"),
  market.request("/fapi/v1/ticker/bookTicker"),
]);
const tickerBySymbol = new Map(tickers.map((value) => [value.symbol, value]));
const bookBySymbol = new Map(books.map((value) => [value.symbol, value]));
const infoBySymbol = new Map(info.symbols.map((value) => [value.symbol, value]));
const minimumHistoryBars4h = 900;
const minimumQuoteVolumeUsdt = 50_000_000;
const maximumSpreadBps = 2;
const minimumMedianMoveBps = 20;
const maximumMedianMoveBps = 150;
const rows = [];

for (const symbol of symbols) {
  const instrument = infoBySymbol.get(symbol);
  const ticker = tickerBySymbol.get(symbol);
  const book = bookBySymbol.get(symbol);
  const bars = await market.bars(symbol, "4h", 1000, serverTime);
  const moves = bars.slice(1).map((bar, index) => Math.abs(Math.log(bar.close / bars[index].close)) * 10_000).filter(Number.isFinite);
  const bid = Number(book?.bidPrice);
  const ask = Number(book?.askPrice);
  const spreadBps = (ask - bid) / ((ask + bid) / 2) * 10_000;
  const row = {
    symbol,
    mandatory: runtime.venue.universe.mandatorySymbols.includes(symbol),
    quoteVolumeUsdt24h: Number(ticker?.quoteVolume),
    spreadBps,
    closedHistoryBars4h: bars.length,
    medianAbsoluteMoveBps4h: median(moves),
    onboardDate: new Date(Number(instrument?.onboardDate)).toISOString().slice(0, 10),
  };
  row.accepted = row.quoteVolumeUsdt24h >= minimumQuoteVolumeUsdt && row.spreadBps <= maximumSpreadBps &&
    row.closedHistoryBars4h >= minimumHistoryBars4h && row.medianAbsoluteMoveBps4h >= minimumMedianMoveBps &&
    row.medianAbsoluteMoveBps4h <= maximumMedianMoveBps;
  rows.push(row);
}

if (symbols.length !== 10 || new Set(symbols).size !== 10) throw new Error("FIXED_UNIVERSE_MUST_HAVE_TEN_UNIQUE_SYMBOLS");
if (authorization.paperScope.universeSelection !== "FIXED_OWNER_APPROVED_10") throw new Error("OWNER_FIXED_UNIVERSE_AUTHORIZATION_MISSING");
if (runtime.venue.universe.mandatorySymbols.some((symbol) => !symbols.includes(symbol))) throw new Error("MANDATORY_SYMBOL_MISSING");
if (rows.some((row) => !row.accepted)) throw new Error(`FIXED_UNIVERSE_QUALITY_GATE_FAILED_${rows.filter((row) => !row.accepted).map((row) => row.symbol).join("_")}`);

process.stdout.write(`${JSON.stringify({
  status: "VALID",
  policy: "LIQUIDITY_SPREAD_HISTORY_VOLATILITY_NO_SIGNAL_LOOKAHEAD",
  fixedUntilNewOwnerAuthorization: true,
  thresholds: { minimumQuoteVolumeUsdt, maximumSpreadBps, minimumHistoryBars4h, minimumMedianMoveBps, maximumMedianMoveBps },
  symbols,
  observedAt: new Date(serverTime).toISOString(),
  rows,
}, null, 2)}\n`);
