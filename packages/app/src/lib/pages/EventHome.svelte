<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { loadEventKeys, currentEck } from "$lib/events/keystore.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { install } from "$lib/stores/install.svelte.js";
  import {
    fetchEventPosts,
    fetchAttendeePosts,
    fetchPostByD,
    cachedEventPosts,
    cachedAttendeePosts,
    type EventPost,
  } from "$lib/events/posts.js";
  import { fetchEventPage, cachedEventPage, resolveTarget, type EventPageModel } from "$lib/events/event-page.js";
  import {
    prefetchAttendeesTab,
    prefetchOrganizerRecovery,
    prefetchEventContent,
    prefetchAdmin,
  } from "$lib/nostr/prefetch.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import { fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import { perfMark } from "$lib/perf.js";
  import { naddrToCoordinate, parseCoordinate, type MergedSection } from "@nostrautica/protocol";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import PostCard from "$lib/components/PostCard.svelte";
  import ReadinessJourney from "$lib/components/ReadinessJourney.svelte";
  import { readinessStore } from "$lib/events/readiness.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let error = $state<string | null>(null);
  let approved = $state(false);
  let organizer = $state(false);
  let requestPending = $state(false); // join request sent, approval not landed yet (P2)
  // No status badge until the role is actually known — a fresh device briefly
  // resolving grants/keys must not flash "Visitor" at the organizer.
  let roleResolved = $state(false);
  // Customized layout (31608) or the default feed when none is published.
  // Cache-first (§2.4): paint the last-seen custom layout before the network.
  let page = $state<EventPageModel | undefined>(
    cachedCtx ? cachedEventPage(cachedCtx.coordinate) : undefined,
  );
  // Cache-first: returning to the event page paints its feed instantly.
  let eventPosts = $state<EventPost[]>((cachedCtx && cachedEventPosts(cachedCtx.coordinate)) ?? []);
  let attendeePosts = $state<EventPost[]>((cachedCtx && cachedAttendeePosts(cachedCtx.coordinate)) ?? []);
  // The body below the header is still fetching — show a skeleton only on a cold
  // open (no cached posts/page to paint).
  let bodyLoading = $state(eventPosts.length === 0 && !page);
  let pinnedPosts = $state<Map<string, EventPost>>(new Map());
  // Seed the attendees-section count from the cached roster (§2.4) so the widget
  // paints instantly on revisit rather than after a fresh roster decrypt.
  let rosterCount = $state<number | undefined>(
    cachedCtx ? cachedRoster(cachedCtx.coordinate)?.attendees.length : undefined,
  );
  let installHint = $state(false);
  if (cachedCtx && (page || eventPosts.length)) perfMark("EventHome", "cache-paint");

  const installHintId = "event-page";

  onMount(async () => {
    try {
      await connectNdk();
      // The grant scan doesn't need the event context — run both in parallel.
      const grantsScan = session.signer
        ? receiveGrants(session.signer).catch(() => {})
        : Promise.resolve();
      ctx = await loadEventContext(naddr);
      perfMark("EventHome", "cache-paint"); // first meaningful data (ctx) is set
      // Whether the ECK was already in the keystore BEFORE this visit's fetches:
      // if not (fresh device), the public-content pass below can't decrypt
      // members-only additions and is re-run once the grant scan lands them.
      const preKeys = await loadEventKeys(ctx.coordinate);
      const hadEck = !!currentEck(preKeys);
      // Local custody answers the role WITHOUT the network (§2.4): if we already
      // hold keys, resolve approved/organizer immediately so a reload never
      // flashes "Visitor" at a member while the grant scan is in flight. The
      // grant scan below still runs and reconciles (must-not-miss, constraint 1).
      if (preKeys) {
        approved = hadEck;
        organizer = preKeys.role === "organizer";
        roleResolved = true;
      }
      // Public content (custom layout 31608 + official feed) needs no keys and
      // no grant scan — start immediately so the page fills while grants resolve.
      const publicLoad = (async () => {
        const [pageRes, postsRes] = await Promise.allSettled([
          fetchEventPage(ctx!),
          fetchEventPosts(ctx!),
        ]);
        page = pageRes.status === "fulfilled" ? pageRes.value : undefined;
        eventPosts = postsRes.status === "fulfilled" ? postsRes.value : [];
        bodyLoading = false;
      })();
      await grantsScan;
      approved = await isApproved(ctx.coordinate);
      // The join-sent marker outlives a reload; approval supersedes it (P2).
      if (approved) clearJoinSent(ctx.coordinate);
      else requestPending = joinSentAt(ctx.coordinate) !== undefined;
      const keys = await loadEventKeys(ctx.coordinate);
      organizer = keys?.role === "organizer";
      roleResolved = true;
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
      // Background-warm what the user opens next: the Attendees tab (directory
      // decrypt is signer-free), the attendee-posts feed (so Updates opens warm),
      // and — for a local key with no custody record yet — the organizer key
      // recovery. Detached: must not delay first paint.
      if (approved) prefetchAttendeesTab(ctx, session.signer);
      // Joining/opening an event precaches the People tab + posts + talks +
      // matches + theme (§2.15) so those tabs open instantly.
      if (approved) prefetchEventContent(ctx, session.signer);
      // Organizers: precache the whole Admin surface so it opens without the
      // serial pending→roster→talks→statuses wait (§2.15).
      if (organizer) prefetchAdmin(ctx, keys ?? undefined);
      void fetchAttendeePosts(ctx).catch(() => {});
      if (!keys) prefetchOrganizerRecovery(session.signer);
      await publicLoad;
      // Fresh device whose ECK arrived during this visit: the public pass ran
      // keyless — re-fetch so members-only page sections and posts decrypt.
      if (approved && !hadEck) {
        const [pageRes, postsRes] = await Promise.allSettled([
          fetchEventPage(ctx),
          fetchEventPosts(ctx),
        ]);
        if (pageRes.status === "fulfilled") page = pageRes.value;
        if (postsRes.status === "fulfilled") eventPosts = postsRes.value;
      }
      if (page) await loadSectionData(page.sections);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      bodyLoading = false;
      roleResolved = true;
      perfMark("EventHome", "network-settled");
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

  // A post's stable identity on this page (used to dedupe across widgets).
  const postKey = (p: EventPost) => `${p.source}:${p.authorPubkey}:${p.d}`;
  // Posts already surfaced in the "Latest" highlight or a pinned section must
  // not appear a second time in the feed below (user feedback 2026-07-17: the
  // "Secret article" showed twice).
  const featuredKeys = $derived.by(() => {
    const s = new Set<string>();
    if (latestPost) s.add(postKey(latestPost));
    for (const p of pinnedPosts.values()) s.add(postKey(p));
    return s;
  });

  /** Posts for a `posts` section, filtered by its source × visibility config. */
  function sectionPosts(section: Extract<MergedSection, { type: "posts" }>): EventPost[] {
    let list: EventPost[] = [];
    if (section.source !== "attendees") list = list.concat(eventPosts);
    if (section.source !== "event") list = list.concat(attendeePosts);
    if (section.visibility === "public") list = list.filter((p) => !p.membersOnly);
    if (section.visibility === "members") list = list.filter((p) => p.membersOnly);
    return list
      .filter((p) => !featuredKeys.has(postKey(p)))
      .sort((a, b) => b.publishedAt - a.publishedAt);
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

  // Badge only when it tells the user something actionable: "pending" (waiting
  // for approval) or "visitor" (not a member — join). Once approved it should
  // just work — no badge (user feedback 2026-07-16). Nothing renders until the
  // role is actually resolved, so an organizer on a fresh device never sees a
  // "Visitor" flash while grants/keys recover.
  const overviewStatus = $derived.by(() => {
    if (!roleResolved || organizer || approved) return undefined;
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

  <!-- One unified event menu (user feedback 2026-07-16: admin was up top, other
       links stranded at the bottom): organizer admin + custom 31608 items +
       the posts archive, as one prominent grid. -->
  <nav class="menu-grid" data-event-menu>
    {#if organizer}
      <button class="btn menu-btn" onclick={() => router.go({ name: "admin", naddr })}>
        <Icon name="sliders" size={17} />{t("event.organizerAdmin")}
      </button>
    {/if}
    {#if page}
      {#each page.menu as item (item.label + item.target)}
        <button class="btn menu-btn" onclick={() => openMenuTarget(item.target)}>
          {item.label}{#if item.membersOnly}&nbsp;<Icon name="lock" size={15} />{/if}
        </button>
      {/each}
    {/if}
    <button class="btn menu-btn" onclick={() => router.go({ name: "posts", naddr })}>
      <Icon name="horn" size={17} />{t("event.allPosts")}
    </button>
  </nav>

  <!-- Readiness journey (§4.1): one honest next action, derived from real state.
       Visitors see the Join CTA as step 1; approved members see intro/matches. -->
  {#if readinessStore.readiness}
    <ReadinessJourney readiness={readinessStore.readiness} {naddr} />
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

  {#if bodyLoading}
    <!-- The feed/layout is still fetching — visible progress, never a void
         (user feedback 2026-07-16: the page "looked empty" on a slow relay). -->
    <div class="card skeleton" aria-label={t("event.loading")}>
      <div class="sk-line" style="width:38%"></div>
      <div class="sk-line" style="width:92%"></div>
      <div class="sk-line" style="width:71%"></div>
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
  {:else if eventPosts.length}
    {@const rest = eventPosts.filter((p) => !featuredKeys.has(postKey(p)))}
    {#if rest.length}
      <!-- Default layout (no 31608): the official feed, minus the highlighted post. -->
      <h2>{t("event.updates")}</h2>
      {#each rest as post (post.d)}
        <PostCard {post} {naddr} full />
      {/each}
    {/if}
  {/if}
{/if}

<style>
  .menu-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    padding: 0.65rem 0.9rem;
  }
  .card.skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
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
    .sk-line {
      animation: none;
    }
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
