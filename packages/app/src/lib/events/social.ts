/**
 * Social overlay (spec §8, §5.4). "You already follow" / "follows you" badges from
 * the user's kind-3 ∩ roster, plus a person's recent public notes for the profile
 * view. No full thread rendering in v1.
 */
import { KIND_CONTACTS, KIND_NOTE, KIND_PROFILE } from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { fetchFollowTags } from "./nostr-actions.js";

export interface ProfileMeta {
  name?: string;
  picture?: string;
  about?: string;
}

// Session-lifetime kind-0 cache so a profile fetched once (roster, matches,
// prefetch) paints instantly everywhere it's needed next — the app re-reads the
// same handful of pubkeys across People/Matches/attendee pages. Latest write
// wins; a background refetch simply overwrites (user feedback 2026-07-17:
// "everything should be snappier / cached ASAP").
const profileCache = new Map<string, ProfileMeta>();

/** Cached kind-0s for these pubkeys (no network) — for cache-first paint. */
export function cachedProfiles(pubkeys: string[]): Map<string, ProfileMeta> {
  const out = new Map<string, ProfileMeta>();
  for (const p of pubkeys) {
    const hit = profileCache.get(p);
    if (hit) out.set(p, hit);
  }
  return out;
}

/** Batch-fetch kind-0 profiles for a set of pubkeys → map of latest per pubkey. */
export async function fetchProfiles(
  pubkeys: string[],
): Promise<Map<string, ProfileMeta>> {
  const out = new Map<string, ProfileMeta>();
  if (pubkeys.length === 0) return out;
  const events = await fetchEvents({ kinds: [KIND_PROFILE], authors: pubkeys });
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
      profileCache.set(pubkey, meta);
    } catch {
      /* skip malformed profile */
    }
  }
  return out;
}

/** The set of pubkeys the signed-in user follows (from their kind-3). */
export async function fetchFollowSet(signer: AppSigner): Promise<Set<string>> {
  const tags = await fetchFollowTags(signer);
  return new Set(tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string));
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
