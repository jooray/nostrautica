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
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  let ctx = $state<EventContext | null>(null);
  let entry = $state<DirectoryEntryContent | null>(null);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let busy = $state(false);
  let saved = $state(false);

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
    try {
      await submitProfileCorrection(session.signer, ctx, buildCorrection());
      saved = true;
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
  <!-- You wrote: authored identity fields (edited only via the submission flow). -->
  <div class="card">
    <div class="field-label">{t("profile.authored.title")}</div>
    <p class="muted small">{t("profile.authored.hint")}</p>
    {#if entry?.profile.about}<p>{entry.profile.about}</p>{/if}
    {#if entry?.profile.skills?.length}
      <div class="row" style="flex-wrap:wrap">
        {#each entry.profile.skills as s (s)}<span class="badge">{s}</span>{/each}
      </div>
    {/if}
    {#if entry?.profile.looking_for}
      <p class="muted">{t("attendee.lookingFor", { value: entry.profile.looking_for })}</p>
    {/if}
    <button class="btn inline" style="margin-top:0.5rem" onclick={() => router.go({ name: "record", naddr, talk: false })}>
      {t("profile.authored.edit")}
    </button>
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
    {#if saved}<p class="muted small">{t("profile.saved.hint")}</p>{/if}
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
