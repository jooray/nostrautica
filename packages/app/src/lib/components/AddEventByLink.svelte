<script lang="ts">
  /**
   * "I have a link, get me into that event."
   *
   * Installed as a PWA, this app is its own browser: a link tapped in a chat app
   * opens in the system browser, which holds none of this device's identity —
   * different keystore, different session, different joined events. The invite
   * therefore lands in the one place it can't be used, and the organizer gets
   * told "your link doesn't work". Pasting it here is the way across that gap,
   * and it is the same navigation the link itself would have performed.
   *
   * The parsing is in events/event-link.ts (pure, tested); this is the surface.
   */
  import Icon from "$lib/components/icons/Icon.svelte";
  import { parseEventLink, type EventLinkError } from "$lib/events/event-link.js";
  import { router } from "$lib/router/router.svelte.js";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { describedBy } from "$lib/stores/form-validation.js";

  const FIELD = "event-link";
  /** One sentence per refusal — see EventLinkError for what each one means. */
  const ERROR_KEY = {
    notAnEvent: "home.addByLink.error.notAnEvent",
    unrecognized: "home.addByLink.error.unrecognized",
  } as const;

  let value = $state("");
  /** The last refusal, or null. `empty` never reaches here — it's not an error. */
  let failure = $state<Exclude<EventLinkError, "empty"> | null>(null);

  function open(event: SubmitEvent): void {
    event.preventDefault();
    const result = parseEventLink(value);
    if (!result.ok) {
      failure = result.reason === "empty" ? null : result.reason;
      return;
    }
    failure = null;
    // An invite link carries a live nsec in its `code`. It has been read into a
    // route now, so there is no reason to leave it sitting in an input (Join
    // strips it out of the URL + history the moment it arrives, same reasoning).
    value = "";
    router.go(result.route);
  }
</script>

<div class="card">
  <h2><Icon name="link" size={18} />{t("home.addByLink.title")}</h2>
  <p class="muted" id="{FIELD}-hint">{t("home.addByLink.body")}</p>
  <form onsubmit={open}>
    <label for={FIELD}>{t("home.addByLink.label")}</label>
    <div class="row" style="align-items:flex-start">
      <input
        id={FIELD}
        bind:value
        type="text"
        inputmode="url"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder={t("home.addByLink.placeholder")}
        aria-invalid={failure !== null}
        aria-describedby={describedBy(FIELD, failure !== null, `${FIELD}-hint`)}
        oninput={() => (failure = null)}
      />
      <button class="btn inline primary" type="submit" disabled={!value.trim()}>
        {t("home.addByLink.action")}
      </button>
    </div>
    {#if failure}
      <p id="{FIELD}-error" class="field-error" role="alert">
        {t(ERROR_KEY[failure])}
      </p>
    {/if}
  </form>
</div>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  /* The button sits beside the field rather than under it: this is a one-shot
     action on a single value, and a full-width button below would read as the
     card's primary call to action over "Create an event". */
  .row button {
    flex: none;
    min-height: 44px;
  }
</style>
