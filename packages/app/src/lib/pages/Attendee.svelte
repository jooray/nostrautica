<script lang="ts" module>
  import { profileDisplayName } from "$lib/events/social.js";

  /**
   * The name at the top of an attendee's page, in the order this app trusts its
   * three sources: their live kind-0, the name frozen into their directory entry
   * at join time, then a slice of their event bio, then the generic fallback.
   *
   * The kind-0 step goes through `profileDisplayName` — it used to read the raw
   * `name` field off the parsed content, which is the ONE field the rest of the
   * app does not prefer. Everything else (the People roster, matches, talk
   * cards, DM headers) resolves names through `fetchProfiles`, which resolves
   * `display_name` first, so the same person could be "Ada Lovelace" in the
   * roster and "ada1815" on the page you opened by tapping that row. Worse, the
   * wrong name arrived SECOND here: the cache paint below uses the already-
   * resolved cached meta, then the relay fetch overwrote `kind0` with the raw
   * content and the heading changed under the reader.
   *
   * Pure and exported so the precedence is unit-testable without a browser (the
   * same reason Attendees.svelte exports its empty-state classifier).
   */
  export function attendeeDisplayName(
    kind0: unknown,
    entry: { name?: string; profile?: { about?: string } } | null | undefined,
    fallback: string,
  ): string {
    return (
      profileDisplayName(kind0) ||
      entry?.name ||
      entry?.profile?.about?.slice(0, 40) ||
      fallback
    );
  }
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
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
  import { viewport } from "$lib/stores/viewport.svelte.js";
  import { STRONG_FLOOR, bandAtCut, strongCutFor } from "$lib/events/confidence.js";
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
  /**
   * The viewer's own "strong" cut, carried alongside the single match: the band
   * depends on the WHOLE match list (confidence.ts), which this page otherwise
   * throws away after picking one entry out of it. Defaulting to the bare floor
   * means a match shown before any list has loaded is banded conservatively
   * rather than optimistically.
   */
  let strongCut = $state(STRONG_FLOOR);
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
        const cachedList = cachedMatches(cached.coordinate)?.matches;
        if (cachedList) strongCut = strongCutFor(cachedList);
        myMatch = cachedList?.find((m) => m.pubkey === pubkey) ?? null;
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
          .then((list) => {
            if (list) strongCut = strongCutFor(list.matches);
            myMatch = list?.matches.find((m) => m.pubkey === pubkey) ?? myMatch;
          })
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
        // Never over the top of something they're mid-way through writing.
        if (!noteTouched) noteDraft = settings.notes[pubkey] ?? "";
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

  // These run from click handlers, which cannot await them. A rejection (signer
  // said no, relay refused, blinding key gone) therefore became an unhandled
  // promise rejection — invisible to the user and a paused debugger for anyone
  // developing with "break on uncaught". Surface it through the same `error`
  // channel the rest of the page already uses.
  async function toggle(list: "favorites" | "want_to_meet" | "met") {
    if (!session.signer || !ctx || !blindingKey) return;
    try {
      settings = await toggleSetting(session.signer, ctx, blindingKey, list, pubkey);
    } catch (e) {
      error = e;
    }
  }

  /**
   * The private note, saved as you type rather than on blur.
   *
   * `onblur` alone silently lost work: removing a focused element from the DOM
   * does NOT fire blur, so navigating away mid-note (the back button, a tap on
   * the bottom nav, the route swapping under a slow relay) discarded everything
   * typed since the field was focused — with no indication it had ever been at
   * risk. A debounce keeps the write rate sane; the visible "Saved" is there
   * because a note that saves invisibly is a note the user re-types to be sure.
   */
  const NOTE_SAVE_DEBOUNCE_MS = 800;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let noteState = $state<"idle" | "saving" | "saved">("idle");
  let noteSavedTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The user has typed in this field. The mount pass paints the CACHED settings
   * first (so the note appears instantly) and then overwrites `noteDraft` from
   * the freshly loaded ones — which, if they've already started typing into the
   * cache-painted field, throws their words away mid-sentence. Harmless while
   * blur was the only save; with save-as-you-type it is the difference between
   * a note that persists and one that is silently replaced by the old value.
   */
  let noteTouched = false;
  onDestroy(() => {
    clearTimeout(noteTimer);
    clearTimeout(noteSavedTimer);
  });

  function noteChanged() {
    noteTouched = true;
    clearTimeout(noteTimer);
    noteState = "saving";
    noteTimer = setTimeout(() => void saveNote(), NOTE_SAVE_DEBOUNCE_MS);
  }

  /** Flush immediately — blur still fires when it fires, and it shouldn't wait. */
  function flushNote() {
    clearTimeout(noteTimer);
    if (noteState === "saving") void saveNote();
  }

  async function saveNote() {
    if (!session.signer || !ctx || !blindingKey) return;
    try {
      settings = await setNote(session.signer, ctx, blindingKey, pubkey, noteDraft);
      noteState = "saved";
      clearTimeout(noteSavedTimer);
      noteSavedTimer = setTimeout(() => (noteState = "idle"), 2000);
    } catch (e) {
      noteState = "idle";
      error = e;
    }
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

  const displayName = $derived(attendeeDisplayName(kind0, entry, t("attendee.name")));
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
  /**
   * Their CURRENT Nostr bio, shown alongside the event bio when the two differ.
   *
   * `entry.profile.about` is one field with two meanings and no flag to tell
   * them apart: for anyone who joined before 2026-09-13 it is a verbatim copy of
   * their kind-0 bio frozen at join, and for anyone who edited it in MyProfile
   * it is a bio deliberately written for this event. Preferring kind 0 would
   * silently clobber the second; preferring the entry is the reported bug, where
   * a user updates their Nostr profile and Nostrautica shows the old one
   * forever.
   *
   * So neither wins and nothing is guessed — when the two texts differ, both are
   * on the page and the reader can see which is which. Empty when the entry has
   * no authored bio, because then the line above IS the kind-0 bio already.
   */
  const nostrAbout = $derived.by(() => {
    const live = kind0?.about?.trim();
    if (!live) return "";
    return live === aboutText.trim() ? "" : live;
  });
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

{#if error}<ErrorState {error} body={mutes.unreadable ? "mute.unreadable" : undefined} />{/if}

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

  {#if nostrAbout}
    <div class="nostr-about">
      <div class="field-label">{t("attendee.nostrAbout")}</div>
      <p class="muted">{nostrAbout}</p>
    </div>
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
  </div>

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
    <!-- Mute lives with the utilities, not with Follow and Message: it is rare,
         it is about you rather than about them, and as a `danger` button third
         in the primary row it was the loudest control on the page. -->
    {#if muted}
      <button class="chip" onclick={toggleMute} disabled={busy}>{t("attendee.unmute")}</button>
    {:else}
      <button class="chip mute" onclick={() => (confirmMute = !confirmMute)} disabled={busy} aria-expanded={confirmMute}>
        {t("attendee.mute")}
      </button>
    {/if}
  </div>

  <!-- Directly under the control that opened it. -->
  {#if confirmMute && !muted}
    <div class="card warn" style="margin-top:0.5rem">
      <p class="muted">{t("mute.confirm")}</p>
      <div class="row">
        <button class="btn danger" onclick={toggleMute} disabled={busy}>{t("attendee.mute")}</button>
        <button class="btn" onclick={() => (confirmMute = false)}>{t("attendee.mute.cancel")}</button>
      </div>
    </div>
  {/if}
  <span class="visually-hidden" role="status">{copied ? t("attendee.id.copied") : ""}</span>
</div>

<!-- Why the coordinator paired you with this person, with the same conversation
     starters and "Introduce us" the Matches tab offers (user feedback
     2026-07-29). Hidden when there's no match: absence is not a finding worth a
     card, and non-members never get a list at all. -->
{#if myMatch}
  <div class="card match">
    <div class="field-label" style="margin-top:0">{t("attendee.yourMatch")}</div>
    <MatchDetails match={myMatch} band={bandAtCut(myMatch.score, strongCut)} showReasoning={!viewport.wide}>
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
      <button class="btn inline" aria-pressed={has(settings.want_to_meet)} class:primary={has(settings.want_to_meet)} onclick={() => void toggle("want_to_meet")}>{t("attendee.wantToMeet")}</button>
      <button class="btn inline" aria-pressed={has(settings.met)} class:primary={has(settings.met)} onclick={() => void toggle("met")}>{t("attendee.met")}</button>
    </div>
    <label class="visually-hidden" for="private-note">{t("attendee.note.placeholder")}</label>
    <textarea
      id="private-note"
      rows="2"
      placeholder={t("attendee.note.placeholder")}
      bind:value={noteDraft}
      oninput={noteChanged}
      onblur={flushNote}
    ></textarea>
    <!-- role="status", not aria-live on the textarea's own container: this
         announces once per completed save, not per keystroke. -->
    <span class="muted small" role="status">
      {#if noteState === "saving"}{t("profile.saving")}{:else if noteState === "saved"}{t("profile.saved")}{/if}
    </span>
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
  .nostr-about {
    margin-top: 0.75rem;
  }
  .nostr-about p {
    margin: 0.15rem 0 0;
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
  .chip.mute:hover {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
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
