/**
 * Persistent app-cache tests (CACHING-PLAN §4). Exercise the mirror/scoping/
 * latest-wins/logout-wipe/hydrate/prune logic against an injected in-memory
 * backend — the same seam pattern as keystore.test.ts (the test env has no
 * IndexedDB).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __setPersistBackend,
  __resetPersistForTests,
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

  it("pruneCache drops entries older than 30 days", async () => {
    __setPersistBackend(memBackend().backend);
    setActiveCacheOwner(A);
    const nowSec = Math.floor(Date.now() / 1000);
    cacheSet("fresh", "keep", nowSec);
    cacheSet("stale", "drop", nowSec - 31 * 24 * 60 * 60);
    await pruneCache();
    expect(cacheGet("fresh")?.data).toBe("keep");
    expect(cacheGet("stale")).toBeUndefined();
  });
});
