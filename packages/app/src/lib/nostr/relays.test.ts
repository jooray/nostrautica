/**
 * Relay-set policy helpers. `signerRelays` is the fix for a NIP-46 outage mode we
 * actually hit: `wss://relay.nsec.app` (the relay nsec.app names in its own
 * `bunker://` URIs) went down — HTTP 502 on the WebSocket upgrade, 3/3 probes —
 * and because the bunker paths used ONLY the pointer's relays, such a link could
 * neither connect nor be restored.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RELAYS,
  DEFAULT_READ_RELAYS,
  NIP46_RELAYS,
  WHITENOISE_RELAYS,
  chatInteropRelays,
  chatRelaysOf,
  signerRelays,
  unionRelays,
} from "./relays.js";

describe("signerRelays (NIP-46 transport set)", () => {
  it("keeps the pointer's own relays FIRST — that's where the signer listens", () => {
    const out = signerRelays(["wss://bunker.example"]);
    expect(out[0]).toBe("wss://bunker.example");
  });

  it("unions the app's signer defaults in behind them, so one dead relay isn't fatal", () => {
    const out = signerRelays(["wss://relay.nsec.app"]);
    for (const dflt of NIP46_RELAYS) expect(out).toContain(dflt);
    expect(out.length).toBe(NIP46_RELAYS.length + 1);
  });

  it("de-duplicates a pointer relay that is already an app default", () => {
    const out = signerRelays([NIP46_RELAYS[0]]);
    expect(out).toEqual([...NIP46_RELAYS]);
  });

  it("de-duplicates across a trailing-slash difference (relays are the same host)", () => {
    const out = signerRelays([NIP46_RELAYS[0] + "/"]);
    expect(new Set(out).size).toBe(out.length);
    expect(out.length).toBe(NIP46_RELAYS.length);
  });

  it("falls back to the app defaults for an empty pointer", () => {
    expect(signerRelays([])).toEqual(unionRelays(NIP46_RELAYS));
  });

  it("no longer advertises the dead signer relay by default", () => {
    // Removed 2026-07-25 (502 on every probe). Still ACCEPTED from a pointer —
    // see the union tests above — just not handed out in our nostrconnect QR.
    expect(NIP46_RELAYS).not.toContain("wss://relay.nsec.app");
  });

  it("advertises four distinct signer relays, with the local strfry first", () => {
    // Widened from three 2026-07-28 after the strfry cutover: the local relay
    // is the preferred low-latency signer transport, while three independent
    // public operators remain as ephemeral-reply redundancy.
    expect(new Set(NIP46_RELAYS).size).toBe(4);
    expect(NIP46_RELAYS[0]).toBe("wss://nostr.cypherpunk.today");
    expect(NIP46_RELAYS).toContain("wss://relay.nostr.net");
  });
});

/**
 * Chat relays are a separate set from the event's relays. The Whitenoise/Marmot
 * interop pair accepts only the chat kinds (0/3/445/1059/10000/10002/10050/30443
 * — probed 2026-07-28) and answers everything else with "blocked: kind N is not
 * accepted by this relay", so anything that mixes them into `DEFAULT_RELAYS` or
 * an event's `config.relays` is publishing into a guaranteed rejection.
 */
describe("chat relays", () => {
  it("is disjoint from the app's general relay defaults", () => {
    for (const url of WHITENOISE_RELAYS) {
      expect(DEFAULT_RELAYS).not.toContain(url);
      expect(DEFAULT_READ_RELAYS).not.toContain(url);
      expect(NIP46_RELAYS).not.toContain(url);
    }
  });

  it("attaches the interop pair to an ordinary event", () => {
    expect(chatInteropRelays(["wss://nostr.cypherpunk.today"])).toEqual(WHITENOISE_RELAYS);
  });

  // Mirrors the coordinator's carve-out: a local e2e event must never make the
  // test run dial public infrastructure.
  it("attaches nothing when every event relay is loopback", () => {
    expect(chatInteropRelays(["ws://localhost:7777"])).toEqual([]);
    expect(chatInteropRelays(["ws://127.0.0.1:7777", "ws://localhost:7777"])).toEqual([]);
    // One public relay in the set means it is not a local-only event.
    expect(chatInteropRelays(["ws://localhost:7777", "wss://nos.lol"])).toEqual(WHITENOISE_RELAYS);
    // An empty set is "not yet known", not "local" — fall back to attaching.
    expect(chatInteropRelays([])).toEqual(WHITENOISE_RELAYS);
  });

  it("returns a fresh array so a caller can't mutate the shared constant", () => {
    chatInteropRelays([]).push("wss://evil.example");
    expect(WHITENOISE_RELAYS).not.toContain("wss://evil.example");
  });

  // An EventContext cached by an app version that predates `chat_relay` has no
  // chatRelays field at runtime, whatever the type says; unionRelays(undefined)
  // throws "list is not iterable", which would break chat startup on the first
  // load after an upgrade.
  it("tolerates a config cached before chat relays existed", () => {
    expect(chatRelaysOf({} as { chatRelays?: string[] })).toEqual([]);
    expect(chatRelaysOf({ chatRelays: ["wss://chat.a"] })).toEqual(["wss://chat.a"]);
  });
});
