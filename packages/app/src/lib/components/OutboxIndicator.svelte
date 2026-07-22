<script lang="ts">
  /**
   * Outbox status (audit UX-15, App-8). A quiet "will sync" chip while the
   * durable publish queue has pending items, plus — for events that exhausted
   * their retries — a "failed" chip that expands a small list letting the user
   * retry or discard each one. Renders nothing when the queue is empty.
   */
  import { onMount } from "svelte";
  import { outbox } from "$lib/stores/outbox.svelte.js";
  import { t, tp } from "$lib/i18n/i18n.svelte.js";

  onMount(() => outbox.init());

  let open = $state(false);
  const when = (sec: number) => new Date(sec).toLocaleTimeString();
</script>

{#if outbox.pending > 0}
  <span class="chip" role="status">{tp("outbox.pending", outbox.pending)}</span>
{/if}

{#if outbox.failed.length > 0}
  <span class="failed-wrap">
    <button
      type="button"
      class="chip failed"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {tp("outbox.failed", outbox.failed.length)}
    </button>
    {#if open}
      <div class="panel card" role="group" aria-label={t("outbox.failed.title")}>
        <ul>
          {#each outbox.failed as item (item.id)}
            <li>
              <span class="meta">{t("outbox.item", { kind: item.kind })} · {when(item.queuedAt)}</span>
              <span class="acts">
                <button type="button" class="btn inline" onclick={() => void outbox.retry(item.id)}>
                  {t("outbox.retry")}
                </button>
                <button
                  type="button"
                  class="btn inline ghost danger"
                  onclick={() => void outbox.discard(item.id)}
                >
                  {t("outbox.discard")}
                </button>
              </span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </span>
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
  .chip.failed {
    color: var(--danger);
    border-color: var(--danger);
    cursor: pointer;
    background: transparent;
  }
  .failed-wrap {
    position: relative;
    display: inline-block;
  }
  .panel {
    position: absolute;
    top: calc(100% + 0.35rem);
    right: 0;
    z-index: 20;
    min-width: 15rem;
    max-width: min(22rem, 80vw);
    padding: 0.5rem;
  }
  .panel ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .panel li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .meta {
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .acts {
    display: flex;
    gap: 0.3rem;
  }
  .btn.inline.ghost {
    background: transparent;
  }
  .btn.inline.danger {
    color: var(--danger);
  }
</style>
