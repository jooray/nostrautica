# NIP-XX — Encrypted Event Networking (Nostrautica Protocol, wire v2)

`draft` `optional`

**Status:** Target specification. This document describes protocol **wire version 2** — the
protocol Nostrautica is converging on. It is written as a normative spec: where the current
implementation (wire v1) differs, v2 is the goal and the differences are breaking changes,
deployed as a coordinated flag day while the network has test users only. Open product
decisions are marked **[DECISION]** and indexed in §14.

This NIP defines a protocol for privacy-preserving event networking on Nostr: encrypted
attendee registration, an encrypted per-event directory, AI-assisted matchmaking through an
organizer-chosen coordinator service, moderated pre-recorded talks, members-only event
content, and MLS (Marmot) group chat with multi-device support.

---

## 1. Terms and actors

- **Event** — a NIP-52 kind `31923` calendar event. Its canonical identifier everywhere is
  the coordinate `31923:<E_id-pubkey>:<d>` (the *coordinate*).
- **`E_id`** — the *event identity* keypair. Signs everything "official" the event
  publishes. Never used for encryption. Held by the organizer and co-organizers only.
- **`E_inbox`** — the *event inbox* keypair. Signs nothing, ever. Its pubkey is the NIP-44
  encryption target for all inbound attendee submissions. Held by organizers and the
  coordinator.
- **ECK** — *Event Content Key*, a versioned 32-byte symmetric key encrypting all outbound
  member-only content. Rotated forward-only on revocation.
- **Coordinator** — an optional headless daemon with its own keypair, granted `E_inbox`
  and ECK custody by the organizer. It transcribes, profiles, matches, publishes
  member-only records, and administers group chat. It can never sign as `E_id`.
- **Attendee account key** — the user's normal Nostr identity (local, NIP-07, or NIP-46).
- **Chat device key** — a per-browser/per-device keypair used only for Marmot/MLS chat
  (§10). One account may have several concurrently.

All hex values are lowercase. *hex32* means `/^[0-9a-f]{64}$/`.

## 2. Wire version

`PROTOCOL_VERSION = 2`.

- Public events carry the tag `["v","2"]`. Encrypted and JSON payloads carry `"v": 2`.
- Parsers **MUST** reject any payload whose `v` is not exactly `2` (`z.literal(2)`, not
  "any positive integer"). Clients **SHOULD** surface an "update the app" message when they
  observe a higher version from an authority key they trust (the event's `E_id` or
  configured coordinator).
- Readers of public custom kinds **MUST** ignore events whose `v` tag is absent or not
  `"2"`.
- Rationale: v1's forward-tolerant parse meant a future breaking payload would be silently
  misparsed. v2 chooses explicit rejection; forward compatibility is achieved by bumping
  `v` and shipping clients first.

Kind numbers are unchanged from v1 (addressable `31600–31611`, rumors `21600–21609`).
The flag day consists of new payload shapes under the same kinds. **[DECISION D1]**

## 3. Ordering, replaceability, and revisions

These rules close the largest defect class in v1 (out-of-order regression, replay,
same-second nondeterminism). They are global and normative.

### 3.1 Latest-event rule (all replaceable/addressable kinds)

For any two events with the same (kind, author, `d`): the event with the **higher
`created_at`** wins; on a tie, the event with the **lexicographically lowest `id`** wins
(the NIP-01 convention). Every reader — app and coordinator, fetch and stream paths —
**MUST** apply exactly this rule. (v1 had no app-side tie-break and the coordinator's only
tie-break picked the *highest* id; both are superseded.)

### 3.2 Monotonic publishing

A publisher of a replaceable event **MUST** set `created_at` to
`max(now, previous_created_at_for_that_address + 1)`. This makes §3.1 deterministic in
practice and removes same-second collisions between successive business updates.

### 3.3 Revisioned mutable submissions

Sender-mutable records carry an explicit application revision; sender-chosen timestamps
are never the primary ordering key.

- **`21601` profile submission** gains `rev` (int ≥ 0, required). The coordinator stores
  the applied `(rev, created_at, rumor_id)` and **MUST** reject a submission whose key is
  not strictly greater under lexicographic comparison `(rev, created_at, id-inverted)` —
  i.e. higher `rev` wins; equal `rev`: higher `created_at` wins; equal both: lowest rumor
  id wins, and a loser is discarded, never applied.
- **`21609` talk submission** keeps `revision`, with the tie rule tightened: a submission
  with `revision` equal to the stored one and a **different content hash MUST be
  rejected** (content change requires a revision bump). Equal revision and identical
  content is an idempotent re-delivery.
- **`21608` profile correction** gains `rev` with the same rule as `21601`.

Clients maintain `rev` monotonically per (coordinate, kind) in their own storage and
**MUST** bump it on every edit.

### 3.4 Admin command ordering and replay horizon

`21604` admin commands gain two required fields:

- `expires` (unix seconds): the command is void after this time. Clients **SHOULD** set
  `created_at + 172800` (48 h) by default.
- Per-subject ordering: the coordinator keeps, per (coordinate, command subject), the
  watermark `(created_at, rumor_id)` of the last applied command. A command strictly older
  than the watermark **MUST** be rejected. The *subject* is `args.pubkey` where present
  (approve/revoke/reprocess), `(args.pubkey, args.talk_d)` for talk commands, and the
  coordinate itself for `recompute`.

Consequences:

- On backfill/restore, expired commands are skipped — an old `revoke` or `recompute`
  can never re-execute after DB loss.
- The `seen_rumors` dedupe ledger only needs to cover `max(expiry horizon, gift-wrap
  window)` and becomes prunable again (v1 had to retain it forever).
- Approve/revoke interleavings resolve deterministically per subject instead of by relay
  arrival order.

### 3.5 Coordinator installation generation and detach

The `31600` `coordinator` tag becomes three-element: `["coordinator", <pubkey>, <gen>]`
where `gen` is a positive integer chosen by the organizer, strictly increasing across
every attach/detach/re-attach of the event (persisted in the organizer's `30078` event-keys
backup). The `21603` install grant carries the same `gen`.

Coordinator rules:

- A fresh install **MUST** be authorized by a fetchable newest `31600` (per §3.1) naming
  this coordinator with the same `gen` as the grant, whose declared `inbox` the grant's
  `inbox_nsec` derives. Unfetchable config is retryable, never authorization (as in the
  v1 P0-4 fix).
- An install with `gen` ≤ the highest generation ever installed *or detached* for that
  coordinate **MUST** be rejected — a replayed historical `21603` can never re-install.
- **Detach is any newest `31600` that does not name this coordinator with the current
  generation** — including a config with *no* coordinator tag, and a config naming another
  coordinator. On detach the coordinator **MUST** durably tombstone the installation
  (coordinate + last gen), close the event's subscriptions, cancel pending paid work, and
  dispose of key custody per the configured policy **[DECISION D6]**.
- On startup the coordinator **MUST** revalidate the newest `31600` for every stored
  installation before resuming it. Fetch failure ⇒ the event stays suspended (no
  processing, no publishing) and revalidation retries; it does not resume leniently.
- An explicit `21604` `detach` command (subject: coordinate) is added for immediate,
  signed detach with the same effects; the tombstone records whichever of the two signals
  arrived.

### 3.6 Grant authority

`21602` key grants are accepted only when the seal author is `E_id` or the coordinator
named (with current generation) in the newest fetchable `31600`. A grant whose seal author
is a *formerly* assigned coordinator **MUST** be rejected once a newer config no longer
names it. Missing config remains "retry later", never "accept".

### 3.7 Detach hygiene, record authority, and handover

Deleting custody on detach (§3.5) is the honest coordinator's obligation; a *malicious*
coordinator may retain copies of `E_inbox` and the ECK. Detach therefore has protocol
consequences beyond the coordinator itself:

- **Key rotation on detach/replace.** The organizer's client **SHOULD** rotate the ECK
  (same machinery as attendee revocation) and **SHOULD** rotate `E_inbox` (mint a new
  inbox keypair, publish it in the new `31600` `inbox` tag, and include the new secret in
  the replacement coordinator's `21603`). Senders always encrypt to the newest config's
  inbox, so inbox rotation is transparent to attendees; organizers retain old inbox
  secrets locally for reading history. As everywhere, rotation protects **future**
  content only.
- **Record authority is pinned to the current assignment.** Readers **MUST** accept
  coordinator-authored kinds (31603, 31604, 31605, 31606, 31610) only when authored by
  the coordinator currently named in the newest fetchable `31600`, or by `E_id`. Records
  authored by a formerly assigned coordinator are ignored once a newer config no longer
  names it.
- **Handover republish.** A newly attached coordinator **MUST** republish the event's
  member records (directory, roster, match lists, published talks) under its own key —
  bootstrapping from the previous coordinator's still-decryptable records where custody
  allows, and from reprocessing otherwise — so that record authority (above) never leaves
  members without a readable directory.

## 4. Encryption model

Unchanged from v1 in construction; restated normatively.

| Layer | Construction | Used for |
|---|---|---|
| Inbound | NIP-44 v2, sender → `E_inbox` pubkey, inside NIP-59 gift wrap | 21600, 21601, 21608, 21609 |
| Outbound member content | NIP-44 v2 with the raw 32-byte ECK as conversation key (no ECDH) | 31603, 31604, 31606, 31607, 31608 `private`, 31610 |
| Per-recipient | NIP-44 v2 ECDH, coordinator → recipient | 31605, all grants/status rumors |
| Self-store | NIP-44 v2 self-conversation-key (or signer nip44 to own pubkey) | 31602, 30078 |
| Media | AES-256-GCM, fresh key + 12-byte IV per blob, whole-file | Blossom blobs |

- Every encrypt path enforces the 65,535-byte NIP-44 plaintext ceiling.
- The ECK **never signs anything**.
- **Blinded addresses:** `d = hex(hmac_sha256(key, utf8("<coordinate>|<pubkey>")))[0..32]`
  with `key` = current ECK (directory/match/talk addresses) or the account's self blinding
  key (self-stores). Talk addresses use the literal-string variant
  `hmac_sha256(ECK, "talk|<coordinate>|<speaker>|<talk_d>")`.
- ECK versions are `{id, key}`; grants carry full version lists; receivers **union-merge**
  (a stale grant never downgrades custody). Current version = highest id; rotation on
  revocation is forward-only and honest about it (old ciphertext stays readable to old
  holders).

## 5. Gift wraps

Per NIP-59: rumor (unsigned) → kind-13 seal (signed by true author, NIP-44 to recipient,
empty tags) → kind-1059 wrap (one-time key, single `p` tag, `created_at` randomized up to
2 days into the past).

- `RUMOR_KINDS` = {14, 21600–21609}. Nothing else may appear in a wrap; a leaked rumor
  kind is in the ephemeral range so relays won't store it.
- Unwrap validation (all consumers): wrap kind 1059; seal kind 13; structural rumor shape;
  **`rumor.pubkey == seal.pubkey`**; rumor id recomputed and matched; `created_at` clamped
  to ≤ now + 900 s.
- Subscription window: `since = now − 259200` (3 days). Consumers dedupe by rumor id.
- Coordinator dedupe: durable `seen_rumors` keyed by wrap id and rumor id, prunable after
  the §3.4 horizon; atomic in-process claim before dispatch; a durable cross-process lease
  is required before two daemons may share one database (until then, single-daemon
  operation is a stated constraint).

## 6. Kinds

### 6.1 Registry

| Kind | Name | Signer | Visibility | `d` |
|---:|---|---|---|---|
| 31600 | Event Networking Config | `E_id` | public | event `d` |
| 31601 | Invite List | `E_id` | public (hash-hidden) | event `d` |
| 31602 | Self profile / reuse library | account | NIP-44 self | blinded |
| 31603 | Directory Entry | coordinator (or `E_id`) | ECK | blinded |
| 31604 | Roster | coordinator (or `E_id`) | ECK | event `d` |
| 31605 | Match List | coordinator | NIP-44 → recipient | blinded |
| 31606 | Match Matrix | coordinator | ECK | event `d` |
| 31607 | Members-only Post | `E_id` | ECK | random stable |
| 31608 | Event Page | `E_id` | public + ECK `private` | event `d` |
| 31609 | Event Theme | `E_id` | public | event `d` |
| 31610 | Talk | coordinator (or `E_id`) | ECK | blinded |
| 31611 | Coordinator Announcement | coordinator | public | `nostrautica:coordinator` |

| Rumor | Name | Seal author → recipient |
|---:|---|---|
| 21600 | Join Request | account → `E_inbox` |
| 21601 | Profile Submission | account → `E_inbox` |
| 21602 | Key Grant | `E_id` or current coordinator → attendee |
| 21603 | Coordinator Grant (install) | `E_id` → coordinator |
| 21604 | Admin Command | `E_id` → coordinator |
| 21605 | Organizer Grant | `E_id` → co-organizer |
| 21606 | Coordinator Status | coordinator → organizer |
| 21607 | Chat Device Attestation | account → coordinator |
| 21608 | Profile Correction | account → `E_inbox` |
| 21609 | Talk Submission | account → `E_inbox` |
| 21610 | Attendee Withdrawal | account → `E_inbox` |

Standard kinds used: 0, 1, 3, 5, 6, 13, 14, 1059, 10000, 10002, 10050, 10063, 24242,
30023, 30078, 31923/31924/31925, and Marmot's 30443/443/444/445.

### 6.2 Changes from v1, per kind

Only differences from the v1 payloads (documented in `PROTOCOL-REGISTRY.md`) are listed;
everything not mentioned is carried over with `v: 2`.

**31600** — `coordinator` tag gains the `gen` element (§3.5). All other tags unchanged.

**31601 / invites** — the invite proof challenge gains domain separation and injective
encoding (§7).

**31602** — the **chat-device-key backup variant is retired** (§10 replaces the shared
chat identity with per-device keys; there is nothing left to back up). Profile self-copy
and reuse library variants unchanged. **[DECISION D3]**

**31603** — unchanged shape. Normative caps aligned with enforcement (§8).

**31604 roster** — `attendees[].chat_pubkey` (single) is replaced by
`attendees[].chat_keys?: [{ pubkey: hex32, label?: string ≤ 60, added_at: int }]`
(≤ `MAX_CHAT_KEYS_PER_ACCOUNT = 5` per attendee). `nostr_group_id` unchanged and remains
the authoritative event→group routing binding (§10.4).

**21601** — gains required `rev` (§3.3).

**21603** — gains required `gen` (§3.5).

**21604** — gains required `expires`; gains command `detach` (no args); per-subject
watermark ordering (§3.4, §3.5).

**21605** — seal author **MUST be exactly `E_id`** (v1 docs said "E_id/organizer
authority"; the code was already stricter). `granted_by` **MUST** equal the seal author
(retained for self-description).

**21607** — reshaped for multi-device with proof of possession (§10.2).

**21608** — gains `rev`; `overrides` fields gain the same bounds as `ai_profile`
(`summary ≤ 5000`, list items ≤ 200 chars, ≤ 50 entries) — v1's unbounded overrides are a
storage-amplification bug.

**21609** — equal-revision/different-content rejection (§3.3).

**31605** — each match entry gains optional `icebreakers?: string[]` (≤ 3 entries,
≤ 280 chars each): concrete conversation starters the coordinator derives alongside the
directional reasoning. Additive (the schema is non-strict); clients without support
ignore it.

**21610 Attendee Withdrawal (new).** Content (`.strict()`):
`{ v: 2, a: <coordinate>, delete_data?: bool (default true) }`, sealed by the attendee's
account key. Semantics: attendee-initiated removal — the same effect chain as an
organizer `revoke` (roster/directory/match removal, NIP-09 deletions, ECK rotation),
without requiring organizer action. The withdrawing client **SHOULD** also delete its own
Blossom blobs (uploader-authorized) and its 31602 self-copy. Ordering uses the §3.4
per-subject watermark (subject = the sender). Rejoining afterwards is a fresh join
request. Rationale: v1 had no way for an attendee to leave an event or retract their
data — user agency over their own participation should not depend on the organizer.

**21606** — recipient widened: in addition to the organizer, the coordinator **MAY** seal
a status rumor to the *affected attendee*, restricted to status about that attendee's own
items (their submission/talk pipeline failures); billing blocks go only to organizers.
Rationale: v1 delivered "your talk failed transcription" only to organizers — the one
party who can't fix it.

**31600** — new optional tag `["retention", <days>]` (positive int): the coordinator
**MUST** delete member records (31603/31604/31605/31606/31610 talks) via NIP-09 and cease
processing `<days>` days after the event's end time, and clients **MUST** surface the
declared retention at join time. Tag absent = indefinite retention (status quo). This
makes data lifetime part of the joining contract rather than an operator afterthought.
Deletion remains best-effort (relays may not honor NIP-09); the privacy model never
depends on it, and the UI wording must not overpromise.

## 7. Invite codes

An invite code is a throwaway nsec, transported only in the URL fragment.

- `31601` content: `{ v: 2, invites: [{ h: sha256(invite-pubkey) hex, label? }] }`
  (≤ 10,000 entries). Voiding = republishing without the hash.
- **Proof (v2):** the join request carries
  `["invite", <invite-pubkey-hex>, <sig-hex>]` where the signature is BIP-340 over:

  ```
  challenge = sha256( utf8( JSON.stringify(
      ["nostrautica-invite-v2", <coordinate>, <attendee-pubkey-hex>] ) ) )
  ```

  JSON-array encoding is injective (fixes v1's ambiguous colon-joined message) and the
  literal first element is the domain-separation tag. Verifiers **MUST** reject v1-format
  proofs.
- Verification stays stateless: `sha256(invite-pubkey) ∈ newest 31601` ∧ signature valid.
- Single-use: the coordinator claims per invite pubkey, **first-processed wins**; later
  uses fall back to the manual queue (benign failure mode). This is eventually consistent
  by design; organizer-client and coordinator claim state are not shared. (v1 docs claimed
  first-by-created_at; v2 documents the implemented and sufficient rule.)

## 8. Media descriptors

`.strict()` schema; unknown fields rejected.

```json
{
  "kind": "intro" | "talk",
  "url": ["https://…", …],                 // https-only, ≥ 1
  "x": "<sha256 ciphertext>", "ox": "<sha256 plaintext>",
  "size": <int ≥ 1>,                        // v2: 0 no longer valid
  "m": "<mime>",
  "duration": <seconds ≥ 0>,                // v2: REQUIRED for audio/video mime types
  "encryption-algorithm": "aes-gcm",
  "decryption-key": "<base64 32B>", "decryption-nonce": "<base64 12B>"
}
```

Coordinator enforcement is the normative wire contract (v1's laxer schema bounds are
tightened to match):

- ≤ **4** media descriptors per `21601` processed; ≤ 500 MiB declared total per
  submission; per-event duration limits from `31600` apply to the declared `duration`.
- The coordinator **MUST** compare the actual downloaded ciphertext length to `size` and
  reject mismatches, and **SHOULD** probe real decoded duration before STT and reject
  media exceeding the event limit regardless of declaration.
- Per-attendee and per-event cumulative byte/duration/spend budgets gate processing
  (values operator-configured; exceeding them requires organizer approval to continue).

## 9. Coordinator lifecycle, billing, and status

- **Install** / **detach** / startup revalidation: §3.5.
- **Billing principal (v2): the event identity.** Configuration and documentation name it
  `free_eids` (v1's `free_organizers` was a misnomer — nothing authenticated a personal
  organizer). The coordinator persists a typed billing principal per installation so a
  personal/organization principal binding can be added later without a wire change.
- **Billing is a persisted state machine** — `evaluating → ok | grace | blocked` —
  re-evaluated at install, attendee-count change, submission revision, job claim, and
  immediately before provider spend. `blocked` stops paid work but never blocks revoke,
  detach, roster repair, or status publication. Transitions emit `21606` with the existing
  `billing` block. (v1 logged and ignored the verdict.)
- **Announcements (`31611`)** are generated from *resolved runtime provider routes*, not
  configured intent — the privacy map must describe where data actually flows (per-role
  provider instances are an implementation requirement of this section).

## 10. Group chat (Marmot/MLS) and multi-device

This section replaces v1's single-chat-identity design. See
`docs/MULTIDEVICE-CHAT.md` for the feasibility study and migration detail.

### 10.1 Model

- One MLS group per event, created and administered by the coordinator (admin bot):
  add-on-approval, remove-on-revoke, member-driven device adds via attestation.
- **Chat identity is per device.** Every browser/device mints its own chat device keypair
  on first chat use — for *all* account types (local key, NIP-07, NIP-46). There is no
  shared chat key, no relay backup of chat secrets, and no cross-device restore of chat
  identity. A device is *added* by attestation and *removed* by revocation; loss of a
  device is handled by revoking its key, not recovering it. **[DECISION D3]**
- One account may hold up to `MAX_CHAT_KEYS_PER_ACCOUNT = 5` concurrent device keys per
  event. Each device gets its own MLS leaf, its own key package (kind 30443, with a stable
  `client_id` slot per device), and its own Welcome; each device sees history only from
  its own join epoch forward (MLS semantics; history never syncs, by design).

### 10.2 Chat Device Attestation (21607, v2)

Sealed by the **account** key to the coordinator. Content (`.strict()`):

```json
{
  "v": 2, "a": "<coordinate>",
  "op": "add" | "revoke",
  "chat_pubkey": "<hex32>",
  "label": "<string ≤ 60>",            // "Chrome on laptop" — user-editable
  "client_id": "<string ≤ 120>",       // stable 30443 slot id for this device
  "proof": "<schnorr sig hex, REQUIRED for op:add>"
}
```

`proof` is BIP-340 by the **chat device key** over:

```
sha256( utf8( JSON.stringify(
  ["nostrautica-chat-device-v2", <coordinate>, <account-pubkey>, <chat_pubkey>, <created_at>] ) ) )
```

The coordinator **MUST** verify the proof before binding — an account can no longer attest
a key it doesn't control (v1's missing proof-of-possession). `op:"revoke"` needs no proof
(the account is evicting a key, possession is irrelevant). Bindings are per
(coordinate, account); a chat pubkey **MUST NOT** be bindable to two different accounts;
rebinding to the same account (e.g. re-add after revoke) mints a fresh binding.

On account revocation from the event, **all** of that account's device leaves are removed
from the MLS group.

### 10.3 Device profiles (kind 0 on chat relays)

So that other Marmot clients (e.g. White Noise) display a human name for each device
member, every chat device publishes a **kind 0 profile signed by the chat device key, to
the event's chat relay set only** (the Marmot relays — never to the account's general
relays):

```json
{ "name": "<account display name>", "about": "via Nostrautica" }
```

- The `name` **SHOULD** equal the account's event display name; devices of one account
  share the same name. The `about` field **SHOULD** reference the owning account's npub
  (decision D4: continuity with v1 behavior — it lets external clients verify and group
  devices by account). Accepted consequence, stated normatively: the device→account link
  is **public on the chat relays**; the ECK-encrypted roster `chat_keys` mapping remains
  the authoritative binding for Nostrautica clients.
- Organizers/users who want no public presence on chat relays can disable device profiles
  per event; members then render as roster names inside Nostrautica and as bare keys in
  external clients.
- The app **MUST NOT** publish or fetch account kind 0 on chat relays, and **MUST NOT**
  publish device kind 0 anywhere else.

### 10.4 Event→group routing

- The roster's `nostr_group_id` is the authoritative binding from coordinate to the active
  MLS group. A newly received Welcome joins into an **unbound candidate** state: no
  listener binding, no history replay, no display, no sending until a verified roster
  `nostr_group_id` matches. Roster-fetch failure keeps the candidate pending —
  fail-closed (v1's cold-cache fail-open path is removed).
- The coordinator **SHOULD** additionally include the event coordinate in the Marmot
  group's name/description metadata as defense in depth; clients treat it as a hint, not
  authority.

### 10.5 Multi-tab ownership (client-local, normative for correctness)

Within one browser profile, exactly one tab may own a chat device's MLS state: leader
election via Web Locks per (account, coordinate); follower tabs proxy sends and receive
messages over BroadcastChannel; where Web Locks are unavailable, secondary tabs are
read-only. Two *devices* are two MLS members and need no coordination — that is what
§10.1 buys.

## 11. Talks

Unchanged from v1 except the §3.3 revision tie rule. Normative caps: ≤ 10 distinct
`talk_d` per speaker per event; talk media descriptor `kind` must be `"talk"`; published
`31610` republishes under new ECK on rotation with NIP-09 deletion of old-address copies.

## 12. Deletions

The coordinator issues NIP-09 kind-5 with both `["a", "<kind>:<pubkey>:<d>"]` and
`["k","<kind>"]` for: revoked attendees' `31603`, `31606` on visibility downgrade, and
obsolete `31610` addresses. Deletion is best-effort; the privacy model never depends on it.

## 13. Security considerations

- **Forward-only revocation** — anyone who held a key reads everything published while it
  was current, forever. Stated in organizer UI. MLS chat removal has real PCS, unlike ECK
  rotation.
- **Coordinator trust** — reads all event-encrypted content, holds `E_inbox`/ECK, grants,
  publishes member records, reads and administers chat. Cannot sign as `E_id`. Its
  authority ends at detach (§3.5) — v2 makes that enforceable.
- **Accepted metadata leaks** — attendee counts (directory-entry counts), submission
  timing (`E_inbox` p-tags), cross-event blob-hash linkage without "fresh copy", chat
  relay traffic patterns, device-profile names on chat relays (§10.3).
- **Organizer CSS (31609)** is presentation control by the same party that controls all
  rendered text; it is **not** a secret-safe boundary. Clients **MUST NOT** render event
  themes on routes where secrets (invite nsecs, key backups, chat handoff) appear.
- **Prompt injection** into AI profiles/matching by attendee content remains semantically
  possible; outputs are length-capped and URL-neutralized; organizers see provenance.
- **`21605` organizer grants are irrevocable full custody** — co-organizers are
  cryptographically indistinguishable from the creator. Scoped roles remain future work.

## 14. Decision index — RESOLVED 2026-07-22 (owner)

All decisions were resolved by the owner on 2026-07-22; the sections above are written
to the resolved choices. This spec is **frozen** as the implementation target.

| # | Decision | Resolution |
|---|---|---|
| D1 | v2 deployment | **Flag day**: same kind numbers, payloads bump to strict `v:2`; no compatibility window |
| D2 | Unknown-version handling | **Reject + "update app" prompt** when from a trusted authority key |
| D3 | Chat identity | **Per-device keys for all account types**; 31602 chat-backup variant retired |
| D4 | Device kind-0 on chat relays | **Display name + account npub in `about`** (v1 behavior; public device→account link accepted for external-client interop) |
| D5 | Billing | **`free_eids` rename + persisted enforcement state machine** (`evaluating → ok | grace | blocked`) |
| D6 | Detach key disposal | **Delete `E_inbox`/ECK custody** on detach; re-attach requires a fresh grant with a new `gen` |
| D7 | `seen_rumors` pruning | **Prune beyond the §3.4 horizon** once command expiry ships |

**Post-freeze review additions (2026-07-22, owner-mandated design pass):** §3.7 detach
hygiene / record-authority pinning / handover republish; rumor 21610 Attendee Withdrawal
(custom rumor range extends to 21600–21610); 31600 `retention` tag; 21606 widened to the
affected attendee. All additive on top of the v2 flag day; no prior decision is changed.
Considered and rejected in the same pass: `E_inbox` p-tag metadata mitigation (complexity
disproportionate to an accepted, documented leak), scoped organizer roles (additive
later, large), chunked-media descriptor reservation (speculative without implementation),
PoW-gated join requests (additive later if spam materializes).

Changelog v1 → v2 (summary): strict version parse; global latest-event tie-break; monotonic
publisher timestamps; `rev` on 21601/21608; talk equal-revision rejection; `expires` +
per-subject watermarks on 21604; install `gen` + durable detach + startup revalidation;
domain-separated injective invite challenge; 21607 proof-of-possession + multi-device;
roster `chat_keys` array; per-device chat identity, chat-backup variant retired; device
kind-0 on chat relays; bounded 21608 overrides; media `size ≥ 1` + required a/v duration +
actual-length verification; billing principal renamed and enforced; announcements from
resolved provider routes.

## 15. Future work (non-normative)

Recorded here so the ideas survive without implying commitment; none of these affect the
v2 wire.

- **Cashu ticketing + QR door check-in (one feature, two halves).** Ticketing per the
  existing design: purchase yields a Cashu token P2PK-locked to the attendee npub; the
  join request carries `["payment", <token>]`; the coordinator's pluggable entitlement
  checker redeems and auto-grants — no wire change beyond the reserved tag. Check-in
  completes it at the venue door: the attendee's app shows a QR of a BIP-340-signed
  statement `{coordinate, attendee-pubkey, timestamp}` (domain-separated like the other
  v2 challenges); door staff verify offline against the ECK roster — no connectivity or
  server needed. Check-in without ticketing is possible (roster membership is the gate)
  but only becomes essential alongside paid admission; implement them together.
- **Match feedback loop.** Attendee ratings of match suggestions biasing future scoring
  would require an opt-in feedback rumor to the coordinator (ratings live in user-private
  30078, unreadable by the coordinator by design). Deferred: wire addition + privacy
  trade-off for an unproven quality gain.
- **Follow packs (following.space, kind 39089).** Considered for the post-event export;
  rejected as default because follow packs are public events — publishing "everyone I
  met at event X" would leak the attendee's participation and social graph. The
  post-event report exports npubs locally instead; a deliberate, clearly-labeled
  "publish as follow pack" could be offered later.
- **Geohash event discovery; NIP-77 negentropy sync.** Not now; revisit with real
  multi-event usage and relay support respectively.
