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
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";

  let { naddr, code }: { naddr: string; code?: string } = $props();

  // Render instantly from cache (e.g. arriving from the event page), refresh after.
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let sent = $state(false);
  let approved = $state(false);

  let name = $state("");
  let about = $state("");
  let skills = $state("");
  let lookingFor = $state("");
  let rsvpPublic = $state(false);

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Pre-fill the name for a returning Nostr user from their existing profile.
      if (session.signer && !name) {
        const pubkey = await session.signer.getPublicKey();
        const me = await fetchProfiles([pubkey]).catch(() => new Map());
        name = me.get(pubkey)?.name ?? "";
      }
    } catch (e) {
      if (!ctx) error = e instanceof Error ? e.message : String(e);
    }
  });

  async function submit() {
    error = null;
    if (!ctx) return;
    if (!name.trim()) {
      error = "Please enter a display name.";
      return;
    }
    busy = true;
    try {
      // First-timers get an identity created automatically — no separate step.
      if (!session.loggedIn) await session.createLocalKey();
      const signer = session.signer!;

      await publishProfile(signer, { name: name.trim(), about: about.trim() });
      await ensureRelayList(signer);

      const blindingKey = await deriveBlindingKey(signer);
      await sendJoinRequest(
        signer,
        ctx,
        {
          name: name.trim(),
          rsvpPublic,
          profile: {
            about: about.trim(),
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
    <p class="muted">
      Fill this in and you're in — we'll set up a Nostr identity for you, no
      password needed. Already a Nostr user?
      <a href="#/login" onclick={(e) => { e.preventDefault(); router.go({ name: "login" }); }}>Log in first</a>.
    </p>
  {/if}

  <div class="card stack">
    <div>
      <label for="n">Display name</label>
      <input id="n" bind:value={name} placeholder="How should people know you?" />
    </div>
    <div>
      <label for="a">About you</label>
      <textarea id="a" rows="3" bind:value={about}></textarea>
    </div>
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
    <button class="btn primary" onclick={submit} disabled={busy}>
      {busy ? "Sending…" : session.loggedIn ? "Send join request" : "Create identity & join"}
    </button>
  </div>
{/if}
