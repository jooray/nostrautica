<script lang="ts">
  import { onMount } from "svelte";
  import { decode } from "nostr-tools/nip19";
  import { KIND_PROFILE } from "@nostrautica/protocol";
  import type { DirectoryEntryContent, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectoryEntry } from "$lib/events/attendee.js";
  import { followUser, fetchFollowTags } from "$lib/events/nostr-actions.js";
  import { isFollowing } from "$lib/events/onboarding.js";
  import { fetchFollowersOf, fetchRecentPosts, type RecentPost } from "$lib/events/social.js";
  import { loadPerEventSettings, toggleSetting, setNote } from "$lib/events/settings.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import PostView from "$lib/components/PostView.svelte";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";

  let { naddr, npub }: { naddr: string; npub: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let pubkey = $state<string>("");
  let kind0 = $state<Record<string, any> | null>(null);
  let entry = $state<DirectoryEntryContent | null>(null);
  let following = $state(false);
  let followsYou = $state(false);
  let posts = $state<RecentPost[]>([]);
  let settings = $state<PerEventSettings | null>(null);
  let blindingKey: Uint8Array | null = null;
  let noteDraft = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const decoded = decode(npub);
      if (decoded.type !== "npub") throw new Error(t("attendee.error.badNpub"));
      pubkey = decoded.data;
      await connectNdk();
      ctx = await loadEventContext(naddr);
      const [profileEvents, dirEntry, recent] = await Promise.all([
        fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] }),
        fetchDirectoryEntry(ctx, pubkey),
        fetchRecentPosts(pubkey, 20),
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
      posts = recent;
      if (session.signer) {
        const me = await session.signer.getPublicKey();
        following = isFollowing(await fetchFollowTags(session.signer), pubkey);
        followsYou = (await fetchFollowersOf(me, [pubkey])).has(pubkey);
        blindingKey = await deriveBlindingKey(session.signer);
        settings = await loadPerEventSettings(session.signer, ctx, blindingKey);
        noteDraft = settings.notes[pubkey] ?? "";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function follow() {
    if (!session.signer) return router.go({ name: "login" });
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

  async function toggle(list: "favorites" | "want_to_meet" | "met") {
    if (!session.signer || !ctx || !blindingKey) return;
    settings = await toggleSetting(session.signer, ctx, blindingKey, list, pubkey);
  }

  async function saveNote() {
    if (!session.signer || !ctx || !blindingKey) return;
    settings = await setNote(session.signer, ctx, blindingKey, pubkey, noteDraft);
  }

  const displayName = $derived(kind0?.name || entry?.profile.about?.slice(0, 40) || t("attendee.name"));
  const has = (list?: string[]) => !!list?.includes(pubkey);

  // A coordinator-published translation of the user's authored fields into the
  // event language. Offer it when the viewer reads that language and the author
  // wrote in a different one. The original is always one tap away.
  const translation = $derived(entry?.ai_profile?.translations);
  const canTranslate = $derived(!!translation && translation.lang === i18n.locale);
  // Default to the translated view when it's available (attendee reads event lang).
  let showTranslated = $state(true);
  const useTranslated = $derived(canTranslate && showTranslated);
  const aboutText = $derived(
    (useTranslated && translation?.about) || entry?.profile.about || kind0?.about || "",
  );
  const lookingForText = $derived(
    (useTranslated && translation?.looking_for) || entry?.profile.looking_for || "",
  );
  const skillList = $derived(
    (useTranslated && translation?.skills?.length ? translation.skills : entry?.profile.skills) ?? [],
  );
</script>

<button class="btn inline" style="margin:0.5rem 0" onclick={() => router.go({ name: "attendees", naddr })}>
  {t("attendee.back")}
</button>

{#if error}<div class="card warn">{error}</div>{/if}

<div class="card">
  <div class="row">
    {#if kind0?.picture}
      <img src={kind0.picture} alt="" width="56" height="56" style="border-radius:50%" />
    {/if}
    <div>
      <h1 style="margin:0">{displayName}</h1>
      <div class="row" style="flex-wrap:wrap">
        {#if following}<span class="badge">{t("attendee.youFollow")}</span>{/if}
        {#if followsYou}<span class="badge">{t("attendee.followsYou")}</span>{/if}
      </div>
    </div>
  </div>

  {#if canTranslate}
    <div class="row" style="margin-top:0.5rem;align-items:baseline;gap:0.4rem">
      {#if useTranslated}<span class="badge">{t("attendee.translated")}</span>{/if}
      <button class="linklike" onclick={() => (showTranslated = !showTranslated)}>
        {useTranslated ? t("attendee.showOriginal") : t("attendee.showTranslation")}
      </button>
    </div>
  {/if}

  {#if aboutText}
    <p style="margin-top:0.75rem">{aboutText}</p>
  {/if}

  {#if entry?.media?.length}
    {#each entry.media.filter((m) => m.kind === "intro") as m (m.x)}
      <div style="margin:0.75rem 0"><MediaPlayer descriptor={m} /></div>
    {/each}
  {/if}

  {#if skillList.length}
    <div class="row" style="flex-wrap:wrap">
      {#each skillList as s (s)}<span class="badge">{s}</span>{/each}
    </div>
  {/if}

  {#if lookingForText}
    <p class="muted">{t("attendee.lookingFor", { value: lookingForText })}</p>
  {/if}

  {#if entry?.ai_profile}
    <div class="card" style="background:var(--bg-elev2)">
      <strong>{t("attendee.aiSummary")}</strong>
      <p class="muted">{entry.ai_profile.summary}</p>
    </div>
  {/if}

  <div class="row">
    <button class="btn primary" onclick={follow} disabled={busy || following}>
      {following ? t("attendee.following") : busy ? t("attendee.followingBusy") : t("attendee.follow")}
    </button>
    <button
      class="btn"
      onclick={() =>
        session.loggedIn ? router.go({ name: "dmPeer", npub }) : router.go({ name: "login" })}
    >
      {t("attendee.message")}
    </button>
  </div>
</div>

{#if settings}
  <div class="card stack">
    <div class="field-label">{t("attendee.private")}</div>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn inline" class:primary={has(settings.favorites)} onclick={() => toggle("favorites")}>{t("attendee.favorite")}</button>
      <button class="btn inline" class:primary={has(settings.want_to_meet)} onclick={() => toggle("want_to_meet")}>{t("attendee.wantToMeet")}</button>
      <button class="btn inline" class:primary={has(settings.met)} onclick={() => toggle("met")}>{t("attendee.met")}</button>
    </div>
    <textarea rows="2" placeholder={t("attendee.note.placeholder")} bind:value={noteDraft} onblur={saveNote}></textarea>
  </div>
{/if}

{#if posts.length}
  <h2>{t("attendee.recentPosts")}</h2>
  <div class="stack">
    {#each posts as p (p.id)}<PostView post={p} />{/each}
  </div>
{/if}

<style>
  .linklike {
    width: auto;
    min-height: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    text-decoration: underline;
  }
</style>
