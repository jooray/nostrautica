/**
 * Zod schemas for every encrypted/JSON payload in spec §7. Every payload is
 * versioned (`"v": 1`). These validate what we parse off relays before trusting
 * it — malformed or hostile payloads are rejected at the boundary.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const version = z.literal(1).or(z.number().int().positive()); // accept v1; forward-tolerant

const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, "expected 32-byte hex");
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

/** An https: URL (C3: block non-https media/fetch targets at the boundary). */
const httpsUrl = z
  .string()
  .url()
  .refine((u) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

// ── Media descriptor (spec §6.2) ─────────────────────────────────────────────
// `.strict()` (Q6): a media descriptor drives coordinator fetch + ffmpeg, so an
// unexpected field is rejected rather than silently ignored. Key/nonce lengths are
// validated (C3) so a malformed descriptor can't reach the crypto layer.
export const mediaDescriptorSchema = z
  .object({
    kind: z.enum(["intro", "talk"]),
    url: z.array(httpsUrl).min(1),
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

// ── Profile (used inside submissions & directory) ────────────────────────────
export const attendeeProfileSchema = z.object({
  about: z.string().default(""),
  skills: z.array(z.string()).default([]),
  looking_for: z.string().default(""),
  links: z.array(z.string()).default([]),
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
  invites: z.array(
    z.object({
      h: hex32, // sha256(invite-pubkey) hex
      label: z.string().optional(),
    }),
  ),
});
export type InviteListContent = z.infer<typeof inviteListContentSchema>;

// ── 21600 Join Request rumor content ─────────────────────────────────────────
export const joinRequestContentSchema = z.object({
  v: version,
  name: z.string(),
  message: z.string().default(""),
  rsvp_public: z.boolean().default(false),
});
export type JoinRequestContent = z.infer<typeof joinRequestContentSchema>;

// ── 21601 Profile Submission rumor content ───────────────────────────────────
export const profileSubmissionContentSchema = z.object({
  v: version,
  profile: attendeeProfileSchema,
  media: z.array(mediaDescriptorSchema).default([]),
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
  config_relays: z.array(z.string()),
});
export type CoordinatorGrantContent = z.infer<
  typeof coordinatorGrantContentSchema
>;

// ── 21604 Admin Command rumor content ────────────────────────────────────────
export const adminCommandContentSchema = z.object({
  v: version,
  a: z.string(),
  cmd: z.enum(["approve", "recompute", "reprocess", "revoke"]),
  args: z.record(z.unknown()).default({}),
});
export type AdminCommandContent = z.infer<typeof adminCommandContentSchema>;

// ── 21605 Organizer Grant rumor content (co-organizer, full key custody) ─────
export const organizerGrantContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate
  eid_nsec: secretKeyHex, // E_id secret (hex) — lets a co-organizer edit the event
  einbox_nsec: secretKeyHex, // E_inbox secret (hex) — read submissions + approve
  eck: z.array(eckVersionSchema),
  config_relays: z.array(z.string()),
  granted_by: hex32,
});
export type OrganizerGrantContent = z.infer<typeof organizerGrantContentSchema>;

// ── 31602 My Event Profile / intro library (self-encrypted) ──────────────────
export const myProfileContentSchema = z.object({
  v: version,
  a: z.string().nullable(), // null = the reuse-library entry
  profile: attendeeProfileSchema.optional(),
  media: z.array(mediaDescriptorSchema).default([]),
});
export type MyProfileContent = z.infer<typeof myProfileContentSchema>;

// ── 31603 Directory Entry content (ECK) ──────────────────────────────────────
export const directoryEntryContentSchema = z
  .object({
    v: version,
    pubkey: hex32,
    profile: attendeeProfileSchema,
    media: z.array(mediaDescriptorSchema).default([]),
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

// ── 31604 Roster content (ECK) ───────────────────────────────────────────────
export const rosterContentSchema = z.object({
  v: version,
  eck_current: z.number().int().positive(),
  attendees: z.array(
    z.object({
      pubkey: hex32,
      d: z.string(), // entry's blinded d
      role: z.enum(["attendee", "organizer"]),
    }),
  ),
});
export type RosterContent = z.infer<typeof rosterContentSchema>;

// ── 31605 Match List content (nip44 → recipient) ─────────────────────────────
export const matchSchema = z.object({
  pubkey: hex32,
  score: z.number(),
  similarity: z.number(),
  complementarity: z.number(),
  reasoning: z.string(),
});
export type Match = z.infer<typeof matchSchema>;

export const matchListContentSchema = z.object({
  v: version,
  computed_at: z.number().int(),
  matches: z.array(matchSchema),
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
  relays: z.array(z.string()).default([]),
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
  eid_nsec: secretKeyHex,
  einbox_nsec: secretKeyHex,
  eck: z.array(eckVersionSchema),
});
export type EventKeysBackup = z.infer<typeof eventKeysBackupSchema>;

// ── 21606 Coordinator Status rumor content (poison surfacing, audit Q12) ─────
// When a pipeline job exhausts its retries the coordinator gift-wraps this to the
// organizer (E_id) so a poisoned job is visible without server logs. The Admin UI
// half is app-side. `error_category` is a sanitized class, never attendee text.
export const coordinatorStatusContentSchema = z.object({
  v: version,
  a: z.string(), // coordinate
  pubkey: hex32.optional(), // affected attendee, when the job is attendee-scoped
  stage: z.string(), // job type (e.g. "process_attendee")
  state: z.enum(["poison", "cleared"]),
  attempts: z.number().int().nonnegative(),
  error_category: z.string(), // sanitized category, no prompts/attendee text
  retryable: z.boolean(),
  at: z.number().int(),
});
export type CoordinatorStatusContent = z.infer<typeof coordinatorStatusContentSchema>;

/** Parse-and-validate helper that throws a descriptive error on mismatch. */
export function parsePayload<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}
