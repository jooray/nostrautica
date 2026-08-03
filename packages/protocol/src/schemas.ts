/**
 * Zod schemas for every encrypted/JSON payload in spec §7. Every payload is
 * versioned (`"v": 2`, wire v2). These validate what we parse off relays before
 * trusting it — malformed or hostile payloads are rejected at the boundary.
 *
 * Wire v2 (NIP §2, decisions D1/D2) is a STRICT, flag-day parse: `v` must be
 * exactly `2`. v1's forward-tolerant `z.number().int().positive()` is gone —
 * a future breaking payload would have been silently misparsed as v1. A payload
 * declaring a higher `v` is now REJECTED and, when it comes from a trusted
 * authority, surfaced as an "update the app" prompt (see the version helpers
 * below).
 */
import { z } from "zod";
import { isEventCoordinate } from "./coordinate.js";

export const PROTOCOL_VERSION = 2;

/** The public-event `["v", …]` tag value for this protocol version ("2"). */
export const PROTOCOL_VERSION_TAG = String(PROTOCOL_VERSION);

// Strict wire version (NIP §2, D1): exactly `2`, not "any positive integer".
const version = z.literal(PROTOCOL_VERSION);

/**
 * Thrown when a payload/event declares an integer protocol version strictly
 * NEWER than this client understands (`v > PROTOCOL_VERSION`). Distinct from a
 * generic malformed-payload error so callers can tell "from the future" (prompt
 * the user to update, NIP §2 / D2) apart from "hostile/garbled" (drop silently).
 */
export class NewerProtocolVersionError extends Error {
  readonly newerVersion: number;
  constructor(newerVersion: number) {
    super(
      `payload requires protocol v${newerVersion}; this client speaks v${PROTOCOL_VERSION} — update required`,
    );
    this.name = "NewerProtocolVersionError";
    this.newerVersion = newerVersion;
  }
}

/** The integer `v` of a raw JSON payload object, or undefined when absent/non-integer. */
export function readPayloadVersion(raw: unknown): number | undefined {
  if (raw && typeof raw === "object" && "v" in raw) {
    const v = (raw as { v: unknown }).v;
    if (typeof v === "number" && Number.isInteger(v)) return v;
  }
  return undefined;
}

/** The integer version from a public event's `["v", …]` tag, or undefined. */
export function readEventVersionTag(tags: string[][]): number | undefined {
  const raw = tags.find((t) => t[0] === "v")?.[1];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * True when a public event carries exactly `["v","2"]`. Readers of public custom
 * kinds MUST ignore events failing this (NIP §2): an absent or mismatched tag
 * means the event is not a v2 event this client can trust.
 */
export function hasCurrentVersionTag(tags: string[][]): boolean {
  return readEventVersionTag(tags) === PROTOCOL_VERSION;
}

/** True when a raw payload declares an integer `v` strictly newer than this client. */
export function isNewerProtocolVersion(raw: unknown): boolean {
  const v = readPayloadVersion(raw);
  return v !== undefined && v > PROTOCOL_VERSION;
}

/** True when a public event's `["v", …]` tag names a version newer than this client. */
export function isNewerVersionTag(tags: string[][]): boolean {
  const v = readEventVersionTag(tags);
  return v !== undefined && v > PROTOCOL_VERSION;
}

/**
 * Discriminated parse result: distinguishes a NEWER-version payload (update the
 * app, D2) from a generic invalid one, so a caller reading from a trusted
 * authority key can drive the update prompt rather than silently dropping the
 * event. On the happy path this is just `schema.parse` with a typed wrapper.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "newer-version"; version: number }
  | { ok: false; reason: "invalid"; error: z.ZodError };

export function parsePayloadSafe<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  const res = schema.safeParse(raw);
  if (res.success) return { ok: true, value: res.data };
  const v = readPayloadVersion(raw);
  if (v !== undefined && v > PROTOCOL_VERSION) {
    return { ok: false, reason: "newer-version", version: v };
  }
  return { ok: false, reason: "invalid", error: res.error };
}

// Lowercase-only (audit PROTO-6): every downstream comparison is case-sensitive,
// so an uppercase-A-F pubkey that validated could never match anything.
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32-byte hex");
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

/**
 * A canonical Nostrautica EVENT coordinate `31923:<E_id pubkey>:<d>` (audit R18):
 * a `kind:pubkey:d` whose kind is exactly 31923. Used for the `a` of grants that
 * INSTALL/AUTHORIZE an event identity, so an alias kind (e.g. `1:<E_id>:d`) can't
 * open a divergent capacity/accounting namespace against the same author. Other
 * `a` fields (corrections, per-event self-copies, library `a:null`) stay generic
 * strings — only the install/key grant establishes the event's server-side identity.
 */
const eventCoordinate = z
  .string()
  .refine(isEventCoordinate, "expected a 31923 event coordinate (kind:pubkey:d)");

/**
 * Byte length a canonical base64 string decodes to, or -1 if the string is not a
 * whole number of base64 quanta. Length-only (no decode) so it works identically
 * in the browser and in Node.
 */
function decodedByteLength(s: string): number {
  if (s.length === 0 || s.length % 4 !== 0) return -1;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

/** base64 that decodes to exactly `nBytes` (Q6: crypto-material length validation). */
function base64Bytes(nBytes: number, label: string) {
  return base64.refine((s) => decodedByteLength(s) === nBytes, `expected ${nBytes}-byte base64 (${label})`);
}

/** An https: URL (C3: block non-https media/fetch targets at the boundary; audit
 *  APPR-1/APPR-2: this is the schema-boundary half — callers that render a URL
 *  as a clickable link additionally re-check the scheme at render time). */
function httpsUrl(maxLen?: number) {
  return (maxLen === undefined ? z.string() : z.string().max(maxLen)).url().refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");
}

// ── Media descriptor (spec §6.2) ─────────────────────────────────────────────
// `.strict()` (Q6): a media descriptor drives coordinator fetch + ffmpeg, so an
// unexpected field is rejected rather than silently ignored. Key/nonce lengths are
// validated (C3) so a malformed descriptor can't reach the crypto layer.
const mediaDescriptorBase = z
  .object({
    kind: z.enum(["intro", "talk"]),
    url: z.array(httpsUrl()).min(1),
    x: hex32, // sha256 of ciphertext
    ox: hex32, // sha256 of plaintext
    // v2 (NIP §8): a real blob is at least 1 byte — AES-GCM always emits ≥ the
    // 16-byte tag — so `size: 0` is no longer a valid descriptor.
    size: z.number().int().min(1),
    m: z.string(), // mime type
    duration: z.number().nonnegative().optional(),
    "encryption-algorithm": z.literal("aes-gcm"),
    "decryption-key": base64Bytes(32, "decryption-key"), // 32 bytes b64
    "decryption-nonce": base64Bytes(12, "decryption-nonce"), // 12 bytes b64
  })
  .strict();

/**
 * v2 (NIP §8): `duration` is REQUIRED for audio/* and video/* media. The
 * coordinator gates STT and pipeline segmentation on it and enforces per-event
 * duration limits against the declared value, so an a/v descriptor without a
 * duration is incomplete. Text/image descriptors leave it optional.
 */
function requireAvDuration(
  val: { m: string; duration?: number },
  ctx: z.RefinementCtx,
): void {
  const isAv = val.m.startsWith("audio/") || val.m.startsWith("video/");
  if (isAv && val.duration === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["duration"],
      message: "duration is required for audio/video media",
    });
  }
}

export const mediaDescriptorSchema = mediaDescriptorBase.superRefine(requireAvDuration);
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;

// Pre-upload draft: identical to mediaDescriptorSchema but `url` may be empty,
// because the Blossom https URLs are only known AFTER the ciphertext is uploaded.
// `encryptMedia` validates this draft at encrypt time; the finalized descriptor
// (real https URLs filled in) is validated against the strict schema at upload
// time. Without this, encrypting an intro throws on the placeholder URL before a
// single byte is uploaded. The a/v-duration rule applies here too, so the
// recorder can't produce a durationless a/v blob even before upload.
export const mediaDescriptorDraftSchema = mediaDescriptorBase
  .extend({ url: z.array(z.string()) })
  .strict()
  .superRefine(requireAvDuration);

// ── Media transcript (spec §9.2, audit A1) ───────────────────────────────────
// A transcript tied to a specific media blob by its ciphertext hash `x`. The
// coordinator publishes these on the directory entry so a deaf/screen-reader
// attendee has a nonvisual path to any intro. `.strict()`: a transcript is read
// off a relay and rendered as trusted text, so an unexpected field is rejected.
// Because `x` is content-addressed, re-recording an intro changes `x` and orphans
// the old transcript — the directory-entry schema below validates that every
// transcript still references live media (stale transcripts are dropped).
/** BCP-47 language tag chars (audit P2). */
export const MAX_LANG = 35;
/** STT/authored transcript body cap (audit P2). */
export const MAX_TRANSCRIPT_TEXT = 100_000;

export const mediaTranscriptSchema = z
  .object({
    x: hex32, // the media descriptor's `x` this transcript belongs to
    text: z.string().max(MAX_TRANSCRIPT_TEXT),
    lang: z.string().max(MAX_LANG), // ISO-639-1 detected by STT, or the authored source language
    source: z.enum(["stt", "authored"]),
    updated_at: z.number().int(),
  })
  .strict();
export type MediaTranscript = z.infer<typeof mediaTranscriptSchema>;

/** Upper bound on a text intro / authored transcript (spec F1, ~2000 chars). */
export const MAX_INTRO_TEXT = 2000;

/** How many authored text intros the cross-event reuse library retains (F1 reuse).
 *  Bounded (like MAX_MEDIA) so the self-encrypted library entry can't grow past the
 *  NIP-44 ceiling; the loader keeps the most recent ones and drops older overflow. */
export const MAX_LIBRARY_TEXTS = 20;

// ── Boundary length caps (audit PROTO-4) ─────────────────────────────────────
// These payloads are parsed straight off relays and most ride inside NIP-44
// ciphertexts, so unbounded strings/arrays are a DoS vector and can push the
// enclosing payload past the 65,535-byte NIP-44 ceiling. The caps are generous —
// well above any legitimate value — while keeping worst-case payloads bounded.
export const MAX_NAME = 200; // join-request / directory-entry display name
export const MAX_MESSAGE = 2000; // join-request message
export const MAX_ABOUT = 5000; // attendee profile bio
export const MAX_LOOKING_FOR = 2000;
export const MAX_SKILLS = 50; // skills array items
export const MAX_SKILL = 200; // chars per skill
export const MAX_LINKS = 20; // profile links array items
export const MAX_URL = 2048; // chars per URL
export const MAX_INVITE_LABEL = 100;
export const MAX_INVITES = 10000; // 31601 invites array items
export const MAX_REASONING = 2000; // per-match reasoning
export const MAX_MATCHES = 100; // 31605 matches array items
// Icebreakers (31605, NIP §6.2): ≤ 3 short conversation starters per match entry,
// ≤ 280 chars each — concrete opening lines the coordinator derives alongside the
// directional reasoning, not a restatement of it.
export const MAX_ICEBREAKERS = 3;
export const MAX_ICEBREAKER = 280;
export const MAX_ROSTER = 2000; // 31604 attendees array items
export const MAX_RELAYS = 30; // relay URL array items
export const MAX_MEDIA = 20; // media descriptors per 31602 self-copy / reuse library
// v2 (NIP §8): a 21601 profile submission carries at most 4 processed media
// descriptors — aligned with the coordinator's long-standing MAX_MEDIA_PER_SUBMISSION
// enforcement. The 31602 self-copy/library keeps MAX_MEDIA (it legitimately holds more).
export const MAX_SUBMISSION_MEDIA = 4;
export const MAX_D = 200; // blinded `d` identifier chars (roster/directory)
export const MAX_MATCH_PAIRS = 200_000; // 31606 match-matrix pairs array items
export const MAX_TITLE = 300; // members-post title
export const MAX_POST_BODY = 100_000; // members-post markdown body
export const MAX_NOTES = 2000; // per-event private note map entries
export const MAX_NOTE = 5000; // chars per per-event private note

// ── Profile (used inside submissions & directory) ────────────────────────────
export const attendeeProfileSchema = z.object({
  about: z.string().max(MAX_ABOUT).default(""),
  skills: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).default([]),
  looking_for: z.string().max(MAX_LOOKING_FOR).default(""),
  links: z.array(z.string().url().max(MAX_URL)).max(MAX_LINKS).default([]),
});
export type AttendeeProfile = z.infer<typeof attendeeProfileSchema>;

// Coordinator-published translation of the USER-authored profile fields into the
// event language, shown when the viewer reads the event language and the source
// text was written in a different one. Never overwrites the user's originals.
export const profileTranslationSchema = z.object({
  lang: z.string().max(MAX_LANG), // target (event) language, ISO 639-1
  about: z.string().max(MAX_ABOUT).optional(),
  looking_for: z.string().max(MAX_LOOKING_FOR).optional(),
  skills: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).optional(),
});
export type ProfileTranslation = z.infer<typeof profileTranslationSchema>;

export const aiProfileSchema = z.object({
  summary: z.string().max(MAX_ABOUT),
  skills: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS),
  interests: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS),
  offers: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS),
  seeks: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS),
  // Present when the attendee's own profile language differs from the event's.
  translations: profileTranslationSchema.optional(),
});
export type AiProfile = z.infer<typeof aiProfileSchema>;

/**
 * Does this ai_profile say anything at all about the person?
 *
 * An all-empty ai_profile is a real, expected value, not a bug: the coordinator
 * publishes one when an attendee had NO inputs to derive from — no authored
 * profile, no intro, no readable public Nostr activity (the empty-input skip,
 * audit COORD-4). Both sides of the protocol have to agree on what "empty" means
 * or they contradict each other in front of the user, which is exactly what
 * happened on 2026-07-29: the app rendered an "AI summary" heading over blank
 * space because it only checked that the field EXISTED, while the coordinator
 * fed that same nothing to the match model and published a confident, entirely
 * invented reason for the two of them to meet. `translations` is deliberately
 * not content — it restates authored fields in another language and says
 * nothing new when there was nothing to restate.
 */
export function hasAiProfileContent(profile: AiProfile | undefined): boolean {
  if (!profile) return false;
  return (
    profile.summary.trim().length > 0 ||
    profile.skills.length > 0 ||
    profile.interests.length > 0 ||
    profile.offers.length > 0 ||
    profile.seeks.length > 0
  );
}

// ── 31601 Invite List content ────────────────────────────────────────────────
/** Upper bound on a single code's redemption cap (`uses`). */
export const MAX_INVITE_USES = 5000;
/** `uses: 0` means unbounded — the shared door code, capped only by `exp`. */
export const INVITE_USES_UNLIMITED = 0;

export const inviteListContentSchema = z.object({
  v: version,
  invites: z
    .array(
      z.object({
        h: hex32, // sha256(invite-pubkey) hex
        label: z.string().max(MAX_INVITE_LABEL).optional(),
        /**
         * How many DISTINCT attendees may redeem this code. Absent means 1 —
         * the original single-use behaviour, and the value an older coordinator
         * effectively assumes, since `z.object` strips a key it doesn't know.
         * That is the whole reason this is additive rather than a new kind: an
         * old coordinator reading a new list admits the first scanner and sends
         * the rest to the manual queue. It under-admits; it never over-admits.
         */
        uses: z.number().int().min(0).max(MAX_INVITE_USES).optional(),
        /**
         * Unix seconds after which the code stops auto-approving (it does not
         * disappear — later joins simply queue for the organizer). A shared code
         * is forwardable by anyone who scanned it, so for the door-QR case this
         * is the containment, not an optional extra.
         */
        exp: z.number().int().positive().optional(),
      }),
    )
    .max(MAX_INVITES),
});
export type InviteListContent = z.infer<typeof inviteListContentSchema>;
export type InviteListEntry = InviteListContent["invites"][number];

/** What an invite entry permits, with the defaults an omitted field implies. */
export interface InvitePolicy {
  /** Distinct redemptions allowed; INVITE_USES_UNLIMITED (0) for unbounded. */
  uses: number;
  /** Unix seconds after which the code no longer auto-approves. */
  exp?: number;
}

export function invitePolicyOf(entry: { uses?: number; exp?: number }): InvitePolicy {
  return { uses: entry.uses ?? 1, ...(entry.exp !== undefined ? { exp: entry.exp } : {}) };
}

// ── 21600 Join Request rumor content ─────────────────────────────────────────
export const joinRequestContentSchema = z.object({
  v: version,
  name: z.string().max(MAX_NAME),
  message: z.string().max(MAX_MESSAGE).default(""),
  rsvp_public: z.boolean().default(false),
});
export type JoinRequestContent = z.infer<typeof joinRequestContentSchema>;

// ── 21601 Profile Submission rumor content ───────────────────────────────────
export const profileSubmissionContentSchema = z.object({
  v: version,
  // Application revision (NIP §3.3, required): the client maintains it monotonically
  // per (coordinate) in its own storage and bumps it on every edit. The coordinator
  // orders submissions by (rev, created_at, id) — sender timestamps are never the
  // primary ordering key — so an out-of-order older edit can never regress the profile.
  rev: z.number().int().nonnegative(),
  profile: attendeeProfileSchema,
  media: z.array(mediaDescriptorSchema).max(MAX_SUBMISSION_MEDIA).default([]),
  // A plain-text intro (spec F1): an alternative to an audio/video intro for
  // attendees who can't/won't record. Feeds the ai_profile like a transcript,
  // but has NO media blob. Bounded so it can't bloat the encrypted submission.
  intro_text: z.string().max(MAX_INTRO_TEXT).optional(),
});
export type ProfileSubmissionContent = z.infer<
  typeof profileSubmissionContentSchema
>;

// ── 21608 Profile Correction rumor content (F3, audit U9) ────────────────────
// An attendee corrects, hides specific fields of, or hides entirely the
// coordinator-generated ai_profile on their OWN directory entry. Sent gift-wrapped
// to E_inbox (same path as a 21601 submission); the coordinator binds the seal
// author to the subject (unwrapRumor), so an attendee can only correct THEIR OWN
// profile. The correction lives in the coordinator's DB (not the content-addressed
// artifact cache), so it SURVIVES reprocessing: a freshly generated ai_profile has
// the stored correction re-applied at publish time.

/** The ai_profile fields an attendee may override (F3). Authored identity fields
 *  (about/skills/looking_for/links) are never touched by a correction. */
export const AI_PROFILE_FIELDS = ["summary", "skills", "interests", "offers", "seeks"] as const;
export type AiProfileField = (typeof AI_PROFILE_FIELDS)[number];

/** Per-field overrides of the generated ai_profile. v2 (NIP §8): bounded exactly
 *  like `ai_profile` (summary ≤ 5000, ≤ 50 list items of ≤ 200 chars) — v1's
 *  unbounded overrides were a storage-amplification bug (an approved attendee could
 *  push arbitrarily large text the coordinator stored and merged into every 31603). */
export const aiProfileOverrideSchema = z.object({
  summary: z.string().max(MAX_ABOUT).optional(),
  skills: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).optional(),
  interests: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).optional(),
  offers: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).optional(),
  seeks: z.array(z.string().max(MAX_SKILL)).max(MAX_SKILLS).optional(),
});
export type AiProfileOverride = z.infer<typeof aiProfileOverrideSchema>;

export const profileCorrectionContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate this correction applies to
  // Application revision (NIP §3.3, required): same monotonic-per-(coordinate,kind)
  // rule and same total order as the 21601 profile submission — an out-of-order
  // older correction can never overwrite a newer one.
  rev: z.number().int().nonnegative(),
  // Replace named ai_profile fields with the attendee's own text/lists.
  overrides: aiProfileOverrideSchema.optional(),
  // true = publish the directory entry with NO ai_profile (self-authored fallback).
  hidden: z.boolean().optional(),
  // Blank specific generated fields (rather than override them).
  hidden_fields: z.array(z.enum(AI_PROFILE_FIELDS)).optional(),
  // Optional "this is inaccurate" note to the organizer. Minimally carried — the
  // owner deferred a full report-to-organizer flow (audit U10), so it is just a
  // free-text string with no elaborate handling here.
  report: z.string().max(MAX_INTRO_TEXT).optional(),
});
export type ProfileCorrectionContent = z.infer<typeof profileCorrectionContentSchema>;

// ── 21602 Key Grant rumor content ────────────────────────────────────────────
export const eckVersionSchema = z.object({
  id: z.number().int().positive(),
  key: base64Bytes(32, "eck"), // 32 bytes b64
});
export type EckVersion = z.infer<typeof eckVersionSchema>;

/** A 32-byte secret key in hex (E_id / E_inbox nsec fields, Q6). */
const secretKeyHex = hex32;

export const keyGrantContentSchema = z.object({
  v: version,
  a: eventCoordinate, // 31923 event coordinate (audit R18)
  role: z.enum(["attendee", "organizer"]),
  eck: z.array(eckVersionSchema),
  granted_by: hex32,
});
export type KeyGrantContent = z.infer<typeof keyGrantContentSchema>;

// ── 21603 Coordinator Grant rumor content ────────────────────────────────────
export const coordinatorGrantContentSchema = z.object({
  v: version,
  a: eventCoordinate, // 31923 event coordinate (audit R18) — the installed event's identity
  // Install generation (NIP §3.5, required): must match the newest 31600's gen for
  // a fresh install, and be strictly greater than the highest gen ever installed or
  // detached for the coordinate — a replayed historical grant can never re-install.
  gen: z.number().int().positive(),
  inbox_nsec: secretKeyHex, // hex privkey of E_inbox
  eck: z.array(eckVersionSchema),
  config_relays: z.array(z.string()).max(MAX_RELAYS),
});
export type CoordinatorGrantContent = z.infer<
  typeof coordinatorGrantContentSchema
>;

// ── 21604 Admin Command rumor content ────────────────────────────────────────
/** Default admin-command lifetime (NIP §3.4): a command is void 48h after it was
 *  issued, so an old revoke/recompute can never re-execute from a backfill/restore. */
export const ADMIN_COMMAND_TTL_SEC = 172_800; // 48 hours

export const adminCommandContentSchema = z.object({
  v: version,
  a: z.string(),
  // talk_publish / talk_reject moderate a submitted talk (F2, audit U11); args
  // carry { pubkey, talk_d }. `detach` (NIP §3.5) uninstalls the coordinator from
  // the event (no args) with the same effects as a config-based detach.
  cmd: z.enum(["approve", "recompute", "reprocess", "revoke", "talk_publish", "talk_reject", "detach"]),
  args: z.record(z.unknown()).default({}),
  // Replay horizon (NIP §3.4, required): unix seconds after which the command is
  // void. The coordinator skips an expired command on live delivery AND on backfill.
  expires: z.number().int(),
});
export type AdminCommandContent = z.infer<typeof adminCommandContentSchema>;

// ── Talk (spec F2, audit U11) ────────────────────────────────────────────────
// Upper bounds on talk metadata (kept small — the media carries the talk itself).
export const MAX_TALK_TITLE = 200;
export const MAX_TALK_DESC = 2000;

export const talkStatusSchema = z.enum(["pending", "published", "rejected"]);
export type TalkStatus = z.infer<typeof talkStatusSchema>;

// ── 21609 Talk Submission rumor content (attendee → E_inbox) ─────────────────
// v2 (additive, §8/§11): a talk's video can come from three sources —
//  - "recording": recorded in-browser, encrypted, uploaded to Blossom (`media`)
//  - "upload":    a local file, same encrypted-Blossom pipeline (`media`)
//  - "external":  a URL the speaker hosts elsewhere (`external_url`) — an
//                 unlisted YouTube link or a direct mp4 — for clips too large
//                 for Blossom (>~1 GB). The URL is carried INSIDE the already
//                 ECK/gift-wrap-encrypted content, so it is members-only even
//                 though the file it points at is not on Blossom. External talks
//                 are NEVER fetched by the coordinator (preserves the C3 SSRF
//                 allowlist), so they are view-only and never matched.
export const talkExternalKindSchema = z.enum(["youtube", "video"]);
export type TalkExternalKind = z.infer<typeof talkExternalKindSchema>;
export const talkSourceTypeSchema = z.enum(["recording", "upload", "external"]);
export type TalkSourceType = z.infer<typeof talkSourceTypeSchema>;

/**
 * A talk carries EITHER a Blossom `media` descriptor (recording/upload) or an
 * `external_url` (+ `external_kind`), never both and never neither. Shared by
 * the submission (21609) and published (31610) schemas.
 */
function refineTalkMediaSource(
  v: { media?: unknown; external_url?: string; external_kind?: string },
  ctx: z.RefinementCtx,
): void {
  const hasMedia = v.media !== undefined;
  const hasExternal = v.external_url !== undefined;
  if (hasMedia === hasExternal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a talk needs exactly one of `media` (recorded/uploaded) or `external_url` (YouTube/mp4)",
    });
    return;
  }
  if (hasMedia && (v.media as { kind?: string }).kind !== "talk") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["media"], message: "talk media must be kind:'talk'" });
  }
  if (hasExternal && v.external_kind === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["external_kind"],
      message: "external_kind (youtube|video) is required when external_url is set",
    });
  }
}

// A speaker submits (or edits) a prerecorded talk. `talk_d` is a stable id the
// speaker chooses once; editing resubmits with the SAME talk_d and a bumped
// `revision`, so the coordinator replaces the previous talk in place. `media` is a
// normal kind:"talk" descriptor (longer clip, max_talk_sec + pipeline segmentation),
// OR `external_url` points at a self-hosted/YouTube video. `process_for_matching`
// (default off) is the ONLY thing that opts a Blossom talk into coordinator STT +
// matching — talks are not fed into matching by default.
export const talkSubmissionContentSchema = z
  .object({
    v: version,
    a: z.string(), // coordinate
    talk_d: z.string().min(1).max(64), // stable per-speaker talk id (edit = same id)
    title: z.string().min(1).max(MAX_TALK_TITLE),
    description: z.string().max(MAX_TALK_DESC).default(""),
    speakers: z.array(hex32).default([]), // co-speakers; the submitter is implicit
    media: mediaDescriptorSchema.optional(),
    external_url: httpsUrl(2048).optional(),
    external_kind: talkExternalKindSchema.optional(),
    source_type: talkSourceTypeSchema.optional(),
    process_for_matching: z.boolean().default(false),
    revision: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine(refineTalkMediaSource);
export type TalkSubmissionContent = z.infer<typeof talkSubmissionContentSchema>;

// ── 31610 Talk content (ECK) ─────────────────────────────────────────────────
// Authored by the coordinator (or the organizer's E_id when there's no coordinator)
// under the ECK, so only members can discover/watch. Discovery = query
// {kinds:[31610], authors:[coordinator], "#a":[coordinate]}; the `d` is blinded per
// talk. `status` supports organizer moderation; `revision` supports editing (the
// last published talk stays watchable until a new revision publishes).
export const talkContentSchema = z
  .object({
    v: version,
    pubkey: hex32, // speaker (submitter)
    talk_d: z.string().min(1).max(64),
    title: z.string().min(1).max(MAX_TALK_TITLE),
    description: z.string().max(MAX_TALK_DESC).default(""),
    speakers: z.array(hex32).default([]),
    // Recording/upload → a Blossom `media` descriptor; external → `external_url`
    // (+ `external_kind`). Exactly one, as on the submission (§8/§11).
    media: mediaDescriptorSchema.optional(),
    external_url: httpsUrl(2048).optional(),
    external_kind: talkExternalKindSchema.optional(),
    source_type: talkSourceTypeSchema.optional(),
    // Reuses F1's transcript sub-schema: the nonvisual consumption path for talks.
    // Absent for external talks and for talks the speaker didn't opt into matching.
    transcript: mediaTranscriptSchema.optional(),
    lang: z.string(),
    revision: z.number().int().nonnegative(),
    status: talkStatusSchema,
    published_at: z.number().int(),
  })
  .superRefine(refineTalkMediaSource);
export type TalkContent = z.infer<typeof talkContentSchema>;

// ── 21610 Attendee Withdrawal rumor content (attendee → E_inbox) ─────────────
// The attendee removing THEMSELVES from the event, without organizer action. Sealed
// by the attendee's own account key; the coordinator binds the subject to the seal
// author (an attendee can only withdraw themselves). Same effect chain as an organizer
// `revoke` (roster/directory/match removal, NIP-09 deletions, ECK rotation). Ordering
// uses the §3.4 per-subject watermark, subject = the sender.
//
// `delete_data` (default true): full deletion — the coordinator also purges its stored
// processed artifacts (transcripts, ai_profile, pair-cache rows). `delete_data: false`
// removes the attendee from FUTURE publications but retains those artifacts so a later
// re-approval avoids reprocessing spend. `.strict()`: read off a relay and acted on, so
// an unexpected field is a hard error.
export const withdrawalContentSchema = z
  .object({
    v: version,
    a: z.string(), // coordinate this withdrawal applies to
    delete_data: z.boolean().default(true),
  })
  .strict();
export type WithdrawalContent = z.infer<typeof withdrawalContentSchema>;

// ── 21605 Organizer Grant rumor content (co-organizer, full key custody) ─────
export const organizerGrantContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate
  eid_nsec: secretKeyHex, // E_id secret (hex) — lets a co-organizer edit the event
  einbox_nsec: secretKeyHex, // E_inbox secret (hex) — read submissions + approve
  eck: z.array(eckVersionSchema),
  config_relays: z.array(z.string()).max(MAX_RELAYS),
  granted_by: hex32,
});
export type OrganizerGrantContent = z.infer<typeof organizerGrantContentSchema>;

// ── 31602 My Event Profile / intro library (self-encrypted) ──────────────────
// The `a:null` reuse-library entry is a SINGLE per-user store (its `d` is blinded
// over the literal "library", NOT over an event coordinate), so it spans every
// event the user joins. `intro_texts` carries authored TEXT intros for cross-event
// reuse — the text counterpart of the reusable `media` descriptors. It lives only
// on the `a:null` entry; per-event self-copies (a = coordinate) leave it unset.
export const myProfileContentSchema = z.object({
  v: version,
  a: z.string().nullable(), // null = the reuse-library entry
  profile: attendeeProfileSchema.optional(),
  media: z.array(mediaDescriptorSchema).max(MAX_MEDIA).default([]),
  intro_texts: z.array(z.string().max(MAX_INTRO_TEXT)).max(MAX_LIBRARY_TEXTS).optional(),
  // The per-(coordinate) profile-submission revision counter (NIP §3.3). The
  // per-event self-copy is the client's own durable store for per-event submission
  // state, so the `rev` last sent in a 21601 lives here and is bumped on every edit
  // (survives a device change, unlike a device-local counter). Absent on the
  // reuse-library entry and on pre-rev self-copies (treated as "no submission yet").
  rev: z.number().int().nonnegative().optional(),
});
export type MyProfileContent = z.infer<typeof myProfileContentSchema>;

// ── 31602 chat device-key backup RETIRED (NIP §6.2 / §10, decision D3) ───────
// The v1 shared-chat-identity design self-encrypted a remote-signer account's MLS
// device key as a per-user 31602 entry so a second browser could restore the SAME
// key. Wire v2 mints a per-DEVICE chat key for every account type — there is no
// shared key to back up or restore (a lost device is revoked, not recovered), so
// this schema variant and its app module are gone. See `docs/MULTIDEVICE-CHAT.md` §5.

// ── 31603 Directory Entry content (ECK) ──────────────────────────────────────
export const directoryEntryContentSchema = z
  .object({
    v: version,
    pubkey: hex32,
    // Display name from the join request: the roster must be able to show WHO
    // someone is even when their kind-0 is slow or unreachable on the event
    // relays (UX finding 2026-07-16). kind-0 stays the preferred source.
    name: z.string().max(MAX_NAME).optional(),
    profile: attendeeProfileSchema,
    media: z.array(mediaDescriptorSchema).max(MAX_MEDIA).default([]),
    ai_profile: aiProfileSchema.optional(), // appears when processing completes
    // Set when the subject corrected/hid fields of the generated ai_profile (F3):
    // viewers can be shown a subtle "edited by attendee" marker.
    ai_profile_edited: z.boolean().optional(),
    // Published transcripts (audit A1): the nonvisual consumption path. Each ties
    // to a media blob by `x`; the refine below rejects any that don't reference
    // live media, so a re-record (new `x`) can't surface a stale transcript.
    transcripts: z.array(mediaTranscriptSchema).optional(),
    // Echoes the authored text intro (spec F1) for display when there's no blob.
    intro_text: z.string().max(MAX_INTRO_TEXT).optional(),
    updated_at: z.number().int(),
  })
  .superRefine((val, ctx) => {
    if (!val.transcripts) return;
    const live = new Set(val.media.map((m) => m.x));
    val.transcripts.forEach((tr, i) => {
      if (!live.has(tr.x)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transcripts", i, "x"],
          message: "transcript.x must reference a media descriptor in this entry",
        });
      }
    });
  });
export type DirectoryEntryContent = z.infer<typeof directoryEntryContentSchema>;

// ── 21607 Chat Device Attestation rumor content (NIP §10.2, v2) ──────────────
// Binds a per-device chat key to an account. Every device (all account types, per
// decision D3) mints its own chat key and attests it: a 21607 rumor gift-wrapped
// attendee → coordinator, sealed (kind 13) by the *account* key (so the coordinator
// authenticates the binding as it authenticates a 21600 join) AND — for `op:"add"`
// — carrying a `proof` of possession: a BIP-340 signature by the chat DEVICE key
// over the §10.2 challenge (see `makeChatDeviceProof`). The coordinator MUST verify
// the proof before binding, closing v1's mis-binding/griefing gap. `op:"revoke"`
// (lost/retired device) needs no proof — the account is evicting a key it named,
// possession is irrelevant.

/** Human-readable per-device label ("Chrome on laptop"), user-editable (NIP §10.2). */
export const MAX_CHAT_KEY_LABEL = 60;
/** Stable per-device 30443 slot id carried in the attestation. */
export const MAX_CHAT_KEY_CLIENT_ID = 120;
/**
 * Concurrent device keys one account may hold per event (NIP §10.1).
 *
 * Raised 5 → 10 on 2026-07-29. Slots are consumed but never reclaimed by normal
 * use: clearing site data (or any state wipe) makes the app mint a FRESH chat
 * device key and attest it, while the old binding stays `active` forever because
 * nothing revokes it. An organizer debugging a stale-PWA incident burned all
 * five on one browser in an afternoon and was then permanently refused entry to
 * their own event's chat — "[chat] REJECTED 21607 add: account already at the
 * 5-device cap" — with the UI blaming an offline coordinator.
 *
 * 10 is headroom, not a fix: there is still no way to revoke a stale binding
 * (the 21607 `revoke` op exists in the protocol but nothing in the app sends
 * one), so slots still leak one per wipe and a heavy user will hit 10 eventually.
 * The real fix is a device list with a revoke action, or evicting the
 * least-recently-used binding when a new attestation arrives at the cap.
 */
export const MAX_CHAT_KEYS_PER_ACCOUNT = 10;

export const chatKeyAttestationContentSchema = z
  .object({
    v: version,
    a: z.string(), // coordinate this attestation applies to
    op: z.enum(["add", "revoke"]),
    chat_pubkey: hex32, // the per-device chat key (MLS account identity for this device)
    label: z.string().max(MAX_CHAT_KEY_LABEL).optional(), // required on add (see refine)
    client_id: z.string().max(MAX_CHAT_KEY_CLIENT_ID).optional(), // stable 30443 slot id
    proof: z.string().regex(/^[0-9a-f]{128}$/, "expected 128-hex schnorr sig").optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.op !== "add") return;
    // Proof of possession is REQUIRED on add — a device without one can't be bound
    // (the coordinator additionally re-verifies the signature). Label is required so
    // the roster/device UI always has a human name for the device.
    if (val.proof === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proof"],
        message: "proof of possession is required for op:'add'",
      });
    }
    if (val.label === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["label"],
        message: "label is required for op:'add'",
      });
    }
  });
export type ChatKeyAttestationContent = z.infer<typeof chatKeyAttestationContentSchema>;

// ── 31604 Roster content (ECK) ───────────────────────────────────────────────
// `chat_keys` (NIP §6.2 / §10.1): the per-DEVICE chat keys attested to each account
// (up to MAX_CHAT_KEYS_PER_ACCOUNT). Replaces v1's never-populated singular
// `chat_pubkey`; Nostrautica clients dedupe the member list by account and render
// per-device labels/revoke UI from it. Each entry carries the device pubkey, its
// human label, and when it was bound. Absent for attendees with no attested device
// (e.g. an account that hasn't opened chat).
//
// `nostr_group_id` (NIP §10.4): the routing id (445 `#h` tag) of this event's MLS
// group — the authoritative event→group binding an MLS Welcome cannot carry, so a
// member holding two same-coordinator events' groups binds deterministically to ITS
// OWN group instead of guessing (audit APPK-3). Absent for chat-off events and for
// coordinators/organizers that predate this field.

/** One attested per-device chat key on the roster (NIP §6.2). */
export const rosterChatKeySchema = z.object({
  pubkey: hex32, // the per-device chat key
  label: z.string().max(MAX_CHAT_KEY_LABEL).optional(),
  added_at: z.number().int(),
});
export type RosterChatKey = z.infer<typeof rosterChatKeySchema>;

export const rosterContentSchema = z.object({
  v: version,
  eck_current: z.number().int().positive(),
  nostr_group_id: hex32.optional(), // Marmot MLS routing id of this event's group (§10.4)
  attendees: z
    .array(
      z.object({
        pubkey: hex32,
        d: z.string().max(MAX_D), // entry's blinded d
        role: z.enum(["attendee", "organizer"]),
        // Per-device chat keys attested to this account (NIP §6.2), ≤ 5 per attendee.
        chat_keys: z.array(rosterChatKeySchema).max(MAX_CHAT_KEYS_PER_ACCOUNT).optional(),
      }),
    )
    .max(MAX_ROSTER),
});
export type RosterContent = z.infer<typeof rosterContentSchema>;

// ── 31605 Match List content (nip44 → recipient) ─────────────────────────────
export const matchSchema = z.object({
  pubkey: hex32,
  score: z.number(),
  similarity: z.number(),
  complementarity: z.number(),
  reasoning: z.string().max(MAX_REASONING),
  // Additive (NIP §6.2): ≤ 3 short conversation starters. A client without support
  // simply ignores the field; an oversized/overlong list is rejected at parse.
  icebreakers: z.array(z.string().max(MAX_ICEBREAKER)).max(MAX_ICEBREAKERS).optional(),
});
export type Match = z.infer<typeof matchSchema>;

export const matchListContentSchema = z.object({
  v: version,
  computed_at: z.number().int(),
  matches: z.array(matchSchema).max(MAX_MATCHES),
});
export type MatchListContent = z.infer<typeof matchListContentSchema>;

// ── 31606 Match Matrix content (ECK, opt-in) ─────────────────────────────────
export const matchMatrixContentSchema = z.object({
  v: version,
  computed_at: z.number().int(),
  pairs: z
    .array(z.object({ a: hex32, b: hex32, score: z.number() }))
    .max(MAX_MATCH_PAIRS),
});
export type MatchMatrixContent = z.infer<typeof matchMatrixContentSchema>;

// ── 31607 Members-only Event Post content (ECK ciphertext, spec §7.4) ────────
// ALL metadata lives inside the ciphertext — no public teasers. `published_at`
// is set on first publish and preserved across edits; `author` is an optional
// organizer attribution.
export const membersPostContentSchema = z.object({
  v: version,
  title: z.string().max(MAX_TITLE),
  summary: z.string().max(MAX_MESSAGE).optional(),
  image: z.string().max(MAX_URL).optional(),
  published_at: z.number().int(),
  author: hex32.optional(),
  content: z.string().max(MAX_POST_BODY), // markdown
});
export type MembersPostContent = z.infer<typeof membersPostContentSchema>;

// ── 31608 Event Page content (menu + layout, spec §7.4) ──────────────────────
// Public menu items live in `r` tags; public layout in `sections`; members-only
// additions in the ECK-encrypted `private` string, each with a `pos` index into
// the client-side merged list.
export const postsSectionSchema = z.object({
  type: z.literal("posts"),
  source: z.enum(["event", "attendees", "both"]),
  visibility: z.enum(["public", "members", "both"]),
});
export const pinnedSectionSchema = z.object({
  type: z.literal("pinned"),
  refs: z.array(z.string()), // naddr refs
});
export const attendeesSectionSchema = z.object({
  type: z.literal("attendees"), // roster preview — renders only for members
});
export const eventPageSectionSchema = z.discriminatedUnion("type", [
  postsSectionSchema,
  pinnedSectionSchema,
  attendeesSectionSchema,
]);
export type EventPageSection = z.infer<typeof eventPageSectionSchema>;

export const menuItemSchema = z.object({
  label: z.string().max(MAX_NAME),
  target: z.string().max(MAX_URL), // https: URL or nostr:naddr…
});
export type MenuItem = z.infer<typeof menuItemSchema>;

const pos = z.number().int().nonnegative();

export const eventPagePrivateSchema = z.object({
  v: version,
  menu: z.array(menuItemSchema.extend({ pos })).default([]),
  sections: z
    .array(
      z.discriminatedUnion("type", [
        postsSectionSchema.extend({ pos }),
        pinnedSectionSchema.extend({ pos }),
        attendeesSectionSchema.extend({ pos }),
      ]),
    )
    .default([]),
});
export type EventPagePrivate = z.infer<typeof eventPagePrivateSchema>;

export const eventPageContentSchema = z.object({
  v: version,
  sections: z.array(eventPageSectionSchema).default([]),
  private: z.string().optional(), // ECK ciphertext of eventPagePrivateSchema
});
export type EventPageContent = z.infer<typeof eventPageContentSchema>;

// ── 30078 user-private settings ──────────────────────────────────────────────
export const userSettingsSchema = z.object({
  v: version,
  theme: z.enum(["light", "dark", "system"]).default("system"),
  language: z.string().max(MAX_LANG).default("en"),
  relays: z.array(z.string().max(MAX_URL)).max(MAX_RELAYS).default([]),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const perEventSettingsSchema = z.object({
  v: version,
  favorites: z.array(hex32).max(MAX_ROSTER).default([]),
  want_to_meet: z.array(hex32).max(MAX_ROSTER).default([]),
  met: z.array(hex32).max(MAX_ROSTER).default([]),
  // Bound both the per-note length and the number of notes (audit P2): an
  // unbounded record is a DoS vector and can push the payload past the NIP-44
  // ceiling.
  notes: z
    .record(z.string().max(MAX_NOTE))
    .refine((r) => Object.keys(r).length <= MAX_NOTES, {
      message: `too many notes (max ${MAX_NOTES})`,
    })
    .default({}),
});
export type PerEventSettings = z.infer<typeof perEventSettingsSchema>;

// ── 30078 DM read state (`d = nostrautica:dmread`) ───────────────────────────
// The newest INCOMING message each DM thread has been read up to, so unread
// badges agree across an account's devices instead of every device counting from
// scratch. User-private: the peer pubkeys live inside the NIP-44 self-encrypted
// content, so a relay learns only that the account wrote a read-state event.
//
// Bounded because the whole map rides in ONE NIP-44 payload (65535-byte plaintext
// ceiling). An entry serializes to roughly 155 bytes, so 200 threads is ~31 KB of
// plaintext — comfortably inside the ceiling and inside relay event-size limits.
// Publishers prune to the most recently read MAX_DM_READ_THREADS.
export const MAX_DM_READ_THREADS = 200;

/** A read position: the rumor's `created_at` plus its id, which breaks ties. */
export const dmReadPositionSchema = z.object({
  at: z.number().int().nonnegative(),
  id: hex32,
});
export type DmReadPosition = z.infer<typeof dmReadPositionSchema>;

export const dmReadStateSchema = z.object({
  v: version,
  threads: z
    .record(hex32, dmReadPositionSchema)
    .refine((r) => Object.keys(r).length <= MAX_DM_READ_THREADS, {
      message: `too many read threads (max ${MAX_DM_READ_THREADS})`,
    })
    .default({}),
});
export type DmReadState = z.infer<typeof dmReadStateSchema>;

export const eventKeysBackupSchema = z.object({
  v: version,
  // Event coordinate (`31923:<E_id pubkey>:<d>`). Optional for backward-compat
  // with backups written before it was recorded — recovery falls back to
  // deriving it from the E_id key + the published config when absent.
  a: z.string().optional(),
  eid_nsec: secretKeyHex,
  einbox_nsec: secretKeyHex,
  eck: z.array(eckVersionSchema),
  // Last coordinator install generation the organizer used (NIP §3.5). Absent = 0
  // (never attached, or a backup written before generations); a re-attach reads it
  // back and uses lastGen + 1, so generations strictly increase across devices.
  coordinator_gen: z.number().int().nonnegative().optional(),
});
export type EventKeysBackup = z.infer<typeof eventKeysBackupSchema>;

// ── 21606 Coordinator Status rumor content (poison surfacing, audit Q12) ─────
// When a pipeline job exhausts its retries the coordinator gift-wraps this to the
// organizer (E_id) so a poisoned job is visible without server logs. The Admin UI
// half is app-side. `error_category` is a sanitized class, never attendee text.
/**
 * Billing signal a coordinator sends the organizer (docs/COORDINATOR-DISCOVERY-PLAN.md,
 * Part 3). Payment itself is NOT handled here — `checkout_url` is a link the app
 * opens (the app appends the event identifier). A free coordinator sends `ok` or
 * omits billing entirely.
 */
export const coordinatorBillingSchema = z.object({
  state: z.enum(["ok", "payment_required", "grace"]),
  reason: z.string().max(500).optional(), // human message ("exceeds 20-user free tier")
  checkout_url: httpsUrl(2048).optional(),
  due: z.number().nonnegative().optional(), // amount, optional (may be negotiated)
  currency: z.string().max(16).optional(),
  grace_until: z.number().int().optional(), // unix; matching continues until then
});
export type CoordinatorBilling = z.infer<typeof coordinatorBillingSchema>;

// A 21606 status is EITHER a poison/health report (poison fields present) OR a
// billing update (`billing` present) OR both — so the poison-specific fields are
// optional. `v`, `a`, `at` are always present. Existing poison statuses (all
// fields set) parse unchanged.
export const coordinatorStatusContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate
  pubkey: hex32.optional(), // affected attendee, when the job is attendee-scoped
  stage: z.string().optional(), // job type (e.g. "process_attendee")
  state: z.enum(["poison", "cleared"]).optional(),
  attempts: z.number().int().nonnegative().optional(),
  error_category: z.string().optional(), // sanitized category, no prompts/attendee text
  retryable: z.boolean().optional(),
  billing: coordinatorBillingSchema.optional(),
  at: z.number().int(),
});
export type CoordinatorStatusContent = z.infer<typeof coordinatorStatusContentSchema>;

// ── 31611 Coordinator Announcement (discovery) ───────────────────────────────
export const coordinatorPricingSchema = z.object({
  // How billing works — NOT necessarily the amount (may be negotiated off-band).
  model: z.enum(["free", "per_user", "per_event", "negotiated", "external"]),
  free_up_to_users: z.number().int().nonnegative().optional(),
  summary: z.string().max(280).optional(), // one-line human pricing summary
  checkout_url: httpsUrl(2048).optional(),
  currency: z.string().max(16).optional(),
});
export type CoordinatorPricing = z.infer<typeof coordinatorPricingSchema>;

export const coordinatorAnnounceSchema = z.object({
  v: version,
  name: z.string().min(1).max(120),
  about: z.string().max(2000).optional(),
  picture: z.string().max(2048).optional(),
  operator: z.string().max(200).optional(),
  relays: z.array(z.string()).max(MAX_RELAYS).default([]),
  features: z
    .object({
      matching: z.boolean().default(true),
      talks: z.boolean().default(false),
      chat: z.array(z.string()).max(MAX_RELAYS).default([]),
    })
    .default({}),
  // Per-role privacy disclosure (role → tier string, e.g. "private"/"non-private").
  privacy: z.record(z.string(), z.string()).optional(),
  terms_url: httpsUrl(2048).optional(),
  pricing: coordinatorPricingSchema.optional(),
});
export type CoordinatorAnnounce = z.infer<typeof coordinatorAnnounceSchema>;

/**
 * Parse-and-validate helper. Throws `NewerProtocolVersionError` when the payload
 * declares an integer `v` newer than this client (so callers can prompt an
 * update, NIP §2 / D2), and the underlying `ZodError` otherwise.
 */
export function parsePayload<T>(schema: z.ZodType<T>, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (res.success) return res.data;
  const v = readPayloadVersion(raw);
  if (v !== undefined && v > PROTOCOL_VERSION) throw new NewerProtocolVersionError(v);
  throw res.error;
}
