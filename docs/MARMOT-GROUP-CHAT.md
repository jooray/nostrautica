# Marmot group chat — specification and implementation plan

Status: **specification + phased plan. Phases 1, 2 (app side), 3 (coordinator admin bot), and
4 (UI) are all implemented; packaging resolved (§2.1). Live-tested 2026-07-16: the
attendee → coordinator direction works end-to-end against a real relay — the browser client publishes its 30443 key package +
10050/10002 relay lists, the coordinator's live watcher receives it and performs a genuine MLS
Add + Welcome. But the coordinator → attendee direction does not complete client-side: two
independent identities both stayed on "Setting up your secure chat…" indefinitely (40s+ across
repeated reloads, and 32s continuously without reload) after the coordinator's confirmed
server-side add, so no 445 message round-trip or revoke-lockout could be exercised. Phase 5
(live e2e + hardening) is accordingly still open — see §8.** Successor to the analysis in
[GROUP-CHAT-FEASIBILITY.md](GROUP-CHAT-FEASIBILITY.md) (read it first for the option analysis
and the multi-client reasoning; this document fixes the design and turns it into buildable
phases). Cross-reference stub: SPECIFICATION.md §7.5.

Sources verified for this document (2026-07-15): the canonical Marmot protocol spec
(`marmot-protocol/marmot`, current head), `marmot-ts` v0.6.0 (`marmot-protocol/marmot-ts`,
master @ `2f60dbb`, 2026-06-24 — up to date with the remote), MDK (`marmot-protocol/mdk`, the
Rust reference workspace), and this codebase.

## Owner decisions (fixed — everything below designs around these)

1. **Marmot only.** No NIP-17 group chat. The feasibility doc's two-backend recommendation is
   superseded: one chat backend, MLS over Nostr.
2. **Per-event optional** via a `chat` tag on the kind 31600 event config, sole defined value
   `"marmot"`; absent = no chat. Valid **only when the event has a `coordinator` tag** — the
   coordinator is the MLS admin bot; without one there is no group chat for that event.
3. **Build on marmot-ts / MDK.** `@internet-privacy/marmot-ts` is the TypeScript
   implementation we integrate (both app and coordinator); MDK (`marmot-protocol/mdk`, Rust,
   OpenMLS-backed) is the reference implementation the protocol is conformance-tested against.
   **Treat the MDK/marmot-protocol ecosystem as the reference spec for Marmot behavior.** Any
   protocol- or library-level change we need is **contributed upstream, never forked** —
   upstream-contribution points are flagged `UPSTREAM` throughout.
4. **No separate interop/Whitenoise test program.** We rely on marmot-ts's own darkmatter/MDK
   wire-interop testing. Expected Whitenoise behavior is still specified (§6) so UX copy and
   support expectations are honest.

---

## 1. Protocol layer

### 1.1 Which Marmot, exactly — and the kind-number skew

Marmot exists in two published shapes and they disagree on the key-package kind:

| | Key package | KP relay list | Welcome | Group msg |
|---|---|---|---|---|
| Merged NIP-EE (`nips/EE.md`, stale snapshot) | kind **443** | kind 10051 | 444 in 1059 | 445 |
| **Current Marmot v2 spec + marmot-ts + MDK** | kind **30443** (addressable) | none — NIP-65 (10002) discovery | 444 in 1059 | 445 |

We implement **Marmot v2**: the current `marmot-protocol/marmot` spec explicitly lists `443`
and `10051` as *removed legacy kinds* (`transports/AGENTS.md`), and marmot-ts publishes
kind 30443 (`ADDRESSABLE_KEY_PACKAGE_KIND`, `core/protocol.ts`). Whitenoise tracks the same
v2 line via darkmatter/MDK. The stale NIP-EE snapshot is a documentation hazard, not an
implementation choice — anyone still emitting bare 443 is behind the spec they claim to
implement. We do not publish 443.

**Correction (verified against the vendored library, 2026-07-15):** marmot-ts 0.6.0 — the
version we integrate — is **30443-only and has NO read-compat for legacy 443**. There is no
`KEY_PACKAGE_KIND = 443` constant and no acceptance of a 443 event anywhere in the build; a
peer still publishing bare 443 is simply *invisible* to us (and to Whitenoise/MDK, which
track the same line). This supersedes the earlier "read-compat for legacy 443" wording, which
described npm's older published 0.5.1 — and 0.5.1 is unusable here for a different reason:
it lacks the mandatory `marmot.account-identity-proof.v1` leaf (see §2, Packaging).

### 1.2 Event kinds used (all external — no new Nostrautica kinds except one rumor)

| Kind | What | Who signs | Where published |
|---|---|---|---|
| **30443** | MLS KeyPackage (addressable, `d` = per-client slot id) | the chat identity key (§3) | chat identity's NIP-65 relays + event relays |
| **10050** | inbox relay list (standard NIP-17 kind, reused unchanged) | chat identity key | chat identity's relays |
| **10002** | NIP-65 relay list — key-package *discovery* (no kind 10051 exists in v2) | chat identity key | as today |
| **444** | Welcome rumor (unsigned; content = base64 `MLSMessage`/`mls_welcome`; `e` tag = consumed key-package event id; `relays` tag = group relays) | nobody (rumor) | inside 1059 |
| **1059** | NIP-59 gift wrap carrying the 444, addressed to the invitee's chat identity | fresh ephemeral key | invitee's 10050 inbox relays |
| **445** | group message (commit / proposal / application). Content = base64 `nonce(12) ‖ ChaCha20-Poly1305(exporter_key, …)`; exactly one `h` tag = hex `nostr_group_id` | **fresh ephemeral key per event — never a user key** | the group's relay list |
| 9 / 7 / 1009 | inner app payloads (chat text / reaction / edit) — *unsigned Nostr-shaped rumors inside MLS*, `pubkey` = sender's chat identity, no `sig` | MLS authenticates | never published bare |
| **21607** | **new Nostrautica rumor kind: chat-key attestation** (§3.3) — gift-wrapped attendee → coordinator | account key seals (kind 13) | coordinator inbox |

The 31600–31609 addressable block is full; nothing new is needed there. 21607 is the next
free slot in the 21600–21606 rumor block and extends it to 21600–21607
(`packages/protocol/src/kinds.ts`, `RUMOR_KINDS`).

### 1.3 The `chat` config tag

`packages/protocol/src/config.ts`:

- `EventConfig` gains `chat: "marmot"[]` (array for forward-compat; today the only value).
- `buildEventConfig` emits one `["chat", "marmot"]` tag when enabled; `parseEventConfig`
  collects all `chat` tags, keeps known values, drops unknown ones.
- **Validation rule: `chat=marmot` without a `coordinator` tag is ignored** (parse keeps it
  but the app and coordinator treat it as absent). UI enforces it at creation time.
- Must be added to *both* build and parse in the same change: config flows rebuild 31600 from
  parsed tags and republish (`packages/protocol/src/event-page.ts` warning), so a tag missing
  from the round-trip is silently dropped on coordinator attach.

### 1.4 Group identity and event binding

Per spec (`app-components/nostr-routing-v1.md`), `nostr_group_id` MUST be 32 random bytes and
MUST NOT be derived from anything — so the group **cannot** be identified from the event
coordinate, by design. Binding is operational, not cryptographic:

- The coordinator creates **one group per event** when `chat=marmot` is (or becomes) active:
  `client.groups.create(<event title>, { description, relays: <event 31600 relay list>,
  adminPubkeys: [coordinatorPubkey] })`. It records `coordinate → mls_group_id,
  nostr_group_id` in its SQLite.
- Members learn the group purely from their **Welcome**: the 444 carries the group relays,
  and the joined state carries `nostr_group_id` (`getNostrGroupIdHex`). The app then
  subscribes `{ kinds: [445], "#h": [nostrGroupIdHex] }` on the group relays.
- Nothing public links the group id to the event: 30443s are generic Marmot readiness (any
  Whitenoise user publishes them), 1059 welcomes are unlinkable, 445s carry only the random
  `h`. Chat membership is therefore *not* publicly linkable to event attendance — consistent
  with the encrypted-tier privacy posture (SPECIFICATION.md §5, THREAT-MODEL.md).
- Group relays default to the event's relay list. Open question 5 (§9) covers 445 retention.

### 1.5 Signer round-trip budget (the Amber story)

Confirmed from `marmot-ts` source (`src/core/group-event.ts`: `finalizeEvent(draft,
generateSecretKey())`):

- **Sending a chat message: zero signer round-trips.** Outer 445 signed by a throwaway key;
  inner rumor is unsigned; encryption is the epoch's exporter secret. Same for receiving.
- Signing is needed only for: **30443 key-package publish** (one `signEvent`), **10050 /
  10002 publish** (one `signEvent` each, once), **welcome unwrap** (two `nip44Decrypt` per
  welcome), and the **21607 attestation seal** (one `signEvent` kind 13) for remote-signer
  users. Under the chat-key design (§3) everything except the attestation is signed by a
  *local* key, so a NIP-46 user's entire Marmot lifecycle costs **one** Amber round-trip
  (kind-13 seal — already in `DEFAULT_PERMS`). No new NIP-46 permissions are required in v1.

---

## 2. Library: marmot-ts (what we integrate against)

`@internet-privacy/marmot-ts` v0.6.0, master @ `2f60dbb`. Alpha ("breaking changes without
notice; do not use in production yet"), but the picture is materially better than the
feasibility doc's snapshot: the repo now tracks **Marmot v2**, is **wire-compatible with
darkmatter/MDK** including the mandatory `marmot.account-identity-proof.v1` leaf extension,
PublicMessage-framed handshakes, `self_remove` departures, and a convergence engine; its
`SPEC_GAP_REVIEW.md` shows all wire-interop blockers (B1–B7) and majors M1–M8 resolved, with
encrypted-media source-epoch retention (M9) the main open major. MLS engine is `ts-mls`
(vendored fork) — pure TypeScript, RFC 9420, no WASM; crypto is @noble/* + @hpke/core
(WebCrypto). Single ciphersuite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Browser,
Node ≥ 20. Bundle: no official figure; estimate 300–400 KB gz including ts-mls — must be
lazy-loaded (dynamic `import()` only on events with `chat=marmot`).

Integration surface (all verified in source):

- `new MarmotClient({ signer, network, groupStateStore, keyPackageStore, clientId,
  accountProofSigner?, inviteStore?, rewindStore?, historyFactory? })`
  - `signer: EventSigner` (applesauce-core: `getPublicKey/signEvent/nip44Encrypt/nip44Decrypt`)
    — exactly our `AppSigner` core methods (`packages/app/src/lib/signer/types.ts`).
  - `network: NostrNetworkInterface` — `publish / request / subscription /
    getUserInboxRelays` (4 methods; we implement over NDK in the app, over `NostrClient` in
    the coordinator).
  - Stores: `GenericKeyValueStore<T>` (`getItem/setItem/removeItem/clear/keys`). **No
    production browser adapter ships** (in-memory + demo-only encrypted store).
    `UPSTREAM: contribute an IndexedDB (Dexie) adapter to marmot-ts `/extra``.
  - `clientId`: stable per-device `d`-tag slot for 30443s (their latest commit is precisely
    about per-device slots).
- `client.keyPackages.create/ensurePublished/rotate/purge` — publish kind 30443.
- `client.groups.create(name, {description, relays, adminPubkeys})` →
  `MarmotGroup`; `groups.invite(groupId, keyPackageEvent)` (Add commit + welcome delivery to
  the invitee's 10050 relays); `group.evaluateKeyPackage(event)` eligibility precheck;
  `proposeRemoveUser(pubkey)` (removes **all** leaves of that pubkey) +
  `groups.commit(groupId, {extraProposals})`; `group.selfUpdate()`; `groups.leave()`
  (self_remove); `proposeUpdateMetadata` (admin list, profile, relays).
- `client.invites.listen/ingestEvent/decryptGiftWraps/getUnread/markAsRead`,
  `client.joinGroupFromWelcome({welcomeRumor})` — join validates **every** leaf's identity
  proof (`verifyAllLeafAccountIdentityProofs`) and rejects otherwise.
- Messaging: `createChatRumor({pubkey, content})` (kind 9) →
  `client.groups.send(group.id, createApplicationMessageIntent(rumor))`;
  receive via 445 subscription → `group.ingest(events)` →
  `group.on("applicationMessage", data => deserializeApplicationData(data))`.
  Sends are convergence-gated (queued until the group settles) — the UI must show a pending
  state rather than assume synchronous publish.
- `accountProofSigner: (request) => Uint8Array` — **raw BIP-340 over a 32-byte digest**; §3.

Known remaining gaps we accept (from `SPEC_GAP_REVIEW.md`): M9 old-epoch media decryption;
m8 welcome-recipient binding and m9 445 sig-before-decrypt hardening
(`UPSTREAM: if either bites us, fix in marmot-ts, not locally`); MIP-06 multi-device pairing
entirely absent (we don't need it — §5); MIP-05 push absent (mobile clients' job).

Pinning policy: exact-version pin; treat every upgrade as a mini-audit (alpha, API churn).
Vendoring only as a last resort and only as a stopgap while an upstream PR lands.

### 2.1 Packaging decision (Phase 2 gate — RESOLVED, 2026-07-15)

Investigated all three candidates against the two hard requirements — emits **30443**, and
carries the mandatory **`marmot.account-identity-proof.v1`** leaf (§3):

| Candidate | 30443? | identity-proof leaf? | installs under `--frozen-lockfile`? |
|---|---|---|---|
| npm `@internet-privacy/marmot-ts@0.5.1` (published) | ✅ (emits 30443, reads 443 too) | ❌ **absent** — no `accountProofSigner`, no proof leaf | ✅ |
| git master `0.6.0` (`2f60dbb`) as a submodule/path dep | ✅ (30443-only) | ✅ | ❌ depends on an **unpublished ts-mls fork** (`hzrd149/ts-mls` @ `2ca5c43`, branch `marmot-required-ext`) via a `./ts-mls` path dep + git submodule — a deploy-hook `pnpm install --frozen-lockfile` cannot resolve it, and the submodule needs a separate init+build |
| **VENDORED 0.6.0 (chosen)** | ✅ | ✅ | ✅ |

0.5.1 is out (no identity-proof leaf ⇒ not wire-compatible with current Whitenoise/MDK).
0.6.0-via-submodule is out (won't survive the deploy hook). **Decision: vendor the *built*
0.6.0 into the workspace**, plus its unpublished ts-mls fork, as two committed workspace
packages — no submodule, no build step at install time:

- `packages/vendor/ts-mls/` — `name: "ts-mls"`, the compiled `hzrd149/ts-mls @ 2ca5c43`
  (`marmot-required-ext`, v2.0.0-rc.14). Its deps are all published (`@hpke/core`,
  `@noble/*`, and the full HPKE/`@noble/post-quantum` ciphersuite catalog ts-mls lazily
  `import()`s — Rollup must resolve every string-literal dynamic import at build time even
  though Marmot uses only `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`).
- `packages/vendor/marmot-ts/` — `name: "@internet-privacy/marmot-ts"` v0.6.0, the compiled
  master. Deps all published (`applesauce-*`, `@noble/*`, `@scure/base`, `debug`,
  `eventemitter3`) + `ts-mls: workspace:*`.
- Built output is committed under **`lib/`** (not `dist/`, which the repo `.gitignore`
  excludes at every level) with the exports map rewritten `dist→lib`. A `"./lib/*"` wildcard
  export is added so upstream-unexported symbols can be deep-imported (see the `U`-register /
  `proposeRemoveUser` workaround). Sourcemaps and `.tsbuildinfo` are stripped.

`app` and `coordinator` depend on `@internet-privacy/marmot-ts: workspace:*`. **Verified in
this environment:** `pnpm install --frozen-lockfile` succeeds; Node resolves the client,
core, and the `proposeRemoveUser` deep-import; the constant `ADDRESSABLE_KEY_PACKAGE_KIND`
reads **30443**; and a **real SvelteKit/Vite production build** (`pnpm --filter
@nostrautica/app build`) bundles marmot-ts+ts-mls into a single lazy chunk (~221 kB gzipped,
loaded only on `chat=marmot` events) and completes green. This closes the one Phase-0 spike
condition that was left unverified. Upgrade path when upstream publishes a self-contained
0.6.x+ (or the ts-mls fork lands on npm): drop the two vendor packages, pin the published
version, re-audit.

---

## 3. Identity: the account-identity-proof problem and its resolution

### 3.1 The problem, precisely

`marmot.account-identity-proof.v1` (extension `0xf2f1`) is **adopted and mandatory**: every
KeyPackage and member leaf MUST carry a BIP-340 Schnorr signature *by the account key* over a
domain-separated 32-byte digest that is **not a Nostr event** — the spec explicitly rejects
the event-id construction (`foundation/account-identity-proof-v1.md`). Enforcement is real on
both sides we touch: marmot-ts refuses to *invite* a proof-less key package
(`src/client/group/proposals/invite-user.ts` → `verifyLeafAccountIdentityProof`) and refuses
to *join* a group containing any proof-less leaf. There is no degraded mixed-group path — one
bad leaf poisons the group for every strict client.

Our signers (`packages/app/src/lib/signer/`):

- `LocalSigner` — holds the raw 32-byte key (`getSecretKey()`); **can** sign the digest.
- `Nip07Signer` — `window.nostr` has no raw-signing method; **cannot**.
- `Nip46Signer` (Amber) — NIP-46 has `sign_event`, `nip44_*` only; **cannot**.

So "Marmot chat requires a key that can raw-sign" is a hard protocol fact, not a preference.

### 3.2 Resolution (concrete)

**The MLS account identity for chat is always a key the app holds locally.** Two cases:

1. **Local-key accounts** (the app-generated onboarding path): the account key itself is the
   chat identity. `accountProofSigner = digest => schnorr.sign(digest, signer.getSecretKey())`.
   Full native interop: the member appears in every Marmot client as the user's own npub.

2. **NIP-46 and NIP-07 accounts**: the app generates a dedicated **chat device key** — a
   normal Nostr keypair created once per install, stored in the signer keystore
   (`packages/app/src/lib/signer/keystore.ts` pattern; IndexedDB, same threat class as
   `local-sk`, covered by the existing backup flow). The chat key is the MLS account
   identity: it signs the 30443, its 10050/10002, the identity proof, and appears as the
   member. The app publishes a kind-0 profile for it (locally signed): display name +
   `" (chat)"` marker, so other Marmot clients render something sensible.

   **Binding to the real account** is app-level: a **kind 21607 chat-key attestation** rumor,
   gift-wrapped to the event coordinator, sealed by the *account* key (`signerWrap` — one
   `sign_event:13`, already granted to Amber sessions). Content (JSON):
   `{ v: 1, coordinate, op: "add" | "revoke", chat_pubkey, client_id? }`. The coordinator
   verifies the seal author is an enrolled npub (exactly how it authenticates 21600 joins)
   and records `account_pubkey → chat_pubkey`. Only attested chat keys (and account keys of
   local-key attendees) are eligible for auto-add (§4). `op:"revoke"` (lost device) makes the
   coordinator remove that chat key's leaves and stop re-adding it.

   Honest costs, stated in UI copy: in Whitenoise the member is the *chat npub*, not the main
   npub; other clients cannot verify the app-level binding; hand-off to a phone means
   importing the chat key (§6). The event roster UI hides this entirely (it maps chat npub →
   attendee profile via the coordinator-published mapping in the encrypted roster, §4.4).

3. **Organizer co-admin** uses the same machinery: the organizer's chat identity (case 1 or
   2) can be promoted to the group admin list (§4.6).

### 3.3 Upstream contribution points for identity

- `UPSTREAM (NIP-46 / Amber)`: propose a `sign_message`-style raw BIP-340-over-digest method
  for NIP-46 and an Amber implementation. This is the *real* fix; when it lands, NIP-46
  accounts can be native Marmot members and the chat-key path becomes a fallback. Marmot-ts
  needs nothing — `accountProofSigner` is already an injectable hook.
- `UPSTREAM (marmot-protocol)`: raise a "delegated device key" discussion — an app component
  attesting `account_pubkey ⇄ device_pubkey` inside group state, so clients could *display*
  chat keys under the owning account. Our 21607 is deliberately app-scoped so it can be
  retired in favor of whatever the protocol adopts.
- `UPSTREAM (marmot-ts)`: a documented recipe/helper for `accountProofSigner` from a raw key
  exists only in test/example helpers (`examples/opentui/src/helpers/account-proof.ts`);
  contribute it as a first-class export.

---

## 4. Coordinator as MLS admin bot

The coordinator (`packages/coordinator/`) is the only always-on, stateful actor and it holds
a plain secret key (`coordSk` — can raw-sign, so its own identity proof is trivial). It runs
a `MarmotClient` with: signer + `accountProofSigner` from `coordSk`; network adapter over its
existing `NostrClient` (SimplePool); stores backed by new SQLite tables with the existing
`Store.protect`/`reveal` NIP-44-under-`coordSk` at-rest encryption.

### 4.1 What it subscribes to (complete list of new inputs)

1. **31600 config** (already subscribed — `subscribeEventConfig`): a `chat` diff in
   `handleConfigUpdate` creates the group (tag appeared) or freezes it (tag removed — stop
   adding/welcoming; the group itself is not killed, see Q4 §9).
2. **kind 30443 key packages** authored by *authorized chat identities* of approved
   attendees: `{ kinds: [30443], authors: [...] }` on the event relays + each identity's
   NIP-65 relays. The author set updates on approve/revoke/attest. This one subscription is
   simultaneously the **initial-add**, **multi-device**, and **state-loss-heal** mechanism.
3. **kind 21607 attestations** — arrive on the existing coordinator 1059 inbox
   (`subscribeCoordInbox` → `handleCoordinatorWrap`); new rumor-kind branch.
4. **kind 445 group traffic** for each of its groups (`#h` filter): the coordinator is a
   member; it must `ingest` continuously to stay converged, serve as the reliable
   auto-committer for `self_remove` departures, and (later) render/export chat if ever needed.

### 4.2 What it does (event-driven, via the existing `JobRunner` lease queue)

- **On approval** (`grantAndPublish`, coordinator.ts:831): after the 21602 ECK grant, enqueue
  `marmot_sync_member(coordinate, account_pubkey)` — fetch current 30443s for each of that
  attendee's authorized chat identities; for each valid, unconsumed key package:
  `group.evaluateKeyPackage` → `groups.invite`. Idempotency: skip identities that already
  have a leaf (`getPubkeyLeafNodes`) with a live key package ref; record consumed key-package
  event ids in SQLite.
- **On new 30443 from an authorized identity** (subscription 2): same sync job, deduped by
  `(coordinate, keyPackageEventId)`. This is how a fresh browser install, an evicted
  IndexedDB, or a newly installed Whitenoise gets a leaf — no human in the loop.
- **On revoke** (`revokeAttendee`, coordinator.ts:880): alongside the existing ECK rotation,
  enqueue `marmot_remove(coordinate, account_pubkey)` — `proposeRemoveUser` for the account
  pubkey *and every attested chat pubkey* + commit. An MLS Remove is real PCS for the chat —
  strictly stronger than the forward-only ECK rotation.
- **On 21607 add**: record mapping; run member-sync if the attendee is approved. **On 21607
  revoke**: remove that chat key's leaves; drop it from the authorized set.
- **Welcome delivery** is marmot-ts's job (gift wrap → invitee's 10050 relays, group-relay
  fallback) — no new publisher code.

### 4.3 State, and the property we are knowingly breaking

New SQLite tables (all secret-bearing columns `protect`ed): `marmot_groups` (coordinate PK,
mls_group_id, nostr_group_id, created_at, status), `marmot_kv` (the three
`GenericKeyValueStore` namespaces: group state / key-package private material / rewind),
`marmot_chat_keys` (coordinate, account_pubkey, chat_pubkey, client_id, status),
`marmot_consumed_kps` (coordinate, kp_event_id).

**This breaks SPECIFICATION.md §9.1's "DB loss only re-costs money."** Losing the coordinator
DB now loses the group's only admin: nobody can add or remove members again, ever (MLS state
is not reconstructible). Mitigations, all required: (a) documented DB backup for coordinator
operators (the MLS state is small and changes on commits only); (b) **second admin** — offer
the organizer's chat identity as co-admin at group creation or later (§4.6); (c) the
coordinator's `selfUpdate` cadence keeps its own leaf healthy. Residual risk stays in §9.

### 4.4 Roster mapping for display

So the app can render chat-key members as people: the coordinator adds an optional
`chat_pubkey` field to each attendee entry in the **encrypted** roster (31604,
`rosterContentSchema` — additive schema change, old clients ignore it). Mapping is thus
visible to members only, preserving the privacy posture.

### 4.5 Disclosure

The coordinator is a group member: **it can read the entire chat**. Event UI must disclose
this exactly like the matchmaking disclosure ("the coordinator operates and can read this
chat"). Also disclosed: messages are visible to all attendees from their join epoch forward.

### 4.6 Admin lifecycle after the event

Coordinators get decommissioned. Before shutdown the operator promotes the organizer's chat
identity to admin (`proposeUpdateMetadata` admin update — one command, exposed as an admin
command rumor `cmd:"chat-admin"` on the existing 21604 channel), or accepts that membership
freezes. A slim "chat-admin-only" coordinator mode is deliberately out of v1 (§9 Q6).

---

## 5. MLS state in a stateless PWA

- **Where**: a new IndexedDB-backed `GenericKeyValueStore` (Dexie — already a dependency —
  or the hand-rolled pattern of `packages/app/src/lib/events/keystore.ts`), four namespaces
  (group state, key-package private material, invites, rewind), keyed/namespaced by the
  active chat identity pubkey. Key-package private material and chat device keys are secrets
  in IndexedDB — same class and same accepted risk as the existing `local-sk`
  (SPECIFICATION.md §14); no new threat introduced.
- **Eviction is survivable by design, with a permanent history gap.** If IndexedDB is purged
  (Safari non-installed PWAs are the worst case), that client's leaf goes deaf. Recovery is
  the heal loop: the app detects it (known-group state missing, or a run of `unreadable`
  ingest dispositions on live 445 traffic), publishes a **fresh key package** (new slot or
  same `clientId`), the coordinator's 30443 watcher re-adds it, a new welcome arrives, and
  chat resumes **from the new join epoch**. Messages between eviction and re-add are
  cryptographically gone for that client — forward secrecy, not a bug. The stale deaf leaf is
  garbage-collected by the coordinator (remove leaves whose key-package ref was superseded by
  a heal re-add from the same identity, or on next revoke sweep).
- **Cross-device reality**: MLS state never syncs; NIP-EE/Marmot track each client as a
  separate member. Every device = its own leaf, own 30443 slot (`clientId`), own join epoch,
  own history window. There is **no history sync, ever** — MIP-06 multi-device (pairing,
  External Commit) is an unimplementable draft and marmot-ts ships none of it. UI copy must
  say "each device sees messages from when it joined."
- **Same mechanism, three faces**: second browser, evicted browser, and new phone are all
  "new key package appears → coordinator adds it." This is why the auto-add bot is
  load-bearing and not a convenience.

---

## 6. Expected Whitenoise interop behavior (documented, not separately tested)

Per owner decision we rely on marmot-ts ↔ darkmatter/MDK interop testing upstream. Expected
behavior, to be reflected in UX copy:

- An attendee installs Whitenoise and signs in with the **key that is their chat identity**
  (their own key for local-key accounts; the exported chat device key for NIP-46/NIP-07
  accounts). Whitenoise publishes its own kind-30443 under its own client slot; our
  coordinator auto-adds it; the event chat appears in Whitenoise with push notifications.
- **From-join-epoch-forward only**: the phone shows messages from the moment its leaf was
  added. Prior history never appears. Set this expectation in the hand-off card.
- **Per-client MLS state**: the web leaf and the phone leaf are two members under one
  account identity; conformant clients dedupe display by account npub, so rosters look
  normal.
- Identity proofs: all our leaves carry valid proofs (coordinator raw-signs; app raw-signs
  with the local account key or chat key), so strict validation on the Whitenoise side is
  satisfied. Group state uses only components marmot-ts and MDK both support (profile,
  admin-policy, nostr-routing; no `0x8002` blossom-image requirement — it would make the
  group unjoinable for both).
- Chat-key members appear in Whitenoise as the chat npub (kind-0 name "<Name> (chat)"). The
  binding to the main npub is visible only inside Nostrautica (§4.4).
- If upstream interop breaks (alpha library, evolving spec), our exposure is exactly theirs;
  we track marmot-ts releases and their conformance reports rather than running our own
  matrix.

---

## 7. App UX

- **Entry point**: new hash route `#/e/:naddr/chat` (`packages/app/src/lib/router/routes.ts`)
  inside the event shell. `eventShell` gains `showChat = isMember &&
  ctx.config.chat.includes("marmot") && !!ctx.config.coordinator` (template: `showMatches`).
  Navigation: **Chat becomes an `EventNav` tab** when enabled; because the bar already holds
  Overview · People · Matches · Updates · More, when both Matches and Chat are visible,
  Updates collapses into the More menu (rule lives in `EventNav.svelte`; final call is a UX
  detail for the owner, an `EventMore` row is the fallback). Non-members never see the tab.
- **Chat screen**: message list + compose, modeled on `DmChat.svelte` but backed by the
  `chat/marmot` module: live 445 subscription → `ingest` → `applicationMessage` events;
  optimistic send with a "pending" state (sends are convergence-gated); day separators;
  sender rendering via roster + §4.4 chat-key mapping; kind-7 reactions and kind-1009 edits
  rendered per the Marmot application-message rules (edits replace in place, never re-bump).
  Message history cache in the chat Dexie store so reopening the tab is instant (decrypted
  plaintext cache — same at-rest posture as MLS state itself).
- **Joining UX**: invisible. On first visit to a marmot event as a member the lazy-loaded
  module ensures chat identity → 10050/10002 → key package → (remote signers) 21607
  attestation, then waits for the welcome ("Setting up your secure chat…"). Everything after
  approval is automatic.
- **Enable toggle**: Create flow + Admin page get a "Group chat (Marmot, experimental)"
  toggle, enabled only when a coordinator is configured; toggling later works (coordinator
  backfills adds for all approved attendees on the config diff). Copy carries the coordinator
  disclosure (§4.5) and the experimental label.
- **Notifications**: in-app only — an unread badge on the Chat tab from a last-read watermark
  (greenfield; no notification infra exists in the app). No web push in v1 (no push backend;
  a coordinator-as-push-sender idea stays in the feasibility doc's future list). The real
  notification story is the phone hand-off:
- **"Take this chat to your phone"**: a hand-off card in chat settings and in the end-of-event
  screen. Local-key users: reuse the existing identity-handoff (nsec QR) + "install
  Whitenoise, sign in, chat appears with notifications; history starts when the phone
  joins." Chat-key users: same flow with the chat key QR + a plain-words note that this key
  is chat-only.

---

## 8. Phased implementation plan

Every phase is independently shippable and gated by its acceptance list. Sizes assume one
developer.

### Phase 0 — spike: marmot-ts in our two runtimes (~1 week)

Validation only; no shipped code. Browser: bundle marmot-ts in the SvelteKit app (build
config for the vendored ts-mls submodule, measure real gz size, confirm lazy-load), a
throwaway Dexie `GenericKeyValueStore`, NDK-backed `NostrNetworkInterface`, create a
loopback group and message it against the e2e local relay. Node: same client over
`NostrClient` under `node:sqlite` stores. Two-client add/remove/heal rehearsal driven by a
script standing in for the coordinator.
**Acceptance**: browser client and Node client exchange kind-9 messages through the local
relay; remove locks the removed client out of the next epoch; a wiped browser store recovers
via re-add; measured bundle size recorded. **Go/no-go gate for everything below.** Any
build/bundler friction found here → `UPSTREAM issue/PR to marmot-ts` (likely candidates:
package export maps, submodule build, IndexedDB adapter).

### Phase 1 — protocol plumbing (~3 days) — ✅ IMPLEMENTED 2026-07-15

`config.ts`: `EventConfig.chat: ChatBackend[]` (`ChatBackend = "marmot"`), emitted as
`["chat","marmot"]` tags (omitted when empty, so chat-off events stay byte-identical),
localized alongside `talks`/`lang` in both build and parse; unknown backends dropped,
duplicates de-duped; `isMarmotChatEnabled(cfg)` enforces the coordinator-required rule.
`kinds.ts`: `KIND_CHAT_KEY_ATTESTATION = 21607` added to `RUMOR_KINDS`. `schemas.ts`:
`chatKeyAttestationContentSchema` (strict; `op: add|revoke`) + additive optional
`chat_pubkey` on `rosterContentSchema`. Round-trip + validation tests added (protocol suite
90→96). App/coordinator construction sites (`create.ts` + input type) updated for the new
required field; whole tree green.

Files: `packages/protocol/src/config.ts` (+ tests), `packages/protocol/src/kinds.ts`
(`KIND_CHAT_KEY_ATTESTATION = 21607`, extend `RUMOR_KINDS`), `packages/protocol/src/schemas.ts`
(21607 content schema; additive `chat_pubkey` in `rosterContentSchema`; + tests).
**Acceptance**: `chat` tag round-trips build→parse→build byte-identically; 21607 validates;
unknown `chat` values are dropped; `pnpm check` green. No behavior anywhere yet.

### Phase 2 — app `chat/marmot` module (~2 weeks) — ✅ IMPLEMENTED (app side; needs live verification)

`packages/app/src/lib/chat/`, all lazy-loaded behind EventChat's dynamic `import()`:
- `stores.ts` — storage-agnostic `GenericKeyValueStore<T>` over a tiny `MarmotKvBackend`;
  `IndexedDbKvBackend` (bounded prefix-range scans) for production, `InMemoryKvBackend` for
  tests; per-identity + per-namespace scoping; `makeMarmotStores(backend, identity)` →
  the four typed stores. (7 conformance tests.)
- `identity.ts` — chat-identity resolution (§3): local-key accounts use the account key;
  NIP-46/NIP-07 accounts generate + persist a chat **device key** in IndexedDB. Uniform
  `accountProofSigner = signAccountIdentityProof(req, sk)`; `eventSignerFromKey` builds the
  applesauce-shaped signer; `buildChatKeyProfile` publishes the "(chat)" kind-0. (7 tests.)
- `attest.ts` — kind-21607 build + gift-wrap to the coordinator, sealed by the account key
  (`signerWrap`); `verifyChatKeyAttestation` for the receiving side. (5 tests.)
- `network.ts` — `NostrNetworkInterface` over the app's NDK pool (publish/request/
  subscription for 30443/1059/445 + `getUserInboxRelays` via 10050).
- `messages.ts` — kind-9 rumor ↔ `ChatMessage` mapping via marmot's real
  `createChatRumor`/`serializeApplicationRumor`/`deserializeApplicationData` codec, incl. the
  id-integrity round-trip. (4 tests.)
- `client.ts` — `MarmotChat` wrapper: identity+stores+network wiring, `ensurePublished`
  (10050 + 10002 + 30443 key package + 21607 attestation), invite listen, `joinPending`,
  `connectAll` 445 subscription, `send`, `healIfEvicted`, `leaveAll`. Includes the
  `proposeRemoveUser` deep-import + `resolveRemoveUserProposals` array-flatten workaround
  (admin/co-admin path; the app member side only `leaveAll`s).
- `session.svelte.ts` — the shared, event-scoped session store the shell owns (see below);
  `client.ts` is dynamically imported from here, so the marmot chunk is still lazy.
- `eventShell.showChat` = member ∧ `isMarmotChatEnabled(config)`.

**Enrolment timing — prewarm (added 2026-07-20).** The session is started by the layout as
soon as the shell resolves an approved member of a chat-enabled event, on *any* of that
event's pages (`shouldPrewarmChat`, `chat/gate.ts`), and kept alive until the user leaves the
event or logs out. It used to start on the Chat page's mount, which meant the kind-30443 key
package — the thing the coordinator consumes to add a member (§4.2) — was only advertised at
first open, so the Add happened *then*. MLS gives a new member nothing from before their Add,
so every attendee's first visit to chat was an empty room with a "Setting up your secure
chat…" wait, and anything announced between their approval and that first click was
unreadable to them forever. Prewarming moves the Add to (as near as the app being open
allows) approval time; the welcome and live 445 traffic land in the background, and
`EventChat.svelte` is now a view over an already-joined session rather than its owner.

**Signer round-trips per message = 0** (445 signed by a throwaway key, inner rumor unsigned) —
the send path uses `client.groups.send`, never `signEvent`. **Needs live verification:**
end-to-end send/receive requires a real relay + the coordinator admin bot (Phase 3), which
is not runnable in the build environment; the integration is written to the verified
marmot-ts API surface.

Original file plan (for reference): `packages/app/src/lib/chat/` (all lazy-loaded): `stores.ts` (Dexie
`GenericKeyValueStore` ×4, per-identity namespacing — written as an upstreamable adapter:
`UPSTREAM PR to marmot-ts /extra`), `network.ts` (NDK adapter incl. `getUserInboxRelays` via
10050 lookup), `identity.ts` (chat-identity resolution: local account key vs generated chat
device key; `accountProofSigner`; chat-key kind-0; keystore entries; hooks into
`signer/backup.ts`), `attest.ts` (21607 build/send via `signerWrap`), `client.ts`
(MarmotClient lifecycle, key-package ensure-published, 10050/10002 ensure — generalizing
`ensureDmRelayList` to sign with the chat identity, invite listening, join, heal detection +
fresh-key-package republish), `messages.ts` (send/ingest/history cache). Svelte glue:
`eventShell.showChat`.
**Acceptance** (against local infra + a script-driven admin from Phase 0): member app
auto-publishes identity artifacts; joins on welcome; sends/receives kind 9 with zero signer
round-trips per message (assert no `signEvent` calls in the message path); NIP-46-simulated
account completes the whole flow with only the kind-13 attestation seal; store wipe self-heals.

### Phase 3 — coordinator admin bot (~2 weeks)

Files: `packages/coordinator/src/chat/` (`marmot-client.ts` — signer/proof-signer from
`coordSk`, network over `NostrClient`; `store.ts` — SQLite `GenericKeyValueStore` +
`marmot_groups` / `marmot_chat_keys` / `marmot_consumed_kps` tables with `protect`);
`coordinator.ts` (group create on `chat` config attach/diff; `marmot_sync_member` /
`marmot_remove` job types registered on `JobRunner`; 30443 watcher; 21607 branch in
`handleCoordinatorWrap`; hooks in `grantAndPublish` / `revokeAttendee`; 445 ingest loop;
roster `chat_pubkey` enrichment; 21604 `cmd:"chat-admin"`), `store/db.ts` migrations,
docs for operators: DB backup requirement + second-admin recommendation (README of the
coordinator package).
**Acceptance** (mock-coordinator harness, `e2e/local-infra/mock-coordinator.mjs`): approve →
attendee's web client lands in the group without human action; revoke → removed client
cannot read the next epoch; a second key package from the same account gets auto-added
(multi-device); config toggle mid-event backfills all approved attendees; coordinator
restart resumes group operation from SQLite alone.

### Phase 4 — UI (~1.5 weeks) — ✅ IMPLEMENTED

Landed: `#/e/:naddr/chat` route (`routes.ts` + `eventNaddr` + `routes.test.ts`); a gated
**Chat** tab in `EventNav.svelte` (shown on `eventShell.showChat`; when both Matches and Chat
show, Updates collapses into More, with a fallback row in `EventMore.svelte`); `EventChat.svelte`
(lazy-loads the `chat/client` stack, message list with day separators + own/other bubbles,
compose with Enter-to-send, "Setting up…" state, the coordinator-read disclosure, and the
experimental badge); `ChatHandoffCard.svelte` (reveal + nsec QR for Whitenoise, with the
chat-only-key note for device-key accounts); the **Create** toggle (`chat=marmot`, with a
needs-a-coordinator note) and the **Admin** toggle (enabled only with a coordinator, via the
extended `updateEventConfig`). en+sk i18n added (`nav.chat`, `title.chat`, `chat.*`). The
alpha/experimental label is carried in the page header, the nav-adjacent badge, and both
toggles.

Original file plan (for reference): `router/routes.ts` (+`chat` route), `EventNav.svelte` (+tab, collapse rule),
`EventMore.svelte` (fallback row), new `pages/EventChat.svelte` + components (list, composer,
pending state, reactions/edits rendering, unread watermark badge), Create/Admin toggle +
disclosure copy, hand-off card (chat settings + event-end screen), i18n (en+sk).
**Acceptance**: full flow clickable on local infra; disclosure and experimental labels
present; chat invisible to non-members and on coordinator-less events; badge updates on
incoming messages while elsewhere in the event shell.

### Phase 5 — tests & hardening (~1 week)

Unit tests colocated per module (Phases 1–4 each ship their own; this phase closes gaps):
identity-proof digest vectors cross-checked against marmot-ts helpers, heal-loop edge cases,
21607 revoke, config-diff freeze. Playwright e2e: two browser contexts + mock coordinator —
approve/chat/revoke/heal script. Load sanity: 100-member synthetic add storm against the
local relay (Q10 §9). Docs: PARTICIPANT-GUIDE / ORGANIZER-GUIDE chat sections;
ENCRYPTION-AND-PRIVACY + THREAT-MODEL deltas (coordinator reads chat; IndexedDB plaintext
cache; §4.3 property change). SPECIFICATION.md §7.5 rewrite is **out of scope here** (owner
folds the cross-reference separately).
**Acceptance**: `pnpm check` + `pnpm e2e` green including the chat spec; docs updated.

Total: **~6–7 weeks**. Ship gate for public availability: Phase 5 done + the experimental
label kept until marmot-ts reaches a version its authors call production-ready.

### Upstream-contribution register (consolidated)

| # | Where | What |
|---|---|---|
| U1 | marmot-ts | IndexedDB/Dexie `GenericKeyValueStore` adapter in `/extra` |
| U2 | marmot-ts | first-class `accountProofSigner`-from-raw-key helper (today example-only) |
| U3 | NIP-46 spec + Amber | raw BIP-340 digest-signing method → native remote-signer membership |
| U4 | marmot-protocol | delegated device-key attestation component (retires our 21607) |
| U5 | marmot-ts | m8 welcome-recipient binding / m9 445 sig-before-decrypt, if encountered |
| U6 | marmot-ts | bundler/browser-build fixes surfaced by Phase 0. **Concrete, found while vendoring 0.6.0:** (a) publish a self-contained release that does NOT depend on an unpublished ts-mls fork via a git-submodule path dep — either land the `marmot-required-ext` ts-mls changes on npm or bundle them, so `pnpm install --frozen-lockfile` works with no submodule; (b) ts-mls declares the whole HPKE/PQ ciphersuite catalog as *peerDependencies* but `import()`s them by string literal, forcing every bundler to resolve all of them even for the single Marmot ciphersuite — mark the unused ones truly optional or lazy-guard them. |
| U7 | marmot-ts | headless admin-bot ergonomics (batch invite, leaf GC helpers) if the coordinator needs them. **Also:** export `proposeRemoveUser` from the package export map (today it lives at `client/group/proposals/remove-member.js`, unexported — we reach it via a `./lib/*` wildcard on the vendored package); and flatten its array-action result in the engine's `extraProposals` resolver (per the Phase-0 spike, the raw proposals must currently be resolved and spread by hand). |

---

## 9. Open questions for the owner, and risks

Questions (decisions needed, none block Phase 0–1):

1. **Chat-key backup**: include the chat device key in the existing encrypted backup flow by
   default, or keep it install-local (lost device = heal loop, new identity npub in the
   group)? Recommendation: include it — losing it silently forks the user's chat identity.
2. **Nav layout**: Chat as sixth-tab-with-collapse (recommended, §7) vs More-menu row.
3. **Coordinator group read access**: keep the coordinator as a plain reading member
   (required for auto-commit duty and simplest), or additionally surface a per-event "chat
   transcript retention: none" promise in coordinator docs? It already never stores decrypted
   chat in v1 design — decide whether to make that a stated guarantee.
4. **`chat` tag removed mid-event**: freeze (stop adds, group lives on) — the specified
   default — or actively dissolve (coordinator removes all members)? Freeze recommended.
5. **Relay retention of 445**: are the event relays enough for a months-long post-event chat,
   or do we recommend organizer-run relays in the organizer guide? (Public relays may prune;
   commits pruned before a client catches up = permanent gap for that client.)
6. **Post-event admin**: is "promote organizer's chat identity, shut down coordinator"
   acceptable as the only decommission story for v1 (no slim chat-admin daemon)?

Risks (accepted or mitigated, honestly):

- **marmot-ts is alpha.** Breaking API churn is promised by its README; ts-mls is a
  from-scratch TS MLS far less battle-tested than OpenMLS. Mitigation: exact pin,
  upgrade-as-audit, experimental label in UI, upstream engagement (we are early adopters and
  should behave like contributors). We would be the **first production web Marmot client**.
- **Coordinator now holds unlosable state** (§4.3). "DB loss re-costs money" becomes "DB loss
  orphans the chat's admin." Mitigation: backups + second admin; residual risk real.
- **Kind-number skew** (§1.1): anything still speaking merged-NIP-EE 443/10051 won't see our
  key packages. We bet on the living Marmot v2 spec (as MDK and marmot-ts do) and rely on
  their interop line; no dual-publish.
- **Browser state durability**: Safari eviction makes the heal loop routine for some users —
  works, but every heal is a permanent history gap. Mitigation: PWA install prompt, phone
  hand-off as the durable home for the chat.
- **Chat-key identity split** for NIP-46/NIP-07 users: correct-by-construction but cosmetically
  leaky outside our app (chat npub ≠ main npub in Whitenoise). U3/U4 are the path out.
- **Scale is untested in any web client**: MLS handles hundreds of members cryptographically,
  but 200 attendees × multiple leaves × commit traffic on venue Wi-Fi is unknown territory;
  Phase 5's load sanity is a smoke test, not proof.
- **445 retention/ordering on public relays** (Q5) and the convergence engine's behavior
  under aggressive pruning are the most likely sources of "my chat is stuck" support load.
