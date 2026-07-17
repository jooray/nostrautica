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
  encryptMedia,
  freshCopy,
  blindedD,
  blindedDLiteral,
  mediaDescriptorSchema,
  type MediaDescriptor,
  type AttendeeProfile,
} from "@nostrautica/protocol";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue } from "$lib/nostr/publish-queue.js";
import { fetchEvents } from "$lib/nostr/ndk.js";
import { DEFAULT_BLOSSOM_SERVERS, unionRelays } from "$lib/nostr/relays.js";
import { preflight, uploadAndMirror, mirror, downloadBlob } from "$lib/blossom/client.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";

// The self-copy (31602) and reuse library are decrypted private data, cached
// owner-scoped and wiped on logout (CACHING-PLAN §2.7): the Record composer and
// readiness paint the last intro/library instantly instead of re-decrypting.
type SelfCopy = { profile?: AttendeeProfile; media: MediaDescriptor[]; introText?: string };
function selfCopyKey(coordinate: string): string {
  return `selfcopy:${coordinate}`;
}
const MEDIALIB_KEY = "medialib";

/** Cached self-copy for a coordinate (no network), or undefined. */
export function cachedSelfCopy(coordinate: string): SelfCopy | undefined {
  return cacheGet<SelfCopy>(selfCopyKey(coordinate))?.data;
}
/** Cached reuse-library media (no network), or undefined. */
export function cachedLibrary(): MediaDescriptor[] | undefined {
  return cacheGet<MediaDescriptor[]>(MEDIALIB_KEY)?.data;
}

/** The Blossom servers to use: event 31600 servers ∪ user 10063 servers ∪ default. */
export async function resolveBlossomServers(
  signer: AppSigner,
  ctx: EventContext,
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();
  const lists = await fetchEvents({ kinds: [KIND_BLOSSOM_SERVERS], authors: [pubkey] });
  const latest = lists.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  const userServers = latest
    ? latest.tags.filter((t) => t[0] === "server").map((t) => t[1]!)
    : [];
  const merged = unionRelays(ctx.config.blossom, userServers, DEFAULT_BLOSSOM_SERVERS);
  return merged;
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

  const servers = await resolveBlossomServers(signer, ctx);
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

  // 21601 → E_inbox (gift-wrapped).
  const submission = {
    v: 1,
    profile: args.profile,
    media: args.media,
    ...(introText ? { intro_text: introText } : {}),
  };
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_SUBMISSION,
    content: submission,
    tags: [["a", ctx.coordinate]],
  });

  // 31602 self-copy (blinded d over the self-conversation key). Keeps the
  // attendee's own device holding their authored text intro too.
  const selfContent = {
    v: 1,
    a: ctx.coordinate,
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
    addToLibrary(signer, args.media, args.blindingKey),
  ]);
}

/**
 * Add media descriptors to the reuse library — the 31602 entry with `a:null` and
 * d blinded over the literal "library" (spec §6.2, §7.3). Merges with existing.
 */
export async function addToLibrary(
  signer: AppSigner,
  media: MediaDescriptor[],
  blindingKey: Uint8Array,
): Promise<void> {
  if (media.length === 0) return;
  const pubkey = await signer.getPublicKey();
  const libD = blindedDLiteral(blindingKey, "library");
  const existing = await loadLibrary(signer, blindingKey);
  const byHash = new Map<string, MediaDescriptor>();
  for (const d of [...existing, ...media]) byHash.set(d.x, d);
  const content = { v: 1, a: null, media: [...byHash.values()] };
  const cipher = await signer.nip44Encrypt(pubkey, JSON.stringify(content));
  const event = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", libD]],
    content: cipher,
  });
  await publishOrQueue(event);
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
  const servers = await resolveBlossomServers(signer, ctx);
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
): Promise<
  { profile?: AttendeeProfile; media: MediaDescriptor[]; introText?: string } | undefined
> {
  const pubkey = await signer.getPublicKey();
  const d = blindedD(blindingKey, ctx.coordinate, pubkey);
  const events = await fetchEvents({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [d],
  });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return undefined;
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    const parsed = JSON.parse(json) as {
      profile?: AttendeeProfile;
      media?: MediaDescriptor[];
      intro_text?: string;
    };
    const self: SelfCopy = {
      profile: parsed.profile,
      media: parsed.media ?? [],
      introText: parsed.intro_text,
    };
    cacheSet(selfCopyKey(ctx.coordinate), self, latest.created_at ?? 0);
    return self;
  } catch {
    return undefined;
  }
}

/** Load the attendee's reuse-library media descriptors (spec §6.2). */
export async function loadLibrary(
  signer: AppSigner,
  blindingKey: Uint8Array,
): Promise<MediaDescriptor[]> {
  const pubkey = await signer.getPublicKey();
  const libD = blindedDLiteral(blindingKey, "library");
  const events = await fetchEvents({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [libD],
  });
  const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
  if (!latest) return [];
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    const parsed = JSON.parse(json) as { media?: MediaDescriptor[] };
    const media = parsed.media ?? [];
    cacheSet(MEDIALIB_KEY, media, latest.created_at ?? 0);
    return media;
  } catch {
    return [];
  }
}
