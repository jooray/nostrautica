# Nostrautica — Real-Relay Gift-Wrap Validation & Custom-Kinds Registry Check (2026-07-13)

Two independent verification jobs, run after the BUG-1 / BUG-1b fixes
(see [`TEST-REPORT-2026-07-13.md`](TEST-REPORT-2026-07-13.md)):

1. **Job 1** — validate the fixed gift-wrap delivery flows against a **real
   relay implementation** (not the minimal in-memory `e2e/local-infra/relay.mjs`
   the bugs were found against).
2. **Job 2** — re-verify the custom kind numbers against the current
   nostr-protocol/nips registry (spec §15 volatile-facts item).

---

## Job 1 — gift-wrap flows against a real relay

### Environment

| Item | Value |
|---|---|
| Commit under test | `1ff2ce5` (branch `main`; includes fix commits `144a106` relay-only gift-wrap reads and `8f827e9` explicit `DEFAULT_RELAYS` for gift-wrap fetches) |
| Relay | **`nak serve`** on `ws://127.0.0.1:7778` — nak's built-in relay is **khatru-based** (fiatjaf's production relay framework), with real NIP-01 semantics: signature verification, replaceable/addressable pruning, ephemeral-kind handling, per-filter limits. nak binary: `/home/juraj/gocode/bin/nak` (build of 2025-08-18; `nak serve` default port 10547, overridden) |
| Container runtimes | `docker` absent; `podman` absent (only a broken 2020 podman-compose shim); per brief, did not sink time into `brew install podman` — `nak serve` is far closer to production semantics than `relay.mjs` and was sufficient |
| Blossom | `e2e/local-infra/blossom.mjs` on `http://localhost:3001` (own instance) |
| App under test | Isolated **git worktree** at commit `1ff2ce5`, built with `VITE_NOSTRAUTICA_RELAYS=ws://127.0.0.1:7778`, `VITE_NOSTRAUTICA_BLOSSOM=http://127.0.0.1:3001`; served statically on `http://localhost:4180`. **The shared build (`packages/app/build`), ports 7777/3000/4173, and the other agent's test stack were never touched** — no restore needed. |
| Driver | Playwright chromium (headless), Node v24.2.0 |

Harness workarounds (same class as the prior report; test-only, nothing shipped):

- Chromium launched with `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults` (headless Chromium otherwise blocks `ws://127.0.0.1` from a `localhost` page).
- The worktree copy of `build/index.html` had its CSP `<meta>` relaxed (`connect-src` + `ws: http:`, `img-src` + `http:`) so the app could reach the local plaintext relay/Blossom. Note: `vite preview` serves the prerendered HTML from `.svelte-kit/output`, **not** `build/` — patching `build/index.html` only takes effect when serving `build/` directly (a static server was used).

### Full-loop results (custom driver, fresh personas)

| Step | Result | Timing / notes |
|---|---|---|
| Organizer identity + event create (31600/31923 publish) | ✅ pass | ~2 s |
| Invite-code generation (31601) | ✅ pass | link with `?code=` produced |
| Join via **invite link** (new user, gift-wrapped 21600/21601 → E_inbox) | ✅ pass | "Request sent" |
| Join via **plain link** (new user, manual path) | ✅ pass | "Request sent" |
| Organizer sees both pending (unwraps E_inbox wraps) | ✅ pass | both visible on admin load |
| Approve both (21602 key grants gift-wrapped to attendees) | ✅ pass | "Approved ✓" |
| **BUG-1 regression: grant ARRIVES** — invite attendee | ✅ pass | "You're in 🎉" already showing when checked (**≪ 15 s**; the join-page poll caught it live during approval) |
| **BUG-1 regression: grant ARRIVES** — manual attendee | ✅ pass | approved state in **0.1 s** after event-page visit |
| Roster decrypts (31603/31604 via ECK) — both attendees | ✅ pass | both names + entries visible |
| **BUG-1b regression: DM round-trip** (NIP-17 kind 14 in 1059 wraps) | ✅ pass | no hang; A→B received in **0.3 s**, B→A reply visible on A's side |
| Reload persistence (identity + ECK survive) | ✅ pass | roster still decrypts after reload |
| Outsider privacy | ✅ pass | encrypted-empty state, no leak |

**15/15 checks passed.** Both fixed bugs stay fixed against a real relay, and
the flows are dramatically *faster* than against the in-memory relay runs
(grants/DMs in sub-second, vs. multi-second polling before).

### Scripted suite (`e2e/tests`)

Run from the isolated worktree with `NOSTRAUTICA_E2E_RELAY=1
NOSTRAUTICA_URL=http://localhost:4180` (webServer block dropped — 4173 belongs
to the shared stack; LNA-disable launch args added).

- **As checked in: 1/3 pass.** `smoke` and `walking-skeleton` both fail on a
  **stale selector**: they click `getByRole("button", { name: /create an
  identity/i })`, but the login screen now renders the create-identity form
  directly with a "**Create my identity**" button and a required "Your name"
  field. This is UI drift, not a relay or app failure (the deep-link test
  passes as-is).
- **After updating the specs to the current UI (worktree copies only): 3/3
  pass** — walking-skeleton (create → join → approve → roster → outsider
  denied) completes in **7.3 s** against the real relay. Suite fixes needed,
  for whoever maintains `e2e/tests` (not applied to the repo per my brief):
  1. `newUser`: fill "Your name", click "Create my identity" (the old
     two-click `create an identity` → `continue` flow is gone).
  2. Join form: the name field only exists for logged-out users; a logged-in
     user gets a read-only profile section (fill conditionally).
  3. The `await expect(organizer.getByText(/approved/i))` assertion is
     ambiguous — it can match the "Approved requests" section header *before*
     the grant publish finishes. Match `/approved ✓/i` and allow ~20 s.
  4. Attendee must visit the **event page** first (it runs the
     `receiveGrants` poll) before `/attendees` decrypts; going straight to
     `/attendees` after approval races the one-shot grant fetch.

### Behavioral differences: `nak serve` (khatru) vs `e2e/local-infra/relay.mjs`

Probed directly over the wire (plus what the app run exercised):

| Semantics | relay.mjs (in-memory) | nak serve (khatru) | Impact on app |
|---|---|---|---|
| **Addressable pruning** (31600 etc., same `d`) | none — returns **all** versions | returns **only latest** | App copes with both (client dedupes by `created_at`). Config/roster updates behave correctly against real pruning. |
| **Replaceable pruning** (kind 0, 10002) | none | latest only | Same — fine. |
| **Per-filter `limit`** (the BUG-1b test-relay bug shape) | fixed 2026-07-13 to per-filter union | per-filter, NIP-01-correct: a `limit:1` filter in the same REQ does **not** starve a `{kinds:[1059],"#p":…}` filter | Confirms the relay.mjs fix matched real-relay behavior; the original starvation was purely a test-relay artifact. |
| **Signature verification** | none (only checks `id`/`sig` present) | full — bad sig ⇒ `["OK",…,false,"invalid: signature is invalid"]` | All app-published events (incl. randomized-key gift wraps) verify — the whole loop worked, so wrap signing is correct. |
| **Ephemeral kinds** (20000–29999) | stored like everything else | **not stored**; publish with no live subscriber ⇒ `OK false` `"mute: no one was listening for this"`; re-query returns nothing | Desirable: confirms the leak-containment rationale for rumor kinds 21600–21605 — if a client bug ever published a signed rumor, a real relay wouldn't retain it. Note khatru returns `OK false` for it; app code must not treat that as a fatal publish error (no app path publishes ephemeral kinds today). |
| **Backdated gift-wrap timestamps** (NIP-59 up-to-2-day backdating) | returned (after limit fix) | returned correctly with `since = now − 3 d` filters | BUG-1's original trigger; real relay handles it fine. |

One test-harness observation (not app, not relay): the admin page fetches
pending requests once on mount; a Playwright `page.goto()` to the **same** hash
URL is a no-op in a hash-routed SPA, so a driver must `reload()` (or click the
in-app Refresh) to re-run `fetchPending` — worth remembering in future drivers.

**Job 1 verdict: PASS.** The gift-wrap grant and DM flows (BUG-1, BUG-1b) work
end-to-end against a real khatru-based relay, faster and with no behavioral
regressions; every relay-semantics difference found is one the app already
handles correctly.

---

## Job 2 — custom kinds registry check

Registry source: `https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md`
(the kinds table in the README is the registry; no separate/newer registry file
is referenced), fetched **2026-07-13**. Range definitions per NIP-01: regular
`1000 ≤ n < 10000 ∪ {1,2,4–44}`, replaceable `10000 ≤ n < 20000 ∪ {0,3}`,
**ephemeral `20000 ≤ n < 30000`**, **addressable `30000 ≤ n < 40000`**.

### Custom kinds (packages/protocol/src/kinds.ts)

| Kind | Nostrautica use | Registry status | Verdict |
|---|---|---|---|
| 31600 | Event Networking Config | unassigned | **CLEAR** |
| 31601 | Invite List | unassigned | **CLEAR** |
| 31602 | My Event Profile | unassigned | **CLEAR** |
| 31603 | Directory Entry | unassigned | **CLEAR** |
| 31604 | Roster index | unassigned | **CLEAR** |
| 31605 | Match List | unassigned | **CLEAR** |
| 31606 | Match Matrix | unassigned | **CLEAR** |
| 31607–31609 | reserved block headroom | unassigned | **CLEAR** |
| 21600 | Join Request (rumor) | unassigned | **CLEAR** |
| 21601 | Profile Submission (rumor) | unassigned | **CLEAR** |
| 21602 | Key Grant (rumor) | unassigned | **CLEAR** |
| 21603 | Coordinator Grant (rumor) | unassigned | **CLEAR** |
| 21604 | Admin Command (rumor) | unassigned | **CLEAR** |
| 21605 | Organizer Grant (rumor) | unassigned | **CLEAR** |

No kind whatsoever is registered in **21600–21699** or **31600–31699**.
Nearest registered neighbors: below/above the 31600 block — `31234` Draft Event
(NIP-37) and `31922–31925` NIP-52 calendar, `31989/31990` NIP-89; around the
21600 block — `22242` NIP-42 auth is the lowest 2xxxx entry in the registry
(nothing between 20000 and 22242 is registered at all).

**Range sanity.** 31600s sit in the addressable range (30000–39999) ✓.
21600s sit in the ephemeral range (20000–29999) — still semantically right for
rumor kinds: rumors are only ever delivered inside NIP-59 gift wraps and never
published as signed events, and the ephemeral placement means a real relay
won't store one if it ever leaks (empirically confirmed against khatru in
Job 1: signed kind-21600 publish ⇒ not stored). No NIP has since claimed
numbers inside either of our blocks.

### Reused standard kinds — usage re-verified against the registry

| Kind | Our use | Registry says | OK? |
|---|---|---|---|
| 0 / 1 / 3 / 5 / 6 | profile / note / follows / deletion / repost | NIP-01 / NIP-10 / NIP-02 / NIP-09 / NIP-18 | ✅ |
| 13 | Seal | NIP-59 Seal | ✅ |
| 14 | private DM rumor | NIP-17 Direct Message | ✅ |
| 1059 | Gift Wrap | NIP-59 Gift Wrap | ✅ |
| 10002 | relay list | NIP-65 (also NIP-51) Relay List Metadata | ✅ |
| 10063 | Blossom user server list | "User server list" — registry files it under **NIP-B7** (Blossom's BUD-03 list, absorbed into the NIPs as B7) | ✅ (kinds.ts comment says "BUD-03"; equivalent, could mention B7) |
| 24133 | NIP-46 remote signing | Nostr Connect (NIP-46) | ✅ |
| 24242 | Blossom auth | "Blobs stored on mediaservers" (NIP-B7) | ✅ (same B7 note) |
| 30023 | long-form | NIP-23 Long-form Content | ✅ |
| 30078 | app data / key backup | NIP-78 Application-specific Data | ✅ |
| 31923 / 31924 / 31925 | calendar event / calendar / RSVP | NIP-52 (all three) | ✅ |
| 38421 | Routstr provider announcement (external convention, spec §9.4) | **not in the registry** | ⚠ informational — Routstr's own convention, unregistered; not ours to defend, but a future NIP claiming 38421 would only affect the optional Routstr discovery path |

**Job 2 verdict: ALL CLEAR — no collisions.** Nothing needs renumbering.
Spec §15's re-verify row updated with this check date (this file is the
evidence). Recommend one final registry glance immediately before the actual
public-release tag, as the registry moves.
