/**
 * Persistent app-cache tests (CACHING-PLAN §4). Exercise the mirror/scoping/
 * latest-wins/logout-wipe/hydrate/prune logic against an injected in-memory
 * backend — the same seam pattern as keystore.test.ts (the test env has no
 * IndexedDB).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cacheHydration } from "./hydration.svelte.js";
import {
  __setPersistBackend,
  __resetPersistForTests,
  __enforceCacheBudgetForTests,
  __setCacheBudgetForTests,
  cacheStats,
  cachePersistenceDegraded,
  setActiveCacheOwner,
  activeCacheOwner,
  cacheGet,
  cacheSet,
  cacheDelete,
  clearOwnerCache,
  cacheGeneration,
  pruneCache,
  hydrateAppCache,
  ANON,
  type CacheEntry,
  type PersistBackend,
} from "./persist.js";

/** In-memory backend backed by a Map so hydrate/put/delete are observable. */
function memBackend() {
  const store = new Map<string, CacheEntry>();
  const backend: PersistBackend = {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
  };
  return { backend, store };
}

/**
 * Backend that also implements the H-5 owner-prefix range delete AND a versioned
 * (App-6) put, so the tests can observe the real production code paths rather
 * than the mirror-only fallback.
 */
function fullBackend() {
  const store = new Map<string, CacheEntry>();
  const SEP = "\x1f";
  const backend: PersistBackend = {
    async getAll() {
      return [...store.entries()];
    },
    async put(k, v) {
      const existing = store.get(k);
      // Read-modify-write inside the "transaction" (App-6): drop stale writes.
      if (!existing || v.at >= existing.at) store.set(k, v);
    },
    async delete(keys) {
      for (const k of keys) store.delete(k);
    },
    async deleteByPrefix(prefix) {
      for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
    },
  };
  return { backend, store, SEP };
}

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("persist owner scoping", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memBackend().backend);
  });

  it("scopes owner data to the active identity; anon is shared", () => {
    setActiveCacheOwner(A);
    cacheSet("dir", ["x"]);
    cacheSet("theme", "css", undefined, ANON);
    expect(cacheGet<string[]>("dir")?.data).toEqual(["x"]);

    // Switching identity hides A's owner-scoped data but not the anon entry.
    setActiveCacheOwner(B);
    expect(cacheGet("dir")).toBeUndefined();
    expect(cacheGet<string>("theme", ANON)?.data).toBe("css");

    setActiveCacheOwner(A);
    expect(cacheGet<string[]>("dir")?.data).toEqual(["x"]);
  });

  it("owner reads/writes with no active identity are safe no-ops", () => {
    setActiveCacheOwner(null);
    expect(activeCacheOwner()).toBeNull();
    cacheSet("dir", ["x"]); // no-op (no owner)
    expect(cacheGet("dir")).toBeUndefined();
    // Anon still works logged-out.
    cacheSet("theme", "css", undefined, ANON);
    expect(cacheGet<string>("theme", ANON)?.data).toBe("css");
  });
});

describe("persist latest-wins", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
  });

  it("never overwrites a newer entry with an older one", () => {
    cacheSet("k", "v100", 100);
    cacheSet("k", "v50", 50); // older — ignored
    expect(cacheGet<string>("k")?.data).toBe("v100");
    cacheSet("k", "v200", 200); // newer — wins
    expect(cacheGet<string>("k")?.data).toBe("v200");
    cacheSet("k", "vEq", 200); // equal at — allowed (>=)
    expect(cacheGet<string>("k")?.data).toBe("vEq");
  });

  it("detaches a stored snapshot from subsequent caller mutations", () => {
    const value = { threads: { peer: { at: 10, id: "read" } } };
    cacheSet("snapshot", value);
    value.threads.peer.at = 20;
    expect(cacheGet<typeof value>("snapshot")?.data.threads.peer.at).toBe(10);
  });
});

describe("persist logout wipe + delete", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memBackend().backend);
  });

  it("clearOwnerCache wipes one owner's entries and leaves anon + other owners", () => {
    setActiveCacheOwner(A);
    cacheSet("dir", ["a-data"]);
    cacheSet("theme", "css", undefined, ANON);
    setActiveCacheOwner(B);
    cacheSet("dir", ["b-data"]);

    clearOwnerCache(A);
    setActiveCacheOwner(A);
    expect(cacheGet("dir")).toBeUndefined();
    // Anon and B survive.
    expect(cacheGet<string>("theme", ANON)?.data).toBe("css");
    setActiveCacheOwner(B);
    expect(cacheGet<string[]>("dir")?.data).toEqual(["b-data"]);
  });

  it("cacheDelete removes a single entry", () => {
    setActiveCacheOwner(A);
    cacheSet("k", "v");
    cacheDelete("k");
    expect(cacheGet("k")).toBeUndefined();
  });

  it("clearOwnerCache range-deletes even a FOREIGN tab's owner keys off disk (H-5)", async () => {
    const { backend, store, SEP } = fullBackend();
    __setPersistBackend(backend);
    // A second tab wrote an owner-scoped key straight to disk — this tab's mirror
    // never saw it (the leak clearOwnerCache used to miss).
    store.set(`${A}${SEP}foreign`, { at: 1, data: "secret-from-other-tab" });
    store.set(`${ANON}${SEP}pub`, { at: 1, data: "public" });
    setActiveCacheOwner(A);
    cacheSet("local", "seen-by-this-tab");
    clearOwnerCache(A);
    // Give the fire-and-forget range delete a tick to run.
    await Promise.resolve();
    expect(store.has(`${A}${SEP}foreign`)).toBe(false); // foreign owner key gone
    expect(store.has(`${A}${SEP}local`)).toBe(false); // this tab's own key gone
    expect(store.has(`${ANON}${SEP}pub`)).toBe(true); // anon survives
  });

  it("bumps the generation so an in-flight write completing after logout is dropped (H-5)", () => {
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
    const gen = cacheGeneration();
    // …async producer starts here, capturing `gen`…
    clearOwnerCache(A); // logout advances the generation
    setActiveCacheOwner(A); // (same identity logs back in, mirror is empty)
    // The slow producer finally writes back, guarded by the stale generation.
    cacheSet("dir", ["stale-plaintext"], undefined, undefined, gen);
    expect(cacheGet("dir")).toBeUndefined(); // fenced out — no repopulation
    // A write guarded by the CURRENT generation still lands.
    cacheSet("dir", ["fresh"], undefined, undefined, cacheGeneration());
    expect(cacheGet<string[]>("dir")?.data).toEqual(["fresh"]);
  });
});

describe("persist cross-tab disk latest-wins (App-6)", () => {
  beforeEach(() => __resetPersistForTests());

  it("a stale fire-and-forget put cannot regress newer disk state", async () => {
    const { backend, store, SEP } = fullBackend();
    __setPersistBackend(backend);
    // Tab B already persisted a newer value to disk (at=200) that tab A never saw.
    store.set(`${A}${SEP}k`, { at: 200, data: "tab-B-newer" });
    setActiveCacheOwner(A);
    // Tab A, whose mirror is empty, writes its older value (at=100).
    cacheSet("k", "tab-A-older", 100);
    await Promise.resolve();
    // The versioned put compared on-disk `at` inside the txn and refused the
    // regression — disk keeps tab B's newer value.
    expect(store.get(`${A}${SEP}k`)?.data).toBe("tab-B-newer");
  });
});

describe("persist hydration generation fence (H-5)", () => {
  beforeEach(() => __resetPersistForTests());

  it("a logout during a slow hydrate does not repopulate owner plaintext", async () => {
    let release!: (v: Array<[string, CacheEntry]>) => void;
    const gate = new Promise<Array<[string, CacheEntry]>>((r) => (release = r));
    const backend: PersistBackend = {
      getAll: () => gate,
      put: async () => {},
      delete: async () => {},
    };
    __setPersistBackend(backend);
    const p = hydrateAppCache();
    // Logout lands mid-hydrate (bumps the generation).
    clearOwnerCache(A);
    // The bulk read now resolves with the logged-out identity's owner plaintext
    // plus an anon entry.
    release([
      [`${A}\x1fdir`, { at: 10, data: ["owner-plaintext"] }],
      [`${ANON}\x1ftheme`, { at: 5, data: "css" }],
    ]);
    await p;
    setActiveCacheOwner(A);
    expect(cacheGet("dir")).toBeUndefined(); // owner plaintext NOT repopulated
    expect(cacheGet<string>("theme", ANON)?.data).toBe("css"); // anon still warms
  });
});

describe("late hydration never paints over a fresher entry (INFRA-N-4)", () => {
  beforeEach(() => __resetPersistForTests());

  it("keeps the newer in-memory record when the bulk read lands with an older one", async () => {
    // Boot no longer awaits the bulk read (§7.4.5), so by the time it lands the app
    // has been running for up to 1.5 s and has very likely written fresher entries
    // — a just-fetched event context, a submission's write-through. Overwriting
    // those with what was on disk when the read STARTED paints stale over fresh,
    // and pages re-read on the hydration bump, so they actively pick the stale copy
    // up until the next revalidation.
    let release!: (v: Array<[string, CacheEntry]>) => void;
    const gate = new Promise<Array<[string, CacheEntry]>>((r) => (release = r));
    __setPersistBackend({ getAll: () => gate, put: async () => {}, delete: async () => {} });
    const p = hydrateAppCache();

    // The app fetches and writes while the bulk read is still in flight.
    setActiveCacheOwner(A);
    cacheSet("dir", ["fresh"], 100);

    release([
      [`${A}\x1fdir`, { at: 10, data: ["stale-from-disk"] }],
      [`${A}\x1fother`, { at: 10, data: ["only-on-disk"] }],
    ]);
    await p;

    expect(cacheGet<string[]>("dir")?.data).toEqual(["fresh"]);
    // Entries the app has NOT touched still hydrate — this is a latest-wins rule,
    // not a "skip everything once anything is in memory" rule.
    expect(cacheGet<string[]>("other")?.data).toEqual(["only-on-disk"]);
  });

  it("still takes the disk copy when it is the newer one (another tab wrote it)", async () => {
    let release!: (v: Array<[string, CacheEntry]>) => void;
    const gate = new Promise<Array<[string, CacheEntry]>>((r) => (release = r));
    __setPersistBackend({ getAll: () => gate, put: async () => {}, delete: async () => {} });
    const p = hydrateAppCache();
    setActiveCacheOwner(A);
    cacheSet("dir", ["older"], 10);
    release([[`${A}\x1fdir`, { at: 100, data: ["newer-from-disk"] }]]);
    await p;
    expect(cacheGet<string[]>("dir")?.data).toEqual(["newer-from-disk"]);
  });
});

describe("persist hydrate + prune", () => {
  beforeEach(() => __resetPersistForTests());

  it("hydrateAppCache fills the synchronous mirror from the backend", async () => {
    const { backend, store } = memBackend();
    store.set(`${A}\x1fdir`, { at: 10, data: ["seed"] });
    store.set(`${ANON}\x1ftheme`, { at: 5, data: "css" });
    __setPersistBackend(backend);
    await hydrateAppCache();
    setActiveCacheOwner(A);
    expect(cacheGet<string[]>("dir")?.data).toEqual(["seed"]);
    expect(cacheGet<string>("theme", ANON)?.data).toBe("css");
  });

  it("hydrateAppCache resolves even if the backend hangs (bounded)", async () => {
    vi.useFakeTimers();
    const backend: PersistBackend = {
      getAll: () => new Promise(() => {}), // never resolves
      put: async () => {},
      delete: async () => {},
    };
    __setPersistBackend(backend);
    const p = hydrateAppCache();
    await vi.advanceTimersByTimeAsync(1600);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  /**
   * Eviction runs on `touchedAt` (last use), never on `at` (the source event's
   * created_at). This test asserted the opposite until 2026-09-04, which is why the
   * bug survived: most writers stamp `at` with the source event's timestamp, so
   * pruning on `at` evicted every record of an event configured more than 30 days
   * before it happened — on every boot, permanently, exactly at the venue where the
   * cache matters most.
   */
  it("pruneCache keeps a current record derived from an OLD event (the 2026-09-04 regression)", async () => {
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
    const old = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
    // A conference configured two months ago and untouched since: `at` is ancient,
    // but we are caching it right now, so it must survive.
    cacheSet("ctx", "keep", old);
    await pruneCache();
    expect(cacheGet("ctx")?.data).toBe("keep");
  });

  it("pruneCache drops entries not touched in 30 days", async () => {
    vi.useFakeTimers();
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
    // Written 31 days ago and never read or rewritten since.
    vi.setSystemTime(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    cacheSet("stale", "drop");
    vi.useRealTimers();
    cacheSet("fresh", "keep");
    await pruneCache();
    expect(cacheGet("fresh")?.data).toBe("keep");
    expect(cacheGet("stale")).toBeUndefined();
  });

  it("a read refreshes the eviction clock, so data still in use never ages out", async () => {
    vi.useFakeTimers();
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
    vi.setSystemTime(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    cacheSet("used", "keep");
    vi.useRealTimers();
    expect(cacheGet("used")?.data).toBe("keep"); // touches it
    await pruneCache();
    expect(cacheGet("used")?.data).toBe("keep");
  });
});

/**
 * The 1500 ms hydration bound exists for slow/broken IndexedDB — i.e. exactly
 * the devices where it actually fires. Firing it used to LOSE the wake-up:
 * `done()` marked hydrated, then short-circuited on `settled`, so when the real
 * `getAll()` finally landed and filled the mirror, `cacheHydration.version`
 * never bumped again. Pages that had already read the cold mirror never re-read
 * it, and the cache sat fully populated and entirely unused for that whole boot.
 */
describe("hydration wakes pages even when the bound fired first", () => {
  beforeEach(() => __resetPersistForTests());

  it("bumps the hydration signal AGAIN when the slow read finally lands", async () => {
    vi.useFakeTimers();
    try {
      let deliver!: (rows: Array<[string, CacheEntry]>) => void;
      const backend: PersistBackend = {
        getAll: () =>
          new Promise<Array<[string, CacheEntry]>>((resolve) => {
            deliver = resolve;
          }),
        put: async () => {},
        delete: async () => {},
      };
      __setPersistBackend(backend);

      const before = cacheHydration.version;
      const p = hydrateAppCache();
      // The bound fires: boot is unblocked with a mirror that is still empty.
      await vi.advanceTimersByTimeAsync(1600);
      await expect(p).resolves.toBeUndefined();
      const afterBound = cacheHydration.version;
      expect(afterBound).toBeGreaterThan(before);
      setActiveCacheOwner(A);
      expect(cacheGet("dir")).toBeUndefined(); // cold, as the pages saw it

      // …and now the real read lands.
      deliver([[`${A}\x1fdir`, { at: 10, data: ["seed"] }]]);
      await vi.advanceTimersByTimeAsync(0);
      expect(cacheGet<string[]>("dir")?.data).toEqual(["seed"]);
      // The signal MUST move again, or nothing re-reads the now-warm mirror.
      expect(cacheHydration.version).toBeGreaterThan(afterBound);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * `pruneCache` was age-only, and the IDB put swallowed every error including the
 * one it was guaranteed to meet: QuotaExceededError. A heavy user who reads
 * everything they store never ages anything out, so the store grew until the
 * browser started refusing writes — silently, while the in-memory mirror kept
 * reporting the data as cached. Perfect behaviour all session, stone-cold boot
 * every morning, nothing logged.
 */
describe("cache size budget + quota reporting", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setCacheBudgetForTests();
  });

  it("evicts the LEAST RECENTLY USED entries when over the entry cap", () => {
    __setPersistBackend(memBackend().backend);
    __setCacheBudgetForTests({ entries: 3 });
    setActiveCacheOwner(A);
    vi.useFakeTimers();
    try {
      for (const k of ["a", "b", "c", "d", "e"]) {
        cacheSet(k, k);
        vi.setSystemTime(Date.now() + 2000); // each write a couple of seconds later
      }
      // "a" and "b" are the oldest-touched, so they go first.
      expect(__enforceCacheBudgetForTests()).toBe(2);
      expect(cacheGet("a")).toBeUndefined();
      expect(cacheGet("b")).toBeUndefined();
      expect(cacheGet<string>("e")?.data).toBe("e");
      expect(cacheStats().entries).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an entry that is still being READ, however old the write was", () => {
    __setPersistBackend(memBackend().backend);
    __setCacheBudgetForTests({ entries: 2 });
    setActiveCacheOwner(A);
    vi.useFakeTimers();
    try {
      cacheSet("old-but-used", 1);
      vi.setSystemTime(Date.now() + 60_000);
      cacheSet("mid", 2);
      vi.setSystemTime(Date.now() + 60_000);
      cacheSet("new", 3);
      // A read is a use: it refreshes the eviction clock (mirror-only).
      vi.setSystemTime(Date.now() + 60_000);
      expect(cacheGet("old-but-used")).toBeDefined();

      __enforceCacheBudgetForTests();
      expect(cacheGet("old-but-used")).toBeDefined(); // survived on last-use
      expect(cacheGet("mid")).toBeUndefined(); // the genuinely idle one went
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts on a byte budget too, not just an entry count", () => {
    __setPersistBackend(memBackend().backend);
    __setCacheBudgetForTests({ bytes: 600 });
    setActiveCacheOwner(A);
    cacheSet("big1", "x".repeat(400));
    cacheSet("big2", "y".repeat(400));
    cacheSet("big3", "z".repeat(400));
    expect(__enforceCacheBudgetForTests()).toBeGreaterThan(0);
    expect(cacheStats().bytes).toBeLessThanOrEqual(600);
  });

  it("reports a QuotaExceededError instead of swallowing it, and frees space", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const quotaError = Object.assign(new Error("full"), { name: "QuotaExceededError" });
      const deleted: string[][] = [];
      __setPersistBackend({
        async getAll() {
          return [];
        },
        async put() {
          throw quotaError;
        },
        async delete(keys) {
          deleted.push(keys);
        },
      });
      __setCacheBudgetForTests({ entries: 2 });
      setActiveCacheOwner(A);
      expect(cachePersistenceDegraded()).toBe(false);

      cacheSet("k1", "v1");
      cacheSet("k2", "v2");
      cacheSet("k3", "v3");
      // The rejections are fire-and-forget; let their handlers run.
      await Promise.resolve();
      await Promise.resolve();

      expect(cachePersistenceDegraded()).toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(deleted.flat().length).toBeGreaterThan(0); // it made room
    } finally {
      warn.mockRestore();
    }
  });

  it("pruneCache enforces the size budget, not only the 30-day age cutoff", async () => {
    __setPersistBackend(memBackend().backend);
    __setCacheBudgetForTests({ entries: 2 });
    setActiveCacheOwner(A);
    // Everything written and read today: age alone can never bound this.
    cacheSet("p1", "1");
    cacheSet("p2", "2");
    cacheSet("p3", "3");
    cacheSet("p4", "4");
    await pruneCache();
    expect(cacheStats().entries).toBe(2);
  });
});
