<script lang="ts">
  /**
   * Organizer controls for the space hierarchy (PROTOCOL-NIP.md §15), on the
   * settings page:
   *
   *  - on a dated event: choose which of YOUR communities it belongs to. Choosing
   *    one publishes both halves of the link (the community lists the event, the
   *    event names the community) and, for an event with no coordinator, re-sends
   *    the key grant of everyone already approved so they can be offered the
   *    community too.
   *  - on a community: the events that belong to it, each removable.
   *
   * Removing a link never revokes memberships already granted.
   */
  import { onMount } from "svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { isCommunityCoordinate } from "@nostrautica/protocol";
  import {
    listOrganizedCommunities,
    linkEventToCommunity,
    unlinkEventFromCommunity,
    setCommunityChild,
    loadChildren,
    loadLinkedParent,
    type ChildSummary,
    type LinkedParent,
    type OrganizedCommunity,
  } from "$lib/events/hierarchy.js";
  import { reissueGrantsWithProof } from "$lib/events/organizer.js";
  import type { EventContext } from "$lib/events/event-context.js";

  let {
    ctx,
    onChange,
  }: {
    ctx: EventContext;
    /** The space's context after a link change, so the page's copy stays current. */
    onChange?: (ctx: EventContext) => void;
  } = $props();

  const isCommunity = $derived(isCommunityCoordinate(ctx.coordinate));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);

  // ── event: the picker ──────────────────────────────────────────────────────
  let communities = $state<OrganizedCommunity[]>([]);
  let loaded = $state(false);
  let current = $state<LinkedParent | undefined>(undefined);
  let selected = $state("");

  onMount(async () => {
    if (isCommunity) return;
    communities = await listOrganizedCommunities().catch(() => []);
    current = await loadLinkedParent(ctx);
    selected = ctx.config.parent ?? "";
    loaded = true;
  });

  const dirty = $derived(selected !== (ctx.config.parent ?? ""));
  const currentIsMine = $derived(!!ctx.config.parent && communities.some((c) => c.coordinate === ctx.config.parent));

  async function save() {
    if (busy || !dirty) return;
    busy = true;
    error = null;
    note = null;
    try {
      if (ctx.config.parent && !selected) {
        await unlinkEventFromCommunity(ctx);
        onChange?.({ ...ctx, config: { ...ctx.config, parent: undefined } });
        current = undefined;
        note = t("hierarchy.settings.unlinked");
      } else {
        const community = communities.find((c) => c.coordinate === selected);
        if (!community) return;
        // Moving between communities: drop this event from the old one first.
        if (ctx.config.parent && ctx.config.parent !== selected) await unlinkEventFromCommunity(ctx);
        const { regranted } = await linkEventToCommunity(ctx, community, reissueGrantsWithProof);
        onChange?.({ ...ctx, config: { ...ctx.config, parent: selected } });
        current = await loadLinkedParent({ coordinate: ctx.coordinate, config: { ...ctx.config, parent: selected } });
        note = regranted > 0
          ? t("hierarchy.settings.linkedRegranted", { title: community.title, n: String(regranted) })
          : t("hierarchy.settings.linked", { title: community.title });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ── community: its events ──────────────────────────────────────────────────
  let children = $state<ChildSummary[]>([]);
  let childrenLoaded = $state(false);
  let removing = $state<string | null>(null);

  onMount(async () => {
    if (!isCommunity) return;
    children = await loadChildren(ctx.coordinate, ctx.config).catch(() => []);
    childrenLoaded = true;
  });

  async function removeChild(c: ChildSummary) {
    if (removing) return;
    removing = c.coordinate;
    error = null;
    note = null;
    try {
      const config = await setCommunityChild(ctx.coordinate, c.coordinate, false, ctx.config.relays);
      children = children.filter((x) => x.coordinate !== c.coordinate);
      if (config) onChange?.({ ...ctx, config });
      note = t("hierarchy.children.removed", { title: c.title });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      removing = null;
    }
  }

  function when(start?: number): string {
    return start ? new Date(start * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  }
</script>

{#if isCommunity}
  <div class="card">
    <div class="field-label" id="hier-children-title">{t("hierarchy.children.title")}</div>
    <p class="muted">{t("hierarchy.children.body")}</p>
    {#if !childrenLoaded}
      <p class="muted" role="status">{t("hierarchy.overview.loading")}</p>
    {:else if children.length === 0}
      <p class="muted">{t("hierarchy.children.empty")}</p>
    {:else}
      <ul style="list-style:none;margin:0;padding:0" aria-labelledby="hier-children-title">
        {#each children as c (c.coordinate)}
          <li class="row" style="justify-content:space-between;align-items:center;gap:0.5rem;padding:0.3rem 0">
            <span style="min-width:0">
              <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{c.title}</strong>
              {#if c.start}<span class="muted" style="font-size:0.8rem">{when(c.start)}</span>{/if}
            </span>
            <button
              type="button"
              class="btn inline"
              disabled={removing !== null}
              aria-label={t("hierarchy.children.remove.aria", { title: c.title })}
              onclick={() => removeChild(c)}
            >
              {removing === c.coordinate ? t("hierarchy.children.removing") : t("hierarchy.children.remove")}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="muted" role="alert" style="color:var(--danger)">{error}</p>{/if}
    {#if note}<p class="muted" role="status">{note}</p>{/if}
  </div>
{:else}
  <div class="card">
    <label class="field-label" for="hier-parent">{t("hierarchy.picker.label")}</label>
    <p class="muted">{t("hierarchy.picker.help")}</p>
    {#if loaded && communities.length === 0 && !ctx.config.parent}
      <p class="muted">{t("hierarchy.picker.empty")}</p>
    {:else}
      <select id="hier-parent" bind:value={selected} disabled={busy || !loaded}>
        <option value="">{t("hierarchy.picker.none")}</option>
        {#each communities as c (c.coordinate)}
          <option value={c.coordinate}>{c.title}</option>
        {/each}
        {#if ctx.config.parent && !currentIsMine}
          <option value={ctx.config.parent}>{current?.title ?? t("hierarchy.picker.other")}</option>
        {/if}
      </select>
      {#if ctx.config.parent && !currentIsMine && loaded}
        <p class="muted" style="margin:0.4rem 0 0">
          {t("hierarchy.settings.foreign", { title: current?.title ?? t("hierarchy.picker.other") })}
        </p>
      {/if}
      <div class="row" style="margin-top:0.5rem">
        <button type="button" class="btn inline" onclick={save} disabled={busy || !dirty || !loaded}>
          {busy ? t("hierarchy.settings.saving") : t("hierarchy.settings.save")}
        </button>
      </div>
    {/if}
    {#if error}<p class="muted" role="alert" style="color:var(--danger)">{error}</p>{/if}
    {#if note}<p class="muted" role="status">{note}</p>{/if}
  </div>
{/if}
