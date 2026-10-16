// Integrity envelope in the existing payload column; no schema mutation or history rewrite.
// Detects isolated corruption, not a coordinated rewrite of both state and digest.
async function digest(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function encodeShadowState(state) {
  return JSON.stringify({ envelopeVersion: 1, state_sha256: await digest(state), state });
}

export async function decodeShadowState(payload) {
  const envelope = JSON.parse(payload);
  if (!envelope || Object.keys(envelope).sort().join(",") !== "envelopeVersion,state,state_sha256"
    || envelope.envelopeVersion !== 1 || !envelope.state || typeof envelope.state !== "object"
    || envelope.state_sha256 !== await digest(envelope.state)) {
    throw new Error("ACCOUNT_SHADOW_STATE_DIGEST_MISMATCH");
  }
  return envelope.state;
}
