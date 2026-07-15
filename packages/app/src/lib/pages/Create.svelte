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
  import { publishProfile, ensureRelayList, ensureDmRelayList, seedFollows } from "$lib/events/nostr-actions.js";
  import BackupCard from "$lib/components/BackupCard.svelte";
  import LanguagePicker from "$lib/components/LanguagePicker.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let title = $state("");
  let summary = $state("");
  let startLocal = $state("");
  let endLocal = $state("");
  let locationStr = $state("");
  let iconUrl = $state("");
  let bannerUrl = $state("");
  let uploading = $state<"icon" | "banner" | null>(null);
  let maxVideoSec = $state(90);
  let maxTalkSec = $state(900);
  let talks = $state<"off" | "on" | "prerecord-first">("off");
  let matching = $state<"on" | "off">("on");
  let matchVisibility = $state<"pair" | "event">("pair");
  let approval = $state<"manual" | "invite" | "manual+invite">("manual+invite");
  let lang = $state<string>("en"); // ISO 639-1 event language (default English)

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
      error = t("create.error.loginToUpload");
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
      error = t("create.error.uploadFailed", { reason: err instanceof Error ? err.message : String(err) });
    } finally {
      uploading = null;
    }
  }

  async function submit() {
    error = null;
    if (!title.trim() || !startLocal) {
      error = t("create.error.titleRequired");
      return;
    }
    if (!session.loggedIn && !organizerName.trim()) {
      error = t("create.error.nameRequired");
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
          maxTalkSec,
          matching,
          matchVisibility,
          approval,
          nostrContext: 100,
          lang,
          talks,
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

<h1>{t("create.title")}</h1>

{#if created}
  <div class="card">
    <h2>{t("create.created")}</h2>
    <!-- Next steps as a checklist, not a pile of equal buttons (UI-SUGGESTIONS #14). -->
    <ol class="stack" style="margin:0.75rem 0 0;padding-left:1.25rem">
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
      <li style="margin-top:0.75rem">
        <strong>{t("create.step.coordinator")}</strong>
        <p class="muted" style="margin:0.25rem 0">
          {t("create.step.coordinator.body")}
        </p>
      </li>
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
  <div class="card stack">
    {#if !session.loggedIn}
      <div>
        <label for="on">{t("create.organizerName")}</label>
        <input id="on" bind:value={organizerName} placeholder={t("create.organizerName.placeholder")} />
        <p class="muted" style="margin:0.25rem 0 0">
          {t("create.organizerName.body")}
        </p>
      </div>
    {/if}
    <div>
      <label for="t">{t("create.field.title")}</label>
      <input id="t" bind:value={title} placeholder={t("create.field.title.placeholder")} />
    </div>
    <div>
      <label for="s">{t("create.field.summary")}</label>
      <textarea id="s" rows="3" bind:value={summary}></textarea>
    </div>
    <div>
      <label for="st">{t("create.field.start")}</label>
      <input id="st" type="datetime-local" bind:value={startLocal} />
    </div>
    <div>
      <label for="en">{t("create.field.end")}</label>
      <input id="en" type="datetime-local" bind:value={endLocal} min={startLocal} />
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
    <!-- Rarely-changed options tucked away; title + date is enough (UI-SUGGESTIONS #13). -->
    <details>
      <summary class="muted" style="cursor:pointer">{t("create.advanced")}</summary>
      <div class="stack" style="margin-top:0.75rem">
    <div>
      <div class="field-label">{t("create.field.images")} <span class="muted" style="font-weight:400">{t("create.field.images.optional")}</span></div>
      <div class="row" style="align-items:flex-start;gap:0.75rem">
        <div style="flex:none;text-align:center">
          <img src={previewIcon} alt={t("create.iconAlt")} style="width:64px;height:64px;border-radius:14px;object-fit:cover" />
          <div style="margin-top:0.35rem">
            <label class="btn inline" style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem">
              {uploading === "icon" ? "…" : t("create.icon")}
              <input type="file" accept="image/*" onchange={(e) => onImageFile(e, "icon")} style="display:none" />
            </label>
          </div>
        </div>
        <div style="flex:1">
          <img src={previewBanner} alt={t("create.bannerAlt")} style="width:100%;border-radius:12px;aspect-ratio:5/2;object-fit:cover" />
          <div class="row" style="margin-top:0.35rem">
            <label class="btn inline" style="width:auto;margin:0;font-size:0.8rem;padding:0.3rem 0.6rem">
              {uploading === "banner" ? "…" : t("create.banner")}
              <input type="file" accept="image/*" onchange={(e) => onImageFile(e, "banner")} style="display:none" />
            </label>
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
      <input id="mv" type="number" bind:value={maxVideoSec} />
    </div>
      </div>
    </details>
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
        <input id="mt" type="number" bind:value={maxTalkSec} />
      </div>
    {/if}
    <p class="muted">
      {t("create.rotationNote")}
    </p>
    <button class="btn primary" onclick={submit} disabled={busy}>
      {busy ? t("create.creating") : t("create.submit")}
    </button>
  </div>
{/if}
