/**
 * The service-worker update WIRING in pwa.ts (audit SB-67). The helpers it uses
 * (ControllerLatch, UpdateHealth, the offline shell) have their own tests; this
 * pins the glue between them, which is the part that failed silently in
 * production on 2026-07-28: that the poll runs, that it fetches sw.js past the
 * HTTP cache, that the served body reaches the drift watchdog, that a waiting
 * worker is applied without a prompt, and that a new controller reloads the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type RegisterOptions = {
  immediate?: boolean;
  onRegisteredSW?: (swUrl: string, registration: unknown) => void;
  onRegisterError?: (error: unknown) => void;
  onNeedRefresh?: () => void;
  onNeedReload?: () => void;
};

const h = vi.hoisted(() => ({
  options: undefined as RegisterOptions | undefined,
  updateSW: vi.fn(async (_reload?: boolean) => {}),
  requestRefresh: vi.fn((apply: () => void) => apply()),
}));

vi.mock("virtual:pwa-register", () => ({
  registerSW: (opts: RegisterOptions) => {
    h.options = opts;
    return h.updateSW;
  },
}));
vi.mock("$lib/stores/install.svelte.js", () => ({ install: { init: () => {} } }));
vi.mock("$lib/stores/refresh-guard.svelte.js", () => ({ refreshGuard: { requestRefresh: h.requestRefresh } }));
vi.mock("$lib/router/route-modules.js", () => ({ warmRouteModules: async () => {}, CRITICAL_PARTICIPANT_ROUTES: [] }));
vi.mock("$lib/pwa/offline-shell.js", () => ({ ensureEntryShellCached: async () => {} }));

import { RELEASE_MANIFEST } from "$lib/release.js";

type Listener = () => void;
function target() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    fire: (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn()),
  };
}

let sw: ReturnType<typeof target> & { controller: unknown };
let win: ReturnType<typeof target> & { location: { reload: ReturnType<typeof vi.fn> } };
let fetchMock: ReturnType<typeof vi.fn>;
const SW_BODY = `precacheAndRoute([{url:"/index.html",revision:"${RELEASE_MANIFEST.swRevision}"}])`;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  h.options = undefined;
  h.updateSW.mockClear();
  h.requestRefresh.mockClear();
  sw = Object.assign(target(), { controller: null as unknown });
  win = Object.assign(target(), { location: { reload: vi.fn() } });
  fetchMock = vi.fn(async () => ({ text: async () => SW_BODY }));
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { serviceWorker: sw, onLine: true });
  vi.stubGlobal("document", Object.assign(target(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * UpdateHealth from the SAME module graph pwa.ts is about to load: each test
 * resets modules (pwa.ts keeps per-page state), so a statically imported class
 * would be a different one from the instance pwa.ts constructs.
 */
async function healthClass() {
  return (await import("$lib/pwa/update-health.js")).UpdateHealth;
}

async function registered() {
  const { registerPwa } = await import("./pwa.js");
  registerPwa();
  expect(h.options?.immediate).toBe(true);
  const registration = { update: vi.fn(async () => {}) };
  h.options!.onRegisteredSW!("/app/sw.js", registration);
  return registration;
}

describe("registerPwa update wiring (SB-67)", () => {
  it("polls every 60 s: fetches sw.js with cache: reload, feeds its body to the watchdog, then updates", async () => {
    const observe = vi.spyOn((await healthClass()).prototype, "observeServiceWorkerSource");
    const registration = await registered();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledWith("/app/sw.js", { cache: "reload" });
    expect(observe).toHaveBeenCalledWith(SW_BODY);
    expect(registration.update).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("checks again when the tab becomes visible and when the network returns", async () => {
    const registration = await registered();
    (document as unknown as ReturnType<typeof target>).fire("visibilitychange");
    win.fire("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  it("the watchdog compares against the per-commit swRevision, not the release label", async () => {
    // A served sw.js that names only the tag must not count as "ours": that is
    // the re-cut-release case SB-52 is about.
    const observe = vi.spyOn((await healthClass()).prototype, "observeServiceWorkerSource");
    await registered();
    await vi.advanceTimersByTimeAsync(60_000);
    const health = observe.mock.contexts[0] as unknown as { releaseId: string };
    expect(health.releaseId).toBe(RELEASE_MANIFEST.swRevision);
    expect(RELEASE_MANIFEST.swRevision).not.toBe("");
  });

  it("a failed check while online is reported, not swallowed", async () => {
    const failed = vi.spyOn((await healthClass()).prototype, "noteCheckFailed");
    fetchMock.mockRejectedValueOnce(new Error("proxy ate it"));
    await registered();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledWith(expect.any(Error), true);
  });

  it("applies a waiting worker immediately: no prompt", async () => {
    await registered();
    h.options!.onNeedRefresh!();
    expect(h.updateSW).toHaveBeenCalledWith(true);
  });

  it("reloads on a new controller, but not on the first install's claim", async () => {
    await registered(); // page started uncontrolled
    sw.fire("controllerchange"); // first install claiming the page
    expect(win.location.reload).not.toHaveBeenCalled();
    sw.fire("controllerchange"); // a real update took control
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("the plugin's own post-activation reload goes through the guard (R-34)", async () => {
    // Without onNeedReload the plugin calls window.location.reload() directly.
    await registered();
    expect(h.options!.onNeedReload).toBeTypeOf("function");
    h.requestRefresh.mockImplementationOnce(() => {}); // unsaved work: guard defers
    h.options!.onNeedReload!();
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect(win.location.reload).not.toHaveBeenCalled();
    // …and once the guard applies it, the tab does reload: never stuck.
    h.requestRefresh.mock.calls[0]![0]();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("a registration error is recorded, so the dead updater is visible", async () => {
    const noted = vi.spyOn((await healthClass()).prototype, "noteRegisterFailed");
    const { registerPwa } = await import("./pwa.js");
    registerPwa();
    const err = new Error("blocked");
    h.options!.onRegisterError!(err);
    expect(noted).toHaveBeenCalledWith(err);
  });
});
