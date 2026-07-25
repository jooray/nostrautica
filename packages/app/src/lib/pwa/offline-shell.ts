/**
 * Fresh-offline-launch readiness for the app SHELL (audit R7).
 *
 * The service worker precaches the shell `index.html` and static assets, but the
 * entry JS/CSS chunks it references are NOT precached — they are runtime-cached
 * (CacheFirst on `/_app/immutable/`, see vite.config.ts) only the first time a
 * CONTROLLING service worker fetches them. On the very first visit the entry
 * modules load BEFORE the worker controls the page, so they never enter Cache
 * Storage, and a later cold offline launch serves the precached HTML but then
 * 404s its entry scripts — a blank screen.
 *
 * This module closes that gap without precaching every chunk (the deliberate
 * payload-size decision): once a controller exists we re-`fetch()` the shell's
 * own entry assets so the SW's CacheFirst rule stores them, then VERIFY each is
 * actually present in Cache Storage. Verification is what the offline pack needs
 * to report readiness honestly instead of trusting that a JS import "worked"
 * (which succeeds off the network/HTTP cache even when nothing durable landed).
 *
 * Everything here is best-effort and SSR/test-safe: no `document`, `caches`, or
 * controller ⇒ honest empty/false results, never a throw.
 */

/** True when a service worker currently controls this page (fetches are cached). */
export function hasServiceWorkerControl(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;
}

/**
 * The content-hashed entry JS/CSS the shell HTML references — every `<script
 * src>` / `<link href>` (stylesheet, modulepreload, preload) under
 * `/_app/immutable/`. These are the assets a cold offline launch needs in Cache
 * Storage after the precached `index.html` boots. `doc` is injectable for tests.
 */
export function entryAssetUrls(doc: Document | undefined = globalThisDocument()): string[] {
  if (!doc) return [];
  const urls = new Set<string>();
  const add = (v: string | null | undefined) => {
    if (v && v.includes("/_app/immutable/")) {
      try {
        urls.add(new URL(v, doc.baseURI).href);
      } catch {
        /* unparseable — skip */
      }
    }
  };
  doc.querySelectorAll("script[src]").forEach((el) => add(el.getAttribute("src")));
  doc.querySelectorAll("link[href]").forEach((el) => {
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    if (rel === "stylesheet" || rel === "modulepreload" || rel === "preload") {
      add(el.getAttribute("href"));
    }
  });
  return [...urls];
}

function globalThisDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

/**
 * Fetch each URL so a controlling SW's CacheFirst rule stores it. No-op (returns
 * 0) when no controller exists — an uncontrolled fetch would not be cached, so
 * pretending otherwise is exactly the false readiness R7 is about. Best-effort:
 * a failed fetch (offline mid-warm) is counted as not-warmed, never thrown.
 */
export async function warmUrls(urls: readonly string[]): Promise<number> {
  if (!hasServiceWorkerControl() || typeof fetch === "undefined") return 0;
  let ok = 0;
  await Promise.all(
    urls.map((u) =>
      fetch(u, { credentials: "same-origin" }).then(
        (r) => {
          if (r.ok || r.type === "opaque") ok++;
        },
        () => {},
      ),
    ),
  );
  return ok;
}

export interface CacheVerification {
  /** URLs actually present in Cache Storage right now. */
  cached: string[];
  /** URLs promised but NOT found in any cache. */
  missing: string[];
  /** True when every promised URL is durably cached (empty input ⇒ false: we
   *  cannot claim readiness we never verified). */
  ok: boolean;
}

/** Verify each URL is present in Cache Storage (`caches.match`). */
export async function verifyCached(urls: readonly string[]): Promise<CacheVerification> {
  const cached: string[] = [];
  const missing: string[] = [];
  const cacheApi = typeof caches !== "undefined" ? caches : undefined;
  for (const u of urls) {
    let hit = false;
    if (cacheApi) {
      try {
        hit = !!(await cacheApi.match(u));
      } catch {
        hit = false;
      }
    }
    (hit ? cached : missing).push(u);
  }
  return { cached, missing, ok: urls.length > 0 && missing.length === 0 };
}

export interface ShellReadiness {
  /** A controller is present, so runtime caching is actually in effect. */
  controlled: boolean;
  /** Entry assets discovered in the shell HTML. */
  total: number;
  /** Entry assets confirmed present in Cache Storage. */
  cached: number;
  /** Entry assets still missing from Cache Storage. */
  missing: string[];
  /** True only when controlled AND every entry asset is durably cached — the
   *  honest "this app will cold-launch offline" signal (R7). */
  ok: boolean;
}

/**
 * Warm and then VERIFY the shell's entry assets are in Cache Storage. Returns an
 * honest readiness snapshot — never "ready" when uncontrolled or when an asset
 * is missing, so the offline pack can surface an unverifiable state instead of a
 * false green.
 */
export async function ensureEntryShellCached(
  doc: Document | undefined = globalThisDocument(),
): Promise<ShellReadiness> {
  const controlled = hasServiceWorkerControl();
  const urls = entryAssetUrls(doc);
  if (controlled) await warmUrls(urls);
  const { cached, missing } = await verifyCached(urls);
  return {
    controlled,
    total: urls.length,
    cached: cached.length,
    missing,
    ok: controlled && urls.length > 0 && missing.length === 0,
  };
}
