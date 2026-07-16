<script lang="ts">
  // Shared person row (redesign §5.1): initial avatar, name, one distinguishing
  // line, and an optional trailing slot for badges. Extracted from the Attendees
  // row markup — the translation-aware bio is computed at the call site and
  // passed in as `line`, so this component stays presentational.
  //
  // `actions` renders OUTSIDE the open-button (quick actions like Message /
  // Want to meet, UX feedback 2026-07-16) — nested buttons are invalid HTML.
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";

  let {
    pubkey,
    name,
    line,
    picture,
    onOpen,
    trailing,
    actions,
  }: {
    pubkey: string;
    name: string;
    line?: string;
    picture?: string;
    onOpen: () => void;
    trailing?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<div class="person">
  <button class="open" onclick={onOpen}>
    <Avatar {pubkey} {name} {picture} size={40} />
    <span class="meta">
      <span class="name">{name}</span>
      {#if line}<span class="line">{line}</span>{/if}
    </span>
    {#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
  </button>
  {#if actions}<span class="actions">{@render actions()}</span>{/if}
</div>

<style>
  .person {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-bottom: 1px solid var(--border);
  }
  .person:last-child {
    border-bottom: none;
  }
  .open {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex: 1;
    min-width: 0;
    padding: 0.6rem 0.2rem;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .open:hover .name {
    color: var(--accent);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }
  .name {
    font-weight: 600;
    font-size: 0.95rem;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    color: var(--text-dim);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trailing {
    display: inline-flex;
    gap: 0.3rem;
    flex: none;
  }
  .actions {
    display: inline-flex;
    gap: 0.25rem;
    flex: none;
  }
</style>
