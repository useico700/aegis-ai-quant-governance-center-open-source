// Read-only verification plus exact duplicate replay (must be ignored).
// Run only on demo-server through sudo. Never prints monitor credentials.
import fs from "node:fs/promises";
const env = Object.fromEntries((await fs.readFile("/etc/aegis/s1-scanner-monitor.env", "utf8")).trim().split("\n").map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
const headers = { "oai-sites-authorization": `Bearer ${env.S1_MONITOR_BYPASS_TOKEN}` };
const get = await fetch(env.S1_MONITOR_URL, { headers, signal: AbortSignal.timeout(10000) });
const data = await get.json();
const unauthorized = await fetch(env.S1_MONITOR_URL, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(10000) });
let duplicate = null;
if (data.snapshot) {
  const response = await fetch(env.S1_MONITOR_URL, { method: "POST", headers: { ...headers, Authorization: `Bearer ${env.S1_MONITOR_INGEST_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(data.snapshot), signal: AbortSignal.timeout(10000) });
  duplicate = { http: response.status, ...(await response.json()) };
}
const page = await fetch(env.S1_MONITOR_URL.replace("/api/s1-monitor", "/s1"), { headers, signal: AbortSignal.timeout(10000) });
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), pageHttp: page.status, getHttp: get.status, status: data.status, sourceAsOf: data.snapshot?.sourceAsOf, sequence: data.snapshot?.sequence, account: data.snapshot?.account, candidateCount: data.snapshot?.candidates?.length, publish: data.snapshot?.publish, unauthorizedHttp: unauthorized.status, duplicate }, null, 2));
if (get.status !== 200 || page.status !== 200 || unauthorized.status !== 401 || duplicate?.status !== "OLDER_SNAPSHOT_IGNORED") process.exitCode = 1;
