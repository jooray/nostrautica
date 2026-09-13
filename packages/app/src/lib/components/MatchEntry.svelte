<script lang="ts">
  // One matched person in the merged People list (2026-09-13).
  //
  // Replaces the Matches tab's card, which spent ~74% of its height on chrome:
  // measured on the 390px docs screenshot, a card was ~373px with a real median
  // reasoning, of which the reasoning itself was ~96px. The rest was a band pill
  // repeating the same two words on every card, three buttons (two full-width),
  // a percentage disclosure, and padding.
  //
  // That chrome is what forced the old "tap a card to see why" question. The
  // reasoning was never the problem: measured over 1026 real coordinator
  // reasonings it runs 168 chars median, 276 max — four lines on a phone, seven
  // worst case. So nothing here is clamped and nothing is collapsed: the whole
  // reasoning is always on screen. What IS collapsed is the icebreaker block,
  // which is 3 × ~104 chars — three times the reasoning, and wanted only after
  // you have decided to talk to someone.
  //
  // The band is NOT rendered here. In the merged list the band is the section
  // heading above a run of entries, said once instead of once per person; a
  // single match shown out of list context (the profile page) keeps the pill via
  // MatchDetails. Actions come in as a snippet so the list owns one action
  // vocabulary shared with the unmatched roster rows.
  import type { Snippet } from "svelte";
  import type { Match } from "@nostrautica/protocol";
  import Avatar from "./Avatar.svelte";
  import Icon from "./icons/Icon.svelte";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    match,
    name,
    sub,
    picture,
    isNew = false,
    selected = false,
    onOpen,
    actions,
  }: {
    match: Match;
    name: string;
    /** One quiet line of who they are — their own bio, not the match reasoning. */
    sub?: string;
    picture?: string;
    /** Arrived since this list was last opened (spec §13 watermark). */
    isNew?: boolean;
    /** Open in the detail pane beside this list (desktop master/detail). */
    selected?: boolean;
    onOpen: () => void;
    actions?: Snippet;
  } = $props();

  // Duplicates happen in real coordinator output; the old card deduped too.
  const icebreakers = $derived([...new Set(match.icebreakers ?? [])]);
</script>

<article class="entry" class:selected>
  <!-- The identity line is the tap target, exactly as in PersonCard: a button
       wrapping the reasoning paragraph would make the one piece of text people
       actually want to read unselectable. -->
  <button class="who" onclick={onOpen} aria-current={selected ? "true" : undefined}>
    <Avatar pubkey={match.pubkey} {name} {picture} size={38} />
    <span class="meta">
      <span class="nameline">
        <span class="name">{name}</span>
        {#if isNew}<span class="new">{t("matches.new")}</span>{/if}
      </span>
      {#if sub}<span class="sub">{sub}</span>{/if}
    </span>
  </button>

  <p class="why">{match.reasoning}</p>

  {#if icebreakers.length > 0}
    <details class="ib">
      <summary>
        <Icon name="chevronDown" size={14} />
        <span>{t("matches.icebreakers")}</span>
      </summary>
      <ul>
        {#each icebreakers as ib (ib)}
          <li>{ib}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</article>

<style>
  .entry {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.9rem 0;
    border-bottom: 1px solid var(--border);
  }
  .entry:last-child {
    border-bottom: none;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
    padding: 0;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .who:hover .name {
    color: var(--accent);
  }
  /* Marked the same way a roster row is, so one list reads as one list. */
  .entry.selected {
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
    box-shadow: inset 3px 0 0 var(--accent);
    padding-left: 0.75rem;
    padding-right: 0.6rem;
  }
  .entry.selected .name {
    color: var(--accent);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .nameline {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }
  .name {
    font-weight: 650;
    font-size: 1rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Not a coloured dot: "new" has to survive forced-colors and greyscale, so it
     is a word. Tiny, uppercase, in the accent — the only accent in the entry. */
  .new {
    flex: none;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .sub {
    color: var(--text-dim);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The reasoning is the product, so it is set as prose rather than as UI: the
     event world's display serif, at reading size, with the measure held under
     the 65–75ch prose range. It is written in the second person and opens with
     the person's own name in 86% of real coordinator output — it reads as a
     note about the two of you, and it should look like one. */
  .why {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1rem;
    line-height: 1.55;
    max-width: 68ch;
  }
  details.ib summary {
    list-style: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-dim);
    /* 44px of vertical hit area on a control whose text is 0.8rem. */
    padding: 0.35rem 0.1rem;
  }
  details.ib summary::-webkit-details-marker {
    display: none;
  }
  details.ib summary:hover {
    color: var(--text);
  }
  details.ib summary :global(svg) {
    transition: transform 0.15s ease;
  }
  details.ib[open] summary :global(svg) {
    transform: rotate(180deg);
  }
  details.ib ul {
    margin: 0.1rem 0 0;
    padding-left: 1.05rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.9rem;
    line-height: 1.45;
    max-width: 68ch;
  }
  details.ib li::marker {
    color: var(--text-dim);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  @media (prefers-reduced-motion: reduce) {
    details.ib summary :global(svg) {
      transition: none;
    }
  }
</style>
