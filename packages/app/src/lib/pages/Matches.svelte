<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { Match, DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchMatches, fetchDirectory } from "$lib/events/attendee.js";
  import { fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let matches = $state<Match[]>([]);
  let names = $state<Map<string, DirectoryEntryContent>>(new Map());
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let loading = $state(true);
  let error = $state<string | null>(null);
  let noCoordinator = $state(false);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (!ctx.config.coordinator) {
        noCoordinator = true;
        return;
      }
      if (!session.signer) return;
      const [list, directory] = await Promise.all([
        fetchMatches(session.signer, ctx),
        fetchDirectory(ctx),
      ]);
      matches = list?.matches ?? [];
      names = new Map(directory.map((e) => [e.pubkey, e]));
      profiles = await fetchProfiles(matches.map((m) => m.pubkey)).catch(() => new Map());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
  function pct(x: number) {
    return Math.round(x * 100);
  }
  function nameOf(pubkey: string): string {
    return profiles.get(pubkey)?.name || names.get(pubkey)?.profile.about?.slice(0, 40) || t("matches.name");
  }
</script>

{#if ctx}<EventHeader {ctx} compact link />{/if}
<h1>{t("matches.title")}</h1>

{#if error}
  <div class="card warn">{error}</div>
{:else if noCoordinator}
  <div class="card">
    <p class="muted">
      {t("matches.noCoordinator")}
    </p>
    <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
      {t("matches.seeWhosHere")}
    </button>
  </div>
{:else if loading}
  <p class="muted">{t("matches.fetching")}</p>
{:else if matches.length === 0}
  <div class="card">
    <p class="muted">
      {t("matches.none")}
    </p>
  </div>
{:else}
  <p class="muted">{t("matches.rankedNote")}</p>
  <div class="stack">
    {#each matches as m (m.pubkey)}
      <button class="card row" style="text-align:left;cursor:pointer;gap:0.75rem;align-items:flex-start" onclick={() => open(m.pubkey)}>
        {#if profiles.get(m.pubkey)?.picture}
          <img src={profiles.get(m.pubkey)!.picture} alt="" width="44" height="44" style="border-radius:50%;flex:none;object-fit:cover" />
        {/if}
        <div style="flex:1;min-width:0">
        <div class="row" style="justify-content:space-between;gap:0.5rem">
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{nameOf(m.pubkey)}</strong>
          <span class="badge" style="flex:none">{t("matches.matchPct", { pct: pct(m.score) })}</span>
        </div>
        <p style="margin:0.5rem 0">{m.reasoning}</p>
        <div class="row" style="flex-wrap:wrap">
          <span class="badge">{t("matches.similar", { pct: pct(m.similarity) })}</span>
          <span class="badge">{t("matches.complementary", { pct: pct(m.complementarity) })}</span>
        </div>
        </div>
      </button>
    {/each}
  </div>
{/if}
