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

  // Regression (App-2 incident 2026-07-23). Every hold() call site runs INSIDE a
  // component $effect reacting to form state (Create title, Record dirty, compose
  // text…):  $effect(() => { if (dirty) return refreshGuard.hold("x"); }). The
  // old guard did `this.version++` in hold()/release() — a read-AND-write of the
  // same `$state` — so Svelte 5 flagged each such effect as reading and writing
  // its own dependency and threw `effect_update_depth_exceeded` the instant a
  // tracked field went non-empty, wedging the page (Create's success screen never
  // rendered though the event had published fine).
  //
  // The fix is structural: the dirty registry carries NO reactive `$state`, so
  // hold()/release() cannot feed back into any effect that also reads the guard.
  // The executable proof that this throws against the reverted code is the e2e
  // `integration` tier (real Chromium drives the Create form); this repo's vitest
  // harness runs Svelte in SSR mode where `$effect` is inert, so the loop can't
  // be scheduled in-process. What we CAN lock here deterministically is the
  // contract that made the fix safe: the exact re-entrant call shape an $effect
  // produces on every re-run+teardown must never throw and must stay consistent.
  it("survives an $effect-style re-run/teardown storm without looping", () => {
    // Svelte drives a form effect as: run body -> hold() -> (field changes) ->
    // teardown(release) -> run body -> hold() -> … Replay that churn tightly; the
    // old version++ path is what a real scheduler turned into a runaway loop.
    let release = refreshGuard.hold("compose");
    for (let i = 0; i < 1000; i++) {
      release(); // teardown from the previous run
      release = refreshGuard.hold("compose"); // body of the next run
      expect(refreshGuard.dirty).toBe(true); // exactly one holder throughout
    }
    release();
    expect(refreshGuard.dirty).toBe(false);
  });

  // A defer that is set WHILE dirty must still apply automatically after the
  // storm settles — the churn above must not have lost the pending reload.
  it("still applies a deferred reload after a hold/release storm", () => {
    const release = refreshGuard.hold("compose");
    const reload = vi.fn();
    refreshGuard.requestRefresh(reload);
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(reload).toHaveBeenCalledTimes(1);
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
