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
  import { publishProfile, ensureRelayList, ensureDmRelayList, seedFollows } from "$lib/events/nostr-actions.js";
  import { parseCoordinate } from "@nostrautica/protocol";
  import { fetchProfiles } from "$lib/events/social.js";
  import { uploadPublicImage, prepareAvatarImage } from "$lib/media/image.js";
  import { loadLibrary, prepareReuse, loadSelfCopy, hasIntro } from "$lib/media/submit.js";
  import type { MediaDescriptor } from "@nostrautica/protocol";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import Icon from "$lib/components/icons/Icon.svelte";
  import FileButton from "$lib/components/FileButton.svelte";
  import NostrichIcon from "$lib/components/NostrichIcon.svelte";
  import SignInOptions from "$lib/components/SignInOptions.svelte";
  import LanguageSwitch from "$lib/components/LanguageSwitch.svelte";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { joinSentAt, markJoinSent, clearJoinSent } from "$lib/stores/join-sent.svelte.js";
  import { storeInvite, loadInvite, clearInvite } from "$lib/stores/invite-store.js";
  import {
    classifyProfileLoad,
    canSubmitLoggedIn,
    type ProfileLoadState,
  } from "$lib/events/profile-load.js";
  import {
    prefetchOrganizerProfiles,
    prefetchJoinLanding,
    prefetchAttendeesTab,
    prefetchGrants,
  } from "$lib/nostr/prefetch.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import ErrorSummary from "$lib/components/ErrorSummary.svelte";
  import { validate, hasError, describedBy } from "$lib/stores/form-validation.js";
  import { recoverFromStaleChunk } from "$lib/stale-chunk.js";

  let { naddr, code: codeParam }: { naddr: string; code?: string } = $props();

  // The invite code is a full nsec riding the URL fragment. Consume it into
  // memory and strip it from the URL + history immediately, mirroring the
  // login-nsec handling in consumeNsecFromHash (spec §5.2, §14). A reload
  // mid-join simply lands on the normal join screen — the code is gone by design.
  // svelte-ignore state_referenced_locally -- codeParam seeds once; the $effect below keeps `code` in sync on change
  let code = $state(codeParam);
  $effect(() => {
    if (codeParam) {
      code = codeParam;
      stripInviteCodeFromUrl();
    }
  });

  function stripInviteCodeFromUrl(): void {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    if (qIndex < 0) return;
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    if (params.get("code") === null) return;
    params.delete("code");
    const path = hash.slice(0, qIndex);
    const rest = params.toString();
    window.history.replaceState(null, "", rest ? `${path}?${rest}` : path);
    // Keep the router's in-memory route consistent so back()/stack navigation
    // never rebuilds a URL carrying the secret.
    const route = router.route;
    if (route.name === "join") route.code = undefined;
  }

  // Render instantly from cache (e.g. arriving from the event page), refresh after.
  // svelte-ignore state_referenced_locally -- naddr is constant for this instance ({#key} remounts on change)
  let ctx = $state<EventContext | null>(cachedEventContext(naddr) ?? null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let sent = $state(false);
  let sentQueued = $state(false); // join request is in the offline outbox (UX-15)
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
  // A load-state machine (UX-O1) distinguishes loaded / no-public-profile / failed
  // so a transient relay error never silently submits an anonymous-looking request.
  let profileState = $state<ProfileLoadState>("idle");
  const profileLoading = $derived(profileState === "loading");
  const profileLoaded = $derived(
    profileState === "loaded" || profileState === "empty" || profileState === "failed",
  );
  let existingName = $state("");
  let existingAbout = $state("");
  let existingPicture = $state("");
  // Event-local display name (UX-O1): editable for logged-in users, prefilled from
  // the loaded kind-0 name. Sent with the join request; NEVER republishes kind 0.
  let eventDisplayName = $state("");

  // Field-level name validation (audit §7.3.7). The required name field differs
  // by mode: a brand-new user edits `n` (newName); a logged-in user whose public
  // profile is missing/blank must supply an event-local `edn` (eventDisplayName).
  let showErrors = $state(false);
  const nameFieldId = $derived(session.loggedIn ? "edn" : "n");
  const nameInvalid = $derived(
    session.loggedIn
      ? !canSubmitLoggedIn(profileState, eventDisplayName)
      : !newName.trim(),
  );
  const fieldErrors = $derived(
    validate([{ id: nameFieldId, message: nameInvalid ? t("join.error.nameRequired") : null }])
      .errors,
  );
  const errName = $derived(showErrors && hasError(fieldErrors, nameFieldId));

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
      // The grant scan doesn't need the event context — run both in parallel.
      const grantsScan = session.signer
        ? receiveGrants(session.signer).catch(() => {})
        : Promise.resolve();
      ctx = await loadEventContext(naddr);
      // Invite persistence (UX-O2): stash a just-arrived code keyed by event so a
      // reload / mobile signer handoff doesn't silently downgrade to manual
      // approval; or restore one stashed on a previous visit this session.
      if (code) {
        storeInvite(ctx.coordinate, code);
      } else {
        const stored = loadInvite(ctx.coordinate);
        if (stored) code = stored;
      }
      // While the user reads the form / scans the Amber QR, warm what the next
      // screens render: organizer profiles here, EventHome after joining.
      prefetchOrganizerProfiles(ctx);
      prefetchJoinLanding(ctx);
      // Restore the "request sent" waiting state across reloads (P2): if we
      // recorded a join marker for this event and aren't approved yet, show the
      // waiting screen instead of a pristine form. If approval already landed,
      // the marker is stale — clear it and fall through to the "You're in" state.
      await grantsScan;
      approved = await isApproved(ctx.coordinate);
      if (approved) {
        clearJoinSent(ctx.coordinate);
        void checkIntro();
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
  // to re-open the event to find out (UI-SUGGESTIONS #4). Guarded so a resubmit
  // (or the mount-time restore plus a fresh submit) never stacks two loops
  // (audit UX-2).
  let polling = false;
  async function pollForGrant() {
    if (!ctx || !session.signer || polling) return;
    polling = true;
    try {
      const coordinate = ctx.coordinate;
      const fast = code ? 10 : 0; // 1.5s cadence first, then relax to 5s
      for (let i = 0; !approved && !destroyed; i++) {
        await new Promise((r) => setTimeout(r, i < fast ? 1500 : 5000));
        await receiveGrants(session.signer).catch(() => {});
        approved = await isApproved(coordinate);
      }
      if (approved) {
        clearJoinSent(coordinate); // marker served its purpose
        void checkIntro();
      }
    } finally {
      polling = false;
    }
  }

  // Post-approval routing (U1): lead with "Record your intro" unless one already
  // exists, in which case "Go to event overview" is the primary action.
  let introDone = $state(false);
  async function checkIntro() {
    if (!ctx || !session.signer) return;
    try {
      const bk = await deriveBlindingKey(session.signer);
      const self = await loadSelfCopy(session.signer, ctx, bk);
      // An intro is a recording OR an authored text intro — one shared check
      // (audit UX-O5), so text-intro users aren't told to "record your intro."
      introDone = hasIntro(self);
    } catch {
      /* can't tell — default to offering Record (introDone stays false) */
    }
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
    if (session.loggedIn && profileState === "idle") void loadExistingProfile();
    if (session.loggedIn && !libraryLoaded) void loadReuseLibrary();
    // The moment a signer lands (sign-in mid-join), front-run the post-login
    // step: approval status + the roster the user will open next. Both warmers
    // self-gate so remote signers (Amber/NIP-07) never get a surprise prompt.
    if (session.loggedIn && ctx) {
      prefetchGrants(session.signer);
      prefetchAttendeesTab(ctx, session.signer);
    }
  });

  async function loadExistingProfile() {
    if (!session.signer) return;
    profileState = "loading";
    let failed = false;
    let fetched: { name?: string; about?: string; picture?: string } | undefined;
    try {
      const pubkey = await session.signer.getPublicKey();
      const me = await fetchProfiles([pubkey]);
      fetched = me.get(pubkey);
    } catch {
      failed = true; // a fetch error is NOT an empty profile (UX-O1)
    }
    const r = classifyProfileLoad(fetched, failed);
    profileState = r.state;
    existingName = r.name;
    existingAbout = r.about;
    existingPicture = r.picture;
    // Prefill the event-local name from a loaded profile; on empty/failed the user
    // must supply one, so leave whatever they've already typed.
    if (r.state === "loaded" && !eventDisplayName.trim()) eventDisplayName = r.name;
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
          showErrors = true;
          document.getElementById("n")?.focus();
          return;
        }
        // H-6: `createLocalKey` reports false when a newer login/logout superseded
        // its adoption, and then leaves `session.signer` null. The old
        // `session.signer!` asserted past exactly that case, so a second tab
        // signing out mid-join turned the next line into "cannot read properties
        // of null" — surfaced to the joiner as a raw TypeError. Create.svelte
        // already guarded this; Join did not.
        if (!(await session.createLocalKey())) throw new Error(t("signin.superseded"));
        const signer = session.signer;
        if (!signer) throw new Error(t("signin.superseded"));
        displayName = newName.trim();
        about = newAbout.trim();
        // Upload the chosen photo to public Blossom (needs the just-created signer).
        // Downscale + EXIF-strip first (audit APPR-3); a bad image aborts with a
        // readable error — the raw original is never uploaded.
        let picture: string | undefined;
        if (newPicFile) {
          const avatar = await prepareAvatarImage(newPicFile);
          picture = await uploadPublicImage(signer, avatar, ctx.config.blossom);
        }
        // Only for a key WE generated do we publish kind-0 (§5.4).
        await publishProfile(signer, { name: displayName, about, picture });
        await ensureRelayList(signer);
        await ensureDmRelayList(signer).catch(() => {});
        // Seed the follow list with the event so it's never empty (§5.4 item 3).
        await seedFollows(signer, parseCoordinate(ctx.coordinate).pubkey).catch(() => {});
      } else {
        // A key we generated on the login screen (no event context there) gets
        // its seed on first join; existing users' lists are never touched.
        if (session.freshLocalKey) {
          await seedFollows(session.signer!, parseCoordinate(ctx.coordinate).pubkey).catch(() => {});
        }
        // Existing Nostr user — use their kind-0 profile as-is; never touch it.
        if (profileState === "idle" || profileState === "loading") await loadExistingProfile();
        // Honest-submit gate (UX-O1): a failed load or an empty public profile
        // must not produce an anonymous-looking request — require an event-local
        // display name (which never modifies kind 0).
        if (!canSubmitLoggedIn(profileState, eventDisplayName)) {
          showErrors = true;
          document.getElementById("edn")?.focus();
          return;
        }
        displayName = eventDisplayName.trim() || existingName;
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

      const published = await sendJoinRequest(
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
      // Queued for the offline flush rather than published (audit UX-15): say so
      // — the organizer can't approve what hasn't reached them yet.
      sentQueued = !published;
      if (sentQueued) outbox.noteQueued();
      // The invite has served its purpose (queued or published) — drop the
      // stashed code so it can't be reused or leak past this join (UX-O2).
      clearInvite(ctx.coordinate);
      markJoinSent(ctx.coordinate); // survives reload → waiting state, not pristine form (P2)
      // Both identity fields from `ctx` — see the note in EventHome.svelte: the
      // `naddr` prop is a live getter into the parent's route and can already
      // point at a different event by the time this async body resumes.
      recentEvents.record({ coordinate: ctx.coordinate, naddr: ctx.naddr, title: ctx.title, icon: ctx.icon, role: "attendee" });

      // Fire-and-forget (audit UX-2): awaiting the poll here would hold
      // `busy = true` for the whole approval wait, so the "send again" escape
      // hatch came back with a permanently disabled submit button. The poll
      // loop is internally guarded against duplicates.
      void pollForGrant();
    } catch (e) {
      // Post-deploy stale shell: missing hashed chunk mid-submit. Reload once
      // rather than strand the user on "Něco se pokazilo" + TypeError (PWA §10.2).
      if (recoverFromStaleChunk(e)) return;
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
  <div class="card stack">
    {#if !introDone}
      <!-- U1: recording the intro is the next step matching depends on. -->
      <button class="btn primary" onclick={() => router.go({ name: "record", naddr, talk: false })}>
        {t("join.recordIntro")}
      </button>
      <button class="btn" onclick={() => router.go({ name: "event", naddr })}>
        {t("join.goToOverview")}
      </button>
      <details style="margin-top:0.25rem">
        <summary class="muted" style="cursor:pointer">{t("join.whyIntro.summary")}</summary>
        <div class="stack" style="margin-top:0.5rem">
          <p class="muted">{t("join.whyIntro.intro")}</p>
          <ul class="muted" style="margin:0;padding-left:1.1rem">
            <li>{t("join.whyIntro.matches")}</li>
            <li>{t("join.whyIntro.vibe")}</li>
            <li>{t("join.whyIntro.recognize")}</li>
          </ul>
        </div>
      </details>
    {:else}
      <button class="btn primary" onclick={() => router.go({ name: "event", naddr })}>
        {t("join.goToOverview")}
      </button>
      <button class="btn" onclick={() => router.go({ name: "attendees", naddr })}>
        {t("join.seeWhosHere")}
      </button>
    {/if}
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
    {#if sentQueued}
      <p class="muted" role="status">{t("sync.queued")}</p>
    {/if}
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
  <h1>{t("join.title", { title: ctx.title })}</h1>

  <!-- Declared data retention (NIP §6.2): one line at join time. Best-effort
       wording — deletion depends on relays honoring NIP-09. -->
  {#if ctx.config.retentionDays !== undefined}
    <p class="muted retention-line">
      {t("join.retention", { days: ctx.config.retentionDays })}
    </p>
  {/if}

  {#if !session.loggedIn}
    <!-- The event's language may have just auto-adopted (event-context.ts,
         logged-out only) — this is the way back to a different one. -->
    <div style="display:flex;justify-content:flex-end;margin-bottom:0.5rem"><LanguageSwitch /></div>
    <!-- Nostr users are first-class: purple sign-in first, no form-reading
         needed (maintainer decision, revising UI-SUGGESTIONS #1). -->
    <button class="btn primary" onclick={() => (showSignIn = !showSignIn)}>
      <NostrichIcon size={20} />
      {t("join.alreadyOnNostr")}
    </button>
    {#if showSignIn}
      <SignInOptions onSignedIn={() => (showSignIn = false)} />
    {/if}
    <div class="or-divider">{t("join.or")}</div>
  {/if}

  {#if code}
    <!-- Invite persistence indicator (UX-O2): survives reload / signer round-trip. -->
    <p class="muted" role="status" style="margin:0 0 0.5rem">
      <span class="badge ok">{t("join.inviteRecognized")}</span>
    </p>
  {/if}

  {#if showErrors}<ErrorSummary errors={fieldErrors} />{/if}
  <div class="card stack">
    {#if session.loggedIn}
      <!-- Existing Nostr user: kind-0 shown read-only; a load-state machine (UX-O1)
           separates loaded / no-public-profile / failed so a relay error never
           submits an anonymous-looking request. -->
      {#if profileState === "loading" || profileState === "idle"}
        <p class="muted">{t("join.fetchingProfile")}</p>
      {:else if profileState === "failed"}
        <div class="card warn" style="margin:0">
          <strong>{t("join.profile.failed.title")}</strong>
          <p class="muted" style="margin:0.25rem 0 0.5rem">{t("join.profile.failed.body")}</p>
          <button class="btn inline" onclick={() => void loadExistingProfile()}>
            {t("join.profile.retry")}
          </button>
        </div>
      {:else}
        {#if profileState === "loaded"}
          <div class="row" style="gap:0.75rem;align-items:center">
            {#if existingPicture}
              <img src={existingPicture} alt="" width="56" height="56" style="border-radius:50%;object-fit:cover;flex:none" />
            {/if}
            {#if existingAbout}
              <div>
                <div class="field-label">{t("join.aboutYou")}</div>
                <p class="muted" style="margin:0">{existingAbout}</p>
              </div>
            {/if}
          </div>
          <p class="muted">{t("join.fromProfile")}</p>
        {:else}
          <!-- No public kind-0 profile: not an error, but we need a name for this
               event (UX-O1) — kind 0 is never modified. -->
          <p class="muted">{t("join.profile.empty")}</p>
        {/if}
      {/if}
      {#if profileState !== "loading" && profileState !== "idle"}
        <div>
          <label for="edn">{t("join.displayName")} <span class="muted" style="font-weight:400">{t("join.displayNameEvent")}</span></label>
          <input
            id="edn"
            bind:value={eventDisplayName}
            placeholder={t("join.namePlaceholder")}
            aria-invalid={errName}
            aria-describedby={describedBy("edn", errName)}
          />
          {#if errName}<p id="edn-error" class="field-error">{t("join.error.nameRequired")}</p>{/if}
        </div>
      {/if}
    {:else}
      <!-- New user: name + bio + photo become the public Nostr profile. -->
      <p class="muted">
        {t("join.publicNote")}
      </p>
      <div class="row" style="gap:0.75rem;align-items:center">
        <FileButton
          class="avatar-pick"
          style="background:none;border:none;padding:0;cursor:pointer;flex:none;margin:0"
          accept="image/*"
          onchange={onPicFile}
          label={t("join.photoAdd")}
        >
          {#if newPicPreview}
            <img src={newPicPreview} alt="" width="64" height="64" style="border-radius:50%;object-fit:cover" />
          {:else}
            <span style="display:flex;width:64px;height:64px;border-radius:50%;border:1px dashed var(--border);align-items:center;justify-content:center;color:var(--text-dim)"><Icon name="plus" size={22} /></span>
          {/if}
        </FileButton>
        <div class="muted" style="font-size:0.85rem">{t("join.photoAdd")} <span class="badge">{t("join.photoPublic")}</span><br />{t("join.photoTap")}</div>
      </div>
      <div>
        <label for="n">{t("join.displayName")} <span class="muted" style="font-weight:400">{t("join.displayNamePublic")}</span></label>
        <input
          id="n"
          bind:value={newName}
          placeholder={t("join.namePlaceholder")}
          aria-invalid={errName}
          aria-describedby={describedBy("n", errName)}
        />
        {#if errName}<p id="n-error" class="field-error">{t("join.error.nameRequired")}</p>{/if}
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

    <button
      class="btn primary"
      onclick={submit}
      disabled={busy || profileLoading || (session.loggedIn && !canSubmitLoggedIn(profileState, eventDisplayName))}
    >
      {busy ? t("join.sending") : session.loggedIn ? t("join.send") : t("join.createAndJoin")}
    </button>
  </div>

{/if}
