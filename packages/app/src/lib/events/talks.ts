/**
 * Client-side prerecorded-talks access (spec F2, audit U11). Talks are kind 31610
 * addressable events authored by the coordinator (or E_id when there's no
 * coordinator) and encrypted under the ECK, so only approved members can discover
 * and watch them. This mirrors the directory-entry access path in `attendee.ts`.
 *
 * Watch progress is stored device-locally in `localStorage` (the lightest reasonable
 * version, spec F2.4). Cross-device resume via a self-encrypted 30078 record is a
 * possible follow-up (open question F2.8) — not implemented here.
 */
import {
  KIND_TALK,
  KIND_TALK_SUBMISSION,
  KIND_GIFT_WRAP,
  eckDecrypt,
  base64ToBytes,
  hexToBytes,
  talkContentSchema,
  talkSubmissionContentSchema,
  giftwrapSince,
  unwrapRumor,
  bytesToHex,
  type TalkContent,
  type TalkSubmissionContent,
  type TalkExternalKind,
  type TalkSourceType,
  type MediaDescriptor,
  type GiftWrap,
} from "@nostrautica/protocol";
import { getPublicKey } from "nostr-tools/pure";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import type { EventKeys } from "./keystore.js";
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import { directoryPublisher, acceptedRecordAuthors } from "./organizer.js";
import { onlyByAuthors } from "$lib/nostr/verify.js";
import { signerWrap } from "./giftwrap.js";
import { publishOrQueue, toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

async function eckBytes(coordinate: string): Promise<Uint8Array | undefined> {
  const keys = await loadEventKeys(coordinate);
  const eck = currentEck(keys);
  return eck ? base64ToBytes(eck.key) : undefined;
}

/** A published talk paired with the blinded `d` that addresses its detail route. */
export interface TalkItem {
  talk: TalkContent;
  d: string;
}

// Decrypted talks are member-only (ECK), cached owner-scoped and wiped on logout
// (CACHING-PLAN §2.5): Talks/TalkDetail paint the last set instantly on revisit.
function talksKey(coordinate: string): string {
  return `talks:${coordinate}`;
}

/** Cached decrypted talks for a coordinate (no network), or undefined. */
export function cachedTalks(coordinate: string): TalkItem[] | undefined {
  return cacheGet<TalkItem[]>(talksKey(coordinate))?.data;
}
/** One cached talk by its blinded `d` (no network), or undefined. */
export function cachedTalk(coordinate: string, d: string): TalkContent | undefined {
  return cachedTalks(coordinate)?.find((it) => it.d === d)?.talk;
}

/**
 * Fetch + decrypt every published talk for the event (newest revision per talk).
 * Returns [] when the viewer isn't an approved member (no ECK) or talks are off.
 */
export async function fetchTalks(ctx: EventContext): Promise<TalkItem[]> {
  if (ctx.config.talks === "off") return [];
  const eck = await eckBytes(ctx.coordinate);
  // No ECK yet (keys still recovering on a fresh device, or the viewer isn't a
  // member): return the last-seen decrypted set rather than [] — an unavailable
  // key must never blank a talk the device has already shown (screenshot a). The
  // cache is wiped on logout, so a genuine non-member sees nothing to fall back to.
  if (!eck) return cachedTalks(ctx.coordinate) ?? [];
  const publisher = directoryPublisher(ctx);
  // Record-authority pinning (NIP §3.7): only talks authored by the CURRENTLY
  // assigned coordinator (or E_id) are trusted — a formerly assigned coordinator's
  // 31610s are ignored once a newer 31600 no longer names it.
  const events = onlyByAuthors(
    await fetchEvents(
      { kinds: [KIND_TALK], authors: [publisher], "#a": [ctx.coordinate] },
      ctx.config.relays,
    ),
    acceptedRecordAuthors(ctx),
  );
  // Keep the latest event per blinded d (a revision replaces the same address).
  const latestByD = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    const prev = latestByD.get(d);
    if (!prev || (e.created_at ?? 0) > (prev.created_at ?? 0)) latestByD.set(d, e);
  }
  const items: TalkItem[] = [];
  let newestAt = 0;
  for (const [d, e] of latestByD) {
    try {
      const talk = talkContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content)));
      if (talk.status === "published") items.push({ talk, d });
      if ((e.created_at ?? 0) > newestAt) newestAt = e.created_at ?? 0;
    } catch {
      /* skip talks we can't decrypt (published under a newer ECK) or malformed */
    }
  }
  // Newest published first.
  const sorted = items.sort((a, b) => b.talk.published_at - a.talk.published_at);
  // A non-empty fetch is authoritative: cache it (latest-wins on `newestAt`).
  if (sorted.length > 0) {
    cacheSet(talksKey(ctx.coordinate), sorted, newestAt);
    return sorted;
  }
  // Zero talks decrypted this round. That's ambiguous — a genuinely empty event
  // OR a transient relay/EOSE miss (a single-relay stack answering empty) OR a
  // set published under a newer ECK we couldn't decrypt. Never blow away a prior
  // non-empty cache on it (the "empty relay response cannot blank a seen talk
  // without EOSE evidence" rule): keep and return what we last decrypted. Only
  // commit an empty set when we never had one, so a truly empty event still reads
  // as empty rather than perpetually loading.
  const prior = cachedTalks(ctx.coordinate);
  if (prior && prior.length > 0) return prior;
  cacheSet(talksKey(ctx.coordinate), sorted, newestAt);
  return sorted;
}

/** A single talk by its blinded `d` route param (found among the fetched set). */
export async function fetchTalk(ctx: EventContext, d: string): Promise<TalkContent | undefined> {
  const talks = await fetchTalks(ctx);
  return talks.find((it) => it.d === d)?.talk;
}

// ── pending talk moderation (organizer side, spec F2.3) ──────────────────────

/** A submitted talk awaiting organizer moderation (unwrapped from E_inbox). */
export interface PendingTalk {
  pubkey: string; // speaker (seal author of the 21609 rumor)
  talkD: string;
  title: string;
  description: string;
  speakers: string[];
  // Exactly one of `media` (recorded/uploaded to Blossom) or `externalUrl`
  // (YouTube/mp4 hosted elsewhere) is set, mirroring the wire schema.
  media?: MediaDescriptor;
  externalUrl?: string;
  externalKind?: TalkExternalKind;
  sourceType?: TalkSourceType;
  processForMatching: boolean;
  revision: number;
  rumorCreatedAt: number;
}

/** A raw unwrapped 21609 submission — the input to the pure dedup step. */
export interface RawTalkSubmission {
  pubkey: string;
  content: TalkSubmissionContent;
  rumorCreatedAt: number;
}

/** Stable per-speaker-per-talk key used for dedup + published-revision lookup. */
function talkKey(pubkey: string, talkD: string): string {
  return `${pubkey}:${talkD}`;
}

// Cached pending-talk moderation queue, owner-scoped (CACHING-PLAN §2.11).
function pendingTalksKey(coordinate: string): string {
  return `pendingtalks:${coordinate}`;
}
/** Cached pending talks for a coordinate (no network), or undefined. */
export function cachedPendingTalks(coordinate: string): PendingTalk[] | undefined {
  return cacheGet<PendingTalk[]>(pendingTalksKey(coordinate))?.data;
}

/**
 * Pure moderation-queue logic (unit-testable, no network): keep the LATEST
 * submission per (speaker, talk_d) by rumor created_at, then drop any that are
 * already published as a 31610 at the same-or-newer revision. Editing a talk bumps
 * `revision`, so a fresh edit re-appears in the queue even after the prior revision
 * was published. Oldest-submitted first (the moderation order).
 */
export function dedupePendingTalks(
  subs: RawTalkSubmission[],
  publishedRevByKey: Map<string, number>,
): PendingTalk[] {
  const latest = new Map<string, PendingTalk>();
  for (const s of subs) {
    const key = talkKey(s.pubkey, s.content.talk_d);
    const prev = latest.get(key);
    if (!prev || s.rumorCreatedAt > prev.rumorCreatedAt) {
      latest.set(key, {
        pubkey: s.pubkey,
        talkD: s.content.talk_d,
        title: s.content.title,
        description: s.content.description,
        speakers: s.content.speakers,
        media: s.content.media,
        externalUrl: s.content.external_url,
        externalKind: s.content.external_kind,
        sourceType: s.content.source_type,
        processForMatching: s.content.process_for_matching,
        revision: s.content.revision,
        rumorCreatedAt: s.rumorCreatedAt,
      });
    }
  }
  return [...latest.values()]
    .filter((t) => (publishedRevByKey.get(talkKey(t.pubkey, t.talkD)) ?? -1) < t.revision)
    .sort((a, b) => a.rumorCreatedAt - b.rumorCreatedAt);
}

/**
 * Fetch PENDING talk submissions for the event (organizer moderation, spec F2.3).
 * Unwraps kind-21609 rumors from E_inbox exactly as `fetchPending` unwraps join
 * requests (the organizer holds the E_inbox secret), keeps the latest per
 * (speaker, talk_d), and excludes any already published as a 31610 at the
 * same-or-newer revision. Returns [] when talks are off. Requires the E_inbox key.
 */
export async function fetchPendingTalks(
  ctx: EventContext,
  keys: EventKeys,
): Promise<PendingTalk[]> {
  if (ctx.config.talks === "off") return [];
  if (!keys.einboxNsecHex) throw new Error("missing E_inbox key");
  const einboxSk = hexToBytes(keys.einboxNsecHex);
  // Relay-only: submissions must not be lost to the cache/EOSE race (see ndk.ts).
  const wraps = (await fetchEventsRelayOnly(
    { kinds: [KIND_GIFT_WRAP], "#p": [getPublicKey(einboxSk)], since: giftwrapSince() },
    ctx.config.relays,
  )) as unknown as GiftWrap[];

  const subs: RawTalkSubmission[] = [];
  for (const wrap of wraps) {
    let rumor;
    try {
      rumor = unwrapRumor(wrap, einboxSk);
    } catch {
      continue; // not ours / malformed
    }
    if (rumor.kind !== KIND_TALK_SUBMISSION) continue;
    try {
      const content = talkSubmissionContentSchema.parse(JSON.parse(rumor.content));
      if (content.a !== ctx.coordinate) continue;
      subs.push({ pubkey: rumor.pubkey, content, rumorCreatedAt: rumor.created_at });
    } catch {
      /* ignore malformed submission */
    }
  }

  // Exclude talks already published as 31610 (per speaker+talk_d, highest revision).
  const published = await fetchTalks(ctx).catch(() => []);
  const publishedRevByKey = new Map<string, number>();
  for (const { talk } of published) {
    const key = talkKey(talk.pubkey, talk.talk_d);
    publishedRevByKey.set(key, Math.max(publishedRevByKey.get(key) ?? -1, talk.revision));
  }

  const queue = dedupePendingTalks(subs, publishedRevByKey);
  const newestAt = queue.reduce((m, tk) => Math.max(m, tk.rumorCreatedAt), 0);
  cacheSet(pendingTalksKey(ctx.coordinate), queue, newestAt);
  return queue;
}

/** A locally-generated, stable talk id (`talk_d`) for a new talk. */
export function newTalkId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

/**
 * Submit (or edit) a talk: a 21609 rumor gift-wrapped to E_inbox (spec F2). Editing
 * resubmits the SAME `talkId` with a bumped `revision`; the coordinator replaces the
 * previous talk in place after re-moderation.
 */
export async function submitTalk(
  signer: AppSigner,
  ctx: EventContext,
  args: {
    talkId: string;
    title: string;
    description: string;
    revision: number;
    // Exactly one source: a Blossom `media` descriptor (recording/upload) OR an
    // `externalUrl` (+ `externalKind`) the speaker hosts elsewhere.
    media?: MediaDescriptor;
    externalUrl?: string;
    externalKind?: TalkExternalKind;
    sourceType?: TalkSourceType;
    /** Opt this talk into coordinator STT + matching. Default off. */
    processForMatching?: boolean;
  },
): Promise<PublishOutcome> {
  const content: TalkSubmissionContent = {
    v: 2,
    a: ctx.coordinate,
    talk_d: args.talkId,
    title: args.title,
    description: args.description,
    speakers: [],
    source_type: args.sourceType,
    process_for_matching: args.processForMatching ?? false,
    revision: args.revision,
    ...(args.media
      ? { media: args.media }
      : { external_url: args.externalUrl, external_kind: args.externalKind }),
  };
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_TALK_SUBMISSION,
    content,
    tags: [["a", ctx.coordinate]],
  });
  // U2: surface whether the 21609 actually reached a relay (awaiting moderation)
  // or is only queued locally, rather than claiming submission unconditionally.
  return toOutcome(await publishOrQueue(wrap as any, ctx.config.relays));
}

// ── talk edit handoff (F2.4) ─────────────────────────────────────────────────
// TalkDetail sets this before routing to the record composer to edit/replace a
// talk; Record reads-and-clears it. A module variable survives the in-SPA route
// change (no reload) without widening the record route shape.
export interface TalkEditDraft {
  talkId: string;
  title: string;
  description: string;
  revision: number;
}
let editDraft: TalkEditDraft | null = null;
export function setTalkEditDraft(d: TalkEditDraft): void {
  editDraft = d;
}
export function takeTalkEditDraft(): TalkEditDraft | null {
  const d = editDraft;
  editDraft = null;
  return d;
}

// ── watch progress (device-local, spec F2.4) ─────────────────────────────────
const WATCH_PREFIX = "nostrautica:talkwatch:";
function watchKey(coordinate: string, mediaX: string): string {
  return `${WATCH_PREFIX}${coordinate}:${mediaX}`;
}

/** Persist how far (seconds) the viewer has watched a talk, keyed by media hash. */
export function saveWatchProgress(coordinate: string, mediaX: string, seconds: number): void {
  try {
    localStorage.setItem(watchKey(coordinate, mediaX), String(Math.floor(seconds)));
  } catch {
    /* storage may be unavailable (private mode) — progress is best-effort */
  }
}

/** Read the last watched position (seconds), or 0 if none/unavailable. */
export function loadWatchProgress(coordinate: string, mediaX: string): number {
  try {
    const raw = localStorage.getItem(watchKey(coordinate, mediaX));
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// ── favorite talks (spec §13 post-event report) ──────────────────────────────
// A talk favorite is a purely LOCAL marker (owner-scoped cache, wiped on logout),
// not synced to a record: the wire schema has no per-user talk-favorite field and
// this phase adds none. Keyed by the talk's blinded `d` (the same id that
// addresses its detail route and keys the talks cache). The post-event report
// resolves these d's to titles from the cached talk set.
function favTalksKey(coordinate: string): string {
  return `favtalks:${coordinate}`;
}

/** The set of favorited talk d's for a coordinate (no network). */
export function favoriteTalks(coordinate: string): string[] {
  return cacheGet<string[]>(favTalksKey(coordinate))?.data ?? [];
}

/** True if the given talk `d` is favorited. */
export function isFavoriteTalk(coordinate: string, d: string): boolean {
  return favoriteTalks(coordinate).includes(d);
}

/** Toggle a talk's favorite marker; returns the new favorite d-list. */
export function toggleFavoriteTalk(coordinate: string, d: string): string[] {
  const cur = favoriteTalks(coordinate);
  const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
  cacheSet(favTalksKey(coordinate), next, Math.floor(Date.now() / 1000));
  return next;
}

/** Resolve favorited talk d's to `{ d, title }`, dropping ones no longer known. */
export function favoriteTalkItems(coordinate: string): { d: string; title: string }[] {
  const favs = favoriteTalks(coordinate);
  if (favs.length === 0) return [];
  const talks = cachedTalks(coordinate) ?? [];
  const byD = new Map(talks.map((it) => [it.d, it.talk.title]));
  return favs.filter((d) => byD.has(d)).map((d) => ({ d, title: byD.get(d)! }));
}
