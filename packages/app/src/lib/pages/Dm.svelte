<script lang="ts">
  // DM inbox (spec §7.2 kind 14): threads grouped by peer, newest first.
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, cachedDms, threadsOf, type DmThread } from "$lib/events/dm.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";

  // Cache-first (§2.6): DM history from the persisted unwrap memo paints the
  // thread list before connectNdk() even resolves — no "Decrypting…" wait.
  const cachedThreads = session.pubkey ? threadsOf(cachedDms(session.pubkey)) : [];
  let threads = $state<DmThread[]>(cachedThreads);
  let profiles = $state<Map<string, ProfileMeta>>(
    cachedProfiles(cachedThreads.map((th) => th.peer)),
  );
  let loading = $state(cachedThreads.length === 0);
  let error = $state<unknown>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  if (cachedThreads.length) perfMark("Dm", "cache-paint");

  // Muted peers drop out of the thread list (U10).
  const visibleThreads = $derived(threads.filter((th) => !mutes.isMuted(th.peer)));

  async function refresh() {
    if (!session.signer) return;
    try {
      void mutes.load(session.signer);
      const msgs = await fetchDms(session.signer);
      threads = threadsOf(msgs);
      const missing = threads.map((t) => t.peer).filter((p) => !profiles.has(p));
      if (missing.length) {
        const fetched = await fetchProfiles(missing);
        profiles = new Map([...profiles, ...fetched]);
      }
      error = null;
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("Dm", "network-settled");
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
{:else if error && threads.length === 0}
  <ErrorState {error} onRetry={refresh} retrying={loading} />
{:else if loading}
  <p class="muted">{t("dm.decrypting")}</p>
{:else if visibleThreads.length === 0}
  <div class="card">
    <p class="muted">
      {t("dm.empty")}
    </p>
  </div>
{:else}
  <div class="stack">
    {#each visibleThreads as thread (thread.peer)}
      <button
        class="card row"
        style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center;margin:0"
        onclick={() => router.go({ name: "dmPeer", npub: npubEncode(thread.peer) })}
      >
        <Avatar pubkey={thread.peer} name={nameOf(thread.peer)} picture={profiles.get(thread.peer)?.picture} size={44} />
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
