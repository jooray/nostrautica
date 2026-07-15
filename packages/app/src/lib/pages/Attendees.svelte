<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { DirectoryEntryContent, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectory, fetchMatches } from "$lib/events/attendee.js";
  import { fetchFollowSet, fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { loadPerEventSettings } from "$lib/events/settings.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { buildSearchText, matchesQuery } from "$lib/events/roster.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import PersonCard from "$lib/components/PersonCard.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { i18n, t, tp } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";

  let { naddr }: { naddr: string } = $props();

  const sortLabels: Record<"matches" | "follows" | "name", MessageKey> = {
    matches: "attendees.sort.matches",
    follows: "attendees.sort.follows",
    name: "attendees.sort.name",
  };

  type FilterKey = "want_to_meet" | "met" | "favorites" | "following";
  const filterLabels: Record<FilterKey, MessageKey> = {
    want_to_meet: "attendees.filter.wantToMeet",
    met: "attendees.filter.met",
    favorites: "attendees.filter.favorites",
    following: "attendees.filter.following",
  };

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let entries = $state<DirectoryEntryContent[]>([]);
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let followSet = $state<Set<string>>(new Set());
  let scores = $state<Map<string, number>>(new Map());
  let settings = $state<PerEventSettings | null>(null);
  let sortBy = $state<"matches" | "follows" | "name">("name");
  let query = $state("");
  let activeFilters = $state<Set<FilterKey>>(new Set());
  let loading = $state(true);
  let error = $state<unknown>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      entries = await fetchDirectory(ctx);
      profiles = await fetchProfiles(entries.map((e) => e.pubkey)).catch(() => new Map());
      if (session.signer) {
        void mutes.load(session.signer);
        followSet = await fetchFollowSet(session.signer).catch(() => new Set<string>());
        const bk = await deriveBlindingKey(session.signer).catch(() => null);
        if (bk) settings = await loadPerEventSettings(session.signer, ctx, bk).catch(() => null);
        if (ctx.config.coordinator) {
          const list = await fetchMatches(session.signer, ctx).catch(() => undefined);
          scores = new Map((list?.matches ?? []).map((m) => [m.pubkey, m.score]));
          if (scores.size > 0) sortBy = "matches";
        }
      }
    } catch (e) {
      error = e;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function nameOf(pubkey: string, about?: string): string {
    return profiles.get(pubkey)?.name || about?.slice(0, 40) || pubkey.slice(0, 10) + "…";
  }

  // Show the coordinator-published translation of an attendee's bio/skills when the
  // viewer reads the event language and the author wrote in a different one.
  const tr = (e: DirectoryEntryContent) => {
    const x = e.ai_profile?.translations;
    return x && x.lang === i18n.locale ? x : undefined;
  };
  const cardAbout = (e: DirectoryEntryContent) => tr(e)?.about || e.profile.about;
  const cardSkills = (e: DirectoryEntryContent) =>
    tr(e)?.skills?.length ? tr(e)!.skills! : e.profile.skills;

  function toggleFilter(f: FilterKey) {
    const next = new Set(activeFilters);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    activeFilters = next;
  }
  function passesFilter(pubkey: string): boolean {
    for (const f of activeFilters) {
      if (f === "following") {
        if (!followSet.has(pubkey)) return false;
      } else if (!settings?.[f]?.includes(pubkey)) {
        return false;
      }
    }
    return true;
  }

  // Roster, muted removed, then sorted, then search + filter chips applied.
  const sorted = $derived.by(() => {
    void profiles; // re-derive when profiles load
    const list = entries.filter((e) => !mutes.isMuted(e.pubkey));
    if (sortBy === "matches") {
      list.sort((a, b) => (scores.get(b.pubkey) ?? -1) - (scores.get(a.pubkey) ?? -1));
    } else if (sortBy === "follows") {
      list.sort((a, b) => Number(followSet.has(b.pubkey)) - Number(followSet.has(a.pubkey)));
    } else {
      list.sort((a, b) => nameOf(a.pubkey, a.profile.about).localeCompare(nameOf(b.pubkey, b.profile.about)));
    }
    return list;
  });

  const visible = $derived(
    sorted.filter((e) => {
      if (!passesFilter(e.pubkey)) return false;
      const hay = buildSearchText([
        nameOf(e.pubkey, e.profile.about),
        cardAbout(e),
        cardSkills(e),
        e.ai_profile?.summary,
      ]);
      return matchesQuery(hay, query);
    }),
  );

  const hasFilters = $derived(query.trim().length > 0 || activeFilters.size > 0);
  function clearFilters() {
    query = "";
    activeFilters = new Set();
  }

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
</script>

<h1 class="disp">{t("attendees.title")}</h1>

{#if error}
  <ErrorState {error} onRetry={load} retrying={loading} />
{:else if loading}
  <p class="muted">{t("attendees.decrypting")}</p>
{:else if entries.length === 0}
  <div class="card">
    <p class="muted">
      {t("attendees.empty")}
    </p>
    <button class="btn" onclick={() => router.go({ name: "event", naddr })}>
      {t("attendees.backToEvent")}
    </button>
  </div>
{:else}
  <div class="stack" style="gap:0.6rem">
    <label class="visually-hidden" for="roster-search">{t("attendees.search.label")}</label>
    <input
      id="roster-search"
      type="search"
      bind:value={query}
      placeholder={t("attendees.search.placeholder")}
    />
    {#if session.loggedIn}
      <div class="row" style="flex-wrap:wrap" role="group" aria-label={t("attendees.filter.label")}>
        {#each ["want_to_meet", "met", "favorites", "following"] as const as f (f)}
          <button
            class="btn inline"
            aria-pressed={activeFilters.has(f)}
            class:primary={activeFilters.has(f)}
            onclick={() => toggleFilter(f)}
          >
            {t(filterLabels[f])}
          </button>
        {/each}
        {#if hasFilters}
          <button class="btn inline" onclick={clearFilters}>{t("attendees.filter.clear")}</button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="row" style="justify-content:space-between;flex-wrap:wrap;margin-top:0.5rem">
    <p class="muted" role="status" aria-live="polite">
      {hasFilters ? tp("attendees.showing", visible.length) : tp("attendees.count", entries.length)}
    </p>
    <div class="row" role="group" aria-label={t("attendees.sort.label")}>
      {#each ["matches", "follows", "name"] as const as s (s)}
        <button class="btn inline" aria-pressed={sortBy === s} class:primary={sortBy === s} onclick={() => (sortBy = s)}>{t(sortLabels[s])}</button>
      {/each}
    </div>
  </div>

  {#if visible.length === 0}
    <div class="card">
      <p class="muted">{t("attendees.noResults")}</p>
      <button class="btn inline" onclick={clearFilters}>{t("attendees.filter.clear")}</button>
    </div>
  {:else}
    <div class="card roster">
      {#each visible as e (e.pubkey)}
        <PersonCard
          pubkey={e.pubkey}
          name={nameOf(e.pubkey, e.profile.about)}
          line={cardAbout(e) || e.ai_profile?.summary}
          picture={profiles.get(e.pubkey)?.picture}
          onOpen={() => open(e.pubkey)}
        >
          {#snippet trailing()}
            {#if scores.has(e.pubkey)}<span class="badge accent">{t("attendees.matchTag")}</span>{/if}
            {#if followSet.has(e.pubkey)}<span class="badge ok">{t("attendees.following")}</span>{/if}
          {/snippet}
        </PersonCard>
      {/each}
    </div>
  {/if}
{/if}

<style>
  h1.disp {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0;
  }
  .roster {
    padding: 0.25rem 0.9rem;
  }
</style>
