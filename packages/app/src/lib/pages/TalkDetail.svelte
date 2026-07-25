<script lang="ts">
  import { onMount } from "svelte";
  import type { TalkContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
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
  import { cachedProfiles, fetchProfiles, type ProfileMeta } from "$lib/events/social.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import ExternalTalkPlayer from "$lib/components/ExternalTalkPlayer.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { perfMark } from "$lib/perf.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, d }: { naddr: string; d: string } = $props();

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  // Cache-first (§2.5): the talk set was decrypted once — don't re-decrypt the
  // whole set on every open; paint this talk from cache, refresh in background.
  // svelte-ignore state_referenced_locally -- d is constant for this instance ({#key} remounts on change)
  let talk = $state<TalkContent | null>(
    cachedCtx ? (cachedTalk(cachedCtx.coordinate, d) ?? null) : null,
  );
  // Author profile (name + picture), resolved the same way the People list does —
  // cache-first with a background kind-0 refresh — so the detail header shows the
  // speaker's real avatar rather than an initials fallback when they have a kind-0.
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  let speaker = $state<ProfileMeta | undefined>(
    talk ? cachedProfiles([talk.pubkey]).get(talk.pubkey) : undefined,
  );
  const speakerName = $derived(speaker?.name ?? "");
  let resumeAt = $state(0);
  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
  let loading = $state(talk === null);
  let error = $state<unknown>(null);
  // Favorite marker (spec §13 report): local-only, keyed by the talk's blinded d.
  // svelte-ignore state_referenced_locally -- d is constant for this instance ({#key} remounts on change)
  let favorite = $state(cachedCtx ? isFavoriteTalk(cachedCtx.coordinate, d) : false);

  // svelte-ignore state_referenced_locally -- intentional one-time read of the initial cache-painted value
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
        // Watch-progress is keyed by the Blossom ciphertext hash; external
        // (YouTube/mp4) talks have no `media`, so there's nothing to resume.
        resumeAt = talk.media ? loadWatchProgress(ctx.coordinate, talk.media.x) : 0;
        // Resolve the author's kind-0 (name + picture) via the shared profile
        // cache so a photo shows and the fetch is deduped/persisted app-wide.
        const profiles = await fetchProfiles([talk.pubkey]);
        speaker = profiles.get(talk.pubkey) ?? speaker;
      }
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("TalkDetail", "network-settled");
    }
  });

  function onProgress(seconds: number) {
    if (ctx && talk?.media) saveWatchProgress(ctx.coordinate, talk.media.x, seconds);
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
      <Avatar pubkey={talk.pubkey} name={speakerName} picture={speaker?.picture} size={32} />
      <span class="muted">{speakerName || t("talks.speaker")}</span>
    </div>

    {#if resumeAt > 0}
      <p class="muted" style="font-size:0.8rem;margin:0.5rem 0 0" role="status">
        {t("talks.resuming", { sec: Math.floor(resumeAt) })}
      </p>
    {/if}

    <div style="margin:0.75rem 0">
      {#if talk.media}
        <MediaPlayer descriptor={talk.media} transcript={talk.transcript} {resumeAt} {onProgress} />
      {:else if talk.external_url && talk.external_kind}
        <ExternalTalkPlayer url={talk.external_url} kind={talk.external_kind} />
      {/if}
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
