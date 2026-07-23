<script lang="ts">
  /**
   * Accessible form error summary (audit §7.3.7). Renders an `role="alert"`
   * region listing every field error as a link that focuses the offending field.
   * On appearing (or when the error set changes) it moves focus to itself so a
   * keyboard/screen-reader user is taken straight to the problem instead of being
   * left on a disabled submit button with no idea what failed.
   */
  import type { FieldError } from "$lib/stores/form-validation.js";
  import { errorId } from "$lib/stores/form-validation.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let { errors, heading }: { errors: FieldError[]; heading?: string } = $props();

  let box = $state<HTMLDivElement | null>(null);
  // Focus the summary each time a non-empty error set is (re)published — e.g.
  // a second failed submit. Keyed on the joined ids so re-submitting the same
  // errors still re-focuses.
  const key = $derived(errors.map((e) => e.id).join(","));
  $effect(() => {
    void key;
    if (errors.length > 0) queueMicrotask(() => box?.focus());
  });

  function focusField(id: string, e: Event) {
    e.preventDefault();
    document.getElementById(id)?.focus();
  }
</script>

{#if errors.length > 0}
  <div class="error-summary card warn" role="alert" tabindex="-1" bind:this={box}>
    <strong>{heading ?? t("form.errorSummary.title")}</strong>
    <ul>
      {#each errors as err (err.id)}
        <li>
          <a href="#{err.id}" onclick={(e) => focusField(err.id, e)} aria-describedby={errorId(err.id)}>
            {err.message}
          </a>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .error-summary {
    margin: 0 0 0.75rem;
  }
  .error-summary strong {
    display: block;
    margin-bottom: 0.35rem;
  }
  .error-summary ul {
    margin: 0;
    padding-left: 1.1rem;
  }
  .error-summary a {
    color: var(--danger);
    text-decoration: underline;
  }
  .error-summary:focus-visible {
    outline: 2px solid var(--danger);
    outline-offset: 2px;
  }
</style>
