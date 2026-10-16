"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketQuote } from "./PriceCalibration";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ZECUSDT", "HYPEUSDT", "LINKUSDT", "AAVEUSDT"];
const ALLOWED = new Set(SYMBOLS);
const STREAM_URL = `wss://fstream.binancefuture.com/stream?streams=${SYMBOLS.map((symbol) => `${symbol.toLowerCase()}@bookTicker`).join("/")}`;

export type LiveQuoteState = "CONNECTING" | "LIVE" | "PAUSED" | "RECONNECTING" | "UNAVAILABLE";

type LiveQuote = MarketQuote & { updateId?: number };

export function useLiveMarketQuotes(fallbackQuotes: MarketQuote[] = []) {
  const [live, setLive] = useState<Record<string, LiveQuote>>({});
  const [state, setState] = useState<LiveQuoteState>("CONNECTING");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let failures = 0;
    const pending = new Map<string, LiveQuote>();

    const close = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
      socket = null;
    };

    const schedule = () => {
      if (disposed || document.hidden) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
      setState("RECONNECTING");
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed || document.hidden || socket) return;
      setState(failures ? "RECONNECTING" : "CONNECTING");
      try {
        socket = new WebSocket(STREAM_URL);
        socket.onopen = () => { failures = 0; setState("LIVE"); };
        socket.onmessage = (event) => {
          try {
            const envelope = JSON.parse(String(event.data));
            const row = envelope?.data ?? envelope;
            const symbol = typeof row?.s === "string" ? row.s : "";
            const bid = Number(row?.b), ask = Number(row?.a), exchangeTime = Number(row?.E ?? Date.now()), updateId = Number(row?.u);
            if (!ALLOWED.has(symbol) || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask || !Number.isFinite(exchangeTime)) return;
            pending.set(symbol, {
              symbol,
              status: "QUOTED",
              bidPrice: String(row.b),
              askPrice: String(row.a),
              exchangeTime: new Date(exchangeTime).toISOString(),
              observedAt: new Date().toISOString(),
              updateId: Number.isFinite(updateId) ? updateId : undefined,
            });
          } catch { /* Ignore malformed public market frames. */ }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          socket = null;
          if (!disposed && !document.hidden) { failures += 1; schedule(); }
        };
      } catch {
        socket = null;
        failures += 1;
        setState("UNAVAILABLE");
        schedule();
      }
    };

    const visibility = () => {
      if (document.hidden) { close(); setState("PAUSED"); }
      else connect();
    };

    flushTimer = setInterval(() => {
      if (!pending.size) return;
      const updates = Object.fromEntries(pending);
      pending.clear();
      setLive((current) => ({ ...current, ...updates }));
    }, 1_000);
    document.addEventListener("visibilitychange", visibility);
    connect();
    return () => {
      disposed = true;
      close();
      if (flushTimer) clearInterval(flushTimer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const quotes = useMemo(() => {
    const fallbackBySymbol = new Map(fallbackQuotes.map((quote) => [quote.symbol, quote]));
    return SYMBOLS.map((symbol) => {
      const realtime = live[symbol];
      const fallback = fallbackBySymbol.get(symbol);
      return realtime ? { ...fallback, ...realtime, tickSize: realtime.tickSize ?? fallback?.tickSize } : fallback;
    }).filter((quote): quote is MarketQuote => Boolean(quote));
  }, [fallbackQuotes, live]);

  return { quotes, state };
}
