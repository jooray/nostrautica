# Multi-device Marmot chat — feasibility study and target design

**Date:** 2026-07-22 · **Verified against:** `main` @ `3bf4cfa` (all file:line references
checked against the working tree). Companion to `PROTOCOL-NIP.md` §10, which carries the
normative wire spec; this document carries the feasibility analysis, the change list, and
the migration plan.

## 0. Goal

The same npub logged in on mobile and desktop **at the same time**, both participating in
the event's Marmot/MLS group chat. Synced history across devices is explicitly a
non-goal — MLS state is per-leaf and each device reads from its own join epoch forward.
That constraint is native to MLS and we embrace it rather than fight it.

**Verdict up front: feasible with the vendored marmot-ts/ts-mls as-is — no library
change required.** The approach is *per-device chat keys*: every browser/device mints its
own chat keypair and is attested to the account; each device is an ordinary, independent
MLS group member. Distinct credentials are just distinct members — the identity-proof,
invite, remove-all-leaves-of-a-pubkey, and admin-policy machinery in marmot-ts all operate
per credential pubkey and already handle N members. This also matches GPT56-AUDIT §13.10's
recommended identity model ("Option B: separate chat key per physical device").

## 1. Why the current design cannot do multi-device

Today's chat identity (`packages/app/src/lib/chat/identity.ts:374-394`):

- **Local-nsec accounts**: the account key *is* the chat key. Two devices importing the
  same nsec share one MLS credential — and a second leaf for the same pubkey is blocked
  three times over: coordinator `isMember` dedupe (`chat/admin.ts:193-196`), the in-lock
  recheck (`chat/mls.ts:148-152`), and marmot-ts's own eligibility helper
  (`key-package-eligibility.js:69-72`, "already a member"). Result: whichever device joins
  first chats; the other cannot.
- **NIP-07/NIP-46 accounts**: one account-global "device" key, restored across browsers
  via the self-encrypted 31602 backup (`chat/device-key-backup.ts`). Restoring the *same*
  secret onto a second device hits exactly the same one-leaf-per-pubkey wall — and the
  backup itself is the source of two deferred audit findings: fail-open restore on relay
  errors minting identity forks (App-11, `identity.ts:189`) and non-deterministic
  convergence between same-second competing backups (App-12, `device-key-backup.ts:57`).

So the shared-key model is simultaneously **what blocks multi-device** and **the cause of
the two nastiest chat-recovery bugs**. Per-device keys dissolve both.

## 2. Library-level feasibility (vendored marmot-ts 0.6.0 / ts-mls 2.0.0-rc.14)

Facts verified in the vendored code:

- The MLS credential holds **only a 32-byte x-only Nostr pubkey**
  (`marmot-ts/lib/core/credential.d.ts`); each leaf additionally carries a mandatory
  `marmot.account-identity-proof.v1` extension — a BIP-340 signature by that pubkey,
  verified on invite and on join. So every device key proves possession of itself at the
  MLS layer already.
- **N members with N different pubkeys is the library's native shape.** Nothing anywhere
  links members into "accounts"; upstream multi-device pairing (MIP-06) is absent from
  0.6.0. The account⇄device mapping is entirely Nostrautica's (21607 +
  `marmot_chat_keys`), which is the right place for it.
- `proposeRemoveUser(pk)` removes **all leaves of a pubkey** in one commit
  (`chat/mls.ts:157-173`) — revocation stays one call per key.
- Admin set is updatable post-creation via `proposeUpdateMetadata({adminPubkeys})` —
  relevant for the separate second-admin recovery item (D-2), not needed for multi-device.
- The **rejected alternative** — one shared pubkey with multiple leaves ("client slots") —
  is MLS-legal but fights the library: the eligibility helper flags `already a member`,
  both Nostrautica dedupe layers block it, and coordinator membership semantics
  (`isMember`, remove-all-leaves) would all need reworking. Per-device keys turn those
  same checks into the *correct* idempotency guarantees instead.

## 3. Coordinator-level feasibility

Better than expected — **the coordinator's data model is already multi-key-per-account**:

- `marmot_chat_keys` binds N chat pubkeys to one account per event, PK
  `(coordinate, chat_pubkey)`, first-binder-wins with rebinding refused
  (`store/db.ts:1334-1360`, COORD-10).
- `authorizedIdentities`/`eligibleChatAuthors` already return
  `[accountPubkey, ...allActiveChatKeys]` (`chat/admin.ts:110-131`); key-package intake,
  sync-on-approval, and the 30443 watcher all iterate that set.
- Per-key revoke (`admin.ts:276-295`) and whole-attendee revoke (removes account key +
  every attested key, `admin.ts:305-314`) are already per-device-shaped.

What the coordinator is missing is exactly what PROTOCOL-NIP §10.2 adds:
**proof of possession in 21607** (today `ChatHandoffCard.svelte:36-57` will attest any
npub the user types — griefing/mis-binding becomes worse, not better, once devices
multiply), plus a per-account device cap (`MAX_CHAT_KEYS_PER_ACCOUNT = 10`) and the roster
`chat_keys` array.

## 4. Target design

Normative wire details in `PROTOCOL-NIP.md` §10. Summary of the moving parts:

1. **Every device mints its own chat keypair on first chat use — all account types.**
   Local-nsec accounts stop chatting as their account key ([DECISION D3]; see §6 for the
   interop trade-off). The key lives only in that device's IndexedDB; it is never
   backed up, exported, or restored. `client_id` stays as the per-device 30443 slot id.
2. **Attestation with proof of possession** (21607 v2): account-sealed
   `{op, chat_pubkey, label, client_id, proof}` where `proof` is a schnorr signature by
   the device key over a domain-separated digest. `revoke` per device key; full attendee
   revocation removes all of the account's leaves (unchanged).
3. **Roster carries `chat_keys: [{pubkey, label?, added_at}]` per attendee** (replacing
   the never-populated singular `chat_pubkey`), so Nostrautica clients dedupe the member
   list by account, show "Alice (2 devices)", and can render per-device revoke UI for the
   user's own devices. Display-name resolution keeps the existing kind-0-by-sender-pubkey
   path (`EventChat.svelte:241-264`) as fallback — it is already per-device-agnostic.
4. **Device kind-0 on chat relays**: each device key publishes a kind-0 (name = account
   display name) so external Marmot clients (White Noise) show humans instead of hex.
   This generalizes what the app already does for remote-signer chat keys
   (`identity.ts:406-424` publishes `"Nostrautica <name> (chat)"` with the account npub
   in `about`, to the event relay set including the Whitenoise relays). Per resolved
   decision D4, v2 **keeps the account npub in `about`** (external clients can verify and
   group devices by account; the public device→account link is accepted) and scopes
   publication to the chat relay set only.
5. **Chat-device-key backup (31602 variant) retired.** Nothing to restore ⇒ App-11
   (fail-open restore) and App-12 (backup convergence) are deleted, not fixed. A "lost
   device" is handled by revoking its key from any other logged-in device (or by the
   fact that event chats are time-bounded anyway).
6. **Relays**: chat traffic uses event relays ∪ the chat interop set. The
   `["chat_relay", …]` 31600 tag anticipated here shipped on 2026-07-28 — the interop
   relays are no longer unioned into `config.relays`, because they reject every kind
   outside the Marmot/NIP-17 chat surface (see NIP §"Event Networking Config").
7. **Welcome/joining**: unchanged per device — each device publishes its own 30443, the
   coordinator invites it, the Welcome arrives gift-wrapped to its 10050 relays, and the
   device joins with its own leaf. The unbound-candidate routing rule (NIP §10.4) applies
   per device.
8. **Multi-tab (H-7) is orthogonal and remains required.** Two tabs in one browser
   profile are one device sharing one IndexedDB state store (`chat/stores.ts:179-235`) —
   per-device keys do not change that. Web Locks leader + BroadcastChannel proxy (or
   read-only secondary tabs as interim) ships alongside.

### What a user experiences

- Desktop: already chatting. Opens the event on their phone (same npub, any login
  method) → phone silently mints a device key, attests it (one signer approval for
  NIP-46), publishes its key package → coordinator adds it (seconds) → phone can chat.
  History starts from join; older messages simply aren't there (stated in UI).
- Members list shows one entry per person. Other Marmot clients show one entry per
  device with the same display name (upstream has no account grouping — accepted).
- Settings → Chat devices: list of own devices with labels, "remove this device".

## 5. Change list (from the verified assumption-site inventory)

App:

- `chat/identity.ts` — delete restore-before-mint orchestration (:130-202), fail-closed
  lock dance (:174-179), backup marker (:80-88, 210-224); mint-per-device becomes the
  only path; local-nsec branch (:376-380) switches to device keys per D3; storage key
  stays `__chat_device_key__\x1f<account>` (each physical device holds only its own).
- `chat/device-key-backup.ts` — deleted (schema variant retired from
  `protocol/schemas.ts:376-383`).
- `chat/attest.ts` + `ChatHandoffCard.svelte` — attestation gains `label` + `proof`;
  the QR "hand off shared key" flow is superseded by "add this device"; "link existing
  npub" (external Whitenoise key) must now present a proof, so it becomes a
  challenge-response QR (external client signs the challenge) or is dropped [D4-adjacent
  sub-decision].
- `EventChat.svelte` / roster UI — dedupe members by roster `chat_keys`; device
  management UI in settings.
- Multi-tab leader election (H-7) — new, `navigator.locks` + BroadcastChannel.

Protocol:

- `schemas.ts` — 21607 v2 shape (+`label`, +`proof`, drop `.optional()` client_id?);
  roster `chat_keys` array; retire `chatDeviceKeyBackupSchema`; constants
  `MAX_CHAT_KEYS_PER_ACCOUNT = 10`, `MAX_CHAT_KEY_LABEL = 60`.
- `crypto.ts` — domain-separated chat-device challenge builder + verifier (shared with
  the invite-proof v2 helper style).

Coordinator:

- `chat/admin.ts` — verify `proof` on `op:add` (:245-264); enforce per-account key cap;
  populate roster `chat_keys` in `publishRoster` (`coordinator.ts:1107-1126`).
- No changes to add/invite/remove mechanics — the pubkey dedupe layers stay, now as
  idempotency guarantees.

## 6. Trade-offs and risks

- **Local-nsec interop regression (D3):** today a local-nsec user appears in White Noise
  as their real npub and could continue the chat there with the same identity. Under
  per-device keys they appear as a device key like everyone else. Mitigation options:
  (a) accept — event chat is app-scoped and time-bounded (recommended, simplest, one
  model for everyone); (b) keep account-key chat for local-nsec users only — preserves
  interop but keeps the one-leaf wall for exactly that cohort, so their multi-device
  story stays broken.
- **Member-list noise in external clients:** N devices = N same-named members outside
  Nostrautica. Accepted; upstream MIP-06-style grouping can adopt later.
- **More MLS members** = marginally larger group state and more Welcome/add commits.
  Capped at 5 devices/account; negligible at conference scale (≤ 2000 × 5 leaves is far
  below MLS practical limits, and real usage is 1–2 devices).
- **Coordinator remains sole admin** — unchanged risk (D-2 second-admin recovery is a
  separate roadmap item; `proposeUpdateMetadata({adminPubkeys})` makes it possible).
- **No history on new devices** — inherent to MLS; must be stated in the device-add UI so
  it reads as design, not data loss.

## 7. Migration

Test users only ⇒ no compatibility path needed (flag day with wire v2):

1. Ship protocol v2 schemas (21607 v2, roster `chat_keys`, backup schema retired).
2. Coordinator: proof verification + cap + roster population. Existing groups keep
   working — current members were added under v1 rules; new adds require v2 attestations.
3. App: mint-per-device identity; delete restore/backup paths; device UI; H-7 leader
   election.
4. Existing attested keys: keep honoring stored bindings (they were first-binder-wins
   verified); optionally require re-attestation with proof on next session for hygiene.
5. Delete stale 31602 chat-backup events best-effort (NIP-09) on first v2 session.
