# UI Suggestions

Improvements to make Nostrautica easier for its three audiences — the
**newcomer** who has never heard of Nostr, the **Nostr-native** user, and the
**organizer**. Grounded in the current screens (branch
`implement-nostrautica`, 2026-07-13). Testers running
[`E2E-TESTING-GUIDE.md`](E2E-TESTING-GUIDE.md): append what you observe,
dated, at the bottom — don't rewrite existing entries.

Principles applied throughout: the most common action comes first and is the
default; one primary action per screen; plain language over protocol
language; less text (people don't read at events, on phones, in a hurry);
works one-handed on a phone.

## For the newcomer (majority of attendees)

1. **Flip the emphasis on the Login and Join screens.** Both currently lead
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
