/**
 * The typed custom-kind registry (audit §13.1 Option A): the compiled,
 * single-source-of-truth index of every custom event kind Nostrautica defines.
 * It identifies each kind's constant, number, class, content-schema export,
 * author/recipient, and sealing — and the reference tables in
 * `docs/PROTOCOL-REGISTRY.md` are GENERATED from it (`pnpm gen:registry`), with
 * a test that fails if the committed doc drifts from this source.
 *
 * `docs/PROTOCOL-NIP.md` stays the handwritten normative spec — this file only
 * governs the mechanical allocation/table surface, not the security rationale.
 *
 * Invariants asserted in registry.test.ts:
 *  - every custom `KIND_*` constant in the custom ranges appears here exactly once;
 *  - every entry's `constant` resolves to its `kind`;
 *  - the addressable kinds are EXACTLY 31600–31611 and the rumor kinds EXACTLY
 *    21600–21610;
 *  - every rumor-class kind is in `RUMOR_KINDS`;
 *  - every non-null `schemaExport` is a real export of the schemas module.
 */
import {
  KIND_EVENT_CONFIG,
  KIND_INVITE_LIST,
  KIND_MY_PROFILE,
  KIND_DIRECTORY_ENTRY,
  KIND_ROSTER,
  KIND_MATCH_LIST,
  KIND_MATCH_MATRIX,
  KIND_MEMBERS_POST,
  KIND_EVENT_PAGE,
  KIND_EVENT_THEME,
  KIND_TALK,
  KIND_COORDINATOR_ANNOUNCE,
  KIND_JOIN_REQUEST,
  KIND_PROFILE_SUBMISSION,
  KIND_KEY_GRANT,
  KIND_COORDINATOR_GRANT,
  KIND_ADMIN_COMMAND,
  KIND_ORGANIZER_GRANT,
  KIND_COORDINATOR_STATUS,
  KIND_CHAT_KEY_ATTESTATION,
  KIND_PROFILE_CORRECTION,
  KIND_TALK_SUBMISSION,
  KIND_ATTENDEE_WITHDRAWAL,
} from "./kinds.js";

/** Typed sealing/protection class — the machine-checkable field. */
export type Sealing = "public" | "eck" | "nip44" | "self-encrypt" | "gift-wrap";

export interface CustomKindEntry {
  /** The exported `KIND_*` constant name in kinds.ts. */
  constant: string;
  /** The kind number. */
  kind: number;
  /** Human-readable name (as rendered in the registry doc). */
  name: string;
  /** `addressable` (31600–31611) or `rumor` (21600–21610, gift-wrapped). */
  klass: "addressable" | "rumor";
  /** Content-schema export in schemas.ts, or null for tag/CSS-encoded kinds. */
  schemaExport: string | null;
  /** Typed sealing class (the invariant). */
  sealing: Sealing;
  /** "Author" (addressable) / "Seal author → recipient" (rumor). */
  author: string;
  /** "Protection and address" prose (addressable only). */
  protection?: string;
  /** "Authority / lifecycle" (addressable) or "Ordering / notes" (rumor). */
  notes: string;
}

export const CUSTOM_KIND_REGISTRY: readonly CustomKindEntry[] = [
  // ── addressable (31600–31611) ──────────────────────────────────────────────
  {
    constant: "KIND_EVENT_CONFIG",
    kind: KIND_EVENT_CONFIG,
    name: "Event Networking Config",
    klass: "addressable",
    schemaExport: null, // tag-encoded (see config.ts parseEventConfig)
    sealing: "public",
    author: "`E_id`",
    protection: "Public; `d` = calendar-event `d`",
    notes:
      "Tags configure inbox, relays, Blossom, coordinator (+ install generation), limits, approval, matching, language, talks, chat, and retention. Only `E_id` may publish. Newest valid config is the root of trust for every other kind.",
  },
  {
    constant: "KIND_INVITE_LIST",
    kind: KIND_INVITE_LIST,
    name: "Invite List",
    klass: "addressable",
    schemaExport: "inviteListContentSchema",
    sealing: "public",
    author: "`E_id`",
    protection: "Public, hash-hidden; `d` = event `d`",
    notes:
      "JSON invite hash list, ≤10,000 entries. Only `E_id` may publish. Voiding = republishing without the hash.",
  },
  {
    constant: "KIND_MY_PROFILE",
    kind: KIND_MY_PROFILE,
    name: "Self-encrypted profile / reuse library",
    klass: "addressable",
    schemaExport: "myProfileContentSchema",
    sealing: "self-encrypt",
    author: "Attendee account",
    protection: "NIP-44 self-encrypted; blinded `d`",
    notes:
      "Per-event self-copy (`a` = coordinate) and cross-event reuse library (`a: null`), same content schema.",
  },
  {
    constant: "KIND_DIRECTORY_ENTRY",
    kind: KIND_DIRECTORY_ENTRY,
    name: "Directory Entry",
    klass: "addressable",
    schemaExport: "directoryEntryContentSchema",
    sealing: "eck",
    author: "Coordinator, or `E_id` without one",
    protection: "ECK-encrypted; ECK-blinded `d`",
    notes:
      "One approved attendee's profile/media/transcripts/derived profile. Replaced when profile or derived output changes; NIP-09-deleted on revocation or withdrawal. Readers accept only the coordinator currently named in the newest `31600`, or `E_id`.",
  },
  {
    constant: "KIND_ROSTER",
    kind: KIND_ROSTER,
    name: "Roster",
    klass: "addressable",
    schemaExport: "rosterContentSchema",
    sealing: "eck",
    author: "Coordinator, or `E_id` without one",
    protection: "ECK-encrypted; `d` = event `d`",
    notes:
      "Approved-attendee index, current ECK version, per-device `chat_keys`, and the active Marmot `nostr_group_id` when chat is on. Latest valid roster wins; `nostr_group_id` is the authoritative event→group binding.",
  },
  {
    constant: "KIND_MATCH_LIST",
    kind: KIND_MATCH_LIST,
    name: "Match List",
    klass: "addressable",
    schemaExport: "matchListContentSchema",
    sealing: "nip44",
    author: "Coordinator",
    protection: "NIP-44 coordinator→recipient; ECK-blinded `d`",
    notes:
      "Directional match reasoning (+ optional icebreakers) for one recipient. Replaced after scoring or ECK rotation.",
  },
  {
    constant: "KIND_MATCH_MATRIX",
    kind: KIND_MATCH_MATRIX,
    name: "Match Matrix",
    klass: "addressable",
    schemaExport: "matchMatrixContentSchema",
    sealing: "eck",
    author: "Coordinator",
    protection: "ECK-encrypted; `d` = event `d`",
    notes:
      "Event-wide score-only matrix; published only when `match_visibility: event`. Deleted when visibility changes away from it.",
  },
  {
    constant: "KIND_MEMBERS_POST",
    kind: KIND_MEMBERS_POST,
    name: "Members-only Event Post",
    klass: "addressable",
    schemaExport: "membersPostContentSchema",
    sealing: "eck",
    author: "`E_id`",
    protection: "ECK-encrypted; random stable `d`",
    notes:
      "Official members-only post. Same `d` on edit; old ciphertext stays readable to whoever held the ECK version it was published under.",
  },
  {
    constant: "KIND_EVENT_PAGE",
    kind: KIND_EVENT_PAGE,
    name: "Event Page",
    klass: "addressable",
    schemaExport: "eventPageContentSchema",
    sealing: "public",
    author: "`E_id`",
    protection: "Public sections + optional ECK-encrypted `private`; `d` = event `d`",
    notes: "Official menu and layout. Latest valid page wins.",
  },
  {
    constant: "KIND_EVENT_THEME",
    kind: KIND_EVENT_THEME,
    name: "Event Theme",
    klass: "addressable",
    schemaExport: null, // raw CSS, no content schema (MAX_THEME_CSS_BYTES bound)
    sealing: "public",
    author: "`E_id`",
    protection: "Public raw CSS; `d` = event `d`",
    notes:
      "Organizer-controlled presentation. Not a secret-safe rendering boundary — clients must not render it on routes carrying secrets.",
  },
  {
    constant: "KIND_TALK",
    kind: KIND_TALK,
    name: "Talk",
    klass: "addressable",
    schemaExport: "talkContentSchema",
    sealing: "eck",
    author: "Coordinator, or `E_id` without one",
    protection: "ECK-encrypted; talk/ECK-blinded `d`",
    notes:
      "Moderated prerecorded talk, transcript, language, revision, status. Republished under a new address on ECK rotation; old address NIP-09-deleted.",
  },
  {
    constant: "KIND_COORDINATOR_ANNOUNCE",
    kind: KIND_COORDINATOR_ANNOUNCE,
    name: "Coordinator Announcement",
    klass: "addressable",
    schemaExport: "coordinatorAnnounceSchema",
    sealing: "public",
    author: "Coordinator",
    protection: "Public; `d = nostrautica:coordinator`",
    notes:
      "Discovery name, capabilities, resolved-route privacy disclosure, relays, optional pricing. Latest announcement per coordinator wins.",
  },
  // ── gift-wrapped rumors (21600–21610) ──────────────────────────────────────
  {
    constant: "KIND_JOIN_REQUEST",
    kind: KIND_JOIN_REQUEST,
    name: "Join Request",
    klass: "rumor",
    schemaExport: "joinRequestContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → `E_inbox`",
    notes: "No revision field; optional invite proof (§7).",
  },
  {
    constant: "KIND_PROFILE_SUBMISSION",
    kind: KIND_PROFILE_SUBMISSION,
    name: "Profile Submission",
    klass: "rumor",
    schemaExport: "profileSubmissionContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → `E_inbox`",
    notes: "Carries `rev` (required) — the primary ordering key over `(rev, created_at, id)` (§3.3).",
  },
  {
    constant: "KIND_KEY_GRANT",
    kind: KIND_KEY_GRANT,
    name: "Key Grant",
    klass: "rumor",
    schemaExport: "keyGrantContentSchema",
    sealing: "gift-wrap",
    author: "`E_id`, or the coordinator currently named (current generation) in the newest `31600` → attendee",
    notes: "ECK versions union-merge into local custody; never downgrades.",
  },
  {
    constant: "KIND_COORDINATOR_GRANT",
    kind: KIND_COORDINATOR_GRANT,
    name: "Coordinator Grant (install)",
    klass: "rumor",
    schemaExport: "coordinatorGrantContentSchema",
    sealing: "gift-wrap",
    author: "`E_id` → coordinator",
    notes: "Carries `gen` (required, strictly increasing per coordinate) — install authorization rules in §3.5.",
  },
  {
    constant: "KIND_ADMIN_COMMAND",
    kind: KIND_ADMIN_COMMAND,
    name: "Admin Command",
    klass: "rumor",
    schemaExport: "adminCommandContentSchema",
    sealing: "gift-wrap",
    author: "`E_id` → coordinator",
    notes:
      "Carries `expires` (required) and is ordered by a per-subject watermark, not arrival order (§3.4); includes the `detach` command.",
  },
  {
    constant: "KIND_ORGANIZER_GRANT",
    kind: KIND_ORGANIZER_GRANT,
    name: "Organizer Grant",
    klass: "rumor",
    schemaExport: "organizerGrantContentSchema",
    sealing: "gift-wrap",
    author: "`E_id` → co-organizer",
    notes: "Grants full, irrevocable `E_id`/`E_inbox`/ECK custody; no scoped roles.",
  },
  {
    constant: "KIND_COORDINATOR_STATUS",
    kind: KIND_COORDINATOR_STATUS,
    name: "Coordinator Status",
    klass: "rumor",
    schemaExport: "coordinatorStatusContentSchema",
    sealing: "gift-wrap",
    author: "Coordinator → organizer, and optionally the affected attendee",
    notes:
      "Poison/health status and/or a billing block; attendee-directed copies are scoped to that attendee's own items.",
  },
  {
    constant: "KIND_CHAT_KEY_ATTESTATION",
    kind: KIND_CHAT_KEY_ATTESTATION,
    name: "Chat Device Attestation",
    klass: "rumor",
    schemaExport: "chatKeyAttestationContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → coordinator",
    notes: "`op:\"add\"` requires a proof of possession signed by the chat device key (§10.2).",
  },
  {
    constant: "KIND_PROFILE_CORRECTION",
    kind: KIND_PROFILE_CORRECTION,
    name: "Profile Correction",
    klass: "rumor",
    schemaExport: "profileCorrectionContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → `E_inbox`",
    notes: "Carries `rev` (required); `overrides` bounded exactly like `ai_profile`.",
  },
  {
    constant: "KIND_TALK_SUBMISSION",
    kind: KIND_TALK_SUBMISSION,
    name: "Talk Submission",
    klass: "rumor",
    schemaExport: "talkSubmissionContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → `E_inbox`",
    notes: "Carries `revision`; a resubmission at the stored revision with different content is rejected (§3.3).",
  },
  {
    constant: "KIND_ATTENDEE_WITHDRAWAL",
    kind: KIND_ATTENDEE_WITHDRAWAL,
    name: "Attendee Withdrawal",
    klass: "rumor",
    schemaExport: "withdrawalContentSchema",
    sealing: "gift-wrap",
    author: "Attendee account → `E_inbox`",
    notes: "Attendee-initiated removal — same effect chain as an organizer `revoke`, without organizer action.",
  },
] as const;

/** The exact addressable and rumor kind ranges (inclusive). */
export const CUSTOM_ADDRESSABLE_RANGE = { min: 31600, max: 31611 } as const;
export const CUSTOM_RUMOR_RANGE = { min: 21600, max: 21610 } as const;

/**
 * Render `docs/PROTOCOL-REGISTRY.md` from the registry. The prose sections
 * (status, ordering, standard events) are handwritten and kept here verbatim;
 * only the two tables are generated. `pnpm gen:registry` writes this to disk and
 * registry.test.ts asserts the committed file equals it (drift guard).
 */
export function renderRegistryDoc(): string {
  const addr = CUSTOM_KIND_REGISTRY.filter((e) => e.klass === "addressable");
  const rumor = CUSTOM_KIND_REGISTRY.filter((e) => e.klass === "rumor");
  const addrRows = addr
    .map((e) => `| ${e.kind} | ${e.name} | ${e.author} | ${e.protection} | ${e.notes} |`)
    .join("\n");
  const rumorRows = rumor
    .map((e) => `| ${e.kind} | ${e.name} | ${e.author} | ${e.notes} |`)
    .join("\n");

  return `<!-- GENERATED FILE — do not edit by hand.
     Source of truth: packages/protocol/src/registry.ts (CUSTOM_KIND_REGISTRY).
     Regenerate with \`pnpm gen:registry\`. The prose sections live in
     renderRegistryDoc(); the tables are generated from the typed registry. -->
# Nostrautica Protocol Registry

**Status:** Compact index of every custom event kind. **\`docs/PROTOCOL-NIP.md\` is the
normative specification** — full per-kind content schemas, cryptographic constructions,
ordering rules, and rationale live there; this document is a quick-reference table,
generated from the typed \`CUSTOM_KIND_REGISTRY\` in \`packages/protocol/src/registry.ts\`.

**Ordering (PROTOCOL-NIP.md §3.1):** for any two events sharing (kind, author, \`d\`), the
event with the higher \`created_at\` wins; on a tie, the event with the lexicographically
lowest \`id\` wins. This rule applies everywhere — the app and the coordinator, fetch paths
and streaming subscriptions alike. Sender-mutable rumors (profile submissions,
corrections, talk submissions) additionally carry an explicit \`rev\`/\`revision\` field that
is the primary ordering key; the sender-chosen timestamp is only a tie-break (§3.3).

The custom kind ranges are \`${CUSTOM_ADDRESSABLE_RANGE.min}\`–\`${CUSTOM_ADDRESSABLE_RANGE.max}\` (addressable) and \`${CUSTOM_RUMOR_RANGE.min}\`–\`${CUSTOM_RUMOR_RANGE.max}\`
(gift-wrapped rumors). All custom payloads carry \`v: 2\`; readers reject any payload or
public event whose \`v\` is not exactly \`2\` (§2).

## Addressable Events

| Kind | Name | Author | Protection and address | Authority / lifecycle |
|---:|---|---|---|---|
${addrRows}

## Gift-Wrapped Rumors

| Kind | Name | Seal author → recipient | Ordering / notes |
|---:|---|---|---|
${rumorRows}

## Standard Events Used by the Application

The protocol additionally uses standard Nostr kinds: kind \`0\` metadata, \`1\` notes, \`3\`
contacts, \`5\` deletions, \`6\` reposts, \`13\` seals, \`14\` NIP-17 direct-message rumors,
\`1059\` gift wraps, \`10000\` mute lists, \`10002\` relay lists, \`10050\` DM relay lists,
\`10063\` Blossom server lists, \`24242\` Blossom authorization, \`30023\` long-form posts,
\`30078\` app data, \`31923\`/\`31924\`/\`31925\` NIP-52 event/calendar/RSVP records, and
Marmot's \`30443\` key packages / \`443\`/\`444\`/\`445\` group messaging.

The \`30078\` app-data identifiers the application owns, all NIP-44 self-encrypted and
user-private (§4.1):

| \`d\` | Contents |
|---|---|
| \`nostrautica:ev:<blinded>\` | Per-event private settings: favorites, want-to-meet, met, notes (§7.3). |
| \`nostrautica:eventkeys:<blinded>\` | Organizer custody backup: \`E_id\`/\`E_inbox\` nsecs and ECK versions. |
| \`nostrautica:keybackup\` | Durable "account key was backed up" marker; existence alone is the signal. |
| \`nostrautica:blindseed\` | The 32-byte seed the blinded-\`d\` construction derives from. |
| \`nostrautica:dmread\` | Per-peer DM read positions, synced across the account's devices (§7.2). Replaceable, so writers must read-merge-write (per-peer maximum), never overwrite. |

(\`nostrautica:\`-prefixed strings also appear as device-local \`localStorage\`/cache keys —
theme, language, correction revisions, watch progress. Those are not relay records and are
not listed here.)

The currently used custom set is exactly \`${CUSTOM_ADDRESSABLE_RANGE.min}\` through \`${CUSTOM_ADDRESSABLE_RANGE.max}\` and \`${CUSTOM_RUMOR_RANGE.min}\` through
\`${CUSTOM_RUMOR_RANGE.max}\`. Before a public release, re-check every custom kind against the Nostr NIPs
registry.
`;
}
