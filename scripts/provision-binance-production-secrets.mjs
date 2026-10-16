import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABELS = ["BN-KEY-PROD", "BN-SECRET-PROD"];
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOTENV_PATH = path.join(PROJECT_ROOT, ".env");

function fromKeychain(label) {
  const attempts = [
    ["find-generic-password", "-s", label, "-w"],
    ["find-generic-password", "-l", label, "-w"],
    ["find-generic-password", "-a", label, "-w"],
    ["find-internet-password", "-s", label, "-w"],
    ["find-internet-password", "-a", label, "-w"],
  ];
  for (const args of attempts) {
    try {
      const value = execFileSync("/usr/bin/security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (value) return value;
    } catch {}
  }
  return null;
}

function fromProjectDotEnv(label) {
  let stat;
  try {
    stat = fs.lstatSync(DOTENV_PATH);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PROJECT_DOTENV_MUST_BE_REGULAR_FILE");
  if ((stat.mode & 0o077) !== 0) throw new Error("PROJECT_DOTENV_PERMISSIONS_TOO_OPEN_REQUIRE_0600");
  try {
    execFileSync("/usr/bin/git", ["-C", PROJECT_ROOT, "ls-files", "--error-unmatch", ".env"], { stdio: "ignore" });
    throw new Error("PROJECT_DOTENV_MUST_NOT_BE_GIT_TRACKED");
  } catch (error) {
    if (error?.message === "PROJECT_DOTENV_MUST_NOT_BE_GIT_TRACKED") throw error;
  }
  const values = new Map();
  for (const raw of fs.readFileSync(DOTENV_PATH, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values.set(match[1], value);
  }
  return values.get(label) || null;
}

function resolve(label) {
  const value = process.env[label] || fromKeychain(label) || fromProjectDotEnv(label);
  if (!value) throw new Error(`${label}_NOT_AVAILABLE_IN_PROCESS_ENV_MACOS_KEYCHAIN_OR_PROJECT_DOTENV`);
  if (value.length < 16 || /[\r\n]/.test(value)) throw new Error(`${label}_VALUE_INVALID`);
  return value;
}

function provision(label, value) {
  const remotePath = `/etc/aegis/secrets/binance-prod/${label}`;
  const command = `sudo /usr/bin/tee '${remotePath}' >/dev/null && sudo /usr/bin/chown root:aegis-trader '${remotePath}' && sudo /usr/bin/chmod 0440 '${remotePath}'`;
  const result = spawnSync("/usr/bin/ssh", ["-o", "BatchMode=yes", "demo-server", command], {
    input: `${value}\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`${label}_REMOTE_PROVISION_FAILED`);
}

const values = LABELS.map((label) => [label, resolve(label)]);
if (values[0][1] === values[1][1]) throw new Error("PRODUCTION_CREDENTIAL_VALUES_MUST_DIFFER");
for (const [label, value] of values) provision(label, value);
process.stdout.write(`${JSON.stringify({ status: "PROVISIONED", labels: LABELS, destination: "demo-server:/etc/aegis/secrets/binance-prod", valuesPrinted: false })}\n`);
