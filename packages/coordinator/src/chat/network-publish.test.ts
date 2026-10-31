import { describe, it, expect } from "vitest";
import { makeChatNetwork, GROUP_EVENT_PUBLISH_TIMEOUT_MS, type ChatNetworkTransport } from "./network.js";

/**
 * makeChatNetwork().publish (audit K-7). marmot-ts keeps a commit's exact bytes
 * for a retry only when a response is `uncertain`; a definite failure rolls the
 * commit back. So the adapter must not call a relay's silence a refusal.
 */
type Ev = { id: string; pubkey: string; kind: number; tags: string[][] };
const EV445: Ev = { id: "1".repeat(64), pubkey: "p".repeat(64), kind: 445, tags: [["h", "g"]] };
const RELAYS = ["wss://a.example", "wss://b.example"];

function transport(publish: ChatNetworkTransport["publish"]): ChatNetworkTransport {
  return {
    publish,
    async fetch() {
      return [];
    },
    subscribe() {
      return () => {};
    },
  };
}

function failure(outcomes: { url: string; status: string; reason: string }[]): Error {
  return Object.assign(new Error("publish of kind 445 failed on all relays"), { outcomes });
}

describe("makeChatNetwork.publish (audit K-7)", () => {
  it("marks a timed-out or transport-failed relay uncertain, a refusing one definite", async () => {
    const net = makeChatNetwork({
      transport: transport(async () => {
        throw failure([
          { url: RELAYS[0]!, status: "timeout", reason: "publish timed out" },
          { url: RELAYS[1]!, status: "rejected", reason: "blocked: no" },
        ]);
      }),
      defaultRelays: RELAYS,
    });
    const res = await net.publish(RELAYS, EV445 as never);
    expect(res[RELAYS[0]!]).toEqual({ from: RELAYS[0], ok: false, message: "publish timed out", uncertain: true });
    expect(res[RELAYS[1]!]).toEqual({ from: RELAYS[1], ok: false, message: "blocked: no" });
  });

  it("an error with no per-relay outcomes is uncertain for every relay", async () => {
    const net = makeChatNetwork({
      transport: transport(async () => {
        throw new Error("socket hang up");
      }),
      defaultRelays: RELAYS,
    });
    const res = await net.publish(RELAYS, EV445 as never);
    expect(Object.values(res).every((r) => r.ok === false && r.uncertain === true)).toBe(true);
  });

  it("all relays refusing stays a definite failure, so marmot may roll back", async () => {
    const net = makeChatNetwork({
      transport: transport(async () => {
        throw failure(RELAYS.map((url) => ({ url, status: "rejected", reason: "invalid: bad sig" })));
      }),
      defaultRelays: RELAYS,
    });
    const res = await net.publish(RELAYS, EV445 as never);
    expect(Object.values(res).some((r) => r.uncertain)).toBe(false);
  });

  it("reports which relays acked, and gives kind 445 the long OK timeout", async () => {
    const calls: { kind: number; opts?: { timeoutMs?: number } }[] = [];
    const net = makeChatNetwork({
      transport: transport(async (event, _relays, opts) => {
        calls.push({ kind: event.kind, opts });
        return { acked: [RELAYS[1]!] };
      }),
      defaultRelays: RELAYS,
    });
    const res = await net.publish(RELAYS, EV445 as never);
    expect(res[RELAYS[1]!]!.ok).toBe(true);
    expect(res[RELAYS[0]!]!.ok).toBe(false);
    await net.publish(RELAYS, { ...EV445, kind: 1059 } as never);
    expect(calls).toEqual([
      { kind: 445, opts: { timeoutMs: GROUP_EVENT_PUBLISH_TIMEOUT_MS } },
      { kind: 1059, opts: undefined },
    ]);
    expect(GROUP_EVENT_PUBLISH_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("a transport that resolves without naming relays counts as acked everywhere", async () => {
    const net = makeChatNetwork({ transport: transport(async () => {}), defaultRelays: RELAYS });
    const res = await net.publish(RELAYS, EV445 as never);
    expect(Object.values(res).every((r) => r.ok)).toBe(true);
  });
});
