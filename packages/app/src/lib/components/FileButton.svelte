<script lang="ts">
  /**
   * Keyboard-accessible file picker (audit §7.3.1). A wrapping `<label>` around a
   * `display:none`/`hidden` input is NOT reliably keyboard operable: the label
   * itself isn't focusable and the hidden input is removed from the tab order, so
   * keyboard-only users on Login/Join/Create/Settings/Record could never open the
   * file dialog. This renders a real `<button>` (focusable, Enter/Space activate)
   * that programmatically clicks a visually-hidden — but not display:none — input,
   * which stays in the accessibility tree with its own label.
   */
  import type { Snippet } from "svelte";

  let {
    accept,
    onchange,
    disabled = false,
    label,
    class: cls = "btn",
    style = "",
    children,
  }: {
    accept?: string;
    onchange: (e: Event) => void;
    disabled?: boolean;
    /** Accessible name for the underlying input (e.g. "Choose a profile picture"). */
    label: string;
    class?: string;
    style?: string;
    children: Snippet;
  } = $props();

  let input = $state<HTMLInputElement | null>(null);
</script>

<!--
  `value = ""` before opening the dialog. A file input fires `change` only when the
  selection CHANGES, so picking the same file twice — after a failed upload, or
  after cropping and wanting the original back — did nothing at all, with no
  feedback of any kind. Clearing it first makes every pick a change.
-->
<button
  type="button"
  class={cls}
  {style}
  {disabled}
  onclick={() => {
    if (input) input.value = "";
    input?.click();
  }}
>
  {@render children()}
</button>
<input
  bind:this={input}
  type="file"
  {accept}
  {disabled}
  aria-label={label}
  onchange={onchange}
  class="vh-file"
  tabindex="-1"
/>

<style>
  /* Visually hidden but present in the a11y tree and clickable. The button is the
     keyboard-reachable control; this input is triggered programmatically. */
  .vh-file {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
