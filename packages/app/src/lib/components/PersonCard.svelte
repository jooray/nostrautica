<script lang="ts">
  // Shared person row (redesign §5.1): initial avatar, name, one distinguishing
  // line, and an optional trailing slot for badges. Extracted from the Attendees
  // row markup — the translation-aware bio is computed at the call site and
  // passed in as `line`, so this component stays presentational.
  import type { Snippet } from "svelte";
  import Avatar from "./Avatar.svelte";

  let {
    pubkey,
    name,
    line,
    picture,
    onOpen,
    trailing,
  }: {
    pubkey: string;
    name: string;
    line?: string;
    picture?: string;
    onOpen: () => void;
    trailing?: Snippet;
  } = $props();
</script>

<button class="person" onclick={onOpen}>
  <Avatar {pubkey} {name} {picture} size={40} />
  <span class="meta">
    <span class="name">{name}</span>
    {#if line}<span class="line">{line}</span>{/if}
  </span>
  {#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
</button>

<style>
  .person {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    width: 100%;
    padding: 0.6rem 0.2rem;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .person:last-child {
    border-bottom: none;
  }
  .person:hover .name {
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
    font-size: 0.78rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trailing {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
</style>
