/**
 * Fresh-offline-launch shell readiness (audit R7): entry-asset discovery,
 * Cache-Storage verification, and the honest "won't cold-launch offline"
 * signals the offline pack relies on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  entryAssetUrls,
  verifyCached,
  hasServiceWorkerControl,
  ensureEntryShellCached,
} from "./offline-shell.js";

type El = { getAttribute: (k: string) => string | null };
const el = (attrs: Record<string, string>): El => ({ getAttribute: (k) => attrs[k] ?? null });

function makeDoc(opts: {
  scripts?: string[];
  styles?: string[];
  modulepreloads?: string[];
  other?: { rel: string; href: string }[];
}): Document {
  const scriptEls = (opts.scripts ?? []).map((src) => el({ src }));
  const linkEls = [
    ...(opts.styles ?? []).map((href) => el({ rel: "stylesheet", href })),
    ...(opts.modulepreloads ?? []).map((href) => el({ rel: "modulepreload", href })),
    ...(opts.other ?? []).map((o) => el({ rel: o.rel, href: o.href })),
  ];
  return {
    baseURI: "https://app.example/app/",
    querySelectorAll: (sel: string) =>
      (sel === "script[src]" ? scriptEls : sel === "link[href]" ? linkEls : []) as unknown as NodeListOf<Element>,
  } as unknown as Document;
}

afterEach(() => vi.unstubAllGlobals());

describe("entryAssetUrls", () => {
  it("collects only /_app/immutable/ scripts, stylesheets, and modulepreloads, absolutised", () => {
    const doc = makeDoc({
      scripts: ["/_app/immutable/entry/start.abc.js", "https://cdn.example/analytics.js"],
      styles: ["/_app/immutable/assets/app.def.css", "/theme.css"],
      modulepreloads: ["/_app/immutable/chunks/pre.ghi.js"],
      other: [{ rel: "icon", href: "/_app/immutable/should-not-count.png" }],
    });
    expect(entryAssetUrls(doc).sort()).toEqual(
      [
        "https://app.example/_app/immutable/entry/start.abc.js",
        "https://app.example/_app/immutable/assets/app.def.css",
        "https://app.example/_app/immutable/chunks/pre.ghi.js",
      ].sort(),
    );
  });

  it("returns [] with no document", () => {
    expect(entryAssetUrls(undefined)).toEqual([]);
  });
});

describe("verifyCached", () => {
  it("splits cached vs missing and only reports ok when all present", async () => {
    const present = new Set(["https://x/a.js"]);
    vi.stubGlobal("caches", {
      match: (u: string) => Promise.resolve(present.has(u) ? ({} as Response) : undefined),
    });
    const v = await verifyCached(["https://x/a.js", "https://x/b.js"]);
    expect(v.cached).toEqual(["https://x/a.js"]);
    expect(v.missing).toEqual(["https://x/b.js"]);
    expect(v.ok).toBe(false);

    present.add("https://x/b.js");
    expect((await verifyCached(["https://x/a.js", "https://x/b.js"])).ok).toBe(true);
  });

  it("is never ok for an empty URL set (can't claim unverified readiness)", async () => {
    vi.stubGlobal("caches", { match: () => Promise.resolve(undefined) });
    expect((await verifyCached([])).ok).toBe(false);
  });
});

describe("hasServiceWorkerControl", () => {
  it("false with no navigator", () => {
    expect(hasServiceWorkerControl()).toBe(false);
  });
  it("reflects navigator.serviceWorker.controller", () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    expect(hasServiceWorkerControl()).toBe(true);
    vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
    expect(hasServiceWorkerControl()).toBe(false);
  });
});

describe("ensureEntryShellCached", () => {
  it("is NOT ok when the page is uncontrolled (R7: no false readiness)", async () => {
    vi.stubGlobal("caches", { match: () => Promise.resolve(undefined) });
    const doc = makeDoc({ scripts: ["/_app/immutable/entry/start.abc.js"] });
    const r = await ensureEntryShellCached(doc);
    expect(r.controlled).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBe(1);
  });

  it("warms then verifies under a controller and reports ok when all cached (R7)", async () => {
    const cached = new Set<string>();
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    // A controlled fetch populates Cache Storage (modelled by adding to the set).
    vi.stubGlobal("fetch", (u: string) => {
      cached.add(u);
      return Promise.resolve({ ok: true, type: "basic" } as Response);
    });
    vi.stubGlobal("caches", {
      match: (u: string) => Promise.resolve(cached.has(u) ? ({} as Response) : undefined),
    });
    const doc = makeDoc({
      scripts: ["/_app/immutable/entry/start.abc.js"],
      styles: ["/_app/immutable/assets/app.def.css"],
    });
    const r = await ensureEntryShellCached(doc);
    expect(r.controlled).toBe(true);
    expect(r.total).toBe(2);
    expect(r.cached).toBe(2);
    expect(r.ok).toBe(true);
  });
});
