/**
 * Event posts (spec §7.4): the unified blog feed behind `#/e/:naddr/posts`.
 *
 * Two visibility levels, fixed at creation:
 *  - public → kind 30023 signed by E_id (see updates.ts — same events)
 *  - members-only → kind 31607, ALL metadata inside the ECK ciphertext,
 *    random stable `d`, `eck` tag naming the key version used.
 *
 * Readers pick the decryption key by the post's `eck` tag from their granted
 * version set — NEVER the current version (plan gotcha). Feeds dedupe by `d`
 * keeping the highest created_at ACROSS BOTH kinds, so a 30023 and a 31607
 * can never both claim the same address.
 *
 * The attendees feed is public 30023 authored by roster pubkeys carrying
 * ["a", <coordinate>] — the standard NIP-23 way to tag long-form to an event.
 */
import { finalizeEvent } from "nostr-tools";
import {
  KIND_LONGFORM,
  KIND_MEMBERS_POST,
  parseCoordinate,
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  decryptMembersPost,
  encryptMembersPost,
  type EckVersion,
  type ExternalFeed,
  supersedes,
} from "@nostrautica/protocol";
import { fetchEvents, type Filter } from "$lib/nostr/ndk.js";
import { publishMonotonic } from "$lib/nostr/monotonic.js";
import { toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import { fetchRoster } from "./attendee.js";
import type { EventContext } from "./event-context.js";
import { cacheGet, cacheSet, cacheDelete, activeCacheOwner, ANON } from "$lib/cache/persist.js";

export type PostSource = "event" | "attendees" | "external";
export type PostVisibility = "public" | "members";

export interface EventPost {
  d: string;
  kind: number; // 30023 | 31607
  membersOnly: boolean;
  /** Members-only post we hold no key for: render a lock + join prompt. */
  locked: boolean;
  title: string; // "" when locked
  summary?: string;
  image?: string;
  content: string; // markdown; "" when locked
  publishedAt: number;
  editedAt: number;
  source: PostSource;
  authorPubkey: string; // signer: E_id for event posts, attendee otherwise
  author?: string; // optional organizer attribution inside a 31607
  eckVersion?: number; // key version named by the 31607 `eck` tag
  /**
   * `source === "external"` only: the organizer's own name for the feed this
   * came from (31608 `sources[].label`). Attribution, so a reader can tell an
   * article pulled in from another npub from one the event itself wrote.
   */
  feedLabel?: string;
}

/** The slice of a Nostr event this module needs (pure/testable). */
export interface RawPostEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * Dedupe by `d` keeping the highest created_at ACROSS BOTH KINDS (30023 and
 * 31607) — an edit of either kind supersedes older revisions at that address.
 * Keyed per author so attendee posts can't collide with each other.
 */
export function dedupePostsByD(events: RawPostEvent[]): RawPostEvent[] {
  const byKey = new Map<string, RawPostEvent>();
  for (const e of events) {
    const d = tag(e.tags, "d") ?? "";
    const key = `${e.pubkey}:${d}`;
    const seen = byKey.get(key);
    if (!seen || supersedes(e, seen)) byKey.set(key, e);
  }
  return [...byKey.values()];
}

/**
 * Turn a raw 30023/31607 into an EventPost, decrypting members-only content
 * with the version named by its `eck` tag from the reader's granted set.
 */
export function toEventPost(
  e: RawPostEvent,
  eckVersions: EckVersion[],
  source: PostSource = "event",
): EventPost {
  const d = tag(e.tags, "d") ?? "";
  if (e.kind !== KIND_MEMBERS_POST) {
    return {
      d,
      kind: e.kind,
      membersOnly: false,
      locked: false,
      title: tag(e.tags, "title") ?? "Update",
      summary: tag(e.tags, "summary"),
      image: tag(e.tags, "image"),
      content: e.content,
      publishedAt: Number(tag(e.tags, "published_at")) || e.created_at,
      editedAt: e.created_at,
      source,
      authorPubkey: e.pubkey,
    };
  }
  const eckVersion = Number(tag(e.tags, "eck")) || undefined;
  // Pick the key the POST names — never assume the current version.
  const version = eckVersions.find((v) => v.id === eckVersion);
  const base = {
    d,
    kind: e.kind,
    membersOnly: true,
    source,
    authorPubkey: e.pubkey,
    eckVersion,
  };
  if (version) {
    try {
      const post = decryptMembersPost(base64ToBytes(version.key), e.content);
      return {
        ...base,
        locked: false,
        title: post.title,
        summary: post.summary,
        image: post.image,
        content: post.content,
        publishedAt: post.published_at,
        editedAt: e.created_at,
        author: post.author,
      };
    } catch {
      /* wrong/garbled payload — fall through to locked */
    }
  }
  return {
    ...base,
    locked: true,
    title: "",
    content: "",
    publishedAt: e.created_at,
    editedAt: e.created_at,
  };
}

function newestFirst(posts: EventPost[]): EventPost[] {
  return posts.sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * The event's official posts (30023 ∪ 31607 authored by E_id), deduped by `d`
 * across both kinds, newest first. Members-only posts decrypt when the reader
 * holds the named ECK version; otherwise they come back locked.
 */
// Persistent post cache per coordinate (CACHING-PLAN §2.4): the Updates/Posts
// page and event home paint instantly on revisit — now ACROSS RELOADS — while a
// background refetch updates them. A 31607 members post carries decrypted
// content, so we owner-scope whenever logged in (wiped on logout) and fall back
// to anon for logged-out visitors (public 30023 only). `at` = newest post's edit
// time, so latest-wins never regresses a feed to an older snapshot.
type PostSlot = "event" | "attendees" | "external";
function postsKey(coordinate: string, slot: PostSlot): string {
  return `posts:${coordinate}:${slot}`;
}
function postsScope(): string {
  return activeCacheOwner() ?? ANON;
}
function newestEditedAt(posts: EventPost[]): number {
  return posts.reduce((m, p) => Math.max(m, p.editedAt), 0);
}

/** Cached official/attendee posts for a coordinate (no network), or undefined. */
export function cachedEventPosts(coordinate: string): EventPost[] | undefined {
  return cacheGet<EventPost[]>(postsKey(coordinate, "event"), postsScope())?.data;
}
export function cachedAttendeePosts(coordinate: string): EventPost[] | undefined {
  return cacheGet<EventPost[]>(postsKey(coordinate, "attendees"), postsScope())?.data;
}
export function cachedExternalPosts(coordinate: string): EventPost[] | undefined {
  return cacheGet<EventPost[]>(postsKey(coordinate, "external"), postsScope())?.data;
}
// Bound the persisted feed at 300/coordinate (§3.5); posts are newest-first.
const MAX_CACHED_POSTS = 300;
function cachePosts(coordinate: string, key: PostSlot, posts: EventPost[], at?: number): void {
  const capped = posts.length > MAX_CACHED_POSTS ? posts.slice(0, MAX_CACHED_POSTS) : posts;
  cacheSet(postsKey(coordinate, key), capped, at ?? newestEditedAt(posts), postsScope());
}

export async function fetchEventPosts(ctx: EventContext): Promise<EventPost[]> {
  const { pubkey } = parseCoordinate(ctx.coordinate);
  // Discovery for 31607 is {kinds, authors:[E_id]} — no `a` tag (spec §7.4).
  const events = await fetchEvents(
    { kinds: [KIND_LONGFORM, KIND_MEMBERS_POST], authors: [pubkey] },
    ctx.config.relays,
  );
  const keys = await loadEventKeys(ctx.coordinate);
  const eck = keys?.eck ?? [];
  const posts = newestFirst(
    dedupePostsByD(events as unknown as RawPostEvent[]).map((e) =>
      toEventPost(e, eck, "event"),
    ),
  );
  cachePosts(ctx.coordinate, "event", posts);
  return posts;
}

/**
 * The attendees feed: public 30023 carrying ["a", <coordinate>], authored by
 * roster pubkeys. When the reader can't decrypt the roster (visitor), the
 * roster filter is skipped — the `a` tag alone scopes the feed; E_id-authored
 * events are excluded either way (those are the official feed).
 */
export async function fetchAttendeePosts(ctx: EventContext): Promise<EventPost[]> {
  const { pubkey: eid } = parseCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    { kinds: [KIND_LONGFORM], "#a": [ctx.coordinate] },
    ctx.config.relays,
  );
  const roster = await fetchRoster(ctx).catch(() => undefined);
  const members = roster ? new Set(roster.attendees.map((a) => a.pubkey)) : undefined;
  const raw = (events as unknown as RawPostEvent[]).filter(
    (e) => e.pubkey !== eid && (!members || members.has(e.pubkey)),
  );
  const posts = newestFirst(dedupePostsByD(raw).map((e) => toEventPost(e, [], "attendees")));
  cachePosts(ctx.coordinate, "attendees", posts);
  return posts;
}

// ── External feeds (31608 `sources`) ─────────────────────────────────────────

/**
 * Per declared feed. An entry that narrows nothing but the author means "every
 * article this npub has ever written", so the reader caps it rather than
 * trusting the organizer's query to be small — a curated feed that shows the
 * newest 100 is a feed; one that pulls a decade of articles into the event page
 * is an outage.
 */
export const MAX_EXTERNAL_PER_FEED = 100;

/** The relay-side query for one declared feed. */
export function externalFeedFilter(src: ExternalFeed): Filter {
  return {
    kinds: [KIND_LONGFORM],
    authors: [src.pubkey],
    limit: MAX_EXTERNAL_PER_FEED,
    ...(src.tags?.length ? { "#t": src.tags } : {}),
    // `created_at`, not `published_at` — see matchesFeed for why this is only a
    // prefilter. `until` is deliberately NOT sent: an article published before
    // `until` may have been edited after it, and dropping it relay-side would
    // make it unrecoverable client-side.
    ...(src.since !== undefined ? { since: src.since } : {}),
  };
}

/**
 * Does this article actually satisfy what the organizer declared?
 *
 * Re-applied client-side because a filter is a request, not a guarantee: a relay
 * that ignores `#t` or `since` would quietly widen the organizer's curation, and
 * `authors` is the one that matters most — nothing else stops a relay from
 * answering with an article by someone the organizer never named. (Signatures
 * are verified upstream by NDK, so `pubkey` here is genuine; what is unverified
 * is whether it is the pubkey we ASKED for.)
 *
 * The date bounds are checked against `published_at`, which is what an organizer
 * means by "since 1 August" — a NIP-23 edit bumps `created_at` without moving
 * `published_at`, so relay-side `since` alone would admit a July article edited
 * in August.
 */
export function matchesFeed(e: RawPostEvent, src: ExternalFeed): boolean {
  if (e.pubkey !== src.pubkey) return false;
  if (src.tags?.length) {
    const hashtags = new Set(
      e.tags.filter((t) => t[0] === "t" && t[1]).map((t) => t[1]!.toLowerCase()),
    );
    if (!src.tags.some((want) => hashtags.has(want.trim().toLowerCase()))) return false;
  }
  const publishedAt = Number(tag(e.tags, "published_at")) || e.created_at;
  if (src.since !== undefined && publishedAt < src.since) return false;
  if (src.until !== undefined && publishedAt > src.until) return false;
  return true;
}

/**
 * Public 30023 by the npubs the organizer declared in the 31608 `sources`,
 * folded into the official feed (spec §7.4).
 *
 * One fetch per distinct relay set, not per source: several feeds usually share
 * the organization's relays, and `fetchEvents` takes a filter ARRAY, so they
 * ride one subscription. A source without its own `relays` uses the event's.
 *
 * E_id's own articles are excluded — those are already the official feed, and a
 * source naming E_id would otherwise duplicate every post on the page.
 */
export async function fetchExternalPosts(
  ctx: EventContext,
  sources: readonly ExternalFeed[],
): Promise<EventPost[]> {
  const { pubkey: eid } = parseCoordinate(ctx.coordinate);
  const feeds = sources.filter((s) => s.pubkey !== eid);
  if (!feeds.length) {
    // DELETE, not "cache an empty list": the organizer removing their last feed
    // has to make those articles disappear, and an empty write would be stamped
    // older than the entry it needs to replace and silently dropped by
    // latest-wins — leaving the removed feed on the page forever.
    cacheDelete(postsKey(ctx.coordinate, "external"), postsScope());
    return [];
  }

  const byRelaySet = new Map<string, ExternalFeed[]>();
  for (const src of feeds) {
    const relays = src.relays?.length ? src.relays : ctx.config.relays;
    const key = [...relays].sort().join(",");
    byRelaySet.set(key, [...(byRelaySet.get(key) ?? []), src]);
  }

  const batches = await Promise.all(
    [...byRelaySet.entries()].map(async ([key, group]) => {
      const relays = key ? key.split(",") : ctx.config.relays;
      try {
        const events = await fetchEvents(group.map(externalFeedFilter), relays);
        // A relay answering one filter of the batch can return events matching a
        // DIFFERENT source in the same group, so each event is kept only if some
        // source in this group actually wanted it.
        return {
          ok: true,
          events: (events as unknown as RawPostEvent[]).filter((e) =>
            group.some((src) => matchesFeed(e, src)),
          ),
        };
      } catch {
        return { ok: false, events: [] as RawPostEvent[] };
      }
    }),
  );

  const labelOf = new Map(
    feeds.filter((f) => f.label?.trim()).map((f) => [f.pubkey, f.label!.trim()]),
  );
  const posts = newestFirst(
    dedupePostsByD(batches.flatMap((b) => b.events)).map((e) => {
      const post = toEventPost(e, [], "external");
      const label = labelOf.get(post.authorPubkey);
      return label ? { ...post, feedLabel: label } : post;
    }),
  );
  // Stamped with NOW, not the newest article's time — unlike the event's own
  // feed, the query behind this one can change under it. Narrowing a source (a
  // hashtag removed, a later `since`) legitimately produces a SHORTER feed whose
  // newest post is older than what is cached, and post-time stamping would
  // discard that write and keep showing articles the organizer just excluded.
  //
  // The protection that stamping bought is kept in a form that doesn't confuse
  // the two cases: a feed is only persisted when EVERY relay group answered.
  // A shrunk feed is then always a real config change, never an unreachable
  // relay, and a failed read leaves the previous snapshot painting.
  if (batches.every((b) => b.ok)) {
    cachePosts(ctx.coordinate, "external", posts, Math.floor(Date.now() / 1000));
  }
  return posts;
}

/**
 * Resolve one post at `d`: 30023-by-d, then 31607-by-d, keeping the highest
 * created_at across both kinds (spec §10.1 `#/e/:naddr/posts/:d`).
 */
/**
 * A single post at `d` from the cached feeds (no network), or undefined. The
 * Post page paints this instantly, then background-refreshes via `fetchPostByD`.
 */
export function cachedPostByD(coordinate: string, d: string): EventPost | undefined {
  return (
    cachedEventPosts(coordinate)?.find((p) => p.d === d) ??
    cachedAttendeePosts(coordinate)?.find((p) => p.d === d) ??
    cachedExternalPosts(coordinate)?.find((p) => p.d === d)
  );
}

export async function fetchPostByD(
  ctx: EventContext,
  d: string,
  sources: readonly ExternalFeed[] = [],
): Promise<EventPost | undefined> {
  const { pubkey: eid } = parseCoordinate(ctx.coordinate);
  // The declared external feeds are resolvable here too, or the "read" link on a
  // curated article would 404 on any device that hasn't cached the feed — a
  // shared link, a fresh browser, or just an evicted cache. Their articles are
  // usually on the feed's own relays, so those are unioned in for this read.
  const authors = [eid, ...sources.map((f) => f.pubkey).filter((p) => p !== eid)];
  const relays = [
    ...new Set([...ctx.config.relays, ...sources.flatMap((f) => f.relays ?? [])]),
  ];
  const events = await fetchEvents(
    { kinds: [KIND_LONGFORM, KIND_MEMBERS_POST], authors, "#d": [d] },
    relays,
  );
  // `d` is only unique per AUTHOR, so a multi-author query can return more than
  // one winner. The event's own post takes the address — an external feed can
  // never shadow what E_id published at the same `d`.
  const winners = dedupePostsByD(events as unknown as RawPostEvent[]);
  const winner = winners.find((e) => e.pubkey === eid) ?? winners[0];
  if (!winner) return undefined;
  if (winner.pubkey !== eid) {
    const label = sources.find((f) => f.pubkey === winner.pubkey)?.label?.trim();
    const post = toEventPost(winner, [], "external");
    return label ? { ...post, feedLabel: label } : post;
  }
  const keys = await loadEventKeys(ctx.coordinate);
  return toEventPost(winner, keys?.eck ?? [], "event");
}

/** Random 32-hex `d` for a new members-only post (chosen once, stable). */
export function randomPostD(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Publish (or, with an existing `d`, edit) a members-only post (kind 31607)
 * signed by E_id. Edits re-encrypt under the CURRENT ECK version (named by the
 * `eck` tag) while preserving `published_at` inside the ciphertext.
 * Organizer-only; the 60,000-byte markdown cap is enforced (readable error).
 *
 * Returns the resulting post AND the publication outcome (R9) so the composer
 * can keep the draft when the 31607 only reached the durable outbox (WSS blocked
 * on venue Wi-Fi) instead of claiming it went live.
 */
export async function publishMembersPost(
  ctx: EventContext,
  input: {
    d?: string;
    title: string;
    summary?: string;
    image?: string;
    content: string;
    publishedAt?: number;
    author?: string; // optional organizer attribution (pubkey hex)
  },
): Promise<{ post: EventPost; outcome: PublishOutcome }> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eck = currentEck(keys);
  if (!eck) throw new Error("event content key not available");
  const now = Math.floor(Date.now() / 1000);
  const d = input.d ?? randomPostD();
  const publishedAt = input.publishedAt ?? now;
  const ciphertext = encryptMembersPost(base64ToBytes(eck.key), {
    v: 2,
    title: input.title,
    summary: input.summary || undefined,
    image: input.image || undefined,
    published_at: publishedAt,
    author: input.author,
    content: input.content,
  });
  // Monotonic republish (audit P3): an edit at the same second as the prior
  // revision of this `d` must win the §3.1 tie-break, or the edit silently
  // doesn't take (the post is addressable across 30023/31607 by its `d`).
  const { createdAt, published } = await publishMonotonic({
    kind: KIND_MEMBERS_POST,
    author: ctx.config.eidPubkey,
    identifier: d,
    relays: ctx.config.relays,
    sign: (created_at) =>
      finalizeEvent(
        {
          kind: KIND_MEMBERS_POST,
          created_at,
          // No `a` tag and no cleartext metadata (spec §7.4).
          tags: [
            ["d", d],
            ["v", "2"],
            ["eck", String(eck.id)],
          ],
          content: ciphertext,
        },
        hexToBytes(keys.eidNsecHex!),
      ),
  });
  return {
    post: {
      d,
      kind: KIND_MEMBERS_POST,
      membersOnly: true,
      locked: false,
      title: input.title,
      summary: input.summary,
      image: input.image,
      content: input.content,
      publishedAt,
      editedAt: createdAt,
      source: "event",
      authorPubkey: ctx.config.eidPubkey,
      author: input.author,
      eckVersion: eck.id,
    },
    outcome: toOutcome(published),
  };
}
