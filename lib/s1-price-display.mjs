// Presentation only: never feed rounded display values back into order/risk calculations.
const stepPlaces = (value) => {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !(Number(text) > 0)) return null;
  const [coefficient, exponent = "0"] = text.toLowerCase().split("e");
  const fraction = (coefficient.split(".")[1] ?? "").replace(/0+$/, "");
  return Math.min(12, Math.max(0, fraction.length - Number(exponent)));
};

const fractionalPlaces = (value) => {
  const match = /^\d+(?:\.(\d+))?$/.exec(String(value ?? ""));
  return match ? (match[1]?.length ?? 0) : 0;
};

export function binancePricePlaces(tickSize, quote) {
  const tickPlaces = stepPlaces(tickSize) ?? 0;
  const quotePlaces = Math.max(fractionalPlaces(quote?.bidPrice), fractionalPlaces(quote?.askPrice));
  return Math.min(12, Math.max(2, tickPlaces, quotePlaces));
}

export function formatBinancePrice(value, tickSize, quote) {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const places = binancePricePlaces(tickSize, quote);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(number);
}

export function formatBinanceQuantity(value, step) {
  if (value === null || value === undefined || String(value).trim() === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: stepPlaces(step) ?? 12,
  }).format(number);
}

// Both account monitors share these symbol lookups, including historical fills.
export function createBinanceDisplay(rules = [], quotes = []) {
  const ruleBySymbol = new Map(rules.map(rule => [rule.symbol, rule]));
  const quoteBySymbol = new Map(quotes.map(quote => [quote.symbol, quote]));
  return {
    price(value, symbol) {
      const quote = quoteBySymbol.get(symbol);
      const step = quote?.tickSize ?? ruleBySymbol.get(symbol)?.price?.step;
      // A missing instrument rule must not silently round a small coin to cents.
      if (stepPlaces(step) === null && !quote?.bidPrice && !quote?.askPrice) return "—";
      return formatBinancePrice(value, step, quote);
    },
    quantity(value, symbol) {
      return formatBinanceQuantity(value, ruleBySymbol.get(symbol)?.lot?.step);
    },
  };
}
