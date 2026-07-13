<script lang="ts">
  // DM inbox (spec §7.2 kind 14): threads grouped by peer, newest first.
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, threadsOf, type DmThread } from "$lib/events/dm.js";
  import { fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

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

<h1>{t("dm.title")}</h1>

{#if !session.loggedIn}
  <div class="card">
    <p>{t("dm.loginToSee")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("dm.login")}</button>
  </div>
{:else if error}
  <div class="card warn">
    <strong>{t("dm.loadFailed")}</strong>
    <span class="muted">{error}</span>
  </div>
{:else if loading}
  <p class="muted">{t("dm.decrypting")}</p>
{:else if threads.length === 0}
  <div class="card">
    <p class="muted">
      {t("dm.empty")}
    </p>
  </div>
{:else}
  <div class="stack">
    {#each threads as thread (thread.peer)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center;margin:0"
        onclick={() => router.go({ name: "dmPeer", npub: npubEncode(thread.peer) })}
      >
        {#if profiles.get(thread.peer)?.picture}
          <img
            src={profiles.get(thread.peer)?.picture}
            alt=""
            width="44"
            height="44"
            style="border-radius:50%;object-fit:cover;flex:none"
          />
        {/if}
        <div style="flex:1;min-width:0">
          <div class="row" style="justify-content:space-between">
            <strong>{nameOf(thread.peer)}</strong>
            <span class="muted" style="font-size:0.75rem;flex:none">{fmt(thread.last.at)}</span>
          </div>
          <span
            class="muted"
            style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >
            {thread.last.from === thread.peer ? "" : t("dm.youPrefix")}{thread.last.text}
          </span>
        </div>
      </button>
    {/each}
  </div>
{/if}
