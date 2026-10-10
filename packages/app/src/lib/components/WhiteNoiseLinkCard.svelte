<script lang="ts">
  // "Also chat from White Noise" (NIP §10.5). Lives under the event chat's
  // "Chat devices" list: the linked key becomes one more device there.
  //
  // States: idle → waiting for the code (a different npub) → linked. Linking the
  // account's own npub skips the code: the 21607 is sealed by that very key, which
  // is the proof. The coordinator does the adding; we only ask, then watch the
  // roster (success) and the 21606 "chat_link" notices (refusals).
  import { onDestroy } from "svelte";
  import { npubEncode } from "nostr-tools/nip19";
  import { t } from "$lib/i18n/i18n.svelte.js";
  import { session } from "$lib/signer/session.svelte.js";
  import { ownStatusStore } from "$lib/stores/own-status.svelte.js";
  import { receiveGrants, fetchRoster, cachedRoster } from "$lib/events/attendee.js";
  import type { EventContext } from "$lib/events/event-context.js";
  import {
    parseExternalChatPubkey,
    sendChatLinkRequest,
    sendChatLinkConfirm,
    isLinkedInRoster,
    latestLinkNotice,
    newestLinkNoticeAt,
    linkRefusalMessage,
    refusalEndsLink,
    loadPendingLink,
    savePendingLink,
    clearPendingLink,
  } from "$lib/chat/external-link.js";

  let { ctx, onChanged }: { ctx: EventContext; onChanged?: () => void } = $props();

  type Phase = "idle" | "sending" | "waiting" | "confirming" | "linked";
  let phase = $state<Phase>("idle");
  let input = $state("");
  let code = $state("");
  let inputError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** The external key being linked, and when (unix s) this attempt started. */
  let target = $state<string | null>(null);
  let since = $state(0);
  /** The newest notice already on hand when the user last acted: anything at or
   *  before it answered an earlier action (see latestLinkNotice). */
  let baselineAt = $state(Number.NEGATIVE_INFINITY);

  const account = $derived(session.pubkey);

  // Pick a pending link back up after a reload (the user went to White Noise and
  // the browser discarded this tab meanwhile).
  $effect(() => {
    if (!account) return;
    const pending = loadPendingLink(account, ctx.coordinate);
    if (pending && phase === "idle") {
      target = pending.chatPubkey;
      since = pending.startedAt;
      phase = "waiting";
    }
  });

  // The coordinator's latest answer for this attempt.
  // Watched in "linked" too: a self-link goes straight there, and the coordinator
  // can still turn it down (device cap, bound elsewhere).
  const linkNotice = $derived(
    target && phase !== "idle" && phase !== "sending"
      ? latestLinkNotice(ownStatusStore.all(ctx.coordinate), since, baselineAt)
      : undefined,
  );
  const refusal = $derived(linkNotice?.state === "poison" ? linkNotice : undefined);

  // A refusal that kills the code sends the card back to the start (the message
  // stays); a wrong code just lets them retype.
  $effect(() => {
    if (!refusal || !account) return;
    if (phase === "confirming") phase = "waiting";
    if (phase === "linked" || refusalEndsLink(refusal.error_category)) {
      notice = t(linkRefusalMessage(refusal.error_category));
      clearPendingLink(account, ctx.coordinate);
      phase = "idle";
      target = null;
    }
  });

  let timers: ReturnType<typeof setTimeout>[] = [];
  onDestroy(() => timers.forEach(clearTimeout));

  /** Re-read the 21606 notices and the roster a few times after an action. */
  function watch(): void {
    timers.forEach(clearTimeout);
    timers = [3_000, 8_000, 15_000, 30_000, 60_000].map((ms) => setTimeout(() => void poll(), ms));
  }

  async function poll(): Promise<void> {
    if (!session.signer || !account || !target) return;
    await receiveGrants(session.signer).catch(() => {});
    const roster = await fetchRoster(ctx).catch(() => cachedRoster(ctx.coordinate));
    if (!target || phase === "idle" || !isLinkedInRoster(roster, account, target)) return;
    clearPendingLink(account, ctx.coordinate);
    phase = "linked";
    if (!announced) {
      announced = true;
      onChanged?.(); // the device list above can show it now
    }
  }
  let announced = false;

  function useAccount(): void {
    if (account) input = npubEncode(account);
    inputError = null;
  }

  async function startLink(): Promise<void> {
    if (!session.signer || !account) return;
    const w = parseExternalChatPubkey(input);
    if (!w) {
      inputError = t("chat.wn.invalid");
      return;
    }
    inputError = null;
    notice = null;
    phase = "sending";
    baselineAt = newestLinkNoticeAt(ownStatusStore.all(ctx.coordinate));
    try {
      const delivered = await sendChatLinkRequest(session.signer, ctx, w);
      target = w;
      since = Math.floor(Date.now() / 1000);
      if (!delivered) notice = t("chat.devices.queued");
      if (w === account) {
        // Self-link: no code. The coordinator binds and invites straight away.
        phase = "linked";
      } else {
        savePendingLink(account, ctx.coordinate, { chatPubkey: w, startedAt: since });
        code = "";
        phase = "waiting";
      }
      watch();
    } catch {
      phase = "idle";
      notice = t("chat.wn.failed");
    }
  }

  async function confirm(): Promise<void> {
    if (!session.signer || !target || !code.trim()) return;
    notice = null;
    phase = "confirming";
    baselineAt = newestLinkNoticeAt(ownStatusStore.all(ctx.coordinate));
    try {
      const delivered = await sendChatLinkConfirm(session.signer, ctx, target, code);
      if (!delivered) notice = t("chat.devices.queued");
      watch();
    } catch {
      phase = "waiting";
      notice = t("chat.wn.failed");
    }
  }

  function reset(): void {
    if (account) clearPendingLink(account, ctx.coordinate);
    timers.forEach(clearTimeout);
    announced = false;
    phase = "idle";
    target = null;
    code = "";
    input = "";
    notice = null;
  }
</script>

<div class="wn" aria-label={t("chat.wn.title")} role="group">
  <strong>{t("chat.wn.title")}</strong>

  {#if phase === "idle" || phase === "sending"}
    <p class="muted small">{t("chat.wn.body")}</p>
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        void startLink();
      }}
    >
      <input
        class="field"
        bind:value={input}
        placeholder={t("chat.wn.inputPlaceholder")}
        aria-label={t("chat.wn.inputLabel")}
        aria-invalid={inputError ? "true" : undefined}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <button class="btn inline primary" type="submit" disabled={!input.trim() || phase === "sending"}>
        {phase === "sending" ? t("chat.wn.sending") : t("chat.wn.submit")}
      </button>
    </form>
    <button class="btn inline ghost" type="button" onclick={useAccount}>{t("chat.wn.useAccount")}</button>
    {#if inputError}<p class="error small" role="alert">{inputError}</p>{/if}
  {:else if phase === "waiting" || phase === "confirming"}
    <p class="small">{t("chat.wn.waitingBody")}</p>
    <p class="muted small">{t("chat.wn.expiry")}</p>
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
    >
      <input
        class="field code"
        bind:value={code}
        placeholder="XXXX-XXXX"
        aria-label={t("chat.wn.codeLabel")}
        maxlength="32"
        autocomplete="one-time-code"
        autocapitalize="characters"
        spellcheck="false"
      />
      <button class="btn inline primary" type="submit" disabled={!code.trim() || phase === "confirming"}>
        {phase === "confirming" ? t("chat.wn.checking") : t("chat.wn.confirm")}
      </button>
      <button class="btn inline ghost" type="button" onclick={reset}>{t("chat.wn.cancel")}</button>
    </form>
    {#if refusal}
      <p class="error small" role="alert">{t(linkRefusalMessage(refusal.error_category))}</p>
    {/if}
  {:else}
    <p class="small" role="status">{t("chat.wn.linkedBody")}</p>
    <button class="btn inline ghost" type="button" onclick={reset}>{t("chat.wn.linkAnother")}</button>
  {/if}

  {#if notice}<p class="muted small" role="status">{notice}</p>{/if}
</div>

<style>
  .wn {
    margin-top: 0.9rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
  }
  .wn p {
    margin: 0;
  }
  .small {
    font-size: 0.82rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    width: 100%;
  }
  .field {
    flex: 1 1 12rem;
    min-width: 0;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    font: inherit;
    background: var(--bg-raised);
    color: var(--text);
  }
  .field.code {
    flex: 0 1 10rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .btn.inline.ghost {
    background: transparent;
  }
  .error {
    color: var(--danger);
  }
</style>
