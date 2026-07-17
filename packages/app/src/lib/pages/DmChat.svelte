<script lang="ts">
  // One NIP-17 conversation (spec §7.2 kind 14). Polls while open; optimistic
  // append on send so the chat feels instant even before relays echo the wrap.
  import { onMount, onDestroy, tick } from "svelte";
  import { decode, npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, cachedDms, sendDm, type DmMessage } from "$lib/events/dm.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";

  let { npub }: { npub: string } = $props();

  const peer = $derived.by(() => {
    try {
      const d = decode(npub);
      return d.type === "npub" ? (d.data as string) : null;
    } catch {
      return null;
    }
  });

  let messages = $state<DmMessage[]>([]);
  let profile = $state<ProfileMeta | undefined>(undefined);
  let draft = $state("");
  let loading = $state(true);
  let sending = $state(false);
  let error = $state<unknown>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let scroller = $state<HTMLDivElement | null>(null);
  let muteBusy = $state(false);
  const muted = $derived(!!peer && mutes.isMuted(peer));

  async function toggleMute() {
    if (!session.signer || !peer) return;
    muteBusy = true;
    try {
      await mutes.toggle(session.signer, peer);
    } catch (e) {
      error = e;
    } finally {
      muteBusy = false;
    }
  }

  async function refresh() {
    if (!session.signer || !peer) return;
    try {
      const all = await fetchDms(session.signer);
      const mine = all.filter((m) => m.peer === peer);
      const atBottom =
        !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      // Merge: relay results replace optimistic entries with the same text+minute.
      messages = mine;
      error = null;
      if (atBottom) {
        await tick();
        scroller?.scrollTo({ top: scroller.scrollHeight });
      }
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("DmChat", "network-settled");
    }
  }

  onMount(async () => {
    // Cache-first: paint the name/avatar the People list already fetched, so the
    // header isn't a bare npub while the network/signer is slow (user feedback
    // 2026-07-17). Refresh in the background.
    if (peer) profile = cachedProfiles([peer]).get(peer) ?? profile;
    // Cache-first thread (§2.6): paint prior messages from the persisted DM memo
    // before connectNdk()/the signer resolve, so the conversation isn't blank.
    if (peer && session.pubkey) {
      const cached = cachedDms(session.pubkey).filter((m) => m.peer === peer);
      if (cached.length) {
        messages = cached;
        loading = false;
        perfMark("DmChat", "cache-paint");
      }
    }
    await connectNdk();
    if (session.signer) void mutes.load(session.signer);
    if (peer) {
      void fetchProfiles([peer])
        .then((m) => {
          const p = m.get(peer);
          if (p) profile = p;
        })
        .catch(() => {});
    }
    await refresh();
    timer = setInterval(refresh, 5_000);
  });
  onDestroy(() => clearInterval(timer));

  let sendSlow = $state(false);
  async function send() {
    const text = draft.trim();
    if (!text || !session.signer || !peer || sending) return;
    sending = true;
    sendSlow = false;
    error = null;
    // If the signer (esp. a remote Amber/bunker) is slow to sign+encrypt, say so
    // rather than showing a silent spinner (user feedback 2026-07-17).
    const slowTimer = setTimeout(() => (sendSlow = true), 6_000);
    try {
      await sendDm(session.signer, peer, text);
      const me = await session.signer.getPublicKey();
      messages = [
        ...messages,
        { id: `local-${Date.now()}`, peer, from: me, text, at: Math.floor(Date.now() / 1000) },
      ];
      draft = "";
      await tick();
      scroller?.scrollTo({ top: scroller.scrollHeight });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(slowTimer);
      sendSlow = false;
      sending = false;
    }
  }

  const title = $derived(profile?.name || (peer ? npubEncode(peer).slice(0, 12) + "…" : t("dmchat.title")));
  function fmt(at: number): string {
    return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>

{#if !session.loggedIn}
  <div class="card">
    <p>{t("dmchat.loginToSend")}</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>{t("dmchat.login")}</button>
  </div>
{:else if !peer}
  <div class="card warn">{t("dmchat.invalidLink")}</div>
{:else}
  <div class="row" style="gap:0.75rem;margin:1rem 0 0.5rem">
    <Avatar pubkey={peer} name={profile?.name} picture={profile?.picture} size={40} />
    <h1 style="margin:0;font-size:1.25rem;flex:1;min-width:0">{title}</h1>
    <button class="btn inline" style="flex:none" onclick={toggleMute} disabled={muteBusy}>
      {muted ? t("attendee.unmute") : t("attendee.mute")}
    </button>
  </div>
  <p class="muted" style="margin:0 0 0.5rem">
    {t("dmchat.e2e")}
  </p>
  {#if muted}
    <p class="muted" role="status" style="margin:0 0 0.5rem">{t("mute.confirm")}</p>
  {/if}

  {#if error}
    <ErrorState {error} />
  {/if}

  <div
    bind:this={scroller}
    class="card"
    style="height:50dvh;overflow-y:auto;display:flex;flex-direction:column;gap:0.5rem"
  >
    {#if loading}
      <p class="muted">{t("dmchat.decrypting")}</p>
    {:else if messages.length === 0}
      <p class="muted">{t("dmchat.empty")}</p>
    {/if}
    {#each messages as m (m.id)}
      <div
        style="max-width:80%;padding:0.5rem 0.75rem;border-radius:12px;
          {m.from === m.peer
          ? 'align-self:flex-start;background:var(--bg-elev2)'
          : 'align-self:flex-end;background:var(--accent-soft)'}"
      >
        <span style="white-space:pre-wrap;word-break:break-word">{m.text}</span>
        <span class="muted" style="display:block;font-size:0.7rem;text-align:right">
          {fmt(m.at)}
        </span>
      </div>
    {/each}
  </div>

  <div class="row" style="align-items:flex-end">
    <textarea
      rows="2"
      placeholder={t("dmchat.placeholder")}
      bind:value={draft}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      }}
    ></textarea>
    <button
      class="btn primary inline"
      style="flex:none"
      onclick={send}
      disabled={sending || !draft.trim()}
    >
      {sending ? "…" : t("dmchat.send")}
    </button>
  </div>
  {#if sendSlow}
    <p class="muted" role="status" style="margin:0.4rem 0 0;font-size:0.85rem">{t("dmchat.signerSlow")}</p>
  {/if}
{/if}
