// Dedicated monitor publishing secret only; never reads exchange credentials.
// JSON arrives over stdin, is sent directly to the demo-server sudo process,
// and is not echoed, included in shell arguments, or stored in this repository.
import { execFileSync } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const values = JSON.parse(input);
if (!/^[a-f0-9]{64}$/.test(values.ingest) || !/^[A-Za-z0-9_-]+$/.test(values.bypass)) throw new Error("INVALID_MONITOR_SECRET");
const payload = `S1_MONITOR_URL=https://your-cockpit.example.invalid`;
const remote = "sudo -n python3 -c 'import os,sys; os.umask(0o077); f=open(\"/etc/aegis/s1-scanner-monitor.env\",\"x\"); f.write(sys.stdin.read()); f.close(); print(\"S1_MONITOR_ENV_PROVISIONED\")'";
const result = execFileSync("ssh", ["-o", "BatchMode=yes", "demo-server", remote], { input: payload, encoding: "utf8" });
process.stdout.write(result);
