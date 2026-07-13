<script lang="ts">
  // One NIP-17 conversation (spec §7.2 kind 14). Polls while open; optimistic
  // append on send so the chat feels instant even before relays echo the wrap.
  import { onMount, onDestroy, tick } from "svelte";
  import { decode, npubEncode } from "nostr-tools/nip19";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { fetchDms, sendDm, type DmMessage } from "$lib/events/dm.js";
  import { fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

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
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let scroller = $state<HTMLDivElement | null>(null);

  async function refresh() {
    if (!session.signer || !peer) return;
    try {
      const all = await fetchDms(session.signer);
      const mine = all.filter((m) => m.peer === peer);
      const atBottom =
        !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      // Merge: relay results replace optimistic entries with the same text+minute.
      messages = mine;
      if (atBottom) {
        await tick();
        scroller?.scrollTo({ top: scroller.scrollHeight });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await connectNdk();
    if (peer) profile = (await fetchProfiles([peer])).get(peer);
    await refresh();
    timer = setInterval(refresh, 5_000);
  });
  onDestroy(() => clearInterval(timer));

  async function send() {
    const text = draft.trim();
    if (!text || !session.signer || !peer || sending) return;
    sending = true;
    error = null;
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
    {#if profile?.picture}
      <img
        src={profile.picture}
        alt=""
        width="40"
        height="40"
        style="border-radius:50%;object-fit:cover;flex:none"
      />
    {/if}
    <h1 style="margin:0;font-size:1.25rem">{title}</h1>
  </div>
  <p class="muted" style="margin:0 0 0.5rem">
    {t("dmchat.e2e")}
  </p>

  {#if error}
    <div class="card warn"><span class="muted">{error}</span></div>
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
{/if}
