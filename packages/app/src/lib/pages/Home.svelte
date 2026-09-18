<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import AddEventByLink from "$lib/components/AddEventByLink.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { coordinateToNaddr, parseCoordinate, isCommunityCoordinate } from "@nostrautica/protocol";
  import { cachedDirectory } from "$lib/events/attendee.js";
  import { whatsNew } from "$lib/stores/whats-new.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import type { AppSigner } from "$lib/signer/types.js";
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { receiveGrants } from "$lib/events/attendee.js";
  import {
    discoverJoinedSpaces,
    awaitingKey,
    type DiscoveredMembership,
  } from "$lib/events/membership.js";
  import {
    startScanBudget,
    scanFailure,
    unreachableEventCount,
    ScanIncompleteError,
    type ScanOutcome,
  } from "$lib/events/scan-budget.js";
  import { connectivity } from "$lib/stores/connectivity.svelte.js";
  import { defaultEventIcon } from "$lib/media/image.js";
  import { backupNag, markBackedUp } from "$lib/stores/backup-nag.svelte.js";
  import { prefetchEventContext } from "$lib/nostr/prefetch.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext } from "$lib/events/event-context.js";
  import { perfMark } from "$lib/perf.js";
  import { t, tp, tcp } from "$lib/i18n/i18n.svelte.js";

  const events = $derived(recentEvents.list);
  /** Cards showing "waiting for its key" — they need one sentence of context. */
  const anyPendingKey = $derived(events.some((e) => e.pendingKey));

  /**
   * What each card says about itself, from data already on this device.
   *
   * An event card used to carry only a role badge, so an event and a community
   * were indistinguishable in the list. Rather than stamping a "COMMUNITY" label
   * on one of them, each says the thing that is true of it: how many people are
   * in, and what has arrived since the last visit. For a community that second
   * number is the whole reason to come back — it has no date to bring anyone
   * back on its own.
   *
   * Both read caches, never the network: `cachedDirectory` is whatever this
   * device last decrypted and `peopleBadge` is a pure read of the watermark. A
   * card with no cached roster simply says nothing about size, which is honest.
   */
  function cardFacts(coordinate: string): { community: boolean; people?: number; fresh: number } {
    const community = isCommunityCoordinate(coordinate);
    const people = cachedDirectory(coordinate)?.length;
    return { community, people, fresh: whatsNew.peopleBadge(coordinate) };
  }

  // "No events yet" is only the truth once the relay scans have SETTLED. On a
  // fresh browser the keystore is empty and the events arrive from the async
  // recovery/grant scan — showing the empty state before then wrongly tells a
  // returning organizer they have nothing. Until we settle (or the first event
  // lands), show "Loading your events…" instead. `settled` flips when the scan
  // resolves, when there's no signer to scan with, or via a hard timeout so a
  // hung relay can never leave the user spinning forever.
  let settled = $state(false);
  const loadingEvents = $derived(session.loggedIn && events.length === 0 && !settled);

  // Non-null once a scan round came back that we cannot present as the whole
  // truth — the relay read threw, the signer answered nothing, or the scans ran
  // out of budget. It is the difference between "your signer didn't answer,
  // retry" and "you have no events": rendering the latter for the former is
  // exactly how 2026-07-28 got reported as "my events vanished".
  let scanError = $state<unknown>(null);
  let retrying = $state(false);

  /**
   * How many events handed this device a key grant it cannot open, because the
   * event's signed 31600 is unreachable from every relay we know (see
   * ScanOutcome.unreachableEvents). Non-zero is the one state where "No events
   * yet" is not merely unproven but demonstrably false: we are holding the key.
   */
  let keysWaiting = $state(0);

  /** The full-history sweep finished, so "nothing more to find" is now earned. */
  let deepScanDone = $state(false);

  /** Backstop for a scan round that never comes back at all. */
  const SCAN_GUARD_MS = 12_000;

  const roleLabel = {
    organizer: "home.role.organizer",
    attendee: "home.role.attendee",
    visitor: "home.role.visitor",
  } as const;

  /** A readable placeholder title from a coordinate's identifier. */
  function placeholderTitle(coordinate: string): string {
    let id = "event";
    try {
      id = parseCoordinate(coordinate).identifier;
    } catch {
      /* keep default */
    }
    return id
      .replace(/-[0-9a-f]{6,}$/i, "") // strip the random slug suffix
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || t("home.placeholderEvent");
  }

  // Backfill "My events" from the local key store — every event the user created
  // or was approved into — so events created before this list existed still show.
  // Backfill "My events" from whatever the KEYSTORE already holds first — never
  // wait on the two relay scans before filling the list (CACHING-PLAN §2.14). The
  // fresh-device recovery + grant scan then run in the background and backfill
  // again once they land.
  function backfillFromKeystore(
    keys: { coordinate: string; role: "organizer" | "attendee" }[],
    authoritative = false,
    pending: DiscoveredMembership[] = [],
  ) {
    const byCoordinate = new Map(keys.map((k) => [k.coordinate, k]));
    const pendingCoords = new Set(pending.map((p) => p.coordinate));
    if (authoritative) {
      for (const prior of recentEvents.list) {
        recentEvents.reconcile({
          ...prior,
          role: byCoordinate.get(prior.coordinate)?.role ?? "visitor",
          // Written on EVERY authoritative pass, `false` included: this is the
          // read that clears the flag once a grant finally lands, and a card
          // still saying "waiting for its key" over an event the user can now
          // open would be the same lie in the other direction.
          pendingKey: pendingCoords.has(prior.coordinate),
        });
      }
    }
    for (const k of keys) {
      try {
        const prior = recentEvents.list.find((e) => e.coordinate === k.coordinate);
        recentEvents.reconcile({
          coordinate: k.coordinate,
          naddr: prior?.naddr ?? coordinateToNaddr(k.coordinate),
          title: prior?.title ?? placeholderTitle(k.coordinate),
          icon: prior?.icon,
          role: k.role,
          at: prior?.at ?? 1, // reconciliation must preserve recent navigation order
        });
      } catch {
        /* one malformed coordinate must not abort the whole backfill */
      }
    }
    // Spaces the NETWORK says this identity joined and this device cannot open
    // (audit E9). Nothing above would ever add them — that is the whole point:
    // without this loop the user sees an empty list, which is indistinguishable
    // from never having joined. `coordinateToNaddr` carries the coordinate's own
    // kind, so a community lands here exactly like an event; enrichEvents() fills
    // in the real title behind the placeholder.
    //
    // LAST, and with no key-store check of its own: `awaitingKey` has already
    // decided what belongs here, and it counts a record with an empty ECK list as
    // unopenable. So an event the key store knows a role for but holds no key
    // for lands in this loop and is corrected down to "waiting for its key",
    // which is the truth about it. The moment a real ECK arrives, `awaitingKey`
    // stops returning it and the role loop above puts its badge back.
    for (const p of pending) {
      try {
        const prior = recentEvents.list.find((e) => e.coordinate === p.coordinate);
        recentEvents.reconcile({
          coordinate: p.coordinate,
          naddr: prior?.naddr ?? coordinateToNaddr(p.coordinate),
          title: prior?.title ?? placeholderTitle(p.coordinate),
          icon: prior?.icon,
          role: "visitor",
          pendingKey: true,
          at: prior?.at ?? 1,
        });
      } catch {
        /* one malformed coordinate must not abort the whole backfill */
      }
    }
  }

  /**
   * One scan round: fresh-device recovery + grant scan, then backfill from the
   * keystore again so a newly-recovered/approved event appears.
   *  - recoverEventKeys: 30078 backups → events this identity CREATED (E_id).
   *  - receiveGrants: 21602/21605 gift-wraps → events APPROVED into / co-organizer.
   *
   * Both share ONE budget (scan-budget.ts) so the pair cannot, between them,
   * walk an unbounded chain of remote-signer prompts — this onMount was the
   * app's only unbounded one, and unlike `prefetch.ts` it deliberately DOES run
   * for a remote signer, because a returning organizer's events are exactly what
   * a silent-signer-only policy would refuse to go and find.
   *
   * Sets `scanError` from the round's outcome rather than swallowing it.
   */
  async function runScans(signer: AppSigner, force = false): Promise<void> {
    const budget = startScanBudget();
    const outcomes: ScanOutcome[] = [];
    const onOutcome = (o: ScanOutcome) => outcomes.push(o);
    const results = await Promise.allSettled([
      recoverEventKeys(signer, { budget, onOutcome, ...(force ? { force: true } : {}) }),
      // `force` reaches the GRANT scan too. It did not, and that was the whole
      // gap: the one control the user had for "you're wrong, look again" bypassed
      // recover.ts's session latch but left `receiveGrants` reading its narrow
      // now−3-days window, so pressing Retry on a phone that had latched its
      // backfill marker months earlier re-asked exactly the question that had
      // already failed — and answered "No events yet" again, with more confidence.
      receiveGrants(signer, { budget, onOutcome, ...(force ? { force: true } : {}) }),
      // The third question, and the only one that can be answered when the other
      // two come back empty: "which spaces did you ever ASK to join?" (audit E9,
      // events/membership.ts). It recovers no key — it reads the attendee's own
      // 31602 self-copies — so it runs at LOW priority in the shared budget and
      // can never take a signer prompt away from the two scans above.
      //
      // No `force`: it has no latch to bypass. It re-reads the full history on
      // every pass by construction (a `{kinds, authors}` filter with no `since`),
      // which is exactly why it can see a join the 3-day grant window cannot.
      discoverJoinedSpaces(signer, { budget, onOutcome }),
    ]);
    scanError = scanFailure(results, outcomes);
    keysWaiting = unreachableEventCount(outcomes);
    const discovered = results[2].status === "fulfilled" ? results[2].value : [];
    try {
      const held = await listEventKeys();
      backfillFromKeystore(held, true, awaitingKey(discovered, held));
      void enrichEvents();
    } catch {
      // A failed custody read is not evidence that every event is a visitor.
    }
    settled = true;
    perfMark("Home", "network-settled");
  }

  /**
   * The user telling us the previous answer was wrong.
   *
   * `force` bypasses BOTH latches — recover.ts's once-per-session guard and the
   * grant scan's full-history backfill marker — so neither a cached "already
   * swept" nor a marker written weeks ago can turn this into a no-op. It is the
   * same work behind the error-state "Retry" and the "Search my whole history"
   * button; `announce` is the only difference, because a retry that follows a
   * visible error needs no receipt while an unprompted search does.
   */
  async function deepScan(announce = false) {
    const signer = session.signer;
    if (!signer || retrying) return;
    retrying = true;
    settled = false;
    scanError = null;
    deepScanDone = false;
    try {
      await runScans(signer, true);
      if (announce) deepScanDone = true;
    } finally {
      retrying = false;
    }
  }

  const retryScan = () => deepScan(false);

  /**
   * True when the device cannot currently reach a relay AT ALL. In that state an
   * empty list is not a finding — nothing was asked and nothing answered — and
   * rendering "No events yet" over it asserts the one thing we have no basis for.
   * "connecting" is deliberately excluded: it means no attempt has FAILED yet.
   */
  const cannotReachRelays = $derived(
    connectivity.overall === "offline" || connectivity.overall === "relay-blocked",
  );

  onMount(async () => {
    // 1. Instant: local custody answers "My events" with no network.
    if (session.custodyReady) backfillFromKeystore(await listEventKeys().catch(() => []));
    perfMark("Home", "cache-paint");
    // 2. Warm the contexts the user is most likely to tap next.
    for (const e of recentEvents.list.slice(0, 4)) prefetchEventContext(e.naddr);
    void enrichEvents();
    // 3. Background: the scan round (see `runScans`), so a newly-recovered or
    //    newly-approved event appears without blocking first paint.
    //
    // Gated on the SIGNER only, never on `custodyReady`. Both scans read from
    // relays and decrypt through the signer; neither needs the on-device custody
    // snapshot to have unlocked. Gating them on `custodyReady` meant that when an
    // unlock failed — precisely the remote-signer-unreachable case — the app not
    // only had no local keys but also refused to go and fetch them, and since
    // `custodyGeneration` never bumps on a failed unlock the $effect below could
    // not retry either. An organizer was left on "No events yet" for the whole
    // session with nothing retrying.
    const signer = session.signer;
    if (signer) {
      // Backstop for a round that never returns at all. It must NOT just flip
      // `settled` any more: doing that with an empty list renders "No events
      // yet", asserting as fact the one thing we still don't know. Say the scan
      // didn't finish and offer the retry instead; `runScans` overwrites this
      // the moment it does come back.
      const guard = setTimeout(() => {
        if (settled) return;
        scanError = new ScanIncompleteError();
        settled = true;
      }, SCAN_GUARD_MS);
      void runScans(signer).finally(() => clearTimeout(guard));
    } else {
      settled = true;
      perfMark("Home", "network-settled");
    }
  });

  // NIP-46 restore is deliberately detached from first paint (+layout.svelte,
  // UX-19), so the identity can arrive long after this component mounted.
  // Reconcile whenever the ACTIVE IDENTITY changes or its custody finishes
  // unlocking — keyed on both, not on `custodyGeneration` alone: that counter
  // only advances on a SUCCESSFUL unlock, so a background restore whose custody
  // unlock failed used to produce no key change at all and this effect never
  // ran, stranding the user's event list empty with no retry.
  const reconcileKey = () =>
    session.signer && session.pubkey ? `${session.pubkey}:${session.custodyGeneration}` : "";
  // Seeded from the state at INIT so a mount that already has an identity does
  // not duplicate the scans onMount is about to run for that same identity.
  let reconciled = reconcileKey();
  $effect(() => {
    const key = reconcileKey();
    const signer = session.signer;
    if (!signer || !key || key === reconciled) return;
    reconciled = key;
    void (async () => {
      settled = false;
      scanError = null;
      backfillFromKeystore(await listEventKeys());
      await runScans(signer);
    })().catch((e) => {
      // A storage failure is not an authoritative empty list or visitor role —
      // and it is not "No events yet" either. Show it.
      scanError = e;
      settled = true;
    });
  });

  async function enrichEvents() {
    const targets = recentEvents.list.slice(0, 8);
    if (!targets.length) return;
    await connectNdk().catch(() => {});
    await Promise.allSettled(
      targets.map(async (e) => {
        const ctx =
          cachedEventContext(e.naddr) ??
          (await loadEventContext(e.naddr, { adoptLang: false }));
        if (ctx.title !== e.title || (ctx.icon && ctx.icon !== e.icon)) {
          recentEvents.record({
            coordinate: e.coordinate,
            naddr: e.naddr,
            title: ctx.title,
            icon: ctx.icon ?? e.icon,
            role: e.role,
            at: e.at, // keep its position — this is a refresh, not a visit
          });
        }
      }),
    );
  }
</script>

<h1>{t("home.title")}</h1>
<p class="muted">
  {t("home.intro")}
</p>

{#if session.loggedIn && session.signer?.method === "local" && !backupNag.done}
  <!-- One gentle nudge until the key is backed up (UI-SUGGESTIONS #8). -->
  <div class="card warn">
    <strong>{t("home.backup.title")}</strong>
    <p class="muted" style="margin:0.25rem 0 0.5rem">
      {t("home.backup.body")}
    </p>
    <div class="row">
      <button class="btn inline primary" onclick={() => router.go({ name: "me" })}>
        {t("home.backup.now")}
      </button>
      <button class="btn inline" onclick={() => markBackedUp()}>{t("home.backup.saved")}</button>
    </div>
  </div>
{/if}

<!-- SESSION STATE FIRST. This block used to sit in the `{:else}` chain BELOW the
     list, which meant `{#if events.length}` swallowed it: a device whose session
     had quietly not restored rendered its cached event cards and NOTHING else —
     no login prompt, no explanation — while running no scan at all (the onMount
     scan is gated on a signer). That is one of the shapes "it still shows me the
     OLD events and the interface tells me nothing" takes. -->
{#if !session.loggedIn && session.restoring}
  <!-- A persisted NIP-46 session is reconnecting in the background (UX-19: the
       shell must not block on it). Until it settles we do NOT know whether this
       person is logged out — telling them to log in while their own session is
       coming back is what made a returning organizer log in a second time on
       2026-07-28. -->
  <p class="muted" role="status" aria-live="polite">{t("home.restoringSession")}</p>
{:else if !session.loggedIn}
  <div class="card {events.length ? 'warn' : ''}">
    <h2>{events.length ? t("home.signedOut.title") : t("home.getStarted")}</h2>
    <p class="muted">
      {events.length ? t("home.signedOut.stale") : t("home.getStarted.body")}
    </p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>
      {t("home.loginOrCreate")}
    </button>
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
      {t("home.createEvent")}
    </button>
  </div>
{/if}

{#if events.length}
  <h2>{t("home.yourEvents")}</h2>
  <div class="stack">
    {#each events as e (e.naddr)}
      {@const facts = cardFacts(e.coordinate)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center"
        onclick={() => router.go({ name: "event", naddr: e.naddr })}
        onpointerenter={() => prefetchEventContext(e.naddr)}
        onfocus={() => prefetchEventContext(e.naddr)}
      >
        <img
          src={e.icon || defaultEventIcon(e.title, e.title)}
          alt=""
          width="44"
          height="44"
          style="border-radius:11px;flex:none"
        />
        <div style="flex:1;min-width:0">
          <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {e.title}
          </strong>
          <span class="cardmeta">
            {#if e.pendingKey}
              <!-- Not "viewed". The one thing this device knows about this space
                   is that the person asked to join it and the key never arrived,
                   and saying so is the entire reason the card exists at all. -->
              <span class="badge warn">{t("home.role.awaitingKey")}</span>
            {:else}
              <span class="badge">{t(roleLabel[e.role])}</span>
            {/if}
            {#if facts.people !== undefined}
              <span class="muted">{tcp("attendees.count", facts.community, facts.people)}</span>
            {/if}
            {#if facts.fresh > 0}
              <span class="fresh">{tp("home.card.new", facts.fresh)}</span>
            {/if}
          </span>
        </div>
        <span class="muted">›</span>
      </button>
    {/each}
  </div>
  {#if anyPendingKey}
    <!-- One sentence for the badge above. Without it "waiting for its key" is a
         label with no explanation and no next step; with it the user knows the
         event is real, why it won't open, and that the wider search is right
         below. -->
    <p class="muted" role="status" aria-live="polite" style="margin-top:0.5rem">
      {t("home.awaitingKey.note")}
    </p>
  {/if}
  {#if scanError || retrying}
    <!-- We have SOME events but the scan couldn't finish, so this list may be
         short of the one the user is looking for. Quiet here (they can see a
         working list) but never silent — the alternative is the user assuming
         the missing event is gone. Held while `retrying` so the note and its
         button don't blink out of existence the moment the retry starts. -->
    <p class="muted" role="status" aria-live="polite" style="margin-top:0.5rem">
      {t("home.scanIncomplete")}
    </p>
    <button class="btn inline" onclick={retryScan} disabled={retrying}>
      {retrying ? t("error.state.retrying") : t("error.state.retry")}
    </button>
  {/if}
  {@render diagnostics()}
  {#if session.loggedIn}
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
      <Icon name="plus" size={17} />{t("home.createAnother")}
    </button>
  {/if}
{:else if session.loggedIn}
  {#if loadingEvents}
    <p class="muted">{t("home.loadingEvents")}</p>
  {:else if scanError}
    <!-- Empty list AND a scan we can't trust: the two states this screen used to
         render identically. "No events yet" here is an assertion we have no basis
         for — say what actually happened and let the user retry. -->
    <ErrorState
      error={scanError}
      body="home.scanFailed.body"
      onRetry={retryScan}
      {retrying}
    />
    <div class="card">
      <button class="btn" onclick={() => router.go({ name: "create" })}>
        {t("home.createEvent")}
      </button>
    </div>
  {:else if cannotReachRelays}
    <!-- The third state, and the one that used to be indistinguishable from the
         other two: we did not fail to FIND events, we failed to ASK. Rendering
         "No events yet" here is how a conference-WiFi captive portal gets
         reported as data loss. -->
    <div class="card warn" role="status" aria-live="polite">
      <h2>{t("home.cantCheck.title")}</h2>
      <p class="muted">{t("home.cantCheck.body")}</p>
      <button class="btn" onclick={retryScan} disabled={retrying}>
        {retrying ? t("error.state.retrying") : t("error.state.retry")}
      </button>
    </div>
  {:else}
    <div class="card">
      <h2>{t("home.noEvents")}</h2>
      <p class="muted">{t("home.noEvents.body")}</p>
      <button class="btn primary" onclick={() => router.go({ name: "create" })}>
        {t("home.createEvent")}
      </button>
    </div>
    {@render diagnostics()}
  {/if}
{/if}

<!--
  Rendered in EVERY state of the list above, deliberately. It is the answer to
  "no events yet" on a fresh install, to a short list missing the one event the
  user came for, and to a key grant this device is holding for an event it can't
  reach ("home.keysWaiting" already tells people to open the invite link here —
  installed as an app, this is the only way to do that).
-->
<AddEventByLink />

<!--
  The honest floor under every "you have no events"-shaped claim on this screen.
  Three facts the user previously had no way to get at:
   - a key grant IS held for an event whose relays this device can't reach (not
     "no events" — we are holding the key and cannot open it);
   - the routine check only covers the last few days, which is exactly why an
     event joined on another device last month can be missing;
   - the wider search exists, and can be run on demand.
-->
{#snippet diagnostics()}
  {#if session.loggedIn}
    {#if keysWaiting > 0}
      <p class="muted" role="status" aria-live="polite" style="margin-top:0.5rem">
        {t("home.keysWaiting")}
      </p>
    {/if}
    <p class="muted" style="margin-top:0.5rem">{t("home.deepScan.hint")}</p>
    <button class="btn inline" onclick={() => deepScan(true)} disabled={retrying}>
      {retrying ? t("home.deepScan.busy") : t("home.deepScan.action")}
    </button>
    {#if deepScanDone && !retrying}
      <p class="muted" role="status" aria-live="polite" style="margin-top:0.5rem">
        {t("home.deepScan.done")}
      </p>
    {/if}
  {/if}
{/snippet}

<div class="card">
  <h2>{t("home.how.title")}</h2>
  <ul class="muted">
    <li>{t("home.how.record")}</li>
    <li>{t("home.how.matched")}</li>
    <li>{t("home.how.encrypted")}</li>
    <li>{t("home.how.portable")}</li>
  </ul>
</div>

<style>
  /* What the card knows about itself. Quiet, because the title is what gets
     scanned; these are the two facts that decide whether it is worth opening. */
  .cardmeta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-top: 0.15rem;
    font-size: 0.8rem;
  }
  /* The return signal. A word, not a coloured dot: it has to survive forced
     colours and greyscale, and for a community it is the only reason anyone
     comes back — there is no date to do it for them. */
  .fresh {
    font-weight: 700;
    color: var(--accent);
  }
</style>
