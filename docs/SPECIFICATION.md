# Nostrautica — Specification

A Nostr-native event organizer built around networking, not just attendance. Attendees record short intro videos and optional pre-recorded talks; an AI coordinator transcribes them, enriches them with each person's existing Nostr content, and tells every attendee **who they should meet and why** — scoring pairs on similarity *and* complementarity of skills, with plain-language reasoning.

See `ELEVATOR-PITCH-en.md` / `ELEVATOR-PITCH-sk.md` for the product pitch. This document is the technical specification: every protocol decision is baked in and an implementer should be able to build from it together with `IMPLEMENTATION_PLAN.md`.

All protocol facts referenced here (NIP text, Blossom BUDs, Venice.ai endpoints, Routstr RIPs, nsite/NIP-5A gateway behavior, library versions) were verified against primary sources in July 2026. Volatile facts an implementer must re-verify at build time are collected in §15.

---

## 1. Vision & product overview

Conferences put interesting people in one room and then fail to connect them. Nostrautica treats networking as the main event:

- Organizers create an event; attendees join (manual approval or invite link, Cashu tickets later).
- Each attendee records a **short intro video** (length limit configurable per event) and optionally submits a **pre-recorded talk** about what they're working on.
- One supported event format has **no live stage talks at all**: talks are watched ahead of time and the venue is used for the conversations the matchmaking points people toward.
- A coordinator service transcribes videos/talks, summarizes each attendee's existing public Nostr activity, builds an AI profile per attendee, and scores **every pair** on similarity **and** complementarity (cryptographer + programmer + designer at a cypherpunk event; drummer + bassist + singer at a music gathering). Every match carries reasoning text, not just a score.
- Attendees see a ranked "people to meet" list, see who they already follow on Nostr, and can read anyone's recent public posts, rendered nicely.
- Match lists recompute as new people join.

## 2. Principles

1. **Nostr-native.** All application state lives in Nostr events on relays; media lives on Blossom servers. The public parts interoperate with the wider Nostr ecosystem (NIP-52 calendar events, kind-0 profiles, kind-3 follows).
2. **Static-only frontend.** The PWA is pure static HTML+JS+CSS talking only to relays and Blossom servers. No app server, no API backend. Soft requirement: deployable as an **nsite** (NIP-5A — the site itself hosted on Nostr/Blossom), and on any dumb static host.
3. **Minimal, honest trusted backend.** Exactly one optional server-side component — the **coordinator** — and it is a headless Nostr client, not an HTTP backend. The PWA never talks to it directly. Its trust envelope is stated explicitly (§4.2).
4. **Transparent for normies, native for Nostr users.** No crypto jargon required to register; but registering *creates a real Nostr identity* the user can carry into Primal/Amethyst/Damus/Yakihonne (§5.4).
5. **Free and open source.**

## 3. Personas & journeys

- **Normie attendee.** Clicks an event link → enters display name → records intro → gets approved → sees who to meet. Under the hood a Nostr keypair was generated; when they set a name/photo/bio a kind-0 profile was published; when they tapped "follow" on people they met, real kind-3 follow events were published. At the end the app tells them: *"You have a Nostr profile now — paste your key into any of these apps and you'll already see posts from the people you met."*
- **Nostr-native attendee.** Logs in with a NIP-07 extension or Amber via NIP-46. Their existing profile pre-fills registration; their existing posts/boosts improve their matchmaking; their intro video from a previous event can be reused with two clicks and no re-upload.
- **Organizer.** Creates the event (public NIP-52 event + app config), distributes invite links and/or reviews the join queue, attaches a coordinator, watches the roster fill in, optionally projects the event-wide match board.
- **Coordinator operator.** Runs the coordinator daemon (their own or the organizer's infrastructure), funds it with a Venice.ai API key (v1) or Cashu tokens for Routstr (v2), and otherwise never touches per-event data manually.

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
                                                                    │ v1 Venice.ai     │
                                                                    │ v2 Routstr(Cashu)│
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
- **The coordinator can read all event-encrypted content.** This is necessary — it transcribes the videos. It is organizer-chosen infrastructure and must be presented as such in the UI ("this event's AI matchmaking is operated by `<npub>`"). It **cannot impersonate the event** (it never holds the event's signing key) and cannot alter the public event, config, or invite lists.
- **The LLM/STT provider sees plaintext transcripts and summaries.** v1 mitigations: prefer Venice.ai models flagged private/TEE (§9.4). v2: Routstr nodes chosen by the operator.
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

Local-key users get multi-device by opening their emailed link or importing the nsec. All app state is on relays (self-encrypted), so a fresh device reconstructs everything from the key alone.

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

### 6.3 Event Content Key (ECK) — the outbound layer

- **ECK** = 32 random bytes generated by the organizer at event creation; versioned (`1, 2, …`).
- "Encrypted under ECK" = the NIP-44 v2 construction (ChaCha20 + HMAC-SHA256, padded) using the ECK directly as the conversation key. Audited primitives, no bespoke crypto; the protocol package exposes `eckEncrypt/eckDecrypt` wrapping nostr-tools' nip44 internals.
- **Grant:** on approval, the attendee receives (via NIP-59 gift wrap, §7 kind 21602) the current ECK plus any prior versions still needed. **Attendees never receive `E_id` or `E_inbox` nsecs.**
- **Flow:** submissions come in encrypted to `E_inbox`; the coordinator (or organizer's client if no coordinator) decrypts and republishes each attendee as a **directory entry** encrypted under ECK. Every approved attendee decrypts the whole directory with one key. Only small key wraps are ever re-encrypted; blobs never move.
- **Rotation/revocation:** removing an attendee = generate ECK v(n+1), gift-wrap it to all remaining attendees, encrypt all *future* directory/match/roster content under it. Old ciphertexts remain readable to old key-holders (see §4.2). The removed attendee's directory entry is deleted (NIP-09) and their entry dropped from the roster.

### 6.4 Match privacy

Pairwise reasoning ("you should meet her because your startup lacks exactly her skill") is the most sensitive derived data in the system, so:

- **Default `match_visibility: "pair"`** — the coordinator publishes one **match list per attendee** (kind 31605), NIP-44-encrypted coordinator→attendee. A pair's score/reasoning is visible only to its two members (each via their own list). N events, not N².
- **Reasoning is directional.** Pair scoring emits two reasonings — one addressed to each member ("why *you* should meet them", grounded in that recipient's own goals) — stored per-direction; each attendee's list surfaces the reasoning written *for them*. It answers "why should I meet him/her?" from the reader's perspective, not a symmetric blurb. Scores (score/similarity/complementarity) are decimals in [0,1]; the coordinator defensively clamps/rescales provider output that ignores the range.
- **Opt-in `match_visibility: "event"`** — additionally a full score matrix (kind 31606) under ECK, for facilitated events that project a "best matches" board.

### 6.5 Invite codes

An invite code **is an nsec** (the *invite key*):

- The organizer generates N invite keypairs and publishes kind 31601 (signed by `E_id`) containing **`sha256(invite-pubkey)`** per code — hashes, so observers can't enumerate valid codes or front-run them.
- Invite link: `https://<app>/#/join?event=<naddr>&code=<invite-nsec>` — the code rides the URL **fragment**, never sent to any server (also nsite-compatible: there is no server).
- The attendee's join request carries proof: `["invite", <invite-pubkey-hex>, <schnorr-sig-hex>]`, where the signature is made with the invite key over `sha256(utf8("<event-coordinate>:<attendee-pubkey>"))`. This **binds the code to the attendee's pubkey** — intercepting the proof doesn't let anyone else use it.
- **Stateless verification** (organizer client and coordinator both, no shared DB): `sha256(invite-pubkey) ∈ 31601` ∧ signature valid.
- **Single-use, first-come:** the coordinator auto-grants only the earliest join request per invite pubkey (by rumor `created_at`) and records usage locally; later uses fall back to the manual queue. This is eventually consistent, not strongly consistent — the failure mode is benign (extra manual review).
- **Cashu later:** the same slot takes a `["payment", ...]` proof tag; the coordinator redeems the token and auto-grants. Approvals are implemented as **pluggable entitlement checkers** so ticketing bolts on without protocol changes (§12).

### 6.6 Blinded d-tags

Wherever a per-attendee addressable event would otherwise leak attendance publicly, the `d` tag is blinded:

```
d = hex( hmac_sha256(key, "<event-coordinate>|<attendee-pubkey>") )[0..32]
```

with `key` = the attendee's NIP-44 self-conversation-key for self-stores (31602), or the current ECK for coordinator-published entries (31603, 31605). Deterministic for everyone entitled to compute it; opaque to the public. Event-scoped (non-per-attendee) events reuse the 31923 `d`.

Known metadata leak (accepted, documented): the *count* of directory entries per coordinator pubkey is observable, i.e. approximate attendee counts.

## 7. Protocol: kinds & schemas

Reused standard kinds: **0** profile, **1** notes, **3** follows, **6** reposts, **10002** relay list, **10063** Blossom server list, **1059** gift wrap (NIP-59), **30078** app data (NIP-78), **31923/31924/31925** NIP-52 event/calendar/RSVP.

Custom kinds: addressable block **31600–31609** and gift-wrap **rumor kinds 21600–21605**. Rumor kinds sit in the ephemeral range deliberately: rumors are never published directly, and if one ever leaks as a signed event through a client bug, relays won't store it. Every payload is versioned: public events carry `["v","1"]`; encrypted JSON payloads carry `"v": 1`.

Gift-wrap mechanics per NIP-59: rumor (unsigned) → seal kind 13 (NIP-44, signed by true author, empty tags) → wrap kind 1059 (random one-time key, single `p` tag = recipient, `created_at` randomized up to 2 days in the past). Consumers must query with `since = now − 3 days` overlap and dedupe by rumor id.

### 7.1 Public events (author `E_id`)

**kind 31923 — the event itself (NIP-52, unmodified)** — `d`, `title`, `start`/`end` (unix), `start_tzid`, `summary`, `image`, `location`(s), `g` geohash, `t` hashtags, `p` participants with roles. Interoperates with Flockstr/Meetstr/any NIP-52 client. Optionally referenced from a kind 31924 calendar.

**kind 31600 — Event Networking Config**
```
tags:
  ["d", <event-d>]                     // same d as the 31923
  ["a", "31923:<E_id-pubkey>:<d>"]
  ["v", "1"]
  ["inbox", <E_inbox-pubkey-hex>]
  ["coordinator", <coordinator-pubkey-hex>]      // absent = no coordinator
  ["relay", <wss-url>] …                         // event home relays
  ["blossom", <https-url>] …                     // event Blossom servers
  ["max_video_sec", "90"]
  ["max_talk_sec", "900"]
  ["matching", "on" | "off"]
  ["match_visibility", "pair" | "event"]
  ["approval", "manual" | "invite" | "manual+invite"]
  ["eck", "1"]                                   // current ECK version number
  ["nostr_context", "100"]                       // N public events per attendee to summarize; "0" = off
content: ""   (reserved for future JSON extension)
```

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
tags: ["d", <event-d>], ["a", <coordinate>], ["v","1"]
content: {"v":1, "invites":[ {"h":"<sha256(invite-pubkey) hex>", "label":"vip-1"}, … ]}
```
Replaceable — organizer republishes to add/void codes (voiding = removing the hash).

### 7.2 Gift-wrapped rumors (all delivered as kind 1059 wraps)

**rumor kind 14 — Direct Message (NIP-17, unmodified)** (→ recipient pubkey, and a
second wrap → the sender's own pubkey so sent messages are recoverable on any
device). Standard NIP-17 private direct messages between attendees — plaintext in
`content`, `["p", <recipient>]` tag, optional `["subject", …]`. Because this is
plain NIP-17, conversations started in Nostrautica continue seamlessly in 0xchat,
Amethyst, or any other NIP-17 client — before, during, and after the event. The
app's DM inbox unwraps incoming 1059s and keeps only kind-14 rumors; wrap
timestamps are randomized per NIP-59 so ordering uses the rumor's `created_at`.
No event coupling: DMs are between pubkeys; the event UI is just the entry point
(Message button on an attendee's profile).

**rumor kind 21600 — Join Request** (→ `E_inbox.pubkey`)
```
tags: ["a", <coordinate>], ["invite", <invite-pubkey>, <sig-hex>]?   // absent → manual queue
content: {"v":1, "name":"…", "message":"…", "rsvp_public": false}
```
If `rsvp_public` is true the client *also* publishes a standard public kind 31925 RSVP (opt-in checkbox; default private).

**rumor kind 21601 — Profile Submission** (→ `E_inbox.pubkey`; may accompany the join request; latest by `created_at` wins)
```
tags: ["a", <coordinate>]
content: {"v":1,
  "profile": {"about":"…", "skills":["…"], "looking_for":"…", "links":["…"]},
  "media": [ <media descriptor §6.2>, … ]        // intro; optionally talk
}
```

**rumor kind 21602 — Key Grant** (→ attendee)
```
content: {"v":1, "a": <coordinate>, "role": "attendee" | "organizer",
          "eck": [ {"id":1, "key":"<base64 32B>"}, … ],
          "granted_by": <organizer-pubkey-hex>}
```
Sent by the organizer (manual approval) or the coordinator (invite auto-approval). ECK rotation = a new 21602 carrying the added version.

**rumor kind 21603 — Coordinator Grant** (→ coordinator; this is how an organizer "installs" the coordinator for an event)
```
content: {"v":1, "a": <coordinate>, "inbox_nsec":"<hex>",
          "eck":[…], "config_relays":["wss://…"]}
```

**rumor kind 21604 — Admin Command** (organizer → coordinator)
```
content: {"v":1, "a": <coordinate>,
          "cmd": "approve" | "recompute" | "reprocess" | "revoke", "args": { … }}
```
`approve` = grant + publish directory/roster for `args.pubkey` (manual approval routed through the coordinator so directory/roster are authored under the coordinator key); `recompute` = full match recompute (clears the pair cache so every pair is re-scored); `reprocess` = re-run pipeline for a pubkey; `revoke` = remove attendee + trigger ECK rotation. Admin commands are sealed by `E_id` (the coordinator authenticates them as coming from the event authority).

**rumor kind 21605 — Organizer Grant** (→ co-organizer; spec §6.1, §13 "multi-organizer")
```
content: {"v":1, "a": <coordinate>, "eid_nsec":"<hex>", "einbox_nsec":"<hex>",
          "eck":[…], "config_relays":["wss://…"], "granted_by": <organizer-pubkey-hex>}
```
Grants a co-organizer **full key custody** — E_id + E_inbox + ECK — so they can edit the event, approve/revoke attendees, and manage the coordinator. The recipient's client stores it as an organizer key record on the normal grant-receiving scan. (Scoped roles — approve-only vs full custody — remain future work, §13.)

### 7.3 Encrypted addressable events

**kind 31602 — My Event Profile / intro library** (author = attendee; content NIP-44 self-encrypted; `d` blinded with self-conv-key)
Content = the 21601 content shape plus `"a": <coordinate>`. The attendee's own queryable copy (gift wraps aren't self-queryable — random one-time authors) **and** the reuse library: a special entry with `"a": null` and `d` blinded over the literal string `"library"` holds event-independent media descriptors.

**kind 31603 — Directory Entry** (author = coordinator, or organizer when no coordinator; content encrypted under ECK; `d` blinded with ECK)
```
tags: ["d", <blinded>], ["a", <coordinate>], ["eck","1"], ["v","1"]
content(ECK): {"v":1, "pubkey": <attendee-hex>,
  "profile": { … }, "media": [ <descriptors> ],
  "ai_profile": {"summary":"…", "skills":[…], "interests":[…],
                 "offers":[…], "seeks":[…]},        // appears when processing completes
  "updated_at": <unix>}
```

**kind 31604 — Roster** (author = coordinator/organizer; ECK; `d` = event-d)
```
content(ECK): {"v":1, "eck_current":1,
  "attendees":[ {"pubkey":…, "d":"<entry blinded d>", "role":"attendee"}, … ]}
```
One small atomic index for cheap sync; entries stay per-attendee events to dodge relay event-size caps.

**kind 31605 — Match List** (author = coordinator; content NIP-44 coordinator→recipient; `d` blinded with ECK)
```
tags: ["d", <blinded>], ["a", <coordinate>], ["v","1"]
content(nip44→recipient): {"v":1, "computed_at":<unix>, "matches":[
  {"pubkey": <hex>, "score":0.87, "similarity":0.60, "complementarity":0.95,
   "reasoning":"You both build on Nostr; she designs interfaces, you write cryptography — your project needs exactly that."}, … ]}
```

**kind 31606 — Match Matrix** (only when `match_visibility:"event"`; ECK; `d` = event-d) — `{"v":1,"computed_at":…,"pairs":[{"a":<pk>,"b":<pk>,"score":…}]}` (scores only; reasoning stays pairwise).

**kind 30078 — user-private settings** (NIP-78; NIP-44 self-encrypted content)
- `d = "nostrautica:settings"` — theme, language, relay prefs.
- `d = "nostrautica:ev:<blinded>"` — per event: `{"v":1,"favorites":[…],"want_to_meet":[…],"met":[…],"notes":{<pubkey>:"…"}}`.
- `d = "nostrautica:eventkeys:<blinded>"` (organizer) — `E_id`/`E_inbox` nsecs + ECK versions backup.

## 8. Flows

**Create event.** Organizer client: generate `E_id`, `E_inbox`, ECK v1 → publish kind 0 for `E_id` (event name/logo) → publish 31923 + 31600 (signed `E_id`) → self-encrypt key backup (30078) → optionally generate invites (31601) → optionally attach coordinator: add `coordinator` tag to 31600 + gift-wrap 21603.

**Join (attendee).** Open event link → login/registration ladder → fill profile, optionally record intro now → send gift-wrapped 21600 (+21601) to `E_inbox`; save self-copy 31602. With an invite code: include the invite proof → coordinator auto-approves → 21602 arrives, usually within seconds. Without: wait for manual approval.

**Approve (organizer).** Admin view lists pending 21600s (organizer holds `E_inbox` nsec and unwraps them) → approve → gift-wrap 21602 (ECK) to attendee → directory entry appears (published by coordinator, or by the organizer client when no coordinator). Reject/ignore = no grant.

**Submit / update profile & media.** Record video (≤ `max_video_sec`, enforced by recorder hard-stop) → AES-GCM encrypt → BUD-06 preflight → BUD-02 upload to first event Blossom server → BUD-04 mirror to the rest → send new 21601 → update self-copy 31602.

**Reuse intro at another event.** Pick from library (31602 `a:null` entry) → re-encrypt descriptor to new event's `E_inbox` in a fresh 21601 → optional BUD-04 mirror to the new event's servers → done; no re-upload, or choose "fresh copy" (§6.2).

**Coordinator processing.** See §9.2 pipeline. Directory entry text appears immediately on approval; `ai_profile` folds in when transcription+profiling completes; match lists appear/refresh after each new/changed attendee.

**View matches.** Attendee opens `#/e/<naddr>/matches` → fetch own 31605 (compute own blinded `d` from ECK) → decrypt → ranked list with reasoning; tap through to the person's directory entry, their recent kind-1 posts, follow button.

**Social overlay.** Fetch user's kind 3 ∩ roster pubkeys → "you already follow" badges; person view streams their recent notes (kind 1, with NIP-21 mentions, imeta images, link previews — no full thread rendering in v1).

**Direct messages.** Attendee opens a person's profile → Message → NIP-17 conversation view (kind-14 rumor, sealed, double-wrapped: one 1059 to the recipient, one to self). Inbox = subscribe 1059 p-tagging own pubkey → unwrap → keep kind 14 → group by peer, order by rumor `created_at`. Works before/during/after the event and with any NIP-17 client.

**Event updates (organizer).** Admin composes title + markdown → publish kind 30023 signed by `E_id` (`d` stable per update; same `d` = edit, `published_at` preserved). Event page fetches 30023 by author `E_id`, dedupes by `d` (highest `created_at` wins), renders newest-first.

**Revoke attendee.** Organizer sends 21604 `revoke` (or does it client-side without coordinator): delete 31603 (NIP-09), rotate ECK, re-grant 21602 to remaining attendees, republish roster + future content under new ECK.

## 9. Coordinator service

Headless TypeScript/Node daemon (`packages/coordinator`), sharing `packages/protocol` with the PWA. Interface = Nostr only. Runs fine on one small VPS; ffmpeg is assumed present (and is verified at startup).

### 9.1 State: SQLite, loss-tolerant by construction

`better-sqlite3`. Every expensive artifact (transcripts, summaries, LLM profiles, pair scores) is keyed by a content hash of its inputs, so the DB is a **cache/queue whose loss re-costs money but can never corrupt correctness** — a wiped DB re-derives everything from relays + providers. Tables: `events` (coordinate, config snapshot, grants), `attendees`, `submissions` (rumor id, sha256s, status), `jobs` (type, dedupe_key, attempts, state), `transcripts` (blob_sha256 PK → text), `nostr_summaries` (pubkey + inputs_hash → summary), `profiles`, `pairs` (a, b, inputs_hash, score, similarity, complementarity, reasoning), `invite_usage`.

### 9.2 Event loop & pipeline

Subscriptions:
- `{kinds:[1059], "#p":[coordinator_pubkey]}` — install grants (21603), admin commands (21604).
- Per installed event: `{kinds:[1059], "#p":[E_inbox_pubkey]}` (join requests + submissions; coordinator unwraps with the granted `E_inbox` nsec) and `{kinds:[31600,31601], authors:[E_id]}` (config/invite updates).
- All gift-wrap subscriptions use `since = now − 3d` (timestamp randomization) with rumor-id dedupe.

Per-submission pipeline — each stage an idempotent job, dedupe key = hash of stage inputs, exponential-backoff retries (max 5, then poison state surfaced to the organizer):

```
unwrap → entitlement check ──(invite valid & unused)──► auto-grant 21602, mark usage
      │                    └─(else)──► manual queue (organizer approves)
      ▼ (once approved)
publish 31603 (profile text immediately)
      → fetch blob (Blossom GET, verify sha256)
      → decrypt (AES-GCM)
      → ffmpeg: extract audio, mono 16 kHz Opus/OGG, bitrate to fit provider limit
        (25 MB for Venice; segment long talks and concatenate transcripts)
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

- Pair scoring prompt takes both `ai_profile`s + event context (title/summary/hashtags from 31923) and returns strict-JSON `{score, similarity, complementarity, reasoning}`. Scoring must explicitly reward **complementarity** (skills that complete each other for this event's purpose), not just similarity.
- **Incremental:** a new joiner costs exactly N−1 new pair jobs; `pairs` rows are keyed by `inputs_hash = sha256(sorted(profileA_hash, profileB_hash))`, so a *changed* profile invalidates only its own pairs and a restart never re-pays for finished pairs.
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

**v1 adapters — Venice.ai** (`https://api.venice.ai/api/v1`, OpenAI-compatible, `Authorization: Bearer <key>` = `ApiKeyPayment`):
- `VeniceStt`: `POST /audio/transcriptions` (multipart `file` + `model`; 25 MB limit — hence the ffmpeg compression/segmentation stage; models e.g. `openai/whisper-large-v3`, default parakeet).
- `VeniceLlm`: `POST /chat/completions` with `response_format {type:"json_schema", json_schema:{name, strict:true, schema}}` (schema needs `additionalProperties:false`, all props required); `GET /models` at runtime and filter by `supportsResponseSchema`; `POST /embeddings` for the pre-filter. **Model policy:** config flag `venice.require_private: true` restricts selection to models in Venice's private/TEE tiers (only TEE/E2EE are technically enforced; document per §4.2).

**v2 adapters — Routstr** (decentralized, Cashu-paid, OpenAI-compatible nodes):
- `RoutstrLlm`: node base URL from config or discovered via Nostr kind 38421 provider announcements (`u` endpoint tags, `mint` tags); `GET /v1/models` (includes `sats_pricing`) and `GET /v1/info` (accepted mints); `POST /v1/chat/completions` is pass-through OpenAI — structured output works iff the upstream model supports it (verify per node at attach time).
- `CashuPayment`: either balance mode (`Authorization: Bearer <cashu-token>`, node converts to an `sk-` key) or stateless per-request `X-Cashu: <token>` with **change returned in the `X-Cashu` response header** — `settle()` must persist the change proofs (wallet state via `@cashu/cashu-ts`). The operator experience: *fund the coordinator with Cashu tokens, pick a node and model, done.*
- Routstr has **no STT today** (audio endpoints "coming soon"), so STT stays on `VeniceStt` or the optional `LocalWhisperStt` (whisper.cpp spawn) — which is why STT and LLM are **separately configurable**.

**Model routing config:** `summaryModel` (cheap; nostr-context summaries), `matchModel` (strong; profiles + pair scoring), `embedModel`. Each is `{provider, model}` so summaries can run on a cheap Venice model while matching runs elsewhere.

### 9.5 Configuration (`coordinator.toml`, illustrative)

```toml
[identity]        # nsec via env NOSTRAUTICA_COORDINATOR_NSEC, or:
ncryptsec_file = "coordinator.ncryptsec"   # passphrase prompted / env

[relays]
default = ["wss://relay.primal.net", "wss://relay.damus.io"]

[providers.venice]
api_key_env = "VENICE_API_KEY"
require_private = true

[providers.routstr]        # v2
node_url = "https://api.routstr.com/v1"   # or discover = true (kind 38421)
mint = "https://mint.example"
wallet_db = "cashu-wallet.sqlite"

[stt]
provider = "venice-stt"          # or "local-whisper"
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
```

Installation is protocol-level (21603 grant + 31600 `coordinator` tag) — no per-event server configuration.

## 10. Frontend (PWA)

### 10.1 Stack & routing

- SvelteKit, Svelte 5 (runes), `adapter-static` with a single fallback page; **hash-based routing** via a thin hash-router layer (single catch-all route; `location.hash` parsed into a route store; pages under `src/lib/pages/`). Reason: nsite gateways serve the SPA fallback with HTTP **status 404**, which breaks history-API deep links for anything status-sensitive; hash routes sidestep it entirely and work on every static host.
- `@nostr-dev-kit/ndk` v3 + `@nostr-dev-kit/cache-dexie` (IndexedDB cache) + `@nostr-dev-kit/svelte`. Relay set = app defaults ∪ event 31600 relays ∪ user 10002.
- Routes: `#/` (my events + discover), `#/login`, `#/create`, `#/e/:naddr` (event home), `#/e/:naddr/join?code=…`, `#/e/:naddr/record`, `#/e/:naddr/attendees`, `#/e/:naddr/attendees/:npub`, `#/e/:naddr/matches`, `#/e/:naddr/admin`, `#/me`, `#/settings`.

### 10.2 PWA & auto-update (never stuck on an old version)

- `vite-plugin-pwa`, `registerType: 'autoUpdate'` (sets `skipWaiting`/`clientsClaim`), `cleanupOutdatedCaches: true`, `registerSW({ immediate: true })`.
- Periodic update check via `onRegisteredSW`: `fetch(swUrl, {cache:'no-store'})` + `registration.update()` on an interval (60 s while the app is open during an event is fine) **plus** on `visibilitychange` → visible (iOS applies updates on relaunch).
- Classic-host deployment must serve `sw.js`, `index.html`, `manifest.webmanifest` with `no-cache` and hashed `/assets/*` as `immutable`. On nsite, headers are fixed (`max-age=3600` + strong sha256 ETag) — acceptable because browsers bypass the HTTP cache for SW update-check requests by default; the real update-latency floor on nsite is the gateway's manifest re-sync (~minutes).

### 10.3 Video capture & playback

- MediaRecorder; mimeType ladder `video/mp4;codecs=avc1` (Safari) → `video/webm;codecs=vp9,opus` → `video/webm`. Visible countdown; hard-stop at `max_video_sec`/`max_talk_sec`; preview + re-record before submit.
- Encrypt: WebCrypto AES-GCM one-shot in memory (fine for short intros; chunked streaming encryption is a v2 item for large talks — GCM whole-file also means no range-request streaming playback; playback = fetch ciphertext → decrypt → object URL).
- Upload: `blossom-client-sdk` — BUD-06 `HEAD /upload` preflight (size/type acceptance), BUD-02 `PUT /upload` (kind 24242 auth event: `t=upload`, `x=sha256`, `expiration`), BUD-04 `PUT /mirror` to remaining event servers + the user's 10063 servers.

### 10.4 Offline behavior

Dexie cache serves roster, directory entries, matches, and profile metadata offline; ECK + self-keys live in IndexedDB so decryption works offline; decrypted intro videos cached via Cache API (bounded LRU); outgoing events queue and flush on reconnect. Goal: an attendee in a venue with terrible Wi-Fi can still browse people and matches.

### 10.5 UI chrome

- Dark/light: CSS custom properties; default from `prefers-color-scheme`; user override persisted (localStorage mirror → 30078).
- i18n: Paraglide JS (compile-time, static-host-friendly); `en` + `sk` initially.
- Accessibility and mobile-first layout; the primary device at an event is a phone.

## 11. Deployment

- **PWA:** built as fully static output. Primary target: **nsite** — publish with `nsyte deploy` (kinds 15128/35128 manifest + blobs to Blossom; supports NIP-46 bunker signing for CI). `--fallback /index.html` publishes the SPA 404 fallback. Also deploy to a conventional static host (Netlify/Cloudflare/nginx) as mirror; same artifact.
- **Coordinator:** Dockerfile (node + ffmpeg + whisper.cpp optional); single process + SQLite volume; config via `coordinator.toml` + env secrets.
- **Relays/Blossom:** the app defaults to public infrastructure; organizers can point events at their own relay + Blossom server via 31600 for locality/retention control.

## 12. Ticketing & approvals

- **v1:** `approval = manual | invite | manual+invite` (§6.5, §8). Both shipping from day one.
- **Future — Cashu ticketing:** buy a ticket → receive a Cashu token (P2PK-locked to the attendee npub, NIP-61-style; BTCPayServer/mint integration); join request carries `["payment", <cashu-token>]`; the coordinator's entitlement checker redeems it and auto-grants. No protocol change: it is one more checker beside `invite`. Related merged primitives: NIP-60 (relay-stored wallets), NIP-61 (nutzaps). There is **no standard ticketing NIP** — this convention is app-defined and documented here.

## 13. Future features (design-compatible, not in v1)

- **Admission micro-app / QR check-in:** attendee shows a QR of a signed statement (pubkey + coordinate + timestamp); door staff verify offline against the ECK roster.
- **Schedules & unconference:** sessions as NIP-52 (31923 children under a 31924 calendar) or NIP-53 (30312/30313 rooms); grid UI; per-person favorites (already in 30078); **.ics export** of the schedule and of "my favorites"; unconference board = attendee-proposed sessions + voting.
- **Icebreakers:** coordinator emits 2–3 conversation starters per match from the reasoning.
- **"Introduce us":** one-tap DM to a match **pre-filled with the shared reasoning** (plain NIP-17 DMs themselves shipped in v1, §7.2 kind 14; only the reasoning prefill remains future).
- **Meeting slots:** free/busy publication and mutual-match time/table suggestions.
- **Post-event contact export:** consent-gated vCard/npub list of people marked "met".
- **WoT spam filtering:** rank join requests/discovery by follow-graph distance from the organizer.
- **Offline event pack:** one-tap pre-download of roster + matches + intro thumbnails.
- **Match feedback loop:** thumbs up/down (private, 30078) fed into future recomputes.
- **Multi-organizer roles:** scoped grants (approve-only vs full key custody).
- **Chunked media encryption:** streaming playback + >25 MB robustness.

## 14. Security & threat model summary

**Protected:** submission contents pre-approval (only `E_inbox` holders read them); event content from non-attendees; match reasoning from everyone but the pair (default); user-private data from everyone including the coordinator; event impersonation (only `E_id` signs); invite forgery (hash-hidden pubkeys + pubkey-bound signatures).

**Leaks (accepted & documented):** attendee *counts* (directory-entry counts per coordinator); blob-hash linkage across events when reusing intros without "fresh copy"; timing correlation on relays; `E_inbox` p-tags on inbound wraps mark *that* someone submitted (not who — wrap authors are one-time keys). Email backup of nsec traverses email infrastructure (user-chosen trade-off, §5.2).

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
| Custom kind collisions (31600–31609, 21600–21605 unassigned as of 2026-07) | re-check nostr-protocol/nips registry before first release |

---

## 16. Implementation notes & deviations (v1, as built)

This section records concrete decisions and small deviations made while building and running v1 (the sections above remain normative intent; this documents *as-built* reality).

### 16.1 Custom kinds — additions
- **21605 Organizer Grant** (co-organizer full key custody, §7.2).
- **21604 Admin Command** gained an `approve` command (§7.2). Admin commands are sealed by `E_id`.
- Rumor-kind range is now **21600–21605**; re-check the NIPs registry before public release (§15).

### 16.2 Coordinator
- **Store:** Node's built-in `node:sqlite` (Node ≥ 22.5) instead of `better-sqlite3` — same synchronous embedded-SQLite semantics as §9.1 intends, no fragile native build. Requires Node ≥ 22.5 (CI/Docker pin Node 24).
- **Install-time subscription:** on receiving a `21603` grant while already running, the coordinator subscribes to that event's `E_inbox` immediately (idempotently); `since = now − 3d` backfills join requests/submissions published before it was attached.
- **Manual approval with a coordinator:** the organizer's Approve routes through the coordinator via a `21604 approve` command so the directory/roster are authored under the coordinator key (which is where attendees look for them). Without a coordinator, the organizer publishes them signed by `E_id`.
- **Matching:** pair scoring returns **directional reasoning** (`reasoning_for_a` / `reasoning_for_b`); scores are clamped/rescaled to [0,1] defensively. `recompute` clears the pair cache before re-scoring.
- **Venice adapter:** requests set `venice_parameters` `{ disable_thinking:true, include_venice_system_prompt:false, strip_thinking_response:true }` and a higher default `max_tokens` — reasoning models otherwise spend the whole budget on chain-of-thought and return empty content.

### 16.3 Client
- **PWA auto-update:** on detecting a new deploy the app reloads itself (no "click to reload"): `autoUpdate` (skipWaiting + clientsClaim) + a guarded `controllerchange` reload; update checks run every 60s / on focus / on reconnect, fetching `sw.js` with `cache:'no-store'`. Classic hosts that cache `sw.js` aggressively still update because `registration.update()` bypasses the HTTP cache per the SW spec.
- **Relay publish resilience:** a publish succeeds if it reaches ≥1 relay; a global `unhandledrejection` guard swallows expected relay rejections (rate-limited, timeout, PoW, auth-required, duplicate…) so a slow relay's late `OK=false` (NDK orphan-promise) never surfaces as an uncaught error.
- **NIP-46 (Amber) session persistence:** the bunker pointer + client key are stored in IndexedDB and reconnected via `BunkerSigner.fromBunker` on refresh, so remote-signer logins survive reloads. The nostrconnect flow also offers an "Open in Amber" deep link + copy button alongside the QR.
- **Event images:** two optional public (unencrypted) Blossom images — a small **icon** (E_id kind-0 `picture`) and a wide **banner** (31923 `image` / kind-0 `banner`) — with deterministic generated-gradient fallbacks; surfaced via an `EventHeader` used across attendee-facing pages.
- **Navigation:** bottom nav bar; a "My events" list backfilled from the local key store (so events you created/joined always reappear), deduped by event coordinate; a smart Back button (in-app history + contextual-parent fallback); an in-memory event-context cache so event sub-pages render instantly.
- **kind-0 write policy:** see §5.4 item 1 — publish only for self-generated keys; existing users are read-only.
- **CSP (as deployed):** `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'`. `'unsafe-inline'` is allowed so SvelteKit's inline bootstrap and NIP-07 signer extensions work; there is still no external script host and no `'unsafe-eval'` (NDK's tseep emitter is patched to its eval-free variant). No `{@html}` on untrusted content, so inline-script XSS is not a vector.
- **Direct messages (2026-07-13):** NIP-17 kind-14 rumors via the signer-based NIP-59 path (§7.2); inbox route `#/dm`, conversation `#/dm/<npub>`, Message button on attendee profiles. Sent messages double-wrapped (recipient + self).
- **Follow safety + seeded follows (2026-07-13):** §5.4 item 3 empty-list guard enforced in `followUser`; app-generated keys are seeded with a kind 3 containing the event's `E_id` at join/create.
- **Event updates (2026-07-13):** NIP-23 30023 by `E_id` (§7.1); organizer composer in Admin (same-`d` edit), rendered on the event page with escape-then-markdown (organizer-authored, but still never raw `{@html}` of unescaped content).

### 16.4 Reference deployment (cypherpunk.today)
- PWA served at `https://cypherpunk.today/nostrautica/` (built with `BASE_PATH=/nostrautica`).
- Coordinator on Venice: STT `openai/whisper-large-v3`; summary `olafangensan-glm-4.7-flash-heretic`; match `zai-org-glm-5-2`; embed `text-embedding-bge-m3` (all Venice private-tier; `require_private=true`). No Cashu.
