import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { buildPxMonitor, sanitizePxMonitor } from "../../../lib/v3-px-monitor.mjs";
import runtime from "../binance-demo/config.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE = path.join(ROOT, ".runtime/orion-v3-px-distance-pullback");
const OUTPUT = path.join(ROOT, ".runtime/orion-v3-px-monitor");
const PID = path.join(OUTPUT, "publisher.pid");
const ONLINE = new URL("/api/v3-px-research", runtime.onlineEquity.url).href;
const keychain = (account, service) => execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
async function readPair() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = JSON.parse(await fs.readFile(path.join(SOURCE, "latest.json"), "utf8"));
    const state = JSON.parse(await fs.readFile(path.join(SOURCE, "state.json"), "utf8"));
    try { return buildPxMonitor(latest, state); } catch (error) { if (error.message !== "RESEARCH_SNAPSHOT_PAIR_MISMATCH" || attempt === 3) throw error; }
  }
}
export async function publishPxMonitor({ snapshot, token, bypassToken, fetchImpl = fetch } = {}) {
  const payload = sanitizePxMonitor(snapshot ?? await readPair());
  const config = runtime.onlineEquity;
  token ??= keychain(config.keychainAccount, config.keychainService);
  bypassToken ??= keychain(config.sitesBypassKeychainAccount, config.sitesBypassKeychainService);
  if (token.length < 32 || bypassToken.length < 32) throw new Error("MONITOR_TOKEN_UNAVAILABLE");
  const response = await fetchImpl(ONLINE, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12000), headers: { authorization: `Bearer ${token}`, "oai-sites-authorization": `Bearer ${bypassToken}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`MONITOR_HTTP_${response.status}`);
  const result = await response.json();
  return { status: result.status, sourceAsOf: payload.asOf, receivedAt: result.receivedAt, recordCount: payload.records.length };
}
const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function resident() {
  await fs.mkdir(OUTPUT, { recursive: true });
  try { await fs.writeFile(PID, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = Number(await fs.readFile(PID, "utf8"));
    if (alive(old)) return;
    await fs.unlink(PID); await fs.writeFile(PID, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    while (!stopping) {
      let result;
      try { result = await publishPxMonitor(); } catch (error) { result = { status: "SYNC_FAILED", error: /^MONITOR_[A-Z0-9_]+$|^RESEARCH_[A-Z0-9_]+$/.test(error.message) ? error.message : "PUBLICATION_FAILED" }; }
      const report = { ...result, publisherPid: process.pid, checkedAt: new Date().toISOString(), executionChanged: false };
      await fs.writeFile(path.join(OUTPUT, "latest.tmp"), JSON.stringify(report, null, 2), { mode: 0o600 }); await fs.rename(path.join(OUTPUT, "latest.tmp"), path.join(OUTPUT, "latest.json"));
      if (!stopping) await new Promise((resolve) => { const timer = setTimeout(resolve, 30000); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  } finally { if (Number(await fs.readFile(PID, "utf8").catch(() => "0")) === process.pid) await fs.unlink(PID); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] ?? "once";
  if (action === "resident") await resident();
  else if (action === "start") {
    const old = Number(await fs.readFile(PID, "utf8").catch(() => "0"));
    if (alive(old)) console.log(JSON.stringify({ status: "ALREADY_RUNNING", pid: old }));
    else { const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "resident"], { cwd: ROOT, detached: true, stdio: "ignore" }); child.unref(); console.log(JSON.stringify({ status: "START_DISPATCHED", pid: child.pid })); }
  } else if (action === "status") {
    const pid = Number(await fs.readFile(PID, "utf8").catch(() => "0")); console.log(JSON.stringify({ running: alive(pid), pid, latest: JSON.parse(await fs.readFile(path.join(OUTPUT, "latest.json"), "utf8").catch(() => "null")) }));
  } else if (action === "once") console.log(JSON.stringify(await publishPxMonitor()));
  else throw new Error("UNKNOWN_MONITOR_ACTION");
}
