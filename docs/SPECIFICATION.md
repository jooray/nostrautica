# Nostrautica — Specification

A Nostr-native event organizer built around networking, not just attendance. Attendees record short intro videos and optional pre-recorded talks; an AI coordinator transcribes them, enriches them with each person's existing Nostr content, and tells every attendee **who they should meet and why** — scoring pairs on similarity *and* complementarity of skills, with plain-language reasoning.

See `ELEVATOR-PITCH-en.md` / `ELEVATOR-PITCH-sk.md` for the product pitch. This document is the technical specification. The complete implemented custom-kind contract is in [PROTOCOL-REGISTRY.md](PROTOCOL-REGISTRY.md); `IMPLEMENTATION_PLAN.md` is historical planning material, not normative behavior.

All protocol facts referenced here (NIP text, Blossom BUDs, Venice.ai endpoints, Routstr RIPs, nsite/NIP-5A gateway behavior, library versions) were verified against primary sources in July 2026. Volatile facts an implementer must re-verify at build time are collected in §15.

---

## 1. Vision & product overview

Conferences put interesting people in one room and then fail to connect them. Nostrautica treats networking as the main event:

- Organizers create an event; attendees join (manual approval or invite link, Cashu tickets later).
- Each attendee records a **short intro video** (length limit configurable per event) and optionally submits a **pre-recorded talk** about what they're working on — recorded in-browser, uploaded as a file, or provided as an unlisted **YouTube / direct-`.mp4` URL** for talks too large for Blossom. Intro and talk playback has a **speed control** (1×/1.5×/2×). Talks are only transcribed and used for matching when the speaker opts in.
- One supported event format has **no live stage talks at all**: talks are watched ahead of time and the venue is used for the conversations the matchmaking points people toward.
- A coordinator service transcribes videos/talks, summarizes each attendee's existing public Nostr activity, builds an AI profile per attendee, and scores pairs on similarity **and** complementarity (cryptographer + programmer + designer at a cypherpunk event; drummer + bassist + singer at a music gathering). Below the configured prefilter threshold it scores every pair; above it, it scores selected high-similarity candidates plus a random low-similarity sample. Every match carries reasoning text, not just a score.
- Attendees see a ranked "people to meet" list, see who they already follow on Nostr, and can read anyone's recent public posts, rendered nicely.
- Match lists recompute as new people join.

## 2. Principles

1. **Nostr-native.** Event business records and encrypted content are relay-backed; media lives on Blossom servers. Some operational and cryptographic state is intentionally local: browser/coordinator MLS state, payment journals, queues/outboxes, watch progress, decrypted caches, and each device's own chat identity key — chat identity is per-device and is never backed up to relays or restored onto another device (§5.3). The public parts interoperate with the wider Nostr ecosystem (NIP-52 calendar events, kind-0 profiles, kind-3 follows).
2. **Static-only frontend.** The PWA is pure static HTML+JS+CSS talking only to relays and Blossom servers. No app server, no API backend. Soft requirement: deployable as an **nsite** (NIP-5A — the site itself hosted on Nostr/Blossom), and on any dumb static host.
3. **Minimal, honest trusted backend.** Exactly one optional server-side component — the **coordinator** — and it is a headless Nostr client, not an HTTP backend. The PWA never talks to it directly. Its trust envelope is stated explicitly (§4.2).
4. **Transparent for normies, native for Nostr users.** No crypto jargon required to register; but registering *creates a real Nostr identity* the user can carry into Primal/Amethyst/Damus/Yakihonne (§5.4).
5. **Free and open source.**

## 3. Personas & journeys

- **Normie attendee.** Clicks an event link → enters display name → records intro → gets approved → sees who to meet. Under the hood a Nostr keypair was generated; when they set a name/photo/bio a kind-0 profile was published; when they tapped "follow" on people they met, real kind-3 follow events were published. At the end the app tells them: *"You have a Nostr profile now — paste your key into any of these apps and you'll already see posts from the people you met."*
- **Nostr-native attendee.** Logs in with a NIP-07 extension or Amber via NIP-46. Their existing profile pre-fills registration; their existing posts/boosts improve their matchmaking; their intro video from a previous event can be reused with two clicks and no re-upload.
- **Organizer.** Creates the event (public NIP-52 event + app config), distributes invite links and/or reviews the join queue, attaches a coordinator, watches the roster fill in, optionally projects the event-wide match board.
- **Coordinator operator.** Runs the coordinator daemon (their own or the organizer's infrastructure), funds it with a Venice.ai API key or, optionally, Cashu tokens for an experimental Routstr provider, and otherwise never touches per-event data manually.

## 4. System architecture

```
┌─────────────┐   Nostr events    ┌──────────────┐   Nostr events   ┌──────────────────┐
│  PWA (static │ ◄───────────────► │ Nostr relays │ ◄──────────────► │ Coordinator      │
│  SvelteKit)  │                   └──────────────┘                  │ (Node daemon)    │
│              │   encrypted blobs ┌──────────────┐  encrypted blobs │  ffmpeg → STT    │
│              │ ◄───────────────► │ Blossom      │ ◄──────────────► │  → LLM profile   │
└─────────────┘                   │ servers      │                  │  → matching      │
                                  └──────────────┘                  └───────┬──────────┘
                                                                            │ HTTPS
                                                                    ┌───────▼──────────┐
                                                                    │ LLM/STT provider │
                                                                    │ Venice.ai        │
                                                                    │ Routstr (Cashu)  │
                                                                    └──────────────────┘
```

- The PWA and the coordinator communicate **only through relays** (encrypted Nostr events). There is no HTTP surface between them.
- The coordinator is optional per event: without one, the organizer's own client performs approvals and directory publishing (no AI features).

### 4.1 Privacy tiers

| Tier | Contents | Mechanism |
|---|---|---|
| **Public** | NIP-52 event, event config, kind-0 profiles, posts, optional public RSVPs | Plain Nostr events |
| **Event-encrypted** | Intro videos, talks, submitted profiles, attendee directory, roster, match matrix (opt-in) | NIP-44 to event inbox key (inbound); symmetric Event Content Key (outbound); AES-GCM blobs on Blossom |
| **Pair-encrypted** | Match lists with reasoning (default) | NIP-44 coordinator → recipient |
| **User-private** | Favorites, want-to-meet tags, notes, settings, reusable intro library | NIP-44 self-encryption (kind 30078 / 31602) |

### 4.2 Trust model (read this)

- **Relays** see only ciphertext for everything above the public tier, plus metadata (event counts, timing, sizes, pubkeys of gift-wrap recipients are hidden by NIP-59 one-time keys, but `E_inbox`'s p-tag is visible on inbound wraps).
- **Blossom servers** see random bytes (AES-GCM ciphertext) and blob sizes/hashes.
- **The coordinator can read all event-encrypted content.** This is necessary — it transcribes the videos. It is organizer-chosen infrastructure and must be presented as such in the UI ("this event's AI matchmaking is operated by `<npub>`"). It **cannot impersonate the event** (it never holds the event's signing key) or alter public event/config/invite records, but once attached it holds `E_inbox` and ECK custody, issues delegated grants in authorized flows, publishes directory/roster/match/talk/status records, and administers Marmot chat.
- **The LLM/STT provider sees plaintext transcripts and summaries.** Mitigations: prefer Venice.ai models flagged private/TEE (§9.4), or an operator-chosen Routstr node (experimental).
- **Revocation is forward-only.** Anyone who ever held a decryption key can decrypt content that was published while that key was current, forever. Key rotation protects *future* content only (§6.3). For conference intro videos and match lists — data of bounded sensitivity and time-bounded relevance — this is an accepted trade-off, and it must be stated in the UI where organizers configure events.

## 5. Identity & keys

### 5.1 Login ladder

1. **NIP-07 browser extension** — if `window.nostr` exists, one-click login. Use `getPublicKey()` + `signEvent()`; use extension `nip44` when present.
2. **NIP-46 remote signer (Amber etc.)** — client-initiated `nostrconnect://` QR / deep link with `relay` + random `secret` + `perms`; verify the signer's `connect` response `result == secret`; then **always call `get_public_key`** — the remote-signer pubkey and the user pubkey are distinct (Amber v6 uses per-connection signer keys). RPC transport is kind 24133 with NIP-44 encryption. Also accept pasted `bunker://` URIs.
3. **Generated local key (normie default).** A secp256k1 keypair generated on first use, stored in IndexedDB. No jargon shown; the word "password" is not required to start.

NIP-04 is banned project-wide (deprecated, `final unrecommended`). All NIP-44 calls in NDK must pass the scheme explicitly (`signer.encrypt(user, value, 'nip44')`) — NDK's NIP-07 signer defaults to nip04 otherwise.

### 5.2 Key backup (local-key users)

- **Backup card** shown after registration and nagging gently until completed, offering:
  - **Email-to-self**: a `mailto:` link with subject "Your Nostrautica key" and a body containing the app URL with the key in the **URL fragment**: `https://<app>/#/login?nsec=<nsec>`. Fragments never reach a server, and the app consumes and strips the parameter from history immediately on open. The UI must state plainly: *email is not confidential transport; this is a convenience trade-off against losing access.*
  - **NIP-49 export**: password-encrypted `ncryptsec` (scrypt + XChaCha20-Poly1305) as file download / copyable string.
  - Raw nsec copy (with a warning), for pasting into other Nostr clients (§5.4).
- Login accepts: `#/login?nsec=` links, pasted nsec, pasted ncryptsec + password, NIP-07, NIP-46.

### 5.3 Multi-device / recovery

Local-key users get multi-device by opening their emailed link or importing the nsec. Relay-backed self-encrypted records can be recovered with the key, but local operational state such as caches, queues, and MLS state is not universally reconstructible.

Chat identity is a separate, per-device concern, and this is true for **every** account type — local key, NIP-07, and NIP-46 alike. The first time a browser/device opens event chat it mints its own chat device keypair and attests it to the account with a signed proof of possession (kind 21607, §7.2), carrying a user-editable device label; an account may hold up to 5 concurrent chat device keys per event. There is **no relay backup of a chat device key and no cross-device restore of chat identity** — a lost or logged-out device is handled by revoking its chat key from another still-logged-in device, not by recovering it. Each device gets its own MLS leaf and sees group history only from its own join epoch forward, regardless of account type; this is inherent to MLS (history never syncs, by design), not a Nostrautica limitation, and the device-add UI states it plainly so it reads as design, not data loss.

### 5.4 Nostr onboarding path (registration IS Nostr onboarding)

For users who arrived without Nostr, every profile-ish action publishes real, standard Nostr events, so that by the end of the event they own a working Nostr identity:

1. **Profile creation.** When the user sets display name / picture / description: **first fetch any existing kind 0** for this pubkey from a broad relay set (the key may be imported, or created earlier). Merge: update only fields the user edited, preserve all unknown JSON fields. Then publish kind 0. Never blind-overwrite. Profile pictures upload to Blossom (public, unencrypted) and go into `picture`.

   **Kind-0 write policy (implemented).** The client publishes/edits kind 0 **only for a key it generated itself** (the normie path where we are certain the user is brand-new). At join time: a user we just created a key for enters name + bio (labelled *public*) which we publish as their kind 0; an **existing Nostr user** (NIP-07 / NIP-46 / imported / returning local key) has their name + bio **fetched read-only from kind 0 and shown with a loading indicator** — we never modify their kind 0. Event-specific fields (skills, "looking for") live only in the encrypted submission, never in kind 0.
2. **Relay list.** Publish kind 10002 (NIP-65) with sensible defaults so other clients find the user and the user finds content: `wss://relay.primal.net`, `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band` (read). Skip if the user already has a kind 10002.
3. **Follows.** The "Follow" button on attendee profiles publishes a **kind-3 update**. **Always fetch the current kind 3 first and append** — publishing kind 3 without merging silently wipes the user's existing follow list (the classic Nostr data-loss footgun). Dedupe by pubkey; keep existing relay/petname fields of untouched entries. **Empty-list guard:** if the fetched follow list has zero `p` tags (relays unreachable, or an existing user whose list simply didn't come back), the follow action **fails** with a retryable error rather than publishing — a kind 3 containing only the new target is indistinguishable from a wiped list downstream. To keep this guard from blocking brand-new users, **every key the app generates with an event in context is seeded with a kind 3 containing the event's `E_id` pubkey** (join flow: the event being joined; create flow: the organizer's own event) — so generated identities always have a non-empty follow list, and following the event is an honest default. Keys generated on the plain login screen (no event context) get seeded on their first join.
4. **The hand-off moment.** A "Your Nostr profile is ready" screen (end of onboarding + always in `#/me`): explains they own a portable identity, shows their npub, offers the nsec/ncryptsec, and links to Primal, Damus, Amethyst, Yakihonne. Message: *paste your key into any of these and you'll instantly see posts from the people you followed at this event.*

## 6. Encryption & key model

### 6.1 Event keypairs — two, with different jobs

| Key | Signs | Encryption target | Held by |
|---|---|---|---|
| **`E_id`** (event identity) | 31923 event, 31600 config, 31601 invite lists; has a kind-0 profile (event name/logo) | never | Organizer only |
| **`E_inbox`** (event inbox) | nothing, ever | all inbound attendee submissions | Organizer + coordinator |

The event's canonical identifier everywhere is the NIP-52 coordinate **`31923:<E_id-pubkey>:<d>`**.

Why two: attendees must be able to encrypt *before approval* to a stable key that the coordinator can read — but the coordinator must not be able to impersonate the event. Splitting identity from inbox achieves both. NIP-44's conversation key requires only the recipient's *pubkey* plus the sender's privkey, so unapproved attendees can encrypt to `E_inbox.pubkey` with zero interaction.

Both nsecs are backed up by the organizer's client as a NIP-44 self-encrypted kind 30078 entry, and shared with co-organizers via NIP-59 gift wrap.

### 6.2 Media encryption & the reuse mechanism

Every media blob (intro video, talk, any attachment) is encrypted client-side with a fresh **AES-256-GCM** key (32 bytes, 12-byte IV, single-shot) before upload. Blossom servers store ciphertext addressed by ciphertext sha256.

The key never appears as its own event; it travels inside encrypted payloads as a **media descriptor** (field names follow NIP-17 kind-15 conventions):

```json
{
  "kind": "intro",
  "url": ["https://blossom.example/<sha256>.bin", "https://mirror.example/<sha256>.bin"],
  "x": "<sha256 of ciphertext>",
  "ox": "<sha256 of plaintext>",
  "size": 12345678,
  "m": "video/webm",
  "duration": 87,
  "encryption-algorithm": "aes-gcm",
  "decryption-key": "<base64 32B>",
  "decryption-nonce": "<base64 12B>"
}
```

Each descriptor exists in two wraps:

1. **Self-wrap** — inside the attendee's NIP-44-self-encrypted intro library (kind 31602). **This is the cross-event reuse mechanism:** to use the same intro at another event, the client re-encrypts *only the descriptor* to that event's `E_inbox.pubkey`. The blob is untouched (optionally BUD-04-mirrored onto the new event's Blossom servers).
2. **Event-wrap** — inside the profile submission (§7, kind 21601) encrypted to `E_inbox.pubkey`.

Privacy note: reusing the identical blob means the ciphertext hash publicly links a pubkey's presence across events. Acceptable default; the UI offers a **"fresh copy"** option (re-encrypt with a new key/IV → new hash) for users who care.

**Text intros.** Not every intro is a recording: a profile submission also accepts a plain-text intro (`intro_text`, capped at 2000 characters) as a first-class alternative for attendees who can't or won't record — no blob, no descriptor, and it feeds the coordinator's pipeline exactly as a transcript would. The published directory entry echoes it back (`intro_text`) so there's something to show when there's no video to play. The reuse library (§7.3 kind 31602) carries its own list of authored text intros (`intro_texts`) alongside the reusable media descriptors, so a text intro reuses across events the same way a recorded one does.

### 6.3 Event Content Key (ECK) — the outbound layer

- **ECK** = 32 random bytes generated by the organizer at event creation; versioned (`1, 2, …`).
- "Encrypted under ECK" = the NIP-44 v2 construction (ChaCha20 + HMAC-SHA256, padded) using the ECK directly as the conversation key. Audited primitives, no bespoke crypto; the protocol package exposes `eckEncrypt/eckDecrypt` wrapping nostr-tools' nip44 internals.
- **Grant:** on approval, the attendee receives (via NIP-59 gift wrap, §7 kind 21602) the current ECK plus any prior versions still needed. **Attendees never receive `E_id` or `E_inbox` nsecs.**
- **Flow:** submissions come in encrypted to `E_inbox`; the coordinator (or organizer's client if no coordinator) decrypts and republishes each attendee as a **directory entry** encrypted under ECK. Every approved attendee decrypts the whole directory with one key. Only small key wraps are ever re-encrypted; blobs never move.
- **Rotation/revocation:** removing an attendee = generate ECK v(n+1), gift-wrap it to all remaining attendees, encrypt all *future* directory/match/roster content under it. Old ciphertexts remain readable to old key-holders (see §4.2). The removed attendee's directory entry is deleted (NIP-09) and their entry dropped from the roster.

### 6.4 Match privacy

Pairwise reasoning ("you should meet her because your startup lacks exactly her skill") is the most sensitive derived data in the system, so:

- **Default `match_visibility: "pair"`** — the coordinator publishes one **match list per attendee** (kind 31605), NIP-44-encrypted coordinator→attendee. On the wire a pair's score/reasoning is readable only by its two members (each via their own list) — not other attendees, not the organizer, not the public. N events, not N². The coordinator itself is the exception: it *computes* the reasoning, so it necessarily knows it (as it does all event-tier content). "Visible only to the pair" is about who can read it off the relays, never a claim that it is hidden from the coordinator that generated it.
- **Reasoning is directional.** Pair scoring emits two reasonings — one addressed to each member ("why *you* should meet them", grounded in that recipient's own goals) — stored per-direction; each attendee's list surfaces the reasoning written *for them*. It answers "why should I meet him/her?" from the reader's perspective, not a symmetric blurb. Scores (score/similarity/complementarity) are decimals in [0,1]; the coordinator defensively clamps/rescales provider output that ignores the range.
- **Opt-in `match_visibility: "event"`** — additionally a full score matrix (kind 31606) under ECK, for facilitated events that project a "best matches" board.

### 6.5 Invite codes

An invite code **is an nsec** (the *invite key*):

- The organizer generates N invite keypairs and publishes kind 31601 (signed by `E_id`) containing **`sha256(invite-pubkey)`** per code — hashes, so observers can't enumerate valid codes or front-run them.
- Invite link: `https://<app>/#/join?event=<naddr>&code=<invite-nsec>` — the code rides the URL **fragment**, never sent to any server (also nsite-compatible: there is no server).
- The attendee's join request carries proof: `["invite", <invite-pubkey-hex>, <schnorr-sig-hex>]`, where the signature is a BIP-340 signature by the invite key over a domain-separated, injectively-encoded challenge:
  ```
  challenge = sha256(utf8(JSON.stringify(["nostrautica-invite-v2", <event-coordinate>, <attendee-pubkey-hex>])))
  ```
  The literal first array element is a domain-separation tag, and JSON-array encoding is injective (no colon-joined string that a crafted pubkey/coordinate could re-segment ambiguously). This **binds the code to the attendee's pubkey** — intercepting the proof doesn't let anyone else use it.
- **Stateless verification** (organizer client and coordinator both, no shared DB): `sha256(invite-pubkey) ∈ 31601` ∧ signature valid.
- **Single-use, first-processed-wins:** each verifier — the coordinator, or the organizer's client when there is no coordinator — claims an invite pubkey against the first join request it processes and records usage locally; later uses of the same code fall back to the manual queue. This is deliberately eventually consistent, not atomic: organizer-client and coordinator claim state are not shared, so two verifiers could each accept the same code from requests that reach them in different orders. The failure mode is benign — an extra attendee lands in manual review rather than being silently rejected — and is documented as the design, not a bug to be papered over.
- **Cashu later:** the same slot takes a `["payment", ...]` proof tag; the coordinator redeems the token and auto-grants. Approvals are implemented as **pluggable entitlement checkers** so ticketing bolts on without protocol changes (§12).

### 6.6 Blinded d-tags

Wherever a per-attendee addressable event would otherwise leak attendance publicly, the `d` tag is blinded:

```
d = hex( hmac_sha256(key, "<event-coordinate>|<attendee-pubkey>") )[0..32]
```

with `key` = the attendee's NIP-44 self-conversation-key for self-stores (31602), or the current ECK for coordinator-published entries (31603, 31605). Deterministic for everyone entitled to compute it; opaque to the public. Event-scoped (non-per-attendee) events reuse the 31923 `d`.

Known metadata leak (accepted, documented): the *count* of directory entries per coordinator pubkey is observable, i.e. approximate attendee counts.

## 7. Protocol: kinds & schemas

This section keeps the product-level narrative — what each kind is for and who signs it. Full field-level schemas, signer/authority rules, and lifecycle detail are normative in PROTOCOL-NIP.md and [PROTOCOL-REGISTRY.md](PROTOCOL-REGISTRY.md); treat the JSON shown below as illustrative, not exhaustive.

Reused standard kinds: **0** profile, **1** notes, **3** follows, **5** deletions (NIP-09), **6** reposts, **13** seals, **10000** mute list, **10002** relay list, **10050** DM relay list, **10063** Blossom server list, **24242** Blossom authorization, **1059** gift wrap (NIP-59), **30078** app data (NIP-78), **31923/31924/31925** NIP-52 event/calendar/RSVP, and Marmot's **30443/443/444/445** for group chat (§7.5).

Custom kinds span addressable kinds **31600–31611** and gift-wrap **rumor kinds 21600–21610**. Rumor kinds sit in the ephemeral range deliberately: rumors are never published directly, and if one ever leaks as a signed event through a client bug, relays won't store it. Every payload is versioned: public events carry `["v","2"]`; encrypted JSON payloads carry `"v": 2`. Parsers reject any other version outright, and a client that observes a newer version from a key it trusts (an event's `E_id`, or its configured coordinator) surfaces an "update the app" prompt rather than guessing at an unknown shape.

**Ordering.** For any two events sharing (kind, author, `d`), the higher `created_at` wins; a tie is broken by the lexicographically lowest event id. Every replaceable-event publisher — coordinator and app alike — sets `created_at` to at least one second past its own previous publish for that address, so same-second collisions between successive updates can't happen. Sender-mutable submissions (profile submissions, corrections, talks) additionally carry an explicit application revision (`rev`, or `revision` for talks) that the client bumps on every edit; the coordinator orders by `(rev, created_at, id)`, never by the sender's timestamp alone, so an out-of-order or replayed older edit can never regress what's published.

Gift-wrap mechanics per NIP-59: rumor (unsigned) → seal kind 13 (NIP-44, signed by true author, empty tags) → wrap kind 1059 (random one-time key, single `p` tag = recipient, `created_at` randomized up to 2 days in the past). Consumers must query with `since = now − 3 days` overlap and dedupe by rumor id.

### 7.1 Public events (author `E_id`)

**kind 31923 — the event itself (NIP-52)** — `d`, `title`, `start`/`end` (unix), `start_tzid`, `summary`, `image`, `location`(s), `g` geohash, `t` hashtags, `p` participants with roles, plus current NIP-52 uppercase **`D` day-index tags**: one `["D", "<decimal day index>"]` tag — `String(Math.floor(unixSeconds / 86400))`, e.g. `"82549"` — for each UTC calendar day the event's `start`..`end` range spans (`end` is exclusive: an event ending exactly at midnight does not emit a tag for the new day), so date-indexed calendar clients can discover the event on every day it runs. Editing `start`/`end` rebuilds the full `D` set. The count is bounded at `MAX_DAY_TAGS = 60` days; an event with no `end` (or an `end` before `start`) emits the single start-day tag. Interoperates with Flockstr/Meetstr/any NIP-52 client. Optionally referenced from a kind 31924 calendar.

**kind 31600 — Event Networking Config**
```
tags:
  ["d", <event-d>]                     // same d as the 31923
  ["a", "31923:<E_id-pubkey>:<d>"]
  ["v", "2"]
  ["inbox", <E_inbox-pubkey-hex>]
  ["coordinator", <coordinator-pubkey-hex>, <gen>]  // absent = no coordinator; gen = install generation (§9)
  ["relay", <wss-url>] …                         // event home relays
  ["blossom", <https-url>] …                     // event Blossom servers
  ["max_video_sec", "90"]
  ["max_talk_sec", "900"]
  ["matching", "on" | "off"]
  ["match_visibility", "pair" | "event"]
  ["approval", "manual" | "invite" | "manual+invite"]
  ["eck", "1"]                                   // current ECK version number
  ["nostr_context", "100"]                       // N public events per attendee to summarize; "0" = off
  ["lang", "sk"]                                  // event language, ISO 639-1; ABSENT = "en" (default, tag omitted)
  ["retention", "90"]                             // optional: days after event end the coordinator keeps member records
  ["talks", "on" | "prerecord-first"]             // optional; ABSENT = "off" (no prerecorded-talks journey)
content: ""   (reserved for future JSON extension)
```
The `lang` tag sets the event's language (ISO 639-1). It drives the attendee UI
default (the PWA adopts it for the session unless the user has an explicit Settings
choice) and the language of all coordinator AI output — match reasoning and profile
summaries are written in it regardless of what language attendees speak or record
in. `"en"` is the implicit default, so the tag is omitted for English events
(an absent tag parses as `"en"`).

The `coordinator` tag's third element, `gen`, is the install generation: a positive
integer the organizer increases on every attach/detach/re-attach of a coordinator to
this event, persisted alongside the event's key backup (§6.1). It lets a coordinator
refuse a replayed historical install grant and lets every reader agree on which
coordinator is currently authoritative for this event (§9).

The optional `retention` tag (positive integer, days) tells the coordinator to delete
this event's member records (directory, roster, match lists, talks) via NIP-09 and
stop processing that many days after the event's end time; an absent tag means
indefinite retention. Clients surface the declared retention at join time. Deletion
stays best-effort — relays may not honor a NIP-09 request — so the UI must not
overpromise it as guaranteed erasure.

The optional `talks` tag turns on the prerecorded-talks journey: absent (equivalent
to `"off"`) means no Talks destination at all; `"on"` adds Talks alongside People;
`"prerecord-first"` is the format described in §1 — talks are watched ahead of time
and featured ahead of People, with the venue reserved for the conversations
matchmaking points people toward. Talk submissions (21609) and published talks
(31610, §7.3) are only processed/visible when this tag is not `"off"`.

**kind 30023 — Event updates (NIP-23 long-form, unmodified)** — announcements
("schedule posted", "venue change", "afterparty") authored by `E_id` and rendered
on the event page. Standard NIP-23: `d` (stable per update — republishing with
the same `d` **edits** the update; clients MUST dedupe by `d` keeping the highest
`created_at`), `title`, `summary` (optional), `published_at` (set on first
publish, preserved on edits), markdown body in `content`. Being plain NIP-23
under the event's author key, updates are also readable in any long-form Nostr
client. The event page renders updates newest-first by `published_at` falling
back to `created_at`.

**kind 31601 — Invite List**
```
tags: ["d", <event-d>], ["a", <coordinate>], ["v","2"]
content: {"v":2, "invites":[ {"h":"<sha256(invite-pubkey) hex>", "label":"vip-1"}, … ]}
```
Replaceable — organizer republishes to add/void codes (voiding = removing the hash).

### 7.2 Gift-wrapped rumors (all delivered as kind 1059 wraps)

The complete rumor registry, including 21606–21610, is maintained in [PROTOCOL-REGISTRY.md](PROTOCOL-REGISTRY.md). The entries below explain the primary flows.

**rumor kind 14 — Direct Message (NIP-17 with a deliberate relay-selection extension)**
(→ recipient pubkey, and a second wrap → the sender's own pubkey so sent messages are
recoverable on any device). Standard NIP-17 private direct messages between attendees —
plaintext in `content`, `["p", <recipient>]` tag, optional `["subject", …]`. The message
shape is unmodified NIP-17, so conversations started in Nostrautica continue seamlessly in
0xchat, Amethyst, or any other NIP-17 client — before, during, and after the event.

**Relay selection is a product extension, not unmodified NIP-17.** Rather than publishing
the recipient copy strictly to the recipient's kind-10050 DM-relay list (and declining
when none exists, as NIP-17 prescribes), the app **unions** the recipient's declared
kind-10050 relays with the app-default DM relays, and sends to the defaults alone when the
recipient has published no list. This is a deliberate reliability choice for the event
setting — an app-created attendee may not have a 10050 yet, and venue networks are flaky —
at the cost of exposing recipient metadata to relays the recipient did not choose. To keep
new attendees reachable, the app **also publishes a kind-10050** for every app-generated
account identity during onboarding (check-before-publish: it never overwrites a list the
user already has). Do not describe DMs here as "NIP-17, unmodified".

The app's DM inbox unwraps incoming 1059s and keeps only kind-14 rumors; wrap
timestamps are randomized per NIP-59 so ordering uses the rumor's `created_at`.
No event coupling: DMs are between pubkeys; the event UI is just the entry point
(Message button on an attendee's profile).

**rumor kind 21600 — Join Request** (→ `E_inbox.pubkey`)
```
tags: ["a", <coordinate>], ["invite", <invite-pubkey>, <sig-hex>]?   // absent → manual queue
content: {"v":2, "name":"…", "message":"…", "rsvp_public": false}
```
If `rsvp_public` is true the client *also* publishes a standard public kind 31925 RSVP (opt-in checkbox; default private).

**rumor kind 21601 — Profile Submission** (→ `E_inbox.pubkey`; may accompany the join request)
```
tags: ["a", <coordinate>]
content: {"v":2, "rev": <int ≥ 0>,
  "profile": {"about":"…", "skills":["…"], "looking_for":"…", "links":["…"]},
  "media": [ <media descriptor §6.2>, … ],       // intro; optionally talk
  "intro_text": "…"?                             // plain-text intro alternative (§6.2)
}
```
The client maintains `rev` monotonically per event in its own storage and bumps it on every edit. The coordinator applies a submission only when its `(rev, created_at, id)` strictly exceeds the last one it applied (§7 "Ordering") — a stale resend from a slow relay or a race between two open tabs is discarded, never applied over a newer edit.

**rumor kind 21602 — Key Grant** (→ attendee)
```
content: {"v":2, "a": <coordinate>, "role": "attendee" | "organizer",
          "eck": [ {"id":1, "key":"<base64 32B>"}, … ],
          "granted_by": <organizer-pubkey-hex>}
```
Sent by the organizer (manual approval) or the coordinator (invite auto-approval). ECK rotation = a new 21602 carrying the added version.

**rumor kind 21603 — Coordinator Grant** (→ coordinator; this is how an organizer "installs" the coordinator for an event)
```
content: {"v":2, "a": <coordinate>, "gen": <int>, "inbox_nsec":"<hex>",
          "eck":[…], "config_relays":["wss://…"]}
```
Sealed by `E_id` (like 21604): the coordinator authenticates the install by requiring the gift wrap's seal author to equal the coordinate's `E_id` pubkey, **and** requires this grant's `gen` to match the `gen` the newest fetchable 31600 currently names it at — a config that can't be fetched is retryable, never treated as authorization. A `gen` at or below any generation this coordinator has ever installed or detached for the event is rejected outright, so a replayed historical grant can never re-install (§9).

**rumor kind 21604 — Admin Command** (organizer → coordinator)
```
content: {"v":2, "a": <coordinate>, "expires": <unix>,
          "cmd": "approve" | "recompute" | "reprocess" | "revoke" | "detach", "args": { … }}
```
`approve` = grant + publish directory/roster for `args.pubkey` (manual approval routed through the coordinator so directory/roster are authored under the coordinator key); `recompute` = full match recompute (clears the pair cache so every pair is re-scored); `reprocess` = re-run pipeline for a pubkey; `revoke` = remove attendee + trigger ECK rotation; `detach` (no args) = immediately uninstall the coordinator from this event, with the same effects as a config update that stops naming it (§9). Every command carries `expires` (organizer clients default to `created_at + 172800`, 48h); the coordinator rejects an expired command outright, so a database restore or backfill can never replay an old `revoke` or `recompute`. The coordinator also keeps a per-subject watermark (the affected pubkey, or the coordinate itself for `recompute`/`detach`) and rejects a command older than the last one it applied for that subject, so approve/revoke interleavings resolve deterministically rather than by relay arrival order. Admin commands are sealed by `E_id` (the coordinator authenticates them as coming from the event authority).

**rumor kind 21605 — Organizer Grant** (→ co-organizer; spec §6.1, §13 "multi-organizer")
```
content: {"v":2, "a": <coordinate>, "eid_nsec":"<hex>", "einbox_nsec":"<hex>",
          "eck":[…], "config_relays":["wss://…"], "granted_by": <organizer-pubkey-hex>}
```
Grants a co-organizer **full key custody** — E_id + E_inbox + ECK — so they can edit the event, approve/revoke attendees, and manage the coordinator. The recipient's client stores it as an organizer key record on the normal grant-receiving scan. `granted_by` must equal the seal author (`E_id` itself — a co-organizer cannot mint another co-organizer's grant). (Scoped roles — approve-only vs full custody — remain future work, §13.)

**rumor kind 21608 — Profile Correction** (→ `E_inbox.pubkey`; attendee corrects or hides fields of their own derived profile)
```
content: {"v":2, "a": <coordinate>, "rev": <int ≥ 0>,
          "overrides": {"summary":"…", "skills":["…"], …}?,
          "hidden": false?, "hidden_fields": ["summary", …]?,
          "report": "…"? }
```
Lets an approved attendee override or hide specific fields of their own coordinator-generated `ai_profile` (summary/skills/interests/offers/seeks) — the coordinator's read of a video or talk isn't always right, and this is the fix-it path. Sealed by the attendee's own account key, so a correction can only ever apply to the sender's own entry, and carries the same `rev` ordering as a profile submission (§7 "Ordering") — an out-of-order older correction can never overwrite a newer one. The coordinator stores the correction durably and reapplies it on top of every freshly generated `ai_profile` before publishing the 31603, so it survives reprocessing; the directory entry carries an `ai_profile_edited` marker so viewers see a subtle "edited by attendee" note. **Authored profile fields — `about`, `skills`, `looking_for`, `links`, from the original submission — are never touched by a correction**; only the coordinator-derived `ai_profile` can be overridden or hidden.

**rumor kind 21609 — Talk Submission** (→ `E_inbox.pubkey`; a speaker submits or edits a prerecorded talk) — same authority and shape as a profile submission, but for a talk: title, description, co-speakers, a stable `talk_d` the speaker chooses once, and **exactly one** video source — a `kind:"talk"` **`media`** descriptor (§6.2, a recording or uploaded file) **or** an **`external_url`** (+ `external_kind:"youtube"|"video"`, see kind 31610). A `process_for_matching` boolean (default **false**) is the only thing that opts a Blossom talk into coordinator transcription + matching: talks are **not** transcribed or fed into matching by default, so `process_talk` STT runs only for opted-in Blossom talks (external talks are never fetched at all). Editing resubmits the same `talk_d` with a bumped `revision`, replacing the previous talk in place (§7 "Ordering" rejects an equal-revision resubmission whose content actually changed). Only processed when the event's `talks` config (§7.1) is not `"off"`.

**rumor kind 21610 — Attendee Withdrawal** (→ `E_inbox.pubkey`; attendee-initiated leave)
```
content: {"v":2, "a": <coordinate>, "delete_data": true}
```
Sealed by the attendee's own account key — the attendee removing themselves, without needing an organizer to act. Same effect chain as an organizer `revoke`: roster/directory/match-list removal, NIP-09 deletions, and ECK rotation. The withdrawing client also deletes its own Blossom blobs and its 31602 self-copy. Rejoining afterwards is a fresh join request, not a resurrection of the old one.

### 7.3 Encrypted addressable events

**kind 31602 — My Event Profile / intro library** (author = attendee; content NIP-44 self-encrypted; `d` blinded with self-conv-key)
Content = the 21601 content shape plus `"a": <coordinate>`. The attendee's own queryable copy (gift wraps aren't self-queryable — random one-time authors) **and** the reuse library: a special entry with `"a": null` and `d` blinded over the literal string `"library"` holds event-independent media descriptors **and** authored text intros (`intro_texts`, §6.2) for the same cross-event reuse. There is no chat-identity variant of this kind — chat device keys are never backed up (§5.3, §7.5).

**kind 31603 — Directory Entry** (author = coordinator, or organizer when no coordinator; content encrypted under ECK; `d` blinded with ECK)
```
tags: ["d", <blinded>], ["a", <coordinate>], ["eck","1"], ["v","2"]
content(ECK): {"v":2, "pubkey": <attendee-hex>,
  "profile": { … }, "media": [ <descriptors> ],
  "ai_profile": {"summary":"…", "skills":[…], "interests":[…],
                 "offers":[…], "seeks":[…]},        // appears when processing completes
  "updated_at": <unix>}
```

**kind 31604 — Roster** (author = coordinator/organizer; ECK; `d` = event-d)
```
content(ECK): {"v":2, "eck_current":1,
  "nostr_group_id":"<optional active Marmot group id>",
  "attendees":[ {"pubkey":…, "d":"<entry blinded d>", "role":"attendee",
                 "chat_keys":[ {"pubkey":"…", "label":"Chrome on laptop", "added_at":<unix>}, … ] }, … ]}
```
One small atomic index for cheap sync; entries stay per-attendee events to dodge relay event-size caps. `chat_keys` lists the per-device chat keys attested to that attendee's account (§7.5), up to 5, so clients can dedupe a member list by account and show "Alice (2 devices)". When present, `nostr_group_id` is the member-only authoritative binding from this event to its active Marmot room. Clients repair a known stale binding when they can fetch this roster and otherwise refuse to guess a room. A current cold-cache/fetch-failure edge remains; clients must not treat a missing routing ID as proof that any joined coordinator room belongs to the event.

**kind 31605 — Match List** (author = coordinator; content NIP-44 coordinator→recipient; `d` blinded with ECK)
```
tags: ["d", <blinded>], ["a", <coordinate>], ["v","2"]
content(nip44→recipient): {"v":2, "computed_at":<unix>, "matches":[
  {"pubkey": <hex>, "score":0.87, "similarity":0.60, "complementarity":0.95,
   "reasoning":"You both build on Nostr; she designs interfaces, you write cryptography — your project needs exactly that.",
   "icebreakers":["…", "…"]}, … ]}
```
`icebreakers` is optional — up to 3 short (≤ 280 char) conversation starters the coordinator derives alongside the directional reasoning (§9.3). Clients without support simply ignore the field.

**kind 31606 — Match Matrix** (only when `match_visibility:"event"`; ECK; `d` = event-d) — `{"v":2,"computed_at":…,"pairs":[{"a":<pk>,"b":<pk>,"score":…}]}` (scores only; reasoning stays pairwise).

**kind 31610 — Talk** (author = coordinator, or `E_id` when there's no coordinator; content encrypted under ECK; `d` blinded per speaker + talk)
```
tags: ["d", <blinded>], ["a", <coordinate>], ["eck", <version>], ["v","2"]
content(ECK): {"v":2, "pubkey": <speaker-hex>, "talk_d": "…", "title":"…", "description":"…"?,
  "speakers": [<hex>, …],
  "media": <descriptor, kind:"talk">?,          // Blossom recording/upload
  "external_url": "https://…"?, "external_kind": "youtube" | "video"?,  // OR external
  "source_type": "recording" | "upload" | "external"?,
  "transcript": { … }?, "lang":"…", "revision": <int>,
  "status": "pending" | "published" | "rejected", "published_at": <unix>}
```
The published, moderated form of a talk submission (21609). The address is blinded per speaker and `talk_d` — `hmac_sha256(ECK, "talk|<coordinate>|<speaker>|<talk_d>")` (§6.6's construction, specialized) — so members can locate a specific talk without a public index leaking who submitted what. `status` supports organizer moderation before a talk is visible to attendees (`talk_publish`/`talk_reject` admin commands, §7.2); `revision` supports editing — the last published revision stays watchable until a newer one publishes. Republished after moderation, after a fresh transcript, and on ECK rotation; an address made obsolete by a new revision or a rotation may receive a NIP-09 deletion.

A talk carries **exactly one** video source: a `kind:"talk"` **`media`** descriptor (an in-browser recording or an uploaded file, encrypted + on Blossom) **or** an **`external_url`** (+ `external_kind`) — an unlisted YouTube link or a direct `.mp4` URL the speaker hosts elsewhere, for clips too large for Blossom (>~1 GB). The external URL rides inside the ECK-encrypted content, so it is members-only even though the file it points at is public; the coordinator **never fetches** an external URL (the §6.2 media-fetch SSRF allowlist is Blossom-origin-only), so external talks are view-only — never transcribed, never fed into matching. Clients play a YouTube `external_kind` via a `youtube-nocookie` embed and a `video` one via a plain `<video>`.

**kind 30078 — user-private settings** (NIP-78; NIP-44 self-encrypted content)
- `d = "nostrautica:settings"` — theme, language, relay prefs.
- `d = "nostrautica:ev:<blinded>"` — per event: `{"v":2,"favorites":[…],"want_to_meet":[…],"met":[…],"notes":{<pubkey>:"…"}}`.
- `d = "nostrautica:eventkeys:<blinded>"` (organizer) — `E_id`/`E_inbox` nsecs, ECK versions, and the last coordinator install `gen` the organizer used (§9) — backup.

### 7.4 Event page customization — theme, menu & layout, members-only posts (author `E_id`)

Three further addressable kinds complete the reserved block (31607–31609). **Everything "official" an event publishes is signed by `E_id`** — posts, menu, theme. This is deliberate:

- The **ECK must never sign anything** — it is shared with every attendee, so an ECK-signed "official post" could be forged by any of them.
- **Organizers' personal keys stay out of event publishing** — the event's voice is separate from anyone's personal account.
- `E_id` is already a per-event keypair whose nsec is held by the creator and distributed to co-organizers via the 21605 grant (§7.2) — exactly the "event account encrypted to the organizers' npubs" this feature needs, at zero new mechanism. (Consequence, accepted: co-organizers are indistinguishable from the creator and irrevocable, §7.2.)

**Visibility model — two levels, chosen per item at creation:**

- **Public** — a plain Nostr event, readable by anyone including other Nostr clients.
- **Members-only** — content encrypted under the ECK (§6.3) with **all metadata (title, summary, image) inside the ciphertext** and an opaque random `d`. There are no public teasers: a non-attendee learns only that E_id-authored events of this kind exist (count/timing metadata — same acceptance as §6.6). The canonical use case: a public post carries the schedule without full names or the precise location; a members-only post carries the full version.

**kind 30023 — public event posts** — unchanged (§7.1 "Event updates"): cleartext `title`/`summary`/`image`/`published_at` tags, markdown content, same-`d` republish = edit.

**kind 31607 — Members-only Event Post**
```
tags: ["d", <random-32-hex, chosen at creation, stable across edits>], ["v","2"], ["eck", <version>]
content(ECK): {"v":2, "title":"…", "summary":"…"?, "image":"…"?,
               "published_at":<unix>, "author":<organizer-pubkey-hex>?,
               "content":"<markdown>"}
```
- No `a` tag and no cleartext metadata; discovery is by query `{kinds:[31607], authors:[E_id]}` (E_id is per-event, so the author fully scopes it). The `d` is random — unlike 31603/31605 nobody needs to *derive* this address, so no blinding construction is needed.
- **Edits:** republish the same `d`; the body is re-encrypted under the ECK version current at edit time (named by the `eck` tag; readers hold all versions via their 21602 grant); `published_at` inside the ciphertext is preserved. After a revocation rotation, old posts are **not** re-encrypted (the removed attendee already read them — §4.2 revocation honesty); edits and new posts simply use the new version, so a removed attendee can locate a post they knew but cannot read anything written after their removal.
- **Size:** NIP-44 caps a single payload at 65,535 plaintext bytes — the editor enforces ≤ 60,000 bytes of markdown (also safely under relay event-size caps). Oversize = reject at the editor with a readable error; chunking is out of scope (§13 "Chunked media encryption").
- An `naddr` to a 31607 behaves like any addressable event; a client without the ECK renders a lock + join prompt in place of the content.
- Markdown (both kinds) renders through the app's escape-first renderer, extended with images, fenced code blocks, tables and nested lists — never raw HTML.
- Visibility is fixed at creation. There is no public↔members switch (a public post's revisions live on relays forever; the honest workaround is NIP-09 delete + repost, both best-effort).

**kind 31608 — Event Page (menu + layout)** (`d` = event-d)
```
tags: ["d", <event-d>], ["a", <coordinate>], ["v","2"], ["eck", <version>]?
      ["r", <target>, <label>] …          // PUBLIC menu items, in display order
content: {"v":2,
  "sections":  [ <section>, … ],          // public layout, in order
  "private":   "<ECK ciphertext of {\"v\":2,
                 \"menu\":[{\"label\":…, \"target\":…, \"pos\":<int>}, …],
                 \"sections\":[{…, \"pos\":<int>}, …]}>"   // members-only additions
}
```
- **Menu.** Public items are Nostree-shaped `r` tags (target + human label — matches the NIP-51 bookmark-set idiom, kind 30003 with labeled `r` tags, without claiming to *be* one). Members-only items live in the encrypted `private.menu`, each with a `pos` index into the merged list; members interleave them client-side, visitors render the `r` tags alone. A **target** is one of:
  - a plain `https:` URL (dinner menu, venue site, …),
  - `nostr:naddr…` → a public 30023 (naddr carries event-relay hints),
  - `nostr:naddr…` → a members-only 31607 (locks for non-members).
  The composer offers a **picker aware of the event's posts** (public and encrypted, latest-by-`d` semantics) alongside a free URL field.
- **Layout.** `sections` composes the event home below the header, in order. Section types:
  - `{"type":"posts", "source":"event"|"attendees"|"both", "visibility":"public"|"members"|"both"}` — the blog feed. `event` = E_id-authored (30023 ∪ 31607); `attendees` = public 30023 authored by roster pubkeys carrying `["a", <coordinate>]` (the standard NIP-23 way for attendees to tag their own long-form to the event); `visibility` filters plain vs ECK-encrypted. Everyone sees only what they can decrypt regardless of config.
  - `{"type":"pinned", "refs":[<naddr>, …]}` — explicitly pinned posts, rendered prominently.
  - `{"type":"attendees"}` — roster preview (renders only for members).
  - Members-only sections go in `private.sections` with `pos`, merged like menu items.
  - No 31608 published → the default layout (the pre-customization event home).

**kind 31609 — Event Theme** (`d` = event-d)
```
tags: ["d", <event-d>], ["a", <coordinate>], ["v","2"]
content: <raw CSS, ≤ 32 KB>
```
- **Public** — branding applies to visitors too.
- Applied by injecting a single `<style data-event-theme>` element **only while a route under `#/e/<naddr>` is active**, removed on leaving the event; never active on login, settings, key-backup or DM routes.
- Deliberately *not* stored in 31600 `content`: 31600 is rebuilt from parsed tags and republished by config flows (e.g. coordinator attach), which would silently drop a content payload.
- **Security (accepted, documented):** only `E_id` holders can set the CSS, and it applies solely inside that event's pages — where the same people already control every rendered string. Residual risks: intra-event UI spoofing by styling, and network beacons via `url(https://…)` (allowed by CSP `img-src https:`; external stylesheet `@import` is blocked by `style-src 'self' 'unsafe-inline'`). The app chrome outside the event is never themed, but some themed event routes currently reveal sensitive values, including chat handoff and admin invite material. `font-src 'self'` limits remote-font text exfiltration; it does not make themes a secret-safe rendering boundary. Treat an event theme as trusted-organizer UI control.

### 7.5 Event group chat

The only shipped group-chat backend is `marmot`, declared as a `chat` tag on the 31600 config. `GROUP-CHAT-FEASIBILITY.md` and the NIP-17 design are archived/future research, not normative current behavior. See `MULTIDEVICE-CHAT.md` for the full multi-device design and rationale; this section summarizes it.

**Status (as-built).** `marmot` is implemented and remains experimental. Current config accepts only `"marmot"`; `nip17` is not an interoperable configuration.

```
["chat", "marmot"]    // Marmot (MLS) group — implemented (experimental), requires a coordinator tag
```

Tag absent = no chat.

- **`marmot`** — one MLS group per event (Marmot protocol, kind 443/444/445 family), created and administered by the **coordinator as admin bot**: add-on-approval, remove-on-revoke (real PCS, unlike ECK rotation), and auto-add of new key packages from enrolled accounts. The coordinator is a group member and can read the chat — disclosed in UI, consistent with §4.2. A member-only roster `nostr_group_id` binds the event to its group when available; a freshly received Welcome sits in an unbound candidate state — no history replay, no display, no sending — until a verified roster confirms it, fail-closed on a roster fetch failure.
- **Chat identity is per device, for every account type.** Local-key, NIP-07, and NIP-46 accounts all follow the same rule: the first time a browser/device opens event chat it mints its own chat device keypair, held only in that device's local storage. The device attests the key to the account with a gift-wrapped **kind 21607 Chat Device Attestation** to the coordinator — sealed by the account key, carrying a BIP-340 proof of possession signed by the device key itself, plus a user-editable label ("Chrome on laptop"). An account may hold up to **5 concurrent chat device keys per event**. Each device gets its own MLS leaf and its own Welcome, and sees group history only **from its own join epoch forward** — history never syncs between devices, by design, and this is stated plainly in the device-add UI so it reads as design, not data loss.
- **No relay backup, no cross-device restore.** A chat device key is never self-encrypted to relays and cannot be restored onto another device. A lost or logged-out device is handled by revoking its chat key (another 21607, `op:"revoke"`, from any still-logged-in device, or from Settings → Chat devices), not by recovering it.
- **Roster.** The 31604 roster's `chat_keys[]` (§7.3) lists every attested device per attendee, so Nostrautica clients dedupe the member list by account ("Alice, 2 devices") and offer per-device revoke.
- **Device profiles for interop.** Each chat device key publishes its own kind 0, but only to the event's chat relay set — never to the account's general relays: `name` is the account's event display name, `about` references the owning account's npub. This lets external Marmot clients (e.g. White Noise) show a human name instead of a bare device pubkey, and group a person's devices by the referenced npub. Accepted consequence: the device→account link is public on the chat relays; the ECK-encrypted roster `chat_keys` mapping remains the authoritative binding for Nostrautica clients. Organizers/users who want no public chat-relay presence can disable device profiles for the event.
- **Non-members see nothing**: Marmot traffic is E2E-encrypted and has no application event coordinate. Relay metadata, timing, and (for those who opt in) device-profile names remain observable on the chat relays.

NIP-17 and dual-backend ideas are intentionally deferred and may change before implementation.

## 8. Flows

**Create event.** Organizer client: generate `E_id`, `E_inbox`, ECK v1 → publish kind 0 for `E_id` (event name/logo) → publish 31923 + 31600 (signed `E_id`) → self-encrypt key backup (30078, includes install `gen = 0`) → optionally generate invites (31601) → optionally attach coordinator: bump `gen` to 1, add `["coordinator", <pubkey>, 1]` to 31600, gift-wrap 21603 carrying the same `gen`.

**Join (attendee).** Open event link → login/registration ladder → fill profile, optionally record intro now → send gift-wrapped 21600 (+21601) to `E_inbox`; save self-copy 31602. With an invite code: include the invite proof → coordinator auto-approves → 21602 arrives, usually within seconds. Without: wait for manual approval.

**Approve (organizer).** Admin view lists pending 21600s (organizer holds `E_inbox` nsec and unwraps them) → approve → gift-wrap 21602 (ECK) to attendee → directory entry appears (published by coordinator, or by the organizer client when no coordinator). Reject/ignore = no grant.

**Submit / update profile & media.** Record video (≤ `max_video_sec`, enforced by recorder hard-stop) → AES-GCM encrypt → BUD-06 preflight → BUD-02 upload to first event Blossom server → BUD-04 mirror to the rest → send new 21601 → update self-copy 31602.

**Reuse intro at another event.** Pick from library (31602 `a:null` entry) → re-encrypt descriptor to new event's `E_inbox` in a fresh 21601 → optional BUD-04 mirror to the new event's servers → done; no re-upload, or choose "fresh copy" (§6.2).

**Coordinator processing.** See §9.2 pipeline. Directory entry text appears immediately on approval; `ai_profile` folds in when transcription+profiling completes; match lists appear/refresh after each new/changed attendee.

**View matches.** Attendee opens `#/e/<naddr>/matches` → fetch own 31605 (compute own blinded `d` from ECK) → decrypt → ranked list with reasoning; tap through to the person's directory entry, their recent kind-1 posts, follow button.

**Social overlay.** Fetch user's kind 3 ∩ roster pubkeys → "you already follow" badges; person view streams their recent notes (kind 1, with NIP-21 mentions, imeta images, link previews — no full thread rendering currently).

**Direct messages.** Attendee opens a person's profile → Message → NIP-17 conversation view (kind-14 rumor, sealed, double-wrapped: one 1059 to the recipient, one to self). Inbox = subscribe 1059 p-tagging own pubkey → unwrap → keep kind 14 → group by peer, order by rumor `created_at`. Works before/during/after the event and with any NIP-17 client.

**Event updates (organizer).** Admin composes title + markdown → publish kind 30023 signed by `E_id` (`d` stable per update; same `d` = edit, `published_at` preserved). Event page fetches 30023 by author `E_id`, dedupes by `d` (highest `created_at` wins), renders newest-first.

**Publish event post (§7.4).** Admin composer: title/summary/image + markdown with preview → visibility chosen at creation: **public** → 30023 (as above); **members-only** → 31607 (all metadata inside the ECK ciphertext, random stable `d`, `eck` tag = current version). Edit = republish same `d` (members-only re-encrypted under the current ECK). The editor enforces the 60 KB members-only ceiling.

**Customize event page (§7.4).** Admin → *Appearance*: CSS editor with live preview → publish 31609. Admin → *Menu & layout*: manage menu items (label + target via the post-aware picker or a URL field; per-item public/members-only toggle) and home sections (type + filters + order, per-section visibility) → publish 31608 (public parts in tags/cleartext JSON, members-only parts ECK-encrypted in `private`). All signed `E_id`.

**Read posts.** `#/e/<naddr>/posts` lists posts with filter controls mirroring the section config — source: event-official / attendees / both; visibility: public / members-only / both. Members-only posts decrypt with the granted ECK (version per the `eck` tag); an naddr link to a 31607 without the key renders a lock + join prompt. Attendees put their own writing in the feed by tagging a public 30023 with `["a", <coordinate>]` from any NIP-23 client.

**Revoke attendee.** Organizer sends 21604 `revoke` (or does it client-side without coordinator): delete 31603 (NIP-09), rotate ECK, re-grant 21602 to remaining attendees, republish roster + future content under new ECK.

**Withdraw (attendee).** Attendee sends 21610 (sealed by their own account key — no organizer action required): the same effect chain as a `revoke` — 31603/roster/match removal, ECK rotation, re-grant to the rest — plus the withdrawing client deletes its own Blossom blobs and its 31602 self-copy. Rejoining later is a fresh join request.

**Detach / replace coordinator.** Organizer edits 31600: bumps `gen`, and either removes the `coordinator` tag (detach) or names a different coordinator at the new `gen` (replace) — or, for an immediate signed detach, sends a 21604 `detach` command. A coordinator that sees a newest fetchable config no longer naming it at its installed `gen` durably tombstones the installation, closes the event's subscriptions, cancels pending paid work, and deletes its `E_inbox`/ECK custody. The organizer rotates the ECK and mints a fresh `E_inbox` keypair (the same machinery as an attendee revoke), publishing the new inbox in the updated 31600 so senders transparently encrypt to it going forward; old inbox secrets stay in the organizer's local key backup for reading history. A newly attached coordinator republishes the event's directory, roster, match lists, and talks under its own key, so members are never left without a readable directory; every reader accepts coordinator-authored records only from whichever coordinator the newest fetchable 31600 currently names.

## 9. Coordinator service

Headless TypeScript/Node daemon (`packages/coordinator`), sharing `packages/protocol` with the PWA. Interface = Nostr only. Runs fine on one small VPS; ffmpeg is assumed present (and is verified at startup).

### 9.1 State: SQLite authority and recovery

The implementation uses Node's built-in `node:sqlite`. Content-addressed derived artifacts can often be rebuilt from relays and providers, but the database is **not disposable**. Treat it as durable operational state and follow [COORDINATOR-OPERATOR-GUIDE.md](COORDINATOR-OPERATOR-GUIDE.md).

| State | Recovery property |
|---|---|
| Relay-backed public/config/encrypted records and derived transcripts/profiles/pairs | Usually reconstructible, with relay/provider cost and availability consequences. |
| Jobs, dedupe, invite claims, billing/budget enforcement state, and Cashu journal | Durable operational state. Loss can replay work, lose queue context, reset billing enforcement to `evaluating`, or leave financial outcomes ambiguous. |
| Coordinator `E_inbox` and ECK custody | Protected at rest under the coordinator identity, but required to resume installed-event processing. |
| Marmot group/admin state in `marmot_kv` | Non-reconstructible from relay events. Loss can orphan the coordinator's MLS administration role. |

Tables include `events`, `attendees`, `jobs`, transcripts, summaries, profiles, pairs, invite usage, Cashu journal, Marmot groups, and protected Marmot key/value state. Back up SQLite and the coordinator identity together, restore-test it, and maintain a second MLS administrator for chat-enabled events.

### 9.2 Event loop & pipeline

Subscriptions:
- `{kinds:[1059], "#p":[coordinator_pubkey]}` — install grants (21603), admin commands (21604).
- Per installed event: `{kinds:[1059], "#p":[E_inbox_pubkey]}` (join requests + submissions; coordinator unwraps with the granted `E_inbox` nsec) and `{kinds:[31600,31601], authors:[E_id]}` (config/invite updates).
- All gift-wrap subscriptions use `since = now − 3d` (timestamp randomization) with rumor-id dedupe.

Per-submission pipeline — each stage an idempotent job, dedupe key = hash of stage inputs, exponential-backoff retries (max 5, then poison state surfaced as a 21606 status to the organizer and, when the failure is scoped to one attendee's own submission or talk, sealed to that attendee too — so the one person who can actually fix it isn't left waiting on the organizer to notice; billing blocks stay organizer-only):

```
unwrap → entitlement check ──(invite valid & unused)──► auto-grant 21602, mark usage
      │                    └─(else)──► manual queue (organizer approves)
      ▼ (once approved)
publish 31603 (profile text immediately)
      → billing/budget gate (§9.5): a blocked event, or an attendee/event past its
        budget, parks here — before any provider spend
      → fetch blob (Blossom GET, verify sha256 AND that the actual downloaded
        ciphertext length matches the descriptor's declared size)
      → decrypt (AES-GCM)
      → ffmpeg: probe real decoded duration and reject media over the event's cap
        regardless of what the descriptor declared; extract audio, mono 16 kHz
        Opus/OGG, bitrate to fit provider limit (25 MB for Venice; segment long
        talks and concatenate transcripts)
      → STT provider → transcript
      → nostr-context: fetch attendee's kind 0 + last N (config §7.1) public events
        (kinds 1, 6, 30023; resolve reposts to their targets), summarize with the
        cheap summaryModel → interests summary          [skipped if N=0 or no content]
      → LLM profile (matchModel, json_schema strict): transcript(s) + profile text
        + nostr summary → ai_profile {summary, skills, interests, offers, seeks}
      → update 31603 with ai_profile
      → matching (§9.3) → publish/refresh 31605 for affected attendees
      → refresh 31604 roster
```

### 9.3 Matching & N² cost control

- Pair scoring prompt takes both `ai_profile`s + event context (title/summary/hashtags from 31923 — REQUIRED input: what counts as a good match depends on what the event is about) and returns strict-JSON `{score, similarity, complementarity, reasoning}`. Scoring must explicitly reward **complementarity** (skills that complete each other for this event's purpose), not just similarity.
- **Talks feed matching too (§7.1 `talks` tag, `"on"`/`"prerecord-first"`).** When talks are enabled, a speaker's own submitted talk transcripts fold into their `ai_profile` alongside their intro — so recording a talk ahead of a `"prerecord-first"` event improves that speaker's own matches, not just their audience's.
- **Reasoning is user-facing copy, not analysis.** The `reasoning` field is shown verbatim to the attendee and must read as *"why you should meet this person and what to talk about"* — second person, concrete conversation hooks, the way a good host introduces two guests. No analytical framing (no "this pair scores high because…", no similarity/complementarity vocabulary, no score justification).
- **Icebreakers.** Alongside the directional reasoning, scoring may also emit up to 3 short (≤ 280 char) `icebreakers` — concrete conversation starters, not restatements of the reasoning (§7.3 kind 31605). The attendee list shows them next to the reasoning; a one-tap "message" action can prefill a DM (§7.2 kind 14) with one, so the coordinator's introduction becomes an actual opening line rather than just a rationale to read.
- **Batched scoring (cost shape).** Pair-per-call is O(N²) and untenable at ~200 attendees even after the prefilter; scoring SHOULD batch one *target* attendee with K candidates per call (each call returns per-candidate scores + target-directed reasoning; the reverse direction comes from the candidate's own batch). K is a quality/cost trade-off — see `docs/MATCHING-BENCHMARK.md` for the measured curve and the recommended model/prompt/K.
- **Incremental:** a new joiner costs exactly N−1 new pair jobs; `pairs` rows are keyed by `inputs_hash = sha256(sorted(profileA_hash, profileB_hash))`, so a *changed* profile invalidates only its own pairs and a restart never re-pays for finished pairs. A changed attendee's forward direction (changed→others) batches normally (one target + ≤K candidates); the reverse direction (others→changed) is scored by a mirror **reverse-batch** call (one shared candidate + ≤K targets) so it stays batched instead of degrading to N−1 single-candidate calls. Pairs not involving the changed attendee are never re-scored; both directions of the changed attendee's pairs are invalidated and the affected 31605 lists republish (publish keys are content-addressed, so identical re-deliveries dedupe).
- **Output language & input-language independence (§7.1 `lang`).** Match reasoning and profile summaries are written in the event language. Attendee inputs — bios, Nostr posts, intro/talk transcripts — may be in ANY language (an English bio at a Slovak event is normal), and the prompts say so explicitly and translate as needed; STT auto-detects the spoken language (no language hint is pinned). Separately, the coordinator translates each attendee's **user-authored** directory fields (`about`, `looking_for`, `skills`) into the event language when their source language differs, publishing the result in `ai_profile.translations` without ever modifying the originals (see §16.2).
- **Above a threshold** (default 50 attendees): embed each `ai_profile` once (provider `embed()`); for each attendee LLM-score only top-M by cosine similarity **plus a random sample of low-similarity candidates** (defaults M=30 + 10 random; both config). The random slice is essential: complementarity is precisely what embedding similarity misses — the drummer must still meet the bassist.
- Full recompute only on 21604 `recompute`.
- Per-attendee 31605 lists contain top-K (default 20) by score.

### 9.4 Provider abstraction (the Routstr-readiness requirement)

All AI I/O goes through three interfaces in `packages/coordinator/src/providers/types.ts`; nothing else in the codebase may import an HTTP client for AI:

```ts
export interface SttProvider {
  readonly id: string;                                  // "venice-stt" | "local-whisper"
  capabilities(): Promise<{ models: string[]; maxUploadBytes: number }>;
  transcribe(audio: { data: Uint8Array; mime: string; language?: string },
             opts?: { model?: string }): Promise<{ text: string; language?: string }>;
}

export interface LlmProvider {
  readonly id: string;                                  // "venice" | "routstr"
  models(): Promise<ModelInfo[]>;                       // always queried at runtime
  completeStructured<T>(req: {
    system: string; user: string;
    schema: object; schemaName: string;                 // json_schema strict mode
    model: string; temperature?: number; maxTokens?: number;
  }): Promise<{ value: T; usage: TokenUsage }>;
  embed?(texts: string[], model?: string): Promise<number[][]>;   // optional capability
}

export interface PaymentStrategy {                      // orthogonal to providers
  prepare(req: { estimateTokens?: number }): Promise<Record<string, string>>; // → HTTP headers
  settle(responseHeaders: Headers): Promise<void>;      // e.g. bank Cashu change
}
```

**Venice.ai adapter** (primary; `https://api.venice.ai/api/v1`, OpenAI-compatible, `Authorization: Bearer <key>` = `ApiKeyPayment`):
- `VeniceStt`: `POST /audio/transcriptions` (multipart `file` + `model`; 25 MB limit — hence the ffmpeg compression/segmentation stage; models e.g. `openai/whisper-large-v3`, default parakeet).
- `VeniceLlm`: `POST /chat/completions` with `response_format {type:"json_schema", json_schema:{name, strict:true, schema}}` (schema needs `additionalProperties:false`, all props required); `GET /models` at runtime and filter by `supportsResponseSchema`; `POST /embeddings` for the pre-filter. **Model policy:** config flag `venice.require_private: true` restricts selection to models in Venice's private/TEE tiers (only TEE/E2EE are technically enforced; document per §4.2), overridable per role (see "Provider routing" below).

**Routstr adapter (experimental, explicitly configured)** — Routstr is a Cashu-paid, OpenAI-compatible LLM path only when `[providers.routstr].node_url` is set. Kind-38421 provider discovery is design-only and not wired into daemon startup. `RoutstrLlm` uses the configured node URL; structured output depends on the upstream model.
- `CashuPayment`: either balance mode (`Authorization: Bearer <cashu-token>`, node converts to an `sk-` key) or stateless per-request `X-Cashu: <token>` with **change returned in the `X-Cashu` response header** — `settle()` must persist the change proofs (wallet state via `@cashu/cashu-ts`). The operator experience: *fund the coordinator with Cashu tokens, pick a node and model, done.*
- Routstr has **no STT** in this daemon. `VeniceStt` is the only implemented STT provider; `local-whisper` is an unsupported configuration value and startup rejects it.

**Provider routing is per role.** Each model role — `summary`, `match`, `embed`, `translate` (STT is a separate single-role slot, §9.6) — configures its own `{provider, model}` pair; roles are not forced onto one global provider instance. At startup the daemon resolves and validates a concrete provider instance per role: a role pointing at an unconfigured provider (missing API key / node URL) fails startup, and a role that requires a private-tier model (`require_private`, a per-role override of the provider-level default) whose resolved model isn't in that provider's own private/TEE catalogue also fails startup — unless the operator explicitly accepts booting unverified. This lets an operator mix providers per role (e.g. summary/match/STT on Venice private-tier, embed on an experimental Routstr node) with the mix enforced, not just declared. The public **31611 Coordinator Announcement**'s per-role privacy disclosure is generated from these resolved, verified routes, not from configured intent, so the privacy map an organizer sees always describes where data actually flows.

### 9.5 Billing, budgets & media policy

**Billing.** The billing principal is the **event identity** (`E_id`), not a personal organizer account — nothing about an event's config authenticates "the organizer" as a person, so config names `free_eids` (an allowlist of always-free event identities), not `free_organizers`. Billing state is a persisted state machine, `evaluating → ok | grace | blocked`, re-evaluated at coordinator install, on attendee-count change, on every submission revision, on job claim, and immediately before any provider spend, so a verdict can never go stale mid-job. An optional operator-configured grace window lets a newly over-tier event keep running paid work for a bounded period before it transitions to `blocked`; absent, it blocks immediately. `blocked` stops paid provider work only — approvals, revocations, roster/directory maintenance, and status publication are never affected, so a billing block degrades an event to "matching paused," never "event broken." A state transition publishes a 21606 status to the organizer carrying the current billing state and reason.

**Budgets.** Independent of billing, the coordinator enforces generous, operator-configured abuse ceilings — not product limits — on actual (not declared) downloaded ciphertext bytes, decoded media duration, and provider-call counts, tracked both per-attendee and per-event. Exceeding a budget parks further paid processing for that attendee or event (the same waiting state as a billing block) and notifies the organizer; raising the limit and reprocessing resumes it.

**Media policy.** A submitted media descriptor's declared `size` and `duration` are attacker-controlled input, so the coordinator never trusts them for enforcement: it compares the actual downloaded ciphertext length against the declared size and rejects a mismatch (§9.2 pipeline), and it probes the real decoded duration before running STT, rejecting media that exceeds the event's configured limit regardless of what was declared. Per-submission caps on the number of media descriptors and the total declared bytes (§8) are a first, cheap filter before any of this runs.

### 9.6 Configuration (`coordinator.toml`, illustrative)

```toml
[identity]        # nsec via env NOSTRAUTICA_COORDINATOR_NSEC, or:
ncryptsec_file = "coordinator.ncryptsec"   # passphrase prompted / env

[relays]
default = ["wss://relay.primal.net", "wss://relay.damus.io"]

[providers.venice]
api_key_env = "VENICE_API_KEY"
require_private = true

[providers.routstr]        # optional experimental LLM path; node_url is required
node_url = "https://api.routstr.com/v1"
mint = "https://mint.example"
wallet_db = "cashu-wallet.sqlite"

[stt]
provider = "venice-stt"          # only implemented STT provider
model = "openai/whisper-large-v3"

[models]
summary = { provider = "venice", model = "<cheap>" }    # resolve against GET /models
match   = { provider = "venice", model = "<strong>" }
embed   = { provider = "venice", model = "text-embedding-bge-m3" }

[matching]
prefilter_threshold = 50
prefilter_top_m = 30
prefilter_random = 10
top_k = 20

[pricing]           # §9.5; default model = "free" (no billing enforcement)
model = "free"
# free_eids = ["npub1…"]        # event identities always treated as free
# grace_period_sec = 604800     # optional grace before blocked (default: none)

[budgets]            # §9.5; generous abuse ceilings, not product limits — 0 = unlimited
# per_attendee_bytes = ...
# per_event_bytes = ...
# per_attendee_duration_sec = ...
# per_event_duration_sec = ...
# per_attendee_calls = ...
# per_event_calls = ...
```

Installation is protocol-level (21603 grant + 31600 `coordinator` tag) — no per-event server configuration.

## 10. Frontend (PWA)

### 10.1 Stack & routing

- SvelteKit, Svelte 5 (runes), `adapter-static` with a single fallback page; **hash-based routing** via a thin hash-router layer (single catch-all route; `location.hash` parsed into a route store; pages under `src/lib/pages/`). Reason: nsite gateways serve the SPA fallback with HTTP **status 404**, which breaks history-API deep links for anything status-sensitive; hash routes sidestep it entirely and work on every static host.
- `@nostr-dev-kit/ndk` v3 + `@nostr-dev-kit/cache-dexie` (IndexedDB cache) + `@nostr-dev-kit/svelte`. Relay set = app defaults ∪ event 31600 relays ∪ user 10002.
- Routes: `#/` (my events + discover), `#/login`, `#/create`, `#/e/:naddr` (event home), `#/e/:naddr/join?code=…`, `#/e/:naddr/record`, `#/e/:naddr/attendees`, `#/e/:naddr/attendees/:npub`, `#/e/:naddr/matches`, `#/e/:naddr/posts`, `#/e/:naddr/posts/:d`, `#/e/:naddr/admin`, `#/me`, `#/settings`.

### 10.2 PWA & auto-update (never stuck on an old version)

- `vite-plugin-pwa`, `registerType: 'autoUpdate'` (sets `skipWaiting`/`clientsClaim`), `cleanupOutdatedCaches: true`, `registerSW({ immediate: true })`.
- Periodic update check via `onRegisteredSW`: `fetch(swUrl, {cache:'no-store'})` + `registration.update()` on an interval (60 s while the app is open during an event is fine) **plus** on `visibilitychange` → visible (iOS applies updates on relaunch).
- Classic-host deployment must serve `sw.js`, `index.html`, `manifest.webmanifest` with `no-cache` and hashed `/assets/*` as `immutable`. On nsite, headers are fixed (`max-age=3600` + strong sha256 ETag) — acceptable because browsers bypass the HTTP cache for SW update-check requests by default; the real update-latency floor on nsite is the gateway's manifest re-sync (~minutes).

### 10.3 Video capture & playback

- MediaRecorder; mimeType ladder `video/mp4;codecs=avc1` (Safari) → `video/webm;codecs=vp9,opus` → `video/webm`. Visible countdown; hard-stop at `max_video_sec`/`max_talk_sec`; preview + re-record before submit.
- Encrypt: WebCrypto AES-GCM one-shot in memory (fine for short intros; chunked streaming encryption for large talks is future work, §13 — GCM whole-file also means no range-request streaming playback; playback = fetch ciphertext → decrypt → object URL).
- Upload: `blossom-client-sdk` — BUD-06 `HEAD /upload` preflight (size/type acceptance), BUD-02 `PUT /upload` (kind 24242 auth event: `t=upload`, `x=sha256`, `expiration`), BUD-04 `PUT /mirror` to remaining event servers + the user's 10063 servers.

### 10.4 Offline behavior

Dexie cache serves roster, directory entries, matches, and profile metadata offline; ECK + self-keys live in IndexedDB so decryption works offline; decrypted intro videos are cached via Cache API (bounded LRU); outgoing events queue and flush on reconnect. These are local caches and operational state, not relay-backed canonical records. Goal: an attendee in a venue with terrible Wi-Fi can still browse people and matches.

### 10.5 UI chrome

- Dark/light: CSS custom properties; default from `prefers-color-scheme`; user override persisted (localStorage mirror → 30078).
- i18n: Paraglide JS (compile-time, static-host-friendly); `en` + `sk` initially.
- Accessibility and mobile-first layout; the primary device at an event is a phone.

## 11. Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for supported PWA modes, header guarantees, release verification, and the difference between the nsite reference workflow and an operator-managed conventional host. See [COORDINATOR-OPERATOR-GUIDE.md](COORDINATOR-OPERATOR-GUIDE.md) for coordinator state, backup, and lifecycle requirements.

- **PWA:** fully static output deployable to nsite or a conventional static host. These modes do not have equivalent response-header guarantees.
- **Coordinator:** Node + ffmpeg/ffprobe plus protected durable SQLite state. Local Whisper is not implemented.
- **Relays/Blossom:** the app defaults to public infrastructure; organizers can point events at their own relay + Blossom server via 31600 for locality/retention control.

## 12. Ticketing & approvals

- **Approval modes:** `approval = manual | invite | manual+invite` (§6.5, §8), both available from day one.
- **Future — Cashu ticketing + door check-in (§13):** buy a ticket → receive a Cashu token (P2PK-locked to the attendee npub, NIP-61-style; BTCPayServer/mint integration); join request carries `["payment", <cashu-token>]`; the coordinator's entitlement checker redeems it and auto-grants. No protocol change: it is one more checker beside `invite`. Related merged primitives: NIP-60 (relay-stored wallets), NIP-61 (nutzaps). There is **no standard ticketing NIP** — this convention is app-defined and documented here.

## 13. Future features

Design-compatible with the current protocol, not yet built. Most of these need no wire change, or only a small additive one.

- **Post-event report & payoff flow.** A print-friendly (browser print-to-PDF, no server rendering) event report: people met, people wanted-to-meet-but-not-met, favorite talks, personal notes. "Met" stays editable after the event ends, so the report reflects what actually happened at the venue, not just what was planned beforehand. A one-click **follow-all** of everyone marked met or want-to-meet (a single kind-3 append-merge, reusing the existing empty-list guard, §5.4). Any npub list the report offers is a **local-only export**, never a published follow pack: kind 39089 / following.space packs are public events, and publishing "everyone I met at event X" by default would leak the user's participation and social graph — that path is deliberately not the default (a clearly-labeled opt-in "publish as follow pack" could be offered later). No vCard export — the app neither holds nor wants contact data beyond what's already in Nostr profiles. For an app-generated identity, the report is where the flow ends in the "switch to Nostr" moment: an nsec/ncryptsec export walkthrough and links to Primal/Damus/Amethyst/Yakihonne (§5.4).
- **Client-side search** across decrypted directory entries, profiles, and transcripts.
- **Offline event pack.** One-tap pre-download of roster, directory, matches, and intro thumbnails, plus a persistent-storage request so mobile browsers are less likely to evict the cache mid-event.
- **"What's new" affordances:** a new-matches badge, an approval banner, and similar low-key surfaces for what changed since the user's last visit.
- **Organizer QoL:** duplicate-event/templates (clone an event's config as a starting point); a printable invite sheet (one QR per invite code); a view-as-visitor preview. (A view-as-*member* preview is deliberately not planned — an admin's own member view already *is* the member view. The visitor view genuinely differs — locked members-only posts, hidden members-only menu items/sections — which is the gap worth previewing.)
- **Cashu ticketing + QR door check-in — one feature, two halves, implemented together.** Ticketing per the existing §12 design (Cashu token entitlement checker, no protocol change). Check-in completes it at the venue door: the attendee's app shows a QR encoding a BIP-340-signed `{coordinate, pubkey, timestamp}` statement; door staff verify it offline against the ECK roster — no connectivity or server needed. Check-in without ticketing is technically possible (roster membership alone is the gate), but it only earns its keep once admission is actually paid, so the two ship together.
- **Schedules & unconference:** sessions as NIP-52 (31923 children under a 31924 calendar) or NIP-53 (30312/30313 rooms); grid UI; per-person favorites (already in 30078); **.ics export** of the schedule and of "my favorites"; unconference board = attendee-proposed sessions + voting.
- **Meeting slots:** free/busy publication and mutual-match time/table suggestions.
- **WoT spam filtering:** rank join requests/discovery by follow-graph distance from the organizer.
- **Multi-organizer roles:** scoped grants (approve-only vs full key custody) — today's only co-organizer grant (21605) is full, irrevocable custody (§7.2).
- **Chunked media encryption:** streaming playback + >25 MB robustness.
- **Attendee-authored members-only posts:** 31607 signed by attendee keys needs a *blinded* event linkage for discovery (a cleartext `a` tag would publicly tie the author to the event) — deferred; members-only posts are `E_id`-only today (§7.4).
- **Nostree mirror:** optionally republish the public menu items as a real NIP-51 kind 30003 bookmark set for interop with list clients.
- **Per-event group chat — NIP-17 half:** NIP-17 group messages (small events / spawned subgroups, lives on in Amethyst/Nostria) as an organizer-choosable alternative backend alongside Marmot, via the 31600 `chat` tag; research in `GROUP-CHAT-FEASIBILITY.md`. An ECK-encrypted web-only chat was considered and rejected — post-event chats must survive in attendees' own clients.

**Explicitly considered and not planned:**

- **Match feedback loop.** Attendee ratings biasing future match scoring would need a new opt-in feedback rumor to the coordinator — ratings currently live in user-private 30078, unreadable by the coordinator by design, and giving that up for an unproven quality gain isn't judged worth the privacy trade-off.
- **Geohash event discovery.** Not until there's real multi-event usage to justify it.
- **Negentropy sync (NIP-77).** Not until relay support is common enough to matter.

## 14. Security & threat model summary

**Protected:** submission contents pre-approval (only `E_inbox` holders read them); event content from non-attendees; match reasoning from everyone but the pair (default); user-private data from everyone including the coordinator; event impersonation (only `E_id` signs); invite forgery (hash-hidden pubkeys + pubkey-bound, domain-separated signatures); coordinator authority (record and grant authority is pinned to whichever coordinator the newest fetchable 31600 currently names at the current `gen` — a detached or replaced coordinator's authored records and grants stop being trusted, §9); chat device binding (a chat key can't be attested without a signed proof of possession, §7.5).

**Leaks (accepted & documented):** attendee *counts* (directory-entry counts per coordinator); blob-hash linkage across events when reusing intros without "fresh copy"; timing correlation on relays; `E_inbox` p-tags on inbound wraps mark *that* someone submitted (not who — wrap authors are one-time keys); each chat device's kind-0 (published only to chat relays) links it to the owning account's npub, by design (§7.5). Email backup of nsec traverses email infrastructure (user-chosen trade-off, §5.2).

**Trusted parties:** coordinator (reads event content; cannot impersonate); LLM/STT provider (reads transcripts/summaries; mitigate via Venice private/TEE tiers or operator-chosen Routstr nodes); relays/Blossom (ciphertext + metadata only).

**Client hygiene:** local keys in IndexedDB (not localStorage strings where avoidable), NIP-49 for any at-rest export, `#/login?nsec` stripped from history immediately, no third-party scripts (CSP: `default-src 'self'; connect-src wss:/https: relays+blossom`), NIP-04 lint-banned, NIP-44 scheme always explicit.

**Revocation honesty:** rotation is forward-only (§6.3); published ciphertext is forever for past key-holders.

## 15. Volatile facts — re-verify at build time

| Fact | How to verify |
|---|---|
| Venice model ids, context sizes, `supportsResponseSchema`, private/TEE flags | `GET /api/v1/models` at runtime (never hardcode) |
| Venice STT limit (25 MB) & model list | `docs.venice.ai` + error responses |
| Blossom server size limits / acceptance | BUD-06 `HEAD /upload` preflight per server |
| Routstr node models, sats pricing, accepted mints, structured-output support | node `GET /v1/models`, `GET /v1/info`, live probe |
| nsite gateway behavior (404-status fallback, header policy, manifest sync interval) | test deploy against target gateway (e.g. nsite.lol) |
| NDK v3 / nostr-tools / blossom-client-sdk APIs | pin versions at P0; notes in IMPLEMENTATION_PLAN.md |
| Amber NIP-46 behavior (per-connection keys, `logout`) | test against current Amber release |
| Custom kind collisions (31600–31611, 21600–21610) | re-check nostr-protocol/nips registry before first release; see PROTOCOL-REGISTRY.md |

---

## 16. Implementation notes & deviations (as built)

This section records concrete decisions and small deviations made while building and running the coordinator and app (the sections above remain normative intent; this documents *as-built* reality).

### 16.1 Custom kinds — additions

The current implemented set is documented in [PROTOCOL-REGISTRY.md](PROTOCOL-REGISTRY.md): addressable kinds 31600–31611 and rumors 21600–21610. Admin commands include `approve`, `talk_publish`, `talk_reject`, and `detach`; all admin commands are sealed by `E_id`.

### 16.2 Coordinator
- **Store:** Node's built-in `node:sqlite` (Node ≥ 22.5) instead of `better-sqlite3` — same synchronous embedded-SQLite semantics as §9.1 intends, no fragile native build. Requires Node ≥ 22.5 (CI/Docker pinned to Node 22).
- **Install-time subscription:** on receiving a `21603` grant while already running, the coordinator subscribes to that event's `E_inbox` immediately (idempotently); `since = now − 3d` backfills join requests/submissions published before it was attached.
- **Manual approval with a coordinator:** the organizer's Approve routes through the coordinator via a `21604 approve` command so the directory/roster are authored under the coordinator key (which is where attendees look for them). Without a coordinator, the organizer publishes them signed by `E_id`.
- **Matching (2026-07-13, batched — docs/MATCHING-BENCHMARK.md):** pair scoring is **batched and directional**: one LLM call scores ONE target attendee against ≤K candidates (`matching.batch_size`, default 10; candidate order shuffled per batch to spread position bias) using the benchmark's BP3 prompt verbatim — rubric score anchors plus host-voice `reasoning_for_target` that is shown to the attendee as-is. Each direction of a pair (`a→b`, `b→a`) is scored and persisted independently in the pair cache (same `inputs_hash` keying; the reverse direction comes from the candidate's own batch via content-addressed recompute triggers), so an attendee's list ranks by their own directional scores. Batching is a transport optimization only: results are written per pair, a retried or partial batch re-sends only still-unscored candidates (finished pairs are never re-billed), and one malformed candidate never poisons its batch-mates. Scores are clamped/rescaled to [0,1] defensively; `recompute` clears the pair cache before re-scoring.
- **Match-model privacy (per-role knob):** the match model is `deepseek-v4-flash` (benchmark winner: best recall@1/separation, judge 4.53, ≈45× cheaper than glm-5-2 pairwise) — **not** Venice private-tier. Privacy is therefore a per-role policy: `models.<role>.require_private` overrides `providers.venice.require_private` (default true) for that role only, and the daemon verifies each role's model against GET `/models` at startup (a private-required role on a non-private model is a hard error; the accepted non-private match role logs a warning).
- **Venice adapter:** requests set `venice_parameters` `{ disable_thinking:true, include_venice_system_prompt:false, strip_thinking_response:true }` and a higher default `max_tokens` — reasoning models otherwise spend the whole budget on chain-of-thought and return empty content.

### 16.3 Client
- **Fresh-device & remote-signer resilience (2026-07-16, prod feedback):** directory entries now carry the join-request display `name` (31603 optional field) so rosters/matches/attendee pages show who someone is even when their kind-0 is slow or unreachable; "My events" refreshes recovered entries with the real title/icon; the event page paints public content in parallel with the grant scan, shows a skeleton while the feed loads, and shows a status badge only when actionable (pending/visitor — approved just works); roster/directory/match-list reads stream (first-EOSE + hard timeout) instead of waiting on the slowest relay; NIP-46 bunker RPCs are time-bounded (60s) so a dead signer relay errors instead of freezing screens; DM reads memoize unwraps per wrap id and terminate on timeout; the SW navigation fallback binds the precached `<base>/index.html` (was broken under `/app`); the tseep patch also guards emit against listener removal mid-loop. People quick actions (message / want-to-meet) live on the roster rows; the "favorites" category is retired in the UI (schema field remains). Coordinator: **profile-first matching** — the AI pipeline runs at approval time from the join profile + nostr context, no intro required; a later intro re-processes and re-matches via the submission-hash job key.
- **Organizer self-enrollment (2026-07-16):** the create form has a default-on
  checkbox that enrolls the organizer as a participant of their own event, so
  the roster is never empty for the first attendee. Implementation is purely
  protocol-native, keyed to the organizer's PERSONAL pubkey (never E_id): a
  self-minted single-use invite (31601) backs a real 21600 join request to
  E_inbox — so a coordinator attached later auto-approves it from the
  full-history backfill instead of queueing the organizer as pending — plus an
  immediate client-side self-approval (grant/directory/roster signed by E_id,
  roster role "organizer") for instant visibility. The enrollment completes
  before the share link is shown (an attendee's approval must never race it),
  and the keystore is untouched (an incoming attendee-role grant never
  downgrades an existing organizer record).
- **Perceived latency (2026-07-16):** relays are slow, so the client hides round-trips two ways. *Predictive prefetch* (`lib/nostr/prefetch.ts`): each page silently warms what the next step renders — Home warms event contexts on mount and card hover; Join warms organizer profiles + the post-join event page while the form is being filled, and grants + the attendees tab on sign-in; the event page warms the Attendees tab and organizer key recovery. Warmers are best-effort, TTL-deduped, and never trigger a remote-signer prompt (decrypt-bearing warmers gate on local-key signers). *Progressive multi-relay fetching* (`lib/nostr/stream.ts`, `dedupe.ts`): a streaming fetch emits events as each relay answers — deduped by id plus NIP-01 latest-wins per replaceable key — and resolves on first EOSE + a short grace instead of waiting for the slowest relay, with a hard timeout so a dead relay can never stall a screen. The roster renders entries as they decrypt; the matches screen paints before names/avatars enrich; event page + posts fetch in parallel with the grant scan. The per-identity blinding key is memoized (was: a relay fetch — and a signer prompt for remote signers — on every derivation), cleared on logout.
- **Snappy caches + rich feed (2026-07-17, prod feedback):** session-lifetime in-memory caches for kind-0 profiles (`social.ts`), event/attendee posts (`posts.ts`), and decrypted directory entries (`attendee.ts`) back cache-first paint everywhere — the Updates page, the event home feed, and the attendee-detail page render instantly on revisit and refresh in the background; the attendee page fetches profile/entry/recent-posts independently (no whole-directory re-pull to show one person). Event open warms the attendee-posts feed too. All relay reads pass `relaySet` via `opts` (NDK v3.14 deprecation). Post rendering (`PostView` + `QuotedNote`) is a real client feed: inline images/video, resolved @-mention names, quoted-note embeds (`nostr:note1…`/`nevent1…`), and a resolved reply-parent card. The create form's icon/banner use an interactive crop/zoom picker (`ImageCropper`) so the upload matches the rendered aspect; the post composer's header image can be uploaded to Blossom, not just pasted as a URL. The event-page "Latest" highlight and the feed dedupe so a post never shows twice. The "More" identity card shows the user's avatar + display name + a click-to-copy npub.
- **PWA auto-update:** on detecting a new deploy the app reloads itself (no "click to reload"): `autoUpdate` (skipWaiting + clientsClaim) + a guarded `controllerchange` reload; update checks run every 60s / on focus / on reconnect, fetching `sw.js` with `cache:'no-store'`. Classic hosts that cache `sw.js` aggressively still update because `registration.update()` bypasses the HTTP cache per the SW spec.
- **Relay publish resilience:** a publish succeeds if it reaches ≥1 relay; a global `unhandledrejection` guard swallows expected relay rejections (rate-limited, timeout, PoW, auth-required, duplicate…) so a slow relay's late `OK=false` (NDK orphan-promise) never surfaces as an uncaught error.
- **NIP-46 (remote signer) session persistence:** the bunker pointer + client key are stored in IndexedDB and reconnected via `BunkerSigner.fromBunker` on refresh, so remote-signer logins survive reloads. The stored pointer keeps only the relays the signer advertised; the app unions them with its own signer relays per connect attempt, so a single dead signer relay degrades the flow instead of breaking it. The nostrconnect flow also offers an "Open in your signer app" deep link + copy button alongside the QR — the QR is shown on every platform, since displaying it on one device and scanning it from a separate phone is a supported path.
- **Event images:** two optional public (unencrypted) Blossom images — a small **icon** (E_id kind-0 `picture`) and a wide **banner** (31923 `image` / kind-0 `banner`) — with deterministic generated-gradient fallbacks; surfaced via an `EventHeader` used across attendee-facing pages.
- **Navigation:** bottom nav bar; a "My events" list backfilled from the local key store (so events you created/joined always reappear), deduped by event coordinate; a smart Back button (in-app history + contextual-parent fallback); an in-memory event-context cache so event sub-pages render instantly.
- **kind-0 write policy:** see §5.4 item 1 — publish only for self-generated keys; existing users are read-only.
- **CSP (as deployed):** `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'`. `'unsafe-inline'` is allowed so SvelteKit's inline bootstrap and NIP-07 signer extensions work; there is still no external script host and no `'unsafe-eval'` (NDK's tseep emitter is patched to its eval-free variant). No `{@html}` on untrusted content, so inline-script XSS is not a vector.
- **Direct messages (2026-07-13):** NIP-17 kind-14 rumors via the signer-based NIP-59 path (§7.2); inbox route `#/dm`, conversation `#/dm/<npub>`, Message button on attendee profiles. Sent messages double-wrapped (recipient + self).
- **Follow safety + seeded follows (2026-07-13):** §5.4 item 3 empty-list guard enforced in `followUser`; app-generated keys are seeded with a kind 3 containing the event's `E_id` at join/create.
- **Event updates (2026-07-13):** NIP-23 30023 by `E_id` (§7.1); organizer composer in Admin (same-`d` edit), rendered on the event page with escape-then-markdown (organizer-authored, but still never raw `{@html}` of unescaped content).
- **Per-event language (2026-07-14, §7.1/§9.3):** the 31600 `lang` tag (ISO 639-1, default `"en"`, tag omitted for English) flows onto the coordinator's event record. Match-scoring and profile/summary prompts get an appended output-language block (BP3 stays verbatim — the block is trailing, empty for English) instructing output in the event language while stating inputs may be in any language; STT pins no language hint (whisper auto-detects). A dedicated **`models.translate`** role (default `gemini-3-flash-preview`, a Venice id; inherits the provider's `require_private` since it sees user content) translates each attendee's user-authored `about`/`looking_for`/`skills` into the event language when the detected source differs, written to `ai_profile.translations = { lang, about?, looking_for?, skills? }` — a schema extension that never touches the user's originals. Detection + translation are one call inside the attendee-processing job, so idempotency is the same input-hash keying as everything else (the nostr-summary cache key also includes `lang`, so a language change re-summarizes).
- **Scoped batched recompute (2026-07-14, §9.3):** re-recording an intro re-transcribes → new `ai_profile` → new `profile_hash`, invalidating only that attendee's pairs (both directions) by `inputs_hash`; unrelated pairs are untouched. The forward direction (changed→others) batches as one target + ≤K candidates; the reverse (others→changed) uses a **reverse-batch** prompt (`REVERSE_BATCH_SYSTEM_PROMPT` — a mirror of BP3: one shared candidate + ≤K targets, same rubric anchors/host voice/language block, per-target JSON out) so it stays batched. Call-count for 1 changed attendee among N=50, K=10: forward = ⌈49/10⌉ = 5 calls; reverse = ⌈49/10⌉ = 5 calls (was 49 single-candidate calls under naive per-other recompute). Affected 31605 lists republish under content-addressed keys; identical re-deliveries dedupe.

### 16.4 Reference deployment (nostrautica.cypherpunk.today)
- Landing page at `https://nostrautica.cypherpunk.today/` (site root); the app at `https://nostrautica.cypherpunk.today/app` (built with `BASE_PATH=/app`); docs at `https://nostrautica.cypherpunk.today/docs` — all same-origin subpaths. Hosting and deploy mechanics are operator-private (not in this repo).
- Coordinator on Venice: STT `openai/whisper-large-v3`; summary `olafangensan-glm-4.7-flash-heretic`; embed `text-embedding-bge-m3` (private-tier); translate `gemini-3-flash-preview` (private-tier). **Match model is `deepseek-v4-flash` on Venice's non-private tier** (the benchmark winner, ≈45× cheaper — `docs/MATCHING-BENCHMARK.md`): the global `providers.venice.require_private=true` default is overridden for the match role only via `models.match.require_private=false` (the per-role knob, §16.2). The daemon logs a warning at startup for the accepted non-private role; all other roles that see user content stay private-tier. An operator-accepted privacy trade-off for the reference deployment, disclosed per §4.2 — not a claim that all inference is private. No Cashu.
