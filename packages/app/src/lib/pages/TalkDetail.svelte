<script lang="ts">
  import { onMount } from "svelte";
  import type { TalkContent } from "@nostrautica/protocol";
  import { KIND_PROFILE } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import {
    fetchTalk,
    cachedTalk,
    saveWatchProgress,
    loadWatchProgress,
    setTalkEditDraft,
    isFavoriteTalk,
    toggleFavoriteTalk,
  } from "$lib/events/talks.js";
  import { cachedProfiles } from "$lib/events/social.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, d }: { naddr: string; d: string } = $props();

  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  // Cache-first (§2.5): the talk set was decrypted once — don't re-decrypt the
  // whole set on every open; paint this talk from cache, refresh in background.
  let talk = $state<TalkContent | null>(
    cachedCtx ? (cachedTalk(cachedCtx.coordinate, d) ?? null) : null,
  );
  let speakerName = $state(
    talk ? (cachedProfiles([talk.pubkey]).get(talk.pubkey)?.name ?? "") : "",
  );
  let resumeAt = $state(0);
  let loading = $state(talk === null);
  let error = $state<unknown>(null);
  // Favorite marker (spec §13 report): local-only, keyed by the talk's blinded d.
  let favorite = $state(cachedCtx ? isFavoriteTalk(cachedCtx.coordinate, d) : false);

  if (talk) perfMark("TalkDetail", "cache-paint");

  function toggleFavorite() {
    if (!ctx) return;
    const next = toggleFavoriteTalk(ctx.coordinate, d);
    favorite = next.includes(d);
  }

  const isOwn = $derived(!!talk && !!session.pubkey && talk.pubkey === session.pubkey);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (ctx.config.talks === "off") return;
      if (!talk) talk = cachedTalk(ctx.coordinate, d) ?? null;
      talk = (await fetchTalk(ctx, d)) ?? talk;
      if (talk) {
        resumeAt = loadWatchProgress(ctx.coordinate, talk.media.x);
        const profiles = await fetchEvents({ kinds: [KIND_PROFILE], authors: [talk.pubkey] });
        const latest = profiles.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
        if (latest) {
          try {
            speakerName = JSON.parse(latest.content).name ?? "";
          } catch {
            /* no name */
          }
        }
      }
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("TalkDetail", "network-settled");
    }
  });

  function onProgress(seconds: number) {
    if (ctx && talk) saveWatchProgress(ctx.coordinate, talk.media.x, seconds);
  }

  function editTalk() {
    if (!talk) return;
    setTalkEditDraft({
      talkId: talk.talk_d,
      title: talk.title,
      description: talk.description,
      revision: talk.revision,
    });
    router.go({ name: "record", naddr, talk: true });
  }
</script>

<button class="btn inline" style="margin:0.5rem 0" onclick={() => router.go({ name: "talks", naddr })}>
  {t("talks.back")}
</button>

{#if error}<ErrorState {error} />{/if}

{#if loading}
  <div class="card"><p class="muted">{t("app.loading")}</p></div>
{:else if !talk}
  <div class="card" role="status"><p class="muted">{t("talks.notFound")}</p></div>
{:else}
  <div class="card">
    <div class="row" style="align-items:flex-start;justify-content:space-between;gap:0.5rem">
      <h1 style="margin:0 0 0.5rem">{talk.title}</h1>
      <button
        class="btn inline icon-btn"
        aria-pressed={favorite}
        class:primary={favorite}
        title={favorite ? t("talks.favorite.remove") : t("talks.favorite.add")}
        aria-label={favorite ? t("talks.favorite.remove") : t("talks.favorite.add")}
        onclick={toggleFavorite}
      >
        <Icon name="star" size={18} />
      </button>
    </div>
    <div class="row" style="align-items:center;gap:0.5rem">
      <Avatar pubkey={talk.pubkey} name={speakerName} size={32} />
      <span class="muted">{speakerName || t("talks.speaker")}</span>
    </div>

    {#if resumeAt > 0}
      <p class="muted" style="font-size:0.8rem;margin:0.5rem 0 0" role="status">
        {t("talks.resuming", { sec: Math.floor(resumeAt) })}
      </p>
    {/if}

    <div style="margin:0.75rem 0">
      <MediaPlayer descriptor={talk.media} transcript={talk.transcript} {resumeAt} {onProgress} />
    </div>

    {#if talk.description}
      <p style="white-space:pre-wrap">{talk.description}</p>
    {/if}

    {#if isOwn}
      <div class="row" style="margin-top:0.5rem">
        <button class="btn" onclick={editTalk}>{t("talks.edit")}</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .icon-btn {
    padding: 0.4rem 0.5rem;
    line-height: 0;
    flex: none;
  }
</style>
