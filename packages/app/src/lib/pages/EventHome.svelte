<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { loadEventKeys } from "$lib/events/keystore.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { install } from "$lib/stores/install.svelte.js";
  import { fetchEventUpdates, type EventUpdate } from "$lib/events/updates.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { loadSelfCopy } from "$lib/media/submit.js";
  import { renderMarkdown } from "$lib/social/markdown.js";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let approved = $state(false);
  let organizer = $state(false);
  let requestPending = $state(false); // join request sent, approval not landed yet (P2)
  let updates = $state<EventUpdate[]>([]);
  // State-aware record CTA (UI-SUGGESTIONS #5): primary = "Record your intro"
  // until the 31602 self-copy carries an intro for this event. Default true so
  // the CTA doesn't flash "record" at people who already have one.
  let hasIntro = $state(true);
  let installHint = $state(false);

  const installHintId = "event-page";

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      approved = await isApproved(ctx.coordinate);
      // The join-sent marker outlives a reload; approval supersedes it (P2).
      if (approved) clearJoinSent(ctx.coordinate);
      else requestPending = joinSentAt(ctx.coordinate) !== undefined;
      const keys = await loadEventKeys(ctx.coordinate);
      organizer = keys?.role === "organizer";
      // Remember this event so it shows up under "My events" on Home.
      recentEvents.record({
        coordinate: ctx.coordinate,
        naddr,
        title: ctx.title,
        icon: ctx.icon,
        role: organizer ? "organizer" : approved ? "attendee" : "visitor",
      });
      if (approved) {
        installHint = install.shouldShow(installHintId);
        void checkIntro();
      }
      // Event updates (30023 by E_id) are public — everyone sees them.
      updates = await fetchEventUpdates(ctx.coordinate).catch(() => []);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function checkIntro() {
    if (!ctx || !session.signer) return;
    try {
      const bk = await deriveBlindingKey(session.signer);
      const self = await loadSelfCopy(session.signer, ctx, bk);
      hasIntro = (self?.media ?? []).some((m) => m.kind === "intro");
    } catch {
      /* can't tell — keep the default, don't nag */
    }
  }

  async function promptInstall() {
    const accepted = await install.promptInstall().catch(() => false);
    if (accepted) installHint = false;
  }

  function dismissInstall() {
    install.dismiss(installHintId);
    installHint = false;
  }

  function fmt(unix?: number) {
    return unix ? new Date(unix * 1000).toLocaleString() : "";
  }
</script>

{#if error}
  <div class="card warn">
    <strong>{t("event.loadFailed")}</strong>
    <span class="muted">{error}</span>
  </div>
{:else if !ctx}
  <p class="muted">{t("event.loading")}</p>
{:else}
  <EventHeader {ctx} />
  <p>{ctx.summary}</p>
  <p class="muted">
    {#if ctx.start}📅 {fmt(ctx.start)}{/if}
    {#if ctx.location}· 📍 {ctx.location}{/if}
  </p>
  <div class="row" style="flex-wrap:wrap">
    <!-- Human labels, not raw config values (UI-SUGGESTIONS #3). -->
    <span class="badge">
      {ctx.config.approval === "invite"
        ? t("event.approval.invite")
        : ctx.config.approval === "manual"
          ? t("event.approval.manual")
          : t("event.approval.both")}
    </span>
    {#if ctx.config.matching === "on"}<span class="badge">{t("event.matching")}</span>{/if}
  </div>

  <div class="card stack">
    {#if organizer}
      <button class="btn primary" onclick={() => router.go({ name: "admin", naddr })}>
        {t("event.organizerAdmin")}
      </button>
    {/if}
    {#if approved}
      <!-- State-aware primary (UI-SUGGESTIONS #5): no intro yet → recording is
           the highest-value action; intro done → matches take the lead. -->
      {#if !hasIntro}
        <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: false })}>
          {t("event.recordIntro")}
        </button>
        <p class="muted" style="margin:-0.25rem 0 0">
          {t("event.recordIntro.body")}
        </p>
        <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
          {t("event.seeWhosHere")}
        </button>
        {#if ctx.config.matching === "on"}
          <button class="btn" onclick={() => router.go({ name: "matches", naddr })}>
            {t("event.peopleToMeet")}
          </button>
        {/if}
      {:else}
        <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
          {t("event.seeWhosHere")}
        </button>
        {#if ctx.config.matching === "on"}
          <button class="btn primary" onclick={() => router.go({ name: "matches", naddr })}>
            {t("event.peopleToMeet")}
          </button>
        {/if}
        <button class="btn" onclick={() => router.go({ name: "record", naddr, talk: false })}>
          {t("event.recordOrUpdate")}
        </button>
      {/if}
    {:else if requestPending}
      <p style="margin:0"><strong>{t("event.requestSent")}</strong></p>
      <p class="muted" style="margin:0">
        {t("event.requestSent.body")}
      </p>
      <button class="btn" onclick={() => router.go({ name: "join", naddr })}>
        {t("event.checkStatus")}
      </button>
    {:else}
      <button class="btn primary" onclick={() => router.go({ name: "join", naddr })}>
        {t("event.join")}
      </button>
      <p class="muted">
        {t("event.join.body")}
      </p>
    {/if}
  </div>

  {#if approved && installHint}
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

  {#if updates.length}
    <h2>{t("event.updates")}</h2>
    {#each updates as u (u.d)}
      <article class="card">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h3 style="margin:0">{u.title}</h3>
          <span class="muted" style="font-size:0.75rem;flex:none">
            {new Date(u.publishedAt * 1000).toLocaleDateString()}
            {#if u.editedAt > u.publishedAt}{t("event.updates.edited")}{/if}
          </span>
        </div>
        <!-- Safe: renderMarkdown escapes the source before emitting its own tags. -->
        <div class="longform">{@html renderMarkdown(u.content)}</div>
      </article>
    {/each}
  {/if}
{/if}

<style>
  .longform :global(p) {
    margin: 0.5rem 0;
  }
  .longform :global(ul) {
    margin: 0.5rem 0;
    padding-left: 1.25rem;
  }
  .longform :global(h3),
  .longform :global(h4),
  .longform :global(h5) {
    margin: 0.75rem 0 0.25rem;
  }
</style>
