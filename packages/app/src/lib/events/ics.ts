/**
 * Client-side iCalendar (.ics) generation for the event logistics block
 * (audit §7.4.9 "add-to-calendar"). Pure and dependency-free so it's fully
 * unit-testable and needs no server: the logistics UI turns the string into a
 * Blob download. Follows RFC 5545 for UTC timestamps, TEXT escaping, and 75-
 * octet line folding.
 */

export interface IcsEvent {
  /** Stable unique id (e.g. the event coordinate); a random one is generated if absent. */
  uid?: string;
  title: string;
  description?: string;
  location?: string;
  /** Unix seconds. */
  start: number;
  /** Unix seconds; omitted → a 2-hour default block from start. */
  end?: number;
  /** Absolute event URL, appended to the description if given. */
  url?: string;
}

/** Format Unix seconds as an RFC 5545 UTC timestamp: `YYYYMMDDTHHMMSSZ`. */
export function icsUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash, comma, semicolon, newlines). */
export function icsEscape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTF-8 length of one code point. */
function utf8Octets(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * Fold a content line to <=75 octets with CRLF + space continuation (§3.1).
 *
 * Octets of UTF-8, not UTF-16 code units (audit R-79): counting `.length` let a
 * CJK title run to 3x the limit on one physical line, and slicing at a fixed
 * index could split a surrogate pair into two lone halves. Breaks fall only
 * between code points, so unfolding restores the line exactly.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = "";
  let octets = 0;
  // The first physical line holds 75 octets; a continuation line spends one of
  // its 75 on the leading space.
  let limit = 75;
  for (const ch of line) {
    const n = utf8Octets(ch.codePointAt(0)!);
    if (octets + n > limit) {
      parts.push(cur);
      cur = " ";
      octets = 1;
      limit = 75;
    }
    cur += ch;
    octets += n;
  }
  parts.push(cur);
  return parts.join("\r\n");
}

/** Build a complete single-event VCALENDAR document. */
export function buildIcs(ev: IcsEvent, now = Date.now()): string {
  const end = ev.end && ev.end > ev.start ? ev.end : ev.start + 2 * 60 * 60;
  const uid = ev.uid ?? `${Math.random().toString(36).slice(2)}-${now}`;
  const descParts: string[] = [];
  if (ev.description) descParts.push(ev.description);
  if (ev.url) descParts.push(ev.url);
  const desc = descParts.join("\n\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nostrautica//Event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${icsUtc(Math.floor(now / 1000))}`,
    `DTSTART:${icsUtc(ev.start)}`,
    `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
  ];
  if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.url) lines.push(`URL:${icsEscape(ev.url)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** A filesystem-safe .ics filename derived from the event title. */
export function icsFilename(title: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "event";
  return `${base}.ics`;
}
