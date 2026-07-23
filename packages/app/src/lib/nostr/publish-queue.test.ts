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
  MAX_FLUSH_ATTEMPTS,
  type OutboxBackend,
  type QueuedItem,
} from "./publish-queue.js";

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

function evt(id: string, kind = 1): QueuedItem["event"] {
  return { id, kind } as unknown as QueuedItem["event"];
}

describe("publish-queue (App-8)", () => {
  let store: Map<string, QueuedItem>;
  beforeEach(() => {
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null); // run unguarded by default (single tab)
    publishSigned.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { onLine: true });
  });

  it("flushes queued items in queuedAt order", async () => {
    // Seed out of insertion order; queuedAt should decide send order.
    await store.set("c", { event: evt("c"), queuedAt: 300, attempts: 0 });
    await store.set("a", { event: evt("a"), queuedAt: 100, attempts: 0 });
    await store.set("b", { event: evt("b"), queuedAt: 200, attempts: 0 });
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
    store.set("x", { event: evt("x", 7), queuedAt: 1, attempts: 0 });
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
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0 });
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i++) await flushQueue();
    expect(store.get("x")?.failed).toBe(true);

    publishSigned.mockResolvedValue(undefined); // relay is back
    const res = await retryFailed("x");
    expect(res.sent).toBe(1);
    expect(store.has("x")).toBe(false); // sent + removed
  });

  it("discardQueued permanently drops an item", async () => {
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, failed: true });
    await discardQueued("x");
    expect(store.has("x")).toBe(false);
    expect(await listQueued()).toEqual([]);
  });

  it("runs under a single-flusher lock: a contended flush is skipped", async () => {
    // Lock manager that reports the lock as already held (callback gets null).
    __setOutboxLocks({
      request: async (_name, _opts, cb) => cb(null),
    });
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0 });
    const res = await flushQueue();
    expect(res.skipped).toBe(true);
    expect(publishSigned).not.toHaveBeenCalled(); // another tab owns the flush
    expect(store.has("x")).toBe(true); // left for the holder to send
  });

  it("acquires the lock and flushes when it is available", async () => {
    __setOutboxLocks({
      request: async (_name, _opts, cb) => cb({} /* granted lock */),
    });
    store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0 });
    const res = await flushQueue();
    expect(res.skipped).toBeUndefined();
    expect(res.sent).toBe(1);
  });

  it("publishOrQueue persists with a zeroed attempt counter when offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const queued = await publishOrQueue(evt("q") as never, ["wss://r"]);
    expect(queued).toBe(false);
    expect(store.get("q")).toMatchObject({ attempts: 0, relays: ["wss://r"] });
  });
});
