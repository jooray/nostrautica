<script lang="ts">
  import { onMount } from "svelte";
  import { decode } from "nostr-tools/nip19";
  import { KIND_PROFILE } from "@nostrautica/protocol";
  import type { DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectoryEntry } from "$lib/events/attendee.js";
  import { followUser, fetchFollowTags } from "$lib/events/nostr-actions.js";
  import { isFollowing } from "$lib/events/onboarding.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";

  let { naddr, npub }: { naddr: string; npub: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let pubkey = $state<string>("");
  let kind0 = $state<Record<string, any> | null>(null);
  let entry = $state<DirectoryEntryContent | null>(null);
  let following = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const decoded = decode(npub);
      if (decoded.type !== "npub") throw new Error("bad npub");
      pubkey = decoded.data;
      await connectNdk();
      ctx = await loadEventContext(naddr);
      const [profileEvents, dirEntry] = await Promise.all([
        fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] }),
        fetchDirectoryEntry(ctx, pubkey),
      ]);
      const latest = profileEvents.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
      if (latest) {
        try {
          kind0 = JSON.parse(latest.content);
        } catch {
          kind0 = null;
        }
      }
      entry = dirEntry ?? null;
      if (session.signer) {
        following = isFollowing(await fetchFollowTags(session.signer), pubkey);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function follow() {
    if (!session.signer) {
      router.go({ name: "login" });
      return;
    }
    busy = true;
    try {
      await followUser(session.signer, pubkey);
      following = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const displayName = $derived(kind0?.name || entry?.profile.about?.slice(0, 40) || "Attendee");
</script>

{#if error}<div class="card warn">{error}</div>{/if}

<div class="card">
  <div class="row">
    {#if kind0?.picture}
      <img src={kind0.picture} alt="" width="56" height="56" style="border-radius:50%" />
    {/if}
    <div>
      <h1 style="margin:0">{displayName}</h1>
      {#if following}<span class="badge">You follow</span>{/if}
    </div>
  </div>

  {#if kind0?.about || entry?.profile.about}
    <p style="margin-top:0.75rem">{entry?.profile.about || kind0?.about}</p>
  {/if}

  {#if entry?.media?.length}
    {#each entry.media.filter((m) => m.kind === "intro") as m (m.x)}
      <div style="margin:0.75rem 0"><MediaPlayer descriptor={m} /></div>
    {/each}
  {/if}

  {#if entry?.profile.skills?.length}
    <div class="row" style="flex-wrap:wrap">
      {#each entry.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
    </div>
  {/if}

  {#if entry?.profile.looking_for}
    <p class="muted">Looking for: {entry.profile.looking_for}</p>
  {/if}

  {#if entry?.ai_profile}
    <div class="card" style="background:var(--bg-elev2)">
      <strong>AI summary</strong>
      <p class="muted">{entry.ai_profile.summary}</p>
    </div>
  {/if}

  <button class="btn primary" onclick={follow} disabled={busy || following}>
    {following ? "Following ✓" : busy ? "Following…" : "Follow"}
  </button>
</div>
