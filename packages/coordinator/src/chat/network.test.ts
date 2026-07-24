import { describe, it, expect } from "vitest";
import { makeChatNetwork, type ChatNetworkTransport } from "./network.js";

const INBOX_RELAY_LIST_KIND = 10050;

type AnyEvent = { id: string; pubkey: string; kind: number; tags: string[][]; created_at?: number };

/** Minimal transport that returns a single seeded kind-10050 inbox list. */
function transportWith(events: AnyEvent[]): ChatNetworkTransport {
  return {
    async publish() {},
    async fetch() {
      return events as never[];
    },
    subscribe() {
      return () => {};
    },
  };
}

describe("makeChatNetwork.getUserInboxRelays (audit R20)", () => {
  const defaults = ["wss://default-a.example", "wss://default-b.example"];

  it("enforces the operator relay allowlist on untrusted kind-10050 inbox relays", async () => {
    const inbox: AnyEvent = {
      id: "inbox1",
      pubkey: "alice",
      kind: INBOX_RELAY_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [
        ["relay", "wss://allowed.example"],
        ["relay", "wss://not-allowed.example"], // off-allowlist → must be dropped
      ],
    };
    const net = makeChatNetwork({
      transport: transportWith([inbox]),
      defaultRelays: defaults,
      relayPolicy: { allowlist: ["allowed.example"] },
    });
    const relays = await net.getUserInboxRelays("alice");
    expect(relays).toEqual(["wss://allowed.example"]);
    expect(relays).not.toContain("wss://not-allowed.example");
  });

  it("falls back to defaults when every advertised relay is off the allowlist", async () => {
    const inbox: AnyEvent = {
      id: "inbox2",
      pubkey: "bob",
      kind: INBOX_RELAY_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [["relay", "wss://not-allowed.example"]],
    };
    const net = makeChatNetwork({
      transport: transportWith([inbox]),
      defaultRelays: defaults,
      relayPolicy: { allowlist: ["allowed.example"] },
    });
    expect(await net.getUserInboxRelays("bob")).toEqual(defaults);
  });

  it("with no allowlist keeps the historical wss-only behavior", async () => {
    const inbox: AnyEvent = {
      id: "inbox3",
      pubkey: "carol",
      kind: INBOX_RELAY_LIST_KIND,
      created_at: 1_700_000_000,
      tags: [
        ["relay", "wss://any-public.example"],
        ["relay", "ws://insecure.example"], // non-wss → dropped even without a policy
      ],
    };
    const net = makeChatNetwork({ transport: transportWith([inbox]), defaultRelays: defaults });
    expect(await net.getUserInboxRelays("carol")).toEqual(["wss://any-public.example"]);
  });
});
