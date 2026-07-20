<script lang="ts">
  // "Use this chat in another Marmot client" (MARMOT-GROUP-CHAT §7).
  //
  // Originally this also offered exporting the web app's own chat key (nsec) to
  // import elsewhere. Removed (user feedback 2026-07-20): that key already holds
  // a leaf in this MLS group the moment chat is opened in the browser, and MLS
  // rejects a second leaf for a credential that already has one (verified against
  // the real ts-mls engine — "Commit cannot contain an Add proposal for someone
  // already in the group"). So importing the SAME key into Whitenoise could never
  // give it independent membership; the export was pure dead weight in the UI.
  //
  // What actually works: someone who already runs a Marmot client (Whitenoise)
  // with their OWN separate identity can authorize that identity for this chat.
  // The kind-21607 attestation the app already sends for its own device keys
  // (attest.ts) is generic — it just binds account_pubkey -> ANY chat_pubkey — so
  // authorizing an arbitrary EXISTING npub needs zero coordinator changes: once
  // that identity publishes its own key package (found via this event's relays or
  // its own NIP-65 list, key-package-discovery.ts), the coordinator's watcher
  // picks it up the same way it does for any other device.
  import { decode } from "nostr-tools/nip19";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { sendChatKeyAttestation } from "$lib/chat/attest.js";
  import type { AppSigner } from "$lib/signer/types.js";
  import type { EventContext } from "$lib/events/event-context.js";

  let { signer, ctx }: { signer: AppSigner; ctx: EventContext } = $props();

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
</section>

<style>
  .handoff {
    margin-top: 1.25rem;
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
  .handoff input {
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
