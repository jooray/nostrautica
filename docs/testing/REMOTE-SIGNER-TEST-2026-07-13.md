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
