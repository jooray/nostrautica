/**
 * App-8: the durable outbox flushes under a single-tab Web Lock, in queuedAt
 * order, and parks an item as terminal `failed` after MAX_FLUSH_ATTEMPTS instead
 * of retrying it forever (with retry/discard user actions).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { publishSigned } = vi.hoisted(() => ({
  publishSigned: vi.fn(async (_event?: unknown, _relays?: unknown) => {}),
}));
vi.mock("./ndk.js", () => ({ publishSigned }));

import {
  __setOutboxBackend,
  __setOutboxLocks,
  publishOrQueue,
  flushQueue,
  listQueued,
  retryFailed,
  discardQueued,
  countQueuedForOwner,
  discardQueuedForOwner,
  MAX_FLUSH_ATTEMPTS,
  type OutboxBackend,
  type QueuedItem,
} from "./publish-queue.js";
import { setActiveCacheOwner, __resetPersistForTests } from "$lib/cache/persist.js";

function memBackend() {
  const store = new Map<string, QueuedItem>();
  const backend: OutboxBackend = {
    async getAll() {
      return [...store.values()];
    },
    async put(item) {
      store.set(item.event.id, item);
    },
    async delete(id) {
      store.delete(id);
    },
  };
  return { backend, store };
}

const OWNER = "f".repeat(64);

function evt(id: string, kind = 1): QueuedItem["event"] {
  return { id, kind, pubkey: OWNER } as unknown as QueuedItem["event"];
}

/** Seed a queued item owned by the active test account (post-U1 shape). */
function seed(store: Map<string, QueuedItem>, id: string, extra: Partial<QueuedItem> = {}) {
  store.set(id, { event: evt(id, extra.event?.kind ?? 1), queuedAt: 1, attempts: 0, owner: OWNER, ...extra });
}

describe("publish-queue (App-8)", () => {
  let store: Map<string, QueuedItem>;
  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER);
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null); // run unguarded by default (single tab)
    publishSigned.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { onLine: true });
  });

  it("flushes queued items in queuedAt order", async () => {
    // Seed out of insertion order; queuedAt should decide send order.
    seed(store, "c", { queuedAt: 300 });
    seed(store, "a", { queuedAt: 100 });
    seed(store, "b", { queuedAt: 200 });
    const res = await flushQueue();
    expect(res.sent).toBe(3);
    expect(publishSigned.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("parks an item as terminal `failed` after MAX_FLUSH_ATTEMPTS, then stops retrying", async () => {
    publishSigned.mockRejectedValue(new Error("relay down"));
    store.set("x", { event: evt("x", 7), queuedAt: 1, attempts: 0, owner: OWNER });
    // Each flush is one durable attempt.
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i++) await flushQueue();
    expect(store.get("x")?.failed).toBe(true);
    expect(store.get("x")?.attempts).toBe(MAX_FLUSH_ATTEMPTS);

    // A further flush must NOT attempt the terminal item again.
    publishSigned.mockClear();
    const res = await flushQueue();
    expect(publishSigned).not.toHaveBeenCalled();
    expect(res.failed).toBe(1);
    expect(res.remaining).toBe(0);
  });

  it("retryFailed revives a terminal item and re-attempts it", async () => {
    publishSigned.mockRejectedValue(new Error("down"));
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, owner: OWNER });
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i++) await flushQueue();
    expect(store.get("x")?.failed).toBe(true);

    publishSigned.mockResolvedValue(undefined); // relay is back
    const res = await retryFailed("x");
    expect(res.sent).toBe(1);
    expect(store.has("x")).toBe(false); // sent + removed
  });

  it("discardQueued permanently drops an item", async () => {
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, failed: true, owner: OWNER });
    await discardQueued("x");
    expect(store.has("x")).toBe(false);
    expect(await listQueued()).toEqual([]);
  });

  it("runs under a single-flusher lock: a contended flush is skipped", async () => {
    // Lock manager that reports the lock as already held (callback gets null).
    __setOutboxLocks({
      request: async (_name, _opts, cb) => cb(null),
    });
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, owner: OWNER });
    const res = await flushQueue();
    expect(res.skipped).toBe(true);
    expect(publishSigned).not.toHaveBeenCalled(); // another tab owns the flush
    expect(store.has("x")).toBe(true); // left for the holder to send
  });

  it("acquires the lock and flushes when it is available", async () => {
    __setOutboxLocks({
      request: async (_name, _opts, cb) => cb({} /* granted lock */),
    });
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, owner: OWNER });
    const res = await flushQueue();
    expect(res.skipped).toBeUndefined();
    expect(res.sent).toBe(1);
  });

  it("publishOrQueue persists with a zeroed attempt counter when offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const queued = await publishOrQueue(evt("q") as never, ["wss://r"]);
    expect(queued).toBe(false);
    expect(store.get("q")).toMatchObject({ attempts: 0, relays: ["wss://r"], owner: OWNER });
  });
});

// U1: the durable outbox is per-account. Queuing as A, switching to B, and
// reconnecting must never let B see, flush, or publish A's already-signed items.
describe("publish-queue owner isolation (audit U1)", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  let store: Map<string, QueuedItem>;

  function evtFor(id: string, pubkey: string): QueuedItem["event"] {
    return { id, kind: 1, pubkey } as unknown as QueuedItem["event"];
  }

  beforeEach(() => {
    __resetPersistForTests();
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null);
    publishSigned.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { onLine: false });
  });

  it("stamps the queuing account, then B never flushes or sees A's item", async () => {
    // A queues an item while offline.
    setActiveCacheOwner(A);
    await publishOrQueue(evtFor("a1", A) as never, ["wss://r"]);
    expect(store.get("a1")?.owner).toBe(A);

    // B logs in on the same device and reconnects.
    setActiveCacheOwner(B);
    vi.stubGlobal("navigator", { onLine: true });
    const res = await flushQueue();
    // Nothing published — A's item is not B's to send — and B sees an empty outbox.
    expect(publishSigned).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
    expect(await listQueued()).toEqual([]);
    // A's item is left untouched for when A returns (not dropped).
    expect(store.has("a1")).toBe(true);

    // A returns and reconnects: now it flushes.
    setActiveCacheOwner(A);
    const res2 = await flushQueue();
    expect(res2.sent).toBe(1);
    expect(publishSigned).toHaveBeenCalledTimes(1);
    expect(store.has("a1")).toBe(false);
  });

  it("discardQueuedForOwner drops only that account's items (logout path)", async () => {
    setActiveCacheOwner(A);
    await publishOrQueue(evtFor("a1", A) as never);
    await publishOrQueue(evtFor("a2", A) as never);
    setActiveCacheOwner(B);
    await publishOrQueue(evtFor("b1", B) as never);

    expect(await countQueuedForOwner(A)).toBe(2);
    const dropped = await discardQueuedForOwner(A);
    expect(dropped).toBe(2);
    expect(store.has("a1")).toBe(false);
    expect(store.has("a2")).toBe(false);
    expect(store.has("b1")).toBe(true); // B's item survives A's logout
  });

  it("drops a legacy ownerless item on flush rather than publishing it", async () => {
    setActiveCacheOwner(A);
    vi.stubGlobal("navigator", { onLine: true });
    store.set("legacy", { event: evtFor("legacy", A), queuedAt: 1, attempts: 0 }); // no owner
    const res = await flushQueue();
    expect(publishSigned).not.toHaveBeenCalled();
    expect(res.sent).toBe(0);
    expect(store.has("legacy")).toBe(false); // migration: dropped, not published
  });
});
