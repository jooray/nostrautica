<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { createEvent, type CreatedEvent } from "$lib/events/create.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    defaultEventBanner,
    defaultEventIcon,
    uploadPublicImage,
  } from "$lib/media/image.js";

  let title = $state("");
  let summary = $state("");
  let startLocal = $state("");
  let endLocal = $state("");
  let locationStr = $state("");
  let iconUrl = $state("");
  let bannerUrl = $state("");
  let uploading = $state<"icon" | "banner" | null>(null);
  let maxVideoSec = $state(90);
  let matching = $state<"on" | "off">("on");
  let matchVisibility = $state<"pair" | "event">("pair");
  let approval = $state<"manual" | "invite" | "manual+invite">("manual+invite");

  let busy = $state(false);
  let error = $state<string | null>(null);
  let created = $state<CreatedEvent | null>(null);

  // Live previews: uploaded image, else a generated default (both optional).
  const previewIcon = $derived(iconUrl.trim() || defaultEventIcon(title, title));
  const previewBanner = $derived(bannerUrl.trim() || defaultEventBanner(title));

  async function onImageFile(e: Event, which: "icon" | "banner") {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !session.signer) return;
    uploading = which;
    error = null;
    try {
      await connectNdk();
      const url = await uploadPublicImage(session.signer, file);
      if (which === "icon") iconUrl = url;
      else bannerUrl = url;
    } catch (err) {
      error = "Image upload failed: " + (err instanceof Error ? err.message : String(err));
    } finally {
      uploading = null;
    }
  }

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
          end: endLocal ? Math.floor(new Date(endLocal).getTime() / 1000) : undefined,
          location: locationStr.trim() || undefined,
          // Both images optional: store only what the organizer uploaded. The
          // attendee UI falls back to generated gradients for display.
          icon: iconUrl.trim() || undefined,
          banner: bannerUrl.trim() || undefined,
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
      <label for="en">End</label>
      <input id="en" type="datetime-local" bind:value={endLocal} min={startLocal} />
    </div>
    <div>
      <label for="loc">Location</label>
      <input id="loc" bind:value={locationStr} placeholder="Bratislava" />
    </div>
    <div>
      <div class="field-label">Event images <span class="muted" style="font-weight:400">(both optional)</span></div>
      <div class="row" style="align-items:flex-start;gap:0.75rem">
        <div style="flex:none;text-align:center">
          <img src={previewIcon} alt="event icon preview" style="width:64px;height:64px;border-radius:14px;object-fit:cover" />
          <div style="margin-top:0.35rem">
            <label class="btn inline" style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem">
              {uploading === "icon" ? "…" : "Icon"}
              <input type="file" accept="image/*" onchange={(e) => onImageFile(e, "icon")} style="display:none" />
            </label>
          </div>
        </div>
        <div style="flex:1">
          <img src={previewBanner} alt="event banner preview" style="width:100%;border-radius:12px;aspect-ratio:5/2;object-fit:cover" />
          <div class="row" style="margin-top:0.35rem">
            <label class="btn inline" style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem">
              {uploading === "banner" ? "…" : "Banner"}
              <input type="file" accept="image/*" onchange={(e) => onImageFile(e, "banner")} style="display:none" />
            </label>
            {#if iconUrl || bannerUrl}
              <button class="btn inline" style="font-size:0.8rem;padding:0.3rem 0.6rem" onclick={() => { iconUrl = ""; bannerUrl = ""; }}>Reset</button>
            {/if}
          </div>
        </div>
      </div>
      <p class="muted">Generated from the title if you don't upload your own. Uploads go to a public Blossom server (Primal).</p>
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
