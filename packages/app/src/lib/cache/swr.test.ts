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
  cacheGet,
  clearOwnerCache,
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

  it("TTL suppression is scope-qualified: a different scope still refreshes (App-5)", async () => {
    const fetcher = vi.fn(async () => "v");
    await swr("k", fetcher, () => {}, { scope: ANON, ttlMs: 10_000, atOf: () => 1 });
    // Same key, DIFFERENT scope, within the anon TTL — must still hit the network.
    await swr("k", fetcher, () => {}, { scope: "b".repeat(64), ttlMs: 10_000 });
    expect(fetcher).toHaveBeenCalledTimes(2); // pre-fix: 1 (bare-key TTL collision)
  });

  it("in-flight results do not bleed across scopes (App-5)", async () => {
    const anonFetch = vi.fn(async () => "anon-value");
    const ownerFetch = vi.fn(async () => "owner-value");
    const [a, b] = await Promise.all([
      swr("k", anonFetch, () => {}, { scope: ANON, ttlMs: 0 }),
      swr("k", ownerFetch, () => {}, { scope: "b".repeat(64), ttlMs: 0 }),
    ]);
    // Pre-fix the owner call reused the anon in-flight job and returned "anon-value".
    expect(a).toBe("anon-value");
    expect(b).toBe("owner-value");
    expect(anonFetch).toHaveBeenCalledTimes(1);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
  });

  it("a fetch that resolves AFTER a logout does not repopulate owner cache (H-5)", async () => {
    const owner = "a".repeat(64); // set as active in beforeEach
    let release!: (v: string) => void;
    const fetcher = vi.fn(() => new Promise<string>((r) => (release = r)));
    // Fire an owner-scoped refresh; it captures the current generation up front.
    const p = swr("dir", fetcher, () => {}, { scope: owner, ttlMs: 0, atOf: () => 200 });
    // The user logs out mid-flight — clearOwnerCache advances the generation.
    clearOwnerCache(owner);
    // The slow relay finally answers with the logged-out identity's decrypted view.
    release("owner-plaintext");
    await p;
    setActiveCacheOwner(owner);
    // The write was fenced by the stale generation — no plaintext left behind.
    expect(cacheGet("dir", owner)).toBeUndefined();
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
