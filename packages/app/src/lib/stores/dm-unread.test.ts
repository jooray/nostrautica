import { beforeEach, describe, expect, it } from "vitest";
import type { DmMessage } from "$lib/events/dm.js";
import { __resetPersistForTests, __setPersistBackend } from "$lib/cache/persist.js";
import { DmUnreadStore, compareDmPosition, incomingUnreadCount } from "./dm-unread.svelte.js";

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const PEER = "c".repeat(64);

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
