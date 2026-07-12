<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { Match, DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchMatches, fetchDirectory } from "$lib/events/attendee.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let matches = $state<Match[]>([]);
  let names = $state<Map<string, DirectoryEntryContent>>(new Map());
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
</script>

<h1>People you should meet</h1>

{#if error}
  <div class="card warn">{error}</div>
{:else if noCoordinator}
  <div class="card">
    <p class="muted">
      This event has no AI coordinator attached, so there are no matches. Browse
      the attendee directory instead.
    </p>
    <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
      See who's here
    </button>
  </div>
{:else if loading}
  <p class="muted">Fetching your matches…</p>
{:else if matches.length === 0}
  <div class="card">
    <p class="muted">
      No matches yet — they appear once the coordinator has processed a few
      attendees. Check back soon.
    </p>
  </div>
{:else}
  <p class="muted">Ranked by how much you'd get from meeting — with the reasoning.</p>
  <div class="stack">
    {#each matches as m (m.pubkey)}
      <button class="card" style="text-align:left;cursor:pointer" onclick={() => open(m.pubkey)}>
        <div class="row" style="justify-content:space-between">
          <strong>{names.get(m.pubkey)?.profile.about?.slice(0, 40) || "Attendee"}</strong>
          <span class="badge">{pct(m.score)}% match</span>
        </div>
        <p style="margin:0.5rem 0">{m.reasoning}</p>
        <div class="row" style="flex-wrap:wrap">
          <span class="badge">similar {pct(m.similarity)}%</span>
          <span class="badge">complementary {pct(m.complementarity)}%</span>
        </div>
      </button>
    {/each}
  </div>
{/if}
