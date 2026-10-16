export function validateTier1EventCalendar(calendar) {
  if (calendar?.schemaVersion !== 1 || !Array.isArray(calendar?.events)) throw new Error("V4_TIER1_EVENT_CALENDAR_INVALID");
  const ids = new Set();
  for (const event of calendar.events) {
    if (!event?.id || ids.has(event.id) || event.tier !== "TIER1" || !Number.isFinite(Date.parse(event.scheduledAt)) || !String(event.sourceUrl ?? "").startsWith("https://")) {
      throw new Error("V4_TIER1_EVENT_CALENDAR_EVENT_INVALID");
    }
    ids.add(event.id);
  }
  return calendar;
}

export function tier1EventWindowAt({ now, policy, calendar }) {
  if (policy?.enabled !== true) return { active: false, reason: "EVENT_RISK_DISABLED", events: [] };
  validateTier1EventCalendar(calendar);
  const beforeMs = Number(policy.freezeBeforeMinutes) * 60_000;
  const afterMs = Number(policy.freezeAfterMinutes) * 60_000;
  if (!(beforeMs >= 0) || !(afterMs >= 0)) throw new Error("V4_EVENT_RISK_WINDOW_INVALID");
  const active = calendar.events.filter((event) => {
    const releaseAt = Date.parse(event.scheduledAt);
    return now >= releaseAt - beforeMs && now < releaseAt + afterMs;
  });
  return active.length
    ? { active: true, reason: "SCHEDULED_TIER1_EVENT_ENTRY_FREEZE", events: active }
    : { active: false, reason: "NO_ACTIVE_TIER1_EVENT_WINDOW", events: [] };
}
