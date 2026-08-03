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
import { fetchEvents, fetchEventsRelayOnly } from "$lib/nostr/ndk.js";
import { DEFAULT_BLOSSOM_SERVERS, unionRelays } from "$lib/nostr/relays.js";
import { preflight, uploadAndMirror, mirror, downloadBlob, isAcceptedBlossomUrl } from "$lib/blossom/client.js";
import { cacheGet, cacheSet } from "$lib/cache/persist.js";
import { t } from "$lib/i18n/i18n.svelte.js";

// The self-copy (31602) and reuse library are decrypted private data, cached
// owner-scoped and wiped on logout (CACHING-PLAN §2.7): the Record composer and
// readiness paint the last intro/library instantly instead of re-decrypting.
type SelfCopy = { profile?: AttendeeProfile; media: MediaDescriptor[]; introText?: string; rev?: number };

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
const MEDIALIB_KEY = "medialib";
const TEXTLIB_KEY = "textlib";

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
  cacheSet(selfRevKey(coordinate), next, next);
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
  cacheSet(selfRevKey(coordinate), floor, floor);
}

/** The cross-event reuse library: recorded intros (`media`) + authored text intros
 *  (`texts`). Both live in the SINGLE per-user `a:null` 31602 entry (§6.2). */
export type ReuseLibrary = { media: MediaDescriptor[]; texts: string[] };

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
  /** The cross-event reuse library entry. */
  library: PublishOutcome;
}

/** The worst-case single outcome: `queued` if anything is still local (U2). */
export function aggregateOutcome(o: SubmitOutcome): PublishOutcome {
  return o.submission === "queued" || o.selfCopy === "queued" || o.library === "queued"
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
  const selfContent = {
    v: 2,
    a: ctx.coordinate,
    rev,
    profile,
    media: args.media,
    ...(introText ? { intro_text: introText } : {}),
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
      { profile, media: args.media, introText, rev } satisfies SelfCopy,
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
): Promise<PublishOutcome> {
  const media = additions.media ?? [];
  const texts = (additions.texts ?? []).map((s) => s.trim()).filter(Boolean);
  // Nothing to add — treat as already-published (no relay work owed).
  if (media.length === 0 && texts.length === 0) return "published";

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
    created_at: nextReplaceableTimestamp(libD, cacheGet<MediaDescriptor[]>(MEDIALIB_KEY)?.at),
    tags: [["d", libD]],
    content: cipher,
  });
  const published = await publishOrQueue(event);
  cacheSet(MEDIALIB_KEY, mergedMedia, event.created_at);
  cacheSet(TEXTLIB_KEY, cappedTexts, event.created_at);
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
