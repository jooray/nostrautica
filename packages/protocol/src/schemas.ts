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

// ── Media descriptor (spec §6.2) ─────────────────────────────────────────────
export const mediaDescriptorSchema = z.object({
  kind: z.enum(["intro", "talk"]),
  url: z.array(z.string().url()).min(1),
  x: hex32, // sha256 of ciphertext
  ox: hex32, // sha256 of plaintext
  size: z.number().int().nonnegative(),
  m: z.string(), // mime type
  duration: z.number().nonnegative().optional(),
  "encryption-algorithm": z.literal("aes-gcm"),
  "decryption-key": base64, // 32 bytes b64
  "decryption-nonce": base64, // 12 bytes b64
});
export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;

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
});
export type ProfileSubmissionContent = z.infer<
  typeof profileSubmissionContentSchema
>;

// ── 21602 Key Grant rumor content ────────────────────────────────────────────
export const eckVersionSchema = z.object({
  id: z.number().int().positive(),
  key: base64, // 32 bytes b64
});
export type EckVersion = z.infer<typeof eckVersionSchema>;

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
  inbox_nsec: z.string(), // hex privkey of E_inbox
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
  eid_nsec: z.string(), // E_id secret (hex) — lets a co-organizer edit the event
  einbox_nsec: z.string(), // E_inbox secret (hex) — read submissions + approve
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
export const directoryEntryContentSchema = z.object({
  v: version,
  pubkey: hex32,
  profile: attendeeProfileSchema,
  media: z.array(mediaDescriptorSchema).default([]),
  ai_profile: aiProfileSchema.optional(), // appears when processing completes
  updated_at: z.number().int(),
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
  eid_nsec: z.string(),
  einbox_nsec: z.string(),
  eck: z.array(eckVersionSchema),
});
export type EventKeysBackup = z.infer<typeof eventKeysBackupSchema>;

/** Parse-and-validate helper that throws a descriptive error on mismatch. */
export function parsePayload<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}
