import crypto from "node:crypto";
import fs from "node:fs/promises";

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export async function readCredentialFile(filePath, { requiredOwnerUid = 0, requiredMode = "0440" } = {}) {
  const stat = await fs.lstat(filePath);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "PRODUCTION_CREDENTIAL_NOT_REGULAR_FILE");
  invariant(stat.uid === Number(requiredOwnerUid), "PRODUCTION_CREDENTIAL_OWNER_INVALID");
  const actualMode = (stat.mode & 0o777).toString(8).padStart(4, "0");
  invariant(actualMode === requiredMode, "PRODUCTION_CREDENTIAL_MODE_INVALID");
  const value = (await fs.readFile(filePath, "utf8")).trim();
  invariant(value.length >= 16, "PRODUCTION_CREDENTIAL_VALUE_INVALID");
  invariant(!/[\r\n]/.test(value), "PRODUCTION_CREDENTIAL_MULTILINE_FORBIDDEN");
  return value;
}

export async function loadProductionCredentials(config) {
  const options = {
    requiredOwnerUid: config.credentials.requiredOwnerUid,
    requiredMode: config.credentials.requiredMode,
  };
  const [apiKey, secretKey] = await Promise.all([
    readCredentialFile(config.credentials.apiKeyFile, options),
    readCredentialFile(config.credentials.secretKeyFile, options),
  ]);
  invariant(apiKey !== secretKey, "PRODUCTION_CREDENTIAL_VALUES_MUST_DIFFER");
  return {
    apiKey,
    secretKey,
    apiKeyFingerprint: crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16),
    secretKeyFingerprint: crypto.createHash("sha256").update(secretKey).digest("hex").slice(0, 16),
  };
}

export function credentialErrorStatus(error) {
  if (error?.code === "ENOENT") return "WAITING_FOR_CREDENTIALS";
  if (String(error?.message ?? "").startsWith("PRODUCTION_CREDENTIAL_")) return "CREDENTIAL_SECURITY_INVALID";
  return "CREDENTIAL_READ_FAILED";
}
