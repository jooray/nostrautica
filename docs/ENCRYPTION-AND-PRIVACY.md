# Nostrautica — Encryption & Privacy Review

A sanity review of how key material is used across the codebase. Unlike
`THREAT-MODEL.md` (which restates the spec's intent), this document is written
**against the actual code** in `packages/protocol`, `packages/app`, and
`packages/coordinator`, and calls out where code and spec disagree. It is meant
to be accurate, not flattering.

Verified against the tree on `main` (2026-07-14); findings F1–F3 were fixed in
code on 2026-07-15 and are marked as such below. Primary sources:
`packages/protocol/src/crypto.ts`, `giftwrap.ts`; `packages/app/src/lib/events/{create,join,organizer,attendee,keystore,blinding}.ts`,
`packages/app/src/lib/signer/{session.svelte,backup,keystore}.ts`;
`packages/coordinator/src/{coordinator,config}.ts`, `store/db.ts`, `pipeline/entitlement.ts`.

---

## 1. Summary

The design is coherent and, for its stated purpose (short-lived conference
networking data), basically sane. It uses audited primitives throughout — no
bespoke crypto. The two-key event model (`E_id` identity vs `E_inbox` inbox) is
a genuinely good idea and is implemented as specified: pre-approval attendees can
encrypt to a stable key the coordinator can read, without giving the coordinator
the power to impersonate the event.

The honest caveats the spec already admits are all real: **no forward secrecy,
no true revocation** (anyone who ever held an ECK keeps it forever), and a
**fully-trusted coordinator** that reads all event content in plaintext. Beyond
those, this review flags several concrete issues the spec is quieter about:

- The **ECK is not in the invite link** — a coordinator (or the organizer's
  online client) is *required* to distribute event access. The invite link only
  auto-*requests*; it does not auto-*admit*. (§3, §4)
- The coordinator stored **`E_inbox` nsec and every ECK in plaintext SQLite** on
  disk. **Fixed 2026-07-15** — now NIP-44-encrypted at rest under the
  coordinator identity key. (§2, F1)
- The coordinator **did not verify that a `21603` install grant actually came
  from `E_id`**. **Fixed 2026-07-15** — the seal author must now equal the
  coordinate's `E_id` pubkey, same as `21604`. (§6, F2)
- **Invite `nsec` in the URL fragment** leaked through browser history because,
  unlike the login-`nsec` link, it was never stripped after consumption.
  **Fixed 2026-07-15** — stripped from URL + history the moment it is read; the
  remaining exposure (clipboard, share sheets, shoulder-surf) is inherent to
  link-based invites. (§7, F3)

None of these were catastrophic for the threat model as scoped; the three
concrete code issues (F1–F3) have since been fixed.

### Key inventory

| Key | Type | Generated | Stored where | Held by | Distributed how |
|---|---|---|---|---|---|
| **User identity** (npub/nsec) | secp256k1 | `LocalSigner.generate()` on first use, or brought via NIP-07/NIP-46/import | IndexedDB **raw bytes** (`nostrautica` DB, `keystore` store) for local keys; never leaves the extension/Amber for NIP-07/46 | the user | never (local key); email-`nsec` link + ncryptsec export are user-initiated backups |
| **`E_id`** (event identity) | secp256k1 | `generateSecretKey()` at event create | organizer IndexedDB (`nostrautica-eventkeys`), plus self-encrypted `30078` backup on relays | organizer + co-organizers | co-organizer only, via `21605` gift wrap. **Never** to attendees or coordinator |
| **`E_inbox`** (event inbox) | secp256k1 | `generateSecretKey()` at event create | organizer IndexedDB + `30078` backup; coordinator SQLite (**NIP-44-encrypted under the coordinator identity key**, F1) | organizer + co-organizers + coordinator | to coordinator via `21603`; to co-organizer via `21605`. Never to attendees |
| **ECK** (Event Content Key) | 32 random bytes | `generateEck()` at create; new version on each revoke | organizer/attendee IndexedDB (`eck` array, base64); coordinator SQLite (**NIP-44-encrypted under the coordinator identity key**, F1); relay backups (`30078` for organizer; the `21602` grants themselves for attendees) | organizer + coordinator + every approved attendee | to attendees via `21602`/`21605` gift wrap |
| **Invite code** | secp256k1 nsec | `generateSecretKey()` per code | shown once to organizer; only `sha256(pubkey)` published in `31601` | organizer, then whoever holds the link | in the invite-link URL **fragment** |
| **Coordinator identity** | secp256k1 | operator-provided | env `NOSTRAUTICA_COORDINATOR_NSEC` or `ncryptsec_file` + passphrase | coordinator operator | public key referenced in `31600` `coordinator` tag |
| **Media key** (AES-256-GCM) | 32 bytes + 12-byte IV | fresh per blob, `aesGcmEncrypt()` | only inside encrypted media descriptors | anyone who can read the descriptor | rides inside `21601`/`31602`/`31603` payloads, never its own event |
| **Blinding key** | derived / 32-byte seed | self-conversation-key (local) or random seed in `30078` `nostrautica:blindseed` (remote signer) | derived, or self-encrypted `30078` | the user | never (it's a self-secret) |

---

## 2. Encryption primitives — what's used where

All confidentiality reuses **NIP-44 v2** (ChaCha20 + HMAC-SHA256, padded) from
`nostr-tools`, or WebCrypto **AES-256-GCM** for media. No NIP-04 (banned
project-wide; the ladder passes `'nip44'` explicitly). Source: `crypto.ts`.

| Purpose | Scheme | Notes |
|---|---|---|
| Inbound submissions → `E_inbox` | NIP-44 (sender→`E_inbox.pubkey`) inside a **NIP-59 gift wrap** | `join.ts`, `giftwrap.ts` |
| Event-wide content (directory, roster, matrix) | **ECK as a raw NIP-44 conversation key** (`eckEncrypt`/`eckDecrypt`) | symmetric: the 32-byte ECK is fed directly to `nip44v2.encrypt` in place of an ECDH conversation key — a legitimate use of the primitive |
| Match lists (`31605`) | NIP-44 coordinator→recipient | directional; only the pair reads it |
| User-private (`30078`, self-copy `31602`, key backups) | NIP-44 **self-encryption** (`getConversationKey(sk, ownPubkey)`) | `selfEncrypt`/`selfDecrypt` |
| Grants, admin commands, DMs | NIP-59 gift wrap (rumor → seal kind 13 → wrap kind 1059, one-time key) | `wrapRumor`/`unwrapRumor` |
| Media blobs on Blossom | AES-256-GCM, fresh key+IV per blob, whole-file single-shot | `aesGcmEncrypt`; no chunked/streaming (documented v1 limit) |
| Blinded `d`-tags | HMAC-SHA256(key, message), first 16 bytes | `blindedD`; key = self-conv-key (31602) or ECK (31603/31605) |
| Invite proofs | Schnorr sig by the invite key over `sha256("coordinate:attendee-pubkey")` | `makeInviteProof`/`verifyInviteProof` |

**Assessment: primitives are used correctly.** Using the ECK directly as a
NIP-44 conversation key is unusual but sound — NIP-44's construction takes a
32-byte symmetric key and does not require it be an ECDH output. AES-GCM uses a
fresh 12-byte random nonce per blob with a fresh 32-byte key, so the
GCM nonce-reuse footgun is avoided by construction (key and nonce are always
generated together). The blinded-`d` HMAC truncation to 128 bits is fine for a
name-collision-resistance role.

One structural weakness inherent to the ECK model: **the same 32-byte ECK is
both the key and the "conversation" for every entry.** All directory entries,
roster, and matrix for a given ECK version share one key. There is no
per-recipient or per-entry key separation within a version — which is exactly
why "revocation" can only mean minting a new version (§4).

---

## 3. The invite / join flow, step by step

This is the flow the task asks to be traced concretely, because the spec's
prose can read as if the invite link alone admits you. **It does not.** The
invite link auto-*requests* and (with a coordinator) auto-*approves the request*
— but the ECK that actually grants access is always distributed by an online
party, never embedded in the link.

**Invite generation** (`organizer.ts` `generateInvites`):
1. Organizer mints N secp256k1 keypairs (each *is* an invite code / nsec).
2. Publishes a replaceable `31601` list containing only `sha256(invite-pubkey)`
   per code — so observers can't enumerate valid codes.
3. Builds a link: `…/#/e/<naddr>/join?code=<invite-nsec>`.
   *(Note: spec §6.5 writes this as `#/join?event=<naddr>&code=…`; the code uses
   the `#/e/:naddr/join?code=` route form. Same mechanism, different route
   shape — a spec/code cosmetic mismatch.)*

**Join** (`join.ts` `sendJoinRequest`, driven by `Join.svelte`):
4. Attendee opens the link; the app parses the `code` out of the fragment.
5. The client builds an **invite proof**: a Schnorr signature by the invite key
   over `sha256("<coordinate>:<attendee-pubkey>")`, binding the code to *this*
   attendee. An intercepted proof is useless to anyone else.
6. It gift-wraps a **`21600` Join Request** to `E_inbox.pubkey` carrying
   `["invite", <invite-pubkey>, <sig>]`, optionally a **`21601` Profile
   Submission**, and saves a self-copy **`31602`**.

**Approval — where the ECK actually comes from:**
7a. **With a coordinator** (`coordinator.ts` `handleJoin` → `evaluateEntitlement`
    → `InviteChecker`): the coordinator fetches the current `31601` hash set,
    checks `isInviteValid` (hash membership ∧ signature), claims the invite
    pubkey first-come single-use in its SQLite, and if OK calls
    `grantAndPublish`: publishes a **`21602` Key Grant** (the ECK, gift-wrapped
    to the attendee), the directory entry, and the roster. This is typically
    within seconds — `Join.svelte` polls for the grant.
7b. **Without a coordinator**: nothing auto-approves. The invited attendee lands
    in the manual queue; the organizer's client (`organizer.ts` `approveAttendee`)
    must be opened to unwrap `E_inbox` requests and issue the `21602`.

**The key fact:** the ECK is **not** in the invite link and is **never**
derivable from it. Access requires an online grantor (coordinator daemon, or the
organizer's browser). The invite link's only power is to skip the *manual
review* step — and only if a coordinator is running. This is the correct design
(you cannot put the shared key in a URL and still hope to revoke or scope it),
but it means "auto-accept invite links" have a hard liveness dependency on the
coordinator that the UI should make honest.

---

## 4. Creator, admins, shared secret, coordinator — who can decrypt / grant what

**Roles and custody** (from `create.ts`, `organizer.ts`, `attendee.ts`):

- **Event creator** holds `E_id`, `E_inbox`, and all ECK versions. Can do
  everything: edit the public event, read submissions, grant/revoke, attach a
  coordinator, add co-organizers.
- **Delegated admins (co-organizers)** are added via `addCoOrganizer` →
  **`21605` Organizer Grant**, which hands over **full key custody**: `E_id`
  nsec + `E_inbox` nsec + all ECK versions. Their client stores them as an
  `organizer`-role record (`attendee.ts` `receiveGrants`). **There is no
  scoped/approve-only admin role** — the spec flags scoped roles as future work
  (§13), and the code confirms it: a co-organizer is cryptographically
  indistinguishable from the creator. Anyone made an admin can themselves add
  more admins, revoke attendees, and impersonate the event's signing identity.
- **Coordinator** holds `E_inbox` + all ECK versions (via `21603`), plus its own
  identity key. It can read every submission and all event-encrypted content and
  authors the directory/roster/matches — but it **never** holds `E_id`, so it
  cannot alter the public event, config, or invite list, and cannot sign as the
  event.
- **Approved attendees** hold only the ECK versions granted to them. They can
  decrypt the roster, all directory entries, and their own match list. They
  cannot read pre-approval submissions (those are to `E_inbox`) or other people's
  match lists.

**Who can decrypt what:**

| Data | Creator | Co-org | Coordinator | Approved attendee | Non-attendee / relay |
|---|---|---|---|---|---|
| Public event / config / invite hashes | ✔ | ✔ | ✔ | ✔ | ✔ (it's public) |
| Inbound submissions (`E_inbox`) | ✔ | ✔ | ✔ | ✘ | ✘ |
| Directory / roster / matrix (ECK) | ✔ | ✔ | ✔ | ✔ | ✘ |
| A pair's match reasoning (`31605`) | ✘¹ | ✘¹ | ✔² | ✔ (own list only) | ✘ |
| User-private `30078` (favorites, notes) | ✘ | ✘ | ✘ | ✔ (self only) | ✘ |

¹ Organizers can't read pairwise match reasoning under the default
`match_visibility:"pair"` — it's NIP-44'd coordinator→recipient. (They *can* see
the score matrix if `match_visibility:"event"` is enabled, `31606`, under ECK.)
² The coordinator authors the match lists, so it necessarily knows all
reasoning.

**Granting access:** only ECK holders who also hold `E_id` (creator +
co-organizers) or the coordinator can issue `21602` grants. A plain attendee
cannot grant anyone anything.

**Revocation — the honest truth (matches spec §6.3, verified in
`organizer.ts` `revokeAttendeeClient` and `coordinator.ts` `revokeAttendee`):**
Removing an attendee mints ECK v(n+1), gift-wraps it to every *remaining*
attendee, re-encrypts future directory/roster content under it, and deletes the
removed entry via NIP-09. **This is forward-only and cannot un-share the past.**
The removed member keeps ECK v1..vn forever and can decrypt any ciphertext that
was published under those versions — including anything they cached before
removal. NIP-09 deletion is also only advisory: relays may ignore it, and the
removed member likely already has the plaintext. So: *access to future content
is revocable; access to already-published content is not, ever.* For the data in
question (intro videos, match lists) the spec accepts this; it must be surfaced
in the organizer UI, which it is.

---

## 5. What each observer sees

**Relay operator:**
- Public tier in full: the `31923` event, `31600` config (including
  `E_inbox.pubkey`, `coordinator` pubkey, relay/blossom lists), `31601` invite
  hashes, kind-0 profiles, public RSVPs, event updates (`30023`), and any public
  kind-1/3/6 the app publishes.
- Ciphertext + metadata for everything else: sizes, timing, counts, and author
  pubkeys of addressable encrypted events. Gift-wrap authors are one-time keys,
  so wrap authors don't identify senders — but **the `p`-tag on inbound wraps is
  `E_inbox.pubkey`**, marking "someone submitted to this event" (not who).
- **Approximate attendee count** leaks: the number of `31603` directory entries
  under the coordinator/`E_id` pubkey is countable. (Documented, accepted.)
- Blinded `d`-tags hide *which* attendee an entry belongs to from the public.

**Non-attendee (has the event link, not approved):**
- Everything the relay sees, plus can send a join request. Cannot read the
  directory, roster, matches, or any submission. Cannot enumerate valid invite
  codes (only hashes are public).

**Ex-attendee / removed member:**
- Retains every ECK version they were ever granted → can still decrypt any
  directory/roster/matrix ciphertext published while those versions were current,
  and anything they cached. New content under the rotated ECK is opaque to them.
- Their own past match list stays readable to them.
- **No forward secrecy and no real "kick":** removal degrades their access to
  *future* content only.

**Coordinator:**
- Reads **everything event-encrypted**: all submissions, all media (it fetches
  and AES-decrypts the blobs to transcribe them), all profiles, the full roster
  and directory, and all match reasoning (it writes it). It sees plaintext names,
  bios, videos, and derived AI profiles. It cannot read user-private `30078`
  (favorites/notes) and cannot sign as the event.

**LLM / STT provider:**
- Sees plaintext transcripts and profile/summary text. Mitigation is policy, not
  crypto: Venice private/TEE tiers (`require_private`) or operator-chosen Routstr
  nodes. Note the reference deployment (spec §16.4) runs the *match* model on a
  **non-private** tier for cost — so at cypherpunk.today, pairwise profile text
  is sent to a non-TEE model. That's a deliberate, logged trade-off but worth
  restating: match-quality won over match-privacy there.

---

## 6. Concrete findings & footguns

**F1 — Coordinator stores `E_inbox` nsec and all ECKs in plaintext on disk.**
**FIXED 2026-07-15.** `store/db.ts` now encrypts the `events.inbox_nsec` and
`eck_json` columns with NIP-44 self-encryption under the coordinator's identity
key (the audited primitive via the protocol package's `selfEncrypt`/`selfDecrypt`
— no bespoke crypto) before they touch SQLite; encrypted values carry a `nip44:`
prefix, so detection is unambiguous. All write paths encrypt and all read paths
transparently decrypt. On startup, a one-way, idempotent, logged migration
re-encrypts any legacy plaintext rows in place. Residual truth: whoever holds
*both* the DB file and the coordinator identity key (env/ncryptsec passphrase)
can still read everything — the DB volume alone is no longer sufficient.
Original finding: anyone who read the coordinator's SQLite file (backup, disk
seizure, container escape, filesystem access) got read access to every hosted
event's inbox and content keys.

**F2 — Coordinator does not authenticate the `21603` install grant against
`E_id`.** **FIXED 2026-07-15.** The client (`organizer.ts` `attachCoordinator`)
now seals the `21603` grant with `E_id` (it previously sealed with the
organizer's personal key), and the coordinator (`handleCoordinatorWrap`) rejects
— with a log line — any install grant whose seal author (`rumor.pubkey`) does not
equal the pubkey inside the grant's coordinate: the exact `seal-author == E_id`
check `21604` admin commands already had. Spec §7.2 now states this for 21603.
While fixing this, a deeper hole was found and closed: the protocol package's
`unwrapRumor` delegated to nostr-tools `unwrapEvent`, which never binds
`rumor.pubkey` to the seal author — so a forger could seal with their *own* key
and claim `E_id` inside the rumor, defeating both the 21603 and the existing
21604 check (this review's earlier claim that the 21604 check was "authentic"
was wrong). `unwrapRumor` now enforces `rumor.pubkey == seal.pubkey` (the seal
author being authenticated by the NIP-44 ECDH decryption itself), mirroring the
app's `signerUnwrap`.
Note: grants sent by pre-fix clients (sealed by the organizer's personal key)
are rejected by a fixed coordinator — acceptable pre-release. Original finding:
`installEvent` derived `eidPubkey` from the *coordinate inside the grant*, never
checking the seal author, so the coordinator would "install" and serve an event
(on relays the sender chose) for any well-formed grant.

**F3 — Invite `nsec` in the URL fragment.** **FIXED 2026-07-15** (the
history-lingering part). `Join.svelte` now consumes the code into memory and
immediately strips `?code=` from the URL and history via
`history.replaceState` — mirroring the login-`nsec` handling in
`consumeNsecFromHash` — and clears it from the in-memory route so back-navigation
cannot rebuild a URL carrying it. A reload mid-join degrades gracefully to the
normal join screen. What remains (inherent to link-based invites): the code is a
full nsec riding `…/join?code=<invite-nsec>` in the fragment, so clipboard,
chat-app link previews, "share sheet", and shoulder-surfing still expose it in
transit. Because the proof is pubkey-bound, a leaked code can't be replayed
against a *different* attendee — but it *can* be used first by anyone who sees
it (first-come single-use), stealing the slot.

**F4 — Local user keys are stored as raw bytes in IndexedDB.** `signer/keystore.ts`
puts the 32-byte secret key unencrypted in IndexedDB (`nostrautica`/`keystore`).
This matches spec §14 ("IndexedDB, not localStorage strings") and is the normal
web-crypto-at-rest trade-off (no passphrase for normies by design), but it means
any XSS or same-origin compromise reads the nsec. The CSP (no external scripts,
no `unsafe-eval`, no `{@html}` on untrusted content) is the real mitigation here
and looks reasonable (spec §16.3). Worth stating plainly: **a normie's key is
recoverable from their browser profile.**

**F5 — No scoped admin roles.** (§4.) `21605` grants full custody including
`E_id`. A co-organizer can impersonate the event and add/revoke at will. Fine if
co-organizers are fully trusted; a footgun if "admin" is handed out casually.

**F6 — Media-blob hash linkage across events.** Reusing an intro reuses the
identical ciphertext (same AES key/IV → same `sha256`), publicly linking a
pubkey's presence across events. The "fresh copy" option re-keys it. Documented,
accepted, and the default is the linkable one — users must opt into privacy.

**F7 — Revocation relies on NIP-09 + relay cooperation.** Directory-entry
deletion is best-effort; relays may retain the event, and the removed member
already holds the plaintext/keys. "Delete" is cosmetic, not a security boundary.

**F8 — First-come invite single-use is eventually-consistent.** The coordinator
claims invites in its own SQLite (`InviteChecker`), so a wiped DB or a race can
let a code appear reusable; the failure mode is benign (falls back to manual
queue), as the spec states. Not a vulnerability, just a caveat.

**Things that are correct and worth crediting:** two-key `E_id`/`E_inbox` split;
pubkey-bound invite proofs; hash-hidden invite lists; NIP-44 everywhere with no
NIP-04; per-blob fresh AES keys; admin-command authentication against `E_id`;
directional match encryption so organizers can't read pairwise reasoning by
default; blinded `d`-tags hiding per-attendee attendance from the public;
self-encrypted user-private tier the coordinator genuinely can't read.

---

## 7. Recommendations

Ordered roughly by value:

1. ~~**Encrypt the coordinator's event-key columns at rest** (F1).~~ **Done
   2026-07-15**: `inbox_nsec` and `eck_json` are NIP-44-encrypted under the
   coordinator identity key, with a transparent startup migration for existing
   plaintext rows.
2. ~~**Authenticate `21603` install grants against `E_id`** (F2).~~ **Done
   2026-07-15**: 21603 is sealed by `E_id` client-side and the coordinator
   enforces `seal-author == E_id`, same as `21604`.
3. ~~**Strip the invite `code` from the URL/history after reading it** (F3).~~
   **Done 2026-07-15**: stripped on consume in `Join.svelte`, mirroring
   `consumeNsecFromHash`.
4. **Reconcile spec §6.5 route shape** (`#/join?event=…&code=…`) with the
   implemented `#/e/:naddr/join?code=…` so the doc and code agree.
5. **Ship scoped admin roles** (F5) — an approve-only delegate that gets the ECK
   (to publish directory/roster) and `E_inbox` (to read the queue) but *not*
   `E_id`. The protocol already separates these keys; only the grant payload and
   client role-handling need the split.
6. **Surface the liveness truth of invite links in the UI** (§3): an invite link
   only auto-admits when a coordinator is running; otherwise it's a fast-track to
   the manual queue. Organizers shouldn't distribute "instant" links for an
   event with no coordinator attached.
7. **Restate the match-privacy trade-off at the deployment level** (§5): running
   the match model on a non-private tier (as cypherpunk.today does) means profile
   text reaches a non-TEE provider. Make that visible where organizers pick a
   coordinator.
8. **Consider key rotation for long-lived events** — the current model rotates
   the ECK only on revocation. For a multi-day event where laptops get lost,
   periodic rotation would bound the damage of a leaked ECK to one window. Lower
   priority given the bounded-sensitivity framing.

None of these change the fundamental posture, which is correctly stated in the
threat model: **the coordinator and any co-organizer are fully trusted, the
crypto protects everyone else, and past ciphertext is forever for past
key-holders.** The fixes above tighten the parts of the implementation that are
looser than the spec's own promises.
