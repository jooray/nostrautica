/**
 * NIP-17 DM relay list (kind-10050) onboarding, audit finding "kind-10050 DM
 * relay list". App-generated keys must publish a 10050 alongside the 10002 so
 * gift-wrapped DMs reach the user in other clients — but only when the user has
 * none yet (same never-override policy as the 10002 relay list).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_DM_RELAY_LIST } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishOrQueue } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));

import { dmRelayListTags, ensureDmRelayList } from "./nostr-actions.js";
import { DM_RELAY_LIST } from "$lib/nostr/relays.js";

/** A stand-in signer that records what it was asked to sign. */
function fakeSigner() {
  const signed: { kind: number; tags: string[][]; content: string }[] = [];
  return {
    signer: {
      method: "local" as const,
      getPublicKey: async () => "a".repeat(64),
      signEvent: async (tpl: { kind: number; tags: string[][]; content: string }) => {
        signed.push(tpl);
        return { ...tpl, id: "x", pubkey: "a".repeat(64), sig: "s" } as unknown as VerifiedEvent;
      },
      nip44Encrypt: async () => "",
      nip44Decrypt: async () => "",
    },
    signed,
  };
}

describe("dmRelayListTags (pure)", () => {
  it("emits NIP-17 [\"relay\", url] tags in order", () => {
    expect(dmRelayListTags(["wss://a", "wss://b"])).toEqual([
      ["relay", "wss://a"],
      ["relay", "wss://b"],
    ]);
  });
  it("handles an empty set", () => {
    expect(dmRelayListTags([])).toEqual([]);
  });
});

describe("ensureDmRelayList (never-override policy)", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
  });

  it("publishes a kind-10050 with default DM relays when the user has none", async () => {
    fetchEvents.mockResolvedValue([]);
    const { signer, signed } = fakeSigner();
    const published = await ensureDmRelayList(signer);
    expect(published).toBe(true);
    expect(publishOrQueue).toHaveBeenCalledTimes(1);
    expect(signed).toHaveLength(1);
    expect(signed[0].kind).toBe(KIND_DM_RELAY_LIST);
    expect(signed[0].tags).toEqual(DM_RELAY_LIST.map((u) => ["relay", u]));
    expect(signed[0].tags.length).toBeGreaterThan(0);
  });

  it("never overrides an existing 10050", async () => {
    fetchEvents.mockResolvedValue([{ kind: KIND_DM_RELAY_LIST, created_at: 1, tags: [], content: "" }]);
    const { signer, signed } = fakeSigner();
    const published = await ensureDmRelayList(signer);
    expect(published).toBe(false);
    expect(publishOrQueue).not.toHaveBeenCalled();
    expect(signed).toHaveLength(0);
  });
});
