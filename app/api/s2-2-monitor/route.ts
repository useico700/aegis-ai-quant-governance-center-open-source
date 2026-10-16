import { publicApi } from "../../../lib/public-preview.mjs";
import snapshot from "../../s2-2/report.json";
// Frozen historical run. No account endpoints, order endpoints, or live polling.
export function GET(request: Request) {
  const download=new URL(request.url).searchParams.get("download")==="1";
  return Response.json(snapshot,{headers:{"Cache-Control":"no-store",...(download?{"Content-Disposition":"attachment; filename=S2-2-report.json"}:{})}});
}
