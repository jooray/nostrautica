/**
 * Submit / update profile & media (spec §8, §6.2). Record → AES-GCM encrypt →
 * BUD-06 preflight → BUD-02 upload → BUD-04 mirror → new 21601 (to E_inbox) +
 * updated 31602 self-copy + intro-library entry.
 *
 * The blob is encrypted client-side with a fresh key; the descriptor (carrying
 * that key) travels inside the encrypted 21601 / self-encrypted 31602 — never as
 * its own event.
 */
import {
  KIND_PROFILE_SUBMISSION,
  KIND_MY_PROFILE,
  KIND_BLOSSOM_SERVERS,
  MAX_LIBRARY_TEXTS,
  encryptMedia,
  freshCopy,
  blindedD,
  blindedDLiteral,
  mediaDescriptorSchema,
  type MediaDescriptor,
  type AttendeeProfile,
  pickLatest,
  MAX_SUBMISSION_MEDIA,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { DEFAULT_BLOSSOM_SERVERS, unionRelays } from "$lib/nostr/relays.js";
import { preflight, uploadAndMirror, mirror, downloadBlob, isAcceptedBlossomUrl } from "$lib/blossom/client.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// The self-copy (31602) and reuse library are decrypted private data, cached
// owner-scoped and wiped on logout (CACHING-PLAN §2.7): the Record composer and
// readiness paint the last intro/library instantly instead of re-decrypting.
type SelfCopy = { profile?: AttendeeProfile; media: MediaDescriptor[]; introText?: string; rev?: number };

/**
 * Whether a self-copy carries an intro (audit UX-O5). An intro is EITHER a
 * recording (media of kind "intro") OR an authored text intro (F1). Both the
 * readiness store and Join's post-approval routing must agree, so this is the
 * single source of truth — checking only media wrongly told text-intro users to
 * "record your intro."
 */
export function hasIntro(
  self: { media?: MediaDescriptor[]; introText?: string } | undefined,
): boolean {
  return (self?.media ?? []).some((m) => m.kind === "intro") || !!self?.introText?.trim();
}

function selfCopyKey(coordinate: string): string {
  return `selfcopy:${coordinate}`;
}
const MEDIALIB_KEY = "medialib";
const TEXTLIB_KEY = "textlib";

/** The cross-event reuse library: recorded intros (`media`) + authored text intros
 *  (`texts`). Both live in the SINGLE per-user `a:null` 31602 entry (§6.2). */
export type ReuseLibrary = { media: MediaDescriptor[]; texts: string[] };

/** Cached self-copy for a coordinate (no network), or undefined. */
export function cachedSelfCopy(coordinate: string): SelfCopy | undefined {
  return cacheGet<SelfCopy>(selfCopyKey(coordinate))?.data;
}
/** Cached reuse-library media (no network), or undefined. */
export function cachedLibrary(): MediaDescriptor[] | undefined {
  return cacheGet<MediaDescriptor[]>(MEDIALIB_KEY)?.data;
}
/** Cached reuse-library text intros (no network), or undefined. */
export function cachedTextLibrary(): string[] | undefined {
  return cacheGet<string[]>(TEXTLIB_KEY)?.data;
}

/**
 * The user's personal BUD-03 (kind 10063) Blossom server list, most-recent
 * event wins.
 */
export async function fetchUserBlossomServers(signer: AppSigner): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  const lists = await fetchEvents({ kinds: [KIND_BLOSSOM_SERVERS], authors: [pubkey] });
  const latest = lists.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  // The 10063 tags are user/relay-supplied and unvalidated — https: only (APPR-8).
  return latest
    ? latest.tags
        .filter((t) => t[0] === "server")
        .map((t) => t[1]!)
        .filter(isAcceptedBlossomUrl)
    : [];
}

/**
 * The Blossom servers to use for ENCRYPTED media: event 31600 servers ∪
 * default. Deliberately excludes the user's own kind 10063 list — that's a
 * general-purpose pin (e.g. blossom.primal.net) meant for ordinary blobs, and
 * several popular ones 415 on AES-GCM ciphertext (no BUD-02 content-type check
 * we control), so honoring it here reliably breaks encrypted uploads (prod
 * report 2026-07-20). Unencrypted uploads (uploadPublicImage) still honor it.
 */
export function resolveBlossomServers(ctx: EventContext): string[] {
  // https: only (audit APPR-8) — the protocol parse validates too; this is the
  // app-side backstop for configs/relays that predate or bypass it.
  return unionRelays(ctx.config.blossom, DEFAULT_BLOSSOM_SERVERS).filter(isAcceptedBlossomUrl);
}

export interface SubmitMediaResult {
  descriptor: MediaDescriptor;
}

/**
 * Encrypt + upload a media blob and return its descriptor. Preflights every
 * target server and fails cleanly if none will accept the blob.
 */
export async function uploadMedia(
  signer: AppSigner,
  ctx: EventContext,
  blob: Blob,
  kind: "intro" | "talk",
  durationSec: number,
): Promise<MediaDescriptor> {
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const { ciphertext, descriptor } = await encryptMedia({
    kind,
    data: plaintext,
    mime: blob.type || "video/webm",
    duration: durationSec,
    urls: [],
  });

  const servers = resolveBlossomServers(ctx);
  // BUD-06 preflight: keep only servers that will accept this ciphertext.
  const checks = await Promise.all(
    servers.map((s) =>
      preflight(signer, s, {
        sha256: descriptor.x,
        size: descriptor.size,
        type: "application/octet-stream",
      }),
    ),
  );
  // Servers whose preflight explicitly succeeded go FIRST (one becomes the upload
  // primary); a `status === 0` preflight (network/CORS-blocked HEAD) is only kept
  // as a fallback — otherwise a server that CORS-blocks its preflight but 415s the
  // real PUT (e.g. blossom.primal.net) would become primary and fail the whole
  // upload even when a good server was available (prod report 2026-07-17).
  const preflightOk = checks.filter((c) => c.ok).map((c) => c.server);
  const preflightUnknown = checks.filter((c) => !c.ok && c.status === 0).map((c) => c.server);
  const accepting = [...preflightOk, ...preflightUnknown];
  if (accepting.length === 0) {
    const reason = checks.map((c) => `${c.server}: ${c.message ?? c.status}`).join("; ");
    throw new Error(`No Blossom server accepted the upload (${reason})`);
  }

  const { urls } = await uploadAndMirror(
    signer,
    accepting,
    ciphertext,
    "application/octet-stream",
  );
  // Real Blossom URLs are known now — validate the finalized descriptor (https-only).
  return mediaDescriptorSchema.parse({ ...descriptor, url: urls });
}

/**
 * Publish a profile submission (21601) with the given media + profile, update the
 * attendee's 31602 self-copy, and store the descriptor in the reuse library.
 */
export async function submitProfileAndMedia(
  signer: AppSigner,
  ctx: EventContext,
  args: {
    profile: AttendeeProfile;
    media: MediaDescriptor[];
    blindingKey: Uint8Array;
    /** A plain-text intro (spec F1). Written into 21601 + the 31602 self-copy. */
    introText?: string;
  },
): Promise<void> {
  const attendeePubkey = await signer.getPublicKey();
  const introText = args.introText?.trim() || undefined;

  // Monotonic per-(coordinate) revision (NIP §3.3): the last-sent rev lives on the
  // per-event self-copy (the client's own durable per-event submission store), so we
  // read it back and bump on every edit. A first submission is rev 0; nothing else
  // in the app depends on the exact value — only that it strictly increases per edit.
  const prevSelf = await loadSelfCopy(signer, ctx, args.blindingKey).catch(() => undefined);
  const rev = (prevSelf?.rev ?? -1) + 1;

  // v2 (NIP §8): the 21601 submission carries at most MAX_SUBMISSION_MEDIA (4)
  // descriptors, or the coordinator rejects it wholesale at the schema boundary.
  // The 31602 self-copy/library keeps the full set (MAX_MEDIA=20).
  const submissionMedia = args.media.slice(0, MAX_SUBMISSION_MEDIA);

  // 21601 → E_inbox (gift-wrapped).
  const submission = {
    v: 2,
    rev,
    profile: args.profile,
    media: submissionMedia,
    ...(introText ? { intro_text: introText } : {}),
  };
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_SUBMISSION,
    content: submission,
    tags: [["a", ctx.coordinate]],
  });

  // 31602 self-copy (blinded d over the self-conversation key). Keeps the
  // attendee's own device holding their authored text intro too, and the `rev`
  // just sent so the next edit bumps from it.
  const selfContent = {
    v: 2,
    a: ctx.coordinate,
    rev,
    profile: args.profile,
    media: args.media,
    ...(introText ? { intro_text: introText } : {}),
  };
  const selfCipher = await signer.nip44Encrypt(attendeePubkey, JSON.stringify(selfContent));
  const selfEvent = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", blindedD(args.blindingKey, ctx.coordinate, attendeePubkey)]],
    content: selfCipher,
  });

  await Promise.all([
    publishOrQueue(wrap as any, ctx.config.relays),
    publishOrQueue(selfEvent),
    // Every submitted intro — recorded OR authored text — is also folded into the
    // cross-event reuse library so it can be picked at a later event (F1 reuse).
    addToLibrary(signer, args.blindingKey, {
      media: args.media,
      texts: introText ? [introText] : [],
    }),
  ]);
}

/**
 * Add media descriptors and/or authored text intros to the reuse library — the
 * 31602 entry with `a:null` and d blinded over the literal "library" (spec §6.2,
 * §7.3). This entry is per-USER, not per-event (its d carries no coordinate), so it
 * spans every event. Merges with the existing entry:
 *  - media dedup by ciphertext hash `x`;
 *  - texts dedup by exact string, re-adding an existing text moves it to newest;
 *  - texts are capped to the most-recent MAX_LIBRARY_TEXTS (keeps the self-encrypted
 *    entry under the NIP-44 ceiling).
 */
export async function addToLibrary(
  signer: AppSigner,
  blindingKey: Uint8Array,
  additions: { media?: MediaDescriptor[]; texts?: string[] },
): Promise<void> {
  const media = additions.media ?? [];
  const texts = (additions.texts ?? []).map((s) => s.trim()).filter(Boolean);
  if (media.length === 0 && texts.length === 0) return;

  const pubkey = await signer.getPublicKey();
  const libD = blindedDLiteral(blindingKey, "library");
  const existing = await loadLibraryFull(signer, blindingKey);

  const byHash = new Map<string, MediaDescriptor>();
  for (const d of [...existing.media, ...media]) byHash.set(d.x, d);
  const mergedMedia = [...byHash.values()];

  const mergedTexts = [...existing.texts];
  for (const txt of texts) {
    const at = mergedTexts.indexOf(txt);
    if (at >= 0) mergedTexts.splice(at, 1); // re-adding bumps it to most-recent
    mergedTexts.push(txt);
  }
  const cappedTexts = mergedTexts.slice(-MAX_LIBRARY_TEXTS);

  const content = {
    v: 2,
    a: null,
    media: mergedMedia,
    ...(cappedTexts.length ? { intro_texts: cappedTexts } : {}),
  };
  const cipher = await signer.nip44Encrypt(pubkey, JSON.stringify(content));
  const event = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", libD]],
    content: cipher,
  });
  await publishOrQueue(event);
  cacheSet(MEDIALIB_KEY, mergedMedia, event.created_at);
  cacheSet(TEXTLIB_KEY, cappedTexts, event.created_at);
}

/**
 * Prepare a library descriptor for reuse at this event (spec §6.2, §8):
 *  - "fresh copy": download → re-encrypt with a new key/IV → upload (new blob hash,
 *    no cross-event linkage).
 *  - default reuse: keep the blob, BUD-04-mirror it onto this event's servers so
 *    it's reachable, and add those URLs to the descriptor. No re-upload.
 */
export async function prepareReuse(
  signer: AppSigner,
  ctx: EventContext,
  descriptor: MediaDescriptor,
  fresh: boolean,
): Promise<MediaDescriptor> {
  const servers = resolveBlossomServers(ctx);
  if (fresh) {
    const ciphertext = await downloadBlob(descriptor.url, descriptor.x);
    const re = await freshCopy(descriptor, ciphertext, []);
    const { urls } = await uploadAndMirror(
      signer,
      servers,
      re.ciphertext,
      "application/octet-stream",
    );
    return mediaDescriptorSchema.parse({ ...re.descriptor, url: urls });
  }
  // Default reuse: mirror the existing blob onto this event's servers.
  const extraUrls: string[] = [];
  for (const server of servers) {
    const url = await mirror(signer, server, descriptor.url[0]!, descriptor.x);
    if (url && !descriptor.url.includes(url)) extraUrls.push(url);
  }
  return mediaDescriptorSchema.parse({ ...descriptor, url: unionRelays(descriptor.url, extraUrls) });
}

/** Load the attendee's own 31602 self-copy for this event (profile + media). */
export async function loadSelfCopy(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<SelfCopy | undefined> {
  const pubkey = await signer.getPublicKey();
  const d = blindedD(blindingKey, ctx.coordinate, pubkey);
  const events = await fetchEvents({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [d],
  });
  const latest = pickLatest(events);
  if (!latest) return undefined;
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    const parsed = JSON.parse(json) as {
      profile?: AttendeeProfile;
      media?: MediaDescriptor[];
      intro_text?: string;
      rev?: number;
    };
    const self: SelfCopy = {
      profile: parsed.profile,
      media: parsed.media ?? [],
      introText: parsed.intro_text,
      rev: typeof parsed.rev === "number" ? parsed.rev : undefined,
    };
    cacheSet(selfCopyKey(ctx.coordinate), self, latest.created_at ?? 0);
    return self;
  } catch {
    return undefined;
  }
}

/**
 * Load the attendee's full cross-event reuse library (spec §6.2): recorded intros
 * AND authored text intros, from the single per-user `a:null` 31602 entry.
 */
export async function loadLibraryFull(
  signer: AppSigner,
  blindingKey: Uint8Array,
): Promise<ReuseLibrary> {
  const pubkey = await signer.getPublicKey();
  const libD = blindedDLiteral(blindingKey, "library");
  const events = await fetchEvents({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [libD],
  });
  const latest = pickLatest(events);
  if (!latest) return { media: [], texts: [] };
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    const parsed = JSON.parse(json) as { media?: MediaDescriptor[]; intro_texts?: string[] };
    const media = parsed.media ?? [];
    // Older library entries (written before text reuse) carry no intro_texts —
    // treated as an empty text library, so they still load cleanly.
    const texts = (parsed.intro_texts ?? []).filter((s) => typeof s === "string");
    cacheSet(MEDIALIB_KEY, media, latest.created_at ?? 0);
    cacheSet(TEXTLIB_KEY, texts, latest.created_at ?? 0);
    return { media, texts };
  } catch {
    return { media: [], texts: [] };
  }
}

/** Load the attendee's reuse-library media descriptors only (spec §6.2). */
export async function loadLibrary(
  signer: AppSigner,
  blindingKey: Uint8Array,
): Promise<MediaDescriptor[]> {
  return (await loadLibraryFull(signer, blindingKey)).media;
}
