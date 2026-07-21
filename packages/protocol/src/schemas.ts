/**
 * Zod schemas for every encrypted/JSON payload in spec §7. Every payload is
 * versioned (`"v": 1`). These validate what we parse off relays before trusting
 * it — malformed or hostile payloads are rejected at the boundary.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const version = z.literal(1).or(z.number().int().positive()); // accept v1; forward-tolerant

// Lowercase-only (audit PROTO-6): every downstream comparison is case-sensitive,
// so an uppercase-A-F pubkey that validated could never match anything.
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32-byte hex");
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64");

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
export const mediaDescriptorSchema = z
  .object({
    kind: z.enum(["intro", "talk"]),
    url: z.array(httpsUrl()).min(1),
    x: hex32, // sha256 of ciphertext
    ox: hex32, // sha256 of plaintext
    size: z.number().int().nonnegative(),
    m: z.string(), // mime type
    duration: z.number().nonnegative().optional(),
    "encryption-algorithm": z.literal("aes-gcm"),
    "decryption-key": base64Bytes(32, "decryption-key"), // 32 bytes b64
    "decryption-nonce": base64Bytes(12, "decryption-nonce"), // 12 bytes b64
  })
  .strict();
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;

// Pre-upload draft: identical to mediaDescriptorSchema but `url` may be empty,
// because the Blossom https URLs are only known AFTER the ciphertext is uploaded.
// `encryptMedia` validates this draft at encrypt time; the finalized descriptor
// (real https URLs filled in) is validated against the strict schema at upload
// time. Without this, encrypting an intro throws on the placeholder URL before a
// single byte is uploaded.
export const mediaDescriptorDraftSchema = mediaDescriptorSchema
  .extend({ url: z.array(z.string()) })
  .strict();

// ── Media transcript (spec §9.2, audit A1) ───────────────────────────────────
// A transcript tied to a specific media blob by its ciphertext hash `x`. The
// coordinator publishes these on the directory entry so a deaf/screen-reader
// attendee has a nonvisual path to any intro. `.strict()`: a transcript is read
// off a relay and rendered as trusted text, so an unexpected field is rejected.
// Because `x` is content-addressed, re-recording an intro changes `x` and orphans
// the old transcript — the directory-entry schema below validates that every
// transcript still references live media (stale transcripts are dropped).
export const mediaTranscriptSchema = z
  .object({
    x: hex32, // the media descriptor's `x` this transcript belongs to
    text: z.string(),
    lang: z.string(), // ISO-639-1 detected by STT, or the authored source language
    source: z.enum(["stt", "authored"]),
    updated_at: z.number().int(),
  })
  .strict();
export type MediaTranscript = z.infer<typeof mediaTranscriptSchema>;

/** Upper bound on a text intro / authored transcript (spec F1, ~2000 chars). */
export const MAX_INTRO_TEXT = 2000;

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
export const MAX_ROSTER = 2000; // 31604 attendees array items
export const MAX_RELAYS = 30; // relay URL array items
export const MAX_MEDIA = 20; // media descriptors per payload

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
  lang: z.string(), // target (event) language, ISO 639-1
  about: z.string().optional(),
  looking_for: z.string().optional(),
  skills: z.array(z.string()).optional(),
});
export type ProfileTranslation = z.infer<typeof profileTranslationSchema>;

export const aiProfileSchema = z.object({
  summary: z.string(),
  skills: z.array(z.string()),
  interests: z.array(z.string()),
  offers: z.array(z.string()),
  seeks: z.array(z.string()),
  // Present when the attendee's own profile language differs from the event's.
  translations: profileTranslationSchema.optional(),
});
export type AiProfile = z.infer<typeof aiProfileSchema>;

// ── 31601 Invite List content ────────────────────────────────────────────────
export const inviteListContentSchema = z.object({
  v: version,
  invites: z
    .array(
      z.object({
        h: hex32, // sha256(invite-pubkey) hex
        label: z.string().max(MAX_INVITE_LABEL).optional(),
      }),
    )
    .max(MAX_INVITES),
});
export type InviteListContent = z.infer<typeof inviteListContentSchema>;

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
  profile: attendeeProfileSchema,
  media: z.array(mediaDescriptorSchema).max(MAX_MEDIA).default([]),
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

/** Per-field overrides of the generated ai_profile. */
export const aiProfileOverrideSchema = z.object({
  summary: z.string().optional(),
  skills: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  offers: z.array(z.string()).optional(),
  seeks: z.array(z.string()).optional(),
});
export type AiProfileOverride = z.infer<typeof aiProfileOverrideSchema>;

export const profileCorrectionContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate this correction applies to
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
  a: z.string(), // coordinate
  role: z.enum(["attendee", "organizer"]),
  eck: z.array(eckVersionSchema),
  granted_by: hex32,
});
export type KeyGrantContent = z.infer<typeof keyGrantContentSchema>;

// ── 21603 Coordinator Grant rumor content ────────────────────────────────────
export const coordinatorGrantContentSchema = z.object({
  v: version,
  a: z.string(),
  inbox_nsec: secretKeyHex, // hex privkey of E_inbox
  eck: z.array(eckVersionSchema),
  config_relays: z.array(z.string()).max(MAX_RELAYS),
});
export type CoordinatorGrantContent = z.infer<
  typeof coordinatorGrantContentSchema
>;

// ── 21604 Admin Command rumor content ────────────────────────────────────────
export const adminCommandContentSchema = z.object({
  v: version,
  a: z.string(),
  // talk_publish / talk_reject moderate a submitted talk (F2, audit U11); args
  // carry { pubkey, talk_d }.
  cmd: z.enum(["approve", "recompute", "reprocess", "revoke", "talk_publish", "talk_reject"]),
  args: z.record(z.unknown()).default({}),
});
export type AdminCommandContent = z.infer<typeof adminCommandContentSchema>;

// ── Talk (spec F2, audit U11) ────────────────────────────────────────────────
// Upper bounds on talk metadata (kept small — the media carries the talk itself).
export const MAX_TALK_TITLE = 200;
export const MAX_TALK_DESC = 2000;

export const talkStatusSchema = z.enum(["pending", "published", "rejected"]);
export type TalkStatus = z.infer<typeof talkStatusSchema>;

// ── 21609 Talk Submission rumor content (attendee → E_inbox) ─────────────────
// A speaker submits (or edits) a prerecorded talk. `talk_d` is a stable id the
// speaker chooses once; editing resubmits with the SAME talk_d and a bumped
// `revision`, so the coordinator replaces the previous talk in place. The media is
// a normal kind:"talk" descriptor (longer clip, max_talk_sec + pipeline segmentation).
export const talkSubmissionContentSchema = z
  .object({
    v: version,
    a: z.string(), // coordinate
    talk_d: z.string().min(1).max(64), // stable per-speaker talk id (edit = same id)
    title: z.string().min(1).max(MAX_TALK_TITLE),
    description: z.string().max(MAX_TALK_DESC).default(""),
    speakers: z.array(hex32).default([]), // co-speakers; the submitter is implicit
    media: mediaDescriptorSchema,
    revision: z.number().int().nonnegative().default(0),
  })
  .strict()
  .refine((v) => v.media.kind === "talk", "talk submission media must be kind:'talk'");
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
    media: mediaDescriptorSchema,
    // Reuses F1's transcript sub-schema: the nonvisual consumption path for talks.
    transcript: mediaTranscriptSchema.optional(),
    lang: z.string(),
    revision: z.number().int().nonnegative(),
    status: talkStatusSchema,
    published_at: z.number().int(),
  })
  .refine((v) => v.media.kind === "talk", "talk media must be kind:'talk'");
export type TalkContent = z.infer<typeof talkContentSchema>;

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
export const myProfileContentSchema = z.object({
  v: version,
  a: z.string().nullable(), // null = the reuse-library entry
  profile: attendeeProfileSchema.optional(),
  media: z.array(mediaDescriptorSchema).max(MAX_MEDIA).default([]),
});
export type MyProfileContent = z.infer<typeof myProfileContentSchema>;

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

// ── 21607 Chat-key Attestation rumor content (Marmot §3.3) ───────────────────
// Binds an app-generated chat *device* key to an account, for NIP-46/NIP-07 users
// who cannot raw-sign the mandatory MLS account-identity-proof with their account
// key. Gift-wrapped attendee → coordinator, sealed (kind 13) by the *account* key,
// so the coordinator authenticates the binding exactly as it authenticates a 21600
// join (seal author = the enrolled account npub). `op:"revoke"` (lost device) tells
// the coordinator to remove that chat key's leaves and stop re-adding it.
export const chatKeyAttestationContentSchema = z
  .object({
    v: version,
    a: z.string(), // coordinate this attestation applies to
    op: z.enum(["add", "revoke"]),
    chat_pubkey: hex32, // the app-generated chat device key (MLS account identity)
    client_id: z.string().optional(), // stable per-device 30443 slot id
  })
  .strict();
export type ChatKeyAttestationContent = z.infer<typeof chatKeyAttestationContentSchema>;

// ── 31604 Roster content (ECK) ───────────────────────────────────────────────
// `chat_pubkey` (Marmot §4.4, additive — old clients ignore it): for NIP-46/NIP-07
// attendees whose MLS identity is a separate chat device key, this maps the chat
// npub back to the account so the chat UI can render members as people. Absent for
// local-key attendees (their account key IS the chat identity).
export const rosterContentSchema = z.object({
  v: version,
  eck_current: z.number().int().positive(),
  attendees: z
    .array(
      z.object({
        pubkey: hex32,
        d: z.string(), // entry's blinded d
        role: z.enum(["attendee", "organizer"]),
        chat_pubkey: hex32.optional(), // Marmot chat device key, when distinct (§4.4)
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
  pairs: z.array(
    z.object({ a: hex32, b: hex32, score: z.number() }),
  ),
});
export type MatchMatrixContent = z.infer<typeof matchMatrixContentSchema>;

// ── 31607 Members-only Event Post content (ECK ciphertext, spec §7.4) ────────
// ALL metadata lives inside the ciphertext — no public teasers. `published_at`
// is set on first publish and preserved across edits; `author` is an optional
// organizer attribution.
export const membersPostContentSchema = z.object({
  v: version,
  title: z.string(),
  summary: z.string().optional(),
  image: z.string().optional(),
  published_at: z.number().int(),
  author: hex32.optional(),
  content: z.string(), // markdown
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
  label: z.string(),
  target: z.string(), // https: URL or nostr:naddr…
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
  language: z.string().default("en"),
  relays: z.array(z.string()).max(MAX_RELAYS).default([]),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const perEventSettingsSchema = z.object({
  v: version,
  favorites: z.array(hex32).default([]),
  want_to_meet: z.array(hex32).default([]),
  met: z.array(hex32).default([]),
  notes: z.record(z.string()).default({}),
});
export type PerEventSettings = z.infer<typeof perEventSettingsSchema>;

export const eventKeysBackupSchema = z.object({
  v: version,
  // Event coordinate (`31923:<E_id pubkey>:<d>`). Optional for backward-compat
  // with backups written before it was recorded — recovery falls back to
  // deriving it from the E_id key + the published config when absent.
  a: z.string().optional(),
  eid_nsec: secretKeyHex,
  einbox_nsec: secretKeyHex,
  eck: z.array(eckVersionSchema),
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

/** Parse-and-validate helper that throws a descriptive error on mismatch. */
export function parsePayload<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}
