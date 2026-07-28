<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { coordinateToNaddr, parseCoordinate } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import type { AppSigner } from "$lib/signer/types.js";
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { receiveGrants } from "$lib/events/attendee.js";
  import {
    startScanBudget,
    scanFailure,
    ScanIncompleteError,
    type ScanOutcome,
  } from "$lib/events/scan-budget.js";
  import { defaultEventIcon } from "$lib/media/image.js";
  import { backupNag, markBackedUp } from "$lib/stores/backup-nag.svelte.js";
  import { prefetchEventContext } from "$lib/nostr/prefetch.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext } from "$lib/events/event-context.js";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  const events = $derived(recentEvents.list);

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
  ) {
    const byCoordinate = new Map(keys.map((k) => [k.coordinate, k]));
    if (authoritative) {
      for (const prior of recentEvents.list) {
        recentEvents.reconcile({
          ...prior,
          role: byCoordinate.get(prior.coordinate)?.role ?? "visitor",
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
      receiveGrants(signer, { budget, onOutcome }),
    ]);
    scanError = scanFailure(results, outcomes);
    try {
      backfillFromKeystore(await listEventKeys(), true);
      void enrichEvents();
    } catch {
      // A failed custody read is not evidence that every event is a visitor.
    }
    settled = true;
    perfMark("Home", "network-settled");
  }

  async function retryScan() {
    const signer = session.signer;
    if (!signer || retrying) return;
    retrying = true;
    settled = false;
    scanError = null;
    // `force` bypasses recover.ts's once-per-session latch: the user is telling
    // us the previous answer was wrong, so a cached "already swept" must not
    // turn the retry into a no-op.
    try {
      await runScans(signer, true);
    } finally {
      retrying = false;
    }
  }

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

{#if events.length}
  <h2>{t("home.yourEvents")}</h2>
  <div class="stack">
    {#each events as e (e.naddr)}
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
          <span class="badge">{t(roleLabel[e.role])}</span>
        </div>
        <span class="muted">›</span>
      </button>
    {/each}
  </div>
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
  <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
    <Icon name="plus" size={17} />{t("home.createAnother")}
  </button>
{:else if !session.loggedIn && session.restoring}
  <!-- A persisted NIP-46 session is reconnecting in the background (UX-19: the
       shell must not block on it). Until it settles we do NOT know whether this
       person is logged out — telling them to log in while their own session is
       coming back is what made a returning organizer log in a second time on
       2026-07-28. Show the pending state instead; the branches above take over
       the moment the restore lands (or fails). -->
  <p class="muted" role="status" aria-live="polite">{t("home.restoringSession")}</p>
{:else if !session.loggedIn}
  <div class="card">
    <h2>{t("home.getStarted")}</h2>
    <p class="muted">{t("home.getStarted.body")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>
      {t("home.loginOrCreate")}
    </button>
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
      {t("home.createEvent")}
    </button>
  </div>
{:else if loadingEvents}
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
{:else}
  <div class="card">
    <h2>{t("home.noEvents")}</h2>
    <p class="muted">{t("home.noEvents.body")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "create" })}>
      {t("home.createEvent")}
    </button>
  </div>
{/if}

<div class="card">
  <h2>{t("home.how.title")}</h2>
  <ul class="muted">
    <li>{t("home.how.record")}</li>
    <li>{t("home.how.matched")}</li>
    <li>{t("home.how.encrypted")}</li>
    <li>{t("home.how.portable")}</li>
  </ul>
</div>
