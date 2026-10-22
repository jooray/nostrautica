/**
 * Audit R-84: the update watchdog computed "this tab is stuck on an old build"
 * and told only the console. This pins the banner state and the button's
 * action, which must actually move the tab (the plugin's updateSW(true) is a
 * no-op in autoUpdate mode) and must still respect unsaved work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  requestRefresh: vi.fn((apply: () => void) => apply()),
  purge: vi.fn(async () => {}),
}));
vi.mock("$lib/stores/refresh-guard.svelte.js", () => ({ refreshGuard: { requestRefresh: h.requestRefresh } }));
vi.mock("$lib/stale-chunk.js", () => ({ purgeServiceWorkerAndReload: h.purge }));

import { updateStuck, reloadToLatestBuild } from "./update-stuck.svelte.js";
import { updatePrompt } from "./update-prompt.svelte.js";

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.requestRefresh.mockClear();
  h.purge.mockClear();
  reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal("navigator", { onLine: true });
  updateStuck.set(null);
});
afterEach(() => vi.unstubAllGlobals());

describe("updateStuck banner state (R-84)", () => {
  it("shows for drift and registration failure, and clears once healthy", () => {
    expect(updateStuck.reason).toBeNull();
    updateStuck.set("drift");
    expect(updateStuck.reason).toBe("drift");
    updateStuck.set(null);
    expect(updateStuck.reason).toBeNull();
    updateStuck.set("register");
    expect(updateStuck.reason).toBe("register");
  });

  it("a dismissal hides the current episode but not a later one", () => {
    updateStuck.set("drift");
    updateStuck.dismiss();
    expect(updateStuck.reason).toBeNull();
    updateStuck.set("drift"); // same episode, still going: stays dismissed
    expect(updateStuck.reason).toBeNull();
    updateStuck.set(null);
    updateStuck.set("drift"); // a new episode
    expect(updateStuck.reason).toBe("drift");
  });
});

describe("reloadToLatestBuild (R-84)", () => {
  it("purges the worker and caches and reloads, through the refresh guard", () => {
    reloadToLatestBuild();
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect(h.purge).toHaveBeenCalledTimes(1);
  });

  it("waits for unsaved work like every other reload", () => {
    h.requestRefresh.mockImplementationOnce(() => {});
    reloadToLatestBuild();
    expect(h.purge).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("offline, reloads without purging (nothing to boot from otherwise)", () => {
    vi.stubGlobal("navigator", { onLine: false });
    reloadToLatestBuild();
    expect(h.purge).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the protocol 'please update' button does the same, not the inert updateSW(true)", () => {
    const updateSW = vi.fn();
    vi.stubGlobal("window", { location: { reload }, __nostrauticaUpdateSW: updateSW });
    updatePrompt.update();
    expect(updateSW).not.toHaveBeenCalled();
    expect(h.purge).toHaveBeenCalledTimes(1);
  });
});
