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

describe("sanitizeRelayUrls SSRF policy (audit C4)", () => {
  it("rejects credential-bearing and fragment URLs", () => {
    expect(
      sanitizeRelayUrls([
        "wss://user:pass@relay.example",
        "wss://relay.example/#frag",
        "wss://ok.example",
      ]),
    ).toEqual(["wss://ok.example"]);
  });

  it("rejects loopback / private / link-local host literals by default", () => {
    expect(
      sanitizeRelayUrls([
        "wss://127.0.0.1",
        "wss://10.0.0.5",
        "wss://192.168.1.1",
        "wss://169.254.1.1",
        "wss://[::1]",
        "wss://localhost",
        "wss://sub.localhost",
        "wss://public.example",
      ]),
    ).toEqual(["wss://public.example"]);
  });

  it("permits ws:// and private hosts only behind the dev flag", () => {
    expect(
      sanitizeRelayUrls(["ws://127.0.0.1:7777", "wss://public.example"], { allowInsecure: true }),
    ).toEqual(["ws://127.0.0.1:7777", "wss://public.example"]);
    // Without the flag both the ws scheme and the loopback host are dropped.
    expect(sanitizeRelayUrls(["ws://127.0.0.1:7777"])).toEqual([]);
  });

  it("enforces an operator host allowlist (URL or bare host entries)", () => {
    const policy = { allowlist: ["wss://good.example", "also-good.example"] };
    expect(
      sanitizeRelayUrls(
        ["wss://good.example", "wss://also-good.example/path", "wss://evil.example"],
        policy,
      ),
    ).toEqual(["wss://good.example", "wss://also-good.example/path"]);
  });
});
