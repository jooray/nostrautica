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
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { publishProfile, ensureRelayList, seedFollows } from "$lib/events/nostr-actions.js";
  import BackupCard from "$lib/components/BackupCard.svelte";

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
  // Logged-out organizers get an inline identity step instead of a login
  // detour (UI-SUGGESTIONS #18) — the key is created on submit, like Join.
  let organizerName = $state("");
  let copiedShare = $state(false);

  // Live previews: uploaded image, else a generated default (both optional).
  const previewIcon = $derived(iconUrl.trim() || defaultEventIcon(title, title));
  const previewBanner = $derived(bannerUrl.trim() || defaultEventBanner(title));

  async function onImageFile(e: Event, which: "icon" | "banner") {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!session.signer) {
      error = "Log in (or create the event first) to upload images — generated ones are used meanwhile.";
      return;
    }
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
    if (!title.trim() || !startLocal) {
      error = "Title and start time are required.";
      return;
    }
    if (!session.loggedIn && !organizerName.trim()) {
      error = "Please enter your name.";
      return;
    }
    busy = true;
    try {
      await connectNdk();
      if (!session.signer) {
        await session.createLocalKey();
        const signer = session.signer;
        if (signer) {
          await publishProfile(signer, { name: organizerName.trim() }).catch(() => {});
          await ensureRelayList(signer).catch(() => {});
        }
      }
      const signer = session.signer;
      if (!signer) throw new Error("Couldn't create your identity — please retry.");
      const blindingKey = await deriveBlindingKey(signer);
      created = await createEvent(
        signer,
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
      recentEvents.record({
        coordinate: created.coordinate,
        naddr: created.naddr,
        title: title.trim(),
        icon: iconUrl.trim() || undefined,
        role: "organizer",
      });
      // Freshly-generated organizer keys follow their own event (§5.4 item 3).
      if (session.freshLocalKey) {
        await seedFollows(signer, created.eidPubkey).catch(() => {});
      }
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

  async function copyShare() {
    await navigator.clipboard.writeText(shareLink);
    copiedShare = true;
    setTimeout(() => (copiedShare = false), 1500);
  }
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  function shareNative() {
    navigator.share({ title: title.trim(), url: shareLink }).catch(() => {});
  }
</script>

<h1>Create an event</h1>

{#if created}
  <div class="card">
    <h2>Event created 🎉</h2>
    <!-- Next steps as a checklist, not a pile of equal buttons (UI-SUGGESTIONS #14). -->
    <ol class="stack" style="margin:0.75rem 0 0;padding-left:1.25rem">
      <li>
        <strong>Share the event</strong>
        <p class="mono" style="margin:0.25rem 0">{shareLink}</p>
        <div class="row">
          <button class="btn inline" onclick={copyShare}>
            {copiedShare ? "Copied ✓" : "Copy link"}
          </button>
          {#if canShare}
            <button class="btn inline" onclick={shareNative}>Share…</button>
          {/if}
        </div>
      </li>
      <li style="margin-top:0.75rem">
        <strong>Optional: attach an AI coordinator</strong>
        <p class="muted" style="margin:0.25rem 0">
          Enables matchmaking and instant invite-link approval — done from the
          admin screen, or skip it and approve people yourself.
        </p>
      </li>
      <li style="margin-top:0.75rem">
        <strong>Approve people as they ask to join</strong>
        <p class="muted" style="margin:0.25rem 0">
          Requests appear on the admin screen (invite links can skip this).
        </p>
      </li>
    </ol>
    <div class="stack" style="margin-top:1rem">
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
  {#if session.freshLocalKey}
    <div class="card">
      <h2>Back up your organizer identity</h2>
      <p class="muted">This key controls your event — don't lose it.</p>
      <BackupCard />
    </div>
  {/if}
{:else}
  {#if error}<div class="card warn">{error}</div>{/if}
  <div class="card stack">
    {#if !session.loggedIn}
      <div>
        <label for="on">Your name</label>
        <input id="on" bind:value={organizerName} placeholder="How should attendees know you?" />
        <p class="muted" style="margin:0.25rem 0 0">
          Your organizer identity is created with the event — no signup needed.
        </p>
      </div>
    {/if}
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
    <!-- Rarely-changed options tucked away; title + date is enough (UI-SUGGESTIONS #13). -->
    <details>
      <summary class="muted" style="cursor:pointer">Advanced — images, video length</summary>
      <div class="stack" style="margin-top:0.75rem">
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
      </div>
    </details>
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
