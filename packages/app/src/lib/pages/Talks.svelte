<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchTalks, cachedTalks, type TalkItem } from "$lib/events/talks.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  // Cache-first paint (§2.5): last-seen talks render instantly, then refresh.
  let items = $state<TalkItem[]>(cachedCtx ? (cachedTalks(cachedCtx.coordinate) ?? []) : []);
  let loading = $state(items.length === 0);
  let error = $state<unknown>(null);
  let gatedOff = $state(false);

  if (items.length) perfMark("Talks", "cache-paint");

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Hard gate (spec F2): a talks-off event has no Talks surface at all.
      if (ctx.config.talks === "off") {
        gatedOff = true;
        return;
      }
      items = await fetchTalks(ctx);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("Talks", "network-settled");
    }
  });
</script>

<h1>{t("talks.title")}</h1>

{#if error}<ErrorState {error} />{/if}

{#if gatedOff}
  <div class="card"><p class="muted">{t("talks.disabled")}</p></div>
{:else if loading}
  <div class="card"><p class="muted">{t("app.loading")}</p></div>
{:else}
  {#if session.loggedIn}
    <div class="row" style="margin-bottom:0.75rem">
      <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: true })}>
        {t("talks.submit")}
      </button>
    </div>
  {/if}

  {#if items.length === 0}
    <div class="card" role="status">
      <strong>{t("talks.empty.title")}</strong>
      <p class="muted">{t("talks.empty.body")}</p>
    </div>
  {:else}
    <div class="stack">
      {#each items as it (it.d)}
        <button class="card talk-card" onclick={() => router.go({ name: "talk", naddr, d: it.d })}>
          <div class="row" style="align-items:flex-start;gap:0.6rem">
            <Avatar pubkey={it.talk.pubkey} size={40} />
            <div style="flex:1;min-width:0;text-align:left">
              <strong>{it.talk.title}</strong>
              {#if it.talk.description}
                <p class="muted" style="margin:0.25rem 0 0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">
                  {it.talk.description}
                </p>
              {/if}
              <div class="row" style="flex-wrap:wrap;margin-top:0.35rem">
                <span class="badge">{it.talk.media.kind === "talk" ? t("record.kind.talk") : t("record.kind.intro")}{it.talk.media.duration ? ` · ${it.talk.media.duration}s` : ""}</span>
                {#if it.talk.transcript}<span class="badge">{t("talks.hasTranscript")}</span>{/if}
              </div>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .talk-card {
    width: 100%;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    font: inherit;
    color: inherit;
  }
</style>
