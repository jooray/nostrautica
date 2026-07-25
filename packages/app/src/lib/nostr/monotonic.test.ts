/**
 * Centralised monotonic publisher (audit P3): every replaceable/addressable
 * publish must use created_at = max(now, max(relayWinner, watermark) + 1) so it
 * always wins the §3.1 tie-break, including the equal-second / losing-id case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VerifiedEvent } from "nostr-tools/pure";

const { fetchEventsRelayOnly, publishOrQueue } = vi.hoisted(() => ({
  fetchEventsRelayOnly: vi.fn(),
  publishOrQueue: vi.fn(),
}));
vi.mock("./ndk.js", () => ({ fetchEventsRelayOnly }));
vi.mock("./publish-queue.js", () => ({ publishOrQueue }));

import { publishMonotonic, publishWatermark, eventAddress } from "./monotonic.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";

function memPersist(): PersistBackend {
  const store = new Map<string, CacheEntry>();
  return {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      const cur = store.get(k);
      if (!cur || v.at >= cur.at) store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
  };
}

const OWNER = "o".repeat(64);
const AUTHOR = "e".repeat(64);
const NOW = 1_700_000_000;

/** A signed event stub carrying just the fields the publisher/tests care about. */
function signed(created_at: number): VerifiedEvent {
  return { id: "x", kind: 31600, pubkey: AUTHOR, created_at, tags: [], content: "", sig: "s" } as unknown as VerifiedEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  __resetPersistForTests();
  __setPersistBackend(memPersist());
  setActiveCacheOwner(OWNER);
  fetchEventsRelayOnly.mockReset().mockResolvedValue([]);
  publishOrQueue.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  __setPersistBackend(null);
});

describe("publishMonotonic", () => {
  it("uses now when there is no prior event or watermark", async () => {
    let seen = 0;
    const { createdAt, published } = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => {
        seen = t;
        return signed(t);
      },
    });
    expect(createdAt).toBe(NOW);
    expect(seen).toBe(NOW);
    expect(published).toBe(true);
    expect(publishOrQueue).toHaveBeenCalledTimes(1);
  });

  it("steps above an equal-second relay winner so it never ties on the id (audit P3)", async () => {
    // Relay already has an event stamped exactly `now`. Publishing at `now` would
    // tie and could LOSE the id tie-break — the publisher must go to now + 1.
    fetchEventsRelayOnly.mockResolvedValue([{ id: "0".repeat(64), created_at: NOW }]);
    const { createdAt } = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(createdAt).toBe(NOW + 1);
  });

  it("steps above a FUTURE relay winner (prior event dated ahead of wall clock)", async () => {
    fetchEventsRelayOnly.mockResolvedValue([{ id: "a", created_at: NOW + 500 }]);
    const { createdAt } = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(createdAt).toBe(NOW + 501);
  });

  it("advances and persists the watermark even when the publish is only queued", async () => {
    publishOrQueue.mockResolvedValue(false); // offline → queued, not sent
    const addr = eventAddress(31600, AUTHOR, "d1");
    const first = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(first.published).toBe(false);
    expect(publishWatermark(addr, OWNER)).toBe(first.createdAt);

    // A second publish in the SAME wall-clock second, with the relay STILL empty
    // (the queued one hasn't propagated), must still step above the watermark.
    const second = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(second.createdAt).toBe(first.createdAt + 1);
  });

  it("takes the max of relay winner and local watermark as the floor", async () => {
    const addr = eventAddress(31600, AUTHOR, "d1");
    // Seed a high watermark via one publish, then have the relay report an OLDER
    // winner: the watermark must still dominate.
    await publishMonotonic({ kind: 31600, author: AUTHOR, identifier: "d1", sign: (t) => signed(t) });
    const wm = publishWatermark(addr, OWNER);
    fetchEventsRelayOnly.mockResolvedValue([{ id: "a", created_at: NOW - 100 }]);
    const { createdAt } = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(createdAt).toBe(wm + 1);
  });

  it("degrades to the local watermark when the relay read throws (offline)", async () => {
    fetchEventsRelayOnly.mockRejectedValue(new Error("no relays"));
    const { createdAt } = await publishMonotonic({
      kind: 31600,
      author: AUTHOR,
      identifier: "d1",
      sign: (t) => signed(t),
    });
    expect(createdAt).toBe(NOW); // no watermark yet, relay unknown → now
  });

  it("builds replaceable addresses without a d, addressable with one", () => {
    expect(eventAddress(10050, AUTHOR)).toBe(`10050:${AUTHOR}`);
    expect(eventAddress(31600, AUTHOR, "d1")).toBe(`31600:${AUTHOR}:d1`);
  });

  it("reserves DISTINCT timestamps for two concurrent same-address publishes (R6)", async () => {
    // Both start in the same wall-clock second with an empty relay + no watermark.
    // Without the per-address lock both would read floor 0 and sign `NOW`; the
    // random lower id would then win the §3.1 tie instead of the later operation.
    // The lock must serialize them onto NOW and NOW+1.
    let inSign = 0;
    let maxConcurrentSigns = 0;
    const signAt: number[] = [];
    const sign = async (t: number) => {
      // Prove the critical sections don't overlap: only one sign runs at a time.
      inSign++;
      maxConcurrentSigns = Math.max(maxConcurrentSigns, inSign);
      await Promise.resolve();
      signAt.push(t);
      inSign--;
      return signed(t);
    };
    const call = () =>
      publishMonotonic({ kind: 31600, author: AUTHOR, identifier: "d1", sign });

    const [a, b] = await Promise.all([call(), call()]);
    expect(maxConcurrentSigns).toBe(1); // never two critical sections at once
    expect(new Set([a.createdAt, b.createdAt]).size).toBe(2); // distinct reservations
    expect([a.createdAt, b.createdAt].sort()).toEqual([NOW, NOW + 1]);
    expect(signAt.sort()).toEqual([NOW, NOW + 1]);
  });

  it("serializes two independent contexts on the shared persisted watermark (R6)", async () => {
    // Simulate two tabs: each does its own read/sign/bump. Interleaved by the
    // in-process lock (no navigator.locks in the test env), they must not collide.
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        publishMonotonic({ kind: 10002, author: AUTHOR, sign: (t) => signed(t) }),
      ),
    );
    const stamps = outcomes.map((o) => o.createdAt).sort((x, y) => x - y);
    expect(stamps).toEqual([NOW, NOW + 1, NOW + 2, NOW + 3]); // strictly monotonic
  });
});
