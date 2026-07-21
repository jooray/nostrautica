/**
 * Relay-URL validation for untrusted input (audit COORD-16): only `wss://`
 * URLs are usable, malformed entries and duplicates are dropped, and every
 * list is capped so a hostile config can't fan the daemon out.
 */
import { describe, it, expect } from "vitest";
import { sanitizeRelayUrls, MAX_RELAYS_PER_LIST } from "./relay-urls.js";

describe("sanitizeRelayUrls (audit COORD-16)", () => {
  it("keeps well-formed wss URLs, deduped and slash-normalized", () => {
    expect(
      sanitizeRelayUrls([
        "wss://relay.example",
        "wss://relay.example/", // dup (trailing slash)
        "wss://two.example/path",
      ]),
    ).toEqual(["wss://relay.example", "wss://two.example/path"]);
  });

  it("drops ws://, http(s)://, and malformed entries", () => {
    expect(
      sanitizeRelayUrls([
        "ws://insecure.example",
        "https://not-a-relay.example",
        "not a url",
        "",
        "wss://ok.example",
      ]),
    ).toEqual(["wss://ok.example"]);
  });

  it("caps the list (extras dropped in order)", () => {
    const many = Array.from({ length: MAX_RELAYS_PER_LIST + 5 }, (_, i) => `wss://r${i}.example`);
    const out = sanitizeRelayUrls(many);
    expect(out).toHaveLength(MAX_RELAYS_PER_LIST);
    expect(out[0]).toBe("wss://r0.example");
    // A tighter per-author cap (key-package discovery fan-out).
    expect(sanitizeRelayUrls(many, 5)).toHaveLength(5);
  });
});
