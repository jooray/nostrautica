/**
 * Coordinator-derived URLs rendered in Admin (audits APPR-1/APPR-2): only
 * absolute https: URLs may become clickable links. Announcements and billing
 * statuses are self-published relay data; `new URL()` parses `javascript:` and
 * `data:` just fine, so an unguarded pass-through is an XSS link.
 */
import { describe, it, expect, vi } from "vitest";
import { getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

vi.mock("$lib/nostr/stream.js", () => ({ streamEvents: vi.fn() }));

import { httpsUrl, checkoutUrlForEvent, parseCoordinatorKey } from "./coordinators.js";

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

describe("parseCoordinatorKey (create-time picker paste fallback)", () => {
  // A real keypair so the npub round-trips through nostr-tools rather than a
  // hand-written string — the parser must return the exact hex getPublicKey gives.
  const hex = getPublicKey(new Uint8Array(32).fill(7));
  const npub = npubEncode(hex);

  it("decodes a valid npub to its hex pubkey", () => {
    expect(parseCoordinatorKey(npub)).toBe(hex);
  });

  it("accepts a raw 64-char hex pubkey, normalising case", () => {
    expect(parseCoordinatorKey(hex)).toBe(hex);
    expect(parseCoordinatorKey(hex.toUpperCase())).toBe(hex); // hex is lowercased
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseCoordinatorKey(`  ${npub}  `)).toBe(hex);
  });

  it("returns null for empty, malformed, wrong-length, and non-npub bech32", () => {
    expect(parseCoordinatorKey("")).toBeNull();
    expect(parseCoordinatorKey("   ")).toBeNull();
    expect(parseCoordinatorKey("npub1notavalidbech32")).toBeNull();
    expect(parseCoordinatorKey("deadbeef")).toBeNull(); // too short for hex
    // An nsec is valid bech32 but the wrong prefix — must never be accepted as a
    // coordinator pubkey (would be a secret key leak into a public config tag).
    expect(parseCoordinatorKey("nsec1" + "q".repeat(58))).toBeNull();
  });
});
