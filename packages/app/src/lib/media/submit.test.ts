import { describe, it, expect } from "vitest";
import { resolveBlossomServers } from "./submit.js";
import { DEFAULT_BLOSSOM_SERVERS } from "$lib/nostr/relays.js";
import type { EventContext } from "$lib/events/event-context.js";

function ctxWith(blossom: string[]): EventContext {
  return { config: { blossom } } as unknown as EventContext;
}

describe("resolveBlossomServers (encrypted media)", () => {
  it("unions event-configured servers with app defaults, event servers first", () => {
    const servers = resolveBlossomServers(ctxWith(["https://event-configured.example"]));
    expect(servers).toEqual(["https://event-configured.example", ...DEFAULT_BLOSSOM_SERVERS]);
  });

  it("falls back to app defaults alone when the event configures none", () => {
    expect(resolveBlossomServers(ctxWith([]))).toEqual(DEFAULT_BLOSSOM_SERVERS);
  });

  it("never pulls in a user-pinned (kind 10063) server — many reject ciphertext", () => {
    // A user's personal Blossom list (e.g. blossom.primal.net) is deliberately
    // out of scope here: this function only sees the event context, so there's
    // no code path by which a user-pinned server could leak into the result.
    const servers = resolveBlossomServers(ctxWith(["https://event-configured.example"]));
    expect(servers).not.toContain("https://blossom.primal.net");
  });

  it("drops non-https event-configured servers (audit APPR-8)", () => {
    const servers = resolveBlossomServers(
      ctxWith(["http://insecure.example", "not a url", "https://event-configured.example"]),
    );
    expect(servers).toEqual(["https://event-configured.example", ...DEFAULT_BLOSSOM_SERVERS]);
  });
});
