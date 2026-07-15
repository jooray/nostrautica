<script lang="ts">
  /**
   * Shared async-error surface (audit finding Q3). Turns a raw thrown value into
   * a plain-language headline + one safe next action, with the technical text
   * tucked behind a collapsed disclosure. Replaces ad-hoc `{error}` warn cards.
   *
   * `role="alert"` announces the failure once to assistive tech (A6). Pass an
   * `onRetry` for retryable reads; the button disables itself while `retrying`.
   */
  import { categorizeError, errorDetail, type ErrorCategory } from "$lib/nostr/errors.js";
  import { online } from "$lib/stores/online.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import type { MessageKey } from "$lib/i18n/messages.js";

  let {
    error,
    onRetry,
    retrying = false,
  }: {
    error: unknown;
    onRetry?: () => void;
    retrying?: boolean;
  } = $props();

  const category = $derived<ErrorCategory>(categorizeError(error, { online: online.isOnline }));
  const headlineKey = $derived<MessageKey>(`error.cat.${category}` as MessageKey);
  const detail = $derived(errorDetail(error));
</script>

<div class="card warn" role="alert">
  <strong>{t(headlineKey)}</strong>
  {#if onRetry}
    <div class="row" style="margin-top:0.6rem">
      <button class="btn inline" onclick={onRetry} disabled={retrying}>
        {retrying ? t("error.state.retrying") : t("error.state.retry")}
      </button>
    </div>
  {/if}
  {#if detail}
    <details style="margin-top:0.5rem">
      <summary class="muted" style="cursor:pointer;font-size:0.85rem">{t("error.state.details")}</summary>
      <p class="mono muted" style="margin:0.4rem 0 0">{detail}</p>
    </details>
  {/if}
</div>
