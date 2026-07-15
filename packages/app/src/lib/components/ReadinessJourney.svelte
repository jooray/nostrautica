<script lang="ts">
  // The Overview readiness stepper (redesign §4.1). An ordered <ol> with
  // aria-current="step" on the current step, state conveyed in text (not knob
  // colour alone, A6), and exactly one primary CTA reachable right after the
  // list. When everything is done it collapses to a single "all set" row so no
  // CTA competes.
  import type { Readiness } from "$lib/events/readiness.js";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";

  let { readiness, naddr }: { readiness: Readiness; naddr: string } = $props();

  function stepClass(i: number): "done" | "cur" | "todo" {
    const s = readiness.steps[i]!;
    if (s.state === "complete") return "done";
    if (i === readiness.currentIndex) return "cur";
    return "todo";
  }
  function stateLabel(i: number): string {
    const cls = stepClass(i);
    return cls === "done"
      ? t("readiness.state.done")
      : cls === "cur"
        ? t("readiness.state.current")
        : t("readiness.state.upcoming");
  }
</script>

<div class="card readiness">
  {#if readiness.allComplete}
    <span class="badge ok allset">
      <Icon name="check" size={14} />
      {t("readiness.allSet")}
    </span>
    {#if readiness.matchesReady}
      <button class="btn primary" style="margin-top:0.75rem" onclick={() => router.go({ name: "matches", naddr })}>
        {t("readiness.cta.matches")}
      </button>
    {/if}
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "attendees", naddr })}>
      {t("event.seeWhosHere")}
    </button>
  {:else}
    <div class="head">
      <strong>{t("readiness.title")}</strong>
      <span class="badge accent">
        {t("readiness.progress", { done: readiness.doneCount, total: readiness.steps.length })}
      </span>
    </div>

    <ol class="steps">
      {#each readiness.steps as step, i (step.id)}
        {@const cls = stepClass(i)}
        <li class="step {cls}" aria-current={cls === "cur" ? "step" : undefined}>
          <span class="rail" aria-hidden="true">
            <span class="knob">
              {#if cls === "done"}<Icon name="check" size={13} />{:else if cls === "cur"}<span class="dot"></span>{/if}
            </span>
            {#if i < readiness.steps.length - 1}<span class="line"></span>{/if}
          </span>
          <span class="body">
            <span class="lab">{t(step.labelKey)}</span>
            <span class="visually-hidden">{stateLabel(i)}</span>
            {#if cls === "cur" && step.hintKey}<span class="hint">{t(step.hintKey)}</span>{/if}
          </span>
        </li>
      {/each}
    </ol>

    {#if readiness.primary}
      <button class="btn primary" style="margin-top:0.75rem" onclick={() => router.go(readiness.primary!.route)}>
        {t(readiness.primary.labelKey)}
      </button>
    {/if}
    {#if readiness.matchesReady}
      <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "matches", naddr })}>
        {t("readiness.cta.matches")}
      </button>
    {/if}
    <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "attendees", naddr })}>
      {t("event.seeWhosHere")}
    </button>
  {/if}
</div>

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
  }
  .allset {
    font-size: 0.85rem;
    padding: 0.3rem 0.7rem;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .step {
    display: flex;
    gap: 0.7rem;
    align-items: flex-start;
    padding: 0.1rem 0;
  }
  .rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
    align-self: stretch;
  }
  .knob {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    border: 2px solid var(--border);
    background: var(--bg-elev);
    flex: none;
    color: var(--text-dim);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .line {
    width: 2px;
    flex: 1;
    min-height: 14px;
    background: var(--border);
  }
  .step.done .knob {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .step.done .line {
    background: var(--ok);
  }
  .step.cur .knob {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .body {
    padding-bottom: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .lab {
    font-weight: 600;
    font-size: 0.92rem;
  }
  .step.todo .lab {
    color: var(--text-dim);
    font-weight: 500;
  }
  .hint {
    font-size: 0.8rem;
    color: var(--accent);
  }
</style>
