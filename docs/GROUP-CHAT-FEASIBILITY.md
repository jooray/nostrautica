# Per-event group chat — feasibility study

Status: research document, 2026-07-14. Sources: the Marmot spec repo (restructured 2026,
MIP-era docs deprecated), `marmot-ts` v0.6.0 source (cloned and read, commit of
2026-06-24), merged NIP-EE (`nips/EE.md`, merged 2025-08-27), NIP-17/28/29/46 texts,
Whitenoise public materials, and this codebase (`packages/protocol`,
`packages/app/src/lib/signer`, spec §5–§7). Facts marked *(unverified)* could not be
confirmed against primary sources and must be checked at implementation time.

---

## 1. Summary & recommendation

**Recommendation: two chats, phased.**

1. **Phase 1 — ship an ECK-native event chat now.** A custom regular kind whose content
   is NIP-44-encrypted under the existing Event Content Key. It reuses the key
   distribution we already have (21602 grants), works identically for local-key, NIP-07
   and NIP-46 users, needs no new infrastructure, no new trust, and roughly a week of
   work including UI. Its honest limits: no forward secrecy beyond ECK rotation
   (identical to the rest of the event-encrypted tier, §4.2), readable only inside
   Nostrautica, and it effectively dies when people stop opening the web app.

2. **Phase 2 — add Marmot (MLS over Nostr) as the durable, interoperable chat**, built
   on `marmot-ts`, with **the coordinator acting as the group's admin bot** (it is the
   only long-lived, stateful actor we have; membership automation is impossible
   client-side-only unless the organizer keeps a tab open). Marmot is the only option
   that satisfies the actual product goal — *the conference chat keeps living in a
   mobile app with push notifications after people stop opening the web app* — because
   Whitenoise ships MIP-05 push (live on iOS) and the group is client-independent at the
   protocol level. Ship it as an **experimental opt-in per event**, clearly labelled,
   because `marmot-ts` is alpha ("do not use in production yet", its own README) and
   there is **no production-grade web Marmot client anywhere yet** — we would be the
   first.

3. **Per-event choice: yes, but as one config tag, not a plugin framework.** A `chat`
   tag on the kind 31600 config (`none | eck | marmot`, extensible) is needed anyway
   (Marmot requires an attached coordinator; ECK chat doesn't). A generic pluggable chat
   abstraction beyond that is overengineering — the two backends share almost no code
   below the message-list UI.

4. **Reject** NIP-17 group DMs (spec itself caps sensible size at ~10 members; per-message
   fan-out is one gift wrap per recipient, which for a NIP-46 user means hundreds of
   serial Amber round-trips per sent message), **reject** NIP-28 (deprecated in favor of
   NIP-29, plaintext, no membership), **defer** NIP-29 (healthy in 2026, good mobile
   clients, but requires running dedicated relay software per group, messages are
   plaintext to that relay, and it adds a new trusted party — reconsider only if an
   organizer explicitly wants relay-moderated public-ish chat).

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
  breaks the coordinator's current "DB loss only re-costs money" property (§9.1): losing
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

### 2.2 NIP-17 gift-wrapped group DMs

NIP-17 supports rooms (kind 14 rumor with multiple p-tags) and we already ship the 1:1
version. But: one gift wrap **per recipient per message** (sender pays N seals + N wrap
encryptions; for NIP-46 that is N `sign_event` + 2N `nip44_encrypt` serial round-trips
through Amber per message — the tab-backgrounding fragility we already fought in
`0cf4062` makes this hopeless at conference scale); receivers pay 2 `nip44_decrypt` per
incoming message (nips issue #2160 documents exactly this pain); the spec itself says
groups over ~10 participants "should find a more suitable messaging scheme"; no
membership management, no admin, no join/leave semantics — "the group" is whatever
p-tags each sender chooses; no FS/PCS. **Rejected** for event chat (kept, as today, for
1:1 DMs, where it interoperates beautifully with 0xchat/Amethyst/Damus).

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

### 2.5 Naive: chat messages encrypted to the event's ECK

A custom **regular** kind (e.g. 1600 — re-verify unassigned per §15 discipline), shaped
like our other event-encrypted content:

- Outer event signed by a **fresh ephemeral key per message** (not the attendee's key —
  a chat message signed by the attendee with an event `a`-tag would publicly announce
  attendance, which the rest of the design carefully hides via blinded d-tags).
- Tag: `["h", hmac_sha256(ECK, "<coordinate>|chat")[0..32]]` — the blinded chat topic;
  only key-holders can correlate it to the event; subscription filter is `{kinds, #h}`.
- Content: NIP-44-encrypted under the current ECK; plaintext is a **signed inner rumor**
  (author = attendee, signed via `AppSigner.signEvent`) so ECK-holders can't impersonate
  each other. One `sign_event` per message through the signer — fine for local keys,
  and Amber handles per-kind auto-approval (add the kind to `DEFAULT_PERMS` in
  `signer/nip46.ts`).

Properties: works for 100% of the login ladder today; offline-cacheable via the existing
Dexie layer; ECK rotation on revoke degrades gracefully (removed attendee stops reading
future messages — same forward-only honesty as §6.3); zero new dependencies; the
Dm/DmChat UI is directly reusable. Limits: no FS (any past ECK-holder reads the whole
history forever), coordinator can read it (already true of the whole tier), **no
interop — the chat exists only inside Nostrautica and only while people open the web
app**, and no notifications beyond an in-app badge. As the *during-the-event* chat this
is excellent; as the *post-event* chat it fails the product goal by construction.

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
  a support nightmare; ECK chat remains available). This coupling is another reason the
  `chat` config tag must exist.
- Disclosure: the chat settings UI must say the coordinator operates and can read the
  group chat, mirroring the existing matchmaking disclosure.

**NIP-46 (Amber) users**, per flow:
- *Key package publish*: one `sign_event:30443` (and/or 443) — add to `DEFAULT_PERMS`.
- *Welcome unwrap*: two `nip44_decrypt` round-trips, once per group join. Fine.
- *Chatting*: **zero signer traffic** (ephemeral-key signing, exporter-secret
  decryption, all local). This makes Marmot *better* for NIP-46 users than either
  NIP-17 groups (catastrophic) or ECK chat (one sign per message).
- *Caveat*: no `accountProofSigner` possible → leaf lacks the identity-proof extension →
  possible rejection by strict validators (§2.1, open question 3).
- ECK chat: one `sign_event` per message (inner rumor); Amber per-kind auto-approve
  makes it silent after first grant.

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
- **ECK chat / NIP-17 groups**: nothing outside the open web app.
- **NIP-29**: native-client notifications (0xchat) — decent, if we ever add it.

## 6. Pluggable per-event protocol — worth it?

A `["chat", "none" | "eck" | "marmot"]` tag on 31600 (default `none`; `marmot` valid
only with a coordinator; conceivably both enabled at once during transition): **yes** —
it's ~20 lines in `packages/protocol/src/config.ts` and honest UI copy, and the
capability difference between backends forces a switch anyway.

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
2. **Relay lists**: Marmot expects kind 10050 inbox relays for welcome delivery; we
   publish 10002 only (§5.4). Publish a 10050 for app-generated keys? For existing users
   without one?
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
8. **Kind number for ECK chat** (e.g. 1600) — re-verify unassigned against the NIPs
   registry, same as §15.
9. **Group scale**: MLS handles hundreds of members fine cryptographically; commit
   traffic on flaky venue Wi-Fi with ~200 members × multiple devices is untested in any
   web client. Load-test.

## 8. Phased implementation plan

**Phase 1 — ECK event chat (~3–5 dev-days)**
`chat` tag in protocol config + schemas; ephemeral-outer/signed-inner message helper in
`packages/protocol` (reuses `eckEncrypt`, blinding, and the giftwrap-style rumor
pattern); `#/e/:naddr/chat` page reusing DmChat UI; Dexie offline cache; Amber perm
addition; i18n (en+sk). No coordinator changes. Ships value immediately and is the
fallback for coordinator-less events forever.

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

*Bottom line*: Marmot from day one is feasible — with the coordinator as admin bot, an
experimental label, and the §3 multi-client UX designed in — but it should ride on top
of a boring ECK chat that works for every event, every signer, and every browser today.
