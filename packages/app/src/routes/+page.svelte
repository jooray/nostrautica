<script lang="ts">
  // The single catch-all page: renders the component for the current hash route.
  // Participant first-paint routes are imported eagerly (they ride the entry
  // chunk); heavier/rarer routes — organizer admin, settings, editors, chat,
  // talks, recording — are code-split behind LazyRoute so they never bloat the
  // entry bundle (audit §7.4.1). Loaders are module-level constants so each
  // import fires once and stays cached.
  import { router } from "$lib/router/router.svelte.js";
  import LazyRoute from "$lib/router/LazyRoute.svelte";
  import RouteBoundary from "$lib/router/RouteBoundary.svelte";

  // Eager: the critical participant path (event entry, join, roster, matches).
  import Home from "$lib/pages/Home.svelte";
  import Login from "$lib/pages/Login.svelte";
  import EventHome from "$lib/pages/EventHome.svelte";
  import Join from "$lib/pages/Join.svelte";
  import Attendees from "$lib/pages/Attendees.svelte";
  import Attendee from "$lib/pages/Attendee.svelte";
  import Matches from "$lib/pages/Matches.svelte";
  import Me from "$lib/pages/Me.svelte";
  import EventMore from "$lib/pages/EventMore.svelte";
  import NotFound from "$lib/pages/NotFound.svelte";

  // Lazy: rarer / heavier routes. Loaders come from the SHARED registry
  // (audit U7) so the offline pack warms the exact same chunks these routes load.
  import { lazyRouteLoaders } from "$lib/router/route-modules.js";
  const loadCreate = lazyRouteLoaders.create;
  const loadSettings = lazyRouteLoaders.settings;
  const loadRecord = lazyRouteLoaders.record;
  const loadEventChat = lazyRouteLoaders.chat;
  const loadTalks = lazyRouteLoaders.talks;
  const loadTalkDetail = lazyRouteLoaders.talk;
  const loadMyProfile = lazyRouteLoaders.myProfile;
  const loadAdmin = lazyRouteLoaders.admin;
  const loadEventSettings = lazyRouteLoaders.eventSettings;
  const loadPosts = lazyRouteLoaders.posts;
  const loadReport = lazyRouteLoaders.report;
  const loadPost = lazyRouteLoaders.post;
  const loadDm = lazyRouteLoaders.dm;
  const loadDmChat = lazyRouteLoaders.dmPeer;

  const route = $derived(router.route);
</script>

<RouteBoundary>
  {#if route.name === "home"}
    <Home />
  {:else if route.name === "login"}
    <Login />
  {:else if route.name === "create"}
    <LazyRoute loader={loadCreate} />
  {:else if route.name === "me"}
    <Me />
  {:else if route.name === "settings"}
    <LazyRoute loader={loadSettings} />
  {:else if route.name === "event"}
    {#key route.naddr}<EventHome naddr={route.naddr} />{/key}
  {:else if route.name === "join"}
    {#key route.naddr}<Join naddr={route.naddr} code={route.code} />{/key}
  {:else if route.name === "record"}
    {#key route.naddr}<LazyRoute loader={loadRecord} props={{ naddr: route.naddr, talk: route.talk }} />{/key}
  {:else if route.name === "attendees"}
    {#key route.naddr}<Attendees naddr={route.naddr} />{/key}
  {:else if route.name === "attendee"}
    {#key route.npub}<Attendee naddr={route.naddr} npub={route.npub} />{/key}
  {:else if route.name === "matches"}
    {#key route.naddr}<Matches naddr={route.naddr} />{/key}
  {:else if route.name === "report"}
    {#key route.naddr}<LazyRoute loader={loadReport} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "chat"}
    {#key route.naddr}<LazyRoute loader={loadEventChat} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "talks"}
    {#key route.naddr}<LazyRoute loader={loadTalks} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "talk"}
    {#key route.naddr + route.d}<LazyRoute loader={loadTalkDetail} props={{ naddr: route.naddr, d: route.d }} />{/key}
  {:else if route.name === "myProfile"}
    {#key route.naddr}<LazyRoute loader={loadMyProfile} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "admin"}
    {#key route.naddr}<LazyRoute loader={loadAdmin} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "eventSettings"}
    {#key route.naddr}<LazyRoute loader={loadEventSettings} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "posts"}
    {#key route.naddr}<LazyRoute loader={loadPosts} props={{ naddr: route.naddr }} />{/key}
  {:else if route.name === "post"}
    {#key route.naddr + route.d}<LazyRoute loader={loadPost} props={{ naddr: route.naddr, d: route.d }} />{/key}
  {:else if route.name === "eventMore"}
    {#key route.naddr}<EventMore naddr={route.naddr} />{/key}
  {:else if route.name === "dm"}
    <LazyRoute loader={loadDm} />
  {:else if route.name === "dmPeer"}
    {#key route.npub}<LazyRoute loader={loadDmChat} props={{ npub: route.npub }} />{/key}
  {:else}
    <NotFound />
  {/if}
</RouteBoundary>
