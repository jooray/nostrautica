<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { loadEventKeys } from "$lib/events/keystore.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { install } from "$lib/stores/install.svelte.js";
  import {
    fetchEventPosts,
    fetchAttendeePosts,
    fetchPostByD,
    type EventPost,
  } from "$lib/events/posts.js";
  import { fetchEventPage, resolveTarget, type EventPageModel } from "$lib/events/event-page.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { fetchRoster } from "$lib/events/attendee.js";
  import { naddrToCoordinate, parseCoordinate, type MergedSection } from "@nostrautica/protocol";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import PostCard from "$lib/components/PostCard.svelte";
  import ReadinessJourney from "$lib/components/ReadinessJourney.svelte";
  import { readinessStore } from "$lib/events/readiness.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let approved = $state(false);
  let organizer = $state(false);
  let requestPending = $state(false); // join request sent, approval not landed yet (P2)
  // Customized layout (31608) or the default feed when none is published.
  let page = $state<EventPageModel | undefined>(undefined);
  let eventPosts = $state<EventPost[]>([]);
  let attendeePosts = $state<EventPost[]>([]);
  let pinnedPosts = $state<Map<string, EventPost>>(new Map());
  let rosterCount = $state<number | undefined>(undefined);
  let installHint = $state(false);

  const installHintId = "event-page";

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      approved = await isApproved(ctx.coordinate);
      // The join-sent marker outlives a reload; approval supersedes it (P2).
      if (approved) clearJoinSent(ctx.coordinate);
      else requestPending = joinSentAt(ctx.coordinate) !== undefined;
      const keys = await loadEventKeys(ctx.coordinate);
      organizer = keys?.role === "organizer";
      // Remember this event so it shows up under "My events" on Home.
      recentEvents.record({
        coordinate: ctx.coordinate,
        naddr,
        title: ctx.title,
        icon: ctx.icon,
        role: organizer ? "organizer" : approved ? "attendee" : "visitor",
      });
      if (approved) {
        installHint = install.shouldShow(installHintId);
      }
      // Readiness journey (§4.1): derived from real state, one primary CTA.
      void readinessStore.load(ctx, session.signer);
      // Customized layout (spec §7.4 kind 31608) or the default feed. Members
      // decrypt the members-only additions; visitors get the public parts.
      page = await fetchEventPage(ctx).catch(() => undefined);
      // The official feed (30023 ∪ 31607 by E_id) is fetched either way —
      // it's the default layout and the most common custom section.
      eventPosts = await fetchEventPosts(ctx).catch(() => []);
      if (page) await loadSectionData(page.sections);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  async function loadSectionData(sections: MergedSection[]) {
    if (!ctx) return;
    const jobs: Promise<void>[] = [];
    if (sections.some((s) => s.type === "posts" && s.source !== "event")) {
      jobs.push(
        fetchAttendeePosts(ctx).then((p) => {
          attendeePosts = p;
        }),
      );
    }
    if (sections.some((s) => s.type === "attendees") && approved) {
      jobs.push(
        fetchRoster(ctx!)
          .then((r) => {
            rosterCount = r?.attendees.length;
          })
          .catch(() => undefined) as Promise<void>,
      );
    }
    const refs = sections.flatMap((s) => (s.type === "pinned" ? s.refs : []));
    for (const ref of refs) {
      jobs.push(
        resolvePinned(ref).then((post) => {
          if (post) pinnedPosts = new Map(pinnedPosts).set(ref, post);
        }),
      );
    }
    await Promise.allSettled(jobs);
  }

  /** A pinned naddr → this event's post by d (foreign refs are skipped). */
  async function resolvePinned(ref: string): Promise<EventPost | undefined> {
    if (!ctx) return undefined;
    try {
      const { coordinate } = naddrToCoordinate(ref);
      const { pubkey, identifier } = parseCoordinate(coordinate);
      const { pubkey: eid } = parseCoordinate(ctx.coordinate);
      if (pubkey !== eid) return undefined;
      return await fetchPostByD(ctx, identifier);
    } catch {
      return undefined;
    }
  }

  /** Posts for a `posts` section, filtered by its source × visibility config. */
  function sectionPosts(section: Extract<MergedSection, { type: "posts" }>): EventPost[] {
    let list: EventPost[] = [];
    if (section.source !== "attendees") list = list.concat(eventPosts);
    if (section.source !== "event") list = list.concat(attendeePosts);
    if (section.visibility === "public") list = list.filter((p) => !p.membersOnly);
    if (section.visibility === "members") list = list.filter((p) => p.membersOnly);
    return list.sort((a, b) => b.publishedAt - a.publishedAt);
  }

  function openMenuTarget(target: string) {
    if (!ctx) return;
    const resolved = resolveTarget(ctx, target);
    if (!resolved) return;
    if (resolved.type === "post") router.go({ name: "post", naddr, d: resolved.d });
    else if (resolved.type === "url") window.open(resolved.href, "_blank", "noopener");
    else window.open(`https://njump.me/${resolved.naddr}`, "_blank", "noopener");
  }

  async function promptInstall() {
    const accepted = await install.promptInstall().catch(() => false);
    if (accepted) installHint = false;
  }

  function dismissInstall() {
    install.dismiss(installHintId);
    installHint = false;
  }

  const overviewStatus = $derived.by(() => {
    if (organizer || approved)
      return { labelKey: "event.status.approved" as const, tone: "ok" as const };
    if (requestPending)
      return { labelKey: "event.status.pending" as const, tone: "warn" as const };
    return { labelKey: "event.status.visitor" as const, tone: "neutral" as const };
  });

  const latestPost = $derived(
    [...eventPosts].sort((a, b) => b.publishedAt - a.publishedAt)[0],
  );
</script>

{#if error}
  <div class="card warn">
    <strong>{t("event.loadFailed")}</strong>
    <span class="muted">{error}</span>
  </div>
{:else if !ctx}
  <p class="muted">{t("event.loading")}</p>
{:else}
  <EventHeader {ctx} status={overviewStatus} />
  {#if ctx.summary}<p class="summary">{ctx.summary}</p>{/if}

  {#if organizer}
    <button class="btn inline" onclick={() => router.go({ name: "admin", naddr })}>
      {t("event.organizerAdmin")}
    </button>
  {/if}

  <!-- Readiness journey (§4.1): one honest next action, derived from real state.
       Visitors see the Join CTA as step 1; approved members see intro/matches. -->
  {#if readinessStore.readiness}
    <ReadinessJourney readiness={readinessStore.readiness} {naddr} />
  {/if}

  {#if page && page.menu.length}
    <!-- Custom menu (31608): merged public + members-only items, in order. -->
    <nav class="row menu" style="flex-wrap:wrap" data-event-menu>
      {#each page.menu as item (item.label + item.target)}
        <button class="btn inline" onclick={() => openMenuTarget(item.target)}>
          {item.label}{#if item.membersOnly}&nbsp;<Icon name="lock" size={15} />{/if}
        </button>
      {/each}
    </nav>
  {/if}

  {#if latestPost}
    <!-- "Latest" highlight — newest update, links through to the Updates tab. -->
    <p class="kicker">{t("event.latest")}</p>
    <PostCard post={latestPost} {naddr} full />
  {/if}

  {#if approved && installHint}
    <!-- One-time, dismissable install hint (UI-SUGGESTIONS #24). Never shown in
         standalone mode; Chrome/Android gets the real prompt, iOS instructions. -->
    <div class="card">
      <strong>{t("event.install.title")}</strong>
      <p class="muted" style="margin:0.25rem 0 0.5rem">
        {t("event.install.body")}
      </p>
      {#if install.canPrompt}
        <div class="row">
          <button class="btn inline primary" onclick={promptInstall}>{t("event.install.install")}</button>
          <button class="btn inline" onclick={dismissInstall}>{t("event.install.notNow")}</button>
        </div>
      {:else}
        <p class="muted" style="margin:0 0 0.5rem">
          {t("event.install.iosHint")}
        </p>
        <button class="btn inline" onclick={dismissInstall}>{t("event.install.gotIt")}</button>
      {/if}
    </div>
  {/if}

  {#if page}
    <!-- Custom layout (31608): sections compose the home below the header. -->
    {#each page.sections as section, i (i)}
      {#if section.type === "posts"}
        {@const list = sectionPosts(section)}
        {#if list.length}
          <h2>{t("event.posts")}</h2>
          {#each list as post (post.source + post.authorPubkey + post.d)}
            <PostCard {post} {naddr} full={post.source === "event"} />
          {/each}
        {/if}
      {:else if section.type === "pinned"}
        {@const pins = section.refs
          .map((ref) => pinnedPosts.get(ref))
          .filter((p): p is EventPost => p !== undefined)}
        {#if pins.length}
          <h2 class="pinned-head"><Icon name="pennant" size={18} /> {t("event.pinned")}</h2>
          {#each pins as post (post.d)}
            <PostCard {post} {naddr} full />
          {/each}
        {/if}
      {:else if section.type === "attendees" && approved}
        <!-- Roster preview — renders only for members (spec §7.4). -->
        <div class="card">
          <strong>{t("event.attendeesSection")}</strong>
          {#if rosterCount !== undefined}
            <p class="muted" style="margin:0.25rem 0 0.5rem">
              {t("event.attendeesSection.count", { n: rosterCount })}
            </p>
          {/if}
          <button class="btn inline" onclick={() => router.go({ name: "attendees", naddr })}>
            {t("event.seeWhosHere")}
          </button>
        </div>
      {/if}
    {/each}
    <button class="btn inline" onclick={() => router.go({ name: "posts", naddr })}>
      {t("event.allPosts")}
    </button>
  {:else if eventPosts.length}
    <!-- Default layout (no 31608): the official feed, exactly as before. -->
    <h2>{t("event.updates")}</h2>
    {#each eventPosts as post (post.d)}
      <PostCard {post} {naddr} full />
    {/each}
    <button class="btn inline" onclick={() => router.go({ name: "posts", naddr })}>
      {t("event.allPosts")}
    </button>
  {/if}
{/if}

<style>
  .menu {
    margin: 0.5rem 0;
  }
  .summary {
    margin: 0.25rem 0 0.75rem;
  }
  .kicker {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-dim);
    margin: 1.1rem 0 0.35rem;
  }
  .pinned-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
</style>
