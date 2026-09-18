<script lang="ts" module>
  /**
   * `identity:coordinate` pairs that have already spent their one forced,
   * full-history grant sweep this session (see `sweepForPendingGrant`). Module
   * scope on purpose — an instance-level guard resets every time this page
   * mounts, so bouncing between two events would re-run the sweep on each visit.
   */
  const forcedPendingSweep = new Set<string>();
</script>

<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import type { AppSigner } from "$lib/signer/types.js";
  import { loadLoginMethod } from "$lib/signer/keystore.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { loadEventKeys, currentEck, type EventKeys } from "$lib/events/keystore.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { install } from "$lib/stores/install.svelte.js";
  import {
    fetchEventPosts,
    fetchAttendeePosts,
    fetchExternalPosts,
    fetchPostByD,
    cachedEventPosts,
    cachedExternalPosts,
    cachedAttendeePosts,
    type EventPost,
  } from "$lib/events/posts.js";
  import { fetchEventPage, cachedEventPage, resolveTarget, type EventPageModel } from "$lib/events/event-page.js";
  import {
    prefetchAttendeesTab,
    prefetchOrganizerRecovery,
    prefetchEventContent,
    prefetchAdmin,
  } from "$lib/nostr/prefetch.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { perfMark } from "$lib/perf.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import { cachePersistenceDegraded } from "$lib/cache/persist.js";
  import { naddrToCoordinate, parseCoordinate, type MergedSection } from "@nostrautica/protocol";
  import {
    buildOfflinePack,
    cachedOfflinePack,
    packComplete,
    PACK_STEP_KEYS,
    type OfflinePack,
    type PackStep,
  } from "$lib/events/offline-pack.js";
  import { formatBytes } from "$lib/util/bytes.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import LogisticsBlock from "$lib/components/LogisticsBlock.svelte";
  import PostCard from "$lib/components/PostCard.svelte";
  import ReadinessJourney from "$lib/components/ReadinessJourney.svelte";
  import { readinessStore } from "$lib/events/readiness.svelte.js";
  import { ownStatusStore } from "$lib/stores/own-status.svelte.js";
  import { whatsNew } from "$lib/stores/whats-new.svelte.js";
  import { visitorPreview } from "$lib/stores/visitor-preview.svelte.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  // The readiness store is a module singleton and nothing dropped the previous
  // event's answer, so navigating A → B painted A's card on B's page — with A's
  // naddr baked into its primary CTA next to buttons carrying B's, i.e. two
  // different events in one card. Drop it here and re-derive for this event; the
  // render below additionally refuses to show a card belonging to another
  // coordinate, so neither a slow load nor a future caller can reintroduce it.
  if (readinessStore.coordinate !== cachedCtx?.coordinate) readinessStore.reset();
  // Raw thrown value, not a pre-stringified message: ErrorState categorizes it
  // into a plain-language headline and hides the technical text behind a
  // disclosure, which is what every other page in the app already does.
  let error = $state<unknown>(null);
  /** A load pass is in flight (drives the retry button's disabled state). */
  let loadingPage = $state(false);
  /** Backstop for a first load that never returns — mirrors Home's SCAN_GUARD_MS. */
  const LOAD_GUARD_MS = 12_000;
  /** Monotonic pass token so a stalled load can't clobber the retry that replaced it. */
  let loadToken = 0;
  let approved = $state(false);
  let organizer = $state(false);
  let requestPending = $state(false); // join request sent, approval not landed yet (P2)
  // No status badge until the role is actually known — a fresh device briefly
  // resolving grants/keys must not flash "Visitor" at the organizer.
  let roleResolved = $state(false);
  // A NIP-46/Amber session is restored in the BACKGROUND by the layout (audit
  // UX-19: a dead signer relay must not hold up first paint), so this page can
  // mount with `session.signer === null` for a user who is very much logged in —
  // this event's organizer included. Every owner-scoped read then answers "no":
  // no custody, not approved, not an organizer. Concluding anything from that is
  // what showed an organizer "1 of 5 · Join this event" on their own event and
  // filed it under "My events" as a visitor. A persisted login method with no
  // live signer means WAIT — the $effect below re-runs the whole pass when the
  // identity lands.
  let identityPending = $state(false);
  // Customized layout (31608) or the default feed when none is published.
  // Cache-first (§2.4): paint the last-seen custom layout before the network.
  let page = $state<EventPageModel | undefined>(
    cachedCtx ? cachedEventPage(cachedCtx.coordinate) : undefined,
  );
  // Cache-first: returning to the event page paints its feed instantly.
  let eventPosts = $state<EventPost[]>((cachedCtx && cachedEventPosts(cachedCtx.coordinate)) ?? []);
  let attendeePosts = $state<EventPost[]>((cachedCtx && cachedAttendeePosts(cachedCtx.coordinate)) ?? []);
  // Long-form by other npubs the organizer folded into the official feed
  // (31608 `sources`). Treated as part of `eventPosts` everywhere below — the
  // organizer curated them as this event's own channel — and attributed on the
  // card so a reader can still see whose npub wrote each one.
  let externalPosts = $state<EventPost[]>((cachedCtx && cachedExternalPosts(cachedCtx.coordinate)) ?? []);
  /** The official feed as the page shows it: the event's own posts plus curated ones. */
  const officialPosts = $derived([...eventPosts, ...externalPosts]);
  // The body below the header is still fetching — show a skeleton only on a cold
  // open (no cached posts/page to paint).
  // svelte-ignore state_referenced_locally -- intentional one-time seed from cache-painted state
  let bodyLoading = $state(eventPosts.length === 0 && externalPosts.length === 0 && !page);
  let pinnedPosts = $state<Map<string, EventPost>>(new Map());
  // Seed the attendees-section count from the cached roster (§2.4) so the widget
  // paints instantly on revisit rather than after a fresh roster decrypt.
  let rosterCount = $state<number | undefined>(
    cachedCtx ? cachedRoster(cachedCtx.coordinate)?.attendees.length : undefined,
  );
  let installHint = $state(false);
  // "You were approved" banner (spec §13): shown once when approval landed since
  // the last visit (watermark in whats-new), then acknowledged.
  let showApprovedBanner = $state(false);
  function checkApprovalBanner(coordinate: string) {
    if (whatsNew.approvalIsNew(coordinate, true)) {
      showApprovedBanner = true;
      whatsNew.markApprovedSeen(coordinate);
    }
  }
  function dismissApproved() {
    showApprovedBanner = false;
  }
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted values
  if (cachedCtx && (page || eventPosts.length)) perfMark("EventHome", "cache-paint");

  // Cache-paint after background hydration (§7.4.5). Boot no longer blocks on the
  // mirror, so on a cold open the cached snapshots above may be empty; re-read
  // them the moment hydration lands. Guarded to act only while still cold — once
  // ctx is set (here or by the network path) this no-ops.
  $effect(() => {
    void cacheHydration.version;
    // Owner-scoped self-copy hydration can finish after the event context and
    // network readiness pass. Re-read that positive intro evidence even when
    // the rest of the page is already warm.
    readinessStore.refreshFromCache();
    if (ctx) return;
    const c = cachedEventContext(naddr);
    if (!c) return;
    ctx = c;
    page ??= cachedEventPage(c.coordinate);
    if (eventPosts.length === 0) eventPosts = cachedEventPosts(c.coordinate) ?? [];
    if (attendeePosts.length === 0) attendeePosts = cachedAttendeePosts(c.coordinate) ?? [];
    if (externalPosts.length === 0) externalPosts = cachedExternalPosts(c.coordinate) ?? [];
    rosterCount ??= cachedRoster(c.coordinate)?.attendees.length;
    if (page || eventPosts.length || externalPosts.length) {
      bodyLoading = false;
      perfMark("EventHome", "cache-paint");
    }
  });

  const installHintId = "event-page";

  // Pending-approval re-scan (audit UX-9): a join request sent from another
  // device (or this page, then left open) used to show "Pending" until a full
  // reload. While the marker says we're waiting, re-scan grants on a slow
  // interval so an approval lands on its own; cleared on destroy/approval.
  let grantPoll: ReturnType<typeof setInterval> | undefined;
  onDestroy(() => clearInterval(grantPoll));

  /**
   * Re-check the journey's network inputs (directory entry, match list) and the
   * gift-wrap scan that carries the coordinator's own-status notices.
   *
   * On demand and on return to the tab, NOT on a timer. For a NIP-46 identity every
   * one of these steps is a signer round-trip — Amber pops a dialog — so a 20-second
   * background poll would trade "the card is stale" for "the phone asks permission
   * three times a minute". The user-visible cost of a stale card was that people
   * reloaded the page, which re-runs the whole boot path; a button that costs one
   * directory read is strictly cheaper than the thing they were already doing.
   */
  let refreshingReadiness = false;
  async function refreshReadiness(force = false) {
    const c = ctx;
    const signer = session.signer;
    if (!c || !signer || refreshingReadiness) return;
    refreshingReadiness = true;
    try {
      // The 21606 "your pipeline failed / recovered" notices arrive as gift wraps,
      // so without this the journey would re-derive from the same stale statuses.
      //
      // `force` on the BUTTON, never on the visibility path. Pressing "check
      // again" is the user saying the card is wrong, and until 2026-09-17 it
      // went through every latch the ordinary scan does — the backfill marker
      // included — so for the one person it exists for (waiting on a grant this
      // device cannot see) it was a guaranteed no-op that still spun and still
      // reported nothing. Home's Retry button learned this lesson already; this
      // one had not. Coming back to the tab is not the same statement, and a
      // full-history sweep every 60s of tab-flipping is not what that costs.
      await receiveGrants(signer, { force }).catch(() => {});
      await readinessStore.load(c, signer);
    } finally {
      refreshingReadiness = false;
    }
  }

  // Coming back to the tab is the moment a person actually wants a fresh answer,
  // and it is naturally rate-limited by them looking away. Bounded by a floor so
  // flipping between tabs doesn't re-run it on every switch.
  const READINESS_REVISIT_MS = 60_000;
  function onVisible() {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    const at = readinessStore.lastCheckedAt;
    if (at !== undefined && Date.now() - at < READINESS_REVISIT_MS) return;
    if (readinessStore.coordinate !== ctx?.coordinate) return;
    void refreshReadiness();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
    onDestroy(() => document.removeEventListener("visibilitychange", onVisible));
  }

  function startGrantPolling() {
    if (grantPoll) return;
    grantPoll = setInterval(() => {
      void (async () => {
        if (!ctx || !session.signer) return;
        await receiveGrants(session.signer).catch(() => {});
        const nowApproved = await isApproved(ctx.coordinate).catch(() => false);
        if (!nowApproved) return;
        clearInterval(grantPoll);
        grantPoll = undefined;
        approved = true;
        requestPending = false;
        clearJoinSent(ctx.coordinate);
        checkApprovalBanner(ctx.coordinate);
        // The ECK just landed: the public pass ran keyless — re-fetch so
        // members-only page sections and posts decrypt, and warm the tabs.
        const [pageRes, postsRes] = await Promise.allSettled([
          fetchEventPage(ctx),
          fetchEventPosts(ctx),
        ]);
        if (pageRes.status === "fulfilled") page = pageRes.value;
        if (postsRes.status === "fulfilled") eventPosts = postsRes.value;
        prefetchAttendeesTab(ctx, session.signer);
        prefetchEventContent(ctx, session.signer);
        void readinessStore.load(ctx, session.signer);
      })();
    }, 20_000);
  }

  /**
   * Local custody → role → the FIRST readiness paint. No network at all: the
   * keystore read answers the role (§2.4) and readiness derives from that same
   * read plus the owner-scoped self-copy cache. Returns whether an ECK was
   * already held, so the caller knows whether the keyless public-content pass
   * has to be re-run once one lands.
   *
   * Readiness is primed HERE rather than after the grant scan, where it used to
   * live: that scan is a full gift-wrap relay sweep, so the one widget telling
   * the user what to do next was the last thing on the page to appear.
   */
  async function primeFromLocalCustody(c: EventContext, signer: AppSigner | null): Promise<boolean> {
    const keys = await loadEventKeys(c.coordinate);
    // If we already hold keys, resolve approved/organizer immediately so a
    // reload never flashes "Visitor" at a member while the grant scan is in
    // flight. That scan still runs and reconciles (must-not-miss, constraint 1).
    if (keys) {
      approved = !!currentEck(keys);
      organizer = keys.role === "organizer";
      roleResolved = true;
    }
    // `keys === undefined` here means the read SUCCEEDED and this identity holds
    // nothing — the store requires that distinction, so a throw must propagate
    // rather than be flattened into "not a member".
    readinessStore.primeLocal(c, signer, keys, { anonymous: !signer && !identityPending });
    return !!currentEck(keys);
  }

  /**
   * One forced, full-history grant sweep for an event this device is waiting on.
   * Returns whether the approval landed. No-op (returns false) after the first
   * call for this identity+event in this session — see `forcedPendingSweep`.
   */
  async function sweepForPendingGrant(c: EventContext, signer: AppSigner): Promise<boolean> {
    const pubkey = session.pubkey;
    if (!pubkey) return false;
    const key = `${pubkey}:${c.coordinate}`;
    if (forcedPendingSweep.has(key)) return false;
    forcedPendingSweep.add(key);
    await receiveGrants(signer, { force: true }).catch(() => {});
    return await isApproved(c.coordinate).catch(() => false);
  }

  /**
   * The owner-scoped pass: grant scan → custody → role → "My events" → readiness
   * → warmers. Extracted from onMount because it must be able to run a SECOND
   * time — a NIP-46/Amber signer can land after this page mounted (see the
   * $effect below), and every conclusion here is wrong until it does. `grants` is
   * the grant scan to settle first, possibly already in flight.
   */
  async function syncIdentity(
    c: EventContext,
    signer: AppSigner | null,
    grants: Promise<unknown>,
  ): Promise<EventKeys | undefined> {
    await grants;
    approved = await isApproved(c.coordinate);
    // The join-sent marker outlives a reload; approval supersedes it (P2).
    if (approved) {
      clearJoinSent(c.coordinate);
      checkApprovalBanner(c.coordinate);
    }
    else if ((requestPending = joinSentAt(c.coordinate) !== undefined)) {
      // We know exactly what we are waiting for, so ask the relays a question
      // wide enough to contain it — once per identity+event per session.
      //
      // Every other scan on this page trusts the backfill marker and reads only
      // `grantScanSince()`. That is the right default for a background sweep and
      // the wrong one here: "I sent a join request and have no key" is the state
      // in which a grant older than the window is not a remote possibility, it is
      // the single most likely explanation. The 2026-09-17 report was exactly
      // this — the grant sat on the relays two days below that device's floor
      // while the page said "waiting for organizer approval" indefinitely.
      //
      // Once, not per poll: `force` re-reads the whole 1059 history, and the 20s
      // poller running that would be a full paginated sweep three times a minute.
      if (signer && (await sweepForPendingGrant(c, signer))) {
        approved = true;
        requestPending = false;
        clearJoinSent(c.coordinate);
        checkApprovalBanner(c.coordinate);
      } else {
        // Keep watching for the approval while the page stays open (UX-9).
        startGrantPolling();
      }
    }
    const keys = await loadEventKeys(c.coordinate);
    organizer = keys?.role === "organizer";
    roleResolved = true;
    // Remember this event so it shows up under "My events" on Home. Both
    // identity fields come from `c` — NEVER one from `c` and one from the
    // `naddr` prop. Props are live getters into the PARENT's scope
    // (`get naddr() { return route.naddr }`), and destroying this component
    // does not freeze them: if the user navigates to another event while the
    // awaits above are in flight, this line still runs and `naddr` reads the
    // event they moved TO. That recorded {this event's coordinate, that
    // event's naddr} in prod (2026-07-24) — the card then opened the wrong
    // event, and the bad naddr collided with the real owner's, crashing the
    // Chat + Home lists on a duplicate {#each} key. `c` is loaded from one
    // naddr and internally consistent, so it cannot disagree with itself.
    // The role recorded here is only trustworthy once an identity exists, which
    // is why this whole function is gated on that — an organizer's own event was
    // being filed as "visitor" while their signer was still reconnecting.
    recentEvents.reconcile({
      coordinate: c.coordinate,
      naddr: c.naddr,
      title: c.title,
      icon: c.icon,
      role: organizer ? "organizer" : approved ? "attendee" : "visitor",
    });
    if (approved) {
      installHint = install.shouldShow(installHintId);
    }
    // Readiness journey (§4.1): derived from real state, one primary CTA. This
    // refines the local paint above with the network-only steps.
    void readinessStore.load(c, signer, { anonymous: !signer });
    // Background-warm what the user opens next: the Attendees tab (directory
    // decrypt is signer-free), the attendee-posts feed (so Updates opens warm),
    // and — for a local key with no custody record yet — the organizer key
    // recovery. Detached: must not delay first paint.
    if (approved) prefetchAttendeesTab(c, signer);
    // Joining/opening an event precaches the People tab + posts + talks +
    // matches + theme (§2.15) so those tabs open instantly.
    if (approved) prefetchEventContent(c, signer);
    // Organizers: precache the whole Admin surface so it opens without the
    // serial pending→roster→talks→statuses wait (§2.15).
    if (organizer) prefetchAdmin(c, keys ?? undefined);
    void fetchAttendeePosts(c).catch(() => {});
    // Silent (local-key) signers get organizer recovery for free here; a remote
    // signer can't be prompted from a background warmer, so it is offered as an
    // explicit action instead — see `restoreOrganizerKeys` below.
    if (!keys) prefetchOrganizerRecovery(signer);
    return keys;
  }

  /**
   * Bounded wait for a background session restore. Holding out for an identity
   * is right (see `identityPending`) but it cannot be unconditional: a NIP-46
   * signer that never answers — phone locked, Amber not running, dead signer
   * relay — would leave this page permanently undecided, with no badge, no
   * readiness card and no way to join. The layout's restore is capped at roughly
   * two 12 s signer-relay timeouts, so past that nothing is coming and treating
   * the viewer as a visitor is the honest answer. The $effect below still
   * corrects everything if the signer turns up afterwards.
   */
  let identityTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(identityTimer));
  function waitForIdentity(c: EventContext) {
    identityTimer = setTimeout(() => {
      if ((session.signer && session.custodyReady) || !identityPending) return; // the $effect got there first
      // Restore is deliberately detached from first paint and may need a ping,
      // connect fallback, identity check and relay switch. It is still bounded;
      // wait for that bounded operation rather than racing it with a false
      // visitor decision.
      if (session.restoring) {
        waitForIdentity(c);
        return;
      }
      // A signer whose custody unlock failed is not an anonymous viewer. Keep the
      // role unresolved rather than translating a storage/decrypt failure into
      // "visitor"; a later successful login will bump custodyGeneration.
      if (session.signer) return;
      identityPending = false;
      void syncIdentity(c, null, Promise.resolve()).catch(() => {});
    }, 30_000);
  }

  /** Members-only sections/posts couldn't decrypt until the ECK landed — re-fetch. */
  async function refetchAfterEck(c: EventContext) {
    const [pageRes, postsRes] = await Promise.allSettled([fetchEventPage(c), fetchEventPosts(c)]);
    if (pageRes.status === "fulfilled") page = pageRes.value;
    if (postsRes.status === "fulfilled") eventPosts = postsRes.value;
  }

  /**
   * The whole first-paint pass, extracted from onMount so the error state can
   * actually retry it (spec: this is the FIRST screen a newcomer sees after
   * tapping an invite link — "Loading event…" with no way forward is the worst
   * possible first impression, and it was reachable simply by opening the link
   * on venue Wi-Fi that blocks WSS).
   */
  async function loadEventPage() {
    // Token-guarded (same idea as event-shell.svelte.ts): when the 12s guard
    // fires, the ORIGINAL pass is still out there — it was never cancellable, it
    // just stopped being believed. If it later settles it must not re-raise its
    // error over a retry the user has already started, nor clear the retry's
    // in-flight flag. Only the newest pass owns `error` / `loadingPage`.
    const token = ++loadToken;
    loadingPage = true;
    error = null;
    // Backstop for a `loadEventContext` that never settles at all — same shape
    // and budget as Home.svelte's SCAN_GUARD_MS. `loadEventContext` awaits relay
    // reads with no timeout of their own, so a silently-dropped socket parked the
    // page on "Loading event…" indefinitely with no retry and nothing announced.
    // Timeout-shaped message on purpose: `categorizeError` then classifies it as
    // `timeout`, reusing ErrorState's existing vocabulary (see ScanIncompleteError).
    const guard = setTimeout(() => {
      if (ctx || token !== loadToken) return; // header is up, or superseded
      error = new Error("Timed out waiting for this event to load.");
      loadingPage = false;
    }, LOAD_GUARD_MS);
    try {
      await connectNdk();
      // The grant scan doesn't need the event context — run both in parallel.
      const grantsScan = session.signer && session.custodyReady
        ? receiveGrants(session.signer).catch(() => {})
        : Promise.resolve();
      // Neither does "is an identity still on its way?" (see `identityPending`):
      // a persisted login method with no live signer means a background NIP-46
      // restore is running and nothing owner-scoped may be concluded yet.
      const loginPending = session.signer
        ? Promise.resolve(!session.custodyReady)
        : loadLoginMethod().then((m) => !!m).catch(() => false);
      ctx = await loadEventContext(naddr);
      perfMark("EventHome", "cache-paint"); // first meaningful data (ctx) is set
      identityPending = await loginPending;
      // Whether the ECK was already in the keystore BEFORE this visit's fetches:
      // if not (fresh device), the public-content pass below can't decrypt
      // members-only additions and is re-run once the grant scan lands them.
      const hadEck = identityPending ? false : await primeFromLocalCustody(ctx, session.signer);
      // Warm People HERE, not in `syncIdentity`. Holding an ECK is the whole
      // precondition for decrypting the directory, and `primeFromLocalCustody`
      // has just proved it from the local keystore — whereas `syncIdentity`
      // first awaits the grant scan, a full gift-wrap sweep over the inbox
      // relays with its own paging. Gating the warm on that meant the most
      // common flow in the app ("open an event, look at the people") only
      // started fetching the roster seconds after the event page was already on
      // screen and tappable, so a user who tapped Ľudia straight away beat the
      // warm-up to it every time and paid for the roster read themselves.
      // Deliberately after the `cache-paint` mark above: the header is already
      // painted, so this competes with the body's fetches, not with first paint.
      if (hadEck) prefetchAttendeesTab(ctx, session.signer);
      // Public content (custom layout 31608 + official feed) needs no keys and
      // no grant scan — start immediately so the page fills while grants resolve.
      const publicLoad = (async () => {
        const [pageRes, postsRes] = await Promise.allSettled([
          fetchEventPage(ctx!),
          fetchEventPosts(ctx!),
        ]);
        page = pageRes.status === "fulfilled" ? pageRes.value : undefined;
        eventPosts = postsRes.status === "fulfilled" ? postsRes.value : [];
        bodyLoading = false;
      })();
      if (identityPending) waitForIdentity(ctx);
      else await syncIdentity(ctx, session.signer, grantsScan);
      await publicLoad;
      // Fresh device whose ECK arrived during this visit: the public pass ran
      // keyless — re-fetch so members-only page sections and posts decrypt.
      if (approved && !hadEck) await refetchAfterEck(ctx);
      if (page) await loadSectionData(page);
    } catch (e) {
      // Only a failure that left us with NOTHING is a page-level error. Once the
      // header is painted from `ctx`, a later section/post failure must not
      // replace the whole event with an error card.
      if (!ctx && token === loadToken) error = e;
    } finally {
      clearTimeout(guard);
      if (token === loadToken) loadingPage = false;
      bodyLoading = false;
      // Role resolution is set only by successful custody/approval reads above.
      // A keystore failure must not turn the default state into "visitor".
      perfMark("EventHome", "network-settled");
    }
  }

  onMount(loadEventPage);

  // The identity can arrive AFTER this page mounted, and nothing recomputed the
  // page when it did: the only other caller of `readinessStore.load` is the
  // pending-approval poller, which an organizer never starts (they have no
  // join-sent marker). So an Amber organizer who opened their own event during
  // the background session restore stayed a "visitor" — wrong badge, wrong
  // "My events" role, wrong readiness card — for the entire visit, and a reload
  // just raced the same restore again.
  // svelte-ignore state_referenced_locally -- an identity present at mount is onMount's job; this effect covers only a LATER arrival or custody generation
  let identitySynced = `${session.pubkey ?? ""}:${session.custodyGeneration}`;
  $effect(() => {
    const pubkey = session.pubkey;
    const signer = session.signer;
    const custodyReady = session.custodyReady;
    const generation = session.custodyGeneration;
    const c = ctx;
    const identity = `${pubkey ?? ""}:${generation}`;
    if (!c || !pubkey || !signer || !custodyReady || identitySynced === identity) return;
    identitySynced = identity;
    untrack(() => {
      void (async () => {
        identityPending = false;
        try {
          const hadEck = await primeFromLocalCustody(c, signer);
          await syncIdentity(c, signer, receiveGrants(signer).catch(() => {}));
          if (approved && !hadEck) await refetchAfterEck(c);
        } catch {
          /* the page keeps whatever onMount resolved; the badge stays honest */
        } finally {
          roleResolved = true;
        }
      })();
    });
  });

  /**
   * Everything the 31608 declares but doesn't carry: the attendee feed, the
   * roster count, pinned articles, and the external long-form feeds.
   *
   * Takes the whole page model, not just its sections, because `sources` is not
   * a section — the curated feeds fold into the OFFICIAL posts wherever those
   * are shown, including the default layout an event with no sections gets.
   */
  async function loadSectionData(model: EventPageModel) {
    if (!ctx) return;
    const sections = model.sections;
    const jobs: Promise<void>[] = [];
    if (model.sources.length) {
      jobs.push(
        fetchExternalPosts(ctx, model.sources)
          .then((p) => {
            externalPosts = p;
          })
          .catch(() => undefined) as Promise<void>,
      );
    }
    if (sections.some((s) => s.type === "posts" && s.source !== "event")) {
      jobs.push(
        fetchAttendeePosts(ctx).then((p) => {
          attendeePosts = p;
        }),
      );
    }
    if (sections.some((s) => s.type === "attendees") && approved) {
      jobs.push(
        fetchRoster(ctx!)
          .then((r) => {
            rosterCount = r?.attendees.length;
          })
          .catch(() => undefined) as Promise<void>,
      );
    }
    const refs = sections.flatMap((s) => (s.type === "pinned" ? s.refs : []));
    for (const ref of refs) {
      jobs.push(
        resolvePinned(ref).then((post) => {
          if (post) pinnedPosts = new Map(pinnedPosts).set(ref, post);
        }),
      );
    }
    await Promise.allSettled(jobs);
  }

  /** A pinned naddr → this event's post by d (foreign refs are skipped). */
  async function resolvePinned(ref: string): Promise<EventPost | undefined> {
    if (!ctx) return undefined;
    try {
      const { coordinate } = naddrToCoordinate(ref);
      const { pubkey, identifier } = parseCoordinate(coordinate);
      const { pubkey: eid } = parseCoordinate(ctx.coordinate);
      if (pubkey !== eid) return undefined;
      return await fetchPostByD(ctx, identifier);
    } catch {
      return undefined;
    }
  }

  // A post's stable identity on this page (used to dedupe across widgets).
  const postKey = (p: EventPost) => `${p.source}:${p.authorPubkey}:${p.d}`;
  // Posts already surfaced in the "Latest" highlight or a pinned section must
  // not appear a second time in the feed below (user feedback 2026-07-17: the
  // "Secret article" showed twice).
  const featuredKeys = $derived.by(() => {
    const s = new Set<string>();
    if (latestPost) s.add(postKey(latestPost));
    for (const p of pinnedPosts.values()) s.add(postKey(p));
    return s;
  });

  /**
   * Does this post expand INLINE in a home feed, or render as a teaser with a
   * "read" link?
   *
   * Only the event's own posts expand. An event update is an announcement —
   * "schedule posted", "venue change" — and reading it inline is the whole
   * point of the home page. A post curated in from another npub (31608
   * `sources`) is a blog article someone wrote for their own feed, routinely
   * thousands of words, and expanding it turns the event home into an endless
   * scroll of one article (prod feedback 2026-08-29). Attendee posts were
   * already teasers for the same reason; external ones simply join them.
   */
  const expandsInFeed = (p: EventPost) => p.source === "event";

  /** Posts for a `posts` section, filtered by its source × visibility config. */
  function sectionPosts(section: Extract<MergedSection, { type: "posts" }>): EventPost[] {
    let list: EventPost[] = [];
    if (section.source !== "attendees") list = list.concat(officialPosts);
    if (section.source !== "event") list = list.concat(attendeePosts);
    if (section.visibility === "public") list = list.filter((p) => !p.membersOnly);
    if (section.visibility === "members") list = list.filter((p) => p.membersOnly);
    return list
      .filter((p) => !featuredKeys.has(postKey(p)))
      .sort((a, b) => b.publishedAt - a.publishedAt);
  }

  function openMenuTarget(target: string) {
    if (!ctx) return;
    const resolved = resolveTarget(ctx, target);
    if (!resolved) return;
    if (resolved.type === "post") router.go({ name: "post", naddr, d: resolved.d });
    // `noreferrer` as well as `noopener`: these hrefs come from the organizer's own
    // 31608 page model, so the destination is chosen by someone other than us, and
    // there is no reason to hand it the URL of the event page the reader was on.
    else if (resolved.type === "url") window.open(resolved.href, "_blank", "noopener,noreferrer");
    else window.open(`https://njump.me/${resolved.naddr}`, "_blank", "noopener,noreferrer");
  }

  async function promptInstall() {
    const accepted = await install.promptInstall().catch(() => false);
    if (accepted) installHint = false;
  }

  function dismissInstall() {
    install.dismiss(installHintId);
    installHint = false;
  }

  // Badge only when it tells the user something actionable: "pending" (waiting
  // for approval) or "visitor" (not a member — join). Once approved it should
  // just work — no badge (user feedback 2026-07-16). Nothing renders until the
  // role is actually resolved, so an organizer on a fresh device never sees a
  // "Visitor" flash while grants/keys recover.
  const overviewStatus = $derived.by(() => {
    if (!roleResolved || organizer || approved) return undefined;
    if (requestPending)
      return { labelKey: "event.status.pending" as const, tone: "warn" as const };
    return { labelKey: "event.status.visitor" as const, tone: "neutral" as const };
  });

  const latestPost = $derived(
    [...officialPosts].sort((a, b) => b.publishedAt - a.publishedAt)[0],
  );

  // The event has ended: its end time is in the past (spec §13 — the report
  // becomes prominent, though it's reachable anytime).
  const eventEnded = $derived(!!ctx?.end && ctx.end * 1000 < Date.now());

  // "View as visitor" (spec §13): an organizer previewing the public view. While
  // active, every member/organizer surface below is suppressed to the effective
  // (visitor) role, so they see exactly what a non-member sees.
  const previewing = $derived(!!ctx && visitorPreview.isActive(ctx.coordinate));
  const effApproved = $derived(approved && !previewing);
  const effOrganizer = $derived(organizer && !previewing);
  function toggleVisitorPreview() {
    if (ctx) visitorPreview.toggle(ctx.coordinate);
  }

  // Fresh device / cleared storage, remote signer: the event's keys have a
  // durable self-encrypted 30078 backup on relays (events/recover.ts), but the
  // only caller of it on this page was `prefetchOrganizerRecovery` — a
  // deliberate no-op for nip07/nip46, because decrypting the backup needs a
  // signer round-trip and a background warmer must never pop an unprompted Amber
  // dialog (prefetch.ts HARD CONSTRAINT 2). So an Amber organizer opening their
  // own event on a wiped device was never even OFFERED recovery: they got "Join
  // this event" and were pushed at the co-organizer flow for keys they already
  // own. A prompt is fine when the USER asks for it, so this is a button rather
  // than an automatic attempt.
  let recovering = $state(false);
  let recoverResult = $state<"idle" | "restored" | "empty" | "failed">("idle");
  const canRecoverKeys = $derived(
    !!ctx &&
      !!session.signer &&
      roleResolved &&
      !identityPending &&
      !organizer &&
      !approved &&
      !previewing,
  );
  async function restoreOrganizerKeys() {
    if (!ctx || !session.signer || recovering) return;
    const c = ctx;
    const signer = session.signer;
    recovering = true;
    recoverResult = "idle";
    try {
      // `force` skips recover.ts's once-per-session guard: the user explicitly
      // asked, and a silent warmer may already have spent the guard on a pass
      // that couldn't decrypt anything.
      const restored = await recoverEventKeys(signer, { force: true });
      // Re-derive the role from the REAL keystore, never from "recovery said it
      // worked" — the admin surface stays gated on custody (`organizer`), which
      // syncIdentity sets from its own `loadEventKeys` read.
      await syncIdentity(c, signer, Promise.resolve());
      recoverResult = restored.includes(c.coordinate) && organizer ? "restored" : "empty";
    } catch {
      recoverResult = "failed";
    } finally {
      recovering = false;
    }
  }

  async function duplicateEvent() {
    if (!ctx) return;
    const { buildDuplicatePrefill } = await import("$lib/events/duplicate.js");
    const { setDuplicateDraft } = await import("$lib/stores/duplicate-draft.js");
    setDuplicateDraft(
      buildDuplicatePrefill({
        title: ctx.title,
        summary: ctx.summary,
        icon: ctx.icon,
        config: ctx.config,
        copyPrefix: (title) => t("event.duplicate.copyOf", { title }),
      }),
    );
    router.go({ name: "create" });
  }

  // Offline event pack (spec §13): one-tap pre-download of roster/directory/
  // matches/talks/profiles + a persistent-storage request, so the app works at a
  // venue with no signal. Everything rides the existing cache layer.
  let offlinePack = $state<OfflinePack | undefined>(
    cachedCtx ? cachedOfflinePack(cachedCtx.coordinate) : undefined,
  );
  let packing = $state(false);
  let packSteps = $state<PackStep[]>([]);
  let packPersisted = $state<boolean | null>(null);
  const packDone = $derived(offlinePack ? packComplete(offlinePack) : false);
  /**
   * Persistence is failing for lack of space. Re-read on every cache-hydration
   * bump, which is the only thing that moves during a visit — the flag is set by a
   * refused write, and a write happens on essentially every fetch this page makes.
   */
  const storageFull = $derived.by(() => {
    void cacheHydration.version;
    return cachePersistenceDegraded();
  });
  // What THIS pack added, not the browser's origin-wide (on Firefox: whole
  // eTLD+1 group) usage figure this line used to show. Omitted below 100 KB so a
  // re-download that changed nothing doesn't claim a footprint it didn't add.
  const packAdded = $derived(
    offlinePack?.bytesAdded !== undefined && offlinePack.bytesAdded >= 100_000
      ? formatBytes(offlinePack.bytesAdded)
      : null,
  );
  // Joined here rather than in the markup so a missing leading clause can't
  // leave the line starting with a stray separator.
  const packNotes = $derived(
    [
      packAdded ? t("event.offline.stored", { size: packAdded }) : null,
      packPersisted ? t("event.offline.persisted") : null,
      packDone ? t("event.offline.routesReady") : null,
      packDone ? t("event.offline.mediaNote") : null,
    ]
      .filter((s) => s !== null)
      .join(" · "),
  );

  async function downloadPack() {
    if (!ctx || packing) return;
    packing = true;
    packSteps = [];
    try {
      const res = await buildOfflinePack(ctx, session.signer, (steps) => (packSteps = steps));
      offlinePack = res.pack;
      packPersisted = res.persisted;
    } catch {
      /* partial packs are recorded per-step; nothing more to surface here */
    } finally {
      packing = false;
    }
  }

  // Own coordinator-status notices (21606 sealed to this attendee, NIP §6.3):
  // a poison in the attendee's own submission/talk pipeline surfaces as a modest
  // banner, seeded from cache and kept live by the grant scan.
  const ownPoison = $derived(ctx ? ownStatusStore.poison(ctx.coordinate) : []);

  // Declared data retention (NIP §6.2): one localized line at the bottom of a
  // member's event view. `retentionDays` is absent for indefinite retention.
  const retentionDays = $derived(ctx?.config.retentionDays);

  // "Leave event" (NIP §6.3 21610) — enrolled attendees only (organizers manage
  // the event, not leave it). A confirm dialog guards the destructive action.
  let leaving = $state(false);
  let confirmingLeave = $state(false);
  let leftMessage = $state<string | null>(null);
  // Withdrawal is a *request* to the coordinator, not an instant local removal
  // (audit U3): the 21610 either went to a relay ("sent") or is only in the
  // durable outbox ("queued"). Either way directory removal / key rotation / data
  // deletion happen coordinator-side and are NOT yet acknowledged, so the member
  // UI stays as-is and we show an honest pending state rather than "you've left".
  let withdrawState = $state<"none" | "sent" | "queued">("none");
  async function doLeave() {
    if (!session.signer || !ctx) return;
    leaving = true;
    leftMessage = null;
    try {
      const { withdrawFromEvent } = await import("$lib/events/withdraw.js");
      const res = await withdrawFromEvent(session.signer, ctx);
      withdrawState = res.sent ? "sent" : "queued";
      confirmingLeave = false;
    } catch {
      leftMessage = t("event.leave.failed");
    } finally {
      leaving = false;
    }
  }
</script>

{#if error && !ctx}
  <!-- role="alert" + a working retry, via the shared surface (ErrorState). The
       old card was a bare `class="warn"` div with the raw error text in it: not
       announced, not categorized, and with no way to try again short of a manual
       reload the newcomer has no reason to think of. -->
  <ErrorState {error} body="event.loadFailed.body" onRetry={loadEventPage} retrying={loadingPage} />
{:else if !ctx}
  <p class="muted" role="status" aria-live="polite">{t("event.loading")}</p>
{:else}
  <EventHeader {ctx} status={overviewStatus} />

  {#if showApprovedBanner}
    <!-- "You were approved" (spec §13): one line, shown once, dismissible. -->
    <div class="card ok approved-banner" role="status">
      <span><Icon name="check" size={16} /> {t("event.approvedBanner")}</span>
      <button class="btn inline ghost" onclick={dismissApproved} aria-label={t("event.approvedBanner.dismiss")}>✕</button>
    </div>
  {/if}

  {#if ctx.summary}<p class="summary">{ctx.summary}</p>{/if}

  <!-- Full logistics (§7.4.9): start/end + time zone, happening-now state,
       add-to-calendar (.ics), directions. -->
  <LogisticsBlock {ctx} />

  <!-- Own-pipeline failure notices (21606 → attendee, NIP §6.3): modest, per stage. -->
  {#each ownPoison as st (st.stage)}
    <!-- The stage decides the sentence. A chat-device refusal ("chat_attestation")
         used to fall through to "your profile couldn't be processed", which sent
         the reader to re-submit a profile that was never the problem — the whole
         explanation lives on the Chat page, which is where this points them. -->
    <div class="card warn" role="status">
      <strong>{t("event.ownStatus.title")}</strong>
      <span class="muted"
        >{st.stage === "process_talk"
          ? t("event.ownStatus.talk")
          : st.stage === "chat_attestation"
            ? t("event.ownStatus.chat")
            : t("event.ownStatus.submission")}</span
      >
    </div>
  {/each}

  <!-- One unified event menu (user feedback 2026-07-16: admin was up top, other
       links stranded at the bottom): organizer admin + custom 31608 items +
       the posts archive, as one prominent grid. -->
  {#if previewing}
    <!-- Exit bar for the visitor preview (spec §13). -->
    <div class="card visitor-preview-bar" role="status">
      <span>{t("event.viewAsVisitor.active")}</span>
      <button class="btn inline primary" onclick={toggleVisitorPreview}>{t("event.viewAsVisitor.exit")}</button>
    </div>
  {/if}

  <nav class="menu-grid" data-event-menu>
    {#if effOrganizer}
      <button class="btn menu-btn" onclick={() => router.go({ name: "admin", naddr })}>
        <Icon name="sliders" size={17} />{t("event.organizerAdmin")}
      </button>
    {/if}
    {#if page}
      {#each page.menu as item, i (i)}
        {#if !(previewing && item.membersOnly)}
          <button class="btn menu-btn" onclick={() => openMenuTarget(item.target)}>
            {item.label}{#if item.membersOnly}&nbsp;<Icon name="lock" size={15} />{/if}
          </button>
        {/if}
      {/each}
    {/if}
    <button class="btn menu-btn" onclick={() => router.go({ name: "posts", naddr })}>
      <Icon name="horn" size={17} />{t("event.allPosts")}
    </button>
    {#if organizer && !previewing}
      <!-- Enter the visitor preview (organizers only). -->
      <button class="btn menu-btn" onclick={toggleVisitorPreview}>
        <Icon name="person" size={17} />{t("event.viewAsVisitor")}
      </button>
      <!-- Duplicate this event's config into a fresh event (organizers only). -->
      <button class="btn menu-btn" onclick={duplicateEvent}>
        <Icon name="copy" size={17} />{t("event.duplicate")}
      </button>
    {/if}
    {#if effApproved}
      <!-- Post-event report (spec §13): available anytime, emphasized once ended. -->
      <button
        class="btn menu-btn"
        class:primary={eventEnded}
        onclick={() => router.go({ name: "report", naddr })}
      >
        <Icon name="pennant" size={17} />{t("event.report")}
      </button>
    {/if}
  </nav>

  <!-- Readiness journey (§4.1): one honest next action, derived from real state.
       Visitors see the Join CTA as step 1; approved members see intro/matches.
       The coordinate check is load-bearing, not defensive tidiness: the store is
       a module singleton, so without it a card derived for the PREVIOUS event
       renders here, CTA and all. -->
  {#if readinessStore.readiness && readinessStore.coordinate === ctx.coordinate && !previewing}
    <ReadinessJourney
      readiness={readinessStore.readiness}
      {naddr}
      lastCheckedAt={readinessStore.lastCheckedAt}
      onRefresh={session.signer ? () => void refreshReadiness(true) : undefined}
      refreshing={readinessStore.loading}
    />
  {/if}

  {#if recoverResult === "restored"}
    <p class="muted" role="status">{t("event.recoverKeys.restored")}</p>
  {:else if canRecoverKeys}
    <!-- This account may already OWN this event and just not have the keys on
         this device. Recovery is one signer prompt away, and offering it beats
         sending an organizer through the co-organizer invite flow for keys they
         already have a relay backup of. -->
    <div class="card recover-keys">
      <strong>{t("event.recoverKeys.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0.5rem">{t("event.recoverKeys.body")}</p>
      <button class="btn inline" disabled={recovering} onclick={restoreOrganizerKeys}>
        {recovering ? t("event.recoverKeys.working") : t("event.recoverKeys.action")}
      </button>
      {#if recoverResult !== "idle"}
        <p class="muted" role="status" style="margin:0.5rem 0 0">
          {recoverResult === "empty"
            ? t("event.recoverKeys.empty")
            : t("event.recoverKeys.failed")}
        </p>
      {/if}
    </div>
  {/if}

  {#if effApproved}
    <!-- Offline event pack (spec §13): pre-download + persistent storage. -->
    <div class="card offline">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:0.5rem;flex-wrap:wrap">
        <div style="min-width:0">
          <strong>{t("event.offline.title")}</strong>
          <p class="muted" style="margin:0.2rem 0 0;font-size:0.85rem">
            {#if packing}
              {t("event.offline.downloading", {
                n: Math.min(packSteps.length, PACK_STEP_KEYS.length),
                total: PACK_STEP_KEYS.length,
              })}
            {:else if packDone}
              {t("event.offline.ready")}
            {:else if offlinePack && offlinePack.swControlled === false}
              <!-- R7: data cached but no controlling SW, so the app SCREENS aren't
                   cached — be honest that this won't cold-launch offline yet. -->
              {t("event.offline.noSw")}
            {:else if offlinePack}
              {t("event.offline.partial")}
            {:else}
              {t("event.offline.body")}
            {/if}
          </p>
        </div>
        <button class="btn inline" disabled={packing} onclick={downloadPack}>
          {#if packing}{t("event.offline.downloadingShort")}
          {:else if offlinePack}{t("event.offline.refresh")}
          {:else}{t("event.offline.download")}{/if}
        </button>
      </div>
      {#if packNotes}
        <p class="muted" role="status" aria-live="polite" style="margin:0.4rem 0 0;font-size:0.78rem">
          {packNotes}
        </p>
      {/if}
      {#if storageFull}
        <!-- INFRA-12: the browser refused a write for lack of space. The in-memory
             mirror still answers reads, so nothing looks broken THIS session — the
             next boot is simply cold, every morning, with no signal anywhere. This
             card is where a user is already thinking about local storage, so it is
             where the one sentence belongs. -->
        <p class="muted" role="status" style="margin:0.4rem 0 0;font-size:0.78rem">
          {t("event.offline.storageFull")}
        </p>
      {/if}
    </div>
  {/if}

  {#if latestPost}
    <!-- "Latest" highlight — newest update, links through to the Updates tab. -->
    <p class="kicker">{t("event.latest")}</p>
    <PostCard post={latestPost} {naddr} full={expandsInFeed(latestPost)} />
  {/if}

  {#if effApproved && installHint}
    <!-- One-time, dismissable install hint (UI-SUGGESTIONS #24). Never shown in
         standalone mode; Chrome/Android gets the real prompt, iOS instructions. -->
    <div class="card">
      <strong>{t("event.install.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0.5rem">
        {t("event.install.body")}
      </p>
      {#if install.canPrompt}
        <div class="row">
          <button class="btn inline primary" onclick={promptInstall}>{t("event.install.install")}</button>
          <button class="btn inline" onclick={dismissInstall}>{t("event.install.notNow")}</button>
        </div>
      {:else}
        <p class="muted" style="margin:0 0 0.5rem">
          {t("event.install.iosHint")}
        </p>
        <button class="btn inline" onclick={dismissInstall}>{t("event.install.gotIt")}</button>
      {/if}
    </div>
  {/if}

  {#if bodyLoading}
    <!-- The feed/layout is still fetching — visible progress, never a void
         (user feedback 2026-07-16: the page "looked empty" on a slow relay). -->
    <div class="card skeleton" aria-label={t("event.loading")}>
      <div class="sk-line" style="width:38%"></div>
      <div class="sk-line" style="width:92%"></div>
      <div class="sk-line" style="width:71%"></div>
    </div>
  {/if}

  {#if page && page.sections.length}
    <!-- Custom layout (31608): sections compose the home below the header.
         Gated on SECTIONS, not on the 31608 existing: a page can now be
         published carrying only a menu or only external feeds, and treating
         that as "custom layout" would render a header above nothing at all
         instead of the default feed the organizer never chose to replace. -->
    {#each page.sections as section, i (i)}
      {#if section.type === "posts"}
        {@const list = sectionPosts(section)}
        {#if list.length}
          <h2>{t("event.posts")}</h2>
          {#each list as post (post.source + post.authorPubkey + post.d)}
            <PostCard {post} {naddr} full={expandsInFeed(post)} />
          {/each}
        {/if}
      {:else if section.type === "pinned"}
        {@const pins = section.refs
          .map((ref) => pinnedPosts.get(ref))
          .filter((p): p is EventPost => p !== undefined)}
        {#if pins.length}
          <h2 class="pinned-head"><Icon name="pennant" size={18} /> {t("event.pinned")}</h2>
          {#each pins as post (post.d)}
            <PostCard {post} {naddr} full />
          {/each}
        {/if}
      {:else if section.type === "attendees" && effApproved}
        <!-- Roster preview — renders only for members (spec §7.4). -->
        <div class="card">
          <strong>{t("event.attendeesSection")}</strong>
          {#if rosterCount !== undefined}
            <p class="muted" style="margin:0.25rem 0 0.5rem">
              {tp("event.attendeesSection.count", rosterCount)}
            </p>
          {/if}
          <button class="btn inline" onclick={() => router.go({ name: "attendees", naddr })}>
            {t("event.seeWhosHere")}
          </button>
        </div>
      {/if}
    {/each}
  {:else if officialPosts.length}
    {@const rest = officialPosts
      .filter((p) => !featuredKeys.has(postKey(p)))
      .sort((a, b) => b.publishedAt - a.publishedAt)}
    {#if rest.length}
      <!-- Default layout (no 31608): the official feed, minus the highlighted post. -->
      <h2>{t("event.updates")}</h2>
      {#each rest as post (post.d)}
        <PostCard {post} {naddr} full={expandsInFeed(post)} />
      {/each}
    {/if}
  {/if}

  <!-- Declared data retention (NIP §6.2): one line, best-effort wording. -->
  {#if retentionDays !== undefined}
    <p class="muted retention-line">{t("event.retention.line", { days: retentionDays })}</p>
  {/if}

  <!-- Leave event (NIP §6.3 21610): enrolled attendees only, confirm-guarded. -->
  {#if effApproved && !effOrganizer}
    <div class="leave-zone">
      {#if withdrawState !== "none"}
        <!-- Pending withdrawal (U3): a request was sent/queued, not completed.
             Removal + data deletion await the coordinator; don't claim they're done. -->
        <p class="muted" role="status">
          {withdrawState === "queued" ? t("event.leave.queued") : t("event.leave.requested")}
        </p>
      {:else if leftMessage}
        <p class="muted" role="status">{leftMessage}</p>
      {:else if confirmingLeave}
        <p class="muted">{t("event.leave.confirm")}</p>
        <div class="row" style="gap:0.5rem">
          <button class="btn danger inline" disabled={leaving} onclick={doLeave}>
            {leaving ? t("event.leave.leaving") : t("event.leave.confirmYes")}
          </button>
          <button class="btn inline" disabled={leaving} onclick={() => (confirmingLeave = false)}>
            {t("event.leave.cancel")}
          </button>
        </div>
      {:else}
        <button class="btn inline subtle" onclick={() => (confirmingLeave = true)}>
          {t("event.leave.action")}
        </button>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .menu-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: 0.65rem 0.9rem;
  }
  .card.skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .sk-line {
    height: 0.85rem;
    border-radius: 0.45rem;
    background: var(--bg-elev2, rgba(128, 128, 128, 0.15));
    animation: sk-pulse 1.2s ease-in-out infinite;
  }
  @keyframes sk-pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk-line {
      animation: none;
    }
  }
  .summary {
    margin: 0.25rem 0 0.75rem;
  }
  .approved-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .approved-banner span {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .visitor-preview-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .kicker {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-dim);
    margin: 1.1rem 0 0.35rem;
  }
  .pinned-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
</style>
