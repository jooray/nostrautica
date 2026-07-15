# Nostrautica Code Quality, Design, and UX Audit

Date: 2026-07-15

Scope: read-only review of the repository, all files under `docs/`, the participant and organizer screenshots, the Svelte PWA, shared protocol package, coordinator, configuration, and committed tests. No application code was changed as part of this audit.

This document audits the current code, not only the intended specification. Existing review documents were treated as evidence, then checked against the current implementation. This matters because some findings in `ENCRYPTION-AND-PRIVACY.md` are already fixed in code: coordinator event keys are now encrypted at rest in `packages/coordinator/src/store/db.ts:11-17,149-188`, and coordinator installation grants are now authenticated in `packages/coordinator/src/coordinator.ts:343-359`. Those two items should be removed or marked resolved in that review.

**[STATUS 2026-07-15: verified — both referenced fixes are in the tree as described (store/db.ts at-rest key encryption; coordinator.ts:343-359 authenticates 21603 against E_id), and ENCRYPTION-AND-PRIVACY.md has since been updated with dated FIXED markers for F1-F3 by the in-flight encryption-fixes work. No action needed here.]**

## Executive assessment

Nostrautica has a strong and unusual core idea: use a portable Nostr identity and private event data to turn networking into concrete, personalized introductions. The split between the event signing identity and submission inbox is thoughtful, the privacy model is more explicit than in most early products, and the participant journey is already coherent enough for the product story to land in screenshots and end-to-end testing.

The app is not yet ready to make its strongest reliability and recovery claims. The most important current defects are identity-unscoped local event keys, unauthenticated grants in the PWA, coordinator SSRF/resource-exhaustion exposure, stranded jobs after a crash, and incomplete relay-based key recovery. These are foundation issues. Fixing them has higher value than adding chat, custom themes, more AI models, or more event-page features.

The largest product opportunity is to stop presenting Nostrautica as a collection of pages and make it feel like an active event companion. The app should always answer three questions:

1. What do I need to do next?
2. Who should I meet next, and what should I say?
3. What have I accomplished at this event?

The current ranked match list answers only part of the second question. A guided readiness journey and clearer access to Matches would make the product easier and more useful at the venue. The broader personal meeting-plan redesign is deferred under U2.

## What is already strong

- The `E_id` and `E_inbox` separation is a sound architectural choice that limits coordinator authority without blocking pre-approval submissions (`docs/SPECIFICATION.md:108-121`).
- Crypto is centralized in the protocol package, NIP-04 is banned, and the project uses standard NIP-44/AES-GCM primitives rather than custom cryptography.
- The product openly documents forward-only revocation and coordinator trust instead of implying impossible guarantees (`docs/SPECIFICATION.md:67-73`).
- The PWA is genuinely static and communicates through Nostr and Blossom rather than hiding a conventional application API behind decentralized terminology.
- The event page uses understandable labels such as “Invite or organizer approval” and “AI matchmaking” rather than raw config values (`packages/app/src/lib/pages/EventHome.svelte:105-115`).
- The event page already changes its primary CTA based on whether an intro exists (`packages/app/src/lib/pages/EventHome.svelte:123-153`).
- English and Slovak localization are broadly implemented, including plural handling.
- Standard controls generally have visible focus states and 44 px minimum dimensions (`packages/app/src/lib/styles/app.css:84-87,133-147,187-201`).
- Markdown follows an escape-first model instead of accepting arbitrary raw HTML (`packages/app/src/lib/social/markdown.ts:12-45,142-159`).
- The inline revoke confirmation states the real consequence in human language rather than describing key rotation (`packages/app/src/lib/pages/Admin.svelte:564-584`).
- The full five-persona flow has been exercised against local and real relay infrastructure, which is much better than relying exclusively on unit tests (`docs/testing/TEST-REPORT-2026-07-13.md`, `docs/testing/RELAY-AND-KINDS-CHECK-2026-07-13.md`).

## Priority order

**[STATUS 2026-07-15: broadly sound ordering; superseded in detail by the "Implementation plan (2026-07-15)" appended at the end of this document, which sequences around in-flight work (P9 event customization, encryption fixes, chat re-spec) and owner decisions.]**

The recommended order is:

1. Protect identity and event-key custody.
2. Authenticate every grant at the receiving boundary.
3. Harden coordinator media ingestion and job recovery.
4. Make attendee, organizer, and coordinator state recoverable from durable relay data.
5. Fix revocation, matching configuration, and live config correctness.
6. Redesign onboarding around explicit progress and one next action.
7. Improve the existing Matches experience; defer the personal meeting-plan redesign in U2.
8. Redesign organizer admin as an event operations console.
9. Complete accessibility and async failure handling.
10. Only then expand into chat, custom event pages, or additional provider complexity.

---

## Critical findings

### C1. Event secrets are shared across every identity using the same browser

**[STATUS 2026-07-15: confirmed, to implement — plan step P0.2. Verified: records keyed by coordinate only (keystore.ts:32), no keystore API takes the active pubkey, logout clears only the signer keystore (session.svelte.ts:126) so event keys leak across identities; join-sent, recent-events and the outbox are also unscoped. Owner's inline note below is honored in the plan: key by owner AND add a durable self-encrypted relay backup (key loss is worse than shared-browser leakage), keep records across logout, no migration of old records.]**

**Evidence:** Event records are keyed only by event coordinate and can contain ECKs plus organizer `E_id` and `E_inbox` secret keys (`packages/app/src/lib/events/keystore.ts:15-33`). Reads and writes do not take the active user's pubkey (`packages/app/src/lib/events/keystore.ts:40-93`). Logout clears the identity signer but not `nostrautica-eventkeys` (`packages/app/src/lib/signer/session.svelte.ts:116-129`).

**Impact:** On a shared browser, user B can log in after user A and inherit A's attendee decryption keys or organizer custody. `isApproved()` can report B as approved because A was approved. Organizer keys allow much more severe event impersonation and submission access.

**Recommendation:** Key every event record by `(ownerPubkey, coordinate)` and require the active pubkey for all key-store operations. Start with a new owner-scoped store rather than migrating the unused pre-release records. Keep identity-owned records across logout, but never expose them to another active identity. Apply the same ownership rule to pending joins, recent events, outbox entries, private notes, and any future MLS state, and back up event custody to durable self-encrypted relay records.

Comment: Make sure the keys are backed up. Maybe just key them and keep them. Key loss is worse than permissions issue on a shared browser. No need to think about migration, just implement what's good, no one is using it now, so no need to do difficult data migrations.

**Specifics:**

- Replace `nostrautica-eventkeys` in `packages/app/src/lib/events/keystore.ts` with a new IndexedDB database/version whose primary key is `[ownerPubkey, coordinate]`; do not read, copy, or migrate records from the old database.
- Require a normalized 64-character active identity pubkey in every keystore read/write/delete API and propagate it through `attendee.ts`, `organizer.ts`, `create.ts`, `onboarding.ts`, and their page callers; reject a coordinate whose author does not match stored organizer custody.
- Keep identity-scoped records across logout. Never enumerate another owner's records into session state, and clear only in-memory decrypted values when `session.svelte.ts` logs out or switches pubkeys.
- Scope `join-sent`, recent-event membership, publish queue/outbox, private notes, relationship state, and install markers by owner pubkey; browsing-only recent history may remain device-local but must not grant approval or custody.
- Add a durable self-encrypted backup record per event, signed by the owner identity and containing `{v, coordinate, role, ecks, organizer_keys?, updated_at}`; encrypt to the same identity, publish to configured recovery relays, and restore only after signature, author, coordinate, and payload validation.
- Resolve concurrent devices by unioning ECKs by version and accepting organizer keys only when they derive the coordinate's `E_id`/`E_inbox`; never let an older backup delete newer keys, and expose backup status plus retry before claiming recovery is complete.
- Test two identities in one browser, logout/login, failed backup publication, clean-device restore, concurrent backup writes, malformed self-encrypted records, and organizer recovery. Acceptance: neither identity can read or use the other's local records, records survive logout, and a clean browser can recover custody from durable backups.

### C2. The PWA accepts forged attendee and organizer grants

**[STATUS 2026-07-15: implemented 2026-07-15 — plan step P0.1. `receiveGrants()` (packages/app/src/lib/events/attendee.ts) now authenticates every grant before any keystore write: `authenticateOrganizerGrant` requires the seal author (bound to rumor.pubkey by signerUnwrap) to be the coordinate's E_id, `granted_by === rumor.pubkey`, and the organizer secrets to derive E_id + the declared inbox; `authenticateKeyGrant` fetches the signed 31600 and accepts only E_id or the currently configured coordinator as author with matching `granted_by`. Forged grants are ignored with a console warning. Covered by packages/app/src/lib/events/attendee.test.ts (15 cases: forged seal, wrong event, stale coordinator, mismatched granted_by, bad key derivation, valid organizer/coordinator, end-to-end unwrap+auth). Was: confirmed, to implement. NOTE: this is the PWA-side gap, NOT the coordinator-side 21603 install auth (already in the tree).]**

**Evidence:** `receiveGrants()` unwraps `21605` and stores full organizer custody without checking that the verified seal author is the coordinate's `E_id` (`packages/app/src/lib/events/attendee.ts:57-79`). It accepts `21602` grants without checking the seal author against `E_id` or the current configured coordinator (`packages/app/src/lib/events/attendee.ts:81-94`). The payload's `granted_by` is parsed but not used (`packages/protocol/src/schemas.ts:99-105`).

**Impact:** Any Nostr user can poison a victim's local state with attacker-selected event keys. A forged organizer grant can make the UI expose false administration state and store attacker-controlled secrets. A forged attendee grant can create false approval and prevent legitimate content from decrypting.

**Recommendation:** For `21605`, require `rumor.pubkey === parseCoordinate(grant.a).pubkey` and `granted_by === rumor.pubkey`. For `21602`, fetch and validate the event's signed `31600`, then require the author to be either `E_id` or its current coordinator. Validate the coordinate kind and author relationships. Add negative tests for arbitrary senders, old coordinators, wrong events, and mismatched `granted_by`.

**Specifics:**

- In `packages/app/src/lib/events/attendee.ts`, make `receiveGrants()` parse the gift-wrap/seal/rumor through protocol schemas before any keystore mutation; require kind `21605` or `21602`, the outer gift wrap's `p` equal to the active pubkey, and `a` parseable as a kind `31923` event coordinate.
- For `21605`, require valid seal/rumor signatures, `rumor.pubkey === coordinate.pubkey`, `payload.granted_by === rumor.pubkey`, and organizer secret keys that derive exactly `coordinate.pubkey` and the payload's declared inbox pubkey.
- For `21602`, fetch the latest valid signed `31600` for the exact coordinate, parse it with strict config validation, and accept only a rumor author equal to `E_id` or the currently configured coordinator; `granted_by` must equal that author.
- Treat coordinator replacement as forward-only: reject an old coordinator for grants created after a newer config, but allow already authenticated stored grants to remain usable; deduplicate by outer event ID and `(coordinate, eckVersion)`.
- Do not write partial grants. Validate all key lengths, versions, coordinate relationships, and active recipient first, then commit one IndexedDB transaction and report invalid grants as ignored telemetry rather than approval.
- Extend `keymodel.test.ts`, `giftwrap.test.ts`, and attendee integration tests with arbitrary sender, wrong recipient/event/kind, mismatched `granted_by`, forged seal, stale coordinator, malformed key, and valid organizer/coordinator cases. Acceptance: only an authenticated current authority can change local custody.

### C3. Submitted media URLs expose the coordinator to SSRF and denial of service

**[STATUS 2026-07-15: confirmed, to implement — plan step P0.3. transcribe.ts:20 does a bare fetch with full-body arrayBuffer (hash checked only post-download), no timeout/size cap/IP guard; audio.ts spawns ffmpeg with no wall-clock or output limits; schemas.ts:18 accepts any URL scheme.]**

**Evidence:** Media descriptors accept any URL protocol (`packages/protocol/src/schemas.ts:16-27`). The coordinator performs direct `fetch(url)`, follows normal fetch behavior, buffers the whole body, and applies no timeout or byte limit (`packages/coordinator/src/pipeline/transcribe.ts:13-35`). Decrypted attacker-controlled files are passed to ffmpeg without a visible wall-clock or process-resource limit (`packages/coordinator/src/pipeline/audio.ts`).

**Impact:** An attendee can make the coordinator request loopback, private-network, metadata, or operator-only endpoints. Large, endless, or hostile media can exhaust memory, disk, CPU, or workers. Hash verification does not prevent blind SSRF or resource exhaustion because it happens only after the response is downloaded.

**Recommendation:** Allow only `https:` and preferably only configured Blossom origins. Resolve DNS and reject loopback, private, link-local, multicast, and reserved addresses on every redirect. Add request timeout, redirect cap, streamed byte limit, declared-size validation, and strict maximum media size. Execute ffmpeg with wall-clock, output-size, duration, and process limits in isolated temporary storage. Add adversarial integration tests.

**Specifics:**

- Tighten media descriptor schemas in `packages/protocol/src/schemas.ts` to `https:` URLs, positive bounded byte sizes, supported MIME types, 32-byte hashes/keys, and 12-byte nonces; expose limits through coordinator config with conservative hard ceilings.
- Replace direct `fetch()` in `packages/coordinator/src/pipeline/transcribe.ts` with a guarded downloader that allowlists configured Blossom origins, resolves every hostname, rejects non-public IPv4/IPv6 ranges, disables automatic redirects, and repeats validation for each of at most three redirects.
- Stream into a newly created mode-`0600` temporary file while hashing; abort on timeout, declared-size mismatch, content-length over limit, streamed bytes over limit, unsupported content type, or hash mismatch, and remove partial files in `finally`.
- In `pipeline/audio.ts`, spawn ffmpeg without a shell in a per-job temporary directory, restrict accepted streams/codecs, cap input duration and output bytes, apply a wall-clock kill timer, and terminate the process group on timeout or cancellation.
- Classify policy rejection as permanent input failure and transient DNS/network failure as bounded retryable failure; never include fetched body, credentials, private address details, or decrypted paths in attendee-visible errors.
- Add integration tests with loopback, RFC1918, link-local, IPv6 local, DNS rebinding/redirect, endless stream, oversized/chunked body, false size, slow response, decompression/codec bomb fixture, ffmpeg hang, and valid allowlisted Blossom media. Acceptance: resource limits hold and no disallowed endpoint receives a request.

---

## High-severity engineering findings

### H1. A coordinator crash can strand a job forever

**[STATUS 2026-07-15: confirmed, to implement — plan step P0.4. claimNextJob (db.ts:525-534) flips pending to running with no lease/worker-token columns; no startup reset of running jobs exists anywhere, so a crash strands the job permanently.]**

**Evidence:** Claiming a job permanently changes it from `pending` to `running` (`packages/coordinator/src/store/db.ts:525-533`). The runner selects only pending jobs. There is no lease, owner token, startup reset, or expired-running recovery (`packages/coordinator/src/pipeline/jobs.ts:39-80`).

**Impact:** A crash after claim and before completion can permanently stop an attendee's processing or match publication. `pendingJobCount()` continues counting the job, but no worker can claim it.

**Recommendation:** Add `claimed_at`, `lease_until`, and a worker token. Claim atomically inside a transaction. Reset expired jobs at startup and periodically. Test a real persisted database by terminating execution immediately after claim, reopening it, and verifying eventual completion.

**Specifics:**

- Add nullable `claimed_at`, `lease_until`, and `worker_token` columns plus an index on `(state, lease_until, created_at)` in `packages/coordinator/src/store/db.ts`; migrate SQLite transactionally without changing completed/poison jobs.
- Make claim a single `BEGIN IMMEDIATE` transaction that selects one pending or expired-running job, sets `running` and a random worker token, and returns only the row successfully updated by that token. Increment attempts only after a handler returns a classified failure; lease expiry or process death must not consume a retry.
- Add token-checked heartbeat, complete, retry, and poison updates in `pipeline/jobs.ts`; a worker that lost its lease must discard its result and cannot overwrite the new owner's state.
- Recover expired leases on startup and on a periodic sweep; use a lease longer than normal heartbeat jitter, cap retries as today, and make shutdown stop claims while allowing active workers a bounded drain period.
- Keep expensive stages idempotent so a lease expiry can safely repeat work, and record sanitized recovery diagnostics without exposing attendee plaintext.
- Test two competing workers, crash immediately after claim against an on-disk DB, lease heartbeat, stale-owner completion, clock-boundary expiry, graceful shutdown, and eventual poison. Acceptance: every recoverable job reaches completion once logically and no job remains permanently `running`.

### H2. Multi-device and disaster recovery do not match the product's claims

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.1 (attendee backup itself lands with P0.2). Verified: grant scans use a 3-day floor (giftwrap.ts:93-94); the organizer eventkeys 30078 backup is written (create.ts:142-157) but no code ever reads it back; the coordinator restores installs from SQLite only, with the same 3-day gift-wrap scan.]**

**Evidence:** The spec says a fresh device reconstructs everything from the identity key (`docs/SPECIFICATION.md:93-95`). Grant scans query only the last three days (`packages/app/src/lib/events/attendee.ts:47-54`). Organizer event-key backups are written, but there is no corresponding restoration path. The coordinator also restores installed events only from SQLite and scans new installation wraps from the last three days (`packages/coordinator/src/coordinator.ts:831-860`).

**Impact:** A participant restoring an identity weeks later may not recover the ECK. An organizer can restore their Nostr identity but still lose event control. A wiped coordinator database cannot rediscover older installations. Old NIP-17 history has the same discoverability problem despite being described as recoverable on any device (`docs/SPECIFICATION.md:248-255`).

**Recommendation:** After authenticating a grant, publish a durable self-encrypted per-event key record that the attendee can query by their stable author. Implement organizer `nostrautica:eventkeys:*` restoration. Give the coordinator a self-encrypted installation registry or a supported full-history recovery procedure. Use three days for live overlap, not as the only recovery query. Test all recovery flows with records older than three days and a clean browser/database.

**Specifics:**

- Define a versioned self-encrypted recovery payload in `packages/protocol/src/schemas.ts`: `{v, type, coordinate, role, ecks, organizer_keys?, updated_at}` with exact key validation and no attendee profile/media content.
- After C2 authentication, have `attendee.ts`/`organizer.ts` merge and publish one identity-authored replaceable recovery record per coordinate to the user's configured relays; organizer restoration must also consume the existing `nostrautica:eventkeys:*` backup format or replace it in one documented cutover.
- Query recovery records by stable identity author with no three-day lower bound during explicit restore; retain the bounded scan only for live grant overlap, validate signatures and self-encryption recipient, and merge ECK versions monotonically.
- Add a coordinator self-encrypted installation registry containing coordinate, inbox custody reference, relay set, and last config event ID; restore into an empty SQLite database only after verifying the coordinator identity and current signed `31600` assignment.
- Show `Backed up`, `Backup pending`, and `Recovery failed - retry` in event/account UI; do not claim another device is recoverable until required relay acknowledgements are obtained, and preserve local records across logout.
- Test attendee, organizer, and coordinator recovery from records older than three days, empty browser/DB, relay disagreement, duplicate/out-of-order backups, wrong identity, corrupt ciphertext, and coordinator replacement. Acceptance: authorized custody is reconstructed without accepting stale authority or relying on SQLite/local IndexedDB.

### H3. Revocation makes remaining users' match lists disappear

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.2. revokeAttendee (coordinator.ts:763-798) re-grants keys and republishes directory/roster but never match lists or the matrix; the blinded d derives from the rotated ECK (publisher.ts:86), so remaining attendees' lists vanish.]**

**Evidence:** A match-list `d` is derived from the current ECK (`packages/coordinator/src/nostr/publisher.ts:79-98`). Revocation rotates the ECK and republishes grants, directory entries, and roster, but does not republish match lists (`packages/coordinator/src/coordinator.ts:763-798`). The client immediately queries using its newest ECK (`packages/app/src/lib/events/attendee.ts:178-190`).

**Impact:** After any revocation, remaining attendees compute a new address where no match list exists. Matches disappear until some later operation happens to republish them.

**Recommendation:** Republish every remaining attendee's cached match list under the new blinded address immediately after rotation, without rerunning the LLM. Republish the optional event matrix too. Add a test proving remaining attendees retain matches while the revoked attendee cannot discover post-rotation output.

**Specifics:**

- Persist the canonical per-attendee match payload and optional matrix independently of their encrypted publication in `store/db.ts`, keyed by coordinate, source revision, and recipient pubkey.
- In the revocation transaction in `coordinator.ts`, rotate the ECK, publish grants/roster/directory, then call `nostr/publisher.ts` to re-encrypt cached matches under each remaining attendee's new blinded `d`; never invoke embedding or LLM providers.
- Publish the `31606` matrix under the new ECK only when configured visibility is `event`; omit the revoked pubkey and any pairs involving it before encryption.
- Track rotation publication per recipient so retries are idempotent; a partial relay failure remains retryable and visible in coordinator health rather than rolling back already delivered grants.
- Add coordinator tests for no provider calls, unchanged match content, new `d` values, revoked-user exclusion, matrix on/off, partial publish retry, and app reads during mixed relay propagation. Acceptance: remaining users continuously recover their newest valid list and revoked users cannot locate/decrypt post-rotation output.

### H4. `matching=off` is not honored and the event match matrix is not published

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.3. `matching` is parsed in protocol config (config.ts:94) but never read into EventState; matchVisibility is stored and only logged; buildMatchMatrix (publisher.ts:104-124) is defined and never called, so 31606 is never published.]**

**Evidence:** Coordinator state records `matchVisibility` but not the `matching` setting (`packages/coordinator/src/coordinator.ts:293-307`). Processing enqueues matching unconditionally. A matrix publisher exists, but no current coordinator call uses it. The spec describes both controls as functional (`docs/SPECIFICATION.md:202-220,325-333`).

**Impact:** Events that disable matching can still send participant data to an LLM and incur cost. Events selecting event-visible scores never receive the promised matrix.

**Recommendation:** Carry `matching` into event state and define precisely which AI stages are disabled with it. Skip provider calls when off. Publish `31606` when visibility is `event`. Test config modes by asserting provider call counts and published event kinds.

**Specifics:**

- Add typed `matching` and `matchVisibility` fields to installed-event persistence and runtime state in `coordinator.ts`/`store/db.ts`, populated only from a validated signed `31600`.
- Define `matching=off` as disabling all AI/provider processing for the event: no media download, ffmpeg, STT, public-Nostr summarization, profile/translation LLM, embeddings, pair scoring, match lists, or matrix. Approval, ECK grants, authored profile/media directory publication, and roster publication continue without derived AI fields.
- Gate job enqueue and execution so stale queued match jobs re-check current config and exit without provider calls when matching is off.
- When matching is on, publish private attendee match lists as now and call the existing matrix publisher only for `matchVisibility=event`; remove/replace an obsolete matrix when visibility changes away from event.
- On off-to-on, enqueue missing current-revision match work once; on visibility-only changes, republish from cached scores without rerunning models where possible.
- Add a config-mode table test asserting job types, provider invocation counts, kinds `31605`/`31606`, toggles during queued work, and restart persistence. Acceptance: no matching provider sees attendee data while matching is off.

### H5. Coordinator behavior freezes at installation-time configuration

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.4. Only gift-wrap inbox subscriptions exist (coordinator.ts:856-874); there is no kind 31600 subscription, so config changes require reinstall/restart.]**

**Evidence:** Config is loaded in `installEvent()` and copied into memory (`packages/coordinator/src/coordinator.ts:275-312`). Runtime subscriptions cover the coordinator inbox and each event inbox, but not current `31600` config (`packages/coordinator/src/coordinator.ts:831-874`). This differs from the subscription design in `docs/SPECIFICATION.md:440-445`.

**Impact:** Changes to language, matching, visibility, Nostr context, relay set, and other event behavior may not take effect. Relay changes can leave the coordinator listening and publishing to stale infrastructure.

**Recommendation:** Subscribe to authenticated replaceable config events for each `E_id` and `d`. Validate newer events, update stored and in-memory state atomically, replace relay subscriptions where needed, and trigger only the recomputation implied by changed fields.

**Specifics:**

- In `coordinator.ts`, maintain a subscription for kind `31600` authored by each installed `E_id` and matching its `d`; verify event ID/signature, coordinate, schema, assignment, and strictly newer replaceable ordering before applying it.
- Store the accepted config event ID, timestamp, and normalized config in one DB transaction, then swap the in-memory snapshot; on restart, revalidate stored config before use.
- Diff fields into effects: language/prompt context invalidates profiles and matches, matching/visibility follows H4, coordinator assignment initiates safe detach, and display-only changes require no AI work.
- For relay changes, connect and subscribe to the new set before retiring old subscriptions, retain overlap long enough for catch-up, deduplicate by event ID, and keep the previous healthy set if the replacement cannot connect.
- Serialize config application per event and resolve equal timestamps deterministically by Nostr replaceable-event rules; stale or malformed events are ignored and surfaced as health diagnostics.
- Test config updates before/after restart, stale/forged/wrong-`d` events, rapid concurrent updates, relay handover failure, minimal recomputation, and coordinator removal. Acceptance: runtime behavior reflects the latest authenticated config without an inconsistent intermediate state.

### H6. Model-provider selection is advertised per role but implemented globally

**[STATUS 2026-07-15: partially true, to implement — plan step P1.9. Model IDs are already per role (config.ts:55-66) and STT is a separate instance, but one global LLM provider object is built in main.ts:90-107 and injected into every stage — per-role *provider* selection does not exist. Related owner decision: the reference deployment intentionally runs the match model on a non-private Venice tier (accepted); per-role providers make that an explicit choice rather than an accident.]**

**Evidence:** Config gives summary, match, and embedding models separate provider fields (`packages/coordinator/src/config.ts:17-21,55-66`). Startup selects one LLM instance and passes it to all stages (`packages/coordinator/src/main.ts:89-143`). The spec promises provider selection by model role (`docs/SPECIFICATION.md:518`).

**Impact:** A mixed Venice/Routstr configuration silently routes data and model IDs to the wrong provider. This can break requests and violate operator privacy or cost expectations.

**Recommendation:** Build a provider registry and resolve each model role to its declared provider. Validate model availability and structured-output/privacy capabilities at startup. Fail closed instead of silently changing routing.

**Specifics:**

- In `providers/types.ts`, define role capabilities for `summary`, `match`, `embedding`, and `stt`; build provider instances by configured name in `main.ts` rather than injecting one global LLM.
- Validate every role's provider/model pair in `config.ts`, including required embeddings or structured JSON support, privacy mode, credentials, endpoint scheme, and payment implementation.
- Pass a typed role resolver into `pipeline/profile.ts`, matching, and transcription; include provider and exact model ID in artifact/cache keys and operational status.
- Fail startup for unknown providers/models or unsupported capabilities and fail an individual event closed if live config requests an unavailable operator capability; never fall back to another provider implicitly.
- Keep provider-specific request/response logic behind the common interfaces and redact credentials, prompts, and participant text from capability errors.
- Test mixed Venice/Routstr roles, wrong model on a valid provider, missing credentials, unsupported embedding/JSON capability, cache separation, and zero cross-provider fallback. Acceptance: each request reaches exactly the provider declared for that role.

### H7. Expensive profile work is not independently content-addressed

**[STATUS 2026-07-15: partially true, to implement — plan step P1.7. Transcripts (by blob sha256), Nostr summaries and pair scores are already content-hash cached in SQLite; the assembled ai_profile and the translations added in 22538c0 are not — profileInputsHash (profile.ts:62) exists but is unused, so reprocessing re-bills profile assembly and translation.]**

**Evidence:** A profile input-hash helper exists but is not used as a persistent artifact key (`packages/coordinator/src/pipeline/profile.ts:61-69`). The database has attendee output columns but no profile artifact table (`packages/coordinator/src/store/db.ts:47-57`). A failure after profile generation can rerun the LLM on retry.

**Impact:** Translation, publication, or process crashes can rebill completed profile work, contradicting the documented idempotency guarantee.

**Recommendation:** Cache profile and translation artifacts separately. Include canonical inputs, provider, model, prompt/schema version, event language, and source hashes in each key. Persist each expensive stage before starting the next one.

**Specifics:**

- Add a `pipeline_artifacts` table in `store/db.ts` keyed by SHA-256 of stage plus canonical JSON inputs, with stage, provider, model, prompt/schema version, source hashes, output JSON, created time, and validation status.
- Split `pipeline/profile.ts` into independently looked-up transcript-derived profile and translation stages; canonicalize arrays/object keys and include event language and normalized Nostr-context IDs in hashes.
- Validate provider output before committing an artifact, commit it in its own transaction, and only then enqueue/start the dependent publication or matching stage.
- Use a uniqueness constraint plus insert-or-read behavior so concurrent duplicate jobs share one artifact; retain old immutable artifacts for rollback/audit but mark current attendee source revision separately.
- Never cache plaintext under an incomplete key, and apply the coordinator's encrypted-at-rest storage path to sensitive artifact output; at-rest encryption is already implemented and is not an open finding.
- Test crash after each provider response/commit boundary, concurrent identical jobs, prompt/model/language/source changes, invalid output, and retry. Acceptance: identical completed work causes no second billable call while any material input change creates a new artifact.

### H8. Cashu proofs are removed before a request has safely settled

**[STATUS 2026-07-15: implemented 2026-07-15 — plan step P1.8. Added a durable `cashu_journal` table (new table + methods in store/db.ts, leaving the F1 encrypted-column logic untouched) with states in_flight/settled/ambiguous keyed by request id; proof JSON reuses the existing at-rest NIP-44 protection. `CashuPayment.prepare()` journals the reservation BEFORE the proofs leave the wallet; `settle()` banks change and closes the reservation (idempotent); `reconcileJournal()` quarantines interrupted in_flight reservations as `ambiguous` on restart — never re-adding proofs to the wallet (no double-spend) and never dropping them (no loss). Covered by packages/coordinator/src/providers/cashu.test.ts (6 cases incl. crash-between-redeem-and-settle survives restart, idempotent reserve/settle, reconcile-to-ambiguous, at-rest encryption). FOLLOW-UP: wiring the journal into the CashuPayment constructed in main.ts is a one-line change deferred to avoid the in-flight main.ts edits (journal is an optional constructor arg; unused until wired). Was: confirmed, to implement.]**

**Evidence:** `CashuPayment.prepare()` removes selected proofs and writes the reduced wallet before the HTTP request succeeds; change is stored only in `settle()` (`packages/coordinator/src/providers/cashu.ts:60-89`).

**Impact:** A process crash or ambiguous network failure can orphan proofs from local wallet state, creating apparent or actual balance loss.

**Recommendation:** Journal proof states as available, in-flight, settled, or ambiguous under a transaction and request ID. Restore on definite pre-send failure; reconcile ambiguous proofs with the mint before reuse. Test crashes at each state transition and concurrent requests.

**Specifics:**

- Replace the single reduced-wallet write in `providers/cashu.ts` with a durable journal keyed by request ID and proof secret, using states `available`, `in_flight`, `ambiguous`, `spent`, and `change_pending`.
- Reserve proofs atomically before sending and prevent overlapping requests from selecting reserved proofs; persist request amount, mint, quote/token identifiers, and timestamps without logging proof secrets.
- Return proofs to `available` only when failure is provably before transmission; after timeout, disconnect, or crash post-send, mark `ambiguous` and query the mint's proof state before reuse.
- In `settle()`, atomically mark inputs spent and insert validated change proofs; on startup reconcile all nonterminal requests and keep unavailable proofs quarantined if the mint cannot answer.
- Make request IDs stable across provider retries so a retry cannot reserve a second payment accidentally, and expose operator-visible balance by available/in-flight/ambiguous totals.
- Test crashes before reserve commit, before send, after send, before change commit, concurrent reservations, duplicate settle, mint outage, and spent/unspent reconciliation. Acceptance: no proof is silently lost or spent twice.

### H9. The strongest product promise overstates matching completeness

**[STATUS 2026-07-15: split. The copy fix is confirmed and to implement — plan step P2.1: SPECIFICATION.md:18 and ELEVATOR-PITCH-en.md:17 still say "scores every pair" while the implementation prefilters above 50 attendees (top-30 cosine + random-10, prefilter.ts:29-61; matcher.ts:37-51 batched K=10). The algorithmic recommendation (all-pairs deterministic scoring) is DECLINED BY OWNER: the benchmarked winner (deepseek-v4-flash + BP3 + K=10 batched) was deliberately adopted in production on 2026-07-14. Fix the claim, keep the algorithm; recall metrics for the benchmark are a reasonable optional add-on, not scheduled.]**

**Evidence:** The pitch says the coordinator scores every pair (`docs/SPECIFICATION.md:18`; `docs/ELEVATOR-PITCH-en.md`). Above 50 attendees, the implementation design prefilters by embedding similarity plus a random low-similarity sample (`docs/SPECIFICATION.md:469-478`).

**Impact:** “Every pair” is a concrete, testable claim that is false at larger events. The prefilter may omit the best complementary match, particularly because complementarity is not the same as embedding similarity.

**Recommendation:** Change the promise to “evaluates the strongest candidates for every attendee,” or calculate a cheap deterministic score for all pairs and reserve LLM reasoning for finalists. Measure candidate recall, especially for complementary low-similarity pairs and attendees with sparse profiles.

**Specifics:**

- Update `SPECIFICATION.md`, both elevator pitches, participant/organizer guides, and product UI to use one accurate claim; do not retain “scores every pair” unless the implementation actually evaluates all pairs.
- Prefer an all-pairs deterministic candidate score in `matching/prefilter.ts` using bounded profile signals, then run LLM reasoning only for a documented finalist count per attendee; retain a small exploration sample for low-similarity complementarity.
- Define completeness metrics in `MATCHING-BENCHMARK.md`: candidate recall against an exhaustive labeled set, reciprocal coverage, sparse-profile coverage, complementarity recall, and compute/cost by event size.
- Version the candidate algorithm and include it in match artifact keys so old and new results cannot be conflated.
- Test 2, 50, 51, 100, and 200 attendees, deterministic ties, sparse profiles, complementary low-embedding pairs, and fixed random seeds. Acceptance: copy matches measured behavior and the benchmark reports recall rather than implying exhaustive LLM scoring.

### H10. Privacy and consent copy overstates who can access intro content

**[STATUS 2026-07-15: confirmed, to implement (copy + pre-submit disclosure) — plan steps P2.1 and P2.2. PARTICIPANT-GUIDE.md:76-77 and :155-158 still claim only attendees can ever see intros; Record.svelte has no pre-upload disclosure; no per-participant nostr-context opt-out exists in the submission schema (schemas.ts:83-90 is {v, profile, media}). Disclosure must also state the owner-accepted non-private match-model tier. The per-participant Nostr-history opt-out is an owner question (see plan).]**

**Evidence:** The participant guide says nobody outside event attendees can ever see an intro (`docs/PARTICIPANT-GUIDE.md:70-77`). The coordinator decrypts all media, and STT/LLM providers receive plaintext-derived content (`docs/SPECIFICATION.md:67-73`). The organizer guide also understates coordinator power even though it issues grants and authors roster, directory, and matches.

**Impact:** Users cannot give informed consent if processing parties and capabilities are described inaccurately. This is particularly important for faces, voices, biographies, inferred interests, and pairwise recommendations.

**Recommendation:** State that approved attendees, the organizer-selected coordinator, and configured processing providers can access the data required for their roles. Explain whether raw video, audio, transcript, or profile text reaches each provider. Add an explicit pre-submission disclosure and allow participants to opt out of public-history enrichment.

**Specifics:**

- Create one data-flow disclosure source used by `PARTICIPANT-GUIDE.md`, `ORGANIZER-GUIDE.md`, event privacy UI, and the pre-submit step in `Record.svelte`; name the coordinator operator and configured STT/LLM providers where known.
- Present a compact table for raw video, extracted audio, transcript, authored profile, inferred profile, Nostr history, matches, and retention, identifying organizer/attendee/coordinator/provider access for each.
- Before upload, require an unchecked confirmation with copy equivalent to “The event coordinator and its listed processing providers will process this intro”; link details without making consent contingent on public-history enrichment.
- Add an event-scoped `use_nostr_context` participant choice defaulted according to an explicitly documented policy; send it in the submission payload and ensure coordinator fetch/cache hashes honor false.
- If provider/config disclosure is unavailable or changes materially before processing, pause submission/processing and ask for confirmation rather than silently broadening data recipients.
- Test both locales, keyboard/screen-reader flow, context opt-out causing zero history fetches, provider-change handling, and normal/talk/text/audio inputs. Acceptance: no guide or UI says only attendees can access content, and observed network calls match the disclosure.

---

## Product and UX findings

### U1. The app lacks a persistent “next best action” journey

**[STATUS 2026-07-15: partially true, to implement — plan step P2.6. EventHome already has the state-aware CTA including "Record your intro" as primary when approved without an intro (EventHome.svelte:123-153); the real gaps are the Join approved screen (only "See who's here", Join.svelte:281-287) and the absence of a shared readiness model. Audit's specifics are mistaken on one point: events/onboarding.ts is a kind-0/kind-3 profile-merge helper, not a journey module — a new module is needed.]**

**Evidence:** Join, backup, record, processing, and matches are separate screens with no shared readiness model. The event home has a state-aware CTA, but the approved Join screen sends the user only to the attendee list (`packages/app/src/lib/pages/Join.svelte:281-293`).

**Impact:** Users can believe onboarding is complete after approval, browse people, and never record the intro required for matching. They must infer why no matches exist.

**Recommendation:** Add a compact event readiness journey: Joined, account backed up, intro submitted, processing, and matches ready. Show one prominent next action. Immediately after approval, make “Record your intro” primary if no intro exists and “See who's here” secondary.

**Specifics:**

- Add a derived readiness model in `events/onboarding.ts` from authenticated grant, durable-backup acknowledgement, current intro submission, coordinator processing status, and match-list availability; do not persist a second mutable status copy.
- Render it in `EventHome.svelte` as a compact ordered status list with one current step and one primary CTA; use `Joined`, `Backup secured`, `Intro submitted`, `Processing`, and `Matches ready`, omitting the deferred meeting-plan step.
- After approval, route back to Overview and make `Record your intro` primary when no current intro exists; keep `See who's here` secondary and preserve talk submission as a separate optional action only when talks are enabled.
- Distinguish waiting, action required, in progress, failed/retryable, and complete states; offline or unknown relay state must say `Checking status` rather than regress completed steps.
- Update locale strings and test new attendee, restored attendee, no coordinator/directory-only, failed upload, processing poison, matching off, and ready states. Acceptance: every event state presents one truthful next action and never claims backup or processing success prematurely.

### U2. Matches are recommendations, not an event-day action plan

**[STATUS 2026-07-15: declined by owner — "let's skip this part for now" (owner note below). Ranked Matches stays as-is; no plan step.]**

**Evidence:** The current match view is a ranked card list with percentages, reasoning, similarity, and complementarity (`packages/app/src/lib/pages/Matches.svelte`; `docs/images/participant/11-matches-light.png`). Private “want to meet” and “met” state lives on attendee detail instead of driving the main experience.

**Impact:** The list explains relevance but does not help someone navigate a crowded venue, remember whom they selected, or feel progress. Similarity and complementarity percentages expose model mechanics rather than strengthening the social action.

**Recommendation:** Reframe the primary experience as “Your meeting plan.” Start with five people, a one-sentence reason, and a suggested opening question. Put Want to meet, Met, Message, and private note actions on the recommendation card. Show progress such as “2 of 5 met,” support replacing a suggestion, and end with a recap of contacts and notes. Keep score details behind an explanation disclosure for users who want them.

Owner's note: let's skip this part for now

### U3. Event navigation is global when users think in an event context

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.5 (owner should confirm the IA change first, see owner questions). One global BottomNav is rendered on every route including inside events; no event-scoped variant exists.]**

**Evidence:** The bottom bar remains organized around Events, Create, Messages, Me, and Settings while event functions live behind event pages (`packages/app/src/lib/components/BottomNav.svelte`).

**Impact:** During an event, users repeatedly move between a global shell and event-specific screens. The product feels like a general utility rather than a live event companion.

**Recommendation:** Once inside an event, use an event-scoped shell: Overview, People, Matches, and Updates, with optional feature-gated destinations only when implemented. Put global events, identity, and settings behind an avatar/menu. Keep a compact event header visible so every screen has clear context.

**Specifics:**

- Add an event-context variant to `+layout.svelte`, `BottomNav.svelte`, and route metadata: `Overview`, `People`, `Matches`, and `Updates`; keep the existing Matches concept and do not introduce `My plan` behavior from deferred U2.
- Derive event context from parsed routes in `router/routes.ts`, render `EventHeader.svelte` with event title/status on all event subroutes, and place Events, Messages, identity, language, theme, and Settings in an accessible avatar menu.
- Show only destinations available to the role/configuration: hide Matches when matching is off, show Admin as an organizer action, and do not add Chat until implemented.
- Preserve deep links and browser Back behavior, retain the global shell on non-event routes, and collapse to a four-item 48 px bottom bar on mobile with a side/top navigation treatment on wider screens.
- Test visitor, pending, attendee, organizer, matching-off, direct-link, 320 px, desktop, keyboard, and screen-reader current-page behavior. Acceptance: event pages retain context without renaming or rebuilding Matches.

### U4. Organizer admin is ordered like a settings form, not a live operations console

**[STATUS 2026-07-15: partially true, to implement — plan step P3.6. A pending-count status strip (Admin.svelte:374-383, scrolls to requests) and bulk approve (:249-256) already exist; but Updates/Coordinator/Co-organizer/Invites/Share still all precede the join-requests section (:530), so the ordering complaint stands.]**

**Evidence:** Updates, coordinator setup, co-organizer setup, invites, and sharing all appear before join requests (`packages/app/src/lib/pages/Admin.svelte:374-554`). The screenshot confirms that requests can sit below a large invite QR block (`docs/images/organizer/06-pending-light.png`).

**Impact:** At a live event, the urgent task is admitting and helping attendees, but the organizer must jump or scroll past setup. As invites and updates grow, the page becomes harder to operate.

**Recommendation:** Put a status strip first: pending, approved, intros submitted, matches ready, coordinator health. If requests exist, show them immediately with selection and bulk actions. Put share/update tools next. Move coordinator, co-organizers, advanced settings, and dangerous actions into an Event setup section. Use two columns on desktop and sticky bulk actions on mobile.

**Specifics:**

- Reorder `Admin.svelte` into Operations, Requests, Communicate, People, Event setup, and Health, backed by small components extracted only where reused; preserve existing actions and protocol behavior.
- Compute a top status strip from roster/submission/job data: pending requests, approved people, current intros, matches ready, and coordinator health, with links that focus the relevant section.
- Put pending requests immediately after status when nonempty; support select all visible, approve, decline with optional reason, and clear per-person results rather than treating a partial bulk failure as total success.
- Use a two-column desktop grid with Operations/Requests dominant and a single-column mobile order; show sticky bulk actions only while selections exist and keep them above safe-area insets.
- Move key inputs, co-organizer custody, admission policy, disconnect/revoke, and advanced settings behind `Event setup`; dangerous actions require consequence-specific confirmation.
- Test empty/high-volume requests, mixed bulk outcomes, keyboard selection, 320 px/200% zoom, organizer reconnect, and stale health data. Acceptance: a pending request is visible without scrolling past setup or invite QR content.

### U5. The recording flow needs coaching and alternatives

**[STATUS 2026-07-15: largely confirmed, to implement — plan step P2.8. A hard-stop countdown/duration timer already exists (capture.ts:68-74). Missing: prompt coaching, mic check, facingMode:user, camera switch, file-upload fallback, and any text or audio intro alternative (modes are intro/talk video only).]**

**Evidence:** The UI offers both Enable camera and Record, although Record also enables it. There is no prompt, countdown, audio check, front-camera preference, camera switch, file fallback, or text alternative (`packages/app/src/lib/pages/Record.svelte:59-90,185-210`).

**Impact:** New users do not know what to say or whether their microphone works. Permission failures are intimidating. Users with disabilities, camera anxiety, browser incompatibility, or an existing local clip can be blocked from the core value.

**Recommendation:** Use a guided flow: prompt template, Start camera, preview and microphone check, three-second countdown, recording progress, review, Retake/Use. Default to `facingMode: "user"`, allow camera switching, allow choosing a video file, and provide an equivalent text or audio intro.

**Specifics:**

- Refactor `Record.svelte`/`media/capture.ts` into `choose -> preview/check -> countdown -> recording -> review -> uploading -> submitted`, with cancellation and retry transitions that preserve the reviewed local blob.
- Show a short prompt based on mode, request camera/microphone only after `Start camera`, prefer `facingMode: user`, display a live input meter, enumerate cameras after permission, and offer `Switch camera` when more than one exists.
- Add `Choose video`, `Record audio`, and `Write intro` inputs that produce a versioned submission shape with `mode`, media descriptor or text, authored fields, and accessibility-equivalent processing.
- Enforce configured duration/size before upload, announce countdown and recording state, prevent duplicate submits, and retain review after upload/network failure; revoke media tracks on route exit.
- Provide specific permission-denied/no-device/unsupported-browser guidance without repeatedly prompting, and require explicit `Use this intro` before encrypted upload.
- Test camera denial, no mic, front/rear switch, countdown cancel, file limits, text/audio paths, retry/offline, double click, cleanup, and both locales. Acceptance: every supported user can submit without video and understands what will happen before capture.

### U6. The home screen conflates membership with browsing history

**[STATUS 2026-07-15: confirmed, to implement — folded into plan steps P0.2 (owner scoping of the store) and P2.7 (Home split). Any viewed event lands under "Your events" with role visitor (EventHome.svelte:47-53, Home.svelte:72-97); the store is one global localStorage key shared across identities.]**

**Evidence:** Viewed events can be recorded with visitor role, while Home lists recent records under “Your events” (`packages/app/src/lib/pages/EventHome.svelte:46-53`; `packages/app/src/lib/pages/Home.svelte:72-100`).

**Impact:** A casually viewed event appears to be one of the user's events. This adds clutter and can reveal browsing history on a shared device.

**Recommendation:** Separate “Your events” from “Recently viewed.” Put organizer and approved-attendee events in the first section, visitors in a capped and dismissible second section, and promote an event when approval arrives.

**Specifics:**

- Change `recent-events.svelte.ts` records to identity-scoped `{ownerPubkey, coordinate, role, lastViewedAt}` for membership and a separate device-local visitor-history store with no keys or approval implications.
- In `Home.svelte`, list organizer/approved records under `Your events` sorted by event status then recency; list at most five visitor records under `Recently viewed` with individual and clear-all dismissal.
- Promote a visitor record atomically when an authenticated grant arrives, removing its visitor duplicate; pending requests remain `Recently viewed` with a `Pending approval` label.
- On logout, hide identity-owned membership while retaining it for later login; provide a setting to clear device browsing history, and never infer approval from history alone.
- Test two identities, promotion, dismissal, duplicate coordinates, expired/invalid event fetch, logout/login, and empty sections. Acceptance: merely opening a link never places it in `Your events` or exposes another identity's memberships.

### U7. Event information is visually attractive but operationally thin

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.7. EventHome renders only start time + location text; `end` is parsed (event-context.ts:26-27) but never shown; no timezone, status, map, calendar, or share on the event page.]**

**Evidence:** EventHome displays start time and location, but not the configured end, explicit timezone, map action, calendar action, or event status (`packages/app/src/lib/pages/EventHome.svelte:86-104`; `packages/app/src/lib/events/event-context.ts:84-96`).

**Impact:** Attendees cannot quickly answer how long the event lasts, whether the displayed time is local, how to navigate there, or how to add it to a calendar.

**Recommendation:** Add start and end, timezone, “Starts in/Happening now/Ended,” map navigation, Add to calendar, and Share. Keep this as one compact metadata block rather than more badges.

**Specifics:**

- Extend normalized event context in `event-context.ts` to expose validated start/end instants, IANA timezone, location name/address, and status; reject or safely omit invalid ranges/timezones.
- Render one metadata group in `EventHome.svelte` with localized date range and explicit timezone, plus `Starts in`, `Happening now`, or `Ended` derived from a clock that updates at boundary times.
- Add map navigation only for a nonempty location using an encoded HTTPS maps URL, calendar download via a local ICS generator with UTC timestamps/timezone text, and Web Share with clipboard fallback.
- Handle all-day/missing end/remote events, DST boundaries, user timezone differing from event timezone, and past events without misleading countdowns.
- Test timezone/DST formatting, URL escaping, ICS fields, share fallback, missing metadata, and fake-clock transitions. Acceptance: the block answers when, where, and current status without horizontal overflow at 320 px.

### U8. The roster does not scale to a real conference

**[STATUS 2026-07-15: confirmed, to implement — plan step P2.9. Sort buttons only (Attendees.svelte:106-108); no search, no filters.]**

**Evidence:** The attendee page offers sorting but no search, filters, saved-state views, alphabet jump, or compact mode (`packages/app/src/lib/pages/Attendees.svelte:103-135`). Cards may show biography, skills, AI summary, follow state, and score together.

**Impact:** At 100 or 200 attendees, finding a remembered person becomes slow and the list becomes visually repetitive.

**Recommendation:** Add search across name, bio, skills, and AI summary. Add filters for Want to meet, Met, Favorites, Following, and skills. Default to concise cards and reveal full AI summaries on detail. Consider virtualization only after actual list performance warrants it.

**Specifics:**

- In `Attendees.svelte`, build a normalized case/diacritic-insensitive local search index from decrypted name, bio, skills, and current AI summary; debounce input without delaying visible typing.
- Add flat filter chips for Want to meet, Met, Favorites, Following, and multi-select skills, intersect filters with search, expose active-filter count, and provide `Clear filters`.
- Use a shared concise `PersonCard` showing avatar, name, up to three skills, relationship markers, and one short summary line; keep full bio/AI explanation on `Attendee.svelte`.
- Preserve sort/filter/query state while navigating to detail and back, announce result counts, and display distinct no-roster and no-filter-results states.
- Measure 200-person rendering before adding virtualization; if adopted later, preserve focus, semantic list positions, and Back scroll restoration.
- Test accents/Slovak, missing fields, combined filters, private-state updates, 200 records, keyboard chips, and mobile overflow. Acceptance: a known person can be found by any indexed field and concise cards remain scannable.

### U9. The app has no correction or dispute flow for AI output

**[STATUS 2026-07-15: owner question — see plan. The gap is real (no correction/dispute/hide flow exists anywhere), but this is a sizable new protocol + coordinator + UI feature; not scheduling without owner sign-off.]**

**Evidence:** The benchmark recognizes invented facts as a failure mode (`docs/MATCHING-BENCHMARK.md`). Current attendee views do not let a person correct an AI profile, report inaccurate reasoning, hide a recommendation, or request recomputation.

**Impact:** Incorrect inferences can damage trust and create awkward introductions. Users have no agency over derived representations of themselves.

**Recommendation:** Show the derived event profile to its subject before or alongside publication. Add “This is inaccurate” and “Edit my event profile” flows, preserve user-authored fields, and let attendees hide or replace a match. Route reports to an organizer without exposing pair-private reasoning more broadly than necessary.

**Specifics:**

- Add a versioned attendee correction payload to protocol schemas containing coordinate, source revision, user-authored overrides, hidden inference fields, and optional report category; gift-wrap it to the authenticated coordinator.
- Show `Your event profile` after processing in Event Overview/attendee self-view, clearly separating `You wrote` from `Generated from your intro`; edits may override generated summary/skills but never silently rewrite authored identity fields.
- Add `This is inaccurate` with categories and optional text, `Edit my event profile`, and `Hide this match`; keep Matches otherwise unchanged and defer replacement mechanics tied to U2.
- Coordinator must validate sender equals profile subject, preserve immutable source/artifact revisions, publish corrected current output, and send organizers only privacy-safe report metadata unless the attendee explicitly shares text.
- Handle concurrent reprocessing with optimistic revision checks: preserve newer user overrides, mark conflicts for review, and allow retry after relay failure without duplicate reports.
- Test spoofed correction, stale revision, processing race, hide persistence, organizer visibility boundaries, and recomputation. Acceptance: subjects can see and correct current derived claims without exposing pair-private reasoning.

### U10. There is no abuse, block, or moderation journey

**[STATUS 2026-07-15: mute part confirmed and to implement — plan step P2.10, via standard NIP-51 kind 10000 exactly as the owner note below directs (no custom block events). The report-to-organizer flow is an owner question.]**

**Evidence:** Attendees can inspect profiles, watch videos, and start interoperable DMs, but the docs and app do not define blocking, reporting, unwanted-message controls, media moderation, or organizer handling.

**Impact:** Networking products expose users to harassment and unwanted contact. Revocation is not an adequate personal safety tool, and NIP-17 conversations continue beyond the event.

**Recommendation:** Implement minimum viable block/report controls, hide blocked users from recommendations, and explain cross-client limits honestly.Use normal muting from Nostr

**Specifics:**

- Implement blocking through standard Nostr NIP-51 mute lists, kind `10000`, authored by the active identity; use `p` tags for muted pubkeys and preserve unknown tags/content when updating the latest valid replaceable event.
- Add `Mute`/`Unmute` and `Report to organizer` actions on `Attendee.svelte`, match cards, and DM headers, with confirmation copy: `Muted in Nostrautica and compatible Nostr clients; other clients may behave differently.`
- Centralize mute loading/updating in a new `events/mutes.ts`; merge concurrent device changes against the newest relay event, sign one replacement, queue failed publishes, and never invent custom event-scoped block state.
- Filter muted pubkeys from roster results, Matches, DM thread lists/notifications, and coordinator candidate output where the user's authenticated mute preference is available; direct URLs show a muted interstitial rather than content.
- Gift-wrap reports to event organizers with reporter, subject, category, optional text, and evidence event IDs only; do not attach private DMs/media by default, and rate-limit duplicate reports locally/coordinator-side.
- Test kind/tag preservation, concurrent updates, relay failure/retry, cross-client import, muted direct link, recommendations/DM filtering, malicious report sender, and unmute. Acceptance: standard kind `10000` is the sole block source and no custom block event is published.

### U11. Prerecorded talks are presented as a flagship feature without a complete journey

**[STATUS 2026-07-15: confirmed — only a talk record mode exists (Record.svelte:20-21, ?talk=1 route in routes.ts:69,109-111); no talks on/off config, discovery, or playback. The owner note below stands (must serve both normal conferences and the prerecord-first format). Minimum step (talks config gate, off by default) is plan step P4.3; the full talks journey scope/timing is an owner question.]**

**Evidence:** Talks are prominent in the pitch (`docs/SPECIFICATION.md:15-18`) and recording code supports a `talk` mode (`packages/app/src/lib/pages/Record.svelte:20-37`), but participant guides, route structure, discovery, playback, completion tracking, and tests focus on intros.

**Impact:** Product messaging implies an event format the current experience does not fully support.

**Recommendation:** Define the whole feature: submit, edit, discover, watch, caption/transcript, progress. Note that this product should work for both normal conferences without prerecorded talks and for the new format we're trying.

**Specifics:**

- Add an optional `talks` event config mode (`off` by default, `prerecord-first` when enabled) to strict `31600` parsing, creation/admin UI, coordinator state, and docs; normal conferences with talks off must show no talk navigation or required talk step.
- Define versioned talk submission metadata with title, description, speakers, duration, language, media, revision, and status; reuse encrypted media submission and coordinator authentication while keeping intro and talk artifacts/jobs distinct.
- When enabled, add Talks discovery, talk detail/playback, organizer moderation/publication, submit/edit/replace, captions/transcript, and per-identity local/self-encrypted watch progress; prerecord-first events may feature Talks before People without blocking joining or intros.
- Editing creates a new revision, preserves the last valid published revision until replacement succeeds, invalidates transcript/captions, and handles duplicate uploads/content hashes idempotently.
- Apply the same disclosure, media limits, text/audio accessibility alternatives where meaningful, abuse reporting, and retention controls as intros; do not send talks into matching unless config explicitly opts in.
- Test talks off, enabled empty/populated, submit/edit failure, captions, resume progress, organizer rejection, normal conference journey, and prerecord-first journey. Acceptance: talks-off events are unchanged and enabled events support the complete lifecycle rather than exposing only record mode.

### U12. Rejection and waiting states are incomplete

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.9. Join.svelte distinguishes only approved/pending and polls forever; the coordinator computes decision.reason but only logs it (coordinator.ts:422) — nothing is ever published to the attendee.]**

**Evidence:** “Reject/ignore” is defined as no grant (`docs/SPECIFICATION.md:406-409`). The waiting UI can resend but has no rejection message, organizer response, expiry, or escalation (`packages/app/src/lib/pages/Join.svelte:294-320`).

**Impact:** A rejected or overlooked person waits indefinitely and cannot tell whether the request failed, is pending, or was declined.

**Recommendation:** Define pending, approved, declined, expired, and processing-failed states. Allow an organizer to include a short reason. Provide attendee retry or contact guidance without exposing sensitive organizer details.

**Specifics:**

- Define a signed/gift-wrapped join-status schema with request ID, coordinate, state (`pending|approved|declined|expired`), optional short reason, actor, and timestamp; keep processing failure as a separate post-approval coordinator status.
- Persist request IDs in identity-scoped `join-sent.svelte.ts`; organizers/coordinator accept transitions only for the same requester/event and reject regressions from terminal approved/declined states without a new request.
- `Join.svelte` must show distinct copy and actions: pending with last sent time, approved next action, declined reason plus allowed retry/contact, expired resubmit, and processing failed retry/help.
- Bound reason length, render as plain text, avoid exposing organizer keys/contact unless explicitly configured, and let organizers decline singly or in bulk with per-request results.
- Reconcile relay races by authenticated timestamp/event ordering and make resubmission a new request ID; offline state must not be mistaken for decline.
- Test every transition, duplicate/out-of-order statuses, forged actor, bulk partial failure, retry, missing reason, and both locales. Acceptance: no attendee waits indefinitely under an ambiguous generic state when a terminal status exists.

### U13. Invite-only admission semantics are unclear

**[STATUS 2026-07-15: confirmed — uninvited/invalid-invite requests always fall to the manual queue (entitlement.ts:69), never rejected, in every approval mode; config.approval is not consulted for rejection. Desired invite-only semantics (hard reject vs manual queue) is an owner question; code/docs alignment follows the answer — plan step P3.10.]**

**Evidence:** The organizer guide describes invite-only as having no other entry path, while coordinator logic/documentation can put invalid or absent invite proofs into a manual queue (`docs/ORGANIZER-GUIDE.md:47-53`; `docs/SPECIFICATION.md:447-452`).

**Impact:** Organizers cannot predict whether an uninvited request will be rejected or queued, and attendees receive inconsistent expectations.

**Recommendation:** Define each mode exactly in code, UI, and docs. For invite-only, either block submission without a valid code or explicitly describe organizer override. Avoid mode names that conceal behavior.

**Specifics:**

- Define strict admission modes in protocol/config: `open` auto-approves, `approval` queues all valid requests, and `invite-only` rejects submission without a valid unused invite proof; do not silently queue uninvited users.
- Centralize the decision function in coordinator admission code and return typed outcomes used by `Join.svelte`, `Admin.svelte`, creation UI, and guides so copy cannot diverge from behavior.
- Validate invite proof event/coordinate, secret hash, expiry, usage limit, and atomic redemption; concurrent claims for the last use must produce exactly one approval and one clear failure.
- Allow an organizer to admit someone manually from People as a separate explicit action, not as hidden override semantics of invite-only submission.
- Show mode-specific pre-submit copy and disable submit until required proof is present; strip invite secrets from history after parsing per D9.
- Test each mode, absent/invalid/expired/exhausted code, concurrent final use, replay, manual admission, and restart persistence. Acceptance: UI, docs, and coordinator produce the same outcome table.

### U14. The coordinator concept remains too operationally opaque

**[STATUS 2026-07-15: largely obsolete — Admin already shows a coordinator health card when attached: key, last-seen liveness badge, stale (>1h) warning, and a recompute action (Admin.svelte:437-465); the bare key input appears only when no coordinator is attached. The fuller "service contract" card (providers, cost policy, queue depth) folds into the Q12 status work; a hosted default offering is out of scope for now.]**

**Evidence:** Admin can attach a coordinator and shows inferred activity, but the control still begins with a bare key input and the coordinator's data access, provider, cost, and health are not presented as one understandable service contract (`packages/app/src/lib/pages/Admin.svelte:437-465`).

**Impact:** Organizers must understand infrastructure details to activate the product's central value, while attendees cannot easily see who processes their data.

**Recommendation:** Replace the key-first experience with a coordinator card: operator identity, capabilities, AI/STT provider, privacy tier, estimated cost policy, last successful job, queue/poison state, and disconnect/replace procedure. Provide a default hosted option if the product is intended for nontechnical organizers.

**Specifics:**

- Define an authenticated coordinator capability/status payload containing operator pubkey/name, protocol version, supported stages, providers/models/privacy tiers, pricing policy text, queue counts, poison count, and last success time; never include prompts or attendee content.
- Render it in `Admin.svelte` as `Coordinator` under Health/Setup, resolving kind 0 identity separately and labeling status freshness; move raw pubkey entry behind `Use custom coordinator`.
- Provide states `Not connected`, `Connecting`, `Healthy`, `Degraded`, `Unavailable`, and `Replacement pending`, with exact next actions and last checked time; stale status must not appear healthy.
- Replacement installs the new coordinator and confirms authenticated readiness before rotating/detaching old inbox access; disconnection explains loss of AI/transcription/invite automation and follows the shutdown runbook.
- A hosted option, if offered, must display the same operator/provider/privacy/cost contract and require organizer confirmation rather than being silently selected.
- Test forged/stale status, unavailable provider, poison jobs, replacement rollback, disconnect, directory-only consequences, and narrow/desktop layouts. Acceptance: an organizer can understand who processes data, current health, and cost before entering infrastructure keys.

---

## Accessibility and interaction findings

### A1. Intro videos have no captions, transcript, or equivalent input path

**[STATUS 2026-07-15: confirmed, to implement — plan steps P2.11 (publish/display transcripts) and P2.8 (equivalent text/audio inputs). Caption warnings still suppressed (Record.svelte:187,197; MediaPlayer.svelte:31); transcripts exist coordinator-side but are never published to attendees.]**

**Evidence:** Both recording playback and attendee media deliberately suppress missing-caption warnings (`packages/app/src/lib/pages/Record.svelte:185-198`; `packages/app/src/lib/components/MediaPlayer.svelte:30-32`).

**Impact:** Deaf and hard-of-hearing people cannot consume central profile content. People unable or unwilling to record video lack an equivalent route to matches.

**Recommendation:** Publish encrypted transcripts from coordinator processing, show them with every intro, attach timed caption tracks where available, and allow text/audio intros. Set a WCAG 2.2 AA target for the product.

**Specifics:**

- Extend encrypted directory/profile schemas and `nostr/publisher.ts` with transcript text, language, source revision, and optional WebVTT caption descriptor; validate that captions refer to the same encrypted media revision.
- Generate transcript/caption artifacts after STT, store them through encrypted-at-rest coordinator storage, encrypt publication under the ECK, and omit stale artifacts when media changes.
- Update `MediaPlayer.svelte` to attach a local/decrypted `<track kind="captions">`, expose `Show transcript`, identify machine-generated text, and allow organizers/subjects to provide corrections.
- Add text and audio intro submission in `Record.svelte` as equivalent profile inputs; matching/profile jobs must not require a video descriptor.
- For missing or failed captions, show transcript availability or a truthful `Captions unavailable` status and retry path rather than suppressing warnings.
- Add axe/keyboard/screen-reader tests plus caption toggle, transcript correction, text-only/audio-only, stale revision, and both locale cases. Acceptance: every intro has a nonvisual consumption path and core flows meet the documented WCAG 2.2 AA target.

### A2. SPA navigation does not manage title, focus, landmarks, or announcements

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.1. No document.title updates, no focus management, no skip link, no live region anywhere in the app.]**

**Evidence:** The catch-all page swaps components without route-specific `<title>` metadata or focus movement (`packages/app/src/routes/+page.svelte:21-53`). The layout lacks a skip link and robust main-route announcement (`packages/app/src/routes/+layout.svelte:36-50`).

**Impact:** Screen-reader users can activate a route and receive no indication that the screen changed. Focus can remain on a removed control. Every tab has a generic title.

**Recommendation:** Add route metadata, update the title, wrap content in `<main id="main-content" tabindex="-1">`, focus the page heading/main after navigation, add a polite route-status live region, and provide a skip link.

**Specifics:**

- Add localized title/announcement metadata to route definitions in `router/routes.ts`, including dynamic event/person names only after safe loading and a stable `Page | Nostrautica` fallback.
- In `+layout.svelte`, add the first-focusable skip link, one `<main id="main-content" tabindex="-1">`, and a visually hidden polite live region outside swapped page content.
- After completed route navigation, update `document.title`, set the announcement, and focus the page's `h1` or main without scrolling when appropriate; do not steal focus for background polling or same-page state updates.
- Ensure each page has one programmatic `h1`, and mark top/bottom navigation plus footer with appropriate landmarks and unique labels.
- Coordinate focus behavior with browser history in A3 and delay dynamic-title announcements so loading and final content do not announce twice.
- Add Playwright tests for click navigation, direct deep link, Back/Forward, loading/error routes, skip link, title, landmarks, and focus. Acceptance: a screen reader receives one useful route-change announcement and focus never remains on removed content.

### A3. The custom back stack conflicts with native history

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.2. Hash-based custom stack with no pushState/popstate; initializes as Home then syncs the deep link (router.svelte.ts:39-58). Only Join.svelte uses history.replaceState (to strip the invite secret — keep that behavior).]**

**Evidence:** The router initializes as Home, then records that synthetic route when syncing a direct deep link (`packages/app/src/lib/router/router.svelte.ts:38-58`). Browser hash changes and the private stack can diverge (`packages/app/src/lib/router/router.svelte.ts:61-81`).

**Impact:** Opening a direct attendee or join link can make in-app Back go to Home rather than the contextual parent. Mixing browser Back and app Back can produce surprising navigation.

**Recommendation:** Use browser history as the source of truth with `pushState`/`replaceState` and `popstate`, or correctly initialize without pushing Home. Use contextual parent only when a route is genuinely the first app entry. Add direct-link and mixed Back/Forward E2E tests.

**Specifics:**

- Replace the private synthetic stack in `router.svelte.ts` with browser `history.state` entries containing a versioned route key and optional contextual parent; initialize from the current URL using `replaceState`, never by first pushing Home.
- Use `pushState` for user navigation, `replaceState` for canonicalization/secret stripping, and `popstate` as the only Back/Forward source; retain hash/base-path compatibility required by the static deployment.
- In-app Back calls `history.back()` when an app entry exists, otherwise navigates once to the route's real contextual parent without trapping the user in a Home loop.
- Preserve query/fragment data needed by routes while stripping invite/login secrets before adding history, and restore scroll position per entry where browser behavior is insufficient.
- Ignore duplicate navigation to the same canonical URL and make rapid clicks/popstate transitions deterministic.
- Extend route unit and Playwright tests for every deep-link family, refresh, mixed app/browser Back/Forward, external entry, base path, secret stripping, and scroll/focus coordination. Acceptance: visible URL, rendered route, and browser history never diverge.

### A4. Restored/detected Slovak can leave the document language as English

**[STATUS 2026-07-15: partially true, to implement — plan step P2.5 (trivial). set() and adoptEventLang() already set document lang (i18n.svelte.ts:68,83); init() does not, so a first load with saved/detected Slovak keeps lang="en".]**

**Evidence:** The initial HTML is always `lang="en"`, while `i18n.init()` does not consistently update it after saved preference or browser detection (`packages/app/src/app.html:2`; `packages/app/src/lib/i18n/i18n.svelte.ts:52-69`).

**Impact:** Screen readers can pronounce Slovak using English rules, and browser language tools receive incorrect metadata.

**Recommendation:** Always assign `document.documentElement.lang` after locale initialization and whenever locale changes. Test both saved and browser-detected Slovak.

**Specifics:**

- In `i18n.svelte.ts`, normalize supported locale values and set `document.documentElement.lang` synchronously when initialization resolves and in the single locale setter used by `LanguagePicker.svelte`.
- Keep `app.html` at `lang="en"` as the no-script/default fallback, but replace it before interactive content is announced when saved preference or browser detection selects `sk`.
- Ignore unsupported/corrupt saved values, map regional values such as `sk-SK` to `sk`, and keep title/route announcements localized after a switch.
- Add unit tests for saved English/Slovak, browser-detected Slovak, unsupported locale fallback, and live switching; add one browser assertion before and after hydration.
- Acceptance: `<html lang>` always equals the active translation locale and never remains English while Slovak UI is rendered.

### A5. Important controls rely on placeholders instead of labels

**[STATUS 2026-07-15: partially true, to implement — plan step P3.3. Admin and DmChat use .field-label divs and placeholders without label/for association; Join and Login already use real labels, so the fix is targeted, not app-wide. No Field component exists.]**

**Evidence:** Update title/body, coordinator key, co-organizer key, invite count, DM composer, and some private-note/credential controls do not have reliable visible programmatic labels (`packages/app/src/lib/pages/Admin.svelte:385-396,460-490`; `packages/app/src/lib/pages/DmChat.svelte:142-153`).

**Impact:** Placeholders disappear after typing and are not an adequate accessible name. Speech-input and screen-reader interaction becomes ambiguous.

**Recommendation:** Give every field an `id` and visible `<label>`. Use `aria-describedby` for privacy and safety hints. Build a reusable `Field` component so this is not fixed page by page.

**Specifics:**

- Add a small `components/Field.svelte` that renders a visible label, required/optional text, hint/error IDs, and a slot/snippet for the native input without replacing native semantics.
- Convert update title/body, coordinator and co-organizer keys, invite count, DM composer, private note, and credential fields in the cited pages first; generate stable IDs rather than using placeholders as names.
- Attach privacy/security hints with `aria-describedby`, errors with `aria-errormessage` plus `aria-invalid`, and preserve autocomplete/inputmode attributes appropriate to keys, counts, and text.
- Keep placeholders only as examples, ensure labels remain visible after entry, and make repeated/list fields receive unique IDs.
- Test accessible-name computation, label click/focus, error/hint association, repeated fields, both locales, and 200% zoom. Acceptance: axe reports no unlabeled form control and speech input can target every field by its visible label.

### A6. Dynamic states are mostly visual-only

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.4. Zero occurrences of aria-live, role=status/alert, aria-pressed, or aria-current in src; state is class-based and visual-only.]**

**Evidence:** Offline state, loading, copied feedback, selected settings, saves, private toggles, and coordinator activity generally do not use `aria-live`, `role=status`, `aria-busy`, `aria-pressed`, or `aria-current` consistently.

**Impact:** Assistive-technology users can miss successful copies, saves, connection changes, and selected state.

**Recommendation:** Encode semantics into reusable controls. Use `aria-pressed` for toggles, `aria-current=page` for navigation, polite status regions for saves/copies/connectivity, and alerts only for blocking failures.

**Specifics:**

- Add reusable `SaveStatus`/status-region and toggle-button patterns, then inventory BottomNav, Settings, copy buttons, follow/private-state controls, offline banner, uploads, and coordinator state.
- Use native checkbox/switch semantics for persistent binary settings, `aria-pressed` only for toggle buttons, and `aria-current="page"` only on the active navigation link.
- Maintain one polite global queue for brief copy/save/connectivity messages, deduplicate repeated polling updates, and reserve `role="alert"` for failures requiring immediate action.
- Apply `aria-busy` to the region being refreshed while keeping controls usable where safe; pair icon/color states with visible text or an accessible label.
- Test with fake timers for announcement ordering/deduplication, keyboard activation, online/offline flapping, save retry, and current route. Acceptance: each important state change is programmatically exposed once without alert fatigue.

### A7. Bottom navigation targets and selection treatment are weak

**[STATUS 2026-07-15: partially true, to implement — folded into plan step P3.5 with U3. Emoji icons, no aria-current, 0.25rem padding with no min-height on the nav buttons (BottomNav.svelte:14-34,65-68); the global .btn 44px rule does not apply to them.]**

**Evidence:** Bottom-nav items have small labels, minimal padding, emoji-like symbols, and no semantic current-page state (`packages/app/src/lib/components/BottomNav.svelte:12-78`).

**Impact:** Targets may fall below the intended touch size; emoji render inconsistently; selected state relies heavily on color.

**Recommendation:** Enforce at least 48 px height, use a consistent icon set, add `aria-current`, and provide a non-color selected marker. Reconsider whether five global destinations should remain visible inside an event-scoped experience.

**Specifics:**

- Update `BottomNav.svelte` and `app.css` to guarantee a 48 by 48 px activation area, safe-area padding, readable 12 px minimum labels, and no overlap at 320 px/200% zoom.
- Replace emoji-like symbols with local inline SVG components using `currentColor`, a shared 24 px viewBox, `aria-hidden="true"`, and no external icon requests.
- Mark the active link with `aria-current="page"`, stronger type weight, and a shape/underline indicator visible in forced-colors mode, not color alone.
- Use the U3 event-scoped destinations inside events and global destinations elsewhere; keep Matches as Matches and do not implement deferred U2 navigation.
- Test touch target geometry, all route states, long Slovak labels, forced colors, landscape safe areas, and keyboard focus. Acceptance: every item meets target size and selected state remains identifiable without icon style or color.

### A8. Responsive control rows are fragile at narrow widths and text zoom

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.8. Base .row has no flex-wrap (app.css:236-240); wrapping exists only where call sites add inline styles.]**

**Evidence:** Generic `.row` does not wrap by default, while sorting, settings, invite sharing, and action groups assume labels fit on one line (`packages/app/src/lib/styles/app.css:236-240`; `packages/app/src/lib/pages/Admin.svelte:504-527`).

**Impact:** At 320 px, translated labels, or 200% text zoom, controls can overflow or become cramped.

**Recommendation:** Make action rows explicitly responsive, stack or wrap below narrow breakpoints, and test 320 px plus 200% text zoom in both locales.

**Specifics:**

- Stop relying on generic `.row` for no-wrap behavior; add explicit `.action-row`/`.field-row` styles in `app.css` with `flex-wrap`, sensible gaps, and child `min-width: 0`.
- Stack primary/secondary actions below a content-based breakpoint, let labels wrap, and make destructive/primary buttons full width only where ordering remains unambiguous.
- Apply to sorting, settings, invite sharing, admin bulk actions, recording review, DM composer, and attendee actions; prevent fixed-width inputs from forcing viewport overflow.
- Preserve a logical DOM/tab order when desktop rows become mobile stacks and keep sticky actions clear of bottom navigation/safe areas.
- Add screenshot/DOM overflow tests at 320, 360, and 412 px, desktop, both locales, 200% zoom, and long validation text. Acceptance: `scrollWidth <= clientWidth` for each page and no control text is clipped.

### A9. Markdown updates can overflow on mobile

**[STATUS 2026-07-15: partially true and in flux (P9), then to implement — plan step P3.8. markdown.ts:119 emits <div class="md-table"> with a comment claiming scroll containment, but no CSS anywhere targets .md-table/table/pre; markdown styling is EventHome-local. P9 is rewriting markdown.ts and the event pages right now — land the global .markdown ruleset only after P9.]**

**Evidence:** The renderer emits tables, code blocks, and images, while event-page styles do not comprehensively constrain `.md-table`, `pre`, images, long URLs, and code (`packages/app/src/lib/social/markdown.ts:104-138`; `packages/app/src/lib/pages/EventHome.svelte:194-224`).

**Impact:** Organizer-authored content can create horizontal overflow on the most important mobile event screen.

**Recommendation:** Add responsive global styles for rendered markdown and screenshot-test adversarial content at 320, 360, and 412 px.

**Specifics:**

- Add a scoped `.markdown` ruleset in `app.css` and apply it around `social/markdown.ts` output on every page; do not rely on EventHome-only styles.
- Set images/video to `max-width:100%; height:auto`, wrap long prose/URLs with `overflow-wrap:anywhere`, make `pre` horizontally scrollable with keyboard focus, and contain tables in a labeled horizontal scroller.
- Constrain inline code without breaking words globally, preserve visible focus on links/scrollers, and support dark/high-contrast themes through existing tokens.
- Keep renderer sanitization/escape-first behavior unchanged and reject unsafe URL schemes independently of CSS.
- Add adversarial fixtures for wide tables, long unbroken URLs, large images, nested lists, code, RTL-like text, and headings at 320/360/412 px plus 200% zoom. Acceptance: the page itself has no horizontal overflow and all content remains reachable.

---

## Reliability and code-quality findings

### Q1. Optimistic DMs can disappear on polling

**[STATUS 2026-07-15: confirmed, to implement — plan step P2.5. refresh() wholesale-replaces the messages array every 5s (DmChat.svelte:42) despite an inline comment claiming a merge; optimistic local- entries are dropped.]**

**Evidence:** Sending appends a local message (`packages/app/src/lib/pages/DmChat.svelte:61-75`), but the next refresh assigns `messages = mine` instead of merging pending entries (`packages/app/src/lib/pages/DmChat.svelte:33-45`).

**Impact:** If a relay has not returned the message within five seconds, it vanishes temporarily. Users may resend it and create duplicates.

**Recommendation:** Maintain pending messages with stable client IDs and Sending/Sent/Failed states. Merge relay events into local pending state and retain failed drafts with Retry.

**Specifics:**

- Define a local DM outbox record in `events/dm.ts` keyed by active identity and random client ID with peer, plaintext/ciphertext reference, created time, state, attempts, and published event IDs; persist before publish.
- In `DmChat.svelte`, render `sending`, `sent`, and `failed` states and merge poll results by signed event ID plus a client correlation tag/content hash where interoperable; never replace the entire visible array with relay results.
- Serialize retries per client ID, disable duplicate send while pending, retain failed text with `Retry`/`Edit`, and mark sent only after the configured relay acknowledgement threshold.
- Reconcile on page load and identity reconnect, expire only confirmed outbox metadata after a retention window, and keep messages ordered stably when relay timestamps differ.
- Test slow/no relay echo, poll during send, duplicate relay copies, restart/offline recovery, retry, two tabs, wrong identity, and acknowledgement failure. Acceptance: an optimistic message never vanishes and one user action produces one logical message.

### Q2. Private notes and relationship-state writes lack durable feedback

**[STATUS 2026-07-15: confirmed, to implement — plan step P2.5. Save-on-blur with no saving/saved/failed indicator (Attendee.svelte:88-91,193).]**

**Evidence:** Notes save on blur, and private-state toggles do not provide clear in-progress, success, failure, or retry states (`packages/app/src/lib/pages/Attendee.svelte:83-91,185-194`).

**Impact:** Important event notes can be lost without the user knowing. Rapid updates can overlap.

**Recommendation:** Keep an immediate draft, debounce saves, flush before route change, serialize writes, and show Saving/Saved/Retry status.

**Specifics:**

- Store note drafts immediately in identity/event/person-scoped IndexedDB from `Attendee.svelte`, then debounce encrypted Nostr persistence in `events/settings.ts`/`social.ts`; relationship toggles use the same queued writer.
- Use a per-record monotonic revision and one serialized promise chain so rapid edits coalesce, stale completions cannot overwrite current UI, and only the newest value is published.
- Show `Saving`, `Saved`, and `Couldn't save - Retry` beside the control via shared `SaveStatus`; keep the unsent draft editable and never clear it on failure.
- Flush on route navigation, visibility hidden, and page lifecycle where feasible, but treat durable local write as the unload guarantee rather than relying on network completion.
- Merge remote/new-device state by authenticated timestamp/revision and surface a conflict instead of silently replacing a newer local draft.
- Test rapid blur/toggles, route exit, offline/reload/retry, out-of-order completion, two devices, identity isolation, and relay rejection. Acceptance: acknowledged text/state survives reload and failed persistence is visible with recovery.

### Q3. Network errors expose raw details and frequently dead-end

**[STATUS 2026-07-15: confirmed, to implement — plan step P3.11. Raw error.message rendered in at least Join, EventHome, Attendees, Matches, DmChat, Admin, and Attendee; no shared component.]**

**Evidence:** Multiple pages display raw `Error.message` in warning cards and provide no shared Retry or category handling (`packages/app/src/lib/pages/Join.svelte:272-280`; similar patterns in EventHome, Attendees, Matches, and DM pages).

**Impact:** Temporary relay failure looks terminal, and protocol-oriented text confuses newcomers.

**Recommendation:** Create a shared `AsyncState/ErrorState` with a plain-language headline, Retry, safe navigation, and collapsed technical details. Categorize offline, timeout, invalid event, access denied, decryption, upload, and provider-processing failures.

**Specifics:**

- Add typed error categories in `nostr/errors.ts` and shared `components/AsyncState.svelte`/`ErrorState.svelte`; map transport/protocol/crypto/provider errors at their boundary rather than parsing arbitrary display strings.
- Render a localized headline, one next action (`Retry`, `Sign in`, `Return to event`, or `Contact organizer`), and a closed `Technical details` disclosure containing sanitized category/correlation ID.
- Preserve existing content during background refresh failures with a nonblocking status; reserve full-page errors for missing required state and avoid exposing relay URLs with credentials, keys, ciphertext, stack traces, or provider bodies.
- Make Retry idempotent, disable it while running, retain user input/uploads, and provide offline-aware automatic retry only for safe reads/queued writes.
- Replace raw `Error.message` rendering in Join, EventHome, Attendees, Matches, DM, Record, and Admin incrementally through the shared component.
- Test every category, unknown fallback, sanitization, retry success/failure, offline recovery, keyboard disclosure, and both locales. Acceptance: users always get a safe next action and raw internal errors are hidden by default.

### Q4. Login profile publication can partially fail while reporting success

**[STATUS 2026-07-15: confirmed, to implement — plan step P2.5. Login.svelte:35-39: photo upload, profile publish, and relay-list setup are all .catch(() => {}) swallowed during identity creation.]**

**Evidence:** Photo upload, profile publication, and relay-list setup swallow errors in the standalone identity flow (`packages/app/src/lib/pages/Login.svelte:31-46`).

**Impact:** A newcomer can believe their name/photo was saved when only the identity was created.

**Recommendation:** Show explicit stages. Report “Identity created” separately from optional profile synchronization. Preserve the local preview and offer Retry when publication fails.

**Specifics:**

- Model `Login.svelte` creation as `creating identity -> identity secured -> uploading photo -> publishing profile -> publishing relay list -> complete`, with identity success committed before optional network stages.
- Persist the local name/photo/about draft under the new identity before publication and show each optional stage as pending/succeeded/failed with an independent Retry.
- Never roll back or regenerate the identity because photo/profile/relay publication failed; route access remains available with a banner such as `Identity created; profile not yet published`.
- Make retries idempotent by reusing uploaded blob hash and replaceable kind 0/relay-list events, and reconcile relay acknowledgement rather than reporting success on local signing alone.
- Handle page reload, offline creation, partial relay success, invalid image, and logout without exposing another identity's draft.
- Test failure at every stage and recovery after reload. Acceptance: success copy names exactly what succeeded and the preview survives until optional publication completes or the user discards it.

### Q5. Protocol version parsing silently accepts unsupported future versions

**[STATUS 2026-07-15: confirmed as described, but the code comment marks the behavior deliberate ("forward-tolerant", schemas.ts:10 accepts literal 1 OR any positive int). Because tolerance was a conscious choice, locking to literal PROTOCOL_VERSION is an owner question; if approved it rides plan step P0.5.]**

**Evidence:** `version` accepts literal 1 or any positive integer (`packages/protocol/src/schemas.ts:8-13`).

**Impact:** A future `v:2` payload with superficially compatible fields can be interpreted using v1 security semantics.

**Recommendation:** Accept only `PROTOCOL_VERSION` in current schemas. Parse an envelope and dispatch explicitly when additional versions are implemented.

**Specifics:**

- Change version fields in `protocol/src/schemas.ts` to `z.literal(PROTOCOL_VERSION)` and export a minimal envelope schema that reads only type/version before selecting a version-specific full schema.
- Ensure gift-wrap, config, grants, submissions, profiles, matches, statuses, and recovery records all pass through explicit dispatch; no caller may cast an unknown version to v1.
- Return a typed `unsupported_version` error distinct from malformed data so clients can ignore safely and coordinators can report upgrade requirements without retry loops.
- Keep signing/author/coordinate checks outside but adjacent to schema dispatch so a valid shape never bypasses Nostr authenticity.
- Add fixtures for missing, zero, negative, string, `2`, huge, and valid version values across each payload family. Acceptance: no unsupported future payload reaches v1 business logic.

### Q6. Crypto fields are not validated to exact decoded lengths

**[STATUS 2026-07-15: confirmed, to implement — plan step P0.5. base64 fields are charset-checked only (schemas.ts:13) with no decoded-length check for 32-byte keys/12-byte nonces; hex32 is fine; worse, the nsec fields (inbox_nsec/eid_nsec/einbox_nsec) are bare z.string().]**

**Evidence:** Base64 is regex-checked but decoded key and nonce lengths are not checked (`packages/protocol/src/schemas.ts:12-26,93-115,129-138`).

**Impact:** Malformed keys enter storage and fail later in harder-to-diagnose crypto paths.

**Recommendation:** Add Zod transforms/refinements for 32-byte ECK/private/media keys and 12-byte GCM nonces. Validate coordinates and relay/Blossom URL schemes at the same boundary.

**Specifics:**

- Add reusable protocol schema helpers that decode canonical base64 and require 32 bytes for ECK/private/media keys, 12 bytes for AES-GCM nonces, and 32-byte lowercase hex Nostr keys/hashes.
- Reject invalid padding/alphabet, whitespace, noncanonical encodings, and decoded-length mismatches before constructing crypto objects or writing storage.
- Parse coordinates with `parseCoordinate`, require kind `31600`, nonempty bounded `d`, and matching author relationships where the enclosing payload defines them.
- Restrict relays to `wss:` and Blossom/media endpoints to `https:` with no credentials; apply stricter coordinator allowlisting separately under C3.
- Return field-level typed validation errors with no secret values and use the same helpers in config/grants/submissions/recovery schemas.
- Expand `schemas.test.ts`, `coordinate.test.ts`, and crypto tests with boundary lengths and malformed encodings. Acceptance: malformed crypto material fails at parse time, not later during decrypt/import.

### Q7. Public config parsing trusts malformed values

**[STATUS 2026-07-15: confirmed, to implement — plan step P0.5. Unchecked `as` casts for approval/visibility (config.ts:82-84), raw Number() for maxVideoSec/maxTalkSec/eck/nostrContext (:92-98), no URL/scheme validation for relays/Blossom (:70-72,89-90).]**

**Evidence:** Approval and visibility values are unchecked casts; numeric tags use raw `Number()`; keys and URLs are not strictly validated (`packages/protocol/src/config.ts:74-100`).

**Impact:** Malicious or malformed config can produce `NaN`, negative/huge limits, unsupported modes, invalid keys, and unsafe endpoint choices.

**Recommendation:** Parse config through a strict Zod schema with finite ranges, enums, hex key checks, `wss:` relay URLs, `https:` Blossom URLs, and sensible maximum durations/context counts.

**Specifics:**

- Define one strict normalized config schema in `protocol/src/config.ts` and have tag parsing build an untrusted object that is validated before defaults are applied.
- Enumerate approval, matching, visibility, talks, and language values; validate 64-hex pubkeys, `wss:` relays, `https:` Blossom URLs, finite integers, and start/end ordering.
- Set documented bounds for intro/talk duration, media bytes, context event count/age, invite limits, and relay/origin counts; reject duplicate/conflicting singleton tags and deduplicate list tags deterministically.
- Preserve unknown tags for Nostr replaceability where needed but do not expose them as trusted runtime options; never use `Number()` output before finite/integer/range checks.
- Update app creation/event context and coordinator install/live-config paths to consume only the parsed type and show an invalid-event error rather than partial behavior.
- Add table/fuzz tests for NaN/infinity, negatives, huge values, wrong schemes, credentials, malformed keys, duplicates, unknown enums, and valid minima/maxima. Acceptance: app and coordinator derive identical config or both reject it.

### Q8. Roster and directory reads ignore the event's ECK version tag

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.5. Readers always take the highest local ECK (keystore.ts:96-99) and skip whatever fails to decrypt (attendee.ts:158); the eck tag written on publish (organizer.ts:220,281) is ignored on read.]**

**Evidence:** The app always chooses the highest local ECK and decrypts every selected event with it (`packages/app/src/lib/events/attendee.ts:104-159`), although published events carry an `eck` tag.

**Impact:** During partial relay propagation after rotation, the newest locally visible event may use an older key and incorrectly appear undecryptable.

**Recommendation:** Select the key named by each event's `eck` tag. For replaceable data, evaluate candidates newest-first and keep the newest valid decryptable event.

**Specifics:**

- In `events/attendee.ts`, parse each roster/directory/match candidate's `eck` tag as a bounded integer and look up exactly that version from the identity-scoped event record.
- Fetch multiple replaceable candidates, verify author/coordinate/signature, sort by Nostr replaceable ordering, and choose the newest candidate whose schema and authenticated decryption succeed.
- Treat a missing local key as `awaiting key` rather than corrupt content, continue to an older decryptable candidate during relay propagation, and trigger grant/recovery refresh in the background.
- Do not try every key against untagged/malformed events or let an old decryptable event overwrite a newer accepted revision in memory.
- Cache the chosen event ID with ECK version and invalidate when a new grant or relay candidate arrives.
- Test old/new propagation in both orders, missing key, bad tag, tampered ciphertext, equal timestamps, rotation, and recovery. Acceptance: users retain the newest valid view available without false decryption failures.

### Q9. LLM/provider output is not consistently runtime-validated

**[STATUS 2026-07-15: implemented 2026-07-15 — plan step P1.6. The provider boundary now validates output at runtime: `completeStructured` takes an optional `validate` hook (providers/types.ts), venice.ts/routstr.ts/mock.ts run it after JSON.parse and raise a sanitized `ProviderContractError` on failure (paths only, never prompt/attendee text), which the job runner already routes to retry→poison. profile.ts validates ai_profile (reusing protocol `aiProfileSchema`), translation, and nostr-summary output; venice STT + embeddings are shape-checked; scoring.ts adds a lenient envelope check that preserves per-candidate tolerance. Mock output runs the same contract so tests exercise it. Covered by packages/coordinator/src/pipeline/profile.test.ts (9 cases: missing/wrong-typed/non-object output, sanitized diagnostics, valid). Was: confirmed, to implement.]**

**Evidence:** Provider JSON is parsed and cast to generic TypeScript types; downstream code assumes required arrays and fields exist (`packages/coordinator/src/providers/venice.ts`, `packages/coordinator/src/providers/routstr.ts`, `packages/coordinator/src/pipeline/profile.ts`).

**Impact:** Model noncompliance or provider changes can poison jobs or crash publication despite “strict JSON” requests.

**Recommendation:** Validate every external response with Zod immediately after parsing. Treat schema failure as a typed retryable provider error with sanitized diagnostics.

**Specifics:**

- Define strict response schemas for STT, profile/translation, embeddings, pair scores, and payment/provider metadata in `providers/types.ts` or stage modules, including finite score ranges and bounded strings/arrays.
- In `venice.ts` and `routstr.ts`, parse HTTP envelopes defensively, then validate role output before returning it; remove broad casts and do not persist partially valid structures.
- Classify malformed/truncated/non-JSON output as a typed provider-contract error with provider, model, request correlation ID, and validation paths only; exclude prompts and attendee text.
- Retry only according to stage policy with capped attempts/jitter, allow repair prompting only if explicitly versioned/cached, and poison after the existing limit with organizer-visible status.
- Validate mock provider output too so tests exercise the same contract, and include schema version in artifact keys.
- Test missing/extra fields, NaN/out-of-range scores, oversized text, refusal prose, malformed JSON, HTTP error bodies, retry/poison, and valid responses. Acceptance: no unvalidated provider value enters storage or publication.

### Q10. Updated attendee data can temporarily publish a stale AI profile

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.10. upsertAttendee COALESCEs ai_profile_json (db.ts:269-274) and handleSubmission calls publishDirectory before reprocessing (coordinator.ts:427-445), so new authored fields publish alongside stale AI output; no source/ai revision tracking exists.]**

**Evidence:** New submissions update authored profile data while an existing AI profile can remain attached until processing completes (`packages/coordinator/src/coordinator.ts:427-444,487-499`).

**Impact:** Other attendees can see a new self-description combined with obsolete inferred skills and summary. If processing poisons, the inconsistency persists.

**Recommendation:** Mark AI output stale whenever source inputs change and omit or label it until regeneration succeeds. Keep old content-addressed artifacts for rollback rather than presenting them as current.

**Specifics:**

- Add `source_revision`, `ai_revision`, and processing state to attendee persistence in `store/db.ts`; increment source revision atomically whenever intro/authored profile/context choice changes.
- In `coordinator.ts`, clear the current AI attachment or publish it explicitly as unavailable before publishing new authored fields; never pair source revision N with AI revision N-1 as current.
- Jobs capture a source revision and commit only if it still matches; stale completions remain immutable artifacts but cannot update current attendee output.
- UI shows authored data immediately with `Updating generated profile` and, on poison, `Generated profile unavailable` plus organizer retry rather than stale claims.
- Reprocessing the same content hash may safely reattach a validated artifact for the exact revision inputs.
- Test rapid resubmission, old job finishing last, poison, rollback/retry, restart, and directory reads during processing. Acceptance: every displayed generated field is traceable to the currently displayed source revision.

### Q11. Nostr-context implementation differs from the documented pipeline

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.11. Kind 0 is fetched then filtered out (coordinator.ts:824); repost targets are never resolved (raw kind-6 content is passed through).]**

**Evidence:** Fetch includes kind 0 but immediately filters it out, and repost targets are not resolved (`packages/coordinator/src/coordinator.ts:816-827`). The spec requires latest kind 0 plus resolved repost targets (`docs/SPECIFICATION.md:449-463`).

**Impact:** AI profiles lose useful metadata context and may receive empty or raw repost content, reducing match quality.

**Recommendation:** Return a typed context object containing latest profile metadata and normalized posts. Resolve repost targets, bound all fetches, and include stable event IDs in cache hashes.

**Specifics:**

- Define `NostrContext` as validated latest kind 0 metadata plus normalized original notes with event ID, author, created time, content, and optional repost source; keep profile metadata separate from posts.
- In coordinator context fetching, select kind 0 by replaceable ordering, parse bounded metadata fields, resolve repost target event IDs through a capped batched query, and omit unresolved/invalid targets rather than passing raw repost markers.
- Bound relay count, time window, event count, content bytes, repost depth to one, and total fetch duration; deduplicate event IDs and verify every event signature/author relation.
- Honor the H10 participant opt-out with zero context relay fetches and include sorted stable event IDs, kind 0 ID, normalization version, and bounds in artifact hashes.
- Handle relay disagreement deterministically and sanitize control text before prompts without rewriting user meaning.
- Test kind 0 inclusion, repost resolution/missing/cycle, invalid signatures, bounds/timeouts, opt-out, ordering, and cache invalidation. Acceptance: profile stages receive the documented typed context and no unbounded relay traversal occurs.

### Q12. Poisoned jobs are operator-log-only

**[STATUS 2026-07-15: confirmed, to implement — plan step P1.12. poisonJobs() (db.ts:549-551) is a SELECT nothing calls; poisoning is console.warn only (jobs.ts:71-73); no organizer-facing status exists.]**

**Evidence:** Jobs enter `poison` state and can be queried, but no organizer-facing event or UI consumes that state (`packages/coordinator/src/pipeline/jobs.ts:65-80`; `packages/coordinator/src/store/db.ts:546-550`).

**Impact:** An attendee can remain indefinitely without a profile or matches while the organizer sees only apparently stale activity.

**Recommendation:** Publish a privacy-safe, authenticated coordinator status or gift-wrapped organizer notification with stage, attendee, attempts, last error category, and retry action. Surface queue health in Admin.

**Specifics:**

- Define a signed/gift-wrapped organizer status payload with coordinate, job ID, stage enum, blinded or authorized attendee pubkey, attempts, state, sanitized error category, timestamps, and retryability; omit transcript/profile/provider body.
- Publish on transition to poison and on organizer retry resolution, authored by the currently configured coordinator and addressed to organizer identities; deduplicate by job ID/state.
- In `Admin.svelte` Health/Operations, show pending/running/poison counts and poison rows with stage, attendee link where authorized, age, and `Retry`/`Dismiss` actions.
- Retry creates or resets a job only after checking current source revision/config and records the organizer actor; concurrent retries must result in one pending job.
- Treat stale/forged/wrong-event status as invalid, show status freshness, and recover the dashboard from durable coordinator events after a clean browser.
- Test authenticated/forged notices, privacy fields, duplicate poison, retry race, stale source, coordinator replacement, and relay failure. Acceptance: organizers can detect and act on poison without reading server logs or attendee plaintext.

### Q13. Current tests do not enforce the advertised release bar

**[STATUS 2026-07-15: confirmed — cross-cutting, to implement incrementally. Only smoke + env-gated walking skeleton exist; CI exists (.github/workflows/ci.yml) but has no adversarial coverage. Every P0/P1 plan step carries its own regression tests as acceptance; wiring them as required CI is plan step P4.1.]**

**Evidence:** The walking-skeleton E2E is environment-gated, smoke coverage is narrow, and no committed suite covers the critical identity-switch, forged-grant, recovery, revocation, SSRF, crash, config, or accessibility scenarios (`e2e/tests/smoke.spec.ts`; `e2e/tests/walking-skeleton.spec.ts`).

**Impact:** The project's most security-sensitive and user-visible regressions can pass normal `pnpm check`.

**Recommendation:** Make pinned-infrastructure integration tests part of required CI. Add identity isolation, forged grants, old-grant recovery, coordinator DB recovery, running-job crash, revocation match continuity, matching-off, live config, hostile media, and Cashu crash cases. Add axe, keyboard, mobile viewport, text zoom, horizontal overflow, route focus/title, and language assertions.

**Specifics:**

- Split CI into deterministic unit, protocol integration, coordinator integration with temporary SQLite, and Playwright PWA jobs; pin relay/Blossom/provider mocks by digest/version and fail required checks when fixtures cannot start.
- Add the listed security/recovery cases as committed tests, using real signing/encryption and on-disk restart boundaries rather than mocks at the trust boundary.
- Add hostile-media fixtures served by controlled HTTP/DNS test infrastructure and Cashu fault injection at each journal transition; never make CI contact public relays, mints, or AI providers.
- Run axe plus keyboard-only flows, route title/focus/lang assertions, 320/360/412 px screenshots, 200% zoom, forced colors, and `scrollWidth` checks in English and Slovak.
- Keep the real-relay walking skeleton as scheduled/manual evidence, but make the pinned local skeleton mandatory on pull requests with retained logs/artifacts on failure.
- Define pass criteria and time budgets in repository CI docs, quarantine only with owner/expiry, and track flaky retries as failures. Acceptance: every critical finding's regression test runs in normal required CI.

### Q14. Runtime and infrastructure declarations are inconsistent

**[STATUS 2026-07-15: implemented 2026-07-15 — plan step P2.4. Standardized on one Node major (22, min 22.5 for node:sqlite): root + coordinator `engines.node` = >=22.5.0, Dockerfile pinned to node:22.14.0-bookworm-slim, CI (ci.yml) + deploy (deploy.yml) node-version = "22". docker-compose strfry/blossom pinned by immutable @sha256 digests (was :latest / :master). Added a CI guardrail job (.github/workflows/ci.yml → .github/scripts/check-pins.mjs) that fails on any Node-major mismatch across engines/Dockerfile/workflows or any non-digest-pinned compose image. Was: confirmed, to implement. FOLLOW-UP (out of this change's packaging/CI allowlist): README.md already says Node ≥22.5 (correct); docs/IMPLEMENTATION_PLAN.md:207 still says "CI/Docker pin Node 24" — stale, update in the P2.1 docs pass.]**

**Evidence:** Root engines say Node 20, README says Node 22.5, Docker uses another fixed major, and implementation notes contain stale runtime claims (`package.json:8-10`; `README.md:48-49`; `docker/coordinator.Dockerfile`; `docs/IMPLEMENTATION_PLAN.md`). Docker Compose also uses mutable relay/Blossom tags.

**Impact:** Developers and deploys can select incompatible Node versions; test infrastructure can change without a repository change.

**Recommendation:** Declare the real minimum in the coordinator package and root, pin a supported Node major across CI/Docker/docs, and pin infrastructure images by version or digest.

**Specifics:**

- Choose one supported Node major/minimum from actual dependency/runtime use and set it consistently in root and coordinator `package.json` engines, version-manager file, CI setup, Docker base, README, and implementation docs.
- Use an exact major/minor or digest for build/runtime Docker stages and pin relay/Blossom Compose images by immutable version/digest with human-readable comments.
- Add a CI assertion that reads declarations and fails on mismatched Node majors or mutable infrastructure tags; run install/build/test on the declared minimum.
- Document the upgrade procedure and support window, including lockfile regeneration and coordinator SQLite backup/rollback checks.
- Test container build/start, native dependency compatibility, PWA/protocol build, coordinator smoke, and Compose health on the pinned versions. Acceptance: a new contributor and deployment use the same runtime without interpreting contradictory docs.

### Q15. Important boundaries rely heavily on `any`

**[STATUS 2026-07-15: confirmed, to implement — plan step P4.2, incremental. no-explicit-any is off (eslint.config.js:31); roughly 22 `any` uses in coordinator src, concentrated at trust boundaries.]**

**Evidence:** ESLint disables `no-explicit-any`, and transport filters, job payloads, SQLite rows, and provider responses use broad `any` in security-sensitive paths (`eslint.config.js`; coordinator transport/store/provider files).

**Impact:** Protocol and provider drift bypass compile-time checks at the exact locations where data crosses trust boundaries.

**Recommendation:** Introduce typed job-payload maps, typed DB rows, validated provider responses, and shared Nostr event/filter interfaces. Keep unavoidable `any` narrowly local rather than disabling the rule project-wide.

**Specifics:**

- Define a discriminated `JobPayloadMap` keyed by job type and use generic enqueue/claim handlers so a job cannot be paired with the wrong payload at compile time; runtime-parse persisted JSON before dispatch.
- Add explicit SQLite row interfaces and conversion functions in `store/db.ts`, including nullable/date/boolean normalization, instead of returning driver `any` into domain code.
- Use provider schemas from Q9 and shared protocol Nostr event/filter types at app/coordinator transport boundaries; unknown external input starts as `unknown`.
- Re-enable `no-explicit-any` globally, then use targeted line-level exceptions only around untyped third-party APIs with a comment and immediate validation/conversion.
- Convert security-sensitive files first: grant/config parsing, coordinator transport/store/jobs, providers, and media descriptors; avoid broad refactors of internal UI state.
- Add typecheck/lint to required CI and tests for runtime row/payload rejection. Acceptance: boundary modules contain no unvalidated `any`, and malformed persisted/external values fail predictably.

---

## Documentation and product-trust findings

### D1. Existing security review contains resolved findings as if they are current

**[STATUS 2026-07-15: fixed / in progress (encryption-fixes). ENCRYPTION-AND-PRIVACY.md is now dated, code-verified, and marks F1-F3 as FIXED 2026-07-15 (working-tree edits from the in-flight encryption-fixes agent). No separate action; let that work land.]**

**Evidence:** `docs/ENCRYPTION-AND-PRIVACY.md:33-36,248-270` says coordinator keys are plaintext and installation is unauthenticated. Current code encrypts key columns and verifies install seal authors (`packages/coordinator/src/store/db.ts:11-17,149-188`; `packages/coordinator/src/coordinator.ts:343-359`).

**Impact:** Readers cannot tell the current security posture and may repeat obsolete remediation work.

**Recommendation:** Date and version security reviews, add resolution markers with commit references, and separate current findings from historical findings.

**Specifics:**

- Add front matter/status to `ENCRYPTION-AND-PRIVACY.md`: review date, reviewed commit, current/historical status, superseding review link, and a warning that findings describe that snapshot.
- Mark coordinator at-rest key encryption and authenticated installation grants (`21603`) as resolved with the implementing commit/test references; do not list either as open work anywhere in this audit or roadmap.
- Split findings into `Open`, `Resolved`, and `Accepted limitation`, preserving original text under resolved items for audit history rather than deleting evidence.
- Add a repeatable security-review template requiring code commit, deployment manifest date, threat assumptions, owner, resolution commit, and verification test.
- Link current security posture from README/docs index and label older test reports historical without rewriting their recorded results.
- Acceptance: a reader can identify the latest open set and verify both resolved fixes from source/tests without mistaking them for recommendations.

### D2. Current deployment AI privacy claims contradict each other

**[STATUS 2026-07-15: confirmed (no manifest exists), and the audit under-states the problem: SPECIFICATION.md:675 (section 16.4) currently claims the reference deployment is all-Venice private tier with require_private=true, while ENCRYPTION-AND-PRIVACY.md:243-246 and the owner decision say the match model runs on a NON-private tier (accepted for cost). Fix section 16.4 to state reality — plan step P2.1. Whether to build a generated deployment manifest is an owner question.]**

**Evidence:** The encryption review describes a non-private live match model (`docs/ENCRYPTION-AND-PRIVACY.md:236-242`), while specification/implementation notes name different models and privacy tiers.

**Impact:** Organizers and attendees cannot know where plaintext profile and transcript data currently goes.

**Recommendation:** Publish one dated deployment manifest with provider, exact model IDs, privacy tier, retention/training policy, and effective config. Clearly label recommended defaults separately from the running deployment.

**Specifics:**

- Add a dated generated deployment manifest documenting coordinator operator/version, STT/summary/match/embedding providers and exact model IDs, endpoint operators, privacy tier, retention/training policy, region where known, and effective date.
- Generate nonsecret fields from validated `coordinator.toml` plus provider metadata at release/deploy time; never include API keys, Cashu proofs, private endpoints, or attendee data.
- Distinguish `Currently deployed`, `Recommended default`, and `Supported options` in headings/tables, and retain prior manifests as immutable dated history.
- Link the active manifest from event privacy disclosure and organizer coordinator card; if runtime config differs, mark disclosure stale/unavailable rather than asserting a default.
- Add a check that configured role/provider/model combinations appear in the manifest and that privacy/retention fields are nonempty.
- Acceptance: the same provider/model/privacy facts appear in deployment docs and pre-submission UI for the running service.

### D3. There is no data retention, deletion, export, or event shutdown policy

**[STATUS 2026-07-15: confirmed, to implement (docs + temp-file hygiene) — plan step P4.4. No retention/deletion/shutdown doc exists. The attendee export/delete features and event-shutdown tooling are an owner question.]**

**Evidence:** Documentation explains forward-only revocation but not retention of encrypted videos, decrypted coordinator files, transcripts, AI profiles, provider data, relay events, or Blossom blobs.

**Impact:** Sensitive face, voice, biography, and inferred-interest data has no defined lifecycle. Organizers cannot answer basic privacy questions.

**Recommendation:** Define default retention per data class, deletion controls, end-of-event cleanup, export, provider retention, and best-effort limits on relays/participant copies. Add a coordinator shutdown/replacement runbook, including `E_inbox` rotation.

**Specifics:**

- Create a retention matrix for raw encrypted media, temporary decrypted files, transcripts, profiles, artifacts, matches, reports, jobs/logs, SQLite backups, relay events, Blossom blobs, provider copies, and browser state, with owner, default duration, deletion mechanism, and hard limitations.
- Enforce coordinator temporary-file deletion in `finally`, scheduled expiry for configured DB/artifact classes, log redaction/rotation, and best-effort Blossom deletion where supported; document that relay and recipient copies may persist.
- Add attendee export/delete requests and organizer event shutdown controls as authenticated operations with status receipts; deletion must not promise erasure from third-party relays/clients.
- Shutdown runbook: stop admission/jobs, drain or cancel work, export required custody/status, publish closure, rotate `E_inbox`, revoke/replace coordinator assignment, delete local sensitive state per policy, and verify recovery/rollback.
- Replacement must overlap safely until the new coordinator is authenticated and healthy, then remove old authority prospectively; at-rest encryption is already fixed and remains a control, not remediation.
- Test expiry jobs with fake time, crash cleanup, export completeness, idempotent delete, unsupported Blossom deletion, shutdown/replacement rollback, and audit receipts. Acceptance: every data class has truthful UI/docs and an implemented lifecycle owner.

### D4. Normative, implemented, planned, and historical material are mixed

**[STATUS 2026-07-15: partially true, to implement — plan step P4.5. The spec has scattered "(implemented)" and section-13 future labels, but no consolidated feature-status matrix exists.]**

**Evidence:** `SPECIFICATION.md` includes custom event pages, themes, members-only posts, talks, and matrices alongside implemented behavior. `IMPLEMENTATION_PLAN.md`, guides, and tests show a different current feature boundary. Historical reports retain resolved blockers without a prominent archive banner.

**Impact:** Users, contributors, and auditors cannot reliably distinguish shipped behavior from protocol design or plans.

**Recommendation:** Add a generated feature-status matrix with Shipped, Experimental, Protocol only, Planned, and Historical. Keep the normative protocol separate from current product documentation. Add “historical/resolved” banners to old test reports.

**Specifics:**

- Add a machine-readable feature inventory with feature ID, status (`Shipped|Experimental|Protocol only|Planned|Historical`), app/coordinator/protocol support, config gate, tests, and last verified commit/date.
- Generate the reader-facing matrix and validate links in docs CI; talks must be shown as optional/config-gated until U11's full journey ships, and meeting-plan redesign remains deferred/out of scope.
- Restructure `SPECIFICATION.md` so normative event/payload rules are clearly labeled separately from product roadmap examples; shipped guides may link to but not imply protocol-only UI exists.
- Add prominent immutable banners to old reports with snapshot date/commit and links to current status; use resolution annotations rather than silently editing historical conclusions.
- Require feature PRs to update inventory/status/tests in one change and fail docs checks for unknown status or shipped without evidence.
- Acceptance: readers can answer whether custom pages, themes, talks, matrices, chat, and recovery are shipped without reconciling contradictory prose manually.

### D5. “All application state lives on Nostr” is too absolute

**[STATUS 2026-07-15: confirmed, to implement — plan step P2.1. SPECIFICATION.md:24 still states the absolute claim.]**

**Evidence:** Correctness-relevant state also lives in Blossom, coordinator SQLite, invite usage, local IndexedDB, pending-join markers, outboxes, and browser caches (`docs/SPECIFICATION.md:22-25` versus current implementation).

**Impact:** Recovery expectations are stronger than the architecture supports.

**Recommendation:** Document state by category: authoritative, replicated, reconstructible cache, and device-local secret state. State the relay-retention and local-storage assumptions for each.

**Specifics:**

- Add an architecture state table covering identity keys, identity-scoped event custody, self-encrypted backups, configs, grants, roster/directory/matches, media blobs, jobs/artifacts, invites, notes/relationships, DMs, pending joins, and publish queues.
- For each, name authority, writers/readers, encryption, storage locations, replication, retention dependency, reconstruction source, conflict rule, and consequence of loss.
- Replace “All application state lives on Nostr” with a bounded claim such as “Portable event state is published through Nostr where specified; secrets, media, processing state, and caches also use the listed stores.”
- Document relay availability/history assumptions and when explicit full-history restore is required versus a three-day live scan.
- Align disaster-recovery procedures and product copy with C1/H2, including persistent identity-scoped IndexedDB and durable self-encrypted backup status.
- Acceptance: every correctness-relevant store in source has a category and no recovery claim depends on an undocumented local/SQLite copy.

### D6. Coordinator-less events are described as fully working

**[STATUS 2026-07-15: largely obsolete — ORGANIZER-GUIDE.md:147-149 already says coordinator-less events have no automatic matches and need manual invite approval. It is not called "directory-only mode" but the limitations ARE listed; optional wording tightening rides P2.1. No separate work.]**

**Evidence:** Guides describe coordinator-less operation positively, but transcription, AI profiles, matchmaking, translation, and invite auto-approval are absent.

**Impact:** Organizers can create an event expecting the main product value and receive only a reduced directory workflow.

**Recommendation:** Call this “directory-only mode” and list exactly what is unavailable before event creation or coordinator detachment.

**Specifics:**

- Rename coordinator-less behavior to `Directory-only mode` in Create, Admin, event status, organizer/participant guides, and feature matrix; keep protocol terminology separate where needed.
- Show unavailable capabilities before creation/detachment: transcription, generated profiles/translation, matchmaking/matrix, invite auto-approval, talk processing, processing status, and any coordinator-mediated recovery/moderation.
- State what remains: signed event/config, manual admission where supported, encrypted directory/authored profile, updates, interoperable identity/DM links, and local/manual operations actually implemented.
- Require consequence confirmation before detaching and update U1 readiness so it does not remain indefinitely at Processing or promise Matches when matching/coordinator is unavailable.
- On coordinator reconnect, enqueue only missing current-revision work after authenticated installation; directory-only data remains intact.
- Test creation, detachment, reconnect, invite-only incompatibility, matching UI hiding, and both locales. Acceptance: no coordinator-less screen advertises AI/transcription outcomes.

### D7. Public-profile wording needs to say “public on Nostr”

**[STATUS 2026-07-15: confirmed, to implement — plan steps P2.1 (guides) and P2.3 (UI strings). messages.ts:69,222-226 say only "public"; the publicNote clarifies event scope but not that public means the global Nostr network.]**

**Evidence:** Generated identities publish name, photo, and bio as kind 0, while event-specific fields remain encrypted (`docs/SPECIFICATION.md:97-106`). Current labels say public but may be read as public to the event.

**Impact:** Newcomers may not understand that their profile is visible outside the event on the global Nostr network.

**Recommendation:** Use “Public on Nostr and visible outside this event,” show a publication preview, and allow a minimal identity without a photo or bio.

**Specifics:**

- Replace ambiguous `Public` labels in Login/Join/profile settings and guides with `Public on Nostr and visible outside this event`; separately label encrypted event-only fields.
- Before signing kind 0, show a preview of exact name, photo URL, and bio plus the active identity pubkey and a link explaining relay replication.
- Allow creation/publication with only the minimum display name required by current UI, or a generated shortened npub label if no name is required; photo and bio remain optional with no dark pattern.
- Do not copy event-specific skills, intro transcript, generated summary, or seeks/offers into kind 0 unless the user explicitly edits the public preview.
- On partial publication failure use Q4 stages and retain the preview; explain that replacement removes fields prospectively but relay caches may retain old events.
- Test minimal identity, omitted photo/bio, preview equality to signed content, event/public field separation, both locales, and screen-reader labels. Acceptance: users can predict exactly what leaves the event boundary.

### D8. Co-organizer delegation needs a stronger warning and eventual scoped roles

**[STATUS 2026-07-15: split. Scoped roles + removal design: DECLINED BY OWNER — full-custody irrevocable co-organizer grants are accepted, scoped admin roles deferred (spec section 13). The high-friction warning copy is compatible with that decision and cheap — plan step P2.3 (addCoOrg currently sends the 21605 immediately with no confirmation, Admin.svelte:177-196, and the copy has no irreversibility warning). Label co-organizers "Full custody" per the accepted model.]**

**Evidence:** A `21605` grant transfers `E_id`, `E_inbox`, and all ECKs, making the recipient cryptographically equivalent to the creator (`docs/SPECIFICATION.md:296-301`; `docs/ENCRYPTION-AND-PRIVACY.md:145-155`).

**Impact:** An organizer may treat this like an ordinary admin invitation even though it grants irreversible full custody and the power to add more co-organizers.

**Recommendation:** Add a high-friction confirmation explaining full, effectively irreversible control. Introduce approve-only and operations roles that do not receive `E_id`. Design removal before encouraging broad delegation.

**Specifics:**

- Before existing `21605`, show a typed/checkbox confirmation stating the recipient receives event signing key, inbox key, all ECKs, can impersonate the organizer/add others, and cannot be cryptographically removed from keys already learned.
- Verify the displayed recipient npub/profile and require a fresh signer confirmation; never accept a pasted secret key, and log the authenticated grant event ID locally for custody history.
- Define future scoped grants as separate versioned role payloads (`approve-only`, `operations`) with explicit capabilities and no `E_id`/`E_inbox` secret; do not simulate scope while sending full custody.
- Design removal as prospective: publish role revocation, rotate affected ECK/inbox capability, update coordinator/clients, and acknowledge that copied full organizer keys cannot be revoked without creating a new event identity.
- Until scoped roles ship, label all co-organizers `Full custody` in Admin and recommend the smallest possible set.
- Test wrong recipient, cancelled/failing signature, duplicate grant, full-custody warning accessibility, scoped payload secret absence, and prospective removal model. Acceptance: no ordinary “admin invite” copy understates irreversible authority.

### D9. Invite-link secrecy wording is misleading

**[STATUS 2026-07-15: fixed in code / in progress (encryption-fixes F3): Join.svelte:44-56 now strips ?code= via history.replaceState immediately after consumption, mirroring the login-nsec path. Remaining: guide wording ("never touches a server" should be "not sent to the app's web server" + bearer-link warning) — rides plan step P2.1.]**

**Evidence:** Guides say a fragment never touches a server, but the full link can remain in history, clipboard, chats, previews, and share sheets. Unlike login-nsec links, invite code removal is not clearly implemented after consumption (`docs/ENCRYPTION-AND-PRIVACY.md:272-283`).

**Impact:** Organizers may treat a bearer invitation as more confidential than it is.

**Recommendation:** Say “not sent to the app's web server,” strip the code from history immediately, and explain that anyone seeing the unused link can claim it first.

**Specifics:**

- Update guides/share UI to say the fragment is not sent to the app's web server by normal browser requests, but may remain in clipboard, history before cleanup, chats, previews, screenshots, backups, or recipient devices.
- In initial route parsing, read the invite secret once into identity/session-scoped memory, then immediately `history.replaceState` to the canonical URL without it before rendering analytics, previews, or external links.
- Never write the raw invite code to logs, recent events, error details, service-worker caches, telemetry, referrers, or IndexedDB; persist only a one-way proof/reference if retry requires it.
- Show organizer share copy: `Bearer invite - anyone with an unused link can claim it first`; provide revoke/expiry/usage state and regenerate rather than redisplaying secrets unnecessarily.
- On invalid/exhausted/replayed links, clear the fragment anyway and show a safe state; coordinate with A3 so Back cannot reveal the original secret.
- Test first load, refresh, Back/Forward, service worker/cache, clipboard/share output, invalid code, concurrent final claim, and log scanning. Acceptance: the address bar/history is sanitized immediately and wording does not promise endpoint-independent secrecy.

---

## Design direction

**[STATUS 2026-07-15: owner question. The concrete low-risk pieces (local SVG icons replacing emoji, Avatar initials fallback, theme-color sync) can ride Phase 3; the broader constellation identity, display typeface, and event color wash need an owner decision before investment. Note: P9 is adding per-event themes (spec section 7.4, kind 31609) right now — any visual-identity work must build on that system, not race it. Also note the owner accepted full custom per-event CSS (spec 7.4) with documented exfiltration risk, which conflicts with this section's "fixed palette, not arbitrary organizer CSS" advice — the fixed-palette-only recommendation is overridden by that decision.]**

The current design is clean and competent, but it still reads as a generic purple card-based application. The product deserves a clearer identity tied to navigation, signals, and human connection.

### Recommended visual concept: constellation and course

Use the “nautica” and navigation idea as a functional visual language rather than decoration. People are points and recommendations are routes. This can appear in readiness progress, score visualization, and event headers without becoming a literal space-themed interface; meeting-plan and recap visuals are deferred with U2.

Recommended changes:

- Replace platform-dependent emoji with a consistent custom icon set.
- Use a restrained constellation/route motif for Matches and event progress without implying a meeting plan.
- Replace bare match percentages with a compact confidence treatment and put technical dimensions in a details disclosure.
- Add initial-based avatar fallbacks everywhere instead of empty circles.
- Give event pages a subtle event-derived color wash so subpages retain context.
- Use a distinctive display face for event titles and key moments while retaining a highly legible system/UI face for controls.
- Reduce repeated generic cards by using spacing, dividers, grouped lists, and stronger information hierarchy.
- Use photography/video as social presence, not merely content in bordered boxes.
- Preserve both themes, but update browser/PWA `theme-color` when effective theme changes (`packages/app/src/app.html:6`; `packages/app/src/lib/stores/theme.svelte.ts`).

**Specifics:**

- Extend existing tokens in `packages/app/src/lib/styles/app.css` rather than introducing a parallel theme: add semantic route-line, event-wash, surface-elevated, focus, success/warning, and muted-border tokens for both current light/dark themes with AA contrast.
- Add local SVG icon components under `packages/app/src/lib/components/icons/` using a shared 24 px grid, `currentColor`, rounded navigation-like strokes, and no emoji/external requests; decorative route lines are `aria-hidden`.
- Use the current UI/system font for controls and body for speed/readability; use one locally bundled or system-serif display stack only for event titles/key milestones, with metric-safe fallbacks and no remote font fetch.
- Add a shared `Avatar` with image load/error handling and deterministic initials from display name or shortened npub, event-derived background token, sufficient text contrast, and an accessible name supplied by its context.
- Derive a subtle event wash from the signed event pubkey/coordinate through a fixed palette, not arbitrary organizer CSS; apply it to `EventHeader` and page background at low contrast while keeping text on normal surface tokens.
- Build/reuse `EventHeader`, `Avatar`, `PersonCard`, status step, icon button, and responsive action components; reduce card nesting with dividers/grouped lists. Keep route/constellation lines decorative around progress and Matches, without implementing deferred meeting-plan mechanics.
- At <= 640 px use one column and bottom event navigation; at wider widths use bounded content plus contextual side/secondary panels, with no hover-only information and motion disabled under `prefers-reduced-motion`.
- Add visual regression tests for light/dark, event palette extremes, image failure/long initials, 320/412/768/1280 px, 200% zoom, forced colors, reduced motion, keyboard focus, and offline icon loading. Acceptance: all assets are local, every key state passes contrast/focus checks, and event identity remains visible without decorative clutter.

### Recommended event participant information architecture

**[STATUS 2026-07-15: consistent with the U1/U3/U7/U8 statuses above; U2 (meeting plan) correctly excluded. Serves as the target IA for plan steps P2.6 and P3.5 once the owner confirms the navigation change.]**

**Overview:** event status, next action, latest update, readiness progress.

**People:** searchable/filterable roster with concise cards.

**Matches:** ranked recommendations with concise reasons and score details available on request. The meeting-plan redesign in U2 is deferred.

**Updates:** organizer announcements and schedule/location changes.

**More:** messages, identity handoff, settings, event privacy details.

**Specifics:**

- Keep four primary event destinations: `Overview`, `People`, `Matches`, and `Updates`; U2's rename to `My plan`, five-person plan, opening questions, replacement, progress, and recap are deferred and out of scope.
- `Overview` contains compact event metadata/status, latest update, U1 readiness, and exactly one primary next action; backup/privacy details open inline or in More without displacing the action.
- `People` contains searchable/filterable roster and concise cards; person detail owns bio/media, Want to meet/Met, private note, DM, NIP-51 mute, and report actions.
- `Matches` retains the current ranked recommendation model, with concise cards and technical score dimensions behind disclosure; it is hidden/marked unavailable when matching is off or not ready.
- `Updates` contains organizer announcements and schedule/location changes in reverse chronology with unread semantics only when durable state exists.
- Put Messages, identity/account handoff, event privacy/provider disclosure, global Events, and Settings in the accessible avatar/More menu; organizers get a clear `Manage event` entry.
- Use the event-scoped shell in U3, preserve direct links and role/config gating, and keep normal conferences/talks-off free of Talks navigation; prerecord-first events may add `Talks` as a gated destination.
- Test visitor/pending/attendee/organizer, matching off/not ready, talks off/on, direct links, Back, 320 px, desktop, keyboard, and screen reader. Acceptance: every event task is reachable in two actions or fewer without introducing U2 behavior.

### Recommended organizer information architecture

**[STATUS 2026-07-15: consistent with the U4/U14/Q12 statuses above; target IA for plan step P3.6. Note "scoped/full custody" test mention: scoped roles are owner-deferred, only full custody exists.]**

**Operations:** pending approvals, failures, attendee activity, intro completion, match readiness.

**Communicate:** public/member updates, share link, invites.

**People:** approved attendees, moderation, revocation, reprocessing.

**Event setup:** coordinator, AI/privacy settings, co-organizers, admission policy, appearance.

**Health:** relay replication, coordinator queue, provider status, poison jobs, storage/recovery status.

**Specifics:**

- Make `Operations` the default Admin view with status strip, pending approvals first, processing failures, attendee/intro counts, match readiness, and authenticated coordinator freshness; urgent items sort above healthy metrics.
- `Communicate` contains updates, share link, invite creation/revocation/usage, and audience preview; bearer-secret warnings and admission-mode semantics are shown at creation time.
- `People` contains approved/pending/declined attendees, search/filter, bulk approval/decline, moderation reports, revocation, and reprocessing with per-person outcomes.
- `Event setup` contains event metadata, admission, optional talks mode, matching/privacy/provider choices, coordinator connect/replace/detach, and full-custody co-organizers; dangerous actions are grouped last with explicit consequences.
- `Health` reads authenticated/durable state for relay acknowledgements, queue/running/poison counts, provider/model/privacy manifest, last successful job, backup/recovery status, and event shutdown readiness; stale/unknown is never green.
- On desktop use a persistent section rail and two-column Operations layout; on mobile use a single ordered page/section picker with selection-only sticky bulk bar and no hidden horizontal tables.
- Add shared status/error/field components, keyboard-accessible section headings and deep links, plain-language summaries with technical detail disclosures, and role checks before every action as well as in UI visibility.
- Test no coordinator, healthy/degraded/poison, high-volume requests, partial bulk failure, talks/matching modes, scoped/full custody, stale relay data, 320 px/200% zoom, keyboard, and screen reader. Acceptance: pending and failed work is visible without scrolling through setup and no health claim relies on unauthenticated status.

---

## Suggested implementation roadmap

**[STATUS 2026-07-15: superseded by the "Implementation plan (2026-07-15)" below, which keeps this phase structure but re-sequences around in-flight work (P9 event customization, encryption fixes, chat re-spec) and owner decisions. Phase-4 item 3 (Marmot/MLS): the chat direction is being re-specified right now in GROUP-CHAT-FEASIBILITY.md (NIP-17 groups and/or Marmot per organizer choice; ECK web-only chat dropped) — defer to that document.]**

### Phase 0: security and correctness gate

1. Scope all local state by active identity.
2. Authenticate PWA-received grants.
3. Restrict and bound coordinator media fetching/ffmpeg.
4. Add job leases and restart recovery.
5. Add strict protocol/config validation.
6. Add required tests for these boundaries.

### Phase 1: durable lifecycle

1. Implement attendee and organizer key recovery records.
2. Implement coordinator installation recovery and replacement/detachment.
3. Republish match output on ECK rotation.
4. Honor live config, matching-off, and event matrix settings.
5. Define retention, deletion, event shutdown, and provider disclosure.
6. Surface coordinator queue and poison state to organizers.

### Phase 2: participant experience

1. Add the event readiness journey and fix post-approval routing.
2. Keep the existing ranked Matches concept; the meeting-plan redesign in U2 is deferred and out of scope for this roadmap.
3. Add search and high-value roster filters.
4. Redesign recording with coaching, file fallback, and text/audio alternatives.
5. Add correction, NIP-51 mute, and report flows.

### Phase 3: organizer experience and design system

1. Redesign Admin around operations and status.
2. Add shared `Field`, `AsyncState`, `ErrorState`, `SaveStatus`, `Avatar`, `PersonCard`, and responsive action components.
3. Complete route focus/title/live-region accessibility.
4. Apply the constellation/course visual language and consistent icons.
5. Add desktop/tablet adaptations without weakening the mobile-first attendee flow.

### Phase 4: expansion only after the foundation is stable

1. Complete the prerecorded-talk experience if it remains central to positioning.
2. Add simple ECK event chat only if event-day research shows demand.
3. Keep Marmot/MLS chat experimental until interop and browser-state recovery are proven (`docs/GROUP-CHAT-FEASIBILITY.md`).
4. Add custom event pages/themes only after CSS/resource privacy, moderation, and design-system constraints are defined.
5. Expand provider routing after current privacy, cache, and payment semantics are reliable.

## Final recommendation

Do not try to make Nostrautica “a lot better” by adding many more features. Make the existing promise dependable and more behavior-oriented.

The best near-term version of Nostrautica is an app that safely gets an attendee from “I opened this event link” to “I found relevant people, made useful connections, and can stay connected.” Every engineering and design decision should be evaluated against that line. Security/recovery fixes make the promise trustworthy; a guided readiness journey and clear Matches experience make it useful; an event-scoped, distinctive visual system makes it memorable. The meeting-plan redesign in U2 remains deferred and out of scope for now.
---

## Implementation plan (2026-07-15)

Verified against the tree at commit a5b8a08 plus in-flight working-tree edits. Every audit
finding above carries a dated status marker; this section schedules the items worth doing.

**In-flight work streams (conflict tags used below):**

- **P9** — event customization (spec §7.4): `packages/protocol` kinds/schemas/event-page,
  `packages/app` `social/markdown.ts`, new posts/theme pages, `EventHome.svelte`,
  `Admin.svelte`, `docs/SPECIFICATION.md`.
- **encryption-fixes** — F1/F2/F3 from ENCRYPTION-AND-PRIVACY.md: `packages/coordinator`
  `store/db.ts`, `coordinator.ts`, `main.ts`; `packages/app` `events/organizer.ts`,
  `pages/Join.svelte`.
- **chat-respec** — `docs/GROUP-CHAT-FEASIBILITY.md`.

**Scheduling rule:** a step tagged with a stream must not start until that stream's changes
land (or must be explicitly coordinated). Steps tagged `conflicts: none` can start
immediately, in parallel with the in-flight work. Sizes: S = up to half a day, M = 1-2 days,
L = 3+ days.

### Phase 0 — security gate

**P0.1 — Authenticate PWA-received grants (C2).**
Steps: in `receiveGrants()`, for 21605 require `rumor.pubkey === parseCoordinate(grant.a).pubkey`,
`granted_by === rumor.pubkey`, and that granted organizer secrets derive the coordinate's
`E_id`/declared inbox; for 21602 fetch the signed 31600 for the coordinate and accept only
`E_id` or the currently configured coordinator as author; validate before any keystore write;
add negative tests (arbitrary sender, wrong event, stale coordinator, mismatched granted_by).
Files: `packages/app/src/lib/events/attendee.ts`, new/extended tests under `packages/app/src/lib/events/`.
Conflicts: none. Size: M.
Acceptance: forged-grant tests fail closed; valid organizer/coordinator grants still accepted; no partial keystore writes.

**P0.2 — Owner-scoped local state + durable key backup (C1, U6 store part; honors owner's C1 note).**
Steps: new IndexedDB store keyed `[ownerPubkey, coordinate]` (no migration — discard old DB);
require active pubkey in every keystore API and propagate through attendee/organizer/create
callers; keep records across logout, never enumerate another owner's records; scope
`join-sent`, `recent-events`, and the outbox by owner; publish a self-encrypted replaceable
per-event backup record `{v, coordinate, role, ecks, organizer_keys?, updated_at}` to the
user's relays after every authenticated key change, restore on demand with signature/recipient
validation and monotonic ECK-version merge; show backup status in UI.
Files: `packages/app/src/lib/events/keystore.ts`, `events/attendee.ts`, `events/create.ts`,
`events/organizer.ts`, `signer/session.svelte.ts`, `stores/join-sent.svelte.ts`,
`stores/recent-events.svelte.ts`, `nostr/publish-queue.ts`, `pages/Home.svelte`,
`pages/EventHome.svelte` (call sites), `packages/protocol/src/schemas.ts` (backup payload).
Conflicts: encryption-fixes (organizer.ts) + P9 (EventHome.svelte, schemas.ts) — start after both land.
Size: L.
Acceptance: two identities in one browser cannot read each other's records; records survive
logout/login; a clean browser recovers full custody (incl. organizer keys) from relay backups;
depends on P0.1 so only authenticated grants enter the store.

**P0.3 — Coordinator media hardening (C3).**
Steps: guarded downloader (https-only, Blossom-origin allowlist, DNS resolution with
public-IP check per redirect, max 3 manual redirects, timeout, streamed byte cap into 0600
temp file with hash-while-streaming); ffmpeg spawned without shell in per-job temp dir with
wall-clock kill timer, process-group termination, output cap; permanent-vs-retryable failure
classification; adversarial integration tests (loopback, RFC1918, rebinding, endless stream,
oversize, ffmpeg hang).
Files: `packages/coordinator/src/pipeline/transcribe.ts`, `pipeline/audio.ts`, new
`src/net/safe-fetch.ts`, `src/config.ts`; `packages/protocol/src/schemas.ts` (https-only media URLs).
Conflicts: P9 (schemas.ts only — the coordinator files are free; split the schema edit if needed).
Size: M-L.
Acceptance: all hostile fixtures rejected without resource exhaustion; no request reaches a non-allowlisted endpoint.

**P0.4 — Job leases and crash recovery (H1).**
Steps: add `claimed_at`/`lease_until`/`worker_token` columns + index; claim in one
`BEGIN IMMEDIATE` transaction; token-checked complete/retry/poison; startup + periodic sweep
reclaiming expired leases; crash-after-claim test against an on-disk DB.
Files: `packages/coordinator/src/store/db.ts`, `pipeline/jobs.ts`.
Conflicts: encryption-fixes (db.ts) — start after it lands. Size: M.
Acceptance: kill-after-claim job completes after restart; no job stays `running` forever; stale owner cannot overwrite the new owner's result.

**P0.5 — Strict protocol/config validation (Q6, Q7; Q5 pending owner answer).**
Steps: decoded-length refinements (32-byte keys, 12-byte nonces, validated nsec fields);
strict config schema (enums for approval/matching/visibility, finite bounded numbers,
`wss:`/`https:` scheme checks, dedup rules); consume only the parsed type in app + coordinator;
table/fuzz tests. If owner approves Q5, lock `v` to literal PROTOCOL_VERSION with an envelope-dispatch pattern.
Files: `packages/protocol/src/schemas.ts`, `packages/protocol/src/config.ts` + tests.
Conflicts: P9 (protocol package) — start after P9 lands. Size: M.
Acceptance: malformed crypto material and config fail at parse time; app and coordinator reject identically.

### Phase 1 — durable lifecycle and coordinator correctness

Most of this phase touches `coordinator.ts`/`store/db.ts` — schedule the phase as a block
after encryption-fixes lands.

**P1.1 — Recovery beyond the 3-day window (H2).** Organizer restore path for the existing
`nostrautica:eventkeys:*` 30078 backups (or cutover to the P0.2 format — one format, documented);
explicit-restore queries with no 3-day floor (keep the bounded scan for live overlap only);
coordinator self-encrypted installation registry + restore into empty SQLite after verifying
identity and current 31600 assignment; backup/restore status in UI.
Files: `packages/app/src/lib/events/create.ts`, `events/organizer.ts`, `events/attendee.ts`,
`packages/protocol/src/schemas.ts`, `packages/coordinator/src/coordinator.ts`, `store/db.ts`.
Conflicts: encryption-fixes + P9. Size: L.
Acceptance: attendee, organizer, and coordinator each recover from records older than 3 days on a clean device/DB.

**P1.2 — Republish matches on ECK rotation (H3).** Persist canonical per-attendee match
payloads; in the revocation flow re-encrypt cached lists under each remaining attendee's new
blinded `d` (zero provider calls); include the 31606 matrix when visibility=event; idempotent
per-recipient retry.
Files: `packages/coordinator/src/coordinator.ts`, `nostr/publisher.ts`, `store/db.ts`.
Conflicts: encryption-fixes. Size: M.
Acceptance: after revocation, remaining attendees' lists resolve under the new `d` with unchanged content; revoked user cannot decrypt post-rotation output; provider call count is zero.

**P1.3 — Honor `matching=off` and publish 31606 (H4).** Carry `matching` + `matchVisibility`
into persisted event state; gate all AI stages (download, STT, summarize, profile, embed,
score) when off; re-check config at job execution; call `buildMatchMatrix` when visibility=event.
Files: `packages/coordinator/src/coordinator.ts`, `store/db.ts`.
Conflicts: encryption-fixes. Size: M.
Acceptance: config-mode table test — zero provider invocations with matching off; 31605/31606 published per mode.

**P1.4 — Live 31600 config subscription (H5).** Subscribe per installed `E_id`+`d`; validate
replaceable ordering/signature/assignment; atomic store+memory swap; diff-driven effects
(relay handover with overlap, recompute only what changed).
Files: `packages/coordinator/src/coordinator.ts`, `store/db.ts`.
Conflicts: encryption-fixes. Size: M.
Acceptance: language/visibility/relay change applies without restart; stale/forged/wrong-`d` events ignored.

**P1.5 — Select ECK by event's `eck` tag (Q8).** Parse the tag, look up exactly that version,
treat missing key as awaiting-key (trigger grant refresh), evaluate replaceable candidates
newest-first keeping newest decryptable.
Files: `packages/app/src/lib/events/attendee.ts`, `events/keystore.ts`.
Conflicts: none (after P0.2). Size: S.
Acceptance: propagation tests in both orders; no false decryption failures during rotation.

**P1.6 — Runtime-validate provider output (Q9).** Zod schemas for STT/profile/translation/
embedding/pair-score responses at the provider boundary; typed provider-contract error,
capped retries, poison with sanitized diagnostics; validate mocks with the same schemas.
Files: `packages/coordinator/src/providers/types.ts`, `providers/venice.ts`,
`providers/routstr.ts`, `pipeline/profile.ts`.
Conflicts: none. Size: M.
Acceptance: malformed/truncated/NaN provider output never enters storage or publication.

**P1.7 — Content-addressed profile + translation artifacts (H7).** Artifact table keyed by
stage + canonical-input hash (use the existing `profileInputsHash`, extend with provider,
model, prompt version, event language); commit each expensive stage before the next; insert-or-read for concurrent duplicates.
Files: `packages/coordinator/src/store/db.ts`, `pipeline/profile.ts`.
Conflicts: encryption-fixes. Size: M.
Acceptance: rerun with identical inputs makes zero billable calls; any material input change makes a new artifact.

**P1.8 — Cashu proof journal (H8).** States available/in_flight/ambiguous/spent/change_pending
keyed by request ID; atomic reserve; return-to-available only on provably-pre-send failure;
mint reconciliation for ambiguous; startup reconcile.
Files: `packages/coordinator/src/providers/cashu.ts` (+ journal persistence, own file or store).
Conflicts: none. Size: M.
Acceptance: crash-at-each-transition tests — no proof silently lost or double-spent.

**P1.9 — Per-role provider registry (H6).** Build provider instances by configured name per
role (summary/match/embedding/stt); validate role capability at startup; fail closed, no
implicit fallback; provider+model in cache keys.
Files: `packages/coordinator/src/main.ts`, `src/config.ts`, `providers/types.ts`.
Conflicts: encryption-fixes (main.ts). Size: M.
Acceptance: mixed Venice/Routstr role config routes each request to its declared provider; unknown model/provider fails startup.

**P1.10 — Source/AI revision consistency (Q10).** `source_revision`/`ai_revision` columns;
clear or label stale AI output before publishing new authored fields; jobs commit only when
their captured revision is still current.
Files: `packages/coordinator/src/coordinator.ts`, `store/db.ts`.
Conflicts: encryption-fixes. Size: M.
Acceptance: no published directory entry pairs source revision N with AI revision N-1 as current.

**P1.11 — Typed Nostr context (Q11).** Keep latest kind 0 as structured metadata; resolve
repost targets with one bounded batched query; include stable event IDs in cache hashes.
Files: `packages/coordinator/src/coordinator.ts`, `pipeline/profile.ts`.
Conflicts: encryption-fixes. Size: S-M.
Acceptance: profile stage receives the documented context; no unbounded traversal.

**P1.12 — Poison surfacing to organizers (Q12).** Gift-wrapped coordinator status payload
(stage, attempts, sanitized error category, retryable) published on poison; Admin health rows
with Retry/Dismiss; retry resets the job once.
Files: `packages/coordinator/src/coordinator.ts`, `packages/protocol/src/schemas.ts`,
`packages/app/src/lib/pages/Admin.svelte`.
Conflicts: encryption-fixes + P9. Size: M.
Acceptance: organizer can detect and retry a poisoned job from Admin without server logs.

### Phase 2 — trust, copy, and quick wins

**P2.1 — Docs truth pass (H9 copy, D2 contradiction, D5, D6 wording, D7 guides, D9 guide wording, H10 guide copy).**
Steps: replace "scores every pair" with "evaluates the strongest candidates for every attendee"
(spec §1 + both pitches); fix §16.4 to state the match model runs on a non-private tier
(owner-accepted) — it currently claims all-private/require_private=true, contradicting
ENCRYPTION-AND-PRIVACY.md and reality; bound the "All application state lives in Nostr" claim;
correct participant-guide access claims (coordinator + providers see intro-derived data);
"public on Nostr" wording in guides; invite-fragment wording ("not sent to the app's web
server" + bearer warning).
Files: `docs/SPECIFICATION.md`, `docs/ELEVATOR-PITCH-en.md`, `docs/ELEVATOR-PITCH-sk.md`,
`docs/PARTICIPANT-GUIDE.md`, `docs/ORGANIZER-GUIDE.md`.
Conflicts: P9 (SPECIFICATION.md) — do after P9's spec edits land. Size: S-M.
Acceptance: no doc claims all-pairs scoring, attendee-only intro access, or a private-tier match model.

**P2.2 — Pre-submission disclosure (H10 UI part).** Short disclosure before upload naming the
coordinator and configured STT/LLM providers and what they receive; explicit confirmation;
localized.
Files: `packages/app/src/lib/pages/Record.svelte`, `lib/i18n/messages.ts`.
Conflicts: none. Size: S.
Acceptance: no intro upload without the disclosure shown; copy matches P2.1 docs.

**P2.3 — UI wording: public-on-Nostr (D7) + co-organizer full-custody warning (D8).**
High-friction confirm before sending 21605 (irreversible full custody, can impersonate event,
can add others); "Full custody" label on co-organizers; "Public on Nostr, visible outside this
event" labels.
Files: `packages/app/src/lib/i18n/messages.ts`, `pages/Admin.svelte`.
Conflicts: P9 (Admin.svelte). Size: S.
Acceptance: grant cannot be sent without explicit confirmation; labels updated in both locales.

**P2.4 — Runtime and image pinning (Q14).** One Node major everywhere; pinned digests/versions
for strfry/blossom images; CI assertion.
Files: `package.json`, `README.md`, `docker/coordinator.Dockerfile`, `docker/docker-compose.yml`,
`.github/workflows/ci.yml`, `docs/IMPLEMENTATION_PLAN.md`.
Conflicts: none. Size: S.
Acceptance: declared Node majors match; no mutable infrastructure tags.

**P2.5 — Small correctness batch (Q1, Q2, Q4, A4).** DM outbox merge with sending/sent/failed
states (Q1); note/toggle SaveStatus with serialized writes (Q2); staged identity creation with
per-stage retry instead of swallowed errors (Q4); set `document.documentElement.lang` in
`i18n.init()` (A4).
Files: `pages/DmChat.svelte`, `pages/Attendee.svelte`, `pages/Login.svelte`,
`lib/i18n/i18n.svelte.ts` (+ small shared SaveStatus component).
Conflicts: none. Size: M total.
Acceptance: optimistic DM never vanishes; failed note saves visible with retry; login reports exactly what succeeded; `<html lang>` matches active locale from first render.

**P2.6 — Readiness journey + post-approval routing (U1).** Derived readiness model (joined,
backup secured, intro submitted, processing, matches ready) computed from grants/backup
status/intro self-copy/match availability; render on EventHome; Join approved screen makes
"Record your intro" primary when no intro exists.
Files: new `packages/app/src/lib/events/readiness.svelte.ts`, `pages/EventHome.svelte`,
`pages/Join.svelte`, `lib/i18n/messages.ts`.
Conflicts: P9 (EventHome) + encryption-fixes (Join) — after both. Depends on P0.2 (backup status).
Size: M.
Acceptance: every event state shows one truthful next action; no premature backup/processing success claims.

**P2.7 — Home split: Your events vs Recently viewed (U6 UI part).** Organizer/attendee records
under "Your events"; capped dismissible visitor history; promote on grant arrival.
Files: `stores/recent-events.svelte.ts`, `pages/Home.svelte`, `pages/EventHome.svelte`.
Conflicts: P9 (EventHome). Depends on P0.2 scoping. Size: S-M.
Acceptance: opening a link never files an event under "Your events"; promotion on approval works.

**P2.8 — Recording flow + equivalent inputs (U5 + A1 input side).** Staged flow
(choose/preview/countdown/record/review), facingMode:user + camera switch + mic meter, file
fallback, and text/audio intro submission shapes processed equivalently by the coordinator.
Files: `pages/Record.svelte`, `lib/media/capture.ts`, `packages/protocol/src/schemas.ts`
(submission shape), `packages/coordinator/src/coordinator.ts` + `pipeline/` (text/audio handling).
Conflicts: P9 (schemas) + encryption-fixes (coordinator.ts). Size: L.
Acceptance: a user can submit without video; permission-denied paths have specific guidance; review survives upload failure.

**P2.9 — Roster search and filters (U8).** Diacritic-insensitive search over
name/bio/skills/summary; chips for want-to-meet/met/favorites/following/skills; state preserved
across detail navigation.
Files: `pages/Attendees.svelte`, `lib/i18n/messages.ts` (+ shared PersonCard if extracted).
Conflicts: none. Size: M.
Acceptance: a known person is findable by any indexed field at 200 attendees.

**P2.10 — NIP-51 mutes (U10 mute part).** Kind 10000 as sole block source (preserve unknown
tags/content); Mute/Unmute on attendee detail and DM header; filter roster/matches/DM lists;
honest cross-client copy.
Files: new `packages/app/src/lib/events/mutes.ts`, `pages/Attendee.svelte`,
`pages/Attendees.svelte`, `pages/Matches.svelte`, `pages/DmChat.svelte`/`Messages.svelte`.
Conflicts: none. Size: M.
Acceptance: standard kind 10000 round-trips with other clients; muted users filtered everywhere; no custom block event.

**P2.11 — Transcripts published and shown (A1 display part).** Transcript (+ language, source
revision) in the encrypted directory payload; "Show transcript" in MediaPlayer contexts;
machine-generated labeling; stale-on-media-change.
Files: `packages/coordinator/src/nostr/publisher.ts` + pipeline, `packages/protocol/src/schemas.ts`,
`packages/app/src/lib/components/MediaPlayer.svelte`, `pages/Attendee.svelte`.
Conflicts: P9 (schemas) + encryption-fixes (coordinator). Size: M-L.
Acceptance: every processed intro has a nonvisual consumption path; stale transcripts never shown for replaced media.

### Phase 3 — accessibility, navigation, admin

**P3.1 — Route titles, focus, skip link, announcements (A2).**
Files: `lib/router/routes.ts`, `routes/+layout.svelte`, `routes/+page.svelte`, `lib/i18n/messages.ts`.
Conflicts: none. Size: M.
Acceptance: one useful announcement per navigation; per-route localized titles; skip link first-focusable.

**P3.2 — History-backed router (A3).**
Files: `lib/router/router.svelte.ts` (verify Join.svelte secret-stripping still holds).
Conflicts: encryption-fixes (Join verification only). Size: M.
Acceptance: URL, rendered route, and browser history never diverge; deep-link Back goes to contextual parent, not Home loop.

**P3.3 — Field component + real labels (A5).**
Files: new `components/Field.svelte`, `pages/Admin.svelte`, `pages/DmChat.svelte`.
Conflicts: P9 (Admin). Size: M.
Acceptance: axe reports no unlabeled control on converted pages.

**P3.4 — Status semantics for dynamic state (A6).** Shared polite status region + toggle
semantics; sweep copy buttons, offline banner, saves, nav current-page.
Files: shared components + `components/BottomNav.svelte`, `pages/Settings.svelte`, others.
Conflicts: none major. Size: M.
Acceptance: each state change announced once; aria-current on active nav.

**P3.5 — Event-scoped navigation + icons (U3 + A7; owner confirmation first).** Event-context
nav variant (Overview/People/Matches/Updates), 48px targets, local SVG icons, aria-current;
global shell elsewhere.
Files: `components/BottomNav.svelte`, `routes/+layout.svelte`, `lib/router/routes.ts`,
new `components/icons/`.
Conflicts: none in-flight, but coordinate with P3.1/P3.2. Size: M-L.
Acceptance: event pages retain context; targets meet 48px; deep links and Back preserved.

**P3.6 — Admin as operations console (U4).** Reorder: status strip, Requests (when nonempty),
Communicate, People, Event setup, Health; keep existing actions/protocol behavior; two-column desktop.
Files: `pages/Admin.svelte` (+ extracted subcomponents).
Conflicts: P9 (Admin) — do after P9's Admin changes land. Size: M.
Acceptance: a pending request is visible without scrolling past setup/invite QR.

**P3.7 — Event metadata block (U7).** End time, explicit timezone, starts-in/happening/ended,
map link, ICS download, share.
Files: `lib/events/event-context.ts`, `pages/EventHome.svelte`, `lib/i18n/messages.ts`.
Conflicts: P9 (EventHome). Size: S-M.
Acceptance: when/where/status answerable at 320px with no overflow.

**P3.8 — Responsive rows + global markdown styles (A8 + A9).** `.action-row`/`.field-row` with
wrap; scoped `.markdown` ruleset (tables in labeled scrollers, pre scrollable, images capped,
overflow-wrap) applied at every markdown call site.
Files: `styles/app.css`, call-site sweep incl. `EventHome.svelte`, posts pages.
Conflicts: P9 (markdown.ts output classes + theme/posts pages) — after P9. Size: S-M.
Acceptance: scrollWidth <= clientWidth on all pages with adversarial fixtures at 320/360/412px.

**P3.9 — Join status states (U12).** Gift-wrapped join-status payload
(pending/approved/declined/expired + bounded reason); organizer decline (single/bulk) in Admin;
distinct Join.svelte states with truthful copy.
Files: `packages/protocol/src/schemas.ts`, `packages/coordinator/src/coordinator.ts`,
`pages/Join.svelte`, `pages/Admin.svelte`, `stores/join-sent.svelte.ts`.
Conflicts: P9 + encryption-fixes. Size: M-L.
Acceptance: a declined attendee sees a terminal state, not an eternal spinner; forged status rejected.

**P3.10 — Admission-mode semantics (U13; after owner answer).** Centralized typed decision
honoring `config.approval`; invite-only per owner's chosen semantics; identical outcome table
in coordinator, UI, and guides; atomic last-use invite redemption.
Files: `packages/coordinator/src/pipeline/entitlement.ts`, `coordinator.ts`,
`packages/protocol/src/config.ts`, `pages/Join.svelte`, guides.
Conflicts: encryption-fixes + P9. Size: M.
Acceptance: each mode's outcome table matches docs and UI copy exactly.

**P3.11 — Shared error component (Q3).** Typed categories, localized headline + one action,
collapsed technical details; convert non-conflicting pages first (Attendees, Matches, DmChat,
Attendee), then Join/EventHome/Admin after their streams land.
Files: new `components/ErrorState.svelte`, `lib/nostr/errors.ts`, page sweep.
Conflicts: P9 + encryption-fixes for the last three pages only. Size: M.
Acceptance: no raw Error.message rendered; every failure offers a safe next action.

### Phase 4 — infrastructure, docs, ongoing

**P4.1 — CI hardening (Q13).** Split unit/protocol/coordinator-integration/Playwright jobs;
make the pinned local walking skeleton required; land the P0/P1 security regression tests as
required checks; axe + viewport/zoom/overflow assertions in both locales.
Files: `.github/workflows/ci.yml`, `e2e/`, coordinator test setup.
Conflicts: none. Size: L (incremental — each P0/P1 step delivers its tests; this step wires them as required).
Acceptance: every critical finding's regression test runs on PRs against pinned local infra.

**P4.2 — Retire boundary `any` (Q15).** Typed job-payload map, SQLite row interfaces, provider
schemas (from P1.6), shared event/filter types; re-enable no-explicit-any with line-level exceptions.
Files: `eslint.config.js`, coordinator boundary modules.
Conflicts: encryption-fixes (db.ts) — after. Size: M, incremental.
Acceptance: boundary modules contain no unvalidated `any`; lint gate in CI.

**P4.3 — Talks config gate (U11 minimum; full journey pending owner answer).** `talks` mode in
31600 (off by default); hide talk record mode/routes when off; creation/admin toggle; docs.
Files: `packages/protocol/src/config.ts`, `pages/Record.svelte`, `lib/router/routes.ts`,
`pages/Admin.svelte`/creation UI, coordinator state.
Conflicts: P9 (protocol + Admin). Size: S-M for the gate.
Acceptance: talks-off events show no talk UI; enabling restores current behavior.

**P4.4 — Retention and lifecycle docs + temp-file hygiene (D3 docs part).** Retention matrix per
data class; coordinator temp-file deletion in `finally` + log rotation notes; shutdown/replacement
runbook (incl. `E_inbox` rotation).
Files: new `docs/RETENTION-AND-LIFECYCLE.md` (linked from README/docs index), coordinator
pipeline cleanup touch-ups.
Conflicts: minor encryption-fixes overlap on coordinator files. Size: M.
Acceptance: every data class has an owner, default duration, and honest deletion limits documented.

**P4.5 — Feature-status matrix (D4).** Status table (Shipped/Experimental/Protocol only/
Planned/Historical) with last-verified commit; historical banners on old test reports; wire into docs site build.
Files: new docs file + `docs/SPECIFICATION.md` cross-links, `scripts/build-docs.mjs`.
Conflicts: P9 (SPECIFICATION.md). Size: S-M.
Acceptance: a reader can answer "is X shipped?" for pages, themes, talks, matrices, chat, recovery without reconciling prose.

### Explicitly not scheduled (owner decisions)

- U2 meeting-plan redesign — owner: skip for now.
- H9 all-pairs scoring — owner adopted the benchmarked prefilter+batched pipeline; copy is fixed in P2.1 instead.
- D8 scoped admin roles / co-organizer removal — owner accepted full-custody irrevocable grants; deferred per spec §13. Warning copy only (P2.3).
- Forward secrecy / ECK back-rotation — accepted forward-only, documented.
- Members-only teasers — owner: none.
- Restricting organizer CSS to a fixed palette (Design direction) — owner accepted full custom per-event CSS with documented risk.
- Simple ECK web-only chat (roadmap phase 4) — dropped in the in-flight chat re-spec; chat direction is NIP-17 groups and/or Marmot per organizer choice (see GROUP-CHAT-FEASIBILITY.md).

### Owner questions

1. **Q5 protocol version:** schemas deliberately accept any positive `v` ("forward-tolerant").
   Lock to literal v1 with explicit envelope dispatch (audit's security argument), or keep tolerance?
2. **U13 invite-only:** should an uninvited/invalid-invite request be hard-rejected with clear
   copy, or stay in the manual queue (current behavior)? Docs and UI will follow whichever you pick.
3. **H10 opt-out:** add a per-participant "use my public Nostr history" opt-out to the
   submission payload (coordinator honors false), or is the event-level knob enough?
4. **U9 AI correction/dispute flow:** build subject-visible generated profiles with
   correct/report/hide actions (new protocol payload + coordinator + UI), or defer?
5. **U10 reports:** beyond NIP-51 mutes, do you want gift-wrapped report-to-organizer with an
   Admin moderation queue?
6. **U11 talks:** after the config gate (P4.3), do you want the full talks journey
   (discovery, playback, captions, revisions, moderation) scheduled now, or after Phase 0-2?
7. **D2 deployment manifest:** generate a dated provider/model/privacy manifest from
   coordinator.toml at deploy time (linked from disclosure UI), or just keep docs consistent by hand (P2.1)?
8. **D3 lifecycle features:** implement attendee export/delete requests and an organizer event
   shutdown flow, or document-only for now (P4.4)?
9. **Design direction:** invest in the constellation visual identity (icons, display type,
   event color wash) this cycle, or limit to the low-risk pieces (SVG icons, Avatar fallback,
   theme-color sync) inside Phase 3?
10. **U3 navigation:** confirm the event-scoped bottom-nav IA (Overview/People/Matches/Updates,
    global items behind an avatar menu) before P3.5 starts.
