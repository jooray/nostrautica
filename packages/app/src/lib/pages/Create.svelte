<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { createEvent, type CreatedEvent } from "$lib/events/create.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { connectNdk } from "$lib/nostr/ndk.js";

  let title = $state("");
  let summary = $state("");
  let startLocal = $state("");
  let locationStr = $state("");
  let maxVideoSec = $state(90);
  let matching = $state<"on" | "off">("on");
  let matchVisibility = $state<"pair" | "event">("pair");
  let approval = $state<"manual" | "invite" | "manual+invite">("manual+invite");

  let busy = $state(false);
  let error = $state<string | null>(null);
  let created = $state<CreatedEvent | null>(null);

  async function submit() {
    error = null;
    if (!session.signer) {
      router.go({ name: "login" });
      return;
    }
    if (!title.trim() || !startLocal) {
      error = "Title and start time are required.";
      return;
    }
    busy = true;
    try {
      await connectNdk();
      const blindingKey = await deriveBlindingKey(session.signer);
      created = await createEvent(
        session.signer,
        {
          title: title.trim(),
          summary: summary.trim(),
          start: Math.floor(new Date(startLocal).getTime() / 1000),
          location: locationStr.trim() || undefined,
          maxVideoSec,
          maxTalkSec: 900,
          matching,
          matchVisibility,
          approval,
          nostrContext: 100,
        },
        blindingKey,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function appBase() {
    return typeof window !== "undefined"
      ? window.location.origin + window.location.pathname
      : "";
  }
  const shareLink = $derived(created ? `${appBase()}#/e/${created.naddr}` : "");
</script>

<h1>Create an event</h1>

{#if !session.loggedIn}
  <div class="card">
    <p>Log in first to create an event.</p>
    <button class="btn primary" onclick={() => router.go({ name: "login" })}>Log in</button>
  </div>
{:else if created}
  <div class="card">
    <h2>Event created 🎉</h2>
    <p class="muted">Share this link with attendees:</p>
    <p class="mono">{shareLink}</p>
    <div class="stack" style="margin-top:0.75rem">
      <button
        class="btn primary"
        onclick={() => router.go({ name: "admin", naddr: created!.naddr })}
      >
        Open organizer admin
      </button>
      <button
        class="btn"
        onclick={() => router.go({ name: "event", naddr: created!.naddr })}
      >
        View event page
      </button>
    </div>
  </div>
{:else}
  {#if error}<div class="card warn">{error}</div>{/if}
  <div class="card stack">
    <div>
      <label for="t">Title</label>
      <input id="t" bind:value={title} placeholder="Cypherpunk Assembly 2026" />
    </div>
    <div>
      <label for="s">Summary</label>
      <textarea id="s" rows="3" bind:value={summary}></textarea>
    </div>
    <div>
      <label for="st">Start</label>
      <input id="st" type="datetime-local" bind:value={startLocal} />
    </div>
    <div>
      <label for="loc">Location</label>
      <input id="loc" bind:value={locationStr} placeholder="Bratislava" />
    </div>
    <div>
      <label for="mv">Max intro video (seconds)</label>
      <input id="mv" type="number" bind:value={maxVideoSec} />
    </div>
    <div>
      <label for="approval">Approval</label>
      <select id="approval" bind:value={approval}>
        <option value="manual">Manual review</option>
        <option value="invite">Invite codes only</option>
        <option value="manual+invite">Invite codes + manual</option>
      </select>
    </div>
    <div>
      <label for="match">AI matchmaking</label>
      <select id="match" bind:value={matching}>
        <option value="on">On (needs a coordinator)</option>
        <option value="off">Off</option>
      </select>
    </div>
    <p class="muted">
      Note: key rotation is forward-only — anyone who ever held a decryption key can
      decrypt content published while it was current, forever (spec §4.2).
    </p>
    <button class="btn primary" onclick={submit} disabled={busy}>
      {busy ? "Creating…" : "Create event"}
    </button>
  </div>
{/if}
