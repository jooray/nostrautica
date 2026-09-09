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

/**
 * Run `times` durable flush ATTEMPTS, letting the clock move between them.
 *
 * Attempts are rationed by elapsed time (FLUSH_BACKOFF_MS), so a tight
 * `for (…) await flushQueue()` loop no longer spends one attempt per iteration —
 * that loop IS the flapping captive portal the backoff exists to absorb. Tests
 * about the terminal-failure policy therefore have to advance past the longest
 * backoff step between calls. Requires fake timers.
 */
async function flushOverTime(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await flushQueue();
    vi.setSystemTime(Date.now() + 30 * 60_000);
  }
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
    vi.useFakeTimers();
    try {
      publishSigned.mockRejectedValue(new Error("relay down"));
      store.set("x", { event: evt("x", 7), queuedAt: 1, attempts: 0, owner: OWNER });
      // Each flush a backoff step apart is one durable attempt.
      await flushOverTime(MAX_FLUSH_ATTEMPTS);
      expect(store.get("x")?.failed).toBe(true);
      expect(store.get("x")?.attempts).toBe(MAX_FLUSH_ATTEMPTS);

      // A further flush must NOT attempt the terminal item again.
      publishSigned.mockClear();
      const res = await flushQueue();
      expect(publishSigned).not.toHaveBeenCalled();
      expect(res.failed).toBe(1);
      expect(res.remaining).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryFailed revives a terminal item and re-attempts it", async () => {
    vi.useFakeTimers();
    try {
      publishSigned.mockRejectedValue(new Error("down"));
      store.set("x", { event: evt("x"), queuedAt: 1, attempts: 0, owner: OWNER });
      await flushOverTime(MAX_FLUSH_ATTEMPTS);
      expect(store.get("x")?.failed).toBe(true);

      publishSigned.mockResolvedValue(undefined); // relay is back
      const res = await retryFailed("x");
      expect(res.sent).toBe(1);
      expect(store.has("x")).toBe(false); // sent + removed
    } finally {
      vi.useRealTimers();
    }
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

/**
 * A publish succeeds at the FIRST relay that acks, which is the right call for
 * the user's latency but leaves the event present on some relays and absent from
 * others. Nothing used to notice: publishSigned already returned a per-relay
 * outcome for every target and no caller read it. A reader that happens to ask
 * only the relays that missed it sees nothing at all — for a replaceable
 * authority event (an event's config, its roster, a directory entry) that reads
 * as "this doesn't exist" rather than "one relay is behind".
 */
describe("partial publishes are carried to the relays that missed them", () => {
  const OWNER2 = "c".repeat(64);
  let store: Map<string, QueuedItem>;
  const ok = (url: string) => ({ url, ok: true });
  const bad = (url: string, reason: string) => ({ url, ok: false, reason });

  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER2);
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null);
    publishSigned.mockReset();
    vi.stubGlobal("navigator", { onLine: true });
  });

  const evt2 = (id: string) => ({ id, kind: 31600, pubkey: OWNER2 }) as unknown as QueuedItem["event"];

  it("queues only the relays worth trying again, and still reports the publish as sent", async () => {
    publishSigned.mockResolvedValue([
      ok("wss://a.example/"),
      bad("wss://slow.example/", "Timeout: 2500ms"),
      bad("wss://strict.example/", "blocked: kind not allowed on this relay"),
    ] as never);

    // True: the event IS out. The straggler is convergence work, not a failed action.
    expect(await publishOrQueue(evt2("e1") as never)).toBe(true);

    const item = store.get("e1")!;
    expect(item.partial).toBe(true);
    // The refusing relay is not a straggler — it will answer the same way forever.
    expect(item.relays).toEqual(["wss://slow.example/"]);
  });

  it("queues nothing when every relay either took it or will never take it", async () => {
    publishSigned.mockResolvedValue([
      ok("wss://a.example/"),
      bad("wss://b.example/", "duplicate: already have this event"),
      bad("wss://c.example/", "blocked: kind not allowed on this relay"),
    ] as never);
    await publishOrQueue(evt2("e2") as never);
    expect(store.size).toBe(0);
  });

  it("keeps convergence work out of the user's outbox and the logout warning", async () => {
    publishSigned.mockResolvedValue([ok("wss://a/"), bad("wss://b/", "Timeout: 2500ms")] as never);
    await publishOrQueue(evt2("e3") as never);
    // The action succeeded, so nothing here is the user's to retry, discard, or
    // be warned about on logout.
    expect(await listQueued()).toEqual([]);
    expect(await countQueuedForOwner(OWNER2)).toBe(0);
  });

  it("gives up on an unreachable straggler quietly instead of parking it as failed", async () => {
    store.set("e4", {
      event: evt2("e4"),
      relays: ["wss://gone/"],
      queuedAt: 1,
      attempts: MAX_FLUSH_ATTEMPTS - 1,
      owner: OWNER2,
      partial: true,
    });
    publishSigned.mockRejectedValue(new Error("Not enough relays received the event"));

    const res = await flushQueue();
    // Dropped, not parked: an outbox entry the user can only be confused by,
    // since the action it describes already succeeded.
    expect(store.has("e4")).toBe(false);
    expect(res.failed).toBe(0);
  });

  it("never narrows a still-unsent item down to a straggler relay set", async () => {
    // A genuinely queued event targets every relay. If a later partial write
    // overwrote it (the store is keyed by event id) it would go out to one relay.
    store.set("e5", {
      event: evt2("e5"),
      relays: ["wss://a/", "wss://b/"],
      queuedAt: 1,
      attempts: 0,
      owner: OWNER2,
    });
    publishSigned.mockResolvedValue([ok("wss://a/"), bad("wss://b/", "Timeout: 2500ms")] as never);
    await publishOrQueue(evt2("e5") as never);

    const item = store.get("e5")!;
    expect(item.partial).toBeUndefined();
    expect(item.relays).toEqual(["wss://a/", "wss://b/"]);
  });
});

/**
 * The straggler redelivery reproduced, one layer down, the exact bug it was
 * written to fix. `flushQueue` called `publishSigned(item.event, item.relays)`
 * and deleted the item on success — but `publishSigned` succeeds at the FIRST
 * relay that acks. A `partial` item carrying an event to three relays that
 * missed it was therefore deleted when one of them accepted, leaving the other
 * two permanently without it. Nobody could notice: `partial` items are
 * deliberately invisible in the outbox UI and are dropped rather than parked.
 */
describe("straggler redelivery is not itself 1-of-N", () => {
  const OWNER3 = "d".repeat(64);
  let store: Map<string, QueuedItem>;
  const ok = (url: string) => ({ url, ok: true });
  const bad = (url: string, reason: string) => ({ url, ok: false, reason });
  const evt3 = (id: string) => ({ id, kind: 31600, pubkey: OWNER3 }) as unknown as QueuedItem["event"];

  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER3);
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null);
    publishSigned.mockReset();
    vi.stubGlobal("navigator", { onLine: true });
  });

  it("keeps carrying the event to the relays that STILL missed it", async () => {
    store.set("s1", {
      event: evt3("s1"),
      relays: ["wss://a/", "wss://b/", "wss://c/"],
      queuedAt: 1,
      attempts: 0,
      owner: OWNER3,
      partial: true,
    });
    // One of the three takes it; the other two time out — retryable, so they are
    // still missing it and the item must survive, narrowed to exactly those two.
    publishSigned.mockResolvedValue([
      ok("wss://a/"),
      bad("wss://b/", "Timeout: 2500ms"),
      bad("wss://c/", "Timeout: 2500ms"),
    ] as never);

    await flushQueue();
    const item = store.get("s1");
    expect(item).toBeDefined();
    expect(item!.relays).toEqual(["wss://b/", "wss://c/"]);
    expect(item!.partial).toBe(true);
  });

  it("deletes the item only once every remaining relay has it (or never will)", async () => {
    store.set("s2", {
      event: evt3("s2"),
      relays: ["wss://b/", "wss://c/"],
      queuedAt: 1,
      attempts: 0,
      owner: OWNER3,
      partial: true,
    });
    publishSigned.mockResolvedValue([
      ok("wss://b/"),
      // "blocked" is permanent: that relay will answer the same way forever, so
      // there is nothing left to converge.
      bad("wss://c/", "blocked: kind not accepted by this relay"),
    ] as never);

    const res = await flushQueue();
    expect(store.has("s2")).toBe(false);
    expect(res.sent).toBe(1);
  });

  it("narrows a partially-delivered USER item to the missing relays instead of dropping them", async () => {
    // Not a straggler item: a genuinely queued user action that goes out to only
    // one of its three relays. The action succeeded, so it leaves the outbox —
    // but the two relays that missed it are still carried.
    store.set("s3", {
      event: evt3("s3"),
      relays: ["wss://a/", "wss://b/", "wss://c/"],
      queuedAt: 1,
      attempts: 0,
      owner: OWNER3,
    });
    publishSigned.mockResolvedValue([
      ok("wss://a/"),
      bad("wss://b/", "Timeout"),
      bad("wss://c/", "Timeout"),
    ] as never);

    const res = await flushQueue();
    expect(res.sent).toBe(1);
    expect(res.remaining).toBe(0); // the user's action is done
    expect(await listQueued()).toEqual([]); // convergence work stays out of the UI
    expect(store.get("s3")?.relays).toEqual(["wss://b/", "wss://c/"]);
    expect(store.get("s3")?.partial).toBe(true);
  });

  it("gives up quietly once a never-converging straggler exhausts its attempts", async () => {
    store.set("s4", {
      event: evt3("s4"),
      relays: ["wss://a/", "wss://b/"],
      queuedAt: 1,
      attempts: MAX_FLUSH_ATTEMPTS - 1,
      owner: OWNER3,
      partial: true,
    });
    publishSigned.mockResolvedValue([ok("wss://a/"), bad("wss://b/", "Timeout")] as never);
    const res = await flushQueue();
    expect(store.has("s4")).toBe(false);
    expect(res.failed).toBe(0); // never parked as a user-visible failure
  });
});

/**
 * Attempts used to be spent per FLUSH, and the flush runs on every `online`
 * event. A captive portal at a venue flaps several times a minute, so five
 * transitions inside a minute burned all five attempts and parked a join request
 * as terminal `failed` behind a Retry button in a panel most users never open.
 */
describe("flush attempts are rationed by time, not by `online` events", () => {
  const OWNER4 = "e".repeat(64);
  let store: Map<string, QueuedItem>;

  beforeEach(() => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER4);
    const m = memBackend();
    store = m.store;
    __setOutboxBackend(m.backend);
    __setOutboxLocks(null);
    publishSigned.mockReset().mockRejectedValue(new Error("relay down"));
    vi.stubGlobal("navigator", { onLine: true });
  });

  it("five reconnects in one minute spend ONE attempt, not five", async () => {
    vi.useFakeTimers();
    try {
      store.set("f1", {
        event: evt("f1"),
        queuedAt: Date.now(),
        attempts: 0,
        owner: OWNER4,
      });
      // The captive portal flaps: five `online` transitions inside twelve seconds.
      for (let i = 0; i < 5; i++) {
        await flushQueue();
        vi.setSystemTime(Date.now() + 3_000);
      }
      expect(store.get("f1")?.attempts).toBe(1);
      expect(store.get("f1")?.failed).toBeFalsy(); // still recoverable
      expect(publishSigned).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still spends every attempt when real time passes", async () => {
    vi.useFakeTimers();
    try {
      store.set("f2", { event: evt("f2"), queuedAt: Date.now(), attempts: 0, owner: OWNER4 });
      await flushOverTime(MAX_FLUSH_ATTEMPTS); // half an hour between tries
      expect(store.get("f2")?.attempts).toBe(MAX_FLUSH_ATTEMPTS);
      expect(store.get("f2")?.failed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an explicit Retry ignores the backoff — the user just asked", async () => {
    vi.useFakeTimers();
    try {
      store.set("f3", {
        event: evt("f3"),
        queuedAt: Date.now(),
        attempts: MAX_FLUSH_ATTEMPTS,
        lastAttemptAt: Date.now(),
        failed: true,
        owner: OWNER4,
      });
      publishSigned.mockResolvedValue(undefined as never);
      const res = await retryFailed("f3");
      expect(res.sent).toBe(1);
      expect(store.has("f3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `queueUndelivered` ran a full-store `getAll()` on EVERY successful publish just
 * to answer "is this event already queued?". With the IndexedDB backend that also
 * meant an open/close cycle per call. It asks for one row now.
 */
describe("outbox reads are point lookups where they can be", () => {
  const OWNER5 = "9".repeat(64);
  const evt5 = (id: string) => ({ id, kind: 31600, pubkey: OWNER5 }) as unknown as QueuedItem["event"];

  it("uses the backend's get() instead of scanning the whole store", async () => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER5);
    const m = memBackend();
    const getAll = vi.fn(m.backend.getAll);
    const get = vi.fn(async (id: string) => m.store.get(id));
    __setOutboxBackend({ ...m.backend, getAll, get });
    __setOutboxLocks(null);
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned
      .mockReset()
      .mockResolvedValue([
        { url: "wss://a/", ok: true },
        { url: "wss://b/", ok: false, reason: "Timeout" },
      ] as never);

    await publishOrQueue(evt5("p1") as never);
    expect(get).toHaveBeenCalledWith("p1");
    expect(getAll).not.toHaveBeenCalled();
  });

  it("a flush reads the store once, not once per item plus a closing scan", async () => {
    __resetPersistForTests();
    setActiveCacheOwner(OWNER5);
    const m = memBackend();
    const getAll = vi.fn(m.backend.getAll);
    __setOutboxBackend({ ...m.backend, getAll });
    __setOutboxLocks(null);
    vi.stubGlobal("navigator", { onLine: true });
    publishSigned.mockReset().mockResolvedValue(undefined as never);
    for (const id of ["q1", "q2", "q3"]) {
      m.store.set(id, { event: evt5(id), queuedAt: 1, attempts: 0, owner: OWNER5 });
    }
    const res = await flushQueue();
    expect(res.sent).toBe(3);
    expect(getAll).toHaveBeenCalledTimes(1);
  });
});
