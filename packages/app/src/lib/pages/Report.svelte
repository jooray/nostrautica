<script lang="ts">
  // Post-event report & payoff flow (spec §13). A print-friendly (browser
  // print-to-PDF) summary of who the user met, who they wanted to meet but
  // didn't, their favorite talks, and their private notes — assembled purely
  // from the user-private 30078 per-event settings and local talk favorites.
  // "Met"/"want-to-meet" stay editable after the event ends (30078 is not
  // time-gated), so this reflects what actually happened at the venue.
  import { onMount } from "svelte";
  import type { DirectoryEntryContent, PerEventSettings } from "@nostrautica/protocol";
  import { session } from "$lib/signer/session.svelte.js";
  import { router } from "$lib/router/router.svelte.js";
  import { connectNdk } from "$lib/nostr/ndk.js";
  import { loadEventContext, cachedEventContext, type EventContext } from "$lib/events/event-context.js";
  import { fetchDirectory, cachedDirectory } from "$lib/events/attendee.js";
  import { fetchProfiles, cachedProfiles, type ProfileMeta } from "$lib/events/social.js";
  import { loadPerEventSettings, cachedPerEventSettings } from "$lib/events/settings.js";
  import { favoriteTalkItems } from "$lib/events/talks.js";
  import { deriveBlindingKey } from "$lib/events/blinding.js";
  import { assembleReport, followTargets, type EventReport, type ReportPerson } from "$lib/events/report.js";
  import { followAll, type FollowAllResult } from "$lib/events/nostr-actions.js";
  import ErrorState from "$lib/components/ErrorState.svelte";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  let { naddr }: { naddr: string } = $props();

  const cachedCtx = cachedEventContext(naddr);
  let ctx = $state<EventContext | null>(cachedCtx ?? null);
  let settings = $state<PerEventSettings | null>(
    cachedCtx ? (cachedPerEventSettings(cachedCtx.coordinate) ?? null) : null,
  );
  let entries = $state<DirectoryEntryContent[]>(cachedCtx ? (cachedDirectory(cachedCtx.coordinate) ?? []) : []);
  let profiles = $state<Map<string, ProfileMeta>>(
    cachedProfiles(entries.map((e) => e.pubkey)),
  );
  let favTalks = $state<{ d: string; title: string }[]>(
    cachedCtx ? favoriteTalkItems(cachedCtx.coordinate) : [],
  );
  let loading = $state(ctx === null);
  let error = $state<unknown>(null);
  let blindingKey: Uint8Array | null = null;

  const entryByPubkey = $derived(new Map(entries.map((e) => [e.pubkey, e])));
  function nameOf(pubkey: string): string {
    return (
      profiles.get(pubkey)?.name ||
      entryByPubkey.get(pubkey)?.name ||
      entryByPubkey.get(pubkey)?.profile.about?.slice(0, 40) ||
      pubkey.slice(0, 10) + "…"
    );
  }

  const report = $derived<EventReport>(
    assembleReport({
      settings: settings ?? { want_to_meet: [], met: [], notes: {} },
      favoriteTalks: favTalks,
      nameOf,
    }),
  );
  const isEmpty = $derived(
    report.met.length === 0 &&
      report.wantedNotMet.length === 0 &&
      report.favoriteTalks.length === 0 &&
      report.notes.length === 0,
  );
  // App-generated identity: the report ends in the "switch to Nostr" moment.
  const isLocalKey = $derived(session.signer?.method === "local");

  async function load() {
    loading = ctx === null;
    error = null;
    try {
      await connectNdk();
      ctx = await loadEventContext(naddr);
      // Event context is the only prerequisite for a truthful report shell. A
      // slow private-settings relay must not leave the route on an indefinite
      // spinner; render the empty state and fill it when 30078 arrives.
      loading = false;
      if (!session.signer) return;
      const signer = session.signer;
      blindingKey = await deriveBlindingKey(signer);
      settings = await loadPerEventSettings(signer, ctx, blindingKey);
      favTalks = favoriteTalkItems(ctx.coordinate);
      // Directory/profile names improve the report but are not report data: a
      // coordinator outage must not hold the page on its loading state. Paint the
      // private settings immediately and enrich names in the background.
      void fetchDirectory(ctx)
        .then((dir) => {
          if (dir.length) entries = dir;
          const need = entries.map((e) => e.pubkey);
          if (!need.length) return;
          return fetchProfiles(need).then((m) => {
            if (m.size) profiles = new Map([...profiles, ...m]);
          });
        })
        .catch(() => {});
    } catch (e) {
      error = e;
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function print() {
    window.print();
  }

  // ── npub export (LOCAL only — no follow pack, no vCard; spec §13) ──────────
  function allPeople(): ReportPerson[] {
    const seen = new Set<string>();
    const out: ReportPerson[] = [];
    for (const p of [...report.met, ...report.wantedNotMet]) {
      if (seen.has(p.pubkey)) continue;
      seen.add(p.pubkey);
      out.push(p);
    }
    return out;
  }
  function npubList(): string {
    return allPeople()
      .map((p) => `${p.npub}  ${p.name}${p.note ? `  — ${p.note}` : ""}`)
      .join("\n");
  }
  let copied = $state(false);
  async function copyNpubs() {
    await navigator.clipboard.writeText(npubList());
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
  function downloadNpubs() {
    const url = URL.createObjectURL(new Blob([npubList()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `nostrautica-people-${naddr.slice(0, 12)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── follow-all with per-person opt-out ────────────────────────────────────
  let confirming = $state(false);
  let optOut = $state<Set<string>>(new Set());
  let following = $state(false);
  let outcome = $state<FollowAllResult | null>(null);
  let followError = $state<string | null>(null);

  const followCandidates = $derived(allPeople());

  function openConfirm() {
    optOut = new Set();
    outcome = null;
    followError = null;
    confirming = true;
  }
  function toggleOptOut(pubkey: string) {
    const next = new Set(optOut);
    if (next.has(pubkey)) next.delete(pubkey);
    else next.add(pubkey);
    optOut = next;
  }
  async function doFollowAll() {
    if (!session.signer || !settings) return;
    const targets = followTargets(settings, optOut);
    if (targets.length === 0) {
      confirming = false;
      return;
    }
    following = true;
    followError = null;
    try {
      outcome = await followAll(session.signer, targets);
      confirming = false;
    } catch (e) {
      followError = e instanceof Error ? e.message : String(e);
    } finally {
      following = false;
    }
  }
</script>

<div class="report">
  {#if error}
    <ErrorState {error} onRetry={load} retrying={loading} />
  {:else}
    <header class="report-head">
      <div>
        <p class="kicker">{t("report.kicker")}</p>
        <h1 class="disp">{ctx?.title ?? t("report.title")}</h1>
      </div>
      <div class="actions no-print">
        <button class="btn inline" onclick={print}>{t("report.print")}</button>
      </div>
    </header>

    {#if loading && isEmpty}
      <p class="muted">{t("report.loading")}</p>
    {:else if isEmpty}
      <div class="card">
        <p class="muted">{t("report.empty")}</p>
        <button class="btn inline" onclick={() => router.go({ name: "attendees", naddr })}>
          {t("report.empty.people")}
        </button>
      </div>
    {:else}
      <!-- Payoff actions (screen only). -->
      <div class="card no-print payoff">
        {#if outcome}
          <p role="status" aria-live="polite" class="outcome">
            {#if outcome.followed.length}
              {tp("report.followed", outcome.followed.length)}
            {/if}
            {#if outcome.alreadyFollowing.length}
              · {tp("report.alreadyFollowing", outcome.alreadyFollowing.length)}
            {/if}
            {#if outcome.failed.length}
              · <span class="fail">{tp("report.followFailed", outcome.failed.length)}</span>
            {/if}
          </p>
        {/if}
        {#if !confirming}
          <div class="row wrap">
            {#if session.loggedIn && followCandidates.length}
              <button class="btn inline primary" onclick={openConfirm}>{t("report.followAll")}</button>
            {/if}
            <button class="btn inline" onclick={copyNpubs}>
              {copied ? t("report.copied") : t("report.copyNpubs")}
            </button>
            <button class="btn inline" onclick={downloadNpubs}>{t("report.downloadNpubs")}</button>
          </div>
        {:else}
          <fieldset class="confirm">
            <legend>{t("report.followConfirm.title")}</legend>
            <p class="muted small">{t("report.followConfirm.body")}</p>
            <ul class="optout-list">
              {#each followCandidates as p (p.pubkey)}
                <li>
                  <label class="row optout">
                    <input
                      type="checkbox"
                      checked={!optOut.has(p.pubkey)}
                      onchange={() => toggleOptOut(p.pubkey)}
                    />
                    <span>{p.name}</span>
                    <span class="mono dim">{p.npub.slice(0, 14)}…</span>
                  </label>
                </li>
              {/each}
            </ul>
            {#if followError}<p class="fail small" role="alert">{followError}</p>{/if}
            <div class="row wrap">
              <button class="btn inline primary" disabled={following} onclick={doFollowAll}>
                {following ? t("report.following") : t("report.followSelected", { n: followCandidates.length - optOut.size })}
              </button>
              <button class="btn inline" disabled={following} onclick={() => (confirming = false)}>
                {t("report.cancel")}
              </button>
            </div>
          </fieldset>
        {/if}
      </div>

      {#if report.met.length}
        <section class="report-section">
          <h2>{t("report.met")}</h2>
          <ul class="people">
            {#each report.met as p (p.pubkey)}
              <li>
                <div class="name-row">
                  <strong>{p.name}</strong>
                  <span class="mono dim">{p.npub}</span>
                </div>
                {#if p.note}<p class="note">{p.note}</p>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if report.wantedNotMet.length}
        <section class="report-section">
          <h2>{t("report.wantedNotMet")}</h2>
          <ul class="people">
            {#each report.wantedNotMet as p (p.pubkey)}
              <li>
                <div class="name-row">
                  <strong>{p.name}</strong>
                  <span class="mono dim">{p.npub}</span>
                </div>
                {#if p.note}<p class="note">{p.note}</p>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if report.favoriteTalks.length}
        <section class="report-section">
          <h2>{t("report.favoriteTalks")}</h2>
          <ul class="talks">
            {#each report.favoriteTalks as talk (talk.d)}
              <li>{talk.title}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if report.notes.length}
        <section class="report-section">
          <h2>{t("report.notes")}</h2>
          <ul class="people">
            {#each report.notes as p (p.pubkey)}
              <li>
                <div class="name-row">
                  <strong>{p.name}</strong>
                  <span class="mono dim">{p.npub}</span>
                </div>
                <p class="note">{p.note}</p>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if isLocalKey}
        <!-- App-generated identity: the payoff ends in the "switch to Nostr"
             moment (nsec/ncryptsec export walkthrough + client links on Me). -->
        <section class="card no-print switch">
          <h2>{t("report.switch.title")}</h2>
          <p class="muted">{t("report.switch.body")}</p>
          <button class="btn primary" onclick={() => router.go({ name: "me" })}>
            {t("report.switch.action")}
          </button>
        </section>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .report {
    max-width: 46rem;
    margin: 0 auto;
  }
  .report-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h1.disp {
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: 0;
    margin: 0.1rem 0 0;
  }
  .kicker {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-dim);
    margin: 0;
  }
  .payoff {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .row.wrap {
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .report-section {
    margin-top: 1.5rem;
  }
  .report-section h2 {
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.3rem;
  }
  .people,
  .talks {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .talks {
    gap: 0.35rem;
  }
  .talks li {
    padding-left: 1rem;
    position: relative;
  }
  .talks li::before {
    content: "★";
    position: absolute;
    left: 0;
    color: var(--accent);
  }
  .name-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .mono {
    font-family: var(--font-mono, monospace);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .dim {
    color: var(--text-dim);
  }
  .note {
    margin: 0.2rem 0 0;
    color: var(--text);
    white-space: pre-wrap;
  }
  .confirm {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem;
    margin: 0;
  }
  .optout-list {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    max-height: 16rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .optout {
    gap: 0.5rem;
    align-items: center;
  }
  .small {
    font-size: 0.82rem;
  }
  .fail {
    color: var(--danger);
  }
  .switch {
    margin-top: 1.5rem;
  }

  /* Print stylesheet: strip chrome, keep the report body on paper. */
  @media print {
    .no-print {
      display: none !important;
    }
    .report {
      max-width: none;
    }
    .report-section {
      break-inside: avoid;
    }
    .people li,
    .talks li {
      break-inside: avoid;
    }
  }
</style>
