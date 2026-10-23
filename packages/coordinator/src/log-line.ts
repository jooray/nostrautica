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
