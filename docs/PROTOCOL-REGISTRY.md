<!-- GENERATED FILE — do not edit by hand.
     Source of truth: packages/protocol/src/registry.ts (CUSTOM_KIND_REGISTRY).
     Regenerate with `pnpm gen:registry`. The prose sections live in
     renderRegistryDoc(); the tables are generated from the typed registry. -->
# Nostrautica Protocol Registry

**Status:** Compact index of every custom event kind. **`docs/PROTOCOL-NIP.md` is the
normative specification** — full per-kind content schemas, cryptographic constructions,
ordering rules, and rationale live there; this document is a quick-reference table,
generated from the typed `CUSTOM_KIND_REGISTRY` in `packages/protocol/src/registry.ts`.

**Ordering (PROTOCOL-NIP.md §3.1):** for any two events sharing (kind, author, `d`), the
event with the higher `created_at` wins; on a tie, the event with the lexicographically
lowest `id` wins. This rule applies everywhere — the app and the coordinator, fetch paths
and streaming subscriptions alike. Sender-mutable rumors (profile submissions,
corrections, talk submissions) additionally carry an explicit `rev`/`revision` field that
is the primary ordering key; the sender-chosen timestamp is only a tie-break (§3.3).

The custom kind ranges are `31600`–`31611` (addressable) and `21600`–`21610`
(gift-wrapped rumors). All custom payloads carry `v: 2`; readers reject any payload or
public event whose `v` is not exactly `2` (§2).

## Addressable Events

| Kind | Name | Author | Protection and address | Authority / lifecycle |
|---:|---|---|---|---|
| 31600 | Event Networking Config | `E_id` | Public; `d` = calendar-event `d` | Tags configure inbox, relays, Blossom, coordinator (+ install generation), limits, approval, matching, language, talks, chat, and retention. Only `E_id` may publish. Newest valid config is the root of trust for every other kind. |
| 31601 | Invite List | `E_id` | Public, hash-hidden; `d` = event `d` | JSON invite hash list, ≤10,000 entries. Only `E_id` may publish. Voiding = republishing without the hash. |
| 31602 | Self-encrypted profile / reuse library | Attendee account | NIP-44 self-encrypted; blinded `d` | Per-event self-copy (`a` = coordinate) and cross-event reuse library (`a: null`), same content schema. |
| 31603 | Directory Entry | Coordinator, or `E_id` without one | ECK-encrypted; ECK-blinded `d` | One approved attendee's profile/media/transcripts/derived profile. Replaced when profile or derived output changes; NIP-09-deleted on revocation or withdrawal. Readers accept only the coordinator currently named in the newest `31600`, or `E_id`. |
| 31604 | Roster | Coordinator, or `E_id` without one | ECK-encrypted; `d` = event `d` | Approved-attendee index, current ECK version, per-device `chat_keys`, and the active Marmot `nostr_group_id` when chat is on. Latest valid roster wins; `nostr_group_id` is the authoritative event→group binding. |
| 31605 | Match List | Coordinator | NIP-44 coordinator→recipient; ECK-blinded `d` | Directional match reasoning (+ optional icebreakers) for one recipient. Replaced after scoring or ECK rotation. |
| 31606 | Match Matrix | Coordinator | ECK-encrypted; `d` = event `d` | Event-wide score-only matrix; published only when `match_visibility: event`. Deleted when visibility changes away from it. |
| 31607 | Members-only Event Post | `E_id` | ECK-encrypted; random stable `d` | Official members-only post. Same `d` on edit; old ciphertext stays readable to whoever held the ECK version it was published under. |
| 31608 | Event Page | `E_id` | Public sections + optional ECK-encrypted `private`; `d` = event `d` | Official menu and layout, plus `sources` — long-form feeds by other npubs the organizer folds into this event's official posts. Latest valid page wins. |
| 31609 | Event Theme | `E_id` | Public raw CSS; `d` = event `d` | Organizer-controlled presentation. Not a secret-safe rendering boundary — clients must not render it on routes carrying secrets. |
| 31610 | Talk | Coordinator, or `E_id` without one | ECK-encrypted; talk/ECK-blinded `d` | Moderated prerecorded talk, transcript, language, revision, status. Republished under a new address on ECK rotation; old address NIP-09-deleted. |
| 31611 | Coordinator Announcement | Coordinator | Public; `d = nostrautica:coordinator` | Discovery name, capabilities, resolved-route privacy disclosure, relays, optional pricing. Latest announcement per coordinator wins. |

## Gift-Wrapped Rumors

| Kind | Name | Seal author → recipient | Ordering / notes |
|---:|---|---|---|
| 21600 | Join Request | Attendee account → `E_inbox` | No revision field; optional invite proof (§7). |
| 21601 | Profile Submission | Attendee account → `E_inbox` | Carries `rev` (required) — the primary ordering key over `(rev, created_at, id)` (§3.3). |
| 21602 | Key Grant | `E_id`, or the coordinator currently named (current generation) in the newest `31600` → attendee | ECK versions union-merge into local custody; never downgrades. |
| 21603 | Coordinator Grant (install) | `E_id` → coordinator | Carries `gen` (required, strictly increasing per coordinate) — install authorization rules in §3.5. |
| 21604 | Admin Command | `E_id` → coordinator | Carries `expires` (required) and is ordered by a per-subject watermark, not arrival order (§3.4); includes the `detach` command. |
| 21605 | Organizer Grant | `E_id` → co-organizer | Grants full, irrevocable `E_id`/`E_inbox`/ECK custody; no scoped roles. |
| 21606 | Coordinator Status | Coordinator → organizer, and optionally the affected attendee | Poison/health status and/or a billing block; attendee-directed copies are scoped to that attendee's own items. |
| 21607 | Chat Device Attestation | Attendee account → coordinator | `op:"add"` requires a proof of possession signed by the chat device key (§10.2). |
| 21608 | Profile Correction | Attendee account → `E_inbox` | Carries `rev` (required); `overrides` bounded exactly like `ai_profile`. |
| 21609 | Talk Submission | Attendee account → `E_inbox` | Carries `revision`; a resubmission at the stored revision with different content is rejected (§3.3). |
| 21610 | Attendee Withdrawal | Attendee account → `E_inbox` | Attendee-initiated removal — same effect chain as an organizer `revoke`, without organizer action. |

## Standard Events Used by the Application

The protocol additionally uses standard Nostr kinds: kind `0` metadata, `1` notes, `3`
contacts, `5` deletions, `6` reposts, `13` seals, `14` NIP-17 direct-message rumors,
`1059` gift wraps, `10000` mute lists, `10002` relay lists, `10050` DM relay lists,
`10063` Blossom server lists, `24242` Blossom authorization, `30023` long-form posts,
`30078` app data, `31923`/`31924`/`31925` NIP-52 event/calendar/RSVP records, and
Marmot's `30443` key packages / `443`/`444`/`445` group messaging.

The `30078` app-data identifiers the application owns, all NIP-44 self-encrypted and
user-private (§4.1):

| `d` | Contents |
|---|---|
| `nostrautica:ev:<blinded>` | Per-event private settings: favorites, want-to-meet, met, notes (§7.3). |
| `nostrautica:eventkeys:<blinded>` | Organizer custody backup: `E_id`/`E_inbox` nsecs and ECK versions. |
| `nostrautica:keybackup` | Durable "account key was backed up" marker; existence alone is the signal. |
| `nostrautica:blindseed` | The 32-byte seed the blinded-`d` construction derives from. |
| `nostrautica:dmread` | Per-peer DM read positions, synced across the account's devices (§7.2). Replaceable, so writers must read-merge-write (per-peer maximum), never overwrite. |

(`nostrautica:`-prefixed strings also appear as device-local `localStorage`/cache keys —
theme, language, correction revisions, watch progress. Those are not relay records and are
not listed here.)

The currently used custom set is exactly `31600` through `31611` and `21600` through
`21610`. Before a public release, re-check every custom kind against the Nostr NIPs
registry.
