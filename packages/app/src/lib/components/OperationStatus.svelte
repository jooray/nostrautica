<script lang="ts">
  /**
   * Persistent, announced operation status (audit §7.3.9). A polite live region
   * that renders the shared `opStatus` message until the user's next edit clears
   * it. Distinguishes Queued / Published / Coordinator-acknowledged / error with
   * a non-color icon glyph as well as tone, so the state is legible without color.
   */
  import { opStatus } from "$lib/stores/op-status.svelte.js";

  const glyph = $derived(
    opStatus.kind === "error"
      ? "!"
      : opStatus.kind === "queued"
        ? "…"
        : "✓",
  );
</script>

<div class="op-status" role="status" aria-live="polite">
  {#if opStatus.message}
    <span class="line" class:err={opStatus.kind === "error"} class:queued={opStatus.kind === "queued"}>
      <span aria-hidden="true" class="glyph">{glyph}</span>
      {opStatus.message}
    </span>
  {/if}
</div>

<style>
  .op-status {
    margin: 0.4rem 0;
  }
  .op-status:empty {
    margin: 0;
  }
  .line {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.9rem;
    color: var(--ok, var(--accent));
  }
  .line.queued {
    color: var(--text-dim);
  }
  .line.err {
    color: var(--danger);
  }
  .glyph {
    font-weight: 700;
  }
</style>
