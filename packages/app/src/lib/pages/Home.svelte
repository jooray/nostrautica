<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { coordinateToNaddr, parseCoordinate } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { listEventKeys } from "$lib/events/keystore.js";
  import { recoverEventKeys } from "$lib/events/recover.js";
  import { receiveGrants } from "$lib/events/attendee.js";
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

  onMount(async () => {
    // 1. Instant: local custody answers "My events" with no network.
    if (session.custodyReady) backfillFromKeystore(await listEventKeys().catch(() => []));
    perfMark("Home", "cache-paint");
    // 2. Warm the contexts the user is most likely to tap next.
    for (const e of recentEvents.list.slice(0, 4)) prefetchEventContext(e.naddr);
    void enrichEvents();
    // 3. Background: fresh-device recovery + grant scan, then backfill again so a
    //    newly-recovered/approved event appears without blocking first paint.
    //  - recoverEventKeys: 30078 backups → events this identity CREATED (E_id).
    //  - receiveGrants: 21602/21605 gift-wraps → events APPROVED into / co-organizer.
    if (session.signer && session.custodyReady) {
      // Backstop: never let a hung relay strand the user on the spinner. The
      // scans have their own ~8s hard cap, so this only fires if something wedges.
      const guard = setTimeout(() => (settled = true), 12000);
      void Promise.allSettled([
        recoverEventKeys(session.signer),
        receiveGrants(session.signer),
      ]).then(async () => {
        clearTimeout(guard);
        try {
          backfillFromKeystore(await listEventKeys(), true);
          void enrichEvents();
          settled = true;
          perfMark("Home", "network-settled");
        } catch {
          // A failed custody read is not evidence that every event is a visitor.
          settled = true;
        }
      });
    } else {
      settled = true;
      perfMark("Home", "network-settled");
    }
  });

  // NIP-46 restore is deliberately detached from first paint. Reconcile again
  // when that identity's encrypted event custody has finished unlocking.
  let reconciledGeneration = session.custodyGeneration;
  $effect(() => {
    const generation = session.custodyGeneration;
    const signer = session.signer;
    if (!session.custodyReady || !signer || generation === reconciledGeneration) return;
    reconciledGeneration = generation;
    void (async () => {
      settled = false;
      backfillFromKeystore(await listEventKeys());
      await Promise.allSettled([recoverEventKeys(signer), receiveGrants(signer)]);
      backfillFromKeystore(await listEventKeys(), true);
      void enrichEvents();
      settled = true;
    })().catch(() => {
      // A storage failure is not an authoritative empty list or visitor role.
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
  <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "create" })}>
    <Icon name="plus" size={17} />{t("home.createAnother")}
  </button>
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
