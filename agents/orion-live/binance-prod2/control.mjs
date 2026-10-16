import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, runPreflight } from "./preflight.mjs";
import { processAlive, readJson } from "./runtime-utils.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? "status";
if (command === "preflight") {
  process.stdout.write(`${JSON.stringify(await runPreflight(), null, 2)}\n`);
} else if (command === "status") {
  const config = await loadConfig(path.join(DIRECTORY, "config.json"));
  const runtimeRoot = process.env.AEGIS_RUNTIME_ROOT || config.runtime.root;
  const pid = await readJson(path.join(runtimeRoot, "resident.pid.json"), {});
  const latest = await readJson(path.join(runtimeRoot, "latest.json"), {});
  process.stdout.write(`${JSON.stringify({ ...latest, pid: pid.pid ?? null, alive: processAlive(pid.pid), realOrdersAllowed: false, newEntriesBlocked: true }, null, 2)}\n`);
} else {
  throw new Error("PRODUCTION_READONLY_CONTROL_COMMAND_INVALID");
}
