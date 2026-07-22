/**
 * App-2: an automatic refresh must never destroy unsaved work, but must still
 * apply on its own (global PWA mandate). The guard reloads immediately when
 * nothing is dirty, defers while any holder is dirty, and fires automatically
 * the moment the last holder clears.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { refreshGuard } from "./refresh-guard.svelte.js";

describe("refreshGuard (App-2)", () => {
  beforeEach(() => refreshGuard.__resetForTests());

  it("reloads immediately when nothing is dirty", () => {
    const reload = vi.fn();
    refreshGuard.requestRefresh(reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(refreshGuard.updateWaiting).toBe(false);
  });

  it("defers while dirty, then applies automatically when the last holder clears", () => {
    const release = refreshGuard.hold("recording");
    expect(refreshGuard.dirty).toBe(true);

    const reload = vi.fn();
    refreshGuard.requestRefresh(reload);
    expect(reload).not.toHaveBeenCalled(); // held off
    expect(refreshGuard.updateWaiting).toBe(true);

    release();
    expect(reload).toHaveBeenCalledTimes(1); // applied on clear
    expect(refreshGuard.updateWaiting).toBe(false);
  });

  it("waits for EVERY holder — multiple reasons must all clear", () => {
    const r1 = refreshGuard.hold("dm");
    const r2 = refreshGuard.hold("create");
    const reload = vi.fn();
    refreshGuard.requestRefresh(reload);
    r1();
    expect(reload).not.toHaveBeenCalled(); // create still dirty
    r2();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the same reason refcounts — two holds need two releases", () => {
    const a = refreshGuard.hold("post");
    const b = refreshGuard.hold("post");
    expect(refreshGuard.dirty).toBe(true);
    a();
    expect(refreshGuard.dirty).toBe(true); // still one outstanding
    b();
    expect(refreshGuard.dirty).toBe(false);
  });

  it("a release is idempotent (double-clear does not underflow)", () => {
    const release = refreshGuard.hold("x");
    release();
    release();
    expect(refreshGuard.dirty).toBe(false);
    // A fresh hold still registers dirty (no negative refcount left behind).
    refreshGuard.hold("y");
    expect(refreshGuard.dirty).toBe(true);
  });
});
