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
  import { loadLibrary, prepareReuse } from "$lib/media/submit.js";
  import type { MediaDescriptor } from "@nostrautica/protocol";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import EventHeader from "$lib/components/EventHeader.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, markJoinSent, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

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

  // Intro-video reuse (UI-SUGGESTIONS #11): a returning attendee with a library
  // entry from a previous event can reuse it here instead of re-recording. The
  // library holds descriptors only (no source-event label), so we offer the
  // newest intro generically. Choice drives what happens after the join request.
  let library = $state<MediaDescriptor[]>([]);
  let libraryLoaded = $state(false);
  type ReuseChoice = "reuse" | "fresh" | "new";
  let reuseChoice = $state<ReuseChoice>("reuse");
  const reusableIntro = $derived(
    library.filter((m) => m.kind === "intro").slice(-1)[0],
  );

  async function loadReuseLibrary() {
    if (!session.signer || libraryLoaded) return;
    libraryLoaded = true;
    try {
      const bk = await deriveBlindingKey(session.signer);
      library = await loadLibrary(session.signer, bk);
    } catch {
      /* no library / offline — just don't offer reuse */
    }
  }

  onMount(async () => {
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Restore the "request sent" waiting state across reloads (P2): if we
      // recorded a join marker for this event and aren't approved yet, show the
      // waiting screen instead of a pristine form. If approval already landed,
      // the marker is stale — clear it and fall through to the "You're in" state.
      if (session.signer) await receiveGrants(session.signer).catch(() => {});
      approved = await isApproved(ctx.coordinate);
      if (approved) {
        clearJoinSent(ctx.coordinate);
      } else if (joinSentAt(ctx.coordinate) !== undefined) {
        sent = true;
        void pollForGrant();
      }
    } catch (e) {
      if (!ctx) error = e instanceof Error ? e.message : String(e);
    }
  });

  // Poll for the ECK grant while the page is open — invite codes are usually
  // instant, manual approval can land minutes later, and the user shouldn't have
  // to re-open the event to find out (UI-SUGGESTIONS #4).
  async function pollForGrant() {
    if (!ctx || !session.signer) return;
    const coordinate = ctx.coordinate;
    const fast = code ? 10 : 0; // 1.5s cadence first, then relax to 5s
    for (let i = 0; !approved && !destroyed; i++) {
      await new Promise((r) => setTimeout(r, i < fast ? 1500 : 5000));
      await receiveGrants(session.signer).catch(() => {});
      approved = await isApproved(coordinate);
    }
    if (approved) clearJoinSent(coordinate); // marker served its purpose
  }

  // Quiet "send again" for the stuck case (P2) — clears the marker and returns
  // to the form so the user can resubmit without hunting for how.
  function sendAgain() {
    if (ctx) clearJoinSent(ctx.coordinate);
    sent = false;
  }

  // When signed in (already, or via the sign-in options here), load the profile
  // from kind-0 — read-only. We never modify an existing user's kind-0.
  $effect(() => {
    if (session.loggedIn && !profileLoaded && !profileLoading) void loadExistingProfile();
    if (session.loggedIn && !libraryLoaded) void loadReuseLibrary();
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
          error = t("join.error.nameRequired");
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

      // Intro reuse (UI-SUGGESTIONS #11): mirror (or fresh-copy) the previous
      // intro first — same prepareReuse Record.svelte uses — and let it ride the
      // join request's own 21601 + 31602. Best-effort: a reuse failure must not
      // lose the join request.
      let reuseMedia: MediaDescriptor[] = [];
      if (reusableIntro && reuseChoice !== "new") {
        try {
          reuseMedia = [
            await prepareReuse(signer, ctx, reusableIntro, reuseChoice === "fresh"),
          ];
        } catch (e) {
          console.warn("intro reuse at join failed:", e);
        }
      }

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
          media: reuseMedia,
          inviteNsec: code,
        },
        blindingKey,
      );

      sent = true;
      markJoinSent(ctx.coordinate); // survives reload → waiting state, not pristine form (P2)
      recentEvents.record({ coordinate: ctx.coordinate, naddr, title: ctx.title, icon: ctx.icon, role: "attendee" });

      await pollForGrant();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

{#if error}
  <div class="card warn">
    <strong>{t("join.wentWrong")}</strong>
    <span class="muted">{error}</span>
  </div>
{/if}

{#if !ctx}
  <p class="muted">{t("join.loading")}</p>
{:else if approved}
  <h1>{t("join.youreIn")}</h1>
  <div class="card">
    <button class="btn primary" onclick={() => router.go({ name: "attendees", naddr })}>
      {t("join.seeWhosHere")}
    </button>
  </div>
  {#if session.signer?.method === "local"}
    <div class="card">
      <h2>{t("join.backupIdentity")}</h2>
      <BackupCard />
    </div>
  {/if}
{:else if sent}
  <h1>{t("join.requestSent")}</h1>
  <div class="card">
    <p>
      {#if code}
        {t("join.waiting.invite")}
      {:else}
        {t("join.waiting.manual")}
      {/if}
    </p>
    <div class="stack">
      <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>
        {t("join.backToEvent")}
      </button>
      <button class="btn" onclick={() => router.go({ name: "home" })}>{t("join.myEvents")}</button>
    </div>
    <p class="muted" style="margin:0.75rem 0 0">
      {t("join.notThrough")}
      <button
        class="btn inline"
        style="display:inline;padding:0;background:none;border:none;color:var(--accent);text-decoration:underline"
        onclick={sendAgain}
      >
        {t("join.sendAgain")}
      </button>
    </p>
  </div>
{:else}
  <EventHeader {ctx} />
  <h1>{t("join.title", { title: ctx.title })}</h1>

  <div class="card stack">
    {#if session.loggedIn}
      <!-- Existing Nostr user: profile shown read-only from their kind-0. -->
      {#if profileLoading}
        <p class="muted">{t("join.fetchingProfile")}</p>
      {:else}
        <div class="row" style="gap:0.75rem;align-items:center">
          {#if existingPicture}
            <img src={existingPicture} alt="" width="56" height="56" style="border-radius:50%;object-fit:cover;flex:none" />
          {/if}
          <div>
            <div class="field-label">{t("join.displayName")}</div>
            <p style="margin:0">{existingName || t("join.noName")}</p>
          </div>
        </div>
        {#if existingAbout}
          <div>
            <div class="field-label">{t("join.aboutYou")}</div>
            <p class="muted" style="margin:0">{existingAbout}</p>
          </div>
        {/if}
        <p class="muted">
          {t("join.fromProfile")}
        </p>
      {/if}
    {:else}
      <!-- New user: name + bio + photo become the public Nostr profile. -->
      <p class="muted">
        {t("join.publicNote")}
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
        <div class="muted" style="font-size:0.85rem">{t("join.photoAdd")} <span class="badge">{t("join.photoPublic")}</span><br />{t("join.photoTap")}</div>
      </div>
      <div>
        <label for="n">{t("join.displayName")} <span class="muted" style="font-weight:400">{t("join.displayNamePublic")}</span></label>
        <input id="n" bind:value={newName} placeholder={t("join.namePlaceholder")} />
      </div>
      <div>
        <label for="a">{t("join.aboutYou")} <span class="muted" style="font-weight:400">{t("join.aboutOptional")}</span></label>
        <textarea id="a" rows="3" bind:value={newAbout}></textarea>
      </div>
    {/if}

    <p class="muted" style="margin:0.25rem 0 0">
      {t("join.concreteHint")}
    </p>
    <div>
      <label for="sk">{t("join.skills")} <span class="muted" style="font-weight:400">{t("join.skills.hint")}</span></label>
      <input id="sk" bind:value={skills} placeholder={t("join.skills.placeholder")} />
    </div>
    <div>
      <label for="lf">{t("join.lookingFor")}</label>
      <input id="lf" bind:value={lookingFor} placeholder={t("join.lookingFor.placeholder")} />
    </div>
    <label class="row" style="font-weight:400">
      <input type="checkbox" bind:checked={rsvpPublic} style="width:auto" />
      {t("join.rsvpPublic")}
    </label>

    {#if reusableIntro}
      <!-- Intro reuse (UI-SUGGESTIONS #11): the library has no source-event label,
           so we offer the previous intro generically. -->
      <div class="card" style="background:var(--bg-elev2)">
        <div class="field-label">{t("join.reuse.title")}</div>
        <p class="muted" style="margin:0 0 0.5rem">
          {t("join.reuse.body", { duration: reusableIntro.duration ?? "?" })}
        </p>
        <div class="stack">
          <label class="row" style="font-weight:400">
            <input type="radio" value="reuse" bind:group={reuseChoice} style="width:auto" />
            {t("join.reuse.reuse")} <span class="muted">{t("join.reuse.reuse.hint")}</span>
          </label>
          <label class="row" style="font-weight:400">
            <input type="radio" value="fresh" bind:group={reuseChoice} style="width:auto" />
            {t("join.reuse.fresh")} <span class="muted">{t("join.reuse.fresh.hint")}</span>
          </label>
          <label class="row" style="font-weight:400">
            <input type="radio" value="new" bind:group={reuseChoice} style="width:auto" />
            {t("join.reuse.new")} <span class="muted">{t("join.reuse.new.hint")}</span>
          </label>
        </div>
      </div>
    {/if}

    <button class="btn primary" onclick={submit} disabled={busy || profileLoading}>
      {busy ? t("join.sending") : session.loggedIn ? t("join.send") : t("join.createAndJoin")}
    </button>
  </div>

  {#if !session.loggedIn}
    <!-- Quiet path for Nostr natives; newcomers just fill the form (UI-SUGGESTIONS #1). -->
    <div class="or-divider">{t("join.or")}</div>
    <button class="btn" onclick={() => (showSignIn = !showSignIn)}>
      <NostrichIcon size={20} />
      {t("join.alreadyOnNostr")}
    </button>
    {#if showSignIn}
      <SignInOptions onSignedIn={() => (showSignIn = false)} />
    {/if}
  {/if}
{/if}
