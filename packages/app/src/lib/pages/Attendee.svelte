<script lang="ts">
  import { onMount } from "svelte";
  import { decode } from "nostr-tools/nip19";
  import { KIND_PROFILE } from "@nostrautica/protocol";
  import type { DirectoryEntryContent, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectoryEntry, cachedDirectoryEntry } from "$lib/events/attendee.js";
  import { followUser, fetchFollowTags } from "$lib/events/nostr-actions.js";
  import { isFollowing } from "$lib/events/onboarding.js";
  import { fetchFollowersOf, fetchRecentPosts, cachedProfiles, type RecentPost } from "$lib/events/social.js";
  import { loadPerEventSettings, toggleSetting, setNote, cachedPerEventSettings } from "$lib/events/settings.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import { perfMark } from "$lib/perf.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import PostView from "$lib/components/PostView.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";

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
  let loading = $state(true);
  let followKnown = $state(false); // don't offer "Follow" before we know
  let error = $state<unknown>(null);
  let confirmMute = $state(false);
  let showAnyway = $state(false);
  // Hard route failure (audit UX-23): an undecodable npub must render an error,
  // not an interactive empty profile whose Follow would publish ["p", ""].
  let invalidNpub = $state(false);
  let followQueued = $state(false); // follow sits in the offline outbox (UX-15)
  const muted = $derived(!!pubkey && mutes.isMuted(pubkey));

  onMount(async () => {
    try {
      const decoded = decode(npub);
      if (decoded.type !== "npub") throw new Error(t("attendee.error.badNpub"));
      pubkey = decoded.data;

      // Cache-first paint: if People/Matches already fetched this person, show
      // them instantly (name, picture, bio, skills) and refresh in the
      // background — never a blank page while everything re-fetches.
      const cached = cachedEventContext(naddr);
      ctx = cached ?? null;
      const cachedMeta = cachedProfiles([pubkey]).get(pubkey);
      if (cachedMeta) kind0 = { name: cachedMeta.name, picture: cachedMeta.picture, about: cachedMeta.about };
      if (cached) {
        entry = cachedDirectoryEntry(cached.coordinate, pubkey) ?? null;
        // Cached per-event settings (want-to-meet/met/note) paint instantly (§2.8).
        settings = cachedPerEventSettings(cached.coordinate) ?? null;
        if (settings) noteDraft = settings.notes[pubkey] ?? "";
      }
      if (kind0 || entry) {
        loading = false;
        perfMark("Attendee", "cache-paint");
      }

      await connectNdk();
      if (!ctx) ctx = await loadEventContext(naddr);
      const eventCtx = ctx;

      // Three independent fetches — each updates its own slice, none blocks the
      // others or the page. The directory entry comes from the in-memory cache
      // when possible (no whole-directory re-pull just to show one person).
      void fetchEvents({ kinds: [KIND_PROFILE], authors: [pubkey] })
        .then((events) => {
          const latest = events.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
          if (latest) {
            try {
              kind0 = JSON.parse(latest.content);
            } catch {
              /* keep cached */
            }
          }
          loading = false;
        })
        .catch(() => (loading = false));

      // Paint the cached entry instantly, but ALWAYS refresh from relays in the
      // background too (SWR — CACHING-PLAN §3.4) — this used to be an if/else
      // that skipped the network fetch entirely whenever any cached entry
      // existed, so a person's updated profile/intro (e.g. after their record
      // flow) could stay invisible to viewers who'd already cached the older
      // (e.g. approval-time, empty-profile) snapshot, forever, even across
      // reloads now that the cache is persistent (caching verification
      // 2026-07-17).
      const cachedEntry = cachedDirectoryEntry(eventCtx.coordinate, pubkey);
      if (cachedEntry) entry = cachedEntry;
      void fetchDirectoryEntry(eventCtx, pubkey)
        .then((e) => {
          if (e) entry = e;
          loading = false;
        })
        .catch(() => {});

      void fetchRecentPosts(pubkey, 20)
        .then((recent) => (posts = recent))
        .catch(() => {});

      if (session.signer) {
        void mutes.load(session.signer);
        const me = await session.signer.getPublicKey();
        // Bound the follow-list fetch (audit UX-10): an unbounded fetch on a bad
        // network left the Follow button at "…" forever. On timeout we enable
        // the button anyway — followUser's empty-list guard surfaces any real
        // failure readably on tap.
        const tags = await Promise.race([
          fetchFollowTags(session.signer),
          new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
        ]);
        if (tags) following = isFollowing(tags, pubkey);
        followKnown = true;
        followsYou = (await fetchFollowersOf(me, [pubkey])).has(pubkey);
        blindingKey = await deriveBlindingKey(session.signer);
        settings = await loadPerEventSettings(session.signer, eventCtx, blindingKey);
        noteDraft = settings.notes[pubkey] ?? "";
      } else {
        followKnown = true;
      }
      perfMark("Attendee", "network-settled");
    } catch (e) {
      // A decode failure above leaves pubkey empty — hard-fail the route
      // instead of rendering an interactive empty profile (audit UX-23).
      if (!pubkey) invalidNpub = true;
      else if (!kind0 && !entry) error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      followKnown = true;
    }
  });

  async function follow() {
    if (!session.signer) return router.go({ name: "login" });
    if (!pubkey) return; // never publish a ["p", ""] tag (audit UX-23)
    busy = true;
    try {
      const published = await followUser(session.signer, pubkey);
      following = true;
      // Queued for the offline flush, not published yet (audit UX-15).
      if (!published) {
        followQueued = true;
        outbox.noteQueued();
      }
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

  async function toggleMute() {
    if (!session.signer) return router.go({ name: "login" });
    busy = true;
    error = null;
    try {
      await mutes.toggle(session.signer, pubkey);
      confirmMute = false;
      showAnyway = false;
    } catch (e) {
      error = e;
    } finally {
      busy = false;
    }
  }

  const displayName = $derived(
    kind0?.name || entry?.name || entry?.profile.about?.slice(0, 40) || t("attendee.name"),
  );
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

{#if error}<ErrorState {error} />{/if}

{#if invalidNpub}
  <!-- No interactive shell for a malformed link (audit UX-23). -->
  <div class="card warn" role="alert">
    <strong>{t("attendee.error.badNpub")}</strong>
    <p class="muted" style="margin:0.25rem 0 0">{t("attendee.error.badNpub.body")}</p>
  </div>
{:else if loading}
  <!-- Never render a bare "Attendee + Follow" shell while data is in flight
       (user feedback 2026-07-16) — show that we're working. -->
  <div class="card" role="status" aria-label={t("app.loading")}>
    <div class="row">
      <span class="sk-avatar"></span>
      <span class="sk-line" style="width:10rem"></span>
    </div>
    <div class="sk-line" style="width:85%;margin-top:0.8rem"></div>
    <div class="sk-line" style="width:60%;margin-top:0.5rem"></div>
  </div>
{:else if muted && !showAnyway}
  <div class="card" role="status">
    <strong>{t("attendee.muted.title")}</strong>
    <p class="muted">{t("mute.confirm")}</p>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn primary" onclick={toggleMute} disabled={busy}>{t("attendee.unmute")}</button>
      <button class="btn" onclick={() => (showAnyway = true)}>{t("attendee.showAnyway")}</button>
    </div>
  </div>
{:else}
<div class="card">
  <div class="row">
    <Avatar {pubkey} name={displayName} picture={kind0?.picture} size={56} />
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

  {#if entry?.intro_text}
    <!-- Text intro (spec F1): the primary content when there's no recording. -->
    <div class="card" style="background:var(--bg-elev2);margin:0.75rem 0">
      <strong>{t("attendee.textIntro")}</strong>
      <p style="margin:0.35rem 0 0;white-space:pre-wrap">{entry.intro_text}</p>
    </div>
  {/if}

  {#if entry?.media?.length}
    {#each entry.media.filter((m) => m.kind === "intro") as m (m.x)}
      <div style="margin:0.75rem 0">
        <MediaPlayer descriptor={m} transcript={entry.transcripts?.find((tr) => tr.x === m.x)} />
      </div>
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
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:0.4rem">
        <strong>{t("attendee.aiSummary")}</strong>
        {#if entry.ai_profile_edited}<span class="badge">{t("attendee.aiEdited")}</span>{/if}
      </div>
      {#if entry.ai_profile.summary}<p class="muted">{entry.ai_profile.summary}</p>{/if}
      {#each [["interests", entry.ai_profile.interests], ["offers", entry.ai_profile.offers], ["seeks", entry.ai_profile.seeks]] as const as [key, items] (key)}
        {#if items?.length}
          <div class="airow">
            <span class="muted small">{t(`profile.field.${key}`)}</span>
            <div class="row" style="flex-wrap:wrap">
              {#each items as it (it)}<span class="badge">{it}</span>{/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <div class="row" style="flex-wrap:wrap">
    <button class="btn primary" onclick={follow} disabled={busy || following || !followKnown}>
      {!followKnown
        ? "…"
        : following
          ? t("attendee.following")
          : busy
            ? t("attendee.followingBusy")
            : t("attendee.follow")}
    </button>
    <button
      class="btn"
      onclick={() =>
        session.loggedIn ? router.go({ name: "dmPeer", npub }) : router.go({ name: "login" })}
    >
      {t("attendee.message")}
    </button>
    {#if followQueued}
      <p class="muted" role="status" style="width:100%;margin:0">{t("sync.queued")}</p>
    {/if}
    {#if muted}
      <button class="btn" onclick={toggleMute} disabled={busy}>{t("attendee.unmute")}</button>
    {:else}
      <button class="btn danger" onclick={() => (confirmMute = !confirmMute)} disabled={busy}>{t("attendee.mute")}</button>
    {/if}
  </div>

  {#if confirmMute && !muted}
    <div class="card warn" style="margin-top:0.5rem">
      <p class="muted">{t("mute.confirm")}</p>
      <div class="row">
        <button class="btn danger" onclick={toggleMute} disabled={busy}>{t("attendee.mute")}</button>
        <button class="btn" onclick={() => (confirmMute = false)}>{t("attendee.mute.cancel")}</button>
      </div>
    </div>
  {/if}
</div>

{#if settings}
  <div class="card stack">
    <div class="field-label" id="private-label">{t("attendee.private")}</div>
    <div class="row" style="flex-wrap:wrap" role="group" aria-labelledby="private-label">
      <!-- "Favorite" retired (user feedback 2026-07-16) — want-to-meet/met say it better. -->
      <button class="btn inline" aria-pressed={has(settings.want_to_meet)} class:primary={has(settings.want_to_meet)} onclick={() => toggle("want_to_meet")}>{t("attendee.wantToMeet")}</button>
      <button class="btn inline" aria-pressed={has(settings.met)} class:primary={has(settings.met)} onclick={() => toggle("met")}>{t("attendee.met")}</button>
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
{/if}

<style>
  .small {
    font-size: 0.8rem;
  }
  .airow {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }
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
  .sk-avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--bg-elev2, rgba(128, 128, 128, 0.15));
    animation: sk-pulse 1.2s ease-in-out infinite;
    flex: none;
  }
  .sk-line {
    height: 0.85rem;
    border-radius: 0.45rem;
    background: var(--bg-elev2, rgba(128, 128, 128, 0.15));
    animation: sk-pulse 1.2s ease-in-out infinite;
  }
  @keyframes sk-pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sk-avatar,
    .sk-line {
      animation: none;
    }
  }
</style>
