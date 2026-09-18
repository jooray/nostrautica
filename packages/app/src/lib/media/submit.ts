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
  MAX_INTRO_TEXT,
  profileSubmissionContentSchema,
} from "@nostrautica/protocol";
import { normalizeAuthoredProfile } from "$lib/events/authored-profile.js";
import type { AppSigner } from "$lib/signer/types.js";
import type { EventContext } from "$lib/events/event-context.js";
import { signerWrap } from "$lib/events/giftwrap.js";
import { publishOrQueue, toOutcome, type PublishOutcome } from "$lib/nostr/publish-queue.js";
import { cachedDirectoryEntry, fetchDirectoryEntry } from "$lib/events/attendee.js";
import { fetchEvents, fetchEventsAnswered, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { DEFAULT_BLOSSOM_SERVERS, unionRelays } from "$lib/nostr/relays.js";
import { preflight, uploadAndMirror, mirror, downloadBlob, isAcceptedBlossomUrl } from "$lib/blossom/client.js";
import { cacheGet, cacheSet, whenCacheReady } from "$lib/cache/persist.js";
import { t } from "$lib/i18n/i18n.svelte.js";

// The self-copy (31602) and reuse library are decrypted private data, cached
// owner-scoped and wiped on logout (CACHING-PLAN §2.7): the Record composer and
// readiness paint the last intro/library instantly instead of re-decrypting.
type SelfCopy = {
  profile?: AttendeeProfile;
  media: MediaDescriptor[];
  introText?: string;
  rev?: number;
  /** The last 21608 correction `rev` sent for this event (audit A-5). */
  correctionRev?: number;
};

// Parameterized replaceable events created in the same wall-clock second must
// not rely on the event-id tie-break to decide which edit survives. Keep each
// d-slot strictly increasing for this session, seeded from its persisted cache.
const lastReplaceableTimestamp = new Map<string, number>();

function nextReplaceableTimestamp(slot: string, persistedAt = 0): number {
  const now = Math.floor(Date.now() / 1000);
  const next = Math.max(now, persistedAt + 1, (lastReplaceableTimestamp.get(slot) ?? 0) + 1);
  lastReplaceableTimestamp.set(slot, next);
  return next;
}

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
/** Persisted high-water mark of the `rev` this device has ever SENT (NIP §3.3). */
function selfRevKey(coordinate: string): string {
  return `selfrev:${coordinate}`;
}
/** The same, for 21608 ai_profile corrections (audit A-5). */
function correctionRevKey(coordinate: string): string {
  return `corrrev:${coordinate}`;
}
const MEDIALIB_KEY = "medialib";
const TEXTLIB_KEY = "textlib";
/** Per-clip "added at" sidecar for the reuse gallery (see ReuseLibrary.at). */
const MEDIALIB_AT_KEY = "medialib-at";

/**
 * The next submission `rev` for this event — strictly greater than both the
 * highest we have ever sent from this device and whatever the loaded self-copy
 * reports (another device may be further ahead).
 *
 * The high-water mark is PERSISTED rather than re-derived from the network on
 * every submit, because re-deriving it made a failed relay read silently
 * destructive. `loadSelfCopy` resolves to undefined whenever a read comes back
 * empty — a routine outcome on venue Wi-Fi, since `fetchEvents` settles with
 * whatever arrived after an 8s cap and never rejects — and `(undefined ?? -1) + 1`
 * is 0. Sending rev 0 again after the counter had reached N loses the §3.3
 * comparison against the stored key, so the coordinator discards the submission
 * as stale ("ignored stale profile") and the attendee is told it saved. Same
 * shape as `nextReplaceableTimestamp` above, which already keeps the OTHER half
 * of the ordering key (created_at) monotonic across a session for this reason.
 */
function nextRev(coordinate: string, observed: number | undefined): number {
  const next = revFloor(coordinate, observed) + 1;
  // Stamp with the WALL CLOCK, not with `next`. The third argument is the cache's
  // latest-wins timestamp, and a revision counter is 0, 1, 2… — as a timestamp that
  // is 1970, so the 30-day prune deleted this high-water mark on the next boot and
  // reinstated the exact incident the comment above describes. `Math.max` keeps
  // latest-wins monotonic if two writes land in the same second.
  cacheSet(selfRevKey(coordinate), next, Math.floor(Date.now() / 1000));
  return next;
}

/** The highest rev known to have been sent for this event, or -1. */
function revFloor(coordinate: string, observed: number | undefined): number {
  const stored = cacheGet<number>(selfRevKey(coordinate))?.data;
  return Math.max(typeof stored === "number" ? stored : -1, observed ?? -1);
}

/** Raise the high-water mark to `rev` without consuming one (a rev already sent). */
function nextRevFloor(coordinate: string, rev: number): void {
  const floor = revFloor(coordinate, rev);
  // Same reason as `nextRev`: the counter is not a timestamp.
  cacheSet(selfRevKey(coordinate), floor, Math.floor(Date.now() / 1000));
}

/** The cross-event reuse library: recorded intros (`media`) + authored text intros
 *  (`texts`). Both live in the SINGLE per-user `a:null` 31602 entry (§6.2). */
/**
 * `at` maps a clip's ciphertext hash to when it was added, in unix seconds.
 *
 * It is a sidecar rather than a field on MediaDescriptor for two reasons: the
 * descriptor is a WIRE object that gets republished into events, and its schema
 * strips unknown keys, so a timestamp added there would silently vanish on the
 * next validation round-trip. This library record is self-encrypted and private
 * — nobody else parses it — so an extra top-level key costs nothing and older
 * clients ignore it.
 *
 * Entries written before this existed have no stamp. That is why the gallery
 * also falls back to array order, which has always been chronological.
 */
export type ReuseLibrary = {
  media: MediaDescriptor[];
  texts: string[];
  at: Record<string, number>;
  /**
   * Whether this is the library as the relays report it, or just the shape of a
   * read that did not land. `false` means empty-because-unknown, and
   * `addToLibrary` refuses to republish over it — see there.
   */
  known: boolean;
};

/**
 * The authored profile of someone who has genuinely never written one. A
 * function, not a shared const: it is handed to submitters that JSON-encode it
 * alongside caller-owned data, and one accidental mutation of a shared literal
 * would travel to every later submission.
 */
export function emptyProfile(): AttendeeProfile {
  return { about: "", skills: [], looking_for: "", links: [] };
}

/**
 * Refuse to sign a 21601 the coordinator would throw away.
 *
 * `profileSubmissionContentSchema` is the coordinator's own intake schema, and a
 * payload that fails it is not retried, queued or reported: the handler
 * classifies a ZodError as permanently unprocessable, writes the rumor to the
 * seen ledger and moves on. The attendee is told "Saved". Failing here instead
 * costs an error message and keeps the submission.
 */
function assertSubmittable(submission: unknown): void {
  const parsed = profileSubmissionContentSchema.safeParse(submission);
  if (parsed.success) return;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "profile";
  throw new Error(t("submit.error.invalid", { field, reason: issue?.message ?? "invalid" }));
}

/** Cached self-copy for a coordinate (no network), or undefined. */
export function cachedSelfCopy(coordinate: string): SelfCopy | undefined {
  return cacheGet<SelfCopy>(selfCopyKey(coordinate))?.data;
}

/**
 * Write through the self-copy a caller just published, and carry its `rev` into
 * the persisted high-water mark. Exported for the join flow, which publishes the
 * FIRST 31602 of an event: without this the joining device held no local copy
 * until its next submission, so the very first "record your intro" — the one
 * most likely to happen minutes later on the same bad venue Wi-Fi — had nothing
 * to fall back on when the relay read came back empty.
 */
export function cacheSelfCopy(coordinate: string, self: SelfCopy, at: number): void {
  cacheSet(selfCopyKey(coordinate), self, at);
  if (typeof self.rev === "number") nextRevFloor(coordinate, self.rev);
  if (typeof self.correctionRev === "number") {
    // Same high-water discipline as `rev`: raise, never lower (audit A-5).
    const floor = Math.max(cacheGet<number>(correctionRevKey(coordinate))?.data ?? -1, self.correctionRev);
    cacheSet(correctionRevKey(coordinate), floor, Math.floor(Date.now() / 1000));
  }
}
/** This device's persisted high-water mark for 21608 correction revs, or undefined. */
export function cachedCorrectionRev(coordinate: string): number | undefined {
  const stored = cacheGet<number>(correctionRevKey(coordinate))?.data;
  return typeof stored === "number" ? stored : undefined;
}

/**
 * Claim the next 21608 correction `rev` for this event, monotonic ACROSS DEVICES
 * (audit A-5).
 *
 * The correction counter used to live only in this device's `localStorage`, so a
 * second device (or a cleared profile) started again from 0 while the coordinator
 * still held rev 3 from the first — and it orders corrections by
 * `(rev, created_at, id)`, so every edit the new device made was discarded
 * server-side while the UI reported "saved". Delivery had genuinely succeeded;
 * application had not, and nothing told the user.
 *
 * The floor is therefore taken from BOTH the relay-backed 31602 self-copy (which
 * survives a device change) and the local high-water mark, exactly as
 * {@link nextRev} does for submissions: a failed or empty relay read can only fail
 * to ADVANCE the counter, never roll it back. The returned `record` publishes the
 * new value into the self-copy so the NEXT device sees it; the local mark is
 * written before either, so a failed publish still can't reissue this rev.
 */
export async function claimCorrectionRev(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<{ rev: number; record: () => Promise<void> }> {
  const self = await loadSelfCopy(signer, ctx, blindingKey).catch(() => undefined);
  const floor = Math.max(cachedCorrectionRev(ctx.coordinate) ?? -1, self?.correctionRev ?? -1);
  const rev = floor + 1;
  // Wall clock as the cache timestamp, NOT `rev` — a revision counter read as a
  // timestamp is 1970, and the 30-day prune then deletes the high-water mark on the
  // next boot (the trap `nextRev` documents).
  cacheSet(correctionRevKey(ctx.coordinate), rev, Math.floor(Date.now() / 1000));
  return {
    rev,
    record: async () => {
      const attendeePubkey = await signer.getPublicKey();
      const selfD = blindedD(blindingKey, ctx.coordinate, attendeePubkey);
      const key = selfCopyKey(ctx.coordinate);
      const merged: SelfCopy = { ...(self ?? { media: [] }), correctionRev: rev };
      const content = {
        v: 2,
        a: ctx.coordinate,
        profile: merged.profile,
        media: merged.media,
        ...(merged.introText ? { intro_text: merged.introText } : {}),
        ...(merged.rev !== undefined ? { rev: merged.rev } : {}),
        correction_rev: rev,
      };
      const cipher = await signer.nip44Encrypt(attendeePubkey, JSON.stringify(content));
      const event = await signer.signEvent({
        kind: KIND_MY_PROFILE,
        created_at: nextReplaceableTimestamp(selfD, cacheGet<SelfCopy>(key)?.at),
        tags: [["d", selfD]],
        content: cipher,
      });
      await publishOrQueue(event);
      cacheSelfCopy(ctx.coordinate, merged, event.created_at);
    },
  };
}

/** Cached reuse-library media (no network), or undefined. */
/** Cached per-clip "added at" map; `{}` when this device has never seen one. */
export function cachedLibraryAt(): Record<string, number> {
  return cacheGet<Record<string, number>>(MEDIALIB_AT_KEY)?.data ?? {};
}

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
 * Aggregate publication outcome of a profile/intro submission (audit U2). A
 * submission fans out into three replaceable/gift-wrapped events; each can
 * independently reach a relay or fall back to the durable outbox. The UI reads
 * `submission` (the load-bearing 21601 to E_inbox — what makes the intro visible
 * to the organizer/coordinator) to decide what it may truthfully claim.
 */
export interface SubmitOutcome {
  /** The 21601 profile submission to E_inbox — the one that matters. */
  submission: PublishOutcome;
  /** The attendee's own 31602 self-copy. */
  selfCopy: PublishOutcome;
  /**
   * The cross-event reuse library entry. `skipped` is its own outcome rather
   * than a failure: the intro reached the organizer, and the library write was
   * deliberately not attempted because the current library could not be read
   * and publishing would have replaced it with a truncated one. Reported, not
   * swallowed — collapsing it into `published` would claim a clip is reusable
   * at the next event when it is not.
   */
  library: PublishOutcome | "skipped";
}

/** The worst-case single outcome: `queued` if anything is still local (U2). */
export function aggregateOutcome(o: SubmitOutcome): PublishOutcome {
  return o.submission === "queued" || o.selfCopy === "queued" || o.library !== "published"
    ? "queued"
    : "published";
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
): Promise<SubmitOutcome> {
  const attendeePubkey = await signer.getPublicKey();
  const introText = args.introText?.trim().slice(0, MAX_INTRO_TEXT) || undefined;
  // Repair the authored fields into something the coordinator's schema accepts
  // BEFORE anything is signed. A submission it rejects is not retried or queued
  // — it is marked seen and discarded permanently — so the only safe place to
  // fail is here, in front of a user who can still do something about it.
  const { profile } = normalizeAuthoredProfile(args.profile);

  // Monotonic per-(coordinate) revision (NIP §3.3). The self-copy reports what the
  // last submission carried, but the counter itself is persisted locally so a
  // failed read can only ever fail to ADVANCE it, never roll it back — see nextRev.
  const prevSelf = await loadSelfCopy(signer, ctx, args.blindingKey).catch(() => undefined);
  const rev = nextRev(ctx.coordinate, prevSelf?.rev);

  // v2 (NIP §8): the 21601 submission carries at most MAX_SUBMISSION_MEDIA (4)
  // descriptors, or the coordinator rejects it wholesale at the schema boundary.
  // The 31602 self-copy/library keeps the full set (MAX_MEDIA=20).
  const submissionMedia = args.media.slice(0, MAX_SUBMISSION_MEDIA);

  // 21601 → E_inbox (gift-wrapped).
  const submission = {
    v: 2,
    rev,
    profile,
    media: submissionMedia,
    ...(introText ? { intro_text: introText } : {}),
  };
  // Parse against the coordinator's OWN schema — the backstop for whatever
  // normalization could not foresee (an over-long media descriptor, a future
  // field). Throwing surfaces it in the UI; publishing it would look identical
  // to success and be gone by the time anyone noticed.
  assertSubmittable(submission);
  const wrap = await signerWrap(signer, ctx.config.inbox, {
    kind: KIND_PROFILE_SUBMISSION,
    content: submission,
    tags: [["a", ctx.coordinate]],
  });

  // 31602 self-copy (blinded d over the self-conversation key). Keeps the
  // attendee's own device holding their authored text intro too, and the `rev`
  // just sent so the next edit bumps from it.
  // Carry the correction rev forward (audit A-5). Every submission REPLACES this
  // 31602, and Zod strips what the schema doesn't name, so a submission that didn't
  // re-emit it would erase the only cross-device record of the correction counter.
  const carriedCorrectionRev = prevSelf?.correctionRev ?? cachedCorrectionRev(ctx.coordinate);
  const selfContent = {
    v: 2,
    a: ctx.coordinate,
    rev,
    profile,
    media: args.media,
    ...(introText ? { intro_text: introText } : {}),
    ...(carriedCorrectionRev !== undefined ? { correction_rev: carriedCorrectionRev } : {}),
  };
  const selfKey = selfCopyKey(ctx.coordinate);
  const selfD = blindedD(args.blindingKey, ctx.coordinate, attendeePubkey);
  const selfCipher = await signer.nip44Encrypt(attendeePubkey, JSON.stringify(selfContent));
  const selfEvent = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: nextReplaceableTimestamp(selfD, cacheGet<SelfCopy>(selfKey)?.at),
    tags: [["d", selfD]],
    content: selfCipher,
  });

  const publishSelfCopy = publishOrQueue(selfEvent).then((published) => {
    // Both outcomes are durable: either a relay accepted the event or the outbox
    // persisted it. Write through before navigation can re-read stale intro state.
    cacheSelfCopy(
      ctx.coordinate,
      { profile, media: args.media, introText, rev, correctionRev: carriedCorrectionRev } satisfies SelfCopy,
      selfEvent.created_at,
    );
    return published;
  });
  const [submissionOut, selfCopyOut, libraryOut] = await Promise.all([
    publishOrQueue(wrap as any, ctx.config.relays),
    publishSelfCopy,
    // Every submitted intro — recorded OR authored text — is also folded into the
    // cross-event reuse library so it can be picked at a later event (F1 reuse).
    addToLibrary(signer, args.blindingKey, {
      media: args.media,
      texts: introText ? [introText] : [],
    }),
  ]);
  // U2: return the true per-event outcome instead of collapsing to success. The
  // library entry going out is not required for the intro to reach the organizer,
  // but its outcome is reported so the caller sees the full picture.
  return {
    submission: toOutcome(submissionOut),
    selfCopy: toOutcome(selfCopyOut),
    library: libraryOut,
  };
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
): Promise<PublishOutcome | "skipped"> {
  const media = additions.media ?? [];
  const texts = (additions.texts ?? []).map((s) => s.trim()).filter(Boolean);
  // Nothing to add — treat as already-published (no relay work owed).
  if (media.length === 0 && texts.length === 0) return "published";

  const pubkey = await signer.getPublicKey();
  const libD = blindedDLiteral(blindingKey, "library");
  // This publish REPLACES the stored library event, and the library is
  // append-only, so anything missing from `existing` is deleted by it. Two
  // routine outcomes produce an empty `existing` that has nothing to do with the
  // library being empty: a relay that did not answer inside the read's timeout
  // (venue Wi-Fi — the same scenario this file's `rev` high-water mark already
  // exists for), and a decrypt that failed. Either one used to publish a library
  // containing only the clip just recorded, wiping every intro the user had.
  await whenCacheReady();
  const existing = await loadLibraryFull(signer, blindingKey);
  if (!existing.known) return "skipped";

  // Belt and braces for the case the flag cannot cover: union with this device's
  // last known copy. The library only ever grows — there is no removal path — so
  // a union can restore but never resurrect.
  const byHash = new Map<string, MediaDescriptor>();
  for (const d of [...(cachedLibrary() ?? []), ...existing.media, ...media]) byHash.set(d.x, d);
  const mergedMedia = [...byHash.values()];
  // Stamp only what is genuinely new. Re-adding a clip that is already in the
  // library must not move it to the top of the gallery: the question the date
  // answers is when it was MADE, not when it was last touched.
  const nowSec = Math.floor(Date.now() / 1000);
  const mergedAt: Record<string, number> = {
    ...(cacheGet<Record<string, number>>(MEDIALIB_AT_KEY)?.data ?? {}),
    ...existing.at,
  };
  for (const d of mergedMedia) if (mergedAt[d.x] === undefined) mergedAt[d.x] = nowSec;

  const priorTexts = cachedTextLibrary() ?? [];
  const mergedTexts = [...priorTexts.filter((t) => !existing.texts.includes(t)), ...existing.texts];
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
    media_at: mergedAt,
    ...(cappedTexts.length ? { intro_texts: cappedTexts } : {}),
  };
  const cipher = await signer.nip44Encrypt(pubkey, JSON.stringify(content));
  const event = await signer.signEvent({
    kind: KIND_MY_PROFILE,
    created_at: nextReplaceableTimestamp(libD, cacheGet<MediaDescriptor[]>(MEDIALIB_KEY)?.at),
    tags: [["d", libD]],
    content: cipher,
  });
  const published = await publishOrQueue(event);
  cacheSet(MEDIALIB_KEY, mergedMedia, event.created_at);
  cacheSet(TEXTLIB_KEY, cappedTexts, event.created_at);
  cacheSet(MEDIALIB_AT_KEY, mergedAt, event.created_at);
  return toOutcome(published);
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

/**
 * Load the attendee's own 31602 self-copy for this event (profile + media).
 *
 * RELAY-ONLY fetch on purpose: this is a must-not-miss read, and with the dexie
 * cache adapter in the loop `fetchEvents` can resolve on EOSE before surfacing a
 * relay event that had already arrived (see fetchEventsRelayOnly's own note).
 * Missing the self-copy here is not a benign miss — callers build the next
 * submission out of it.
 *
 * Falls back to the persisted copy when the relays produce nothing. The device
 * that is submitting is almost always the device that wrote the self-copy in the
 * first place, so the answer is usually sitting in the local cache while the
 * network read times out — and returning `undefined` in that state is what let a
 * transient read failure be mistaken for "this attendee has no profile".
 */
export async function loadSelfCopy(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<SelfCopy | undefined> {
  const pubkey = await signer.getPublicKey();
  const d = blindedD(blindingKey, ctx.coordinate, pubkey);
  const events = await fetchEventsRelayOnly({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [d],
  });
  const latest = pickLatest(events);
  if (latest) {
    try {
      const json = await signer.nip44Decrypt(pubkey, latest.content);
      const parsed = JSON.parse(json) as {
        profile?: AttendeeProfile;
        media?: MediaDescriptor[];
        intro_text?: string;
        rev?: number;
        correction_rev?: number;
      };
      const self: SelfCopy = {
        profile: parsed.profile,
        media: parsed.media ?? [],
        introText: parsed.intro_text,
        rev: typeof parsed.rev === "number" ? parsed.rev : undefined,
        correctionRev: typeof parsed.correction_rev === "number" ? parsed.correction_rev : undefined,
      };
      cacheSet(selfCopyKey(ctx.coordinate), self, latest.created_at ?? 0);
      return self;
    } catch {
      /* undecryptable / malformed — fall through to the persisted copy */
    }
  }
  return cachedSelfCopy(ctx.coordinate);
}

/**
 * The attendee's current authored state, for building a submission that must
 * PRESERVE what it isn't editing (a recorded intro carries the profile forward
 * unchanged; a text intro likewise).
 *
 * The 21601 replaces the authored profile wholesale — that is what lets an
 * attendee clear a field — so a caller that cannot load the current state has no
 * safe way to express "leave it alone", and substituting a blank profile
 * silently deletes their about/skills/looking_for at the coordinator, taking
 * them out of matching with it (an empty profile is correctly refused by the
 * scorer). So this widens the search rather than degrading to blank:
 *
 *   31602 self-copy (relays) → persisted self-copy → published 31603 entry
 *
 * The directory entry is the coordinator's own copy of the authored fields, so
 * it is a faithful last resort and covers the genuinely new device with a cold
 * cache. `undefined` now means all three said nothing, which for a joined
 * attendee is close to unreachable and for a brand-new one is the truth.
 */
export async function loadAuthoredState(
  signer: AppSigner,
  ctx: EventContext,
  blindingKey: Uint8Array,
): Promise<SelfCopy | undefined> {
  const self = await loadSelfCopy(signer, ctx, blindingKey).catch(() => undefined);
  if (self) return self;
  const pubkey = await signer.getPublicKey();
  const entry =
    cachedDirectoryEntry(ctx.coordinate, pubkey) ??
    (await fetchDirectoryEntry(ctx, pubkey).catch(() => undefined));
  if (!entry) return undefined;
  return {
    profile: entry.profile,
    media: entry.media ?? [],
    introText: entry.intro_text,
    // The 31603 carries no `rev` — it is the coordinator's projection, not the
    // submission. nextRev's persisted high-water mark supplies the ordering.
    rev: undefined,
  };
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
  const { events, answered } = await fetchEventsAnswered({
    kinds: [KIND_MY_PROFILE],
    authors: [pubkey],
    "#d": [libD],
  });
  const latest = pickLatest(events);
  // No event AND no relay answer is not an empty library, it is an unread one.
  // Rendering it as empty is harmless; republishing over it is not.
  if (!latest) return { media: [], texts: [], at: {}, known: answered };
  try {
    const json = await signer.nip44Decrypt(pubkey, latest.content);
    const parsed = JSON.parse(json) as {
      media?: MediaDescriptor[];
      intro_texts?: string[];
      media_at?: Record<string, number>;
    };
    const media = parsed.media ?? [];
    const at = parsed.media_at ?? {};
    // Older library entries (written before text reuse) carry no intro_texts —
    // treated as an empty text library, so they still load cleanly.
    const texts = (parsed.intro_texts ?? []).filter((s) => typeof s === "string");
    cacheSet(MEDIALIB_KEY, media, latest.created_at ?? 0);
    cacheSet(TEXTLIB_KEY, texts, latest.created_at ?? 0);
    cacheSet(MEDIALIB_AT_KEY, at, latest.created_at ?? 0);
    return { media, texts, at, known: true };
  } catch {
    // The library IS there and would not decrypt (a signer that dropped the
    // request, a payload from a future schema). The one case where "empty" is
    // definitely wrong.
    return { media: [], texts: [], at: {}, known: false };
  }
}

/** Load the attendee's reuse-library media descriptors only (spec §6.2). */
export async function loadLibrary(
  signer: AppSigner,
  blindingKey: Uint8Array,
): Promise<MediaDescriptor[]> {
  return (await loadLibraryFull(signer, blindingKey)).media;
}
