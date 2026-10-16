import { publicApi } from "../../../lib/public-preview.mjs";
import seed from "../../../lib/s1-risk-calendar-seed.json";
import { parseIcs, parseBlsMonth, parseFedMonth, DAY } from "../../../lib/s1-risk-calendar.mjs";
type Event = typeof seed.events[number];
type Source = { provider: string; status: string; verifiedAt: string; coverageEnd: string; error: string | null; dataVerifiedAt?: string };
type Calendar = { checkedAt: string; events: Event[]; sources: Source[]; displayOnly: boolean; executionControl: false };
let cached: Calendar | null = null, expires = 0, pending: Promise<Calendar> | null = null;
async function officialText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6500), redirect: "manual", headers: { Accept: "text/calendar,text/html;q=0.9", "User-Agent": "AEGIS-Risk-Calendar/1.0 (+https://your-cockpit.example.invalid" } });
  if (!response.ok) throw new Error(`OFFICIAL_HTTP_${response.status}`);
  const body = await response.text(); if (body.length > 1000000) throw new Error("OFFICIAL_RESPONSE_TOO_LARGE"); return body;
}
async function refresh(): Promise<Calendar> {
  const now = Date.now(), verifiedAt = new Date(now).toISOString();
  const results = await Promise.all(["BLS", "BEA", "FED"].map(async (provider) => {
    try {
      let events: Event[], coverageEnd: string;
      if (provider === "FED") {
        const cursor = new Date(now - DAY); cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
        const months: { year: number; month: number; url: string }[] = [];
        while (+cursor <= now + 31 * DAY) { const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth() + 1; const name = cursor.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase(); months.push({ year, month, url: `https://www.federalreserve.gov/newsevents/${year}-${name}.htm` }); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
        events = (await Promise.all(months.map(async ({ year, month, url }) => parseFedMonth(await officialText(url), year, month, url)))).flat();
        coverageEnd = cursor.toISOString();
      } else if (provider === "BLS") {
        const icsUrl = "https://www.bls.gov/schedule/news_release/bls.ics";
        try {
          events = parseIcs(await officialText(icsUrl), provider, icsUrl);
          const last = Math.max(...events.map((event) => Date.parse(event.scheduledAt)));
          if (last < now) throw new Error("OFFICIAL_FEED_HAS_NO_FUTURE_COVERAGE");
          coverageEnd = new Date(last + DAY).toISOString();
        } catch {
          const cursor = new Date(now - DAY); cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
          const months: { year: number; month: number; url: string }[] = [];
          while (+cursor <= now + 62 * DAY) {
            const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth() + 1;
            months.push({ year, month, url: `https://www.bls.gov/schedule/${year}/${String(month).padStart(2, "0")}_sched.htm` });
            cursor.setUTCMonth(cursor.getUTCMonth() + 1);
          }
          const annual = new Map<number, Promise<string>>();
          events = (await Promise.all(months.map(async ({ year, month }) => {
            const url = `https://www.bls.gov/schedule/${year}/`;
            if (!annual.has(year)) annual.set(year, officialText(url));
            return parseBlsMonth(await annual.get(year)!, year, month, url);
          }))).flat();
          coverageEnd = cursor.toISOString();
        }
      } else {
        const url = "https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics";
        events = parseIcs(await officialText(url), provider, url);
        const last = Math.max(...events.map((event) => Date.parse(event.scheduledAt)));
        if (last < now) throw new Error("OFFICIAL_FEED_HAS_NO_FUTURE_COVERAGE");
        coverageEnd = new Date(last + DAY).toISOString();
      }
      return { events, source: { provider, status: "LIVE_OFFICIAL", verifiedAt, coverageEnd, error: null } as Source };
    } catch (error) {
      // `verifiedAt` records this current official recheck attempt. The data's
      // original verification time remains explicit and the fallback ceases to
      // qualify when its declared coverage ends.
      return { events: seed.events.filter((event) => event.provider === provider), source: { provider,
        status: "VERIFIED_FALLBACK", verifiedAt, dataVerifiedAt: seed.verifiedAt,
        coverageEnd: seed.coverageEnd, error: error instanceof Error ? error.message : "SOURCE_UNAVAILABLE" } as Source };
    }
  }));
  return { checkedAt: verifiedAt, displayOnly: false, executionControl: false, sources: results.map((result) => result.source), events: results.flatMap((result) => result.events).filter((event) => Date.parse(event.scheduledAt) >= now - DAY && Date.parse(event.scheduledAt) <= now + 62 * DAY).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt)) };
}
export async function GET() {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("s1-risk-calendar", "GET");

  if (!cached || Date.now() >= expires) {
    pending ??= refresh().then((data) => { cached = data; expires = Date.now() + 3600000; return data; }).finally(() => { pending = null; });
    await pending;
  }
  return Response.json(cached, { headers: { "Cache-Control": "private, max-age=300" } });
}
