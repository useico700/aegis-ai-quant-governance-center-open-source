// Presentation only. Never creates, admits, cancels or retimes a scanner event.
const HOUR = 3600000;

/** @param {{ clock?: import('./types').IntersectionClock | null, candidateEvent?: import('./types').IntersectionEvent | null, scanFresh: boolean, now: number, quotePrice?: number | null, quoteFresh: boolean }} input */
export function buildIntersectionView({ clock, candidateEvent, scanFresh, now, quotePrice, quoteFresh }) {
  const base = { window: null, start: null, end: null, markerX: null, nowX: null, distance: null, percent: null, otherWindows: 0 };
  if (!scanFresh || !Number.isFinite(now) || now <= 0 || !clock
    || clock.revision !== 'SMC-INTERSECTION-CLOCK-1' || clock.coordinate !== 'LOG' || clock.orderAuthority !== false
    || !Number.isFinite(clock.observedAt) || now - clock.observedAt < -5000 || now - clock.observedAt > 360000) {
    return { ...base, status: 'UNAVAILABLE' };
  }
  const windows = (clock.windows ?? []).filter(w => w?.event?.id
    && [w.event.tx, w.event.px, w.opensAt, w.expiresAt, w.selectedAt].every(Number.isFinite)
    && w.event.tx > 0 && w.event.tx < 8e15 && w.event.px > 0 && w.opensAt === w.event.tx
    && w.selectedAt < w.opensAt && w.expiresAt > w.opensAt && w.expiresAt >= now)
    .sort((a, b) => a.opensAt - b.opensAt);
  // A real candidate retains its own source event; never substitute a different
  // window merely because it is nearer to the current clock or price.
  const window = candidateEvent
    ? windows.find(w => w.event.id === candidateEvent.id && w.event.tx === candidateEvent.tx && w.event.px === candidateEvent.px)
    : windows.find(w => w.opensAt <= now) ?? windows[0];
  if (!window) return { ...base, status: candidateEvent ? 'SOURCE_UNAVAILABLE' : 'EMPTY' };
  const start = Math.min(now, window.event.tx) - HOUR;
  const end = Math.max(now, window.event.tx) + HOUR;
  const x = t => (t - start) / (end - start) * 100;
  const live = quoteFresh && typeof quotePrice === 'number' && Number.isFinite(quotePrice) && quotePrice > 0;
  const distance = live ? window.event.px - quotePrice : null;
  return { window, start, end, markerX: x(window.event.tx), nowX: x(now),
    distance, percent: distance == null ? null : distance / quotePrice * 100,
    status: now < window.opensAt ? 'UPCOMING' : 'WINDOW', otherWindows: windows.length - 1 };
}
