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

  let {
    readiness,
    naddr,
    lastCheckedAt,
    onRefresh,
    refreshing = false,
  }: {
    readiness: Readiness;
    naddr: string;
    /** Epoch ms of the last completed network refresh, or undefined. */
    lastCheckedAt?: number;
    /** Re-check the journey's network inputs. Omitted ⇒ no footer is rendered. */
    onRefresh?: () => void;
    refreshing?: boolean;
  } = $props();

  /** "14:32" in the viewer's locale — a clock time, not a countdown: the card is
   *  refreshed on demand and on return to the tab, not on a timer, so a "next check
   *  in Ns" would be a promise nothing keeps. */
  const checkedLabel = $derived(
    lastCheckedAt === undefined
      ? undefined
      : new Date(lastCheckedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  );

  // The primary CTA's route carries the naddr readiness was DERIVED from, while
  // every other button here uses the `naddr` prop. Those must be the same event:
  // the readiness store is a module singleton, and when a stale one leaked
  // through, this card offered one event's "Join" beside another's "See who's
  // here". The page gates on the coordinate now, so this is the second line of
  // defence — drop the CTA rather than navigate somewhere the user didn't ask for.
  const primary = $derived.by(() => {
    const p = readiness.primary;
    if (!p) return undefined;
    const target = (p.route as { naddr?: string }).naddr;
    return target !== undefined && target !== naddr ? undefined : p;
  });

  // "fail" is its own class, not a variant of "cur": a step the coordinator has
  // REPORTED as stopped must not look like one that is merely in progress — that
  // was the whole complaint (a stepper saying "building your profile" beside a
  // banner saying it had failed). It also carries its hint whether or not it
  // happens to be the current step.
  function stepClass(i: number): "done" | "fail" | "cur" | "todo" {
    const s = readiness.steps[i]!;
    if (s.state === "complete") return "done";
    if (s.state === "failed") return "fail";
    if (i === readiness.currentIndex) return "cur";
    return "todo";
  }
  function stateLabel(i: number): string {
    const cls = stepClass(i);
    return cls === "done"
      ? t("readiness.state.done")
      : cls === "fail"
        ? t("readiness.state.failed")
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
    {#if readiness.viewerIsMember}
      <!-- People is member-gated (UX-O4): only offer "See who's here" to members. -->
      <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "attendees", naddr })}>
        {t("event.seeWhosHere")}
      </button>
    {/if}
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
        <li class="step {cls}" aria-current={cls === "cur" || cls === "fail" ? "step" : undefined}>
          <span class="rail" aria-hidden="true">
            <span class="knob">
              {#if cls === "done"}<Icon name="check" size={13} />{:else if cls === "fail"}<span class="bang">!</span>{:else if cls === "cur"}<span class="dot"></span>{/if}
            </span>
            {#if i < readiness.steps.length - 1}<span class="line"></span>{/if}
          </span>
          <span class="body">
            <span class="lab">{t(step.labelKey)}</span>
            <span class="visually-hidden">{stateLabel(i)}</span>
            {#if (cls === "cur" || cls === "fail") && step.hintKey}
              <span class="hint" class:bad={cls === "fail"}>{t(step.hintKey)}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ol>

    {#if primary}
      <button class="btn primary" style="margin-top:0.75rem" onclick={() => router.go(primary.route)}>
        {t(primary.labelKey)}
      </button>
    {/if}
    {#if readiness.matchesReady}
      <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "matches", naddr })}>
        {t("readiness.cta.matches")}
      </button>
    {/if}
    {#if readiness.viewerIsMember}
      <!-- People is member-gated (UX-O4): only offer "See who's here" to members. -->
      <button class="btn" style="margin-top:0.5rem" onclick={() => router.go({ name: "attendees", naddr })}>
        {t("event.seeWhosHere")}
      </button>
    {/if}
    {#if onRefresh}
      <p class="checked" role="status">
        {#if checkedLabel}<span class="muted">{t("readiness.lastChecked", { time: checkedLabel })}</span>{/if}
        <button class="btn inline ghost" onclick={onRefresh} disabled={refreshing}>
          {refreshing ? t("readiness.checking") : t("readiness.checkAgain")}
        </button>
      </p>
    {/if}
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
  .step.fail .knob {
    background: var(--warn);
    border-color: var(--warn);
    color: #fff;
  }
  .bang {
    font-size: 0.8rem;
    font-weight: 700;
    line-height: 1;
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
  .hint.bad {
    color: var(--warn);
  }
  .checked {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
  }
</style>
