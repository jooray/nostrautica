<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { DirectoryEntryContent, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { streamDirectory, fetchMatches, cachedDirectory, type DirectoryStream } from "$lib/events/attendee.js";
  import { fetchFollowSet, fetchProfiles, cachedProfiles, cachedFollowSet, type ProfileMeta } from "$lib/events/social.js";
  import { loadPerEventSettings, toggleSetting, cachedPerEventSettings } from "$lib/events/settings.js";
  import { perfMark } from "$lib/perf.js";
  import { cacheHydration } from "$lib/cache/hydration.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { directoryEntryFields, searchRank } from "$lib/events/search.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import PersonCard from "$lib/components/PersonCard.svelte";
  import FollowButton from "$lib/components/FollowButton.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { i18n, t, tp } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";

  let { naddr }: { naddr: string } = $props();

  const sortLabels: Record<"matches" | "follows" | "name", MessageKey> = {
    matches: "attendees.sort.matches",
    follows: "attendees.sort.follows",
    name: "attendees.sort.name",
  };

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
  let scores = $state<Map<string, number>>(new Map());
  let settings = $state<PerEventSettings | null>(
    cachedCtx ? (cachedPerEventSettings(cachedCtx.coordinate) ?? null) : null,
  );
  let sortBy = $state<"matches" | "follows" | "name">("name");
  let query = $state("");
  let activeFilters = $state<Set<FilterKey>>(new Set());
  let loading = $state(cachedEntries.length === 0);
  let error = $state<unknown>(null);

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
    settings ??= cachedPerEventSettings(c.coordinate) ?? null;
    loading = false;
    perfMark("Attendees", "cache-paint");
  });

  let stream: DirectoryStream | undefined;
  let blindingKey: Uint8Array | null = null;
  const profiledPubkeys = new Set<string>();

  // Row-level quick actions (user feedback 2026-07-16): message someone or mark
  // "want to meet" straight from the list, no detour through their profile.
  function message(pubkey: string) {
    if (!session.loggedIn) return router.go({ name: "login" });
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

  // Social overlay (follows, per-event settings, match scores) loads in
  // parallel with the roster stream — none of it blocks the first paint.
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
            scores = new Map((list?.matches ?? []).map((m) => [m.pubkey, m.score]));
            if (scores.size > 0) sortBy = "matches";
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
      const social = loadSocial(ctx);
      stream?.stop();
      // Progressive roster: entries render as each relay answers; profiles are
      // fetched incrementally for the pubkeys that just appeared.
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
      await Promise.allSettled([social, stream?.ready]);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
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
  const cardSkills = (e: DirectoryEntryContent) =>
    tr(e)?.skills?.length ? tr(e)!.skills! : e.profile.skills;

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

  // Roster, muted removed, then sorted, then search + filter chips applied.
  const sorted = $derived.by(() => {
    void profiles; // re-derive when profiles load
    const list = entries.filter((e) => !mutes.isMuted(e.pubkey));
    if (sortBy === "matches") {
      list.sort((a, b) => (scores.get(b.pubkey) ?? -1) - (scores.get(a.pubkey) ?? -1));
    } else if (sortBy === "follows") {
      list.sort((a, b) => Number(followSet.has(b.pubkey)) - Number(followSet.has(a.pubkey)));
    } else {
      list.sort((a, b) => nameOf(a.pubkey, a.profile.about).localeCompare(nameOf(b.pubkey, b.profile.about)));
    }
    return list;
  });

  // Filter by the active chips first, then run the full-text search (all decrypted
  // fields, transcripts included) with name matches ranked first (spec §13). The
  // chip filter is applied before ranking so counts stay honest.
  const visible = $derived(
    searchRank(
      sorted.filter((e) => passesFilter(e.pubkey)),
      query,
      (e) => directoryEntryFields(e, nameOf(e.pubkey, e.profile.about), i18n.locale),
    ),
  );

  const hasFilters = $derived(query.trim().length > 0 || activeFilters.size > 0);
  function clearFilters() {
    query = "";
    activeFilters = new Set();
  }

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
</script>

<h1 class="disp">{t("attendees.title")}</h1>

{#if error}
  <ErrorState {error} onRetry={load} retrying={loading} />
{:else if loading}
  <p class="muted">{t("attendees.decrypting")}</p>
{:else if entries.length === 0}
  <div class="card">
    <p class="muted">
      {t("attendees.empty")}
    </p>
    <button class="btn" onclick={() => router.go({ name: "event", naddr })}>
      {t("attendees.backToEvent")}
    </button>
  </div>
{:else}
  <div class="stack" style="gap:0.6rem">
    <label class="visually-hidden" for="roster-search">{t("attendees.search.label")}</label>
    <input
      id="roster-search"
      type="search"
      bind:value={query}
      placeholder={t("attendees.search.placeholder")}
    />
    {#if session.loggedIn}
      <div class="row" style="flex-wrap:wrap" role="group" aria-label={t("attendees.filter.label")}>
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
  </div>

  <div class="row" style="justify-content:space-between;flex-wrap:wrap;margin-top:0.5rem">
    <p class="muted" role="status" aria-live="polite">
      {hasFilters ? tp("attendees.showing", visible.length) : tp("attendees.count", entries.length)}
    </p>
    <div class="row" role="group" aria-label={t("attendees.sort.label")}>
      {#each ["matches", "follows", "name"] as const as s (s)}
        <button class="btn inline" aria-pressed={sortBy === s} class:primary={sortBy === s} onclick={() => (sortBy = s)}>{t(sortLabels[s])}</button>
      {/each}
    </div>
  </div>

  {#if visible.length === 0}
    <div class="card">
      <p class="muted">{t("attendees.noResults")}</p>
      <button class="btn inline" onclick={clearFilters}>{t("attendees.filter.clear")}</button>
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
          <li>
            <PersonCard
              pubkey={e.pubkey}
              name={nameOf(e.pubkey, e.profile.about)}
              line={cardAbout(e) || e.ai_profile?.summary}
              picture={profiles.get(e.pubkey)?.picture}
              onOpen={() => open(e.pubkey)}
              last={e.pubkey === visible[visible.length - 1]?.pubkey}
            >
              {#snippet trailing()}
                {#if scores.has(e.pubkey)}<span class="badge accent">{t("attendees.matchTag")}</span>{/if}
              {/snippet}
              {#snippet actions()}
                {#if session.loggedIn && e.pubkey !== session.pubkey}
                  <!-- The follow state lives here, not in `trailing` — that slot
                       renders INSIDE PersonCard's open-button, and a button
                       inside a button is invalid HTML. -->
                  {#if followsKnown}
                    <FollowButton
                      pubkey={e.pubkey}
                      name={nameOf(e.pubkey, e.profile.about)}
                      following={followSet.has(e.pubkey)}
                      onChange={(f) => noteFollow(e.pubkey, f)}
                    />
                  {/if}
                  <button
                    class="btn inline icon-btn"
                    aria-pressed={wantToMeet(e.pubkey)}
                    class:primary={wantToMeet(e.pubkey)}
                    title={t("attendees.wantToMeetName", { name: nameOf(e.pubkey, e.profile.about) })}
                    aria-label={t("attendees.wantToMeetName", { name: nameOf(e.pubkey, e.profile.about) })}
                    onclick={() => toggleWantToMeet(e.pubkey)}
                  >
                    <Icon name="star" size={16} />
                  </button>
                  <button
                    class="btn inline icon-btn"
                    title={t("attendees.messageName", { name: nameOf(e.pubkey, e.profile.about) })}
                    aria-label={t("attendees.messageName", { name: nameOf(e.pubkey, e.profile.about) })}
                    onclick={() => message(e.pubkey)}
                  >
                    <Icon name="send" size={16} />
                  </button>
                {/if}
              {/snippet}
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
