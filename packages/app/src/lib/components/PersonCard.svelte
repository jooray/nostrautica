<script lang="ts">
  // Shared person row (redesign §5.1): initial avatar, name, one distinguishing
  // line, and an optional trailing slot for badges. Extracted from the Attendees
  // row markup — the translation-aware bio is computed at the call site and
  // passed in as `line`, so this component stays presentational.
  //
  // `trailing` sits on the SECOND line, beside the bio, not beside the name
  // (2026-09-13). On the name's line a 55px badge plus three controls left a
  // 390px row about 76px of name — "Peter Bezpečnostný" rendered as "Peter…".
  // The badge is an annotation on the person, not part of their name, and the
  // bio's line has room the name's line does not.
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
    last = false,
    selected = false,
  }: {
    pubkey: string;
    name: string;
    line?: string;
    picture?: string;
    onOpen: () => void;
    trailing?: Snippet;
    actions?: Snippet;
    /** True for the true last row of the list (audit UX-30: with a virtualized
     *  roster the DOM's last child isn't necessarily the list's last item, so
     *  `:last-child` can no longer decide this — the caller knows). */
    last?: boolean;
    /** Open in the detail pane beside this list (desktop master/detail). */
    selected?: boolean;
  } = $props();
</script>

<div class="person" class:last class:selected>
  <button class="open" onclick={onOpen} aria-current={selected ? "true" : undefined}>
    <Avatar {pubkey} {name} {picture} size={40} />
    <span class="meta">
      <span class="name">{name}</span>
      {#if line || trailing}
        <span class="sub">
          {#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
          {#if line}<span class="line">{line}</span>{/if}
        </span>
      {/if}
    </span>
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
  .person.last {
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
  /* Which row the detail pane is showing. `aria-current` carries it for anyone
     not looking at the tint, and the leading bar keeps it legible in forced
     colours, where the background is discarded. */
  .person.selected {
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
  }
  .person.selected .name {
    color: var(--accent);
  }
  .person.selected::before {
    content: "";
    align-self: stretch;
    width: 3px;
    flex: none;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
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
  .sub {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
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
