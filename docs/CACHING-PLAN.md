# Caching-first plan: every relay read paints from cache, refreshes progressively

Status: implementation plan (2026-07-17). Goal: **no page ever waits on a relay
round-trip for data the app has already seen or could have prefetched.** Every
fetch follows stale-while-revalidate (SWR): paint from a persistent cache
instantly, refresh from relays in the background, update the UI reactively.
Pre-decrypt whenever the key material is already in local custody.

## 0. What exists today (audit result)

Layers already in place:

| Layer | Where | Survives reload? |
|---|---|---|
| NDK Dexie cache (raw events) | `lib/nostr/ndk.ts` (`nostrautica-cache` IDB) | yes, but `fetchEvents` still *awaits relay EOSE* before resolving — cached events don't make pages fast |
| Event keystore (ECK/E_id/E_inbox, role) | `lib/events/keystore.ts` (IDB, owner-scoped) | yes |
| In-memory session caches | `contextCache` (event-context), `profileCache` (social), `directoryCache` (attendee), `postCache` (posts), DM `unwrapCache` (dm.ts), blindseed memo | **no — lost on every reload** |
| localStorage | recent-events, join-sent, grants-backfilled marker, talk watch progress, dismissed statuses, install hints | yes |
| Prefetch warmers | `lib/nostr/prefetch.ts` (ctx, org profiles, landing, attendees tab, grants, recovery) | fills in-memory + dexie only |
| Marmot MLS state | `lib/chat/stores.ts` (IDB, per-identity) | yes |

The structural problem: the *decrypted/derived* view models (directory entries,
posts, matches, talks, event page, readiness, DM plaintexts, roles) live only in
in-memory Maps. A reload or fresh navigation re-fetches (relay EOSE wait) and
re-decrypts (signer round-trips — a prompt storm on Amber/NIP-46) everything.

## 1. Core infrastructure (new)

### 1.1 `lib/cache/persist.ts` — persistent KV with a synchronous mirror

- IndexedDB database `nostrautica-appcache`, one object store `kv`,
  key = `` `${scope}\x1f${key}` ``, value = `{ at: number, data: unknown }`.
  - `scope` = `"anon"` for public data (event contexts, kind-0 profiles, public
    posts, talks metadata is NOT public — see below, themes, coordinator
    announcements) or the **owner pubkey** for anything decrypted with
    user/event keys (directory, roster, matches, members posts, event-page
    private parts, DMs, settings, follows, mutes, self-copy, pending queues,
    readiness, roles).
- In-memory `Map` mirror. API (all owner-resolution mirrors `keystore.ts`'s
  `setActiveOwner` pattern — reuse the session hook):
  - `hydrateAppCache(): Promise<void>` — one `getAll()` at boot; bounded:
    resolve after 1500 ms even if IDB is slow/broken (mirror stays empty, app
    works as before).
  - `cacheGet<T>(key, scope?): { at, data } | undefined` — **synchronous** mirror read.
  - `cacheSet(key, data, at?, scope?)` — mirror write + fire-and-forget IDB put.
    Only overwrite if `at >= stored.at` (latest-wins, matching Nostr replaceable
    semantics).
  - `cacheDelete(key, scope?)`, `clearOwnerCache(owner)` (called on logout),
    `pruneCache()` (drop entries older than 30 days; cap DM message stores).
- Call `hydrateAppCache()` in `+layout.svelte onMount` **before** `booted = true`
  (alongside `session.restore()`), so every page's `cachedX()` helper is warm on
  first render.

Privacy note (document in the module header): decrypted event content at rest in
IndexedDB is the same risk class as the ECK / `local-sk` already persisted there
(SPECIFICATION.md §14). DM plaintexts are also persisted owner-scoped and wiped
on logout — same accepted class.

### 1.2 `lib/cache/swr.ts` — one revalidation helper

```ts
swr<T>(key, fetcher, apply, opts?: { scope?, ttlMs? }): Promise<T | undefined>
```
- If mirror has `key`: `apply(cached)` synchronously.
- Dedupe in-flight per key (like prefetch.ts `warm()`); default `ttlMs` 15 s so
  a remount doesn't refetch.
- Run `fetcher()`; on success `cacheSet` + `apply(fresh)`.
- Never throws to the caller for background refreshes; returns the fresh value
  (or cached, or undefined) for await-style callers.

### 1.3 Perf instrumentation (for the measurement phase)

`lib/perf.ts`: `perfMark(page: string, phase: "cache-paint" | "network-settled")`
recording `performance.now()` deltas from route change into
`window.__nostrauticaPerf` (array of `{page, phase, ms, at}`) and a
`console.debug`. Zero UI. Called from each page: once when first meaningful data
is set (cache or network, whichever first), once when the background refresh
settles. The e2e agent reads `window.__nostrauticaPerf`.

## 2. Module-by-module changes

Rule of thumb applied everywhere: **the existing in-memory Map becomes a view
over the persistent cache** — `cachedX()` helpers keep their synchronous
signatures, pages keep their current cache-first code paths, and everything
suddenly survives reloads.

### 2.1 `events/event-context.ts` (every event page's gate)
- `contextCache` → persist (`ctx:<naddr>`, anon). `cachedEventContext` reads the
  mirror; `loadEventContext` write-through (store `at = config event created_at`).
- New `ensureEventContext(naddr, apply)` (SWR): apply cached ctx immediately,
  refresh in background. **Also re-add the event's relays (`addRelays`) from the
  cached config synchronously** so subsequent fetches target the right relays
  without waiting for the 31600 re-fetch.
- Pages that currently `ctx = await loadEventContext(naddr)` switch to: cached
  ctx → render now; `loadEventContext` continues in background and updates
  `ctx`. (EventHome, Attendees, Matches, Posts, Post, Talks, TalkDetail, Admin,
  Attendee, MyProfile, Join, Record, EventChat.)

### 2.2 `events/social.ts` (kind-0 profiles — used by every people surface)
- `profileCache` → persist (`profile:<pubkey>`, anon).
- `fetchProfiles(pubkeys)`: keep signature; internally only hit relays for
  pubkeys **missing or older than 10 min** (per-entry `at`); always return the
  merged map. Add `fetchProfiles(pubkeys, {force?: boolean})` for explicit
  refreshes.
- Persist the **follow set** (kind-3 p-tags) per owner (`follows`), SWR in
  `fetchFollowSet`. NOTE: `followUser`'s fetch-merge-write MUST keep fetching
  fresh from relays before publishing (never merge into a cached copy).

### 2.3 `events/attendee.ts` (roster / directory / matches — the People + Matches pages)
- Persist decrypted roster (`roster:<coordinate>`, owner), directory entries
  (`dir:<coordinate>`, owner), match list (`matches:<coordinate>`, owner).
- `cachedDirectory` / `cachedDirectoryEntry` read the mirror (signatures unchanged).
- `streamDirectory(ctx, onEntries)`:
  1. Synchronously emit cached entries via `onEntries` (page paints instantly).
  2. If a cached roster exists, **don't await `fetchRoster`** — start the
     directory stream with the cached blinded-d list immediately, while a fresh
     roster fetch runs in parallel; when the fresh roster adds/removes d's,
     restart/extend the stream filter.
  3. Write-through decrypted snapshots on each flush (already calls
     `cacheDirectory` — now persistent).
- `fetchMatches`: add `cachedMatches(coordinate)`; persist the decrypted
  `MatchListContent` after `signer.nip44Decrypt`. Matches page paints cached
  list instantly (`loading = false` when cache hit), background-refreshes.
- `receiveGrants`: persist the **wrap-id memo** (`grantwraps`, owner: map of
  wrap id → done) so re-scans skip `signerUnwrap` for wraps already processed —
  this is the #1 Amber/NIP-46 prompt/latency saver. Keep the relay-only fetch
  (must-not-miss semantics untouched).
- `isApproved` already reads only the keystore — fast; unchanged.

### 2.4 `events/posts.ts` + `events/event-page.ts` (EventHome / Posts / Post)
- `postCache` → persist (`posts:<coordinate>` with `event`/`attendees` slots).
  Scope: owner when logged in (31607 decrypted content), anon otherwise; on
  logout the owner copy is wiped, the public copy may be rebuilt lazily —
  simplest correct rule: **always owner-scope when any members post decrypted,
  else anon**; acceptable simplification: owner scope whenever logged in.
- `fetchPostByD`: check the cached post lists for that `d` first, return
  immediately, refresh in background (Post page currently always round-trips).
- `fetchEventPage`: persist merged `EventPageModel` (`page:<coordinate>`, owner —
  it may contain decrypted private menu/sections). Add `cachedEventPage()`.
  EventHome paints menu/sections from cache before network.
- EventHome role gating: read `loadEventKeys` + `isApproved` (both
  IndexedDB-only) **before** awaiting the grants scan; set
  `approved/organizer/roleResolved` from keystore immediately when keys exist,
  then reconcile after `receiveGrants` lands. Never leave `roleResolved` false
  while waiting on the network when local custody already answers it.
- Persist `rosterCount` (`rostercount:<coordinate>`, owner) for the attendees
  section widget.

### 2.5 `events/talks.ts` (Talks / TalkDetail)
- Persist decrypted `TalkItem[]` (`talks:<coordinate>`, owner). Add
  `cachedTalks()` / `cachedTalk(d)`.
- Talks page: paint cached, refresh in background.
- TalkDetail: `cachedTalk(d)` first (today it re-fetches and re-decrypts the
  entire talk set per open); speaker kind-0 via cached `fetchProfiles`.

### 2.6 `events/dm.ts` + Dm/DmChat pages
- Persist the unwrap memo (`dmwraps`, owner: wrap id → `DmMessage | null`) and
  hydrate `unwrapCache` from it — decrypted once, never again, across sessions.
  Cap at ~3000 wrap ids (prune oldest by message `at`).
- `fetchDms`: return the cached snapshot immediately when the relay scan/decrypt
  loop hasn't finished (it already races a deadline — now the racer resolves
  with *history* instead of empty). Track `lastDmScanAt` per owner and pass
  `since = min(giftwrapSince(), lastDmScanAt - 24h)` on steady-state scans
  (keep the full `limit: 500` scan on first run per identity).
- Dm inbox page: `threads` from cached messages before `connectNdk()` even
  resolves; `loading = false` on cache hit. DmChat likewise for the thread.

### 2.7 `events/readiness.svelte.ts` (the EventHome journey widget)
- Persist the last derived `Readiness` + the latch per coordinate
  (`readiness:<coordinate>`, owner). `load()` sets `this.readiness` from cache
  synchronously before its (many) network fetches; keeps the monotonic latch
  across sessions.
- Persist self-copy (`selfcopy:<coordinate>`, owner) inside
  `media/submit.ts#loadSelfCopy` (SWR) and library (`medialib`, owner) in
  `loadLibrary` — also makes the Record composer open instantly.

### 2.8 `events/settings.ts` + `stores/mutes.svelte.ts`
- Persist decrypted `PerEventSettings` (`evsettings:<coordinate>`, owner);
  `loadPerEventSettings` SWR; `toggleSetting`/`setNote` update the cache
  optimistically after publish (they already return the new settings).
- Mutes: persist the muted set (`mutes`, owner); `mutes.load()` paints from
  cache then refreshes. `setMuted` keeps its fetch-merge-write against fresh
  relay state.

### 2.9 `events/blinding.ts`
- Persist the remote-signer blind seed (`blindseed`, owner) — same secret class
  as the keystore (document it). Saves one Amber prompt + relay fetch per
  session for NIP-46/NIP-07 users. Local-key derivation stays computed.

### 2.10 `events/key-backup.ts`
- Persist the confirmed marker per owner (tiny; localStorage or the KV — use the
  KV for consistency).

### 2.11 Admin page (`pages/Admin.svelte` + `events/organizer.ts`, `coordinator-status.ts`, `coordinators.ts`, `updates.ts`)
Admin currently serializes: ctx → keys → `fetchPending` (relay-only giftwrap
scan + N unwraps) → `fetchRoster` → `fetchPendingTalks` (another giftwrap scan +
`fetchTalks`) → `loadUpdates` → liveness → statuses. Make all of it
paint-from-cache + parallel refresh:
- Persist per coordinate (owner scope): decrypted pending queue
  (`pending:<coordinate>`), roster-approved set (via 2.3 roster), pending talks
  (`pendingtalks:<coordinate>`), coordinator statuses
  (`coordstatus:<coordinate>`), `coordLastSeen` (`coordseen:<coordinate>`),
  updates/posts list (2.4 covers it), invite list (`invites:<coordinate>`).
- Persist the E_inbox wrap memo (`inboxwraps:<coordinate>`, owner: wrap id →
  parsed-or-null) — E_inbox unwrapping is raw-key (cheap) but the scans re-parse
  hundreds of wraps per visit; memoizing makes refresh O(new wraps).
- On mount: keys from keystore (fast) → paint pending/roster/talks/statuses/
  updates from cache with a subtle "refreshing…" indicator → run all refreshes
  in `Promise.allSettled` parallel (they're independent), updating each slice as
  it lands. The relay-only semantics of the scans stay (correctness: a stale
  cached queue may briefly show an already-approved request — the roster
  cross-reference already handles exactly that).
- `fetchCoordinators` (kind 31611 picker): SWR (`coordinators`, anon, TTL 1 h).

### 2.12 Event theme (`events/theme.ts` + `theme-injector.ts`)
- Persist theme CSS per coordinate (`theme:<coordinate>`, anon). `syncEventTheme`
  applies cached CSS synchronously on route entry (no unthemed flash), refreshes
  in background.

### 2.13 `stores/event-shell.svelte.ts` (tab gating / compact header)
- Works via `cachedEventContext` → now persistent: gating is instant after
  reload. Additionally persist the resolved role per coordinate
  (`role:<coordinate>`, owner) and seed `this.role` from it before the async
  keystore/grants reconciliation (never flash "Visitor" at an organizer, even on
  a cold boot).

### 2.14 Home page
- Don't block the keystore backfill on the network:
  `listEventKeys()` → backfill list → *then* `recoverEventKeys` + `receiveGrants`
  in the background → backfill again + `enrichEvents()`. (Today a fresh session
  awaits two relay scans before "My events" fills from local custody.)

### 2.15 Prefetch expansion (`lib/nostr/prefetch.ts`)
New warmers (all `warm()`-deduped, silent-signer-guarded exactly like today):
- `prefetchIdentity(signer)` — on login/session-restore (+layout): grants,
  organizer recovery, own kind-0, follow set, mutes, DM relay list, blind seed
  (local only), one DM inbox scan.
- `prefetchEventContent(ctx, signer)` — after approval/grant detected for a
  coordinate, or on EventHome mount for members: directory + profiles + posts +
  attendee posts + event page + talks (if enabled) + matches (silent signer) +
  theme. This is the "joining an event precaches the People tab" ask.
- `prefetchAdmin(ctx, keys)` — on EventHome mount for organizers: pending queue,
  roster, coordinator statuses + liveness, pending talks. Admin then opens
  instantly.
- Keep every warmer non-blocking (fire-and-forget after first paint).

### 2.16 Leave alone (correctness)
- `fetchEventsRelayOnly` usage for grants / pending / statuses / key-package
  verification stays relay-only — caches are a *painting* layer, never a
  substitute for must-not-miss scans.
- `publishOrQueue` offline queue: unchanged.
- Marmot chat: MLS state already persists; do not touch the protocol flows.
  (Optional, only if trivial: persist decoded `ChatMessage[]` per group for
  instant chat history paint — skip if marmot already replays history quickly.)
- PWA versioning/auto-refresh (`pwa.ts`): unchanged and must keep working.

## 3. Cross-cutting rules

1. **Owner scoping**: every cache of decrypted/private data keyed by active
   owner; `session.logout()` calls `clearOwnerCache(owner)` (wire next to
   `setActiveOwner(null)` / `clearBlindingCache()`).
2. **Latest-wins**: store the newest `created_at` seen as `at`; never overwrite
   newer with older (background refreshes racing prefetches are then safe).
3. **No new signer prompts**: cache reads are always prompt-free; background
   refreshes that would decrypt via remote signer keep the existing
   `isSilentSigner` guard.
4. **Loading states**: a page with cached data never shows a spinner — show data
   plus (where it exists) the subtle refresh affordance. Spinners only on true
   cold-cache opens.
5. **Bounds**: DM wraps memo ≤ 3000, posts ≤ 300/coordinate, prune > 30 days on
   `hydrateAppCache` idle callback.

## 4. Testing requirements

- Unit tests: `persist.ts` (in-memory IDB stub or injected backend like
  keystore's), owner scoping + logout wipe, latest-wins, `swr` dedupe/TTL;
  updated tests for attendee/posts/dm cache paths (they already have test files).
- `pnpm check` (lint + typecheck + unit tests across packages) must pass.
- Existing e2e suite (`e2e/tests/*`) must pass against the local tier-2 stack
  (`docker compose -f docker/docker-compose.yml up`).

## 5. Measurement (phase 3, Sonnet)

For each page (Home, EventHome, Attendees, Attendee, Matches, Posts, Post,
Talks, TalkDetail, Admin, Dm, DmChat, EventMore, Record): measure
time-to-full-display cold (empty cache) vs warm (second visit, and after
reload), via `window.__nostrauticaPerf` + Playwright timing. Update screenshots
in docs (UI changed since the last set). Report the numbers and suggest the
next round of improvements.
