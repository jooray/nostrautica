# Product

<!-- impeccable:product-schema 1 -->

Scope: the Nostrautica PWA (`packages/app`) — the only surface with a UI. The
coordinator is a headless daemon and `protocol` is a library; both appear here
only where they constrain what the app can show.

## Platform

web

## Users

**Primary: an attendee in the days before the event**, at home on a laptop or a
phone on the couch — recording their intro, watching pre-recorded talks, and
reading *why* the app thinks they should meet someone. This is the moment the
design optimizes for: there is time, attention, and a willingness to read.
Depth beats glanceability when the two conflict.

Secondary: the same attendee at the venue (phone in hand, noisy room, patchy
wifi) and the organizer (setup, approvals, chasing missing intros, monitoring).
Both must work; neither sets the bar.

Audience: **any event**. The crowd today is privacy/cypherpunk-leaning (Plan B
and its kin), but the design must never presuppose Nostr or crypto fluency —
ownership of your identity is available to whoever wants it and invisible to
everyone else. Jargon in the interface is a defect, not a signal of belonging.

## Product Purpose

Conferences are good at putting interesting people in one room and bad at
helping them find each other. Nostrautica treats networking as the main event:
each attendee records a short intro (and optionally a talk), an AI coordinator
transcribes and enriches it with their existing public Nostr content, and then
tells every attendee **who to meet and why** — in plain language, not a score.

Success is an attendee who arrives already knowing who to seek out, and an
event where the conversations that should have happened did.

## Positioning

Two things a neighbouring event app could not truthfully copy without building
the same machinery:

- **Complementarity, not just similarity.** Pairs are scored on how well two
  people would *complement* each other (a cryptographer, a programmer and a
  designer; a drummer, a bassist and a singer), not only on shared interests.
- **Reasoning as the deliverable.** Every match carries a written explanation
  and conversation starters. The score is supporting evidence; the paragraph is
  the product. A UI that hides the reasoning has thrown away the differentiator.

Supporting: the event format itself is rearranged around this — talks are
watched ahead of time (`talks: "prerecord-first"`), freeing the room for the
conversations the matches point at. And the profile is portable to the next
event.

## Operating Context

- **Journey:** join (approval or invite) → record a short intro → optionally
  record a talk → watch others' talks → read matches → follow / mark
  want-to-meet / message → meet at the venue.
- **Event-scoped shell.** Everything below an event lives under one bottom nav:
  Overview · (Talks) · People · Matches · Chat · Updates · More. Tabs are gated
  by role and event config, so a tab never dead-ends at "join first". With both
  Matches and Chat visible the bar is full and Updates collapses into More.
- **Per-event configuration drives the shell** (`packages/protocol/src/config.ts`):
  `matching` on/off, `matchVisibility` pair|event, `approval`
  manual|invite|manual+invite, `talks` off|on|prerecord-first, `chat` [marmot],
  `nostrContext` (N public notes summarized per attendee), `lang`, media length
  caps. The same screens must read well across these combinations.
- **Three languages ship in the UI**: `en`, `sk`, `cs` (`LOCALES` in
  `src/lib/i18n/messages.ts`), plus an event language that also steers the AI's
  output. Slovak strings run noticeably longer than English — layouts are
  judged in Slovak, not in English.
- **Cache-first, offline-capable.** Every relay read paints from IndexedDB and
  revalidates in the background, so screens must be designed to paint with
  stale-but-real data rather than a spinner.

## Capabilities and Constraints

- **Static PWA.** No application API server exists: the app talks only to Nostr
  relays and Blossom media servers. Anything the UI shows must be derivable from
  relay events plus local cache.
- **Privacy tiers are structural** (spec §4.1): public (Nostr profile), event-
  encrypted under the Event Content Key (intro videos, directory, roster),
  pair-encrypted (match lists, when `matchVisibility: "pair"`), user-private
  (want-to-meet list, notes). The UI must never show data across a tier it does
  not belong to, and "share this" features are constrained by which key the
  viewer holds.
- **Matching is optional and coordinator-provided.** An event with no
  coordinator has People but no Matches. Matches arrive asynchronously and keep
  recalculating as people join — a screen showing them must tolerate arriving,
  changing, and absent data.
- **Self-updating is mandatory** (`src/lib/pwa.ts`): a new version is detected
  and refreshed without the user hard-reloading. Nobody is stuck on a stale
  build mid-event.
- **Dark and light themes** are both first-class (`data-theme` on `<html>`,
  system-following by default).
- **Undecided / not shipped:** pay-with-Bitcoin ticketing is a roadmap idea in
  the pitch, not a feature — do not design as if it exists.
- **Event size is no longer capped at a few hundred.** The roster used to be one
  NIP-44 payload, which ran out somewhere around 240-480 approved members; it now
  paginates (PROTOCOL-NIP.md §6.2.1) up to `MAX_ROSTER` (2000). Design the member
  list for thousands, not hundreds — and note that a community (31612) is a
  standing group that only ever grows, so it reaches those numbers by sitting
  still.

## Brand Commitments

- Name: **Nostrautica**. Logos in `brand/` (dark and light, SVG + PNG at 256 /
  512 / 1024).
- Voice, taken from the shipped copy and docs: plain, concrete, unhyped.
  Explains mechanisms rather than promising outcomes. Names the trade-off
  instead of hiding it. No growth-marketing register, no crypto triumphalism.
- Live at `nostrautica.cypherpunk.today` (app at `/app`, docs at `/docs`).

## Evidence on Hand

Real, and usable:

- **A real event's data** — Plan B, 44 named attendees with AI profiles, match
  reasonings and icebreakers. It is **member-only and ECK-encrypted**
  (`approval: "manual+invite"`, `matchVisibility: "pair"`). Local extracts live
  in gitignored `benchmarks/matching/private/`. It may be used to make mock-ups
  honest; it must never be published, pasted into a hosted artifact, or sent to
  a third-party service.
- **Measured content shape** (real coordinator output, 108 people / 1026
  reasonings, measured 2026-09-13) — the numbers any list or card design has to
  physically accommodate: match reasoning median **168** chars (p25 149, p90
  213, max **276**) ≈ 4 lines at 390px and 7 worst case; **86%** of reasonings
  open with the person's first name, 92% within four words, written in second
  person to the reader; icebreakers **3 per match** × median **104** chars
  (~312 chars ≈ 8 lines) — 3× the reasoning; strong matches per person median
  **3** (p90 4, max 5), good median 3 (p90 4, max 8); profile summary median
  **193** chars; and **13 of 108 people — 12% — have no strong match at all**,
  so every matches surface needs a designed answer for that person.

- `docs/MATCHING-BENCHMARK.md`, `docs/MODEL-BAKEOFF.md` — real measured
  benchmark results.
- Guides for organizers and participants in en/sk/cs; `docs/SPECIFICATION.md`
  is normative; `docs/THREAT-MODEL.md` states what leaks and why it is accepted.

Absent — do not fabricate: testimonials, customer logos, press quotes, user
counts, pricing, uptime or performance claims beyond the measured ones above.

## Product Principles

1. **The reasoning is the product.** A match reduced to a score or a badge is
   the thing every other event app already does. If a layout can only fit one
   of {score, explanation}, it fits the explanation.
2. **Design for the couch, not the corridor.** The decisive moment is before
   the event, where there is time to read. Don't amputate depth for a
   glanceability the primary user isn't asking for — but don't make the venue
   moment unusable either.
3. **No fluency required.** Nothing in the interface may assume the user knows
   what a relay, a key, or a nsec is. Ownership is there for those who look.
4. **Show what you're allowed to show.** Privacy tiers are a design input, not
   a backend detail; a screen is wrong if it needs a key its viewer won't have.
5. **Real data, real length.** Judge every layout against the measured content
   above, in Slovak, with the empty and one-item cases drawn — not against
   plausible-looking filler.

## Accessibility & Inclusion

**WCAG 2.2 AA is the floor**, stated so future work cannot quietly drift below
what the code already does: `aria-current="page"` on nav, a non-colour
`::before` active marker (forced-colors safe), `aria-hidden` on decorative
icons, visually-hidden live text for badge counts, 48px minimum tap targets,
safe-area padding, and `prefers-reduced-motion` honoured in every component
that animates. Both themes must meet contrast, not just the dark one.
