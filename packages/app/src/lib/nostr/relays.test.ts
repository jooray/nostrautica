/**
 * Relay-set policy helpers. `signerRelays` is the fix for a NIP-46 outage mode we
 * actually hit: `wss://relay.nsec.app` (the relay nsec.app names in its own
 * `bunker://` URIs) went down — HTTP 502 on the WebSocket upgrade, 3/3 probes —
 * and because the bunker paths used ONLY the pointer's relays, such a link could
 * neither connect nor be restored.
 */
import { describe, it, expect } from "vitest";
import { NIP46_RELAYS, signerRelays, unionRelays } from "./relays.js";

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
});
