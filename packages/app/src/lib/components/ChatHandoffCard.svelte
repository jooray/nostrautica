<script lang="ts">
  // "Take this chat to your phone (Whitenoise)" hand-off (MARMOT-GROUP-CHAT §7).
  // Local-key accounts export their own nsec; NIP-46/NIP-07 accounts export the
  // chat *device* key (chat-only). The phone shows messages from when it joins.
  //
  // Second option (user feedback 2026-07-20): someone who already runs a Marmot
  // client (Whitenoise) with their own long-term identity doesn't want to import
  // a second one just for this event. The 21607 attestation the app already sends
  // for its own device keys (attest.ts) is generic — it just binds
  // account_pubkey -> ANY chat_pubkey — so authorizing an arbitrary EXISTING npub
  // works with zero coordinator changes: once that identity publishes its own
  // key package to this event's relays, the coordinator's watcher picks it up the
  // same way it does for any other device (admin.ts eligibleChatAuthors).
  import { nsecEncode, decode } from "nostr-tools/nip19";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import Icon from "$lib/components/icons/Icon.svelte";
  import QrCode from "$lib/components/QrCode.svelte";
  import { sendChatKeyAttestation } from "$lib/chat/attest.js";
  import type { AppSigner } from "$lib/signer/types.js";
  import type { EventContext } from "$lib/events/event-context.js";

  let {
    isAccountKey,
    secretKey,
    signer,
    ctx,
  }: {
    isAccountKey: boolean;
    secretKey: Uint8Array;
    signer: AppSigner;
    ctx: EventContext;
  } = $props();

  let revealed = $state(false);
  const nsec = $derived(revealed ? nsecEncode(secretKey) : "");

  async function copy() {
    try {
      await navigator.clipboard.writeText(nsecEncode(secretKey));
    } catch {
      /* clipboard blocked — the QR + on-screen text remain */
    }
  }

  let linkInput = $state("");
  let linking = $state(false);
  let linkError = $state<string | null>(null);
  let linked = $state(false);
  // Kept so "authorize again" (re-check, e.g. after opening Whitenoise for the
  // first time) can resend without the user re-pasting the npub.
  let linkedPubkey = $state("");

  async function linkExisting(): Promise<void> {
    if (!linkInput.trim() || linking) return;
    linking = true;
    linkError = null;
    try {
      let pubkey = linkInput.trim();
      if (pubkey.startsWith("npub1")) {
        const decoded = decode(pubkey);
        if (decoded.type !== "npub") throw new Error(t("chat.handoff.link.badNpub"));
        pubkey = decoded.data;
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error(t("chat.handoff.link.badNpub"));
      await sendChatKeyAttestation(signer, ctx, { op: "add", chatPubkey: pubkey });
      linked = true;
      linkedPubkey = pubkey;
      linkInput = "";
    } catch (e) {
      linkError = e instanceof Error ? e.message : String(e);
    } finally {
      linking = false;
    }
  }

  // Re-send the same attestation: harmless (the coordinator's upsert is
  // idempotent) and re-triggers its key-package sync, which is exactly what
  // "authorize again" needs if the first attempt ran before that identity had
  // published a key package anywhere the coordinator could find it.
  async function reauthorize(): Promise<void> {
    if (!linkedPubkey || linking) return;
    linking = true;
    linkError = null;
    try {
      await sendChatKeyAttestation(signer, ctx, { op: "add", chatPubkey: linkedPubkey });
    } catch (e) {
      linkError = e instanceof Error ? e.message : String(e);
    } finally {
      linking = false;
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

  <div class="or-divider">{t("login.or")}</div>

  <div class="link-existing">
    <strong>{t("chat.handoff.link.title")}</strong>
    <p class="muted">{t("chat.handoff.link.body")}</p>
    {#if linked}
      <p class="muted linked-ok">{t("chat.handoff.link.success")}</p>
      <div class="row">
        <button class="btn inline" onclick={reauthorize} disabled={linking}>
          {linking ? t("chat.handoff.link.authorizing") : t("chat.handoff.link.button")}
        </button>
      </div>
      {#if linkError}<p class="muted warn" role="alert">{linkError}</p>{/if}
    {:else}
      <input
        placeholder={t("chat.handoff.link.placeholder")}
        bind:value={linkInput}
        disabled={linking}
      />
      <div class="row">
        <button class="btn inline" onclick={linkExisting} disabled={!linkInput.trim() || linking}>
          {linking ? t("chat.handoff.link.authorizing") : t("chat.handoff.link.button")}
        </button>
      </div>
      {#if linkError}<p class="muted warn" role="alert">{linkError}</p>{/if}
    {/if}
    {#if ctx.config.relays.length}
      <p class="muted relays-hint">
        {t("chat.handoff.link.relaysHint")}
        {ctx.config.relays.join(", ")}
      </p>
    {/if}
  </div>
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
  .link-existing input {
    width: 100%;
    margin-top: 0.4rem;
  }
  .linked-ok {
    color: var(--ok);
  }
  .relays-hint {
    font-size: 0.72rem;
    margin-top: 0.6rem;
    word-break: break-all;
  }
</style>
