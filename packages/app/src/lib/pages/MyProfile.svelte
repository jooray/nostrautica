<script lang="ts">
  // "My event profile" (spec F3, audit U9): the attendee sees their own directory
  // entry as others see it — the authored "You wrote" fields and the coordinator-
  // generated "Generated from your intro" ai_profile — and can override specific
  // generated fields, blank them, or hide the ai_profile entirely. Each action
  // publishes a 21608 Profile Correction to E_inbox; the coordinator re-applies it
  // on every 31603 publish, so it survives reprocessing.
  import { onMount } from "svelte";
  import { AI_PROFILE_FIELDS, type AiProfileField } from "@nostrautica/protocol";
  import type { DirectoryEntryContent } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectoryEntry } from "$lib/events/attendee.js";
  import { submitProfileCorrection, type CorrectionInput } from "$lib/events/correction.js";
  import {
    fieldsFromProfile,
    buildAuthoredSubmission,
    authoredChanged,
    type AuthoredFields,
  } from "$lib/events/authored-profile.js";
  import { loadSelfCopy, submitProfileAndMedia, aggregateOutcome } from "$lib/media/submit.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { refreshGuard } from "$lib/stores/refresh-guard.svelte.js";
  import { saveFormDraft, loadFormDraft, clearDraft } from "$lib/stores/drafts.js";
  import type { MediaDescriptor } from "@nostrautica/protocol";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let entry = $state<DirectoryEntryContent | null>(null);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let busy = $state(false);
  let saved = $state(false);
  let saveQueued = $state(false); // correction sits in the offline outbox (UX-15)

  // Authored-profile editing (UX-O3): a real form for the fields the attendee
  // wrote (about/skills/looking_for/links/text intro), submitting a new 21601 rev
  // — separate from re-recording media and from AI-profile correction (21608).
  let editingAuthored = $state(false);
  let authored = $state<AuthoredFields>({ about: "", skills: "", lookingFor: "", links: "", introText: "" });
  let authoredBaseline = $state<AuthoredFields>({ about: "", skills: "", lookingFor: "", links: "", introText: "" });
  let authoredMedia = $state<MediaDescriptor[]>([]); // preserved across an authored edit
  let authoredBusy = $state(false);
  let authoredSaved = $state(false);
  let authoredQueued = $state(false); // save sits in the offline outbox (U2)
  let authoredError = $state<unknown>(null);
  const authoredDirty = $derived(authoredChanged(authored, authoredBaseline));
  // Durable draft of UNSENT authored-profile edits (audit U9): survives a
  // crash/eviction/reload, not just a deferred SW refresh. Owner-scoped per event.
  const authoredDraftId = $derived(ctx ? `authprofile:${ctx.coordinate}` : "");
  let authoredDraftRestored = $state(false);

  async function openAuthoredEditor() {
    if (!session.signer || !ctx) return;
    authoredError = null;
    authoredSaved = false;
    // Seed from the self-copy (the attendee's own durable submission, which holds
    // the authored fields + media + text intro), falling back to the directory
    // entry's authored profile.
    let profile = entry?.profile;
    let introText = entry?.intro_text;
    let media: MediaDescriptor[] = entry?.media ?? [];
    try {
      const bk = await deriveBlindingKey(session.signer);
      const self = await loadSelfCopy(session.signer, ctx, bk);
      if (self?.profile) profile = self.profile;
      if (self?.introText !== undefined) introText = self.introText;
      if (self?.media?.length) media = self.media;
    } catch {
      /* fall back to the directory entry's fields */
    }
    const f = fieldsFromProfile(profile, introText);
    authored = { ...f };
    authoredBaseline = { ...f };
    authoredMedia = media;
    // U9: restore an unsent draft that differs from the loaded baseline.
    const draft = authoredDraftId
      ? loadFormDraft<AuthoredFields>(authoredDraftId)
      : undefined;
    if (draft && authoredChanged(draft, f)) {
      authored = { ...f, ...draft };
      authoredDraftRestored = true;
    }
    editingAuthored = true;
  }

  // Hold an auto-refresh while an authored edit is in progress (App-2).
  $effect(() => {
    if (editingAuthored && authoredDirty) return refreshGuard.hold("authored");
  });

  // Persist unsent authored edits as they're typed (U9); clear once they match the
  // baseline again so a later visit doesn't restore already-saved fields.
  $effect(() => {
    if (!editingAuthored || !authoredDraftId) return;
    if (authoredDirty) {
      saveFormDraft(authoredDraftId, {
        about: authored.about,
        skills: authored.skills,
        lookingFor: authored.lookingFor,
        links: authored.links,
        introText: authored.introText,
      });
    } else clearDraft(authoredDraftId);
  });

  async function saveAuthored() {
    if (!session.signer || !ctx) return;
    authoredBusy = true;
    authoredError = null;
    authoredSaved = false;
    authoredQueued = false;
    try {
      const bk = await deriveBlindingKey(session.signer);
      const { profile, introText, media } = buildAuthoredSubmission(authored, authoredMedia);
      const outcome = await submitProfileAndMedia(session.signer, ctx, { profile, media, blindingKey: bk, introText });
      authoredSaved = true;
      // U2: don't claim it's shared if the relay publish only queued locally.
      authoredQueued = aggregateOutcome(outcome) === "queued";
      if (authoredQueued) outbox.noteQueued();
      authoredBaseline = { ...authored };
      // U9: submitted (or durably queued) — retire the unsent draft.
      if (authoredDraftId) clearDraft(authoredDraftId);
      authoredDraftRestored = false;
    } catch (e) {
      authoredError = e;
    } finally {
      authoredBusy = false;
    }
  }

  // Editable copies of each generated field. List fields are edited as one item
  // per line; summary is free text. `initial` is the loaded baseline so only
  // fields the attendee actually changes are sent as overrides.
  let values = $state<Record<AiProfileField, string>>({
    summary: "", skills: "", interests: "", offers: "", seeks: "",
  });
  let initial: Record<AiProfileField, string> = { summary: "", skills: "", interests: "", offers: "", seeks: "" };
  let hide = $state<Record<AiProfileField, boolean>>({
    summary: false, skills: false, interests: false, offers: false, seeks: false,
  });
  let hideAll = $state(false);
  let report = $state("");

  // Draft-safe auto-refresh (App-2): hold the pending reload while the organizer
  // has an unsaved correction/report in progress; it applies once submitted or
  // cleared. (Values load from the network, so a reload restores them anyway —
  // this only prevents a reload landing mid-edit.)
  $effect(() => {
    const edited =
      report.trim().length > 0 || AI_PROFILE_FIELDS.some((f) => values[f] !== initial[f]);
    if (edited) return refreshGuard.hold("profile");
  });

  const isList = (f: AiProfileField) => f !== "summary";

  function fieldToString(f: AiProfileField, ai: DirectoryEntryContent["ai_profile"]): string {
    if (!ai) return "";
    if (f === "summary") return ai.summary ?? "";
    return (ai[f] ?? []).join("\n");
  }

  function loadFromEntry(e: DirectoryEntryContent | null): void {
    const v: Record<AiProfileField, string> = {
      summary: fieldToString("summary", e?.ai_profile),
      skills: fieldToString("skills", e?.ai_profile),
      interests: fieldToString("interests", e?.ai_profile),
      offers: fieldToString("offers", e?.ai_profile),
      seeks: fieldToString("seeks", e?.ai_profile),
    };
    values = { ...v };
    initial = { ...v };
    hide = { summary: false, skills: false, interests: false, offers: false, seeks: false };
    hideAll = false;
  }

  onMount(async () => {
    try {
      if (!session.signer) return router.go({ name: "login" });
      const pubkey = await session.signer.getPublicKey();
      await connectNdk();
      ctx = await loadEventContext(naddr);
      entry = (await fetchDirectoryEntry(ctx, pubkey)) ?? null;
      loadFromEntry(entry);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });

  const parseLines = (s: string): string[] =>
    s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  function buildCorrection(): CorrectionInput {
    if (hideAll) return { hidden: true };
    const overrides: Record<string, unknown> = {};
    const hiddenFields: AiProfileField[] = [];
    for (const f of AI_PROFILE_FIELDS) {
      if (hide[f]) {
        hiddenFields.push(f);
        continue;
      }
      if (values[f] === initial[f]) continue; // unchanged → leave the generated value
      overrides[f] = isList(f) ? parseLines(values[f]) : values[f];
    }
    const input: CorrectionInput = {};
    if (Object.keys(overrides).length) input.overrides = overrides as CorrectionInput["overrides"];
    if (hiddenFields.length) input.hidden_fields = hiddenFields;
    if (report.trim()) input.report = report.trim();
    return input;
  }

  async function save(): Promise<void> {
    if (!session.signer || !ctx) return;
    busy = true;
    error = null;
    saved = false;
    saveQueued = false;
    try {
      const published = await submitProfileCorrection(session.signer, ctx, buildCorrection());
      saved = true;
      // Queued for the offline flush, not sent yet (audit UX-15) — say so.
      if (!published) {
        saveQueued = true;
        outbox.noteQueued();
      }
    } catch (e) {
      error = e;
    } finally {
      busy = false;
    }
  }

  const fieldLabel = (f: AiProfileField): string => t(`profile.field.${f}`);
</script>

<button class="btn inline" style="margin:0.5rem 0" onclick={() => router.go({ name: "eventMore", naddr })}>
  {t("nav.back")}
</button>

<h1>{t("profile.mine.title")}</h1>
<p class="muted">{t("profile.mine.intro")}</p>

{#if error}<ErrorState {error} />{/if}

{#if loading}
  <p class="muted">{t("app.loading")}</p>
{:else}
  <!-- You wrote: authored identity fields. UX-O3 — a real edit form here submits a
       new 21601 rev; re-recording media and AI correction are separate actions. -->
  <div class="card">
    <div class="field-label">{t("profile.authored.title")}</div>
    <p class="muted small">{t("profile.authored.hint")}</p>
    {#if !editingAuthored}
      {#if entry?.profile.about}<p>{entry.profile.about}</p>{/if}
      {#if entry?.profile.skills?.length}
        <div class="row" style="flex-wrap:wrap">
          {#each [...new Set(entry.profile.skills)] as s (s)}<span class="badge">{s}</span>{/each}
        </div>
      {/if}
      {#if entry?.profile.looking_for}
        <p class="muted">{t("attendee.lookingFor", { value: entry.profile.looking_for })}</p>
      {/if}
      {#if entry?.intro_text}<p class="muted">{entry.intro_text}</p>{/if}
      <div class="row" style="margin-top:0.5rem;flex-wrap:wrap">
        <button class="btn inline" onclick={openAuthoredEditor}>{t("profile.authored.edit")}</button>
        <button class="btn inline" onclick={() => router.go({ name: "record", naddr, talk: false })}>
          {t("profile.authored.rerecord")}
        </button>
      </div>
    {:else}
      {#if authoredError}<ErrorState error={authoredError} />{/if}
      {#if authoredDraftRestored}
        <!-- Visible restore of unsent authored edits (U9). -->
        <div class="row" style="justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap">
          <span class="muted small" role="status">{t("draft.restored")}</span>
          <button
            class="btn inline"
            style="flex:none"
            onclick={() => {
              authored = { ...authoredBaseline };
              authoredDraftRestored = false;
              if (authoredDraftId) clearDraft(authoredDraftId);
            }}>{t("draft.discard")}</button>
        </div>
      {/if}
      <div class="editfield">
        <label for="au-about">{t("profile.authored.about")}</label>
        <textarea id="au-about" rows="3" bind:value={authored.about}></textarea>
      </div>
      <div class="editfield">
        <label for="au-skills">{t("profile.authored.skills")}</label>
        <input id="au-skills" bind:value={authored.skills} placeholder={t("profile.authored.skills.placeholder")} />
      </div>
      <div class="editfield">
        <label for="au-lf">{t("profile.authored.lookingFor")}</label>
        <input id="au-lf" bind:value={authored.lookingFor} />
      </div>
      <div class="editfield">
        <label for="au-links">{t("profile.authored.links")}</label>
        <textarea id="au-links" rows="2" bind:value={authored.links} placeholder={t("profile.authored.links.placeholder")}></textarea>
      </div>
      <div class="editfield">
        <label for="au-intro">{t("profile.authored.introText")}</label>
        <textarea id="au-intro" rows="3" bind:value={authored.introText}></textarea>
        <span class="muted small">{t("profile.authored.introText.hint")}</span>
      </div>
      <div class="row" style="flex-wrap:wrap;align-items:center">
        <button class="btn primary" onclick={saveAuthored} disabled={authoredBusy || !authoredDirty}>
          {authoredBusy ? t("profile.saving") : t("profile.save")}
        </button>
        <button class="btn inline" onclick={() => (editingAuthored = false)}>{t("profile.authored.cancel")}</button>
        {#if authoredSaved}<span class="badge" role="status">{t("profile.saved")}</span>{/if}
      </div>
      {#if authoredSaved && authoredQueued}
        <p class="muted small" role="status">{t("sync.queued")}</p>
      {:else if authoredSaved}
        <p class="muted small">{t("profile.authored.saved.hint")}</p>
      {/if}
    {/if}
  </div>

  <!-- Generated from your intro: the ai_profile the coordinator built. -->
  <div class="card stack">
    <div class="field-label">{t("profile.generated.title")}</div>
    <p class="muted small">{t("profile.generated.hint")}</p>

    {#if !entry?.ai_profile}
      <p class="muted">{t("profile.generated.none")}</p>
    {/if}

    <label class="hidetoggle">
      <input type="checkbox" bind:checked={hideAll} />
      <span>{t("profile.hide.all")}</span>
    </label>

    {#if !hideAll && entry?.ai_profile}
      {#each AI_PROFILE_FIELDS as f (f)}
        <div class="editfield">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <span class="field-label">{fieldLabel(f)}</span>
            <label class="hidetoggle small">
              <input type="checkbox" bind:checked={hide[f]} />
              <span>{t("profile.field.hide")}</span>
            </label>
          </div>
          {#if !hide[f]}
            <textarea
              rows={f === "summary" ? 4 : 3}
              bind:value={values[f]}
              placeholder={isList(f) ? t("profile.field.listPlaceholder") : ""}
            ></textarea>
            {#if isList(f)}<span class="muted small">{t("profile.field.listHint")}</span>{/if}
          {:else}
            <span class="muted small">{t("profile.field.hidden")}</span>
          {/if}
        </div>
      {/each}
    {/if}

    <div class="editfield">
      <span class="field-label">{t("profile.report.title")}</span>
      <textarea rows="2" bind:value={report} placeholder={t("profile.report.placeholder")}></textarea>
    </div>

    <div class="row" style="flex-wrap:wrap;align-items:center">
      <button class="btn primary" onclick={save} disabled={busy}>
        {busy ? t("profile.saving") : t("profile.save")}
      </button>
      {#if saved}<span class="badge" role="status">{t("profile.saved")}</span>{/if}
    </div>
    {#if saved && !saveQueued}<p class="muted small">{t("profile.saved.hint")}</p>{/if}
    {#if saveQueued}<p class="muted small" role="status">{t("sync.queued")}</p>{/if}
  </div>
{/if}

<style>
  .small {
    font-size: 0.82rem;
  }
  .stack > * + * {
    margin-top: 0.75rem;
  }
  .editfield {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .hidetoggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .hidetoggle.small {
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .hidetoggle input {
    width: auto;
    min-height: 0;
    margin: 0;
  }
</style>
