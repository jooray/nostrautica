/**
 * Watchdog for the service-worker update path (spec §10.2).
 *
 * The update mechanism is the one subsystem in this app whose failures are
 * BOTH invisible and long-lived. `registerSW`'s `onRegisterError` was never
 * passed, so a registration that threw left the app with no polling for the
 * page's lifetime and nothing in the console; `check()`'s catch was empty, so
 * every failed update poll — a proxy eating the request, a 404 on `sw.js`, a
 * CSP change — looked exactly like a healthy check. The prod incident of
 * 2026-07-28 (nginx serving `/app/sw.js` with `expires 1d`, so browsers answered
 * their own update check from cache for up to 24 h) ran for days before anyone
 * noticed, and the only symptom was users being on an old build.
 *
 * This module holds the parts that are worth testing without the
 * `virtual:pwa-register` import: what counts as drift, how long silence is
 * allowed to last, and what gets logged. `pwa.ts` owns the wiring.
 */

/**
 * How many consecutive checks may disagree with our own release before we say
 * so. One disagreement is normal and expected: it is precisely what a pending
 * deploy looks like in the seconds between `sw.js` changing on the server and
 * the new worker taking control. Three in a row (i.e. ≥2 minutes at the 60 s
 * poll) is not a deploy in progress, it is a client that cannot move.
 */
export const DRIFT_WARN_AFTER = 3;

/**
 * How long the update path may go without a single successful check before it
 * is called out. Ten poll intervals: long enough that a phone in a tunnel or a
 * laptop asleep on a train never trips it, short enough that a genuinely dead
 * checker is named within the same session it broke.
 */
export const SILENCE_WARN_MS = 10 * 60_000;

/**
 * The revision a served `sw.js` stamps on its precached `index.html` (see
 * vite.config.ts), i.e. which build the server is actually handing out. Used to
 * latch the automatic recovery once per served build. "unknown" when the body
 * carries none (an error page, a proxy's answer), which still latches once.
 */
export function servedRevision(source: string): string {
  return /index\.html"\s*,\s*"?revision"?\s*:\s*"([^"]+)"/.exec(source)?.[1] ?? "unknown";
}

/**
 * What an update check fetched for `sw.js`: a real service worker (with the
 * revision it serves), or something else that must not be read as drift.
 */
export type ServedWorker =
  | { ok: true; source: string; revision: string }
  | { ok: false; reason: string };

/**
 * Accept a fetched `sw.js` only when it IS one (audit KIMIK31 W-9). The check
 * used to feed any body to the drift watchdog: a 404 or 503 page, or a venue
 * captive portal answering HTTP 200 with its login page, never mentions our
 * release, so three of them in a row read as "stuck on an old build" and drove
 * the automatic purge-and-reload, wiping the offline shell at exactly the place
 * with no network to rebuild it from. A real `sw.js` from any of our builds
 * stamps a revision on its precached index.html; a body without one is a failed
 * check, not a stale deploy. A real stale deploy (an old sw.js, with its old
 * revision) still passes here and still recovers, once per revision (R-84).
 */
export function readServedWorker(
  res: { ok: boolean; status: number },
  source: string,
): ServedWorker {
  if (!res.ok) return { ok: false, reason: `sw.js answered HTTP ${res.status}` };
  const revision = servedRevision(source);
  if (revision === "unknown") {
    return {
      ok: false,
      reason: "sw.js answered with something that is not a service worker (an error or captive-portal page?)",
    };
  }
  return { ok: true, source, revision };
}

type Log = (...args: unknown[]) => void;

/**
 * Tracks whether the served service worker matches the bundle we are running,
 * and whether the update check is running at all. Every method is safe to call
 * from a `catch`.
 */
export class UpdateHealth {
  private driftMisses = 0;
  private driftWarned = false;
  private silenceWarned = false;
  private registerFailed = false;
  private lastOkAt: number;

  constructor(
    /**
     * This bundle's `RELEASE_MANIFEST.swRevision`: the `revision` the build
     * stamps on the precached `index.html` entry (see vite.config.ts), so a
     * served `sw.js` built from the same commit contains it verbatim. Not
     * `releaseId`: on a tagged commit that is the bare tag name, which another
     * commit re-cut under the same tag would also contain (audit SB-52). The
     * fallback "dev" id (and any empty id) disables drift checking entirely —
     * matching a three-letter string against a whole bundle would be noise.
     */
    private readonly releaseId: string,
    private readonly warn: Log = console.warn,
    private readonly now: () => number = Date.now,
  ) {
    this.lastOkAt = this.now();
  }

  /** True when drift comparison is meaningful for this build. */
  get comparable(): boolean {
    return !!this.releaseId && this.releaseId !== "dev" && this.releaseId !== "unknown";
  }

  /**
   * Feed the body of the `sw.js` we just fetched. Returns true when a SUSTAINED
   * divergence was reported by this call (once per divergence episode, so a
   * wedged client logs one line rather than one per minute).
   */
  observeServiceWorkerSource(source: string): boolean {
    this.noteCheckSucceeded();
    if (!this.comparable) return false;
    if (source.includes(this.releaseId)) {
      this.driftMisses = 0;
      this.driftWarned = false;
      return false;
    }
    this.driftMisses++;
    if (this.driftMisses < DRIFT_WARN_AFTER || this.driftWarned) return false;
    this.driftWarned = true;
    this.warn(
      `[pwa] the served service worker has not matched this bundle (release ${this.releaseId}) ` +
        `for ${this.driftMisses} consecutive checks. Either sw.js is being answered from a stale ` +
        `cache/proxy, or the new worker cannot activate — this tab will stay on the old build.`,
    );
    return true;
  }

  /** A check completed. Resets the silence watchdog. */
  noteCheckSucceeded(): void {
    this.lastOkAt = this.now();
    this.silenceWarned = false;
  }

  /**
   * A check threw. Offline is normal and stays at debug level in the caller;
   * this only records that no successful check has happened, and warns once the
   * silence has gone on long enough to matter.
   */
  noteCheckFailed(reason: unknown, online: boolean): void {
    if (!online) return; // no network, no news — the next `online` event retries
    this.warn("[pwa] update check failed while online:", reason);
    this.warnIfSilent();
  }

  /** Registration itself failed: nothing will poll for this page's lifetime. */
  noteRegisterFailed(reason: unknown): void {
    this.registerFailed = true;
    this.warn(
      "[pwa] service worker registration FAILED — no update checks will run in this tab, " +
        "and offline support is unavailable until the next reload:",
      reason,
    );
  }

  get registrationFailed(): boolean {
    return this.registerFailed;
  }

  /** True while a sustained sw.js drift is in progress (from the warning until a match). */
  get driftDetected(): boolean {
    return this.driftWarned;
  }

  /** Warn (once per silent stretch) when no check has succeeded in a long time. */
  warnIfSilent(): boolean {
    const silentFor = this.now() - this.lastOkAt;
    if (silentFor < SILENCE_WARN_MS || this.silenceWarned) return false;
    this.silenceWarned = true;
    this.warn(
      `[pwa] no successful update check for ${Math.round(silentFor / 1000)}s while online — ` +
        "this tab may never pick up a new deploy.",
    );
    return true;
  }
}
