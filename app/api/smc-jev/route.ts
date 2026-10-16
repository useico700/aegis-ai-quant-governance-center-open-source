import { publicApi } from "../../../lib/public-preview.mjs";
// Owner stopped the entire JEV system on 2026-10-10. No observer runs in this
// request path; preserved snapshots remain historical evidence only.
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("smc-jev", "GET");

  return Response.json({ status: "OWNER_STOPPED", observation: null, orderAuthority: false,
    authorization: "OWNER-DIRECTIVE-JEV-STOP-ALL-20261010" }, { headers });
}
