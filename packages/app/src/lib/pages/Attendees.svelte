<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectory, fetchMatches } from "$lib/events/attendee.js";
  import { fetchFollowSet, fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import EventHeader from "$lib/components/EventHeader.svelte";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let entries = $state<DirectoryEntryContent[]>([]);
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let followSet = $state<Set<string>>(new Set());
  let scores = $state<Map<string, number>>(new Map());
  let sortBy = $state<"matches" | "follows" | "name">("name");
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      entries = await fetchDirectory(ctx);
      profiles = await fetchProfiles(entries.map((e) => e.pubkey)).catch(() => new Map());
      if (session.signer) {
        followSet = await fetchFollowSet(session.signer).catch(() => new Set<string>());
        if (ctx.config.coordinator) {
          const list = await fetchMatches(session.signer, ctx).catch(() => undefined);
          scores = new Map((list?.matches ?? []).map((m) => [m.pubkey, m.score]));
          if (scores.size > 0) sortBy = "matches";
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  function nameOf(pubkey: string, about?: string): string {
    return profiles.get(pubkey)?.name || about?.slice(0, 40) || pubkey.slice(0, 10) + "…";
  }

  const sorted = $derived.by(() => {
    void profiles; // re-derive when profiles load
    const list = [...entries];
    if (sortBy === "matches") {
      list.sort((a, b) => (scores.get(b.pubkey) ?? -1) - (scores.get(a.pubkey) ?? -1));
    } else if (sortBy === "follows") {
      list.sort((a, b) => Number(followSet.has(b.pubkey)) - Number(followSet.has(a.pubkey)));
    } else {
      list.sort((a, b) => nameOf(a.pubkey, a.profile.about).localeCompare(nameOf(b.pubkey, b.profile.about)));
    }
    return list;
  });

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
</script>

{#if ctx}<EventHeader {ctx} compact link />{/if}
<h1>Who's here</h1>

{#if error}
  <div class="card warn">{error}</div>
{:else if loading}
  <p class="muted">Decrypting the roster…</p>
{:else if entries.length === 0}
  <div class="card">
    <p class="muted">No attendees visible yet. If you were just approved, refresh in a moment.</p>
  </div>
{:else}
  <div class="row" style="justify-content:space-between">
    <p class="muted">{entries.length} attendee{entries.length === 1 ? "" : "s"}</p>
    <div class="row">
      {#each ["matches", "follows", "name"] as const as s (s)}
        <button class="btn inline" class:primary={sortBy === s} onclick={() => (sortBy = s)}>{s}</button>
      {/each}
    </div>
  </div>
  <div class="stack">
    {#each sorted as e (e.pubkey)}
      <button class="card row" style="text-align:left;cursor:pointer;gap:0.75rem;align-items:flex-start" onclick={() => open(e.pubkey)}>
        {#if profiles.get(e.pubkey)?.picture}
          <img src={profiles.get(e.pubkey)!.picture} alt="" width="44" height="44" style="border-radius:50%;flex:none;object-fit:cover" />
        {/if}
        <div style="flex:1;min-width:0">
          <div class="row" style="justify-content:space-between;gap:0.5rem">
            <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{nameOf(e.pubkey, e.profile.about)}</strong>
            <div class="row" style="flex:none">
              {#if scores.has(e.pubkey)}<span class="badge">{Math.round(scores.get(e.pubkey)! * 100)}%</span>{/if}
              {#if followSet.has(e.pubkey)}<span class="badge">following</span>{/if}
            </div>
          </div>
          {#if e.profile.about}<p class="muted" style="margin:0.15rem 0 0">{e.profile.about}</p>{/if}
          {#if e.profile.skills.length}
            <div class="row" style="flex-wrap:wrap;margin-top:0.35rem">
              {#each e.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
            </div>
          {/if}
          {#if e.ai_profile}<p class="muted" style="margin-top:0.35rem">{e.ai_profile.summary}</p>{/if}
        </div>
      </button>
    {/each}
  </div>
{/if}
