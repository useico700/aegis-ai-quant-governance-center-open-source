// DEMO ONLY — active exclusively with `?demo=1`. Serves synthetic S1 payloads to the unchanged classic
// page so the motion can be previewed without a backend. Never active on the normal route.
import { buildDemoFeed, tickDemo } from "./demo-data";

export const demoRequested = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";

let installed = false;
export function installDemoMode() {
  if (installed || !demoRequested()) return;
  installed = true;
  let state = buildDemoFeed();
  window.setInterval(() => { state = tickDemo(state); }, 1500);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/s1-monitor")) return json({ status: "OK", snapshot: state.snapshot, history: state.history });
    if (url.includes("/api/s1-execution-ledger")) return json(state.ledger);
    if (url.includes("/api/s1-risk-calendar")) return json(state.calendar);
    return original(input, init);
  }) as typeof fetch;
  // keep real Binance quotes out of the synthetic preview
  (window as unknown as { WebSocket: unknown }).WebSocket = class { onopen = null; onmessage = null; onerror = null; onclose = null; close() {} };
}
