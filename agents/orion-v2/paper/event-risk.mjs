/**
 * Scheduled macro-event risk is deliberately narrow.  It never touches an
 * open paper position; it only answers whether a *new* entry may be created
 * at a particular decision clock.
 */
export function validateTier1EventCalendar(calendar) {
  if (calendar?.schemaVersion !== 1 || !Array.isArray(calendar?.events)) {
    throw new Error("MTFX_TIER1_EVENT_CALENDAR_INVALID");
  }
  const ids = new Set();
  for (const event of calendar.events) {
    if (!event?.id || ids.has(event.id)) throw new Error("MTFX_TIER1_EVENT_CALENDAR_DUPLICATE_ID");
    ids.add(event.id);
    if (event.tier !== "TIER1" || !Number.isFinite(Date.parse(event.scheduledAt))) {
      throw new Error("MTFX_TIER1_EVENT_CALENDAR_EVENT_INVALID");
    }
    if (!String(event.sourceUrl ?? "").startsWith("https://")) {
      throw new Error("MTFX_TIER1_EVENT_CALENDAR_SOURCE_REQUIRED");
    }
  }
  return calendar;
}

export function tier1EventWindowAt({ now, policy, calendar }) {
  if (policy?.enabled !== true) return { active: false, reason: "EVENT_RISK_DISABLED", events: [] };
  validateTier1EventCalendar(calendar);
  const beforeMs = Number(policy.freezeBeforeMinutes) * 60_000;
  const afterMs = Number(policy.freezeAfterMinutes) * 60_000;
  if (!(beforeMs >= 0) || !(afterMs >= 0)) throw new Error("MTFX_EVENT_RISK_WINDOW_INVALID");
  const active = calendar.events.filter((event) => {
    const releaseAt = Date.parse(event.scheduledAt);
    return now >= releaseAt - beforeMs && now < releaseAt + afterMs;
  }).sort((first, second) => Date.parse(first.scheduledAt) - Date.parse(second.scheduledAt));
  if (!active.length) return { active: false, reason: "NO_ACTIVE_TIER1_EVENT_WINDOW", events: [] };
  const windowStart = Math.min(...active.map((event) => Date.parse(event.scheduledAt) - beforeMs));
  const windowEnd = Math.max(...active.map((event) => Date.parse(event.scheduledAt) + afterMs));
  return {
    active: true,
    reason: "SCHEDULED_TIER1_EVENT_ENTRY_FREEZE",
    events: active,
    eventIds: active.map((event) => event.id),
    windowStart,
    windowEnd,
  };
}

export function nextTier1EventWindow({ now, policy, calendar }) {
  if (policy?.enabled !== true) return null;
  validateTier1EventCalendar(calendar);
  const beforeMs = Number(policy.freezeBeforeMinutes) * 60_000;
  const afterMs = Number(policy.freezeAfterMinutes) * 60_000;
  const candidates = calendar.events
    .map((event) => ({ event, releaseAt: Date.parse(event.scheduledAt) }))
    .filter(({ releaseAt }) => Number.isFinite(releaseAt) && releaseAt + afterMs > now)
    .sort((first, second) => first.releaseAt - second.releaseAt);
  const next = candidates[0];
  if (!next) return null;
  return {
    ...next.event,
    releaseAt: next.releaseAt,
    windowStart: next.releaseAt - beforeMs,
    windowEnd: next.releaseAt + afterMs,
    active: now >= next.releaseAt - beforeMs,
  };
}
