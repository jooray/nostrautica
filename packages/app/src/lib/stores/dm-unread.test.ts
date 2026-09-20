import { beforeEach, describe, expect, it } from "vitest";
import type { DmMessage } from "$lib/events/dm.js";
import {
  __resetPersistForTests,
  __setPersistBackend,
  cacheGet,
  hydrateAppCache,
  type CacheEntry,
} from "$lib/cache/persist.js";
import {
  DmUnreadStore,
  compareDmPosition,
  incomingUnreadCount,
  mergeWatermarks,
  sameWatermarks,
} from "./dm-unread.svelte.js";

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const PEER = "c".repeat(64);
const PEER_2 = "d".repeat(64);
/** Scope/key separator in persist.ts\u2019s composite IndexedDB key. */
const SEP = "\x1f";

function message(id: string, at: number, from = PEER): DmMessage {
  return { id, at, from, peer: PEER, text: id };
}

beforeEach(async () => {
  __setPersistBackend({
    getAll: async () => [],
    put: async () => {},
    delete: async () => {},
  });
  __resetPersistForTests();
  // The store refuses to report an unread count until the persisted watermark
  // map has actually been read back (see `DmUnreadStore.loaded`) — an empty
  // mirror is "not loaded yet", not "nothing read". Boot does that read; here,
  // do it explicitly, or every count below is a legitimate 0.
  await hydrateAppCache();
});

describe("DM unread positions", () => {
  it("orders equal timestamps by stable message id", () => {
    expect(compareDmPosition({ at: 10, id: "b" }, { at: 10, id: "a" })).toBeGreaterThan(0);
    expect(incomingUnreadCount([message("a", 10), message("b", 10)], OWNER_A, PEER, { at: 10, id: "a" })).toBe(1);
  });

  it("counts only incoming decrypted messages", () => {
    expect(incomingUnreadCount([message("in", 1), message("out", 2, OWNER_A)], OWNER_A)).toBe(1);
  });

  it("mergeWatermarks takes the per-peer maximum and is commutative", () => {
    const a = { [PEER]: { at: 9, id: "x" }, [PEER_2]: { at: 1, id: "y" } };
    const b = { [PEER]: { at: 2, id: "z" }, ["e".repeat(64)]: { at: 4, id: "w" } };
    const expected = {
      [PEER]: { at: 9, id: "x" },
      [PEER_2]: { at: 1, id: "y" },
      ["e".repeat(64)]: { at: 4, id: "w" },
    };
    expect(mergeWatermarks(a, b)).toEqual(expected);
    // Order-independence is what lets two devices publish blind and still agree.
    expect(mergeWatermarks(b, a)).toEqual(expected);
    // Same timestamp, different id: the §3.1-style id tie-break decides.
    expect(mergeWatermarks({ [PEER]: { at: 5, id: "a" } }, { [PEER]: { at: 5, id: "b" } })).toEqual({
      [PEER]: { at: 5, id: "b" },
    });
  });

  it("sameWatermarks distinguishes maps that differ in peers or position", () => {
    const a = { [PEER]: { at: 1, id: "x" } };
    expect(sameWatermarks(a, { [PEER]: { at: 1, id: "x" } })).toBe(true);
    expect(sameWatermarks(a, { [PEER]: { at: 2, id: "x" } })).toBe(false);
    expect(sameWatermarks(a, { [PEER_2]: { at: 1, id: "x" } })).toBe(false);
    expect(sameWatermarks(a, { ...a, [PEER_2]: { at: 1, id: "x" } })).toBe(false);
  });
});

describe("DmUnreadStore", () => {
  it("persists reads and encrypted activity through the IndexedDB clone boundary and a cold boot", async () => {
    const disk = new Map<string, CacheEntry>();
    const failures: unknown[] = [];
    __resetPersistForTests();
    __setPersistBackend({
      getAll: async () => structuredClone([...disk.entries()]),
      put: async (key, entry) => {
        try {
          disk.set(key, structuredClone(entry));
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
      delete: async () => {},
    });
    await hydrateAppCache();
    const first = new DmUnreadStore();
    first.init(OWNER_A);
    first.syncMessages(OWNER_A, [message("one", 1)]);
    first.markThreadRead(PEER);
    first.observeEncryptedWrapIds(OWNER_A, ["wrap-1"]);
    first.observeEncryptedWrapIds(OWNER_A, ["wrap-1", "wrap-2"]);
    first.acknowledgeEncryptedActivity();
    await Promise.resolve();
    expect(failures).toEqual([]);

    // Discard the mirror as a real reload does. Reading the same in-memory map
    // with a second store never tested whether IndexedDB accepted the write.
    __resetPersistForTests();
    await hydrateAppCache();
    const restored = new DmUnreadStore();
    restored.init(OWNER_A);
    restored.syncMessages(OWNER_A, [message("one", 1), message("two", 2)]);
    expect(restored.threadCount(PEER)).toBe(1);
    restored.observeEncryptedWrapIds(OWNER_A, ["wrap-1", "wrap-2"]);
    expect(restored.hasEncryptedActivity).toBe(false);
    restored.observeEncryptedWrapIds(OWNER_A, ["wrap-1", "wrap-2", "wrap-3"]);
    expect(restored.hasEncryptedActivity).toBe(true);
  });

  it("persists thread watermarks under the owner and isolates accounts", () => {
    const first = new DmUnreadStore();
    first.init(OWNER_A);
    first.syncMessages(OWNER_A, [message("one", 1)]);
    expect(first.threadCount(PEER)).toBe(1);
    first.markThreadRead(PEER);
    expect(first.threadCount(PEER)).toBe(0);

    const restored = new DmUnreadStore();
    restored.init(OWNER_A);
    restored.syncMessages(OWNER_A, [message("one", 1)]);
    expect(restored.threadCount(PEER)).toBe(0);
    restored.init(OWNER_B);
    restored.syncMessages(OWNER_B, [message("one", 1)]);
    expect(restored.threadCount(PEER)).toBe(1);
  });

  it("markAllRead clears every thread, the ciphertext badge, and persists once", () => {
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [
      message("p1-a", 1),
      message("p1-b", 2),
      { id: "p2-a", at: 3, from: PEER_2, peer: PEER_2, text: "p2-a" },
      // Deliberately OLDER than p2-a: an outgoing message must not be counted as
      // unread, which is what this line is here to prove. A NEWER one would also
      // mark p2-a read (see "a reply of your own…" above) and this case would
      // stop testing what it is named for.
      { id: "mine", at: 2, from: OWNER_A, peer: PEER_2, text: "mine" },
    ]);
    store.observeEncryptedWrapIds(OWNER_A, ["wrap-1"]);
    store.observeEncryptedWrapIds(OWNER_A, ["wrap-1", "wrap-2"]);
    expect(store.confirmedCount).toBe(3);
    expect(store.hasEncryptedActivity).toBe(true);

    store.markAllRead();
    expect(store.confirmedCount).toBe(0);
    expect(store.threadCount(PEER)).toBe(0);
    expect(store.threadCount(PEER_2)).toBe(0);
    expect(store.hasEncryptedActivity).toBe(false);

    // Durable, not just in-memory: a fresh store for the same owner stays read.
    const restored = new DmUnreadStore();
    restored.init(OWNER_A);
    restored.syncMessages(OWNER_A, [message("p1-a", 1), message("p1-b", 2)]);
    expect(restored.confirmedCount).toBe(0);
  });

  it("counts nothing until the persisted watermark map has been read back", async () => {
    // The reload bug (user report 2026-09-18). Boot doesn't wait for IndexedDB,
    // so the store is initialised against a cold mirror while messages arrive
    // from relays on their own schedule. Reading "no watermarks" out of a mirror
    // that simply hasn't loaded yet made every already-read message unread, and
    // the badge sat on 9 until hydration caught up seconds later.
    const seeded = new DmUnreadStore();
    seeded.init(OWNER_A);
    seeded.syncMessages(OWNER_A, [message("one", 1)]);
    seeded.markThreadRead(PEER);
    const stored = cacheGet("dm-read-watermarks", OWNER_A)!;

    // A fresh boot: an empty mirror, with that entry still on "disk".
    __resetPersistForTests();
    __setPersistBackend({
      getAll: async () => [[`${OWNER_A}${SEP}dm-read-watermarks`, stored]],
      put: async () => {},
      delete: async () => {},
    });

    const cold = new DmUnreadStore();
    cold.init(OWNER_A);
    // "one" was read on the last visit; "two" arrived since.
    cold.syncMessages(OWNER_A, [message("one", 1), message("two", 2)]);
    expect(cold.confirmedCount).toBe(0);
    expect(cold.threadCount(PEER)).toBe(0);
    expect(cold.ready).toBe(false);

    await hydrateAppCache();
    await Promise.resolve();
    expect(cold.ready).toBe(true);
    // Exactly the one that really is new — not both, which is what the cold read
    // reported, and not zero, which gating alone would have reported forever.
    expect(cold.confirmedCount).toBe(1);
  });

  it("a read taken before hydration survives the disk copy landing", async () => {
    __resetPersistForTests();
    let released: (() => void) | null = null;
    __setPersistBackend({
      getAll: () =>
        new Promise((resolve) => {
          released = () => resolve([]);
        }),
      put: async () => {},
      delete: async () => {},
    });

    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [message("one", 1)]);
    // The user opens the thread while IndexedDB is still being read.
    store.markThreadRead(PEER);
    released!();
    await hydrateAppCache();
    await Promise.resolve();
    expect(store.ready).toBe(true);
    // `init`'s post-hydration read MERGES; assigning the (empty) disk map here
    // would put the thread back to unread.
    expect(store.threadCount(PEER)).toBe(0);
  });

  it("a reply of your own marks everything before it read, whatever sent it", async () => {
    // The reported case, from the reporter's own IndexedDB (2026-09-18): a badge
    // of 9 over four threads, one of which had never been marked at all, and
    // every one of which had the user's own reply as its newest message. Their
    // stored read state had not moved in two weeks, because this app only ever
    // recorded a read when a thread was opened INSIDE it — and they read and
    // reply on a phone.
    //
    // The evidence was already on the device: a NIP-17 send self-wraps, so the
    // reply is in the same memo regardless of which client sent it.
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [
      message("in-1", 10),
      message("in-2", 20),
      message("in-3", 30),
      { id: "my-reply", at: 40, from: OWNER_A, peer: PEER, text: "reply" },
    ]);
    expect(store.threadCount(PEER)).toBe(0);
    expect(store.confirmedCount).toBe(0);

    // Nothing is swallowed: a message that arrives AFTER the reply is still new.
    store.syncMessages(OWNER_A, [
      message("in-1", 10),
      { id: "my-reply", at: 40, from: OWNER_A, peer: PEER, text: "reply" },
      message("in-later", 50),
    ]);
    expect(store.threadCount(PEER)).toBe(1);

    // And it is derived, not recorded — nothing was written to say so, so a
    // device that has never seen the reply is not told anything false.
    expect(cacheGet("dm-read-watermarks", OWNER_A)).toBeUndefined();
  });

  it("does not let one thread's reply silence another thread", async () => {
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [
      { id: "p1-in", at: 10, from: PEER, peer: PEER, text: "hi" },
      { id: "p1-mine", at: 20, from: OWNER_A, peer: PEER, text: "reply" },
      { id: "p2-in", at: 15, from: PEER_2, peer: PEER_2, text: "hi" },
    ]);
    expect(store.threadCount(PEER)).toBe(0);
    expect(store.threadCount(PEER_2)).toBe(1);
    expect(store.confirmedCount).toBe(1);
  });

  it("markAllRead never moves a watermark backwards and is idempotent", () => {
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [message("newer", 5)]);
    store.markAllRead();
    // A later sync that only knows about an OLDER message must not un-read the
    // thread — watermarks advance or stay put, never regress.
    store.syncMessages(OWNER_A, [message("older", 1)]);
    store.markAllRead();
    store.syncMessages(OWNER_A, [message("newer", 5), message("older", 1)]);
    expect(store.confirmedCount).toBe(0);
  });

  it("merges another device's watermarks without ever regressing a thread", () => {
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.syncMessages(OWNER_A, [message("newer", 9), { id: "p2", at: 3, from: PEER_2, peer: PEER_2, text: "p2" }]);
    store.markThreadRead(PEER); // local: PEER read up to at=9

    // The other device is BEHIND on PEER (at=2) but ahead on PEER_2. Replaceable
    // 30078 is last-write-wins, so a blind overwrite here would un-read PEER —
    // the merge must take the per-peer maximum in both directions.
    expect(
      store.mergeRemoteWatermarks(OWNER_A, {
        [PEER]: { at: 2, id: "old" },
        [PEER_2]: { at: 3, id: "p2" },
      }),
    ).toBe(true);
    expect(store.threadCount(PEER)).toBe(0); // stayed read
    expect(store.threadCount(PEER_2)).toBe(0); // adopted from the other device
    expect(store.readWatermarks[PEER]).toEqual({ at: 9, id: "newer" });

    // Re-merging the same remote is a no-op, so a steady-state poll publishes nothing.
    expect(
      store.mergeRemoteWatermarks(OWNER_A, {
        [PEER]: { at: 2, id: "old" },
        [PEER_2]: { at: 3, id: "p2" },
      }),
    ).toBe(false);
  });

  it("notifies the read-state syncer only when a LOCAL action advances a watermark", () => {
    const store = new DmUnreadStore();
    const seen: string[] = [];
    store.init(OWNER_A);
    store.setLocalAdvanceListener((owner) => seen.push(owner));

    store.syncMessages(OWNER_A, [message("one", 1)]);
    store.markThreadRead(PEER);
    expect(seen).toEqual([OWNER_A]);

    // Already read: no advance, so no publish is scheduled (this is what keeps
    // re-opening a thread from signing an event every time).
    store.markThreadRead(PEER);
    store.markAllRead();
    expect(seen).toEqual([OWNER_A]);

    // A merge FROM the network must not notify either, or two devices would
    // ping-pong publishes at each other forever.
    store.mergeRemoteWatermarks(OWNER_A, { [PEER_2]: { at: 5, id: "remote" } });
    expect(seen).toEqual([OWNER_A]);

    store.syncMessages(OWNER_A, [message("two", 7)]);
    store.markAllRead();
    expect(seen).toEqual([OWNER_A, OWNER_A]);
  });

  it("keeps generic ciphertext activity separate from confirmed unread", () => {
    const store = new DmUnreadStore();
    store.init(OWNER_A);
    store.observeEncryptedWrapIds(OWNER_A, ["wrap-1"]);
    expect(store.hasEncryptedActivity).toBe(false);
    expect(store.confirmedCount).toBe(0);
    store.observeEncryptedWrapIds(OWNER_A, ["wrap-1", "wrap-2"]);
    expect(store.hasEncryptedActivity).toBe(true);
    store.acknowledgeEncryptedActivity();
    expect(store.hasEncryptedActivity).toBe(false);
  });
});
