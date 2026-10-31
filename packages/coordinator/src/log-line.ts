/**
 * Make a string safe to write as ONE operator log line (audit R-48).
 *
 * Attendee-controlled text reaches the log verbatim: a join name, a talk title,
 * AI-profile skills. A newline in any of them starts a forged record — including
 * a copy of the daemon's readiness line, which the deploy's restart script greps
 * for — and an ANSI escape repaints whatever terminal tails the log. C0 and C1
 * controls, the Unicode line/paragraph separators and the bidi overrides are
 * replaced with a visible `\uXXXX`, so the record stays one line and still shows
 * that something odd was sent.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeLogText(s: string): string {
  return s.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * `10-29 03:51:07`: the UTC month-day and time that goes inside the `[…]` at the
 * start of every daemon log line (audit O-4).
 *
 * The prefix used to be the time alone (`[03:51:07]`), so every incident analysis
 * had to infer the DAY from logrotate boundaries: a week of log has seven
 * 03:51:07s. The year is left out on purpose. The file is rotated long before it
 * matters, and lifecycle.ts keeps the full ISO stamp for the few lines that are
 * read across deploys. Fixed width (14 characters), so columns still line up.
 */
/**
 * An error as one line, WITH its cause chain (`a: b ← caused by: c`), capped so a
 * pathological chain cannot become a log line of its own size.
 */
export function describeError(e: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < maxDepth && cur !== undefined && cur !== null; i++) {
    parts.push(cur instanceof Error ? `${cur.name !== "Error" ? `${cur.name}: ` : ""}${cur.message}` : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(" ← caused by: ").slice(0, 600);
}

/**
 * Once per key per window (audit R-5). A handler that fires per relay delivery —
 * the 445 ingest, the 30443 watcher — must not turn one broken group into a line
 * per message, and must not go silent either, which is what `.catch(() => {})`
 * did. The first failure in a window prints; the rest are counted, and the count
 * rides on the next line that prints.
 */
export class LogThrottle {
  private readonly windows = new Map<string, { until: number; suppressed: number }>();
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 1_000,
  ) {}

  /**
   * `undefined` when this occurrence is suppressed; otherwise how many were
   * suppressed for `key` since the last one that printed.
   */
  admit(key: string): number | undefined {
    const now = this.now();
    const w = this.windows.get(key);
    if (w && w.until > now) {
      w.suppressed++;
      return undefined;
    }
    if (!w && this.windows.size >= this.maxKeys) {
      for (const [k, v] of this.windows) if (v.until <= now) this.windows.delete(k);
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (!oldest.done) this.windows.delete(oldest.value);
      }
    }
    const suppressed = w?.suppressed ?? 0;
    this.windows.set(key, { until: now + this.windowMs, suppressed: 0 });
    return suppressed;
  }
}

export function logStamp(at: Date = new Date()): string {
  const iso = at.toISOString(); // 2026-10-29T03:51:07.004Z
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`;
}
