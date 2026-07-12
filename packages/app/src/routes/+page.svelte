<script lang="ts">
  // The single catch-all page: renders the component for the current hash route.
  import { router } from "$lib/router/router.svelte.js";

  import Home from "$lib/pages/Home.svelte";
  import Login from "$lib/pages/Login.svelte";
  import Create from "$lib/pages/Create.svelte";
  import Me from "$lib/pages/Me.svelte";
  import Settings from "$lib/pages/Settings.svelte";
  import EventHome from "$lib/pages/EventHome.svelte";
  import Join from "$lib/pages/Join.svelte";
  import Record from "$lib/pages/Record.svelte";
  import Attendees from "$lib/pages/Attendees.svelte";
  import Attendee from "$lib/pages/Attendee.svelte";
  import Matches from "$lib/pages/Matches.svelte";
  import Admin from "$lib/pages/Admin.svelte";
  import NotFound from "$lib/pages/NotFound.svelte";

  const route = $derived(router.route);
</script>

{#if route.name === "home"}
  <Home />
{:else if route.name === "login"}
  <Login />
{:else if route.name === "create"}
  <Create />
{:else if route.name === "me"}
  <Me />
{:else if route.name === "settings"}
  <Settings />
{:else if route.name === "event"}
  <EventHome naddr={route.naddr} />
{:else if route.name === "join"}
  <Join naddr={route.naddr} code={route.code} />
{:else if route.name === "record"}
  <Record naddr={route.naddr} talk={route.talk} />
{:else if route.name === "attendees"}
  <Attendees naddr={route.naddr} />
{:else if route.name === "attendee"}
  <Attendee naddr={route.naddr} npub={route.npub} />
{:else if route.name === "matches"}
  <Matches naddr={route.naddr} />
{:else if route.name === "admin"}
  <Admin naddr={route.naddr} />
{:else}
  <NotFound />
{/if}
