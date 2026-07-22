# Per-event group chat — feasibility study

> **Archived research.** This document records a 2026-07 feasibility decision and
> is superseded for current behavior by `MARMOT-GROUP-CHAT.md`, `SPECIFICATION.md`
> §7.5, and `PROTOCOL-REGISTRY.md`. Only Marmot is currently implemented; NIP-17
> group chat and dual-backend selection are not supported configuration.

Status: research document, 2026-07-14; **revised 2026-07-15 per owner decision** — the
ECK-encrypted web-only chat is dropped (rejected: web-only, §2.5) and NIP-17 group
messages are promoted from "rejected" to a researched first-class option alongside
Marmot. Sources: the Marmot spec repo (restructured 2026, MIP-era docs deprecated),
`marmot-ts` v0.6.0 source (cloned and read, commit of 2026-06-24), merged NIP-EE
(`nips/EE.md`, merged 2025-08-27), NIP-17/28/29/46/59 texts (fetched from master
2026-07-14/15), the nostrability DM-interop tracker (issue #169) and client source
(Amethyst/Quartz, 0xchat-core — fetched 2026-07-15), Whitenoise public materials, and
this codebase (`packages/protocol`, `packages/app/src/lib/signer`,
`packages/app/src/lib/events/giftwrap.ts`, spec §5–§7). Facts marked *(unverified)*
could not be confirmed against primary sources and must be checked at implementation
time.

---

## 1. Summary & recommendation

**Recommendation: two chat options, choosable per event by the organizer — either or
both.**

1. **NIP-17 group messages** (kind-14 rumors with multiple `p` tags, gift-wrapped per
   NIP-59 — the exact machinery our 1:1 DMs already use; full analysis in §2.2). Zero
   new kinds, zero new dependencies, zero new trust; a group started in Nostrautica is
   a *standard* NIP-17 room living on the attendees' own DM relays, independent of this
   app. Its honest limits are hard ones: the spec itself says groups with **more than
   10 participants** "should find a more suitable messaging scheme"; the room's
   identity IS the exact member set, so **every roster change forks the conversation**;
   and a NIP-46 (Amber) sender pays 2 serial remote round-trips per member per message.
   Group (as opposed to 1:1) support in other clients is thin — verified today
   essentially **Amethyst and Nostria**, with 0xchat *unconfirmed* (§2.2 matrix).
   Right-sized for **small events and spawned subgroups (roughly ≤ 10–20 people)**, not
   for a 200-person conference chat.

2. **Marmot (MLS over Nostr)** as the durable, event-scale chat, built on `marmot-ts`,
   with **the coordinator acting as the group's admin bot** (it is the only long-lived,
   stateful actor we have; membership automation is impossible client-side-only unless
   the organizer keeps a tab open). Marmot is the only option that scales to conference
   size AND satisfies the mobile-continuity goal — *the chat keeps living in a mobile
   app with push notifications after people stop opening the web app* — because
   Whitenoise ships MIP-05 push (live on iOS) and the group is client-independent at the
   protocol level. Ship it as an **experimental opt-in per event**, clearly labelled,
   because `marmot-ts` is alpha ("do not use in production yet", its own README) and
   there is **no production-grade web Marmot client anywhere yet** — we would be the
   first.

3. **Per-event choice: one config tag, not a plugin framework.** `chat` tags on the
   kind 31600 config — values `nip17` and `marmot`, absent = no chat, **both tags
   allowed** when the organizer offers both. The tag is needed anyway (Marmot requires
   an attached coordinator; NIP-17 doesn't). A generic pluggable chat abstraction
   beyond that is overengineering — the two backends share almost no code below the
   message-list UI. Spec stub: SPECIFICATION.md §7.5 (planned, not built).

4. **Rejected: ECK-encrypted web-only chat** (previously this document's phase 1 —
   owner decision 2026-07-15, kept for the record in §2.5): a chat readable only inside
   the Nostrautica web app fails the product goal by construction — post-conference
   chats must survive in the clients attendees already use. **Reject** NIP-28
   (deprecated in favor of NIP-29, plaintext, no membership), **defer** NIP-29 (healthy
   in 2026, good mobile clients, but requires running dedicated relay software per
   group, messages are plaintext to that relay, and it adds a new trusted party —
   reconsider only if an organizer explicitly wants relay-moderated public-ish chat).

**The critical multi-client answer, up front (details in §3):** joining the event's
Marmot group in the Nostrautica web app does **not** make the group appear in Whitenoise
on the same npub. MLS state is strictly per-client; NIP-EE says verbatim that a user on
two clients is tracked as **two separate group members**. The workable UX is: every
client/device of an attendee is added to the group as its own MLS leaf (our coordinator
can automate this by watching for key packages from enrolled npubs), and each
client only sees messages **from the moment it was added** — MLS forward secrecy makes
history sync impossible by design. This is workable, but it must be designed for from
day one; it is not a bug we can fix later.

---

## 2. Option analysis

### 2.1 Marmot protocol via `marmot-ts` (MLS over Nostr)

**What it is.** MLS (RFC 9420) group key agreement carried over Nostr events. The living
spec is the restructured `marmot-protocol/marmot` repo (the numbered MIP-00…06 documents
are deprecated; content now lives in `foundation/`, `protocol-core/`, `transports/`,
`features/`). NIP-EE was merged into the nips repo in August 2025 but is now effectively
a stale snapshot of the same protocol; one wire-format divergence matters to us (below).

**Wire shape.**
- **Key package**: a Nostr event signed by the user's identity key advertising an MLS
  init key + leaf material. Merged NIP-EE says kind **443** (+ kind 10051 key-package
  relay list); the current Marmot spec and `marmot-ts` use **kind 30443 addressable**
  key packages published to the user's NIP-65 relays, with kind **10050** inbox relays.
  This skew is real (verified in `marmot-ts/src/core/protocol.ts`:
  `ADDRESSABLE_KEY_PACKAGE_KIND = 30443`). What Whitenoise emits on the wire today is
  *(unverified)* — interop-test before committing.
- **Welcome**: unsigned kind **444** rumor, NIP-59 gift-wrapped (kind 1059) to the
  invitee — exactly the wrap construction we already implement in
  `packages/app/src/lib/events/giftwrap.ts`.
- **Group messages**: kind **445**, content encrypted with a key derived from the MLS
  `exporter_secret` (rotated every epoch), **signed by a fresh ephemeral keypair, never
  the user's identity key**. This is a huge property for us: *sending and receiving chat
  messages requires zero signer interaction* — the signer is touched only at join time.
- **Admin model**: admin authority is attached to Nostr identity (npub), not MLS leaf,
  via the `marmot.group.admin-policy.v1` app component in the authenticated group
  context. Adds/removes/settings changes are admin-gated commits.

**`marmot-ts` v0.6.0 assessment** (repo cloned and read):
- **API**: `new MarmotClient({ signer, network, groupStateStore, keyPackageStore, clientId })`
  exposing `client.groups` (`create/load/invite/send/leave`), `client.keyPackages`
  (`create/rotate/watch` — publishes kind 30443), `client.invites`
  (`ingestEvent/decryptGiftWraps/getUnread`), `client.joinGroupFromWelcome()`,
  per-group `group.ingest(events)` + `group.on("applicationMessage", …)`. Clean, small,
  async/await.
- **Signer requirement — fits our `AppSigner` almost exactly.** It takes an
  applesauce-core `EventSigner` (`getPublicKey`, `signEvent`, `nip44Encrypt`,
  `nip44Decrypt`) — the same four methods as `packages/app/src/lib/signer/types.ts`. It
  never needs the raw nsec: key packages are signed via `signer.signEvent`, welcomes are
  unwrapped via `signer.nip44Decrypt`, and kind-445 messages use ephemeral keys
  internally (`src/core/group-event.ts`: `finalizeEvent(draft, generateSecretKey())`).
  **NIP-46 works** — with one caveat: the optional `accountProofSigner` (signs the
  `marmot.account-identity-proof.v1` leaf extension) needs raw BIP-340 access that
  NIP-46 cannot provide. `marmot-ts` works without it, but **darkmatter (the Rust
  reference implementation) validates the proof on every leaf** — so a NIP-46 user's
  leaf may be rejected by strict clients. Whether Whitenoise enforces it is
  *(unverified)* and is a mandatory interop test.
- **Browser/PWA compatibility: good.** Pure TypeScript, no WASM, no Node-only APIs;
  crypto is @noble/* (same family we already ship via nostr-tools); explicitly supports
  browsers. No CSP change needed (we already allow `wasm-unsafe-eval`, but it isn't
  required). Transport-agnostic: we implement a 4-method `NostrNetworkInterface`
  (`publish/request/subscription/getUserInboxRelays`) over NDK — an example adapter
  exists in their repo (`examples/opentui/src/helpers/relay-pool.ts`).
- **Storage**: pluggable `GenericKeyValueStore<T>` (get/set/remove/clear/keys). We back
  it with IndexedDB (Dexie table or localforage). Must persist: serialized MLS
  `ClientState` per group (ratchet tree, epoch secrets, exporter secret) and key-package
  private material. **Losing this state is fatal for that client**: it can no longer
  decrypt anything and cannot self-recover — it must be re-welcomed by an admin. On the
  coordinator (Node), state goes in its SQLite alongside everything else — but note this
  broke the previous "DB loss only re-costs money" claim (§9.1): losing
  the coordinator DB now loses group admin/membership state. Back it up, and always have
  a second (human, mobile-client) admin.
- **Bundle**: est. ~300–400 KB gzipped incl. ts-mls + @noble deps. Acceptable if
  lazy-loaded (`import()` the chat module only on events with `chat=marmot`).
- **Maturity — the honest part.** Alpha; README: breaking changes without notice, "do
  not use in production yet". v0.6.0, active (last commit 2026-06-24), 62 test files,
  and a candid `SPEC_GAP_REVIEW.md`: encrypted media (MIP-04) incomplete, several
  hardening gaps (e.g. no explicit welcome-recipient binding, kind-445 sig-check-before-
  decrypt not done at the core layer), **multi-device (MIP-06) entirely absent**, push
  (MIP-05) absent (irrelevant for us — push is the mobile client's job). MLS engine is
  `ts-mls`, a from-scratch TypeScript MLS — far less battle-tested than OpenMLS.
- **Ecosystem**: Whitenoise (Flutter, Rust core; iOS TestFlight + Android
  Zapstore/APK, iOS push live with on-device decryption), 0xchat (implemented NIP-EE),
  Amethyst integrated MDK (April 2026), Pika, Vector. **No production web/PWA Marmot
  client exists** — we'd be first, with everything that implies.

**Fit for Nostrautica**: the only option delivering post-event mobile continuity +
E2EE + real membership revocation (an MLS Remove actually locks the removed member out
of *future* messages — strictly stronger than our forward-only ECK rotation). Costs:
alpha dependency, MLS state fragility in browser storage, coordinator becomes a chat
admin bot and a group member (it reads the chat — consistent with §4.2, but must be
disclosed in the UI the same way matchmaking is), and the multi-client model of §3.

### 2.2 NIP-17 gift-wrapped group messages

**What it is.** NIP-17 "chat rooms": a kind-14 rumor whose `p` tags name **all**
receivers, sealed (kind 13, signed by the true author) and gift-wrapped (kind 1059,
fresh ephemeral key) **separately to every receiver and to the sender** — byte-for-byte
the construction our 1:1 DMs already ship (`packages/app/src/lib/events/giftwrap.ts`,
spec §7.2). Current spec text (master, fetched 2026-07-14), the load-bearing lines
verbatim:

- Room identity: *"The set of `pubkey` + `p` tags defines a chat room. If a new `p`
  tag is added or a current one is removed, a new room is created with a clean message
  history."* There is **no group identifier** — deliberately (*"No Public Group
  Identifiers"* is listed as a privacy benefit).
- Naming: *"An optional `subject` tag defines the current name/topic of the
  conversation. Any member can change the topic by simply submitting a new `subject`
  to an existing `pubkey` + `p` tags room."* Newest wins; any member can rename.
- Size guidance: *"The main limitation of this approach is having to send a separate
  encrypted event to each receiver. Group chats with more than 10 participants should
  find a more suitable messaging scheme."* **The cap is 10, straight from the spec** —
  this document's earlier "~10" was accurate.
- Also in the current spec: kind-15 file messages and kind-7 reactions may be sent to
  a room; kind 10050 lists DM inbox relays and clients *"MUST only publish events to
  the relays listed in the recipient's kind 10050 event"* — no 10050, no delivery.
- Spec churn check (2025–2026 commit history): kind-15 files, `q` tags, reactions,
  10050 MUST, delete/edit/disappearing messages were merged; **no merged change to the
  group semantics** — the p-set room model and the 10-participant line are unchanged.
  Active proposals (PRs #1647 NIP-4E, #2361, #2397) all attack wrapper-key/remote-
  signer cost, not group scale; larger groups keep being pointed at MLS.

**Membership semantics — the p-list IS the group, per message.** There is no join, no
leave, no admin, no membership event. "Adding" a member = senders start including their
`p` tag (the newcomer sees **no history** — nothing was ever encrypted to them);
"removing" = senders stop including them (they keep everything they received, and
nothing stops them wrapping messages to the stale list). Crucially, per the spec text
above, **any change to the member set is a NEW room with clean history** in conforming
clients. Verified in Amethyst's source: rooms are keyed by
`ChatroomKey(users: Set<HexKey>)` — the participant set and nothing else (subject is
*not* part of the key; changing it renames in place, changing the p-list forks). For a
fluctuating event roster this is the killer UX fact: **every approval or revocation
forks the event chat into a fresh conversation** in attendees' apps, with the old one
going quiet. Workable policies: freeze the p-list at chat spawn (late joiners get the
*next* spawned room), or batch roster changes into deliberate, announced "chat v2"
forks. Pretending the roster can flow through continuously is not an option.

**Client interop matrix — the load-bearing finding.** "Will a conference group chat
started in Nostrautica show up in attendees' daily apps, with notifications?" Verified
per client (primary sources: client source code, README NIP lists, and the
nostrability DM-interop tracker, github.com/nostrability/nostrability issue #169,
checked 2026-07-15):

| Client | Platform | 1:1 NIP-17 | **Group** (multi-p 14) receive/reply | Create group | `subject` | DM push | Evidence |
|---|---|---|---|---|---|---|---|
| **Amethyst** | Android | yes | **yes** — Quartz `nip17Dm` pkg; `reply()` re-targets the full recipient set | yes (protocol verified; UI multi-select inferred) | **yes** (`changeSubject`, `NewChatroomSubjectDialog`) | yes (Google + UnifiedPush) | Quartz source: `ChatMessageEvent.kt`, `ChatroomKey.kt`, `TagArrayBuilderExt.kt` |
| **Nostria** | web/Windows | yes | **yes** — documents "NIP-17 groups", `computeGroupChatId()` (participant-set hash) | yes | *(unverified)* | *(unverified)* | nostrability #169 |
| **0xchat** | iOS/Android | yes | **unconfirmed — likely no.** Its "private groups" are a custom kind 40/41/42 gift-wrap scheme (own `doc/privateGroup.md`), now migrating to MLS; code modules for DMs vs. private groups are disjoint. nostrability #169 flags 0xchat under "groups", but that almost certainly refers to this custom scheme. **Live test required before promising anything.** | no (custom scheme) | no evidence (kind-40/41 `name` instead) | yes (custom push) | 0xchat-core source + `doc/privateGroup.md`; nostrability #169 |
| **Damus** | iOS | **no** — NIP-04 only in production; NIP-17 PRs in progress (#3590 closed, #3667 open) | no | no | — | yes (1:1 legacy) | nostrability #169 |
| **Primal** | all | no (NIP-04 only; no 13/14/1059/10050) | no | no | — | — | nostrability #169 |
| **Coracle / Flotilla** | web | no by stance — hodlbod calls NIP-17 "evil", plans MLS; Flotilla is relay-based (NIP-29-style) groups | no | no | — | — | nostrability #169; coracle-social/flotilla |
| **Snort, Nostur, notedeck, Wisp** | various | yes (per tracker) | *(unverified — no group evidence)* | *(unverified)* | *(unverified)* | varies | nostrability #169 |
| **Yakihonne** | web/mobile | unclear (NIP-04 confirmed; "secure DM" toggle) | no evidence | no | no evidence | UnifiedPush (DM path unverified) | YakiHonne READMEs; nostrability #169 |
| **Whitenoise** | iOS/Android | **no** — Marmot/MLS only, no kind-14 code path | no | no | — | yes (MLS/MIP-05) | parres-hq/whitenoise README, NIP-EE |

**Honest bottom line on interop:** NIP-17 *1:1* interoperates broadly (Amethyst,
0xchat, Snort, Nostur, notedeck, Nostria, …) — that story is real and we already ride
it. NIP-17 *groups* interoperate today between **Amethyst and Nostria, full stop**,
pending a live 0xchat test. For our audience (Amber/Android-heavy, Amethyst common)
that is meaningfully better than web-only — the room genuinely lives on in the
attendee's daily driver with push — but it is nowhere near the 1:1 story, and iOS
attendees (Damus/Primal) see nothing. Interop must be promised as "continues in
Amethyst and other NIP-17-group clients", not "works everywhere".

**Scaling math, honestly.** Per message to a room of N members (sender's copies
included: one wrap per receiver + one to self), the sender performs N × (2 NIP-44
encrypts + 2 Schnorr signs) plus N publishes of ~1.5–2.5 KB each; a receiver pays 2
NIP-44 decrypts per incoming message. Of those, exactly the seal's encrypt + sign go
through the user's signer (the wrap layer uses a local ephemeral key — see
`signerWrap`). So:

- **Local-key / NIP-07 users:** crypto is negligible (well under a second even at
  N=200). The real sender costs are bandwidth (N=200 ⇒ ~300–500 KB uploaded *per
  message*) and relay behavior — publishing hundreds of 1059s per message, per sender,
  into each recipient's 10050 relays will meet rate limits, and PR #686's critique
  stands: data volume is O(participants × messages). Receiving is cheap.
- **NIP-46 (Amber) users:** each copy costs **2 serial remote round-trips**
  (`nip44_encrypt` + `sign_event:13`) at ~0.5–2 s each over the signer relay. Realistic
  send ceilings — N=10: ~20 RTs ≈ 10–40 s; **N=20: ~40 RTs ≈ 30–80 s**; N=50: ~100 RTs
  ≈ 2–3 min; N=200: ~400 RTs ≈ 7–13 min. On mobile the tab backgrounds behind the
  signer app and the kind-24133 reply sockets drop (the exact fragility fought in
  `0cf4062`) — a multi-minute serial chain **will** break in practice. Reading hurts
  too: 2 remote decrypts per incoming wrap means a 100-message day costs ~200 Amber
  round-trips just to render the room (the O(n) remote-decrypt pain of nips issue
  #2160, and why PRs #1647/#2361/#2397 exist).
- **Cost asymmetry, stated plainly:** a local-key member and an Amber member sit in
  the same room with ~100× different send/read costs. A group is only as usable as its
  worst-signer member — and our onboarding funnel deliberately produces NIP-46 users.

**Viable-size verdict.** The spec's own cap of 10 is about right for mixed-signer
rooms; with patience and mostly-local keys perhaps 15–20. **Viable:** small events
(a dinner, a workshop, a ≤20-person meetup) and **spawned subgroups** of a larger
event — topic tables, session groups, match clusters of ≤10, all derivable from the
roster and match data we already have (match-pair 1:1 intro DMs already exist, spec
§13 "Introduce us"). **Not viable:** one big chat for a 50–500-person conference —
that is Marmot's job (§2.1). The UI must enforce this: refuse (or at minimum scream)
above ~20 members, and offer subgroup spawning instead.

**Other properties.** No FS/PCS (a compromised key reads all past wraps it received —
same as our 1:1 DMs); metadata-private (ephemeral wrap authors, randomized timestamps,
no group identifier — strictly better event-privacy than any public-channel scheme);
spam/abuse: anyone who learns the member list can wrap into the room, and any member
can "rename" it via `subject` — acceptable at ≤20 trusted attendees, unacceptable at
conference scale. Delivery requires each recipient to have a kind 10050 (we must
publish one for app-generated keys — same open question as Marmot's, §7 Q2).

**Verdict: adopt, correctly scoped** — as the small-event / subgroup chat option,
promoted per event via `chat=nip17`, never as the flagship conference-wide chat.

### 2.3 NIP-28 public chat channels

Marked deprecated/unrecommended in favor of NIP-29; plaintext; client-side-only
moderation; no meaningful development since. **Rejected.**

### 2.4 NIP-29 relay-based groups

Alive and reasonably healthy in 2026: reference relay `relay29` (Khatru-based; a stock
relay won't do), public group relays exist (`groups.0xchat.com`, `groups.fiatjaf.com`),
clients 0xchat, Chachi, Flotilla (partial), Nostrord. Relay-enforced membership (kind
9000-series moderation events) maps nicely onto our roster, and the coordinator could
drive add/remove via admin events. Mobile continuity and notifications via 0xchat are
real. But: **messages are plaintext to the relay** (privacy = relay AUTH, not E2EE — a
new trusted party seeing all chat content, worse than our current trust envelope), and
each group lives on a specific NIP-29 relay someone must run or rent. For a
privacy-first event app whose encrypted tier hides even attendance, shipping the chat
plaintext to a third-party relay is a hard sell. **Deferred** — a reasonable future
third backend for events that explicitly want open community chat.

### 2.5 ECK-encrypted chat — REJECTED (web-only), kept for the record

An earlier revision of this document recommended shipping this first: a custom regular
kind, outer event signed by a fresh ephemeral key, blinded `h` topic tag, content
NIP-44-encrypted under the event's ECK with a signed inner rumor. It reused existing
key distribution (21602), worked for the whole login ladder, and cost ~a week to build.

**Owner decision 2026-07-15: rejected.** Its disqualifying property was always in the
text: the chat exists **only inside Nostrautica and only while people open the web
app** — no interop, no notifications beyond an in-app badge. Post-conference chats must
survive in the clients attendees already use daily; a web-only chat fails that by
construction, and shipping it first would have anchored users to the wrong thing. The
design is preserved in git history should a "during-the-event-only" scratch chat ever
be wanted; it is not on any roadmap.

---

## 3. The multi-client question: Nostrautica web + Whitenoise, same npub

**Definitive answer: no, the group does not follow the npub.** It follows the client.

Why, mechanically:

1. **Key packages are per-client.** Each client generates its own MLS signing keypair
   and publishes its own key package (the npub is only the credential *inside* the
   leaf). `marmot-ts` even asks for a stable `clientId` to namespace its kind-30443
   d-tag slot.
2. **Group membership is per-leaf.** NIP-EE, verbatim: *"It is not possible to share
   group state across multiple Clients. If a user joins a group from 2 separate devices,
   their state is separate and they will be tracked as 2 separate members of the
   group."* Marmot inherits this.
3. **MLS state never syncs.** Ratchet secrets are deliberately unexportable-in-practice
   (forward secrecy = delete keys after use). There is no mailbox Whitenoise could read
   to discover a group the web client joined; a fresh client can't even *see* that the
   group exists, let alone decrypt kind-445 traffic.
4. **The multi-device spec is a non-implementable draft.** `features/multi-device.md`
   (successor of MIP-06: new leaf under the same identity via External Commit + pairing
   PSK + kind-450 identity proof) states its byte-level definitions "MUST NOT be
   implemented for interop yet", and `marmot-ts` implements none of it. Even that draft
   scopes **history sync out** — a new device never decrypts epochs before it joined.

**So what's the actual UX?** The workable pattern — and the one Whitenoise itself
reportedly uses for its own multi-device story ("each device a distinct participant",
*(unverified)* against their source) — is **every client is a separate member**:

- Attendee uses Nostrautica web → web client's leaf is in the group.
- Attendee later installs Whitenoise on the same npub → Whitenoise publishes its own key
  package → **someone with admin rights must add that leaf** → a welcome (1059→444)
  arrives → the group appears in Whitenoise → messages are readable **from that epoch
  forward only**. Earlier chat history is cryptographically unavailable to the new
  device, forever. UI-wise, clients display leaves deduped by npub, so the roster looks
  normal.
- Our coordinator can fully automate the "someone must add" step: subscribe to key
  packages (kind 30443/443) authored by enrolled npubs; on a new one, issue an Add
  commit + welcome. That turns "open Whitenoise once" into the entire migration
  procedure from the attendee's perspective.

**Consequences for the product goal** (post-conference chat surviving in mobile apps
with notifications):

- Achievable, but only if attendees get a *mobile Marmot client's leaf* into the group
  before they abandon the web app. The end-of-event "your Nostr profile is ready"
  hand-off screen (§5.4) is the natural place: "install Whitenoise, sign in with your
  key, and this chat moves to your phone — with notifications."
- Messages posted before their phone joined won't be on the phone. Communicate this;
  don't fight it.
- If the web client's IndexedDB is evicted (Safari is aggressive with non-installed
  PWAs), the web leaf goes deaf; the same coordinator auto-re-add loop heals it (web app
  detects undecryptable state → publishes a fresh key package → gets re-welcomed →
  history gap). State loss and multi-device are the *same mechanism*, which is why the
  auto-add bot is non-negotiable, not a nice-to-have.
- Residual interop risks, to be tested before promising anything publicly: the
  443-vs-30443 wire skew between merged NIP-EE and current Marmot (which one Whitenoise
  speaks today is unverified); and the `account-identity-proof` leaf extension that
  NIP-46 users cannot produce and darkmatter-style validators may reject (§2.1).

---

## 4. Membership mapping, admin automation, NIP-46 users

**Who is admin?** MLS/Marmot requires an admin to add and remove members. With no
backend, the only always-on candidate is the **coordinator** — which is already
organizer-chosen trusted infrastructure that reads all event content (§4.2). Design:

- At event creation (when `chat=marmot` and a coordinator is attached), the coordinator
  creates the group; admins = coordinator npub + organizer npub(s). Group relays = the
  event's 31600 relay list.
- **Approval → membership**: on granting 21602 (manual approve or invite auto-approve),
  the coordinator looks up the attendee's key package; if none exists, the web app
  publishes one during the join flow (so by approval time it's there). Add commit +
  welcome follow automatically. New key packages from already-enrolled npubs → auto-add
  (the multi-device/heal loop of §3).
- **Revoke** (21604 `revoke`): coordinator removes *all leaves* belonging to that npub —
  and unlike ECK rotation this is real PCS for the chat.
- **No coordinator** → no Marmot chat for that event (organizer's browser tab can
  technically admin via `marmot-ts`, but adds then only happen while the tab is open —
  a support nightmare; NIP-17 chat remains available, being coordinator-free). This
  coupling is another reason the `chat` config tag must exist.
- Disclosure: the chat settings UI must say the coordinator operates and can read the
  group chat, mirroring the existing matchmaking disclosure.

**NIP-46 (Amber) users**, per flow:
- *Key package publish*: one `sign_event:30443` (and/or 443) — add to `DEFAULT_PERMS`.
- *Welcome unwrap*: two `nip44_decrypt` round-trips, once per group join. Fine.
- *Chatting*: **zero signer traffic** (ephemeral-key signing, exporter-secret
  decryption, all local). This makes Marmot *dramatically better* for NIP-46 users than
  NIP-17 groups (2 remote round-trips per member per sent message, 2 per received —
  §2.2 scaling math). If an event enables both chat options, the UI should steer
  NIP-46-heavy audiences toward the Marmot chat for anything beyond small rooms.
- *Caveat*: no `accountProofSigner` possible → leaf lacks the identity-proof extension →
  possible rejection by strict validators (§2.1, open question 3).

## 5. Notifications

- **Web PWA**: realistically none. Web Push requires an application server to POST to
  push endpoints; we have no backend, and a service worker cannot hold a relay
  WebSocket. In-app (tab open) live updates + badge only. (Future idea, out of scope:
  the coordinator could act as an opt-in web-push sender — it's a daemon that can do
  HTTPS — with subscriptions registered via encrypted Nostr events; iOS additionally
  requires the PWA installed to home screen. Real work, privacy-sensitive, later.)
- **Marmot**: notifications are the mobile client's job and they exist — Whitenoise
  ships iOS push with on-device decryption (Apple sees a delivery, not content); Android
  via its own channels *(mechanics unverified)*. This is the payoff of §3's "get a
  mobile leaf into the group" UX.
- **NIP-17 groups**: in our web app, nothing outside the open tab — but the room is
  standard NIP-17, so members on **Amethyst get real push** (Google/UnifiedPush) for
  the group, today. That, not our tab, is the NIP-17 notification story.
- **NIP-29**: native-client notifications (0xchat) — decent, if we ever add it.

## 6. Pluggable per-event protocol — worth it?

`["chat", "nip17"]` / `["chat", "marmot"]` tags on 31600 (absent = no chat; `marmot`
valid only with a coordinator; **both tags allowed** when the organizer offers both —
e.g. Marmot as the event-wide chat plus NIP-17 for spawned subgroups): **yes** — it's
~20 lines in `packages/protocol/src/config.ts` and honest UI copy, and the capability
difference between backends forces a switch anyway. Spec stub: SPECIFICATION.md §7.5.

A *generic* chat-plugin abstraction (interface all backends implement, third-party
backends, per-event negotiation): **overengineering**. The backends share only the
message-list UI; their membership, crypto, storage and failure models are disjoint.
Build two concrete implementations behind one Svelte component and one config tag; if a
third backend ever lands (NIP-29), extract the interface then, when there are three
data points instead of guesses.

## 7. Open questions

1. **Wire-format skew**: does shipping Whitenoise consume kind-30443 addressable key
   packages (current Marmot spec, marmot-ts) or kind-443 (merged NIP-EE)? Interop test
   is step zero of Phase 2; if they diverge, we may need to publish both.
2. **Relay lists**: Marmot expects kind 10050 inbox relays for welcome delivery, and
   NIP-17 now says clients "MUST only publish to the recipient's 10050 relays" — no
   10050, no group messages either; we publish 10002 only (§5.4). Publish a 10050 for
   app-generated keys? For existing users without one?
3. **`account-identity-proof`**: does Whitenoise reject leaves without it? If yes,
   NIP-46 users can't interop-chat until the proof gets a NIP-46-compatible signing path
   (upstream conversation to have with the Marmot folks).
4. **Browser state durability**: how bad is IndexedDB eviction for our audience in
   practice (Safari non-installed PWAs)? Does the heal loop (§3) make it tolerable?
5. **Relay retention of kind 445**: public relays may prune; do event relays (31600)
   suffice as group relays for a multi-month post-event chat? Organizer-run relay
   recommendation?
6. **Admin lifecycle after the event**: coordinators get decommissioned. Promote the
   organizer's mobile client to admin before shutdown? Keep a slim "chat-admin-only"
   coordinator mode running?
7. **marmot-ts API churn**: alpha, breaking changes promised. Pin hard, vendor if
   needed, budget for rework before their v1.
8. **0xchat live test** (NIP-17): does current 0xchat render an incoming multi-p
   kind-14 conversation as a group at all, or mis-thread it as 1:1s? Its code suggests
   the latter (§2.2). The answer decides whether the interop promise names 0xchat.
9. **Roster-fork policy** (NIP-17): freeze the p-list at chat spawn vs. batched,
   announced "chat v2" forks on roster change (§2.2 membership semantics). Owner call —
   it's pure UX policy, the protocol allows only forking.
10. **Group scale**: MLS handles hundreds of members fine cryptographically; commit
   traffic on flaky venue Wi-Fi with ~200 members × multiple devices is untested in any
   web client. Load-test.

## 8. Phased implementation plan

**Phase 1 — NIP-17 group chat (~1–2 dev-weeks)**
`chat` tag in protocol config + schemas; generalize `sendDm`/`fetchDms`/`threadsOf`
(`packages/app/src/lib/events/dm.ts`) from single-peer to participant-set rooms keyed
Amethyst-style (set of pubkeys), honoring `subject`; roster→p-list derivation with the
chosen fork policy (§7 Q9); member-count guard (~20 hard, 10 advisory per spec) +
subgroup spawning from matches; 10050 publication/lookup (§7 Q2); batching + progress
UI for NIP-46 fan-out sends; `#/e/:naddr/chat` page reusing DmChat UI; Dexie offline
cache; i18n (en+sk). No coordinator changes, works for coordinator-less events. Gate:
a live interop test against Amethyst (and 0xchat, §7 Q8) before the interop promise
goes in any UI copy.

**Phase 2 — Marmot chat, experimental opt-in (~4–7 weeks)**
1. *Spike + interop test (1 wk)*: marmot-ts in the browser against Whitenoise on a
   phone — join, message both directions, second-device add, NIP-46 leaf acceptance.
   **Go/no-go gate**; answers open questions 1–3.
2. *Protocol/plumbing (1–2 wks)*: `NostrNetworkInterface` over NDK; Dexie-backed
   stores namespaced per npub; `AppSigner`→`EventSigner` shim; key-package publish in
   join flow; 10050 handling; lazy-loaded chat module.
3. *Coordinator admin bot (1–2 wks)*: group create on attach; add-on-approve;
   auto-add new key packages of enrolled npubs; remove-on-revoke; MLS state in SQLite +
   backup story; second-admin (organizer) enrollment.
4. *UX + hardening (1–2 wks)*: chat UI on marmot events; state-loss detection + heal
   loop; "move this chat to your phone" hand-off card at event end; coordinator-reads-
   chat disclosure; e2e tests against local relay infra.

**Phase 3 — later**: web-push-via-coordinator investigation; MIP-06 multi-device
pairing when the draft stabilizes (removes the "second device sees no history before
join" *re-add* step, though never the history gap); NIP-29 backend if demanded;
encrypted media in chat once marmot-ts finishes MIP-04.

---

*Bottom line*: two interoperable chats, each honest about its lane. NIP-17 groups are
cheap to build (we already ship the machinery for 1:1), live on in Amethyst/Nostria
with real push, and are strictly a **small-room** tool — ≤10 per the spec, ~20 at the
outside, forking on every roster change. Marmot — coordinator as admin bot,
experimental label, §3 multi-client UX designed in — is the only event-scale option
and the real bearer of the "chat survives in attendees' daily apps" promise. The
organizer picks either or both per event; web-only chat is off the table.
