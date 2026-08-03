<script lang="ts">
  /**
   * A person's identity in an organizer list: their display name plus the short
   * npub that tells two same-named people apart. Clicking either copies the full
   * **nprofile** — the shareable form, which carries relay hints so another client
   * can actually find them — falling back to the bare npub when the event config
   * has no relays to hint with.
   *
   * The chip next to these names used to print raw hex (`2e5124a9…0024`), which is
   * neither recognizable as an identity nor pasteable into any Nostr client, and
   * the name itself did nothing (user feedback 2026-07-30). Hint policy matches the
   * attendee page: the event's own relays are where we actually read this person's
   * records from, so they are the honest hint to hand on.
   */
  import { npubEncode, nprofileEncode } from "nostr-tools/nip19";
  import { copyText } from "$lib/util/clipboard.js";
  import { t } from "$lib/i18n/i18n.svelte.js";

  let {
    pubkey,
    name,
    relays = [],
  }: {
    pubkey: string;
    /** Display name; the short npub stands in when there isn't one. */
    name?: string;
    /** Event relays used as nprofile hints (first three). */
    relays?: string[];
  } = $props();

  const npub = $derived(npubEncode(pubkey));
  const shortId = $derived(npub.slice(0, 10) + "…" + npub.slice(-4));
  const shareable = $derived(
    relays.length > 0 ? nprofileEncode({ pubkey, relays: relays.slice(0, 3) }) : npub,
  );

  let copied = $state(false);
  /** Copy refused (permissions/webview): fall back to showing the value to select. */
  let failed = $state(false);

  async function copy(): Promise<void> {
    if ((await copyText(shareable)) === "copied") {
      failed = false;
      copied = true;
      setTimeout(() => (copied = false), 1500);
      return;
    }
    copied = false;
    failed = true;
  }
</script>

<button type="button" class="person-id" onclick={() => void copy()} title={t("admin.person.copyId")}>
  <strong>{name || shortId}</strong>
  <span class="badge id" aria-live="polite">{copied ? t("admin.copied") : shortId}</span>
  <span class="visually-hidden">{t("admin.person.copyId")}</span>
</button>
{#if failed}
  <!-- Truthful failure (audit U15): the value stays on screen to select by hand. -->
  <p class="muted copy-fallback">{t("admin.person.copyIdFailed")}</p>
  <p class="mono copy-value">{shareable}</p>
{/if}

<style>
  /* Reads as the row's heading, not as a control — the affordance is the pointer,
     the hover/focus highlight on the chip, and the tooltip. */
  .person-id {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .person-id:hover .id,
  .person-id:focus-visible .id {
    background: var(--accent-soft, var(--bg-elev2));
    color: var(--text);
  }
  .person-id:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 8px;
  }
  .copy-fallback {
    margin: 0.35rem 0 0.15rem;
    font-size: 0.82rem;
  }
  .copy-value {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 0.78rem;
  }
</style>
