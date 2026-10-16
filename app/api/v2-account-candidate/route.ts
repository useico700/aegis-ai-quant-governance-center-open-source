import { publicApi } from "../../../lib/public-preview.mjs";
import { createCandidateHandlers } from "@/app/v2-ledger/account-shadow/candidate-api.mjs";

// Read-only summary publication: deliberately separate from baseline ingestion and execution.
const handlers = createCandidateHandlers(async () => (await import("cloudflare:workers")).env);
export const GET = handlers.GET;
export const POST = handlers.POST;
