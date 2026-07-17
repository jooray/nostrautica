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
