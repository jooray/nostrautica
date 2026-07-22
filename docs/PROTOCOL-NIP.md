# NIP-XX — Encrypted Event Networking (Nostrautica Protocol)

`draft` `optional`

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
  "any positive integer"). Clients **SHOULD** surface an "update required" message when
  they observe a higher version from an authority key they trust (the event's `E_id` or
  configured coordinator).
- Readers of public custom kinds **MUST** ignore events whose `v` tag is absent or not
  `"2"`.
- Rationale: an explicit-rejection parse means a future breaking payload can never be
  silently misparsed under the wrong semantics; forward compatibility is achieved by
  bumping `v` and shipping clients first.

Custom kinds occupy the addressable block `31600`–`31611` and the gift-wrap rumor block
`21600`–`21610`.

## 3. Ordering, replaceability, and revisions

These rules give every reader — app and coordinator, fetch and stream paths alike — one
deterministic answer for which replaceable event is current, and give every mutable
submission an explicit, replay-safe order. They are global and normative.

### 3.1 Latest-event rule (all replaceable/addressable kinds)

For any two events with the same (kind, author, `d`): the event with the **higher
`created_at`** wins; on a tie, the event with the **lexicographically lowest `id`** wins
(the NIP-01 convention). Every reader — app and coordinator, fetch and stream paths —
**MUST** apply exactly this rule, so two conforming implementations never disagree about
which replaceable event is current.

### 3.2 Monotonic publishing

A publisher of a replaceable event **MUST** set `created_at` to
`max(now, previous_created_at_for_that_address + 1)`. This makes §3.1 deterministic in
practice and removes same-second collisions between successive business updates.

### 3.3 Revisioned mutable submissions

Sender-mutable records carry an explicit application revision; sender-chosen timestamps
are never the primary ordering key.

- **`21601` profile submission** content carries `rev` (int ≥ 0, required). The
  coordinator stores the applied `(rev, created_at, rumor_id)` and **MUST** reject a
  submission whose key is not strictly greater under lexicographic comparison
  `(rev, created_at, id-inverted)` — i.e. higher `rev` wins; equal `rev`: higher
  `created_at` wins; equal both: lowest rumor id wins, and a loser is discarded, never
  applied.
- **`21609` talk submission** content carries `revision`; a submission with `revision`
  equal to the stored one and a **different content hash MUST be rejected** (a content
  change requires a revision bump). Equal revision and identical content is an idempotent
  re-delivery.
- **`21608` profile correction** content carries `rev` with the same rule as `21601`.

Clients maintain `rev` monotonically per (coordinate, kind) in their own storage and
**MUST** bump it on every edit.

### 3.4 Admin command ordering and replay horizon

`21604` admin commands carry two required fields:

- `expires` (unix seconds): the command is void after this time. Clients **SHOULD** set
  `created_at + 172800` (48 h) by default.
- Per-subject ordering: the coordinator keeps, per (coordinate, command subject), the
  watermark `(created_at, rumor_id)` of the last applied command. A command that does not
  supersede the watermark under the §3.1 ordering rule **MUST** be rejected. The *subject*
  is `args.pubkey` for `approve`/`revoke`/`reprocess`, `(args.pubkey, args.talk_d)` for
  talk commands, and the coordinate itself for `recompute` and `detach`.

On backfill/restore, an expired command is skipped — an old `revoke` or `recompute` can
never re-execute after a database loss. Approve/revoke interleavings resolve
deterministically per subject instead of by relay arrival order.

Coordinators **MUST** retain their rumor dedupe ledger (wrap id + rumor id) indefinitely
rather than pruning it by age. A coordinator re-scans its inbox from `since: 0` on install
and on restore, so any dedupe entry aged out under a fixed time-to-live makes the
corresponding rumor look unseen on the next rescan and lets it replay — and only `21604`
admin commands carry an `expires` bound; join requests, submissions, and grants do not.
Bounding the ledger safely again requires a durable, protocol-level generation or expiry
model that covers every rumor kind, not admin commands alone. Only kind-scoped receipts
with their own natural single-use expiry (such as consumed Marmot key packages) may be
pruned by age.

### 3.5 Coordinator installation generation and detach

The `31600` `coordinator` tag is three-element: `["coordinator", <pubkey>, <gen>]` where
`gen` is a positive integer chosen by the organizer, strictly increasing across every
attach/detach/re-attach of the event (persisted in the organizer's `30078` event-keys
backup as `coordinator_gen`). The `21603` install grant carries the same `gen`. A
malformed coordinator tag (a missing element, a non-hex pubkey, or a non-positive-integer
`gen`) **MUST** be treated as no coordinator at all.

Coordinator rules:

- A fresh install **MUST** be authorized by a fetchable newest `31600` (per §3.1) naming
  this coordinator with the same `gen` as the grant, whose declared `inbox` the grant's
  `inbox_nsec` derives. Unfetchable config is retryable, never authorization.
- An install with `gen` ≤ the highest generation ever installed *or detached* for that
  coordinate **MUST** be rejected — a replayed historical `21603` can never re-install.
- **Detach is any newest `31600` that does not name this coordinator with the current
  generation** — including a config with *no* coordinator tag, and a config naming another
  coordinator. On detach the coordinator **MUST** durably tombstone the installation
  (coordinate + last gen), close the event's subscriptions, cancel pending paid work, and
  delete its stored custody of `E_inbox` and the ECK; re-attaching requires a fresh grant
  with a new `gen`.
- On startup the coordinator **MUST** revalidate the newest `31600` for every stored
  installation before resuming it. Fetch failure ⇒ the event stays suspended (no
  processing, no publishing) and revalidation retries; it does not resume leniently.
- An explicit `21604` `detach` command (subject: the coordinate) triggers the same effects
  immediately, without waiting for a config re-fetch; the tombstone records whichever of
  the two signals arrived.

### 3.6 Grant authority

`21602` key grants are accepted only when the seal author is `E_id` or the coordinator
named (with current generation) in the newest fetchable `31600`. A grant whose seal author
is a *formerly* assigned coordinator **MUST** be rejected once a newer config no longer
names it. Missing config is always "retry later," never "accept."

### 3.7 Detach hygiene, record authority, and handover

Deleting custody on detach (§3.5) is the honest coordinator's obligation; a *malicious*
coordinator may retain copies of `E_inbox` and the ECK it held before detach. Detach
therefore has protocol consequences beyond the coordinator's own state:

- **Key rotation on detach/replace.** The organizer's client **SHOULD** rotate the ECK
  (the same machinery as attendee revocation) and **SHOULD** rotate `E_inbox` (mint a new
  inbox keypair, publish it in the new `31600` `inbox` tag, and include the new secret in
  the replacement coordinator's `21603`) whenever detaching or replacing a coordinator.
  Senders always encrypt to the newest config's inbox, so inbox rotation is transparent to
  attendees; organizers retain old inbox secrets locally for reading history. As with every
  ECK rotation, this protects only **future** content — ciphertext already published under
  an old key or old inbox stays readable to whoever held it.
- **Record authority is pinned to the current assignment.** Readers **MUST** accept
  coordinator-authored kinds (31603, 31604, 31605, 31606, 31610) only when authored by
  the coordinator currently named in the newest fetchable `31600`, or by `E_id`. Records
  authored by a formerly assigned coordinator are ignored once a newer config no longer
  names it.
- **Handover republish.** A newly attached coordinator **MUST** republish the event's
  member records (directory, roster, match lists, published talks) under its own key —
  bootstrapping from the previous coordinator's still-decryptable records where custody
  allows, and from reprocessing otherwise — so that record-authority pinning (above) never
  leaves members without a readable directory.

## 4. Encryption model

Every layer reuses an audited primitive — NIP-44 v2 for confidentiality, AES-256-GCM for
media — with no bespoke cryptography.

| Layer | Construction | Used for |
|---|---|---|
| Inbound | NIP-44 v2, sender → `E_inbox` pubkey, inside NIP-59 gift wrap | 21600, 21601, 21608, 21609, 21610 |
| Outbound member content | NIP-44 v2 with the raw 32-byte ECK as conversation key (no ECDH) | 31603, 31604, 31606, 31607, 31608 `private`, 31610 |
| Per-recipient | NIP-44 v2 ECDH, coordinator → recipient | 31605, all grants/status rumors |
| Self-store | NIP-44 v2 self-conversation-key (or signer nip44 to own pubkey) | 31602, 30078 |
| Media | AES-256-GCM, fresh key + 12-byte IV per blob, whole-file | Blossom blobs |

- Every encrypt path enforces the 65,535-byte NIP-44 plaintext ceiling.
- The ECK **never signs anything**.
- **Blinded addresses:** `d = hex(hmac_sha256(key, utf8("<coordinate>|<pubkey>")))[0..32]`
  with `key` = current ECK (directory/match/talk addresses) or the account's self-blinding
  key (self-stores). Talk addresses use the literal-string variant
  `hmac_sha256(ECK, "talk|<coordinate>|<speaker>|<talk_d>")`.
- ECK versions are `{id, key}`; grants carry the full version list; receivers
  **union-merge** (a stale grant never downgrades custody). The current version is the
  highest `id`; rotation on revocation is forward-only and honest about it (old ciphertext
  stays readable to whoever held the old key).

## 5. Gift wraps

Per NIP-59: rumor (unsigned) → kind-13 seal (signed by the true author, NIP-44 to the
recipient, empty tags) → kind-1059 wrap (one-time key, single `p` tag, `created_at`
randomized up to 2 days into the past).

- `RUMOR_KINDS` = {14, 21600–21610}. Nothing else may appear in a wrap; a leaked rumor
  kind is in the ephemeral range so relays won't store it.
- Unwrap validation (every consumer): wrap kind 1059; seal kind 13; structural rumor
  shape; **`rumor.pubkey == seal.pubkey`**; rumor id recomputed and matched; `created_at`
  clamped to ≤ now + 900 s.
- Subscription window: `since = now − 259200` (3 days). Consumers dedupe by rumor id.
- Coordinator dedupe: durable `seen_rumors` ledger keyed by wrap id and rumor id, retained
  indefinitely (§3.4); atomic in-process claim before dispatch; a durable cross-process
  lease is required before two daemons may share one database — until then, single-daemon
  operation per database is a stated constraint.

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
| 21602 | Key Grant | `E_id` or the currently assigned coordinator → attendee |
| 21603 | Coordinator Grant (install) | `E_id` → coordinator |
| 21604 | Admin Command | `E_id` → coordinator |
| 21605 | Organizer Grant | `E_id` → co-organizer |
| 21606 | Coordinator Status | coordinator → organizer, and optionally the affected attendee |
| 21607 | Chat Device Attestation | account → coordinator |
| 21608 | Profile Correction | account → `E_inbox` |
| 21609 | Talk Submission | account → `E_inbox` |
| 21610 | Attendee Withdrawal | account → `E_inbox` |

Standard kinds used: 0, 1, 3, 5, 6, 13, 14, 1059, 10000, 10002, 10050, 10063, 24242,
30023, 30078, 31923/31924/31925, and Marmot's 30443/443/444/445.

`31610` extends past the originally-reserved `31600`–`31609` addressable block, and
`21610` past the originally-reserved `21600`–`21609` rumor block; both remain inside their
respective standard Nostr ranges (parameterized-replaceable 30000–39999, ephemeral
20000–29999).

### 6.2 Addressable kind specifications

Every field below is exactly what `packages/protocol/src/schemas.ts` and `config.ts`
accept. `?` marks an optional field; "(default …)" marks a field the schema fills in when
absent; everything else is required. `.strict()` schemas reject unknown fields; the rest
silently drop them.

#### `31600` — Event Networking Config

- **Class:** parameterized-replaceable. **Signer:** `E_id`. **Visibility:** public;
  `content` is the empty string — every field lives in tags.
- **`d`:** identical to the event's own `31923` `d` tag (one config per calendar event).
- **Tags:**
  - `["d", <event-d>]`, `["a", <coordinate>]`, `["v","2"]` — structural.
  - `["inbox", <E_inbox-pubkey-hex>]` — required, lowercase hex32.
  - `["coordinator", <pubkey-hex>, <gen>]` — optional, three-element (§3.5). Absent =
    no coordinator.
  - `["relay", <wss-url>]` × N — relay set for the event's encrypted traffic.
  - `["blossom", <https-url>]` × N — allowed Blossom origins for media.
  - `["max_video_sec", <int>]` — intro-video cap, default 90; `"0"` means unlimited.
  - `["max_talk_sec", <int>]` — talk cap, default 900; `"0"` means unlimited.
  - `["matching", "on"|"off"]` — default `"off"` (only the literal `"on"` enables it).
  - `["match_visibility", "pair"|"event"]` — default `"pair"`.
  - `["approval", "manual"|"invite"|"manual+invite"]` — default `"manual"`.
  - `["eck", <int>]` — the current ECK version; default/floor 1.
  - `["nostr_context", <int>]` — how many public Nostr events per attendee the
    coordinator summarizes as matching context; default 0 (off).
  - `["lang", <iso639-1>]` — event language; omitted when `"en"` (the implicit default).
  - `["talks", "on"|"prerecord-first"]` — omitted when talks are off (the default).
  - `["chat", "marmot"]` × N — group-chat backends; omitted when chat is disabled.
    Operative only when a `coordinator` tag is also present.
  - `["retention", <days>]` — optional positive integer. When present, the coordinator
    **MUST** delete the event's member records (31603, 31604, 31605, 31606, published
    31610 talks) via NIP-09 and cease processing `<days>` days after the event's end
    time, and clients **MUST** surface the declared retention at join time. Absent =
    indefinite retention. Deletion remains best-effort (relays may not honor NIP-09); the
    privacy model never depends on it succeeding, and client wording must not overpromise.
- Readers apply §3.1 to find the current config; it is the root of trust for every other
  kind on the event.

#### `31601` — Invite List

- **Class:** parameterized-replaceable. **Signer:** `E_id`. **Visibility:** public,
  hash-hidden (the codes themselves never appear on the wire).
- **`d`:** event `d`. **Tags:** `["d", <event-d>]`, `["a", <coordinate>]`, `["v","2"]`.
- **Content:**
  ```
  { v: 2, invites: [{ h: hex32, label?: string ≤100 }] ≤10000 entries }
  ```
  `h` = `sha256(invite-pubkey)`. Voiding a code = republishing the list without its hash.

#### `31602` — Self Event Profile / Reuse Library

- **Class:** parameterized-replaceable. **Signer:** the attendee's account key.
- **Sealing:** the content is **NIP-44 self-encrypted** — the conversation key of the
  signer's key with itself (a local-key signer computes it directly; a remote signer
  calls `nip44Encrypt` targeting its own pubkey).
- Two variants, distinguished by `d` and by the `a` field inside the ciphertext:
  1. **Per-event self-copy** — `d = blindedD(blindingKey, coordinate, ownPubkey)`.
  2. **Reuse library** (spans every event the account joins) —
     `d = blindedDLiteral(blindingKey, "library")`.
- **`blindingKey`:** a local-key signer uses `selfConversationKey(sk)` directly; a remote
  signer generates a random 32-byte seed once and self-stores it in a `30078` event with
  `d = "nostrautica:blindseed"`.
- **Tags:** `[["d", <blinded>]]` only — no `a` tag, so the address itself never reveals
  which event an attendee has joined.
- **Content** (both variants share one schema):
  ```
  {
    v: 2,
    a: <coordinate> | null,          // null on the reuse-library entry
    profile?: AttendeeProfile,
    media: MediaDescriptor[] ≤20 (default []),
    intro_texts?: string[≤2000] ≤20, // library entry only, in practice
    rev?: int ≥0                     // per-event self-copy only; the client's own
                                      // durable store of the last 21601 `rev` it sent
                                      // (survives a device change)
  }
  ```
  `AttendeeProfile = { about: string ≤5000 (default ""), skills: string[≤200] ≤50
  (default []), looking_for: string ≤2000 (default ""), links: url-string ≤2048[] ≤20
  (default []) }`.

#### `31603` — Directory Entry

- **Class:** parameterized-replaceable. **Signer:** the coordinator, or `E_id` when the
  event has no coordinator. **Sealing:** ECK.
- **`d`:** `blindedD(currentECK, coordinate, attendeePubkey)` — rotates whenever the ECK
  rotates.
- **Tags:** `["d", <blinded>]`, `["a", <coordinate>]`, `["eck", <version>]`, `["v","2"]`.
- **Content** (ECK ciphertext):
  ```
  {
    v: 2,
    pubkey: hex32,
    name?: string ≤200,               // display name, echoed from the join request
    profile: AttendeeProfile,         // as in 31602
    media: MediaDescriptor[] ≤20 (default []),
    ai_profile?: AiProfile,           // present once matching-derivation completes
    ai_profile_edited?: bool,         // set when a 21608 correction has been applied
    transcripts?: MediaTranscript[],  // every transcripts[i].x MUST reference a live
                                       // media[].x — a stale transcript is rejected
    intro_text?: string ≤2000,
    updated_at: int
  }
  ```
  `AiProfile = { summary: string ≤5000, skills: string[≤200] ≤50, interests: string[≤200]
  ≤50, offers: string[≤200] ≤50, seeks: string[≤200] ≤50, translations?: { lang: string
  ≤35, about?: string ≤5000, looking_for?: string ≤2000, skills?: string[≤200] ≤50 } }`.
  `MediaTranscript = { x: hex32, text: string ≤100000, lang: string ≤35, source:
  "stt"|"authored", updated_at: int }`.
- **Coordinator publish-time hygiene:** on top of the schema bounds above, the reference
  coordinator additionally re-caps at the moment it publishes — `about`/`looking_for`/
  `intro_text`/`name` to 4000/4000/4000/200 chars, each skills entry to 200 chars within
  the schema's 50-item limit, links to 32 entries of ≤500 chars, transcript text to 8000
  chars, and every LLM-authored string (`ai_profile.*`, match `reasoning`) is
  word-boundary-truncated to 2000 chars and has its `https://`/`http://` prefixes stripped
  so injected text can't render as a clickable link. These are defense-in-depth caps
  tighter than the intake schema, not separate wire fields.
- Deleted via NIP-09 (`["a","31603:<coordinator-pk>:<blinded-d>"]` + `["k","31603"]`) on
  revocation or withdrawal.

#### `31604` — Roster

- **Class:** parameterized-replaceable. **Signer:** the coordinator, or `E_id` without
  one. **Sealing:** ECK. **`d`:** event `d` (one roster per event, not blinded).
- **Tags:** `["d", <event-d>]`, `["a", <coordinate>]`, `["eck", <version>]`, `["v","2"]`.
- **Content:**
  ```
  {
    v: 2,
    eck_current: int >0,
    nostr_group_id?: hex32,           // this event's active Marmot MLS group (§10.4)
    attendees: [
      {
        pubkey: hex32,
        d: string ≤200,               // that attendee's blinded 31603 d
        role: "attendee" | "organizer",
        chat_keys?: [
          { pubkey: hex32, label?: string ≤60, added_at: int }
        ] ≤5                         // per-device chat keys attested for this account
      }
    ] ≤2000
  }
  ```
  `nostr_group_id` is the authoritative event→group routing binding (§10.4); it is
  absent for chat-off events. `chat_keys` is absent for an attendee with no attested
  device.

#### `31605` — Match List

- **Class:** parameterized-replaceable. **Signer:** the coordinator only.
- **Sealing:** NIP-44, coordinator → the recipient attendee (ECDH, **not** ECK).
- **`d`:** `blindedD(currentECK, coordinate, recipientPubkey)` — ECK-derived so only
  members can compute the address, and only the recipient can decrypt the content.
- **Tags:** `["d", <blinded>]`, `["a", <coordinate>]`, `["v","2"]` — no `eck` tag (the
  per-recipient encryption does not need one).
- **Content:**
  ```
  {
    v: 2,
    computed_at: int,
    matches: [
      {
        pubkey: hex32,
        score: number,
        similarity: number,
        complementarity: number,
        reasoning: string ≤2000,
        icebreakers?: string[≤280] ≤3   // concrete conversation starters the
                                         // coordinator derives alongside the
                                         // directional reasoning
      }
    ] ≤100
  }
  ```
  `icebreakers` is additive: a client without support for it simply ignores the field.
  The reference coordinator publishes the top-K matches by score (default K = 20).

#### `31606` — Match Matrix

- **Class:** parameterized-replaceable, opt-in (published only when the event's
  `match_visibility` is `"event"`). **Signer:** the coordinator. **Sealing:** ECK.
- **`d`:** event `d`. **Tags:** `["d", <event-d>]`, `["a", <coordinate>]`,
  `["eck", <version>]`, `["v","2"]`.
- **Content:**
  ```
  { v: 2, computed_at: int, pairs: [{ a: hex32, b: hex32, score: number }] ≤200000 }
  ```
  Pairs are canonically ordered (`a < b`); the matrix carries scores only, never
  reasoning. Deleted (NIP-09) when visibility changes away from `"event"`.

#### `31607` — Members-only Event Post

- **Class:** parameterized-replaceable. **Signer:** `E_id`. **Sealing:** ECK.
- **`d`:** a random 32-hex identifier chosen at creation, stable across edits — **not**
  blinded (there is no `a` tag and no cleartext metadata; discovery is
  `{kinds:[31607], authors:[E_id]}`).
- **Tags:** `["d", <random>]`, `["v","2"]`, `["eck", <version>]`.
- **Content** (ECK ciphertext):
  ```
  {
    v: 2,
    title: string ≤300,
    summary?: string ≤2000,
    image?: string ≤2048,
    published_at: int,     // set on first publish, preserved across edits
    author?: hex32,        // optional organizer attribution
    content: string ≤100000   // markdown
  }
  ```
  The reference editor additionally enforces ≤ 60,000 UTF-8 bytes of markdown at write
  time — comfortably inside both the schema's character cap and the NIP-44 65,535-byte
  plaintext ceiling. Edits re-encrypt under the ECK current at edit time; a post published
  before a rotation is never re-encrypted under the new key.

#### `31608` — Event Page (menu + layout)

- **Class:** parameterized-replaceable. **Signer:** `E_id`. **`d`:** event `d`.
- **Tags:** `["d", <event-d>]`, `["a", <coordinate>]`, `["v","2"]`,
  `["eck", <version>]` (present only when a `private` blob exists), plus
  `["r", <target>, <label>]` × N — the **public** menu, in display order.
- **Content:**
  ```
  {
    v: 2,
    sections: EventPageSection[] (default []),   // PUBLIC layout
    private?: string                             // ECK ciphertext (below)
  }
  ```
  `EventPageSection` is a discriminated union on `type`:
  - `{ type: "posts", source: "event"|"attendees"|"both", visibility:
    "public"|"members"|"both" }`
  - `{ type: "pinned", refs: string[] }` — naddr references.
  - `{ type: "attendees" }` — roster preview; renders only for members.

  The ECK-decrypted `private` payload:
  ```
  {
    v: 2,
    menu: (MenuItem & { pos: int ≥0 })[] (default []),
    sections: (EventPageSection & { pos: int ≥0 })[] (default [])
  }
  ```
  `MenuItem = { label: string ≤200, target: string ≤2048 }` (an https URL or a
  `nostr:naddr…` reference; not format-validated beyond length). `pos` is the item's
  index into the client-side list merged from the public and private items — the merge
  and its inverse split round-trip exactly.

#### `31609` — Event Theme

- **Class:** parameterized-replaceable. **Signer:** `E_id`. **`d`:** event `d`.
- **Tags:** `["d", <event-d>]`, `["a", <coordinate>]`, `["v","2"]`.
- **Content:** raw CSS, plaintext, ≤ 32,768 bytes. Public. Explicitly **not** a
  secret-safe rendering boundary (see §13).

#### `31610` — Talk

- **Class:** parameterized-replaceable. **Signer:** the coordinator, or `E_id` without
  one. **Sealing:** ECK.
- **`d`:** `blindedDLiteral(ECK, "talk|<coordinate>|<speaker-pubkey>|<talk_d>")` — stable
  per (speaker, talk_d) under one ECK; changes on rotation, at which point the coordinator
  republishes under the new address and NIP-09-deletes the old one.
- **Tags:** `["d", <blinded>]`, `["a", <coordinate>]`, `["eck", <version>]`, `["v","2"]`.
- **Content** (ECK ciphertext):
  ```
  {
    v: 2,
    pubkey: hex32,                 // the submitting speaker
    talk_d: string 1..64,
    title: string 1..200,
    description: string ≤2000 (default ""),
    speakers: hex32[] (default []),   // co-speakers; the submitter is implicit
    media: MediaDescriptor,           // kind MUST be "talk"
    transcript?: MediaTranscript,
    lang: string,
    revision: int ≥0,
    status: "pending" | "published" | "rejected",
    published_at: int
  }
  ```
  Only `status: "published"` talks are ever put on the wire in practice; `"pending"`/
  `"rejected"` describe the moderation queue the coordinator keeps privately.

#### `31611` — Coordinator Announcement

- **Class:** parameterized-replaceable. **Signer:** the coordinator's own key.
  **Visibility:** public, plaintext (discovery record).
- **`d`:** the literal `"nostrautica:coordinator"`.
- **Tags:** `["d","nostrautica:coordinator"]`, `["v","2"]`.
- **Content:**
  ```
  {
    v: 2,
    name: string 1..120,
    about?: string ≤2000,
    picture?: string ≤2048,
    operator?: string ≤200,
    relays: string[] ≤30 (default []),
    features: {
      matching: bool (default true),
      talks: bool (default false),
      chat: string[] ≤30 (default [])     // Marmot chat-relay URLs, when offered
    } (default {}),
    privacy?: { [role: string]: string },  // per-role disclosure tier, e.g. "private"
    terms_url?: https-string ≤2048,
    pricing?: {
      model: "free"|"per_user"|"per_event"|"negotiated"|"external",
      free_up_to_users?: int ≥0,
      summary?: string ≤280,
      checkout_url?: https-string ≤2048,
      currency?: string ≤16
    }
  }
  ```
  See §9 for how `privacy` and `pricing` are meant to be generated.

### 6.3 Rumor kind specifications

Every rumor below travels only inside a NIP-59 gift wrap (§5); none is ever a signed,
relay-visible event on its own.

#### `21600` — Join Request

- **Seal author → recipient:** attendee account → `E_inbox`.
- **Tags:** `["a", <coordinate>]`; optionally
  `["invite", <invite-pubkey-hex>, <schnorr-sig-hex>]` (§7).
- **Content:**
  ```
  { v: 2, name: string ≤200, message: string ≤2000 (default ""), rsvp_public: bool (default false) }
  ```
  When `rsvp_public` is true, the client additionally publishes a public kind-31925 RSVP
  with `["a", <coordinate>]`, `["d", "<coordinate>:<attendeePubkey>"]`,
  `["status","accepted"]`.

#### `21601` — Profile Submission

- **Seal author → recipient:** attendee account → `E_inbox`.
- **Tags:** `["a", <coordinate>]`.
- **Content:**
  ```
  {
    v: 2,
    rev: int ≥0,
    profile: AttendeeProfile,
    media: MediaDescriptor[] ≤4 (default []),
    intro_text?: string ≤2000
  }
  ```
- Ordering per §3.3. `intro_text` is a text-only alternative to a recorded intro; it feeds
  the derived `ai_profile` the same way a transcript would, without a media blob.

#### `21602` — Key Grant

- **Seal author → recipient:** `E_id`, or the coordinator currently named (with current
  generation) in the newest fetchable `31600` (§3.6) → the attendee.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    role: "attendee" | "organizer",
    eck: [{ id: int >0, key: base64(32 bytes) }],
    granted_by: hex32
  }
  ```
  `granted_by` **MUST** equal the seal author. Receivers **union-merge** the granted ECK
  versions into local custody — a stale grant never removes or downgrades a newer known
  version, and an attendee-role grant never downgrades a stored organizer role.

#### `21603` — Coordinator Grant (install)

- **Seal author → recipient:** `E_id` → coordinator.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    gen: int >0,
    inbox_nsec: hex32,
    eck: [{ id: int >0, key: base64(32 bytes) }],
    config_relays: string[] ≤30
  }
  ```
- Seal author **MUST** equal the coordinate's `E_id`. Install authorization and the `gen`
  rules are §3.5.

#### `21604` — Admin Command

- **Seal author → recipient:** `E_id` → coordinator.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    cmd: "approve" | "recompute" | "reprocess" | "revoke" | "talk_publish" | "talk_reject" | "detach",
    args: { [key: string]: unknown } (default {}),
    expires: int
  }
  ```
  `args` by command: `approve`/`reprocess`/`revoke` → `{ pubkey }`; `talk_publish`/
  `talk_reject` → `{ pubkey, talk_d }`; `recompute`/`detach` → `{}`. Seal author **MUST**
  equal the installed event's `E_id`. Ordering, expiry, and `detach`'s effects are §3.4
  and §3.5.

#### `21605` — Organizer Grant

- **Seal author → recipient:** `E_id` → co-organizer.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    eid_nsec: hex32,
    einbox_nsec: hex32,
    eck: [{ id: int >0, key: base64(32 bytes) }],
    config_relays: string[] ≤30,
    granted_by: hex32
  }
  ```
- Seal author **MUST be exactly `E_id`**; `granted_by` **MUST** equal the seal author.
  Grants full, irrevocable custody of `E_id`, `E_inbox`, and every known ECK version — a
  co-organizer is cryptographically indistinguishable from the event's creator (§13).
  Receivers union-merge the granted ECK versions the same way `21602` does.

#### `21606` — Coordinator Status

- **Seal author → recipient:** the coordinator → the organizer (`E_id`), and, for status
  restricted to one attendee's own pipeline items, optionally *also* → that attendee.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    pubkey?: hex32,             // affected attendee, when the item is attendee-scoped
    stage?: string,             // job type, e.g. "process_attendee"
    state?: "poison" | "cleared",
    attempts?: int ≥0,
    error_category?: string,    // sanitized class, never raw attendee/provider text
    retryable?: bool,
    billing?: {
      state: "ok" | "payment_required" | "grace",
      reason?: string ≤500,
      checkout_url?: https-string ≤2048,
      due?: number ≥0,
      currency?: string ≤16,
      grace_until?: int
    },
    at: int
  }
  ```
  A status is a poison/health report (the poison fields set), a billing update (`billing`
  set), or both. A rumor sent to an affected attendee is scoped to that attendee's own
  submission/talk pipeline failures; billing status is sent only to organizers.

#### `21607` — Chat Device Attestation

- **Seal author → recipient:** the attendee's **account** key → coordinator.
- **Content** (`.strict()`):
  ```
  {
    v: 2,
    a: <coordinate>,
    op: "add" | "revoke",
    chat_pubkey: hex32,
    label?: string ≤60,       // required when op:"add" ("Chrome on laptop")
    client_id?: string ≤120,  // stable per-device kind-30443 key-package slot id
    proof?: schnorr-sig-hex   // required when op:"add"
  }
  ```
  `proof` is a BIP-340 signature by the **chat device key** over
  `sha256(utf8(JSON.stringify(["nostrautica-chat-device-v2", <coordinate>,
  <account-pubkey>, <chat_pubkey>, <rumor created_at>])))`. Full mechanics are §10.2.

#### `21608` — Profile Correction

- **Seal author → recipient:** attendee account → `E_inbox`.
- **Tags:** `["a", <coordinate>]`.
- **Content:**
  ```
  {
    v: 2,
    a: <coordinate>,
    rev: int ≥0,
    overrides?: {
      summary?: string ≤5000,
      skills?: string[≤200] ≤50,
      interests?: string[≤200] ≤50,
      offers?: string[≤200] ≤50,
      seeks?: string[≤200] ≤50
    },
    hidden?: bool,                 // publish the directory entry with NO ai_profile
    hidden_fields?: ("summary"|"skills"|"interests"|"offers"|"seeks")[],
    report?: string ≤2000          // free-text "this is inaccurate" note to the organizer
  }
  ```
  The subject is the seal author — an attendee can only correct their own directory
  entry. `overrides` is bounded exactly like `ai_profile` itself. Ordering per §3.3. The
  correction is stored by the coordinator and re-applied on every `31603` republish
  (surviving reprocessing); authored identity fields (`about`/`skills`/`looking_for`/
  `links`) are never touched by a correction.

#### `21609` — Talk Submission

- **Seal author → recipient:** the speaker (attendee account) → `E_inbox`.
- **Tags:** `["a", <coordinate>]`.
- **Content** (`.strict()`, and `media.kind` **MUST** be `"talk"`):
  ```
  {
    v: 2,
    a: <coordinate>,
    talk_d: string 1..64,          // stable per-speaker id; editing resubmits the same id
    title: string 1..200,
    description: string ≤2000 (default ""),
    speakers: hex32[] (default []),  // co-speakers; the submitter is implicit
    media: MediaDescriptor,
    revision: int ≥0 (default 0)
  }
  ```
  Ordering per §3.3. Normative caps: at most 10 distinct `talk_d` per speaker per event
  (edits to an existing `talk_d` are uncapped).

#### `21610` — Attendee Withdrawal

- **Seal author → recipient:** the withdrawing attendee's account key → `E_inbox`.
- **Content** (`.strict()`):
  ```
  { v: 2, a: <coordinate>, delete_data?: bool (default true) }
  ```
- Semantics: attendee-initiated removal from the event — the same effect chain as an
  organizer `revoke` (roster/directory/match removal, NIP-09 deletions, ECK rotation),
  triggered without requiring organizer action. `delete_data: false` requests removal from
  future publications while retaining the coordinator's already-processed artifacts (e.g.
  to support a later re-approval without reprocessing); the default is full deletion. The
  withdrawing client **SHOULD** also delete its own Blossom blobs (uploader-authorized)
  and its `31602` per-event self-copy. Ordering uses the §3.4 per-subject watermark, where
  the subject is the sender. Rejoining afterward is a fresh `21600` join request.

## 7. Invite codes

An invite code is a throwaway nsec, transported only in the URL fragment
(`#/e/:naddr/join?code=<nsec>`).

- `31601` content carries `h = sha256(invite-pubkey)` per code (hash-hidden: observers
  can't enumerate or front-run codes).
- **Proof:** the join request carries `["invite", <invite-pubkey-hex>, <sig-hex>]` where
  the signature is BIP-340 over:

  ```
  challenge = sha256( utf8( JSON.stringify(
      ["nostrautica-invite-v2", <coordinate>, <attendee-pubkey-hex>] ) ) )
  ```

  The literal first element is a domain-separation tag; JSON-array encoding is injective,
  so the challenge can never collide with a differently-shaped message that happens to
  serialize to the same bytes.
- Verification is stateless: `sha256(invite-pubkey) ∈ newest 31601` ∧ signature valid.
- **Single-use:** the coordinator claims per invite pubkey, **first-processed wins**;
  later uses fall back to the manual approval queue (a benign failure mode). This is
  eventually consistent by design — the organizer client and the coordinator do not share
  claim state, so a code can independently be "used" once locally by each.

## 8. Media descriptors

`.strict()` schema; unknown fields are rejected (a descriptor drives coordinator fetch and
transcoding, so an unexpected field is a hard error, not a silently-ignored one).

```json
{
  "kind": "intro" | "talk",
  "url": ["https://…", …],                 // https-only, ≥ 1 entry
  "x": "<sha256 hex of ciphertext>",
  "ox": "<sha256 hex of plaintext>",
  "size": "<int ≥ 1, ciphertext bytes>",
  "m": "<mime type>",
  "duration": "<seconds, number ≥ 0>",      // REQUIRED when m starts with audio/ or video/
  "encryption-algorithm": "aes-gcm",
  "decryption-key": "<base64, decodes to exactly 32 bytes>",
  "decryption-nonce": "<base64, decodes to exactly 12 bytes>"
}
```

- **Crypto:** AES-256-GCM, a fresh key and 12-byte IV per blob, single-shot whole-file (no
  range/streaming playback). The decryption key and nonce travel *inside* the descriptor,
  never as a separate event. A "fresh copy" (decrypt → re-encrypt with a new key/IV)
  produces an unlinkable blob hash, breaking cross-event linkage by ciphertext reuse.
- Coordinator enforcement, tighter than the schema's per-field bounds:
  - At most **4** media descriptors are processed per `21601` submission; the schema
    itself caps a submission's array at 4 entries (`MAX_SUBMISSION_MEDIA`), while the
    `31602` self-copy/reuse-library variant allows up to 20 (it legitimately holds more
    across an attendee's history).
  - At most **500 MiB** declared total per submission.
  - A descriptor's declared `duration` is checked against the event's `max_video_sec`/
    `max_talk_sec` (§6.2 `31600`).
  - The coordinator **MUST** compare the actual downloaded ciphertext length against
    `size` and reject a mismatch, and **SHOULD** probe the real decoded duration before
    running speech-to-text and reject media exceeding the event's limit regardless of the
    declared value.
  - Blossom fetches are restricted to the event's `31600` `blossom` origin allowlist.
- The https-only rule applies again at render boundaries — a client must not surface a
  plain-http media URL as a clickable/loadable resource even if one somehow parsed.

## 9. Coordinator lifecycle, billing, and announcements

- **Install** / **detach** / startup revalidation: §3.5. **Detach hygiene, record
  authority, and handover:** §3.7.
- **Billing principal: the event identity (`E_id`).** Coordinator configuration names its
  free-tier allowlist `free_eids` — a set of `E_id` pubkeys, since nothing in the protocol
  authenticates a personal-organizer identity independent of the events they create. The
  coordinator persists a typed billing principal per installation.
- **Billing is a persisted state machine** — internally `evaluating → ok | grace |
  blocked` — re-evaluated at install, on attendee-count change, on submission revision, at
  job claim, and immediately before provider spend. `blocked` stops paid work but never
  blocks revoke, detach, roster repair, or status publication. A state transition emits a
  `21606` with the `billing` block; the wire has no `"blocked"` state of its own — a
  blocked installation is reported as `billing.state: "payment_required"`.
- **Announcements (`31611`) are generated from resolved runtime provider routes, not
  configured intent** — the `privacy` disclosure map describes where attendee data
  actually flows for each processing role, not merely what an operator intended to
  configure.

## 10. Group chat (Marmot/MLS) and multi-device

### 10.1 Model

- One MLS group per event, created and administered by the coordinator (admin bot):
  add-on-approval, remove-on-revoke, member-driven device adds via attestation.
- **Chat identity is per device.** Every browser/device mints its own chat device keypair
  on first chat use — for *all* account types (local key, NIP-07, NIP-46). There is no
  shared chat key, no relay backup of chat secrets, and no cross-device restore of chat
  identity. A device is *added* by attestation and *removed* by revocation; loss of a
  device is handled by revoking its key, not recovering it.
- One account may hold up to `MAX_CHAT_KEYS_PER_ACCOUNT = 5` concurrent device keys per
  event. Each device gets its own MLS leaf, its own key package (kind `30443`, with a
  stable `client_id` slot per device), and its own Welcome; each device sees history only
  from its own join epoch forward (MLS semantics — history never syncs, by design).

### 10.2 Chat Device Attestation (21607)

Sealed by the **account** key to the coordinator (schema in §6.3). `proof` is a BIP-340
signature by the **chat device key**, required on `op:"add"`, over:

```
sha256( utf8( JSON.stringify(
  ["nostrautica-chat-device-v2", <coordinate>, <account-pubkey>, <chat_pubkey>, <created_at>] ) ) )
```

The coordinator **MUST** verify the proof before binding a device to an account — an
account cannot attest a key it does not control. `op:"revoke"` needs no proof (the account
is evicting a key it already named; possession is irrelevant to that decision). Bindings
are per (coordinate, account); a chat pubkey **MUST NOT** be bindable to two different
accounts; rebinding it to the same account (e.g. re-add after revoke) mints a fresh
binding. On account revocation from the event, **all** of that account's device leaves are
removed from the MLS group.

### 10.3 Device profiles (kind 0 on chat relays)

So that other Marmot clients (e.g. White Noise) display a human name for each device
member, every chat device publishes a **kind 0 profile signed by the chat device key, to
the event's chat relay set only** (the Marmot relays — never the account's general
relays):

```json
{ "name": "<account display name>", "about": "<note pointing at the account's npub>", "picture": "<optional>" }
```

- `name` equals the account's event display name (falling back to a generic label);
  devices belonging to one account share the same name. `about` references the owning
  account's npub in prose, so external clients can verify and group devices by account.
  This is an accepted, stated consequence: the device→account link is **public on the
  chat relays**; the ECK-encrypted roster `chat_keys` mapping remains the authoritative
  binding for Nostrautica clients themselves.
- The app **MUST NOT** publish or fetch account kind 0 on chat relays, and **MUST NOT**
  publish device kind 0 anywhere else.

### 10.4 Event→group routing

- The roster's `nostr_group_id` is the authoritative binding from coordinate to the
  active MLS group. A newly received Welcome joins into an **unbound candidate** state: no
  listener binding, no history replay, no display, no sending until a verified roster
  `nostr_group_id` matches. Roster-fetch failure keeps the candidate pending —
  **fail-closed**: a client that cannot verify the binding must not guess it.
- The coordinator **SHOULD** additionally include the event coordinate in the Marmot
  group's name/description metadata as defense in depth; clients treat it as a hint, not
  authority.

## 11. Talks

Normative caps: at most 10 distinct `talk_d` per speaker per event; a talk media
descriptor's `kind` must be `"talk"`; a published `31610` is republished under a new ECK
on rotation, with the old-address copy NIP-09-deleted.

## 12. Deletions

The coordinator issues NIP-09 kind-5 with both `["a", "<kind>:<pubkey>:<d>"]` and
`["k","<kind>"]` for: a revoked or withdrawn attendee's `31603`, a `31606` on visibility
downgrade, and obsolete `31610` addresses after rotation or rejection. Deletion is
best-effort; the privacy model never depends on relays honoring it.

## 13. Security considerations

- **Forward-only revocation** — anyone who held a key reads everything published while it
  was current, forever. Stated in organizer UI. MLS chat removal has real post-compromise
  security, unlike ECK rotation.
- **Coordinator trust** — reads all event-encrypted content, holds `E_inbox`/ECK, grants,
  publishes member records, reads and administers chat. Cannot sign as `E_id`. Its
  authority ends at detach (§3.5), enforced by record-authority pinning (§3.7).
- **Accepted metadata leaks** — attendee counts (directory-entry counts), submission
  timing (`E_inbox` p-tags), cross-event blob-hash linkage without a "fresh copy," chat
  relay traffic patterns, device-profile names on chat relays (§10.3).
- **Organizer CSS (31609)** is presentation control by the same party that controls all
  rendered text; it is **not** a secret-safe boundary. Clients **MUST NOT** render event
  themes on routes where secrets (invite nsecs, key backups, chat handoff) appear.
- **Prompt injection** into AI profiles/matching by attendee content remains semantically
  possible; outputs are length-capped and URL-neutralized at the coordinator's publish
  boundary (§6.2 `31603`); organizers see provenance.
- **`21605` organizer grants are irrevocable full custody** — co-organizers are
  cryptographically indistinguishable from the creator. Scoped roles are not part of this
  protocol.
- **Readers MUST only accept coordinator-authored kinds from the currently assigned
  coordinator** (§3.7) — a formerly assigned coordinator's records are ignored once a
  newer `31600` no longer names it.

## 14. Constants appendix

Wire-normative bounds (`packages/protocol/src/schemas.ts`, `crypto.ts`, `giftwrap.ts`,
`config.ts`, `event-page.ts` unless noted):

- NIP-44 plaintext ceiling: **65,535 bytes**, enforced at every encrypt entry point.
- Blinded `d` length: 32 hex chars (128 bits of HMAC-SHA256 output).
- Gift-wrap subscription window: `now − 259,200 s` (3 days). Wrap timestamp
  randomization: ≤ 2 days into the past. Rumor future-timestamp clamp:
  `RUMOR_MAX_CLOCK_SKEW_SEC = 900 s` (15 min).
- Admin command replay horizon: `ADMIN_COMMAND_TTL_SEC = 172,800 s` (48 h), client
  default.
- `MAX_NAME` 200, `MAX_MESSAGE` 2000, `MAX_ABOUT` 5000, `MAX_LOOKING_FOR` 2000,
  `MAX_SKILLS` 50, `MAX_SKILL` 200, `MAX_LINKS` 20, `MAX_URL` 2048,
  `MAX_INVITE_LABEL` 100, `MAX_INVITES` 10000, `MAX_REASONING` 2000, `MAX_MATCHES` 100,
  `MAX_ROSTER` 2000, `MAX_RELAYS` 30, `MAX_MEDIA` 20 (31602), `MAX_SUBMISSION_MEDIA` 4
  (21601), `MAX_D` 200, `MAX_MATCH_PAIRS` 200000, `MAX_TITLE` 300, `MAX_POST_BODY`
  100000, `MAX_NOTES` 2000, `MAX_NOTE` 5000, `MAX_LANG` 35, `MAX_TRANSCRIPT_TEXT`
  100000, `MAX_INTRO_TEXT` 2000, `MAX_LIBRARY_TEXTS` 20, `MAX_TALK_TITLE` 200,
  `MAX_TALK_DESC` 2000, `talk_d` length 1..64, `MAX_CHAT_KEY_LABEL` 60,
  `MAX_CHAT_KEY_CLIENT_ID` 120, `MAX_CHAT_KEYS_PER_ACCOUNT` 5.
- Icebreakers (31605, §6.2): ≤ 3 per match entry, ≤ 280 chars each.
- Members-only post markdown editor cap: 60,000 UTF-8 bytes
  (`MAX_MEMBERS_POST_MARKDOWN_BYTES`). Theme CSS: 32,768 bytes (`MAX_THEME_CSS_BYTES`).
- Media descriptor: `size ≥ 1` byte; `duration` required for `audio/*` and `video/*`
  mime types; decryption key decodes to exactly 32 bytes, nonce to exactly 12 bytes.

Coordinator operational defaults (`packages/coordinator/src/coordinator.ts` and
neighboring modules — tunable per deployment, not part of interop compatibility):

- `DEFAULT_MAX_EVENTS` 50 installations per coordinator.
- Media processing: ≤ 4 descriptors processed per submission (`MAX_MEDIA_PER_SUBMISSION`,
  mirrors the schema's `MAX_SUBMISSION_MEDIA`), ≤ 500 MiB declared bytes per submission
  (`MAX_SUBMISSION_MEDIA_BYTES`).
- `MAX_TALKS_PER_SPEAKER` 10 distinct `talk_d` per speaker per event.
- Gift-wrap live-processing retry backoff: `[5 s, 30 s]`, then the rumor is left unseen
  for the next backfill rescan.
- Pipeline job retry: default backoff escalates from 1 s through hourly and then
  four-hourly steps, keeping a job retrying for at least 3 days before it poisons and
  emits a `21606` status.
- Matching: `topK` 20 (match list size), `batchSize` 10 (scoring batch), embedding
  prefilter default `threshold` 50 attendees / `topM` 30 / `random` 10.
- Publish-time defense-in-depth caps on `31603` (tighter than the intake schema, §6.2):
  `about`/`looking_for`/`intro_text`/`name` 4000/4000/4000/200 chars, links 32 × 500
  chars, transcript text 8000 chars, LLM-authored strings (`ai_profile.*`, match
  `reasoning`) word-boundary-truncated to 2000 chars with URL schemes stripped.
- Marmot: key-package kind `30443`, group-message kind `445` (routed by `#h`); the
  Whitenoise relays (`wss://relay.us.whitenoise.chat`, `wss://relay.eu.whitenoise.chat`)
  are folded into chat relay routing.
