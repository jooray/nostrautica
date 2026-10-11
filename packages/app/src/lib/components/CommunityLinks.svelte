<script lang="ts">
  /**
   * How a space shows its place in the hierarchy (PROTOCOL-NIP.md §15), on its
   * Overview:
   *
   *  - mode "header", on a dated event that belongs to a community: a "Part of
   *    <community>" link, and — for a member who holds a proof but never agreed to
   *    join (they joined before this existed, or the grant was re-issued) — a
   *    one-tap offer. Nothing here ever joins anyone; the automatic path lives in
   *    community-join.ts and only fires on consent given at the join form.
   *  - mode "events", on a community: the events that belong to it, upcoming
   *    first, then past.
   */
  import { onMount } from "svelte";
  import { router } from "$lib/router/router.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import {
    cachedLinkedParent,
    loadLinkedParent,
    loadChildren,
    sortChildren,
    type ChildSummary,
    type LinkedParent,
  } from "$lib/events/hierarchy.js";
  import {
    evaluateCommunityOffer,
    joinCommunityViaChild,
    dismissCommunityOffer,
  } from "$lib/events/community-join.js";
  import { cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { coordinateToNaddr } from "@nostrautica/protocol";
  import { defaultEventIcon } from "$lib/media/image.js";

  let {
    ctx,
    mode,
    member = false,
  }: {
    ctx: EventContext;
    mode: "header" | "events";
    /** The viewer is an approved member (or organizer) of THIS space. */
    member?: boolean;
  } = $props();

  // ── header: Part of <community> ────────────────────────────────────────────
  // svelte-ignore state_referenced_locally -- seeded from cache; the effect below refreshes it
  let parent = $state<LinkedParent | undefined>(
    mode === "header" ? cachedLinkedParent(ctx) : undefined,
  );
  let offer = $state(false);
  let offerState = $state<"idle" | "sending" | "sent" | "failed">("idle");

  async function refreshOffer() {
    if (mode !== "header" || !member) {
      offer = false;
      return;
    }
    offer = (await evaluateCommunityOffer(ctx.coordinate)).decision === "offer";
  }

  $effect(() => {
    if (mode !== "header") return;
    const c = ctx;
    let alive = true;
    void loadLinkedParent(c).then((p) => {
      if (alive) parent = p;
    });
    return () => {
      alive = false;
    };
  });
  $effect(() => {
    void member;
    void session.pubkey;
    void ctx.coordinate;
    void refreshOffer();
  });

  async function acceptOffer() {
    if (!session.signer || offerState === "sending") return;
    offerState = "sending";
    try {
      const sent = await joinCommunityViaChild(session.signer, ctx.coordinate);
      offerState = sent ? "sent" : "failed";
    } catch {
      offerState = "failed";
    }
    if (offerState === "sent") offer = false;
  }
  function declineOffer() {
    dismissCommunityOffer(ctx.coordinate);
    offer = false;
  }

  // ── events: the community's children ───────────────────────────────────────
  let children = $state<ChildSummary[]>([]);
  let childrenLoaded = $state(false);

  function fromCache(coordinates: string[]): ChildSummary[] {
    const out: ChildSummary[] = [];
    for (const c of coordinates) {
      const cached = cachedEventContext(coordinateToNaddr(c, ctx.config.relays));
      if (cached && cached.config.parent === ctx.coordinate) {
        out.push({ coordinate: c, naddr: cached.naddr, title: cached.title, start: cached.start, icon: cached.icon });
      }
    }
    return sortChildren(out);
  }

  $effect(() => {
    if (mode !== "events") return;
    const c = ctx;
    let alive = true;
    children = fromCache(c.config.children ?? []);
    childrenLoaded = children.length > 0;
    void loadChildren(c.coordinate, c.config).then((list) => {
      if (!alive) return;
      children = list;
      childrenLoaded = true;
    });
    return () => {
      alive = false;
    };
  });

  const nowSec = $derived(Math.floor(Date.now() / 1000));
  const upcoming = $derived(children.filter((c) => c.start === undefined || c.start >= nowSec));
  const past = $derived(children.filter((c) => c.start !== undefined && c.start < nowSec));

  function when(start?: number): string {
    if (!start) return "";
    return new Date(start * 1000).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }
</script>

{#if mode === "header"}
  {#if parent}
    <p class="partof">
      <button
        type="button"
        class="btn inline ghost partof-link"
        aria-label={t("hierarchy.overview.partOf.open", { title: parent.title })}
        onclick={() => router.go({ name: "event", naddr: parent!.naddr })}
      >
        {t("hierarchy.overview.partOf", { title: parent.title })} ›
      </button>
    </p>
  {/if}
  {#if offer && parent}
    <div class="card" role="region" aria-label={t("hierarchy.offer.region")}>
      <strong>{t("hierarchy.offer.title", { title: parent.title })}</strong>
      <p class="muted" style="margin:0.25rem 0 0.5rem">
        {t("hierarchy.offer.body", { event: ctx.title, title: parent.title })}
      </p>
      <div class="row">
        <button
          type="button"
          class="btn inline primary"
          onclick={acceptOffer}
          disabled={offerState === "sending"}
          aria-label={t("hierarchy.offer.join.aria", { title: parent.title })}
        >
          {offerState === "sending" ? t("hierarchy.offer.joining") : t("hierarchy.offer.join")}
        </button>
        <button type="button" class="btn inline" onclick={declineOffer} disabled={offerState === "sending"}>
          {t("hierarchy.offer.later")}
        </button>
      </div>
      {#if offerState === "failed"}
        <p class="muted" role="status" style="color:var(--danger);margin:0.4rem 0 0">
          {t("hierarchy.offer.failed")}
        </p>
      {/if}
    </div>
  {:else if offerState === "sent" && parent}
    <p class="muted" role="status">{t("hierarchy.offer.sent", { title: parent.title })}</p>
  {/if}
{:else if (ctx.config.children?.length ?? 0) > 0}
  <section class="card" aria-labelledby="hierarchy-events-title">
    <h2 id="hierarchy-events-title" style="margin-top:0">{t("hierarchy.overview.events")}</h2>
    {#if !childrenLoaded}
      <p class="muted" role="status">{t("hierarchy.overview.loading")}</p>
    {:else if children.length === 0}
      <p class="muted">{t("hierarchy.overview.noEvents")}</p>
    {/if}
    {#snippet row(c: ChildSummary)}
      <li>
        <button
          type="button"
          class="child-row"
          aria-label={t("hierarchy.overview.event.open", { title: c.title })}
          onclick={() => router.go({ name: "event", naddr: c.naddr })}
        >
          <img src={c.icon || defaultEventIcon(c.title, c.title)} alt="" width="36" height="36" style="border-radius:9px;flex:none" />
          <span style="flex:1;min-width:0">
            <strong class="child-title">{c.title}</strong>
            {#if c.start}<span class="muted child-when">{when(c.start)}</span>{/if}
          </span>
          <span class="muted">›</span>
        </button>
      </li>
    {/snippet}
    {#if upcoming.length}
      <h3 class="child-head">{t("hierarchy.overview.upcoming")}</h3>
      <ul class="child-list">
        {#each upcoming as c (c.coordinate)}{@render row(c)}{/each}
      </ul>
    {/if}
    {#if past.length}
      <h3 class="child-head">{t("hierarchy.overview.past")}</h3>
      <ul class="child-list">
        {#each past as c (c.coordinate)}{@render row(c)}{/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .partof {
    margin: 0.25rem 0;
  }
  .partof-link {
    padding-left: 0;
    font-weight: 600;
  }
  .child-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .child-head {
    margin: 0.75rem 0 0.25rem;
    font-size: 0.85rem;
    color: var(--muted, inherit);
  }
  .child-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.5rem 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .child-title {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .child-when {
    display: block;
    font-size: 0.8rem;
  }
</style>
