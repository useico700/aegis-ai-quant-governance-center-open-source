const MINUTE = 60000;
export function evaluateEventGate(calendar, now = Date.now()) {
  const base = { beforeMinutes: 30, afterMinutes: 30, existingPositions: "UNCHANGED_ORIGINAL_RULES", signalWindowExtensionAllowed: false, scanContinues: true };
  const sources = calendar?.sources;
  const valid = Array.isArray(sources) && ["BLS", "BEA", "FED"].every((provider) => sources.some((source) => source.provider === provider &&
    ["LIVE_OFFICIAL", "VERIFIED_FALLBACK"].includes(source.status) && Number.isFinite(Date.parse(source.verifiedAt)) &&
    now - Date.parse(source.verifiedAt) >= -30000 && now - Date.parse(source.verifiedAt) <= 7 * 86400000 &&
    Date.parse(source.coverageEnd) > now + 30 * MINUTE)) &&
    Number.isFinite(Date.parse(calendar?.checkedAt)) && now - Date.parse(calendar.checkedAt) >= -30000 && now - Date.parse(calendar.checkedAt) <= 2 * 3600000 &&
    Array.isArray(calendar?.events) && calendar.events.every((event) => typeof event.id === "string" && Number.isFinite(Date.parse(event.scheduledAt)));
  if (!valid) return { ...base, status: "CALENDAR_UNVERIFIED_PAUSE", newEntriesPaused: true, events: [], pauseUntil: null };
  const windows = calendar.events.map((event) => ({ start: Date.parse(event.scheduledAt) - 30 * MINUTE, end: Date.parse(event.scheduledAt) + 30 * MINUTE, events: [{ id: event.id, name: event.name, scheduledAt: event.scheduledAt }] })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of windows) { const last = merged.at(-1); if (last && item.start <= last.end) { last.end = Math.max(last.end, item.end); last.events.push(...item.events); } else merged.push({ ...item, events: [...item.events] }); }
  const active = merged.find((window) => now >= window.start && now < window.end);
  return { ...base, status: active ? "EVENT_WINDOW_PAUSE" : "NO_SCHEDULED_WINDOW", newEntriesPaused: !!active,
    events: active?.events ?? [], pauseUntil: active ? new Date(active.end).toISOString() : null, calendarCheckedAt: calendar.checkedAt,
    nextWindowAt: merged.find((window) => window.start > now) ? new Date(merged.find((window) => window.start > now).start).toISOString() : null };
}
