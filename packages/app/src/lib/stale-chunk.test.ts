import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleChunkReloadLatch,
  installStaleChunkRecovery,
  recoverFromStaleChunk,
} from "./stale-chunk.js";

describe("recoverFromStaleChunk", () => {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const listeners = new Map<string, Set<EventListener>>();

  beforeEach(() => {
    store.clear();
    reload.mockReset();
    listeners.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    vi.stubGlobal("window", {
      location: { reload },
      addEventListener: (type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads once on a stale-chunk TypeError", () => {
    const err = new Error(
      "Failed to fetch dynamically imported module: https://x/chunks/W3Bonw05.js",
    );
    expect(recoverFromStaleChunk(err)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Inside cooldown — must not loop.
    expect(recoverFromStaleChunk(err)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated errors", () => {
    expect(recoverFromStaleChunk(new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("vite:preloadError path (no reason) still reloads once", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(recoverFromStaleChunk()).toBe(false);
  });

  it("allows another recovery after the latch is cleared (later deploy)", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    clearStaleChunkReloadLatch();
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("installStaleChunkRecovery reloads on vite:preloadError and unhandledrejection", () => {
    installStaleChunkRecovery();
    const preload = [...(listeners.get("vite:preloadError") ?? [])][0]!;
    const rejection = [...(listeners.get("unhandledrejection") ?? [])][0]!;
    const ev = {
      payload: new Error("Failed to fetch dynamically imported module: x"),
      preventDefault: vi.fn(),
      reason: new Error("Failed to fetch dynamically imported module: y"),
    };
    preload(ev as unknown as Event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(ev.preventDefault).toHaveBeenCalled();
    // Cooldown held — second path must not loop.
    rejection(ev as unknown as Event);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
