/**
 * Offline event pack (spec §13). One tap pre-downloads and persists everything an
 * attendee needs at a venue with no signal — roster, directory entries, matches,
 * talk metadata, and profile/thumbnail metadata — by running the existing fetchers
 * (which all write-through the SWR cache layer) and then asking the browser for
 * persistent storage so mobile browsers are less likely to evict mid-event.
 *
 * Media blobs (audio/video) are NOT downloaded here — only their descriptors and
 * profile thumbnails ride the cache; the pack reports this so the UI can say so.
 * The step/completeness derivation is pure and unit-tested.
 */
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { fetchRoster, fetchDirectory, fetchMatches } from "./attendee.js";
import { fetchTalks } from "./talks.js";
import { fetchProfiles } from "./social.js";
import { fetchEventPage } from "./event-page.js";
import { fetchEventPosts } from "./posts.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { warmRouteModules, PARTICIPANT_OFFLINE_ROUTES } from "$lib/router/route-modules.js";
import { ensureEntryShellCached, hasServiceWorkerControl } from "$lib/pwa/offline-shell.js";

export type PackStepKey =
  | "roster"
  | "directory"
  | "matches"
  | "talks"
  | "profiles"
  | "page"
  | "shell"
  | "modules";

export interface PackStep {
  key: PackStepKey;
  /** Completed successfully (or was legitimately empty). */
  ok: boolean;
  /** How many records the step cached (attendees, entries, matches, …). */
  count: number;
  /** Step doesn't apply to this event (no coordinator / talks off). */
  skipped?: boolean;
}

export interface OfflinePack {
  at: number;
  steps: PackStep[];
  /** Media blobs were not downloaded (descriptors/thumbnails only). */
  mediaSkipped: boolean;
  /**
   * True when a service worker controlled the page while the pack was built
   * (audit R7). Without a controller the app-code (shell + route chunks) can't be
   * durably cached, so the pack is NOT a real offline pack — the UI must say the
   * screens themselves may not open offline even though the data was cached.
   */
  swControlled?: boolean;
}

export interface PackOutcome {
  pack: OfflinePack;
  /** navigator.storage.persist() result (best-effort; false when unavailable). */
  persisted: boolean;
  estimate?: StorageEstimate;
}

function packKey(coordinate: string): string {
  return `offlinepack:${coordinate}`;
}

/** The last offline pack recorded for this coordinate (no network), or undefined. */
export function cachedOfflinePack(coordinate: string): OfflinePack | undefined {
  return cacheGet<OfflinePack>(packKey(coordinate))?.data;
}

/**
 * True when every applicable (non-skipped) step of the pack succeeded AND a
 * service worker controlled the build (audit R7): without a controller the
 * app-code steps can't have durably cached, so the pack is never "complete".
 */
export function packComplete(pack: OfflinePack): boolean {
  if (pack.swControlled === false) return false;
  return pack.steps.filter((s) => !s.skipped).every((s) => s.ok);
}

/** Human-readable byte size (KB/MB/GB), for the storage estimate line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Best-effort persistent-storage request (once). False when unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function storageEstimate(): Promise<StorageEstimate | undefined> {
  try {
    return await navigator.storage?.estimate?.();
  } catch {
    return undefined;
  }
}

/**
 * Download + persist the offline pack for an event. Each step runs the existing
 * fetcher (which caches its result) and reports success/count; a failed step is
 * recorded (ok:false) rather than aborting the whole pack, so a partial pack is
 * still useful and re-runnable. Calls `onProgress` after each step.
 */
export async function buildOfflinePack(
  ctx: EventContext,
  signer: AppSigner | null,
  onProgress?: (steps: PackStep[]) => void,
): Promise<PackOutcome> {
  const steps: PackStep[] = [];
  const record = (s: PackStep) => {
    steps.push(s);
    onProgress?.([...steps]);
  };

  const run = async (
    key: PackStepKey,
    skipped: boolean,
    fn: () => Promise<number>,
  ): Promise<void> => {
    if (skipped) return record({ key, ok: true, count: 0, skipped: true });
    try {
      record({ key, ok: true, count: await fn() });
    } catch {
      record({ key, ok: false, count: 0 });
    }
  };

  await run("roster", false, async () => (await fetchRoster(ctx))?.attendees.length ?? 0);
  let directoryPubkeys: string[] = [];
  await run("directory", false, async () => {
    const dir = await fetchDirectory(ctx);
    directoryPubkeys = dir.map((e) => e.pubkey);
    return dir.length;
  });
  await run("matches", !(ctx.config.coordinator && signer), async () =>
    (await fetchMatches(signer!, ctx))?.matches.length ?? 0,
  );
  await run("talks", ctx.config.talks === "off", async () => (await fetchTalks(ctx)).length);
  await run("profiles", directoryPubkeys.length === 0, async () =>
    (await fetchProfiles(directoryPubkeys)).size,
  );
  await run("page", false, async () => {
    await Promise.all([fetchEventPage(ctx), fetchEventPosts(ctx)]);
    return 1;
  });
  // Entry SHELL (audit R7): the app's own entry JS/CSS aren't precached, so a
  // cold offline launch would serve the precached index.html and then 404 its
  // scripts. Warm them under the controller and VERIFY they're actually in Cache
  // Storage — this step fails (ok:false) when no SW controls the page or an asset
  // is missing, so the pack never claims offline-readiness it can't back up.
  const controlled = hasServiceWorkerControl();
  await run("shell", false, async () => {
    const readiness = await ensureEntryShellCached();
    if (!readiness.ok) {
      throw new Error(
        readiness.controlled
          ? "entry shell assets are not all in Cache Storage yet"
          : "no service worker controls the page — app code can't be cached offline",
      );
    }
    return readiness.cached;
  });
  // Route MODULES (audit U7/R7): fetching the data isn't enough — the lazy route
  // chunks (Talks, Talk Detail, Record, My Profile, Posts/Post) are absent
  // offline until visited online, so the pack imports each one it promises,
  // landing them in the SW runtime cache. Requires a controller first (an import
  // that resolves off the network/HTTP cache without a controlling SW is NOT
  // durably cached — the false readiness R7 flags). `ok:false` otherwise, so
  // `packComplete` reports the pack as partial and the UI says screens may need a
  // reconnect.
  await run("modules", false, async () => {
    if (!controlled) {
      throw new Error("no service worker control — route chunks can't be cached offline");
    }
    const warmed = await warmRouteModules(PARTICIPANT_OFFLINE_ROUTES);
    if (warmed < PARTICIPANT_OFFLINE_ROUTES.length) {
      throw new Error("some route modules could not be warmed");
    }
    return warmed;
  });

  const pack: OfflinePack = {
    at: Math.floor(Date.now() / 1000),
    steps,
    mediaSkipped: true,
    swControlled: controlled,
  };
  cacheSet(packKey(ctx.coordinate), pack, pack.at);

  const persisted = await requestPersistentStorage();
  const estimate = await storageEstimate();
  return { pack, persisted, estimate };
}
