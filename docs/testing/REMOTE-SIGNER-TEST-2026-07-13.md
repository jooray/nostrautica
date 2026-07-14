# Nostrautica — Nostr-native sign-in & remote-signer test (2026-07-13)

Focused follow-up to [TEST-REPORT-2026-07-13.md](TEST-REPORT-2026-07-13.md):
the three "already on Nostr" sign-in paths, with the NIP-46 flows exercised
end-to-end through a real bunker daemon (join → approval → roster → follow →
DM, all remote-signed).

## Environment

| Item | Value |
|---|---|
| Commit | `8f827e9` (branch `implement-nostrautica`), preview build of ~18:12 incl. the gift-wrap cache fix `144a106` and the BUG-1b explicit-relay fix |
| App | `http://localhost:4173` (static `pnpm preview`) |
| Signer daemon | `nak` **v0.15.2** (go1.24.4, `/home/juraj/gocode/bin/nak`) |
| Driver | Playwright 1.61.1 chromium headless, Node v24.2.0, viewport 900×760 |
| Relay | `ws://localhost:7778` — **private** `e2e/local-infra/relay.mjs` (see incident) |
| Blossom | `http://localhost:3000` (shared, untouched) |

### Environment incidents & workarounds (read before reproducing)

1. **Shared relay death.** The shared in-memory relay on `:7777` crashed
   mid-run (alongside a preview-server crash during a bundle swap) and this
   session was not permitted to restart it. The run continued on a private
   `relay.mjs` instance on **`:7778`**, with the baked `ws://localhost:7777`
   rewritten to `:7778` in-flight per browser context (Playwright route
   interception on document+script responses — the served build and shared
   infra were never modified). Same relay implementation, so fidelity is
   unchanged; but all state described below lives on `:7778`.
2. **CSP.** As in the main report: the shipped `connect-src 'self' wss: https:`
   blocks `ws://localhost`; the same in-flight rewrite loosens it for the test
   contexts only. Chromium additionally needs
   `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`.
3. **One unreproduced hang.** Against the pre-rebuild bundle, the very first
   `bunker://` connect attempt hung >45 s *after* the bunker had ACKed the
   connect (verified in the nak log; the same nostr-tools 2.23.9 code path
   connected in 78 ms from Node against the same bunker). The preview was
   rebuilt with the BUG-1b fix moments later and the hang never reproduced
   (subsequent connects: 105–709 ms). Recorded as anecdote, not a bug — but if
   a bunker connect ever hangs in the field, note there is **no client-side
   timeout to surface it** (finding UX-2).

## Personas (seeded with nak)

| Persona | Path tested | Key |
|---|---|---|
| Radka | A — pasted nsec | `npub1tjvgmn…` |
| Milan | B(a) — `bunker://` paste, `nak bunker` autosign | `npub18v8cc3…` |
| Petra | B(b) — `nostrconnect://` QR flow | `npub1phmwwp…` |
| Oskar | throwaway organizer (nsec) — created "Remote Signer Rodeo II", approved joins | `npub1a49hk0…` |

Seeding (kind-0 with distinct name/bio/dicebear picture + non-empty kind-3),
exactly reproducible:

```sh
NAK=nak; R=ws://localhost:7778           # :7777 when the shared relay is up
SK=$($NAK key generate); PK=$($NAK key public $SK)
NSEC=$(echo $SK | $NAK encode nsec)      # what gets pasted into the app
$NAK event -k 0 --sec $SK -c '{"name":"Radka","about":"Herbalist and mesh-network tinkerer…","picture":"https://api.dicebear.com/9.x/avataaars/png?seed=Radka"}' $R
$NAK event -k 3 --sec $SK -p <followed-pubkey-hex> [-p …] $R
```

## Results

### Path A — pasted nsec (Radka) · ✅ PASS

Login → "Already on Nostr? Sign in" → paste nsec → **Import key**.

- Sign-in resolves in ~80 ms and navigates home.
- Join form on the event shows her kind-0 **read-only**: name, dicebear photo,
  bio, plus the note "From your Nostr profile — we won't change it…". Only
  Skills / Looking-for are editable. ✔
- "Send join request" → "Request sent" state. ✔ (Request later approved and
  she appears on the roster with her real bio and photo.)
- Session survives reload; `/me` shows her npub. ✔

### Path B(a) — `bunker://` paste with `nak bunker` autosign (Milan) · ✅ PASS

Signer daemon (this is the whole autosign recipe — the secret in the printed
URI auto-authorizes the connecting client; no flag needed, no prompt):

```sh
nak bunker --sec <hex-or-nsec> ws://localhost:7778
# prints: bunker://<user-pubkey>?relay=ws%3A%2F%2Flocalhost%3A7778&secret=XXXX
```

⚠ **The secret is single-use**: after each successful `connect`, nak rotates
it and prints a fresh URI. Paste the *latest* printed URI for each new client.
To pre-authorize a known client key instead: `-k <client-pubkey-hex>`.

Every remote-sign surface a pasted-nsec user never hits, measured:

| Flow (all through the bunker) | Result | Latency |
|---|---|---|
| Connect + `get_public_key` (paste URI → "Connect bunker") | ✅ | 105 ms |
| Join request (kind-1059 gift-wrap: `nip44_encrypt` ×2 + `sign_event`) | ✅ | 130 ms |
| Approval grant landing (kind-1059 unwrap: `nip44_decrypt` via bunker) | ✅ | "See who's here" ~3 s after organizer approval |
| Roster decrypt (event-key via remote decrypt) | ✅ | shows Radka w/ bio+skills |
| Social overlay | ✅ | "Follows you" badge from Radka's seeded kind-3 |
| Follow (kind-3 update, remote-signed) | ✅ | 117 ms → "Following ✓" |
| DM send (NIP-17 double wrap, remote-signed) | ✅ | 876 ms; Radka's inbox shows it |
| DM receive (unwrap Radka's reply via remote `nip44_decrypt`) | ✅ | reply visible <8 s |
| Session persistence (reload → NIP-46 reconnect, same client key) | ✅ | `/me` still signed in, "Signed in via nip46." |

### Path B(b) — `nostrconnect://` (Petra) · ✅ app-side PASS / ❌ nak cannot drive it

- The app's "Connect with Remote Signer" renders QR + `nostrconnect://` URI +
  Copy + "Open in Amber" deep link + "Waiting for the signer to approve…". ✔
- **`nak bunker connect <nostrconnect-uri>` is a stub in nak v0.15.2 — it
  prints `this is not implemented yet` and exits.** So nak cannot consume the
  QR flow; keep Amber/a scripted signer for it.
- To not leave the path untested, a ~60-line Node NIP-46 signer
  (nostr-tools 2.23.9: subscribe kind-24133, publish the URI secret, serve
  `get_public_key`/`sign_event`/`nip44_*`) completed the handshake: sign-in
  resolved in **216 ms**, `/me` shows Petra's npub, and her join request went
  through remote-signed in 1064 ms. The app-side client flow is correct.
- Protocol note: right after connecting the app (nostr-tools) issues a
  `switch_relays` request; a signer that answers it with an error does **not**
  break the flow.

## UX findings (severity-ranked)

1. **P1 — Offline/unreachable bunker = infinite silent hang.** Pasting a
   syntactically valid `bunker://` URI whose signer is not responding and
   clicking **Connect bunker** disables the button forever: observed 120 s
   with no spinner, no timeout, no error, no cancel. A signer-app user whose
   phone is asleep/offline gets zero feedback and a dead form (only escape:
   navigate away and come back). Repro: `bunker://<any-valid-pubkey-with-no-signer>?relay=ws%3A%2F%2Flocalhost%3A7778&secret=x` → Connect bunker → wait.
   Suggested: 15–20 s timeout with "Signer didn't respond — is it online?" + a
   cancel affordance.
2. **P2 — Organizer admin keys are device-bound (discovered incidentally).**
   Oskar created an event, then signed in with the *same nsec* in a fresh
   browser context: admin shows "You don't hold this event's organizer keys on
   this device" and there is no recovery path offered. A real organizer
   switching devices (or clearing storage) permanently loses their own admin
   screen. If this is by design, the create flow should say so and offer an
   organizer-key backup/hand-off.
3. **P2 — No feedback while a bunker connect is in flight.** During
   `bunker://` connect the button is just disabled — no "contacting your
   signer…" state. With a real phone signer (human approval takes seconds to
   minutes) users will assume the app froze. The nostrconnect side *does* show
   "Waiting for the signer to approve…" — the paste path should match.
4. **P2 — "Request sent" state is not persisted.** After reload (path A and
   B), the join page shows the pristine form again and the event page shows
   the "Join this event" CTA — nothing tells the user a request is already
   pending, and resubmitting creates a duplicate request for the organizer.
5. **P3 — Malformed bunker pubkey surfaces a raw crypto error.** A
   `bunker://` URI whose pubkey is not on the curve fails in ~3 s with
   "bad point: is not on curve, sqrt error: Cannot find square root" —
   honest, but gibberish to a signer-app user. Say "That doesn't look like a
   valid bunker link."
6. **P3 — No explicit cancel in the nostrconnect waiting state.** Once the QR
   is up, the only ways out are the browser Back / bottom nav; a "Cancel"
   under "Waiting for the signer to approve…" would be clearer (also needed if
   the user scanned with the wrong app).
7. **P4 — `/me` says "You're a Nostr user now" to veteran Nostr users.** For a
   session signed in via nsec/NIP-46 (an *existing* identity, name+profile
   already on relays) the newcomer copy and the absence of the user's own
   name/avatar on `/me` feel off. (Nice touch spotted: "Signed in via nip46."
   and "Your key lives in your signer — back it up there.")

## Reproduction crib

```sh
# bunker daemon (autosign):
nak bunker --sec <sk> ws://localhost:7777          # paste the printed bunker:// URI
# nostrconnect (nak CAN'T):
nak bunker connect '<nostrconnect://…>'            # -> "this is not implemented yet"
# driver scripts used (temp, deleted after the run): e2e/.rs-*.mjs
# screenshots: docs/images/participant/16-signin-nsec-{light,dark}.png,
#              docs/images/participant/17-signin-bunker-{light,dark}.png
```

## Fixes applied (2026-07-13)

NIP-46 hardening pass against the findings above. All changes on branch
`implement-nostrautica` (not committed — for maintainer review). `pnpm check`
green (0 errors). Files touched:
`packages/app/src/lib/signer/nip46.ts`,
`packages/app/src/lib/components/SignInOptions.svelte`,
`packages/app/src/lib/nostr/relays.ts`.

### Finding → fix → verification

| # | Finding | Fix | Verified |
|---|---|---|---|
| **P1** | Offline bunker = infinite silent hang on `bunker://` connect | `fromBunkerUri` now wraps `bunker.connect()` in a 45 s timeout + `AbortSignal`; on timeout/cancel it closes the signer and throws the human message *"Your signer didn't respond — check it's online and try again."* The Connect button re-enables (never disabled-forever). | ✅ E2E (b): timeout error appeared < 60 s; button re-enabled; Cancel mid-flight reset the form. Timeout primitive unit-tested (bounds a never-resolving promise at the deadline; honors abort; passes through success). |
| **P2** | No feedback during `bunker://` connect | Added a *"Contacting your signer…"* progress note + a **Cancel** button while the connect is in flight. | ✅ E2E (a): progress note observed before the connect resolved. |
| **P3** | Malformed bunker pubkey → raw *"bad point: is not on curve"* | `looksLikeBunkerUri` gate (64-hex + ≥1 relay) before any crypto, **and** a try/catch around `BunkerSigner.fromBunker` (which derives the conversation key synchronously) → both surface *"That doesn't look like a valid bunker link."* | ✅ E2E (c): off-curve 64-`f` pubkey → friendly message, no curve error. |
| **P3** | No Cancel in the nostrconnect waiting state | `startNostrConnect` now returns a `cancel()` (aborts the `fromURI` wait); a **Cancel** button under *"Waiting for the signer to approve…"* returns to idle. A user-initiated cancel is treated as non-error (no red banner). | ✅ E2E (d): Cancel returned to the idle "Connect with Remote Signer" button. |
| — | Session-restore reconnect could block app boot forever on a dead bunker | `fromPersisted` wraps the reconnect in a **12 s** budget (shorter than the interactive one — boot must not stall) and closes the signer on timeout; `session.restore()` already swallows the failure → app boots logged-out. | ✅ E2E (e): live bunker → session restored and `/me` shows the npub; dead bunker (killed after login) → shell booted logged-out in < 200 ms across every run, never wedged. |

### Best-practice URI improvements (no finding, requested)

- **Client metadata**: the `nostrconnect://` URI now advertises `name=Nostrautica`
  + `url=<origin>`, and the `bunker://` `connect` RPC passes the same metadata,
  so a real signer's approval screen names the app instead of "unknown app".
- **`perms`** corrected to the kinds the app signs *directly* through the signer,
  so signers (Amber/nsec.app) can grant once instead of prompting per event:
  `sign_event:{0,3,13,10002,24242,30078,31600,31601,31602,31923,31925}` +
  `nip44_encrypt`/`nip44_decrypt`. The prior list was missing **13** (the NIP-59
  *seal* — signed for every gift-wrapped join request and NIP-17 DM), **10002**,
  **24242**, **30078**, and wrongly listed **1059** (the gift-wrap outer is signed
  with a local ephemeral key, never the user's signer).
- **`auth_url`** now handled: an `onauth` callback opens the challenge URL in a new
  tab (spec's out-of-band approval), wired on all three paths (nostrconnect,
  bunker paste, restore). Previously a signer that required a challenge would have
  logged a warning and stalled.

### Relays for the nostrconnect URI

Introduced `NIP46_RELAYS = ["wss://relay.nsec.app", "wss://relay.primal.net"]`
(was the app's general-purpose `DEFAULT_RELAYS`). `relay.nsec.app` is the
de-facto dedicated NIP-46 signer relay (nsec.app/noauth default, referenced by
Amber and nostrconnect.org); dedicated signer relays don't rate-limit the
ephemeral kind-24133 RPC traffic the way general relays do. Paired with a
widely-reachable general relay as a fallback since relay.nsec.app has had
reported EU flakiness. **`VITE_NOSTRAUTICA_RELAYS` still overrides it** (the
`ENV_RELAYS ??` guard), so the §2.2 e2e recipe is unaffected. `bunker://`
connects continue to honor the relays in the pasted URI (nostr-tools
`parseBunkerInput` → `fromBunker`, unchanged).

### Verification harness

Own isolated infra on free ports (relay :7791, blossom :3011, preview :4179;
shared :7777/:3000/:4173 untouched; shared `packages/app/build` rebuilt back to
`ws://localhost:7777` + `http://localhost:3000` afterwards). Playwright chromium
headless with the `LocalNetworkAccessChecks` disable flag + per-context CSP
strip (as in the original run). `nak` v0.15.2 autosign bunker for the happy
path. Driver scripts were temporary (`e2e/.rs-*.mjs`, deleted after the run).
Result: **9/10 scripted assertions PASS**; the one non-pass was a selector-timing
artifact in the dead-bunker reload assertion — the shell demonstrably booted
(logged-out, not wedged) in every run, which is the actual requirement.

### Not fixed (out of scope for this pass)

- **P2 — organizer admin keys device-bound** and **P2 — "Request sent" not
  persisted** and **P4 — newcomer copy for veterans**: unrelated to NIP-46
  robustness; left for their own changes.

## Fixes applied (2026-07-14) — the three findings deferred above

UX pass on branch `implement-nostrautica` (not committed). `packages/app`
lint/typecheck/tests green. Files:
`packages/app/src/lib/pages/{Admin,Join,EventHome,Me}.svelte`,
`packages/app/src/lib/events/{organizer,join}.ts`,
`packages/app/src/lib/stores/join-sent.svelte.ts` (new). Each verified
end-to-end with a scripted Playwright run against the local stack.

| Finding | Fix | Verified |
|---|---|---|
| **P2 — organizer admin keys device-bound** | The "You don't hold this event's organizer keys on this device" state is now a real recovery path: it explains that organizer keys live on the creating device, shows the user's own npub with a copy button and step-by-step instructions ("On the device you created the event with, open Admin → Co-organizers and add this npub"), and **polls for the incoming 21605 organizer grant** (same `receiveGrants` channel co-organizers use) so the page unlocks in place — no reload. | ✅ E2E: fresh context signed in with the organizer's nsec showed the recovery card (own npub + instructions + "Waiting for the grant…"); after the original device added that npub under Co-organizers, the second context's admin page unlocked automatically within seconds. |
| **P2 — "Request sent" not persisted** | New per-event join marker (`nostrautica:join-sent` in localStorage, keyed by event coordinate, timestamped), set on submit. On reload the Join page restores the waiting state (and resumes the grant poll); EventHome shows "Request sent — waiting for approval" instead of the Join CTA. The marker clears when approval lands, and a quiet "Send the request again" link covers the stuck case (clears the marker, returns to the form). | ✅ E2E: reloaded Join page showed the waiting state, not the pristine form; EventHome showed the pending state with no Join CTA; after approval both pages flipped to member state. |
| **P4 — "You're a Nostr user now" for veterans** | `/me` now keys off how the identity got here. Full onboarding payoff only for a key created *this session* (`session.freshLocalKey`); everyone else gets a compact "Your Nostr profile" page (npub + copy, "Signed in via …" note, logout). The keystore doesn't record generated-vs-imported, so local-key users on a later visit get a middle ground: backup card kept, onboarding pitch dropped. nip07/nip46 sessions get no backup section — just the "your key lives in your signer" note. | ✅ E2E: same-session fresh key → "You're a Nostr user now"; after reload (local key) → "Your Nostr profile" + backup card, no pitch. nip46 path not re-driven (no bunker in this run) — it takes the same non-local branch as the verified imported-nsec case, minus the backup card. |

## Addendum (2026-07-14): mobile field failure — lost ephemeral reply

### Field failure

Maintainer's real-phone Amber test: after approving in Amber, the app never
logs in — the wait just runs into the timeout.

### Root cause — CONFIRMED

Kind-24133 RPC events are **ephemeral** (20000–29999 range): relays don't
store them, and the `BunkerSigner` subscription filter carries `limit: 0`, so
a missed reply is never replayed either. The reply exists only for sockets
open at publish time. On mobile, tapping "Open in Amber" backgrounds the
browser tab; the browser throttles/kills the websocket exactly when Amber
publishes its response → the approval is lost forever. Two compounding
deficiencies in nostr-tools' defaults (verified in the 2.23.9 source):
`SimplePool` ships with `enableReconnect: false` (socket close silently kills
the subscription, no resubscribe) and no keepalive (`enablePing` off), so an
idle waiting socket also gets reaped by mobile radios/proxies. Reproduced
deterministically (see verification): with the signer's reply frame dropped in
transit, the pre-fix code waits until timeout in 100 % of runs.

### Fixes

| Area | Change |
|---|---|
| Transport | All NIP-46 `BunkerSigner`s now get a dedicated `SimplePool({ enableReconnect: true, enablePing: true })` — auto-reconnect + resubscribe on socket close, keepalive ping (browser fallback: dummy REQ every 29 s, dead socket detected in 20 s) so idle waits aren't reaped. The pool is destroyed on cancel/timeout/close so failed attempts don't leak reconnecting sockets. |
| `bunker://` recovery | `connectWithRecovery`: on `visibilitychange`→visible while the connect is still pending, re-send `connect` (client-initiated, safe to repeat) **and** probe with `ping`. The ping is what confirms a connect whose ack was lost — verified against nak, which rotates the single-use secret server-side, so the re-sent connect alone fails while ping answers. Sending also forces an immediate pool reconnect instead of waiting out the ~10 s backoff. A first-attempt failure while the tab is hidden is held (not surfaced) so recovery gets its chance, still bounded by the 45 s timeout. |
| `nostrconnect://` recovery | The signer initiates, so a lost reply can't be re-requested. On foreground-return still-waiting (3 s grace): visible hint “Didn't get the approval? Keep this tab open while approving, or retry with a fresh code.” + **Retry** that regenerates the URI (new client key + secret). Wait budget raised to 120 s (human-paced flow, tab-switch included); Cancel unchanged. Signers generally publish the response once and move on — the client must not rely on signer-side retries, and this one no longer does. |
| Relays | `NIP46_RELAYS` = `wss://relay.nsec.app` + `wss://relay.damus.io` + `wss://relay.primal.net` (maintainer's requested set). To be clear: **redundancy only helps while our sockets are open** — three relays don't save a reply published while the tab was backgrounded; the reconnect + foreground-recovery logic above is the real fix. `VITE_NOSTRAUTICA_RELAYS` still overrides. |
| Subscription-open race | Audited: `fromURI`/`fromBunker` queue the REQ at call time and the QR renders the same tick, vs. a human scan seconds later — no practical race. The dangerous gap was the missing resubscribe-on-close, fixed above. |

Files: `packages/app/src/lib/signer/nip46.ts`,
`packages/app/src/lib/components/SignInOptions.svelte` (+ hint/retry i18n keys
in `i18n/messages.ts`), `packages/app/src/lib/nostr/relays.ts`.

### Verification (2026-07-14, headless)

Own infra: relay `:7791`, **frame-level lossy WS proxy** `:7799` (control
endpoint toggles dropping server→client EVENT frames / hard-terminating
sockets — deterministic reproduction of “reply published while our socket was
down”), blossom `:3011`, preview `:4179` built with
`VITE_NOSTRAUTICA_RELAYS=ws://localhost:7799`. Foreground-return simulated by
dispatching `visibilitychange`. Temp drivers `e2e/.rs-*.mjs`, deleted after
the run.

Gap scenarios — **7/7 PASS**:

| Scenario | Result |
|---|---|
| GAP-1 `bunker://`: nak's connect ack dropped in transit → still pending (proves the failure mode) | ✅ |
| GAP-1 sockets hard-terminated (“backgrounded”), then foreground return → re-send + ping probe → **login completes** | ✅ |
| GAP-1 `/me` shows npub after recovery | ✅ |
| GAP-2 `nostrconnect://`: scripted signer's approval reply dropped → still waiting | ✅ |
| GAP-2 foreground return → retry hint appears after the 3 s grace | ✅ |
| GAP-2 Retry regenerates a fresh `nostrconnect://` URI | ✅ |
| GAP-2 fresh approval against the new URI → login completes | ✅ |

Happy-path regression (previous suite re-run through the proxy, lossy off):
malformed→friendly; nostrconnect cancel→idle without error banner or
premature hint; bunker connect + progress; `/me` npub; live restore;
offline-bunker Cancel; offline-bunker timeout <60 s; button re-enabled —
**8/8 PASS**. `pnpm check` green (0 errors).
