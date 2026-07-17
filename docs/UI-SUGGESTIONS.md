# UI Suggestions

Improvements to make Nostrautica easier for its three audiences — the
**newcomer** who has never heard of Nostr, the **Nostr-native** user, and the
**organizer**. Grounded in the current screens (branch
`implement-nostrautica`, 2026-07-13). Testers running
[`E2E-TESTING-GUIDE.md`](E2E-TESTING-GUIDE.md): append what you observe,
dated, at the bottom — don't rewrite existing entries.

**Implementation status (2026-07-14):** items 1–6, 8–22, 24 are
implemented on this branch (7 partially — friendly headline + muted detail,
no collapsible raw error yet; 16 now complete including coordinator
liveness; 20 now complete — see below). Still open: 23 (ongoing mobile
testing).

> **Update 2026-07-15 — the full UI redesign has since been delivered**, superseding the
> incremental fixes below with a ground-up scheme: an event-scoped bottom nav
> (Overview / People / Matches / Updates / More), an Overview readiness journey with a
> single next-action, confidence-first Matches ("Strong / Good match", reasoning-first,
> raw scores behind a disclosure), a People roster with search + filter chips + initial
> avatars, an operations-first Admin, a monochrome icon set (no calendar/clock), and a
> per-event colour wash + serif titles. Items 1–6 and 49-style suggestions here are now
> **realized in that redesign** rather than as spot edits. The redesign did **not** close
> two things this document cares about: raw-error rendering still exists on three pages
> (the shared `ErrorState` is used on five), and a real bug now blocks intro recording.
> New UI friction found during that pass is appended, dated, at the bottom of this file.

Principles applied throughout: the most common action comes first and is the
default; one primary action per screen; plain language over protocol
language; less text (people don't read at events, on phones, in a hurry);
works one-handed on a phone.

## For the newcomer (majority of attendees)

1. **Flip the emphasis on the Login and Join screens.** *(Revised 2026-07-14 by
   maintainer decision: Nostr users are first-class citizens — the "Already on
   Nostr? Sign in" button is now purple/primary and placed FIRST on both
   screens, with the newcomer form fully visible right below the divider. Both
   audiences get a zero-scroll path.)* Both currently lead
   with a large primary “I'm already a Nostr user” / “Already a Nostr user?
   Sign in” button, with identity creation below the fold of attention.
   Newcomers are the majority; make **Create my identity** (Login) and the
   join form itself the primary path, and demote existing-user sign-in to a
   quiet text link (“Already on Nostr? Sign in”). Nostr-natives will find it;
   newcomers won't be confused by it.
2. **Don't say “Nostr” before it means anything.** The create-identity card
   says “we'll set up a Nostr account for you. No password, no jargon” —
   naming the protocol *is* the jargon. Say “No email, no password — your
   account is created instantly” and keep the Nostr reveal for the Me page,
   where it's a delightful payoff (that page does this well, but is
   text-heavy — three paragraphs before the actionable card; cut to one).
3. **Event page badges leak config internals.** Attendees see raw
   `approval: manual+invite`, `matching: on` badges. Translate to human
   (“Invite or organizer approval” / “AI matchmaking”) — or show them only to
   the organizer.
4. **The post-approval dead end.** After “Request sent”, the page polls ~15 s
   (invite path) and then stops; the manual-approval path never updates on
   its own — an approved attendee only finds out by re-opening the event.
   Keep a live subscription and flip the screen to “You're in 🎉” whenever
   the grant arrives; consider a browser notification.
5. **Steer to the intro recording, state-awarely.** The single highest-value
   attendee action is recording an intro (no intro → no matches), but after
   approval the CTA is “See who's here”, and on the event page “Record /
   update your intro” is a secondary button below “People you should meet”.
   Make the event page's primary button depend on state: no intro yet →
   **Record your intro** (with a one-line “this is what gets you matches”);
   intro recorded → **People you should meet**.
6. **Join form friction.** Mark optional fields as optional; “Skills
   (comma-separated)” is developer phrasing — a chip/tag input, or at least
   “Skills — separate with commas”; add one motivating line (“used to pick
   who you should meet — be concrete”). The public/private distinction is
   marked with a lone “public” badge on the photo; a single line above the
   form (“Name, photo and bio are public; everything else stays inside the
   event”) is clearer than per-field badges.
7. **Friendly errors.** Raw exception text (`e.message`) renders directly in
   warn cards on Login/Join/Event pages. Wrap in plain language (“Couldn't
   reach the event — check your connection and retry”) with the technical
   detail collapsed underneath.
8. **Keep nagging (gently) about backup.** The backup card appears once;
   after “Continue” nothing reminds a local-key user. Show a dismissable
   “Back up your account — 30 seconds” banner on Home until the user confirms
   they saved the key (an “I saved it” tap is enough; no verification
   ceremony).

## For the Nostr-native user

9. **Remember the sign-in method.** After one NIP-07/NIP-46 login, boot
   restores the session — good — but a logged-out return visit re-offers all
   three methods equally. Pre-expand the last-used method.
10. **The read-only kind-0 treatment is right** (never mutate an existing
    profile). Add the missing affordance: “Edit your profile in your Nostr
    app — changes show up here.”
11. **Offer intro-video reuse at join time.** The library (“reuse previous
    video / fresh copy”) lives on the Record page; a returning attendee
    joining their second event won't discover it until they go to re-record.
    Offer it in the join flow (“Use the intro from <previous event>? [Reuse]
    [Record new]”) — it's the two-click reuse the spec promises.
12. **Paste-key field:** accepts nsec/ncryptsec/bunker — good. Add one line
    noting a remote signer or extension is safer than pasting an nsec on
    shared devices.

## For the organizer

13. **Defaults over decisions on the create form.** Pre-select the
    recommended combination (approval *invite + manual*, matching *on*, 90 s
    video) and collapse images + video length + matching under “Advanced”.
    Title + date should be enough to create an event.
14. **Post-create checklist.** After “event created”, show a 3-step
    checklist instead of two equal buttons: ① share the link / print invite
    QRs → ② attach a coordinator (optional, enables matchmaking +
    auto-approval) → ③ approve people as they ask. Track done/undone; makes
    the admin page self-explanatory on first visit.
15. **Admin ordering & bulk actions.** Pending requests first (already true)
    — then invite links (frequent), then setup (coordinator, co-organizers)
    last. With 50 invite-backed requests, per-row Approve is painful: add
    **Approve all** (or “approve all invite-backed”).
16. **The coordinator is the most confusing concept in the app.** The admin
    section asks for a bare `npub1… (coordinator)` with no explanation of
    what a coordinator is, where to get one, or what happens without one.
    Add two sentences (“A coordinator is a service that transcribes intros
    and computes matches. Without one: no matches, and invite links need
    manual approval.”) + a link to setup docs; after attach, show liveness
    (“last seen 2 min ago”), since a dead coordinator currently looks
    identical to a working one.
17. **Speak consequences, not cryptography.** Revoke confirms with “This
    rotates the event key (forward-only)”. Say what the organizer needs to
    know: “They lose access to everything new. What they already saw can't
    be taken back.”
18. **Don't dead-end the logged-out organizer.** Opening “Create an event”
    while logged out shows only “Log in first to create an event” + a Log in
    button — a detour before the user has typed anything. Inline the
    identity-creation step into the create flow (create the key on submit,
    like the join form does for attendees).
19. **Copy-link affordances.** The share link and invite URLs render as long
    mono strings with a small copy control; make the whole row tappable-to-
    copy with visible feedback, and offer “Share…” (Web Share API) on mobile.

## Cross-cutting

20. **i18n coverage is ~10%.** `messages.ts` holds ~20 keys, but most copy
    (Join, Admin, Me, BackupCard, SignInOptions…) is hardcoded English — a
    Slovak user gets a mixed-language UI. Move all user-facing strings into
    the catalog; the e2e language check (S1) will show the gaps.
    **Done (2026-07-14):** all user-facing copy across pages, components, and
    lib error/status messages is now in the typed catalog (~250 keys per
    locale) with full Slovak translations. `t()` gained `{name}` interpolation
    and `tp()` adds Slovak 3-form pluralization (1 / 2–4 / 5+). Switching to
    Slovenčina translates the entire app — verified by screenshot pass; the en
    e2e specs still pass unchanged. Evidence: `docs/images/app/settings-sk.png`.
21. **Empty/denied states should explain and direct.** Outsider on the
    attendee list gets a bare “no attendees visible”; say why and what to do
    (“The attendee list is encrypted for approved attendees. Join the event
    to see who's here.”). Empty matches: “Matches appear after you record an
    intro and the event's AI has processed a few attendees.”
22. **Native controls don't follow the theme.** Add `color-scheme:
    light`/`dark` per theme so `datetime-local` pickers, checkboxes and
    scrollbars match (they currently render light-mode chrome inside the
    dark UI). *(Addressed in the CSS refresh below.)*
23. **Mobile specifics to keep testing:** long mono strings (naddr,
    nostrconnect URIs) must truncate, never widen the page; QR codes must fit
    a 360 px viewport; tap targets ≥ 44 px; the bottom nav must not cover the
    last card (shell padding exists — verify per page); recording UI in
    portrait.
24. **PWA install hint.** Auto-update exists, but nothing suggests installing.
    A one-time, dismissable “Add this to your home screen for the event”
    hint on the event page is worth it — attendees will open it dozens of
    times during an event.

## Visual design

The current look is functional but flat and noisy at the same time: every
element is a 1 px-bordered box on a near-black canvas, all buttons are
full-width gray slabs, the OR divider shouts in uppercase, headings barely
differ from body text, and light mode is an afterthought of the same
borders on white. Direction — keep the purple, remove the boxes:

- **Elevation instead of outlines.** Cards separate from the background by
  surface color (dark) and soft shadow (light), not by drawing a border
  around everything. Hairlines only where structure needs them (topbar,
  inputs).
- **A real type scale.** Larger, tighter h1 (~1.75 rem, -0.03 em), roomier
  line-height for body, `text-wrap: balance` on headings; `.muted` reserved
  for genuinely secondary text.
- **Button hierarchy.** One solid purple primary per screen; secondary
  buttons become quiet (transparent, hairline); danger stays outlined until
  confirmed. Comfortable 44 px minimum height, subtle hover/active
  transitions, visible `:focus-visible` rings.
- **Purple as a system, not a single hex.** Per-theme accent (slightly
  deeper on white for contrast, slightly lighter on dark for legibility) +
  a translucent `--accent-soft` tint for badges, selected states, and the
  “you organize” chip — this is what makes the app feel designed rather
  than themed.
- **Quieter chrome.** Lowercase hairline “or” divider, smaller pill badges,
  softer radius (14 px), consistent 4 px-grid spacing.
- **Readability guarantee.** Both themes verified for contrast: body text
  ≥ 12:1, secondary text ≥ 4.5:1, white-on-purple primary buttons ≥ 4.5:1
  (light) / ≥ 4.3:1 bold (dark); `color-scheme` set so native widgets never
  render dark-on-dark.

**Status: implemented in `packages/app/src/lib/styles/app.css`** (this
branch) — token values and component styles only; no class names or markup
changed. Screens to eyeball after any further change: Login (both themes),
Admin (densest screen), Join on a phone viewport.

Beyond CSS (future, needs markup): avatar fallbacks with initials instead of
empty circles, a subtle page-level fade on route change, match-percentage
shown as a small ring rather than a bare number, and the event banner
gradient echoed as a soft header wash on event pages.

---

## Observations from e2e runs

<!-- Testers: append dated findings here. -->

### 2026-07-13 — screenshot & docs pass (5 personas, Tier 1 + mock coordinator)

Driven headless via Playwright against the local relay/blossom (`e2e/local-infra`)
and a mock coordinator. Personas: Olga (organizer, desktop), Nina (newcomer,
phone), Ivan (invited, phone), Nadia (existing Nostr user, desktop), Otto
(outsider, desktop).

**Blocker found (see `testing/TEST-REPORT-2026-07-13.md` BUG-1).** Approved
attendees never receive their event-key grant, so the whole *inside-the-event*
experience (roster, recording, matches, DMs) can't be reached by an attendee.
The grant wrap reaches the browser over the wire (verified: 1 kind-1059 EVENT
frame delivered) but the app's `receiveGrants` `fetchEvents(...closeOnEose)`
resolves without it — an NDK browser cache/subscription race. This is the single
highest-impact thing to fix; everything downstream of approval depends on it. A
live `subscribe()` for grants (instead of a one-shot `fetchEvents`), or
`cacheUsage: ONLY_RELAY` on that read, is the likely fix.

**UX friction observed (smaller):**

1. **Approval has no discoverable "you're in" moment for the attendee.** Even
   setting the grant bug aside, the design leans entirely on the attendee
   re-opening/polling the event page. When approval *does* land, there's no
   push/notification; the join page's silent poll is the only signal. Consider a
   clearer "refresh to check" affordance or a persistent "we'll let you know"
   banner with a manual check button.

2. **`06-pending` (admin) puts the invite-code QR block above the actual
   pending-requests list.** When several requests are in, the organizer has to
   scroll past a big QR card to reach "Approve all". Consider ordering: pending
   requests first, invite generation below.

3. **Revoke uses a native `confirm()`.** It's unstyleable, can't be
   screenshotted for docs, and looks out of place against the app's own cards.
   Replace with an in-page confirm (a small inline card with Cancel / Revoke),
   which also lets you show the consequence copy in the app's voice.

4. **`07-signin-options` on the Join page sits *below* the whole join form.** A
   Nostr-native arriving at a join link scrolls past the entire newcomer form
   (photo, name, skills…) before finding "Already on Nostr? Sign in". For the
   join screen specifically, consider surfacing the sign-in entry nearer the top
   for people who clearly already have an identity.

5. **Photo upload silently no-ops if the Blossom server is unreachable.** In
   testing, the strict CSP blocked the local http Blossom and the picker just did
   nothing (the create-identity path swallows the upload error). A tiny inline
   "couldn't upload your photo — you can add it later" would beat silence.

6. **Event page member CTAs are a good implicit "you're in" state.** When an
   attendee is approved, the event page shows "See who's here / People you should
   meet / Record your intro". That reads clearly as membership and is a fine
   surrogate for a dedicated approved screen — worth leaning into.

**Things that worked well:** the create-event → success-checklist → admin flow
is clean; invite codes with per-code QR are excellent; the **Event updates**
composer + its render on the public event page (bold/list/link Markdown) is a
genuinely nice feature and looks polished in both themes; the outsider privacy
state ("No attendees visible… encrypted for approved attendees") is exactly
right; every phone-viewport screen (412×915) held up with no horizontal scroll,
reachable bottom nav, and truncated naddr/npub.

**Update (same day):** the grant blocker is fixed and verified — the full
5-persona loop now runs end-to-end (auto-approval → roster → intros → matches →
DMs) and all remaining screenshots were captured. Two fixes were needed: the
app's relay-only gift-wrap reads (`fetchEventsRelayOnly`) and a NIP-01
per-filter-`limit` fix in the local test relay. One follow-up remains
(TEST-REPORT-2026-07-13, BUG-1b): gift-wrap reads should pass an explicit relay
set — without one, NDK's outbox relay-set calculation can make the fetch hang
indefinitely when relay lists are unresolvable. The invite-link "You're in 🎉"
moment, the 86%-match cards with per-person reasoning, and the cross-messenger
DM thread all photograph beautifully — the product story lands.

### 2026-07-14 — UX-fixes pass (items 5, 11, 16, 24 + revoke confirm) — resolved

All driven end-to-end against the local stack (relay :7777, blossom :3000,
preview :4173) with a scripted Playwright run (23 assertions; 22 passed in the
full run, the one flake — first revoke click after approve on a loaded 2-core
host — was re-verified instantly in an isolated repro and in the screenshot
run).

- **#5 state-aware record CTA** — implemented. EventHome's primary for an
  approved attendee is **Record your intro** (+ a "Matches come from intros"
  nudge) until the 31602 self-copy carries an intro; then primary reverts to
  **People you should meet** with record demoted. Verified both states across
  reloads.
- **#11 join-time video reuse** — implemented, the real thing (not the
  deep-link fallback). A signed-in user with a library intro gets a "Use your
  previous intro?" card in the join form (Reuse / Fresh copy / I'll record a
  new one) wired to the same `prepareReuse` Record.svelte uses. The prepared
  descriptor rides the join request's own 21601 + 31602 (`sendJoinRequest`
  gained a `media` field — a second racing submission would lose same-second
  latest-wins ties, found during verification). The library stores descriptors
  without a source-event label, so the card says "your previous intro" rather
  than naming the source event. Verified: organizer sees "🎥 1 video" on the
  request; the attendee's event-2 self-copy carries the intro (matches becomes
  primary without re-recording).
- **#16 coordinator liveness** — completed. Admin shows a last-seen badge next
  to "Attached:" derived from the newest coordinator-authored event for this
  event (31603/31604/31605/31606 by `#a`, roster-`#d` fallback): "active just
  now" / "active N min ago" / "last seen N h/d ago" / "no activity yet", with
  a warning tint + "looks stale — is it still running?" beyond 1 h. Pure read,
  no protocol change.
- **#24 PWA install hint** — implemented. One-time dismissable card on the
  event page for approved attendees; `beforeinstallprompt` is captured at boot
  (Chrome/Android → native prompt on tap), iOS Safari gets share-sheet
  instructions; dismissal persists in localStorage; never rendered in
  standalone display-mode.
- **e2e observation #3 (native `confirm()` on revoke)** — resolved. Revoke now
  swaps the attendee card to an inline confirmation ("They lose access to
  everything new. What they already saw can't be taken back." [Revoke] [Keep])
  — theme-consistent and screenshotable. Figures re-captured:
  `images/organizer/08-revoke-{light,dark}.png` and
  `images/participant/05-request-sent-{light,dark}.png` (the waiting state now
  persists across reloads and offers a quiet "Send the request again").

---

## Observations from the 2026-07-15 redesign verification pass

Appended (not rewritten) per this file's convention. Grounded in a live mobile-viewport
run of the redesigned build.

- **[blocker] Intro recording fails before upload.** Record → review → *Use this* throws
  "must be an https URL" and nothing is submitted (verification gap G1). Since the whole
  product hinges on intros, this is the first thing to fix; it also means the redesign's
  "Intro submitted / Processing / Matches ready" readiness steps can never advance in the
  current tree.
- **[medium] The post-approval wait is still the softest spot in onboarding.** After the
  organizer approves, the attendee's Overview keeps showing "Pending / Waiting for the
  organizer's approval" until grants propagate over the relay — seconds to tens of
  seconds — with only a passive "refresh in a moment" hint on the People screen. The
  readiness journey improves the framing but doesn't give an active "you're in now"
  moment. Consider a live grant subscription that flips the Overview and (optionally) a
  local notification, as suggested in item #4 above — still relevant post-redesign.
- **[low] Three screens bypass the shared `ErrorState`.** `Join`, `EventHome`, and
  `Admin` still render a raw `card warn` error box; folding them into `ErrorState` would
  finish audit Q3.
- **[low] Organizer theme CSS is applied unsanitized.** The kind-31609 editor is powerful
  and correctly blocks HTML/script (it sets `textContent`), but arbitrary CSS can still,
  e.g., `@import` or scrape via attribute selectors. A one-line caution in the editor UI
  ("only paste CSS you trust / wrote") would set expectations.
- **[positive] The redesign reads well on a 390 px phone in both themes.** Event colour
  wash + serif title give each event a distinct identity without a custom theme; the
  readiness journey and the confidence-first empty states are legible and reassuring; the
  members-only post lock badge on Overview communicates the gate cleanly. No horizontal
  scroll observed on the captured screens.
