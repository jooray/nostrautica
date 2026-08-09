/**
 * Social overlay (spec §8, §5.4). "You already follow" / "follows you" badges from
 * the user's kind-3 ∩ roster, plus a person's recent public notes for the profile
 * view. No full thread rendering in v1.
 */
import { KIND_CONTACTS, KIND_NOTE, KIND_PROFILE } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { streamEvents } from "$lib/nostr/stream.js";
import { fetchFollowTags } from "./nostr-actions.js";
import { cacheGet, cacheSet, ANON } from "$lib/cache/persist.js";
import { swr } from "$lib/cache/swr.js";

export interface ProfileMeta {
  name?: string;
  picture?: string;
  about?: string;
}

// kind-0 profiles are public, so they cache under the anon scope and now SURVIVE
// RELOADS (CACHING-PLAN §2.2): a profile fetched once (roster, matches, prefetch)
// paints instantly everywhere it's needed next, across sessions. Per-pubkey entry
// keyed `profile:<pubkey>`, `at` = the kind-0's created_at (latest-wins).
function profileKey(pubkey: string): string {
  return `profile:${pubkey}`;
}
// Re-fetch a cached profile only when it's older than this (§2.2): kind-0s change
// rarely, so most People/Matches paints skip relays entirely.
const PROFILE_TTL_SEC = 10 * 60;

/**
 * Avatar props (name + picture) for a pubkey, resolved from a profile map, for
 * any card/header that shows a person's avatar (People rows, talk cards, the talk
 * detail header). The `picture` is always carried through when the map has it —
 * the talk surfaces previously dropped it and fell back to bare initials, which,
 * when the author was the viewer, looked identical to the More tab's own avatar
 * (Bug 3). Missing fields leave `<Avatar>` to render its initials placeholder.
 */
export function avatarInfo(
  pubkey: string,
  profiles: Map<string, ProfileMeta>,
): { name?: string; picture?: string } {
  const p = profiles.get(pubkey);
  return { name: p?.name, picture: p?.picture };
}

/** Cached kind-0s for these pubkeys (no network) — for cache-first paint. */
export function cachedProfiles(pubkeys: string[]): Map<string, ProfileMeta> {
  const out = new Map<string, ProfileMeta>();
  for (const p of pubkeys) {
    const hit = cacheGet<ProfileMeta>(profileKey(p), ANON);
    if (hit) out.set(p, hit.data);
  }
  return out;
}

/**
 * Batch-fetch kind-0 profiles for a set of pubkeys → map of latest per pubkey.
 * Cache-first: only pubkeys MISSING or older than 10 min hit relays (§2.2); the
 * returned map always merges the cached entries with any freshly fetched ones.
 * Pass `{ force: true }` to bypass the freshness check (explicit refresh).
 */
export async function fetchProfiles(
  pubkeys: string[],
  opts: { force?: boolean } = {},
): Promise<Map<string, ProfileMeta>> {
  const out = new Map<string, ProfileMeta>();
  if (pubkeys.length === 0) return out;

  const nowSec = Math.floor(Date.now() / 1000);
  const stale: string[] = [];
  for (const p of pubkeys) {
    const hit = cacheGet<ProfileMeta>(profileKey(p), ANON);
    if (hit) out.set(p, hit.data);
    if (opts.force || !hit || nowSec - hit.at > PROFILE_TTL_SEC) stale.push(p);
  }
  if (stale.length === 0) return out;

  // streamEvents, not fetchEvents: (a) same single-relay EOSE stall as coordinator
  // discovery — fetchEvents hangs on a 1-relay stack; (b) fetchEvents' dexie-cache/EOSE
  // race can resolve before a just-arrived kind-0 is surfaced (see ndk.ts
  // fetchEventsRelayOnly), which left blank attendee names in the verification pass.
  // NOT relay-only: the dexie cache is a legitimate fast source for public profiles,
  // and streamEvents includes cache results while still terminating on the hard timeout.
  const events = await streamEvents(
    { kinds: [KIND_PROFILE], authors: stale },
    { timeoutMs: 8000 },
  ).ready;
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const prev = latest.get(e.pubkey);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latest.set(e.pubkey, e);
  }
  for (const [pubkey, e] of latest) {
    try {
      const p = JSON.parse(e.content);
      const meta = { name: p.name || p.display_name, picture: p.picture, about: p.about };
      out.set(pubkey, meta);
      cacheSet(profileKey(pubkey), meta, e.created_at ?? nowSec, ANON);
    } catch {
      /* skip malformed profile */
    }
  }
  return out;
}

// The signed-in user's follow set (kind-3 p-tags) is cached per owner (`follows`)
// so People "you already follow" badges paint instantly (§2.2).
const FOLLOWS_KEY = "follows";

/** Cached follow set for the active owner (no network), or undefined. */
export function cachedFollowSet(): Set<string> | undefined {
  const hit = cacheGet<string[]>(FOLLOWS_KEY);
  return hit ? new Set(hit.data) : undefined;
}

/**
 * The set of pubkeys the signed-in user follows (from their kind-3), SWR: paints
 * the cached set immediately via `apply` (if given), refreshes in the background.
 * Returns the fresh (or cached) set. NOTE: `followUser`'s fetch-merge-write MUST
 * still fetch fresh kind-3 from relays before publishing (§2.2, HARD CONSTRAINT 4)
 * — it must never merge into this cached copy.
 */
export async function fetchFollowSet(
  signer: AppSigner,
  apply?: (set: Set<string>) => void,
): Promise<Set<string>> {
  const owner = await signer.getPublicKey();
  const fresh = await swr<string[]>(
    FOLLOWS_KEY,
    async () => {
      const tags = await fetchFollowTags(signer);
      return tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string);
    },
    (list) => apply?.(new Set(list)),
    { scope: owner },
  );
  return new Set(fresh ?? []);
}

/**
 * Reflect a just-published follow/unfollow in the CACHED set (paint layer only).
 *
 * Without this the SWR entry keeps the pre-toggle list until the next
 * `fetchFollowSet`, so leaving People and coming back repaints the badge the
 * user just changed — the toggle looks like it silently reverted.
 *
 * Cache-only on purpose. The authoritative write is the kind-3 publish in
 * `followUser`/`unfollowUser`, which re-fetches from relays first and must never
 * merge into this copy (§2.2, HARD CONSTRAINT 4).
 */
export function noteFollowChange(pubkey: string, following: boolean): void {
  const current = new Set(cacheGet<string[]>(FOLLOWS_KEY)?.data ?? []);
  if (following) current.add(pubkey);
  else current.delete(pubkey);
  cacheSet(FOLLOWS_KEY, [...current]);
}

/** The set of pubkeys (among `candidates`) who follow `me` (kind-3 p-tagging me). */
export async function fetchFollowersOf(
  me: string,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const events = await fetchEvents({ kinds: [KIND_CONTACTS], authors: candidates, "#p": [me] });
  // Keep only the latest kind-3 per author, then confirm it still p-tags me.
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const prev = latest.get(e.pubkey);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latest.set(e.pubkey, e);
  }
  const followers = new Set<string>();
  for (const [author, e] of latest) {
    if (e.tags.some((t) => t[0] === "p" && t[1] === me)) followers.add(author);
  }
  return followers;
}

export interface RecentPost {
  id: string;
  content: string;
  created_at: number;
  tags: string[][];
}

/** Fetch a person's recent public notes (kind 1), newest first. */
export async function fetchRecentPosts(pubkey: string, limit = 20): Promise<RecentPost[]> {
  const events = await fetchEvents({ kinds: [KIND_NOTE], authors: [pubkey], limit });
  return events
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, limit)
    .map((e) => ({ id: e.id, content: e.content, created_at: e.created_at ?? 0, tags: e.tags }));
}
