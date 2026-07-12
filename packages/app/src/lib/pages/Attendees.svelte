<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectory } from "$lib/events/attendee.js";
  import type { DirectoryEntryContent } from "@nostrautica/protocol";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let entries = $state<DirectoryEntryContent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      entries = await fetchDirectory(ctx);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
</script>

<h1>Who's here</h1>

{#if error}
  <div class="card warn">{error}</div>
{:else if loading}
  <p class="muted">Decrypting the roster…</p>
{:else if entries.length === 0}
  <div class="card">
    <p class="muted">
      No attendees visible yet. If you were just approved, give it a few seconds
      and refresh.
    </p>
  </div>
{:else}
  <p class="muted">{entries.length} attendee{entries.length === 1 ? "" : "s"}</p>
  <div class="stack">
    {#each entries as e (e.pubkey)}
      <button class="card" style="text-align:left;cursor:pointer" onclick={() => open(e.pubkey)}>
        <strong>{e.profile.about || "(no bio yet)"}</strong>
        {#if e.profile.skills.length}
          <div class="row" style="flex-wrap:wrap;margin-top:0.35rem">
            {#each e.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
          </div>
        {/if}
        {#if e.ai_profile}
          <p class="muted" style="margin-top:0.35rem">{e.ai_profile.summary}</p>
        {/if}
      </button>
    {/each}
  </div>
{/if}
