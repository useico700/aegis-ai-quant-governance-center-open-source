#!/usr/bin/env node
import { blockLegacyDirectLaunch } from "../../../scripts/public/entry-guard.mjs";
blockLegacyDirectLaunch(import.meta.url);
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../../..");
const RUNTIME = path.join(ROOT, ".runtime/orion-v3-px-distance-pullback");
const PID_PATH = path.join(RUNTIME, "resident.pid.json"), LATEST = path.join(RUNTIME, "latest.json"), LOG = path.join(RUNTIME, "resident.log");
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } };
const command = process.argv[2] ?? "status";
if (command === "status") { const pid = read(PID_PATH); process.stdout.write(`${JSON.stringify({ pid: pid?.pid ?? null, alive: alive(pid?.pid), process: pid, latest: read(LATEST) }, null, 2)}\n`); }
else if (command === "start") {
  const prior = read(PID_PATH); if (alive(prior?.pid)) { process.stdout.write(`${JSON.stringify({ status: "ALREADY_RUNNING", pid: prior.pid })}\n`); process.exit(0); }
  fs.mkdirSync(RUNTIME, { recursive: true }); const fd = fs.openSync(LOG, "a", 0o600); const child = spawn(process.execPath, [path.join(DIR, "resident.mjs")], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { PATH: process.env.PATH } }); child.unref(); fs.closeSync(fd); process.stdout.write(`${JSON.stringify({ status: "STARTED", pid: child.pid, executionGate: false, ordersAffected: false })}\n`);
} else throw new Error(`UNKNOWN_COMMAND_${command}`);
