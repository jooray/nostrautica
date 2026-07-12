# Nostrautica — Implementation Plan

Companion to `SPECIFICATION.md` (the spec is normative; section references like §6.3 point there). This document tells the implementer **what to build, in what order, and how to know it works**.

## 0. Repository layout & toolchain

```
nostrautica/
├── package.json                 # pnpm workspaces, scripts
├── pnpm-workspace.yaml
├── packages/
│   ├── protocol/                # shared: kinds, schemas, crypto — ZERO UI/server deps
│   │   └── src/
│   │       ├── kinds.ts         # kind constants (31600–31609, 21600–21604, standard)
│   │       ├── schemas.ts       # zod schemas for every payload in spec §7
│   │       ├── crypto.ts        # eckEncrypt/Decrypt, blindedD, AES-GCM media,
│   │       │                    #   invite sig make/verify, giftwrap helpers, nip44 self
│   │       ├── media.ts         # media descriptor build/parse
│   │       └── index.ts
│   ├── app/                     # SvelteKit PWA
│   │   └── src/lib/
│   │       ├── signer/          # login ladder, key storage, NIP-49, mailto backup
│   │       ├── router/          # hash router (spec §10.1)
│   │       ├── nostr/           # NDK setup, subscriptions, publish queue
│   │       ├── blossom/         # upload/mirror/preflight wrappers
│   │       ├── media/           # MediaRecorder capture, encrypt, playback
│   │       └── pages/
│   └── coordinator/             # Node daemon
│       └── src/
│           ├── providers/       # types.ts + venice.ts + routstr.ts + local-whisper.ts
│           ├── pipeline/        # job stages (spec §9.2)
│           ├── matching/        # pair scoring, embeddings prefilter (spec §9.3)
│           ├── store/           # better-sqlite3 schema + migrations
│           └── main.ts
├── docker/                      # compose: strfry relay + blossom-server (tests/dev)
└── e2e/                         # Playwright
```

Toolchain: pnpm, TypeScript strict everywhere, vitest, Playwright, ESLint (+ a lint rule banning `nip04` imports/usages), GitHub Actions.

Key dependencies (pin at P0; verify current APIs then — spec §15): `@nostr-dev-kit/ndk` v3 + `@nostr-dev-kit/cache-dexie` + `@nostr-dev-kit/svelte`, `nostr-tools` (nip19/44/49/59 modules used inside `protocol`), `blossom-client-sdk`, `vite-plugin-pwa`, `zod`, `better-sqlite3`, `@cashu/cashu-ts` (P6), Paraglide JS.

## 1. Phases

Ordering rationale: crypto/protocol correctness first (everything depends on it), then a deployable shell (deployment surprises surface early, especially nsite), then a **walking skeleton with no media and no AI** (the full trust/key flow end-to-end), and only then the expensive layers.

---

### P0 — Monorepo + `protocol` package  (size: S/M)

Build:
- Workspace scaffolding, CI (lint → typecheck → unit).
- `kinds.ts`, `schemas.ts` (zod for every §7 payload, versioned), `crypto.ts`:
  - `eckEncrypt/eckDecrypt` (NIP-44 v2 construction with raw 32-byte key — wrap nostr-tools nip44 internals),
  - `blindedD(key, coordinate, pubkey)` (§6.6) and `blindedDLiteral(key, "library")`,
  - AES-256-GCM media encrypt/decrypt (WebCrypto in browser, node:crypto webcrypto in coordinator — same code path via globalThis.crypto),
  - invite proof `makeInviteProof(inviteNsec, coordinate, attendeePubkey)` / `verifyInviteProof` (schnorr over `sha256("<coordinate>:<attendee-pubkey>")`),
  - gift-wrap helpers `wrapRumor/unwrapRumor` (nostr-tools nip59) typed per rumor kind,
  - NIP-44 self-encryption helpers.

Acceptance:
- vitest round-trips every schema (parse(serialize(x)) == x) and every crypto helper (encrypt→decrypt, sign→verify, blinded-d determinism, wrong-key failure cases).
- Cross-runtime test: a payload encrypted under Node decrypts in a browser-like (jsdom + webcrypto) environment.

---

### P1 — App shell: keys, PWA, deploy  (size: M)

Build:
- Hash router (§10.1) + page scaffold + dark/light theming (§10.5).
- Login ladder (§5.1): NIP-07; NIP-46 nostrconnect QR (secret verification + mandatory `get_public_key`; also bunker:// paste); generated local key.
- Key backup card (§5.2): mailto link (nsec in app-URL fragment), NIP-49 export, raw copy; `#/login?nsec=` consumption with history strip.
- NDK v3 + dexie cache wiring; publish queue with offline flush.
- vite-plugin-pwa autoUpdate + `onRegisteredSW` periodic check + visibilitychange check (§10.2).
- CI deploy: build → `nsyte deploy` (NIP-46 bunker key in CI secret, `--fallback /index.html`) + mirror to a conventional static host.

Acceptance:
- Log in all three ways (NIP-46 tested against real Amber).
- App installs as PWA and loads from an nsite gateway URL.
- Redeploy → open app → new version active within one update-check interval; deep link `#/e/xyz` loads correctly from the nsite gateway.

Gotchas: NDK signer `encrypt` must be called with `'nip44'` explicitly; test the mailto link length limits with a real mail client.

---

### P2 — Walking skeleton: create → join → approve → roster  (size: L)

No media, no AI, no coordinator — the organizer's client does everything. This phase proves the entire key model.

Build:
- Create-event flow (§8): `E_id`/`E_inbox`/ECK generation, kind 0 for `E_id`, 31923 + 31600 publish, 30078 key backup.
- Join flow: gift-wrapped 21600 (+ optional 21601 with profile text only), 31602 self-copy.
- Organizer admin page: unwrap pending 21600s, approve → 21602 grant; client-side directory publishing (31603 under ECK, blinded d) + roster 31604.
- Attendee views: roster list, person page (kind 0 + directory entry), own grant handling (receive 21602, store ECK, compute blinded d's, decrypt directory).
- **Nostr onboarding (§5.4):** kind-0 fetch-merge-publish on profile edit; kind 10002 defaults; follow button with **kind-3 fetch-merge-append** (never blind overwrite — write a regression test for this); "Your Nostr profile is ready" screen with Primal/Damus/Amethyst/Yakihonne links.
- Public 31925 RSVP opt-in checkbox.

Acceptance:
- Two browsers, full loop: create → join → approve → both see the same roster; a third non-attendee browser sees only the public 31923/31600 and cannot decrypt anything else.
- Follow performed in-app appears in the user's kind 3 on public relays without losing pre-existing follows (seed a follow list first in the test).
- Event created here renders correctly in at least one external NIP-52 client (manual check against Flockstr or Meetstr).

---

### P3 — Media: record, encrypt, upload, reuse  (size: M/L)

Build:
- Recorder page (§10.3): countdown, hard-stop at config limits, preview/re-record; mimeType ladder.
- AES-GCM encrypt → BUD-06 preflight → BUD-02 upload → BUD-04 mirror (event servers + user 10063); media descriptors into 21601 + 31602.
- Playback: fetch → verify sha256 → decrypt → object URL.
- Intro library (§6.2): `a:null` 31602 entry; "reuse at this event" flow (descriptor re-wrap, optional mirror); "fresh copy" option.

Acceptance:
- e2e: attendee records intro → another approved attendee plays it; the raw Blossom URL is verifiably not decodable media (ciphertext).
- Reuse: second event receives the same intro with **no re-upload** (assert no PUT /upload network call); fresh-copy produces a different blob hash.
- Oversized/unsupported uploads fail cleanly at preflight with a user-readable message.

---

### P4 — Coordinator v1: pipeline + AI matchmaking  (size: L)

Build:
- Daemon skeleton: config load (`coordinator.toml`, §9.5), identity, relay subscriptions with `since = now−3d` + rumor dedupe, SQLite store + migrations, job runner (idempotent stages, dedupe keys, backoff, poison state).
- Install handling (21603), admin commands (21604: recompute/reprocess/revoke).
- Pipeline stages (§9.2) incl. ffmpeg audio extraction (mono 16 kHz opus targeting the provider's byte limit; segmentation for long talks).
- Provider layer (§9.4): `types.ts`, `VeniceStt`, `VeniceLlm` (runtime `GET /models`, json_schema strict, embeddings), `ApiKeyPayment`, mock providers for tests. `LocalWhisperStt` optional (behind config).
- **Nostr-context stage:** fetch kind 0 + last N events (kinds 1, 6, 30023; resolve kind-6 reposts to target notes; N from 31600 `nostr_context`), summarize with `summaryModel`, cache by inputs-hash.
- Matching (§9.3): pair scoring with complementarity-aware prompt, incremental N−1 pairs, embeddings prefilter + random slice above threshold, 31605 per-recipient lists (top-K), optional 31606 matrix.
- Invite auto-approval (entitlement checker interface + `invite` checker + first-come usage tracking).
- Frontend: matches page (ranked list + reasoning), ai_profile display on person page, coordinator-attach UI in admin (writes 31600 tag + sends 21603).

Acceptance (run against dockerized strfry + blossom-server + mock providers):
- 3 seeded attendees with distinct fixture transcripts each receive a ranked 31605 with reasoning mentioning complementary skills.
- 4th joiner triggers exactly 3 new pair jobs (assert on the jobs table).
- Kill the daemon mid-pipeline, restart: no duplicate STT/LLM calls (assert mock call counts), pipeline completes.
- Attendee with seeded kind-1/kind-6 history gets a nostr-context summary that visibly influences the ai_profile fixture output; attendee with `nostr_context=0` event config gets none.
- One real-Venice smoke test (manual, small): video → transcript → profile → match.

---

### P5 — Invites + social layer + i18n  (size: M)

Build:
- Invite generation UI (31601 publish, link/QR export with code in fragment), join-with-code path, coordinator auto-approval e2e; reused-code fallback to manual queue.
- Social overlay: kind-3 ∩ roster badges ("you follow", "follows you"); person page recent kind-1 posts (NIP-21 mentions, imeta images, link previews).
- Favorites / want-to-meet / met / notes (30078 per-event, §7.3) + sorting the roster by matches | follows | name.
- Paraglide i18n, `en` + `sk`.

Acceptance:
- Invite link on a fresh browser: zero organizer interaction → approved, directory visible.
- Same code second time → lands in manual queue.
- Follow badges match ground truth for a seeded follow graph; posts render for a seeded author.

---

### P6 — Hardening + release  (size: M)

Build:
- Playwright e2e suite covering P2/P3/P5 happy paths + revocation, in CI against docker compose.
- ECK rotation full flow (revoke via 21604 and client-side path): re-grants, roster/directory republish.
- `RoutstrLlm` + `CashuPayment` adapters behind config flag (chat/matching only; STT remains Venice/local — spec §9.4); manual smoke against a live Routstr node.
- Error/empty/offline states pass; Lighthouse PWA audit passes; bundle-size budget.
- Threat-model doc finalized from spec §14; README; license (FOSS).

Acceptance:
- e2e green in CI.
- Rotation demo: removed attendee's client cannot decrypt any post-rotation content (test with captured relay traffic).
- Routstr flag on: a match computation completes paid by a Cashu token, change persisted (assert wallet balance).

---

## 2. Testing strategy (cross-phase)

- **Unit (vitest):** all of `protocol` — this is where correctness lives; crypto negative tests (wrong key, tampered ciphertext, replayed invite proof against a different attendee pubkey).
- **Integration:** docker compose `strfry` (relay) + `blossom-server`; `nak` CLI for fixture event publishing; coordinator with mock providers (the provider interfaces make mocks first-class).
- **e2e (Playwright):** multi-context browsers for organizer/attendee/outsider roles.
- **CI (GitHub Actions):** lint → typecheck → unit → integration → e2e → build → `nsyte deploy` on tags.

## 3. Gotchas for the implementer (hard-won, don't rediscover)

1. **NDK NIP-07 signer defaults to NIP-04** — pass `'nip44'` explicitly on every encrypt/decrypt. NIP-04 is lint-banned.
2. **kind-3 blind overwrite wipes follow lists.** Always fetch-merge-append. Regression-test it (P2).
3. **kind-0 overwrite:** fetch-merge, preserve unknown JSON fields (P2, §5.4).
4. **Gift-wrap timestamps are randomized up to 2 days into the past** — subscriptions need `since = now − 3d` and rumor-id dedupe, or you will "lose" wraps.
5. **NIP-46:** verify `connect` response secret; remote-signer pubkey ≠ user pubkey; call `get_public_key` after connect (Amber v6 per-connection keys).
6. **nsite serves the SPA fallback with HTTP status 404** — hash routing only; never rely on history-API paths or per-file headers (fixed `max-age=3600`; SW update checks bypass HTTP cache, so autoUpdate still works).
7. **Venice STT hard limit 25 MB** — ffmpeg to mono 16 kHz opus first; segment long talks; query `GET /models` at runtime, filter `supportsResponseSchema` for structured output; strict schema needs `additionalProperties:false` + all props required.
8. **AES-GCM whole-file = no streaming/range playback** — acceptable for short intros; don't promise seeking in long talks (chunked scheme is future work).
9. **Relay event-size caps (~64–256 KB)** — that's why directory entries are per-attendee events and the roster is a slim index (§7.3).
10. **Embedding prefilter must keep the random low-similarity slice** — complementarity is what embeddings miss (§9.3).
11. **Paid work must be idempotent** — every coordinator stage keyed by input hash; restart must never re-bill (P4 acceptance).
12. **Invite single-use is eventually consistent** — first-come by rumor `created_at`; duplicates go to the manual queue, never auto-reject.
13. **Blossom uploads:** always BUD-06 preflight (limits vary per server); mirror with BUD-04; auth events are kind 24242 with `t`, `x`, `expiration`.
14. **`#/login?nsec=` must be stripped from the URL/history immediately** after key import.
15. **Custom kinds:** re-check 31600–31609 / 21600–21604 against the NIPs registry before first public release (unassigned as of 2026-07).

## 4. Definition of done (v1)

A stranger can: open an invite link on a phone, register with just a display name, record a 90-second intro, get auto-approved, watch other attendees' intros, read an AI-written explanation of who to meet and why, follow people with one tap — and afterwards paste their key into Primal and find their profile, follows, and feed already alive. The organizer did nothing but create the event, send links, and attach a coordinator. Everything except the coordinator ran as static files served from Nostr itself.

---

## 5. Build status (as implemented)

All phases **P0–P6 are implemented** (monorepo `packages/protocol`, `packages/app`, `packages/coordinator`, `e2e/`). Unit tests pass across packages (protocol + coordinator + app). A live reference deployment runs at `https://cypherpunk.today/nostrautica/` with a Venice-backed coordinator. See SPECIFICATION.md §16 for as-built protocol/architecture notes; the key deltas from this plan:

- **Coordinator store:** `node:sqlite` (built-in, Node ≥ 22.5) instead of `better-sqlite3` — avoids a native build; CI/Docker pin Node 24.
- **Providers verified live (Venice):** STT `openai/whisper-large-v3`; summary `olafangensan-glm-4.7-flash-heretic`; match `zai-org-glm-5-2`; embed `text-embedding-bge-m3` (all private-tier). Reasoning models require `venice_parameters.disable_thinking` + suppressing Venice's system prompt, and pair scores are clamped to [0,1].
- **Matching:** directional per-recipient reasoning (`reasoning_for_a`/`reasoning_for_b`).
- **Co-organizers (multi-admin):** `21605` organizer grant (full key custody); manual approval routed through the coordinator via `21604 approve`.
- **PWA:** automatic reload on new deploy (no prompt); relay-publish resilience (partial-success + benign-error guard); NIP-46 (Amber) session persistence.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'` — tseep (NDK's emitter) is `pnpm patch`ed to its eval-free variant so no `'unsafe-eval'` is needed.
- **UX added beyond the plan:** event icon+banner images, `EventHeader`, bottom navigation, "My events" (backfilled from the local key store), smart Back button, event-context cache for instant navigation, shared sign-in component, kind-0 write policy (publish only for self-generated keys; existing users read-only).

### Remaining / manual-verification items
- Playwright e2e specs are scaffolded (`e2e/`); the full-loop specs run against the dockerized relay + Blossom (`docker/docker-compose.yml`) and are gated behind `NOSTRAUTICA_E2E_RELAY`.
- nsite deploy (`nsyte`) is wired in CI but the primary reference deploy currently targets a classic static host (nginx). On that host `sw.js` is served with a long `max-age`; PWA updates still work because the SW update check bypasses the HTTP cache, but serving `sw.js`/`index.html` as `no-cache` (spec §10.2) is preferred.
- Custom kinds (`31600–31609`, `21600–21605`) remain to be re-checked against the NIPs registry before public release.
