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
  eckDecrypt,
  base64ToBytes,
  talkContentSchema,
  bytesToHex,
  type TalkContent,
  type MediaDescriptor,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "./event-context.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { loadEventKeys, currentEck } from "./keystore.js";
import { directoryPublisher } from "./organizer.js";
import { signerWrap } from "./giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";

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

/**
 * Fetch + decrypt every published talk for the event (newest revision per talk).
 * Returns [] when the viewer isn't an approved member (no ECK) or talks are off.
 */
export async function fetchTalks(ctx: EventContext): Promise<TalkItem[]> {
  if (ctx.config.talks === "off") return [];
  const eck = await eckBytes(ctx.coordinate);
  if (!eck) return [];
  const publisher = directoryPublisher(ctx);
  const events = await fetchEvents(
    { kinds: [KIND_TALK], authors: [publisher], "#a": [ctx.coordinate] },
    ctx.config.relays,
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
  for (const [d, e] of latestByD) {
    try {
      const talk = talkContentSchema.parse(JSON.parse(eckDecrypt(eck, e.content)));
      if (talk.status === "published") items.push({ talk, d });
    } catch {
      /* skip talks we can't decrypt (published under a newer ECK) or malformed */
    }
  }
  // Newest published first.
  return items.sort((a, b) => b.talk.published_at - a.talk.published_at);
}

/** A single talk by its blinded `d` route param (found among the fetched set). */
export async function fetchTalk(ctx: EventContext, d: string): Promise<TalkContent | undefined> {
  const talks = await fetchTalks(ctx);
  return talks.find((it) => it.d === d)?.talk;
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
    media: MediaDescriptor;
    revision: number;
  },
): Promise<void> {
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_TALK_SUBMISSION,
    content: {
      v: 1,
      a: ctx.coordinate,
      talk_d: args.talkId,
      title: args.title,
      description: args.description,
      speakers: [],
      media: args.media,
      revision: args.revision,
    },
    tags: [["a", ctx.coordinate]],
  });
  await publishOrQueue(wrap as any, ctx.config.relays);
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
