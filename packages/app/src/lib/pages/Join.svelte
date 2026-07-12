<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    loadEventContext,
    cachedEventContext,
    type EventContext,
  } from "$lib/events/event-context.js";
  import { sendJoinRequest } from "$lib/events/join.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { receiveGrants, isApproved } from "$lib/events/attendee.js";
  import { publishProfile, ensureRelayList } from "$lib/events/nostr-actions.js";
  import { fetchProfiles } from "$lib/events/social.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";

  let { naddr, code }: { naddr: string; code?: string } = $props();

  // Render instantly from cache (e.g. arriving from the event page), refresh after.
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let sent = $state(false);
  let approved = $state(false);
  let showSignIn = $state(false);

  // New-user (we generate the key) editable fields — these become the kind-0 profile.
  let newName = $state("");
  let newAbout = $state("");
  // Existing-Nostr-user profile, fetched read-only from their kind-0 (never edited).
  let profileLoading = $state(false);
  let profileLoaded = $state(false);
  let existingName = $state("");
  let existingAbout = $state("");
  // Event-specific fields (not part of kind-0), editable for everyone.
  let skills = $state("");
  let lookingFor = $state("");
  let rsvpPublic = $state(false);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
    } catch (e) {
      if (!ctx) error = e instanceof Error ? e.message : String(e);
    }
  });

  // When signed in (already, or via the sign-in options here), load the profile
  // from kind-0 — read-only. We never modify an existing user's kind-0.
  $effect(() => {
    if (session.loggedIn && !profileLoaded && !profileLoading) void loadExistingProfile();
  });

  async function loadExistingProfile() {
    if (!session.signer) return;
    profileLoading = true;
    try {
      const pubkey = await session.signer.getPublicKey();
      const me = await fetchProfiles([pubkey]);
      existingName = me.get(pubkey)?.name ?? "";
      existingAbout = me.get(pubkey)?.about ?? "";
    } catch {
      /* leave blank */
    } finally {
      profileLoading = false;
      profileLoaded = true;
    }
  }

  async function submit() {
    error = null;
    if (!ctx) return;
    busy = true;
    try {
      let displayName: string;
      let about: string;

      if (!session.loggedIn) {
        // Brand-new user we're creating a key for — these fields ARE the profile.
        if (!newName.trim()) {
          error = "Please enter a display name.";
          return;
        }
        await session.createLocalKey();
        const signer = session.signer!;
        displayName = newName.trim();
        about = newAbout.trim();
        // Only for a key WE generated do we publish kind-0 (§5.4).
        await publishProfile(signer, { name: displayName, about });
        await ensureRelayList(signer);
      } else {
        // Existing Nostr user — use their kind-0 profile as-is; never touch it.
        if (!profileLoaded) await loadExistingProfile();
        displayName = existingName;
        about = existingAbout;
      }

      const signer = session.signer!;
      const blindingKey = await deriveBlindingKey(signer);
      await sendJoinRequest(
        signer,
        ctx,
        {
          name: displayName,
          rsvpPublic,
          profile: {
            about,
            skills: skills.split(",").map((s) => s.trim()).filter(Boolean),
            looking_for: lookingFor.trim(),
            links: [],
          },
          inviteNsec: code,
        },
        blindingKey,
      );
      sent = true;
      recentEvents.record({ coordinate: ctx.coordinate, naddr, title: ctx.title, icon: ctx.icon, role: "attendee" });

      // With an invite code, approval is usually instant — poll for the grant.
      if (code) {
        for (let i = 0; i < 10 && !approved; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          await receiveGrants(signer).catch(() => {});
          approved = await isApproved(ctx.coordinate);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if error}<div class="card warn">{error}</div>{/if}

{#if !ctx}
  <p class="muted">Loading event…</p>
{:else if approved}
  <h1>You're in 🎉</h1>
  <div class="card">
    <button class="btn primary" onclick={() => router.go({ name: "attendees", naddr })}>
      See who's here
    </button>
  </div>
  {#if session.signer?.method === "local"}
    <div class="card">
      <h2>Back up your new identity</h2>
      <BackupCard />
    </div>
  {/if}
{:else if sent}
  <h1>Request sent</h1>
  <div class="card">
    <p>
      {#if code}
        Waiting for auto-approval… If it doesn't arrive, the organizer will review
        your request manually.
      {:else}
        The organizer will review your request. You'll get access as soon as
        they approve.
      {/if}
    </p>
    <div class="stack">
      <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>
        Back to event
      </button>
      <button class="btn" onclick={() => router.go({ name: "home" })}>My events</button>
    </div>
  </div>
{:else}
  <EventHeader {ctx} />
  <h1>Join {ctx.title}</h1>

  {#if !session.loggedIn}
    <button class="btn primary" style="padding:0.9rem;font-size:1.05rem" onclick={() => (showSignIn = !showSignIn)}>
      <NostrichIcon size={24} />
      Already a Nostr user? Sign in
    </button>
    {#if showSignIn}
      <SignInOptions onSignedIn={() => (showSignIn = false)} />
    {/if}
    <div class="or-divider">or</div>
  {/if}

  <div class="card stack">
    {#if session.loggedIn}
      <!-- Existing Nostr user: profile shown read-only from their kind-0. -->
      {#if profileLoading}
        <p class="muted">Fetching your Nostr profile…</p>
      {:else}
        <div>
          <div class="field-label">Display name</div>
          <p style="margin:0">{existingName || "(no name set in your Nostr profile)"}</p>
        </div>
        {#if existingAbout}
          <div>
            <div class="field-label">About you</div>
            <p class="muted" style="margin:0">{existingAbout}</p>
          </div>
        {/if}
        <p class="muted">From your Nostr profile — we won't change it.</p>
      {/if}
    {:else}
      <!-- New user: name + bio become the public Nostr profile. -->
      <p class="muted">Your name and bio become your public Nostr profile.</p>
      <div>
        <label for="n">Display name <span class="muted" style="font-weight:400">(public)</span></label>
        <input id="n" bind:value={newName} placeholder="How should people know you?" />
      </div>
      <div>
        <label for="a">About you <span class="muted" style="font-weight:400">(public)</span></label>
        <textarea id="a" rows="3" bind:value={newAbout}></textarea>
      </div>
    {/if}

    <div>
      <label for="sk">Skills (comma-separated)</label>
      <input id="sk" bind:value={skills} placeholder="cryptography, rust, design" />
    </div>
    <div>
      <label for="lf">What are you looking for?</label>
      <input id="lf" bind:value={lookingFor} placeholder="a co-founder, collaborators…" />
    </div>
    <label class="row" style="font-weight:400">
      <input type="checkbox" bind:checked={rsvpPublic} style="width:auto" />
      Publish a public RSVP (others can see I'm attending)
    </label>
    <button class="btn primary" onclick={submit} disabled={busy || profileLoading}>
      {busy ? "Sending…" : session.loggedIn ? "Send join request" : "Create identity & join"}
    </button>
  </div>
{/if}
