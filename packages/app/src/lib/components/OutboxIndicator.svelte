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

{#if outbox.pending > 0 || outbox.failed.length > 0}
  <span class="failed-wrap">
    <button
      type="button"
      class="chip"
      class:failed={outbox.failed.length > 0}
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {outbox.failed.length > 0
        ? tp("outbox.failed", outbox.failed.length)
        : tp("outbox.pending", outbox.pending)}
    </button>
    {#if open}
      <!-- Sync Status (audit §7.4.7): item type, queued time, retries, last error,
           retry-now, safe cancel — for both waiting and failed items. -->
      <div class="panel card" role="group" aria-label={t("outbox.syncStatus")}>
        {#if outbox.failed.length > 0}
          <h3>{t("outbox.failed.title")}</h3>
          <ul>
            {#each outbox.failed as item (item.id)}
              <li>
                <span class="meta">
                  {t("outbox.item", { kind: item.kind })} · {when(item.queuedAt)} · {t("outbox.retries", { n: item.attempts })}
                </span>
                {#if item.lastError}<span class="err">{item.lastError}</span>{/if}
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
        {/if}
        {#if outbox.pendingItems.length > 0}
          <h3>{t("outbox.waiting.title")}</h3>
          <ul>
            {#each outbox.pendingItems as item (item.id)}
              <li>
                <span class="meta">
                  {t("outbox.item", { kind: item.kind })} · {when(item.queuedAt)}{#if item.attempts > 0} · {t("outbox.retries", { n: item.attempts })}{/if}
                </span>
                <span class="acts">
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
        {/if}
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
  .panel h3 {
    margin: 0.25rem 0 0.15rem;
    font-size: 0.8rem;
  }
  .meta {
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .err {
    display: block;
    width: 100%;
    font-size: 0.75rem;
    color: var(--danger);
    word-break: break-word;
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
