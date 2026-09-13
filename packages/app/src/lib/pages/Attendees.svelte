<script lang="ts" module>
  import type { RelayHealth } from "$lib/nostr/ndk.js";

  /**
   * Why the roster is empty. The page used to have exactly two states — "error
   * thrown" and "everything else" — so ONE string ("No attendees visible … if
   * you haven't joined yet, that's why; if you were just approved, refresh in a
   * moment") had to cover three unrelated situations. It was actively wrong for
   * the most likely reader: an approved attendee standing in the venue whose
   * Wi-Fi blocks WSS. Nothing threw — `streamDirectory` simply never heard back —
   * so they were told they probably hadn't joined an event they were standing in.
   *
   * `hasKey` is the honest membership signal: `streamDirectory` returns undefined
   * when there is no ECK on this device, which is exactly "not approved (yet)".
   * Relay reachability comes from the same signal the connectivity banner uses,
   * so "the venue Wi-Fi is lying" is diagnosed the same way everywhere.
   *
   * Pure so the three-way split is unit-testable without a browser.
   */
  export type RosterEmptyReason = "loading" | "notApproved" | "staleKey" | "unreachable" | "none";
  export function rosterEmptyReason(s: {
    /**
     * Directory entries arrived that this device could not decrypt (audit EV-9).
     * Outranks everything except `loading`: it is positive evidence that people
     * ARE here, which makes every other empty-state sentence false.
     */
    undecryptable?: number;
    loading: boolean;
    /** An ECK is present, i.e. streamDirectory handed back a live stream. */
    hasKey: boolean;
    /** navigator.onLine. */
    online: boolean;
    relay: RelayHealth;
  }): RosterEmptyReason {
    if (s.loading) return "loading";
    if (!s.hasKey) return "notApproved";
    // Entries came back and none of them opened. Holding an ECK (`hasKey`) says
    // nothing about whether it is the CURRENT one — a revoked member, or one whose
    // grant for a rotation has not landed, holds a stale key and decrypts nothing.
    // They were shown "Nobody is on the list yet", which is a claim about the
    // event, and the wrong one: the people are there, this device cannot read them.
    if ((s.undecryptable ?? 0) > 0) return "staleKey";
    // "connected" is the only state that licenses the claim "the list really is
    // empty" — idle/connecting/failed all mean we never got an answer worth
    // believing, and offline settles it outright.
    if (!s.online || s.relay !== "connected") return "unreachable";
    return "none";
  }
</script>

<script lang="ts">
  /**
   * People — the merged roster + matches surface (2026-09-13).
   *
   * Ľudia and Spojenia were two tabs about the same 44 people: one that could
   * follow and mark "want to meet" but never said why anyone mattered, and one
   * that explained why but offered neither action. Merging them was easy; the
   * hard question was whether a merged list can carry the reasoning without
   * becoming a wall of prose, or has to hide it behind a tap.
   *
   * Measuring the real coordinator output settled it: 1026 reasonings run 168
   * chars median and 276 max — four phone lines, seven worst case. The old match
   * card was ~373px for ~96px of reasoning. The reasoning was never what made
   * the list long; the chrome around it was. So every match here shows its full
   * reasoning, unclamped and un-collapsed, and the band that used to be a pill on
   * every card is now the heading over a run of them (said once, not N times).
   *
   * Sections are the sort, which is why the three sort chips are gone: matched
   * people lead, in band order, and everyone else follows by name. Searching or
   * filtering dissolves the sections into one flat result list, because a result
   * set has no band structure worth preserving.
   *
   * The "worth a hello" band deliberately does NOT get full entries — it is the
   * tail of a top-10 and would dilute the read. It folds into the directory as a
   * tagged row instead. The exception is the attendee with no strong and no good
   * match (12% of real users): featuring nothing for them would be the one case
   * where this page says nothing at all, so their best band is promoted and the
   * lead line says plainly that nothing here is sharp yet.
   */
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { DirectoryEntryContent, PerEventSettings, Match } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk, relayHealth } from "$lib/nostr/ndk.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { streamDirectory, fetchMatches, cachedDirectory, cachedMatches, type DirectoryStream } from "$lib/events/attendee.js";
  import { fetchFollowSet, fetchProfiles, cachedProfiles, cachedFollowSet, type ProfileMeta } from "$lib/events/social.js";
  import { loadPerEventSettings, toggleSetting, cachedPerEventSettings } from "$lib/events/settings.js";
  import { perfMark } from "$lib/perf.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { directoryEntryFields, searchRank } from "$lib/events/search.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import { dmPrefill } from "$lib/stores/dm-prefill.svelte.js";
  import { whatsNew } from "$lib/stores/whats-new.svelte.js";
  import { loadWatermark, newMatchPubkeys } from "$lib/events/whats-new.js";
  import { readinessStore } from "$lib/events/readiness.svelte.js";
  import { bandAtCut, byMatchRank, strongCutFor, type ConfidenceBand } from "$lib/events/confidence.js";
  import PersonCard from "$lib/components/PersonCard.svelte";
  import MatchEntry from "$lib/components/MatchEntry.svelte";
  import ConfidenceBadge from "$lib/components/ConfidenceBadge.svelte";
  import FollowButton from "$lib/components/FollowButton.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { i18n, t, tp } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";

  let { naddr }: { naddr: string } = $props();

  // "Favorites" retired (user feedback 2026-07-16): three clear categories —
  // planning (want to meet), done (met), and the Nostr graph (following).
  type FilterKey = "want_to_meet" | "met" | "following";
  const filterLabels: Record<FilterKey, MessageKey> = {
    want_to_meet: "attendees.filter.wantToMeet",
    met: "attendees.filter.met",
    following: "attendees.filter.following",
  };

  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  const cachedCtx = cachedEventContext(naddr);
  // Cache-first paint (§2.3): the roster/directory/follows/settings the app has
  // seen render instantly on revisit; the stream + social refresh in background.
  const cachedEntries = cachedCtx ? (cachedDirectory(cachedCtx.coordinate) ?? []) : [];
  const cachedMatchList = cachedCtx ? cachedMatches(cachedCtx.coordinate) : undefined;
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let entries = $state<DirectoryEntryContent[]>(cachedEntries);
  let profiles = $state<Map<string, ProfileMeta>>(
    cachedProfiles(cachedEntries.map((e) => e.pubkey)),
  );
  // svelte-ignore state_referenced_locally -- read once for the initial paint
  const cachedFollows = cachedFollowSet();
  let followSet = $state<Set<string>>(cachedFollows ?? new Set());
  // Whether the follow set is actually KNOWN. An unfetched set is all-absent,
  // which is indistinguishable from "follows nobody here" — fine for hiding a
  // badge, a lie for a button that would then read "not following" and offer to
  // follow someone the user already follows. Until we know, no button.
  let followsKnown = $state(cachedFollows !== undefined);
  let matchList = $state<Match[]>(cachedMatchList?.matches ?? []);
  /**
   * Which matches are new since the last visit. Captured ONCE, from the
   * watermark as it stood before this visit — `markMatchesSeen` then clears the
   * nav badge, and reading the watermark afterwards would always return "none
   * new" and the markers would never appear.
   */
  let newPubkeys = $state<Set<string>>(new Set());
  let settings = $state<PerEventSettings | null>(
    cachedCtx ? (cachedPerEventSettings(cachedCtx.coordinate) ?? null) : null,
  );
  let query = $state("");
  let activeFilters = $state<Set<FilterKey>>(new Set());
  let loading = $state(cachedEntries.length === 0);
  let error = $state<unknown>(null);
  // Whether the LAST completed pass had an event key (see rosterEmptyReason).
  // Starts true so a cache-painted roster never flashes "you're not approved".
  let hasKey = $state(true);
  /** Entries that arrived and would not decrypt under this device's ECK (EV-9). */
  let undecryptableCount = $state(0);
  // Relay health as of the last settled pass. Sampled rather than read live so
  // the empty state doesn't flicker between reasons on the connectivity poll.
  let relayAtSettle = $state<RelayHealth>("connecting");
  /** Whether this event has a coordinator at all — no coordinator, no matches. */
  let matchingOn = $state(!!cachedCtx?.config.coordinator);

  if (cachedEntries.length) perfMark("Attendees", "cache-paint");

  // Cache-paint after background hydration (§7.4.5): boot no longer waits on the
  // mirror, so re-read the roster/directory snapshots when hydration lands while
  // the list is still empty.
  $effect(() => {
    void cacheHydration.version;
    if (entries.length > 0) return;
    const c = cachedEventContext(naddr);
    if (!c) return;
    ctx ??= c;
    const de = cachedDirectory(c.coordinate) ?? [];
    if (de.length === 0) return;
    entries = de;
    profiles = cachedProfiles(de.map((e) => e.pubkey));
    const cf = cachedFollowSet();
    if (cf) {
      followSet = cf;
      followsKnown = true;
    }
    if (matchList.length === 0) {
      const cm = cachedMatches(c.coordinate);
      if (cm?.matches.length) noteMatches(c.coordinate, cm.matches);
    }
    settings ??= cachedPerEventSettings(c.coordinate) ?? null;
    loading = false;
    perfMark("Attendees", "cache-paint");
  });

  let stream: DirectoryStream | undefined;
  let blindingKey: Uint8Array | null = null;
  const profiledPubkeys = new Set<string>();

  /**
   * Take a match list: remember which entries are new (before clearing the
   * watermark), then clear it. Viewing this page is what "seeing" your matches
   * now means — the Matches tab it replaced did the same on open (spec §13).
   */
  function noteMatches(coordinate: string, list: Match[]) {
    if (newPubkeys.size === 0) {
      newPubkeys = new Set(
        newMatchPubkeys({ matches: list }, loadWatermark(coordinate).seenMatches),
      );
    }
    matchList = list;
    whatsNew.markMatchesSeen(coordinate);
  }

  // Row-level quick actions (user feedback 2026-07-16): message someone or mark
  // "want to meet" straight from the list, no detour through their profile.
  function message(pubkey: string) {
    if (!session.loggedIn) return router.go({ name: "login" });
    // When this person is one of your matches, the composer opens on the
    // coordinator's suggested opening line rather than a blank box — this is
    // what the old "Introduce us" button did (§9.3). Prefill only: the user
    // edits and sends. Two buttons that differed solely in whether the draft
    // was pre-written did not earn the space they took on every card.
    const m = matchByPubkey.get(pubkey);
    const suggestion = m?.icebreakers?.[0] || m?.reasoning;
    if (suggestion) dmPrefill.set(pubkey, suggestion);
    router.go({ name: "dmPeer", npub: npubEncode(pubkey) });
  }
  async function toggleWantToMeet(pubkey: string) {
    if (!session.signer || !ctx || !blindingKey) return;
    settings = await toggleSetting(session.signer, ctx, blindingKey, "want_to_meet", pubkey).catch(
      () => settings,
    );
  }
  const wantToMeet = (pubkey: string) => !!settings?.want_to_meet?.includes(pubkey);

  /** FollowButton published a change — keep this page's set authoritative. */
  function noteFollow(pubkey: string, following: boolean) {
    const next = new Set(followSet);
    if (following) next.add(pubkey);
    else next.delete(pubkey);
    followSet = next;
  }

  // Social overlay (follows, per-event settings, matches) loads in parallel with
  // the roster stream — none of it blocks the first paint.
  async function loadSocial(c: EventContext) {
    if (!session.signer) return;
    const signer = session.signer;
    void mutes.load(signer);
    const jobs: Promise<unknown>[] = [
      fetchFollowSet(signer)
        .then((s) => {
          followSet = s;
          followsKnown = true;
        })
        .catch(() => {}),
      deriveBlindingKey(signer)
        .then((bk) => {
          blindingKey = bk; // kept for the row-level Want-to-meet toggle
          return loadPerEventSettings(signer, c, bk);
        })
        .then((s) => (settings = s))
        .catch(() => {}),
    ];
    if (c.config.coordinator) {
      jobs.push(
        fetchMatches(signer, c)
          .then((list) => {
            noteMatches(c.coordinate, list?.matches ?? []);
            // Powers the cause-aware note ("record your intro" when that's why
            // there is nothing to show).
            if (matchList.length === 0) void readinessStore.load(c, signer);
          })
          .catch(() => {}),
      );
    }
    await Promise.all(jobs);
  }

  async function load() {
    loading = true;
    error = null;
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      matchingOn = !!ctx.config.coordinator;
      const social = loadSocial(ctx);
      stream?.stop();
      // Progressive roster: entries render as each relay answers; profiles are
      // fetched incrementally for the pubkeys that just appeared. A missing
      // stream means no ECK on this device — the honest "not approved" signal.
      stream = await streamDirectory(ctx, (list) => {
        entries = list;
        loading = false;
        const fresh = list.map((e) => e.pubkey).filter((p) => !profiledPubkeys.has(p));
        if (fresh.length) {
          for (const p of fresh) profiledPubkeys.add(p);
          fetchProfiles(fresh)
            .then((m) => {
              if (m.size) profiles = new Map([...profiles, ...m]);
            })
            .catch(() => {});
        }
      });
      hasKey = stream !== undefined;
      await Promise.allSettled([social, stream?.ready]);
      // Read AFTER the stream settles: this is the count of entries that arrived
      // and would not open under this device's ECK (EV-9).
      undecryptableCount = stream?.undecryptable() ?? 0;
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      // Sampled once the pass has settled, so the empty-state reason is stable
      // rather than re-classifying itself on every connectivity poll.
      relayAtSettle = relayHealth();
      perfMark("Attendees", "network-settled");
    }
  }

  onMount(load);
  onDestroy(() => stream?.stop());

  const entryByPubkey = $derived(new Map(entries.map((e) => [e.pubkey, e])));
  function nameOf(pubkey: string, about?: string): string {
    return (
      profiles.get(pubkey)?.name ||
      entryByPubkey.get(pubkey)?.name || // directory-entry name: instant, no kind-0 round-trip
      about?.slice(0, 40) ||
      pubkey.slice(0, 10) + "…"
    );
  }

  // Show the coordinator-published translation of an attendee's bio/skills when the
  // viewer reads the event language and the author wrote in a different one.
  const tr = (e: DirectoryEntryContent) => {
    const x = e.ai_profile?.translations;
    return x && x.lang === i18n.locale ? x : undefined;
  };
  const cardAbout = (e: DirectoryEntryContent) => tr(e)?.about || e.profile.about;

  function toggleFilter(f: FilterKey) {
    const next = new Set(activeFilters);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    activeFilters = next;
  }
  function passesFilter(pubkey: string): boolean {
    for (const f of activeFilters) {
      if (f === "following") {
        if (!followSet.has(pubkey)) return false;
      } else if (!settings?.[f]?.includes(pubkey)) {
        return false;
      }
    }
    return true;
  }

  // ── Matches ──────────────────────────────────────────────────────────────
  // Muted attendees never appear in your matches (U10), and the list is ordered
  // here rather than trusted as received — an event scored before the coordinator
  // learned to break score ties on complementarity still has arbitrary order at
  // the top (confidence.ts).
  const rankedMatches = $derived([...matchList].sort(byMatchRank));
  const visibleMatches = $derived(rankedMatches.filter((m) => !mutes.isMuted(m.pubkey)));
  const matchByPubkey = $derived(new Map(matchList.map((m) => [m.pubkey, m])));
  // The "strong" cut is per attendee, so it is derived ONCE for the list. It reads
  // the full ranked list, not the muted-out one: muting three people must not
  // promote the next three into "Strong match".
  const strongCut = $derived(strongCutFor(rankedMatches));
  const bandOf = (m: Match): ConfidenceBand => bandAtCut(m.score, strongCut);

  /**
   * The bands that get full entries at the top of the page.
   *
   * Strong and good, normally — median 3 + 3 on real data, so about six entries
   * and a screen and a half. "Worth a hello" is the tail of a top-10 and stays in
   * the directory as a tagged row, EXCEPT for the attendee who has nothing else:
   * 12% of real users have no strong match, and a few have no good one either.
   * Featuring their best band is the difference between this page telling them
   * something and telling them nothing.
   */
  const featured = $derived.by(() => {
    const by = (b: ConfidenceBand) => visibleMatches.filter((m) => bandOf(m) === b);
    const strong = by("strong");
    const good = by("good");
    if (strong.length || good.length) {
      return [
        { band: "strong" as const, items: strong },
        { band: "good" as const, items: good },
      ].filter((s) => s.items.length > 0);
    }
    const hello = by("hello");
    return hello.length ? [{ band: "hello" as const, items: hello }] : [];
  });
  const featuredPubkeys = $derived(new Set(featured.flatMap((s) => s.items.map((m) => m.pubkey))));

  /** Nothing sharp at the top — say so rather than let the heading imply it. */
  const noStrong = $derived(
    matchingOn && visibleMatches.length > 0 && !visibleMatches.some((m) => bandOf(m) === "strong"),
  );
  /** A member with matching on and an empty list: is their own intro the reason? */
  const needsIntro = $derived(
    readinessStore.readiness?.steps.find((s) => s.id === "intro")?.state === "action-required",
  );
  const awaitingMatches = $derived(
    matchingOn && hasKey && !loading && entries.length > 0 && visibleMatches.length === 0,
  );

  // ── Directory ────────────────────────────────────────────────────────────
  const hasFilters = $derived(query.trim().length > 0 || activeFilters.size > 0);
  /**
   * Everyone, by name. Collate in the ACTIVE locale, not the host's default:
   * Slovak and Czech order č/š/ž after c/s/z rather than lumping them in with
   * the base letter (and ch sorts after h in both), so a locale-less
   * localeCompare put a Slovak roster in an order a Slovak reader reads as
   * "random".
   */
  const byName = $derived.by(() => {
    void profiles; // re-derive when profiles load
    return entries
      .filter((e) => !mutes.isMuted(e.pubkey))
      .sort((a, b) =>
        nameOf(a.pubkey, a.profile.about).localeCompare(
          nameOf(b.pubkey, b.profile.about),
          i18n.locale,
        ),
      );
  });

  /**
   * The directory rows. Searching or filtering flattens the page — every person
   * who matches, featured or not, in one relevance-ranked list — because a
   * result set has no band structure worth preserving and hiding six people from
   * a search because they were already on screen above is how you make a search
   * box untrustworthy.
   */
  const visible = $derived(
    searchRank(
      byName.filter((e) => passesFilter(e.pubkey) && (hasFilters || !featuredPubkeys.has(e.pubkey))),
      query,
      (e) => directoryEntryFields(e, nameOf(e.pubkey, e.profile.about), i18n.locale),
    ),
  );

  function clearFilters() {
    query = "";
    activeFilters = new Set();
  }

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }

  // Which of the empty states to render (see rosterEmptyReason above).
  const emptyReason = $derived(
    rosterEmptyReason({
      loading,
      hasKey,
      undecryptable: undecryptableCount,
      online: online.isOnline,
      relay: relayAtSettle,
    }),
  );
</script>

<!-- One action vocabulary for the whole page: a matched person and an unmatched
     one offer exactly the same three controls, in the same order, in the same
     skin. This is the gap the merge was asked to close — the Matches tab could
     message someone but never follow them or mark them. -->
{#snippet personActions(pubkey: string, name: string)}
  {#if session.loggedIn && pubkey !== session.pubkey}
    {#if followsKnown}
      <FollowButton variant="icon" {pubkey} {name} following={followSet.has(pubkey)} onChange={(f) => noteFollow(pubkey, f)} />
    {/if}
    <button
      class="btn inline icon-btn"
      aria-pressed={wantToMeet(pubkey)}
      class:primary={wantToMeet(pubkey)}
      title={t("attendees.wantToMeetName", { name })}
      aria-label={t("attendees.wantToMeetName", { name })}
      onclick={() => toggleWantToMeet(pubkey)}
    >
      <Icon name="bookmark" size={16} />
    </button>
    <button
      class="btn inline icon-btn"
      title={t("attendees.messageName", { name })}
      aria-label={t("attendees.messageName", { name })}
      onclick={() => message(pubkey)}
    >
      <Icon name="send" size={16} />
    </button>
  {/if}
{/snippet}

<h1 class="disp">{t("attendees.title")}</h1>

{#if error}
  <ErrorState {error} onRetry={load} retrying={loading} />
{:else if loading}
  <p class="muted">{t("attendees.decrypting")}</p>
{:else if entries.length === 0}
  <!-- Three different facts, three different cards. The only one that offers a
       retry is the one a retry can actually fix; the other two get the action
       that matches their situation. -->
  <div class="card" class:warn={emptyReason === "unreachable"} role={emptyReason === "unreachable" ? "alert" : undefined}>
    <p class="muted">
      {#if emptyReason === "unreachable"}
        {t("attendees.empty.unreachable")}
      {:else if emptyReason === "staleKey"}
        {t("attendees.empty.staleKey")}
      {:else if emptyReason === "notApproved"}
        {t("attendees.empty.notApproved")}
      {:else}
        {t("attendees.empty.none")}
      {/if}
    </p>
    <div class="row" style="flex-wrap:wrap">
      {#if emptyReason !== "notApproved"}
        <!-- No "Retrying…" label: `load()` flips `loading` synchronously, so the
             branch above ("Decrypting the roster…") takes over the whole screen
             before this button could ever render a busy state. -->
        <button class="btn inline" onclick={() => void load()}>{t("error.state.retry")}</button>
      {/if}
      <button class="btn inline" onclick={() => router.go({ name: "event", naddr })}>
        {t("attendees.backToEvent")}
      </button>
    </div>
  </div>
{:else}
  <!-- Search stays at the top — it is how you look someone up mid-conversation
       at the venue, and it costs one field. The filter chips moved down to the
       directory they filter, which is what took a whole control row off the
       first screen. -->
  <label class="visually-hidden" for="roster-search">{t("attendees.search.label")}</label>
  <input
    id="roster-search"
    type="search"
    bind:value={query}
    placeholder={t("attendees.search.placeholder")}
  />

  {#if !hasFilters}
    {#if noStrong}
      <p class="lead">{t("matches.noStrong")}</p>
    {/if}

    {#each featured as section (section.band)}
      <h2 class="band-head">
        <ConfidenceBadge band={section.band} size="sm" context="section" />
        <span class="n">{section.items.length}</span>
      </h2>
      <ul class="entries">
        {#each section.items as m (m.pubkey)}
          {@const name = nameOf(m.pubkey)}
          <li>
            <MatchEntry
              match={m}
              {name}
              sub={cardAbout(entryByPubkey.get(m.pubkey) ?? ({ profile: {} } as DirectoryEntryContent))}
              picture={profiles.get(m.pubkey)?.picture}
              isNew={newPubkeys.has(m.pubkey)}
              onOpen={() => open(m.pubkey)}
            >
              {#snippet actions()}{@render personActions(m.pubkey, name)}{/snippet}
            </MatchEntry>
          </li>
        {/each}
      </ul>
    {/each}

    {#if awaitingMatches}
      <!-- A member with matching on and no list yet. Not a full-screen state: the
           roster below is real and useful, so this is one line and the action
           that actually unblocks it. -->
      <div class="card">
        {#if needsIntro}
          <p class="muted">{t("matches.none.noIntro")}</p>
          <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: false })}>
            {t("readiness.cta.record")}
          </button>
        {:else}
          <p class="muted">{t("matches.none")}</p>
          <p class="muted">{t("matches.none.why")}</p>
          <button class="btn" onclick={() => void load()} disabled={loading}>
            {loading ? t("error.state.retrying") : t("matches.checkAgain")}
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="dir-head">
    {#if featured.length > 0 && !hasFilters}
      <h2>{t("attendees.section.everyone")}</h2>
    {/if}
    <!-- Deliberately NOT a live region. This count changes on every keystroke in
         the search box, and role="status" (which implies aria-live="polite")
         made a screen reader re-announce "Showing 41 people… 12 people… 4
         people…" between every letter, drowning out the typing itself. The
         number is right there next to the field for anyone who wants it. -->
    <p class="muted count">
      {hasFilters ? tp("attendees.showing", visible.length) : tp("attendees.count", entries.length)}
    </p>
  </div>

  {#if session.loggedIn}
    <div class="row filters" role="group" aria-label={t("attendees.filter.label")}>
      {#each ["want_to_meet", "met", "following"] as const as f (f)}
        <button
          class="btn inline"
          aria-pressed={activeFilters.has(f)}
          class:primary={activeFilters.has(f)}
          onclick={() => toggleFilter(f)}
        >
          {t(filterLabels[f])}
        </button>
      {/each}
      {#if hasFilters}
        <button class="btn inline" onclick={clearFilters}>{t("attendees.filter.clear")}</button>
      {/if}
    </div>
  {/if}

  {#if visible.length === 0}
    <div class="card">
      <p class="muted">{hasFilters ? t("attendees.noResults") : t("attendees.section.allFeatured")}</p>
      {#if hasFilters}
        <button class="btn inline" onclick={clearFilters}>{t("attendees.filter.clear")}</button>
      {/if}
    </div>
  {:else}
    <!-- Full roster in the DOM (audit §7.3.5): virtualization mounted only the
         visible window, so browser Find and screen readers missed offscreen
         attendees and zoom could clip fixed-height rows. At the spec scale
         (≤2000, typically ~200) rendering every row is fine, and it's the
         simplest correct fix. Real list semantics so AT announces "list, N
         items"; a 2000-row render-perf check is an e2e-phase task. -->
    <div class="card roster">
      <ul class="roster-list" aria-label={t("attendees.rosterLabel")}>
        {#each visible as e (e.pubkey)}
          {@const name = nameOf(e.pubkey, e.profile.about)}
          <li>
            <PersonCard
              pubkey={e.pubkey}
              {name}
              line={cardAbout(e) || e.ai_profile?.summary}
              picture={profiles.get(e.pubkey)?.picture}
              onOpen={() => open(e.pubkey)}
              last={e.pubkey === visible[visible.length - 1]?.pubkey}
            >
              {#snippet trailing()}
                {#if matchByPubkey.has(e.pubkey)}<span class="badge accent">{t("attendees.matchTag")}</span>{/if}
              {/snippet}
              {#snippet actions()}{@render personActions(e.pubkey, name)}{/snippet}
            </PersonCard>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/if}

<style>
  h1.disp {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0;
  }
  /* The band, said once, as structure. It keeps the pill — the plain-text
     version of this label tested unnoticeable at a glance (2026-07-20) — but
     promotes it from a decoration repeated on every card to the rule that opens
     a run of them. */
  .band-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 1.4rem 0 0.1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
    font-size: 1rem;
  }
  .band-head .n {
    color: var(--text-dim);
    font-size: 0.8rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .lead {
    color: var(--text-dim);
    font-size: 0.9rem;
    line-height: 1.5;
    margin: 0.6rem 0 0;
    max-width: 68ch;
  }
  .dir-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 1.4rem;
  }
  .dir-head h2 {
    margin: 0;
    font-size: 1rem;
  }
  .dir-head .count {
    margin: 0;
  }
  .filters {
    flex-wrap: wrap;
    margin: 0.5rem 0 0.1rem;
  }
  .roster {
    padding: 0.25rem 0.9rem;
  }
  .roster-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .icon-btn {
    padding: 0.4rem 0.5rem;
    line-height: 0;
  }
</style>
