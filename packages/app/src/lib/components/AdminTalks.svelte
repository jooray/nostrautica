<script lang="ts">
  /**
   * Talk moderation domain (Phase 5A carry-over b — Admin domain split). Owns its
   * own interaction state (which talk is previewing, which is mid-moderation) and
   * the publish/reject action; the parent keeps the source list + the acted-on set
   * (which feeds the ops-overview count) and is told via `onModerated` when a talk
   * leaves the queue. First slice of breaking Admin.svelte's monolith into
   * domain components — queue/people/communicate remain in the page for now.
   */
  import type { EventContext } from "$lib/events/event-context.js";
  import type { PendingTalk } from "$lib/events/talks.js";
  import { sendAdminCommand } from "$lib/events/organizer.js";
  import MediaPlayer from "./MediaPlayer.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    ctx,
    talks,
    onModerated,
    onError,
  }: {
    ctx: EventContext;
    /** The still-pending talks to show (parent filters out already-moderated). */
    talks: PendingTalk[];
    /** Called with a talk's key once it's been published/rejected. */
    onModerated: (key: string) => void;
    onError: (message: string) => void;
  } = $props();

  let talkBusy = $state<string | null>(null);
  let previewingTalk = $state<string | null>(null);

  function tkKey(tk: PendingTalk): string {
    return `${tk.pubkey}:${tk.talkD}`;
  }

  async function moderate(tk: PendingTalk, cmd: "talk_publish" | "talk_reject") {
    if (!ctx.config.coordinator) return;
    const key = tkKey(tk);
    talkBusy = key;
    try {
      await sendAdminCommand(ctx, cmd, { pubkey: tk.pubkey, talk_d: tk.talkD });
      onModerated(key);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      talkBusy = null;
    }
  }

  const short = (pk: string) => `${pk.slice(0, 8)}…`;
</script>

<h2 class="section-head">{t("admin.talks.mod.section")}</h2>
<div class="card">
  <div class="field-label">{t("admin.talks.mod.title")}</div>
  {#if !ctx.config.coordinator}
    <!-- Publishing a talk's 31610 is a coordinator action (spec F2). Without one
         there's no publish path, so surface that instead of dead buttons. -->
    <p class="muted">{t("admin.talks.mod.needsCoordinator")}</p>
  {:else if talks.length === 0}
    <p class="muted">{t("admin.talks.mod.none")}</p>
  {:else}
    <p class="muted">{t("admin.talks.mod.body")}</p>
    <div class="stack">
      {#each talks as tk (tkKey(tk))}
        <div class="card" style="background:var(--bg-elev2)">
          <strong>{tk.title}</strong>
          <span class="badge">{short(tk.pubkey)}</span>
          {#if tk.revision > 0}
            <span class="badge">{t("admin.talks.mod.revision", { n: tk.revision })}</span>
          {/if}
          {#if tk.description}<p class="muted">{tk.description}</p>{/if}
          {#if previewingTalk === tkKey(tk)}
            <MediaPlayer descriptor={tk.media} />
          {:else}
            <button class="btn inline" onclick={() => (previewingTalk = tkKey(tk))}>
              {t("admin.talks.mod.preview")}
            </button>
          {/if}
          <div class="row">
            <button
              class="btn primary"
              onclick={() => moderate(tk, "talk_publish")}
              disabled={talkBusy === tkKey(tk)}
            >
              {t("admin.talks.mod.publish")}
            </button>
            <button
              class="btn inline danger"
              onclick={() => moderate(tk, "talk_reject")}
              disabled={talkBusy === tkKey(tk)}
            >
              {t("admin.talks.mod.reject")}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Matches the ops-console section heading in Admin (kept in step). */
  .section-head {
    margin: 1.5rem 0 0.25rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
</style>
