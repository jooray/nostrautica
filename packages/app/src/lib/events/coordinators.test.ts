/**
 * Coordinator-derived URLs rendered in Admin (audits APPR-1/APPR-2): only
 * absolute https: URLs may become clickable links. Announcements and billing
 * statuses are self-published relay data; `new URL()` parses `javascript:` and
 * `data:` just fine, so an unguarded pass-through is an XSS link.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("$lib/nostr/stream.js", () => ({ streamEvents: vi.fn() }));

import { httpsUrl, checkoutUrlForEvent } from "./coordinators.js";

const NADDR = "naddr1qqxnzd3cxqmrzvfe8xmnrjvp4q3trv";

describe("httpsUrl (APPR-1)", () => {
  it("passes absolute https: URLs", () => {
    expect(httpsUrl("https://coordinator.example/terms")).toBe("https://coordinator.example/terms");
  });

  it("drops javascript:/data:/http: URLs and unparseable input", () => {
    expect(httpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(httpsUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(httpsUrl("http://insecure.example/terms")).toBeUndefined();
    expect(httpsUrl("not a url")).toBeUndefined();
    expect(httpsUrl("/relative/path")).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});

describe("checkoutUrlForEvent (APPR-2)", () => {
  it("appends the event param to an https checkout URL", () => {
    const out = checkoutUrlForEvent("https://pay.example/checkout?plan=pro", NADDR);
    const u = new URL(out!);
    expect(u.protocol).toBe("https:");
    expect(u.searchParams.get("event")).toBe(NADDR);
    expect(u.searchParams.get("plan")).toBe("pro"); // existing query preserved
  });

  it("rejects javascript: and data: URLs outright (link hidden)", () => {
    expect(checkoutUrlForEvent("javascript:alert(1)", NADDR)).toBeNull();
    expect(checkoutUrlForEvent("data:text/html,<script>alert(1)</script>", NADDR)).toBeNull();
  });

  it("rejects http:, relative, and malformed URLs", () => {
    expect(checkoutUrlForEvent("http://pay.example/checkout", NADDR)).toBeNull();
    expect(checkoutUrlForEvent("/checkout", NADDR)).toBeNull();
    expect(checkoutUrlForEvent("not a url", NADDR)).toBeNull();
  });
});
