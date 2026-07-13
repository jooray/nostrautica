<script lang="ts">
  import { onMount, onDestroy } from "svelte";
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
  import { publishProfile, ensureRelayList, seedFollows } from "$lib/events/nostr-actions.js";
  import { parseCoordinate } from "@nostrautica/protocol";
  import { fetchProfiles } from "$lib/events/social.js";
  import { uploadPublicImage } from "$lib/media/image.js";
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
  let destroyed = false;
  onDestroy(() => (destroyed = true));

  // New-user (we generate the key) editable fields — these become the kind-0 profile.
  let newName = $state("");
  let newAbout = $state("");
  let newPicFile = $state<File | null>(null);
  let newPicPreview = $state(""); // local object URL (uploaded on submit)
  // Existing-Nostr-user profile, fetched read-only from their kind-0 (never edited).
  let profileLoading = $state(false);
  let profileLoaded = $state(false);
  let existingName = $state("");
  let existingAbout = $state("");
  let existingPicture = $state("");

  function onPicFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (newPicPreview) URL.revokeObjectURL(newPicPreview);
    newPicFile = f;
    newPicPreview = URL.createObjectURL(f);
  }
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
      existingPicture = me.get(pubkey)?.picture ?? "";
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
        // Upload the chosen photo to public Blossom (needs the just-created signer).
        let picture: string | undefined;
        if (newPicFile) {
          picture = await uploadPublicImage(signer, newPicFile, ctx.config.blossom);
        }
        // Only for a key WE generated do we publish kind-0 (§5.4).
        await publishProfile(signer, { name: displayName, about, picture });
        await ensureRelayList(signer);
        // Seed the follow list with the event so it's never empty (§5.4 item 3).
        await seedFollows(signer, parseCoordinate(ctx.coordinate).pubkey).catch(() => {});
      } else {
        // A key we generated on the login screen (no event context there) gets
        // its seed on first join; existing users' lists are never touched.
        if (session.freshLocalKey) {
          await seedFollows(session.signer!, parseCoordinate(ctx.coordinate).pubkey).catch(() => {});
        }
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

      // Keep polling for the grant while the page is open — invite codes are
      // usually instant, manual approval can land minutes later, and the user
      // shouldn't have to re-open the event to find out (UI-SUGGESTIONS #4).
      const fast = code ? 10 : 0; // 1.5s cadence first, then relax to 5s
      for (let i = 0; !approved && !destroyed; i++) {
        await new Promise((r) => setTimeout(r, i < fast ? 1500 : 5000));
        await receiveGrants(signer).catch(() => {});
        approved = await isApproved(ctx.coordinate);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if error}
  <div class="card warn">
    <strong>Something went wrong.</strong>
    <span class="muted">{error}</span>
  </div>
{/if}

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

  <div class="card stack">
    {#if session.loggedIn}
      <!-- Existing Nostr user: profile shown read-only from their kind-0. -->
      {#if profileLoading}
        <p class="muted">Fetching your Nostr profile…</p>
      {:else}
        <div class="row" style="gap:0.75rem;align-items:center">
          {#if existingPicture}
            <img src={existingPicture} alt="" width="56" height="56" style="border-radius:50%;object-fit:cover;flex:none" />
          {/if}
          <div>
            <div class="field-label">Display name</div>
            <p style="margin:0">{existingName || "(no name set in your Nostr profile)"}</p>
          </div>
        </div>
        {#if existingAbout}
          <div>
            <div class="field-label">About you</div>
            <p class="muted" style="margin:0">{existingAbout}</p>
          </div>
        {/if}
        <p class="muted">
          From your Nostr profile — we won't change it. To update it, edit it in
          your Nostr app and it shows up here.
        </p>
      {/if}
    {:else}
      <!-- New user: name + bio + photo become the public Nostr profile. -->
      <p class="muted">
        Name, photo and bio are public — everything else stays inside the event.
      </p>
      <div class="row" style="gap:0.75rem;align-items:center">
        <label style="cursor:pointer;flex:none;margin:0">
          {#if newPicPreview}
            <img src={newPicPreview} alt="" width="64" height="64" style="border-radius:50%;object-fit:cover" />
          {:else}
            <span style="display:flex;width:64px;height:64px;border-radius:50%;border:1px dashed var(--border);align-items:center;justify-content:center;font-size:1.4rem;color:var(--text-dim)">＋</span>
          {/if}
          <input type="file" accept="image/*" onchange={onPicFile} style="display:none" />
        </label>
        <div class="muted" style="font-size:0.85rem">Photo <span class="badge">public</span><br />tap to add</div>
      </div>
      <div>
        <label for="n">Display name <span class="muted" style="font-weight:400">(public)</span></label>
        <input id="n" bind:value={newName} placeholder="How should people know you?" />
      </div>
      <div>
        <label for="a">About you <span class="muted" style="font-weight:400">(optional)</span></label>
        <textarea id="a" rows="3" bind:value={newAbout}></textarea>
      </div>
    {/if}

    <p class="muted" style="margin:0.25rem 0 0">
      The next two pick who you should meet — be concrete.
    </p>
    <div>
      <label for="sk">Skills <span class="muted" style="font-weight:400">— separate with commas</span></label>
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

  {#if !session.loggedIn}
    <!-- Quiet path for Nostr natives; newcomers just fill the form (UI-SUGGESTIONS #1). -->
    <div class="or-divider">or</div>
    <button class="btn" onclick={() => (showSignIn = !showSignIn)}>
      <NostrichIcon size={20} />
      Already on Nostr? Sign in
    </button>
    {#if showSignIn}
      <SignInOptions onSignedIn={() => (showSignIn = false)} />
    {/if}
  {/if}
{/if}
