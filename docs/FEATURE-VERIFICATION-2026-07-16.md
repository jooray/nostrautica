# Nostrautica — End-to-End Feature Verification & Gap Report (2026-07-16)

**Date:** 2026-07-16
**Scope:** F1 (text/audio intro alternatives), F3 (AI-profile dispute/hide), F2 (talks
journey), Marmot group chat, G2 (durable key backup/recovery), G4 (DM relay routing) —
verified against `main` at `a8daaa9` by (a) reading the relevant source in
`packages/app/src` and `packages/coordinator/src`, and (b) driving the real built PWA with
Playwright against local infrastructure: the in-memory strfry-equivalent relay and Blossom
stand-ins in `e2e/local-infra/`, plus a new `mock-coordinator-chat.mjs` harness that wires
the coordinator's **real** Marmot admin-bot code (not a stub) alongside the existing
mock LLM/STT.

This document is deliberately blunt, in the spirit of the prior pass. It found and
live-reproduced a **new P0 regression that is more severe than last round's G1**: the
manual (no-coordinator) approval path is completely non-functional end-to-end. That
finding, not any of the four features listed above, is the most important thing in this
report.

---

## 0. What changed operationally since 2026-07-15

- Docker was unavailable again; the `e2e/local-infra/` stand-ins were used, exactly as
  `E2E-TESTING-GUIDE.md §1.1` provides for.
- **G1 (last round's P0 — broken intro recording) is confirmed fixed.** `media.ts`'s
  `encryptMedia()` now uses a permissive draft schema pre-upload (`url` may be empty) and
  `media/submit.ts#uploadMedia()` only validates the strict https-only schema *after*
  real Blossom URLs are known (`packages/protocol/src/media.ts:29-48`,
  `packages/app/src/lib/media/submit.ts:53-94`). Verified live: video, audio, and text
  intros all uploaded and processed successfully this pass (see §1).
- The local Blossom stand-in (`e2e/local-infra/blossom.mjs`) is plain HTTP and always
  returned `http://localhost:3000/...` upload URLs, which fails the (correct) https-only
  media descriptor schema (audit C3) — nothing to do with the app. Fixed the **test
  harness** (not the product) to accept `BLOSSOM_PUBLIC_BASE_URL` so it can sit behind a
  local TLS proxy; documented in `docs/E2E-TESTING-GUIDE.md §1.1`. New:
  `e2e/local-infra/https-proxy.mjs`.
- New `e2e/local-infra/mock-coordinator-chat.mjs`: the same mock-provider pattern as
  `mock-coordinator.mjs`, but wires `chatMls` (the real Marmot admin-bot code) so the
  live chat round-trip could actually be attempted, per this task's "key live test."

---

## How to read the verdicts

- **VERIFIED-WORKING** — read in source *and* exercised live in the running app, with
  evidence (screenshot and/or coordinator log line and/or relay query).
- **PARTIAL** — the capability exists but is incomplete, unreachable end-to-end, or
  reproduces inconsistently.
- **BROKEN** — reproducibly fails in a way that defeats the feature's purpose.

---

## 1. F1 — Text/audio intro alternatives

**VERIFIED-WORKING.** `Record.svelte` is a real Video/Audio/Text tabbed composer, driven
live for all three modes against a coordinator-attached event:

- **Video** (default): fake-camera capture → encrypt → BUD-06 preflight → BUD-02 upload →
  submit. `Uploaded ✓`. Evidence: `docs/images/participant/09-record-*.png`,
  `09b-record-uploaded-*.png`.
- **Audio**: mic-only capture with a live level meter, same pipeline, mode-specific
  disclosure copy ("no coordinator/providers see video, only audio+transcript+profile").
  Evidence: `docs/images/participant/19-record-audio-*.png`.
- **Text**: skips capture entirely — a "Write your intro" composer, mode-specific
  disclosure copy explicitly stating *nothing is recorded, no audio leaves your device*
  (`record.disclosure.confirmText`). Evidence:
  `docs/images/participant/20-record-text-*.png`.
- **Transcripts**: the coordinator transcribed video and audio intros (STT mocked with a
  canned transcript per the harness) and published them on the directory entry; the
  media player's **Show transcript** toggle renders the text with a "Machine-generated
  transcript" label, verified on another attendee's view of a video intro. Evidence:
  `docs/images/participant/10-attendee-detail-*.png`,
  `docs/images/participant/21-transcript-*.png` (same capture — the transcript is
  expanded in both).
- **Matches populated end-to-end** (a first for this project, since last round's G1 blocked
  it): with 3 attendees who each submitted a real intro (video/audio/text), the coordinator
  scored and published match lists with plain-language reasoning
  (`docs/images/participant/11-matches-*.png`).

No gaps found in F1 itself.

## 2. F3 — AI-profile dispute/hide ("My event profile")

**VERIFIED-WORKING.** `#/e/<naddr>/profile` (`MyProfile.svelte`) shows the attendee their
own directory entry as others see it: an authored "You wrote" block (read-only, edit via
re-recording) and a "Generated from your intro" block with the coordinator's `ai_profile`.

- Per-field **edit** (a real textarea per field, only sent as an override if it differs
  from the generated value), per-field **Hide**, and **Hide the AI profile entirely**
  all work — tested editing the summary, hiding one field, and adding a free-text
  "report a problem" note. Save publishes a real kind-21608 Profile Correction; the
  coordinator log confirms `[correction] ... override applied for <pubkey>`.
  Evidence: `docs/images/participant/22-my-profile-*.png` (before),
  `23-my-profile-edited-*.png` (mid-edit), `24-my-profile-saved-*.png` (saved).
- The **"Edited by attendee" badge** (`attendee.aiEdited`,
  `packages/app/src/lib/pages/Attendee.svelte:208`) renders on another attendee's view of
  a corrected profile — witnessed live earlier in this pass (the attendee-detail page
  rendered `AI summary … Edited by attendee` immediately after the correction was saved
  and reprocessed). A later re-run of the same check, after this pass's local
  mock-coordinator process had gone silently unreachable for ~30 minutes (see §9, an
  artifact of testing infrastructure churn — restarting `e2e/local-infra/relay.mjs`
  severed the already-running mock coordinator's websocket with no observed
  reconnection), hit a **separate, unresolved oddity**: Ivan's attendee list briefly
  showed "No attendees visible" despite being Approved. This looked like a stale/mismatched
  ECK-version cache from the coordinator restart rather than a fresh regression — it did
  not reproduce with a freshly-approved attendee elsewhere in this pass — but it wasn't
  root-caused in the time available. Flagged as G-5 below; re-verify the badge with a
  clean single coordinator lifetime.

No functional gaps found in the correction mechanism itself.

## 3. F2 — Prerecorded talks journey

**BROKEN — the moderation/publish step does not exist anywhere in the app.** This is a
new P0.

- **Submit: VERIFIED-WORKING.** With `talks=on`, an approved attendee sees the **Talks**
  tab, taps **Submit a talk**, fills title/description, records/writes exactly like an
  intro, and the submission uploads successfully. The coordinator receives it and logs
  `[talk] "<title>" from <pubkey> (rev 0) → pending moderation`, then transcribes it in
  the background (`[talk] transcribed "<title>" for <pubkey>`) and folds it into the
  speaker's `ai_profile` for matching. Evidence:
  `docs/images/participant/27-talks-submit-*.png`; coordinator log lines above.
- **Publish/moderate: NOT BUILT.** `packages/coordinator/src/coordinator.ts:1188-1197`
  implements `talk_publish`/`talk_reject` admin commands that flip a talk from `pending`
  to `published` (or delete it) — but **grep across `packages/app/src` finds zero callers**
  of either command. `Admin.svelte`'s only talks-related UI is the on/off/prerecord-first
  select (`admin.talks.title`, ~line 1088) — there is no pending-talks queue, no per-talk
  Approve/Reject/Publish button, nothing. `events/talks.ts#fetchTalks()` only returns
  entries with `status === "published"` (line 66), so **no talk submitted this round, or
  presumably ever, can become visible to anyone**. Confirmed live: waited 4+ seconds after
  a successful submission and reloaded the Talks list — still "No talks yet."
  Evidence: `docs/images/participant/26-talks-empty-*.png` (before submit) — the *same*
  empty state persists after the submit-and-wait, so a second "after" screenshot would be
  visually identical; verified instead via the coordinator log
  (`→ pending moderation`, no `talk_publish` ever sent) and by reading
  `packages/app/src/lib/events/talks.ts` and `Admin.svelte` end to end.
- **Gating: VERIFIED-WORKING.** A `talks=off` event has no Talks tab in `EventNav`
  (confirmed: nav shows only Overview/Updates/More for a pending attendee, and
  Overview/People/Matches/Chat/Updates/More for an approved one — no Talks in either) and
  a direct link to `#/e/<naddr>/talks` shows "Talks aren't enabled for this event"
  with no Submit button. Evidence: `docs/images/participant/28-talks-off-event-*.png`,
  `28b-talks-disabled-*.png`.
- **Watch/resume/transcript:** could not be exercised — there is no path to a *published*
  talk to watch. `TalkDetail.svelte` (resume via `loadWatchProgress`/`saveWatchProgress`,
  transcript via `MediaPlayer`) was read and looks correct by construction (same
  `MediaPlayer` component already verified working for intros in §1), but this is
  **unverified live** because no talk can ever reach the state that page requires.

**See gap G-1.**

## 4. Marmot group chat

**PARTIAL — server-side works, client-side never converges.** This section is the
"key live test" the task asked for; here is exactly how far it got.

**Setup, toggles, gating: VERIFIED-WORKING.**
- **Create**: a "Group chat (Marmot)" checkbox, independent of the talks setting.
  Evidence: `docs/images/organizer/01-create-form-*.png` (form, unchecked) and the
  installed event's coordinator log line `matching=on, ... talks=on` alongside
  `[chat] created MLS group for <coordinate>` confirms the box was honored.
- **Admin**: a second, independently save-able toggle with its own "Save" flow
  (`ctx.config.chat`), disabled until a coordinator is attached. Evidence:
  `docs/images/organizer/11-chat-toggle-*.png`.
- **Nav gating**: the **Chat** tab appears in `EventNav` only when `chat=marmot` **and**
  a coordinator is attached **and** the viewer is a member — confirmed present for an
  approved attendee on the chat-enabled event and absent from the talks-off/no-chat event.
  Evidence: `docs/images/participant/29-chat-tab-visible-*.png`.
- **EventChat page**: renders the disclosure ("end-to-end encrypted... the event
  coordinator operates and can read it... each device sees only messages sent after it
  joined"), the experimental badge, and the Whitenoise hand-off card (chat key /
  QR hand-off for the standalone Marmot app). Evidence:
  `docs/images/participant/30-event-chat-setup-*.png`.

**Live MLS round-trip: PARTIAL, and this is the important part.**

Built a Node harness (`e2e/local-infra/mock-coordinator-chat.mjs`) running the coordinator's
**real** `chat/admin.ts` `MarmotAdmin` + `chat/mls.ts` MLS layer (not a stub), pointed at
the same in-memory relay as two real browser-driven `MarmotChat` clients
(`packages/app/src/lib/chat/client.ts`).

- **Attendee → coordinator direction: works.** A browser client's `ensurePublished()`
  publishes its kind-30443 key package plus 10050/10002 relay lists; the coordinator's
  live 30443 watcher receives it, authorizes it (checks the sender is an approved
  member), and performs a genuine MLS Add + Welcome
  (`chat/admin.ts:167`, `this.mls.invite(mlsGroupId, kp)`). Confirmed twice, for two
  independent identities, via the coordinator log:
  `[chat] added <pubkey> to <coordinate> from 30443 <event-id>`.
- **Coordinator → attendee direction: does not complete client-side.** After the
  coordinator's confirmed server-side add, `EventChat.svelte`'s `phase` never left
  `"setup"` (**"Setting up your secure chat… you'll join once the coordinator adds
  you."**) for either identity:
  - Identity A: reloaded the page 6 times over 40 seconds after the add — still "setup"
    every time (one intermediate reload transiently rendered something else, but the very
    next reload reverted to "setup," so that data point doesn't support "eventually
    ready either).
  - Identity B: watched continuously **without reloading** for 32 seconds after the
    add — still "setup" throughout, ruling out "a subscription-startup race that a reload
    would dodge" as the sole explanation.
  - No message could be sent (compose box stays disabled while `phase === "setup"`), so
    the 445 message round-trip and revoke-lockout — the rest of what this task asked to
    exercise — **could not be reached**.
- The likely mechanism (not fully root-caused — this is a plausible read of the code, not
  a confirmed diagnosis): `MarmotChat.start()`
  (`packages/app/src/lib/chat/client.ts:134-145`) calls `this.client.invites.listen(...)`
  then `joinPending()` → `decryptGiftWraps()` to find a welcome. Whether that listen call
  backfills recently-published gift-wraps or is live-only lives inside the vendored
  `marmot-ts` library (`packages/vendor`), which this pass did not have time to trace
  further. Given identity B's 32-second no-reload observation, a pure "subscribe slightly
  too late" race is not a sufficient explanation on its own — worth the owner's direct
  attention.

Evidence: `docs/images/participant/30-event-chat-setup-*.png`,
`30b-event-chat-after-wait-*.png`, `30c-event-chat-final-*.png`,
`30d-event-chat-ivan-noreload-*.png` (all show the same "Setting up" state at different
points in the wait). **See gap G-3.**

## 5. G2 — Durable key backup/recovery

**VERIFIED-WORKING**, and this is a genuine, well-evidenced fix of last round's G2 finding.

`Home.svelte` calls `recoverEventKeys(session.signer)` on load
(`packages/app/src/lib/events/recover.ts`), which reads back the organizer's self-encrypted
kind-30078 `nostrautica:eventkeys:*` backups (written at event creation,
`create.ts`) and restores them into the owner-scoped local keystore.

**Live test**: extracted the organizer's nsec (via the backup card's mailto-link href, no
UI change needed), wiped the browser profile entirely (a brand-new `launchPersistentContext`
directory — a genuinely fresh device, no cached IndexedDB/localStorage), logged in with only
that nsec, and navigated straight to `#/e/<naddr>/admin`:

- Reached the full **Organizer admin** screen — not a "not the organizer" error.
- Saw all 3 approved attendees with working **Re-process** / **Revoke** controls.
- This requires BOTH `E_id` and `E_inbox` custody to have been reconstructed from
  relay data alone — the hard part of G2.

Evidence: `docs/images/participant/33-key-recovery-fresh-device-*.png`.

No gaps found in this mechanism. (Attendee-side ECK recovery is a separate, already-working
mechanism via `receiveGrants()` grants — not exercised fresh this round, but unrelated to
G2's scope, which is specifically organizer custody.)

## 6. G4 — DM relay routing (kind-10050)

**VERIFIED via code only — not live-tested this round** (time-boxed; this was lower
priority than the four items above). `packages/app/src/lib/events/dm.ts` now resolves the
recipient's kind-10050 DM-relay list and unions it with sensible defaults before sending
(`dm.ts:38-60`, comment: *"published to that party's declared kind-10050 DM inboxes (union
defaults) so ... are reachable"*). This directly addresses last round's finding that the
10050 list was published but never consulted. Recommend a live two-party DM test with
distinct relay lists before fully closing this out — not done here.

---

# Prioritized gap report

### G-1. Talks: no organizer moderation UI exists at all (P0)
The entire point of the "submit → moderate → publish → watch" journey is broken at the
publish step: `Admin.svelte` has zero UI to review a pending talk or send `talk_publish`/
`talk_reject`, even though the coordinator fully implements both
(`packages/coordinator/src/coordinator.ts:1188-1197`). Every talk ever submitted sits in
`pending` forever; `Talks.svelte` will always show "No talks yet" regardless of how many
people submit. **Repro**: enable talks, submit one as an approved attendee, wait, reload
the Talks list as any attendee — still empty; coordinator log shows
`→ pending moderation` and nothing after. **Fix**: add a pending-talks section to Admin
(list + Publish/Reject per talk), wired to the existing admin-command channel exactly like
approve/revoke/reprocess already are.

### G-2. Manual (no-coordinator) approval is completely broken (P0 — the most severe finding this round)
This is a regression introduced by the C2 grant-authentication hardening
(`GPT56-AUDIT.md` C2, "implemented 2026-07-15") without a matching fix on the
grant-*issuing* side for events with no coordinator.

- `packages/app/src/lib/events/organizer.ts:201` — `approveAttendee()` seals the 21602
  key grant with `signerWrap(organizer, ...)`, where `organizer` is the **organizer's
  personal session signer** (`session.signer`, passed from `Admin.svelte`'s
  `approveAttendee(session.signer, ctx, req)`).
- `packages/app/src/lib/events/attendee.ts:95-111` — `authenticateKeyGrant()` (the C2 fix)
  only accepts a grant whose seal author (`rumor.pubkey`) equals the coordinate's `E_id`
  (`coord.pubkey`) or the event's currently-configured coordinator. The organizer's
  personal pubkey is **neither** of those — `E_id` is a separate per-event keypair, and
  there is no coordinator in this path by definition.
- Every no-coordinator grant is therefore rejected: `receiveGrants()` logs
  `[receiveGrants] ignored forged/invalid key grant (21602) for <coordinate>` on the
  attendee's own device, and the attendee is permanently stuck showing **"Pending"** /
  "Waiting for the organizer's approval" even though the organizer's admin screen
  correctly shows them Approved and the 31603 directory entry is genuinely on the relay
  (confirmed by querying the relay directly).
- **The same bug pattern hits two more paths that use the identical
  `signerWrap(organizer, ...)` construction**: co-organizer grants
  (`organizer.ts:334`, kind 21605) and — worse — **revocation's re-grant to remaining
  attendees** (`organizer.ts:533`), meaning a no-coordinator event's revoke flow silently
  fails to keep the *other* attendees' access working going forward (a new instance of the
  old H3 symptom, via a different root cause).
- **Repro** (100% reproducible, hit independently four separate times this pass —
  a from-scratch debug script, and three of the four new/existing Playwright specs:
  `walking-skeleton.spec.ts`, `join-approve-directory.spec.ts`,
  `members-only-posts.spec.ts`): create an event with no coordinator, join as an attendee,
  approve them as the organizer, then from the attendee's own session try to view the
  roster or a members-only post — it never appears, indefinitely (tested up to ~35s with a
  freshly-restarted, empty local relay to rule out unrelated slowness).
- **Impact**: this breaks Tier 1 — the primary, free, no-AI-cost mode that
  `docs/E2E-TESTING-GUIDE.md §1.2` explicitly says to test first — entirely. An organizer
  running an event without a coordinator cannot actually let anyone in.
- **Fix direction** (not implemented — for the owner): `approveAttendee()` already loads
  `keys.eidNsecHex` to sign the 31603 directory entry directly with `finalizeEvent(...,
  eidSk)`; the 21602 grant's seal needs the same E_id-based signing instead of the
  organizer's personal signer, and the co-organizer/revoke-regrant paths need the same fix.

### G-3. Marmot: welcome delivery/join never completes client-side (P1)
See §4. The coordinator's admin bot performs a real, confirmed MLS Add + Welcome, but
`EventChat.svelte` never leaves "Setting up your secure chat…" for either of two tested
identities, reload or no reload, for 30-40+ seconds. No message round-trip or
revoke-lockout could be exercised as a result. Needs the owner's attention to
`packages/app/src/lib/chat/client.ts:134-157` and the vendored `marmot-ts` invite-listen
behavior.

### G-4. Admin.svelte contains a raw NUL byte, making the file invisible to `git diff`/`grep` (low, tooling/review-quality)
`statusId()` (`packages/app/src/lib/pages/Admin.svelte`, in the poison-job status
section) builds a key with a **literal embedded NUL byte** inside a template literal —
`` `${s.a}\x00${s.stage}\x00${s.pubkey ?? ""}` `` written as a raw control character rather
than the escape sequence `"\0"`. This makes standard tools treat the entire 1150+-line file
as binary: `git show`/`git diff` render it as `Bin NNNNN -> MMMMM bytes` (no diff content
at all — confirmed via `git diff -a` to force text mode, which shows a perfectly normal
diff once forced), and a bare `grep` silently returns nothing for this file (also confirmed
— `grep -a` is required). This is genuinely dangerous for review quality on an
already-large, frequently-touched file: a reviewer looking at a real PR diff for
`Admin.svelte` sees nothing. Trivial fix: replace the raw byte with `"\0"`.

### G-5. My-profile "Edited by attendee" badge — re-verification inconclusive after infra churn (low, needs a clean re-check)
See §2. Witnessed working correctly earlier in this pass; a later re-check (after this
pass's own local mock-coordinator process had silently lost its relay connection for
~30 minutes — a testing-infrastructure artifact, not necessarily a product issue) hit an
unrelated "No attendees visible" state for an already-approved attendee. Didn't have time
to fully separate "stale test session" from "a real transient bug" — re-verify with a
single clean coordinator lifetime.

### G-6. Talks watch/resume/transcript — unverified live (carries over, blocked by G-1)
`TalkDetail.svelte`'s resume-progress and transcript rendering (reusing the already-verified
`MediaPlayer`) look correct by code inspection but could not be driven live because G-1
means no talk can ever reach the `published` state the page requires.

### G-7. G4 (DM relay routing) — verified via code only, not live end-to-end (low, time-boxed)
See §6. Recommend a live two-party test with distinct declared inboxes before considering
this fully closed.

---

## e2e specs added (deliverable C)

Four new Playwright specs under `e2e/tests/`, gated behind `NOSTRAUTICA_E2E_RELAY` like the
existing suite, all actually run against the live local infra this pass (not just
type-checked):

- **`intro-composer.spec.ts`** (3 tests, **all pass**) — the highest-priority spec per the
  task: drives the real record → encrypt → BUD-06 preflight → BUD-02 upload →
  descriptor-revalidation path for video, audio, and text modes against a live Blossom
  server. This is exactly the path that broke as G1 last round, and exactly the kind of
  test that would have caught it (a UI-only assertion would not have).
- **`talks-gating.spec.ts`** (2 tests, **all pass**) — talks=off has no Talks tab and the
  route refuses; talks=on exposes the tab and a talk can be submitted (does not assert
  publish, since G-1 makes that impossible right now — documented in the spec's own
  comment).
- **`members-only-posts.spec.ts`** (1 test, **currently fails** — blocked by G-2): asserts
  a members-only post is locked for an outsider and readable for an approved attendee.
  Fails on the attendee-side read because of G-2, not a bug in the spec; documented inline
  in the spec.
- **`join-approve-directory.spec.ts`** (1 test, **currently fails** — blocked by G-2):
  focuses on directory-entry *content* (not just roster presence, which
  `walking-skeleton.spec.ts` already covered) plus a revoke. Fails at the same "attendee
  never sees the approval" point as the pre-existing `walking-skeleton.spec.ts`, which
  **also now fails for the identical reason** — confirming G-2 is a real regression in
  already-covered functionality, not a fluke of a newly-written test.

`e2e/playwright.config.ts` was extended (mobile 390×844 viewport, camera/mic permissions +
fake-device flags, `ignoreHTTPSErrors` for the local https-Blossom stand-in) so the new
specs — and any future ones needing the record flow — work without per-test boilerplate.

**Final local run: 7 passed, 3 failed** (the 3 failures are exactly the G-2 regression,
across one pre-existing and two new specs) — `smoke.spec.ts` (2) and `intro-composer.spec.ts`
(3) and `talks-gating.spec.ts` (2) all green; `walking-skeleton.spec.ts`,
`members-only-posts.spec.ts`, `join-approve-directory.spec.ts` all fail identically.

---

## Test method & environment

- Built `@nostrautica/protocol`, `@nostrautica/coordinator`, and the static PWA
  (`@nostrautica/app`) against local infra (`ws://localhost:7777` relay,
  `https://localhost:8443` → local Blossom via a throwaway TLS proxy — see
  `docs/E2E-TESTING-GUIDE.md §1.1`).
- Docker was unavailable; used `e2e/local-infra/relay.mjs` + `blossom.mjs` +
  the new `mock-coordinator-chat.mjs` (wires the real Marmot admin-bot code, unlike the
  existing `mock-coordinator.mjs`).
- Driver: Playwright (Chromium), persistent per-persona browser profiles at 390×844
  (mobile), light + dark captured via `page.emulateMedia`, fake camera/mic device flags,
  `--ignore-certificate-errors` for the local https-Blossom proxy.
- Personas: an organizer and three attendees (video/audio/text intro submitters) on a
  chat+talks-enabled coordinator-attached event; a second talks-off/no-chat event; plus
  fresh single-purpose contexts for the G2 fresh-device test and the Marmot live test.
- All screenshots are freshly captured this pass at `docs/images/{organizer,participant}/`
  under the existing `NN-name-{light,dark}.png` convention, new entries numbered from
  `participant/19` and `organizer/11` onward.
