"use client";
import type { MarketQuote } from "./PriceCalibration";
export type LiveQuoteState="CONNECTING"|"LIVE"|"PAUSED"|"RECONNECTING"|"UNAVAILABLE";
export function useLiveMarketQuotes(fallbackQuotes: MarketQuote[]=[]):{quotes:MarketQuote[];state:LiveQuoteState}{
 return {quotes:fallbackQuotes,state:"PAUSED"};
}
