# Nostrautica — End-to-End Testing Guide (Multi-Participant)

This guide drives a **full browser-based test of Nostrautica with several
simultaneous participants**, and produces three artifacts:

1. A filled-in **test report** (pass/fail per scenario, bugs found).
2. **[`ORGANIZER-GUIDE.md`](ORGANIZER-GUIDE.md)** — completed with real screenshots.
3. **[`PARTICIPANT-GUIDE.md`](PARTICIPANT-GUIDE.md)** — completed with real screenshots.

Observations about awkward UX go into a local `docs/internal/UI-SUGGESTIONS.md`
(gitignored — not published; append, don't rewrite others' findings).

> **Resilience note for the tester (human or model).** This guide describes
> *intent*, not pixels. Button labels, exact copy, and layout will drift.
> If a step says “click *Create my identity*” and the button now says
> “Get started”, that's the same step — follow the UI, note the difference,
> and **update the user guides to match what you actually saw**. Only report a
> failure when the *capability* is missing or broken, not when wording moved.

---

## 1. Test environment

### 1.1 The orchestrator owns the stack

Do **not** hand-start the relay, Blossom, TLS proxy, and preview server — that is
exactly how the old quick-start ended up telling you to bind port 3000 twice (the
docker Blossom AND `blossom.mjs`). One command per tier brings up exactly the
infrastructure that tier needs, health-probes it, runs the specs, and tears
everything down with no orphans (`e2e/orchestrator.mjs`, audit §13.7):

```sh
# From the repo root:
pnpm e2e:smoke         # preview only — the static PWA loads, no relay/blossom
pnpm e2e:integration   # + relay (nak or in-repo) + Blossom + HTTPS proxy
pnpm e2e:chat          # + a coordinator with the real Marmot admin bot (a double)
pnpm e2e:full          # everything, all specs
```

The orchestrator builds the app itself (relay tiers get
`VITE_NOSTRAUTICA_RELAYS`/`VITE_NOSTRAUTICA_BLOSSOM` pointed at the local stack),
so you never manage that by hand. Pass extra Playwright args after `--`:

```sh
pnpm e2e:integration -- tests/integration/walking-skeleton.spec.ts --headed
```

Knobs (env): `E2E_SKIP_BUILD=1` reuses an existing build (must already point at
the local stack); `E2E_RELAY_IMPL=local|nak` forces the relay implementation
(default: `nak` if on PATH — CLAUDE.md gotcha #3 — else the in-repo relay).

**A selected tier FAILS its setup loudly if its infrastructure can't start** —
it never silently skips (audit D-11). The exit code is non-zero on any setup or
test failure, so CI/scripts can gate on it. Ports: preview `4173`, relay `7777`,
Blossom `3000`, HTTPS proxy `8443` — each bound by exactly ONE process (the
orchestrator reuses an already-healthy instance instead of double-binding).

To drive the app manually (headed, for the guide's screenshot scenarios), run a
tier headed against a spec you can watch, e.g.
`pnpm e2e:integration -- tests/integration/walking-skeleton.spec.ts --headed`.
For a free-form manual session, start the pieces from `e2e/local-infra/` by hand
(relay, blossom + https-proxy) and a preview with `PUBLIC_CSP_EXTRA_CONNECT` set,
then open `http://127.0.0.1:4173` — but the orchestrator is the supported path.

### 1.1.1 Gotcha: HTTPS Blossom (why the proxy exists)

The media descriptor schema accepts only `https://` blob URLs (audit C3 — SSRF
hardening). `e2e/local-infra/blossom.mjs` is plain HTTP, so **recording an
intro/talk and submitting it fails** ("must be an https URL") unless its upload
responses are https. The orchestrator fronts Blossom (`:3000`) with a
self-signed TLS proxy (`:8443`) and sets `BLOSSOM_PUBLIC_BASE_URL` to the proxy
origin — it generates the throwaway cert under `/tmp/nostrautica-tls` if absent.
`http://localhost:3000` is useful only for text-only diagnostics; its media URLs
are rejected. Chromium accepts the self-signed cert via `--ignore-certificate-errors`
+ `ignoreHTTPSErrors: true`, already wired into `e2e/playwright.config.ts`.

### 1.1.2 Gotcha: CSP is set at RUN time, not just build time

`vite preview` re-renders the CSP shell (`%sveltekit.env.PUBLIC_CSP_EXTRA_CONNECT%`)
per request, so the value must be on the RUNNING preview process, not only the
build. Preview is owned by Playwright's `webServer` (`e2e/playwright.config.ts`),
whose command sets `PUBLIC_CSP_EXTRA_CONNECT` at run time — a single preview
owner, so it is never double-bound whether launched by a tier or a bare
`playwright test`. Without the run-time CSP, every local ws/http connection is
blocked with only "Relay not connected." to show for it.

### 1.2 Two test tiers

| Tier | Orchestrator tier | Infrastructure | What is testable |
|---|---|---|---|
| **Tier 1 — no coordinator** | `e2e:integration` | relay + Blossom | identity, sign-in, event creation, invites, join, **manual approval**, roster/directory, record & playback, favorites/notes, follows, settings, i18n, theme, outsider privacy |
| **Tier 2 — with coordinator** | `e2e:chat` / `e2e:full` | + coordinator double | Marmot group chat, and (with a real coordinator + `VENICE_API_KEY`, ffmpeg) invite-code **auto-approval**, AI summaries, the **matches** screen, "Recompute all matches" |

The `chat`/`full` tiers start a coordinator DOUBLE (`mock-coordinator-chat.mjs` /
`mock-coordinator.mjs`) that uses `MockStt`/`MockLlm` — no API money. For a
Tier-2 pass against the REAL coordinator (real STT/LLM, costs money and minutes),
build and run `@nostrautica/coordinator` per `docs/COORDINATOR-OPERATOR-GUIDE.md`,
point its relays at `ws://127.0.0.1:7777`, and attach its **npub** in Admin.

### 1.3 Fake camera (required for the record flow)

Headless Chromium can supply a synthetic camera/mic so the intro-video flow
works without hardware and without permission prompts:

```
--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream
```

(optionally `--use-file-for-fake-video-capture=<file>.y4m` for a recognizable
clip). In Playwright also grant `permissions: ["camera", "microphone"]` on the
context.

---

## 2. Recommended test infrastructure

**One isolated browser session per persona.** Nostrautica keeps identity in
IndexedDB/localStorage per origin, so *session isolation = separate browser
context or profile directory*. Never share a profile between personas.

### Option A — Claude-driven interactive testing (recommended for this guide)

Run one **Playwright MCP server per persona**, each headless with its own
profile dir; desktop personas get a desktop viewport, attendee personas get a
phone viewport (§2.1). Example registration:

```sh
claude mcp add organizer  -- npx @playwright/mcp@latest --browser chromium --headless \
    --user-data-dir /tmp/nostrautica-e2e/organizer
claude mcp add attendee-nina -- npx @playwright/mcp@latest --browser chromium --headless \
    --user-data-dir /tmp/nostrautica-e2e/nina --device "Pixel 7"
claude mcp add attendee-ivan -- npx @playwright/mcp@latest --browser chromium --headless \
    --user-data-dir /tmp/nostrautica-e2e/ivan --device "Pixel 7"
claude mcp add nostr-nadia -- npx @playwright/mcp@latest --browser chromium --headless \
    --user-data-dir /tmp/nostrautica-e2e/nadia
claude mcp add outsider-otto -- npx @playwright/mcp@latest --browser chromium --headless \
    --user-data-dir /tmp/nostrautica-e2e/otto
```

Pass the fake-camera flags through to Chromium for the personas that record
video. The model then drives each persona by name (navigate, click, fill,
`browser_take_screenshot` → save into `docs/images/…`), which is exactly the
mixed “test + observe + document” mode this guide needs. Persistent
`--user-data-dir` also lets you *stop and resume* a session (identity
survives), which mirrors real attendee behavior across days.

An equivalent alternative is a small Node driver script using Playwright's
API with named `browser.newContext()` per persona — same isolation, useful if
MCP is unavailable.

### Option B — scripted regression (the tiers)

`e2e/tests/` holds the Playwright suite organized by tier: `tests/smoke/`
(preview-only) and `tests/integration/` (multi-`BrowserContext` create → join →
approve → roster/directory/record loops) — the right home for anything from this
guide worth keeping as an automated regression. Run a tier via the orchestrator
(§1.1), e.g. `pnpm e2e:integration`. The orchestrator sets `NOSTRAUTICA_E2E_RELAY`
for you once the relay is confirmed up, so the integration specs RUN rather than
self-skip; running `playwright test` directly (without the orchestrator) leaves
that env unset and the relay-dependent specs skip — always go through a tier.

### 2.1 Mobile viewports are part of the test matrix

The primary device at a real event is a phone. Run **attendee personas on a
phone-sized viewport** (Playwright device `"Pixel 7"` ≈ 412×915, or iPhone
14) and the organizer on desktop. For the scripted suite, add a second
project:

```ts
projects: [
  { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  { name: "mobile",  use: { ...devices["Pixel 7"] } },
],
```

At minimum, verify on mobile: no horizontal scrolling anywhere, bottom nav
reachable and not overlapping content, join form usable, video recording UI
fits portrait, long `naddr`/`npub` strings truncate instead of overflowing,
QR codes fit the screen, tap targets are comfortably tappable. File anything
off into `docs/internal/UI-SUGGESTIONS.md` with a screenshot.

### 2.2 Simulating the sign-in methods

- **Paste key (nsec)** — fully testable headless. Seed a complete “existing
  Nostr user” persona with `nak` (github.com/fiatjaf/nak; verified with
  v0.15.2) against the local relay, then paste the nsec into the app:

  ```sh
  R=ws://localhost:7777
  SK=$(nak key generate)
  echo $SK | nak encode nsec        # ← paste this into "Paste a key"
  nak key public $SK                # pubkey, for other personas' follow lists
  nak event -k 0 --sec $SK -c '{"name":"Nadia","about":"…","picture":"https://api.dicebear.com/9.x/avataaars/png?seed=Nadia"}' $R
  nak event -k 3 --sec $SK -p <followed-pubkey-hex> $R   # non-empty follows
  ```

  (An https picture URL keeps the shipped `img-src` CSP happy.)
- **NIP-07 extension** — no real extension in headless Chromium. Either skip
  (note as untested), or inject a `window.nostr` shim via an init script that
  signs with a fixed test key; then the “Log in with extension” button appears
  and can be exercised.
- **NIP-46 remote signer, `bunker://` paste** — fully testable headless with
  `nak bunker` as an **auto-signing** daemon (no phone needed):

  ```sh
  nak bunker --sec <hex-or-nsec> ws://localhost:7777
  # prints: bunker://<pubkey>?relay=…&secret=XXXX
  ```

  Paste the printed URI into the app's “Paste a key” field → **Connect
  bunker**. The `secret` in the URI auto-authorizes the connecting client and
  every subsequent request (`sign_event`, `nip44_encrypt`/`decrypt`) is
  answered without any prompt. ⚠ nak rotates the secret after each successful
  connect — each printed URI is single-use, so copy the *latest* printed URI
  per client (or pre-authorize a known client key with `-k
  <client-pubkey-hex>`). This exercises the full remote-sign surface: join
  gift-wraps, grant unwrapping, roster decrypt, follows, NIP-17 DMs — measured
  results are logged locally under `docs/internal/testing/`.
- **NIP-46 `nostrconnect://` QR flow** — `nak bunker connect <uri>` is a stub
  in nak ≤ 0.15.2 (“this is not implemented yet”), so nak cannot consume the
  app's QR. Verify the option renders a QR + copyable URI + waiting state; to
  drive the handshake itself use a phone with Amber, or a small scripted
  signer (nostr-tools: subscribe kind-24133 for your pubkey, publish the URI's
  `secret` as the first response, then serve
  `get_public_key`/`sign_event`/`nip44_*`).

---

## 3. Personas

| Persona | Who they are | Viewport | Identity |
|---|---|---|---|
| **Olga** | Organizer. Comfortable with tech, new to Nostrautica. Creates the event, manages approvals. | Desktop | New — created in-app |
| **Nina** | Newcomer attendee. Knows nothing about Nostr; got a link from a friend. Joins **without** an invite code → manual approval. | Phone | New — created during join |
| **Ivan** | Invited attendee. New user arriving via an **invite-code link** → auto-approval (Tier 2) or manual (Tier 1). | Phone | New — created during join |
| **Nadia** | Nostr-native attendee. Has an existing identity (pre-made nsec with a kind-0 profile: name, bio, picture) and existing follows. | Desktop | Existing — pasted key |
| **Otto** | Outsider. Has an identity but is **not** approved into the event. Used for privacy checks. | Desktop | New — created in-app |

Seed Nadia before the run: create a keypair, publish a kind-0 profile (name
“Nadia”, a bio, a picture) and a kind-3 follow list that includes Nina's
pubkey (captured after Nina joins, or pre-generate Nina's key too) — this is
what makes the “following” social-overlay badges testable.

---

## 4. Test scenarios

Run in order — later scenarios depend on earlier state. 📸 marks a required
screenshot; names refer to the checklist in §5.

### S1 — First contact & app chrome (any fresh persona)

1. Open the app root. Expect the home/landing screen with the value
   proposition and a way to get started. 📸 `participant/01-home`
2. Open Settings: switch theme Light↔Dark (persists across reload), switch
   language to Slovenčina and back (UI re-translates; note untranslated
   strings for `docs/internal/UI-SUGGESTIONS.md`). 📸 `app/settings`
3. Confirm the PWA manifest and service worker are served (installable app).
4. Deep-link to a nonsense event URL (`#/e/naddr1invalid`) — the app shell
   must render an error state, not a blank page or server 404.

### S2 — Olga: create identity & event

1. Olga logs in via “create identity” (name + optional photo). Expect a
   success state with a **key backup card** (copy secret key; more options
   like email link / password-protected file). 📸 `participant/03-backup`
2. Create the event: title, summary, start date, location, an approval mode
   that allows both invites and manual review, AI matchmaking **on**, default
   video length. 📸 `organizer/01-create-form`
3. Expect a success state with a **shareable event link** (and/or QR).
   Capture the link — every other persona uses it. 📸 `organizer/02-created`
4. Open the organizer admin. Expect sections for pending requests, invite
   codes, coordinator, co-organizers. 📸 `organizer/03-admin-empty`
5. Generate a batch of invite codes (e.g. 5). Expect one link + QR per code.
   Capture one invite link for Ivan. 📸 `organizer/04-invites`
6. *(Tier 2)* Attach the coordinator by its npub; expect an “attached”
   confirmation. 📸 `organizer/05-coordinator`
7. Verify the event also appears on Olga's home list marked as one she
   organizes.

### S3 — Nina: newcomer joins via plain link (phone)

1. Open the **plain event link** (no code) in Nina's session. Expect the
   event page with a clear “join” call to action. 📸 `participant/02-event-page`
2. Join as a brand-new user: photo, name, bio, skills, “looking for”. Note
   for `docs/internal/UI-SUGGESTIONS.md`: is it obvious which fields are public? Is any
   Nostr jargon leaking? 📸 `participant/04-join-form`
3. Submit. Expect a “request sent / waiting for the organizer” state.
   📸 `participant/05-request-sent`
4. Verify Nina is *not* able to see the attendee roster yet.

### S4 — Ivan: invited newcomer joins via code link (phone)

1. Open the **invite-code link** in Ivan's session. Join as a new user.
2. **Tier 2:** expect auto-approval within ~15–30 s → a “you're in” state
   without organizer action. 📸 `participant/06-approved`
   **Tier 1:** expect the request to land in Olga's pending queue flagged as
   invite-backed; Olga approves it there.
3. Confirm Ivan's fresh identity got a backup prompt too.

### S5 — Nadia: existing Nostr user joins (desktop)

1. Open the event link logged out; choose the “already a Nostr user” path;
   paste Nadia's nsec. 📸 `participant/07-signin-options`
2. On the join form, expect her **existing profile shown read-only**
   (name/bio/photo prefilled from Nostr, with a note it won't be changed);
   only event-specific fields (skills, looking-for) editable.
3. Send the join request.
4. *(Optional variant)* Re-run Nadia via the `bunker://` remote-signer path
   using the `nak bunker` recipe in §2.2 — same expectations, but every
   signature/encryption round-trips through the signer daemon.

### S6 — Olga: approvals & roster

1. In admin, expect Nina's and Nadia's pending requests (name, message,
   skills, invite badge where applicable). 📸 `organizer/06-pending`
2. Approve both. Expect them to move to the approved section.
   📸 `organizer/07-approved`
3. Within ~15 s, Nina's and Nadia's sessions should flip to approved (may
   need a revisit/refresh of the event page — note how discoverable that is).
4. Everyone approved opens the attendee list and sees the same roster.
   📸 `participant/08-attendees` (from Nina's phone)

### S7 — Recording intros (each approved attendee)

1. From the event page, go to record the intro. Enable camera (fake device
   feeds a test pattern), record a few seconds, stop, review the playback,
   accept it. 📸 `participant/09-record` (mid-recording, phone)
2. Expect an upload-success state and, afterwards, the video playable from
   that attendee's directory entry (verify from *another* attendee's session —
   this proves event-encryption works end to end).
3. Re-record path: record again, discard, keep the original — no duplicate
   entries.
4. *(Nadia, second event only / optional)* If a video library exists, verify
   “reuse previous video” is offered.

### S8 — Directory, social overlay & private actions

1. From Nina's session: browse attendees, open Nadia's detail page. Expect
   profile, skills, intro video, recent Nostr posts (Nadia has real history).
   📸 `participant/10-attendee-detail`
2. Follow Nadia. From Nadia's session, Nina should show a “follows you” /
   “following” badge (Nadia already followed Nina via her kind-3).
3. Toggle ★ favorite, “want to meet”, “met ✓”, and write a private note on
   someone. Reload — they persist. **Privacy check:** from any other persona,
   confirm none of that is visible.
4. Sort tabs (by matches / follows / name) reorder the list sensibly.

### S9 — Matches *(Tier 2 only)*

1. Wait for the coordinator to process intros (watch its logs; minutes).
2. Each attendee opens “people you should meet”. Expect ranked match cards
   with a percentage, similar/complementary breakdown, and **plain-language
   reasoning**. 📸 `participant/11-matches` (phone)
3. Tap through a match card to the attendee detail.
4. Olga triggers “recompute all matches” in admin; expect no errors and
   eventually refreshed lists.
5. Check the AI summary shows up on attendee detail pages.

### S10 — Otto: outsider privacy checks

1. Otto (logged in, never joined) opens the event link: sees only public
   info (title, date, summary) and a join prompt — **no roster, no videos, no
   matches**. 📸 `participant/12-outsider`
2. Otto navigates directly to the attendees/matches URLs: expect empty/denied
   states, not decrypted content.

### S11 — Organizer lifecycle extras

1. **Co-organizer:** Olga adds Nadia's npub as co-organizer. Nadia reopens
   the event and should now reach the admin screen with working approvals.
2. **Revoke:** Olga revokes Ivan. Expect a consequence-explaining
   confirmation. After it: Ivan no longer decrypts *new* roster/content;
   remaining attendees still see the roster (minus Ivan); observe re-grant
   flow completes. 📸 `organizer/08-revoke`
3. **Re-process** an attendee — no errors, directory entry republished.

### S12 — Persistence, hand-off & logout

1. Reload each persona's browser: sessions and event access must survive
   (identity in IndexedDB, no re-login).
2. Nina opens her profile page (“Me”): expect the Nostr hand-off — her npub,
   copyable, links to other Nostr apps, backup options. 📸 `participant/13-me`
3. Log out and back in with a copied nsec — same identity, same event access.

### S13 — Mobile sweep

Re-check S3, S6.4, S7–S9 screens on the phone personas per §2.1's checklist
(no horizontal scroll, nav reachable, truncation, tap targets). Screenshot
anything broken for `docs/internal/UI-SUGGESTIONS.md`.

---

## 5. Screenshot checklist

Save under `docs/images/organizer/` and `docs/images/participant/` (plus
`docs/images/app/` for shared chrome). PNG, light theme unless noted, phone
screenshots from a phone-viewport persona. Use these exact stems (add
`NN-` ordering as shown) so guide references resolve; recapture > reuse when
the UI changed.

| File stem | Screen / moment | Persona · viewport | Used in |
|---|---|---|---|
| `organizer/01-create-form` | event creation form, filled | Olga · desktop | Organizer guide |
| `organizer/02-created` | success + share link/QR | Olga · desktop | Organizer guide |
| `organizer/03-admin-empty` | admin overview, no requests | Olga · desktop | Organizer guide |
| `organizer/04-invites` | generated invite codes w/ QR | Olga · desktop | Organizer guide |
| `organizer/05-coordinator` | coordinator attached | Olga · desktop | Organizer guide |
| `organizer/06-pending` | pending join requests | Olga · desktop | Organizer guide |
| `organizer/07-approved` | approved attendees section | Olga · desktop | Organizer guide |
| `organizer/08-revoke` | revoke confirmation | Olga · desktop | Organizer guide |
| `participant/01-home` | landing screen | any · phone | Participant guide |
| `participant/02-event-page` | event page w/ join CTA | Nina · phone | Both guides |
| `participant/03-backup` | key backup card | Olga or Nina | Participant guide |
| `participant/04-join-form` | join form, filled | Nina · phone | Participant guide |
| `participant/05-request-sent` | waiting-for-approval state | Nina · phone | Participant guide |
| `participant/06-approved` | “you're in” state | Ivan · phone | Participant guide |
| `participant/07-signin-options` | existing-user sign-in methods | Nadia · desktop | Participant guide |
| `participant/08-attendees` | attendee roster | Nina · phone | Participant guide |
| `participant/09-record` | recording UI mid-capture | Ivan · phone | Participant guide |
| `participant/10-attendee-detail` | attendee detail w/ video + private actions | Nina · phone | Participant guide |
| `participant/11-matches` | match list w/ reasoning (Tier 2) | Nina · phone | Participant guide |
| `participant/12-outsider` | what a non-attendee sees | Otto · desktop | Participant guide |
| `participant/13-me` | Nostr hand-off / Me page | Nina · phone | Participant guide |
| `app/settings` | settings (theme + language) | any | Both guides |

---

## 6. Producing the two user guides

`ORGANIZER-GUIDE.md` and `PARTICIPANT-GUIDE.md` already exist as **skeletons
with placeholder screenshots and `<!-- TODO -->` markers**. After (not
during) the test run:

1. **Drop in the screenshots** you captured at the checklist stems; delete
   placeholder comments for images you added.
2. **Rewrite any step whose wording no longer matches the UI you saw.** The
   skeleton's step text is a best guess; the UI is the truth. Keep the
   section structure unless a whole feature moved.
3. **Honor each guide's voice** (stated at the top of each skeleton):
   the participant guide is for someone who has never heard of Nostr — no
   protocol jargon, no kind numbers, analogies over precision; the organizer
   guide may assume light technical comfort but still explains *why*
   (e.g. what attaching a coordinator gets you).
4. Fill the FAQ/troubleshooting sections with **real friction you hit**
   during testing — those are the questions real users will have.
5. Remove every remaining `TODO` marker; a guide with TODOs is not done.
6. Cross-check: every image referenced exists in `docs/images/`, and every
   captured screenshot is referenced somewhere (or deleted).

## 7. Reporting results

Write `docs/internal/testing/TEST-REPORT-<YYYY-MM-DD>.md` (gitignored — local
only) containing: environment (commit, tier, browser), a table of scenarios
S1–S13 with pass / fail / skipped and one-line notes, a **Bugs** section
(repro steps, expected vs. actual, console errors, screenshot), and a pointer
to the UI observations you appended to `docs/internal/UI-SUGGESTIONS.md`.
Bugs block guide-writing only if the flow is
impossible to complete — otherwise document the workaround in the guide's
troubleshooting section and keep going.
