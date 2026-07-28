<script lang="ts">
  // Unified "Chat" pane (user feedback 2026-07-20): group chats (per event,
  // Marmot-enabled events you're not just a visitor of) and DM threads in one
  // place — previously DMs lived at the app root ("Messages") while group chat
  // only existed inside each event's own nav and vanished everywhere else,
  // so there was no single place to see "everything I'm part of". Group chats
  // stay resolvable straight from the event's own nav tab too (unchanged,
  // still the fast path while you're inside that event) — this is the "see
  // everything, including from outside an event" view. Starting a NEW
  // conversation still happens from the People pane (Attendee "Message"
  // button); this page only lists conversations that already exist.
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { isMarmotChatEnabled } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, cachedDms, threadsOf, type DmThread } from "$lib/events/dm.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { dmUnread } from "$lib/stores/dm-unread.svelte.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import { cachedEventContext } from "$lib/events/event-context.js";
  import { defaultEventIcon } from "$lib/media/image.js";
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

  $effect(() => {
    void cacheHydration.version;
    if (!session.pubkey) return;
    const cached = cachedDms(session.pubkey);
    if (cached.length === 0) return;
    dmUnread.syncMessages(session.pubkey, cached);
    if (threads.length > 0) return;
    threads = threadsOf(cached);
    loading = false;
  });

  // Group chats: events already visited where the viewer isn't just a "visitor"
  // (so presumably enrolled) and chat is on — cache-only, no network fetch, so
  // it never blocks first paint and never adds a loading state of its own. An
  // event whose chat later turns out unavailable (never approved, chat toggled
  // off since) still resolves gracefully — EventChat.svelte's own gate handles
  // that; this list is a fast-path shortcut, not a membership authority.
  const roleLabel = {
    organizer: "home.role.organizer",
    attendee: "home.role.attendee",
    visitor: "home.role.visitor",
  } as const;
  const groupChats = $derived(
    recentEvents.list.filter((e) => {
      if (e.role === "visitor") return false;
      const ctx = cachedEventContext(e.naddr);
      return !!ctx && isMarmotChatEnabled(ctx.config);
    }),
  );

  async function refresh() {
    if (!session.signer) return;
    try {
      void mutes.load(session.signer);
      const msgs = await fetchDms(session.signer);
      threads = threadsOf(msgs);
      if (session.pubkey) dmUnread.syncMessages(session.pubkey, msgs);
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
      dmUnread.acknowledgeEncryptedActivity();
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

<h1>{t("nav.chat")}</h1>

{#if !session.loggedIn}
  <div class="card">
    <p>{t("dm.loginToSee")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("dm.login")}</button>
  </div>
{:else}
  {#if groupChats.length}
    <h2>{t("chats.groupSection")}</h2>
    <div class="stack">
      {#each groupChats as e (e.naddr)}
        <button
          class="card row"
          style="text-align:left;cursor:pointer;gap:0.75rem;align-items:center;margin:0"
          onclick={() => router.go({ name: "chat", naddr: e.naddr })}
        >
          <img
            src={e.icon || defaultEventIcon(e.title, e.title)}
            alt=""
            width="44"
            height="44"
            style="border-radius:11px;flex:none"
          />
          <div style="flex:1;min-width:0">
            <strong style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {e.title}
            </strong>
            <span class="badge">{t(roleLabel[e.role])}</span>
          </div>
          <span class="muted">›</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="row" style="justify-content:space-between;align-items:center;gap:0.5rem">
    <h2 style="margin:0">{t("chats.dmSection")}</h2>
    <!-- Only offered when there is something to clear, so the control isn't a
         permanent no-op sitting next to an already-read inbox. -->
    {#if dmUnread.confirmedCount > 0 || dmUnread.hasEncryptedActivity}
      <button class="btn inline" style="flex:none" onclick={() => dmUnread.markAllRead()}>
        {t("dm.markAllRead")}
      </button>
    {/if}
  </div>
  {#if error && threads.length === 0}
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
          {#if dmUnread.threadCount(thread.peer) > 0}
            <span class="badge" aria-label={t("dm.unread", { n: dmUnread.threadCount(thread.peer) })}>
              {dmUnread.threadCount(thread.peer) > 99 ? "99+" : dmUnread.threadCount(thread.peer)}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/if}
