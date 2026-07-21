<script lang="ts">
  /**
   * Coordinator discovery + pick widget (kind-31611 announcements). Renders the
   * discovered-coordinator list (name/pricing/feature badges/terms) plus an
   * "advanced: paste an npub" fallback, and reports the chosen coordinator's hex
   * pubkey to the parent via `selected` (bindable) + `onSelect`.
   *
   * It is deliberately selection-only: it never publishes an attach. That keeps
   * it usable BOTH pre-creation (Create.svelte — the choice is folded into the
   * event when it's published) and, later, post-creation (Admin can attach on
   * pick). The parent decides what "picked" means; this component only surfaces
   * the discovery UX and validates the paste fallback.
   */
  import { onMount } from "svelte";
  import {
    fetchCoordinators,
    pricingLabel,
    httpsUrl,
    parseCoordinatorKey,
    type DiscoveredCoordinator,
  } from "$lib/events/coordinators.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    selected = $bindable(null),
    onSelect,
    disabled = false,
  }: {
    /** Chosen coordinator hex pubkey, or null when none is picked. */
    selected?: string | null;
    /** Called with the picked pubkey (or null on clear). */
    onSelect?: (pubkey: string | null) => void;
    disabled?: boolean;
  } = $props();

  let coordinators = $state<DiscoveredCoordinator[]>([]);
  let loading = $state(true);
  let pasteInput = $state("");
  let pasteError = $state<string | null>(null);

  // Discovery is a relay round-trip (cache-first), so kick it off on mount only —
  // never during SSR/init where NDK isn't connected.
  onMount(async () => {
    try {
      coordinators = await fetchCoordinators();
    } catch {
      coordinators = [];
    } finally {
      loading = false;
    }
  });

  // The picked coordinator's discovered announcement, if it came from the list
  // (a pasted npub won't be here — we fall back to showing the raw key).
  const selectedCoord = $derived(
    selected ? coordinators.find((c) => c.pubkey === selected) : undefined,
  );

  function pick(pubkey: string) {
    selected = pubkey;
    onSelect?.(pubkey);
  }

  function clear() {
    selected = null;
    pasteInput = "";
    pasteError = null;
    onSelect?.(null);
  }

  function applyPaste() {
    pasteError = null;
    const pubkey = parseCoordinatorKey(pasteInput);
    if (!pubkey) {
      pasteError = t("create.coordinator.invalidKey");
      return;
    }
    pick(pubkey);
    pasteInput = "";
  }
</script>

{#if loading}
  <p class="muted">{t("admin.coordinator.discovering")}</p>
{:else if coordinators.length}
  <div class="stack" style="gap:0.5rem;margin:0.5rem 0">
    {#each coordinators as c (c.pubkey)}
      <div class="card coord-card" class:selected={selected === c.pubkey}>
        <div class="row" style="gap:0.6rem;align-items:flex-start">
          {#if c.announce.picture}
            <img src={c.announce.picture} alt="" class="coord-logo" />
          {/if}
          <div style="flex:1;min-width:0">
            <strong>{c.announce.name}</strong>
            <span class="badge">{pricingLabel(c.announce)}</span>
            {#if c.announce.about}
              <p class="muted" style="margin:0.2rem 0 0;font-size:0.85rem">{c.announce.about}</p>
            {/if}
            <div class="row" style="flex-wrap:wrap;gap:0.3rem;margin-top:0.35rem">
              {#if c.announce.features?.matching}<span class="badge">{t("admin.coordinator.feat.matching")}</span>{/if}
              {#if c.announce.features?.talks}<span class="badge">{t("admin.coordinator.feat.talks")}</span>{/if}
              {#if c.announce.features?.chat?.length}<span class="badge">{t("admin.coordinator.feat.chat")}</span>{/if}
              {#if c.announce.privacy}
                {#each Object.entries(c.announce.privacy).filter(([, v]) => v !== "private") as [role] (role)}
                  <span class="badge warn">{role}: {t("admin.coordinator.nonPrivate")}</span>
                {/each}
              {/if}
            </div>
            <p class="muted mono" style="margin:0.35rem 0 0;font-size:0.72rem">{c.npub.slice(0, 20)}…</p>
          </div>
        </div>
        <div class="row" style="margin-top:0.5rem;gap:0.5rem;flex-wrap:wrap">
          <!-- terms_url comes from a SELF-PUBLISHED announcement: render only a
               parseable https: URL (audit APPR-1) — announcements already on
               relays predate the schema's https validation. -->
          {#if httpsUrl(c.announce.terms_url)}
            <a class="btn inline" href={httpsUrl(c.announce.terms_url)} target="_blank" rel="noopener noreferrer">{t("admin.coordinator.terms")}</a>
          {/if}
          {#if selected === c.pubkey}
            <button class="btn inline" onclick={clear} {disabled}>{t("create.coordinator.clear")}</button>
            <span class="badge ok">{t("create.coordinator.selected")}</span>
          {:else}
            <button class="btn inline primary" onclick={() => pick(c.pubkey)} {disabled}>
              {t("admin.coordinator.attachThis")}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <p class="muted" style="margin:0.5rem 0 0;font-size:0.8rem">{t("admin.coordinator.unverified")}</p>
{/if}

<!-- A pasted npub isn't in the discovered list — surface the picked key so the
     organizer can see (and clear) their choice regardless of where it came from. -->
{#if selected && !selectedCoord && !loading}
  <div class="row" style="gap:0.5rem;align-items:center;margin:0.5rem 0;flex-wrap:wrap">
    <span class="badge ok">{t("create.coordinator.selected")}</span>
    <span class="mono" style="font-size:0.72rem">{selected.slice(0, 20)}…</span>
    <button class="btn inline" onclick={clear} {disabled}>{t("create.coordinator.clear")}</button>
  </div>
{/if}

<!-- Advanced / fallback: paste an npub directly. -->
<details style="margin-top:0.5rem">
  <summary class="muted" style="cursor:pointer">{t("admin.coordinator.paste")}</summary>
  <input style="margin-top:0.5rem" placeholder={t("admin.coordinator.placeholder")} bind:value={pasteInput} {disabled} />
  {#if pasteError}<p class="muted" style="margin:0.35rem 0 0;color:var(--danger)">{pasteError}</p>{/if}
  <button class="btn" style="margin-top:0.5rem" onclick={applyPaste} disabled={disabled || !pasteInput.trim()}>
    {t("create.coordinator.use")}
  </button>
</details>

<style>
  .coord-card {
    background: var(--bg-elev2, transparent);
  }
  .coord-card.selected {
    outline: 2px solid var(--accent, #6c8cff);
  }
  .coord-logo {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    object-fit: cover;
    flex: none;
  }
</style>
