/**
 * Cross-device DM read state (kind-30078, `d = nostrautica:dmread`).
 *
 * The invariant under test is that a publish is a read-merge-write, never a blind
 * overwrite. 30078 is replaceable, so a device that publishes its own watermark
 * map without folding in the current event silently un-reads every thread the
 * OTHER device had read — the exact regression that makes cross-device read state
 * worse than no sync at all. These tests fail against a naive implementation that
 * publishes `dmUnread.readWatermarks` directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { KIND_APP_DATA, MAX_DM_READ_THREADS } from "@nostrautica/protocol";
import type { VerifiedEvent } from "nostr-tools/pure";
import type { AppSigner } from "$lib/signer/types.js";
import { __resetPersistForTests, __setPersistBackend } from "$lib/cache/persist.js";

const { fetchEvents, publishMonotonic } = vi.hoisted(() => ({
  fetchEvents: vi.fn(),
  publishMonotonic: vi.fn(),
}));
vi.mock("$lib/nostr/ndk.js", () => ({ fetchEvents }));
vi.mock("$lib/nostr/monotonic.js", () => ({ publishMonotonic }));

import { dmUnread } from "$lib/stores/dm-unread.svelte.js";
import {
  DM_READ_STATE_D,
  prunedForPublish,
  syncDmReadState,
  resetDmReadStateSync,
  flushDmReadState,
} from "./dm-read-state.js";

const OWNER = "a".repeat(64);
const PEER = "c".repeat(64);
const PEER_2 = "d".repeat(64);
const ID_1 = "1".repeat(64);
const ID_2 = "2".repeat(64);
const ID_3 = "3".repeat(64);

/**
 * A signer whose "NIP-44" is identity-with-a-tag: the round-trip is what matters
 * here, and real crypto would only slow the test down without exercising anything
 * this module owns.
 */
function fakeSigner(): AppSigner & { signed: VerifiedEvent[] } {
  const signed: VerifiedEvent[] = [];
  return {
    method: "local",
    signed,
    getPublicKey: async () => OWNER,
    nip44Encrypt: async (_to: string, plaintext: string) => `enc:${plaintext}`,
    nip44Decrypt: async (_from: string, ciphertext: string) => {
      if (!ciphertext.startsWith("enc:")) throw new Error("undecryptable");
      return ciphertext.slice(4);
    },
    signEvent: async (template) => {
      const event = { ...template, id: "e".repeat(64), pubkey: OWNER, sig: "s" } as VerifiedEvent;
      signed.push(event);
      return event;
    },
  };
}

/** Content of every event actually signed, in order (`enc:<json>`). */
let signedContents: string[] = [];

/** The threads map of the most recent publish, as it went over the wire. */
function lastPublishedThreads(): Record<string, { at: number; id: string }> {
  const content = signedContents[signedContents.length - 1];
  expect(content).toBeDefined();
  return JSON.parse(content.slice(4)).threads;
}

/** A stored 30078 as the relay would return it. */
function remoteEvent(threads: Record<string, { at: number; id: string }>, created_at = 1000) {
  return {
    id: "f".repeat(64),
    created_at,
    content: `enc:${JSON.stringify({ v: 2, threads })}`,
  };
}

beforeEach(() => {
  __setPersistBackend({ getAll: async () => [], put: async () => {}, delete: async () => {} });
  __resetPersistForTests();
  resetDmReadStateSync();
  dmUnread.init(null);
  signedContents = [];
  fetchEvents.mockReset();
  publishMonotonic.mockReset();
  // Invoke the caller's `sign` so the published content is really exercised.
  publishMonotonic.mockImplementation(
    async (input: { sign: (at: number) => Promise<VerifiedEvent> }) => {
      const event = await input.sign(1234);
      signedContents.push((event as unknown as { content: string }).content);
      return { published: true, createdAt: 1234 };
    },
  );
});

describe("DM read state sync", () => {
  it("publishes the union of local and remote, never overwriting the other device", async () => {
    dmUnread.init(OWNER);
    dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
    dmUnread.markThreadRead(PEER); // this device read PEER up to at=9

    // The relay holds the OTHER device's state: it never saw PEER's newest
    // message, but it did read a whole thread this device knows nothing about.
    fetchEvents.mockResolvedValue([
      remoteEvent({ [PEER]: { at: 2, id: ID_2 }, [PEER_2]: { at: 7, id: ID_3 } }),
    ]);

    await syncDmReadState(fakeSigner());

    expect(fetchEvents).toHaveBeenCalledWith({
      kinds: [KIND_APP_DATA],
      authors: [OWNER],
      "#d": [DM_READ_STATE_D],
    });
    const published = lastPublishedThreads();
    expect(published[PEER]).toEqual({ at: 9, id: ID_1 }); // ours won (newer)
    expect(published[PEER_2]).toEqual({ at: 7, id: ID_3 }); // theirs survived
    // …and the local store adopted the other device's thread, so the badge here
    // now agrees with the badge there.
    expect(dmUnread.readWatermarks[PEER_2]).toEqual({ at: 7, id: ID_3 });
  });

  it("does not publish when the relay copy already matches (steady state)", async () => {
    dmUnread.init(OWNER);
    dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
    dmUnread.markThreadRead(PEER);
    fetchEvents.mockResolvedValue([remoteEvent({ [PEER]: { at: 9, id: ID_1 } })]);

    await syncDmReadState(fakeSigner());

    // One fetch, no signature: the common poll must not cost a signer prompt.
    expect(publishMonotonic).not.toHaveBeenCalled();
  });

  it("publishes nothing at all when no thread has ever been read", async () => {
    dmUnread.init(OWNER);
    fetchEvents.mockResolvedValue([]);
    await syncDmReadState(fakeSigner());
    expect(publishMonotonic).not.toHaveBeenCalled();
  });

  it("self-heals an unreadable remote payload instead of stalling on it", async () => {
    dmUnread.init(OWNER);
    dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
    dmUnread.markThreadRead(PEER);
    // Corrupt/undecryptable content, or one written by a schema we can't read.
    fetchEvents.mockResolvedValue([{ id: "f".repeat(64), created_at: 1000, content: "garbage" }]);

    await syncDmReadState(fakeSigner());

    // Local state is preserved (not clobbered by the unreadable copy) AND
    // republished, so the stored event becomes readable again.
    expect(dmUnread.readWatermarks[PEER]).toEqual({ at: 9, id: ID_1 });
    expect(lastPublishedThreads()[PEER]).toEqual({ at: 9, id: ID_1 });
  });

  it("throttles poll-driven reconciles but lets `force` through", async () => {
    dmUnread.init(OWNER);
    fetchEvents.mockResolvedValue([]);
    const signer = fakeSigner();

    await syncDmReadState(signer);
    await syncDmReadState(signer); // within the throttle window
    expect(fetchEvents).toHaveBeenCalledTimes(1);

    await syncDmReadState(signer, true);
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("flushes a debounced publish when the user leaves the screen", async () => {
    vi.useFakeTimers();
    try {
      dmUnread.init(OWNER);
      fetchEvents.mockResolvedValue([]);
      const signer = fakeSigner();
      await syncDmReadState(signer); // registers the local-advance listener

      dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
      dmUnread.markThreadRead(PEER); // schedules a debounced publish
      expect(publishMonotonic).not.toHaveBeenCalled();

      // Navigating away before the debounce fires must not lose the read.
      flushDmReadState();
      await vi.runAllTimersAsync();
      expect(lastPublishedThreads()[PEER]).toEqual({ at: 9, id: ID_1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an account switch drops the previous identity's pending publish and throttle", async () => {
    vi.useFakeTimers();
    try {
      dmUnread.init(OWNER);
      fetchEvents.mockResolvedValue([]);
      await syncDmReadState(fakeSigner());

      // Owner A reads something; the publish is still sitting in the debounce…
      dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
      dmUnread.markThreadRead(PEER);

      // …when the user switches accounts. The queued publish belongs to A, whose
      // watermarks the store no longer holds — firing it would write A's read
      // state from B's session.
      const other = "b".repeat(64);
      const signerB = { ...fakeSigner(), getPublicKey: async () => other };
      dmUnread.init(other);
      await syncDmReadState(signerB);
      await vi.runAllTimersAsync();

      // B's pull ran immediately (A's throttle window did not apply to it) and
      // nothing was published, because B has read nothing and A's debounce died.
      expect(fetchEvents).toHaveBeenCalledTimes(2);
      expect(publishMonotonic).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetDmReadStateSync detaches the listener so a logout can't publish", async () => {
    vi.useFakeTimers();
    try {
      dmUnread.init(OWNER);
      fetchEvents.mockResolvedValue([]);
      await syncDmReadState(fakeSigner());
      resetDmReadStateSync();

      dmUnread.init(OWNER);
      dmUnread.syncMessages(OWNER, [{ id: ID_1, at: 9, from: PEER, peer: PEER, text: "hi" }]);
      dmUnread.markThreadRead(PEER);
      await vi.runAllTimersAsync();
      expect(publishMonotonic).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("prunedForPublish", () => {
  it("keeps the most recently read threads when over the cap", () => {
    const many: Record<string, { at: number; id: string }> = {};
    for (let i = 0; i < MAX_DM_READ_THREADS + 10; i++) {
      many[i.toString(16).padStart(64, "0")] = { at: i, id: ID_1 };
    }
    const pruned = prunedForPublish(many);
    expect(Object.keys(pruned)).toHaveLength(MAX_DM_READ_THREADS);
    // The 10 oldest-read threads are the ones dropped, not an arbitrary slice.
    expect(pruned["0".repeat(64)]).toBeUndefined();
    expect(pruned[(MAX_DM_READ_THREADS + 9).toString(16).padStart(64, "0")]).toBeDefined();
  });

  it("drops entries the schema would reject, so one bad row can't break every device", () => {
    const pruned = prunedForPublish({
      [PEER]: { at: 5, id: ID_1 },
      "not-a-pubkey": { at: 5, id: ID_1 },
      [PEER_2]: { at: 5, id: "local-123" },
    });
    expect(pruned).toEqual({ [PEER]: { at: 5, id: ID_1 } });
  });
});
