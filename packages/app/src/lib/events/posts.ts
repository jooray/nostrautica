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
} from "@nostrautica/protocol";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import { fetchRoster } from "./attendee.js";
import type { EventContext } from "./event-context.js";
import { cacheGet, cacheSet, activeCacheOwner, ANON } from "$lib/cache/persist.js";

export type PostSource = "event" | "attendees";
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
}

/** The slice of a Nostr event this module needs (pure/testable). */
export interface RawPostEvent {
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
    if (!seen || e.created_at > seen.created_at) byKey.set(key, e);
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
function postsKey(coordinate: string, slot: "event" | "attendees"): string {
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
// Bound the persisted feed at 300/coordinate (§3.5); posts are newest-first.
const MAX_CACHED_POSTS = 300;
function cachePosts(coordinate: string, key: "event" | "attendees", posts: EventPost[]): void {
  const capped = posts.length > MAX_CACHED_POSTS ? posts.slice(0, MAX_CACHED_POSTS) : posts;
  cacheSet(postsKey(coordinate, key), capped, newestEditedAt(posts), postsScope());
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
    cachedAttendeePosts(coordinate)?.find((p) => p.d === d)
  );
}

export async function fetchPostByD(
  ctx: EventContext,
  d: string,
): Promise<EventPost | undefined> {
  const { pubkey } = parseCoordinate(ctx.coordinate);
  const events = await fetchEvents(
    { kinds: [KIND_LONGFORM, KIND_MEMBERS_POST], authors: [pubkey], "#d": [d] },
    ctx.config.relays,
  );
  const [winner] = dedupePostsByD(events as unknown as RawPostEvent[]);
  if (!winner) return undefined;
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
): Promise<EventPost> {
  const keys = await loadEventKeys(ctx.coordinate);
  if (!keys?.eidNsecHex) throw new Error("organizer E_id key not available");
  const eck = currentEck(keys);
  if (!eck) throw new Error("event content key not available");
  const now = Math.floor(Date.now() / 1000);
  const d = input.d ?? randomPostD();
  const publishedAt = input.publishedAt ?? now;
  const ciphertext = encryptMembersPost(base64ToBytes(eck.key), {
    v: 1,
    title: input.title,
    summary: input.summary || undefined,
    image: input.image || undefined,
    published_at: publishedAt,
    author: input.author,
    content: input.content,
  });
  const event = finalizeEvent(
    {
      kind: KIND_MEMBERS_POST,
      created_at: now,
      // No `a` tag and no cleartext metadata (spec §7.4).
      tags: [
        ["d", d],
        ["v", "1"],
        ["eck", String(eck.id)],
      ],
      content: ciphertext,
    },
    hexToBytes(keys.eidNsecHex),
  );
  await publishOrQueue(event, ctx.config.relays);
  return {
    d,
    kind: KIND_MEMBERS_POST,
    membersOnly: true,
    locked: false,
    title: input.title,
    summary: input.summary,
    image: input.image,
    content: input.content,
    publishedAt,
    editedAt: now,
    source: "event",
    authorPubkey: ctx.config.eidPubkey,
    author: input.author,
    eckVersion: eck.id,
  };
}
