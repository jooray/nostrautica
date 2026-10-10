import { describe, it, expect } from "vitest";
import { makeChatNetwork, type ChatNetworkTransport } from "./network.js";

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; created_at?: number };

describe("makeChatNetwork.getUserInboxRelays — external Marmot clients (NIP §10.5)", () => {
  const defaults = ["wss://default-a.example"];
  const W = "f".repeat(64);

  /** Answers per (kind, relay set): an external client's lists live on ITS relays. */
  function routedTransport(byRelay: Record<string, AnyEvent[]>) {
    const calls: { kinds: number[]; relays: string[] }[] = [];
    const transport: ChatNetworkTransport = {
      async publish() {},
      async fetch(filter, relays = []) {
        const kinds = (filter as { kinds: number[] }).kinds;
        calls.push({ kinds, relays });
        return relays.flatMap((r) => (byRelay[r] ?? []).filter((e) => kinds.includes(e.kind))) as never[];
      },
      subscribe() {
        return () => {};
      },
    };
    return { transport, calls };
  }

  it("looks for the 10050 on the chat interop relays too, not just the defaults", async () => {
    const { transport, calls } = routedTransport({
      "wss://relay.eu.whitenoise.chat": [
        { id: "i", pubkey: W, kind: 10050, created_at: 1, tags: [["relay", "wss://wn-inbox.example"]] },
      ],
    });
    const net = makeChatNetwork({ transport, defaultRelays: defaults });
    expect(await net.getUserInboxRelays(W)).toEqual(["wss://wn-inbox.example"]);
    expect(calls[0]!.relays).toEqual(expect.arrayContaining([...defaults, "wss://relay.eu.whitenoise.chat"]));
  });

  it("falls back to the key's own NIP-65 outbox relays when no 10050 is on the bootstrap set", async () => {
    const { transport } = routedTransport({
      "wss://default-a.example": [
        { id: "r", pubkey: W, kind: 10002, created_at: 1, tags: [["r", "wss://own-outbox.example"]] },
      ],
      "wss://own-outbox.example": [
        { id: "i", pubkey: W, kind: 10050, created_at: 2, tags: [["relay", "wss://own-inbox.example"]] },
      ],
    });
    const net = makeChatNetwork({ transport, defaultRelays: defaults });
    expect(await net.getUserInboxRelays(W)).toEqual(["wss://own-inbox.example"]);
  });

  it("applies the operator allowlist to the outbox relays it consults", async () => {
    const { transport, calls } = routedTransport({
      "wss://default-a.example": [
        { id: "r", pubkey: W, kind: 10002, created_at: 1, tags: [["r", "wss://off-list.example"]] },
      ],
    });
    const net = makeChatNetwork({
      transport,
      defaultRelays: defaults,
      relayPolicy: { allowlist: ["default-a.example"] },
    });
    expect(await net.getUserInboxRelays(W)).toEqual(defaults);
    expect(calls.some((c) => c.relays.includes("wss://off-list.example"))).toBe(false);
  });

  it("ignores lists authored by someone else and falls back to the defaults", async () => {
    const { transport } = routedTransport({
      "wss://default-a.example": [
        { id: "x", pubkey: "e".repeat(64), kind: 10050, created_at: 1, tags: [["relay", "wss://evil.example"]] },
      ],
    });
    const net = makeChatNetwork({ transport, defaultRelays: defaults });
    expect(await net.getUserInboxRelays(W)).toEqual(defaults);
  });
});
