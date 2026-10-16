import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const HF14_SHARED_AUTHORIZATION = "OWNER-DIRECTIVE-ORION-V3-HF14-SINGLE-Z-20260914";
export const HF14_SHARED_MANIFEST = "governance/evidence/manifests/v3-hf14-shared-verifier-20260914.json";
export const HF14_SHARED_PREDECESSOR = "governance/evidence/manifests/aegis-prime-clean-context-rotation-20260914.json";
export const HF14_SHARED_AUTH_PATH = "governance/owner-authorizations/2026-09-14-orion-v3-hf14-single-z.json";
export const HF14_SHARED_BEFORE_ROOT = "reports/strategy-research/20260914-v3-hf14/before/";
export const HF14_SHARED_CHANGED = Object.freeze(["scripts/verify-migration.mjs", "scripts/verify-aegis-rotation.mjs"]);
export const HF14_SHARED_ADDED = Object.freeze(["scripts/verify-v3-hf14-successor.mjs", "tests/v3-hf14-successor.test.mjs"]);

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const must = (value, code) => { if (!value) throw new Error(`V3_HF14_SHARED_SUCCESSOR_${code}`); };
const descriptor = (value) => value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/.test(value.sha256);
const matches = (bytes, value) => Buffer.isBuffer(bytes) && descriptor(value) && bytes.length === value.bytes && hash(bytes) === value.sha256;

/** Authenticate the narrow shared-verifier successor before applying old manifests.
 * Both historical source files and their original AEGIS manifest remain intact.
 * The caller must still run current HF14 policy checks on the actual live state.
 */
export function verifyV3Hf14SharedSuccessor({ authorization, manifest, predecessorManifestBytes, sourceBytes }) {
  const revision = "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE";
  must(authorization?.id === HF14_SHARED_AUTHORIZATION && authorization.status === "ACTIVE" &&
    authorization.appliesTo?.agent === "orion-v3" && authorization.appliesTo?.release === revision &&
    authorization.appliesTo?.venue === "BINANCE_USDM_TESTNET" && authorization.appliesTo?.fixedBaseUrl === "https://demo-fapi.binance.com" &&
    authorization.release?.implementationRevision === revision, "AUTHORITY");
  must(authorization.transition?.redLatchResetAuthorized === false &&
    authorization.transition?.preserveExistingManagedPositions === true &&
    authorization.transition?.preserveExistingProtectiveOrders === true &&
    authorization.hardRisk?.maximumRiskPerEntryFraction === 0.01 &&
    authorization.hardRisk?.maximumManagedPortfolioRiskFraction === 0.1 &&
    authorization.hardRisk?.maximumOpenPositionsTotal === 18 &&
    authorization.hardRisk?.maximumEffectiveNotionalLeverage === 10, "BOUNDARIES");
  must(manifest?.schemaVersion === 1 && manifest.authorizationId === HF14_SHARED_AUTHORIZATION &&
    manifest.scope === "V3_HF14_SHARED_VERIFICATION_ONLY" &&
    manifest.supersedesManifest === HF14_SHARED_PREDECESSOR &&
    manifest.historicalManifestPreserved === true && manifest.preservedV2S1AndAegisChecks === true, "SCOPE");
  must(Buffer.isBuffer(predecessorManifestBytes) &&
    manifest.predecessorManifestSha256 === hash(predecessorManifestBytes), "PREDECESSOR_HASH");
  const predecessor = JSON.parse(predecessorManifestBytes.toString("utf8"));
  must(predecessor.authorizationId === "OWNER-DIRECTIVE-AEGIS-PRIME-CLEAN-CONTEXT-ROTATION-20260914" &&
    predecessor.scope === "AEGIS_CONVERSATION_ROUTING_AND_VERIFICATION_ONLY" && Array.isArray(predecessor.files), "PREDECESSOR_AUTHORITY");
  const expected = [...HF14_SHARED_CHANGED, ...HF14_SHARED_ADDED].sort();
  must(Array.isArray(manifest.files) && manifest.files.length === expected.length &&
    JSON.stringify(manifest.files.map((file) => file.path).sort()) === JSON.stringify(expected), "SOURCE_SET");
  const retained = new Map();
  for (const file of manifest.files) {
    const actual = sourceBytes?.[file.path];
    must(matches(actual, file.after), `CURRENT_HASH:${file.path}`);
    if (HF14_SHARED_CHANGED.includes(file.path)) {
      const beforePath = HF14_SHARED_BEFORE_ROOT + file.path;
      must(file.beforePath === beforePath, `BEFORE_PATH:${file.path}`);
      const original = sourceBytes?.[beforePath];
      const prior = predecessor.files.find((entry) => entry.path === file.path);
      must(predecessor.files.filter((entry) => entry.path === file.path).length === 1 &&
        matches(original, file.before) && matches(original, prior), `PREDECESSOR_LINK:${file.path}`);
      retained.set(file.path, { after: file.after, before: file.before, original: Buffer.from(original) });
    } else {
      must(file.before === null && file.beforePath == null, `ADDED_FILE_BASELINE:${file.path}`);
    }
  }
  return {
    normalize(filePath, bytes) {
      const file = retained.get(filePath);
      if (!file) return bytes;
      if (matches(bytes, file.before)) return bytes;
      must(matches(bytes, file.after), `UNAUTHENTICATED_SOURCE:${filePath}`);
      return Buffer.from(file.original);
    },
  };
}

export async function loadV3Hf14SharedSuccessor(root, current) {
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root, HF14_SHARED_MANIFEST), "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    must(current?.orionV3BinanceUsdmDemo?.implementationRevision !== "MTFX-V3-HF14-SINGLE-Z-STRUCTURE-GATE", "MANIFEST_MISSING");
    return null;
  }
  const sourcePaths = [...HF14_SHARED_CHANGED, ...HF14_SHARED_ADDED, ...HF14_SHARED_CHANGED.map((file) => HF14_SHARED_BEFORE_ROOT + file)];
  const [authorization, predecessorManifestBytes, sources] = await Promise.all([
    fs.readFile(path.join(root, HF14_SHARED_AUTH_PATH), "utf8").then(JSON.parse),
    fs.readFile(path.join(root, HF14_SHARED_PREDECESSOR)),
    Promise.all(sourcePaths.map(async (file) => [file, await fs.readFile(path.join(root, file))])),
  ]);
  return verifyV3Hf14SharedSuccessor({ authorization, manifest, predecessorManifestBytes, sourceBytes: Object.fromEntries(sources) });
}
