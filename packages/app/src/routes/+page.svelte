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
  import EventChat from "$lib/pages/EventChat.svelte";
  import Talks from "$lib/pages/Talks.svelte";
  import TalkDetail from "$lib/pages/TalkDetail.svelte";
  import MyProfile from "$lib/pages/MyProfile.svelte";
  import Admin from "$lib/pages/Admin.svelte";
  import Posts from "$lib/pages/Posts.svelte";
  import Post from "$lib/pages/Post.svelte";
  import EventMore from "$lib/pages/EventMore.svelte";
  import Dm from "$lib/pages/Dm.svelte";
  import DmChat from "$lib/pages/DmChat.svelte";
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
  {#key route.naddr}<EventHome naddr={route.naddr} />{/key}
{:else if route.name === "join"}
  {#key route.naddr}<Join naddr={route.naddr} code={route.code} />{/key}
{:else if route.name === "record"}
  {#key route.naddr}<Record naddr={route.naddr} talk={route.talk} />{/key}
{:else if route.name === "attendees"}
  {#key route.naddr}<Attendees naddr={route.naddr} />{/key}
{:else if route.name === "attendee"}
  {#key route.npub}<Attendee naddr={route.naddr} npub={route.npub} />{/key}
{:else if route.name === "matches"}
  {#key route.naddr}<Matches naddr={route.naddr} />{/key}
{:else if route.name === "chat"}
  {#key route.naddr}<EventChat naddr={route.naddr} />{/key}
{:else if route.name === "talks"}
  {#key route.naddr}<Talks naddr={route.naddr} />{/key}
{:else if route.name === "talk"}
  {#key route.naddr + route.d}<TalkDetail naddr={route.naddr} d={route.d} />{/key}
{:else if route.name === "myProfile"}
  {#key route.naddr}<MyProfile naddr={route.naddr} />{/key}
{:else if route.name === "admin"}
  {#key route.naddr}<Admin naddr={route.naddr} />{/key}
{:else if route.name === "posts"}
  {#key route.naddr}<Posts naddr={route.naddr} />{/key}
{:else if route.name === "post"}
  {#key route.naddr + route.d}<Post naddr={route.naddr} d={route.d} />{/key}
{:else if route.name === "eventMore"}
  {#key route.naddr}<EventMore naddr={route.naddr} />{/key}
{:else if route.name === "dm"}
  <Dm />
{:else if route.name === "dmPeer"}
  {#key route.npub}<DmChat npub={route.npub} />{/key}
{:else}
  <NotFound />
{/if}
