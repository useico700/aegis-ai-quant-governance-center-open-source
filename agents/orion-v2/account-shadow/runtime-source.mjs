import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, stableStringify } from "./contracts.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "../../..");

async function importedSourceGraph() {
  const seeds = (await fs.readdir(MODULE_DIR)).filter((file) => file.endsWith(".mjs")).map((file) => path.join(MODULE_DIR, file));
  const visited = new Set();
  const pending = [...seeds];
  while (pending.length) {
    const filePath = path.resolve(pending.pop());
    if (visited.has(filePath)) continue;
    if (!(filePath === PROJECT_ROOT || filePath.startsWith(`${PROJECT_ROOT}${path.sep}`))) throw new Error("C_RUNTIME_SOURCE_DEPENDENCY_OUTSIDE_PROJECT");
    visited.add(filePath);
    const content = await fs.readFile(filePath, "utf8");
    const imports = [...content.matchAll(/(?:from\s+|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      const dependency = path.resolve(path.dirname(filePath), specifier);
      if (dependency.endsWith(".mjs") || dependency.endsWith(".js")) pending.push(dependency);
    }
  }
  return [...visited].sort();
}

export async function calculateRuntimeSourceHash() {
  const manifest = [];
  for (const filePath of await importedSourceGraph()) {
    const content = await fs.readFile(filePath, "utf8");
    manifest.push({ file: path.relative(PROJECT_ROOT, filePath), sha256: sha256(content) });
  }
  return { sha256: sha256(stableStringify(manifest)), manifest };
}
