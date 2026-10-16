import vinext from "vinext";
import { defineConfig } from "vite";
import hosting from "./.openai/hosting.json" with { type: "json" };
import { sites } from "./build/sites-vite-plugin.ts";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  return { server:{host:"127.0.0.1",port:3001}, plugins: [vinext(), sites(), cloudflare({
    viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    config: {
      main: "./worker/index.ts", compatibility_flags: ["nodejs_compat"],
      d1_databases: hosting.d1 ? [{ binding: hosting.d1, database_name: "site-creator-d1", database_id: "00000000-0000-4000-8000-000000000000" }] : [],
    },
  })] };
});
