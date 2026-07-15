# Nostrautica — End-to-End Feature Verification & Gap Report

**Date:** 2026-07-15
**Scope:** the P9 event-customization feature set, the 7-phase UI redesign, and the
`GPT56-AUDIT.md` follow-up items — verified against the **working tree** (not `HEAD`)
by (a) a full read of the relevant source under `packages/app/src` and
`packages/coordinator/src`, and (b) a live browser run of the built PWA driven with
Playwright against local infrastructure (in-memory strfry relay + Blossom + the mock
coordinator in `e2e/local-infra/`).

This document is deliberately blunt. The owner asked "what's lacking compared to what
we've talked about," so PARTIAL and NOT-BUILT items are called out with the same
prominence as what works.

---

## 0. Two facts that frame everything below

1. **Almost nothing here is committed.** `git status --porcelain` shows ~150
   modified/untracked files against `HEAD = a5b8a08`. Essentially all of P9, the
   redesign, and Phase 0/1 of the audit's implementation plan live **only in the
   uncommitted working tree**. Per `CLAUDE.md`, only a push to `main` triggers the
   deploy hook, so **none of this is in production yet.** A consequence: several
   `GPT56-AUDIT.md` "STATUS 2026-07-15: confirmed, to implement" lines are now
   **stale** — the code for U8, U10, H10, A2, A6, Q3, H1, H3, H4, H5, C3, and the
   poison-job UI exists in the tree even though those status lines imply it doesn't.
   Commit-and-review is itself the highest-priority action: this work is one
   `rm -rf` from gone.

2. **Live screenshots succeeded.** The redesigned UI was captured on a real mobile
   viewport (390 px) in both light and dark themes and the images under
   `docs/images/` were refreshed from this run. One flow could **not** be exercised
   because it is genuinely broken (see [G1](#g1-recording-an-intro-is-broken-p0) —
   intro recording throws before upload), so the screens that depend on processed
   intros (populated Matches, AI summaries on a person's page) are shown in their
   honest empty / pre-processing states, as noted per-screen below.

---

## How to read the verdicts

- **VERIFIED-WORKING** — read in source *and* exercised in the running app (or, for
  coordinator-only paths, read in source and confirmed via coordinator logs).
- **PARTIAL** — the capability exists but is incomplete or not reachable end-to-end.
- **NOT-BUILT** — absent by design/deferral, or written but not wired up.

---

## 1. Onboarding — create identity, join, approval

**VERIFIED-WORKING.** Live: created an in-app identity (`Login.svelte`), created an
event (`Create.svelte`), and joined it from three separate attendee browser contexts
(`Join.svelte`), each landing on the "Request sent / waiting for the organizer" state.
The organizer's Admin shows pending requests immediately (operations-first, see §7) and
**Approve** / **Approve all (N)** move them to the approved section; the coordinator
log confirms the round-trip `[approve] organizer approved … → [grant] ECK granted;
directory + roster published`.

- Evidence: `docs/images/organizer/06-pending-*.png`, `07-approved-*.png`,
  `docs/images/participant/04-join-form-*.png`, `05-request-sent-*.png`.
- Gap: grant propagation over the network is asynchronous; an approved attendee's app
  only flips to "in" after `receiveGrants` polls and the coordinator has published the
  roster. On slow relays this takes seconds-to-tens-of-seconds and the only signal is a
  passive "refresh in a moment" message. Not broken, but the post-approval wait is the
  weakest link in the newcomer flow (audit U1 anticipated this; readiness journey
  softens it but does not eliminate it).

## 2. Invite entitlement (free)

**VERIFIED-WORKING (free codes only).** `organizer.ts` generates single-use invite
links (a fresh nsec per code carried in the URL fragment); `entitlement.ts` redeems
them; auto-approval fires only when a coordinator is attached and running. No server,
no price.

- Evidence: `docs/images/organizer/04-invites-*.png`; `entitlement.ts:32-52`,
  `organizer.ts:383-441`.
- Gap: this is the *only* ticketing that exists — see §11 for paid ticketing.

## 3. Intro recording + pre-submit disclosure

**PARTIAL — disclosure works, submission is broken.**

- The pre-submit disclosure (audit **H10**) is **VERIFIED-WORKING**: `Record.svelte`
  renders an unchecked acknowledgement that names the coordinator and the configured
  processing providers and states the match model may run on a non-private tier; it
  disables every submit path until ticked. Evidence: `docs/images/participant/09-record-*.png`,
  `Record.svelte:171-214`, `messages.ts:720-728`.
- **The recording → upload path itself throws before any upload** and no intro can be
  submitted. This is a real, reproducible P0 — see [G1](#g1-recording-an-intro-is-broken-p0).
  Because of it, no attendee profile is ever produced, which cascades into empty
  Matches and no AI summaries.

## 4. Matches (confidence-first)

**VERIFIED-WORKING as UI; NOT populatable in this environment (blocked by G1).**
`Matches.svelte` + `events/confidence.ts` implement the confidence bands
(strong ≥ 0.80 / good ≥ 0.60 / else "say hello"), reasoning-first hero content, a route
glyph, and raw dimension scores tucked behind a `<details>` disclosure — exactly the
redesign spec. The empty state ("No matches yet — they appear once the coordinator has
processed a few attendees") renders correctly.

- Evidence: `docs/images/participant/11-matches-*.png` (honest empty state),
  `events/confidence.ts`, `ConfidenceBadge.svelte`, `Matches.svelte:122-148`.
- Gap: a **populated** confidence-card screenshot could not be produced because G1
  blocks intro submission, so the coordinator never gets media to score. The card
  layout itself is verified by source + unit tests; only the live populated capture is
  missing, and that is a downstream symptom of G1, not a Matches defect.

## 5. Event customization (P9)

All four sub-capabilities are **VERIFIED-WORKING** in source and, where reachable,
in the live app:

- **Members-only encrypted posts (kind 31607)** — `crypto.ts:50-66` encrypts with
  NIP-44 v2 keyed on the 32-byte Event Content Key; `posts.ts` publishes and gates
  reads (`locked:true` when the reader has no ECK). Live: a members-only post renders as
  a lock + join prompt to a non-member and appears in the "Latest" strip on Overview.
  Evidence: `docs/images/participant/02-event-overview-*.png` (lock badge visible),
  `docs/images/participant/12-posts-feed-*.png`, `PostCard.svelte:30-38`.
- **Event-page menu + layout (kind 31608)** — organizer editor in `Admin.svelte`,
  attendee render in `EventHome.svelte` (`fetchEventPage`, section/menu resolution).
- **Per-event theme CSS (kind 31609)** — organizer CSS editor with live preview
  (`Admin.svelte` + `theme-injector.ts`); applied via `textContent` on a
  `<style data-event-theme>` element (blocks HTML/script injection; raw CSS is
  intentionally unrestrained — a documented, owner-accepted risk, not a gap).
  Evidence: `docs/images/organizer/10-theme-editor-*.png`.
- **Long-form markdown editor + public/members visibility toggle** — `PostEditor.svelte`;
  `publishPost` genuinely branches on visibility (`publishMembersPost` → encrypted 31607
  vs. `publishEventUpdate` → public 30023), not cosmetic. Markdown reuses the escape-first
  `markdown.ts` (HTML-escape before transform, `https?://`-only links). Post-aware link
  picker and feed filtering (source × visibility) both present and working.
  Evidence: `docs/images/organizer/09-posts-editor-*.png`.

- **Gap (authoring surface):** the post composer is wired **only inside `Admin.svelte`**
  — i.e. organizers/co-organizers. There is no compose UI anywhere an ordinary attendee
  can reach (`Posts.svelte` is feed-only). Attendee-authored members-only posts are
  **NOT-BUILT** (see §13), consistent with the task's "deferred" list — but note it's
  absent by *omission of any UI*, not by an explicit role gate.

## 6. Mutes (NIP-51)

**VERIFIED-WORKING.** `events/mutes.ts` publishes and reads a real **kind-10000** mute
list with NIP-44-encrypted private `p` tags. Mute/unmute actions live on a person's page
and in DM threads, each behind a confirm step; muted pubkeys are filtered out of the
roster, Matches, and the DM inbox.

- Evidence: `Attendee.svelte:212-224`, `DmChat.svelte:119-127`, filtering at
  `Attendees.svelte:110`, `Matches.svelte:56`, `Dm.svelte:22`;
  `docs/images/participant/18-mute-confirm-*.png` (mute confirmation).

## 7. Redesign screens

All nine redesign moves are **VERIFIED-WORKING** in the running app:

| Redesign move | Verdict | Evidence |
|---|---|---|
| Event-scoped bottom nav (Overview/People/Matches/Updates/More) | VERIFIED | `EventNav.svelte`, `+layout.svelte:138-142`; all refreshed event screenshots show it |
| Overview readiness journey + single next-action | VERIFIED | `docs/images/participant/02-event-overview-*.png`; `ReadinessJourney.svelte`, `events/readiness.ts` (13 tests) |
| Matches confidence-first | VERIFIED (empty state captured) | `docs/images/participant/11-matches-*.png`; `events/confidence.ts` |
| People roster: search + filter chips + PersonCard + initial avatars | VERIFIED | `docs/images/participant/08-attendees-*.png`, `08b-attendees-search-*.png`; `Attendees.svelte:162-185`, `PersonCard.svelte` |
| Admin operations-first | PARTIAL (reorder done, extraction not) | `docs/images/organizer/03-admin-empty-*.png`; see §8 |
| Monochrome icon set, no calendar/clock | VERIFIED | `components/icons/Icon.svelte` + `paths.ts` (18 SVGs); grep found zero calendar/clock/emoji in UI |
| Initial-based avatars used generally | VERIFIED | `Avatar.svelte` used across 7+ components |
| Event colour wash + serif titles | VERIFIED | serif title + accent wash visible in every event-header screenshot; `app.css`, `theme-injector.ts` (wash sits *under* 31609) |
| Theme-color meta sync | VERIFIED | `theme.svelte.ts:39-45,58-65` (init, toggle, live OS change) |

## 8. Admin operations-first (detail)

**PARTIAL.** The **reordering** genuinely shipped: pending join requests now render
immediately after the top bar, above the Communicate and Event-setup sections — the
audit's original U4 complaint (requests buried under invite QR / setup) is fixed, and a
pending-count status strip + bulk approve exist. **But** the redesign plan's fuller work
did not land:

- `Admin.svelte` is **still one 1064-line monolith** — the planned extraction into
  `lib/pages/admin/{Operations,Communicate,People,Setup}.svelte` never happened
  (no `lib/pages/admin/` directory exists).
- The planned distinct **"Health"** section never materialized: `messages.ts` has an
  `admin.section.health` string but it is unreferenced; coordinator health is folded
  into "Event setup" instead of split out.

## 9. Accessibility (A2/A6)

**VERIFIED-WORKING.** Per-route `document.title` + focus move to `<main>` + a skip-link
to `#main-content` (`+layout.svelte:52-69,107`). Status semantics are real, not
decorative: `aria-current` on both nav bars, `aria-pressed` on toggle chips/buttons,
`role="status"`/`aria-live="polite"` on the roster count, record state, and a route-change
announcer, and `role="alert"` on the shared error component.

- Gap: the **shared ErrorState** (audit Q3) is used on 5 pages but three still render a
  raw `<div class="card warn">{error}</div>` (`Join.svelte:294`, `EventHome.svelte:170`,
  `Admin.svelte:591`). Minor, cosmetic-consistency only.

## 10. DMs and DM-relay list (kind 10050)

**PARTIAL.** 1:1 DMs work (NIP-17 kind-14 gift-wrapped), the inbox lists threads, and
mutes filter it. **However, the kind-10050 DM-relay list is published but never read on
the send path** — `dm.ts`'s `sendDm` has no relay-list lookup and falls back to the
default connected relays. So the 10050 plumbing exists but does **not** currently route
DMs to a recipient's declared inboxes (the stated purpose). Evidence:
`nostr-actions.ts:60-70` (publish) vs. `dm.ts:30-45` (send path, no lookup).

## 11. Ticketing

- **Invite-only entitlement (free): VERIFIED-WORKING** — see §2.
- **Paid Cashu ticketing: NOT-BUILT** — confirmed absent. There is no payment/lightning/
  invoice/price code anywhere in the frontend. (The coordinator's `providers/cashu.ts`
  is exclusively for paying *AI providers* — Venice/Routstr — and is unrelated to
  attendee ticketing; do not conflate the two.) This matches the "designed but unbuilt"
  status.

## 12. Group chat

**NOT-BUILT (spec-only, by design).** Only the kind-10050 DM-relay plumbing shipped
(and even that is unused on the send path, §10). No group kind, no MLS/Marmot/NIP-29
code, no group UI. Consistent with `GROUP-CHAT-FEASIBILITY.md` and spec §7.5 ("planned").

## 13. Other explicitly-deferred items (confirmed absent)

- **Attendee-authored members-only posts** — NOT-BUILT (composer is organizer-only, §5).
- **Nostree mirror** — NOT-BUILT (docs mention it; zero code; `IMPLEMENTATION_PLAN.md:249`
  explicitly excludes it from v1).
- **Playwright e2e for P9 / redesign** — NOT-BUILT. `e2e/tests/` has only `smoke.spec.ts`
  and `walking-skeleton.spec.ts`; zero coverage of 31607/31608/31609, posts, themes,
  event-scoped nav, readiness, confidence bands, PersonCard, or the admin reorder.
- **Admin child-component extraction** — NOT-BUILT (§8).
- **Durable owner-scoped key backup / fresh-device recovery (C1/H2)** — see G2 below.

## 14. Coordinator robustness (audit Phase 0/1)

All **VERIFIED-WORKING in source** (and the happy paths were exercised via the mock
coordinator's logs), contradicting the stale "to implement" status lines in the audit:

- Job leases (`claimed_at`/`lease_until`/`worker_token`, atomic claim, startup sweep of
  expired-running jobs) — `store/db.ts`, H1.
- Revocation republishes match lists + matrix under the rotated ECK — `coordinator.ts`
  `revokeAttendee`, H3.
- `matching=off` is read into event state and gated at pipeline entry and publish — H4.
- Live kind-31600 config subscription with replaceable-event ordering — H5.
- SSRF/ffmpeg hardening: `net/safe-fetch.ts` (private-IP/loopback/redirect/timeout/byte
  caps, https-only, origin allowlist) + `pipeline/audio.ts` (ffmpeg in its own process
  group, wall-clock kill, output/duration caps) — C3.
- Poison-job surfacing: coordinator gift-wraps a kind-21606 status; `Admin.svelte`
  renders a real poison card with stage/attempts/error-category/retry/dismiss.
  (Observed live: `process_attendee POISONED … surfaced … to organizer`.)

---

# Prioritized gap report — what's lacking vs. what we discussed

### G1. Recording an intro is broken (P0)
`encryptMedia` (`packages/protocol/src/media.ts:35`) inserts a literal `"about:blank"`
placeholder URL when it encrypts a blob *before* upload (`urls: []` from
`media/submit.ts`), then immediately validates the descriptor against the **newly
https-only** schema (`schemas.ts` `httpsUrl`, added by the working-tree C3 hardening),
which throws `"must be an https URL"`. **Every intro submission fails before any upload
happens** — reproduced live for two separate attendees. This is a working-tree
regression: `schemas.ts` is modified in the tree; `media.ts` (committed) was never
reconciled with it. Because no intro is ever stored, there are **no profiles → no
matches → no AI summaries** — it silently guts the product's core value. Fix: let the
encrypt step emit a schema-valid placeholder (or defer descriptor validation until
after upload fills real URLs). **Fix this first.**

### G2. Durable key recovery does not actually work (high)
The self-encrypted kind-30078 "eventkeys" backup is **written** (correctly owner-scoped
via `blindedD`) but **nothing ever reads it back** — grep across `packages/app/src`
finds zero readers. The local keystore (`keystore.ts`) is keyed by `coordinate` only,
**not** `[ownerPubkey, coordinate]`, so two identities on one device collide. Net: a
fresh device (or a cleared browser) **cannot recover event custody**, and the readiness
step "Backup secured" is a self-reported nsec-copy nag, not evidence of a working relay
backup. This is the audit's C1/H2, still open.

### G3. Nothing is committed (high — process risk)
~150 modified/untracked files, `HEAD` unchanged. All of P9 + the redesign + Phase 0/1
audit fixes exist only in the working tree and are not deployed. Commit + review + run
the test suite before this is lost or before further edits collide. (Also: refresh the
stale "confirmed, to implement" STATUS lines in `GPT56-AUDIT.md` — most are done.)

### G4. kind-10050 DM-relay list is unused plumbing (medium)
Published but never consulted on the DM send path (§10). DMs currently rely on default
relays reaching the recipient; the declared-inbox routing the 10050 list is meant to
provide isn't wired.

### G5. Admin refactor only half-done (medium)
Operations-first **reorder** shipped, but `Admin.svelte` is still a 1064-line monolith
(no `admin/` subcomponents) and the planned distinct "Health" section doesn't exist
(§8). Functional, but the maintainability goal of the redesign plan is unmet.

### G6. Attendee-authored members-only posts — not built (low / as-designed)
Composing is organizer-only by omission of any attendee-facing composer (§5). On the
deferred list, flagged here for completeness.

### G7. No automated coverage for any of the new surface (medium, longer-term)
No Playwright specs for P9 or the redesign (§13). Given G1 slipped through despite unit
tests (they pass real URLs; the runtime path passes `[]`), an e2e that drives
record→submit against a Blossom would have caught it.

### G8. Cosmetic consistency (low)
Three pages still render raw error text instead of the shared `ErrorState` (§9); the
theme CSS editor applies organizer CSS unsanitized (accepted risk, but worth a documented
warning in the organizer UI).

---

## Test method & environment

- **Built** `@nostrautica/protocol`, `@nostrautica/coordinator`, and the static PWA
  (`@nostrautica/app`) pointed at local relays.
- **Infra:** in-memory strfry-equivalent relay (`e2e/local-infra/relay.mjs`) on
  `ws://localhost:7777`; a Blossom server; the mock coordinator
  (`e2e/local-infra/mock-coordinator.mjs`, MockStt/MockLlm) attached by npub in Admin.
  Docker was unavailable in this environment, so the in-memory stand-ins from
  `E2E-TESTING-GUIDE.md §1.1` were used, exactly as that guide provides for.
- **Driver:** the repo's Playwright (Chromium), mobile viewport 390 px, both themes,
  five personas (organizer + three attendees + outsider) in isolated browser contexts.
- **Note on Blossom + https:** because the working-tree schema now requires https media
  URLs (C3), a local https Blossom was used for the upload attempts; the record flow
  still failed at the client-side encrypt step (G1), before Blossom was ever contacted —
  confirming G1 is independent of the local setup.
