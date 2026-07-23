<script lang="ts">
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import {
    createEvent,
    createdEventContext,
    enrollOrganizerAsParticipant,
    type CreatedEvent,
    type CreateEventInput,
  } from "$lib/events/create.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import {
    defaultEventBanner,
    defaultEventIcon,
    uploadPublicImage,
  } from "$lib/media/image.js";
  import { recentEvents } from "$lib/stores/recent-events.svelte.js";
  import { publishProfile, ensureRelayList, ensureDmRelayList, seedFollows } from "$lib/events/nostr-actions.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import LanguagePicker from "$lib/components/LanguagePicker.svelte";
  import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
  import ImageCropper from "$lib/components/ImageCropper.svelte";
  import FileButton from "$lib/components/FileButton.svelte";
  import CoordinatorPicker from "$lib/components/CoordinatorPicker.svelte";
  import { attachCoordinator } from "$lib/events/organizer.js";
  import { buildReceipt, type CreationReceipt } from "$lib/events/creation-outcomes.js";
  import { UNLIMITED_SEC } from "@nostrautica/protocol";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { onMount } from "svelte";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveDraft, loadDraft, clearDraft } from "$lib/stores/drafts.js";
  import { takeDuplicateDraft } from "$lib/stores/duplicate-draft.js";
  import ErrorSummary from "$lib/components/ErrorSummary.svelte";
  import { validate, hasError, describedBy } from "$lib/stores/form-validation.js";
  import { opStatus } from "$lib/stores/op-status.svelte.js";

  let title = $state("");
  let summary = $state("");
  let startLocal = $state("");
  let endLocal = $state("");
  let locationStr = $state("");
  let iconUrl = $state("");
  let bannerUrl = $state("");
  let uploading = $state<"icon" | "banner" | null>(null);
  // Entered in minutes in the UI; the wire protocol (max_video_sec/max_talk_sec)
  // stays seconds (spec defaults 90/900 = 1.5/15 minutes). UNLIMITED_SEC (0) means
  // no cap — represented here by the "No limit" checkboxes rather than a value.
  let maxVideoMinutes = $state(1.5);
  let maxVideoUnlimited = $state(false);
  let maxTalkMinutes = $state(15);
  let maxTalkUnlimited = $state(false);
  let talks = $state<"off" | "on" | "prerecord-first">("off");
  let matching = $state<"on" | "off">("on");
  // Enroll the organizer as a participant too (default on) — the first attendee
  // then sees at least the organizer in People instead of an empty roster.
  let enrollSelf = $state(true);
  let chatEnabled = $state(false); // Marmot group chat (experimental); operative once a coordinator is attached
  // Optional AI coordinator picked during creation (kind-31611 discovery). Null =
  // create without one (attach later from Admin still works). When set, the event
  // is created coordinator-less and then attached in the SAME submit, so it lands
  // in the exact state as create-then-attach-from-Admin (see submit()).
  let coordinatorPubkey = $state<string | null>(null);
  let matchVisibility = $state<"pair" | "event">("pair");
  let approval = $state<"manual" | "invite" | "manual+invite">("manual+invite");
  let lang = $state<string>("en"); // ISO 639-1 event language (default English)

  let busy = $state(false);
  let error = $state<string | null>(null);
  let created = $state<CreatedEvent | null>(null);

  // Draft-safe auto-refresh (App-2): the title/summary an organizer is composing
  // must not be lost to a mid-typing deploy. Persist them (owner-scoped once the
  // key exists) and hold the pending reload while either is non-empty — it
  // applies automatically once the form is empty or the event is created.
  // Duplicate-event prefill (spec §13): a "Duplicate event" action stashed a
  // config-only prefill (never keys / coordinate / d — see events/duplicate.ts).
  // Consuming it here fills the form; the event is still created fresh on submit.
  let duplicatedFrom = $state<string | null>(null);

  onMount(() => {
    const dup = takeDuplicateDraft();
    if (dup) {
      title = dup.title;
      summary = dup.summary;
      iconUrl = dup.iconUrl;
      bannerUrl = dup.bannerUrl;
      talks = dup.talks;
      matching = dup.matching;
      matchVisibility = dup.matchVisibility;
      approval = dup.approval;
      lang = dup.lang;
      maxVideoUnlimited = dup.maxVideoSec === UNLIMITED_SEC;
      if (!maxVideoUnlimited) maxVideoMinutes = dup.maxVideoSec / 60;
      maxTalkUnlimited = dup.maxTalkSec === UNLIMITED_SEC;
      if (!maxTalkUnlimited) maxTalkMinutes = dup.maxTalkSec / 60;
      chatEnabled = dup.chatEnabled;
      duplicatedFrom = dup.title;
    }
    if (!session.pubkey) return;
    if (!title) title = loadDraft("create:title") ?? "";
    if (!summary) summary = loadDraft("create:summary") ?? "";
  });
  $effect(() => {
    if (created) return; // event published — drafts already cleared below
    saveDraft("create:title", title);
    saveDraft("create:summary", summary);
    if (title.trim().length > 0 || summary.trim().length > 0) return refreshGuard.hold("create");
  });
  // Truthful outcomes for the two best-effort secondary steps (audit UX-A3):
  // the event is created regardless, but the success screen must not claim
  // enrollment/attach succeeded when they didn't — it must offer a retry.
  let enrollFailed = $state(false);
  let attachFailed = $state(false);
  let retrying = $state<"enroll" | "attach" | null>(null);
  let retryCtx = $state<ReturnType<typeof createdEventContext> | null>(null);
  let retryBlindingKey: Awaited<ReturnType<typeof deriveBlindingKey>> | null = null;
  // Logged-out organizers get an inline identity step instead of a login
  // detour (UI-SUGGESTIONS #18) — the key is created on submit, like Join.
  let organizerName = $state("");
  let copiedShare = $state(false);

  // Live previews: uploaded image, else a generated default (both optional).
  const previewIcon = $derived(iconUrl.trim() || defaultEventIcon(title, title));
  const previewBanner = $derived(bannerUrl.trim() || defaultEventBanner(title));

  // The chosen file opens the crop/zoom picker; upload happens on confirm.
  let cropFile = $state<File | null>(null);
  let cropWhich = $state<"icon" | "banner">("icon");

  function onImageFile(e: Event, which: "icon" | "banner") {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file after a cancel
    if (!file) return;
    if (!session.signer) {
      error = t("create.error.loginToUpload");
      return;
    }
    cropWhich = which;
    cropFile = file;
  }

  async function onCropConfirm(blob: Blob) {
    const which = cropWhich;
    cropFile = null;
    if (!session.signer) return;
    uploading = which;
    error = null;
    try {
      await connectNdk();
      const url = await uploadPublicImage(session.signer, blob);
      if (which === "icon") iconUrl = url;
      else bannerUrl = url;
    } catch (err) {
      error = t("create.error.uploadFailed", { reason: err instanceof Error ? err.message : String(err) });
    } finally {
      uploading = null;
    }
  }

  async function submit() {
    error = null;
    const result = validate([
      {
        id: "on",
        message: !session.loggedIn && !organizerName.trim() ? t("create.error.nameRequired") : null,
      },
      { id: "t", message: !title.trim() ? t("create.error.titleRequired") : null },
      { id: "st", message: !startLocal ? t("create.error.startRequired") : null },
      { id: "en", message: endBeforeStart ? t("create.error.endBeforeStart") : null },
    ]);
    if (!result.ok) {
      showErrors = true;
      if (result.firstErrorId) document.getElementById(result.firstErrorId)?.focus();
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
          await ensureDmRelayList(signer).catch(() => {});
        }
      }
      const signer = session.signer;
      if (!signer) throw new Error(t("create.error.identityFailed"));
      const blindingKey = await deriveBlindingKey(signer);
      const createInput: CreateEventInput = {
        title: title.trim(),
        summary: summary.trim(),
        start: Math.floor(new Date(startLocal).getTime() / 1000),
        end: endLocal ? Math.floor(new Date(endLocal).getTime() / 1000) : undefined,
        location: locationStr.trim() || undefined,
        // Both images optional: store only what the organizer uploaded. The
        // attendee UI falls back to generated gradients for display.
        icon: iconUrl.trim() || undefined,
        banner: bannerUrl.trim() || undefined,
        maxVideoSec: maxVideoUnlimited ? UNLIMITED_SEC : Math.max(1, Math.round(maxVideoMinutes * 60)),
        maxTalkSec: maxTalkUnlimited ? UNLIMITED_SEC : Math.max(1, Math.round(maxTalkMinutes * 60)),
        matching,
        matchVisibility,
        approval,
        nostrContext: 100,
        lang,
        talks,
        chat: chatEnabled ? ["marmot"] : [],
      };
      const result = await createEvent(signer, createInput, blindingKey);
      recentEvents.record({
        coordinate: result.coordinate,
        naddr: result.naddr,
        title: title.trim(),
        icon: iconUrl.trim() || undefined,
        role: "organizer",
      });
      // Freshly-generated organizer keys follow their own event (§5.4 item 3).
      if (session.freshLocalKey) {
        await seedFollows(signer, result.eidPubkey).catch(() => {});
      }
      // Enroll the organizer as a participant (checkbox, default on) — a real
      // invite-backed join request + immediate self-approval, so the roster is
      // never empty and a later-attached coordinator picks them up from the
      // E_inbox backfill. Best-effort (the event exists either way), but it must
      // complete BEFORE the share link is shown: once the link is out, an
      // attendee's approval could race an enrollment still in flight.
      const eventCtx = createdEventContext(result, createInput);
      // Keep what a later retry needs (the event context + blinding key), so a
      // failed secondary step can be re-run from the success screen.
      retryCtx = eventCtx;
      retryBlindingKey = blindingKey;
      if (enrollSelf) {
        enrollFailed = await enrollOrganizerAsParticipant(
          signer,
          eventCtx,
          blindingKey,
          appBase(),
        ).then(
          () => false,
          (e) => {
            console.warn("organizer self-enrollment failed:", e);
            return true;
          },
        );
      }
      // Coordinator picked during creation: attach it now, AFTER self-enrollment,
      // exactly mirroring "create, then go to Admin and attach" — attachCoordinator
      // republishes 31600 with the coordinator tag and gift-wraps the 21603 grant
      // (the coordinator's own subscription installs from there and backfills the
      // enrollment). createEvent already persisted the E_id/E_inbox keys locally,
      // so attach loads them from the keystore. Best-effort like enrollment: the
      // event exists regardless, and a failure is recoverable from Admin — never a
      // reason to leave the organizer on the form risking a duplicate create.
      if (coordinatorPubkey) {
        attachFailed = await attachCoordinator(signer, eventCtx, coordinatorPubkey, blindingKey).then(
          () => false,
          (e) => {
            console.warn("coordinator attach at creation failed:", e);
            return true;
          },
        );
      }
      created = result;
      opStatus.published(t("op.eventCreated"));
      // Event published — the compose drafts are spent (App-2).
      clearDraft("create:title");
      clearDraft("create:summary");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function retryEnroll() {
    if (!session.signer || !retryCtx || !retryBlindingKey) return;
    retrying = "enroll";
    enrollFailed = await enrollOrganizerAsParticipant(
      session.signer,
      retryCtx,
      retryBlindingKey,
      appBase(),
    ).then(
      () => false,
      () => true,
    );
    retrying = null;
  }

  async function retryAttach() {
    if (!session.signer || !retryCtx || !coordinatorPubkey) return;
    retrying = "attach";
    attachFailed = await attachCoordinator(session.signer, retryCtx, coordinatorPubkey, retryBlindingKey ?? undefined).then(
      () => false,
      () => true,
    );
    retrying = null;
  }

  function appBase() {
    return typeof window !== "undefined"
      ? window.location.origin + window.location.pathname
      : "";
  }
  const shareLink = $derived(created ? `${appBase()}#/e/${created.naddr}` : "");

  // Independent-outcome receipt (UX-A3 tail): each publication tracked separately
  // so the success screen reports the real state, not an implied all-success. The
  // enroll/attach retries mutate enrollFailed/attachFailed, so the receipt updates
  // reactively; backup stays "pending" until the BackupCard below confirms it.
  const receipt = $derived<CreationReceipt>(
    buildReceipt({
      enrollAttempted: enrollSelf,
      enrollFailed,
      coordinatorPicked: !!coordinatorPubkey,
      attachFailed,
      freshLocalKey: session.freshLocalKey,
      backupConfirmed: false,
    }),
  );

  async function copyShare() {
    await navigator.clipboard.writeText(shareLink);
    copiedShare = true;
    setTimeout(() => (copiedShare = false), 1500);
  }
  const canShare = typeof navigator !== "undefined" && !!navigator.share;
  function shareNative() {
    navigator.share({ title: title.trim(), url: shareLink }).catch(() => {});
  }

  // Inline end-before-start hint (submit() also hard-blocks this — see there).
  const endBeforeStart = $derived(
    !!endLocal && !!startLocal && new Date(endLocal).getTime() <= new Date(startLocal).getTime(),
  );

  // Field-level validation (audit §7.3.7). Errors surface only after a submit
  // attempt (`showErrors`), stay linked to their field via aria-describedby, and
  // are summarized + first-error-focused by submit().
  let showErrors = $state(false);
  const fieldErrors = $derived(
    validate([
      {
        id: "on",
        message: !session.loggedIn && !organizerName.trim() ? t("create.error.nameRequired") : null,
      },
      { id: "t", message: !title.trim() ? t("create.error.titleRequired") : null },
      { id: "st", message: !startLocal ? t("create.error.startRequired") : null },
      { id: "en", message: endBeforeStart ? t("create.error.endBeforeStart") : null },
    ]).errors,
  );
  const errName = $derived(showErrors && hasError(fieldErrors, "on"));
  const errTitle = $derived(showErrors && hasError(fieldErrors, "t"));
  const errStart = $derived(showErrors && hasError(fieldErrors, "st"));
</script>

<h1>{t("create.title")}</h1>

{#if duplicatedFrom && !created}
  <div class="card" role="status">
    <p class="muted" style="margin:0">{t("create.duplicatedFrom", { title: duplicatedFrom })}</p>
  </div>
{/if}

{#if created}
  <div class="card">
    <h2>{t("create.created")}</h2>
    <!-- Independent-outcome receipt (UX-A3): each publication reports its own
         state; failed secondary steps stay retryable and never masquerade as done. -->
    <ul class="stack receipt" style="margin:0.75rem 0 0;padding:0;list-style:none">
      <li><span class="badge ok">{t("create.receipt.ok")}</span> {t("create.receipt.event")}</li>
      {#if receipt.organizerEnrolled !== "skipped"}
        <li>
          {#if receipt.organizerEnrolled === "ok"}
            <span class="badge ok">{t("create.receipt.ok")}</span> {t("create.receipt.enrolled")}
          {:else}
            <span class="badge warn">{t("create.receipt.failed")}</span> {t("create.receipt.enrolled")}
            <p class="muted" style="margin:0.25rem 0">{t("create.step.enroll.failed.body")}</p>
            <button class="btn inline" disabled={retrying !== null} onclick={retryEnroll}>
              {retrying === "enroll" ? t("create.retrying") : t("create.retry")}
            </button>
          {/if}
        </li>
      {/if}
      {#if receipt.coordinatorGrant !== "skipped"}
        <li>
          {#if receipt.coordinatorGrant === "ok"}
            <span class="badge ok">{t("create.receipt.ok")}</span> {t("create.receipt.grant")}
            <p class="muted" style="margin:0.25rem 0">{t("create.step.coordinator.attached.body")}</p>
          {:else}
            <span class="badge warn">{t("create.receipt.failed")}</span> {t("create.receipt.grant")}
            <p class="muted" style="margin:0.25rem 0">{t("create.step.coordinator.failed.body")}</p>
            <button class="btn inline" disabled={retrying !== null} onclick={retryAttach}>
              {retrying === "attach" ? t("create.retrying") : t("create.retry")}
            </button>
          {/if}
        </li>
      {/if}
      {#if session.freshLocalKey}
        <li>
          {#if receipt.keysBackedUp === "ok"}
            <span class="badge ok">{t("create.receipt.ok")}</span> {t("create.receipt.backup")}
          {:else}
            <span class="badge">{t("create.receipt.pending")}</span> {t("create.receipt.backup")}
            <p class="muted" style="margin:0.25rem 0">{t("create.receipt.backup.pending.body")}</p>
          {/if}
        </li>
      {/if}
    </ul>

    <!-- Next steps as a checklist, not a pile of equal buttons (UI-SUGGESTIONS #14). -->
    <ol class="stack" style="margin:1rem 0 0;padding-left:1.25rem">
      <li>
        <strong>{t("create.step.share")}</strong>
        <p class="mono" style="margin:0.25rem 0">{shareLink}</p>
        <div class="row">
          <button class="btn inline" aria-live="polite" onclick={copyShare}>
            {copiedShare ? t("create.copied") : t("create.copyLink")}
          </button>
          {#if canShare}
            <button class="btn inline" onclick={shareNative}>{t("create.share")}</button>
          {/if}
        </div>
      </li>
      {#if !coordinatorPubkey}
        <li style="margin-top:0.75rem">
          <strong>{t("create.step.coordinator")}</strong>
          <p class="muted" style="margin:0.25rem 0">
            {t("create.step.coordinator.body")}
          </p>
        </li>
      {/if}
      <li style="margin-top:0.75rem">
        <strong>{t("create.step.approve")}</strong>
        <p class="muted" style="margin:0.25rem 0">
          {t("create.step.approve.body")}
        </p>
      </li>
    </ol>
    <div class="stack" style="margin-top:1rem">
      <button
        class="btn primary"
        onclick={() => router.go({ name: "admin", naddr: created!.naddr })}
      >
        {t("create.openAdmin")}
      </button>
      <button
        class="btn"
        onclick={() => router.go({ name: "event", naddr: created!.naddr })}
      >
        {t("create.viewEvent")}
      </button>
    </div>
  </div>
  {#if session.freshLocalKey}
    <div class="card">
      <h2>{t("create.backupOrganizer")}</h2>
      <p class="muted">{t("create.backupOrganizer.body")}</p>
      <BackupCard />
    </div>
  {/if}
{:else}
  {#if error}<div class="card warn">{error}</div>{/if}
  {#if showErrors}<ErrorSummary errors={fieldErrors} />{/if}
  <div class="card stack">
    {#if !session.loggedIn}
      <div>
        <label for="on">{t("create.organizerName")}</label>
        <input
          id="on"
          bind:value={organizerName}
          placeholder={t("create.organizerName.placeholder")}
          aria-invalid={errName}
          aria-describedby={describedBy("on", errName)}
        />
        {#if errName}<p id="on-error" class="field-error">{t("create.error.nameRequired")}</p>{/if}
        <p class="muted" style="margin:0.25rem 0 0">
          {t("create.organizerName.body")}
        </p>
      </div>
    {/if}
    <div>
      <label for="t">{t("create.field.title")}</label>
      <input
        id="t"
        bind:value={title}
        placeholder={t("create.field.title.placeholder")}
        aria-invalid={errTitle}
        aria-describedby={describedBy("t", errTitle)}
      />
      {#if errTitle}<p id="t-error" class="field-error">{t("create.error.titleRequired")}</p>{/if}
    </div>
    <div>
      <label for="s">{t("create.field.summary")}</label>
      <textarea id="s" rows="3" bind:value={summary}></textarea>
    </div>
    <div class="row" style="gap:0.75rem;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <label for="st">{t("create.field.start")}</label>
        <input
          id="st"
          type="datetime-local"
          class="datetime-input"
          bind:value={startLocal}
          aria-invalid={errStart}
          aria-describedby={describedBy("st", errStart)}
        />
        {#if errStart}<p id="st-error" class="field-error">{t("create.error.startRequired")}</p>{/if}
      </div>
      <div style="flex:1;min-width:180px">
        <label for="en">{t("create.field.end")}</label>
        <input
          id="en"
          type="datetime-local"
          class="datetime-input"
          bind:value={endLocal}
          min={startLocal}
          aria-invalid={endBeforeStart}
          aria-describedby={describedBy("en", endBeforeStart)}
        />
        {#if endBeforeStart}
          <p id="en-error" class="field-error">{t("create.error.endBeforeStart")}</p>
        {/if}
      </div>
    </div>
    <div>
      <label for="loc">{t("create.field.location")}</label>
      <input id="loc" bind:value={locationStr} placeholder={t("create.field.location.placeholder")} />
    </div>
    <div>
      <label for="lang">{t("create.field.language")}</label>
      <LanguagePicker id="lang" bind:value={lang} />
      <p class="muted" style="margin:0.25rem 0 0">{t("create.field.language.body")}</p>
    </div>
    <!-- Images + intro length promoted out of "Advanced" (user feedback
         2026-07-16): nearly every event wants images, and the previews below
         show the EXACT crop attendees will see (uploads are cropped to it). -->
    <div>
      <div class="field-label">{t("create.field.images")} <span class="muted" style="font-weight:400">{t("create.field.images.optional")}</span></div>
      <div class="row" style="align-items:flex-start;gap:0.75rem">
        <div style="flex:none;text-align:center">
          <img src={previewIcon} alt={t("create.iconAlt")} style="width:64px;height:64px;border-radius:14px;object-fit:cover" />
          <div style="margin-top:0.35rem">
            <FileButton
              class="btn inline"
              style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem"
              accept="image/*"
              onchange={(e) => onImageFile(e, "icon")}
              label={t("create.iconPick")}
            >
              {uploading === "icon" ? "…" : t("create.icon")}
            </FileButton>
          </div>
        </div>
        <div style="flex:1">
          <img src={previewBanner} alt={t("create.bannerAlt")} style="width:100%;border-radius:12px;aspect-ratio:5/2;object-fit:cover" />
          <div class="row" style="margin-top:0.35rem">
            <FileButton
              class="btn inline"
              style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem"
              accept="image/*"
              onchange={(e) => onImageFile(e, "banner")}
              label={t("create.bannerPick")}
            >
              {uploading === "banner" ? "…" : t("create.banner")}
            </FileButton>
            {#if iconUrl || bannerUrl}
              <button class="btn inline" style="font-size:0.8rem;padding:0.3rem 0.6rem" onclick={() => { iconUrl = ""; bannerUrl = ""; }}>{t("create.reset")}</button>
            {/if}
          </div>
        </div>
      </div>
      <p class="muted">{t("create.images.body")}</p>
    </div>
    <div>
      <label for="mv">{t("create.field.maxVideo")}</label>
      <div class="row" style="gap:0.75rem;align-items:center;flex-wrap:wrap">
        <input
          id="mv"
          type="number"
          min="0.5"
          step="0.5"
          style="flex:1;min-width:100px"
          bind:value={maxVideoMinutes}
          disabled={maxVideoUnlimited}
        />
        <ToggleSwitch bind:checked={maxVideoUnlimited}>{t("create.field.noLimit")}</ToggleSwitch>
      </div>
    </div>
    <div>
      <label for="approval">{t("create.field.approval")}</label>
      <select id="approval" bind:value={approval}>
        <option value="manual">{t("create.approval.manual")}</option>
        <option value="invite">{t("create.approval.invite")}</option>
        <option value="manual+invite">{t("create.approval.both")}</option>
      </select>
    </div>
    <div>
      <label for="match">{t("create.field.matching")}</label>
      <select id="match" bind:value={matching}>
        <option value="on">{t("create.matching.on")}</option>
        <option value="off">{t("create.matching.off")}</option>
      </select>
    </div>
    <div>
      <label class="row" style="font-weight:400">
        <input type="checkbox" bind:checked={enrollSelf} style="width:auto" />
        {t("create.field.enrollSelf")}
      </label>
      <p class="muted" style="margin:0.25rem 0 0">{t("create.enrollSelf.body")}</p>
    </div>
    <div>
      <label for="talks">{t("create.field.talks")}</label>
      <select id="talks" bind:value={talks}>
        <option value="off">{t("create.talks.off")}</option>
        <option value="on">{t("create.talks.on")}</option>
        <option value="prerecord-first">{t("create.talks.prerecordFirst")}</option>
      </select>
      <p class="muted" style="margin:0.25rem 0 0">{t("create.field.talks.body")}</p>
    </div>
    {#if talks !== "off"}
      <div>
        <label for="mt">{t("create.field.maxTalk")}</label>
        <div class="row" style="gap:0.75rem;align-items:center;flex-wrap:wrap">
          <input
            id="mt"
            type="number"
            min="0.5"
            step="0.5"
            style="flex:1;min-width:100px"
            bind:value={maxTalkMinutes}
            disabled={maxTalkUnlimited}
          />
          <ToggleSwitch bind:checked={maxTalkUnlimited}>{t("create.field.noLimit")}</ToggleSwitch>
        </div>
      </div>
    {/if}
    <div>
      <ToggleSwitch bind:checked={chatEnabled}>
        {t("chat.toggle.label")}
        <span class="badge">{t("chat.toggle.experimental")}</span>
      </ToggleSwitch>
      <p class="muted" style="margin:0.25rem 0 0">{t("chat.toggle.help")}</p>
      {#if chatEnabled}
        <p class="muted" style="margin:0.25rem 0 0">{t("chat.toggle.needsCoordinator")}</p>
      {/if}
    </div>
    <div>
      <div class="field-label">
        {t("create.coordinator.title")}
        <span class="muted" style="font-weight:400">{t("create.coordinator.optional")}</span>
      </div>
      <p class="muted" style="margin:0.25rem 0 0">{t("create.coordinator.body")}</p>
      <CoordinatorPicker bind:selected={coordinatorPubkey} disabled={busy} />
    </div>
    <p class="muted">
      {t("create.rotationNote")}
    </p>
    <button class="btn primary" onclick={submit} disabled={busy}>
      {busy ? t("create.creating") : t("create.submit")}
    </button>
  </div>
{/if}

{#if cropFile}
  <ImageCropper
    file={cropFile}
    aspect={cropWhich === "icon" ? 1 : 2.5}
    outWidth={cropWhich === "icon" ? 512 : 1500}
    onConfirm={onCropConfirm}
    onCancel={() => (cropFile = null)}
  />
{/if}

<style>
  /* Native datetime-local picker (start/end, spec §16 NIP-52): the calendar/clock
     icon already follows the theme via color-scheme (app.css), this just gives it
     the same hover affordance as other interactive inputs. */
  .datetime-input::-webkit-calendar-picker-indicator {
    cursor: pointer;
    border-radius: 4px;
  }
  .datetime-input::-webkit-calendar-picker-indicator:hover {
    background-color: var(--accent-soft);
  }
  .receipt > li + li {
    margin-top: 0.5rem;
  }
</style>
