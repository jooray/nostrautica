<script lang="ts">
  // "Take this chat to your phone (Whitenoise)" hand-off (MARMOT-GROUP-CHAT §7).
  // Local-key accounts export their own nsec; NIP-46/NIP-07 accounts export the
  // chat *device* key (chat-only). The phone shows messages from when it joins.
  import { nsecEncode } from "nostr-tools/nip19";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import QrCode from "$lib/components/QrCode.svelte";

  let { isAccountKey, secretKey }: { isAccountKey: boolean; secretKey: Uint8Array } = $props();

  let revealed = $state(false);
  const nsec = $derived(revealed ? nsecEncode(secretKey) : "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(nsecEncode(secretKey));
    } catch {
      /* clipboard blocked — the QR + on-screen text remain */
    }
  }
</script>

<section class="handoff card">
  <div class="hd">
    <Icon name="waypoint" size={20} />
    <strong>{t("chat.handoff.title")}</strong>
  </div>
  <p class="muted">{t("chat.handoff.body")}</p>
  {#if !isAccountKey}
    <p class="muted note">{t("chat.handoff.chatKeyNote")}</p>
  {/if}

  {#if revealed}
    <div class="qr">
      <QrCode data={nsec} size={200} />
    </div>
    <code class="nsec">{nsec}</code>
    <div class="row">
      <button class="btn" onclick={copy}>{t("chat.handoff.copy")}</button>
      <button class="btn" onclick={() => (revealed = false)}>{t("chat.handoff.hide")}</button>
    </div>
    <p class="muted warn">{t("chat.handoff.secretWarning")}</p>
  {:else}
    <button class="btn primary" onclick={() => (revealed = true)}>{t("chat.handoff.reveal")}</button>
  {/if}
</section>

<style>
  .handoff {
    margin-top: 1.25rem;
  }
  .hd {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .note {
    font-size: 0.85rem;
  }
  .qr {
    display: grid;
    place-items: center;
    margin: 0.75rem 0;
  }
  .nsec {
    display: block;
    word-break: break-all;
    font-size: 0.78rem;
    padding: 0.4rem 0.55rem;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .warn {
    font-size: 0.78rem;
    margin-top: 0.5rem;
  }
</style>
