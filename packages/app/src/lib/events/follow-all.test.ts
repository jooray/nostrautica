/**
 * Follow-all payoff flow (spec §13). A single kind-3 append-merge over everyone
 * met / want-to-meet, honoring the empty-list guard and reporting partial failure
 * (a publish error → those targets reported failed, never silently "followed").
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

import { planFollowAll, followAll } from "./nostr-actions.js";
import type { Tag } from "./onboarding.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const EXISTING = "e".repeat(64);

function ptags(...pks: string[]): Tag[] {
  return pks.map((p) => ["p", p] as Tag);
}

function fakeSigner(opts: { signThrows?: boolean } = {}) {
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
        if (opts.signThrows) throw new Error("signer unreachable");
        signed.push(tpl);
        return { ...tpl, id: "x", pubkey, sig: "s" } as unknown as VerifiedEvent;
      },
      nip44Encrypt: async () => "",
      nip44Decrypt: async () => "",
    },
    signed,
  };
}

describe("planFollowAll (pure)", () => {
  it("splits targets into already-following and to-add", () => {
    const plan = planFollowAll(ptags(EXISTING, A), [A, B, C]);
    expect(plan.guardTripped).toBe(false);
    expect(plan.alreadyFollowing).toEqual([A]);
    expect(plan.toAdd).toEqual([B, C]);
    expect(plan.mergedTags?.filter((t) => t[0] === "p").map((t) => t[1])).toEqual(
      expect.arrayContaining([EXISTING, A, B, C]),
    );
  });

  it("trips the empty-list guard when adding onto a list with no follows", () => {
    const plan = planFollowAll([], [A]);
    expect(plan.guardTripped).toBe(true);
    expect(plan.mergedTags).toBeUndefined();
  });

  it("does not trip the guard when nothing needs adding", () => {
    const plan = planFollowAll(ptags(A), [A]);
    expect(plan.guardTripped).toBe(false);
    expect(plan.toAdd).toEqual([]);
    expect(plan.mergedTags).toBeUndefined();
  });

  it("dedupes repeated targets", () => {
    const plan = planFollowAll(ptags(EXISTING), [A, A, B]);
    expect(plan.toAdd).toEqual([A, B]);
  });
});

describe("followAll", () => {
  beforeEach(() => {
    fetchEvents.mockReset();
    publishOrQueue.mockReset();
  });

  it("publishes one merged kind-3 and reports followed + skipped", async () => {
    const { signer, sk, pubkey, signed } = fakeSigner();
    const existing = finalizeEvent(
      { kind: KIND_CONTACTS, created_at: 1, tags: [["p", EXISTING], ["p", A]], content: "{}" },
      sk,
    );
    void pubkey;
    fetchEvents.mockResolvedValue([existing]);
    const res = await followAll(signer, [A, B, C]);
    expect(res.followed).toEqual([B, C]);
    expect(res.alreadyFollowing).toEqual([A]);
    expect(res.failed).toEqual([]);
    expect(publishOrQueue).toHaveBeenCalledTimes(1);
    expect(signed[0].content).toBe("{}"); // legacy relay-metadata carried through
  });

  it("refuses to publish onto an empty follow list (guard)", async () => {
    const { signer } = fakeSigner();
    fetchEvents.mockResolvedValue([]);
    await expect(followAll(signer, [A])).rejects.toThrow();
    expect(publishOrQueue).not.toHaveBeenCalled();
  });

  it("reports targets as failed when the publish throws (no false success)", async () => {
    const { signer, sk } = fakeSigner({ signThrows: true });
    const existing = finalizeEvent(
      { kind: KIND_CONTACTS, created_at: 1, tags: [["p", EXISTING]], content: "" },
      sk,
    );
    fetchEvents.mockResolvedValue([existing]);
    const res = await followAll(signer, [A, B]);
    expect(res.followed).toEqual([]);
    expect(res.failed).toEqual([A, B]);
  });
});
