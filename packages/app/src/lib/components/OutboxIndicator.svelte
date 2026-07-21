<script lang="ts">
  /**
   * Quiet "you have unsent changes" chip (audit UX-15). Renders nothing when the
   * durable publish queue is empty; otherwise says the count and that it syncs
   * on its own — so a send on bad Wi-Fi never looks lost. Mounted in the TopBar
   * (the offline banner itself lives in +layout.svelte, owned elsewhere).
   */
  import { onMount } from "svelte";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { tp } from "$lib/i18n/i18n.svelte.js";

  onMount(() => outbox.init());
</script>

{#if outbox.pending > 0}
  <span class="chip" role="status">{tp("outbox.pending", outbox.pending)}</span>
{/if}

<style>
  .chip {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    white-space: nowrap;
  }
</style>
