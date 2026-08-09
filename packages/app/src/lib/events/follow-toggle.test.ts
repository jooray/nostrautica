/**
 * follow / unfollow round trip on the user's kind-3 (spec §5.4 item 3).
 *
 * The pair has to stay symmetric: both fetch the live list first, both refuse to
 * publish when nothing came back, and both carry the legacy relay-metadata
 * content through. The interesting case is the one that made unfollow possible
 * at all — a real kind-3 that has ended up with zero follows must still be
 * appendable, or unfollowing your last follow locks you out of following again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { KIND_CONTACTS } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEvents, publishOrQueue } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishOrQueue: vi.fn(),
}));

vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/publish-queue.js", () => ({ publishOrQueue }));

import { followUser, unfollowUser } from "./nostr-actions.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function fakeSigner() {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const signed: { kind: number; tags: string[][]; content: string }[] = [];
  return {
    sk,
    pubkey,
    signer: {
      method: "local" as const,
      getPublicKey: async () => pubkey,
      signEvent: async (tpl: { kind: number; tags: string[][]; content: string }) => {
        signed.push(tpl);
        return { ...tpl, id: "x", pubkey, sig: "s" } as unknown as VerifiedEvent;
      },
      nip44Encrypt: async () => "",
      nip44Decrypt: async () => "",
    },
    signed,
  };
}

/** The kind-3 the relays will answer with, signed by the caller's own key. */
function contacts(sk: Uint8Array, pubkeys: string[], content = "") {
  return finalizeEvent(
    {
      kind: KIND_CONTACTS,
      created_at: 1,
      tags: pubkeys.map((p) => ["p", p]),
      content,
    },
    sk,
  );
}

/** The `p` tags of the nth signed event. */
function published(signed: { tags: string[][] }[], n = 0): string[] {
  return signed[n]!.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]!);
}

describe("unfollowUser", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
    publishOrQueue.mockResolvedValue(true); // publishOrQueue resolves a bare boolean
  });

  it("drops only the target's p tag and keeps everything else", async () => {
    const { signer, sk, signed } = fakeSigner();
    fetchEvents.mockResolvedValue([contacts(sk, [A, B], '{"wss://relay":{}}')]);

    await expect(unfollowUser(signer, A)).resolves.toBe(true);

    expect(published(signed)).toEqual([B]);
    // Legacy relay-metadata content survives the republish (audit UX-16).
    expect(signed[0]!.content).toBe('{"wss://relay":{}}');
  });

  it("publishes nothing when the target was never followed", async () => {
    const { signer, sk } = fakeSigner();
    fetchEvents.mockResolvedValue([contacts(sk, [B])]);

    // Reports success — the state the caller asked for already holds.
    await expect(unfollowUser(signer, A)).resolves.toBe(true);
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("refuses when no kind-3 came back at all (a failed fetch would wipe the list)", async () => {
    const { signer } = fakeSigner();
    fetchEvents.mockResolvedValue([]);

    await expect(unfollowUser(signer, A)).rejects.toThrow();
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("reports a queued publish rather than claiming it went out", async () => {
    const { signer, sk } = fakeSigner();
    fetchEvents.mockResolvedValue([contacts(sk, [A, B])]);
    publishOrQueue.mockResolvedValue(false);

    await expect(unfollowUser(signer, A)).resolves.toBe(false);
  });
});

describe("followUser empty-list guard", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
    publishOrQueue.mockResolvedValue(true); // publishOrQueue resolves a bare boolean
  });

  it("still refuses when no kind-3 came back at all", async () => {
    const { signer } = fakeSigner();
    fetchEvents.mockResolvedValue([]);

    await expect(followUser(signer, A)).rejects.toThrow();
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("appends to a real kind-3 that has no follows left", async () => {
    // Pre-2026-08-07 this threw: the guard tested "has no p tags" rather than
    // "no event came back", so unfollowing your last follow left you unable to
    // follow anyone ever again from this app.
    const { signer, sk, signed } = fakeSigner();
    fetchEvents.mockResolvedValue([contacts(sk, [])]);

    await expect(followUser(signer, A)).resolves.toBe(true);
    expect(published(signed)).toEqual([A]);
  });

  it("round-trips: follow, unfollow the last one, follow again", async () => {
    const { signer, sk, signed } = fakeSigner();

    fetchEvents.mockResolvedValue([contacts(sk, [B])]);
    await followUser(signer, A);
    expect(published(signed, 0)).toEqual([B, A]);

    fetchEvents.mockResolvedValue([contacts(sk, [A])]);
    await unfollowUser(signer, A);
    expect(published(signed, 1)).toEqual([]);

    fetchEvents.mockResolvedValue([contacts(sk, [])]);
    await followUser(signer, B);
    expect(published(signed, 2)).toEqual([B]);
  });
});
