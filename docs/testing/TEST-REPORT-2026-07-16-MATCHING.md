# Test report — 10-user Tier-2 matching run (2026-07-16)

Full-stack test of the join → intro → AI matching loop with **1 organizer + 9
invented attendees** (full-text bios), run against the local infra (dockerized
strfry on `:7777`, blossom on `:3000`, app preview on `:4173`) and a **real
coordinator** (Venice: summary `qwen3-5-9b`, match `deepseek-v4-flash`,
embed `text-embedding-bge-m3`, translate `zai-org-glm-4.7-flash`). Driven by an
automated browser session (Playwright, one incognito context per user, 390×844).
The build under test includes the 0.2.0 perceived-latency work (predictive
prefetch + progressive multi-relay fetching, spec §16.3).

Screenshots from this run (light+dark) replaced the stale ones in
`docs/images/participant/` (01-home, 04-join-form, 06-approved, 08-attendees,
10-attendee-detail, 11-matches) and `docs/images/organizer/07-approved`.

## Cast

Event: **Cypherpunk Builders Meetup**, organizer **Olga Novák**, AI matchmaking
on, invite-code auto-approval via the coordinator.

| Attendee | Role in the mix | Looking for |
|---|---|---|
| Marek Dvořák | Rust/Nostr/Cashu protocol dev (2 relays + a mint in production) | Cashu/Fedimint interop collaborators, relay beta testers |
| Sofia Lindqvist | UX designer, privacy-first scheduling app, 30 user interviews | Technical (Rust/Swift) cofounder |
| Tomás Herrera | Lightning routing-node operator (Lisbon), merchant onboarding | Channel partners, merchants, LSP tooling |
| Amina Yusuf | Investigative journalist (de-banking, financial censorship) | Sources, devs who can explain tech plainly |
| Victor Palmieri | Angel/VC, open-source money & identity infra | Pre-seed teams, technical diligence advisors |
| Priya Chandrasekaran | Embedded/secure-element engineer, open hardware wallets | Firmware security auditor, Rust port help |
| Jonas Weber | Community organizer, hackathon circuit | Speakers, sponsors |
| Elena Rusu | Monetary economist/author, preparing a Lightning talk | Technical fact-checkers, podcast invites |
| Daniel Kowalski | Self-taught junior dev (ex-musician) | A mentor, a project to contribute to |

## What passed

- **Whole loop, all 10 users**: identity creation via the join form (name +
  full-text bio → kind-0), invite-code joins **auto-approved in < 3 s** each,
  text intros submitted from the Record page's text tab, AI profiles within
  ~10–30 s per attendee, full pairwise matching (9×8 directed pairs) done
  **~2.5 min** after the last intro with **no manual recompute**.
- **Match *scores* are genuinely good.** The designed complementary pairs all
  surfaced with sensible similarity/complementarity splits: economist↔node-
  operator (Elena→Tomás **0.95**, comp 1.00 — "you need someone who actually
  runs a Lightning node to fact-check your talk"), VC↔hardware-hacker
  (Victor→Priya 0.90), designer↔Rust-dev (Sofia→Marek 0.80), organizer↔builders
  (Marek→Jonas 0.85), mentor-seeker↔mentor (Marek→Daniel 0.85, sim 0.50 /
  comp 0.90). Same-role pairs are correctly demoted (Marek↔Tomás 0.25–0.30,
  "his focus is operations, not protocol development"). Scores are asymmetric
  per viewer, which is by design (the value of a meeting isn't symmetric).
- **Progressive rendering + prefetch (the 0.2.0 work) behaved**: the roster
  streams in as entries decrypt, profiles/avatars fill in after, matches paint
  before names enrich; no signer prompts fired from any background prefetch
  (all test users were local-key).

## Bugs found

> **Status update (same day):** B1 and B2 are **fixed and verified** — see
> "Fixes" at the end of this report. B3 remains open (minor).

### B1 (P1) — match *reasoning* sometimes describes the wrong person / wrong perspective

Roughly **2 of 8 cards per viewer** show reasoning that (a) calls the matched
person — or the viewer — **"Elena"** regardless of anyone's actual name, and/or
(b) is written **from the other side of the pair**: the viewer's own profile
appears in the third person while the matched person is addressed as "you".
Examples from this run:

- Sofia's card for Marek: *"You should grab Elena — she's building a
  privacy-first scheduling app … and you've shipped production relays"* — the
  scheduling app is **Sofia's own** profile (misnamed "Elena"); "you" is Marek.
- Tomás's card for Victor: *"You should grab Elena — she invests in open-source
  money infrastructure"* — Victor renamed and misgendered.
- Tomás's card for Priya: *"You should grab Tomás — he runs a Lightning node …
  a great sounding board for your hardware wallet's Lightning integration"* —
  Priya's reasoning shown on Tomás's list.

Two contributing causes, both in `packages/coordinator/src/matching/scoring.ts`:

1. **Prompt-example name leakage.** Both `BATCH_SYSTEM_PROMPT` (~line 148) and
   `REVERSE_BATCH_SYSTEM_PROMPT` (~line 327) contain the literal host-voice
   example `"You should grab Elena — …"`. `deepseek-v4-flash` copies the example
   name into real output. The prompt is benchmark-frozen (BP3, "do NOT
   paraphrase"), so the fix needs a benchmark pass: replace the example name
   with an instruction to use the actual person's name, re-run
   `docs/MATCHING-BENCHMARK.md`.
2. **Reverse-batch confusion.** The corrupted cards correlate with directed
   pairs written by the **reverse batch** (`scoreReverseBatch`: one shared
   person + K targets; runs whenever an earlier attendee's list needs the
   direction *existing→newcomer*). The forward BP3 shape was benchmarked; the
   reverse mirror was not, and the model visibly swaps who is "you" in a
   fraction of entries. Candidate fixes: name both people explicitly per target
   ("address TARGET N as 'you'; call the shared person by their name"), or
   benchmark the reverse shape properly.

The *scores* on the affected cards still look consistent with the pair, so the
defect is confined to the human-readable reasoning strings.

### B2 (P3) — `publish_matches` retries treat "replaced: have newer event" as failure

During the burst republish (every attendee's 31605 list republishing as new
directions land), strfry rejects re-publishes of an addressable event it already
holds newer with `replaced: have newer event`; the publisher counts that as a
failed relay and the job logs `publish_matches failed (retry n/5): All promises
were rejected`, retrying up to 5×. All lists were in fact readable on the relay
the whole time — the retry storm is wasted work and misleading log noise.
Treat a "replaced"/"duplicate" OK=false as success (the data is already there).

### B3 (P3) — coordinator-attach confirmation occasionally exceeds its UI wait

The admin "attach coordinator" confirmation once took > 20 s to reflect
(relay-timing); a second click succeeded. Worth a retry/timeout affordance in
the admin UI.

### Infra note (not the app)

The dockerized strfry was unreachable from the host because the image's default
config binds `127.0.0.1` **inside the container**; fixed in this repo by
mounting `docker/strfry.conf` with `bind = "0.0.0.0"` (docker-compose.yml).
This had silently broken the docker path of the e2e suite; the walking-skeleton
spec passes again. Pre-existing e2e baseline (unchanged by 0.2.0): video/audio
intro specs need the HTTPS Blossom proxy; join-approve-directory,
members-only-posts and talks=on fail identically on `main`.

## Fixes (same day)

**B1 — root cause was deeper than prompt wording: the LLM never saw anyone's
name.** `profileText` sent only summary/skills/interests/offers/seeks, so the
model *could not* name people and borrowed "Elena" from the prompt's host-voice
example; without name anchors, the "you" binding also drifted in the reverse
batch. Fix (coordinator):
- The join request's display name is now persisted (`attendees.display_name`,
  migrated in place) and threaded into both scoring calls — every profile block
  gains a `Name:` line (`scoreBatch` target+candidates, `scoreReverseBatch`
  shared+targets). Nameless pre-migration rows degrade gracefully (no line).
- Both prompts gained an additive bullet (BP3's benchmarked wording untouched)
  pinning the bindings: the target is always "you"; the other person is called
  by the `Name:` in their profile; example names are never attendees'.

Verified by a full `recompute` on the test event (names backfilled from
kind-0s): all inspected lists (Sofia, Tomás, Marek) now use correct names and
correct perspective — e.g. Sofia's Marek card reads *"Marek is a Rust developer
building Nostr and Cashu relay software — he's exactly the technical cofounder
you're seeking"*. Screenshots in `docs/images/participant/11-matches-*` are
from the fixed run. Unit tests: `scoring.test.ts` "name-aware reasoning (B1)".

**B2 — fixed**: `NostrClient.publish` now treats an OK=false whose reason
matches `duplicate`/`replaced` as success (the relay durably holds the event or
a newer version of the addressable coordinate). The same recompute burst that
previously logged 81 `publish_matches failed` retries logged **zero**.

**B3 — open** (admin attach-confirmation robustness; minor).
