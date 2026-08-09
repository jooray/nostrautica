<script lang="ts">
  import { onMount } from "svelte";
  import { decode, nprofileEncode } from "nostr-tools/nip19";
  import { KIND_PROFILE, hasAiProfileContent } from "@nostrautica/protocol";
  import type { DirectoryEntryContent, Match, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { dmPrefill } from "$lib/stores/dm-prefill.svelte.js";
  import { connectNdk, fetchEvents } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectoryEntry, cachedDirectoryEntry, fetchMatches, cachedMatches } from "$lib/events/attendee.js";
  import { fetchFollowTags } from "$lib/events/nostr-actions.js";
  import { isFollowing } from "$lib/events/onboarding.js";
  import { fetchFollowersOf, fetchRecentPosts, cachedProfiles, type RecentPost } from "$lib/events/social.js";
  import { loadPerEventSettings, toggleSetting, setNote, cachedPerEventSettings } from "$lib/events/settings.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import { perfMark } from "$lib/perf.js";
  import MediaPlayer from "$lib/components/MediaPlayer.svelte";
  import PostView from "$lib/components/PostView.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import FollowButton from "$lib/components/FollowButton.svelte";
  import MatchDetails from "$lib/components/MatchDetails.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { i18n, t } from "$lib/i18n/i18n.svelte.js";
  import { copyText } from "$lib/util/clipboard.js";
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
  // The viewer's own match WITH this person, if the coordinator computed one
  // (UX feedback 2026-07-29): Matches → profile was a one-way door, so the
  // reasoning and icebreakers you came for vanished on arrival.
  let myMatch = $state<Match | null>(null);
  let copied = $state<"npub" | "nprofile" | null>(null);
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
        myMatch = cachedMatches(cached.coordinate)?.matches.find((m) => m.pubkey === pubkey) ?? null;
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
        // Refresh the match list in the background (SWR, like the entry above) —
        // a match computed since the last visit must not stay invisible here.
        // Non-members / no coordinator resolve to undefined; the section hides.
        void fetchMatches(session.signer, eventCtx)
          .then((list) => (myMatch = list?.matches.find((m) => m.pubkey === pubkey) ?? myMatch))
          .catch(() => {});
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

  // An ai_profile can exist with NOTHING in it: the coordinator publishes an
  // all-empty one when an attendee had no inputs at all to derive from (audit
  // COORD-4's empty-input skip). Rendering the card on mere presence showed a
  // heading over blank space (user report 2026-07-29) — gate on real content,
  // using the shared predicate so "empty" means the same thing here as it does
  // where the coordinator decides not to match on it.
  // `skills` is in the field list because it's the one ai_profile field this page
  // never rendered at all — an AI profile carrying only skills looked empty too.
  const aiSkills = $derived((entry?.ai_profile?.skills ?? []).filter((s) => !skillList.includes(s)));
  const aiFields = $derived(
    [
      ["skills", aiSkills],
      ["interests", entry?.ai_profile?.interests],
      ["offers", entry?.ai_profile?.offers],
      ["seeks", entry?.ai_profile?.seeks],
    ] as const,
  );
  const aiHasContent = $derived(hasAiProfileContent(entry?.ai_profile));

  // Public identity, one tap away (user feedback 2026-07-29). The nprofile carries
  // the event's own relays as hints — that's where we actually read this person's
  // records from, so it's the honest hint to hand another client. njump resolves
  // an nprofile, so the link gets the hints too.
  const nprofile = $derived(
    pubkey
      ? nprofileEncode({ pubkey, ...(ctx?.config.relays?.length ? { relays: ctx.config.relays.slice(0, 3) } : {}) })
      : "",
  );
  const njumpUrl = $derived(nprofile ? `https://njump.me/${nprofile}` : "");

  async function copyId(which: "npub" | "nprofile") {
    const value = which === "npub" ? npub : nprofile;
    if (!value) return;
    if ((await copyText(value)) === "copied") {
      copied = which;
      setTimeout(() => (copied = copied === which ? null : copied), 1500);
    }
  }

  // "Introduce us" (§9.3), same as the Matches tab: prefill the DM composer with
  // the coordinator's icebreaker so the introduction becomes an opening line.
  function introduce() {
    if (!session.loggedIn) return router.go({ name: "login" });
    const suggestion = myMatch?.icebreakers?.[0] || myMatch?.reasoning;
    if (suggestion) dmPrefill.set(pubkey, suggestion);
    router.go({ name: "dmPeer", npub });
  }
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
      {#each [...new Set(skillList)] as s (s)}<span class="badge">{s}</span>{/each}
    </div>
  {/if}

  {#if lookingForText}
    <p class="muted">{t("attendee.lookingFor", { value: lookingForText })}</p>
  {/if}

  {#if aiHasContent && entry?.ai_profile}
    <div class="card" style="background:var(--bg-elev2)">
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:0.4rem">
        <strong>{t("attendee.aiSummary")}</strong>
        {#if entry.ai_profile_edited}<span class="badge">{t("attendee.aiEdited")}</span>{/if}
      </div>
      {#if entry.ai_profile.summary}<p class="muted">{entry.ai_profile.summary}</p>{/if}
      {#each aiFields as [key, items] (key)}
        {#if items?.length}
          <div class="airow">
            <span class="muted small">{t(`profile.field.${key}`)}</span>
            <div class="row" style="flex-wrap:wrap">
              {#each [...new Set(items)] as it (it)}<span class="badge">{it}</span>{/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- Follow / Message / Mute side by side: three full-width buttons owned a whole
       screen of a phone viewport for actions you take once (user feedback
       2026-07-29). They wrap on a narrow viewport rather than shrinking. -->
  <div class="acts">
    {#if followKnown && pubkey}
      <!-- Same control as the roster row (`cta` skin): follow AND unfollow, with
           the action named in the tooltip. `pubkey` gates it because an
           undecodable npub must never publish a ["p", ""] tag (audit UX-23). -->
      <FollowButton
        variant="cta"
        {pubkey}
        name={displayName}
        {following}
        onChange={(f) => (following = f)}
      />
    {:else}
      <button class="btn inline primary" disabled>…</button>
    {/if}
    <button
      class="btn inline"
      onclick={() =>
        session.loggedIn ? router.go({ name: "dmPeer", npub }) : router.go({ name: "login" })}
    >
      {t("attendee.message")}
    </button>
    {#if muted}
      <button class="btn inline" onclick={toggleMute} disabled={busy}>{t("attendee.unmute")}</button>
    {:else}
      <button class="btn inline danger" onclick={() => (confirmMute = !confirmMute)} disabled={busy}>{t("attendee.mute")}</button>
    {/if}
  </div>

  <!-- Directly under the button that opened it, not below the identity chips. -->
  {#if confirmMute && !muted}
    <div class="card warn" style="margin-top:0.5rem">
      <p class="muted">{t("mute.confirm")}</p>
      <div class="row">
        <button class="btn danger" onclick={toggleMute} disabled={busy}>{t("attendee.mute")}</button>
        <button class="btn" onclick={() => (confirmMute = false)}>{t("attendee.mute.cancel")}</button>
      </div>
    </div>
  {/if}

  <!-- Public identity: copy it or open the person in any other Nostr client. The
       values themselves stay off-screen — nobody reads an npub, they paste it. -->
  <div class="ids">
    <button class="chip" onclick={() => copyId("npub")}>
      <Icon name={copied === "npub" ? "check" : "copy"} size={13} />
      {copied === "npub" ? t("attendee.id.copied") : t("attendee.id.copyNpub")}
    </button>
    <button class="chip" onclick={() => copyId("nprofile")}>
      <Icon name={copied === "nprofile" ? "check" : "copy"} size={13} />
      {copied === "nprofile" ? t("attendee.id.copied") : t("attendee.id.copyNprofile")}
    </button>
    <a class="chip" href={njumpUrl} target="_blank" rel="noopener noreferrer">
      {t("attendee.id.njump")}<Icon name="arrowUpRight" size={13} />
    </a>
  </div>
  <span class="visually-hidden" role="status">{copied ? t("attendee.id.copied") : ""}</span>
</div>

<!-- Why the coordinator paired you with this person, with the same conversation
     starters and "Introduce us" the Matches tab offers (user feedback
     2026-07-29). Hidden when there's no match: absence is not a finding worth a
     card, and non-members never get a list at all. -->
{#if myMatch}
  <div class="card match">
    <div class="field-label" style="margin-top:0">{t("attendee.yourMatch")}</div>
    <MatchDetails match={myMatch}>
      {#snippet actions()}
        <div class="mact">
          <button class="btn inline primary" onclick={introduce}>
            <Icon name="send" size={16} />{t("matches.introduce")}
          </button>
        </div>
      {/snippet}
    </MatchDetails>
  </div>
{/if}

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
  /* Primary actions on one row (they wrap before they squash). */
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }
  /* `:global` because FollowButton's root element is in another component, so
     Svelte's scoping class never lands on it. */
  .acts .btn,
  .acts :global(.follow) {
    flex: 1 1 auto;
  }
  /* Identity affordances: deliberately lighter than the actions above — a pill,
     not a button, but still a real 32px tap target. */
  .ids {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.55rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    min-height: 32px;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elev2);
    color: var(--text-dim);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 550;
    text-decoration: none;
    cursor: pointer;
  }
  .chip:hover {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  }
  .match {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .mact {
    display: flex;
  }
  .mact .btn {
    flex: 1;
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
