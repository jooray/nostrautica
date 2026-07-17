<script lang="ts">
  import { onMount } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import type { Match, DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchMatches, fetchDirectory, cachedMatches, cachedDirectory } from "$lib/events/attendee.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { mutes } from "$lib/stores/mutes.svelte.js";
  import { readinessStore } from "$lib/events/readiness.svelte.js";
  import { perfMark } from "$lib/perf.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import ConfidenceBadge from "$lib/components/ConfidenceBadge.svelte";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const cachedCtx = cachedEventContext(naddr);
  // Cache-first paint (§2.3): matches/names/profiles from the persistent cache so
  // the page shows the ranked list instantly on revisit, then refreshes.
  const cachedList = cachedCtx ? cachedMatches(cachedCtx.coordinate) : undefined;
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let matches = $state<Match[]>(cachedList?.matches ?? []);
  let names = $state<Map<string, DirectoryEntryContent>>(
    cachedCtx
      ? new Map((cachedDirectory(cachedCtx.coordinate) ?? []).map((e) => [e.pubkey, e]))
      : new Map(),
  );
  let profiles = $state<Map<string, ProfileMeta>>(
    cachedList ? cachedProfiles(cachedList.matches.map((m) => m.pubkey)) : new Map(),
  );
  let loading = $state(matches.length === 0);
  let error = $state<unknown>(null);
  let noCoordinator = $state(false);

  if (matches.length) perfMark("Matches", "cache-paint");

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (!ctx.config.coordinator) {
        noCoordinator = true;
        return;
      }
      if (!session.signer) return;
      void mutes.load(session.signer);
      // The match list is the page — paint it as soon as it lands. The directory
      // and kind-0 profiles only enrich names/avatars; they fill in reactively.
      const directoryFill = fetchDirectory(ctx)
        .then((directory) => (names = new Map(directory.map((e) => [e.pubkey, e]))))
        .catch(() => {});
      const list = await fetchMatches(session.signer, ctx);
      matches = list?.matches ?? [];
      loading = false;
      // Powers the cause-aware empty state ("record your intro" when that's why).
      void readinessStore.load(ctx, session.signer);
      await Promise.allSettled([
        directoryFill,
        fetchProfiles(matches.map((m) => m.pubkey))
          .then((m) => (profiles = m))
          .catch(() => {}),
      ]);
    } catch (e) {
      error = e;
    } finally {
      loading = false;
      perfMark("Matches", "network-settled");
    }
  });

  // Muted attendees never appear in your matches (U10).
  const visibleMatches = $derived(matches.filter((m) => !mutes.isMuted(m.pubkey)));

  // Empty-state cause: does the viewer still owe an intro?
  const needsIntro = $derived(
    readinessStore.readiness?.steps.find((s) => s.id === "intro")?.state === "action-required",
  );

  function open(pubkey: string) {
    router.go({ name: "attendee", naddr, npub: npubEncode(pubkey) });
  }
  function message(pubkey: string) {
    router.go({ name: "dmPeer", npub: npubEncode(pubkey) });
  }
  function nameOf(pubkey: string): string {
    return (
      profiles.get(pubkey)?.name ||
      names.get(pubkey)?.name || // directory-entry name — no kind-0 round-trip needed
      names.get(pubkey)?.profile.about?.slice(0, 40) ||
      t("matches.name")
    );
  }
  function descriptorOf(pubkey: string): string {
    const about = names.get(pubkey)?.profile.about;
    if (!about) return "";
    return about.length > 60 ? about.slice(0, 60) + "…" : about;
  }
</script>

<h1 class="disp">{t("matches.title")}</h1>

{#if error}
  <ErrorState {error} />
{:else if noCoordinator}
  <!-- Quiet unavailable state (NOT ErrorState — it's role="alert"). -->
  <div class="card">
    <p class="muted">
      {t("matches.noCoordinator")}
    </p>
    <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
      {t("matches.seeWhosHere")}
    </button>
  </div>
{:else if loading}
  <p class="muted">{t("matches.fetching")}</p>
{:else if visibleMatches.length === 0}
  <div class="card">
    {#if needsIntro}
      <p class="muted">{t("matches.none.noIntro")}</p>
      <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: false })}>
        {t("readiness.cta.record")}
      </button>
    {:else}
      <p class="muted">{t("matches.none")}</p>
    {/if}
  </div>
{:else}
  <p class="app-sub">
    {t("matches.rankedNote")}
    {#if !needsIntro}<span class="live"> · {t("matches.live")}</span>{/if}
  </p>
  <div class="stack">
    {#each visibleMatches as m (m.pubkey)}
      <div class="card match">
        <div class="head">
          <Avatar pubkey={m.pubkey} name={nameOf(m.pubkey)} picture={profiles.get(m.pubkey)?.picture} size={42} />
          <div class="who">
            <strong class="name">{nameOf(m.pubkey)}</strong>
            {#if descriptorOf(m.pubkey)}<span class="muted desc">{descriptorOf(m.pubkey)}</span>{/if}
          </div>
        </div>

        <ConfidenceBadge score={m.score} />

        <!-- Reasoning is the product — full body size, no longer under a %. -->
        <p class="reason">{m.reasoning}</p>

        <div class="actions">
          {#if session.loggedIn}
            <button class="btn inline primary" onclick={() => message(m.pubkey)}>
              <Icon name="send" size={16} />{t("matches.message")}
            </button>
          {/if}
          <button class="btn inline" onclick={() => open(m.pubkey)}>
            {t("matches.openProfile")}
          </button>
        </div>

        <details class="score">
          <summary>
            {t("matches.scoreDetails")}
            <span class="chev"><Icon name="chevronDown" size={16} /></span>
          </summary>
          <div class="dims">
            <div class="d"><span>{t("matches.dim.similarity")}</span><b>{m.similarity.toFixed(2)}</b></div>
            <div class="d"><span>{t("matches.dim.complementarity")}</span><b>{m.complementarity.toFixed(2)}</b></div>
            <div class="d"><span>{t("matches.dim.overall")}</span><b>{m.score.toFixed(2)}</b></div>
          </div>
        </details>
      </div>
    {/each}
  </div>
{/if}

<style>
  h1.disp {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0;
  }
  .app-sub {
    color: var(--text-dim);
    font-size: 0.9rem;
    margin: 0 0 0.75rem;
  }
  .match {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }
  .who {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
  }
  .desc {
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reason {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.5;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .actions .btn {
    flex: 1;
    min-width: 8rem;
  }
  details.score {
    border-top: 1px solid var(--border);
    padding-top: 0.55rem;
  }
  details.score summary {
    list-style: none;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  details.score summary::-webkit-details-marker {
    display: none;
  }
  details.score .chev {
    display: inline-flex;
    transition: transform 0.15s ease;
  }
  details.score[open] .chev {
    transform: rotate(180deg);
  }
  .dims {
    display: flex;
    gap: 1.1rem;
    margin-top: 0.5rem;
    font-size: 0.82rem;
  }
  .dims .d {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .dims .d span {
    color: var(--text-dim);
    font-size: 0.72rem;
  }
  .dims .d b {
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }
  @media (prefers-reduced-motion: reduce) {
    details.score .chev {
      transition: none;
    }
  }
</style>
