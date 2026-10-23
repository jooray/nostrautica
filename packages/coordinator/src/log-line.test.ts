import { describe, expect, it } from "vitest";
import { sanitizeLogText } from "./log-line.js";

describe("sanitizeLogText (audit R-48)", () => {
  it("keeps a forged readiness line on the attacker's own record", () => {
    const name = "Mallory\n[coordinator] running — watching for installs, submissions, admin commands";
    const out = sanitizeLogText(`[join] request from abcd1234 ("${name}")`);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("Mallory\\u000a[coordinator] running");
  });

  it("neutralises CR, ANSI escapes, C1 controls, line separators and bidi overrides", () => {
    expect(sanitizeLogText("a\rb\u001b[2Jc\u0085d\u2028e\u202ef")).toBe(
      "a\\u000db\\u001b[2Jc\\u0085d\\u2028e\\u202ef",
    );
  });

  it("leaves ordinary text, including non-ASCII, untouched", () => {
    const s = '[talk] "Ako na Nostr — úvod" from abcd1234 (rev 2) → pending moderation';
    expect(sanitizeLogText(s)).toBe(s);
  });
});
