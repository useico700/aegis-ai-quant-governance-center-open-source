export const DAY = 86400000;
export function easternToUtc(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 3; i++) { const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value])); const rendered = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute); instant += wall - rendered; }
  return new Date(instant).toISOString();
}
function definition(summary, provider) {
  if (provider === "BLS") {
    if (/^Consumer Price Index/i.test(summary)) return ["美国 CPI", "CPI", "TIER1"];
    if (/^Employment Situation/i.test(summary)) return ["美国非农就业报告", "NFP", "TIER1"];
    if (/^Producer Price Index/i.test(summary)) return ["美国 PPI", "PPI", "WATCH"];
    if (/^Job Openings and Labor Turnover/i.test(summary)) return ["美国 JOLTS 职位空缺", "JOLTS", "WATCH"];
  }
  if (provider === "BEA") {
    if (/^Personal Income and Outlays/i.test(summary)) return ["美国个人收入与支出 · PCE", "PCE", "TIER1"];
    if (/^(Gross Domestic Product|GDP\b)/i.test(summary) && !/^Gross Domestic Product by State|^Gross Domestic Product by County/i.test(summary)) return ["美国 GDP", "GDP", "WATCH"];
  }
  return null;
}
export function parseIcs(body, provider, sourceUrl) {
  if (!body.includes("BEGIN:VCALENDAR") || body.length > 1000000) throw new Error("INVALID_CALENDAR_FORMAT");
  const events = [];
  const unfolded = body.replace(/\r?\n[ \t]/g, "");
  for (const match of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    const block = match[1];
    if (/^STATUS:CANCELLED\s*$/m.test(block)) continue;
    const summary = block.match(/^SUMMARY[^:]*:(.*)$/m)?.[1]?.replace(/\\,/g, ",").trim() ?? "";
    const info = definition(summary, provider); if (!info) continue;
    const start = block.match(/^DTSTART([^:]*):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)\s*$/m);
    if (!start) continue;
    const [, zone, y, m, d, hh, mm, ss, utc] = start;
    if (!utc && zone.includes("TZID=") && !zone.includes("America/New_York")) continue;
    const scheduledAt = utc ? `${y}-${m}-${d}T${hh}:${mm}:${ss}.000Z` : easternToUtc(+y, +m, +d, +hh, +mm);
    if (!Number.isFinite(Date.parse(scheduledAt))) continue;
    const [name, category, tier] = info;
    events.push({ id: `${provider}_${category}_${scheduledAt}`, provider, name, category, tier, scheduledAt, sourceUrl });
  }
  if (!events.length) throw new Error("NO_RECOGNIZED_CALENDAR_EVENTS");
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
const plain = (html) => html
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;|&#34;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, " ")
  .trim();

export function parseBlsMonth(html, year, month, sourceUrl) {
  if (!/Bureau of Labor Statistics/i.test(html) || !/Economic News Release/i.test(html)) throw new Error("BLS_FORMAT_CHANGED");
  const events = [];
  const cellPattern = /<td\b[^>]*\bid=["']d(\d{2})(\d{2})["'][^>]*>([\s\S]*?)<\/td>/gi;
  for (const cell of html.matchAll(cellPattern)) {
    const cellMonth = Number(cell[1]), day = Number(cell[2]);
    if (cellMonth !== month || !Number.isInteger(day) || day < 1 || day > 31) continue;
    for (const paragraph of cell[3].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const strong = paragraph[1].match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
      if (!strong) continue;
      const summary = plain(strong[1]);
      const info = definition(summary, "BLS");
      if (!info) continue;
      const time = plain(paragraph[1]).match(/\b(\d{1,2}):(\d{2})\s*([AP])M\b/i);
      if (!time) throw new Error("BLS_EVENT_TIME_NOT_PARSED");
      const [name, category, tier] = info;
      const hour = (+time[1] % 12) + (time[3].toUpperCase() === "P" ? 12 : 0);
      const scheduledAt = easternToUtc(year, month, day, hour, +time[2]);
      events.push({ id: `BLS_${category}_${scheduledAt}`, provider: "BLS", name, category, tier, scheduledAt, sourceUrl });
    }
  }
  // The official annual list view remains usable when a monthly endpoint
  // intermittently returns a short NUL-filled HTTP 200 response.
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const rowPattern = /<tr\b[^>]*>[\s\S]*?<td\b[^>]*class=["'][^"']*date-cell[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<td\b[^>]*class=["'][^"']*time-cell[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<td\b[^>]*class=["'][^"']*desc-cell[^"']*["'][^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
  for (const row of html.matchAll(rowPattern)) {
    const date = plain(row[1]).match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    if (!date || Number(date[3]) !== year || monthNames.indexOf(date[1].toLowerCase()) + 1 !== month) continue;
    const strong = row[3].match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    const info = strong ? definition(plain(strong[1]), "BLS") : null;
    if (!info) continue;
    const time = plain(row[2]).match(/\b(\d{1,2}):(\d{2})\s*([AP])M\b/i);
    if (!time) throw new Error("BLS_EVENT_TIME_NOT_PARSED");
    const [name, category, tier] = info, day = Number(date[2]);
    const hour = (+time[1] % 12) + (time[3].toUpperCase() === "P" ? 12 : 0);
    const scheduledAt = easternToUtc(year, month, day, hour, +time[2]);
    events.push({ id: `BLS_${category}_${scheduledAt}`, provider: "BLS", name, category, tier, scheduledAt, sourceUrl });
  }
  if (!events.length) throw new Error("NO_RECOGNIZED_BLS_EVENTS");
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
export function parseFedMonth(html, year, month, sourceUrl) {
  if (!html.includes("FOMC Meetings") || !html.includes("Release Date(s)")) throw new Error("FED_FORMAT_CHANGED");
  const section = html.slice(html.indexOf("FOMC Meetings"), html.indexOf("Beige Book", html.indexOf("FOMC Meetings")));
  const events = [];
  const pattern = /<div class="col-xs-2">((?:(?!<div|<\/div>)[\s\S])*)<\/div>\s*<div class="col-xs-7">([\s\S]*?)<\/div>\s*<div class="col-xs-3">([\s\S]*?)<\/div>/g;
  for (const row of section.matchAll(pattern)) {
    const time = plain(row[1]).match(/^(\d{1,2}):(\d{2})\s*([ap])\.m\.$/i), description = plain(row[2]), day = Number(plain(row[3]));
    if (!time || !Number.isInteger(day) || day < 1 || day > 31) continue;
    const info = description.startsWith("FOMC Press Conference") ? ["美联储新闻发布会", "FOMC_PRESS", "TIER1"] : description.startsWith("FOMC Minutes") ? ["FOMC 会议纪要", "FOMC_MINUTES", "WATCH"] : description.startsWith("FOMC Meeting") ? ["FOMC 利率决议", "FOMC", "TIER1"] : null;
    if (!info) continue;
    const [name, category, tier] = info;
    const scheduledAt = easternToUtc(year, month, day, (+time[1] % 12) + (time[3].toLowerCase() === "p" ? 12 : 0), +time[2]);
    events.push({ id: `FED_${category}_${scheduledAt}`, provider: "FED", name, category, tier, scheduledAt, sourceUrl });
  }
  const expected = [...section.matchAll(/FOMC (?:Press Conference|Minutes|Meeting)(?=<|\s)/g)].length;
  if (events.length !== expected) throw new Error("FED_EVENTS_NOT_FULLY_PARSED");
  return events;
}
export function eventPhase(event, now) {
  const at = Date.parse(event.scheduledAt), width = 30 * 60000;
  if (now >= at - width && now < at + width) return "WINDOW";
  return now < at ? "UPCOMING" : "PASSED";
}
export function rollingEvents(events, now, days = 30, tier = "ALL") {
  return events.filter((event) => Date.parse(event.scheduledAt) >= now - DAY && Date.parse(event.scheduledAt) <= now + days * DAY && (tier === "ALL" || event.tier === tier)).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}
export function calendarFreshness(source, now, end) {
  if (Date.parse(source.coverageEnd) < end) return "INCOMPLETE";
  if (now - Date.parse(source.verifiedAt) > 7 * DAY) return "NEEDS_RECHECK";
  return source.status;
}
