/**
 * Code-split route module loaders — the SINGLE source of truth for the app's
 * lazy route chunks (audit U7). Both the catch-all page (`routes/+page.svelte`)
 * and the offline warmers import from here, so the offline pack warms the EXACT
 * chunk a route later loads (same import specifier ⇒ same content-hashed URL),
 * and the module-warming list can be unit-tested against the route registry.
 *
 * Why this matters: JS/CSS chunks are NOT precached (they're runtime-cached the
 * first time a controlling service worker fetches them, see vite.config.ts). So
 * a lazy route the attendee never visited online is simply absent offline — the
 * offline pack could fetch all the DATA and still fail to OPEN Talks. Warming
 * imports the module, which the SW's CacheFirst rule then stores.
 */

/**
 * Loader per lazy (code-split) route name. Eager participant routes (home,
 * event, join, attendees, attendee, matches, me, eventMore) ride the entry
 * chunk and are always present, so they are not listed here.
 */
export const lazyRouteLoaders = {
  create: () => import("$lib/pages/Create.svelte"),
  settings: () => import("$lib/pages/Settings.svelte"),
  record: () => import("$lib/pages/Record.svelte"),
  chat: () => import("$lib/pages/EventChat.svelte"),
  talks: () => import("$lib/pages/Talks.svelte"),
  talk: () => import("$lib/pages/TalkDetail.svelte"),
  myProfile: () => import("$lib/pages/MyProfile.svelte"),
  admin: () => import("$lib/pages/Admin.svelte"),
  eventSettings: () => import("$lib/pages/EventSettings.svelte"),
  posts: () => import("$lib/pages/Posts.svelte"),
  report: () => import("$lib/pages/Report.svelte"),
  post: () => import("$lib/pages/Post.svelte"),
  dm: () => import("$lib/pages/Dm.svelte"),
  dmPeer: () => import("$lib/pages/DmChat.svelte"),
} satisfies Record<string, () => Promise<unknown>>;

export type LazyRouteName = keyof typeof lazyRouteLoaders;

/**
 * The participant-facing lazy routes the offline pack promises an attendee at a
 * venue with no signal (audit U7): Talks + Talk Detail (the pack downloads talk
 * data), Record (submit an intro/talk), My Profile, and event Posts/Post.
 * Organizer (admin/settings), global settings, chat, and DM routes are
 * intentionally excluded — the offline pack is a participant affordance.
 */
export const PARTICIPANT_OFFLINE_ROUTES: LazyRouteName[] = [
  "talks",
  "talk",
  "record",
  "myProfile",
  "posts",
  "post",
];

/**
 * The smallest set worth warming proactively right after the service worker is
 * in control (audit U7): the participant lazy routes most likely to be opened
 * offline first. A subset of PARTICIPANT_OFFLINE_ROUTES so a boot warm stays
 * cheap; the offline pack warms the full set on demand.
 */
export const CRITICAL_PARTICIPANT_ROUTES: LazyRouteName[] = ["record", "talks", "talk"];

/**
 * Import (warm) the given route modules so their chunks land in the SW runtime
 * cache. Resolves with the count that loaded successfully; a failed import
 * (offline before the chunk was ever cached) is counted as not-ready rather than
 * thrown, so a partial warm never rejects.
 */
export async function warmRouteModules(names: readonly LazyRouteName[]): Promise<number> {
  let ok = 0;
  await Promise.all(
    names.map((n) =>
      lazyRouteLoaders[n]().then(
        () => {
          ok++;
        },
        () => {
          /* chunk unreachable (offline, never cached) — counted as not ready */
        },
      ),
    ),
  );
  return ok;
}
