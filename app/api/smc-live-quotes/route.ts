import { publicApi } from "../../../lib/public-preview.mjs";
import { sanitizeSmcLiveQuotes } from "../../../lib/smc-live-quotes.mjs";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const endpoint = "https://www.binance.com/fapi/v1/ticker/bookTicker";

export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-live-quotes", "GET");

  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("BINANCE_BBO_UNAVAILABLE");
    const snapshot = sanitizeSmcLiveQuotes(await response.json());
    return Response.json({ status: "OK", snapshot }, { headers });
  } catch {
    return Response.json({ status: "UNAVAILABLE", snapshot: null }, { status: 503, headers });
  }
}
