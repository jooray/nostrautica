/**
 * Event logistics helpers (audit §7.4.9). Pure timing/formatting logic for the
 * logistics block: the happening-now state machine, a full localized date/time
 * range with the viewer's time zone, and a maps directions URL. Extracted so the
 * state transitions are unit-tested without a clock or DOM.
 */

export type EventPhase = "upcoming" | "happening" | "ended" | "unknown";

/**
 * Phase of an event relative to `now` (all Unix seconds). `happening` runs from
 * start to end (or start + `defaultDurationSec` when no end is set). Before start
 * → upcoming; after end → ended; no start → unknown.
 */
export function eventPhase(
  start: number | undefined,
  end: number | undefined,
  now: number,
  defaultDurationSec = 2 * 60 * 60,
): EventPhase {
  if (!start) return "unknown";
  const effectiveEnd = end && end > start ? end : start + defaultDurationSec;
  if (now < start) return "upcoming";
  if (now <= effectiveEnd) return "happening";
  return "ended";
}

/** Whole days until start (>=0), or null if already started / no start. */
export function daysUntil(start: number | undefined, now: number): number | null {
  if (!start || now >= start) return null;
  return Math.ceil((start - now) / 86_400);
}

/**
 * Localized start–end string including the viewer's time zone name (audit wants
 * "full start/end with timezone"). Same-day ranges collapse the date on the end.
 */
export function formatRange(
  start: number | undefined,
  end: number | undefined,
  locale: string,
): string {
  if (!start) return "";
  const startDate = new Date(start * 1000);
  const dateTime = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (!end || end <= start) return dateTime.format(startDate);

  const endDate = new Date(end * 1000);
  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  if (sameDay) {
    const timeOnly = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return `${dateTime.format(startDate)} – ${timeOnly.format(endDate)}`;
  }
  return `${dateTime.format(startDate)} – ${dateTime.format(endDate)}`;
}

/** A maps directions URL for a free-text venue string, or null when empty. */
export function directionsUrl(location: string | undefined): string | null {
  const q = (location ?? "").trim();
  if (!q) return null;
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`;
}
