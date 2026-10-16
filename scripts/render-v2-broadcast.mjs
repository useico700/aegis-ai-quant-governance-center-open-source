import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTER = path.join(PROJECT_ROOT, "agents/orion-v2/paper/control.mjs");

try {
  process.stdout.write(execFileSync(process.execPath, [REPORTER, "report"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
} catch (error) {
  const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, " ").slice(0, 240);
  process.stdout.write(`### ORION V2｜MTFX 纸面交易报表\n\n**状态异常：${detail}**\n\n交易进程、策略与订单均未被修改，请人工检查运行状态。\n`);
  process.exitCode = 2;
}
