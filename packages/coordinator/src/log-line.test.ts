import { describe, expect, it } from "vitest";
import { describeError, LogThrottle, logStamp, sanitizeLogText } from "./log-line.js";

describe("LogThrottle + describeError (audit R-5)", () => {
  it("admits once per key per window and reports what it suppressed", () => {
    let t = 0;
    const th = new LogThrottle(1_000, () => t);
    expect(th.admit("a")).toBe(0);
    expect(th.admit("a")).toBeUndefined();
    expect(th.admit("a")).toBeUndefined();
    expect(th.admit("b")).toBe(0); // keys are independent
    t = 1_000;
    expect(th.admit("a")).toBe(2);
  });

  it("stays bounded in the number of keys it remembers", () => {
    const th = new LogThrottle(60_000, () => 0, 3);
    for (const k of ["a", "b", "c", "d"]) th.admit(k);
    expect((th as any).windows.size).toBe(3);
  });

  it("prints the cause chain", () => {
    const e = new Error("outer", { cause: new TypeError("inner") });
    expect(describeError(e)).toBe("outer ← caused by: TypeError: inner");
    expect(describeError("plain")).toBe("plain");
  });
});

describe("logStamp (audit O-4)", () => {
  it("carries the date, not just the time of day", () => {
    expect(logStamp(new Date("2026-10-29T03:51:07.004Z"))).toBe("10-29 03:51:07");
  });

  it("tells two days' 03:51:07 apart, at a fixed width", () => {
    const a = logStamp(new Date("2026-10-28T03:51:07Z"));
    const b = logStamp(new Date("2026-10-29T03:51:07Z"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

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
