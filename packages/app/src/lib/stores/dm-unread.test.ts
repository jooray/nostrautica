import { beforeEach, describe, expect, it } from "vitest";
import type { DmMessage } from "$lib/events/dm.js";
import { __resetPersistForTests, __setPersistBackend } from "$lib/cache/persist.js";
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

function message(id: string, at: number, from = PEER): DmMessage {
  return { id, at, from, peer: PEER, text: id };
}

beforeEach(() => {
  __setPersistBackend({
    getAll: async () => [],
    put: async () => {},
    delete: async () => {},
  });
  __resetPersistForTests();
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
      { id: "mine", at: 4, from: OWNER_A, peer: PEER_2, text: "mine" },
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
