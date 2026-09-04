/**
 * The deferred-update dead zone (2026-09-04).
 *
 * After a new service worker activates, a lazy route this tab has never visited
 * 404s: its content-hashed chunk is gone from the server and was never in the
 * runtime cache. `recoverFromStaleChunk` returns true — recovery was REQUESTED —
 * so LazyRoute left `failed` false and fell through to a bare "Loading…". But
 * the reload it was relying on goes through `refreshGuard`, which HOLDS while
 * unsaved work exists (a completed recording, a selected file, an open draft),
 * and that work may live on a different screen entirely. The result was a route
 * that said "Loading…" forever, with no explanation and nothing to press.
 */
import { describe, it, expect } from "vitest";
import { classifyLoadFailure } from "./LazyRoute.svelte";

const STALE = new Error("Failed to fetch dynamically imported module: /_app/W3Bonw05.js");

describe("classifyLoadFailure", () => {
  it("distinguishes a HELD recovery from one that is actually reloading", () => {
    expect(
      classifyLoadFailure(STALE, { recover: () => true, refreshHeld: () => true }),
    ).toBe("deferred");
    expect(
      classifyLoadFailure(STALE, { recover: () => true, refreshHeld: () => false }),
    ).toBe("recovering");
  });

  it("still shows the error card when recovery is unavailable (offline, spent cooldown)", () => {
    expect(
      classifyLoadFailure(STALE, { recover: () => false, refreshHeld: () => false }),
    ).toBe("failed");
    // A held guard is irrelevant when no recovery was requested in the first
    // place: the user needs the Retry button, not an update notice.
    expect(
      classifyLoadFailure(STALE, { recover: () => false, refreshHeld: () => true }),
    ).toBe("failed");
  });

  it("routes an ordinary (non-stale-chunk) failure to the error card", () => {
    const network = new TypeError("NetworkError when attempting to fetch resource.");
    expect(
      classifyLoadFailure(network, { recover: () => false, refreshHeld: () => false }),
    ).toBe("failed");
  });
});
