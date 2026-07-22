/**
 * App-2 draft persistence: compose/create text survives a reload (owner-scoped
 * so it is wiped on logout and never leaks across identities).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __setPersistBackend,
  __resetPersistForTests,
  setActiveCacheOwner,
  clearOwnerCache,
  type CacheEntry,
  type PersistBackend,
} from "$lib/cache/persist.js";
import { saveDraft, loadDraft, clearDraft } from "./drafts.js";

function memBackend(): PersistBackend {
  const store = new Map<string, CacheEntry>();
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

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("drafts (App-2)", () => {
  beforeEach(() => {
    __resetPersistForTests();
    __setPersistBackend(memBackend());
  });

  it("round-trips a draft for the active owner", () => {
    setActiveCacheOwner(A);
    saveDraft("dm:peer", "half-typed message");
    expect(loadDraft("dm:peer")).toBe("half-typed message");
  });

  it("saving empty (or whitespace) clears the draft", () => {
    setActiveCacheOwner(A);
    saveDraft("create:title", "Conf 2026");
    saveDraft("create:title", "   ");
    expect(loadDraft("create:title")).toBeUndefined();
  });

  it("clearDraft removes it (post-send)", () => {
    setActiveCacheOwner(A);
    saveDraft("chat:naddr", "gm");
    clearDraft("chat:naddr");
    expect(loadDraft("chat:naddr")).toBeUndefined();
  });

  it("drafts are owner-scoped: another identity can't read them, logout wipes them", () => {
    setActiveCacheOwner(A);
    saveDraft("dm:peer", "A's private draft");
    // A different identity sees nothing.
    setActiveCacheOwner(B);
    expect(loadDraft("dm:peer")).toBeUndefined();
    // Back to A, logout wipes it.
    setActiveCacheOwner(A);
    expect(loadDraft("dm:peer")).toBe("A's private draft");
    clearOwnerCache(A);
    expect(loadDraft("dm:peer")).toBeUndefined();
  });

  it("logged out, saving is a silent no-op", () => {
    setActiveCacheOwner(null);
    saveDraft("dm:peer", "nowhere to store");
    expect(loadDraft("dm:peer")).toBeUndefined();
  });
});
