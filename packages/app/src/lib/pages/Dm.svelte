<script lang="ts">
  // DM inbox (spec §7.2 kind 14): threads grouped by peer, newest first.
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, threadsOf, type DmThread } from "$lib/events/dm.js";
  import { fetchProfiles, type ProfileMeta } from "$lib/events/social.js";

  let threads = $state<DmThread[]>([]);
  let profiles = $state<Map<string, ProfileMeta>>(new Map());
  let loading = $state(true);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    if (!session.signer) return;
    try {
      const msgs = await fetchDms(session.signer);
      threads = threadsOf(msgs);
      const missing = threads.map((t) => t.peer).filter((p) => !profiles.has(p));
      if (missing.length) {
        const fetched = await fetchProfiles(missing);
        profiles = new Map([...profiles, ...fetched]);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await connectNdk();
    await refresh();
    timer = setInterval(refresh, 10_000);
  });
  onDestroy(() => clearInterval(timer));

  function nameOf(pubkey: string): string {
    return profiles.get(pubkey)?.name || npubEncode(pubkey).slice(0, 12) + "…";
  }
  function fmt(at: number): string {
    return new Date(at * 1000).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<h1>Messages</h1>

{#if !session.loggedIn}
  <div class="card">
    <p>Log in to see your messages.</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>Log in</button>
  </div>
{:else if error}
  <div class="card warn">
    <strong>Couldn't load messages.</strong>
    <span class="muted">{error}</span>
  </div>
{:else if loading}
  <p class="muted">Decrypting your messages…</p>
{:else if threads.length === 0}
  <div class="card">
    <p class="muted">
      No messages yet. Open someone's profile in an event's attendee list and tap
      <strong>Message</strong> to start a conversation. Messages are end-to-end
      encrypted and work with other Nostr messengers too.
    </p>
  </div>
{:else}
  <div class="stack">
    {#each threads as t (t.peer)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center;margin:0"
        onclick={() => router.go({ name: "dmPeer", npub: npubEncode(t.peer) })}
      >
        {#if profiles.get(t.peer)?.picture}
          <img
            src={profiles.get(t.peer)?.picture}
            alt=""
            width="44"
            height="44"
            style="border-radius:50%;object-fit:cover;flex:none"
          />
        {/if}
        <div style="flex:1;min-width:0">
          <div class="row" style="justify-content:space-between">
            <strong>{nameOf(t.peer)}</strong>
            <span class="muted" style="font-size:0.75rem;flex:none">{fmt(t.last.at)}</span>
          </div>
          <span
            class="muted"
            style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >
            {t.last.from === t.peer ? "" : "You: "}{t.last.text}
          </span>
        </div>
      </button>
    {/each}
  </div>
{/if}
