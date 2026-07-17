/**
 * SWR helper tests (CACHING-PLAN §4): cache-first apply, in-flight dedupe, TTL
 * short-circuit, and silent failure (background refresh never throws).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  cacheSet,
  ANON,
  type PersistBackend,
} from "./persist.js";
import { swr, __resetSwrForTests } from "./swr.js";

function memBackend(): PersistBackend {
  const store = new Map();
  return {
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
}

describe("swr", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __resetSwrForTests();
    __setPersistBackend(memBackend());
    setActiveCacheOwner("a".repeat(64));
  });

  it("applies the cached value synchronously, then the fresh one", async () => {
    cacheSet("k", "cached", 100, ANON);
    const applied: Array<[string, string]> = [];
    const fresh = await swr(
      "k",
      async () => "fresh",
      (v, source) => applied.push([source, v]),
      { scope: ANON, ttlMs: 0, atOf: () => 200 },
    );
    expect(fresh).toBe("fresh");
    expect(applied).toEqual([
      ["cache", "cached"],
      ["network", "fresh"],
    ]);
  });

  it("dedupes concurrent refreshes for the same key (one fetch)", async () => {
    const fetcher = vi.fn(async () => "v");
    const [a, b] = await Promise.all([
      swr("k", fetcher, () => {}, { scope: ANON, ttlMs: 0 }),
      swr("k", fetcher, () => {}, { scope: ANON, ttlMs: 0 }),
    ]);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("skips the network within the TTL window", async () => {
    const fetcher = vi.fn(async () => "v");
    await swr("k", fetcher, () => {}, { scope: ANON, ttlMs: 10_000, atOf: () => 1 });
    // Second call within TTL → no new fetch.
    await swr("k", fetcher, () => {}, { scope: ANON, ttlMs: 10_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never throws on a background failure; returns the cached value", async () => {
    cacheSet("k", "cached", 100, ANON);
    const fresh = await swr(
      "k",
      async () => {
        throw new Error("relay down");
      },
      () => {},
      { scope: ANON, ttlMs: 0 },
    );
    expect(fresh).toBe("cached");
  });
});
