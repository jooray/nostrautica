<script lang="ts">
  /**
   * On-brand toggle switch, replacing raw <input type="checkbox"> in the
   * event-config forms (Create/Admin) — the native checkbox renders as an ugly
   * grey box under the app's generic `input` reset. A real <input type="checkbox">
   * still drives the state (bind:checked), just visually hidden and swapped for a
   * styled track+thumb sibling — so screen readers, keyboard (Space/Tab), and
   * :focus-visible all behave exactly like a normal checkbox.
   */
  import type { Snippet } from "svelte";

  let {
    checked = $bindable(false),
    disabled = false,
    id,
    children,
  }: {
    checked?: boolean;
    disabled?: boolean;
    id?: string;
    children?: Snippet;
  } = $props();
</script>

<label class="toggle">
  <input type="checkbox" {id} bind:checked {disabled} class="toggle-input" />
  <span class="toggle-track" aria-hidden="true"></span>
  {#if children}<span class="toggle-label">{@render children()}</span>{/if}
</label>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    /* The visible track is 44×24. A <label> activates its control from anywhere
       inside it, so giving the label a 44px minimum height turns the whole band
       around the track into the tap target and brings the switch up to the 44px
       floor every .btn in this app already meets — without inflating the pill
       itself, which is a deliberate 24px. Matters most in the Create/Admin
       config forms, where these toggles sit in a dense stack. */
    min-height: 44px;
    margin: 0;
    font-weight: 400;
    cursor: pointer;
  }
  .toggle:has(.toggle-input:disabled) {
    cursor: not-allowed;
    opacity: 0.55;
  }
  /* Visually hidden but still the real, focusable, tabbable control. */
  .toggle-input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .toggle-track {
    position: relative;
    flex: none;
    width: 44px;
    height: 24px;
    border-radius: 999px;
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease;
  }
  .toggle-track::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text-dim);
    transition:
      transform 0.15s ease,
      background-color 0.15s ease;
  }
  .toggle-input:checked + .toggle-track {
    background: var(--accent-bg);
    border-color: var(--accent-bg);
  }
  .toggle-input:checked + .toggle-track::before {
    transform: translateX(20px);
    background: var(--accent-contrast);
  }
  .toggle-input:focus-visible + .toggle-track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .toggle-label {
    font-size: 0.95rem;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  @media (prefers-reduced-motion: reduce) {
    .toggle-track,
    .toggle-track::before {
      transition: none;
    }
  }
</style>
